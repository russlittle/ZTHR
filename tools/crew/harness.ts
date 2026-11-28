/**
 * A minimal agent loop for models behind an OpenAI-compatible chat completions endpoint (open models and Gemini on
 * Vertex). The model gets the task's prompt and four tools:
 *
 *   read_file(path)            a file tracked in the repository, or one of the task's mayEdit files
 *   write_file(path, content)  replaces a whole file; only paths in the task's mayEdit
 *   run_acceptance()           runs the task's acceptance gate, and nothing else
 *   finish(summary, ...)       ends the run
 *
 * It loops until finish, a reply with no tool calls, the step cap or the token cap. Tokens, cost and outcome are
 * recorded to intent/factory/results.jsonl by the caller (dispatch) or by this file's command line, after the gate,
 * so the log never trips the gate's scope check. No network except the model endpoint, which must be Vertex AI.
 *
 *   node tools/crew/harness.ts <task-file> --model <catalogue id> [--project P] [--max-steps 30] [--no-record]
 */
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import type { Model, Router } from '../../intent/blocks/router/index.ts';
import { ROOT, adaptPrompt, appendResult, gcloudToken, git, openRouter, openapiBase, runAcceptance, taskKey, vertexHostAllowed, type CrewResult } from './lib.ts';

export interface Task {
  kind: string;
  block: string;
  mutant: { id: string };
  mayEdit: string[];
  acceptance: string;
  budgetTokens: number;
  tier?: string;
  prompt: string;
  baseline?: Record<string, string>;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: unknown[];
  max_tokens: number;
  temperature: number;
}
export interface ChatResponse {
  id?: string;
  choices: { message: ChatMessage; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}
export type Chat = (req: ChatRequest) => Promise<ChatResponse>;

/** A chat client for an OpenAI-compatible endpoint on Vertex; refuses any other host. */
export function vertexChat(baseUrl: string, token: () => Promise<string>, f: typeof fetch = fetch): Chat {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  if (!vertexHostAllowed(url)) throw new Error(`refusing a model endpoint outside Vertex AI: ${url}`);
  return async (req) => {
    let last = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await f(url, { method: 'POST', headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' }, body: JSON.stringify(req), signal: AbortSignal.timeout(300_000) });
      if (res.ok) return (await res.json()) as ChatResponse;
      last = `${res.status} ${(await res.text()).slice(0, 400)}`;
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
    throw new Error(`model endpoint: ${last}`);
  };
}

export const TOOLS = [
  { type: 'function', function: { name: 'read_file', description: 'Read a file tracked in the repository, or one of the files you may edit. Paths are relative to the repository root.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Replace the whole content of a file you may edit. Read it first and send the complete new content.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'run_acceptance', description: "Run this task's acceptance gate (one to three minutes). Returns its JSON verdict.", parameters: { type: 'object', properties: {} } } },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'End the task.',
      parameters: { type: 'object', properties: { summary: { type: 'string' }, equivalent: { type: 'boolean', description: 'true if the mutant is equivalent and you wrote nothing' }, argument: { type: 'string', description: 'why it is equivalent' }, no_simplification: { type: 'boolean' } }, required: ['summary'] },
    },
  },
];

const READ_CAP = 120_000;
const OUT_CAP = 6_000;

/** The tools, confined to the task. Every refusal is returned to the model as text, never thrown. */
export class Sandbox {
  readonly writes = new Set<string>();
  acceptanceRuns = 0;
  readonly task: Task;
  readonly root: string;
  private readonly acceptance: () => { ok: boolean; output: string };
  private readonly maxAcceptance: number;
  private readonly mayEdit: Set<string>;
  private readonly tracked: Set<string>;

  constructor(task: Task, root: string, acceptance: () => { ok: boolean; output: string }, tracked?: Iterable<string>, maxAcceptance = 4) {
    this.task = task;
    this.root = root;
    this.acceptance = acceptance;
    this.maxAcceptance = maxAcceptance;
    this.mayEdit = new Set(task.mayEdit.map((p) => posix.normalize(p)));
    this.tracked = new Set(tracked ?? git(['ls-files', '-z'], root).out.split('\0').filter(Boolean));
  }

  /** A repository-relative path, or undefined if it is absolute, escapes the root or names git's own files. */
  static clean(p: unknown): string | undefined {
    if (typeof p !== 'string' || !p.trim() || p.includes('\0') || isAbsolute(p) || p.includes('\\')) return undefined;
    const n = posix.normalize(p.trim()).replace(/^\.\//, '');
    if (n === '.' || n.startsWith('../') || n === '..' || n.split('/').includes('.git')) return undefined;
    return n;
  }

  read(path: unknown): string {
    const p = Sandbox.clean(path);
    if (!p) return `refused: ${JSON.stringify(path)} is not a path inside the repository`;
    if (!this.tracked.has(p) && !this.mayEdit.has(p)) return `refused: ${p} is not a tracked file of the repository`;
    const abs = join(this.root, p);
    if (!existsSync(abs)) return `not found: ${p}`;
    if (lstatSync(abs).isSymbolicLink()) return `refused: ${p} is a symbolic link`;
    const text = readFileSync(abs, 'utf8');
    return text.length > READ_CAP ? `${text.slice(0, READ_CAP)}\n[truncated at ${READ_CAP} characters of ${text.length}]` : text;
  }

  write(path: unknown, content: unknown): string {
    const p = Sandbox.clean(path);
    if (!p || !this.mayEdit.has(p)) return `refused: you may write only ${[...this.mayEdit].join(', ')}`;
    if (typeof content !== 'string') return 'refused: content must be a string';
    const abs = join(this.root, p);
    if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) return `refused: ${p} is a symbolic link`;
    writeFileSync(abs, content);
    this.writes.add(p);
    return `wrote ${p} (${content.length} characters)`;
  }

  accept(): string {
    if (this.acceptanceRuns >= this.maxAcceptance) return `refused: the gate has run ${this.acceptanceRuns} times for this task; finish now`;
    this.acceptanceRuns++;
    const r = this.acceptance();
    const out = r.output.length > OUT_CAP ? `…${r.output.slice(-OUT_CAP)}` : r.output;
    return `${r.ok ? 'PASS' : 'NOT PASSED'}\n${out}`;
  }

  /** Dispatches one tool call by name; anything not one of the four tools is refused. */
  call(name: string, args: Record<string, unknown>): string {
    switch (name) {
      case 'read_file':
        return this.read(args.path);
      case 'write_file':
        return this.write(args.path, args.content);
      case 'run_acceptance':
        return this.accept();
      default:
        return `refused: no tool ${name}; the tools are read_file, write_file, run_acceptance and finish`;
    }
  }
}

export interface AgentRun {
  stop: 'finish' | 'no-tool-calls' | 'step-cap' | 'token-cap' | 'error';
  steps: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  responseIds: string[];
  summary: string;
  equivalent?: { argument: string };
  noSimplification?: string;
  writes: string[];
  acceptanceRuns: number;
  error?: string;
}

export const SYSTEM = (t: Task) =>
  [
    'You are a worker in a software factory. The gate decides whether your work is kept; your own claims count for nothing.',
    `You may change only these files, and only with write_file: ${t.mayEdit.join(', ')}. write_file replaces the whole file, so read it first and send the complete new content.`,
    'read_file reads any tracked file in the repository. run_acceptance runs the gate for this task and returns its verdict. Call finish when you are done.',
    'Be brief. Do not explain what you are about to do; call the tools.',
  ].join('\n');

/** The loop. The model, the gate and the clock are arguments, so it runs the same with a fake model. */
export async function runAgent(task: Task, taskFile: string, o: { chat: Chat; model: Model; router: Router; sandbox: Sandbox; maxSteps?: number; tokenCap?: number; temperature?: number }): Promise<AgentRun> {
  const maxSteps = o.maxSteps ?? 30;
  const tokenCap = o.tokenCap ?? task.budgetTokens;
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM(task) },
    { role: 'user', content: adaptPrompt(task.prompt, taskFile, 'tool') },
  ];
  const run: AgentRun = { stop: 'step-cap', steps: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, responseIds: [], summary: '', writes: [], acceptanceRuns: 0 };
  const done = (stop: AgentRun['stop']) => ({ ...run, stop, writes: [...o.sandbox.writes], acceptanceRuns: o.sandbox.acceptanceRuns });
  for (run.steps = 0; run.steps < maxSteps; ) {
    const used = run.inputTokens + run.cacheReadTokens + run.outputTokens;
    if (used >= tokenCap) return done('token-cap');
    let res: ChatResponse;
    try {
      res = await o.chat({ model: o.model.vertexId, messages, tools: TOOLS, max_tokens: Math.max(256, Math.min(8192, tokenCap - used)), temperature: o.temperature ?? 0.2 });
    } catch (e) {
      run.error = (e as Error).message;
      return done('error');
    }
    run.steps++;
    const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const input = Math.max(0, (res.usage?.prompt_tokens ?? 0) - cached);
    const output = res.usage?.completion_tokens ?? 0;
    run.inputTokens += input;
    run.cacheReadTokens += cached;
    run.outputTokens += output;
    run.costUsd = Math.round((run.costUsd + o.router.cost(o.model.id, { inputTokens: input, outputTokens: output, cacheReadTokens: cached })) * 1e9) / 1e9;
    if (res.id) run.responseIds.push(res.id);
    const msg = res.choices[0]?.message;
    if (!msg) {
      run.error = 'empty response';
      return done('error');
    }
    messages.push({ role: 'assistant', content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
    if (!msg.tool_calls?.length) {
      run.summary = (msg.content ?? '').slice(0, 2000);
      return done('no-tool-calls');
    }
    for (const call of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'refused: arguments were not valid JSON' });
        continue;
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'refused: arguments must be a JSON object' });
        continue;
      }
      if (call.function.name === 'finish') {
        run.summary = String(args.summary ?? '').slice(0, 2000);
        if (args.equivalent === true) run.equivalent = { argument: String(args.argument ?? args.summary ?? '').slice(0, 4000) };
        if (args.no_simplification === true) run.noSimplification = run.summary;
        return done('finish');
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: o.sandbox.call(call.function.name, args) });
    }
  }
  return done('step-cap');
}

