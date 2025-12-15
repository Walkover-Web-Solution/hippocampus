import { ChangeStream, MongoClient, ObjectId, Timestamp } from 'mongodb';
import mongoService from '../config/mongo';
import { Readable, Transform, TransformCallback } from 'stream';
import { pipeline } from 'stream/promises';
import { delay } from '../utility';
import logger from '../service/logger';
import { ChunkEvent, ChunkEventSchema, DeleteEventSchema, Event, EventSchema, LoadEvent, LoadEventSchema } from '../type/rag';
import rabbitmq from '../config/rabbitmq';
import producer from '../config/producer';
import { JobPointer } from '../service/utility';
import env from '../config/env';

const dbName = env.MONGO_DB_NAME || 'hippocampus';
export const ragSyncJob = async (jobName: string = "rag-sync") => {
    const pointer = await JobPointer.getPointer(jobName);
    mongoService().on("connect", async (connection: MongoClient) => {
        const collection = connection.db(dbName).collection('resources');
        const options: any = {
            fullDocument: 'updateLookup',
            batchSize: 1,
            startAfter: (pointer) ? { "_data": pointer } : null
        }
        const stream = collection.watch([], options);
        await handleResourceStream(stream, jobName);
    })
}

async function handleResourceStream(changeStream: ChangeStream, jobName: string) {
    const readableStream: Readable = changeStream.stream();
    try {
        await pipeline(readableStream, new FilterOutNull(), new FilterUpdate(['metadata']), new MetaData(), new PublishEvent(), new Pointer(jobName).on("data", (data) => {
            logger.info(data?.fullDocument?._id);
        }));
    } catch (error: any) {
        console.error(error);
        // TODO: Send Notification
        await delay(5000);
        process.exit(1);
    }
}


class Log extends Transform {
    private keys: string[] = new Array();
    constructor(keys?: string | string[], options: any = {}) {
        options.objectMode = true;
        super(options);
        if (typeof keys == "string") {
            this.keys = [keys]
        } else {
            this.keys = keys || [];
        };
    }

    async _transform(request: any, encoding: BufferEncoding, callback: TransformCallback): Promise<void> {
        let value = request;
        if (this.keys.length > 0) {
            for (let key of this.keys) {
                try {
                    value = value[key];
                } catch (error) {
                    logger.error(error);
                    value = value;
                }
            }
        }
        try {
            (typeof value == "object") ? logger.info(JSON.stringify(value)) : logger.info(value);

        } catch (error) {
            logger.error(error);
        }
        this.push(request);
        callback();
    }
}

class MetaData extends Transform {
    constructor(keys?: string | string[], options: any = {}) {
        options.objectMode = true;
        super(options);

    }

    async _transform(request: any, encoding: BufferEncoding, callback: TransformCallback): Promise<void> {
        const fullDocument = request.fullDocument;
        // const operationType = request.operationType;
        const resourceURL = fullDocument?.url;
        if (resourceURL) {
            const url = new URL(resourceURL);

            // Extract the domain (host)
            const domain = url.hostname;

            // Extract the file extension if it exists
            const pathname = url.pathname;
            const extension = pathname.includes(".") ? pathname?.split(".")?.pop() : 'html';
            request.metaData = { domain, extension: extension?.toLocaleLowerCase() };
        }
        this.push(request);
        callback();
    }
}

// Filter out specified keys
class FilterUpdate extends Transform {
    private filterKeys: Set<string> = new Set();
    constructor(keys?: string[], options: any = {}) {
        options.objectMode = true;
        super(options);
        this.filterKeys = new Set(keys || []);
    }

    async _transform(request: any, encoding: BufferEncoding, callback: TransformCallback): Promise<void> {
        const operationType = request.operationType;
        if (operationType != "update") {
            this.push(request);
        } else {
            const updatedFields = Object.keys(request.updateDescription?.updatedFields);
            const isFiltered = updatedFields.some((field) => this.filterKeys.has(field));
            if (!isFiltered) {
                this.push(request);
            }
        }
        callback();
    }
}

export class FilterOutNull extends Transform {
    constructor(options: any = {}) {
        options.objectMode = true;
        super(options);
    }

    async _transform(request: any, encoding: BufferEncoding, callback: TransformCallback): Promise<void> {
        const operationType = request.operationType;
        const fullDocument = request.fullDocument;
        if (fullDocument) {
            this.push(request);
        }
        callback();
    }
}


