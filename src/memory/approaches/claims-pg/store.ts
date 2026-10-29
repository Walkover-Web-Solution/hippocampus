import { createHash } from 'crypto';
import { Pool } from 'pg';
import { Scope } from '../../core/types';
import { ClaimStatus, StreamHead, WriteDecision, decideWrite } from './decide';

// Append-only claim log in Postgres. Each event carries the stream's full state after the event,
// so the current state is simply the latest version of each stream (the claims_current view).

const DDL = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS entities (
    id text PRIMARY KEY,
    kind text NOT NULL,
    name text NOT NULL
);
CREATE TABLE IF NOT EXISTS entity_aliases (
    alias text PRIMARY KEY,
    entity_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS claim_events (
    event_id bigserial PRIMARY KEY,
    stream_id text NOT NULL,
    stream_version integer NOT NULL,
    scope text NOT NULL,
    subject_id text NOT NULL,
    subject_name text NOT NULL,
    predicate text NOT NULL,
    value text NOT NULL,
    value_norm text NOT NULL,
    value_entity text,
    status text NOT NULL,
    disputed_values text[] NOT NULL DEFAULT '{}',
    valid_from timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL,
    source_message_ids text[] NOT NULL,
    actor_person text NOT NULL,
    actor_agent text NOT NULL,
    evidence text NOT NULL,
    claim_text text NOT NULL,
    embedding vector,
    UNIQUE (stream_id, stream_version)
);
CREATE INDEX IF NOT EXISTS claim_events_subject ON claim_events (subject_id, predicate);
CREATE OR REPLACE VIEW claims_current AS
    SELECT DISTINCT ON (stream_id) * FROM claim_events ORDER BY stream_id, stream_version DESC;
`;

export interface ClaimRow {
    stream_id: string;
    stream_version: number;
    scope: Scope;
    subject_id: string;
    subject_name: string;
    predicate: string;
    value: string;
    value_norm: string;
    value_entity: string | null;
    status: ClaimStatus;
    disputed_values: string[];
    valid_from: Date;
    recorded_at: Date;
    source_message_ids: string[];
    actor_person: string;
    claim_text: string;
    score?: number;
}

export interface ClaimWrite {
    scope: Scope;
    subjectId: string;
    subjectName: string;
    predicate: string;
    cardinality: 'single' | 'multi';
    value: string;
    valueNorm: string;
    valueEntity: string | null;
    operation: 'assert' | 'retract';
    proposed: boolean;
    validFrom: Date;
    recordedAt: Date;
    sourceMessageId: string;
    actorPerson: string;
    actorAgent: string;
    evidence: string;
    // Renders the claim text for a given status/value set (disputes list every contender).
    render: (status: ClaimStatus, disputedValues: string[]) => string;
    embed: (text: string) => Promise<number[]>;
}

const COLUMNS = `stream_id, stream_version, scope, subject_id, subject_name, predicate, value, value_norm, value_entity,
    status, disputed_values, valid_from, recorded_at, source_message_ids, actor_person, claim_text`;

const short = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const vectorLiteral = (v: number[]) => `[${v.join(',')}]`;

export function streamId(write: Pick<ClaimWrite, 'scope' | 'subjectId' | 'predicate' | 'cardinality' | 'valueNorm' | 'proposed'>): string {
    const base = `${write.scope}|${write.subjectId}|${write.predicate}`;
    // Proposed claims live in their own streams so they can never displace a confirmed value.
    if (write.proposed) return `${base}|proposed|${short(write.valueNorm)}`;
    return write.cardinality === 'multi' ? `${base}|${short(write.valueNorm)}` : base;
}

// Each variant gets its own schema, so variants can run side by side without resetting each other.
export function openClaimStore(connectionString: string, schema = 'public'): { store: ClaimStore; close: () => Promise<void> } {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Invalid schema name ${schema}`);
    const pool = new Pool({ connectionString, max: 5, options: `-c search_path=${schema},public` });
    return { store: new ClaimStore(pool, schema), close: () => pool.end() };
}

export class ClaimStore {
    constructor(private pool: Pool, private schema = 'public') {}

    async init() {
        await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
        await this.pool.query(DDL);
    }

    async reset() {
        await this.pool.query('TRUNCATE claim_events, entity_aliases, entities RESTART IDENTITY CASCADE');
    }

    // ---- entities ----

    async findEntity(alias: string): Promise<{ id: string; name: string } | null> {
        const { rows } = await this.pool.query(
            'SELECT e.id, e.name FROM entity_aliases a JOIN entities e ON e.id = a.entity_id WHERE a.alias = $1',
            [alias]
        );
        return rows[0] ?? null;
    }

