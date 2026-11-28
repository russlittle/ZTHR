import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Flags } from '../flags/index.ts';
import { EntitlementError, Entitlements, Ledger, checkCatalog, flatten, periodOf, resolve } from './index.ts';
import type { Account, Catalog } from './index.ts';

const D = 86_400_000;
const at = (s: string) => Date.parse(s);
const T = at('2026-03-10T12:00:00Z');

const catalog: Catalog = {
  features: ['sso', 'audit-log', 'api', 'beta-editor'],
  limits: ['seats', 'emails', 'storage', 'exports'],
  plans: {
    free: { name: 'free', features: { api: false }, limits: { seats: { included: 3, period: 'gauge' }, emails: { included: 100, period: 'month', overage: { mode: 'block' } }, exports: { included: 5, period: 'day' } } },
    pro: {
      name: 'pro',
      extends: 'free',
      trialDays: 14,
      features: { api: true, 'audit-log': true, 'beta-editor': { enabled: true, flag: 'beta-editor' } },
      limits: { seats: { included: 10, period: 'gauge' }, emails: { included: 1000, period: 'month', overage: { mode: 'charge', price: 200, perUnits: 500, cap: 5000 } }, storage: { included: 50, period: 'lifetime', overage: { mode: 'allow' } } },
    },
    team: { name: 'team', extends: 'pro', features: { sso: true }, limits: { seats: { included: null, period: 'gauge' } } },
  },
};

const acct = (over: Partial<Account> = {}): Account => ({ id: 'acme', plan: 'pro', anchorDay: 15, ...over });
const make = (flags?: Flags) => new Entitlements(catalog, new Ledger(), flags);

test('a catalog is checked as a whole: unknown names, loops, bad numbers and prices that do not add up', () => {
  assert.deepEqual(checkCatalog(catalog), []);
  const bad: Catalog = {
    features: ['a'],
    limits: ['x', 'y'],
    plans: {
      p: { name: 'wrong', extends: 'q', features: { zzz: true }, limits: { x: { included: -1, period: 'month' } } },
      q: { name: 'q', extends: 'r' },
      r: { name: 'r', extends: 'q' },
      s: { name: 's', limits: { y: { included: 5, period: 'month', overage: { mode: 'charge' } }, x: { included: 1.5, period: 'day' }, nope: { included: 1, period: 'day' } }, trialDays: 0 },
      t: { name: 't', limits: { x: { included: 3, period: 'gauge', overage: { mode: 'allow' } }, y: { included: 3, period: 'day', overage: { mode: 'block', price: 5 }, warnAt: 2 } } },
    },
  };
  assert.deepEqual(checkCatalog(bad), [
    'plan "p" is named "wrong"',
    'plan p leads into a loop of plans at q',
    'plan p names an unknown feature "zzz"',
    'plan p: x must be null or a whole number from 0',
    'plan q extends itself',
    'plan r extends itself',
    'plan s: y charges overage but has no whole price and block size',
    'plan s: x must be null or a whole number from 0',
    'plan s names an unknown limit "nope"',
    'plan s: trialDays is 1 to 365',
    'plan t: x is a gauge, which can only block',
    'plan t: y has a price but its overage mode is block',
    'plan t: y warnAt is above 0 and at most 1',
  ]);
  assert.throws(() => new Entitlements(bad), (e: unknown) => e instanceof EntitlementError && e.problems.length > 5);
  const dangling: Catalog = { features: [], limits: [], plans: { a: { name: 'a', extends: 'ghost' } } };
  assert.deepEqual(checkCatalog(dangling), ['plan a extends ghost, which does not exist']);
});

