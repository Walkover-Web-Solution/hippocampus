import { decide, noul } from '../../core/jev';

// Maker-checker (the banking "four-eyes" rule) for invalidation: the LLM that resolves facts proposes
// which existing facts a new one makes untrue, and an independent judge (Jev) can veto a proposal when
// it is confident the two facts are about different things (another milestone's deadline, a sub-item,
// a related contract). A cancellation or a new value of the same thing is never vetoed.

const DIFFERENT = noul(
    'Is new_fact about a different thing than existing_fact (another project, phase, milestone, document, deliverable, contract, team, sub-team, product, program, service, API or person)?',
    'Yes: a different thing, even if it is related or similarly named.',
    'No: the same thing (possibly called by another name), including when new_fact changes, corrects or cancels it.'
);

export const CHECKER_VETO = 0.8;

export async function vetoInvalidations(
    newFact: string,
    evidence: string,
    proposed: { uuid: string; fact: string }[]
): Promise<{ kept: { uuid: string; fact: string; different: number }[]; confirmed: string[] }> {
    const checks = await Promise.all(proposed.map(async (existing) => {
        const answers = await decide({ new_fact: newFact, new_statement: evidence, existing_fact: existing.fact }, { different: DIFFERENT });
        return { ...existing, different: answers.different.noul };
    }));
    return {
        kept: checks.filter((c) => c.different >= CHECKER_VETO),
        confirmed: checks.filter((c) => c.different < CHECKER_VETO).map((c) => c.uuid),
    };
}
