import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { JourneyError, NotConnectedError } from './errors.js';
import { capNotice, type Enforcer } from './policy/enforcer.js';
import type { Logger } from './logger.js';
import type { Account } from './auth/account.js';
import type { Entity } from './policy/policy.js';
import { classifyClient, type UsageEvent, type UsageSink } from './telemetry/usage-events.js';
import {
  IngredientSchema,
  IngredientSummarySchema,
  LabResultSchema,
  PriceForecastSchema,
  PriceSchema,
  PriceSeriesSummarySchema,
  ProductSchema,
  ProductSummarySchema,
  SupplierSchema,
  type JourneyData,
  type PriceForecast,
  type LabSubjectType,
} from './api/types.js';

export interface ToolContext {
  account: Account;
  data: JourneyData;
  enforcer: Enforcer;
  log: Logger;
  /** Where usage events go. Optional so tests and embedders can leave it out. */
  usage?: UsageSink;
  /** Client identity for usage reporting: MCP clientInfo (when known) and the HTTP user agent. */
  client?: () => { name?: string; version?: string; userAgent?: string };
  transport?: UsageEvent['transport'];
  /** Runs before each call (the Worker refreshes the user's session and tier here). */
  prepare?: () => Promise<void>;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const notice = z.string().optional().describe('Present when results were limited by the account data access policy.');

function ok(structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
}

function fail(e: unknown): CallToolResult {
  const message = e instanceof JourneyError ? e.message : 'Journey request failed. No data was returned.';
  const code = e instanceof JourneyError ? e.code : 'internal_error';
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }] };
}

/** Per-call wrapper around the enforcer that tallies the records each call returns and withholds. */
function tallying(ctx: ToolContext) {
  const records: Record<string, number> = {};
  let withheld = 0;
  const enforcer: Enforcer = {
    checkRate: (a) => ctx.enforcer.checkRate(a),
    assertCapacity: (a, e) => ctx.enforcer.assertCapacity(a, e),
    capErrorFor: (a, d) => ctx.enforcer.capErrorFor(a, d),
    usage: (a) => ctx.enforcer.usage(a),
    async admit(a, e, items, idOf) {
      const r = await ctx.enforcer.admit(a, e, items, idOf);
      records[e] = (records[e] ?? 0) + r.allowed.length;
      withheld += r.withheld;
      return r;
    },
  };
  // Object.create keeps lazy getters on ctx (the Worker resolves account and data per call).
  const call = Object.create(ctx, { enforcer: { value: enforcer } }) as ToolContext;
  return { call, records, withheld: () => withheld };
}

function outcomeOf(e: unknown): UsageEvent['outcome'] {
  const code = e instanceof JourneyError ? e.code : 'internal_error';
  if (code === 'cap_exceeded') return 'cap_exceeded';
  if (code === 'rate_limited') return 'rate_limited';
  if (code === 'not_connected') return 'not_connected';
  return 'error';
}

async function emitUsage(ctx: ToolContext, tool: string, started: number, outcome: UsageEvent['outcome'], errorCode: string | undefined, t: ReturnType<typeof tallying>) {
  if (!ctx.usage) return;
  try {
    let capMax = 0;
    let capEntity: string | undefined;
    try {
      const u = await ctx.enforcer.usage(ctx.account);
      for (const [e, n] of Object.entries(u.used)) {
        const lim = u.limits.lifetime[e as Entity];
        if (lim && lim > 0 && n / lim > capMax) {
          capMax = n / lim;
          capEntity = e;
        }
      }
    } catch {
      /* usage lookup is best effort */
    }
    const c = ctx.client?.() ?? {};
    await ctx.usage.emit({
      v: 1,
      ts: new Date().toISOString(),
      account: ctx.account.id,
      tier: ctx.account.tier ?? 'default',
      auth: ctx.account.authMethod,
      tool,
      outcome,
      ...(errorCode ? { error_code: errorCode } : {}),
      records: t.records,
      withheld: t.withheld(),
      cap_used_max: Math.round(capMax * 1000) / 1000,
      ...(capEntity ? { cap_entity_max: capEntity } : {}),
      client: classifyClient(c.name, c.userAgent),
      ...(c.version ? { client_version: c.version.slice(0, 40) } : {}),
      ...(c.userAgent ? { user_agent: c.userAgent.slice(0, 200) } : {}),
      transport: ctx.transport ?? 'http',
      latency_ms: Date.now() - started,
    });
  } catch (e) {
    ctx.log.warn('usage event failed', { tool, detail: (e as Error).message });
  }
}

