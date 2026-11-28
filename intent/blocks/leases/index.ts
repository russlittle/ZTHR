/**
 * Leases on named resources: an exclusive hold with an owner, a token and a time limit, that ends on its own when
 * the time runs out, so a crashed holder can never lock anyone out for good. A lease on a folder-like resource can
 * cover everything below it ("a/b" covers "a/b/c"), and nothing below may be held by someone else at the same time.
 * Resources are paths of "/"-separated steps; the caller decides what they name.
 */
import { randomUUID } from 'node:crypto';

export interface Lease {
  readonly token: string;
  readonly resource: string;
  readonly owner: string;
  /** Who is holding it in words: a person, an app, an editor. */
  readonly holder: string;
  readonly deep: boolean;
  readonly since: number;
  /** When it ends on its own; 0 means it lasts until released. */
  readonly until: number;
}

export interface LeaseStore {
  all(): Promise<Lease[]>;
  set(l: Lease): Promise<void>;
  delete(token: string): Promise<void>;
}

export function memoryLeases(): LeaseStore {
  const m = new Map<string, Lease>();
  return { all: async () => [...m.values()], set: async (l) => void m.set(l.token, l), delete: async (t) => void m.delete(t) };
}

export class Held extends Error {
  readonly by: Lease;
  constructor(by: Lease) {
    super(`${by.resource} is held by ${by.holder}`);
    this.by = by;
  }
}

export class NoLease extends Error {
  constructor(token: string) {
    super(`no lease ${token}, or it ended`);
  }
}

export const norm = (r: string) => `/${r.split('/').filter(Boolean).join('/')}`;
const covers = (l: Lease, r: string) => l.resource === r || (l.deep && (l.resource === '/' || r.startsWith(`${l.resource}/`)));
const overlaps = (a: Lease, r: string, deep: boolean) => covers(a, r) || (deep && (r === '/' || a.resource.startsWith(`${r}/`)));

export interface LeasesOptions {
  readonly now?: () => number;
  /** The longest a lease may be asked for; longer asks are cut to this. */
  readonly maxMs?: number;
}

export class Leases {
  private readonly store: LeaseStore;
  private readonly now: () => number;
  private readonly maxMs: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(store: LeaseStore, o: LeasesOptions = {}) {
    this.store = store;
    this.now = o.now ?? Date.now;
    this.maxMs = o.maxMs ?? 30 * 60_000;
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Leases still in force; ended ones are dropped as they are found. */
  private async live(): Promise<Lease[]> {
    const t = this.now();
    const out: Lease[] = [];
    for (const l of await this.store.all()) {
      if (l.until && l.until <= t) await this.store.delete(l.token);
      else out.push(l);
    }
    return out;
  }

  async acquire(resource: string, owner: string, o: { holder?: string; deep?: boolean; ms?: number } = {}): Promise<Lease> {
    const r = norm(resource);
    const deep = !!o.deep;
    return this.serial(async () => {
      const clash = (await this.live()).find((l) => overlaps(l, r, deep));
      if (clash) throw new Held(clash);
      const ms = o.ms === 0 ? 0 : Math.min(o.ms ?? this.maxMs, this.maxMs);
      const l: Lease = { token: `opaquelocktoken:${randomUUID()}`, resource: r, owner, holder: o.holder ?? owner, deep, since: this.now(), until: ms ? this.now() + ms : 0 };
      await this.store.set(l);
      return l;
    });
  }

  async refresh(token: string, ms?: number): Promise<Lease> {
    return this.serial(async () => {
      const l = (await this.live()).find((x) => x.token === token);
      if (!l) throw new NoLease(token);
      const next: Lease = { ...l, until: this.now() + Math.min(ms ?? this.maxMs, this.maxMs) };
      await this.store.set(next);
      return next;
    });
  }

  /** Ends a lease; only its owner may, and ending one that already ended is not an error. */
  async release(token: string, owner: string): Promise<void> {
    return this.serial(async () => {
      const l = (await this.live()).find((x) => x.token === token);
      if (!l) return;
      if (l.owner !== owner) throw new Held(l);
      await this.store.delete(token);
    });
  }

  /** The lease that covers a resource, if any. */
  async heldOn(resource: string): Promise<Lease | undefined> {
    const r = norm(resource);
    return (await this.live()).find((l) => covers(l, r));
  }

  /**
   * Whether someone may change a resource now: yes when nothing covers it, or when they hold the covering lease
   * (by its token, or as its owner when `ownerMay` is set). Throws Held with the lease that stops them.
   */
  async mayChange(resource: string, who: { owner: string; tokens?: readonly string[]; ownerMay?: boolean }, deep = false): Promise<void> {
    const r = norm(resource);
    for (const l of await this.live()) {
      if (!overlaps(l, r, deep)) continue;
      const mine = who.tokens?.includes(l.token) || (who.ownerMay && l.owner === who.owner);
      if (!mine) throw new Held(l);
    }
  }

  /** Moves leases with their resource when it is renamed, so a rename does not drop a hold. */
  async rename(from: string, to: string): Promise<void> {
    const f = norm(from);
    const t = norm(to);
    return this.serial(async () => {
      for (const l of await this.live())
        if (l.resource === f || l.resource.startsWith(`${f}/`)) await this.store.set({ ...l, resource: t + l.resource.slice(f.length) });
    });
  }
}
