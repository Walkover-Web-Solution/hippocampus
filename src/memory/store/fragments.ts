import { Params } from '../db';

/**
 * SQL fragments every store shares. Aliases: n = memory_notes, v = memory_note_versions, s = memory_spaces,
 * c = memory_chunks, l = memory_entity_links, e = memory_entities.
 */
export interface Moment {
    // The moment to look at: what was current then, rather than now.
    asOf?: Date | null;
}

// The version to read: the current one, or the latest one saved by the moment.
export const versionJoin = (params: Params, moment: Moment = {}): string => (moment.asOf
    ? `JOIN LATERAL (SELECT * FROM memory_note_versions x WHERE x.note_id = n.id AND x.created_at <= ${params.add(moment.asOf)} ORDER BY x.version DESC LIMIT 1) v ON TRUE`
    : 'JOIN memory_note_versions v ON v.id = n.current_version_id');

// In use: active and inside its valid dates. At a moment: saved by then, not archived by then, valid then.
export const inUse = (params: Params, moment: Moment = {}): string => {
    if (!moment.asOf) return "n.status = 'active' AND n.valid_from <= now() AND (n.valid_to IS NULL OR n.valid_to > now())";
    const at = params.add(moment.asOf);
    return `n.created_at <= ${at} AND (n.status = 'active' OR n.updated_at > ${at}) AND n.valid_from <= ${at} AND (n.valid_to IS NULL OR n.valid_to > ${at})`;
};

export const NOTE_COLUMNS = `n.id, n.space_id, s.name AS space, n.path, n.kind, n.slot, n.labels, n.current_version_id, n.status, n.valid_from, n.valid_to,
    n.source, n.written_by, n.confidence, n.evidence_count, n.created_at, n.updated_at,
    v.version, v.id AS version_id, v.title, v.summary, v.written_by AS version_written_by, v.change, v.created_at AS version_created_at`;

export const kindFilter = (params: Params, kinds?: string[] | null): string => (kinds?.length ? `AND n.kind = ANY(${params.add(kinds)}::text[])` : '');

export const labelFilter = (params: Params, labels?: string[] | null): string => (labels?.length ? `AND n.labels && ${params.add(labels)}::text[]` : '');

export const RULES_FIRST = "CASE WHEN n.kind = 'rule' THEN 0 ELSE 1 END";

// A LIKE pattern for everything under a folder, with the folder's own wildcard characters escaped.
export const likePrefix = (prefix: string): string => `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
