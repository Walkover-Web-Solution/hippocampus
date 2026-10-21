/**
 * Memory settings, all from the environment. Memory is on when MEMORY_DATABASE_URL points at a Postgres with the
 * pgvector extension; nothing else in Hippocampus changes when it is off, and the existing RAG routes never read
 * any of these.
 */
const positive = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// MEMORY_SIGNERS is a JSON object of issuer -> secret, such as {"viasocket":"..."}; signers can also be added at
// runtime through the admin API, which stores them in Postgres.
const parseSigners = (raw: string | undefined): Record<string, string> => {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
        return Object.fromEntries(Object.entries(parsed).filter(([, secret]) => typeof secret === 'string' && secret)) as Record<string, string>;
    } catch {
        return {};
    }
};

// Defaults that follow the embedding model. The vector size must match the model. The distance is where "related"
// ends on that model's cosine scale, measured on short memories and queries: with text-embedding-3-small related
// facts landed between 0.27 and 0.79 and unrelated ones from 0.80; with EmbeddingGemma and its query/document
// prefixes, related between 0.33 and 0.66 and unrelated from 0.73 (off-topic queries from 0.86).
const EMBEDDING_DEFAULTS: Record<string, { dimensions: number; maxDistance: number }> = {
    'google/embeddinggemma-300m': { dimensions: 768, maxDistance: 0.72 },
    'text-embedding-3-small': { dimensions: 1536, maxDistance: 0.8 },
    'text-embedding-3-large': { dimensions: 3072, maxDistance: 0.8 },
};
const embeddingModel = process.env.MEMORY_EMBEDDING_MODEL || 'google/embeddinggemma-300m';
const embeddingDefaults = EMBEDDING_DEFAULTS[embeddingModel];

export const memoryConfig = {
    databaseUrl: process.env.MEMORY_DATABASE_URL || '',
    databaseSsl: process.env.MEMORY_DATABASE_SSL === 'true',
    // The tables are created or updated when the server starts, unless a deploy prefers `npm run memory:migrate`.
    autoMigrate: process.env.MEMORY_AUTO_MIGRATE !== 'false',
    // Any model the Encoder knows. The default, Google's EmbeddingGemma, runs in the FastEmbed sidecar (fastembed/,
    // EMBEDDING_SERVER) and needs no API key; OpenAI's models need OPENAI_API_KEY_EMBEDDING. The vector column has
    // a fixed size, so the dimensions must match the model, and changing the model needs a re-index.
    embeddingModel,
    embeddingDimensions: positive(process.env.MEMORY_EMBEDDING_DIMENSIONS, embeddingDefaults?.dimensions ?? 768),
    // When the model changed on a database that already has an index: drop the chunks, resize the column and
    // re-index every note on start. Off, a mismatch is logged as an error at start and memory writes fail.
    reindexOnModelChange: process.env.MEMORY_EMBEDDING_REINDEX === 'true',
    // Cosine distance beyond which a chunk is not about the query; each model has its own scale.
    maxDistance: positive(process.env.MEMORY_MAX_DISTANCE, embeddingDefaults?.maxDistance ?? 0.8),
    // The chat model that extracts memories from conversations, links names, and writes summaries: a Claude model
    // (ANTHROPIC_API_KEY) or an OpenAI model (OPENAI_API_KEY). The default, claude-haiku-5-5, passed the golden
    // cases (18/18, twice) at a quarter of gpt-4.1-mini's cost; `npm run memory:eval` scores a candidate first.
    extractionModel: process.env.MEMORY_EXTRACTION_MODEL || 'claude-haiku-5-5',
    // A second model, from the other provider, that answers when the first fails (an outage, a rate limit, a
    // rejected request), so one provider's bad hour does not stop memories from being learned. Empty: no fallback.
    extractionFallbackModel: process.env.MEMORY_EXTRACTION_FALLBACK_MODEL || 'gpt-4.1-mini',
    // How hard a Claude model thinks per call; low is enough for these short decisions and the fastest. Ignored by OpenAI.
    extractionEffort: (['low', 'medium', 'high'].includes(process.env.MEMORY_EXTRACTION_EFFORT ?? '') ? process.env.MEMORY_EXTRACTION_EFFORT : 'low') as 'low' | 'medium' | 'high',
    // A body longer than this is indexed by the memory consumer instead of inside the request.
    inlineIndexChars: positive(process.env.MEMORY_INLINE_INDEX_CHARS, 12000),
    queue: process.env.MEMORY_QUEUE || 'memory',
    signers: parseSigners(process.env.MEMORY_SIGNERS),
    // A token may not be valid for longer than this, whatever exp it carries.
    tokenMaxAgeSeconds: positive(process.env.MEMORY_TOKEN_MAX_AGE, 7 * 24 * 3600),
    // With fake models, embeddings are hashed from words and no chat model is called: for tests and local runs
    // without API keys. Search still works on words and names; extraction learns nothing.
    fakeModels: process.env.MEMORY_FAKE_MODELS === 'true',
};

export const memoryEnabled = (): boolean => Boolean(memoryConfig.databaseUrl);
