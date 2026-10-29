import type { MemoryEvent } from './events';
import type { World } from './service';

// The admin's view of interactions with the memory, for the whole team or one person. Text is shown when it
// belongs to memory the viewer can read anyway (their teams', or their own); for someone else's personal
// memory, only that it happened and how it went.

const FACT = /^(?:#\d+ ([^:]+): )?((?:personal|team):\S+) (new|proposed) fact(?: \((invalidated|disputed with) (\d+)\))?: (.*)$/s;
const DUP = /^(?:#\d+ ([^:]+): )?((?:personal|team):\S+) duplicate of existing: (.*)$/s;
const WAIT = /^working memory \(((?:personal|team):[^)]+)\)/;

// seeAll: show everything to the admin, personal memory included (testing with a small team; MEMORY_ADMIN_SEE_ALL).
export interface InteractionOptions { viewer: string; days: number; person?: string | null; kind?: 'remember' | 'recall' | null; limit?: number; now?: number; seeAll?: boolean }

export function interactions(all: MemoryEvent[], world: World, opts: InteractionOptions) {
    const now = opts.now ?? Date.now();
    const since = new Date(now - opts.days * 86_400_000).toISOString();
    const names = new Map(world.people.map((p) => [p.id, p.name]));
    const ownScopes = new Set([`personal:${opts.viewer}`, ...world.memberships.filter((m) => m.personId === opts.viewer).map((m) => `team:${m.teamId}`)]);
    const readable = { has: (scope: string) => !!opts.seeAll || ownScopes.has(scope) };
    const side = (scope: string) => (scope.startsWith('team:') ? 'team' as const : 'personal' as const);
    const nameOf = (id: string) => names.get(id) ?? id;

    const events = all.filter((e) => e.source === 'mcp' && e.at >= since && (e.kind === 'remember' || e.kind === 'recall') && (!opts.person || e.person === opts.person));
    const rows = events.map((e) => {
        const steps = e.steps ?? [];
        const facts = steps.flatMap((s) => {
            const f = FACT.exec(s.text);
            if (f) return [{ author: f[1] ?? nameOf(e.person), scope: side(f[2]), kind: f[3], effect: f[4] ? `${f[4]} ${f[5]}` : null, text: readable.has(f[2]) ? f[6] : null }];
            const d = DUP.exec(s.text);
            if (d) return [{ author: d[1] ?? nameOf(e.person), scope: side(d[2]), kind: 'duplicate', effect: null, text: readable.has(d[2]) ? d[3] : null }];
            return [];
        });
        const waitingIn = steps.map((s) => WAIT.exec(s.text)?.[1]).find(Boolean) ?? null;
        const gate = steps.find((s) => s.kind === 'gate')?.text ?? null;
        const skipped = gate?.startsWith('gate: skip') ? /skip \(([^;)]+)/.exec(gate)?.[1] ?? 'not kept' : null;
        const base = {
            id: e.id, at: e.at, person: { id: e.person, name: nameOf(e.person) }, kind: e.kind as 'remember' | 'recall',
            app: e.client ?? 'unknown', status: e.status, ms: e.ms ?? null, error: e.status === 'error' ? e.error ?? 'error' : null,
        };
        if (e.kind === 'remember') {
            const filedTo = waitingIn ? side(waitingIn) : facts[0]?.scope ?? null;
            const visible = !!opts.seeAll || e.person === opts.viewer || (waitingIn ? readable.has(waitingIn) : filedTo === 'team' && facts.every((f) => f.scope === 'team' && f.text !== null));
            const said = (e.message?.turns ?? []).filter((t) => t.role === 'user').map((t) => t.content).join('\n');
            return { ...base, filedTo, skipped, waiting: !!waitingIn && !skipped, visible, message: visible ? said : null, query: null, facts, results: null };
        }
        const mems = e.memories ?? [];
        const shown = mems.filter((m) => readable.has(m.scope)).map((m) => ({ text: m.text, status: m.status, scope: side(m.scope), author: m.author ?? null }));
        // Someone else's question is shown only when everything it found was team memory the viewer can read.
        const visible = !!opts.seeAll || e.person === opts.viewer || (mems.length > 0 && mems.every((m) => m.scope.startsWith('team:') && readable.has(m.scope)));
        return {
            ...base, filedTo: null, skipped: null, waiting: false, visible, message: null, facts,
            query: visible ? e.query?.text ?? null : null,
            results: {
                team: mems.filter((m) => m.scope.startsWith('team:')).length, personal: mems.filter((m) => m.scope.startsWith('personal:')).length,
                items: opts.seeAll || e.person === opts.viewer ? shown : shown.filter((m) => m.scope === 'team'),
            },
        };
    });

    const days = Math.round(opts.days);
    const daily = new Map<string, { day: string; saves: number; recalls: number }>();
    for (let d = days - 1; d >= 0; d--) {
        const day = new Date(now - d * 86_400_000).toISOString().slice(0, 10);
        daily.set(day, { day, saves: 0, recalls: 0 });
    }
    const hoursUtc = Array.from({ length: 24 }, () => 0);
    const apps: Record<string, number> = {};
    for (const r of rows) {
        const bucket = daily.get(r.at.slice(0, 10));
        if (bucket) {
            if (r.kind === 'remember') bucket.saves++;
            else bucket.recalls++;
        }
        hoursUtc[new Date(r.at).getUTCHours()]++;
        apps[r.app] = (apps[r.app] ?? 0) + 1;
    }
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    const saves = rows.filter((r) => r.kind === 'remember');
    const recalls = rows.filter((r) => r.kind === 'recall');
    const added = rows.flatMap((r) => r.facts.filter((f) => f.kind !== 'duplicate'));
    return {
        viewer: { id: opts.viewer, name: nameOf(opts.viewer) }, days, person: opts.person ?? null, kind: opts.kind ?? null, seeAll: !!opts.seeAll,
        summary: {
            saves: saves.length, recalls: recalls.length, errors: rows.filter((r) => r.status === 'error').length,
            skipped: saves.filter((r) => r.skipped).length, toTeam: saves.filter((r) => r.filedTo === 'team').length, toPersonal: saves.filter((r) => r.filedTo === 'personal').length,
            factsTeam: added.filter((f) => f.scope === 'team').length, factsPersonal: added.filter((f) => f.scope === 'personal').length,
            recallsAnswered: recalls.filter((r) => r.results!.team + r.results!.personal > 0).length,
            avgSaveMs: avg(saves.map((r) => r.ms ?? 0).filter(Boolean)), avgRecallMs: avg(recalls.map((r) => r.ms ?? 0).filter(Boolean)),
            apps, daily: [...daily.values()], hoursUtc,
        },
        events: (opts.kind ? rows.filter((r) => r.kind === opts.kind) : rows).slice(0, opts.limit ?? 200),
    };
}
