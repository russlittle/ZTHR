import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { compile, DIALECTS, QueryModelError } from './index.ts';
import type { StructuredQuery } from './index.ts';

const schema = {
  orders: ['id', 'customer_id', 'total', 'status', 'created_at', 'note'],
  customers: ['id', 'name', 'country'],
};

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    create table customers (id integer primary key, name text, country text);
    create table orders (id integer primary key, customer_id integer, total real, status text, created_at text, note text);
    insert into customers values (1,'Ada','UK'),(2,'Grace','US'),(3,'Linus','FI'),(4,'Nobody','US');
    insert into orders values
      (1,1,10,'paid','2026-01-05 10:00:00','50% off'),
      (2,1,35,'paid','2026-01-20 11:30:00',null),
      (3,2,5,'open','2026-02-02 09:00:00','a_b'),
      (4,2,95,'paid','2026-02-14 23:59:00',null),
      (5,3,0,'void','2026-04-01 00:00:00',null);
  `);
  return d;
}
const run = (q: StructuredQuery, values?: Record<string, never>) => {
  const c = compile(q, { dialect: 'sqlite', schema, ...(values ? { values } : {}) });
  return db().prepare(c.sql).all(...(c.params as never[])) as Record<string, unknown>[];
};

test('a plain query selects all columns of the source and quotes the identifiers', () => {
  const c = compile({ source: 'orders' }, { dialect: 'postgres', schema });
  assert.equal(c.sql, 'SELECT "orders".* FROM "orders"');
  assert.deepEqual(c.params, []);
  assert.deepEqual(c.columns, schema.orders);
});

test('every value is a numbered parameter in postgres and a question mark in sqlite, never text in the SQL', () => {
  const q: StructuredQuery = { source: 'orders', filter: { and: [{ op: '=', left: { field: 'status' }, right: { value: "paid' OR '1'='1" } }, { op: '>', left: { field: 'total' }, right: { value: 20 } }] } };
  const pg = compile(q, { dialect: 'postgres', schema });
  assert.equal(pg.sql, 'SELECT "orders".* FROM "orders" WHERE ("orders"."status" = $1 AND "orders"."total" > $2)');
  assert.deepEqual(pg.params, ["paid' OR '1'='1", 20]);
  const lite = compile(q, { dialect: 'sqlite', schema });
  assert.equal(lite.sql, 'SELECT "orders".* FROM "orders" WHERE ("orders"."status" = ? AND "orders"."total" > ?)');
  assert.ok(!lite.sql.includes('OR'));
  assert.equal(compile(q, { dialect: 'bigquery' }).sql, 'SELECT `orders`.* FROM `orders` WHERE (`orders`.`status` = @p1 AND `orders`.`total` > @p2)');
});

test('identifiers that are not plain names are refused, so a name cannot carry SQL', () => {
  assert.throws(() => compile({ source: 'orders; DROP TABLE orders' }), QueryModelError);
  assert.throws(() => compile({ source: 'orders', fields: [{ field: 'total"--' }] }), /not a plain name/);
  assert.throws(() => compile({ source: 'orders', breakouts: [{ field: 'a.b.c' }] }), /too many parts/);
  assert.throws(() => compile({ source: 'orders', alias: '1x' }), /not a plain name/);
});

test('with a schema, unknown tables and columns are refused', () => {
  assert.throws(() => compile({ source: 'users' }, { schema }), /table "users" is not in the schema/);
  assert.throws(() => compile({ source: 'orders', fields: [{ field: 'secret' }] }, { schema }), /column "secret" is not in table "orders"/);
  assert.throws(() => compile({ source: 'orders', fields: [{ field: 'customers.name' }] }, { schema }), /not part of this query/);
  assert.throws(() => compile({ source: 'orders', joins: [{ table: 'ghosts', on: [{ left: 'id', right: 'ghosts.id' }] }] }, { schema }), /not in the schema/);
});

test('group by a breakout with count and sum, ordered by an output column, runs and gives the right numbers', () => {
  const rows = run({
    source: 'orders',
    breakouts: [{ field: 'status' }],
    aggregations: [{ op: 'count' }, { op: 'sum', field: 'total', as: 'revenue' }],
    orderBy: [{ by: 'revenue', dir: 'desc' }],
  });
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { status: 'paid', count: 3, revenue: 140 },
    { status: 'open', count: 1, revenue: 5 },
    { status: 'void', count: 1, revenue: 0 },
  ]);
});

test('aggregates avg, min, max, distinct and a conditional count each compute their own value', () => {
  const [r] = run({
    source: 'orders',
    aggregations: [
      { op: 'avg', field: 'total', as: 'a' },
      { op: 'min', field: 'total', as: 'lo' },
      { op: 'max', field: 'total', as: 'hi' },
      { op: 'distinct', field: 'customer_id', as: 'people' },
      { op: 'count', where: { op: '=', left: { field: 'status' }, right: { value: 'paid' } }, as: 'paid_n' },
      { op: 'sum', field: 'total', where: { op: '=', left: { field: 'status' }, right: { value: 'paid' } }, as: 'paid_sum' },
    ],
  });
  assert.deepEqual({ ...r }, { a: 29, lo: 0, hi: 95, people: 3, paid_n: 3, paid_sum: 140 });
});

test('a join writes its type and its ON pairs, and left join keeps customers with no orders', () => {
  const q: StructuredQuery = {
    source: 'customers',
    joins: [{ table: 'orders', type: 'left', on: [{ left: 'customers.id', right: 'orders.customer_id' }] }],
    breakouts: [{ field: 'customers.name' }],
    aggregations: [{ op: 'count', field: 'orders.id', as: 'n' }],
    orderBy: [{ by: 'name' }],
  };
  assert.match(compile(q, { schema }).sql, /LEFT JOIN "orders" ON "customers"."id" = "orders"."customer_id"/);
  assert.deepEqual(run(q).map((r) => ({ ...r })), [
    { name: 'Ada', n: 2 }, { name: 'Grace', n: 2 }, { name: 'Linus', n: 1 }, { name: 'Nobody', n: 0 },
  ]);
});

test('a join with an alias, twice-used alias refused, and a join without match columns refused', () => {
  const c = compile({ source: 'orders', alias: 'o', joins: [{ table: 'customers', alias: 'c', on: [{ left: 'o.customer_id', right: 'c.id' }] }], fields: [{ field: 'o.id' }, { field: 'c.name' }] }, { schema });
  assert.equal(c.sql, 'SELECT "o"."id" AS "id", "c"."name" AS "name" FROM "orders" AS "o" INNER JOIN "customers" AS "c" ON "o"."customer_id" = "c"."id"');
  assert.throws(() => compile({ source: 'orders', joins: [{ table: 'customers', alias: 'orders', on: [{ left: 'a', right: 'b' }] }] }), /used twice/);
  assert.throws(() => compile({ source: 'orders', joins: [{ table: 'customers', on: [] }] }), /at least one pair/);
  assert.throws(() => compile({ source: 'orders', joins: [{ table: 'customers', type: 'full', on: [{ left: 'customer_id', right: 'customers.id' }] }] }, { dialect: 'sqlite' }), /does not support FULL JOIN/);
});

test('time binning truncates per dialect, and month buckets group real rows', () => {
  const b = { field: 'created_at', binning: { time: 'month' as const } };
  assert.match(compile({ source: 'orders', breakouts: [b], aggregations: [{ op: 'count' }] }, { dialect: 'postgres' }).sql, /date_trunc\('month', "orders"."created_at"\) AS "created_at_month"/);
  assert.match(compile({ source: 'orders', breakouts: [b], aggregations: [{ op: 'count' }] }, { dialect: 'mysql' }).sql, /DATE_FORMAT\(`orders`.`created_at`, '%Y-%m-01'\)/);
  assert.match(compile({ source: 'orders', breakouts: [b], aggregations: [{ op: 'count' }] }, { dialect: 'bigquery' }).sql, /TIMESTAMP_TRUNC\(`orders`.`created_at`, MONTH\)/);
  const rows = run({ source: 'orders', breakouts: [b], aggregations: [{ op: 'count' }], orderBy: [{ by: 'created_at_month' }] });
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { created_at_month: '2026-01-01', count: 2 }, { created_at_month: '2026-02-01', count: 2 }, { created_at_month: '2026-04-01', count: 1 },
  ]);
});

test('sqlite week and year and quarter truncation return the first day of the period', () => {
  const sql = (unit: 'week' | 'year' | 'quarter') => compile({ source: 'orders', breakouts: [{ field: 'created_at', binning: { time: unit } }] }, { dialect: 'sqlite' });
  const d = db();
  const got = (u: 'week' | 'year' | 'quarter', ts: string) => {
    const c = sql(u);
    const expr = c.sql.slice('SELECT '.length, c.sql.indexOf(' AS "')).replaceAll('"orders"."created_at"', `'${ts}'`);
    return (d.prepare(`select ${expr} as v`).get() as { v: string }).v;
  };
  assert.equal(got('week', '2026-01-07 10:00:00'), '2026-01-05'); // a Wednesday: the week starts Monday 5 Jan
  assert.equal(got('week', '2026-01-04 10:00:00'), '2025-12-29'); // Sunday belongs to the week that began Monday
  assert.equal(got('year', '2026-08-09 00:00:00'), '2026-01-01');
  assert.equal(got('quarter', '2026-05-09 00:00:00'), '2026-04-01');
  assert.equal(got('quarter', '2026-12-31 00:00:00'), '2026-10-01');
});

test('numeric binning buckets by width and offset and runs: 0-49 and 50-99', () => {
  const rows = run({ source: 'orders', breakouts: [{ field: 'total', binning: { width: 50 } }], aggregations: [{ op: 'count' }], orderBy: [{ by: 'total_binned' }] });
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ total_binned: 0, count: 4 }, { total_binned: 50, count: 1 }]);
  assert.throws(() => compile({ source: 'orders', breakouts: [{ field: 'total', binning: { width: 0 } }] }), /positive/);
  const c = compile({ source: 'orders', breakouts: [{ field: 'total', binning: { width: 10, offset: 5 } }] }, { dialect: 'sqlite' });
  assert.deepEqual(c.params, [5, 10, 10, 5, 5, 10, 10, 5]); // select then group by, each in text order
});

test('custom columns compute, can be used in filters by name, and divide safely by zero', () => {
  const q: StructuredQuery = {
    source: 'orders',
    expressions: [{ name: 'half', expr: { op: '/', args: [{ field: 'total' }, { value: 2 }] } }, { name: 'ratio', expr: { op: '/', args: [{ field: 'total' }, { field: 'customer_id' }] } }],
    filter: { op: '>=', left: { field: 'half' }, right: { value: 10 } },
  };
  const c = compile(q, { dialect: 'sqlite', schema });
  assert.match(c.sql, /NULLIF\(\?, 0\)/);
  const rows = run(q);
  assert.deepEqual(rows.map((r) => [r['id'], r['half']]), [[2, 17.5], [4, 47.5]]);
  assert.equal(compile({ source: 'orders', expressions: [{ name: 'x', expr: { op: '/', args: [{ value: 1 }, { value: 0 }] } }] }, { dialect: 'sqlite' }).sql.includes('NULLIF'), true);
  assert.throws(() => compile({ source: 'orders', expressions: [{ name: 'a', expr: { field: 'b' } }, { name: 'b', expr: { field: 'a' } }], filter: { op: 'is-null', left: { field: 'a' } } }), /refers to itself/);
  assert.throws(() => compile({ source: 'orders', expressions: [{ name: 'a', expr: { value: 1 } }, { name: 'a', expr: { value: 2 } }] }), /defined twice/);
});

test('case expressions and concat choose per row', () => {
  const rows = run({
    source: 'orders',
    fields: [
      { field: 'id' },
      { as: 'size', expr: { op: 'case', cases: [{ when: { op: '>=', left: { field: 'total' }, right: { value: 50 } }, then: { value: 'big' } }, { when: { op: '>', left: { field: 'total' }, right: { value: 0 } }, then: { value: 'small' } }], else: { value: 'none' } } },
      { as: 'label', expr: { op: 'concat', args: [{ field: 'status' }, { value: '#' }, { field: 'note' }] } },
    ],
    orderBy: [{ by: 'id' }],
  });
  assert.deepEqual(rows.map((r) => [r['size'], r['label']]), [['small', 'paid#50% off'], ['small', 'paid#'], ['small', 'open#a_b'], ['big', 'paid#'], ['none', 'void#']]);
});

test('filters: between, in, not-in, is-null, not-null, not and or', () => {
  const ids = (f: StructuredQuery['filter']) => run({ source: 'orders', fields: [{ field: 'id' }], filter: f!, orderBy: [{ by: 'id' }] }).map((r) => r['id']);
  assert.deepEqual(ids({ op: 'between', left: { field: 'total' }, low: { value: 5 }, high: { value: 35 } }), [1, 2, 3]);
  assert.deepEqual(ids({ op: 'in', left: { field: 'status' }, values: ['open', 'void'] }), [3, 5]);
  assert.deepEqual(ids({ op: 'not-in', left: { field: 'status' }, values: ['open', 'void'] }), [1, 2, 4]);
  assert.deepEqual(ids({ op: 'is-null', left: { field: 'note' } }), [2, 4, 5]);
  assert.deepEqual(ids({ op: 'not-null', left: { field: 'note' } }), [1, 3]);
  assert.deepEqual(ids({ not: { op: '=', left: { field: 'status' }, right: { value: 'paid' } } }), [3, 5]);
  assert.deepEqual(ids({ or: [{ op: '=', left: { field: 'id' }, right: { value: 1 } }, { op: '=', left: { field: 'id' }, right: { value: 5 } }] }), [1, 5]);
  assert.deepEqual(ids({ op: '=', left: { field: 'note' }, right: { value: null } }), [2, 4, 5]); // = null is written IS NULL
  assert.deepEqual(ids({ op: 'in', left: { field: 'status' }, values: [] }), []);
  assert.deepEqual(ids({ op: 'not-in', left: { field: 'status' }, values: [] }), [1, 2, 3, 4, 5]);
  assert.throws(() => compile({ source: 'orders', filter: { and: [] } }), /at least one/);
});

test('contains escapes % and _ so user text means itself, and is case-insensitive unless asked', () => {
  const ids = (text: string, op: 'contains' | 'starts-with' | 'ends-with' = 'contains', caseSensitive = false) =>
    run({ source: 'orders', fields: [{ field: 'id' }], filter: { op, left: { field: 'note' }, text, caseSensitive }, orderBy: [{ by: 'id' }] }).map((r) => r['id']);
  assert.deepEqual(ids('%'), [1]); // only the row that has a real percent sign
  assert.deepEqual(ids('_'), [3]);
  assert.deepEqual(ids('50% OFF'), [1]);
  assert.deepEqual(ids('50% OFF', 'contains', true), []);
  assert.deepEqual(ids('a_', 'starts-with'), [3]);
  assert.deepEqual(ids('off', 'ends-with'), [1]);
  const c = compile({ source: 'orders', filter: { op: 'contains', left: { field: 'note' }, text: '100%' } }, { dialect: 'postgres' });
  assert.match(c.sql, /ILIKE \$1 ESCAPE/);
  assert.deepEqual(c.params, ['%100\\%%']);
});

test('named parameters are filled from values, and a missing one is refused', () => {
  const q: StructuredQuery = { source: 'orders', fields: [{ field: 'id' }], filter: { and: [{ op: '=', left: { field: 'status' }, right: { param: 'st' } }, { op: 'in', left: { field: 'customer_id' }, values: [{ param: 'a' }, { param: 'b' }] }] } };
  const c = compile(q, { dialect: 'postgres', schema, values: { st: 'paid', a: 1, b: 2 } });
  assert.deepEqual(c.params, ['paid', 1, 2]);
  assert.throws(() => compile(q, { schema, values: { st: 'paid', a: 1 } }), /parameter "b" has no value/);
  assert.throws(() => compile(q, { schema }), /parameter "st" has no value/);
});

test('having filters on an output column and writes the aggregate again, in text order for question-mark dialects', () => {
  const q: StructuredQuery = {
    source: 'orders',
    breakouts: [{ field: 'customer_id' }],
    aggregations: [{ op: 'sum', field: 'total', as: 'spent' }],
    having: { op: '>', left: { field: 'spent' }, right: { value: 40 } },
    orderBy: [{ by: 'spent', dir: 'desc' }],
  };
  const c = compile(q, { dialect: 'sqlite', schema });
  assert.equal(c.sql, 'SELECT "orders"."customer_id" AS "customer_id", SUM("orders"."total") AS "spent" FROM "orders" GROUP BY "orders"."customer_id" HAVING SUM("orders"."total") > ? ORDER BY "spent" DESC');
  assert.deepEqual(run(q).map((r) => ({ ...r })), [{ customer_id: 2, spent: 100 }, { customer_id: 1, spent: 45 }].filter((r) => r.spent > 40));
  assert.throws(() => compile({ source: 'orders', having: { op: 'is-null', left: { field: 'id' } } }), /"having" needs/);
});

test('parameters stay in text order when a conditional aggregate, a filter and a limit all hold values', () => {
  const q: StructuredQuery = {
    source: 'orders',
    aggregations: [{ op: 'count', where: { op: '=', left: { field: 'status' }, right: { value: 'paid' } }, as: 'p' }],
    filter: { op: '>', left: { field: 'total' }, right: { value: 1 } },
    breakouts: [{ field: 'customer_id' }],
    orderBy: [{ by: 'customer_id' }],
  };
  const c = compile(q, { dialect: 'sqlite' });
  assert.deepEqual(c.params, ['paid', 1]);
  assert.deepEqual(run(q).map((r) => [r['customer_id'], r['p']]), [[1, 2], [2, 1]]);
});

test('limit and offset per dialect, a bare offset gets the dialect\'s "no limit", and bad numbers are refused', () => {
  assert.match(compile({ source: 'orders', limit: 10, offset: 20 }, { dialect: 'postgres' }).sql, / LIMIT 10 OFFSET 20$/);
  assert.match(compile({ source: 'orders', offset: 5 }, { dialect: 'sqlite' }).sql, / LIMIT -1 OFFSET 5$/);
  assert.match(compile({ source: 'orders', offset: 5 }, { dialect: 'mysql' }).sql, / LIMIT 18446744073709551615 OFFSET 5$/);
  assert.throws(() => compile({ source: 'orders', limit: -1 }), /whole number/);
  assert.throws(() => compile({ source: 'orders', limit: 1.5 }), /whole number/);
  assert.throws(() => compile({ source: 'orders', limit: 10 }, { maxLimit: 5 }), /above the maximum/);
  assert.throws(() => compile({ source: 'orders' }, { maxLimit: 5 }), /limit is required/);
  assert.equal(run({ source: 'orders', fields: [{ field: 'id' }], orderBy: [{ by: 'id' }], limit: 2, offset: 1 }).map((r) => r['id']).join(), '2,3');
});

test('hostile values: NaN, objects and invalid dates are refused; quotes in an alias name cannot be injected', () => {
  assert.throws(() => compile({ source: 'orders', filter: { op: '=', left: { field: 'total' }, right: { value: NaN } } }), /finite/);
  assert.throws(() => compile({ source: 'orders', filter: { op: '=', left: { field: 'total' }, right: { value: { x: 1 } as never } } }), /must be a string/);
  assert.throws(() => compile({ source: 'orders', filter: { op: '=', left: { field: 'total' }, right: { value: new Date('nope') } } }), /invalid date/);
  assert.throws(() => compile({ source: 'orders', fields: [{ field: 'id', as: 'x" FROM y --' }] }), /not a plain name/);
  assert.throws(() => compile({ source: 'orders', orderBy: [{ by: 'id', dir: 'sideways' as never }] }), /asc or desc/);
  assert.throws(() => compile({ source: 'orders', breakouts: [{ field: 'status' }], orderBy: [{ by: 'total' }] }), /not a column of the result/);
  assert.throws(() => compile({ source: 'orders' }, { dialect: 'oracle' as never }), /unknown dialect/);
});

test('the dialect map quotes by doubling the quote character and differs on placeholders and concat', () => {
  assert.equal(DIALECTS.postgres.quote('a"b'), '"a""b"');
  assert.equal(DIALECTS.mysql.quote('a`b'), '`a``b`');
  assert.equal(DIALECTS.postgres.placeholder(3), '$3');
  assert.equal(DIALECTS.mysql.placeholder(3), '?');
  assert.equal(DIALECTS.bigquery.placeholder(3), '@p3');
  assert.equal(DIALECTS.postgres.concat(['a', 'b']), '(a || b)');
  assert.equal(DIALECTS.mysql.concat(['a', 'b']), 'CONCAT(a, b)');
});

test('selected columns need names, aggregations other than count need a field, and duplicates are refused', () => {
  assert.throws(() => compile({ source: 'orders', fields: [{ expr: { value: 1 } }] }), /needs an "as" name/);
  assert.throws(() => compile({ source: 'orders', fields: [{}] }), /needs a field or an expression/);
  assert.throws(() => compile({ source: 'orders', aggregations: [{ op: 'sum' }] }), /needs a field/);
  assert.throws(() => compile({ source: 'orders', breakouts: [{ field: 'status' }, { field: 'orders.status' }] }), /appears twice/);
});
