// Memory MCP server + UI, for trying memory versions from Claude, Gemini or by hand:
//   npm run memory:mcp                                   HTTP: UI on http://127.0.0.1:7800, MCP at /mcp/<version>
//   npm run memory:mcp -- --stdio --version=<name> [--person=p-ankit] [--team=t-core]   for clients that spawn servers
// Uses its own stores (Postgres *_mcp databases, the memory-neo4j-mcp container), so eval runs never touch it.
// Deployed for the team (pm2 app "memory-mcp"), it is configured by environment:
//   MEMORY_MCP_HOST=0.0.0.0            listen beyond localhost
//   MEMORY_MCP_PUBLIC_URL=https://...  the address teammates use, for the printed setup commands
//   MEMORY_MCP_VERSIONS=<name>,...     only these versions are served
//   MEMORY_MCP_TOKENS=p-ankit:<token>,p-priya:<token>   each person's bearer token; the token decides who
//                                      is speaking, so nobody can read someone else's personal memory
//   MEMORY_MCP_UI=false                no Lab UI or /api (they show everyone's memories, unauthenticated)
//   MEMORY_MCP_ALIASES=engram:<version>   short names for versions in the URL (/mcp/engram); data stays under the version
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   OAuth sign-in with Google (oauth.ts), for apps that connect by URL
//                                      only; the issuer is MEMORY_MCP_PUBLIC_URL
// Admins (role "admin" in world.json) add teammates and get their token from POST /admin/people.

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string | undefined]).map(([k, v]) => [k, v ?? 'true']));
const STDIO = args.stdio === 'true';
if (STDIO) {
    // stdout is the MCP channel: anything else printed there would corrupt it.
    console.log = console.error;
    console.info = console.error;
    console.warn = console.error;
}

// Clients like Claude Desktop start stdio servers from anywhere; .env and .memory-data live at the repo root.
process.chdir(require('path').resolve(__dirname, '..', '..', '..'));
require('dotenv').config({ quiet: true });
process.env.MEMORY_PG_DB_SUFFIX ??= '_mcp';
// In a team, what people say about their own work and availability is for the team (core/scope-policy).
process.env.MEMORY_SCOPE_POLICY ??= 'team-context';
// Reads never file working memory here. A buffer is filed when it is full (MEMORY_WM_BATCH_SIZE messages), not
// after a wait, so every filing has a whole batch of context; MEMORY_WM_FILE_BY_AGE=true adds filing by age, on
// a timer (startFilingTimer).
process.env.MEMORY_WM_CONSOLIDATE_ON_READ ??= 'false';
process.env.MEMORY_WM_FILE_BY_AGE ??= 'false';
// Nightly dreaming here: other names for things and a short profile of each (dreaming.ts). Merging and retiring
// stay off unless MEMORY_DREAM_STEPS adds them; MEMORY_DREAM_AT_UTC=off turns the night run off.
process.env.MEMORY_DREAM_STEPS ??= 'aliases,profiles';
process.env.MEMORY_NEO4J_URL = process.env.MEMORY_MCP_NEO4J_URL || 'bolt://127.0.0.1:7694';

import { createConnection } from 'net';
import path from 'path';

const MCP_DATABASES = ['mem_claims'];

// The *_mcp databases aren't created by the Postgres init script; create them (with pgvector) on first start.
async function ensureDatabases() {
    const { Client } = await import('pg');
    const { pgDatabase } = await import('../core/env');
    const base = (process.env.MEMORY_PG_URL || 'postgres://memory:memory@127.0.0.1:5433').replace(/\/+$/, '');
    const admin = new Client({ connectionString: `${base}/memory` });
    await admin.connect();
    try {
        for (const name of MCP_DATABASES.map(pgDatabase)) {
            const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
            if (!rowCount) await admin.query(`CREATE DATABASE "${name}"`);
            const db = new Client({ connectionString: `${base}/${name}` });
            await db.connect();
            await db.query('CREATE EXTENSION IF NOT EXISTS vector');
            await db.end();
        }
    } finally {
        await admin.end();
    }
}

