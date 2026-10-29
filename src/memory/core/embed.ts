import { createHash } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { llmProvider } from './env';
import { openaiClient } from './llm';
import { recordEmbed } from './meter';

export interface Embedder {
    model: string;
    dims: number;
    // Texts to store and search (facts, names, messages).
    embed(texts: string[]): Promise<number[][]>;
    // Search questions; models trained with separate query/document prompts embed them differently.
    embedQuery?(texts: string[]): Promise<number[][]>;
}

export const DATA_DIR = path.resolve(process.cwd(), '.memory-data');

const EMBED_MODELS: Record<string, { dims: number; requestDims: boolean }> = {
    'text-embedding-3-small': { dims: 1536, requestDims: false },
    'text-embedding-3-large': { dims: 3072, requestDims: false },
    // Gemini defaults to 3072; ask for 1536 so tables use the same size as OpenAI runs.
    'gemini-embedding-001': { dims: 1536, requestDims: true },
};

export function embedModelName(): string {
    return process.env.MEMORY_EMBED_MODEL || llmProvider().defaultEmbedModel;
}

export function embeddingDims(model: string): number {
    const spec = EMBED_MODELS[model];
    if (!spec) throw new Error(`Unknown embedding model ${model} (known: ${Object.keys(EMBED_MODELS).join(', ')})`);
    return spec.dims;
}

// Provider embeddings (OpenAI-compatible API) with an append-only disk cache, so repeated eval runs
// don't re-embed the same text.
class ApiEmbedder implements Embedder {
    dims: number;
    private requestDims: boolean;
    private cache: Map<string, number[]> | null = null;
    private cacheFile: string;

    constructor(public model: string) {
        this.dims = embeddingDims(model);
        this.requestDims = EMBED_MODELS[model].requestDims;
        this.cacheFile = path.join(DATA_DIR, 'embed-cache', `${model}.jsonl`);
    }

    private loadCache(): Map<string, number[]> {
        if (this.cache) return this.cache;
        this.cache = new Map();
        if (existsSync(this.cacheFile)) {
            for (const line of readFileSync(this.cacheFile, 'utf8').split('\n')) {
                if (!line) continue;
                const { k, v } = JSON.parse(line);
                this.cache.set(k, v);
            }
        }
        return this.cache;
    }

    async embed(texts: string[]): Promise<number[][]> {
        const cache = this.loadCache();
        const keys = texts.map(cacheKey);
        const missing = [...new Set(texts.filter((_, i) => !cache.has(keys[i])))];
        for (let i = 0; i < missing.length; i += 100) {
            const batch = missing.slice(i, i + 100);
            const response = await openaiClient().embeddings.create({
                model: this.model,
                input: batch,
                ...(this.requestDims ? { dimensions: this.dims } : {}),
            });
            recordEmbed(response.usage?.total_tokens);
            mkdirSync(path.dirname(this.cacheFile), { recursive: true });
            response.data.forEach((d, j) => {
                const k = cacheKey(batch[j]);
                cache.set(k, d.embedding);
                appendFileSync(this.cacheFile, JSON.stringify({ k, v: d.embedding }) + '\n');
            });
        }
        return keys.map((k) => cache.get(k)!);
    }
}

// Deterministic offline embedder (hashed bag of words + bigrams). Only for checking the harness
// without network access; its notion of similarity is crude.
class HashEmbedder implements Embedder {
    model = 'hash-256';
    dims = 256;

    async embed(texts: string[]): Promise<number[][]> {
        return texts.map((text) => hashEmbedding(text, this.dims));
    }
}

export function hashEmbedding(text: string, dims: number): number[] {
    const vector = new Array(dims).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9$]+/g) ?? [];
    const features = [...tokens, ...tokens.slice(1).map((t, i) => `${tokens[i]} ${t}`)];
    for (const feature of features) {
        const digest = createHash('md5').update(feature).digest();
        const index = digest.readUInt16BE(0) % dims;
        vector[index] += digest[2] & 1 ? 1 : -1;
    }
    return normalize(vector);
}

function cacheKey(text: string): string {
    return createHash('sha1').update(text).digest('hex');
}

function normalize(vector: number[]): number[] {
    const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
    return norm === 0 ? vector : vector.map((x) => x / norm);
}

export function cosine(a: number[], b: number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

// The team's FastEmbed service (hippocampus' fastembed/main.py, deployed): POST /embed {texts, model}.
// Default model EmbeddingGemma (768 dims), used with its retrieval prompts, which matter: on the Lab chat's
// hard questions they lift the right fact from 5th to 1st. About 100 ms per question over the network.
const REMOTE_PROMPTS: Record<string, { query: string; document: string }> = {
    'google/embeddinggemma-300m': { query: 'task: search result | query: ', document: 'title: none | text: ' },
};

class RemoteEmbedder implements Embedder {
    dims = 0;
    private cache = new Map<string, number[]>();

    constructor(public model: string, private url: string) {}

    private async call(texts: string[], prefix: string): Promise<number[][]> {
        const keys = texts.map((t) => prefix + t);
        const missing = [...new Set(keys.filter((k) => !this.cache.has(k)))];
        for (let i = 0; i < missing.length; i += 64) {
            const batch = missing.slice(i, i + 64);
            const { embeddings } = await this.post(batch);
            embeddings.forEach((v, j) => this.cache.set(batch[j], v));
            this.dims = embeddings[0]?.length ?? this.dims;
        }
        return keys.map((k) => this.cache.get(k)!);
    }

    // Network blips and restarts happen; three tries with backoff, then the error surfaces.
    private async post(texts: string[], attempt = 1): Promise<{ embeddings: number[][] }> {
        try {
            const res = await fetch(`${this.url.replace(/\/+$/, '')}/embed`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ texts, model: this.model }),
            });
            if (!res.ok) throw new Error(`embedding server ${res.status}: ${(await res.text()).slice(0, 200)}`);
            return (await res.json()) as { embeddings: number[][] };
        } catch (error) {
            if (attempt >= 3) throw error;
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
            return this.post(texts, attempt + 1);
        }
    }

    embed(texts: string[]) {
        return this.call(texts, REMOTE_PROMPTS[this.model]?.document ?? '');
    }

    embedQuery(texts: string[]) {
        return this.call(texts, REMOTE_PROMPTS[this.model]?.query ?? '');
    }
}

let embedder: Embedder | null = null;
let remoteEmbedder: Embedder | null = null;

// Provider is read lazily so the CLI's --offline flag can switch it after env is loaded. "remote" asks for
// the FastEmbed service, whatever the default is (offline runs still get the hash embedder). Vectors from
// different models live in different spaces, so a store must use one embedder throughout.
export function getEmbedder(kind?: 'remote'): Embedder {
    if (kind === 'remote' && process.env.MEMORY_EMBED_PROVIDER !== 'hash') {
        return (remoteEmbedder ??= new RemoteEmbedder(
            process.env.MEMORY_REMOTE_EMBED_MODEL || 'google/embeddinggemma-300m',
            process.env.MEMORY_REMOTE_EMBED_URL || 'http://profiler-embedding.rtlayer.com'
        ));
    }
    if (!embedder) {
        embedder = process.env.MEMORY_EMBED_PROVIDER === 'hash' ? new HashEmbedder() : new ApiEmbedder(embedModelName());
    }
    return embedder;
}
