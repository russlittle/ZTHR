import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POINTS, Publisher, featureReport, improvementBrief, markdown, median, operationsReport, percentile, type Doc, type Journey, type Walk } from './index.ts';
import { Incidents, type Incident } from '../slo/index.ts';
import { Pipeline } from '../pipeline/index.ts';
import { Meter } from '../costmeter/index.ts';

const FROM = '2026-11-16';
const TO = '2026-11-23';
const journeys: Journey[] = [
  { id: 'share', feature: 'sharing', goal: 'Share a folder', persona: 'owner', budget: { actions: 5, ms: 3000 } },
  { id: 'revoke', feature: 'sharing', goal: 'Take back a share', persona: 'owner', budget: { actions: 3, ms: 2000 } },
  { id: 'upload', feature: 'files', goal: 'Upload a file', persona: 'member', budget: { actions: 3, ms: 5000 } },
];

let n = 0;
const walk = (journey: string, persona: string, outcome: Walk['outcome'], extra: Partial<Walk> = {}): Walk => ({ journey, feature: journeys.find((j) => j.id === journey)!.feature, persona, session: `s${++n}`, at: '2026-11-18T10:00:00Z', outcome, actions: 4, ms: 2000, ...extra });

function walks(): Walk[] {
  n = 0;
  return [
    ...Array.from({ length: 12 }, () => walk('share', 'owner', 'completed')),
    walk('share', 'owner', 'completed', { actions: 9 }),
    walk('share', 'owner', 'abandoned', { stoppedAt: 'choose people' }),
    walk('share', 'owner', 'abandoned', { stoppedAt: 'choose people' }),
    walk('share', 'owner', 'abandoned', { stoppedAt: 'set expiry' }),
    walk('share', 'owner', 'error', { error: 'grant store timed out' }),
    ...Array.from({ length: 3 }, () => walk('share', 'auditor', 'completed')),
    walk('revoke', 'owner', 'refused', { refusal: 'not the owner' }),
    walk('share', 'owner', 'completed', { at: '2026-11-30T00:00:00Z' }),
    ...Array.from({ length: 4 }, () => walk('upload', 'member', 'error', { error: 'quota check failed' })),
  ];
}

test('a feature report says who uses it, with small groups hidden, and whether its journeys complete within budget', () => {
  const d = featureReport({ id: 'sharing', name: 'Sharing' }, journeys, walks(), { from: FROM, to: TO });
  assert.equal(d.title, 'Sharing: use and health');
  assert.deepEqual(d.sections.map((s) => s.heading), ['Who uses it', 'Whether its journeys complete within budget', 'Where people stop', 'Refusals and errors']);
  const [who, js, stop, ref] = d.sections as [Doc['sections'][0], Doc['sections'][0], Doc['sections'][0], Doc['sections'][0]];
  assert.deepEqual(who.text, ['21 people used it in this period.', '1 smaller group is not shown, so no one can be picked out.']);
  assert.deepEqual(who.table!.rows, [['owner', 18, 18]], 'three auditors are fewer than ten, so not shown; the walk after the period is not counted');
  assert.deepEqual(js.table!.rows, [['Share a folder', 20, 16, 15, 75, 2000, 4], ['Take back a share', 1, 0, 0, 0, null, null]]);
  assert.deepEqual(js.findings, [
    { level: 'attention', text: 'Only 75% of walks of "Share a folder" finished within its budget of 5 actions and 3000 ms.', evidence: ['20 walks, 16 completed, 15 within budget'] },
    { level: 'attention', text: 'Only 0% of walks of "Take back a share" finished within its budget of 3 actions and 2000 ms.', evidence: ['1 walk, 0 completed, 0 within budget'] },
  ]);
  assert.deepEqual(stop.table!.rows, [['Share a folder', 'choose people', 2], ['Share a folder', 'set expiry', 1]]);
  assert.deepEqual(stop.findings, [{ level: 'attention', text: 'Most people who leave "Share a folder" stop at choose people.', evidence: ['2 of 3 abandoned walks'] }]);
  assert.deepEqual(ref.table!.rows, [['Share a folder', 0, 1], ['Take back a share', 1, 0]]);
  assert.deepEqual(ref.findings, [{ level: 'action', text: '1 walk of "Share a folder" ended in an error.', evidence: ['grant store timed out'] }]);
});

test('a feature with few people shows no breakdown at all, and a journey nobody walked is named', () => {
  const d = featureReport({ id: 'files', name: 'Files' }, [...journeys, { id: 'rename', feature: 'files', goal: 'Rename a file', persona: 'member', budget: { actions: 2, ms: 1000 } }], walks(), { from: FROM, to: TO });
  assert.deepEqual(d.sections[0], { heading: 'Who uses it', text: ['Fewer than 10 people used it in this period, so no breakdown is shown.'], findings: [] });
  assert.deepEqual(d.sections[1]!.findings.map((f) => f.text), ['Only 0% of walks of "Upload a file" finished within its budget of 3 actions and 5000 ms.', 'Nobody walked "Rename a file" in this period.']);
  assert.deepEqual(d.sections[2]!.text, ['Nobody left a journey before the goal.']);
  assert.equal(d.sections[2]!.table, undefined);
  assert.deepEqual(d.sections[3]!.findings[0]!.evidence, ['quota check failed'], 'the same error is listed once');
});

