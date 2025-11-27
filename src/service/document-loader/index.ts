import { HTMLLoader } from './html';
import { ImageLoader } from './image';
import { PDFLoader } from './pdf';
export class DocumentLoader {
    private states: { [key: string]: any };
    constructor() {
        this.states = {
            'default': new HTMLLoader(),
            'html': new HTMLLoader(),
            'pdf': new PDFLoader(),
            'jpeg': new ImageLoader()
        }
    }

    async getContent(url: string, options?: { [key: string]: any }): Promise<string> {
        const parsedURL = new URL(url);

        // Extract the domain (host)
        const domain = parsedURL.hostname;

        // Extract the file extension if it exists
        const pathname = parsedURL.pathname;
        const extension = (pathname.includes(".") ? pathname?.split(".")?.pop() : 'html') as string;
        const loader = this.states[extension] || this.states['default'];
        return loader.getContent(url, options);
    }

}
