/**
 * The memory file system: a tenant (whoever signed the token, and their org and project) owns spaces (folders);
 * a space holds notes (files) at paths; every write of a note is a new version; every version is indexed by meaning
 * (chunks with embeddings), by words (a tsvector) and by the names and links in it (the graph).
 */
// read: see the space. append: add notes and change your own. write: also replace or delete what others wrote.
export type Access = 'read' | 'append' | 'write';

export interface Tenant {
    issuer: string;
    orgId: string;
    projectId: string;
}

export const ENTITY_TYPES = ['person', 'organisation', 'product', 'app', 'channel', 'place', 'topic', 'other'] as const;
export type EntityType = typeof ENTITY_TYPES[number];

export interface TypedEntity {
    name: string;
    type: EntityType;
}

// A link a note states between two named things: "acme" "uses" "hubspot". The object may be a short value rather
// than a named thing ("business plan").
export interface Relation {
    subject: string;
    relation: string;
    object: string;
}

export interface Links {
    entities: TypedEntity[];
    relations: Relation[];
}

// Kinds with a meaning of their own; a product may use any other short word for its own kinds.
export const NOTE_KINDS = {
    NOTE: 'note',
    RULE: 'rule',
    FACT: 'fact',
    LESSON: 'lesson',
    DOC: 'doc',
} as const;

export type NoteStatus = 'active' | 'archived';

// Where a note came from: a thread, a message, a document, a ticket. Deleting a source deletes what came from it.
export interface Source {
    type: string;
    id: string;
}

export interface SpaceRow {
    id: string;
    name: string;
}

export interface NoteRow {
    id: string;
    space_id: string;
    space: string;
    path: string;
    kind: string;
    slot: string | null;
    labels: string[];
    current_version_id: string | null;
    status: NoteStatus;
    valid_from: Date;
    valid_to: Date | null;
    source: Source | null;
    written_by: string;
    confidence: number | null;
    evidence_count: number;
    created_at: Date;
    updated_at: Date;
    version: number;
    version_id: string;
    title: string | null;
    summary: string | null;
    version_written_by: string;
    change: string;
    version_created_at: Date;
    body?: string;
}

export interface VersionRow {
    id: string;
    version: number;
    title: string | null;
    summary: string | null;
    body: string;
    written_by: string;
    change: string;
    created_at: Date;
}

export interface DocumentRow {
    id: string;
    note_id: string;
    url: string | null;
    filename: string | null;
    mime: string | null;
    bytes: number | null;
    status: string;
    error: string | null;
    extracted_at: Date | null;
}

export interface SearchHit {
    note: NoteRow;
    excerpt: string;
    ordinal: number;
    // Cosine distance: 0 is identical, 2 is opposite.
    distance: number;
    score: number;
}

export interface EntityLink {
    subject: string;
    relation: string;
    object: string;
    space: string;
    path: string;
    asOf: Date;
    until: Date | null;
}

export interface EntityNode {
    name: string;
    type: EntityType | null;
    notes: NoteRow[];
    links: EntityLink[];
    connected: { name: string; links: number }[];
}

export interface EntitySummary {
    name: string;
    type: EntityType;
    notes: number;
}

// What the extractor is shown of saved memory, numbered so it can point at one.
export interface KnownMemory {
    ref: number;
    kind: string;
    slot: string | null;
    text: string;
    evidenceCount?: number;
    shared?: boolean;
    // Who created it, and whether that is the current speaker.
    writtenBy?: string | null;
    mine?: boolean;
    // Someone else wrote it in a space the caller may only append to: it is added beside, never changed. With write,
    // nothing is locked: the grant, not the extractor, decides who may change what.
    locked?: boolean;
}

export type ExtractionAction = 'add' | 'update' | 'forget';

export interface ExtractedOperation {
    action: ExtractionAction;
    ref: number | null;
    kind: 'rule' | 'fact';
    slot: string | null;
    text: string;
    entities: TypedEntity[];
    relations: Relation[];
    // True when it is about the group rather than the person, so it belongs in the shared space.
    shared: boolean;
    expiresOn: string | null;
    confidence: number;
}

// The subject of a space. A person is the user speaking; a name lets shared memories say who. A thing (an article,
// a product, an account) never speaks, so no rules are learned about it and every memory names it.
export interface ExtractionSubject {
    kind: 'person' | 'thing';
    name: string | null;
}

export interface ExtractionContext {
    sharedSpace: string | null;
    // True when the product says everything learned goes to the shared space, instead of the extractor sorting it.
    shareAll?: boolean;
    today: string;
    // False when nobody in the text is the user, such as a customer's ticket: then only facts may be learned.
    rulesAllowed: boolean;
    knownEntities: TypedEntity[];
    // What the space is about: the person speaking (the default, optionally named), or a thing the product names.
    subject?: ExtractionSubject | null;
    // What the product says is worth keeping ("only save billing and order information"): it narrows or extends
    // relevance, never the guardrails (the never-save list, who may set rules).
    instructions?: string | null;
}

export type ReconcileDecision = 'new' | 'replaces' | 'duplicate';

export type FeedbackOutcome = 'good' | 'bad' | 'corrected';

export interface FeedbackInput {
    task: string;
    output: string;
    outcome: FeedbackOutcome;
    correction?: string;
    note?: string;
}

export type LessonAction = 'add' | 'reinforce' | 'revise';

export interface LessonOperation {
    action: LessonAction;
    ref: number | null;
    text: string;
    confidence: number;
}

export interface Models {
    readonly model: string;
    extract(text: string, known: KnownMemory[], context: ExtractionContext): Promise<ExtractedOperation[]>;
    link(text: string, knownEntities: TypedEntity[]): Promise<Links>;
    reconcile(text: string, known: KnownMemory[]): Promise<{ decision: ReconcileDecision; ref: number | null }>;
    distillLesson(feedback: FeedbackInput, known: KnownMemory[]): Promise<LessonOperation[]>;
    summarize(title: string | null, body: string): Promise<string>;
}

export interface Embedder {
    readonly model: string;
    readonly dimensions: number;
    // Queries and documents are embedded differently by some models (EmbeddingGemma), so the caller says which it has.
    embed(texts: string[], kind: 'query' | 'document'): Promise<number[][]>;
}
