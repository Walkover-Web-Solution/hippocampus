import { AsyncLocalStorage } from 'async_hooks';
import logger from '../service/logger';
import { query } from './db';
import { Tenant } from './types';

/**
 * Metering: one row per call, with the model tokens it used. The count is kept in an async context opened by the
 * auth middleware, so the embedder and the chat models add to it without the handlers passing it around.
 */
interface UsageStore {
    tokens: number;
}

const storage = new AsyncLocalStorage<UsageStore>();

export const runWithUsage = <T>(work: () => T): T => storage.run({ tokens: 0 }, work);

export const addTokens = (count: number | undefined | null): void => {
    const store = storage.getStore();
    if (store && typeof count === 'number' && count > 0) store.tokens += Math.round(count);
};

export const tokensUsed = (): number => storage.getStore()?.tokens ?? 0;

export const recordUsage = (tenant: Tenant, caller: string | null, verb: string, tokens: number): void => {
    query(
        'INSERT INTO memory_usage (issuer, org_id, project_id, caller, verb, tokens) VALUES ($1, $2, $3, $4, $5, $6)',
        [tenant.issuer, tenant.orgId, tenant.projectId, caller, verb, tokens],
    ).catch((error) => logger.error(`[MEMORY](usage) ${error?.message}`));
};
