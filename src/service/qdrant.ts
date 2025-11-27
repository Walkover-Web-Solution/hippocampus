import qdrantClient from "../config/qdrant";

export async function search(collectionName: string, vector: number[], topK: number = 5, filter?: object) {
    const query: any = {
        vector: vector,
        limit: topK,
        with_payload: true,
        params: {
            indexed_only: true,
            exact: false,
            hnsw_ef: 128
        }
    }
    if (filter) query.filter = filter;
    const result = await qdrantClient.search(collectionName, query);
    return result;
}

export interface QdrantPoint {
    id: string | number;
    vector: number[];
    payload?: Record<string, any>;
}

export async function insert(collectionName: string, points: Array<QdrantPoint>) {
    const collection = await qdrantClient.collectionExists(collectionName);
    if (!collection.exists) {
        await qdrantClient.createCollection(collectionName, {
            vectors: { size: points[0].vector.length, distance: 'Cosine' },
        });
        console.log(`Collection "${collectionName}" created.`);
    }
    const saveResult = await qdrantClient.upsert(collectionName, {
        wait: true,
        points: points,
    });
    return saveResult;
}

export async function deletePoints(collectionName: string, filter: any) {
    return await qdrantClient.delete(collectionName, {
        wait: true,
        filter: filter
    });
}