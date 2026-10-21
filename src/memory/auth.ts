import { randomBytes } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ApiError } from '../error/api-error';
import logger from '../service/logger';
import { memoryConfig } from './config';
import { one, query } from './db';
import { grantCovers, grantSpecificity, isGrantPattern, normalizeSpace } from './paths';
import { Access, Tenant } from './types';
import { recordUsage, runWithUsage, tokensUsed } from './usage';

/**
 * Access is decided by the product and enforced here, from the token alone. A product's backend (or viaSocket on
 * its behalf) signs a short-lived HS256 token:
 *
 *   { "iss": "viasocket", "sub": "users/maya", "org": "4310", "project": "projX",
 *     "spaces": { "users/maya": "write", "teams/acme": "write", "product-truth": "read", "customers/*": "read" },
 *     "iat": ..., "exp": ... }
 *
 * `iss` names a signer registered with Hippocampus (MEMORY_SIGNERS, or the admin API), whose secret verifies the
 * token. `org` and `project` are the product's own ids; with `iss` they make the tenant that every row carries.
 * `spaces` grants read or write per space, with "folder/*" and "*" wildcards. Identity never enters Hippocampus:
 * `sub` is only recorded as who wrote a note.
 */
export const MAX_GRANTS = 50;

// Each level includes the ones below it: write may do everything append may, append everything read may.
const RANK: Record<Access, number> = { read: 0, append: 1, write: 2 };

export interface MemoryAuth {
    tenant: Tenant;
    caller: string;
    grants: Grants;
}

export class Grants {
    private readonly byPattern: Map<string, Access>;

    constructor(entries: Iterable<[string, Access]>) {
        this.byPattern = new Map(entries);
    }

    static parse(claim: unknown): Grants {
        if (claim === undefined || claim === null) return new Grants([]);
        if (typeof claim !== 'object' || Array.isArray(claim)) throw new ApiError('The token\'s "spaces" must map space names to "read", "append" or "write"', 401);
        const entries = Object.entries(claim as Record<string, unknown>);
        if (entries.length > MAX_GRANTS) throw new ApiError(`The token grants more than ${MAX_GRANTS} spaces`, 401);
        return new Grants(entries.map(([pattern, access]) => {
            if (!isGrantPattern(pattern)) throw new ApiError(`The token grants an invalid space name "${pattern}"`, 401);
            if (access !== 'read' && access !== 'append' && access !== 'write') throw new ApiError(`The token's grant for "${pattern}" must be "read", "append" or "write"`, 401);
            return [pattern, access];
        }));
    }

    get patterns(): string[] {
        return [...this.byPattern.keys()];
    }

    patternsWith(access: Access): string[] {
        return [...this.byPattern.entries()].filter(([, granted]) => RANK[granted] >= RANK[access]).map(([pattern]) => pattern);
    }

    // The access to one space: the most specific pattern that covers it decides, so "customers/*": read with
    // "customers/acme": write gives write on acme and read on the rest.
    accessTo(space: string): Access | null {
        let best: { specificity: number; access: Access } | null = null;
        for (const [pattern, access] of this.byPattern) {
            if (!grantCovers(pattern, space)) continue;
            const specificity = grantSpecificity(pattern);
            if (!best || specificity > best.specificity) best = { specificity, access };
        }
        return best?.access ?? null;
    }

    can(space: string, access: Access): boolean {
        const granted = this.accessTo(space);
        return granted !== null && RANK[granted] >= RANK[access];
    }

    require(space: string, access: Access): string {
        const name = normalizeSpace(space);
        if (!this.can(name, access)) throw new ApiError(`This token cannot ${access} the memory space "${name}"`, 403);
        return name;
    }

    toJSON(): Record<string, Access> {
        return Object.fromEntries(this.byPattern);
    }
}

interface SignerRow {
    issuer: string;
    secret: string;
    org_id: string | null;
    project_id: string | null;
    revoked_at: Date | null;
}

const SIGNER_CACHE_MS = 60 * 1000;
const signerCache = new Map<string, { row: SignerRow | null; until: number }>();

export const forgetSigner = (issuer: string): void => {
    signerCache.delete(issuer);
};

