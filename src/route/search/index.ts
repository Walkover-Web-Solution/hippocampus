import express from 'express';
import { ApiError } from '../../error/api-error';
import { generateEmbedding, generateLateInteractionEmbedding } from '../../service/encoder/fast-embed';
import { Encoder } from '../../service/encoder';
import { denseSearch, hybridSearch, rerank } from '../../service/qdrant';
import Collection from '../../service/collection'
import { v4 as uuidv4 } from 'uuid';
import redis from '../../config/redis';
import logger from '../../service/logger';
import producer from '../../config/producer';
import { search } from '../../service/search';

const router = express.Router();

router.post('/', async (req, res, next) => {
    try {
        const { query, collectionId, ownerId, resourceId } = req.body;
        if (!query) {
            throw new ApiError('"query" is required in the request body.', 400);
        }
        if (!collectionId) throw new ApiError('"collectionId" is required in the request body.', 400);
        const result = await search(query, collectionId, { ownerId: ownerId, resourceId: resourceId, analytics: true }).catch((error) => []);
        // Return top 5 results
        res.json({ result: result.slice(0, 5) });
    } catch (error) {
        next(error);
    }
});



export default router;
