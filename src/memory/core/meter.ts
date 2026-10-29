import { AsyncLocalStorage } from 'async_hooks';

// Process-wide usage counters. The harness diffs them around each ingest/recall, so approaches
// don't have to report their own cost.
// Calls the harness makes itself (answerer, judge) run inside `asHarness` and are counted separately,
// so they never show up in an approach's numbers even when they overlap with its ingest.
export interface Usage {
    llmCalls: number;
    promptTokens: number;
    completionTokens: number;
    embedCalls: number;
    embedTokens: number;
    jevCalls: number;
    jevCostUsd: number;
}

const counters: Usage = emptyUsage();
const harnessCounters: Usage = emptyUsage();
const harnessScope = new AsyncLocalStorage<true>();

export function asHarness<T>(fn: () => Promise<T>): Promise<T> {
    return harnessScope.run(true, fn);
}

export function harnessUsage(): Usage {
    return { ...harnessCounters };
}

const target = () => (harnessScope.getStore() ? harnessCounters : counters);

export function recordLlm(promptTokens = 0, completionTokens = 0) {
    const c = target();
    c.llmCalls += 1;
    c.promptTokens += promptTokens;
    c.completionTokens += completionTokens;
}

// Output tokens as billed. Gemini's OpenAI-compatible API leaves "thinking" tokens out of
// completion_tokens but bills them as output; they only show up in total_tokens.
export function billedOutputTokens(usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null): number {
    const completion = usage?.completion_tokens ?? 0;
    return Math.max(completion, (usage?.total_tokens ?? 0) - (usage?.prompt_tokens ?? 0));
}

export function recordEmbed(tokens = 0) {
    const c = target();
    c.embedCalls += 1;
    c.embedTokens += tokens;
}

export function recordJev(costUsd = 0) {
    const c = target();
    c.jevCalls += 1;
    c.jevCostUsd += costUsd;
}

export function usageSnapshot(): Usage {
    return { ...counters };
}

export function usageSince(before: Usage): Usage {
    const now = usageSnapshot();
    return combine(now, before, (a, b) => a - b);
}

export function emptyUsage(): Usage {
    return { llmCalls: 0, promptTokens: 0, completionTokens: 0, embedCalls: 0, embedTokens: 0, jevCalls: 0, jevCostUsd: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
    return combine(a, b, (x, y) => x + y);
}

function combine(a: Usage, b: Usage, op: (x: number, y: number) => number): Usage {
    const out = emptyUsage();
    for (const key of Object.keys(out) as (keyof Usage)[]) out[key] = op(a[key] ?? 0, b[key] ?? 0);
    return out;
}
