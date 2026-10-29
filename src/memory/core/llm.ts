import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { llmProvider, providerApiKey } from './env';
import { billedOutputTokens, recordLlm } from './meter';

// Every approach uses this model and temperature, so comparisons stay fair.
export const llmConfig = {
    provider: llmProvider().name,
    model: process.env.MEMORY_LLM_MODEL || llmProvider().defaultModel,
    // "default" leaves temperature unset (reasoning models reject anything else); empty = provider default.
    temperature: parseTemperature(process.env.MEMORY_LLM_TEMPERATURE),
    // Thinking budget for reasoning models (e.g. "low", "none"); empty = model default. Faster dev runs.
    reasoningEffort: (process.env.MEMORY_LLM_REASONING_EFFORT || null) as 'low' | 'medium' | 'high' | null,
};

// Sampling settings shared by every call.
export function samplingParams(): { temperature?: number; reasoning_effort?: 'low' | 'medium' | 'high' } {
    return {
        ...(llmConfig.temperature === null ? {} : { temperature: llmConfig.temperature }),
        ...(llmConfig.reasoningEffort ? { reasoning_effort: llmConfig.reasoningEffort } : {}),
    };
}

function parseTemperature(value: string | undefined): number | null {
    if (value === undefined || value === '') return llmProvider().defaultTemperature;
    if (value === 'default') return null;
    const parsed = Number(value);
    if (Number.isNaN(parsed)) throw new Error(`MEMORY_LLM_TEMPERATURE must be a number or "default", got ${value}`);
    return parsed;
}

let client: OpenAI | null = null;
let clientBaseUrl: string | undefined;

// OpenAI SDK client for the configured provider (OpenAI, or Gemini's OpenAI-compatible endpoint).
export function openaiClient(): OpenAI {
    const { baseURL } = llmProvider();
    if (!client || clientBaseUrl !== baseURL) {
        // Extra retries: rate limits (429) and network blips are common during long parallel eval runs.
        client = new OpenAI({ apiKey: providerApiKey(), baseURL, maxRetries: 10 });
        clientBaseUrl = baseURL;
    }
    return client;
}

interface StructuredRequest<T extends z.ZodTypeAny> {
    // Name of the response schema, e.g. "claim_extraction".
    name: string;
    // Root must be a z.object; use .nullable() instead of .optional() (OpenAI strict mode).
    schema: T;
    system: string;
    user: string;
}

export async function structured<T extends z.ZodTypeAny>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    const completion = await openaiClient().beta.chat.completions.parse({
        model: llmConfig.model,
        ...samplingParams(),
        messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
        ],
        response_format: zodResponseFormat(req.schema, req.name),
    });
    recordLlm(completion.usage?.prompt_tokens, billedOutputTokens(completion.usage));
    const message = completion.choices[0].message;
    if (message.refusal) throw new Error(`LLM refused ${req.name}: ${message.refusal}`);
    if (!message.parsed) throw new Error(`LLM returned no parsed output for ${req.name}`);
    return message.parsed;
}

export async function text(system: string, user: string): Promise<string> {
    const completion = await openaiClient().chat.completions.create({
        model: llmConfig.model,
        ...samplingParams(),
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
    });
    recordLlm(completion.usage?.prompt_tokens, billedOutputTokens(completion.usage));
    return completion.choices[0].message.content ?? '';
}
