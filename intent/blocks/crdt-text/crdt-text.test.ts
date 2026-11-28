import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Doc, Refused, decodeRelativePosition, decodeStateVector, encodeRelativePosition, encodeStateVector, mergeUpdates, sync } from './index.ts';

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('local inserts and deletes edit the text by code point index', () => {
  const d = new Doc(1);
  d.insert(0, 'hello world');
  d.insert(5, ',');
  d.delete(6, 1);
  assert.equal(d.toString(), 'hello,world');
  assert.equal(d.length, 11);
  d.insert(11, '!');
  d.insert(0, '>> ');
  assert.equal(d.toString(), '>> hello,world!');
  assert.throws(() => d.insert(99, 'x'), /past the end/);
  assert.throws(() => d.delete(10, 99), /past the end/);
});

test('astral characters count as one and are never split', () => {
  const d = new Doc(1);
  d.insert(0, 'a😀b');
  assert.equal(d.length, 3);
  d.delete(1, 1);
  assert.equal(d.toString(), 'ab');
  d.insert(1, '👩‍👩');
  assert.equal(d.toString(), 'a👩‍👩b');
  const e = new Doc(2);
  e.applyUpdate(d.encodeUpdate());
  assert.equal(e.toString(), 'a👩‍👩b');
});

test('two replicas typing at the same place converge to the same text, in either delivery order', () => {
  const a = new Doc(1);
  a.insert(0, 'base');
  const b = new Doc(2);
  const baseUpdate = a.encodeUpdate();
  b.applyUpdate(baseUpdate);
  a.insert(4, 'AAA');
  b.insert(4, 'BBB');
  const ua = a.encodeUpdate(b.stateVector());
  const ub = b.encodeUpdate(a.stateVector());
  a.applyUpdate(ub);
  b.applyUpdate(ua);
  assert.equal(a.toString(), b.toString());
  assert.equal(a.toString(), 'baseAAABBB', 'the lower client id goes first, and runs are not interleaved');
  const c = new Doc(3);
  c.applyUpdate(ub);
  c.applyUpdate(ua);
  assert.equal(c.toString(), '', 'both wait for the base');
  c.applyUpdate(baseUpdate);
  assert.equal(c.toString(), 'baseAAABBB');
});

test('a delete and a concurrent insert inside the deleted range both survive correctly', () => {
  const a = new Doc(1);
  a.insert(0, 'abcdef');
  const b = new Doc(2);
  b.applyUpdate(a.encodeUpdate());
  a.delete(1, 4);
  b.insert(3, 'XY');
  sync(a, b);
  assert.equal(a.toString(), 'aXYf');
  assert.equal(b.toString(), 'aXYf');
});

test('deleting the same text on two replicas is idempotent', () => {
  const a = new Doc(1);
  a.insert(0, 'abcdef');
  const b = new Doc(2);
  b.applyUpdate(a.encodeUpdate());
  a.delete(0, 3);
  b.delete(0, 3);
  sync(a, b);
  assert.equal(a.toString(), 'def');
  assert.equal(b.toString(), 'def');
});

test('state vector sync sends only what the other side lacks', () => {
  const a = new Doc(1);
  a.insert(0, 'x'.repeat(500));
  const b = new Doc(2);
  b.applyUpdate(a.encodeUpdate());
  a.insert(500, 'tail');
  const full = a.encodeUpdate();
  const diff = a.encodeUpdate(b.stateVector());
  assert.ok(diff.length < 30, `diff is ${diff.length} bytes`);
  assert.ok(full.length > 500);
  b.applyUpdate(diff);
  assert.equal(b.toString(), 'x'.repeat(500) + 'tail');
  assert.deepEqual([...b.stateVector()], [[1, 504]]);
  const sv = decodeStateVector(encodeStateVector(b.stateVector()));
  assert.deepEqual([...sv], [[1, 504]]);
});

test('typing a run travels as one run: the update is a few bytes more than the text', () => {
  const a = new Doc(7);
  a.insert(0, 'The quick brown fox'.repeat(50));
  const u = a.encodeUpdate();
  assert.ok(u.length < 950 + 16, `update is ${u.length} bytes for 950 characters`);
});

