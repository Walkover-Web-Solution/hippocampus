import { ApiError } from '../error/api-error';
import { Chunk } from '../models/chunk';
import { Chunk as ChunkType, CreateChunk, UpdateChunk } from '../type/chunk';

const createChunk = async (data: CreateChunk): Promise<ChunkType> => {
    const chunk = new Chunk(data);
    return await chunk.save();
};

const getChunkById = async (id: string): Promise<ChunkType | null> => {
    return await Chunk.findById(id);
};

const getChunkByResourceId = async (resourceId: string): Promise<ChunkType[] | null> => {
    return await Chunk.find({ resourceId });
}

const updateChunk = async (id: string, data: UpdateChunk): Promise<ChunkType | null> => {
    return await Chunk.findByIdAndUpdate(id, data, { new: true });
};

const deleteChunk = async (id: string): Promise<ChunkType | null> => {
    return await Chunk.findByIdAndDelete(id);
};
const deleteChunksByResource = async (resourceId: string): Promise<any> => {
    try {
        // const chunks = await Chunk.find({ resourceId }) as ChunkType[];

        // Delete chunks from database
        const result = await Chunk.deleteMany({ resourceId });
        return result;
    } catch (error: any) {
        throw new ApiError(`Failed to delete chunks for resource: ${error.message}`, 500);
    }
}

export default {
    createChunk,
    getChunkById,
    updateChunk,
    deleteChunk,
    deleteChunksByResource,
    getChunkByResourceId
};
