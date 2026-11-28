import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TooLarge, memoryObjects, readAll } from '../objects/index.ts';
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
  await up.finish('ana', 'u1');
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
  await up.finish('ana', 'u');
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

test('a chunk stream is cut off at the declared total and at the free space, counting what already arrived', async () => {
  const { up, objects } = setup(10);
  await up.start('ana', 'u', '/d', 8);
  await up.chunk('ana', 'u', '1', b('abcd'));
  await assert.rejects(up.chunk('ana', 'u', '2', b('efghi')), BadChunk, 'four more bytes than the eight declared');
  await up.chunk('ana', 'u', '2', b('efgh'));
  await up.chunk('ana', 'u', '1', b('ABCD'), undefined);
  assert.equal(objects.count(), 2, 'a refused chunk keeps no bytes, and a resent one replaces the first');
  const { up: up2 } = setup(10);
  await up2.start('ana', 'v', '/d');
  await up2.chunk('ana', 'v', '1', b('abcdefgh'));
  await assert.rejects(up2.chunk('ana', 'v', '2', b('ijk')), OverQuota, 'eight arrived, two free');
  await up2.chunk('ana', 'v', '2', b('ij'));
  await assert.rejects(up2.chunk('ana', 'v', '3', b('xxxx'), undefined, 4), OverQuota, 'a declared chunk size over the room is refused before reading');
  const { up: up3 } = setup();
  await up3.start('ana', 'w', '/d');
  await assert.rejects(up3.chunk('ana', 'w', '1', b('x'.repeat(65))), TooLarge, 'never more than a chunk may have');
});

test('assembly keeps the chunks until finish, so a crash before the file is committed loses nothing', async () => {
  const { up, objects } = setup();
  await up.start('ana', 'u', '/d');
  await up.chunk('ana', 'u', '1', b('abcd'));
  await up.chunk('ana', 'u', '2', b('ef'));
  const w = await up.assemble('ana', 'u');
  assert.equal(objects.count(), 3, 'the chunks are still there beside the joined object');
  assert.equal((await up.received('ana', 'u')).length, 2, 'and the session can be assembled again');
  // A crash here: the joined object was never committed, and the client retries.
  await objects.delete(w.key);
  const again = await up.assemble('ana', 'u');
  assert.equal((await readAll(await objects.get(again.key))).toString(), 'abcdef');
  await up.finish('ana', 'u');
  assert.equal(objects.count(), 1, 'finish removes the chunks and the session');
  await assert.rejects(up.received('ana', 'u'), NoSession);
});
