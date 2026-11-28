import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CorruptIndex, VectorError, VectorIndex, compileFilter } from './index.ts';
import type { Metric } from './index.ts';

const rng = (seed: number) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
const randomVecs = (n: number, dim: number, seed: number) => {
  const r = rng(seed);
  return Array.from({ length: n }, () => Array.from({ length: dim }, () => r() * 2 - 1));
};
const ids = (hits: { id: string }[]) => hits.map((h) => h.id);

function build(kind: 'flat' | 'hnsw', metric: Metric, n: number, dim: number, o: { store?: 'float32' | 'int8'; seed?: number } = {}) {
  const idx = new VectorIndex({ dim, metric, kind, store: o.store ?? 'float32', random: rng(7), m: 12, efConstruction: 80 });
  const vs = randomVecs(n, dim, o.seed ?? 1);
  vs.forEach((v, i) => idx.put(`v${i}`, v, { group: i % 10, parity: i % 2 === 0 ? 'even' : 'odd', rare: i % 100 === 0 }));
  return { idx, vs };
}

const recall = (idx: VectorIndex, queries: number[][], k: number, o: { ef?: number } = {}) => {
  let hit = 0;
  for (const q of queries) {
    const want = new Set(ids(idx.search(q, { k, exact: true })));
    for (const h of idx.search(q, { k, ...o })) if (want.has(h.id)) hit++;
  }
  return hit / (queries.length * k);
};

test('flat search ranks by cosine similarity, dot product and Euclidean distance with the scores they define', () => {
  const cos = new VectorIndex({ dim: 2, metric: 'cosine' });
  cos.put('east', [1, 0]);
  cos.put('north', [0, 3]);
  cos.put('ne', [2, 2]);
  const c = cos.search([1, 0.1], { k: 3 });
  assert.deepEqual(ids(c), ['east', 'ne', 'north']);
  assert.ok(Math.abs(c[0]!.score - 1 / Math.sqrt(1.01)) < 1e-6, 'cosine of (1,0) and (1,0.1)');
  assert.ok(Math.abs(c[1]!.score - (1.1 / (Math.sqrt(2) * Math.sqrt(1.01)))) < 1e-6);
  const dot = new VectorIndex({ dim: 2, metric: 'dot' });
  dot.put('big', [10, 0]);
  dot.put('small', [1, 0]);
  dot.put('neg', [-5, 0]);
  const d = dot.search([2, 1]);
  assert.deepEqual(ids(d), ['big', 'small', 'neg']);
  assert.deepEqual(d.map((h) => h.score), [20, 2, -10], 'dot product keeps length');
  const l2 = new VectorIndex({ dim: 2, metric: 'l2' });
  l2.put('origin', [0, 0]);
  l2.put('three-four', [3, 4]);
  l2.put('near', [0.5, 0]);
  const e = l2.search([0, 0]);
  assert.deepEqual(ids(e), ['origin', 'near', 'three-four']);
  assert.deepEqual(e.map((h) => h.score), [-0, -0.5, -5]);
});

test('input is checked: dimension, finite numbers, zero vectors for cosine, ids, k, ef and metadata', () => {
  const idx = new VectorIndex({ dim: 3 });
  assert.throws(() => idx.put('a', [1, 2]), /3 numbers, not 2/);
  assert.throws(() => idx.put('a', [1, NaN, 3]), /finite/);
  assert.throws(() => idx.put('a', [1, Infinity, 3]), /finite/);
  assert.throws(() => idx.put('a', [1e31, 0, 0]), /finite/);
  assert.throws(() => idx.put('a', [0, 0, 0]), /zero vector/);
  assert.throws(() => idx.put('', [1, 0, 0]), /id is 1 to/);
  assert.throws(() => idx.put('x'.repeat(513), [1, 0, 0]), /id is 1 to/);
  assert.throws(() => idx.put('a', [1, 0, 0], { nested: { a: 1 } } as never), /short string, a number/);
  assert.throws(() => idx.put('a', [1, 0, 0], { $bad: 1 }), /not a good field name/);
  assert.throws(() => idx.put('a', [1, 0, 0], JSON.parse('{"__proto__": 1}')), /not a good field name/);
  assert.throws(() => idx.put('a', [1, 0, 0], Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`f${i}`, i]))), /at most 64/);
  idx.put('a', [1, 0, 0]);
  assert.throws(() => idx.search([1, 0, 0], { k: 0 }), /k is a whole number/);
  assert.throws(() => idx.search([1, 0, 0], { k: 1.5 }), /k is a whole number/);
  assert.throws(() => idx.search([1, 0, 0], { k: 10_001 }), /k is a whole number/);
  assert.throws(() => idx.search([1, 0], { k: 1 }), /3 numbers/);
  assert.throws(() => idx.search([1, 0, 0], { ef: 0 }), /ef is/);
  assert.throws(() => new VectorIndex({ dim: 0 }), /dimension/);
  assert.throws(() => new VectorIndex({ dim: 5000 }), /dimension/);
  assert.throws(() => new VectorIndex({ dim: 3, metric: 'manhattan' as never }), /unknown metric/);
  assert.throws(() => new VectorIndex({ dim: 3, m: 1 }), /m must be/);
  const tiny = new VectorIndex({ dim: 3, maxVectors: 1 });
  tiny.put('a', [1, 0, 0]);
  assert.throws(() => tiny.put('b', [0, 1, 0]), /at most 1 vectors/);
  tiny.put('a', [0, 1, 0]);
});

