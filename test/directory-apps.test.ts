import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';
import request from 'supertest';
import { describe, expect, it, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHttpApp } from '../src/http.js';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { PolicyEnforcer } from '../src/policy/enforcer.js';
import { MemoryUsageStore } from '../src/policy/usage-store.js';
import { smallPolicy } from './helpers.js';
import { ApiKeyResolver } from '../src/auth/api-key.js';
import { JwtVerifier } from '../src/auth/oauth.js';
import { AuthorizationServer, type IdentityProvider } from '../src/auth/authorization-server.js';
import type { Account } from '../src/auth/account.js';
import { anonymousAccount } from '../src/auth/account.js';
import { createAppServer } from '../src/apps/server.js';
import type { GuavaCatalog, GuavaProduct } from '../src/apps/guava-catalog.js';
import { readGuavaProduct } from '../src/apps/guava-catalog.js';
import { WIDGETS } from '../src/apps/widgets.js';
import { ACCOUNT_NOTE, PAGE_NOTE, directoryAccessMessage } from '../src/policy/search-gate.js';
import { connect, MockData, account } from './helpers.js';

const ORIGIN = 'https://mcp.example.test';
const RESOURCE = `${ORIGIN}/apps/journey-foods/mcp`;
const GUAVA = `${ORIGIN}/apps/guava/mcp`;
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const MCP_HEADERS = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
const subscriber: Account = {
  id: 'acct:co-1',
  authMethod: 'oauth',
  scopes: ['journey:read'],
  tier: 'startup',
  status: 'active',
  userId: 'user-stable',
  companyId: 'co-1',
  displayName: 'Fixture User',
  email: 'fixture@example.test',
};

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

class FixtureGuava implements GuavaCatalog {
  constructor(private readonly rows: GuavaProduct[]) {}
  async search(q: { query?: string; barcode?: string; limit: number }) {
    return this.rows.filter((row) => (q.barcode ? row.barcode === q.barcode : q.query ? row.name.toLowerCase().includes(q.query.toLowerCase()) : false)).slice(0, q.limit).map(({ id, name, barcode, brand, source }) => ({ id, name, ...(barcode ? { barcode } : {}), ...(brand ? { brand } : {}), ...(source ? { source } : {}) }));
  }
  async get(id: string) {
    return this.rows.find((row) => row.id === id) ?? null;
  }
}

const fixtureProducts: GuavaProduct[] = [
  { id: 'fixture-1', name: 'Fixture granola', barcode: '0000000000000', brand: 'Fixture', source: 'test-fixture' },
  { id: 'fixture-2', name: 'Fixture oats', barcode: '1111111111111', brand: 'Fixture', source: 'test-fixture', guava_score: 1, ingredients: ['oats'], price_context: { currency: 'USD', amount: 1, note: 'fixture price' } },
  { id: 'fixture-3', name: 'Fixture tea', source: 'test-fixture' },
  { id: 'fixture-4', name: 'Fixture rice', source: 'test-fixture' },
  { id: 'fixture-5', name: 'Fixture beans', source: 'test-fixture' },
  { id: 'fixture-6', name: 'Fixture corn', source: 'test-fixture' },
];

async function session(appId: 'journey-foods' | 'guava', opts: { account?: Account; data?: MockData; guava?: GuavaCatalog; policy?: ReturnType<typeof smallPolicy> } = {}) {
  const data = opts.data ?? new MockData();
  const enforcer = new PolicyEnforcer(opts.policy ?? smallPolicy(), new MemoryUsageStore());
  const server = createAppServer(appId, { account: opts.account ?? anonymousAccount(), data, enforcer, log: silentLogger, guava: opts.guava }, `${ORIGIN}/.well-known/oauth-protected-resource${appId === 'guava' ? '/apps/guava/mcp' : '/apps/journey-foods/mcp'}`);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text?: string }[])[0]?.text ?? '';
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { ...result, json };
  };
  return { client, call, data };
}

