import { randomUUID } from 'crypto';
import { copyFileSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import { loadApproach } from '../approaches/registry';
import { answer } from '../core/answer';
import { DATA_DIR } from '../core/embed';
import { IdentityDirectory, Role, Team } from '../core/identity';
import { defaultScope, readableScopes, writableScopes } from '../core/scope';
import type { MemoryApproach, MemoryGraph, PersonRef, RawMessage, RecalledMemory, Scope, Turn } from '../core/types';
import { EventLog, MemoryEvent, classifyNote } from './events';

// The memory service behind the MCP tools and the UI: who is asking (world.json), which memory
// version handles it, and a record of every request and what the version did with it.

export const MCP_DIR = path.join(DATA_DIR, 'mcp');

// Shown first in the UI; any registered approach name also works.
export const FEATURED_VERSIONS = [
    'temporal-kg+vecmatch+rank+serial+crowd+gemma+link+consolidate',
    'temporal-kg+vecmatch+rank+serial+crowd+gemma+link',
    'temporal-kg+vecmatch+rank+serial+lexical',
    'temporal-kg+vecmatch',
    'claims-pg+gate+router',
    'naive',
];

export interface World {
    defaults: { person: string; team: string | null };
    people: PersonRef[];
    teams: Team[];
    memberships: { personId: string; teamId: string; role: Role }[];
}

export interface Identity {
    person: PersonRef;
    teamId: string | null;
}

export interface RememberRequest {
    version: string;
    person?: string;
    team?: string | null;
    // user: the person said it; agent: an agent inferred it (stored as unconfirmed).
    kind?: 'user' | 'agent';
    agent?: string;
    turns: Turn[];
    context?: Turn[];
    // ISO time the message happened; default now. Same time + different people = a concurrent write.
    occurredAt?: string;
    source: MemoryEvent['source'];
    client?: string | null;
    group?: string;
}

export interface RecallRequest {
    version: string;
    person?: string;
    team?: string | null;
    query: string;
    asOf?: string | null;
    includeProposed?: boolean;
    topK?: number;
    // Reads see what was written up to this time; default: now, or the latest write if that is later.
    now?: string;
    // Also write an answer from the memories (the eval's shared answerer), as a chat reply.
    answer?: boolean;
    source: MemoryEvent['source'];
    client?: string | null;
    group?: string;
}

export class MemoryService {
    readonly events: EventLog;
    private approaches = new Map<string, Promise<MemoryApproach>>();
    // One writer per version, in arrival order, like a queue consumer: a write sees the ones before it.
    private queues = new Map<string, Promise<unknown>>();
    private latestWrite = new Map<string, string>();
    private worldFile: string;

    constructor(files: { events?: string; world?: string } = {}) {
        this.events = new EventLog(files.events ?? path.join(MCP_DIR, 'events.jsonl'));
        this.worldFile = files.world ?? path.join(MCP_DIR, 'world.json');
        for (const e of this.events.list(100000)) {
            if (e.kind === 'remember' && e.message) this.noteWrite(e.version, e.message.occurredAt);
        }
    }

    world(): World {
        if (!existsSync(this.worldFile)) copyFileSync(path.join(__dirname, 'world.example.json'), this.worldFile);
        // Editors like Notepad (and PowerShell's Set-Content) may add a byte-order mark.
        return JSON.parse(readFileSync(this.worldFile, 'utf8').replace(/^﻿/, ''));
    }

    private directory(world: World): IdentityDirectory {
        return new IdentityDirectory(world.people, world.teams, world.memberships.map((m) => ({ ...m, validFrom: new Date(0), validTo: null })));
    }

    // person: id, name or alias; team: id or name, "none"/"" for no team, undefined for the default.
    identity(person?: string, team?: string | null): Identity {
        const world = this.world();
        const dir = this.directory(world);
        const found = dir.resolvePerson(person ?? world.defaults.person);
        if (!found) throw new Error(`Unknown person "${person}". Known: ${world.people.map((p) => p.id).join(', ')}`);
        const wanted = team === undefined ? world.defaults.team : team;
        if (wanted === null || wanted === '' || wanted === 'none') return { person: found, teamId: null };
        const t = world.teams.find((x) => x.id === wanted || x.name.toLowerCase() === wanted.toLowerCase());
        if (!t) throw new Error(`Unknown team "${wanted}". Known: ${world.teams.map((x) => `${x.id} (${x.name})`).join(', ')}`);
        return { person: found, teamId: t.id };
    }

    async approach(version: string): Promise<MemoryApproach> {
        let loading = this.approaches.get(version);
        if (!loading) {
            loading = loadApproach(version).then(async (approach) => {
                await approach.init();
                return approach;
            });
            loading.catch(() => this.approaches.delete(version));
            this.approaches.set(version, loading);
        }
        return loading;
    }

    // Every version writes into its own partition of the shared stores: "team:t-core~<version>".
    private ns(version: string, scope: Scope): Scope {
        return `${scope}~${version}`;
    }

    private plain(version: string, text: string): string {
        return text.split(`~${version}`).join('');
    }

    private noteWrite(version: string, occurredAt: string) {
        if (occurredAt > (this.latestWrite.get(version) ?? '')) this.latestWrite.set(version, occurredAt);
    }

    // Queues the write and returns its event at once; `done` settles when the version has processed it.
    remember(req: RememberRequest): { event: MemoryEvent; done: Promise<MemoryEvent> } {
        const { person, teamId } = this.identity(req.person, req.team);
        const occurredAt = new Date(req.occurredAt ?? Date.now()).toISOString();
        const id = randomUUID();
        const event = this.events.record({
            id, group: req.group ?? id, at: new Date().toISOString(), version: req.version, source: req.source, client: req.client ?? null,
            kind: 'remember', person: person.id, team: teamId, status: 'queued',
            message: { kind: req.kind ?? 'user', agent: req.agent ?? req.client ?? 'manual', occurredAt, turns: req.turns, context: req.context ?? [] },
        });
        this.noteWrite(req.version, occurredAt);

        const previous = this.queues.get(req.version) ?? Promise.resolve();
        const done = previous.then(() => this.process(event, person, teamId));
        this.queues.set(req.version, done.catch(() => undefined));
        return { event, done };
    }

    private async process(event: MemoryEvent, person: PersonRef, teamId: string | null): Promise<MemoryEvent> {
        const started = Date.now();
        this.events.update(event, { status: 'running' });
        try {
            const version = event.version;
            const approach = await this.approach(version);
            const world = this.world();
            const dir = this.directory(world);
            const message = event.message!;
            const at = new Date(message.occurredAt);
            const msg: RawMessage = {
                id: event.id, kind: message.kind, actorPersonId: person.id, actorName: person.name, actorAgent: message.agent,
                activeTeamId: teamId, activeTeamName: teamId ? dir.team(teamId).name : null, sessionId: null,
                turns: message.turns, context: message.context, occurredAt: message.occurredAt,
            };
            const result = await approach.ingest(msg, {
                writableScopes: writableScopes(dir, person.id, teamId, at).map((s) => this.ns(version, s)),
                defaultScope: this.ns(version, defaultScope(dir, person.id, teamId, at)),
                teamRole: teamId ? dir.roleIn(person.id, teamId, at) : null,
                now: at,
                directory: dir.directory(),
            });
            const steps = result.notes.map((note) => classifyNote(this.plain(version, note)));
            return this.events.update(event, { status: 'done', steps, ms: Date.now() - started });
        } catch (error: any) {
            return this.events.update(event, { status: 'error', error: error?.message ?? String(error), ms: Date.now() - started });
        }
    }

    async recall(req: RecallRequest): Promise<MemoryEvent> {
        const { person, teamId } = this.identity(req.person, req.team);
        const latest = this.latestWrite.get(req.version);
        const realNow = new Date().toISOString();
        const now = req.now ? new Date(req.now).toISOString() : latest && latest > realNow ? latest : realNow;
        const query = { text: req.query, asOf: req.asOf ? new Date(req.asOf).toISOString() : null, includeProposed: req.includeProposed ?? false, topK: req.topK ?? 8, now };
        const id = randomUUID();
        const event = this.events.record({
            id, group: req.group ?? id, at: realNow, version: req.version, source: req.source, client: req.client ?? null,
            kind: 'recall', person: person.id, team: teamId, status: 'running', query,
        });
        const started = Date.now();
        try {
            const approach = await this.approach(req.version);
            const dir = this.directory(this.world());
            const scopes = readableScopes(dir, person.id, teamId, new Date(now));
            const result = await approach.recall({
                asPersonId: person.id, activeTeamId: teamId, query: query.text, now, asOf: query.asOf,
                includeProposed: query.includeProposed, topK: query.topK,
                readableScopes: scopes.map((s) => this.ns(req.version, s)), directory: dir.directory(),
            });
            const memories = result.memories.map((m) => this.plainMemory(req.version, m));
            const ms = Date.now() - started; // recall alone, without the answer
            const reply = req.answer ? await answer(query.text, memories, now, query.asOf, person, dir.directory(), 'helpful') : undefined;
            return this.events.update(event, { status: 'done', memories, ms, answer: reply });
        } catch (error: any) {
            return this.events.update(event, { status: 'error', error: error?.message ?? String(error), ms: Date.now() - started });
        }
    }

    // Everything the person can currently see in this version (not recorded as an event).
    async list(version: string, person?: string, team?: string | null, asOf?: string | null): Promise<RecalledMemory[]> {
        const { person: who, teamId } = this.identity(person, team);
        const approach = await this.approach(version);
        const dir = this.directory(this.world());
        const scopes = readableScopes(dir, who.id, teamId, new Date()).map((s) => this.ns(version, s));
        const memories = await approach.snapshot(scopes, asOf ? new Date(asOf) : undefined);
        return memories.map((m) => this.plainMemory(version, m));
    }

    // The version's entities and the facts between them, as the person sees them (null: no graph to show).
    // "Now" is the current time or the latest write, whichever is later, as for recall.
    async graph(version: string, person?: string, team?: string | null, asOf?: string | null, history = false): Promise<MemoryGraph | null> {
        const { person: who, teamId } = this.identity(person, team);
        const approach = await this.approach(version);
        if (!approach.inspectGraph) return null;
        const latest = this.latestWrite.get(version);
        const realNow = new Date().toISOString();
        const at = new Date(asOf ?? (latest && latest > realNow ? latest : realNow));
        const world = this.world();
        const scopes = readableScopes(this.directory(world), who.id, teamId, at).map((s) => this.ns(version, s));
        const g = await approach.inspectGraph(scopes, at, history);
        const plain = (text: string) => this.plain(version, text);
        const names = new Map(world.people.map((p) => [p.id, p.name]));
        // Entities are stored once per memory space (team, personal), so the same person or thing can appear
        // in both. The view shows one node per key ("person:p-ankit"); each fact keeps its own scope.
        const viewId = (id: string) => plain(id).replace(/^(personal|team):[^|]+\|/, '');
        const nodes = new Map<string, MemoryGraph['nodes'][number]>();
        for (const n of g.nodes) {
            const id = viewId(n.id);
            const seen = nodes.get(id);
            nodes.set(id, seen ? { ...seen, aliases: [...new Set([...seen.aliases, ...n.aliases])] } : { ...n, id, name: plain(n.name) });
        }
        return {
            nodes: [...nodes.values()],
            edges: g.edges.map((e) => ({
                ...e, id: plain(e.id), source: viewId(e.source), target: viewId(e.target), text: plain(e.text),
                scope: plain(e.scope) as Scope, author: e.author ? names.get(e.author) ?? e.author : null,
            })),
        };
    }

    // What waits in working memory for this person: the active team's buffer and their own (null: the
    // version has no working memory).
    async workingMemory(version: string, person?: string, team?: string | null) {
        const { person: who, teamId } = this.identity(person, team);
        const approach = await this.approach(version);
        if (!approach.workingMemory) return null;
        const scopes = readableScopes(this.directory(this.world()), who.id, teamId, new Date()).map((s) => this.ns(version, s));
        return (await approach.workingMemory(scopes)).map((w) => ({ ...w, id: this.plain(version, w.id), scope: this.plain(version, w.scope) as Scope }));
    }

    // Consolidate (or dream over) the active team's scope and the person's own, now; recorded as an event.
    async maintain(version: string, kind: 'consolidate' | 'dream', person?: string, team?: string | null, source: MemoryEvent['source'] = 'ui'): Promise<MemoryEvent> {
        const { person: who, teamId } = this.identity(person, team);
        const id = randomUUID();
        const event = this.events.record({ id, group: id, at: new Date().toISOString(), version, source, client: 'ui', kind, person: who.id, team: teamId, status: 'running' });
        const started = Date.now();
        try {
            const approach = await this.approach(version);
            const run = kind === 'consolidate' ? approach.consolidate?.bind(approach) : approach.dream?.bind(approach);
            if (!run) throw new Error(`${version} has no ${kind === 'consolidate' ? 'working memory' : 'dream pass'} (try a +consolidate version)`);
            const world = this.world();
            const dir = this.directory(world);
            const latest = this.latestWrite.get(version);
            const now = new Date(latest && latest > new Date().toISOString() ? latest : Date.now());
            const notes: string[] = [];
            for (const scope of writableScopes(dir, who.id, teamId, now)) {
                notes.push(...(await run(this.ns(version, scope), dir.directory(), now)));
            }
            const steps = (notes.length ? notes : ['nothing waiting']).map((n) => classifyNote(this.plain(version, n)));
            return this.events.update(event, { status: 'done', steps, ms: Date.now() - started });
        } catch (error: any) {
            return this.events.update(event, { status: 'error', error: error?.message ?? String(error), ms: Date.now() - started });
        }
    }

    private plainMemory(version: string, m: RecalledMemory): RecalledMemory {
        return { ...m, scope: this.plain(version, m.scope) as Scope, text: this.plain(version, m.text) };
    }

    async close() {
        await Promise.allSettled([...this.queues.values()]);
        for (const loading of this.approaches.values()) {
            try {
                await (await loading).close();
            } catch {
                // already failed to load
            }
        }
    }
}
