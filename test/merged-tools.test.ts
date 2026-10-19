import { describe, expect, it } from 'vitest';
import { account, connect, MockData } from './helpers.js';
import { TOOL_NAMES } from '../src/tools.js';
import { DEFAULT_POLICY } from '../src/policy/policy.js';
import { PolicyEnforcer } from '../src/policy/enforcer.js';
import { MemoryUsageStore } from '../src/policy/usage-store.js';

const sc = (r: any) => r.structuredContent as any;
const err = (r: any) => JSON.parse(r.content[0].text);
const pid = (i: number) => i.toString(16).padStart(24, '0');

function clockEnforcer() {
  let t = 1_000_000;
  return new PolicyEnforcer(DEFAULT_POLICY, new MemoryUsageStore(), () => (t += 7000));
}

describe('merged tool set', () => {
  it('registers the ten merged tools, all read-only with output schemas', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools).toHaveLength(10);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.outputSchema).toBeTruthy();
    }
  });

  it('search_ingredients counts each returned ingredient toward the ingredient cap', async () => {
    const enforcer = clockEnforcer();
    const acct = account('free', 'acct:si');
    const { client } = await connect({ account: acct, enforcer });
    const r = await client.callTool({ name: 'search_ingredients', arguments: { query: 'Ingredient', limit: 25 } });
    expect(sc(r).returned).toBe(25);
    expect((await enforcer.usage(acct)).used.ingredient).toBe(25);
  });

  it('get_ingredient_price can include the forecast without counting a new record', async () => {
    const enforcer = clockEnforcer();
    const acct = account('free', 'acct:fc');
    const { client } = await connect({ account: acct, enforcer });
    const r = await client.callTool({ name: 'get_ingredient_price', arguments: { ingredient: 'cocoa', include_forecast: true } });
    expect(sc(r).forecast.points[0].p50).toBe(8000);
    const used = (await enforcer.usage(acct)).used;
    expect(used.price_series).toBe(1);
    expect(used.ingredient).toBe(1);
  });

  it('list_price_series returns names only and counts nothing', async () => {
    const enforcer = clockEnforcer();
    const acct = account('free', 'acct:lp');
    const { client } = await connect({ account: acct, enforcer });
    const r = await client.callTool({ name: 'list_price_series', arguments: {} });
    expect(sc(r).series[0]).toEqual({ symbol: 'COCOA', name: 'Cocoa', category: 'softs', unit: 'USD/mt', currency: 'USD' });
    expect(JSON.stringify(sc(r))).not.toContain('price"');
    expect((await enforcer.usage(acct)).used).toEqual({});
  });

  it('product tools say not connected without an app session', async () => {
    const { client } = await connect({ account: account('free', 'acct:np') });
    const r = await client.callTool({ name: 'search_products', arguments: {} });
    expect(r.isError).toBe(true);
    expect(err(r).error).toBe('not_connected');
  });

  it('search_products and get_product count toward the product cap and honour sections', async () => {
    const enforcer = clockEnforcer();
    const acct = account('free', 'acct:pr', { appToken: 'session' });
    const { client } = await connect({ account: acct, enforcer });
    const list = await client.callTool({ name: 'search_products', arguments: { query: 'granola', limit: 5 } });
    expect(sc(list).returned).toBe(5);
    expect(sc(list).total).toBe(30);
    const one = await client.callTool({ name: 'get_product', arguments: { product_id: pid(1), sections: ['ingredients'] } });
    expect(sc(one).product.ingredients[0].name).toBe('oats');
    expect(sc(one).product.nutrition).toBeUndefined();
    const other = await client.callTool({ name: 'get_product', arguments: { product_id: pid(20) } });
    expect(sc(other).product.nutrition.protein).toBe(6);
    expect((await enforcer.usage(acct)).used.product).toBe(6); // pid(1) was already counted by the search
  });

  it('get_product is blocked at the free product cap with the upgrade and contract message', async () => {
    const enforcer = clockEnforcer();
    const acct = account('free', 'acct:pcap', { appToken: 'session' });
    await enforcer.admit(acct, 'product', Array.from({ length: 200 }, (_, i) => `x${i}`), (x) => x);
    const { client } = await connect({ account: acct, enforcer, data: new MockData() });
    const r = await client.callTool({ name: 'get_product', arguments: { product_id: pid(3) } });
    expect(r.isError).toBe(true);
    const e = err(r);
    expect(e.message).toContain('lifetime limit of 200 products');
    expect(e.message).toContain('Upgrade');
    expect(e.message).toContain('journeyfoods.io/contact');
    expect(e.message).toContain('Thank you');
  });

  it('rejects malformed product ids', async () => {
    const { client } = await connect({ account: account('free', 'acct:bad', { appToken: 'session' }) });
    const r = await client.callTool({ name: 'get_product', arguments: { product_id: 'nope' } });
    expect(r.isError).toBe(true);
  });
});
