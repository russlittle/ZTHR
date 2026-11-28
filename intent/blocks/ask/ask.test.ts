import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ask, check, describe, measureLabel, schemaFor, twinModel, type Answer, type Dataset, type Refusal } from './index.ts';

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

// ---- Checking a proposal: every refusal says its own reason, and every accepted form comes out exactly. ----

const base = [{ op: 'count' }];
const refusals = (raw: unknown, d: Dataset = dataset, p = advisor) => {
  const c = check(raw, d, p);
  return c.ok ? 'accepted' : c.problems;
};
const accepted = (raw: unknown, d: Dataset = dataset, p = advisor) => {
  const c = check(raw, d, p);
  if (!c.ok) assert.fail(`refused: ${c.problems.join(' | ')}`);
  return c;
};

const wide: Dataset = {
  ...dataset,
  fields: [...dataset.fields, { name: 'memo', label: 'Memo', type: 'text', filterable: false }, { name: 'audit', label: 'Audit', type: 'text', seenBy: ['finance', 'registrar'] }],
};

test('a field restricted to several roles is seen by a person holding any one of them', () => {
  const some = { id: 'u3', roles: ['registrar'] };
  assert.equal(schemaFor(wide, some).fields.some((f) => f.name === 'audit'), true);
  assert.equal(schemaFor(wide, advisor).fields.some((f) => f.name === 'audit'), false);
  assert.equal(refusals({ groupBy: ['audit'], measures: base }, wide, some), 'accepted');
});

test('a proposal that is not an object is refused outright, whatever else it is', () => {
  for (const raw of [null, 'x', 5, true, undefined, []]) assert.deepEqual(check(raw, dataset, advisor), { ok: false, problems: ['The proposal is not a report.'] });
});

test('a single unknown key is reported with "is", several with "are"', () => {
  assert.deepEqual(refusals({ measures: base, sql: 'x' }), ['The proposal has "sql", which is not allowed.']);
  assert.deepEqual(refusals({ measures: [{ op: 'count', extra: 1 }] }), ['A measure has "extra", which is not allowed.']);
  assert.deepEqual(refusals({ measures: base, filters: [{ field: 'campus', eq: 'North', also: 1 }] }), ['The filter on Campus has "also", which is not allowed.']);
  assert.deepEqual(refusals({ measures: base, filters: [{ field: 'campus', in: ['North'], also: 1 }] }), ['The filter on Campus has "also", which is not allowed.']);
  assert.deepEqual(refusals({ measures: base, filters: [{ field: 'credits', gte: 1, also: 1 }] }), ['The filter on Credit has "also", which is not allowed.']);
  assert.deepEqual(refusals({ measures: base, sort: { measure: 0, also: 1 } }), ['The sort has "also", which is not allowed.']);
});

test('names quoted in a refusal are cut at 40 characters with an ellipsis, and not before', () => {
  const at40 = 'a'.repeat(40);
  const at41 = 'a'.repeat(41);
  assert.deepEqual(refusals({ groupBy: [at40], measures: base }), [`Grouping uses "${at40}", which is not something you can ask about in enrolments.`]);
  assert.deepEqual(refusals({ groupBy: [at41], measures: base }), [`Grouping uses "${at40}…", which is not something you can ask about in enrolments.`]);
});

test('grouping: a name that is not text, a list that is not a list, and a field named twice each say so', () => {
  assert.deepEqual(refusals({ groupBy: [5], measures: base }), ['Grouping must name a field.']);
  assert.deepEqual(refusals({ groupBy: 'campus', measures: base }), ['groupBy must be a list of fields.']);
  assert.deepEqual(refusals({ groupBy: ['campus', 'campus'], measures: base }), ['Campus is grouped by twice.']);
  const c = accepted({ groupBy: ['campus', 'programme'], measures: base });
  assert.deepEqual(c.spec.groupBy, ['campus', 'programme']);
});

