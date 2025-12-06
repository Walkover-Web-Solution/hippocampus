import { FastEmbedEncoder, SparseEncoder, Reranker } from "./fast-embed";
import { OpenAiEncoder } from "./openai";

export class Encoder {
    private states: { [key: string]: any };
    private sparseStates: { [key: string]: any };
    private rerankerStates: { [key: string]: any };

    constructor() {
        this.states = {
            'text-embedding-3-large': new OpenAiEncoder(),
            'text-embedding-3-small': new OpenAiEncoder(),
            'BAAI/bge-small-en-v1.5': new FastEmbedEncoder(),
            'BAAI/bge-large-en-v1.5': new FastEmbedEncoder(),
            'sentence-transformers/all-MiniLM-L6-v2': new FastEmbedEncoder(),
            'intfloat/multilingual-e5-large': new FastEmbedEncoder(),
            'jinaai/jina-embeddings-v2-base-code': new FastEmbedEncoder(),
        };
        this.sparseStates = {
            'prithivida/Splade_PP_en_v1': new SparseEncoder(),
            'Qdrant/bm25': new SparseEncoder(),
        };
        this.rerankerStates = {
            'colbert-ir/colbertv2.0': new Reranker(),
            'jinaai/jina-colbert-v2': new Reranker(),
            'answerdotai/answerai-colbert-small-v1': new Reranker(),
        };
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

    public getSparseModels() {
        return Object.keys(this.sparseStates).map((model) => {
            const details = this.sparseStates[model].getModelDetail ? this.sparseStates[model].getModelDetail(model) : null;
            return {
                id: model,
                name: model,
                ...details
            }
        });
    }

    public getRerankerModels() {
        return Object.keys(this.rerankerStates).map((model) => {
            const details = this.rerankerStates[model].getModelDetail ? this.rerankerStates[model].getModelDetail(model) : null;
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
    
    public isValidSparse(model: string) {
        return Object.keys(this.sparseStates).includes(model);
    }

    public isValidReranker(model: string) {
        return Object.keys(this.rerankerStates).includes(model);
    }

    async encode(chunks: string[], model: string) {
        const encoder = this.states[model];
        if (!encoder) throw new Error(`Encoder model ${model} not supported`);
        return encoder.encode(chunks, model);
    }

    async encodeSparse(chunks: string[], model: string) {
        const encoder = this.sparseStates[model];
        if (!encoder) throw new Error(`Sparse encoder model ${model} not supported`);
        return encoder.encode(chunks, model);
    }

    async encodeReranker(chunks: string[], model: string) {
        const encoder = this.rerankerStates[model];
        if (!encoder) throw new Error(`Reranker model ${model} not supported`);
        return encoder.encode(chunks, model);
    }

    async rerank(query: string, documents: string[], model: string) {
        const reranker = this.rerankerStates[model];
        if (!reranker) throw new Error(`Reranker model ${model} not supported`);
        return reranker.rerank(query, documents, model);
    }
}