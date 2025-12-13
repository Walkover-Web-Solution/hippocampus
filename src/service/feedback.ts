import { Feedback } from '../models/feedback';
import { Feedback as FeedbackType } from '../type/feedback';

const FEEDBACK_COLLECTION_PREFIX = 'feedback_';

class FeedbackService {

    public getFeedbackCollectionName(collectionId: string) {
        return `${FEEDBACK_COLLECTION_PREFIX}${collectionId}`;
    }

    async getFeedback(feedbackId: string) {
        // TODO : Cache feedback retrievals if needed
        return await Feedback.findById(feedbackId);
    }

    async createFeedback(id: string, collectionId: string, query: string, ownerId: string): Promise<FeedbackType> {
        const feedback = new Feedback({
            _id: id,
            collectionId,
            query,
            ownerId,
            hits: new Map()
        });
        await feedback.save();
        return feedback as FeedbackType;
    }

    async addFeedback(feedbackId: string, chunkId: string, resourceId: string, action: 'upvote' | 'downvote') {
        const feedback = await Feedback.findById(feedbackId);

        if (!feedback) {
            throw new Error(`Feedback with ID ${feedbackId} not found. Cannot add feedback to non-existent session.`);
        }

        const delta = action === 'upvote' ? 1 : -1;
        const hit = feedback.hits.get(chunkId);

        if (hit) {
            hit.count += delta;
        } else {
            feedback.hits.set(chunkId, {
                chunkId,
                resourceId,
                count: delta
            });
        }

        await feedback.save();
        return feedback;
    }


    /**
     * Fuses feedback scores into search results.
     */
    async fuseFeedback(searchResults: any[], feedbackResults: any[]) {
        // Create a map of ChunkID -> Boost Score
        const boostMap = new Map<string, number>();

        for (const res of feedbackResults) {
            // 'res' is a Qdrant point from the feedback collection
            // The similarity score (res.score) tells us how relevant this past query is to current query.
            const querySimilarity = res.score; // 0 to 1
            const hits = res.payload?.topHits || [];

            for (const hit of hits) {
                // Decay: Past queries that are less similar should have less influence
                // Logarithmic: Diminishing returns on raw feedback count
                const logScore = Math.log10(hit.count + 1);

                // Final Boost = QuerySimilarity * Log(FeedbackScore)
                const boost = querySimilarity * logScore;

                const currentBoost = boostMap.get(hit.chunkId) || 0;
                // Accumulate boost (or take max? Accumulating is usually better for multi-query consensus)
                boostMap.set(hit.chunkId, currentBoost + boost);
            }
        }

        // Apply Boost to current Search Results
        // Note: 'searchResults' are Qdrant points (or reranked items).
        // If they are Qdrant points, score is under 'score'.

        // We need to normalize current scores first? 
        // Or just add the boost (assuming vector scores are approx 0-1 range).
        // Reranker scores can be any range (logits), usually -10 to 10.
        // Vector cosine is -1 to 1.

        const fusedResults = searchResults.map(result => {
            const chunkId = result.payload?.chunkId || result.id; // Adjust based on your schema
            const boost = boostMap.get(chunkId) || 0;

            // Weighting: How much should feedback matter? 
            // Let's say 20% weight.
            const feedbackWeight = 0.2;

            return {
                ...result,
                originalScore: result.score,
                feedbackBoost: boost,
                score: result.score + (boost * feedbackWeight)
            };
        });

        // Re-sort
        fusedResults.sort((a, b) => b.score - a.score);
        return fusedResults;
    }
}

const feedbackService = new FeedbackService();

export default feedbackService;