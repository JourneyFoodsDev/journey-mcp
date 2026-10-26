import { NotConnectedError, UpstreamError } from '../errors.js';
import type { JourneyConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { signEndUser } from '../auth/end-user.js';
import { JourneyHttpClient, unwrap } from './client.js';
import type { Credential, Ingredient, JourneyData, LabLookupOptions, LabResult, Price, PriceForecast, PriceSeriesSummary, Product, ProductQuery, ProductSummary, Supplier, SupplierQuery } from './types.js';

/**
 * Endpoint map. Base URLs come from the environment, with production defaults in loadConfig.
 *
 * Suppliers  -> Internal backend only (x-journey-service-key, never a user's x-api-key). No default base URL.
 *               GET /api/v1/supplier/profiles?search=  and  /api/v1/supplier/profiles/:slug
 * Ingredients-> Developer API https://devapi.journeyfoods.io (x-api-key): GET /ingredients/search?q=, /ingredients/:id, /nutrients/:id, /allergens/:id
 * Prices     -> Price feed https://price.journeyfoods.io (x-api-key): GET /api/v1/commodities, /api/v1/commodities/:symbol/quote|history|forecast
 *               Prices are commodity-level; ingredient -> commodity mapping is a name/symbol match.
 * Products   -> Journey app API, the signed-in user's own products (remote OAuth only):
 *               GET /api/v1/product/product-list, /api/v1/product/product-detail/:id
 * Labs       -> Journey app API: GET /api/v1/lab-results/verify (set JOURNEY_LABS_VERIFY_PATH to enable)
 */
export const ENDPOINTS = {
  supplierList: '/api/v1/supplier/profiles',
  supplierBySlug: (slug: string) => `/api/v1/supplier/profiles/${encodeURIComponent(slug)}`,
  ingredientSearch: '/ingredients/search',
  ingredientById: (id: string) => `/ingredients/${encodeURIComponent(id)}`,
  nutrientsById: (id: string) => `/nutrients/${encodeURIComponent(id)}`,
  allergensById: (id: string) => `/allergens/${encodeURIComponent(id)}`,
  commodityList: '/api/v1/commodities',
  productList: '/api/v1/product/product-list',
  productDetail: (id: string) => `/api/v1/product/product-detail/${encodeURIComponent(id)}`,
  commodity: (symbol: string, resource: 'quote' | 'history' | 'forecast') => `/api/v1/commodities/${encodeURIComponent(symbol)}/${resource}`,
};

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const strs = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? str((x as Record<string, unknown>).name) ?? str((x as Record<string, unknown>).city) ?? str((x as Record<string, unknown>).country) : null))
        .filter((x): x is string => Boolean(x))
    : [];

export function normalizeSupplier(row: Record<string, unknown>): Supplier {
  const id = str(row.slug) ?? str(row.id) ?? str(row._id);
  if (!id) throw new UpstreamError('Supplier record has no id.', 502, ENDPOINTS.supplierList);
  return {
    id,
    name: str(row.displayName) ?? str(row.name) ?? id,
    legal_name: str(row.legalName),
    website: str(row.website),
    country: str(row.country),
    country_code: str(row.countryCode),
    role: str(row.role),
    categories: strs(row.categories),
    certifications: strs(row.certifications),
    ingredients: strs(row.ingredients),
    locations: strs(row.locations),
    verification_status: str(row.verificationStatus),
    domain_verified: typeof row.domainVerified === 'boolean' ? row.domainVerified : null,
  };
}

function rejectSeeded(payload: unknown, endpoint: string) {
  const inner = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).data : undefined;
  const rec = inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : undefined;
  const rows = Array.isArray(rec?.data) ? (rec!.data as Record<string, unknown>[]) : [];
  if (rec?.mongo === false || rows.some((r) => r?.source === 'memory_seed')) {
    throw new UpstreamError('Live supplier data is unavailable right now, so no suppliers are listed.', 503, endpoint);
  }
}

