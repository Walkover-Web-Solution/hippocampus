import { ContentLoader } from "../utility";
import fs from "fs/promises";
import { WebPDFLoader } from "@langchain/community/document_loaders/web/pdf";
import axios from 'axios';

export class PDFLoader implements ContentLoader {
    async getContent(url: string, options?: { [key: string]: any }): Promise<string> {
        // Fetch the PDF from the URL
        const response = await axios.get(url, { responseType: 'arraybuffer' });

        // Convert the response data to a Blob
        const pdfBlob = new Blob([response.data], { type: 'application/pdf' });

        // Load the PDF using WebPDFLoader
        const loader = new WebPDFLoader(pdfBlob, {});
        const doc = await loader.load();

        // Return the content of the first page
        const pageContents = doc.map((page) => page.pageContent);
        return pageContents.join('\n\n\n\n');
    }
}