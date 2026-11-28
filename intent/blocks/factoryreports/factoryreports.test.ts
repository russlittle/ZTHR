import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Publisher, featureReport, improvementBrief, markdown, median, operationsReport, percentile, type Doc, type Journey, type Walk } from './index.ts';
import { Incidents } from '../slo/index.ts';
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
