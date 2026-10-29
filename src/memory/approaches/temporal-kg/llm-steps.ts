import { z } from 'zod';
import { structured } from '../../core/llm';
import { selfFactsRule } from '../../core/scope-policy';
import { PersonRef, RawMessage, renderTurns, teamLabel } from '../../core/types';

// LLM steps of the graph pipeline: extraction, entity de-duplication and fact resolution
// (duplicate / contradiction). Prompts follow Graphiti's approach.

const KINDS = ['person', 'team', 'project', 'client', 'service', 'deliverable', 'other'] as const;

const FactSchema = z.object({
    source: z.string(),
    // null when the fact is an attribute of the source (a date, number, preference...).
    target: z.string().nullable(),
    relation: z.string(),
    fact: z.string(),
    scope: z.enum(['personal', 'team']),
    certainty: z.enum(['stated', 'inferred', 'hypothetical']),
    valid_at: z.string().nullable(),
    invalid_at: z.string().nullable(),
    evidence: z.string(),
});
const EntitiesSchema = z.array(z.object({ name: z.string(), kind: z.enum(KINDS) }));
const GraphExtractionSchema = z.object({ entities: EntitiesSchema, facts: z.array(FactSchema) });
// Operator fusion (as compilers fuse adjacent steps): the doc2query expansion is written by the
// extraction call itself instead of a second call.
const FusedExtractionSchema = z.object({ entities: EntitiesSchema, facts: z.array(FactSchema.extend({ search_terms: z.array(z.string()) })) });

export type ExtractedFact = z.infer<typeof FactSchema> & { search_terms?: string[] };
export type GraphExtraction = { entities: z.infer<typeof EntitiesSchema>; facts: ExtractedFact[] };

const extractSystem = () => `You turn a chat into a temporal knowledge graph for a shared memory that serves a person and their teams.
Extract the entities (people, teams, projects, clients, services, deliverables, other things) and the facts about them. Each fact links a source entity to a target entity, or only to a source when it is an attribute (a date, number, preference, rule), and is written as one standalone sentence.

Rules:
1. Extract only from the NEW turns. Earlier turns are context for resolving references.
2. A fact counts when the user states or confirms it. If only the assistant asserts or guesses something and the user doesn't confirm it, use certainty "inferred". Hypotheticals, brainstorming, questions and undecided options get certainty "hypothetical". Chit-chat and generic how-to help are not facts.
3. If the user corrects a value within the new turns, output only the final value. If something ends or is cancelled, state that as a fact ("X was cancelled"). Short status updates are facts too, including ones that end an earlier temporary state ("I'm back", "done for the day", "leave cancelled").
4. People: use full names from the people list; "I", "me", "my" mean the user. Reuse known entity names exactly when they refer to a known entity. For counts, the source names what is counted (e.g. "Phoenix beta testers").
5. fact: a self-contained sentence naming the source and the value. Write dates as "Month D, YYYY (YYYY-MM-DD)", resolving relative dates against the message time; money as written ("$240,000").
6. relation: SHORT_UPPER_SNAKE_CASE, e.g. LAUNCH_DATE, CODE_FREEZE_DATE, OWNS, DEPENDS_ON, KNOWS_LANGUAGE, PREFERS, POLICY, ROLE, CONTRACT_VALUE.
7. scope: ${selfFactsRule()} Facts about projects, clients, services, decisions, rules, and about other people's work are "team". With no active team, everything is personal.
8. valid_at / invalid_at: ISO date-times when the fact starts / stops being true, if stated, resolved against the message time; otherwise null. Temporary states end: "for the next 30 minutes" → invalid_at is the message time plus 30 minutes; "today" → the end of that day; "until Friday" → the end of that Friday; "this week" → the end of that week.
9. evidence: a short verbatim quote from the new turns that states the fact.`;

const SEARCH_TERMS_RULE = `
10. search_terms: for keyword search only (never shown to anyone): 3 short questions the fact answers, worded differently from the fact (synonyms, casual wording, other names for the same things), then up to 8 single words or short terms not in the fact that someone might use to ask about it (launch: go-live, release, ship; owns: owner, responsible, handles). No values or facts that aren't in the fact.`;

