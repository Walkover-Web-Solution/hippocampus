import dotenv from 'dotenv';
dotenv.config();
import express, { Request, Response } from 'express';
import { connectDB } from './models';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import cors from 'cors';
import errorHandler from './middleware/error-handler';
import bodyParser from 'body-parser';
import { AuthMethod, auth } from './middleware/auth';
import collectionRouter from './route/collection';
import resourceRouter from './route/resource';
import searchRouter from './route/search';
import utilityRouter from './route/utility';
import { SemanticChunker } from './service/semantic-chunker';

const app = express();
const port = process.env.PORT || 3000;
connectDB();
puppeteer.use(StealthPlugin());
app.use(cors({
    origin: "*",
    maxAge: 86400,
    preflightContinue: true,
}));
app.use(bodyParser.json({ limit: '8mb' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Define a route
app.get('/', (req: Request, res: Response) => {
    res.send(
        `Welcome to the future of SEARCH!<br/><br/>
        * Documentation: <a href="/doc">/doc</a> <br/>
        * Feedback: <a href="/feedback">/feedback</a>`);
});

app.post('/test/semantic-chunker', async (req: Request, res: Response, next) => {
    try {
        const { content, denseModel, similarityThreshold, minChunkSize, maxChunkSize, bufferSize, breakpointPercentile } = req.body;

        if (!content || typeof content !== 'string') {
            return res.status(400).json({ error: 'content is required and must be a string' });
        }

        if (similarityThreshold !== undefined && typeof similarityThreshold !== 'number') {
            return res.status(400).json({ error: 'similarityThreshold must be a number' });
        }

        if (minChunkSize !== undefined && typeof minChunkSize !== 'number') {
            return res.status(400).json({ error: 'minChunkSize must be a number' });
        }

        if (maxChunkSize !== undefined && typeof maxChunkSize !== 'number') {
            return res.status(400).json({ error: 'maxChunkSize must be a number' });
        }

        if (bufferSize !== undefined && typeof bufferSize !== 'number') {
            return res.status(400).json({ error: 'bufferSize must be a number' });
        }

        if (breakpointPercentile !== undefined && typeof breakpointPercentile !== 'number') {
            return res.status(400).json({ error: 'breakpointPercentile must be a number' });
        }

        const chunker = new SemanticChunker({
            denseModel: denseModel || 'BAAI/bge-small-en-v1.5',
            similarityThreshold: similarityThreshold ?? 0.5,
            minChunkSize: minChunkSize ?? 50,
            maxChunkSize: maxChunkSize ?? 2000,
            bufferSize: bufferSize ?? 1,
            breakpointPercentile: breakpointPercentile ?? 95,
        });

        const chunks = await chunker.chunk(content);
        res.json({ chunks, count: chunks.length });
    } catch (error) {
        next(error);
    }
});

app.use('/collection', auth([AuthMethod.API_KEY]), collectionRouter);
app.use('/resource', auth([AuthMethod.API_KEY]), resourceRouter);
app.use('/search', auth([AuthMethod.API_KEY]), searchRouter);
app.use('/utility', auth([AuthMethod.API_KEY]), utilityRouter);
app.get('/doc', (req: Request, res: Response) => {
    res.redirect('https://www.postman.com/cloudvulture/rag-service/collection/6unm4q7/api-documentation');
});

app.get('/feedback', (req: Request, res: Response) => {
    res.send("Comming soon!");
});

app.use(errorHandler as any);
// Start the server
app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});