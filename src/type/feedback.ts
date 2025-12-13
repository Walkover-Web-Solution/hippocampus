import { z } from 'zod';
import { Schema } from 'mongoose';

export const FeedbackChunkSchema = z.object({
    chunkId: z.string(), // Qdrant chunk ID or hash of the chunk
    resourceId: z.string(),
    count: z.number().default(1),
});

export const FeedbackSchema = z.object({
    _id: z.string().optional(),
    query: z.string().max(1000),
    collectionId: z.custom<Schema.Types.ObjectId>(),
    ownerId: z.string().default("public"),
    hits: z.map(z.string(), FeedbackChunkSchema).default(new Map()),
    updatedAt: z.date().optional(),
});


export const FeedbackAction = z.enum(['upvote', 'downvote']);
export type FeedbackChunk = z.infer<typeof FeedbackChunkSchema>;
export type Feedback = z.infer<typeof FeedbackSchema>;
