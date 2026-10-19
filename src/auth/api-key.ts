import { AuthError } from '../errors.js';
import type { Logger } from '../logger.js';
import { fingerprint, type Account } from './account.js';

export interface KeyLookupResponse {
  account_id: string;
  tier?: string | null;
  limits?: Account['contractLimits'];
}

/**
 * API key fallback. With JOURNEY_KEY_LOOKUP_URL set, Journey resolves the key to its account and tier.
 * Without it, the account id is a hash of the key and the tier is the policy default (most restrictive).
 * Upstream still enforces the key's own plan.
 */
export class ApiKeyResolver {
  private cache = new Map<string, { account: Account; until: number }>();
  constructor(
    private readonly lookupUrl: string | undefined,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  async resolve(key: string, authMethod: Account['authMethod'] = 'api_key'): Promise<Account> {
    const fp = fingerprint(key);
    const hit = this.cache.get(fp);
    if (hit && hit.until > Date.now()) return hit.account;
    let account: Account;
    if (this.lookupUrl) {
      const res = await this.fetchImpl(this.lookupUrl, { headers: { 'x-api-key': key, Accept: 'application/json' } });
      if (res.status === 401 || res.status === 403) throw new AuthError('The Journey API key is invalid or revoked.', 'invalid_api_key');
      if (!res.ok) throw new AuthError(`Journey account lookup failed (${res.status}).`, 'account_lookup_failed');
      const body = (await res.json()) as KeyLookupResponse;
      if (!body?.account_id) throw new AuthError('Journey account lookup returned no account.', 'account_lookup_failed');
      account = { id: `acct:${body.account_id}`, tier: body.tier ?? null, authMethod, scopes: ['journey:read'], upstreamApiKey: key, contractLimits: body.limits };
    } else {
      this.log.warn('api key lookup not configured; using default tier', { key_fp: fp });
      account = { id: `key:${fp}`, tier: null, authMethod, scopes: ['journey:read'], upstreamApiKey: key };
    }
    this.cache.set(fp, { account, until: Date.now() + this.ttlMs });
    return account;
  }
}
