import { z } from 'zod';
import { Encoder } from '../service/encoder';

const encoderInstance = new Encoder();

export const EncoderSchema = z.string().superRefine((val, ctx) => {
  if (!encoderInstance.isValid(val)) {
    const validModels = encoderInstance.getModels().map(m => m.id).join(", ");
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid model '${val}'. Supported models are: ${validModels}`,
      fatal: true
    });
  }
});


// Define the Zod schema for the settings sub-document
export const CollectionSettingsSchema = z.object({
  encoder: EncoderSchema.default('BAAI/bge-small-en-v1.5'),
  chunkSize: z.number().max(512).default(512),
  chunkOverlap: z.number().default(100),
});

// Define the Zod schema for the Collection model
export const CollectionSchema = z.object({
  _id: z.string().optional(), // MongoDB ObjectId as string
  name: z.string(),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(), // Map type
  settings: CollectionSettingsSchema.default({
    encoder: 'BAAI/bge-small-en-v1.5',
    chunkSize: 512,
    chunkOverlap: 100,
  }), // Make settings required with a default
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});

// Infer the TypeScript type from the Zod schema
export type Collection = z.infer<typeof CollectionSchema>;

// Optional: Zod schema for creating a new collection (without _id and timestamps)
export const CreateCollectionSchema = CollectionSchema.omit({
  _id: true,
  createdAt: true,
  updatedAt: true,
});

export type CreateCollection = z.infer<typeof CreateCollectionSchema>;

// Optional: Zod schema for updating a collection (all fields optional)
export const UpdateCollectionSchema = CollectionSchema.partial().omit({
  _id: true,
  createdAt: true,
  updatedAt: true,
});

export type UpdateCollection = z.infer<typeof UpdateCollectionSchema>;
