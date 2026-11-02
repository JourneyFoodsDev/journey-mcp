import { afterEach, describe, expect, it } from 'vitest';
import worker, { FALLBACK_DEV_API_BASE, FALLBACK_MCP_API_BASE } from '../worker/index.js';

const env = {
  JOURNEY_DEV_API_BASE: FALLBACK_DEV_API_BASE,
  JOURNEY_API_BASE: FALLBACK_MCP_API_BASE,
  JOURNEY_PRICE_API_BASE: 'https://price.journeyfoods.io',
  JOURNEY_PRICE_API_KEY: { async get() { return 'price-from-store'; } },
  JOURNEY_SUPPLIER_API_KEY: { async get() { return 'supplier-from-store'; } },
};

type Seen = { url: string; headers: Record<string, string> };
const seen: Seen[] = [];

function headersOf(init?: RequestInit): Record<string, string> {
  const h = init?.headers;
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h);
  return h as Record<string, string>;
}

afterEach(() => {
  seen.length = 0;
  Reflect.deleteProperty(globalThis, 'fetch');
});

function installFetch() {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, headers: headersOf(init) });
    if (url.includes('/api/v1/account')) return new Response('{}', { status: 404 });
    if (url.includes('/ingredients/search')) return Response.json([{ id: 'o1', name: 'Oat' }]);
    if (url.includes('/api/v1/supplier/profiles')) {
      return Response.json({ data: { mongo: true, data: [{ slug: 'acme', displayName: 'Acme', ingredients: ['oat'] }] } });
    }
    if (url.includes('/api/v1/commodities')) return Response.json({ data: [{ symbol: 'COCOA', name: 'Cocoa', unit: 'index', currency: 'USD' }] });
    return new Response('{"error":"nf"}', { status: 404 });
  }) as typeof fetch;
  globalThis.fetch = fetchImpl;
}

async function tool(name: string, args: Record<string, unknown>, apiKey = 'caller-dev-key') {
  installFetch();
  const res = await worker.fetch(new Request('https://mcp.journeyfoods.io/mcp', {
    method: 'POST',
    headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), env);
  const body = await res.json() as { result?: { isError?: boolean; content?: { text: string }[]; structuredContent?: unknown }; error?: unknown };
  return { status: res.status, body };
}

describe('hosted worker upstream auth', () => {
  it('reads the price secret and calls the price feed with it', async () => {
    const { status, body } = await tool('list_price_series', {});
    expect(status).toBe(200);
    expect(body.result?.isError).toBeFalsy();
    const price = seen.find((s) => s.url.startsWith('https://price.journeyfoods.io/api/v1/commodities'));
    expect(price?.headers['x-api-key']).toBe('price-from-store');
  });

  it('sends the caller key as x-api-key to the fallback devapi', async () => {
    const { status, body } = await tool('search_ingredients', { query: 'oat' });
    expect(status).toBe(200);
    expect(body.result?.isError).toBeFalsy();
    const dev = seen.find((s) => s.url.startsWith(`${FALLBACK_DEV_API_BASE}/ingredients/search`));
    expect(dev).toBeTruthy();
    expect(dev?.headers['x-api-key']).toBe('caller-dev-key');
    expect(dev?.headers['x-api-key']).not.toBe('price-from-store');
    expect(dev?.headers.authorization).toBeUndefined();
  });

  it('does not require the caller key to be sent to /x/mcp supplier search', async () => {
    const { status, body } = await tool('search_suppliers', { query: 'oat' });
    expect(status).toBe(200);
    expect(body.result?.isError).toBeFalsy();
    const supplier = seen.find((s) => s.url.startsWith(`${FALLBACK_MCP_API_BASE}/api/v1/supplier/profiles`));
    expect(supplier).toBeTruthy();
    expect(supplier?.headers['x-api-key']).toBeUndefined();
    expect(supplier?.headers['x-journey-service-key']).toBe('supplier-from-store');
  });

  it('still rejects /mcp when the API key is missing', async () => {
    installFetch();
    const res = await worker.fetch(new Request('https://mcp.journeyfoods.io/mcp', {
      method: 'POST',
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }), env);
    expect(res.status).toBe(401);
    expect(seen.filter((s) => s.url.includes('journey-fallback'))).toHaveLength(0);
  });
});
