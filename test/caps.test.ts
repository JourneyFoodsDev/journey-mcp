import { describe, it, expect } from 'vitest';
import { connect, account, smallPolicy, MockData } from './helpers.js';
import { DEFAULT_POLICY, effectiveLimits, validatePolicy, resolveTier, ENTITIES } from '../src/policy/policy.js';
import { PolicyEnforcer } from '../src/policy/enforcer.js';
import { MemoryUsageStore } from '../src/policy/usage-store.js';

describe('policy limits', () => {
  it('keeps every tier below Enterprise at or under 2% of each dataset and of all data', () => {
    const grand = ENTITIES.reduce((s, e) => s + DEFAULT_POLICY.totals[e], 0);
    for (const [tier, def] of Object.entries(DEFAULT_POLICY.tiers)) {
      if (!def.selfServe) continue;
      const l = effectiveLimits(DEFAULT_POLICY, tier);
      for (const e of ENTITIES) expect(l.lifetime[e]).toBeLessThanOrEqual(DEFAULT_POLICY.totals[e] * 0.02);
      expect(l.lifetimeTotal).toBeLessThanOrEqual(grand * 0.02);
    }
  });
  it('caps every tier below Enterprise at exactly 2%, with no 4,000 ingredient exception', () => {
    const p = { ...DEFAULT_POLICY, tiers: { ...DEFAULT_POLICY.tiers, startup: { selfServe: true, requestsPerMinute: 60, lifetime: { ingredient: 999999 } } } };
    expect(effectiveLimits(p, 'startup').lifetime.ingredient).toBe(Math.floor(500000 * 0.02));
    expect(effectiveLimits(DEFAULT_POLICY, 'startup').lifetime.ingredient).toBe(10_000);
    expect(effectiveLimits(DEFAULT_POLICY, 'fresh').lifetime.ingredient).toBe(10_000);
  });
  it('clamps self-serve caps to the 2% ceiling', () => {
    const p = { ...DEFAULT_POLICY, tiers: { ...DEFAULT_POLICY.tiers, startup: { selfServe: true, requestsPerMinute: 60, lifetime: { supplier: 100000 } } } };
    expect(effectiveLimits(p, 'startup').lifetime.supplier).toBe(Math.floor(34388 * 0.02));
  });
  it('accepts a share ceiling of exactly 2% and rejects anything above', () => {
    expect(validatePolicy({ ...DEFAULT_POLICY, maxSelfServeShare: 0.02 }).maxSelfServeShare).toBe(0.02);
    expect(() => validatePolicy({ ...DEFAULT_POLICY, maxSelfServeShare: 0.021 })).toThrow(/2%/);
  });
  it('reads the tier from the account, maps plan aliases, and defaults unknown tiers to free', () => {
    expect(resolveTier(DEFAULT_POLICY, 'pro')).toBe('startup');
    expect(resolveTier(DEFAULT_POLICY, 'none')).toBe('free');
    expect(resolveTier(DEFAULT_POLICY, 'platinum-hacker')).toBe('free');
    expect(resolveTier(DEFAULT_POLICY, null)).toBe('free');
    expect(resolveTier(DEFAULT_POLICY, 'app:supplier')).toBe('startup');
    expect(resolveTier(DEFAULT_POLICY, 'supplier')).toBe('startup');
    expect(resolveTier(DEFAULT_POLICY, 'app:fresh')).toBe('fresh');
    expect(effectiveLimits(DEFAULT_POLICY, 'fresh').lifetime.supplier).toBe(0);
    expect(effectiveLimits(DEFAULT_POLICY, 'app:supplier').lifetime.supplier).toBe(Math.floor(34388 * 0.02));
  });
  it('lets an active or trialing enterprise contract carry account-specific limits', () => {
    const l = effectiveLimits(DEFAULT_POLICY, 'enterprise', { supplier: 20000, requestsPerMinute: 900 }, 'active');
    expect(l.lifetime.supplier).toBe(20000);
    expect(l.requestsPerMinute).toBe(900);
    expect(l.selfServe).toBe(false);
    expect(effectiveLimits(DEFAULT_POLICY, 'enterprise', { supplier: 20000 }, 'trialing').lifetime.supplier).toBe(20000);
    expect(effectiveLimits(DEFAULT_POLICY, 'enterprise', undefined, 'active').lifetime.ingredient).toBe(Number.POSITIVE_INFINITY);
  });
  it('keeps enterprise on the 2% ceiling unless status is active or trialing', () => {
    const capped = Math.floor(34388 * 0.02);
    expect(effectiveLimits(DEFAULT_POLICY, 'enterprise', { supplier: 20000 }).lifetime.supplier).toBe(capped);
    expect(effectiveLimits(DEFAULT_POLICY, 'enterprise', { supplier: 20000 }, 'canceled').lifetime.supplier).toBe(capped);
    expect(effectiveLimits(DEFAULT_POLICY, 'enterprise', { supplier: 20000 }, 'past_due').selfServe).toBe(true);
  });
  it('ignores contract overrides on self-serve tiers', () => {
    expect(effectiveLimits(DEFAULT_POLICY, 'free', { supplier: 20000 }).lifetime.supplier).toBe(10);
  });
});

