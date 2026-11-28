import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Entitlements, type Account, type Catalog } from '../entitlements/index.ts';
import { RatePlanError, RatePlans, checkPlans, type RatePlan } from './index.ts';

const T0 = Date.UTC(2026, 10, 28, 12, 0, 0);

const catalog: Catalog = {
  plans: {
    free: { name: 'free', limits: { 'api.calls': { included: 200, period: 'month', overage: { mode: 'block' } } } },
    pro: { name: 'pro', limits: { 'api.calls': { included: 100, period: 'month', overage: { mode: 'charge', price: 100, perUnits: 50 } } } },
    open: { name: 'open', limits: { 'api.calls': { included: 10, period: 'month', overage: { mode: 'allow' } } } },
  },
  features: [],
  limits: ['api.calls'],
};
const acct = (id: string, plan: string): Account => ({ id, plan, anchorDay: 1 });

function make(plans: RatePlan[], o: { pool?: { capacityPerSecond: number; windowSeconds?: number; highWatermark?: number; shareFactor?: number }; leaseMs?: number } = {}) {
  let t = T0;
  const ent = new Entitlements(catalog);
  const rp = new RatePlans({ plans, now: () => t, entitlements: ent, ...o });
  let n = 0;
  return { rp, ent, tick: (ms: number) => (t += ms), now: () => t, id: () => `req-${++n}` };
}

const FREE: RatePlan = { name: 'free', rate: { perSecond: 2, burst: 5 }, windows: [{ name: 'minute', seconds: 60, limit: 60 }], quota: 'api.calls' };

test('burst then sustained: five at once, the sixth waits half a second, and refills continuously', () => {
  const { rp, tick, id } = make([FREE]);
  const a = acct('a1', 'free');
  for (let i = 0; i < 5; i++) assert.equal(rp.admit(a, { route: 'r', id: id() }).allowed, true);
  const no = rp.admit(a, { route: 'r', id: id() });
  assert.deepEqual([no.allowed, no.status, no.rule, no.retryAfterMs], [false, 429, 'burst', 500]);
  assert.equal(no.headers['Retry-After'], '1');
  assert.equal(no.headers['RateLimit-Remaining'], '0');
  tick(499);
  assert.equal(rp.admit(a, { route: 'r', id: id() }).allowed, false);
  tick(1);
  assert.equal(rp.admit(a, { route: 'r', id: id() }).allowed, true);
  tick(10_000);
  assert.equal(rp.usage(a).burstLeft, 5, 'refill stops at the burst');
});

test('accounts do not share buckets, windows or quotas', () => {
  const { rp, id } = make([FREE]);
  const a = acct('a1', 'free');
  const b = acct('b1', 'free');
  for (let i = 0; i < 5; i++) rp.admit(a, { route: 'r', id: id() });
  assert.equal(rp.admit(a, { route: 'r', id: id() }).allowed, false);
  assert.equal(rp.admit(b, { route: 'r', id: id() }).allowed, true);
  assert.equal(rp.usage(b).quota!.used, 1);
});

test('headers describe the tightest rule and a refusal by a window says when the window ends', () => {
  const { rp, tick, id } = make([{ ...FREE, rate: { perSecond: 1000, burst: 1000 } }]);
  const a = acct('a1', 'free');
  tick(5_000);
  let last = rp.admit(a, { route: 'r', id: id() });
  assert.deepEqual([last.headers['RateLimit-Limit'], last.headers['RateLimit-Remaining']], ['60', '59']);
  for (let i = 0; i < 59; i++) last = rp.admit(a, { route: 'r', id: id() });
  assert.equal(last.headers['RateLimit-Remaining'], '0');
  const no = rp.admit(a, { route: 'r', id: id() });
  assert.deepEqual([no.rule, no.status, no.retryAfterMs], ['window', 429, 60_000 - 5_000 - 0]);
  assert.deepEqual([no.headers['RateLimit-Limit'], no.headers['RateLimit-Reset'], no.headers['Retry-After']], ['60', '55', '55']);
  tick(55_000);
  assert.equal(rp.admit(a, { route: 'r', id: id() }).allowed, true);
});