test('an update that arrives before its dependencies is held and integrated when they arrive', () => {
  const updates: Uint8Array[] = [];
  const a = new Doc(1, { onUpdate: (u) => updates.push(u) });
  a.insert(0, 'one');
  a.insert(3, ' two');
  a.delete(0, 1);
  a.insert(0, 'O');
  assert.equal(updates.length, 4);
  const b = new Doc(2);
  b.applyUpdate(updates[3]!);
  assert.equal(b.toString(), '', 'nothing can be shown yet');
  assert.ok(b.pendingItems > 0);
  b.applyUpdate(updates[2]!);
  b.applyUpdate(updates[1]!);
  assert.equal(b.toString(), '');
  b.applyUpdate(updates[0]!);
  assert.equal(a.toString(), 'Gne two'.replace('G', 'O'));
  assert.equal(b.toString(), a.toString());
  assert.equal(b.pendingItems, 0);
});

test('applying the same update again, or an overlapping one, changes nothing', () => {
  const a = new Doc(1);
  a.insert(0, 'hello');
  const b = new Doc(2);
  const u1 = a.encodeUpdate();
  b.applyUpdate(u1);
  b.applyUpdate(u1);
  a.insert(5, ' there');
  a.delete(0, 1);
  b.applyUpdate(a.encodeUpdate());
  b.applyUpdate(a.encodeUpdate());
  assert.equal(b.toString(), 'ello there');
  assert.equal(b.itemCount, a.itemCount);
});

test('random editing on three replicas with shuffled, duplicated delivery converges (fuzz)', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const r = rng(seed);
    const log: Uint8Array[] = [];
    const docs = [1, 2, 3].map((id) => new Doc(id, { onUpdate: (u) => log.push(u) }));
    const inbox: Uint8Array[][] = docs.map(() => []);
    for (let step = 0; step < 60; step++) {
      const i = Math.floor(r() * 3);
      const d = docs[i]!;
      const mark = log.length;
      if (r() < 0.65 || d.length === 0) d.insert(Math.floor(r() * (d.length + 1)), String.fromCharCode(97 + Math.floor(r() * 26)).repeat(1 + Math.floor(r() * 3)));
      else {
        const at = Math.floor(r() * d.length);
        d.delete(at, 1 + Math.floor(r() * Math.min(3, d.length - at)));
      }
      for (const u of log.slice(mark)) for (let j = 0; j < 3; j++) if (j !== i) inbox[j]!.push(u);
      if (r() < 0.3) {
        const j = Math.floor(r() * 3);
        const q = inbox[j]!;
        q.sort(() => r() - 0.5);
        for (const u of q.splice(0, Math.floor(r() * q.length))) docs[j]!.applyUpdate(u);
      }
    }
    for (let j = 0; j < 3; j++) {
      const q = inbox[j]!;
      q.push(...q.slice(0, 3));
      q.sort(() => r() - 0.5);
      for (const u of q) docs[j]!.applyUpdate(u);
    }
    assert.equal(docs[0]!.toString(), docs[1]!.toString(), `seed ${seed}`);
    assert.equal(docs[1]!.toString(), docs[2]!.toString(), `seed ${seed}`);
    assert.equal(docs.every((d) => d.pendingItems === 0), true, `seed ${seed}: nothing left pending`);
  }
});

test('a full update into a fresh document reproduces the text and the tombstones', () => {
  const a = new Doc(1);
  a.insert(0, 'abcdefghij');
  a.delete(2, 3);
  a.insert(2, '-');
  const b = new Doc(2);
  b.applyUpdate(a.encodeUpdate());
  assert.equal(b.toString(), 'ab-fghij');
  assert.equal(b.itemCount, a.itemCount);
  assert.deepEqual([...b.deleteSet()], [[1, [[2, 3]]]]);
  const merged = new Doc(3);
  merged.applyUpdate(mergeUpdates([a.encodeUpdate(), b.encodeUpdate()]));
  assert.equal(merged.toString(), 'ab-fghij');
});

