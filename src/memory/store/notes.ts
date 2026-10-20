import { randomUUID } from 'crypto';
import { ApiError } from '../../error/api-error';
import { firstSentence } from '../chunker';
import { one, Params, query, Queryable, withTransaction } from '../db';
import { folderOf, normalizeKind, normalizePath } from '../paths';
import { normalizeLabels, normalizeSlot } from '../text';
import { DocumentRow, NoteRow, Source, SpaceRow, VersionRow } from '../types';
import { inUse, kindFilter, labelFilter, likePrefix, Moment, NOTE_COLUMNS, RULES_FIRST, versionJoin } from './fragments';

/**
 * Notes are the files: one per path in a space, every write a new version, the old versions kept for history and
 * for reading the past. A write never destroys; delete is the only thing that does.
 */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export interface WriteInput {
    space: SpaceRow;
    path: string;
    body: string;
    // Left out: the note keeps its title, kind, slot, labels, dates and source. Null clears where allowed.
    title?: string | null;
    kind?: string | null;
    slot?: string | null;
    labels?: string[] | null;
    validFrom?: Date | null;
    validTo?: Date | null;
    source?: Source | null;
    confidence?: number | null;
    // Refused when the note is not at this version: two writers cannot silently race.
    ifVersion?: number | null;
    // Why this version exists: write, edit, learn, remember, document, feedback.
    change?: string;
}

export interface WriteResult {
    note: NoteRow;
    created: boolean;
    previousVersion: number | null;
}

const FROM_NOTES = 'FROM memory_notes n JOIN memory_spaces s ON s.id = n.space_id';

export async function loadNote(id: string, { withBody = false }: { withBody?: boolean } = {}, client?: Queryable): Promise<NoteRow | null> {
    return one<NoteRow>(
        `SELECT ${NOTE_COLUMNS}${withBody ? ', v.body' : ''} ${FROM_NOTES} JOIN memory_note_versions v ON v.id = n.current_version_id WHERE n.id = $1`,
        [id],
        client,
    );
}

export async function findNote(space: SpaceRow, path: string, client?: Queryable): Promise<NoteRow | null> {
    return one<NoteRow>(
        `SELECT ${NOTE_COLUMNS} ${FROM_NOTES} JOIN memory_note_versions v ON v.id = n.current_version_id WHERE n.space_id = $1 AND n.path = $2`,
        [space.id, path],
        client,
    );
}

