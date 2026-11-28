/**
 * Rate plans: what each plan of a service may do per second, per minute, per day and per month, and what happens
 * at the edge. One call, `admit`, answers a request with an allow or a refusal that says which rule refused, how
 * long to wait, and the rate-limit headers to send.
 *
 * What a plan holds (`RatePlan`):
 *  - a sustained rate with a burst (a token bucket per account, from the ratelimit block), in cost units, so an
 *    export can cost 20 while a read costs 1; routes can carry their own cost and their own bucket, or be exempt;
 *  - fixed metering windows (a minute, an hour, a day) aligned to the clock, each with a limit;
 *  - a cap on requests in flight, held as leases that expire on their own so a crashed handler cannot leak one;
 *  - a period quota (a monthly allowance) delegated to the entitlements block, which already knows overage that
 *    blocks, is free, or is charged, and counts a retried request once by its id;
 *  - fair use: once the quota is spent and the plan lets overage through, requests run at a slower `throttle` rate
 *    instead of at full speed; a `penalty` puts an account that keeps hitting limits in a cooldown; and a shared
 *    `pool` refuses the heaviest accounts first when the whole service is near its capacity.
 *
 * Every check that only reads runs first; the token bucket (the one check that spends) runs last among them, and
 * only when all pass is anything recorded. So a request refused by a window does not eat burst, and a request
 * refused by burst does not count against a window or the quota.
 *
 * Headers follow the IETF RateLimit header fields draft: `RateLimit-Limit`, `RateLimit-Remaining`,
 * `RateLimit-Reset` (seconds), and `Retry-After` (whole seconds, rounded up) on refusal; they describe the rule that
 * is tightest right now. The clock is an argument. Out of scope: sharing counters between processes (counters live
 * in memory behind these methods; a shared store replaces them), and billing (the entitlements block prices overage).
 */
import { Limited, Limiter } from '../ratelimit/index.ts';
import { periodOf, type Account, type Entitlements } from '../entitlements/index.ts';

export class RatePlanError extends Error {
  readonly problems: readonly string[];
  constructor(why: string | readonly string[]) {
    const list = typeof why === 'string' ? [why] : why;
    super(list.join('; '));
    this.name = 'RatePlanError';
    this.problems = list;
  }
}

export interface RateSpec {
  readonly perSecond: number;
  readonly burst: number;
}

export interface WindowSpec {
  readonly name: string;
  readonly seconds: number;
  readonly limit: number;
}

export interface RouteSpec {
  /** Cost units of one request. Default 1. */
  readonly cost?: number;
  /** A bucket of its own on top of the plan's. */
  readonly rate?: RateSpec;
  /** Not counted or limited at all (health checks). */
  readonly exempt?: boolean;
  /** Whether it draws on the period quota. Default true. */
  readonly quota?: boolean;
}

export interface RatePlan {
  /** Matches `Account.plan`. */
  readonly name: string;
  readonly rate: RateSpec;
  readonly windows?: readonly WindowSpec[];
  readonly concurrency?: number;
  /** The entitlements limit that holds the period quota. */
  readonly quota?: string;
  readonly routes?: Readonly<Record<string, RouteSpec>>;
  /** Once the quota is spent and overage is allowed, requests run at this slower rate. */
  readonly throttle?: RateSpec;
  readonly penalty?: { readonly strikes: number; readonly withinMs: number; readonly cooldownMs: number };
}

export interface PoolSpec {
  /** Cost units per second the whole service can serve. */
  readonly capacityPerSecond: number;
  /** Length in seconds of the window consumption is measured over. Default 10. */
  readonly windowSeconds?: number;
  /** Fair-use rules apply once the pool is this full (0 to 1). Default 0.8. */
  readonly highWatermark?: number;
  /** An account is over its share when it used more than this many times an equal share. Default 2. */
  readonly shareFactor?: number;
}