/** Wraps every tool: rate limit, request logging, usage events, uniform error handling. */
function run<A>(ctx: ToolContext, tool: string, fn: (args: A, ctx: ToolContext) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    const started = Date.now();
    const t = tallying(ctx);
    try {
      if (ctx.prepare) await ctx.prepare();
      await ctx.enforcer.checkRate(ctx.account);
      const result = await fn(args, t.call);
      ctx.log.info('tool call', { tool, account: ctx.account.id, tier: ctx.account.tier ?? 'default', auth: ctx.account.authMethod, ms: Date.now() - started, outcome: result.isError ? 'error' : 'ok' });
      let code: string | undefined;
      if (result.isError) {
        try {
          code = JSON.parse((result.content[0] as { text: string }).text).error;
        } catch {
          code = 'error';
        }
      }
      await emitUsage(ctx, tool, started, result.isError ? (code === 'not_connected' ? 'not_connected' : 'error') : 'ok', code, t);
      return result;
    } catch (e) {
      const level = e instanceof JourneyError && e.status < 500 ? 'warn' : 'error';
      ctx.log[level]('tool call failed', { tool, account: ctx.account.id, ms: Date.now() - started, error: e instanceof JourneyError ? e.code : 'internal_error', detail: (e as Error).message });
      await emitUsage(ctx, tool, started, outcomeOf(e), e instanceof JourneyError ? e.code : 'internal_error', t);
      return fail(e);
    }
  };
}

const FEATURE_LABEL = {
  ingredients: 'Journey ingredient data (developer API)',
  labs: 'Journey Labs verification lookup',
  products: 'Product data needs a signed-in Journey app account (connect with OAuth). Product lookup',
  prices: 'Journey price data',
  suppliers: 'Journey supplier data',
} as const;

/** Clean "not connected yet" before any cap is touched when this server has no backend for the feature. */
function need(ctx: ToolContext, feature: keyof typeof FEATURE_LABEL) {
  if (ctx.data.available && !ctx.data.available(feature, cred(ctx))) throw new NotConnectedError(FEATURE_LABEL[feature]);
}

const cred = (ctx: ToolContext): { apiKey?: string; appToken?: string } => ({ apiKey: ctx.account.upstreamApiKey, appToken: ctx.account.appToken });

