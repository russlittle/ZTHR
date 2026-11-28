import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Router, type Model } from '../../intent/blocks/router/index.ts';
import { claudeArgs, claudeEnv, dispatch, parseClaudeStream, queueOrder, restoreOutside, snapshot, taskKey, type Deps, type Worker, type WorkerRun } from './dispatch.ts';
import { Sandbox, TOOLS, runAgent, vertexChat, type Chat, type ChatResponse, type Task, type ToolCall } from './harness.ts';
import { ROOT, adaptPrompt, anthropicUrl, loadPrices, openapiBase, reviewSpend, runAcceptance, scrubbedEnv, vertexHostAllowed, type CrewResult } from './lib.ts';
import { firstJson, vertexComplete, type Complete } from './models.ts';
import { morningReport, writeReport } from './report.ts';
import { parseVerdict, prompts, review, rules, summary } from './review.ts';

const PRICES = loadPrices();
const router = (results: CrewResult[] = []) => new Router(PRICES, results, { now: new Date(), random: () => 0.99 });

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-'));
  const g = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'crew@example.invalid');
  g('config', 'user.name', 'crew test');
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), t);
  }
  g('add', '-A');
  g('commit', '-q', '-m', 'start');
  return dir;
}

const mutant = (id: string, line: number) => ({ id, line, column: 1, endLine: line, endColumn: 5, mutator: 'ConditionalExpression', original: `a${id}`, replacement: 'true', lineText: `if (a${id}) x();`, prevText: '', nextText: '' });
const task = (kind: string, id: string, line = 1, block = 'geo'): Task & { mutant: ReturnType<typeof mutant> } => ({
  kind,
  block,
  mutant: mutant(id, line),
  mayEdit: kind === 'kill-mutant' ? [`intent/blocks/${block}/${block}.test.ts`] : [`intent/blocks/${block}/index.ts`, `intent/blocks/${block}/${block}.test.ts`],
  acceptance: `node tools/mutation/accept.ts intent/factory/queue/mutation/${block}-${id}.json`,
  budgetTokens: 40_000,
  tier: 'worker',
  prompt: `TASK ${kind}.\nRun when done: node tools/mutation/accept.ts intent/factory/queue/mutation/${block}-${id}.json\nCommit only if it prints "pass": true.`,
  baseline: {},
});

const call = (name: string, args: unknown, id = name): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (calls: ToolCall[], usage = { prompt_tokens: 1000, completion_tokens: 100 }, content: string | null = null): ChatResponse => ({ id: `resp-${Math.random().toString(36).slice(2, 8)}`, choices: [{ message: { role: 'assistant', content, tool_calls: calls } }], usage });
/** A fake model that plays a script, one reply per request, and records what it was sent. */
function scripted(steps: ChatResponse[]): Chat & { sent: Parameters<Chat>[0][] } {
  const sent: Parameters<Chat>[0][] = [];
  const f = (async (req) => {
    sent.push(structuredClone(req));
    const next = steps.shift();
    if (!next) throw new Error('script ran out');
    return next;
  }) as Chat & { sent: Parameters<Chat>[0][] };
  f.sent = sent;
  return f;
}

const T = 'intent/blocks/geo/geo.test.ts';
const SRC = 'intent/blocks/geo/index.ts';
const base = () => repo({ [T]: 'test 1\n', [SRC]: 'code 1\n', 'README.md': 'readme\n', 'tools/mutation/accept.ts': 'gate\n' });

test('the sandbox reads tracked files and mayEdit files, and nothing outside the repository or under .git', () => {
  const dir = base();
  writeFileSync(join(dir, 'gha-creds-123.json'), '{"secret": true}');
  const sb = new Sandbox(task('kill-mutant', '1'), dir, () => ({ ok: true, output: '' }));
  assert.equal(sb.read('README.md'), 'readme\n');
  assert.equal(sb.read('./README.md'), 'readme\n');
  assert.equal(sb.read(T), 'test 1\n');
  assert.match(sb.read('gha-creds-123.json'), /^refused: .* not a tracked file/, 'an untracked credentials file is not readable');
  for (const p of ['/etc/passwd', '../outside', 'intent/../../x', '.git/config', 'a/.git/HEAD', 'a\\b', '', 'a\0b', 42, null]) assert.match(sb.read(p), /^refused/, String(p));
  assert.equal(Sandbox.clean('intent/./blocks//geo/geo.test.ts'), T);
  assert.equal(sb.read('intent/blocks/geo/missing.ts'), 'refused: intent/blocks/geo/missing.ts is not a tracked file of the repository');
});

