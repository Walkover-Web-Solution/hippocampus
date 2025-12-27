import { Schema, model } from 'mongoose';
import { EvalDataset as EvalDatasetType } from '../type/eval';

const evalDatasetSchema = new Schema(
    {
        name: {
            type: String,
            required: true
        },
        description: {
            type: String,
            required: false
        }
    },
    {
        timestamps: true,
        versionKey: false
    }
);

export const EvalDataset = model<EvalDatasetType>('EvalDataset', evalDatasetSchema);
