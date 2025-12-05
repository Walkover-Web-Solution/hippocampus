import express from 'express';
import { ApiError } from '../../error/api-error';
import { generateEmbedding } from '../../service/encoder/fast-embed';
import { Encoder } from '../../service/encoder';
import { search, hybridSearch } from '../../service/qdrant';
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
        
        const denseModel = collection?.settings?.denseModel || collection?.metadata?.embedding;
        const sparseModel = collection?.settings?.sparseModel; // Now a string (model name)
        const rerankerModel = collection?.settings?.rerankerModel;

        const embedding = await generateEmbedding([query], denseModel);

        let searchResult;
        if (sparseModel) {
             const sparseEmbedding = await encoder.encodeSparse([query], sparseModel);
             // Note: sparseEmbedding return type from encodeSparse might need adjustment to match expected format
             // But for now assuming it returns array of {indices, values}
             searchResult = await hybridSearch(collectionId, embedding[0], sparseEmbedding[0], 50); // Fetch more for reranking
        } else {
             searchResult = await search(collectionId, embedding[0], 50);
        }

        // Reranking
        if (rerankerModel && searchResult.length > 0) {
            const documents = searchResult.map((item: any) => item?.payload?.content || "");
            const rerankScores = await encoder.rerank(query, documents, rerankerModel);
            
            // Assign scores and sort
            searchResult = searchResult.map((item: any, index: number) => ({
                ...item,
                score: rerankScores[index], // Overwrite score or add new field? Usually replace or add 'rerankScore'
                rerankScore: rerankScores[index]
            })).sort((a: any, b: any) => b.rerankScore - a.rerankScore);
        }
        
        // Return top 5 after reranking
        res.json({ result: searchResult.slice(0, 5) });
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
