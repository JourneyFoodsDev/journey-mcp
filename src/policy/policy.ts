import { readFileSync } from 'node:fs';
import { JourneyError } from '../errors.js';

/** Entity types counted toward lifetime caps. Each distinct record an account receives counts once, forever. */
export type Entity = 'product' | 'supplier' | 'ingredient' | 'price_series' | 'lab_result';
export const ENTITIES: Entity[] = ['product', 'supplier', 'ingredient', 'price_series', 'lab_result'];

/** A combined lifetime cap across several entities, e.g. 200 products and ingredients together. */
export interface LifetimeGroup {
  name: string;
  entities: Entity[];
  limit: number;
}

export interface TierLimits {
  /** Tiers below Enterprise are hard-clamped to maxSelfServeShare of Journey data. Active Enterprise is not. */
  selfServe: boolean;
  requestsPerMinute: number;
  /** Lifetime distinct-record caps per entity. Omitted = the 2% ceiling. 0 means that type is not included. */
  lifetime: Partial<Record<Entity, number>>;
  /** Lifetime distinct records across all entities. Omitted = maxSelfServeShare of all records. */
  lifetimeTotal?: number;
  /** Optional combined caps across entities (applied on top of the per-entity caps). */
  lifetimeGroups?: LifetimeGroup[];
  /** Extra sentence added to cap-hit messages for this tier, e.g. how to upgrade. No pricing. */
  upgradeMessage?: string;
}

export interface PolicyConfig {
  /** Record counts in the Journey dataset, used to compute the 2% ceiling. Keep current. */
  totals: Record<Entity, number>;
  /** Hard ceiling for every tier below Enterprise, as a share of each total. Exactly 0.02 is 2%. */
  maxSelfServeShare: number;
  /** Tier used when an account has no tier or an unknown tier. Should be the most restrictive tier. */
  defaultTier: string;
  /** Map account plan ids (e.g. dev portal "none", "basic", "pro") to policy tiers. */
  aliases: Record<string, string>;
  tiers: Record<string, TierLimits>;
}

/**
 * Built-in policy. Tier names and limits only; no pricing lives in the server.
 * Totals are approximate dataset sizes used to keep self-serve tiers under the share ceiling.
 */
export const DEFAULT_POLICY: PolicyConfig = {
  totals: { product: 488009, supplier: 34388, ingredient: 500000, price_series: 750, lab_result: 10000 },
  maxSelfServeShare: 0.02,
  defaultTier: 'free',
  aliases: {
    none: 'free', trial: 'free', basic: 'free', pro: 'startup', starter: 'startup', custom: 'enterprise',
    // Journey app plans. Supplier is a paid plan. Fresh is paid and has no supplier network.
    explore: 'free', free_trial: 'free',
    supplier: 'startup', growth: 'startup', group: 'startup',
    'app:explore': 'free', 'app:free_trial': 'free', 'app:supplier': 'startup',
    'app:fresh': 'fresh', 'app:growth': 'startup', 'app:group': 'startup',
    'app:enterprise': 'enterprise',
  },
  tiers: {
    // Free discovery tier (Explore): per company or account, lifetime, distinct records.
    // These counts stay only while each one is under 2% of that dataset.
    // To make products + ingredients one combined 200 cap instead, add
    // lifetimeGroups: [{ name: 'products_and_ingredients', entities: ['product', 'ingredient'], limit: 200 }].
    free: {
      selfServe: true,
      requestsPerMinute: 10,
      lifetime: { product: 200, ingredient: 200, supplier: 10, lab_result: 25 },
      upgradeMessage: 'Upgrade to the Startup plan in the Journey developer portal at https://dev.journeyfoods.io for higher limits.',
    },
    // Paid brand plan. No supplier network, so supplier records are not included. Other types use the 2% ceiling.
    fresh: {
      selfServe: true,
      requestsPerMinute: 60,
      lifetime: { supplier: 0 },
    },
    // Paid plans below Enterprise (Supplier, Growth, Group, Startup): exactly 2% of each type. No extra ingredient cap.
    startup: {
      selfServe: true,
      requestsPerMinute: 60,
      lifetime: {},
    },
    enterprise: {
      selfServe: false,
      requestsPerMinute: 300,
      lifetime: {},
    },
  },
};

