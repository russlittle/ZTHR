import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadSchema, StoreConflict, crud, declare, memoryStore } from './index.ts';
import type { Entity, Req } from './index.ts';
import type { Policy, Subject } from '../rbac/index.ts';
import { check, contract, verifyResponse } from '../openapi/index.ts';

const User: Entity = {
  name: 'User', plural: 'users',
  fields: {
    name: { type: 'string', required: true, minLength: 1, maxLength: 50, filterable: true, sortable: true },
    email: { type: 'string', required: true, format: 'email', unique: true, filterable: true },
    salary: { type: 'integer', nullable: true, readAction: 'read-salary', writeAction: 'write-salary', filterable: true, sortable: true },
  },
};
const Post: Entity = {
  name: 'Post', plural: 'posts',
  fields: {
    title: { type: 'string', required: true, maxLength: 80, filterable: true, sortable: true },
    status: { type: 'string', enum: ['draft', 'published'], default: 'draft', filterable: true },
    views: { type: 'integer', default: 0, minimum: 0, filterable: true, sortable: true },
    authorId: { type: 'string', required: true, filterable: true },
    meta: { type: 'json' },
  },
  relations: { author: { entity: 'User', kind: 'one', field: 'authorId' }, comments: { entity: 'Comment', kind: 'many', field: 'postId' } },
};
const Comment: Entity = { name: 'Comment', plural: 'comments', fields: { postId: { type: 'string', required: true, filterable: true }, text: { type: 'string', required: true } }, operations: ['list', 'get', 'create'] };

const policy: Policy = {
  roles: { member: { label: 'Member' }, admin: { label: 'Admin', inherits: ['member'] } },
  grants: [
    { role: 'member', kind: 'User', actions: ['list', 'read'] },
    { role: 'member', kind: 'Post', actions: ['list', 'read', 'create'] },
    { role: 'member', kind: 'Post', actions: ['update', 'delete'], when: [{ field: 'authorId', equalsSubject: 'id' }] },
    { role: 'member', kind: 'Comment', actions: ['list', 'read', 'create'] },
    { role: 'admin', kind: 'User', actions: ['create', 'update', 'delete', 'read-salary', 'write-salary'] },
    { role: 'admin', kind: 'Post', actions: ['update', 'delete'] },
  ],
};
const ada: Subject = { id: 'u1', roles: ['admin'] };
const bob: Subject = { id: 'u2', roles: ['member'] };

function setup() {
  let n = 0;
  let t = Date.parse('2026-01-01T00:00:00Z');
  const store = memoryStore({}, { User: ['email'] });
  const api = crud({ entities: [User, Post, Comment], policy, store, now: () => new Date((t += 1000)), newId: () => `id${++n}`, prefix: '/v1', defaultLimit: 2, maxLimit: 5 });
  const call = (subject: Subject | null, method: string, path: string, body?: unknown, query?: string) => api.handle({ method, path: `/v1${path}`, subject, ...(body !== undefined ? { body } : {}), ...(query !== undefined ? { query } : {}) } as Req);
  return { api, call, store };
}

async function seed(call: ReturnType<typeof setup>['call']) {
  await call(ada, 'POST', '/users', { name: 'Ada', email: 'ada@example.com', salary: 100 }); // id1
  await call(ada, 'POST', '/users', { name: 'Bob', email: 'bob@example.com' }); // id2 (not the same as subject id u2, set below)
}

test('create fills id, defaults and timestamps and answers 201 with a Location', async () => {
  const { call } = setup();
  const r = await call(bob, 'POST', '/posts', { title: 'Hello', authorId: 'u2' });
  assert.equal(r.status, 201);
  assert.equal(r.headers['location'], '/v1/posts/id1');
  assert.deepEqual(r.body, { id: 'id1', title: 'Hello', status: 'draft', views: 0, authorId: 'u2', createdAt: '2026-01-01T00:00:01.000Z', updatedAt: '2026-01-01T00:00:01.000Z' });
});

