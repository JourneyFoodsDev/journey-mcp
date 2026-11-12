import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NotConnectedError } from '../errors.js';
import { applyPreview, joinNotice, previewQuery } from '../policy/search-gate.js';
import { runTool, READ_ONLY, toolMeta, ok, notice, type ToolContext } from '../tools.js';
import { GuavaProductSchema, GuavaProductSummarySchema, type GuavaCatalog, type GuavaProduct } from './guava-catalog.js';

const BARCODE = /^(?:\d{8}|\d{12}|\d{13})$/;

function requireCatalog(ctx: ToolContext): GuavaCatalog {
  if (!ctx.guava) {
    throw new NotConnectedError(
      'Guava product catalog',
      'The Guava product catalog is not connected on this server. No products were returned.',
    );
  }
  return ctx.guava;
}

export function registerGuavaTools(server: McpServer, ctx: ToolContext) {
  const meta = (name: string) => toolMeta(ctx, name);

  server.registerTool(
    'search_products',
    {
      title: 'Search products',
      description:
        'Search the Guava product catalog by name or a typed barcode (EAN-8, UPC-A, or EAN-13). Returns summaries from the connected catalog. Does not estimate a Guava Score. Callers without full catalog access receive at most 4 results, with a note that more need a Journey account. If the catalog is not connected, no products are returned.',
      inputSchema: {
        query: z.string().min(2).max(200).optional().describe('Product name or keyword'),
        barcode: z.string().regex(BARCODE, 'Use 8, 12, or 13 digits').optional().describe('Typed barcode: EAN-8, UPC-A, or EAN-13'),
        limit: z.number().int().min(1).max(25).default(10).describe('Maximum products to return (1-25)'),
        page: z.number().int().min(1).max(40).default(1).describe('Result page (1-40)'),
      },
      outputSchema: { products: z.array(GuavaProductSummarySchema), returned: z.number().int(), notice },
      annotations: { title: 'Search products', ...READ_ONLY },
      ...(meta('search_products') ? { _meta: meta('search_products') } : {}),
    },
    runTool(ctx, 'search_products', async (a: { query?: string; barcode?: string; limit?: number; page?: number }, ctx) => {
      const catalog = requireCatalog(ctx);
      if (!a.query && !a.barcode) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_arguments', message: 'Provide a product name or a typed barcode.' }) }] };
      const requested = a.limit ?? 10;
      const bounded = previewQuery(ctx.account, requested, a.page ?? 1);
      if (bounded.blocked) return ok({ products: [], returned: 0, notice: bounded.notice });
      const rows = await catalog.search({ query: a.query, barcode: a.barcode, limit: bounded.limit });
      const visible = applyPreview(ctx.account, rows);
      return ok({ products: visible.rows, returned: visible.rows.length, notice: joinNotice(visible.notice) });
    }),
  );

  server.registerTool(
    'get_product',
    {
      title: 'Get product',
      description:
        'Get one Guava catalog product by id: name, Guava Score, ingredients, nutrition, and price context. A field is omitted when the catalog did not provide it. This tool does not calculate a score.',
      inputSchema: { product_id: z.string().min(1).max(200).describe('Product id from search_products') },
      outputSchema: { product: GuavaProductSchema },
      annotations: { title: 'Get product', ...READ_ONLY },
      ...(meta('get_product') ? { _meta: meta('get_product') } : {}),
    },
    runTool(ctx, 'get_product', async (a: { product_id: string }, ctx) => {
      const product = await requireCatalog(ctx).get(a.product_id);
      if (!product) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'not_found', message: `No Guava product found with id "${a.product_id}". No score was estimated.` }) }] };
      return ok({ product });
    }),
  );

  server.registerTool(
    'compare_products',
    {
      title: 'Compare products',
      description:
        'Compare two to four Guava catalog products returned by search. Shows only fields the catalog provided, including the Guava Score when it is present. Does not estimate missing scores.',
      inputSchema: { product_ids: z.array(z.string().min(1).max(200)).min(2).max(4).describe('Two to four product ids from search_products') },
      outputSchema: {
        products: z.array(GuavaProductSchema),
        comparison: z.object({
          shared_ingredients: z.array(z.string()),
          by_product: z.array(z.object({ id: z.string(), guava_score: z.number().nullable(), name: z.string() })),
        }),
        not_found: z.array(z.string()),
      },
      annotations: { title: 'Compare products', ...READ_ONLY },
      ...(meta('compare_products') ? { _meta: meta('compare_products') } : {}),
    },
    runTool(ctx, 'compare_products', async (a: { product_ids: string[] }, ctx) => {
      const catalog = requireCatalog(ctx);
      const ids = [...new Set(a.product_ids)];
      if (ids.length < 2) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_arguments', message: 'Provide at least two different product ids.' }) }] };
      const found = await Promise.all(ids.map((id) => catalog.get(id)));
      const products = found.filter((row): row is GuavaProduct => Boolean(row));
      const notFound = ids.filter((_, i) => !found[i]);
      if (products.length < 2) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'not_found', message: `At least two products are needed to compare. Not found: ${notFound.join(', ')}. No scores were estimated.` }) }] };
      }
      const sets = products.map((product) => new Set((product.ingredients ?? []).map((item) => item.toLowerCase())));
      const shared = (products[0].ingredients ?? []).filter((item) => sets.every((bag) => bag.has(item.toLowerCase())));
      return ok({
        products,
        comparison: {
          shared_ingredients: shared,
          by_product: products.map((product) => ({ id: product.id, name: product.name, guava_score: product.guava_score ?? null })),
        },
        not_found: notFound,
      });
    }),
  );
}
