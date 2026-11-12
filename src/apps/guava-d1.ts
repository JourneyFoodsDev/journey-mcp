import { UpstreamError } from '../errors.js';
import { readGuavaProduct, type GuavaCatalog, type GuavaProduct, type GuavaProductSummary, type GuavaQuery } from './guava-catalog.js';

/** Subset of Cloudflare D1 used by the catalog. */
export interface GuavaD1 {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
    };
  };
}

const MAX_LIMIT = 25;

/**
 * Read-only view of the D1 database `journey-fallback-guava` filled by the
 * guava-catalog-sync Worker. It reads `guava_p` for search and `docs` for one
 * product. It does not calculate a Guava Score.
 */
export class D1GuavaCatalog implements GuavaCatalog {
  constructor(private readonly db: GuavaD1) {}

  async search(q: GuavaQuery): Promise<GuavaProductSummary[]> {
    const limit = clamp(q.limit);
    try {
      if (q.barcode) {
        const rows = await this.all<{ id: string; barcode: string | null; name: string }>(
          'SELECT id, barcode, name FROM guava_p WHERE barcode = ?1 LIMIT ?2',
          q.barcode,
          limit,
        );
        return rows.map(summary);
      }
      const phrase = ftsPhrase(q.query ?? '');
      const rows = phrase
        ? await this.all<{ id: string; barcode: string | null; name: string }>(
            `SELECT p.id AS id, p.barcode AS barcode, p.name AS name
             FROM guava_p_fts
             JOIN guava_p AS p ON p.rid = guava_p_fts.rowid
             WHERE guava_p_fts MATCH ?1
             LIMIT ?2`,
            phrase,
            limit,
          )
        : await this.all<{ id: string; barcode: string | null; name: string }>(
            `SELECT id, barcode, name FROM guava_p WHERE name LIKE ?1 ESCAPE '\\' ORDER BY name LIMIT ?2`,
            `${escapeLike(q.query ?? '')}%`,
            limit,
          );
      return rows.map(summary);
    } catch {
      throw new UpstreamError('Guava catalog search failed. No products were returned.', 502, 'guava_p');
    }
  }

  async get(id: string): Promise<GuavaProduct | null> {
    try {
      const row = await this.first<{ doc: string }>(`SELECT doc FROM docs WHERE coll = 'products' AND id = ?1`, id);
      if (!row?.doc) return null;
      const parsed = JSON.parse(row.doc) as Record<string, unknown>;
      const names = await this.ingredientNames(parsed.ingredients);
      const brand = await this.brandName(parsed.brandId);
      return readGuavaProduct({ ...parsed, id, ...(brand ? { brand } : {}), ingredients: names });
    } catch (e) {
      if (e instanceof SyntaxError) return null;
      if (e instanceof UpstreamError) throw e;
      throw new UpstreamError('Guava catalog lookup failed. No product was returned.', 502, 'docs');
    }
  }

  private async ingredientNames(value: unknown): Promise<string[]> {
    if (!Array.isArray(value)) return [];
    const ids: string[] = [];
    const direct: string[] = [];
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) direct.push(item.trim());
      else if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        if (typeof rec.name === 'string' && rec.name.trim()) direct.push(rec.name.trim());
        const ref = rec.ingredient;
        const id = typeof ref === 'string' ? ref : ref && typeof ref === 'object' && typeof (ref as { $oid?: unknown }).$oid === 'string' ? (ref as { $oid: string }).$oid : undefined;
        if (id) ids.push(id);
      }
    }
    if (!ids.length) return direct;
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ');
    const found = await this.all<{ id: string; name: string | null }>(
      `SELECT id, json_extract(doc, '$.name') AS name FROM docs WHERE coll = 'ingredients' AND id IN (${placeholders})`,
      ...ids,
    );
    const byId = new Map(found.map((row) => [row.id, typeof row.name === 'string' ? row.name : '']));
    return [...direct, ...ids.map((id) => byId.get(id) ?? '').filter(Boolean)];
  }

  private async brandName(brandId: unknown): Promise<string | undefined> {
    const id = typeof brandId === 'string' ? brandId : brandId && typeof brandId === 'object' && typeof (brandId as { $oid?: unknown }).$oid === 'string' ? (brandId as { $oid: string }).$oid : undefined;
    if (!id) return undefined;
    const row = await this.first<{ name: string | null }>('SELECT name FROM guava_b WHERE id = ?1', id);
    return row?.name?.trim() || undefined;
  }

  private async all<T>(sql: string, ...args: unknown[]): Promise<T[]> {
    const result = await this.db.prepare(sql).bind(...args).all<T>();
    return result.results ?? [];
  }

  private async first<T>(sql: string, ...args: unknown[]): Promise<T | null> {
    return this.db.prepare(sql).bind(...args).first<T>();
  }
}

function summary(row: { id: string; barcode: string | null; name: string }): GuavaProductSummary {
  return { id: row.id, name: row.name, ...(row.barcode ? { barcode: row.barcode } : {}) };
}

function clamp(limit: number): number {
  if (!Number.isFinite(limit)) return 1;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function ftsPhrase(query: string): string | undefined {
  const clean = query.replace(/["*]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length < 3) return undefined;
  return `"${clean}"`;
}

function escapeLike(query: string): string {
  return query.replace(/[\\%_]/g, (char) => `\\${char}`);
}
