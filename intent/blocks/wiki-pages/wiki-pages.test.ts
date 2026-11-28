import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wiki, WikiError, diffLines, extractLinks, type User } from './index.ts';

const ada: User = { id: 'ada' };
const bob: User = { id: 'bob', groups: ['staff'] };
const root: User = { id: 'root' };

function setup(o: { defaultRole?: 'none' | 'read' | 'edit' | 'admin' } = {}) {
  let t = Date.parse('2024-03-01T10:00:00Z');
  let n = 0;
  const clock = { advance: (s: number) => { t += s * 1000; } };
  const w = new Wiki({ now: () => new Date(t), id: () => `p${++n}`, admins: ['root'], defaultRole: o.defaultRole ?? 'edit' });
  return { w, clock };
}
const code = (f: () => unknown): string | undefined => { try { f(); return undefined; } catch (e) { return e instanceof WikiError ? e.code : `other:${String(e)}`; } };

test('create builds a tree with slug paths and breadcrumbs', () => {
  const { w } = setup();
  const a = w.create(ada, { title: 'Handbook' });
  assert.equal(a.path, 'handbook');
  const b = w.create(ada, { parent: 'handbook', title: 'On boarding!' });
  assert.equal(b.path, 'handbook/on-boarding');
  const c = w.create(ada, { parent: 'handbook/on-boarding', title: 'Laptops', slug: 'laptops' });
  assert.equal(c.path, 'handbook/on-boarding/laptops');
  assert.deepEqual(w.breadcrumbs(ada, c.path).map((x) => x.title), ['Handbook', 'On boarding!', 'Laptops']);
  assert.deepEqual(w.children(ada, 'handbook').map((x) => x.slug), ['on-boarding']);
  assert.equal(w.get(ada, c.path).version, 1);
});

test('slugs and titles are validated', () => {
  const { w } = setup();
  assert.equal(code(() => w.create(ada, { title: 'x', slug: 'Bad Slug' })), 'invalid');
  assert.equal(code(() => w.create(ada, { title: 'x', slug: 'edit' })), 'invalid');
  assert.equal(code(() => w.create(ada, { title: '  ' })), 'invalid');
  assert.equal(code(() => w.create(ada, { title: 'a\u0000b' })), 'invalid');
  assert.equal(code(() => w.create(ada, { title: 'x', slug: '../etc' })), 'invalid');
  w.create(ada, { title: 'Dup' });
  assert.equal(code(() => w.create(ada, { title: 'Dup' })), 'exists');
});

test('save keeps revisions and refuses a stale edit', () => {
  const { w, clock } = setup();
  w.create(ada, { title: 'Page', body: 'one' });
  clock.advance(60);
  const v2 = w.save(ada, 'page', { body: 'two', expected: 1, note: 'second' });
  assert.equal(v2.version, 2);
  assert.equal(v2.updatedAt, '2024-03-01T10:01:00.000Z');
  assert.equal(code(() => w.save(bob, 'page', { body: 'three', expected: 1 })), 'conflict');
  assert.equal(w.save(bob, 'page', { body: 'three', expected: 2 }).version, 3);
  assert.deepEqual(w.revisions(ada, 'page').map((r) => [r.version, r.by, r.changed]), [[1, 'ada', ['body', 'parent', 'slug', 'title']], [2, 'ada', ['body']], [3, 'bob', ['body']]]);
  assert.equal(w.revisions(ada, 'page')[1]!.note, 'second');
});

test('saving unchanged content makes no revision', () => {
  const { w } = setup();
  w.create(ada, { title: 'P', body: 'same' });
  assert.equal(w.save(ada, 'p', { body: 'same', expected: 1 }).version, 1);
  assert.equal(code(() => w.save(ada, 'p', { body: 'same', expected: 5 })), 'conflict');
});

test('revisions can be read, compared and restored as a new revision', () => {
  const { w } = setup();
  w.create(ada, { title: 'Doc', body: 'a\nb\nc' });
  w.save(ada, 'doc', { body: 'a\nB\nc\nd', expected: 1 });
  assert.equal(w.revision(ada, 'doc', 1).body, 'a\nb\nc');
  const cmp = w.compare(ada, 'doc', 1, 2);
  assert.deepEqual(cmp.fields, ['body']);
  assert.deepEqual(cmp.lines, [{ op: 'same', line: 'a' }, { op: 'del', line: 'b' }, { op: 'add', line: 'B' }, { op: 'same', line: 'c' }, { op: 'add', line: 'd' }]);
  const r = w.restore(ada, 'doc', 1, 2);
  assert.equal(r.version, 3);
  assert.equal(r.body, 'a\nb\nc');
  assert.equal(w.revision(ada, 'doc', 2).body, 'a\nB\nc\nd');
  assert.equal(code(() => w.revision(ada, 'doc', 9)), 'not-found');
  assert.equal(code(() => w.revision(ada, 'doc', 0)), 'not-found');
});