test('measures: at most four, each an object with a known op and, except count, a field of a fitting type', () => {
  const five = [{ op: 'count' }, { op: 'sum', field: 'credits' }, { op: 'avg', field: 'credits' }, { op: 'min', field: 'credits' }, { op: 'max', field: 'credits' }];
  assert.deepEqual(refusals({ measures: five }), ['A question can ask for at most 4 measures.']);
  assert.equal(refusals({ measures: five.slice(0, 4) }), 'accepted');
  assert.deepEqual(refusals({ measures: ['count'] }), ['Each measure must be an object with an op.']);
  assert.deepEqual(refusals({ measures: [5] }), ['Each measure must be an object with an op.']);
  assert.deepEqual(refusals({ measures: [{ op: 5 }] }), ['5 is not a measure; use one of count, sum, avg, min, max, distinct.']);
  assert.deepEqual(refusals({ measures: [{ op: 'sum' }] }), ['The sum measure must name a field.']);
  assert.deepEqual(refusals({ measures: 'count' }), ['The proposal must ask for at least one measure.']);
});

test('a date can be compared (lowest, highest) but not added up or averaged, and text can be none of those', () => {
  assert.deepEqual(refusals({ measures: [{ op: 'sum', field: 'started' }] }), ['Start date is not a number, so it cannot be added up.']);
  assert.deepEqual(refusals({ measures: [{ op: 'avg', field: 'started' }] }), ['Start date is not a number, so it cannot be averaged.']);
  assert.deepEqual(refusals({ measures: [{ op: 'min', field: 'campus' }] }), ['Campus is not a number, so it cannot be compared.']);
  assert.deepEqual(refusals({ measures: [{ op: 'max', field: 'campus' }] }), ['Campus is not a number, so it cannot be compared.']);
  assert.deepEqual(accepted({ measures: [{ op: 'min', field: 'started' }] }).spec.measures, [{ name: 'min_started', op: 'min', field: 'started' }]);
  assert.deepEqual(accepted({ measures: [{ op: 'max', field: 'started' }] }).spec.measures, [{ name: 'max_started', op: 'max', field: 'started' }]);
  assert.deepEqual(accepted({ measures: [{ op: 'distinct', field: 'campus' }] }).spec.measures, [{ name: 'distinct_campus', op: 'distinct', field: 'campus' }]);
});

test('asking for the same measure twice computes it once', () => {
  const c = accepted({ measures: [{ op: 'sum', field: 'credits' }, { op: 'avg', field: 'credits' }, { op: 'sum', field: 'credits' }] });
  assert.deepEqual(c.spec.measures.map((m) => m.name), ['sum_credits', 'avg_credits']);
});

test('filters: a list of at most six, each an object naming a field the person may filter on', () => {
  const f = { field: 'campus', eq: 'North' };
  assert.deepEqual(refusals({ measures: base, filters: 'x' }), ['filters must be a list.']);
  assert.deepEqual(refusals({ measures: base, filters: [f, f, f, f, f, f, f] }), ['A question can have at most 6 filters.']);
  assert.equal(refusals({ measures: base, filters: [f, f, f, f, f, f] }), 'accepted');
  assert.deepEqual(refusals({ measures: base, filters: ['x'] }), ['Each filter must be an object with a field.']);
  assert.deepEqual(refusals({ measures: base, filters: [{ eq: 'x' }] }), ['A filter must name a field.']);
  assert.deepEqual(refusals({ measures: base, filters: [{ field: 'salary', eq: 'x' }] }), ['A filter uses "salary", which is not something you can ask about in enrolments.']);
  assert.deepEqual(refusals({ measures: base, filters: [{ field: 'memo', eq: 'x' }] }, wide), ['Memo cannot be filtered on.']);
});

