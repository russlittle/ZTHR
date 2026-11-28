/** Fuzz: query console (blocks/query parse, checkPlan, Console). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Console, QueryError, checkPlan, parse, type Collection, type Plan } from '../../blocks/query/index.ts';
import { forAll, type Rand } from './harness.ts';

const cols: Collection[] = [
  { name: 'files', fields: { name: { type: 'string' }, size: { type: 'number' }, owner: { type: 'string' }, shared: { type: 'boolean' }, email: { type: 'string', sensitive: true }, salary: { type: 'number', sensitive: true } } },
  { name: 'users', fields: { id: { type: 'string' }, age: { type: 'number' } } },
];

const OPS = new Set(['=', '!=', '<', '<=', '>', '>=', 'contains']);

const WORDS = ['from', 'FROM', 'files', 'users', 'where', 'and', 'or', 'order', 'by', 'asc', 'desc', 'limit', 'select', ',', '=', '!=', '<', '<=', '>', '>=', 'contains', 'CONTAINS', 'name', 'size', 'owner', 'shared', 'email', 'salary', 'id', 'age', 'true', 'false', '"ana"', '"a\\"b"', '"\\u0041"', '"\\q"', '""', '0', '1', '-1', '20', '1.5', '100000', '99999999999999999999', '1'.repeat(400), 'insert', 'update', 'delete', 'drop', 'set', 'truncate', 'grant', 'into', 'values', 'constructor', '__proto__', 'toString', 'hasOwnProperty', ';', '--', '/*', '*/', '(', ')', '*', 'files.name', '_x', "'x'", '`', '\\', '\n', '\t', 'é'];

const soup = (r: Rand): string => {
  const head = r.bool(0.7) ? `from ${r.pick(['files', 'files', 'users', 'nope', '__proto__'])} ` : '';
  return head + r.array(0, 14, () => (r.bool(0.92) ? r.pick(WORDS) : r.text(1, 3))).join(r.pick([' ', ' ', '  ', '\n', '']));
};

/** Mostly well-formed queries from the grammar, with a soup word dropped in now and then. */
const grammar = (r: Rand): string => {
  const f = () => r.pick(['name', 'size', 'owner', 'shared', 'email', 'salary', 'id', 'age', 'constructor']);
  const v = () => r.pick(['"ana"', '"a\\"b"', '1', '-5', '1.5', 'true', 'false', '"\\u00e9"', '99999999999999999999']);
  const parts: string[] = [`from ${r.pick(['files', 'files', 'files', 'users'])}`];
  for (let k = r.int(0, 3); k > 0; k--) parts.push(`${parts.length === 1 || r.bool(0.3) ? 'where' : 'and'} ${f()} ${r.pick([...OPS])} ${v()}`);
  if (r.bool(0.4)) parts.push(`order by ${f()}${r.pick(['', ' asc', ' desc'])}`);
  if (r.bool(0.5)) parts.push(`limit ${r.pick(['1', '2', '20', '499', '500', '501', '100000', '0', '-1', '1.5', '1e3'])}`);
  if (r.bool(0.5)) parts.push(`select ${r.array(1, 3, f).join(', ')}`);
  if (r.bool(0.2)) parts.splice(r.int(0, parts.length), 0, r.pick(WORDS));
  return parts.join(' ');
};

const query = (r: Rand) => (r.bool() ? grammar(r) : soup(r));

const PLAN_KEYS = new Set(['from', 'where', 'order', 'limit', 'select']);
const WRITE = /^(insert|update|delete|drop|set|truncate|grant|alter|create|merge|replace)$/i;

/** A plan holds only reads: known keys, comparison ops, scalar values, and a positive whole limit within the cap. */
const assertReadOnly = (p: Plan, cap: number) => {
  for (const k of Object.keys(p)) assert.ok(PLAN_KEYS.has(k), `unexpected plan key ${k}`);
  assert.equal(typeof p.from, 'string');
  assert.ok(Array.isArray(p.where));
  for (const w of p.where) {
    assert.ok(OPS.has(w.op), `op ${w.op}`);
    assert.ok(['string', 'number', 'boolean'].includes(typeof w.value));
    assert.deepEqual(Object.keys(w).sort(), ['field', 'op', 'value']);
  }
  assert.ok(Number.isInteger(p.limit) && p.limit >= 1 && p.limit <= cap, `limit ${p.limit} with cap ${cap}`);
  if (p.order) assert.deepEqual(Object.keys(p.order).sort(), ['desc', 'field']);
};

test('random token soups never produce a plan that writes, and every limit is within the cap (3000 cases)', async () => {
  await forAll('query soup is read-only', {
    cases: 3000,
    gen: (r) => ({ q: query(r), cap: r.pick([500, 500, 1, 10, 50]) }),
    shrink: () => [],
    check: ({ q, cap }) => {
      let p: Plan;
      try {
        p = parse(q, cap);
      } catch (e) {
        assert.ok(e instanceof QueryError, `parse threw ${e instanceof Error ? e.constructor.name : typeof e}: ${String(e)}`);
        return;
      }
      assertReadOnly(p, cap);
      // A write keyword can only survive as a name (a field, a collection), never as a clause.
      const clauses = q.split(/\s+/).filter((w) => WRITE.test(w));
      if (clauses.length) for (const w of clauses) assert.ok(p.from === w || p.where.some((c) => c.field === w || c.value === w) || p.order?.field === w || p.select?.includes(w), `${w} was accepted as something other than a name`);
    },
  });
});

test('any parsed plan passes or fails checkPlan with QueryError, never another error (3000 cases)', async () => {
  await forAll('query checkPlan errors', {
    cases: 3000,
    gen: query,
    check: (q) => {
      let p: Plan;
      try {
        p = parse(q);
      } catch {
        return;
      }
      try {
        const c = checkPlan(p, cols);
        assert.ok(cols.includes(c));
      } catch (e) {
        assert.ok(e instanceof QueryError, `checkPlan threw ${e instanceof Error ? e.constructor.name : typeof e}: ${String(e)}`);
      }
    },
  });
});

const deepFreeze = <T>(x: T): T => {
  if (x && typeof x === 'object') {
    for (const v of Object.values(x)) deepFreeze(v);
    Object.freeze(x);
  }
  return x;
};

test('Console.run on random queries: never mutates data, stays within the cap, masks sensitive fields, fails only with QueryError (2000 cases)', async () => {
  await forAll('query console', {
    cases: 2000,
    gen: (r) => ({
      q: query(r),
      see: r.bool(0.3),
      rows: r.array(0, 700, () => ({ name: r.pick(['a.txt', 'b.pdf', 'Ana']), size: r.int(0, 10000), owner: r.pick(['ana', 'ben']), shared: r.bool(), email: 'secret@example.org', salary: 123456 })),
    }),
    shrink: () => [],
    check: ({ q, see, rows }) => {
      const data = deepFreeze(rows);
      const snapshot = JSON.stringify(data);
      const c = new Console(cols, (n) => (n === 'files' ? data : []), () => new Date('2026-11-27T00:00:00Z'));
      let out;
      try {
        out = c.run('fuzz', q, { seeSensitive: see });
      } catch (e) {
        assert.ok(e instanceof QueryError, `run threw ${e instanceof Error ? e.constructor.name : typeof e}: ${String(e)}`);
        return;
      } finally {
        assert.equal(JSON.stringify(data), snapshot, 'data changed');
        assert.equal(c.log.length, 1, 'every query is recorded once');
      }
      assert.ok(out.rows.length <= 500);
      assert.ok(out.rows.length <= parse(q).limit);
      if (!see) for (const row of out.rows) for (const f of ['email', 'salary']) if (Object.hasOwn(row, f)) assert.equal(row[f], '•••', `${f} leaked`);
    },
  });
});
