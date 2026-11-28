import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CrdtError, CrdtMap, compare, covers, fingerprint, mergeClocks, type Op } from './index.ts';

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const clone = (m: CrdtMap, name = 'clone') => CrdtMap.from(name, m.state());
const join = (...ms: CrdtMap[]) => {
  const out = new CrdtMap('join');
  for (const m of ms) out.merge(m);
  return out;
};
/** Deliver every operation to a replica in the given order; causal delivery sorts out the rest. */
const deliver = (to: CrdtMap, ops: readonly Op[]) => ops.forEach((o) => (o.replica === to.replica ? undefined : to.apply(o)));

test('vector clocks: order, merge and the causal delivery test', () => {
  assert.equal(compare({ a: 1 }, { a: 1 }), 'equal');
  assert.equal(compare({ a: 1 }, { a: 2, b: 1 }), 'before');
  assert.equal(compare({ a: 3 }, { a: 2 }), 'after');
  assert.equal(compare({ a: 2 }, { b: 1 }), 'concurrent');
  assert.equal(compare({}, {}), 'equal');
  assert.deepEqual(mergeClocks({ a: 2, b: 1 }, { a: 1, c: 4 }), { a: 2, b: 1, c: 4 });
  assert.equal(covers({ a: 2, b: 1 }, { a: 2 }), true);
  assert.equal(covers({ a: 2 }, { a: 3 }), false);
  assert.equal(covers({}, {}), true);
});

test('a register keeps concurrent writes and every replica picks the same winner', () => {
  const a = new CrdtMap('a');
  const b = new CrdtMap('b');
  const oa = a.set(['title'], 'from a');
  const ob = b.set(['title'], 'from b');
  a.apply(ob);
  b.apply(oa);
  assert.equal(a.get(['title']), 'from b', 'equal Lamport times: the higher replica id wins');
  assert.equal(b.get(['title']), 'from b');
  assert.deepEqual(a.conflicts(['title']), ['from a']);
  const later = a.set(['title'], 'resolved');
  b.apply(later);
  assert.deepEqual([a.get(['title']), b.get(['title']), a.conflicts(['title'])], ['resolved', 'resolved', []]);
});

test('causality beats replica order: a write made after seeing another always wins', () => {
  const z = new CrdtMap('z');
  const a = new CrdtMap('a');
  const oz = z.set(['k'], 'first by z');
  a.apply(oz);
  const oa = a.set(['k'], 'then a');
  z.apply(oa);
  assert.equal(z.get(['k']), 'then a');
  assert.equal(a.get(['k']), 'then a');
  assert.equal(z.get(['missing']), undefined);
});

test('a set: removing what you saw removes it, and a concurrent add wins', () => {
  const a = new CrdtMap('a');
  const b = new CrdtMap('b');
  const first = a.add(['tags'], 'x');
  b.apply(first);
  const second = a.add(['tags'], { n: 1, m: 2 });
  b.apply(second);
  assert.deepEqual(a.members(['tags']), ['x', { m: 2, n: 1 }], 'sorted by canonical text, objects by sorted keys');
  assert.equal(a.has(['tags'], { m: 2, n: 1 }), true, 'object key order does not matter');
  const rm = a.discard(['tags'], 'x');
  const readd = b.add(['tags'], 'x');
  a.apply(readd);
  b.apply(rm);
  assert.deepEqual(a.members(['tags']).includes('x'), true, 'the concurrent add survived the remove');
  assert.equal(fingerprint(a), fingerprint(b));
  assert.deepEqual(b.members(['tags']).includes('x'), true);
  const c = new CrdtMap('c');
  c.add(['s'], 1);
  c.add(['s'], 1);
  assert.deepEqual(c.members(['s']), [1], 'adding twice is one element');
  c.discard(['s'], 1);
  assert.deepEqual(c.members(['s']), []);
  c.discard(['s'], 99);
  assert.equal(c.has(['s'], 1), false);
});

test('counters add up across replicas, with negatives, and a repeated delivery counts once', () => {
  const [a, b, c] = ['a', 'b', 'c'].map((n) => new CrdtMap(n)) as [CrdtMap, CrdtMap, CrdtMap];
  const ops = [a.increment(['views'], 5), a.increment(['views'], 2), b.increment(['views'], -3), c.increment(['views'])];
  for (const m of [a, b, c]) deliver(m, ops);
  for (const m of [a, b, c]) deliver(m, ops);
  assert.deepEqual([a.count(['views']), b.count(['views']), c.count(['views'])], [5, 5, 5]);
  assert.equal(a.count(['nothing']), 0);
  assert.throws(() => a.increment(['views'], 1.5), CrdtError);
  assert.throws(() => a.increment(['views'], Number.MAX_SAFE_INTEGER * 2), CrdtError);
});

