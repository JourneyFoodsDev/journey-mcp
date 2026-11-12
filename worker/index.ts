import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { buildRuntime } from '../src/runtime.js';
import { createMcpServer } from '../src/server.js';
import { readSecretBinding } from '../src/auth/end-user.js';
import { anonymousAccount } from '../src/auth/account.js';
import { AuthError } from '../src/errors.js';
import { appForPath, metadataForRequestPath, metadataUrl, resourceForPath } from '../src/apps/definitions.js';
import { createAppServer } from '../src/apps/server.js';
import type { AppId } from '../src/apps/definitions.js';
import { D1GuavaCatalog, type GuavaD1 } from '../src/apps/guava-d1.js';
import { queryGuavaCatalog } from '../src/apps/guava-http.js';
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
  /** D1 snapshot written by guava-catalog-sync. Absent until this Worker is deployed with the binding. */
  GUAVA_D1?: GuavaD1;
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
  if (!proc.MCP_RESOURCE_URL) proc.MCP_RESOURCE_URL = proc.MCP_RESOURCE || 'https://mcp.journeyfoods.io/mcp';
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

function unauthorized(message = 'Authentication required. Send a Journey API key in the x-api-key header.', metadata?: string): Response {
  const extra = metadata ? ` resource_metadata="${metadata}",` : '';
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'www-authenticate': `Bearer realm="Journey",${extra} error="invalid_token", error_description="Send a Journey API key in x-api-key, or sign in with OAuth. Get a free trial key at https://price.journeyfoods.io"`,
    },
  });
}

const CORS_ORIGINS = new Set(['https://chatgpt.com', 'https://chat.openai.com']);

function withCors(request: Request, response: Response): Response {
  const origin = request.headers.get('origin');
  const self = new URL(request.url).origin;
  if (!origin || (!CORS_ORIGINS.has(origin) && origin !== self)) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.set('access-control-allow-headers', 'authorization, content-type, accept, x-api-key, mcp-protocol-version');
  headers.set('access-control-allow-methods', 'POST, GET, OPTIONS');
  headers.set('vary', 'origin');
  return new Response(response.body, { status: response.status, headers });
}

async function accountFromRequest(request: Request, rt: Awaited<ReturnType<typeof runtime>>, resource: string, allowAnonymous: boolean) {
  const apiKey = request.headers.get('x-api-key')?.trim();
  const authz = request.headers.get('authorization');
  if (authz?.toLowerCase().startsWith('bearer ')) {
    if (!rt.verifier) throw new AuthError('OAuth is not configured on this server. Use an x-api-key header.', 'oauth_not_configured');
    return rt.verifier.verify(authz.slice(7).trim(), resource);
  }
  if (apiKey) return rt.keys.resolve(apiKey);
  if (allowAnonymous) return anonymousAccount();
  throw new AuthError('Authentication required. Send a Journey API key in the x-api-key header.', 'missing_credentials');
}

