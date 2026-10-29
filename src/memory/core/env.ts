// Connection settings for the POC's local infra (docker-compose.memory.yml).

export function pgUrl(database: string): string {
    const base = (process.env.MEMORY_PG_URL || 'postgres://memory:memory@127.0.0.1:5433').replace(/\/+$/, '');
    return `${base}/${pgDatabase(database)}`;
}

// MEMORY_PG_DB_SUFFIX keeps a long-lived store (the MCP server's, "_mcp") apart from the eval's, whose
// runs reset their databases.
export function pgDatabase(database: string): string {
    return `${database}${process.env.MEMORY_PG_DB_SUFFIX ?? ''}`;
}

export function neo4jConfig() {
    return {
        url: process.env.MEMORY_NEO4J_URL || 'bolt://127.0.0.1:7688',
        user: process.env.MEMORY_NEO4J_USER || 'neo4j',
        password: process.env.MEMORY_NEO4J_PASSWORD || 'memory-poc',
    };
}

// LLM/embedding provider. Both are reached through the OpenAI SDK: Gemini via its OpenAI-compatible endpoint.
export type LlmProviderName = 'openai' | 'gemini';

export interface LlmProvider {
    name: LlmProviderName;
    apiKeyVar: string;
    baseURL: string;
    defaultModel: string;
    defaultEmbedModel: string;
    // null leaves temperature unset (the model's default).
    defaultTemperature: number | null;
}

const PROVIDERS: Record<LlmProviderName, LlmProvider> = {
    openai: {
        name: 'openai',
        apiKeyVar: 'OPENAI_API_KEY',
        baseURL: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4.1-mini',
        defaultEmbedModel: 'text-embedding-3-small',
        defaultTemperature: 0,
    },
    gemini: {
        name: 'gemini',
        apiKeyVar: 'GEMINI_API_KEY',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
        // gemini-2.5-flash is closed to new users; Google points to 3.8 Flash.
        defaultModel: 'gemini-3.8-flash',
        defaultEmbedModel: 'gemini-embedding-001',
        // Google advises keeping Gemini 3.x at its default temperature; lower values can degrade output.
        defaultTemperature: null,
    },
};

export function llmProvider(): LlmProvider {
    const name = (process.env.MEMORY_LLM_PROVIDER || 'openai') as LlmProviderName;
    const provider = PROVIDERS[name];
    if (!provider) throw new Error(`MEMORY_LLM_PROVIDER must be one of ${Object.keys(PROVIDERS).join(', ')}, got ${name}`);
    // MEMORY_OPENAI_BASE_URL points every call at another OpenAI-compatible server (tests, gateways).
    return { ...provider, baseURL: (process.env.MEMORY_OPENAI_BASE_URL || provider.baseURL).replace(/\/+$/, '') };
}

export function providerApiKey(): string {
    const provider = llmProvider();
    const key = process.env[provider.apiKeyVar];
    if (!key) {
        throw new Error(`${provider.apiKeyVar} is not set (MEMORY_LLM_PROVIDER=${provider.name}); add it to .env, or run the eval with --offline`);
    }
    return key;
}