test('a refusal records nothing: a window refusal does not spend burst, and a burst refusal does not count in the window', () => {
  const { rp, tick, id } = make([{ name: 'free', rate: { perSecond: 1, burst: 3 }, windows: [{ name: 'minute', seconds: 60, limit: 2 }], quota: 'api.calls' }]);
  const a = acct('a1', 'free');
  rp.admit(a, { route: 'r', id: id() });
  rp.admit(a, { route: 'r', id: id() });
  assert.equal(rp.usage(a).burstLeft, 1);
  for (let i = 0; i < 5; i++) assert.equal(rp.admit(a, { route: 'r', id: id() }).rule, 'window');
  assert.equal(rp.usage(a).burstLeft, 1, 'the refused calls cost no burst');
  assert.equal(rp.usage(a).quota!.used, 2, 'nor quota');
  const b = make([{ name: 'free', rate: { perSecond: 1, burst: 1 }, windows: [{ name: 'minute', seconds: 60, limit: 10 }], quota: 'api.calls' }]);
  const c = acct('c1', 'free');
  b.rp.admit(c, { route: 'r', id: 'x1' });
  assert.equal(b.rp.admit(c, { route: 'r', id: 'x2' }).rule, 'burst');
  assert.equal(b.rp.usage(c).windows[0]!.used, 1);
  assert.equal(b.rp.usage(c).quota!.used, 1);
  void tick;
});

test('route costs, per-route buckets and exempt routes', () => {
  const plan: RatePlan = { name: 'pro', rate: { perSecond: 10, burst: 30 }, quota: 'api.calls', routes: { export: { cost: 20 }, search: { rate: { perSecond: 1, burst: 2 } }, health: { exempt: true }, free: { cost: 0 } } };
  const { rp, tick, id } = make([plan]);
  const a = acct('a1', 'pro');
  assert.equal(rp.admit(a, { route: 'export', id: id() }).allowed, true);
  assert.equal(rp.usage(a).burstLeft, 10);
  const second = rp.admit(a, { route: 'export', id: id() });
  assert.deepEqual([second.allowed, second.retryAfterMs], [false, 1000]);
  for (let i = 0; i < 50; i++) assert.equal(rp.admit(a, { route: 'health', id: id() }).allowed, true);
  assert.equal(rp.usage(a).quota!.used, 20, 'exempt requests cost nothing');
  assert.equal(rp.admit(a, { route: 'search', id: id() }).allowed, true);
  assert.equal(rp.admit(a, { route: 'search', id: id() }).allowed, true);
  const slow = rp.admit(a, { route: 'search', id: id() });
  assert.deepEqual([slow.rule, slow.retryAfterMs], ['route-burst', 1000]);
  tick(1000);
  assert.equal(rp.admit(a, { route: 'search', id: id() }).allowed, true);
  assert.equal(rp.admit(a, { route: 'free', id: id() }).allowed, true);
  assert.equal(rp.admit(a, { route: 'search', id: id(), cost: 3 }).rule, 'route-burst', 'a cost over the route bucket is refused');
  assert.throws(() => rp.admit(a, { route: 'search', id: id(), cost: -1 }), RatePlanError);
});

test('the monthly quota blocks at the limit with the time to the next period, and a retried id counts once', () => {
  const { rp, id } = make([{ name: 'free', rate: { perSecond: 1000, burst: 1000 }, quota: 'api.calls' }]);
  const a = acct('a1', 'free');
  const dup = rp.admit(a, { route: 'r', id: 'same' });
  const again = rp.admit(a, { route: 'r', id: 'same' });
  assert.deepEqual([dup.allowed, again.allowed], [true, true]);
  assert.equal(rp.usage(a).quota!.used, 1, 'counted once');
  for (let i = 0; i < 199; i++) rp.admit(a, { route: 'r', id: id() });
  assert.equal(rp.usage(a).quota!.used, 200);
  const no = rp.admit(a, { route: 'r', id: id() });
  assert.deepEqual([no.allowed, no.status, no.rule], [false, 429, 'quota']);
  assert.match(no.reason, /pass the limit of 200/);
  assert.equal(no.retryAfterMs, Date.UTC(2026, 11, 1) - T0, 'until the billing month rolls over');
});

test('warnings: the quota reports when it is nearly used', () => {
  const { rp, id } = make([{ name: 'free', rate: { perSecond: 1000, burst: 1000 }, quota: 'api.calls' }]);
  const a = acct('a1', 'free');
  let warned = 0;
  for (let i = 0; i < 200; i++) if (rp.admit(a, { route: 'r', id: id() }).warn) warned++;
  assert.equal(warned, 41, 'from the 160th of 200 on');
});

