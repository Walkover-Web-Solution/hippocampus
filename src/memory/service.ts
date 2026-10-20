import { ApiError } from '../error/api-error';
import { DocumentLoader } from '../service/document-loader';
import logger from '../service/logger';
import { MemoryAuth } from './auth';
import { memoryConfig } from './config';
import { generatedPath, normalizeKind, normalizePath, normalizeSpace } from './paths';
import {
    presentChange, presentConnection, presentDocument, presentEntity, presentHit, presentNote, presentSave, presentVersion,
} from './present';
import { MemoryJob, publishMemoryJob } from './queue';
import { normalizeEntityName, normalizeLabels, normalizeRelations, normalizeSlot, normalizeTypedEntities, PRIVATE_DETAIL } from './text';
import { indexVersion } from './store/indexer';
import { entityNode, listEntities } from './store/graph';
import { IndexFn, IndexState, learn, learnFromFeedback, remember } from './store/learn';
import {
    applyEdits, archiveNote, deleteByEntity, deleteBySource, deleteNote, EditOp, findNote, historyOf, listNotes, loadNote, openNote, upsertDocument, writeNote,
} from './store/notes';
import { DEFAULT_TOP_K, MAX_TOP_K, recall } from './store/search';
import { deleteSpace, ensureSpace, findSpace, listSpaces, resolveSpaces } from './store/spaces';
import { FeedbackOutcome, Links, NOTE_KINDS, NoteRow, Source, SpaceRow, Tenant } from './types';

/**
 * The six verbs an agent gets, over HTTP, as MCP tools and as function definitions: index, open, search, entity,
 * write/edit/learn, delete. Every call carries the token's tenant and grants, and every store query is limited to
 * the spaces resolved from them here, never from the request body.
 */
const DEFAULT_LIST = 100;
const MAX_LIST = 500;
const MAX_BODY_CHARS = 2_000_000;

const clamp = (value: number | undefined, fallback: number, max: number): number => Math.min(Math.max(Math.trunc(value ?? fallback) || fallback, 1), max);
const toDate = (value: unknown): Date | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    const date = new Date(value as string);
    if (Number.isNaN(date.getTime())) throw new ApiError(`Invalid date "${String(value)}"`, 400);
    return date;
};
const toSource = (value: unknown): Source | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const source = value as Record<string, unknown>;
    if (typeof source.type !== 'string' || typeof source.id !== 'string' || !source.type || !source.id) throw new ApiError('A source is { "type": "...", "id": "..." }', 400);
    return { type: source.type.slice(0, 64), id: source.id.slice(0, 512) };
};
const toLinks = (entities: unknown, relations: unknown): Links | null => {
    if (entities === undefined && relations === undefined) return null;
    return {
        entities: normalizeTypedEntities(Array.isArray(entities) ? entities.map((entity) => (typeof entity === 'string' ? { name: entity } : entity)) : []),
        relations: normalizeRelations(Array.isArray(relations) ? relations : []),
    };
};

// Indexing follows every write: inside the request for a short body, by the consumer for a long one. When the
// broker is down the work is done inline anyway, and when inline indexing fails it is queued for the consumer.
export const indexAfterWrite: IndexFn = async (note: NoteRow, links?: Links | null): Promise<IndexState> => {
    const inline = (note.body?.length ?? 0) <= memoryConfig.inlineIndexChars;
    const job: MemoryJob = { type: 'index', version_id: note.version_id, links: links ?? null };
    if (!inline) {
        try {
            await publishMemoryJob(job);
            return 'queued';
        } catch (error: any) {
            logger.error(`[MEMORY](queue) index job not published, indexing inline: ${error?.message}`);
        }
    }
    try {
        await indexVersion(note.version_id, links);
        return 'indexed';
    } catch (error: any) {
        logger.error(`[MEMORY](index) ${note.space}/${note.path}: ${error?.message}`);
        try {
            await publishMemoryJob(job);
            return 'queued';
        } catch {
            return 'failed';
        }
    }
};

const spaceOf = async (auth: MemoryAuth, name: unknown, access: 'read' | 'write'): Promise<SpaceRow | null> => {
    const space = auth.grants.require(normalizeSpace(name), access);
    return access === 'write' ? ensureSpace(auth.tenant, space) : findSpace(auth.tenant, space);
};

const spacesOf = (auth: MemoryAuth, names: unknown, access: 'read' | 'write'): Promise<SpaceRow[]> => {
    const list = Array.isArray(names) ? names : (typeof names === 'string' && names ? [names] : undefined);
    return resolveSpaces(auth.tenant, auth.grants, list, access);
};

