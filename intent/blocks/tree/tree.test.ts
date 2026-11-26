import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Exists, IntoItself, InvalidName, MissingParent, NotFound, Tree, memoryNodes, steps } from './index.ts';

const make = () => {
  let e = 0;
  let t = 1000;
  return new Tree(memoryNodes(), { etag: () => `e${++e}`, now: () => ++t });
};
const file = (size: number) => ({ size, blob: `b${size}` });

test('a change gives the node and every ancestor a new etag, and siblings keep theirs', async () => {
  const tr = make();
  await tr.mkdir('ana', 'a');
  await tr.mkdir('ana', 'a/b');
  await tr.mkdir('ana', 'c');
  const before = { root: (await tr.root('ana')).etag, a: (await tr.resolve('ana', 'a'))!.etag, b: (await tr.resolve('ana', 'a/b'))!.etag, c: (await tr.resolve('ana', 'c'))!.etag };
  await tr.put('ana', 'a/b/x.txt', file(10));
  assert.notEqual((await tr.root('ana')).etag, before.root);
  assert.notEqual((await tr.resolve('ana', 'a'))!.etag, before.a);
  assert.notEqual((await tr.resolve('ana', 'a/b'))!.etag, before.b);
  assert.equal((await tr.resolve('ana', 'c'))!.etag, before.c, 'an untouched folder keeps its etag, so a client skips it');
});

test('folder sizes are the sum of what is inside, through writes, overwrites and removals', async () => {
  const tr = make();
  await tr.mkdir('ana', 'a');
  await tr.put('ana', 'a/x', file(10));
  await tr.put('ana', 'a/y', file(5));
  assert.equal((await tr.resolve('ana', 'a'))!.size, 15);
  await tr.put('ana', 'a/x', file(3));
  assert.equal((await tr.resolve('ana', 'a'))!.size, 8);
  assert.equal((await tr.root('ana')).size, 8);
  await tr.remove('ana', 'a/y');
  assert.equal((await tr.root('ana')).size, 3);
});

test('an overwrite keeps the file id; a new file gets a new one', async () => {
  const tr = make();
  const a = await tr.put('ana', 'x', file(1));
  const b = await tr.put('ana', 'x', file(2));
  assert.equal(a.node.id, b.node.id);
  assert.equal(b.before?.size, 1);
  const c = await tr.put('ana', 'y', file(1));
  assert.notEqual(c.node.id, a.node.id);
});

test('a move between folders keeps the id, moves the size, and changes both sides', async () => {
  const tr = make();
  await tr.mkdir('ana', 'a');
  await tr.mkdir('ana', 'b');
  const { node } = await tr.put('ana', 'a/x', file(7));
  const bEtag = (await tr.resolve('ana', 'b'))!.etag;
  const rootSize = (await tr.root('ana')).size;
  const m = await tr.move('ana', 'a/x', 'b/y');
  assert.equal(m.node.id, node.id);
  assert.equal(await tr.resolve('ana', 'a/x'), undefined);
  assert.equal((await tr.resolve('ana', 'b/y'))!.id, node.id);
  assert.equal((await tr.resolve('ana', 'a'))!.size, 0);
  assert.equal((await tr.resolve('ana', 'b'))!.size, 7);
  assert.equal((await tr.root('ana')).size, rootSize, 'the root holds the same bytes after a move');
  assert.notEqual((await tr.resolve('ana', 'b'))!.etag, bEtag);
});

test('a move over an existing node needs overwrite, and reports what it replaced', async () => {
  const tr = make();
  await tr.put('ana', 'x', file(1));
  await tr.put('ana', 'y', file(2));
  await assert.rejects(tr.move('ana', 'x', 'y'), Exists);
  const r = await tr.move('ana', 'x', 'y', true);
  assert.equal(r.replaced.length, 1);
  assert.equal((await tr.root('ana')).size, 1);
});

test('a folder cannot be moved or copied inside itself', async () => {
  const tr = make();
  await tr.mkdir('ana', 'a');
  await tr.mkdir('ana', 'a/b');
  await assert.rejects(tr.move('ana', 'a', 'a/b/a'), IntoItself);
  await assert.rejects(tr.copy('ana', 'a', 'a/b/a'), IntoItself);
});

test('a copy makes new ids for the whole subtree and adds its size', async () => {
  const tr = make();
  await tr.mkdir('ana', 'a');
  const { node } = await tr.put('ana', 'a/x', file(4));
  const c = await tr.copy('ana', 'a', 'b');
  const x2 = (await tr.resolve('ana', 'b/x'))!;
  assert.notEqual(c.node.id, (await tr.resolve('ana', 'a'))!.id);
  assert.notEqual(x2.id, node.id);
  assert.equal(x2.blob, node.blob);
  assert.equal((await tr.root('ana')).size, 8);
});

test('a write into a missing folder is a missing parent, not a silent mkdir', async () => {
  const tr = make();
  await assert.rejects(tr.put('ana', 'no/such/x', file(1)), MissingParent);
  await assert.rejects(tr.remove('ana', 'nothing'), NotFound);
});

test('names that would break a client are refused', () => {
  assert.throws(() => steps('a/../b'), InvalidName);
  assert.throws(() => steps('a/ b'), InvalidName);
  assert.throws(() => steps(`a/${'x'.repeat(251)}`), InvalidName);
  assert.deepEqual(steps('/a//b/'), ['a', 'b']);
});

test('a removed subtree restores with the same ids, and the sizes come back', async () => {
  const tr = make();
  await tr.mkdir('ana', 'a');
  const { node } = await tr.put('ana', 'a/x', file(9));
  const gone = await tr.remove('ana', 'a');
  assert.equal((await tr.root('ana')).size, 0);
  await tr.restore('ana', 'a', gone);
  assert.equal((await tr.resolve('ana', 'a/x'))!.id, node.id);
  assert.equal((await tr.root('ana')).size, 9);
});

test('writes to one tree at the same moment are applied one after another, so no size is lost', async () => {
  const tr = make();
  await Promise.all(Array.from({ length: 50 }, (_, i) => tr.put('ana', `f${i}`, file(1))));
  assert.equal((await tr.root('ana')).size, 50);
  assert.equal((await tr.list(await tr.root('ana'))).length, 50);
});

test('properties change without changing the etag; owners never see each other', async () => {
  const tr = make();
  const { node } = await tr.put('ana', 'x', file(1));
  const p = await tr.setProps('ana', 'x', { '{http://owncloud.org/ns}favorite': '1' });
  assert.equal(p.etag, node.etag);
  assert.equal(await tr.resolve('ben', 'x'), undefined);
  assert.equal(await tr.pathOf((await tr.resolve('ana', 'x'))!), '/x');
});