export async function writeNote(caller: string, input: WriteInput): Promise<WriteResult> {
    const path = normalizePath(input.path);
    const body = input.body.replace(/\r\n?/g, '\n');
    return withTransaction(async (client) => {
        const existing = await one<{ id: string; kind: string; slot: string | null; version: number | null; title: string | null }>(
            `SELECT n.id, n.kind, n.slot, v.version, v.title FROM memory_notes n LEFT JOIN memory_note_versions v ON v.id = n.current_version_id
             WHERE n.space_id = $1 AND n.path = $2 FOR UPDATE OF n`,
            [input.space.id, path],
            client,
        );
        const currentVersion = existing?.version ?? 0;
        if (input.ifVersion !== undefined && input.ifVersion !== null && input.ifVersion !== currentVersion) {
            throw new ApiError(`"${path}" is at version ${currentVersion}, not ${input.ifVersion}: read it again before writing`, 409);
        }
        const kind = input.kind !== undefined && input.kind !== null ? normalizeKind(input.kind) : (existing?.kind ?? 'note');
        let slot: string | null = null;
        if (kind === 'rule') slot = input.slot === undefined ? (existing?.slot ?? null) : normalizeSlot(input.slot);
        // One live rule per slot in a space: the previous holder of this slot is archived, kept as history.
        if (slot) {
            await client.query(
                "UPDATE memory_notes SET status = 'archived', updated_at = now() WHERE space_id = $1 AND slot = $2 AND status = 'active' AND id <> $3",
                [input.space.id, slot, existing?.id ?? NIL_UUID],
            );
        }
        const labels = input.labels === undefined || input.labels === null ? null : normalizeLabels(input.labels);
        const noteId = existing?.id ?? randomUUID();
        if (!existing) {
            await client.query(
                `INSERT INTO memory_notes (id, space_id, path, kind, slot, labels, status, valid_from, valid_to, source, written_by, confidence)
                 VALUES ($1, $2, $3, $4, $5, $6, 'active', COALESCE($7, now()), $8, $9, $10, $11)`,
                [noteId, input.space.id, path, kind, slot, labels ?? [], input.validFrom ?? null, input.validTo ?? null, input.source ? JSON.stringify(input.source) : null, caller, input.confidence ?? null],
            );
        }
        const last = await one<{ version: number }>('SELECT COALESCE(MAX(version), 0)::int AS version FROM memory_note_versions WHERE note_id = $1', [noteId], client);
        const version = (last?.version ?? 0) + 1;
        const versionId = randomUUID();
        const title = input.title === undefined ? (existing?.title ?? null) : input.title;
        await client.query(
            'INSERT INTO memory_note_versions (id, note_id, version, title, summary, body, written_by, change) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [versionId, noteId, version, title, firstSentence(body), body, caller, input.change ?? 'write'],
        );
        await client.query(
            `UPDATE memory_notes SET current_version_id = $2, status = 'active', updated_at = now(), kind = $3, slot = $4, written_by = $5,
                labels = COALESCE($6::text[], labels),
                valid_from = COALESCE($7, valid_from),
                valid_to = CASE WHEN $8 THEN $9 ELSE valid_to END,
                source = COALESCE($10::jsonb, source),
                confidence = COALESCE($11, confidence)
             WHERE id = $1`,
            [noteId, versionId, kind, slot, caller, labels, input.validFrom ?? null, input.validTo !== undefined, input.validTo ?? null, input.source ? JSON.stringify(input.source) : null, input.confidence ?? null],
        );
        const note = await loadNote(noteId, { withBody: true }, client) as NoteRow;
        return { note, created: !existing, previousVersion: existing ? currentVersion : null };
    });
}

// Edits in the middle of a note, the way a person edits a file: replace one exact phrase, insert after a line,
// add at the start or end, or remove one exact phrase.
export type EditOp =
    | { op: 'str_replace'; old: string; new: string }
    | { op: 'insert'; line: number; text: string }
    | { op: 'append'; text: string }
    | { op: 'prepend'; text: string }
    | { op: 'delete'; old: string };

export const applyEdits = (body: string, ops: EditOp[]): string => {
    let text = body.replace(/\r\n?/g, '\n');
    for (const edit of ops) {
        switch (edit.op) {
            case 'str_replace':
            case 'delete': {
                const first = text.indexOf(edit.old);
                if (first === -1) throw new ApiError(`The text to ${edit.op === 'delete' ? 'delete' : 'replace'} was not found in the note: "${edit.old.slice(0, 80)}"`, 409);
                if (text.indexOf(edit.old, first + 1) !== -1) throw new ApiError(`The text to ${edit.op === 'delete' ? 'delete' : 'replace'} appears more than once in the note; give more of it: "${edit.old.slice(0, 80)}"`, 409);
                text = text.slice(0, first) + (edit.op === 'delete' ? '' : edit.new) + text.slice(first + edit.old.length);
                break;
            }
            case 'insert': {
                const lines = text ? text.split('\n') : [];
                if (!Number.isInteger(edit.line) || edit.line < 0 || edit.line > lines.length) throw new ApiError(`Line ${edit.line} is outside the note, which has ${lines.length} lines`, 409);
                lines.splice(edit.line, 0, edit.text);
                text = lines.join('\n');
                break;
            }
            case 'append':
                text = text ? `${text.replace(/\n+$/, '')}\n${edit.text}` : edit.text;
                break;
            case 'prepend':
                text = text ? `${edit.text}\n${text}` : edit.text;
                break;
            default:
                throw new ApiError('Unknown edit operation', 400);
        }
    }
    return text;
};

