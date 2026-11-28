import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BoundedLog, Console, QueryError, checkPlan, parse, tokens, type Collection, type QueryLog } from './index.ts';

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

const msgOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof QueryError, 'a refusal is a QueryError');
    return e.message;
  }
  throw new assert.AssertionError({ message: 'expected the call to be refused' });
};

test('tokens: decimals, trailing blanks and the place an unreadable query stops are all exact', () => {
  assert.deepEqual(tokens('from files where size > 1.25'), ['from', 'files', 'where', 'size', '>', '1.25']);
  assert.deepEqual(tokens('a <= -2.50 , "x y"'), ['a', '<=', '-2.50', ',', '"x y"']);
  assert.deepEqual(tokens('from files  \n '), ['from', 'files'], 'blanks after the last word are not a token');
  assert.deepEqual(tokens('from files   '), ['from', 'files']);
  assert.deepEqual(tokens(''), []);
  assert.deepEqual(tokens('   '), []);
  assert.equal(msgOf(() => tokens('from files; drop')), 'cannot read the query at "; drop"');
  assert.equal(msgOf(() => tokens('from files #abcdefghijklmnopqrstuvwxyz')), 'cannot read the query at " #abcdefghij"', 'the excerpt is 12 characters from where reading stopped');
  assert.equal(parse('from files where size > 1.25').where[0]!.value, 1.25);
});

test('parse: the end of the query and each keyword are checked with a plain message', () => {
  assert.equal(msgOf(() => parse('from')), 'the query ends too soon');
  assert.equal(msgOf(() => parse('')), 'the query ends too soon; expected from');
  assert.equal(msgOf(() => parse('from files order')), 'the query ends too soon; expected by');
  assert.equal(msgOf(() => parse('from files order size')), 'expected by, found size');
  assert.equal(msgOf(() => parse('from files where size')), 'the query ends too soon');
  assert.equal(msgOf(() => parse('select name')), 'expected from, found select');
  assert.equal(msgOf(() => parse('from files banana')), 'did not expect banana');
  assert.equal(msgOf(() => parse('from files where size > 1 limit')), 'the query ends too soon');
});

test('parse: values are text, numbers, true or false and nothing else', () => {
  const v = (q: string) => parse(q).where[0]!.value;
  assert.equal(v('from files where owner = "ana"'), 'ana');
  assert.equal(v('from files where owner = "a\\nb"'), 'a\nb');
  assert.equal(v('from files where size = 12'), 12);
  assert.equal(v('from files where size = -3'), -3);
  assert.equal(v('from files where shared = true'), true);
  assert.equal(v('from files where shared = false'), false);
  assert.equal(msgOf(() => parse('from files where owner = ana')), 'ana is not a value; quote text like "this"');
  assert.equal(msgOf(() => parse('from files where shared = yes')), 'yes is not a value; quote text like "this"');
  assert.equal(msgOf(() => parse('from files where shared = maybe')), 'maybe is not a value; quote text like "this"');
  assert.equal(msgOf(() => parse('from files where size = a1')), 'a1 is not a value; quote text like "this"', 'a name that merely contains a digit is not a number');
  assert.equal(msgOf(() => parse('from files where size = x9')), 'x9 is not a value; quote text like "this"');
  assert.equal(msgOf(() => parse('from files where owner = "a\\q"')), '"a\\q" is not readable text; the escapes are \\" \\\\ \\n \\t and \\u0000');
});

test('parse: every comparison is accepted, in any letter case, and anything else is named', () => {
  for (const op of ['=', '!=', '<', '<=', '>', '>=']) assert.equal(parse(`from files where size ${op} 5`).where[0]!.op, op);
  assert.equal(parse('from files where name CONTAINS "x"').where[0]!.op, 'contains');
  assert.equal(parse('FROM files WHERE size > 1 AND owner = "a" ORDER BY size DESC LIMIT 3 SELECT name').where.length, 2);
  assert.equal(msgOf(() => parse('from files where size , 5')), ', is not a comparison');
  assert.equal(msgOf(() => parse('from files where size like 5')), 'like is not a comparison');
});

test('parse: order by takes asc, desc or nothing, and a limit is a whole number above 0', () => {
  assert.deepEqual(parse('from files order by size').order, { field: 'size', desc: false });
  assert.deepEqual(parse('from files order by size asc').order, { field: 'size', desc: false });
  assert.deepEqual(parse('from files order by size desc').order, { field: 'size', desc: true });
  assert.deepEqual(parse('from files order by size asc limit 2'), { from: 'files', where: [], order: { field: 'size', desc: false }, limit: 2 });
  assert.equal(parse('from files').limit, 50, 'fifty rows unless asked');
  assert.equal(parse('from files limit 1').limit, 1);
  assert.equal(parse('from files limit 600', 1000).limit, 600);
  assert.equal(parse('from files limit 600').limit, 500);
  for (const bad of ['0', '-1', '1.5', 'abc', 'files']) assert.equal(msgOf(() => parse(`from files limit ${bad}`)), 'limit is a whole number above 0', bad);
  assert.deepEqual(parse('from files select a, b ,c').select, ['a', 'b', 'c']);
  assert.deepEqual(parse('from files select a').select, ['a']);
});