test('plans inherit: the nearest plan wins, and what it does not say it takes from the one it extends', () => {
  const pro = flatten(catalog, 'pro');
  assert.deepEqual(Object.keys(pro.limits).sort(), ['emails', 'exports', 'seats', 'storage']);
  assert.equal(pro.limits.seats!.included, 10);
  assert.equal(pro.limits.exports!.included, 5, 'from free');
  assert.equal(flatten(catalog, 'team').limits.seats!.included, null);
  assert.equal(flatten(catalog, 'team').features.sso!.enabled, true);
  assert.equal(flatten(catalog, 'team').features.api!.enabled, true, 'inherited from pro, which overrode free');
  assert.throws(() => flatten(catalog, 'ghost'), /no plan "ghost"/);
});

test('an account\'s features come from its plan, with the reason in words', () => {
  const r = resolve(catalog, acct(), T);
  assert.deepEqual([r.features.api, r.features.sso], [{ enabled: true, source: 'plan', because: 'included in pro' }, { enabled: false, source: 'none', because: 'not in pro' }]);
  assert.equal(r.features['beta-editor']!.flag, 'beta-editor');
  assert.equal(r.limits.emails!.limit, 1000);
  assert.deepEqual(r.limits.seats!.sources, ['pro: 10']);
  assert.equal(resolve(catalog, acct({ plan: 'free' }), T).limits.storage, undefined, 'free has no storage limit at all');
});

test('a trial gives the better of plan and trial, once, and ends on its date', () => {
  const e = make();
  const free = acct({ plan: 'free' });
  const t = e.startTrial(free, 'pro', T);
  assert.equal(t.trialUsed, true);
  const during = e.resolve(t, T + 5 * D);
  assert.equal(during.trialing, true);
  assert.equal(during.features.api!.enabled, true);
  assert.equal(during.features.api!.source, 'trial');
  assert.match(during.features.api!.because, /included in the pro trial until 2026-03-24/);
  assert.equal(during.limits.seats!.limit, 10);
  assert.equal(during.limits.emails!.limit, 1000);
  assert.deepEqual(during.limits.seats!.sources, ['free: 3', 'trial of pro: 10']);
  const after = e.resolve(t, T + 14 * D);
  assert.equal(after.trialing, false);
  assert.equal(after.features.api!.enabled, false);
  assert.equal(after.limits.seats!.limit, 3);
  assert.throws(() => e.startTrial(t, 'pro', T + 20 * D), /already had its trial/);
  assert.throws(() => e.startTrial(free, 'free', T), /has no trial/);
  const lower = e.resolve(acct({ plan: 'team', trial: { plan: 'free', from: T, until: T + D } }), T);
  assert.equal(lower.limits.seats!.limit, null, 'a trial of a smaller plan never lowers anything');
});

test('add-ons and time-boxed grants raise a limit; a grant that has ended adds nothing', () => {
  const a = acct({ addons: [{ limit: 'seats', add: 5 }], grants: [{ id: 'g', reason: 'launch promo', from: T - D, until: T + 3 * D, limit: 'emails', add: 500 }, { id: 'old', reason: 'expired promo', from: T - 30 * D, until: T - D, limit: 'emails', add: 9999 }] });
  const r = resolve(catalog, a, T);
  assert.equal(r.limits.seats!.limit, 15);
  assert.equal(r.limits.emails!.limit, 1500);
  assert.deepEqual(r.limits.emails!.sources, ['pro: 1000', 'grant: +500 (launch promo)']);
  assert.equal(resolve(catalog, a, T + 4 * D).limits.emails!.limit, 1000);
  const f = acct({ plan: 'free', addonFeatures: ['audit-log'], grants: [{ id: 'f', reason: 'pilot', from: T, until: T + D, feature: 'sso' }] });
  assert.deepEqual([resolve(catalog, f, T).features['audit-log']!.source, resolve(catalog, f, T).features.sso!.source], ['addon', 'grant']);
  assert.equal(resolve(catalog, f, T + 2 * D).features.sso!.enabled, false);
});

