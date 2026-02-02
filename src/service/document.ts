import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { OpenAIEmbeddings } from "@langchain/openai";
import env from "../config/env";
import { Chunk, ChunkSchema } from "../type/chunk";
import ChunkService from "../service/chunk";
import mongoose from "mongoose";
import { IEncoder, generateContentId } from "./utility";
import { Encoder } from "./encoder";
import { generateSparseEmbedding } from "./encoder/fast-embed";
import { deletePoints, insert } from "./qdrant";
import { v4 as uuidv4 } from 'uuid';
import producer from "../config/producer";
import _, { words } from "lodash";
import crypto from 'crypto';
import { ChunkingStrategy, DEFAULT_CHUNKING_STRATEGY } from "../type/collection";
import axios from "axios";
import { SemanticChunker } from "./semantic-chunker";
import { resolve } from "path";
type Metadata = {
    collectionId: string;
    ownerId?: string;
    [key: string]: any;
}

type ChunkingSetting = {
    size: number;
    overlap: number;
    strategy: ChunkingStrategy;
    url?: string;
    denseModel?: string;
}

export class Doc {
    private content?: string;
    private resourceId: string;
    private chunks: Array<Chunk>;
    private metadata?: Metadata;
    constructor(resourceId: string, content?: string, metadata?: Metadata) {
        this.content = content;
        this.resourceId = resourceId;
        this.metadata = metadata;
        this.chunks = [];
    }

    async chunk(setting: ChunkingSetting): Promise<this> {
        if (!this.content) throw new Error("Content is required for chunking");
        if (!this?.metadata?.collectionId) throw new Error("CollectionId is required for chunking");
        this.chunks = []

        let splits: any[] = [];
        let strategy = setting.strategy;
        if (this.content.length > 10000 && strategy == "semantic") strategy = "recursive";
        switch (strategy) {
            case "recursive": {
                const textSplitter = new RecursiveCharacterTextSplitter({
                    chunkSize: setting.size,
                    chunkOverlap: setting.overlap,
                });
                splits = await textSplitter.splitDocuments([{ pageContent: this.content, metadata: {} }]);
                break;
            }
            case "semantic": {
                const denseModel = setting.denseModel || "BAAI/bge-small-en-v1.5";
                const semanticChunker = new SemanticChunker({
                    denseModel,
                    minChunkSize: Math.max(50, Math.floor(setting.size * 0.1)),
                    maxChunkSize: setting.size,
                });
                const chunks = await semanticChunker.chunk(this.content);
                splits = chunks.map(chunk => ({ pageContent: chunk }));
                break;
            }
            case "custom": {
                if (!setting.url) {
                    throw new Error("Chunking URL is required for custom strategy");
                }
                try {
                    const response = await axios.post(setting.url, {
                        content: this.content,
                        resourceId: this.resourceId,
                        collectionId: this.metadata.collectionId,
                        metadata: this.metadata
                    }, { timeout: 60 * 1000 }); // 1 minute timeout

                    if (response.data && Array.isArray(response.data.chunks)) {
                        splits = response.data.chunks.map((chunk: { text: string, vectorSource?: string, metadata?: any }) => {
                            if (typeof chunk !== 'object') throw new Error("Invalid response format from custom chunking service. Expected { chunks: { text: string, vectorSource?: string }[] }");
                            if (chunk.metadata) {
                                chunk.metadata = ChunkSchema.pick({ metadata: true }).optional().parse(chunk.metadata);
                            }
                            return {
                                pageContent: chunk.text,
                                vectorSource: chunk.vectorSource,
                                metadata: chunk?.metadata
                            };
                        });
                    } else {
                        throw new Error("Invalid response format from custom chunking service. Expected { chunks: { text: string, vectorSource?: string }[] }");
                    }

                } catch (error: any) {
                    throw new Error(`Custom chunking failed: ${error.message}`);
                }
                break;
            }
            default: {
                console.warn(`Strategy ${setting.strategy} is not implemented yet. Defaulting to recursive.`);
                // Fallback to recursive for now
                const textSplitter = new RecursiveCharacterTextSplitter({
                    chunkSize: setting.size,
                    chunkOverlap: setting.overlap,
                });
                splits = await textSplitter.splitDocuments([{ pageContent: this.content, metadata: {} }]);
            }
        }

        for (const split of splits) {
            this.chunks.push({
                _id: uuidv4(),
                data: split.pageContent,
                vectorSource: split?.vectorSource,
                resourceId: this.resourceId,
                collectionId: this.metadata.collectionId,
                ownerId: this.metadata.ownerId || "public",
            });
        }
        return this;
    }

