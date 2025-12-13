import { Schema, model } from 'mongoose';
import { Feedback as FeedbackType } from '../type/feedback';

const feedbackChunkSchema = new Schema({
    chunkId: {
        type: String,
        required: true,
        ref: 'Chunk'
    },
    score: {
        type: Number,
        default: 0
    },
    count: {
        type: Number,
        default: 0
    }
}, { _id: false });

const feedbackSchema = new Schema(
    {
        _id: {
            type: Schema.Types.String,
            require: true
        },
        query: {
            type: String,
            required: true
        },
        vector: {
            type: [Number], // Array of numbers for the dense vector
            required: true,
            select: false // Exclude by default to save bandwidth, fetch explicitly when needed
        },
        collectionId: {
            type: Schema.Types.ObjectId,
            ref: 'Collection',
            required: true
        },
        hits: {
            type: Map,
            of: feedbackChunkSchema,
            default: {}
        }
    },
    {
        timestamps: true,
        versionKey: false
    }
);

// Compound index to ensure unique queries per collection
feedbackSchema.index({ _id: 1 }, { unique: true });

export const Feedback = model<FeedbackType>('Feedback', feedbackSchema);