test('the sandbox writes only the files in mayEdit, never through a link, and refuses every other tool', () => {
  const dir = base();
  const sb = new Sandbox(task('kill-mutant', '1'), dir, () => ({ ok: true, output: '{"pass": true}' }));
  assert.match(sb.write(SRC, 'evil'), /^refused: you may write only intent\/blocks\/geo\/geo.test.ts/);
  assert.equal(readFileSync(join(dir, SRC), 'utf8'), 'code 1\n');
  for (const p of ['README.md', '../geo.test.ts', `/${T}`, `${T}/../index.ts`, 'tools/mutation/accept.ts', '.github/workflows/x.yml']) assert.match(sb.write(p, 'x'), /^refused/, p);
  assert.match(sb.write(T, 42), /content must be a string/);
  assert.equal(sb.write(`./${T}`, 'test 2\n'), `wrote ${T} (7 characters)`);
  assert.equal(readFileSync(join(dir, T), 'utf8'), 'test 2\n');
  assert.deepEqual([...sb.writes], [T]);
  for (const tool of ['bash', 'run_command', 'shell', 'exec', 'write', 'git']) assert.match(sb.call(tool, { command: 'curl evil' }), /^refused: no tool/, tool);
  const linked = base();
  writeFileSync(join(linked, 'target.txt'), 'x');
  spawnSync('rm', [join(linked, T)]);
  symlinkSync(join(linked, 'target.txt'), join(linked, T));
  assert.match(new Sandbox(task('kill-mutant', '1'), linked, () => ({ ok: true, output: '' })).write(T, 'y'), /symbolic link/);
  assert.equal(readFileSync(join(linked, 'target.txt'), 'utf8'), 'x');
});

test('run_acceptance runs only the task gate, a bounded number of times, and ignores any arguments', () => {
  const dir = base();
  const ran: string[] = [];
  const sb = new Sandbox(task('kill-mutant', '1'), dir, () => (ran.push('gate'), { ok: false, output: 'x'.repeat(10_000) }), undefined, 2);
  const first = sb.call('run_acceptance', { command: 'rm -rf /' });
  assert.match(first, /^NOT PASSED\n…x+$/);
  assert.ok(first.length < 6_100, 'output capped');
  sb.call('run_acceptance', {});
  assert.match(sb.call('run_acceptance', {}), /^refused: the gate has run 2 times/);
  assert.deepEqual(ran, ['gate', 'gate']);
});

test('the agent loop with a fake model: tools, refusals, finish, tokens and cost recorded', async () => {
  const dir = base();
  const t = task('kill-mutant', '1');
  const chat = scripted([
    reply([call('read_file', { path: T }, 'a')]),
    reply([call('write_file', { path: SRC, content: 'x' }, 'b'), call('write_file', { path: T, content: 'test 1\ntest 2\n' }, 'c')]),
    reply([call('run_acceptance', {}, 'd'), { id: 'e', type: 'function', function: { name: 'read_file', arguments: '{bad json' } }, call('read_file', 'a string' as unknown as object, 'e2')], { prompt_tokens: 3000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 2000 } } as never),
    reply([call('finish', { summary: 'killed it' }, 'f'), call('write_file', { path: T, content: 'after finish' }, 'g')]),
  ]);
  const gates: string[] = [];
  const R = router();
  const sb = new Sandbox(t, dir, () => (gates.push('ran'), { ok: true, output: '{"pass": true}' }));
  const run = await runAgent(t, 'intent/factory/queue/mutation/geo-1.json', { chat, model: R.model('gpt-oss-120b'), router: R, sandbox: sb });
  assert.equal(run.stop, 'finish');
  assert.equal(run.steps, 4);
  assert.equal(run.summary, 'killed it');
  assert.deepEqual(run.writes, [T]);
  assert.equal(readFileSync(join(dir, T), 'utf8'), 'test 1\ntest 2\n', 'nothing after finish runs');
  assert.equal(readFileSync(join(dir, SRC), 'utf8'), 'code 1\n');
  assert.equal(run.inputTokens, 1000 + 1000 + 1000 + 1000);
  assert.equal(run.cacheReadTokens, 2000);
  assert.equal(run.outputTokens, 350);
  assert.equal(run.costUsd, R.cost('gpt-oss-120b', { inputTokens: 3000, outputTokens: 300 }) + R.cost('gpt-oss-120b', { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 2000 }));
  assert.equal(run.responseIds.length, 4);
  assert.deepEqual(gates, ['ran']);
  const last = chat.sent.at(-1)!;
  assert.equal(last.model, 'openai/gpt-oss-120b-maas');
  assert.deepEqual(last.tools, TOOLS);
  const toolText = last.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.deepEqual(toolText, ['test 1\n', 'refused: you may write only intent/blocks/geo/geo.test.ts', `wrote ${T} (14 characters)`, 'PASS\n{"pass": true}', 'refused: arguments were not valid JSON', 'refused: arguments must be a JSON object']);
  const user = chat.sent[0]!.messages[1]!.content!;
  assert.match(user, /call the run_acceptance tool/);
  assert.doesNotMatch(user, /Commit only if/);
});

