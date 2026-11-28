/**
 * Workflows as graphs of steps (the n8n shape), run so they can stop and carry on. Holds: a graph of nodes and
 * edges where a node's output goes to its edges by port (main, true and false, loop and done, error, or a switch
 * case); items, the records that flow along edges, each handled one at a time or all together, with where each
 * came from kept; branching (if, switch), merging (append, zip, first, by key) that waits for every branch and
 * counts a branch not taken as done, loops over batches with a round limit, wait nodes (a time, or an event that
 * `resume` delivers), retries per item with backoff that survive a restart (the run is a plain JSON value: save it,
 * load it, call advance), three kinds of error handling per node (stop the run, keep going with the error on the
 * item, or route the failing items down an error edge), a failure branch for the whole run, limits on steps and
 * items, cancellation, a run history, and a validation pass that finds the mistakes before a run does: unknown
 * types, edges to nowhere, ports a node does not have, unreachable nodes, loops that do not go through a loop node,
 * merges with one input, and unconnected error routes. The run's own lifecycle is a state machine from the
 * workflow block (checked when the module loads), and `attachToQueue` runs advance as jobs on the jobs block's queue
 * with the next wake-up scheduled. Not here: what the nodes do (HTTP, mail, code: the host registers handlers),
 * expressions in parameters, sub-workflows, and parallel execution (nodes run one after another, in order).
 */
import { check, type Definition } from '../workflow/index.ts';
import type { Queue } from '../jobs/index.ts';

// ---------------------------------------------------------------- types

export interface Item {
  json: Record<string, unknown>;
  error?: { message: string; node: string };
  /** Where it came from: the node and the index of the input item it was made from. */
  source?: { node: string; item: number };
}

export interface Retry {
  readonly max: number;
  readonly delayMs?: number;
  readonly factor?: number;
  readonly maxDelayMs?: number;
}

export interface NodeDef {
  readonly id: string;
  readonly type: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly onError?: 'stop' | 'continue' | 'route';
  readonly retry?: Retry;
}

export interface Edge {
  readonly from: string;
  readonly to: string;
  /** The output port of `from`; default "main". */
  readonly port?: string;
}

export interface Graph {
  readonly nodes: readonly NodeDef[];
  readonly edges: readonly Edge[];
  /** The node that receives the run's input; default: the only node with no incoming edge. */
  readonly start?: string;
  /** A node that runs, with the error as its item, when the run fails. */
  readonly onFailure?: string;
  readonly limits?: { readonly maxSteps?: number; readonly maxItems?: number; readonly maxRounds?: number };
}

export class Wait {
  readonly until: number | undefined;
  readonly event: string | undefined;
  constructor(o: { until?: number; event?: string }) {
    this.until = o.until;
    this.event = o.event;
  }
}

/** Throw from a handler to say retrying will not help. */
export class NonRetryable extends Error {}
/** Throw from a handler to say how long to wait before the next try. */
export class RetryAfter extends Error {
  readonly ms: number;
  constructor(ms: number, message = 'retry later') {
    super(message);
    this.ms = ms;
  }
}

export interface NodeContext {
  readonly node: NodeDef;
  readonly params: Readonly<Record<string, unknown>>;
  readonly now: number;
  /** In each mode, the index of the item being handled. */
  readonly index: number;
  readonly attempt: number;
  /** Persistent JSON for this node (loops and merges keep their place here). */
  readonly state: Record<string, unknown>;
  /** True when the run came from a loop-back edge. */
  readonly back: boolean;
  /** The items from each incoming edge, in edge order (all mode). */
  readonly inputs: readonly (readonly Item[])[];
  readonly signal: AbortSignal | undefined;
}

export type Outputs = Record<string, Item[]>;
export type Result = Outputs | Item[] | Item | null | Wait;

export interface NodeHandler {
  readonly mode: 'each' | 'all';
  readonly run: (input: Item[] | Item, ctx: NodeContext) => Promise<Result> | Result;
  /** The output ports the node has, given its parameters; default ["main"]. */
  readonly ports?: (params: Readonly<Record<string, unknown>>) => readonly string[];
  /** Whether the node still runs when every input came from a branch that was not taken. */
  readonly runOnEmpty?: boolean;
  readonly check?: (node: NodeDef) => string[];
}

export type Status = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';