class PublishEvent extends Transform {
    constructor(keys?: string[], options: any = {}) {
        options.objectMode = true;
        super(options);

    }

    async _transform(request: any, encoding: BufferEncoding, callback: TransformCallback): Promise<void> {
        const operationType = request.operationType;
        const fullDocument = request.fullDocument;
        const url = fullDocument?.url;
        let events: Event[] = new Array<Event>();
        switch (operationType) {
            case "insert": {
                // Trigger LoadEvent if URL exists
                // Trigger ChunkEvent if content exists
                if (url) {
                    const loadEvent = {
                        event: "load",
                        data: {
                            resourceId: fullDocument._id?.toString(),
                            collectionId: fullDocument.collectionId?.toString(),
                            ownerId: fullDocument.ownerId,
                            url: url,
                            meta: {
                                domain: request.metaData?.domain,
                                extension: request.metaData?.extension
                            },
                            timestamp: Date.now()
                        }
                    };
                    events.push(LoadEventSchema.parse(loadEvent));
                } else if (fullDocument?.content) {
                    const chunkEvent = {
                        event: "chunk",
                        data: {
                            resourceId: fullDocument._id?.toString(),
                            collectionId: fullDocument.collectionId?.toString(),
                            content: fullDocument.content,
                            ownerId: fullDocument.ownerId,
                            public: fullDocument.public,
                            meta: {
                                domain: request.metaData?.domain,
                                extension: request.metaData?.extension
                            },
                            timestamp: Date.now()
                        }
                    };
                    events.push(ChunkEventSchema.parse(chunkEvent));
                }
                break;
            }
            case "update":
                const updatedFields = new Set(Object.keys(request.updateDescription?.updatedFields));
                // Trigger load if URL has changed
                const isUrlChanged = updatedFields.has("url");
                const isContentChanged = updatedFields.has("content");
                const isRefreshedAtChanged = updatedFields.has("refreshedAt");
                const isDeletedChanged = updatedFields.has("isDeleted");
                // Load document if URL changed or refreshedAt changed
                if (isUrlChanged || (url && isRefreshedAtChanged)) {
                    const loadEvent = {
                        event: "load",
                        data: {
                            resourceId: fullDocument._id?.toString(),
                            collectionId: fullDocument.collectionId?.toString(),
                            url: url,
                            ownerId: fullDocument.ownerId,
                            meta: {
                                domain: request?.metaData?.domain,
                                extension: request?.metaData?.extension
                            },
                            timestamp: Date.now()
                        }
                    };
                    events.push(LoadEventSchema.parse(loadEvent));
                }

                // If content changed, delete old chunks and create new chunks
                if (isContentChanged) {
                    // Delete Old Chunks
                    const deleteEvent = {
                        event: "delete",
                        data: {
                            resourceId: fullDocument._id?.toString(),
                            collectionId: fullDocument.collectionId?.toString(),
                            timestamp: Date.now()
                        }
                    }
                    events.push(DeleteEventSchema.parse(deleteEvent));

                    // Create New Chunks
                    const chunkEvent = {
                        event: "chunk",
                        data: {
                            resourceId: fullDocument._id?.toString(),
                            collectionId: fullDocument.collectionId?.toString(),
                            content: fullDocument.content,
                            public: fullDocument.public,
                            ownerId: fullDocument.ownerId,
                            meta: {
                                domain: request?.metaData?.domain,
                                extension: request?.metaData?.extension
                            },
                            timestamp: Date.now()
                        }
                    };
                    events.push(ChunkEventSchema.parse(chunkEvent));
                }
                // If isDeleted changed to true, trigger delete event
                if (isDeletedChanged && fullDocument.isDeleted) {
                    const deleteEvent = {
                        event: "delete",
                        data: {
                            resourceId: request.documentKey._id?.toString(),
                            collectionId: fullDocument.collectionId?.toString(),
                            timestamp: Date.now()
                        }
                    }
                    events.push(DeleteEventSchema.parse(deleteEvent));
                }

                break;
            default:

                break;
        }
        for (let event of events) {
            await producer.publishToQueue('rag', event);
        }
        this.push(request);
        callback();
    }
}


export class Pointer extends Transform {
    private jobName: string;
    constructor(jobName: string, options: any = {}) {
        options.objectMode = true;
        super(options);
        this.jobName = jobName;
    }

    async _transform(request: any, encoding: BufferEncoding, callback: TransformCallback): Promise<void> {
        JobPointer.setPointer(this.jobName, request._id?._data.toString());
        this.push(request);
        callback();
    }
}