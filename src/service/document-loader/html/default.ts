import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";
import { ContentLoader } from "../../utility";
import { PuppeteerWebBaseLoader } from "@langchain/community/document_loaders/web/puppeteer";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { HtmlToTextTransformer } from "@langchain/community/document_transformers/html_to_text";

export class WebLoader implements ContentLoader {
    async getContent(url: string, options?: { [key: string]: any }): Promise<string> {
        const loader = new PuppeteerWebBaseLoader(url, {
            launchOptions: {
                headless: true,
                args: ['--no-sandbox']
            },
            gotoOptions: {
                waitUntil: 'load'
            }
        });
        const docs = await loader.load();
        const transformer = new HtmlToTextTransformer();
        const textDoc = await transformer.invoke(docs) as any;
        return textDoc[0]?.pageContent || "";
    }
}