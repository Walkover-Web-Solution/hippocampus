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

export const memoryConfig = {
    databaseUrl: process.env.MEMORY_DATABASE_URL || '',
    databaseSsl: process.env.MEMORY_DATABASE_SSL === 'true',
    // The tables are created or updated when the server starts, unless a deploy prefers `npm run memory:migrate`.
    autoMigrate: process.env.MEMORY_AUTO_MIGRATE !== 'false',
    // Any model the Encoder knows: an OpenAI one, or a FastEmbed one served by the sidecar. The vector column has a
    // fixed size, so the dimensions must match the model and changing them needs a re-index.
    embeddingModel: process.env.MEMORY_EMBEDDING_MODEL || 'text-embedding-3-small',
    embeddingDimensions: positive(process.env.MEMORY_EMBEDDING_DIMENSIONS, 1536),
    // The chat model that extracts memories from conversations, links names, and writes summaries.
    extractionModel: process.env.MEMORY_EXTRACTION_MODEL || 'gpt-4.1-mini',
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
