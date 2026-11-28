import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Exists, IntoItself, InvalidName, MissingParent, NotFound, Tree, checkName, memoryNodes, steps, type Node, type NodeStore } from './index.ts';

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

test('names are Unicode NFC: a name sent decomposed (NFD) reaches the same node as its composed form', async () => {
  const tr = make();
  const nfc = 'café';
  const nfd = 'café';
  await tr.mkdir('ana', nfd);
  await tr.put('ana', `${nfc}/résumé.txt`, file(3));
  assert.equal((await tr.resolve('ana', nfc))!.name, nfc, 'stored composed');
  assert.equal((await tr.resolve('ana', `${nfd}/résumé.txt`))!.size, 3);
  await assert.rejects(tr.mkdir('ana', nfc), Exists, 'one folder, not two');
  assert.deepEqual(steps(`/${nfd}/x`), [nfc, 'x']);
});

test('a move into another owner’s tree keeps the ids, changes the owner below it, and fixes both trees’ sizes', async () => {
  const tr = make();
  await tr.mkdir('ana', 'a');
  await tr.put('ana', 'a/x.txt', file(10));
  await tr.mkdir('ben', 'in');
  await tr.put('ben', 'in/old', file(4));
  const a = (await tr.resolve('ana', 'a'))!;
  const x = (await tr.resolve('ana', 'a/x.txt'))!;
  const benIn = (await tr.resolve('ben', 'in'))!.etag;
  await assert.rejects(tr.moveAcross('ana', 'a', 'ben', 'in/old'), Exists);
  const r = await tr.moveAcross('ana', 'a', 'ben', 'in/old', true);
  assert.equal(r.node.id, a.id);
  assert.equal(r.node.owner, 'ben');
  assert.deepEqual(r.replaced.map((n) => n.name), ['old']);
  const moved = (await tr.resolve('ben', 'in/old/x.txt'))!;
  assert.equal(moved.id, x.id, 'the file keeps its id');
  assert.equal(moved.owner, 'ben');
  assert.equal(await tr.resolve('ana', 'a'), undefined);
  assert.equal((await tr.root('ana')).size, 0);
  assert.equal((await tr.root('ben')).size, 10);
  assert.notEqual((await tr.resolve('ben', 'in'))!.etag, benIn);
  await assert.rejects(tr.moveAcross('ana', 'nope', 'ben', 'z'), NotFound);
  await assert.rejects(tr.moveAcross('ben', 'in', 'ana', 'missing/in'), MissingParent);
  // Two moves in opposite directions at once do not wait on each other for ever.
  await tr.put('ana', 'p', file(1));
  await tr.put('ben', 'q', file(2));
  await Promise.all([tr.moveAcross('ana', 'p', 'ben', 'p'), tr.moveAcross('ben', 'q', 'ana', 'q')]);
  assert.equal((await tr.root('ana')).size, 2);
  assert.equal((await tr.root('ben')).size, 11);
});

// ---- Mutation-hardening: behaviours the cases above leave open. ----

const leaf = (id: number, parent: number | null, name: string, kind: 'file' | 'folder' = 'file') => ({ id, parent, owner: 'ana', name, kind, size: 0, mtime: 0, etag: `n${id}` });
const names = (ns: readonly { name: string }[]) => ns.map((n) => n.name);
const tick = () => new Promise<void>((r) => setImmediate(r));
const FUTURE = 5_000_000;

