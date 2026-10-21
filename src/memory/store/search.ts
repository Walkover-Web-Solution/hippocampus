import { Params, query, toVector } from '../db';
import { memoryConfig } from '../config';
import { embedder } from '../embedder';
import { Connection, groupConnections, renderPrompt } from '../prompt';
import { queryTerms } from '../text';
import { NOTE_KINDS, NoteRow, SearchHit, SpaceRow } from '../types';
import { inUse, kindFilter, labelFilter, Moment, NOTE_COLUMNS, versionJoin } from './fragments';
import { linksOf, matchEntities, neighbours } from './graph';

/**
 * One query combines the three indexes: the nearest chunks by meaning, lifted by exact words, by names shared with
 * the query, by names one link away in the graph, and by how often a note was confirmed. The best chunk of each
 * note stands for the note.
 */
export const DEFAULT_TOP_K = 5;
export const MAX_TOP_K = 50;
// Cosine distance above which a chunk is too far from the query to be worth returning. The scale depends on the
// embedding model, so the default follows the configured model (memoryConfig.maxDistance, MEMORY_MAX_DISTANCE).
export const DEFAULT_MAX_DISTANCE = memoryConfig.maxDistance;
// Lessons are general by nature and may sit a little further from any one query.
const LESSON_MAX_DISTANCE = DEFAULT_MAX_DISTANCE + 0.05;
const CANDIDATES = 300;
const MAX_RULES = 30;
const RELEVANT_LESSONS = 3;
const CONNECTED_NAMES = 2;
const CONNECTION_LINKS = 40;
// A shared name, keyword or linked name may pull in a chunk slightly beyond the distance limit, never one that is
// clearly about something else.
const MATCH_DISTANCE_MARGIN = 0.1;

export interface SearchInput extends Moment {
    spaces: SpaceRow[];
    query: string;
    kinds?: string[] | null;
    // Kinds left out of the results, such as rules and lessons when the prompt block carries them already.
    excludeKinds?: string[] | null;
    labels?: string[] | null;
    topK?: number;
    maxDistance?: number;
    // The query's embedding when the caller already has it, so several searches of one text embed it once.
    embedding?: number[];
    // Names one link away from the names in the query: chunks naming them count a little.
    linked?: string[];
}