test('an empty index, k larger than the index, and minScore', () => {
  const idx = new VectorIndex({ dim: 2, metric: 'dot', kind: 'hnsw', random: rng(1) });
  assert.deepEqual(idx.search([1, 1]), []);
  idx.put('a', [1, 0]);
  idx.put('b', [0, 1]);
  assert.equal(idx.search([1, 1], { k: 50 }).length, 2);
  assert.deepEqual(ids(idx.search([1, 0.5], { k: 5, minScore: 0.9 })), ['a']);
  assert.deepEqual(idx.search([1, 0], { minScore: 5 }), []);
  assert.equal(idx.size, 2);
});

test('put replaces an id, delete hides it, and get returns the stored (normalised) vector with metadata', () => {
  const idx = new VectorIndex({ dim: 2 });
  idx.put('a', [3, 4], { tag: 'one' });
  const got = idx.get('a')!;
  assert.ok(Math.abs(got.vector[0]! - 0.6) < 1e-6 && Math.abs(got.vector[1]! - 0.8) < 1e-6, 'cosine stores unit vectors');
  assert.deepEqual(got.metadata, { tag: 'one' });
  idx.put('a', [0, 5], { tag: 'two' });
  assert.equal(idx.size, 1);
  assert.deepEqual(idx.get('a')!.metadata, { tag: 'two' });
  assert.deepEqual(ids(idx.search([0, 1])), ['a']);
  assert.equal(idx.delete('a'), true);
  assert.equal(idx.delete('a'), false);
  assert.equal(idx.has('a'), false);
  assert.equal(idx.get('a'), undefined);
  assert.deepEqual(idx.search([0, 1]), []);
  assert.equal(idx.size, 0);
  idx.put('a', [1, 1]);
  assert.equal(idx.has('a'), true);
});

test('ties are broken by id so results never change between runs', () => {
  const idx = new VectorIndex({ dim: 2, metric: 'dot' });
  for (const id of ['c', 'a', 'b']) idx.put(id, [1, 1]);
  assert.deepEqual(ids(idx.search([1, 1])), ['a', 'b', 'c']);
  assert.deepEqual(ids(idx.search([1, 1], { k: 2 })), ['a', 'b']);
});

test('filters: equality, comparison, sets, existence, and, or, not; a missing field never matches a comparison', () => {
  const idx = new VectorIndex({ dim: 2, metric: 'dot' });
  idx.put('a', [1, 0], { colour: 'red', year: 2019, ok: true });
  idx.put('b', [2, 0], { colour: 'blue', year: 2021, ok: false });
  idx.put('c', [3, 0], { colour: 'red', year: 2023 });
  idx.put('d', [4, 0], { name: 'zed', note: null });
  const q = (f: object) => ids(idx.search([1, 0], { filter: f as never, k: 10 })).sort();
  assert.deepEqual(q({ colour: 'red' }), ['a', 'c']);
  assert.deepEqual(q({ colour: { $ne: 'red' } }), ['b', 'd'], 'a missing field is not equal to red');
  assert.deepEqual(q({ year: { $gte: 2021 } }), ['b', 'c']);
  assert.deepEqual(q({ year: { $gt: 2019, $lt: 2023 } }), ['b']);
  assert.deepEqual(q({ year: { $lte: 2019 } }), ['a']);
  assert.deepEqual(q({ year: { $gt: 'a' } }), [], 'numbers do not compare with strings');
  assert.deepEqual(q({ name: { $gt: 'a' } }), ['d']);
  assert.deepEqual(q({ colour: { $in: ['blue', 'green'] } }), ['b']);
  assert.deepEqual(q({ colour: { $nin: ['red'] } }), ['b', 'd']);
  assert.deepEqual(q({ ok: { $exists: true } }), ['a', 'b']);
  assert.deepEqual(q({ ok: { $exists: false } }), ['c', 'd']);
  assert.deepEqual(q({ note: null }), ['d']);
  assert.deepEqual(q({ ok: false }), ['b']);
  assert.deepEqual(q({ $or: [{ colour: 'blue' }, { year: { $gt: 2022 } }] }), ['b', 'c']);
  assert.deepEqual(q({ $and: [{ colour: 'red' }, { $not: { year: { $lt: 2020 } } }] }), ['c']);
  assert.deepEqual(q({ colour: 'red', year: 2023 }), ['c'], 'fields in one object are all required');
  assert.deepEqual(q({}), ['a', 'b', 'c', 'd']);
});

