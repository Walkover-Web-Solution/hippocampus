import { Channel } from "amqplib";
import logger from "../service/logger";
import producer from "../config/producer";
import { denseSearch, insert } from "../service/qdrant";
import { generateContentId } from "../service/utility";
import redis from "../config/redis";

const ANALYTICS_QUEUE = "testing-analytics";

export const analyticsConsumer = {
    queue: ANALYTICS_QUEUE,
    processor: processAnalytics,
    batch: 1
}

type Payload = {
    id: string,
    collectionId: string,
    ownerId: string,
    query: string,
    embedding: number[],
    result?: {
        scores: number[]
    },
    rt: number,
    ts: Date,
    [key: string]: any
}

async function processAnalytics(message: any, channel: Channel) {
    try {
        const payload: Payload = JSON.parse(message.content.toString());
        /**
         * 1. Restrict users from creating ownerId which starts with _*
         * 2. Store unique queries in _queries ownerId (Relationship data will be store externally)
         */
        const collectionId = payload.collectionId;
        const denseEmbedding = payload.embedding;
        const filter = {
            must: [
                {
                    key: "ownerId",
                    match: {
                        value: "_queries"
                    }
                }
            ]
        }
        const result = await denseSearch(collectionId, denseEmbedding, 1, filter).catch((error) => []);
        const similarQuery = result.filter((query) => query.score >= 0.85);
        let queryId: string;
        if (similarQuery.length) {
            // Similar query already exists in database
            queryId = similarQuery[0].id as string;
            console.log(`Similar Query Exists: ${payload.query} -> ${similarQuery[0]?.payload?.content}`);
        } else {
            // Insert query in the database
            console.log(`Unique Query: ${payload.query}`);
            queryId = generateContentId(payload.query, collectionId, "_queries") || "";
            await insert(collectionId, [{ id: queryId, vector: { dense: denseEmbedding }, payload: { ownerId: "_queries", content: payload.query } }])
        }
        await trackQuery(collectionId, payload.ownerId, queryId);
        // Add additional data
        payload.queryId = queryId;
        payload.score = payload?.result?.scores;
        // console.log(payload)
        await producer.publishToQueue('analytics', JSON.stringify(payload));
        channel.ack(message);
    } catch (error) {
        logger.error(error);
        const failedQueue = `${ANALYTICS_QUEUE}-failed`
        await producer.publishToQueue(failedQueue, message?.content?.toString());
        channel.ack(message);
    }
}


const BUCKET_SIZE_SEC = 600; // 10 minutes
const RETENTION_SEC = 86400; // 24 hours

export async function trackQuery(collectionId: string, ownerId: string, queryId: string): Promise<void> {
    const bucket = Math.floor(Date.now() / 1000 / BUCKET_SIZE_SEC);

    const colKey = `hippocampus:trends:col:${collectionId}:${bucket}`;
    const ownKey = `hippocampus:trends:own:${ownerId}:${bucket}`;

    // Create a pipeline to send all commands in 1 network round-trip
    const batch = redis.multi();

    // 1. Update Collection
    batch.zIncrBy(colKey, 1, queryId);
    batch.expire(colKey, RETENTION_SEC);

    // 2. Update Owner
    batch.zIncrBy(ownKey, 1, queryId);
    batch.expire(ownKey, RETENTION_SEC);

    // Execute all
    await batch.exec();
}