test('overrides win over everything: a feature can be switched off, a limit set outright, and both end', () => {
  const a = acct({ overrides: [{ id: 'o1', reason: 'abuse review', until: T + 7 * D, feature: 'api', enabled: false }, { id: 'o2', reason: 'negotiated', until: null, limit: 'seats', value: 25 }, { id: 'o3', reason: 'custom deal', until: null, limit: 'exports', value: null }] });
  const r = resolve(catalog, a, T);
  assert.deepEqual(r.features.api, { enabled: false, source: 'override', because: 'override: abuse review' });
  assert.equal(r.limits.seats!.limit, 25);
  assert.equal(r.limits.exports!.limit, null);
  assert.equal(resolve(catalog, a, T + 8 * D).features.api!.enabled, true, 'the override ended');
});

test('a limit is checked against what has been used, up to and not past the number', () => {
  const e = make();
  const a = acct({ plan: 'free' });
  const first = e.consume(a, 'emails', 60, 'k1', T);
  assert.deepEqual([first.allowed, first.used, first.remaining, first.because, first.warn], [true, 0, 100, '60 of 100 used', false]);
  const second = e.consume(a, 'emails', 40, 'k2', T);
  assert.deepEqual([second.allowed, second.because, second.warn], [true, '100 of 100 used', true]);
  const third = e.consume(a, 'emails', 1, 'k3', T);
  assert.equal(third.allowed, false);
  assert.equal(third.because, 'that would pass the limit of 100 (100 used, 0 left)');
  assert.equal(third.overage, 1);
  assert.equal(e.check(a, 'emails', 0, T).allowed, true, 'asking for nothing is always fine');
  assert.equal(e.ledger.used('acme', 'emails', 'month', 15, T), 100, 'a refused request records nothing');
});

test('a request is all or nothing: it does not use up part of what is left', () => {
  const e = make();
  const a = acct({ plan: 'free' });
  e.consume(a, 'emails', 90, 'a', T);
  assert.equal(e.consume(a, 'emails', 20, 'b', T).allowed, false);
  assert.equal(e.check(a, 'emails', 10, T).allowed, true);
  assert.equal(e.check(a, 'emails', 10, T).remaining, 10);
});

test('warnings come at the share the plan sets', () => {
  const e = make();
  const a = acct({ plan: 'free' });
  assert.equal(e.consume(a, 'emails', 79, 'a', T).warn, false);
  assert.equal(e.consume(a, 'emails', 1, 'b', T).warn, true, '80 of 100');
});

test('usage with the same key counts once, however often it is retried', () => {
  const e = make();
  const a = acct({ plan: 'free' });
  const one = e.consume(a, 'emails', 30, 'req-77', T);
  const again = e.consume(a, 'emails', 30, 'req-77', T + 1000);
  assert.deepEqual(again, one);
  assert.equal(e.ledger.used('acme', 'emails', 'month', 15, T), 30);
  assert.equal(e.consume(acct({ id: 'other', plan: 'free' }), 'emails', 30, 'req-77', T).used, 0, 'the key is per account');
  assert.throws(() => e.consume(a, 'emails', 1, '', T), /idempotency key/);
});

test('overage that is charged goes by the block, only for blocks the request opens, up to the cap', () => {
  const e = make();
  const a = acct();
  e.consume(a, 'emails', 1000, 'fill', T);
  const d1 = e.consume(a, 'emails', 1, 'o1', T);
  assert.deepEqual([d1.allowed, d1.overage, d1.charge, d1.because], [true, 1, 200, '1 over the limit of 1000; 1 more block(s) at 200 each']);
  const d2 = e.consume(a, 'emails', 499, 'o2', T);
  assert.equal(d2.charge, 0, 'still inside the block already opened');
  const d3 = e.consume(a, 'emails', 1, 'o3', T);
  assert.equal(d3.charge, 200, 'the next block opens');
  assert.deepEqual(e.overageLines(a, T), [{ limit: 'emails', included: 1000, used: 1501, over: 501, blocks: 2, amount: 400 }]);
  const big = e.check(a, 'emails', 5000, T);
  assert.equal(big.allowed, false);
  assert.equal(big.because, 'that would pass the limit of 1000 and the overage cap of 5000');
});