test('the agent loop stops at the step cap, the token cap, a reply with no tool calls, or a model error', async () => {
  const dir = base();
  const t = task('kill-mutant', '1');
  const R = router();
  const m = R.model('deepseek-v4.1-flash');
  const sb = () => new Sandbox(t, dir, () => ({ ok: true, output: '' }));
  const forever = () => reply([call('read_file', { path: 'README.md' })]);
  const steps = await runAgent(t, 'x.json', { chat: scripted(Array.from({ length: 10 }, forever)), model: m, router: R, sandbox: sb(), maxSteps: 3 });
  assert.equal(steps.stop, 'step-cap');
  assert.equal(steps.steps, 3);
  const tokens = await runAgent(t, 'x.json', { chat: scripted(Array.from({ length: 10 }, () => reply([call('read_file', { path: 'README.md' })], { prompt_tokens: 15_000, completion_tokens: 1000 }))), model: m, router: R, sandbox: sb() });
  assert.equal(tokens.stop, 'token-cap');
  assert.equal(tokens.steps, 3, '48,000 tokens after three calls is over the 40,000 cap');
  const quiet = await runAgent(t, 'x.json', { chat: scripted([{ id: 'q', choices: [{ message: { role: 'assistant', content: 'I am done' } }] }]), model: m, router: R, sandbox: sb() });
  assert.equal(quiet.stop, 'no-tool-calls');
  assert.equal(quiet.summary, 'I am done');
  const broken = await runAgent(t, 'x.json', { chat: scripted([]), model: m, router: R, sandbox: sb() });
  assert.equal(broken.stop, 'error');
  assert.match(broken.error!, /script ran out/);
  const eq = await runAgent(t, 'x.json', { chat: scripted([reply([call('finish', { summary: 's', equivalent: true, argument: 'a >= -90 is implied' })])]), model: m, router: R, sandbox: sb() });
  assert.deepEqual(eq.equivalent, { argument: 'a >= -90 is implied' });
});

test('model calls go only to Vertex AI, with a bearer token, retried on server errors', async () => {
  for (const ok of ['https://aiplatform.googleapis.com/v1/x', 'https://us-central1-aiplatform.googleapis.com/v1/x', 'https://aiplatform.us.rep.googleapis.com/v1/x']) assert.ok(vertexHostAllowed(ok), ok);
  for (const bad of ['http://aiplatform.googleapis.com/v1', 'https://aiplatform.googleapis.com.evil.com/v1', 'https://evil.com/aiplatform.googleapis.com', 'https://openrouter.ai/api/v1', 'not a url']) assert.equal(vertexHostAllowed(bad), false, bad);
  assert.throws(() => vertexChat('https://api.openai.com/v1', async () => 't'), /outside Vertex AI/);
  assert.equal(openapiBase('my-project-1'), 'https://aiplatform.googleapis.com/v1/projects/my-project-1/locations/global/endpoints/openapi');
  assert.equal(openapiBase('my-project-1', 'us-central1'), 'https://us-central1-aiplatform.googleapis.com/v1/projects/my-project-1/locations/us-central1/endpoints/openapi');
  assert.equal(anthropicUrl('my-project-1', 'claude-haiku-5-5'), 'https://aiplatform.googleapis.com/v1/projects/my-project-1/locations/global/publishers/anthropic/models/claude-haiku-5-5:rawPredict');
  assert.throws(() => openapiBase('../evil'), /not a project id/);
  const seen: { url: string; auth: string }[] = [];
  let n = 0;
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, auth: (init.headers as Record<string, string>).authorization ?? '' });
    return ++n === 1 ? new Response('busy', { status: 503 }) : Response.json({ id: 'r1', choices: [{ message: { role: 'assistant', content: 'hi' } }] });
  }) as unknown as typeof fetch;
  const res = await vertexChat(openapiBase('my-project-1'), async () => 'tok', f)({ model: 'm', messages: [], tools: [], max_tokens: 1, temperature: 0 });
  assert.equal(res.id, 'r1');
  assert.deepEqual(seen.map((s) => s.url), Array(2).fill('https://aiplatform.googleapis.com/v1/projects/my-project-1/locations/global/endpoints/openapi/chat/completions'));
  assert.equal(seen[0]!.auth, 'Bearer tok');
  const denied = (async () => new Response('no', { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(vertexChat(openapiBase('my-project-1'), async () => 't', denied)({ model: 'm', messages: [], tools: [], max_tokens: 1, temperature: 0 }), /403/);
});

test('model-written code runs with credentials scrubbed from its environment', () => {
  const env = scrubbedEnv({ PATH: '/bin', HOME: '/h', GOOGLE_APPLICATION_CREDENTIALS: '/c.json', CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/c', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't', GITHUB_TOKEN: 'g', ANTHROPIC_VERTEX_PROJECT_ID: 'p', CREW_DAILY_BUDGET_USD: '5', GITHUB_SHA: 'abc' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', GITHUB_SHA: 'abc' });
  const ce = claudeEnv(router().model('claude-haiku-5-5'), 'proj-123', { PATH: '/bin', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 'g', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't', CREW_DAILY_BUDGET_USD: '5', CREW_ACCEPT_PREFIX: 'bash tools/crew/no-network.sh' });
  assert.equal(ce.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
  assert.equal(ce.CREW_DAILY_BUDGET_USD, undefined);
  assert.equal(ce.CREW_ACCEPT_PREFIX, 'bash tools/crew/no-network.sh', 'the gate Claude runs still goes in the no-network namespace');
  assert.equal(ce.ANTHROPIC_API_KEY, undefined);
  assert.equal(ce.GITHUB_TOKEN, undefined);
  assert.equal(ce.CLAUDE_CODE_USE_VERTEX, '1');
  assert.equal(ce.CLOUD_ML_REGION, 'global');
  assert.equal(ce.ANTHROPIC_VERTEX_PROJECT_ID, 'proj-123');
  assert.equal(ce.ANTHROPIC_MODEL, 'claude-haiku-5-5');
  assert.equal(ce.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
});

test('the prompt a worker reads points at the wrapped gate and forbids committing', () => {
  const p = task('simplify', '9').prompt + '\nIf no safe simplification exists, change nothing and run: node tools/mutation/equivalent.ts --stands geo 9 --reason "<why>" --by "<your model>"';
  const cmd = adaptPrompt(p, 'intent/factory/queue/mutation/geo-9-simplify.json', 'command');
  assert.match(cmd, /When done, run: node tools\/crew\/accept\.ts intent\/factory\/queue\/mutation\/geo-9-simplify\.json/);
  assert.doesNotMatch(cmd, /tools\/mutation\/accept\.ts|tools\/mutation\/equivalent\.ts/);
  assert.match(cmd, /Do not commit/);
  assert.match(cmd, /NO SIMPLIFICATION: <why>/);
  assert.match(cmd, /EQUIVALENT: <the argument>/);
  assert.match(adaptPrompt(p, 'x.json', 'tool'), /no_simplification set to true/);
});

test('Claude Code headless is confined to the task files and the exact gate command', () => {
  const t = task('fix-bug', '3');
  const a = claudeArgs(t, 'intent/factory/queue/mutation/geo-3-fix.json', router().model('claude-sonnet-5-5'), 0.5);
  const allowed = a.slice(a.indexOf('--allowedTools') + 1, a.indexOf('--disallowedTools'));
  assert.deepEqual(allowed, ['Read', 'Glob', 'Grep', `Edit(./${SRC})`, `Write(./${SRC})`, `Edit(./${T})`, `Write(./${T})`, 'Bash(node tools/crew/accept.ts intent/factory/queue/mutation/geo-3-fix.json)']);
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'dontAsk', 'anything not allowed is denied, not asked');
  assert.equal(a[a.indexOf('--model') + 1], 'claude-sonnet-5-5');
  assert.equal(a[a.indexOf('--max-budget-usd') + 1], '0.50');
  assert.ok(a.includes('Read(./gha-creds-*.json)'));
  assert.ok(a.includes('--strict-mcp-config'));
});

test("Claude Code's stream is priced per request, so the long-context tier applies only to the requests over it", () => {
  const R = router();
  const m = R.model('claude-haiku-5-5');
  const ev = (id: string, input: number, out: number, cacheRead = 0) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: input, output_tokens: out, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 } } });
  const stdout = [ev('msg_1', 80_000, 1000), ev('msg_1', 80_000, 1000), ev('msg_2', 10_000, 500, 95_000), 'not json', JSON.stringify({ type: 'result', result: 'done\nEQUIVALENT: no input differs', is_error: false, total_cost_usd: 0.07, num_turns: 2 })].join('\n');
  const p = parseClaudeStream(stdout, m, R);
  assert.deepEqual(p.responseIds, ['msg_1', 'msg_2'], 'a message seen twice counts once');
  assert.equal(p.inputTokens, 90_000);
  assert.equal(p.cacheReadTokens, 95_000);
  assert.equal(p.costUsd, R.cost(m.id, { inputTokens: 80_000, outputTokens: 1000 }) + R.cost(m.id, { inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 95_000 }));
  assert.equal(R.cost(m.id, { inputTokens: 80_000, outputTokens: 1000 }), 0.0085, 'under the threshold: standard');
  assert.equal(R.cost(m.id, { inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 95_000 }), 0.011, '105,000 in: long rates (0.005 + 0.00475 + 0.00125)');
  assert.equal(p.steps, 2);
  assert.equal(p.reportedUsd, 0.07);
});

