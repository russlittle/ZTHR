/**
 * A bounded tool-using agent loop: ask the model, run the tools it asks for, show it what happened, and stop. It never
 * runs without limits and never acts with more rights than the person it acts for.
 *
 * Each step is one model call (through llm-provider, or anything with its `complete`) followed by the tool calls
 * the reply asked for. The loop ends when the model answers without calling a tool, or on the first limit hit:
 * steps, tool calls (in all and per tool), cost in USD, tokens, wall time, repeated identical calls (a loop),
 * or too many steps in a row where every tool call failed. The status says which.
 *
 * Tools are the mcp block's `Tool`s: each has an input schema (arguments are checked before the tool runs, so a bad
 * call comes back to the model as an error it can fix) and an optional permission checked against the person
 * the agent acts for. A tool the person may not use is not shown to the model, and calling it anyway is refused
 * and traced as a denial. Tools that are not marked read-only need human approval by default.
 *
 * Human approval: when a call needs approval and no `decide` callback is given, the run is suspended with status
 * `waiting-approval` and the pending calls (tool, arguments); the state is kept in a store the caller can make
 * durable, and `resume(runId, decisions)` carries on, possibly hours later. An approver may approve, approve with
 * edited arguments (checked again against the schema), or decline with a reason the model sees. A pending run can
 * only be resumed by naming the calls it is waiting on; decisions for anything else are refused.
 *
 * The transcript is the message list; the trace is an ordered record of every model call, tool call, result,
 * denial, approval and stop, with time (injected clock), sizes and cost, with argument and output text cut to a
 * bounded length and passed through an optional `redact` hook. Tool output given back to the model is cut to
 * `maxToolOutputChars` with a notice.
 *
 * Out of scope: running tool calls in parallel (they run in order), cancelling a tool that is already running
 * (a timed-out tool is abandoned, not killed), long-term memory, planning beyond what the model does itself, and
 * durable storage (the default store is in memory).
 */

import type { LlmRequest, LlmResponse, Message, Part, ToolCall, ToolSpec, CallContext } from '../llm-provider/index.ts';
import { validate as validateArgs, type Tool } from '../mcp/index.ts';

export interface Actor {
  readonly who: string;
  readonly can: (permission: string) => boolean;
}

/** Anything that answers a request the way LlmClient does. */
export interface Model {
  complete(req: LlmRequest, ctx?: CallContext): Promise<LlmResponse>;
}

export interface Budgets {
  /** Model calls (default 10). */
  readonly maxSteps?: number;
  /** Tool calls run, in all (default 25). */
  readonly maxToolCalls?: number;
  /** Tool calls run per tool name. */
  readonly maxCallsPerTool?: Readonly<Record<string, number>>;
  readonly maxCostUsd?: number;
  /** Input plus output tokens, in all. */
  readonly maxTokens?: number;
  /** Wall time of the run so far, by the injected clock, checked between steps and calls. */
  readonly maxWallMs?: number;
  /** The same call (tool and arguments) may be made this many times (default 2); one more is refused, and again is a loop. */
  readonly maxRepeat?: number;
  /** Steps in a row where every tool call failed (default 3). */
  readonly maxFailedSteps?: number;
  /** Characters of one tool result shown to the model (default 20000). */
  readonly maxToolOutputChars?: number;
  /** A tool that has not answered by then is abandoned (default 30000). */
  readonly toolTimeoutMs?: number;
}

export type Decision =
  | { readonly approve: true; readonly args?: Record<string, unknown>; readonly by?: string }
  | { readonly approve: false; readonly reason?: string; readonly by?: string };

export interface ApprovalRequest {
  readonly runId: string;
  readonly callId: string;
  readonly tool: string;
  readonly title: string;
  readonly args: Record<string, unknown>;
  readonly readOnly: boolean;
}

export interface AgentOptions {
  readonly model: Model;
  readonly modelName: string;
  readonly system?: string;
  readonly tools: readonly Tool[];
  readonly actor: Actor;
  readonly now: () => Date;
  readonly id: () => string;
  readonly budgets?: Budgets;
  /** Which calls need a person's approval (default: every tool not marked read-only). */
  readonly needsApproval?: (tool: Tool, args: Record<string, unknown>) => boolean;
  /** Decide in-line (a UI prompt, a policy). Without it, calls needing approval suspend the run. */
  readonly decide?: (r: ApprovalRequest) => Promise<Decision>;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly feature?: string;
  readonly tenant?: string;
  /** Where suspended runs are kept (default: memory). */
  readonly store?: StateStore;
  /** Applied to argument and output text before it enters the trace. */
  readonly redact?: (s: string) => string;
  readonly onEvent?: (e: TraceEvent) => void;
}

