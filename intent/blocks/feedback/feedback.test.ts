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