export function registerTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    'search_suppliers',
    {
      title: 'Search suppliers',
      description:
        'Find food and CPG suppliers in the Journey network by ingredient, category, region (country or country code) or certification. Returns supplier summaries; use get_supplier for a full profile.',
      inputSchema: {
        query: z.string().min(2).max(200).optional().describe('Free-text search, e.g. supplier name or keyword'),
        ingredient: z.string().min(2).max(200).optional().describe('Ingredient the supplier provides, e.g. "pea protein"'),
        category: z.string().min(2).max(100).optional().describe('Supplier category, e.g. "Food Ingredients"'),
        region: z.string().min(2).max(100).optional().describe('Country name or ISO country code, e.g. "Brazil" or "BR"'),
        certification: z.string().min(2).max(100).optional().describe('Certification, e.g. "Organic", "Non-GMO", "Kosher"'),
        limit: z.number().int().min(1).max(25).default(10).describe('Maximum suppliers to return (1-25)'),
        page: z.number().int().min(1).max(40).default(1).describe('Result page (1-40)'),
      },
      outputSchema: { suppliers: z.array(SupplierSchema), returned: z.number().int(), notice },
      annotations: { title: 'Search suppliers', ...READ_ONLY },
    },
    run(ctx, 'search_suppliers', async (a: { query?: string; ingredient?: string; category?: string; region?: string; certification?: string; limit?: number; page?: number }, ctx) => {
      need(ctx, 'suppliers');
      if (!a.query && !a.ingredient && !a.category && !a.region && !a.certification) {
        return fail(new JourneyError('Provide at least one of query, ingredient, category, region or certification.', 'invalid_arguments', 400));
      }
      await ctx.enforcer.assertCapacity(ctx.account, 'supplier');
      const rows = await ctx.data.searchSuppliers({ ...a, limit: a.limit ?? 10, page: a.page ?? 1 }, cred(ctx));
      const adm = rows.length ? await ctx.enforcer.admit(ctx.account, 'supplier', rows, (s) => s.id) : { allowed: [], withheld: 0, upgrade: undefined };
      return ok({ suppliers: adm.allowed, returned: adm.allowed.length, notice: capNotice(adm.withheld, adm.upgrade) });
    }),
  );

  server.registerTool(
    'get_supplier',
    {
      title: 'Get supplier profile',
      description: 'Get the full Journey profile for one supplier: legal name, website, country, locations, categories, certifications, ingredients and verification status.',
      inputSchema: { supplier_id: z.string().min(1).max(200).describe('Supplier id (slug) from search_suppliers') },
      outputSchema: { supplier: SupplierSchema },
      annotations: { title: 'Get supplier profile', ...READ_ONLY },
    },
    run(ctx, 'get_supplier', async (a: { supplier_id: string }, ctx) => {
      need(ctx, 'suppliers');
      const s = await ctx.data.getSupplier(a.supplier_id, cred(ctx));
      if (!s) return fail(new JourneyError(`No supplier found with id "${a.supplier_id}".`, 'not_found', 404));
      const adm = await ctx.enforcer.admit(ctx.account, 'supplier', [s], (x) => x.id);
      return ok({ supplier: adm.allowed[0] });
    }),
  );

  server.registerTool(
    'search_ingredients',
    {
      title: 'Search ingredients',
      description: 'Search the Journey ingredient database by name and get matching ingredient ids with nutrition and sustainability scores. Use get_ingredient for the full profile.',
      inputSchema: {
        query: z.string().min(2).max(200).describe('Ingredient name or keyword, e.g. "oat" or "pea protein"'),
        limit: z.number().int().min(1).max(25).default(10).describe('Maximum ingredients to return (1-25)'),
      },
      outputSchema: { ingredients: z.array(IngredientSummarySchema), returned: z.number().int(), notice },
      annotations: { title: 'Search ingredients', ...READ_ONLY },
    },
    run(ctx, 'search_ingredients', async (a: { query: string; limit?: number }, ctx) => {
      need(ctx, 'ingredients');
      await ctx.enforcer.assertCapacity(ctx.account, 'ingredient');
      const rows = (await ctx.data.searchIngredients(a.query, a.limit ?? 10, cred(ctx))).map((i) => ({
        id: i.id,
        name: i.name,
        nutrition_score: i.nutrition_score ?? null,
        sustainability_score: i.sustainability_score ?? null,
      }));
      const adm = rows.length ? await ctx.enforcer.admit(ctx.account, 'ingredient', rows, (x) => x.id) : { allowed: [], withheld: 0, upgrade: undefined };
      return ok({ ingredients: adm.allowed, returned: adm.allowed.length, notice: capNotice(adm.withheld, adm.upgrade) });
    }),
  );

  server.registerTool(
    'get_ingredient',
    {
      title: 'Get ingredient profile',
      description: 'Get an ingredient profile from Journey: nutrition per 100 g, nutrition and sustainability scores, detailed nutrients, allergens and attributes. Look up by Journey ingredient id or by name.',
      inputSchema: {
        ingredient_id: z.string().min(1).max(100).optional().describe('Journey ingredient id'),
        name: z.string().min(2).max(200).optional().describe('Ingredient name, e.g. "mango" (best match is returned)'),
      },
      outputSchema: { ingredient: IngredientSchema, matched_by: z.enum(['id', 'name']) },
      annotations: { title: 'Get ingredient profile', ...READ_ONLY },
    },
    run(ctx, 'get_ingredient', async (a: { ingredient_id?: string; name?: string }, ctx) => {
      need(ctx, 'ingredients');
      if (!a.ingredient_id && !a.name) return fail(new JourneyError('Provide ingredient_id or name.', 'invalid_arguments', 400));
      let id = a.ingredient_id;
      if (!id) {
        const [first] = await ctx.data.searchIngredients(a.name!, 1, cred(ctx));
        if (!first) return fail(new JourneyError(`No ingredient found matching "${a.name}".`, 'not_found', 404));
        id = first.id;
      }
      // Count the ingredient before fetching its full profile so a capped account never receives it.
      await ctx.enforcer.admit(ctx.account, 'ingredient', [id], (x) => x);
      const ing = await ctx.data.getIngredient(id, cred(ctx));
      if (!ing) return fail(new JourneyError(`No ingredient found with id "${id}".`, 'not_found', 404));
      return ok({ ingredient: ing, matched_by: a.ingredient_id ? 'id' : 'name' });
    }),
  );

  server.registerTool(
    'get_ingredient_price',
    {
      title: 'Get ingredient price',
      description: 'Get the current Journey reference price and recent price history for an ingredient or commodity (e.g. cocoa, sugar, coffee). Prices are commodity-level series.',
      inputSchema: {
        ingredient: z.string().min(2).max(100).describe('Ingredient or commodity name or symbol, e.g. "cocoa" or "COCOA"'),
        days: z.number().int().min(1).max(3650).default(365).describe('History window in days (default 365)'),
        include_forecast: z.boolean().default(false).describe('Also return the Journey P10/P50/P90 forecast (published only where it beats a naive backtest)'),
      },
      outputSchema: { price: PriceSchema, forecast: PriceForecastSchema.optional() },
      annotations: { title: 'Get ingredient price', ...READ_ONLY },
    },
    run(ctx, 'get_ingredient_price', async (a: { ingredient: string; days?: number; include_forecast?: boolean }, ctx) => {
      need(ctx, 'prices');
      // A price lookup counts toward both the price series cap and the ingredient cap (one ingredient record per series).
      await ctx.enforcer.assertCapacity(ctx.account, 'price_series');
      await ctx.enforcer.assertCapacity(ctx.account, 'ingredient');
      const p = await ctx.data.getIngredientPrice(a.ingredient, a.days ?? 365, cred(ctx));
      if (!p) return fail(new JourneyError(`Journey does not publish a price series for "${a.ingredient}" yet.`, 'not_found', 404));
      await ctx.enforcer.admit(ctx.account, 'ingredient', [p], (x) => `price:${x.series_id}`);
      await ctx.enforcer.admit(ctx.account, 'price_series', [p], (x) => x.series_id);
      // The forecast belongs to the same series, so it adds no new record to the count.
      let forecast: PriceForecast | undefined;
      if (a.include_forecast) forecast = (await ctx.data.getPriceForecast(p.symbol, Math.min(a.days ?? 90, 90), cred(ctx))) ?? undefined;
      return ok(forecast ? { price: p, forecast } : { price: p });
    }),
  );

  server.registerTool(
    'list_price_series',
    {
      title: 'List price series',
      description: 'List the ingredients and commodities Journey publishes reference prices for (symbol, name, unit, currency). No prices are included; use get_ingredient_price for those.',
      inputSchema: {},
      outputSchema: { series: z.array(PriceSeriesSummarySchema), returned: z.number().int() },
      annotations: { title: 'List price series', ...READ_ONLY },
    },
    run(ctx, 'list_price_series', async (_a: Record<string, never>, ctx) => {
      need(ctx, 'prices');
      const series = await ctx.data.listPriceSeries(cred(ctx));
      return ok({ series, returned: series.length });
    }),
  );

  server.registerTool(
    'compare_suppliers',
    {
      title: 'Compare suppliers',
      description: 'Compare two to five Journey suppliers side by side: countries, categories, certifications, ingredients and verification status, plus what they share.',
      inputSchema: { supplier_ids: z.array(z.string().min(1).max(200)).min(2).max(5).describe('Two to five supplier ids from search_suppliers') },
      outputSchema: {
        suppliers: z.array(SupplierSchema),
        comparison: z.object({
          shared_certifications: z.array(z.string()),
          shared_categories: z.array(z.string()),
          shared_ingredients: z.array(z.string()),
          by_supplier: z.array(z.object({ id: z.string(), unique_certifications: z.array(z.string()), country: z.string().nullable(), verification_status: z.string().nullable() })),
        }),
        not_found: z.array(z.string()),
        notice,
      },
      annotations: { title: 'Compare suppliers', ...READ_ONLY },
    },
    run(ctx, 'compare_suppliers', async (a: { supplier_ids: string[] }, ctx) => {
      need(ctx, 'suppliers');
      const ids = [...new Set(a.supplier_ids)];
      if (ids.length < 2) return fail(new JourneyError('Provide at least two different supplier ids.', 'invalid_arguments', 400));
      const found = await Promise.all(ids.map((id) => ctx.data.getSupplier(id, cred(ctx))));
      const present = found.filter((s): s is NonNullable<typeof s> => Boolean(s));
      const notFound = ids.filter((_, i) => !found[i]);
      if (present.length < 2) return fail(new JourneyError(`At least two suppliers are needed to compare. Not found: ${notFound.join(', ')}.`, 'not_found', 404));
      const adm = await ctx.enforcer.admit(ctx.account, 'supplier', present, (s) => s.id);
      if (adm.allowed.length < 2) throw await ctx.enforcer.capErrorFor(ctx.account, 'This account does not have enough remaining supplier allowance to compare.');
      const list = adm.allowed;
      const inter = (pick: (s: (typeof list)[number]) => string[]) => {
        const sets = list.map((s) => new Set(pick(s).map((x) => x.toLowerCase())));
        return pick(list[0]).filter((x) => sets.every((st) => st.has(x.toLowerCase())));
      };
      const sharedCerts = inter((s) => s.certifications);
      return ok({
        suppliers: list,
        comparison: {
          shared_certifications: sharedCerts,
          shared_categories: inter((s) => s.categories),
          shared_ingredients: inter((s) => s.ingredients),
          by_supplier: list.map((s) => ({
            id: s.id,
            unique_certifications: s.certifications.filter((c) => !sharedCerts.includes(c)),
            country: s.country ?? null,
            verification_status: s.verification_status ?? null,
          })),
        },
        not_found: notFound,
        notice: capNotice(adm.withheld, adm.upgrade),
      });
    }),
  );

  server.registerTool(
    'search_products',
    {
      title: 'Search my products',
      description: "List or search the signed-in Journey account's own products (formulations) by name, optionally filtered by status. Needs a Journey app account connected with OAuth.",
      inputSchema: {
        query: z.string().min(1).max(200).optional().describe('Product name contains, case-insensitive'),
        status: z.enum(['active', 'concept', 'discontinued']).optional().describe('Product status filter'),
        page: z.number().int().min(1).max(40).default(1).describe('Result page (1-40)'),
        limit: z.number().int().min(1).max(25).default(10).describe('Products per page (1-25)'),
      },
      outputSchema: { products: z.array(ProductSummarySchema), returned: z.number().int(), total: z.number().int().nullable(), notice },
      annotations: { title: 'Search my products', ...READ_ONLY },
    },
    run(ctx, 'search_products', async (a: { query?: string; status?: 'active' | 'concept' | 'discontinued'; page?: number; limit?: number }, ctx) => {
      need(ctx, 'products');
      await ctx.enforcer.assertCapacity(ctx.account, 'product');
      const r = await ctx.data.searchProducts({ query: a.query, status: a.status, page: a.page ?? 1, limit: a.limit ?? 10 }, cred(ctx));
      const adm = r.products.length ? await ctx.enforcer.admit(ctx.account, 'product', r.products, (p) => p.id) : { allowed: [], withheld: 0, upgrade: undefined };
      return ok({ products: adm.allowed, returned: adm.allowed.length, total: r.total, notice: capNotice(adm.withheld, adm.upgrade) });
    }),
  );

  server.registerTool(
    'get_product',
    {
      title: 'Get my product',
      description: "Get one of the signed-in account's products: summary, ingredient list and nutrition panel. Choose sections to keep the answer short. Needs a Journey app account connected with OAuth.",
      inputSchema: {
        product_id: z.string().regex(/^[a-f0-9]{24}$/i, 'Expected a 24-character Journey product id').describe('Product id from search_products'),
        sections: z.array(z.enum(['summary', 'ingredients', 'nutrition'])).min(1).max(3).default(['summary', 'ingredients', 'nutrition']).describe('Which parts to return'),
      },
      outputSchema: { product: ProductSchema },
      annotations: { title: 'Get my product', ...READ_ONLY },
    },
    run(ctx, 'get_product', async (a: { product_id: string; sections?: ('summary' | 'ingredients' | 'nutrition')[] }, ctx) => {
      need(ctx, 'products');
      await ctx.enforcer.assertCapacity(ctx.account, 'product');
      const p = await ctx.data.getProduct(a.product_id, cred(ctx));
      if (!p) return fail(new JourneyError(`No product found with id "${a.product_id}".`, 'not_found', 404));
      const adm = await ctx.enforcer.admit(ctx.account, 'product', [p], (x) => x.id);
      const [prod] = adm.allowed;
      const want = new Set(a.sections ?? ['summary', 'ingredients', 'nutrition']);
      const { ingredients, nutrition, nutrition_score, serving_size, serving_size_unit, ...summary } = prod;
      return ok({
        product: {
          ...summary,
          ...(want.has('ingredients') ? { ingredients } : {}),
          ...(want.has('nutrition') ? { nutrition, nutrition_score, serving_size, serving_size_unit } : {}),
        },
      });
    }),
  );

  server.registerTool(
    'verify_lab_result',
    {
      title: 'Verify Journey Labs result',
      description: 'Check whether a product or ingredient has a Journey Labs verified (accredited) test result and return its summary.',
      inputSchema: {
        subject: z.string().min(2).max(200).describe('Journey id of the ingredient, product, supplier or company'),
        subject_type: z.enum(['ingredient', 'product', 'supplier', 'company']).default('ingredient').describe('What the subject id refers to'),
        result_id: z.string().min(1).max(100).optional().describe('Journey Labs result id, if known'),
      },
      outputSchema: { result: LabResultSchema },
      annotations: { title: 'Verify Journey Labs result', ...READ_ONLY },
    },
    run(ctx, 'verify_lab_result', async (a: { subject: string; subject_type?: LabSubjectType; result_id?: string }, ctx) => {
      need(ctx, 'labs');
      await ctx.enforcer.assertCapacity(ctx.account, 'lab_result');
      // PDF reports are a paid feature: free accounts get the summary only.
      const tier = (await ctx.enforcer.usage(ctx.account)).tier;
      const r = await ctx.data.verifyLabResult(a.subject, a.result_id, cred(ctx), { subjectType: a.subject_type ?? 'ingredient', includePdf: tier !== 'free' });
      if (tier === 'free' && r.pdf_available) r.pdf_url = null;
      if (r.verified) await ctx.enforcer.admit(ctx.account, 'lab_result', [r], (x) => x.result_id ?? `subject:${x.subject.toLowerCase()}`);
      return ok({ result: r });
    }),
  );
}

export const TOOL_NAMES = [
  'search_suppliers',
  'get_supplier',
  'compare_suppliers',
  'search_ingredients',
  'get_ingredient',
  'get_ingredient_price',
  'list_price_series',
  'search_products',
  'get_product',
  'verify_lab_result',
] as const;
