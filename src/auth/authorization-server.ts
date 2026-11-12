import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createLocalJWKSet, importJWK, jwtVerify, SignJWT, type JWK, type JWTPayload } from 'jose';
import type { JourneyConfig } from '../config.js';
import type { Account } from './account.js';
import { JwtVerifier, type TokenVerifier } from './oauth.js';

const ACCESS_TTL_SEC = 60 * 60;
const REFRESH_TTL_SEC = 14 * 24 * 60 * 60;
const CODE_TTL_MS = 60_000;
const SUPPORTED_SCOPES = ['journey:read', 'openid', 'profile'];

export interface IdentityRequest {
  redirectUri: string;
  state: string;
  scope: string;
  resource: string;
}

export type IdentityResult = { type: 'account'; account: Account } | { type: 'unconfigured' };

/** Login is supplied by a real identity provider. The default provider refuses to sign anyone in. */
export interface IdentityProvider {
  authenticate(input: IdentityRequest): Promise<IdentityResult>;
}

export class UnconfiguredIdentityProvider implements IdentityProvider {
  async authenticate(): Promise<IdentityResult> {
    return { type: 'unconfigured' };
  }
}

interface ClientRecord {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
}

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  resource: string;
  scope: string;
  challenge: string;
  account: Account;
  expires: number;
}

interface RefreshRecord {
  clientId: string;
  resource: string;
  scope: string;
  account: Account;
  expires: number;
}

export interface AuthStore {
  saveClient(client: ClientRecord): Promise<void>;
  getClient(id: string): Promise<ClientRecord | undefined>;
  saveCode(code: string, record: CodeRecord): Promise<void>;
  takeCode(code: string): Promise<CodeRecord | undefined>;
  saveRefresh(token: string, record: RefreshRecord): Promise<void>;
  takeRefresh(token: string): Promise<RefreshRecord | undefined>;
}

export class MemoryAuthStore implements AuthStore {
  private clients = new Map<string, ClientRecord>();
  private codes = new Map<string, CodeRecord>();
  private refresh = new Map<string, RefreshRecord>();
  async saveClient(client: ClientRecord) { this.clients.set(client.clientId, client); }
  async getClient(id: string) { return this.clients.get(id); }
  async saveCode(code: string, record: CodeRecord) { this.codes.set(code, record); }
  async takeCode(code: string) {
    const row = this.codes.get(code);
    this.codes.delete(code);
    if (!row || row.expires < Date.now()) return undefined;
    return row;
  }
  async saveRefresh(token: string, record: RefreshRecord) { this.refresh.set(token, record); }
  async takeRefresh(token: string) {
    const row = this.refresh.get(token);
    this.refresh.delete(token);
    if (!row || row.expires < Date.now()) return undefined;
    return row;
  }
}

export interface AuthorizationServerOptions {
  /** Issuer URL with no trailing slash. Tokens use this exact string. */
  issuer: string;
  /** Private JWK JSON. When unset, the server advertises metadata but will not mint tokens. */
  signingJwk?: string;
  identity?: IdentityProvider;
  allowedResources: string[];
  store?: AuthStore;
  /** Used only for Client ID Metadata Documents. */
  fetchImpl?: typeof fetch;
}