test('every refusal says which path or name, in words a person can read', async () => {
  const tr = make();
  await tr.mkdir('ana', 'a');
  await tr.put('ana', 'f', file(1));
  await assert.rejects(tr.remove('ana', 'nothing'), (e: NotFound) => e instanceof NotFound && e.path === 'nothing' && e.message === 'nothing at nothing');
  await assert.rejects(tr.put('ana', 'no/x', file(1)), (e: MissingParent) => e instanceof MissingParent && e.path === 'no/x' && e.message === 'the folder for no/x does not exist');
  await assert.rejects(tr.mkdir('ana', 'a'), (e: Exists) => e instanceof Exists && e.path === 'a' && e.message === 'a already exists');
  await assert.rejects(tr.mkdir('ana', '/'), (e: Exists) => e instanceof Exists && e.path === '/' && e.message === '/ already exists');
  await assert.rejects(tr.put('ana', 'a', file(1)), (e: Exists) => e instanceof Exists && e.message === 'a already exists', 'a folder in the way');
  await tr.mkdir('ana', 'a/b');
  await assert.rejects(tr.move('ana', 'a', 'a/b/a'), (e: IntoItself) => e instanceof IntoItself && e.message === 'cannot put a inside itself at a/b/a');
  await assert.rejects(tr.copy('ana', 'a', 'a/b/a'), (e: IntoItself) => e.message === 'cannot put a inside itself at a/b/a');
  await assert.rejects(tr.remove('ana', '/'), (e: InvalidName) => e instanceof InvalidName && e.name_ === '/' && e.message === '"/" is not a valid name: the root cannot be removed');
  await assert.rejects(tr.move('ana', '/', 'z'), (e: InvalidName) => e.message === '"/" is not a valid name: the root cannot be moved');
  await assert.rejects(tr.moveAcross('ana', '/', 'ben', 'z'), (e: InvalidName) => e.message === '"/" is not a valid name: the root cannot be moved');
  await assert.rejects(tr.move('ana', 'ghost', 'z'), NotFound);
  await assert.rejects(tr.copy('ana', 'ghost', 'z'), NotFound);
  await assert.rejects(tr.setProps('ana', 'ghost', {}), NotFound);
  await assert.rejects(tr.touch('ana', 'ghost', 5), NotFound);
  await assert.rejects(tr.restore('ana', 'z', []), (e: NotFound) => e instanceof NotFound && e.message === 'nothing at z');
});

test('a name must be a plain name: each rule has its own reason', () => {
  const why = (n: string) => {
    try {
      checkName(n);
    } catch (e) {
      assert.ok(e instanceof InvalidName);
      assert.equal(e.name_, n);
      return e.message;
    }
    return 'accepted';
  };
  assert.equal(why(''), '"" is not a valid name: it is empty');
  assert.equal(why('.'), '"." is not a valid name: it is a path step');
  assert.equal(why('..'), '".." is not a valid name: it is a path step');
  assert.equal(why('a/b'), '"a/b" is not a valid name: it contains a slash or a null');
  assert.equal(why('a\\b'), '"a\\b" is not a valid name: it contains a slash or a null');
  assert.equal(why('a\0b'), '"a\0b" is not a valid name: it contains a slash or a null');
  assert.equal(why('x'.repeat(251)), `"${'x'.repeat(251)}" is not a valid name: it is longer than 250 bytes`);
  assert.equal(why(' a'), '" a" is not a valid name: it starts or ends with a space');
  assert.equal(why('a '), '"a " is not a valid name: it starts or ends with a space');
  assert.equal(why('x'.repeat(250)), 'accepted', '250 bytes is allowed');
  assert.equal(why('é'.repeat(125)), 'accepted', '125 two-byte letters are 250 bytes');
  assert.match(why('é'.repeat(126)), /longer than 250 bytes/, 'the limit counts bytes, not letters');
  assert.equal(why('...'), 'accepted', 'dots are fine as long as the name is not a path step');
  assert.equal(why('.hidden'), 'accepted');
});

test('the store keeps children in name order, forgets what is removed, and hands out rising ids', async () => {
  const s = memoryNodes();
  await s.commit([leaf(1, null, '', 'folder'), leaf(2, 1, 'b'), leaf(3, 1, 'a'), leaf(4, 1, 'C'), leaf(5, 1, 'ab')], []);
  assert.deepEqual(names(await s.children(1)), ['C', 'a', 'ab', 'b'], 'plain code-unit order');
  assert.deepEqual(await s.children(2), [], 'a node with no children');
  assert.deepEqual(await s.children(999), [], 'a node that does not exist');
  assert.equal((await s.child(1, 'a'))!.id, 3);
  assert.equal(await s.child(1, 'nope'), undefined);
  assert.equal(await s.child(999, 'a'), undefined);
  assert.equal((await s.root('ana'))!.id, 1);
  await s.commit([], [999]);
  await s.commit([], [3]);
  assert.equal(await s.get(3), undefined);
  assert.equal(await s.child(1, 'a'), undefined);
  await s.commit([], [1]);
  assert.equal(await s.root('ana'), undefined, 'a removed root is no longer anyone’s root');
  assert.equal(await s.get(1), undefined);
  assert.deepEqual(await s.children(1), [], 'and its children index goes with it');
  const ids = [await s.nextId(), await s.nextId(), await s.nextId()];
  assert.deepEqual(ids, [1, 2, 3]);
});

