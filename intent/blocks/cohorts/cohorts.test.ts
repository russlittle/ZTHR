import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Columns, CohortError, buildCohorts, growthAccounting, inactivityChurn, survival, periodIndex, periodStart, label, formatTable } from './index.ts';
import type { Event } from '../analytics/index.ts';

const H = 3_600_000, DAY = 86_400_000;
const D0 = Date.UTC(2026, 2, 2); // Monday 2026-03-02
const at = (d: number, h = 10) => D0 + d * DAY + h * H;
const ev = (who: string, name: string, d: number, props: Event['props'] = {}, h = 10): Event => ({ who, name, at: at(d, h), props });
const FIX: Event[] = [
  ev('a', 'signup', 0), ev('b', 'signup', 0), ev('c', 'signup', 0), ev('d', 'signup', 7), ev('e', 'signup', 7),
  ev('a', 'use', 8), ev('a', 'use', 15), ev('b', 'use', 9), ev('c', 'use', 24), ev('d', 'use', 15),
];
const ASOF = at(28, 12); // Monday 2026-03-30 noon: weeks up to the one of Mar 23 are complete
const W = { period: 'week' as const, asOf: ASOF };

test('weeks and months are labelled and started where a reader expects', () => {
  assert.equal(label(periodIndex(at(0), { period: 'week' }), { period: 'week' }), '2026-03-02');
  assert.equal(label(periodIndex(at(6), { period: 'week' }), { period: 'week' }), '2026-03-02');
  assert.equal(label(periodIndex(at(6), { period: 'week', weekStart: 'sunday' }), { period: 'week', weekStart: 'sunday' }), '2026-03-08');
  assert.equal(label(periodIndex(at(0), { period: 'month' }), { period: 'month' }), '2026-03');
  assert.equal(periodStart(periodIndex(at(3), { period: 'day' }), { period: 'day' }), D0 + 3 * DAY);
  assert.equal(periodStart(periodIndex(at(0), { period: 'month' }), { period: 'month' }), Date.UTC(2026, 2, 1));
});

test('the UTC offset moves an event into the reader\'s own day and month', () => {
  const t = Date.UTC(2026, 1, 28, 23, 30);
  assert.equal(label(periodIndex(t, { period: 'month' }), { period: 'month' }), '2026-02');
  assert.equal(label(periodIndex(t, { period: 'month', offsetMinutes: 60 }), { period: 'month', offsetMinutes: 60 }), '2026-03');
  assert.equal(periodStart(periodIndex(t, { period: 'day', offsetMinutes: 60 }), { period: 'day', offsetMinutes: 60 }), Date.UTC(2026, 1, 28, 23, 0));
  assert.throws(() => buildCohorts([], { ...W, offsetMinutes: 15 * 60 }), /14 hours/);
  assert.throws(() => buildCohorts([], { ...W, period: 'year' as never }), /day, week or month/);
});

test('weekly cohorts: sizes, retained counts and rates, with the unfinished week left blank', () => {
  const t = buildCohorts(FIX, { ...W, cohortEvent: 'signup', periods: 5 });
  assert.equal(t.people, 5);
  assert.deepEqual(t.rows.map((r) => [r.key, r.size]), [['2026-03-02', 3], ['2026-03-09', 2]]);
  assert.deepEqual(t.rows[0]!.retained, [3, 2, 1, 1, null]);
  assert.deepEqual(t.rows[0]!.base, [3, 3, 3, 3, 0]);
  assert.deepEqual(t.rows[1]!.retained, [2, 1, 0, null, null]);
  assert.deepEqual(t.rows[1]!.rate, [1, 0.5, 0, null, null]);
});

test('the curve pools people, not rates, and only over cohorts old enough', () => {
  const t = buildCohorts(FIX, { ...W, cohortEvent: 'signup', periods: 5 });
  assert.deepEqual(t.curveBase, [5, 5, 5, 3, 0]);
  assert.deepEqual(t.curve, [1, 0.6, 0.2, 1 / 3, null]);
  assert.equal(t.curve[1], 0.6);
  assert.equal(t.curve[2], 0.2);
});

