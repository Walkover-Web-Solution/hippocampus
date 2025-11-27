import { ContentLoader } from "../utility";
export class ImageLoader implements ContentLoader {
    async getContent() {
        throw new Error("Image Not Supported.");
        return "PDF Not Supported";
    }
}