import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { AuthError } from '../errors.js';
import type { JourneyConfig } from '../config.js';
import type { Account } from './account.js';

/**
 * OAuth 2.1 resource-server side of the MCP authorization spec (2025-11-25):
 * - validates bearer access tokens issued by the configured authorization server (JWKS or RFC 7662 introspection)
 * - requires the token audience/resource to be this MCP server (RFC 8707) and the journey:read scope
 * - maps the token to a Journey account and tier from token claims
 * The authorization server itself (login, consent, DCR/CIMD) is configured separately via OAUTH_ISSUER.
 */
export interface TokenVerifier {
  verify(token: string): Promise<Account>;
}

function scopesOf(p: Record<string, unknown>): string[] {
  const s = p.scope ?? p.scp;
  if (Array.isArray(s)) return s.map(String);
  return typeof s === 'string' ? s.split(' ').filter(Boolean) : [];
}

function toAccount(p: Record<string, unknown>, cfg: JourneyConfig['oauth']): Account {
  const id = (p[cfg.accountClaim] ?? p.sub) as string | undefined;
  if (!id) throw new AuthError('Access token has no Journey account.');
  const scopes = scopesOf(p);
  if (cfg.requiredScope && !scopes.includes(cfg.requiredScope)) throw new AuthError(`Access token is missing the ${cfg.requiredScope} scope.`, 'insufficient_scope');
  const tier = (p[cfg.tierClaim] as string | undefined) ?? null;
  const limits = p.journey_limits as Account['contractLimits'] | undefined;
  return { id: `acct:${id}`, tier, authMethod: 'oauth', scopes, contractLimits: limits };
}

export class JwtVerifier implements TokenVerifier {
  private jwks;
  constructor(private readonly cfg: JourneyConfig['oauth'], private readonly resource: string, jwks?: Parameters<typeof jwtVerify>[1]) {
    if (!cfg.jwksUrl && !jwks) throw new Error('OAUTH_JWKS_URL is required for JWT verification');
    this.jwks = jwks ?? createRemoteJWKSet(new URL(cfg.jwksUrl!));
  }
  async verify(token: string): Promise<Account> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks as never, { issuer: this.cfg.issuer, audience: this.resource }));
    } catch (e) {
      throw new AuthError(`Access token rejected: ${(e as Error).message}`);
    }
    return toAccount(payload as Record<string, unknown>, this.cfg);
  }
}

export class IntrospectionVerifier implements TokenVerifier {
  constructor(private readonly cfg: JourneyConfig['oauth'], private readonly resource: string, private readonly fetchImpl: typeof fetch = fetch) {}
  async verify(token: string): Promise<Account> {
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
    if (!auds.map(norm).includes(norm(this.resource))) throw new AuthError('Access token was not issued for this MCP server.');
    if (this.cfg.issuer && body.iss && body.iss !== this.cfg.issuer) throw new AuthError('Access token issuer is not trusted.');
    return toAccount(body, this.cfg);
  }
}

export function createTokenVerifier(cfg: JourneyConfig): TokenVerifier | undefined {
  if (cfg.oauth.jwksUrl) return new JwtVerifier(cfg.oauth, cfg.resourceUrl);
  if (cfg.oauth.introspectionUrl) return new IntrospectionVerifier(cfg.oauth, cfg.resourceUrl);
  return undefined;
}

/** RFC 9728 protected resource metadata served at /.well-known/oauth-protected-resource[/mcp]. */
export function protectedResourceMetadata(cfg: JourneyConfig) {
  return {
    resource: cfg.resourceUrl,
    authorization_servers: cfg.oauth.issuer ? [cfg.oauth.issuer] : [],
    scopes_supported: [cfg.oauth.requiredScope],
    bearer_methods_supported: ['header'],
    resource_name: 'Journey AI',
    resource_documentation: 'https://journeyfoods.io/mcp',
  };
}