test('parse: words that would write are refused as reads-only, "or" gets its own advice', () => {
  for (const w of ['insert', 'update', 'delete', 'drop', 'set', 'INSERT']) assert.equal(msgOf(() => parse(`from files ${w}`)), 'this console only reads', w);
  assert.equal(msgOf(() => parse('from files or')), 'use two queries instead of or');
});

test('checkPlan: names the collections, and refuses a value that does not fit the field', () => {
  const two: Collection[] = [...cols, { name: 'people', fields: { age: { type: 'number' } } }];
  assert.equal(msgOf(() => checkPlan(parse('from nope'), two)), 'no collection nope; there are files, people');
  assert.equal(checkPlan(parse('from people where age > 3'), two).name, 'people');
  const ok = (q: string) => checkPlan(parse(q), cols).name;
  assert.equal(ok('from files where size > 5 and size <= 6'), 'files');
  assert.equal(ok('from files where shared = true'), 'files');
  assert.equal(ok('from files where shared != false'), 'files');
  assert.equal(ok('from files where name = "x" and name contains "y"'), 'files');
  assert.equal(msgOf(() => checkPlan(parse('from files where size > "a"'), cols)), 'size is a number; "a" does not fit >');
  assert.equal(msgOf(() => checkPlan(parse('from files where shared = "yes"'), cols)), 'shared is a boolean; "yes" does not fit =');
  assert.equal(msgOf(() => checkPlan(parse('from files where shared = 1'), cols)), 'shared is a boolean; 1 does not fit =');
  assert.equal(msgOf(() => checkPlan(parse('from files where owner = 5'), cols)), 'owner is a string; 5 does not fit =');
  assert.equal(msgOf(() => checkPlan(parse('from files where owner = true'), cols)), 'owner is a string; true does not fit =');
  assert.equal(msgOf(() => checkPlan(parse('from files where size contains 5'), cols)), 'size is a number; 5 does not fit contains');
  assert.equal(msgOf(() => checkPlan(parse('from files where size contains "5"'), cols)), 'size is a number; "5" does not fit contains');
  assert.equal(msgOf(() => checkPlan(parse('from files where shared contains true'), cols)), 'shared is a boolean; true does not fit contains');
});

test('every comparison keeps exactly the rows it should, including the row that is equal', () => {
  const c = make();
  const names = (q: string) => c.run('t', q).rows.map((r) => r.name).sort();
  assert.deepEqual(names('from files where size = 5000'), ['plan.pdf']);
  assert.deepEqual(names('from files where size != 5000'), ['cat.jpg', 'notes.txt']);
  assert.deepEqual(names('from files where size < 5000'), ['cat.jpg']);
  assert.deepEqual(names('from files where size <= 5000'), ['cat.jpg', 'plan.pdf']);
  assert.deepEqual(names('from files where size > 5000'), ['notes.txt']);
  assert.deepEqual(names('from files where size >= 5000'), ['notes.txt', 'plan.pdf']);
  assert.deepEqual(names('from files where owner != "ana"'), ['notes.txt']);
  assert.deepEqual(names('from files where shared != true'), ['cat.jpg']);
  assert.deepEqual(names('from files where shared = false'), ['cat.jpg']);
  assert.deepEqual(names('from files where size > 100 and size < 9000 and owner = "ana"'), ['cat.jpg', 'plan.pdf']);
  assert.deepEqual(names('from files where name contains ".P"'), ['plan.pdf']);
  assert.deepEqual(names('from files where name contains "z"'), []);
});

test('contains does not match a value that is not text, and does not crash on one', () => {
  const rows = [{ name: null }, { name: 5 }, { name: undefined }, { name: 'a5' }];
  const c = new Console([{ name: 't', fields: { name: { type: 'string' } } }], () => rows, () => new Date('2026-11-26T00:00:00Z'));
  assert.deepEqual(c.run('x', 'from t where name contains "5"').rows, [{ name: 'a5' }]);
  assert.deepEqual(c.run('x', 'from t where name contains "null"').rows, []);
  assert.deepEqual(c.run('x', 'from t where name contains "undefined"').rows, []);
});

