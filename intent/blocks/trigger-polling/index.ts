/**
 * Triggers that start flows: polling triggers that ask an outside system "anything new?" on a timer, and webhook
 * triggers that are told. Polling keeps a cursor and a bounded, expiring set of keys already emitted, so an item is
 * emitted once even when the source returns it again or the cursor is lost. The first poll after activation only
 * records what is already there (the baseline) unless told to emit it, so turning a trigger on does not fire for
 * every old record. A failing poll backs off (doubling, capped at 16 intervals); after enough failures in a row the
 * trigger is deactivated with the reason, and stays off until someone reactivates it. Webhook triggers verify the
 * signature, the age and the delivery id with the webhooks block before anything is queued. Each trigger has a test
 * mode that fetches or captures a payload without touching the cursor, the dedupe set or the queue, and falls back
 * to the trigger's declared sample when the source has nothing. Emitted items become keyed jobs on the jobs
 * queue, so a restart or a second poller cannot run the same item twice; polls themselves are jobs too.
 *
 * Out of scope: persisting state (it is held through a small store interface with an in-memory version) and
 * calling real services (the poll function is yours).
 */
import { Inbound, Unverified } from '../webhooks/index.ts';
import type { Queue } from '../jobs/index.ts';

export { Unverified };

export class UnknownTrigger extends Error {}
export class Inactive extends Error {}

export interface PollTrigger<T = unknown> {
  readonly id: string;
  /** The job kind created for each emitted item. */
  readonly flow: string;
  readonly intervalMs: number;
  /** The identity of an item, stable across polls. */
  readonly key: (item: T) => string;
  /** Items newer than the cursor (or everything recent when there is none), and the next cursor. */
  readonly fetch: (cursor: string | undefined, signal: AbortSignal) => Promise<{ items: readonly T[]; cursor?: string }>;
  readonly sample: readonly T[];
  /** Emit what is already there on the first poll (default false: record it as the baseline). */
  readonly emitOnFirstPoll?: boolean;
  /** Consecutive failures before deactivation (default 5). */
  readonly maxFailures?: number;
  /** Most keys remembered (default 1000) and how long (default 7 days). */
  readonly dedupeMax?: number;
  readonly dedupeTtlMs?: number;
  /** Longest a single poll may take before it is abandoned and counted as a failure (default 30 s). */
  readonly timeoutMs?: number;
}

export interface TriggerState {
  readonly id: string;
  active: boolean;
  primed: boolean;
  cursor?: string;
  /** Emitted keys and when, oldest first. */
  seen: [string, number][];
  lastPollAt?: number;
  nextPollAt: number;
  failures: number;
  lastError?: string;
  deactivatedReason?: string;
  emittedTotal: number;
  polling: boolean;
}

export interface StateStore {
  get(id: string): TriggerState | undefined;
  set(s: TriggerState): void;
}

export function memoryState(): StateStore {
  const m = new Map<string, TriggerState>();
  return { get: (id) => { const s = m.get(id); return s ? structuredClone(s) : undefined; }, set: (s) => void m.set(s.id, structuredClone(s)) };
}

export interface PollOutcome<T> {
  readonly emitted: readonly T[];
  readonly duplicates: number;
  readonly baseline: boolean;
  readonly error?: string;
  readonly deactivated?: boolean;
}

export interface WebhookTrigger {
  readonly id: string;
  readonly flow: string;
  readonly secrets: readonly string[];
  readonly sample: unknown;
  readonly maxBytes?: number;
  readonly maxFailures?: number;
}

export interface HostOptions {
  readonly queue: Queue;
  readonly now?: () => number;
  readonly store?: StateStore;
}

const MAX_BACKOFF = 16;

export class TriggerHost {
  readonly #queue: Queue;
  readonly #now: () => number;
  readonly #store: StateStore;
  readonly #polls = new Map<string, PollTrigger<any>>();
  readonly #hooks = new Map<string, { def: WebhookTrigger; inbound: Inbound }>();
  readonly #armed = new Map<string, { until: number; captured?: unknown }>();

  constructor(o: HostOptions) {
    this.#queue = o.queue;
    this.#now = o.now ?? Date.now;
    this.#store = o.store ?? memoryState();
  }

  #fresh(id: string): TriggerState {
    return { id, active: true, primed: false, seen: [], nextPollAt: this.#now(), failures: 0, emittedTotal: 0, polling: false };
  }

