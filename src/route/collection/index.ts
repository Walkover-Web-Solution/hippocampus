import express from 'express';
import CollectionService from '../../service/collection';
import ResourceService from '../../service/resource';
import { CreateCollectionSchema, UpdateCollectionSchema, Collection } from '../../type/collection';
import { Resource } from '../../type/resource';
import { ApiError } from '../../error/api-error';

const router = express.Router();

router.post('/', async (req, res, next) => {
    try {
        const validatedData = await CreateCollectionSchema.parseAsync(req.body);
        const collection: Collection = await CollectionService.createCollection(validatedData);
        res.status(201).json(collection);
    } catch (error) {
        next(error);
    }
});

router.get('/:id/resources', async (req, res, next) => {
    try {
        const ownerId = req.query.ownerId as string;
        const includeContent = req.query.content === 'true';
        const resources: Resource[] = await ResourceService.getResourcesByCollectionId(req.params.id, ownerId, includeContent);
        res.json({
            resources: resources,
            metadata: {
                total: resources.length
            }
        });
    } catch (error) {
        next(error);
    }
});

router.get('/:id', async (req, res, next) => {
    try {
        const collection: Collection | null = await CollectionService.getCollectionById(req.params.id);
        if (!collection) {
            throw new ApiError('Collection not found', 404);
        }
        res.json(collection);
    } catch (error) {
        next(error);
    }
});

router.put('/:id', async (req, res, next) => {
    try {
        const validatedData = await UpdateCollectionSchema.parseAsync(req.body);
        const collection: Collection | null = await CollectionService.updateCollection(req.params.id, validatedData);
        if (!collection) {
            throw new ApiError('Collection not found', 404);
        }
        res.json(collection);
    } catch (error) {
        next(error);
    }
});

export default router;
