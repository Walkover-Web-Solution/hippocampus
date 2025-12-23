import { Schema, model } from 'mongoose';

/**
 * Adapter model stores the trained linear projection weights
 * for query vector transformation to better match chunk vectors
 */
const adapterSchema = new Schema(
    {
        _id: {
            type: String, // collectionId
            required: true
        },
        weights: {
            type: [[Number]], // 2D array representing the weight matrix
            required: true
        },
        bias: {
            type: [Number], // 1D array for bias (optional, but useful for the model)
            required: false
        },
        inputDim: {
            type: Number,
            required: true
        },
        outputDim: {
            type: Number,
            required: true
        },
        trainingCount: {
            type: Number,
            default: 0
        }
    },
    {
        timestamps: true,
        versionKey: false
    }
);

export interface AdapterDocument {
    _id: string;
    weights: number[][];
    bias?: number[];
    inputDim: number;
    outputDim: number;
    trainingCount: number;
    createdAt?: Date;
    updatedAt?: Date;
}

export const Adapter = model<AdapterDocument>('Adapter', adapterSchema);
