import axios from "../../config/axios";
import { IEncoder, ModelDetail } from "../utility";

export async function generateEmbedding(texts: string[], model: string = "BAAI/bge-small-en-v1.5"): Promise<number[][]> {
    try {
        const response = await axios.post('http://127.0.0.1:8000/embed', {
            model: model,
            texts: texts
        });
        return response.data.embeddings;
    } catch (error) {
        console.error('Error fetching embeddings:', error);
        throw error;
    }
}

export async function generateSparseEmbedding(texts: string[], model: string = "prithivida/splade-pp-en-v1"): Promise<{ indices: number[], values: number[] }[]> {
    try {
        const response = await axios.post('http://127.0.0.1:8000/sparse-embed', {
            model: model,
            texts: texts
        });
        return response.data.embeddings;
    } catch (error) {
        console.error('Error fetching embeddings:', error);
        throw error;
    }
}

export async function generateRerank(query: string, documents: string[], model: string = "colbert-ir/colbertv2.0"): Promise<number[]> {
    // Dummy implementation.
    // Returns scores for each document.
    return documents.map(() => Math.random());
}

export async function generateLateInteractionEmbedding(texts: string[], model: string = "colbert-ir/colbertv2.0"): Promise<number[][][]> {
    try {
        const response = await axios.post('http://127.0.0.1:8000/late-interection-embed', {
            model: model,
            texts: texts
        });
        return response.data.embeddings;
    } catch (error) {
        console.error('Error fetching late interaction embeddings:', error);
        throw error;
    }
}

export class SparseEncoder implements IEncoder {
    async encode(chunks: string[], model: string = "prithivida/splade-pp-en-v1"): Promise<any> {
        return generateSparseEmbedding(chunks, model);
    }
    getModelDetail(model: string) {
        return {
            name: "SPLADE",
            provider: "Hosted",
            description: "Sparse Lexical and Expansion Model",
            latency: "Medium"
        };
    }
}

export class Reranker implements IEncoder {
    async encode(chunks: string[], model: string = "colbert-ir/colbertv2.0"): Promise<any> {
        return generateLateInteractionEmbedding(chunks, model);
    }

    // Custom method for reranking
    async rerank(query: string, documents: string[], model: string): Promise<number[]> {
        return generateRerank(query, documents, model);
    }

    getModelDetail(model: string) {
        return {
            name: "ColBERT",
            provider: "Hosted",
            description: "Late Interaction Reranker",
            latency: "High"
        };
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