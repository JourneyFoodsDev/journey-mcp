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
export function readGuavaProduct(row: Record<string, unknown>): GuavaProduct | null {
  const id = str(row.id) ?? str(row._id);
  const name = str(row.name);
  if (!id || !name) return null;
  const ingredients = Array.isArray(row.ingredients)
    ? row.ingredients.map((item) => (typeof item === 'string' ? item : str(asRecord(item)?.name))).filter((item): item is string => Boolean(item))
    : undefined;
  const nutritionIn = asRecord(row.nutrition);
  const nutrition = nutritionIn
    ? Object.fromEntries(Object.entries(nutritionIn).map(([key, value]) => [key, num(value) ?? null]))
    : undefined;
  const priceIn = asRecord(row.price_context) ?? asRecord(row.priceContext);
  const score = num(row.guava_score) ?? num(row.guavaScore) ?? num(row.score);
  const product: GuavaProduct = {
    id,
    name,
    ...(str(row.barcode) ? { barcode: str(row.barcode) } : {}),
    ...(str(row.brand) ? { brand: str(row.brand) } : {}),
    ...(str(row.source) ? { source: str(row.source) } : {}),
    ...(score != null ? { guava_score: score } : {}),
    ...(ingredients ? { ingredients } : {}),
    ...(nutrition ? { nutrition } : {}),
  };
  if (priceIn) {
    const amount = num(priceIn.amount);
    const currency = str(priceIn.currency);
    const note = str(priceIn.note);
    if (amount != null || currency || note) product.price_context = { ...(currency ? { currency } : {}), ...(amount != null ? { amount } : {}), ...(note ? { note } : {}) };
  }
  return product;
}

function summaryOf(product: GuavaProduct): GuavaProductSummary {
  return { id: product.id, name: product.name, ...(product.barcode ? { barcode: product.barcode } : {}), ...(product.brand ? { brand: product.brand } : {}), ...(product.source ? { source: product.source } : {}) };
}

/**
 * Calls a Guava catalog that speaks GET /v1/products and GET /v1/products/:id.
 * This is not a guessed withguava.io route. Leave the base URL unset until the real catalog is known.
 */
export class RestGuavaCatalog implements GuavaCatalog {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 15000) {}

  async search(q: GuavaQuery): Promise<GuavaProductSummary[]> {
    const url = new URL('/v1/products', this.baseUrl);
    if (q.query) url.searchParams.set('query', q.query);
    if (q.barcode) url.searchParams.set('barcode', q.barcode);
    url.searchParams.set('limit', String(q.limit));
    const payload = await this.getJson(url);
    return rowsOf(payload).map(readGuavaProduct).filter((row): row is GuavaProduct => Boolean(row)).slice(0, q.limit).map(summaryOf);
  }

  async get(id: string): Promise<GuavaProduct | null> {
    const url = new URL(`/v1/products/${encodeURIComponent(id)}`, this.baseUrl);
    const payload = await this.getJson(url, true);
    if (payload == null) return null;
    const root = asRecord(payload);
    const row = asRecord(root?.product) ?? root;
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