test('unbounded retention counts anyone seen in that period or later', () => {
  const t = buildCohorts(FIX, { ...W, cohortEvent: 'signup', periods: 4, kind: 'unbounded' });
  assert.deepEqual(t.rows[0]!.retained, [3, 3, 2, 1]);
  assert.deepEqual(t.rows[1]!.retained, [2, 1, 0, null]);
});

test('returnEvents narrows what counts as coming back', () => {
  const t = buildCohorts(FIX, { ...W, cohortEvent: 'signup', periods: 4, returnEvents: ['use'] });
  assert.deepEqual(t.rows[0]!.retained, [0, 2, 1, 1]);
  assert.deepEqual(t.rows[1]!.retained, [0, 1, 0, null]);
});

test('with no cohort event, a person\'s first event of any kind defines their cohort', () => {
  const t = buildCohorts([...FIX, ev('z', 'use', 7)], { ...W, periods: 2 });
  assert.equal(t.people, 6);
  assert.equal(t.rows[1]!.size, 3);
});

test('small cells are suppressed, not shown', () => {
  const t = buildCohorts(FIX, { ...W, cohortEvent: 'signup', periods: 3, minSize: 3 });
  assert.deepEqual(t.rows[1]!.retained, [null, null, null]);
  assert.deepEqual(t.rows[1]!.rate, [null, null, null]);
  assert.deepEqual(t.rows[0]!.retained, [3, 2, 1]);
  assert.deepEqual(t.curve, [1, 2 / 3, 1 / 3]);
});

test('cohorts can be split by a property of the defining event', () => {
  const evs: Event[] = [
    ev('a', 'signup', 0, { plan: 'free' }), ev('b', 'signup', 0, { plan: 'pro' }), ev('c', 'signup', 0, { plan: 'pro' }), ev('d', 'signup', 1),
    ev('b', 'use', 8), ev('c', 'use', 9), ev('a', 'use', 16),
  ];
  const t = buildCohorts(evs, { ...W, cohortEvent: 'signup', periods: 2, groupBy: 'plan' });
  assert.deepEqual(t.rows.map((r) => [r.key, r.size, r.retained[1]]), [['2026-03-02|(none)', 1, 0], ['2026-03-02|free', 1, 0], ['2026-03-02|pro', 2, 2]]);
  assert.deepEqual(t.rows.map((r) => r.group), ['(none)', 'free', 'pro']);
});

test('relative alignment measures each person from their own first event and waits for maturity', () => {
  const evs: Event[] = [
    ev('u1', 'signup', 0, {}, 10), ev('u1', 'use', 1, {}, 12), // 26 h later: day 1
    ev('u2', 'signup', 0, {}, 23), ev('u2', 'use', 1, {}, 1), // 2 h later: still day 0
    ev('u3', 'signup', 8, {}, 23), // joined too recently for day 1 to be known at asOf
  ];
  const asOf = at(10, 12);
  const rel = buildCohorts(evs, { period: 'day', asOf, cohortEvent: 'signup', periods: 3, align: 'relative', returnEvents: ['use'] });
  const d0 = rel.rows.find((r) => r.key === '2026-03-02')!;
  assert.deepEqual(d0.retained, [1, 1, 0]);
  const d9 = rel.rows.find((r) => r.key === '2026-03-10')!;
  assert.deepEqual(d9.base, [1, 0, 0]);
  assert.deepEqual(d9.retained, [0, null, null]);
  const cal = buildCohorts(evs, { period: 'day', asOf, cohortEvent: 'signup', periods: 3, returnEvents: ['use'] });
  assert.equal(cal.rows[0]!.retained[1], 2);
  assert.throws(() => buildCohorts(evs, { period: 'month', asOf, align: 'relative' }), /day or week/);
});

