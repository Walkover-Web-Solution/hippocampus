import { z } from 'zod';
import { Encoder } from '../service/encoder';
import { validateCustomChunkingUrl } from '../utility';

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

export const SparseEncoderSchema = z.string().superRefine((val, ctx) => {
  if (!encoderInstance.isValidSparse(val)) {
    const validModels = encoderInstance.getSparseModels().map(m => m.id).join(", ");
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid sparse model '${val}'. Supported models are: ${validModels}`,
      fatal: true
    });
  }
});

export const RerankerSchema = z.string().superRefine((val, ctx) => {
  if (!encoderInstance.isValidReranker(val)) {
    const validModels = encoderInstance.getRerankerModels().map(m => m.id).join(", ");
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid reranker model '${val}'. Supported models are: ${validModels}`,
      fatal: true
    });
  }
});

export const CHUNKING_STRATEGIES = ["recursive", "semantic", "agentic", "custom"] as const;
export const ChunkingStrategySchema = z.enum(CHUNKING_STRATEGIES);
export type ChunkingStrategy = z.infer<typeof ChunkingStrategySchema>;
export const DEFAULT_CHUNKING_STRATEGY: ChunkingStrategy = "recursive";

export const ChunkingSettingsBaseSchema = z.object({
  chunkSize: z.number().max(4000).default(1000),
  chunkOverlap: z.number().default(100),
  strategy: ChunkingStrategySchema.default(DEFAULT_CHUNKING_STRATEGY),
  chunkingUrl: z.string().url().optional()
});

export const chunkingSettingsRefinement = async (data: any, ctx: z.RefinementCtx) => {
  if (data.strategy === "custom") {
    if (!data.chunkingUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "chunkingUrl is required when strategy is 'custom'",
        path: ["chunkingUrl"]
      });
      return;
    }

    // Validate the URL
    const isValid = await validateCustomChunkingUrl(data.chunkingUrl);
    if (!isValid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "chunkingUrl must return a valid JSON object with a 'chunks' array of { text: string, vectorSource?: string }. Payload sent: { content: 'Health check', ... }",
        path: ["chunkingUrl"]
      });
    }
  }
};

export const ChunkingSettingsSchema = ChunkingSettingsBaseSchema.superRefine(chunkingSettingsRefinement);

export type ChunkingSettings = z.infer<typeof ChunkingSettingsSchema>;

// Define the Zod schema for the settings sub-document
export const CollectionSettingsBaseSchema = ChunkingSettingsBaseSchema.extend({
  denseModel: EncoderSchema.default('BAAI/bge-small-en-v1.5'),
  sparseModel: SparseEncoderSchema.optional(),
  rerankerModel: RerankerSchema.optional(),
  keepDuplicate: z.boolean().default(false)
});
export const CollectionSettingsSchema = CollectionSettingsBaseSchema.superRefine(chunkingSettingsRefinement);
// Define the Zod schema for the Collection model
export const CollectionSchema = z.object({
  _id: z.string().optional(), // MongoDB ObjectId as string
  name: z.string(),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(), // Map type
  settings: CollectionSettingsSchema.default({
    denseModel: 'BAAI/bge-small-en-v1.5',
    chunkSize: 1000,
    chunkOverlap: 100,
    strategy: 'recursive'
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
