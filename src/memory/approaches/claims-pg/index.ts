import { z } from 'zod';
import { getEmbedder } from '../../core/embed';
import { actorOf, aliasKey, evidenceFound } from '../../core/entities';
import { pgUrl } from '../../core/env';
import { structured } from '../../core/llm';
import { CandidateMode } from '../../core/entity-match';
import { describeGate, gateExchange } from '../../core/gate';
import { decideScope } from '../../core/scope';
import { IngestContext, IngestResult, MemoryApproach, MemoryGraph, MemoryStatus, PersonRef, RawMessage, RecallInput, RecallResult, RecalledMemory, Scope, teamLabel } from '../../core/types';
import { ClaimStatus } from './decide';
import { extractFacts } from './extract';
import { routeQuery } from './router';
import { normalizeValue, resolveEntity } from './resolve';
import { queryWords, reciprocalRankFusion } from '../../core/rank';
import { findUpdatedFact } from './invalidate';
import { ClaimRow, ClaimStore, openClaimStore, streamId } from './store';
import { PREDICATE_NAMES, PredicateDef, describeVocabulary, predicateDef } from './vocabulary';

// Approach A: structured claims (subject / predicate / value / scope) in an append-only Postgres log,
// with version-checked writes, supersession, disputes and as-of reads.

const QuerySchema = z.object({
    subjects: z.array(z.string()),
    predicates: z.array(z.enum(PREDICATE_NAMES)),
});

const MAX_HISTORY = 3;

const QUERY_SYSTEM = `You map a question about a team/personal memory onto the memory's vocabulary.
subjects: the specific entities the question is about. Reuse known entity names or people's full names exactly; "I", "me", "my" mean the asker.
predicates: up to 3 predicates from the vocabulary whose values would answer the question (empty if unclear).`;

export interface ClaimsPgOptions {
    // Jev ingest gate before extraction.
    gate: boolean;
    // Jev query router instead of the LLM query parse.
    router: boolean;
    // Jev entity matching for names without an exact alias; candidates from shared words only
    // ("lexical") or also typos, prefixes and embedding neighbours ("vector").
    match?: CandidateMode;
    // Zep-inspired extras:
    // invalidate: a claim on a subject with no current value may update an existing fact stated under
    //   another name (judged by Jev from the claim texts, like Zep's edge invalidation).
    invalidate?: boolean;
    // hybrid: full-text search fused with vector search (reciprocal rank fusion) at recall.
    hybrid?: boolean;
    // summaries: entity matching shows Jev each candidate's known facts, not just its name.
    summaries?: boolean;
}

// The Zep-inspired bundle on top of the front-runner.
export const ZEP: Pick<ClaimsPgOptions, 'match' | 'invalidate' | 'hybrid' | 'summaries'> = {
    match: 'vector',
    invalidate: true,
    hybrid: true,
    summaries: true,
};

export class ClaimsPgApproach implements MemoryApproach {
    name: string;
    capabilities = { asOf: true, perFactScope: true };
    private store: ClaimStore | null = null;
    private closeStore: (() => Promise<void>) | null = null;

    constructor(private options: ClaimsPgOptions = { gate: false, router: false }) {
        const zep = options.match === 'vector' && options.invalidate && options.hybrid && options.summaries;
        const match = options.match === 'vector' ? '+vecmatch' : options.match ? '+match' : '';
        const extras = zep ? '+zep' : `${match}${options.invalidate ? '+inval' : ''}${options.hybrid ? '+hybrid' : ''}`;
        this.name = `claims-pg${options.gate ? '+gate' : ''}${options.router ? '+router' : ''}${extras}`;
    }

    async init() {
        const { store, close } = openClaimStore(pgUrl('mem_claims'), this.name.replace(/[^a-z0-9]+/g, '_'));
        this.store = store;
        this.closeStore = close;
        await store.init();
    }

    async reset() {
        await this.db().reset();
    }

    async close() {
        await this.closeStore?.();
    }

    private db(): ClaimStore {
        if (!this.store) throw new Error('claims-pg not initialized');
        return this.store;
    }

