import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Audit, canonical, memoryAudit } from './index.ts';

test('entries chain, and the whole chain verifies', async () => {
  const s = memoryAudit();
  const a = new Audit(s, { now: () => new Date('2026-11-26T12:00:00Z') });
  await a.record({ actor: 'ana', action: 'update', target: 'student/7', detail: { field: 'phone' } });
  await a.read('ben', 'student/7', 'health', 'reviewing an accommodation');
  await a.record({ actor: 'admin', onBehalfOf: 'cy', action: 'delete', target: 'note/3', reason: 'acting as cy to reproduce a ticket' });
  assert.equal(s.entries[1]!.prev, s.entries[0]!.hash);
  assert.equal(await a.verify(), null);
  assert.deepEqual((await a.about({ target: 'student/7' })).map((e) => e.action), ['update', 'read']);
  assert.equal((await a.about({ actor: 'cy' })).length, 1, 'acting for someone shows in their history');
});

test('changing, removing or reordering any entry is found, at the entry where it happened', async () => {
  const s = memoryAudit();
  const a = new Audit(s);
  for (let i = 0; i < 5; i++) await a.record({ actor: 'ana', action: 'update', target: `r/${i}` });
  const head = await a.head();
  const original = [...s.entries];
  s.entries[2] = { ...s.entries[2]!, actor: 'mallory' };
  assert.deepEqual(await a.verify(), { at: 3, why: 'its content was changed after it was written' });
  s.entries.splice(0, s.entries.length, ...original.filter((e) => e.n !== 3));
  assert.deepEqual(await a.verify(), { at: 4, why: 'entry 3 is missing' });
  s.entries.splice(0, s.entries.length, ...original.slice(0, 3));
  assert.match((await a.verify(head))!.why, /published head is entry 5/, 'cutting the tail is caught by the published head');
});

test('entries written at the same moment are chained in order, never forked', async () => {
  const s = memoryAudit();
  const a = new Audit(s);
  await Promise.all(Array.from({ length: 30 }, (_, i) => a.record({ actor: 'x', action: 'read', target: String(i) })));
  assert.deepEqual(s.entries.map((e) => e.n), Array.from({ length: 30 }, (_, i) => i + 1));
  assert.equal(await a.verify(), null);
  assert.equal(canonical({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});