export type Rule = 'ok' | 'burst' | 'route-burst' | 'window' | 'quota' | 'concurrency' | 'throttle' | 'fair-use' | 'penalty' | 'unknown-plan';

export interface Admission {
  readonly allowed: boolean;
  readonly status: 200 | 429 | 503;
  readonly rule: Rule;
  readonly reason: string;
  readonly retryAfterMs: number;
  readonly headers: Record<string, string>;
  /** Pass to `release` when the request ends, when the plan caps concurrency. */
  readonly lease: string | undefined;
  /** The request went past the quota, which the plan allows. */
  readonly overage: boolean;
  /** Minor units this request adds to the invoice. */
  readonly charge: number;
  /** The quota is nearly used. */
  readonly warn: boolean;
  /** The request ran under the fair-use throttle. */
  readonly throttled: boolean;
}

export interface Request {
  readonly route: string;
  /** A unique id per request; a retry with the same id counts once against the quota. */
  readonly id: string;
  /** Cost units; defaults to the route's cost. */
  readonly cost?: number;
}

export interface Options {
  readonly plans: readonly RatePlan[];
  readonly now: () => number;
  /** Entitlements holding the period quotas; required when a plan names a `quota`. */
  readonly entitlements?: Entitlements;
  readonly pool?: PoolSpec;
  /** How long an unreleased concurrency lease lives. Default 60 seconds. */
  readonly leaseMs?: number;
}

const okRate = (r: RateSpec | undefined, what: string, out: string[]) => {
  if (!r) return;
  if (!(r.perSecond > 0) || !(r.burst >= 1) || !Number.isFinite(r.perSecond) || !Number.isFinite(r.burst)) out.push(`${what}: a rate needs perSecond above 0 and a burst of at least 1`);
};

/** Everything wrong with a set of plans, in one list. */
export function checkPlans(plans: readonly RatePlan[], hasEntitlements: boolean): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of plans) {
    if (seen.has(p.name)) out.push(`plan ${p.name} is defined twice`);
    seen.add(p.name);
    okRate(p.rate, `${p.name}`, out);
    okRate(p.throttle, `${p.name} throttle`, out);
    if (p.throttle && p.throttle.perSecond > p.rate.perSecond) out.push(`plan ${p.name}: the throttle must be slower than the normal rate`);
    const wn = new Set<string>();
    for (const w of p.windows ?? []) {
      if (!(w.seconds >= 1) || !Number.isInteger(w.seconds)) out.push(`plan ${p.name}: window ${w.name} must last a whole number of seconds`);
      if (!(w.limit >= 1) || !Number.isInteger(w.limit)) out.push(`plan ${p.name}: window ${w.name} needs a whole limit of at least 1`);
      if (wn.has(w.name)) out.push(`plan ${p.name}: window ${w.name} is defined twice`);
      wn.add(w.name);
    }
    if (p.concurrency !== undefined && (!Number.isInteger(p.concurrency) || p.concurrency < 1)) out.push(`plan ${p.name}: concurrency is a whole number from 1`);
    if (p.quota && !hasEntitlements) out.push(`plan ${p.name} names a quota but no entitlements were given`);
    if (p.throttle && !p.quota) out.push(`plan ${p.name}: a throttle only applies after a quota`);
    for (const [r, s] of Object.entries(p.routes ?? {})) {
      if (s.cost !== undefined && (!Number.isInteger(s.cost) || s.cost < 0)) out.push(`plan ${p.name}: route ${r} cost is a whole number from 0`);
      okRate(s.rate, `${p.name} route ${r}`, out);
      if (s.rate && s.cost !== undefined && s.cost > s.rate.burst) out.push(`plan ${p.name}: route ${r} costs more than its own burst, so it could never run`);
    }
    for (const [r, s] of Object.entries(p.routes ?? {})) if ((s.cost ?? 1) > p.rate.burst && !s.exempt) out.push(`plan ${p.name}: route ${r} costs more than the plan's burst, so it could never run`);
    if (p.penalty && !(p.penalty.strikes >= 1 && p.penalty.withinMs > 0 && p.penalty.cooldownMs > 0)) out.push(`plan ${p.name}: a penalty needs strikes, a window and a cooldown`);
  }
  return out;
}

