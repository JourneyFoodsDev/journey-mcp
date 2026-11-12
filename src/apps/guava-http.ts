import type { Account } from '../auth/account.js';
import { applyPreview, joinNotice, previewQuery } from '../policy/search-gate.js';
import type { GuavaCatalog } from './guava-catalog.js';

const PREFIX = '/apps/guava/v1/products';
const BARCODE = /^(?:\d{8}|\d{12}|\d{13})$/;

export async function queryGuavaCatalog(input: {
  pathname: string;
  searchParams: URLSearchParams;
  catalog?: GuavaCatalog;
  account: Account;
}): Promise<{ status: number; body: unknown } | null> {
  const { pathname } = input;
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return null;
  if (!input.catalog) {
    return { status: 501, body: { error: 'not_connected', message: 'The Guava product catalog is not connected on this server. No products were returned.' } };
  }
  if (pathname === PREFIX) return search(input.catalog, input.account, input.searchParams);
  const id = decodeURIComponent(pathname.slice(PREFIX.length + 1));
  if (!id || id.includes('/')) return { status: 400, body: { error: 'invalid_arguments', message: 'Provide one product id.' } };
  const product = await input.catalog.get(id);
  if (!product) return { status: 404, body: { error: 'not_found', message: `No Guava product found with id "${id}". No score was estimated.` } };
  return { status: 200, body: { product } };
}

async function search(catalog: GuavaCatalog, account: Account, params: URLSearchParams): Promise<{ status: number; body: unknown }> {
  const query = params.get('query')?.trim() || undefined;
  const barcode = params.get('barcode')?.trim() || undefined;
  const requested = Math.max(1, Math.min(25, numberParam(params.get('limit'), 10)));
  const page = numberParam(params.get('page'), 1);
  if (barcode && !BARCODE.test(barcode)) return { status: 400, body: { error: 'invalid_arguments', message: 'Use an 8, 12, or 13 digit barcode.' } };
  if (!query && !barcode) return { status: 400, body: { error: 'invalid_arguments', message: 'Provide a product name or a typed barcode.' } };
  if (query && query.length < 2) return { status: 400, body: { error: 'invalid_arguments', message: 'Provide at least two characters of a product name.' } };
  const bounded = previewQuery(account, requested, page);
  if (bounded.blocked) return { status: 200, body: { products: [], returned: 0, notice: bounded.notice } };
  const rows = await catalog.search({ query, barcode, limit: bounded.limit });
  const visible = applyPreview(account, rows);
  return { status: 200, body: { products: visible.rows, returned: visible.rows.length, notice: joinNotice(visible.notice) } };
}

function numberParam(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}
