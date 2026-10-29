import { cosine, getEmbedder } from '../../core/embed';
import { IngestContext, IngestResult, MemoryApproach, RawMessage, RecallQuery, RecallResult, RecalledMemory, Scope, renderMessage } from '../../core/types';

interface Entry {
    messageId: string;
    author: string;
    scope: Scope;
    text: string;
    embedding: number[];
    occurredAt: string;
}

// Control: no LLM at write time. Each raw message is embedded and stored in the actor's default scope;
// recall is an exact cosine scan. Anything worth keeping must beat this.
export class NaiveApproach implements MemoryApproach {
    name = 'naive';
    capabilities = { asOf: true, perFactScope: false };
    private entries: Entry[] = [];

    async init() {}

    async reset() {
        this.entries = [];
    }

    async close() {}

    async ingest(msg: RawMessage, ctx: IngestContext): Promise<IngestResult> {
        const text = renderMessage(msg);
        const [embedding] = await getEmbedder().embed([text]);
        this.entries.push({ messageId: msg.id, author: msg.actorName, scope: ctx.defaultScope, text, embedding, occurredAt: msg.occurredAt });
        return { notes: [`stored the raw message in ${ctx.defaultScope}`] };
    }

    async recall(q: RecallQuery & { readableScopes: Scope[] }): Promise<RecallResult> {
        const [queryVector] = await getEmbedder().embed([q.query]);
        const cutoff = Date.parse(q.asOf ?? q.now);
        const memories = this.entries
            .filter((e) => q.readableScopes.includes(e.scope) && Date.parse(e.occurredAt) <= cutoff)
            .map((e) => ({ entry: e, score: cosine(queryVector, e.embedding) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, q.topK)
            .map(({ entry, score }) => toMemory(entry, score));
        return { memories, notes: [] };
    }

    async snapshot(scopes: Scope[], asOf?: Date): Promise<RecalledMemory[]> {
        const cutoff = asOf ? asOf.getTime() : Infinity;
        return this.entries
            .filter((e) => scopes.includes(e.scope) && Date.parse(e.occurredAt) <= cutoff)
            .map((e) => toMemory(e, null));
    }
}

function toMemory(entry: Entry, score: number | null): RecalledMemory {
    return {
        text: entry.text,
        scope: entry.scope,
        status: 'current',
        validFrom: entry.occurredAt,
        validTo: null,
        sourceMessageIds: [entry.messageId],
        score,
        author: entry.author,
    };
}
