import { z } from 'zod';

/**
 * Zod schema for analytics query parameters.
 * Validates and provides sensible defaults for the analytics API inputs.
 */
export const AnalyticsQuerySchema = z.object({
    /** Start of the date range (ISO 8601 string). Defaults to 24 hours ago. */
    startDate: z.string().datetime({ message: 'startDate must be a valid ISO 8601 datetime string' }).optional(),
    /** End of the date range (ISO 8601 string). Defaults to now. */
    endDate: z.string().datetime({ message: 'endDate must be a valid ISO 8601 datetime string' }).optional(),
    /** Filter by collection ID (maps to queryId prefix or collection context). */
    collectionId: z.string().min(1, 'collectionId must not be empty'),
    /** Filter by owner ID. */
    ownerId: z.string().min(1, 'ownerId must not be empty').optional(),
    /** Maximum number of grouped results to return. */
    limit: z.number().int().min(1).max(1000).default(500),
}).refine(
    (data) => {
        if (data.startDate && data.endDate) {
            return new Date(data.startDate) < new Date(data.endDate);
        }
        return true;
    },
    { message: 'startDate must be before endDate', path: ['startDate'] }
);

export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;

/**
 * Shape of a single analytics result row returned from BigQuery.
 */
export interface AnalyticsResult {
    ownerId: string;
    queryId: string;
    sample_queries: string[];
    volume: number;
    avg_relevance: number;
    is_content_gap: boolean;
}
