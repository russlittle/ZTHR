import { createHash } from 'node:crypto';

/**
 * The operator block: the parts every persistent operator needs, with no knowledge of what the jobs do.
 *
 *  - Leases (Pattern 26): a job runs only while its holder owns an unexpired lease; heartbeats extend it, and
 *    a lease another holder owns is never taken until it lapses.
 *  - Dispatches (Pattern 25): a write is sent with an idempotency key and is "sent", not done, until a lookup
 *    confirms it. An ambiguous send is retried only with the same key, so it can never happen twice. After the
 *    attempt limit it is refused with a reason the person can read.
 *  - Holds (Pattern 24): when a job holds back, it records what the person loses by the hold.
 */

/** What the block needs from a store. The store block's DocStore fits. */
export interface KeyedStore {
  get<T>(collection: string, id: string): T | undefined;
  put<T>(collection: string, id: string, owner: string, doc: T): T;
  remove(collection: string, id: string): void;
}

export interface Lease {
  job: string;
  holder: string;
  until: string;
  beats: number;
}

export interface LeaseOptions {
  ms?: number;
  collection?: string;
  owner?: string;
}

export class Leases {
  readonly ms: number;
  private readonly collection: string;
  private readonly owner: string;
  constructor(
    private readonly store: KeyedStore,
    readonly holder: string,
    opts: LeaseOptions = {},
  ) {
    this.ms = opts.ms ?? 60_000;
    this.collection = opts.collection ?? 'leases';
    this.owner = opts.owner ?? '_operator';
  }

  /** Takes the lease, or renews our own. Undefined when another holder's lease has not lapsed. */
  take(job: string, now: Date): Lease | undefined {
    const cur = this.store.get<Lease>(this.collection, job);
    if (cur && cur.holder !== this.holder && Date.parse(cur.until) > now.getTime()) return undefined;
    const l: Lease = { job, holder: this.holder, until: new Date(now.getTime() + this.ms).toISOString(), beats: (cur?.holder === this.holder ? cur.beats : 0) + 1 };
    this.store.put(this.collection, job, this.owner, l);
    return l;
  }

  /** Extends our lease. False when we no longer hold it, which means stop. */
  beat(job: string, now: Date): boolean {
    const cur = this.store.get<Lease>(this.collection, job);
    if (!cur || cur.holder !== this.holder) return false;
    this.store.put(this.collection, job, this.owner, { ...cur, until: new Date(now.getTime() + this.ms).toISOString(), beats: cur.beats + 1 });
    return true;
  }

  /** Lets go of our lease; never another holder's. */
  release(job: string): void {
    const cur = this.store.get<Lease>(this.collection, job);
    if (cur?.holder === this.holder) this.store.remove(this.collection, job);
  }

  /** Runs fn under the lease and always releases it. */
  async run(job: string, now: Date, fn: () => Promise<unknown>): Promise<{ status: 'ran' } | { status: 'skipped'; reason: string } | { status: 'failed'; reason: string }> {
    if (!this.take(job, now)) return { status: 'skipped', reason: 'another operator holds the lease' };
    try {
      await fn();
      return { status: 'ran' };
    } catch (e) {
      return { status: 'failed', reason: (e as Error).message };
    } finally {
      this.release(job);
    }
  }
}

// ------------------------------------------------------------------ dispatches

export type DispatchStatus = 'queued' | 'sent' | 'ambiguous' | 'confirmed' | 'refused';

export interface DispatchCore<R> {
  id: string;
  key: string;
  status: DispatchStatus;
  attempts: number;
  result?: R;
}

/** The same owner asking for the same thing gets the same key, so a repeat is the same dispatch. */
export function idempotencyKey(owner: string, kind: string, request: unknown): string {
  return createHash('sha256').update(`${owner}|${kind}|${JSON.stringify(request)}`).digest('hex').slice(0, 24);
}

export const MAX_ATTEMPTS = 3;

/** Whether a dispatch should be sent now: it is waiting, and has not used up its attempts. */
export const due = (d: DispatchCore<unknown>): boolean => d.status === 'queued' || d.status === 'ambiguous';
/** Whether a dispatch needs a lookup to learn how it ended. */
export const unsettled = (d: DispatchCore<unknown>): boolean => d.status === 'sent' || d.status === 'ambiguous';
export const exhausted = (d: DispatchCore<unknown>, max = MAX_ATTEMPTS): boolean => d.attempts >= max;

export type SendOutcome<R> = { ok: true; result: R } | { ok: false; status: number; reason: string };

/**
 * The next state after a send. Success means sent (not done). A 400 or 409 is a definite no: refused, with the
 * reason the caller supplies. Anything else (a timeout, a 5xx) is ambiguous: it may or may not have happened.
 */
export function afterSend<R, D extends DispatchCore<R>>(d: D, out: SendOutcome<R>, refusal: (status: number) => R): D {
  if (out.ok) return { ...d, status: 'sent', attempts: d.attempts + 1, result: out.result };
  if (out.status === 409 || out.status === 400) return { ...d, status: 'refused', attempts: d.attempts + 1, result: refusal(out.status) };
  return { ...d, status: 'ambiguous', attempts: d.attempts + 1, result: { reason: out.reason } as unknown as R };
}

/** The state after a lookup: confirmed or refused when the other side says so, unchanged while it is pending. */
export function afterLookup<R, D extends DispatchCore<R>>(d: D, found: { outcome: 'confirmed' | 'refused' | 'pending'; result?: R }): D {
  if (found.outcome === 'pending') return d;
  return { ...d, status: found.outcome, ...(found.result !== undefined ? { result: found.result } : {}) };
}

/** A hold: a job that did not run, and what the person loses because it did not. */
export interface Hold {
  job: string;
  loss: string;
}
