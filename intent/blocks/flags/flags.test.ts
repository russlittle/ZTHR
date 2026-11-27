import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Flags, bucket, evaluate } from './index.ts';

const people = Array.from({ length: 10_000 }, (_, i) => ({ id: `p${i}` }));

test('a percentage rollout is stable, close to its share, and raising it only adds people', () => {
  const at = (percent: number) => new Set(people.filter((p) => evaluate({ key: 'new-upload', description: '', owner: 'ana', on: true, rules: [{ percent }] }, p).on).map((p) => p.id));
  const ten = at(10);
  const twenty = at(20);
  assert.ok(Math.abs(ten.size - 1000) < 150, `about 10%: ${ten.size}`);
  assert.ok([...ten].every((id) => twenty.has(id)), 'everyone at 10% is still in at 20%');
  assert.deepEqual(at(10), ten, 'the same people every time');
  assert.notEqual(bucket('a', 'p1'), bucket('b', 'p1'), 'independent between flags');
});

test('rules for people, groups and attributes; a kill switch wins; each answer says why', () => {
  const f = new Flags([{ key: 'beta', description: 'beta tools', owner: 'ana', on: true, rules: [{ people: ['ana'] }, { groups: ['staff'], attrs: { region: ['us'] } }], removeBy: '2026-12-31' }]);
  assert.equal(f.explain('beta', { id: 'ana' }).because, 'rule 1');
  assert.equal(f.isOn('beta', { id: 'ben', groups: ['staff'], attrs: { region: 'us' } }), true);
  assert.equal(f.isOn('beta', { id: 'ben', groups: ['staff'], attrs: { region: 'eu' } }), false);
  assert.equal(f.explain('beta', { id: 'cy' }).because, 'no rule reaches them');
  f.kill('beta');
  assert.deepEqual(f.explain('beta', { id: 'ana' }), { on: false, because: 'switched off for everyone' });
  assert.equal(f.explain('nope', { id: 'ana' }).because, 'no such flag');
  f.set({ key: 'old', description: '', owner: 'ben', on: true });
  assert.deepEqual(f.stale('2027-01-15').map((x) => x.key), ['beta', 'old']);
  assert.deepEqual(f.stale('2026-11-26').map((x) => x.key), ['old'], 'a flag with no removal date is always listed');
});
