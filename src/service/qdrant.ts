import qdrantClient from "../config/qdrant";

export async function denseSearch(collectionName: string, vector: number[], topK: number = 5, filter?: object) {
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
                filter: filter
            },
            {
                using: 'sparse',
                query: sparseVector,
                limit: topK * 2,
                filter: filter
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
        if (firstVector.dense) {
            vectorsConfig.dense = {
                size: firstVector.dense.length,
                distance: 'Cosine',
                // on_disk: true
            };
        }

        if (firstVector.rerank) {
            const rerankerSize = firstVector.rerank[0]?.length || 128;
            vectorsConfig.rerank = {
                size: rerankerSize,
                distance: 'Cosine',
                multivector_config: {
                    comparator: 'max_sim'
                },
                // on_disk: true
            };
        }

        const config: any = { vectors: vectorsConfig };
        if (firstVector.sparse) {
            config.sparse_vectors = { sparse: {} };
        }
        // Scalar Quantization config
        // config.quantization_config = {
        //     scalar: {
        //         type: "int8",
        //         quantile: 0.99,
        //         always_ram: true,
        //     }
        // }
        // Binary Quantization Config
        // config.quantization_config = {
        //     binary: {
        //         always_ram: true,
        //     }
        // }
        await qdrantClient.createCollection(collectionName, config);
        console.log(`Collection "${collectionName}" created.`);
        
        // Create payload index for ownerId for efficient multi-tenancy filtering
        await qdrantClient.createPayloadIndex(collectionName, {
            field_name: "ownerId",
            field_schema: "keyword"
        });
        console.log(`Payload index for "ownerId" created in "${collectionName}".`);
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