test('overage that is allowed free is allowed, with a warning, and blocked ones stay blocked', () => {
  const e = make();
  const a = acct();
  const d = e.consume(a, 'storage', 60, 's', T);
  assert.deepEqual([d.allowed, d.overage, d.charge, d.warn, d.because], [true, 10, 0, true, '10 over the limit of 50, at no charge']);
  assert.deepEqual(e.overageLines(a, T), []);
});

test('periods: monthly from the billing day, clamped in short months, daily, and for life', () => {
  assert.deepEqual(periodOf('month', 15, at('2026-03-10T12:00:00Z')), { start: at('2026-02-15T00:00:00Z'), end: at('2026-03-15T00:00:00Z') });
  assert.deepEqual(periodOf('month', 15, at('2026-03-15T00:00:00Z')), { start: at('2026-03-15T00:00:00Z'), end: at('2026-04-15T00:00:00Z') });
  assert.deepEqual(periodOf('month', 31, at('2026-03-01T00:00:00Z')), { start: at('2026-02-28T00:00:00Z'), end: at('2026-03-31T00:00:00Z') });
  assert.deepEqual(periodOf('month', 31, at('2028-03-15T00:00:00Z')), { start: at('2028-02-29T00:00:00Z'), end: at('2028-03-31T00:00:00Z') });
  assert.deepEqual(periodOf('month', 1, at('2026-01-10T00:00:00Z')), { start: at('2026-01-01T00:00:00Z'), end: at('2026-02-01T00:00:00Z') });
  assert.deepEqual(periodOf('month', 20, at('2026-01-10T00:00:00Z')), { start: at('2025-12-20T00:00:00Z'), end: at('2026-01-20T00:00:00Z') });
  assert.deepEqual(periodOf('day', 15, at('2026-03-10T23:59:59Z')), { start: at('2026-03-10T00:00:00Z'), end: at('2026-03-11T00:00:00Z') });
  assert.deepEqual(periodOf('year', 15, at('2026-03-10T00:00:00Z')), { start: at('2026-01-01T00:00:00Z'), end: at('2027-01-01T00:00:00Z') });
  assert.deepEqual(periodOf('lifetime', 1, T), { start: 0, end: Infinity });
});

test('usage resets with the period: the next month is a fresh allowance, and a day for daily limits', () => {
  const e = make();
  const a = acct({ plan: 'free', anchorDay: 15 });
  e.consume(a, 'emails', 100, 'm1', at('2026-03-14T23:00:00Z'));
  assert.equal(e.check(a, 'emails', 1, at('2026-03-14T23:30:00Z')).allowed, false);
  assert.equal(e.check(a, 'emails', 1, at('2026-03-15T00:00:00Z')).allowed, true, 'the billing day starts a new month');
  e.consume(a, 'exports', 5, 'd1', at('2026-03-10T08:00:00Z'));
  assert.equal(e.check(a, 'exports', 1, at('2026-03-10T23:00:00Z')).allowed, false);
  assert.equal(e.check(a, 'exports', 1, at('2026-03-11T00:00:01Z')).allowed, true);
});

test('a gauge such as seats is measured, not summed; downgrading below what is in use is reported before it happens', () => {
  const e = make();
  const a = acct();
  e.consume(a, 'seats', 8, 'seat-1', T);
  assert.equal(e.ledger.used('acme', 'seats', 'gauge', 15, T), 8);
  e.ledger.setGauge('acme', 'seats', 12);
  assert.equal(e.check(a, 'seats', 1, T).allowed, false, 'already past the plan\'s ten');
  assert.deepEqual(e.downgradeProblems(a, 'free', T), ['audit-log would be switched off', 'api would be switched off', 'beta-editor would be switched off', 'seats is 12 but free allows 3']);
  assert.throws(() => e.changePlan(a, 'free', T), (x: unknown) => x instanceof EntitlementError && x.problems.includes('seats is 12 but free allows 3'));
  assert.equal(e.changePlan(a, 'free', T, true).plan, 'free');
  assert.equal(e.changePlan(a, 'team', T).plan, 'team', 'an upgrade breaks nothing');
  assert.throws(() => e.changePlan(a, 'ghost', T), /no plan "ghost"/);
  assert.throws(() => e.ledger.setGauge('acme', 'seats', -1), /whole number/);
});

