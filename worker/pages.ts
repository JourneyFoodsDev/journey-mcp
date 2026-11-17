/** Journey-branded HTML for the OAuth sign-in page. Tan #f6f1e8, blue #395efa. No secrets are ever rendered. */

export const LOGO_URL = 'https://www.journeyfoods.io/images/journey-logo.png';
export const GET_KEY_URL = 'https://price.journeyfoods.io';

export const PAGE_SECURITY_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy':
    "default-src 'none'; img-src https://www.journeyfoods.io; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

const STYLE = `
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f6f1e8;color:#1f2a44;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#fff;max-width:440px;width:100%;border-radius:16px;padding:32px;box-shadow:0 8px 30px rgba(31,42,68,.08)}
.logo{height:36px;display:block;margin:0 0 24px}h1{font-size:22px;margin:0 0 8px}p{line-height:1.5;margin:0 0 16px;font-size:15px}
.muted{color:#5b6478;font-size:13px}label{display:block;font-weight:600;font-size:14px;margin:0 0 6px}
input[type=password]{width:100%;padding:12px 14px;border:1px solid #d9d2c3;border-radius:10px;font-size:15px;background:#fbf9f4}
input[type=password]:focus{outline:2px solid #395efa;border-color:#395efa}
.row{display:flex;gap:12px;margin-top:20px}button{flex:1;padding:12px 16px;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;border:1px solid #395efa}
.primary{background:#395efa;color:#fff}.secondary{background:#fff;color:#395efa}
.error{background:#fdecec;color:#9b1c1c;border-radius:10px;padding:10px 12px;font-size:14px;margin:0 0 16px}
a{color:#395efa}code{background:#f6f1e8;padding:1px 5px;border-radius:4px}`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main class="card"><img class="logo" src="${LOGO_URL}" alt="Journey Foods">${body}</main></body></html>`;
}

export interface SignInPageOptions {
  clientName: string;
  redirectHost: string;
  handle: string;
  error?: string;
}

export function signInPage(o: SignInPageOptions): string {
  return layout(
    'Connect to Journey AI',
    `<h1>Connect ${escapeHtml(o.clientName)} to Journey AI</h1>
<p>Paste your Journey API key to let <strong>${escapeHtml(o.clientName)}</strong> use Journey's food, ingredient, supplier and price tools for your account.</p>
${o.error ? `<div class="error" role="alert">${escapeHtml(o.error)}</div>` : ''}
<form method="post" action="/authorize" autocomplete="off">
<input type="hidden" name="handle" value="${escapeHtml(o.handle)}">
<input type="hidden" name="client_name" value="${escapeHtml(o.clientName)}">
<input type="hidden" name="redirect_host" value="${escapeHtml(o.redirectHost)}">
<label for="api_key">Journey API key</label>
<input id="api_key" name="api_key" type="password" required spellcheck="false" autocapitalize="off" placeholder="Paste your key">
<p class="muted" style="margin-top:8px">The same key you use in the <code>x-api-key</code> header. No key yet? Get a free trial key at <a href="${GET_KEY_URL}" target="_blank" rel="noopener">price.journeyfoods.io</a>.</p>
<div class="row"><button class="secondary" type="submit" name="decision" value="deny" formnovalidate>Cancel</button><button class="primary" type="submit" name="decision" value="approve">Connect</button></div>
</form>
<p class="muted" style="margin-top:20px">After you connect, you'll return to <strong>${escapeHtml(o.redirectHost)}</strong>. Your key stays on Journey's server and is never sent to ${escapeHtml(o.clientName)}.</p>`,
  );
}

export function messagePage(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}
