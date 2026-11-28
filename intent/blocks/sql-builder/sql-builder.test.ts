import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSql, insertSql, updateSql, deleteSql, planToSql, placeholdersMatch, checkReadOnly, assertReadOnly, policyFor, limitTo, checkExplain, SqlError, UnsafeSql } from './index.ts';
import type { Collection } from '../query/index.ts';

const cols: Collection[] = [
  { name: 'customers', fields: { id: { type: 'number' }, name: { type: 'string' }, email: { type: 'string', sensitive: true }, created: { type: 'date' }, vip: { type: 'boolean' } } },
  { name: 'orders', fields: { id: { type: 'number' }, customer_id: { type: 'number' }, total: { type: 'number' }, status: { type: 'string' } } },
];
const policy = policyFor(cols, { maxLimit: 500 });

test('select quotes names and binds every value (pg)', () => {
  const b = selectSql({ from: 'orders', columns: ['id', 'total'], where: { and: [{ column: 'status', op: '=', value: 'open' }, { column: 'total', op: '>=', value: 10 }] }, limit: 20 }, cols);
  assert.equal(b.text, 'SELECT "orders"."id", "orders"."total" FROM "orders" WHERE ("orders"."status" = $1 AND "orders"."total" >= $2) LIMIT $3');
  assert.deepEqual(b.params, ['open', 10, 20]);
  assert.ok(placeholdersMatch(b));
});

test('mysql and sqlite use ? and their quoting', () => {
  const b = selectSql({ from: 'orders', columns: ['id'], where: { column: 'id', op: 'in', value: [1, 2, 3] } }, cols, { dialect: 'mysql' });
  assert.match(b.text, /^SELECT `orders`\.`id` FROM `orders` WHERE `orders`\.`id` IN \(\?, \?, \?\) LIMIT \?$/);
  assert.deepEqual(b.params, [1, 2, 3, 100]);
  assert.ok(placeholdersMatch(b, 'mysql'));
});

test('injection text stays in the parameters', () => {
  const evil = "x'; DROP TABLE orders; --";
  const b = selectSql({ from: 'orders', columns: ['id'], where: { column: 'status', op: '=', value: evil } }, cols);
  assert.ok(!b.text.includes('DROP'));
  assert.deepEqual(b.params[0], evil);
});

test('unknown tables and columns, and name-shaped injection, are refused', () => {
  assert.throws(() => selectSql({ from: 'users', columns: ['id'] }, cols), SqlError);
  assert.throws(() => selectSql({ from: 'orders', columns: ['id; DROP TABLE x'] }, cols), SqlError);
  assert.throws(() => selectSql({ from: 'orders', where: { column: 'nope', op: '=', value: 1 } }, cols), SqlError);
  assert.throws(() => selectSql({ from: 'orders', columns: ['constructor'] }, cols), SqlError);
});

test('sensitive columns are excluded by default and refused when named', () => {
  const b = selectSql({ from: 'customers' }, cols);
  assert.ok(!b.text.includes('email'));
  assert.throws(() => selectSql({ from: 'customers', columns: ['email'] }, cols), /sensitive/);
  assert.throws(() => selectSql({ from: 'customers', where: { column: 'email', op: '=', value: 'a' } }, cols), /sensitive/);
  assert.ok(selectSql({ from: 'customers', columns: ['email'] }, cols, { allowSensitive: true }).text.includes('email'));
});

test('values are type checked against the column', () => {
  assert.throws(() => selectSql({ from: 'orders', where: { column: 'total', op: '=', value: '5 OR 1=1' } }, cols), /number/);
  assert.throws(() => selectSql({ from: 'customers', where: { column: 'vip', op: '>', value: true } }, cols), SqlError);
  assert.throws(() => selectSql({ from: 'customers', where: { column: 'created', op: '=', value: 'yesterday' } }, cols), /date/);
  assert.ok(selectSql({ from: 'customers', where: { column: 'created', op: '>', value: '2026-03-01' } }, cols).params.includes('2026-03-01'));
});

test('contains escapes LIKE wildcards', () => {
  const b = selectSql({ from: 'customers', columns: ['id'], where: { column: 'name', op: 'contains', value: '50%_off' } }, cols);
  assert.deepEqual(b.params[0], '%50\\%\\_off%');
  assert.match(b.text, /ILIKE \$1 ESCAPE/);
});

test('joins need a real pair of columns of matching type', () => {
  const b = selectSql({ from: 'orders', columns: ['orders.id', 'customers.name'], joins: [{ table: 'customers', on: ['orders.customer_id', 'customers.id'] }] }, cols);
  assert.match(b.text, /INNER JOIN "customers" ON "orders"\."customer_id" = "customers"\."id"/);
  assert.throws(() => selectSql({ from: 'orders', joins: [{ table: 'customers', on: ['orders.status', 'customers.id'] }] }, cols), /same kind/);
  assert.throws(() => selectSql({ from: 'orders', columns: ['id'], joins: [{ table: 'customers', on: ['orders.customer_id', 'customers.id'] }] }, cols), /more than one table/);
});