test('diffLines edge cases', () => {
  assert.deepEqual(diffLines('', 'x'), [{ op: 'add', line: 'x' }]);
  assert.deepEqual(diffLines('x', ''), [{ op: 'del', line: 'x' }]);
  assert.deepEqual(diffLines('', ''), []);
  assert.throws(() => diffLines('a\n'.repeat(10), 'b', 5), WikiError);
});

test('move refuses cycles, taken slugs and keeps children', () => {
  const { w } = setup();
  w.create(ada, { title: 'A' });
  w.create(ada, { parent: 'a', title: 'B' });
  w.create(ada, { parent: 'a/b', title: 'C' });
  w.create(ada, { title: 'Z' });
  assert.equal(code(() => w.move(ada, 'a', { parent: 'a/b/c' })), 'cycle');
  assert.equal(code(() => w.move(ada, 'a', { parent: 'a' })), 'cycle');
  const m = w.move(ada, 'a/b', { parent: 'z' });
  assert.equal(m.path, 'z/b');
  assert.equal(w.get(ada, 'z/b/c').path, 'z/b/c');
  assert.equal(code(() => w.get(ada, 'a/b')), 'not-found');
  w.create(ada, { parent: 'a', title: 'B' });
  assert.equal(code(() => w.move(ada, 'z/b', { parent: 'a' })), 'exists');
  assert.equal(w.move(ada, 'z/b', { parent: null, slug: 'top' }).path, 'top');
  assert.equal(w.revisions(ada, 'top').at(-1)!.note, 'moved');
});

test('delete refuses sub-pages unless recursive and needs admin', () => {
  const { w } = setup();
  w.create(root, { title: 'A' });
  w.create(root, { parent: 'a', title: 'B' });
  assert.equal(code(() => w.remove(ada, 'a')), 'forbidden');
  assert.equal(code(() => w.remove(root, 'a')), 'has-children');
  assert.equal(w.remove(root, 'a', { recursive: true }), 2);
  assert.equal(code(() => w.get(root, 'a')), 'not-found');
  w.create(root, { title: 'A' });
  assert.equal(w.get(root, 'a').version, 1);
});

test('depth, child and size limits', () => {
  let n = 0;
  const w = new Wiki({ now: () => new Date(0), id: () => `i${++n}`, defaultRole: 'admin', maxDepth: 2, maxChildren: 2, maxBytes: 10 });
  w.create(ada, { title: 'a' });
  w.create(ada, { parent: 'a', title: 'b' });
  assert.equal(code(() => w.create(ada, { parent: 'a/b', title: 'c' })), 'limit');
  w.create(ada, { parent: 'a', title: 'c' });
  assert.equal(code(() => w.create(ada, { parent: 'a', title: 'd' })), 'limit');
  assert.equal(code(() => w.save(ada, 'a', { body: 'x'.repeat(11), expected: 1 })), 'limit');
  assert.equal(code(() => w.save(ada, 'a', { body: '€€€€', expected: 1 })), 'limit');
});

test('templates fill placeholders and refuse missing ones', () => {
  const { w } = setup();
  assert.equal(code(() => w.defineTemplate(ada, { name: 'meeting', title: 'x', body: 'y' })), 'forbidden');
  w.defineTemplate(root, { name: 'meeting', title: 'Meeting {{date}}', body: '# {{title}}\nAttendees: {{who}}\nBy {{user}} on {{date}}' });
  assert.deepEqual(w.listTemplates(), ['meeting']);
  const p = w.create(ada, { template: 'meeting', title: 'Weekly', vars: { who: 'Ada, Bob' } });
  assert.equal(p.body, '# Weekly\nAttendees: Ada, Bob\nBy ada on 2024-03-01');
  assert.equal(code(() => w.create(ada, { template: 'meeting', title: 'No vars' })), 'invalid');
  assert.equal(code(() => w.create(ada, { template: 'nope', title: 'x' })), 'not-found');
  assert.equal(code(() => w.defineTemplate(root, { name: 'Bad Name', title: 't', body: 'b' })), 'invalid');
  const q = w.create(ada, { template: 'meeting', vars: { who: '{{title}}' }, title: 'T2' });
  assert.ok(q.body.includes('Attendees: {{title}}'));
});