describe('search preview', () => {
  it('caps anonymous and non-subscribed searches at 4 and lets an active subscriber through', async () => {
    const anon = await connect({ account: anonymousAccount() });
    const hidden = await anon.call('search_suppliers', { query: 'pea', limit: 10 });
    expect(hidden.structuredContent.returned).toBe(4);
    expect(hidden.structuredContent.notice).toBe(ACCOUNT_NOTE);
    expect(anon.data.calls.filter((call) => call === 'searchSuppliers')).toHaveLength(1);
    const page = await anon.call('search_suppliers', { query: 'pea', page: 2, limit: 10 });
    expect(page.structuredContent.returned).toBe(0);
    expect(page.structuredContent.notice).toBe(PAGE_NOTE);
    expect(anon.data.calls.filter((call) => call === 'searchSuppliers')).toHaveLength(1);
    const free = await connect({ account: account('free', 'acct:free') });
    expect((await free.call('search_ingredients', { query: 'Ingredient', limit: 25 })).structuredContent.returned).toBe(4);
    const canceled = await connect({ account: account('enterprise', 'acct:old', { status: 'canceled' }) });
    expect((await canceled.call('search_suppliers', { query: 'pea', limit: 8 })).structuredContent.returned).toBe(4);
    const paid = await connect({ account: account('startup', 'acct:paid', { status: 'active' }) });
    const full = await paid.call('search_suppliers', { query: 'pea', limit: 8 });
    expect(full.structuredContent.returned).toBe(8);
    expect(full.structuredContent.notice).toBeUndefined();
    const short = await anon.call('search_suppliers', { query: 'pea', region: 'nowhere', limit: 10 });
    expect(short.structuredContent.returned).toBe(0);
    expect(short.structuredContent.notice).toBeUndefined();
  });

  it('keeps directory limit copy informational', () => {
    const text = directoryAccessMessage('This account has reached its lifetime limit of 10 suppliers. Upgrade to the Startup plan in the Journey developer portal at https://dev.journeyfoods.io for higher limits. To keep going beyond that, request a custom contract at https://journeyfoods.io/contact and our team will follow up. Thank you.');
    expect(text).toContain(ACCOUNT_NOTE.replace('More results need a Journey account. ', ''));
    expect(text.toLowerCase()).not.toMatch(/upgrade|checkout|subscribe|pricing|contract|\bplan\b/);
  });
});

