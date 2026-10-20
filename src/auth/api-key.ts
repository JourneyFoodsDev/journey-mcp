import { AuthError } from '../errors.js';
import type { Logger } from '../logger.js';
import { fingerprint, type Account } from './account.js';
import { allowanceOwner, parsePriceAccount, type PriceAccountIdentity } from './end-user.js';

export interface KeyLookupResponse {
  account_id: string;
  tier?: string | null;
  limits?: Account['contractLimits'];
}

/**
 * API key identity. The allowance belongs to the company or account, not the key.
 * The price feed GET /api/v1/account is checked first. A company id or account id there is the usage bucket,
 * so rotating or issuing another key for the same account does not reset caps.
 * Without a stable id, the bucket is a hash of the key (see the rollout note: the public account payload
 * is "key status and trial usage" and may not include one).
 */
export class ApiKeyResolver {
  private cache = new Map<string, { account: Account; until: number }>();
  constructor(
    private readonly lookupUrl: string | undefined,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly ttlMs = 5 * 60_000,
    private readonly priceApiBaseUrl?: string,
  ) {}

  async resolve(key: string, authMethod: Account['authMethod'] = 'api_key'): Promise<Account> {
    const fp = fingerprint(key);
    const hit = this.cache.get(fp);
    if (hit && hit.until > Date.now()) return hit.account;
    const price = await this.lookupPrice(key, fp);
    let account: Account;
    if (price?.stable) {
      account = this.fromIdentity(price, key, authMethod);
    } else if (this.lookupUrl) {
      const res = await this.fetchImpl(this.lookupUrl, { headers: { 'x-api-key': key, Accept: 'application/json' } });
      if (res.status === 401 || res.status === 403) throw new AuthError('The Journey API key is invalid or revoked.', 'invalid_api_key');
      if (!res.ok) throw new AuthError(`Journey account lookup failed (${res.status}).`, 'account_lookup_failed');
      const body = (await res.json()) as KeyLookupResponse;
      const parsed = parsePriceAccount(body);
      if (!body?.account_id && !parsed.stable) throw new AuthError('Journey account lookup returned no account.', 'account_lookup_failed');
      const owner = allowanceOwner(parsed).id ?? body.account_id;
      account = {
        id: `acct:${owner}`,
        tier: body.tier ?? parsed.tier ?? null,
        status: parsed.status ?? null,
        role: parsed.role ?? null,
        userId: parsed.userId,
        companyId: allowanceOwner(parsed).companyId ?? body.account_id,
        authMethod,
        scopes: ['journey:read'],
        upstreamApiKey: key,
        contractLimits: body.limits,
      };
    } else {
      if (price && !price.stable) this.log.warn('price account response has no stable company or account id; usage stays on this key', { key_fp: fp });
      else this.log.warn('api key lookup not configured; using default tier', { key_fp: fp });
      account = {
        id: `key:${fp}`,
        tier: price?.tier ?? null,
        status: price?.status ?? null,
        role: price?.role ?? null,
        userId: price?.userId,
        authMethod,
        scopes: ['journey:read'],
        upstreamApiKey: key,
      };
    }
    this.cache.set(fp, { account, until: Date.now() + this.ttlMs });
    return account;
  }

  /** Never treat the API key itself as an account id. */
  private sanitize(identity: PriceAccountIdentity, key: string): PriceAccountIdentity {
    const drop = (v?: string) => (v && v !== key ? v : undefined);
    const companyId = drop(identity.companyId);
    const accountId = drop(identity.accountId);
    const userId = drop(identity.userId);
    return { ...identity, companyId, accountId, userId, stable: Boolean(companyId || accountId || userId) };
  }

  private fromIdentity(identity: PriceAccountIdentity, key: string, authMethod: Account['authMethod']): Account {
    const owner = allowanceOwner(identity);
    return {
      id: `acct:${owner.id}`,
      tier: identity.tier ?? null,
      status: identity.status ?? null,
      role: identity.role ?? null,
      userId: owner.userId,
      companyId: owner.companyId,
      authMethod,
      scopes: ['journey:read'],
      upstreamApiKey: key,
    };
  }

  /** GET {price}/api/v1/account. Failures fall through; a bad price key must not block a developer key. */
  private async lookupPrice(key: string, fp: string): Promise<PriceAccountIdentity | undefined> {
    if (!this.priceApiBaseUrl) return undefined;
    const url = `${this.priceApiBaseUrl.replace(/\/+$/, '')}/api/v1/account`;
    try {
      const res = await this.fetchImpl(url, { headers: { 'x-api-key': key, Accept: 'application/json' } });
      if (!res.ok) return undefined;
      return this.sanitize(parsePriceAccount(await res.json()), key);
    } catch (e) {
      this.log.warn('price account lookup failed', { key_fp: fp, error: (e as Error).message });
      return undefined;
    }
  }
}