test('the operations report covers availability, response times against the feedback budget, errors, incidents, runs, reads and model cost', () => {
  const inc = new Incidents(() => new Date('2026-11-18T09:00:00Z'));
  inc.open('Uploads failing', 1);
  inc.update(1, 'resolved', 'fixed');
  inc.open('Slow search', 3);
  const p = new Pipeline([{ id: 'review', title: 'Review' }, { id: 'prod', title: 'Production' }]);
  p.record({ change: 'c1', stage: 'review', kind: 'entered', at: '2026-11-17T00:00:00Z' });
  p.record({ change: 'c1', stage: 'review', kind: 'passed', at: '2026-11-17T02:00:00Z' });
  p.record({ change: 'c1', stage: 'prod', kind: 'entered', at: '2026-11-17T02:00:00Z' });
  p.record({ change: 'c1', stage: 'prod', kind: 'passed', at: '2026-11-17T04:00:00Z' });
  const m = new Meter([{ meter: 'model tokens', unit: 'token', microCentsPerUnit: 200_000 }, { meter: 'emails', unit: 'email', microCentsPerUnit: 1_000_000 }]);
  m.record({ meter: 'model tokens', units: 1000, feature: 'search', tenant: 't', at: '2026-11-18T00:00:00Z' });
  m.record({ meter: 'model tokens', units: 500, feature: 'summaries', tenant: 't', at: '2026-11-18T00:00:00Z' });
  m.record({ meter: 'emails', units: 50, feature: 'notify', tenant: 't', at: '2026-11-18T00:00:00Z' });
  const at = '2026-11-18T00:00:00Z';
  const d = operationsReport({
    from: FROM, to: TO, feedbackMs: 1000,
    objectives: [{ objective: { name: 'Requests succeed', target: 0.99, windowDays: 7 }, window: { good: 980, total: 1000 } }],
    requests: [...[100, 200, 300, 400, 2500].map((ms) => ({ feature: 'search', ms, status: 200, at })), { feature: 'files', ms: 90, status: 503, at }, { feature: 'files', ms: 80, status: 200, at }, { feature: 'files', ms: 80, status: 200, at: '2026-12-01T00:00:00Z' }],
    incidents: inc.list,
    delivery: p.measures(FROM, TO),
    jobs: [{ id: 'j1', kind: 'email', payload: null, state: 'dead', attempts: 5, maxAttempts: 5, runAt: 0, lastError: 'mail server refused', created: Date.parse(at) }, { id: 'j2', kind: 'email', payload: null, state: 'done', attempts: 1, maxAttempts: 5, runAt: 0, created: Date.parse(at) }],
    reads: [{ who: 'ana', what: 'patient 12', at }, { who: 'ana', what: 'patient 12', at }, { who: 'ben', what: 'payroll', at }],
    costs: { lines: m.bill('2026-11'), budgetCents: 250 },
  });
  assert.deepEqual(d.sections.map((s) => s.heading), ['Availability', 'Response times', 'Errors by feature', 'Incidents', 'Every run', 'Who read what', 'What model calls cost']);
  const s = (h: string) => d.sections.find((x) => x.heading === h)!;
  assert.deepEqual(s('Availability').table!.rows, [['Requests succeed', 99, 98, 0]]);
  assert.deepEqual(s('Availability').findings[0]!.evidence, ['20 failures against 10 allowed over 7 days']);
  assert.deepEqual(s('Response times').table!.rows, [['files', 2, 80, 90, 100], ['search', 5, 300, 2500, 80]]);
  assert.deepEqual(s('Response times').findings, [{ level: 'attention', text: 'search is slower than the feedback budget for one request in twenty.', evidence: ['95th percentile 2500 ms against 1000 ms'] }]);
  assert.deepEqual(s('Errors by feature').table!.rows, [['files', 2, 1, 50], ['search', 5, 0, 0]]);
  assert.deepEqual(s('Incidents').findings.map((f) => f.text), ['Incident 1, "Uploads failing", owes a postmortem.', 'Incident 2, "Slow search", is still investigating.']);
  assert.deepEqual(s('Every run').text, ['1 deploy (0.14 a day); median lead time 4 hours; change failure rate 0%; median time to restore not measured.']);
  assert.deepEqual(s('Every run').table!.rows, [['email', 2, 1, 1, 0]]);
  assert.deepEqual(s('Who read what').table!.rows, [['ana', 'patient 12', 2], ['ben', 'payroll', 1]]);
  assert.deepEqual(s('What model calls cost').table!.rows, [['search', 'model tokens', 1000, 200], ['summaries', 'model tokens', 500, 100]], 'emails are not model calls');
  assert.deepEqual(s('What model calls cost').findings, [{ level: 'attention', text: 'Model calls cost more than their budget.', evidence: ['300 cents against 250'] }]);
  assert.deepEqual(operationsReport({ from: FROM, to: TO }).sections, [], 'nothing measured, nothing shown');
});

test('the improvement brief ranks what to change next by evidence and says why for each', () => {
  const inc = new Incidents(() => new Date('2026-11-18T09:00:00Z'));
  const i1 = inc.open('Uploads failing', 1);
  const r = improvementBrief({
    from: FROM, to: TO, journeys, walks: walks(),
    incidents: [{ feature: 'files', incident: i1 }],
    complaints: [{ feature: 'sharing', title: 'Link expired too early', severity: 'major', count: 2 }, { feature: 'search', title: 'Results are slow', count: 1 }],
    costs: [{ feature: 'summaries', cents: 1300, budgetCents: 1000 }, { feature: 'search', cents: 10, budgetCents: 100 }],
    undesigned: [{ feature: 'files', steps: ['search', 'open folder', 'download all'], count: 24 }, { steps: ['home', 'help'], count: 4 }],
    personas: { expected: ['owner', 'member'], seen: [{ persona: 'owner', people: 60 }, { persona: 'auditor', people: 30 }, { persona: 'student', people: 3 }] },
  });
  assert.deepEqual(r.ranked.map((x) => [x.rank, x.feature, x.change, x.points]), [
    [1, 'files', 'fix', 60],
    [2, null, 'retune people', 32],
    [3, 'summaries', 'cut cost', 30],
    [4, 'sharing', 'fix', 15],
    [5, 'files', 'add journey', 12],
    [6, 'sharing', 'simplify', 7],
    [7, 'search', 'fix', 3],
  ]);
  const files = r.ranked[0]!;
  assert.deepEqual(files.why, ['4 walks of "Upload a file" ended in an error: quota check failed. (20 points)', 'Incident 1, "Uploads failing", severity 1. (40 points)']);
  assert.equal(files.suggestion, 'Write the failing test that shows it, then fix it: the error in "Upload a file"; the cause of "Uploads failing".');
  assert.deepEqual(r.ranked[1]!.why, ['30 of 93 people (32%) are auditor, whom the schematic does not expect. (32 points)'], 'three students are too few to show');
  assert.equal(r.ranked[1]!.suggestion, 'Retune the people the schematic is tuned for to include auditor, or find out why they come.');
  assert.deepEqual(r.ranked[2]!.why, ['It cost 1300 cents against a budget of 1000, 30% over. (30 points)']);
  assert.deepEqual(r.ranked[3]!.why, ['1 walk of "Share a folder" ended in an error: grant store timed out. (5 points)', '2 people reported "Link expired too early" (major). (10 points)']);
  assert.equal(r.ranked[4]!.suggestion, 'Add a journey for what people already do: search → open folder → download all.');
  assert.deepEqual(r.ranked[5]!.why, ['3 people left "Share a folder"; 2 stopped at choose people. (6 points)', '1 walk of "Share a folder" finished over its budget of 5 actions and 3000 ms. (1 points)']);
  assert.equal(r.ranked[5]!.suggestion, 'Take steps out of the step choose people in "Share a folder"; "Share a folder" so it fits its budget.');
  assert.deepEqual(r.ranked[6]!.why, ['1 person reported "Results are slow", not yet triaged. (3 points)']);
  assert.equal(r.omitted, 0);
  const short = improvementBrief({ from: FROM, to: TO, journeys, walks: walks(), limit: 1 });
  assert.equal(short.omitted, 2);
  assert.match(short.doc.sections[0]!.text[0]!, /2 smaller items are not shown\.$/);
  assert.deepEqual(improvementBrief({ from: FROM, to: TO, journeys, walks: [] }).doc.sections[0]!.text, ['The evidence this week suggests no change.']);
});

