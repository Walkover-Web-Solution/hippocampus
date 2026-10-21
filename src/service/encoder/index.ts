import { FastEmbedEncoder, SparseEncoder, Reranker } from "./fast-embed";
import { OpenAiEncoder } from "./openai";
import { EmbeddingKind } from "../utility";

export class Encoder {
    private states: { [key: string]: any };
    private sparseStates: { [key: string]: any };
    private rerankerStates: { [key: string]: any };

    constructor() {
        this.states = {
            'text-embedding-3-large': new OpenAiEncoder(),
            'text-embedding-3-small': new OpenAiEncoder(),
            'google/embeddinggemma-300m': new FastEmbedEncoder(),
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

    // The vector size a dense model produces, when known; a wrong configured size is then caught before any data is written.
    public getDimensions(model: string): number | undefined {
        const encoder = this.states[model];
        return encoder?.getModelDetail ? encoder.getModelDetail(model)?.dimensions : undefined;
    }

    // `kind` says whether the texts are queries or documents; models trained with prefixes need it.
    async encode(chunks: string[], model: string, kind: EmbeddingKind = 'document') {
        const encoder = this.states[model];
        if (!encoder) throw new Error(`Encoder model ${model} not supported`);
        return encoder.encode(chunks, model, kind);
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

}