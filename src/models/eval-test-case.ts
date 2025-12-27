import { Schema, model } from 'mongoose';
import { EvalTestCase as EvalTestCaseType } from '../type/eval';

const evalTestCaseSchema = new Schema(
    {
        datasetId: {
            type: Schema.Types.ObjectId,
            ref: 'EvalDataset',
            required: true
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
evalTestCaseSchema.index({ datasetId: 1 });

export const EvalTestCase = model<EvalTestCaseType>('EvalTestCase', evalTestCaseSchema);
