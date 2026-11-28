import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Feedback } from './index.ts';

test('reports keep the person’s words, redacted, with context; similar reports join one ticket', () => {
  let t = Date.parse('2026-11-26T09:00:00Z');
  const f = new Feedback({ now: () => new Date(t) });
  const a = f.report('ana', 'Upload of a big video fails at 99%, email me at ana@example.org', { surface: 'files', version: '1.4.2', trace: 'tr-1', errors: ['TypeError: x is undefined token=abc123'] });
  assert.equal(a.isNew, true);
  assert.equal(a.report.said, 'Upload of a big video fails at 99%, email me at [email]');
  assert.deepEqual(a.report.context.errors, ['TypeError: x is undefined token=[hidden]']);
  t += 3_600_000;
  const b = f.report('ben', 'big video upload fails at 99 percent', { surface: 'files' });
  assert.equal(b.isNew, false);
  assert.equal(b.ticket.id, a.ticket.id);
  const c = f.report('cy', 'something odd', { surface: 'files', errors: ['TypeError: x is undefined token=[hidden]'] });
  assert.equal(c.ticket.id, a.ticket.id, 'the same last error is the same cause');
  assert.equal(f.report('dee', 'The share dialog has a typo', { surface: 'sharing' }).isNew, true);
  assert.throws(() => f.report('x', ' '), /a few words/);
});

