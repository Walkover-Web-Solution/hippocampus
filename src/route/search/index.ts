import express from 'express';
import { ApiError } from '../../error/api-error';
import { generateEmbedding } from '../../service/encoder/fast-embed';
import { search } from '../../service/qdrant';
import Collection from '../../service/collection'

const router = express.Router();

router.post('/', async (req, res, next) => {
    try {
        const { query, collectionId } = req.body;

        if (!query) {
            throw new ApiError('"query" is required in the request body.', 400);
        }
        if (!collectionId) throw new ApiError('"collectionId" is required in the request body.', 400);
        const collection = await Collection.getCollectionById(collectionId);
        const embedding = await generateEmbedding([query], collection?.settings?.encoder);
        const searchResult = await search(collectionId, embedding[0], 5);
        res.json({ result: searchResult });
    } catch (error) {
        next(error);
    }
});

// router.get('/', async (req, res, next) => {
//     try {
//         const query = req.query.q || req.query.query;
//         if (!query) {
//             throw new ApiError('"query" is required in the request body.', 400);
//         }
//         const embedding = await generateEmbedding([query as string], EmbeddingModel['bge-large-en']);
//         res.json({ result: embedding });
//     } catch (error) {
//         next(error);
//     }
// });

export default router;