test('invalid input is a 422 problem listing each field', async () => {
  const { call } = setup();
  const r = await call(bob, 'POST', '/posts', { title: '', status: 'x', views: -1, id: 'mine', extra: 1 });
  assert.equal(r.status, 422);
  assert.equal(r.headers['content-type'], 'application/problem+json');
  const paths = (r.body as { errors: { path: string }[] }).errors.map((e) => e.path).sort();
  assert.deepEqual(paths, ['/authorId', '/extra', '/id', '/status', '/views']);
  assert.equal((await call(bob, 'POST', '/posts', [1])).status, 422);
});

test('not signed in is 401; unknown paths 404; wrong verb 405 with Allow', async () => {
  const { call } = setup();
  assert.equal((await call(null, 'GET', '/posts')).status, 401);
  assert.equal((await call(bob, 'GET', '/nope')).status, 404);
  assert.equal((await call(bob, 'GET', '/posts/a/b')).status, 404);
  const r = await call(bob, 'PUT', '/posts');
  assert.equal(r.status, 405);
  assert.equal(r.headers['allow'], 'GET, POST');
  const c = await call(bob, 'DELETE', '/comments/x');
  assert.equal(c.status, 405);
  assert.equal(c.headers['allow'], 'GET');
});

test('owners edit their own records; others get 403; strangers to the record get what rbac says', async () => {
  const { call } = setup();
  const made = (await call(bob, 'POST', '/posts', { title: 'Mine', authorId: 'u2' })).body as { id: string };
  assert.equal((await call(bob, 'PATCH', `/posts/${made.id}`, { title: 'Still mine' })).status, 200);
  const other: Subject = { id: 'u9', roles: ['member'] };
  assert.equal((await call(other, 'PATCH', `/posts/${made.id}`, { title: 'x' })).status, 403);
  assert.equal((await call(other, 'DELETE', `/posts/${made.id}`)).status, 403);
  assert.equal((await call(ada, 'PATCH', `/posts/${made.id}`, { views: 3 })).status, 200);
  // Handing the record to someone else is refused: the result must still be the editor's to change.
  assert.equal((await call(bob, 'PATCH', `/posts/${made.id}`, { authorId: 'u9' })).status, 403);
  assert.equal((await call(bob, 'DELETE', `/posts/${made.id}`)).status, 204);
  assert.equal((await call(bob, 'GET', `/posts/${made.id}`)).status, 404);
});

test('update is partial, bumps updatedAt only, and refuses read-only fields', async () => {
  const { call } = setup();
  const made = (await call(bob, 'POST', '/posts', { title: 'A', authorId: 'u2' })).body as { id: string; createdAt: string };
  const r = await call(bob, 'PATCH', `/posts/${made.id}`, { views: 5 });
  const b = r.body as { title: string; views: number; createdAt: string; updatedAt: string };
  assert.equal(b.title, 'A');
  assert.equal(b.views, 5);
  assert.equal(b.createdAt, made.createdAt);
  assert.ok(b.updatedAt > made.createdAt);
  assert.equal((await call(bob, 'PATCH', `/posts/${made.id}`, { createdAt: '2020-01-01T00:00:00Z' })).status, 422);
});

test('field permissions hide a field from readers and refuse writes to it', async () => {
  const { call } = setup();
  await seed(call);
  const forAda = (await call(ada, 'GET', '/users/id1')).body as Record<string, unknown>;
  const forBob = (await call(bob, 'GET', '/users/id1')).body as Record<string, unknown>;
  assert.equal(forAda['salary'], 100);
  assert.equal('salary' in forBob, false);
  assert.equal((await call(bob, 'POST', '/users', { name: 'x', email: 'x@example.com' })).status, 403);
  const member: Subject = { id: 'm', roles: ['member'] };
  const lists = (await call(member, 'GET', '/users')).body as { data: Record<string, unknown>[] };
  assert.ok(lists.data.every((u) => !('salary' in u)));
  // Filtering or sorting by a field would reveal it, so it needs the same permission as reading it.
  const sneaky = await call(member, 'GET', '/users', undefined, 'filter[salary][gt]=50');
  assert.equal(sneaky.status, 400);
  assert.equal((await call(member, 'GET', '/users', undefined, 'sort=-salary')).status, 400);
  const allowed = await call(ada, 'GET', '/users', undefined, 'filter[salary][gt]=50');
  assert.deepEqual((allowed.body as { data: { name: string }[] }).data.map((u) => u.name), ['Ada']);
});

