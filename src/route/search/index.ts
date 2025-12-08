import express from 'express';
import { ApiError } from '../../error/api-error';
import { generateEmbedding, generateLateInteractionEmbedding } from '../../service/encoder/fast-embed';
import { Encoder } from '../../service/encoder';
import { search, hybridSearch, rerank } from '../../service/qdrant';
import Collection from '../../service/collection'

const router = express.Router();
const encoder = new Encoder();

router.post('/', async (req, res, next) => {
    try {
        const { query, collectionId } = req.body;

        if (!query) {
            throw new ApiError('"query" is required in the request body.', 400);
        }
        if (!collectionId) throw new ApiError('"collectionId" is required in the request body.', 400);
        const collection = await Collection.getCollectionById(collectionId);
        const denseModel = collection?.settings?.denseModel;
        const sparseModel = collection?.settings?.sparseModel;
        const rerankerModel = collection?.settings?.rerankerModel;
        const embedding = await generateEmbedding([query], denseModel);
        const sparseEmbedding = sparseModel && await encoder.encodeSparse([query], sparseModel);
        let searchResult = (sparseEmbedding) ? await hybridSearch(collectionId, embedding[0], sparseEmbedding[0], 50) : await search(collectionId, embedding[0], 50);

        // Reranking
        if (rerankerModel && searchResult.length > 0) {
            const lateInteractionEmbedding = await generateLateInteractionEmbedding([query], rerankerModel);
            // Candidates
            const candidateIds = searchResult.map((item: any) => item.id);
            // Rerank
            const rerankedResults = await rerank(collectionId, lateInteractionEmbedding[0], candidateIds, 5);
            // Reranked results
            searchResult = rerankedResults.map((item: any) => ({
                ...item,
                rerankScore: item.score
            }));
        }
        // Return top 5 results
        res.json({ result: searchResult.slice(0, 5) });
    } catch (error) {
        next(error);
    }
});


export default router;
