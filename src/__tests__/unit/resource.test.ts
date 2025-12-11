// src/__tests__/unit/resource.test.ts

import ResourceService from '../../service/resource';
import { Resource } from '../../models/resource';
import { ApiError } from '../../error/api-error';

// Mock the Resource model
jest.mock('../../models/resource');

describe('ResourceService Unit Tests', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('createResource', () => {
        it('should create and save a new resource', async () => {
            const mockData = {
                title: 'Test Resource',
                collectionId: 'col123',
                ownerId: 'user123',
                content: 'Some content'
            };
            const mockSavedResource = { _id: 'res123', ...mockData };
            
            // Mock constructor and save method
            const mockResourceInstance = {
                save: jest.fn().mockResolvedValue(mockSavedResource)
            };
            (Resource as unknown as jest.Mock).mockImplementation(() => mockResourceInstance);

            const result = await ResourceService.createResource(mockData as any);

            expect(Resource).toHaveBeenCalledWith(mockData);
            expect(mockResourceInstance.save).toHaveBeenCalled();
            expect(result).toEqual(mockSavedResource);
        });
    });

    describe('getResourceById', () => {
        it('should return a resource if found', async () => {
            const mockResource = { _id: 'res123', title: 'Found Resource' };
            (Resource.findById as jest.Mock).mockResolvedValue(mockResource);

            const result = await ResourceService.getResourceById('res123');
            expect(Resource.findById).toHaveBeenCalledWith('res123');
            expect(result).toEqual(mockResource);
        });

        it('should throw an error if resource is not found', async () => {
            (Resource.findById as jest.Mock).mockResolvedValue(null);

            await expect(ResourceService.getResourceById('res123'))
                .rejects.toThrow('Resource with ID res123 not found.');
        });
    });

    describe('getResourcesByCollectionId', () => {
        it('should return resources filtered by collectionId and ownerId', async () => {
            const mockResources = [{ _id: 'res1', title: 'Resource 1' }];
            (Resource.find as jest.Mock).mockResolvedValue(mockResources);

            const result = await ResourceService.getResourcesByCollectionId('col123', 'user123');

            expect(Resource.find).toHaveBeenCalledWith(
                { collectionId: 'col123', ownerId: 'user123' },
                { content: 0 } // Default projection excluding content
            );
            expect(result).toEqual(mockResources);
        });

        it('should include content if includeContent is true', async () => {
            const mockResources = [{ _id: 'res1', title: 'Resource 1', content: 'Full content' }];
            (Resource.find as jest.Mock).mockResolvedValue(mockResources);

            const result = await ResourceService.getResourcesByCollectionId('col123', 'user123', true);

            expect(Resource.find).toHaveBeenCalledWith(
                { collectionId: 'col123', ownerId: 'user123' },
                {} // Empty projection means include everything
            );
            expect(result).toEqual(mockResources);
        });
    });

    describe('updateResource', () => {
        it('should update and return the resource', async () => {
            const mockUpdatedResource = { _id: 'res123', title: 'Updated Title' };
            (Resource.findByIdAndUpdate as jest.Mock).mockResolvedValue(mockUpdatedResource);

            const result = await ResourceService.updateResource('res123', { title: 'Updated Title' });

            expect(Resource.findByIdAndUpdate).toHaveBeenCalledWith(
                'res123',
                { title: 'Updated Title' },
                { new: true }
            );
            expect(result).toEqual(mockUpdatedResource);
        });

        it('should throw error if resource to update not found', async () => {
            (Resource.findByIdAndUpdate as jest.Mock).mockResolvedValue(null);

            await expect(ResourceService.updateResource('res123', { title: 'Updated Title' }))
                .rejects.toThrow('Failed to update resource: Resource with ID res123 not found.');
        });
    });

    describe('deleteResource', () => {
        it('should soft delete a resource by default', async () => {
            const mockDeletedResource = { _id: 'res123', isDeleted: true };
            (Resource.findByIdAndUpdate as jest.Mock).mockResolvedValue(mockDeletedResource);

            const result = await ResourceService.deleteResource('res123');

            expect(Resource.findByIdAndUpdate).toHaveBeenCalledWith(
                'res123',
                { isDeleted: true },
                { new: true }
            );
            expect(result).toEqual(mockDeletedResource);
        });

        it('should hard delete a resource if soft is false', async () => {
            const mockDeletedResource = { _id: 'res123' };
            (Resource.deleteOne as jest.Mock).mockResolvedValue(mockDeletedResource);
            
            const result = await ResourceService.deleteResource('res123', false);
            
            expect(Resource.deleteOne).toHaveBeenCalledWith({ _id: 'res123' });
            expect(result).toEqual(mockDeletedResource);
        });
    });
});
