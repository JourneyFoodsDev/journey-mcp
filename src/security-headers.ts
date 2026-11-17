import type { OutgoingHttpHeader, OutgoingHttpHeaders } from 'node:http';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';

/** JSON, JSON-RPC, and event-stream responses. No document subresources are loaded. */
export const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'";

/**
 * Express's unmatched-route page is the only HTML this process writes. It is a
 * static error document with no scripts, styles, images, or other subresources.
 * `base-uri` and `form-action` do not fall back to `default-src`.
 */
export const HTML_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const HEADER_NAMES = {
  contentTypeOptions: 'X-Content-Type-Options',
  frameOptions: 'X-Frame-Options',
  referrerPolicy: 'Referrer-Policy',
  contentSecurityPolicy: 'Content-Security-Policy',
} as const;

export function isHtmlContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const media = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return media === 'text/html' || media === 'application/xhtml+xml';
}

export function contentSecurityPolicy(contentType: string | null | undefined): string {
  return isHtmlContentType(contentType) ? HTML_CONTENT_SECURITY_POLICY : API_CONTENT_SECURITY_POLICY;
}

type HeaderPair = readonly [name: string, value: string];

function securityHeaderPairs(contentType: string | undefined): HeaderPair[] {
  return [
    [HEADER_NAMES.contentTypeOptions, 'nosniff'],
    [HEADER_NAMES.frameOptions, 'DENY'],
    [HEADER_NAMES.referrerPolicy, 'no-referrer'],
    [HEADER_NAMES.contentSecurityPolicy, contentSecurityPolicy(contentType)],
  ];
}

function headerText(value: OutgoingHttpHeader | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.map(String).join(', ') : String(value);
}

/** Node accepts `[name, value]` pairs here. The published type is a flat header list. */
function pairEntries(headers: OutgoingHttpHeader[]): Array<readonly [string, OutgoingHttpHeader | undefined]> | undefined {
  const pairs: Array<readonly [string, OutgoingHttpHeader | undefined]> = [];
  for (const entry of headers) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') return undefined;
    pairs.push([entry[0], entry[1]]);
  }
  return pairs;
}

function readBag(headers: OutgoingHttpHeaders | OutgoingHttpHeader[] | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  if (Array.isArray(headers)) {
    const pairs = pairEntries(headers);
    if (!pairs) return undefined;
    for (let i = pairs.length - 1; i >= 0; i -= 1) {
      const pair = pairs[i];
      if (pair?.[0].toLowerCase() === wanted) return headerText(pair[1]);
    }
    return undefined;
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headerText(headers[key]);
  }
  return undefined;
}

function writeBag(headers: OutgoingHttpHeaders | OutgoingHttpHeader[], pairs: readonly HeaderPair[]) {
  if (Array.isArray(headers)) {
    if (!pairEntries(headers)) return;
    for (const [name, value] of pairs) {
      const index = headers.findIndex((entry) => Array.isArray(entry) && entry[0].toLowerCase() === name.toLowerCase());
      if (index >= 0) headers[index] = [name, value];
      else headers.push([name, value]);
    }
    return;
  }
  for (const [name, value] of pairs) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name.toLowerCase() && key !== name) delete headers[key];
    }
    headers[name] = value;
  }
}

/**
 * Stamp every Node response at the moment headers are written, so a later
 * writer (the MCP transport, or Express's HTML error page) cannot drop them.
 * The Express import is type-only and is not part of the Worker bundle.
 */
export function securityHeaders(_req: Request, res: ExpressResponse, next: NextFunction) {
  const original = res.writeHead.bind(res);
  res.writeHead = ((
    statusCode: number,
    statusMessage?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
    headers?: OutgoingHttpHeaders | OutgoingHttpHeader[],
  ) => {
    const message = typeof statusMessage === 'string' ? statusMessage : undefined;
    const bag = typeof statusMessage === 'string' ? headers : statusMessage;
    const contentType = readBag(bag, 'content-type') ?? headerText(res.getHeader('content-type'));
    const pairs = securityHeaderPairs(contentType);
    if (!res.headersSent) {
      for (const [name, value] of pairs) res.setHeader(name, value);
    }
    if (bag) writeBag(bag, pairs);
    if (message !== undefined) return original(statusCode, message, bag);
    if (bag) return original(statusCode, bag);
    return original(statusCode);
  }) as typeof res.writeHead;
  next();
}

/** Copy a Fetch Response and set the same headers. The body and status are unchanged. */
export function withSecurityHeaders(response: globalThis.Response): globalThis.Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of securityHeaderPairs(headers.get('content-type') ?? undefined)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
