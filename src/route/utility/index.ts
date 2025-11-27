import express from 'express';
import { Encoder } from '../../service/encoder';

const router = express.Router();

router.get('/encoding-models', async (req, res, next) => {
    try {
        const supportedModels = new Encoder().getModels();
        res.json({ models: supportedModels });
    } catch (error) {
        next(error);
    }
});

export default router;
