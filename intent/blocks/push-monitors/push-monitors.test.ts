import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from '../watchdog/index.ts';
import { AlertTracker, PushMonitorError, accept, asWatchdog, evaluate, nextCron, nextDue, parseCron, parsePingPath, pingToken, pingUrl, tokenValid, validate } from './index.ts';
import type { PushMonitor } from './index.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 5, 0, 0, 0); // a Monday
const key = 'unit-test-ping-signing-key';
const every = (n: number, over: Partial<PushMonitor> = {}): PushMonitor => ({ id: 'backup', schedule: { everyMin: n }, graceMin: 5, created: T0, tokenVersion: 1, ...over });
const at = (s: string) => Date.parse(s);

test('cron: lists, ranges, steps and names give the next matching minute', () => {
  assert.equal(nextCron(parseCron('*/15 * * * *'), at('2026-01-05T10:07:30Z')), at('2026-01-05T10:15:00Z'));
  assert.equal(nextCron(parseCron('0 9 * * mon-fri'), at('2026-01-09T09:00:00Z')), at('2026-01-12T09:00:00Z'), 'Friday 09:00 passed, next is Monday');
  assert.equal(nextCron(parseCron('30 2 1 jan,jul *'), at('2026-01-01T02:30:00Z')), at('2026-07-01T02:30:00Z'));
  assert.equal(nextCron(parseCron('5-10/2 0 * * *'), at('2026-01-05T00:05:00Z')), at('2026-01-05T00:07:00Z'));
  assert.equal(nextCron(parseCron('0 0 * * 7'), at('2026-01-05T00:00:00Z')), at('2026-01-11T00:00:00Z'), 'day 7 is Sunday');
});

test('cron: when both day fields are restricted, either may match', () => {
  const c = parseCron('0 0 13 * fri');
  assert.equal(nextCron(c, at('2026-02-01T00:00:00Z')), at('2026-02-06T00:00:00Z'), 'the first Friday');
  assert.equal(nextCron(c, at('2026-02-12T12:00:00Z')), at('2026-02-13T00:00:00Z'));
});

test('cron: leap day and impossible dates', () => {
  assert.equal(nextCron(parseCron('0 0 29 2 *'), at('2026-03-01T00:00:00Z')), at('2028-02-29T00:00:00Z'));
  assert.throws(() => nextCron(parseCron('0 0 31 2 *'), T0), /never happens/);
});

test('cron: malformed expressions are refused with a reason', () => {
  for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '*/0 * * * *', '5-1 * * * *', 'a * * * *', '1//2 * * * *', '* * * foo *', '1,,2 * * * *'])
    assert.throws(() => parseCron(bad), PushMonitorError, bad);
});

test('a new monitor waits, is up after a success, late inside grace, down after it', () => {
  const m = every(60);
  assert.equal(evaluate(m, [], T0 + 30 * MIN).state, 'new');
  assert.equal(evaluate(m, [], T0 + 62 * MIN).state, 'late');
  const r = evaluate(m, [], T0 + 66 * MIN);
  assert.equal(r.state, 'down');
  assert.equal(r.missed, 1);
  const up = evaluate(m, [{ at: T0 + 58 * MIN, kind: 'success' }], T0 + 90 * MIN);
  assert.equal(up.state, 'up');
  assert.equal(up.due, T0 + 118 * MIN);
});

test('missed runs are counted, not just noticed', () => {
  const m = every(10, { graceMin: 2 });
  const r = evaluate(m, [{ at: T0, kind: 'success' }], T0 + 55 * MIN);
  assert.equal(r.state, 'down');
  assert.equal(r.missed, 5, 'due at 10, 20, 30, 40, 50 and past grace each time');
  assert.equal(r.detail, '5 expected pings did not arrive');
});

test('a failure ping is failed until the next success', () => {
  const m = every(60);
  assert.equal(evaluate(m, [{ at: T0 + 10 * MIN, kind: 'fail' }], T0 + 20 * MIN).state, 'failed');
  assert.equal(evaluate(m, [{ at: T0 + 10 * MIN, kind: 'fail' }, { at: T0 + 15 * MIN, kind: 'success' }], T0 + 20 * MIN).state, 'up');
});

test('start pings: running, then overlong past maxRun, then up once it ends', () => {
  const m = every(60, { maxRunMin: 10 });
  const start = { at: T0 + 55 * MIN, kind: 'start' as const };
  assert.equal(evaluate(m, [start], T0 + 58 * MIN).state, 'running');
  const long = evaluate(m, [start], T0 + 70 * MIN);
  assert.equal(long.state, 'overlong');
  assert.equal(long.detail, 'started 15 minutes ago; allowed 10');
  assert.equal(evaluate(m, [start, { at: T0 + 60 * MIN, kind: 'success' }], T0 + 61 * MIN).state, 'up');
});

test('pings from the future are ignored and a paused monitor says so', () => {
  const m = every(60);
  assert.equal(evaluate(m, [{ at: T0 + 500 * MIN, kind: 'success' }], T0 + 10 * MIN).state, 'new');
  assert.equal(evaluate({ ...m, paused: true }, [], T0 + 9999 * MIN).state, 'paused');
});

