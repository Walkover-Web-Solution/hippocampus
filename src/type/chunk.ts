import { z } from 'zod';

// Define the Zod schema for the Chunk model
export const ChunkSchema = z.object({
  _id: z.string().optional(), // MongoDB ObjectId as string
  data: z.string(),
  vectorSource: z.string().optional(),
  resourceId: z.string(), // MongoDB ObjectId as string
  collectionId: z.string(), // MongoDB ObjectId as string
  ownerId: z.string().default("public"),
  vector: z.array(z.number()).optional(),
  sparseVector: z.object({
    indices: z.array(z.number()),
    values: z.array(z.number())
  }).optional(),
  rerankVector: z.array(z.array(z.number())).optional(),
  metadata: z.record(z.any()).optional(),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});

// Infer the TypeScript type from the Zod schema
export type Chunk = z.infer<typeof ChunkSchema>;

// Optional: Zod schema for creating a new chunk (without timestamps)
export const CreateChunkSchema = ChunkSchema.omit({
  createdAt: true,
  updatedAt: true,
});

export type CreateChunk = z.infer<typeof CreateChunkSchema>;

// Optional: Zod schema for updating a chunk (all fields optional)
export const UpdateChunkSchema = ChunkSchema.partial().omit({
  _id: true,
  createdAt: true,
  updatedAt: true,
});

export type UpdateChunk = z.infer<typeof UpdateChunkSchema>;