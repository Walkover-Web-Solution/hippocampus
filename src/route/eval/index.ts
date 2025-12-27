import express from 'express';
import EvalService from '../../service/eval';
import { CreateEvalDatasetSchema, CreateEvalTestCaseSchema } from '../../type/eval';
import { ApiError } from '../../error/api-error';

const router = express.Router();

/**
 * POST /eval/datasets
 * Create a new evaluation dataset
 */
router.post('/datasets', async (req, res, next) => {
    try {
        const validatedData = await CreateEvalDatasetSchema.parseAsync(req.body);
        const dataset = await EvalService.createDataset(validatedData);
        res.status(201).json(dataset);
    } catch (error) {
        next(error);
    }
});

/**
 * GET /eval/datasets/:id
 * Get a specific dataset by ID
 */
router.get('/datasets/:id', async (req, res, next) => {
    try {
        const dataset = await EvalService.getDatasetById(req.params.id);
        res.json(dataset);
    } catch (error) {
        next(error);
    }
});

/**
 * POST /eval/cases
 * Add a manual test case (Query + List of Expected IDs)
 */
router.post('/cases', async (req, res, next) => {
    try {
        const validatedData = await CreateEvalTestCaseSchema.parseAsync(req.body);
        const testCase = await EvalService.createTestCase(validatedData);
        res.status(201).json(testCase);
    } catch (error) {
        next(error);
    }
});

/**
 * GET /eval/cases/:datasetId
 * Get all test cases for a dataset
 */
router.get('/cases/:datasetId', async (req, res, next) => {
    try {
        const testCases = await EvalService.getTestCasesByDatasetId(req.params.datasetId);
        res.json({
            testCases,
            metadata: {
                total: testCases.length
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /eval/run/:datasetId
 * Trigger the evaluation logic for a dataset
 * Response: JSON report with overall_accuracy, mrr, and a list of failed cases
 */
router.post('/run/:datasetId', async (req, res, next) => {
    try {
        const datasetId = req.params.datasetId;
        if (!datasetId) {
            throw new ApiError('Dataset ID is required', 400);
        }
        
        const report = await EvalService.runEvaluation(datasetId);
        res.json(report);
    } catch (error) {
        next(error);
    }
});

export default router;
