import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { createHttpApp } from '../src/http.js';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { PolicyEnforcer } from '../src/policy/enforcer.js';
import { DEFAULT_POLICY } from '../src/policy/policy.js';
import { MemoryUsageStore } from '../src/policy/usage-store.js';
import { ApiKeyResolver } from '../src/auth/api-key.js';
import { JwtVerifier } from '../src/auth/oauth.js';
import { FULL_CATALOG_CLAIM } from '../src/auth/oauth.js';
import { protectedResourceMetadata } from '../src/auth/oauth.js';
import { APP_OAUTH_SCOPES } from '../src/auth/oauth.js';
import { loadWorkerConfig } from '../worker/index.js';
import { MockData, connect, account } from './helpers.js';
import worker from '../worker/index.js';

const ISSUER = 'https://dev-ssk71qghv0z5qp7s.us.auth0.com/';
const FOODS = 'https://mcp.journeyfoods.io/apps/journey-foods/mcp';
const GUAVA = 'https://mcp.journeyfoods.io/apps/guava/mcp';
const MCP_HEADERS = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };

describe('Auth0 resource server', () => {
  let sign: (claims: Record<string, unknown>, opts?: { aud?: string; iss?: string; alg?: 'RS256' | 'ES256' }) => Promise<string>;
  let app: ReturnType<typeof createHttpApp>;

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: 'auth0-test', alg: 'RS256', use: 'sig' };
    const { privateKey: ecKey } = await generateKeyPair('ES256', { extractable: true });
    sign = (claims, opts = {}) => {
      const alg = opts.alg ?? 'RS256';
      const key = alg === 'RS256' ? privateKey : ecKey;
      return new SignJWT(claims)
        .setProtectedHeader({ alg, kid: 'auth0-test' })
        .setIssuer(opts.iss ?? ISSUER)
        .setAudience(opts.aud ?? FOODS)
        .setSubject('auth0|fixture-user')
        .setExpirationTime('5m')
        .sign(key);
    };
    const cfg = loadConfig({
      MCP_RESOURCE_URL: 'https://mcp.journeyfoods.io/mcp',
      OAUTH_ISSUER: ISSUER,
      OAUTH_JWKS_URL: 'https://dev-ssk71qghv0z5qp7s.us.auth0.com/.well-known/jwks.json',
      OAUTH_JWT_ALGS: 'RS256',
    });
    app = createHttpApp({
      cfg,
      log: silentLogger,
      data: new MockData(),
      enforcer: new PolicyEnforcer(DEFAULT_POLICY, new MemoryUsageStore()),
      keys: new ApiKeyResolver(undefined, silentLogger),
      verifier: new JwtVerifier(cfg.oauth, FOODS, createLocalJWKSet({ keys: [jwk] }) as never),
    });
  });

  it('keeps the Auth0 issuer slash and advertises it for each app', async () => {
    const cfg = await loadWorkerConfig({
      OAUTH_ISSUER: ISSUER,
      OAUTH_JWKS_URL: 'https://dev-ssk71qghv0z5qp7s.us.auth0.com/.well-known/jwks.json',
      OAUTH_JWT_ALGS: 'RS256',
      MCP_RESOURCE: 'https://mcp.journeyfoods.io/mcp',
    });
    expect(cfg.oauth.issuer).toBe(ISSUER);
    expect(cfg.oauth.jwksUrl).toBe('https://dev-ssk71qghv0z5qp7s.us.auth0.com/.well-known/jwks.json');
    expect(cfg.oauth.algorithms).toEqual(['RS256']);
    expect(protectedResourceMetadata(cfg, { resource: FOODS, name: 'Journey Foods', scopes: APP_OAUTH_SCOPES })).toMatchObject({
      authorization_servers: [ISSUER],
      resource: FOODS,
      scopes_supported: ['catalog:read', 'profile:read', 'offline_access'],
    });
    expect(protectedResourceMetadata(cfg, { resource: GUAVA, scopes: APP_OAUTH_SCOPES }).authorization_servers).toEqual([ISSUER]);
  });

  it('rejects the wrong audience, a slash-stripped issuer, and a non-RS256 token', async () => {
    const good = await sign({ scope: 'catalog:read profile:read' });
    const wrongApp = await sign({ scope: 'catalog:read profile:read' }, { aud: GUAVA });
    const wrongIss = await sign({ scope: 'catalog:read' }, { iss: 'https://dev-ssk71qghv0z5qp7s.us.auth0.com' });
    const es256 = await sign({ scope: 'catalog:read' }, { alg: 'ES256' });
    const call = (token: string) => request(app).post('/apps/journey-foods/mcp').set(MCP_HEADERS).set('Authorization', `Bearer ${token}`).send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect((await call(good)).status).toBe(200);
    expect((await call(wrongApp)).status).toBe(401);
    expect((await call(wrongIss)).status).toBe(401);
    expect((await call(es256)).status).toBe(401);
    const noScope = await sign({ scope: 'openid' });
    const denied = await call(noScope);
    expect(denied.status).toBe(403);
    expect(denied.headers['www-authenticate']).toContain('insufficient_scope');
  });

  it('keeps a signed-in caller on 4 results until the full-catalog claim is true', async () => {
    const preview = await sign({ scope: 'catalog:read profile:read', journey_tier: 'startup', journey_status: 'active' });
    const full = await sign({ scope: 'catalog:read profile:read', [FULL_CATALOG_CLAIM]: true });
    const search = (token: string) => request(app).post('/apps/journey-foods/mcp').set(MCP_HEADERS).set('Authorization', `Bearer ${token}`).send({
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_suppliers', arguments: { query: 'pea', limit: 10 } },
    });
    const limited = await search(preview);
    expect(limited.body.result.structuredContent.returned).toBe(4);
    const opened = await search(full);
    expect(opened.body.result.structuredContent.returned).toBe(10);
    const profileOnly = await sign({ scope: 'profile:read', [FULL_CATALOG_CLAIM]: true });
    const blocked = await search(profileOnly);
    expect(blocked.body.result.isError).toBe(true);
    expect(JSON.stringify(blocked.body.result._meta)).toContain('catalog:read');
    const profile = await request(app).post('/apps/journey-foods/mcp').set(MCP_HEADERS).set('Authorization', `Bearer ${profileOnly}`).send({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_profile', arguments: {} },
    });
    expect(profile.body.result.isError).toBeFalsy();
    expect(profile.body.result.structuredContent.id).toBe('auth0|fixture-user');
  });

  it('does not treat an OAuth tier claim as full catalog access', async () => {
    const { call } = await connect({ account: account('enterprise', 'acct:oauth', { authMethod: 'oauth', status: 'active', scopes: ['catalog:read', 'profile:read'] }) });
    const result = await call('search_suppliers', { query: 'pea', limit: 8 });
    expect(result.structuredContent.returned).toBe(4);
    const opened = await connect({ account: account(null, 'acct:open', { authMethod: 'oauth', scopes: ['catalog:read'], fullCatalogAccess: true }) });
    expect((await opened.call('search_suppliers', { query: 'pea', limit: 8 })).structuredContent.returned).toBe(8);
  });

  it('serves Auth0 in protected-resource metadata when the Worker env is set', async () => {
    const res = await worker.fetch(new Request('https://mcp.journeyfoods.io/.well-known/oauth-protected-resource/apps/guava/mcp'), {
      OAUTH_ISSUER: ISSUER,
      OAUTH_JWKS_URL: 'https://dev-ssk71qghv0z5qp7s.us.auth0.com/.well-known/jwks.json',
      OAUTH_JWT_ALGS: 'RS256',
      MCP_RESOURCE: 'https://mcp.journeyfoods.io/mcp',
    });
    const body = await res.json() as { authorization_servers?: string[]; scopes_supported?: string[]; resource?: string };
    expect(body.authorization_servers).toEqual([ISSUER]);
    expect(body.resource).toBe(GUAVA);
    expect(body.scopes_supported).toEqual(['catalog:read', 'profile:read', 'offline_access']);
  });
});