describe('lifetime caps through the tools', () => {
  it('hits the ingredient cap and returns the custom contract message', async () => {
    const { call } = await connect({ account: account('free'), policy: smallPolicy() });
    for (const id of ['i1', 'i2', 'i3']) expect((await call('get_ingredient', { ingredient_id: id })).isError).toBeFalsy();
    const r = await call('get_ingredient', { ingredient_id: 'i4' });
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe('cap_exceeded');
    expect(r.json.message).toContain('journeyfoods.io');
    expect(r.json.message).toContain('custom contract');
    expect(r.json.message).toContain('Thank you');
    expect(r.json.message.toLowerCase()).not.toContain('thanks');
  });
  it('still serves records the account already received after the cap', async () => {
    const { call } = await connect({ account: account('free'), policy: smallPolicy() });
    for (const id of ['i1', 'i2', 'i3']) await call('get_ingredient', { ingredient_id: id });
    expect((await call('get_ingredient', { ingredient_id: 'i2' })).isError).toBeFalsy();
  });
  it('enforces the 2% ingredient ceiling on the startup tier', async () => {
    const policy = { ...DEFAULT_POLICY, totals: { ...DEFAULT_POLICY.totals, ingredient: 150 }, tiers: { ...DEFAULT_POLICY.tiers, startup: { ...DEFAULT_POLICY.tiers.startup, requestsPerMinute: 1000 } } };
    expect(effectiveLimits(policy, 'startup').lifetime.ingredient).toBe(3);
    const data = new MockData(0, 6);
    const enforcer = new PolicyEnforcer(policy, new MemoryUsageStore());
    const acct = account('startup', 'acct:bulk');
    const { call } = await connect({ account: acct, data, enforcer, policy });
    for (const id of ['i1', 'i2', 'i3']) expect((await call('get_ingredient', { ingredient_id: id })).isError).toBeFalsy();
    const r = await call('get_ingredient', { ingredient_id: 'i4' });
    expect(r.json.error).toBe('cap_exceeded');
    expect(r.json.message).toContain('3 ingredients');
  });
  it('blocks supplier records on the Fresh plan', async () => {
    const { call } = await connect({ account: account('fresh', 'acct:fresh') });
    const r = await call('search_suppliers', { query: 'pea', limit: 2 });
    expect(r.json.error).toBe('cap_exceeded');
    expect(r.json.message).toContain('supplier network');
  });
  it('withholds search results beyond the supplier cap with a notice, then refuses', async () => {
    const { call } = await connect({ account: account('free'), policy: smallPolicy() });
    const first = await call('search_suppliers', { query: 'pea', limit: 4 });
    expect(first.structuredContent.returned).toBe(4);
    const second = await call('search_suppliers', { query: 'pea', limit: 10 });
    expect(second.structuredContent.returned).toBe(5); // 4 already seen + 1 new
    expect(second.structuredContent.notice).toContain('journeyfoods.io');
    const third = await call('get_supplier', { supplier_id: 's20' });
    expect(third.json.error).toBe('cap_exceeded');
  });
  it('blocks compare_suppliers when the cap leaves fewer than two suppliers', async () => {
    const { call } = await connect({ account: account('free'), policy: smallPolicy() });
    await call('search_suppliers', { query: 'pea', limit: 5 });
    const r = await call('compare_suppliers', { supplier_ids: ['s10', 's11'] });
    expect(r.json.error).toBe('cap_exceeded');
  });
  it('caps price series and lab results', async () => {
    const { call } = await connect({ account: account('free'), policy: smallPolicy() });
    expect((await call('get_ingredient_price', { ingredient: 'cocoa' })).isError).toBeFalsy();
    expect((await call('verify_lab_result', { subject: 'oats', result_id: 'r1' })).isError).toBeFalsy();
    expect((await call('verify_lab_result', { subject: 'rice', result_id: 'r2' })).isError).toBeFalsy();
    expect((await call('verify_lab_result', { subject: 'corn', result_id: 'r3' })).json.error).toBe('cap_exceeded');
  });
  it('enforces the cross-entity lifetime total', async () => {
    const p = smallPolicy();
    p.tiers.free.lifetimeTotal = 3;
    const { call } = await connect({ account: account('free'), policy: p });
    await call('search_suppliers', { query: 'pea', limit: 3 });
    expect((await call('get_ingredient', { ingredient_id: 'i1' })).json.error).toBe('cap_exceeded');
  });
  it('keeps caps per account', async () => {
    const enforcer = new PolicyEnforcer(smallPolicy(), new MemoryUsageStore());
    const a = await connect({ account: account('free', 'acct:a'), enforcer });
    const b = await connect({ account: account('free', 'acct:b'), enforcer });
    for (const id of ['i1', 'i2', 'i3']) await a.call('get_ingredient', { ingredient_id: id });
    expect((await a.call('get_ingredient', { ingredient_id: 'i4' })).isError).toBe(true);
    expect((await b.call('get_ingredient', { ingredient_id: 'i4' })).isError).toBeFalsy();
  });
  it('does not overshoot the cap under concurrent calls', async () => {
    const { call, enforcer } = await connect({ account: account('free', 'acct:race'), policy: smallPolicy() });
    await Promise.all(['i1', 'i2', 'i3', 'i4', 'i5', 'i6'].map((id) => call('get_ingredient', { ingredient_id: id })));
    const u = await enforcer.usage(account('free', 'acct:race'));
    expect(u.used.ingredient).toBe(3);
  });
});

describe('rate limits', () => {
  it('limits requests per minute per account and recovers after the window', async () => {
    let t = 1_000_000;
    const p = smallPolicy();
    p.tiers.free.requestsPerMinute = 3;
    const { call } = await connect({ account: account('free'), policy: p, now: () => t });
    for (let i = 0; i < 3; i++) expect((await call('get_supplier', { supplier_id: 's1' })).isError).toBeFalsy();
    const r = await call('get_supplier', { supplier_id: 's1' });
    expect(r.json.error).toBe('rate_limited');
    expect(r.json.message).toContain('Thank you');
    t += 61_000;
    expect((await call('get_supplier', { supplier_id: 's1' })).isError).toBeFalsy();
  });
});