    async ingest(msg: RawMessage, ctx: IngestContext): Promise<IngestResult> {
        const store = this.db();
        const actor = actorOf(msg.actorPersonId, msg.actorName, ctx.directory);
        const notes: string[] = [];
        const gate = this.options.gate ? await gateExchange(msg) : null;
        if (gate) {
            notes.push(describeGate(gate));
            if (gate.skip) return { notes };
        }
        const facts = await extractFacts({
            msg,
            actor,
            directory: ctx.directory,
            // What the app says the user is working in; decideScope enforces whether they may write there.
            activeTeam: teamLabel(msg),
            knownEntities: await store.listEntities(ctx.writableScopes),
        });

        // Same-message guard: the names this message uses as separate subjects are different things,
        // so none of them (or the entities they resolve to) may be a merge target for another.
        const mentionKeys = new Set<string>();
        for (const fact of facts) {
            mentionKeys.add(aliasKey(fact.subject));
            if (PREDICATE_NAMES.includes(fact.predicate) && predicateDef(fact.predicate).valueType === 'entity') mentionKeys.add(aliasKey(fact.value));
        }
        const resolvedIds = new Map<string, string>();
        for (const key of mentionKeys) {
            const known = await store.findEntity(key);
            if (known) resolvedIds.set(key, known.id);
        }
        const matchingFor = (mention: string, evidence: string) => {
            if (!this.options.match) return null;
            const own = aliasKey(mention);
            return {
                scopes: ctx.writableScopes,
                evidence,
                mode: this.options.match,
                siblingKeys: new Set([...mentionKeys].filter((k) => k !== own)),
                siblingIds: new Set([...resolvedIds].filter(([k]) => k !== own).map(([, id]) => id)),
                summaries: this.options.summaries,
            };
        };

        for (const fact of facts) {
            if (gate?.forcePersonal) fact.scope = 'personal';
            const label = `${fact.subject} ${fact.predicate}=${fact.value}`;
            if (fact.certainty === 'hypothetical') {
                notes.push(`skip hypothetical: ${label}`);
                continue;
            }
            if (!evidenceFound(fact.evidence, msg)) {
                notes.push(`drop (evidence not in message): ${label}`);
                continue;
            }
            const scopeDecision = decideScope(fact.scope, ctx);
            if ('rejected' in scopeDecision) {
                notes.push(`reject ${fact.scope} write (${scopeDecision.rejected}): ${label}`);
                continue;
            }
            const scope = scopeDecision.scope;
            const def = predicateDef(fact.predicate);
            const subject = (await resolveEntity(store, fact.subject, fact.subject_kind, ctx.directory, actor, true, matchingFor(fact.subject, fact.evidence)))!;
            resolvedIds.set(aliasKey(fact.subject), subject.id);
            notes.push(...(subject.matchNotes ?? []));
            if (subject.matchedFrom) notes.push(`match: "${subject.matchedFrom.mention}" → ${subject.name} (${subject.matchedFrom.probability.toFixed(2)})`);

            let value = normalizeValue(fact.value, def.valueType);
            let valueEntity: string | null = null;
            if (def.valueType === 'entity') {
                const kind = def.name === 'depends_on' ? 'service' : 'other';
                const target = (await resolveEntity(store, fact.value, kind, ctx.directory, actor, true, matchingFor(fact.value, fact.evidence)))!;
                resolvedIds.set(aliasKey(fact.value), target.id);
                notes.push(...(target.matchNotes ?? []));
                if (target.matchedFrom) notes.push(`match: "${target.matchedFrom.mention}" → ${target.name} (${target.matchedFrom.probability.toFixed(2)})`);
                value = { value: target.name, norm: target.id, display: target.name };
                valueEntity = target.id;
            }

            const proposed =
                gate?.proposed === true ||
                msg.kind === 'agent' ||
                fact.certainty === 'inferred' ||
                (def.confirmRole === 'admin' && scope.startsWith('team:') && ctx.teamRole !== 'admin');

            // Zep-style invalidation: no current value for this subject+predicate, but maybe an existing
            // fact under another name is what this claim updates.
            let target = { id: subject.id, name: subject.name };
            if (this.options.invalidate && def.cardinality === 'single' && !proposed && fact.operation === 'assert') {
                const ownStream = streamId({ scope, subjectId: subject.id, predicate: def.name, cardinality: 'single', valueNorm: value.norm, proposed: false });
                if (!(await store.streamExists(ownStream))) {
                    const newClaim = renderClaim(subject.name, def, value.display, 'current', [], fact.evidence);
                    const [embedding] = await getEmbedder().embed([newClaim]);
                    const siblingIds = new Set([...resolvedIds].filter(([k]) => k !== aliasKey(fact.subject)).map(([, id]) => id));
                    // Top matches of the same predicate, no similarity cutoff (as in Zep): Jev decides.
                    const candidates = (await store.similarHeads(scope, def.name, ownStream, embedding, 5))
                        .filter((row) => !siblingIds.has(row.subject_id));
                    const { update, considered } = await findUpdatedFact(newClaim, fact.evidence, msg.occurredAt, candidates);
                    for (const c of considered.filter((c) => c.updates >= 0.5 && c.claim !== update?.target.claim_text.split(' — ')[0])) {
                        notes.push(`inval rejected: "${subject.name}" ≠ ${c.claim} (updates ${c.updates.toFixed(2)}, different ${c.different.toFixed(2)})`);
                    }
                    if (update) {
                        target = { id: update.target.subject_id, name: update.target.subject_name };
                        // A brand-new name for an existing thing: point the alias there for later mentions.
                        if (!(await store.entityHasClaims(subject.id))) await store.remapAlias(aliasKey(fact.subject), target.id);
                        resolvedIds.set(aliasKey(fact.subject), target.id);
                        notes.push(`inval: "${subject.name}" · ${def.name} updates ${target.name} (${update.probability.toFixed(2)})`);
                    }
                }
            }

            const decision = await store.append({
                scope,
                subjectId: target.id,
                subjectName: target.name,
                predicate: def.name,
                cardinality: def.cardinality,
                value: value.value,
                valueNorm: value.norm,
                valueEntity,
                operation: fact.operation,
                proposed,
                validFrom: new Date(msg.occurredAt),
                recordedAt: ctx.now,
                sourceMessageId: msg.id,
                actorPerson: msg.actorPersonId,
                actorAgent: msg.actorAgent,
                evidence: fact.evidence,
                render: (status, disputed) => renderClaim(target.name, def, value.display, status, disputed, fact.evidence),
                embed: async (text) => (await getEmbedder().embed([text]))[0],
            });
            notes.push(`${scope} ${target.name} · ${def.name} = ${value.value} → ${decision.kind === 'noop' ? `noop (${decision.reason})` : decision.status}`);
        }
        if (facts.length === 0) notes.push('no facts extracted');
        return { notes };
    }

