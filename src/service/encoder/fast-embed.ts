import axios from "../../config/axios";
import { IEncoder, ModelDetail } from "../utility";
import { randomUUID } from 'crypto';
const CONFIG = {
    MAX_BATCH_SIZE: 50,
    MAX_WASTE_RATIO: 0.10,
    RETRY_COUNT: 5
};
const EMBEDDING_SERVER = process.env.EMBEDDING_SERVER || 'http://127.0.0.1:8000';

export async function generateEmbedding(texts: string[], model: string = "BAAI/bge-small-en-v1.5"): Promise<number[][]> {
    try {
        const routingKey = `${model}:${randomUUID()}`;
        const sortedChunks: IndexedText[] = texts
            .map((text, index) => ({ text, originalIndex: index, length: text.length }))
            .sort((a, b) => b.length - a.length);
        const batches = createOptimizedBatches(sortedChunks); // Minimize padding
        const embeddingsMap = new Map<number, number[]>();
        for (const batch of batches) {
            const response = await axios.post(`${EMBEDDING_SERVER}/embed`, {
                model: model,
                texts: batch.map(t => t.text)
            }, {
                headers: {
                    'X-Routing-Key': routingKey,
                    'Content-Type': 'application/json'
                },
                retry: CONFIG.RETRY_COUNT
            } as any);
            const embeddings: number[][] = response.data.embeddings;
            batch.forEach((item, i) => {
                embeddingsMap.set(item.originalIndex, embeddings[i]);
            });

        }
        return texts.map((_, i) => embeddingsMap.get(i)!);
    } catch (error) {
        console.error('Error fetching embeddings:', error);
        throw error;
    }
}

export async function generateSparseEmbedding(texts: string[], model: string = "prithivida/splade-pp-en-v1"): Promise<{ indices: number[], values: number[] }[]> {
    try {
        const routingKey = `${model}:${randomUUID()}`;
        const sortedChunks: IndexedText[] = texts
            .map((text, index) => ({ text, originalIndex: index, length: text.length }))
            .sort((a, b) => b.length - a.length);
        const batches = createOptimizedBatches(sortedChunks); // Minimize padding
        const embeddingsMap = new Map<number, { indices: number[], values: number[] }>();
        for (const batch of batches) {
            const response = await axios.post(`${EMBEDDING_SERVER}/sparse-embed`, {
                model: model,
                texts: batch.map(t => t.text)
            }, {
                headers: {
                    'X-Routing-Key': routingKey,
                    'Content-Type': 'application/json'
                },
                retry: CONFIG.RETRY_COUNT
            } as any);
            const embeddings = response.data.embeddings;
            const mappedEmbeddings = embeddings.map((emb: Record<string, number>) => {
                const indices = Object.keys(emb).map(Number);
                const values = Object.values(emb);
                return { indices, values };
            });
            batch.forEach((item, i) => {
                embeddingsMap.set(item.originalIndex, mappedEmbeddings[i]);
            });

        }
        return texts.map((_, i) => embeddingsMap.get(i)!);
    } catch (error) {
        console.error('Error fetching embeddings:', error);
        throw error;
    }
}


export async function generateLateInteractionEmbedding(texts: string[], model: string = "colbert-ir/colbertv2.0"): Promise<number[][][]> {

    try {
        const routingKey = `${model}:${randomUUID()}`;
        const sortedChunks: IndexedText[] = texts
            .map((text, index) => ({ text, originalIndex: index, length: text.length }))
            .sort((a, b) => b.length - a.length);
        const batches = createOptimizedBatches(sortedChunks); // Minimize padding
        const embeddingsMap = new Map<number, number[][]>();
        for (const batch of batches) {
            const response = await axios.post(`${EMBEDDING_SERVER}/late-interaction-embed`, {
                model: model,
                texts: batch.map(t => t.text)
            }, {
                headers: {
                    'X-Routing-Key': routingKey,
                    'Content-Type': 'application/json'
                },
                retry: CONFIG.RETRY_COUNT
            } as any);
            const embeddings: number[][][] = response.data.embeddings;
            batch.forEach((item, i) => {
                embeddingsMap.set(item.originalIndex, embeddings[i]);
            });

        }
        return texts.map((_, i) => embeddingsMap.get(i)!);
    } catch (error) {
        console.error('Error fetching embeddings:', error);
        throw error;
    }
}

