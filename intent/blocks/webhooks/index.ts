/**
 * Webhooks both ways. Inbound: a request is believed only when its signature (HMAC-SHA-256 over the timestamp and
 * the exact body) matches, its timestamp is recent, and its id has not been seen before, so a captured request
 * cannot be replayed; an id is spent only once the handler has taken the event, so a sender's retry after a failed
 * handler is still received. Outbound: endpoints must be public https addresses (never loopback, private,
 * link-local or cloud metadata, checked when subscribing and again against the resolved address before each send);
 * each event is delivered to every endpoint subscribed to its type, signed the same way, retried with backoff until
 * it is acknowledged, and parked after its attempts with the last answer, where it can be replayed; an endpoint
 * that keeps failing is paused and its owner told, and events for it while paused are parked for the replay.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export class Unverified extends Error {
  constructor(why: string) {
    super(why);
  }
}

/** The signature header: "t=<unix seconds>,v1=<hex hmac of `${t}.${body}`>". */
export function signature(secret: string, body: string, t: number): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/** A verified request whose id is held while the handler runs: accept spends the id, release frees it for a retry. */
export interface Receipt {
  accept(): void;
  release(): void;
}

export class Inbound {
  private readonly seen = new Map<string, number>();
  /** Ids and signatures verified and being handled, not yet spent. */
  private readonly held = new Map<string, number>();
  private readonly secrets: readonly string[];
  private readonly toleranceSec: number;
  private readonly now: () => number;

  /** More than one secret while rotating: the old and the new both verify until the sender has moved over. */
  constructor(secrets: readonly string[], o: { toleranceSec?: number; now?: () => number } = {}) {
    this.secrets = secrets;
    this.toleranceSec = o.toleranceSec ?? 300;
    this.now = o.now ?? Date.now;
  }

  /**
   * Verifies and spends the id at once: for a handler that has already run, or one that cannot fail. Otherwise use
   * `receive` (or `begin`), so a handler that fails does not burn the id the sender will retry with.
   */
  verify(body: string, header: string | undefined, id: string | undefined): void {
    this.begin(body, header, id).accept();
  }

  /**
   * Verifies, runs the handler, and spends the id only when the handler succeeds. When it throws, the id is freed
   * and the error rethrown, so the caller answers with an error and the sender's retry is received.
   */
  async receive<T>(body: string, header: string | undefined, id: string | undefined, handler: () => Promise<T> | T): Promise<T> {
    const r = this.begin(body, header, id);
    try {
      const out = await handler();
      r.accept();
      return out;
    } catch (e) {
      r.release();
      throw e;
    }
  }

  /**
   * Verifies and holds the id (and signature) while the caller handles the event: a duplicate arriving meanwhile is
   * refused, `accept()` spends the id for good, `release()` frees it so the sender's retry is received. A hold never
   * accepted or released lapses with the replay window.
   */
  begin(body: string, header: string | undefined, id: string | undefined): Receipt {
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
    if (!m) throw new Unverified('no signature, or not in the expected form');
    const t = Number(m[1]);
    const nowSec = Math.floor(this.now() / 1000);
    if (Math.abs(nowSec - t) > this.toleranceSec) throw new Unverified('the signature is too old or from the future');
    const got = Buffer.from(m[2]!, 'hex');
    const ok = this.secrets.some((s) => timingSafeEqual(Buffer.from(createHmac('sha256', s).update(`${t}.${body}`).digest('hex'), 'hex'), got));
    if (!ok) throw new Unverified('the signature does not match');
    if (!id) throw new Unverified('the request carries no delivery id');
    for (const m of [this.seen, this.held]) for (const [k, at] of m) if (nowSec - at > this.toleranceSec * 2) m.delete(k);
    // The delivery id is not covered by the signature, so the signature itself is remembered too: a captured
    // request sent again under a fresh id is still the same signed request.
    const sigKey = `sig:${m[2]}`;
    const idKey = `id:${id}`;
    if (this.seen.has(idKey) || this.seen.has(sigKey)) throw new Unverified('this delivery was already received');
    if (this.held.has(idKey) || this.held.has(sigKey)) throw new Unverified('this delivery is being received; try again shortly');
    this.held.set(idKey, nowSec);
    this.held.set(sigKey, nowSec);
    let open = true;
    const done = (spend: boolean) => {
      if (!open) return;
      open = false;
      this.held.delete(idKey);
      this.held.delete(sigKey);
      if (spend) {
        this.seen.set(idKey, nowSec);
        this.seen.set(sigKey, nowSec);
      }
    };
    return { accept: () => done(true), release: () => done(false) };
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

/** Addresses a webhook may never be sent to: loopback, private, link-local, carrier-grade NAT, multicast, reserved. */
const INTERNAL = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) INTERNAL.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]] as const) INTERNAL.addSubnet(net, bits, 'ipv6');

