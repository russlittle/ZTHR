import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Incidents, alerts, budget, burnRate } from './index.ts';

const o = { name: 'requests succeed', target: 0.999, windowDays: 30 };

test('error budget and burn rate', () => {
  assert.deepEqual(budget(o, { good: 999_500, total: 1_000_000 }), { allowedBad: 1000.0000000000009, bad: 500, remaining: 500.0000000000009, spent: 0.49999999999999956 });
  assert.ok(Math.abs(burnRate(o, { good: 98_560, total: 100_000 }) - 14.4) < 1e-6);
  assert.equal(burnRate(o, { good: 0, total: 0 }), 0);
});

test('a short blip does not page; an outage seen in both windows does', () => {
  const ok = { good: 100_000, total: 100_000 };
  const bad = { good: 90_000, total: 100_000 };
  assert.deepEqual(alerts(o, { '1h': ok, '5m': bad }), [], 'the 5-minute spike alone is not enough');
  const a = alerts(o, { '1h': bad, '5m': bad, '6h': bad, '30m': bad });
  assert.deepEqual(a.map((x) => x.severity), ['page', 'page']);
  assert.match(a[0]!.because, /burning 100\.0x over 1h/);
  assert.deepEqual(alerts(o, { '3d': { good: 99_850, total: 100_000 }, '6h': { good: 99_800, total: 100_000 } }).map((x) => x.severity), ['ticket']);
});

test('incidents keep a timeline, show only public notes, and are owed a postmortem with owned actions', () => {
  let t = Date.parse('2026-11-26T10:00:00Z');
  const inc = new Incidents(() => new Date(t));
  const i = inc.open('Uploads failing', 1, 'We are looking into failed uploads.');
  t += 20 * 60_000;
  inc.update(i.id, 'identified', 'bad deploy 4c1e, rolling back', 'We found the cause and are fixing it.');
  t += 25 * 60_000;
  inc.update(i.id, 'resolved', 'rolled back', 'Uploads are working again.');
  assert.equal(inc.duration(i), 45);
  assert.throws(() => inc.update(i.id, 'monitoring', 'x'), /resolved/);
  assert.equal(JSON.stringify(inc.publicView()).includes('4c1e'), false, 'internal notes stay internal');
  assert.equal(inc.publicView()[0]!.updates.length, 3);
  assert.deepEqual(inc.owed().map((x) => x.id), [1]);
  assert.throws(() => inc.postmortem(i.id, { cause: 'x', impact: '', detection: 'alert', actions: [{ what: 'canary', owner: '', due: '2026-12-10' }] }), /the impact, an owner for "canary"/);
  inc.postmortem(i.id, { cause: 'a config change skipped the canary', impact: '45 minutes of failed uploads for 12% of people', detection: 'burn-rate page after 4 minutes', actions: [{ what: 'canary every deploy', owner: 'ana', due: '2026-12-10' }] });
  assert.deepEqual(inc.owed(), []);
});
