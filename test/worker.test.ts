import { describe, it, expect } from 'vitest';
import worker, { FALLBACK_DEV_API_BASE, FALLBACK_MCP_API_BASE, loadWorkerConfig } from '../worker/index.js';
import { DEFAULT_PRICE_API_BASE_URL } from '../src/config.js';

describe('hosted worker', () => {
  it('serves the public root and requires an API key on /mcp', async () => {
    const root = await worker.fetch(new Request('https://mcp.journeyfoods.io/'), {});
    expect(await root.json()).toMatchObject({ name: 'Journey', mcp: 'https://mcp.journeyfoods.io/mcp', auth: ['api_key', 'oauth'] });
    const denied = await worker.fetch(new Request('https://mcp.journeyfoods.io/mcp', { method: 'POST', body: '{}' }), {});
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toContain('price.journeyfoods.io');
    expect(await denied.json()).toMatchObject({ error: { code: -32001 } });
  });

  it('loads the supplier service key and the signing secret from Secrets Store bindings', async () => {
    const cfg = await loadWorkerConfig({
      JOURNEY_PRICE_API_BASE_URL: 'https://price.example.test',
      JOURNEY_SUPPLIER_API_KEY: { async get() { return 'supplier-from-store'; } },
      JOURNEY_END_USER_SIGNING_SECRET: { async get() { return 'signing-from-store'; } },
    });
    expect(cfg.supplierServiceKey).toBe('supplier-from-store');
    expect(cfg.supplierApiKey).toBeUndefined();
    expect(cfg.endUserSigningSecret).toBe('signing-from-store');
    expect(cfg.priceAccountBaseUrl).toBe('https://price.example.test');
    expect(cfg.priceApiKey).toBeUndefined();
    expect(cfg.apiKey).toBeUndefined();
    const missing = await loadWorkerConfig({ JOURNEY_END_USER_SIGNING_SECRET: { async get() { throw new Error('not bound'); } } });
    expect(missing.endUserSigningSecret).toBeUndefined();
    expect(missing.apiBaseUrl).toBe(FALLBACK_DEV_API_BASE);
    expect(missing.supplierApiBaseUrl).toBe(FALLBACK_MCP_API_BASE);
    expect(missing.appApiBaseUrl).toBe(FALLBACK_MCP_API_BASE);
    expect(missing.priceApiBaseUrl).toBe(DEFAULT_PRICE_API_BASE_URL);
  });

  it('reads JOURNEY_PRICE_API_KEY from the Secrets Store the same way as the supplier key', async () => {
    const cfg = await loadWorkerConfig({
      JOURNEY_PRICE_API_BASE: 'https://price.journeyfoods.io',
      JOURNEY_PRICE_API_KEY: { async get() { return 'price-from-store'; } },
      JOURNEY_SUPPLIER_API_KEY: { async get() { return 'supplier-from-store'; } },
    });
    expect(cfg.priceApiKey).toBe('price-from-store');
    expect(cfg.priceApiBaseUrl).toBe('https://price.journeyfoods.io');
    expect(cfg.supplierServiceKey).toBe('supplier-from-store');
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.supplierApiKey).toBeUndefined();
    const fromEnv = await loadWorkerConfig({ JOURNEY_PRICE_API_KEY: 'price-from-env' });
    expect(fromEnv.priceApiKey).toBe('price-from-env');
  });

  it('maps the live Worker binding names onto this repo and does not override an explicit rollback URL', async () => {
    const live = await loadWorkerConfig({
      JOURNEY_API_BASE: FALLBACK_MCP_API_BASE,
      JOURNEY_DEV_API_BASE: FALLBACK_DEV_API_BASE,
      JOURNEY_PRICE_API_BASE: 'https://price.journeyfoods.io',
    });
    expect(live.apiBaseUrl).toBe(FALLBACK_DEV_API_BASE);
    expect(live.supplierApiBaseUrl).toBe(FALLBACK_MCP_API_BASE);
    expect(live.appApiBaseUrl).toBe(FALLBACK_MCP_API_BASE);
    expect(live.priceApiBaseUrl).toBe('https://price.journeyfoods.io');

    const rollback = await loadWorkerConfig({
      JOURNEY_API_BASE_URL: 'https://devapi.journeyfoods.io',
      JOURNEY_DEV_API_BASE: FALLBACK_DEV_API_BASE,
      JOURNEY_SUPPLIER_API_BASE_URL: 'https://journeyfoods-api-prod-17792015607.us-central1.run.app',
      JOURNEY_API_BASE: FALLBACK_MCP_API_BASE,
    });
    expect(rollback.apiBaseUrl).toBe('https://devapi.journeyfoods.io');
    expect(rollback.supplierApiBaseUrl).toBe('https://journeyfoods-api-prod-17792015607.us-central1.run.app');
    expect(rollback.appApiBaseUrl).toBe('https://journeyfoods-api-prod-17792015607.us-central1.run.app');
  });

  it('lists Journey Foods tools without a key and keeps /mcp locked', async () => {
    const headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
    const list = await worker.fetch(new Request('https://mcp.journeyfoods.io/apps/journey-foods/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }), {});
    expect(list.status).toBe(200);
    const body = await list.json() as { result?: { tools?: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }; _meta?: { ui?: { resourceUri?: string }; securitySchemes?: { type: string }[] } }[] } };
    const tools = body.result?.tools ?? [];
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('search_suppliers');
    expect(names).toContain('get_profile');
    expect(names).not.toContain('search_products');
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.openWorldHint).toBe(false);
    }
    const search = tools.find((tool) => tool.name === 'search_suppliers');
    expect(search?._meta?.ui?.resourceUri).toBe('ui://journey/result-list.html');
    expect(search?._meta?.securitySchemes?.map((scheme) => scheme.type).sort()).toEqual(['noauth', 'oauth2']);
    const profile = tools.find((tool) => tool.name === 'get_profile');
    expect(profile?._meta?.securitySchemes).toEqual([{ type: 'oauth2', scopes: ['journey:read'] }]);
    expect(profile?._meta).toMatchObject({ 'openai/profile': true });
    const denied = await worker.fetch(new Request('https://mcp.journeyfoods.io/mcp', { method: 'POST', headers, body: '{}' }), {});
    expect(denied.status).toBe(401);
  });

  it('advertises PKCE S256 and does not invent an OpenAI challenge token', async () => {
    const meta = await worker.fetch(new Request('https://mcp.journeyfoods.io/.well-known/oauth-authorization-server'), {});
    const body = await meta.json() as { code_challenge_methods_supported?: string[]; authorization_response_iss_parameter_supported?: boolean };
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.authorization_response_iss_parameter_supported).toBe(true);
    const challenge = await worker.fetch(new Request('https://mcp.journeyfoods.io/.well-known/openai-apps-challenge'), {});
    expect(challenge.status).toBe(404);
    expect(await challenge.text()).toBe('not_configured');
  });

  it('requires an API key on /mcp and does not serve data from any other path', async () => {
    const denied = await worker.fetch(new Request('https://mcp.journeyfoods.io/mcp', { method: 'POST', headers: { 'x-api-key': '   ' }, body: '{}' }), {});
    expect(denied.status).toBe(401);
    const missing = await worker.fetch(new Request('https://mcp.journeyfoods.io/data/v1/jai/index'), {});
    expect(missing.status).toBe(404);
    const root = await worker.fetch(new Request('https://mcp.journeyfoods.io/'), {});
    const body = await root.json() as { name?: string };
    expect(body.name).toBe('Journey');
    expect(JSON.stringify(body)).not.toMatch(/price|index|supplier/i);
  });
});