test('unlimited limits allow anything, and a limit the plan does not have allows nothing', () => {
  const e = make();
  const team = acct({ plan: 'team' });
  const d = e.check(team, 'seats', 1_000_000, T);
  assert.deepEqual([d.allowed, d.limit, d.remaining, d.because], [true, null, null, 'unlimited']);
  const none = e.check(acct({ plan: 'free' }), 'storage', 1, T);
  assert.deepEqual([none.allowed, none.because], [false, 'storage is not part of free']);
  assert.equal(e.check(acct({ plan: 'free', overrides: [{ id: 'z', reason: 'frozen', until: null, limit: 'emails', value: 0 }] }), 'emails', 1, T).allowed, false);
  assert.equal(e.check(acct({ overrides: [{ id: 'z', reason: 'frozen', until: null, limit: 'emails', value: 0 }] }), 'emails', 1, T).charge, 200, 'pro still charges overage on a limit set to zero');
});

test('features behind a flag need the flag on for the person too', () => {
  const flags = new Flags([{ key: 'beta-editor', description: 'new editor', owner: 'web', on: true, rules: [{ percent: 50 }] }]);
  const e = make(flags);
  const a = acct();
  const people = Array.from({ length: 40 }, (_, i) => `user-${i}`);
  const on = people.filter((id) => e.feature(a, 'beta-editor', T, { id }).enabled);
  assert.ok(on.length > 8 && on.length < 32, `${on.length} of 40 get the beta`);
  assert.deepEqual(on, people.filter((id) => flags.isOn('beta-editor', { id })), 'exactly the people the flag reaches');
  const off = people.find((id) => !on.includes(id))!;
  assert.match(e.feature(a, 'beta-editor', T, { id: off }).because, /included in pro, but flag beta-editor is off for this person/);
  assert.equal(e.feature(a, 'beta-editor', T).enabled, false, 'no person named, flag unknown');
  assert.equal(e.feature(acct({ plan: 'free' }), 'beta-editor', T, { id: on[0]! }).enabled, false, 'the plan has to include it first');
  assert.equal(e.feature(a, 'api', T).enabled, true, 'a feature with no flag needs none');
  assert.throws(() => e.feature(a, 'warp-drive', T), /not a feature/);
  assert.equal(make().feature(a, 'beta-editor', T, { id: 'x' }).enabled, false, 'no flags configured: not on');
});

test('nonsense is refused: unknown limits, fractions, negatives, a bad billing day', () => {
  const e = make();
  assert.throws(() => e.check(acct(), 'warp', 1, T), /not a limit/);
  for (const bad of [-1, 1.5, NaN, Infinity, 1e13]) assert.throws(() => e.check(acct(), 'emails', bad, T), /whole number of units/, String(bad));
  assert.throws(() => e.resolve(acct({ anchorDay: 0 }), T), /1 to 31/);
  assert.throws(() => e.resolve(acct({ anchorDay: 32 }), T), /1 to 31/);
  assert.throws(() => e.resolve(acct({ plan: 'ghost' }), T), /no plan/);
});

test('old usage can be dropped to keep memory bounded, without touching the current period', () => {
  const e = make();
  const a = acct({ plan: 'free' });
  e.consume(a, 'emails', 10, 'old', at('2025-01-20T00:00:00Z'));
  e.consume(a, 'emails', 20, 'new', T);
  assert.equal(e.ledger.compact(at('2026-01-01T00:00:00Z')), 1);
  assert.equal(e.ledger.used('acme', 'emails', 'month', 15, T), 20);
});
