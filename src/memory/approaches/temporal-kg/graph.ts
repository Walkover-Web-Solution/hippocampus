import neo4j, { Driver } from 'neo4j-driver';
import { Scope } from '../../core/types';

// Temporal knowledge graph in Neo4j (Graphiti-style). Entities are partitioned by scope; facts are
// RELATES_TO edges with a validity window. Contradicted facts get invalid_at/expired_at — nothing is
// ever deleted, so "what did we believe at T" stays answerable. Times are ISO strings (scenario time).

export interface EntityNode {
    uuid: string;
    scope: Scope;
    key: string;
    name: string;
    kind: string;
}

export interface FactEdge {
    uuid: string;
    name: string;
    fact: string;
    scope: Scope;
    status: 'current' | 'proposed' | 'disputed';
    valid_at: string | null;
    invalid_at: string | null;
    created_at: string;
    expired_at: string | null;
    episode_ids: string[];
    // Name of the person whose message stated the fact.
    author: string | null;
    source_name: string;
    target_name: string;
    source_uuid: string;
    target_uuid: string;
    score?: number;
}

export function openGraph(url: string, user: string, password: string): Graph {
    return new Graph(neo4j.driver(url, neo4j.auth.basic(user, password), { disableLosslessIntegers: true }));
}

const EDGE_FIELDS = `r.uuid AS uuid, r.name AS name, r.fact AS fact, r.scope AS scope, r.status AS status, r.valid_at AS valid_at,
    r.invalid_at AS invalid_at, r.created_at AS created_at, r.expired_at AS expired_at, r.episode_ids AS episode_ids,
    r.author AS author, a.name AS source_name, b.name AS target_name, a.uuid AS source_uuid, b.uuid AS target_uuid`;

// An edge is believed at time T if it was created by T, not yet expired at T, and, if it was stated as a
// temporary state ("out for lunch for 30 minutes": its end is later than when it was said), not over by T.
// An end before the statement is history being told ("the pilot ran until Sept 30") and stays visible.
const BELIEVED_AT = `r.created_at <= $at AND (r.expired_at IS NULL OR r.expired_at > $at)
    AND (r.invalid_at IS NULL OR r.invalid_at <= r.created_at OR r.invalid_at > $at)`;

export class Graph {
    constructor(private driver: Driver) {}

    private async run<T = any>(cypher: string, params: Record<string, unknown> = {}): Promise<T[]> {
        const { records } = await this.driver.executeQuery(cypher, params, { database: 'neo4j' });
        return records.map((r) => r.toObject() as T);
    }

    async init() {
        await this.run('CREATE CONSTRAINT entity_uuid IF NOT EXISTS FOR (e:Entity) REQUIRE e.uuid IS UNIQUE');
        await this.run('CREATE CONSTRAINT episode_id IF NOT EXISTS FOR (e:Episode) REQUIRE e.id IS UNIQUE');
        await this.run('CREATE INDEX entity_scope IF NOT EXISTS FOR (e:Entity) ON (e.scope)');
        await this.run('CREATE INDEX buffered_scope IF NOT EXISTS FOR (w:Buffered) ON (w.scope)');
        // Full-text (BM25-style) search over fact text, for hybrid retrieval.
        await this.run('CREATE FULLTEXT INDEX fact_text IF NOT EXISTS FOR ()-[r:RELATES_TO]-() ON EACH [r.fact]');
        // Full-text search over fact text plus its write-time expansions (questions, synonyms), with
        // stemming, for reads that skip the query embedding.
        await this.run(
            "CREATE FULLTEXT INDEX fact_search IF NOT EXISTS FOR ()-[r:RELATES_TO]-() ON EACH [r.search_text] OPTIONS {indexConfig: {`fulltext.analyzer`: 'english'}}"
        );
    }

    async reset() {
        await this.run('MATCH (n) DETACH DELETE n');
    }

    async close() {
        await this.driver.close();
    }

    // ---- entities ----

    async findEntity(scope: Scope, key: string): Promise<EntityNode | null> {
        const rows = await this.run<EntityNode>(
            `MATCH (e:Entity {scope: $scope}) WHERE e.key = $key OR $key IN e.aliases
             RETURN e.uuid AS uuid, e.scope AS scope, e.key AS key, e.name AS name, e.kind AS kind LIMIT 1`,
            { scope, key }
        );
        return rows[0] ?? null;
    }

