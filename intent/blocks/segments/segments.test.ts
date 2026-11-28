import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SegmentError, Segments, checkRules, fromQuery, matches, preview, describe, csvCell } from './index.ts';
import type { Rule, Context } from './index.ts';
import type { Collection } from '../query/index.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 28, 12);
const users: Collection = {
  name: 'users',
  fields: { id: { type: 'string' }, email: { type: 'string', sensitive: true }, name: { type: 'string' }, plan: { type: 'string' }, seats: { type: 'number' }, active: { type: 'boolean' }, lastSeen: { type: 'date' }, country: { type: 'string' } },
};
const R = [
  { id: 'u1', email: 'ann@example.com', name: 'Ann', plan: 'pro', seats: 10, active: true, lastSeen: NOW - 1 * DAY, country: 'US' },
  { id: 'u2', email: 'bob@example.com', name: 'Bob "B" Jones', plan: 'free', seats: 1, active: true, lastSeen: NOW - 40 * DAY, country: 'DE' },
  { id: 'u3', email: 'cy@example.com', name: '=SUM(A1:A9)', plan: 'pro', seats: 3, active: false, lastSeen: NOW - 10 * DAY, country: 'US' },
  { id: 'u4', email: 'di@example.com', name: 'Di, the Great', plan: 'team', seats: 25, active: true, lastSeen: NOW - 100 * DAY, country: 'FR' },
  { id: 'u5', email: 'ed@example.com', name: 'Ed', plan: 'free', seats: 1, active: false, country: 'US' },
  { id: 'u6', email: 'fy@example.com', name: '@cmd', plan: 'pro', seats: 7, active: true, lastSeen: NOW + 5 * DAY, country: 'GB' },
];
const ctx = (members?: Context['members']): Context => ({ now: NOW, idOf: (r) => String(r.id), ...(members ? { members } : {}) });
const ids = (rule: Rule) => R.filter((r) => matches(rule, r, ctx())).map((r) => r.id);
const mk = () => new Segments(users, 'id');
const seg = (id: string, rules: Rule, extra: object = {}) => ({ id, name: id, rules, maxAgeMs: 3_600_000, ...extra });

test('each comparison selects what it says', () => {
  assert.deepEqual(ids({ field: 'plan', cmp: '=', value: 'pro' }), ['u1', 'u3', 'u6']);
  assert.deepEqual(ids({ field: 'plan', cmp: '!=', value: 'pro' }), ['u2', 'u4', 'u5']);
  assert.deepEqual(ids({ field: 'seats', cmp: '>=', value: 7 }), ['u1', 'u4', 'u6']);
  assert.deepEqual(ids({ field: 'seats', cmp: '<', value: 3 }), ['u2', 'u5']);
  assert.deepEqual(ids({ field: 'seats', cmp: 'between', value: [3, 10] }), ['u1', 'u3', 'u6']);
  assert.deepEqual(ids({ field: 'country', cmp: 'in', value: ['DE', 'FR'] }), ['u2', 'u4']);
  assert.deepEqual(ids({ field: 'name', cmp: 'contains', value: 'JONES' }), ['u2']);
  assert.deepEqual(ids({ field: 'active', cmp: '=', value: false }), ['u3', 'u5']);
  assert.deepEqual(ids({ field: 'lastSeen', cmp: 'is-not-set' }), ['u5']);
  assert.deepEqual(ids({ field: 'lastSeen', cmp: 'is-set' }), ['u1', 'u2', 'u3', 'u4', 'u6']);
});

test('dates are relative to the injected clock and a record from the future matches neither side', () => {
  assert.deepEqual(ids({ field: 'lastSeen', cmp: 'within-days', value: 30 }), ['u1', 'u3']);
  assert.deepEqual(ids({ field: 'lastSeen', cmp: 'older-than-days', value: 30 }), ['u2', 'u4']);
  assert.ok(!ids({ field: 'lastSeen', cmp: 'within-days', value: 30 }).includes('u6'));
  assert.ok(!ids({ field: 'lastSeen', cmp: 'older-than-days', value: 30 }).includes('u6'));
  assert.deepEqual(ids({ field: 'lastSeen', cmp: 'within-days', value: 0 }), []);
});

