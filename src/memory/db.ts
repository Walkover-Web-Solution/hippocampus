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
    return done;
}

export async function closeMemoryDb(): Promise<void> {
    await pool?.end();
    pool = undefined;
}