test('Markdown rendering escapes table cells and shows findings with their evidence', () => {
  const md = markdown({ title: 'T', period: { from: 'a', to: 'b' }, sections: [{ heading: 'H', text: ['Some text.'], table: { columns: ['A', 'B'], rows: [['x|y', null], ['line\nbreak', 3]] }, findings: [{ level: 'action', text: 'Fix it.', evidence: ['e1', 'e2'] }, { level: 'ok', text: 'Fine.', evidence: [] }] }, { heading: 'Empty', text: [], table: { columns: ['A', 'B'], rows: [] }, findings: [] }] });
  assert.equal(md, ['# T', '', 'a to b', '', '## H', '', 'Some text.', '', '| A | B |', '| --- | --- |', '| x\\|y | — |', '| line break | 3 |', '', '- **Action:** Fix it. Evidence: e1; e2.', '- **Fine:** Fine.', '', '## Empty', '', '| A | B |', '| --- | --- |', '| None |  |', ''].join('\n'));
  assert.equal(markdown({ title: 'T', period: { from: 'a', to: 'b' }, sections: [] }), '# T\n\na to b\n\nNothing was measured for this period.\n');
});

test('reports are delivered on schedule through the sender, and a failure is logged without stopping the rest', async () => {
  const sent: { to: readonly string[]; title: string; md: string }[] = [];
  let down = false;
  const pub = new Publisher({ async send(to, title, md) { if (down) throw new Error('mail is down'); sent.push({ to, title, md }); } });
  const now = new Date('2026-11-23T07:00:00Z');
  pub.add('brief', '0 8 * * 1', ['intent-holder@example.org'], () => improvementBrief({ from: FROM, to: TO, journeys, walks: walks() }).doc, now);
  pub.add('ops', '0 6 * * *', ['ops@example.org'], () => operationsReport({ from: FROM, to: TO }), now);
  assert.throws(() => pub.add('ops', '0 6 * * *', ['x'], () => operationsReport({ from: FROM, to: TO }), now), /already scheduled/);
  assert.throws(() => pub.add('lonely', '0 6 * * *', [], () => operationsReport({ from: FROM, to: TO }), now), /needs someone to send it to/);
  assert.throws(() => pub.add('bad', 'every day', ['x'], () => operationsReport({ from: FROM, to: TO }), now), /five fields/);
  assert.equal(await pub.tick(new Date('2026-11-23T07:30:00Z')), 0);
  assert.equal(await pub.tick(new Date('2026-11-23T08:00:00Z')), 1);
  assert.equal(sent[0]!.title, 'Improvement brief');
  assert.match(sent[0]!.md, /^# Improvement brief\n/);
  down = true;
  assert.equal(await pub.tick(new Date('2026-11-24T06:00:00Z')), 1);
  assert.deepEqual(pub.log.map((l) => [l.id, l.ok, l.error ?? null]), [['brief', true, null], ['ops', false, 'mail is down']]);
  assert.equal(pub.scheduled.find((s) => s.id === 'ops')!.next, Date.parse('2026-11-25T06:00:00Z'));
});

test('median and percentile', () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2, 4]), 2.5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([], 50), null);
});

// ---------------------------------------------------------------- mutation night shift: boundaries, orders and wording

const sharing = { id: 'sharing', name: 'Sharing' };
const one = (o: Partial<Walk> & Pick<Walk, 'session'>): Walk => ({ journey: 'share', feature: 'sharing', persona: 'owner', at: '2026-11-18T10:00:00Z', outcome: 'completed', actions: 1, ms: 1, ...o });

test('a feature report reads a period as from (included) to (excluded)', () => {
  const ws = [one({ session: 'before', at: '2026-11-15T23:59:59Z' }), one({ session: 'first', at: FROM }), one({ session: 'inside' }), one({ session: 'last', at: '2026-11-22T23:59:59Z' }), one({ session: 'end', at: TO })];
  const d = featureReport(sharing, journeys, ws, { from: FROM, to: TO, minGroup: 1 });
  assert.deepEqual(d.sections[0]!.table!.rows, [['owner', 3, 3]]);
  assert.deepEqual(d.period, { from: FROM, to: TO });
});

test('a walk is within budget at exactly its action and time budget, and not one over', () => {
  const ws = [one({ session: 'a', actions: 5, ms: 3000 }), one({ session: 'b', actions: 6, ms: 3000 }), one({ session: 'c', actions: 5, ms: 3001 }), one({ session: 'd', actions: 5, ms: 3000, outcome: 'abandoned' })];
  const d = featureReport(sharing, [journeys[0]!], ws, { from: FROM, to: TO, minGroup: 1 });
  assert.deepEqual(d.sections[1]!.table!.rows, [['Share a folder', 4, 3, 1, 25, 3000, 5]]);
});