export interface ExtractInput {
    msg: RawMessage;
    actor: PersonRef;
    directory: PersonRef[];
    knownEntities: { name: string; kind: string }[];
    // Also write each fact's search terms (the fused doc2query expansion).
    searchTerms?: boolean;
}

export async function extractGraph(input: ExtractInput): Promise<GraphExtraction> {
    const { msg } = input;
    const user = [
        `Message time: ${msg.occurredAt}`,
        `App: ${msg.actorAgent}${msg.kind === 'agent' ? " (these are notes an agent inferred, not the user's own words)" : ''}`,
        `User: ${input.actor.name}`,
        `Active team: ${teamLabel(msg)}`,
        '',
        'People:',
        input.directory.map((p) => `- ${p.name}${p.aliases.length ? ` (also: ${p.aliases.join(', ')})` : ''}`).join('\n'),
        '',
        'Known entities:',
        input.knownEntities.length ? input.knownEntities.map((e) => `- ${e.name} (${e.kind})`).join('\n') : '(none yet)',
        '',
        'Earlier turns:',
        msg.context.length ? renderTurns(msg.context) : '(none)',
        '',
        'New turns:',
        renderTurns(msg.turns),
    ].join('\n');
    if (input.searchTerms) {
        return structured({ name: 'graph_extraction', schema: FusedExtractionSchema, system: extractSystem() + SEARCH_TERMS_RULE, user });
    }
    return structured({ name: 'graph_extraction', schema: GraphExtractionSchema, system: extractSystem(), user });
}

// Consolidation: one call for a batch of messages from working memory. Seeing them together lets the
// extractor name one thing consistently across messages and resolve references between them; each fact
// says which message stated it, so author, time and scope still come from that message.
const BATCH_RULES = `

Several messages follow, numbered. Treat each one as new turns from its own speaker: "the user" is that message's speaker ("I", "me", "my" mean them) and its active team is that message's team. For every fact, set message to the number of the message that states it; evidence must quote that message. Read all messages before extracting: use the others to resolve references and to give one thing one name (a product described in one message as "a managed WebRTC service" and called "the WebRTC product" in another is the same entity, under its proper name). Extract each message's facts even when a later message changes them: messages are applied in order, so a later one replaces an earlier one.
Extract exactly as you would from each message alone; a batch is no reason to summarize. One fact per value: "the site runs on Django, Redis and Celery" is three facts, so that one of them can change later without the others. Never merge facts from one message or from several into one sentence. Keep every detail of each message, including secondary ones: a second deadline next to the main one, requests and assignments ("Ana asked Raj to renew the certificate"), proposals and unconfirmed changes (with their certainty).`;

const BatchFact = FactSchema.extend({ message: z.number().int() });
const BatchSchema = z.object({ entities: EntitiesSchema, facts: z.array(BatchFact) });
const FusedBatchSchema = z.object({ entities: EntitiesSchema, facts: z.array(BatchFact.extend({ search_terms: z.array(z.string()) })) });

export interface BatchMessage {
    msg: RawMessage;
    actor: PersonRef;
}

