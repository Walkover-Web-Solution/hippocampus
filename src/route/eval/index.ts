import express from 'express';
import EvalService from '../../service/eval';
import { CreateEvalDatasetSchema, CreateEvalTestCaseSchema } from '../../type/eval';
import { ApiError } from '../../error/api-error';

const router = express.Router();

router.post('/cases', async (req, res, next) => {
    try {
        const validatedData = await CreateEvalTestCaseSchema.parseAsync(req.body);
        const testCase = await EvalService.createTestCase(validatedData);
        res.status(201).json(testCase);
    } catch (error) {
        next(error);
    }
});

router.get('/cases/:collectionId/:ownerId', async (req, res, next) => {
    try {
        const testCases = await EvalService.getTestCasesByCollectionId(req.params.collectionId, req.params.ownerId);
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

router.post('/run/:datasetId/:ownerId', async (req, res, next) => {
    try {
        const datasetId = req.params.datasetId;
        const ownerId = req.params.ownerId || "public";
        if (!datasetId) {
            throw new ApiError('Dataset ID is required', 400);
        }

        const report = await EvalService.runEvaluation(datasetId, ownerId);
        res.json(report);
    } catch (error) {
        next(error);
    }
});

export default router;
