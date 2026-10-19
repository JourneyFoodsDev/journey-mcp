import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';
import { createHttpApp } from '../src/http.js';
import { loadConfig } from '../src/config.js';
import { silentLogger, createLogger } from '../src/logger.js';
import { PolicyEnforcer } from '../src/policy/enforcer.js';
import { DEFAULT_POLICY } from '../src/policy/policy.js';
import { MemoryUsageStore } from '../src/policy/usage-store.js';
import { ApiKeyResolver } from '../src/auth/api-key.js';
import { JwtVerifier, IntrospectionVerifier } from '../src/auth/oauth.js';
import { MockData } from './helpers.js';

const RESOURCE = 'https://mcp.example.test/mcp';
const ISSUER = 'https://auth.example.test';
const cfg = loadConfig({ MCP_RESOURCE_URL: RESOURCE, OAUTH_ISSUER: ISSUER, OAUTH_JWKS_URL: 'https://auth.example.test/jwks' });
const MCP_HEADERS = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
const init = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } };

let sign: (claims: Record<string, unknown>, aud?: string) => Promise<string>;
let app: ReturnType<typeof createHttpApp>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  sign = (claims, aud = RESOURCE) => new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(ISSUER).setAudience(aud).setSubject('user-1').setExpirationTime('5m').sign(privateKey);
  app = createHttpApp({
    cfg,
    log: silentLogger,
    data: new MockData(),
    enforcer: new PolicyEnforcer(DEFAULT_POLICY, new MemoryUsageStore()),
    verifier: new JwtVerifier(cfg.oauth, RESOURCE, jwks as never),
    keys: new ApiKeyResolver(undefined, silentLogger),
  });
});

describe('remote server auth (MCP authorization spec)', () => {
  it('serves RFC 9728 protected resource metadata', async () => {
    const r = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    expect(r.body).toMatchObject({ resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: ['journey:read'] });
  });
  it('challenges unauthenticated requests with WWW-Authenticate and resource_metadata', async () => {
    const r = await request(app).post('/mcp').set(MCP_HEADERS).send(init);
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toContain('resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"');
    expect(r.headers['www-authenticate']).toContain('scope="journey:read"');
  });
  it('accepts a valid OAuth token for this resource and lists tools', async () => {
    const token = await sign({ scope: 'journey:read offline_access', journey_account_id: 'c-42', journey_tier: 'startup' });
    const r = await request(app).post('/mcp').set(MCP_HEADERS).set('Authorization', `Bearer ${token}`).send(listTools);
    expect(r.status).toBe(200);
    expect(r.body.result.tools).toHaveLength(10);
  });
  it('rejects tokens issued for another resource (audience binding)', async () => {
    const token = await sign({ scope: 'journey:read' }, 'https://other.example.test/mcp');
    const r = await request(app).post('/mcp').set(MCP_HEADERS).set('Authorization', `Bearer ${token}`).send(listTools);
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toContain('error="invalid_token"');
  });
  it('rejects tokens without the journey:read scope with 403 insufficient_scope', async () => {
    const token = await sign({ scope: 'profile' });
    const r = await request(app).post('/mcp').set(MCP_HEADERS).set('Authorization', `Bearer ${token}`).send(listTools);
    expect(r.status).toBe(403);
    expect(r.headers['www-authenticate']).toContain('insufficient_scope');
  });
  it('accepts the x-api-key fallback and calls a tool', async () => {
    const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_supplier', arguments: { supplier_id: 's1' } } };
    const r = await request(app).post('/mcp').set(MCP_HEADERS).set('x-api-key', 'local-test-key').send(call);
    expect(r.status).toBe(200);
    expect(r.body.result.structuredContent.supplier.id).toBe('s1');
  });
  it('rejects GET on the stateless endpoint', async () => {
    const r = await request(app).get('/mcp');
    expect(r.status).toBe(405);
  });
});

describe('introspection verifier', () => {
  const fetchWith = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  const ocfg = { ...cfg.oauth, introspectionUrl: 'https://auth.example.test/introspect' };
  it('maps an active token to the account and tier', async () => {
    const v = new IntrospectionVerifier(ocfg, RESOURCE, fetchWith({ active: true, aud: RESOURCE, iss: ISSUER, sub: 'u', journey_account_id: 'c-1', journey_tier: 'enterprise', scope: 'journey:read' }));
    expect(await v.verify('t')).toMatchObject({ id: 'acct:c-1', tier: 'enterprise', authMethod: 'oauth' });
  });
  it('rejects inactive tokens and wrong audiences', async () => {
    await expect(new IntrospectionVerifier(ocfg, RESOURCE, fetchWith({ active: false })).verify('t')).rejects.toThrow(/not active/);
    await expect(new IntrospectionVerifier(ocfg, RESOURCE, fetchWith({ active: true, aud: 'https://x', scope: 'journey:read' })).verify('t')).rejects.toThrow(/not issued/);
  });
});

describe('api key resolver', () => {
  it('reads account and tier from the Journey lookup endpoint', async () => {
    const f = (async () => new Response(JSON.stringify({ account_id: 'c-9', tier: 'pro' }), { status: 200 })) as unknown as typeof fetch;
    const a = await new ApiKeyResolver('https://lookup.example.test', silentLogger, f).resolve('k');
    expect(a).toMatchObject({ id: 'acct:c-9', tier: 'pro' });
  });
  it('falls back to the most restrictive tier when no lookup is configured', async () => {
    const a = await new ApiKeyResolver(undefined, silentLogger).resolve('k');
    expect(a.tier).toBeNull();
    expect(a.id).toMatch(/^key:[0-9a-f]{16}$/);
  });
  it('rejects revoked keys', async () => {
    const f = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    await expect(new ApiKeyResolver('https://lookup.example.test', silentLogger, f).resolve('k')).rejects.toThrow(/invalid or revoked/);
  });
});

describe('logging', () => {
  it('redacts secret-looking fields', () => {
    const lines: string[] = [];
    createLogger('info', (l) => lines.push(l)).info('x', { apiKey: 'abc', nested: { authorization: 'Bearer t' }, tool: 'get_supplier' });
    expect(lines[0]).not.toContain('abc');
    expect(lines[0]).not.toContain('Bearer t');
    expect(lines[0]).toContain('get_supplier');
  });
});
