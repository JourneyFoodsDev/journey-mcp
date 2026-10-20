import { createHmac } from 'node:crypto';

/** Backend allowance header (journey-nodejs PR #194). HMAC covers this exact string. */
export const END_USER_HEADER = 'x-journey-end-user';
export const END_USER_SIG_HEADER = 'x-journey-end-user-sig';
/** Backend rejects tokens whose exp - iat is greater than 300 seconds. */
export const END_USER_TTL_SEC = 300;

export interface EndUserClaims {
  userId?: string;
  companyId?: string;
  tier?: string;
  status?: string;
  role?: string;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * base64url JSON + hex HMAC-SHA256 of that header value.
 * Returns no headers when the signing secret or both identities are missing, so the backend is not sent a bad signature (401).
 * A service key with no end user then shares the backend's single public:service bucket.
 */
export function signEndUser(claims: EndUserClaims, secret: string | undefined, nowSec = Math.floor(Date.now() / 1000)): Record<string, string> {
  const key = secret?.trim();
  if (!key) return {};
  const userId = text(claims.userId);
  const companyId = text(claims.companyId);
  if (!userId && !companyId) return {};
  const payload: Record<string, string | number> = {};
  if (userId) payload.userId = userId;
  if (companyId) payload.companyId = companyId;
  const tier = text(claims.tier)?.toLowerCase();
  const status = text(claims.status)?.toLowerCase();
  const role = text(claims.role);
  if (tier) payload.tier = tier;
  if (status) payload.status = status;
  if (role) payload.role = role;
  payload.iat = nowSec;
  payload.exp = nowSec + END_USER_TTL_SEC;
  const header = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', key).update(header).digest('hex');
  return { [END_USER_HEADER]: header, [END_USER_SIG_HEADER]: sig };
}

/**
 * Read a Worker secret. Secrets Store bindings are objects with get(); env vars are strings.
 * A missing binding returns undefined. Pass optional so a missing signing secret does not fail the request.
 */
export async function readSecretBinding(value: unknown, opts?: { optional?: boolean }): Promise<string | undefined> {
  if (typeof value === 'string') return value.trim() || undefined;
  if (value && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    try {
      const v = await (value as { get: () => Promise<unknown> }).get();
      return typeof v === 'string' && v.trim() ? v.trim() : undefined;
    } catch (e) {
      if (opts?.optional) return undefined;
      throw e;
    }
  }
  return undefined;
}

export interface PriceAccountIdentity {
  companyId?: string;
  accountId?: string;
  userId?: string;
  tier?: string | null;
  status?: string | null;
  role?: string | null;
  /**
   * True when the payload has a company id, account id, or user id.
   * A bare `id` is not stable: the price feed describes /api/v1/account as key status, and a key id would reset caps.
   */
  stable: boolean;
}

const asObj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

function pick(obj: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const s = text(obj[k]);
    if (s) return s;
  }
  return undefined;
}

/** Read company, account, and user ids from a price-feed /api/v1/account (or key-lookup) body. */
export function parsePriceAccount(payload: unknown): PriceAccountIdentity {
  const root = asObj(payload) ?? {};
  const data = asObj(root.data) ?? root;
  const account = asObj(data.account) ?? asObj(root.account);
  const company = asObj(data.company) ?? asObj(root.company) ?? asObj(account?.company);

  const companyId =
    pick(data, ['companyId', 'company_id']) ??
    pick(root, ['companyId', 'company_id']) ??
    pick(account, ['companyId', 'company_id']) ??
    pick(company, ['id', 'companyId', 'company_id']);
  const accountId =
    pick(data, ['accountId', 'account_id']) ??
    pick(root, ['accountId', 'account_id']) ??
    pick(account, ['id', 'accountId', 'account_id']);
  const userId = pick(data, ['userId', 'user_id']) ?? pick(root, ['userId', 'user_id']) ?? pick(account, ['userId', 'user_id']);
  const tier = pick(data, ['tier', 'plan']) ?? pick(root, ['tier', 'plan']) ?? pick(account, ['tier', 'plan']) ?? null;
  const status =
    pick(data, ['status', 'subscriptionStatus', 'subscription_status']) ??
    pick(root, ['status', 'subscriptionStatus', 'subscription_status']) ??
    pick(account, ['status', 'subscriptionStatus', 'subscription_status']) ??
    null;
  const role = pick(data, ['role']) ?? pick(root, ['role']) ?? pick(account, ['role']) ?? null;
  return { companyId, accountId, userId, tier, status, role, stable: Boolean(companyId || accountId || userId) };
}

/** Company owns the allowance. An account id is the owner when the feed has no separate company id. */
export function allowanceOwner(identity: PriceAccountIdentity): { id?: string; companyId?: string; userId?: string } {
  const companyId = identity.companyId ?? identity.accountId;
  const userId = identity.userId;
  return { id: companyId ?? userId, companyId, userId };
}

/** Plan name the backend compares to `enterprise` (`app:enterprise` → `enterprise`). */
export function backendPlan(tier?: string | null): string | undefined {
  const t = tier?.trim().toLowerCase();
  if (!t) return undefined;
  return t.startsWith('app:') ? t.slice(4) : t;
}
