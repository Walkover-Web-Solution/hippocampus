import { memoryConfig } from './config';
import { Links, Source, Tenant } from './types';

/**
 * Work the memory consumer does off the request: indexing a long version, learning from a conversation, loading a
 * document from a url, rebuilding indexes. Publishing fails when the broker is not reachable; callers then do the
 * work inline or report it.
 */
export type MemoryJob =
    | { type: 'index'; version_id: string; links?: Links | null }
    | { type: 'reindex'; version_ids: string[] }
    | { type: 'document'; note_id: string; url: string }
    | {
        type: 'learn';
        tenant: Tenant;
        caller: string;
        space: string;
        shared_space?: string | null;
        text: string;
        source?: Source | null;
        rules_allowed?: boolean;
    };

export const queueConfigured = (): boolean => Boolean(process.env.QUEUE_CONNECTIONURL);

// The producer is loaded on first use: a memory-only deployment without RabbitMQ never opens a connection, and a
// publish there fails at once so the caller does the work inline.
export async function publishMemoryJob(job: MemoryJob): Promise<void> {
    if (!queueConfigured()) throw new Error('No queue is configured (QUEUE_CONNECTIONURL)');
    const { default: producer } = await import('../config/producer');
    await producer.publishToQueue(memoryConfig.queue, job);
}
