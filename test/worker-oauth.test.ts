import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import worker from '../worker/index.js';
import { redirectUriAllowed } from '../worker/oauth.js';

/** In-memory stand-in for the OAUTH_KV namespace. */
class MemoryKV {
  store = new Map<string, { value: string; expires?: number }>();
  async get(key: string, opts?: { type?: string } | string) {
    const hit = this.store.get(key);
    if (!hit || (hit.expires && hit.expires < Date.now())) return null;
    const type = typeof opts === 'string' ? opts : opts?.type;
    return type === 'json' ? JSON.parse(hit.value) : hit.value;
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number; expiration?: number }) {
    const expires = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : opts?.expiration ? opts.expiration * 1000 : undefined;
    this.store.set(key, { value, expires });
  }
  async delete(key: string) {
    this.store.delete(key);
  }
  async list(opts?: { prefix?: string; limit?: number; cursor?: string }) {
    const keys = [...this.store.keys()].filter((k) => !opts?.prefix || k.startsWith(opts.prefix)).map((name) => ({ name }));
    return { keys, list_complete: true, cursor: '' };
  }
}

const ORIGIN = 'https://mcp.journeyfoods.io';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

function makeEnv() {
  return {
    MCP_RESOURCE: `${ORIGIN}/mcp`,
    JOURNEY_PRICE_API_BASE: 'https://price.journeyfoods.io',
    OAUTH_KV: new MemoryKV(),
  };
}

const seenKeys: string[] = [];
function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    if (h.get('x-api-key')) seenKeys.push(h.get('x-api-key')!);
    if (url.includes('/api/v1/account')) return new Response('{}', { status: 404 });
    return new Response('{"error":"nf"}', { status: 404 });
  }) as typeof fetch;
}
afterEach(() => {
  seenKeys.length = 0;
  Reflect.deleteProperty(globalThis, 'fetch');
});

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const call = (req: Request, env: object) => worker.fetch(req, env as never, ctx);

function cookiesFrom(res: Response): string {
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function register(env: object, redirect = CALLBACK) {
  const res = await call(new Request(`${ORIGIN}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  }), env);
  return { res, body: (await res.json()) as { client_id?: string; error?: string } };
}

async function authorize(env: object, apiKey: string) {
  const { body: client } = await register(env);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id!, redirect_uri: CALLBACK, state: 'st1', code_challenge: challenge, code_challenge_method: 'S256', resource: `${ORIGIN}/mcp` });
  const page = await call(new Request(`${ORIGIN}/authorize?${q}`), env);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('Journey API key');
  expect(html).toContain('#395efa');
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1];
  const cookie = cookiesFrom(page);
  const form = new URLSearchParams({ handle, api_key: apiKey, decision: 'approve', client_name: 'Claude', redirect_host: 'claude.ai' });
  const done = await call(new Request(`${ORIGIN}/authorize?${q}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: form }), env);
  return { done, client, verifier, q, cookie, handle };
}