/** Host names that always mean the machine itself or the cloud's metadata service. */
const INTERNAL_NAMES = /^(?:localhost|.+\.localhost|metadata|metadata\.google\.internal|metadata\.goog|instance-data|instance-data\.ec2\.internal)$/i;

/** Whether an address (IPv4, IPv6, or IPv4 written inside IPv6) is one a webhook must not reach. */
export function internalAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  const v = isIP(bare);
  if (v === 4) return INTERNAL.check(bare, 'ipv4');
  if (v === 6) return INTERNAL.check(bare, 'ipv6');
  return false;
}

/** A host name as compared: lower case, without IPv6 brackets or a trailing dot. */
const hostOf = (u: URL) => u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

export interface OutboundOptions {
  readonly fetch?: typeof fetch;
  /**
   * Looks up the addresses a host name resolves to, checked before each send so a name that later points inside
   * (DNS rebinding) is refused. Defaults to the system resolver when the built-in fetch is used. A caller that
   * supplies its own fetch owns its connections: pass a resolver too, ideally the one its fetch connects with,
   * to keep the check. The check and the connection resolve separately, so a fetch that pins the checked address
   * closes the last gap.
   */
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  /** Host names or IP literals allowed even though they are internal (a test receiver, a sidecar). */
  readonly allowHosts?: readonly string[];
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
  private readonly o: Required<Omit<OutboundOptions, 'onPaused' | 'resolve' | 'allowHosts'>> & Pick<OutboundOptions, 'onPaused' | 'resolve'>;
  private readonly allow: ReadonlySet<string>;

  constructor(o: OutboundOptions = {}) {
    const resolve = o.resolve ?? (o.fetch ? undefined : async (host: string) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address));
    this.o = { fetch: o.fetch ?? fetch, now: o.now ?? Date.now, maxAttempts: o.maxAttempts ?? 8, baseMs: o.baseMs ?? 30_000, pauseAfter: o.pauseAfter ?? 20, ...(o.onPaused ? { onPaused: o.onPaused } : {}), ...(resolve ? { resolve } : {}) };
    this.allow = new Set((o.allowHosts ?? []).map((h) => h.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')));
  }

  /** Why a URL's host may not receive webhooks, or null when it may. Names are checked again, resolved, at send. */
  private refuseHost(u: URL): string | null {
    const host = hostOf(u);
    if (this.allow.has(host)) return null;
    if (INTERNAL_NAMES.test(host)) return `${host} is an internal address`;
    if (isIP(host) && internalAddress(host)) return `${host} is an internal address`;
    return null;
  }

  /** Subscribes a public https endpoint; loopback, private, link-local and metadata addresses are refused. */
  subscribe(owner: string, url: string, types: readonly string[], secret: string): Endpoint {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Unverified('webhook endpoints must use https');
    const why = this.refuseHost(u);
    if (why) throw new Unverified(`webhook endpoints must be public: ${why}`);
    const e: Endpoint = { id: randomUUID(), owner, url, secret, types: [...types], failuresInARow: 0 };
    this.endpoints.set(e.id, e);
    return e;
  }

  /**
   * Queues an event for every endpoint subscribed to its type (or to "*") and returns those queued to send. For an
   * endpoint that is paused, the delivery is parked instead (in `deliveries`, not returned), so replaying the
   * endpoint once it is fixed sends it.
   */
  emit(type: string, data: unknown): Delivery[] {
    const body = JSON.stringify({ id: randomUUID(), type, created: new Date(this.o.now()).toISOString(), data });
    const out: Delivery[] = [];
    for (const e of this.endpoints.values())
      if (e.types.includes(type) || e.types.includes('*')) {
        const d: Delivery = { id: randomUUID(), endpoint: e.id, type, body, attempts: 0, state: e.paused ? 'parked' : 'pending', next: this.o.now(), ...(e.paused ? { lastError: e.paused } : {}) };
        this.deliveries.push(d);
        if (!e.paused) out.push(d);
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
      await this.checkResolved(e.url);
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

  /** Refuses a send whose host now resolves to an internal address, unless the host is allowed. */
  private async checkResolved(url: string): Promise<void> {
    const u = new URL(url);
    const host = hostOf(u);
    const why = this.refuseHost(u);
    if (why) throw new Error(`refused: ${why}`);
    if (this.allow.has(host) || isIP(host) || !this.o.resolve) return;
    const addrs = await this.o.resolve(host);
    if (!addrs.length) throw new Error(`refused: ${host} did not resolve`);
    const bad = addrs.find(internalAddress);
    if (bad) throw new Error(`refused: ${host} resolves to the internal address ${bad}`);
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
