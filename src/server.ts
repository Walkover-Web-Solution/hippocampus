import dotenv from 'dotenv';
dotenv.config();
import 'newrelic';
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
import evalRouter from './route/eval';

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

app.use('/collection', auth([AuthMethod.API_KEY]), collectionRouter);
app.use('/resource', auth([AuthMethod.API_KEY]), resourceRouter);
app.use('/search', auth([AuthMethod.API_KEY]), searchRouter);
app.use('/utility', auth([AuthMethod.API_KEY]), utilityRouter);
app.use('/eval', auth([AuthMethod.API_KEY]), evalRouter);
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