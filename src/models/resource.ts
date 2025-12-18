import { Timestamp } from "bson";
import { CHUNKING_STRATEGIES, DEFAULT_CHUNKING_STRATEGY } from "../type/collection";

const mongoose = require('mongoose');
const resourceSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            required: false
        },
        collectionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Collection',
            required: true
        },
        ownerId: {
            type: String,
            required: true,
            default: "public"
        },
        content: {
            type: String,
            required: false
        },
        description: {
            type: String,
            required: false
        },
        url: {
            type: String,
            required: false
        },
        metadata: {
            type: Map,
            of: mongoose.Schema.Types.Mixed,
            required: false
        },
        refreshedAt: {
            type: mongoose.Schema.Types.Date,
            required: false,
            default: null
        },
        isDeleted: {
            type: Boolean,
            default: false
        },
        settings: {
            type: {
                chunkSize: {
                    type: Number,
                    required: false
                },
                chunkOverlap: {
                    type: Number,
                    required: false
                },
                strategy: {
                    type: String,
                    enum: CHUNKING_STRATEGIES,
                    default: DEFAULT_CHUNKING_STRATEGY,
                    required: false
                },
                chunkingUrl: {
                    type: String,
                    required: false
                }
            },
            required: false,
            _id: false
        }
    },
    {
        timestamps: true, // Automatically adds `createdAt` and `updatedAt` fields
        versionKey: false, // Remove `__v` field
    }
);

resourceSchema.index({ collectionId: 1, ownerId: 1 });

export const Resource = mongoose.model('Resource', resourceSchema);
