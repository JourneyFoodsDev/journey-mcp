import { describe, it, expect } from 'vitest';
import worker, { loadWorkerConfig } from '../worker/index.js';

describe('hosted worker', () => {
  it('serves the public root and requires an API key on /mcp', async () => {
    const root = await worker.fetch(new Request('https://mcp.journeyfoods.io/'), {});
    expect(await root.json()).toMatchObject({ name: 'Journey AI', mcp: 'https://mcp.journeyfoods.io/mcp', auth: ['api_key'] });
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
    const missing = await loadWorkerConfig({ JOURNEY_END_USER_SIGNING_SECRET: { async get() { throw new Error('not bound'); } } });
    expect(missing.endUserSigningSecret).toBeUndefined();
  });
});
