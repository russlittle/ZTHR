/**
 * The crew's dispatcher. Takes work orders from the queue in order (fix-bug, then kill-mutant, then simplify), asks
 * the router for the cheapest model proven good enough at the task's level, runs it (the harness for open and Gemini
 * models, Claude Code headless for Claude), runs the gate itself, keeps the change only on a pass and otherwise
 * restores the files, records every attempt to intent/factory/results.jsonl, and stops when the day's budget is
 * spent. It never commits; the workflow does, after it.
 *
 *   node tools/crew/dispatch.ts [--budget-usd 5] [--max-tasks N] [--per-task 3] [--deadline ISO] [--project P] [--dry-run] [--report]
 *
 * --dry-run lists what would be handed out, to which model, at what estimated cost, and runs nothing.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { round, type Choice, type Model, type Router } from '../../intent/blocks/router/index.ts';
import { Sandbox, record, runAgent, vertexChat, type AgentRun, type Chat, type Task } from './harness.ts';
import { ROOT, acceptanceCommand, adaptPrompt, appendResult, gcloudToken, git, openRouter, openapiBase, readResults, reviewSpend, runAcceptance, taskKey, today, type CrewResult } from './lib.ts';
import { firstJson, vertexComplete, type Complete } from './models.ts';
import { morningReport, writeReport } from './report.ts';

const RANK: Record<string, number> = { 'fix-bug': 0, 'kill-mutant': 1, simplify: 2 };

/** What a worker reports back, whichever runner ran it. */
export type WorkerRun = Pick<AgentRun, 'stop' | 'steps' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'costUsd' | 'responseIds' | 'summary' | 'equivalent' | 'noSimplification' | 'error'> & { cacheWriteTokens?: number };
export type Worker = (task: Task, taskFile: string, m: Model, o: { maxUsd: number; router: Router; root: string }) => Promise<WorkerRun>;
export type Gate = (taskFile: string) => { ok: boolean; output: string; verdict?: Record<string, unknown> };

export interface Deps {
  root: string;
  queue: string;
  router: Router;
  budgetUsd: number;
  workers: Partial<Record<Model['runner'], Worker>>;
  gate: Gate;
  /** Records a result line; the default appends to results.jsonl. */
  write: (r: CrewResult) => void;
  /** Results recorded before this run (today's spending and each task's failures). */
  prior: CrewResult[];
  /** A one-shot completion for judging an equivalence claim. */
  complete?: Complete;
  /** Records an equivalence ruling or a standing ruling with tools/mutation/equivalent.ts. */
  rule?: (args: string[]) => { ok: boolean; output: string };
  maxTasks?: number;
  perTask?: number;
  /** No task is handed out after this moment (so the commit lands before the no-push window). */
  deadline?: Date;
  now?: () => Date;
  log?: (line: Record<string, unknown>) => void;
}

export interface Attempt {
  task: string;
  file: string;
  kind: string;
  model: string;
  level: string;
  why: string;
  outcome: string;
  pass: boolean | null;
  costUsd: number;
}

export interface Summary {
  date: string;
  budgetUsd: number;
  spentUsd: number;
  stopped: string;
  attempts: Attempt[];
  fixed: string[];
  parked: string[];
  skipped: { file: string; why: string }[];
}

export { taskKey };

export function queueOrder(queue: string): string[] {
  if (!existsSync(queue)) return [];
  const tasks = readdirSync(queue)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f: join(queue, f), t: JSON.parse(readFileSync(join(queue, f), 'utf8')) as Task & { mutant: { line?: number } } }));
  tasks.sort((a, b) => (RANK[a.t.kind] ?? 9) - (RANK[b.t.kind] ?? 9) || (a.t.mutant.line ?? 0) - (b.t.mutant.line ?? 0) || a.f.localeCompare(b.f));
  return tasks.map((x) => x.f);
}

const hash = (s: string) => createHash('sha1').update(s).digest('hex');

