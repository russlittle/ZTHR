import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ask, check, describe, schemaFor, twinModel, type Answer, type Dataset, type Refusal } from './index.ts';

const dataset: Dataset = {
  name: 'enrolments',
  noun: { one: 'enrolment', many: 'enrolments' },
  minGroup: 3,
  fields: [
    { name: 'campus', label: 'Campus', type: 'text', values: ['North', 'South', 'East'] },
    { name: 'programme', label: 'Programme', type: 'text', values: ['Nursing', 'Welding'] },
    { name: 'status', label: 'Status', type: 'text', values: ['active', 'withdrawn'] },
    { name: 'student', label: 'Student', type: 'text', groupable: false },
    { name: 'started', label: 'Start date', type: 'date' },
    { name: 'credits', label: 'Credit', type: 'number' },
    { name: 'fee', label: 'Fee', type: 'number', seenBy: ['finance'] },
  ],
};

const row = (campus: string, programme: string, n: number, credits: number, started = '2026-09-01', status = 'active') =>
  Array.from({ length: n }, (_, i) => ({ campus, programme, status, student: `${campus}-${programme}-${i}`, started, credits, fee: credits * 100 }));
const rows = [...row('North', 'Nursing', 6, 12), ...row('North', 'Welding', 4, 6, '2025-09-01'), ...row('South', 'Nursing', 5, 10), ...row('South', 'Welding', 1, 6), ...row('East', 'Nursing', 3, 9, '2026-01-15', 'withdrawn')];

const advisor = { id: 'u1', roles: ['advisor'] };
const finance = { id: 'u2', roles: ['advisor', 'finance'] };
const yes = (a: Answer | Refusal): Answer => {
  if (!a.ok) assert.fail(`refused: ${a.say} ${a.problems.join(' | ')}`);
  return a;
};
const no = (a: Answer | Refusal): Refusal => {
  if (a.ok) assert.fail('expected a refusal');
  return a;
};

test('a question becomes a checked report, answered with the records behind it and a description of what was computed', async () => {
  const model = twinModel();
  const a = yes(await ask('How many enrolments by campus, most first?', { dataset, rows, person: advisor, model }));
  assert.deepEqual(a.spec, { groupBy: ['campus'], measures: [{ name: 'count', op: 'count' }], sort: { by: 'count', desc: true }, minGroup: 3 });
  assert.deepEqual(a.columns, [{ key: 'campus', label: 'Campus' }, { key: 'count', label: 'Number of enrolments' }]);
  assert.deepEqual(a.rows, [{ campus: 'North', count: 10 }, { campus: 'South', count: 6 }, { campus: 'East', count: 3 }]);
  assert.deepEqual(a.totals, { campus: 'Total', count: 19 });
  assert.equal(a.hidden, 0);
  assert.equal(a.description, 'Of all enrolments in enrolments, counted the enrolments for each Campus. Sorted by Number of enrolments, highest first. Groups of fewer than 3 enrolments are hidden to protect privacy.');
  assert.equal(a.recordsTotal, 19);
  assert.equal(a.records.length, 19);
  assert.deepEqual(Object.keys(a.records[0]!), ['campus', 'programme', 'status', 'student', 'started', 'credits'], 'records carry only fields the person may see');
  assert.equal(a.note, undefined);
});

test('filters from declared values and a year, several measures, and the top N', async () => {
  const a = yes(await ask('Total credits and average credits for nursing by campus in 2026, top 2', { dataset, rows, person: advisor, model: twinModel() }));
  assert.deepEqual(a.spec.filters, [{ field: 'programme', eq: 'Nursing' }, { field: 'started', gte: '2026-01-01', lt: '2027-01-01' }]);
  assert.deepEqual(a.rows, [{ campus: 'North', sum_credits: 72, avg_credits: 12 }, { campus: 'South', sum_credits: 50, avg_credits: 10 }]);
  assert.deepEqual(a.totals, { campus: 'Total', sum_credits: 149, avg_credits: 149 / 14 });
  assert.equal(a.note, 'Only the first 2 of 3 groups are shown.');
  assert.equal(a.description, 'Of all enrolments in enrolments where Programme is Nursing and Start date is from 2026-01-01 up to but not including 2027-01-01, added up Credit and averaged Credit for each Campus. Sorted by Average Credit, highest first. Only the first 2 groups are shown. Groups of fewer than 3 enrolments are hidden to protect privacy.');
  assert.equal(a.recordsTotal, 11, 'records come only from the groups shown');
});

