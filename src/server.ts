import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools, type ToolContext } from './tools.js';

export const SERVER_INFO = { name: 'journey-ai', title: 'Journey', version: '0.2.1' };

export const INSTRUCTIONS =
  'Journey is read-only food and CPG supply chain data: suppliers, ingredients, ingredient price indexes and forecasts, your own Journey products and Journey Labs verification. ' +
  'Start with search_suppliers, search_ingredients or list_price_series. Search tools return at most 4 results unless the caller is signed in with full catalog access. ' +
  'Do not invent records. Usage counts toward the account lifetime data limits.';

/** One MCP server per authenticated account context (stateless HTTP creates one per request). */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {}, logging: {} }, instructions: INSTRUCTIONS });
  const outer = ctx.client;
  registerTools(server, Object.create(ctx, {
    // MCP clientInfo from initialize when this server saw it (stdio, stateful), else the HTTP user agent.
    client: {
      value: () => {
        const info = server.server.getClientVersion();
        const o = outer?.() ?? {};
        return { name: info?.name ?? o.name, version: info?.version ?? o.version, userAgent: o.userAgent };
      },
    },
  }) as ToolContext);
  return server;
}