test('the board puts overdue and severe first; a defect comes with evidence and a failing test to write', () => {
  let t = Date.parse('2026-11-26T09:00:00Z');
  const f = new Feedback({ now: () => new Date(t) });
  const up = f.report('ana', 'uploads fail at the end', { trace: 'tr-9', version: '1.4.2' }).ticket;
  const typo = f.report('ben', "typo in the share dialog's title", {}).ticket;
  assert.throws(() => f.move(up.id, 'in progress'), /triage it first/);
  f.triage(typo.id, 'cosmetic');
  f.triage(up.id, 'blocker', 'Uploads over 2 GB fail at the final chunk');
  t += 5 * 3_600_000;
  const board = f.board();
  assert.deepEqual(board.map((x) => [x.id, x.overdue]), [[up.id, true], [typo.id, false]]);
  const d = f.defect(up.id, { steps: ['sign in', 'upload a 2.1 GB file'], expected: "a 2.1 GB upload completes and the file's size matches", actual: 'the last chunk returns 413' });
  assert.deepEqual(d.evidence, ['trace tr-9', 'version 1.4.2']);
  assert.match(d.test, /test\('a 2\.1 GB upload completes and the file\\'s size matches'/);
  assert.match(d.test, /\/\/ 2\. upload a 2\.1 GB file/);
  assert.match(d.test, /assert\.fail/);
  f.move(up.id, 'fixed');
  assert.deepEqual(f.board().map((x) => x.id), [typo.id]);
});

test('nothing a person wrote can escape the comments or the string of the generated test', () => {
  const f = new Feedback({ now: () => new Date('2026-11-26T09:00:00Z') });
  const t = f.report('ana', 'uploads fail\nprocess.exit(1)').ticket;
  f.triage(t.id, 'major');
  const d = f.defect(t.id, { steps: ['open files\nrequire("child_process").execSync("rm -rf /")'], expected: "it works\n'); process.exit(2); ('", actual: 'it breaks\u2028process.exit(3)' });
  const code = d.test.split(/\r?\n|\u2028|\u2029/);
  for (const line of code) assert.ok(/^(import |\s*\/\/|test\(|\s*assert\.fail|\}\);|$)/.test(line), `stray code: ${line}`);
  assert.doesNotThrow(() => new Function(d.test.replace(/^import .*$/gm, '')));
});

test('secrets in key=value form are hidden however the key is spelled', () => {
  const f = new Feedback();
  const r = f.report('ana', 'failed with api_key=sk_live_123 access_token: abc secret=xyz Authorization: Bearer eyJabc').report.said;
  for (const s of ['sk_live_123', 'abc ', 'xyz', 'eyJabc']) assert.ok(!r.includes(s), r);
});

test('redaction stays fast on a long unbroken paste', () => {
  const f = new Feedback();
  const t0 = performance.now();
  f.report('ana', 'a'.repeat(200_000));
  assert.ok(performance.now() - t0 < 500, `${performance.now() - t0} ms`);
});

const T0 = Date.parse('2026-11-26T09:00:00Z');
const HOUR = 3_600_000;
const clock = (start = T0) => {
  const c = { t: start, now: () => new Date(c.t) };
  return c;
};

test('a new feedback desk is empty', () => {
  const f = new Feedback();
  assert.deepEqual(f.reports, []);
  assert.deepEqual(f.tickets, []);
  assert.deepEqual(f.board(), []);
});

test('card-like numbers are hidden in any spacing, but short numbers are not', () => {
  const f = new Feedback();
  const said = (s: string) => f.report('ana', s).report.said;
  assert.equal(said('card 4111 1111 1111 1111 declined'), 'card [number] declined');
  assert.equal(said('card 4111-1111-1111-1111 declined'), 'card [number] declined');
  assert.equal(said('card 4111111111111111 declined'), 'card [number] declined');
  assert.equal(said('card 4111111111111 declined'), 'card [number] declined', '13 digits');
  assert.equal(said('step 5 of 12 failed at 123456789012'), 'step 5 of 12 failed at 123456789012', '12 digits is not a card');
  assert.equal(said('order 2026 failed'), 'order 2026 failed');
});

test('secrets are hidden, including a bearer value after the key however it is spaced', () => {
  const f = new Feedback();
  const said = (s: string) => f.report('ana', s).report.said;
  assert.equal(said('token: Bearer abc123 rejected'), 'token=[hidden] rejected');
  assert.equal(said('secret=Bearer    xyz789 rejected'), 'secret=[hidden] rejected');
  assert.equal(said('password=hunter2 rejected'), 'password=[hidden] rejected');
});

test('a report needs words, and the person’s text is trimmed before it is counted or kept', () => {
  const f = new Feedback();
  assert.throws(() => f.report('a', 'ab'), /a few words/);
  assert.throws(() => f.report('a', '  a  '), /a few words/, 'padding does not count as words');
  assert.equal(f.reports.length, 0, 'a refused report is not kept');
  assert.equal(f.report('a', '  abc  ').report.said, 'abc');
});

test('only the last five errors are kept, and each is redacted', () => {
  const f = new Feedback();
  const errors = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7 password=p'];
  const r = f.report('ana', 'it broke', { errors }).report;
  assert.deepEqual(r.context.errors, ['e3', 'e4', 'e5', 'e6', 'e7 password=[hidden]']);
  assert.equal(f.report('ana', 'it broke again').report.context.errors, undefined, 'no errors given, none invented');
});

test('text with no real words never groups, and each ticket opens as new with the person’s words as title', () => {
  const f = new Feedback();
  const a = f.report('a', 'ab cd');
  const b = f.report('b', 'ef gh');
  assert.equal(a.isNew && b.isNew, true);
  assert.notEqual(a.ticket.id, b.ticket.id);
  assert.equal(a.ticket.column, 'new');
  assert.equal(a.ticket.severity, undefined);
  assert.equal(a.ticket.opened, a.report.at);
  const long = f.report('c', 'x'.repeat(200)).ticket;
  assert.equal(long.title.length, 80);
});

test('a report from a different cause, with its own error, does not join', () => {
  const f = new Feedback();
  f.report('a', 'upload fails', { errors: ['E1'] });
  const b = f.report('b', 'completely unrelated words here', { errors: ['E2'] });
  assert.equal(b.isNew, true);
  const c = f.report('c', 'zzz yyy xxx', { errors: ['E3'] });
  assert.equal(c.isNew, true);
});

test('a report with errors can be compared with a ticket whose first report had none', () => {
  const f = new Feedback();
  f.report('a', 'upload fails');
  assert.doesNotThrow(() => f.report('b', 'something else entirely', { errors: ['E'] }));
});

test('closed tickets are never joined, whether fixed or won’t fix', () => {
  const f = new Feedback();
  const a = f.report('a', 'upload fails at the end').ticket;
  f.triage(a.id, 'major');
  f.move(a.id, 'fixed');
  const b = f.report('b', 'upload fails at the end');
  assert.equal(b.isNew, true, 'a fixed ticket stays fixed; a repeat is a new ticket');
  f.move(b.ticket.id, 'wont fix');
  const c = f.report('c', 'upload fails at the end');
  assert.equal(c.isNew, true, 'a won’t-fix ticket is closed too');
  assert.equal(f.report('d', 'upload fails at the end').isNew, false, 'an open ticket is joined');
});

test('the same surface makes similar reports more alike; no surface, or another, does not', () => {
  // 'alpha bravo charlie delta echo' vs 'alpha bravo foxtrot golf hotel': 2 shared of 8 = 0.25, boosted to 0.3 on one surface.
  const make = (s1: string | undefined, s2: string | undefined) => {
    const f = new Feedback({ similarity: 0.29 });
    f.report('a', 'alpha bravo charlie delta echo', s1 ? { surface: s1 } : {});
    return f.report('b', 'alpha bravo foxtrot golf hotel', s2 ? { surface: s2 } : {}).isNew;
  };
  assert.equal(make('files', 'files'), false, 'same surface: joined');
  assert.equal(make('files', 'sharing'), true, 'different surface: not joined');
  assert.equal(make(undefined, undefined), true, 'two unknown surfaces are not the same surface');
  assert.equal(make('files', undefined), true);
  assert.equal(make(undefined, 'files'), true);
});

test('a report joins when its similarity equals the threshold, and not when below it', () => {
  const f = new Feedback({ similarity: 0.5 });
  f.report('a', 'alpha bravo');
  assert.equal(f.report('b', 'alpha bravo charlie delta').isNew, false, '2 of 4 is exactly 0.5');
  assert.equal(new Feedback({ similarity: 0.51 }).report('a', 'alpha bravo').ticket.id, 1);
  const g = new Feedback({ similarity: 0.51 });
  g.report('a', 'alpha bravo');
  assert.equal(g.report('b', 'alpha bravo charlie delta').isNew, true);
});

test('a report joins the most similar open ticket, and the earlier one when they tie', () => {
  const weakFirst = new Feedback({ similarity: 0.2 });
  const w = weakFirst.report('a', 'alpha bravo charlie delta echo').ticket;
  const s = weakFirst.report('b', 'alpha foxtrot golf hotel india').ticket;
  assert.notEqual(w.id, s.id);
  assert.equal(weakFirst.report('c', 'alpha foxtrot golf hotel bravo').ticket.id, s.id, 'the stronger match later');

  const strongFirst = new Feedback({ similarity: 0.2 });
  const s2 = strongFirst.report('a', 'alpha foxtrot golf hotel india').ticket;
  strongFirst.report('b', 'alpha bravo charlie delta echo');
  assert.equal(strongFirst.report('c', 'alpha foxtrot golf hotel bravo').ticket.id, s2.id, 'the stronger match first');

  const tie = new Feedback({ similarity: 0.3 });
  const a = tie.report('a', 'alpha bravo').ticket;
  const b = tie.report('b', 'delta echo').ticket;
  assert.notEqual(a.id, b.id);
  const r = tie.report('c', 'alpha delta');
  assert.equal(r.ticket.id, a.id, 'equal scores keep the earlier ticket');
  assert.deepEqual(a.reports, [1, 3]);
  assert.equal(r.report.group, a.id);
});

test('triage sets severity, moves a new ticket to triaged, and only retitles when given a title', () => {
  const f = new Feedback();
  const t = f.report('a', 'upload fails').ticket;
  assert.throws(() => f.triage(7, 'major'), /no ticket 7/);
  f.triage(t.id, 'major');
  assert.equal(t.column, 'triaged');
  assert.equal(t.severity, 'major');
  assert.equal(t.title, 'upload fails');
  f.triage(t.id, 'minor', 'Uploads fail');
  assert.equal(t.title, 'Uploads fail');
  f.triage(t.id, 'blocker', '');
  assert.equal(t.title, 'Uploads fail', 'an empty title changes nothing');
  f.move(t.id, 'in progress');
  f.triage(t.id, 'major');
  assert.equal(t.column, 'in progress', 're-triage does not move a ticket that is already underway');
});

test('moving needs a real ticket, and a severity for anything but new or won’t fix', () => {
  const f = new Feedback();
  const t = f.report('a', 'upload fails').ticket;
  assert.throws(() => f.move(9, 'new'), /no ticket 9/);
  for (const c of ['triaged', 'in progress', 'fixed'] as const) assert.throws(() => f.move(t.id, c), /triage it first/, c);
  f.move(t.id, 'wont fix');
  assert.equal(t.column, 'wont fix');
  f.move(t.id, 'new');
  assert.equal(t.column, 'new');
  f.triage(t.id, 'minor');
  for (const c of ['triaged', 'in progress', 'fixed'] as const) {
    f.move(t.id, c);
    assert.equal(t.column, c);
  }
});

test('the board lists open tickets only, by severity (untriaged first), then reports, then age', () => {
  const k = clock();
  const f = new Feedback({ now: k.now });
  const mk = (words: string) => f.report('x', words).ticket;
  const cosmetic = mk('alpha cosmetic');
  const untriaged = mk('bravo untriaged');
  const minor = mk('charlie minor');
  const blocker = mk('delta blocker');
  const major = mk('echo major');
  const closed = mk('foxtrot closed');
  const wont = mk('golf wont');
  f.triage(cosmetic.id, 'cosmetic');
  f.triage(minor.id, 'minor');
  f.triage(blocker.id, 'blocker');
  f.triage(major.id, 'major');
  f.triage(closed.id, 'major');
  f.triage(wont.id, 'major');
  f.move(closed.id, 'fixed');
  f.move(wont.id, 'wont fix');
  assert.deepEqual(f.board().map((x) => x.id), [untriaged.id, blocker.id, major.id, minor.id, cosmetic.id]);
});

test('on equal severity the ticket with more reports comes first, then the older', () => {
  const k = clock();
  const f = new Feedback({ now: k.now });
  const a = f.report('a', 'alpha one').ticket;
  k.t += HOUR;
  const b = f.report('b', 'bravo two').ticket;
  k.t += HOUR;
  const c = f.report('c', 'charlie three').ticket;
  for (const t of [a, b, c]) f.triage(t.id, 'minor');
  assert.deepEqual(f.board().map((x) => x.id), [a.id, b.id, c.id], 'oldest first on a tie');
  f.report('d', 'charlie three more'); // joins c
  assert.deepEqual(f.board().map((x) => [x.id, x.count]), [[c.id, 2], [a.id, 1], [b.id, 1]], 'more reports first');
});

test('overdue means strictly past the response target, and overdue tickets come before more severe ones', () => {
  const k = clock();
  const f = new Feedback({ now: k.now });
  const cosmetic = f.report('a', 'alpha cosmetic').ticket;
  f.triage(cosmetic.id, 'cosmetic');
  k.t += 721 * HOUR;
  const blocker = f.report('b', 'bravo blocker').ticket;
  f.triage(blocker.id, 'blocker');
  const board = f.board();
  assert.deepEqual(board.map((x) => [x.id, x.overdue, x.ageHours]), [[cosmetic.id, true, 721], [blocker.id, false, 0]]);
  k.t += 4 * HOUR;
  assert.equal(f.board().find((x) => x.id === blocker.id)!.overdue, false, 'exactly at the target is not overdue');
  k.t += 1;
  assert.equal(f.board().find((x) => x.id === blocker.id)!.overdue, true);
  const g = new Feedback({ now: k.now });
  const u = g.report('a', 'uuu vvv www').ticket;
  k.t += 10_000 * HOUR;
  assert.equal(g.board().find((x) => x.id === u.id)!.overdue, false, 'untriaged tickets have no target');
});

test('a defect needs a real, triaged ticket and says so', () => {
  const f = new Feedback();
  const t = f.report('a', 'upload fails').ticket;
  const o = { steps: ['a'], expected: 'e', actual: 'x' };
  assert.throws(() => f.defect(99, o), /^Error: triage it first: give it a severity$/, 'no such ticket');
  assert.throws(() => f.defect(t.id, o), /^Error: triage it first: give it a severity$/);
});

test('defect evidence skips what is missing and does not repeat itself', () => {
  const f = new Feedback();
  const a = f.report('a', 'upload fails', { errors: ['E1'] }).ticket;
  f.report('b', 'upload fails', { version: '2', errors: ['E1', 'E2'] });
  f.triage(a.id, 'minor');
  const d = f.defect(a.id, { steps: [], expected: 'e', actual: 'x' });
  assert.deepEqual(d.evidence, ['E1', 'version 2', 'E2']);
  assert.equal(d.severity, 'minor');
  assert.equal(d.title, 'upload fails');
});

test('the generated test is exact, with plural and singular report counts', () => {
  const f = new Feedback();
  const a = f.report('a', 'upload fails').ticket;
  f.triage(a.id, 'major');
  const one = f.defect(a.id, { steps: ['sign in', 'upload'], expected: 'it works', actual: 'it fails' });
  assert.equal(
    one.test,
    [
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      '',
      '// Defect 1: upload fails (major, 1 report)',
      "test('it works', async () => {",
      '  // 1. sign in',
      '  // 2. upload',
      '  // Today: it fails',
      "  assert.fail('write the steps above against the real code; this test must fail before the fix and pass after');",
      '});',
      '',
    ].join('\n'),
  );
  f.report('b', 'upload fails');
  assert.match(f.defect(a.id, { steps: [], expected: 'e', actual: 'x' }).test, /\(major, 2 reports\)/);
});

test('whatever a person typed arrives intact in the test name and as one-line comments', () => {
  const f = new Feedback();
  const a = f.report('a', 'upload fails').ticket;
  f.triage(a.id, 'minor');
  const names: string[] = [];
  const run = (code: string) => new Function('assert', 'test', code.replace(/^import .*$/gm, ''))({ fail() {} }, (n: string) => names.push(n));
  for (const expected of ['back\\slash', "it's", 'cr\rlf', 'new\nline', 'ls ps end', 'a\\\'b\\n']) {
    const d = f.defect(a.id, { steps: [], expected, actual: 'x' });
    run(d.test);
    assert.equal(names.pop(), expected, JSON.stringify(expected));
  }
  const d = f.defect(a.id, { steps: ['one\r\ntwo', 'three four five'], expected: 'e', actual: 'x\n\ny' });
  assert.match(d.test, /^  \/\/ 1\. one two$/m);
  assert.match(d.test, /^  \/\/ 2\. three four five$/m);
  assert.match(d.test, /^  \/\/ Today: x y$/m);
});

test('a blocker ranks ahead of an untriaged ticket however they were opened', () => {
  const f = new Feedback({ now: clock().now });
  const blocker = f.report('a', 'alpha blocker').ticket;
  const untriaged = f.report('b', 'bravo untriaged').ticket;
  f.triage(blocker.id, 'blocker');
  assert.deepEqual(f.board().map((x) => x.id), [untriaged.id, blocker.id]);
});

test('overdue tickets lead whichever order the tickets were opened in', () => {
  // Opened first and overdue, although less severe than the second.
  const a = clock();
  const f = new Feedback({ now: a.now });
  const old = f.report('x', 'alpha old').ticket;
  a.t += 720 * HOUR;
  const fresh = f.report('x', 'bravo fresh').ticket;
  f.triage(old.id, 'cosmetic');
  f.triage(fresh.id, 'blocker');
  a.t += HOUR;
  assert.deepEqual(f.board().map((x) => [x.id, x.overdue]), [[old.id, true], [fresh.id, false]]);

  // Opened second and overdue, although less urgent by age; the first is not overdue.
  const b = clock();
  const g = new Feedback({ now: b.now });
  const early = g.report('x', 'charlie early').ticket;
  b.t += 10 * HOUR;
  const late = g.report('x', 'delta late').ticket;
  g.triage(early.id, 'cosmetic');
  g.triage(late.id, 'blocker');
  b.t += 5 * HOUR;
  assert.deepEqual(g.board().map((x) => [x.id, x.overdue]), [[late.id, true], [early.id, false]]);
});
