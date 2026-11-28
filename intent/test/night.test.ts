import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checker, judge, PRICES, route, usd, type Perf } from '../src/console/crew.ts';
import { certificate, limits, westernElectric } from '../src/console/lab.ts';
import { BENEATH, DEPARTMENTS, LINE, lineBar, nextDept } from '../src/console/line.ts';
import { costPerAccepted, emptyNight, headline, nightBody, parseNight, performance, queue, report, scoreLight, status, tagToFix, type Night } from '../src/console/night.ts';

const night = (over: Partial<Night> = {}): Night => ({ ...emptyNight(), ...over });
const proven = (model: string, kind: Perf['kind'] = 'kill-mutant'): Perf => ({ model, kind, attempts: 10, accepted: 9, usd: 0.1 });

test('the router gives a task the cheapest model allowed, on trial until one is proven', () => {
  const r = route({ kind: 'kill-mutant' });
  assert.equal(r.to, 'model');
  assert.equal(r.to === 'model' && r.model.key, 'gpt-oss-120b');
  assert.equal(r.to === 'model' && r.standing, 'on trial');
  const p = route({ kind: 'kill-mutant', perf: [proven('deepseek-v4.1-flash')] });
  assert.equal(p.to === 'model' && p.model.key, 'deepseek-v4.1-flash', 'a proven model beats a cheaper one on trial');
  assert.equal(p.to === 'model' && p.standing, 'proven');
});

test('planted: a model below the bar for a kind is left out of that kind', () => {
  const bad: Perf = { model: 'gpt-oss-120b', kind: 'kill-mutant', attempts: 10, accepted: 2, usd: 0.05 };
  const r = route({ kind: 'kill-mutant', perf: [bad] });
  assert.notEqual(r.to === 'model' && r.model.key, 'gpt-oss-120b');
  const other = route({ kind: 'fix-bug', perf: [bad] });
  assert.equal(other.to === 'model' && other.model.key, 'gpt-oss-120b', 'only for the kind it failed at');
});

test('a failure moves the task a tier up; past the top it goes to a person', () => {
  const up = route({ kind: 'fix-bug', failed: ['haiku-5.5'] });
  assert.equal(up.to === 'model' && up.model.tier, 'escalation');
  const top = route({ kind: 'fix-bug', failed: ['sonnet-5.5'] });
  assert.equal(top.to === 'model' && top.model.key, 'opus-5.5');
  assert.equal(route({ kind: 'fix-bug', failed: ['opus-5.5'] }).to, 'person');
  assert.equal(route({ kind: 'renew' }).to === 'model' && (route({ kind: 'renew' }) as { model: { tier: string } }).model.tier, 'escalation', 'a kind starts at its own lowest tier');
});

test('a task the day’s budget cannot cover is held, never skipped', () => {
  const r = route({ kind: 'investigate', spentToday: 0.99, dailyUSD: 1 });
  assert.equal(r.to, 'held');
  assert.equal(route({ kind: 'kill-mutant', spentToday: 0, dailyUSD: 1 }).to, 'model');
});

test('the check and the ruling always come from another family', () => {
  for (const m of PRICES.models) {
    const c = checker(m.key);
    assert.ok(c.to === 'model' && c.model.family !== m.family, `check on ${m.key}`);
    const j = judge(m.key);
    assert.ok(j.to === 'model' && j.model.family !== m.family, `ruling on ${m.key}`);
  }
  assert.equal(judge('gpt-oss-120b').to === 'model' && (judge('gpt-oss-120b') as { model: { key: string } }).model.key, 'opus-5.5', 'the judgment tier when its family differs');
});

test('a long-context request is charged at the long rate on every token', () => {
  const h = PRICES.models.find((m) => m.key === 'haiku-5.5')!.price;
  assert.equal(usd(h, { in: 100_000, out: 1_000 }), (100_000 * 0.1 + 1_000 * 0.5) / 1e6);
  assert.equal(usd(h, { in: 200_000, out: 1_000 }), (200_000 * 0.5 + 1_000 * 2.5) / 1e6);
  assert.match(PRICES.checked, /^\d{4}-\d{2}-\d{2}$/, 'the table is dated');
});

test('before any shift, the night shift says so and invents nothing', () => {
  const n = emptyNight();
  assert.equal(status(n), 'No shift has run yet: the crew’s runner is not live yet.');
  assert.match(headline(n), /No shift has run yet/);
  assert.match(report(n), /No shift has run yet/);
  assert.equal(costPerAccepted(n), null);
  assert.equal(tagToFix(n), null);
  assert.doesNotMatch(nightBody(n), /\$0\.00 per accepted/);
  assert.equal(parseNight({ schema: 'other' }), null);
  assert.equal(parseNight(null), null);
});