test('an equality filter takes a number for a number field, a string for a date field, and any plain value for text', () => {
  const eq = (field: string, v: unknown) => refusals({ measures: base, filters: [{ field, eq: v }] });
  assert.equal(eq('credits', 12), 'accepted');
  assert.deepEqual(eq('credits', '12'), ['"12" is not a value Credit can have.']);
  assert.deepEqual(eq('credits', Number.POSITIVE_INFINITY), ['Infinity is not a value Credit can have.']);
  assert.deepEqual(eq('started', 2026), ['2026 is not a value Start date can have.']);
  assert.deepEqual(eq('student', null), ['null is not a value Student can have.']);
  assert.deepEqual(eq('student', ['a']), ['a is not a value Student can have.']);
  assert.deepEqual(eq('student', {}), ['[object Object] is not a value Student can have.']);
  assert.deepEqual(eq('student', Number.NaN), ['NaN is not a value Student can have.']);
  assert.deepEqual(eq('student', Number.POSITIVE_INFINITY), ['Infinity is not a value Student can have.']);
  for (const v of ['ada', 7, true, false, 0, '']) assert.equal(eq('student', v), 'accepted', `plain value ${JSON.stringify(v)}`);
});

test('dates may be a year, a month, a day, or a day with a time, and nothing looser', () => {
  const eq = (v: unknown) => refusals({ measures: base, filters: [{ field: 'started', eq: v }] });
  for (const v of ['2026', '2026-01', '2026-01-31', '2026-01-31T10:00', '2026-01-31T10:00:00', '2026-01-31T10:00:00Z', '2026-01-31T10:00:00.123Z', '2026-01-31T1']) assert.equal(eq(v), 'accepted', v);
  for (const v of ['x2026', '2026x', '2026-01-31x', 'soon', '202', '2026-1', '2026-01-3', '2026-01-31T', '2026-01-31Tab', '2026-01-31T10:00Zx', '2026-01-31 10:00', '']) assert.equal(eq(v) === 'accepted', false, v);
});

test('an "in" filter takes one to fifty acceptable values and names each one it cannot accept', () => {
  const inn = (field: string, values: unknown) => refusals({ measures: base, filters: [{ field, in: values }] });
  assert.equal(inn('student', Array.from({ length: 50 }, (_, i) => `s${i}`)), 'accepted');
  assert.deepEqual(inn('student', Array.from({ length: 51 }, (_, i) => `s${i}`)), ['The filter on Student must list between 1 and 50 values.']);
  assert.deepEqual(inn('student', 'x'), ['The filter on Student must list between 1 and 50 values.']);
  assert.deepEqual(inn('status', ['active', 'graduated']), ['"graduated" is not a value Status can have.']);
  assert.deepEqual(inn('status', ['active', 'graduated', 'left']), ['"graduated", "left" are not values Status can have.']);
  assert.deepEqual(inn('credits', ['x']), ['"x" is not a value Credit can have.']);
  assert.deepEqual(inn('credits', [1, 'x', 3]), ['"x" is not a value Credit can have.']);
  assert.deepEqual(accepted({ measures: base, filters: [{ field: 'status', in: ['active', 'withdrawn'] }] }).spec.filters, [{ field: 'status', in: ['active', 'withdrawn'] }]);
});

test('a range may have one end or both, each end must be of the field kind, and only number and date fields have ranges', () => {
  const range = (field: string, r: Record<string, unknown>) => refusals({ measures: base, filters: [{ field, ...r }] });
  assert.deepEqual(accepted({ measures: base, filters: [{ field: 'credits', gte: 5 }] }).spec.filters, [{ field: 'credits', gte: 5 }]);
  assert.deepEqual(accepted({ measures: base, filters: [{ field: 'credits', lt: 5 }] }).spec.filters, [{ field: 'credits', lt: 5 }]);
  assert.deepEqual(accepted({ measures: base, filters: [{ field: 'started', gte: '2026', lt: '2027-01' }] }).spec.filters, [{ field: 'started', gte: '2026', lt: '2027-01' }]);
  assert.deepEqual(range('credits', { gte: 5, lt: 'x' }), ['The range on Credit must use numbers.']);
  assert.deepEqual(range('credits', { gte: 'x', lt: 5 }), ['The range on Credit must use numbers.']);
  assert.deepEqual(range('started', { lt: 5 }), ['The range on Start date must use dates like 2026-01-31.']);
  assert.deepEqual(range('started', { gte: '2026-01-01', lt: 'soon' }), ['The range on Start date must use dates like 2026-01-31.']);
  assert.deepEqual(range('campus', { lt: 'B' }), ['Campus is text, so it cannot be filtered by a range.']);
});

