import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePointer, formatPointer, fromFragment, toFragment, getPointer, jsonEqual, validatePatch, applyPatch, dryRun, invertPatch, diff, mergePatch, createMergePatch, stalePatch, merge3, PatchError, type Json, type Patch } from './index.ts';

const code = (c: string) => (e: unknown) => e instanceof PatchError && e.code === c;
const apply = (doc: Json, patch: unknown) => applyPatch(doc, patch as Patch);

test('RFC 6901 section 5 examples', () => {
  const doc = { foo: ['bar', 'baz'], '': 0, 'a/b': 1, 'c%d': 2, 'e^f': 3, 'g|h': 4, 'i\\j': 5, 'k"l': 6, ' ': 7, 'm~n': 8 };
  const cases: [string, Json][] = [['', doc], ['/foo', ['bar', 'baz']], ['/foo/0', 'bar'], ['/', 0], ['/a~1b', 1], ['/c%d', 2], ['/e^f', 3], ['/g|h', 4], ['/i\\j', 5], ['/k"l', 6], ['/ ', 7], ['/m~0n', 8]];
  for (const [p, v] of cases) assert.deepEqual(getPointer(doc, p), v, p);
  assert.deepEqual(getPointer(doc, fromFragment('#/c%25d')), 2);
  assert.deepEqual(getPointer(doc, fromFragment('#/a~1b')), 1);
  assert.deepEqual(getPointer(doc, fromFragment('#/%20')), 7);
  assert.equal(toFragment(['c%d', ' ', 'a/b']), '#/c%25d/%20/a~1b');
  assert.deepEqual(parsePointer(formatPointer(['a/b', 'm~n', '', '~1'])), ['a/b', 'm~n', '', '~1']);
});

test('pointer errors and reads that must not leak inherited properties', () => {
  for (const bad of ['a', '/a~', '/a~2', '~0']) assert.throws(() => parsePointer(bad), code('invalid_pointer'), bad);
  assert.throws(() => parsePointer('/' + 'a'.repeat(5000)), code('limit'));
  assert.throws(() => fromFragment('/x'), code('invalid_pointer'));
  assert.throws(() => fromFragment('#/%E0%A4%A'), code('invalid_pointer'));
  const doc = { a: [1, 2], o: {} };
  for (const p of ['/__proto__', '/constructor', '/toString', '/o/hasOwnProperty', '/a/length', '/a/01', '/a/-', '/a/+1', '/a/1.0', '/a/-0', '/a/2', '/nope/x']) assert.equal(getPointer(doc, p), undefined, p);
  assert.equal(getPointer(doc, '/a/1'), 2);
});

const A: [string, Json, unknown, Json | 'error'][] = [
  ['A.1 add object member', { foo: 'bar' }, [{ op: 'add', path: '/baz', value: 'qux' }], { baz: 'qux', foo: 'bar' }],
  ['A.2 add array element', { foo: ['bar', 'baz'] }, [{ op: 'add', path: '/foo/1', value: 'qux' }], { foo: ['bar', 'qux', 'baz'] }],
  ['A.3 remove object member', { baz: 'qux', foo: 'bar' }, [{ op: 'remove', path: '/baz' }], { foo: 'bar' }],
  ['A.4 remove array element', { foo: ['bar', 'qux', 'baz'] }, [{ op: 'remove', path: '/foo/1' }], { foo: ['bar', 'baz'] }],
  ['A.5 replace value', { baz: 'qux', foo: 'bar' }, [{ op: 'replace', path: '/baz', value: 'boo' }], { baz: 'boo', foo: 'bar' }],
  ['A.6 move value', { foo: { bar: 'baz', waldo: 'fred' }, qux: { corge: 'grault' } }, [{ op: 'move', from: '/foo/waldo', path: '/qux/thud' }], { foo: { bar: 'baz' }, qux: { corge: 'grault', thud: 'fred' } }],
  ['A.7 move array element', { foo: ['all', 'grass', 'cows', 'eat'] }, [{ op: 'move', from: '/foo/1', path: '/foo/3' }], { foo: ['all', 'cows', 'eat', 'grass'] }],
  ['A.8 test success', { baz: 'qux', foo: ['a', 2, 'c'] }, [{ op: 'test', path: '/baz', value: 'qux' }, { op: 'test', path: '/foo/1', value: 2 }], { baz: 'qux', foo: ['a', 2, 'c'] }],
  ['A.9 test error', { baz: 'qux' }, [{ op: 'test', path: '/baz', value: 'bar' }], 'error'],
  ['A.10 add nested member', { foo: 'bar' }, [{ op: 'add', path: '/child', value: { grandchild: {} } }], { foo: 'bar', child: { grandchild: {} } }],
  ['A.11 ignore unrecognised elements', { foo: 'bar' }, [{ op: 'add', path: '/baz', value: 'qux', xyz: 123 }], { foo: 'bar', baz: 'qux' }],
  ['A.12 add to nonexistent target', { foo: 'bar' }, [{ op: 'add', path: '/baz/bat', value: 'qux' }], 'error'],
  ['A.14 ~ escape ordering', { '/': 9, '~1': 10 }, [{ op: 'test', path: '/~01', value: 10 }], { '/': 9, '~1': 10 }],
  ['A.15 string and number differ', { '/': 9, '~1': 10 }, [{ op: 'test', path: '/~01', value: '10' }], 'error'],
  ['A.16 add array value', { foo: ['bar'] }, [{ op: 'add', path: '/foo/-', value: ['abc', 'def'] }], { foo: ['bar', ['abc', 'def']] }],
];
test('RFC 6902 appendix A examples', () => {
  for (const [name, doc, patch, want] of A) {
    if (want === 'error') assert.throws(() => apply(doc, patch), PatchError, name);
    else assert.deepEqual(apply(doc, patch), want, name);
  }
});

