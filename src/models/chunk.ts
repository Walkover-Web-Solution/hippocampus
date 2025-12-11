import { Document, Schema, model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { Chunk as ChunkType } from '../type/chunk';

const chunkSchema = new Schema(
    {
        _id: {
            type: String,
            default: uuidv4
        },
        data: {
            type: String,
            required: true
        },
        resourceId: {
            type: Schema.Types.ObjectId,
            ref: 'Resource',
            required: true
        },
        collectionId: {
            type: Schema.Types.ObjectId,
            ref: 'Collection',
            required: true
        },
        ownerId: {
            type: String,
            required: true,
            default: "public"
        }
    },
    {
        timestamps: true, // Automatically adds `createdAt` and `updatedAt` fields
        versionKey: false // Remove `__v` field
    }
);


export const Chunk = model<ChunkType>('Chunk', chunkSchema);
