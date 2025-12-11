import { z } from "zod";

export const ResourceSchema = z.object({
  _id: z.string().optional(), // MongoDB ObjectId as string
  // Required fields
  title: z.string(),
  collectionId: z.string(), // MongoDB ObjectId as string
  ownerId: z.string().default("public"),
  createdBy: z.string().optional(), // MongoDB ObjectId as string
  content: z.string().optional(),
  refreshedAt: z.date().optional(),
  description: z.string().optional(),
  url: z.string().url().optional(),
  metadata: z.record(z.any()).optional(),
  isDeleted: z.boolean().optional(),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});

// Type inference
export type Resource = z.infer<typeof ResourceSchema>;

// Optional: Zod schema for creating a new resource (without _id and timestamps)
export const CreateResourceSchema = ResourceSchema.omit({
  _id: true,
  createdAt: true,
  updatedAt: true,
});

export type CreateResource = z.infer<typeof CreateResourceSchema>;

// Optional: Zod schema for updating a resource (all fields optional)
export const UpdateResourceSchema = ResourceSchema.partial().omit({
  _id: true,
  createdAt: true,
  updatedAt: true,
});

export type UpdateResource = z.infer<typeof UpdateResourceSchema>;