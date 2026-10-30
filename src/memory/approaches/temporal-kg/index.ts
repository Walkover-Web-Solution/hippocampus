import { randomUUID } from 'crypto';
import { getEmbedder } from '../../core/embed';
import { actorOf, aliasKey, evidenceFound, findPerson, normalizeForAliases, peopleMentionedFuzzily } from '../../core/entities';
import { neo4jConfig } from '../../core/env';
import { CandidateMode, EntityCandidate, describeDecisions, excludeSiblings, findCandidates, matchDescription, matchEntity } from '../../core/entity-match';
import { GateDecision, describeGate, gateOrOpen } from '../../core/gate';
import { personalizedPageRank, queryWords, reciprocalRankFusion } from '../../core/rank';
import { decideScope } from '../../core/scope';
import { IngestContext, IngestResult, MemoryApproach, MemoryGraph, PersonRef, RawMessage, RecallInput, RecallResult, RecalledMemory, Scope, renderMessage, renderTurns } from '../../core/types';
import { EntityNode, FactEdge, Graph, openGraph } from './graph';
import { ExtractedFact, GraphExtraction, dedupeEntities, dreamEntities, expandFacts, extractBatch, extractGraph, resolveFacts } from './llm-steps';
import { DREAMING, acceptAliases } from './dreaming';
import { vetoInvalidations } from './checker';
import { KeyedMutex } from './lock';

// Approach B: Graphiti-style temporal knowledge graph on Neo4j. Facts are edges with validity windows;
// an LLM decides which existing facts a new one duplicates or contradicts, and contradicted facts are
// invalidated (never deleted).

interface AcceptedFact {
    fact: ExtractedFact;
    scope: Scope;
    proposed: boolean;
}

// A date-only end ("2026-10-22") means the end of that day.
function endTime(value: string | null): string | null {
    if (!value) return null;
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
    return Number.isNaN(Date.parse(iso)) ? null : new Date(iso).toISOString();
}

export interface TemporalKgOptions {
    gate: boolean;
    match?: CandidateMode;
    hybrid?: boolean;
    disputes?: boolean;
    summaries?: boolean;
    rank?: boolean;
    serial?: boolean;
    ppr?: boolean;
    lexical?: boolean;
    crowd?: boolean;
    checker?: boolean;
    fuse?: boolean;
    link?: boolean;
    consolidate?: boolean;
    gemma?: boolean;
}

// consolidate: working-memory batches (see buffer()). A bigger batch gives consolidation more context per
// call and fewer calls; a longer wait means facts reach the graph later (reads still see the buffer).
export const WORKING_MEMORY = {
    batchSize: Number(process.env.MEMORY_WM_BATCH_SIZE) || 12,
    maxAgeMinutes: Number(process.env.MEMORY_WM_MAX_AGE_MIN) || 10,
    // Waiting messages shown at recall, ahead of the graph's facts.
    readSlots: Number(process.env.MEMORY_WM_READ_SLOTS) || 5,
    // Evals jump through time, so a read files overdue buffers first. A live server files them on a timer
    // (consolidateOverdue) and turns this off, so reads never wait for filing.
    consolidateOnRead: process.env.MEMORY_WM_CONSOLIDATE_ON_READ !== 'false',
    // Whether a buffer is also filed once its oldest message has waited maxAgeMinutes. Off: only a full buffer
    // is filed, so every filing sees a whole batch of context; waiting messages are still found by reads.
    fileByAge: process.env.MEMORY_WM_FILE_BY_AGE !== 'false',
};

// link: descriptive names whose last word is one of these ("the WebRTC product") may refer to an entity
// that the description's other words describe.
const DESCRIPTIVE_HEADS = new Set(['product', 'project', 'service', 'app', 'application', 'platform', 'system', 'tool', 'initiative']);

// Host crowding (search engines cap results per site): an entity keeps at most this many places while
// facts about other entities are waiting.
const CROWD_CAP = 4;

// rank: facts about entities the question names get a score bonus (a prior, like a field boost in
// search engines) instead of absolute priority, so a hub entity's loosely related facts can't fill
// every place ahead of a close match stored under another entity.
const NAMED_PRIOR = 0.1; // added to cosine similarity
const LEXICAL_NAMED_BOOST = 1.3; // multiplies the full-text score

// Contradicting facts from different authors this close together are racing, not superseding.
const DISPUTE_WINDOW_MS = 60 * 1000;
// Recall places reserved for Personalized PageRank bridges (the rest keep the direct matches).
const BRIDGE_SLOTS = 2;

export class TemporalKgApproach implements MemoryApproach {
    name: string;
    capabilities = { asOf: true, perFactScope: true };
    private graph: Graph | null = null;
    private commits = new KeyedMutex();
    // One consolidation or dream at a time per buffer scope.
    private consolidations = new KeyedMutex();