test('small groups are hidden, a second group is hidden when one alone could be worked out from the total, and thin totals are withheld', async () => {
  const model = twinModel({
    byProgramme: { groupBy: ['campus', 'programme'], measures: [{ op: 'count' }] },
    southWelding: { filters: [{ field: 'campus', eq: 'South' }, { field: 'programme', eq: 'Welding' }], measures: [{ op: 'count' }] },
    southByProgramme: { filters: [{ field: 'campus', eq: 'South' }], groupBy: ['programme'], measures: [{ op: 'count' }] },
  });
  const a = yes(await ask('byProgramme', { dataset, rows, person: advisor, model }));
  assert.deepEqual(a.rows, [{ campus: 'North', programme: 'Nursing', count: 6 }, { campus: 'North', programme: 'Welding', count: 4 }, { campus: 'South', programme: 'Nursing', count: 5 }]);
  assert.equal(a.hidden, 2, 'South Welding (1) is too small; East Nursing (3), the smallest shown, is hidden with it');
  assert.equal(a.note, '2 groups are hidden because they have, or would reveal one that has, fewer than 3 enrolments.');
  assert.deepEqual(a.totals, { campus: 'Total', programme: '', count: 19 });
  assert.equal(a.recordsTotal, 15);
  assert.ok(a.records.every((r) => r.campus !== 'East' && !(r.campus === 'South' && r.programme === 'Welding')), 'no record from a hidden group is shown');
  const one = yes(await ask('southWelding', { dataset, rows, person: advisor, model }));
  assert.deepEqual([one.rows, one.totals, one.hidden, one.records], [[], null, 1, []]);
  assert.equal(one.note, '1 group is hidden because it has fewer than 3 enrolments. Fewer than 3 enrolments match, so the totals are not shown.');
  const both = yes(await ask('southByProgramme', { dataset, rows, person: advisor, model }));
  assert.deepEqual([both.rows, both.hidden, both.totals], [[], 2, { programme: 'Total', count: 6 }]);
});

test('fields the person may not see are never shown to the model, and a proposal that reaches for one is refused like a field that does not exist', async () => {
  const model = twinModel({ fees: { measures: [{ op: 'sum', field: 'fee' }] }, nothing: { measures: [{ op: 'sum', field: 'salary' }] }, proto: { groupBy: ['__proto__'], measures: [{ op: 'count' }] } });
  await ask('How many by campus', { dataset, rows, person: advisor, model });
  assert.deepEqual(model.asked[0]!.schema.fields.map((f) => f.name), ['campus', 'programme', 'status', 'student', 'started', 'credits']);
  const hidden = no(await ask('fees', { dataset, rows, person: advisor, model }));
  const missing = no(await ask('nothing', { dataset, rows, person: advisor, model }));
  assert.deepEqual(hidden.problems, ['The sum measure uses "fee", which is not something you can ask about in enrolments.']);
  assert.deepEqual(missing.problems, ['The sum measure uses "salary", which is not something you can ask about in enrolments.']);
  assert.equal(hidden.say, 'That question cannot be answered from this data, so nothing was run. Try asking it another way.');
  assert.deepEqual(no(await ask('proto', { dataset, rows, person: advisor, model })).problems, ['Grouping uses "__proto__", which is not something you can ask about in enrolments.']);
  const f = yes(await ask('fees', { dataset, rows, person: finance, model }));
  assert.deepEqual(f.totals, { sum_fee: 17_900 });
  assert.equal(schemaFor(dataset, finance).fields.some((x) => x.name === 'fee'), true);
});