test('all, any and not combine, and describe reads back as plain text', () => {
  const rule: Rule = { op: 'all', rules: [{ field: 'plan', cmp: '=', value: 'pro' }, { op: 'any', rules: [{ field: 'country', cmp: '=', value: 'US' }, { field: 'seats', cmp: '>', value: 5 }] }, { op: 'not', rule: { field: 'active', cmp: '=', value: false } }] };
  assert.deepEqual(ids(rule), ['u1', 'u6']);
  assert.equal(describe(rule), 'plan = "pro" and (country = "US" or seats > 5) and (not (active = false))');
});

test('rules are checked before they are stored, with a path to each problem', () => {
  const p = checkRules({ op: 'all', rules: [
    { field: 'nope', cmp: '=', value: 1 },
    { field: 'seats', cmp: '=', value: 'ten' },
    { field: 'plan', cmp: 'between', value: ['b', 'a'] },
    { field: 'seats', cmp: 'contains', value: 'x' },
    { field: 'plan', cmp: 'within-days', value: 3 },
    { field: 'lastSeen', cmp: 'within-days', value: -1 },
    { field: 'country', cmp: 'in', value: [] },
    { field: 'active', cmp: '>', value: true },
    { field: 'seats', cmp: '>' },
    { field: 'email', cmp: '=', value: 'a@b.co' },
    { field: 'seats', cmp: 'like' as never, value: 1 },
    { op: 'all', rules: [] },
    { segment: 'ghost' },
  ] }, users, { known: () => false });
  assert.equal(p.length, 13);
  assert.match(p[0]!, /^rules\.all\[0\]: users has no field nope/);
  assert.ok(p.some((x) => /email is sensitive/.test(x)));
  assert.ok(p.some((x) => /there is no segment ghost/.test(x)));
  assert.ok(p.some((x) => /all of nothing/.test(x)));
  assert.deepEqual(checkRules({ field: 'email', cmp: '=', value: 'a@b.co' }, users, { allowSensitive: true }), []);
});

test('depth and size limits hold', () => {
  let deep: Rule = { field: 'seats', cmp: '>', value: 0 };
  for (let i = 0; i < 9; i++) deep = { op: 'not', rule: deep };
  assert.ok(checkRules(deep, users).some((x) => /deeper than 8/.test(x)));
  const wide: Rule = { op: 'any', rules: Array.from({ length: 101 }, () => ({ field: 'seats', cmp: '>', value: 0 })) };
  assert.ok(checkRules(wide, users).includes('more than 100 conditions'));
});

test('preview gives counts, share, a sample and what each condition does alone, and stores nothing', () => {
  const s = mk();
  const p = s.preview({ op: 'all', rules: [{ field: 'plan', cmp: '=', value: 'pro' }, { field: 'active', cmp: '=', value: true }] }, R, NOW, { sample: 1 });
  assert.equal(p.matches, 2);
  assert.equal(p.total, 6);
  assert.equal(p.share, 2 / 6);
  assert.deepEqual(p.sample, ['u1']);
  assert.deepEqual(p.perCondition, [{ condition: 'plan = "pro"', matches: 3 }, { condition: 'active = true', matches: 4 }]);
  assert.equal(s.snapshot('x'), undefined);
  assert.equal(preview({ field: 'plan', cmp: '=', value: 'none' }, [], ctx()).share, 0);
  assert.throws(() => s.preview({ field: 'email', cmp: 'contains', value: 'a' }, R, NOW), /sensitive/);
  assert.throws(() => s.preview({ field: 'plan', cmp: '=', value: 'x' }, R, NOW, { sample: 500 }), /0 to 100/);
});

test('fromQuery turns a console where-clause into rules and refuses what the console would', () => {
  const { rules } = fromQuery('from users where plan = "pro" and seats >= 5', [users]);
  assert.deepEqual(rules, { op: 'all', rules: [{ field: 'plan', cmp: '=', value: 'pro' }, { field: 'seats', cmp: '>=', value: 5 }] });
  assert.deepEqual(ids(rules), ['u1', 'u6']);
  assert.deepEqual(fromQuery('country = "US"', [users]).rules, { op: 'all', rules: [{ field: 'country', cmp: '=', value: 'US' }] });
  assert.throws(() => fromQuery('from users where bogus = 1', [users]), /no field bogus/);
  assert.throws(() => fromQuery('from users where seats = "ten"', [users]), /does not fit/);
  assert.throws(() => fromQuery('from users', [users]), SegmentError);
});

