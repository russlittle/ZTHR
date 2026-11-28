import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { memoryObjects } from '../objects/index.ts';
import { ChunkError, ChunkStore, Chunker, chunkLengths, compare, cutPoint, memoryIndex, plan } from './index.ts';
import type { ChunkParams } from './index.ts';

/** Deterministic pseudo-random bytes. */
function bytes(n: number, seed = 1): Buffer {
  const out = Buffer.alloc(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}
const P: ChunkParams = { min: 512, avg: 2048, max: 8192 };
const store = (o: Partial<ConstructorParameters<typeof ChunkStore>[0]> = {}) => new ChunkStore({ objects: memoryObjects(), params: P, ...o });

test('chunk sizes stay between the minimum and maximum and cluster near the average', () => {
  const data = bytes(2_000_000);
  const lens = chunkLengths(data, P);
  assert.equal(lens.reduce((a, b) => a + b, 0), data.length);
  assert.ok(lens.slice(0, -1).every((l) => l >= P.min && l <= P.max), 'all but the last are within bounds');
  const avg = data.length / lens.length;
  assert.ok(avg > P.avg * 0.7 && avg < P.avg * 1.6, `average ${Math.round(avg)} should be near ${P.avg}`);
  assert.ok(lens.some((l) => l < P.avg) && lens.some((l) => l > P.avg), 'sizes vary with content');
});

test('chunking is deterministic, and a different salt gives different boundaries', () => {
  const data = bytes(300_000, 7);
  assert.deepEqual(chunkLengths(data, P), chunkLengths(Buffer.from(data), P));
  const salted = chunkLengths(data, { ...P, salt: 'tenant-a' });
  assert.notDeepEqual(salted, chunkLengths(data, P));
  assert.deepEqual(salted, chunkLengths(data, { ...P, salt: 'tenant-a' }));
});

test('the streaming chunker gives the same chunks however the bytes arrive', () => {
  const data = bytes(200_000, 3);
  const whole = chunkLengths(data, P);
  for (const piece of [1, 7, 1000, 8192, 65536]) {
    const c = new Chunker(P);
    const got: number[] = [];
    for (let i = 0; i < data.length; i += piece) got.push(...c.push(data.subarray(i, i + piece)).map((b) => b.length));
    got.push(...c.end().map((b) => b.length));
    assert.deepEqual(got, whole, `pieces of ${piece}`);
  }
});

test('inserting bytes near the start changes only the chunks around the edit', () => {
  const a = bytes(400_000, 11);
  const b = Buffer.concat([a.subarray(0, 1000), Buffer.from('INSERTED BYTES THAT SHIFT EVERYTHING'), a.subarray(1000)]);
  const ids = (d: Buffer) => {
    const out: string[] = [];
    let at = 0;
    for (const l of chunkLengths(d, P)) {
      out.push(createHash('sha256').update(d.subarray(at, at + l)).digest('hex'));
      at += l;
    }
    return out;
  };
  const ia = ids(a);
  const ib = new Set(ids(b));
  const shared = ia.filter((x) => ib.has(x)).length;
  assert.ok(shared >= ia.length - 4, `${shared} of ${ia.length} chunks survive a shift of everything after byte 1000`);
  // fixed-size blocking would share none after the insertion
});

test('a file is stored once per distinct chunk, read back exactly, and its digest matches', async () => {
  const s = store();
  const data = bytes(150_000, 5);
  const m = await s.put('a.bin', data);
  assert.equal(m.size, data.length);
  assert.equal(m.digest, createHash('sha256').update(data).digest('hex'));
  assert.deepEqual(await s.readAll('a.bin'), data);
  assert.equal(m.chunks.reduce((n, c) => n + c.size, 0), data.length);
  await assert.rejects(s.put('a.bin', data), /already exists/);
  assert.deepEqual(await s.readAll('a.bin', { start: 100_000, end: 100_000 }), data.subarray(100_000, 100_001));
});

test('identical content, and content with a long shared run, is stored once', async () => {
  const objects = memoryObjects();
  const s = new ChunkStore({ objects, params: P });
  const base = bytes(200_000, 9);
  await s.put('v1', base);
  const afterFirst = objects.count();
  await s.put('copy', base);
  assert.equal(objects.count(), afterFirst, 'an identical file adds no objects');
  const edited = Buffer.concat([base.subarray(0, 50_000), Buffer.from('CHANGED'), base.subarray(50_007)]);
  await s.put('v2', edited);
  const st = s.stats();
  assert.ok(objects.count() <= afterFirst + 3, `a small edit adds only a few chunks (${objects.count() - afterFirst})`);
  assert.equal(st.files, 3);
  assert.equal(st.logicalBytes, 200_000 * 3);
  assert.ok(st.ratio > 2.9, `ratio ${st.ratio}`);
  assert.equal(st.savedBytes, st.logicalBytes - st.storedBytes);
  const cmp = compare(s.manifest('v1')!, s.manifest('v2')!);
  assert.ok(cmp.shared >= s.manifest('v1')!.chunks.length - 3);
  assert.ok(cmp.newBytes <= 3 * P.max);
});

test('repeated content inside one file is stored once', async () => {
  const s = store();
  const block = bytes(5000, 2);
  const data = Buffer.concat(Array.from({ length: 40 }, () => block));
  const m = await s.put('rep', data);
  const st = s.stats();
  assert.ok(m.chunks.length > st.uniqueChunks, 'chunk list repeats ids');
  assert.ok(st.storedBytes < data.length / 5, `stored ${st.storedBytes} of ${data.length}`);
  assert.deepEqual(await s.readAll('rep'), data);
});

test('ranges read only the chunks they cover', async () => {
  const objects = memoryObjects();
  let gets = 0;
  const counting = { ...objects, get: async (k: string, r?: { start: number; end: number }) => (gets++, objects.get(k, r)) };
  const s = new ChunkStore({ objects: counting, params: P });
  const data = bytes(300_000, 4);
  const m = await s.put('big', data);
  assert.deepEqual(await s.readAll('big', { start: 1234, end: 5678 }), data.subarray(1234, 5679));
  assert.ok(gets <= 4, `a 4 KB range touched ${gets} chunks of ${m.chunks.length}`);
  assert.deepEqual(await s.readAll('big', { start: 0, end: 299_999 }), data);
  await assert.rejects(s.readAll('big', { start: 0, end: 300_000 }), /outside the file/);
  await assert.rejects(s.readAll('nope'), /no file nope/);
});

test('empty files and tiny files work', async () => {
  const s = store();
  const e = await s.put('empty', Buffer.alloc(0));
  assert.equal(e.chunks.length, 0);
  assert.equal((await s.readAll('empty')).length, 0);
  const t = await s.put('tiny', Buffer.from('hi'));
  assert.equal(t.chunks.length, 1);
  assert.equal((await s.readAll('tiny')).toString(), 'hi');
});

test('delete releases a file and removes only chunks nothing else uses', async () => {
  const objects = memoryObjects();
  const s = new ChunkStore({ objects, params: P });
  const base = bytes(100_000, 8);
  await s.put('a', base);
  await s.put('b', Buffer.concat([base.subarray(0, 60_000), bytes(40_000, 99)]));
  const before = objects.count();
  const freed = await s.delete('a');
  assert.ok(freed > 0 && freed < 100_000, 'a shared prefix stays');
  assert.ok(objects.count() < before);
  assert.deepEqual(await s.readAll('b'), Buffer.concat([base.subarray(0, 60_000), bytes(40_000, 99)]), 'the other file is intact');
  assert.equal(await s.delete('a'), 0, 'deleting twice frees nothing and does no harm');
  await s.delete('b');
  assert.equal(objects.count(), 0);
  assert.equal(s.stats().uniqueChunks, 0);
});

test('a put that fails leaves orphans that a sweep removes after the grace period, never earlier', async () => {
  let t = 1000;
  const objects = memoryObjects();
  const s = new ChunkStore({ objects, params: P, now: () => t });
  async function* broken() {
    yield bytes(60_000, 1);
    throw new Error('connection dropped');
  }
  await assert.rejects(s.put('doomed', broken()), /connection dropped/);
  assert.equal(s.manifest('doomed'), undefined);
  const orphans = s.stats().orphanChunks;
  assert.ok(orphans > 0);
  assert.deepEqual(await s.sweep(10_000), { removed: 0, bytes: 0 }, 'too young: a put may still be running');
  t += 20_000;
  const r = await s.sweep(10_000);
  assert.equal(r.removed, orphans);
  assert.equal(objects.count(), 0);
});

test('damaged stored bytes are caught on read and by verify', async () => {
  const objects = memoryObjects();
  const index = memoryIndex();
  const s = new ChunkStore({ objects, index, params: P });
  const data = bytes(50_000, 6);
  await s.put('f', data);
  assert.deepEqual(await s.verify(), []);
  const [victim, entry] = [...index.entries()][1]!;
  await objects.delete(entry.key);
  const w = await objects.put(Buffer.alloc(entry.size, 7));
  index.set(victim, { ...entry, key: w.key });
  assert.deepEqual(await s.verify(), [victim]);
  await assert.rejects(s.readAll('f'), /does not match its id/);
});

test('a hash key makes chunk ids unguessable from content, and the same key still dedups', async () => {
  const objects = memoryObjects();
  const keyed = new ChunkStore({ objects, params: P, hashKey: Buffer.from('a deployment key of some length') });
  const plain = new ChunkStore({ objects: memoryObjects(), params: P });
  const data = bytes(30_000, 12);
  const mk = await keyed.put('f', data);
  const mp = await plain.put('f', data);
  assert.notEqual(mk.chunks[0]!.id, mp.chunks[0]!.id);
  assert.notEqual(mk.digest, mp.digest);
  assert.notEqual(mk.chunks[0]!.id, createHash('sha256').update(data.subarray(0, mk.chunks[0]!.size)).digest('hex'), 'the id is not the plain SHA-256 of the chunk');
  const before = objects.count();
  await keyed.put('g', data);
  assert.equal(objects.count(), before);
  assert.deepEqual(await keyed.readAll('g'), data);
});

test('a sync plan sends only the distinct chunks the peer lacks', async () => {
  const s = store();
  const base = bytes(120_000, 21);
  const m1 = await s.put('v1', base);
  const m2 = await s.put('v2', Buffer.concat([base.subarray(0, 70_000), Buffer.from('EDIT'), base.subarray(70_000)]));
  const peer = new Set(m1.chunks.map((c) => c.id));
  const p = plan(m2, (id) => peer.has(id));
  assert.ok(p.sendBytes < 3 * P.max, `sends ${p.sendBytes} of ${m2.size}`);
  assert.equal(p.sendBytes + p.skipBytes, m2.size);
  assert.equal(plan(m2, () => true).sendBytes, 0);
  const all = plan(m1, () => false);
  assert.equal(all.send.length, new Set(m1.chunks.map((c) => c.id)).size, 'a repeated chunk is sent once');
});

test('limits and parameters are validated', async () => {
  assert.throws(() => chunkLengths(Buffer.alloc(10), { min: 10, avg: 100, max: 1000 }), /at least 64/);
  assert.throws(() => chunkLengths(Buffer.alloc(10), { min: 100, avg: 100, max: 1000 }), /min < avg < max/);
  assert.throws(() => new Chunker({ min: 128, avg: 512, max: 1 << 25 }), /16 MiB/);
  assert.throws(() => new ChunkStore({ objects: memoryObjects(), params: { min: 1, avg: 2, max: 3 } }), ChunkError);
  const s = store({ maxBytes: 10_000 });
  await assert.rejects(s.put('big', bytes(20_000)), /more than 10000 bytes/);
  assert.equal(cutPoint(Buffer.alloc(100), P), 100, 'data shorter than the minimum is one chunk');
});