interface Parked {
  kind: 'retry' | 'wait';
  until: number | null;
  event?: string;
  items?: Item[];
}

interface Partial {
  items: Item[];
  inputs: Item[][];
  back: boolean;
  index: number;
  attempt: number;
  out: Outputs;
}

export interface HistoryEntry {
  readonly at: number;
  readonly node: string;
  readonly what: 'ok' | 'skipped' | 'retry' | 'error' | 'wait' | 'resumed';
  readonly items?: number;
  readonly detail?: string;
}

export interface RunState {
  readonly id: string;
  readonly graph: Graph;
  status: Status;
  inbox: Record<string, Record<string, Item[] | null>>;
  ready: { node: string; back: boolean }[];
  parked: Record<string, Parked>;
  partial: Record<string, Partial>;
  nodeState: Record<string, Record<string, unknown>>;
  /** Items from nodes that have no outgoing edges: the result of the run. */
  final: Record<string, Item[]>;
  steps: number;
  error?: { node: string; message: string };
  failing?: boolean;
  wakeAt?: number;
  history: HistoryEntry[];
}

// ---------------------------------------------------------------- run lifecycle (from the workflow block)

export const RUN_LIFECYCLE: Definition = {
  name: 'workflow run',
  start: 'queued',
  final: ['succeeded', 'failed', 'cancelled'],
  transitions: [
    { from: 'queued', to: 'running', action: 'start', roles: ['engine'] },
    { from: 'queued', to: 'cancelled', action: 'cancel', roles: ['engine', 'user'] },
    { from: 'running', to: 'waiting', action: 'wait', roles: ['engine'] },
    { from: 'running', to: 'succeeded', action: 'finish', roles: ['engine'] },
    { from: 'running', to: 'failed', action: 'fail', roles: ['engine'] },
    { from: 'running', to: 'cancelled', action: 'cancel', roles: ['engine', 'user'] },
    { from: 'waiting', to: 'running', action: 'wake', roles: ['engine'] },
    { from: 'waiting', to: 'cancelled', action: 'cancel', roles: ['engine', 'user'] },
    { from: 'waiting', to: 'failed', action: 'fail', roles: ['engine'] },
  ],
};
const problems = check(RUN_LIFECYCLE);
if (problems.length) throw new Error(`run lifecycle is wrong: ${problems.join('; ')}`);
const ALLOWED = new Set(RUN_LIFECYCLE.transitions.map((t) => `${t.from}>${t.to}`));

// ---------------------------------------------------------------- conditions and builtins

export interface Condition {
  readonly field: string;
  readonly op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists' | 'in' | 'matches';
  readonly value?: unknown;
}

const pathGet = (o: unknown, path: string): unknown => {
  let cur: unknown = o;
  for (const p of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, p)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
};

/** A condition on an item, with no code evaluation. */
export function evalCondition(c: Condition, item: Item): boolean {
  const v = pathGet(item.json, c.field);
  switch (c.op) {
    case 'exists': return v !== undefined && v !== null;
    case 'eq': return JSON.stringify(v) === JSON.stringify(c.value);
    case 'ne': return JSON.stringify(v) !== JSON.stringify(c.value);
    case 'gt': return typeof v === typeof c.value && (v as number) > (c.value as number);
    case 'gte': return typeof v === typeof c.value && (v as number) >= (c.value as number);
    case 'lt': return typeof v === typeof c.value && (v as number) < (c.value as number);
    case 'lte': return typeof v === typeof c.value && (v as number) <= (c.value as number);
    case 'contains': return typeof v === 'string' ? v.includes(String(c.value)) : Array.isArray(v) && v.some((x) => JSON.stringify(x) === JSON.stringify(c.value));
    case 'in': return Array.isArray(c.value) && c.value.some((x) => JSON.stringify(x) === JSON.stringify(v));
    case 'matches': {
      const src = String(c.value);
      if (src.length > 200 || typeof v !== 'string' || v.length > 10_000) return false;
      try {
        return new RegExp(src).test(v);
      } catch {
        return false;
      }
    }
  }
}

const clone = <T>(x: T): T => structuredClone(x);

