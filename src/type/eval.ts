import { z } from 'zod';

// EvalDataset Schema - A container for a group of tests
export const EvalDatasetSchema = z.object({
    _id: z.string().optional(),
    name: z.string().min(1, 'Dataset name is required'),
    description: z.string().optional(),
    createdAt: z.date().optional(),
    updatedAt: z.date().optional(),
});

export type EvalDataset = z.infer<typeof EvalDatasetSchema>;

export const CreateEvalDatasetSchema = EvalDatasetSchema.omit({
    _id: true,
    createdAt: true,
    updatedAt: true,
});

export type CreateEvalDataset = z.infer<typeof CreateEvalDatasetSchema>;

// EvalTestCase Schema - A specific query and its expected answer
export const EvalTestCaseSchema = z.object({
    _id: z.string().optional(),
    collectionId: z.string().min(1, 'Dataset ID is required'),
    query: z.string().min(1, 'Query is required'),
    expectedChunkIds: z.array(z.string()).min(1, 'At least one expected chunk ID is required'),
    createdAt: z.date().optional(),
    updatedAt: z.date().optional(),
});

export type EvalTestCase = z.infer<typeof EvalTestCaseSchema>;

export const CreateEvalTestCaseSchema = EvalTestCaseSchema.omit({
    _id: true,
    createdAt: true,
    updatedAt: true,
});

export type CreateEvalTestCase = z.infer<typeof CreateEvalTestCaseSchema>;

// EvalResult Schema - The result for a single query within a run
export const EvalResultSchema = z.object({
    caseId: z.string().min(1, 'Case ID is required'),
    query: z.string(),
    expectedChunkIds: z.array(z.string()),
    retrievedChunkIds: z.array(z.string()),
    isHit: z.boolean(),
    recall: z.number().min(0).max(1),
    reciprocalRank: z.number().min(0).max(1),
});

export type EvalResult = z.infer<typeof EvalResultSchema>;

// EvalRun Schema - A record of a test execution
export const EvalRunSchema = z.object({
    _id: z.string().optional(),
    collectionId: z.string().min(1, 'Dataset ID is required'),
    timestamp: z.date().optional(),
    overallScore: z.number().min(0).max(1),
    averageRecall: z.number().min(0).max(1),
    mrr: z.number().min(0).max(1),
    totalCases: z.number().int().min(0),
    hitCount: z.number().int().min(0),
    results: z.array(EvalResultSchema),
    createdAt: z.date().optional(),
    updatedAt: z.date().optional(),
});

export type EvalRun = z.infer<typeof EvalRunSchema>;

// Evaluation Report Response Schema
export const EvalReportSchema = z.object({
    runId: z.string(),
    collectionId: z.string(),
    timestamp: z.date(),
    overallAccuracy: z.number(),
    mrr: z.number(),
    averageRecall: z.number(),
    totalCases: z.number(),
    hitCount: z.number(),
    failedCases: z.array(z.object({
        caseId: z.string(),
        query: z.string(),
        expectedChunkIds: z.array(z.string()),
        retrievedChunkIds: z.array(z.string()),
        recall: z.number(),
        reciprocalRank: z.number(),
    })),
});

export type EvalReport = z.infer<typeof EvalReportSchema>;
