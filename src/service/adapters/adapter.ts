import * as fs from 'fs';
import * as path from 'path';
import { Adapter, AdapterDocument } from '../../models/adapter';
import logger from '../logger';
import env from '../../config/env';
import * as tf from '@tensorflow/tfjs-node';

/**
 * Interface for adapter data stored in file or MongoDB
 */
interface AdapterData {
    weights: number[][];
    bias: number[];
    inputDim: number;
    outputDim: number;
    trainingCount: number;
}

/**
 * LinearProjectionAdapter - Adapter layer that transforms query vectors
 * to better match chunk vectors based on feedback training.
 * 
 * The model is a single dense layer (linear projection) initialized as identity matrix.
 * Training uses MSE loss to bring query vectors closer to positive chunk vectors.
 * 
 * Storage: By default uses local file storage. Set ADAPTER_USE_MONGO=true to use MongoDB.
 */
export class LinearProjectionAdapter {
    private model: tf.Sequential | null = null;
    private collectionId: string;
    private inputDim: number;
    private trainingCount: number = 0;
    private static storageDir: string = env.ADAPTER_STORAGE_PATH || './adapter_models';

    constructor(collectionId: string, inputDim: number) {
        this.collectionId = collectionId;
        this.inputDim = inputDim;
    }

    /**
     * Get the file path for storing adapter data
     */
    private getFilePath(): string {
        return path.join(LinearProjectionAdapter.storageDir, `${this.collectionId}.json`);
    }

    /**
     * Ensure storage directory exists
     */
    private ensureStorageDir(): void {
        if (!fs.existsSync(LinearProjectionAdapter.storageDir)) {
            fs.mkdirSync(LinearProjectionAdapter.storageDir, { recursive: true });
        }
    }

    /**
     * Load adapter data from local file
     */
    private loadFromFile(): AdapterData | null {
        const filePath = this.getFilePath();
        if (fs.existsSync(filePath)) {
            try {
                const data = fs.readFileSync(filePath, 'utf-8');
                return JSON.parse(data) as AdapterData;
            } catch (error) {
                logger.error(`Error reading adapter file ${filePath}:`, error);
                return null;
            }
        }
        return null;
    }

    /**
     * Save adapter data to local file
     */
    private saveToFile(data: AdapterData): void {
        this.ensureStorageDir();
        const filePath = this.getFilePath();
        try {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        } catch (error) {
            logger.error(`Error writing adapter file ${filePath}:`, error);
            throw error;
        }
    }

    /**
     * Load adapter data from MongoDB
     */
    private async loadFromMongo(): Promise<AdapterData | null> {
        const adapterDoc = await Adapter.findById(this.collectionId);
        if (adapterDoc && adapterDoc.weights) {
            return {
                weights: adapterDoc.weights,
                bias: adapterDoc.bias || [],
                inputDim: adapterDoc.inputDim,
                outputDim: adapterDoc.outputDim,
                trainingCount: adapterDoc.trainingCount
            };
        }
        return null;
    }

    /**
     * Save adapter data to MongoDB
     */
    private async saveToMongo(data: AdapterData): Promise<void> {
        await Adapter.findByIdAndUpdate(
            this.collectionId,
            {
                _id: this.collectionId,
                weights: data.weights,
                bias: data.bias,
                inputDim: data.inputDim,
                outputDim: data.outputDim,
                trainingCount: data.trainingCount
            },
            { upsert: true, new: true }
        );
    }

    /**
     * Initialize the model with identity matrix weights
     */
    private initializeModel(): void {
        this.model = tf.sequential();

        // Create identity matrix as initial weights
        const identityWeights = tf.eye(this.inputDim);
        const zeroBias = tf.zeros([this.inputDim]);

        try {
            this.model.add(tf.layers.dense({
                units: this.inputDim,
                inputShape: [this.inputDim],
                useBias: true,
                weights: [identityWeights, zeroBias],
                trainable: true
            }));

        } finally {
            // Dispose tensors to prevent memory leaks
            identityWeights.dispose();
            zeroBias.dispose();
        }

        // Compile with MSE loss and Adam optimizer
        this.model.compile({
            optimizer: tf.train.adam(0.0001),
            loss: 'cosineProximity',
            metrics: ['mse']
        });
    }