/** Every path that differs from HEAD, with its content, so anything a worker touched outside mayEdit can be put back. */
export function snapshot(root: string): Map<string, string | undefined> {
  const out = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root).out;
  const parts = out.split('\0').filter(Boolean);
  const m = new Map<string, string | undefined>();
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const path = p.slice(3);
    if (p[0] === 'R' || p[0] === 'C') i++;
    const abs = join(root, path);
    m.set(path, existsSync(abs) ? readFileSync(abs, 'utf8') : undefined);
  }
  return m;
}

/** Puts back every path outside mayEdit (and outside the gate's own queue writes) that changed since `before`. */
export function restoreOutside(root: string, before: Map<string, string | undefined>, mayEdit: string[], keep: (p: string) => boolean): string[] {
  const after = snapshot(root);
  const restored: string[] = [];
  for (const p of new Set([...before.keys(), ...after.keys()])) {
    if (mayEdit.includes(p) || keep(p)) continue;
    const was = before.get(p);
    const now = after.get(p);
    if (before.has(p) && after.has(p) && (was === undefined ? now === undefined : now !== undefined && hash(was) === hash(now))) continue;
    const abs = join(root, p);
    if (before.has(p)) {
      if (was === undefined) rmSync(abs, { force: true });
      else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, was);
      }
    } else if (git(['cat-file', '-e', `HEAD:${p}`], root).ok) git(['checkout', 'HEAD', '--', p], root);
    else rmSync(abs, { force: true, recursive: true });
    restored.push(p);
  }
  return restored;
}

const JUDGE_SYSTEM = 'You judge claims that a code mutant is equivalent: that no input can tell the mutated program from the original. Most such claims are wrong. Reply with one JSON object: {"verdict": "equivalent" | "not-equivalent" | "unsure", "reason": "...", "counterexample": "an input that tells them apart, if any"}.';

export async function dispatch(d: Deps): Promise<Summary> {
  const log = d.log ?? (() => {});
  const date = today();
  const results: CrewResult[] = [...d.prior];
  const s: Summary = { date, budgetUsd: d.budgetUsd, spentUsd: 0, stopped: 'queue empty', attempts: [], fixed: [], parked: [], skipped: [] };
  const left = () => d.router.budgetLeft(d.budgetUsd, results);
  const runners = Object.keys(d.workers) as Model['runner'][];
  const staleBlocks = new Set<string>();
  const order = queueOrder(d.queue);
  let handed = 0;
  const save = (r: CrewResult) => {
    results.push(r);
    d.write(r);
    s.spentUsd = round(s.spentUsd + r.costUsd);
  };

  for (let i = 0; i < order.length; i++) {
    const file = order[i]!;
    if (d.maxTasks !== undefined && handed >= d.maxTasks) {
      s.stopped = `max tasks (${d.maxTasks})`;
      break;
    }
    if (d.deadline && (d.now ?? (() => new Date()))() >= d.deadline) {
      s.stopped = `deadline ${d.deadline.toISOString()}`;
      break;
    }
    if (!existsSync(file)) continue;
    const rel = file.replace(`${d.root}/`, '');
    let task = JSON.parse(readFileSync(file, 'utf8')) as Task;
    if (staleBlocks.has(task.block)) {
      s.skipped.push({ file: rel, why: `${task.block}/index.ts changed this run; line numbers moved, the night shift re-finds` });
      continue;
    }
    const key = taskKey(task);
    handed++;
    let passed = false;
    for (let attempt = 0; attempt < (d.perTask ?? 3) && !passed; attempt++) {
      const failed = results.filter((r) => r.task === key && r.pass === false);
      const c = d.router.choose(task.kind, task.budgetTokens, left(), { failures: failed.length, runners, avoid: failed.map((r) => r.model) });
      if (c.stop) {
        if (c.reason === 'budget') {
          s.stopped = `budget: ${c.detail}`;
          log({ event: 'stop', reason: c.detail });
          return s;
        }
        if (c.reason === 'parked') s.parked.push(rel);
        else s.skipped.push({ file: rel, why: c.detail });
        log({ event: c.reason, task: rel, detail: c.detail });
        break;
      }
      const out = await attemptOnce(d, task, file, rel, key, c, left());
      save(out.result);
      s.attempts.push({ task: key, file: rel, kind: task.kind, model: c.model.id, level: c.level, why: c.why, outcome: out.result.outcome, pass: out.result.pass, costUsd: out.result.costUsd });
      for (const j of out.extra) save(j);
      log({ event: 'attempt', task: rel, model: c.model.id, level: c.level, why: c.why, outcome: out.result.outcome, costUsd: out.result.costUsd });
      if (out.result.outcome === 'pass') {
        passed = true;
        s.fixed.push(rel);
        const done = join(d.queue, 'done');
        mkdirSync(done, { recursive: true });
        renameSync(file, join(done, file.split('/').pop()!));
        if (task.kind !== 'kill-mutant') staleBlocks.add(task.block);
      } else if (out.followUp) {
        order.splice(i + 1, 0, join(d.root, out.followUp)); // the fix-bug task the gate wrote goes next
        break;
      } else if (out.result.pass === null) break; // a claim or a neutral end: nothing to retry tonight
      if (!passed) task = JSON.parse(readFileSync(file, 'utf8')) as Task;
    }
  }
  if (s.stopped === 'queue empty' && order.length) s.stopped = 'queue done';
  return s;
}