    async similarEntities(scope: Scope, embedding: number[], min: number, limit: number): Promise<(EntityNode & { score: number })[]> {
        return this.run(
            `MATCH (e:Entity {scope: $scope})
             WITH e, vector.similarity.cosine(e.name_embedding, $embedding) AS score WHERE score >= $min
             RETURN e.uuid AS uuid, e.scope AS scope, e.key AS key, e.name AS name, e.kind AS kind, score
             ORDER BY score DESC LIMIT toInteger($limit)`,
            { scope, embedding, min, limit }
        );
    }

    async createEntity(entity: EntityNode, embedding: number[], aliases: string[]): Promise<void> {
        await this.run(
            `MERGE (e:Entity {uuid: $uuid})
             ON CREATE SET e.scope = $scope, e.key = $key, e.name = $name, e.kind = $kind, e.aliases = $aliases, e.name_embedding = $embedding`,
            { ...entity, embedding, aliases: [...new Set([entity.key, ...aliases])] }
        );
    }

    async addAlias(uuid: string, alias: string): Promise<void> {
        await this.run(
            `MATCH (e:Entity {uuid: $uuid}) WHERE NOT $alias IN e.aliases SET e.aliases = e.aliases + $alias`,
            { uuid, alias }
        );
    }

    async entitiesInScope(scope: Scope): Promise<(EntityNode & { aliases: string[] })[]> {
        return this.run(
            'MATCH (e:Entity {scope: $scope}) RETURN e.uuid AS uuid, e.scope AS scope, e.key AS key, e.name AS name, e.kind AS kind, e.aliases AS aliases',
            { scope }
        );
    }

    async entityNames(scopes: Scope[]): Promise<{ name: string; kind: string }[]> {
        return this.run(
            'MATCH (e:Entity) WHERE e.scope IN $scopes RETURN DISTINCT e.name AS name, e.kind AS kind ORDER BY name',
            { scopes }
        );
    }

    // Entities whose name or alias appears as whole words in the (normalized) text. With byWords, a
    // multi-word name also counts when all its words (of 3+ letters) appear anywhere in the text
    // ("Phoenix beta testers" in "how many testers will the Phoenix beta have").
    async entitiesMentioned(scopes: Scope[], normalizedText: string, byWords = false): Promise<string[]> {
        const rows = await this.run<{ uuid: string }>(
            `MATCH (e:Entity) WHERE e.scope IN $scopes AND any(k IN e.aliases WHERE size(k) > 1 AND (
                 $padded CONTAINS (' ' + k + ' ')
                 OR ($byWords AND size(split(k, ' ')) > 1 AND all(w IN split(k, ' ') WHERE size(w) < 3 OR $padded CONTAINS (' ' + w + ' ')))))
             RETURN e.uuid AS uuid`,
            { scopes, padded: ` ${normalizedText} `, byWords }
        );
        return rows.map((r) => r.uuid);
    }

    // ---- episodes and facts ----

    async addEpisode(id: string, scope: Scope, text: string, occurredAt: string, entityUuids: string[]): Promise<void> {
        await this.run(
            `MERGE (ep:Episode {id: $id}) ON CREATE SET ep.scope = $scope, ep.text = $text, ep.occurred_at = $occurredAt
             WITH ep UNWIND $entityUuids AS uuid MATCH (e:Entity {uuid: uuid}) MERGE (ep)-[:MENTIONS]->(e)`,
            { id, scope, text, occurredAt, entityUuids }
        );
    }

    // Facts a new fact might duplicate or contradict: same entity pair, same source+relation, or similar text.
    // minSimilarity depends on the embedding model's scale (see SIMILARITY in index.ts).
    async candidateFacts(scope: Scope, source: string, target: string, name: string, embedding: number[], at: string, minSimilarity = 0.6): Promise<FactEdge[]> {
        return this.run(
            `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
             WHERE r.scope = $scope AND ${BELIEVED_AT}
               AND ((a.uuid = $source AND b.uuid = $target) OR (a.uuid = $target AND b.uuid = $source)
                    OR (a.uuid = $source AND r.name = $name)
                    OR vector.similarity.cosine(r.fact_embedding, $embedding) >= $minSimilarity)
             RETURN ${EDGE_FIELDS}, vector.similarity.cosine(r.fact_embedding, $embedding) AS score
             ORDER BY score DESC LIMIT 8`,
            { scope, source, target, name, embedding, at, minSimilarity }
        );
    }

