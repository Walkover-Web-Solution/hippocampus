import express from 'express';
import AnalyticsService from '../../service/analytics';
import { AnalyticsQuerySchema } from '../../type/analytics';

const router = express.Router();

/**
 * GET /analytics
 *
 * Retrieve search analytics grouped by ownerId and queryId.
 *
 * Query Parameters:
 *   - startDate  (optional) ISO 8601 datetime. Defaults to 24 hours ago.
 *   - endDate    (optional) ISO 8601 datetime. Defaults to now.
 *   - collectionId (optional) Filter by collection ID.
 *   - ownerId    (optional) Filter by owner ID.
 *   - limit      (optional) Max results (1-1000, default 500).
 */
router.get('/', async (req, res, next) => {
    try {
        // Parse limit as a number if it's provided as a query string
        const rawQuery = {
            ...req.query,
            ...(req.query.limit !== undefined && { limit: Number(req.query.limit) }),
        };

        const validatedParams = await AnalyticsQuerySchema.parseAsync(rawQuery);
        const results = await AnalyticsService.getSearchAnalytics(validatedParams);

        res.json({
            results,
            metadata: {
                total: results.length,
                startDate: validatedParams.startDate || null,
                endDate: validatedParams.endDate || null,
                collectionId: validatedParams.collectionId,
                ownerId: validatedParams.ownerId,
                limit: validatedParams.limit,
            },
        });
    } catch (error) {
        next(error);
    }
});

export default router;
