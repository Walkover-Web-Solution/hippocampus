import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { MemoryAuth } from './auth';
import { memoryService } from './service';

/**
 * The verbs as tools, one definition each, served three ways: as MCP tools on /memory/mcp, as function definitions
 * on GET /memory/tools for products that run their own model, and as the HTTP routes themselves.
 */
export interface ToolDefinition {
    name: string;
    description: string;
    input: z.AnyZodObject;
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    run: (auth: MemoryAuth, args: Record<string, unknown>) => Promise<unknown>;
}

const space = z.string().describe('A space (folder) name, such as "users/maya", "teams/acme" or "product-truth".');
const spaces = z.array(z.string()).optional().describe('The spaces to look in, most specific first. Left out: every space this token can read, in the order it was granted.');
const path = z.string().describe('The note\'s path inside the space, such as "pricing" or "drafts/launch-email".');
const asOf = z.string().optional().describe('An ISO date-time: answer from what was current at that moment instead of now.');
const kind = z.string().optional().describe('The kind of note: "note" (default), "rule", "fact", "lesson", "doc", or a word of your own.');
const labels = z.array(z.string()).optional().describe('Tags of your own, up to 10, such as "billing".');
const validTo = z.string().optional().describe('ISO date-time after which the note is no longer used, for something true until a date. Leave it out for anything lasting.');
const source = z.object({ type: z.string(), id: z.string() }).optional().describe('Where this came from, such as { "type": "thread", "id": "chat-8f2a" }; deleting the source deletes what came from it.');
const ifVersion = z.number().int().optional().describe('The version you read. The write is refused when the note has moved on, so read it again first.');

