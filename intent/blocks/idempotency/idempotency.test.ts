import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fingerprint, Idempotent, KeyReused, memoryStore } from './index.ts';

test('a repeat returns the first result and does not run again', async () => {
  const i = new Idempotent<number>(memoryStore(), 60_000, () => 0);
  let runs = 0;
  const a = await i.once('k1', { amount: 5, to: 'x' }, async () => ++runs);
  const b = await i.once('k1', { to: 'x', amount: 5 }, async () => ++runs);
  assert.deepEqual([a, b], [{ result: 1, replayed: false }, { result: 1, replayed: true }]);
  assert.equal(runs, 1);
});

test('the same key with different content is refused', async () => {
  const i = new Idempotent<number>(memoryStore(), 60_000, () => 0);
  await i.once('k1', { amount: 5 }, async () => 1);
  await assert.rejects(i.once('k1', { amount: 6 }, async () => 2), KeyReused);
  await assert.rejects(i.once(' ', {}, async () => 1), TypeError);
});

test('two at once run once', async () => {
  const i = new Idempotent<number>(memoryStore(), 60_000, () => 0);
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const first = i.once('k', { a: 1 }, async () => { runs++; await gate; return 7; });
  const second = i.once('k', { a: 1 }, async () => { runs++; return 8; });
  release();
  assert.deepEqual((await Promise.all([first, second])).map((x) => x.result), [7, 7]);
  assert.equal(runs, 1);
});

test('a failure is not kept, and a key expires', async () => {
  let t = 0;
  const i = new Idempotent<number>(memoryStore(), 1000, () => t);
  await assert.rejects(i.once('k', {}, async () => { throw new Error('down'); }));
  assert.equal((await i.once('k', {}, async () => 3)).result, 3, 'the caller may try again after a failure');
  t = 1000;
  assert.deepEqual(await i.once('k', { new: true }, async () => 4), { result: 4, replayed: false }, 'after the window the key is free');
  assert.equal(fingerprint({ b: [1, { d: 1, c: 2 }], a: 1 }), '{"a":1,"b":[1,{"c":2,"d":1}]}');
});
