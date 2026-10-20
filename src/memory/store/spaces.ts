import { randomUUID } from 'crypto';
import { Grants } from '../auth';
import { one, Params, query, Queryable } from '../db';
import { grantCondition, grantCovers, normalizeSpace } from '../paths';
import { Access, SpaceRow, Tenant } from '../types';

/**
 * Spaces are the folders of a tenant: created on first write, named by the product, reached only through the
 * grants in the token.
 */
export interface SpaceSummary extends SpaceRow {
    notes: number;
    updated_at: Date | null;
}

const tenantWhere = (params: Params, tenant: Tenant, alias = 's'): string => (
    `${alias}.issuer = ${params.add(tenant.issuer)} AND ${alias}.org_id = ${params.add(tenant.orgId)} AND ${alias}.project_id = ${params.add(tenant.projectId)}`
);

export async function findSpace(tenant: Tenant, name: string, client?: Queryable): Promise<SpaceRow | null> {
    const params = new Params();
    return one<SpaceRow>(`SELECT s.id, s.name FROM memory_spaces s WHERE ${tenantWhere(params, tenant)} AND s.name = ${params.add(name)}`, params.values, client);
}

export async function ensureSpace(tenant: Tenant, name: string, client?: Queryable): Promise<SpaceRow> {
    const inserted = await one<SpaceRow>(
        `INSERT INTO memory_spaces (id, issuer, org_id, project_id, name) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (issuer, org_id, project_id, name) DO NOTHING RETURNING id, name`,
        [randomUUID(), tenant.issuer, tenant.orgId, tenant.projectId, name],
        client,
    );
    return inserted ?? (await findSpace(tenant, name, client)) as SpaceRow;
}

// The spaces a token reaches that exist, with how many notes each holds: the top level of the file system.
export async function listSpaces(tenant: Tenant, grants: Grants, access: Access = 'read'): Promise<SpaceSummary[]> {
    const patterns = grants.patternsWith(access);
    if (!patterns.length) return [];
    const params = new Params();
    const covered = patterns.map((pattern) => grantCondition(pattern, 's.name', (value) => params.add(value))).join(' OR ');
    const rows = await query<SpaceSummary>(
        `SELECT s.id, s.name, c.notes, c.updated_at
         FROM memory_spaces s
         LEFT JOIN LATERAL (
            SELECT COUNT(*) FILTER (WHERE n.status = 'active')::int AS notes, MAX(n.updated_at) AS updated_at FROM memory_notes n WHERE n.space_id = s.id
         ) c ON TRUE
         WHERE ${tenantWhere(params, tenant)} AND (${covered})
         ORDER BY s.name`,
        params.values,
    );
    return orderByGrant(rows, grants);
}

// Spaces in the order of the token's grants, so the first granted space is the most specific one: a rule in it
// beats the same rule in a space granted later.
const orderByGrant = <T extends SpaceRow>(rows: T[], grants: Grants): T[] => {
    const patterns = grants.patterns;
    const rank = (name: string): number => {
        const index = patterns.findIndex((pattern) => grantCovers(pattern, name));
        return index === -1 ? patterns.length : index;
    };
    return [...rows].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
};

/**
 * The spaces a request works in. Named spaces must each be granted for the access asked, and are returned in the
 * order given (their precedence); for reading, a named space that does not exist yet is simply empty, for writing
 * it is created. Without names: every existing space the token may use that way.
 */
export async function resolveSpaces(tenant: Tenant, grants: Grants, requested: string[] | undefined | null, access: Access): Promise<SpaceRow[]> {
    if (!requested?.length) return listSpaces(tenant, grants, access);
    const names = [...new Set(requested.map((name) => grants.require(normalizeSpace(name), access)))];
    if (access === 'write') return Promise.all(names.map((name) => ensureSpace(tenant, name)));
    const params = new Params();
    const rows = await query<SpaceRow>(
        `SELECT s.id, s.name FROM memory_spaces s WHERE ${tenantWhere(params, tenant)} AND s.name = ANY(${params.add(names)}::text[])`,
        params.values,
    );
    const byName = new Map(rows.map((row) => [row.name, row]));
    return names.map((name) => byName.get(name)).filter((row): row is SpaceRow => Boolean(row));
}

// Removes a space with everything in it: notes, versions, documents and every index entry. Returns the note count.
export async function deleteSpace(space: SpaceRow, client?: Queryable): Promise<number> {
    const counted = await one<{ notes: number }>('SELECT COUNT(*)::int AS notes FROM memory_notes WHERE space_id = $1', [space.id], client);
    await query('DELETE FROM memory_spaces WHERE id = $1', [space.id], client);
    return counted?.notes ?? 0;
}