    // gate: Jev ingest gate before extraction. match: Jev entity matching for names without an exact
    // alias, with candidates from shared words ("lexical") or also typos/prefixes/embeddings ("vector").
    // Zep-inspired extras: hybrid (full-text + 2-hop BFS fused with vector search), disputes (racing
    // contradictions from different authors become disputed), summaries (candidate facts shown to Jev).
    // Ideas from other fields:
    // rank: named-entity facts are boosted rather than put first (see NAMED_PRIOR), and multi-word
    //   names count as mentioned when all their words appear in the question.
    // serial: commits are serialized per scope (one writer per partition, as in databases), so racing
    //   writers see each other, and their contradictions stay disputed (a CRDT multi-value register)
    //   instead of the later write silently winning. Implies disputes.
    // ppr: Personalized PageRank from the question's entities and top facts (HippoRAG) fills the last
    //   recall places with the facts that connect them, for multi-hop questions.
    // lexical: facts get questions and synonyms at write time (doc2query) and reads use full-text
    //   search only: no query embedding, so no embedding API call on the read path.
    // crowd: host crowding (CROWD_CAP places per entity) plus the facts of the entities the top facts
    //   lead to, ranked against the question, so a question about a hub can reach the fact one hop away.
    // checker: maker-checker for invalidation (checker.ts): Jev can veto an invalidation the LLM
    //   proposed when the two facts are about different things.
    // fuse: with lexical, extraction writes the search terms itself (one LLM call fewer per message).
    // consolidate: working memory, as in the brain's hippocampus: messages wait as written (per team, or per
    //   person when private) and are consolidated into the graph in batches, which see several messages at
    //   once; reads include what is still waiting. dream() is the offline pass that merges entities and retires
    //   facts newer ones made untrue.
    // gemma: every embedding from EmbeddingGemma on the team's FastEmbed service (core/embed RemoteEmbedder),
    //   with its query/document prompts; about 100 ms per question.
    // link: entity linking by description (NLP entity linking uses entity descriptions the same way):
    //   "the WebRTC product" also gets the entities whose facts describe them with its words as
    //   match candidates, shown to Jev with those facts.
    constructor(private options: TemporalKgOptions = { gate: false }) {
        const zep = options.match === 'vector' && options.hybrid && options.disputes && options.summaries;
        const match = options.match === 'vector' ? '+vecmatch' : options.match ? '+match' : '';
        const extras = zep ? '+zep' : `${match}${options.hybrid ? '+hybrid' : ''}${options.disputes ? '+disputes' : ''}`;
        const novel = `${options.rank ? '+rank' : ''}${options.serial ? '+serial' : ''}${options.ppr ? '+ppr' : ''}${options.lexical ? '+lexical' : ''}`
            + `${options.crowd ? '+crowd' : ''}${options.checker ? '+checker' : ''}${options.fuse ? '+fuse' : ''}${options.gemma ? '+gemma' : ''}${options.link ? '+link' : ''}${options.consolidate ? '+consolidate' : ''}`;
        this.name = `temporal-kg${options.gate ? '+gate' : ''}${extras}${novel}`;
    }

    async init() {
        const { url, user, password } = neo4jConfig();
        this.graph = openGraph(url, user, password);
        await this.graph.init();
    }

    async reset() {
        await this.db().reset();
    }

    async close() {
        await this.graph?.close();
    }

    private db(): Graph {
        if (!this.graph) throw new Error('temporal-kg not initialized');
        return this.graph;
    }

    // Similarity cut-offs on the embedding model's own scale: related facts score 0.63â€“0.89 with
    // EmbeddingGemma (unrelated ~0.2), lower than with the API model.
    private similarity() {
        return this.options.gemma ? { relatedFact: 0.45, history: 0.35 } : { relatedFact: 0.6, history: 0.5 };
    }

    private async embedOne(text: string, asQuery = false): Promise<number[]> {
        const embedder = getEmbedder(this.options.gemma ? 'remote' : undefined);
        return (await (asQuery && embedder.embedQuery ? embedder.embedQuery([text]) : embedder.embed([text])))[0];
    }

    async ingest(msg: RawMessage, ctx: IngestContext): Promise<IngestResult> {
        const graph = this.db();
        const actor = actorOf(msg.actorPersonId, msg.actorName, ctx.directory);
        const now = ctx.now.toISOString();
        const notes: string[] = [];
        const gate = this.options.gate || this.options.consolidate ? await gateOrOpen(msg) : null;
        // The user confirmed the assistant's reply, so what it says is theirs, however much of it the assistant wrote.
        if (gate && msg.assistantConfirmed) gate.proposed = false;
        if (gate) {
            notes.push(describeGate(gate));
            // Working memory keeps short-lived things the gate finds "not worth remembering" long-term ("out
            // for lunch for 30 minutes"); only hypotheticals and questions stay out. Consolidation decides the rest.
            const text = msg.turns.map((t) => t.content).join(' ').trim();
            const question = /\?$/.test(text) || /^(who|what|when|where|why|how|which|is|are|do|does|did|can|could|should|would|will)\b/i.test(text);
            if (gate.skip && (!this.options.consolidate || gate.skip === 'hypothetical' || question)) return { notes };
        }
        if (this.options.consolidate) {
            await this.buffer(msg, ctx, actor, gate!, notes);
            return { notes };
        }
        const extraction = await extractGraph({
            msg,
            actor,
            directory: ctx.directory,
            knownEntities: await graph.entityNames(ctx.writableScopes),
            searchTerms: this.options.lexical && this.options.fuse,
        });
        await this.acceptAndCommit(msg, ctx, actor, extraction, gate, notes);
        return { notes };
    }

    // ---- working memory, consolidation, dreaming ----

    // Working memory: the message waits, as written, in its team's buffer, or in the speaker's own buffer when
    // the gate thinks it's private (or there's no team). A buffer is consolidated when it holds
    // WORKING_MEMORY.batchSize messages or (with fileByAge) its oldest waited maxAgeMinutes (message time).
    private async buffer(msg: RawMessage, ctx: IngestContext, actor: PersonRef, gate: GateDecision, notes: string[]) {
        const graph = this.db();
        const team = ctx.writableScopes.find((s) => s.startsWith('team:'));
        const personal = ctx.writableScopes.find((s) => s.startsWith('personal:'))!;
        const scope = team && !gate.forcePersonal ? team : personal;
        // What reads show while it waits: only what the person said (an assistant's guess in the same exchange
        // isn't theirs), and an agent's notes as unconfirmed. An assistant reply the person confirmed counts as
        // theirs, so it is shown too. Consolidation still gets the whole exchange.
        const said = msg.turns
            .filter((t) => t.role !== 'assistant' || msg.assistantConfirmed)
            .map((t) => (t.role === 'assistant' ? `(confirmed from the assistant's reply) ${t.content}` : t.content))
            .join('\n');
        const text = msg.kind === 'agent' ? `(inferred by an agent, unconfirmed) ${said}` : said;
        await graph.addBuffered({
            id: `${msg.id}@${scope}`, scope, at: msg.occurredAt, actor: actor.name, text,
            payload: JSON.stringify({ msg, ctx: { writableScopes: ctx.writableScopes, defaultScope: ctx.defaultScope, teamRole: ctx.teamRole, now: ctx.now.toISOString() }, gate }),
            embedding: await this.embedOne(text),
        });
        const pending = await graph.pendingBuffered(scope);
        notes.push(`working memory (${scope}): ${pending.length} waiting`);
        const oldest = Date.parse(pending[0]?.at ?? msg.occurredAt);
        const tooOld = WORKING_MEMORY.fileByAge && Date.parse(msg.occurredAt) - oldest >= WORKING_MEMORY.maxAgeMinutes * 60_000;
        if (pending.length >= WORKING_MEMORY.batchSize || tooOld) {
            notes.push(...(await this.consolidate(scope, ctx.directory)));
        }
    }

