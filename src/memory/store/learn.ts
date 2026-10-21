import logger from '../../service/logger';
import { models } from '../llm';
import { generatedPath, normalizeKind } from '../paths';
import { normalizeLabels, normalizeSlot } from '../text';
import {
    ExtractedOperation, ExtractionSubject, FeedbackInput, KnownMemory, Links, NOTE_KINDS, NoteRow, SearchHit, Source, SpaceRow,
} from '../types';
import { archiveNote, confirmNote, writeNote } from './notes';
import { knownEntities } from './graph';
import { listRules, searchNotes } from './search';

/**
 * Extraction is one writer onto the file system, like mem0's add: it reads a conversation, compares it with what the
 * spaces already hold, and adds, updates, confirms or forgets notes. A changed fact becomes a new version of the
 * note that held it; a forgotten one is archived and stays in history; a repeat is confirmed. Rules come only from
 * the user's own words.
 */
export type IndexState = 'indexed' | 'queued' | 'failed';
export type IndexFn = (note: NoteRow, links?: Links | null) => Promise<IndexState>;

export type SaveOutcome = 'added' | 'replaced' | 'confirmed';

export interface Previous {
    path: string;
    text: string;
}

export interface SaveResult {
    note: NoteRow;
    outcome: SaveOutcome;
    previous?: Previous;
    indexed: IndexState;
}

export interface RememberInput {
    space: SpaceRow;
    kind?: string | null;
    text: string;
    title?: string | null;
    slot?: string | null;
    labels?: string[] | null;
    validTo?: Date | null;
    source?: Source | null;
    confidence?: number | null;
    // A path pins the note: it is written there, merged with nothing.
    path?: string | null;
    links?: Links | null;
    // False saves exactly what was sent, compared with nothing. A rule still replaces its slot.
    merge?: boolean;
    change?: string;
    // False for a caller granted append, not write: a change to a note someone else created is added beside it
    // instead of replacing it.
    canReplace?: boolean;
}

const MIN_CONFIDENCE = 0.5;
const MIN_TEXT_LENGTH = 8;
const MAX_TEXT_LENGTH = 20000;
const RELATED = 10;
// Wider than recall: the extractor should see anything it might be about to repeat or contradict.
const RELATED_MAX_DISTANCE = 0.9;
// A saved note this close to a new one may be the same thing or an older version of it, worth a second look.
const MERGE_MAX_DISTANCE = 0.6;
const MERGE_CANDIDATES = 5;
// Two notes this close say the same thing; saving the second would only repeat the first in every prompt.
const DUPLICATE_DISTANCE = 0.05;
const LESSON_MAX_DISTANCE = 0.85;

interface Known {
    note: NoteRow;
    text: string;
}

const toKnown = (items: Known[], sharedSpaceId?: string | null, caller?: string): KnownMemory[] => items.map(({ note, text }, i) => ({
    ref: i + 1,
    kind: note.kind,
    slot: note.slot,
    text,
    evidenceCount: note.evidence_count,
    shared: Boolean(sharedSpaceId) && note.space_id === sharedSpaceId,
    writtenBy: note.written_by,
    mine: caller ? note.written_by === caller : undefined,
}));
const fromHits = (hits: SearchHit[]): Known[] => hits.map((hit) => ({ note: hit.note, text: hit.excerpt }));
const fromRules = (rules: NoteRow[]): Known[] => rules.map((note) => ({ note, text: note.body ?? note.summary ?? '' }));

// "until 2026-10-20" from the extractor becomes the start of that day, UTC. An end date already past is a misread
// date and would hide the note the moment it is saved, so it is dropped and the note kept.
const endOf = (day: string | null): Date | null => {
    const end = day ? new Date(`${day}T00:00:00.000Z`) : null;
    return end && end.getTime() > Date.now() ? end : null;
};

// "Friday, 16 October 2026 (2026-10-16)": the weekday and the year leave the model no room to guess "next Friday".
export const today = (): string => {
    const now = new Date();
    return `${now.toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    })} (${now.toISOString().slice(0, 10)})`;
};

/**
 * Saves one memory the way a careful person would: a repeat confirms the saved one, a change replaces the saved one
 * (kept as history), anything else is added at a new path. A rule replaces whatever holds its slot.
 */