test('a journey that reaches its target exactly raises no finding, and the target is printed as a percentage', () => {
  const nine = [...Array.from({ length: 9 }, (_, i) => one({ session: `ok${i}` })), one({ session: 'slow', actions: 50 })];
  const d = featureReport(sharing, [journeys[0]!], nine, { from: FROM, to: TO });
  assert.deepEqual(d.sections[1]!.findings, []);
  assert.deepEqual(d.sections[1]!.text, ['A walk counts when it completes within its journey’s action and time budget; the target is 90%.']);
  const half = featureReport(sharing, [journeys[0]!], nine, { from: FROM, to: TO, target: 0.5 });
  assert.deepEqual(half.sections[1]!.text, ['A walk counts when it completes within its journey’s action and time budget; the target is 50%.']);
  const strict = featureReport(sharing, [journeys[0]!], nine, { from: FROM, to: TO, target: 0.95 });
  assert.equal(strict.sections[1]!.findings.length, 1);
});

test('who uses it: the biggest group first, ties by name, and a group of exactly the small-cell size is shown', () => {
  const ws = [
    ...Array.from({ length: 10 }, (_, i) => one({ session: `z${i}`, persona: 'zed' })),
    ...Array.from({ length: 10 }, (_, i) => one({ session: `a${i}`, persona: 'amy' })),
    ...Array.from({ length: 11 }, (_, i) => one({ session: `b${i}`, persona: 'big' })),
    ...Array.from({ length: 9 }, (_, i) => one({ session: `t${i}`, persona: 'tiny' })),
  ];
  const d = featureReport(sharing, journeys, ws, { from: FROM, to: TO });
  assert.deepEqual(d.sections[0], {
    heading: 'Who uses it',
    text: ['40 people used it in this period.', '1 smaller group is not shown, so no one can be picked out.'],
    table: { columns: ['Who', 'People', 'Walks'], rows: [['big', 11, 11], ['amy', 10, 10], ['zed', 10, 10]] },
    findings: [],
  });
});

test('with exactly the small-cell number of people the breakdown is shown but every smaller group is hidden, in the plural', () => {
  const ws = [...Array.from({ length: 3 }, (_, i) => one({ session: `a${i}`, persona: 'amy' })), ...Array.from({ length: 2 }, (_, i) => one({ session: `b${i}`, persona: 'bo' }))];
  const d = featureReport(sharing, journeys, ws, { from: FROM, to: TO, minGroup: 5 });
  assert.deepEqual(d.sections[0], {
    heading: 'Who uses it',
    text: ['5 people used it in this period.', '2 smaller groups are not shown, so no one can be picked out.'],
    table: { columns: ['Who', 'People', 'Walks'], rows: [] },
    findings: [],
  });
  const fewer = featureReport(sharing, journeys, ws, { from: FROM, to: TO, minGroup: 6 });
  assert.deepEqual(fewer.sections[0]!.text, ['Fewer than 6 people used it in this period, so no breakdown is shown.']);
});

test('where people stop: most stops first, ties by name, a missing step named, and a journey the package does not declare shown by its id', () => {
  const stop = (session: string, journey: string, stoppedAt?: string) => one({ session, journey, outcome: 'abandoned', ...(stoppedAt ? { stoppedAt } : {}) });
  const ws = [stop('1', 'share', 'b'), stop('2', 'share', 'a'), stop('3', 'share', 'z'), stop('4', 'share', 'z'), stop('5', 'share'), stop('6', 'ghost', 'lost')];
  const d = featureReport(sharing, journeys, ws, { from: FROM, to: TO });
  const sec = d.sections[2]!;
  assert.deepEqual(sec, {
    heading: 'Where people stop',
    text: ['6 walks ended before the goal.'],
    table: { columns: ['Journey', 'Step', 'Stopped'], rows: [['Share a folder', 'z', 2], ['ghost', 'lost', 1], ['Share a folder', 'a', 1], ['Share a folder', 'b', 1], ['Share a folder', 'unknown step', 1]] },
    findings: [{ level: 'attention', text: 'Most people who leave "Share a folder" stop at z.', evidence: ['2 of 6 abandoned walks'] }],
  });
  const lone = featureReport(sharing, journeys, [stop('1', 'ghost', 'lost')], { from: FROM, to: TO });
  assert.deepEqual(lone.sections[2]!.text, ['1 walk ended before the goal.']);
  assert.equal(lone.sections[2]!.findings[0]!.text, 'Most people who leave "ghost" stop at lost.');
});

test('refusals and errors: at most three distinct messages are listed, and an error with no message says so', () => {
  const err = (session: string, error?: string) => one({ session, outcome: 'error', ...(error ? { error } : {}) });
  const d = featureReport(sharing, [journeys[0]!], [err('1'), err('2', 'm1'), err('3', 'm2'), err('4', 'm3'), err('5', 'm4'), one({ session: '6', outcome: 'refused' })], { from: FROM, to: TO });
  assert.deepEqual(d.sections[3], {
    heading: 'Refusals and errors',
    text: ['A refusal is the app saying no as designed; an error is the app failing.'],
    table: { columns: ['Journey', 'Refused', 'Errors'], rows: [['Share a folder', 1, 5]] },
    findings: [{ level: 'action', text: '5 walks of "Share a folder" ended in an error.', evidence: ['no message recorded', 'm1', 'm2'] }],
  });
});

test('the journeys section as a whole: the table, the nobody-walked finding and the over-budget finding', () => {
  const d = featureReport({ id: 'files', name: 'Files' }, [journeys[2]!, { id: 'rename', feature: 'files', goal: 'Rename a file', persona: 'member', budget: { actions: 2, ms: 1000 } }], [one({ session: 'x', journey: 'upload', feature: 'files', actions: 1 })], { from: FROM, to: TO });
  assert.deepEqual(d.sections[1], {
    heading: 'Whether its journeys complete within budget',
    text: ['A walk counts when it completes within its journey’s action and time budget; the target is 90%.'],
    table: { columns: ['Journey', 'Walks', 'Completed', 'Within budget', 'Within budget (%)', 'Median ms', 'Median actions'], rows: [['Upload a file', 1, 1, 1, 100, 1, 1], ['Rename a file', 0, 0, 0, null, null, null]] },
    findings: [{ level: 'attention', text: 'Nobody walked "Rename a file" in this period.', evidence: [] }],
  });
});

test('median and percentile are exact at their edges', () => {
  assert.equal(percentile([1, 2, 3], 150), 3, 'a percentile past 100 is the largest value');
  assert.equal(percentile([1, 2, 3], 0), 1);
  assert.equal(percentile([5], 95), 5);
  assert.equal(median([9]), 9);
  assert.equal(median([5, 1, 9]), 5);
});

