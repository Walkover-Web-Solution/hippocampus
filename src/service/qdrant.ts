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

export async function hybridSearch(collectionName: string, denseVector: number[], sparseVector: any, topK: number = 5, filter?: object) {
    // Perform parallel searches
    const densePromise = qdrantClient.search(collectionName, {
        vector: {
            name: 'dense',
            vector: denseVector
        },
        limit: topK * 2, // Fetch more for fusion
        with_payload: true,
        filter: filter as any
    });

    const sparsePromise = qdrantClient.search(collectionName, {
        vector: {
            name: 'sparse',
            vector: sparseVector
        },
        limit: topK * 2,
        with_payload: true,
        filter: filter as any
    });

    const [denseResults, sparseResults] = await Promise.all([densePromise, sparsePromise]);

    // Reciprocal Rank Fusion (RRF)
    const rrfScore: Record<string, { score: number, item: any }> = {};
    const k = 60; // RRF constant

    const processResults = (results: any[]) => {
        results.forEach((result, index) => {
            const id = result.id as string;
            if (!rrfScore[id]) {
                rrfScore[id] = { score: 0, item: result };
            }
            rrfScore[id].score += 1 / (k + index + 1);
        });
    };

    processResults(denseResults);
    processResults(sparseResults);

    // Sort by RRF score and take topK
    const sortedResults = Object.values(rrfScore)
        .sort((a, b) => b.score - a.score)
        .map(entry => entry.item)
        .slice(0, topK);

    return sortedResults;
}

export interface QdrantPoint {
    id: string | number;
    vector: number[] | { [key: string]: any };
    payload?: Record<string, any>;
}

export async function insert(collectionName: string, points: Array<QdrantPoint>) {
    const collection = await qdrantClient.collectionExists(collectionName);
    if (!collection.exists) {
        const firstVector = points[0].vector;
        let vectorsConfig: any = {};
        let sparseVectorsConfig: any = undefined;

        if (Array.isArray(firstVector)) {
            vectorsConfig = { size: firstVector.length, distance: 'Cosine' };
        } else {
            // Hybrid or named vectors
            if (firstVector.dense) {
                vectorsConfig.dense = { size: firstVector.dense.length, distance: 'Cosine' };
            }
            if (firstVector.sparse) {
                sparseVectorsConfig = { sparse: {} };
            }
            if (firstVector.rerank) {
                const colbertSize = firstVector.rerank[0]?.length || 128;
                vectorsConfig.colbert = {
                    size: colbertSize,
                    distance: 'Cosine',
                    multivector_config: {
                        comparator: 'max_sim'
                    }
                };
            }
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