const BUILTIN: Record<string, NodeHandler> = {
  start: { mode: 'all', run: (items) => items as Item[] },
  noop: { mode: 'all', run: (items) => items as Item[] },
  set: { mode: 'each', run: (item, ctx) => ({ json: { ...(ctx.params.keepOthers === false ? {} : (item as Item).json), ...(ctx.params.values as Record<string, unknown>) } }) },
  filter: { mode: 'each', run: (item, ctx) => (evalCondition(ctx.params.condition as Condition, item as Item) ? (item as Item) : null) },
  if: {
    mode: 'each',
    ports: () => ['true', 'false'],
    run: (item, ctx) => ({ [evalCondition(ctx.params.condition as Condition, item as Item) ? 'true' : 'false']: [item as Item] }),
  },
  switch: {
    mode: 'each',
    ports: (p) => [...Object.keys((p.cases as Record<string, Condition>) ?? {}), 'default'],
    run: (item, ctx) => {
      for (const [name, c] of Object.entries(ctx.params.cases as Record<string, Condition>)) if (evalCondition(c, item as Item)) return { [name]: [item as Item] };
      return { default: [item as Item] };
    },
  },
  wait: {
    mode: 'all',
    run: (_items, ctx) => new Wait({ ...(typeof ctx.params.ms === 'number' ? { until: ctx.now + ctx.params.ms } : {}), ...(typeof ctx.params.event === 'string' ? { event: ctx.params.event } : {}) }),
    check: (n) => (typeof n.params?.ms !== 'number' && typeof n.params?.event !== 'string' ? [`wait node ${n.id} needs ms or event`] : []),
  },
  merge: {
    mode: 'all',
    check: (n) => (['append', 'zip', 'first', 'key'].includes(String(n.params?.mode ?? 'append')) ? [] : [`merge node ${n.id} has an unknown mode`]),
    run: (_items, ctx) => {
      const mode = String(ctx.params.mode ?? 'append');
      const ins = ctx.inputs;
      if (mode === 'first') return ins.find((x) => x.length)?.map(clone) ?? [];
      if (mode === 'zip') {
        const n = Math.max(0, ...ins.map((x) => x.length));
        return Array.from({ length: n }, (_, i) => ({ json: Object.assign({}, ...ins.map((x) => x[i]?.json ?? {})) }));
      }
      if (mode === 'key') {
        const key = String(ctx.params.key);
        const by = new Map<string, Record<string, unknown>>();
        const loose: Item[] = [];
        for (const x of ins) for (const it of x) {
          if (it.json[key] === undefined) loose.push(it);
          else {
            const k = JSON.stringify(it.json[key]);
            by.set(k, { ...(by.get(k) ?? {}), ...it.json });
          }
        }
        return [...[...by.values()].map((json) => ({ json })), ...loose];
      }
      return ins.flat();
    },
  },
  loop: {
    mode: 'all',
    ports: () => ['loop', 'done'],
    run: (items, ctx) => {
      const size = Math.max(1, Number(ctx.params.batchSize ?? 1));
      const maxRounds = Number(ctx.params.maxRounds ?? 1000);
      const s = ctx.state as { remaining?: Item[]; acc?: Item[]; round?: number };
      if (!ctx.back) {
        s.remaining = [...(items as Item[])];
        s.acc = [];
        s.round = 0;
      } else if (s.remaining === undefined) return {};
      else s.acc!.push(...(items as Item[]));
      if (s.remaining!.length === 0) {
        const done = s.acc!;
        delete s.remaining;
        delete s.acc;
        return { done };
      }
      if (++s.round! > maxRounds) throw new NonRetryable(`loop ran more than ${maxRounds} rounds`);
      return { loop: s.remaining!.splice(0, size) };
    },
  },
};

// ---------------------------------------------------------------- validation

export interface Validation {
  readonly errors: string[];
  readonly warnings: string[];
}

export interface EngineOptions {
  readonly now?: () => number;
  readonly handlers?: Readonly<Record<string, NodeHandler>>;
}

export class RunFailure extends Error {
  readonly node: string;
  constructor(node: string, message: string) {
    super(message);
    this.node = node;
  }
}

const portsOf = (h: NodeHandler, n: NodeDef): string[] => [...(h.ports?.(n.params ?? {}) ?? ['main']), ...(n.onError === 'route' ? ['error'] : [])];

export class GraphEngine {
  private readonly handlers = new Map<string, NodeHandler>(Object.entries(BUILTIN));
  private readonly now: () => number;
  private seq = 0;