    /**
     * Load model from adapter data
     */
    private loadModelFromData(data: AdapterData): void {
        this.model = tf.sequential();

        const weights = tf.tensor2d(data.weights);
        const bias = data.bias && data.bias.length > 0
            ? tf.tensor1d(data.bias)
            : tf.zeros([data.inputDim]);

        try {
            this.model.add(tf.layers.dense({
                units: data.outputDim,
                inputShape: [data.inputDim],
                useBias: true,
                weights: [weights, bias],
                trainable: true
            }));
        } finally {
            // Dispose tensors to prevent memory leaks
            weights.dispose();
            bias.dispose();
        }

        this.model.compile({
            optimizer: tf.train.adam(0.0001),
            loss: 'cosineProximity',
            metrics: ['mse']
        });

        this.inputDim = data.inputDim;
        this.trainingCount = data.trainingCount;
    }

    /**
     * Load adapter weights from storage (file by default, or MongoDB if flag enabled) or initialize if not exists
     */
    async loadOrInitialize(): Promise<void> {
        let adapterData: AdapterData | null = null;

        if (env.ADAPTER_USE_MONGO) {
            adapterData = await this.loadFromMongo();
        } else {
            adapterData = this.loadFromFile();
        }

        if (adapterData) {
            this.loadModelFromData(adapterData);
        } else {
            // Initialize new model with identity matrix
            this.initializeModel();
        }
    }

    /**
     * Save adapter weights to storage (file by default, or MongoDB if flag enabled)
     */
    async save(): Promise<void> {
        if (!this.model) {
            throw new Error('Model not initialized. Call loadOrInitialize() first.');
        }

        const layer = this.model.layers[0] as tf.layers.Layer;
        const weights = layer.getWeights();

        if (weights.length < 2) {
            throw new Error('Model weights not properly initialized.');
        }

        const weightMatrix = await weights[0].array() as number[][];
        const biasVector = await weights[1].array() as number[];

        const adapterData: AdapterData = {
            weights: weightMatrix,
            bias: biasVector,
            inputDim: this.inputDim,
            outputDim: this.inputDim,
            trainingCount: this.trainingCount
        };

        if (env.ADAPTER_USE_MONGO) {
            await this.saveToMongo(adapterData);
        } else {
            this.saveToFile(adapterData);
        }
    }

    /**
     * Train the model to bring query vector closer to chunk vector
     * @param queryVector - The query embedding vector
     * @param chunkVector - The target chunk embedding vector
     * @param epochs - Number of training epochs (default: 1 for online learning)
     */
    async train(queryVector: number[][], chunkVector: number[][], epochs: number = 3): Promise<void> {
        if (!this.model) {
            await this.loadOrInitialize();
        }

        if (queryVector[0].length !== this.inputDim || chunkVector[0].length !== this.inputDim) {
            throw new Error(`Vector dimensions mismatch. Expected ${this.inputDim}, got query: ${queryVector[0].length}, chunk: ${chunkVector[0].length}`);
        }

        const queryTensor = tf.tensor2d(queryVector);
        const chunkTensor = tf.tensor2d(chunkVector);
        const normalizedQuery = tf.tidy(() => {
            const norm = tf.norm(queryTensor, 'euclidean', 1); // Calculate length
            const normColumn = norm.reshape([-1, 1]);
            return queryTensor.div(normColumn.add(tf.scalar(1e-12)));
        });

        const normalizedChunk = tf.tidy(() => {
            const norm = tf.norm(chunkTensor, 'euclidean', 1, true);
            const normColumn = norm.reshape([-1, 1]);
            return chunkTensor.div(normColumn.add(tf.scalar(1e-12)));
        });
        try {
            await this.model!.fit(normalizedQuery, normalizedChunk, {
                epochs: epochs,
                batchSize: Math.min(32, queryVector.length),
                shuffle: true,
                verbose: 0
            });
            this.trainingCount++;
        } finally {
            queryTensor.dispose();
            chunkTensor.dispose();
            normalizedChunk.dispose();
            normalizedQuery.dispose();
        }
    }

