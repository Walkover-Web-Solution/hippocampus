import { ApiError } from '../error/api-error';
import { EvalTestCase } from '../models/eval';
import { EvalRun } from '../models/eval';
import { search } from '../service/search';
import {
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