test('unique fields answer 409, from the check and from the store', async () => {
  const { call, store } = setup();
  await seed(call);
  const r = await call(ada, 'POST', '/users', { name: 'Dup', email: 'ada@example.com' });
  assert.equal(r.status, 409);
  assert.equal((r.body as { errors: { path: string }[] }).errors[0]!.path, '/email');
  await assert.rejects(store.insert('User', { id: 'zz', email: 'bob@example.com' }), StoreConflict);
  assert.equal((await call(ada, 'PATCH', '/users/id2', { email: 'ada@example.com' })).status, 409);
  assert.equal((await call(ada, 'PATCH', '/users/id2', { email: 'bob@example.com' })).status, 200);
});

async function posts(call: ReturnType<typeof setup>['call']) {
  for (const [title, views, status] of [['b', 3, 'published'], ['a', 9, 'draft'], ['c', 1, 'published'], ['d', 5, 'published']] as const) await call(bob, 'POST', '/posts', { title, views, status, authorId: 'u2' });
}

test('list: filters, operators, sorting and a combined query', async () => {
  const { call } = setup();
  await posts(call);
  const titles = async (q: string) => ((await call(bob, 'GET', '/posts', undefined, q)).body as { data: { title: string }[] }).data.map((p) => p.title);
  assert.deepEqual(await titles('limit=5&sort=title'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(await titles('limit=5&sort=-views'), ['a', 'd', 'b', 'c']);
  assert.deepEqual(await titles('limit=5&sort=title&filter[status]=published'), ['b', 'c', 'd']);
  assert.deepEqual(await titles('limit=5&sort=title&filter[views][gte]=3'), ['a', 'b', 'd']);
  assert.deepEqual(await titles('limit=5&sort=title&filter[title][in]=a,d'), ['a', 'd']);
  assert.deepEqual(await titles('limit=5&sort=title&filter[title][contains]=C'), ['c']);
  assert.deepEqual(await titles('limit=5&sort=title&filter[status]=published&filter[views][lt]=5'), ['b', 'c']);
});

test('list: bad queries are 400 with the offending parameter named', async () => {
  const { call } = setup();
  const bad = async (q: string) => ((await call(bob, 'GET', '/posts', undefined, q)).body as { errors: { path: string; message: string }[] }).errors[0]!;
  assert.equal((await bad('filter[meta]=1')).path, 'filter[meta]');
  assert.match((await bad('filter[views][contains]=1')).message, /does not apply/);
  assert.match((await bad('filter[views]=abc')).message, /integer/);
  assert.equal((await bad('sort=meta')).path, 'sort');
  assert.equal((await bad('limit=99')).path, 'limit');
  assert.equal((await bad('expand=nope')).path, 'expand');
  assert.equal((await bad('what=1')).path, 'what');
  assert.equal((await bad('cursor=garbage')).path, 'cursor');
});

test('cursor paging walks every row once and refuses a cursor from another query', async () => {
  const { call } = setup();
  await posts(call);
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const r = await call(bob, 'GET', '/posts', undefined, `limit=2&sort=title${cursor ? `&cursor=${cursor}` : ''}`);
    const b = r.body as { data: { title: string }[]; next: string | null };
    seen.push(...b.data.map((p) => p.title));
    cursor = b.next;
    pages++;
  } while (cursor);
  assert.deepEqual(seen, ['a', 'b', 'c', 'd']);
  assert.equal(pages, 2);
  const first = (await call(bob, 'GET', '/posts', undefined, 'limit=2&sort=title')).body as { next: string };
  assert.equal((await call(bob, 'GET', '/posts', undefined, `limit=2&sort=-title&cursor=${first.next}`)).status, 400);
});

test('lists leave out rows the subject may not read, before paging', async () => {
  const strict: Policy = { ...policy, grants: [...policy.grants.filter((g) => !(g.kind === 'Post' && g.role === 'member' && g.actions.includes('list'))), { role: 'member', kind: 'Post', actions: ['list', 'read'], when: [{ field: 'status', in: ['published'] }] }, { role: 'member', kind: 'Post', actions: ['create'] }] };
  let n = 0;
  const store = memoryStore();
  const api = crud({ entities: [User, Post, Comment], policy: strict, store, now: () => new Date('2026-01-01T00:00:00Z'), newId: () => `p${++n}` });
  for (const status of ['draft', 'published', 'draft', 'published', 'published']) await api.handle({ method: 'POST', path: '/posts', subject: bob, body: { title: status, status, authorId: 'u2' } });
  const r = await api.handle({ method: 'GET', path: '/posts', query: 'limit=2', subject: bob });
  const b = r.body as { data: { id: string }[]; next: string | null };
  assert.deepEqual(b.data.map((p) => p.id), ['p2', 'p4']);
  assert.ok(b.next);
  assert.equal((await api.handle({ method: 'GET', path: '/posts/p1', subject: bob })).status, 404);
});

test('expand includes related records the subject may read, and null when not', async () => {
  const { call } = setup();
  await seed(call);
  const p = (await call(bob, 'POST', '/posts', { title: 'T', authorId: 'id1' })).body as { id: string };
  await call(bob, 'POST', '/comments', { postId: p.id, text: 'one' });
  await call(bob, 'POST', '/comments', { postId: p.id, text: 'two' });
  const r = (await call(bob, 'GET', `/posts/${p.id}`, undefined, 'expand=author,comments&fields=title')).body as { title: string; author: Record<string, unknown>; comments: { text: string }[]; views?: number };
  assert.equal(r.title, 'T');
  assert.equal(r.views, undefined);
  assert.equal(r.author['name'], 'Ada');
  assert.equal('salary' in r.author, false);
  assert.deepEqual(r.comments.map((c) => c.text), ['one', 'two']);
  const gone = (await call(bob, 'POST', '/posts', { title: 'Orphan', authorId: 'missing' })).body as { id: string };
  assert.equal(((await call(bob, 'GET', `/posts/${gone.id}`, undefined, 'expand=author')).body as { author: unknown }).author, null);
});

test('declare refuses a broken declaration with every problem listed', () => {
  const bad: Entity[] = [
    { name: 'thing', plural: 'Things', fields: { m: { type: 'json', filterable: true }, e: { type: 'boolean', enum: ['a'] }, d: { type: 'integer', default: 'x' } } },
    { name: 'Other', plural: 'others', fields: {}, relations: { r: { entity: 'Missing', kind: 'one', field: 'x' } }, defaultSort: ['nope'] },
  ];
  assert.throws(() => declare(bad), (e: unknown) => e instanceof BadSchema && e.problems.length >= 6 && e.problems.some((p) => p.includes('Missing')) && e.problems.some((p) => p.includes('json field')));
});

test('the generated OpenAPI document is sound, covers each route and matches real responses', async () => {
  const { api, call } = setup();
  const doc = api.openapi({ title: 'Blog', version: '1.0.0' });
  assert.deepEqual(check(doc).errors, []);
  assert.ok(doc.paths['/v1/posts']!['get'] && doc.paths['/v1/posts/{id}']!['patch'] && !doc.paths['/v1/comments/{id}']!['delete']);
  const params = (doc.paths['/v1/posts']!['get']!['parameters'] as { name: string }[]).map((p) => p.name);
  assert.ok(params.includes('filter[views]') && params.includes('sort') && !params.includes('filter[meta]'));
  assert.equal(contract(doc).length, 13);
  const made = await call(bob, 'POST', '/posts', { title: 'Hi', authorId: 'u2' });
  assert.deepEqual(verifyResponse(doc, { operationId: 'createPost' }, { status: made.status, headers: { ...made.headers }, body: made.body }), []);
  const list = await call(bob, 'GET', '/posts');
  assert.deepEqual(verifyResponse(doc, { operationId: 'listPost' }, { status: list.status, headers: { ...list.headers }, body: list.body }), []);
  const bad = await call(bob, 'POST', '/posts', {});
  assert.deepEqual(verifyResponse(doc, { operationId: 'createPost' }, { status: bad.status, headers: { ...bad.headers }, body: bad.body }), []);
});