  constructor(o: EngineOptions = {}) {
    this.now = o.now ?? Date.now;
    for (const [k, v] of Object.entries(o.handlers ?? {})) this.handlers.set(k, v);
  }

  register(type: string, h: NodeHandler): void {
    this.handlers.set(type, h);
  }

  /** Back edges: the edges that close a cycle, found by walking from the start. */
  private backEdges(g: Graph, start: string): Set<number> {
    const back = new Set<number>();
    const state = new Map<string, 1 | 2>();
    const out = new Map<string, number[]>();
    g.edges.forEach((e, i) => out.set(e.from, [...(out.get(e.from) ?? []), i]));
    const walk = (n: string) => {
      state.set(n, 1);
      for (const i of out.get(n) ?? []) {
        const to = g.edges[i]!.to;
        if (state.get(to) === 1) back.add(i);
        else if (!state.has(to)) walk(to);
      }
      state.set(n, 2);
    };
    walk(start);
    for (const n of g.nodes) if (!state.has(n.id) && g.onFailure !== n.id) walk(n.id);
    return back;
  }

  private startOf(g: Graph): string | undefined {
    if (g.start) return g.start;
    const targets = new Set(g.edges.map((e) => e.to));
    const roots = g.nodes.filter((n) => !targets.has(n.id) && n.id !== g.onFailure);
    return roots.length === 1 ? roots[0]!.id : undefined;
  }