/** The record of one attempt, for results.jsonl. */
export function record(task: Task, taskFile: string, m: Model, run: Pick<AgentRun, 'steps' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'costUsd' | 'responseIds'>, gate: { outcome: string; pass: boolean | null; reasons?: string[] }, extra: Partial<CrewResult> = {}): CrewResult {
  return {
    at: new Date().toISOString(),
    task: taskFile.replace(`${ROOT}/`, ''),
    kind: task.kind,
    block: task.block,
    model: m.id,
    family: m.family,
    runner: m.runner,
    pass: gate.pass,
    outcome: gate.outcome,
    steps: run.steps,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cacheReadTokens: run.cacheReadTokens,
    costUsd: run.costUsd,
    responseIds: run.responseIds,
    ...(gate.reasons?.length ? { reasons: gate.reasons.map((r) => r.slice(0, 300)) } : {}),
    ...extra,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const val = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
  const file = args[0];
  const modelId = val('model');
  const project = val('project') ?? process.env.GCP_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (!file || !modelId || !project) {
    console.error('usage: node tools/crew/harness.ts <task-file> --model <id> [--project P] [--max-steps N] [--no-record]');
    process.exit(2);
  }
  const taskFile = isAbsolute(file) ? file : join(ROOT, file);
  const task = JSON.parse(readFileSync(taskFile, 'utf8')) as Task;
  const router = openRouter();
  const m = router.model(modelId);
  if (m.runner !== 'openai-compatible') {
    console.error(`${m.id} runs under Claude Code; use tools/crew/dispatch.ts`);
    process.exit(2);
  }
  const rel = taskFile.replace(`${ROOT}/`, '');
  const sandbox = new Sandbox(task, ROOT, () => runAcceptance(rel));
  const run = await runAgent(task, rel, { chat: vertexChat(openapiBase(project, m.location), gcloudToken()), model: m, router, sandbox, maxSteps: Number(val('max-steps') ?? 30) });
  console.error(JSON.stringify({ stop: run.stop, steps: run.steps, tokens: run.inputTokens + run.outputTokens, costUsd: run.costUsd, summary: run.summary }));
  if (!args.includes('--no-record')) {
    const g = runAcceptance(rel);
    const outcome = String(g.verdict?.outcome ?? (g.ok ? 'pass' : 'rejected'));
    appendResult({ ...record(task, rel, m, run, { outcome, pass: outcome === 'bug-found' ? null : g.ok, reasons: (g.verdict?.reasons as string[] | undefined) ?? [] }), task: taskKey(task), file: rel });
    process.exit(g.ok ? 0 : 1);
  }
}
