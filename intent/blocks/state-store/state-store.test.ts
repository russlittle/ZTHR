import test from 'node:test';
import assert from 'node:assert/strict';
import { StateMachine, StateError, Timeseries, History, statistics, domainOf, MAX_STATE, type State } from './index.ts';
import { Hub } from '../events/index.ts';

const H = 3_600_000;
let t = 10 * H;
const mk = () => new StateMachine({ now: () => t });
test.beforeEach(() => { t = 10 * H; });

test('setting a new entity creates it with all three times equal', () => {
  const m = mk();
  const r = m.set('sensor.kitchen_temp', '21.5', { unit: 'C' });
  assert.equal(r.changed, true);
  assert.deepEqual({ ...r.state }, { entityId: 'sensor.kitchen_temp', state: '21.5', attributes: { unit: 'C' }, lastChanged: t, lastUpdated: t, lastReported: t });
  assert.equal(m.get('sensor.kitchen_temp')!.state, '21.5');
  assert.equal(m.count(), 1);
});

test('the same state and attributes again moves only last_reported and publishes nothing', () => {
  const m = mk();
  m.set('light.hall', 'on');
  const seen: unknown[] = [];
  m.hub.subscribe(() => true, (e) => seen.push(e));
  t += 5000;
  const r = m.set('light.hall', 'on');
  assert.equal(r.changed, false);
  assert.equal(r.updated, false);
  const s = m.get('light.hall')!;
  assert.equal(s.lastReported, t);
  assert.equal(s.lastUpdated, t - 5000);
  assert.equal(s.lastChanged, t - 5000);
  assert.equal(seen.length, 0);
});

test('an attribute-only change moves last_updated, keeps last_changed, and publishes', () => {
  const m = mk();
  m.set('light.hall', 'on', { brightness: 100 });
  t += 1000;
  const r = m.set('light.hall', 'on', { brightness: 50 });
  assert.equal(r.changed, false);
  assert.equal(r.updated, true);
  assert.equal(r.state.lastChanged, t - 1000);
  assert.equal(r.state.lastUpdated, t);
  assert.equal(m.history.size('light.hall'), 2);
});

test('a state change moves last_changed and the old state travels in the event', () => {
  const m = mk();
  const got: { old?: State; next: State }[] = [];
  m.onChange('light.hall', (e) => got.push(e));
  m.set('light.hall', 'off');
  t += 1000;
  m.set('light.hall', 'on');
  assert.equal(got.length, 2);
  assert.equal(got[0]!.old, undefined);
  assert.equal(got[1]!.old!.state, 'off');
  assert.equal(got[1]!.next.lastChanged, t);
});

test('events are CloudEvents on the hub with the entity as subject and the clock as time', () => {
  const m = mk();
  const evs: { type: string; subject?: string; time: string; specversion: string }[] = [];
  m.hub.subscribe(() => true, (e) => evs.push(e));
  m.set('switch.pump', 'on');
  m.remove('switch.pump');
  assert.deepEqual(evs.map((e) => e.type), ['state.changed', 'state.removed']);
  assert.equal(evs[0]!.subject, 'switch.pump');
  assert.equal(evs[0]!.time, new Date(t).toISOString());
  assert.equal(evs[0]!.specversion, '1.0');
});

test('a shared hub receives the events, and domain filters pick the right ones', () => {
  const hub = new Hub();
  const m = new StateMachine({ now: () => t, hub });
  const seen: string[] = [];
  const stop = m.onChange('sensor.*', (e) => seen.push(e.entityId));
  m.set('sensor.a', '1');
  m.set('light.b', 'on');
  m.set('sensor.c', '2');
  stop();
  m.set('sensor.d', '3');
  assert.deepEqual(seen, ['sensor.a', 'sensor.c']);
  assert.equal(m.hub, hub);
  const fn: string[] = [];
  m.onChange((s) => s.state === 'on', (e) => fn.push(e.entityId));
  m.set('light.e', 'on');
  assert.deepEqual(fn, ['light.e']);
});

