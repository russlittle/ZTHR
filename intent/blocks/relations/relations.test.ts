import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IntegrityError, Restricted, SchemaError, Store, cascadeLoops, checkSchema } from './index.ts';
import type { Schema } from './index.ts';

const schema: Schema = {
  types: ['user', 'post', 'comment', 'tag', 'folder', 'profile', 'page'],
  relations: [
    { kind: 'belongsTo', name: 'post.author', from: 'post', field: 'authorId', to: 'user', onDelete: 'restrict', required: true },
    { kind: 'belongsTo', name: 'comment.post', from: 'comment', field: 'postId', to: 'post', onDelete: 'cascade', required: true },
    { kind: 'belongsTo', name: 'comment.author', from: 'comment', field: 'authorId', to: 'user', onDelete: 'set-null' },
    { kind: 'belongsTo', name: 'folder.parent', from: 'folder', field: 'parentId', to: 'folder', onDelete: 'cascade', acyclic: true },
    { kind: 'oneToOne', name: 'profile.user', from: 'profile', field: 'userId', to: 'user', onDelete: 'cascade', required: true },
    { kind: 'manyToMany', name: 'post.tags', left: 'post', right: 'tag', ordered: 'left' },
    { kind: 'manyToMany', name: 'post.related', left: 'post', right: 'post' },
    { kind: 'soft', name: 'post.seeAlso', from: 'post', field: 'seeAlso', to: ['post'], toField: 'slug' },
    { kind: 'soft', name: 'comment.target', from: 'comment', field: 'target', to: ['post', 'page'] },
  ],
};

const seed = () => {
  const s = new Store(schema);
  s.insert('user', { id: 'u1' });
  s.insert('user', { id: 'u2' });
  s.insert('post', { id: 'p1', authorId: 'u1', slug: 'hello' });
  s.insert('post', { id: 'p2', authorId: 'u1', slug: 'world', seeAlso: 'hello' });
  s.insert('comment', { id: 'c1', postId: 'p1', authorId: 'u2' });
  s.insert('comment', { id: 'c2', postId: 'p1', authorId: 'u1' });
  for (const t of ['a', 'b', 'c']) s.insert('tag', { id: t });
  return s;
};

test('a schema with unknown kinds, repeats or contradictions is refused with every problem', () => {
  const bad: Schema = {
    types: ['a', 'a', 'b c'],
    relations: [
      { kind: 'belongsTo', name: 'r', from: 'a', field: 'id', to: 'zzz', onDelete: 'set-null', required: true },
      { kind: 'belongsTo', name: 'r', from: 'a', field: 'x', to: 'b c', onDelete: 'cascade', acyclic: true },
      { kind: 'soft', name: 's', from: 'a', field: 'x', to: [] },
    ],
  };
  const p = checkSchema(bad);
  for (const s of ['listed twice', '"b c" is not a usable name', 'there is no kind "zzz"', 'cannot be the id', 'cannot be set to null', 'relation r is declared twice', 'only a relation to the same kind', 'at least one target kind', 'field a.x is used by two relations']) assert.ok(p.some((x) => x.includes(s)), s);
  assert.throws(() => new Store(bad), SchemaError);
  assert.throws(() => checkSchema({ types: ['__proto__'], relations: [] }).length && new Store({ types: ['__proto__'], relations: [] }), SchemaError);
});

test('inserting needs the parent to exist, a required field, and a new id', () => {
  const s = seed();
  assert.throws(() => s.insert('post', { id: 'p3', authorId: 'nobody' }), /there is no user nobody/);
  assert.throws(() => s.insert('post', { id: 'p3' }), /authorId is required/);
  assert.throws(() => s.insert('post', { id: 'p3', authorId: 5 }), /must be the id of a user/);
  assert.throws(() => s.insert('post', { id: 'p1', authorId: 'u1' }), /already exists/);
  assert.throws(() => s.insert('post', { id: '', authorId: 'u1' }), /needs an id/);
  assert.throws(() => s.insert('nothing', { id: 'x' }), /no kind/);
  s.insert('comment', { id: 'c3', postId: 'p2' });
  assert.equal(s.get('comment', 'c3')?.authorId, undefined, 'an optional reference may be empty');
});