export interface EffectiveLimits {
  tier: string;
  selfServe: boolean;
  requestsPerMinute: number;
  lifetime: Record<Entity, number>;
  lifetimeTotal: number;
  groups: LifetimeGroup[];
  upgradeMessage?: string;
}

export function validatePolicy(p: PolicyConfig): PolicyConfig {
  if (!(p.maxSelfServeShare > 0 && p.maxSelfServeShare <= 0.02)) {
    throw new JourneyError('Policy maxSelfServeShare must be greater than 0 and at most 0.02 (exactly 2%).', 'policy_invalid');
  }
  if (!p.tiers[p.defaultTier]) throw new JourneyError(`Policy defaultTier "${p.defaultTier}" is not defined.`, 'policy_invalid');
  for (const [name, t] of Object.entries(p.tiers)) {
    for (const g of t.lifetimeGroups ?? []) {
      if (!g.entities?.length || g.entities.some((e) => !ENTITIES.includes(e)) || !(g.limit >= 0)) {
        throw new JourneyError(`Policy tier "${name}" has an invalid lifetime group "${g.name}".`, 'policy_invalid');
      }
    }
  }
  for (const [alias, target] of Object.entries(p.aliases)) {
    if (!p.tiers[target]) throw new JourneyError(`Policy alias "${alias}" points to unknown tier "${target}".`, 'policy_invalid');
  }
  return p;
}

export function loadPolicy(file?: string): PolicyConfig {
  if (!file) return validatePolicy(DEFAULT_POLICY);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PolicyConfig>;
  return validatePolicy({ ...DEFAULT_POLICY, ...parsed, totals: { ...DEFAULT_POLICY.totals, ...(parsed.totals ?? {}) } });
}

export function resolveTier(policy: PolicyConfig, accountTier?: string | null): string {
  const t = (accountTier ?? '').toLowerCase().trim();
  if (t && policy.tiers[t]) return t;
  if (t && policy.aliases[t]) return policy.aliases[t];
  return policy.defaultTier;
}

/** Enterprise is uncapped only while the subscription is active or trialing. Any other status stays on the 2% ceiling. */
export function isUncappedEnterprise(tier: string, status?: string | null): boolean {
  const s = (status ?? '').toLowerCase().trim();
  return tier === 'enterprise' && (s === 'active' || s === 'trialing');
}

/**
 * Effective limits for a company or account.
 * Every tier below Enterprise is clamped to exactly maxSelfServeShare (2%) of each dataset.
 * Enterprise with status active or trialing is uncapped, and may carry contract overrides.
 */
export function effectiveLimits(
  policy: PolicyConfig,
  accountTier?: string | null,
  contractOverrides?: Partial<Record<Entity, number>> & { requestsPerMinute?: number; lifetimeTotal?: number },
  status?: string | null,
): EffectiveLimits {
  const tier = resolveTier(policy, accountTier);
  const def = policy.tiers[tier];
  const uncapped = isUncappedEnterprise(tier, status);
  const lifetime = {} as Record<Entity, number>;
  const grandTotal = ENTITIES.reduce((s, e) => s + policy.totals[e], 0);
  for (const e of ENTITIES) {
    const ceiling = Math.floor(policy.totals[e] * policy.maxSelfServeShare);
    let cap: number;
    if (uncapped) cap = contractOverrides?.[e] != null ? contractOverrides[e]! : Number.POSITIVE_INFINITY;
    else cap = Math.min(def.lifetime[e] ?? ceiling, ceiling);
    lifetime[e] = Math.max(0, cap);
  }
  const totalCeiling = Math.floor(grandTotal * policy.maxSelfServeShare);
  const lifetimeTotal = uncapped
    ? contractOverrides?.lifetimeTotal != null ? contractOverrides.lifetimeTotal : Number.POSITIVE_INFINITY
    : Math.min(def.lifetimeTotal ?? totalCeiling, totalCeiling);
  const rpm = uncapped && contractOverrides?.requestsPerMinute ? contractOverrides.requestsPerMinute : def.requestsPerMinute;
  const groups = (def.lifetimeGroups ?? []).map((g) => ({ ...g, limit: Math.max(0, g.limit) }));
  return { tier, selfServe: !uncapped, requestsPerMinute: rpm, lifetime, lifetimeTotal, groups, upgradeMessage: def.upgradeMessage };
}
