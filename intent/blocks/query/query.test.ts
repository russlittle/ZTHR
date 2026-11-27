import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Console, QueryError, parse, type Collection } from './index.ts';

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