test('updates are checked the same way, and ids cannot change', () => {
  const s = seed();
  assert.equal(s.update('post', 'p1', { authorId: 'u2' }).authorId, 'u2');
  assert.throws(() => s.update('post', 'p1', { authorId: 'ghost' }), /no user ghost/);
  assert.throws(() => s.update('post', 'p1', { authorId: null }), /required/);
  assert.throws(() => s.update('post', 'p1', { id: 'p9' }), /id cannot change/);
  assert.throws(() => s.update('post', 'zz', {}), /no post zz/);
  assert.equal(s.get('post', 'p1')?.authorId, 'u2', 'a refused update changed nothing');
});

test('a one-to-one stays one-to-one', () => {
  const s = seed();
  s.insert('profile', { id: 'pr1', userId: 'u1' });
  assert.throws(() => s.insert('profile', { id: 'pr2', userId: 'u1' }), /already has its profile/);
  s.insert('profile', { id: 'pr2', userId: 'u2' });
  assert.throws(() => s.update('profile', 'pr2', { userId: 'u1' }), /already has/);
  assert.equal(s.parentOf('profile.user', 'pr1')?.id, 'u1');
});

test('a tree cannot be made into a loop', () => {
  const s = seed();
  s.insert('folder', { id: 'f1' });
  s.insert('folder', { id: 'f2', parentId: 'f1' });
  s.insert('folder', { id: 'f3', parentId: 'f2' });
  assert.throws(() => s.update('folder', 'f1', { parentId: 'f3' }), /inside itself/);
  assert.throws(() => s.update('folder', 'f2', { parentId: 'f2' }), /inside itself/);
  assert.equal(s.update('folder', 'f3', { parentId: 'f1' }).parentId, 'f1');
  assert.deepEqual(s.childrenOf('folder.parent', 'f1').map((x) => x.id).sort(), ['f2', 'f3']);
});

test('the delete plan lists cascades, nulls, links, blockers and soft references before anything happens', () => {
  const s = seed();
  s.link('post.tags', 'p1', 'a');
  s.link('post.related', 'p2', 'p1');
  s.insert('comment', { id: 'c9', postId: 'p2', target: 'post:p1' });
  const plan = s.planDelete('post', 'p1');
  assert.deepEqual(plan.deletes.map((d) => `${d.type}:${d.id}`).sort(), ['comment:c1', 'comment:c2', 'post:p1']);
  assert.deepEqual(plan.unlink.map((u) => `${u.relation}:${u.left}>${u.right}`).sort(), ['post.related:p2>p1', 'post.tags:p1>a']);
  assert.deepEqual(plan.dangling.map((d) => `${d.type}:${d.id}:${d.field}`).sort(), ['comment:c9:target', 'post:p2:seeAlso']);
  assert.deepEqual(plan.blockers, []);
  assert.equal(s.get('post', 'p1')?.id, 'p1', 'planning changed nothing');
});

test('restrict refuses the delete and names what blocks it, changing nothing', () => {
  const s = seed();
  try {
    s.delete('user', 'u1');
    assert.fail('should refuse');
  } catch (e) {
    assert.ok(e instanceof Restricted);
    assert.deepEqual(e.blockers.map((b) => `${b.type}:${b.id}:${b.relation}`).sort(), ['post:p1:post.author', 'post:p2:post.author']);
  }
  assert.equal(s.all('user').length, 2);
  assert.equal(s.all('comment').length, 2);
  assert.equal(s.get('comment', 'c2')?.authorId, 'u1');
});