    // Consolidation: the scope's waiting messages, in order, become entities and facts through one batch
    // extraction; each message's facts are then committed as if it had just arrived (its own time, author,
    // scope rules and gate decision).
    // The background timer's job: file every buffer (scopes ending in `scopeSuffix`) whose oldest message has
    // waited WORKING_MEMORY.maxAgeMinutes. Returns the notes of each filing.
    async consolidateOverdue(now: Date, directory: PersonRef[], scopeSuffix = ''): Promise<string[]> {
        if (!this.options.consolidate) return [];
        const before = new Date(now.getTime() - WORKING_MEMORY.maxAgeMinutes * 60_000).toISOString();
        const notes: string[] = [];
        for (const scope of await this.db().overdueBufferScopes(before, scopeSuffix)) notes.push(...(await this.consolidate(scope, directory)));
        return notes;
    }

    async consolidate(scope: Scope, directory: PersonRef[]): Promise<string[]> {
        return this.consolidations.run([scope], async () => {
            const graph = this.db();
            const pending = await graph.pendingBuffered(scope);
            if (pending.length === 0) return [];
            const items = pending.map((p) => {
                const { msg, ctx, gate } = JSON.parse(p.payload) as { msg: RawMessage; ctx: Omit<IngestContext, 'directory' | 'now'> & { now: string }; gate: GateDecision };
                return { id: p.id, msg, gate, ctx: { ...ctx, now: new Date(ctx.now), directory }, actor: actorOf(msg.actorPersonId, msg.actorName, directory) };
            });
            const writable = [...new Set(items.flatMap((i) => i.ctx.writableScopes))];
            const batch = await extractBatch({
                messages: items.map(({ msg, actor }) => ({ msg, actor })), directory,
                knownEntities: await graph.entityNames(writable), searchTerms: this.options.lexical && this.options.fuse,
            });
            const notes = [`consolidated ${items.length} message(s) from ${scope}`];
            for (const [i, item] of items.entries()) {
                const extraction = { entities: batch.entities, facts: batch.facts.filter((f) => f.message === i) };
                const mine: string[] = [];
                await this.acceptAndCommit(item.msg, item.ctx, item.actor, extraction, item.gate, mine);
                notes.push(...mine.map((n) => `#${i} ${item.actor.name}: ${n}`));
            }
            await graph.markBuffered(items.map((i) => i.id));
            return notes;
        });
    }

    async workingMemory(scopes: Scope[]) {
        return this.db().listBuffered(scopes);
    }

    // Dreaming, an offline pass over a scope: (1) merge entities that are one thing under two names (judged
    // by Jev from their facts); (2) sweep each entity's current facts for ones a newer fact made untrue or
    // repeats, which per-message comparison missed. Nothing is deleted: facts move or are invalidated.
    async dream(scope: Scope, directory: PersonRef[], now: Date): Promise<string[]> {
        return this.consolidations.run([scope], async () => {
            const graph = this.db();
            const at = now.toISOString();
            const notes: string[] = [];
            if (DREAMING.steps.has('merge') || DREAMING.steps.has('retire')) notes.push(...(await this.mergeAndRetire(scope, at)));
            if (DREAMING.steps.has('aliases') || DREAMING.steps.has('profiles')) notes.push(...(await this.namesAndProfiles(scope, at)));
            return notes.length ? notes : ['nothing to merge, retire, name or describe'];
        });
    }

    // Dreaming, aliases and profiles: for each entity with facts newer than its last dream, the other names the
    // messages use for it (checked by acceptAliases) and a short profile from its current facts.
    private async namesAndProfiles(scope: Scope, at: string): Promise<string[]> {
        const graph = this.db();
        const todo = await graph.entitiesToDream(scope);
        if (!todo.length) return [];
        const owners = await graph.aliasesInScope(scope);
        const allNames = (await graph.entitiesInScope(scope)).map((e) => e.name);
        const notes: string[] = [];
        for (let start = 0; start < todo.length; start += DREAMING.batchSize) {
            const batch = await Promise.all(todo.slice(start, start + DREAMING.batchSize).map(async (e) => ({
                ...e,
                facts: (await graph.entitySummary(e.uuid, at, 10)).split('; ').filter(Boolean),
                messages: await graph.episodesMentioning(e.uuid, 3),
            })));
            let results: { index: number; aliases: string[]; profile: string }[];
            try {
                results = await dreamEntities({ entities: batch, allNames, model: DREAMING.model });
            } catch (error: any) {
                notes.push(`${batch.map((e) => e.name).join(', ')}: dreaming failed (${error?.message ?? error})`);
                continue;
            }
            for (const [index, e] of batch.entries()) {
                const result = results.find((r) => r.index === index) ?? { aliases: [], profile: '' };
                if (DREAMING.steps.has('aliases')) {
                    const taken = new Set(owners.filter((o) => o.uuid !== e.uuid).flatMap((o) => o.aliases));
                    const added = acceptAliases(result.aliases, { existing: [e.name, e.key, ...e.aliases], messages: e.messages, taken });
                    for (const alias of added) await graph.addAlias(e.uuid, alias);
                    owners.find((o) => o.uuid === e.uuid)?.aliases.push(...added);
                    if (added.length) notes.push(`${e.name}: also called ${added.map((a) => `"${a}"`).join(', ')}`);
                }
                const profile = result.profile.trim();
                if (DREAMING.steps.has('profiles') && profile && e.facts.length) {
                    await graph.setProfile(e.uuid, profile, await this.embedOne(profile), at);
                    notes.push(`${e.name}: profile: ${profile}`);
                } else {
                    await graph.markDreamed(e.uuid, at);
                }
            }
        }
        return notes;
    }

