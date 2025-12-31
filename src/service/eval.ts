import { ApiError } from '../error/api-error';
import { EvalTestCase } from '../models/eval';
import { EvalRun } from '../models/eval';
import { search } from '../service/search';
import {
    CreateEvalDataset,
    CreateEvalTestCase,
    EvalDataset as EvalDatasetType,
    EvalTestCase as EvalTestCaseType,
    EvalResult,
    EvalReport
} from '../type/eval';
import logger from './logger';

const TOP_K = 5;

/**
 * Helper to extract document ID as string from a mongoose document
 * Mongoose documents have _id as ObjectId, which has a toString() method
 */
const getDocumentId = (doc: { _id?: unknown }): string => {
    if (doc._id && typeof doc._id === 'object' && 'toString' in doc._id) {
        return (doc._id as { toString(): string }).toString();
    }
    if (typeof doc._id === 'string') {
        return doc._id;
    }
    return '';
};



/**
 * Create a new test case for a dataset
 */
const createTestCase = async (data: CreateEvalTestCase): Promise<EvalTestCaseType> => {
    const testCase = new EvalTestCase(data);
    return await testCase.save();
};

/**
 * Get all test cases for a dataset
 */
const getTestCasesByCollectionId = async (collectionId: string, ownerId: string = "public"): Promise<EvalTestCaseType[]> => {
    return await EvalTestCase.find({ collectionId, ownerId });
};

/**
 * Run evaluation for a dataset
 * This is the main scoring engine that:
 * 1. Fetches all test cases for the dataset
 * 2. Runs each query through the mock search
 * 3. Calculates metrics (Hit, Recall@5, RR)
 * 4. Aggregates results and saves the run
 */
const runEvaluation = async (collectionId: string, ownerId: string = "public"): Promise<EvalReport> => {

    // Get all test cases for this dataset
    const testCases = await getTestCasesByCollectionId(collectionId, ownerId);

    if (testCases.length === 0) {
        throw new ApiError(`No test cases found for collection ${collectionId} and ownerId ${ownerId}`, 400);
    }

    logger.info(`Running evaluation for collection ${collectionId} with ${testCases.length} test cases`);

    const results: EvalResult[] = [];
    let totalRecall = 0;
    let totalRR = 0;
    let hitCount = 0;

    // Iterate and evaluate each test case
    for (const testCase of testCases) {
        // Access _id from the mongoose document using type-safe helper
        const caseId = getDocumentId(testCase);

        // Query the mock vector search
        // const retrievedChunkIds = mockSearchHippocampus(
        //     testCase.query,
        //     testCase.expectedChunkIds,
        //     TOP_K
        // );
        const retrievedChunkIds = (await search(testCase.query, collectionId, { ownerId: ownerId, topK: TOP_K })).map((result) => result.id as string);

        // Calculate metrics
        const isHit = calculateHit(testCase.expectedChunkIds, retrievedChunkIds);
        const recall = calculateRecall(testCase.expectedChunkIds, retrievedChunkIds);
        const reciprocalRank = calculateReciprocalRank(testCase.expectedChunkIds, retrievedChunkIds);

        // Aggregate
        if (isHit) hitCount++;
        totalRecall += recall;
        totalRR += reciprocalRank;

        results.push({
            caseId,
            query: testCase.query,
            expectedChunkIds: testCase.expectedChunkIds,
            retrievedChunkIds,
            isHit,
            recall,
            reciprocalRank,
        });
    }

    // Calculate averages
    const totalCases = testCases.length;
    const overallScore = hitCount / totalCases; // Hit rate / accuracy
    const averageRecall = totalRecall / totalCases;
    const mrr = totalRR / totalCases; // Mean Reciprocal Rank

    // Save the evaluation run
    const evalRun = new EvalRun({
        collectionId: collectionId,
        ownerId: ownerId,
        timestamp: new Date(),
        overallScore,
        averageRecall,
        mrr,
        totalCases,
        hitCount,
        results,
    });

    const savedRun = await evalRun.save();

    // Identify failed cases (no hit)
    const failedCases = results
        .filter(r => !r.isHit)
        .map(r => ({
            caseId: r.caseId,
            query: r.query,
            expectedChunkIds: r.expectedChunkIds,
            retrievedChunkIds: r.retrievedChunkIds,
            recall: r.recall,
            reciprocalRank: r.reciprocalRank,
        }));

    logger.info(`Evaluation complete: accuracy=${overallScore}, MRR=${mrr}, recall=${averageRecall}`);

    return {
        runId: getDocumentId(savedRun),
        collectionId: collectionId,
        timestamp: savedRun.timestamp || new Date(),
        overallAccuracy: overallScore,
        mrr,
        averageRecall,
        totalCases,
        hitCount,
        failedCases,
    };
};

export default {
    createTestCase,
    getTestCasesByCollectionId,
    runEvaluation,
};


import { v4 as uuidv4 } from 'uuid';

/**
 * Mock function to simulate vector database search.
 * Returns random IDs, but returns the correct ID if the query contains the word "test".
 * This allows verifying the evaluation logic works correctly.
 */
export function mockSearchHippocampus(query: string, expectedIds: string[], topK: number = 5): string[] {
    const results: string[] = [];

    // If query contains "test", include one of the expected IDs at a random position
    if (query.toLowerCase().includes('test') && expectedIds.length > 0) {
        // Pick a random expected ID
        const correctId = expectedIds[Math.floor(Math.random() * expectedIds.length)];
        // Place it at a random position within the results
        const correctPosition = Math.floor(Math.random() * topK);

        for (let i = 0; i < topK; i++) {
            if (i === correctPosition) {
                results.push(correctId);
            } else {
                // Generate random UUID as a mock chunk ID
                results.push(uuidv4());
            }
        }
    } else {
        // Generate all random IDs
        for (let i = 0; i < topK; i++) {
            results.push(uuidv4());
        }
    }

    return results;
}

/**
 * Calculate if any expected chunk IDs appear in the retrieved results (Hit)
 */
export function calculateHit(expectedIds: string[], retrievedIds: string[]): boolean {
    return expectedIds.some(id => retrievedIds.includes(id));
}

/**
 * Calculate Recall@K: (Count of Expected IDs found in Retrieved) / (Total Expected IDs)
 */
export function calculateRecall(expectedIds: string[], retrievedIds: string[]): number {
    if (expectedIds.length === 0) return 0;
    const foundCount = expectedIds.filter(id => retrievedIds.includes(id)).length;
    return foundCount / expectedIds.length;
}

/**
 * Calculate Reciprocal Rank (RR): 1 / rank of first matching relevant ID
 * Returns 0 if no match found
 */
export function calculateReciprocalRank(expectedIds: string[], retrievedIds: string[]): number {
    for (let i = 0; i < retrievedIds.length; i++) {
        if (expectedIds.includes(retrievedIds[i])) {
            // Rank is 1-indexed, so position 0 means rank 1
            return 1 / (i + 1);
        }
    }
    return 0;
}
