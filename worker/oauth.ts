import { AuthorizationError, CimdFetchError, OAuthProvider, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { fingerprint, type Account } from '../src/auth/account.js';
import { AuthError } from '../src/errors.js';
import { messagePage, PAGE_SECURITY_HEADERS, signInPage } from './pages.js';

/**
 * Remote MCP OAuth for claude.ai custom connectors (and any MCP client that speaks the MCP
 * authorization spec). The user signs in by pasting their existing Journey API key; the grant
 * stores that key in the provider's encrypted props, so a bearer token behaves exactly like
 * the same key sent in x-api-key. Grants, clients and tokens live in OAUTH_KV (journey-mcp-oauth).
 */

export const DEFAULT_MCP_RESOURCE = 'https://mcp.journeyfoods.io/mcp';
export const SCOPES = ['mcp'];
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Props stored (encrypted) on each grant. Never logged or returned to the client. */
export interface GrantProps {
  apiKey: string;
}

export interface OAuthDeps<Env> {
  /** Serve one MCP request for a resolved Journey API key (same path x-api-key uses). */
  serveMcp(request: Request, env: Env, apiKey: string): Promise<Response>;
  /** Validate a Journey API key the same way x-api-key is validated. Throws AuthError when invalid. */
  resolveKey(env: Env, apiKey: string): Promise<Account>;
}

export function mcpResource(env: { MCP_RESOURCE?: unknown }): string {
  const raw = typeof env.MCP_RESOURCE === 'string' && env.MCP_RESOURCE.trim() ? env.MCP_RESOURCE.trim() : DEFAULT_MCP_RESOURCE;
  const url = new URL(raw);
  return `${url.origin}${url.pathname.replace(/\/$/, '') || '/mcp'}`;
}

/** RFC 9728 metadata URL for the resource, e.g. https://mcp.journeyfoods.io/.well-known/oauth-protected-resource/mcp */
export function resourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname === '/' ? '' : url.pathname}`;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** DCR policy: https redirect URIs (claude.ai, claude.com, any https app) or loopback http for desktop/CLI clients. */
export function redirectUriAllowed(uri: unknown): boolean {
  if (typeof uri !== 'string') return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname);
}

function html(body: string, status = 200, extra?: Headers): Response {
  const headers = new Headers(PAGE_SECURITY_HEADERS);
  if (extra) {
    extra.forEach((value, key) => {
      if (key.toLowerCase() !== 'set-cookie') headers.set(key, value);
    });
    for (const cookie of extra.getSetCookie()) headers.append('set-cookie', cookie);
  }
  return new Response(body, { status, headers });
}

function redirect(location: string, extra?: Headers): Response {
  const headers = new Headers(extra);
  headers.set('location', location);
  headers.set('cache-control', 'no-store');
  return new Response(null, { status: 302, headers });
}

async function handleAuthorize(request: Request, env: any, deps: OAuthDeps<any>): Promise<Response> {
  const oauth: OAuthHelpers = env.OAUTH_PROVIDER;
  if (request.method === 'GET') {
    const authRequest = await oauth.parseAuthRequest(request);
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    return html(signInPage({ clientName: details.clientName, redirectHost: details.redirectHost, handle: consent.handle }), 200, consent.headers);
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const form = await request.formData();
  const handle = String(form.get('handle') ?? '');
  const clientName = String(form.get('client_name') ?? '') || 'this app';
  const redirectHost = String(form.get('redirect_host') ?? '') || 'the app';
  if (!handle) return html(messagePage('Sign-in expired', 'Start the connection again from your AI app.'), 400);

  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(request, handle, { description: 'The user cancelled Journey sign-in.' });
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const apiKey = String(form.get('api_key') ?? '').trim();
  const retry = (error: string, status: number) =>
    html(signInPage({ clientName, redirectHost, handle, error }), status);
  if (!apiKey) return retry('Paste your Journey API key to continue.', 400);

  let account: Account;
  try {
    account = await deps.resolveKey(env, apiKey);
  } catch (e) {
    if (e instanceof AuthError) return retry('That Journey API key was not accepted. Check it and try again.', 401);
    console.log(JSON.stringify({ event: 'oauth_key_check_failed', error: e instanceof Error ? e.name : 'unknown' }));
    return retry('Journey could not check that key right now. Try again in a minute.', 503);
  }

  const approved = await oauth.approveConsent(request, handle);
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    // Stable per key, no colon (the provider's token format is userId:grantId:secret).
    userId: `key_${fingerprint(apiKey)}`,
    metadata: { account: account.id, tier: account.tier ?? null },
    scope: approved.request.scope,
    props: { apiKey } satisfies GrantProps,
  });
  console.log(JSON.stringify({ event: 'oauth_authorized', account: account.id, client: approved.request.clientId }));
  return redirect(redirectTo, approved.headers);
}

export function createOAuthProvider<Env>(env: Env, deps: OAuthDeps<Env>) {
  const resource = mcpResource(env as { MCP_RESOURCE?: unknown });
  return new OAuthProvider<any>({
    apiRoute: '/mcp',
    apiHandler: {
      async fetch(request: Request, apiEnv: any, ctx: any): Promise<Response> {
        const apiKey = (ctx?.props as Partial<GrantProps> | undefined)?.apiKey;
        if (typeof apiKey !== 'string' || !apiKey) {
          // Grants from the retired Firebase-session build carry no API key. Ask the client to sign in again.
          return new Response(JSON.stringify({ error: 'invalid_token', error_description: 'Sign in to Journey AI again.' }), {
            status: 401,
            headers: {
              'content-type': 'application/json',
              'www-authenticate': `Bearer realm="Journey AI", error="invalid_token", resource_metadata="${resourceMetadataUrl(resource)}"`,
            },
          });
        }
        return deps.serveMcp(request, apiEnv, apiKey);
      },
    },
    defaultHandler: {
      async fetch(request: Request, handlerEnv: any): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname !== '/authorize') return Response.json({ error: 'not_found' }, { status: 404 });
        try {
          return await handleAuthorize(request, handlerEnv, deps as OAuthDeps<any>);
        } catch (error) {
          if (error instanceof AuthorizationError && error.redirectTo) return redirect(error.redirectTo);
          if (error instanceof AuthorizationError) return html(messagePage('Authorization error', error.description), 400);
          if (error instanceof CimdFetchError) return html(messagePage('This app could not be verified', "The app's client metadata could not be fetched."), 400);
          throw error;
        }
      },
    },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: SCOPES,
    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
    clientRegistrationCallback: ({ clientMetadata }) => {
      const uris = clientMetadata.redirect_uris;
      if (!Array.isArray(uris) || uris.length === 0 || !uris.every(redirectUriAllowed)) {
        return { code: 'invalid_redirect_uri', description: 'Redirect URIs must be https, or http on localhost.', status: 400 };
      }
      return undefined;
    },
    resourceMetadata: {
      resource,
      authorization_servers: [new URL(resource).origin],
      scopes_supported: SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'Journey AI',
      resource_documentation: 'https://journeyfoods.io/mcp',
    },
  });
}
