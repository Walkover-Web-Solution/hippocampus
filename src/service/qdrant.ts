import qdrantClient from "../config/qdrant";

export async function search(collectionName: string, vector: number[], topK: number = 5, filter?: object) {
    const query: any = {
        vector: {
            name: "dense",
            vector: vector
        },
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

export async function hybridSearch(collectionName: string, denseVector: number[], sparseVector: any, topK: number = 5, filter?: object) {
    const result = await qdrantClient.query(collectionName, {
        prefetch: [
            {
                using: 'dense',
                query: denseVector,
                limit: topK * 2,
            },
            {
                using: 'sparse',
                query: sparseVector,
                limit: topK * 2,
            }
        ],
        query: {
            fusion: 'rrf',
        },
        limit: topK,
        with_payload: true,
    });

    return result.points;
}

export async function rerank(collectionName: string, queryVectors: number[][], candidateIds: Array<string | number>, topK: number = 5) {
    const result = await qdrantClient.query(collectionName, {
        query: queryVectors,
        using: "rerank",
        filter: {
            must: [
                {
                    has_id: candidateIds
                }
            ]
        },
        limit: topK,
        with_payload: true,
        params: {
            indexed_only: true,
            exact: false,
            hnsw_ef: 128
        }
    });
    return result.points;
}

export interface QdrantPoint {
    id: string | number;
    vector: { [key: string]: any };
    payload?: Record<string, any>;
}

export async function insert(collectionName: string, points: Array<QdrantPoint>) {
    const collection = await qdrantClient.collectionExists(collectionName);
    if (!collection.exists) {
        const firstVector = points[0].vector;
        let vectorsConfig: any = {};
        let sparseVectorsConfig: any = undefined;

        if (firstVector.dense) {
            vectorsConfig.dense = { size: firstVector.dense.length, distance: 'Cosine' };
        }
        if (firstVector.sparse) {
            sparseVectorsConfig = { sparse: {} };
        }
        if (firstVector.rerank) {
            const rerankerSize = firstVector.rerank[0]?.length || 128;
            vectorsConfig.rerank = {
                size: rerankerSize,
                distance: 'Cosine',
                multivector_config: {
                    comparator: 'max_sim'
                }
            };
        }


        const createConfig: any = { vectors: vectorsConfig };
        if (sparseVectorsConfig) {
            createConfig.sparse_vectors = sparseVectorsConfig;
        }

        await qdrantClient.createCollection(collectionName, createConfig);
        console.log(`Collection "${collectionName}" created.`);
    }
    const saveResult = await qdrantClient.upsert(collectionName, {
        wait: true,
        points: points as any,
    });
    return saveResult;
}

export async function deletePoints(collectionName: string, filter: any) {
    return await qdrantClient.delete(collectionName, {
        wait: true,
        filter: filter
    });
}