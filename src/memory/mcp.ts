import { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { memoryAuthOf } from './auth';
import { TOOLS } from './tools';

/**
 * The same verbs as MCP tools over streamable HTTP, stateless: every request builds a server scoped to its token,
 * so an MCP client (Claude Desktop, Cursor, an agent framework) points at POST /memory/mcp with the memory token
 * as a bearer and gets exactly the spaces the token grants.
 */
const serverFor = (auth: ReturnType<typeof memoryAuthOf>): McpServer => {
    const server = new McpServer({ name: 'hippocampus-memory', version: '1.0.0' });
    for (const tool of TOOLS) {
        // The config is untyped on purpose: the SDK's generic over every tool's exact zod shape is too deep for the
        // compiler, and the shapes are checked where the tools are defined.
        const config: any = { description: tool.description, inputSchema: tool.input.shape };
        server.registerTool(tool.name, config, (async (args: Record<string, unknown>) => {
            try {
                const result = await tool.run(auth, args ?? {});
                return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
            } catch (error: any) {
                return { isError: true, content: [{ type: 'text' as const, text: error?.message ?? 'The tool failed' }] };
            }
        }) as any);
    }
    return server;
};

export async function handleMcp(req: Request, res: Response): Promise<void> {
    const auth = memoryAuthOf(res);
    const server = serverFor(auth);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
        transport.close().catch(() => undefined);
        server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
}