export const memoryService = {
    // What is there: the spaces the token reaches.
    async spaces(auth: MemoryAuth) {
        const spaces = await listSpaces(auth.tenant, auth.grants, 'read');
        return { spaces: spaces.map((space) => ({ name: space.name, access: auth.grants.accessTo(space.name), notes: space.notes, updated_at: space.updated_at })) };
    },

    // index(space, path?): the table of contents of a space or a folder in it.
    async index(auth: MemoryAuth, input: { space?: unknown; spaces?: unknown; path?: unknown; as_of?: unknown; kind?: unknown; labels?: unknown; all?: unknown; limit?: unknown; offset?: unknown }) {
        const spaces = await spacesOf(auth, input.spaces ?? input.space, 'read');
        const prefix = input.path ? normalizePath(input.path) : null;
        const listing = await listNotes(spaces, {
            prefix,
            asOf: toDate(input.as_of) ?? null,
            kinds: input.kind ? [normalizeKind(input.kind)] : null,
            labels: normalizeLabels(input.labels),
            all: input.all === true || input.all === 'true',
            limit: clamp(Number(input.limit), DEFAULT_LIST, MAX_LIST),
            offset: Math.max(Number(input.offset) || 0, 0),
        });
        return { spaces: spaces.map((space) => space.name), path: prefix, folders: listing.folders, notes: listing.notes.map((note) => presentNote(note)) };
    },

    // open(path, as_of?): one note with its body, as it is or as it was.
    async open(auth: MemoryAuth, input: { space: unknown; path: unknown; as_of?: unknown; version?: unknown }) {
        const path = normalizePath(input.path);
        const space = await spaceOf(auth, input.space, 'read');
        const note = space ? await openNote(space, path, { asOf: toDate(input.as_of) ?? null, version: input.version ? Number(input.version) : null }) : null;
        if (!note) throw new ApiError(`No note at "${normalizeSpace(input.space)}/${path}"`, 404);
        return { note: { ...presentNote(note, true), document: presentDocument(note.document) } };
    },

    async history(auth: MemoryAuth, input: { space: unknown; path: unknown }) {
        const path = normalizePath(input.path);
        const space = await spaceOf(auth, input.space, 'read');
        const versions = space ? await historyOf(space, path) : [];
        if (!versions.length) throw new ApiError(`No note at "${normalizeSpace(input.space)}/${path}"`, 404);
        return { space: space?.name, path, versions: versions.map((version) => presentVersion(version)) };
    },

    // search(query, spaces?, as_of?): notes by meaning, words and names, with a ready prompt block.
    async search(auth: MemoryAuth, input: { query: unknown; spaces?: unknown; space?: unknown; kinds?: unknown; labels?: unknown; as_of?: unknown; top_k?: unknown; max_distance?: unknown; prompt?: unknown }) {
        const query = typeof input.query === 'string' ? input.query.trim() : '';
        if (!query) throw new ApiError('"query" is required', 400);
        const spaces = await spacesOf(auth, input.spaces ?? input.space, 'read');
        const kinds = Array.isArray(input.kinds) ? input.kinds.map(normalizeKind) : (typeof input.kinds === 'string' ? [normalizeKind(input.kinds)] : null);
        const result = await recall({
            spaces,
            query,
            kinds,
            labels: normalizeLabels(input.labels),
            asOf: toDate(input.as_of) ?? null,
            topK: clamp(Number(input.top_k), DEFAULT_TOP_K, MAX_TOP_K),
            maxDistance: typeof input.max_distance === 'number' ? input.max_distance : undefined,
            withPrompt: input.prompt !== false,
        });
        return {
            prompt: result.prompt,
            rules: result.rules.map((rule) => presentNote(rule, true)),
            results: result.hits.map(presentHit),
            connections: result.connections.map(presentConnection),
            lessons: result.lessons.map(presentHit),
        };
    },

    async entities(auth: MemoryAuth, input: { spaces?: unknown; space?: unknown; q?: unknown; limit?: unknown; offset?: unknown }) {
        const spaces = await spacesOf(auth, input.spaces ?? input.space, 'read');
        const entities = await listEntities(spaces, {
            q: typeof input.q === 'string' ? input.q : null, limit: clamp(Number(input.limit), DEFAULT_LIST, MAX_LIST), offset: Math.max(Number(input.offset) || 0, 0),
        });
        return { entities };
    },

    // entity(name, as_of?): everything about one named thing, and where to go next.
    async entity(auth: MemoryAuth, input: { name: unknown; spaces?: unknown; space?: unknown; as_of?: unknown; limit?: unknown }) {
        const name = typeof input.name === 'string' ? normalizeEntityName(input.name) : null;
        if (!name) throw new ApiError('"name" is required', 400);
        const spaces = await spacesOf(auth, input.spaces ?? input.space, 'read');
        const node = await entityNode(spaces, name, { asOf: toDate(input.as_of) ?? null, limit: input.limit ? Number(input.limit) : undefined });
        if (!node) throw new ApiError(`Nothing is remembered about "${name}"`, 404);
        return { entity: presentEntity(node) };
    },

    // write(path, body): the whole note, as a new version. Create or replace.
    async write(auth: MemoryAuth, input: Record<string, unknown>) {
        // Everything in the request is checked before the space is looked up or made.
        const body = typeof input.body === 'string' ? input.body : (typeof input.text === 'string' ? input.text : null);
        if (body === null) throw new ApiError('"body" is required', 400);
        if (body.length > MAX_BODY_CHARS) throw new ApiError(`The body is longer than ${MAX_BODY_CHARS} characters`, 400);
        const kind = input.kind !== undefined ? normalizeKind(input.kind) : undefined;
        const slot = kind === NOTE_KINDS.RULE && typeof input.slot === 'string' ? normalizeSlot(input.slot) : undefined;
        const path = input.path ? normalizePath(input.path) : (slot ? `rules/${slot}` : generatedPath(kind ?? NOTE_KINDS.NOTE, typeof input.title === 'string' && input.title ? input.title : body));
        const space = await spaceOf(auth, input.space, 'write') as SpaceRow;
        const result = await writeNote(auth.caller, {
            space,
            path,
            body,
            title: typeof input.title === 'string' ? input.title.slice(0, 300) : (input.title === null ? null : undefined),
            kind,
            slot: slot === undefined && input.slot === null ? null : slot,
            labels: input.labels === undefined ? undefined : normalizeLabels(input.labels),
            validFrom: toDate(input.valid_from) ?? undefined,
            validTo: toDate(input.valid_to),
            source: toSource(input.source),
            confidence: typeof input.confidence === 'number' ? input.confidence : undefined,
            ifVersion: typeof input.if_version === 'number' ? input.if_version : undefined,
            change: 'write',
        });
        const indexed = await indexAfterWrite(result.note, toLinks(input.entities, input.relations));
        return { created: result.created, note: presentNote(result.note, true), indexed };
    },

    // remember(text): one memory merged with what the space knows: a repeat confirms, a change replaces, else added.
    async remember(auth: MemoryAuth, input: Record<string, unknown>) {
        const text = typeof input.text === 'string' ? input.text.trim() : (typeof input.body === 'string' ? input.body.trim() : '');
        if (!text) throw new ApiError('"text" is required', 400);
        if (text.length > MAX_BODY_CHARS) throw new ApiError(`The text is longer than ${MAX_BODY_CHARS} characters`, 400);
        if (input.guard !== false && PRIVATE_DETAIL.test(text)) {
            throw new ApiError('Not saved: memory never keeps email addresses, phone numbers, card numbers or other long numbers. Send guard: false to save it anyway.', 400);
        }
        const path = input.path ? normalizePath(input.path) : null;
        const space = await spaceOf(auth, input.space, 'write') as SpaceRow;
        const result = await remember(auth.caller, {
            space,
            kind: typeof input.kind === 'string' ? input.kind : NOTE_KINDS.FACT,
            text,
            title: typeof input.title === 'string' ? input.title.slice(0, 300) : undefined,
            slot: typeof input.slot === 'string' ? input.slot : undefined,
            labels: normalizeLabels(input.labels),
            validTo: toDate(input.valid_to) ?? null,
            source: toSource(input.source) ?? null,
            confidence: typeof input.confidence === 'number' ? input.confidence : null,
            path,
            links: toLinks(input.entities, input.relations),
            merge: input.merge !== false,
            change: 'remember',
        }, indexAfterWrite);
        return presentSave(result);
    },

    // edit(path, ops, if_version): change part of a note in place; each edit is its own version.
    async edit(auth: MemoryAuth, input: Record<string, unknown>) {
        const path = normalizePath(input.path);
        const space = await spaceOf(auth, input.space, 'write') as SpaceRow;
        const current = await findNote(space, path);
        if (!current) throw new ApiError(`No note at "${space.name}/${path}"`, 404);
        const ops = Array.isArray(input.ops) ? input.ops as EditOp[] : [];
        const metadataOnly = !ops.length && input.title === undefined && input.body === undefined;
        let body: string | undefined;
        if (!metadataOnly) {
            const opened = await openNote(space, path);
            body = typeof input.body === 'string' ? input.body : applyEdits(opened?.body ?? '', ops);
        }
        const result = await writeNote(auth.caller, {
            space,
            path,
            body: body ?? (await openNote(space, path))?.body ?? '',
            title: typeof input.title === 'string' ? input.title.slice(0, 300) : (input.title === null ? null : undefined),
            kind: input.kind !== undefined ? normalizeKind(input.kind) : undefined,
            slot: input.slot === undefined ? undefined : (typeof input.slot === 'string' ? normalizeSlot(input.slot) : null),
            labels: input.labels === undefined ? undefined : normalizeLabels(input.labels),
            validTo: toDate(input.valid_to),
            source: toSource(input.source),
            ifVersion: typeof input.if_version === 'number' ? input.if_version : undefined,
            change: metadataOnly ? 'edit-metadata' : 'edit',
        });
        const indexed = metadataOnly ? 'indexed' : await indexAfterWrite(result.note, toLinks(input.entities, input.relations));
        return { note: presentNote(result.note, true), indexed };
    },

    // learn(messages, space): extraction as one writer; what is learned lands as notes like any other.
    async learn(auth: MemoryAuth, input: Record<string, unknown>) {
        const space = await spaceOf(auth, input.space, 'write') as SpaceRow;
        const sharedSpace = input.shared_space ? await spaceOf(auth, input.shared_space, 'write') : null;
        let text: string;
        let rulesAllowed = input.rules_allowed !== false;
        if (Array.isArray(input.messages)) {
            const messages = input.messages as Array<{ role: string; content: string }>;
            text = messages.map((message) => `${message.role}: ${message.content}`).join('\n');
            // Rules come only from the user: a transcript with no "user" line teaches facts only.
            rulesAllowed = rulesAllowed && messages.some((message) => String(message.role).trim().toLowerCase() === 'user');
        } else if (typeof input.text === 'string') {
            text = input.text;
        } else {
            throw new ApiError('"messages" or "text" is required', 400);
        }
        const source = toSource(input.source) ?? null;
        if (input.async === true) {
            try {
                await publishMemoryJob({
                    type: 'learn', tenant: auth.tenant, caller: auth.caller, space: space.name, shared_space: sharedSpace?.name ?? null, text, source, rules_allowed: rulesAllowed,
                });
                return { queued: true };
            } catch (error: any) {
                logger.error(`[MEMORY](queue) learn job not published, learning inline: ${error?.message}`);
            }
        }
        const result = await learn(auth.caller, { space, sharedSpace, text, source, rulesAllowed }, indexAfterWrite);
        return { queued: false, changes: result.changes.map(presentChange), skipped: result.skipped, failed: result.failed };
    },

    async feedback(auth: MemoryAuth, input: Record<string, unknown>) {
        const space = await spaceOf(auth, input.space, 'write') as SpaceRow;
        const outcome = input.outcome as FeedbackOutcome;
        if (!['good', 'bad', 'corrected'].includes(outcome)) throw new ApiError('"outcome" must be good, bad or corrected', 400);
        if (typeof input.task !== 'string' || typeof input.output !== 'string' || !input.task.trim() || !input.output.trim()) throw new ApiError('"task" and "output" are required', 400);
        const changes = await learnFromFeedback(auth.caller, space, {
            task: input.task, output: input.output, outcome, correction: typeof input.correction === 'string' ? input.correction : undefined, note: typeof input.note === 'string' ? input.note : undefined,
        }, toSource(input.source) ?? null, indexAfterWrite);
        return { changes: changes.map(presentChange) };
    },

    // delete(path | space | name | source): forgetting, with nothing derived left behind.
    async deleteNote(auth: MemoryAuth, input: { space: unknown; path: unknown; archive?: unknown }) {
        const path = normalizePath(input.path);
        const space = await spaceOf(auth, input.space, 'write') as SpaceRow;
        if (input.archive === true) {
            const current = await findNote(space, path);
            if (!current) throw new ApiError(`No note at "${space.name}/${path}"`, 404);
            const note = await archiveNote(current.id);
            return { archived: true, note: note ? presentNote(note) : null };
        }
        const deleted = await deleteNote(space, path);
        if (!deleted) throw new ApiError(`No note at "${space.name}/${path}"`, 404);
        return { deleted: 1 };
    },

    async deleteSpace(auth: MemoryAuth, input: { space: unknown }) {
        const name = auth.grants.require(normalizeSpace(input.space), 'write');
        const space = await findSpace(auth.tenant, name);
        if (!space) return { space: name, deleted: 0 };
        return { space: name, deleted: await deleteSpace(space) };
    },

    async forgetEntity(auth: MemoryAuth, input: { name: unknown; spaces?: unknown; space?: unknown }) {
        const name = typeof input.name === 'string' ? normalizeEntityName(input.name) : null;
        if (!name) throw new ApiError('"name" is required', 400);
        const spaces = await spacesOf(auth, input.spaces ?? input.space, 'write');
        return { name, deleted: await deleteByEntity(spaces, name) };
    },

    async forgetSource(auth: MemoryAuth, input: { type: unknown; id: unknown; spaces?: unknown; space?: unknown }) {
        const source = toSource({ type: input.type, id: input.id }) as Source;
        const spaces = await spacesOf(auth, input.spaces ?? input.space, 'write');
        return { source, deleted: await deleteBySource(spaces, source) };
    },

    // A document is a long note: given as text, or loaded from a url by the consumer and then indexed in chunks.
    async addDocument(auth: MemoryAuth, input: Record<string, unknown>) {
        const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : null;
        const content = typeof input.content === 'string' ? input.content : (typeof input.body === 'string' ? input.body : null);
        if (!url && content === null) throw new ApiError('"url" or "content" is required', 400);
        if (url) {
            try {
                new URL(url); // eslint-disable-line no-new
            } catch {
                throw new ApiError(`Invalid url "${url}"`, 400);
            }
        }
        const title = typeof input.title === 'string' ? input.title.slice(0, 300) : (url ? url.slice(0, 300) : null);
        const path = input.path ? normalizePath(input.path) : generatedPath(NOTE_KINDS.DOC, title ?? content ?? 'document');
        const space = await spaceOf(auth, input.space, 'write') as SpaceRow;
        const result = await writeNote(auth.caller, {
            space,
            path,
            body: content ?? '',
            title,
            kind: typeof input.kind === 'string' ? normalizeKind(input.kind) : NOTE_KINDS.DOC,
            labels: input.labels === undefined ? undefined : normalizeLabels(input.labels),
            source: toSource(input.source) ?? (url ? { type: 'url', id: url } : undefined),
            change: 'document',
        });
        if (!url) {
            const indexed = await indexAfterWrite(result.note, null);
            const document = await upsertDocument(result.note.id, { bytes: Buffer.byteLength(content ?? ''), status: indexed === 'indexed' ? 'indexed' : (indexed === 'queued' ? 'indexing' : 'error'), extracted_at: new Date() });
            return { note: presentNote(result.note), document: presentDocument(document) };
        }
        let document = await upsertDocument(result.note.id, { url, status: 'queued' });
        try {
            await publishMemoryJob({ type: 'document', note_id: result.note.id, url });
        } catch (error: any) {
            logger.error(`[MEMORY](queue) document job not published, loading inline: ${error?.message}`);
            document = await loadDocument(result.note.id, url);
        }
        return { note: presentNote(result.note), document: presentDocument(document) };
    },
};