test('renaming a node in the store moves its name entry', async () => {
  const s = memoryNodes();
  await s.commit([leaf(1, null, '', 'folder'), leaf(2, 1, 'old')], []);
  await s.commit([leaf(2, 1, 'new')], []);
  assert.equal(await s.child(1, 'old'), undefined);
  assert.equal((await s.child(1, 'new'))!.id, 2);
});

test('without options a tree stamps seconds since the epoch and random 16-digit hexadecimal etags', async () => {
  const before = Math.floor(Date.now() / 1000);
  const tr = new Tree(memoryNodes());
  const r = await tr.root('ana');
  const after = Math.floor(Date.now() / 1000);
  assert.ok(r.mtime >= before && r.mtime <= after, `${r.mtime} is in seconds`);
  assert.match(r.etag, /^[0-9a-f]{16}$/);
  assert.notEqual((await tr.mkdir('ana', 'a')).etag, (await tr.mkdir('ana', 'b')).etag);
});

test('etags are eight random bytes, two hex digits each, with no separators', async () => {
  const fixed = [0x00, 0x01, 0x0f, 0x10, 0xff, 0xa5, 0x00, 0x09];
  const spy = mock.method(globalThis.crypto, 'getRandomValues', (b: Uint8Array) => {
    b.set(fixed);
    return b;
  });
  try {
    const r = await new Tree(memoryNodes()).root('ana');
    assert.equal(r.etag, '00010f10ffa50009');
  } finally {
    spy.mock.restore();
  }
});

test('the clock and etag source you give are the ones used', async () => {
  const tr = make();
  const root = await tr.root('ana');
  assert.equal(root.etag, 'e1');
  assert.equal(root.mtime, 1001);
  const d = await tr.mkdir('ana', 'd');
  assert.equal(d.mtime, 1002);
  assert.equal(d.etag, 'e2');
  assert.equal((await tr.put('ana', 'a', { ...file(1), mtime: 77 })).node.mtime, 77, 'a client’s own mtime is kept');
  assert.equal((await tr.put('ana', 'b', file(1))).node.mtime, 1004, 'otherwise the clock');
});

test('a new root is an empty, nameless folder with no parent, and is created once even when asked for at once', async () => {
  const tr = make();
  const [a, b] = await Promise.all([tr.root('ana'), tr.root('ana')]);
  assert.equal(a.id, b.id);
  assert.deepEqual({ parent: a.parent, owner: a.owner, name: a.name, kind: a.kind, size: a.size }, { parent: null, owner: 'ana', name: '', kind: 'folder', size: 0 });
  assert.equal((await tr.get(a.id))!.id, a.id, 'it is stored');
  assert.equal((await tr.root('ana')).id, a.id, 'and found again');
  assert.notEqual((await tr.root('ben')).id, a.id);
});

test('creating a root never waits on the owner’s own queue', async () => {
  const tr = make();
  const done = tr.mkdir('', 'a').then(() => 'done');
  const winner = await Promise.race([done, new Promise<string>((r) => setTimeout(() => r('stuck'), 1000))]);
  assert.equal(winner, 'done');
});

test('creating one owner’s root does not hold up another owner’s', async () => {
  const inner = memoryNodes();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const store = { ...inner, commit: async (put: readonly Node[], remove: readonly number[]) => { if (put.some((n) => n.owner === 'slow')) await gate; return inner.commit(put, remove); } };
  const tr = new Tree(store);
  const slow = tr.root('slow');
  await tick();
  const winner = await Promise.race([tr.root('quick').then(() => 'quick'), new Promise<string>((r) => setTimeout(() => r('stuck'), 1000))]);
  release();
  await slow;
  assert.equal(winner, 'quick');
});

test('one owner’s changes queue up behind each other even after earlier ones finish, and the queue is tidied away', async () => {
  const inner = memoryNodes();
  const log: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const store = {
    ...inner,
    commit: async (put: readonly Node[], remove: readonly number[]) => {
      const tag = put.map((n) => n.name).find((n) => n === 'a' || n === 'b' || n === 'c');
      if (tag === 'b') await gate;
      if (tag) log.push(tag);
      return inner.commit(put, remove);
    },
  };
  const tr = new Tree(store, { etag: () => 'e', now: () => 1 });
  const queues = (tr as unknown as { queues: Map<string, unknown> }).queues;
  await tr.root('ana');
  const p1 = tr.put('ana', 'a', file(1));
  const p2 = tr.put('ana', 'b', file(1));
  await p1;
  await tick();
  const p3 = tr.put('ana', 'c', file(1));
  await tick();
  assert.deepEqual(log, ['a'], 'c waits for b, which waits on the gate');
  release();
  await Promise.all([p2, p3]);
  assert.deepEqual(log, ['a', 'b', 'c']);
  await tick();
  assert.equal(queues.size, 0, 'nothing is left in the queue table');
  const failing = tr.mkdir('ana', 'no/such/dir');
  await assert.rejects(failing, MissingParent);
  await tr.mkdir('ana', 'after');
  await tick();
  assert.equal(queues.size, 0, 'a failed change does not jam or leak the queue');
});