export interface OpenOptions extends Moment {
    version?: number | null;
}

// A note with its body: as it is, as it was at a moment, or one numbered version.
export async function openNote(space: SpaceRow, path: string, options: OpenOptions = {}): Promise<(NoteRow & { body: string; document: DocumentRow | null }) | null> {
    const params = new Params();
    const join = options.version
        ? `JOIN memory_note_versions v ON v.note_id = n.id AND v.version = ${params.add(options.version)}`
        : versionJoin(params, options);
    const note = await one<NoteRow & { body: string }>(
        `SELECT ${NOTE_COLUMNS}, v.body ${FROM_NOTES} ${join} WHERE n.space_id = ${params.add(space.id)} AND n.path = ${params.add(path)}`,
        params.values,
    );
    if (!note) return null;
    const document = await one<DocumentRow>('SELECT * FROM memory_documents WHERE note_id = $1', [note.id]);
    return { ...note, document };
}

export interface ListOptions extends Moment {
    // Only the notes under this folder.
    prefix?: string | null;
    kinds?: string[] | null;
    labels?: string[] | null;
    // Archived notes too.
    all?: boolean;
    limit: number;
    offset: number;
}

export interface Listing {
    notes: NoteRow[];
    folders: string[];
}

// The table of contents of some spaces, or of one folder in them: rules first, then by path. Folders are the
// next level down from the prefix, for an index that reads as a tree.
export async function listNotes(spaces: SpaceRow[], options: ListOptions): Promise<Listing> {
    if (!spaces.length) return { notes: [], folders: [] };
    const params = new Params();
    const prefix = options.prefix ? `${options.prefix.replace(/\/+$/, '')}/` : '';
    const where = [
        `n.space_id = ANY(${params.add(spaces.map((space) => space.id))}::uuid[])`,
        options.all && !options.asOf ? 'TRUE' : inUse(params, options),
        prefix ? `n.path LIKE ${params.add(likePrefix(prefix))}` : 'TRUE',
    ].join(' AND ');
    const notes = await query<NoteRow>(
        `SELECT ${NOTE_COLUMNS} ${FROM_NOTES} ${versionJoin(params, options)}
         WHERE ${where} ${kindFilter(params, options.kinds)} ${labelFilter(params, options.labels)}
         ORDER BY ${RULES_FIRST}, s.name, n.path
         LIMIT ${params.add(options.limit)} OFFSET ${params.add(options.offset)}`,
        params.values,
    );
    const folderParams = new Params();
    const folders = await query<{ folder: string }>(
        `SELECT DISTINCT split_part(substr(n.path, ${folderParams.add(prefix.length + 1)}), '/', 1) AS folder
         FROM memory_notes n WHERE n.space_id = ANY(${folderParams.add(spaces.map((space) => space.id))}::uuid[]) AND n.status = 'active'
           ${prefix ? `AND n.path LIKE ${folderParams.add(likePrefix(prefix))}` : ''}
           AND position('/' in substr(n.path, ${folderParams.add(prefix.length + 1)})) > 0
         ORDER BY folder`,
        folderParams.values,
    );
    return { notes, folders: folders.map((row) => (prefix ? `${prefix}${row.folder}` : row.folder)) };
}

export async function historyOf(space: SpaceRow, path: string): Promise<VersionRow[]> {
    return query<VersionRow>(
        `SELECT v.id, v.version, v.title, v.summary, v.body, v.written_by, v.change, v.created_at
         FROM memory_note_versions v JOIN memory_notes n ON n.id = v.note_id
         WHERE n.space_id = $1 AND n.path = $2 ORDER BY v.version`,
        [space.id, path],
    );
}

