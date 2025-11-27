import { Collection } from '../models/collection';
import { Collection as CollectionType, CreateCollection, UpdateCollection } from '../type/collection';

const createCollection = async (data: CreateCollection): Promise<CollectionType> => {
    const collection = new Collection(data);
    return await collection.save();
};

const getCollectionById = async (id: string): Promise<CollectionType | null> => {
    return await Collection.findById(id);
};

const updateCollection = async (id: string, data: UpdateCollection): Promise<CollectionType | null> => {
    delete data.settings; // Settings are immutable after creation
    return await Collection.findByIdAndUpdate(id, data, { new: true });
};

const deleteCollection = async (id: string): Promise<CollectionType | null> => {
    return await Collection.findByIdAndDelete(id);
};

export default {
    createCollection,
    getCollectionById,
    updateCollection,
    deleteCollection
};