export class SparseEncoder implements IEncoder {
    async encode(chunks: string[], model: string = "Qdrant/bm25"): Promise<any> {
        return generateSparseEmbedding(chunks, model);
    }
    getModelDetail(model: string) {
        const modelDetails = new Map<string, ModelDetail>();
        modelDetails.set("prithivida/Splade_PP_en_v1", {
            name: "Splade PP EN V1",
            provider: "Hosted",
            description: "Sparse model",
            latency: "Low"
        });
        modelDetails.set("Qdrant/bm25", {
            name: "BM25",
            provider: "Hosted",
            description: "Sparse model",
            latency: "Low"
        });
        return modelDetails.get(model);
    }
}

export class Reranker implements IEncoder {
    async encode(chunks: string[], model: string = "colbert-ir/colbertv2.0"): Promise<any> {
        return generateLateInteractionEmbedding(chunks, model);
    }

    getModelDetail(model: string) {
        const modelDetails = new Map<string, ModelDetail>();
        modelDetails.set("colbert-ir/colbertv2.0", {
            name: "Colbert v2.0",
            provider: "Hosted",
            description: "Great reranker",
            latency: "Low"
        });
        modelDetails.set("jinaai/jina-colbert-v2", {
            name: "Jinaai Colbert v2.0",
            provider: "Hosted",
            description: "Great reranker",
            latency: "Low"
        });
        modelDetails.set("answerdotai/answerai-colbert-small-v1", {
            name: "Answerai Colbert Small v1",
            provider: "Hosted",
            description: "Lightweight reranker",
            latency: "Low"
        });
        return modelDetails.get(model);
    }
}

export class FastEmbedEncoder implements IEncoder {
    async encode(chunks: string[], model: string = "BAAI/bge-small-en-v1.5"): Promise<number[][]> {
        return generateEmbedding(chunks, model);
    }

    getModelDetail(model: string) {
        const modelDetails = new Map<string, ModelDetail>();
        modelDetails.set("BAAI/bge-small-en-v1.5", {
            name: "BAAI BGE Small EN v1.5",
            provider: "Hosted",
            description: "A smaller version of Baidu's General Embedding model optimized for English text.",
            latency: "Low"
        });

        modelDetails.set("BAAI/bge-large-en-v1.5", {
            name: "BAAI BGE Large EN v1.5",
            provider: "Hosted",
            description: "A larger version of Baidu's General Embedding model optimized for English text, providing higher accuracy.",
            latency: "Medium"
        });

        modelDetails.set("sentence-transformers/all-MiniLM-L6-v2", {
            name: "Sentence Transformers MiniLM L6 v2",
            provider: "Hosted",
            description: "A compact and efficient model from Sentence Transformers for generating sentence embeddings.",
            latency: "Low"
        });
        modelDetails.set("intfloat/multilingual-e5-large", {
            name: "Intfloat Multilingual E5 Large",
            provider: "Hosted",
            description: "A large multilingual embedding model suitable for various languages.",
            latency: "Medium"
        });
        modelDetails.set("jinaai/jina-embeddings-v2-base-code", {
            name: "Jina Embeddings v2 Base Code",
            provider: "Hosted",
            description: "An embedding model from Jina AI optimized for code and technical text.",
            latency: "Low"
        });
        return modelDetails.get(model);
    }
}


interface IndexedText {
    text: string;
    originalIndex: number;
    length: number;
}
/**
 * Sub-function: Handles the Math (Greedy Batching)
 * Returns an array of batches, where each batch is an array of items.
 */
function createOptimizedBatches(sortedItems: IndexedText[]): IndexedText[][] {
    const batches: IndexedText[][] = [];
    let currentBatch: IndexedText[] = [];

    for (const item of sortedItems) {
        if (currentBatch.length === 0) {
            currentBatch.push(item);
            continue;
        }

        if (shouldStartNewBatch(currentBatch, item)) {
            batches.push(currentBatch);
            currentBatch = [item];
        } else {
            currentBatch.push(item);
        }
    }

    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }

    return batches;
}

/**
 * Sub-function: Calculates padding waste to decide if we split
 */
function shouldStartNewBatch(currentBatch: IndexedText[], newItem: IndexedText): boolean {
    if (currentBatch.length >= CONFIG.MAX_BATCH_SIZE) return true;

    // First item is always longest (due to sort), so it sets matrix height
    const batchMaxLen = currentBatch[0].length;

    // Calculate Matrix Stats
    const potentialSize = currentBatch.length + 1;
    const totalMatrixArea = batchMaxLen * potentialSize;

    const currentSum = currentBatch.reduce((sum, i) => sum + i.length, 0);
    const actualTokens = currentSum + newItem.length;

    const wastedTokens = totalMatrixArea - actualTokens;
    const wasteRatio = wastedTokens / totalMatrixArea;

    return wasteRatio > CONFIG.MAX_WASTE_RATIO;
}