test('restrict does not block when the blocking record is itself deleted by cascade', () => {
  const s = new Store({
    types: ['org', 'team', 'member'],
    relations: [
      { kind: 'belongsTo', name: 'team.org', from: 'team', field: 'orgId', to: 'org', onDelete: 'cascade', required: true },
      { kind: 'belongsTo', name: 'member.team', from: 'member', field: 'teamId', to: 'team', onDelete: 'restrict' },
      { kind: 'belongsTo', name: 'member.org', from: 'member', field: 'orgId', to: 'org', onDelete: 'cascade' },
    ],
  });
  s.insert('org', { id: 'o' });
  s.insert('team', { id: 't', orgId: 'o' });
  s.insert('member', { id: 'm', teamId: 't', orgId: 'o' });
  const plan = s.delete('org', 'o');
  assert.equal(plan.deletes.length, 3);
  assert.equal(s.all('member').length, 0);
});

test('delete cascades through levels, sets null, removes links, and renumbers what is left', () => {
  const s = seed();
  s.insert('profile', { id: 'pr', userId: 'u2' });
  s.link('post.tags', 'p2', 'a');
  s.link('post.tags', 'p2', 'b');
  s.link('post.tags', 'p2', 'c');
  s.delete('tag', 'b');
  assert.deepEqual(s.rightsOf('post.tags', 'p2'), ['a', 'c']);
  assert.deepEqual(s.scan(), [], 'positions stay dense');
  s.delete('user', 'u2');
  assert.equal(s.get('comment', 'c1')?.authorId, null, 'set null');
  assert.equal(s.get('profile', 'pr'), undefined, 'the profile went with its user');
  s.insert('folder', { id: 'f1' });
  s.insert('folder', { id: 'f2', parentId: 'f1' });
  s.insert('folder', { id: 'f3', parentId: 'f2' });
  assert.equal(s.delete('folder', 'f1').deletes.length, 3);
  assert.equal(s.all('folder').length, 0);
});

test('ordered links keep their order, insert at a place, move, and reorder only with exactly the same members', () => {
  const s = seed();
  s.link('post.tags', 'p1', 'a');
  s.link('post.tags', 'p1', 'b');
  s.link('post.tags', 'p1', 'c', { left: 0 });
  assert.deepEqual(s.rightsOf('post.tags', 'p1'), ['c', 'a', 'b']);
  s.move('post.tags', 'p1', 'b', 0);
  assert.deepEqual(s.rightsOf('post.tags', 'p1'), ['b', 'c', 'a']);
  s.move('post.tags', 'p1', 'b', 99);
  assert.deepEqual(s.rightsOf('post.tags', 'p1'), ['c', 'a', 'b']);
  s.reorder('post.tags', 'p1', ['a', 'b', 'c']);
  assert.deepEqual(s.rightsOf('post.tags', 'p1'), ['a', 'b', 'c']);
  assert.throws(() => s.reorder('post.tags', 'p1', ['a', 'b']), /exactly the linked/);
  assert.throws(() => s.reorder('post.tags', 'p1', ['a', 'a', 'b']), /exactly the linked/);
  assert.throws(() => s.reorder('post.tags', 'p1', ['a', 'b', 'zzz']), /exactly the linked/);
  assert.throws(() => s.move('post.tags', 'p1', 'ghost', 0), /not linked/);
  assert.equal(s.unlink('post.tags', 'p1', 'a'), true);
  assert.equal(s.unlink('post.tags', 'p1', 'a'), false);
  assert.deepEqual(s.rightsOf('post.tags', 'p1'), ['b', 'c']);
  s.move('post.tags', 'p1', 'c', 0);
  assert.deepEqual(s.rightsOf('post.tags', 'p1'), ['c', 'b']);
});