    async upsertEntity(id: string, kind: string, name: string, aliases: string[]) {
        await this.pool.query('INSERT INTO entities (id, kind, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [id, kind, name]);
        for (const alias of aliases) {
            await this.pool.query('INSERT INTO entity_aliases (alias, entity_id) VALUES ($1, $2) ON CONFLICT (alias) DO NOTHING', [alias, id]);
        }
    }

    // Entities that appear in claims of the given scopes, so prompts never show names from scopes the
    // caller can't access (other teams, other people's personal memory).
    async addAlias(alias: string, entityId: string) {
        await this.pool.query('INSERT INTO entity_aliases (alias, entity_id) VALUES ($1, $2) ON CONFLICT (alias) DO NOTHING', [alias, entityId]);
    }

    async listEntities(scopes: string[]): Promise<{ id: string; kind: string; name: string }[]> {
        const { rows } = await this.pool.query(
            `SELECT DISTINCT e.id, e.kind, e.name FROM entities e
             JOIN claim_events c ON c.subject_id = e.id OR c.value_entity = e.id
             WHERE c.scope = ANY($1) ORDER BY e.name`,
            [scopes]
        );
        return rows;
    }

    // ---- writes ----

    // Version-checked append: two writers that read the same head can't both win; the loser retries
    // against the new head (which is how racing contradictions become "disputed").
    async append(write: ClaimWrite): Promise<WriteDecision> {
        const id = streamId(write);
        for (let attempt = 0; attempt < 5; attempt++) {
            const client = await this.pool.connect();
            try {
                await client.query('BEGIN');
                const { rows } = await client.query(
                    `SELECT ${COLUMNS} FROM claim_events WHERE stream_id = $1 ORDER BY stream_version DESC LIMIT 1`,
                    [id]
                );
                const row: ClaimRow | undefined = rows[0];
                const head: StreamHead | null = row
                    ? {
                        version: row.stream_version,
                        status: row.status,
                        valueNorm: row.value_norm,
                        disputedValues: row.disputed_values,
                        actorPerson: row.actor_person,
                        recordedAt: row.recorded_at,
                    }
                    : null;
                const decision = decideWrite(
                    head,
                    { valueNorm: write.valueNorm, operation: write.operation, proposed: write.proposed, actorPerson: write.actorPerson, recordedAt: write.recordedAt },
                    write.cardinality
                );
                if (decision.kind === 'noop') {
                    await client.query('COMMIT');
                    return decision;
                }

                const disputed = decision.status === 'disputed';
                const retracted = decision.status === 'retracted';
                const value = disputed ? decision.disputedValues.join(' | ') : retracted && row ? row.value : write.value;
                const valueNorm = disputed ? decision.disputedValues.join(' | ') : retracted && row ? row.value_norm : write.valueNorm;
                const sources = disputed && row ? [...new Set([...row.source_message_ids, write.sourceMessageId])] : [write.sourceMessageId];
                const text = write.render(decision.status, decision.disputedValues);
                const embedding = await write.embed(text);
                await client.query(
                    `INSERT INTO claim_events (stream_id, stream_version, scope, subject_id, subject_name, predicate, value, value_norm,
                        value_entity, status, disputed_values, valid_from, recorded_at, source_message_ids, actor_person, actor_agent,
                        evidence, claim_text, embedding)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::vector)`,
                    [
                        id, (head?.version ?? 0) + 1, write.scope, write.subjectId, write.subjectName, write.predicate, value, valueNorm,
                        write.valueEntity, decision.status, decision.disputedValues, write.validFrom, write.recordedAt, sources,
                        write.actorPerson, write.actorAgent, write.evidence, text, vectorLiteral(embedding),
                    ]
                );
                await client.query('COMMIT');
                return decision;
            } catch (error: any) {
                await client.query('ROLLBACK').catch(() => undefined);
                if (error?.code === '23505') continue; // someone else appended to this stream first: re-read and retry
                throw error;
            } finally {
                client.release();
            }
        }
        throw new Error(`Gave up appending to stream ${id} after repeated conflicts`);
    }

    // ---- reads ----

    // Latest state of each stream, either now or as believed at `asOf` (recorded time).
    private headsSql(asOf: Date | null, where: string): string {
        const source = asOf
            ? `(SELECT DISTINCT ON (stream_id) * FROM claim_events WHERE recorded_at <= $1 ORDER BY stream_id, stream_version DESC)`
            : '(SELECT * FROM claims_current WHERE $1::timestamptz IS NULL)';
        return `SELECT ${COLUMNS} FROM ${source} h WHERE status <> 'retracted' AND ${where}`;
    }

    async heads(scopes: Scope[], asOf: Date | null, filter: { subjectIds?: string[]; valueEntities?: string[] } = {}): Promise<ClaimRow[]> {
        const params: unknown[] = [asOf, scopes];
        const clauses = ['scope = ANY($2)'];
        if (filter.subjectIds) {
            params.push(filter.subjectIds);
            clauses.push(`subject_id = ANY($${params.length})`);
        }
        if (filter.valueEntities) {
            params.push(filter.valueEntities);
            clauses.push(`value_entity = ANY($${params.length})`);
        }
        const { rows } = await this.pool.query(this.headsSql(asOf, clauses.join(' AND ')), params);
        return rows;
    }

    // Exact cosine scan over stream heads in the readable scopes (no ANN index: exact and deterministic).
    async nearest(scopes: Scope[], asOf: Date | null, embedding: number[], limit: number): Promise<ClaimRow[]> {
        const source = asOf
            ? `(SELECT DISTINCT ON (stream_id) * FROM claim_events WHERE recorded_at <= $1 ORDER BY stream_id, stream_version DESC)`
            : '(SELECT * FROM claims_current WHERE $1::timestamptz IS NULL)';
        const { rows } = await this.pool.query(
            `SELECT ${COLUMNS}, 1 - (embedding <=> $3::vector) AS score FROM ${source} h
             WHERE status <> 'retracted' AND scope = ANY($2)
             ORDER BY embedding <=> $3::vector LIMIT $4`,
            [asOf, scopes, vectorLiteral(embedding), limit]
        );
        return rows;
    }

    async streamExists(id: string): Promise<boolean> {
        const { rows } = await this.pool.query('SELECT 1 FROM claim_events WHERE stream_id = $1 LIMIT 1', [id]);
        return rows.length > 0;
    }

    async entityHasClaims(entityId: string): Promise<boolean> {
        const { rows } = await this.pool.query('SELECT 1 FROM claim_events WHERE subject_id = $1 OR value_entity = $1 LIMIT 1', [entityId]);
        return rows.length > 0;
    }

    // Point an alias at another entity (after Jev decided a new name is an existing entity).
    async remapAlias(alias: string, entityId: string) {
        await this.pool.query('UPDATE entity_aliases SET entity_id = $2 WHERE alias = $1', [alias, entityId]);
    }

    // Current claims with the same predicate in one scope, most similar first: candidates for "is this
    // new claim an update of an existing fact under another name?" (Zep-style edge invalidation).
    async similarHeads(scope: Scope, predicate: string, excludeStream: string, embedding: number[], limit: number): Promise<ClaimRow[]> {
        const { rows } = await this.pool.query(
            `SELECT ${COLUMNS}, 1 - (embedding <=> $4::vector) AS score FROM claims_current
             WHERE scope = $1 AND predicate = $2 AND stream_id <> $3 AND status IN ('current', 'disputed')
             ORDER BY embedding <=> $4::vector LIMIT $5`,
            [scope, predicate, excludeStream, vectorLiteral(embedding), limit]
        );
        return rows;
    }

    // Full-text search over claim text (OR of the query's words, ranked), for hybrid retrieval.
    async fullText(scopes: Scope[], asOf: Date | null, words: string[], limit: number): Promise<ClaimRow[]> {
        if (words.length === 0) return [];
        const source = asOf
            ? `(SELECT DISTINCT ON (stream_id) * FROM claim_events WHERE recorded_at <= $1 ORDER BY stream_id, stream_version DESC)`
            : '(SELECT * FROM claims_current WHERE $1::timestamptz IS NULL)';
        const { rows } = await this.pool.query(
            `SELECT ${COLUMNS}, ts_rank(to_tsvector('english', claim_text), q) AS score
             FROM ${source} h, to_tsquery('english', $3) q
             WHERE status <> 'retracted' AND scope = ANY($2) AND to_tsvector('english', claim_text) @@ q
             ORDER BY score DESC LIMIT $4`,
            [asOf, scopes, words.join(' | '), limit]
        );
        return rows;
    }

    // A few current facts about an entity, as context for entity matching (Zep-style entity summary).
    async entitySummary(entityId: string, scopes: Scope[], limit = 3): Promise<string> {
        const { rows } = await this.pool.query(
            `SELECT claim_text FROM claims_current WHERE subject_id = $1 AND scope = ANY($2) AND status IN ('current', 'disputed')
             ORDER BY recorded_at DESC LIMIT $3`,
            [entityId, scopes, limit]
        );
        return rows.map((r: { claim_text: string }) => r.claim_text.split(' — ')[0]).join('; ');
    }

    // The value a single-valued stream held before its current version (for "moved from X" context).
    async previousValue(streamIdValue: string, beforeVersion: number): Promise<ClaimRow | null> {
        const { rows } = await this.pool.query(
            `SELECT ${COLUMNS} FROM claim_events WHERE stream_id = $1 AND stream_version < $2 AND status IN ('current', 'disputed')
             ORDER BY stream_version DESC LIMIT 1`,
            [streamIdValue, beforeVersion]
        );
        return rows[0] ?? null;
    }
}
