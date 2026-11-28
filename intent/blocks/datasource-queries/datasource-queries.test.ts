import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Engine, QueryDefError, BadArguments, Forbidden, BadCursor } from './index.ts';
import type { DataSource, Session } from './index.ts';
import type { Built } from '../sql-builder/index.ts';
import type { Collection } from '../query/index.ts';

const collections: Collection[] = [
  { name: 'orders', fields: { id: { type: 'number' }, owner_id: { type: 'string' }, status: { type: 'string' }, total: { type: 'number' }, created: { type: 'date' }, note: { type: 'string', sensitive: true } } },
  { name: 'customers', fields: { id: { type: 'number' }, name: { type: 'string' }, email: { type: 'string' } } },
];
const ana: Session = { user: 'ana', roles: ['sales'], attrs: { team: 'north' } };
const boss: Session = { user: 'boss', roles: ['manager'] };
const nobody: Session = { user: 'x', roles: [] };

function setup(rowsFor: (b: Built, n: number) => Record<string, unknown>[] = () => []) {
  const calls: Built[] = [];
  const src: DataSource = {
    name: 'main',
    dialect: 'pg',
    collections,
    policy: {
      orders: { roles: ['sales', 'manager'], columns: { sales: ['id', 'status', 'total', 'created', 'owner_id'] }, rowFilter: (s) => (s.roles.includes('manager') ? undefined : { column: 'owner_id', op: '=', value: s.user }) },
      customers: { roles: ['sales', 'manager'], columns: { sales: ['id', 'name'] } },
    },
    run: async (b) => {
      calls.push(b);
      return rowsFor(b, calls.length);
    },
  };
  const e = new Engine({ signingKey: randomBytes(32) });
  e.addSource(src);
  return { e, calls };
}

const listOrders = {
  id: 'listOrders',
  datasource: 'main',
  params: [{ name: 'status', type: 'string' as const, options: ['open', 'paid'] }, { name: 'min', type: 'number' as const, min: 0 }],
  spec: { from: 'orders', columns: ['id', 'status', 'total'], where: { and: [{ column: 'status', op: '=' as const, value: { $param: 'status' }, optional: true }, { column: 'total', op: '>=' as const, value: { $param: 'min' }, optional: true }] }, orderBy: [{ column: 'id' }] },
  pagination: { mode: 'offset' as const, defaultSize: 2, maxSize: 5 },
};

test('a spec query binds arguments, drops optional filters that are absent, and adds the row filter', async () => {
  const { e, calls } = setup();
  e.define(listOrders);
  await e.run('listOrders', ana, { args: { status: 'open' } });
  assert.match(calls[0]!.text, /WHERE \(\("orders"\."status" = \$1\) AND "orders"\."owner_id" = \$2\)/);
  assert.deepEqual(calls[0]!.params.slice(0, 2), ['open', 'ana']);
  await e.run('listOrders', boss, {});
  assert.ok(!calls[1]!.text.includes('WHERE'));
});

test('arguments are validated: types, choices, unknown names, required', async () => {
  const { e } = setup();
  e.define({ ...listOrders, params: [...listOrders.params, { name: 'must', type: 'string' as const, required: true }] });
  await assert.rejects(e.run('listOrders', ana, { args: { must: 'x', status: 'refunded' } }), (x: unknown) => x instanceof BadArguments && x.problems.some((p) => p.path === 'status'));
  await assert.rejects(e.run('listOrders', ana, { args: { must: 'x', evil: 1 } }), /not a parameter/);
  await assert.rejects(e.run('listOrders', ana, { args: { must: 'x', min: 'abc' } }), BadArguments);
  await assert.rejects(e.run('listOrders', ana, { args: {} }), /must is needed/);
});

test('injection in an argument stays a bound parameter', async () => {
  const { e, calls } = setup();
  e.define({ id: 'byNote', datasource: 'main', params: [{ name: 'q', type: 'string' }], spec: { from: 'customers', columns: ['id', 'name'], where: { column: 'name', op: 'contains', value: { $param: 'q' } } }, pagination: { mode: 'offset' } });
  await e.run('byNote', ana, { args: { q: "x'; DROP TABLE customers; --" } });
  assert.ok(!calls[0]!.text.includes('DROP'));
  assert.ok(calls[0]!.params.includes("%x'; DROP TABLE customers; --%"));
});

