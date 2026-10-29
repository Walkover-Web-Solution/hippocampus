import { cosine, getEmbedder } from './embed';
import { aliasKey, normalizeForAliases } from './entities';
import { decide, noul } from './jev';

// Entity matching with Jev: when a new name ("Phoenix") has no exact alias, decide whether it is an
// existing entity under another name ("Phoenix picker app"). Without this, the two become separate
// subjects and an update to one never supersedes the other.

export interface EntityCandidate {
    id: string;
    name: string;
    kind: string;
    // A few known facts about it (Zep-style entity summary), shown to Jev when matching.
    summary?: string;
}

// Words too generic to make two names candidates for each other.
const GENERIC = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'to', 'in', 'on', 'team', 'project', 'app', 'application',
    'service', 'module', 'system', 'client', 'company', 'inc', 'ltd']);

// Existing entities sharing a meaningful word with the mention, most overlap first.
export function matchCandidates(mention: string, entities: EntityCandidate[], max = 8): EntityCandidate[] {
    const key = aliasKey(mention);
    const tokens = new Set(key.split(' ').filter((t) => t.length > 1 && !GENERIC.has(t)));
    return entities
        .filter((e) => aliasKey(e.name) !== key)
        .map((e) => ({ e, overlap: aliasKey(e.name).split(' ').filter((t) => tokens.has(t)).length }))
        .filter((x) => x.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap)
        .slice(0, max)
        .map((x) => x.e);
}

// Optimal string alignment distance (Levenshtein plus adjacent transpositions).
function osaDistance(a: string, b: string): number {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
    }
    return d[a.length][b.length];
}

// Typo ("pheonix"/"phoenix") or abbreviation-as-prefix ("auth"/"authentication"); short words never match.
function tokensSimilar(a: string, b: string): boolean {
    if (a.length < 4 || b.length < 4 || GENERIC.has(a) || GENERIC.has(b)) return false;
    if (a.startsWith(b) || b.startsWith(a)) return true;
    return 1 - osaDistance(a, b) / Math.max(a.length, b.length) >= 0.75;
}

export function fuzzyCandidates(mention: string, entities: EntityCandidate[], max = 8): EntityCandidate[] {
    const key = aliasKey(mention);
    const tokens = key.split(' ');
    return entities
        .filter((e) => aliasKey(e.name) !== key && aliasKey(e.name).split(' ').some((u) => tokens.some((t) => tokensSimilar(t, u))))
        .slice(0, max);
}

// Nearest existing names by embedding of "name (kind)": synonyms and abbreviations that share no
// letters with the mention ("authentication service" for "auth-service").
export async function vectorCandidates(mention: string, kind: string, entities: EntityCandidate[], max = 5, minSimilarity = 0.6): Promise<EntityCandidate[]> {
    if (entities.length === 0) return [];
    const texts = [`${mention} (${kind})`, ...entities.map((e) => `${e.name} (${e.kind})`)];
    const [query, ...vectors] = await getEmbedder().embed(texts);
    return entities
        .map((e, i) => ({ e, score: cosine(query, vectors[i]) }))
        .filter((x) => x.score >= minSimilarity && aliasKey(x.e.name) !== aliasKey(mention))
        .sort((a, b) => b.score - a.score)
        .slice(0, max)
        .map((x) => x.e);
}

export type CandidateMode = 'lexical' | 'vector';

// lexical: shared words only. vector: shared words + typos/prefixes + embedding neighbours.
// Jev decides either way; more candidates only means more chances to find the right one.
export async function findCandidates(mention: string, kind: string, entities: EntityCandidate[], mode: CandidateMode, max = 8): Promise<EntityCandidate[]> {
    const pools = [matchCandidates(mention, entities, max)];
    if (mode === 'vector') {
        pools.push(fuzzyCandidates(mention, entities, max), await vectorCandidates(mention, kind, entities));
    }
    const seen = new Set<string>();
    return pools
        .flat()
        .filter((e) => !seen.has(e.id) && seen.add(e.id))
        .filter((e) => !partWholeBlocked(mention, kind, e))
        .slice(0, max);
}

// Probability of "same thing" needed to merge; below it a new entity is created (a missed merge is
// recoverable, a wrong merge corrupts two entities' facts).
export const MATCH_THRESHOLD = 0.7;

export interface MatchResult {
    match: EntityCandidate | null;
    probability: number;
    // Jev's per-candidate answers, for logging near misses.
    decisions: CandidateDecision[];
}

// Veto: if Jev thinks one is a part of / related to the other at this probability, never merge. Jev
// answers this ambiguously for true aliases (a project and "its" app: ~0.5–0.75) but high for real
// part/related pairs (~0.8–0.9), so only a strong answer vetoes; "same" must also outweigh "related".
export const RELATED_VETO = 0.8;

export interface CandidateDecision {
    candidate: EntityCandidate;
    same: number;
    related: number;
}

const SAME = noul(
    'Do "mention" and "candidate" refer to the same real-world thing?',
    'Yes: the same person, team, organisation, project, product, service or deliverable, only named differently (shorter or longer name, nickname, typo, abbreviation or initials, with or without a legal suffix, product name versus project name).',
    'No: two different things, even if their names share words.'
);
const RELATED = noul(
    'Is one of them a part, phase, milestone, document, contract or agreement, sub-team, member, API or SDK, program or other component of the other — or otherwise a different but related thing?',
    'Yes: related but not the same thing (for example a company and the contract with it, a project and one of its milestones or documents, a team and a sub-team, a service and its API).',
    'No: neither is a part of, or a separate thing related to, the other.'
);

