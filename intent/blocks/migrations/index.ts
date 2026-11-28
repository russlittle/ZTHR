/**
 * Data migrations that are safe to run on every start. Each migration has an id that sorts in order, a description,
 * an `up` step and a `verify` that proves it worked. The ledger records each applied migration with a checksum of
 * its source; an applied migration whose source has changed since is refused, because the database and the code
 * would no longer agree about what was done. One runner holds a lease while it works, so two starting servers never
 * migrate at once. The runner renews the lease before every step and again before recording it, and hands each
 * step a `renew` it can call during long work; if a renewal fails the lease has gone to another runner, so this one
 * stops, records nothing more and reports why. A dry run lists what would run without touching anything; a failed step or verify stops the run
 * and is reported with the error, leaving it unrecorded so it runs again next time.
 */
import { createHash } from 'node:crypto';

/** What a running step is given: a way to keep the migration lock through long work. */
export interface Lease {
  /** Extends the lock for another lease period; throws if another runner now holds it, which fails the step. */
  renew(): Promise<void>;
}

export interface Migration<Db> {
  readonly id: string;
  readonly description: string;
  /** Applies the change. A step that may outlast the lease calls `lease.renew()` as it goes. */
  readonly up: (db: Db, lease: Lease) => Promise<void>;
  readonly verify?: (db: Db) => Promise<boolean | string>;
}

export interface Applied {
  readonly id: string;
  readonly checksum: string;
  readonly at: string;
  readonly ms: number;
}

export interface Ledger {
  applied(): Promise<readonly Applied[]>;
  record(a: Applied): Promise<void>;
  /** Takes the migration lock for `ms`, or returns false if another runner holds it. */
  lock(owner: string, ms: number): Promise<boolean>;
  /** Extends `owner`'s lock to `ms` from now, or returns false if `owner` no longer holds it. */
  renew(owner: string, ms: number): Promise<boolean>;
  unlock(owner: string): Promise<void>;
}

export const checksum = (m: Migration<unknown>) => createHash('sha256').update(`${m.id}\n${m.up.toString()}\n${m.verify?.toString() ?? ''}`).digest('hex').slice(0, 16);

export interface Plan {
  readonly pending: readonly string[];
  readonly problems: readonly string[];
}

export function plan<Db>(list: readonly Migration<Db>[], applied: readonly Applied[]): Plan {
  const problems: string[] = [];
  const ids = list.map((m) => m.id);
  if (new Set(ids).size !== ids.length) problems.push('two migrations share an id');
  const sorted = [...ids].sort();
  if (sorted.join() !== ids.join()) problems.push('migrations must be listed in id order');
  const done = new Map(applied.map((a) => [a.id, a]));
  for (const a of applied) {
    const m = list.find((x) => x.id === a.id);
    if (!m) problems.push(`${a.id} was applied but is no longer in the code`);
    else if (checksum(m as Migration<unknown>) !== a.checksum) problems.push(`${a.id} was changed after it was applied; add a new migration instead`);
  }
  const lastApplied = [...done.keys()].sort().at(-1);
  const pending = list.filter((m) => !done.has(m.id)).map((m) => m.id);
  for (const p of pending) if (lastApplied && p < lastApplied) problems.push(`${p} sorts before ${lastApplied}, which is already applied`);
  return { pending, problems };
}

export async function migrate<Db>(db: Db, list: readonly Migration<Db>[], ledger: Ledger, o: { owner: string; dryRun?: boolean; lockMs?: number; now?: () => number }): Promise<{ ran: string[]; pending: string[]; problems: string[]; failed?: { id: string; error: string } }> {
  const now = o.now ?? Date.now;
  const p = plan(list, await ledger.applied());
  if (p.problems.length || o.dryRun) return { ran: [], pending: [...p.pending], problems: [...p.problems] };
  const lockMs = o.lockMs ?? 600_000;
  if (!(await ledger.lock(o.owner, lockMs))) return { ran: [], pending: [...p.pending], problems: ['another runner is migrating; this one waits'] };
  const ran: string[] = [];
  try {
    // Read the ledger again under the lease: another runner may have finished between the first read and the lock.
    const q = plan(list, await ledger.applied());
    if (q.problems.length) return { ran: [], pending: [...q.pending], problems: [...q.problems] };
    const left = () => q.pending.filter((x) => !ran.includes(x));
    const lost = (id: string, when: string) => ({ ran, pending: left(), problems: [`the migration lock was lost to another runner ${when} ${id}; this one stopped`] });
    const lease: Lease = {
      async renew() {
        if (!(await ledger.renew(o.owner, lockMs))) throw new Error('the migration lock was lost to another runner');
      },
    };
    for (const id of q.pending) {
      const m = list.find((x) => x.id === id)!;
      if (!(await ledger.renew(o.owner, lockMs))) return lost(id, 'before');
      const t0 = now();
      try {
        await m.up(db, lease);
        const v = m.verify ? await m.verify(db) : true;
        if (v !== true) throw new Error(typeof v === 'string' ? v : 'verify said no');
      } catch (e) {
        return { ran, pending: left(), problems: [], failed: { id, error: e instanceof Error ? e.message : String(e) } };
      }
      // A step that outlasted the lease may now be running under another runner too: leave the record to the holder.
      if (!(await ledger.renew(o.owner, lockMs))) return lost(id, 'while running');
      await ledger.record({ id, checksum: checksum(m as Migration<unknown>), at: new Date(now()).toISOString(), ms: now() - t0 });
      ran.push(id);
    }
  } finally {
    await ledger.unlock(o.owner);
  }
  return { ran, pending: [], problems: [] };
}

export function memoryLedger(now: () => number = Date.now): Ledger & { rows: Applied[] } {
  let holder: { owner: string; until: number } | undefined;
  const l = {
    rows: [] as Applied[],
    async applied() {
      return [...l.rows];
    },
    async record(a: Applied) {
      l.rows.push(a);
    },
    async lock(owner: string, ms: number) {
      if (holder && holder.owner !== owner && holder.until > now()) return false;
      holder = { owner, until: now() + ms };
      return true;
    },
    async renew(owner: string, ms: number) {
      if (holder?.owner !== owner) return false;
      holder = { owner, until: now() + ms };
      return true;
    },
    async unlock(owner: string) {
      if (holder?.owner === owner) holder = undefined;
    },
  };
  return l;
}
