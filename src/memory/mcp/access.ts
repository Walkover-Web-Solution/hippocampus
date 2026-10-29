import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { World } from './service';

// Who may call the MCP endpoints. Tokens issued through the admin API are kept only as SHA-256 hashes
// (.memory-data/mcp/tokens.json), so a copy of that file can't be used to sign in. Tokens from
// MEMORY_MCP_TOKENS keep working alongside them.

interface IssuedToken {
    personId: string;
    hash: string;
    createdAt: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export class AccessStore {
    constructor(private file: string, private envTokens: Map<string, string> = new Map()) {}

    private read(): IssuedToken[] {
        if (!existsSync(this.file)) return [];
        return JSON.parse(readFileSync(this.file, 'utf8'));
    }

    // With no tokens anywhere the server is open (local use), as before.
    get enabled() {
        return this.envTokens.size > 0 || this.read().length > 0;
    }

    personFor(token: string | undefined): string | undefined {
        if (!token) return undefined;
        const fromEnv = this.envTokens.get(token);
        if (fromEnv) return fromEnv;
        const hash = sha256(token);
        return this.read().find((t) => t.hash === hash)?.personId;
    }

    // A fresh token for the person; tokens issued to them earlier stop working.
    issue(personId: string): string {
        const token = randomBytes(24).toString('hex');
        const tokens = this.read().filter((t) => t.personId !== personId);
        tokens.push({ personId, hash: sha256(token), createdAt: new Date().toISOString() });
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
        renameSync(tmp, this.file);
        return token;
    }
}

export const isAdmin = (world: World, personId: string) => world.memberships.some((m) => m.personId === personId && m.role === 'admin');

const slug = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

// Adds the person to the roster (or finds them by email, then by name) and makes them a member of the team.
export function upsertPerson(world: World, input: { name: string; email?: string; aliases?: string[]; team?: string }) {
    const name = input.name.trim();
    const email = input.email?.trim().toLowerCase();
    if (email && !isEmail(email)) throw new Error(`Not an email address: "${input.email}"`);
    const team = world.teams.find((t) => t.id === (input.team ?? world.defaults.team) || t.name.toLowerCase() === input.team?.toLowerCase());
    if (!team) throw new Error(`Unknown team "${input.team ?? world.defaults.team}". Known: ${world.teams.map((t) => t.id).join(', ')}`);
    let person = (email && world.people.find((p) => p.email === email))
        || world.people.find((p) => p.name.toLowerCase() === name.toLowerCase() && (!email || !p.email));
    if (!person) {
        const base = `p-${slug(name) || 'person'}`;
        let id = base;
        for (let n = 2; world.people.some((p) => p.id === id); n++) id = `${base}-${n}`;
        person = { id, name, aliases: [] };
        world.people.push(person);
    }
    if (email) person.email = email;
    for (const alias of input.aliases ?? []) {
        if (alias.trim() && !person.aliases.includes(alias.trim())) person.aliases.push(alias.trim());
    }
    if (!world.memberships.some((m) => m.personId === person!.id && m.teamId === team.id)) {
        world.memberships.push({ personId: person.id, teamId: team.id, role: 'member' });
    }
    return { person, team };
}