test('defining a segment validates id, age limit, rules and loops', () => {
  const s = mk();
  const ok: Rule = { field: 'plan', cmp: '=', value: 'pro' };
  assert.throws(() => s.define(seg('Bad Id', ok)), /segment id/);
  assert.throws(() => s.define(seg('x', ok, { name: ' ' })), /needs a name/);
  assert.throws(() => s.define(seg('x', ok, { maxAgeMs: 1000 })), /every minute/);
  assert.throws(() => s.define(seg('x', { field: 'zzz', cmp: 'is-set' })), /no field zzz/);
  assert.throws(() => s.define(seg('a', { segment: 'b' })), /no segment b/);
  s.define(seg('a', ok));
  s.define(seg('b', { op: 'all', rules: [{ segment: 'a' }, { field: 'active', cmp: '=', value: true }] }));
  assert.throws(() => s.define(seg('a', { segment: 'b' })), /loop: a -> b -> a/);
  assert.throws(() => s.define(seg('c', { segment: 'c' })), /no segment c/);
  assert.equal(s.get('a')?.rules, ok);
});

test('refresh keeps a snapshot, reports who came and went, and rejects duplicate ids', () => {
  const s = mk();
  s.define(seg('pro', { field: 'plan', cmp: '=', value: 'pro' }));
  const a = s.refresh('pro', R, NOW);
  assert.deepEqual(a, { takenAt: NOW, ids: ['u1', 'u3', 'u6'], total: 6, added: 3, removed: 0 });
  const changed = R.map((r) => (r.id === 'u3' ? { ...r, plan: 'free' } : r.id === 'u2' ? { ...r, plan: 'pro' } : r));
  const b = s.refresh('pro', changed, NOW + DAY);
  assert.deepEqual([b.ids, b.added, b.removed], [['u1', 'u2', 'u6'], 1, 1]);
  assert.ok(s.has('pro', 'u2'));
  assert.ok(!s.has('pro', 'u3'));
  assert.throws(() => s.refresh('pro', [...R, R[0]!], NOW), /two records have the id u1/);
  assert.throws(() => s.refresh('ghost', R, NOW), /no segment ghost/);
});

test('a segment can build on another one; refresh order and requirements follow', () => {
  const s = mk();
  s.define(seg('pro', { field: 'plan', cmp: '=', value: 'pro' }));
  s.define(seg('pro-quiet', { op: 'all', rules: [{ segment: 'pro' }, { field: 'lastSeen', cmp: 'older-than-days', value: 5 }] }));
  s.define(seg('not-pro', { op: 'not', rule: { segment: 'pro' } }));
  assert.deepEqual(s.order(), ['pro', 'not-pro', 'pro-quiet']);
  assert.throws(() => s.refresh('pro-quiet', R, NOW), /has not been refreshed yet/);
  s.refresh('pro', R, NOW);
  assert.deepEqual(s.refresh('pro-quiet', R, NOW).ids, ['u3']);
  assert.deepEqual(s.refresh('not-pro', R, NOW).ids, ['u2', 'u4', 'u5']);
});

test('freshness and due: missing, fresh, stale, and dependencies first', () => {
  const s = mk();
  s.define(seg('pro', { field: 'plan', cmp: '=', value: 'pro' }, { maxAgeMs: 3_600_000 }));
  s.define(seg('big', { op: 'all', rules: [{ segment: 'pro' }, { field: 'seats', cmp: '>', value: 5 }] }, { maxAgeMs: 7_200_000 }));
  assert.deepEqual(s.freshness('pro', NOW), { fresh: false, ageMs: null, dueAt: null });
  assert.deepEqual(s.due(NOW), ['pro', 'big']);
  s.refresh('pro', R, NOW);
  s.refresh('big', R, NOW);
  assert.deepEqual(s.freshness('pro', NOW + 1_800_000), { fresh: true, ageMs: 1_800_000, dueAt: NOW + 3_600_000 });
  assert.deepEqual(s.due(NOW + 3_600_001), ['pro']);
  assert.deepEqual(s.due(NOW + 7_200_001), ['pro', 'big']);
  assert.throws(() => s.freshness('ghost', NOW), SegmentError);
});

