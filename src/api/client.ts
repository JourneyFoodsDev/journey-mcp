import { UpstreamError } from '../errors.js';
import type { Logger } from '../logger.js';

export interface RequestOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  apiKey?: string;
  /** Bearer token (Journey app session). Sent instead of x-api-key when present. */
  bearer?: string;
  /** Extra headers, e.g. a service key for one endpoint. */
  headers?: Record<string, string>;
}

/** Thin HTTP client. Base URL and key are injected from env-derived config; nothing is hardcoded. */
export class JourneyHttpClient {
  constructor(
    private readonly baseUrl: string | undefined,
    private readonly defaultKey: string | undefined,
    private readonly log: Logger,
    // Wrapped so the global is never called unbound (Workers throw "Illegal invocation").
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly timeoutMs = 15000,
    private readonly name = 'journey-api',
  ) {}

  get configured() {
    return Boolean(this.baseUrl);
  }

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    if (!this.baseUrl) throw new UpstreamError(`${this.name} base URL is not configured. Set it in the environment.`, 503, path);
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'journey-mcp/0.1' };
    const key = opts.apiKey ?? this.defaultKey;
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
    else if (key) headers['x-api-key'] = key;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.headers) Object.assign(headers, opts.headers);
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      this.log.warn('upstream unreachable', { upstream: this.name, path, error: (e as Error).message });
      throw new UpstreamError(`Journey data service is unreachable right now. No data was returned.`, 503, path);
    }
    this.log.debug('upstream call', { upstream: this.name, path, status: res.status, ms: Date.now() - started });
    if (res.status === 404) return null as T;
    const text = await res.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new UpstreamError(`Journey data service returned a non-JSON response (${res.status}).`, 502, path);
    }
    if (res.status === 401 || res.status === 403) throw new UpstreamError('Journey rejected the credentials for this request.', res.status, path);
    if (res.status === 429) throw new UpstreamError('Journey upstream rate limit reached. Please retry shortly.', 429, path);
    if (!res.ok) throw new UpstreamError(`Journey data service error (${res.status}).`, res.status >= 500 ? 502 : res.status, path);
    return payload as T;
  }
}

/** Unwrap common Journey envelopes: {data}, {data:{data}}, {results}. */
export function unwrap(payload: unknown): unknown {
  let cur = payload;
  for (let i = 0; i < 3; i++) {
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
      const o = cur as Record<string, unknown>;
      if ('data' in o && o.data !== undefined) { cur = o.data; continue; }
      if (Array.isArray(o.results)) { cur = o.results; continue; }
    }
    break;
  }
  return cur;
}