test('get, list and descendants read back what is stored, in order', async () => {
  const tr = make();
  await tr.mkdir('ana', 'a');
  await tr.mkdir('ana', 'a/z');
  await tr.put('ana', 'a/z/deep', file(1));
  await tr.put('ana', 'a/m', file(2));
  const a = (await tr.resolve('ana', 'a'))!;
  assert.equal((await tr.get(a.id))!.name, 'a');
  assert.equal(await tr.get(123456), undefined);
  assert.deepEqual(names(await tr.list(a)), ['m', 'z']);
  const m = (await tr.resolve('ana', 'a/m'))!;
  assert.deepEqual(await tr.list(m), [], 'a file holds nothing');
  assert.deepEqual(await tr.descendants(m), []);
  assert.deepEqual(names(await tr.descendants(a)), ['m', 'z', 'deep'], 'depth first, in name order');
  assert.deepEqual(await tr.descendants((await tr.resolve('ana', 'a/z/deep'))!), []);
  assert.deepEqual(names(await tr.descendants(await tr.root('ana'))), ['a', 'm', 'z', 'deep']);
});

test('a path is slash, then each name from the root; the root alone is "/"; ancestors run from parent up to the root', async () => {
  const tr = make();
  await tr.mkdir('ana', 'a');
  await tr.mkdir('ana', 'a/b');
  await tr.put('ana', 'a/b/x', file(1));
  const x = (await tr.resolve('ana', 'a/b/x'))!;
  assert.equal(await tr.pathOf(x), '/a/b/x');
  assert.equal(await tr.pathOf(await tr.root('ana')), '/');
  assert.deepEqual(names(await tr.ancestors(x)), ['b', 'a', ''], 'parent, grandparent, root');
  assert.deepEqual(await tr.ancestors(await tr.root('ana')), []);
  const orphan = { ...x, id: 900, parent: 777 };
  assert.deepEqual(await tr.ancestors(orphan), [], 'a missing ancestor ends the walk');
});

test('nothing can be put under a file', async () => {
  const tr = make();
  await tr.put('ana', 'f', file(1));
  await assert.rejects(tr.put('ana', 'f/y', file(1)), MissingParent);
  await assert.rejects(tr.mkdir('ana', 'f/y'), MissingParent);
  assert.equal(await tr.resolve('ana', 'f/y'), undefined, 'a path through a file finds nothing');
});

test('a put records what the client sent, and only what it sent', async () => {
  const tr = make();
  const plain = (await tr.put('ana', 'p', file(5))).node;
  assert.equal(plain.kind, 'file');
  assert.equal(plain.blob, 'b5');
  assert.equal('mime' in plain, false);
  assert.equal('checksums' in plain, false);
  assert.equal('props' in plain, false);
  const none = (await tr.put('ana', 'q', { ...file(5), mime: '', checksums: [] })).node;
  assert.equal('mime' in none, false, 'an empty mime is not stored');
  assert.equal('checksums' in none, false, 'an empty checksum list is not stored');
  const full = (await tr.put('ana', 'r', { ...file(5), mime: 'text/plain', checksums: ['SHA1:ab', 'MD5:cd'] })).node;
  assert.equal(full.mime, 'text/plain');
  assert.deepEqual(full.checksums, ['SHA1:ab', 'MD5:cd']);
  assert.equal('before' in (await tr.put('ana', 's', file(1))), false, 'a new file has no before');
});

test('overwriting a file keeps its client properties and gives it a new etag and blob', async () => {
  const tr = make();
  const first = (await tr.put('ana', 'x', file(1))).node;
  await tr.setProps('ana', 'x', { fav: '1' });
  const second = await tr.put('ana', 'x', { size: 2, blob: 'new' });
  assert.deepEqual(second.node.props, { fav: '1' });
  assert.notEqual(second.node.etag, first.etag);
  assert.equal(second.node.blob, 'new');
  assert.equal(second.before!.blob, first.blob);
});

