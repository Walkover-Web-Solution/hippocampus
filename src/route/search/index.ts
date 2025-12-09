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

        const denseEmbeddingPromise = denseModel ? encoder.encode([query], denseModel) : Promise.resolve([]);
        const sparseEmbeddingPromise = sparseModel ? encoder.encodeSparse([query], sparseModel) : Promise.resolve(null);
        const rerankerEmbeddingPromise = rerankerModel ? encoder.encodeReranker([query], rerankerModel) : Promise.resolve(null);

        const [denseEmbedding, sparseEmbedding] = await Promise.all([denseEmbeddingPromise, sparseEmbeddingPromise]);

        let searchResult = (sparseEmbedding) ? await hybridSearch(collectionId, denseEmbedding[0], sparseEmbedding[0], 50) : await search(collectionId, denseEmbedding[0], 50);

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
        // Return top 5 results
        res.json({ result: searchResult.slice(0, 5) });
    } catch (error) {
        next(error);
    }
});


export default router;