// The consumer's half of a document: fetch the url with the loaders (page, PDF, Google Doc, YouTube), save the
// text as the note's next version, index it, and record the outcome on the document.
export async function loadDocument(noteId: string, url: string) {
    const note = await loadNote(noteId);
    if (!note) throw new ApiError(`Document note ${noteId} no longer exists`, 404);
    await upsertDocument(noteId, { status: 'loading' });
    try {
        const content = await new DocumentLoader().getContent(url);
        if (!content?.trim()) throw new Error('The url gave no text');
        const space: SpaceRow = { id: note.space_id, name: note.space };
        const result = await writeNote(note.written_by, { space, path: note.path, body: content, change: 'document' });
        await indexVersion(result.note.version_id, null);
        return upsertDocument(noteId, { status: 'indexed', bytes: Buffer.byteLength(content), extracted_at: new Date(), error: null });
    } catch (error: any) {
        logger.error(`[MEMORY](document) ${url}: ${error?.message}`);
        return upsertDocument(noteId, { status: 'error', error: String(error?.message ?? error).slice(0, 1000) });
    }
}

// Learning queued by a request, run by the consumer.
export async function learnFromJob(job: Extract<MemoryJob, { type: 'learn' }>) {
    const tenant: Tenant = job.tenant;
    const space = await ensureSpace(tenant, job.space);
    const sharedSpace = job.shared_space ? await ensureSpace(tenant, job.shared_space) : null;
    return learn(job.caller, { space, sharedSpace, text: job.text, source: job.source ?? null, rulesAllowed: job.rules_allowed !== false }, indexAfterWrite);
}