// ---------------------------------------------------------------------------------------------------------------
// Dispatch, end to end with fake models and a fake gate

function crewRepo(tasks: Task[]) {
  const dir = base();
  const queue = join(dir, 'intent/factory/queue/mutation');
  mkdirSync(queue, { recursive: true });
  for (const t of tasks) writeFileSync(join(queue, `${t.block}-${t.mutant.id}${t.kind === 'kill-mutant' ? '' : t.kind === 'fix-bug' ? '-fix' : '-simplify'}.json`), JSON.stringify(t, null, 2));
  return { dir, queue };
}

const blank: WorkerRun = { stop: 'finish', steps: 1, inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 0, costUsd: 0.002, responseIds: ['r'], summary: '' };

function deps(dir: string, queue: string, o: Partial<Deps> & { worker?: Worker }): Deps & { written: CrewResult[] } {
  const written: CrewResult[] = [];
  return {
    root: dir,
    queue,
    router: router(),
    budgetUsd: 1,
    workers: { 'openai-compatible': o.worker ?? (async () => blank), 'claude-code': o.worker ?? (async () => blank) },
    gate: () => ({ ok: false, output: '', verdict: { outcome: 'rejected', reasons: ['d-mutant-killed: mutant still survives'] } }),
    write: (r) => written.push(r),
    prior: [],
    ...o,
    written,
  };
}

test('dispatch takes fix-bug first, then kill-mutant by line, then simplify', () => {
  const { queue } = crewRepo([task('simplify', '5', 1), task('kill-mutant', '7', 30), task('kill-mutant', '6', 10), task('fix-bug', '8', 50)]);
  assert.deepEqual(queueOrder(queue).map((f) => f.split('/').pop()), ['geo-8-fix.json', 'geo-6.json', 'geo-7.json', 'geo-5-simplify.json']);
  assert.deepEqual(queueOrder(join(queue, 'nowhere')), []);
});

