
import CollectionService from '../../service/collection';
import { Collection } from '../../models/collection';
import redis from '../../config/redis';
import { ApiError } from '../../error/api-error';

jest.mock('../../models/collection');
jest.mock('../../config/redis', () => ({
    cget: jest.fn(),
    cset: jest.fn(),
    del: jest.fn()
}));

describe('CollectionService Unit Tests', () => {
    const mockCollectionData = {
        name: 'Test Collection',
        description: 'Test Description',
        settings: {
            denseModel: 'BAAI/bge-small-en-v1.5',
            chunkSize: 1024,
            chunkOverlap: 200
        }
    };

    const mockSavedCollection = {
        _id: 'col123',
        ...mockCollectionData,
        createdAt: new Date(),
        updatedAt: new Date()
    };

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('createCollection', () => {
        it('should create and save a new collection', async () => {
            const mockCollectionInstance = {
                save: jest.fn().mockResolvedValue(mockSavedCollection)
            };
            (Collection as unknown as jest.Mock).mockImplementation(() => mockCollectionInstance);

            const result = await CollectionService.createCollection(mockCollectionData as any);

            expect(Collection).toHaveBeenCalledWith(mockCollectionData);
            expect(mockCollectionInstance.save).toHaveBeenCalled();
            expect(result).toEqual(mockSavedCollection);
        });
    });

    describe('getCollectionById', () => {
        it('should return collection from cache if available', async () => {
            (redis.cget as jest.Mock).mockResolvedValue(JSON.stringify(mockSavedCollection));

            const result = await CollectionService.getCollectionById('col123');

            expect(redis.cget).toHaveBeenCalledWith('hippocampus:collection:col123');
            expect(Collection.findById).not.toHaveBeenCalled();
            expect(result).toEqual(JSON.parse(JSON.stringify(mockSavedCollection))); // Handling date serialization
        });

        it('should return collection from DB if not in cache and cache it', async () => {
            (redis.cget as jest.Mock).mockResolvedValue(null);
            (Collection.findById as jest.Mock).mockResolvedValue(mockSavedCollection);

            const result = await CollectionService.getCollectionById('col123');

            expect(redis.cget).toHaveBeenCalledWith('hippocampus:collection:col123');
            expect(Collection.findById).toHaveBeenCalledWith('col123');
            expect(redis.cset).toHaveBeenCalledWith(
                'hippocampus:collection:col123',
                JSON.stringify(mockSavedCollection)
            );
            expect(result).toEqual(mockSavedCollection);
        });

        it('should throw ApiError if collection not found in DB', async () => {
            (redis.cget as jest.Mock).mockResolvedValue(null);
            (Collection.findById as jest.Mock).mockResolvedValue(null);

            await expect(CollectionService.getCollectionById('nonexistent'))
                .rejects.toThrow(ApiError);
            
             await expect(CollectionService.getCollectionById('nonexistent'))
                .rejects.toThrow('Failed to retrieve collection: Collection with ID nonexistent not found.');
        });
    });

    describe('updateCollection', () => {
        it('should update collection and clear cache', async () => {
            const updateData = { name: 'Updated Name', settings: { chunkSize: 500 } }; // Settings should be ignored
            const expectedUpdate = { name: 'Updated Name' };
            const mockUpdatedCollection = { ...mockSavedCollection, ...expectedUpdate };

            (Collection.findByIdAndUpdate as jest.Mock).mockResolvedValue(mockUpdatedCollection);

            const result = await CollectionService.updateCollection('col123', updateData as any);

            expect(Collection.findByIdAndUpdate).toHaveBeenCalledWith('col123', expect.objectContaining({ name: 'Updated Name' }), { new: true });
            // Ensure settings were removed from update data
            const updateCallArgs = (Collection.findByIdAndUpdate as jest.Mock).mock.calls[0][1];
            expect(updateCallArgs.settings).toBeUndefined();

            expect(redis.del).toHaveBeenCalledWith('hippocampus:collection:col123');
            expect(result).toEqual(mockUpdatedCollection);
        });
    });

    describe('deleteCollection', () => {
        it('should delete collection and clear cache', async () => {
            (Collection.findByIdAndDelete as jest.Mock).mockResolvedValue(mockSavedCollection);

            const result = await CollectionService.deleteCollection('col123');

            expect(Collection.findByIdAndDelete).toHaveBeenCalledWith('col123');
            expect(redis.del).toHaveBeenCalledWith('hippocampus:collection:col123');
            expect(result).toEqual(mockSavedCollection);
        });
    });
});
