import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { JourneyHttpClient } from '../src/api/client.js';
import { RestJourneyData } from '../src/api/rest-adapter.js';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { END_USER_HEADER, END_USER_SIG_HEADER } from '../src/auth/end-user.js';

type Seen = { url: URL; headers: Record<string, string> };
function mockFetch(routes: Record<string, unknown>, seen: Seen[] = []) {
  return (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const key = url.host + url.pathname;
    if (!(key in routes)) return new Response('{"error":"nf"}', { status: 404 });
    const v = routes[key];
    if (v instanceof Response) return v;
    return new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const env = {
  JOURNEY_API_BASE_URL: 'https://dev.example.test',
  JOURNEY_API_KEY: 'test-key-not-real',
  JOURNEY_SUPPLIER_API_BASE_URL: 'https://app.example.test',
  JOURNEY_PRICE_API_BASE_URL: 'https://price.example.test',
};

describe('RestJourneyData', () => {
  it('never sends a user key to the supplier backend, even on the developer host', async () => {
    const seen: Seen[] = [];
    const d = new RestJourneyData(loadConfig({
      ...env,
      JOURNEY_SUPPLIER_API_BASE_URL: 'https://dev.example.test',
      JOURNEY_SUPPLIER_API_KEY: 'service-key',
      JOURNEY_PRICE_API_KEY: 'price-key',
    }), silentLogger, mockFetch({
      'dev.example.test/api/v1/supplier/profiles': { data: { mongo: true, data: [{ slug: 'acme', displayName: 'Acme', ingredients: ['oat'] }] } },
    }, seen));
    const rows = await d.searchSuppliers({ query: 'acme', limit: 5 }, { apiKey: 'caller-key' });
    expect(rows.map((r) => r.id)).toEqual(['acme']);
    expect(seen[0].headers['x-api-key']).toBeUndefined();
    expect(seen[0].headers['x-journey-service-key']).toBe('service-key');
  });

  it('maps supplier search to /api/v1/supplier/profiles and normalizes rows', async () => {
    const seen: Seen[] = [];
    const d = new RestJourneyData(loadConfig(env), silentLogger, mockFetch({
      'app.example.test/api/v1/supplier/profiles': { code: 200, data: { mongo: true, data: [
        { slug: 'acme', displayName: 'Acme Foods', countryCode: 'BR', country: 'Brazil', categories: ['Food Ingredients'], certifications: ['Organic'], ingredients: ['pea protein'], locations: [{ city: 'Sao Paulo' }] },
        { slug: 'beta', displayName: 'Beta', countryCode: 'US', certifications: [], ingredients: [] },
      ] } },
    }, seen));
    const rows = await d.searchSuppliers({ query: 'acme', region: 'BR', limit: 10 }, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'acme', name: 'Acme Foods', locations: ['Sao Paulo'] });
    expect(seen[0].url.searchParams.get('search')).toBe('acme');
    // The dev API key must not be sent to a different service.
    expect(seen[0].headers['x-api-key']).toBeUndefined();
  });

  it('refuses seeded fallback supplier data', async () => {
    const d = new RestJourneyData(loadConfig(env), silentLogger, mockFetch({
      'app.example.test/api/v1/supplier/profiles': { data: { mongo: false, data: [{ slug: 'x', source: 'memory_seed' }] } },
    }));
    await expect(d.searchSuppliers({ query: 'x', limit: 5 }, {})).rejects.toThrow(/unavailable/);
  });

  it('maps ingredients to the dev API with x-api-key and enriches nutrients and allergens', async () => {
    const seen: Seen[] = [];
    const d = new RestJourneyData(loadConfig(env), silentLogger, mockFetch({
      'dev.example.test/ingredients/abc': { id: 'abc', name: 'Mango, boiled', protein: 2.76, nutrition_score: 72.7, sustainability_score: 45.2, category: 'Fruit' },
      'dev.example.test/nutrients/abc': { id: 'abc', name: 'Mango', potassium: '232.4', sugar: '11.9' },
      'dev.example.test/allergens/abc': { allergens_flat: [], allergens_by_country: [] },
    }, seen));
    const ing = await d.getIngredient('abc', {});
    expect(ing).toMatchObject({ id: 'abc', name: 'Mango, boiled', nutrition_per_100g: { protein: 2.76 }, nutrients: { potassium: '232.4' }, allergens: [], attributes: { category: 'Fruit' } });
    expect(seen.every((s) => s.headers['x-api-key'] === 'test-key-not-real')).toBe(true);
  });

  it('forwards the caller key when the caller authenticated with their own key', async () => {
    const seen: Seen[] = [];
    const d = new RestJourneyData(loadConfig(env), silentLogger, mockFetch({ 'dev.example.test/ingredients/search': [{ id: 'm1', name: 'Mango' }] }, seen));
    await d.searchIngredients('mango', 1, { apiKey: 'caller-key' });
    expect(seen[0].headers['x-api-key']).toBe('caller-key');
  });

  it('returns null for 404s and maps prices through the commodity feed', async () => {
    const d = new RestJourneyData(loadConfig(env), silentLogger, mockFetch({
      'price.example.test/api/v1/commodities': { data: [{ symbol: 'COCOA', name: 'Cocoa', unit: 'USD/mt', currency: 'USD' }] },
      'price.example.test/api/v1/commodities/COCOA/quote': { data: { price: 8123.4, date: '2026-09-01', changePct: -2.1 } },
      'price.example.test/api/v1/commodities/COCOA/history': { source: 'IMF/FRED', data: [{ date: '2026-08-01', price: 8300 }] },
    }));
    expect(await d.getIngredient('missing', {})).toBeNull();
    const p = await d.getIngredientPrice('cocoa', 90, {});
    expect(p).toMatchObject({ symbol: 'COCOA', current: { price: 8123.4, change_pct: -2.1 }, history: [{ date: '2026-08-01', price: 8300 }] });
    expect(await d.getIngredientPrice('saffron', 90, {})).toBeNull();
  });

  it('turns upstream auth and server errors into clean errors without leaking details', async () => {
    const d = new RestJourneyData(loadConfig(env), silentLogger, mockFetch({
      'dev.example.test/ingredients/search': new Response('{"error":"Missing x-api-key header"}', { status: 401 }),
      'dev.example.test/ingredients/boom': new Response('stack trace here', { status: 500 }),
    }));
    await expect(d.searchIngredients('x', 1, {})).rejects.toThrow('Journey rejected the credentials');
    await expect(d.getIngredient('boom', {})).rejects.toThrow(/non-JSON|service error/);
  });

  it('reports the Labs lookup as not connected until an endpoint is configured', async () => {
    const d = new RestJourneyData(loadConfig(env), silentLogger, mockFetch({}));
    await expect(d.verifyLabResult('oats', undefined, {})).rejects.toThrow(/not connected/);
  });

  it('reads the Journey Labs summary from the app backend and fetches the PDF link with the service key', async () => {
    const seen: Seen[] = [];
    const d = new RestJourneyData(loadConfig({ ...env, JOURNEY_LABS_VERIFY_PATH: '/api/v1/lab-results/verify', JOURNEY_LABS_SERVICE_KEY: 'svc-not-real' }), silentLogger, mockFetch({
      'app.example.test/api/v1/lab-results/verify': { code: 200, data: { subject: { type: 'ingredient', id: 'ing-1', name: 'Oat flour' }, verified: true, status: 'verified', results: [{ id: 'r1', lab: 'Journey Labs Atlanta', accreditation: 'ISO/IEC 17025', test: 'Gluten', testedOn: '2026-10-01', verifiedAt: '2026-10-05T12:00:00.000Z', analytes: 3, hasPdf: true }] } },
      'app.example.test/api/v1/lab-results/r1/pdf': { code: 200, data: { url: 'https://storage.example.test/signed', expiresInMinutes: 15 } },
    }, seen));
    const free = await d.verifyLabResult('ing-1', undefined, {}, { subjectType: 'ingredient' });
    expect(free).toMatchObject({ verified: true, result_id: 'r1', subject: 'Oat flour', lab: 'Journey Labs Atlanta', tested_at: '2026-10-01', summary: 'Gluten, 3 analytes', pdf_available: true });
    expect(free.pdf_url).toBeUndefined();
    expect(seen[0].url.searchParams.get('subjectType')).toBe('ingredient');
    expect(seen[0].headers['x-api-key']).toBeUndefined();
    const paid = await d.verifyLabResult('ing-1', undefined, {}, { includePdf: true });
    expect(paid.pdf_url).toBe('https://storage.example.test/signed');
    expect(seen.at(-1)!.headers['x-journey-service-key']).toBe('svc-not-real');
  });

  it('signs the end user on supplier, ingredient, product and lab calls, and skips the headers when the secret is missing', async () => {
    const seen: Seen[] = [];
    const secret = 'test-signing-secret';
    const endUser = { userId: 'user-1', companyId: 'co-1', tier: 'Enterprise', status: 'Active', role: 'admin' };
    const d = new RestJourneyData(loadConfig({
      ...env,
      JOURNEY_SUPPLIER_API_KEY: 'supplier-service-key',
      JOURNEY_END_USER_SIGNING_SECRET: secret,
      JOURNEY_LABS_VERIFY_PATH: '/api/v1/lab-results/verify',
      JOURNEY_LABS_SERVICE_KEY: 'svc-not-real',
    }), silentLogger, mockFetch({
      'app.example.test/api/v1/supplier/profiles': { data: { mongo: true, data: [{ slug: 'acme', displayName: 'Acme', ingredients: ['oat'] }] } },
      'app.example.test/api/v1/supplier/profiles/acme': { data: { slug: 'acme', displayName: 'Acme' } },
      'dev.example.test/ingredients/search': [{ id: 'm1', name: 'Mango' }],
      'dev.example.test/ingredients/m1': { id: 'm1', name: 'Mango' },
      'dev.example.test/nutrients/m1': { id: 'm1' },
      'dev.example.test/allergens/m1': { allergens_flat: [] },
      'app.example.test/api/v1/product/product-list': { data: { data: [{ _id: 'a'.repeat(24), name: 'Bar' }], total: 1 } },
      ['app.example.test/api/v1/product/product-detail/' + 'a'.repeat(24)]: { data: { name: 'Bar' } },
      'app.example.test/api/v1/lab-results/verify': { data: { subject: { name: 'Oat' }, verified: true, status: 'verified', results: [{ id: 'r1', test: 'Gluten', hasPdf: true }] } },
      'app.example.test/api/v1/lab-results/r1/pdf': { data: { url: 'https://storage.example.test/signed' } },
      'price.example.test/api/v1/commodities': { data: [{ symbol: 'COCOA', name: 'Cocoa' }] },
    }, seen));
    await d.searchSuppliers({ query: 'acme', limit: 5 }, { endUser });
    await d.getSupplier('acme', { endUser });
    await d.searchIngredients('mango', 1, { apiKey: 'caller-key', endUser });
    await d.getIngredient('m1', { apiKey: 'caller-key', endUser });
    await d.searchProducts({ page: 1, limit: 5 }, { appToken: 'tok', endUser });
    await d.getProduct('a'.repeat(24), { appToken: 'tok', endUser });
    await d.verifyLabResult('ing-1', undefined, { endUser }, { includePdf: true });
    await d.listPriceSeries({});
    const signed = seen.filter((s) => !s.url.pathname.startsWith('/api/v1/commodities'));
    expect(signed.length).toBeGreaterThan(0);
    for (const s of signed) {
      const header = s.headers[END_USER_HEADER];
      expect(header).toBeTruthy();
      expect(s.headers[END_USER_SIG_HEADER]).toBe(createHmac('sha256', secret).update(header).digest('hex'));
      const body = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
      expect(body).toMatchObject({ userId: 'user-1', companyId: 'co-1', tier: 'enterprise', status: 'active', role: 'admin' });
      expect(body.exp - body.iat).toBe(300);
    }
    const supplier = seen.find((s) => s.url.pathname === '/api/v1/supplier/profiles')!;
    expect(supplier.headers['x-journey-service-key']).toBe('supplier-service-key');
    expect(supplier.headers['x-api-key']).toBeUndefined();
    const ingredient = seen.find((s) => s.url.pathname === '/ingredients/search')!;
    expect(ingredient.headers['x-api-key']).toBe('caller-key');
    const price = seen.find((s) => s.url.pathname === '/api/v1/commodities')!;
    expect(price.headers[END_USER_HEADER]).toBeUndefined();
    const unsigned = new RestJourneyData(loadConfig(env), silentLogger, mockFetch({
      'app.example.test/api/v1/supplier/profiles': { data: { mongo: true, data: [{ slug: 'acme', displayName: 'Acme', ingredients: ['oat'] }] } },
    }, seen));
    const before = seen.length;
    await unsigned.searchSuppliers({ query: 'acme', limit: 1 }, { endUser });
    expect(seen[before].headers[END_USER_HEADER]).toBeUndefined();
    expect(seen[before].headers['x-journey-service-key']).toBeUndefined();
  });

  it('reports revoked when the only result was revoked', async () => {
    const d = new RestJourneyData(loadConfig({ ...env, JOURNEY_LABS_VERIFY_PATH: '/api/v1/lab-results/verify' }), silentLogger, mockFetch({
      'app.example.test/api/v1/lab-results/verify': { code: 200, data: { subject: { type: 'product', id: 'p', name: null }, verified: false, status: 'revoked', results: [] } },
    }));
    expect(await d.verifyLabResult('p', undefined, {}, { subjectType: 'product' })).toMatchObject({ verified: false, status: 'revoked', subject: 'p' });
  });

  it('calls the default developer API when no base URL is set, and still refuses an unconfigured client', async () => {
    const seen: Seen[] = [];
    const d = new RestJourneyData(loadConfig({ JOURNEY_API_KEY: 'dev-key' }), silentLogger, mockFetch({
      'devapi.journeyfoods.io/ingredients/search': [{ id: 'o1', name: 'Oat' }],
    }, seen));
    expect((await d.searchIngredients('oat', 1, {})).map((r) => r.id)).toEqual(['o1']);
    expect(seen[0].url.origin).toBe('https://devapi.journeyfoods.io');
    expect(seen[0].headers['x-api-key']).toBe('dev-key');
    const bare = new JourneyHttpClient(undefined, undefined, silentLogger, mockFetch({}));
    await expect(bare.request('/x')).rejects.toThrow(/not configured/);
  });

  it('sends supplier filters server side and pages', async () => {
    const seen: Seen[] = [];
    const d = new RestJourneyData(loadConfig(env), silentLogger, mockFetch({
      'app.example.test/api/v1/supplier/profiles': { data: { mongo: true, data: [{ slug: 'c', displayName: 'Cocoa Co', ingredients: ['cocoa'], certifications: ['Organic'] }] } },
    }, seen));
    const rows = await d.searchSuppliers({ ingredient: 'cocoa', certification: 'organic', limit: 5, page: 2 }, {});
    expect(rows).toHaveLength(1);
    const q = seen[0].url.searchParams;
    expect(q.get('ingredient')).toBe('cocoa');
    expect(q.get('certification')).toBe('organic');
    expect(q.get('pageSize')).toBe('5');
    expect(q.get('page')).toBe('2');
    expect(q.get('search')).toBeNull();
  });

  it('maps price forecasts and lists series without prices', async () => {
    const d = new RestJourneyData(loadConfig(env), silentLogger, mockFetch({
      'price.example.test/api/v1/commodities': { data: [{ symbol: 'COCOA', name: 'Cocoa', unit: 'USD/mt', currency: 'USD', category: 'softs', price: 8000 }] },
      'price.example.test/api/v1/commodities/COCOA/forecast': { published: true, horizonUnit: 'month', model: 'ets', beatsNaiveByPct: 9.5, data: [{ date: '2026-11-01', p10: 1, p50: 2, p90: 3 }] },
    }));
    const list = await d.listPriceSeries({});
    expect(list[0]).toEqual({ symbol: 'COCOA', name: 'Cocoa', category: 'softs', unit: 'USD/mt', currency: 'USD' });
    const f = await d.getPriceForecast('COCOA', 90, {});
    expect(f).toMatchObject({ published: true, beats_naive_by_pct: 9.5, points: [{ date: '2026-11-01', p50: 2 }] });
  });

  it('calls the app API with the user session only, never an API key', async () => {
    const seen: Seen[] = [];
    const d = new RestJourneyData(loadConfig(env), silentLogger, mockFetch({
      'app.example.test/api/v1/product/product-list': { code: 200, data: { data: [{ _id: 'a'.repeat(24), name: 'Bar', status: 'active' }], page: 1, limit: 10, total: 1 } },
      ['app.example.test/api/v1/product/product-detail/' + 'a'.repeat(24)]: { data: { name: 'Bar', ingredients: [{ name: 'oats' }], nutrition: { protein: 5 }, 'Serving Size': 40, unitServingSize: 'g' } },
    }, seen));
    await expect(d.searchProducts({ page: 1, limit: 10 }, {})).rejects.toMatchObject({ code: 'not_connected' });
    const r = await d.searchProducts({ query: 'bar', page: 1, limit: 10 }, { appToken: 'tok' });
    expect(r).toEqual({ products: [expect.objectContaining({ id: 'a'.repeat(24), name: 'Bar' })], total: 1 });
    expect(seen[0].headers.Authorization).toBe('Bearer tok');
    expect(seen[0].headers['x-api-key']).toBeUndefined();
    const p = await d.getProduct('a'.repeat(24), { appToken: 'tok' });
    expect(p).toMatchObject({ name: 'Bar', serving_size: 40, serving_size_unit: 'g', nutrition: { protein: 5 } });
  });
});