describe('directory apps', () => {
  it('serves Journey Foods and Guava as separate read-only tool sets with UI resources', async () => {
    const foods = await session('journey-foods');
    const guava = await session('guava', { guava: new FixtureGuava(fixtureProducts) });
    const foodTools = (await foods.client.listTools()).tools;
    const guavaTools = (await guava.client.listTools()).tools;
    expect(foodTools.map((tool) => tool.name).sort()).toEqual(['compare_suppliers', 'get_ingredient', 'get_ingredient_price', 'get_profile', 'get_supplier', 'list_price_series', 'search_ingredients', 'search_suppliers', 'verify_lab_result']);
    expect(guavaTools.map((tool) => tool.name).sort()).toEqual(['compare_products', 'get_product', 'get_profile', 'search_products']);
    for (const tool of [...foodTools, ...guavaTools]) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.openWorldHint).toBe(false);
      const schemes = (tool._meta?.securitySchemes as { type: string }[] | undefined)?.map((scheme) => scheme.type).sort();
      expect(schemes).toEqual(tool.name === 'get_profile' ? ['oauth2'] : ['noauth', 'oauth2']);
    }
    expect(foodTools.find((tool) => tool.name === 'get_ingredient_price')?._meta?.ui).toEqual({ resourceUri: 'ui://journey/price-chart.html' });
    expect(guavaTools.find((tool) => tool.name === 'get_product')?._meta?.ui).toEqual({ resourceUri: 'ui://journey/product-score.html' });
    const resources = await foods.client.listResources();
    const uris = resources.resources.map((resource) => resource.uri).sort();
    expect(uris).toEqual(['ui://journey/comparison-table.html', 'ui://journey/price-chart.html', 'ui://journey/record-card.html', 'ui://journey/result-list.html']);
    const chart = await foods.client.readResource({ uri: 'ui://journey/price-chart.html' });
    const widget = chart.contents[0] as { text?: string; mimeType?: string; _meta?: { ui?: { csp?: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[] } } } };
    expect(widget.mimeType).toBe('text/html;profile=mcp-app');
    expect(widget._meta?.ui?.csp).toEqual({ connectDomains: [], resourceDomains: [], frameDomains: [] });
    expect(widget.text).toContain('The text reply contains the same result.');
    for (const doc of Object.values(WIDGETS)) {
      expect(doc.html).not.toMatch(/https?:\/\//);
      expect(doc.html.toLowerCase()).not.toMatch(/upgrade|checkout|subscribe/);
    }
    const profile = foodTools.find((tool) => tool.name === 'get_profile');
    expect(profile?._meta).toMatchObject({ 'openai/profile': true });
    expect(profile?.outputSchema).toMatchObject({ additionalProperties: false, required: ['id'] });
  });

  it('returns fixture Guava rows without inventing a score, and says so when the catalog is absent', async () => {
    const anon = await session('guava', { guava: new FixtureGuava(fixtureProducts) });
    const listed = await anon.call('search_products', { query: 'Fixture', limit: 10 });
    expect(listed.json.returned).toBe(4);
    expect(listed.json.notice).toBe(ACCOUNT_NOTE);
    expect(listed.json.products.every((row: { source: string }) => row.source === 'test-fixture')).toBe(true);
    expect(JSON.stringify(listed.json)).not.toContain('guava_score');
    const one = await anon.call('get_product', { product_id: 'fixture-1' });
    expect(one.json.product.source).toBe('test-fixture');
    expect(one.json.product.guava_score).toBeUndefined();
    const scored = await anon.call('get_product', { product_id: 'fixture-2' });
    expect(scored.json.product.guava_score).toBe(1);
    const cmp = await anon.call('compare_products', { product_ids: ['fixture-1', 'fixture-2'] });
    expect(cmp.json.comparison.by_product.find((row: { id: string }) => row.id === 'fixture-1').guava_score).toBeNull();
    const paid = await session('guava', { account: account('startup', 'acct:g', { status: 'active' }), guava: new FixtureGuava(fixtureProducts) });
    expect((await paid.call('search_products', { query: 'Fixture', limit: 10 })).json.returned).toBe(6);
    const missing = await session('guava');
    const err = await missing.call('search_products', { query: 'oats' });
    expect(err.isError).toBe(true);
    expect(err.json.error).toBe('not_connected');
    expect(err.json.message).not.toMatch(/\d/);
    expect(readGuavaProduct({ id: 'live-1', name: 'From catalog' })).toEqual({ id: 'live-1', name: 'From catalog' });
    expect(readGuavaProduct({ id: 'live-2', name: 'From catalog', score: 'high' })?.guava_score).toBeUndefined();
  });

  it('rewrites cap errors on the directory app and still requires auth for get_profile', async () => {
    const { call } = await session('journey-foods', { account: account('free', 'acct:dir'), policy: smallPolicy() });
    for (const id of ['s1', 's2', 's3', 's4', 's5']) expect((await call('get_supplier', { supplier_id: id })).isError).toBeFalsy();
    const capped = await call('get_supplier', { supplier_id: 's6' });
    expect(capped.json.error).toBe('cap_exceeded');
    expect(capped.json.message.toLowerCase()).not.toMatch(/upgrade|checkout|subscribe|pricing|contract|\bplan\b/);
    expect(capped.json.message).toContain('https://www.journeyfoods.io/mcp');
    const anon = await session('journey-foods');
    const profile = await anon.call('get_profile', {});
    expect(profile.isError).toBe(true);
    expect(JSON.stringify(profile._meta)).toContain('mcp/www_authenticate');
    expect(profile.json?.id).toBeUndefined();
  });
});

