import express, { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../error/api-error';
import logger from '../service/logger';
import adminRouter from './admin';
import { memoryAuth, memoryAuthOf } from './auth';
import { memoryConfig, memoryEnabled } from './config';
import { handleMcp } from './mcp';
import { documentSchema, editSchema, feedbackSchema, learnSchema, searchSchema, writeSchema } from './schemas';
import { memoryService } from './service';
import { functionDefinitions } from './tools';

/**
 * The memory API under /memory. Everything but /health and /admin needs a memory token (see auth.ts); /admin needs
 * the server's master key. Bodies are checked for shape and size here; names, dates and grants in the service.
 */
const router = express.Router();

type Handler = (req: Request, res: Response) => Promise<unknown>;

// A model or database failure is the service's fault, not the caller's: it is logged in full and answered as a 500
// with a plain message, never with the provider's error text (which can name keys and hosts).
export const asApiError = (error: any, where: string): Error => {
    if (error instanceof ApiError || error instanceof z.ZodError) return error;
    logger.error(`[MEMORY](${where}) ${error?.stack ?? error?.message ?? error}`);
    return new ApiError('The memory service could not complete the request (a model or database call failed); see the server log', 500);
};

const wrap = (handler: Handler) => (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).then((data) => {
        if (!res.headersSent) res.json(data);
    }).catch((error) => next(asApiError(error, `${req.method} ${req.path}`)));
};

// Query strings arrive as strings; these turn the few typed fields back.
const fromQuery = (query: Request['query']): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...query };
    for (const key of ['spaces', 'labels', 'kinds']) if (typeof out[key] === 'string') out[key] = String(out[key]).split(',').map((item) => item.trim()).filter(Boolean);
    for (const key of ['all', 'prompt']) if (out[key] !== undefined) out[key] = out[key] === 'true';
    return out;
};
const merged = (req: Request): Record<string, unknown> => ({ ...fromQuery(req.query), ...(req.body && typeof req.body === 'object' ? req.body : {}) });

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) {
        const issue = result.error.issues[0];
        throw new ApiError(`${issue?.path?.length ? `"${issue.path.join('.')}": ` : ''}${issue?.message ?? 'invalid request'}`, 400);
    }
    return result.data;
};

router.get('/health', (req, res) => {
    res.json({ enabled: memoryEnabled(), embedding_model: memoryConfig.embeddingModel, extraction_model: memoryConfig.fakeModels ? 'fake' : memoryConfig.extractionModel });
});

router.use('/admin', adminRouter);

router.use((req, res, next) => {
    if (!memoryEnabled()) return next(new ApiError('Memory is not enabled on this server: MEMORY_DATABASE_URL is not set', 503));
    return memoryAuth(req, res, next);
});

// Reading
router.get('/spaces', wrap(async (req, res) => memoryService.spaces(memoryAuthOf(res))));
router.get('/index', wrap(async (req, res) => memoryService.index(memoryAuthOf(res), fromQuery(req.query))));
router.get('/open', wrap(async (req, res) => memoryService.open(memoryAuthOf(res), fromQuery(req.query) as { space: unknown; path: unknown })));
router.get('/history', wrap(async (req, res) => memoryService.history(memoryAuthOf(res), fromQuery(req.query) as { space: unknown; path: unknown })));
router.post('/search', wrap(async (req, res) => memoryService.search(memoryAuthOf(res), parse(searchSchema, req.body))));
router.get('/search', wrap(async (req, res) => memoryService.search(memoryAuthOf(res), parse(searchSchema, fromQuery(req.query)))));
router.get('/entities', wrap(async (req, res) => memoryService.entities(memoryAuthOf(res), fromQuery(req.query))));
router.get('/entity/:name', wrap(async (req, res) => memoryService.entity(memoryAuthOf(res), { ...fromQuery(req.query), name: req.params.name })));
router.post('/entity', wrap(async (req, res) => memoryService.entity(memoryAuthOf(res), merged(req) as { name: unknown })));

// Writing
router.put('/notes', wrap(async (req, res) => {
    const result = await memoryService.write(memoryAuthOf(res), parse(writeSchema, req.body));
    res.status(result.created ? 201 : 200);
    return result;
}));
router.post('/notes', wrap(async (req, res) => {
    const result = await memoryService.remember(memoryAuthOf(res), parse(writeSchema, req.body));
    res.status(result.outcome === 'added' ? 201 : 200);
    return result;
}));
router.patch('/notes', wrap(async (req, res) => memoryService.edit(memoryAuthOf(res), parse(editSchema, req.body))));
router.post('/learn', wrap(async (req, res) => {
    const result = await memoryService.learn(memoryAuthOf(res), parse(learnSchema, req.body));
    if (result.queued) res.status(202);
    return result;
}));
router.post('/feedback', wrap(async (req, res) => memoryService.feedback(memoryAuthOf(res), parse(feedbackSchema, req.body))));
router.post('/documents', wrap(async (req, res) => {
    const result = await memoryService.addDocument(memoryAuthOf(res), parse(documentSchema, req.body));
    res.status(202);
    return result;
}));

// Forgetting
router.delete('/notes', wrap(async (req, res) => memoryService.deleteNote(memoryAuthOf(res), merged(req) as { space: unknown; path: unknown })));
router.delete('/spaces', wrap(async (req, res) => memoryService.deleteSpace(memoryAuthOf(res), merged(req) as { space: unknown })));
router.delete('/entity/:name', wrap(async (req, res) => memoryService.forgetEntity(memoryAuthOf(res), { ...merged(req), name: req.params.name })));
router.delete('/entity', wrap(async (req, res) => memoryService.forgetEntity(memoryAuthOf(res), merged(req) as { name: unknown })));
router.delete('/source', wrap(async (req, res) => memoryService.forgetSource(memoryAuthOf(res), merged(req) as { type: unknown; id: unknown })));

// The verbs for a model: as function definitions, and as MCP.
router.get('/tools', (req, res) => {
    res.json({ tools: functionDefinitions(`${req.protocol}://${req.get('host')}`) });
});
router.post('/mcp', (req, res, next) => {
    handleMcp(req, res).catch((error) => next(asApiError(error, 'POST /mcp')));
});
router.all('/mcp', (req, res) => {
    res.status(405).json({ status: 'error', success: false, message: 'The memory MCP endpoint is stateless: send POST requests only' });
});

export default router;
