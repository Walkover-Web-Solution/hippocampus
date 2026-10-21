import express, { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../error/api-error';
import logger from '../service/logger';
import adminRouter from './admin';
import { memoryAuth, memoryAuthOf } from './auth';
import { memoryConfig, memoryEnabled } from './config';
import { handleMcp } from './mcp';
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

const MAX_BODY = 2_000_000;
const source = z.object({ type: z.string().max(64), id: z.string().max(512) }).nullable().optional();
const labels = z.array(z.string().max(64)).max(10).optional();
const spaces = z.array(z.string().max(202)).max(50).optional();
const text = (max: number) => z.string().max(max);

const searchSchema = z.object({
    query: text(5000),
    spaces,
    space: z.string().optional(),
    kinds: z.array(z.string().max(32)).max(20).optional(),
    labels,
    as_of: z.string().optional(),
    top_k: z.number().int().optional(),
    max_distance: z.number().min(0).max(2).optional(),
    prompt: z.boolean().optional(),
}).passthrough();

const writeSchema = z.object({
    space: z.string(),
    path: z.string().optional(),
    body: text(MAX_BODY).optional(),
    text: text(MAX_BODY).optional(),
    title: z.string().max(300).nullable().optional(),
    kind: z.string().optional(),
    slot: z.string().nullable().optional(),
    labels,
    valid_from: z.string().nullable().optional(),
    valid_to: z.string().nullable().optional(),
    source,
    confidence: z.number().min(0).max(1).optional(),
    if_version: z.number().int().optional(),
    entities: z.array(z.union([z.string(), z.object({ name: z.string(), type: z.string().optional() })])).max(40).optional(),
    relations: z.array(z.object({ subject: z.string(), relation: z.string(), object: z.string() })).max(30).optional(),
    merge: z.boolean().optional(),
    guard: z.boolean().optional(),
}).passthrough();

const editSchema = z.object({
    space: z.string(),
    path: z.string(),
    ops: z.array(z.union([
        z.object({ op: z.literal('str_replace'), old: z.string().min(1), new: z.string() }),
        z.object({ op: z.literal('insert'), line: z.number().int().min(0), text: z.string() }),
        z.object({ op: z.literal('append'), text: z.string() }),
        z.object({ op: z.literal('prepend'), text: z.string() }),
        z.object({ op: z.literal('delete'), old: z.string().min(1) }),
    ])).max(50).optional(),
    body: text(MAX_BODY).optional(),
    title: z.string().max(300).nullable().optional(),
    kind: z.string().optional(),
    slot: z.string().nullable().optional(),
    labels,
    valid_to: z.string().nullable().optional(),
    source,
    if_version: z.number().int().optional(),
}).passthrough();

const learnSchema = z.object({
    space: z.string(),
    shared_space: z.string().optional(),
    messages: z.array(z.object({ role: z.string().max(32), content: z.string().max(20000) })).min(1).max(200).optional(),
    text: text(20000).optional(),
    source,
    rules_allowed: z.boolean().optional(),
    // What the space is about: the person speaking (named, so a memory they share says who), or a thing such as an
    // article or an account, which never sets rules and is named in every memory.
    subject: z.object({ kind: z.enum(['person', 'thing']).optional(), name: z.string().max(120).optional() }).optional(),
    async: z.boolean().optional(),
}).refine((value) => value.messages || value.text, { message: '"messages" or "text" is required' });

const feedbackSchema = z.object({
    space: z.string(),
    task: text(5000),
    output: text(10000),
    outcome: z.enum(['good', 'bad', 'corrected']),
    correction: text(5000).optional(),
    note: text(2000).optional(),
    source,
});

const documentSchema = z.object({
    space: z.string(),
    path: z.string().optional(),
    url: z.string().max(2048).optional(),
    content: text(MAX_BODY).optional(),
    title: z.string().max(300).optional(),
    kind: z.string().optional(),
    labels,
    source,
}).refine((value) => value.url || value.content !== undefined, { message: '"url" or "content" is required' });

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