describe('OAuth 2.1 PKCE and mixed auth', () => {
  const identity: IdentityProvider = { async authenticate() { return { type: 'account', account: subscriber }; } };
  let app: ReturnType<typeof createHttpApp>;
  let signingJwk: string;

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const jwk = { ...(await exportJWK(privateKey)), kid: 'k1', alg: 'ES256' };
    signingJwk = JSON.stringify(jwk);
    const publicJwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' };
    const cfg = loadConfig({ MCP_RESOURCE_URL: `${ORIGIN}/mcp`, OAUTH_ISSUER: ORIGIN, OAUTH_JWKS_URL: `${ORIGIN}/.well-known/jwks.json`, OPENAI_APPS_CHALLENGE: 'challenge-fixture' });
    const authServer = new AuthorizationServer({
      issuer: ORIGIN,
      signingJwk,
      identity,
      allowedResources: [`${ORIGIN}/mcp`, RESOURCE, GUAVA],
    });
    app = createHttpApp({
      cfg,
      log: silentLogger,
      data: new MockData(),
      enforcer: new PolicyEnforcer(smallPolicy(), new MemoryUsageStore()),
      verifier: new JwtVerifier(cfg.oauth, RESOURCE, createLocalJWKSet({ keys: [publicJwk] }) as never),
      keys: new ApiKeyResolver(undefined, silentLogger),
      authServer,
    });
  });

  async function login(resource = RESOURCE) {
    const client = await request(app).post('/oauth/register').send({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', client_name: 'ChatGPT' });
    expect(client.status).toBe(201);
    const { verifier, challenge } = pkce();
    const auth = await request(app).get('/oauth/authorize').query({
      response_type: 'code',
      client_id: client.body.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource,
      state: 'state-1',
      scope: 'journey:read openid profile',
    });
    expect(auth.status).toBe(302);
    const location = new URL(auth.headers.location);
    expect(location.searchParams.get('iss')).toBe(ORIGIN);
    expect(location.searchParams.get('state')).toBe('state-1');
    const token = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code: location.searchParams.get('code'),
      redirect_uri: REDIRECT,
      client_id: client.body.client_id,
      code_verifier: verifier,
      resource,
    });
    expect(token.status).toBe(200);
    const again = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code: location.searchParams.get('code'),
      redirect_uri: REDIRECT,
      client_id: client.body.client_id,
      code_verifier: verifier,
      resource,
    });
    expect(again.status).toBe(400);
    return { access: token.body.access_token as string, refresh: token.body.refresh_token as string, clientId: client.body.client_id as string };
  }

  it('publishes protected-resource metadata, S256, and the challenge token', async () => {
    const prm = await request(app).get('/.well-known/oauth-protected-resource/apps/journey-foods/mcp');
    expect(prm.body).toMatchObject({ resource: RESOURCE, authorization_servers: [ORIGIN], resource_name: 'Journey Foods', scopes_supported: ['journey:read'] });
    const guava = await request(app).get('/.well-known/oauth-protected-resource/apps/guava/mcp');
    expect(guava.body.resource_name).toBe('Guava by Journey');
    const as = await request(app).get('/.well-known/oauth-authorization-server');
    expect(as.body.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.body.client_id_metadata_document_supported).toBe(true);
    expect(as.body.authorization_response_iss_parameter_supported).toBe(true);
    const challenge = await request(app).get('/.well-known/openai-apps-challenge');
    expect(challenge.text).toBe('challenge-fixture');
  });

  it('rejects plain PKCE and accepts S256, then enforces the search gate by identity', async () => {
    const client = await request(app).post('/oauth/register').send({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
    const plain = await request(app).get('/oauth/authorize').query({
      response_type: 'code', client_id: client.body.client_id, redirect_uri: REDIRECT, code_challenge: 'abc', code_challenge_method: 'plain', resource: RESOURCE, state: 's',
    });
    expect(new URL(plain.headers.location).searchParams.get('error')).toBe('invalid_request');
    const { verifier, challenge } = pkce();
    const auth = await request(app).get('/oauth/authorize').query({
      response_type: 'code', client_id: client.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource: RESOURCE, state: 's2',
    });
    const code = new URL(auth.headers.location).searchParams.get('code');
    const bad = await request(app).post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.body.client_id, code_verifier: 'x'.repeat(50), resource: RESOURCE });
    expect(bad.status).toBe(400);
    const { access } = await login();
    const anon = await request(app).post('/apps/journey-foods/mcp').set(MCP_HEADERS).send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_suppliers', arguments: { query: 'pea', limit: 10 } } });
    expect(anon.body.result.structuredContent.returned).toBe(4);
    expect(anon.body.result.structuredContent.notice).toBe(ACCOUNT_NOTE);
    const signed = await request(app).post('/apps/journey-foods/mcp').set(MCP_HEADERS).set('Authorization', `Bearer ${access}`).send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_suppliers', arguments: { query: 'pea', limit: 10 } } });
    expect(signed.body.result.structuredContent.returned).toBe(10);
    const profile = await request(app).post('/apps/journey-foods/mcp').set(MCP_HEADERS).set('Authorization', `Bearer ${access}`).send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_profile', arguments: {} } });
    expect(profile.body.result.structuredContent).toEqual({ id: 'user-stable', name: 'Fixture User', email: 'fixture@example.test' });
    const again = await request(app).post('/apps/journey-foods/mcp').set(MCP_HEADERS).set('Authorization', `Bearer ${access}`).send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_profile', arguments: {} } });
    expect(again.body.result.structuredContent.id).toBe('user-stable');
    const key = await request(app).post('/mcp').set(MCP_HEADERS).set('x-api-key', 'local-test-key').send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_supplier', arguments: { supplier_id: 's1' } } });
    expect(key.body.result.structuredContent.supplier.id).toBe('s1');
    const wrongAudience = await login(GUAVA);
    const rejected = await request(app).post('/apps/journey-foods/mcp').set(MCP_HEADERS).set('Authorization', `Bearer ${wrongAudience.access}`).send({ jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} });
    expect(rejected.status).toBe(401);
  });

  it('refuses to sign a user in when no identity provider is configured', async () => {
    const as = new AuthorizationServer({ issuer: ORIGIN, signingJwk, allowedResources: [RESOURCE] });
    const registered = await as.register({ redirect_uris: [REDIRECT] });
    const clientId = (registered.body as { client_id: string }).client_id;
    const result = await as.authorize(new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: RESOURCE, state: 's' }));
    expect(result.location).toContain('temporarily_unavailable');
    expect(result.location).toContain('Identity+provider+is+not+configured');
  });
});