export interface RouteResult {
  status: number;
  body?: unknown;
  location?: string;
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function redirect(uri: string, params: Record<string, string>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** CIMD client ids are fetched. Only public https hosts, so this is not an internal URL fetch. */
function isPublicClientMetadataUrl(clientId: string): boolean {
  try {
    const url = new URL(clientId);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return false;
    if (host.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
    return host.includes('.');
  } catch {
    return false;
  }
}

function isRedirectUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/**
 * OAuth 2.1 authorization server for the MCP host: authorization code, PKCE S256 only,
 * RFC 8707 resource, and RFC 9207 issuer on every redirect. Login is not included.
 * Production should point protected-resource metadata at an identity provider that already
 * meets these requirements. This server keeps clients and codes in memory unless a store is injected.
 */
export class AuthorizationServer {
  private readonly identity: IdentityProvider;
  private readonly store: AuthStore;
  private readonly allowed: Set<string>;
  private key?: { privateKey: CryptoKey; publicKey: CryptoKey; publicJwk: JWK };
  private keyError?: string;
  private cimd = new Map<string, { expires: number; client: ClientRecord }>();

  constructor(private readonly opts: AuthorizationServerOptions) {
    this.identity = opts.identity ?? new UnconfiguredIdentityProvider();
    this.store = opts.store ?? new MemoryAuthStore();
    this.allowed = new Set(opts.allowedResources.map((resource) => resource.replace(/\/+$/, '')));
  }

  metadata() {
    const issuer = this.opts.issuer.replace(/\/+$/, '');
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      userinfo_endpoint: `${issuer}/oauth/userinfo`,
      scopes_supported: SUPPORTED_SCOPES,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: 'https://www.journeyfoods.io/mcp',
    };
  }

  async jwks(): Promise<{ keys: JWK[] }> {
    const key = await this.signingKey();
    return { keys: key ? [key.publicJwk] : [] };
  }

  async register(body: unknown): Promise<RouteResult> {
    const rec = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const redirects = Array.isArray(rec.redirect_uris) ? rec.redirect_uris.filter((uri): uri is string => typeof uri === 'string') : [];
    if (!redirects.length || redirects.length > 10 || redirects.some((uri) => !isRedirectUri(uri))) {
      return { status: 400, body: { error: 'invalid_client_metadata', error_description: 'redirect_uris must be https, or http on localhost.' } };
    }
    const method = typeof rec.token_endpoint_auth_method === 'string' ? rec.token_endpoint_auth_method : 'none';
    if (method !== 'none') {
      return { status: 400, body: { error: 'invalid_client_metadata', error_description: 'This authorization server accepts public clients only (token_endpoint_auth_method none).' } };
    }
    const client: ClientRecord = {
      clientId: `jny_${randomBytes(16).toString('hex')}`,
      redirectUris: redirects,
      ...(typeof rec.client_name === 'string' ? { clientName: rec.client_name.slice(0, 120) } : {}),
    };
    await this.store.saveClient(client);
    return {
      status: 201,
      body: {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: client.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(client.clientName ? { client_name: client.clientName } : {}),
      },
    };
  }

  async authorize(query: URLSearchParams): Promise<RouteResult> {
    const clientId = query.get('client_id') ?? '';
    const redirectUri = query.get('redirect_uri') ?? '';
    const state = query.get('state') ?? '';
    const resource = (query.get('resource') ?? '').replace(/\/+$/, '');
    const challenge = query.get('code_challenge') ?? '';
    const method = query.get('code_challenge_method') ?? '';
    const responseType = query.get('response_type') ?? '';
    const client = await this.clientFor(clientId);
    if (!client || !redirectUri || !client.redirectUris.includes(redirectUri)) {
      return { status: 400, body: { error: 'invalid_request', error_description: 'client_id and redirect_uri are not a registered pair.' } };
    }
    const fail = (error: string, description: string): RouteResult => ({
      status: 302,
      location: redirect(redirectUri, { error, error_description: description, ...(state ? { state } : {}), iss: this.metadata().issuer }),
    });
    if (!state) return fail('invalid_request', 'state is required.');
    if (responseType !== 'code') return fail('unsupported_response_type', 'Only authorization code is supported.');
    if (!resource || !this.allowed.has(resource)) return fail('invalid_target', 'resource is not a Journey MCP endpoint.');
    if (method !== 'S256' || !challenge) return fail('invalid_request', 'PKCE S256 is required. The plain method is not supported.');
    const scope = this.scopeOf(query.get('scope'));
    const identity = await this.identity.authenticate({ redirectUri, state, scope, resource });
    if (identity.type === 'unconfigured') {
      return fail('temporarily_unavailable', 'Identity provider is not configured.');
    }
    const code = randomBytes(32).toString('base64url');
    await this.store.saveCode(code, { clientId, redirectUri, resource, scope, challenge, account: identity.account, expires: Date.now() + CODE_TTL_MS });
    return { status: 302, location: redirect(redirectUri, { code, state, iss: this.metadata().issuer }) };
  }

  async token(params: URLSearchParams): Promise<RouteResult> {
    const grant = params.get('grant_type');
    const clientId = params.get('client_id') ?? '';
    const resource = (params.get('resource') ?? '').replace(/\/+$/, '');
    if (grant === 'authorization_code') {
      const code = await this.store.takeCode(params.get('code') ?? '');
      const verifier = params.get('code_verifier') ?? '';
      if (!code || code.clientId !== clientId || code.redirectUri !== (params.get('redirect_uri') ?? '') || code.resource !== resource) {
        return { status: 400, body: { error: 'invalid_grant', error_description: 'Authorization code is invalid, expired, or was issued for another client or resource.' } };
      }
      if (verifier.length < 43 || verifier.length > 128 || !same(s256(verifier), code.challenge)) {
        return { status: 400, body: { error: 'invalid_grant', error_description: 'PKCE verification failed.' } };
      }
      return this.issue(code.account, code.scope, code.resource, clientId);
    }
    if (grant === 'refresh_token') {
      const current = await this.store.takeRefresh(params.get('refresh_token') ?? '');
      if (!current || current.clientId !== clientId || (resource && current.resource !== resource)) {
        return { status: 400, body: { error: 'invalid_grant', error_description: 'Refresh token is invalid or expired.' } };
      }
      return this.issue(current.account, current.scope, current.resource, clientId);
    }
    return { status: 400, body: { error: 'unsupported_grant_type', error_description: 'Use authorization_code or refresh_token.' } };
  }

  async userinfo(authorization: string | undefined): Promise<RouteResult> {
    const token = authorization?.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
    const key = await this.signingKey();
    if (!token || !key) return { status: 401, body: { error: 'invalid_token' } };
    try {
      const { payload } = await jwtVerify(token, key.publicKey, { issuer: this.metadata().issuer });
      const aud = payload.aud;
      const auds = (Array.isArray(aud) ? aud : aud ? [aud] : []).map(String);
      if (!auds.some((item) => this.allowed.has(item.replace(/\/+$/, '')))) return { status: 401, body: { error: 'invalid_token' } };
      const body: Record<string, string> = {};
      if (typeof payload.sub === 'string' && payload.sub.trim()) body.sub = payload.sub;
      if (typeof payload.name === 'string' && payload.name.trim()) body.name = payload.name;
      if (typeof payload.email === 'string' && payload.email.trim()) body.email = payload.email;
      if (!body.sub) return { status: 401, body: { error: 'invalid_token' } };
      return { status: 200, body };
    } catch {
      return { status: 401, body: { error: 'invalid_token' } };
    }
  }

  private scopeOf(requested: string | null): string {
    const asked = (requested ?? '').split(' ').filter((scope) => SUPPORTED_SCOPES.includes(scope));
    if (!asked.includes('journey:read')) asked.unshift('journey:read');
    return [...new Set(asked)].join(' ');
  }

  private async clientFor(clientId: string): Promise<ClientRecord | undefined> {
    const stored = await this.store.getClient(clientId);
    if (stored) return stored;
    if (!isPublicClientMetadataUrl(clientId)) return undefined;
    const hit = this.cimd.get(clientId);
    if (hit && hit.expires > Date.now()) return hit.client;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetchImpl(clientId, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
      if (!res.ok) return undefined;
      const text = await res.text();
      if (text.length > 65_536) return undefined;
      const body = JSON.parse(text) as { redirect_uris?: unknown; client_name?: unknown };
      const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((uri): uri is string => typeof uri === 'string' && isRedirectUri(uri)) : [];
      if (!redirectUris.length) return undefined;
      const client: ClientRecord = { clientId, redirectUris, ...(typeof body.client_name === 'string' ? { clientName: body.client_name.slice(0, 120) } : {}) };
      this.cimd.set(clientId, { client, expires: Date.now() + 5 * 60_000 });
      return client;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private async issue(account: Account, scope: string, resource: string, clientId: string): Promise<RouteResult> {
    const key = await this.signingKey();
    if (!key) return { status: 500, body: { error: 'server_error', error_description: this.keyError ?? 'Token signing is not configured.' } };
    const subject = account.userId || account.companyId || account.id;
    const claims: JWTPayload = { scope };
    if (account.companyId || account.userId) claims.journey_account_id = account.companyId ?? account.userId;
    if (account.userId) claims.journey_user_id = account.userId;
    if (account.companyId) claims.journey_company_id = account.companyId;
    if (account.tier) claims.journey_tier = account.tier;
    if (account.status) claims.journey_status = account.status;
    if (account.role) claims.journey_role = account.role;
    if (account.displayName) claims.name = account.displayName;
    if (account.email) claims.email = account.email;
    const access = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: key.publicJwk.kid })
      .setIssuer(this.metadata().issuer)
      .setAudience(resource)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_SEC}s`)
      .sign(key.privateKey);
    const refresh = randomBytes(32).toString('base64url');
    await this.store.saveRefresh(refresh, { clientId, resource, scope, account, expires: Date.now() + REFRESH_TTL_SEC * 1000 });
    return { status: 200, body: { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_SEC, refresh_token: refresh, scope } };
  }

  private async signingKey() {
    if (this.key || this.keyError) return this.key;
    if (!this.opts.signingJwk) {
      this.keyError = 'Token signing is not configured.';
      return undefined;
    }
    try {
      const parsed = JSON.parse(this.opts.signingJwk) as JWK;
      const privateKey = await importJWK(parsed, 'ES256') as CryptoKey;
      const { d: _private, ...publicFields } = parsed;
      const pub: JWK = { ...publicFields, kid: parsed.kid ?? 'journey-mcp', alg: 'ES256', use: 'sig' };
      const publicKey = await importJWK(pub, 'ES256') as CryptoKey;
      this.key = { privateKey, publicKey, publicJwk: pub };
      return this.key;
    } catch {
      this.keyError = 'Token signing key could not be read.';
      return undefined;
    }
  }
}

export function createAuthorizationServer(opts: AuthorizationServerOptions): AuthorizationServer {
  return new AuthorizationServer(opts);
}

/** Verifies tokens this process minted. Used when no external JWKS is configured. */
export class BuiltinTokenVerifier implements TokenVerifier {
  constructor(private readonly server: AuthorizationServer, private readonly oauth: JourneyConfig['oauth'], private readonly issuer: string, private readonly resource: string) {}
  async verify(token: string, audience?: string | string[]): Promise<Account> {
    const jwks = createLocalJWKSet(await this.server.jwks());
    const expected = typeof audience === 'string' ? audience : this.resource;
    return new JwtVerifier({ ...this.oauth, issuer: this.issuer }, expected, jwks as never).verify(token, expected);
  }
}