export type Status = 'done' | 'waiting-approval' | 'step-limit' | 'tool-limit' | 'budget' | 'timeout' | 'loop' | 'failing' | 'aborted' | 'refused' | 'truncated';

export type TraceEvent =
  | { readonly seq: number; readonly at: string; readonly type: 'start'; readonly runId: string; readonly task: string }
  | { readonly seq: number; readonly at: string; readonly type: 'model'; readonly step: number; readonly finish: string; readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number; readonly toolCalls: number }
  | { readonly seq: number; readonly at: string; readonly type: 'tool-call'; readonly callId: string; readonly tool: string; readonly args: string }
  | { readonly seq: number; readonly at: string; readonly type: 'tool-result'; readonly callId: string; readonly tool: string; readonly ok: boolean; readonly chars: number; readonly excerpt: string; readonly ms: number }
  | { readonly seq: number; readonly at: string; readonly type: 'denied'; readonly callId: string; readonly tool: string; readonly why: string }
  | { readonly seq: number; readonly at: string; readonly type: 'approval-requested'; readonly callId: string; readonly tool: string }
  | { readonly seq: number; readonly at: string; readonly type: 'approval'; readonly callId: string; readonly tool: string; readonly approved: boolean; readonly by?: string; readonly reason?: string; readonly edited: boolean }
  | { readonly seq: number; readonly at: string; readonly type: 'stop'; readonly status: Status; readonly detail: string };