test('permissions: nearest page decides, user beats group beats everyone', () => {
  const { w } = setup({ defaultRole: 'none' });
  w.setAccess(root, null, '*', 'read');
  w.setAccess(root, null, 'user:ada', 'edit');
  w.create(ada, { title: 'Open' });
  w.create(ada, { title: 'Secret' });
  w.setAccess(root, 'secret', '*', 'none');
  w.setAccess(root, 'secret', 'group:staff', 'read');
  w.setAccess(root, 'secret', 'user:ada', 'admin');
  w.create(ada, { parent: 'secret', title: 'Child' });
  assert.equal(w.roleOn(bob, 'open'), 'read');
  assert.equal(w.roleOn(bob, 'secret'), 'read');
  assert.equal(w.roleOn(bob, 'secret/child'), 'read');
  assert.equal(w.roleOn(ada, 'secret/child'), 'admin');
  assert.equal(w.roleOn({ id: 'eve' }, 'secret'), 'none');
  assert.equal(w.roleOn({ id: 'eve' }, 'open'), 'read');
  assert.equal(code(() => w.save(bob, 'open', { body: 'x', expected: 1 })), 'forbidden');
  assert.equal(code(() => w.get({ id: 'eve' }, 'secret')), 'not-found');
});

test('permissions: unreadable pages are hidden from listing, tree, search and backlinks', () => {
  const { w } = setup({ defaultRole: 'read' });
  w.create(root, { title: 'Public' });
  w.create(root, { title: 'Hidden', body: 'See [[public]]' });
  w.setAccess(root, 'hidden', '*', 'none');
  const eve = { id: 'eve' };
  assert.deepEqual(w.children(eve, null).map((p) => p.slug), ['public']);
  assert.deepEqual(w.tree(eve).map((x) => x.path), ['public']);
  assert.deepEqual(w.search(eve, 'hid'), []);
  assert.deepEqual(w.backlinks(eve, 'public'), []);
  assert.deepEqual(w.backlinks(root, 'public').map((p) => p.path), ['hidden']);
  assert.deepEqual(w.brokenLinks(eve), []);
});

test('permissions: only admins change access and creating needs edit on the parent', () => {
  const { w } = setup({ defaultRole: 'read' });
  assert.equal(code(() => w.create(ada, { title: 'x' })), 'forbidden');
  w.setAccess(root, null, 'user:ada', 'edit');
  w.create(ada, { title: 'x' });
  assert.equal(code(() => w.setAccess(ada, 'x', '*', 'admin')), 'forbidden');
  assert.equal(code(() => w.setAccess(root, 'x', 'ada', 'edit')), 'invalid');
  assert.equal(code(() => w.setAccess(root, 'x', '*', 'owner' as never)), 'invalid');
  w.setAccess(root, 'x', 'user:bob', 'edit');
  assert.deepEqual(w.access(root, 'x'), [{ subject: 'user:bob', role: 'edit' }]);
  w.setAccess(root, 'x', 'user:bob', null);
  assert.deepEqual(w.access(root, 'x'), []);
});

test('locks block others, expire on the clock, renew and can be broken', () => {
  const { w, clock } = setup();
  w.create(ada, { title: 'L', body: 'a' });
  const l = w.lock(ada, 'l');
  assert.equal(l.expires, '2024-03-01T10:15:00.000Z');
  assert.equal(code(() => w.save(bob, 'l', { body: 'b', expected: 1 })), 'locked');
  assert.equal(code(() => w.lock(bob, 'l')), 'locked');
  assert.equal(w.save(ada, 'l', { body: 'c', expected: 1 }).version, 2);
  clock.advance(600);
  assert.equal(w.lock(ada, 'l').expires, '2024-03-01T10:25:00.000Z');
  clock.advance(901);
  assert.equal(w.lockOf(ada, 'l'), undefined);
  assert.equal(w.save(bob, 'l', { body: 'd', expected: 2 }).version, 3);
  w.lock(bob, 'l');
  assert.equal(code(() => w.unlock(ada, 'l')), 'locked');
  assert.equal(code(() => w.breakLock(ada, 'l')), 'forbidden');
  assert.equal(w.breakLock(root, 'l'), true);
  assert.equal(w.unlock(bob, 'l'), false);
  w.lock(ada, 'l');
  assert.equal(w.unlock(ada, 'l'), true);
});

test('locks also block moves and deletes by others', () => {
  const { w } = setup({ defaultRole: 'admin' });
  w.create(ada, { title: 'L' });
  w.create(ada, { title: 'Dest' });
  w.lock(ada, 'l');
  assert.equal(code(() => w.move(bob, 'l', { parent: 'dest' })), 'locked');
  assert.equal(code(() => w.remove(bob, 'l')), 'locked');
});

test('extractLinks finds targets outside code only', () => {
  const body = 'See [[Alpha]] and [[beta/gamma|the gamma]].\n\n`[[inline]]`\n\n```\n[[fenced]]\n```\n\n[[Alpha]] again';
  assert.deepEqual(extractLinks(body), [{ target: 'Alpha', label: 'Alpha' }, { target: 'beta/gamma', label: 'the gamma' }]);
  assert.deepEqual(extractLinks('[[]] [[a|]] [ [x] ]'), []);
});

