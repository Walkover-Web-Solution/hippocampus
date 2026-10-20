import dotenv from 'dotenv';

dotenv.config();

/**
 * Memory on its own: an HTTP server that serves only /memory, for a deployment (or a laptop) that wants the memory
 * file system without the RAG routes and their Mongo, Qdrant, Redis and RabbitMQ. Needs MEMORY_DATABASE_URL and
 * the model keys; with QUEUE_CONNECTIONURL set, long work goes to the memory consumer, otherwise it runs inline.
 *
 *   npm run memory:server          (development, ts-node-dev)
 *   npm run build && npm run memory:start
 */
import cors from 'cors';
import express, { Request, Response } from 'express';
import errorHandler from '../middleware/error-handler';
import logger from '../service/logger';
import { memoryConfig, memoryEnabled } from './config';
import { migrateMemory } from './db';
import memoryRouter from './routes';

const app = express();
const port = Number(process.env.MEMORY_PORT || 4478);

app.use(cors({ origin: '*', maxAge: 86400 }));
app.use(express.json({ limit: '16mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (req: Request, res: Response) => {
    res.json({ service: 'hippocampus-memory', docs: 'https://github.com/Walkover-Web-Solution/hippocampus/blob/master/docs/MEMORY.md', health: '/memory/health', mcp: '/memory/mcp' });
});
app.use('/memory', memoryRouter);
app.use(errorHandler as any);

if (memoryEnabled() && memoryConfig.autoMigrate) {
    migrateMemory().catch((error) => logger.error(`[MEMORY] migration failed: ${error?.message}`));
}

app.listen(port, () => {
    logger.info(`[MEMORY] server listening on http://localhost:${port}/memory (${memoryEnabled() ? 'enabled' : 'MEMORY_DATABASE_URL not set'})`);
});
