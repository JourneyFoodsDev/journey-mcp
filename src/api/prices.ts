/**
 * Public price output is an index (base 100) and P10–P90 ranges.
 * Raw commodity levels from the price feed are used only to scale that index.
 * They are never copied onto a tool result.
 */

export const INDEX_BASE = 100 as const;

const RAW_PRICE_KEY = /^(price|prices|cost|costs|msrp|wholesale|wholesale_price|unit_price|unitprice|trade_price|raw_price|rawprice)$/i;

export function roundIndex(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Scale one raw level so `baseLevel` becomes 100. */
export function scaleToIndex(level: number, baseLevel: number): number {
  if (!Number.isFinite(level) || !Number.isFinite(baseLevel) || baseLevel === 0) return INDEX_BASE;
  return roundIndex((level / baseLevel) * INDEX_BASE);
}

/** Drop raw price/cost fields anywhere in a JSON value. Index and forecast keys stay. */
export function omitRawPrices<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => omitRawPrices(item)) as T;
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (RAW_PRICE_KEY.test(key)) continue;
    out[key] = omitRawPrices(child);
  }
  return out as T;
}

export function readIndex(row: Record<string, unknown>, num: (v: unknown) => number | null): number | null {
  return num(row.idx ?? row.index);
}

export function readRawLevel(row: Record<string, unknown>, num: (v: unknown) => number | null): number | null {
  return num(row.price ?? row.last ?? row.value ?? row.close);
}

export interface ScaledPoint {
  date: string;
  index: number;
}

/**
 * History points as an index. Prefers an upstream `idx`/`index`.
 * Otherwise scales raw levels so the earliest point in the window is 100.
 * Returns the raw level used as that base so a forecast can share it. The caller must not return it.
 */
export function indexHistory(
  rows: Record<string, unknown>[],
  num: (v: unknown) => number | null,
  str: (v: unknown) => string | null,
): { points: ScaledPoint[]; rawBase: number | null; alreadyIndex: boolean } {
  const parsed = rows
    .map((row) => ({
      date: str(row.date ?? row.month) ?? '',
      index: readIndex(row, num),
      raw: readRawLevel(row, num),
    }))
    .filter((row) => row.date && (row.index !== null || row.raw !== null))
    .sort((a, b) => a.date.localeCompare(b.date));
  const alreadyIndex = parsed.some((row) => row.index !== null);
  if (alreadyIndex) {
    return {
      alreadyIndex: true,
      rawBase: null,
      points: parsed
        .filter((row): row is { date: string; index: number; raw: number | null } => row.index !== null)
        .map((row) => ({ date: row.date, index: roundIndex(row.index) })),
    };
  }
  const rawBase = parsed.find((row) => row.raw)?.raw ?? null;
  if (rawBase === null) return { points: [], rawBase: null, alreadyIndex: false };
  return {
    alreadyIndex: false,
    rawBase,
    points: parsed
      .filter((row): row is { date: string; index: number | null; raw: number } => row.raw !== null)
      .map((row) => ({ date: row.date, index: scaleToIndex(row.raw, rawBase) })),
  };
}

export function indexLevel(rawOrIndex: number | null, rawBase: number | null, alreadyIndex: boolean): number | null {
  if (rawOrIndex === null) return null;
  if (alreadyIndex || rawBase === null) return roundIndex(rawOrIndex);
  return scaleToIndex(rawOrIndex, rawBase);
}

export interface ForecastRange {
  date: string;
  p10: number;
  p50: number;
  p90: number;
}

/** P10–P90 on the same base-100 index. Unscaled raw levels are dropped. */
export function indexForecast(
  rows: Record<string, unknown>[],
  num: (v: unknown) => number | null,
  str: (v: unknown) => string | null,
  rawBase: number | null,
  alreadyIndex: boolean,
): ForecastRange[] {
  const ranges: ForecastRange[] = [];
  for (const row of rows) {
    const date = str(row.date) ?? '';
    const p10 = num(row.p10);
    const p50 = num(row.p50);
    const p90 = num(row.p90);
    if (!date || p10 === null || p50 === null || p90 === null) continue;
    if (!alreadyIndex && rawBase === null) continue;
    const scale = (n: number) => (alreadyIndex || rawBase === null ? roundIndex(n) : scaleToIndex(n, rawBase));
    ranges.push({ date, p10: scale(p10), p50: scale(p50), p90: scale(p90) });
  }
  return ranges;
}