test('links are refused for missing records and repeats, and an unordered relation refuses a place', () => {
  const s = seed();
  s.link('post.tags', 'p1', 'a');
  assert.throws(() => s.link('post.tags', 'p1', 'a'), /already linked/);
  assert.throws(() => s.link('post.tags', 'nope', 'a'), /no post nope/);
  assert.throws(() => s.link('post.tags', 'p1', 'nope'), /no tag nope/);
  assert.throws(() => s.link('post.related', 'p1', 'p2', { left: 0 }), /not ordered/);
  assert.throws(() => s.move('post.related', 'p1', 'p2', 0), /does not keep an order/);
  assert.throws(() => s.link('post.author', 'p1', 'a'), /not a many-to-many/);
  s.link('post.related', 'p1', 'p2');
  s.link('post.related', 'p2', 'p1');
  assert.deepEqual(s.leftsOf('post.related', 'p1'), ['p2']);
  assert.deepEqual(s.dependents('tag', 'a'), [{ type: 'post', id: 'p1', relation: 'post.tags' }]);
});

test('ordered on both sides keeps two separate orders', () => {
  const s = new Store({ types: ['a', 'b'], relations: [{ kind: 'manyToMany', name: 'ab', left: 'a', right: 'b', ordered: 'both' }] });
  for (const id of ['a1', 'a2']) s.insert('a', { id });
  for (const id of ['b1', 'b2']) s.insert('b', { id });
  s.link('ab', 'a1', 'b1');
  s.link('ab', 'a2', 'b1', { right: 0 });
  s.link('ab', 'a1', 'b2', { left: 0 });
  assert.deepEqual(s.rightsOf('ab', 'a1'), ['b2', 'b1']);
  assert.deepEqual(s.leftsOf('ab', 'b1'), ['a2', 'a1']);
  assert.deepEqual(s.scan(), []);
});

test('soft references resolve by slug or by type:id, and never block a delete', () => {
  const s = seed();
  s.insert('page', { id: 'pg1' });
  s.insert('comment', { id: 'c5', postId: 'p2', target: 'page:pg1' });
  s.insert('comment', { id: 'c6', postId: 'p2', target: 'p1' });
  assert.equal(s.resolveSoft('post.seeAlso', 'p2')?.id, 'p1');
  assert.equal(s.resolveSoft('comment.target', 'c5')?.id, 'pg1');
  assert.equal(s.resolveSoft('comment.target', 'c6'), undefined, 'a bare id is ambiguous across kinds');
  assert.equal(s.resolveSoft('comment.target', 'c1'), undefined);
  s.delete('post', 'p1');
  assert.equal(s.resolveSoft('post.seeAlso', 'p2'), undefined);
  assert.deepEqual(s.scan().map((f) => [f.kind, f.severity, f.id]), [['dangling-soft', 'warning', 'p2'], ['dangling-soft', 'warning', 'c6']]);
  assert.throws(() => s.resolveSoft('post.author', 'p2'), /not a soft reference/);
});

const damaged = () =>
  Store.load(schema, {
    rows: {
      user: [{ id: 'u1' }],
      post: [{ id: 'p1', authorId: 'u1' }, { id: 'p2', authorId: 'gone' }, { id: 'p3' }],
      comment: [{ id: 'c1', postId: 'p1', authorId: 'gone' }, { id: 'c2', postId: 'gone' }],
      tag: [{ id: 'a' }],
      folder: [{ id: 'f1', parentId: 'f1' }],
      profile: [{ id: 'pr1', userId: 'u1' }, { id: 'pr2', userId: 'u1' }],
    },
    links: {
      'post.tags': [{ left: 'p1', right: 'a', posL: 0, posR: 0 }, { left: 'p1', right: 'a', posL: 1, posR: 0 }, { left: 'p1', right: 'zz', posL: 5, posR: 0 }, { left: 'p9', right: 'a', posL: 0, posR: 0 }],
    },
  });

