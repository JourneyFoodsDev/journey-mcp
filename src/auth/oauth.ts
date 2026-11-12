import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AuthError } from '../errors.js';
import type { JourneyConfig } from '../config.js';
import type { Account } from './account.js';

/** Auth0 API scopes for the two ChatGPT apps. offline_access is advertised, not required. */
export const CATALOG_SCOPE = 'catalog:read';
export const PROFILE_SCOPE = 'profile:read';
export const APP_OAUTH_SCOPES = [CATALOG_SCOPE, PROFILE_SCOPE, 'offline_access'] as const;
/**
 * Set by an Auth0 Action from Journey subscription data. A boolean true grants
 * full search. Anything else, including a missing claim, keeps the 4-result gate.
 */
export const FULL_CATALOG_CLAIM = 'https://journeyfoods.io/full_catalog';

export function isAppResource(resource: string): boolean {
  try {
    const path = new URL(resource).pathname;
    return path === '/apps/journey-foods/mcp' || path === '/apps/guava/mcp';
  } catch {
    return false;
  }
}

export function scopeForTool(tool: string): string {
  return tool === 'get_profile' ? PROFILE_SCOPE : CATALOG_SCOPE;
}

/**
 * OAuth 2.1 resource-server side of the MCP authorization spec (2025-11-25):
 * - validates bearer access tokens issued by the configured authorization server (JWKS or RFC 7662 introspection)
 * - requires the token audience/resource to be this MCP server (RFC 8707) and the journey:read scope
 * - maps the token to a Journey account and tier from token claims
 * The authorization server itself (login, consent, DCR/CIMD) is configured separately via OAUTH_ISSUER.
 */
export interface TokenVerifier {
  verify(token: string, audience?: string | string[]): Promise<Account>;
}

function scopesOf(p: Record<string, unknown>): string[] {
  const s = p.scope ?? p.scp;
  if (Array.isArray(s)) return s.map(String);
  return typeof s === 'string' ? s.split(' ').filter(Boolean) : [];
}

function claim(p: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = p[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function truthyClaim(value: unknown): boolean {
  return value === true || value === 'true';
}

function toAccount(p: Record<string, unknown>, cfg: JourneyConfig['oauth'], resource?: string): Account {
  const userId = claim(p, [cfg.userClaim, 'journey_user_id', 'user_id', 'sub']);
  const companyId = claim(p, [cfg.companyClaim, 'journey_company_id', 'company_id', cfg.accountClaim]);
  const id = companyId ?? userId ?? claim(p, [cfg.accountClaim, 'sub']);
  if (!id) throw new AuthError('Access token has no Journey account.');
  const scopes = scopesOf(p);
  const app = resource ? isAppResource(resource) : false;
  if (app) {
    if (!scopes.includes(CATALOG_SCOPE) && !scopes.includes(PROFILE_SCOPE)) {
      throw new AuthError(`Access token is missing the ${CATALOG_SCOPE} or ${PROFILE_SCOPE} scope.`, 'insufficient_scope');
    }
  } else if (cfg.requiredScope && !scopes.includes(cfg.requiredScope)) {
    throw new AuthError(`Access token is missing the ${cfg.requiredScope} scope.`, 'insufficient_scope');
  }
  const tier = claim(p, [cfg.tierClaim]) ?? null;
  const status = claim(p, [cfg.statusClaim, 'journey_status', 'subscription_status', 'status']) ?? null;
  const role = claim(p, [cfg.roleClaim, 'journey_role', 'role']) ?? null;
  const displayName = claim(p, ['name', 'preferred_username']);
  const email = claim(p, ['email']);
  const limits = p.journey_limits as Account['contractLimits'] | undefined;
  // The company owns the allowance. The user is still forwarded so the backend can attribute the call.
  return {
    id: `acct:${companyId ?? id}`,
    tier,
    status,
    role,
    userId,
    companyId,
    authMethod: 'oauth',
    scopes,
    contractLimits: limits,
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {}),
    fullCatalogAccess: truthyClaim(p[FULL_CATALOG_CLAIM]),
  };
}

export function missingScopeResult(metadataUrl: string, scope: string): CallToolResult {
  const challenge = `Bearer resource_metadata="${metadataUrl}", scope="${scope}", error="insufficient_scope", error_description="The access token is missing the ${scope} scope"`;
  return {
    isError: true,
    content: [{ type: 'text', text: `The access token is missing the ${scope} scope.` }],
    _meta: { 'mcp/www_authenticate': [`'${challenge}'`] },
  };
}

export class JwtVerifier implements TokenVerifier {
  private jwks;
  constructor(private readonly cfg: JourneyConfig['oauth'], private readonly resource: string, jwks?: Parameters<typeof jwtVerify>[1]) {
    if (!cfg.jwksUrl && !jwks) throw new Error('OAUTH_JWKS_URL is required for JWT verification');
    this.jwks = jwks ?? createRemoteJWKSet(new URL(cfg.jwksUrl!));
  }
  async verify(token: string, audience?: string | string[]): Promise<Account> {
    const expected = audience ?? this.resource;
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks as never, {
        issuer: this.cfg.issuer,
        audience: expected,
        ...(this.cfg.algorithms?.length ? { algorithms: this.cfg.algorithms } : {}),
      }));
    } catch (e) {
      throw new AuthError(`Access token rejected: ${(e as Error).message}`);
    }
    const resource = typeof expected === 'string' ? expected : expected[0];
    return toAccount(payload as Record<string, unknown>, this.cfg, resource);
  }
}