export const TOOLS: ToolDefinition[] = [
    {
        name: 'memory_spaces',
        description: 'The spaces (folders) this token can reach, with how many notes each holds. Start here when you do not know what exists.',
        input: z.object({}),
        method: 'GET',
        path: '/spaces',
        run: (auth) => memoryService.spaces(auth),
    },
    {
        name: 'memory_index',
        description: 'What is in a space, or in one folder of it: every note\'s path, title, one-line summary and last update, plus the sub-folders. Read this first, then open what matters. Like listing a directory.',
        input: z.object({
            space, path: z.string().optional().describe('A folder inside the space; left out: the whole space.'), as_of: asOf, kind, labels,
        }),
        method: 'GET',
        path: '/index',
        run: (auth, args) => memoryService.index(auth, args),
    },
    {
        name: 'memory_open',
        description: 'Read one note in full: its body, title, dates and version. With as_of, the version that was current at that moment.',
        input: z.object({
            space, path, as_of: asOf, version: z.number().int().optional().describe('One numbered version from the note\'s history.'),
        }),
        method: 'GET',
        path: '/open',
        run: (auth, args) => memoryService.open(auth, args as { space: unknown; path: unknown }),
    },
    {
        name: 'memory_search',
        description: 'Find what is similar or relevant to a question across spaces: by meaning, by exact words and by shared names, with the links of the things named. Returns ranked notes with the matching excerpt, every rule in force, lessons from feedback, and a ready "What you remember" block for a prompt.',
        input: z.object({
            query: z.string().describe('What to look for, in a few words or a sentence.'),
            spaces,
            kinds: z.array(z.string()).optional().describe('Only these kinds of note.'),
            labels,
            as_of: asOf,
            top_k: z.number().int().optional().describe('How many notes to return; default 5, at most 50.'),
            prompt: z.boolean().optional().describe('False for a plain search without rules, lessons and the prompt block.'),
        }),
        method: 'POST',
        path: '/search',
        run: (auth, args) => memoryService.search(auth, args as { query: unknown }),
    },
    {
        name: 'memory_entity',
        description: 'Everything about one named thing: a customer, company, product, app, channel or person. Its notes, its links to other things ("acme uses hubspot") and the connected names you can look up next. Names are lowercase as remembered, such as "acme" or "#payments".',
        input: z.object({ name: z.string().describe('The name to look up.'), spaces, as_of: asOf }),
        method: 'POST',
        path: '/entity',
        run: (auth, args) => memoryService.entity(auth, args as { name: unknown }),
    },
    {
        name: 'memory_write',
        description: 'Create a note or replace its whole body with a new version. The old version stays in history. For a rule, give kind "rule" and a slot ("tone", "language"): one live rule per slot.',
        input: z.object({
            space, path: z.string().optional().describe('Where to write; left out: a path is made from the kind and the text.'), body: z.string().describe('The note, in Markdown.'), title: z.string().optional(), kind, slot: z.string().optional(), labels, valid_to: validTo, source, if_version: ifVersion,
        }),
        method: 'PUT',
        path: '/notes',
        run: (auth, args) => memoryService.write(auth, args),
    },
    {
        name: 'memory_edit',
        description: 'Change part of a note in place, like editing a file: replace one exact phrase, insert after a line, append or prepend. Each edit is a new version; six agents editing six paragraphs of one note do not overwrite each other.',
        input: z.object({
            space,
            path,
            ops: z.array(z.union([
                z.object({ op: z.literal('str_replace'), old: z.string(), new: z.string() }),
                z.object({ op: z.literal('insert'), line: z.number().int().describe('Insert after this many lines; 0 inserts at the top.'), text: z.string() }),
                z.object({ op: z.literal('append'), text: z.string() }),
                z.object({ op: z.literal('prepend'), text: z.string() }),
                z.object({ op: z.literal('delete'), old: z.string() }),
            ])).describe('The edits, applied in order. "old" must appear exactly once in the note.'),
            if_version: ifVersion,
        }),
        method: 'PATCH',
        path: '/notes',
        run: (auth, args) => memoryService.edit(auth, args),
    },
    {
        name: 'memory_remember',
        description: 'Save one thing worth knowing later: a lasting fact about a person, team or business, or a rule the user set for how to work. It is merged with what the space holds: a repeat confirms, a change replaces, anything else is added. Never save questions, one-off tasks, passwords, keys, card numbers, email addresses or phone numbers.',
        input: z.object({
            space, text: z.string().describe('One short sentence that makes sense later on its own, such as "Acme is launching Product X on November 3."'), kind: z.string().optional().describe('"fact" (default), "rule" (with a slot), or "lesson".'), slot: z.string().optional().describe('For a rule: what it controls, such as "tone" or "language".'), labels, valid_to: validTo, source,
        }),
        method: 'POST',
        path: '/notes',
        run: (auth, args) => memoryService.remember(auth, args),
    },
    {
        name: 'memory_learn',
        description: 'Read a conversation and keep what is lasting in it: rules from the user\'s own words, facts from anyone, merged with what is known. With shared_space, what is about the team or account goes there and what is personal stays in the space.',
        input: z.object({
            space,
            messages: z.array(z.object({ role: z.string(), content: z.string() })).optional().describe('The conversation; rules come only from "user" lines.'),
            text: z.string().optional().describe('Or plain text, read as the user speaking.'),
            shared_space: z.string().optional(),
            source,
        }),
        method: 'POST',
        path: '/learn',
        run: (auth, args) => memoryService.learn(auth, args),
    },
    {
        name: 'memory_delete',
        description: 'Forget: one note with its history (space and path), everything about a named thing (name), or everything from a source (source). Nothing derived survives.',
        input: z.object({
            space: z.string().optional(), path: z.string().optional(), name: z.string().optional().describe('A named thing to forget everywhere this token can write.'), source, spaces,
        }),
        method: 'DELETE',
        path: '/notes',
        run: async (auth, args) => {
            if (args.name) return memoryService.forgetEntity(auth, args as { name: unknown });
            if (args.source) return memoryService.forgetSource(auth, { ...(args.source as object), spaces: args.spaces } as unknown as { type: unknown; id: unknown });
            return memoryService.deleteNote(auth, args as { space: unknown; path: unknown });
        },
    },
];

export const toolByName = (name: string): ToolDefinition | undefined => TOOLS.find((tool) => tool.name === name);

// The tools as function definitions in the shape OpenAI-style APIs take, for a product that runs its own model
// and calls the HTTP routes itself.
export const functionDefinitions = (baseUrl?: string) => TOOLS.map((tool) => ({
    type: 'function',
    function: {
        name: tool.name,
        description: tool.description,
        // Untyped at the boundary: the converter's generic over the exact shape is too deep for the compiler.
        parameters: (zodToJsonSchema as any)(tool.input, { $refStrategy: 'none', target: 'openApi3' }),
    },
    http: { method: tool.method, url: `${baseUrl ?? ''}/memory${tool.path}` },
}));
