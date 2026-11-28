import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Console, QueryError, parse, type Collection, type QueryLog } from './index.ts';

const cols: Collection[] = [{ name: 'files', fields: { name: { type: 'string' }, size: { type: 'number' }, owner: { type: 'string' }, shared: { type: 'boolean' }, email: { type: 'string', sensitive: true } } }];
const files = [
  { name: 'plan.pdf', size: 5000, owner: 'ana', shared: true, email: 'ana@example.org' },
  { name: 'cat.jpg', size: 200, owner: 'ana', shared: false, email: 'ana@example.org' },
  { name: 'notes.txt', size: 9000, owner: 'ben', shared: true, email: 'ben@example.org' },
];
const make = () => new Console(cols, () => files, () => new Date('2026-11-26T00:00:00Z'));

test('a query parses into a plan, runs, masks sensitive fields and is recorded', () => {
  assert.deepEqual(parse('from files where size > 1000 and owner = "ana" order by size desc limit 20 select name, size'), { from: 'files', where: [{ field: 'size', op: '>', value: 1000 }, { field: 'owner', op: '=', value: 'ana' }], order: { field: 'size', desc: true }, limit: 20, select: ['name', 'size'] });
  const c = make();
  assert.deepEqual(c.run('ana', 'from files where shared = true order by size desc select name, email').rows, [{ name: 'notes.txt', email: '•••' }, { name: 'plan.pdf', email: '•••' }]);
  assert.deepEqual(c.run('dpo', 'from files where name contains "CAT" select email', { seeSensitive: true }).rows, [{ email: 'ana@example.org' }]);
  const capped = c.run('ana', 'from files limit 2');
  assert.equal(capped.capped, true);
  assert.equal(capped.rows.length, 2);
  assert.equal(parse('from files limit 100000').limit, 500, 'results are capped');
  assert.deepEqual(c.log.map((l) => [l.who, l.rows]), [['ana', 2], ['dpo', 1], ['ana', 2]]);
});

test('writes do not exist, unknown names and wrong types are refused by name, and failures are recorded', () => {
  const c = make();
  assert.throws(() => c.run('x', 'delete from files'), /expected from/);
  assert.throws(() => c.run('x', 'from files where size > 1 delete'), /only reads/);
  assert.throws(() => c.run('x', 'from users'), /no collection users; there are files/);
  assert.throws(() => c.run('x', 'from files where colour = "red"'), /files has no field colour/);
  assert.throws(() => c.run('x', 'from files where size > "big"'), /size is a number/);
  assert.throws(() => c.run('x', 'from files where email = "ana@example.org"'), /cannot filter on email/, 'no guessing a hidden value by filtering');
  assert.throws(() => c.run('x', 'from files where owner = ana'), QueryError);
  assert.throws(() => c.run('x', 'from files where size > 1 or size < 2'), /two queries/);
  assert.throws(() => parse('from files where name = "x"; drop'), /cannot read/);
  assert.equal(c.log.filter((l) => l.error).length, 8);
});

test('a sensitive field cannot be sorted on either: the order would reveal what the mask hides', () => {
  const c = make();
  assert.throws(() => c.run('x', 'from files order by email select name'), /cannot sort on email/);
  assert.deepEqual(c.run('dpo', 'from files order by email select name', { seeSensitive: true }).rows.map((r) => r.name), ['plan.pdf', 'cat.jpg', 'notes.txt']);
});

test('names inherited from Object.prototype are not fields', () => {
  const c = make();
  assert.throws(() => c.run('x', 'from files select constructor'), /files has no field constructor/);
  assert.throws(() => c.run('x', 'from files where toString = "x"'), /files has no field toString/);
  assert.throws(() => c.run('x', 'from files order by __proto__'), /files has no field __proto__/);
});

test('a text value with a bad escape is a query error, not a crash', () => {
  assert.throws(() => parse('from files where name = "a\\q"'), QueryError);
});

test('the query log keeps the most recent queries in memory and hands every one to the sink', () => {
  const stored: QueryLog[] = [];
  const c = new Console(cols, () => files, () => new Date('2026-11-26T00:00:00Z'), { keep: 3, sink: (e) => void stored.push(e) });
  for (let i = 0; i < 10; i++) c.run(`user-${i}`, 'from files limit 1');
  assert.throws(() => c.run('x', 'from users'));
  assert.deepEqual(c.log.map((l) => l.who), ['user-8', 'user-9', 'x']);
  assert.equal(c.log.at(-1)!.error, 'no collection users; there are files');
  assert.deepEqual(stored.map((l) => l.who), [...Array.from({ length: 10 }, (_, i) => `user-${i}`), 'x']);
  assert.deepEqual([c.queries.recorded, c.queries.handed, c.queries.evicted], [11, 11, 8]);
  const unbounded = make();
  for (let i = 0; i < 1500; i++) unbounded.run('ana', 'from files limit 1');
  assert.equal(unbounded.log.length, 1000, 'by default the most recent 1000 stay in memory');
  assert.equal(unbounded.queries.evicted, 500);
});
