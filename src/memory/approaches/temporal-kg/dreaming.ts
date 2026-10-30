import { aliasKey } from '../../core/entities';

// Dreaming settings. Steps: merge (one thing under two names), retire (facts newer ones made untrue), aliases
// (other names people use, so lookups match casual wording), profiles (a short state of each entity, so vague
// questions find it). The live server runs aliases and profiles nightly; evals and the Lab run them all.
export const DREAMING = {
    steps: new Set((process.env.MEMORY_DREAM_STEPS || 'merge,retire,aliases,profiles').split(',').map((s) => s.trim()).filter(Boolean)),
    // Lookups also reach entities whose profile is this close to the question (cosine).
    profileMin: Number(process.env.MEMORY_PROFILE_MIN) || 0.55,
    profileRecall: process.env.MEMORY_PROFILE_RECALL !== 'false',
};

// Words that never become an alias on their own.
const NOT_NAMES = new Set([
    'it', 'this', 'that', 'these', 'those', 'he', 'she', 'they', 'him', 'her', 'them', 'we', 'us', 'i', 'me', 'you',
    'project', 'team', 'client', 'service', 'app', 'thing', 'task', 'work', 'product', 'feature', 'deal', 'company',
]);

// The aliases an LLM suggested that may be kept: written in the messages, not a pronoun or a bare generic word,
// not one of the entity's names already, and not a name of another entity. Returned as alias keys.
export function acceptAliases(candidates: string[], ctx: { existing: string[]; messages: string[]; taken: Set<string> }): string[] {
    const text = ` ${ctx.messages.join(' ').toLowerCase().replace(/[^a-z0-9@.$]+/g, ' ')} `;
    const existing = new Set(ctx.existing.map(aliasKey));
    const kept = new Set<string>();
    for (const candidate of candidates) {
        const key = aliasKey(candidate);
        if (key.length < 2 || key.length > 40 || NOT_NAMES.has(key)) continue;
        if (existing.has(key) || ctx.taken.has(key) || kept.has(key)) continue;
        if (!text.includes(` ${key} `)) continue;
        kept.add(key);
    }
    return [...kept];
}