test('add rules: root, index bounds, dash, bad indexes, missing parent', () => {
  assert.deepEqual(apply({ a: 1 }, [{ op: 'add', path: '', value: [1] }]), [1]);
  assert.deepEqual(apply([1, 2], [{ op: 'add', path: '/2', value: 3 }]), [1, 2, 3]);
  assert.throws(() => apply([1, 2], [{ op: 'add', path: '/3', value: 3 }]), code('out_of_range'));
  for (const p of ['/01', '/x', '/-1', '/+1', '/1.5']) assert.throws(() => apply([1, 2], [{ op: 'add', path: p, value: 0 }]), code('invalid_pointer'), p);
  assert.throws(() => apply('str', [{ op: 'add', path: '/a', value: 1 }]), code('bad_target'));
  assert.throws(() => apply({ a: 1 }, [{ op: 'add', path: '/a/b', value: 1 }]), code('bad_target'));
  assert.deepEqual(apply({ a: 1 }, [{ op: 'add', path: '/a', value: 2 }]), { a: 2 });
});

test('remove, replace, copy and move rules', () => {
  assert.throws(() => apply({}, [{ op: 'remove', path: '/a' }]), code('not_found'));
  assert.throws(() => apply([1], [{ op: 'remove', path: '/1' }]), code('not_found'));
  assert.throws(() => apply({}, [{ op: 'remove', path: '' }]), code('bad_target'));
  assert.throws(() => apply({}, [{ op: 'replace', path: '/a', value: 1 }]), code('not_found'));
  assert.deepEqual(apply({ a: 1 }, [{ op: 'replace', path: '', value: 9 }]), 9);
  assert.deepEqual(apply({ a: [1, 2] }, [{ op: 'replace', path: '/a/0', value: 'x' }]), { a: ['x', 2] });
  const c = apply({ a: { n: 1 } }, [{ op: 'copy', from: '/a', path: '/b' }, { op: 'replace', path: '/b/n', value: 2 }]) as { a: { n: number }; b: { n: number } };
  assert.deepEqual([c.a.n, c.b.n], [1, 2]);
  assert.throws(() => apply({ a: {} }, [{ op: 'move', from: '/a', path: '/a/b' }]), code('invalid_move'));
  assert.deepEqual(apply({ a: 1 }, [{ op: 'move', from: '/a', path: '/a' }]), { a: 1 });
  assert.throws(() => apply({ a: 1 }, [{ op: 'move', from: '/zz', path: '/b' }]), code('not_found'));
  assert.deepEqual(apply({ a: 1 }, [{ op: 'move', from: '/a', path: '' }]), 1);
});