async function attemptOnce(d: Deps, task: Task, file: string, rel: string, key: string, c: Choice, leftUsd: number): Promise<{ result: CrewResult; extra: CrewResult[]; followUp?: string }> {
  const m = c.model;
  const before = snapshot(d.root);
  const mayEditBefore = new Map(task.mayEdit.map((f) => [f, existsSync(join(d.root, f)) ? readFileSync(join(d.root, f), 'utf8') : undefined]));
  // The gate's scope check is relative to this baseline: earlier accepted, uncommitted work is not this worker's.
  const baseline = Object.fromEntries([...before].filter(([p]) => !p.startsWith('intent/eval/mutation/') && !p.startsWith('intent/factory/queue/mutation/')).map(([p, t]) => [p, t === undefined ? 'deleted' : hash(t)]));
  task.baseline = baseline;
  writeFileSync(file, JSON.stringify(task, null, 2) + '\n');
  const started = Date.now();
  const worker = d.workers[m.runner]!;
  let run: WorkerRun;
  try {
    run = await worker(task, rel, m, { maxUsd: Math.min(leftUsd, Math.max(c.estCostUsd * 2, 0.05)), router: d.router, root: d.root });
  } catch (e) {
    run = { stop: 'error', steps: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, responseIds: [], summary: '', error: (e as Error).message };
  }
  const keep = (p: string) => p.startsWith('intent/factory/queue/mutation/');
  const restored = restoreOutside(d.root, before, task.mayEdit, keep);
  const extra: CrewResult[] = [];
  const base = { level: c.level, why: c.why, durationMs: Date.now() - started, file: rel };
  const restoreMayEdit = () => {
    for (const [f, text] of mayEditBefore) {
      const abs = join(d.root, f);
      if (text === undefined) rmSync(abs, { force: true });
      else writeFileSync(abs, text);
    }
  };
  const changed = task.mayEdit.some((f) => (existsSync(join(d.root, f)) ? readFileSync(join(d.root, f), 'utf8') : undefined) !== mayEditBefore.get(f));

  if (run.stop === 'error' && !changed) {
    return { result: { ...record(task, rel, m, run, { outcome: 'error', pass: null, reasons: [run.error ?? 'worker error'] }), task: key, ...base }, extra };
  }

  // An equivalence claim with nothing written goes to a judge of another family.
  if (run.equivalent && !changed && task.kind === 'kill-mutant' && d.complete && d.rule) {
    const j = d.router.chooseJudge(m.family, 20_000, leftUsd - run.costUsd);
    if (j.stop) return { result: { ...record(task, rel, m, run, { outcome: 'equivalent-claimed', pass: null, reasons: [`no judge: ${j.detail}`] }), task: key, ...base }, extra };
    const got = await d.complete(j.model, JUDGE_SYSTEM, `${task.prompt}\n\nThe worker (${m.id}) claims this mutant is equivalent:\n${run.equivalent.argument}`, 2000).catch((e: Error) => e);
    if (got instanceof Error) return { result: { ...record(task, rel, m, run, { outcome: 'equivalent-claimed', pass: null, reasons: [`judge failed: ${got.message}`] }), task: key, ...base }, extra };
    const v = String(firstJson(got.text)?.verdict ?? 'unsure');
    const verdict = ['equivalent', 'not-equivalent', 'unsure'].includes(v) ? v : 'unsure';
    const judgeCost = d.router.cost(j.model.id, { inputTokens: got.inputTokens, outputTokens: got.outputTokens, cacheReadTokens: got.cacheReadTokens });
    extra.push({ at: new Date().toISOString(), task: `${key}:judge`, kind: 'judge', block: task.block, model: j.model.id, family: j.model.family, runner: j.model.runner, pass: null, outcome: `verdict ${verdict}`, inputTokens: got.inputTokens, outputTokens: got.outputTokens, costUsd: judgeCost, responseIds: [got.responseId] });
    const r = d.rule([task.block, task.mutant.id, '--argument', run.equivalent.argument, '--by', m.vertexId, '--judge', j.model.vertexId, '--verdict', verdict]);
    return { result: { ...record(task, rel, m, run, { outcome: verdict === 'equivalent' ? 'ruled-equivalent' : 'equivalence-disputed', pass: verdict === 'equivalent' ? null : false, reasons: r.ok ? [] : [r.output.slice(0, 300)] }), task: key, ...base }, extra };
  }
  if (run.noSimplification && !changed && task.kind === 'simplify' && d.rule) {
    const r = d.rule(['--stands', task.block, task.mutant.id, '--reason', run.noSimplification, '--by', m.vertexId]);
    return { result: { ...record(task, rel, m, run, { outcome: r.ok ? 'no-simplification' : 'rejected', pass: r.ok ? null : false, reasons: r.ok ? [] : [r.output.slice(0, 300)] }), task: key, ...base }, extra };
  }

  const g = d.gate(rel);
  const outcome = String(g.verdict?.outcome ?? (g.ok ? 'pass' : 'rejected'));
  const reasons = [...((g.verdict?.reasons as string[] | undefined) ?? []), ...(restored.length ? [`restored files outside mayEdit: ${restored.join(', ')}`] : [])];
  const followUp = typeof g.verdict?.followUp === 'string' ? g.verdict.followUp : undefined;
  if (!g.ok && outcome !== 'bug-found') restoreMayEdit();
  const pass = g.ok && outcome === 'pass' ? true : outcome === 'bug-found' ? null : false;
  return { result: { ...record(task, rel, m, run, { outcome: g.ok ? 'pass' : outcome, pass, reasons }), task: key, ...base, ...(run.cacheWriteTokens ? { cacheWriteTokens: run.cacheWriteTokens } : {}) }, extra, ...(followUp ? { followUp } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------
// Runners

/** The harness on Vertex's OpenAI-compatible endpoint. */
export const harnessWorker =
  (chatFor: (m: Model) => Chat, gate: Gate): Worker =>
  async (task, taskFile, m, o) => {
    const sandbox = new Sandbox(task, o.root, () => gate(taskFile));
    return runAgent(task, taskFile, { chat: chatFor(m), model: m, router: o.router, sandbox });
  };

/** The argv for Claude Code headless on one task: its tools confined to the task's files and its gate. */
export function claudeArgs(task: Task, taskFile: string, m: Model, maxUsd: number): string[] {
  const files = task.mayEdit.map((f) => `./${f}`);
  return [
    '-p',
    '--model', m.vertexId,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'dontAsk',
    '--tools', 'Read,Glob,Grep,Edit,Write,Bash',
    '--allowedTools', 'Read', 'Glob', 'Grep', ...files.flatMap((f) => [`Edit(${f})`, `Write(${f})`]), `Bash(${acceptanceCommand(taskFile)})`,
    '--disallowedTools', 'WebFetch', 'WebSearch', 'Read(./gha-creds-*.json)', 'Read(./.git/**)',
    '--max-budget-usd', maxUsd.toFixed(2),
    '--no-session-persistence',
    '--strict-mcp-config',
  ];
}

/** The environment Claude Code gets: Vertex, the project, the model pinned for every alias, nothing else. */
export function claudeEnv(m: Model, project: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  // Google credentials stay (Claude Code authenticates with them); the gate wrapper scrubs them before running tests.
  const keep = Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && (k === 'CREW_ACCEPT_PREFIX' || !/^(ANTHROPIC_|CLAUDE_|CREW_|GITHUB_TOKEN$|GH_TOKEN$|ACTIONS_)/.test(k)))) as Record<string, string>;
  return {
    ...keep,
    CLAUDE_CODE_USE_VERTEX: '1',
    CLOUD_ML_REGION: m.location,
    ANTHROPIC_VERTEX_PROJECT_ID: project,
    ANTHROPIC_MODEL: m.vertexId,
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  };
}

/** Reads Claude Code's stream-json: per-request usage (so the long-context tier is priced per request) and ids. */
export function parseClaudeStream(stdout: string, m: Model, router: Router): Omit<WorkerRun, 'stop' | 'summary'> & { summary: string; isError: boolean; reportedUsd?: number } {
  const seen = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();
  let summary = '';
  let isError = false;
  let reportedUsd: number | undefined;
  let turns = 0;
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (ev.type === 'assistant') {
      const msg = ev.message as { id?: string; usage?: Record<string, number> } | undefined;
      if (msg?.id && msg.usage) seen.set(msg.id, { input: msg.usage.input_tokens ?? 0, output: msg.usage.output_tokens ?? 0, cacheRead: msg.usage.cache_read_input_tokens ?? 0, cacheWrite: msg.usage.cache_creation_input_tokens ?? 0 });
    }
    if (ev.type === 'result') {
      summary = String(ev.result ?? '').slice(0, 2000);
      isError = ev.is_error === true;
      if (typeof ev.total_cost_usd === 'number') reportedUsd = ev.total_cost_usd;
      if (typeof ev.num_turns === 'number') turns = ev.num_turns;
    }
  }
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, costUsd = 0;
  for (const u of seen.values()) {
    inputTokens += u.input;
    outputTokens += u.output;
    cacheReadTokens += u.cacheRead;
    cacheWriteTokens += u.cacheWrite;
    costUsd += router.cost(m.id, { inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite });
  }
  return { steps: turns || seen.size, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd: round(costUsd), responseIds: [...seen.keys()], summary, isError, ...(reportedUsd !== undefined ? { reportedUsd } : {}) };
}