    /**
     * Transform a query vector using the trained adapter
     * @param queryVector - The query embedding vector to transform
     * @returns Transformed query vector
     */
    async transform(queryVector: number[]): Promise<number[]> {
        const start = performance.now();
        if (!this.model) {
            await this.loadOrInitialize();
        }

        if (queryVector.length !== this.inputDim) {
            throw new Error(`Vector dimension mismatch. Expected ${this.inputDim}, got ${queryVector.length}`);
        }

        // tf.tidy automatically disposes ALL tensors created inside this callback
        // when the function finishes. This prevents memory leaks.
        const transformedVector = tf.tidy(() => {
            const queryTensor = tf.tensor2d([queryVector]);

            // 1. Run Model
            const rawResult = this.model!.predict(queryTensor) as tf.Tensor;

            // 2. Calculate Norm (Length)
            // 'euclidean', axis=1, keepDims=true
            // Result shape: [1, 1] (Perfect for division)
            const norm = tf.norm(rawResult, 'euclidean', 1, true);

            // 3. Normalize (Vector / Length)
            // We add 1e-12 to avoid division by zero if the vector is empty
            const normalizedResult = rawResult.div(norm.add(tf.scalar(1e-12)));

            // Extract values synchronously (fast for small single vectors)
            // Array.from converts TypedArray to standard JS number[]
            return Array.from(normalizedResult.dataSync());
        });

        console.log(`Adapter transform took ${(performance.now() - start).toFixed(2)} ms`);
        return transformedVector;
    }

    /**
     * Get the training count
     */
    getTrainingCount(): number {
        return this.trainingCount;
    }

    /**
     * Dispose the model to free memory
     */
    dispose(): void {
        if (this.model) {
            this.model.dispose();
            this.model = null;
        }
    }
}

/**
 * Get the storage directory for adapter files
 */
function getStorageDir(): string {
    return env.ADAPTER_STORAGE_PATH || './adapter_models';
}

/**
 * Check if adapter exists in storage
 */
async function adapterExistsInStorage(collectionId: string): Promise<{ exists: boolean; trainingCount: number }> {
    if (env.ADAPTER_USE_MONGO) {
        const adapterDoc = await Adapter.findById(collectionId);
        return {
            exists: !!(adapterDoc && adapterDoc.trainingCount > 0),
            trainingCount: adapterDoc?.trainingCount || 0
        };
    } else {
        const filePath = path.join(getStorageDir(), `${collectionId}.json`);
        if (fs.existsSync(filePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                return {
                    exists: data.trainingCount > 0,
                    trainingCount: data.trainingCount || 0
                };
            } catch (error) {
                logger.error(`Error reading adapter file for existence check: ${filePath}`, error);
                return { exists: false, trainingCount: 0 };
            }
        }
        return { exists: false, trainingCount: 0 };
    }
}

/**
 * AdapterService - Service for managing adapter instances
 */
class AdapterService {
    private adapters: Map<string, LinearProjectionAdapter> = new Map();

    /**
     * Get or create an adapter for a collection
     */
    async getAdapter(collectionId: string, inputDim: number): Promise<LinearProjectionAdapter> {
        if (!this.adapters.has(collectionId)) {
            const adapter = new LinearProjectionAdapter(collectionId, inputDim);
            await adapter.loadOrInitialize();
            this.adapters.set(collectionId, adapter);
        }

        return this.adapters.get(collectionId)!;
    }

