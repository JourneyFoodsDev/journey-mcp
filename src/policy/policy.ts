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
  /** Self-serve tiers are hard-clamped below maxSelfServeShare of Journey data. Contract tiers are not. */
  selfServe: boolean;
  requestsPerMinute: number;
  /** Lifetime distinct-record caps per entity. Omitted = maxSelfServeShare ceiling. */
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
  /** Hard ceiling for any self-serve account as a share of each total. Must stay below 0.02. */
  maxSelfServeShare: number;
  /** Absolute lifetime ingredient cap for every self-serve account (policy: 4,000). */
  ingredientLifetimeCap: number;
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
  maxSelfServeShare: 0.019,
  ingredientLifetimeCap: 4000,
  defaultTier: 'free',
  aliases: {
    none: 'free', trial: 'free', basic: 'free', pro: 'startup', starter: 'startup', custom: 'enterprise',
    // Journey app subscription tiers (used by the hosted server with OAuth).
    'app:explore': 'free', 'app:free_trial': 'free', 'app:supplier': 'free',
    'app:fresh': 'startup', 'app:growth': 'startup', 'app:group': 'startup',
    'app:enterprise': 'enterprise',
  },
  tiers: {
    // Free discovery tier: per account, lifetime, distinct records returned.
    // To make products + ingredients one combined 200 cap instead, add
    // lifetimeGroups: [{ name: 'products_and_ingredients', entities: ['product', 'ingredient'], limit: 200 }].
    free: {
      selfServe: true,
      requestsPerMinute: 10,
      lifetime: { product: 200, ingredient: 200, supplier: 10, lab_result: 25 },
      upgradeMessage: 'Upgrade to the Startup plan in the Journey developer portal at https://dev.journeyfoods.io for higher limits.',
    },
    startup: {
      selfServe: true,
      requestsPerMinute: 60,
      lifetime: { ingredient: 4000 },
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
  if (!(p.maxSelfServeShare > 0 && p.maxSelfServeShare < 0.02)) {
    throw new JourneyError('Policy maxSelfServeShare must be greater than 0 and below 0.02.', 'policy_invalid');
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

/**
 * Effective limits for an account. Self-serve tiers are clamped so no account can reach the
 * share ceiling of any entity or of the whole dataset, and ingredients never exceed the absolute cap.
 * Contract (non self-serve) tiers may carry account-specific overrides from the account record.
 */
export function effectiveLimits(
  policy: PolicyConfig,
  accountTier?: string | null,
  contractOverrides?: Partial<Record<Entity, number>> & { requestsPerMinute?: number; lifetimeTotal?: number },
): EffectiveLimits {
  const tier = resolveTier(policy, accountTier);
  const def = policy.tiers[tier];
  const lifetime = {} as Record<Entity, number>;
  const grandTotal = ENTITIES.reduce((s, e) => s + policy.totals[e], 0);
  for (const e of ENTITIES) {
    const ceiling = Math.floor(policy.totals[e] * policy.maxSelfServeShare);
    let cap = def.lifetime[e] ?? ceiling;
    if (!def.selfServe && contractOverrides?.[e] != null) cap = contractOverrides[e]!;
    if (def.selfServe) cap = Math.min(cap, ceiling);
    if (def.selfServe && e === 'ingredient') cap = Math.min(cap, policy.ingredientLifetimeCap);
    lifetime[e] = Math.max(0, cap);
  }
  const totalCeiling = Math.floor(grandTotal * policy.maxSelfServeShare);
  let lifetimeTotal = def.lifetimeTotal ?? totalCeiling;
  if (!def.selfServe && contractOverrides?.lifetimeTotal != null) lifetimeTotal = contractOverrides.lifetimeTotal;
  if (def.selfServe) lifetimeTotal = Math.min(lifetimeTotal, totalCeiling);
  const rpm = !def.selfServe && contractOverrides?.requestsPerMinute ? contractOverrides.requestsPerMinute : def.requestsPerMinute;
  const groups = (def.lifetimeGroups ?? []).map((g) => ({ ...g, limit: Math.max(0, g.limit) }));
  return { tier, selfServe: def.selfServe, requestsPerMinute: rpm, lifetime, lifetimeTotal, groups, upgradeMessage: def.upgradeMessage };
}