// Saying the same thing again moves its date forward and counts one more confirmation; labels sent are added.
export async function confirmNote(id: string, labels: string[] = []): Promise<NoteRow | null> {
    await query(
        `UPDATE memory_notes SET evidence_count = evidence_count + 1, updated_at = now(),
            labels = (SELECT ARRAY(SELECT DISTINCT l FROM unnest(labels || $2::text[]) AS t(l) ORDER BY l))[1:10]
         WHERE id = $1`,
        [id, normalizeLabels(labels)],
    );
    return loadNote(id, { withBody: true });
}

// Forgetting keeps the note and its history but stops it being used; delete removes it for good.
export async function archiveNote(id: string): Promise<NoteRow | null> {
    await query("UPDATE memory_notes SET status = 'archived', updated_at = now() WHERE id = $1 AND status = 'active'", [id]);
    return loadNote(id);
}

export async function deleteNote(space: SpaceRow, path: string): Promise<boolean> {
    const rows = await query<{ id: string }>('DELETE FROM memory_notes WHERE space_id = $1 AND path = $2 RETURNING id', [space.id, path]);
    if (rows.length) await pruneEntities([space.id]);
    return rows.length > 0;
}

// Everything that came from one source: a thread, a ticket, a document.
export async function deleteBySource(spaces: SpaceRow[], source: Source): Promise<number> {
    if (!spaces.length) return 0;
    const rows = await query<{ id: string }>(
        'DELETE FROM memory_notes WHERE space_id = ANY($1::uuid[]) AND source @> $2::jsonb RETURNING id',
        [spaces.map((space) => space.id), JSON.stringify({ type: source.type, id: source.id })],
    );
    if (rows.length) await pruneEntities(spaces.map((space) => space.id));
    return rows.length;
}

// Everything about one named thing, through the graph: every note whose current version names it or links it.
export async function deleteByEntity(spaces: SpaceRow[], name: string): Promise<number> {
    if (!spaces.length) return 0;
    const rows = await query<{ id: string }>(
        `DELETE FROM memory_notes n USING memory_note_versions v
         WHERE v.id = n.current_version_id AND n.space_id = ANY($1::uuid[])
           AND ($2 = ANY(v.names) OR EXISTS (SELECT 1 FROM memory_entity_links l WHERE l.version_id = v.id AND (l.subject = $2 OR l.object = $2)))
         RETURNING n.id`,
        [spaces.map((space) => space.id), name],
    );
    if (rows.length) await pruneEntities(spaces.map((space) => space.id));
    return rows.length;
}

// A node no version mentions any more is gone from the graph too.
export async function pruneEntities(spaceIds: string[]): Promise<void> {
    if (!spaceIds.length) return;
    await query(
        `DELETE FROM memory_entities e WHERE e.space_id = ANY($1::uuid[])
           AND NOT EXISTS (SELECT 1 FROM memory_note_entities ne WHERE ne.entity_id = e.id)`,
        [spaceIds],
    );
}

export async function upsertDocument(noteId: string, values: Partial<DocumentRow>, client?: Queryable): Promise<DocumentRow> {
    const row = await one<DocumentRow>(
        `INSERT INTO memory_documents (id, note_id, url, filename, mime, bytes, status, error, extracted_at)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'queued'), $8, $9)
         ON CONFLICT (note_id) DO UPDATE SET
            url = COALESCE(EXCLUDED.url, memory_documents.url),
            filename = COALESCE(EXCLUDED.filename, memory_documents.filename),
            mime = COALESCE(EXCLUDED.mime, memory_documents.mime),
            bytes = COALESCE(EXCLUDED.bytes, memory_documents.bytes),
            status = COALESCE($7, memory_documents.status),
            error = $8,
            extracted_at = COALESCE(EXCLUDED.extracted_at, memory_documents.extracted_at),
            updated_at = now()
         RETURNING *`,
        [randomUUID(), noteId, values.url ?? null, values.filename ?? null, values.mime ?? null, values.bytes ?? null, values.status ?? null, values.error ?? null, values.extracted_at ?? null],
        client,
    );
    return row as DocumentRow;
}

export { folderOf };