export function normalizeIngredient(row: Record<string, unknown>): Ingredient {
  const id = str(row.id) ?? str(row._id);
  if (!id) throw new UpstreamError('Ingredient record has no id.', 502, ENDPOINTS.ingredientSearch);
  const macros: Record<string, number | null> = {};
  for (const k of ['energy', 'protein', 'fat', 'carbs', 'fiber', 'sodium', 'sugar']) if (k in row) macros[k] = num(row[k]);
  return {
    id,
    name: str(row.name) ?? id,
    image_url: str(row.image_url),
    nutrition_score: num(row.nutrition_score),
    sustainability_score: num(row.sustainability_score),
    nutrition_per_100g: Object.keys(macros).length ? macros : undefined,
  };
}

export function normalizeProduct(row: Record<string, unknown>, endpoint: string): ProductSummary {
  const id = str(row._id) ?? str(row.id);
  if (!id) throw new UpstreamError('Product record has no id.', 502, endpoint);
  const brand = row.brand && typeof row.brand === 'object' ? str((row.brand as Record<string, unknown>).name) : str(row.brand) ?? str(row.brandName);
  return {
    id,
    name: str(row.name) ?? id,
    status: str(row.status),
    category: str(row.category),
    sub_category: str(row.subCategory),
    brand,
    updated_at: str(row.updatedAt),
  };
}

const matches = (hay: string[], needle?: string) => !needle || hay.some((h) => h.toLowerCase().includes(needle.toLowerCase()));

