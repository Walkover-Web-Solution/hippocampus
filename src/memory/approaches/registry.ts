import { MemoryApproach } from '../core/types';

// Approaches load lazily so running one never loads another's dependencies (neo4j-driver, pg, ...).
// The five methods that held up on held-out and in the Lab chats, plus the naive control everything is
// measured against (it also backs the offline tests: no LLM, hash embeddings).
const loaders: Record<string, () => Promise<MemoryApproach>> = {
    naive: async () => new (await import('./naive')).NaiveApproach(),
    // The Postgres option: claims from a fixed vocabulary, Jev ingest gate and property router.
    'claims-pg+gate+router': async () => new (await import('./claims-pg')).ClaimsPgApproach({ gate: true, router: true }),
    // The temporal knowledge graph with Jev entity matching (typos, prefixes, embedding neighbours).
    'temporal-kg+vecmatch': async () => new (await import('./temporal-kg')).TemporalKgApproach({ gate: false, match: 'vector' }),
    // Plus named-entity boosting, per-scope serialized commits with disputes, and embedding-free reads
    // (write-time question expansion, full-text search only).
    'temporal-kg+vecmatch+rank+serial+lexical': async () => new (await import('./temporal-kg')).TemporalKgApproach({ gate: false, match: 'vector', rank: true, serial: true, lexical: true }),
    // Vector reads with EmbeddingGemma on the team's FastEmbed service, one-hop expansion and entity
    // linking by description.
    'temporal-kg+vecmatch+rank+serial+crowd+gemma+link': async () => new (await import('./temporal-kg')).TemporalKgApproach({ gate: false, match: 'vector', rank: true, serial: true, crowd: true, gemma: true, link: true }),
    // The same with working memory: messages wait and are consolidated in batches; dream() merges and cleans up.
    'temporal-kg+vecmatch+rank+serial+crowd+gemma+link+consolidate': async () => new (await import('./temporal-kg')).TemporalKgApproach({ gate: false, match: 'vector', rank: true, serial: true, crowd: true, gemma: true, link: true, consolidate: true }),
};

export const APPROACH_NAMES = Object.keys(loaders);

// Approaches that share a store which can't be partitioned must not run at the same time.
// Neo4j Community has a single database, so every temporal-kg variant shares it (unless the eval
// CLI is given a pool of instances, MEMORY_NEO4J_POOL).
export function storeGroup(name: string): string {
    return name.startsWith('temporal-kg') ? 'neo4j' : name;
}

export async function loadApproach(name: string): Promise<MemoryApproach> {
    const loader = loaders[name];
    if (!loader) throw new Error(`Unknown approach "${name}". Known: ${APPROACH_NAMES.join(', ')}`);
    return loader();
}