    // Dreaming, merge and retire: entities that are one thing under two names, and facts newer ones made untrue.
    private async mergeAndRetire(scope: Scope, at: string): Promise<string[]> {
        const graph = this.db();
        const notes: string[] = [];
        const entities = (await graph.entitiesInScope(scope)).filter((e) => e.kind !== 'person');
        const merged = new Set<string>();
        for (const e of DREAMING.steps.has('merge') ? entities : []) {
            if (merged.has(e.uuid)) continue;
            const others = entities.filter((o) => o.uuid !== e.uuid && !merged.has(o.uuid));
            const summary = await graph.entitySummary(e.uuid, at, 5);
            if (!summary) continue;
            const byName = await findCandidates(e.name, e.kind, others.map((o) => ({ id: o.uuid, name: o.name, kind: o.kind })), 'vector');
            const described = await this.describedCandidates(scope, e.name, at, byName);
            const candidates = [...byName, ...described];
            for (const c of candidates) c.summary ??= await graph.entitySummary(c.id, at);
            // The messages that mentioned it are the context a person would use ("pausing the WebRTC product
            // and Ankit needs to move back to UI" ties it to what Ankit was working on).
            const evidence = [`Known facts about ${e.name}: ${summary}`, ...(await graph.episodesMentioning(e.uuid, 2))].join('\n');
            let result = await matchEntity(e.name, e.kind, evidence, byName);
            if (!result.match && described.length) result = await matchDescription(e.name, evidence, described);
            if (!result.match) continue;
            // Keep the entity that has more facts (usually the properly named one).
            const [keep, drop] = (await graph.entitySummary(result.match.id, at, 50)).split('; ').length >= summary.split('; ').length
                ? [result.match.id, e.uuid] : [e.uuid, result.match.id];
            await graph.mergeEntity(drop, keep);
            merged.add(drop);
            notes.push(`merged "${entities.find((x) => x.uuid === drop)?.name}" into ${entities.find((x) => x.uuid === keep)?.name} (${result.probability.toFixed(2)})`);
        }
        for (const { name, facts } of DREAMING.steps.has('retire') ? await graph.factsByEntity(scope, at) : []) {
            const items = facts.slice(1).map((f, i) => ({ index: i + 1, fact: f.fact, existing: facts.slice(Math.max(0, i - 7), i + 1).map((x) => ({ uuid: x.uuid, fact: x.fact })) }));
            if (!items.length) continue;
            const resolutions = await resolveFacts(items.slice(-8));
            for (const r of resolutions) {
                const newer = facts[r.index];
                if (!newer) continue;
                for (const uuid of r.contradicts) {
                    const older = facts.find((f) => f.uuid === uuid);
                    if (!older || older.created_at > newer.created_at) continue;
                    await graph.invalidateFact(uuid, newer.valid_at ?? newer.created_at, at);
                    notes.push(`${name}: "${older.fact}" no longer true (after "${newer.fact}")`);
                }
                const duplicate = facts.find((f) => f.uuid === r.duplicate_of);
                if (duplicate && duplicate.created_at < newer.created_at) {
                    await graph.invalidateFact(newer.uuid, newer.valid_at ?? newer.created_at, at);
                    notes.push(`${name}: "${newer.fact}" repeats "${duplicate.fact}"`);
                }
            }
        }
        return notes;
    }

    private async acceptAndCommit(msg: RawMessage, ctx: IngestContext, actor: PersonRef, extraction: GraphExtraction, gate: GateDecision | null, notes: string[]) {
        const graph = this.db();
        const now = ctx.now.toISOString();
        const accepted: AcceptedFact[] = [];
        for (const fact of extraction.facts) {
            if (gate?.forcePersonal) fact.scope = 'personal';
            if (fact.certainty === 'hypothetical') {
                notes.push(`skip hypothetical: ${fact.fact}`);
                continue;
            }
            if (!evidenceFound(fact.evidence, msg)) {
                notes.push(`drop (evidence not in message): ${fact.fact}`);
                continue;
            }
            // "Ankit Kumar's name is Ankit": the people directory already knows names and aliases.
            if (/\b(name is|is called|goes by|is (also )?known as)\b/i.test(fact.fact) && findPerson(fact.source, ctx.directory, actor)) {
                notes.push(`drop (only restates a name): ${fact.fact}`);
                continue;
            }
            const decision = decideScope(fact.scope, ctx);
            if ('rejected' in decision) {
                notes.push(`reject ${fact.scope} write (${decision.rejected}): ${fact.fact}`);
                continue;
            }
            accepted.push({ fact, scope: decision.scope, proposed: gate?.proposed === true || msg.kind === 'agent' || fact.certainty === 'inferred' });
        }
        if (accepted.length === 0) {
            notes.push(extraction.facts.length ? 'no facts accepted' : 'no facts extracted');
            return;
        }

        // Extraction (the slow part) runs freely; comparing with and changing the graph is the commit.
        const commit = () => this.commit(msg, ctx, actor, extraction, accepted, notes, now);
        const created = this.options.serial
            ? await this.commits.run([...new Set(accepted.map((a) => a.scope))], commit)
            : await commit();

        if (this.options.lexical && created.length) {
            if (this.options.fuse) {
                for (const edge of created) {
                    if (edge.terms?.length) await graph.setSearchText(edge.uuid, [edge.fact, ...edge.terms].join('\n'));
                }
            } else {
                const expansions = await expandFacts(created.map((edge, index) => ({ index, fact: edge.fact })));
                for (const [index, edge] of created.entries()) {
                    const expansion = expansions.find((e) => e.index === index);
                    if (expansion) await graph.setSearchText(edge.uuid, [edge.fact, ...expansion.questions, ...expansion.keywords].join('\n'));
                }
            }
        }
    }