export class IntrospectionVerifier implements TokenVerifier {
  constructor(private readonly cfg: JourneyConfig['oauth'], private readonly resource: string, private readonly fetchImpl: typeof fetch = fetch) {}
  async verify(token: string, audience?: string): Promise<Account> {
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (this.cfg.introspectionClientId && this.cfg.introspectionClientSecret) {
      headers.Authorization = 'Basic ' + Buffer.from(`${this.cfg.introspectionClientId}:${this.cfg.introspectionClientSecret}`).toString('base64');
    }
    const res = await this.fetchImpl(this.cfg.introspectionUrl!, { method: 'POST', headers, body: new URLSearchParams({ token }) });
    if (!res.ok) throw new AuthError(`Token introspection failed (${res.status}).`);
    const body = (await res.json()) as Record<string, unknown>;
    if (body.active !== true) throw new AuthError('Access token is not active.');
    const aud = body.aud ?? body.resource;
    const auds = Array.isArray(aud) ? aud.map(String) : aud ? [String(aud)] : [];
    const norm = (u: string) => u.replace(/\/+$/, '');
    const expected = audience ?? this.resource;
    if (!auds.map(norm).includes(norm(expected))) throw new AuthError('Access token was not issued for this MCP server.');
    if (this.cfg.issuer && body.iss && body.iss !== this.cfg.issuer) throw new AuthError('Access token issuer is not trusted.');
    return toAccount(body, this.cfg, expected);
  }
}

export function createTokenVerifier(cfg: JourneyConfig): TokenVerifier | undefined {
  if (cfg.oauth.jwksUrl) return new JwtVerifier(cfg.oauth, cfg.resourceUrl);
  if (cfg.oauth.introspectionUrl) return new IntrospectionVerifier(cfg.oauth, cfg.resourceUrl);
  return undefined;
}

/** RFC 9728 protected resource metadata served at /.well-known/oauth-protected-resource[/mcp]. */
export function protectedResourceMetadata(cfg: JourneyConfig, over: { resource?: string; name?: string; documentation?: string; scopes?: readonly string[] } = {}) {
  const resource = over.resource ?? cfg.resourceUrl;
  const origin = new URL(resource).origin;
  return {
    resource,
    authorization_servers: cfg.oauth.issuer ? [cfg.oauth.issuer] : [origin],
    scopes_supported: [...(over.scopes ?? [cfg.oauth.requiredScope])],
    bearer_methods_supported: ['header'],
    resource_name: over.name ?? 'Journey',
    resource_documentation: over.documentation ?? 'https://www.journeyfoods.io/mcp',
  };
}
