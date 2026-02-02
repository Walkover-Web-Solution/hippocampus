import express from 'express';
import { ApiError } from '../../error/api-error';
import { search } from '../../service/search';
import { v4 as uuidv4 } from 'uuid';
import redis from '../../config/redis';
import feedbackService from '../../service/feedback';

const router = express.Router();

router.post('/', async (req, res, next) => {
    try {
        const { query, collectionId, ownerId, resourceId, isReview, limit, minScore } = req.body;
        const topK = limit ? limit : 5;
        if (!query) {
            throw new ApiError('"query" is required in the request body.', 400);
        }
        if (!collectionId) throw new ApiError('"collectionId" is required in the request body.', 400);
        const result = await search(query, collectionId, { ownerId: ownerId, resourceId: resourceId, analytics: true, topK: topK, minScore });
        if (isReview) {
            const baseUrl = `${req.protocol}://${req.get('host')}/feedback/vote`;

            await Promise.all(result.map(async (item: any) => {
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
        }

        // Return top 5 results
        res.json({ result: result });
    } catch (error) {
        next(error);
    }
});



export default router;