    async createFact(edge: Omit<FactEdge, 'source_name' | 'target_name' | 'source_uuid' | 'target_uuid' | 'expired_at' | 'invalid_at'> & { source: string; target: string; embedding: number[]; evidence: string; invalid_at: string | null }): Promise<void> {
        await this.run(
            `MATCH (a:Entity {uuid: $source}), (b:Entity {uuid: $target})
             CREATE (a)-[:RELATES_TO {uuid: $uuid, name: $name, fact: $fact, fact_embedding: $embedding, scope: $scope, status: $status,
                     valid_at: $valid_at, invalid_at: $invalid_at, created_at: $created_at, episode_ids: $episode_ids, evidence: $evidence,
                     author: $author, search_text: $fact}]->(b)`,
            edge
        );
    }

    async addEpisodeToFact(uuid: string, episodeId: string): Promise<void> {
        await this.run(
            `MATCH ()-[r:RELATES_TO {uuid: $uuid}]->() WHERE NOT $episodeId IN r.episode_ids SET r.episode_ids = r.episode_ids + $episodeId`,
            { uuid, episodeId }
        );
    }

    async setStatus(uuid: string, status: FactEdge['status']): Promise<void> {
        await this.run('MATCH ()-[r:RELATES_TO {uuid: $uuid}]->() SET r.status = $status', { uuid, status });
    }

    // Text the lexical read path searches: the fact plus questions and synonyms written at ingest.
    async setSearchText(uuid: string, text: string): Promise<void> {
        await this.run('MATCH ()-[r:RELATES_TO {uuid: $uuid}]->() SET r.search_text = $text', { uuid, text });
    }

    // Full-text search over facts' search text, optionally only facts touching the given entities.
    async searchFacts(scopes: Scope[], at: string, words: string[], limit: number, onlyEntities: string[] | null): Promise<FactEdge[]> {
        if (words.length === 0) return [];
        return this.run(
            `CALL db.index.fulltext.queryRelationships('fact_search', $query) YIELD relationship AS r, score
             MATCH (a:Entity)-[r]->(b:Entity)
             WHERE r.scope IN $scopes AND ${BELIEVED_AT}
               AND ($onlyEntities IS NULL OR a.uuid IN $onlyEntities OR b.uuid IN $onlyEntities)
             RETURN ${EDGE_FIELDS}, score ORDER BY score DESC LIMIT toInteger($limit)`,
            { query: words.join(' OR '), scopes, at, limit, onlyEntities }
        );
    }

    // Facts touching the given entities, newest first (for when the question's words match none).
    async entityFacts(scopes: Scope[], at: string, entities: string[], limit: number): Promise<FactEdge[]> {
        if (entities.length === 0) return [];
        return this.run(
            `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
             WHERE r.scope IN $scopes AND ${BELIEVED_AT} AND (a.uuid IN $entities OR b.uuid IN $entities)
             RETURN ${EDGE_FIELDS} ORDER BY r.created_at DESC LIMIT toInteger($limit)`,
            { scopes, at, entities, limit }
        );
    }

    // Already-invalidated facts matching the question's words (history, without embeddings).
    async searchExpired(scopes: Scope[], at: string, words: string[], limit: number): Promise<FactEdge[]> {
        if (words.length === 0) return [];
        return this.run(
            `CALL db.index.fulltext.queryRelationships('fact_search', $query) YIELD relationship AS r, score
             MATCH (a:Entity)-[r]->(b:Entity)
             WHERE r.scope IN $scopes AND r.expired_at IS NOT NULL AND r.expired_at <= $at
             RETURN ${EDGE_FIELDS}, score ORDER BY score DESC LIMIT toInteger($limit)`,
            { query: words.join(' OR '), scopes, at, limit }
        );
    }

    // Just the shape of the believed graph (for Personalized PageRank): edge ids and endpoints.
    async edgeEndpoints(scopes: Scope[], at: string): Promise<{ uuid: string; source: string; target: string; status: FactEdge['status'] }[]> {
        return this.run(
            `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity) WHERE r.scope IN $scopes AND ${BELIEVED_AT}
             RETURN r.uuid AS uuid, a.uuid AS source, b.uuid AS target, r.status AS status`,
            { scopes, at }
        );
    }

