import { PersonRef, RawMessage } from './types';

// Shared identity helpers: the same normalization for every approach, so "Ankit", "AK" and
// "ankit@acme.io" resolve identically, and "the Phoenix app" matches "Phoenix".

const GENERIC_SUFFIXES = /\s+(project|team|app|application)$/;

export function aliasKey(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9@.$]+/g, ' ')
        .replace(/\.(\s|$)/g, ' ')
        .replace(/^(the|our|my)\s+/, '')
        .trim()
        .replace(GENERIC_SUFFIXES, '')
        .trim();
}

// Normalizes free text (a question) the same way, for whole-word alias matching.
export function normalizeForAliases(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9@.$]+/g, ' ').replace(/\.(\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
}

export function findPerson(mention: string, directory: PersonRef[], actor: PersonRef): PersonRef | null {
    const key = aliasKey(mention);
    if (['i', 'me', 'my', 'myself', 'user', 'the user'].includes(key)) return actor;
    return directory.find((p) => [p.id, p.name, ...p.aliases].some((n) => aliasKey(n) === key)) ?? null;
}

// People named in a question with a typo ("Is Denial available?"): capitalized words of 4+ letters that are
// one edit from a name or alias, or the same letters in another order with the same first letter and length.
// Capitalized only, so ordinary words ("in denial") never match.
export function peopleMentionedFuzzily(text: string, directory: PersonRef[]): PersonRef[] {
    const words = (text.match(/\b[A-Z][a-zA-Z]{3,}\b/g) ?? []).map((w) => w.toLowerCase());
    const sorted = (w: string) => [...w].sort().join('');
    const close = (a: string, b: string) =>
        a !== b && b.length >= 4 && ((a[0] === b[0] && a.length === b.length && sorted(a) === sorted(b)) || editDistance(a, b) <= 1);
    return directory.filter((p) => {
        const names = [...p.name.split(/\s+/), ...p.aliases].map((n) => n.toLowerCase()).filter((n) => /^[a-z]+$/.test(n));
        return words.some((w) => names.some((n) => close(w, n)));
    });
}

function editDistance(a: string, b: string): number {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
    }
    return d[a.length][b.length];
}

export function actorOf(personId: string, fallbackName: string, directory: PersonRef[]): PersonRef {
    return directory.find((p) => p.id === personId) ?? { id: personId, name: fallbackName, aliases: [] };
}

// Guard against hallucinated extraction: an extracted fact's evidence must occur in the new turns.
export function evidenceFound(evidence: string, msg: RawMessage): boolean {
    const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9$]+/g, ' ').trim();
    const needle = squash(evidence);
    return needle.length > 0 && squash(msg.turns.map((t) => t.content).join(' ')).includes(needle);
}