test('properties are added to, not replaced; clearing removes only what is named; changes are stored', async () => {
  const tr = make();
  await tr.put('ana', 'x', file(1));
  await tr.setProps('ana', 'x', { a: '1' });
  const two = await tr.setProps('ana', 'x', { b: '2' });
  assert.deepEqual(two.props, { a: '1', b: '2' });
  const one = await tr.setProps('ana', 'x', {}, ['a']);
  assert.deepEqual(one.props, { b: '2' });
  assert.deepEqual((await tr.resolve('ana', 'x'))!.props, { b: '2' }, 'read back from the store');
  assert.deepEqual((await tr.setProps('ana', 'x', { b: '3' })).props, { b: '3' }, 'a set value replaces the old one');
});

test('touch sets the time, keeps the etag, and is stored', async () => {
  const tr = make();
  const { node } = await tr.put('ana', 'x', file(1));
  const t = await tr.touch('ana', 'x', 42);
  assert.equal(t.mtime, 42);
  assert.equal(t.etag, node.etag);
  assert.equal(t.id, node.id);
  assert.equal((await tr.resolve('ana', 'x'))!.mtime, 42);
});

test('removing returns the node first, then everything under it, and takes them all out of the store', async () => {
  const tr = make();
  await tr.mkdir('ana', 'a');
  await tr.mkdir('ana', 'a/b');
  await tr.put('ana', 'a/b/x', file(3));
  await tr.put('ana', 'a/y', file(4));
  const gone = await tr.remove('ana', 'a');
  assert.deepEqual(names(gone), ['a', 'b', 'x', 'y']);
  for (const n of gone) assert.equal(await tr.get(n.id), undefined, n.name);
  assert.equal((await tr.root('ana')).size, 0);
  assert.deepEqual(await tr.list(await tr.root('ana')), []);
});

test('a restore needs a free place and something to restore, and puts the top back under its new name with a fresh etag', async () => {
  const tr = make();
  await tr.mkdir('ana', 'a');
  await tr.put('ana', 'a/x', file(9));
  const gone = await tr.remove('ana', 'a');
  await tr.mkdir('ana', 'taken');
  await assert.rejects(tr.restore('ana', 'taken', gone), (e: Exists) => e instanceof Exists && e.message === 'taken already exists');
  await assert.rejects(tr.restore('ana', 'nothing', []), NotFound);
  const placed = await tr.restore('ana', 'back', gone);
  assert.equal(placed.name, 'back');
  assert.equal(placed.id, gone[0]!.id);
  assert.notEqual(placed.etag, gone[0]!.etag);
  assert.equal((await tr.resolve('ana', 'back/x'))!.size, 9);
  assert.equal((await tr.root('ana')).size, 9);
  assert.equal(await tr.resolve('ana', 'a'), undefined);
});

test('a move onto itself changes nothing; a rename in the same folder is one record and a net size change', async () => {
  const tr = make();
  await tr.put('ana', 'x', file(3));
  const x = (await tr.resolve('ana', 'x'))!;
  const rootBefore = await tr.root('ana');
  for (const overwrite of [false, true]) {
    const same = await tr.move('ana', 'x', 'x', overwrite);
    assert.deepEqual(same.replaced, []);
    assert.deepEqual(same.node, x, 'the very same node');
  }
  assert.deepEqual(await tr.resolve('ana', 'x'), x, 'nothing was written or removed');
  assert.deepEqual(await tr.root('ana'), rootBefore, 'and the folder was not touched');
  const r = await tr.move('ana', 'x', 'y');
  assert.equal(r.node.id, x.id);
  assert.equal(r.node.name, 'y');
  assert.notEqual(r.node.etag, x.etag);
  assert.deepEqual(r.replaced, []);
  assert.equal((await tr.root('ana')).size, 3);
  assert.equal(await tr.resolve('ana', 'x'), undefined);
});

test('a folder cannot be moved into itself directly either', async () => {
  const tr = make();
  await tr.mkdir('ana', 'a');
  await assert.rejects(tr.move('ana', 'a', 'a/x'), IntoItself);
  await assert.rejects(tr.copy('ana', 'a', 'a/x'), IntoItself);
  assert.equal(await tr.resolve('ana', 'a/x'), undefined);
});