test('the readings come from the records: queue by kind, pass rates, cost per accepted change, tag to fix', () => {
  const n = night({
    tags: [
      { id: 't1', raisedBy: 'metrology', station: 'gauges', where: 'a', what: 'w', evidence: 'e', proof: 'p', state: 'fixed', raisedAt: '2026-11-27T00:00:00Z', closedAt: '2026-11-27T10:00:00Z' },
      { id: 't2', raisedBy: 'qa', station: 'scrap', where: 'a', what: 'w', evidence: 'e', proof: 'p', state: 'open', raisedAt: '2026-11-27T00:00:00Z' },
    ],
    tasks: [
      { id: 'a', tag: 't1', kind: 'kill-mutant', state: 'accepted', model: 'haiku-5.5', usd: 0.02 },
      { id: 'b', tag: 't1', kind: 'kill-mutant', state: 'rejected', model: 'gpt-oss-120b', usd: 0.01 },
      { id: 'c', tag: 't2', kind: 'reproduce', state: 'queued' },
    ],
  });
  assert.equal(queue(n).find((q) => q.kind === 'reproduce')!.queued, 1);
  assert.deepEqual(performance(n).map((p) => [p.model, p.accepted, p.attempts]), [['gpt-oss-120b', 0, 1], ['haiku-5.5', 1, 1]]);
  assert.equal(costPerAccepted(n), 0.03, 'failures are part of what a fix costs');
  assert.equal(tagToFix(n), 10);
});

test('a block holds when only recorded equivalents survive, fails below its floor, and otherwise waits for the crew', () => {
  const s = { block: 'b', at: '', score: 90, killed: 9, survived: 1, equivalent: 0, floor: 80 };
  assert.equal(scoreLight(s), 'waiting');
  assert.equal(scoreLight({ ...s, survived: 0 }), 'pass');
  assert.equal(scoreLight({ ...s, score: 70 }), 'fail');
  assert.equal(scoreLight({ ...s, score: null }), 'not measured');
});

test('a gauge is certified only when capable, repeatable and reproducible', () => {
  const s = { block: 'b', at: '2026-11-27', score: 80, killed: 8, survived: 2, equivalent: 1, floor: null };
  assert.equal(certificate('b', undefined).state, 'not measured');
  assert.equal(certificate('b', s).state, 'not certified');
  assert.equal(certificate('b', { ...s, equivalent: 2 }).state, 'capability only', 'R&R not measured is not certified');
  assert.equal(certificate('b', { ...s, equivalent: 2 }, { repeatability: 0, reproducible: true }).state, 'certified');
  assert.equal(certificate('b', { ...s, equivalent: 2 }, { repeatability: 1.5, reproducible: true }).state, 'not certified', 'a flaky gauge is not certified');
});

test('control charts: limits from the moving range, drift read by the Western Electric rules', () => {
  const steady = [10, 11, 10, 9, 10, 11, 10, 9, 10, 11];
  const l = limits(steady)!;
  assert.equal(l.centre, 10.1);
  assert.deepEqual(westernElectric(steady, l), []);
  assert.deepEqual(westernElectric([...steady, 30], l).map((x) => x.rule), [1]);
  { const sh = westernElectric([...steady, 12, 12, 12, 12, 12, 12, 12, 12], l); assert.ok(sh.length > 0 && sh.every((x) => x.rule !== 1), 'a shift is seen before any point leaves the limits'); }
  assert.equal(limits([1]), null);
});

test('metrology and maintenance sit beneath the line: unnumbered, no handoff, listed in every enumeration', () => {
  assert.deepEqual(BENEATH.map((d) => d.key), ['metrology', 'maintenance']);
  assert.equal(LINE.length + BENEATH.length, DEPARTMENTS.length);
  assert.equal(nextDept('fleet'), null, 'the line ends at the fleet');
  assert.equal(nextDept('maintenance'), null);
  const bar = lineBar('maintenance');
  assert.match(bar, /<ol class="zline">(?:(?!maintenance).)*<\/ol><p class="zl-beneath">.*href="\/metrology".*href="\/maintenance" aria-current="page"/s);
  assert.doesNotMatch(bar, /zl-n" aria-hidden="true">9</, 'nothing beneath the line is numbered');
});

test('planted: hostile text in a record is escaped', () => {
  const n = night({ shifts: [{ id: 's', startedAt: '2026-11-27T01:00:00Z', endedAt: null, budgetUSD: 1, spentUSD: 0, fixed: [{ tag: 'x', task: 'y', evidence: '<img src=x onerror=alert(1)>' }], escalated: [], raised: [] }] });
  assert.doesNotMatch(report(n), /<img/);
});