test('entity ids, state length and attribute size are checked', () => {
  const m = mk();
  for (const bad of ['Sensor.x', 'sensor', 'sensor.', '.x', 'sensor.x y', 'a.b.c', '1sensor.x']) assert.throws(() => m.set(bad, '1'), StateError, bad);
  assert.throws(() => m.set('sensor.x', 'y'.repeat(MAX_STATE + 1)), /255/);
  assert.doesNotThrow(() => m.set('sensor.x', 'y'.repeat(MAX_STATE)));
  assert.throws(() => m.set('sensor.x', '1', { blob: 'z'.repeat(20000) }), /16 KiB/);
});

test('attributes are copied and frozen, so callers cannot change stored state', () => {
  const m = mk();
  const attrs = { list: [1, 2] };
  m.set('sensor.x', '1', attrs);
  attrs.list.push(3);
  assert.deepEqual(m.get('sensor.x')!.attributes, { list: [1, 2] });
  assert.throws(() => { (m.get('sensor.x')!.attributes as Record<string, unknown>).list = []; }, TypeError);
});

test('attribute order does not matter for "same"', () => {
  const m = mk();
  m.set('sensor.x', '1', { a: 1, b: { c: 1, d: 2 } });
  const r = m.set('sensor.x', '1', { b: { d: 2, c: 1 }, a: 1 });
  assert.equal(r.updated, false);
});

test('force publishes even when nothing differs', () => {
  const m = mk();
  m.set('sensor.x', '1');
  const n: number[] = [];
  m.hub.subscribe(() => true, () => n.push(1));
  m.set('sensor.x', '1', {}, { force: true });
  assert.equal(n.length, 1);
});

test('all, is, count, domainOf and remove', () => {
  const m = mk();
  m.set('light.b', 'on');
  m.set('light.a', 'off');
  m.set('sensor.t', '3');
  assert.deepEqual(m.all('light').map((s) => s.entityId), ['light.a', 'light.b']);
  assert.equal(m.count('sensor'), 1);
  assert.equal(m.is('light.a', 'off', 'unavailable'), true);
  assert.equal(m.is('light.zzz', 'on'), false);
  assert.equal(domainOf('light.a'), 'light');
  assert.equal(m.remove('light.a'), true);
  assert.equal(m.remove('light.a'), false);
  assert.equal(m.get('light.a'), undefined);
});

test('history records changes and answers "what was it at time T"', () => {
  const m = mk();
  m.set('sensor.x', '1');
  t += H;
  m.set('sensor.x', '2');
  t += H;
  m.set('sensor.x', '3');
  assert.equal(m.history.at('sensor.x', 10 * H + 30 * 60_000)!.state, '1');
  assert.equal(m.history.at('sensor.x', 11 * H)!.state, '2');
  assert.equal(m.history.at('sensor.x', 5 * H), undefined);
  assert.equal(m.history.get('sensor.x', 11 * H, 12 * H).length, 1);
});

test('compaction keeps recent detail, thins the middle to one per bucket, and drops the old', () => {
  const h = new History();
  const now = 100 * H;
  // 6 points an hour apart-ish, spread: two per hour for hours 0..4 (old), then recent ones
  for (let hr = 0; hr < 5; hr++) for (const m of [10, 40]) h.record('sensor.x', { t: hr * H + m * 60_000, state: `${hr}:${m}`, attributes: {} });
  h.record('sensor.x', { t: 98 * H + 5, state: 'mid-a', attributes: {} });
  h.record('sensor.x', { t: 98 * H + 20 * 60_000, state: 'mid-b', attributes: {} });
  for (const m of [3, 2, 1]) h.record('sensor.x', { t: now - m * 60_000, state: `recent${m}`, attributes: {} });
  const removed = h.compact(now, { fullFor: H, bucket: H, keepFor: 10 * H });
  const states = h.get('sensor.x').map((p) => p.state);
  assert.deepEqual(states, ['mid-b', 'recent3', 'recent2', 'recent1']);
  assert.equal(removed, 11);
  assert.equal(h.size('sensor.x'), 4);
});

test('compaction rejects a policy that does not make sense and removes empty entities', () => {
  const h = new History();
  h.record('a.b', { t: 0, state: '1', attributes: {} });
  assert.throws(() => h.compact(1000, { fullFor: 10, bucket: 0, keepFor: 20 }), StateError);
  assert.throws(() => h.compact(1000, { fullFor: 30, bucket: 5, keepFor: 20 }), StateError);
  assert.equal(h.compact(10 * H, { fullFor: 1, bucket: 1, keepFor: 5 }), 1);
  assert.equal(h.size(), 0);
});