    /**
     * Train adapter with feedback
     * @param collectionId - Collection ID
     * @param queryVector - Query embedding
     * @param chunkVector - Target chunk embedding
     */
    async trainWithFeedback(
        collectionId: string,
        queryVector: number[][],
        chunkVector: number[][]
    ): Promise<void> {
        const adapter = await this.getAdapter(collectionId, queryVector[0].length);
        await adapter.train(queryVector, chunkVector);
        await adapter.save();
    }

    /**
     * Transform query vector using trained adapter
     * @param collectionId - Collection ID
     * @param queryVector - Query embedding to transform
     * @returns Transformed query vector, or original if no adapter exists
     */
    async transformQuery(collectionId: string, queryVector: number[]): Promise<number[]> {
        try {
            const { exists, trainingCount } = await adapterExistsInStorage(collectionId);
            if (!exists || trainingCount === 0) {
                // No trained adapter, return original vector
                return queryVector;
            }

            const adapter = await this.getAdapter(collectionId, queryVector.length);
            return await adapter.transform(queryVector);
        } catch (error) {
            logger.error('Error transforming query with adapter:', error);
            // Fallback to original vector on error
            return queryVector;
        }
    }

    /**
     * Check if an adapter exists for a collection
     */
    async hasTrainedAdapter(collectionId: string): Promise<boolean> {
        const { exists } = await adapterExistsInStorage(collectionId);
        return exists;
    }

    /**
     * Clear cached adapter (useful when weights are updated externally)
     */
    clearCache(collectionId: string): void {
        const adapter = this.adapters.get(collectionId);
        if (adapter) {
            adapter.dispose();
            this.adapters.delete(collectionId);
        }
    }
}

const adapterService = new AdapterService();

export default adapterService;


interface TransformationAnalysis {
    isModified: boolean;
    similarity: number;   // 1.0 = Identical, 0.0 = Totally different
    distance: number;     // Raw distance between points
    isSafe: boolean;      // False if meaning drifted too far
    message: string;      // Human readable status
}

/**
 * Compares the original query vector vs the adapted vector.
 * @param originalVec - The raw embedding from the base model
 * @param transformedVec - The output from your Adapter
 * @param safetyThreshold - Minimum similarity allowed (default 0.75)
 */
export function analyzeTransformation(
    originalVec: number[],
    transformedVec: number[],
    safetyThreshold: number = 0.75
): TransformationAnalysis {

    return tf.tidy(() => {
        const tOriginal = tf.tensor1d(originalVec);
        const tTransformed = tf.tensor1d(transformedVec);

        // 1. Check strict equality (Is Modified?)
        // We use a small epsilon because floating point math is rarely exact 0
        const rawDistance = tf.norm(tOriginal.sub(tTransformed)).dataSync()[0];
        const isModified = rawDistance > 0.000001;

        if (!isModified) {
            return {
                isModified: false,
                similarity: 1.0,
                distance: 0,
                isSafe: true,
                message: "No change detected."
            };
        }

        // 2. Calculate Cosine Similarity (The "Meaning" Check)
        // Normalize first to ensure dot product = cosine similarity
        const normOrg = tOriginal.div(tOriginal.norm());
        const normTrans = tTransformed.div(tTransformed.norm());

        // Dot product of unit vectors = Cosine Similarity
        // Range: 1.0 (Identical) to -1.0 (Opposite)
        const similarity = normOrg.dot(normTrans).dataSync()[0];

        // 3. Generate Safety Warning
        let message = `Modified. Similarity: ${(similarity * 100).toFixed(1)}%`;
        let isSafe = true;

        if (similarity < safetyThreshold) {
            isSafe = false;
            message = `⚠️ CRITICAL DRIFT: Query meaning changed too much (${(similarity * 100).toFixed(1)}%). Original meaning may be lost.`;
        } else if (similarity < 0.9) {
            message = `Significant adaptation applied (${(similarity * 100).toFixed(1)}%).`;
        }

        return {
            isModified,
            similarity,
            distance: rawDistance,
            isSafe,
            message
        };
    });
}