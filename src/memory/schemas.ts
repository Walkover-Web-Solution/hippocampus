import { z } from 'zod';

/**
 * The shape and size of the memory API's request bodies. Names, dates and grants are checked in the service; these
 * only keep malformed or oversized input out.
 */
export const MAX_BODY = 2_000_000;

const source = z.object({ type: z.string().max(64), id: z.string().max(512) }).nullable().optional();
const labels = z.array(z.string().max(64)).max(10).optional();
const spaces = z.array(z.string().max(202)).max(50).optional();
const text = (max: number) => z.string().max(max);

export const searchSchema = z.object({
    query: text(5000),
    spaces,
    space: z.string().optional(),
    kinds: z.array(z.string().max(32)).max(20).optional(),
    labels,
    as_of: z.string().optional(),
    top_k: z.number().int().optional(),
    max_distance: z.number().min(0).max(2).optional(),
    prompt: z.boolean().optional(),
}).passthrough();

export const writeSchema = z.object({
    space: z.string(),
    path: z.string().optional(),
    body: text(MAX_BODY).optional(),
    text: text(MAX_BODY).optional(),
    title: z.string().max(300).nullable().optional(),
    kind: z.string().optional(),
    slot: z.string().nullable().optional(),
    labels,
    valid_from: z.string().nullable().optional(),
    valid_to: z.string().nullable().optional(),
    source,
    confidence: z.number().min(0).max(1).optional(),
    if_version: z.number().int().optional(),
    entities: z.array(z.union([z.string(), z.object({ name: z.string(), type: z.string().optional() })])).max(40).optional(),
    relations: z.array(z.object({ subject: z.string(), relation: z.string(), object: z.string() })).max(30).optional(),
    merge: z.boolean().optional(),
    guard: z.boolean().optional(),
}).passthrough();

export const editSchema = z.object({
    space: z.string(),
    path: z.string(),
    ops: z.array(z.union([
        z.object({ op: z.literal('str_replace'), old: z.string().min(1), new: z.string() }),
        z.object({ op: z.literal('insert'), line: z.number().int().min(0), text: z.string() }),
        z.object({ op: z.literal('append'), text: z.string() }),
        z.object({ op: z.literal('prepend'), text: z.string() }),
        z.object({ op: z.literal('delete'), old: z.string().min(1) }),
    ])).max(50).optional(),
    body: text(MAX_BODY).optional(),
    title: z.string().max(300).nullable().optional(),
    kind: z.string().optional(),
    slot: z.string().nullable().optional(),
    labels,
    valid_to: z.string().nullable().optional(),
    source,
    if_version: z.number().int().optional(),
}).passthrough();

export const learnSchema = z.object({
    space: z.string(),
    shared_space: z.string().optional(),
    // "infer" (default): the extractor sorts personal from shared. "all": everything learned goes to shared_space.
    share: z.enum(['infer', 'all']).optional(),
    messages: z.array(z.object({ role: z.string().max(32), content: z.string().max(20000) })).min(1).max(200).optional(),
    text: text(20000).optional(),
    source,
    rules_allowed: z.boolean().optional(),
    // What the space is about: the person speaking (named, so a memory they share says who), or a thing such as an
    // article or an account, which never sets rules and is named in every memory.
    subject: z.object({ kind: z.enum(['person', 'thing']).optional(), name: z.string().max(120).optional() }).optional(),
    // The product's own view of what is worth keeping; it steers relevance, never the guardrails.
    instructions: z.string().max(4000).optional(),
    async: z.boolean().optional(),
}).refine((value) => value.messages || value.text, { message: '"messages" or "text" is required' });

export const feedbackSchema = z.object({
    space: z.string(),
    task: text(5000),
    output: text(10000),
    outcome: z.enum(['good', 'bad', 'corrected']),
    correction: text(5000).optional(),
    note: text(2000).optional(),
    source,
});

export const documentSchema = z.object({
    space: z.string(),
    path: z.string().optional(),
    url: z.string().max(2048).optional(),
    content: text(MAX_BODY).optional(),
    title: z.string().max(300).optional(),
    kind: z.string().optional(),
    labels,
    source,
}).refine((value) => value.url || value.content !== undefined, { message: '"url" or "content" is required' });