    // Resolves entities, records episodes, and dedupes/invalidates/creates facts. Returns the new facts.
    private async commit(
        msg: RawMessage,
        ctx: IngestContext,
        actor: PersonRef,
        extraction: GraphExtraction,
        accepted: AcceptedFact[],
        notes: string[],
        now: string
    ): Promise<{ uuid: string; fact: string; terms?: string[] }[]> {
        const graph = this.db();
        const created: { uuid: string; fact: string; terms?: string[] }[] = [];
        const disputes = this.options.disputes || this.options.serial;

        // 1. Resolve every entity a fact refers to, within the fact's scope.
        const kindOf = (name: string) => extraction.entities.find((e) => aliasKey(e.name) === aliasKey(name))?.kind ?? 'other';
        const entities = await this.resolveEntities(accepted, kindOf, ctx.directory, actor, notes, now, renderTurns(msg.turns));
        const entityFor = (scope: Scope, name: string) => entities.get(`${scope}|${aliasKey(name)}`)!;

        // 2. Record the episode (provenance) per scope.
        for (const scope of new Set(accepted.map((a) => a.scope))) {
            const uuids = [...entities.entries()].filter(([k]) => k.startsWith(`${scope}|`)).map(([, e]) => e.uuid);
            await graph.addEpisode(`${msg.id}@${scope}`, scope, renderMessage(msg), msg.occurredAt, uuids);
        }

        // 3. Compare each new fact with what the graph already believes; dedupe or invalidate.
        const prepared = [];
        for (const item of accepted) {
            const source = entityFor(item.scope, item.fact.source);
            const target = item.fact.target ? entityFor(item.scope, item.fact.target) : source;
            const relation = item.fact.relation.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
            const embedding = await this.embedOne(item.fact.fact);
            const candidates = await graph.candidateFacts(item.scope, source.uuid, target.uuid, relation, embedding, now, this.similarity().relatedFact);
            prepared.push({ ...item, source, target, relation, embedding, candidates });
        }
        const toResolve = prepared.map((p, index) => ({ index, fact: p.fact.fact, existing: p.candidates.map((c) => ({ uuid: c.uuid, fact: c.fact })) }))
            .filter((item) => item.existing.length > 0);
        const resolutions = toResolve.length ? await resolveFacts(toResolve) : [];

        for (const [index, item] of prepared.entries()) {
            const resolution = resolutions.find((r) => r.index === index);
            const candidateIds = new Set(item.candidates.map((c) => c.uuid));
            const duplicate = item.candidates.find((c) => c.uuid === resolution?.duplicate_of);
            if (duplicate && (duplicate.status === 'current' || item.proposed)) {
                await graph.addEpisodeToFact(duplicate.uuid, msg.id);
                notes.push(`${item.scope} duplicate of existing: ${item.fact.fact}`);
                continue;
            }
            // Unconfirmed facts never invalidate confirmed knowledge.
            let contradicted = item.proposed ? [] : (resolution?.contradicts ?? []).filter((id) => candidateIds.has(id));
            if (this.options.checker && contradicted.length) {
                const proposals = contradicted.map((uuid) => ({ uuid, fact: item.candidates.find((c) => c.uuid === uuid)!.fact }));
                const { kept, confirmed } = await vetoInvalidations(item.fact.fact, item.fact.evidence, proposals);
                for (const k of kept) notes.push(`checker kept (a different thing, ${k.different.toFixed(2)}): ${k.fact}`);
                contradicted = confirmed;
            }
            if (duplicate) contradicted.push(duplicate.uuid); // a confirmed restatement replaces the proposed edge
            // Racing writes (different author, same minute) don't win silently: both become disputed.
            const racing = disputes
                ? contradicted.filter((uuid) => {
                    const c = item.candidates.find((x) => x.uuid === uuid);
                    return !!c?.author && c.author !== msg.actorName && Math.abs(Date.parse(c.created_at) - Date.parse(now)) <= DISPUTE_WINDOW_MS;
                })
                : [];
            // valid_at is when the fact became true. The extractor sometimes gives the date the fact is about
            // ("launch is November 5" â†’ November 5), which inverts this fact's window and the one it replaces;
            // a statement is true from when it is made at the latest.
            const stated = item.fact.valid_at;
            const validAt = stated && Date.parse(stated) <= Date.parse(msg.occurredAt) ? stated : msg.occurredAt;
            for (const uuid of contradicted) {
                if (racing.includes(uuid)) await graph.setStatus(uuid, 'disputed');
                else await graph.invalidateFact(uuid, validAt, now);
            }
            const uuid = randomUUID();
            await graph.createFact({
                uuid,
                name: item.relation,
                fact: item.fact.fact,
                scope: item.scope,
                status: item.proposed ? 'proposed' : racing.length ? 'disputed' : 'current',
                valid_at: validAt,
                invalid_at: endTime(item.fact.invalid_at),
                created_at: now,
                episode_ids: [msg.id],
                author: msg.actorName,
                source: item.source.uuid,
                target: item.target.uuid,
                embedding: item.embedding,
                evidence: item.fact.evidence,
            });
            created.push({ uuid, fact: item.fact.fact, terms: item.fact.search_terms });
            const effect = racing.length ? ` (disputed with ${racing.length})` : contradicted.length ? ` (invalidated ${contradicted.length})` : '';
            notes.push(`${item.scope} ${item.proposed ? 'proposed' : 'new'} fact${effect}: ${item.fact.fact}`);
        }
        return created;
    }