test('malformed or hostile filters are refused, never guessed at', () => {
  const bad: [unknown, RegExp][] = [
    [null, /is an object/],
    [[], /is an object/],
    [{ $and: [] }, /needs a list/],
    [{ $or: 'x' }, /needs a list/],
    [{ $nor: [] }, /unknown operator \$nor/],
    [{ a: { $regex: '.*' } }, /unknown operator \$regex/],
    [{ a: { $in: 'x' } }, /needs a list/],
    [{ a: { $in: [{}] } }, /needs a list/],
    [{ a: { $gt: {} } }, /needs a number or a string/],
    [{ a: { $exists: 'yes' } }, /true or false/],
    [{ a: {} }, /no condition/],
    [{ a: [1] }, /not a value/],
    [{ a: { $eq: [1] } }, /needs a value/],
    [JSON.parse('{"__proto__": 1}'), /not a field name/],
  ];
  for (const [f, re] of bad) assert.throws(() => compileFilter(f), re, JSON.stringify(f));
  let deep: object = { a: 1 };
  for (let i = 0; i < 12; i++) deep = { $not: deep };
  assert.throws(() => compileFilter(deep), /nested too deeply/);
  assert.throws(() => compileFilter({ a: { $in: Array.from({ length: 1001 }, (_, i) => i) } }), /up to 1000/);
  const idx = new VectorIndex({ dim: 2 });
  idx.put('a', [1, 0]);
  assert.throws(() => idx.search([1, 0], { filter: { $bogus: 1 } as never }), /unknown operator/);
});

test('HNSW finds nearly the same neighbours as the exact scan, for each metric', () => {
  for (const metric of ['cosine', 'dot', 'l2'] as const) {
    const { idx } = build('hnsw', metric, 1500, 16);
    const queries = randomVecs(40, 16, 99);
    const r = recall(idx, queries, 10, { ef: 80 });
    assert.ok(r >= 0.95, `${metric}: recall ${r}`);
    const wide = recall(idx, queries, 10, { ef: 400 });
    assert.ok(wide >= r - 1e-9 && wide >= 0.99, `${metric}: wider search is no worse, ${wide}`);
  }
});

test('HNSW is repeatable: the same data and random numbers give the same graph, the same answers and the same bytes', () => {
  const a = build('hnsw', 'cosine', 400, 8);
  const b = build('hnsw', 'cosine', 400, 8);
  assert.deepEqual(Buffer.from(a.idx.save()), Buffer.from(b.idx.save()));
  const q = randomVecs(1, 8, 5)[0]!;
  assert.deepEqual(a.idx.search(q), b.idx.search(q));
  const s = a.idx.stats();
  assert.equal(s.kind, 'hnsw');
  assert.ok(s.maxLevel >= 1, 'a few hundred vectors need more than one layer');
});

test('a tiny HNSW index is exact; the flat index is exact by definition and equals an index asked to scan exactly', () => {
  const { idx, vs } = build('hnsw', 'cosine', 10, 4);
  const flat = new VectorIndex({ dim: 4 });
  vs.forEach((v, i) => flat.put(`v${i}`, v));
  const q = [0.3, -0.2, 0.9, 0.1];
  assert.deepEqual(ids(idx.search(q, { k: 10 })), ids(flat.search(q, { k: 10 })));
  assert.deepEqual(idx.search(q, { k: 5, exact: true }).map((h) => h.id), ids(flat.search(q, { k: 5 })));
});

