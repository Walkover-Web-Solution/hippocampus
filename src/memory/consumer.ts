import { Channel } from 'amqplib';
import producer from '../config/producer';
import logger from '../service/logger';
import { memoryConfig } from './config';
import { MemoryJob } from './queue';
import { learnFromJob, loadDocument } from './service';
import { indexVersion, reindexVersions } from './store/indexer';

/**
 * The memory consumer: indexes long versions, loads documents from urls, learns from queued conversations, and
 * rebuilds indexes. A failed job is logged and parked on the failed queue; the note it concerned is untouched.
 */
async function processMemoryJob(message: any, channel: Channel): Promise<void> {
    let job: MemoryJob | undefined;
    try {
        job = JSON.parse(message.content.toString()) as MemoryJob;
        const started = Date.now();
        switch (job.type) {
            case 'index':
                await indexVersion(job.version_id, job.links ?? null);
                break;
            case 'reindex': {
                const result = await reindexVersions(job.version_ids);
                logger.info(`[MEMORY](consumer) reindexed ${result.indexed}, failed ${result.failed}`);
                break;
            }
            case 'document':
                await loadDocument(job.note_id, job.url);
                break;
            case 'learn': {
                const result = await learnFromJob(job);
                logger.info(`[MEMORY](consumer) learned ${result.changes.length} changes, ${result.skipped} skipped, ${result.failed} failed`);
                break;
            }
            default:
                throw new Error(`Unknown memory job type: ${(job as any)?.type}`);
        }
        logger.info(`[MEMORY](consumer) ${job.type} took ${Date.now() - started} ms`);
    } catch (error: any) {
        logger.error(`[MEMORY](consumer) ${job?.type ?? 'job'} failed: ${error?.message}`);
        await producer.publishToQueue(`${memoryConfig.queue}-failed`, message.content.toString()).catch(() => undefined);
    } finally {
        channel.ack(message);
    }
}

export const memoryConsumer = {
    queue: memoryConfig.queue,
    processor: processMemoryJob,
    batch: Number(process.env.MEMORY_CONSUMER_BATCH || 2),
};
