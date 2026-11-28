import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { Adler32, Missing, TooLarge, diskKeys, diskObjects, memoryObjects, parseChecksums, parseRange, readAll, type ObjectStore } from './index.ts';

const bytes = (s: string) => new TextEncoder().encode(s);

test('Adler-32 matches the published value for "Wikipedia"', () => {
  assert.equal(new Adler32().update(bytes('Wikipedia')).hex(), '11e60398');
  // Split across updates gives the same answer as one pass.
  assert.equal(new Adler32().update(bytes('Wiki')).update(bytes('pedia')).hex(), '11e60398');
  // Long input exercises the modulo, which a wrong implementation gets wrong only past 3,800 bytes.
  const long = new Uint8Array(100_000).fill(255);
  const one = new Adler32().update(long).hex();
  const two = new Adler32().update(long.subarray(0, 5000)).update(long.subarray(5000)).hex();
  assert.equal(one, two);
  assert.equal(one, '149a302c', "zlib's value for 100,000 bytes of 0xff");
  // Sixteen 0xff bytes put the top bit of the result on, where a signed shift goes negative.
  assert.equal(new Adler32().update(new Uint8Array(16).fill(255)).hex(), '87880ff1');
});

test('a byte range is parsed as HTTP means it, and an impossible one is unsatisfiable', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=50-500', 100), { start: 50, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-1,5-6', 100), null, 'several ranges: send the whole object');
  assert.equal(parseRange(undefined, 100), null);
});

test('checksum headers keep known algorithms and normalise them', () => {
  assert.deepEqual(parseChecksums('SHA1:ABC md5:def'), ['SHA1:abc', 'MD5:def']);
  assert.deepEqual(parseChecksums('CRC99:zz'), []);
});

for (const [name, mk] of [
  ['memory', async () => ({ s: memoryObjects() as ObjectStore, done: async () => {} })],
  [
    'disk',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'objects-'));
      return { s: diskObjects(dir), done: () => rm(dir, { recursive: true, force: true }), dir };
    },
  ],
] as const) {
  test(`${name}: what is written reads back whole and by range, with checksums computed on the way in`, async () => {
    const { s, done } = await mk();
    try {
      const w = await s.put(bytes('hello world'));
      assert.equal(w.size, 11);
      assert.ok(w.checksums.includes(`SHA1:${createHash('sha1').update('hello world').digest('hex')}`));
      assert.equal((await readAll(await s.get(w.key))).toString(), 'hello world');
      assert.equal((await readAll(await s.get(w.key, { start: 6, end: 10 }))).toString(), 'world');
      assert.equal(await s.size(w.key), 11);
    } finally {
      await done();
    }
  });

  test(`${name}: parts compose into one object in order, and a missing part is an error`, async () => {
    const { s, done } = await mk();
    try {
      const a = await s.put(bytes('abc'));
      const b = await s.put(bytes('def'));
      const c = await s.compose([a.key, b.key]);
      assert.equal((await readAll(await s.get(c.key))).toString(), 'abcdef');
      assert.equal(c.size, 6);
      await assert.rejects(s.compose([a.key, '00000000-0000-0000-0000-000000000000']), Missing);
    } finally {
      await done();
    }
  });

  test(`${name}: a write over its limit stops and leaves nothing behind`, async () => {
    const { s, done } = await mk();
    try {
      await assert.rejects(s.put(bytes('x'.repeat(20)), { maxBytes: 10 }), TooLarge);
    } finally {
      await done();
    }
  });
}

test('the disk store fans keys out and can list them for a sweep', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'objects-'));
  try {
    const s = diskObjects(dir);
    const w = await s.put(bytes('x'));
    assert.deepEqual(await diskKeys(dir), [w.key]);
    await s.delete(w.key);
    assert.equal(await s.size(w.key), undefined);
    await assert.rejects(s.get('../../etc/passwd'), Missing, 'a key is never a path');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('on disk, a stored object and the folders it was made in are forced to disk before put returns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'objects-sync-'));
  const probe = await open(tmpdir(), 'r');
  const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  const m = mock.method(proto, 'sync');
  try {
    const s = diskObjects(dir);
    const w = await s.put(new TextEncoder().encode('durable'));
    assert.ok(m.mock.callCount() >= 2, `the file and its folder: ${m.mock.callCount()} syncs`);
    assert.equal((await readAll(await s.get(w.key))).toString(), 'durable');
  } finally {
    m.mock.restore();
    await rm(dir, { recursive: true, force: true });
  }
});
