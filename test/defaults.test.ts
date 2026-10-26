import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RestJourneyData } from '../src/api/rest-adapter.js';
import type { Account } from '../src/auth/account.js';
import {
  DEFAULT_DEV_API_BASE_URL,
  DEFAULT_PRICE_API_BASE_URL,
  DEV_API_KEY_URL,
  HOSTED_MCP_URL,
  PRICE_API_KEY_URL,
  loadConfig,
} from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { PolicyEnforcer } from '../src/policy/enforcer.js';
import { DEFAULT_POLICY } from '../src/policy/policy.js';
import { MemoryUsageStore } from '../src/policy/usage-store.js';
import { createMcpServer } from '../src/server.js';

type Seen = { url: URL; headers: Record<string, string> };
function mockFetch(routes: Record<string, unknown>, seen: Seen[] = []) {
  return (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const key = url.host + url.pathname;
    if (!(key in routes)) return new Response('{"error":"nf"}', { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const priceRoutes = {
  'price.journeyfoods.io/api/v1/commodities': { data: [{ symbol: 'COCOA', name: 'Cocoa', unit: 'USD/mt', currency: 'USD' }] },
  'price.journeyfoods.io/api/v1/commodities/COCOA/quote': { data: { price: 8123.4, date: '2026-09-01', changePct: -2.1 } },
  'price.journeyfoods.io/api/v1/commodities/COCOA/history': { data: [{ date: '2026-08-01', price: 8300 }] },
};

describe('loadConfig defaults and key fallbacks', () => {
  it('defaults the developer and price bases and does not invent a supplier base', () => {
    const cfg = loadConfig({});
    expect(cfg.apiBaseUrl).toBe(DEFAULT_DEV_API_BASE_URL);
    expect(cfg.priceApiBaseUrl).toBe(DEFAULT_PRICE_API_BASE_URL);
    expect(cfg.supplierApiBaseUrl).toBeUndefined();
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.priceApiKey).toBeUndefined();
    expect(cfg.priceAccountBaseUrl).toBeUndefined();
  });

  it('keeps env overrides and strips trailing slashes', () => {
    const cfg = loadConfig({
      JOURNEY_API_BASE_URL: 'https://dev.example.test/',
      JOURNEY_PRICE_API_BASE_URL: 'https://price.example.test/',
      JOURNEY_SUPPLIER_API_BASE_URL: 'https://app.example.test/',
      JOURNEY_API_KEY: 'dev-key',
      JOURNEY_PRICE_API_KEY: 'price-key',
    });
    expect(cfg.apiBaseUrl).toBe('https://dev.example.test');
    expect(cfg.priceApiBaseUrl).toBe('https://price.example.test');
    expect(cfg.supplierApiBaseUrl).toBe('https://app.example.test');
    expect(cfg.apiKey).toBe('dev-key');
    expect(cfg.priceApiKey).toBe('price-key');
    expect(cfg.supplierApiKey).toBeUndefined();
  });

  it('does not use the price key as the developer key', () => {
    const cfg = loadConfig({ JOURNEY_PRICE_API_KEY: 'price-key' });
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.priceApiKey).toBe('price-key');
    expect(cfg.priceAccountBaseUrl).toBe(DEFAULT_PRICE_API_BASE_URL);
    expect(cfg.supplierApiKey).toBeUndefined();
  });

  it('reuses the developer key for prices only when both bases are the same explicit origin', () => {
    const separate = loadConfig({ JOURNEY_API_KEY: 'dev-key' });
    expect(separate.priceApiKey).toBeUndefined();
    expect(separate.priceApiBaseUrl).toBe(DEFAULT_PRICE_API_BASE_URL);

    const shared = loadConfig({
      JOURNEY_API_BASE_URL: 'https://one.example.test',
      JOURNEY_PRICE_API_BASE_URL: 'https://one.example.test',
      JOURNEY_API_KEY: 'dev-key',
    });
    expect(shared.priceApiKey).toBe('dev-key');
    expect(shared.apiKey).toBe('dev-key');
  });

  it('does not point suppliers at the developer API, and reuses a non-default shared origin', () => {
    expect(loadConfig({ JOURNEY_API_BASE_URL: 'https://devapi.journeyfoods.io/' }).supplierApiBaseUrl).toBeUndefined();
    const shared = loadConfig({ JOURNEY_API_BASE_URL: 'https://app.example.test/', JOURNEY_API_KEY: 'dev-key' });
    expect(shared.supplierApiBaseUrl).toBe('https://app.example.test');
    expect(shared.supplierApiKey).toBe('dev-key');
    expect(shared.priceApiBaseUrl).toBe(DEFAULT_PRICE_API_BASE_URL);
    const explicit = loadConfig({
      JOURNEY_API_BASE_URL: 'https://app.example.test',
      JOURNEY_SUPPLIER_API_BASE_URL: 'https://suppliers.example.test',
      JOURNEY_SUPPLIER_API_KEY: 'service-key',
    });
    expect(explicit.supplierApiBaseUrl).toBe('https://suppliers.example.test');
    expect(explicit.supplierServiceKey).toBe('service-key');
    expect(explicit.supplierApiKey).toBeUndefined();
  });
});

describe('npx with only JOURNEY_PRICE_API_KEY', () => {
  const localAccount = (apiKey?: string): Account => ({
    id: 'key:test',
    tier: 'startup',
    authMethod: 'local',
    scopes: ['journey:read'],
    upstreamApiKey: apiKey,
  });

  async function call(env: NodeJS.ProcessEnv, name: string, args: Record<string, unknown>, fetchImpl: typeof fetch) {
    const cfg = loadConfig(env);
    const data = new RestJourneyData(cfg, silentLogger, fetchImpl);
    const server = createMcpServer({
      account: localAccount(cfg.apiKey),
      data,
      enforcer: new PolicyEnforcer(DEFAULT_POLICY, new MemoryUsageStore()),
      log: silentLogger,
      transport: 'stdio',
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]?.text ?? '';
    return { result, json: JSON.parse(text) as { error?: string; message?: string; price?: { symbol?: string } } };
  }

  it('loads prices from the default price host and does not send the price key to the developer API', async () => {
    const seen: Seen[] = [];
    const { result, json } = await call({ JOURNEY_PRICE_API_KEY: 'price-key' }, 'get_ingredient_price', { ingredient: 'cocoa', days: 90 }, mockFetch(priceRoutes, seen));
    expect(result.isError).toBeFalsy();
    expect(json.price?.symbol).toBe('COCOA');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.url.origin === DEFAULT_PRICE_API_BASE_URL)).toBe(true);
    expect(seen.every((s) => s.headers['x-api-key'] === 'price-key')).toBe(true);
  });

  it('tells the user which developer key to create instead of calling the developer API', async () => {
    const seen: Seen[] = [];
    const { result, json } = await call({ JOURNEY_PRICE_API_KEY: 'price-key' }, 'search_ingredients', { query: 'oat' }, mockFetch(priceRoutes, seen));
    expect(result.isError).toBe(true);
    expect(json.error).toBe('not_connected');
    expect(json.message).toContain('JOURNEY_API_KEY');
    expect(json.message).toContain(DEV_API_KEY_URL);
    expect(json.message).toContain('JOURNEY_PRICE_API_KEY');
    expect(seen).toHaveLength(0);
  });

  it('points supplier tools at the hosted server', async () => {
    const seen: Seen[] = [];
    const { result, json } = await call({ JOURNEY_PRICE_API_KEY: 'price-key' }, 'search_suppliers', { query: 'oat' }, mockFetch(priceRoutes, seen));
    expect(result.isError).toBe(true);
    expect(json.message).toContain(HOSTED_MCP_URL);
    expect(json.message).toContain('x-api-key');
    expect(json.message?.toLowerCase()).not.toContain('not connected');
    expect(seen).toHaveLength(0);
  });

  it('names the price key when it is missing', async () => {
    const seen: Seen[] = [];
    const { result, json } = await call({ JOURNEY_API_KEY: 'dev-key' }, 'list_price_series', {}, mockFetch({}, seen));
    expect(result.isError).toBe(true);
    expect(json.message).toContain('JOURNEY_PRICE_API_KEY');
    expect(json.message).toContain(PRICE_API_KEY_URL);
    expect(seen).toHaveLength(0);
  });
});
