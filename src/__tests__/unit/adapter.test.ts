// src/__tests__/unit/adapter.test.ts

import * as tf from '@tensorflow/tfjs';
import * as fs from 'fs';
import * as path from 'path';
import { LinearProjectionAdapter } from '../../service/adapter';
import { Adapter } from '../../models/adapter';

jest.mock('../../models/adapter');
jest.mock('fs');
jest.mock('../../config/env', () => ({
    default: {
        ADAPTER_USE_MONGO: false,
        ADAPTER_STORAGE_PATH: './test_adapter_models'
    }
}));

describe('LinearProjectionAdapter Unit Tests', () => {
    const mockCollectionId = 'test-collection-123';
    const inputDim = 3; // Small dimension for testing

    beforeEach(() => {
        jest.clearAllMocks();
        // Set TensorFlow backend to CPU for testing
        tf.setBackend('cpu');
        
        // Mock fs.existsSync to return false by default (no existing file)
        (fs.existsSync as jest.Mock).mockReturnValue(false);
    });

    afterEach(() => {
        // Dispose any lingering tensors
        tf.disposeVariables();
    });

    describe('initialization', () => {
        it('should initialize with identity matrix when no existing adapter', async () => {
            (fs.existsSync as jest.Mock).mockReturnValue(false);

            const adapter = new LinearProjectionAdapter(mockCollectionId, inputDim);
            await adapter.loadOrInitialize();

            // Transform a vector - should return same vector with identity initialization
            const testVector = [1.0, 2.0, 3.0];
            const result = await adapter.transform(testVector);

            // With identity matrix, output should be approximately equal to input
            expect(result.length).toBe(inputDim);
            expect(result[0]).toBeCloseTo(testVector[0], 2);
            expect(result[1]).toBeCloseTo(testVector[1], 2);
            expect(result[2]).toBeCloseTo(testVector[2], 2);

            adapter.dispose();
        });

        it('should load existing weights from file', async () => {
            // Create a weight matrix that doubles the first element
            const mockWeights = [
                [2.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0]
            ];
            const mockBias = [0.0, 0.0, 0.0];
            const mockData = {
                weights: mockWeights,
                bias: mockBias,
                inputDim: inputDim,
                outputDim: inputDim,
                trainingCount: 5
            };

            (fs.existsSync as jest.Mock).mockReturnValue(true);
            (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(mockData));

            const adapter = new LinearProjectionAdapter(mockCollectionId, inputDim);
            await adapter.loadOrInitialize();

            const testVector = [1.0, 2.0, 3.0];
            const result = await adapter.transform(testVector);

            // First element should be doubled due to weight matrix
            expect(result[0]).toBeCloseTo(2.0, 2);
            expect(result[1]).toBeCloseTo(2.0, 2);
            expect(result[2]).toBeCloseTo(3.0, 2);
            expect(adapter.getTrainingCount()).toBe(5);

            adapter.dispose();
        });
    });

    describe('transform', () => {
        it('should throw error if vector dimension mismatch', async () => {
            (fs.existsSync as jest.Mock).mockReturnValue(false);

            const adapter = new LinearProjectionAdapter(mockCollectionId, inputDim);
            await adapter.loadOrInitialize();

            const wrongDimVector = [1.0, 2.0]; // Only 2 dimensions instead of 3

            await expect(adapter.transform(wrongDimVector)).rejects.toThrow(
                'Vector dimension mismatch'
            );

            adapter.dispose();
        });

        it('should return transformed vector', async () => {
            (fs.existsSync as jest.Mock).mockReturnValue(false);

            const adapter = new LinearProjectionAdapter(mockCollectionId, inputDim);
            await adapter.loadOrInitialize();

            const testVector = [0.5, 0.3, 0.2];
            const result = await adapter.transform(testVector);

            expect(Array.isArray(result)).toBe(true);
            expect(result.length).toBe(inputDim);

            adapter.dispose();
        });
    });

    describe('train', () => {
        it('should train model to move query toward chunk', async () => {
            (fs.existsSync as jest.Mock).mockReturnValue(false);

            const adapter = new LinearProjectionAdapter(mockCollectionId, inputDim);
            await adapter.loadOrInitialize();

            const queryVector = [1.0, 0.0, 0.0];
            const chunkVector = [0.8, 0.2, 0.0];

            // Train multiple epochs to move query toward chunk
            for (let i = 0; i < 50; i++) {
                await adapter.train(queryVector, chunkVector, 1);
            }

            // After training, transform should move query closer to chunk
            const result = await adapter.transform(queryVector);
            
            // The transformed query should be closer to chunk vector
            const originalDistance = Math.sqrt(
                Math.pow(queryVector[0] - chunkVector[0], 2) +
                Math.pow(queryVector[1] - chunkVector[1], 2) +
                Math.pow(queryVector[2] - chunkVector[2], 2)
            );
            
            const newDistance = Math.sqrt(
                Math.pow(result[0] - chunkVector[0], 2) +
                Math.pow(result[1] - chunkVector[1], 2) +
                Math.pow(result[2] - chunkVector[2], 2)
            );

            expect(newDistance).toBeLessThan(originalDistance);

            adapter.dispose();
        });

        it('should increment training count', async () => {
            (fs.existsSync as jest.Mock).mockReturnValue(false);

            const adapter = new LinearProjectionAdapter(mockCollectionId, inputDim);
            await adapter.loadOrInitialize();

            expect(adapter.getTrainingCount()).toBe(0);

            await adapter.train([1.0, 0.0, 0.0], [0.8, 0.2, 0.0]);
            expect(adapter.getTrainingCount()).toBe(1);

            await adapter.train([0.0, 1.0, 0.0], [0.1, 0.9, 0.0]);
            expect(adapter.getTrainingCount()).toBe(2);

            adapter.dispose();
        });

        it('should throw error if vector dimensions mismatch', async () => {
            (fs.existsSync as jest.Mock).mockReturnValue(false);

            const adapter = new LinearProjectionAdapter(mockCollectionId, inputDim);
            await adapter.loadOrInitialize();

            const queryVector = [1.0, 0.0]; // Wrong dimension
            const chunkVector = [0.8, 0.2, 0.0];

            await expect(adapter.train(queryVector, chunkVector)).rejects.toThrow(
                'Vector dimensions mismatch'
            );

            adapter.dispose();
        });
    });

    describe('save', () => {
        it('should save weights to file', async () => {
            (fs.existsSync as jest.Mock).mockReturnValue(false);
            (fs.mkdirSync as jest.Mock).mockReturnValue(undefined);
            (fs.writeFileSync as jest.Mock).mockReturnValue(undefined);

            const adapter = new LinearProjectionAdapter(mockCollectionId, inputDim);
            await adapter.loadOrInitialize();

            await adapter.save();

            expect(fs.writeFileSync).toHaveBeenCalledWith(
                expect.stringContaining(`${mockCollectionId}.json`),
                expect.any(String),
                'utf-8'
            );

            adapter.dispose();
        });

        it('should throw error if model not initialized', async () => {
            const adapter = new LinearProjectionAdapter(mockCollectionId, inputDim);
            // Don't call loadOrInitialize

            await expect(adapter.save()).rejects.toThrow(
                'Model not initialized'
            );
        });
    });

    describe('dispose', () => {
        it('should dispose model without error', async () => {
            (fs.existsSync as jest.Mock).mockReturnValue(false);

            const adapter = new LinearProjectionAdapter(mockCollectionId, inputDim);
            await adapter.loadOrInitialize();

            expect(() => adapter.dispose()).not.toThrow();
        });

        it('should handle multiple dispose calls', async () => {
            (fs.existsSync as jest.Mock).mockReturnValue(false);

            const adapter = new LinearProjectionAdapter(mockCollectionId, inputDim);
            await adapter.loadOrInitialize();

            adapter.dispose();
            expect(() => adapter.dispose()).not.toThrow();
        });
    });
});
