import { describe, it, expect } from 'vitest';
import { connect, MockData, account } from './helpers.js';
import { TOOL_NAMES } from '../src/tools.js';

describe('tool registry', () => {
  it('exposes exactly the six read-only tools with input and output schemas', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) {
      expect(t.description && t.description.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe('object');
      expect(t.outputSchema?.type).toBe('object');
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
    }
  });

  it('never uses "thanks" in tool copy', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(JSON.stringify(tools).toLowerCase()).not.toContain('thanks');
  });
});

describe('search_suppliers', () => {
  it('returns structured suppliers filtered by region', async () => {
    const { call } = await connect();
    const r = await call('search_suppliers', { region: 'PE', limit: 5 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.returned).toBe(5);
    expect(r.structuredContent.suppliers.every((s: any) => s.country_code === 'PE')).toBe(true);
  });
  it('requires at least one filter', async () => {
    const { call } = await connect();
    const r = await call('search_suppliers', {});
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe('invalid_arguments');
  });
  it('rejects a limit above 25 through the input schema', async () => {
    const { call } = await connect();
    const r = await call('search_suppliers', { query: 'pea', limit: 100 });
    expect(r.isError).toBe(true);
  });
});

describe('get_supplier', () => {
  it('returns a full profile', async () => {
    const { call } = await connect();
    const r = await call('get_supplier', { supplier_id: 's1' });
    expect(r.structuredContent.supplier).toMatchObject({ id: 's1', name: 'Supplier s1', certifications: ['Organic', 'Kosher'] });
  });
  it('returns not_found for unknown suppliers', async () => {
    const { call } = await connect();
    const r = await call('get_supplier', { supplier_id: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe('not_found');
  });
});

describe('get_ingredient', () => {
  it('looks up by id', async () => {
    const { call } = await connect();
    const r = await call('get_ingredient', { ingredient_id: 'i2' });
    expect(r.structuredContent).toMatchObject({ matched_by: 'id', ingredient: { id: 'i2' } });
  });
  it('looks up by name', async () => {
    const { call } = await connect();
    const r = await call('get_ingredient', { name: 'mango' });
    expect(r.structuredContent.matched_by).toBe('name');
    expect(r.structuredContent.ingredient.id).toBe('i1');
  });
  it('requires an id or name', async () => {
    const { call } = await connect();
    expect((await call('get_ingredient', {})).isError).toBe(true);
  });
});

describe('get_ingredient_price', () => {
  it('returns current price and history', async () => {
    const { call } = await connect();
    const r = await call('get_ingredient_price', { ingredient: 'cocoa', days: 90 });
    expect(r.structuredContent.price).toMatchObject({ symbol: 'COCOA', current: { price: 8123.4 } });
    expect(r.structuredContent.price.history).toHaveLength(2);
  });
  it('returns not_found for an unpriced ingredient', async () => {
    const { call } = await connect();
    const r = await call('get_ingredient_price', { ingredient: 'saffron' });
    expect(r.json.error).toBe('not_found');
  });
});

describe('compare_suppliers', () => {
  it('compares 2-5 suppliers and computes shared certifications', async () => {
    const { call } = await connect();
    const r = await call('compare_suppliers', { supplier_ids: ['s1', 's2', 's3'] });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.suppliers).toHaveLength(3);
    expect(r.structuredContent.comparison.shared_certifications).toEqual(['Organic']);
    expect(r.structuredContent.comparison.by_supplier[1].unique_certifications).toEqual(['Halal']);
  });
  it('rejects fewer than two or more than five ids', async () => {
    const { call } = await connect();
    expect((await call('compare_suppliers', { supplier_ids: ['s1'] })).isError).toBe(true);
    expect((await call('compare_suppliers', { supplier_ids: ['s1', 's2', 's3', 's4', 's5', 's6'] })).isError).toBe(true);
  });
  it('reports suppliers that were not found', async () => {
    const { call } = await connect();
    const r = await call('compare_suppliers', { supplier_ids: ['s1', 's2', 'missing'] });
    expect(r.structuredContent.not_found).toEqual(['missing']);
  });
});

describe('verify_lab_result', () => {
  it('returns a verified summary', async () => {
    const { call } = await connect();
    const r = await call('verify_lab_result', { subject: 'Oat flour', result_id: 'JL-42' });
    expect(r.structuredContent.result).toMatchObject({ verified: true, result_id: 'JL-42', lab: 'Journey Labs' });
  });
  it('includes the PDF link for paid tiers only', async () => {
    const paid = await connect({ account: account('startup') });
    expect((await paid.call('verify_lab_result', { subject: 'ing-1' })).structuredContent.result.pdf_url).toBe('https://storage.example.test/signed');
    const free = await connect({ account: account('trial', 'acct:free') });
    const r = (await free.call('verify_lab_result', { subject: 'ing-1' })).structuredContent.result;
    expect(r.pdf_available).toBe(true);
    expect(r.pdf_url).toBeNull();
  });
  it('returns verified:false when there is no result', async () => {
    const { call } = await connect();
    const r = await call('verify_lab_result', { subject: 'unknown' });
    expect(r.structuredContent.result.verified).toBe(false);
  });
  it('fails clearly when the Labs lookup is not connected', async () => {
    const data = new MockData();
    data.labsConnected = false;
    const { call } = await connect({ data, account: account('startup') });
    const r = await call('verify_lab_result', { subject: 'Oat flour' });
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe('not_connected');
  });
});
