import { track } from "@amplitude/analytics-node";
import { DateTime } from "luxon";
import axios from "../config/axios";

export function delay(time = 1000) {
    return new Promise((resolve) => {
        setTimeout(() => {
            return resolve(true);
        }, time)
    });
}

export async function validateCustomChunkingUrl(url: string): Promise<boolean> {
    try {
        const response = await axios.post(url, {
            content: "Health check",
            resourceId: "validation",
            collectionId: "validation",
            metadata: { type: "validation" }
        }, { timeout: 60*1000 }); // 1 minute timeout

        if (response.data && Array.isArray(response.data.chunks) && response.data.chunks.every((c: any) => typeof c === 'string')) {
            return true;
        }
        return false;
    } catch (error) {
        return false;
    }
}
