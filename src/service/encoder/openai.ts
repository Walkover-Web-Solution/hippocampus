import { OpenAIEmbeddings } from "@langchain/openai";
import env from "../../config/env";
import { IEncoder, ModelDetail } from "../utility";

export class OpenAiEncoder implements IEncoder {
    async encode(chunks: string[], model: string = 'text-embedding-3-small') {
        const embeddings = new OpenAIEmbeddings({
            openAIApiKey: env.OPENAI_API_KEY_EMBEDDING,
            batchSize: 100,
            model: model,
        });
        return embeddings.embedDocuments(chunks);
    }

    getModelDetail(model: string): ModelDetail | undefined {
        const modelDetails = new Map<string, ModelDetail>();
        modelDetails.set("text-embedding-3-small", {
            name: "OpenAI Text Embedding 3 Small",
            provider: "OpenAI",
            description: "A smaller version of OpenAI's text embedding model optimized for general-purpose text embeddings.",
            latency: "Low"
        });

        modelDetails.set("text-embedding-3-large", {
            name: "OpenAI Text Embedding 3 Large",
            provider: "OpenAI",
            description: "A larger version of OpenAI's text embedding model providing higher accuracy for complex text embeddings.",
            latency: "Medium"
        });

        return modelDetails.get(model);
    }
}