test('ordering: ascending, descending, ties keep their first order, and the source rows are not reordered', () => {
  const rows = [
    { id: 'a', n: 3 },
    { id: 'b', n: 1 },
    { id: 'c', n: 2 },
    { id: 'd', n: 3 },
    { id: 'e', n: 1 },
    { id: 'f', n: 2 },
  ];
  const before = rows.map((r) => r.id).join('');
  const c = new Console([{ name: 't', fields: { id: { type: 'string' }, n: { type: 'number' } } }], () => rows, () => new Date('2026-11-26T00:00:00Z'));
  const ids = (q: string) => c.run('x', q).rows.map((r) => r.id).join('');
  assert.equal(ids('from t order by n'), 'becfad');
  assert.equal(ids('from t order by n asc'), 'becfad');
  assert.equal(ids('from t order by n desc'), 'adcfbe');
  assert.equal(ids('from t'), 'abcdef');
  assert.equal(rows.map((r) => r.id).join(''), before, 'the data is left as it was');
});

test('capped says whether rows were left out, and masked says which fields were hidden', () => {
  const c = make();
  assert.equal(c.run('x', 'from files limit 3').capped, false, 'a limit equal to the rows is not a cap');
  assert.equal(c.run('x', 'from files limit 2').capped, true);
  assert.equal(c.run('x', 'from files').capped, false);
  assert.equal(c.run('x', 'from files limit 4').capped, false);
  assert.deepEqual(c.run('x', 'from files').masked, ['email']);
  assert.deepEqual(c.run('x', 'from files select name').masked, []);
  assert.deepEqual(c.run('x', 'from files', { seeSensitive: true }).masked, []);
  assert.equal(c.run('x', 'from files limit 1', { seeSensitive: true }).rows[0]!.email, 'ana@example.org');
  assert.equal(c.run('x', 'from files limit 1').rows[0]!.email, '•••');
});

test('the console stamps each query with the clock, and with the real time when none is given', () => {
  const before = Date.now();
  const c = new Console(cols, () => files);
  c.run('x', 'from files');
  const at = Date.parse(c.log[0]!.at);
  assert.ok(at >= before - 1 && at <= Date.now() + 1, 'the stamp is the current time');
  assert.equal(make().run('x', 'from files').rows.length, 3);
  const m = make();
  m.run('x', 'from files');
  assert.equal(m.log[0]!.at, '2026-11-26T00:00:00.000Z');
});

test('a log keeps a whole number of entries of at least 1', () => {
  for (const keep of [0, -1, 1.5, Number.NaN, Infinity]) assert.throws(() => new BoundedLog({ keep }), /a log keeps a whole number of entries, at least 1/, String(keep));
  const one = new BoundedLog<number>({ keep: 1 });
  one.push(1);
  one.push(2);
  assert.deepEqual(one.entries, [2]);
  assert.equal(one.evicted, 1);
});

test('a log with no sink hands nothing on and counts no failure', () => {
  const log = new BoundedLog<number>();
  log.push(1);
  log.push(2);
  assert.deepEqual([log.recorded, log.handed, log.sinkFailures, log.evicted], [2, 0, 0, 0]);
});

test('a sink that throws, rejects or answers oddly is counted only when it really failed, and never breaks the log', async () => {
  const settle = () => new Promise((r) => setImmediate(r));
  const answers: unknown[] = [undefined, 7, true, {}, { then: 5 }, null, ''];
  let n = 0;
  const odd = new BoundedLog<number>({ sink: () => answers[n++] as void });
  for (let i = 0; i < answers.length; i++) odd.push(i);
  await settle();
  assert.equal(odd.sinkFailures, 0, 'an answer that is not a promise is not a failure');
  assert.equal(odd.handed, answers.length);

  const thrower = new BoundedLog<number>({ sink: () => { throw new Error('disk'); } });
  thrower.push(1);
  thrower.push(2);
  assert.equal(thrower.sinkFailures, 2);
  assert.deepEqual(thrower.entries, [1, 2]);

  const rejecter = new BoundedLog<number>({ sink: () => Promise.reject(new Error('net')) });
  rejecter.push(1);
  assert.equal(rejecter.sinkFailures, 0, 'a rejection is counted when it happens, not before');
  await settle();
  rejecter.push(2);
  await settle();
  assert.equal(rejecter.sinkFailures, 2);
  assert.deepEqual(rejecter.entries, [1, 2]);

  const ok = new BoundedLog<number>({ sink: () => Promise.resolve('fine') });
  ok.push(1);
  await settle();
  assert.deepEqual([ok.sinkFailures, ok.handed, ok.recorded], [0, 1, 1]);
});

test('a console records a refused query with its error and zero rows, and a sink failure never changes the answer', async () => {
  const c = new Console(cols, () => files, () => new Date('2026-11-26T00:00:00Z'), { sink: () => { throw new Error('disk'); } });
  assert.equal(c.run('x', 'from files').rows.length, 3);
  assert.throws(() => c.run('x', 'from nope'), /no collection nope/);
  assert.deepEqual(c.log.map((l) => [l.rows, l.error]), [[3, undefined], [0, 'no collection nope; there are files']]);
  assert.equal(c.queries.sinkFailures, 2);
});
