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