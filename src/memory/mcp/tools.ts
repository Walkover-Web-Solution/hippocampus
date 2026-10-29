import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// The SDK's types are written against "zod/v3"; importing the same path keeps one set of declarations.
import { z } from 'zod/v3';
import { formatMemories } from '../core/answer';
import type { MemoryEvent } from './events';
import { MemoryService } from './service';

// The MCP face of one memory version. Identity (who is speaking, which team they're in) comes from
// the connection (URL query or stdio flags); every tool can override the team.

export interface Connection {
    version: string;
    person?: string;
    team?: string | null;
    source: MemoryEvent['source'];
}

const INSTRUCTIONS = `Long-term memory shared between the user's apps and their teams.
- Before answering anything that may depend on what the user or their team said earlier (people, projects, deadlines, owners, decisions, preferences, rules), call \`recall\` with a short question.
- When the user states a fact, decision, plan, preference, rule or correction worth keeping, call \`remember\` with the user's exact words in \`user_message\`. Don't paraphrase: facts are only kept when the message contains them.
- Memories marked "superseded" are history, "proposed" are unconfirmed, "disputed" conflict: say so instead of picking one.
- In a team, what people say about their own work and availability is shared with that team; feelings, preferences and anything marked private stay personal.`;

const teamParam = z.string().optional().describe('Team id or name to act in. Omit for the default team; "none" for personal memory only.');

export function buildMcpServer(service: MemoryService, connection: Connection): McpServer {
    const server = new McpServer({ name: `memory (${connection.version})`, version: '0.1.0' }, { instructions: INSTRUCTIONS });
    const client = () => server.server.getClientVersion()?.name ?? null;
    const team = (override?: string) => (override === undefined ? connection.team : override);

    server.registerTool('remember', {
        title: 'Remember',
        description: 'Store what the user just said so it can be recalled later, in this or other apps. Pass the user\'s exact words. Writes are processed in the background unless wait is true.',
        inputSchema: {
            user_message: z.string().min(1).describe("The user's message, verbatim."),
            assistant_message: z.string().optional().describe('Your reply, if the user confirmed something in it.'),
            inferred: z.boolean().optional().describe('True when this is your inference rather than something the user stated; it is stored as unconfirmed.'),
            team: teamParam,
            wait: z.boolean().optional().describe('Wait for processing (10-30 s) and report what was stored.'),
        },
    }, async ({ user_message, assistant_message, inferred, team: teamOverride, wait }) => {
        const turns = [{ role: 'user' as const, content: user_message }, ...(assistant_message ? [{ role: 'assistant' as const, content: assistant_message }] : [])];
        const { event, done } = service.remember({
            version: connection.version, person: connection.person, team: team(teamOverride), kind: inferred ? 'agent' : 'user',
            agent: client() ?? 'mcp', turns, source: connection.source, client: client(),
        });
        if (!wait) return { content: [{ type: 'text', text: `Queued for memory (${connection.version}); searchable in about 20 seconds. Event ${event.id}.` }] };
        const result = await done;
        if (result.status === 'error') return { isError: true, content: [{ type: 'text', text: `Memory write failed: ${result.error}` }] };
        const steps = result.steps?.length ? result.steps.map((s) => `- [${s.kind}] ${s.text}`).join('\n') : '- nothing worth remembering was found';
        return { content: [{ type: 'text', text: `Processed in ${result.ms} ms:\n${steps}` }] };
    });

    server.registerTool('recall', {
        title: 'Recall',
        description: 'Search memory (the user\'s personal memory plus the active team\'s) for facts relevant to a question.',
        inputSchema: {
            query: z.string().min(1).describe('A short question or topic, e.g. "When does the Phoenix launch?"'),
            team: teamParam,
            as_of: z.string().optional().describe('ISO date to ask what was true back then.'),
            include_unconfirmed: z.boolean().optional().describe('Also return unconfirmed (agent-inferred) memories.'),
            limit: z.number().int().min(1).max(30).optional().describe('Maximum memories (default 8).'),
        },
        annotations: { readOnlyHint: true },
    }, async ({ query, team: teamOverride, as_of, include_unconfirmed, limit }) => {
        const result = await service.recall({
            version: connection.version, person: connection.person, team: team(teamOverride), query, asOf: as_of ?? null,
            includeProposed: include_unconfirmed ?? false, topK: limit ?? 8, source: connection.source, client: client(),
        });
        if (result.status === 'error') return { isError: true, content: [{ type: 'text', text: `Recall failed: ${result.error}` }] };
        return { content: [{ type: 'text', text: formatMemories(result.memories ?? []) }] };
    });

    server.registerTool('list_memories', {
        title: 'List memories',
        description: 'List everything currently stored that the user can see (personal plus active team).',
        inputSchema: { team: teamParam },
        annotations: { readOnlyHint: true },
    }, async ({ team: teamOverride }) => {
        const memories = await service.list(connection.version, connection.person, team(teamOverride));
        return { content: [{ type: 'text', text: formatMemories(memories) }] };
    });

    server.registerTool('whoami', {
        title: 'Who am I',
        description: 'Show which person, team and memory version this connection uses, and the teams available.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
    }, async () => {
        const { person, teamId } = service.identity(connection.person, connection.team);
        const world = service.world();
        const teams = world.memberships.filter((m) => m.personId === person.id)
            .map((m) => `${m.teamId} (${world.teams.find((t) => t.id === m.teamId)?.name ?? '?'}, ${m.role})`);
        return { content: [{ type: 'text', text: `You are ${person.name} (${person.id}). Active team: ${teamId ?? 'none'}. Memory version: ${connection.version}. Your teams: ${teams.join(', ') || 'none'}.` }] };
    });

    return server;
}
