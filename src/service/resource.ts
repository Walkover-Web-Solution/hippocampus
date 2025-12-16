import { ApiError } from '../error/api-error';
import { Resource } from '../models/resource';
import { Resource as ResourceType, CreateResource, UpdateResource } from '../type/resource';

class ResourceService {
    static async createResource(data: CreateResource): Promise<ResourceType> {
        const resource = new Resource(data);
        return await resource.save();
    };

    static async deleteResource(id: string, soft: boolean = true): Promise<ResourceType> {
        try {
            if (soft) {
                const result = await this.updateResource(id, { isDeleted: true });
                return result as ResourceType;
            }
            const deletedResource = await Resource.deleteOne({ _id: id });
            if (!deletedResource) {
                throw new Error(`Resource with ID ${id} not found.`);
            }
            return deletedResource;
        } catch (error: any) {
            throw new Error(`Failed to delete resource: ${error.message}`);
        }
    }

    static async updateResource(id: string, updateData: Partial<ResourceType>) {
        try {
            const updatedResource = await Resource.findByIdAndUpdate(id, updateData, {
                new: true,
            });
            if (!updatedResource) {
                throw new Error(`Resource with ID ${id} not found.`);
            }
            return updatedResource;
        } catch (error: any) {
            throw new ApiError(`Failed to update resource: ${error.message}`, 404);
        }
    }

    static async getResourceById(id: string): Promise<ResourceType> {
        try {
            const resource = await Resource.findById(id);

            if (!resource) {
                throw new Error(`Resource with ID ${id} not found.`);
            }
            return resource;
        } catch (error: any) {
            throw new ApiError(`Failed to retrieve resource: ${error.message}`, 404);
        }
    }



    static async getResourcesByCollectionId(collectionId: string, ownerId: string = "public", includeContent: boolean = false): Promise<ResourceType[]> {
        try {
            const projection = includeContent ? {} : { content: 0 };
            const resources = await Resource.find({ collectionId, ownerId, isDeleted: false }, projection);
            return resources;
        } catch (error: any) {
            throw new Error(`Failed to retrieve resources for collection: ${error.message}`);
        }
    }

    static async updateMetadata(id: string, metadata: Record<string, any>) {
        try {
            const updatedResource = await Resource.findByIdAndUpdate(
                id,
                { $set: { metadata } },
                { new: true }
            );
            if (!updatedResource) {
                throw new Error(`Resource with ID ${id} not found.`);
            }
            return updatedResource;
        } catch (error: any) {
            throw new ApiError(`Failed to update resource metadata: ${error.message}`, 404);
        }
    }

    static async getAllGoogleDocs(): Promise<ResourceType[]> {
        try {
            const resources = await Resource.find({
                url: { $regex: "^https://docs\\.google\\.com", $options: "i" } // Case-insensitive match
            });
            return resources;
        } catch (error: any) {
            throw new Error(`Failed to retrieve resources: ${error.message}`);
        }
    }
}

export default ResourceService;