test('filtered search only returns what passes, and a very selective filter still finds the true best matches', () => {
  const { idx } = build('hnsw', 'cosine', 1500, 16);
  const queries = randomVecs(20, 16, 123);
  for (const q of queries) {
    const hits = idx.search(q, { k: 10, filter: { parity: 'even', group: { $lt: 5 } } });
    assert.equal(hits.length, 10);
    assert.ok(hits.every((h) => h.metadata.parity === 'even' && (h.metadata.group as number) < 5));
    const rare = idx.search(q, { k: 5, filter: { rare: true } });
    const want = idx.search(q, { k: 5, filter: { rare: true }, exact: true });
    assert.deepEqual(ids(rare), ids(want), 'about 1% pass: scanned exactly');
    assert.equal(rare.length, 5);
  }
  const mid = recall2(idx, queries, { filter: { group: 3 } });
  assert.ok(mid >= 0.9, `filtered recall ${mid}`);
  assert.deepEqual(idx.search(queries[0]!, { filter: { group: 99 } }), []);
});
function recall2(idx: VectorIndex, queries: number[][], o: { filter: object }) {
  let hit = 0;
  let total = 0;
  for (const q of queries) {
    const want = new Set(ids(idx.search(q, { k: 10, exact: true, filter: o.filter as never })));
    for (const h of idx.search(q, { k: 10, filter: o.filter as never })) if (want.has(h.id)) hit++;
    total += want.size;
  }
  return hit / total;
}

test('removed vectors never come back, the graph still works around them, and compact rebuilds without them', () => {
  const { idx, vs } = build('hnsw', 'cosine', 800, 12);
  for (let i = 0; i < 800; i += 2) idx.delete(`v${i}`);
  assert.equal(idx.size, 400);
  assert.equal(idx.stored, 800);
  const queries = randomVecs(30, 12, 77);
  for (const q of queries) assert.ok(idx.search(q, { k: 10 }).every((h) => Number(h.id.slice(1)) % 2 === 1));
  assert.ok(recall(idx, queries, 10, { ef: 100 }) >= 0.9);
  const before = idx.search(queries[0]!, { k: 5, exact: true });
  const small = idx.compact(rng(3));
  assert.equal(small.stored, 400);
  assert.equal(small.stats().removed, 0);
  assert.deepEqual(ids(small.search(queries[0]!, { k: 5, exact: true })), ids(before));
  assert.ok(recall(small, queries, 10, { ef: 100 }) >= 0.9);
  void vs;
  const stats = idx.stats();
  assert.equal(stats.removed, 400);
  const dup = build('hnsw', 'dot', 200, 6).idx;
  dup.put('v5', [9, 9, 9, 9, 9, 9]);
  assert.equal(dup.size, 200, 'replacing keeps the count');
  assert.equal(dup.stored, 201);
  assert.equal(dup.search([1, 1, 1, 1, 1, 1], { k: 1 })[0]!.id, 'v5');
});

test('int8 storage keeps a quarter of the bytes, errs by at most half a step per number, and ranks almost the same', () => {
  const f = build('flat', 'dot', 600, 32, { seed: 4 });
  const q8 = build('flat', 'dot', 600, 32, { store: 'int8', seed: 4 });
  const bytesF = f.idx.stats().bytes;
  const bytes8 = q8.idx.stats().bytes;
  assert.ok(bytes8 < bytesF * 0.4, `${bytes8} against ${bytesF}`);
  const orig = f.vs[3]!;
  const kept = q8.idx.get('v3')!.vector;
  const range = Math.max(...orig) - Math.min(...orig);
  for (let i = 0; i < 32; i++) assert.ok(Math.abs(kept[i]! - orig[i]!) <= range / 255 / 2 + 1e-6, `component ${i}`);
  const queries = randomVecs(30, 32, 55);
  let agree = 0;
  for (const q of queries) {
    const want = new Set(ids(f.idx.search(q, { k: 10 })));
    for (const h of q8.idx.search(q, { k: 10 })) if (want.has(h.id)) agree++;
  }
  assert.ok(agree / 300 >= 0.9, `top-10 overlap ${agree / 300}`);
  const hn = build('hnsw', 'l2', 500, 16, { store: 'int8' });
  assert.ok(recall(hn.idx, randomVecs(20, 16, 8), 10, { ef: 100 }) >= 0.9);
  const same = new VectorIndex({ dim: 3, store: 'int8', metric: 'dot' });
  same.put('flat', [2, 2, 2]);
  assert.deepEqual([...same.get('flat')!.vector], [2, 2, 2], 'a vector with no spread is held exactly');
});