interface WindowState {
  start: number;
  used: number;
}

export class RatePlans {
  readonly #plans = new Map<string, RatePlan>();
  readonly #o: Options;
  readonly #buckets = new Map<string, Limiter>();
  readonly #windows = new Map<string, WindowState>();
  readonly #leases = new Map<string, Map<string, number>>();
  readonly #strikes = new Map<string, number[]>();
  readonly #cooldown = new Map<string, number>();
  readonly #pool = new Map<string, { start: number; used: number; prevUsed: number }>();
  #seq = 0;

  constructor(o: Options) {
    const problems = checkPlans(o.plans, o.entitlements !== undefined);
    if (o.pool && !(o.pool.capacityPerSecond > 0)) problems.push('the pool needs a capacity above 0');
    if (problems.length) throw new RatePlanError(problems);
    for (const p of o.plans) this.#plans.set(p.name, p);
    this.#o = o;
  }

  #limiter(key: string, r: RateSpec): Limiter {
    let l = this.#buckets.get(key);
    if (!l) this.#buckets.set(key, (l = new Limiter({ burst: r.burst, perSecond: r.perSecond }, { now: this.#o.now })));
    return l;
  }

  #window(accountId: string, w: WindowSpec, now: number): WindowState {
    const len = w.seconds * 1000;
    const start = Math.floor(now / len) * len;
    const k = `${accountId}\0${w.name}`;
    const s = this.#windows.get(k);
    if (!s || s.start !== start) {
      const fresh = { start, used: 0 };
      this.#windows.set(k, fresh);
      return fresh;
    }
    return s;
  }

  #poolState(accountId: string, now: number) {
    const len = (this.#o.pool?.windowSeconds ?? 10) * 1000;
    const start = Math.floor(now / len) * len;
    const s = this.#pool.get(accountId);
    if (!s) return { start, used: 0, prevUsed: 0 };
    if (s.start === start) return s;
    return { start, used: 0, prevUsed: s.start === start - len ? s.used : 0 };
  }

  #refuse(rule: Rule, status: 429 | 503, reason: string, retryAfterMs: number, headers: Record<string, string> = {}): Admission {
    const h = { ...headers, 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) };
    return { allowed: false, status, rule, reason, retryAfterMs: Math.ceil(retryAfterMs), headers: h, lease: undefined, overage: false, charge: 0, warn: false, throttled: false };
  }

  #strike(a: Account, plan: RatePlan, now: number): void {
    const p = plan.penalty;
    if (!p) return;
    const list = (this.#strikes.get(a.id) ?? []).filter((t) => now - t < p.withinMs);
    list.push(now);
    this.#strikes.set(a.id, list);
    if (list.length >= p.strikes) {
      this.#cooldown.set(a.id, now + p.cooldownMs);
      this.#strikes.delete(a.id);
    }
  }

  /** Decide one request for an account. Nothing is recorded unless it is allowed. */
  admit(a: Account, req: Request): Admission {
    const now = this.#o.now();
    const plan = this.#plans.get(a.plan);
    if (!plan) return this.#refuse('unknown-plan', 503, `no rate plan named ${a.plan}`, 60_000);
    const route = plan.routes?.[req.route];
    if (route?.exempt) return { allowed: true, status: 200, rule: 'ok', reason: 'route is exempt', retryAfterMs: 0, headers: {}, lease: undefined, overage: false, charge: 0, warn: false, throttled: false };
    const cost = req.cost ?? route?.cost ?? 1;
    if (!Number.isInteger(cost) || cost < 0) throw new RatePlanError('a request cost is a whole number from 0');

    const until = this.#cooldown.get(a.id);
    if (until !== undefined) {
      if (now < until) return this.#refuse('penalty', 429, 'too many refused requests: cooling down', until - now);
      this.#cooldown.delete(a.id);
    }
    const fail = (r: Admission): Admission => (this.#strike(a, plan, now), r);

    // concurrency
    const mine = this.#leases.get(a.id) ?? new Map<string, number>();
    for (const [id, at] of mine) if (now - at >= (this.#o.leaseMs ?? 60_000)) mine.delete(id);
    if (plan.concurrency !== undefined && mine.size >= plan.concurrency) {
      const oldest = Math.min(...mine.values());
      return fail(this.#refuse('concurrency', 429, `${plan.concurrency} requests are already running`, Math.max(1000, oldest + (this.#o.leaseMs ?? 60_000) - now)));
    }

    // fixed windows
    let tightest: { limit: number; remaining: number; resetMs: number; label: string } | undefined;
    const note = (limit: number, remaining: number, resetMs: number, label: string) => {
      if (!tightest || remaining / limit < tightest.remaining / tightest.limit) tightest = { limit, remaining, resetMs, label };
    };
    const states: { w: WindowSpec; s: WindowState }[] = [];
    for (const w of plan.windows ?? []) {
      const s = this.#window(a.id, w, now);
      const resetMs = s.start + w.seconds * 1000 - now;
      if (s.used + cost > w.limit) return fail(this.#refuse('window', 429, `the ${w.name} limit of ${w.limit} is used`, resetMs, { 'RateLimit-Limit': String(w.limit), 'RateLimit-Remaining': '0', 'RateLimit-Reset': String(Math.ceil(resetMs / 1000)) }));
      note(w.limit, w.limit - s.used - cost, resetMs, w.name);
      states.push({ w, s });
    }

    // fair use of the shared pool
    const pool = this.#o.pool;
    if (pool && cost > 0) {
      const len = (pool.windowSeconds ?? 10) * 1000;
      const total = pool.capacityPerSecond * (len / 1000);
      let sum = 0;
      let active = 0;
      for (const id of this.#pool.keys()) {
        const st = this.#poolState(id, now);
        const u = st.used + st.prevUsed * (1 - (now - st.start) / len);
        if (u > 0) active++;
        sum += u;
      }
      const me = this.#poolState(a.id, now);
      const myUse = me.used + me.prevUsed * (1 - (now - me.start) / len);
      if (myUse === 0) active++;
      if (sum / total >= (pool.highWatermark ?? 0.8) && myUse > (pool.shareFactor ?? 2) * (total / Math.max(1, active))) {
        return fail(this.#refuse('fair-use', 429, 'the service is busy and this account is using far more than its share', len - (now - me.start)));
      }
    }

    // quota
    let overage = false;
    let charge = 0;
    let warn = false;
    let throttled = false;
    const useQuota = plan.quota !== undefined && (route?.quota ?? true) && cost > 0;
    const ent = this.#o.entitlements;
    if (useQuota && ent) {
      const d = ent.check(a, plan.quota!, cost, now);
      const view = ent.resolve(a, now).limits[plan.quota!];
      if (!d.allowed) {
        const end = view ? periodOf(view.period, a.anchorDay, now).end : now + 3_600_000;
        return fail(this.#refuse('quota', 429, d.because, end - now));
      }
      overage = d.overage > 0;
      charge = d.charge;
      warn = d.warn;
      throttled = overage && plan.throttle !== undefined;
    }

    // buckets last: the only check that spends
    const bucketRate = throttled ? plan.throttle! : plan.rate;
    const key = `${plan.name}${throttled ? '\0throttle' : ''}`;
    const planBucket = this.#limiter(key, bucketRate);
    const routeBucket = route?.rate ? this.#limiter(`${plan.name}\0route\0${req.route}`, route.rate) : undefined;
    if (routeBucket && routeBucket.left(a.id) < cost) {
      try {
        routeBucket.take(a.id, cost);
      } catch (e) {
        if (e instanceof Limited) return fail(this.#refuse('route-burst', 429, `${req.route} is going too fast`, e.retryAfterMs));
        throw e;
      }
    }
    try {
      planBucket.take(a.id, cost);
    } catch (e) {
      if (e instanceof Limited) return fail(this.#refuse(throttled ? 'throttle' : 'burst', 429, throttled ? 'past the quota, requests are slowed' : 'too many requests at once', e.retryAfterMs, { 'RateLimit-Limit': String(bucketRate.burst), 'RateLimit-Remaining': '0', 'RateLimit-Reset': String(Math.ceil(e.retryAfterMs / 1000)) }));
      throw e;
    }
    if (routeBucket) routeBucket.take(a.id, cost);

    // commit
    for (const { s } of states) s.used += cost;
    if (useQuota && ent) ent.consume(a, plan.quota!, cost, req.id, now);
    if (pool && cost > 0) {
      const st = this.#poolState(a.id, now);
      this.#pool.set(a.id, { start: st.start, used: st.used + cost, prevUsed: st.prevUsed });
    }
    let lease: string | undefined;
    if (plan.concurrency !== undefined) {
      lease = `l${++this.#seq}`;
      mine.set(lease, now);
      this.#leases.set(a.id, mine);
    }
    const left = planBucket.left(a.id);
    note(bucketRate.burst, left, Math.ceil(((bucketRate.burst - left) / bucketRate.perSecond) * 1000), 'burst');
    const t = tightest as { limit: number; remaining: number; resetMs: number; label: string } | undefined;
    const headers: Record<string, string> = t ? { 'RateLimit-Limit': String(t.limit), 'RateLimit-Remaining': String(Math.max(0, t.remaining)), 'RateLimit-Reset': String(Math.ceil(t.resetMs / 1000)) } : {};
    return { allowed: true, status: 200, rule: throttled ? 'throttle' : 'ok', reason: overage ? 'past the quota; allowed by the plan' : throttled ? 'throttled' : 'ok', retryAfterMs: 0, headers, lease, overage, charge, warn, throttled };
  }

  /** End a request that held a concurrency lease. Returns false when the lease was unknown or had expired. */
  release(accountId: string, lease: string): boolean {
    return this.#leases.get(accountId)?.delete(lease) ?? false;
  }

  /** What an account has used and has left, for a dashboard or a headers endpoint. */
  usage(a: Account): { burstLeft: number; windows: { name: string; limit: number; used: number; remaining: number; resetsAt: number }[]; quota: { limit: number | null; used: number; remaining: number | null } | undefined; inFlight: number; coolingUntil: number | undefined } {
    const now = this.#o.now();
    const plan = this.#plans.get(a.plan);
    if (!plan) throw new RatePlanError(`no rate plan named ${a.plan}`);
    const windows = (plan.windows ?? []).map((w) => {
      const s = this.#window(a.id, w, now);
      return { name: w.name, limit: w.limit, used: s.used, remaining: Math.max(0, w.limit - s.used), resetsAt: s.start + w.seconds * 1000 };
    });
    let quota: { limit: number | null; used: number; remaining: number | null } | undefined;
    if (plan.quota && this.#o.entitlements) {
      const d = this.#o.entitlements.check(a, plan.quota, 0, now);
      quota = { limit: d.limit, used: d.used, remaining: d.remaining };
    }
    const live = [...(this.#leases.get(a.id) ?? [])].filter(([, at]) => now - at < (this.#o.leaseMs ?? 60_000)).length;
    const until = this.#cooldown.get(a.id);
    return { burstLeft: this.#limiter(plan.name, plan.rate).left(a.id), windows, quota, inFlight: live, coolingUntil: until !== undefined && until > now ? until : undefined };
  }
}
