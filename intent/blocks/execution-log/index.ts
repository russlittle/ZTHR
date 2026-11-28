/**
 * Run records for automated workflows: every run of a flow, every step in it with its input and output, kept in a
 * run store. Secrets are removed where the record is written, not where it is shown: values under sensitive key
 * names (password, token, secret, authorization, api key, cookie and any names you add), values you declare as
 * secrets, and long payloads are cut to a size cap with a marker saying how much was dropped. Old runs are pruned
 * by a plan you can read before it is applied (age, count per flow, failed runs kept longer, pinned runs kept for
 * good), and every start, replay and prune is written to the audit chain. A run can be replayed from any step: the
 * earlier steps' outputs are reused as they were recorded, the later steps are executed again by the executor you
 * pass, and a new run is stored that points back at the original. Replay from a step whose stored input was
 * redacted or cut is refused unless you supply the input, because replaying a changed input would be a different
 * run presented as the same one.
 *
 * Out of scope: durable storage (the store is an interface with an in-memory version) and scheduling the pruning.
 */
import { randomUUID } from 'node:crypto';
import type { Audit } from '../audit/index.ts';

export type RunStatus = 'running' | 'success' | 'failed' | 'cancelled';

export interface StepRecord {
  readonly index: number;
  readonly name: string;
  readonly status: 'success' | 'failed' | 'reused';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly error?: string;
  /** True when the recorded input had something removed or cut, so it cannot be replayed as it was. */
  readonly inputAltered: boolean;
  readonly outputAltered: boolean;
}

export interface Run {
  readonly id: string;
  readonly flow: string;
  readonly trigger: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly steps: readonly StepRecord[];
  readonly replayOf?: { readonly run: string; readonly fromStep: number };
  readonly pinned: boolean;
}

export interface RunStore {
  put(run: Run): void;
  get(id: string): Run | undefined;
  list(): Run[];
  delete(id: string): void;
}

export function memoryRuns(): RunStore {
  const m = new Map<string, Run>();
  return { put: (r) => void m.set(r.id, structuredClone(r)), get: (id) => { const r = m.get(id); return r ? structuredClone(r) : undefined; }, list: () => [...m.values()].map((r) => structuredClone(r)), delete: (id) => void m.delete(id) };
}

export const REDACTED = '[redacted]';

export interface RedactionOptions {
  /** Extra key-name patterns to redact (matched case-insensitively against the whole key). */
  readonly keys?: readonly RegExp[];
  /** Exact secret values to remove wherever they appear inside strings. */
  readonly secrets?: readonly string[];
  /** Strings longer than this are cut. */
  readonly maxString?: number;
  /** Arrays longer than this are cut. */
  readonly maxItems?: number;
  /** Nesting deeper than this is replaced. */
  readonly maxDepth?: number;
}

const DEFAULT_KEYS: readonly RegExp[] = [/pass(word|wd)?/i, /secret/i, /token/i, /authorization/i, /api[-_]?key/i, /cookie/i, /private[-_]?key/i, /^x-api-key$/i, /credential/i, /signature/i];

/** A copy of the value with secrets removed and size capped. `altered` says whether anything was changed. */
export function redact(value: unknown, o: RedactionOptions = {}): { value: unknown; altered: boolean } {
  const keys = [...DEFAULT_KEYS, ...(o.keys ?? [])];
  const secrets = (o.secrets ?? []).filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  const maxString = o.maxString ?? 10_000;
  const maxItems = o.maxItems ?? 1000;
  const maxDepth = o.maxDepth ?? 20;
  let altered = false;
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') {
      let s = v;
      for (const sec of secrets) if (s.includes(sec)) { s = s.split(sec).join(REDACTED); altered = true; }
      if (s.length > maxString) { altered = true; return `${s.slice(0, maxString)}…[cut ${s.length - maxString} characters]`; }
      return s;
    }
    if (v === null || typeof v !== 'object') return typeof v === 'bigint' ? v.toString() : typeof v === 'function' || typeof v === 'symbol' ? undefined : v;
    if (seen.has(v)) { altered = true; return '[circular]'; }
    if (depth >= maxDepth) { altered = true; return '[too deep]'; }
    seen.add(v);
    try {
      if (v instanceof Date) return v.toISOString();
      if (Array.isArray(v)) {
        const items = v.slice(0, maxItems).map((x) => walk(x, depth + 1));
        if (v.length > maxItems) { altered = true; items.push(`[cut ${v.length - maxItems} more items]`); }
        return items;
      }
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (keys.some((re) => re.test(k))) { out[k] = REDACTED; altered = true; } else out[k] = walk(x, depth + 1);
      }
      return out;
    } finally {
      seen.delete(v);
    }
  };
  return { value: walk(value, 0), altered };
}

