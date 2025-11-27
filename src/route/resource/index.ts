import express from 'express';
import ResourceService from '../../service/resource';
import { CreateResourceSchema, UpdateResourceSchema, Resource } from '../../type/resource';
import { ApiError } from '../../error/api-error';

const router = express.Router();

router.post('/', async (req, res, next) => {
    try {
        const validatedData = CreateResourceSchema.parse(req.body);
        const resource: Resource = await ResourceService.createResource(validatedData);
        res.status(201).json(resource);
    } catch (error) {
        next(error);
    }
});

router.get('/:id', async (req, res, next) => {
    try {
        const resource: Resource | null = await ResourceService.getResourceById(req.params.id);
        if (!resource) {
            throw new ApiError('Resource not found', 404);
        }
        res.json(resource);
    } catch (error) {
        next(error);
    }
});

router.put('/:id', async (req, res, next) => {
    try {
        const validatedData = UpdateResourceSchema.parse(req.body);
        const resource: Resource | null = await ResourceService.updateResource(req.params.id, validatedData);
        if (!resource) {
            throw new ApiError('Resource not found', 404);
        }
        res.json(resource);
    } catch (error) {
        next(error);
    }
});

router.delete('/:id', async (req, res, next) => {
    try {
        const resource: Resource | null = await ResourceService.deleteResource(req.params.id);
        if (!resource) {
            throw new ApiError('Resource not found', 404);
        }
        res.status(200).json(resource);
    } catch (error) {
        next(error);
    }
});

export default router;
