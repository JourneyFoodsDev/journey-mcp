import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHttpApp } from '../src/http.js';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { PolicyEnforcer } from '../src/policy/enforcer.js';
import { DEFAULT_POLICY } from '../src/policy/policy.js';
import { MemoryUsageStore } from '../src/policy/usage-store.js';
import { ApiKeyResolver } from '../src/auth/api-key.js';
import { MockData, account } from './helpers.js';
import { D1GuavaCatalog, type GuavaD1 } from '../src/apps/guava-d1.js';
import { HOSTED_GUAVA_CATALOG_URL, RestGuavaCatalog, readGuavaProduct } from '../src/apps/guava-catalog.js';
import type { GuavaCatalog, GuavaProductSummary } from '../src/apps/guava-catalog.js';
import worker from '../worker/index.js';

const stored = {
  name: 'Fixture cereal',
  source: 'test-fixture',
  barcode: '1234567890123',
  guavaScore: null,
  nutritionScore: { $numberInt: '64' },
  sustainabilityScore: { $numberInt: '40' },
  price: { $numberDouble: '2.5' },
  brandId: { $oid: 'brand-fixture' },
  ingredients: [{ ingredient: { $oid: 'ing-fixture' } }],
};

function fakeDb(): GuavaD1 & { sql: string[] } {
  const sql: string[] = [];
  const db: GuavaD1 & { sql: string[] } = {
    sql,
    prepare(query: string) {
      return {
        bind(...args: unknown[]) {
          sql.push(query);
          const rows = answer(query, args);
          return {
            async all<T>() { return { results: rows as T[] }; },
            async first<T>() { return (rows[0] as T) ?? null; },
          };
        },
      };
    },
  };
  return db;
}

function answer(query: string, args: unknown[]): Record<string, unknown>[] {
  if (query.includes('guava_auth') || query.includes('users')) throw new Error('catalog query touched a private table');
  if (query.includes('barcode =')) return [{ id: 'fixture-1', barcode: String(args[0]), name: 'Fixture cereal' }];
  if (query.includes('MATCH')) return [{ id: 'fixture-1', barcode: '1234567890123', name: 'Fixture cereal' }];
  if (query.includes("coll = 'products'")) return [{ doc: JSON.stringify(stored) }];
  if (query.includes("coll = 'ingredients'")) return [{ id: 'ing-fixture', name: 'Fixture oat' }];
  if (query.includes('guava_b')) return [{ name: 'Fixture brand' }];
  return [];
}

describe('stored Guava documents', () => {
  it('reads extended JSON numbers and leaves a null Guava Score off the product', () => {
    const product = readGuavaProduct({ ...stored, _id: { $oid: 'fixture-id' } });
    expect(product).toMatchObject({
      id: 'fixture-id',
      name: 'Fixture cereal',
      source: 'test-fixture',
      barcode: '1234567890123',
      nutrition: { nutrition_score: 64, sustainability_score: 40 },
      price_context: { amount: 2.5 },
    });
    expect(product?.guava_score).toBeUndefined();
    expect(readGuavaProduct({ ...stored, _id: 'fixture-2', guavaScore: { $numberInt: '81' } })?.guava_score).toBe(81);
  });

  it('searches guava_p and loads one product document without calculating a score', async () => {
    const db = fakeDb();
    const catalog = new D1GuavaCatalog(db);
    const rows = await catalog.search({ query: 'Fixture cereal', limit: 5 });
    expect(rows).toEqual([{ id: 'fixture-1', name: 'Fixture cereal', barcode: '1234567890123' }]);
    expect(JSON.stringify(rows)).not.toContain('guava_score');
    const product = await catalog.get('fixture-1');
    expect(product).toMatchObject({ id: 'fixture-1', name: 'Fixture cereal', brand: 'Fixture brand', ingredients: ['Fixture oat'], source: 'test-fixture' });
    expect(product?.guava_score).toBeUndefined();
    expect(db.sql.some((query) => query.includes('guava_p'))).toBe(true);
    expect(db.sql.some((query) => query.includes("coll = 'products'"))).toBe(true);
    expect(db.sql.some((query) => query.includes('guava_auth'))).toBe(false);
    const barcode = await catalog.search({ barcode: '1234567890123', limit: 1 });
    expect(barcode[0]?.id).toBe('fixture-1');
  });

  it('calls the hosted catalog path under /apps/guava', async () => {
    const seen: string[] = [];
    const catalog = new RestGuavaCatalog(HOSTED_GUAVA_CATALOG_URL, (async (input: URL | string) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ products: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);
    await catalog.search({ query: 'oat', limit: 4 });
    expect(seen[0]).toBe('https://mcp.journeyfoods.io/apps/guava/v1/products?query=oat&limit=4');
  });
});

describe('catalog HTTP gate', () => {
  const products: GuavaProductSummary[] = Array.from({ length: 6 }, (_, i) => ({ id: `fixture-${i}`, name: `Fixture ${i}`, source: 'test-fixture' }));
  const catalog: GuavaCatalog = {
    async search(q) { return products.filter((row) => row.name.includes(q.query ?? '')).slice(0, q.limit); },
    async get(id) { return products.find((row) => row.id === id) ? { ...products.find((row) => row.id === id)!, name: 'Fixture' } : null; },
  };

  it('returns at most 4 products to an anonymous caller', async () => {
    const app = createHttpApp({
      cfg: loadConfig({ MCP_RESOURCE_URL: 'https://mcp.example.test/mcp' }),
      log: silentLogger,
      data: new MockData(),
      enforcer: new PolicyEnforcer(DEFAULT_POLICY, new MemoryUsageStore()),
      keys: new ApiKeyResolver(undefined, silentLogger),
      guava: catalog,
    });
    const anon = await request(app).get('/apps/guava/v1/products').query({ query: 'Fixture', limit: 10 });
    expect(anon.status).toBe(200);
    expect(anon.body.returned).toBe(4);
    expect(anon.body.notice).toContain('https://www.journeyfoods.io/mcp');
    expect(JSON.stringify(anon.body)).not.toContain('guava_score');
    const paid = await request(app).get('/apps/guava/v1/products').query({ query: 'Fixture', limit: 10 }).set('x-api-key', 'paid-key');
    expect(paid.body.returned).toBe(4);
  });

  it('gives a subscribed API key the requested page', async () => {
    const keys = new ApiKeyResolver('https://lookup.example.test', silentLogger, (async () => new Response(JSON.stringify({ account_id: 'co-1', tier: 'startup', status: 'active' }), { status: 200 })) as unknown as typeof fetch);
    const app = createHttpApp({
      cfg: loadConfig({ MCP_RESOURCE_URL: 'https://mcp.example.test/mcp' }),
      log: silentLogger,
      data: new MockData(),
      enforcer: new PolicyEnforcer(DEFAULT_POLICY, new MemoryUsageStore()),
      keys,
      guava: catalog,
    });
    const paid = await request(app).get('/apps/guava/v1/products').query({ query: 'Fixture', limit: 10 }).set('x-api-key', 'paid-key');
    expect(paid.body.returned).toBe(6);
    expect(paid.body.notice).toBeUndefined();
    void account;
  });
});

describe('worker catalog route', () => {
  it('does not invent products when the D1 binding is absent', async () => {
    const res = await worker.fetch(new Request('https://mcp.journeyfoods.io/apps/guava/v1/products?query=oat'), {});
    expect(res.status).toBe(501);
    const body = await res.json() as { error?: string; products?: unknown };
    expect(body.error).toBe('not_connected');
    expect(body.products).toBeUndefined();
  });
});