  addPoll<T>(t: PollTrigger<T>): void {
    if (this.#polls.has(t.id) || this.#hooks.has(t.id)) throw new Error(`trigger ${t.id} is already registered`);
    if (!(t.intervalMs >= 1000)) throw new Error(`trigger ${t.id}: the interval must be at least one second`);
    this.#polls.set(t.id, t);
    if (!this.#store.get(t.id)) this.#store.set(this.#fresh(t.id));
    this.#queue.handle(`poll:${t.id}`, async () => {
      const r = await this.poll(t.id);
      const s = this.state(t.id);
      if (s.active) this.schedule(t.id);
      return { emitted: r.emitted.length, error: r.error };
    });
  }

  addWebhook(t: WebhookTrigger): void {
    if (this.#polls.has(t.id) || this.#hooks.has(t.id)) throw new Error(`trigger ${t.id} is already registered`);
    this.#hooks.set(t.id, { def: t, inbound: new Inbound(t.secrets, { now: this.#now }) });
    if (!this.#store.get(t.id)) this.#store.set(this.#fresh(t.id));
  }

  state(id: string): TriggerState {
    const s = this.#store.get(id);
    if (!s) throw new UnknownTrigger(`no trigger ${id}`);
    return s;
  }

  /** Put the next poll on the queue, at the time the trigger's state says. One poll per scheduled time. */
  schedule(id: string): void {
    const s = this.state(id);
    this.#queue.enqueue(`poll:${id}`, { id }, { key: `poll:${id}@${s.nextPollAt}`, runAt: s.nextPollAt, maxAttempts: 1 });
  }

  /** Turn a trigger on (clearing any failure state). The next poll re-records the baseline unless keepBaseline. */
  activate(id: string, o: { keepBaseline?: boolean } = {}): void {
    const s = this.state(id);
    s.active = true;
    s.failures = 0;
    delete s.lastError;
    delete s.deactivatedReason;
    s.nextPollAt = this.#now();
    if (!o.keepBaseline) { s.primed = false; delete s.cursor; }
    this.#store.set(s);
  }

  deactivate(id: string, reason: string): void {
    const s = this.state(id);
    s.active = false;
    s.deactivatedReason = reason;
    this.#store.set(s);
  }

  /** Poll once, if it is time. Items not seen before are queued as keyed jobs. */
  async poll<T>(id: string, o: { force?: boolean } = {}): Promise<PollOutcome<T>> {
    const t = this.#polls.get(id) as PollTrigger<T> | undefined;
    if (!t) throw new UnknownTrigger(`no polling trigger ${id}`);
    const s = this.state(id);
    if (!s.active) throw new Inactive(`trigger ${id} is off: ${s.deactivatedReason ?? 'deactivated'}`);
    const now = this.#now();
    if (s.polling) return { emitted: [], duplicates: 0, baseline: false, error: 'a poll is already running' };
    if (!o.force && now < s.nextPollAt) return { emitted: [], duplicates: 0, baseline: false };
    s.polling = true;
    this.#store.set(s);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), t.timeoutMs ?? 30_000);
    let got: { items: readonly T[]; cursor?: string };
    try {
      got = await Promise.race([
        t.fetch(s.cursor, ac.signal),
        new Promise<never>((_, rej) => ac.signal.addEventListener('abort', () => rej(new Error('the poll timed out')), { once: true })),
      ]);
    } catch (e) {
      clearTimeout(timer);
      const f = this.state(id);
      f.polling = false;
      f.failures++;
      f.lastError = e instanceof Error ? e.message : String(e);
      f.lastPollAt = now;
      f.nextPollAt = now + t.intervalMs * Math.min(MAX_BACKOFF, 2 ** f.failures);
      let deactivated = false;
      if (f.failures >= (t.maxFailures ?? 5)) {
        f.active = false;
        f.deactivatedReason = `${f.failures} polls failed in a row; last error: ${f.lastError}`;
        deactivated = true;
      }
      this.#store.set(f);
      return { emitted: [], duplicates: 0, baseline: false, error: f.lastError, deactivated };
    }
    clearTimeout(timer);
    const st = this.state(id);
    const seen = new Map(st.seen);
    const ttl = t.dedupeTtlMs ?? 7 * 86_400_000;
    for (const [k, at] of seen) if (now - at > ttl) seen.delete(k);
    const baseline = !st.primed && !t.emitOnFirstPoll;
    const emitted: T[] = [];
    let duplicates = 0;
    for (const item of got.items) {
      const key = t.key(item);
      if (seen.has(key)) { duplicates++; continue; }
      seen.set(key, now);
      if (baseline) continue;
      this.#queue.enqueue(t.flow, item, { key: `${id}:${key}` });
      emitted.push(item);
    }
    const max = t.dedupeMax ?? 1000;
    const kept = [...seen].slice(-max);
    st.seen = kept;
    st.polling = false;
    st.primed = true;
    st.failures = 0;
    delete st.lastError;
    st.lastPollAt = now;
    st.nextPollAt = now + t.intervalMs;
    if (got.cursor !== undefined) st.cursor = got.cursor;
    st.emittedTotal += emitted.length;
    this.#store.set(st);
    return { emitted, duplicates, baseline };
  }

  /**
   * Test mode for a polling trigger: fetch with the current cursor but change nothing and queue nothing. If the
   * source returns nothing or fails, the declared sample is returned and marked as such.
   */
  async testPoll<T>(id: string, limit = 3): Promise<{ items: readonly T[]; source: 'live' | 'sample'; note?: string }> {
    const t = this.#polls.get(id) as PollTrigger<T> | undefined;
    if (!t) throw new UnknownTrigger(`no polling trigger ${id}`);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), t.timeoutMs ?? 30_000);
    try {
      const r = await Promise.race([t.fetch(undefined, ac.signal), new Promise<never>((_, rej) => ac.signal.addEventListener('abort', () => rej(new Error('the poll timed out')), { once: true }))]);
      if (r.items.length) return { items: r.items.slice(0, limit), source: 'live' };
      return { items: t.sample.slice(0, limit), source: 'sample', note: 'the source returned nothing' };
    } catch (e) {
      return { items: t.sample.slice(0, limit), source: 'sample', note: `the source failed: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Start listening for one test delivery to a webhook trigger. */
  listenForTest(id: string, ttlMs = 120_000): void {
    if (!this.#hooks.has(id)) throw new UnknownTrigger(`no webhook trigger ${id}`);
    this.#armed.set(id, { until: this.#now() + ttlMs });
  }

  /** The payload captured by test mode, once one has arrived. */
  testResult(id: string): { waiting: boolean; payload?: unknown; sample: unknown } {
    const h = this.#hooks.get(id);
    if (!h) throw new UnknownTrigger(`no webhook trigger ${id}`);
    const a = this.#armed.get(id);
    if (a?.captured !== undefined) return { waiting: false, payload: a.captured, sample: h.def.sample };
    return { waiting: !!a && a.until > this.#now(), sample: h.def.sample };
  }

  /**
   * A webhook arrives. While a test is armed the first verified delivery is captured and nothing is queued; at
   * other times an active trigger queues one job per delivery. Unsigned, stale, repeated, oversized or non-JSON
   * deliveries are refused before anything happens.
   */
  async receive(id: string, body: string, header: string | undefined, deliveryId: string | undefined): Promise<{ mode: 'test' | 'production'; jobId?: string }> {
    const h = this.#hooks.get(id);
    if (!h) throw new UnknownTrigger(`no webhook trigger ${id}`);
    if (Buffer.byteLength(body) > (h.def.maxBytes ?? 1_000_000)) throw new Unverified('the body is larger than this trigger accepts');
    const armed = this.#armed.get(id);
    const testing = !!armed && armed.until > this.#now() && armed.captured === undefined;
    const s = this.state(id);
    if (!testing && !s.active) throw new Inactive(`trigger ${id} is off: ${s.deactivatedReason ?? 'deactivated'}`);
    return h.inbound.receive(body, header, deliveryId, () => {
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { throw new Unverified('the body is not JSON'); }
      if (testing) {
        armed.captured = payload;
        return { mode: 'test' as const };
      }
      const job = this.#queue.enqueue(h.def.flow, payload, { key: `${id}:${deliveryId}` });
      const st = this.state(id);
      st.emittedTotal++;
      this.#store.set(st);
      return { mode: 'production' as const, jobId: job.id };
    });
  }

  /** The flow reports how a run it started went; enough consecutive failures turn the trigger off. */
  recordRun(id: string, ok: boolean, error?: string): void {
    const s = this.state(id);
    const limit = this.#polls.get(id)?.maxFailures ?? this.#hooks.get(id)?.def.maxFailures ?? 5;
    if (ok) { s.failures = 0; delete s.lastError; } else {
      s.failures++;
      s.lastError = error ?? 'the flow failed';
      if (s.failures >= limit) { s.active = false; s.deactivatedReason = `${s.failures} runs failed in a row; last error: ${s.lastError}`; }
    }
    this.#store.set(s);
  }

  /** One line per trigger for a status page. */
  overview(): { id: string; kind: 'poll' | 'webhook'; active: boolean; failures: number; nextPollAt?: number; emittedTotal: number; note?: string }[] {
    return [...this.#polls.keys(), ...this.#hooks.keys()].sort().map((id) => {
      const s = this.state(id);
      const poll = this.#polls.has(id);
      return { id, kind: poll ? 'poll' as const : 'webhook' as const, active: s.active, failures: s.failures, ...(poll && s.active ? { nextPollAt: s.nextPollAt } : {}), emittedTotal: s.emittedTotal, ...(s.deactivatedReason ? { note: s.deactivatedReason } : {}) };
    });
  }
}
