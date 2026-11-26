/**
 * Rate limits by key: a token bucket per key (an address, an account, a link), refilled continuously, with a
 * separate failure counter for things that should slow down only on mistakes (wrong passwords). A refusal says
 * how long to wait, so a client can back off instead of hammering. Buckets idle long enough to be full are
 * dropped, so memory stays bounded by the keys active now.
 */

export class Limited extends Error {
  readonly retryAfterMs: number;
  constructor(ms: number, what: string) {
    super(`${what}: wait ${Math.ceil(ms / 1000)} s`);
    this.retryAfterMs = ms;
  }
}

export interface Bucket {
  /** Requests allowed at once. */
  readonly burst: number;
  /** Requests added back per second. */
  readonly perSecond: number;
}

export class Limiter {
  private readonly b: Bucket;
  private readonly now: () => number;
  private readonly what: string;
  private readonly state = new Map<string, { tokens: number; at: number }>();

  constructor(b: Bucket, o: { now?: () => number; what?: string } = {}) {
    if (b.burst < 1 || b.perSecond <= 0) throw new RangeError('a bucket needs a burst of at least 1 and a positive rate');
    this.b = b;
    this.now = o.now ?? Date.now;
    this.what = o.what ?? 'too many requests';
  }

  private level(key: string): { tokens: number; at: number } {
    const t = this.now();
    const s = this.state.get(key);
    if (!s) return { tokens: this.b.burst, at: t };
    return { tokens: Math.min(this.b.burst, s.tokens + ((t - s.at) / 1000) * this.b.perSecond), at: t };
  }

  /** Takes `cost` tokens for a key, or refuses with how long until there are enough. */
  take(key: string, cost = 1): void {
    const s = this.level(key);
    if (s.tokens < cost) throw new Limited(((cost - s.tokens) / this.b.perSecond) * 1000, this.what);
    this.state.set(key, { tokens: s.tokens - cost, at: s.at });
    if (this.state.size > 50_000) this.prune();
  }

  /** Tokens a key has now, for headers and tests. */
  left(key: string): number {
    return Math.floor(this.level(key).tokens);
  }

  /** Drops keys whose buckets have refilled: they behave exactly as keys never seen. */
  prune(): void {
    for (const k of [...this.state.keys()]) if (this.level(k).tokens >= this.b.burst) this.state.delete(k);
  }
}

/**
 * Failures by key within a window: allowed until `limit` failures, then refused until the oldest falls out of
 * the window. A success clears the key. For sign-ins and passwords, where only mistakes should slow anyone down.
 */
export class Failures {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly what: string;
  private readonly seen = new Map<string, number[]>();

  constructor(limit: number, windowMs: number, o: { now?: () => number; what?: string } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = o.now ?? Date.now;
    this.what = o.what ?? 'too many failed attempts';
  }

  private recent(key: string): number[] {
    const t = this.now();
    return (this.seen.get(key) ?? []).filter((x) => t - x < this.windowMs);
  }

  /** Refuses when a key has failed too often lately. */
  check(key: string): void {
    const r = this.recent(key);
    if (r.length >= this.limit) throw new Limited(this.windowMs - (this.now() - r[0]!), this.what);
  }

  fail(key: string): void {
    const r = this.recent(key);
    r.push(this.now());
    this.seen.set(key, r);
    if (this.seen.size > 50_000) for (const k of [...this.seen.keys()]) if (!this.recent(k).length) this.seen.delete(k);
  }

  succeed(key: string): void {
    this.seen.delete(key);
  }
}
