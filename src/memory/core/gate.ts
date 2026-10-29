import { decide, noul } from './jev';
import { RawMessage, renderTurns } from './types';

// Ingest gate: one Jev call per exchange, before any LLM extraction, answering the judgements where
// memory goes wrong: is anything worth keeping, is it only hypothetical, is it private, did only the
// assistant say it. Calibrated probabilities let low-confidence cases fall back to normal extraction.

const QUESTIONS = {
    memorable: noul(
        'Does new_turns contain information worth keeping in long-term memory about the people, teams or projects?',
        'Yes: facts, decisions, preferences, plans, dates, ownership, roles, rules, or changes and corrections to earlier facts that the user states or confirms.',
        'No: only chit-chat, greetings, generic how-to help, questions to the assistant, or requests for drafts or code that add no new facts.'
    ),
    hypothetical: noul(
        'Is the information in new_turns only hypothetical or undecided?',
        'Yes: what-ifs, brainstorming, options being considered, nothing decided.',
        'No: something is stated as true, decided or planned.'
    ),
    private_only: noul(
        'Is everything worth remembering in new_turns private to the user?',
        "Yes: the user marks it as private, personal or just for themselves (their own targets, preferences, reminders) and none of it is meant for the team.",
        'No: at least some of it is information for the team or project, or nothing is marked as private.'
    ),
    assistant_only: noul(
        'Does the key information in new_turns come only from the assistant, without the user stating or confirming it?',
        'Yes: the assistant guessed, assumed or inferred it and the user did not confirm it.',
        'No: the user stated it or clearly confirmed it.'
    ),
};

// Thresholds on the probability of "yes". Acting only on confident answers keeps the gate safe:
// anything uncertain goes through normal extraction.
export const GATE_THRESHOLDS = {
    skipIfMemorableBelow: 0.2,
    skipIfHypotheticalAbove: 0.8,
    personalIfPrivateAbove: 0.7,
    proposedIfAssistantOnlyAbove: 0.7,
};

export interface GateDecision {
    // Why the exchange is skipped, or null to extract it.
    skip: string | null;
    // Force every fact from this exchange into the actor's personal scope.
    forcePersonal: boolean;
    // Record every fact from this exchange as proposed (unconfirmed).
    proposed: boolean;
    probabilities: Record<keyof typeof QUESTIONS, number>;
}

export function applyGate(p: GateDecision['probabilities']): GateDecision {
    const t = GATE_THRESHOLDS;
    const skip = p.memorable < t.skipIfMemorableBelow
        ? 'not worth remembering'
        : p.hypothetical > t.skipIfHypotheticalAbove
            ? 'hypothetical'
            : null;
    return {
        skip,
        forcePersonal: p.private_only > t.personalIfPrivateAbove,
        proposed: p.assistant_only > t.proposedIfAssistantOnlyAbove,
        probabilities: p,
    };
}

export async function gateExchange(msg: RawMessage): Promise<GateDecision> {
    const answers = await decide(
        {
            user: msg.actorName,
            active_team: msg.activeTeamId ?? 'none',
            source: msg.kind === 'agent' ? 'notes an agent inferred' : 'chat with an AI assistant',
            earlier_turns: msg.context.length ? renderTurns(msg.context) : '(none)',
            new_turns: renderTurns(msg.turns),
        },
        QUESTIONS
    );
    return applyGate({
        memorable: answers.memorable.noul,
        hypothetical: answers.hypothetical.noul,
        private_only: answers.private_only.noul,
        assistant_only: answers.assistant_only.noul,
    });
}

export function describeGate(g: GateDecision): string {
    const p = g.probabilities;
    const probs = `memorable ${p.memorable.toFixed(2)}, hypothetical ${p.hypothetical.toFixed(2)}, private ${p.private_only.toFixed(2)}, assistant-only ${p.assistant_only.toFixed(2)}`;
    if (g.skip) return `gate: skip (${g.skip}; ${probs})`;
    return `gate: extract${g.forcePersonal ? ' → personal' : ''}${g.proposed ? ' → proposed' : ''} (${probs})`;
}
