import { randomUUID } from 'crypto';
import logger from '../../service/logger';
import { chunkText, firstSentence } from '../chunker';
import { one, Params, query, toVector, withTransaction } from '../db';
import { embedder } from '../embedder';
import { models } from '../llm';
import { extractNamedEntities, extractNames, normalizeNames, normalizeRelations, normalizeTypedEntities } from '../text';
import { Links, NOTE_KINDS } from '../types';
import { knownEntities } from './graph';

/**
 * The job that runs after every saved version. It never changes the note: chunks and embeddings, the one-line
 * summary, the names and links all derive from the version's body, and all of it can be rebuilt from the versions
 * alone. Links the writer already knows (the extractor returns them with each memory) are used instead of a model
 * call.
 */
interface VersionToIndex {
    id: string;
    note_id: string;
    space_id: string;
    kind: string;
    title: string | null;
    body: string;
}

export async function indexVersion(versionId: string, given?: Links | null): Promise<boolean> {
    const row = await one<VersionToIndex>(
        'SELECT v.id, v.note_id, n.space_id, n.kind, v.title, v.body FROM memory_note_versions v JOIN memory_notes n ON n.id = v.note_id WHERE v.id = $1',
        [versionId],
    );
    if (!row) return false;
    const body = row.body.trim();
    const chunks = chunkText(body);
    const embeddings = chunks.length ? await embedder.embed(chunks.map((chunk) => chunk.text)) : [];
    const summary = chunks.length > 1 ? await models.summarize(row.title, body) : firstSentence(body);
    // Lessons are general and name nothing; an empty body has nothing to link.
    const links = given ?? (row.kind === NOTE_KINDS.LESSON || !body
        ? { entities: [], relations: [] }
        : await models.link(body, await knownEntities([{ id: row.space_id, name: '' }])));
    const entities = normalizeTypedEntities([...links.entities, ...extractNamedEntities(body)]);
    const relations = normalizeRelations(links.relations);
    // Every name worth matching: the graph's nodes, both ends of every link, and the capitalised words in the text.
    const names = normalizeNames([...entities.map((entity) => entity.name), ...relations.flatMap((relation) => [relation.subject, relation.object]), ...extractNames(body)]);

    await withTransaction(async (client) => {
        await client.query('DELETE FROM memory_chunks WHERE version_id = $1', [row.id]);
        if (chunks.length) {
            const params = new Params();
            const values = chunks.map((chunk, i) => `(${params.add(randomUUID())}, ${params.add(row.id)}, ${params.add(row.note_id)}, ${params.add(row.space_id)}, ${params.add(chunk.ordinal)}, ${params.add(chunk.text)}, ${params.add(toVector(embeddings[i]))}::vector, ${params.add(embedder.model)})`);
            await client.query(`INSERT INTO memory_chunks (id, version_id, note_id, space_id, ordinal, text, embedding, embedding_model) VALUES ${values.join(', ')}`, params.values);
        }
        await client.query('UPDATE memory_note_versions SET summary = $2, names = $3::text[], indexed_at = now() WHERE id = $1', [row.id, summary, names]);

        await client.query('DELETE FROM memory_note_entities WHERE version_id = $1', [row.id]);
        if (entities.length) {
            const params = new Params();
            const values = entities.map((entity) => `(${params.add(randomUUID())}, ${params.add(row.space_id)}, ${params.add(entity.name)}, ${params.add(entity.type)})`);
            const rows = await client.query(
                `INSERT INTO memory_entities (id, space_id, name, type) VALUES ${values.join(', ')}
                 ON CONFLICT (space_id, name) DO UPDATE SET updated_at = now(),
                    type = CASE WHEN memory_entities.type = 'other' THEN EXCLUDED.type ELSE memory_entities.type END
                 RETURNING id`,
                params.values,
            );
            const ids = rows.rows.map((entity: { id: string }) => entity.id);
            await client.query('INSERT INTO memory_note_entities (version_id, entity_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING', [row.id, ids]);
        }
        await client.query('DELETE FROM memory_entity_links WHERE version_id = $1', [row.id]);
        if (relations.length) {
            const params = new Params();
            const values = relations.map((relation) => `(${params.add(randomUUID())}, ${params.add(row.id)}, ${params.add(row.note_id)}, ${params.add(row.space_id)}, ${params.add(relation.subject)}, ${params.add(relation.relation)}, ${params.add(relation.object)})`);
            await client.query(`INSERT INTO memory_entity_links (id, version_id, note_id, space_id, subject, relation, object) VALUES ${values.join(', ')}`, params.values);
        }
    });
    return true;
}

// Rebuilds the index of every current version in some spaces (or of a tenant), oldest first. Used after a change
// of embedding model, and to repair anything a failed job left behind.
export async function reindexVersions(versionIds: string[]): Promise<{ indexed: number; failed: number }> {
    let indexed = 0;
    let failed = 0;
    for (const versionId of versionIds) {
        try {
            if (await indexVersion(versionId)) indexed += 1;
        } catch (error: any) {
            failed += 1;
            logger.error(`[MEMORY](reindex) ${versionId}: ${error?.message}`);
        }
    }
    return { indexed, failed };
}

export async function currentVersionIds(filter: { spaceIds?: string[]; issuer?: string; orgId?: string; projectId?: string; staleModel?: string }): Promise<string[]> {
    const params = new Params();
    const where = ['n.current_version_id IS NOT NULL'];
    if (filter.spaceIds?.length) where.push(`n.space_id = ANY(${params.add(filter.spaceIds)}::uuid[])`);
    if (filter.issuer) where.push(`s.issuer = ${params.add(filter.issuer)}`);
    if (filter.orgId) where.push(`s.org_id = ${params.add(filter.orgId)}`);
    if (filter.projectId) where.push(`s.project_id = ${params.add(filter.projectId)}`);
    if (filter.staleModel) {
        where.push(`NOT EXISTS (SELECT 1 FROM memory_chunks c WHERE c.version_id = n.current_version_id AND c.embedding_model = ${params.add(filter.staleModel)})`);
    }
    const rows = await query<{ id: string }>(
        `SELECT n.current_version_id AS id FROM memory_notes n JOIN memory_spaces s ON s.id = n.space_id WHERE ${where.join(' AND ')} ORDER BY n.updated_at`,
        params.values,
    );
    return rows.map((row) => row.id);
}
