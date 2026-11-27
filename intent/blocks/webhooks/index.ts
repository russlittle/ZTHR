/**
 * Webhooks both ways. Inbound: a request is believed only when its signature (HMAC-SHA-256 over the timestamp and
 * the exact body) matches, its timestamp is recent, and its id has not been seen before, so a captured request
 * cannot be replayed. Outbound: each event is delivered to every endpoint subscribed to its type, signed the same
 * way, retried with backoff until it is acknowledged, and parked after its attempts with the last answer, where it
 * can be replayed; an endpoint that keeps failing is paused and its owner told.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export class Unverified extends Error {
  constructor(why: string) {
    super(why);
  }
}

/** The signature header: "t=<unix seconds>,v1=<hex hmac of `${t}.${body}`>". */
export function signature(secret: string, body: string, t: number): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

export class Inbound {
  private readonly seen = new Map<string, number>();
  private readonly secrets: readonly string[];
  private readonly toleranceSec: number;
  private readonly now: () => number;

  /** More than one secret while rotating: the old and the new both verify until the sender has moved over. */
  constructor(secrets: readonly string[], o: { toleranceSec?: number; now?: () => number } = {}) {
    this.secrets = secrets;
    this.toleranceSec = o.toleranceSec ?? 300;
    this.now = o.now ?? Date.now;
  }

  verify(body: string, header: string | undefined, id: string | undefined): void {
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
    if (!m) throw new Unverified('no signature, or not in the expected form');
    const t = Number(m[1]);
    const nowSec = Math.floor(this.now() / 1000);
    if (Math.abs(nowSec - t) > this.toleranceSec) throw new Unverified('the signature is too old or from the future');
    const got = Buffer.from(m[2]!, 'hex');
    const ok = this.secrets.some((s) => timingSafeEqual(Buffer.from(createHmac('sha256', s).update(`${t}.${body}`).digest('hex'), 'hex'), got));
    if (!ok) throw new Unverified('the signature does not match');
    if (!id) throw new Unverified('the request carries no delivery id');
    for (const [k, at] of this.seen) if (nowSec - at > this.toleranceSec * 2) this.seen.delete(k);
    // The delivery id is not covered by the signature, so the signature itself is remembered too: a captured
    // request sent again under a fresh id is still the same signed request.
    const sigKey = `sig:${m[2]}`;
    const idKey = `id:${id}`;
    if (this.seen.has(idKey) || this.seen.has(sigKey)) throw new Unverified('this delivery was already received');
    this.seen.set(idKey, nowSec);
    this.seen.set(sigKey, nowSec);
  }
}

export interface Endpoint {
  readonly id: string;
  readonly owner: string;
  readonly url: string;
  readonly secret: string;
  readonly types: readonly string[];
  paused?: string;
  failuresInARow: number;
}

export interface Delivery {
  readonly id: string;
  readonly endpoint: string;
  readonly type: string;
  readonly body: string;
  attempts: number;
  state: 'pending' | 'delivered' | 'parked';
  next: number;
  lastStatus?: number;
  lastError?: string;
}

export interface OutboundOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly maxAttempts?: number;
  readonly baseMs?: number;
  /** After this many delivery attempts in a row fail (retries count), the endpoint is paused. */
  readonly pauseAfter?: number;
  readonly onPaused?: (e: Endpoint) => void;
}

export class Outbound {
  readonly endpoints = new Map<string, Endpoint>();
  readonly deliveries: Delivery[] = [];
  private readonly sending = new Set<string>();
  private readonly o: Required<Omit<OutboundOptions, 'onPaused'>> & Pick<OutboundOptions, 'onPaused'>;

  constructor(o: OutboundOptions = {}) {
    this.o = { fetch: o.fetch ?? fetch, now: o.now ?? Date.now, maxAttempts: o.maxAttempts ?? 8, baseMs: o.baseMs ?? 30_000, pauseAfter: o.pauseAfter ?? 20, ...(o.onPaused ? { onPaused: o.onPaused } : {}) };
  }

  subscribe(owner: string, url: string, types: readonly string[], secret: string): Endpoint {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Unverified('webhook endpoints must use https');
    const e: Endpoint = { id: randomUUID(), owner, url, secret, types: [...types], failuresInARow: 0 };
    this.endpoints.set(e.id, e);
    return e;
  }

  /** Queues an event for every endpoint subscribed to its type (or to "*"). */
  emit(type: string, data: unknown): Delivery[] {
    const body = JSON.stringify({ id: randomUUID(), type, created: new Date(this.o.now()).toISOString(), data });
    const out: Delivery[] = [];
    for (const e of this.endpoints.values())
      if (!e.paused && (e.types.includes(type) || e.types.includes('*'))) {
        const d: Delivery = { id: randomUUID(), endpoint: e.id, type, body, attempts: 0, state: 'pending', next: this.o.now() };
        this.deliveries.push(d);
        out.push(d);
      }
    return out;
  }

  /** Sends every delivery that is due; a 2xx answer within the timeout is an acknowledgement. */
  async flush(): Promise<number> {
    const due = this.deliveries.filter((d) => d.state === 'pending' && d.next <= this.o.now() && !this.sending.has(d.id));
    // Claimed before the first await, so a flush that overlaps this one does not send the same delivery again.
    for (const d of due) this.sending.add(d.id);
    try {
      for (const d of due) {
        try {
          await this.send(d);
        } finally {
          this.sending.delete(d.id);
        }
      }
    } finally {
      for (const d of due) this.sending.delete(d.id);
    }
    return due.length;
  }

  private async send(d: Delivery): Promise<void> {
    const e = this.endpoints.get(d.endpoint);
    if (!e || e.paused) return;
    d.attempts++;
    const t = Math.floor(this.o.now() / 1000);
    try {
      const r = await this.o.fetch(e.url, { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-id': d.id, 'webhook-signature': signature(e.secret, d.body, t), 'user-agent': 'zthr-webhooks/1' }, body: d.body, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
      d.lastStatus = r.status;
      await r.body?.cancel();
      if (r.status >= 200 && r.status < 300) {
        d.state = 'delivered';
        e.failuresInARow = 0;
        return;
      }
      d.lastError = `answered ${r.status}`;
    } catch (err) {
      d.lastError = err instanceof Error ? err.message : String(err);
    }
    e.failuresInARow++;
    if (d.attempts >= this.o.maxAttempts) d.state = 'parked';
    else d.next = this.o.now() + this.o.baseMs * 2 ** (d.attempts - 1);
    if (e.failuresInARow >= this.o.pauseAfter && !e.paused) {
      e.paused = `paused after ${e.failuresInARow} failed deliveries in a row`;
      this.o.onPaused?.(e);
    }
  }

  /** Sends parked deliveries again, after the endpoint is fixed; resumes the endpoint too. */
  replay(endpoint: string): number {
    const e = this.endpoints.get(endpoint);
    if (e) {
      delete e.paused;
      e.failuresInARow = 0;
    }
    let n = 0;
    for (const d of this.deliveries)
      if (d.endpoint === endpoint && (d.state === 'parked' || d.state === 'pending')) {
        d.state = 'pending';
        d.attempts = 0;
        d.next = this.o.now();
        n++;
      }
    return n;
  }
}
