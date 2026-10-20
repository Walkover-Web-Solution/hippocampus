/**
 * End-to-end checks against a real Postgres with pgvector, through the service layer (the same functions the HTTP
 * routes and MCP tools call). Skipped unless MEMORY_TEST_DATABASE_URL is set; it uses fake models, so no API key
 * is needed and search works on words and names rather than meaning.
 *
 *   MEMORY_TEST_DATABASE_URL=postgres://user:pass@localhost:5432/hippocampus_test npm test -- integration
 */
const url = process.env.MEMORY_TEST_DATABASE_URL;
process.env.MEMORY_DATABASE_URL = url ?? '';
process.env.MEMORY_FAKE_MODELS = 'true';
process.env.MEMORY_EMBEDDING_DIMENSIONS = process.env.MEMORY_EMBEDDING_DIMENSIONS || '64';
process.env.MEMORY_SIGNERS = JSON.stringify({ test: 'integration-secret' });
process.env.MEMORY_INLINE_INDEX_CHARS = '1000000';
process.env.QUEUE_CONNECTIONURL = process.env.QUEUE_CONNECTIONURL || 'amqp://127.0.0.1:1';
process.env.REDIS_CONNECTION_STRING = process.env.REDIS_CONNECTION_STRING || 'redis://127.0.0.1:1';

const describeIfDb = url ? describe : describe.skip;