    async factsByUuid(uuids: string[]): Promise<FactEdge[]> {
        if (uuids.length === 0) return [];
        const rows = await this.run<FactEdge>(
            `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity) WHERE r.uuid IN $uuids RETURN ${EDGE_FIELDS}`,
            { uuids }
        );
        return uuids.map((uuid) => rows.find((r) => r.uuid === uuid)).filter((r): r is FactEdge => !!r);
    }

    // Full-text search over facts believed at `at` (words are alphanumeric, OR-ed for Lucene).
    async fullTextFacts(scopes: Scope[], at: string, words: string[], limit: number): Promise<FactEdge[]> {
        if (words.length === 0) return [];
        return this.run(
            `CALL db.index.fulltext.queryRelationships('fact_text', $query) YIELD relationship AS r, score
             MATCH (a:Entity)-[r]->(b:Entity)
             WHERE r.scope IN $scopes AND ${BELIEVED_AT}
             RETURN ${EDGE_FIELDS}, score ORDER BY score DESC LIMIT toInteger($limit)`,
            { query: words.join(' OR '), scopes, at, limit }
        );
    }

    // Breadth-first expansion (Zep): facts within two hops of the seed entities, nearest hops first.
    async bfsFacts(scopes: Scope[], at: string, seeds: string[], limit: number): Promise<FactEdge[]> {
        if (seeds.length === 0) return [];
        return this.run(
            `MATCH (s:Entity) WHERE s.uuid IN $seeds
             MATCH p = (s)-[rels:RELATES_TO*1..2]-(:Entity)
             WHERE all(r IN rels WHERE r.scope IN $scopes AND r.created_at <= $at AND (r.expired_at IS NULL OR r.expired_at > $at))
             UNWIND rels AS r
             WITH r, min(length(p)) AS hops
             MATCH (a:Entity)-[r]->(b:Entity)
             RETURN ${EDGE_FIELDS}, hops ORDER BY hops LIMIT toInteger($limit)`,
            { scopes, at, seeds, limit }
        );
    }

    // Entities (not people) whose current facts mention any of the words: candidates for a descriptive name
    // that shares no word with the entity's own name ("the WebRTC product" → Wire Pulse, "a managed WebRTC service").
    async entitiesDescribedBy(scope: Scope, at: string, words: string[], limit: number): Promise<EntityNode[]> {
        if (words.length === 0) return [];
        return this.run(
            `CALL db.index.fulltext.queryRelationships('fact_text', $query) YIELD relationship AS r, score
             MATCH (a:Entity)-[r]->(b:Entity)
             WHERE r.scope = $scope AND ${BELIEVED_AT}
             UNWIND [a, b] AS e
             WITH e, max(score) AS best WHERE e.kind <> 'person'
             RETURN e.uuid AS uuid, e.scope AS scope, e.key AS key, e.name AS name, e.kind AS kind
             ORDER BY best DESC LIMIT toInteger($limit)`,
            { scope, at, query: words.join(' OR '), limit }
        );
    }

    // A few current facts about an entity, as context for entity matching (Zep-style entity summary).
    // With `prefer`, facts containing those words come first (the ones that make it a candidate).
    async entitySummary(uuid: string, at: string, limit = 3, prefer: string[] = []): Promise<string> {
        const rows = await this.run<{ fact: string }>(
            `MATCH (e:Entity {uuid: $uuid})-[r:RELATES_TO]-() WHERE ${BELIEVED_AT}
             RETURN DISTINCT r.fact AS fact, r.created_at AS created
             ORDER BY size([w IN $prefer WHERE toLower(fact) CONTAINS w]) DESC, created DESC LIMIT toInteger($limit)`,
            { uuid, at, limit, prefer }
        );
        return rows.map((r) => r.fact).join('; ');
    }

    async invalidateFact(uuid: string, invalidAt: string, expiredAt: string): Promise<void> {
        await this.run(
            `MATCH ()-[r:RELATES_TO {uuid: $uuid}]->() WHERE r.expired_at IS NULL SET r.invalid_at = $invalidAt, r.expired_at = $expiredAt`,
            { uuid, invalidAt, expiredAt }
        );
    }

    // ---- reads ----

