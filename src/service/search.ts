import { generateEmbedding, generateLateInteractionEmbedding } from '../service/encoder/fast-embed';
import { Encoder } from '../service/encoder';
import { denseSearch, hybridSearch, rerank } from '../service/qdrant';
import Collection from '../service/collection'
import { v4 as uuidv4 } from 'uuid';
import redis from '../config/redis';
import logger from '../service/logger';
import producer from '../config/producer';


interface SearchOptions {
    ownerId?: string;
    resourceId?: string;
    ignoreReranker?: boolean;
    ignoreKeywordSearch?: boolean;
    analytics?: boolean;
    topK?: number;
}

const encoder = new Encoder();

export async function search(query: string, collectionId: string, options?: SearchOptions) {
    options = { ownerId: "public", analytics: false, topK: 5, ...options };
    const start = performance.now();
    const collection = await Collection.getCollectionById(collectionId);
    const denseModel = collection?.settings?.denseModel;
    const sparseModel = collection?.settings?.sparseModel;
    const rerankerModel = collection?.settings?.rerankerModel;

    const denseEmbeddingPromise = denseModel ? encoder.encode([query], denseModel) : Promise.resolve([]);
    const sparseEmbeddingPromise = sparseModel ? encoder.encodeSparse([query], sparseModel) : Promise.resolve(null);
    const rerankerEmbeddingPromise = rerankerModel ? encoder.encodeReranker([query], rerankerModel) : Promise.resolve(null);

    const [denseEmbedding, sparseEmbedding] = await Promise.all([denseEmbeddingPromise, sparseEmbeddingPromise]);

    // Filter Logic: "ownerId" (default: "global")
    const filter = {
        must: [
            {
                key: "ownerId",
                match: {
                    value: options.ownerId || "public"
                }
            }
        ]
    };
    if (options.resourceId) filter.must.push({ key: "resourceId", match: { value: options.resourceId } });

    let searchResult = (sparseEmbedding) ? await hybridSearch(collectionId, denseEmbedding[0], sparseEmbedding[0], 50, filter) : await denseSearch(collectionId, denseEmbedding[0], 50, filter);

    const lateInteractionEmbedding = await rerankerEmbeddingPromise;

    // Reranking
    if (rerankerModel && lateInteractionEmbedding && searchResult.length > 0) {
        // Candidates
        const candidateIds = searchResult.map((item: any) => item.id);
        // Rerank
        const rerankedResults = await rerank(collectionId, lateInteractionEmbedding[0], candidateIds, 5);
        // Reranked results
        searchResult = rerankedResults;
    }

    const analyticsData = {
        "id": uuidv4(),
        collectionId: collectionId,
        ownerId: options.ownerId,
        query: query,
        rt: (performance.now() - start).toFixed(0),
        ts: (Date.now() / 1000).toFixed(0)
    };
    if (options.analytics) producer.publishToQueue("analytics", analyticsData);
    return searchResult;
}