test('everything outside the declared shape is refused, with every reason at once', () => {
  const c = check({ groupBy: ['credits', 'campus', 'status'], measures: [{ op: 'sum', field: 'campus' }, { op: 'median', field: 'credits' }, { op: 'count', field: 'x' }], filters: [{ field: 'status', eq: 'graduated' }, { field: 'campus', gte: 'A' }, { field: 'credits', eq: 1, in: [1] }, { field: 'started', gte: 'soon' }, { field: 'programme', in: [] }], sort: { field: 'student' }, limit: 0, minGroup: 1, sql: 'drop table' }, dataset, advisor);
  assert.equal(c.ok, false);
  assert.deepEqual(!c.ok && c.problems, [
    'The proposal has "minGroup", "sql", which are not allowed.',
    'A question can be grouped by at most 2 fields.',
    'Credit cannot be used to group enrolments.',
    'Campus is not a number, so it cannot be added up.',
    '"median" is not a measure; use one of count, sum, avg, min, max, distinct.',
    'count counts records and takes no field.',
    '"graduated" is not a value Status can have.',
    'Campus is text, so it cannot be filtered by a range.',
    'The filter on Credit must use exactly one of eq, in, or a range (gte and lt).',
    'The range on Start date must use dates like 2026-01-31.',
    'The filter on Programme must list between 1 and 50 values.',
    'The sort uses "student", which is not one of the groupings.',
    'limit must be a whole number from 1 to 100.',
  ]);
  assert.deepEqual(check([], dataset, advisor), { ok: false, problems: ['The proposal is not a report.'] });
  assert.deepEqual(check({ measures: [] }, dataset, advisor), { ok: false, problems: ['The proposal must ask for at least one measure.'] });
  assert.deepEqual(check({ measures: [{ op: 'count' }], filters: [{ field: 'campus', eq: { $ne: null } }] }, dataset, advisor), { ok: false, problems: ['[object Object] is not a value Campus can have.'] });
  const ok = check({ measures: [{ op: 'max', field: 'started' }, { op: 'distinct', field: 'student' }, { op: 'count' }, { op: 'count' }], filters: [{ field: 'campus', in: ['North', 'East'] }, { field: 'credits', gte: 6, lt: 12 }], sort: { measure: 0 } }, dataset, advisor);
  assert.deepEqual(ok, { ok: true, limit: 100, spec: { filters: [{ field: 'campus', in: ['North', 'East'] }, { field: 'credits', gte: 6, lt: 12 }], groupBy: [], measures: [{ name: 'max_started', op: 'max', field: 'started' }, { name: 'distinct_student', op: 'distinct', field: 'student' }, { name: 'count', op: 'count' }], sort: { by: 'max_started', desc: false }, minGroup: 3 } });
  if (ok.ok) assert.equal(describe(ok.spec, dataset), 'Of all enrolments in enrolments where Campus is one of North and East and Credit is from 6 up to but not including 12, found the highest Start date, counted the different values of Student and counted the enrolments. Sorted by Highest Start date, lowest first. Groups of fewer than 3 enrolments are hidden to protect privacy.');
});

test('model output as a JSON string is parsed and checked; a model that fails, empty and overlong questions are refused plainly', async () => {
  const model = twinModel({ asText: JSON.stringify({ measures: [{ op: 'count' }], filters: [{ field: 'status', eq: 'withdrawn' }] }), junk: 'SELECT * FROM enrolments', boom: new Error('model timed out') });
  const a = yes(await ask('asText', { dataset, rows, person: advisor, model }));
  assert.deepEqual(a.totals, { count: 3 });
  assert.equal(a.description, 'Of all enrolments in enrolments where Status is withdrawn, counted the enrolments. Groups of fewer than 3 enrolments are hidden to protect privacy.');
  for (const q of ['junk', 'boom']) assert.equal(no(await ask(q, { dataset, rows, person: advisor, model })).say, 'The question could not be turned into a report. Try asking it another way, naming what to count and how to group it.');
  assert.equal(no(await ask('   ', { dataset, rows, person: advisor, model })).say, 'Ask a question about your data, for example "how many by status?".');
  assert.equal(no(await ask('x'.repeat(501), { dataset, rows, person: advisor, model })).say, 'The question is 501 characters long; keep it under 500.');
  assert.equal(model.asked.length, 3, 'empty and overlong questions never reach the model');
});