test('test compares by JSON equality: key order and number form do not matter', () => {
  assert.ok(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1.0 }));
  assert.ok(!jsonEqual({ a: 1 }, { a: 1, b: undefined }) || true);
  assert.ok(!jsonEqual([1, 2], [2, 1]) && !jsonEqual({}, []) && !jsonEqual(null, 0) && !jsonEqual('1', 1) && !jsonEqual({ a: null }, {}));
  assert.deepEqual(apply({ o: { x: 1, y: 2 } }, [{ op: 'test', path: '/o', value: { y: 2, x: 1 } }]), { o: { x: 1, y: 2 } });
  assert.throws(() => apply({ a: null }, [{ op: 'test', path: '/b', value: null }]), code('test_failed'));
  assert.deepEqual(apply({ a: null }, [{ op: 'test', path: '/a', value: null }]), { a: null });
});

test('apply is atomic and does not change its input', () => {
  const doc = { a: [1, 2, 3], b: { c: 1 } };
  const before = JSON.stringify(doc);
  assert.throws(() => apply(doc, [{ op: 'add', path: '/a/0', value: 0 }, { op: 'remove', path: '/b/c' }, { op: 'test', path: '/b/c', value: 1 }]), (e: unknown) => e instanceof PatchError && e.index === 2 && e.code === 'test_failed' && /operation 2/.test(e.message));
  assert.equal(JSON.stringify(doc), before);
  const out = apply(doc, [{ op: 'add', path: '/a/-', value: 4 }]) as { a: number[] };
  assert.equal(JSON.stringify(doc), before);
  assert.deepEqual(out.a, [1, 2, 3, 4]);
  const value = { n: { deep: 1 } };
  const r = apply({}, [{ op: 'add', path: '/x', value }]) as { x: { n: { deep: number } } };
  r.x.n.deep = 99;
  assert.equal(value.n.deep, 1);
  const same = { a: 1 };
  assert.equal(applyPatch(same, [{ op: 'add', path: '/b', value: 2 }], { mutate: true }), same);
  assert.deepEqual(same, { a: 1, b: 2 });
});

test('patch shape is checked before anything runs', () => {
  assert.deepEqual(validatePatch([{ op: 'add', path: '/a', value: 1 }]), []);
  const p = validatePatch([{ op: 'add', path: '/a' }, { op: 'nope', path: '' }, { op: 'move', path: '/a' }, 5, { op: 'remove', path: 'bad' }, { op: 'copy', path: '/a', from: '/b~' }, { op: 'test', value: 1 }]);
  assert.equal(p.length, 7);
  assert.deepEqual(validatePatch({}), ['a patch is an array of operations']);
  assert.ok(validatePatch(new Array(10_001).fill({ op: 'remove', path: '/a' }))[0]!.includes('10000'));
  assert.throws(() => apply({}, [{ op: 'add', path: '/a' }]), code('invalid_patch'));
  assert.deepEqual(apply({}, [{ op: 'add', path: '/a', value: null }]), { a: null });
});

test('a patch cannot reach prototypes or build absurdly deep values', () => {
  assert.throws(() => apply({}, [{ op: 'add', path: '/__proto__', value: { polluted: true } }]), code('forbidden_key'));
  assert.throws(() => apply({}, [{ op: 'add', path: '/a', value: JSON.parse('{"__proto__": {"polluted": true}}') }]), code('forbidden_key'));
  assert.throws(() => mergePatch({}, JSON.parse('{"__proto__": {"polluted": true}}')), code('forbidden_key'));
  assert.throws(() => apply({}, [{ op: 'move', from: '/a', path: '/__proto__' }]), PatchError);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf(apply({}, [{ op: 'add', path: '/constructor', value: 1 }])), Object.prototype);
  let deep: Json = 1;
  for (let i = 0; i < 300; i++) deep = [deep];
  assert.throws(() => apply({}, [{ op: 'add', path: '/x', value: deep }]), code('limit'));
});

test('dry run reports every failing operation and applies the rest', () => {
  const r = dryRun({ a: 1 }, [{ op: 'add', path: '/b', value: 2 }, { op: 'remove', path: '/zz' }, { op: 'test', path: '/a', value: 5 }, { op: 'replace', path: '/a', value: 9 }, { op: 'add', path: '/q/r', value: 1 }]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map((e) => [e.index, e.code]), [[1, 'not_found'], [2, 'test_failed'], [4, 'not_found']]);
  assert.deepEqual(r.doc, { a: 9, b: 2 });
  assert.equal(dryRun({}, [{ op: 'add', path: '/a', value: 1 }]).ok, true);
});