    async nearestFacts(scopes: Scope[], at: string, embedding: number[], limit: number, onlyEntities: string[] | null): Promise<FactEdge[]> {
        return this.run(
            `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
             WHERE r.scope IN $scopes AND ${BELIEVED_AT}
               AND ($onlyEntities IS NULL OR a.uuid IN $onlyEntities OR b.uuid IN $onlyEntities)
             WITH r, a, b, vector.similarity.cosine(r.fact_embedding, $embedding) AS score
             RETURN ${EDGE_FIELDS}, score ORDER BY score DESC LIMIT toInteger($limit)`,
            { scopes, at, embedding, limit, onlyEntities }
        );
    }

    // Facts that had already been invalidated by time `at` (history: "moved from X").
    async expiredFacts(scopes: Scope[], at: string, embedding: number[], limit: number, minSimilarity = 0.5): Promise<FactEdge[]> {
        return this.run(
            `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
             WHERE r.scope IN $scopes AND r.expired_at IS NOT NULL AND r.expired_at <= $at
             WITH r, a, b, vector.similarity.cosine(r.fact_embedding, $embedding) AS score WHERE score >= $minSimilarity
             RETURN ${EDGE_FIELDS}, score ORDER BY score DESC LIMIT toInteger($limit)`,
            { scopes, at, embedding, limit, minSimilarity }
        );
    }

    // The whole believed graph at `at` in these scopes, for inspection; with history, also facts that were
    // invalidated by then (status "superseded").
    async subgraph(scopes: Scope[], at: string, history: boolean) {
        const nodes = await this.run<{ id: string; name: string; kind: string; aliases: string[] }>(
            'MATCH (e:Entity) WHERE e.scope IN $scopes RETURN e.uuid AS id, e.name AS name, e.kind AS kind, coalesce(e.aliases, []) AS aliases',
            { scopes }
        );
        const edges = await this.run<{ id: string; source: string; target: string; relation: string; text: string; status: string; believed: boolean;
            validFrom: string | null; validTo: string | null; expiredAt: string | null; author: string | null; scope: Scope }>(
            `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
             WHERE r.scope IN $scopes AND r.created_at <= $at AND ($history OR (${BELIEVED_AT}))
             RETURN r.uuid AS id, a.uuid AS source, b.uuid AS target, r.name AS relation, r.fact AS text, r.status AS status,
                    CASE WHEN ${BELIEVED_AT} THEN true ELSE false END AS believed,
                    r.valid_at AS validFrom, r.invalid_at AS validTo, r.expired_at AS expiredAt, r.author AS author, r.scope AS scope`,
            { scopes, at, history }
        );
        return { nodes, edges };
    }

    // ---- working memory (consolidate) ----
    // Raw messages waiting to become entities and facts, one buffer per scope (a team's, or one person's).

    async addBuffered(item: { id: string; scope: Scope; at: string; actor: string; text: string; payload: string; embedding: number[] }): Promise<void> {
        await this.run(
            `MERGE (w:Buffered {id: $id}) ON CREATE SET w.scope = $scope, w.at = $at, w.actor = $actor, w.text = $text,
             w.payload = $payload, w.embedding = $embedding, w.done = false`,
            item
        );
    }

    // Buffers (scopes ending in `suffix`) whose oldest waiting message is at or before `before`.
    async overdueBufferScopes(before: string, suffix = ''): Promise<Scope[]> {
        const rows = await this.run<{ scope: Scope }>(
            `MATCH (w:Buffered {done: false}) WHERE w.scope ENDS WITH $suffix
             WITH w.scope AS scope, min(w.at) AS oldest WHERE oldest <= $before RETURN scope`,
            { before, suffix }
        );
        return rows.map((r) => r.scope);
    }

    async pendingBuffered(scope: Scope): Promise<{ id: string; at: string; payload: string }[]> {
        return this.run(
            'MATCH (w:Buffered {scope: $scope, done: false}) RETURN w.id AS id, w.at AS at, w.payload AS payload ORDER BY w.at, w.id',
            { scope }
        );
    }

    async markBuffered(ids: string[]): Promise<void> {
        await this.run('MATCH (w:Buffered) WHERE w.id IN $ids SET w.done = true', { ids });
    }

