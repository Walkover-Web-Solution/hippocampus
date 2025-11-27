import z from 'zod';

export const EventTypeSchema = z.enum(['load', 'delete', 'chunk', 'update']);
export type EventType = z.infer<typeof EventTypeSchema>;
export const VERSION = '1.0.0';

export const LoadEventSchema = z.object({
    version: z.string().default(VERSION),
    event: z.literal('load'),
    data: z.object({
        resourceId: z.string(),
        collectionId: z.string(),
        url: z.string(),
        meta: z.object({
            domain: z.string().optional(),
            extension: z.string().optional()
        }),
        timestamp: z.number()
    })
});
export type LoadEvent = z.infer<typeof LoadEventSchema>;

export const ChunkEventSchema = z.object({
    version: z.string().default(VERSION),
    event: z.literal('chunk'),
    data: z.object({
        resourceId: z.string(),
        collectionId: z.string(),
        content: z.string(),
        public: z.boolean().default(true),
        meta: z.object({
            domain: z.string().optional(),
            extension: z.string().optional()
        }),
        timestamp: z.number()
    })
});
export type ChunkEvent = z.infer<typeof ChunkEventSchema>;


export const DeleteEventSchema = z.object({
    version: z.string().default(VERSION),
    event: z.literal('delete'),
    data: z.object({
        resourceId: z.string(),
        collectionId: z.string(),
        timestamp: z.number()
    })
});
export type DeleteEvent = z.infer<typeof DeleteEventSchema>;


export const UpdateEventSchema = z.object({
    version: z.string().default(VERSION),
    event: z.literal('update'),
    data: z.object({
        resourceId: z.string(),
        collectionId: z.string(),
        public: z.boolean(),
        timestamp: z.number()
    })
});


export const EventSchema = z.discriminatedUnion('event', [
    LoadEventSchema,
    ChunkEventSchema,
    DeleteEventSchema,
    UpdateEventSchema
]);

export type Event = z.infer<typeof EventSchema>;