test('nested maps read as JSON, and writing a register replaces what is under it', () => {
  const m = new CrdtMap('a');
  m.set(['user', 'name'], 'Ann');
  m.add(['user', 'tags'], 'b');
  m.add(['user', 'tags'], 'a');
  m.increment(['stats', 'views'], 3);
  m.set(['list'], [1, { x: null }]);
  assert.deepEqual(m.toJSON(), { user: { name: 'Ann', tags: ['a', 'b'] }, stats: { views: 3 }, list: [1, { x: null }] });
  m.set(['user'], 'gone');
  assert.deepEqual(m.toJSON(), { user: 'gone', stats: { views: 3 }, list: [1, { x: null }] });
  assert.equal(m.exists(['user', 'name']), false);
  m.remove(['stats']);
  assert.deepEqual(Object.keys(m.toJSON() as object).sort(), ['list', 'user']);
});

test('removing a subtree loses to a concurrent write inside it, and keeps what was seen removed', () => {
  const a = new CrdtMap('a');
  const b = new CrdtMap('b');
  const setup = [a.set(['user', 'name'], 'Ann'), a.add(['user', 'tags'], 'x')];
  deliver(b, setup);
  const removal = a.remove(['user']);
  const write = b.set(['user', 'email'], 'ann@example.test');
  a.apply(write);
  b.apply(removal);
  assert.deepEqual(a.toJSON(), { user: { email: 'ann@example.test' } });
  assert.deepEqual(b.toJSON(), { user: { email: 'ann@example.test' } });
});

test('causal delivery: an early operation waits, a repeat is ignored, and nothing is resurrected', () => {
  const a = new CrdtMap('a');
  const b = new CrdtMap('b');
  const c = new CrdtMap('c');
  const o1 = a.add(['s'], 'x');
  b.apply(o1);
  const o2 = b.discard(['s'], 'x');
  assert.equal(c.apply(o2), 'buffered', 'the removal depends on an add this replica has not seen');
  assert.equal(c.pendingCount, 1);
  assert.equal(c.apply(o2), 'duplicate');
  assert.equal(c.apply(o1), 'applied');
  assert.equal(c.pendingCount, 0);
  assert.deepEqual(c.members(['s']), [], 'the removal was applied after the add, so x is gone');
  assert.equal(c.apply(o1), 'duplicate');
  const o3 = a.set(['k'], 1);
  const o4 = a.set(['k'], 2);
  const d = new CrdtMap('d');
  assert.equal(d.apply(o4), 'buffered');
  assert.equal(d.apply(o3), 'buffered', 'it needs the first operation, which d has not seen');
  assert.equal(d.apply(o1), 'applied');
  assert.deepEqual([d.get(['k']), d.pendingCount, d.clock()], [2, 0, { a: 3 }]);
});

test('replicas that exchange operations in any order reach the same state (50 random histories)', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const r = rng(seed);
    const names = ['a', 'b', 'c'];
    const reps = names.map((n) => new CrdtMap(n));
    const all: Op[] = [];
    const paths = [['x'], ['y'], ['p', 'q'], ['p', 'r'], ['s'], ['n']];
    for (let i = 0; i < 40; i++) {
      const m = reps[Math.floor(r() * 3)]!;
      const p = paths[Math.floor(r() * paths.length)]!;
      const kind = r();
      let op: Op;
      if (kind < 0.25) op = m.set(p, Math.floor(r() * 5));
      else if (kind < 0.45) op = m.add(['s'], Math.floor(r() * 4));
      else if (kind < 0.6) op = m.discard(['s'], Math.floor(r() * 4));
      else if (kind < 0.8) op = m.increment(['n'], Math.floor(r() * 7) - 3);
      else op = m.remove(p.length > 1 ? [p[0]!] : p);
      all.push(op);
      if (r() < 0.3) {
        const to = reps[Math.floor(r() * 3)]!;
        const some = all.filter(() => r() < 0.5).sort(() => r() - 0.5);
        deliver(to, some);
      }
    }
    for (const m of reps) deliver(m, [...all].sort(() => r() - 0.5));
    const fp = reps.map(fingerprint);
    assert.equal(fp[0], fp[1], `seed ${seed}`);
    assert.equal(fp[1], fp[2], `seed ${seed}`);
    assert.deepEqual(reps.map((m) => m.pendingCount), [0, 0, 0]);
    assert.deepEqual(reps[0]!.toJSON(), reps[2]!.toJSON());
  }
});