export const claudeWorker =
  (project: string, bin = 'claude'): Worker =>
  async (task, taskFile, m, o) => {
    const r = spawnSync(bin, claudeArgs(task, taskFile, m, o.maxUsd), { cwd: o.root, input: adaptPrompt(task.prompt, taskFile, 'command'), encoding: 'utf8', env: claudeEnv(m, project), timeout: 45 * 60_000, maxBuffer: 256 * 1024 * 1024 });
    const p = parseClaudeStream(r.stdout ?? '', m, o.router);
    const ok = r.status === 0 && !p.isError;
    const equivalent = /^EQUIVALENT:\s*([\s\S]+)/m.exec(p.summary)?.[1];
    const none = /^NO SIMPLIFICATION:\s*([\s\S]+)/m.exec(p.summary)?.[1];
    return { ...p, stop: ok ? 'finish' : 'error', ...(equivalent ? { equivalent: { argument: equivalent.trim() } } : {}), ...(none ? { noSimplification: none.trim() } : {}), ...(ok ? {} : { error: `claude exit ${r.status}: ${(r.stderr ?? '').slice(-400) || p.summary.slice(0, 400)}` }) };
  };

// ---------------------------------------------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);
  const val = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
  const budgetUsd = Number(val('budget-usd') ?? process.env.CREW_DAILY_BUDGET_USD ?? 0);
  const project = val('project') ?? process.env.GCP_PROJECT ?? '';
  const router = openRouter();
  const queue = join(ROOT, 'intent', 'factory', 'queue', 'mutation');
  const prior = [...readResults(), ...reviewSpend()];
  if (args.includes('--dry-run')) {
    let leftUsd = router.budgetLeft(budgetUsd, prior);
    console.log(`dry run: ${leftUsd.toFixed(4)} USD left of ${budgetUsd} today`);
    for (const f of queueOrder(queue)) {
      const t = JSON.parse(readFileSync(f, 'utf8')) as Task;
      const failures = prior.filter((r) => r.task === taskKey(t) && r.pass === false).length;
      const c = router.choose(t.kind, t.budgetTokens, leftUsd, { failures });
      console.log(c.stop ? `${f.replace(`${ROOT}/`, '')}  ${c.reason}: ${c.detail}` : `${f.replace(`${ROOT}/`, '')}  ${t.kind}  ${c.model.id} (${c.level}, ${c.why})  est ${c.estCostUsd.toFixed(4)} USD`);
      if (c.stop && c.reason === 'budget') break;
      if (!c.stop) leftUsd -= c.estCostUsd;
    }
    process.exit(0);
  }
  if (!(budgetUsd > 0)) {
    console.error('set --budget-usd or CREW_DAILY_BUDGET_USD to a positive number');
    process.exit(2);
  }
  if (!project) {
    console.error('set --project or GCP_PROJECT');
    process.exit(2);
  }
  const token = gcloudToken();
  const gate: Gate = (taskFile) => runAcceptance(taskFile);
  const haveClaude = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;
  const workers: Deps['workers'] = { 'openai-compatible': harnessWorker((m) => vertexChat(openapiBase(project, m.location), token), gate), ...(haveClaude && !args.includes('--no-claude') ? { 'claude-code': claudeWorker(project) } : {}) };
  const summary = await dispatch({
    root: ROOT,
    queue,
    router,
    budgetUsd,
    workers,
    gate,
    write: (r) => appendResult(r),
    prior,
    complete: vertexComplete(project, token),
    rule: (a) => {
      const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'mutation', 'equivalent.ts'), ...a], { cwd: ROOT, encoding: 'utf8' });
      return { ok: r.status === 0, output: (r.stdout ?? '') + (r.stderr ?? '') };
    },
    ...(val('max-tasks') ? { maxTasks: Number(val('max-tasks')) } : {}),
    perTask: Number(val('per-task') ?? 3),
    ...(val('deadline') ? { deadline: new Date(val('deadline')!) } : {}),
    log: (l) => console.log(JSON.stringify({ at: new Date().toISOString(), ...l })),
  });
  console.log(JSON.stringify({ stopped: summary.stopped, spentUsd: summary.spentUsd, fixed: summary.fixed.length, attempts: summary.attempts.length }));
  if (args.includes('--report')) {
    const md = morningReport(summary, openRouter({ allowStale: true }), [...readResults(), ...reviewSpend()]);
    writeReport(summary.date, md);
  }
}
