import { ENTITY_TYPES, EntityType, Relation, TypedEntity } from './types';

/**
 * How names, labels, slots and query words are normalised, so the same thing is spelled the same way in every
 * index: "Acme Inc." and "acme inc" are one node, "Billing " and "billing" one label.
 */
const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'these', 'those', 'from', 'have', 'has', 'had', 'are', 'was', 'were', 'will',
    'would', 'should', 'could', 'can', 'also', 'about', 'into', 'onto', 'your', 'yours', 'our', 'ours', 'their', 'them', 'they',
    'you', 'what', 'which', 'when', 'where', 'who', 'whom', 'how', 'why', 'please', 'just', 'more', 'most', 'some', 'any', 'all',
    'not', 'but', 'its', 'than', 'then', 'there', 'here', 'been', 'being', 'does', 'did', 'done', 'get', 'got', 'set', 'put',
    'let', 'very', 'much', 'many', 'each', 'other', 'only', 'same', 'such', 'own', 'over', 'under', 'again', 'once', 'now',
    'use', 'used', 'using', 'send', 'make', 'need', 'want', 'tell', 'give', 'show', 'help', 'like', 'know', 'think', 'every',
    'always', 'never', 'today', 'tomorrow', 'yesterday', 'thanks', 'thank', 'okay', 'yes', 'yeah', 'sure', 'hey', 'hello', 'hi',
]);

export const MAX_ENTITY_NAME_LENGTH = 64;
export const MAX_RELATION_LENGTH = 64;
export const MAX_RELATION_OBJECT_LENGTH = 200;
export const MAX_RELATIONS_PER_NOTE = 30;
export const MAX_ENTITIES_PER_NOTE = 40;
export const MAX_LABELS = 10;
export const MAX_LABEL_LENGTH = 64;
export const MAX_SLOT_LENGTH = 64;
// In a note's links the person whose memory it is goes by this name, whatever they are called.
export const USER_ENTITY = 'user';

// An email address, or a long number such as a phone, card or account number: never kept in memory.
export const PRIVATE_DETAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}|(?:\d[\s().-]?){10,}/i;

const normalize = (value: string): string => value.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[.,;:!?)"']+$/u, '');