  validate(g: Graph): Validation {
    const errors: string[] = [];
    const warnings: string[] = [];
    const byId = new Map<string, NodeDef>();
    for (const n of g.nodes) {
      if (!/^[\w.-]+$/.test(n.id)) errors.push(`node id ${JSON.stringify(n.id)} is not a plain name`);
      if (byId.has(n.id)) errors.push(`node ${n.id} is defined twice`);
      byId.set(n.id, n);
      const h = this.handlers.get(n.type);
      if (!h) errors.push(`node ${n.id} has unknown type ${n.type}`);
      else errors.push(...(h.check?.(n) ?? []));
      if (n.retry && (!Number.isInteger(n.retry.max) || n.retry.max < 0 || n.retry.max > 20)) errors.push(`node ${n.id} retry.max must be 0 to 20`);
      if (n.onError === 'route' && !g.edges.some((e) => e.from === n.id && e.port === 'error')) warnings.push(`node ${n.id} routes errors but nothing is connected to its error port`);
    }
    const start = this.startOf(g);
    if (!start) errors.push('there must be exactly one start node (or name one in "start")');
    else if (!byId.has(start)) errors.push(`start node ${start} does not exist`);
    if (g.onFailure && !byId.has(g.onFailure)) errors.push(`failure node ${g.onFailure} does not exist`);
    g.edges.forEach((e, i) => {
      const from = byId.get(e.from);
      const to = byId.get(e.to);
      if (!from) errors.push(`edge ${i} starts at unknown node ${e.from}`);
      if (!to) errors.push(`edge ${i} ends at unknown node ${e.to}`);
      if (from) {
        const h = this.handlers.get(from.type);
        if (h && !portsOf(h, from).includes(e.port ?? 'main')) errors.push(`edge ${i}: node ${from.id} (${from.type}) has no port ${e.port ?? 'main'}`);
      }
      if (to && to.id === start) errors.push(`edge ${i} goes into the start node`);
    });
    for (const n of g.nodes) {
      const ports = new Map<string, number>();
      for (const e of g.edges) if (e.from === n.id) ports.set(e.port ?? 'main', (ports.get(e.port ?? 'main') ?? 0) + 1);
      if (n.type === 'loop' && !ports.has('loop')) errors.push(`loop node ${n.id} has nothing connected to its loop port`);
      if (n.type === 'loop' && !ports.has('done')) warnings.push(`loop node ${n.id} has nothing connected to its done port`);
    }
    if (!start || !byId.has(start)) return { errors, warnings };
    const back = this.backEdges(g, start);
    for (const i of back) {
      const t = byId.get(g.edges[i]!.to);
      if (t?.type !== 'loop') errors.push(`edge ${i} (${g.edges[i]!.from} to ${g.edges[i]!.to}) makes a cycle that does not go through a loop node`);
    }
    const seen = new Set<string>();
    const todo = [start, ...(g.onFailure ? [g.onFailure] : [])];
    while (todo.length) {
      const n = todo.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const e of g.edges) if (e.from === n) todo.push(e.to);
    }
    for (const n of g.nodes) if (!seen.has(n.id)) errors.push(`node ${n.id} cannot be reached from the start`);
    for (const n of g.nodes) {
      const inc = g.edges.filter((e, i) => e.to === n.id && !back.has(i));
      if (n.type === 'merge' && inc.length < 2) errors.push(`merge node ${n.id} needs at least two incoming edges`);
      else if (n.type !== 'merge' && inc.length > 1) warnings.push(`node ${n.id} has ${inc.length} incoming edges: it waits for all of them (use a merge node, or make sure the branches are exclusive)`);
    }
    return { errors, warnings };
  }

  // ------------------------------------------------------------ running

  start(g: Graph, input: readonly (Item | Record<string, unknown>)[] = [{}], id?: string): RunState {
    const v = this.validate(g);
    if (v.errors.length) throw new Error(`the graph is not valid:\n- ${v.errors.join('\n- ')}`);
    const items: Item[] = input.map((x) => (x && typeof x === 'object' && 'json' in x && typeof (x as Item).json === 'object' ? clone(x as Item) : { json: clone(x as Record<string, unknown>) }));
    return { id: id ?? `run-${++this.seq}`, graph: clone(g), status: 'queued', inbox: { [this.startOf(g)!]: { input: items } }, ready: [{ node: this.startOf(g)!, back: false }], parked: {}, partial: {}, nodeState: {}, final: {}, steps: 0, history: [] };
  }

  private setStatus(s: RunState, to: Status): void {
    if (s.status === to) return;
    if (!ALLOWED.has(`${s.status}>${to}`)) throw new Error(`a run cannot go from ${s.status} to ${to}`);
    s.status = to;
  }

  private log(s: RunState, e: Omit<HistoryEntry, 'at'>): void {
    s.history.push({ at: this.now(), ...e });
    if (s.history.length > 2000) s.history.splice(0, s.history.length - 2000);
  }

  /** Delivers an event to a node waiting for it. Returns whether one was waiting. */
  resume(s: RunState, event: string, data?: Record<string, unknown>): boolean {
    let hit = false;
    for (const [id, p] of Object.entries(s.parked)) {
      if (p.kind === 'wait' && p.event === event) {
        p.until = this.now();
        delete p.event;
        if (data) p.items = (p.items ?? []).map((it) => ({ ...it, json: { ...it.json, resume: data } }));
        hit = true;
        this.log(s, { node: id, what: 'resumed', detail: event });
      }
    }
    return hit;
  }

  cancel(s: RunState): void {
    if (['succeeded', 'failed', 'cancelled'].includes(s.status)) return;
    this.setStatus(s, 'cancelled');
    s.ready = [];
    s.parked = {};
    delete s.wakeAt;
  }

  /** Runs until nothing more can run now: finished, failed, cancelled, or waiting for a time or an event. */
  async advance(s: RunState, o: { signal?: AbortSignal } = {}): Promise<RunState> {
    if (['succeeded', 'failed', 'cancelled'].includes(s.status)) return s;
    this.setStatus(s, 'running');
    delete s.wakeAt;
    const lim = { maxSteps: s.graph.limits?.maxSteps ?? 10_000, maxItems: s.graph.limits?.maxItems ?? 10_000 };
    try {
      for (;;) {
        if (o.signal?.aborted) {
          this.setStatus(s, 'cancelled');
          return s;
        }
        this.release(s);
        const next = s.ready.shift();
        if (!next) break;
        if (++s.steps > lim.maxSteps) throw new RunFailure(next.node, `the run took more than ${lim.maxSteps} steps`);
        await this.exec(s, next.node, next.back, lim.maxItems, o.signal);
      }
    } catch (e) {
      return this.fail(s, e instanceof RunFailure ? e : new RunFailure('?', (e as Error).message), o.signal);
    }
    const waiting = Object.values(s.parked);
    if (waiting.length) {
      this.setStatus(s, 'waiting');
      const times = waiting.map((p) => p.until).filter((x): x is number => x !== null);
      if (times.length) s.wakeAt = Math.min(...times);
    } else this.setStatus(s, s.failing ? 'failed' : 'succeeded');
    return s;
  }

  private async fail(s: RunState, f: RunFailure, signal?: AbortSignal): Promise<RunState> {
    s.error = { node: f.node, message: f.message };
    this.log(s, { node: f.node, what: 'error', detail: f.message });
    const h = s.graph.onFailure;
    if (h && !s.failing) {
      s.failing = true;
      s.ready = [{ node: h, back: false }];
      s.inbox = { [h]: { input: [{ json: { error: f.message, node: f.node, run: s.id } }] } };
      s.parked = {};
      s.partial = {};
      try {
        for (;;) {
          this.release(s);
          const next = s.ready.shift();
          if (!next) break;
          await this.exec(s, next.node, next.back, 10_000, signal);
        }
      } catch (e) {
        this.log(s, { node: h, what: 'error', detail: `the failure branch failed: ${(e as Error).message}` });
      }
    }
    s.ready = [];
    s.parked = {};
    delete s.wakeAt;
    this.setStatus(s, 'failed');
    return s;
  }

  /** Moves parked nodes whose time has come back to the ready list. */
  private release(s: RunState): void {
    const t = this.now();
    for (const [id, p] of Object.entries(s.parked)) {
      if (p.until === null || p.until > t) continue;
      delete s.parked[id];
      if (p.kind === 'wait') {
        this.log(s, { node: id, what: 'resumed' });
        this.deliver(s, id, { main: p.items ?? [] }, Number.MAX_SAFE_INTEGER);
      } else s.ready.unshift({ node: id, back: s.partial[id]?.back ?? false });
    }
  }

  private async exec(s: RunState, id: string, back: boolean, maxItems: number, signal: AbortSignal | undefined): Promise<void> {
    const node = s.graph.nodes.find((n) => n.id === id)!;
    const h = this.handlers.get(node.type)!;
    let work = s.partial[id];
    if (!work) {
      const incoming = s.graph.edges.map((e, i) => ({ e, key: `e${i}` })).filter((x) => x.e.to === id);
      const box = s.inbox[id] ?? {};
      const inputs = [...(box.input ? [box.input] : []), ...incoming.map((x) => box[x.key]).filter((x): x is Item[] => Array.isArray(x))];
      delete s.inbox[id];
      const items = inputs.flat();
      const allSkipped = !box.input && !back && incoming.length > 0 && incoming.every((x) => box[x.key] === null);
      if ((allSkipped || (items.length === 0 && !back && !h.runOnEmpty && node.type !== 'start' && node.type !== 'merge')) && !h.runOnEmpty) {
        this.log(s, { node: id, what: 'skipped' });
        this.deliver(s, id, {}, maxItems);
        return;
      }
      work = { items, inputs, back, index: 0, attempt: 0, out: {} };
      s.partial[id] = work;
    }
    const st = (s.nodeState[id] ??= {});
    const total = h.mode === 'all' ? 1 : work.items.length;
    while (work.index < total) {
      const item = h.mode === 'all' ? work.items : work.items[work.index]!;
      const ctx: NodeContext = { node, params: node.params ?? {}, now: this.now(), index: work.index, attempt: work.attempt, state: st, back: work.back, inputs: work.inputs, signal };
      let r: Result;
      try {
        r = await h.run(item, ctx);
      } catch (e) {
        const err = e as Error;
        const max = node.retry?.max ?? 0;
        if (!(err instanceof NonRetryable) && work.attempt < max) {
          const r0 = node.retry!;
          const delay = err instanceof RetryAfter ? err.ms : Math.min(r0.maxDelayMs ?? 3_600_000, (r0.delayMs ?? 1000) * (r0.factor ?? 2) ** work.attempt);
          work.attempt++;
          s.parked[id] = { kind: 'retry', until: this.now() + delay };
          this.log(s, { node: id, what: 'retry', detail: `${err.message} (attempt ${work.attempt} of ${max}, in ${delay} ms)` });
          return;
        }
        const mode = node.onError ?? 'stop';
        if (mode === 'stop') {
          delete s.partial[id];
          throw new RunFailure(id, err.message);
        }
        const failed: Item[] = (h.mode === 'all' ? (item as Item[]) : [item as Item]).map((x) => ({ json: x.json, error: { message: err.message, node: id } }));
        (work.out[mode === 'route' ? 'error' : 'main'] ??= []).push(...failed);
        this.log(s, { node: id, what: 'error', detail: err.message });
        work.index++;
        work.attempt = 0;
        continue;
      }
      if (r instanceof Wait) {
        s.parked[id] = { kind: 'wait', until: r.until ?? null, ...(r.event ? { event: r.event } : {}), items: work.items };
        delete s.partial[id];
        this.log(s, { node: id, what: 'wait', detail: r.event ?? `until ${r.until}` });
        return;
      }
      const norm: Outputs = r === null ? {} : Array.isArray(r) ? { main: r } : 'json' in r && typeof (r as Item).json === 'object' ? { main: [r as Item] } : (r as Outputs);
      for (const [port, list] of Object.entries(norm)) {
        const tagged = list.map((x) => (h.mode === 'each' && !x.source ? { ...x, source: { node: id, item: work!.index } } : x));
        (work.out[port] ??= []).push(...tagged);
      }
      work.index++;
      work.attempt = 0;
    }
    delete s.partial[id];
    const total2 = Object.values(work.out).reduce((n, l) => n + l.length, 0);
    this.log(s, { node: id, what: 'ok', items: total2 });
    this.deliver(s, id, work.out, maxItems);
  }

  /** Sends a node's outputs along its edges; a port with nothing tells the next node its branch was not taken. */
  private deliver(s: RunState, id: string, out: Outputs, maxItems: number): void {
    const count = Object.values(out).reduce((n, l) => n + l.length, 0);
    if (count > maxItems) throw new RunFailure(id, `the node produced ${count} items, over the limit of ${maxItems}`);
    const edges = s.graph.edges.map((e, i) => ({ e, i })).filter((x) => x.e.from === id);
    if (edges.length === 0) {
      const main = out.main ?? [];
      if (main.length) s.final[id] = main;
      return;
    }
    const start = this.startOf(s.graph)!;
    const back = this.backEdges(s.graph, start);
    for (const { e, i } of edges) {
      const items = out[e.port ?? 'main'] ?? [];
      const box = (s.inbox[e.to] ??= {});
      if (back.has(i)) {
        if (!s.nodeState[e.to] || (s.nodeState[e.to] as { remaining?: unknown }).remaining === undefined) continue;
        box[`e${i}`] = items.length ? items : null;
        if (!s.ready.some((r) => r.node === e.to)) s.ready.push({ node: e.to, back: true });
        continue;
      }
      box[`e${i}`] = items.length ? items : null;
      const forward = s.graph.edges.map((x, k) => ({ x, k })).filter((y) => y.x.to === e.to && !back.has(y.k));
      if (forward.every((y) => box[`e${y.k}`] !== undefined) && !s.ready.some((r) => r.node === e.to) && !s.parked[e.to] && !s.partial[e.to]) s.ready.push({ node: e.to, back: false });
    }
  }
}