test('aggregates need grouping and numeric columns', () => {
  const b = selectSql({ from: 'orders', columns: ['status', { fn: 'sum', column: 'total', as: 'revenue' }], groupBy: ['status'], having: { fn: 'count', op: '>', value: 2 }, orderBy: [{ column: 'revenue', dir: 'desc' }] }, cols);
  assert.match(b.text, /SUM\("orders"\."total"\) AS "revenue" FROM "orders" GROUP BY "orders"."status" HAVING COUNT\(\*\) > \$1 ORDER BY "revenue" DESC/);
  assert.throws(() => selectSql({ from: 'orders', columns: ['status', { fn: 'count' }] }, cols), /groupBy/);
  assert.throws(() => selectSql({ from: 'orders', columns: [{ fn: 'sum', column: 'status' }] }, cols), /number/);
});

test('limit and offset are clamped by refusal', () => {
  assert.throws(() => selectSql({ from: 'orders', limit: 5000 }, cols), SqlError);
  assert.throws(() => selectSql({ from: 'orders', limit: 1.5 }, cols), SqlError);
  assert.throws(() => selectSql({ from: 'orders', offset: -1 }, cols), SqlError);
  assert.throws(() => selectSql({ from: 'orders', where: { column: 'id', op: 'in', value: [] } }, cols), SqlError);
});

test('insert, update and delete are parameterised and delete/update need a condition', () => {
  const i = insertSql('orders', { customer_id: 1, total: 9.5, status: 'new' }, cols);
  assert.equal(i.text, 'INSERT INTO "orders" ("customer_id", "total", "status") VALUES ($1, $2, $3)');
  const u = updateSql('orders', { status: 'done' }, { column: 'id', op: '=', value: 3 }, cols);
  assert.equal(u.text, 'UPDATE "orders" SET "status" = $1 WHERE "orders"."id" = $2');
  assert.deepEqual(u.params, ['done', 3]);
  const d = deleteSql('orders', { column: 'id', op: '=', value: 3 }, cols);
  assert.equal(d.text, 'DELETE FROM "orders" WHERE "orders"."id" = $1');
  assert.throws(() => updateSql('orders', { status: 'x' }, undefined as never, cols), SqlError);
  assert.throws(() => deleteSql('orders', undefined as never, cols), SqlError);
  assert.throws(() => insertSql('customers', { email: 'a' }, cols), /cannot be written/);
  assert.throws(() => updateSql('orders', { status: 'x' }, { column: 'id', op: '=', value: 1 }, cols, { writable: ['total'] }), /cannot be written/);
});

test('a plan from the query block becomes SQL', () => {
  const b = planToSql({ from: 'orders', where: [{ field: 'status', op: '=', value: 'open' }], order: { field: 'total', desc: true }, limit: 5, select: ['id'] }, cols);
  assert.match(b.text, /WHERE \("orders"."status" = \$1\) ORDER BY "orders"."total" DESC LIMIT \$2/);
});

test('checker accepts plain selects, joins, CTEs and subqueries over allowed tables', () => {
  assert.ok(checkReadOnly('SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.total > 5 LIMIT 10', policy).ok);
  const c = checkReadOnly('WITH big AS (SELECT id FROM orders WHERE total > 100) SELECT id FROM big LIMIT 5;', policy);
  assert.ok(c.ok, c.problems.join());
  const s = checkReadOnly('SELECT id FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE vip = true) LIMIT 5', policy);
  assert.ok(s.ok, s.problems.join());
  assert.equal(s.subqueryDepth, 1);
});

test('checker refuses writes, second statements and SELECT INTO', () => {
  for (const q of ['DELETE FROM orders', 'SELECT 1; DROP TABLE orders', 'SELECT id INTO t FROM orders LIMIT 1', 'UPDATE orders SET total = 0', 'SELECT id FROM orders LIMIT 1 FOR UPDATE', 'WITH d AS (DELETE FROM orders RETURNING id) SELECT id FROM d LIMIT 1', 'COPY orders TO STDOUT']) {
    assert.equal(checkReadOnly(q, policy).ok, false, q);
  }
});

test('checker refuses tables off the list, including schema-qualified catalog tables', () => {
  assert.equal(checkReadOnly('SELECT id FROM users LIMIT 1', policy).ok, false);
  assert.equal(checkReadOnly('SELECT relname FROM pg_catalog.pg_class LIMIT 1', policy).ok, false);
  assert.equal(checkReadOnly('SELECT id FROM orders, users LIMIT 1', policy).ok, false);
  assert.equal(checkReadOnly('SELECT id FROM orders JOIN secrets ON 1=1 LIMIT 1', policy).ok, false);
});