interface Pending {
  readonly callId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface RunState {
  readonly runId: string;
  messages: Message[];
  steps: number;
  toolCalls: number;
  perTool: Record<string, number>;
  tokens: number;
  costUsd: number;
  startedAt: number;
  failedSteps: number;
  repeats: Record<string, number>;
  trace: TraceEvent[];
  /** The calls of the step in progress, their results so far, and the ones waiting for a person. */
  batch: ToolCall[];
  results: Record<string, Extract<Part, { type: 'tool_result' }>>;
  pending: Pending[];
  stopped?: { status: Status; detail: string };
}

export interface RunResult {
  readonly runId: string;
  readonly status: Status;
  readonly answer: string;
  readonly detail: string;
  readonly steps: number;
  readonly toolCalls: number;
  readonly tokens: number;
  readonly costUsd: number;
  readonly transcript: readonly Message[];
  readonly trace: readonly TraceEvent[];
  /** Calls waiting for a person, when status is waiting-approval. */
  readonly pending: readonly ApprovalRequest[];
}

export interface StateStore {
  save(id: string, s: RunState): void | Promise<void>;
  load(id: string): RunState | undefined | Promise<RunState | undefined>;
  delete(id: string): void | Promise<void>;
}

export function memoryStore(): StateStore {
  const m = new Map<string, RunState>();
  return { save: (id, s) => { m.set(id, s); }, load: (id) => m.get(id), delete: (id) => { m.delete(id); } };
}

export class AgentError extends Error {}

const DEFAULTS = { maxSteps: 10, maxToolCalls: 25, maxRepeat: 2, maxFailedSteps: 3, maxToolOutputChars: 20_000, toolTimeoutMs: 30_000 };

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}... [${s.length - n} more characters]` : s);

/** Stable text for an arguments object, with keys sorted, for spotting repeated calls. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** The tool descriptions a model is shown for the tools a person may use. */
export function toolSpecs(tools: readonly Tool[], actor: Actor): ToolSpec[] {
  return tools.filter((t) => !t.permission || actor.can(t.permission)).map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema as unknown as ToolSpec['parameters'] }));
}

export class Agent {
  private readonly o: AgentOptions;
  private readonly b: Required<Pick<Budgets, 'maxSteps' | 'maxToolCalls' | 'maxRepeat' | 'maxFailedSteps' | 'maxToolOutputChars' | 'toolTimeoutMs'>> & Budgets;
  private readonly tools = new Map<string, Tool>();
  private readonly specs: ToolSpec[];
  private readonly store: StateStore;

  constructor(o: AgentOptions) {
    this.o = o;
    this.b = { ...DEFAULTS, ...o.budgets };
    for (const t of o.tools) {
      if (this.tools.has(t.name)) throw new AgentError(`the tool ${t.name} is listed twice`);
      this.tools.set(t.name, t);
    }
    this.specs = toolSpecs(o.tools, o.actor);
    this.store = o.store ?? memoryStore();
    for (const [k, v] of Object.entries(this.b)) if (typeof v === 'number' && !(v > 0)) throw new AgentError(`the budget ${k} must be more than zero`);
  }

  private ev(s: RunState, e: DistributiveOmit<TraceEvent, 'seq' | 'at'>): void {
    const full = { ...e, seq: s.trace.length + 1, at: this.o.now().toISOString() } as TraceEvent;
    s.trace.push(full);
    this.o.onEvent?.(full);
  }

  private red(s: string, n: number): string {
    return cut(this.o.redact ? this.o.redact(s) : s, n);
  }

  /** Starts a run. A string is the first user message; a message list continues a conversation. */
  async run(task: string | readonly Message[], ctx: CallContext = {}): Promise<RunResult> {
    const messages: Message[] = typeof task === 'string' ? [{ role: 'user', content: [{ type: 'text', text: task }] }] : [...task];
    const text = typeof task === 'string' ? task : JSON.stringify(task.at(-1)?.content ?? '');
    if (messages.length === 0 || (typeof task === 'string' && (task.trim() === '' || task.length > 100_000))) throw new AgentError('a task is 1 to 100,000 characters');
    const s: RunState = { runId: this.o.id(), messages, steps: 0, toolCalls: 0, perTool: Object.create(null) as Record<string, number>, tokens: 0, costUsd: 0, startedAt: this.o.now().getTime(), failedSteps: 0, repeats: Object.create(null) as Record<string, number>, trace: [], batch: [], results: Object.create(null) as RunState['results'], pending: [] };
    this.ev(s, { type: 'start', runId: s.runId, task: this.red(text, 500) });
    return this.drive(s, ctx);
  }

  /** Carries on a suspended run with the approvers' decisions, keyed by call id. Calls without a decision stay pending. */
  async resume(runId: string, decisions: Readonly<Record<string, Decision>>, ctx: CallContext = {}): Promise<RunResult> {
    const s = await this.store.load(runId);
    if (!s) throw new AgentError(`there is no suspended run ${runId.slice(0, 80)}`);
    const ids = new Set(s.pending.map((p) => p.callId));
    for (const k of Object.keys(decisions)) if (!ids.has(k)) throw new AgentError(`the run is not waiting on ${k.slice(0, 80)}`);
    const rest: Pending[] = [];
    for (const p of s.pending) {
      const d = Object.hasOwn(decisions, p.callId) ? decisions[p.callId] : undefined;
      if (!d) { rest.push(p); continue; }
      await this.settle(s, p, d);
    }
    s.pending = rest;
    return this.drive(s, ctx);
  }

  private async settle(s: RunState, p: Pending, d: Decision): Promise<void> {
    const tool = this.tools.get(p.name)!;
    this.ev(s, { type: 'approval', callId: p.callId, tool: p.name, approved: d.approve, ...(d.by ? { by: d.by } : {}), ...(!d.approve && d.reason ? { reason: this.red(d.reason, 200) } : {}), edited: d.approve && d.args !== undefined });
    if (!d.approve) { s.results[p.callId] = { type: 'tool_result', id: p.callId, content: `The person declined this action${d.reason ? `: ${cut(d.reason, 300).replace(/[.\s]+$/, '')}` : ''}. Do not retry it; continue without it or ask what they want instead.`, isError: true }; return; }
    const args = d.args ?? p.args;
    const problems = validateArgs(tool.inputSchema, args);
    if (problems.length) { s.results[p.callId] = { type: 'tool_result', id: p.callId, content: `The edited arguments do not match the tool: ${problems.slice(0, 5).join('; ')}`, isError: true }; return; }
    s.results[p.callId] = await this.execute(s, tool, p.callId, args);
  }

  private stop(s: RunState, status: Status, detail: string): void {
    s.stopped = { status, detail };
    this.ev(s, { type: 'stop', status, detail });
  }

  private result(s: RunState, status: Status, answer: string, detail: string): RunResult {
    return {
      runId: s.runId, status, answer, detail, steps: s.steps, toolCalls: s.toolCalls, tokens: s.tokens, costUsd: Math.round(s.costUsd * 1e9) / 1e9,
      transcript: s.messages, trace: s.trace,
      pending: s.pending.map((p) => ({ runId: s.runId, callId: p.callId, tool: p.name, title: this.tools.get(p.name)?.title ?? p.name, args: p.args, readOnly: !!this.tools.get(p.name)?.readOnly })),
    };
  }

  private lastText(s: RunState): string {
    for (let i = s.messages.length - 1; i >= 0; i--) {
      const m = s.messages[i]!;
      if (m.role === 'assistant') return m.content.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('');
    }
    return '';
  }

  private overBudget(s: RunState, ctx: CallContext): { status: Status; detail: string } | undefined {
    const b = this.b;
    if (ctx.signal?.aborted) return { status: 'aborted', detail: 'the run was cancelled' };
    if (s.steps >= b.maxSteps) return { status: 'step-limit', detail: `reached ${b.maxSteps} model calls` };
    if (b.maxCostUsd !== undefined && s.costUsd >= b.maxCostUsd) return { status: 'budget', detail: `spent $${s.costUsd.toFixed(4)} of $${b.maxCostUsd}` };
    if (b.maxTokens !== undefined && s.tokens >= b.maxTokens) return { status: 'budget', detail: `used ${s.tokens} of ${b.maxTokens} tokens` };
    if (b.maxWallMs !== undefined && this.o.now().getTime() - s.startedAt >= b.maxWallMs) return { status: 'timeout', detail: `ran for more than ${b.maxWallMs} ms` };
    return undefined;
  }

  private async drive(s: RunState, ctx: CallContext): Promise<RunResult> {
    try {
      for (;;) {
        // finish the step in progress first
        if (s.batch.length) {
          const stop = await this.runBatch(s, ctx);
          if (stop) break;
          if (s.pending.length) { await this.store.save(s.runId, s); this.ev(s, { type: 'stop', status: 'waiting-approval', detail: `${s.pending.length} call(s) need a person` }); return this.result(s, 'waiting-approval', '', `${s.pending.length} call(s) need approval`); }
          continue;
        }
        const over = this.overBudget(s, ctx);
        if (over) { this.stop(s, over.status, over.detail); break; }
        const res = await this.o.model.complete({
          model: this.o.modelName, messages: [...s.messages], ...(this.o.system ? { system: this.o.system } : {}), ...(this.specs.length ? { tools: this.specs } : {}),
          ...(this.o.maxTokens ? { maxTokens: this.o.maxTokens } : {}), ...(this.o.temperature !== undefined ? { temperature: this.o.temperature } : {}),
          ...(this.o.feature ? { feature: this.o.feature } : {}), ...(this.o.tenant ? { tenant: this.o.tenant } : {}),
        }, ctx);
        s.steps++;
        s.tokens += res.usage.inputTokens + res.usage.outputTokens + (res.usage.cacheReadTokens ?? 0) + (res.usage.cacheWriteTokens ?? 0);
        s.costUsd += res.costUsd;
        s.messages.push(res.message);
        this.ev(s, { type: 'model', step: s.steps, finish: res.finish, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd: res.costUsd, toolCalls: res.toolCalls.length });
        if (res.finish === 'content_filter') { this.stop(s, 'refused', 'the model declined to answer'); break; }
        if (res.toolCalls.length === 0) {
          if (res.finish === 'length') { this.stop(s, 'truncated', 'the reply was cut off at the token limit'); break; }
          this.stop(s, 'done', 'the model answered');
          break;
        }
        if (new Set(res.toolCalls.map((c) => c.id)).size !== res.toolCalls.length) { this.stop(s, 'failing', 'the model reused a tool call id in one reply'); break; }
        s.batch = [...res.toolCalls];
        s.results = Object.create(null) as RunState['results'];
        s.pending = [];
      }
    } catch (e) {
      if (ctx.signal?.aborted) { this.stop(s, 'aborted', 'the run was cancelled'); } else throw e;
    }
    await this.store.delete(s.runId);
    const st = s.stopped!;
    return this.result(s, st.status, this.lastText(s), st.detail);
  }

  /** Runs the step's tool calls in order. Returns true when the run must stop. */
  private async runBatch(s: RunState, ctx: CallContext): Promise<boolean> {
    for (const call of s.batch) {
      if (Object.hasOwn(s.results, call.id) || s.pending.some((p) => p.callId === call.id)) continue;
      if (ctx.signal?.aborted) { this.stop(s, 'aborted', 'the run was cancelled'); return true; }
      if (this.b.maxWallMs !== undefined && this.o.now().getTime() - s.startedAt >= this.b.maxWallMs) { this.stop(s, 'timeout', `ran for more than ${this.b.maxWallMs} ms`); return true; }
      const out = await this.handle(s, call);
      if (out === 'stop') return true;
      if (out) s.results[call.id] = out;
    }
    if (s.pending.length) return false;
    // every call has a result: show them to the model in the order it asked
    const parts = s.batch.map((c) => s.results[c.id]!);
    const failed = parts.every((p) => p.isError);
    s.failedSteps = failed ? s.failedSteps + 1 : 0;
    s.messages.push({ role: 'user', content: parts });
    s.batch = [];
    s.results = Object.create(null) as RunState['results'];
    if (s.failedSteps >= this.b.maxFailedSteps) { this.stop(s, 'failing', `${s.failedSteps} steps in a row where every tool call failed`); return true; }
    return false;
  }

  private errResult(id: string, msg: string): Extract<Part, { type: 'tool_result' }> {
    return { type: 'tool_result', id, content: msg, isError: true };
  }

  /** One call: returns its result, 'stop' to end the run, or undefined when it is waiting for a person. */
  private async handle(s: RunState, call: ToolCall): Promise<Extract<Part, { type: 'tool_result' }> | 'stop' | undefined> {
    const tool = this.tools.get(call.name);
    this.ev(s, { type: 'tool-call', callId: call.id, tool: call.name, args: this.red(JSON.stringify(call.arguments) ?? '{}', 1000) });
    if (!tool || (tool.permission && !this.o.actor.can(tool.permission))) {
      // the same answer for a tool that is missing and one the person may not use
      this.ev(s, { type: 'denied', callId: call.id, tool: call.name.slice(0, 80), why: tool ? `not permitted: needs ${tool.permission}` : 'no such tool' });
      return this.errResult(call.id, `There is no tool called ${call.name.slice(0, 80)}. Use one of: ${this.specs.map((t) => t.name).join(', ') || '(none)'}.`);
    }
    if (call.invalid) return this.errResult(call.id, `The arguments for ${call.name} could not be read: ${call.invalid}. Send a JSON object.`);
    const problems = validateArgs(tool.inputSchema, call.arguments);
    if (problems.length) return this.errResult(call.id, `The arguments do not match ${call.name}: ${problems.slice(0, 5).join('; ')}`);
    const key = `${call.name}\n${canon(call.arguments)}`;
    const seen = (s.repeats[key] = (s.repeats[key] ?? 0) + 1);
    if (seen > this.b.maxRepeat + 1) { this.stop(s, 'loop', `${call.name} was called with the same arguments ${seen} times`); return 'stop'; }
    if (seen > this.b.maxRepeat) return this.errResult(call.id, `You already called ${call.name} with these exact arguments ${this.b.maxRepeat} times. Use the earlier result or change your approach.`);
    if (s.toolCalls >= this.b.maxToolCalls) { this.stop(s, 'tool-limit', `reached ${this.b.maxToolCalls} tool calls`); return 'stop'; }
    const per = this.b.maxCallsPerTool?.[call.name];
    if (per !== undefined && (s.perTool[call.name] ?? 0) >= per) return this.errResult(call.id, `${call.name} may be used at most ${per} times in one run, and that is used up.`);
    const needs = this.o.needsApproval ? this.o.needsApproval(tool, call.arguments) : !tool.readOnly;
    if (!needs) return this.execute(s, tool, call.id, call.arguments);
    const req: ApprovalRequest = { runId: s.runId, callId: call.id, tool: call.name, title: tool.title, args: call.arguments, readOnly: !!tool.readOnly };
    this.ev(s, { type: 'approval-requested', callId: call.id, tool: call.name });
    if (!this.o.decide) { s.pending.push({ callId: call.id, name: call.name, args: call.arguments }); return undefined; }
    const d = await this.o.decide(req);
    await this.settle(s, { callId: call.id, name: call.name, args: call.arguments }, d);
    return s.results[call.id]!;
  }

  private async execute(s: RunState, tool: Tool, id: string, args: Record<string, unknown>): Promise<Extract<Part, { type: 'tool_result' }>> {
    s.toolCalls++;
    s.perTool[tool.name] = (s.perTool[tool.name] ?? 0) + 1;
    const t0 = this.o.now().getTime();
    let ok = true;
    let text: string;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new AgentError(`${tool.name} did not answer within ${this.b.toolTimeoutMs} ms`)), this.b.toolTimeoutMs); });
      const v = await Promise.race([tool.run(args, this.o.actor), timeout]);
      text = typeof v === 'string' ? v : JSON.stringify(v) ?? 'null';
    } catch (e) {
      ok = false;
      text = `The tool failed: ${cut(e instanceof Error ? e.message : String(e), 500)}`;
    } finally { clearTimeout(timer); }
    const full = text.length;
    const shown = full > this.b.maxToolOutputChars ? `${text.slice(0, this.b.maxToolOutputChars)}\n[output cut: ${full - this.b.maxToolOutputChars} more characters not shown]` : text;
    this.ev(s, { type: 'tool-result', callId: id, tool: tool.name, ok, chars: full, excerpt: this.red(text, 300), ms: Math.max(0, this.o.now().getTime() - t0) });
    return { type: 'tool_result', id, content: shown, ...(ok ? {} : { isError: true }) };
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