test('CSV export quotes, guards against formulas, leaves sensitive fields out and writes an audit entry', () => {
  const s = mk();
  s.define(seg('everyone', { field: 'seats', cmp: '>', value: 0 }));
  s.refresh('everyone', R, NOW);
  const csv = s.export('everyone', R, { who: 'ops@example.com', now: NOW, format: 'csv', fields: ['id', 'name', 'email', 'seats'] });
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'id,name,seats');
  assert.equal(lines[2], 'u2,"Bob ""B"" Jones",1');
  assert.equal(lines[3], "u3,'=SUM(A1:A9),3");
  assert.equal(lines[4], 'u4,"Di, the Great",25');
  assert.equal(lines[6], "u6,'@cmd,7");
  assert.equal(lines.length, 8);
  assert.ok(!csv.includes('@example.com'));
  assert.deepEqual(s.audit, [{ at: NOW, who: 'ops@example.com', segment: 'everyone', format: 'csv', rows: 6, fields: ['id', 'name', 'seats'], stale: false }]);
  assert.ok(s.export('everyone', R, { who: 'dpo', now: NOW, format: 'csv', fields: ['email'], seeSensitive: true }).includes('ann@example.com'));
});

test('JSON lines export keeps only members and chosen fields; bad requests are refused', () => {
  const s = mk();
  s.define(seg('pro', { field: 'plan', cmp: '=', value: 'pro' }));
  assert.throws(() => s.export('pro', R, { who: 'x', now: NOW, format: 'csv' }), /refresh it first/);
  s.refresh('pro', R, NOW);
  const out = s.export('pro', R, { who: 'ops', now: NOW, format: 'jsonl', fields: ['id', 'lastSeen'] });
  assert.deepEqual(out.trim().split('\n').map((l) => JSON.parse(l)), [{ id: 'u1', lastSeen: NOW - DAY }, { id: 'u3', lastSeen: NOW - 10 * DAY }, { id: 'u6', lastSeen: NOW + 5 * DAY }]);
  assert.throws(() => s.export('pro', R, { who: 'ops', now: NOW, format: 'csv', fields: ['id', 'ssn'] }), /no field ssn/);
  assert.throws(() => s.export('pro', R, { who: ' ', now: NOW, format: 'csv' }), /who asked/);
  assert.equal(s.export('pro', [], { who: 'ops', now: NOW, format: 'jsonl' }), '');
});

test('a stale snapshot is not exported unless the caller says so, and the audit remembers', () => {
  const s = mk();
  s.define(seg('pro', { field: 'plan', cmp: '=', value: 'pro' }));
  s.refresh('pro', R, NOW);
  assert.throws(() => s.export('pro', R, { who: 'ops', now: NOW + 2 * 3_600_000, format: 'csv' }), /out of date \(taken 120 minutes ago\)/);
  s.export('pro', R, { who: 'ops', now: NOW + 2 * 3_600_000, format: 'csv', allowStale: true });
  assert.equal(s.audit.length, 1);
  assert.equal(s.audit[0]!.stale, true);
});

test('csvCell: quoting rules and every formula-leading character', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  for (const c of ['=', '+', '-', '@', '\t', '\r']) assert.ok(csvCell(`${c}1+1`).startsWith(c === '\r' ? '"\'' : "'"), JSON.stringify(c));
  assert.equal(csvCell(-5), "'-5");
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(new Date(Date.UTC(2026, 0, 2))), '2026-01-02T00:00:00.000Z');
  assert.equal(csvCell(true), 'true');
});

test('the collection must have the id field, and a redefined segment drops its old snapshot', () => {
  assert.throws(() => new Segments(users, 'uuid'), /no field uuid/);
  const s = mk();
  s.define(seg('pro', { field: 'plan', cmp: '=', value: 'pro' }));
  s.refresh('pro', R, NOW);
  s.define(seg('pro', { field: 'plan', cmp: '=', value: 'team' }));
  assert.equal(s.snapshot('pro'), undefined);
  assert.equal(s.refresh('pro', R, NOW).ids.join(), 'u4');
});
