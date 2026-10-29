import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { DATA_DIR } from './embed';
import { recordJev } from './meter';

// Client for Jev (typesafe/jev-1.13) via the OpenRouter Decisions API: a `state` plus typed questions
// in, calibrated answers out (no generation). See work/jev/experiments for how it behaves.

export interface NoulQuestion {
    type: 'noul';
    instructions: string;
    criteria: { true: string; false: string };
}

export interface ChoiceQuestion {
    type: 'choice';
    instructions: string;
    criteria: Record<string, string>;
}

export type JevQuestion = NoulQuestion | ChoiceQuestion;

export interface NoulAnswer {
    type: 'noul';
    // Probability that the answer is true.
    noul: number;
}

export interface ChoiceAnswer {
    type: 'choice';
    choice: string;
    probabilities: Record<string, number>;
    confidence: number;
}

type AnswerFor<Q extends JevQuestion> = Q extends NoulQuestion ? NoulAnswer : ChoiceAnswer;

const DEFAULT_URL = 'https://openrouter.ai/api/alpha/decisions';

export async function decide<Q extends Record<string, JevQuestion>>(state: unknown, questions: Q): Promise<{ [K in keyof Q]: AnswerFor<Q[K]> }> {
    const body = { model: process.env.JEV_MODEL || 'typesafe/jev-1.13', state, questions };
    // Identical requests are served from disk: re-runs are free and see the same answers.
    const cacheDir = process.env.MEMORY_JEV_CACHE_DIR || path.join(DATA_DIR, 'jev-cache');
    const cacheFile = path.join(cacheDir, `${createHash('sha1').update(JSON.stringify(body)).digest('hex')}.json`);
    if (existsSync(cacheFile)) {
        // Meter cache hits at their original cost, so variants sharing the cache report comparable cost.
        const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
        recordJev(cached.usage?.cost ?? 0);
        return cached.answers;
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set (Jev runs through OpenRouter; add it to .env)');
    for (let attempt = 1; ; attempt++) {
        let res: Response;
        try {
            res = await fetch(process.env.JEV_URL || DEFAULT_URL, {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        } catch (error) {
            // Network failure (connection reset, DNS, timeout): back off and retry like a 5xx.
            if (attempt < 8) {
                await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** Math.min(attempt, 5)));
                continue;
            }
            throw error;
        }
        const text = await res.text();
        if (res.ok) {
            const data = JSON.parse(text);
            recordJev(data.usage?.cost ?? 0);
            mkdirSync(cacheDir, { recursive: true });
            writeFileSync(cacheFile, JSON.stringify(data));
            return data.answers;
        }
        // Rate limits and transient errors: back off and retry, as in the Jev experiments.
        if (attempt < 6 && (res.status === 429 || res.status >= 500)) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
            continue;
        }
        throw new Error(`Jev HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
}

export const noul = (instructions: string, whenTrue: string, whenFalse: string): NoulQuestion => ({
    type: 'noul',
    instructions,
    criteria: { true: whenTrue, false: whenFalse },
});

export const choice = (instructions: string, options: Record<string, string>): ChoiceQuestion => ({
    type: 'choice',
    instructions,
    criteria: options,
});