test('dispatch keeps a passing change, moves the task to done, and records the attempt', async () => {
  const { dir, queue } = crewRepo([task('kill-mutant', '1')]);
  const d = deps(dir, queue, {
    worker: async (t, f, m, o) => {
      writeFileSync(join(o.root, T), 'test 1\ntest kills\n');
      return { ...blank, costUsd: o.router.cost(m.id, { inputTokens: 10_000, outputTokens: 1_000 }) };
    },
    gate: () => ({ ok: true, output: '', verdict: { outcome: 'pass', reasons: [] } }),
  });
  const s = await dispatch(d);
  assert.deepEqual(s.fixed, ['intent/factory/queue/mutation/geo-1.json']);
  assert.equal(readFileSync(join(dir, T), 'utf8'), 'test 1\ntest kills\n');
  assert.ok(existsSync(join(queue, 'done', 'geo-1.json')));
  assert.ok(!existsSync(join(queue, 'geo-1.json')));
  const r = d.written[0]!;
  assert.equal(r.model, 'gpt-oss-120b');
  assert.equal(r.pass, true);
  assert.equal(r.outcome, 'pass');
  assert.equal(r.level, 'worker');
  assert.equal(r.task, taskKey(task('kill-mutant', '1')));
  assert.equal(r.costUsd, 0.00126);
  assert.equal(s.spentUsd, 0.00126);
  const t = JSON.parse(readFileSync(join(queue, 'done', 'geo-1.json'), 'utf8')) as Task;
  assert.deepEqual(t.baseline, {}, 'baseline taken before the worker ran: nothing was dirty');
});

test('dispatch restores files on a failed gate, and anything a worker touched outside mayEdit always', async () => {
  const { dir, queue } = crewRepo([task('kill-mutant', '1')]);
  writeFileSync(join(dir, 'README.md'), 'someone else, uncommitted\n');
  const d = deps(dir, queue, {
    worker: async (_t, _f, _m, o) => {
      writeFileSync(join(o.root, T), 'a hollow test\n');
      writeFileSync(join(o.root, SRC), 'code changed by the worker\n');
      writeFileSync(join(o.root, 'README.md'), 'worker was here\n');
      writeFileSync(join(o.root, 'new-file.txt'), 'planted\n');
      writeFileSync(join(o.root, 'intent/factory/queue/mutation/geo-1-fix.json.tmp'), 'the gate writes here');
      return blank;
    },
    perTask: 1,
  });
  const s = await dispatch(d);
  assert.equal(s.fixed.length, 0);
  assert.equal(readFileSync(join(dir, T), 'utf8'), 'test 1\n', 'mayEdit file put back after the failed gate');
  assert.equal(readFileSync(join(dir, SRC), 'utf8'), 'code 1\n', 'tracked file outside mayEdit checked out');
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'someone else, uncommitted\n', "someone's uncommitted work is put back as it was, not to HEAD");
  assert.ok(!existsSync(join(dir, 'new-file.txt')), 'new file outside mayEdit removed');
  assert.ok(existsSync(join(dir, 'intent/factory/queue/mutation/geo-1-fix.json.tmp')), "the gate's own queue writes stay");
  const r = d.written[0]!;
  assert.equal(r.pass, false);
  assert.equal(r.outcome, 'rejected');
  assert.ok(r.reasons!.some((x) => x.startsWith('restored files outside mayEdit: ')));
  assert.ok(r.reasons!.includes('d-mutant-killed: mutant still survives'));
});

test('restoreOutside leaves a clean tree clean and puts back a deleted tracked file', () => {
  const dir = base();
  const before = snapshot(dir);
  assert.equal(before.size, 0);
  spawnSync('rm', [join(dir, 'README.md')]);
  assert.deepEqual(restoreOutside(dir, before, [], () => false), ['README.md']);
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'readme\n');
  assert.deepEqual(restoreOutside(dir, snapshot(dir), [], () => false), []);
});