test('offset paging reads one extra row to know if there is more, and caps the size', async () => {
  const { e, calls } = setup(() => [{ id: 1 }, { id: 2 }, { id: 3 }]);
  e.define(listOrders);
  const r = await e.run('listOrders', boss, { page: 2, size: 2 });
  assert.equal(r.rows.length, 2);
  assert.equal(r.page.hasMore, true);
  assert.equal(r.page.page, 2);
  assert.deepEqual(calls[0]!.params.slice(-2), [3, 2]);
  await assert.rejects(e.run('listOrders', boss, { size: 6 }), BadArguments);
  await assert.rejects(e.run('listOrders', boss, { page: 0 }), BadArguments);
  const last = await e.run('listOrders', boss, { size: 3 });
  assert.equal(last.page.hasMore, false);
});

const keysetDef = { id: 'feed', datasource: 'main', spec: { from: 'orders', columns: ['created', 'id', 'status'], orderBy: [{ column: 'created', dir: 'desc' as const }, { column: 'id', dir: 'desc' as const }] }, pagination: { mode: 'keyset' as const, defaultSize: 2, maxSize: 10 } };

test('keyset paging issues a signed cursor and builds the seek condition', async () => {
  const rows = [{ created: '2026-01-03', id: 9, status: 'open' }, { created: '2026-01-03', id: 8, status: 'open' }, { created: '2026-01-02', id: 7, status: 'paid' }];
  const { e, calls } = setup(() => rows);
  e.define(keysetDef);
  const first = await e.run('feed', boss);
  assert.equal(first.rows.length, 2);
  assert.ok(first.page.next);
  const second = await e.run('feed', boss, { cursor: first.page.next! });
  assert.match(calls[1]!.text, /\(\("orders"\."created" < \$1\) OR \("orders"\."created" = \$2 AND "orders"\."id" < \$3\)\)/);
  assert.deepEqual(calls[1]!.params.slice(0, 3), ['2026-01-03', '2026-01-03', 8]);
  assert.ok(second.rows.length);
});

test('a cursor cannot be edited, reused on other arguments, other users or other queries', async () => {
  const rows = [{ created: '2026-01-03', id: 9, status: 'open' }, { created: '2026-01-03', id: 8, status: 'open' }, { created: '2026-01-02', id: 7, status: 'paid' }];
  const { e } = setup(() => rows);
  e.define(keysetDef);
  e.define({ ...keysetDef, id: 'feed2', params: [{ name: 'status', type: 'string' as const }], spec: { ...keysetDef.spec, where: { column: 'status', op: '=' as const, value: { $param: 'status' }, optional: true } } });
  const c = (await e.run('feed', boss)).page.next!;
  await assert.rejects(e.run('feed', boss, { cursor: `${c.slice(0, -2)}xx` }), BadCursor);
  await assert.rejects(e.run('feed', boss, { cursor: 'garbage' }), BadCursor);
  await assert.rejects(e.run('feed', { ...boss, user: 'other' }, { cursor: c }), /other arguments/);
  await assert.rejects(e.run('feed2', boss, { cursor: c }), /another query/);
  const c2 = (await e.run('feed2', boss, { args: { status: 'open' } })).page.next!;
  await assert.rejects(e.run('feed2', boss, { args: { status: 'paid' }, cursor: c2 }), /other arguments/);
});

test('permissions: no role, no table; columns narrowed to what the role sees; asking for more is refused', async () => {
  const { e, calls } = setup();
  e.define({ id: 'allOrders', datasource: 'main', spec: { from: 'orders' }, pagination: { mode: 'offset' } });
  e.define({ id: 'withNote', datasource: 'main', spec: { from: 'orders', columns: ['id', 'note'] } });
  await assert.rejects(e.run('allOrders', nobody), Forbidden);
  await e.run('allOrders', ana);
  assert.ok(!calls[0]!.text.includes('"note"'));
  await assert.rejects(e.run('withNote', boss), /sensitive|cannot/);
  e.define({ id: 'custEmail', datasource: 'main', spec: { from: 'customers', columns: ['id', 'email'] } });
  await assert.rejects(e.run('custEmail', ana), /cannot read customers.email/);
  await e.run('custEmail', boss);
});

test('template sql: placeholders become parameters, lists expand, session values bind', async () => {
  const { e, calls } = setup();
  e.define({ id: 't1', datasource: 'main', params: [{ name: 'ids', type: 'number', list: true, required: true }, { name: 'st', type: 'string' }], sql: 'SELECT id, name FROM customers WHERE id IN ({{ids}}) AND name <> {{st}}', maxRows: 50 });
  await e.run('t1', ana, { args: { ids: [1, 2, 3], st: 'x' } });
  assert.match(calls[0]!.text, /IN \(\$1, \$2, \$3\) AND name <> \$4 LIMIT 50$/);
  assert.deepEqual(calls[0]!.params, [1, 2, 3, 'x']);
  await assert.rejects(e.run('t1', ana, { args: { ids: [] } }), BadArguments);
});