export class NotFound extends Error {}
export class NotReplayable extends Error {}

export interface LogOptions {
  readonly store?: RunStore;
  readonly audit?: Audit;
  readonly now?: () => Date;
  readonly id?: () => string;
  readonly redaction?: RedactionOptions;
}

export interface PrunePolicy {
  /** Successful and cancelled runs older than this are removed. */
  readonly maxAgeMs: number;
  /** Failed runs are kept this long (defaults to the same as maxAgeMs). */
  readonly keepFailedMs?: number;
  /** At most this many runs are kept per flow (newest first); pinned runs do not count against it. */
  readonly maxPerFlow?: number;
}

export interface PruneItem { readonly id: string; readonly flow: string; readonly reason: string }

export type StepExecutor = (step: { index: number; name: string; input: unknown }) => Promise<unknown>;

export class ExecutionLog {
  readonly store: RunStore;
  readonly #audit: Audit | undefined;
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #redaction: RedactionOptions;

  constructor(o: LogOptions = {}) {
    this.store = o.store ?? memoryRuns();
    this.#audit = o.audit;
    this.#now = o.now ?? (() => new Date());
    this.#id = o.id ?? randomUUID;
    this.#redaction = o.redaction ?? {};
  }

  /** Begin a run. */
  async start(flow: string, trigger: string, actor = 'system'): Promise<Run> {
    const run: Run = { id: this.#id(), flow, trigger, status: 'running', startedAt: this.#now().toISOString(), steps: [], pinned: false };
    this.store.put(run);
    await this.#audit?.record({ actor, action: 'run.start', target: `run/${run.id}`, detail: { flow, trigger } });
    return run;
  }

  #need(id: string): Run {
    const r = this.store.get(id);
    if (!r) throw new NotFound(`no run ${id}`);
    return r;
  }

