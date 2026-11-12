import { protectedResourceMetadata } from '../auth/oauth.js';
import type { JourneyConfig } from '../config.js';

/** Widget URIs. The HTML is served by the MCP server that registers the resource. */
export const UI = {
  resultList: 'ui://journey/result-list.html',
  recordCard: 'ui://journey/record-card.html',
  comparison: 'ui://journey/comparison-table.html',
  priceChart: 'ui://journey/price-chart.html',
  productScore: 'ui://journey/product-score.html',
} as const;

export type AppId = 'journey-foods' | 'guava';

export interface AppDefinition {
  id: AppId;
  /** Machine name advertised by the MCP server. */
  serverName: string;
  /** Directory display name. */
  title: string;
  path: string;
  instructions: string;
  /** Tools from the existing registry. Guava registers its own tools. */
  tools: string[];
  /** Tool name to UI resource URI. Profile stays text-only. */
  widgets: Record<string, string>;
}

const PREVIEW = 'Callers without full catalog access receive at most 4 results, and the response notes that more need a Journey account.';

export const JOURNEY_FOODS: AppDefinition = {
  id: 'journey-foods',
  serverName: 'journey-foods',
  title: 'Journey Foods',
  path: '/apps/journey-foods/mcp',
  instructions:
    'Journey Foods is read-only food and CPG data: suppliers, ingredients, price indexes, and lab verification. ' +
    PREVIEW +
    ' Do not invent suppliers, prices, or lab results. Price values are indexes with a base of 100, not raw prices. This server cannot create or change records.',
  tools: [
    'search_suppliers',
    'get_supplier',
    'compare_suppliers',
    'search_ingredients',
    'get_ingredient',
    'get_ingredient_price',
    'list_price_series',
    'verify_lab_result',
  ],
  widgets: {
    search_suppliers: UI.resultList,
    search_ingredients: UI.resultList,
    list_price_series: UI.resultList,
    get_supplier: UI.recordCard,
    get_ingredient: UI.recordCard,
    verify_lab_result: UI.recordCard,
    compare_suppliers: UI.comparison,
    get_ingredient_price: UI.priceChart,
  },
};

export const GUAVA: AppDefinition = {
  id: 'guava',
  serverName: 'guava',
  title: 'Guava by Journey',
  path: '/apps/guava/mcp',
  instructions:
    'Guava by Journey is a read-only consumer product lookup. Search by product name or a typed barcode, then read the Guava Score, ingredients, nutrition, and price context when the catalog provides them. ' +
    'If a score or product is missing, say so. Do not estimate a score. ' +
    PREVIEW +
    ' This server cannot create or change records.',
  tools: [],
  widgets: {
    search_products: UI.resultList,
    compare_products: UI.comparison,
    get_product: UI.productScore,
  },
};

export const APPS: Record<AppId, AppDefinition> = {
  'journey-foods': JOURNEY_FOODS,
  guava: GUAVA,
};

export const APP_LIST = [JOURNEY_FOODS, GUAVA] as const;

export function appForPath(path: string): AppDefinition | undefined {
  return APP_LIST.find((app) => app.path === path);
}

export function publicOrigin(resourceUrl: string): string {
  return new URL(resourceUrl).origin;
}

export function resourceForPath(cfg: JourneyConfig, path: string): string {
  if (path === '/mcp') return cfg.resourceUrl;
  return `${publicOrigin(cfg.resourceUrl)}${path}`;
}

export function metadataUrl(cfg: JourneyConfig, resource: string): string {
  const url = new URL(resource);
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
}

/** Public catalog tools can run without a token. Account tools cannot. */
export const PUBLIC_AUTH = [
  { type: 'noauth' },
  { type: 'oauth2', scopes: ['journey:read'] },
] as const;

export const ACCOUNT_AUTH = [{ type: 'oauth2', scopes: ['journey:read'] }] as const;

export function metadataForRequestPath(cfg: JourneyConfig, path: string) {
  const prefix = '/.well-known/oauth-protected-resource';
  const rest = path.startsWith(prefix) ? path.slice(prefix.length) : '';
  const resourcePath = rest && rest !== '/' ? (rest.startsWith('/') ? rest : `/${rest}`) : '';
  const app = resourcePath ? appForPath(resourcePath) : undefined;
  const resource = resourcePath ? `${publicOrigin(cfg.resourceUrl)}${resourcePath}` : cfg.resourceUrl;
  return protectedResourceMetadata(cfg, { resource, name: app?.title ?? 'Journey' });
}