test('operations: availability against each objective, exactly spent is not overspent, and nothing allowed is not a percentage', () => {
  const d = operationsReport({
    from: FROM, to: TO,
    objectives: [
      { objective: { name: 'Spent', target: 0.99, windowDays: 7 }, window: { good: 980, total: 1000 } },
      { objective: { name: 'Half', target: 0.5, windowDays: 30 }, window: { good: 50, total: 100 } },
      { objective: { name: 'Roomy', target: 0.5, windowDays: 30 }, window: { good: 75, total: 100 } },
      { objective: { name: 'Perfect', target: 1, windowDays: 7 }, window: { good: 10, total: 10 } },
      { objective: { name: 'Quiet', target: 0.9, windowDays: 7 }, window: { good: 0, total: 0 } },
    ],
  });
  assert.deepEqual(d, {
    title: 'Operations',
    period: { from: FROM, to: TO },
    sections: [{
      heading: 'Availability',
      text: [],
      table: { columns: ['Objective', 'Target (%)', 'Achieved (%)', 'Budget left (%)'], rows: [['Spent', 99, 98, 0], ['Half', 50, 50, 0], ['Roomy', 50, 75, 50], ['Perfect', 100, 100, null], ['Quiet', 90, null, null]] },
      findings: [{ level: 'action', text: 'Spent spent its error budget.', evidence: ['20 failures against 10 allowed over 7 days'] }],
    }],
  });
});

test('operations: response times default to a one second feedback budget, and a 95th percentile equal to it is fine', () => {
  const at = '2026-11-18T00:00:00Z';
  const d = operationsReport({ from: FROM, to: TO, requests: [{ feature: 'edge', ms: 1000, status: 200, at }, { feature: 'late', ms: 1001, status: 200, at }] });
  assert.deepEqual(d.sections[0], {
    heading: 'Response times',
    text: ['The feedback budget is 1000 ms.'],
    table: { columns: ['Feature', 'Requests', 'Median ms', '95th percentile ms', 'Within budget (%)'], rows: [['edge', 1, 1000, 1000, 100], ['late', 1, 1001, 1001, 0]] },
    findings: [{ level: 'attention', text: 'late is slower than the feedback budget for one request in twenty.', evidence: ['95th percentile 1001 ms against 1000 ms'] }],
  });
});

test('operations: requests count from the start of the period up to, not including, its end', () => {
  const r = (at: string) => ({ feature: 'f', ms: 5, status: 200, at });
  const d = operationsReport({ from: FROM, to: TO, requests: [r('2026-11-15T23:59:59Z'), r(FROM), r('2026-11-22T23:59:59Z'), r(TO)] });
  assert.deepEqual(d.sections[0]!.table!.rows, [['f', 2, 5, 5, 100]]);
});

test('operations: errors by feature count status 500 and up, worst first, ties by name, and say what failed', () => {
  const at = '2026-11-18T00:00:00Z';
  const q = (feature: string, status: number) => ({ feature, ms: 100, status, at });
  const d = operationsReport({ from: FROM, to: TO, requests: [q('a0', 200), q('b1', 500), q('b1', 200), q('c1', 503), q('c1', 200), q('c1', 200), q('c1', 499), q('d2', 500), q('d2', 599)] });
  assert.deepEqual(d.sections[1], {
    heading: 'Errors by feature',
    text: [],
    table: { columns: ['Feature', 'Requests', 'Errors', 'Error rate (%)'], rows: [['d2', 2, 2, 100], ['b1', 2, 1, 50], ['c1', 4, 1, 25], ['a0', 1, 0, 0]] },
    findings: [
      { level: 'action', text: 'b1 failed 1 request.', evidence: ['50% of 2 requests answered 500 or above'] },
      { level: 'action', text: 'c1 failed 1 request.', evidence: ['25% of 4 requests answered 500 or above'] },
      { level: 'action', text: 'd2 failed 2 requests.', evidence: ['100% of 2 requests answered 500 or above'] },
    ],
  });
});

const incident = (id: number, title: string, severity: 1 | 2 | 3, status: Incident['status'], started: string, resolved?: string, postmortem?: Incident['postmortem']): Incident => ({ id, title, severity, status, started, ...(resolved ? { resolved } : {}), ...(postmortem ? { postmortem } : {}), timeline: [] });

test('operations: incidents in the period or still open, what each owes, and the minutes it took', () => {
  const pm = { cause: 'c', impact: 'i', detection: 'd', actions: [] };
  const d = operationsReport({
    from: FROM, to: TO,
    incidents: [
      incident(1, 'Old and done', 1, 'resolved', '2026-10-01T00:00:00Z', '2026-10-01T01:00:00Z'),
      incident(2, 'Old and open', 3, 'monitoring', '2026-10-01T00:00:00Z'),
      incident(3, 'Big', 2, 'resolved', '2026-11-17T00:00:00Z', '2026-11-17T01:30:00Z'),
      incident(4, 'Small', 3, 'resolved', FROM, '2026-11-16T00:02:30Z'),
      incident(5, 'Done right', 1, 'resolved', '2026-11-18T00:00:00Z', '2026-11-18T00:10:00Z', pm),
      incident(6, 'Too late', 1, 'resolved', TO, '2026-11-23T01:00:00Z'),
    ],
  });
  assert.deepEqual(d.sections, [{
    heading: 'Incidents',
    text: ['4 incidents in this period or still open.'],
    table: { columns: ['Incident', 'Title', 'Severity', 'Status', 'Minutes to resolve'], rows: [[2, 'Old and open', 3, 'monitoring', null], [3, 'Big', 2, 'resolved', 90], [4, 'Small', 3, 'resolved', 3], [5, 'Done right', 1, 'resolved', 10]] },
    findings: [
      { level: 'action', text: 'Incident 2, "Old and open", is still monitoring.', evidence: ['opened 2026-10-01T00:00:00Z'] },
      { level: 'attention', text: 'Incident 3, "Big", owes a postmortem.', evidence: ['severity 2, resolved 2026-11-17T01:30:00Z'] },
    ],
  }]);
  assert.deepEqual(operationsReport({ from: FROM, to: TO, incidents: [] }).sections, [{ heading: 'Incidents', text: ['No incidents.'], table: { columns: ['Incident', 'Title', 'Severity', 'Status', 'Minutes to resolve'], rows: [] }, findings: [] }]);
  assert.equal(operationsReport({ from: FROM, to: TO, incidents: [incident(1, 'One', 3, 'resolved', FROM, FROM)] }).sections[0]!.text[0], '1 incident in this period or still open.');
});