export class RestJourneyData implements JourneyData {
  readonly dev: JourneyHttpClient;
  readonly suppliers: JourneyHttpClient;
  readonly prices: JourneyHttpClient;
  readonly labs: JourneyHttpClient;
  constructor(private readonly cfg: JourneyConfig, log: Logger, fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {
    this.dev = new JourneyHttpClient(cfg.apiBaseUrl, cfg.apiKey, log, fetchImpl, cfg.requestTimeoutMs, 'journey-dev-api');
    // No default key: the internal supplier backend takes x-journey-service-key, not the caller's x-api-key.
    this.suppliers = new JourneyHttpClient(cfg.supplierApiBaseUrl, undefined, log, fetchImpl, cfg.requestTimeoutMs, 'journey-supplier-api');
    this.prices = new JourneyHttpClient(cfg.priceApiBaseUrl, cfg.priceApiKey, log, fetchImpl, cfg.requestTimeoutMs, 'journey-price-api');
    // No default key: the verification summary is public, and the developer API key is never sent to the app API.
    this.labs = new JourneyHttpClient(cfg.labsApiBaseUrl, undefined, log, fetchImpl, cfg.requestTimeoutMs, 'journey-labs-api');
    // No default key: product calls only ever carry the signed-in user's own session.
    this.app = new JourneyHttpClient(cfg.appApiBaseUrl, undefined, log, fetchImpl, cfg.requestTimeoutMs, 'journey-app-api');
  }
  readonly app: JourneyHttpClient;

  /** End-user headers for one backend call. Empty when the signing secret or the identity is missing. */
  private endUserHeaders(cred: Credential, extra?: Record<string, string>): Record<string, string> {
    return { ...extra, ...signEndUser(cred.endUser ?? {}, this.cfg.endUserSigningSecret) };
  }

  private supplierHeaders(cred: Credential): Record<string, string> {
    return this.endUserHeaders(cred, this.cfg.supplierServiceKey ? { 'x-journey-service-key': this.cfg.supplierServiceKey } : undefined);
  }

  async searchSuppliers(q: SupplierQuery, cred: Credential): Promise<Supplier[]> {
    // Filters run server side (GET /api/v1/supplier/profiles with ingredient/category/region/certification).
    // The client-side filter below stays as a guard for API versions that ignore them.
    const payload = await this.suppliers.request(ENDPOINTS.supplierList, {
      query: { search: q.query, ingredient: q.ingredient, category: q.category, region: q.region, certification: q.certification, pageSize: q.limit, page: q.page },
      headers: this.supplierHeaders(cred),
    });
    rejectSeeded(payload, ENDPOINTS.supplierList);
    const rows = unwrap(payload);
    if (!Array.isArray(rows)) throw new UpstreamError('Supplier search returned an unexpected shape.', 502, ENDPOINTS.supplierList);
    return rows
      .map((r) => normalizeSupplier(r as Record<string, unknown>))
      .filter((s) => matches(s.ingredients, q.ingredient) || (q.ingredient ? matches([s.name], q.ingredient) : true))
      .filter((s) => matches(s.categories, q.category))
      .filter((s) => matches(s.certifications, q.certification))
      .filter((s) => matches([s.country ?? '', s.country_code ?? '', ...s.locations], q.region))
      .slice(0, q.limit);
  }

  async getSupplier(id: string, cred: Credential): Promise<Supplier | null> {
    const payload = await this.suppliers.request(ENDPOINTS.supplierBySlug(id), { headers: this.supplierHeaders(cred) });
    if (!payload) return null;
    const row = unwrap(payload);
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    if ((row as Record<string, unknown>).source === 'memory_seed') throw new UpstreamError('Live supplier data is unavailable right now.', 503, ENDPOINTS.supplierBySlug(id));
    return normalizeSupplier(row as Record<string, unknown>);
  }

  async searchIngredients(q: string, limit: number, cred: Credential): Promise<Ingredient[]> {
    const payload = await this.dev.request(ENDPOINTS.ingredientSearch, { query: { q }, apiKey: cred.apiKey, headers: this.endUserHeaders(cred) });
    const rows = unwrap(payload);
    if (!Array.isArray(rows)) throw new UpstreamError('Ingredient search returned an unexpected shape.', 502, ENDPOINTS.ingredientSearch);
    return rows.slice(0, limit).map((r) => normalizeIngredient(r as Record<string, unknown>));
  }

  async getIngredient(id: string, cred: Credential): Promise<Ingredient | null> {
    const headers = this.endUserHeaders(cred);
    const payload = await this.dev.request(ENDPOINTS.ingredientById(id), { apiKey: cred.apiKey, headers });
    if (!payload) return null;
    const row = unwrap(payload) as Record<string, unknown>;
    const base = normalizeIngredient(row);
    // Optional enrichments. Plan-gated upstream; a failure here does not fail the profile.
    const [nut, all] = await Promise.allSettled([
      this.dev.request(ENDPOINTS.nutrientsById(id), { apiKey: cred.apiKey, headers }),
      this.dev.request(ENDPOINTS.allergensById(id), { apiKey: cred.apiKey, headers }),
    ]);
    if (nut.status === 'fulfilled' && nut.value) {
      const n = unwrap(nut.value) as Record<string, unknown>;
      const nutrients: Record<string, string | number | null> = {};
      for (const [k, v] of Object.entries(n ?? {})) if (!['id', 'name', '_id'].includes(k) && (typeof v === 'string' || typeof v === 'number' || v === null)) nutrients[k] = v;
      base.nutrients = nutrients;
    }
    if (all.status === 'fulfilled' && all.value) {
      const a = unwrap(all.value) as Record<string, unknown>;
      base.allergens = strs(a?.allergens_flat);
      base.allergens_by_country = strs(a?.allergens_by_country);
    }
    const attrs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) if (!(k in base) && !['_id', 'energy', 'protein', 'fat', 'carbs', 'fiber', 'sodium', 'sugar'].includes(k)) attrs[k] = v;
    if (Object.keys(attrs).length) base.attributes = attrs;
    return base;
  }

