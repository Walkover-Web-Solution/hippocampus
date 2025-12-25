import * as tf from '@tensorflow/tfjs';
import * as fs from 'fs';
import * as path from 'path';
import { Adapter, AdapterDocument } from '../models/adapter';
import logger from './logger';
import env from '../config/env';

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
            optimizer: tf.train.adam(0.001),
            loss: 'meanSquaredError'
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
            optimizer: tf.train.adam(0.001),
            loss: 'meanSquaredError'
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
    async train(queryVector: number[], chunkVector: number[], epochs: number = 1): Promise<void> {
        if (!this.model) {
            await this.loadOrInitialize();
        }

        if (queryVector.length !== this.inputDim || chunkVector.length !== this.inputDim) {
            throw new Error(`Vector dimensions mismatch. Expected ${this.inputDim}, got query: ${queryVector.length}, chunk: ${chunkVector.length}`);
        }

        const queryTensor = tf.tensor2d([queryVector]);
        const chunkTensor = tf.tensor2d([chunkVector]);

        try {
            await this.model!.fit(queryTensor, chunkTensor, {
                epochs: epochs,
                verbose: 0
            });
            this.trainingCount++;
        } finally {
            queryTensor.dispose();
            chunkTensor.dispose();
        }
    }

    /**
     * Transform a query vector using the trained adapter
     * @param queryVector - The query embedding vector to transform
     * @returns Transformed query vector
     */
    async transform(queryVector: number[]): Promise<number[]> {
        if (!this.model) {
            await this.loadOrInitialize();
        }

        if (queryVector.length !== this.inputDim) {
            throw new Error(`Vector dimension mismatch. Expected ${this.inputDim}, got ${queryVector.length}`);
        }

        const queryTensor = tf.tensor2d([queryVector]);
        
        try {
            const result = this.model!.predict(queryTensor) as tf.Tensor;
            const transformed = await result.array() as number[][];
            result.dispose();
            return transformed[0];
        } finally {
            queryTensor.dispose();
        }
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
        queryVector: number[],
        chunkVector: number[]
    ): Promise<void> {
        const adapter = await this.getAdapter(collectionId, queryVector.length);
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