test('sort: an object that names one measure by position or one grouping field, with an optional true/false direction', () => {
  const sorted = (sort: unknown, extra: Record<string, unknown> = {}) => refusals({ groupBy: ['campus'], measures: [{ op: 'count' }, { op: 'sum', field: 'credits' }], sort, ...extra });
  assert.deepEqual(sorted('x'), ['sort must be an object.']);
  assert.deepEqual(sorted({ measure: 0, desc: 'yes' }), ['sort.desc must be true or false.']);
  assert.deepEqual(sorted({ measure: 5 }), ['The sort names a measure that is not in the question.']);
  assert.deepEqual(sorted({ measure: -1 }), ['The sort names a measure that is not in the question.']);
  assert.deepEqual(sorted({ measure: 1.5 }), ['The sort must name either a measure or a grouping field.']);
  assert.deepEqual(sorted({ measure: '0' }), ['The sort must name either a measure or a grouping field.']);
  assert.deepEqual(sorted({ measure: 0, field: 'campus' }), ['The sort must name either a measure or a grouping field.']);
  assert.deepEqual(sorted({ measure: 1.5, field: 'campus' }), ['The sort must name either a measure or a grouping field.']);
  assert.deepEqual(sorted({ desc: true }), ['The sort must name either a measure or a grouping field.']);
  assert.deepEqual(sorted({}), ['The sort must name either a measure or a grouping field.']);
  assert.deepEqual(sorted({ field: 5 }), ['The sort must name either a measure or a grouping field.']);
  assert.deepEqual(sorted({ field: 'programme' }), ['The sort uses "programme", which is not one of the groupings.']);
  assert.deepEqual(accepted({ groupBy: ['campus'], measures: base, sort: { field: 'campus' } }).spec.sort, { by: 'campus', desc: false });
  assert.deepEqual(accepted({ groupBy: ['campus'], measures: base, sort: { field: 'campus', desc: true } }).spec.sort, { by: 'campus', desc: true });
  assert.deepEqual(accepted({ groupBy: ['campus'], measures: [{ op: 'count' }, { op: 'sum', field: 'credits' }], sort: { measure: 1, desc: false } }).spec.sort, { by: 'sum_credits', desc: false });
  assert.deepEqual(accepted({ measures: [{ op: 'count' }], sort: { measure: 0 } }).spec.sort, { by: 'count', desc: false });
});

test('a sort on a measure that was itself refused adds its own reason on top of the measure\'s', () => {
  assert.deepEqual(refusals({ measures: [{ op: 'sum', field: 'campus' }, { op: 'count' }], sort: { measure: 0 } }), ['Campus is not a number, so it cannot be added up.', 'The sort names a measure that is not in the question.']);
});

test('a sort position counts the measures as asked, including a repeated one', () => {
  const c = accepted({ measures: [{ op: 'count' }, { op: 'count' }, { op: 'sum', field: 'credits' }], sort: { measure: 2, desc: true } });
  assert.deepEqual(c.spec.sort, { by: 'sum_credits', desc: true });
  assert.deepEqual(accepted({ measures: [{ op: 'count' }, { op: 'count' }], sort: { measure: 1 } }).spec.sort, { by: 'count', desc: false });
});

test('limit: a whole number from 1 to 100', () => {
  const lim = (limit: unknown) => refusals({ measures: base, limit });
  const msg = ['limit must be a whole number from 1 to 100.'];
  for (const v of ['5', 1.5, 0, -1, 101, Number.NaN, null, true]) assert.deepEqual(lim(v), msg, String(v));
  assert.equal(accepted({ measures: base, limit: 1 }).limit, 1);
  assert.equal(accepted({ measures: base, limit: 100 }).limit, 100);
  assert.equal(accepted({ measures: base, limit: 7 }).limit, 7);
});

