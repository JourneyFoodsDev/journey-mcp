import type { Account } from '../auth/account.js';
import { resolveTier } from './policy.js';
import { DEFAULT_POLICY } from './policy.js';

/** Anonymous callers and accounts without full catalog access see at most this many search rows. */
export const SEARCH_PREVIEW_LIMIT = 4;

/**
 * Informational page only. It must not be a checkout, upgrade, or subscription flow.
 * Humans should replace this if a dedicated access page is published.
 */
export const ACCOUNT_INFO_URL = 'https://www.journeyfoods.io/mcp';

export const ACCOUNT_NOTE = `More results need a Journey account. ${ACCOUNT_INFO_URL}`;
export const PAGE_NOTE = `Further pages need a Journey account. ${ACCOUNT_INFO_URL}`;

const FULL_ACCESS_TIERS = new Set(['fresh', 'startup', 'enterprise']);
const ACTIVE_STATUS = new Set(['active', 'trialing']);

/**
 * Full search results require a signed-in account whose plan already includes catalog access.
 * A missing status does not block a paid tier: API-key lookups often omit it.
 * A present status must be active or trialing. Canceled and past-due accounts stay on the preview.
 */
export function hasFullSearch(account: Account): boolean {
  if (account.authMethod === 'anonymous') return false;
  const tier = resolveTier(DEFAULT_POLICY, account.tier);
  if (!FULL_ACCESS_TIERS.has(tier)) return false;
  const status = account.status?.trim().toLowerCase();
  if (!status) return true;
  return ACTIVE_STATUS.has(status);
}

export function previewQuery(account: Account, requested: number, page = 1): { blocked: true; notice: string } | { blocked: false; limit: number } {
  if (hasFullSearch(account)) return { blocked: false, limit: requested };
  if (page > 1) return { blocked: true, notice: PAGE_NOTE };
  return { blocked: false, limit: Math.min(requested, SEARCH_PREVIEW_LIMIT + 1) };
}

/** Drop rows past the preview. The note is set only when a row was actually withheld. */
export function applyPreview<T>(account: Account, rows: T[]): { rows: T[]; notice?: string } {
  if (hasFullSearch(account) || rows.length <= SEARCH_PREVIEW_LIMIT) return { rows };
  return { rows: rows.slice(0, SEARCH_PREVIEW_LIMIT), notice: ACCOUNT_NOTE };
}

export function joinNotice(...parts: Array<string | undefined>): string | undefined {
  const text = parts.filter((p): p is string => Boolean(p && p.trim())).join(' ');
  return text || undefined;
}

const PROMO = /upgrade|checkout|subscribe|pricing|\bplan\b|contract|buy now|add to cart/i;

/** Directory responses explain a limit and link to the informational page. No upgrade or checkout copy. */
export function directoryAccessMessage(message: string): string {
  const parts = message.split(/\.\s+/).map((s) => s.replace(/\.$/, '').trim()).filter(Boolean);
  const kept = parts.filter((s) => !PROMO.test(s)).slice(0, 2);
  const lead = kept.join('. ') || 'This result is not included with the current account';
  return `${lead}. More access needs a Journey account. ${ACCOUNT_INFO_URL}`;
}

export function limitNotice(withheld: number, upgrade: string | undefined, directory?: boolean): string | undefined {
  if (!withheld) return undefined;
  if (directory) return `${withheld} more result(s) were withheld because this account is at its data access limit. More access needs a Journey account. ${ACCOUNT_INFO_URL}`;
  const tail = upgrade?.trim() ? `${upgrade.trim()} ` : '';
  return `${withheld} more result(s) were withheld because this account is at its self-serve data access limit. ${tail}Request a custom contract at https://journeyfoods.io/contact for more. Thank you.`;
}