async function readParams(request: Request): Promise<URLSearchParams> {
  const text = await request.text();
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    const body = text ? JSON.parse(text) as Record<string, unknown> : {};
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) if (typeof value === 'string') params.set(key, value);
    return params;
  }
  return new URLSearchParams(text);
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const rtPromise = () => runtime(env);
    if (request.method === 'GET' && (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname.startsWith('/.well-known/oauth-protected-resource/'))) {
      const rt = await rtPromise();
      return Response.json(metadataForRequestPath(rt.cfg, url.pathname), { headers: { 'cache-control': 'no-store' } });
    }
    if (request.method === 'GET' && (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration')) {
      const rt = await rtPromise();
      return Response.json(rt.authServer.metadata(), { headers: { 'cache-control': 'no-store' } });
    }
    if (request.method === 'GET' && (url.pathname === '/.well-known/jwks.json' || url.pathname === '/oauth/jwks.json')) {
      const rt = await rtPromise();
      return Response.json(await rt.authServer.jwks(), { headers: { 'cache-control': 'no-store' } });
    }
    if (request.method === 'GET' && url.pathname === '/.well-known/openai-apps-challenge') {
      const token = (await readSecretBinding(env.OPENAI_APPS_CHALLENGE, { optional: true })) ?? (typeof env.OPENAI_APPS_CHALLENGE === 'string' ? env.OPENAI_APPS_CHALLENGE.trim() : '');
      if (!token) return new Response('not_configured', { status: 404, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
      return new Response(token, { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/oauth/register' && request.method === 'POST') {
      const rt = await rtPromise();
      const result = await rt.authServer.register(await request.json().catch(() => ({})));
      return Response.json(result.body, { status: result.status, headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/oauth/authorize' && request.method === 'GET') {
      const rt = await rtPromise();
      const result = await rt.authServer.authorize(url.searchParams);
      if (result.location) return new Response(null, { status: result.status, headers: { location: result.location, 'cache-control': 'no-store' } });
      return Response.json(result.body, { status: result.status, headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/oauth/token' && request.method === 'POST') {
      const rt = await rtPromise();
      const result = await rt.authServer.token(await readParams(request));
      return Response.json(result.body, { status: result.status, headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/oauth/userinfo' && request.method === 'GET') {
      const rt = await rtPromise();
      const result = await rt.authServer.userinfo(request.headers.get('authorization') ?? undefined);
      return Response.json(result.body, { status: result.status, headers: { 'cache-control': 'no-store' } });
    }
    if (request.method === 'GET' && url.pathname === '/') {
      return Response.json({
        name: 'Journey',
        mcp: `${url.origin}/mcp`,
        auth: ['api_key', 'oauth'],
        docs: 'https://www.journeyfoods.io/mcp',
        apps: {
          journey_foods: `${url.origin}/apps/journey-foods/mcp`,
          guava: `${url.origin}/apps/guava/mcp`,
        },
        guava_catalog: `${url.origin}/apps/guava/v1/products`,
      });
    }
    if (url.pathname === '/apps/guava/v1/products' || url.pathname.startsWith('/apps/guava/v1/products/')) {
      if (request.method === 'OPTIONS') return withCors(request, new Response(null, { status: 204 }));
      if (request.method !== 'GET') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
      const rt = await rtPromise();
      const resource = resourceForPath(rt.cfg, '/apps/guava/mcp');
      let account;
      try {
        account = await accountFromRequest(request, rt, resource, true);
      } catch (e) {
        return unauthorized(e instanceof AuthError ? e.message : 'Authentication failed.', metadataUrl(rt.cfg, resource));
      }
      const catalog = env.GUAVA_D1 ? new D1GuavaCatalog(env.GUAVA_D1) : rt.guava;
      const result = await queryGuavaCatalog({ pathname: url.pathname, searchParams: url.searchParams, catalog, account });
      return withCors(request, Response.json(result?.body ?? { error: 'not_found' }, { status: result?.status ?? 404, headers: { 'cache-control': 'no-store' } }));
    }
    const app = appForPath(url.pathname);
    const legacy = url.pathname === '/mcp';
    if (!legacy && !app) return Response.json({ error: 'not_found' }, { status: 404 });
    if (request.method === 'OPTIONS' && app) return withCors(request, new Response(null, { status: 204 }));
    if (request.method !== 'POST') {
      return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This server is stateless; use POST.' }, id: null }, { status: 405 });
    }
    const rt = await rtPromise();
    const resource = resourceForPath(rt.cfg, url.pathname);
    let account;
    try {
      account = await accountFromRequest(request, rt, resource, Boolean(app));
    } catch (e) {
      return unauthorized(e instanceof AuthError ? e.message : 'Authentication failed.', metadataUrl(rt.cfg, resource));
    }
    const base = {
      account,
      data: rt.data,
      enforcer: rt.enforcer,
      log: rt.log,
      usage: rt.usage,
      transport: 'worker' as const,
      client: () => ({ userAgent: request.headers.get('user-agent') ?? undefined }),
      guava: env.GUAVA_D1 ? new D1GuavaCatalog(env.GUAVA_D1) : rt.guava,
    };
    const server = app ? createAppServer(app.id as AppId, base, metadataUrl(rt.cfg, resource)) : createMcpServer(base);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(request);
      return app ? withCors(request, response) : response;
    } finally {
      await transport.close();
      await server.close();
    }
  },
};
