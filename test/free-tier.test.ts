import { describe, it, expect } from 'vitest';
import { connect, account, MockData } from './helpers.js';
import { DEFAULT_POLICY, effectiveLimits, validatePolicy, type PolicyConfig } from '../src/policy/policy.js';
import { PolicyEnforcer } from '../src/policy/enforcer.js';
import { MemoryUsageStore } from '../src/policy/usage-store.js';
import { CapExceededError } from '../src/errors.js';

// Advance a fake clock 7s per rate check so the free tier's 10/min limit never interferes with cap tests.
const clock = () => { let t = 0; return () => (t += 7000); };
const free = () => account('free', `acct:free-${Math.random()}`);
const expectFreeCapMessage = (m: string) => {
  expect(m).toContain('https://journeyfoods.io/contact');
  expect(m).toContain('Upgrade to the Startup plan');
  expect(m).toContain('Thank you.');
  expect(m.toLowerCase()).not.toContain('thanks');
};

describe('free tier lifetime caps (200 products, 200 ingredients, 10 suppliers)', () => {
  it('default policy table', () => {
    const l = effectiveLimits(DEFAULT_POLICY, 'free');
    expect(l.lifetime.product).toBe(200);
    expect(l.lifetime.ingredient).toBe(200);
    expect(l.lifetime.supplier).toBe(10);
    const s = effectiveLimits(DEFAULT_POLICY, 'startup');
    expect(s.lifetime.ingredient).toBe(Math.floor(DEFAULT_POLICY.totals.ingredient * 0.02));
    expect(s.lifetime.supplier).toBe(Math.floor(DEFAULT_POLICY.totals.supplier * 0.02));
    expect(s.upgradeMessage).toBeUndefined();
    expect(effectiveLimits(DEFAULT_POLICY, 'free').lifetime.lab_result).toBe(25);
  });

  it('caps suppliers at 10 across search_suppliers, get_supplier and compare_suppliers', async () => {
    const { call } = await connect({ account: free(), data: new MockData(40, 5) });
    const s = await call('search_suppliers', { query: 'pea', limit: 6 }); // s1-s6
    expect(s.structuredContent.returned).toBe(6);
    await call('get_supplier', { supplier_id: 's7' });
    await call('get_supplier', { supplier_id: 's1' }); // already seen, free
    const cmp = await call('compare_suppliers', { supplier_ids: ['s8', 's9', 's10', 's11'] });
    expect(cmp.structuredContent.suppliers.map((x: any) => x.id)).toEqual(['s8', 's9', 's10']);
    expect(cmp.structuredContent.notice).toContain('Upgrade to the Startup plan');
    const capped = await call('get_supplier', { supplier_id: 's12' });
    expect(capped.json.error).toBe('cap_exceeded');
    expect(capped.json.message).toContain('10 suppliers');
    expectFreeCapMessage(capped.json.message);
    expect((await call('get_supplier', { supplier_id: 's3' })).isError).toBeFalsy();
  });

  it('caps ingredients at 200 across get_ingredient and get_ingredient_price', async () => {
    const { call, enforcer } = await connect({ account: free(), data: new MockData(2, 250), now: clock() });
    for (let i = 1; i <= 199; i++) expect((await call('get_ingredient', { ingredient_id: `i${i}` })).isError).toBeFalsy();
    expect((await call('get_ingredient_price', { ingredient: 'cocoa' })).isError).toBeFalsy(); // 200th ingredient record
    const capped = await call('get_ingredient', { ingredient_id: 'i200' });
    expect(capped.json.error).toBe('cap_exceeded');
    expect(capped.json.message).toContain('200 ingredients');
    expectFreeCapMessage(capped.json.message);
    expect((await call('get_ingredient', { ingredient_id: 'i5' })).isError).toBeFalsy(); // seen before
  });

  it('blocks a price lookup once the ingredient cap is reached', async () => {
    const { call } = await connect({ account: free(), data: new MockData(2, 250), now: clock() });
    for (let i = 1; i <= 200; i++) await call('get_ingredient', { ingredient_id: `i${i}` });
    const p = await call('get_ingredient_price', { ingredient: 'cocoa' });
    expect(p.json.error).toBe('cap_exceeded');
    expectFreeCapMessage(p.json.message);
  });

  it('caps products at 200 for any tool that returns products', async () => {
    const enforcer = new PolicyEnforcer(DEFAULT_POLICY, new MemoryUsageStore());
    const a = free();
    const ids = Array.from({ length: 250 }, (_, i) => `p${i}`);
    const first = await enforcer.admit(a, 'product', ids.slice(0, 150), (x) => x);
    expect(first.allowed.length).toBe(150);
    const second = await enforcer.admit(a, 'product', ids.slice(150), (x) => x);
    expect(second.allowed.length).toBe(50);
    expect(second.withheld).toBe(50);
    await expect(enforcer.assertCapacity(a, 'product')).rejects.toBeInstanceOf(CapExceededError);
    const err = await enforcer.admit(a, 'product', ['p999'], (x) => x).catch((e) => e);
    expect(err.message).toContain('200 products');
    expectFreeCapMessage(err.message);
    expect((await enforcer.admit(a, 'product', ['p1'], (x) => x)).allowed).toEqual(['p1']);
  });

  it('can switch to one combined 200 cap for products and ingredients by policy', async () => {
    const p: PolicyConfig = validatePolicy({
      ...DEFAULT_POLICY,
      tiers: { ...DEFAULT_POLICY.tiers, free: { ...DEFAULT_POLICY.tiers.free, lifetimeGroups: [{ name: 'products_and_ingredients', entities: ['product', 'ingredient'], limit: 200 }] } },
    });
    const enforcer = new PolicyEnforcer(p, new MemoryUsageStore());
    const a = free();
    await enforcer.admit(a, 'product', Array.from({ length: 120 }, (_, i) => `p${i}`), (x) => x);
    const ing = await enforcer.admit(a, 'ingredient', Array.from({ length: 100 }, (_, i) => `i${i}`), (x) => x);
    expect(ing.allowed.length).toBe(80);
    const err = await enforcer.admit(a, 'ingredient', ['i500'], (x) => x).catch((e) => e);
    expect(err.message).toContain('combined lifetime limit of 200 product and ingredient');
    expectFreeCapMessage(err.message);
  });

  it('rejects invalid combined groups', () => {
    expect(() => validatePolicy({ ...DEFAULT_POLICY, tiers: { ...DEFAULT_POLICY.tiers, free: { ...DEFAULT_POLICY.tiers.free, lifetimeGroups: [{ name: 'x', entities: ['nope' as any], limit: 1 }] } } })).toThrow();
  });

  it('paid tiers keep the contract-only message and the 2% ingredient ceiling', async () => {
    const enforcer = new PolicyEnforcer(DEFAULT_POLICY, new MemoryUsageStore());
    const a = account('startup', 'acct:paid');
    const cap = effectiveLimits(DEFAULT_POLICY, 'startup').lifetime.ingredient;
    expect(cap).toBe(10_000);
    await enforcer.admit(a, 'ingredient', Array.from({ length: cap }, (_, i) => `i${i}`), (x) => x);
    const err = await enforcer.admit(a, 'ingredient', ['extra'], (x) => x).catch((e) => e);
    expect(err.message).toContain('10,000 ingredients');
    expect(err.message).toContain('https://journeyfoods.io/contact');
    expect(err.message).not.toContain('Upgrade');
  });
});