test('a refused proposal reports each reason once however often it arises', () => {
  assert.deepEqual(refusals({ measures: [{ op: 'sum', field: 'campus' }, { op: 'sum', field: 'campus' }] }), ['Campus is not a number, so it cannot be added up.']);
});

// ---- Describing and answering. ----

test('describe reads a report back in plain words, including ranges with one end and reports with no filters or no minimum', () => {
  const d = (s: Parameters<typeof describe>[0], limit?: number) => describe(s, dataset, limit);
  const count = { name: 'count', op: 'count' as const };
  assert.equal(d({ groupBy: [], measures: [count] }), 'Of all enrolments in enrolments, counted the enrolments.');
  assert.equal(d({ groupBy: [], measures: [count], minGroup: 0 }), 'Of all enrolments in enrolments, counted the enrolments.');
  assert.equal(d({ groupBy: [], measures: [count], filters: [{ field: 'credits', gte: 6 }] }), 'Of all enrolments in enrolments where Credit is 6 or more, counted the enrolments.');
  assert.equal(d({ groupBy: [], measures: [count], filters: [{ field: 'credits', lt: 12 }] }), 'Of all enrolments in enrolments where Credit is before 12, counted the enrolments.');
  assert.equal(d({ groupBy: [], measures: [count], filters: [{ field: 'credits', gte: 6, lt: 12 }] }), 'Of all enrolments in enrolments where Credit is from 6 up to but not including 12, counted the enrolments.');
  assert.equal(d({ groupBy: [], measures: [count], filters: [{ field: 'credits', eq: 6 }, { field: 'campus', in: ['North', 'South', 'East'] }] }), 'Of all enrolments in enrolments where Credit is 6 and Campus is one of North, South and East, counted the enrolments.');
  assert.equal(d({ groupBy: ['campus', 'programme'], measures: [count], sort: { by: 'campus' } }), 'Of all enrolments in enrolments, counted the enrolments for each Campus and Programme. Sorted by Campus, lowest first.');
  assert.equal(d({ groupBy: ['campus'], measures: [count] }, 100), 'Of all enrolments in enrolments, counted the enrolments for each Campus.');
  assert.equal(d({ groupBy: ['campus'], measures: [count] }, 99), 'Of all enrolments in enrolments, counted the enrolments for each Campus. Only the first 99 groups are shown.');
  assert.equal(d({ groupBy: [], measures: [count] }, 5), 'Of all enrolments in enrolments, counted the enrolments.');
  assert.equal(d({ groupBy: ['nowhere'], measures: [{ name: 'x', op: 'sum', field: 'ghost' }] }), 'Of all enrolments in enrolments, added up ghost for each nowhere.');
  assert.equal(d({ groupBy: [], measures: [] }), 'Of all enrolments in enrolments, .');
});

test('a measure with no field still has a label', () => {
  assert.equal(measureLabel({ name: 'x', op: 'sum' }, dataset), 'Total ');
  assert.equal(measureLabel({ name: 'x', op: 'sum', field: 'ghost' }, dataset), 'Total ghost');
  assert.equal(measureLabel({ name: 'x', op: 'distinct', field: 'campus' }, dataset), 'Distinct Campus');
});

test('refusals to ask carry no problems, and a question of exactly 500 characters is allowed', async () => {
  const model = twinModel();
  assert.deepEqual(await ask('', { dataset, rows, person: advisor, model }), { ok: false, say: 'Ask a question about your data, for example "how many by status?".', problems: [] });
  assert.deepEqual(await ask('x'.repeat(501), { dataset, rows, person: advisor, model }), { ok: false, say: 'The question is 501 characters long; keep it under 500.', problems: [] });
  yes(await ask('x'.repeat(500), { dataset, rows, person: advisor, model }));
  const failing = twinModel({ boom: new Error('no') });
  assert.deepEqual(await ask('boom', { dataset, rows, person: advisor, model: failing }), { ok: false, say: 'The question could not be turned into a report. Try asking it another way, naming what to count and how to group it.', problems: [] });
});