export const normalizeEntityName = (value: string): string | null => {
    const name = normalize(value).replace(/^["'(]+/u, '');
    return name.length >= 2 && name.length <= MAX_ENTITY_NAME_LENGTH && !STOPWORDS.has(name) ? name : null;
};

const ENTITY_TYPE_VALUES = new Set<string>(ENTITY_TYPES);
export const toEntityType = (type: unknown): EntityType => (typeof type === 'string' && ENTITY_TYPE_VALUES.has(type) ? type as EntityType : 'other');

// Typed names, one per name; the first type given for a name wins, except that a real type beats "other".
export const normalizeTypedEntities = (values: Array<{ name: string; type?: unknown }>): TypedEntity[] => {
    const byName = new Map<string, EntityType>();
    for (const value of values) {
        const name = normalizeEntityName(value.name ?? '');
        if (!name) continue;
        const type = toEntityType(value.type);
        const current = byName.get(name);
        if (current === undefined || (current === 'other' && type !== 'other')) byName.set(name, type);
    }
    return [...byName.entries()].slice(0, MAX_ENTITIES_PER_NOTE).map(([name, type]) => ({ name, type }));
};

// A relation is a short snake_case verb phrase such as "works_at" or "uses"; both ends are node names, the object
// may also be a short value ("business plan"). A link from a thing to itself says nothing.
export const normalizeRelations = (values: Array<Partial<Relation>>): Relation[] => {
    const seen = new Set<string>();
    const relations: Relation[] = [];
    for (const value of values) {
        const subject = normalizeEntityName(value.subject ?? '');
        const object = normalize(value.object ?? '').slice(0, MAX_RELATION_OBJECT_LENGTH);
        const relation = (value.relation ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, MAX_RELATION_LENGTH);
        if (!subject || !object || !relation || subject === object) continue;
        const key = `${subject}|${relation}|${object}`;
        if (seen.has(key)) continue;
        seen.add(key);
        relations.push({ subject, relation, object });
        if (relations.length >= MAX_RELATIONS_PER_NOTE) break;
    }
    return relations;
};

// A slot is a short key such as "tone" or "no_customer_emails"; the same idea must always map to the same key.
export const normalizeSlot = (slot?: string | null): string | null => {
    const normalized = slot?.toLowerCase().replace(/[^a-z0-9_:]+/g, '_').replace(/^_+|_+$/g, '').slice(0, MAX_SLOT_LENGTH);
    return normalized || null;
};

export const normalizeLabels = (labels?: unknown): string[] => {
    const list = Array.isArray(labels) ? labels : (typeof labels === 'string' ? [labels] : []);
    return [...new Set(list
        .filter((label): label is string => typeof label === 'string')
        .map((label) => label.trim().toLowerCase())
        .filter((label) => label && label.length <= MAX_LABEL_LENGTH))].slice(0, MAX_LABELS);
};

export const normalizeNames = (values: string[]): string[] => [
    ...new Set(values.map(normalize).filter((value) => value.length >= 2 && value.length <= MAX_ENTITY_NAME_LENGTH && !STOPWORDS.has(value))),
].slice(0, MAX_ENTITIES_PER_NOTE);

// Email addresses are skipped on purpose everywhere below: they are personal data, not names.
const withoutEmails = (text: string): string => text.replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu, ' ');

// Names that are names by their shape, worth a node even when no model listed them: #channels, @handles, domains.
export const extractNamedEntities = (text: string): TypedEntity[] => {
    const clean = withoutEmails(text);
    const found: TypedEntity[] = [];
    clean.match(/#[\p{L}\p{N}_-]+/gu)?.forEach((tag) => found.push({ name: tag, type: 'channel' }));
    clean.match(/(?<![\p{L}\p{N}])@[\p{L}\p{N}_.-]+/gu)?.forEach((handle) => found.push({ name: handle, type: 'other' }));
    clean.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|io|ai|in|co|org|net|app|dev|so)\b/giu)?.forEach((domain) => found.push({ name: domain, type: 'other' }));
    return normalizeTypedEntities(found);
};

// Words worth matching exactly in a search: the names above plus capitalised words that do not just start a
// sentence. A capitalised word is a hint for matching, not a node of the graph.
export const extractNames = (text: string): string[] => {
    const clean = withoutEmails(text);
    const found: string[] = extractNamedEntities(text).map((entity) => entity.name);
    clean.match(/(?:^|[.!?]\s+|\s)([\p{Lu}][\p{L}\p{N}&-]*)/gu)?.forEach((match) => {
        const startsSentence = /^(?:[.!?]\s+)?$/u.test(match.slice(0, match.search(/[\p{Lu}]/u)));
        if (!startsSentence) found.push(match.trim());
    });
    return normalizeNames(found);
};

export interface QueryTerms {
    names: string[];
    keywordQuery: string | null;
}

// Turns a query into the words and names a stored chunk can match on, beside the meaning search.
export const queryTerms = (text: string): QueryTerms => {
    const words = (text.toLowerCase().match(/[#@]?[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? []).map((word) => word.replace(/[._-]+$/u, ''));
    const terms = [...new Set(words.filter((word) => word.replace(/^[#@]/u, '').length >= 3 && !STOPWORDS.has(word)))];
    const bigrams = words.slice(1).map((word, i) => `${words[i]} ${word}`).filter((pair) => !pair.split(' ').some((part) => STOPWORDS.has(part)));
    const keywords = [...new Set(terms.map((term) => term.replace(/[^\p{L}\p{N}_]/gu, '')).filter((term) => term.length >= 3))];
    return {
        names: normalizeNames([...terms, ...bigrams, ...extractNames(text)]),
        keywordQuery: keywords.length ? keywords.join(' | ') : null,
    };
};