    async recall(q: RecallInput): Promise<RecallResult> {
        const store = this.db();
        const asOf = q.asOf ? new Date(q.asOf) : null;
        const scopes = q.readableScopes;
        const asker = actorOf(q.asPersonId, q.asPersonId, q.directory);
        const entities = await store.listEntities(scopes);

        const parsed: { subjects: string[]; predicates: string[] } = this.options.router
            ? await routeQuery(q.query, asker, q.directory, entities)
            : await parseQuery(q.query, asker, q.directory, entities);

        // 1. Exact lookup on the subjects the question names, preferred predicates first,
        //    plus one hop along entity-valued claims and claims pointing at the subjects.
        const subjectIds: string[] = [];
        for (const mention of parsed.subjects) {
            const entity = await resolveEntity(store, mention, 'other', q.directory, asker, false);
            if (entity && !subjectIds.includes(entity.id)) subjectIds.push(entity.id);
        }
        let lookup: ClaimRow[] = [];
        if (subjectIds.length) {
            const rows = await store.heads(scopes, asOf, { subjectIds });
            const preferred = rows.filter((r) => parsed.predicates.includes(r.predicate));
            lookup = [...preferred, ...rows.filter((r) => !preferred.includes(r))];
            const hops = [...new Set(lookup.map((r) => r.value_entity).filter((id): id is string => !!id))];
            if (hops.length) lookup.push(...(await store.heads(scopes, asOf, { subjectIds: hops })));
            lookup.push(...(await store.heads(scopes, asOf, { valueEntities: subjectIds })));
        }

        // 2. Semantic fallback over claim text; with `hybrid`, fused with full-text search (Zep: cosine + BM25, RRF).
        const [queryVector] = await getEmbedder().embed([q.query]);
        const near = await store.nearest(scopes, asOf, queryVector, q.topK);
        const fallback = this.options.hybrid
            ? reciprocalRankFusion([near, await store.fullText(scopes, asOf, queryWords(q.query), q.topK)], (row) => row.stream_id)
            : near;

        const seen = new Set<string>();
        const selected = [...lookup, ...fallback].filter((row) => {
            if (seen.has(row.stream_id)) return false;
            if (row.status === 'proposed' && !q.includeProposed) return false;
            if (row.status === 'superseded') return false;
            seen.add(row.stream_id);
            return true;
        }).slice(0, q.topK);

        // 3. Precedence: when personal and team hold the same subject+predicate, the winning scope comes first.
        const ordered = applyPrecedence(selected);

        // 4. History context for changed single-valued facts ("moved from X").
        const names = new Map(q.directory.map((p) => [p.id, p.name]));
        const memories: RecalledMemory[] = ordered.map((row) => toMemory(row, names));
        let history = 0;
        for (const row of ordered) {
            // At most 3 history items, like temporal-kg, so neither approach gets more extra context.
            if (history >= MAX_HISTORY) break;
            if (row.stream_version < 2 || predicateDef(row.predicate).cardinality !== 'single') continue;
            const previous = await store.previousValue(row.stream_id, row.stream_version);
            if (previous && previous.value_norm !== row.value_norm) {
                memories.push({ ...toMemory(previous, names), status: 'superseded', validTo: row.recorded_at.toISOString() });
                history += 1;
            }
        }
        return { memories, notes: [`subjects=${parsed.subjects.join(', ') || '-'} predicates=${parsed.predicates.join(', ') || '-'}`] };
    }

