import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AccountLedger, JourneyMcp } from '../worker/durable-objects.js';

/** Live journey-mcp bindings read on Nov 2 2026. No secret values. */
const LIVE = {
  compatibility_date: '2026-10-16',
  compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
  vars: {
    JOURNEY_API_BASE: 'https://journey-fallback.journeyfoods.workers.dev/x/mcp',
    JOURNEY_APP_URL: 'https://app.journeyfoods.io',
    JOURNEY_DEV_API_BASE: 'https://journey-fallback.journeyfoods.workers.dev/x/devapi',
    JOURNEY_PRICE_API_BASE: 'https://price.journeyfoods.io',
    MCP_RESOURCE: 'https://mcp.journeyfoods.io/mcp',
  },
  kv: { binding: 'OAUTH_KV', id: 'fbc5a846390a4654a4b59bcf5d5dcc1e' },
  durable_objects: [
    { name: 'ACCOUNT_LEDGER', class_name: 'AccountLedger' },
    { name: 'MCP_OBJECT', class_name: 'JourneyMcp' },
  ],
  analytics: { binding: 'USAGE_EVENTS', dataset: 'journey_mcp_usage' },
  secrets: [
    { binding: 'FIREBASE_WEB_API_KEY', store_id: '7a5116d7ce5d482e8e8cec9e2554c765', secret_name: 'FIREBASE_WEB_API_KEY' },
    { binding: 'JOURNEY_END_USER_SIGNING_SECRET', store_id: '7a5116d7ce5d482e8e8cec9e2554c765', secret_name: 'JOURNEY_END_USER_SIGNING_SECRET' },
    { binding: 'JOURNEY_PRICE_API_KEY', store_id: '7a5116d7ce5d482e8e8cec9e2554c765', secret_name: 'JOURNEY_PRICE_API_KEY' },
    { binding: 'JOURNEY_SUPPLIER_API_KEY', store_id: '7a5116d7ce5d482e8e8cec9e2554c765', secret_name: 'JOURNEY_SUPPLIER_KEY_MCP' },
    { binding: 'SESSION_SECRET', store_id: '7a5116d7ce5d482e8e8cec9e2554c765', secret_name: 'JOURNEY_MCP_SESSION_SECRET' },
  ],
} as const;

function parseJsonc(path: string): Record<string, unknown> {
  const text = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return JSON.parse(text) as Record<string, unknown>;
}

describe('worker/wrangler.jsonc matches the live Worker bindings', () => {
  const cfg = parseJsonc(new URL('../worker/wrangler.jsonc', import.meta.url));

  it('keeps the live compatibility date and flags, including nodejs_compat', () => {
    expect(cfg.compatibility_date).toBe(LIVE.compatibility_date);
    expect(cfg.compatibility_flags).toEqual([...LIVE.compatibility_flags]);
    expect(cfg.name).toBe('journey-mcp');
  });

  it('keeps every plain-text var at the live value', () => {
    expect(cfg.vars).toEqual(LIVE.vars);
  });

  it('keeps OAUTH_KV, both sqlite Durable Objects, and USAGE_EVENTS', () => {
    expect(cfg.kv_namespaces).toEqual([LIVE.kv]);
    expect(cfg.durable_objects).toEqual({ bindings: [...LIVE.durable_objects] });
    expect(cfg.exports).toEqual({
      AccountLedger: { type: 'durable-object', storage: 'sqlite' },
      JourneyMcp: { type: 'durable-object', storage: 'sqlite' },
    });
    expect(cfg.analytics_engine_datasets).toEqual([LIVE.analytics]);
    expect(cfg.migrations).toBeUndefined();
  });

  it('keeps every secrets-store binding on the live store, with no secret values', () => {
    const secrets = cfg.secrets_store_secrets as { binding: string; store_id: string; secret_name: string }[];
    expect(secrets).toEqual([...LIVE.secrets]);
    const blob = JSON.stringify(cfg);
    expect(blob).not.toMatch(/mongodb|mongo\+srv|BEGIN |private_key/i);
    for (const secret of secrets) {
      expect(Object.keys(secret).sort()).toEqual(['binding', 'secret_name', 'store_id']);
    }
  });

  it('exports the Durable Object classes and does not delete their storage', async () => {
    expect(new JourneyMcp({}, {}).fetch().then).toBeTypeOf('function');
    const mcp = await new JourneyMcp({}, {}).fetch();
    const ledger = await new AccountLedger({}, {}).fetch();
    expect(mcp.status).toBe(501);
    expect(ledger.status).toBe(501);
    expect(JSON.stringify(await mcp.json())).not.toMatch(/delete/i);
  });
});
