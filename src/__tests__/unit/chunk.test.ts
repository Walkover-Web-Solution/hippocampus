// src/__tests__/unit/chunk.test.ts

import ChunkService from '../../service/chunk';
import { Chunk } from '../../models/chunk';

jest.mock('../../models/chunk');

describe('ChunkService Unit Tests', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('createChunk', () => {
        it('should create and save a new chunk', async () => {
            const mockData = {
                data: 'Chunk content',
                resourceId: 'res123',
                collectionId: 'col123',
                ownerId: 'user123'
            };
            const mockSavedChunk = { _id: 'chunk123', ...mockData };

            const mockChunkInstance = {
                save: jest.fn().mockResolvedValue(mockSavedChunk)
            };
            (Chunk as unknown as jest.Mock).mockImplementation(() => mockChunkInstance);

            const result = await ChunkService.createChunk(mockData as any);

            expect(Chunk).toHaveBeenCalledWith(mockData);
            expect(mockChunkInstance.save).toHaveBeenCalled();
            expect(result).toEqual(mockSavedChunk);
        });
    });

    describe('getChunkById', () => {
        it('should return a chunk if found', async () => {
            const mockChunk = { _id: 'chunk123', data: 'content' };
            (Chunk.findById as jest.Mock).mockResolvedValue(mockChunk);

            const result = await ChunkService.getChunkById('chunk123');
            expect(Chunk.findById).toHaveBeenCalledWith('chunk123');
            expect(result).toEqual(mockChunk);
        });

        it('should return null if chunk is not found', async () => {
            (Chunk.findById as jest.Mock).mockResolvedValue(null);

            const result = await ChunkService.getChunkById('nonexistent');
            expect(result).toBeNull();
        });
    });

    describe('getChunkByResourceId', () => {
        it('should return chunks for a resource', async () => {
            const mockChunks = [{ _id: 'chunk1', resourceId: 'res1' }];
            (Chunk.find as jest.Mock).mockResolvedValue(mockChunks);

            const result = await ChunkService.getChunkByResourceId('res1');
            expect(Chunk.find).toHaveBeenCalledWith({ resourceId: 'res1' });
            expect(result).toEqual(mockChunks);
        });
    });

    describe('deleteChunk', () => {
        it('should delete a chunk by id', async () => {
            const mockDeletedChunk = { _id: 'chunk123' };
            (Chunk.findByIdAndDelete as jest.Mock).mockResolvedValue(mockDeletedChunk);

            const result = await ChunkService.deleteChunk('chunk123');
            expect(Chunk.findByIdAndDelete).toHaveBeenCalledWith('chunk123');
            expect(result).toEqual(mockDeletedChunk);
        });
    });

    describe('deleteChunksByResource', () => {
        it('should delete all chunks for a resource', async () => {
            const mockResult = { deletedCount: 5 };
            (Chunk.deleteMany as jest.Mock).mockResolvedValue(mockResult);

            const result = await ChunkService.deleteChunksByResource('res123');
            console.log("deleteChunksByResource result:", result);
            expect(Chunk.deleteMany).toHaveBeenCalledWith({ resourceId: 'res123' });
            expect(result).toEqual(mockResult);
        });

        it('should throw api error on failure', async () => {
            (Chunk.deleteMany as jest.Mock).mockRejectedValue(new Error('DB Error'));

            await expect(ChunkService.deleteChunksByResource('res123'))
                .rejects.toThrow('Failed to delete chunks for resource: DB Error');
        });
    });
});