    async encode({ denseModel, sparseModel, rerankerModel }: any): Promise<this> {
        const chunkTexts = this.chunks.map((chunk) => chunk?.vectorSource || chunk.data);
        const encoder = new Encoder();
        const startTime = performance.now();
        const encodingTasks = [encoder.encode(chunkTexts, denseModel)];
        (sparseModel) ? encodingTasks.push(encoder.encodeSparse(chunkTexts, sparseModel)) : encodingTasks.push(new Promise((resolve) => resolve(undefined)));
        (rerankerModel) ? encodingTasks.push(encoder.encodeReranker(chunkTexts, rerankerModel)) : encodingTasks.push(new Promise((resolve) => resolve(undefined)));
        const [denseEmbedding, sparseEmbedding, lateInteractionEmbedding] = await Promise.all(encodingTasks);
        const embeddings = {
            denseVectors: denseEmbedding,
            sparseVectors: sparseEmbedding,
            rerankVectors: lateInteractionEmbedding,
        }

        const duration = Math.round(performance.now() - startTime);
        const totalWords = chunkTexts.reduce((sum, str) => sum + str.length, 0) / 5;
        const wordsPerSecond = parseFloat((totalWords / (duration / 1000)).toFixed(2));
        console.log(`Encoding ${this.chunks.length} chunks with (${denseModel} | ${sparseModel} | ${rerankerModel}) took ${duration}ms - ${wordsPerSecond}/wps`);
        this.chunks = this.chunks.map((chunk, index) => {
            chunk.vector = embeddings.denseVectors[index];
            chunk.sparseVector = embeddings.sparseVectors ? embeddings.sparseVectors[index] : undefined;
            chunk.rerankVector = embeddings.rerankVectors ? embeddings.rerankVectors[index] : undefined;
            return chunk;
        });
        return this;
    }

    // async save(storage: Storage): Promise<this> {
    //     await storage.save(this.chunks);
    //     return this;
    // }
    async store(keepDuplicate?: boolean): Promise<this> {
        const isLateInteractionEnabled = (this.chunks[0].rerankVector?.length) ? true : false;
        if (isLateInteractionEnabled) {
            // NOTICE: In case of late interaction reranker, vector size is too large to send in one go
            for (const chunk of this.chunks) {
                await producer.publish("chunk_exchange", {
                    action: "save",
                    collectionId: this.metadata?.collectionId,
                    resourceId: this.resourceId,
                    chunks: [chunk],
                    keepDuplicate
                });
            }
        } else {
            await producer.publish("chunk_exchange", {
                action: "save",
                collectionId: this.metadata?.collectionId,
                resourceId: this.resourceId,
                chunks: this.chunks,
                keepDuplicate
            });
        }

        return this;
    }

    // async delete(storage: Storage) {
    //     if (!this.metadata?.collectionId) throw new Error("CollectionId is required for deleting chunks");
    //     await storage.delete(this.metadata?.collectionId, this.resourceId);
    //     return this;
    // }
    async delete() {
        if (!this.metadata?.collectionId) throw new Error("CollectionId is required for deleting chunks");
        await producer.publish("chunk_exchange", {
            action: "delete",
            collectionId: this.metadata?.collectionId,
            resourceId: this.resourceId
        });
        return this;
    }
}


export interface Storage {
    save(chunks: Chunk[]): Promise<any>;
    delete(collectionId: string, resourceId: string): Promise<any>;
}






export class MongoStorage implements Storage {
    async save(chunks: Chunk[]) {
        return Promise.all(chunks.map(async (chunk) => await ChunkService.createChunk(chunk)));
    }

    async delete(collectionId: string, resourceId: string) {
        return ChunkService.deleteChunksByResource(resourceId);
    }
}

export class QdrantStorage implements Storage {
    async save(chunks: Chunk[], keepDuplicate: boolean = false) {
        const points = chunks.map((chunk) => {
            let vector: any = {
                dense: chunk.vector,
                sparse: chunk.sparseVector ? chunk.sparseVector : undefined,
                rerank: chunk.rerankVector ? chunk.rerankVector : undefined,
            };
            const content = chunk.data + (chunk?.vectorSource || "");
            return {
                id: keepDuplicate ? chunk._id : generateContentId(content, chunk.collectionId, chunk.ownerId || "public"),
                vector: vector,
                payload: {
                    resourceId: chunk.resourceId,
                    collectionId: chunk.collectionId,
                    content: chunk.data,
                    ownerId: chunk.ownerId,
                    metadata: chunk?.metadata
                }
            }
        });
        // Map chunks based on their collectionId
        const collectionMap: Record<string, Array<typeof points[0]>> = {};
        for (const point of points) {
            if (!point.vector) continue;
            const collectionId = point.payload.collectionId;
            if (!collectionMap[collectionId]) {
                collectionMap[collectionId] = [];
            }
            collectionMap[collectionId].push(point);
        }
        // Insert points into Qdrant based on their collectionId
        for (const collectionId in collectionMap) {
            const collectionName = `${collectionId}`;
            await insert(collectionName, collectionMap[collectionId] as any);
        }
    }

    async delete(collectionId: string, resourceId: string) {

        const collectionName = `${collectionId}`;
        const filter = {
            must: [
                {
                    key: "resourceId",
                    match: {
                        value: resourceId
                    }
                }
            ]
        };
        return deletePoints(collectionName, filter);
    }
}