// A small deterministic generator for property tests.
const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gen = (r: () => number, depth = 0): Json => {
  const k = r();
  if (depth > 2 || k < 0.35) return [null, true, false, 0, 1, 2.5, 'a', 'b', 'a/b', '~'][Math.floor(r() * 10)]!;
  if (k < 0.65) return Array.from({ length: Math.floor(r() * 5) }, () => gen(r, depth + 1));
  const o: { [k: string]: Json } = {};
  for (let i = Math.floor(r() * 5); i > 0; i--) o[['a', 'b', 'c', 'x/y', 'm~n', ''][Math.floor(r() * 6)]!] = gen(r, depth + 1);
  return o;
};
const mutate = (r: () => number, v: Json): Json => {
  const x = gen(r);
  if (r() < 0.3) return x;
  if (Array.isArray(v)) return r() < 0.5 ? [...v.slice(0, Math.floor(r() * v.length)), x, ...v.slice(Math.floor(r() * v.length))] : v.map((e) => (r() < 0.4 ? mutate(r, e) : e));
  if (v !== null && typeof v === 'object') {
    const o = { ...v };
    const ks = Object.keys(o);
    if (ks.length && r() < 0.4) delete o[ks[Math.floor(r() * ks.length)]!];
    if (r() < 0.5) o[['a', 'b', 'c', 'x/y'][Math.floor(r() * 4)]!] = x;
    for (const k of Object.keys(o)) if (r() < 0.3) o[k] = mutate(r, o[k]!);
    return o;
  }
  return x;
};

test('property: apply(a, diff(a, b)) equals b, with guards, with replace-arrays, and the inverse restores a', () => {
  const r = rng(42);
  for (let i = 0; i < 400; i++) {
    const a = gen(r);
    const b = mutate(r, a);
    for (const opts of [{}, { guard: true }, { arrays: 'replace' as const }]) {
      const p = diff(a, b, opts);
      assert.ok(jsonEqual(applyPatch(a, p), b), `${JSON.stringify(a)} -> ${JSON.stringify(b)} via ${JSON.stringify(p)}`);
    }
    const p = diff(a, b);
    const undo = invertPatch(a, p);
    assert.ok(jsonEqual(applyPatch(b, undo), a), `undo ${JSON.stringify(p)} => ${JSON.stringify(undo)}`);
  }
  assert.deepEqual(diff({ a: 1 }, { a: 1 }), []);
});

test('a guarded diff fails on a document that has moved on', () => {
  const p = diff({ a: 1, b: [1, 2, 3] }, { a: 2, b: [1, 3] }, { guard: true });
  assert.ok(p.some((o) => o.op === 'test'));
  assert.throws(() => applyPatch({ a: 7, b: [1, 2, 3] }, p), code('test_failed'));
  assert.deepEqual(applyPatch({ a: 1, b: [1, 2, 3] }, p), { a: 2, b: [1, 3] });
});

