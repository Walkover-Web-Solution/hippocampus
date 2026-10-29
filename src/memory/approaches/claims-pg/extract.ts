import { z } from 'zod';
import { structured } from '../../core/llm';
import { selfFactsRule } from '../../core/scope-policy';
import { PersonRef, RawMessage, renderTurns } from '../../core/types';
import { PREDICATE_NAMES, describeVocabulary } from './vocabulary';

// The only place an LLM interprets a message. Everything downstream is deterministic.

const FactSchema = z.object({
    subject: z.string(),
    subject_kind: z.enum(['person', 'team', 'project', 'client', 'service', 'deliverable', 'other']),
    predicate: z.enum(PREDICATE_NAMES),
    value: z.string(),
    scope: z.enum(['personal', 'team']),
    operation: z.enum(['assert', 'retract']),
    certainty: z.enum(['stated', 'inferred', 'hypothetical']),
    evidence: z.string(),
});
const ExtractionSchema = z.object({ facts: z.array(FactSchema) });
export type ExtractedFact = z.infer<typeof FactSchema>;

const system = () => `You extract durable facts from a chat for a shared memory that serves a person and their teams. Express each fact as a (subject, predicate, value) claim, using ONLY the predicate vocabulary given.

Rules:
1. Extract only from the NEW turns. Earlier turns are context for resolving references; do not re-extract facts that appear only in earlier turns.
2. A fact counts when the user states or confirms it. If only the assistant asserts or guesses something and the user doesn't confirm it, use certainty "inferred". Hypotheticals, brainstorming, questions and undecided options get certainty "hypothetical". Chit-chat, generic how-to help and requests to the assistant are not facts at all.
3. If the user corrects a value within the new turns, output only the final value. If something is said to be no longer true or cancelled, use operation "retract" with the value being retracted.
4. subject: the specific thing the fact is about. When it refers to a known entity, reuse the known name exactly. For people use their full name from the people list; "I", "me", "my" mean the user. For counts, the subject names what is counted (e.g. "Phoenix beta testers").
5. value: dates as YYYY-MM-DD (resolve relative dates against the message time); money like "$240,000"; numbers as digits; people as full names; otherwise a short phrase that makes sense on its own.
6. scope: ${selfFactsRule()} Facts about projects, clients, services, decisions, rules, and about other people's work are "team" (shared with the active team). With no active team, everything is personal.
7. Prefer a specific predicate; use "note" only when nothing else fits.
8. evidence: a short verbatim quote from the new turns that states the fact.`;

export interface ExtractionInput {
    msg: RawMessage;
    actor: PersonRef;
    directory: PersonRef[];
    // e.g. "Phoenix (t-phoenix)" or "none".
    activeTeam: string;
    knownEntities: { name: string; kind: string }[];
}

export async function extractFacts(input: ExtractionInput): Promise<ExtractedFact[]> {
    const { msg } = input;
    const people = input.directory
        .map((p) => `- ${p.name}${p.aliases.length ? ` (also: ${p.aliases.join(', ')})` : ''}`)
        .join('\n');
    const entities = input.knownEntities.length
        ? input.knownEntities.map((e) => `- ${e.name} (${e.kind})`).join('\n')
        : '(none yet)';
    const user = [
        `Message time: ${msg.occurredAt}`,
        `App: ${msg.actorAgent}${msg.kind === 'agent' ? ' (these are notes an agent inferred, not the user\'s own words)' : ''}`,
        `User: ${input.actor.name}`,
        `Active team: ${input.activeTeam}`,
        '',
        'Predicate vocabulary:',
        describeVocabulary(),
        '',
        'People:',
        people,
        '',
        'Known entities:',
        entities,
        '',
        'Earlier turns:',
        msg.context.length ? renderTurns(msg.context) : '(none)',
        '',
        'New turns:',
        renderTurns(msg.turns),
    ].join('\n');
    const { facts } = await structured({ name: 'claim_extraction', schema: ExtractionSchema, system: system(), user });
    return facts;
}