test('operations: every run reports deploys and jobs separately or together, and which kinds gave up and why', () => {
  const at = Date.parse('2026-11-18T00:00:00Z');
  const job = (id: string, kind: string, state: 'waiting' | 'running' | 'done' | 'dead' | 'cancelled', extra: { lastError?: string; created?: number } = {}) => ({ id, kind, payload: null, state, attempts: 1, maxAttempts: 5, runAt: 0, created: extra.created ?? at, ...(extra.lastError ? { lastError: extra.lastError } : {}) });
  const delivery = { deploys: 2, perDay: 0.29, leadTimeHoursMedian: 3, changeFailureRate: 0.25, restoreHoursMedian: 1 };
  const jobs = [job('1', 'email', 'dead', { lastError: 'boom' }), job('2', 'email', 'dead', { lastError: 'boom' }), job('3', 'email', 'dead'), job('4', 'backup', 'dead', { lastError: 'disk' }), job('5', 'backup', 'done'), job('6', 'backup', 'running'), job('7', 'backup', 'waiting'), job('8', 'backup', 'cancelled'), job('9', 'email', 'done', { created: Date.parse(TO) }), job('10', 'email', 'done', { created: Date.parse(FROM) - 1 })];
  const both = operationsReport({ from: FROM, to: TO, delivery, jobs });
  assert.deepEqual(both.sections, [{
    heading: 'Every run',
    text: ['2 deploys (0.29 a day); median lead time 3 hours; change failure rate 25%; median time to restore 1 hours.'],
    table: { columns: ['Job', 'Runs', 'Done', 'Gave up', 'Waiting'], rows: [['backup', 5, 1, 1, 2], ['email', 3, 0, 3, 0]] },
    findings: [
      { level: 'action', text: '1 backup job gave up.', evidence: ['disk'] },
      { level: 'action', text: '3 email jobs gave up.', evidence: ['boom', 'no message recorded'] },
    ],
  }]);
  const onlyJobs = operationsReport({ from: FROM, to: TO, jobs: [job('1', 'email', 'done')] });
  assert.deepEqual(onlyJobs.sections[0]!.text, []);
  assert.deepEqual(onlyJobs.sections[0]!.table!.rows, [['email', 1, 1, 0, 0]]);
  const onlyDelivery = operationsReport({ from: FROM, to: TO, delivery: { deploys: 0, perDay: 0, leadTimeHoursMedian: null, changeFailureRate: null, restoreHoursMedian: null } });
  assert.deepEqual(onlyDelivery.sections, [{ heading: 'Every run', text: ['0 deploys (0 a day); median lead time not measured; change failure rate not measured; median time to restore not measured.'], findings: [] }]);
  assert.match(operationsReport({ from: FROM, to: TO, delivery: { ...delivery, changeFailureRate: 0 } }).sections[0]!.text[0]!, /change failure rate 0%;/);
});

test('operations: who read what is limited to the period, sorted by person then record, and says so when nobody did', () => {
  const r = (who: string, what: string, at = '2026-11-18T00:00:00Z') => ({ who, what, at });
  const d = operationsReport({ from: FROM, to: TO, reads: [r('ben', 'payroll'), r('ana', 'z'), r('ana', 'a'), r('ana', 'a', TO), r('ana', 'a', '2026-11-15T00:00:00Z')] });
  assert.deepEqual(d.sections, [{
    heading: 'Who read what',
    text: ['3 sensitive reads recorded.'],
    table: { columns: ['Who', 'What', 'Reads'], rows: [['ana', 'a', 1], ['ana', 'z', 1], ['ben', 'payroll', 1]] },
    findings: [],
  }]);
  assert.deepEqual(operationsReport({ from: FROM, to: TO, reads: [] }).sections, [{ heading: 'Who read what', text: ['No sensitive reads were recorded.'], table: { columns: ['Who', 'What', 'Reads'], rows: [] }, findings: [] }]);
  assert.equal(operationsReport({ from: FROM, to: TO, reads: [r('ana', 'a')] }).sections[0]!.text[0], '1 sensitive read recorded.');
});

test('operations: model cost lists the costliest first, ties by feature, and flags only a total over its budget', () => {
  const line = (feature: string, cents: number, meter = 'model tokens') => ({ meter, feature, units: 1, cents });
  const lines = [line('b', 5), line('a', 5), line('c', 9), line('mail', 100, 'emails'), line('d', 0.1), line('e', 0.2)];
  const d = operationsReport({ from: FROM, to: TO, costs: { lines } });
  assert.deepEqual(d.sections, [{
    heading: 'What model calls cost',
    text: ['19.3 cents in this period.'],
    table: { columns: ['Feature', 'Meter', 'Units', 'Cents'], rows: [['c', 'model tokens', 1, 9], ['a', 'model tokens', 1, 5], ['b', 'model tokens', 1, 5], ['e', 'model tokens', 1, 0.2], ['d', 'model tokens', 1, 0.1]] },
    findings: [],
  }]);
  assert.deepEqual(operationsReport({ from: FROM, to: TO, costs: { lines, budgetCents: 19.3 } }).sections[0]!.findings, [], 'exactly the budget is within it');
  assert.deepEqual(operationsReport({ from: FROM, to: TO, costs: { lines, budgetCents: 25 } }).sections[0]!.findings, [], 'under budget');
  assert.deepEqual(operationsReport({ from: FROM, to: TO, costs: { lines, budgetCents: 19 } }).sections[0]!.findings, [{ level: 'attention', text: 'Model calls cost more than their budget.', evidence: ['19.3 cents against 19'] }]);
  assert.deepEqual(operationsReport({ from: FROM, to: TO, costs: { lines, modelMeters: /emails/ } }).sections[0]!.table!.rows, [['mail', 'emails', 1, 100]]);
});