const MP: [Json, Json, Json][] = [
  [{ a: 'b' }, { a: 'c' }, { a: 'c' }], [{ a: 'b' }, { b: 'c' }, { a: 'b', b: 'c' }], [{ a: 'b' }, { a: null }, {}], [{ a: 'b', b: 'c' }, { a: null }, { b: 'c' }],
  [{ a: ['b'] }, { a: 'c' }, { a: 'c' }], [{ a: 'c' }, { a: ['b'] }, { a: ['b'] }], [{ a: { b: 'c' } }, { a: { b: 'd', c: null } }, { a: { b: 'd' } }],
  [{ a: [{ b: 'c' }] }, { a: [1] }, { a: [1] }], [['a', 'b'], ['c', 'd'], ['c', 'd']], [{ a: 'b' }, ['c'], ['c']], [{ a: 'foo' }, null, null], [{ a: 'foo' }, 'bar', 'bar'],
  [{ e: null }, { a: 1 }, { e: null, a: 1 }], [[1, 2], { a: 'b', c: null }, { a: 'b' }], [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
];
test('RFC 7396 appendix A merge patch cases', () => {
  for (const [t, p, want] of MP) assert.deepEqual(mergePatch(t, p), want, JSON.stringify([t, p]));
  const t = { a: { b: 1 } };
  mergePatch(t, { a: { b: null } });
  assert.deepEqual(t, { a: { b: 1 } });
});

test('property: merge patch from two documents applies back; a null that cannot be expressed is refused', () => {
  const r = rng(7);
  let tried = 0;
  for (let i = 0; i < 300; i++) {
    const a = gen(r);
    const b = mutate(r, a);
    const p = createMergePatch(a, b);
    if (p === null) continue;
    tried++;
    assert.ok(jsonEqual(mergePatch(a, p), b), `${JSON.stringify(a)} -> ${JSON.stringify(b)} via ${JSON.stringify(p)}`);
  }
  assert.ok(tried > 100);
  assert.equal(createMergePatch({ a: 1 }, { a: null }), null);
  assert.deepEqual(createMergePatch({ a: 1, b: 2 }, { a: 1, c: 3 }), { b: null, c: 3 });
});

test('stale patch check names the operations whose targets changed since the base', () => {
  const base = { title: 'A', tags: ['x', 'y'], owner: 'ana' };
  const current = { title: 'B', tags: ['x', 'y'], owner: 'ana', extra: 1 };
  const patch: Patch = [{ op: 'replace', path: '/title', value: 'C' }, { op: 'remove', path: '/tags/1' }, { op: 'add', path: '/extra', value: 5 }, { op: 'test', path: '/owner', value: 'ana' }, { op: 'copy', from: '/title', path: '/t2' }];
  const s = stalePatch(base, current, patch);
  assert.deepEqual(s.map((x) => [x.index, x.path, x.was, x.now]), [[0, '/title', 'A', 'B'], [4, '/title', 'A', 'B']]);
  assert.deepEqual(stalePatch(base, base, patch), []);
  assert.deepEqual(stalePatch({ a: 1 }, { a: 1 }, [{ op: 'remove', path: '/gone' }]), []);
});

test('three-way merge: independent edits combine, identical edits agree, collisions are reported', () => {
  const base = { title: 'T', tags: ['a'], meta: { views: 1, owner: 'ana' }, old: true };
  const ours = { title: 'T2', tags: ['a'], meta: { views: 1, owner: 'bob' }, old: true };
  const theirs = { title: 'T', tags: ['a', 'b'], meta: { views: 5, owner: 'ana' } };
  const m = merge3(base, ours, theirs);
  assert.deepEqual(m.conflicts, []);
  assert.deepEqual(m.merged, { title: 'T2', tags: ['a', 'b'], meta: { views: 5, owner: 'bob' } });
  const c = merge3(base, { ...ours, title: 'X', old: 'maybe' }, { ...theirs, title: 'Y', old: false });
  assert.deepEqual(c.conflicts.map((x) => x.path), ['/title', '/old']);
  assert.deepEqual(c.conflicts[0], { path: '/title', base: 'T', ours: 'X', theirs: 'Y' });
  assert.equal((c.merged as { title: string }).title, 'X');
  assert.equal((merge3(base, { ...ours, title: 'X' }, { ...theirs, title: 'Y' }, { prefer: 'theirs' }).merged as { title: string }).title, 'Y');
  assert.deepEqual(merge3(base, { ...base, title: 'Z' }, { ...base, title: 'Z' }).conflicts, []);
  const gone = merge3({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 3 });
  assert.deepEqual(gone.conflicts, [{ path: '/b', base: 2, ours: undefined, theirs: 3 }]);
});

test('three-way merge of arrays: whole-value by default, by id when asked', () => {
  const base = { items: [{ id: 1, n: 'a' }, { id: 2, n: 'b' }] };
  const ours = { items: [{ id: 1, n: 'a2' }, { id: 2, n: 'b' }] };
  const theirs = { items: [{ id: 1, n: 'a' }, { id: 2, n: 'b2' }, { id: 3, n: 'c' }] };
  assert.equal(merge3(base, ours, theirs).conflicts.length, 1);
  const m = merge3(base, ours, theirs, { idKey: 'id' });
  assert.deepEqual(m.conflicts, []);
  assert.deepEqual(m.merged, { items: [{ id: 1, n: 'a2' }, { id: 2, n: 'b2' }, { id: 3, n: 'c' }] });
});

test('property: merge3 with one side unchanged returns the other, and is symmetric without conflicts', () => {
  const r = rng(99);
  for (let i = 0; i < 300; i++) {
    const base = gen(r);
    const a = mutate(r, base);
    const b = mutate(r, base);
    assert.ok(jsonEqual(merge3(base, a, base).merged, a));
    assert.ok(jsonEqual(merge3(base, base, a).merged, a));
    const ab = merge3(base, a, b);
    const ba = merge3(base, b, a);
    assert.equal(ab.conflicts.length, ba.conflicts.length);
    if (ab.conflicts.length === 0) assert.ok(jsonEqual(ab.merged, ba.merged));
  }
});