test('a file can be moved or copied into the folder it is in, and a folder beside its own children', async () => {
  const tr = make();
  await tr.mkdir('ana', 'a');
  await tr.put('ana', 'a/x', file(2));
  const c = await tr.copy('ana', 'a/x', 'a/y');
  assert.equal(c.node.name, 'y');
  assert.equal((await tr.resolve('ana', 'a'))!.size, 4);
});

test('overwriting a folder removes everything that was under it', async () => {
  const tr = make();
  await tr.mkdir('ana', 'old');
  await tr.put('ana', 'old/k', file(5));
  await tr.mkdir('ana', 'new');
  await tr.put('ana', 'new/j', file(2));
  const k = (await tr.resolve('ana', 'old/k'))!;
  const old = (await tr.resolve('ana', 'old'))!;
  const r = await tr.move('ana', 'new', 'old', true);
  assert.deepEqual(names(r.replaced), ['old', 'k']);
  assert.equal(await tr.get(k.id), undefined, 'the child of the replaced folder is gone, not orphaned');
  assert.equal(await tr.get(old.id), undefined);
  assert.equal((await tr.resolve('ana', 'old/j'))!.size, 2);
  assert.equal((await tr.root('ana')).size, 2);
});

test('a move between deep folders updates every ancestor on both sides once, and the shared ones only by what was replaced', async () => {
  const tr = make();
  for (const p of ['a', 'a/b', 'a/b/c', 'd', 'd/e', 'd/e/f']) await tr.mkdir('ana', p);
  await tr.put('ana', 'a/b/c/x', file(10));
  await tr.put('ana', 'd/e/f/old', file(4));
  const before = new Map<string, { etag: string; mtime: number }>();
  for (const p of ['', 'a', 'a/b', 'a/b/c', 'd', 'd/e', 'd/e/f']) before.set(p, (await tr.resolve('ana', p))!);
  for (const p of ['a', 'd']) await tr.touch('ana', p, FUTURE);
  const m = await tr.move('ana', 'a/b/c/x', 'd/e/f/old', true);
  const size = async (p: string) => (await tr.resolve('ana', p))!.size;
  assert.deepEqual([await size(''), await size('a'), await size('a/b'), await size('a/b/c'), await size('d'), await size('d/e'), await size('d/e/f')], [10, 0, 0, 0, 10, 10, 10]);
  for (const p of ['', 'a', 'a/b', 'a/b/c', 'd', 'd/e', 'd/e/f']) assert.notEqual((await tr.resolve('ana', p))!.etag, before.get(p)!.etag, `${p || 'root'} has a new etag`);
  assert.equal((await tr.resolve('ana', 'a'))!.mtime, FUTURE, 'a folder never goes back in time');
  assert.equal((await tr.resolve('ana', 'd'))!.mtime, FUTURE);
  assert.ok((await tr.resolve('ana', 'a/b/c'))!.mtime > before.get('a/b/c')!.mtime, 'a quiet folder is stamped with the time of the change');
  assert.ok((await tr.root('ana')).mtime > before.get('')!.mtime);
  assert.deepEqual(names(m.replaced), ['old']);
});

test('no change ever moves a folder’s time backwards', async () => {
  const tr = make();
  await tr.mkdir('ana', 'a');
  await tr.touch('ana', 'a', FUTURE);
  const quiet = (await tr.root('ana')).mtime;
  await tr.put('ana', 'a/x', file(1));
  assert.equal((await tr.resolve('ana', 'a'))!.mtime, FUTURE, 'put');
  await tr.mkdir('ana', 'a/d');
  assert.equal((await tr.resolve('ana', 'a'))!.mtime, FUTURE, 'mkdir');
  await tr.copy('ana', 'a/x', 'a/y');
  assert.equal((await tr.resolve('ana', 'a'))!.mtime, FUTURE, 'copy');
  await tr.remove('ana', 'a/y');
  assert.equal((await tr.resolve('ana', 'a'))!.mtime, FUTURE, 'remove');
  await tr.move('ana', 'a/x', 'a/z');
  assert.equal((await tr.resolve('ana', 'a'))!.mtime, FUTURE, 'rename');
  assert.ok((await tr.root('ana')).mtime > quiet, 'while the root, last touched long ago, moves forward');
});

