import { Params, query } from '../db';
import { normalizeEntityName } from '../text';
import { EntityLink, EntityNode, EntitySummary, EntityType, NoteRow, SpaceRow } from '../types';
import { inUse, Moment, NOTE_COLUMNS, RULES_FIRST, versionJoin } from './fragments';

/**
 * The graph is not a separate store: nodes are the names found in notes, links are the relations a note states,
 * and both belong to the version they were read from, so "Acme as of October 1" is the links of the versions that
 * were current then.
 */
const DEFAULT_KNOWN = 60;
const DEFAULT_NEIGHBOURS = 20;
const DEFAULT_LINKS = 60;
const ENTITY_NOTES = 100;
const ENTITY_LINKS = 200;

// The first type given to a node, except that a real type beats "other".
const BEST_TYPE = "(array_agg(e.type ORDER BY CASE WHEN e.type = 'other' THEN 1 ELSE 0 END))[1]";

const ids = (spaces: SpaceRow[]): string[] => spaces.map((space) => space.id);

// The names some spaces know, most recently mentioned first, so a model spells a thing the way it is already spelled.
export async function knownEntities(spaces: SpaceRow[], limit = DEFAULT_KNOWN): Promise<{ name: string; type: EntityType }[]> {
    if (!spaces.length) return [];
    return query(
        `SELECT e.name, ${BEST_TYPE} AS type FROM memory_entities e WHERE e.space_id = ANY($1::uuid[])
         GROUP BY e.name ORDER BY MAX(e.updated_at) DESC LIMIT $2`,
        [ids(spaces), limit],
    );
}

// Which of some words are names the graph knows.
export async function matchEntities(spaces: SpaceRow[], names: string[]): Promise<string[]> {
    if (!spaces.length || !names.length) return [];
    const rows = await query<{ name: string }>('SELECT DISTINCT e.name FROM memory_entities e WHERE e.space_id = ANY($1::uuid[]) AND e.name = ANY($2::text[])', [ids(spaces), names]);
    return rows.map((row) => row.name);
}

const linkRows = (params: Params, spaces: SpaceRow[], names: string[], moment: Moment): string => `
    FROM memory_entity_links l
    JOIN memory_notes n ON n.id = l.note_id
    JOIN memory_spaces s ON s.id = n.space_id
    ${versionJoin(params, moment)}
    WHERE l.version_id = v.id AND l.space_id = ANY(${params.add(ids(spaces))}::uuid[])
      AND (l.subject = ANY(${params.add(names)}::text[]) OR l.object = ANY(${params.add(names)}::text[]))
      AND ${inUse(params, moment)}`;

// The names one link away from some names, most linked first.
export async function neighbours(spaces: SpaceRow[], names: string[], limit = DEFAULT_NEIGHBOURS, moment: Moment = {}): Promise<{ name: string; links: number }[]> {
    if (!spaces.length || !names.length) return [];
    const params = new Params();
    const rows = await query<{ name: string; links: number }>(
        `SELECT t.name, COUNT(*)::int AS links FROM (
            SELECT CASE WHEN l.subject = ANY(${params.add(names)}::text[]) THEN l.object ELSE l.subject END AS name ${linkRows(params, spaces, names, moment)}
         ) t WHERE NOT (t.name = ANY(${params.add(names)}::text[]))
         GROUP BY t.name ORDER BY links DESC, t.name LIMIT ${params.add(limit)}`,
        params.values,
    );
    return rows;
}

// The links at either end of some names, newest first.
export async function linksOf(spaces: SpaceRow[], names: string[], limit = DEFAULT_LINKS, moment: Moment = {}): Promise<EntityLink[]> {
    if (!spaces.length || !names.length) return [];
    const params = new Params();
    const rows = await query<{ subject: string; relation: string; object: string; space: string; path: string; created_at: Date; updated_at: Date; valid_to: Date | null }>(
        `SELECT l.subject, l.relation, l.object, s.name AS space, n.path, v.created_at, n.updated_at, n.valid_to ${linkRows(params, spaces, names, moment)}
         ORDER BY n.updated_at DESC LIMIT ${params.add(limit)}`,
        params.values,
    );
    return rows.map((row) => ({
        subject: row.subject,
        relation: row.relation,
        object: row.object,
        space: row.space,
        path: row.path,
        // Looking back, a link was true from when its version was saved; looking at now, from the note's last change.
        asOf: moment.asOf ? row.created_at : row.updated_at,
        until: row.valid_to,
    }));
}

