import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHttpApp } from '../src/http.js';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { PolicyEnforcer } from '../src/policy/enforcer.js';
import { DEFAULT_POLICY } from '../src/policy/policy.js';
import { MemoryUsageStore } from '../src/policy/usage-store.js';
import { ApiKeyResolver } from '../src/auth/api-key.js';
import { MockData } from './helpers.js';
import worker, { AccountLedger, JourneyMcp } from '../worker/index.js';

/** Non-HTML API responses. Matches the passive-scan fix exactly. */
const API_CSP = "default-src 'none'; frame-ancestors 'none'";
/**
 * Express's built-in unmatched-route page is the only HTML this server writes.
 * It is a static error document: no scripts, styles, images, or subresources.
 * base-uri and form-action do not fall back to default-src, so the document
 * policy names them. The page text still renders.
 */
const HTML_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const MCP_HEADERS = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

function headerValue(source: { get?(name: string): string | null } | Record<string, string | string[] | undefined>, name: string): string | null {
  if (typeof (source as { get?: unknown }).get === 'function') {
    return (source as { get(name: string): string | null }).get(name);
  }
  const raw = (source as Record<string, string | string[] | undefined>)[name.toLowerCase()];
  if (Array.isArray(raw)) return raw.join(', ');
  return raw ?? null;
}

function expectCommonHeaders(source: { get?(name: string): string | null } | Record<string, string | string[] | undefined>) {
  expect(headerValue(source, 'x-content-type-options')).toBe('nosniff');
  expect(headerValue(source, 'x-frame-options')).toBe('DENY');
  expect(headerValue(source, 'referrer-policy')).toBe('no-referrer');
  expect(headerValue(source, 'access-control-allow-origin')).toBeNull();
}

function expectApiHeaders(source: { get?(name: string): string | null } | Record<string, string | string[] | undefined>) {
  expectCommonHeaders(source);
  expect(headerValue(source, 'content-security-policy')).toBe(API_CSP);
}

function httpApp(env: Record<string, string> = {}) {
  const cfg = loadConfig({ MCP_RESOURCE_URL: 'https://mcp.example.test/mcp', ...env });
  return createHttpApp({
    cfg,
    log: silentLogger,
    data: new MockData(),
    enforcer: new PolicyEnforcer(DEFAULT_POLICY, new MemoryUsageStore()),
    keys: new ApiKeyResolver(undefined, silentLogger),
  });
}

describe('security headers on every HTTP response', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('Express HTTP server', () => {
    const app = httpApp();

    it('sets the API policy on JSON routes such as /healthz', async () => {
      const res = await request(app).get('/healthz');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({ ok: true });
      expectApiHeaders(res.headers);
    });

    it('keeps OAuth protected-resource metadata JSON and adds the API policy', async () => {
      const res = await request(app).get('/.well-known/oauth-protected-resource');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.resource).toBe('https://mcp.example.test/mcp');
      expectApiHeaders(res.headers);
    });

    it('keeps the bearer challenge and adds the API policy', async () => {
      const res = await request(app).post('/mcp').set(MCP_HEADERS).send(listTools);
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toContain('Bearer');
      expect(res.body).toMatchObject({ error: 'missing_credentials' });
      expectApiHeaders(res.headers);
    });

    it('does not change a successful tools/list response', async () => {
      const res = await request(app).post('/mcp').set(MCP_HEADERS).set('x-api-key', 'local-test-key').send(listTools);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.result.tools).toHaveLength(10);
      expectApiHeaders(res.headers);
    });

    it('keeps method-not-allowed on the stateless endpoint', async () => {
      const res = await request(app).get('/mcp');
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe('POST');
      expect(res.body.error.code).toBe(-32000);
      expectApiHeaders(res.headers);
    });

    it('still rejects a browser origin that is not on the allow list', async () => {
      const strict = httpApp({ MCP_ALLOWED_ORIGINS: 'https://app.example.test' });
      const blocked = await request(strict).post('/mcp').set(MCP_HEADERS).set('Origin', 'https://evil.example.test').send(listTools);
      expect(blocked.status).toBe(403);
      expect(blocked.body).toEqual({ error: 'forbidden_origin' });
      expectApiHeaders(blocked.headers);
      const allowedOrigin = await request(strict).post('/mcp').set(MCP_HEADERS).set('Origin', 'https://app.example.test').send(listTools);
      expect(allowedOrigin.status).toBe(401);
      expectApiHeaders(allowedOrigin.headers);
    });

    it('uses the document policy for the HTML unmatched-route page without removing its text', async () => {
      const res = await request(app).get('/does-not-exist').set('Accept', 'text/html');
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain('<title>Error</title>');
      expect(res.text).toContain('Cannot GET /does-not-exist');
      expect(res.text).not.toContain('<script');
      expectCommonHeaders(res.headers);
      expect(res.headers['content-security-policy']).toBe(HTML_CSP);
    });
  });

  describe('hosted Worker (mcp.journeyfoods.io)', () => {
    it('sets the API policy on the public discovery response', async () => {
      const res = await worker.fetch(new Request('https://mcp.journeyfoods.io/'), {});
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      expect(await res.json()).toMatchObject({ name: 'Journey AI', mcp: 'https://mcp.journeyfoods.io/mcp', auth: ['api_key'] });
      expectApiHeaders(res.headers);
    });

    it('sets the API policy on a 401 without dropping WWW-Authenticate', async () => {
      const res = await worker.fetch(new Request('https://mcp.journeyfoods.io/mcp', { method: 'POST', body: '{}' }), {});
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('price.journeyfoods.io');
      expect(await res.json()).toMatchObject({ error: { code: -32001 } });
      expectApiHeaders(res.headers);
    });

    it('sets the API policy on not-found and method-not-allowed', async () => {
      const missing = await worker.fetch(new Request('https://mcp.journeyfoods.io/data/v1/jai/index'), {});
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: 'not_found' });
      expectApiHeaders(missing.headers);
      const method = await worker.fetch(new Request('https://mcp.journeyfoods.io/mcp', { method: 'GET' }), {});
      expect(method.status).toBe(405);
      expect(await method.json()).toMatchObject({ error: { code: -32000 } });
      expectApiHeaders(method.headers);
    });

    it('sets the API policy on a JSON-RPC tools/list and still returns the tools', async () => {
      globalThis.fetch = (async () => new Response('{}', { status: 404 })) as typeof fetch;
      const res = await worker.fetch(new Request('https://mcp.journeyfoods.io/mcp', {
        method: 'POST',
        headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'x-api-key': 'caller-key' },
        body: JSON.stringify(listTools),
      }), {});
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      const body = await res.json() as { result?: { tools?: unknown[] } };
      expect(body.result?.tools).toHaveLength(10);
      expectApiHeaders(res.headers);
    });

    it('sets the API policy on durable object responses that are not publicly routed', async () => {
      const mcp = await new JourneyMcp({}, {}).fetch(new Request('https://do.internal/'));
      expect(mcp.status).toBe(501);
      expect(await mcp.json()).toEqual({ error: 'not_served_here' });
      expectApiHeaders(mcp.headers);
      const ledger = await new AccountLedger({}, {}).fetch(new Request('https://do.internal/'));
      expect(ledger.status).toBe(501);
      expectApiHeaders(ledger.headers);
    });
  });
});