test('backlinks resolve beside the page then from the root, and survive moves', () => {
  const { w } = setup();
  w.create(ada, { title: 'Guide' });
  w.create(ada, { parent: 'guide', title: 'Setup' });
  w.create(ada, { parent: 'guide', title: 'Usage', body: 'Do [[Setup]] first, then [[/faq]].' });
  w.create(ada, { title: 'Faq' });
  assert.deepEqual(w.backlinks(ada, 'guide/setup').map((p) => p.path), ['guide/usage']);
  assert.deepEqual(w.backlinks(ada, 'faq').map((p) => p.path), ['guide/usage']);
  w.move(ada, 'guide/setup', { parent: null });
  assert.deepEqual(w.backlinks(ada, 'setup').map((p) => p.path), ['guide/usage']);
  w.save(ada, 'guide/usage', { body: 'no links now', expected: 1 });
  assert.deepEqual(w.backlinks(ada, 'setup'), []);
});

test('links to pages created later become backlinks; broken links are listed', () => {
  const { w } = setup();
  w.create(ada, { title: 'Home', body: 'Go to [[Future Page]]' });
  assert.deepEqual(w.brokenLinks(ada), [{ from: 'home', target: 'Future Page' }]);
  w.create(ada, { title: 'Future Page' });
  assert.deepEqual(w.brokenLinks(ada), []);
  assert.deepEqual(w.backlinks(ada, 'future-page').map((p) => p.path), ['home']);
});

test('html turns wiki links into links, marks missing pages and never passes raw html', () => {
  const { w } = setup();
  w.create(ada, { title: 'Target' });
  w.create(ada, { title: 'Src', body: '# Hi\n\n[[Target]] and [[nope|Missing one]] and [[Target|label]]\n\n<script>alert(1)</script>\n\n`[[code]]`' });
  const h = w.html(ada, 'src');
  assert.ok(h.includes('<a href="/wiki/target">Target</a>'), h);
  assert.ok(h.includes('<a href="/wiki/nope?new=1">Missing one</a>'), h);
  assert.ok(h.includes('<a href="/wiki/target">label</a>'), h);
  assert.ok(!h.includes('<script>'), h);
  assert.ok(h.includes('<code>[[code]]</code>'), h);
});

test('html does not leak a hidden page', () => {
  const { w } = setup({ defaultRole: 'none' });
  w.setAccess(root, null, 'user:ada', 'edit');
  w.create(ada, { title: 'Mine', body: 'x' });
  assert.equal(code(() => w.html(bob, 'mine')), 'not-found');
});

test('search ranks exact, prefix then contains', () => {
  const { w } = setup();
  for (const t of ['Deploy', 'Deploy guide', 'How to deploy', 'Other']) w.create(ada, { title: t });
  assert.deepEqual(w.search(ada, 'deploy').map((p) => p.title), ['Deploy', 'Deploy guide', 'How to deploy']);
  assert.deepEqual(w.search(ada, ' '), []);
  assert.equal(w.search(ada, 'deploy', 1).length, 1);
});

test('hostile: odd paths and prototype-like names are just missing or invalid', () => {
  const { w } = setup();
  assert.equal(code(() => w.get(ada, '__proto__')), 'not-found');
  assert.equal(code(() => w.get(ada, 'constructor/prototype')), 'not-found');
  assert.equal(code(() => w.get(ada, '')), 'not-found');
  assert.equal(code(() => w.get(ada, 'a'.repeat(5000))), 'not-found');
  assert.equal(code(() => w.create(ada, { title: 'x', slug: '__proto__' })), 'invalid');
  assert.equal(code(() => w.create(ada, { parent: '../x', title: 't' })), 'not-found');
  const p = w.create(ada, { title: 'Proto', body: '[[constructor]] [[toString]]' });
  assert.equal(p.version, 1);
  assert.equal(w.brokenLinks(ada).length, 2);
});

test('tree lists readable pages sorted to a depth', () => {
  const { w } = setup();
  w.create(ada, { title: 'B' });
  w.create(ada, { title: 'A' });
  w.create(ada, { parent: 'a', title: 'A1' });
  w.create(ada, { parent: 'a/a1', title: 'Deep' });
  assert.deepEqual(w.tree(ada, null, 2), [{ path: 'a', title: 'A', children: [{ path: 'a/a1', title: 'A1', children: [] }] }, { path: 'b', title: 'B', children: [] }]);
  assert.equal(w.tree(ada, 'a', 3)[0]!.children.length, 1);
});

test('the page cap is enforced', () => {
  let n = 0;
  const w = new Wiki({ now: () => new Date(0), id: () => `i${++n}`, defaultRole: 'admin', maxPages: 2 });
  w.create(ada, { title: 'a' });
  w.create(ada, { title: 'b' });
  assert.equal(code(() => w.create(ada, { title: 'c' })), 'limit');
});
