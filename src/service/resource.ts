import { ApiError } from '../error/api-error';
import { Resource } from '../models/resource';
import { Resource as ResourceType, CreateResource, UpdateResource } from '../type/resource';
import { ChunkingSettings } from '../type/collection';
import { ChunkEventSchema, DeleteEventSchema } from '../type/rag';

const RAG_QUEUE = process.env.RAG_QUEUE;

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



    static async getResourcesByCollectionId(collectionId: string, ownerId: string, includeContent: boolean = false): Promise<ResourceType[]> {
        try {
            const projection = includeContent ? {} : { content: 0 };
            const filter: Record<string, any> = { collectionId, isDeleted: false };
            if (ownerId) filter.ownerId = ownerId;
            const resources = await Resource.find(filter, projection);
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

    /**
     * Re-chunks an already loaded resource using its stored content.
     * Optional `settings` are merged into the resource's chunking settings and persisted,
     * then a delete + chunk event pair is published so the old chunks are replaced.
     */
    static async rechunkResource(id: string, settings?: Partial<ChunkingSettings>): Promise<ResourceType> {
        let resource = await this.getResourceById(id);
        if (resource.isDeleted) {
            throw new ApiError(`Resource with ID ${id} is deleted.`, 404);
        }
        if (!resource.content) {
            throw new ApiError(`Resource with ID ${id} has no content to re-chunk. Refresh the resource first.`, 400);
        }

        if (settings && Object.keys(settings).length > 0) {
            const currentSettings = (resource as any).settings?.toObject?.() ?? resource.settings ?? {};
            const mergedSettings = { ...currentSettings, ...settings };
            if (mergedSettings.strategy === 'custom' && !mergedSettings.chunkingUrl) {
                throw new ApiError("chunkingUrl is required when strategy is 'custom'", 400);
            }
            resource = await this.updateResource(id, { settings: mergedSettings });
        }

        await this.publishRechunkEvents(resource);
        await this.updateMetadata(id, { status: 'rechunking' }).catch(error => console.log(error));
        return resource;
    }

    /**
     * Drops the existing chunks of a resource and queues it to be chunked again.
     */
    private static async publishRechunkEvents(resource: ResourceType): Promise<void> {
        const resourceId = resource._id?.toString() as string;
        const collectionId = resource.collectionId?.toString();
        const meta = getUrlMeta(resource.url);

        const deleteEvent = DeleteEventSchema.parse({
            event: 'delete',
            data: { resourceId, collectionId, timestamp: Date.now() }
        });
        const chunkEvent = ChunkEventSchema.parse({
            event: 'chunk',
            data: {
                resourceId,
                collectionId,
                ownerId: resource.ownerId,
                content: resource.content,
                meta,
                timestamp: Date.now()
            }
        });

        // Loaded lazily: the producer opens a RabbitMQ connection as soon as it is imported.
        const producer = require('../config/producer').default;
        // Order matters: old chunks must be removed before the new ones are written.
        await producer.publishToQueue(RAG_QUEUE, deleteEvent);
        await producer.publishToQueue(RAG_QUEUE, chunkEvent);
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

function getUrlMeta(resourceUrl?: string): { domain?: string, extension?: string } {
    if (!resourceUrl) return {};
    try {
        const url = new URL(resourceUrl);
        const pathname = url.pathname;
        const extension = pathname.includes('.') ? pathname.split('.').pop() : 'html';
        return { domain: url.hostname, extension: extension?.toLocaleLowerCase() };
    } catch (error) {
        return {};
    }
}

export default ResourceService;
