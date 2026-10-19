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
  JOURNEY_PRICE_API_KEY   Journey price feed key (free trial: https://price.journeyfoods.io)
  JOURNEY_API_KEY         Journey developer API key (https://dev.journeyfoods.io)
  JOURNEY_PRICE_API_BASE_URL, JOURNEY_API_BASE_URL, JOURNEY_SUPPLIER_API_BASE_URL  Override base URLs

Hosted server (no install): https://mcp.journeyfoods.io/mcp with header x-api-key.
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
  // Local (npx) mode: the account is the caller's own Journey API key from the environment.
  // Identity comes from JOURNEY_API_KEY. A price-feed-only setup (JOURNEY_PRICE_API_KEY) also works; in that case
  // no key is forwarded to the developer API, so each key only ever reaches the service that issued it.
  const identityKey = rt.cfg.apiKey ?? rt.cfg.priceApiKey;
  if (!identityKey) {
    rt.log.error('JOURNEY_API_KEY is not set. Create a key at https://dev.journeyfoods.io and set it in your MCP client config.');
    process.exit(1);
  }
  const resolved = await rt.keys.resolve(identityKey);
  const account = { ...resolved, authMethod: 'local' as const, upstreamApiKey: rt.cfg.apiKey ? resolved.upstreamApiKey : undefined };
  if (!rt.cfg.apiKey) rt.log.warn('JOURNEY_API_KEY is not set; running with the price feed key only. Developer API tools will be unavailable.');
  const server = createMcpServer({ account, data: rt.data, enforcer: rt.enforcer, log: rt.log, usage: rt.usage, transport: 'stdio' });
  await server.connect(new StdioServerTransport());
  rt.log.info('journey mcp running on stdio', { account: account.id });
}

main().catch((e) => {
  process.stderr.write(`journey-mcp failed to start: ${(e as Error).message}\n`);
  process.exit(1);
});
