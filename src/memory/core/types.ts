import { z } from 'zod';

// A scope is the memory space a memory lives in: one person's private memory or one team's shared memory.
export const ScopeSchema = z.string().regex(/^(personal|team):.+$/);
export type Scope = z.infer<typeof ScopeSchema>;

export const personalScope = (personId: string): Scope => `personal:${personId}`;
export const teamScope = (teamId: string): Scope => `team:${teamId}`;

export const MessageKindSchema = z.enum(['user', 'agent']);
export type MessageKind = z.infer<typeof MessageKindSchema>;

// A chat turn, or a note an agent wrote with a `remember`-style tool.
export const TurnSchema = z.object({
    role: z.enum(['user', 'assistant', 'note']),
    content: z.string(),
});
export type Turn = z.infer<typeof TurnSchema>;

// What an app/agent sent us: one exchange (user turn + assistant reply) or one agent note.
// `user` = the person said it; `agent` = the agent inferred it.
export const RawMessageSchema = z.object({
    id: z.string(),
    kind: MessageKindSchema,
    actorPersonId: z.string(),
    actorName: z.string(),
    actorAgent: z.string(),
    activeTeamId: z.string().nullable(),
    activeTeamName: z.string().nullable(),
    sessionId: z.string().nullable(),
    // The new content to remember.
    turns: z.array(TurnSchema).min(1),
    // Earlier turns of the same chat session, for resolving references; not new information.
    context: z.array(TurnSchema),
    occurredAt: z.string().datetime(),
});
export type RawMessage = z.infer<typeof RawMessageSchema>;

export const MemoryStatusSchema = z.enum(['current', 'superseded', 'proposed', 'disputed']);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const RecalledMemorySchema = z.object({
    text: z.string(),
    scope: ScopeSchema,
    status: MemoryStatusSchema,
    validFrom: z.string().nullable(),
    validTo: z.string().nullable(),
    sourceMessageIds: z.array(z.string()),
    score: z.number().nullable(),
    // Who stated it (person name), when the approach keeps provenance.
    author: z.string().nullable().optional(),
});
export type RecalledMemory = z.infer<typeof RecalledMemorySchema>;

export const RecallQuerySchema = z.object({
    asPersonId: z.string(),
    activeTeamId: z.string().nullable(),
    query: z.string(),
    now: z.string().datetime(),
    asOf: z.string().datetime().nullable(),
    includeProposed: z.boolean(),
    topK: z.number().int().positive(),
});
export type RecallQuery = z.infer<typeof RecallQuerySchema>;

export interface PersonRef {
    id: string;
    name: string;
    aliases: string[];
}

export interface IngestContext {
    // Computed by the harness from memberships; approaches never decide access themselves.
    writableScopes: Scope[];
    defaultScope: Scope;
    // The actor's role in the active team, or null without a (member) team context.
    teamRole: 'admin' | 'member' | null;
    now: Date;
    // Known people and their aliases (identity layer), available to every approach.
    directory: PersonRef[];
}

export interface RecallInput extends RecallQuery {
    // Computed by the harness; approaches must only return memories from these scopes.
    readableScopes: Scope[];
    directory: PersonRef[];
}

export interface IngestResult {
    notes: string[];
}

export interface RecallResult {
    memories: RecalledMemory[];
    notes: string[];
}

export interface ApproachCapabilities {
    // Can answer "what was true at time T" questions.
    asOf: boolean;
    // Can put different facts from one message into different scopes.
    perFactScope: boolean;
}

export interface MemoryApproach {
    name: string;
    capabilities: ApproachCapabilities;
    init(): Promise<void>;
    reset(): Promise<void>;
    close(): Promise<void>;
    ingest(msg: RawMessage, ctx: IngestContext): Promise<IngestResult>;
    recall(q: RecallInput): Promise<RecallResult>;
    snapshot(scopes: Scope[], asOf?: Date): Promise<RecalledMemory[]>;
    // For inspecting the store (the Memory Lab's graph view), where the approach has entities and relations.
    inspectGraph?(scopes: Scope[], at: Date, history: boolean): Promise<MemoryGraph>;
    // Approaches with working memory (temporal-kg +consolidate): what is waiting, consolidating a scope's
    // buffer now, and the offline "dream" pass. Each returns notes on what it did.
    workingMemory?(scopes: Scope[]): Promise<{ id: string; scope: Scope; at: string; actor: string; text: string }[]>;
    consolidate?(scope: Scope, directory: PersonRef[]): Promise<string[]>;
    dream?(scope: Scope, directory: PersonRef[], now: Date): Promise<string[]>;
}

export interface GraphNode {
    id: string;
    name: string;
    kind: string;
    aliases: string[];
}

// A fact between two entities; source === target for a fact about one entity ("launches November 30").
export interface GraphEdge {
    id: string;
    source: string;
    target: string;
    relation: string;
    text: string;
    status: MemoryStatus;
    validFrom: string | null;
    validTo: string | null;
    author: string | null;
    scope: Scope;
}

export interface MemoryGraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
}

// Every approach sees the same rendering of a message, so time and author reach even approaches
// that can't take them as structured input.
export function renderHeader(msg: RawMessage): string {
    const when = msg.occurredAt.slice(0, 16).replace('T', ' ');
    const via = msg.kind === 'agent' ? `${msg.actorAgent}, inferred by agent` : msg.actorAgent;
    const team = msg.activeTeamName ? ` in team ${msg.activeTeamName}` : '';
    return `[${when}] ${msg.actorName}${team} (via ${via})`;
}

// "Phoenix (t-phoenix)", for prompts.
export function teamLabel(msg: RawMessage): string {
    return msg.activeTeamId ? `${msg.activeTeamName ?? msg.activeTeamId} (${msg.activeTeamId})` : 'none';
}

export function renderTurns(turns: Turn[]): string {
    return turns.map((t) => `${t.role}: ${t.content}`).join('\n');
}

export function renderMessage(msg: RawMessage): string {
    return `${renderHeader(msg)}\n${renderTurns(msg.turns)}`;
}
