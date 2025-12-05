import express from 'express';
import { Encoder } from '../../service/encoder';

const router = express.Router();

router.get('/encoding-models', async (req, res, next) => {
    try {
        const denseModels = new Encoder().getModels();
        const sparseModels = new Encoder().getSparseModels();
        const rerankerModels = new Encoder().getRerankerModels();
        res.json({ models: { denseModels, sparseModels, rerankerModels } });
    } catch (error) {
        next(error);
    }
});

export default router;
