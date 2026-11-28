import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('an entry still verifies after a trip through a JSON store, and the caller changing its detail later changes nothing', async () => {
  const s = memoryAudit();
  const a = new Audit(s, { now: () => new Date('2026-11-26T12:00:00Z') });
  const detail: Record<string, unknown> = { when: new Date('2026-01-01T00:00:00Z'), gone: undefined, n: 1 };
  await a.record({ actor: 'ana', action: 'update', target: 'x', detail });
  detail['n'] = 2;
  assert.equal(await a.verify(), null, 'the caller kept a reference to the detail');
  const stored = s.entries.map((e) => JSON.parse(JSON.stringify(e)));
  s.entries.splice(0, s.entries.length, ...stored);
  assert.equal(await a.verify(), null, 'dates and undefined values do not hash differently once stored');
});

test('an empty log has a head of entry 0 and a hash of 64 zeros, and the first entry chains to it', async () => {
  const s = memoryAudit();
  const a = new Audit(s);
  assert.deepEqual(await a.head(), { n: 0, hash: '0'.repeat(64) });
  const first = await a.record({ actor: 'ana', action: 'update', target: 'x' });
  assert.equal(first.prev, '0'.repeat(64));
  assert.equal(first.n, 1);
  assert.deepEqual(await a.head(), { n: 1, hash: first.hash });
  const second = await a.record({ actor: 'ana', action: 'update', target: 'y' });
  assert.deepEqual(await a.head(), { n: 2, hash: second.hash });
});

test('canonical encodes arrays in order, with commas, at any depth', () => {
  assert.equal(canonical([1, 'a', null]), '[1,"a",null]');
  assert.equal(canonical([]), '[]');
  assert.equal(canonical({ z: [{ b: 1, a: [2, 3] }], a: [] }), '{"a":[],"z":[{"a":[2,3],"b":1}]}');
});

test('sensitivity, reason and detail are kept on the entry, and left off when not given', async () => {
  const s = memoryAudit();
  const a = new Audit(s, { now: () => new Date('2026-11-26T12:00:00Z') });
  const r = await a.read('ben', 'student/7', 'health', 'reviewing an accommodation');
  assert.equal(r.action, 'read');
  assert.equal(r.sensitivity, 'health');
  assert.equal(r.reason, 'reviewing an accommodation');
  const bare = await a.read('ben', 'student/8', 'finance');
  assert.equal(bare.sensitivity, 'finance');
  assert.equal('reason' in bare, false);
  const d = await a.record({ actor: 'ana', action: 'update', target: 'x', sensitivity: 'pii', reason: 'fixing a typo', detail: { when: new Date('2026-01-01T00:00:00Z'), gone: undefined, n: 1, list: [1, 2] } });
  assert.equal(d.sensitivity, 'pii');
  assert.equal(d.reason, 'fixing a typo');
  assert.deepEqual(d.detail, { when: '2026-01-01T00:00:00.000Z', n: 1, list: [1, 2] });
  const plain = await a.record({ actor: 'ana', action: 'update', target: 'x' });
  for (const k of ['sensitivity', 'reason', 'detail', 'onBehalfOf']) assert.equal(k in plain, false, k);
  assert.equal(s.entries[2]!.detail!['n'], 1);
});

test('the store can be read by entry number, from one end, to the other, or both inclusive', async () => {
  const s = memoryAudit();
  const a = new Audit(s);
  for (let i = 0; i < 5; i++) await a.record({ actor: 'ana', action: 'update', target: `r/${i}` });
  const ns = async (f: number, t?: number) => (await s.range(f, t)).map((e) => e.n);
  assert.deepEqual(await ns(1), [1, 2, 3, 4, 5]);
  assert.deepEqual(await ns(3), [3, 4, 5]);
  assert.deepEqual(await ns(2, 4), [2, 3, 4]);
  assert.deepEqual(await ns(1, 1), [1]);
  assert.deepEqual(await ns(5, 5), [5]);
  assert.deepEqual(await ns(4, 2), []);
});

test('an entry that does not follow the one before it is found even when its own hash is right', async () => {
  const s = memoryAudit();
  const a = new Audit(s);
  for (let i = 0; i < 3; i++) await a.record({ actor: 'ana', action: 'update', target: `r/${i}` });
  const { hash: _h, ...body } = s.entries[1]!;
  const forgedBody = { ...body, prev: 'f'.repeat(64) };
  s.entries[1] = { ...forgedBody, hash: createHash('sha256').update(canonical(forgedBody)).digest('hex') };
  assert.deepEqual(await a.verify(), { at: 2, why: 'it does not follow the entry before it' });
});

test('a published head must match the log: a different hash, a longer head, and the true head are told apart', async () => {
  const s = memoryAudit();
  const a = new Audit(s);
  for (let i = 0; i < 3; i++) await a.record({ actor: 'ana', action: 'update', target: `r/${i}` });
  const head = await a.head();
  assert.equal(await a.verify(head), null, 'the true head of the whole log');
  assert.equal(await a.verify({ n: 2, hash: s.entries[1]!.hash }), null, 'an earlier head that is still in the chain');
  assert.equal(await a.verify({ n: 0, hash: '0'.repeat(64) }), null);
  assert.deepEqual(await a.verify({ n: 3, hash: 'f'.repeat(64) }), { at: 3, why: 'it differs from the published head' });
  assert.deepEqual(await a.verify({ n: 2, hash: 'f'.repeat(64) }), { at: 2, why: 'it differs from the published head' });
  assert.deepEqual(await a.verify({ n: 5, hash: head.hash }), { at: 4, why: 'the published head is entry 5, but the log ends at 3' });
  assert.deepEqual(await a.verify({ n: 4, hash: head.hash }), { at: 4, why: 'the published head is entry 4, but the log ends at 3' });
});

test('about finds by record, by actor, or by who was acted for, and with no filter finds everything', async () => {
  const s = memoryAudit();
  const a = new Audit(s);
  await a.record({ actor: 'ana', action: 'update', target: 'student/7' });
  await a.record({ actor: 'admin', onBehalfOf: 'cy', action: 'delete', target: 'note/3' });
  await a.record({ actor: 'cy', action: 'read', target: 'note/3' });
  await a.record({ actor: 'ben', action: 'read', target: 'student/7' });
  const acts = async (o: { target?: string; actor?: string }) => (await a.about(o)).map((e) => e.n);
  assert.deepEqual(await acts({ target: 'note/3' }), [2, 3], 'an entry made on behalf of someone is still about its record');
  assert.deepEqual(await acts({ actor: 'ana' }), [1]);
  assert.deepEqual(await acts({ actor: 'admin' }), [2]);
  assert.deepEqual(await acts({ actor: 'cy' }), [2, 3]);
  assert.deepEqual(await acts({ target: 'student/7', actor: 'ben' }), [4]);
  assert.deepEqual(await acts({ target: 'note/3', actor: 'ana' }), []);
  assert.deepEqual(await acts({}), [1, 2, 3, 4]);
});
