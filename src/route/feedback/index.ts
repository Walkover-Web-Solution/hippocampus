import express, { Request, Response, NextFunction } from 'express';
import { ApiError } from '../../error/api-error';
import producer from '../../config/producer';
import redis from '../../config/redis';

const router = express.Router();
const FEEDBACK_QUEUE = "search-feedback";

// POST /feedback/vote
export const voteHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { collectionId, query, chunkId, resourceId, action, ownerId } = req.body;

        if (!collectionId || !query || !chunkId || !resourceId || !action) {
            throw new ApiError('Missing required fields: collectionId, query, chunkId, resourceId, action', 400);
        }

        if (action !== 'upvote' && action !== 'downvote') {
            throw new ApiError('Invalid action. Must be "upvote" or "downvote"', 400);
        }

        const payload = {
            query,
            chunkId,
            resourceId,
            action,
            collectionId,
            ownerId: ownerId || "public"
        };

        // Publish the feedback to the RabbitMQ queue "search-feedback"
        await producer.publishToQueue(FEEDBACK_QUEUE, payload);

        res.json({ success: true, message: 'Feedback received' });
    } catch (error) {
        next(error);
    }
};

// GET /feedback/vote/:referenceId/:action
export const voteViaUrlHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { referenceId, action } = req.params;

        if (!referenceId || !action) {
            throw new ApiError('Missing required parameters: referenceId, action', 400);
        }

        if (action !== 'upvote' && action !== 'downvote') {
            throw new ApiError('Invalid action. Must be "upvote" or "downvote"', 400);
        }

        // Retrieve context from Redis
        const contextStr = await redis.cget(`hippocampus:feedback_context:${referenceId}`);
        if (!contextStr) {
            throw new ApiError('Invalid or expired feedback link', 404);
        }

        const context = JSON.parse(contextStr);

        const payload = {
            query: context.query,
            chunkId: context.chunkId,
            resourceId: context.resourceId,
            action,
            collectionId: context.collectionId,
            ownerId: context.ownerId || "public"
        };

        // Publish the feedback to the RabbitMQ queue "search-feedback"
        await producer.publishToQueue(FEEDBACK_QUEUE, payload);

        res.send(`
            <html>
                <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
                    <h1 style="color: green;">Thank you!</h1>
                    <p>Your <strong>${action}</strong> has been recorded.</p>
                </body>
            </html>
        `);
    } catch (error) {
        next(error);
    }
};

router.post('/vote', voteHandler);
router.get('/vote/:referenceId/:action', voteViaUrlHandler);

export default router;
