import { aliasKey, findPerson } from '../../core/entities';
import { CandidateMode, describeDecisions, excludeSiblings, findCandidates, matchEntity } from '../../core/entity-match';
import { PersonRef } from '../../core/types';
import { ClaimStore } from './store';
import { ValueType } from './vocabulary';

// Entity resolution: "Ankit", "AK" and "ankit@acme.io" must become the same subject, and
// "Phoenix", "the Phoenix app" and "Phoenix project" the same project.

const slug = (name: string) => aliasKey(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unnamed';

export interface ResolvedEntity {
    id: string;
    name: string;
    // Set when Jev matched a new name to this existing entity.
    matchedFrom?: { mention: string; probability: number };
    // Near-miss candidates Jev rejected (for diagnosis).
    matchNotes?: string[];
}

// Jev entity matching for names without an exact alias: candidates come from the given scopes,
// minus the other names this same message uses (and the entities they resolved to).
export interface EntityMatching {
    scopes: string[];
    evidence: string;
    mode: CandidateMode;
    siblingKeys: Set<string>;
    siblingIds: Set<string>;
    // Show Jev each candidate's known facts (Zep-style entity summaries).
    summaries?: boolean;
}

export async function resolveEntity(
    store: ClaimStore,
    mention: string,
    kind: string,
    directory: PersonRef[],
    actor: PersonRef,
    create: boolean,
    matching: EntityMatching | null = null
): Promise<ResolvedEntity | null> {
    const person = findPerson(mention, directory, actor);
    if (person) return { id: `person:${person.id}`, name: person.name };
    const key = aliasKey(mention);
    const known = await store.findEntity(key);
    if (known) return known;
    if (!create) return null;
    let matchNotes: string[] = [];
    if (matching) {
        const candidates = excludeSiblings(
            await findCandidates(mention, kind, await store.listEntities(matching.scopes), matching.mode),
            matching.siblingKeys,
            matching.siblingIds
        );
        if (matching.summaries) {
            for (const c of candidates) c.summary = await store.entitySummary(c.id, matching.scopes);
        }
        const result = await matchEntity(mention, kind, matching.evidence, candidates);
        matchNotes = describeDecisions(mention, result);
        if (result.match) {
            // Remember the new name as an alias, so later mentions resolve without asking again.
            await store.addAlias(key, result.match.id);
            return { id: result.match.id, name: result.match.name, matchedFrom: { mention, probability: result.probability }, matchNotes };
        }
    }
    const id = `${kind === 'person' ? 'other' : kind}:${slug(mention)}`;
    const name = mention.trim();
    await store.upsertEntity(id, kind, name, [key]);
    return { ...((await store.findEntity(key)) ?? { id, name }), matchNotes };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export interface NormalizedValue {
    value: string;
    norm: string;
    // Human-readable rendering used in claim text.
    display: string;
}

export function normalizeValue(raw: string, type: ValueType): NormalizedValue {
    const value = raw.trim();
    if (type === 'date') {
        const iso = toIsoDate(value);
        if (iso) {
            const [y, m, d] = iso.split('-').map(Number);
            return { value: iso, norm: iso, display: `${iso} (${MONTHS[m - 1]} ${d}, ${y})` };
        }
    }
    if (type === 'number') {
        const digits = value.replace(/[^0-9.]/g, '');
        if (digits) return { value: digits, norm: digits, display: digits };
    }
    if (type === 'money') {
        const digits = value.replace(/[^0-9.]/g, '');
        if (digits) return { value, norm: digits, display: value };
    }
    return { value, norm: value.toLowerCase().replace(/\s+/g, ' '), display: value };
}

// Calendar dates are timezone-free: parse in UTC so "November 5, 2026" never becomes Nov 4 on a machine
// east of UTC. Values without a year ("Nov 5") stay text rather than gaining a guessed year.
function toIsoDate(value: string): string | null {
    const isoPrefix = value.match(/^(\d{4}-\d{2}-\d{2})(T|\s|$)/);
    if (isoPrefix) return isoPrefix[1];
    if (!/\b\d{4}\b/.test(value)) return null;
    const parsed = Date.parse(`${value} UTC`);
    if (Number.isNaN(parsed)) return null;
    return new Date(parsed).toISOString().slice(0, 10);
}
