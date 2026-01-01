import { generateEmbedding, generateLateInteractionEmbedding } from '../service/encoder/fast-embed';
import { Encoder } from '../service/encoder';
import { denseSearch, hybridSearch, rerank } from '../service/qdrant';
import Collection from '../service/collection'
import { v4 as uuidv4 } from 'uuid';
import redis from '../config/redis';
import logger from '../service/logger';
import producer from '../config/producer';
import feedbackService from './feedback';


interface SearchOptions {
    ownerId?: string;
    resourceId?: string;
    ignoreReranker?: boolean;
    ignoreKeywordSearch?: boolean;
    useFeedback?: boolean;
    analytics?: boolean;
    topK?: number;
}

const encoder = new Encoder();

export async function search(query: string, collectionId: string, options?: SearchOptions) {
    options = { ownerId: "public", analytics: false, topK: 5, useFeedback: false, ...options };
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
        const rankedResults = await rerank(collectionId, lateInteractionEmbedding[0], candidateIds, options.topK);
        // Reranked results
        searchResult = rankedResults;
    }

    // Integrate Human Feedback
    // TODO: Reduce response time of feedback integration by using caching and parallel/group/batch requests
    if (options.useFeedback) {
        const searchResultMap = new Map(searchResult.map((result) => [result.id, result]));
        const feedbackCollectionId = 'feedback_' + collectionId;
        const similarQueriesWithFeedback = (await denseSearch(feedbackCollectionId, denseEmbedding[0], 5, filter).catch(error => [])).filter((fb) => fb.score > 0.85);
        for (const similarQuery of similarQueriesWithFeedback) {
            const { id, score } = similarQuery;
            const feedback = await feedbackService.getFeedback(id as string);
            if (!feedback?.hits) continue;
            for (const hit of feedback.hits) {
                const [key, value] = hit;
                const result = searchResultMap.get(key);
                if (!result) continue;
                result.score = (Math.log(value.count) * score) + result.score || 0;
                console.log(result.score);
            }
        }
        searchResult = Array.from(searchResultMap.values()).sort((a, b) => b.score - a.score);
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