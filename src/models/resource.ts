import { Timestamp } from "bson";

const mongoose = require('mongoose');
const resourceSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            required: true
        },
        collectionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Collection',
            required: true
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
        }
    },
    {
        timestamps: true, // Automatically adds `createdAt` and `updatedAt` fields
        versionKey: false, // Remove `__v` field
    }
);


export const Resource = mongoose.model('Resource', resourceSchema);
