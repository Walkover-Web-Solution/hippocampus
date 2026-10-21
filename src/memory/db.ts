import { Pool, PoolClient } from 'pg';
import { ApiError } from '../error/api-error';
import logger from '../service/logger';
import { memoryConfig } from './config';
import { migrations } from './migrations';

/**
 * One Postgres (with pgvector) holds the whole memory file system. It is separate from the Mongo and Qdrant the RAG
 * routes use, and is only opened when MEMORY_DATABASE_URL is set.
 */
export type Queryable = Pool | PoolClient;

let pool: Pool | undefined;

export const memoryDb = (): Pool => {
    if (!memoryConfig.databaseUrl) throw new ApiError('Memory is not enabled on this server: MEMORY_DATABASE_URL is not set', 503);
    if (!pool) {
        pool = new Pool({
            connectionString: memoryConfig.databaseUrl,
            ssl: memoryConfig.databaseSsl ? { rejectUnauthorized: false } : undefined,
            max: Number(process.env.MEMORY_DATABASE_POOL || 10),
        });
        pool.on('error', (error) => logger.error(`[MEMORY](postgres) ${error.message}`));
    }
    return pool;
};

export async function query<T = any>(sql: string, params: unknown[] = [], client?: Queryable): Promise<T[]> {
    const result = await (client ?? memoryDb()).query(sql, params);
    return result.rows as T[];
}

export async function one<T = any>(sql: string, params: unknown[] = [], client?: Queryable): Promise<T | null> {
    const rows = await query<T>(sql, params, client);
    return rows[0] ?? null;
}

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await memoryDb().connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

// Builds one statement's parameter list: `params.add(value)` returns the placeholder to put in the text.
export class Params {
    readonly values: unknown[] = [];

    add(value: unknown): string {
        this.values.push(value);
        return `$${this.values.length}`;
    }
}

export const toVector = (embedding: number[]): string => `[${embedding.join(',')}]`;

export async function migrateMemory(): Promise<string[]> {
    await query('CREATE TABLE IF NOT EXISTS memory_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied = new Set((await query<{ name: string }>('SELECT name FROM memory_migrations')).map((row) => row.name));
    const done: string[] = [];
    for (const migration of migrations) {
        if (applied.has(migration.name)) continue;
        await withTransaction(async (client) => {
            await client.query(migration.sql);
            await client.query('INSERT INTO memory_migrations (name) VALUES ($1)', [migration.name]);
        });
        logger.info(`[MEMORY] migration applied: ${migration.name}`);
        done.push(migration.name);
    }
    await ensureEmbeddingColumn();
    return done;
}

// The vector column is created with the configured size, but the embedding model can change later. Chunks are a
// derived index, so with MEMORY_EMBEDDING_REINDEX=true they are dropped, the column resized and every current
// version re-indexed with the new model; without it a size mismatch is reported at start instead of failing on the
// first write.
async function ensureEmbeddingColumn(): Promise<void> {
    const [column] = await query<{ dims: number; chunks: string }>(
        "SELECT a.atttypmod AS dims, (SELECT count(*) FROM memory_chunks) AS chunks FROM pg_attribute a WHERE a.attrelid = 'memory_chunks'::regclass AND a.attname = 'embedding'",
    );
    const current = column?.dims;
    const wanted = memoryConfig.embeddingDimensions;
    if (!current || current === wanted) return;
    const chunks = Number(column.chunks);
    if (chunks > 0 && !memoryConfig.reindexOnModelChange) {
        throw new Error(
            `memory_chunks.embedding is vector(${current}) but ${memoryConfig.embeddingModel} needs vector(${wanted}). Either keep the model the index was built with (MEMORY_EMBEDDING_MODEL and MEMORY_EMBEDDING_DIMENSIONS), or start once with MEMORY_EMBEDDING_REINDEX=true to drop the ${chunks} chunks, resize the column and re-index every note with the new model; until that finishes search finds only word and name matches.`,
        );
    }
    await withTransaction(async (client) => {
        await client.query('DELETE FROM memory_chunks');
        await client.query(`ALTER TABLE memory_chunks ALTER COLUMN embedding TYPE vector(${wanted})`);
    });
    logger.warn(`[MEMORY] embedding column resized from vector(${current}) to vector(${wanted}) for ${memoryConfig.embeddingModel}`);
    if (chunks === 0) return;
    // Imported here because the indexer and the queue import this module.
    const [{ currentVersionIds, reindexVersions }, { publishMemoryJob, queueConfigured }] = await Promise.all([import('./store/indexer'), import('./queue')]);
    const versionIds = await currentVersionIds({});
    logger.warn(`[MEMORY] re-indexing ${versionIds.length} notes with ${memoryConfig.embeddingModel}${queueConfigured() ? ' through the memory consumer' : ' in this process'}`);
    if (queueConfigured()) {
        const BATCH = 50;
        for (let start = 0; start < versionIds.length; start += BATCH) await publishMemoryJob({ type: 'reindex', version_ids: versionIds.slice(start, start + BATCH) });
    } else {
        void reindexVersions(versionIds).then((result) => logger.warn(`[MEMORY] re-index done: ${result.indexed} indexed, ${result.failed} failed`));
    }
}

export async function closeMemoryDb(): Promise<void> {
    await pool?.end();
    pool = undefined;
}