    // Waiting messages a reader may see, most similar first (or newest first without an embedding).
    async bufferedForRead(scopes: Scope[], at: string, embedding: number[] | null, limit: number) {
        return this.run<{ id: string; scope: Scope; at: string; actor: string; text: string; score: number | null }>(
            `MATCH (w:Buffered) WHERE w.scope IN $scopes AND w.done = false AND w.at <= $at
             WITH w, CASE WHEN $embedding IS NULL THEN null ELSE vector.similarity.cosine(w.embedding, $embedding) END AS score
             RETURN w.id AS id, w.scope AS scope, w.at AS at, w.actor AS actor, w.text AS text, score
             ORDER BY coalesce(score, 0) DESC, w.at DESC LIMIT toInteger($limit)`,
            { scopes, at, embedding, limit }
        );
    }

    async listBuffered(scopes: Scope[]) {
        return this.run<{ id: string; scope: Scope; at: string; actor: string; text: string }>(
            'MATCH (w:Buffered) WHERE w.scope IN $scopes AND w.done = false RETURN w.id AS id, w.scope AS scope, w.at AS at, w.actor AS actor, w.text AS text ORDER BY w.at',
            { scopes }
        );
    }

    // ---- dreaming ----

    // The latest messages that mentioned an entity (its episodes), for judging it in context.
    async episodesMentioning(uuid: string, limit: number): Promise<string[]> {
        const rows = await this.run<{ text: string }>(
            'MATCH (ep:Episode)-[:MENTIONS]->(e:Entity {uuid: $uuid}) RETURN ep.text AS text ORDER BY ep.occurred_at DESC LIMIT toInteger($limit)',
            { uuid, limit }
        );
        return rows.map((r) => r.text);
    }

    // Merges a duplicate entity into the canonical one: every fact and mention moves over unchanged (same
    // uuid, times and status, so history and the fact count are kept) and the duplicate's names become aliases.
    async mergeEntity(duplicate: string, canonical: string): Promise<void> {
        const p = { d: duplicate, c: canonical };
        await this.run(`MATCH (d:Entity {uuid: $d})-[r:RELATES_TO]->(d), (c:Entity {uuid: $c}) CREATE (c)-[n:RELATES_TO]->(c) SET n = properties(r) DELETE r`, p);
        await this.run(`MATCH (d:Entity {uuid: $d})-[r:RELATES_TO]->(t:Entity), (c:Entity {uuid: $c}) WHERE t <> d CREATE (c)-[n:RELATES_TO]->(t) SET n = properties(r) DELETE r`, p);
        await this.run(`MATCH (s:Entity)-[r:RELATES_TO]->(d:Entity {uuid: $d}), (c:Entity {uuid: $c}) WHERE s <> d CREATE (s)-[n:RELATES_TO]->(c) SET n = properties(r) DELETE r`, p);
        await this.run(`MATCH (ep:Episode)-[m:MENTIONS]->(d:Entity {uuid: $d}), (c:Entity {uuid: $c}) MERGE (ep)-[:MENTIONS]->(c) DELETE m`, p);
        await this.run(
            `MATCH (d:Entity {uuid: $d}), (c:Entity {uuid: $c})
             SET c.aliases = c.aliases + [x IN coalesce(d.aliases, []) + [d.key] WHERE NOT x IN c.aliases]
             WITH d DETACH DELETE d`,
            p
        );
    }

    // Current facts touching each entity of a scope, oldest first (for the dream's contradiction sweep).
    async factsByEntity(scope: Scope, at: string): Promise<{ entity: string; name: string; facts: FactEdge[] }[]> {
        return this.run(
            `MATCH (e:Entity {scope: $scope})-[r:RELATES_TO]-(o:Entity) WHERE r.scope = $scope AND ${BELIEVED_AT} AND r.status <> 'disputed'
             MATCH (a:Entity)-[r]->(b:Entity)
             WITH e, r, a, b ORDER BY r.created_at
             WITH e, collect(DISTINCT {uuid: r.uuid, name: r.name, fact: r.fact, valid_at: r.valid_at, created_at: r.created_at, status: r.status}) AS facts
             WHERE size(facts) > 1
             RETURN e.uuid AS entity, e.name AS name, facts`,
            { scope, at }
        );
    }

    async factsInScopes(scopes: Scope[], at: string): Promise<FactEdge[]> {
        return this.run(
            `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity) WHERE r.scope IN $scopes AND ${BELIEVED_AT} RETURN ${EDGE_FIELDS}`,
            { scopes, at }
        );
    }

    async countFacts(): Promise<number> {
        const [row] = await this.run<{ n: number }>('MATCH ()-[r:RELATES_TO]->() RETURN count(r) AS n');
        return row.n;
    }
}
