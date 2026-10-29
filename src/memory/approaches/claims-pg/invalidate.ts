import { decide, noul } from '../../core/jev';
import { ClaimRow } from './store';

// Zep-style edge invalidation for claims: a new single-valued claim whose subject has no current value
// may still update an existing fact stated under another name ("the portal" for "patient portal").
// Jev compares the new statement with the most similar current claims of the same predicate, using
// the full claim text and evidence rather than names alone.

const UPDATES = noul(
    'Does new_statement give a new, corrected or repeated value for the SAME fact as existing_fact — the same property of the same real-world thing, possibly called by a different name, nickname, abbreviation or a misspelling?',
    'Yes: same thing, same property (for example a new date, owner, number or status for it).',
    'No: a different thing or a different property, even if similar or related.'
);
const DIFFERENT = noul(
    'Is new_statement about a different thing than existing_fact (another project, phase, milestone, document, contract, team, sub-team, product, program, service, API or person)?',
    'Yes: a different thing, even if it is related or similarly named.',
    'No: the same thing.'
);

export const UPDATE_THRESHOLD = 0.7;
export const DIFFERENT_VETO = 0.6;

export interface FactUpdate {
    target: ClaimRow;
    probability: number;
}

export async function findUpdatedFact(
    newClaim: string,
    evidence: string,
    occurredAt: string,
    candidates: ClaimRow[]
): Promise<{ update: FactUpdate | null; considered: { claim: string; updates: number; different: number }[] }> {
    const decisions = await Promise.all(candidates.map(async (row) => {
        const answers = await decide(
            {
                new_statement: evidence,
                new_claim: newClaim,
                new_time: occurredAt,
                existing_fact: row.claim_text,
                existing_time: row.recorded_at.toISOString(),
            },
            { updates: UPDATES, different: DIFFERENT }
        );
        return { row, updates: answers.updates.noul, different: answers.different.noul };
    }));
    const best = decisions
        .filter((d) => d.updates >= UPDATE_THRESHOLD && d.different < DIFFERENT_VETO && d.updates > d.different)
        .sort((a, b) => b.updates - a.updates)[0];
    return {
        update: best ? { target: best.row, probability: best.updates } : null,
        considered: decisions.map((d) => ({ claim: d.row.claim_text.split(' — ')[0], updates: d.updates, different: d.different })),
    };
}
