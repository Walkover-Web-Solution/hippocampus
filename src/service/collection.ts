import redis from '../config/redis';
import { ApiError } from '../error/api-error';
import { Collection } from '../models/collection';
import { CollectionSchema, CollectionSettingsBaseSchema, CollectionSettingsSchema, Collection as CollectionType, CreateCollection, UpdateCollection } from '../type/collection';
const getCollectionKey = (id: string) => `hippocampus:collection:${id}`;
const createCollection = async (data: CreateCollection): Promise<CollectionType> => {
    const collection = new Collection(data);
    return await collection.save();
};

const getCollectionById = async (id: string): Promise<CollectionType | null> => {
    try {
        const cacheKey = getCollectionKey(id);
        const cachedCollection = await redis.cget(cacheKey).catch((error) => null);
        if (cachedCollection) {
            return JSON.parse(cachedCollection);
        }
        const collection = await Collection.findById(id);
        if (!collection) {
            throw new Error(`Collection with ID ${id} not found.`);
        }
        redis.cset(cacheKey, JSON.stringify(collection));
        return collection;
    } catch (error: any) {
        throw new ApiError(`Failed to retrieve collection: ${error.message}`, 404);
    }
};

const updateCollection = async (id: string, data: UpdateCollection): Promise<CollectionType | null> => {
    if (data.settings) await updateCollectionSetting(id, data.settings);
    delete data.settings;
    const collection = await Collection.findByIdAndUpdate(id, data, { new: true });
    redis.del(getCollectionKey(id));
    return collection;
};

const updateCollectionSetting = async (id: string, setting: any) => {
    const verifiedSettings = CollectionSettingsBaseSchema.pick({ chunkingUrl: true, chunkOverlap: true, chunkSize: true, strategy: true, keepDuplicate: true }).partial().parse(setting);
    const updateData = {} as any;
    for (const [key, value] of Object.entries(verifiedSettings)) {
        updateData[`settings.${key}`] = value;
    }
    const collection = await Collection.findByIdAndUpdate(id, {
        $set: updateData
    }, { new: true });
    redis.del(getCollectionKey(id));
    return collection;
}

const deleteCollection = async (id: string): Promise<CollectionType | null> => {
    const collection = await Collection.findByIdAndDelete(id);
    redis.del(getCollectionKey(id));
    return collection;
};

export default {
    createCollection,
    getCollectionById,
    updateCollection,
    deleteCollection
};
