import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentsCli } from '../src/agents/cli.ts';
import { DUTIES, PERSON_ONLY, REQUIRED_CHECKS } from '../src/agents/duties.ts';
import { reference } from '../src/agents/guide.ts';
import { fileTicket, ledgerOf, proposals, verifyLog, type Session } from '../src/agents/ledger.ts';
import { call, toolsFor, TOOLS, type Context, type Result } from '../src/agents/tools.ts';
import { prepare } from '../src/pipeline.ts';
import { release } from '../src/release.ts';
import { init } from '../src/workspace.ts';

const fixture = (n: string) => new URL(`fixtures/${n}`, import.meta.url).pathname;

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 10, 26, 12, 0, tick++)).toISOString();

function world() {
  const ws = mkdtempSync(join(tmpdir(), 'zthr-agents-'));
  init(ws, [fixture('rough.md')]);
  const ledger = ledgerOf(ws, clock);
  const as = (role: Session['role'], family: string, agent = `${role}-${family}`, extra: Partial<Context> = {}): Context => ({ workspace: ws, ledger, session: { role, family, agent }, ...extra });
  return { ws, ledger, as };
}

/** A workspace read by two families and released once, ready to build to. */
function released() {
  const w = world();
  copyFileSync(fixture('reading-a.json'), join(w.ws, 'readings', 'gemini.json'));
  copyFileSync(fixture('reading-b.json'), join(w.ws, 'readings', 'claude.json'));
  const r = call(w.as('steward', 'anthropic'), 'release_issue', {});
  assert.ok(r.ok, JSON.stringify(r));
  return w;
}

/** A git checkout of a stand-in factory, on one clean commit. */
function factory() {
  const dir = mkdtempSync(join(tmpdir(), 'zthr-factory-'));
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  git('init', '-q');
  writeFileSync(join(dir, 'README.md'), 'factory\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  const base = git('rev-parse', 'HEAD');
  mkdirSync(join(dir, 'apps'), { recursive: true });
  writeFileSync(join(dir, 'apps', 'a.ts'), 'export {};\n');
  git('add', '.');
  git('commit', '-qm', 'two');
  return { dir, base, head: git('rev-parse', 'HEAD'), git };
}

const v = (r: Result): unknown => {
  assert.ok(r.ok, JSON.stringify(r));
  return r.ok ? r.value : undefined;
};

const refusedWith = (r: ReturnType<typeof call>, re: RegExp) => {
  assert.equal(r.ok, false, `expected a refusal, got ${JSON.stringify(r)}`);
  assert.ok(!r.ok && r.refused, JSON.stringify(r));
  assert.match((r as { why: string }).why, re);
};

/** Open a change, run every check passing, and have two other families pass it. */
function admitted(w: ReturnType<typeof released>) {
  const f = factory();
  const b = w.as('builder', 'anthropic', 'builder-1', { factory: f.dir, run: () => ({ exit: 0, out: 'ok' }) });
  const o = call(b, 'change_open', { title: 'Bills page', commit: f.head, paths: ['apps/a.ts'] });
  assert.ok(o.ok);
  const change = (v(o) as { change: string }).change;
  assert.ok(call(b, 'checks_run', { change }).ok);
  for (const fam of ['google', 'openai']) assert.ok(call(w.as('reviewer', fam), 'review_submit', { change, verdict: 'pass', checked: ['gauge bills-on-time'], findings: [] }).ok);
  return { change, f, b };
}

test('every role sees only its own tools, and each denial names the test that proves it', () => {
  for (const d of DUTIES) {
    const names = toolsFor(d.role).map((t) => t.name);
    assert.ok(names.includes('guide') && names.includes('status'), `${d.role} can orient itself`);
    for (const t of TOOLS) if (t.roles !== 'all' && !t.roles.includes(d.role)) assert.ok(!names.includes(t.name));
    assert.ok(d.denied.every((x) => x.provenBy === 'intent/test/agents.test.ts'));
  }
  assert.deepEqual(toolsFor('reader').map((t) => t.name).sort(), ['admission', 'guide', 'log', 'reading_context', 'reading_submit', 'status'].sort(), 'a reader sees nothing that shows another reading');
});

test('what only a person does has no tool at all', () => {
  const names = TOOLS.map((t) => t.name).join(' ');
  assert.doesNotMatch(names, /sign|lock|iam|credential|secret|approve|reset|people|answer_record/);
  assert.ok(PERSON_ONLY.length >= 6);
  assert.ok(!TOOLS.some((t) => JSON.stringify(t.input).includes('"ok"') && t.roles !== 'all' && (t.roles as string[]).includes('builder')), 'no builder tool takes a check result');
});

test('a reader reads once, for its own family, and is refused anything else', () => {
  const w = world();
  const r = w.as('reader', 'gemini');
  assert.match(String((v(call(r, 'reading_context')) as { prompt: string }).prompt), /independent readers/);
  const reading = JSON.parse(readFileSync(fixture('reading-a.json'), 'utf8'));
  refusedWith(call(w.as('reader', 'llama'), 'reading_submit', { reading }), /reads for llama, not gemini/);
  assert.ok(call(r, 'reading_submit', { reading }).ok);
  refusedWith(call(r, 'reading_submit', { reading }), /already read/);
  refusedWith(call(r, 'questions', {}), /a reader does not questions/);
  refusedWith(call(r, 'schematic', {}), /a reader does not/);
});

test('a steward drafts answers; only a listed person signs them into the intent', () => {
  const w = world();
  copyFileSync(fixture('reading-a.json'), join(w.ws, 'readings', 'gemini.json'));
  const s = w.as('steward', 'anthropic');
  const qs = (v(call(s, 'questions', { budget: 3 })) as { questions: { id: string; choices: string[] }[] }).questions;
  assert.ok(qs.length > 0);
  const q = qs[0]!;
  const r = call(s, 'answer_suggest', { question: q.id, answer: q.choices.length ? { pick: q.choices[0]! } : { yes: true }, source: 'rough.md, line 1' });
  assert.ok(r.ok);
  const id = (v(r) as { proposal: string }).proposal;
  assert.equal(readFileSync(join(w.ws, 'answers.json'), 'utf8').trim(), '{}', 'a drafted answer changes nothing');
  refusedWith(call(s, 'answer_suggest', { question: 'nope', answer: { yes: true }, source: 'x' }), /no open question/);

  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(agentsCli(['sign', id, '--workspace', w.ws, '--by', 'someone@example.com']), 1, 'nobody signs until a person lists who may');
    writeFileSync(join(w.ws, 'agents', 'people.json'), JSON.stringify({ signers: ['russ@example.com'] }));
    assert.equal(agentsCli(['sign', id, '--workspace', w.ws, '--by', 'agent@example.com']), 1, 'someone not listed is refused');
  } finally {
    console.error = quiet;
  }
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(agentsCli(['sign', id, '--workspace', w.ws, '--by', 'russ@example.com']), 0);
  } finally {
    console.log = log;
  }
  assert.ok(JSON.parse(readFileSync(join(w.ws, 'answers.json'), 'utf8'))[q.id], 'once signed, it is the person’s answer');
});

