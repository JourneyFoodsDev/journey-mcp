import { describe, expect, it } from 'vitest';
import { account, connect } from './helpers.js';
import { createMcpServer } from '../src/server.js';
import { DEFAULT_POLICY } from '../src/policy/policy.js';
import { PolicyEnforcer } from '../src/policy/enforcer.js';
import { MemoryUsageStore } from '../src/policy/usage-store.js';
import { AnalyticsEngineUsageSink, classifyClient, type UsageEvent } from '../src/telemetry/usage-events.js';
import { MockData } from './helpers.js';
import { silentLogger } from '../src/logger.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

async function withSink(tier = 'free', id = 'acct:ev', clientName = 'claude-ai') {
  const events: UsageEvent[] = [];
  let t = 1_000_000;
  const enforcer = new PolicyEnforcer(DEFAULT_POLICY, new MemoryUsageStore(), () => (t += 7000));
  const server = createMcpServer({
    account: account(tier, id), data: new MockData(), enforcer, log: silentLogger, transport: 'stdio',
    usage: { emit: (e) => void events.push(e) },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: '1.2.3' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, events, enforcer };
}

describe('usage events', () => {
  it('emits one event per call with records, cap use, client and latency, and no arguments', async () => {
    const { client, events } = await withSink();
    await client.callTool({ name: 'search_suppliers', arguments: { query: 'secret-query', limit: 5 } });
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e).toMatchObject({ v: 1, account: 'acct:ev', tier: 'free', tool: 'search_suppliers', outcome: 'ok', records: { supplier: 5 }, withheld: 0, client: 'Claude', client_version: '1.2.3', transport: 'stdio' });
    expect(e.cap_used_max).toBe(0.5); // 5 of 10 free suppliers
    expect(e.cap_entity_max).toBe('supplier');
    expect(e.latency_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(e)).not.toContain('secret-query');
  });

  it('records withheld rows and cap_exceeded outcomes', async () => {
    const { client, events } = await withSink('free', 'acct:ev2', 'Cursor');
    await client.callTool({ name: 'search_suppliers', arguments: { query: 'abc', limit: 25 } });
    await client.callTool({ name: 'get_supplier', arguments: { supplier_id: 's20' } });
    expect(events[0]).toMatchObject({ records: { supplier: 10 }, withheld: 15, cap_used_max: 1, client: 'Cursor' });
    expect(events[1]).toMatchObject({ outcome: 'cap_exceeded', error_code: 'cap_exceeded' });
  });

  it('labels not_connected product calls', async () => {
    const { client, events } = await withSink('startup', 'acct:ev3', 'openai-mcp');
    await client.callTool({ name: 'search_products', arguments: {} });
    expect(events[0]).toMatchObject({ outcome: 'not_connected', client: 'ChatGPT' });
  });

  it('classifies common clients', () => {
    expect(classifyClient('claude-code')).toBe('Claude Code');
    expect(classifyClient(undefined, 'openai-mcp/1.0 (ChatGPT)')).toBe('ChatGPT');
    expect(classifyClient('Visual Studio Code')).toBe('VS Code');
    expect(classifyClient(undefined, 'Perplexity-User/1.0')).toBe('Perplexity');
    expect(classifyClient('my-agent')).toBe('my-agent');
    expect(classifyClient()).toBe('unknown');
  });

  it('writes a stable Analytics Engine row', () => {
    const rows: any[] = [];
    new AnalyticsEngineUsageSink({ writeDataPoint: (p) => void rows.push(p) }).emit({
      v: 1, ts: 'x', account: 'user:1', tier: 'free', auth: 'oauth', tool: 'get_product', outcome: 'ok', records: { product: 1 }, withheld: 0,
      cap_used_max: 0.005, client: 'Claude', transport: 'worker', latency_ms: 42,
    });
    expect(rows[0].indexes).toEqual(['user:1']);
    expect(rows[0].blobs.slice(0, 5)).toEqual(['get_product', 'free', 'ok', 'Claude', 'oauth']);
    expect(rows[0].doubles).toEqual([42, 1, 0, 0.005, 1, 0, 0, 0, 0]);
  });
});
