import { ChangeStream, Collection, Document, MongoClient, ObjectId, Timestamp } from 'mongodb';
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
// Replaying the gap left by a lost resume token is the right default; set to
// "false" to bring the stream back up without re-publishing the missed window.
const BACKFILL_ON_HISTORY_LOSS = process.env.RAG_SYNC_BACKFILL !== 'false';
const BACKFILL_BATCH_SIZE = 100;

export const ragSyncJob = async (jobName: string = "rag-sync") => {
    mongoService().on("connect", async (connection: MongoClient) => {
        const collection = connection.db(dbName).collection('resources');
        await watchResources(connection, collection, jobName);
    })
}

async function watchResources(connection: MongoClient, collection: Collection<Document>, jobName: string) {
    const pointer = await JobPointer.getPointer(jobName);
    const options: any = {
        fullDocument: 'updateLookup',
        batchSize: 1,
        startAfter: (pointer) ? { "_data": pointer } : null
    }
    const stream = collection.watch([], options);
    await handleResourceStream(stream, jobName, connection, collection, pointer);
}

// Mongo drops the resume point once it falls out of the oplog window. The token is
// then permanently unusable, so retrying it only crash-loops the job.
function isHistoryLost(error: any): boolean {
    return error?.code === 286
        || error?.codeName === 'ChangeStreamHistoryLost'
        || error?.errorLabelSet?.has?.('NonResumableChangeStreamError') === true;
}

// A resume token is hex; bytes 1-4 after the leading type byte are the cluster time.
export function resumeTokenTime(token?: string | null): Date | null {
    if (!token || token.length < 10) return null;
    const seconds = parseInt(token.slice(2, 10), 16);
    return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

async function handleResourceStream(changeStream: ChangeStream, jobName: string, connection: MongoClient, collection: Collection<Document>, pointer: string | null) {
    const readableStream: Readable = changeStream.stream();
    try {
        await pipeline(readableStream, new FilterOutNull(), new FilterUpdate(['metadata']), new MetaData(), new PublishEvent(), new Pointer(jobName).on("data", (data) => {
            logger.info(data?.fullDocument?._id);
        }));
    } catch (error: any) {
        if (isHistoryLost(error)) {
            const lostFrom = resumeTokenTime(pointer);
            logger.error(`[${jobName}] resume point ${lostFrom ? `from ${lostFrom.toISOString()} ` : ''}is no longer in the oplog. Dropping the token and restarting the stream.`);
            await JobPointer.clearPointer(jobName);
            await changeStream.close().catch(() => undefined);
            if (BACKFILL_ON_HISTORY_LOSS) {
                await backfillSince(connection, collection, lostFrom, jobName);
            } else {
                logger.warn(`[${jobName}] RAG_SYNC_BACKFILL=false, skipping replay of the missed window.`);
            }
            return watchResources(connection, collection, jobName);
        }
        console.error(error);
        // TODO: Send Notification
        await delay(5000);
        process.exit(1);
    }
}

// Resources changed while the stream was down never produced an event. Replay them
// through the same transforms the live stream uses, skipping any that already have
// chunks so a repeated recovery cannot duplicate them.
async function backfillSince(connection: MongoClient, collection: Collection<Document>, since: Date | null, jobName: string) {
    if (!since) {
        logger.warn(`[${jobName}] lost token carried no usable timestamp, cannot replay the missed window.`);
        return;
    }
    const chunks = connection.db(dbName).collection('chunks');
    const cursor = collection.find({ updatedAt: { $gte: since }, isDeleted: { $ne: true } }).sort({ updatedAt: 1 });
    let batch: Document[] = [];
    let seen = 0;
    let republished = 0;

    const flush = async () => {
        if (!batch.length) return;
        const ids = batch.map((doc) => doc._id?.toString());
        const alreadyChunked = new Set<string>(await chunks.distinct('resourceId', { resourceId: { $in: ids } }));
        const missed = batch.filter((doc) => !alreadyChunked.has(doc._id?.toString()));
        batch = [];
        if (!missed.length) return;
        await pipeline(
            Readable.from(missed.map((fullDocument) => ({ operationType: 'insert', fullDocument }))),
            new MetaData(),
            new PublishEvent(),
            async function (source: AsyncIterable<any>) { for await (const _ of source) { /* drain */ } }
        );
        republished += missed.length;
    };

    for await (const doc of cursor) {
        seen++;
        batch.push(doc);
        if (batch.length >= BACKFILL_BATCH_SIZE) await flush();
    }
    await flush();
    logger.warn(`[${jobName}] replayed ${republished} of ${seen} resources changed since ${since.toISOString()}.`);
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