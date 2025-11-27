import { QdrantClient } from "@qdrant/qdrant-js";
import env from "./env";

const qdrantClient = new QdrantClient({
    url: env.QDRANT_URL,
    apiKey: env.QDRANT_API_KEY,
});

export default qdrantClient;