async function exchange(env: object, body: Record<string, string>) {
  const res = await call(new Request(`${ORIGIN}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }), env);
  return { res, json: (await res.json()) as Record<string, string> };
}

const listTools = (headers: Record<string, string>) => new Request(`${ORIGIN}/mcp`, {
  method: 'POST',
  headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
});

describe('remote MCP OAuth (claude.ai custom connector)', () => {
  it('returns 401 with resource_metadata on /mcp when no credential is sent', async () => {
    const res = await call(listTools({}), makeEnv());
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    expect(res.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate');
  });

  it('serves protected-resource and authorization-server metadata', async () => {
    const env = makeEnv();
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const prm = await call(new Request(`${ORIGIN}${path}`), env);
      expect(prm.status).toBe(200);
      expect(await prm.json()).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    }
    const as = await call(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), env);
    expect(as.status).toBe(200);
    const meta = (await as.json()) as Record<string, unknown>;
    expect(meta).toMatchObject({ issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/authorize`, token_endpoint: `${ORIGIN}/token`, registration_endpoint: `${ORIGIN}/register` });
    expect(meta.code_challenge_methods_supported).toContain('S256');
  });

  it('answers CORS preflight on /mcp and /token', async () => {
    for (const path of ['/mcp', '/token', '/register']) {
      const res = await call(new Request(`${ORIGIN}${path}`, { method: 'OPTIONS', headers: { origin: 'https://claude.ai', 'access-control-request-method': 'POST' } }), makeEnv());
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-headers')).toMatch(/authorization/i);
      expect(res.headers.get('access-control-allow-headers')).toMatch(/x-api-key/i);
    }
  });

  it('registers clients with https or loopback redirect URIs only', async () => {
    const ok = await register(makeEnv());
    expect(ok.res.status).toBe(201);
    expect(ok.body.client_id).toBeTruthy();
    const bad = await register(makeEnv(), 'http://evil.example/cb');
    expect(bad.res.status).toBe(400);
    expect(redirectUriAllowed('https://claude.com/api/mcp/auth_callback')).toBe(true);
    expect(redirectUriAllowed('http://localhost:33418/callback')).toBe(true);
    expect(redirectUriAllowed('javascript:alert(1)')).toBe(false);
  });

  it('runs the code + PKCE flow, then the bearer token lists tools with the pasted key', async () => {
    installFetch();
    const env = makeEnv();
    const { done, client, verifier } = await authorize(env, 'user-journey-key');
    expect(done.status).toBe(302);
    const loc = new URL(done.headers.get('location')!);
    expect(`${loc.origin}${loc.pathname}`).toBe(CALLBACK);
    expect(loc.searchParams.get('state')).toBe('st1');
    const code = loc.searchParams.get('code')!;

    const wrong = await exchange(env, { grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: client.client_id!, code_verifier: 'x'.repeat(50) });
    expect(wrong.res.status).toBe(400);

    // A failed verifier burns nothing usable for an attacker; run a fresh flow for the real exchange.
    const second = await authorize(env, 'user-journey-key');
    const code2 = new URL(second.done.headers.get('location')!).searchParams.get('code')!;
    const tok = await exchange(env, { grant_type: 'authorization_code', code: code2, redirect_uri: CALLBACK, client_id: second.client.client_id!, code_verifier: second.verifier, resource: `${ORIGIN}/mcp` });
    expect(tok.res.status).toBe(200);
    expect(tok.json.token_type).toMatch(/bearer/i);
    expect(tok.json.access_token).toBeTruthy();
    expect(tok.json.refresh_token).toBeTruthy();
    expect(JSON.stringify(tok.json)).not.toContain('user-journey-key');
    // The key is not stored in plaintext in KV.
    expect(JSON.stringify([...env.OAUTH_KV.store.values()])).not.toContain('user-journey-key');

    const res = await call(listTools({ authorization: `Bearer ${tok.json.access_token}` }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { tools?: { name: string }[] } };
    expect(body.result?.tools?.length).toBeGreaterThan(0);

    const bad = await call(listTools({ authorization: 'Bearer nope:nope:nope' }), env);
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('resource_metadata');

    const refreshed = await exchange(env, { grant_type: 'refresh_token', refresh_token: tok.json.refresh_token, client_id: second.client.client_id! });
    expect(refreshed.res.status).toBe(200);
    const again = await call(listTools({ authorization: `Bearer ${refreshed.json.access_token}` }), env);
    expect(again.status).toBe(200);
    void verifier;
  });

  it('re-shows the sign-in page when no key is pasted, and cancel returns access_denied', async () => {
    const env = makeEnv();
    const empty = await authorize(env, '');
    expect(empty.done.status).toBe(400);
    expect(await empty.done.text()).toContain('Paste your Journey API key');
    const deny = await call(new Request(`${ORIGIN}/authorize`, { method: 'POST', headers: { cookie: empty.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ handle: empty.handle, decision: 'deny' }) }), env);
    expect(deny.status).toBe(302);
    expect(new URL(deny.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
  });

  it('keeps x-api-key working unchanged with OAuth enabled', async () => {
    installFetch();
    const res = await call(listTools({ 'x-api-key': 'claude-code-key' }), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { tools?: unknown[] } };
    expect(body.result?.tools?.length).toBeGreaterThan(0);
    const blank = await call(listTools({ 'x-api-key': '  ' }), makeEnv());
    expect(blank.status).toBe(401);
  });
});
