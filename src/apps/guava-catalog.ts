import { z } from 'zod';
import { UpstreamError } from '../errors.js';

export const GuavaProductSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  barcode: z.string().nullable().optional(),
  brand: z.string().nullable().optional(),
  /** Present only when the upstream record is labeled, such as a test fixture. */
  source: z.string().optional(),
});
export type GuavaProductSummary = z.infer<typeof GuavaProductSummarySchema>;

export const GuavaPriceContextSchema = z.object({
  currency: z.string().nullable().optional(),
  amount: z.number().nullable().optional(),
  note: z.string().nullable().optional(),
});

export const GuavaProductSchema = GuavaProductSummarySchema.extend({
  guava_score: z.number().nullable().optional(),
  ingredients: z.array(z.string()).optional(),
  nutrition: z.record(z.number().nullable()).optional(),
  price_context: GuavaPriceContextSchema.nullable().optional(),
});
export type GuavaProduct = z.infer<typeof GuavaProductSchema>;

export interface GuavaQuery {
  query?: string;
  barcode?: string;
  limit: number;
}

/** Catalog adapter. Implementations return only fields the upstream sent. */
export interface GuavaCatalog {
  search(q: GuavaQuery): Promise<GuavaProductSummary[]>;
  get(id: string): Promise<GuavaProduct | null>;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Mongo extended JSON used by the Guava D1 snapshot. Missing and JSON null stay missing. */
export function mongoScalar(value: unknown): unknown {
  const rec = asRecord(value);
  if (!rec) return value;
  if (typeof rec.$oid === 'string') return rec.$oid;
  const token = rec.$numberInt ?? rec.$numberDouble ?? rec.$numberLong;
  if (typeof token === 'string' || typeof token === 'number') {
    const n = Number(token);
    return Number.isFinite(n) ? n : undefined;
  }
  return value;
}

export function mongoNumber(value: unknown): number | undefined {
  const scalar = mongoScalar(value);
  return typeof scalar === 'number' && Number.isFinite(scalar) ? scalar : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function rowsOf(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((row): row is Record<string, unknown> => Boolean(asRecord(row)));
  const root = asRecord(payload);
  const list = root?.products ?? root?.data ?? root?.results;
  return Array.isArray(list) ? list.filter((row): row is Record<string, unknown> => Boolean(asRecord(row))) : [];
}

/** Copy a catalog product. Scores and prices are omitted when the payload does not include a number. */
function nutritionOf(row: Record<string, unknown>): Record<string, number | null> | undefined {
  const out: Record<string, number | null> = {};
  const block = asRecord(row.nutrition);
  if (block) {
    for (const [key, value] of Object.entries(block)) {
      const n = mongoNumber(value);
      if (n != null) out[key] = n;
    }
  }
  const nutritionScore = mongoNumber(row.nutritionScore);
  const sustainabilityScore = mongoNumber(row.sustainabilityScore);
  if (nutritionScore != null && out.nutrition_score == null) out.nutrition_score = nutritionScore;
  if (sustainabilityScore != null && out.sustainability_score == null) out.sustainability_score = sustainabilityScore;
  return Object.keys(out).length ? out : undefined;
}

function priceOf(row: Record<string, unknown>): GuavaProduct['price_context'] | undefined {
  const priceIn = asRecord(row.price_context) ?? asRecord(row.priceContext);
  if (priceIn && (priceIn.amount != null || priceIn.currency != null || priceIn.note != null)) {
    const amount = num(priceIn.amount) ?? mongoNumber(priceIn.amount);
    const currency = str(priceIn.currency);
    const note = str(priceIn.note);
    if (amount != null || currency || note) return { ...(currency ? { currency } : {}), ...(amount != null ? { amount } : {}), ...(note ? { note } : {}) };
  }
  const amount = mongoNumber(row.price);
  return amount != null ? { amount } : undefined;
}

export function readGuavaProduct(row: Record<string, unknown>): GuavaProduct | null {
  const id = str(mongoScalar(row.id)) ?? str(mongoScalar(row._id));
  const name = str(row.name);
  if (!id || !name) return null;
  const ingredients = Array.isArray(row.ingredients)
    ? row.ingredients.map((item) => (typeof item === 'string' ? item : str(asRecord(item)?.name))).filter((item): item is string => Boolean(item))
    : undefined;
  // Only the stored Guava Score. A missing or null score is omitted, never calculated.
  const score = mongoNumber(row.guava_score ?? row.guavaScore);
  const nutrition = nutritionOf(row);
  const price = priceOf(row);
  const product: GuavaProduct = {
    id,
    name,
    ...(str(row.barcode) ? { barcode: str(row.barcode) } : {}),
    ...(str(row.brand) ? { brand: str(row.brand) } : {}),
    ...(str(row.source) ? { source: str(row.source) } : {}),
    ...(score != null ? { guava_score: score } : {}),
    ...(ingredients?.length ? { ingredients } : {}),
    ...(nutrition ? { nutrition } : {}),
    ...(price ? { price_context: price } : {}),
  };
  return product;
}

function summaryOf(product: GuavaProduct): GuavaProductSummary {
  return { id: product.id, name: product.name, ...(product.barcode ? { barcode: product.barcode } : {}), ...(product.brand ? { brand: product.brand } : {}), ...(product.source ? { source: product.source } : {}) };
}

/** Public catalog on this host, after the Worker is deployed with the D1 binding. */
export const HOSTED_GUAVA_CATALOG_URL = 'https://mcp.journeyfoods.io/apps/guava/';

/**
 * Calls GET {base}/v1/products and GET {base}/v1/products/:id.
 * Base `https://mcp.journeyfoods.io/apps/guava` is the route this Worker serves from the Guava D1 snapshot.
 */
export class RestGuavaCatalog implements GuavaCatalog {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 15000) {}

  async search(q: GuavaQuery): Promise<GuavaProductSummary[]> {
    const url = new URL('v1/products', this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`);
    if (q.query) url.searchParams.set('query', q.query);
    if (q.barcode) url.searchParams.set('barcode', q.barcode);
    url.searchParams.set('limit', String(q.limit));
    const payload = await this.getJson(url);
    return rowsOf(payload).map(readGuavaProduct).filter((row): row is GuavaProduct => Boolean(row)).slice(0, q.limit).map(summaryOf);
  }

  async get(id: string): Promise<GuavaProduct | null> {
    const root = this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`;
    const url = new URL(`v1/products/${encodeURIComponent(id)}`, root);
    const payload = await this.getJson(url, true);
    if (payload == null) return null;
    const body = asRecord(payload);
    const row = asRecord(body?.product) ?? body;
    return row ? readGuavaProduct(row) : null;
  }

  private async getJson(url: URL, allow404 = false): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
      if (allow404 && res.status === 404) return null;
      if (!res.ok) throw new UpstreamError(`Guava catalog request failed (${res.status}). No product data was returned.`, res.status, url.pathname);
      return await res.json();
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      throw new UpstreamError('Guava catalog request failed. No product data was returned.', 502, url.pathname);
    } finally {
      clearTimeout(timer);
    }
  }
}