test('gc frees deleted content, keeps the tombstones, and deleted text never travels', () => {
  const a = new Doc(1);
  a.insert(0, 'secret-token-text');
  a.delete(0, 7);
  assert.equal(a.gc(), 7);
  assert.equal(a.gc(), 0, 'nothing left to free');
  assert.equal(a.itemCount, 17, 'tombstones stay');
  const u = a.encodeUpdate();
  assert.equal(Buffer.from(u).includes('secret'), false);
  const b = new Doc(2);
  b.applyUpdate(u);
  assert.equal(b.toString(), 'token-text');
  b.insert(0, 'new ');
  a.applyUpdate(b.encodeUpdate(a.stateVector()));
  assert.equal(a.toString(), 'new token-text');
});

test('cursors follow their character through edits by others, and a deleted anchor falls to where it was', () => {
  const a = new Doc(1);
  a.insert(0, 'hello world');
  const b = new Doc(2);
  b.applyUpdate(a.encodeUpdate());
  const cur = b.relativePosition(6); // before "w"
  const after = b.relativePosition(5, 1); // after "o"
  const end = b.relativePosition(11);
  a.insert(0, 'Oh, ');
  a.insert(a.length, '!!');
  sync(a, b);
  assert.equal(b.absolutePosition(cur), 10);
  assert.equal(b.absolutePosition(after), 9);
  assert.equal(b.absolutePosition(end), b.length, 'an end cursor stays at the end');
  a.delete(10, 5);
  sync(a, b);
  assert.equal(b.toString(), 'Oh, hello !!');
  assert.equal(b.absolutePosition(cur), 10, 'the anchor is gone: the cursor sits where it was');
  const round = decodeRelativePosition(encodeRelativePosition(cur));
  assert.deepEqual(round, cur);
  assert.equal(new Doc(9).absolutePosition(cur), undefined, 'a character not yet received has no position');
});

test('hostile updates are refused: truncated, trailing bytes, oversized runs, wrong text length, bad UTF-8, absurd counts', () => {
  const a = new Doc(1);
  a.insert(0, 'hello');
  const good = a.encodeUpdate();
  const b = () => new Doc(2);
  assert.throws(() => b().applyUpdate(good.subarray(0, good.length - 2)), Refused);
  assert.throws(() => b().applyUpdate(Uint8Array.from([...good, 0])), /after the end/);
  assert.throws(() => b().applyUpdate(Uint8Array.from([1, 1, 1, 0, 0xff, 0xff, 0xff, 0x7f, 0])), /run of .* items is outside/);
  assert.throws(() => b().applyUpdate(Uint8Array.from([1, 1, 1, 0, 3, 0, 2, 0x61, 0x62, 0])), /declared length/);
  assert.throws(() => b().applyUpdate(Uint8Array.from([1, 1, 1, 0, 1, 0, 1, 0xff, 0])), /UTF-8/);
  assert.throws(() => b().applyUpdate(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01])), /too long|too large|more clients/);
  assert.throws(() => b().applyUpdate(Uint8Array.from([200])), Refused);
  assert.throws(() => new Doc(2, { maxUpdateBytes: 4 }).applyUpdate(good), /larger than the limit/);
  assert.throws(() => new Doc(2, { maxRun: 4 }).applyUpdate(good), /outside 1\.\.4/);
  assert.throws(() => decodeStateVector(Uint8Array.from([5])), Refused);
});

test('operations waiting for ones that never come are capped', () => {
  const a = new Doc(1);
  a.insert(0, 'abc');
  a.insert(3, 'defgh');
  const second = a.encodeUpdate(new Map([[1, 3]]));
  const victim = new Doc(2, { maxPending: 4 });
  assert.throws(() => victim.applyUpdate(second), /too many operations are waiting/);
  assert.equal(victim.pendingItems, 0);
  assert.equal(victim.toString(), '');
});

test('the item cap stops a document growing without bound', () => {
  const d = new Doc(1, { maxItems: 10 });
  d.insert(0, '0123456789');
  assert.throws(() => d.insert(0, 'x'), /too many items/);
  assert.equal(d.toString(), '0123456789');
});

test('client ids and indexes are validated', () => {
  assert.throws(() => new Doc(-1), RangeError);
  assert.throws(() => new Doc(1.5), RangeError);
  const d = new Doc(1);
  assert.throws(() => d.insert(-1, 'x'), RangeError);
  d.insert(0, '');
  assert.equal(d.itemCount, 0);
});