describe('submission packages', () => {
  for (const name of ['journey-foods', 'guava']) {
    it(`${name} has a manifest, five positive cases, and three negative cases`, () => {
      const dir = `apps/${name}`;
      const plugin = JSON.parse(readFileSync(`${dir}/plugin.json`, 'utf8'));
      const mcp = JSON.parse(readFileSync(`${dir}/mcp.json`, 'utf8'));
      const cases = JSON.parse(readFileSync(`${dir}/test-cases.json`, 'utf8'));
      expect(plugin.mcp_server_url).toMatch(/^https:\/\/mcp\.journeyfoods\.io\/apps\//);
      expect(plugin.auth.pkce).toBe('S256');
      expect(JSON.stringify(mcp)).toContain(plugin.mcp_server_url);
      expect(cases.positive).toHaveLength(5);
      expect(cases.negative).toHaveLength(3);
      const blob = JSON.stringify({ plugin, cases }).toLowerCase();
      expect(blob).not.toMatch(/checkout|upgrade now|subscribe now/);
      expect(readFileSync(`${dir}/README.md`, 'utf8')).toMatch(/privacy|logo|demo account|openai-apps-challenge|walkthrough/i);
      expect(readFileSync(`${dir}/RELEASE_NOTES.md`, 'utf8').length).toBeGreaterThan(40);
    });
  }
});