function reachable(url: string): Promise<boolean> {
    const { hostname, port } = new URL(url.replace(/^bolt/, 'http'));
    return new Promise((resolve) => {
        const socket = createConnection({ host: hostname, port: Number(port) }, () => {
            socket.end();
            resolve(true);
        });
        socket.on('error', () => resolve(false));
        socket.setTimeout(1500, () => {
            socket.destroy();
            resolve(false);
        });
    });
}

const list = (value: string | undefined) => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// "p-ankit:secret,p-priya:secret2" → token → person id.
function parseTokens(value: string | undefined): Map<string, string> {
    const tokens = new Map<string, string>();
    for (const entry of list(value)) {
        const at = entry.indexOf(':');
        if (at <= 0 || at === entry.length - 1) throw new Error('MEMORY_MCP_TOKENS entries must look like <person-id>:<token>');
        tokens.set(entry.slice(at + 1), entry.slice(0, at));
    }
    return tokens;
}

// "engram:temporal-kg+..." → alias → version.
function parseAliases(value: string | undefined): Map<string, string> {
    const aliases = new Map<string, string>();
    for (const entry of list(value)) {
        const at = entry.indexOf(':');
        if (at <= 0 || at === entry.length - 1) throw new Error('MEMORY_MCP_ALIASES entries must look like <alias>:<version>');
        aliases.set(entry.slice(0, at), entry.slice(at + 1));
    }
    return aliases;
}

