import { ApiError } from '../error/api-error';
import { EvalDataset } from '../models/eval-dataset';
import { EvalTestCase } from '../models/eval-test-case';
import { EvalRun } from '../models/eval-run';
import { 
    CreateEvalDataset, 
    CreateEvalTestCase, 
    EvalDataset as EvalDatasetType,
    EvalTestCase as EvalTestCaseType,
    EvalResult,
    EvalReport
} from '../type/eval';
import { 
    mockSearchHippocampus, 
    calculateHit, 
    calculateRecall, 
    calculateReciprocalRank 
} from './eval-metrics';
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
 * Create a new evaluation dataset
 */
const createDataset = async (data: CreateEvalDataset): Promise<EvalDatasetType> => {
    const dataset = new EvalDataset(data);
    return await dataset.save();
};

/**
 * Get a dataset by ID
 */
const getDatasetById = async (id: string): Promise<EvalDatasetType> => {
    const dataset = await EvalDataset.findById(id);
    if (!dataset) {
        throw new ApiError(`Dataset with ID ${id} not found`, 404);
    }
    return dataset;
};

/**
 * Create a new test case for a dataset
 */
const createTestCase = async (data: CreateEvalTestCase): Promise<EvalTestCaseType> => {
    // Verify the dataset exists
    await getDatasetById(data.datasetId);
    
    const testCase = new EvalTestCase(data);
    return await testCase.save();
};

/**
 * Get all test cases for a dataset
 */
const getTestCasesByDatasetId = async (datasetId: string): Promise<EvalTestCaseType[]> => {
    return await EvalTestCase.find({ datasetId });
};

/**
 * Run evaluation for a dataset
 * This is the main scoring engine that:
 * 1. Fetches all test cases for the dataset
 * 2. Runs each query through the mock search
 * 3. Calculates metrics (Hit, Recall@5, RR)
 * 4. Aggregates results and saves the run
 */
const runEvaluation = async (datasetId: string): Promise<EvalReport> => {
    // Get dataset info - getDatasetById throws if not found
    const dataset = await getDatasetById(datasetId);

    // Get all test cases for this dataset
    const testCases = await getTestCasesByDatasetId(datasetId);
    
    if (testCases.length === 0) {
        throw new ApiError(`No test cases found for dataset ${datasetId}`, 400);
    }

    logger.info(`Running evaluation for dataset ${datasetId} with ${testCases.length} test cases`);

    const results: EvalResult[] = [];
    let totalRecall = 0;
    let totalRR = 0;
    let hitCount = 0;

    // Iterate and evaluate each test case
    for (const testCase of testCases) {
        // Access _id from the mongoose document using type-safe helper
        const caseId = getDocumentId(testCase);
        
        // Query the mock vector search
        const retrievedChunkIds = mockSearchHippocampus(
            testCase.query, 
            testCase.expectedChunkIds, 
            TOP_K
        );

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
        datasetId,
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
        datasetId,
        datasetName: dataset.name,
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
    createDataset,
    getDatasetById,
    createTestCase,
    getTestCasesByDatasetId,
    runEvaluation,
};