describeIfDb('memory file system (integration)', () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { migrateMemory, closeMemoryDb, query } = require('../../db');
    const { memoryService } = require('../../service');
    const { Grants } = require('../../auth');
    /* eslint-enable @typescript-eslint/no-var-requires */

    const run = `t${Date.now()}`;
    const tenant = { issuer: 'test', orgId: run, projectId: 'p1' };
    const maya = { tenant, caller: 'users/maya', grants: Grants.parse({ 'users/maya': 'write', 'teams/acme': 'write', 'product-truth': 'read', 'customers/*': 'read' }) };
    const admin = { tenant, caller: 'admin', grants: Grants.parse({ '*': 'write' }) };
    const reader = { tenant, caller: 'agents/reader', grants: Grants.parse({ 'product-truth': 'read' }) };

    beforeAll(async () => {
        await migrateMemory();
    }, 60000);

    afterAll(async () => {
        await query('DELETE FROM memory_spaces WHERE issuer = $1 AND org_id = $2', ['test', run]);
        await closeMemoryDb();
    });

    it('writes, indexes, lists and opens notes; every write is a version', async () => {
        const first = await memoryService.write(admin, { space: 'product-truth', path: 'pricing', title: 'Pricing', body: 'Starter is $10 a month.\n\nPro is $30 a month.', kind: 'doc' });
        expect(first.created).toBe(true);
        expect(first.note.version).toBe(1);
        expect(first.indexed).toBe('indexed');

        const second = await memoryService.edit(admin, { space: 'product-truth', path: 'pricing', ops: [{ op: 'str_replace', old: 'Pro is $30', new: 'Pro is $35' }], if_version: 1 });
        expect(second.note.version).toBe(2);
        expect(second.note.body).toContain('Pro is $35');

        await expect(memoryService.edit(admin, { space: 'product-truth', path: 'pricing', ops: [{ op: 'append', text: 'x' }], if_version: 1 })).rejects.toMatchObject({ code: 409 });

        const index = await memoryService.index(maya, { space: 'product-truth' });
        expect(index.notes.map((note: any) => note.path)).toEqual(['pricing']);
        expect(index.notes[0].summary).toBe('Starter is $10 a month.');

        const opened = await memoryService.open(maya, { space: 'product-truth', path: 'pricing' });
        expect(opened.note.body).toContain('Pro is $35');
        const history = await memoryService.history(maya, { space: 'product-truth', path: 'pricing' });
        expect(history.versions.map((version: any) => version.version)).toEqual([1, 2]);

        const before = await memoryService.open(maya, { space: 'product-truth', path: 'pricing', version: 1 });
        expect(before.note.body).toContain('Pro is $30');
    });

    it('enforces grants from the token alone', async () => {
        await expect(memoryService.write(maya, { space: 'product-truth', path: 'x', body: 'no' })).rejects.toMatchObject({ code: 403 });
        await expect(memoryService.open(reader, { space: 'users/maya', path: 'anything' })).rejects.toMatchObject({ code: 403 });
        await expect(memoryService.write(maya, { space: 'customers/acme', path: 'x', body: 'no' })).rejects.toMatchObject({ code: 403 });
        const ok = await memoryService.write(maya, { space: 'teams/acme', path: 'launch', body: 'Acme launches Product X on November 3 in #payments.', entities: [{ name: 'acme', type: 'organisation' }, { name: 'product x', type: 'product' }], relations: [{ subject: 'acme', relation: 'launches', object: 'product x' }] });
        expect(ok.created).toBe(true);
        const spaces = await memoryService.spaces(reader);
        expect(spaces.spaces.map((space: any) => space.name)).toEqual(['product-truth']);
    });

    it('searches by words and names, lists rules first in the prompt, and travels the graph', async () => {
        await memoryService.write(maya, { space: 'users/maya', body: 'Prefers a casual tone.', kind: 'rule', slot: 'tone' });
        await memoryService.write(admin, { space: 'teams/acme', body: 'Use a formal tone.', kind: 'rule', slot: 'tone' });
        const result = await memoryService.search(maya, { query: 'When does Acme launch in #payments?', spaces: ['users/maya', 'teams/acme'] });
        expect(result.results.map((hit: any) => hit.path)).toContain('launch');
        expect(result.prompt).toContain('(tone) Prefers a casual tone.');
        expect(result.prompt).not.toContain('formal');
        expect(result.connections.map((connection: any) => connection.name)).toContain('acme');

        const entity = await memoryService.entity(maya, { name: 'Acme' });
        expect(entity.entity.notes.map((note: any) => note.path)).toContain('launch');
        expect(entity.entity.links).toEqual(expect.arrayContaining([expect.objectContaining({ subject: 'acme', relation: 'launches', object: 'product x' })]));
        expect(entity.entity.connected.map((c: any) => c.name)).toContain('product x');
        const entities = await memoryService.entities(maya, {});
        expect(entities.entities.map((e: any) => e.name)).toEqual(expect.arrayContaining(['acme', '#payments']));
    });

    it('remembers with merge: a repeat confirms, a rule replaces its slot', async () => {
        const added = await memoryService.remember(maya, { space: 'users/maya', text: 'Runs marketing at Acme.' });
        expect(added.outcome).toBe('added');
        const again = await memoryService.remember(maya, { space: 'users/maya', text: 'Runs marketing at Acme.' });
        expect(again.outcome).toBe('confirmed');
        expect(again.note.confirmed).toBe(2);
        const rule = await memoryService.remember(maya, { space: 'users/maya', text: 'Prefers a formal tone from now on.', kind: 'rule', slot: 'tone' });
        expect(rule.outcome).toBe('replaced');
        expect(rule.note.path).toBe('rules/tone');
        expect(rule.note.version).toBe(2);
        await expect(memoryService.remember(maya, { space: 'users/maya', text: 'Call me on 9876543210.' })).rejects.toMatchObject({ code: 400 });
    });

    it('reads the past with as_of and forgets by note, name and source', async () => {
        const start = new Date();
        await new Promise((resolve) => setTimeout(resolve, 20));
        await memoryService.write(maya, { space: 'users/maya', path: 'facts/plan', body: 'Acme is on the Business plan.', source: { type: 'thread', id: 'chat-1' } });
        await new Promise((resolve) => setTimeout(resolve, 20));
        const middle = new Date();
        await memoryService.write(maya, { space: 'users/maya', path: 'facts/plan', body: 'Acme is on the Enterprise plan.', source: { type: 'thread', id: 'chat-1' } });
        const atMiddle = await memoryService.open(maya, { space: 'users/maya', path: 'facts/plan', as_of: middle.toISOString() });
        expect(atMiddle.note.body).toContain('Business');
        await expect(memoryService.open(maya, { space: 'users/maya', path: 'facts/plan', as_of: start.toISOString() })).rejects.toMatchObject({ code: 404 });

        const bySource = await memoryService.forgetSource(maya, { type: 'thread', id: 'chat-1', spaces: ['users/maya'] });
        expect(bySource.deleted).toBe(1);
        await expect(memoryService.open(maya, { space: 'users/maya', path: 'facts/plan' })).rejects.toMatchObject({ code: 404 });

        const byName = await memoryService.forgetEntity(maya, { name: 'acme', spaces: ['teams/acme'] });
        expect(byName.deleted).toBe(1);
        const deleted = await memoryService.deleteNote(maya, { space: 'users/maya', path: 'rules/tone' });
        expect(deleted.deleted).toBe(1);
        const gone = await memoryService.deleteSpace(admin, { space: 'product-truth' });
        expect(gone.deleted).toBe(1);
    });
});