test('checker refuses dangerous and unlisted functions', () => {
  assert.equal(checkReadOnly('SELECT pg_sleep(10) FROM orders LIMIT 1', policy).ok, false);
  assert.equal(checkReadOnly("SELECT pg_read_file('/etc/passwd') FROM orders LIMIT 1", policy).ok, false);
  assert.equal(checkReadOnly('SELECT public.my_fn(id) FROM orders LIMIT 1', policy).ok, false);
  assert.equal(checkReadOnly('SELECT whatever(id) FROM orders LIMIT 1', policy).ok, false);
  assert.equal(checkReadOnly('SELECT id FROM generate_series(1, 100000000) LIMIT 1', policy).ok, false);
  assert.ok(checkReadOnly('SELECT lower(status), count(*) FROM orders GROUP BY 1 LIMIT 5', policy).ok);
});

test('checker refuses comments, dollar quotes, backslashes and non-ASCII tricks', () => {
  for (const q of ['SELECT id FROM orders -- x\nLIMIT 1', 'SELECT id FROM orders /* x */ LIMIT 1', 'SELECT id FROM orders /*! DROP */ LIMIT 1', 'SELECT $$x$$ FROM orders LIMIT 1', "SELECT E'\\x' FROM orders LIMIT 1", "SELECT 'a\\' FROM orders LIMIT 1", 'SELECT id FROM orders LIMIT 1', 'SELECT id FROM orders # x\nLIMIT 1']) {
    assert.equal(checkReadOnly(q, policy).ok, false, JSON.stringify(q));
  }
  // a semicolon or keyword inside a string is only text
  assert.ok(checkReadOnly("SELECT id FROM orders WHERE status = 'a; DROP TABLE x' LIMIT 1", policy).ok);
});

test('checker keeps sensitive columns out, including through *', () => {
  assert.equal(checkReadOnly('SELECT email FROM customers LIMIT 1', policy).ok, false);
  assert.equal(checkReadOnly('SELECT "email" FROM customers LIMIT 1', policy).ok, false);
  assert.equal(checkReadOnly('SELECT * FROM customers LIMIT 1', policy).ok, false);
  assert.equal(checkReadOnly('SELECT c.* FROM customers c LIMIT 1', { ...policy, allowStar: true }).ok, false);
  assert.ok(checkReadOnly('SELECT count(*) FROM customers LIMIT 1', policy).ok);
});

test('cost caps: limit required and capped, offset, joins, cross joins, subquery depth, length', () => {
  assert.equal(checkReadOnly('SELECT id FROM orders', policy).ok, false);
  assert.equal(checkReadOnly('SELECT id FROM orders LIMIT 501', policy).ok, false);
  assert.equal(checkReadOnly('SELECT id FROM orders LIMIT 5 OFFSET 9999999', policy).ok, false);
  assert.equal(checkReadOnly('SELECT a.id FROM orders a CROSS JOIN orders b LIMIT 5', policy).ok, false);
  assert.equal(checkReadOnly('SELECT id FROM orders LIMIT 5', { ...policy, maxLength: 10 }).ok, false);
  const deep = 'SELECT id FROM orders WHERE id IN (SELECT id FROM orders WHERE id IN (SELECT id FROM orders WHERE id IN (SELECT id FROM orders WHERE id IN (SELECT id FROM orders)))) LIMIT 1';
  assert.equal(checkReadOnly(deep, policy).ok, false);
  assert.ok(checkReadOnly('SELECT id FROM orders', { ...policy, requireLimit: false }).ok);
});

test('assertReadOnly throws UnsafeSql listing the problems', () => {
  assert.throws(() => assertReadOnly('DROP TABLE orders', policy), (e: unknown) => e instanceof UnsafeSql && e.problems.length > 0);
});

test('limitTo adds or clamps the outer limit and leaves inner ones', () => {
  assert.equal(limitTo('SELECT id FROM orders', 50), 'SELECT id FROM orders LIMIT 50');
  assert.equal(limitTo('SELECT id FROM orders LIMIT 900;', 50), 'SELECT id FROM orders LIMIT 50');
  assert.equal(limitTo('SELECT id FROM orders LIMIT 10', 50), 'SELECT id FROM orders LIMIT 10');
  assert.equal(limitTo('SELECT id FROM (SELECT id FROM orders LIMIT 9000) t', 50), 'SELECT id FROM (SELECT id FROM orders LIMIT 9000) t LIMIT 50');
  assert.throws(() => limitTo('SELECT 1 -- x', 5), UnsafeSql);
});

test('checkExplain flags cost, rows and big sequential scans', () => {
  const plan = [{ Plan: { 'Node Type': 'Hash Join', 'Total Cost': 5000, 'Plan Rows': 200, Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Plan Rows': 900000, 'Total Cost': 10 }] } }];
  assert.deepEqual(checkExplain(plan, { maxTotalCost: 10000, maxRows: 1000 }), []);
  assert.equal(checkExplain(plan, { maxTotalCost: 1000 }).length, 1);
  assert.equal(checkExplain(plan, { maxRows: 100 }).length, 1);
  const seq = checkExplain(plan, { maxSeqScanRows: 100000 });
  assert.match(seq[0]!, /orders/);
  assert.throws(() => checkExplain({ nope: 1 }, {}), SqlError);
});