test('save and load: every kind comes back with the same answers; replacing and removing survive', () => {
  for (const [kind, store, metric] of [['flat', 'float32', 'cosine'], ['hnsw', 'float32', 'l2'], ['hnsw', 'int8', 'dot'], ['flat', 'int8', 'cosine']] as const) {
    const { idx } = build(kind, metric, 300, 8, { store });
    idx.delete('v7');
    idx.put('v9', [1, 2, 3, 4, 5, 6, 7, 8], { group: 99 });
    const bytes = idx.save();
    const back = VectorIndex.load(bytes, { random: rng(7) });
    assert.equal(back.size, idx.size);
    assert.equal(back.stored, idx.stored);
    assert.equal(back.has('v7'), false);
    assert.equal(back.kind, kind);
    assert.equal(back.store, store);
    for (const q of randomVecs(10, 8, 21)) {
      assert.deepEqual(back.search(q, { k: 10 }), idx.search(q, { k: 10 }), `${kind}/${store}/${metric}`);
      assert.deepEqual(back.search(q, { k: 5, filter: { group: 99 } }), idx.search(q, { k: 5, filter: { group: 99 } }));
    }
    assert.deepEqual(Buffer.from(back.save()), Buffer.from(bytes), 'saving what was loaded gives the same bytes');
    back.put('later', [1, 1, 1, 1, 1, 1, 1, 1]);
    assert.equal(back.search([1, 1, 1, 1, 1, 1, 1, 1], { k: 1 })[0]!.id.length > 0, true);
  }
  const empty = VectorIndex.load(new VectorIndex({ dim: 4, kind: 'hnsw' }).save());
  assert.equal(empty.size, 0);
  assert.deepEqual(empty.search([1, 0, 0, 0]), []);
});

test('damaged, cut-off, foreign or hostile bytes are refused before anything is built', () => {
  const { idx } = build('hnsw', 'cosine', 120, 4);
  const good = Buffer.from(idx.save());
  assert.doesNotThrow(() => VectorIndex.load(good));
  const flip = Buffer.from(good);
  flip[good.length >> 1] = flip[good.length >> 1]! ^ 1;
  assert.throws(() => VectorIndex.load(flip), /checksum/);
  assert.throws(() => VectorIndex.load(good.subarray(0, good.length - 7)), CorruptIndex);
  assert.throws(() => VectorIndex.load(good.subarray(0, 10)), /too short/);
  assert.throws(() => VectorIndex.load(Buffer.from('not an index at all, just some text of enough length')), /not a saved vector index/);
  const wrongVersion = Buffer.from(good);
  wrongVersion.writeUInt32LE(9, 4);
  assert.throws(() => VectorIndex.load(wrongVersion), /version 9/);
  assert.throws(() => VectorIndex.load(good, { maxDim: 2 }), /dimension is out of range/);
  assert.throws(() => VectorIndex.load(good, { maxVectors: 10 }), /count is out of range/);
  assert.throws(() => VectorIndex.load(good, { maxBytes: 100 }), /larger than the limit/);
  // A valid checksum does not make the contents trustworthy: forge one over a graph with a link out of range.
  const forged = Buffer.from(good);
  const body = forged.subarray(0, forged.length - 16);
  const headLen = forged.readUInt32LE(8);
  const pad = (4 - ((12 + headLen) % 4)) % 4;
  const graphStart = 12 + headLen + pad + 120 * 4 * 4;
  const len0 = body.readInt32LE(graphStart);
  assert.ok(len0 > 0);
  body.writeInt32LE(100_000, graphStart + 4);
  createHash('sha256').update(body).digest().subarray(0, 16).copy(forged, forged.length - 16);
  assert.throws(() => VectorIndex.load(forged), /link points outside the graph/);
  const nan = Buffer.from(good);
  nan.writeFloatLE(NaN, 12 + headLen + pad);
  createHash('sha256').update(nan.subarray(0, nan.length - 16)).digest().subarray(0, 16).copy(nan, nan.length - 16);
  assert.throws(() => VectorIndex.load(nan), /not finite/);
  const trailing = Buffer.concat([good.subarray(0, good.length - 16), Buffer.from([1, 2, 3, 4])]);
  const digest = createHash('sha256').update(trailing).digest().subarray(0, 16);
  assert.throws(() => VectorIndex.load(Buffer.concat([trailing, digest])), /left over/);
});