test('the scan finds every kind of damage in loaded data, each with where and why', () => {
  const found = damaged().scan().map((f) => `${f.kind}|${f.severity}|${f.relation}|${f.type}:${f.id}`);
  for (const w of [
    'dangling-fk|error|post.author|post:p2',
    'required-empty|error|post.author|post:p3',
    'dangling-fk|error|comment.post|comment:c2',
    'dangling-fk|error|comment.author|comment:c1',
    'not-unique|error|profile.user|profile:pr2',
    'loop|error|folder.parent|folder:f1',
    'dangling-link|error|post.tags|tag:zz',
    'dangling-link|error|post.tags|post:p9',
    'repeated-link|error|post.tags|post:p1',
    'bad-order|warning|post.tags|post:p1',
  ]) assert.ok(found.includes(w), `missing ${w} in\n${found.join('\n')}`);
  assert.equal(found.length, new Set(found).size);
});

test('repair plans set null where allowed, delete where required, drop dead links, and leave choices to a person', () => {
  const s = damaged();
  const plan = s.repairPlan();
  assert.deepEqual(plan.filter((p) => p.action === 'set-null').map((p) => p.action === 'set-null' ? `${p.type}:${p.id}:${p.field}` : '').sort(), ['comment:c1:authorId', 'folder:f1:parentId']);
  assert.deepEqual(plan.filter((p) => p.action === 'delete-row').map((p) => p.action === 'delete-row' ? `${p.type}:${p.id}` : '').sort(), ['comment:c2', 'post:p2']);
  assert.deepEqual(plan.filter((p) => p.action === 'manual').map((p) => p.action === 'manual' ? `${p.type}:${p.id}` : '').sort(), ['post:p3', 'profile:pr2']);
  const left = s.repair(plan);
  assert.equal(left.length, 2);
  const after = s.scan().map((f) => `${f.kind}:${f.type}:${f.id}`).sort();
  assert.deepEqual(after, ['not-unique:profile:pr2', 'required-empty:post:p3']);
  assert.deepEqual(s.rightsOf('post.tags', 'p1'), ['a']);
  assert.equal(s.get('comment', 'c1')?.authorId, null);
  assert.equal(s.get('post', 'p2'), undefined);
});

test('cascade loops across kinds are reported, and a clean store scans clean', () => {
  assert.deepEqual(cascadeLoops(schema), []);
  const ring: Schema = {
    types: ['a', 'b'],
    relations: [
      { kind: 'belongsTo', name: 'a.b', from: 'a', field: 'bId', to: 'b', onDelete: 'cascade' },
      { kind: 'belongsTo', name: 'b.a', from: 'b', field: 'aId', to: 'a', onDelete: 'cascade' },
    ],
  };
  assert.equal(cascadeLoops(ring).length, 1);
  const s = new Store(ring);
  s.insert('a', { id: 'a1' });
  s.insert('b', { id: 'b1', aId: 'a1' });
  s.update('a', 'a1', { bId: 'b1' });
  assert.equal(s.delete('a', 'a1').deletes.length, 2, 'a ring of cascades ends instead of looping');
  assert.deepEqual(seed().scan(), []);
});

test('snapshots round trip and the returned rows are copies', () => {
  const s = seed();
  s.link('post.tags', 'p1', 'a');
  const snap = JSON.parse(JSON.stringify(s.snapshot()));
  const back = Store.load(schema, snap);
  assert.deepEqual(back.snapshot(), s.snapshot());
  const row = s.get('post', 'p1')!;
  row.authorId = 'hacked';
  assert.equal(s.get('post', 'p1')?.authorId, 'u1');
  assert.throws(() => Store.load(schema, { rows: { nothing: [] }, links: {} }), SchemaError);
  assert.throws(() => Store.load(schema, { rows: {}, links: { nope: [] } }), SchemaError);
});

test('hostile field names do not reach the prototype', () => {
  const s = seed();
  s.update('post', 'p1', { ['__proto__']: { authorId: 'u2' }, constructor: 'x' });
  assert.equal(({} as Record<string, unknown>).authorId, undefined);
  assert.equal(s.get('post', 'p1')?.authorId, 'u1');
  assert.throws(() => s.get('__proto__', 'x'), IntegrityError);
});