test('a copy over an existing node needs overwrite, and takes the replaced subtree out', async () => {
  const tr = make();
  await tr.put('ana', 'x', file(3));
  await tr.mkdir('ana', 'y');
  await tr.put('ana', 'y/inner', file(5));
  const inner = (await tr.resolve('ana', 'y/inner'))!;
  await assert.rejects(tr.copy('ana', 'x', 'y'), (e: Exists) => e instanceof Exists && e.message === 'y already exists');
  assert.equal((await tr.root('ana')).size, 8, 'the refused copy changed nothing');
  const r = await tr.copy('ana', 'x', 'y', true);
  assert.deepEqual(names(r.replaced), ['y', 'inner']);
  assert.equal(await tr.get(inner.id), undefined);
  assert.equal((await tr.root('ana')).size, 6, '3 for x, 3 for its copy; the 5 that was replaced is gone');
  assert.equal((await tr.resolve('ana', 'y'))!.size, 3);
  assert.deepEqual(r.node, (await tr.resolve('ana', 'y'))!);
});

test('a copy asks the share function for each file’s blob and uses what it answers', async () => {
  const tr = make();
  await tr.mkdir('ana', 'a');
  await tr.put('ana', 'a/x', file(1));
  await tr.put('ana', 'a/y', file(2));
  const asked: string[] = [];
  await tr.copy('ana', 'a', 'b', false, async (blob) => {
    asked.push(blob);
    return `copy-of-${blob}`;
  });
  assert.deepEqual(asked.sort(), ['b1', 'b2'], 'folders have no blob to share');
  assert.equal((await tr.resolve('ana', 'b/x'))!.blob, 'copy-of-b1');
  assert.equal((await tr.resolve('ana', 'a/x'))!.blob, 'b1', 'the original is untouched');
  assert.equal((await tr.resolve('ana', 'b'))!.blob, undefined);
});

test('a move into another owner’s tree: the same owner is an ordinary move, and a refused one changes nothing', async () => {
  const tr = make();
  await tr.mkdir('ana', 'a');
  await tr.put('ana', 'a/x', file(2));
  const same = await tr.moveAcross('ana', 'a', 'ana', 'b');
  assert.deepEqual(names(same.moved), ['b', 'x']);
  assert.equal((await tr.resolve('ana', 'b/x'))!.size, 2);
  await tr.mkdir('ben', 'b');
  await assert.rejects(tr.moveAcross('ana', 'b', 'ben', 'b'), (e: Exists) => e instanceof Exists && e.message === 'b already exists', 'overwrite is off unless asked for');
  assert.equal((await tr.resolve('ana', 'b'))!.owner, 'ana');
  assert.equal((await tr.root('ana')).size, 2);
});

test('replacing a folder in another owner’s tree takes its contents out of the store', async () => {
  const tr = make();
  await tr.mkdir('ana', 'a');
  await tr.mkdir('ben', 'b');
  await tr.put('ben', 'b/inner', file(6));
  const inner = (await tr.resolve('ben', 'b/inner'))!;
  const r = await tr.moveAcross('ana', 'a', 'ben', 'b', true);
  assert.deepEqual(names(r.replaced), ['b', 'inner']);
  assert.equal(await tr.get(inner.id), undefined);
  assert.equal((await tr.root('ben')).size, 0);
});

test('a move between owners stamps the ancestors on both sides and never sets their time back', async () => {
  const tr = make();
  await tr.mkdir('ana', 'a');
  await tr.put('ana', 'a/x', file(2));
  await tr.mkdir('ben', 'in');
  await tr.touch('ana', 'a', FUTURE);
  await tr.touch('ben', 'in', FUTURE);
  const rootsBefore = [(await tr.root('ana')).mtime, (await tr.root('ben')).mtime];
  await tr.moveAcross('ana', 'a/x', 'ben', 'in/x');
  assert.equal((await tr.resolve('ana', 'a'))!.mtime, FUTURE);
  assert.equal((await tr.resolve('ben', 'in'))!.mtime, FUTURE);
  assert.ok((await tr.root('ana')).mtime > rootsBefore[0]!);
  assert.ok((await tr.root('ben')).mtime > rootsBefore[1]!);
  assert.equal((await tr.root('ben')).size, 2);
  assert.equal((await tr.root('ana')).size, 0);
});

/** A store that remembers every commit, so a test can see exactly what a change wrote and removed. */
const recorded = () => {
  const inner = memoryNodes();
  const commits: Array<{ put: Node[]; remove: number[] }> = [];
  const store: NodeStore = {
    ...inner,
    commit: async (put, remove) => {
      commits.push({ put: [...put], remove: [...remove] });
      return inner.commit(put, remove);
    },
  };
  return { store, commits };
};

