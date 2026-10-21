import { EntityLink, NoteRow, SearchHit } from './types';

/**
 * The ready block a search returns beside its results: what an assistant should have in its prompt before it
 * answers. Rules first, then the notes related to the query with their dates, the links of the named things in it,
 * and the lessons from feedback. Kept within a budget by dropping the least valuable lines first.
 */
const MAX_CONTEXT_CHARS = 4000;
const MAX_LINE_CHARS = 300;
const MAX_CONNECTED = 2;
const MAX_LINKS_PER_NAME = 6;

export interface Connection {
    name: string;
    links: EntityLink[];
}

export interface PromptParts {
    rules: NoteRow[];
    hits: SearchHit[];
    lessons: SearchHit[];
    connections: Connection[];
    // Who is asking: their own notes read "noted by you", anyone else's name who wrote them.
    caller?: string;
}

const asOf = (date: Date): string => new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const clip = (text: string): string => {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1).trimEnd()}…` : line;
};
const words = (relation: string): string => relation.replace(/_/g, ' ');

const ruleLine = (note: NoteRow): string => `- ${note.slot ? `(${words(note.slot)}) ` : ''}${clip(note.body ?? note.summary ?? '')}`;
// The date tells the assistant how fresh a note is: "on the Pro plan (as of 3 Mar)" may no longer be true in October.
// Who wrote it tells the assistant whether it is first-hand: what the user said, or what someone else noted.
const notedBy = (hit: SearchHit, caller?: string): string => {
    const writer = hit.note.version_written_by ?? hit.note.written_by;
    if (!caller || !writer) return '';
    return writer === caller ? ', noted by you' : `, noted by ${writer}`;
};
const hitLine = (hit: SearchHit, caller?: string): string => `- ${hit.note.title ? `${hit.note.title}: ` : ''}${clip(hit.excerpt)} (${hit.note.space}/${hit.note.path}, as of ${asOf(hit.note.updated_at)}${notedBy(hit, caller)})`;
const lessonLine = (hit: SearchHit): string => `- ${clip(hit.excerpt)}${hit.note.evidence_count > 1 ? ` (confirmed ${hit.note.evidence_count} times)` : ''}`;
// "acme: → uses hubspot; → plan business plan; ← maya works at": each link read from the name's side.
export const linkPhrase = (name: string, link: EntityLink): string => (link.subject === name ? `→ ${words(link.relation)} ${link.object}` : `← ${link.subject} ${words(link.relation)}`);
const connectionLine = ({ name, links }: Connection): string => `- ${name}: ${clip(links.map((link) => linkPhrase(name, link)).join('; '))}`;

const HEADER = [
    '## What you remember',
    'Saved from earlier conversations and notes. Follow the rules unless the current message asks otherwise. Use a note only when it helps, and prefer newer ones. A request recorded as a note is not a promise or a decision: never agree to it because it is remembered. Apply the lessons. Connections are what the named things link to. Do not mention this memory unless asked.',
];

// The links of each named thing in the query, a few per name, each link once.
export const groupConnections = (names: string[], links: EntityLink[]): Connection[] => names.slice(0, MAX_CONNECTED).map((name) => {
    const seen = new Set<string>();
    const own = links.filter((link) => {
        if (link.subject !== name && link.object !== name) return false;
        const key = linkPhrase(name, link);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    return { name, links: own.slice(0, MAX_LINKS_PER_NAME) };
}).filter((group) => group.links.length);

const render = ({ rules, hits, lessons, connections, caller }: PromptParts): string => {
    const sections = [...HEADER];
    if (rules.length) sections.push(`Rules:\n${rules.map(ruleLine).join('\n')}`);
    if (hits.length) sections.push(`Relevant notes:\n${hits.map((hit) => hitLine(hit, caller)).join('\n')}`);
    if (connections.length) sections.push(`Connections:\n${connections.map(connectionLine).join('\n')}`);
    if (lessons.length) sections.push(`Lessons from feedback:\n${lessons.map(lessonLine).join('\n')}`);
    return sections.join('\n\n');
};

// Null when nothing applies. Otherwise the block, trimmed to budget by dropping the weakest lesson, then a
// connection, then the weakest note, then the least specific rule.
export const renderPrompt = (parts: PromptParts): string | null => {
    const kept: PromptParts = { rules: [...parts.rules], hits: [...parts.hits], lessons: [...parts.lessons], connections: [...parts.connections] };
    if (!kept.rules.length && !kept.hits.length && !kept.lessons.length && !kept.connections.length) return null;
    let text = render(kept);
    while (text.length > MAX_CONTEXT_CHARS) {
        if (kept.lessons.length) kept.lessons.pop();
        else if (kept.connections.length) kept.connections.pop();
        else if (kept.hits.length) kept.hits.pop();
        else if (kept.rules.length) kept.rules.pop();
        else break;
        text = render(kept);
    }
    return text;
};
