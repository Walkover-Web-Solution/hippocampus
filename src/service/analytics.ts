import bigquery from '../config/bigquery';
import env from '../config/env';
import logger from './logger';
import { AnalyticsQuery, AnalyticsResult } from '../type/analytics';
import { ApiError } from '../error/api-error';

const DATASET = env.BQ_DATASET;
const TABLE = env.BQ_TABLE;

/**
 * Queries BigQuery for search analytics data.
 *
 * Uses parameterized queries to prevent SQL injection.
 * Filters are applied conditionally — only non-null params are included in the WHERE clause.
 */
async function getSearchAnalytics(params: AnalyticsQuery): Promise<AnalyticsResult[]> {
    const { startDate, endDate, collectionId, ownerId, limit } = params;

    // Build WHERE conditions and query parameters dynamically
    const conditions: string[] = ['queryId != \'\''];
    const queryParams: Record<string, any> = {};

    // Date range: default to last 24 hours if not specified
    if (startDate) {
        conditions.push('ts > @startDate');
        queryParams.startDate = bigquery.timestamp(new Date(startDate));
    } else {
        conditions.push('ts > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)');
    }

    if (endDate) {
        conditions.push('ts <= @endDate');
        queryParams.endDate = bigquery.timestamp(new Date(endDate));
    }

    if (collectionId) {
        conditions.push('collectionId = @collectionId');
        queryParams.collectionId = collectionId;
    }

    if (ownerId) {
        conditions.push('ownerId = @ownerId');
        queryParams.ownerId = ownerId;
    }

    const whereClause = conditions.join('\n  AND ');

    const query = `
        SELECT
            ownerId,
            queryId,
            ARRAY_AGG(DISTINCT query LIMIT 5) as sample_queries,
            COUNT(*) as volume,
            ROUND(AVG( (SELECT MAX(s) FROM UNNEST(score) AS s) ), 2) as avg_relevance,
            CASE
                WHEN AVG( (SELECT MAX(s) FROM UNNEST(score) AS s) ) < 0.60 THEN TRUE
                ELSE FALSE
            END as is_content_gap
        FROM
            \`${DATASET}.${TABLE}\`
        WHERE
            ${whereClause}
        GROUP BY
            ownerId, queryId
        ORDER BY
            volume DESC
        LIMIT @limit
    `;
    queryParams.limit = limit;

    try {
        logger.info(`[ANALYTICS] Executing BigQuery query with params: ${JSON.stringify({
            startDate: startDate || '(last 24h)',
            endDate: endDate || '(now)',
            collectionId: collectionId || '(all)',
            ownerId: ownerId || '(all)',
            limit,
        })}`);

        const [rows] = await bigquery.query({
            query,
            params: queryParams,
        });

        return rows as AnalyticsResult[];
    } catch (error: any) {
        logger.error('[ANALYTICS] BigQuery query failed', error);
        throw new ApiError(`Analytics query failed: ${error.message}`, 500);
    }
}

export default {
    getSearchAnalytics,
};