test('template sql definitions are checked when defined', () => {
  const { e } = setup();
  assert.throws(() => e.define({ id: 'bad1', datasource: 'main', sql: "SELECT id FROM customers WHERE name = '{{x}}'" }), /inside quotes/);
  assert.throws(() => e.define({ id: 'bad2', datasource: 'main', sql: 'SELECT id FROM customers WHERE id = {{nope}}' }), /not a declared parameter/);
  assert.throws(() => e.define({ id: 'bad3', datasource: 'main', sql: 'DELETE FROM customers' }), /not allowed|only SELECT/i);
  assert.throws(() => e.define({ id: 'bad4', datasource: 'main', sql: 'SELECT id FROM secrets' }), QueryDefError);
  assert.throws(() => e.define({ id: 'bad5', datasource: 'main', sql: 'SELECT 1', spec: { from: 'orders' } }), /either/);
  assert.throws(() => e.define({ id: 'bad6', datasource: 'main', spec: { from: 'ghost' } }), QueryDefError);
  assert.throws(() => e.define({ id: 'bad7', datasource: 'main', spec: { from: 'orders', where: { column: 'id', op: '=', value: { $param: 'zzz' } } } }), /declared parameter/);
  assert.throws(() => e.define({ id: 'bad8', datasource: 'main', spec: { from: 'orders' }, pagination: { mode: 'keyset' } }), /orderBy/);
  assert.throws(() => e.define({ id: 'bad id', datasource: 'main', spec: { from: 'orders' } }), QueryDefError);
});

test('template sql is checked per session: hidden columns and row-filtered tables are refused', async () => {
  const { e } = setup();
  e.define({ id: 'email', datasource: 'main', sql: 'SELECT id, email FROM customers', maxRows: 10 });
  e.define({ id: 'raw_orders', datasource: 'main', sql: 'SELECT id FROM orders', maxRows: 10 });
  await assert.rejects(e.run('email', ana), /not allowed for you/);
  await e.run('email', boss);
  await assert.rejects(e.run('raw_orders', boss), /row rules/);
});

test('cache: a second identical call is served from cache; different args, roles and users are not shared', async () => {
  const { e, calls } = setup(() => [{ id: 1 }]);
  e.define({ ...listOrders, ttlMs: 60_000 });
  const a = await e.run('listOrders', boss, { args: { status: 'open' } });
  const b = await e.run('listOrders', boss, { args: { status: 'open' } });
  assert.deepEqual([a.fromCache, b.fromCache, calls.length], [false, true, 1]);
  await e.run('listOrders', boss, { args: { status: 'paid' } });
  await e.run('listOrders', ana, { args: { status: 'open' } });
  await e.run('listOrders', { ...ana, user: 'bea' }, { args: { status: 'open' } });
  assert.equal(calls.length, 4);
  await e.run('listOrders', ana, { args: { status: 'open' } });
  assert.equal(calls.length, 4);
});

test('invalidateTable drops what read that table and nothing else', async () => {
  const { e, calls } = setup(() => [{ id: 1 }]);
  e.define({ ...listOrders, ttlMs: 60_000 });
  e.define({ id: 'cust', datasource: 'main', spec: { from: 'customers', columns: ['id'] }, ttlMs: 60_000 });
  await e.run('listOrders', boss);
  await e.run('cust', boss);
  assert.equal(e.invalidateTable('orders'), 1);
  await e.run('listOrders', boss);
  await e.run('cust', boss);
  assert.equal(calls.length, 3);
});

test('a slow source times out; the engine and sources validate their setup', async () => {
  const e = new Engine({ signingKey: randomBytes(32) });
  e.addSource({ name: 'slow', dialect: 'sqlite', collections, policy: { customers: { roles: ['sales'] } }, run: () => new Promise(() => {}) });
  e.define({ id: 'slowq', datasource: 'slow', spec: { from: 'customers', columns: ['id'] }, timeoutMs: 20 });
  await assert.rejects(e.run('slowq', ana), /no answer within 20 ms/);
  assert.throws(() => new Engine({ signingKey: 'short' }), QueryDefError);
  assert.throws(() => e.addSource({ name: 'slow', dialect: 'pg', collections, policy: {}, run: async () => [] }), /already defined/);
  assert.throws(() => e.addSource({ name: 'p', dialect: 'pg', collections, policy: { ghost: { roles: [] } }, run: async () => [] }), /not a table/);
  assert.throws(() => e.define({ id: 'slowq', datasource: 'slow', spec: { from: 'customers' } }), /already defined/);
});
