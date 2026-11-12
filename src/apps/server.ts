import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_INFO } from '../server.js';
import { registerTools, type ToolContext } from '../tools.js';
import { APPS, type AppId } from './definitions.js';
import { registerGuavaTools } from './guava.js';
import { registerProfileTool } from './profile.js';
import { UI_MIME, WIDGETS, widgetMeta } from './widgets.js';

/** One directory app. Tools stay text-complete; UI resources are optional panels. */
export function createAppServer(appId: AppId, ctx: ToolContext, metadataUrl: string): McpServer {
  const app = APPS[appId];
  const server = new McpServer(
    { name: app.serverName, title: app.title, version: SERVER_INFO.version },
    { capabilities: { tools: {}, resources: {}, logging: {} }, instructions: app.instructions },
  );
  const outer = ctx.client;
  const appCtx = Object.create(ctx, {
    directory: { value: true },
    resourceMetadataUrl: { value: metadataUrl },
    widgetUris: { value: app.widgets },
    client: {
      value: () => {
        const info = server.server.getClientVersion();
        const base = outer?.() ?? {};
        return { name: info?.name ?? base.name, version: info?.version ?? base.version, userAgent: base.userAgent };
      },
    },
  }) as ToolContext;
  if (app.tools.length) registerTools(server, appCtx, { only: app.tools });
  if (appId === 'guava') registerGuavaTools(server, appCtx);
  registerProfileTool(server, appCtx);
  const seen = new Set<string>();
  for (const uri of Object.values(app.widgets)) {
    if (seen.has(uri)) continue;
    seen.add(uri);
    const widget = WIDGETS[uri];
    if (!widget) continue;
    server.registerResource(
      widget.name,
      uri,
      { mimeType: UI_MIME, description: widget.description, _meta: widgetMeta() },
      async () => ({ contents: [{ uri, mimeType: UI_MIME, text: widget.html, _meta: widgetMeta() }] }),
    );
  }
  return server;
}