test('the records behind an answer carry only the fields that exist on each row, and are cut at twenty', async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ campus: 'North', programme: 'Nursing', status: 'active', student: `s${i}`, started: '2026-09-01', ...(i === 0 ? {} : { credits: 3 }), fee: 1 }));
  const a = yes(await ask('How many by campus', { dataset, rows: many, person: advisor, model: twinModel() }));
  assert.equal(a.recordsTotal, 25);
  assert.equal(a.records.length, 20);
  assert.deepEqual(a.records[0], { campus: 'North', programme: 'Nursing', status: 'active', student: 's0', started: '2026-09-01' });
  assert.deepEqual(a.records[1], { campus: 'North', programme: 'Nursing', status: 'active', student: 's1', started: '2026-09-01', credits: 3 });
});

test('when one group is too small, the next smallest shown group is hidden with it, wherever it sits', async () => {
  const mk = (campus: string, n: number) => Array.from({ length: n }, (_, i) => ({ campus, programme: 'Nursing', status: 'active', student: `${campus}${i}`, started: '2026-09-01', credits: 1, fee: 1 }));
  const data = [...mk('A', 5), ...mk('B', 3), ...mk('C', 4), ...mk('D', 1)];
  const model = twinModel({ q: { groupBy: ['campus'], measures: [{ op: 'count' }], sort: { measure: 0, desc: true } } });
  const a = yes(await ask('q', { dataset, rows: data, person: advisor, model }));
  assert.deepEqual(a.rows, [{ campus: 'A', count: 5 }, { campus: 'C', count: 4 }]);
  assert.equal(a.hidden, 2);
  assert.equal(a.recordsTotal, 9);
  const cb = yes(await ask('q', { dataset, rows: [...mk('A', 4), ...mk('B', 5), ...mk('C', 3), ...mk('D', 6), ...mk('E', 1)], person: advisor, model }));
  assert.deepEqual(cb.rows, [{ campus: 'D', count: 6 }, { campus: 'B', count: 5 }, { campus: 'A', count: 4 }]);
});

test('the note about extra groups appears only when groups really are cut, and each column is labelled by its own field', async () => {
  const model = twinModel({
    exact: { groupBy: ['campus', 'programme'], measures: [{ op: 'count' }], limit: 3, filters: [{ field: 'campus', eq: 'North' }] },
    cut: { groupBy: ['campus'], measures: [{ op: 'count' }], limit: 2 },
    all: { groupBy: ['campus'], measures: [{ op: 'count' }], limit: 3 },
  });
  const e = yes(await ask('exact', { dataset, rows, person: advisor, model }));
  assert.deepEqual(e.columns, [{ key: 'campus', label: 'Campus' }, { key: 'programme', label: 'Programme' }, { key: 'count', label: 'Number of enrolments' }]);
  assert.equal(e.note, undefined);
  assert.equal(yes(await ask('all', { dataset, rows, person: advisor, model })).note, undefined);
  assert.equal(yes(await ask('cut', { dataset, rows, person: advisor, model })).note, 'Only the first 2 of 3 groups are shown.');
});

// ---- The deterministic twin of a model. ----

const schema = (fields: { name: string; label: string; type: 'text' | 'number' | 'date'; groupable?: boolean; filterable?: boolean; values?: (string | number | boolean)[] }[]) => ({
  name: 'd',
  noun: { one: 'row', many: 'rows' },
  fields: fields.map((f) => ({ groupable: f.type !== 'number', filterable: true, ...f })),
  ops: ['count', 'sum', 'avg', 'min', 'max', 'distinct'] as const,
});
const sch = schema([
  { name: 'programme', label: 'Programme', type: 'text', values: ['Nursing', 'Welding'] },
  { name: 'campus', label: 'Campus', type: 'text', values: ['North', 'South', 'East'] },
  { name: 'credits', label: 'Credit', type: 'number' },
  { name: 'started', label: 'Start date', type: 'date' },
]);
const twin = (q: string, s = sch) => twinModel().propose(q, s);