export async function extractBatch(input: { messages: BatchMessage[]; directory: PersonRef[]; knownEntities: { name: string; kind: string }[]; searchTerms?: boolean }) {
    const user = [
        'People:',
        input.directory.map((p) => `- ${p.name}${p.aliases.length ? ` (also: ${p.aliases.join(', ')})` : ''}`).join('\n'),
        '',
        'Known entities:',
        input.knownEntities.length ? input.knownEntities.map((e) => `- ${e.name} (${e.kind})`).join('\n') : '(none yet)',
        '',
        'Messages:',
        ...input.messages.map(({ msg, actor }, i) => [
            `#${i} — time ${msg.occurredAt}; speaker ${actor.name}; active team ${teamLabel(msg)}; app ${msg.actorAgent}${msg.kind === 'agent' ? " (notes an agent inferred, not the speaker's own words)" : ''}`,
            // Earlier turns only resolve references ("he", "the migration"); facts come from the message itself.
            ...(msg.context.length ? [`(context only, don't extract from it:)\n${renderTurns(msg.context)}`] : []),
            renderTurns(msg.turns),
        ].join('\n')),
    ].join('\n');
    const system = extractSystem() + (input.searchTerms ? SEARCH_TERMS_RULE : '') + BATCH_RULES;
    const result = input.searchTerms
        ? await structured({ name: 'graph_batch_extraction', schema: FusedBatchSchema, system, user })
        : await structured({ name: 'graph_batch_extraction', schema: BatchSchema, system, user });
    return result as { entities: GraphExtraction['entities']; facts: (ExtractedFact & { message: number })[] };
}

const DedupeSchema = z.object({
    results: z.array(z.object({ index: z.number().int(), match_uuid: z.string().nullable() })),
});

export async function dedupeEntities(items: { index: number; name: string; kind: string; candidates: { uuid: string; name: string; kind: string }[] }[]) {
    const user = items
        .map((item) => [
            `NEW #${item.index}: ${item.name} (${item.kind})`,
            ...item.candidates.map((c) => `  candidate ${c.uuid}: ${c.name} (${c.kind})`),
        ].join('\n'))
        .join('\n\n');
    const { results } = await structured({
        name: 'entity_dedupe',
        schema: DedupeSchema,
        system: 'For each NEW entity mention, decide whether it refers to the same real-world thing as one of its candidates. Return the matching candidate uuid, or null if it is a different thing. Similar names are not enough; they must be the same entity.',
        user,
    });
    return results;
}

const ExpansionSchema = z.object({
    results: z.array(z.object({ index: z.number().int(), questions: z.array(z.string()), keywords: z.array(z.string()) })),
});

// Write-time query expansion (doc2query): the questions a fact answers and the other words people
// use for its terms, so a read can find it by full-text search alone, without embedding the question.
// Only searched, never shown to the reader, so it can't change what the memory says.
export async function expandFacts(facts: { index: number; fact: string }[]) {
    const { results } = await structured({
        name: 'fact_expansion',
        schema: ExpansionSchema,
        system: `You index facts for a team memory so they can be found by keyword search.
For each fact, write:
- questions: 3 short questions someone might ask that this fact answers, worded differently from the fact (synonyms, casual wording, other names for the same things, "I"/"my" phrasing when the fact is about a person).
- keywords: up to 8 single words or short terms that are not in the fact but that someone might use to ask about it: synonyms (launch: go-live, release, ship), abbreviations, related roles or actions (owns: owner, responsible, handles, maintainer).
Do not add values or facts that are not in the fact.`,
        user: facts.map((f) => `#${f.index}: ${f.fact}`).join('\n'),
    });
    return results;
}

const ResolutionSchema = z.object({
    results: z.array(z.object({
        index: z.number().int(),
        duplicate_of: z.string().nullable(),
        contradicts: z.array(z.string()),
    })),
});

export async function resolveFacts(items: { index: number; fact: string; existing: { uuid: string; fact: string }[] }[]) {
    const user = items
        .map((item) => [
            `NEW #${item.index}: ${item.fact}`,
            ...item.existing.map((e) => `  existing ${e.uuid}: ${e.fact}`),
        ].join('\n'))
        .join('\n\n');
    const { results } = await structured({
        name: 'fact_resolution',
        schema: ResolutionSchema,
        system: `You maintain a temporal knowledge graph. For each NEW fact, compare it with the EXISTING facts listed under it.
duplicate_of: the uuid of an existing fact that states the same thing with the same value, else null.
contradicts: uuids of existing facts that the new fact makes no longer true (a changed date, a new owner, a revised number, a reversed decision).
Facts that can both be true at once (someone knowing two languages, two different deadlines for different things) do not contradict.`,
        user,
    });
    return results;
}
