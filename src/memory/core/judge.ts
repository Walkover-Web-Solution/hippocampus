import { z } from 'zod';
import { structured } from './llm';

const VerdictSchema = z.object({
    pass: z.boolean(),
    reason: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export interface JudgeInput {
    question: string;
    expectedAnswer: string | null;
    abstain: boolean;
    rubric: string | null;
    actualAnswer: string;
}

const SYSTEM = `You grade answers from a memory system against an expected answer.
Pass only if the actual answer states the expected information and contains nothing that contradicts it.
Equivalent formats count as the same (e.g. "Nov 5", "November 5", "2026-11-05").
Mentioning an older value as explicitly outdated/replaced is fine; presenting it as current is a fail.
If abstention is expected, pass only if the answer says it doesn't know and does not reveal the information.`;

export async function judge(input: JudgeInput): Promise<Verdict> {
    const expected = input.abstain
        ? 'The system should abstain (say it does not know).'
        : `Expected answer: ${input.expectedAnswer}`;
    const rubric = input.rubric ? `\nAdditional rubric: ${input.rubric}` : '';
    const user = `Question: ${input.question}\n${expected}${rubric}\n\nActual answer: ${input.actualAnswer}`;
    return structured({ name: 'answer_verdict', schema: VerdictSchema, system: SYSTEM, user });
}
