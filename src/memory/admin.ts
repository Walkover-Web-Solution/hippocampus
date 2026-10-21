import express, { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../error/api-error';
import { auth, AuthMethod } from '../middleware/auth';
import logger from '../service/logger';
import { findSigner, forgetSigner, newSecret, signMemoryToken } from './auth';
import { memoryConfig, memoryEnabled } from './config';
import { migrateMemory, one, query } from './db';
import { publishMemoryJob } from './queue';
import { currentVersionIds, reindexVersions } from './store/indexer';
import { Access } from './types';

/**
 * Operator routes, behind the master key: migrate, manage signers (the products allowed to sign memory tokens),
 * mint a token for trying things out, rebuild indexes, and read usage.
 */
const router = express.Router();

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (handler: Handler) => (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).then((data) => {
        if (!res.headersSent) res.json(data);
    }).catch((error) => {
        if (error instanceof ApiError || error instanceof z.ZodError) return next(error);
        logger.error(`[MEMORY](admin ${req.method} ${req.path}) ${error?.stack ?? error?.message ?? error}`);
        return next(new ApiError('The memory service could not complete the request; see the server log', 500));
    });
};

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw new ApiError(result.error.issues[0]?.message ?? 'invalid request', 400);
    return result.data;
};

const issuer = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, 'an issuer is letters, digits and _ . -');

router.use(auth([AuthMethod.API_KEY]));
router.use((req, res, next) => (memoryEnabled() ? next() : next(new ApiError('Memory is not enabled on this server: MEMORY_DATABASE_URL is not set', 503))));

router.post('/migrate', wrap(async () => ({ applied: await migrateMemory() })));

router.get('/signers', wrap(async () => {
    const rows = await query<{ issuer: string; name: string | null; org_id: string | null; project_id: string | null; created_at: Date; revoked_at: Date | null }>(
        'SELECT issuer, name, org_id, project_id, created_at, revoked_at FROM memory_signers ORDER BY issuer',
    );
    return {
        signers: [
            ...Object.keys(memoryConfig.signers).map((name) => ({ issuer: name, name: null, org_id: null, project_id: null, source: 'env', revoked_at: null })),
            ...rows.map((row) => ({ ...row, source: 'db' })),
        ],
    };
}));

// A new signer: a product (or viaSocket) that will sign memory tokens with the secret returned here, shown once.
// With org_id or project_id, its tokens may only carry those.
router.post('/signers', wrap(async (req, res) => {
    const input = parse(z.object({
        issuer, name: z.string().max(200).optional(), org_id: z.string().max(200).optional(), project_id: z.string().max(200).optional(), secret: z.string().min(32).max(512).optional(),
    }), req.body);
    if (memoryConfig.signers[input.issuer]) throw new ApiError(`"${input.issuer}" is configured in MEMORY_SIGNERS`, 409);
    const secret = input.secret ?? newSecret();
    const row = await one<{ issuer: string }>(
        `INSERT INTO memory_signers (issuer, secret, name, org_id, project_id) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (issuer) DO UPDATE SET secret = EXCLUDED.secret, name = COALESCE(EXCLUDED.name, memory_signers.name),
            org_id = EXCLUDED.org_id, project_id = EXCLUDED.project_id, revoked_at = NULL
         RETURNING issuer`,
        [input.issuer, secret, input.name ?? null, input.org_id ?? null, input.project_id ?? null],
    );
    forgetSigner(input.issuer);
    res.status(201);
    return { issuer: row?.issuer, secret, org_id: input.org_id ?? null, project_id: input.project_id ?? null };
}));

router.delete('/signers/:issuer', wrap(async (req) => {
    const name = parse(issuer, req.params.issuer);
    const rows = await query('UPDATE memory_signers SET revoked_at = now() WHERE issuer = $1 AND revoked_at IS NULL RETURNING issuer', [name]);
    forgetSigner(name);
    return { issuer: name, revoked: rows.length > 0 };
}));

// A token signed for a known signer: for trying the API from curl or an MCP client without a backend.
router.post('/token', wrap(async (req) => {
    const input = parse(z.object({
        issuer,
        org: z.string().max(200),
        project: z.string().max(200),
        caller: z.string().max(200).optional(),
        spaces: z.record(z.enum(['read', 'append', 'write'])),
        expires_in: z.union([z.string(), z.number().int().positive()]).optional(),
    }), req.body);
    const signer = await findSigner(input.issuer);
    if (!signer || signer.revoked_at) throw new ApiError(`Unknown signer "${input.issuer}"`, 404);
    const token = signMemoryToken({
        issuer: input.issuer, secret: signer.secret, orgId: input.org, projectId: input.project, caller: input.caller, spaces: input.spaces as Record<string, Access>, expiresIn: input.expires_in ?? '1h',
    });
    return { token, expires_in: input.expires_in ?? '1h' };
}));

// Rebuild the chunks, summaries, names and links of every current version: of a tenant, of some of its spaces,
// or only of versions whose chunks were made with another embedding model.
router.post('/reindex', wrap(async (req) => {
    const input = parse(z.object({
        issuer: issuer.optional(), org: z.string().optional(), project: z.string().optional(), spaces: z.array(z.string()).optional(), stale_only: z.boolean().optional(), inline: z.boolean().optional(),
    }), req.body ?? {});
    let spaceIds: string[] | undefined;
    if (input.spaces?.length) {
        if (!input.issuer || !input.org || !input.project) throw new ApiError('spaces need issuer, org and project', 400);
        const rows = await query<{ id: string }>(
            'SELECT id FROM memory_spaces WHERE issuer = $1 AND org_id = $2 AND project_id = $3 AND name = ANY($4::text[])',
            [input.issuer, input.org, input.project, input.spaces],
        );
        spaceIds = rows.map((row) => row.id);
    }
    const versionIds = await currentVersionIds({
        spaceIds, issuer: input.issuer, orgId: input.org, projectId: input.project, staleModel: input.stale_only ? memoryConfig.embeddingModel : undefined,
    });
    if (input.inline) return { versions: versionIds.length, ...(await reindexVersions(versionIds)) };
    const BATCH = 50;
    for (let start = 0; start < versionIds.length; start += BATCH) {
        await publishMemoryJob({ type: 'reindex', version_ids: versionIds.slice(start, start + BATCH) });
    }
    return { versions: versionIds.length, queued: true };
}));

router.get('/usage', wrap(async (req) => {
    const input = parse(z.object({
        issuer: z.string().optional(), org: z.string().optional(), project: z.string().optional(), from: z.string().optional(), to: z.string().optional(),
    }), req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace('?', `$${params.length}`));
    };
    if (input.issuer) add('issuer = ?', input.issuer);
    if (input.org) add('org_id = ?', input.org);
    if (input.project) add('project_id = ?', input.project);
    if (input.from) add('at >= ?', new Date(input.from));
    if (input.to) add('at < ?', new Date(input.to));
    const rows = await query(
        `SELECT issuer, org_id, project_id, verb, COUNT(*)::int AS calls, SUM(tokens)::int AS tokens
         FROM memory_usage ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         GROUP BY issuer, org_id, project_id, verb ORDER BY issuer, org_id, project_id, verb`,
        params,
    );
    return { usage: rows };
}));

export default router;
