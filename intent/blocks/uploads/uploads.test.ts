import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryObjects, readAll } from '../objects/index.ts';
import { BadChunk, NoSession, OverQuota, Uploads, WrongLength, memorySessions, type Rules } from './index.ts';

const RULES: Rules = { minChunk: 1, maxChunk: 10_000, minBytes: 4, maxBytes: 64, idleMs: 1000 };
const b = (s: string) => new TextEncoder().encode(s);

const setup = (free?: number) => {
  let t = 0;
  const objects = memoryObjects();
  const up = new Uploads(objects, memorySessions(), { rules: RULES, now: () => t, free: async () => free, composeWidth: 3 });
  return { up, objects, tick: (ms: number) => (t += ms) };
};

test('chunks sent out of order assemble in number order into one object, and the chunks are cleaned up', async () => {
  const { up, objects } = setup();
  await up.start('ana', 'u1', '/files/ana/big.bin');
  await up.chunk('ana', 'u1', '00003', b('ijkl'));
  await up.chunk('ana', 'u1', '00001', b('abcd'));
  await up.chunk('ana', 'u1', '00002', b('efgh'));
  const w = await up.assemble('ana', 'u1');
  assert.equal((await readAll(await objects.get(w.key))).toString(), 'abcdefghijkl');
  assert.equal(w.destination, '/files/ana/big.bin');
  assert.equal(objects.count(), 1, 'only the assembled object is left');
  await assert.rejects(up.received('ana', 'u1'), NoSession);
});

test('a resend of a chunk replaces it, and the client can see what has arrived', async () => {
  const { up, objects } = setup();
  await up.start('ana', 'u', '/d');
  await up.chunk('ana', 'u', '1', b('xxxx'));
  await up.chunk('ana', 'u', '1', b('abcd'));
  await up.chunk('ana', 'u', '2', b('ef'));
  assert.deepEqual(await up.received('ana', 'u'), [
    { n: 1, size: 4 },
    { n: 2, size: 2 },
  ]);
  assert.equal(objects.count(), 2, 'the replaced chunk is deleted');
  assert.equal((await readAll(await objects.get((await up.assemble('ana', 'u')).key))).toString(), 'abcdef');
});

test('chunks arriving at the same moment are all kept', async () => {
  const { up, objects } = setup();
  await up.start('ana', 'u', '/d');
  await Promise.all(Array.from({ length: 20 }, (_, i) => up.chunk('ana', 'u', String(i + 1), b(String.fromCharCode(97 + i).repeat(4)))));
  assert.equal((await up.received('ana', 'u')).length, 20);
  const w = await up.assemble('ana', 'u');
  assert.equal(w.size, 80);
  assert.equal((await readAll(await objects.get(w.key))).toString().slice(0, 8), 'aaaabbbb');
  assert.equal(objects.count(), 1, 'every intermediate join is deleted');
});

test('a total length over the free space is refused on the first chunk, not at the end', async () => {
  const { up } = setup(10);
  await assert.rejects(up.start('ana', 'u', '/d', 100), OverQuota);
  await up.start('ana', 'v', '/d');
  await assert.rejects(up.chunk('ana', 'v', '1', b('abcd'), 100), OverQuota);
});

test('the assembled length must match what the client said', async () => {
  const { up } = setup();
  await up.start('ana', 'u', '/d', 9);
  await up.chunk('ana', 'u', '1', b('abcd'));
  await assert.rejects(up.assemble('ana', 'u'), WrongLength);
});

test('chunk rules: numbers in range, every chunk but the last at least the minimum', async () => {
  const { up } = setup();
  await up.start('ana', 'u', '/d');
  await assert.rejects(up.chunk('ana', 'u', '0', b('abcd')), BadChunk);
  await assert.rejects(up.chunk('ana', 'u', '10001', b('abcd')), BadChunk);
  await assert.rejects(up.chunk('ana', 'u', '1.5', b('abcd')), BadChunk);
  await up.chunk('ana', 'u', '1', b('ab'));
  await up.chunk('ana', 'u', '2', b('cdef'));
  await assert.rejects(up.assemble('ana', 'u'), BadChunk);
  await assert.rejects(up.start('ana', '../x', '/d'), BadChunk);
});

test('an idle session expires, and the sweep removes it and its chunks', async () => {
  const { up, objects, tick } = setup();
  await up.start('ana', 'u', '/d');
  await up.chunk('ana', 'u', '1', b('abcd'));
  tick(500);
  await up.chunk('ana', 'u', '2', b('ef'));
  tick(900);
  assert.equal((await up.received('ana', 'u')).length, 2, 'a chunk keeps the session alive');
  tick(200);
  await assert.rejects(up.chunk('ana', 'u', '3', b('gh')), NoSession);
  assert.equal(await up.sweep(), 1);
  assert.equal(objects.count(), 0);
});

test('sessions belong to their owner, and abort discards everything', async () => {
  const { up, objects } = setup();
  await up.start('ana', 'u', '/d');
  await up.chunk('ana', 'u', '1', b('abcd'));
  await assert.rejects(up.chunk('ben', 'u', '2', b('abcd')), NoSession);
  await up.abort('ana', 'u');
  assert.equal(objects.count(), 0);
});