export async function remember(caller: string, input: RememberInput, index: IndexFn): Promise<SaveResult> {
    const kind = normalizeKind(input.kind ?? NOTE_KINDS.FACT);
    const slot = kind === NOTE_KINDS.RULE ? normalizeSlot(input.slot) : null;
    const text = input.text.trim();
    const labels = normalizeLabels(input.labels);
    const change = input.change ?? 'remember';
    const base = {
        space: input.space, body: text, title: input.title, kind, slot, labels: labels.length ? labels : undefined, validTo: input.validTo, source: input.source, confidence: input.confidence, change,
    };

    if (slot || input.path || input.merge === false) {
        const path = input.path ?? (slot ? `rules/${slot}` : generatedPath(kind, text));
        const result = await writeNote(caller, { ...base, path });
        const indexed = await index(result.note, input.links);
        return { note: result.note, outcome: result.created ? 'added' : 'replaced', indexed };
    }

    const candidates = await searchNotes({ spaces: [input.space], query: text, kinds: [kind], topK: MERGE_CANDIDATES, maxDistance: MERGE_MAX_DISTANCE });
    if (candidates.length) {
        const nearest = candidates[0];
        const decision = nearest.distance <= DUPLICATE_DISTANCE
            ? { decision: 'duplicate' as const, ref: 1 }
            : await models.reconcile(text, toKnown(fromHits(candidates), null, caller));
        const target = decision.ref ? candidates[decision.ref - 1] : undefined;
        if (decision.decision === 'duplicate' && target) {
            const note = (await confirmNote(target.note.id, labels)) ?? target.note;
            return { note, outcome: 'confirmed', previous: { path: target.note.path, text: target.excerpt }, indexed: 'indexed' };
        }
        if (decision.decision === 'replaces' && target && (input.canReplace !== false || target.note.written_by === caller)) {
            const result = await writeNote(caller, { ...base, path: target.note.path, labels: normalizeLabels([...target.note.labels, ...labels]) });
            const indexed = await index(result.note, input.links);
            return { note: result.note, outcome: 'replaced', previous: { path: target.note.path, text: target.excerpt }, indexed };
        }
    }
    const result = await writeNote(caller, { ...base, path: generatedPath(kind, text) });
    const indexed = await index(result.note, input.links);
    return { note: result.note, outcome: 'added', indexed };
}

export type LearnAction = 'added' | 'updated' | 'confirmed' | 'replaced' | 'forgotten' | 'reinforced' | 'revised';

export interface LearnChange {
    action: LearnAction;
    note: NoteRow;
    previous?: Previous;
}

export interface LearnResult {
    changes: LearnChange[];
    skipped: number;
    failed: number;
}

export interface LearnInput {
    // Where what is about the person goes, and, when given, where what is about their team or account goes.
    space: SpaceRow;
    sharedSpace?: SpaceRow | null;
    text: string;
    source?: Source | null;
    rulesAllowed?: boolean;
    // What the space is about; a thing never sets rules.
    subject?: ExtractionSubject | null;
    // Whether the caller may replace notes others created in a space (write) or only add beside them (append).
    canReplace?: (space: SpaceRow) => boolean;
    // The product's instructions on what is worth keeping, handed to the extractor as data.
    instructions?: string | null;
}

const links = (operation: ExtractedOperation): Links => ({ entities: operation.entities, relations: operation.relations });

async function apply(caller: string, input: LearnInput, operation: ExtractedOperation, known: Known | undefined, index: IndexFn): Promise<LearnChange | null> {
    // The space this piece of information belongs in. A change or a forget only touches a saved note in that same
    // space: the team's "formal tone" is never rewritten because one user wants casual replies.
    const space = operation.shared && input.sharedSpace ? input.sharedSpace : input.space;
    const canReplace = input.canReplace ? input.canReplace(space) : true;
    // A note someone else created is only this caller's to change with write on the space; with append, a change
    // is added beside it and a forget is skipped.
    const same = known && known.note.space_id === space.id && (canReplace || known.note.written_by === caller) ? known : undefined;
    const slot = operation.kind === NOTE_KINDS.RULE ? normalizeSlot(operation.slot) : null;
    const common = {
        space, kind: operation.kind, text: operation.text, slot, validTo: endOf(operation.expiresOn), source: input.source, confidence: operation.confidence, links: links(operation), change: 'learn', canReplace,
    };
    if (operation.action === 'forget') {
        if (!same) return null;
        const note = await archiveNote(same.note.id);
        return note ? { action: 'forgotten', note } : null;
    }
    if (operation.action === 'update' && same) {
        if (slot) {
            // A rule lives at its slot's path, so a changed slot moves it: the old holder is retired.
            const saved = await remember(caller, { ...common, labels: same.note.labels }, index);
            if (same.note.path !== saved.note.path) await archiveNote(same.note.id);
            return { action: 'updated', note: saved.note, previous: { path: same.note.path, text: same.text } };
        }
        const result = await writeNote(caller, { space, path: same.note.path, body: operation.text, kind: operation.kind, validTo: common.validTo, source: input.source, confidence: operation.confidence, change: 'learn', onlyOwn: !canReplace });
        await index(result.note, common.links);
        return { action: 'updated', note: result.note, previous: { path: same.note.path, text: same.text } };
    }
    const saved = await remember(caller, common, index);
    return { action: saved.outcome, note: saved.note, ...(saved.previous && { previous: saved.previous }) };
}