    private async resolveEntities(
        accepted: AcceptedFact[],
        kindOf: (name: string) => string,
        directory: PersonRef[],
        actor: PersonRef,
        notes: string[],
        now: string,
        // The whole new message, for judging descriptive names in context.
        messageText: string
    ): Promise<Map<string, EntityNode>> {
        const graph = this.db();
        const resolved = new Map<string, EntityNode>();
        const pending: { mapKey: string; scope: Scope; key: string; name: string; kind: string; embedding: number[]; candidates: (EntityNode & { score: number })[] }[] = [];

        const mentions = new Map<string, { scope: Scope; name: string }>();
        for (const { fact, scope } of accepted) {
            for (const name of [fact.source, fact.target]) {
                if (name) mentions.set(`${scope}|${aliasKey(name)}`, { scope, name });
            }
        }

        // Exact matches first, so the same-message guard below knows every sibling's entity.
        for (const [mapKey, { scope, name }] of mentions) {
            const person = findPerson(name, directory, actor);
            const existing = await graph.findEntity(scope, person ? `person:${person.id}` : aliasKey(name));
            if (existing) resolved.set(mapKey, existing);
        }

        for (const [mapKey, { scope, name }] of mentions) {
            if (resolved.has(mapKey)) continue;
            const person = findPerson(name, directory, actor);
            const key = person ? `person:${person.id}` : aliasKey(name);
            const display = person ? person.name : name.trim();
            const embedding = await this.embedOne(display);
            const entity: EntityNode = { uuid: `${scope}|${key}`, scope, key, name: display, kind: person ? 'person' : kindOf(name) };
            if (person) {
                await graph.createEntity(entity, embedding, [aliasKey(person.name), ...person.aliases.map(aliasKey)]);
                resolved.set(mapKey, entity);
                continue;
            }
            if (this.options.match) {
                // Jev first: is this an existing entity under another name? The embedding+LLM dedupe
                // below still catches what Jev doesn't match.
                const inScope = await graph.entitiesInScope(scope);
                const evidence = accepted.find(({ fact }) => [fact.source, fact.target].includes(name))?.fact.evidence ?? name;
                // Same-message guard: other names in this message (same scope) are different things.
                const siblings = [...mentions.entries()].filter(([k, m]) => k !== mapKey && m.scope === scope);
                const siblingKeys = new Set(siblings.map(([, m]) => aliasKey(m.name)));
                const siblingIds = new Set(siblings.map(([k]) => resolved.get(k)?.uuid).filter((id): id is string => !!id));
                // With link, names an entity was given later count too ("Wire Pulse (also called webrtc product)").
                const pool = inScope.flatMap((e) => [
                    { id: e.uuid, name: e.name, kind: e.kind },
                    ...(this.options.link ? (e.aliases ?? []).filter((a) => a !== aliasKey(e.name) && a.includes(' ') && !/[:@]/.test(a)).map((a) => ({ id: e.uuid, name: `${e.name} (also called ${a})`, kind: e.kind })) : []),
                ]);
                const candidates = excludeSiblings(await findCandidates(display, entity.kind, pool, this.options.match), siblingKeys, siblingIds);
                if (this.options.summaries || this.options.link) {
                    for (const c of candidates) if (this.options.summaries || c.name.includes('(also called')) c.summary = await graph.entitySummary(c.id, now);
                }
                let result = await matchEntity(display, entity.kind, evidence, candidates);
                notes.push(...describeDecisions(display, result));
                let how = '';
                // No name matched: is this a description of an entity ("the WebRTC product")?
                if (!result.match && this.options.link) {
                    const described = excludeSiblings(await this.describedCandidates(scope, display, now, candidates), siblingKeys, siblingIds);
                    const byDescription = await matchDescription(display, messageText, described);
                    notes.push(...describeDecisions(display, byDescription));
                    if (byDescription.match) {
                        result = byDescription;
                        how = ' by description';
                    }
                }
                const node = result.match ? inScope.find((e) => e.uuid === result.match!.id) : undefined;
                if (node) {
                    await graph.addAlias(node.uuid, key);
                    resolved.set(mapKey, node);
                    notes.push(`match${how}: "${display}" â†’ ${node.name} (${result.probability.toFixed(2)})`);
                    continue;
                }
            }
            const candidates = await graph.similarEntities(scope, embedding, 0.8, 3);
            if (candidates.length) pending.push({ mapKey, scope, key, name: display, kind: entity.kind, embedding, candidates });
            else {
                await graph.createEntity(entity, embedding, []);
                resolved.set(mapKey, entity);
            }
        }

        if (pending.length) {
            const results = await dedupeEntities(pending.map((p, index) => ({ index, name: p.name, kind: p.kind, candidates: p.candidates })));
            for (const [index, p] of pending.entries()) {
                const match = p.candidates.find((c) => c.uuid === results.find((r) => r.index === index)?.match_uuid);
                if (match) {
                    await graph.addAlias(match.uuid, p.key);
                    resolved.set(p.mapKey, match);
                } else {
                    const entity: EntityNode = { uuid: `${p.scope}|${p.key}`, scope: p.scope, key: p.key, name: p.name, kind: p.kind };
                    await graph.createEntity(entity, p.embedding, []);
                    resolved.set(p.mapKey, entity);
                }
            }
        }
        return resolved;
    }