test('overage that is charged or free is allowed, flagged, and slowed by the fair-use throttle', () => {
  const pro: RatePlan = { name: 'pro', rate: { perSecond: 100, burst: 100 }, quota: 'api.calls', throttle: { perSecond: 1, burst: 2 } };
  const { rp, tick, id } = make([pro]);
  const a = acct('a1', 'pro');
  for (let i = 0; i < 100; i++) assert.equal(rp.admit(a, { route: 'r', id: id() }).overage, false);
  const first = rp.admit(a, { route: 'r', id: id() });
  assert.deepEqual([first.allowed, first.overage, first.throttled, first.charge], [true, true, true, 100]);
  const second = rp.admit(a, { route: 'r', id: id() });
  assert.deepEqual([second.allowed, second.charge], [true, 0], 'the first block of 50 is already paid');
  const third = rp.admit(a, { route: 'r', id: id() });
  assert.deepEqual([third.allowed, third.rule, third.retryAfterMs], [false, 'throttle', 1000]);
  tick(1000);
  assert.equal(rp.admit(a, { route: 'r', id: id() }).allowed, true);
  const open = make([{ name: 'open', rate: { perSecond: 100, burst: 100 }, quota: 'api.calls' }]);
  const o = acct('o1', 'open');
  for (let i = 0; i < 10; i++) open.rp.admit(o, { route: 'r', id: open.id() });
  const free = open.rp.admit(o, { route: 'r', id: open.id() });
  assert.deepEqual([free.allowed, free.overage, free.charge, free.throttled], [true, true, 0, false]);
});

test('concurrency: leases hold slots until released, and a lost lease expires on its own', () => {
  const plan: RatePlan = { name: 'free', rate: { perSecond: 1000, burst: 1000 }, concurrency: 2, quota: 'api.calls' };
  const { rp, tick, id } = make([plan], { leaseMs: 30_000 });
  const a = acct('a1', 'free');
  const r1 = rp.admit(a, { route: 'r', id: id() });
  const r2 = rp.admit(a, { route: 'r', id: id() });
  assert.ok(r1.lease && r2.lease && r1.lease !== r2.lease);
  const no = rp.admit(a, { route: 'r', id: id() });
  assert.deepEqual([no.allowed, no.rule], [false, 'concurrency']);
  assert.equal(rp.usage(a).inFlight, 2);
  assert.equal(rp.release('a1', r1.lease!), true);
  assert.equal(rp.release('a1', r1.lease!), false, 'releasing twice does nothing');
  assert.equal(rp.admit(a, { route: 'r', id: id() }).allowed, true);
  tick(30_000);
  assert.equal(rp.usage(a).inFlight, 0, 'unreleased leases expire');
  assert.equal(rp.admit(a, { route: 'r', id: id() }).allowed, true);
});

test('a penalty box: repeated refusals earn a cooldown that outlasts a refilled bucket', () => {
  const plan: RatePlan = { name: 'free', rate: { perSecond: 1, burst: 1 }, penalty: { strikes: 3, withinMs: 10_000, cooldownMs: 30_000 } };
  const { rp, tick, id } = make([plan]);
  const a = acct('a1', 'free');
  assert.equal(rp.admit(a, { route: 'r', id: id() }).allowed, true);
  for (let i = 0; i < 3; i++) assert.equal(rp.admit(a, { route: 'r', id: id() }).rule, 'burst');
  tick(2000);
  const boxed = rp.admit(a, { route: 'r', id: id() });
  assert.deepEqual([boxed.allowed, boxed.rule, boxed.retryAfterMs], [false, 'penalty', 28_000]);
  assert.equal(rp.usage(a).coolingUntil, T0 + 30_000);
  tick(28_000);
  assert.equal(rp.admit(a, { route: 'r', id: id() }).allowed, true);
  assert.equal(rp.usage(a).coolingUntil, undefined);
  const spread = make([plan]);
  const b = acct('b1', 'free');
  spread.rp.admit(b, { route: 'r', id: spread.id() });
  for (let i = 0; i < 2; i++) spread.rp.admit(b, { route: 'r', id: spread.id() });
  spread.tick(11_000);
  spread.rp.admit(b, { route: 'r', id: spread.id() });
  spread.rp.admit(b, { route: 'r', id: spread.id() });
  assert.equal(spread.rp.admit(b, { route: 'r', id: spread.id() }).rule, 'burst', 'strikes older than the window do not add up');
});

