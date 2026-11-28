/**
 * The audit log: an append-only record of who did what to which record, and who read sensitive data, each entry
 * chained to the one before by a hash, so removing or changing any entry breaks every hash after it. The chain's
 * head can be published elsewhere (a separate bucket, a ticket, a signed release) so even the log's own store
 * cannot rewrite history without it showing.
 */
import { createHash } from 'node:crypto';

export interface Entry {
  readonly n: number;
  readonly at: string;
  readonly actor: string;
  /** Acting for someone else (an admin acting as a user, a break-glass session). */
  readonly onBehalfOf?: string;
  readonly action: string;
  readonly target: string;
  /** For a read of sensitive data: the sensitivity class read. */
  readonly sensitivity?: string;
  readonly reason?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly prev: string;
  readonly hash: string;
}

export interface AuditStore {
  append(e: Entry): Promise<void>;
  last(): Promise<Entry | undefined>;
  range(from: number, to?: number): Promise<Entry[]>;
}

export function memoryAudit(): AuditStore & { entries: Entry[] } {
  const entries: Entry[] = [];
  return { entries, append: async (e) => void entries.push(e), last: async () => entries.at(-1), range: async (f, t) => entries.filter((e) => e.n >= f && (t === undefined || e.n <= t)) };
}

const GENESIS = '0'.repeat(64);

/** A stable encoding (keys sorted at every level), so the same entry always hashes the same. */
export const canonical = (v: unknown): string =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? `{${Object.keys(v as object)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
        .join(',')}}`
    : Array.isArray(v)
      ? `[${v.map(canonical).join(',')}]`
      : JSON.stringify(v);

const hashOf = (e: Omit<Entry, 'hash'>) => createHash('sha256').update(canonical(e)).digest('hex');

export class Audit {
  private readonly store: AuditStore;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(store: AuditStore, o: { now?: () => Date } = {}) {
    this.store = store;
    this.now = o.now ?? (() => new Date());
  }

  /**
   * Appends one entry, after every entry before it, chained to the last. The detail is kept as the JSON it will be
   * stored as (dates become strings, undefined values go), so an entry hashes the same before and after a store,
   * and later changes to the caller's object do not reach it.
   */
  record(e: { actor: string; action: string; target: string; onBehalfOf?: string; sensitivity?: string; reason?: string; detail?: Record<string, unknown> }): Promise<Entry> {
    const run = async () => {
      const last = await this.store.last();
      const body: Omit<Entry, 'hash'> = { n: (last?.n ?? 0) + 1, at: this.now().toISOString(), actor: e.actor, ...(e.onBehalfOf ? { onBehalfOf: e.onBehalfOf } : {}), action: e.action, target: e.target, ...(e.sensitivity ? { sensitivity: e.sensitivity } : {}), ...(e.reason ? { reason: e.reason } : {}), ...(e.detail ? { detail: JSON.parse(JSON.stringify(e.detail)) as Record<string, unknown> } : {}), prev: last?.hash ?? GENESIS };
      const entry: Entry = { ...body, hash: hashOf(body) };
      await this.store.append(entry);
      return entry;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** A read of sensitive data is recorded like a change, with what class was read and why. */
  read(actor: string, target: string, sensitivity: string, reason?: string): Promise<Entry> {
    return this.record({ actor, action: 'read', target, sensitivity, ...(reason ? { reason } : {}) });
  }

  /** The chain's head, to publish somewhere the log's store cannot write. */
  async head(): Promise<{ n: number; hash: string }> {
    const l = await this.store.last();
    return { n: l?.n ?? 0, hash: l?.hash ?? GENESIS };
  }

  /**
   * Checks every entry's hash and link, and, when given, that a published head is in the chain unchanged.
   * Returns the first entry that does not hold, or null when the whole chain holds.
   */
  async verify(published?: { n: number; hash: string }): Promise<{ at: number; why: string } | null> {
    let prev = GENESIS;
    let n = 0;
    for (const e of await this.store.range(1)) {
      if (e.n !== n + 1) return { at: e.n, why: `entry ${n + 1} is missing` };
      if (e.prev !== prev) return { at: e.n, why: 'it does not follow the entry before it' };
      const { hash, ...body } = e;
      if (hashOf(body) !== hash) return { at: e.n, why: 'its content was changed after it was written' };
      if (published && published.n === e.n && published.hash !== e.hash) return { at: e.n, why: 'it differs from the published head' };
      prev = e.hash;
      n = e.n;
    }
    if (published && published.n > n) return { at: n + 1, why: `the published head is entry ${published.n}, but the log ends at ${n}` };
    return null;
  }

  /** Everything recorded about one record or by one person, oldest first. */
  async about(o: { target?: string; actor?: string }): Promise<Entry[]> {
    return (await this.store.range(1)).filter((e) => (!o.target || e.target === o.target) && (!o.actor || e.actor === o.actor || e.onBehalfOf === o.actor));
  }
}
