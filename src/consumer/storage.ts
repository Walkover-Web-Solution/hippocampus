import { Channel } from "amqplib";
import { Chunk } from "../type/chunk";
import { MongoStorage, QdrantStorage } from "../service/document";
import rabbitmq from "../config/rabbitmq";
import producer from "../config/producer";
/**
 * QUESTION:
 * Why are we creating separate consumers for Mongo and Qdrant?
 * 
 * ANSWER:
 * Because we might have to save same chunks in multiple types of databases or 
 * in separate databases based on region or other factors to reduce latency and improve performance.
 * We can just add different consumers for each type of database or region as needed.
 * Writing to multiple dtabases from same consumer will make error handling and retries complex.
 * In this case, if a database is down for some time, it will not block the processing of messages
 * for other databases and data will be synced once the database is back up.
 */

const MONGO_QUEUE = "mongo-sync";
async function mongoStore(message: any, channel: Channel) {
    try {
        const msg = JSON.parse(message.content.toString());
        const action = msg.action;
        const collectionId = msg.collectionId;
        const resourceId = msg.resourceId;
        switch (action) {
            case "save": {
                const chunks: Chunk[] = msg.chunks;
                const storage = new MongoStorage();
                await storage.save(chunks);
                break;
            }
            case "delete": {
                const storage = new MongoStorage();
                await storage.delete(collectionId, resourceId);
                break;
            }
        }
        channel.ack(message);
    } catch (error) {
        console.error("Error processing mongoStore message:", error);
        const failedQueue = `${MONGO_QUEUE}-failed`;
        await producer.publishToQueue(failedQueue, message.content.toString());
        channel.ack(message);
    }

}

const QDRANT_USA_QUEUE = "qdrant-usa-sync";
async function qdrantUSAStore(message: any, channel: Channel) {
    try {
        const msg = JSON.parse(message.content.toString());
        const action = msg.action;
        const collectionId = msg.collectionId;
        const resourceId = msg.resourceId;
        switch (action) {
            case "save": {
                const chunks: Chunk[] = msg.chunks;
                const storage = new QdrantStorage();
                await storage.save(chunks);
                break;
            }
            case "delete": {
                const storage = new QdrantStorage();
                await storage.delete(collectionId, resourceId);
                break;
            }
        }
        channel.ack(message);
    } catch (error) {
        console.error("Error processing qdrantUSAStore message:", error);
        const failedQueue = `${QDRANT_USA_QUEUE}-failed`;
        await producer.publishToQueue(failedQueue, message.content.toString());
        channel.ack(message);
    }
}
const QDRANT_INDIA_QUEUE = "qdrant-india-sync";
async function qdrantIndiaStore(message: any, channel: Channel) {
    try {
        const msg = JSON.parse(message.content.toString());
        const action = msg.action;
        const collectionId = msg.collectionId;
        const resourceId = msg.resourceId;
        switch (action) {
            case "save": {
                const chunks: Chunk[] = msg.chunks;
                const storage = new QdrantStorage();
                await storage.save(chunks);
                break;
            }
            case "delete": {
                const storage = new QdrantStorage();
                await storage.delete(collectionId, resourceId);
                break;
            }
        }
        channel.ack(message);
    } catch (error) {
        console.error("Error processing qdrantIndiaStore message:", error);
        const failedQueue = `${QDRANT_INDIA_QUEUE}-failed`;
        await producer.publishToQueue(failedQueue, message.content.toString());
        channel.ack(message);
    }
}

export const mongoStoreConsumer = {
    queue: MONGO_QUEUE,
    processor: mongoStore,
    batch: 1
}

export const qdrantUSAStoreConsumer = {
    queue: QDRANT_USA_QUEUE,
    processor: qdrantUSAStore,
    batch: 1
}
export const qdrantIndiaStoreConsumer = {
    queue: QDRANT_INDIA_QUEUE,
    processor: qdrantIndiaStore,
    batch: 1
}