test('a revision after the first must say why', () => {
  const w = released();
  refusedWith(call(w.as('steward', 'anthropic'), 'release_issue', {}), /must say why/);
  assert.ok(call(w.as('steward', 'anthropic'), 'release_issue', { reason: 'answers settled' }).ok);
});

test('every package carries a brief for the factory’s agents', () => {
  const files = [{ path: 'rough.md', text: readFileSync(fixture('rough.md'), 'utf8') }];
  const p = prepare({ files, readings: [JSON.parse(readFileSync(fixture('reading-a.json'), 'utf8')), JSON.parse(readFileSync(fixture('reading-b.json'), 'utf8'))] });
  const a = release(p, { revision: 1 }).files['AGENTS.md']!;
  assert.equal(a, release(p, { revision: 1 }).files['AGENTS.md'], 'the same intent gives the same brief: it is hashed');
  assert.match(a, /## What counts as done/);
  assert.match(a, /## The gauges that judge it/);
  assert.match(a, /control\/journeys\//);
});

test('a builder may not touch a locked, person or generated path, and a proven one must be re-proved', () => {
  const w = released();
  const b = w.as('builder', 'anthropic');
  refusedWith(call(b, 'change_open', { title: 'x', commit: 'abcdef1', paths: ['src/a.ts', 'control/journeys/x.yaml'] }), /no agent writes control\/journeys\/x\.yaml \(locked\)/);
  refusedWith(call(b, 'change_open', { title: 'x', commit: 'abcdef1', paths: ['control/ratchets.json'] }), /\(person\)/);
  refusedWith(call(b, 'change_open', { title: 'x', commit: 'abcdef1', paths: ['docs/testing/gates.md'] }), /\(generated\)/);
  const r = call(b, 'change_open', { title: 'x', commit: 'abcdef1', paths: ['tools/gates.ts'] });
  assert.ok(r.ok);
  assert.deepEqual((v(r) as { reprove: string[] }).reprove, ['tools/gates.ts']);
  const t = v(call(b, 'path_tier', { paths: ['control/lock.json', 'apps/x.ts'] })) as { paths: { writable: boolean }[] };
  assert.deepEqual(t.paths.map((x) => x.writable), [false, true]);
});

test('checks run on the change’s own commit, by the API; nobody reports a result', () => {
  const w = released();
  const f = factory();
  const open = (ctx: Context) => (v(call(ctx, 'change_open', { title: 'x', commit: f.head, paths: ['apps/a.ts'] })) as { change: string }).change;
  const bare = w.as('builder', 'anthropic');
  const change = open(bare);
  refusedWith(call(bare, 'checks_run', { change }), /no factory checkout/);
  const other = w.as('builder', 'anthropic', 'b', { factory: f.dir, run: () => ({ exit: 0, out: '' }) });
  const wrong = (v(call(other, 'change_open', { title: 'x', commit: 'abcdef1234', paths: ['apps/a.ts'] })) as { change: string }).change;
  refusedWith(call(other, 'checks_run', { change: wrong }), /not abcdef1234/);
  writeFileSync(join(f.dir, 'dirty.txt'), 'x');
  refusedWith(call(other, 'checks_run', { change }), /uncommitted/);
  spawnSync('rm', [join(f.dir, 'dirty.txt')]);
  mkdirSync(join(f.dir, 'control', 'journeys'), { recursive: true });
  writeFileSync(join(f.dir, 'control', 'journeys', 'easier.yaml'), 'goal: anything\n');
  writeFileSync(join(f.dir, 'apps', 'a.ts'), 'export const x = 1;\n');
  f.git('add', '.');
  f.git('commit', '-qm', 'quietly loosen a goal');
  const sly = f.git('rev-parse', 'HEAD');
  const hidden = v(call(other, 'change_open', { title: 'x', commit: sly, base: f.head, paths: ['apps/a.ts'] })) as { change: string };
  refusedWith(call(other, 'checks_run', { change: hidden.change }), /does not declare: control\/journeys\/easier\.yaml/);
  f.git('reset', '-q', '--hard', f.head);
  const failing = w.as('builder', 'anthropic', 'b', { factory: f.dir, run: (step) => ({ exit: step === 'walk' ? 1 : 0, out: step === 'walk' ? 'journey bills-on-time: over budget' : '' }) });
  const r = v(call(failing, 'checks_run', { change })) as { results: { ok: boolean; tail?: string }[]; admission: { blocking: string[] } };
  assert.equal(r.results.length, REQUIRED_CHECKS.length);
  assert.ok(r.admission.blocking.some((x) => /browser walk/.test(x)));
  assert.match(r.results.find((x) => !x.ok)!.tail!, /over budget/, 'a failure says why, in the check’s own words');
});

test('reviews come from other families, say what was checked, and admission is computed', () => {
  const w = released();
  const f = factory();
  const b = w.as('builder', 'anthropic', 'builder-1', { factory: f.dir, run: () => ({ exit: 0, out: '' }) });
  const change = (v(call(b, 'change_open', { title: 'x', commit: f.head, paths: ['apps/a.ts'] })) as { change: string }).change;
  call(b, 'checks_run', { change });
  refusedWith(call(b, 'review_submit', { change, verdict: 'pass', checked: ['all'], findings: [] }), /a builder does not review_submit/);
  refusedWith(call(w.as('reviewer', 'anthropic', 'other'), 'review_submit', { change, verdict: 'pass', checked: ['all'], findings: [] }), /anthropic wrote this change/);
  refusedWith(call(w.as('reviewer', 'anthropic', 'builder-1'), 'review_submit', { change, verdict: 'pass', checked: ['all'], findings: [] }), /you wrote this change/);
  const g = w.as('reviewer', 'google');
  refusedWith(call(g, 'review_submit', { change, verdict: 'pass', checked: [], findings: [] }), /not a review/);
  refusedWith(call(g, 'review_submit', { change, verdict: 'block', checked: ['x'], findings: [{ what: 'nit', severity: 'minor' }] }), /blocking finding/);
  assert.ok(call(g, 'review_submit', { change, verdict: 'pass', checked: ['the bills gauge'], findings: [] }).ok);
  refusedWith(call(w.as('reviewer', 'google', 'g2'), 'review_submit', { change, verdict: 'pass', checked: ['x'], findings: [] }), /already reviewed/);
  assert.equal((v(call(g, 'admission', { change })) as { admitted: boolean }).admitted, false, 'one family is not enough');
  assert.deepEqual(toolsFor('reviewer').map((t) => t.name).includes('review_queue'), true);
  assert.ok(call(w.as('reviewer', 'openai'), 'review_submit', { change, verdict: 'pass', checked: ['the schema migration'], findings: [] }).ok);
  assert.equal((v(call(g, 'admission', { change })) as { admitted: boolean }).admitted, true);
  assert.ok(!TOOLS.some((t) => /admit/.test(t.name) && t.kind !== 'read'), 'no tool admits');
});

test('delivery goes stage by stage, results come from the pipeline, and release needs a person', () => {
  const w = released();
  const op = w.as('operator', 'anthropic');
  const pipe = w.as('pipeline', 'cloud-build', 'build-sa');
  const f = factory();
  const b = w.as('builder', 'anthropic', 'builder-1', { factory: f.dir, run: () => ({ exit: 0, out: '' }) });
  const early = (v(call(b, 'change_open', { title: 'x', commit: f.head, paths: ['apps/a.ts'] })) as { change: string }).change;
  refusedWith(call(op, 'deploy_advance', { change: early, stage: 'build' }), /not admitted/);
  const { change } = admitted(w);
  refusedWith(call(op, 'deploy_advance', { change, stage: 'test' }), /next stage .* is build/);
  assert.ok(call(op, 'deploy_advance', { change, stage: 'build' }).ok);
  refusedWith(call(op, 'deploy_advance', { change, stage: 'test' }), /already requested/);
  refusedWith(call(op, 'stage_record', { change, stage: 'build', ok: true, build: 'b1' }), /an operator does not stage_record/);
  refusedWith(call(pipe, 'deploy_advance', { change, stage: 'test' }), /a pipeline does not/);
  refusedWith(call(pipe, 'stage_record', { change, stage: 'test', ok: true, build: 'b1' }), /was not requested/);
  for (const stage of ['build', 'test', 'data', 'package', 'deploy', 'canary']) {
    if (stage !== 'build') assert.ok(call(op, 'deploy_advance', { change, stage }).ok, stage);
    if (stage === 'canary') refusedWith(call(op, 'production_request', { change, evidence: 'x' }), /canary has not passed/);
    assert.ok(call(pipe, 'stage_record', { change, stage, ok: true, build: `b-${stage}` }).ok);
  }
  refusedWith(call(op, 'deploy_advance', { change, stage: 'release' }), /named person/);
  const pr = call(op, 'production_request', { change, evidence: '5% for 2 hours; availability 99.97%, latency 98.2% under budget' });
  assert.ok(pr.ok);
  writeFileSync(join(w.ws, 'agents', 'people.json'), JSON.stringify({ signers: ['russ@example.com'] }));
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(agentsCli(['sign', (v(pr) as { proposal: string }).proposal, '--workspace', w.ws, '--by', 'russ@example.com']), 0);
  } finally {
    console.log = log;
  }
  assert.ok(call(op, 'deploy_advance', { change, stage: 'release' }).ok);
  assert.ok(call(op, 'deploy_rollback', { change, why: 'availability burning at 14x' }).ok, 'going back is always allowed');
  refusedWith(call(op, 'deploy_advance', { change, stage: 'release' }), /next stage .* is build/);
});

test('a triager sorts reports but cannot rewrite them, resolve without evidence, or change the intent', () => {
  const w = world();
  fileTicket(w.ledger, { id: 't1', by: 'uid-1', kind: 'bug', title: 'Bill shows twice', happened: 'Two rows for rent', expected: 'One' });
  fileTicket(w.ledger, { id: 't2', by: 'uid-2', kind: 'bug', title: 'Rent twice', happened: 'Same' });
  fileTicket(w.ledger, { id: 't3', by: 'uid-3', kind: 'idea', title: 'Remind me the day before' });
  const t = w.as('triager', 'anthropic');
  refusedWith(call(t, 'ticket_triage', { ticket: 't1', title: 'Duplicate bill row' }), /title is not an input/);
  refusedWith(call(t, 'ticket_triage', { ticket: 't2', status: 'duplicate' }), /names another report/);
  assert.ok(call(t, 'ticket_triage', { ticket: 't2', status: 'duplicate', duplicateOf: 't1' }).ok);
  assert.ok(call(t, 'ticket_triage', { ticket: 't1', status: 'triaged', severity: 'high' }).ok);
  refusedWith(call(t, 'ticket_triage', { ticket: 't1', status: 'resolved' }), /needs evidence/);
  refusedWith(call(t, 'ticket_triage', { ticket: 't1', status: 'resolved', evidence: 'commit abc1234' }), /failed and now passes/);
  assert.ok(call(t, 'ticket_defect', { ticket: 't1', test: 'a bill is listed once', expectation: 'One row per bill in a period' }).ok);
  assert.equal((v(call(w.as('builder', 'x'), 'defects')) as { defects: unknown[] }).defects.length, 1);
  assert.ok(call(t, 'ticket_triage', { ticket: 't1', status: 'resolved', evidence: 'commit abc1234' }).ok);
  refusedWith(call(t, 'ticket_defect', { ticket: 't3', test: 'x', expectation: 'y' }), /idea, not a bug/);
  const idea = call(t, 'ticket_idea', { ticket: 't3', change: 'Add a reminder the day before a bill is due' });
  assert.ok(idea.ok);
  assert.equal(proposals(w.ledger).find((p) => p.id === (v(idea) as { proposal: string }).proposal)!.kind, 'intent');
  const listed = v(call(t, 'tickets_list', {})) as { tickets: { id: string; title: string; status: string }[] };
  assert.equal(listed.tickets.find((x) => x.id === 't1')!.title, 'Bill shows twice', 'the reporter’s words are kept');
});

test('nothing credential-shaped gets in, and every call goes into a chain that shows tampering', () => {
  const w = world();
  const s = w.as('steward', 'anthropic');
  refusedWith(call(s, 'answer_suggest', { question: 'q', answer: { other: ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz'].join('-') }, source: 'x' }), /Anthropic key/);
  call(s, 'status');
  call(s, 'nonexistent');
  const v = verifyLog(w.ledger);
  assert.deepEqual(v, { ok: true, lines: 3 });
  const p = join(w.ledger.dir, 'log.jsonl');
  const lines = readFileSync(p, 'utf8').split('\n');
  lines[0] = lines[0]!.replace('"refused"', '"ok"');
  writeFileSync(p, lines.join('\n'));
  assert.deepEqual(verifyLog(w.ledger), { ok: false, at: 1 }, 'a refusal rewritten as allowed breaks the chain');
  writeFileSync(p, readFileSync(p, 'utf8').split('\n').slice(1).join('\n'));
  assert.equal(verifyLog(w.ledger).ok, false, 'so does a removed line');
});

test('the tool reference is generated from the registry and kept fresh', () => {
  const doc = readFileSync(new URL('../docs/agents-tools.md', import.meta.url), 'utf8');
  assert.equal(doc, reference(), 'run: node -e "import(\'./src/agents/guide.ts\').then(g=>process.stdout.write(g.reference()))" > docs/agents-tools.md');
});

test('the API speaks MCP on standard input and output, with the session fixed by whoever starts it', async () => {
  const w = released();
  const child = spawn(process.execPath, [new URL('../src/cli.ts', import.meta.url).pathname, 'agents', 'serve', '--workspace', w.ws, '--role', 'builder', '--family', 'anthropic', '--agent', 'b1'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
  const got: Record<string, unknown>[] = [];
  const want = 5;
  const done = new Promise<void>((resolve) => {
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      const parts = buf.split('\n');
      buf = parts.pop()!;
      for (const x of parts) if (x.trim()) got.push(JSON.parse(x) as Record<string, unknown>);
      if (got.length >= want) resolve();
    });
  });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'build_plan', arguments: {} } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'review_submit', arguments: {} } });
  send({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'zthr://guide' } });
  await done;
  child.stdin.end();
  const by = (id: number) => got.find((x) => x['id'] === id)!['result'] as Record<string, unknown>;
  assert.equal((by(1) as { protocolVersion: string }).protocolVersion, '2025-06-18');
  const names = (by(2) as { tools: { name: string }[] }).tools.map((t) => t.name);
  assert.ok(names.includes('change_open') && !names.includes('review_submit') && !names.includes('deploy_advance'));
  assert.equal((by(3) as { isError: boolean }).isError, false);
  assert.ok(((by(3) as { structuredContent: { lines: unknown[] } }).structuredContent.lines.length) > 0);
  assert.equal((by(4) as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(by(4)), /a builder does not review_submit/);
  assert.match((by(5) as { contents: { text: string }[] }).contents[0]!.text, /# Working in the ZTHR factory: builder/);
});
