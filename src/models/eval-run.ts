import { Schema, model } from 'mongoose';
import { EvalRun as EvalRunType } from '../type/eval';

const evalResultSchema = new Schema(
    {
        caseId: {
            type: Schema.Types.ObjectId,
            ref: 'EvalTestCase',
            required: true
        },
        query: {
            type: String,
            required: true
        },
        expectedChunkIds: {
            type: [String],
            required: true
        },
        retrievedChunkIds: {
            type: [String],
            required: true
        },
        isHit: {
            type: Boolean,
            required: true
        },
        recall: {
            type: Number,
            required: true
        },
        reciprocalRank: {
            type: Number,
            required: true
        }
    },
    {
        _id: false,
        versionKey: false
    }
);

const evalRunSchema = new Schema(
    {
        datasetId: {
            type: Schema.Types.ObjectId,
            ref: 'EvalDataset',
            required: true
        },
        timestamp: {
            type: Date,
            default: Date.now,
            required: true
        },
        overallScore: {
            type: Number,
            required: true
        },
        averageRecall: {
            type: Number,
            required: true
        },
        mrr: {
            type: Number,
            required: true
        },
        totalCases: {
            type: Number,
            required: true
        },
        hitCount: {
            type: Number,
            required: true
        },
        results: {
            type: [evalResultSchema],
            required: true
        }
    },
    {
        timestamps: true,
        versionKey: false
    }
);

// Index for efficient lookup by datasetId
evalRunSchema.index({ datasetId: 1 });

export const EvalRun = model<EvalRunType>('EvalRun', evalRunSchema);