test('the improvement brief, whole: ranks, ties, wording, levels and evidence', () => {
  const walksIn = [one({ session: '1', outcome: 'abandoned' }), one({ session: '2', outcome: 'error', at: '2026-11-30T00:00:00Z', error: 'late news' }), one({ session: '3', outcome: 'error' })];
  const r = improvementBrief({
    from: FROM, to: TO, journeys: [journeys[0]!], walks: walksIn,
    complaints: [{ feature: 'a', title: 'T', severity: 'blocker', count: 1 }],
    personas: { expected: ['owner'], seen: [{ persona: 'owner', people: 90 }, { persona: 'guest', people: 10 }] },
  });
  assert.deepEqual(r.ranked.map((x) => [x.rank, x.feature, x.change, x.points]), [[1, null, 'retune people', 10], [2, 'a', 'fix', 10], [3, 'sharing', 'fix', 5], [4, 'sharing', 'simplify', 2]]);
  assert.deepEqual(r.ranked[2]!.why, ['1 walk of "Share a folder" ended in an error. (5 points)']);
  assert.equal(r.ranked[3]!.suggestion, 'Take steps out of the step an unknown step in "Share a folder".');
  assert.deepEqual(r.ranked[3]!.why, ['1 person left "Share a folder"; 1 stopped at an unknown step. (2 points)']);
  assert.deepEqual(r.doc, {
    title: 'Improvement brief',
    period: { from: FROM, to: TO },
    sections: [{
      heading: 'What to change next',
      text: ['Ranked by evidence: failed walks, incidents, complaints, people leaving, budgets and cost, walks nobody designed, and people the schematic did not expect.'],
      table: { columns: ['Rank', 'Feature', 'Change', 'Points'], rows: [[1, 'Whole app', 'retune people', 10], [2, 'a', 'fix', 10], [3, 'sharing', 'fix', 5], [4, 'sharing', 'simplify', 2]] },
      findings: [
        { level: 'attention', text: '1. Retune the people the schematic is tuned for to include guest, or find out why they come.', evidence: ['10 of 100 people (10%) are guest, whom the schematic does not expect. (10 points)'] },
        { level: 'action', text: '2. a: Write the failing test that shows it, then fix it: "T".', evidence: ['1 person reported "T" (blocker). (10 points)'] },
        { level: 'action', text: '3. sharing: Write the failing test that shows it, then fix it: the error in "Share a folder".', evidence: ['1 walk of "Share a folder" ended in an error. (5 points)'] },
        { level: 'attention', text: '4. sharing: Take steps out of the step an unknown step in "Share a folder".', evidence: ['1 person left "Share a folder"; 1 stopped at an unknown step. (2 points)'] },
      ],
    }],
  });
  const cut = improvementBrief({ from: FROM, to: TO, journeys: [journeys[0]!], walks: walksIn, complaints: [{ feature: 'a', title: 'T', severity: 'blocker', count: 1 }], personas: { expected: ['owner'], seen: [{ persona: 'owner', people: 90 }, { persona: 'guest', people: 10 }] }, limit: 3 });
  assert.equal(cut.ranked.length, 3);
  assert.equal(cut.omitted, 1);
  assert.match(cut.doc.sections[0]!.text[0]!, /did not expect\. 1 smaller item is not shown\.$/);
});

test('the improvement brief: nothing counts for nothing, and every threshold is at its exact value', () => {
  const none = improvementBrief({
    from: FROM, to: TO, journeys: [], walks: [],
    complaints: [{ feature: 'x', title: 'Nothing', severity: 'major', count: 0 }],
    costs: [{ feature: 'x', cents: 100, budgetCents: 100 }],
    undesigned: [{ steps: ['a'], count: 1 }],
    personas: { expected: [], seen: [] },
    minGroup: 1,
  });
  assert.deepEqual(none.ranked, []);
  assert.deepEqual(none.doc.sections[0], { heading: 'What to change next', text: ['The evidence this week suggests no change.'], table: { columns: ['Rank', 'Feature', 'Change', 'Points'], rows: [] }, findings: [] });
  const edge = improvementBrief({
    from: FROM, to: TO, journeys: [], walks: [],
    costs: [{ feature: 'cheap', cents: 101, budgetCents: 100 }, { feature: 'zero', cents: 5, budgetCents: 0 }],
    undesigned: [{ feature: 'f', steps: ['x', 'y'], count: 10 }, { feature: 'g', steps: ['p'], count: 9 }],
    personas: { expected: ['owner'], seen: [{ persona: 'owner', people: 70 }, { persona: 'ten', people: 10 }, { persona: 'nine', people: 9 }] },
  });
  assert.deepEqual(edge.ranked.map((x) => [x.feature, x.change, x.points, x.suggestion]), [
    [null, 'retune people', 11, 'Retune the people the schematic is tuned for to include ten, or find out why they come.'],
    ['f', 'add journey', 5, 'Add a journey for what people already do: x → y.'],
    ['cheap', 'cut cost', 1, 'Cut what it spends, or raise its budget on purpose.'],
    ['zero', 'cut cost', 1, 'Cut what it spends, or raise its budget on purpose.'],
  ]);
  assert.deepEqual(edge.ranked[1]!.why, ['10 walks went x → y, and no journey describes it. (5 points)']);
  assert.deepEqual(edge.ranked[2]!.why, ['It cost 101 cents against a budget of 100, 1% over. (1 points)']);
  assert.deepEqual(edge.ranked[3]!.why, ['It cost 5 cents against a budget of 0, 0% over. (1 points)']);
});

test('the improvement brief: equal points go to the feature that sorts first (the whole app first), then to the change that sorts first', () => {
  const jr: Journey[] = [{ id: 'ja', feature: 'a', goal: 'Do A', persona: 'o', budget: { actions: 5, ms: 3000 } }];
  const left = Array.from({ length: 5 }, (_, i) => one({ session: `l${i}`, journey: 'ja', feature: 'a', outcome: 'abandoned', stoppedAt: 's' }));
  const r = improvementBrief({
    from: FROM, to: TO, journeys: jr, walks: left,
    complaints: [{ feature: 'z', title: 'U', severity: 'blocker', count: 1 }, { feature: 'a', title: 'T', severity: 'blocker', count: 1 }, { feature: 'z', title: 'V', count: 1 }],
    personas: { expected: ['owner'], seen: [{ persona: 'owner', people: 90 }, { persona: 'guest', people: 10 }] },
    undesigned: [{ feature: 'z', steps: ['q'], count: 20 }],
  });
  assert.deepEqual(r.ranked.map((x) => [x.feature, x.change, x.points]), [['z', 'fix', 13], [null, 'retune people', 10], ['a', 'fix', 10], ['a', 'simplify', 10], ['z', 'add journey', 10]]);
});