// One Jev call per candidate (so a candidate's score doesn't depend on which others were listed), with a
// part/related veto. The best candidate wins if it is confidently the same thing and not vetoed.
export async function matchEntity(mention: string, kind: string, evidence: string, candidates: EntityCandidate[]): Promise<MatchResult> {
    if (candidates.length === 0) return { match: null, probability: 0, decisions: [] };
    const decisions: CandidateDecision[] = await Promise.all(candidates.map(async (candidate) => {
        const label = `${candidate.name} (${candidate.kind})${candidate.summary ? ` — known facts: ${candidate.summary}` : ''}`;
        const answers = await decide(
            { mention, mention_kind: kind, said_in: evidence, candidate: label },
            { same: SAME, related: RELATED }
        );
        return { candidate, same: answers.same.noul, related: answers.related.noul };
    }));
    const best = decisions
        .filter((d) => d.same >= MATCH_THRESHOLD && d.related < RELATED_VETO && d.same > d.related)
        .sort((a, b) => b.same - a.same)[0];
    const probability = best?.same ?? Math.max(...decisions.map((d) => d.same));
    return { match: best?.candidate ?? null, probability, decisions };
}

// Entity linking by description: "the WebRTC product" names no entity, but may describe one (a product known
// to be a WebRTC service). SAME/RELATED are made for names (where a part or contract is the trap); this asks
// whether the description, read in the whole message, refers to the candidate. It links only when exactly
// one candidate clears the bar.
const REFERS = noul(
    'In said_in, does mention refer to candidate itself, describing it by what kind of thing it is instead of by its name, given the candidate\'s known facts?',
    'Yes: mention is another way of naming the candidate (e.g. "the WebRTC product" for a product known to be a WebRTC service).',
    'No: mention is a different thing, or a part, phase, feature, document, contract or customer of the candidate, or there is not enough to tell.'
);
export const REFERS_THRESHOLD = 0.7;

export async function matchDescription(mention: string, message: string, candidates: EntityCandidate[]): Promise<MatchResult> {
    if (candidates.length === 0) return { match: null, probability: 0, decisions: [] };
    const decisions: CandidateDecision[] = await Promise.all(candidates.map(async (candidate) => {
        const label = `${candidate.name} (${candidate.kind})${candidate.summary ? ` — known facts: ${candidate.summary}` : ''}`;
        const { refers } = await decide({ mention, said_in: message, candidate: label }, { refers: REFERS });
        return { candidate, same: refers.noul, related: 0 };
    }));
    const passing = decisions.filter((d) => d.same >= REFERS_THRESHOLD);
    return { match: passing.length === 1 ? passing[0].candidate : null, probability: Math.max(...decisions.map((d) => d.same)), decisions };
}

// Words that only label what kind of thing a name is: "Phoenix picker app" is still Phoenix.
const DESIGNATORS = new Set(['app', 'application', 'project', 'service', 'platform', 'system', 'tool', 'program', 'programme',
    'initiative', 'product', 'team', 'inc', 'ltd', 'llc', 'corp', 'corporation', 'co', 'gmbh', 'plc', 'group']);
// Kinds whose names are commonly extended without becoming a different thing ("Acme" / "Acme Logistics").
const NAME_EXTENDING_KINDS = new Set(['client', 'team', 'person']);

const nameWords = (name: string) => normalizeForAliases(name).split(' ').filter(Boolean);

// Part/whole guard. When one name is the other plus extra words ("Phoenix" vs "Phoenix release notes",
// a company vs "<company> agreement"), they are usually a thing and its part, document or contract.
// Allow such a pair only if the longer name ends in a designator or both end in the same word, or both
// are organisations/teams/people of the same kind. Names that aren't sub-phrases of each other are
// left to Jev.
export function partWholeBlocked(mention: string, mentionKind: string, candidate: EntityCandidate): boolean {
    const a = nameWords(mention);
    const b = nameWords(candidate.name);
    if (a.length === b.length) return false;
    const [short, long] = a.length < b.length ? [a, b] : [b, a];
    if (!short.every((w) => long.includes(w))) return false;
    const lastLong = long[long.length - 1];
    if (DESIGNATORS.has(lastLong) || lastLong === short[short.length - 1]) return false;
    if (mentionKind === candidate.kind && NAME_EXTENDING_KINDS.has(candidate.kind)) return false;
    return true;
}

// Same-message guard: names the same message uses as separate subjects are different things, so they
// (and the entities they already resolved to) can't be merge targets for each other.
export function excludeSiblings(candidates: EntityCandidate[], siblingKeys: Set<string>, siblingIds: Set<string>): EntityCandidate[] {
    return candidates.filter((c) => !siblingIds.has(c.id) && !siblingKeys.has(aliasKey(c.name)));
}

export function describeDecisions(mention: string, result: MatchResult): string[] {
    return result.decisions
        .filter((d) => d.candidate !== result.match && d.same >= 0.5)
        .map((d) => `match rejected: "${mention}" ≠ ${d.candidate.name} (same ${d.same.toFixed(2)}, related ${d.related.toFixed(2)})`);
}
