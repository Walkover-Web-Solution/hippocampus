import redis from "../config/redis";
import crypto from 'crypto';
type StatusMessage = 'success' | 'error';
/**
 * This class helps to build a response object that can be sent back to the client.
 * Why use a class?
 * -> Helps in building a response object in a structured and consistant way
 * -> Response validation can be done in a single place
 * -> Easy to change response format in future
 * -> Easy to add new features like pagination, metadata etc.
 */
export class APIResponseBuilder {
    private status: StatusMessage;
    private isSuccess: boolean;
    private message: any;
    private data: any;
    private code: number;

    constructor() {
        this.status = 'success';
        this.code = 200;
        this.message = null;
        this.isSuccess = true;
        this.data = null;
    }

    setMeta(meta: any) {
        this.data = {
            ...this.data,
            meta,
        };
        return this;
    }
    setSuccess(data?: object, code: number = 200) {
        this.code = code;
        if (typeof data === 'object' && !Array.isArray(data) && data !== null) {
            this.data = data;
        } else {
            throw new Error('Data must be undefined or an object');
        }
        this.isSuccess = true;
        return this;

    }
    setError(message: string, code: number = 400) {
        if (typeof message !== 'string') {
            throw new Error('Message must be a string');
        }
        this.code = code;
        this.message = message;
        this.status = 'error';
        this.isSuccess = false;
        return this;
    }
    build() {

        return {
            status: this.status,
            message: this.message,
            data: this.data,
            success: this.isSuccess
        };
    }
}


export function getDefaultPicture(name: string) {
    return `https://ui-avatars.com/api/?name=${name}&background=random`
}



const pointerKey = (jobName: string) => `hippocampus:pointer:${jobName}`;
export class JobPointer {

    static async getPointer(jobName: string): Promise<string | null> {
        const pointer = await redis.get(pointerKey(jobName));
        return pointer || null;
    }
    static async setPointer(jobName: string, pointer: string) {
        redis.set(pointerKey(jobName), pointer);
    }
}


export interface ContentLoader {
    getContent(url: string, options?: { [key: string]: any }): Promise<string>;
}


export type ModelDetail = { name: string; provider: string; description: string; latency: string; }
export interface IEncoder {
    encode(chunks: string[], model?: string): Promise<any>;
    getModelDetail(model: string): ModelDetail | undefined;
}


export function generateContentId(text: string, collectionId: string, ownerId: string) {
    if (!text) return undefined;
    const input = `${collectionId}:${ownerId}:${text}`;
    const hash = crypto.createHash('md5').update(input).digest('hex');
    return [
        hash.substring(0, 8),
        hash.substring(8, 12),
        hash.substring(12, 16),
        hash.substring(16, 20),
        hash.substring(20, 32)
    ].join('-');
}