test('the improvement brief: journeys are weighed per walk, the commonest stopping step is named, ties by name', () => {
  const stop = (session: string, journey: string, stoppedAt: string) => one({ session, journey, outcome: 'abandoned', stoppedAt });
  const two: Journey[] = [journeys[0]!, { id: 'other', feature: 'other', goal: 'Do another thing', persona: 'owner', budget: { actions: 5, ms: 3000 } }];
  const r = improvementBrief({ from: FROM, to: TO, journeys: two, walks: [stop('1', 'share', 'zz'), stop('2', 'share', 'yy'), stop('3', 'share', 'yy'), stop('4', 'other', 'b'), stop('5', 'other', 'a'), one({ session: '6', actions: 99 }), one({ session: '7', actions: 99 })] });
  assert.deepEqual(r.ranked.map((x) => [x.feature, x.change, x.points]), [['sharing', 'simplify', 8], ['other', 'simplify', 4]]);
  assert.deepEqual(r.ranked[0]!.why, ['3 people left "Share a folder"; 2 stopped at yy. (6 points)', '2 walks of "Share a folder" finished over its budget of 5 actions and 3000 ms. (2 points)']);
  assert.deepEqual(r.ranked[1]!.why, ['2 people left "Do another thing"; 1 stopped at a. (4 points)']);
});

test('the improvement brief: incidents count only inside the period, and weigh by severity', () => {
  const inc = (id: number, severity: 1 | 2 | 3, started: string) => ({ feature: 'f', incident: incident(id, `I${id}`, severity, 'resolved', started, started) });
  const r = improvementBrief({ from: FROM, to: TO, journeys: [], walks: [], incidents: [inc(1, 1, FROM), inc(2, 2, '2026-11-17T00:00:00Z'), inc(3, 3, TO), inc(4, 3, '2026-11-15T00:00:00Z')] });
  assert.deepEqual(r.ranked.map((x) => [x.points, x.why]), [[60, ['Incident 1, "I1", severity 1. (40 points)', 'Incident 2, "I2", severity 2. (20 points)']]]);
  assert.equal(r.ranked[0]!.suggestion, 'Write the failing test that shows it, then fix it: the cause of "I1"; the cause of "I2".');
});

test('the improvement brief multiplies each count by its weight in POINTS', () => {
  const w = POINTS as unknown as Record<string, number>;
  const saved = { ...POINTS };
  try {
    Object.assign(w, { error: 7, abandoned: 11, overBudget: 13, costPercent: 17, undesignedPair: 19, personaPercent: 23 });
    const jw: Journey[] = ['share', 'other', 'third'].map((id) => ({ id, feature: id, goal: id, persona: 'o', budget: { actions: 5, ms: 3000 } }));
    const walksW = [one({ session: '1', outcome: 'error', feature: 'share' }), one({ session: '2', journey: 'other', feature: 'other', outcome: 'abandoned', stoppedAt: 's' }), one({ session: '3', journey: 'third', feature: 'third', actions: 99 })];
    const rw = improvementBrief({ from: FROM, to: TO, journeys: jw, walks: walksW, costs: [{ feature: 'money', cents: 150, budgetCents: 100 }], undesigned: [{ feature: 'ud', steps: ['a'], count: 25 }], personas: { expected: ['owner'], seen: [{ persona: 'guest', people: 20 }, { persona: 'owner', people: 80 }] }, minGroup: 5 });
    assert.deepEqual(Object.fromEntries(rw.ranked.map((x) => [`${x.feature}/${x.change}`, x.points])), { 'share/fix': 7, 'other/simplify': 11, 'third/simplify': 13, 'money/cut cost': 50 * 17, 'ud/add journey': 12 * 19, 'null/retune people': 20 * 23 });
  } finally {
    Object.assign(w, saved);
  }
});

test('Markdown: backslashes are escaped, attention is labelled, a section may have no table, and a finding never ends in two full stops', () => {
  const md = markdown({ title: 'T', period: { from: 'a', to: 'b' }, sections: [{ heading: 'H', text: [], table: { columns: ['A\\B'], rows: [['x\\|y']] }, findings: [{ level: 'attention', text: 'Look.', evidence: ['it ends here.'] }] }, { heading: 'No table', text: ['Just words.'], findings: [] }] });
  assert.equal(md, ['# T', '', 'a to b', '', '## H', '', '| A\\\\B |', '| --- |', '| x\\\\\\|y |', '', '- **Attention:** Look. Evidence: it ends here.', '', '## No table', '', 'Just words.', ''].join('\n'));
});

test('where people stop: when nobody left, the section says so and has no finding and no table', () => {
  const d = featureReport(sharing, journeys, [one({ session: '1' })], { from: FROM, to: TO });
  assert.deepEqual(d.sections[2], { heading: 'Where people stop', text: ['Nobody left a journey before the goal.'], findings: [] });
});

test('operations: a kind of job that never gave up raises no finding', () => {
  const at = Date.parse('2026-11-18T00:00:00Z');
  const job = (id: string, kind: string, state: 'done' | 'dead') => ({ id, kind, payload: null, state, attempts: 1, maxAttempts: 5, runAt: 0, created: at });
  const d = operationsReport({ from: FROM, to: TO, jobs: [job('1', 'cleanup', 'done'), job('2', 'email', 'dead')] });
  assert.deepEqual(d.sections[0]!.table!.rows, [['cleanup', 1, 1, 0, 0], ['email', 1, 0, 1, 0]]);
  assert.deepEqual(d.sections[0]!.findings, [{ level: 'action', text: '1 email job gave up.', evidence: ['no message recorded'] }]);
});

test('the improvement brief: two items for the whole app with equal points are ordered by the change that sorts first', () => {
  const r = improvementBrief({ from: FROM, to: TO, journeys: [], walks: [], undesigned: [{ steps: ['q'], count: 20 }], personas: { expected: ['owner'], seen: [{ persona: 'owner', people: 90 }, { persona: 'guest', people: 10 }] } });
  assert.deepEqual(r.ranked.map((x) => [x.feature, x.change, x.points]), [[null, 'add journey', 10], [null, 'retune people', 10]]);
});
