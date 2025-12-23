import * as tf from '@tensorflow/tfjs';
import { Adapter, AdapterDocument } from '../models/adapter';
import logger from './logger';

/**
 * LinearProjectionAdapter - Adapter layer that transforms query vectors
 * to better match chunk vectors based on feedback training.
 * 
 * The model is a single dense layer (linear projection) initialized as identity matrix.
 * Training uses MSE loss to bring query vectors closer to positive chunk vectors.
 */
export class LinearProjectionAdapter {
    private model: tf.Sequential | null = null;
    private collectionId: string;
    private inputDim: number;
    private trainingCount: number = 0;

    constructor(collectionId: string, inputDim: number) {
        this.collectionId = collectionId;
        this.inputDim = inputDim;
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
     * Load adapter weights from MongoDB or initialize if not exists
     */
    async loadOrInitialize(): Promise<void> {
        const adapterDoc = await Adapter.findById(this.collectionId);
        
        if (adapterDoc && adapterDoc.weights) {
            // Load existing weights
            this.model = tf.sequential();
            
            const weights = tf.tensor2d(adapterDoc.weights);
            const bias = adapterDoc.bias 
                ? tf.tensor1d(adapterDoc.bias) 
                : tf.zeros([this.inputDim]);

            try {
                this.model.add(tf.layers.dense({
                    units: adapterDoc.outputDim,
                    inputShape: [adapterDoc.inputDim],
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

            this.inputDim = adapterDoc.inputDim;
            this.trainingCount = adapterDoc.trainingCount;
        } else {
            // Initialize new model with identity matrix
            this.initializeModel();
        }
    }

    /**
     * Save adapter weights to MongoDB
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

        await Adapter.findByIdAndUpdate(
            this.collectionId,
            {
                _id: this.collectionId,
                weights: weightMatrix,
                bias: biasVector,
                inputDim: this.inputDim,
                outputDim: this.inputDim,
                trainingCount: this.trainingCount
            },
            { upsert: true, new: true }
        );
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
            const adapterDoc = await Adapter.findById(collectionId);
            if (!adapterDoc || adapterDoc.trainingCount === 0) {
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
        const adapterDoc = await Adapter.findById(collectionId);
        return !!(adapterDoc && adapterDoc.trainingCount > 0);
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
