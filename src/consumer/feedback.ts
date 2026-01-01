import { Channel } from "amqplib";
import { Chunk } from "../type/chunk";
import { MongoStorage, QdrantStorage } from "../service/document";
import rabbitmq from "../config/rabbitmq";
import producer from "../config/producer";
import collectionService from "../service/collection";
import { generateEmbedding, generateSparseEmbedding } from "../service/encoder/fast-embed";
import { denseSearch, hybridSearch, insert } from "../service/qdrant";
import feedbackService from "../service/feedback";
import { generateContentId } from "../service/utility";
const FEEDBACK_QUEUE = "search-feedback";

type Payload = {
    query: string;
    chunkId: string;
    resourceId: string;
    action: "upvote" | "downvote";
    collectionId: string;
    ownerId: string;
}
async function processFeedback(message: any, channel: Channel) {
    try {
        const payload: Payload = JSON.parse(message.content.toString());
        const action = payload.action;
        const collectionId = payload.collectionId;
        const resourceId = payload.resourceId;
        const chunkId = payload.chunkId;
        const userQuery = payload.query;
        const ownerId = payload.ownerId;
        const collection = await collectionService.getCollectionById(collectionId);
        if (!collection) {
            throw new Error(`Collection with ID ${collectionId} not found.`);
        }
        const denseModel = collection.settings.denseModel;
        if (!denseModel) throw new Error("Dense model is not defined for the collection.");
        const sparseModel = collection.settings.sparseModel;
        const denseEmbedding = await generateEmbedding([userQuery], denseModel);
        const sparseEmbedding = sparseModel ? await generateSparseEmbedding([userQuery], sparseModel) : null;
        // Step 3: Check for similar query is in Qdrant
        const feedbackCollectionName = `feedback_${collectionId}`;
        // TODO : Maybe we can update the feedback for all the queries with score > 0.9 not just one
        const filter = {
            must: [
                {
                    key: "ownerId",
                    match: {
                        value: ownerId || "public"
                    }
                }
            ]
        };
        const result = sparseEmbedding ?
            await hybridSearch(feedbackCollectionName, denseEmbedding[0], sparseEmbedding[0], 1, filter).catch((error) => []) :
            await denseSearch(feedbackCollectionName, denseEmbedding[0], 1, filter).catch((error) => []);
        let feedbackId: any = result.length > 0 && result[0].score > 0.9 ? result[0].id : null;
        const feedback = await feedbackService.getFeedback(feedbackId).catch(error => undefined);
        if (!feedback) {
            feedbackId = generateContentId(userQuery, collectionId, ownerId);
            const vector = { dense: denseEmbedding[0], sparse: sparseEmbedding ? sparseEmbedding[0] : undefined };
            await insert(feedbackCollectionName, [{ id: feedbackId, vector: vector, payload: { collectionId, ownerId } }]);
            await feedbackService.createFeedback(
                feedbackId,
                collectionId,
                userQuery,
                ownerId
            );

        }
        await feedbackService.addFeedback(feedbackId, chunkId, resourceId, action);
        channel.ack(message);
    } catch (error) {
        console.error("Error processing feedback:", error);
        const failedQueue = `${FEEDBACK_QUEUE}-failed`;
        await producer.publishToQueue(failedQueue, message.content.toString());
        channel.ack(message);
    }
}


export const feedbackConsumer = {
    queue: FEEDBACK_QUEUE,
    processor: processFeedback,
    batch: 1
}