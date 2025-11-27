import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";
import { ContentLoader } from "../../utility";
import { YoutubeLoader } from "@langchain/community/document_loaders/web/youtube";

export class YTLoader implements ContentLoader {
    async getContent(url: string, options?: { [key: string]: any }): Promise<string> {
        const loader = YoutubeLoader.createFromUrl(url, {
            // language: "en",
            addVideoInfo: true,
        });

        const docs = await loader.load();
        return docs[0]?.pageContent;
    }
}