    async recall(q: RecallInput): Promise<RecallResult> {
        const graph = this.db();
        const at = q.asOf ?? q.now;
        const scopes = q.readableScopes;
        // A buffer past its maximum wait would have been consolidated by a background timer by now; do that
        // first (in production the timer runs on its own and reads never wait for it).
        if (this.options.consolidate && WORKING_MEMORY.consolidateOnRead) {
            for (const scope of scopes) {
                const pending = await graph.pendingBuffered(scope);
                if (pending.length && Date.parse(q.now) - Date.parse(pending[0].at) >= WORKING_MEMORY.maxAgeMinutes * 60_000) {
                    await this.consolidate(scope, q.directory);
                }
            }
        }
        // With rank, "everything / all / list" questions get twice the places.
        if (this.options.rank && /\b(everything|all|list|summar\w*|overview)\b/i.test(q.query)) q = { ...q, topK: q.topK * 2 };

        // Facts touching entities the question names (plus the asker for "I/my"), then global matches.
        const normalized = normalizeForAliases(q.query);
        const mentioned = await graph.entitiesMentioned(scopes, normalized, this.options.rank);
        // With rank, people named with a typo count too ("Is Denial available?").
        if (this.options.rank) {
            for (const person of peopleMentionedFuzzily(q.query, q.directory)) mentioned.push(...scopes.map((s) => `${s}|person:${person.id}`));
        }
        // The asker ("I", "my") is the subject when the question names nothing else ("everything about me",
        // "the project I'm on") and is boosted then; otherwise their facts are searched but not boosted, so
        // they can't crowd out what was asked about ("my target for the checkout module").
        const askerIds = /\b(i|me|my|mine|myself)\b/.test(normalized) ? scopes.map((s) => `${s}|person:${q.asPersonId}`) : [];
        const namedIds = new Set(mentioned.length || !this.options.rank ? mentioned : askerIds);
        mentioned.push(...askerIds);
        const touchesNamed = (e: FactEdge) => namedIds.has(e.source_uuid) || namedIds.has(e.target_uuid);
        // crowd: entities one hop from what the question is about; their facts get half the named prior.
        const linkedIds = new Set<string>();
        const touchesLinked = (e: FactEdge) => linkedIds.has(e.source_uuid) || linkedIds.has(e.target_uuid);
        const prior = (e: FactEdge) => (touchesNamed(e) ? 1 : touchesLinked(e) ? 0.5 : 0);
        const byBoostedScore = (boost: (e: FactEdge, score: number) => number) => (a: FactEdge, b: FactEdge) =>
            boost(b, b.score ?? 0) - boost(a, a.score ?? 0);
        // crowd: the entities the top facts lead to, other than those the question already names.
        const linkedFrom = (top: FactEdge[]) => {
            const linked = [...new Set(top.slice(0, 3).flatMap((e) => [e.source_uuid, e.target_uuid]))].filter((uuid) => !mentioned.includes(uuid));
            linked.forEach((uuid) => linkedIds.add(uuid));
            return linked;
        };

        let ranked: FactEdge[];
        let history: FactEdge[];
        let questionVector: number[] | null = null;
        if (this.options.lexical) {
            // Full-text search over facts and their write-time expansions; the question isn't embedded.
            const words = queryWords(q.query);
            const sort = (edges: FactEdge[]) => dedupe(edges).sort(byBoostedScore((e, s) => s * (1 + (LEXICAL_NAMED_BOOST - 1) * prior(e))));
            const [named, near, recent, expired] = await Promise.all([
                mentioned.length ? graph.searchFacts(scopes, at, words, q.topK, mentioned) : [],
                graph.searchFacts(scopes, at, words, q.topK, null),
                graph.entityFacts(scopes, at, mentioned, q.topK),
                graph.searchExpired(scopes, at, words, 3),
            ]);
            let scored = [...named, ...near];
            let unscored = recent;
            if (this.options.crowd) {
                const linked = linkedFrom(this.options.rank ? sort(scored) : scored);
                if (linked.length) {
                    const [matches, latest] = await Promise.all([graph.searchFacts(scopes, at, words, q.topK, linked), graph.entityFacts(scopes, at, linked, 3)]);
                    scored = [...scored, ...matches];
                    unscored = [...unscored, ...latest];
                }
            }
            ranked = this.options.rank ? [...sort(scored), ...unscored] : [...scored, ...unscored];
            history = expired;
        } else {
            const queryVector = await this.embedOne(q.query, true);
            questionVector = queryVector;
            const sort = (edges: FactEdge[]) => dedupe(edges).sort(byBoostedScore((e, s) => s + NAMED_PRIOR * prior(e)));
            const named = mentioned.length ? await graph.nearestFacts(scopes, at, queryVector, q.topK, mentioned) : [];
            const near = await graph.nearestFacts(scopes, at, queryVector, q.topK, null);
            let scored = [...named, ...near];
            // Profiles (written by dreaming): entities whose profile is close to the question join the one-hop
            // entities, so a vague question reaches the right entity's facts without outranking what it names.
            if (DREAMING.profileRecall) {
                const profiled = (await graph.profileMatches(scopes, queryVector, DREAMING.profileMin, 3)).map((p) => p.uuid).filter((uuid) => !mentioned.includes(uuid));
                if (profiled.length) {
                    profiled.forEach((uuid) => linkedIds.add(uuid));
                    scored = [...scored, ...(await graph.nearestFacts(scopes, at, queryVector, q.topK, profiled))];
                }
            }
            if (this.options.crowd) {
                const linked = linkedFrom(this.options.rank ? sort(scored) : scored);
                if (linked.length) scored = [...scored, ...(await graph.nearestFacts(scopes, at, queryVector, q.topK, linked))];
            }

            ranked = this.options.rank ? sort(scored) : scored;
            // Zep-style hybrid retrieval: vector + full-text + 2-hop BFS from the question's entities and the
            // top facts' endpoints, fused by reciprocal rank; facts about named entities stay first.
            if (this.options.hybrid) {
                const text = await graph.fullTextFacts(scopes, at, queryWords(q.query), q.topK);
                const seeds = [...new Set([...mentioned, ...near.slice(0, 3).flatMap((e) => [e.source_uuid, e.target_uuid])])];
                const bfs = await graph.bfsFacts(scopes, at, seeds, q.topK * 2);
                ranked = [...named, ...reciprocalRankFusion([near, text, bfs], (e) => e.uuid)];
            }
            history = await graph.expiredFacts(scopes, at, queryVector, 3, this.similarity().history);
        }

        const visible = (edge: FactEdge) => edge.status !== 'proposed' || q.includeProposed;
        const candidates = dedupe(ranked).filter(visible);
        let selected = (this.options.crowd ? crowd(candidates, CROWD_CAP, namedIds) : candidates).slice(0, q.topK);
        if (this.options.ppr) selected = await this.withBridges(selected, mentioned, q, at, visible);

        // Working memory: what was said but not consolidated yet is newer than any fact, so it comes first.
        const waiting = this.options.consolidate ? await graph.bufferedForRead(scopes, q.asOf ?? q.now, questionVector, WORKING_MEMORY.readSlots) : [];
        const memories: RecalledMemory[] = [
            ...waiting.map((w) => ({
                text: `${w.actor} said (not consolidated yet): ${w.text}`, scope: w.scope, status: 'current' as const,
                validFrom: w.at, validTo: null, sourceMessageIds: [w.id.split('@')[0]], score: w.score, author: w.actor,
            })),
            ...selected.map((edge) => toMemory(edge, edge.status)),
            ...history.map((edge) => ({ ...toMemory(edge, 'superseded'), validTo: edge.invalid_at ?? edge.expired_at })),
        ];
        return { memories, notes: [`named entities: ${mentioned.length}`] };
    }

