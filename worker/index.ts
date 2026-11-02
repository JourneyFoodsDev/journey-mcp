import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { buildRuntime } from '../src/runtime.js';
import { createMcpServer } from '../src/server.js';
import { readSecretBinding } from '../src/auth/end-user.js';
import { AuthError } from '../src/errors.js';
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
  if (supplier) proc.JOURNEY_SUPPLIER_API_KEY = supplier;
  if (signing) proc.JOURNEY_END_USER_SIGNING_SECRET = signing;
  else delete proc.JOURNEY_END_USER_SIGNING_SECRET;
  return loadConfig(proc);
}

let runtimePromise: Promise<ReturnType<typeof buildRuntime>> | undefined;

function runtime(env: WorkerEnv) {
  runtimePromise ??= loadWorkerConfig(env).then((cfg) => buildRuntime(cfg, createLogger('info', (line) => console.log(line))));
  return runtimePromise;
}

function unauthorized(message = 'Authentication required. Send a Journey API key in the x-api-key header.'): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'www-authenticate': 'Bearer realm="Journey AI", error="invalid_token", error_description="Send a Journey API key in x-api-key. Get a free trial key at https://price.journeyfoods.io"',
    },
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') {
      return Response.json({ name: 'Journey AI', mcp: `${url.origin}/mcp`, auth: ['api_key'], docs: 'https://journeyfoods.io/mcp' });
    }
    // Every data endpoint requires an API key. `/` is discovery only and returns no Journey data.
    if (url.pathname !== '/mcp') return Response.json({ error: 'not_found' }, { status: 404 });
    if (request.method !== 'POST') {
      return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This server is stateless; use POST.' }, id: null }, { status: 405 });
    }
    const apiKey = request.headers.get('x-api-key')?.trim();
    if (!apiKey) return unauthorized();
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
  },
};