  async getIngredientPrice(ingredient: string, days: number, _cred: Credential): Promise<Price | null> {
    const list = unwrap(await this.prices.request(ENDPOINTS.commodityList));
    if (!Array.isArray(list)) throw new UpstreamError('Price list returned an unexpected shape.', 502, ENDPOINTS.commodityList);
    const want = ingredient.trim().toLowerCase();
    const hit = (list as Record<string, unknown>[]).find((c) => {
      const sym = String(c.symbol ?? '').toLowerCase();
      const name = String(c.name ?? '').toLowerCase();
      return sym === want || name === want || (want.length > 2 && name.includes(want));
    });
    if (!hit) return null;
    const symbol = String(hit.symbol);
    const [quoteRaw, histRaw] = await Promise.all([
      this.prices.request(ENDPOINTS.commodity(symbol, 'quote')),
      this.prices.request(ENDPOINTS.commodity(symbol, 'history'), { query: { days } }),
    ]);
    const quote = (unwrap(quoteRaw) ?? {}) as Record<string, unknown>;
    const histObj = (histRaw ?? {}) as Record<string, unknown>;
    const series = Array.isArray(histObj.data) ? (histObj.data as Record<string, unknown>[]) : [];
    return {
      series_id: `commodity:${symbol}`,
      ingredient,
      symbol,
      unit: str(hit.unit) ?? str(histObj.unit),
      currency: str(hit.currency) ?? str(histObj.currency),
      current: { price: num(quote.price ?? quote.last ?? quote.value), as_of: str(quote.date ?? quote.asOf), change_pct: num(quote.changePct ?? quote.change_pct) },
      history: series
        .map((p) => ({ date: str(p.date ?? p.month) ?? '', price: num(p.price ?? p.value ?? p.close) }))
        .filter((p): p is { date: string; price: number } => Boolean(p.date) && p.price !== null),
      source: str(histObj.source),
      methodology_url: str(histObj.methodologyUrl),
    };
  }

  /**
   * Journey Labs verification summary from the Journey app API (GET /api/v1/lab-results/verify).
   * The summary counts only results Journey staff marked verified. PDF links are for paid tiers only,
   * through a service-key endpoint that returns a 15-minute signed URL.
   */
  async verifyLabResult(subject: string, resultId: string | undefined, cred: Credential, opts: LabLookupOptions = {}): Promise<LabResult> {
    if (!this.cfg.labsVerifyPath) throw new NotConnectedError('Journey Labs verification lookup');
    const subjectType = opts.subjectType ?? 'ingredient';
    const payload = await this.labs.request(this.cfg.labsVerifyPath, { query: { subjectType, subjectId: subject }, headers: this.endUserHeaders(cred) });
    // Unwrap only the { data } envelope: the generic unwrap would descend into `results`.
    const body = (payload ?? {}) as Record<string, unknown>;
    const r = ((body.data && typeof body.data === 'object' ? body.data : body) ?? {}) as Record<string, unknown>;
    const results = (Array.isArray(r.results) ? r.results : []) as Record<string, unknown>[];
    const hit = resultId ? results.find((x) => String(x.id) === resultId) : results[0];
    const subj = (r.subject ?? {}) as Record<string, unknown>;
    const status = (['verified', 'revoked', 'none'] as const).find((x) => x === r.status) ?? 'none';
    const out: LabResult = {
      verified: Boolean(hit) && r.verified === true,
      result_id: hit ? str(hit.id) : null,
      subject: str(subj.name) ?? subject,
      subject_type: subjectType,
      status: hit ? 'verified' : status === 'verified' ? 'none' : status,
      tested_at: hit ? str(hit.testedOn) : null,
      lab: hit ? str(hit.lab) : null,
      accreditation: hit ? str(hit.accreditation) : null,
      summary: hit ? [str(hit.test), num(hit.analytes) ? `${num(hit.analytes)} analytes` : null].filter(Boolean).join(', ') || null : null,
      verification_url: null,
      pdf_available: Boolean(hit?.hasPdf),
    };
    if (hit?.hasPdf && opts.includePdf && this.cfg.labsServiceKey) {
      try {
        const link = unwrap(await this.labs.request(`/api/v1/lab-results/${encodeURIComponent(String(hit.id))}/pdf`, {
          headers: this.endUserHeaders(cred, { 'x-journey-service-key': this.cfg.labsServiceKey }),
        })) as Record<string, unknown> | null;
        out.pdf_url = str(link?.url);
      } catch {
        out.pdf_url = null;
      }
    }
    return out;
  }

