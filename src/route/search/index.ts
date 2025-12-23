import express from 'express';
import { ApiError } from '../../error/api-error';
import { generateEmbedding, generateLateInteractionEmbedding } from '../../service/encoder/fast-embed';
import { Encoder } from '../../service/encoder';
import { search, hybridSearch, rerank } from '../../service/qdrant';
import Collection from '../../service/collection'
import { v4 as uuidv4 } from 'uuid';
import redis from '../../config/redis';
import feedbackService from '../../service/feedback';
import adapterService from '../../service/adapter';

const router = express.Router();
const encoder = new Encoder();

router.post('/', async (req, res, next) => {
    try {
        const { query, collectionId, ownerId, resourceId, isReview } = req.body;

        if (!query) {
            throw new ApiError('"query" is required in the request body.', 400);
        }
        if (!collectionId) throw new ApiError('"collectionId" is required in the request body.', 400);
        const collection = await Collection.getCollectionById(collectionId);
        const denseModel = collection?.settings?.denseModel;
        const sparseModel = collection?.settings?.sparseModel;
        const rerankerModel = collection?.settings?.rerankerModel;

        const denseEmbeddingPromise = denseModel ? encoder.encode([query], denseModel) : Promise.resolve([]);
        const sparseEmbeddingPromise = sparseModel ? encoder.encodeSparse([query], sparseModel) : Promise.resolve(null);
        const rerankerEmbeddingPromise = rerankerModel ? encoder.encodeReranker([query], rerankerModel) : Promise.resolve(null);

        const [denseEmbedding, sparseEmbedding] = await Promise.all([denseEmbeddingPromise, sparseEmbeddingPromise]);

        // Apply adapter layer transformation to query vector if trained adapter exists
        // This morphs the query vector to better match relevant chunk vectors based on feedback training
        let transformedDenseEmbedding = denseEmbedding;
        if (denseEmbedding.length > 0) {
            try {
                const transformedVector = await adapterService.transformQuery(collectionId, denseEmbedding[0]);
                transformedDenseEmbedding = [transformedVector];
            } catch (adapterError) {
                // If adapter transformation fails, use original embedding
                console.error('Adapter transformation failed, using original embedding:', adapterError);
            }
        }

        // Filter Logic: "ownerId" (default: "global")
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
        if (resourceId) filter.must.push({ key: "resourceId", match: { value: resourceId } });

        let searchResult = (sparseEmbedding) ? await hybridSearch(collectionId, transformedDenseEmbedding[0], sparseEmbedding[0], 50, filter) : await search(collectionId, transformedDenseEmbedding[0], 50, filter);

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

        let finalResults = searchResult.slice(0, 10);

        if (isReview) {
            const baseUrl = `${req.protocol}://${req.get('host')}/feedback/vote`;

            await Promise.all(finalResults.map(async (item: any) => {
                const feedbackId = uuidv4();
                const feedbackContext = {
                    query,
                    collectionId,
                    chunkId: item.id, // Assuming item.id is the chunkId
                    resourceId: item?.payload?.resourceId,
                    ownerId: ownerId || "public"
                };

                // Store in Redis with 24 hour TTL (86400 seconds)
                await redis.cset(`hippocampus:feedback_context:${feedbackId}`, JSON.stringify(feedbackContext), 86400);

                item.feedback = {
                    upvoteUrl: `${baseUrl}/${feedbackId}/upvote`,
                    downvoteUrl: `${baseUrl}/${feedbackId}/downvote`
                };
            }));
        } else {
            const resultMap = new Map();
            for (const item of finalResults) {
                resultMap.set(item.id, item);
            }
            const colId = 'feedback_' + collectionId;
            const feedback = await search(colId, transformedDenseEmbedding[0], 1, filter);
            console.log(feedback)
            if (feedback.length >= 1) {
                const { id } = feedback[0];
                const metadata = await feedbackService.getFeedback(id as string);
                console.log(metadata);
                if (metadata)
                    for (const fb of metadata?.hits) {
                        const [key, value] = fb;
                        const result = resultMap.get(key);
                        if (result) {

                            result.score = value.count + result.score || 0;
                            console.log(result.score);
                        }
                    }
                finalResults = Array.from(resultMap.values()).sort((a, b) => b.score - a.score);
            }

        }

        // Return top 5 results
        res.json({ result: finalResults });
    } catch (error) {
        next(error);
    }
});


export default router;