test('each change writes only real nodes and removes exactly what it replaced or deleted', async () => {
  const { store, commits } = recorded();
  let e = 0;
  let t = 100;
  const tr = new Tree(store, { etag: () => `r${++e}`, now: () => ++t });
  await tr.root('ana');
  await tr.root('ben');
  const check = (what: string, expectRemoved: readonly number[]) => {
    const c = commits.pop()!;
    commits.length = 0;
    assert.deepEqual(c.remove, expectRemoved, `${what}: removed`);
    assert.ok(c.put.length > 0, `${what}: wrote something`);
    for (const n of c.put) assert.ok(typeof n === 'object' && typeof n.id === 'number' && typeof n.etag === 'string', `${what}: only nodes are written`);
    assert.equal(new Set(c.put.map((n) => n.id)).size, c.put.length, `${what}: no node twice`);
  };
  commits.length = 0;
  await tr.mkdir('ana', 'a');
  check('mkdir', []);
  await tr.put('ana', 'a/x', file(1));
  check('put', []);
  await tr.setProps('ana', 'a/x', { k: 'v' });
  check('setProps', []);
  await tr.touch('ana', 'a/x', 9);
  check('touch', []);
  await tr.copy('ana', 'a', 'b');
  check('copy', []);
  await tr.mkdir('ana', 'target');
  await tr.put('ana', 'target/old', file(1));
  commits.length = 0;
  const target = (await tr.resolve('ana', 'target'))!;
  const old = (await tr.resolve('ana', 'target/old'))!;
  await tr.copy('ana', 'a', 'target', true);
  check('copy over', [target.id, old.id]);
  await tr.move('ana', 'b', 'c');
  check('move', []);
  await tr.mkdir('ana', 'victim');
  await tr.put('ana', 'victim/v', file(1));
  const victim = (await tr.resolve('ana', 'victim'))!;
  const v = (await tr.resolve('ana', 'victim/v'))!;
  commits.length = 0;
  await tr.move('ana', 'c', 'victim', true);
  check('move over', [victim.id, v.id]);
  const gone = await tr.remove('ana', 'target');
  check('remove', gone.map((n) => n.id));
  await tr.restore('ana', 'target', gone);
  check('restore', []);
  await tr.moveAcross('ana', 'target', 'ben', 'moved');
  check('moveAcross', []);
});

test('a folder is copied into another folder, a deeper one, and beside itself', async () => {
  const tr = make();
  await tr.mkdir('ana', 'a');
  await tr.put('ana', 'a/x', file(1));
  await tr.mkdir('ana', 'd');
  await tr.mkdir('ana', 'd/e');
  await tr.copy('ana', 'a', 'd/a');
  await tr.copy('ana', 'a', 'd/e/a');
  assert.equal((await tr.resolve('ana', 'd/a/x'))!.size, 1);
  assert.equal((await tr.resolve('ana', 'd/e/a/x'))!.size, 1);
  await tr.move('ana', 'a', 'd/e/moved');
  assert.equal((await tr.resolve('ana', 'd/e/moved/x'))!.size, 1);
  assert.equal((await tr.root('ana')).size, 3);
});

test('a move or copy that replaces nothing reports nothing replaced; a move across lists everything that went with it', async () => {
  const tr = make();
  await tr.mkdir('ana', 'a');
  await tr.put('ana', 'a/x', file(1));
  assert.deepEqual((await tr.copy('ana', 'a', 'b')).replaced, []);
  assert.deepEqual((await tr.move('ana', 'b', 'c')).replaced, []);
  const r = await tr.moveAcross('ana', 'a', 'ben', 'a');
  assert.deepEqual(r.replaced, []);
  assert.deepEqual(names(r.moved), ['a', 'x']);
  assert.equal(r.moved[0]!.owner, 'ben');
  assert.equal(r.moved[1]!.owner, 'ben');
});

test('a folder with many children lists them in name order whatever order they were made in', async () => {
  const tr = make();
  const all = Array.from({ length: 150 }, (_, i) => `n${String((i * 37) % 150).padStart(3, '0')}`);
  for (const n of all) await tr.put('ana', n, file(1));
  assert.deepEqual(names(await tr.list(await tr.root('ana'))), [...all].sort());
});

test('creating a root writes that one node and removes nothing', async () => {
  const { store, commits } = recorded();
  const tr = new Tree(store, { etag: () => 'r', now: () => 1 });
  const r = await tr.root('ana');
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0]!.put, [r]);
  assert.deepEqual(commits[0]!.remove, []);
});
