/**
 * Independence is bound to evidence, not to a flag. Each verdict records the model call it came from (provider,
 * model id, the provider's response id, and the tree under review); admission counts a family only from the model
 * id, counts each family and each response once, and does not count a verdict without its call at all.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { wake, type Fetch } from '../src/agents/driver.ts';
import { familyOfModel } from '../src/agents/families.ts';
import { ledgerOf, readLines, type ReviewRecord, type Session } from '../src/agents/ledger.ts';
import { admission, call, type Context, type ModelCall } from '../src/agents/tools.ts';
import { init } from '../src/workspace.ts';

const fixture = (n: string) => new URL(`fixtures/${n}`, import.meta.url).pathname;
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 10, 27, 10, 0, tick++)).toISOString();

function checked() {
  const ws = mkdtempSync(join(tmpdir(), 'zthr-adm-'));
  init(ws, [fixture('rough.md')]);
  copyFileSync(fixture('reading-a.json'), join(ws, 'readings', 'gemini.json'));
  copyFileSync(fixture('reading-b.json'), join(ws, 'readings', 'claude.json'));
  const ledger = ledgerOf(ws, clock, Buffer.alloc(32, 3));
  const as = (role: Session['role'], family: string, agent: string, extra: Partial<Context> = {}): Context => ({ workspace: ws, ledger, session: { role, family, agent }, ...extra });
  assert.ok(call(as('steward', 'google', 's'), 'release_issue', {}).ok);
  const dir = mkdtempSync(join(tmpdir(), 'zthr-adm-factory-'));
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  git('init', '-q');
  mkdirSync(join(dir, 'apps'));
  writeFileSync(join(dir, 'apps', 'a.ts'), 'export {};\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  const commit = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  const b = as('builder', 'qwen', 'builder-1', { factory: dir, run: () => ({ exit: 0, out: 'ok' }) });
  const o = call(b, 'change_open', { title: 'Bills page', commit, paths: ['apps/a.ts'] });
  assert.ok(o.ok, JSON.stringify(o));
  const change = (o.value as { change: string }).change;
  assert.ok(call(b, 'checks_run', { change }).ok);
  let n = 0;
  const reviewer = (family: string, model: string, a: Partial<ModelCall> = {}) => as('reviewer', family, `r-${family}-${++n}`, { factory: dir, answer: { provider: 'vertex', model, response: `chatcmpl-${n}`, ...a } });
  const pass = (c: Context) => call(c, 'review_submit', { change, verdict: 'pass', checked: ['the bills gauge'], findings: [] });
  const forge = (r: Partial<ReviewRecord>) => appendFileSync(join(ledger.dir, 'reviews.jsonl'), `${JSON.stringify({ change, verdict: 'pass', checked: ['x'], findings: [], at: clock(), ...r })}\n`);
  return { ws, ledger, as, change, tree, reviewer, pass, forge, dir };
}

test('the family is read from the model id the provider answered with', () => {
  assert.equal(familyOfModel('google/gemini-4-hydrogen'), 'google');
  assert.equal(familyOfModel('deepseek-ai/deepseek-v4.1-flash-maas'), 'deepseek');
  assert.equal(familyOfModel('llama3.3'), 'llama');
  assert.equal(familyOfModel('qwen3-coder'), 'qwen');
  assert.equal(familyOfModel('claude-sonnet-5@20261001'), 'anthropic');
  assert.equal(familyOfModel('gpt-5'), 'openai');
  assert.equal(familyOfModel('my-finetune'), null, 'an unknown model has no family');
  assert.equal(familyOfModel('llama-distilled-from-qwen'), null, 'nor does one that names two');
});

test('two verdicts with their model calls admit the change, and the record says which calls', () => {
  const x = checked();
  assert.ok(x.pass(x.reviewer('google', 'google/gemini-4-hydrogen')).ok);
  assert.ok(x.pass(x.reviewer('deepseek', 'deepseek-ai/deepseek-v4.1-flash-maas')).ok);
  const a = admission(x.ledger, x.change);
  assert.ok(a.admitted, JSON.stringify(a));
  const rs = readLines<ReviewRecord>(x.ledger, 'reviews.jsonl');
  for (const r of rs) {
    assert.ok(r.evidence?.provider && r.evidence.model && r.evidence.response, JSON.stringify(r));
    assert.equal(r.evidence.tree, x.tree, 'the tree the API read for the change, not one the agent gave');
  }
});

test('planted: verdicts without the record of their model call do not count', () => {
  const x = checked();
  assert.ok(x.pass(x.as('reviewer', 'google', 'g')).ok, 'a review without a call is recorded');
  assert.ok(x.pass(x.as('reviewer', 'openai', 'o')).ok);
  const a = admission(x.ledger, x.change);
  assert.equal(a.admitted, false);
  assert.ok(a.missing.some((m) => /google review carries no record of the model call/.test(m)), a.missing.join('\n'));
  assert.ok(a.missing.some((m) => /2 more passing review/.test(m)));
  const x2 = checked();
  assert.ok(x2.pass(x2.reviewer('google', 'google/gemini-4-hydrogen', { response: '' })).ok);
  assert.ok(x2.pass(x2.reviewer('deepseek', 'deepseek-ai/deepseek-v4.1-flash-maas')).ok);
  const a2 = admission(x2.ledger, x2.change);
  assert.ok(!a2.admitted && a2.missing.some((m) => /google review carries no record/.test(m)), 'nor one without the provider’s response id');
});

test('planted: two verdicts from one provider’s family under two flags count as one family', () => {
  const x = checked();
  assert.ok(x.pass(x.reviewer('google', 'google/gemini-4-hydrogen')).ok);
  const r = x.pass(x.reviewer('openai', 'google/gemini-4-hydrogen'));
  assert.ok(!r.ok && r.refused && /a google model/.test(r.why), 'the API refuses a session whose model is not its family');
  // The same, written straight into the record by something with a shell: admission still counts one family.
  x.forge({ by: { role: 'reviewer', family: 'openai', agent: 'forger' }, evidence: { provider: 'vertex', model: 'google/gemini-4-hydrogen', response: 'chatcmpl-x', tree: x.tree } });
  x.forge({ by: { role: 'reviewer', family: 'google', agent: 'forger-2' }, evidence: { provider: 'vertex', model: 'gemini-4-pro', response: 'chatcmpl-y', tree: x.tree } });
  const a = admission(x.ledger, x.change);
  assert.equal(a.admitted, false, JSON.stringify(a));
  assert.ok(a.missing.some((m) => /1 more passing review/.test(m)), a.missing.join('\n'));
});

test('planted: one response counted twice, a review of another tree, or an unknown model, does not count', () => {
  const x = checked();
  assert.ok(x.pass(x.reviewer('google', 'google/gemini-4-hydrogen', { response: 'chatcmpl-same' })).ok);
  x.forge({ by: { role: 'reviewer', family: 'deepseek', agent: 'f1' }, evidence: { provider: 'vertex', model: 'deepseek-ai/deepseek-v4.1-flash-maas', response: 'chatcmpl-same', tree: x.tree } });
  let a = admission(x.ledger, x.change);
  assert.ok(!a.admitted && a.missing.some((m) => /already counted/.test(m)), a.missing.join('\n'));
  x.forge({ by: { role: 'reviewer', family: 'deepseek', agent: 'f2' }, evidence: { provider: 'vertex', model: 'deepseek-ai/deepseek-v4.1-flash-maas', response: 'chatcmpl-2', tree: '0'.repeat(40) } });
  a = admission(x.ledger, x.change);
  assert.ok(!a.admitted && a.missing.some((m) => /not the checked tree/.test(m)), a.missing.join('\n'));
  x.forge({ by: { role: 'reviewer', family: 'mystery', agent: 'f3' }, evidence: { provider: 'ollama', model: 'my-finetune', response: 'r', tree: x.tree } });
  a = admission(x.ledger, x.change);
  assert.ok(!a.admitted && a.missing.some((m) => /family is not known/.test(m)), a.missing.join('\n'));
  assert.ok(x.pass(x.reviewer('llama', 'llama3.3', { provider: 'ollama' })).ok);
  const after = admission(x.ledger, x.change);
  assert.ok(after.admitted, `a real second family makes up the two: ${JSON.stringify(after)}`);
  assert.equal(after.uncounted.length, 2, 'and what did not count is still said');
});

test('planted: a block counts even without evidence: refusing is always safe', () => {
  const x = checked();
  assert.ok(x.pass(x.reviewer('google', 'google/gemini-4-hydrogen')).ok);
  assert.ok(x.pass(x.reviewer('deepseek', 'deepseek-ai/deepseek-v4.1-flash-maas')).ok);
  assert.ok(call(x.as('reviewer', 'llama', 'l'), 'review_submit', { change: x.change, verdict: 'block', checked: ['x'], findings: [{ what: 'drops a payment', severity: 'blocking' }] }).ok);
  assert.equal(admission(x.ledger, x.change).admitted, false);
});

test('the driver records the provider’s response id with the verdict it carried', async () => {
  const x = checked();
  const c = x.as('reviewer', 'deepseek', 'reviewer-deepseek-flash', { factory: x.dir });
  let turn = 0;
  const f: Fetch = async () => {
    turn++;
    const message = turn === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'review_submit', arguments: JSON.stringify({ change: x.change, verdict: 'pass', checked: ['the bills gauge'], findings: [] }) } }] } : { role: 'assistant', content: 'reviewed' };
    return { ok: true, status: 200, text: async () => '', json: async () => ({ id: `chatcmpl-vertex-${turn}`, choices: [{ message, finish_reason: 'stop' }] }) };
  };
  const r = await wake(c, 'deepseek-flash', f, { project: 'p', token: () => 't' });
  assert.equal(r.stopped, 'done');
  const rec = readLines<ReviewRecord>(x.ledger, 'reviews.jsonl').at(-1)!;
  assert.deepEqual(rec.evidence, { provider: 'vertex', model: 'deepseek-ai/deepseek-v4.1-flash-maas', response: 'chatcmpl-vertex-1', tree: x.tree });
});
