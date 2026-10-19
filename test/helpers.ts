import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/server.js';
import { PolicyEnforcer } from '../src/policy/enforcer.js';
import { DEFAULT_POLICY, type PolicyConfig } from '../src/policy/policy.js';
import { MemoryUsageStore } from '../src/policy/usage-store.js';
import { silentLogger } from '../src/logger.js';
import type { Account } from '../src/auth/account.js';
import type { Credential, Ingredient, JourneyData, LabResult, Price, PriceForecast, Product, ProductQuery, Supplier } from '../src/api/types.js';
import { NotConnectedError } from '../src/errors.js';

export const supplier = (id: string, extra: Partial<Supplier> = {}): Supplier => ({
  id,
  name: `Supplier ${id}`,
  country: 'Brazil',
  country_code: 'BR',
  categories: ['Food Ingredients'],
  certifications: ['Organic', 'Kosher'],
  ingredients: ['pea protein'],
  locations: [],
  verification_status: 'verified',
  ...extra,
});
export const ingredient = (id: string): Ingredient => ({ id, name: `Ingredient ${id}`, nutrition_score: 70, sustainability_score: 50, nutrition_per_100g: { protein: 2.7 } });

export class MockData implements JourneyData {
  suppliers = new Map<string, Supplier>();
  ingredients = new Map<string, Ingredient>();
  calls: string[] = [];
  labsConnected = true;
  constructor(nSuppliers = 30, nIngredients = 50) {
    for (let i = 1; i <= nSuppliers; i++) this.suppliers.set(`s${i}`, supplier(`s${i}`, i % 2 ? {} : { certifications: ['Organic', 'Halal'], country: 'Peru', country_code: 'PE' }));
    for (let i = 1; i <= nIngredients; i++) this.ingredients.set(`i${i}`, ingredient(`i${i}`));
    for (let i = 1; i <= 30; i++) {
      const id = i.toString(16).padStart(24, '0');
      this.products.set(id, { id, name: `Granola Bar ${i}`, status: 'active', ingredients: [{ name: 'oats', percentage: 40 }], nutrition: { protein: 6 }, serving_size: 40, serving_size_unit: 'g' });
    }
  }
  async searchSuppliers(q: { region?: string; limit: number }) {
    this.calls.push('searchSuppliers');
    return [...this.suppliers.values()].filter((s) => !q.region || s.country === q.region || s.country_code === q.region).slice(0, q.limit);
  }
  async getSupplier(id: string) {
    this.calls.push(`getSupplier:${id}`);
    return this.suppliers.get(id) ?? null;
  }
  async searchIngredients(q: string, limit: number) {
    this.calls.push(`searchIngredients:${q}`);
    return [...this.ingredients.values()].filter((i) => q === 'mango' || i.name.includes(q)).slice(0, limit);
  }
  async getIngredient(id: string) {
    this.calls.push(`getIngredient:${id}`);
    return this.ingredients.get(id) ?? null;
  }
  async getIngredientPrice(ing: string): Promise<Price | null> {
    if (ing.toLowerCase() !== 'cocoa') return null;
    return { series_id: 'commodity:COCOA', ingredient: ing, symbol: 'COCOA', unit: 'USD/mt', currency: 'USD', current: { price: 8123.4, as_of: '2026-09-01', change_pct: -2.1 }, history: [{ date: '2026-08-01', price: 8300 }, { date: '2026-09-01', price: 8123.4 }], source: 'IMF/FRED' };
  }
  products = new Map<string, Product>();
  async listPriceSeries() {
    return [{ symbol: 'COCOA', name: 'Cocoa', category: 'softs', unit: 'USD/mt', currency: 'USD' }];
  }
  async getPriceForecast(symbol: string): Promise<PriceForecast | null> {
    if (symbol !== 'COCOA') return null;
    return { published: true, horizon_unit: 'month', model: 'ets', beats_naive_by_pct: 12, points: [{ date: '2026-11-01', p10: 7000, p50: 8000, p90: 9000 }] };
  }
  async searchProducts(q: ProductQuery, cred: Credential) {
    if (!cred.appToken) throw new NotConnectedError('Product lookup');
    const all = [...this.products.values()].filter((p) => !q.query || p.name.toLowerCase().includes(q.query.toLowerCase()));
    const start = (q.page - 1) * q.limit;
    return { products: all.slice(start, start + q.limit).map(({ ingredients, nutrition, ...r }) => r), total: all.length };
  }
  async getProduct(id: string, cred: Credential) {
    if (!cred.appToken) throw new NotConnectedError('Product lookup');
    return this.products.get(id) ?? null;
  }
  async verifyLabResult(subject: string, resultId?: string, _cred?: Credential, opts: { includePdf?: boolean } = {}): Promise<LabResult> {
    if (!this.labsConnected) throw new NotConnectedError('Journey Labs verification lookup');
    if (subject === 'unknown') return { verified: false, subject };
    return { verified: true, result_id: resultId ?? 'JL-1', subject, lab: 'Journey Labs', accreditation: 'ISO/IEC 17025', summary: 'Gluten below 20 ppm.', tested_at: '2026-09-15', pdf_available: true, pdf_url: opts.includePdf ? 'https://storage.example.test/signed' : null };
  }
}

export const account = (tier: string | null = 'startup', id = 'acct:test', extra: Partial<Account> = {}): Account => ({ id, tier, authMethod: 'api_key', scopes: ['journey:read'], ...extra });

export async function connect(opts: { account?: Account; data?: MockData; policy?: PolicyConfig; enforcer?: PolicyEnforcer; now?: () => number } = {}) {
  const data = opts.data ?? new MockData();
  const enforcer = opts.enforcer ?? new PolicyEnforcer(opts.policy ?? DEFAULT_POLICY, new MemoryUsageStore(), opts.now);
  const server = createMcpServer({ account: opts.account ?? account(), data, enforcer, log: silentLogger });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text: string }[])[0]?.text ?? '';
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { ...r, json } as typeof r & { json: any; structuredContent?: any };
  };
  return { client, call, data, enforcer };
}

/** A policy with small caps so tests can hit them quickly. */
export const smallPolicy = (over: Partial<PolicyConfig> = {}): PolicyConfig => ({
  ...DEFAULT_POLICY,
  tiers: {
    ...DEFAULT_POLICY.tiers,
    free: { selfServe: true, requestsPerMinute: 1000, lifetime: { supplier: 5, ingredient: 3, price_series: 1, lab_result: 2 }, lifetimeTotal: 100 },
  },
  ...over,
});
