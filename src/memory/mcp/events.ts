import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import type { RecalledMemory, Turn } from '../core/types';

// Everything the memory server received and what each memory version did with it, for the UI.
// Persisted as JSONL (one line per change; later lines for the same id win), so a stdio server
// started by Claude Desktop and the HTTP server's UI share one timeline.

export type EventKind = 'remember' | 'recall' | 'list' | 'consolidate' | 'dream';
export type EventStatus = 'queued' | 'running' | 'done' | 'error';
export type StepKind =
    | 'gate' | 'new' | 'invalidated' | 'disputed' | 'duplicate' | 'proposed' | 'unchanged'
    | 'skipped' | 'dropped' | 'rejected' | 'matched' | 'not-matched' | 'extracted' | 'kept' | 'buffered' | 'info';

export interface Step {
    kind: StepKind;
    text: string;
}

export interface MemoryEvent {
    id: string;
    // Requests sent to several versions at once share a group, so the UI can show them side by side.
    group: string;
    at: string;
    version: string;
    source: 'mcp' | 'ui' | 'stdio';
    client: string | null;
    kind: EventKind;
    person: string;
    team: string | null;
    status: EventStatus;
    // remember: the message as the approach received it; recall/list: the query.
    message?: { kind: 'user' | 'agent'; agent: string; occurredAt: string; turns: Turn[]; context: Turn[]; assistantConfirmed?: boolean };
    query?: { text: string; asOf: string | null; includeProposed: boolean; topK: number; now: string };
    steps?: Step[];
    memories?: RecalledMemory[];
    // recall from the UI chat: an answer written from the memories by the shared answerer.
    answer?: string;
    ms?: number;
    error?: string;
}

// Turns an approach's ingest notes into typed steps. Order matters: the specific patterns first.
export function classifyNote(note: string): Step {
    // Consolidation prefixes each message's notes with "#2 Priya Sharma: "; classify what follows.
    const body = note.replace(/^#\d+ [^:]+: /, '');
    const rules: [RegExp, StepKind][] = [
        [/^working memory/, 'buffered'],
        [/^consolidated \d+/, 'info'],
        [/^merged "/, 'matched'],
        [/no longer true \(after/, 'invalidated'],
        [/" repeats "/, 'duplicate'],
        [/^gate:/, 'gate'],
        [/^checker kept/, 'kept'], // temporal-kg +checker vetoed an invalidation
        [/^(match rejected|inval rejected)/, 'not-matched'],
        [/^(match|inval)( by description)?:/, 'matched'],
        [/^skip/, 'skipped'],
        [/^drop/, 'dropped'],
        [/^reject/, 'rejected'],
        [/disputed/, 'disputed'],
        [/\(invalidated \d+\)|superseded/, 'invalidated'],
        [/duplicate of existing|→ noop/, 'duplicate'],
        [/proposed/, 'proposed'],
        [/ new fact|→ current/, 'new'],
        [/^no facts|nothing extracted/, 'unchanged'],
        [/^stored the raw message/, 'new'], // naive
    ];
    const kind = rules.find(([pattern]) => pattern.test(body))?.[1] ?? 'info';
    return { kind, text: note };
}

export class EventLog {
    private events = new Map<string, MemoryEvent>();
    private loadedBytes = 0;

    constructor(private file: string) {
        mkdirSync(path.dirname(file), { recursive: true });
    }

    record(event: MemoryEvent): MemoryEvent {
        this.events.set(event.id, event);
        appendFileSync(this.file, JSON.stringify(event) + '\n');
        return event;
    }

    update(event: MemoryEvent, change: Partial<MemoryEvent>): MemoryEvent {
        return this.record(Object.assign(event, change));
    }

    // Empties the timeline (memories in the stores are kept).
    clear() {
        writeFileSync(this.file, '');
        this.events.clear();
        this.loadedBytes = 0;
    }

    // Newest first. Re-reads lines other processes (a stdio server) appended since the last call.
    list(limit = 500): MemoryEvent[] {
        this.refresh();
        return [...this.events.values()].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, limit);
    }

    private refresh() {
        if (!existsSync(this.file)) return;
        const content = readFileSync(this.file);
        if (content.length < this.loadedBytes) {
            this.events.clear(); // the file was cleared
            this.loadedBytes = 0;
        }
        const fresh = content.subarray(this.loadedBytes).toString('utf8');
        const complete = fresh.lastIndexOf('\n') + 1;
        for (const line of fresh.slice(0, complete).split('\n')) {
            if (!line.trim()) continue;
            try {
                const event = JSON.parse(line) as MemoryEvent;
                this.events.set(event.id, event);
            } catch {
                // a torn line from a concurrent writer; skip it
            }
        }
        this.loadedBytes += Buffer.byteLength(fresh.slice(0, complete), 'utf8');
    }
}
