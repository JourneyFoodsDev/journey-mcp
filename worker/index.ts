import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { buildRuntime } from '../src/runtime.js';
import { createMcpServer } from '../src/server.js';
import { readSecretBinding } from '../src/auth/end-user.js';
import { AuthError } from '../src/errors.js';
import { createOAuthProvider, mcpResource, resourceMetadataUrl } from './oauth.js';
export { AccountLedger, JourneyMcp } from './durable-objects.js';

/**
 * Cloudflare fallback for the Nov 2 2026 Atlas outage.
 * Rollback (mcp_rollback_vars.json): supplier and app bases return to the Cloud Run API,
 * and JOURNEY_API_BASE_URL returns to https://devapi.journeyfoods.io.
 */
export const FALLBACK_DEV_API_BASE = 'https://journey-fallback.journeyfoods.workers.dev/x/devapi';
export const FALLBACK_MCP_API_BASE = 'https://journey-fallback.journeyfoods.workers.dev/x/mcp';

/** Bindings the Worker receives. Secrets Store values are objects with get(), not strings. */
export interface WorkerEnv {
  /** This repo's developer API base. Live Worker name: JOURNEY_DEV_API_BASE. */
  JOURNEY_API_BASE_URL?: string;
  /** Live Worker name for the developer API. Mapped onto JOURNEY_API_BASE_URL when that is unset. */
  JOURNEY_DEV_API_BASE?: string;
  /** This repo's supplier API base. Live Worker name: JOURNEY_API_BASE. */
  JOURNEY_SUPPLIER_API_BASE_URL?: string;
  /** This repo's app API base. Live Worker sets this from JOURNEY_API_BASE. */
  JOURNEY_APP_API_BASE_URL?: string;
  /** Live Worker name for the Node API (suppliers, products, labs). */
  JOURNEY_API_BASE?: string;
  JOURNEY_PRICE_API_BASE_URL?: string;
  /** Live Worker name. Mapped onto JOURNEY_PRICE_API_BASE_URL when that is unset. */
  JOURNEY_PRICE_API_BASE?: string;
  JOURNEY_APP_URL?: string;
  MCP_RESOURCE?: string;
  OAUTH_KV?: unknown;
  MCP_OBJECT?: unknown;
  ACCOUNT_LEDGER?: unknown;
  USAGE_EVENTS?: unknown;
  FIREBASE_WEB_API_KEY?: unknown;
  JOURNEY_PRICE_API_KEY?: unknown;
  SESSION_SECRET?: unknown;
  JOURNEY_SUPPLIER_API_KEY?: unknown;
  JOURNEY_END_USER_SIGNING_SECRET?: unknown;
  [key: string]: unknown;
}

function stringEnv(env: WorkerEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v;
  return out;
}

export async function loadWorkerConfig(env: WorkerEnv) {
  const proc = stringEnv(env);
  // Prefer this repo's names. Fall back to the live Worker's names, then to the Cloudflare copy.
  // An explicit rollback URL (Cloud Run or devapi) still wins over the fallback.
  if (!proc.JOURNEY_API_BASE_URL) proc.JOURNEY_API_BASE_URL = proc.JOURNEY_DEV_API_BASE || FALLBACK_DEV_API_BASE;
  if (!proc.JOURNEY_SUPPLIER_API_BASE_URL) proc.JOURNEY_SUPPLIER_API_BASE_URL = proc.JOURNEY_API_BASE || FALLBACK_MCP_API_BASE;
  // App reads follow the supplier base. An explicit supplier URL wins over the live JOURNEY_API_BASE name.
  if (!proc.JOURNEY_APP_API_BASE_URL) proc.JOURNEY_APP_API_BASE_URL = proc.JOURNEY_SUPPLIER_API_BASE_URL;
  if (!proc.JOURNEY_PRICE_API_BASE_URL && proc.JOURNEY_PRICE_API_BASE) proc.JOURNEY_PRICE_API_BASE_URL = proc.JOURNEY_PRICE_API_BASE;
  const supplier = await readSecretBinding(env.JOURNEY_SUPPLIER_API_KEY);
  // Missing signing secret: leave it unset so backend calls omit the end-user headers instead of 401ing.
  const signing = await readSecretBinding(env.JOURNEY_END_USER_SIGNING_SECRET, { optional: true });
  // Same Secrets Store get() as the supplier key. A string env value is accepted too.
  const priceKey = await readSecretBinding(env.JOURNEY_PRICE_API_KEY);
  if (supplier) proc.JOURNEY_SUPPLIER_API_KEY = supplier;
  if (signing) proc.JOURNEY_END_USER_SIGNING_SECRET = signing;
  else delete proc.JOURNEY_END_USER_SIGNING_SECRET;
  if (priceKey) proc.JOURNEY_PRICE_API_KEY = priceKey;
  return loadConfig(proc);
}