interface HitRow extends NoteRow {
    excerpt: string;
    ordinal: number;
    distance: number;
    score: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

export async function searchNotes(input: SearchInput): Promise<SearchHit[]> {
    if (!input.spaces.length || !input.query.trim()) return [];
    const embedding = input.embedding ?? (await embedder.embed([input.query], 'query'))[0];
    const terms = queryTerms(input.query);
    const params = new Params();
    const e = params.add(toVector(embedding));
    const keyword = params.add(terms.keywordQuery);
    const names = params.add(terms.names);
    const linked = params.add(input.linked ?? []);
    const spaceIds = params.add(input.spaces.map((space) => space.id));
    const maxDistance = params.add(input.maxDistance ?? DEFAULT_MAX_DISTANCE);
    const rows = await query<HitRow>(
        `WITH candidates AS (
            SELECT c.version_id, c.note_id, c.ordinal, c.text AS excerpt,
                   (c.embedding <=> ${e}::vector)::float8 AS distance,
                   COALESCE(ts_rank_cd(c.search_text, to_tsquery('simple', ${keyword}::text)), 0)::float8 AS keyword_rank,
                   cardinality(ARRAY(SELECT unnest(v.names) INTERSECT SELECT unnest(${names}::text[])))::int AS entity_hits,
                   cardinality(ARRAY(SELECT unnest(v.names) INTERSECT SELECT unnest(${linked}::text[])))::int AS linked_hits,
                   n.evidence_count
            FROM memory_chunks c
            JOIN memory_notes n ON n.id = c.note_id
            ${versionJoin(params, input)}
            WHERE c.version_id = v.id AND n.space_id = ANY(${spaceIds}::uuid[]) AND c.embedding IS NOT NULL
              AND ${inUse(params, input)} ${kindFilter(params, input.kinds)} ${labelFilter(params, input.labels)}
              ${input.excludeKinds?.length ? `AND NOT (n.kind = ANY(${params.add(input.excludeKinds)}::text[]))` : ''}
            ORDER BY c.embedding <=> ${e}::vector
            LIMIT ${CANDIDATES}
         ), scored AS (
            SELECT *, ((1 - distance) + 0.15 * LEAST(entity_hits, 3) + 0.08 * LEAST(linked_hits, 2) + LEAST(keyword_rank, 0.2) + 0.03 * LEAST(evidence_count - 1, 5))::float8 AS score
            FROM candidates
         ), best AS (
            SELECT DISTINCT ON (note_id) * FROM scored ORDER BY note_id, score DESC
         )
         SELECT ${NOTE_COLUMNS}, b.excerpt, b.ordinal, b.distance, b.score
         FROM best b
         JOIN memory_notes n ON n.id = b.note_id
         JOIN memory_spaces s ON s.id = n.space_id
         JOIN memory_note_versions v ON v.id = b.version_id
         WHERE b.distance <= ${maxDistance}
            OR ((b.entity_hits > 0 OR b.linked_hits > 0 OR b.keyword_rank > 0) AND b.distance <= ${maxDistance} + ${MATCH_DISTANCE_MARGIN})
         ORDER BY b.score DESC
         LIMIT ${params.add(clamp(input.topK ?? DEFAULT_TOP_K, 1, MAX_TOP_K))}`,
        params.values,
    );
    return rows.map(({ excerpt, ordinal, distance, score, ...note }) => ({ note, excerpt, ordinal, distance, score }));
}

// Every rule in use in some spaces, with its body, newest first.
export async function listRules(spaces: SpaceRow[], options: Moment & { labels?: string[] | null } = {}): Promise<NoteRow[]> {
    if (!spaces.length) return [];
    const params = new Params();
    return query<NoteRow>(
        `SELECT ${NOTE_COLUMNS}, v.body FROM memory_notes n JOIN memory_spaces s ON s.id = n.space_id ${versionJoin(params, options)}
         WHERE n.space_id = ANY(${params.add(spaces.map((space) => space.id))}::uuid[]) AND n.kind = '${NOTE_KINDS.RULE}' AND ${inUse(params, options)} ${labelFilter(params, options.labels)}
         ORDER BY n.updated_at DESC LIMIT ${MAX_RULES}`,
        params.values,
    );
}

// One rule per slot: the spaces come in order of precedence (the first granted or requested wins), so the user's
// own "casual" beats the team's "formal".
export const mostSpecificRules = (rules: NoteRow[], spaces: SpaceRow[]): NoteRow[] => {
    const rank = (note: NoteRow): number => {
        const index = spaces.findIndex((space) => space.id === note.space_id);
        return index === -1 ? spaces.length : index;
    };
    const bySlot = new Map<string, NoteRow>();
    const unslotted: NoteRow[] = [];
    for (const rule of rules) {
        if (!rule.slot) unslotted.push(rule);
        else if (!bySlot.has(rule.slot) || rank(rule) < rank(bySlot.get(rule.slot) as NoteRow)) bySlot.set(rule.slot, rule);
    }
    return [...bySlot.values(), ...unslotted].sort((a, b) => rank(a) - rank(b));
};

export interface RecallInput extends Moment {
    spaces: SpaceRow[];
    // Who is asking, so the prompt can say which notes they wrote themselves and which others did.
    caller?: string;
    query: string;
    kinds?: string[] | null;
    labels?: string[] | null;
    topK?: number;
    maxDistance?: number;
    // False leaves out the rules, lessons, connections and the prompt block: a plain search.
    withPrompt?: boolean;
}

export interface Recall {
    prompt: string | null;
    rules: NoteRow[];
    hits: SearchHit[];
    lessons: SearchHit[];
    connections: Connection[];
}

/**
 * What an assistant should have before it answers: every rule, the notes related to the query, the links of the
 * things it names, and the lessons from feedback, as results and as a ready prompt block. The query is embedded
 * once; when it names things the graph knows, notes about what they link to count a little too.
 */
export async function recall(input: RecallInput): Promise<Recall> {
    const withPrompt = input.withPrompt !== false;
    if (!input.spaces.length) return { prompt: null, rules: [], hits: [], lessons: [], connections: [] };
    const [[embedding], named] = await Promise.all([embedder.embed([input.query], 'query'), matchEntities(input.spaces, queryTerms(input.query).names)]);
    const [linked, links] = named.length
        ? await Promise.all([neighbours(input.spaces, named, undefined, input), linksOf(input.spaces, named.slice(0, CONNECTED_NAMES), CONNECTION_LINKS, input)])
        : [[], []];
    const searchKinds = input.kinds?.length ? input.kinds : null;
    const [allRules, hits, lessons] = await Promise.all([
        withPrompt ? listRules(input.spaces, input) : Promise.resolve([]),
        searchNotes({
            ...input,
            embedding,
            linked: linked.map((item) => item.name),
            kinds: searchKinds,
            // With the prompt, rules are all listed and lessons searched on their own, so neither repeats in the hits.
            excludeKinds: withPrompt && !searchKinds ? [NOTE_KINDS.RULE, NOTE_KINDS.LESSON] : null,
        }),
        withPrompt ? searchNotes({ ...input, embedding, kinds: [NOTE_KINDS.LESSON], topK: RELEVANT_LESSONS, maxDistance: LESSON_MAX_DISTANCE, labels: null }) : Promise.resolve([]),
    ]);
    const rules = mostSpecificRules(allRules, input.spaces);
    const connections = withPrompt ? groupConnections(named, links) : [];
    return { prompt: withPrompt ? renderPrompt({ rules, hits, lessons, connections, caller: input.caller }) : null, rules, hits, lessons, connections };
}