test('events after asOf, before the defining event, and with bad data are ignored or counted', () => {
  const evs: Event[] = [
    ...FIX,
    ev('a', 'use', 40), // after asOf
    ev('f', 'use', 1), ev('f', 'signup', 8), // use before signup does not make a week-0 return, nor an earlier cohort
    { who: '', name: 'use', at: at(1), props: {} },
    { who: 'g', name: 'use', at: NaN, props: {} },
    { who: 'g', name: 'use', at: -5, props: {} },
  ];
  const t = buildCohorts(evs, { ...W, cohortEvent: 'signup', periods: 4 });
  assert.deepEqual(t.skipped, { badTime: 2, noUser: 1 });
  assert.equal(t.people, 6);
  assert.deepEqual(t.rows[0]!.retained, [3, 2, 1, 1]);
  const f = t.rows.find((r) => r.key === '2026-03-09')!;
  assert.equal(f.size, 3);
});

test('a Columns object can be reused for several questions with the same answers', () => {
  const cols = Columns.from(FIX);
  assert.equal(cols.length, 10);
  assert.deepEqual(cols.users, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(buildCohorts(cols, { ...W, cohortEvent: 'signup' }), buildCohorts(FIX, { ...W, cohortEvent: 'signup' }));
  assert.equal(growthAccounting(cols, W).length, 4);
});

test('bad options are refused', () => {
  assert.throws(() => buildCohorts(FIX, { ...W, periods: 0 }), /periods/);
  assert.throws(() => buildCohorts(FIX, { ...W, periods: 400 }), /periods/);
  assert.throws(() => buildCohorts(FIX, { ...W, asOf: NaN }), /asOf/);
  assert.deepEqual(buildCohorts([], { ...W }).rows, []);
});

test('growth accounting splits each period into new, kept, back, and gone', () => {
  const g = growthAccounting(FIX, W);
  assert.deepEqual(g.map((r) => [r.active, r.new, r.retained, r.resurrected, r.churned]), [[3, 3, 0, 0, 0], [4, 2, 2, 0, 1], [2, 0, 2, 0, 2], [1, 0, 0, 1, 2]]);
  assert.deepEqual(g.map((r) => r.churnRate), [null, 1 / 3, 0.5, 1]);
  assert.deepEqual(g.map((r) => r.quickRatio), [null, 2, 0, 0.5]);
  assert.equal(label(g[0]!.period, W), '2026-03-02');
  assert.deepEqual(growthAccounting([], W), []);
});

test('inactivity churn names who has gone quiet and does not judge newcomers', () => {
  const evs = [...FIX, ev('f', 'signup', 27)];
  const c = inactivityChurn(evs, { asOf: ASOF, inactiveDays: 14 });
  assert.deepEqual(c.churned, ['b', 'e']);
  assert.equal(c.everSeen, 6);
  assert.equal(c.eligible, 5);
  assert.equal(c.rate, 0.4);
  assert.throws(() => inactivityChurn(FIX, { asOf: ASOF, inactiveDays: 0 }), /at least 1 day/);
  assert.deepEqual(inactivityChurn(FIX, { asOf: ASOF, inactiveDays: 14, activeEvents: ['use'] }).churned, ['b', 'e'].filter((x) => x === 'b'));
});

test('survival treats people still active as censored, not as survivors', () => {
  const s = survival(FIX, { asOf: ASOF, inactiveDays: 14, days: 30 });
  assert.deepEqual([s[0]!.atRisk, s[0]!.churned, s[0]!.survival], [5, 1, 0.8]);
  assert.equal(s[8]!.survival, 0.8);
  assert.deepEqual([s[9]!.atRisk, s[9]!.churned], [4, 1]);
  assert.ok(Math.abs(s[9]!.survival - 0.6) < 1e-12);
  assert.ok(Math.abs(s[30]!.survival - 0.6) < 1e-12);
  assert.equal(s[30]!.atRisk, 0);
  assert.throws(() => survival(FIX, { asOf: ASOF, inactiveDays: 14, days: 0 }), /days/);
});

test('formatTable gives one readable line per cohort', () => {
  const lines = formatTable(buildCohorts(FIX, { ...W, cohortEvent: 'signup', periods: 4 }));
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^2026-03-02\s+3\s+100%\s+67%\s+33%\s+33%/);
  assert.match(lines[1]!, /^2026-03-09\s+2\s+100%\s+50%\s+0%\s+\./);
});