test('cron monitors are due at the schedule, not one period after the last ping', () => {
  const m: PushMonitor = { id: 'nightly', schedule: { cron: '0 3 * * *' }, graceMin: 30, created: at('2026-01-05T12:00:00Z'), tokenVersion: 1 };
  assert.equal(nextDue(m, m.created), at('2026-01-06T03:00:00Z'));
  assert.equal(evaluate(m, [], at('2026-01-06T03:10:00Z')).state, 'late');
  assert.equal(evaluate(m, [], at('2026-01-06T03:31:00Z')).state, 'down');
  const ok = evaluate(m, [{ at: at('2026-01-06T03:04:00Z'), kind: 'success' }], at('2026-01-06T20:00:00Z'));
  assert.equal(ok.state, 'up');
  assert.equal(ok.due, at('2026-01-07T03:00:00Z'));
});

test('alerts fire once per bad spell and once on recovery, and not during pauses', () => {
  const m = every(60);
  const t = new AlertTracker();
  const step = (state: Parameters<AlertTracker['step']>[1]['state'], now = 0) => t.step(m, { state, due: null, missed: 0, lastPing: null, detail: 'd' }, now);
  assert.deepEqual(step('up'), []);
  assert.deepEqual(step('late'), []);
  assert.deepEqual(step('down').map((a) => a.kind), ['down']);
  assert.deepEqual(step('down'), [], 'not again every minute');
  assert.deepEqual(step('failed').map((a) => a.kind), ['failed'], 'a different kind of bad is news');
  assert.deepEqual(step('up').map((a) => a.kind), ['recovered']);
  assert.deepEqual(step('up'), []);
  step('down');
  assert.deepEqual(step('paused'), [], 'pausing is not recovery');
});

test('ping tokens are bound to the monitor and version, and a version bump revokes the old URL', () => {
  const m = every(60);
  const url = pingUrl('https://ping.example.com/', key, m);
  assert.match(url, /^https:\/\/ping\.example\.com\/ping\/backup\/[A-Za-z0-9_-]{32}$/);
  assert.equal(pingUrl('https://p.example', key, m, 'start').endsWith('/start'), true);
  assert.equal(tokenValid(key, m, pingToken(key, m)), true);
  assert.equal(tokenValid(key, { ...m, tokenVersion: 2 }, pingToken(key, m)), false);
  assert.equal(tokenValid(key, { ...m, id: 'other' }, pingToken(key, m)), false);
  assert.equal(tokenValid('another-key', m, pingToken(key, m)), false);
  assert.notEqual(pingToken(key, { id: 'ab', tokenVersion: 11 }), pingToken(key, { id: 'ab1', tokenVersion: 1 }), 'the id and version cannot run together');
});

test('accepting a ping checks the path, the monitor and the token', () => {
  const m = every(60);
  const path = new URL(pingUrl('https://x.example', key, m, 'fail')).pathname;
  assert.deepEqual(accept(key, m, path, 123), { at: 123, kind: 'fail' });
  assert.throws(() => accept(key, { ...m, tokenVersion: 2 }, path, 1), /not valid for this monitor/);
  assert.throws(() => accept(key, { ...m, id: 'zzz' }, path, 1), /not valid for this monitor/);
  for (const bad of ['/ping/backup/short', '/ping/backup/' + 'A'.repeat(32) + '/explode', '/ping/../x/' + 'A'.repeat(32), '/pong/backup/' + 'A'.repeat(32), '/ping/backup/' + 'A'.repeat(32) + '/start/extra'])
    assert.throws(() => parsePingPath(bad), /not a ping address/, bad);
});

test('monitor definitions are validated', () => {
  assert.doesNotThrow(() => validate(every(5)));
  assert.throws(() => validate(every(0)), /everyMin/);
  assert.throws(() => validate(every(1.5)), /everyMin/);
  assert.throws(() => validate(every(5, { id: 'has space' })), /monitor id/);
  assert.throws(() => validate(every(5, { graceMin: -1 })), /grace/);
  assert.throws(() => validate({ ...every(5), schedule: { cron: 'nope' } }), PushMonitorError);
  assert.throws(() => validate(every(5, { maxRunMin: 0 })), /maxRunMin/);
});

test('interval monitors can be checked by the watchdog from the same pings', () => {
  const m = every(10, { graceMin: 2, maxRunMin: 5 });
  const pings = [
    { at: T0 + 1 * MIN, kind: 'start' as const }, { at: T0 + 2 * MIN, kind: 'success' as const },
    { at: T0 + 11 * MIN, kind: 'start' as const }, { at: T0 + 12 * MIN, kind: 'fail' as const },
  ];
  const { job, checkIns } = asWatchdog(m, pings);
  assert.deepEqual(job, { name: 'backup', everyMin: 10, graceMin: 2, maxMin: 5 });
  assert.deepEqual(check([job], checkIns, T0 + 14 * MIN).map((f) => f.problem), ['failed']);
  assert.deepEqual(check([job], checkIns, T0 + 40 * MIN).map((f) => f.problem), ['missed', 'failed']);
  assert.throws(() => asWatchdog({ ...m, schedule: { cron: '* * * * *' } }, []), /only interval/);
});