test('a task that keeps failing climbs worker, escalation, judgment within the run, then is parked', async () => {
  const { dir, queue } = crewRepo([task('kill-mutant', '1')]);
  const seen: string[] = [];
  const d = deps(dir, queue, { worker: async (_t, _f, m) => (seen.push(m.id), blank), perTask: 7 });
  const s = await dispatch(d);
  assert.deepEqual(seen, ['gpt-oss-120b', 'claude-haiku-5-5', 'gemini-3.8-flash', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5']);
  assert.deepEqual(s.attempts.map((a) => a.level), ['worker', 'worker', 'escalation', 'escalation', 'judgment', 'judgment']);
  assert.deepEqual(s.parked, ['intent/factory/queue/mutation/geo-1.json']);
  const next = deps(dir, queue, { worker: async (_t, _f, m) => (seen.push(m.id), blank), prior: d.written });
  const again = await dispatch(next);
  assert.equal(again.attempts.length, 0, 'failures from earlier runs count: still parked');
  assert.deepEqual(again.parked, ['intent/factory/queue/mutation/geo-1.json']);
});

test('dispatch stops when the daily budget is spent, counting what was spent earlier today', async () => {
  const { dir, queue } = crewRepo([task('kill-mutant', '1'), task('kill-mutant', '2', 2), task('kill-mutant', '3', 3)]);
  const spentEarlier: CrewResult = { at: new Date().toISOString(), task: 'x', kind: 'review', model: 'claude-haiku-5-5', family: 'anthropic', runner: 'review', outcome: 'review', pass: null, inputTokens: 0, outputTokens: 0, costUsd: 0.99 };
  const d = deps(dir, queue, { worker: async () => ({ ...blank, costUsd: 0.006 }), prior: [spentEarlier], perTask: 1 });
  const s = await dispatch(d);
  assert.equal(s.attempts.length, 1, '0.01 left: one task at an estimated 0.00522 costing 0.006, then 0.004 left');
  assert.match(s.stopped, /^budget/);
  const none = await dispatch(deps(dir, queue, { prior: [{ ...spentEarlier, costUsd: 1 }] }));
  assert.equal(none.attempts.length, 0);
  assert.match(none.stopped, /^budget: budget left 0\.0000/);
});

test('a bug-found verdict keeps the test and hands the fix-bug task the gate wrote straight on', async () => {
  const { dir, queue } = crewRepo([task('kill-mutant', '1'), task('kill-mutant', '2', 5)]);
  const handed: string[] = [];
  const d = deps(dir, queue, {
    worker: async (t, f, _m, o) => {
      handed.push(f);
      if (t.kind === 'kill-mutant' && t.mutant.id === '1') writeFileSync(join(o.root, T), 'test 1\nfailing test\n');
      return blank;
    },
    gate: (f) => {
      if (f.endsWith('geo-1.json')) {
        writeFileSync(join(dir, 'intent/factory/queue/mutation/geo-1-fix.json'), JSON.stringify(task('fix-bug', '1', 1)));
        return { ok: false, output: '', verdict: { outcome: 'bug-found', followUp: 'intent/factory/queue/mutation/geo-1-fix.json' } };
      }
      return { ok: true, output: '', verdict: { outcome: 'pass' } };
    },
  });
  const s = await dispatch(d);
  assert.deepEqual(handed, ['intent/factory/queue/mutation/geo-1.json', 'intent/factory/queue/mutation/geo-1-fix.json', 'intent/factory/queue/mutation/geo-2.json'].slice(0, 2), 'the fix goes next; after a fix-bug pass the block is stale');
  assert.equal(d.written[0]!.outcome, 'bug-found');
  assert.equal(d.written[0]!.pass, null, 'finding a bug is not scored as a failure');
  assert.deepEqual(s.fixed, ['intent/factory/queue/mutation/geo-1-fix.json']);
  assert.deepEqual(s.skipped.map((x) => x.file), ['intent/factory/queue/mutation/geo-2.json']);
});

test('an equivalence claim goes to a judge of another family, and the ruling is recorded with both models', async () => {
  const { dir, queue } = crewRepo([task('kill-mutant', '1')]);
  const asked: Model[] = [];
  const rulings: string[][] = [];
  const complete: Complete = async (m) => (asked.push(m), { text: '```json\n{"verdict": "not-equivalent", "counterexample": "lat = -91"}\n```', provider: 'vertex-anthropic', responseId: 'msg_j', inputTokens: 2000, outputTokens: 100, cacheReadTokens: 0 });
  const d = deps(dir, queue, { worker: async () => ({ ...blank, equivalent: { argument: 'always true here' } }), complete, rule: (a) => (rulings.push(a), { ok: true, output: '' }), perTask: 1 });
  await dispatch(d);
  assert.equal(asked[0]!.id, 'claude-haiku-5-5', 'the worker was gpt-oss (openai); the judge is the cheapest other family');
  assert.deepEqual(rulings[0], ['geo', '1', '--argument', 'always true here', '--by', 'openai/gpt-oss-120b-maas', '--judge', 'claude-haiku-5-5', '--verdict', 'not-equivalent']);
  assert.equal(d.written[0]!.outcome, 'equivalence-disputed');
  assert.equal(d.written[0]!.pass, false);
  assert.equal(d.written[1]!.kind, 'judge');
  assert.equal(d.written[1]!.family, 'anthropic');
  assert.deepEqual(d.written[1]!.responseIds, ['msg_j']);
});

test('the morning report says what was fixed, escalated and parked, the cost, and the pass rates', () => {
  const R = router([{ at: new Date().toISOString(), task: 'k', kind: 'kill-mutant', model: 'gpt-oss-120b', family: 'openai', runner: 'openai-compatible', outcome: 'pass', pass: true, inputTokens: 1, outputTokens: 1, costUsd: 0.01 }]);
  const md = morningReport({ date: '2026-11-27', budgetUsd: 5, spentUsd: 0.03, stopped: 'queue done', fixed: ['q/geo-1.json'], parked: ['q/geo-9.json'], skipped: [], attempts: [{ task: 'k', file: 'q/geo-1.json', kind: 'kill-mutant', model: 'gpt-oss-120b', level: 'worker', why: 'not-yet-proven', outcome: 'pass', pass: true, costUsd: 0.01 }, { task: 'j', file: 'q/geo-2.json', kind: 'kill-mutant', model: 'gemini-3.8-flash', level: 'escalation', why: 'not-yet-proven', outcome: 'rejected', pass: false, costUsd: 0.02 }] }, R, []);
  for (const s of ['# Crew report, 2026-11-27', 'Fixed **1** of 2 work orders', '- `q/geo-1.json` by gpt-oss-120b (worker, $0.0100)', '- `q/geo-2.json` at escalation on gemini-3.8-flash: rejected', '- `q/geo-9.json`: failed at worker, escalation and judgment', '| gpt-oss-120b | 1 | 1 |', '| kill-mutant | gpt-oss-120b | 1 | 1 | 0.207 | exploring | $0.0100 |', 'pie showData']) assert.ok(md.includes(s), s);
  const dir = mkdtempSync(join(tmpdir(), 'report-'));
  const summaryFile = join(dir, 'summary.md');
  const p = writeReport('2026-11-27', md, dir, summaryFile);
  writeReport('2026-11-27', md, dir, summaryFile);
  const text = readFileSync(p, 'utf8');
  assert.equal(text.match(/# Crew report/g)!.length, 1, 'a second run the same day is added below');
  assert.match(text, /Run at \d\d:\d\d UTC/);
  assert.equal(readFileSync(summaryFile, 'utf8').match(/# Crew report/g)!.length, 2);
});

// ---------------------------------------------------------------------------------------------------------------
// Review

test('a reviewer reply is a verdict only if it says pass or block; a blocker finding blocks', () => {
  assert.deepEqual(parseVerdict('{"verdict":"pass","findings":[]}'), { verdict: 'pass', findings: [] });
  assert.equal(parseVerdict('Sure! ```json\n{"verdict":"pass","findings":[{"severity":"blocker","location":"a.ts:1","expectation":"x","support":"y"}]}\n```').verdict, 'block');
  assert.equal(parseVerdict('{"verdict":"block","findings":[]}').verdict, 'block');
  assert.equal(parseVerdict('{"verdict":"approve"}').verdict, 'none');
  assert.equal(parseVerdict('LGTM').verdict, 'none');
  assert.equal(parseVerdict('{"verdict":"pass","findings":[{"severity":"weird"}]}').findings[0]!.severity, 'major');
  assert.deepEqual(firstJson('text {"a": {"b": 1}} trailing } brace'), { a: { b: 1 } });
  assert.equal(firstJson('[1,2]'), undefined);
});

test('the reviewers are held to Pattern 21, and each seat is told its own part', () => {
  const r = rules();
  assert.match(r, /^Multi-Family Review \(ZTHR-P21\)/);
  assert.match(r, /at least three models from different families/);
  const input = { diff: 'DIFF', messages: 'MSG', contextPage: 'PAGE', files: 'FILES', rules: r };
  assert.match(prompts('context-aided', input).user, /MSG[\s\S]*FILES[\s\S]*DIFF/);
  const unaided = prompts('unaided', input).user;
  assert.ok(unaided.includes('PAGE') && unaided.includes('DIFF') && !unaided.includes('MSG') && !unaided.includes('FILES'), 'the unaided reviewer gets the diff and the context page only');
  assert.doesNotMatch(prompts('independent', input).user, /MSG/);
});

test('review: three families must return verdicts, each recorded with provider, model, response id and tree hash', async () => {
  const dir = repo({ 'a.ts': 'export const a = 1;\n', 'README.md': 'the context page\n' });
  const g = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const baseSha = g('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
  g('commit', '-qam', 'a is two');
  const head = g('rev-parse', 'HEAD');
  const tree = g('rev-parse', 'HEAD^{tree}');
  const reply = (text: string): Complete => async (m) => ({ text, provider: m.runner === 'claude-code' ? 'vertex-anthropic' : 'vertex-openapi', responseId: `id-${m.id}`, inputTokens: 5000, outputTokens: 400, cacheReadTokens: 0 });
  const R = router();
  const ok = await review({ repo: dir, base: baseSha, head, complete: reply('{"verdict":"pass","findings":[]}'), router: R, pinned: true, rulesText: 'RULES' });
  assert.equal(ok.admitted, true, ok.why.join('; '));
  assert.equal(ok.tree, tree);
  assert.deepEqual(ok.seats.map((s) => [s.role, s.family, s.vertexId, s.provider, s.responseId]), [
    ['context-aided', 'anthropic', 'claude-haiku-5-5', 'vertex-anthropic', 'id-claude-haiku-5-5'],
    ['unaided', 'google', 'google/gemini-3.5-flash-lite', 'vertex-openapi', 'id-gemini-3.5-flash-lite'],
    ['independent', 'openai', 'openai/gpt-oss-120b-maas', 'vertex-openapi', 'id-gpt-oss-120b'],
  ]);
  assert.equal(ok.costUsd, R.cost('claude-haiku-5-5', { inputTokens: 5000, outputTokens: 400 }) + R.cost('gemini-3.5-flash-lite', { inputTokens: 5000, outputTokens: 400 }) + R.cost('gpt-oss-120b', { inputTokens: 5000, outputTokens: 400 }));
  assert.match(summary(ok), /\*\*Admitted\.\*\* 3 families returned verdicts\. Cost \*\*\$0\.00/);
  const blocked = await review({ repo: dir, base: baseSha, head, complete: async (m, ...rest) => (m.family === 'google' ? { text: '{"verdict":"block","findings":[{"severity":"blocker","location":"a.ts:1","expectation":"a stays 1","support":"callers"}]}', provider: 'vertex-openapi', responseId: 'g', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } : reply('{"verdict":"pass"}')(m, ...rest)), router: R, pinned: true, rulesText: 'RULES' });
  assert.equal(blocked.admitted, false);
  assert.deepEqual(blocked.why, ['unaided (gemini-3.5-flash-lite) blocks: a.ts:1: a stays 1']);
  const down = await review({ repo: dir, base: baseSha, head, complete: async (m, ...rest) => { if (m.family === 'anthropic') throw new Error('404 model not enabled'); return reply('{"verdict":"pass"}')(m, ...rest); }, router: R, pinned: true, rulesText: 'RULES' });
  assert.equal(down.admitted, false);
  assert.deepEqual(down.why, ['only 2 model families returned a verdict; three are required', 'context-aided (claude-haiku-5-5) returned no verdict: 404 model not enabled']);
  const noId = await review({ repo: dir, base: baseSha, head, complete: async (m, ...rest) => ({ ...(await reply('{"verdict":"pass"}')(m, ...rest)), responseId: m.family === 'openai' ? '' : 'x' }), router: R, pinned: true, rulesText: 'RULES' });
  assert.equal(noId.admitted, false, 'a verdict with no provider response id cannot be traced to a real call');
  const reviewsDir = join(dir, 'reviews');
  mkdirSync(reviewsDir);
  writeFileSync(join(reviewsDir, `${head}.json`), JSON.stringify(ok));
  assert.deepEqual(reviewSpend(reviewsDir).map((r) => [r.kind, r.model, r.pass]), [['review', 'claude-haiku-5-5', null], ['review', 'gemini-3.5-flash-lite', null], ['review', 'gpt-oss-120b', null]]);
});

test('one-shot completions: Claude by rawPredict with the Vertex anthropic_version, others by chat completions', async () => {
  const R = router();
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return url.endsWith(':rawPredict') ? Response.json({ id: 'msg_1', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 } }) : Response.json({ id: 'chatcmpl-1', choices: [{ message: { content: 'yo' } }], usage: { prompt_tokens: 20, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } });
  }) as unknown as typeof fetch;
  const c = vertexComplete('proj-123', async () => 't', f);
  assert.deepEqual(await c(R.model('claude-haiku-5-5'), 's', 'u'), { text: 'hi', provider: 'vertex-anthropic', responseId: 'msg_1', inputTokens: 10, outputTokens: 2, cacheReadTokens: 5 });
  assert.equal(calls[0]!.url, 'https://aiplatform.googleapis.com/v1/projects/proj-123/locations/global/publishers/anthropic/models/claude-haiku-5-5:rawPredict');
  assert.equal(calls[0]!.body.anthropic_version, 'vertex-2023-10-16');
  assert.equal(calls[0]!.body.model, undefined, 'the model is in the URL for rawPredict');
  assert.deepEqual(await c(R.model('gemini-3.5-flash-lite'), 's', 'u'), { text: 'yo', provider: 'vertex-openapi', responseId: 'chatcmpl-1', inputTokens: 16, outputTokens: 3, cacheReadTokens: 4 });
  assert.equal(calls[1]!.body.model, 'google/gemini-3.5-flash-lite');
});

test('no task is handed out after the deadline', async () => {
  const { dir, queue } = crewRepo([task('kill-mutant', '1'), task('kill-mutant', '2', 2)]);
  let clock = new Date('2026-11-28T06:00:00Z');
  const d = deps(dir, queue, { deadline: new Date('2026-11-28T06:15:00Z'), now: () => clock, worker: async () => ((clock = new Date('2026-11-28T06:16:00Z')), blank), perTask: 1 });
  const s = await dispatch(d);
  assert.equal(s.attempts.length, 1);
  assert.equal(s.stopped, 'deadline 2026-11-28T06:15:00.000Z');
});

test('the gate runs as tools/mutation/accept.ts on the task, under the prefix, with credentials scrubbed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prefix-'));
  const spy = join(dir, 'spy.mjs');
  writeFileSync(spy, "console.log(JSON.stringify({ outcome: 'pass', argv: process.argv.slice(2), env: Object.keys(process.env).filter((k) => /GOOGLE|ACTIONS|CREW|GITHUB_TOKEN/.test(k)) }));");
  const saved = { ...process.env };
  Object.assign(process.env, { GOOGLE_APPLICATION_CREDENTIALS: '/c.json', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't', CREW_ACCEPT_PREFIX: 'ignored-when-given' });
  try {
    const r = runAcceptance('intent/factory/queue/mutation/geo-1.json', { prefix: `${process.execPath} ${spy}` });
    assert.equal(r.ok, true);
    const v = r.verdict as { argv: string[]; env: string[] };
    assert.deepEqual(v.argv.slice(1), [join(ROOT, 'tools/mutation/accept.ts'), 'intent/factory/queue/mutation/geo-1.json']);
    assert.equal(v.argv[0], process.execPath);
    assert.deepEqual(v.env, []);
  } finally {
    for (const k of ['GOOGLE_APPLICATION_CREDENTIALS', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'CREW_ACCEPT_PREFIX']) if (saved[k] === undefined) delete process.env[k];
  }
});
