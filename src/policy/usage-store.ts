import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import type { Entity } from './policy.js';

/**
 * Lifetime usage per account: the distinct record ids each account has received.
 * The interface only needs counts and membership checks, so it can be backed by a
 * Durable Object, Postgres or Redis as well as memory or a local file.
 * Production needs a shared durable store so caps hold across instances.
 */
export interface UsageStore {
  /** The subset of `ids` this account has already received for `entity`. */
  hasMany(accountId: string, entity: Entity, ids: string[]): Promise<Set<string>>;
  add(accountId: string, entity: Entity, ids: string[]): Promise<void>;
  counts(accountId: string): Promise<Record<string, number>>;
}

export class MemoryUsageStore implements UsageStore {
  protected data = new Map<string, Map<Entity, Set<string>>>();
  protected bucket(accountId: string, entity: Entity) {
    let a = this.data.get(accountId);
    if (!a) this.data.set(accountId, (a = new Map()));
    let s = a.get(entity);
    if (!s) a.set(entity, (s = new Set()));
    return s;
  }
  async hasMany(accountId: string, entity: Entity, ids: string[]) {
    const s = this.bucket(accountId, entity);
    return new Set(ids.filter((id) => s.has(id)));
  }
  async add(accountId: string, entity: Entity, ids: string[]) {
    const s = this.bucket(accountId, entity);
    for (const id of ids) s.add(id);
  }
  async counts(accountId: string) {
    const out: Record<string, number> = {};
    for (const [e, s] of this.data.get(accountId) ?? []) out[e] = s.size;
    return out;
  }
}

/** Single-process JSON file store for local/stdio use. Not safe for multiple instances. */
export class FileUsageStore extends MemoryUsageStore {
  constructor(private readonly file: string) {
    super();
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, string[]>>;
      for (const [acct, ents] of Object.entries(raw)) {
        for (const [e, ids] of Object.entries(ents)) for (const id of ids) this.bucket(acct, e as Entity).add(id);
      }
    }
  }
  override async add(accountId: string, entity: Entity, ids: string[]) {
    await super.add(accountId, entity, ids);
    const out: Record<string, Record<string, string[]>> = {};
    for (const [acct, ents] of this.data) {
      out[acct] = {};
      for (const [e, s] of ents) out[acct][e] = [...s];
    }
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
