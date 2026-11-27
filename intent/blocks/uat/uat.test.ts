import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Uat } from './index.ts';

test('overrides apply to the tester alone, end on their own, show on a banner and are recorded', () => {
  let t = Date.parse('2026-11-26T10:00:00Z');
  const u = new Uat({ env: 'staging', now: () => t });
  u.set('ana', { kind: 'flag', flag: 'new-upload', on: true }, 'checking the new upload flow', 30);
  u.set('ana', { kind: 'clock', at: '2026-12-31T23:00:00Z' }, 'what happens after the trial ends');
  u.set('ana', { kind: 'role', role: 'viewer' }, 'can a viewer see the share button?');
  assert.equal(u.flag('ana', 'new-upload'), true);
  assert.equal(u.flag('ben', 'new-upload'), undefined, 'nobody else is affected');
  assert.equal(u.clock('ana').toISOString(), '2026-12-31T23:00:00.000Z');
  assert.equal(u.clock('ben').toISOString(), '2026-11-26T10:00:00.000Z');
  assert.equal(u.role('ana', 'admin'), 'viewer');
  assert.equal(u.banner('ana'), 'Test overrides on: new-upload on; clock set to 2026-12-31T23:00:00Z; acting as viewer. The first ends in 30 minutes.');
  t += 31 * 60_000;
  assert.equal(u.flag('ana', 'new-upload'), undefined, 'ended on its own');
  u.clear('ana');
  assert.equal(u.banner('ana'), undefined);
  assert.equal(u.log.length, 3);
});

test('production refuses every override; reasons, limits and roles are checked', () => {
  const prod = new Uat({ env: 'production' });
  assert.throws(() => prod.set('ana', { kind: 'flag', flag: 'x', on: true }, 'just testing in prod'), /not available in production/);
  const u = new Uat({ env: 'uat' });
  assert.throws(() => u.set('ana', { kind: 'role', role: 'admin' }, 'need admin for a bit'), /cannot be taken on/);
  assert.throws(() => u.set('ana', { kind: 'flag', flag: 'x', on: true }, 'x'), /say why/);
  assert.throws(() => u.set('ana', { kind: 'flag', flag: 'x', on: true }, 'all week long please', 60 * 24 * 7), /working day/);
  assert.throws(() => u.set('ana', { kind: 'clock', at: 'next tuesday' }, 'clock needs a time'), /date and time/);
  u.set('ana', { kind: 'flag', flag: 'x', on: true }, 'first setting of x');
  u.set('ana', { kind: 'flag', flag: 'x', on: false }, 'second setting of x');
  assert.equal(u.flag('ana', 'x'), false, 'a new override replaces the old one');
});

test('production is refused however it is spelled, and so is any environment not known to be a test one', () => {
  for (const env of ['prod', 'Production', ' production ', 'PRD', 'live', 'prod-eu']) {
    assert.throws(() => new Uat({ env }).set('ana', { kind: 'flag', flag: 'x', on: true }, 'checking the flag'), /not available/, env);
  }
  assert.equal(new Uat({ env: 'QA' }).set('ana', { kind: 'flag', flag: 'x', on: true }, 'checking the flag').who, 'ana');
  assert.equal(new Uat({ env: 'demo', testEnvs: ['demo'] }).set('ana', { kind: 'flag', flag: 'x', on: true }, 'checking the flag').who, 'ana');
});

test('an override needs a real, positive length of time', () => {
  const u = new Uat({ env: 'uat' });
  for (const m of [Number.NaN, 0, -5]) assert.throws(() => u.set('ana', { kind: 'flag', flag: 'x', on: true }, 'checking the flag', m), /minutes/, String(m));
});