  async listPriceSeries(_cred: Credential): Promise<PriceSeriesSummary[]> {
    const list = unwrap(await this.prices.request(ENDPOINTS.commodityList));
    if (!Array.isArray(list)) throw new UpstreamError('Price list returned an unexpected shape.', 502, ENDPOINTS.commodityList);
    // Names and units only: the list never includes prices, so it does not count toward any cap.
    return (list as Record<string, unknown>[])
      .map((c) => ({ symbol: String(c.symbol ?? ''), name: str(c.name) ?? String(c.symbol ?? ''), category: str(c.category), unit: str(c.unit), currency: str(c.currency) }))
      .filter((c) => c.symbol);
  }

  async getPriceForecast(symbol: string, days: number, _cred: Credential): Promise<PriceForecast | null> {
    const raw = (await this.prices.request(ENDPOINTS.commodity(symbol, 'forecast'), { query: { days } })) as Record<string, unknown> | null;
    if (!raw) return null;
    const pts = Array.isArray(raw.data) ? (raw.data as Record<string, unknown>[]) : [];
    return {
      published: raw.published === true,
      horizon_unit: str(raw.horizonUnit),
      model: str(raw.model),
      beats_naive_by_pct: num(raw.beatsNaiveByPct),
      points: pts
        .map((p) => ({ date: str(p.date) ?? '', p10: num(p.p10), p50: num(p.p50), p90: num(p.p90) }))
        .filter((p): p is { date: string; p10: number; p50: number; p90: number } => Boolean(p.date) && p.p10 !== null && p.p50 !== null && p.p90 !== null),
    };
  }

  available(feature: 'ingredients' | 'labs' | 'products' | 'prices' | 'suppliers', cred: Credential): boolean {
    switch (feature) {
      case 'ingredients':
        return Boolean(this.cfg.apiBaseUrl && (cred.apiKey || this.cfg.apiKey));
      case 'labs':
        return Boolean(this.cfg.labsVerifyPath && this.cfg.labsApiBaseUrl);
      case 'products':
        return Boolean(this.cfg.appApiBaseUrl && cred.appToken);
      case 'prices':
        return Boolean(this.cfg.priceApiBaseUrl && this.cfg.priceApiKey);
      case 'suppliers':
        return Boolean(this.cfg.supplierApiBaseUrl);
    }
  }

  private requireSession(cred: Credential): string {
    if (!cred.appToken) {
      throw new NotConnectedError('Product data needs a signed-in Journey app account (connect through the remote server with OAuth). Product lookup');
    }
    return cred.appToken;
  }

  async searchProducts(q: ProductQuery, cred: Credential): Promise<{ products: ProductSummary[]; total: number | null }> {
    const bearer = this.requireSession(cred);
    const payload = (await this.app.request(ENDPOINTS.productList, { query: { search: q.query, page: q.page, limit: q.limit, status: q.status }, bearer, headers: this.endUserHeaders(cred) })) as Record<string, unknown> | null;
    const inner = payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? (payload.data as Record<string, unknown>) : payload;
    const rows = unwrap(inner);
    if (!Array.isArray(rows)) throw new UpstreamError('Product list returned an unexpected shape.', 502, ENDPOINTS.productList);
    return { products: rows.slice(0, q.limit).map((r) => normalizeProduct(r as Record<string, unknown>, ENDPOINTS.productList)), total: num(inner?.total) };
  }

  async getProduct(id: string, cred: Credential): Promise<Product | null> {
    const bearer = this.requireSession(cred);
    const endpoint = ENDPOINTS.productDetail(id);
    const payload = await this.app.request(endpoint, { bearer, headers: this.endUserHeaders(cred) });
    if (!payload) return null;
    const row = unwrap(payload);
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const r = row as Record<string, unknown>;
    const base = normalizeProduct({ _id: id, ...r }, endpoint);
    const ingredients = Array.isArray(r.ingredients)
      ? (r.ingredients as unknown[]).map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : { name: String(x) }))
      : undefined;
    const nutrition = r.nutrition && typeof r.nutrition === 'object' ? (r.nutrition as Record<string, unknown>) : null;
    return {
      ...base,
      ingredients,
      nutrition,
      nutrition_score: r.Nutrition,
      serving_size: r['Serving Size'],
      serving_size_unit: str(r.unitServingSize),
    };
  }
}
