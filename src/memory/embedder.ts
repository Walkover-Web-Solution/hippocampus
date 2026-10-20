import { createHash } from 'crypto';
import { ApiError } from '../error/api-error';
import { Encoder } from '../service/encoder';
import { memoryConfig } from './config';
import { Embedder } from './types';
import { addTokens } from './usage';

/**
 * Embeddings for memory chunks and queries, through the same Encoder the RAG routes use, so any dense model it
 * knows works here: OpenAI's, or a FastEmbed model served by the sidecar.
 */
const BATCH = 100;

class EncoderEmbedder implements Embedder {
    readonly model = memoryConfig.embeddingModel;

    readonly dimensions = memoryConfig.embeddingDimensions;

    private readonly encoder = new Encoder();

    async embed(texts: string[]): Promise<number[][]> {
        if (!texts.length) return [];
        if (!this.encoder.isValid(this.model)) throw new ApiError(`MEMORY_EMBEDDING_MODEL "${this.model}" is not a model this server can run`, 500);
        const vectors: number[][] = [];
        for (let start = 0; start < texts.length; start += BATCH) {
            const batch = texts.slice(start, start + BATCH);
            vectors.push(...await this.encoder.encode(batch, this.model));
            addTokens(batch.reduce((sum, text) => sum + text.length, 0) / 4);
        }
        if (vectors.length !== texts.length || vectors.some((vector) => !vector || vector.length !== this.dimensions)) {
            throw new ApiError(`Embedding model ${this.model} did not return ${texts.length} vectors of ${this.dimensions} dimensions; check MEMORY_EMBEDDING_DIMENSIONS`, 500);
        }
        return vectors;
    }
}

// Deterministic vectors hashed from words, so two texts that share words are close. Enough for tests and local
// runs without an embedding model; useless for meaning.
export class FakeEmbedder implements Embedder {
    readonly model = 'fake';

    readonly dimensions = memoryConfig.embeddingDimensions;

    async embed(texts: string[]): Promise<number[][]> {
        return texts.map((text) => {
            const vector = new Array<number>(this.dimensions).fill(0);
            const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
            for (const word of words) {
                const digest = createHash('sha1').update(word).digest();
                const index = digest.readUInt32BE(0) % this.dimensions;
                vector[index] += digest[4] % 2 === 0 ? 1 : -1;
            }
            // A small constant keeps every vector non-zero, so cosine distance is always defined.
            vector[0] += 0.01;
            const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
            return vector.map((value) => value / norm);
        });
    }
}

export const embedder: Embedder = memoryConfig.fakeModels ? new FakeEmbedder() : new EncoderEmbedder();