// ---------------------------------------------------------------- jobs

export interface RunStore {
  get(id: string): RunState | undefined;
  put(s: RunState): void;
}

export const memoryStore = (): RunStore & { runs: Map<string, string> } => {
  const runs = new Map<string, string>();
  return { runs, get: (id) => (runs.has(id) ? (JSON.parse(runs.get(id)!) as RunState) : undefined), put: (s) => void runs.set(s.id, JSON.stringify(s)) };
};

/** Runs advance as jobs: after each, the next wake-up (a timer or a retry) is queued for its time. */
export function attachToQueue(queue: Queue, engine: GraphEngine, store: RunStore, now: () => number = Date.now): void {
  queue.handle('workflow.advance', async (payload) => {
    const { runId } = payload as { runId: string };
    const s = store.get(runId);
    if (!s) return { missing: true };
    await engine.advance(s);
    store.put(s);
    if (s.status === 'waiting' && s.wakeAt !== undefined) queue.enqueue('workflow.advance', { runId }, { runAt: Math.max(s.wakeAt, now()), key: `${runId}:${s.wakeAt}` });
    return { status: s.status };
  });
}

export function enqueueRun(queue: Queue, store: RunStore, s: RunState): void {
  store.put(s);
  queue.enqueue('workflow.advance', { runId: s.id }, { key: `${s.id}:start` });
}
