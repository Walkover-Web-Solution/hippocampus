import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// The SDK's types are written against "zod/v3"; importing the same path keeps one set of declarations.
import { z } from 'zod/v3';
import { formatMemories } from '../core/answer';
import type { RecalledMemory } from '../core/types';
import type { MemoryEvent } from './events';
import { PromptSet, promptSet } from './prompts';
import { MemoryService } from './service';

// The MCP face of one memory version. Identity (who is speaking, which team they're in) comes from
// the connection (URL query or stdio flags); every tool can override the team. All text the agent
// reads comes from a prompt set (prompts.ts).

export interface Connection {
    version: string;
    person?: string;
    team?: string | null;
    source: MemoryEvent['source'];
}

export function recallText(memories: RecalledMemory[], prompts: PromptSet): string {
    if (memories.length === 0) return prompts.noMemories;
    const text = formatMemories(memories);
    return prompts.statusLegend && memories.some((m) => m.status !== 'current') ? `${text}\n\n${prompts.statusLegend}` : text;
}

export function buildMcpServer(service: MemoryService, connection: Connection, prompts: PromptSet = promptSet()): McpServer {
    const server = new McpServer({ name: prompts.serverName(connection.version), version: '0.1.0' }, { instructions: prompts.instructions });
    const client = () => server.server.getClientVersion()?.name ?? null;
    const team = (override?: string) => (override === undefined ? connection.team : override);
    const teamParam = z.string().optional().describe(prompts.team);

    server.registerTool('remember', {
        title: 'Remember',
        description: prompts.remember.description,
        inputSchema: {
            user_message: z.string().min(1).describe(prompts.remember.userMessage),
            ...(prompts.remember.context ? { context: z.string().optional().describe(prompts.remember.context) } : {}),
            assistant_message: z.string().optional().describe(prompts.remember.assistantMessage),
            inferred: z.boolean().optional().describe(prompts.remember.inferred),
            team: teamParam,
            wait: z.boolean().optional().describe(prompts.remember.wait),
        },
    }, async (args) => {
        const { user_message, assistant_message, inferred, team: teamOverride, wait } = args;
        const context = typeof (args as { context?: unknown }).context === 'string' ? (args as { context: string }).context.trim() : '';
        const turns = [{ role: 'user' as const, content: user_message }, ...(assistant_message ? [{ role: 'assistant' as const, content: assistant_message }] : [])];
        const { event, done } = service.remember({
            version: connection.version, person: connection.person, team: team(teamOverride), kind: inferred ? 'agent' : 'user',
            agent: client() ?? 'mcp', turns, source: connection.source, client: client(),
            // The agent's note on who or what the message refers to: earlier conversation, used only to resolve references.
            context: context ? [{ role: 'assistant' as const, content: `In this conversation: ${context}` }] : undefined,
        });
        if (!wait) return { content: [{ type: 'text', text: prompts.queued(connection.version, event.id) }] };
        const result = await done;
        if (result.status === 'error') return { isError: true, content: [{ type: 'text', text: `Memory write failed: ${result.error}` }] };
        const steps = result.steps?.length ? result.steps.map((s) => `- [${s.kind}] ${s.text}`).join('\n') : '- nothing worth remembering was found';
        return { content: [{ type: 'text', text: `Processed in ${result.ms} ms:\n${steps}` }] };
    });

    server.registerTool('recall', {
        title: 'Recall',
        description: prompts.recall.description,
        inputSchema: {
            query: z.string().min(1).describe(prompts.recall.query),
            team: teamParam,
            as_of: z.string().optional().describe(prompts.recall.asOf),
            include_unconfirmed: z.boolean().optional().describe(prompts.recall.includeUnconfirmed),
            limit: z.number().int().min(1).max(30).optional().describe(prompts.recall.limit),
        },
        annotations: { readOnlyHint: true },
    }, async ({ query, team: teamOverride, as_of, include_unconfirmed, limit }) => {
        const result = await service.recall({
            version: connection.version, person: connection.person, team: team(teamOverride), query, asOf: as_of ?? null,
            includeProposed: include_unconfirmed ?? false, topK: limit ?? 8, source: connection.source, client: client(),
        });
        if (result.status === 'error') return { isError: true, content: [{ type: 'text', text: `Recall failed: ${result.error}` }] };
        return { content: [{ type: 'text', text: recallText(result.memories ?? [], prompts) }] };
    });

    server.registerTool('list_memories', {
        title: 'List memories',
        description: prompts.list,
        inputSchema: { team: teamParam },
        annotations: { readOnlyHint: true },
    }, async ({ team: teamOverride }) => {
        const memories = await service.list(connection.version, connection.person, team(teamOverride));
        return { content: [{ type: 'text', text: recallText(memories, prompts) }] };
    });

    server.registerTool('whoami', {
        title: 'Who am I',
        description: prompts.whoami,
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
