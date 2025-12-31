import { Schema, model } from 'mongoose';
import { EvalTestCase as EvalTestCaseType } from '../type/eval';
import { EvalRun as EvalRunType } from '../type/eval';
import { EvalDataset as EvalDatasetType } from '../type/eval';

const evalTestCaseSchema = new Schema(
    {
        collectionId: {
            type: Schema.Types.ObjectId,
            ref: 'Collection',
            required: true
        },
        ownerId: {
            type: String,
            required: true,
            default: "public"
        },
        query: {
            type: String,
            required: true
        },
        expectedChunkIds: {
            type: [String],
            required: true
        }
    },
    {
        timestamps: true,
        versionKey: false
    }
);

// Index for efficient lookup by datasetId
evalTestCaseSchema.index({ collectionId: 1 });

export const EvalTestCase = model<EvalTestCaseType>('EvalTestCase', evalTestCaseSchema);

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
        collectionId: {
            type: Schema.Types.ObjectId,
            ref: 'Collection',
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
evalRunSchema.index({ collectionId: 1 });

export const EvalRun = model<EvalRunType>('EvalRun', evalRunSchema);