test('merging states is commutative, associative and idempotent (50 random histories)', () => {
  for (let seed = 100; seed < 150; seed++) {
    const r = rng(seed);
    const reps = ['a', 'b', 'c'].map((n) => new CrdtMap(n));
    for (let i = 0; i < 25; i++) {
      const m = reps[Math.floor(r() * 3)]!;
      const k = r();
      if (k < 0.3) m.set([['x', 'y', 'z'][Math.floor(r() * 3)]!], Math.floor(r() * 9));
      else if (k < 0.55) m.add(['s'], Math.floor(r() * 3));
      else if (k < 0.7) m.discard(['s'], Math.floor(r() * 3));
      else if (k < 0.85) m.increment(['n'], 1 + Math.floor(r() * 3));
      else m.remove([['x', 'y', 'z', 's'][Math.floor(r() * 4)]!]);
      if (r() < 0.25) reps[Math.floor(r() * 3)]!.merge(m);
    }
    const [a, b, c] = reps as [CrdtMap, CrdtMap, CrdtMap];
    assert.equal(fingerprint(join(a, b)), fingerprint(join(b, a)), `commutative ${seed}`);
    assert.equal(fingerprint(join(join(a, b), c)), fingerprint(join(a, join(b, c))), `associative ${seed}`);
    assert.equal(fingerprint(join(a, a)), fingerprint(join(a)), `idempotent ${seed}`);
    const merged = join(a, b, c);
    const viaOps = join(merged, merged);
    assert.deepEqual(viaOps.toJSON(), merged.toJSON());
  }
});

test('delivering operations and merging states reach the same value', () => {
  const a = new CrdtMap('a');
  const b = new CrdtMap('b');
  const ops = [a.set(['t'], 'A'), b.set(['t'], 'B'), a.add(['s'], 1), b.add(['s'], 2), a.increment(['n'], 4), b.increment(['n'], 5), a.remove(['s'])];
  const byOps = new CrdtMap('o');
  deliver(byOps, ops);
  const byState = join(a, b);
  assert.deepEqual(byOps.toJSON(), byState.toJSON());
  assert.deepEqual(byState.toJSON(), { t: 'B', s: [2], n: 9 });
  assert.equal(fingerprint(byOps), fingerprint(byState));
});

test('a stale state does not bring back what has been removed', () => {
  const a = new CrdtMap('a');
  a.add(['s'], 'x');
  const stale = a.state();
  a.discard(['s'], 'x');
  a.merge(stale);
  assert.deepEqual(a.members(['s']), []);
  const fresh = new CrdtMap('fresh');
  fresh.merge(stale);
  fresh.merge(a);
  assert.deepEqual(fresh.members(['s']), [], 'the later state, which has seen the add, removes it');
});

test('state survives JSON and rebuilds a replica', () => {
  const a = new CrdtMap('a');
  a.set(['k', 'v'], { deep: [1, 2] });
  a.add(['s'], 'x');
  a.increment(['n'], 7);
  const copy = CrdtMap.from('copy', JSON.parse(JSON.stringify(a.state())));
  assert.deepEqual(copy.toJSON(), a.toJSON());
  assert.deepEqual(copy.clock(), { a: 3 });
  const op = copy.set(['k', 'w'], 1);
  assert.equal(op.replica, 'copy');
  assert.equal(a.apply(op), 'applied');
});

test('hostile input is refused', () => {
  assert.throws(() => new CrdtMap('bad id!'), CrdtError);
  assert.throws(() => new CrdtMap(''), CrdtError);
  const m = new CrdtMap('a');
  assert.throws(() => m.set(['__proto__'], 1), /__proto__/);
  assert.throws(() => m.set([], 1), /needs a path/);
  assert.throws(() => m.set(Array.from({ length: 33 }, (_, i) => `k${i}`), 1), /at most 32/);
  assert.throws(() => m.set([''], 1), /non-empty/);
  assert.throws(() => m.set(['k'], 'x'.repeat(1_048_577)), /1 MiB/);
  assert.throws(() => m.set(['k'], Number.NaN), /finite/);
  const real = m.set(['k'], 1);
  const forged: Op = { ...real, n: 5, deps: { a: 4 } };
  assert.throws(() => m.apply(forged), /from the future/);
  const other = new CrdtMap('b');
  assert.throws(() => other.apply({ ...real, remove: ['not a dot'] }), /dots/);
  assert.throws(() => other.apply({ ...real, deps: { a: 7 } }), /one before/);
  assert.throws(() => other.apply({ ...real, replica: 'a b' }), CrdtError);
  assert.throws(() => other.apply({ ...real, add: { kind: 'ctr', path: ['c'], value: 1.5 } }), /whole number/);
  assert.throws(() => other.apply({ ...real, stamp: { t: 1, r: 'zzz' } }), /stamp/);
  assert.throws(() => other.apply(null as never), /not an operation/);
  assert.throws(() => other.merge({ clock: { 'bad name': 1 }, lamport: 0, entries: [] }), /replica names/);
});

test('the pending queue is bounded', () => {
  const a = new CrdtMap('a');
  a.set(['k'], 0);
  const ops = [a.set(['k'], 1), a.set(['k'], 2), a.set(['k'], 3), a.set(['k'], 4)];
  const b = new CrdtMap('b', { maxPending: 2 });
  assert.equal(b.apply(ops[1]!), 'buffered');
  assert.equal(b.apply(ops[2]!), 'buffered');
  assert.throws(() => b.apply(ops[3]!), /too many operations/);
});
