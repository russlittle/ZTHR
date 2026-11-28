import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Delivery, asCsv, fromTemplate, pivot, run, type Template } from './index.ts';

const sales = [
  { region: 'east', month: '2026-10', amount: 100, rep: 'ana' },
  { region: 'east', month: '2026-11', amount: 150, rep: 'ana' },
  { region: 'east', month: '2026-11', amount: 50, rep: 'ben' },
  { region: 'west', month: '2026-11', amount: 300, rep: 'cy' },
  { region: 'north', month: '2026-11', amount: 7, rep: 'dee' },
  { region: 'west', month: '2026-11', amount: null, rep: 'cy' },
];

test('group, measure, filter, sort, suppress small groups and total', () => {
  const r = run(sales, { groupBy: ['region'], measures: [{ name: 'n', op: 'count' }, { name: 'total', op: 'sum', field: 'amount' }, { name: 'reps', op: 'distinct', field: 'rep' }, { name: 'avg', op: 'avg', field: 'amount' }], sort: { by: 'total', desc: true }, minGroup: 2 });
  assert.deepEqual(r.rows, [{ region: 'east', n: 3, total: 300, reps: 2, avg: 100 }]);
  assert.equal(r.hidden, 2, 'north has one row, and west, the next smallest, is hidden with it so the totals do not give north away');
  assert.deepEqual(r.totals, { region: 'Total', n: 6, total: 607, reps: 4, avg: 121.4 });
  const nov = run(sales, { filters: [{ field: 'month', eq: '2026-11' }, { field: 'amount', gte: 50 }], groupBy: ['rep'], measures: [{ name: 'max', op: 'max', field: 'amount' }] });
  assert.deepEqual(nov.rows.map((x) => x.rep), ['ana', 'ben', 'cy']);
  assert.throws(() => run(sales, { groupBy: [], measures: [{ name: 's', op: 'sum' }] }), /needs a field/);
  assert.equal(asCsv(nov).split('\r\n').at(-1), 'Total,300');
});

test('pivot with one dimension across', () => {
  const p = pivot(sales, 'region', 'month', { name: 'total', op: 'sum', field: 'amount' });
  assert.deepEqual(p.columns, ['region', '2026-10', '2026-11']);
  assert.deepEqual(p.rows[0], { region: 'east', '2026-10': 100, '2026-11': 200 });
  assert.deepEqual(p.rows.find((r) => r.region === 'west'), { region: 'west', '2026-10': null, '2026-11': 300 });
});

test('templates check their parameters; scheduled delivery runs when due and logs failures', async () => {
  const t: Template = { id: 'by-region', title: 'Sales by region', params: { month: { default: '2026-11' }, order: { default: 'asc', options: ['asc', 'desc'] } }, build: (p) => ({ filters: [{ field: 'month', eq: p.month }], groupBy: ['region'], measures: [{ name: 'total', op: 'sum', field: 'amount' }], sort: { by: 'total', desc: p.order === 'desc' } }) };
  assert.throws(() => fromTemplate(t, { order: 'sideways' }), /one of asc, desc/);
  assert.throws(() => fromTemplate(t, { colour: 'red' }), /no parameter colour/);
  const sent: string[] = [];
  let fail = false;
  const d = new Delivery([t], async () => sales, async (_to, title, csv) => {
    if (fail) throw new Error('mail down');
    sent.push(`${title}\n${csv}`);
  });
  d.schedule('by-region', { order: 'desc' }, '0 7 * * 1', ['ana@x.org'], new Date('2026-11-26T12:00:00Z'));
  assert.equal(await d.tick(new Date('2026-11-29T12:00:00Z')), 0, 'not yet Monday 07:00');
  assert.equal(await d.tick(new Date('2026-11-30T07:00:00Z')), 1);
  assert.match(sent[0]!, /^Sales by region\nregion,total\r\nwest,300/);
  fail = true;
  await d.tick(new Date('2026-12-07T07:00:00Z'));
  assert.deepEqual(d.log.map((l) => [l.ok, l.error]), [[true, undefined], [false, 'mail down']]);
  assert.equal(new Date(d.schedules[0]!.next).toISOString(), '2026-12-14T07:00:00.000Z');
});

test('min and max work on large groups', () => {
  const big = Array.from({ length: 500_000 }, (_, i) => ({ g: 'all', v: i }));
  const r = run(big, { groupBy: ['g'], measures: [{ name: 'lo', op: 'min', field: 'v' }, { name: 'hi', op: 'max', field: 'v' }] });
  assert.deepEqual(r.rows, [{ g: 'all', lo: 0, hi: 499_999 }]);
});

test('a pivot column named like an object property is a column like any other', () => {
  const p = pivot([{ k: 'a', c: 'constructor', n: 1 }, { k: 'b', c: 'toString', n: 2 }], 'k', 'c', { name: 'n', op: 'sum', field: 'n' });
  assert.deepEqual(p.rows, [{ k: 'a', constructor: 1, toString: null }, { k: 'b', constructor: null, toString: 2 }]);
});

test('a parameter name a template does not have is refused, even one named like an object property', () => {
  const t: Template = { id: 't', title: 'T', params: {}, build: () => ({ groupBy: [], measures: [] }) };
  assert.throws(() => fromTemplate(t, { toString: 'x' }), /no parameter toString/);
});

test('two ticks that overlap deliver a due report once', async () => {
  const t: Template = { id: 't', title: 'T', params: {}, build: () => ({ groupBy: ['region'], measures: [{ name: 'n', op: 'count' }] }) };
  let sends = 0;
  const d = new Delivery([t], () => new Promise((r) => setTimeout(() => r(sales), 5)), async () => void sends++);
  d.schedule('t', {}, '0 7 * * *', ['ana@x.org'], new Date('2026-11-26T12:00:00Z'));
  const at = new Date('2026-11-27T07:00:00Z');
  const n = await Promise.all([d.tick(at), d.tick(at)]);
  assert.equal(sends, 1);
  assert.deepEqual(n.sort(), [0, 1]);
});

test('one small group is never recoverable as totals minus the rows shown, and too few matching rows withhold the totals', () => {
  const rows = [...Array(5)].map(() => ({ team: 'a', pay: 10 })).concat([...Array(4)].map(() => ({ team: 'b', pay: 20 })), [{ team: 'c', pay: 99 }]);
  const spec = { groupBy: ['team'], measures: [{ name: 'n', op: 'count' as const }, { name: 'pay', op: 'sum' as const, field: 'pay' }], minGroup: 3 };
  const r = run(rows, spec);
  assert.deepEqual(r.rows, [{ team: 'a', n: 5, pay: 50 }], 'c is too small, and b (the next smallest) goes with it');
  assert.equal(r.hidden, 2);
  assert.deepEqual(r.totals, { team: 'Total', n: 10, pay: 229 });
  assert.notEqual((r.totals.pay as number) - 50, 99, 'totals minus what is shown is not the hidden group');
  const two = run(rows.filter((x) => x.team !== 'b').concat([{ team: 'd', pay: 1 }]), spec);
  assert.deepEqual(two.rows.map((x) => x.team), ['a'], 'two small groups already hide each other');
  assert.equal(two.hidden, 2);
  const few = run(rows.filter((x) => x.team === 'c'), spec);
  assert.equal(few.totalsWithheld, true);
  assert.deepEqual(few.totals, { team: 'Total', n: null, pay: null });
  assert.equal(asCsv(few), 'team,n,pay', 'no totals row when they are withheld');
  assert.equal(run(rows, { groupBy: spec.groupBy, measures: spec.measures }).hidden, 0, 'no floor, nothing hidden');
});
