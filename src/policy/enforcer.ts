import { CapExceededError, RateLimitError } from '../errors.js';
import { effectiveLimits, ENTITIES, type Entity, type EffectiveLimits, type PolicyConfig } from './policy.js';
import type { UsageStore } from './usage-store.js';
import type { Account } from '../auth/account.js';

export interface AdmitResult<T> {
  allowed: T[];
  withheld: number;
  remaining: number;
  /** Tier-specific upgrade hint, for notices about withheld results. */
  upgrade?: string;
}

/**
 * What tools need from the policy layer. PolicyEnforcer implements it in-process; a hosted deployment can
 * implement it with a shared per-account store so caps and rate limits are global.
 */
export interface Enforcer {
  checkRate(account: Account): void | Promise<void>;
  assertCapacity(account: Account, entity: Entity): Promise<void>;
  admit<T>(account: Account, entity: Entity, items: T[], idOf: (t: T) => string): Promise<AdmitResult<T>>;
  capErrorFor(account: Account, detail: string): Error | Promise<Error>;
  usage(account: Account): Promise<{ tier: string; limits: EffectiveLimits; used: Record<string, number> }>;
}

/** Server-side data access policy: per-minute rate limits and lifetime distinct-record caps per account. */
export class PolicyEnforcer implements Enforcer {
  private windows = new Map<string, number[]>();
  /** Serialize admits per account so concurrent calls cannot overshoot a cap in one process. */
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly policy: PolicyConfig,
    private readonly store: UsageStore,
    private readonly now: () => number = Date.now,
  ) {}

  limitsFor(account: Account): EffectiveLimits {
    return effectiveLimits(this.policy, account.tier, account.contractLimits, account.status);
  }

  /** Sliding one-minute window. Throws RateLimitError when the account is over its tier's limit. */
  checkRate(account: Account): void {
    const limits = this.limitsFor(account);
    const t = this.now();
    const arr = (this.windows.get(account.id) ?? []).filter((x) => t - x < 60_000);
    if (arr.length >= limits.requestsPerMinute) {
      const retry = Math.max(1, Math.ceil((60_000 - (t - arr[0])) / 1000));
      this.windows.set(account.id, arr);
      throw new RateLimitError(retry);
    }
    arr.push(t);
    this.windows.set(account.id, arr);
  }

  private async withLock<R>(accountId: string, fn: () => Promise<R>): Promise<R> {
    const prev = this.locks.get(accountId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(accountId, next.catch(() => undefined));
    return next;
  }

  private async totalSeen(accountId: string) {
    const c = await this.store.counts(accountId);
    return ENTITIES.reduce((s, e) => s + (c[e] ?? 0), 0);
  }

  /** Remaining room in every combined group that contains this entity (Infinity when none). */
  private async groupRoom(accountId: string, entity: Entity, limits: EffectiveLimits) {
    let room = Infinity;
    let hit: string | undefined;
    const groups = limits.groups.filter((g) => g.entities.includes(entity));
    if (!groups.length) return { room, hit };
    const c = await this.store.counts(accountId);
    for (const g of groups) {
      const r = g.limit - g.entities.reduce((s, e) => s + (c[e] ?? 0), 0);
      if (r < room) { room = r; hit = g.name; }
    }
    return { room, hit };
  }

  /** Throws before an upstream call when the account has nothing left for this entity. */
  async assertCapacity(account: Account, entity: Entity): Promise<void> {
    const limits = this.limitsFor(account);
    const seen = (await this.store.counts(account.id))[entity] ?? 0;
    const total = await this.totalSeen(account.id);
    if (seen >= limits.lifetime[entity]) throw this.capError(entity, limits);
    const g = await this.groupRoom(account.id, entity, limits);
    if (g.room <= 0) throw this.groupError(g.hit!, limits);
    if (total >= limits.lifetimeTotal) throw new CapExceededError('lifetime_records', 'This account has reached its lifetime record limit.', limits.upgradeMessage);
  }

  /** Cap error for tools that need to refuse after a partial admit (e.g. compare_suppliers). */
  capErrorFor(account: Account, detail: string) {
    return new CapExceededError('lifetime_records', detail, this.limitsFor(account).upgradeMessage);
  }

  /**
   * Admit records into an account's lifetime usage. Records the account already received are always allowed again.
   * New records are allowed up to the remaining allowance; the rest are withheld. If every record is new and none
   * fit, throws CapExceededError with the custom contract message.
   */
  async admit<T>(account: Account, entity: Entity, items: T[], idOf: (t: T) => string): Promise<AdmitResult<T>> {
    return this.withLock(account.id, async () => {
      const limits = this.limitsFor(account);
      const seen = await this.store.hasMany(account.id, entity, [...new Set(items.map(idOf))]);
      const seenCount = (await this.store.counts(account.id))[entity] ?? 0;
      const total = await this.totalSeen(account.id);
      const g = await this.groupRoom(account.id, entity, limits);
      const entityRoom = limits.lifetime[entity] - seenCount;
      let room = Math.min(entityRoom, limits.lifetimeTotal - total, g.room);
      const allowed: T[] = [];
      const fresh: string[] = [];
      let withheld = 0;
      for (const item of items) {
        const id = idOf(item);
        if (seen.has(id) || fresh.includes(id)) {
          allowed.push(item);
        } else if (room > 0) {
          allowed.push(item);
          fresh.push(id);
          room--;
        } else {
          withheld++;
        }
      }
      if (allowed.length === 0 && withheld > 0) {
        if (entityRoom <= 0) throw this.capError(entity, limits);
        if (g.room <= 0) throw this.groupError(g.hit!, limits);
        throw new CapExceededError('lifetime_records', 'This account has reached its lifetime record limit.', limits.upgradeMessage);
      }
      if (fresh.length) await this.store.add(account.id, entity, fresh);
      return { allowed, withheld, remaining: Math.max(0, room), upgrade: limits.upgradeMessage };
    });
  }

  async usage(account: Account) {
    const limits = this.limitsFor(account);
    const counts = await this.store.counts(account.id);
    return { tier: limits.tier, limits, used: counts };
  }

  private capError(entity: Entity, limits: EffectiveLimits) {
    const label: Record<Entity, string> = { product: 'products', supplier: 'suppliers', ingredient: 'ingredients', price_series: 'price series', lab_result: 'lab results' };
    if (entity === 'supplier' && limits.lifetime.supplier === 0) {
      return new CapExceededError('lifetime_supplier', 'This plan does not include the Journey supplier network.', limits.upgradeMessage);
    }
    const n = limits.lifetime[entity].toLocaleString('en-US');
    return new CapExceededError(`lifetime_${entity}`, `This account has reached its lifetime limit of ${n} ${label[entity]}.`, limits.upgradeMessage);
  }

  private groupError(name: string, limits: EffectiveLimits) {
    const g = limits.groups.find((x) => x.name === name)!;
    return new CapExceededError(`lifetime_${name}`, `This account has reached its combined lifetime limit of ${g.limit.toLocaleString('en-US')} ${g.entities.join(' and ').replace(/_/g, ' ')} records.`, limits.upgradeMessage);
  }
}

export function capNotice(withheld: number, upgrade?: string): string | undefined {
  if (!withheld) return undefined;
  return `${withheld} more result(s) were withheld because this account is at its self-serve data access limit. ${upgrade ? `${upgrade.trim()} ` : ''}Request a custom contract at https://journeyfoods.io/contact for more. Thank you.`;
}