    // Candidates for entity linking by description, for descriptive names only ("the WebRTC product":
    // distinctive words + a generic head): entities whose facts mention the distinctive words but whose name
    // doesn't (name matches are found anyway), each with its facts, which Jev needs to judge.
    private async describedCandidates(scope: Scope, display: string, now: string, already: EntityCandidate[]): Promise<EntityCandidate[]> {
        const words = display.toLowerCase().match(/[a-z0-9]+/g) ?? [];
        if (words.length < 2 || !DESCRIPTIVE_HEADS.has(words[words.length - 1])) return [];
        const distinctive = words.filter((w) => w.length >= 3 && !DESCRIPTIVE_HEADS.has(w) && !['the', 'our', 'new', 'this', 'that'].includes(w));
        if (distinctive.length === 0) return [];
        const known = new Set(already.map((c) => c.id));
        const found = (await this.db().entitiesDescribedBy(scope, now, distinctive, 3))
            .filter((e) => !known.has(e.uuid) && !distinctive.some((w) => e.name.toLowerCase().includes(w)));
        return Promise.all(found.map(async (e) => ({ id: e.uuid, name: e.name, kind: e.kind, summary: await this.db().entitySummary(e.uuid, now, 4, distinctive) })));
    }

    // Personalized PageRank seeded at the question's entities and the top facts' endpoints. A fact
    // scores as its less-activated end, so facts connecting what the question is about beat facts
    // hanging off one seed; the best take the last BRIDGE_SLOTS places, so the direct matches ahead
    // of them are never pushed out.
    private async withBridges(
        selected: FactEdge[],
        mentioned: string[],
        q: RecallInput,
        at: string,
        visible: (edge: FactEdge) => boolean
    ): Promise<FactEdge[]> {
        const graph = this.db();
        const seeds = new Map<string, number>(mentioned.map((uuid) => [uuid, 1]));
        for (const edge of selected.slice(0, 3)) {
            for (const uuid of [edge.source_uuid, edge.target_uuid]) seeds.set(uuid, Math.max(seeds.get(uuid) ?? 0, 0.5));
        }
        const edges = (await graph.edgeEndpoints(q.readableScopes, at)).filter((e) => e.source !== e.target);
        const rank = personalizedPageRank(edges.map((e) => [e.source, e.target]), seeds);
        const kept = selected.slice(0, q.topK - BRIDGE_SLOTS);
        const keptIds = new Set(kept.map((e) => e.uuid));
        const best = edges
            .filter((e) => !keptIds.has(e.uuid))
            .map((e) => ({ uuid: e.uuid, score: Math.min(rank.get(e.source) ?? 0, rank.get(e.target) ?? 0) }))
            .filter((e) => e.score > 0)
            .sort((a, b) => b.score - a.score);
        const bridges = (await graph.factsByUuid(best.slice(0, BRIDGE_SLOTS * 2).map((e) => e.uuid))).filter(visible).slice(0, BRIDGE_SLOTS);
        return dedupe([...kept, ...bridges, ...selected.slice(kept.length)]).slice(0, q.topK);
    }

    async snapshot(scopes: Scope[], asOf?: Date): Promise<RecalledMemory[]> {
        const at = (asOf ?? new Date('9999-12-31T00:00:00Z')).toISOString();
        const edges = await this.db().factsInScopes(scopes, at);
        return edges.map((edge) => toMemory(edge, edge.status));
    }

    async inspectGraph(scopes: Scope[], at: Date, history: boolean): Promise<MemoryGraph> {
        const { nodes, edges } = await this.db().subgraph(scopes, at.toISOString(), history);
        return {
            nodes,
            edges: edges.map((e) => ({
                id: e.id, source: e.source, target: e.target, relation: e.relation, text: e.text,
                status: (e.believed ? e.status : 'superseded') as MemoryGraph['edges'][number]['status'],
                validFrom: e.validFrom, validTo: e.believed ? e.validTo : e.validTo ?? e.expiredAt, author: e.author, scope: e.scope,
            })),
        };
    }

    // For tests: the edge count must never decrease (nothing is deleted).
    async factCount(): Promise<number> {
        return this.db().countFacts();
    }
}

// Keeps the order, but a fact touching an entity that already has `cap` places waits until the facts
// about other entities have had theirs. With `hubs`, only those entities (the ones the question names) are
// capped: a project reached through them must not be crowded out by the hub's facts that mention it.
export function crowd<T extends Pick<FactEdge, 'source_uuid' | 'target_uuid'>>(edges: T[], cap: number, hubs?: Set<string>): T[] {
    const counts = new Map<string, number>();
    const kept: T[] = [];
    const waiting: T[] = [];
    for (const edge of edges) {
        const ends = [...new Set([edge.source_uuid, edge.target_uuid])].filter((uuid) => !hubs?.size || hubs.has(uuid));
        if (ends.some((uuid) => (counts.get(uuid) ?? 0) >= cap)) {
            waiting.push(edge);
            continue;
        }
        for (const uuid of ends) counts.set(uuid, (counts.get(uuid) ?? 0) + 1);
        kept.push(edge);
    }
    return [...kept, ...waiting];
}

function dedupe(edges: FactEdge[]): FactEdge[] {
    const seen = new Set<string>();
    return edges.filter((edge) => !seen.has(edge.uuid) && !!seen.add(edge.uuid));
}

function toMemory(edge: FactEdge, status: RecalledMemory['status']): RecalledMemory {
    return {
        text: status === 'proposed' ? `${edge.fact} (unconfirmed)` : edge.fact,
        scope: edge.scope,
        status,
        validFrom: edge.valid_at,
        validTo: edge.invalid_at,
        sourceMessageIds: edge.episode_ids,
        score: edge.score ?? null,
        author: edge.author,
    };
}
