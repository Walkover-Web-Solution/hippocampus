import { Document, Schema, model } from 'mongoose';
import { Collection as CollectionType } from '../type/collection';

const collectionSchema = new Schema(
    {
        name: {
            type: String,
            required: true
        },
        description: {
            type: String,
            required: false
        },
        metadata: {
            type: Map,
            of: Schema.Types.Mixed,
            required: false
        },
        settings: {
            type: {
                encoder: {
                    type: String,
                    required: true,
                    default: "BAAI/bge-small-en-v1.5"
                },
                chunkSize: {
                    type: Number,
                    required: true,
                    default: 1024
                },
                chunkOverlap: {
                    type: Number,
                    required: true,
                    default: 200
                }
            },
            required: true,
            _id: false
        }
    },
    {
        timestamps: true, // Automatically adds `createdAt` and `updatedAt` fields
        versionKey: false, // Remove `__v` field
    }
);


export const Collection = model<CollectionType>('Collection', collectionSchema);