async function main() {
    const { APPROACH_NAMES: ALL_VERSIONS } = await import('../approaches/registry');
    const { MemoryService, FEATURED_VERSIONS: ALL_FEATURED, MCP_DIR } = await import('./service');
    const { buildMcpServer } = await import('./tools');
    const { AccessStore, isAdmin, upsertPerson } = await import('./access');
    const { TeamOAuth, mountOAuth } = await import('./oauth');
    const { interactions } = await import('./insights');
    const { writeFileSync } = await import('fs');

    const served = list(process.env.MEMORY_MCP_VERSIONS);
    for (const version of served) if (!ALL_VERSIONS.includes(version)) throw new Error(`MEMORY_MCP_VERSIONS: unknown version "${version}"`);
    const APPROACH_NAMES = served.length ? served : ALL_VERSIONS;
    const FEATURED_VERSIONS = served.length ? served : ALL_FEATURED;
    const access = new AccessStore(path.join(MCP_DIR, 'tokens.json'), parseTokens(process.env.MEMORY_MCP_TOKENS));
    const aliases = parseAliases(process.env.MEMORY_MCP_ALIASES);
    for (const [alias, version] of aliases) if (!APPROACH_NAMES.includes(version)) throw new Error(`MEMORY_MCP_ALIASES: "${alias}" points to unknown version "${version}"`);
    const ui = process.env.MEMORY_MCP_UI !== 'false';

    if (APPROACH_NAMES.some((v) => v.startsWith('claims-pg'))) {
        try {
            await ensureDatabases();
        } catch (error: any) {
            console.error(`Postgres is not reachable (${error?.message}); claims-pg won't work. Start it: docker compose -f docker-compose.memory.yml up -d`);
        }
    }
    if (!(await reachable(process.env.MEMORY_NEO4J_URL!))) {
        console.error(`Neo4j for the MCP server is not reachable at ${process.env.MEMORY_NEO4J_URL}; temporal-kg won't work. Start it: docker compose -f docker-compose.memory.yml --profile mcp up -d memory-neo4j-mcp`);
    }

    const service = new MemoryService();
    if (process.env.MEMORY_WM_CONSOLIDATE_ON_READ === 'false' && process.env.MEMORY_WM_FILE_BY_AGE !== 'false') {
        service.startFilingTimer(APPROACH_NAMES.filter((v) => v.includes('+consolidate')));
    }
    // 21:30 UTC is 03:00 in India, when the team is asleep.
    const dreamAt = process.env.MEMORY_DREAM_AT_UTC || '21:30';
    // Only on a deployment that names its versions (MEMORY_MCP_VERSIONS), so the local Lab never dreams on its own.
    if (!STDIO && served.length && /^\d{2}:\d{2}$/.test(dreamAt)) service.startDreamTimer(served.filter((v) => v.startsWith('temporal-kg')), dreamAt);
    const shutdown = async () => {
        await service.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    if (STDIO) {
        const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
        const version = args.version ?? FEATURED_VERSIONS[0];
        if (!APPROACH_NAMES.includes(version)) throw new Error(`Unknown version "${version}". Known: ${APPROACH_NAMES.join(', ')}`);
        const server = buildMcpServer(service, { version, person: args.person, team: args.team, source: 'stdio' });
        await server.connect(new StdioServerTransport());
        console.error(`memory MCP (stdio) ready: ${version}`);
        return;
    }

    const express = (await import('express')).default;
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const app = express();
    // Behind nginx on the same machine.
    app.set('trust proxy', 'loopback');
    app.use(express.json({ limit: '2mb' }));
    const port = Number(args.port ?? process.env.MEMORY_MCP_PORT ?? 7800);
    const host = process.env.MEMORY_MCP_HOST || '127.0.0.1';
    const base = (process.env.MEMORY_MCP_PUBLIC_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
    const oauth = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
        ? new TeamOAuth({
            issuer: base, file: path.join(MCP_DIR, 'oauth.json'), world: () => service.world(),
            google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET },
        })
        : null;
    if (oauth) mountOAuth(app, oauth);
    const knownVersion = (version: string) => APPROACH_NAMES.includes(version);
    const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
    const bearer = (req: { headers: { authorization?: string } }) => /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim();
    // The name a version goes by in URLs: its alias if it has one.
    const urlName = (version: string) => [...aliases].find(([, v]) => v === version)?.[0] ?? version;

    app.get('/health', (_req, res) => res.json({ ok: true }));

    // ---- Admin: add a teammate (or find them by name) and issue them a fresh token ----
    app.post('/admin/people', (req, res) => {
        const caller = access.enabled ? access.personFor(bearer(req)) : undefined;
        const world = service.world();
        if (!caller || !isAdmin(world, caller)) {
            res.status(caller ? 403 : 401).json({ error: caller ? 'Only admins can add people' : 'Missing or unknown bearer token' });
            return;
        }
        const name = str(req.body?.name)?.trim();
        const email = str(req.body?.email)?.trim();
        if (!name || name.length > 80 || !email) {
            res.status(400).json({ error: 'Send {"name": "Full Name", "email": "name@company.com", "aliases": ["Nickname"], "team": "optional team id"}' });
            return;
        }
        const aliasList = Array.isArray(req.body.aliases) ? req.body.aliases.filter((a: unknown) => typeof a === 'string') : [];
        try {
            const { person, team } = upsertPerson(world, { name, email, aliases: aliasList, team: str(req.body.team) });
            writeFileSync(path.join(MCP_DIR, 'world.json'), JSON.stringify(world, null, 2));
            const token = access.issue(person.id);
            const versionName = urlName(FEATURED_VERSIONS[0]);
            res.json({
                id: person.id, name: person.name, email: person.email, aliases: person.aliases, team: team.id, token,
                // For apps that take only a URL (claude.ai, ChatGPT): add it as a connector with no authentication.
                link: `${base}/u/${token}/mcp/${versionName}`,
                connect: `claude mcp add --transport http memory "${base}/mcp/${versionName}" --header "Authorization: Bearer ${token}"`,
            });
        } catch (error: any) {
            res.status(400).json({ error: error?.message ?? String(error) });
        }
    });

    // ---- Admin: sign a person out everywhere; issue a fixed OAuth client for apps that don't register themselves ----
    const adminCaller = (req: any, res: any): boolean => {
        const caller = access.enabled ? access.personFor(bearer(req)) : undefined;
        if (!caller || !isAdmin(service.world(), caller)) {
            res.status(caller ? 403 : 401).json({ error: caller ? 'Only admins can do this' : 'Missing or unknown bearer token' });
            return false;
        }
        return true;
    };
    app.post('/admin/people/:id/revoke', (req, res) => {
        if (!adminCaller(req, res)) return;
        const id = req.params.id;
        if (!service.world().people.some((p) => p.id === id)) {
            res.status(404).json({ error: `Unknown person "${id}"` });
            return;
        }
        access.revoke(id);
        oauth?.revokePerson(id);
        res.json({ id, revoked: true, note: 'Their token, link and app sign-ins stop working. Add them again to issue a new token.' });
    });
    app.post('/admin/oauth-clients', (req, res) => {
        if (!adminCaller(req, res)) return;
        const name = str(req.body?.name)?.trim();
        const redirects = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.filter((u: unknown) => typeof u === 'string' && /^https:\/\//.test(u)) : [];
        if (!oauth || !name || !redirects.length) {
            res.status(400).json({ error: oauth ? 'Send {"name": "Gemini Enterprise", "redirect_uris": ["https://..."]}' : 'OAuth is not configured (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)' });
            return;
        }
        res.json({ ...oauth.registerFixedClient(name, redirects), ...oauth.serverMetadata() });
    });

    // ---- Admin views (read-only): who uses memory and how, and the memory graph as the admin sees it ----
    // Activity carries counts, apps and times only, never what anyone said; the graph is the admin's own
    // view (their personal memory plus their team's), so other people's personal memory stays private.
    app.get('/admin/activity', (req, res) => {
        if (!adminCaller(req, res)) return;
        const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
        const since = new Date(Date.now() - days * 86_400_000).toISOString();
        const world = service.world();
        const names = new Map(world.people.map((p) => [p.id, p.name]));
        const events = service.events.list(100_000).filter((e) => e.source === 'mcp' && e.at >= since);
        const people = new Map(world.people.map((p) => [p.id, {
            id: p.id, name: p.name, email: p.email ?? null, saves: 0, recalls: 0, other: 0, errors: 0,
            factsSaved: 0, apps: {} as Record<string, number>, firstAt: null as string | null, lastAt: null as string | null,
        }]));
        const daily = new Map<string, { day: string; saves: number; recalls: number }>();
        for (let d = days - 1; d >= 0; d--) {
            const day = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
            daily.set(day, { day, saves: 0, recalls: 0 });
        }
        const factsOf = (e: (typeof events)[number]) => (e.steps ?? []).filter((s) => s.kind === 'new' || s.kind === 'buffered' || s.kind === 'invalidated').length;
        for (const e of events) {
            const p = people.get(e.person);
            const bucket = daily.get(e.at.slice(0, 10));
            if (e.kind === 'remember') bucket && bucket.saves++;
            if (e.kind === 'recall') bucket && bucket.recalls++;
            if (!p) continue;
            if (e.kind === 'remember') p.saves++, p.factsSaved += factsOf(e);
            else if (e.kind === 'recall') p.recalls++;
            else p.other++;
            if (e.status === 'error') p.errors++;
            const app = e.client ?? 'unknown';
            p.apps[app] = (p.apps[app] ?? 0) + 1;
            if (!p.firstAt || e.at < p.firstAt) p.firstAt = e.at;
            if (!p.lastAt || e.at > p.lastAt) p.lastAt = e.at;
        }
        res.json({
            days, since,
            people: [...people.values()].sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? '') || a.name.localeCompare(b.name)),
            daily: [...daily.values()],
            recent: events.slice(0, 60).map((e) => ({
                at: e.at, person: names.get(e.person) ?? e.person, kind: e.kind, app: e.client ?? 'unknown', status: e.status, ms: e.ms ?? null,
                facts: e.kind === 'remember' ? factsOf(e) : null, results: e.kind === 'recall' ? (e.memories?.length ?? 0) : null,
            })),
        });
    });
    // MEMORY_ADMIN_SEE_ALL=true: admins see everyone's interactions and memory, personal included (testing with a
    // small team that knows about it). Off by default.
    const seeAll = process.env.MEMORY_ADMIN_SEE_ALL === 'true';
    // Every interaction, for the whole team or one person (insights.ts decides what text the admin may see).
    app.get('/admin/interactions', (req, res) => {
        if (!adminCaller(req, res)) return;
        const kind = req.query.kind === 'remember' || req.query.kind === 'recall' ? req.query.kind : null;
        res.json(interactions(service.events.list(100_000), service.world(), {
            viewer: access.personFor(bearer(req))!,
            days: Math.min(Math.max(Number(req.query.days) || 14, 1), 90),
            person: str(req.query.person) && req.query.person !== 'all' ? String(req.query.person) : null,
            kind,
            limit: Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000),
            seeAll,
        }));
    });


    // Files one memory space's waiting messages now instead of when its buffer is full: {"scope": "personal:p-ankit"}.
    app.post('/admin/file', async (req, res) => {
        if (!adminCaller(req, res)) return;
        const scope = str(req.body?.scope) ?? '';
        const world = service.world();
        const known = scope.startsWith('personal:') ? world.people.some((p) => `personal:${p.id}` === scope) : world.teams.some((t) => `team:${t.id}` === scope);
        if (!known) {
            res.status(400).json({ error: 'Send {"scope": "personal:<person id>"} or {"scope": "team:<team id>"}' });
            return;
        }
        try {
            const runs = [];
            for (const version of APPROACH_NAMES.filter((v) => v.includes('+consolidate'))) {
                const { notes, ms } = await service.fileScope(version, scope as any);
                runs.push({ version: urlName(version), ms, facts: notes.filter((n) => / (new|proposed) fact/.test(n)).length, unconfirmed: notes.filter((n) => / proposed fact/.test(n)).length, notes: notes.length });
            }
            res.json({ scope, runs });
        } catch (error: any) {
            res.status(500).json({ error: error?.message ?? String(error) });
        }
    });

    // Runs the nightly dream now, over every memory space of the served versions (MEMORY_DREAM_STEPS).
    app.post('/admin/dream', async (req, res) => {
        if (!adminCaller(req, res)) return;
        try {
            const runs = [];
            for (const version of APPROACH_NAMES.filter((v) => v.startsWith('temporal-kg'))) {
                const { scopes, notes, ms } = await service.dreamAll(version);
                runs.push({ version: urlName(version), scopes, ms, aliases: notes.filter((n) => n.includes('also called')).length, profiles: notes.filter((n) => n.includes(': profile: ')).length, failures: notes.filter((n) => n.includes('dreaming failed')).length });
            }
            res.json({ runs });
        } catch (error: any) {
            res.status(500).json({ error: error?.message ?? String(error) });
        }
    });

    app.get('/admin/graph', async (req, res) => {
        if (!adminCaller(req, res)) return;
        try {
            const caller = access.personFor(bearer(req))!;
            const version = FEATURED_VERSIONS[0];
            const graph = await service.graph(version, caller, undefined, null, req.query.history === '1', seeAll);
            const waiting = await service.workingMemory(version, caller, undefined, seeAll);
            res.json({ version: urlName(version), viewer: service.world().people.find((p) => p.id === caller)?.name ?? caller, seeAll, ...(graph ?? { nodes: [], edges: [] }), waiting: waiting ?? [] });
        } catch (error: any) {
            res.status(500).json({ error: error?.message ?? String(error) });
        }
    });

    // ---- MCP (Streamable HTTP, stateless: one server per request) ----
    // Two ways in: /mcp/<version> with the token in the Authorization header, or a private link
    // /u/<token>/mcp/<version> for apps that take only a URL. A link works like a password: anyone who
    // has it acts as that person, and reissuing the person's token (admin endpoint) revokes it.
    const handleMcp = async (req: any, res: any, pathToken?: string) => {
        const version = aliases.get(req.params.version) ?? req.params.version;
        if (!knownVersion(version)) {
            res.status(404).json({ error: `Unknown version "${req.params.version}"`, versions: [...aliases.keys(), ...APPROACH_NAMES] });
            return;
        }
        let person = str(req.query.person);
        if (pathToken !== undefined) {
            // An unknown link gets 404, not 401: a 401 would send apps looking for an OAuth sign-in that doesn't exist.
            const owner = access.enabled ? access.personFor(pathToken) : undefined;
            if (!owner) {
                res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unknown or revoked link' }, id: null });
                return;
            }
            person = owner;
        } else if (access.enabled || oauth) {
            // A bearer is either a token issued by an admin or an OAuth access token from signing in.
            const token = bearer(req);
            const owner = (access.enabled ? access.personFor(token) : undefined)
                ?? (oauth ? await oauth.personFor(token, `${base}/mcp/${req.params.version}`) : undefined);
            if (!owner) {
                // The pointer tells apps that sign in (claude.ai, ChatGPT) where to start.
                if (oauth) res.set('WWW-Authenticate', `Bearer resource_metadata="${oauth.resourceMetadataUrl(`/mcp/${req.params.version}`)}", scope="memory"`);
                res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Missing or unknown bearer token' }, id: null });
                return;
            }
            person = owner;
        }
        const server = buildMcpServer(service, { version, person, team: str(req.query.team), source: 'mcp' });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
            transport.close();
            server.close();
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (error: any) {
            if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: error?.message ?? 'Internal error' }, id: null });
        }
    };
    app.post('/mcp/:version', (req, res) => handleMcp(req, res));
    app.post('/u/:token/mcp/:version', (req, res) => handleMcp(req, res, req.params.token));
    // Stateless: no server-initiated streams or sessions to end.
    for (const route of ['/mcp/:version', '/u/:token/mcp/:version']) {
        app.get(route, (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Method not allowed' }));
        app.delete(route, (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Method not allowed' }));
    }

    // ---- UI and its API ----
    if (!ui) app.use((req, res, next) => (req.path === '/' || req.path.startsWith('/api/') ? res.status(404).end() : next()));
    app.get('/',(_req, res) => res.sendFile(path.join(__dirname, 'ui', 'index.html')));

    app.get('/api/config', (_req, res) => {
        res.json({
            versions: APPROACH_NAMES, featured: FEATURED_VERSIONS, world: service.world(), mcpBase: `${base}/mcp`,
            // For the Claude Desktop (stdio) snippet: absolute paths, since Desktop starts servers from anywhere.
            stdio: { node: process.execPath, tsx: path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'), server: path.resolve(__dirname, 'server.ts') },
        });
    });

    app.get('/api/events', (req, res) => res.json(service.events.list(Number(req.query.limit ?? 500))));
    app.delete('/api/events', (_req, res) => {
        service.events.clear();
        res.json({ ok: true });
    });

    app.get('/api/memories', async (req, res) => {
        try {
            res.json(await service.list(String(req.query.version), str(req.query.person), str(req.query.team) ?? null, str(req.query.asOf) ?? null));
        } catch (error: any) {
            res.status(400).json({ error: error?.message ?? String(error) });
        }
    });

    app.get('/api/graph', async (req, res) => {
        try {
            const graph = await service.graph(String(req.query.version), str(req.query.person), str(req.query.team) ?? null, str(req.query.asOf) ?? null, req.query.history === '1');
            res.json(graph ? { supported: true, ...graph } : { supported: false, nodes: [], edges: [] });
        } catch (error: any) {
            res.status(400).json({ error: error?.message ?? String(error) });
        }
    });

    app.get('/api/working-memory', async (req, res) => {
        try {
            const items = await service.workingMemory(String(req.query.version), str(req.query.person), str(req.query.team) ?? null);
            const { WORKING_MEMORY } = await import('../approaches/temporal-kg');
            res.json(items ? { supported: true, items, settings: WORKING_MEMORY } : { supported: false, items: [] });
        } catch (error: any) {
            res.status(400).json({ error: error?.message ?? String(error) });
        }
    });

    for (const kind of ['consolidate', 'dream'] as const) {
        app.post(`/api/${kind}`, async (req, res) => {
            try {
                res.json(await service.maintain(String(req.body.version), kind, req.body.person, req.body.team ?? null));
            } catch (error: any) {
                res.status(400).json({ error: error?.message ?? String(error) });
            }
        });
    }

    // Manual requests from the UI, as if an agent had sent them. One request goes to every selected version.
    app.post('/api/remember', async (req, res) => {
        try {
            const { versions, wait, client, ...request } = req.body;
            const group = `ui-${Date.now()}`;
            const runs = (versions as string[]).filter(knownVersion).map((version) => service.remember({ ...request, version, source: 'ui', client: client ?? 'ui', group }));
            if (wait) await Promise.all(runs.map((r) => r.done));
            res.json(runs.map((r) => r.event));
        } catch (error: any) {
            res.status(400).json({ error: error?.message ?? String(error) });
        }
    });

    app.post('/api/recall', async (req, res) => {
        try {
            const { versions, client, wait, ...request } = req.body;
            const group = `ui-${Date.now()}`;
            const runs = (versions as string[]).filter(knownVersion).map((version) => service.recall({ ...request, version, source: 'ui', client: client ?? 'ui', group }));
            // The chat doesn't wait: it follows the events, which show up as soon as each recall starts.
            if (wait === false) {
                Promise.allSettled(runs);
                res.json({ group });
                return;
            }
            res.json(await Promise.all(runs));
        } catch (error: any) {
            res.status(400).json({ error: error?.message ?? String(error) });
        }
    });

    // A scripted use case: items run in order; consecutive remembers marked "concurrent" are sent at the
    // same moment (each version still applies its writes one at a time, as a queue consumer would).
    app.post('/api/batch', async (req, res) => {
        try {
            const { versions, items } = req.body as { versions: string[]; items: any[] };
            const selected = versions.filter(knownVersion);
            const group = `batch-${Date.now()}`;
            const results: { item: number; events: unknown[] }[] = [];
            for (let i = 0; i < items.length; i++) {
                const run = [items[i]];
                while (items[i].type !== 'recall' && items[i + 1]?.concurrent) run.push(items[++i]);
                const events = await Promise.all(run.flatMap((item) => selected.map(async (version) => {
                    const { type, concurrent, ...request } = item;
                    if (type === 'recall') return service.recall({ ...request, version, source: 'ui', client: 'batch', group });
                    return service.remember({ ...request, version, source: 'ui', client: 'batch', group }).done;
                })));
                results.push({ item: i, events });
            }
            res.json(results);
        } catch (error: any) {
            res.status(400).json({ error: error?.message ?? String(error) });
        }
    });

    app.listen(port, host, () => {
        const world = service.world();
        // With tokens the token names the person, so only the team goes in the URL.
        // With tokens the token names the person, and the default team needs no mention.
        const query = access.enabled ? '' : `?person=${world.defaults.person}${world.defaults.team ? `&team=${world.defaults.team}` : ''}`;
        console.log(`memory MCP server on ${host}:${port}${ui ? `: UI ${base}/` : ' (UI off)'}`);
        console.log('MCP endpoints (Streamable HTTP), one per memory version:');
        for (const version of FEATURED_VERSIONS) console.log(`  ${base}/mcp/${urlName(version)}${query}`);
        const header = access.enabled ? ' --header "Authorization: Bearer <your token>"' : '';
        console.log(`Claude Code: claude mcp add --transport http memory "${base}/mcp/${urlName(FEATURED_VERSIONS[0])}${query}"${header}`);
    });
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