  /** Record one finished step. Input, output and error text are redacted as they are written. */
  step(runId: string, s: { name: string; input: unknown; output?: unknown; error?: string; startedAt: Date; finishedAt?: Date; reused?: boolean }): StepRecord {
    const run = this.#need(runId);
    if (run.status !== 'running') throw new Error(`run ${runId} is already ${run.status}`);
    const i = redact(s.input, this.#redaction);
    const o = redact(s.output, this.#redaction);
    const err = s.error === undefined ? undefined : (redact(s.error, this.#redaction).value as string);
    const rec: StepRecord = {
      index: run.steps.length,
      name: s.name,
      status: s.reused ? 'reused' : s.error === undefined ? 'success' : 'failed',
      startedAt: s.startedAt.toISOString(),
      finishedAt: (s.finishedAt ?? this.#now()).toISOString(),
      input: i.value,
      output: o.value,
      ...(err === undefined ? {} : { error: err }),
      inputAltered: i.altered,
      outputAltered: o.altered,
    };
    this.store.put({ ...run, steps: [...run.steps, rec] });
    return rec;
  }

  /** End a run; a failed step makes it failed unless a status is given. */
  finish(runId: string, status?: Exclude<RunStatus, 'running'>): Run {
    const run = this.#need(runId);
    const final = status ?? (run.steps.some((s) => s.status === 'failed') ? 'failed' : 'success');
    const done: Run = { ...run, status: final, finishedAt: this.#now().toISOString() };
    this.store.put(done);
    return done;
  }

  get(runId: string): Run {
    return this.#need(runId);
  }

  /** Runs, newest first, optionally narrowed. */
  list(f: { flow?: string; status?: RunStatus; limit?: number } = {}): Run[] {
    return this.store.list().filter((r) => (!f.flow || r.flow === f.flow) && (!f.status || r.status === f.status)).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id)).slice(0, f.limit ?? 100);
  }

  pin(runId: string, pinned = true): void {
    this.store.put({ ...this.#need(runId), pinned });
  }

  /** What a prune would remove and why, without removing it. */
  prunePlan(p: PrunePolicy): PruneItem[] {
    const now = this.#now().getTime();
    const keepFailed = p.keepFailedMs ?? p.maxAgeMs;
    const out = new Map<string, PruneItem>();
    const runs = this.store.list().filter((r) => r.status !== 'running' && !r.pinned);
    for (const r of runs) {
      const age = now - new Date(r.finishedAt ?? r.startedAt).getTime();
      const limit = r.status === 'failed' ? keepFailed : p.maxAgeMs;
      if (age > limit) out.set(r.id, { id: r.id, flow: r.flow, reason: `${r.status} run older than ${Math.round(limit / 3_600_000)} hours` });
    }
    if (p.maxPerFlow !== undefined) {
      const byFlow = new Map<string, Run[]>();
      for (const r of this.store.list().filter((x) => x.status !== 'running')) byFlow.set(r.flow, [...(byFlow.get(r.flow) ?? []), r]);
      for (const [flow, rs] of byFlow) {
        const kept = rs.filter((r) => !r.pinned).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
        for (const r of kept.slice(p.maxPerFlow)) if (!out.has(r.id)) out.set(r.id, { id: r.id, flow, reason: `more than ${p.maxPerFlow} runs kept for ${flow}` });
      }
    }
    return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Apply a prune plan and record it. Returns what was removed. */
  async prune(p: PrunePolicy, actor = 'system'): Promise<PruneItem[]> {
    const plan = this.prunePlan(p);
    for (const i of plan) this.store.delete(i.id);
    await this.#audit?.record({ actor, action: 'run.prune', target: 'runs', detail: { removed: plan.length, ids: plan.map((i) => i.id) } });
    return plan;
  }

  /**
   * Replay a run from a step: earlier steps are copied as recorded (marked reused), the chosen step and every later
   * one are executed again. The first replayed step uses the recorded input, or `input` when you supply one; later
   * steps use the previous replayed output. A failed step stops the replay and the new run is marked failed.
   */
  async replay(runId: string, fromStep: number, execute: StepExecutor, o: { input?: unknown; actor?: string } = {}): Promise<Run> {
    const orig = this.#need(runId);
    if (orig.status === 'running') throw new NotReplayable(`run ${runId} is still running`);
    const first = orig.steps[fromStep];
    if (!Number.isInteger(fromStep) || !first) throw new NotReplayable(`run ${runId} has no step ${fromStep}`);
    if (first.inputAltered && o.input === undefined) throw new NotReplayable(`step ${fromStep} (${first.name}) had its input redacted or cut, so it cannot be replayed as it was; supply the input`);
    const run = await this.start(orig.flow, `replay of ${orig.id}`, o.actor ?? 'system');
    this.store.put({ ...this.#need(run.id), replayOf: { run: orig.id, fromStep } });
    await this.#audit?.record({ actor: o.actor ?? 'system', action: 'run.replay', target: `run/${orig.id}`, detail: { newRun: run.id, fromStep } });
    for (const s of orig.steps.slice(0, fromStep)) {
      this.step(run.id, { name: s.name, input: s.input, output: s.output, startedAt: new Date(s.startedAt), finishedAt: new Date(s.finishedAt), reused: true });
    }
    let input: unknown = o.input !== undefined ? o.input : first.input;
    for (const s of orig.steps.slice(fromStep)) {
      const started = this.#now();
      try {
        const output = await execute({ index: s.index, name: s.name, input });
        this.step(run.id, { name: s.name, input, output, startedAt: started });
        input = output;
      } catch (e) {
        this.step(run.id, { name: s.name, input, error: (e as Error).message, startedAt: started });
        return this.finish(run.id);
      }
    }
    return this.finish(run.id);
  }
}
