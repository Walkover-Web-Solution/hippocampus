import { OpenAIEmbeddings } from "@langchain/openai";
import { calculateVectorSize, chunkTextWithOverlap } from '../utility/langchain';
import { getOpenAIResponse } from './openai';
import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";
import env from '../config/env';
import { ProxyAgent, Dispatcher } from 'undici';

// TODO: Refactor this file

const MAX_REQUEST_SIZE = 4 * 1024 * 1024;
const embeddings: any = new OpenAIEmbeddings({
    openAIApiKey: env.OPENAI_API_KEY_EMBEDDING,
    batchSize: 100,
    model: 'text-embedding-3-small',
});



export const getCrawledDataFromSite = async (url: string) => {
    try {

        const docId = url?.match(/\/d\/(.*?)\//)?.[1];
        const loader = new CheerioWebBaseLoader(`https://docs.google.com/document/d/${docId}/export?format=txt`);
        const docs = await loader.load();
        return docs[0].pageContent;

    } catch (error) {
        console.error('Error fetching the webpage:', error);
        throw error;
    }
}
