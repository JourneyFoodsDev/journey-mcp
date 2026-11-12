import { UI } from './definitions.js';

/** Widgets load no remote images, fonts, scripts, or frames. CSP stays empty. */
export const UI_MIME = 'text/html;profile=mcp-app';

export const WIDGET_CSP = {
  connectDomains: [] as string[],
  resourceDomains: [] as string[],
  frameDomains: [] as string[],
};

export function widgetMeta() {
  return {
    ui: { csp: WIDGET_CSP },
    'openai/widgetCSP': {
      connect_domains: [] as string[],
      resource_domains: [] as string[],
      frame_domains: [] as string[],
    },
  };
}

type Kind = 'list' | 'card' | 'compare' | 'price' | 'score';

function page(kind: Kind, title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  :root { color: #1c1917; font-family: system-ui, sans-serif; }
  body { margin: 0; padding: 16px; background: #f7f7f5; }
  main { max-width: 640px; margin: 0 auto; background: #fff; border: 1px solid #e7e5e4; border-radius: 12px; padding: 16px; }
  h1 { font-size: 1.05rem; margin: 0 0 8px; }
  p { margin: 0 0 8px; line-height: 1.4; }
  .muted { color: #57534e; font-size: 0.9rem; }
  ul, table { width: 100%; }
  ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
  li, td, th { font-size: 0.95rem; }
  li { background: #f5f5f4; border-radius: 8px; padding: 10px 12px; }
  table { border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e7e5e4; vertical-align: top; }
  .score { font-size: 2rem; font-weight: 650; letter-spacing: -0.03em; }
  svg { width: 100%; height: 160px; }
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <p id="status" class="muted">The text reply contains the same result.</p>
  <p id="note"></p>
  <div id="view"></div>
</main>
<script type="module">
const KIND = ${JSON.stringify(kind)};
const statusEl = document.querySelector('#status');
const noteEl = document.querySelector('#note');
const viewEl = document.querySelector('#view');

const text = (value) => (value == null ? '' : String(value));
const el = (tag, value) => {
  const node = document.createElement(tag);
  node.textContent = text(value);
  return node;
};
const line = (primary, secondary) => {
  const item = el('li', '');
  item.append(el('div', primary));
  if (secondary) item.append(el('div', secondary));
  return item;
};

function readStructured(params) {
  if (!params || typeof params !== 'object') return null;
  if (params.structuredContent && typeof params.structuredContent === 'object') return params.structuredContent;
  const result = params.result;
  if (result && result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const content = Array.isArray(params.content) ? params.content : result && Array.isArray(result.content) ? result.content : [];
  const block = content.find((item) => item && item.type === 'text' && typeof item.text === 'string');
  if (!block) return null;
  try { return JSON.parse(block.text); } catch { return null; }
}

function renderList(data) {
  const rows = data.suppliers || data.ingredients || data.products || data.series || [];
  const list = document.createElement('ul');
  rows.forEach((row) => {
    const primary = row.name || row.symbol || row.id || 'Result';
    const secondary = [row.country, row.barcode, row.symbol, row.category, row.brand, row.source].filter(Boolean).join(' · ');
    list.append(line(primary, secondary));
  });
  if (!rows.length) list.append(line('No rows in this result.', ''));
  return list;
}

function renderCard(data) {
  const row = data.supplier || data.ingredient || data.result || {};
  const list = document.createElement('ul');
  const name = row.name || row.subject || row.id || 'Record';
  list.append(line(name, row.id || row.result_id || ''));
  if (row.country) list.append(line('Country', row.country));
  if (Array.isArray(row.certifications) && row.certifications.length) list.append(line('Certifications', row.certifications.join(', ')));
  if (row.nutrition_score != null) list.append(line('Nutrition score', row.nutrition_score));
  if (row.sustainability_score != null) list.append(line('Sustainability score', row.sustainability_score));
  if (row.verified != null) list.append(line('Lab verification', row.verified ? 'Verified' : 'Not verified'));
  if (row.summary) list.append(line('Summary', row.summary));
  if (row.lab) list.append(line('Lab', row.lab));
  return list;
}

function renderCompare(data) {
  const rows = data.suppliers || data.products || [];
  const table = document.createElement('table');
  const head = document.createElement('tr');
  ['Name', 'Detail'].forEach((label) => head.append(el('th', label)));
  table.append(head);
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    const detail = [
      row.country,
      row.verification_status,
      row.barcode,
      row.guava_score == null ? '' : 'Guava Score ' + row.guava_score,
      row.source,
    ].filter(Boolean).join(' · ');
    tr.append(el('td', row.name || row.id || ''));
    tr.append(el('td', detail));
    table.append(tr);
  });
  return table;
}

function series(points, pick) {
  return (points || []).map((point) => ({ x: text(point.date), y: Number(pick(point)) })).filter((point) => Number.isFinite(point.y));
}

function renderPrice(data) {
  const wrap = document.createElement('div');
  const price = data.price || {};
  const history = series(price.history, (point) => point.index);
  const forecast = series(data.forecast && data.forecast.points, (point) => point.p50);
  if (price.current && price.current.index != null) wrap.append(el('p', 'Current index ' + price.current.index + ' (base 100)'));
  const points = history.length >= 2 ? history : forecast.length >= 2 ? forecast : [];
  if (points.length < 2) {
    wrap.append(el('p', history.length ? 'Not enough index points to draw a chart. The text reply has the values.' : 'No index history was returned.'));
    return wrap;
  }
  const min = Math.min(...points.map((point) => point.y));
  const max = Math.max(...points.map((point) => point.y));
  const span = max - min || 1;
  const chart = document.createElement('div');
  chart.style.display = 'flex';
  chart.style.alignItems = 'flex-end';
  chart.style.gap = '4px';
  chart.style.height = '140px';
  points.forEach((point) => {
    const bar = document.createElement('div');
    bar.style.flex = '1';
    bar.style.background = '#0f766e';
    bar.style.minHeight = '4px';
    bar.style.height = (8 + ((point.y - min) / span) * 92).toFixed(1) + '%';
    bar.title = point.x + ' ' + point.y;
    chart.append(bar);
  });
  wrap.append(chart);
  wrap.append(el('p', points[0].x + ' to ' + points[points.length - 1].x));
  return wrap;
}

function renderScore(data) {
  const product = data.product || {};
  const wrap = document.createElement('div');
  wrap.append(el('p', product.name || 'Product'));
  if (product.brand) wrap.append(el('p', product.brand));
  if (typeof product.guava_score === 'number') {
    const score = el('p', String(product.guava_score));
    score.className = 'score';
    wrap.append(score);
    wrap.append(el('p', 'Guava Score from the catalog'));
  } else {
    wrap.append(el('p', 'No Guava Score was provided for this product.'));
  }
  if (product.barcode) wrap.append(el('p', 'Barcode ' + product.barcode));
  if (Array.isArray(product.ingredients) && product.ingredients.length) wrap.append(el('p', 'Ingredients: ' + product.ingredients.join(', ')));
  if (product.price_context && (product.price_context.amount != null || product.price_context.note)) {
    const price = [product.price_context.currency, product.price_context.amount, product.price_context.note].filter((part) => part != null && part !== '').join(' ');
    wrap.append(el('p', price));
  }
  if (product.source) wrap.append(el('p', 'Source: ' + product.source));
  return wrap;
}

function render(data) {
  if (!data) return;
  statusEl.textContent = 'Showing the tool result. The text reply has the same data.';
  noteEl.textContent = typeof data.notice === 'string' ? data.notice : '';
  viewEl.replaceChildren();
  const view = KIND === 'list' ? renderList(data) : KIND === 'card' ? renderCard(data) : KIND === 'compare' ? renderCompare(data) : KIND === 'price' ? renderPrice(data) : renderScore(data);
  viewEl.append(view);
}

let rpcId = 0;
const pending = new Map();
const rpcRequest = (method, params) => new Promise((resolve, reject) => {
  const id = ++rpcId;
  pending.set(id, { resolve, reject });
  window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
});
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.jsonrpc !== '2.0') return;
  if (typeof message.id === 'number') {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(message.error);
    else waiter.resolve(message.result);
    return;
  }
  if (message.method === 'ui/notifications/tool-result') render(readStructured(message.params));
});
try {
  await rpcRequest('ui/initialize', { appInfo: { name: ${JSON.stringify(title)}, version: '1' }, appCapabilities: {}, protocolVersion: '2026-01-26' });
  window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');
} catch (error) {
  statusEl.textContent = 'The text reply contains the result. This panel could not attach to the host.';
}
</script>
</body>
</html>`;
}

export interface WidgetDocument {
  uri: string;
  name: string;
  description: string;
  html: string;
}

export const WIDGETS: Record<string, WidgetDocument> = {
  [UI.resultList]: {
    uri: UI.resultList,
    name: 'Result list',
    description: 'Renders a list of suppliers, ingredients, price series, or products from the tool result. The text reply remains complete without this panel.',
    html: page('list', 'Results'),
  },
  [UI.recordCard]: {
    uri: UI.recordCard,
    name: 'Record card',
    description: 'Renders one supplier, ingredient, or lab-verification record from the tool result.',
    html: page('card', 'Record'),
  },
  [UI.comparison]: {
    uri: UI.comparison,
    name: 'Comparison table',
    description: 'Renders a side-by-side comparison from the tool result.',
    html: page('compare', 'Comparison'),
  },
  [UI.priceChart]: {
    uri: UI.priceChart,
    name: 'Price chart',
    description: 'Draws the returned price index. It does not invent points.',
    html: page('price', 'Price index'),
  },
  [UI.productScore]: {
    uri: UI.productScore,
    name: 'Product score',
    description: 'Shows a Guava product and the Guava Score only when the catalog included one.',
    html: page('score', 'Product'),
  },
};