export async function learn(caller: string, input: LearnInput, index: IndexFn): Promise<LearnResult> {
    const result: LearnResult = { changes: [], skipped: 0, failed: 0 };
    const said = input.text.trim().slice(0, MAX_TEXT_LENGTH);
    if (said.length < MIN_TEXT_LENGTH || !/\p{L}/u.test(said)) return result;
    // A thing (an article, an account) never speaks, so nothing in the text can set a rule about it.
    const rulesAllowed = input.rulesAllowed !== false && input.subject?.kind !== 'thing';
    const spaces = [input.space, ...(input.sharedSpace ? [input.sharedSpace] : [])];

    const [rules, related, names] = await Promise.all([
        listRules(spaces),
        searchNotes({ spaces, query: said, kinds: [NOTE_KINDS.FACT], topK: RELATED, maxDistance: RELATED_MAX_DISTANCE }),
        knownEntities(spaces),
    ]);
    const known = [...new Map([...fromRules(rules), ...fromHits(related)].map((item) => [item.note.id, item])).values()];
    const operations = await models.extract(said, toKnown(known, input.sharedSpace?.id, caller), {
        sharedSpace: input.sharedSpace?.name ?? null,
        today: today(),
        rulesAllowed,
        knownEntities: names,
        subject: input.subject ?? null,
        instructions: input.instructions ?? null,
    });

    for (const operation of operations) {
        // Only the user sets rules: text from others (a ticket, a customer's chat) can never tell the assistant how to behave.
        if (operation.confidence < MIN_CONFIDENCE || (!rulesAllowed && operation.kind === NOTE_KINDS.RULE)) {
            result.skipped += 1;
            continue;
        }
        try {
            const change = await apply(caller, input, operation, operation.ref ? known[operation.ref - 1] : undefined, index);
            if (change) result.changes.push(change);
            else result.skipped += 1;
        } catch (error: any) {
            result.failed += 1;
            logger.error(`[MEMORY](learn) ${error?.message}`);
        }
    }
    return result;
}

/**
 * Turns feedback on an answer into a lesson used next time: a new lesson, one more confirmation of a saved lesson,
 * or a rewrite of a lesson the outcome proved wrong. A good outcome can only confirm a lesson that exists.
 */
export async function learnFromFeedback(caller: string, space: SpaceRow, feedback: FeedbackInput, source: Source | null | undefined, index: IndexFn): Promise<LearnChange[]> {
    const related = await searchNotes({
        spaces: [space],
        query: [feedback.task, feedback.correction, feedback.note].filter(Boolean).join('\n'),
        kinds: [NOTE_KINDS.LESSON],
        topK: 5,
        maxDistance: LESSON_MAX_DISTANCE,
    });
    const operations = (await models.distillLesson(feedback, toKnown(fromHits(related))))
        .filter((operation) => operation.confidence >= MIN_CONFIDENCE && (feedback.outcome !== 'good' || operation.action === 'reinforce'));
    const changes: LearnChange[] = [];
    for (const operation of operations) {
        const target = operation.ref ? related[operation.ref - 1] : undefined;
        if (operation.action === 'reinforce' && target) {
            const note = await confirmNote(target.note.id);
            if (note) changes.push({ action: 'reinforced', note });
        } else if (operation.action === 'revise' && target) {
            const result = await writeNote(caller, { space, path: target.note.path, body: operation.text, kind: NOTE_KINDS.LESSON, confidence: operation.confidence, source, change: 'feedback' });
            await index(result.note, { entities: [], relations: [] });
            changes.push({ action: 'revised', note: result.note, previous: { path: target.note.path, text: target.excerpt } });
        } else {
            const saved = await remember(caller, {
                space, kind: NOTE_KINDS.LESSON, text: operation.text, confidence: operation.confidence, source, links: { entities: [], relations: [] }, change: 'feedback',
            }, index);
            changes.push({ action: saved.outcome === 'confirmed' ? 'reinforced' : saved.outcome, note: saved.note, ...(saved.previous && { previous: saved.previous }) });
        }
    }
    return changes;
}
