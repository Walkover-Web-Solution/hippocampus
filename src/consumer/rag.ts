import { Channel } from '../config/rabbitmq';
import logger from "../service/logger";
import producer from '../config/producer';
import rtlayer from '../config/rtlayer';
import { EventSchema, VERSION } from '../type/rag';
import { delay } from '../utility';
import { DocumentLoader } from '../service/document-loader';
import ResourceService from '../service/resource';
import CollectionService from '../service/collection';
import { Doc, MongoStorage, QdrantStorage } from '../service/document';
import env from '../config/env';
import { DEFAULT_CHUNKING_STRATEGY } from '../type/collection';


const QUEUE_NAME = process.env.RAG_QUEUE || 'rag';
async function processMsg(message: any, channel: Channel) {
    let resourceId: string = '';
    try {
        const msg = JSON.parse(message.content.toString());
        const { version, event, data } = EventSchema.parse(msg);
        resourceId = data.resourceId;
        console.log(`Event: ${event}`);
        let pipelineStatus = null;
        switch (event) {
            case 'load':
                const loader = new DocumentLoader();
                const content = await loader.getContent(data.url);
                const { content: oldContent } = await ResourceService.getResourceById(data.resourceId);
                // TODO: Can we change the final status as "done"
                if (oldContent === content) {
                    pipelineStatus = "chunked";
                    break;
                }
                await ResourceService.updateResource(data.resourceId, { content });
                pipelineStatus = "loaded";
                break;
            case 'chunk': {
                const doc = new Doc(data.resourceId, data.content, { collectionId: data.collectionId, ownerId: data.ownerId });
                // TODO: Choose encoder and chunking strategy based on collection settings
                const collection = await CollectionService.getCollectionById(data.collectionId);
                if (!collection) throw new Error("Collection not found");

                const resource = await ResourceService.getResourceById(data.resourceId);
                const resourceSettings = resource?.settings;

                const { denseModel, chunkOverlap, chunkSize, sparseModel, rerankerModel, strategy, chunkingUrl } = collection.settings;

                const finalChunkSize = resourceSettings?.chunkSize || chunkSize || 512;
                const finalChunkOverlap = resourceSettings?.chunkOverlap || chunkOverlap || 50;
                const finalStrategy = resourceSettings?.strategy || strategy || DEFAULT_CHUNKING_STRATEGY;
                const finalChunkingUrl = resourceSettings?.chunkingUrl || chunkingUrl;

                const chunkedDocument = await doc.chunk(finalChunkSize, finalChunkOverlap, finalStrategy, finalChunkingUrl);
                await chunkedDocument.encode({
                    denseModel: denseModel,
                    sparseModel: sparseModel,
                    rerankerModel: rerankerModel
                });
                await chunkedDocument.store();
                // await updateDescription(data?.resourceId, data?.content).catch(error => logger.error(error));
                pipelineStatus = "chunked";
                break;
            }
            case 'update':
                {
                    // TODO: Change the visibility of the resource
                    break;
                }
            case 'delete': {
                const doc = new Doc(data.resourceId, undefined, { collectionId: data.collectionId });
                await doc.delete();
                pipelineStatus = "deleted";
                break;
            }
            default:
                {
                    logger.error(`[message] Unknown event type: ${event}`);
                    throw new Error(`Unknown event type: ${event}`);
                    break;
                }
        }
        if (pipelineStatus) {
            await ResourceService.updateMetadata(data.resourceId, { status: pipelineStatus }).catch(error => console.log(error));
            await rtlayer.message(JSON.stringify({ id: data?.resourceId, status: pipelineStatus }), { channel: "resource" }).catch(error => logger.error(error));
        }
        channel.ack(message);
    } catch (error: any) {
        console.log(error);
        // TODO: Add error message to the failed message
        producer.publishToQueue(QUEUE_NAME + "_FAILED", message.content.toString());
        if (resourceId) {
            await ResourceService.updateMetadata(resourceId, { status: 'error', message: error?.message }).catch(error => console.log(error));
            await rtlayer.message(JSON.stringify({ id: resourceId, status: 'error', message: error?.message }), { channel: "resource" }).catch(error => logger.error(error));
        }
        logger.error(`[message] Error processing message: ${error.message}`);
        channel.ack(message);
    }

}

export default {
    queue: QUEUE_NAME,
    processor: processMsg,
    batch: 1
}


// async function updateDescription(resourceId: string, content: string) {
//     // Generate description
//     const aiMiddleware = new AIMiddlewareBuilder(env.AI_MIDDLEWARE_AUTH_KEY);
//     const descriptionGenerator = aiMiddleware.useBridge("676febfe9768bd87271d3e3e").useOpenAI("gpt-4o-mini").build();
//     const description = await descriptionGenerator.sendMessage(content);
//     await ResourceService.updateResource(resourceId, { description });
// }