#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildRuntime } from './runtime.js';
import { createHttpApp } from './http.js';
import { createMcpServer, SERVER_INFO } from './server.js';

const HELP = `journey-mcp: Journey AI MCP server (food and CPG supplier, ingredient and commodity price data)

Usage:
  npx -y @journeyfoods/mcp            Run over stdio (for Claude Desktop, Cursor, VS Code and other MCP clients)
  npx -y @journeyfoods/mcp --http     Run a Streamable HTTP server on HOST:PORT (default 127.0.0.1:3000)
  npx -y @journeyfoods/mcp --help     Show this help
  npx -y @journeyfoods/mcp --version  Show the version

Environment:
  JOURNEY_PRICE_API_KEY   Price feed key (free trial: https://price.journeyfoods.io). Enables price tools.
  JOURNEY_API_KEY         Developer API key (https://dev.journeyfoods.io). Required for ingredient tools.
                          The price feed key is not accepted by the developer API.
  JOURNEY_PRICE_API_BASE_URL   Default https://price.journeyfoods.io (/api/v1/commodities)
  JOURNEY_API_BASE_URL         Default https://devapi.journeyfoods.io (x-api-key)
  JOURNEY_SUPPLIER_API_BASE_URL  No default. Internal backend; a user key is not sent.
                                 Local supplier tools use the hosted server unless this is set.

Hosted server (no install, includes suppliers): https://mcp.journeyfoods.io/mcp with header x-api-key.
Docs: https://docs.journeyfoods.io
`;

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    process.stdout.write(`${SERVER_INFO.version}\n`);
    return;
  }
  const rt = buildRuntime();
  const http = process.argv.includes('--http') || process.env.MCP_TRANSPORT === 'http';
  if (http) {
    const app = createHttpApp(rt);
    app.listen(rt.cfg.port, rt.cfg.host, () => rt.log.info('journey mcp listening', { host: rt.cfg.host, port: rt.cfg.port, oauth: Boolean(rt.verifier) }));
    return;
  }
  // Local (npx) mode. Identity is the price-feed account when a price key is configured, so a new key for the
  // same account does not reset caps. The developer API key is forwarded only to the developer API.
  const identityKey = rt.cfg.priceApiKey ?? rt.cfg.apiKey;
  if (!identityKey) {
    rt.log.error('Set JOURNEY_PRICE_API_KEY (free trial: https://price.journeyfoods.io) or JOURNEY_API_KEY (developer key: https://dev.journeyfoods.io).');
    process.exit(1);
  }
  const resolved = await rt.keys.resolve(identityKey);
  // upstreamApiKey is the developer API key only. The price feed key is a different credential and is not forwarded.
  const account = { ...resolved, authMethod: 'local' as const, upstreamApiKey: rt.cfg.apiKey };
  if (!rt.cfg.apiKey) {
    rt.log.warn('JOURNEY_API_KEY is not set. Ingredient tools need a developer API key from https://dev.journeyfoods.io. Price tools use JOURNEY_PRICE_API_KEY.');
  }
  const server = createMcpServer({ account, data: rt.data, enforcer: rt.enforcer, log: rt.log, usage: rt.usage, transport: 'stdio' });
  await server.connect(new StdioServerTransport());
  rt.log.info('journey mcp running on stdio', { account: account.id });
}

main().catch((e) => {
  process.stderr.write(`journey-mcp failed to start: ${(e as Error).message}\n`);
  process.exit(1);
});