// A signer from the environment, or from the memory_signers table (cached for a minute).
export async function findSigner(issuer: string): Promise<SignerRow | null> {
    const fromEnv = memoryConfig.signers[issuer];
    if (fromEnv) return { issuer, secret: fromEnv, org_id: null, project_id: null, revoked_at: null };
    const cached = signerCache.get(issuer);
    if (cached && cached.until > Date.now()) return cached.row;
    let row: SignerRow | null = null;
    try {
        row = await one<SignerRow>('SELECT issuer, secret, org_id, project_id, revoked_at FROM memory_signers WHERE issuer = $1', [issuer]);
    } catch (error: any) {
        logger.error(`[MEMORY](signers) ${error?.message}`);
    }
    signerCache.set(issuer, { row, until: Date.now() + SIGNER_CACHE_MS });
    return row;
}

const claimString = (claims: Record<string, unknown>, ...names: string[]): string | null => {
    for (const name of names) {
        const value = claims[name];
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (typeof value === 'number') return String(value);
    }
    return null;
};

export async function verifyMemoryToken(raw: string | undefined): Promise<MemoryAuth> {
    const token = raw?.replace(/^Bearer\s+/i, '').trim();
    if (!token) throw new ApiError('Missing memory token', 401);
    const decoded = jwt.decode(token);
    const issuer = decoded && typeof decoded === 'object' ? claimString(decoded as Record<string, unknown>, 'iss') : null;
    if (!issuer) throw new ApiError('The memory token names no issuer (iss)', 401);
    const signer = await findSigner(issuer);
    if (!signer || signer.revoked_at) throw new ApiError(`Unknown memory token issuer "${issuer}"`, 401);

    let claims: Record<string, unknown>;
    try {
        claims = jwt.verify(token, signer.secret, { algorithms: ['HS256'], issuer, maxAge: memoryConfig.tokenMaxAgeSeconds }) as Record<string, unknown>;
    } catch (error: any) {
        throw new ApiError(error?.name === 'TokenExpiredError' ? 'The memory token has expired' : 'Invalid memory token', 401);
    }
    if (typeof claims.exp !== 'number') throw new ApiError('The memory token must carry an expiry (exp)', 401);
    const orgId = claimString(claims, 'org', 'org_id');
    const projectId = claimString(claims, 'project', 'project_id');
    if (!orgId || !projectId) throw new ApiError('The memory token must carry org and project', 401);
    if (signer.org_id && signer.org_id !== orgId) throw new ApiError(`The signer "${issuer}" may only sign for its own org`, 401);
    if (signer.project_id && signer.project_id !== projectId) throw new ApiError(`The signer "${issuer}" may only sign for its own project`, 401);
    return {
        tenant: { issuer, orgId, projectId },
        caller: claimString(claims, 'sub') ?? issuer,
        grants: Grants.parse(claims.spaces),
    };
}

export interface TokenInput {
    issuer: string;
    secret: string;
    orgId: string;
    projectId: string;
    caller?: string;
    spaces: Record<string, Access>;
    // Seconds, or a string jsonwebtoken understands such as "1h".
    expiresIn?: string | number;
}

export const signMemoryToken = ({ issuer, secret, orgId, projectId, caller, spaces, expiresIn = '1h' }: TokenInput): string => jwt.sign(
    { org: orgId, project: projectId, spaces, ...(caller && { sub: caller }) },
    secret,
    { algorithm: 'HS256', issuer, expiresIn: expiresIn as any },
);

export const newSecret = (): string => randomBytes(32).toString('base64url');

export const memoryAuthOf = (res: Response): MemoryAuth => {
    const auth = res.locals.memoryAuth as MemoryAuth | undefined;
    if (!auth) throw new ApiError('Missing memory token', 401);
    return auth;
};

// Verifies the token, leaves the auth in res.locals.memoryAuth, and meters the call when the response is sent.
export function memoryAuth(req: Request, res: Response, next: NextFunction): void {
    verifyMemoryToken(req.header('authorization') ?? req.header('x-memory-token'))
        .then((auth) => {
            res.locals.memoryAuth = auth;
            runWithUsage(() => {
                res.on('finish', () => {
                    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.originalUrl.split('?')[0];
                    recordUsage(auth.tenant, auth.caller, `${req.method} ${route}`, tokensUsed());
                });
                next();
            });
        })
        .catch(next);
}