test('fair use of the pool: when the service is nearly full the heaviest account is refused, not the light ones', () => {
  const big: RatePlan = { name: 'free', rate: { perSecond: 10_000, burst: 10_000 } };
  const { rp, tick, id } = make([big], { pool: { capacityPerSecond: 10, windowSeconds: 10 } });
  const heavy = acct('heavy', 'free');
  const l1 = acct('l1', 'free');
  const l2 = acct('l2', 'free');
  tick(0);
  for (let i = 0; i < 80; i++) assert.equal(rp.admit(heavy, { route: 'r', id: id() }).allowed, true, 'while the pool has room nobody is refused');
  for (let i = 0; i < 5; i++) rp.admit(l1, { route: 'r', id: id() });
  for (let i = 0; i < 5; i++) rp.admit(l2, { route: 'r', id: id() });
  for (let i = 0; i < 10; i++) rp.admit(heavy, { route: 'r', id: id() });
  const no = rp.admit(heavy, { route: 'r', id: id() });
  assert.deepEqual([no.allowed, no.rule, no.status], [false, 'fair-use', 429]);
  assert.equal(rp.admit(l1, { route: 'r', id: id() }).allowed, true);
  assert.equal(rp.admit(l2, { route: 'r', id: id() }).allowed, true);
  tick(25_000);
  assert.equal(rp.admit(heavy, { route: 'r', id: id() }).allowed, true, 'consumption ages out of the window');
});

test('an account on an unknown plan is refused with 503, not waved through', () => {
  const { rp, id } = make([FREE]);
  const r = rp.admit(acct('x', 'platinum'), { route: 'r', id: id() });
  assert.deepEqual([r.allowed, r.status, r.rule], [false, 503, 'unknown-plan']);
  assert.throws(() => rp.usage(acct('x', 'platinum')), /no rate plan named platinum/);
});

test('usage reports burst, windows, quota and in-flight', () => {
  const { rp, tick, id } = make([{ ...FREE, concurrency: 3 }]);
  const a = acct('a1', 'free');
  tick(3_000);
  rp.admit(a, { route: 'r', id: id() });
  rp.admit(a, { route: 'r', id: id() });
  const u = rp.usage(a);
  assert.deepEqual(u.windows, [{ name: 'minute', limit: 60, used: 2, remaining: 58, resetsAt: T0 + 60_000 }]);
  assert.deepEqual(u.quota, { limit: 200, used: 2, remaining: 198 });
  assert.equal(u.burstLeft, 3);
  assert.equal(u.inFlight, 2);
});

test('plan checks list every mistake at once', () => {
  const bad: RatePlan[] = [
    { name: 'a', rate: { perSecond: 0, burst: 5 } },
    { name: 'a', rate: { perSecond: 1, burst: 0.5 } },
    { name: 'b', rate: { perSecond: 1, burst: 5 }, windows: [{ name: 'm', seconds: 0, limit: 1 }, { name: 'm', seconds: 60, limit: 0 }], concurrency: 0, quota: 'q', throttle: { perSecond: 9, burst: 1 } },
    { name: 'c', rate: { perSecond: 1, burst: 5 }, routes: { big: { cost: 10 }, own: { cost: 5, rate: { perSecond: 1, burst: 2 } } }, penalty: { strikes: 0, withinMs: 1, cooldownMs: 1 } },
  ];
  const problems = checkPlans(bad, false);
  assert.deepEqual(problems, [
    'a: a rate needs perSecond above 0 and a burst of at least 1',
    'plan a is defined twice',
    'a: a rate needs perSecond above 0 and a burst of at least 1',
    'plan b: the throttle must be slower than the normal rate',
    'plan b: window m must last a whole number of seconds',
    'plan b: window m needs a whole limit of at least 1',
    'plan b: window m is defined twice',
    'plan b: concurrency is a whole number from 1',
    'plan b names a quota but no entitlements were given',
    'plan c: route own costs more than its own burst, so it could never run',
    "plan c: route big costs more than the plan's burst, so it could never run",
    'plan c: a penalty needs strikes, a window and a cooldown',
  ]);
  assert.throws(() => new RatePlans({ plans: bad, now: () => 0 }), (e: unknown) => e instanceof RatePlanError && e.problems.length === problems.length);
  assert.throws(() => new RatePlans({ plans: [FREE], now: () => 0, pool: { capacityPerSecond: 0 } }), /pool needs a capacity/);
  assert.throws(() => new RatePlans({ plans: [{ name: 'x', rate: { perSecond: 1, burst: 1 }, quota: 'api.calls' }], now: () => 0 }), /names a quota but no entitlements/);
});