let runtimePromise: Promise<ReturnType<typeof buildRuntime>> | undefined;

function runtime(env: WorkerEnv) {
  runtimePromise ??= loadWorkerConfig(env).then((cfg) => buildRuntime(cfg, createLogger('info', (line) => console.log(line))));
  return runtimePromise;
}

function unauthorized(message = 'Authentication required. Send a Journey API key in the x-api-key header.', resourceMetadata?: string): Response {
  const meta = resourceMetadata ? `, resource_metadata="${resourceMetadata}"` : '';
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'www-authenticate': `Bearer realm="Journey AI", error="invalid_token", error_description="Sign in with OAuth or send a Journey API key in x-api-key. Get a free trial key at https://price.journeyfoods.io"${meta}`,
    },
  });
}

/** CORS for browser-based MCP clients and connector setup. Credentials are headers, never cookies, on /mcp. */
export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type, Accept, x-api-key, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'WWW-Authenticate, mcp-session-id, mcp-protocol-version, Retry-After',
  'access-control-max-age': '86400',
};

function withCors(response: Response, request: Request): Response {
  const url = new URL(request.url);
  // The sign-in page is a top-level page, not an API.
  if (url.pathname === '/authorize') return response;
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(CORS_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  return out;
}

/** One MCP request for a Journey API key. x-api-key and OAuth bearer tokens both end here. */
export async function serveMcp(request: Request, env: WorkerEnv, apiKey: string): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This server is stateless; use POST.' }, id: null }, { status: 405, headers: { allow: 'POST, OPTIONS' } });
  }
  const rt = await runtime(env);
  let account;
  try {
    account = await rt.keys.resolve(apiKey);
  } catch (e) {
    return unauthorized(e instanceof AuthError ? e.message : 'Authentication failed.');
  }
  const server = createMcpServer({
    account,
    data: rt.data,
    enforcer: rt.enforcer,
    log: rt.log,
    usage: rt.usage,
    transport: 'worker',
    client: () => ({ userAgent: request.headers.get('user-agent') ?? undefined }),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
    await server.close();
  }
}

async function route(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method === 'GET' && url.pathname === '/') {
    return Response.json({
      name: 'Journey AI',
      mcp: `${url.origin}/mcp`,
      auth: ['api_key', 'oauth'],
      oauth: { protected_resource_metadata: resourceMetadataUrl(mcpResource(env)), authorization_server: `${url.origin}/.well-known/oauth-authorization-server` },
      docs: 'https://journeyfoods.io/mcp',
    });
  }
  if (url.pathname === '/mcp') {
    // x-api-key: unchanged path for Claude Code, Cursor and scripts.
    const apiKey = request.headers.get('x-api-key');
    if (apiKey !== null) {
      if (!apiKey.trim()) return unauthorized();
      return serveMcp(request, env, apiKey.trim());
    }
    // No credential at all: point the client at OAuth discovery (MCP authorization spec, RFC 9728).
    if (!request.headers.get('authorization')) return unauthorized(undefined, resourceMetadataUrl(mcpResource(env)));
  }
  if (!env.OAUTH_KV) return Response.json({ error: 'not_found' }, { status: 404 });
  const provider = createOAuthProvider(env, { serveMcp, resolveKey: async (e, key) => (await runtime(e)).keys.resolve(key) });
  // Some clients probe the root form of RFC 9728 metadata; serve the same document as the /mcp form.
  if (url.pathname === '/.well-known/oauth-protected-resource') {
    const canonical = new URL(resourceMetadataUrl(mcpResource(env)));
    if (canonical.pathname !== url.pathname) return provider.fetch(new Request(canonical.href, request), env as any, ctx);
  }
  // Bearer tokens on /mcp, OAuth metadata, /register, /authorize and /token.
  return provider.fetch(request, env as any, ctx);
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx?: ExecutionContext): Promise<Response> {
    const fallbackCtx = ctx ?? ({ waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext);
    return withCors(await route(request, env, fallbackCtx), request);
  },
};