// The notes that name one thing, rules first, newest first.
export async function entityNotes(spaces: SpaceRow[], name: string, limit = ENTITY_NOTES, moment: Moment = {}): Promise<NoteRow[]> {
    if (!spaces.length) return [];
    const params = new Params();
    const nameParam = params.add(name);
    return query<NoteRow>(
        `SELECT ${NOTE_COLUMNS} FROM memory_notes n JOIN memory_spaces s ON s.id = n.space_id ${versionJoin(params, moment)}
         WHERE n.space_id = ANY(${params.add(ids(spaces))}::uuid[]) AND ${inUse(params, moment)}
           AND (${nameParam} = ANY(v.names) OR EXISTS (SELECT 1 FROM memory_entity_links l WHERE l.version_id = v.id AND (l.subject = ${nameParam} OR l.object = ${nameParam})))
         ORDER BY ${RULES_FIRST}, n.updated_at DESC LIMIT ${params.add(limit)}`,
        params.values,
    );
}

export async function entityType(spaces: SpaceRow[], name: string): Promise<EntityType | null> {
    if (!spaces.length) return null;
    const rows = await query<{ type: EntityType }>(
        `SELECT e.type FROM memory_entities e WHERE e.space_id = ANY($1::uuid[]) AND e.name = $2
         ORDER BY CASE WHEN e.type = 'other' THEN 1 ELSE 0 END LIMIT 1`,
        [ids(spaces), name],
    );
    return rows[0]?.type ?? null;
}

// Everything about one named thing: its notes, its links in and out, and the names one hop away to open next.
export async function entityNode(spaces: SpaceRow[], rawName: string, options: Moment & { limit?: number } = {}): Promise<EntityNode | null> {
    const name = normalizeEntityName(rawName);
    if (!name || !spaces.length) return null;
    const [notes, links, type] = await Promise.all([
        entityNotes(spaces, name, Math.min(options.limit ?? ENTITY_NOTES, ENTITY_NOTES), options),
        linksOf(spaces, [name], ENTITY_LINKS, options),
        entityType(spaces, name),
    ]);
    if (!notes.length && !links.length) return null;
    const counts = new Map<string, number>();
    for (const link of links as EntityLink[]) {
        const other: string = link.subject === name ? link.object : link.subject;
        if (other !== name) counts.set(other, (counts.get(other) ?? 0) + 1);
    }
    const connected = [...counts.entries()].map(([other, count]) => ({ name: other, links: count })).sort((a, b) => b.links - a.links || a.name.localeCompare(b.name));
    return { name, type, notes, links, connected };
}

// The nodes of some spaces, most mentioned first, with how many notes in use mention each.
export async function listEntities(spaces: SpaceRow[], { q, limit, offset }: { q?: string | null; limit: number; offset: number }): Promise<EntitySummary[]> {
    if (!spaces.length) return [];
    const params = new Params();
    const filter = q ? `AND e.name LIKE ${params.add(`%${q.toLowerCase().replace(/[\\%_]/g, '')}%`)}` : '';
    return query<EntitySummary>(
        `SELECT e.name, ${BEST_TYPE} AS type, COUNT(DISTINCT n.id)::int AS notes
         FROM memory_entities e
         LEFT JOIN memory_note_entities ne ON ne.entity_id = e.id
         LEFT JOIN memory_notes n ON n.current_version_id = ne.version_id AND n.status = 'active' AND n.valid_from <= now() AND (n.valid_to IS NULL OR n.valid_to > now())
         WHERE e.space_id = ANY(${params.add(ids(spaces))}::uuid[]) ${filter}
         GROUP BY e.name HAVING COUNT(DISTINCT n.id) > 0
         ORDER BY notes DESC, e.name LIMIT ${params.add(limit)} OFFSET ${params.add(offset)}`,
        params.values,
    );
}