test('state machine compaction uses its own clock', () => {
  const m = mk();
  m.set('sensor.x', '1');
  t += 100 * H;
  m.set('sensor.x', '2');
  assert.equal(m.compact({ fullFor: H, bucket: H, keepFor: 50 * H }), 1);
  assert.deepEqual(m.history.get('sensor.x').map((p) => p.state), ['2']);
});

test('statistics: min, max, count, last and time-weighted mean per bucket', () => {
  const pts = [
    { t: 0, state: '10', attributes: {} },
    { t: 15 * 60_000, state: '20', attributes: {} },
    { t: 75 * 60_000, state: '40', attributes: {} },
  ];
  const b = statistics(pts, { from: 0, to: 2 * H, width: H });
  assert.equal(b.length, 2);
  assert.deepEqual({ ...b[0]! }, { start: 0, min: 10, max: 20, mean: (10 * 15 + 20 * 45) / 60, last: 20, count: 2 });
  assert.equal(b[1]!.start, H);
  assert.equal(b[1]!.min, 20);
  assert.equal(b[1]!.max, 40);
  assert.equal(b[1]!.last, 40);
  assert.equal(b[1]!.mean, (20 * 15 + 40 * 45) / 60);
});

test('statistics skip non-numeric states and need a sane range', () => {
  const pts = [{ t: 0, state: '5', attributes: {} }, { t: 1000, state: 'unavailable', attributes: {} }, { t: 2000, state: '7', attributes: {} }, { t: 3000, state: '', attributes: {} }];
  const b = statistics(pts, { from: 0, to: H, width: H });
  assert.equal(b[0]!.count, 2);
  assert.equal(b[0]!.min, 5);
  assert.equal(b[0]!.max, 7);
  assert.throws(() => statistics(pts, { from: 5, to: 5, width: 1 }), StateError);
  assert.throws(() => statistics(pts, { from: 0, to: 5, width: 0 }), StateError);
});

test('total_increasing sums growth and survives a meter reset', () => {
  const pts = ['100', '110', '125', '3', '10'].map((state, i) => ({ t: i * 10 * 60_000, state, attributes: {} }));
  const b = statistics(pts, { from: 0, to: H, width: H, kind: 'total_increasing' });
  // 0 + 10 + 15 + (reset: 3) + 7
  assert.equal(b[0]!.sum, 35);
  assert.equal(statistics(pts, { from: 0, to: H, width: H })[0]!.sum, undefined);
});

test('state machine statistics include the value held from before the range', () => {
  const m = mk();
  m.set('sensor.x', '10');
  t += 2 * H;
  m.set('sensor.x', '30');
  const b = m.statistics('sensor.x', { from: 11 * H, to: 13 * H, width: H });
  assert.equal(b[0]!.start, 11 * H);
  assert.equal(b[0]!.mean, 10);
  assert.equal(b[1]!.mean, 30);
});

test('timeseries keeps order, downsamples to bucket ends, and gives a rate per second', () => {
  const s = new Timeseries();
  s.add(3000, 3);
  s.add(1000, 1);
  s.add(2000, 2);
  s.add(70_000, 9);
  assert.deepEqual(s.points().map((p) => p.t), [1000, 2000, 3000, 70_000]);
  assert.deepEqual(s.downsample(60_000), [{ t: 0, v: 3 }, { t: 60_000, v: 9 }]);
  assert.equal(s.rate(0, 4000), 1);
  assert.equal(s.rate(0, 1500), undefined);
  assert.throws(() => s.add(NaN, 1), StateError);
  assert.throws(() => s.downsample(0), StateError);
  assert.equal(s.length, 4);
});

test('series() builds a numeric series from history, skipping non-numbers', () => {
  const m = mk();
  m.set('sensor.x', '1');
  t += 1000;
  m.set('sensor.x', 'unknown');
  t += 1000;
  m.set('sensor.x', '3');
  assert.deepEqual(m.series('sensor.x').points().map((p) => p.v), [1, 3]);
});

test('a subscriber that throws does not stop the state being set', () => {
  const m = mk();
  m.onChange('sensor.*', () => { throw new Error('boom'); });
  assert.doesNotThrow(() => m.set('sensor.x', '1'));
  assert.equal(m.get('sensor.x')!.state, '1');
});