    async snapshot(scopes: Scope[], asOf?: Date): Promise<RecalledMemory[]> {
        const rows = await this.db().heads(scopes, asOf ?? null);
        return rows.map((row) => toMemory(row));
    }

    // Claims as a graph: an entity-valued claim links its subject to the value's entity; any other value
    // ("launch date: 2026-11-30") is a fact about the subject. Only the current heads (no history).
    async inspectGraph(scopes: Scope[], at: Date): Promise<MemoryGraph> {
        const store = this.db();
        const [entities, rows] = await Promise.all([store.listEntities(scopes), store.heads(scopes, at)]);
        return {
            nodes: entities.map((e) => ({ id: e.id, name: e.name, kind: e.kind, aliases: [] })),
            edges: rows
                .filter((r) => r.status === 'current' || r.status === 'proposed' || r.status === 'disputed')
                .map((r) => ({
                    id: r.stream_id, source: r.subject_id, target: r.value_entity ?? r.subject_id, relation: r.predicate,
                    text: r.claim_text.split(' — ')[0], status: r.status as MemoryStatus,
                    validFrom: r.valid_from.toISOString(), validTo: null, author: r.actor_person, scope: r.scope,
                })),
        };
    }
}

// LLM query parse: which subjects and predicates a question is about.
async function parseQuery(question: string, asker: PersonRef, people: PersonRef[], entities: { name: string; kind: string }[]) {
    return structured({
        name: 'memory_query',
        schema: QuerySchema,
        system: QUERY_SYSTEM,
        user: [
            `Asker: ${asker.name}`,
            `Question: ${question}`,
            '',
            'Vocabulary:',
            describeVocabulary(),
            '',
            'People:',
            people.map((p) => `- ${p.name}`).join('\n'),
            '',
            'Known entities:',
            entities.map((e) => `- ${e.name} (${e.kind})`).join('\n') || '(none)',
        ].join('\n'),
    });
}

export function applyPrecedence(rows: ClaimRow[]): ClaimRow[] {
    const ordered: ClaimRow[] = [];
    for (const row of rows) {
        if (ordered.includes(row)) continue;
        const personalFirst = predicateDef(row.predicate).precedence === 'personal_wins';
        const rank = (r: ClaimRow) => (r.scope.startsWith('personal:') === personalFirst ? 0 : 1);
        const group = rows.filter((r) => r.subject_id === row.subject_id && r.predicate === row.predicate);
        ordered.push(...group.sort((a, b) => rank(a) - rank(b)));
    }
    return ordered;
}

// The verbatim evidence travels with the normalized claim, so qualifiers the vocabulary can't hold
// ("for Q4", "just for me") survive for the reader and for semantic search.
export function renderClaim(subjectName: string, def: PredicateDef, display: string, status: ClaimStatus, disputed: string[], evidence: string): string {
    const label = def.name.replace(/_/g, ' ');
    const quote = ` — "${evidence.trim()}"`;
    if (status === 'disputed') {
        // Disputed values are stored normalized; show them the way people write them ("$240,000").
        const shown = disputed.map((v) => (def.valueType === 'money' && /^[\d.]+$/.test(v) ? `$${Number(v).toLocaleString('en-US')}` : v));
        return `${subjectName} · ${label}: DISPUTED — conflicting values ${shown.join(' vs ')}`;
    }
    if (status === 'proposed') return `${subjectName} · ${label}: ${display} (unconfirmed)${quote}`;
    return `${subjectName} · ${label}: ${display}${quote}`;
}

// names: person id -> name, for provenance ("stated by Rahul Verma").
function toMemory(row: ClaimRow, names: Map<string, string> = new Map()): RecalledMemory {
    return {
        text: row.claim_text,
        scope: row.scope,
        status: row.status === 'retracted' ? 'superseded' : row.status,
        validFrom: row.valid_from.toISOString(),
        validTo: null,
        sourceMessageIds: row.source_message_ids,
        score: row.score ?? null,
        author: names.get(row.actor_person) ?? row.actor_person,
    };
}
