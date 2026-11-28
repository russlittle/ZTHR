/**
 * Timeouts, retries and circuit breakers. Every outward call gets a deadline, a bounded number of retries with
 * full-jitter backoff, and a breaker that fails fast while a dependency is down and lets one trial call through
 * after a cool-down. The clock, the sleeper and the randomness are arguments, so every path is testable.
 */

export class TimedOut extends Error {
  readonly ms: number;
  constructor(ms: number) {
    super(`no answer within ${ms} ms`);
    this.ms = ms;
  }
}

export class BreakerOpen extends Error {
  readonly until: number;
  constructor(until: number) {
    super('the dependency is failing; not calling it until the breaker half-opens');
    this.until = until;
  }
}

/** Resolve with the call's result, or reject with TimedOut once the deadline passes. The call is told to stop. */
export function withTimeout<T>(ms: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new TimedOut(ms));
    }, ms);
  });
  return Promise.race([call(ctl.signal), deadline]).finally(() => clearTimeout(timer));
}

export interface RetryPolicy {
  /** Attempts in all, the first included. */
  readonly attempts: number;
  readonly baseMs: number;
  readonly maxMs: number;
  /** Whether an error is worth another try. Errors that are the caller's fault never are. */
  readonly retryable: (e: unknown) => boolean;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseMs: 200, maxMs: 5000, retryable: (e) => !(e instanceof BreakerOpen) };

/** Full jitter: a random wait between zero and the capped exponential step, so retries from many callers spread out. */
export const backoff = (attempt: number, p: RetryPolicy, random: () => number): number => Math.floor(random() * Math.min(p.maxMs, p.baseMs * 2 ** attempt));

export async function retry<T>(call: (attempt: number) => Promise<T>, p: RetryPolicy = DEFAULT_RETRY, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)), random: () => number = Math.random): Promise<T> {
  if (p.attempts < 1) throw new RangeError('at least one attempt');
  let last: unknown;
  for (let a = 0; a < p.attempts; a++) {
    try {
      return await call(a);
    } catch (e) {
      last = e;
      if (!p.retryable(e) || a === p.attempts - 1) break;
      await sleep(backoff(a, p, random));
    }
  }
  throw last;
}

export type BreakerState = 'closed' | 'open' | 'half-open';

/**
 * Closed: calls go through, consecutive failures are counted. Open: calls fail at once until the cool-down ends.
 * Half-open: one trial call goes through; success closes the breaker, failure opens it again.
 */
export class Breaker {
  private failures = 0;
  private openedAt: number | null = null;
  private trial = false;

  private readonly threshold: number;
  private readonly coolDownMs: number;
  private readonly now: () => number;

  constructor(threshold: number, coolDownMs: number, now: () => number = Date.now) {
    if (threshold < 1) throw new RangeError('threshold must be at least 1');
    this.threshold = threshold;
    this.coolDownMs = coolDownMs;
    this.now = now;
  }

  get state(): BreakerState {
    if (this.openedAt === null) return 'closed';
    return this.now() - this.openedAt >= this.coolDownMs ? 'half-open' : 'open';
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    const s = this.state;
    if (s === 'open' || (s === 'half-open' && this.trial)) throw new BreakerOpen((this.openedAt ?? 0) + this.coolDownMs);
    if (s === 'half-open') this.trial = true;
    try {
      const r = await fn();
      this.failures = 0;
      this.openedAt = null;
      this.trial = false;
      return r;
    } catch (e) {
      this.trial = false;
      if (s === 'half-open') this.openedAt = this.now();
      else if (++this.failures >= this.threshold) this.openedAt = this.now();
      throw e;
    }
  }
}