test('the twin reads measures from plain words', async () => {
  assert.deepEqual(await twin('hello'), { groupBy: [], measures: [{ op: 'count' }] });
  assert.deepEqual(await twin('total credits'), { groupBy: [], measures: [{ op: 'sum', field: 'credits' }] });
  assert.deepEqual(await twin('total credit'), { groupBy: [], measures: [{ op: 'sum', field: 'credits' }] });
  assert.deepEqual(await twin('Total Credits.'), { groupBy: [], measures: [{ op: 'sum', field: 'credits' }] });
  assert.deepEqual(await twin('average credits'), { groupBy: [], measures: [{ op: 'avg', field: 'credits' }] });
  assert.deepEqual(await twin('highest credits'), { groupBy: [], measures: [{ op: 'max', field: 'credits' }] });
  assert.deepEqual(await twin('lowest credits'), { groupBy: [], measures: [{ op: 'min', field: 'credits' }] });
  assert.deepEqual(await twin('total'), { groupBy: [], measures: [{ op: 'count' }] }, 'no number field is named, so there is nothing to add up');
  assert.deepEqual(await twin('how many total credits'), { groupBy: [], measures: [{ op: 'count' }, { op: 'sum', field: 'credits' }] });
  assert.deepEqual(await twin('number of rows'), { groupBy: [], measures: [{ op: 'count' }] });
});

test('the twin counts the different values of a field named after "different", "distinct" or "unique"', async () => {
  assert.deepEqual(await twin('how many different campus'), { groupBy: [], measures: [{ op: 'count' }, { op: 'distinct', field: 'campus' }] });
  assert.deepEqual(await twin('unique campus'), { groupBy: [], measures: [{ op: 'distinct', field: 'campus' }] });
  assert.deepEqual(await twin('distinct campus'), { groupBy: [], measures: [{ op: 'distinct', field: 'campus' }] });
  assert.deepEqual(await twin('different progs in programme'), { groupBy: [], measures: [{ op: 'distinct', field: 'programme' }] });
  assert.deepEqual(await twin('different campus by programme'), { groupBy: ['programme'], measures: [{ op: 'distinct', field: 'campus' }] });
  assert.deepEqual(await twin('different campus, programme'), { groupBy: [], measures: [{ op: 'distinct', field: 'campus' }] });
  assert.deepEqual(await twin('different things'), { groupBy: [], measures: [{ op: 'count' }] });
});

test('the twin groups, filters and sorts from plain words', async () => {
  assert.deepEqual(await twin('how many by campus'), { groupBy: ['campus'], measures: [{ op: 'count' }] });
  assert.deepEqual(await twin('how many for each campus'), { groupBy: ['campus'], measures: [{ op: 'count' }] });
  assert.deepEqual(await twin('how many by credit'), { groupBy: [], measures: [{ op: 'count' }] }, 'number fields are not groupable');
  assert.deepEqual(await twin('how many in North'), { groupBy: [], measures: [{ op: 'count' }], filters: [{ field: 'campus', eq: 'North' }] });
  assert.deepEqual(await twin('how many in North,South'), { groupBy: [], measures: [{ op: 'count' }], filters: [{ field: 'campus', in: ['North', 'South'] }] });
  assert.deepEqual(await twin('how many in north and east nursing'), { groupBy: [], measures: [{ op: 'count' }], filters: [{ field: 'programme', eq: 'Nursing' }, { field: 'campus', in: ['North', 'East'] }] });
  assert.deepEqual(await twin('how many in 2026'), { groupBy: [], measures: [{ op: 'count' }], filters: [{ field: 'started', gte: '2026-01-01', lt: '2027-01-01' }] });
  assert.deepEqual(await twin('how many most'), { groupBy: [], measures: [{ op: 'count' }] });
  assert.deepEqual(await twin('how many top 5'), { groupBy: [], measures: [{ op: 'count' }], limit: 5 });
  assert.deepEqual(await twin('how many by campus most'), { groupBy: ['campus'], measures: [{ op: 'count' }], sort: { measure: 0, desc: true } });
  assert.deepEqual(await twin('total credits by campus top 12'), { groupBy: ['campus'], measures: [{ op: 'sum', field: 'credits' }], sort: { measure: 0, desc: true }, limit: 12 });
});
