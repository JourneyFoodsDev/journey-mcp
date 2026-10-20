import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { buildRuntime } from '../src/runtime.js';
import { createMcpServer } from '../src/server.js';
import { readSecretBinding } from '../src/auth/end-user.js';
import { AuthError } from '../src/errors.js';

/** Bindings the Worker receives. Secrets Store values are objects with get(), not strings. */
export interface WorkerEnv {
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
