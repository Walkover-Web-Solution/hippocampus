import axios from "../../config/axios";
import { IEncoder, ModelDetail } from "../utility";
const EMBEDDING_SERVER = process.env.EMBEDDING_SERVER || 'http://127.0.0.1:8000';
export async function generateEmbedding(texts: string[], model: string = "BAAI/bge-small-en-v1.5"): Promise<number[][]> {
    const batchSize = 10;
    const embeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        try {
            const response = await axios.post(`${EMBEDDING_SERVER}/embed`, {
                model: model,
                texts: batch
            });
            embeddings.push(...response.data.embeddings);
        } catch (error) {
            console.error('Error fetching embeddings:', error);
            throw error;
        }
    }
    return embeddings;
}

export async function generateSparseEmbedding(texts: string[], model: string = "prithivida/splade-pp-en-v1"): Promise<{ indices: number[], values: number[] }[]> {
    const batchSize = 10;
    const result: { indices: number[], values: number[] }[] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        try {
            const response = await axios.post(`${EMBEDDING_SERVER}/sparse-embed`, {
                model: model,
                texts: batch
            });
            const embeddings = response.data.embeddings;
            const mappedEmbeddings = embeddings.map((emb: Record<string, number>) => {
                const indices = Object.keys(emb).map(Number);
                const values = Object.values(emb);
                return { indices, values };
            });
            result.push(...mappedEmbeddings);
        } catch (error) {
            console.error('Error fetching embeddings:', error);
            throw error;
        }
    }
    return result;
}


export async function generateLateInteractionEmbedding(texts: string[], model: string = "colbert-ir/colbertv2.0"): Promise<number[][][]> {
    const batchSize = 10;
    const embeddings: number[][][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        try {
            const response = await axios.post(`${EMBEDDING_SERVER}/late-interaction-embed`, {
                model: model,
                texts: batch
            });
            embeddings.push(...response.data.embeddings);
        } catch (error) {
            console.error('Error fetching late interaction embeddings:', error);
            throw error;
        }
    }
    return embeddings;
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