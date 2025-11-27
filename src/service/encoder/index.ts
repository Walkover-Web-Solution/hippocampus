import { FastEmbedEncoder } from "./fast-embed";
import { OpenAiEncoder } from "./openai";

export class Encoder {
    private states: { [key: string]: any };
    constructor() {
        this.states = {
            'text-embedding-3-large': new OpenAiEncoder(),
            'text-embedding-3-small': new OpenAiEncoder(),
            'BAAI/bge-small-en-v1.5': new FastEmbedEncoder(),
            'BAAI/bge-large-en-v1.5': new FastEmbedEncoder(),
            'sentence-transformers/all-MiniLM-L6-v2': new FastEmbedEncoder(),
            'intfloat/multilingual-e5-large': new FastEmbedEncoder(),
            'jinaai/jina-embeddings-v2-base-code': new FastEmbedEncoder(),
        }
    }

    public getModels() {
        return Object.keys(this.states).map((model) => {
            const details = this.states[model].getModelDetail ? this.states[model].getModelDetail(model) : null;
            return {
                id: model,
                name: model,
                ...details
            }
        });
    }
    public isValid(model: string) {
        return Object.keys(this.states).includes(model);
    }

    async encode(chunks: string[], model: string) {
        const encoder = this.states[model];
        if (!encoder) throw new Error(`Encoder model ${model} not supported`);
        return encoder.encode(chunks, model);
    }
}