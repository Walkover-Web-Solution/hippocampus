import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { OpenAIEmbeddings } from "@langchain/openai";
import env from "../config/env";
import { Chunk } from "../type/chunk";
import ChunkService from "../service/chunk";
import mongoose from "mongoose";
import { IEncoder } from "./utility";
import { Encoder } from "./encoder";
import { generateSparseEmbedding } from "./encoder/fast-embed";
import { deletePoints, insert } from "./qdrant";
import { v4 as uuidv4 } from 'uuid';
import producer from "../config/producer";
import _ from "lodash";
import crypto from 'crypto';
type Metadata = {
    collectionId: string;
    ownerId?: string;
    [key: string]: any;
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

    async chunk(chunkSize: number, overlap: number = 0) {
        if (!this.content) throw new Error("Content is required for chunking");
        if (!this?.metadata?.collectionId) throw new Error("CollectionId is required for chunking");
        this.chunks = []

        const textSplitter = new RecursiveCharacterTextSplitter({
            chunkSize: chunkSize,
            chunkOverlap: overlap,
        });
        const splits = await textSplitter.splitDocuments([{ pageContent: this.content, metadata: {} }]);
        for (const split of splits) {
            this.chunks.push({
                _id: uuidv4(),
                data: split.pageContent,
                resourceId: this.resourceId,
                collectionId: this.metadata.collectionId,
                ownerId: this.metadata.ownerId || "public",
            });
        }
        return this;
    }

    async encode({ denseModel, sparseModel, rerankerModel }: any): Promise<this> {
        const chunkTexts = this.chunks.map((chunk) => chunk.data);
        const encoder = new Encoder();
        const startTime = performance.now();
        const embeddings = {
            denseVectors: await encoder.encode(chunkTexts, denseModel),
            sparseVectors: sparseModel ? await encoder.encodeSparse(chunkTexts, sparseModel) : undefined,
            rerankVectors: rerankerModel ? await encoder.encodeReranker(chunkTexts, rerankerModel) : undefined,
        }

        const duration = Math.round(performance.now() - startTime);
        console.log(`Encoding ${this.chunks.length} chunks with (${denseModel} | ${sparseModel} | ${rerankerModel}) took ${duration}ms`);
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
    async store(): Promise<this> {
        const isLateInteractionEnabled = (this.chunks[0].rerankVector?.length) ? true : false;
        if (isLateInteractionEnabled) {
            // NOTICE: In case of late interaction reranker, vector size is too large to send in one go
            for (const chunk of this.chunks) {
                await producer.publish("chunk_exchange", {
                    action: "save",
                    collectionId: this.metadata?.collectionId,
                    resourceId: this.resourceId,
                    chunks: [chunk]
                });
            }
        } else {
            await producer.publish("chunk_exchange", {
                action: "save",
                collectionId: this.metadata?.collectionId,
                resourceId: this.resourceId,
                chunks: this.chunks
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
    private generateContentId(text: string) {
        if (!text) return undefined;
        const hash = crypto.createHash('md5').update(text).digest('hex');
        return [
            hash.substring(0, 8),
            hash.substring(8, 12),
            hash.substring(12, 16),
            hash.substring(16, 20),
            hash.substring(20, 32)
        ].join('-');
    }
    async save(chunks: Chunk[]) {
        const points = chunks.map((chunk) => {
            let vector: any = {
                dense: chunk.vector,
                sparse: chunk.sparseVector ? chunk.sparseVector : undefined,
                rerank: chunk.rerankVector ? chunk.rerankVector : undefined,
            };

            return {
                id: this.generateContentId(chunk.data) || chunk._id,
                vector: vector,
                payload: {
                    resourceId: chunk.resourceId,
                    collectionId: chunk.collectionId,
                    content: chunk.data,
                    ownerId: chunk.ownerId
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
