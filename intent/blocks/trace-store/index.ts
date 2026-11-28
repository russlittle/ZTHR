/**
 * Distributed traces: the span model (after OpenTelemetry: 128-bit trace id and 64-bit span id in hex, parent, name,
 * service, kind, start and duration in milliseconds, status, attributes), a store that takes spans in any order and
 * from any service, trace assembly (a tree, with spans whose parent never arrived kept as orphans, self time per span,
 * the critical path, services touched, errors), a service graph built from calls that cross a service boundary (with
 * counts, errors and p50/p95/p99 latency, and edges inferred from a client span's `peer.service` when the callee sent
 * nothing), trace search, retention, and tail-based sampling.
 *
 * Tail-based sampling decides after the whole trace has been seen: a trace is held until it has been quiet for the
 * decision wait (or reaches a span cap), then kept if any policy says so (it has an error, it was slow, an attribute
 * matches, a probabilistic share chosen by a hash of the trace id so every collector reaches the same answer, or a
 * rate-limited baseline) and dropped otherwise. The reason for each decision is returned.
 *
 * Rules: the clock is an argument; ids that are not hex of the right length are refused; a span repeated with the
 * same id is a duplicate and ignored (the first one wins); a trace and a span have size caps so one bad producer cannot
 * fill memory; a cycle in parent links is cut, not followed forever.
 *
 * Out of scope: the OTLP wire encoding, durable storage, and span links across traces.
 */
import { createHash } from 'node:crypto';

export class TraceError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';
export type SpanStatus = 'unset' | 'ok' | 'error';
export type AttributeValue = string | number | boolean;

export interface Span {
  /** 32 lowercase hex characters. */
  readonly traceId: string;
  /** 16 lowercase hex characters. */
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly service: string;
  readonly kind?: SpanKind;
  /** Start, in milliseconds since the epoch (fractions allowed). */
  readonly startMs: number;
  readonly durationMs: number;
  readonly status?: SpanStatus;
  readonly attributes?: Readonly<Record<string, AttributeValue>>;
}

export interface Limits {
  readonly maxSpansPerTrace: number;
  readonly maxAttributes: number;
  readonly maxNameLength: number;
  readonly maxTraces: number;
}

export const DEFAULT_LIMITS: Limits = { maxSpansPerTrace: 5000, maxAttributes: 64, maxNameLength: 256, maxTraces: 100_000 };

export type IngestResult = 'stored' | 'duplicate' | 'trace-full';

export interface SpanNode {
  readonly span: Span;
  readonly children: SpanNode[];
  readonly depth: number;
  /** Time in this span not covered by any child. */
  readonly selfMs: number;
  readonly endMs: number;
}

export interface Trace {
  readonly traceId: string;
  /** Spans with no parent: normally one. */
  readonly roots: readonly SpanNode[];
  /** Spans whose parent id is not in the store (late, lost, or sampled out). */
  readonly orphans: readonly SpanNode[];
  readonly spanCount: number;
  readonly services: readonly string[];
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
  readonly errorCount: number;
  /** Spans on the critical path, root first. */
  readonly criticalPath: readonly Span[];
  /** True when there is exactly one root and no orphans. */
  readonly complete: boolean;
}

export interface TraceSummary {
  readonly traceId: string;
  readonly rootName: string | undefined;
  readonly rootService: string | undefined;
  readonly startMs: number;
  readonly durationMs: number;
  readonly spanCount: number;
  readonly errorCount: number;
  readonly services: readonly string[];
}

export interface SearchQuery {
  readonly service?: string;
  readonly name?: string;
  readonly minDurationMs?: number;
  readonly maxDurationMs?: number;
  readonly errorsOnly?: boolean;
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly attribute?: { readonly key: string; readonly value: AttributeValue };
  readonly limit?: number;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly calls: number;
  readonly errors: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  /** True when the callee never reported a span and the edge comes from the caller's `peer.service`. */
  readonly inferred: boolean;
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const KINDS = new Set(['internal', 'server', 'client', 'producer', 'consumer']);
const STATUSES = new Set(['unset', 'ok', 'error']);

/** Nearest-rank percentile of an unsorted list; 0 for none. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

export function validateSpan(s: Span, limits: Limits = DEFAULT_LIMITS): void {
  if (!HEX32.test(s.traceId) || /^0+$/.test(s.traceId)) throw new TraceError('traceId must be 32 lowercase hex characters and not all zero');
  if (!HEX16.test(s.spanId) || /^0+$/.test(s.spanId)) throw new TraceError('spanId must be 16 lowercase hex characters and not all zero');
  if (s.parentSpanId !== undefined && !HEX16.test(s.parentSpanId)) throw new TraceError('parentSpanId must be 16 lowercase hex characters');
  if (s.parentSpanId === s.spanId) throw new TraceError('a span cannot be its own parent');
  if (typeof s.name !== 'string' || s.name === '' || s.name.length > limits.maxNameLength) throw new TraceError(`span name must be 1 to ${limits.maxNameLength} characters`);
  if (typeof s.service !== 'string' || s.service === '' || s.service.length > limits.maxNameLength) throw new TraceError(`service must be 1 to ${limits.maxNameLength} characters`);
  if (!Number.isFinite(s.startMs) || s.startMs < 0) throw new TraceError('startMs must be a finite number, zero or more');
  if (!Number.isFinite(s.durationMs) || s.durationMs < 0) throw new TraceError('durationMs must be a finite number, zero or more');
  if (s.kind !== undefined && !KINDS.has(s.kind)) throw new TraceError(`unknown span kind "${String(s.kind)}"`);
  if (s.status !== undefined && !STATUSES.has(s.status)) throw new TraceError(`unknown span status "${String(s.status)}"`);
  if (s.attributes && Object.keys(s.attributes).length > limits.maxAttributes) throw new TraceError(`more than ${limits.maxAttributes} attributes`);
}

function hasError(s: Span): boolean {
  return s.status === 'error';
}

/** Length of the union of the intervals, clipped to [from, to]. */
function covered(intervals: readonly (readonly [number, number])[], from: number, to: number): number {
  const clipped = intervals
    .map(([a, b]) => [Math.max(a, from), Math.min(b, to)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curStart = NaN;
  let curEnd = NaN;
  for (const [a, b] of clipped) {
    if (Number.isNaN(curStart)) [curStart, curEnd] = [a, b];
    else if (a <= curEnd) curEnd = Math.max(curEnd, b);
    else {
      total += curEnd - curStart;
      [curStart, curEnd] = [a, b];
    }
  }
  if (!Number.isNaN(curStart)) total += curEnd - curStart;
  return total;
}

/** Build the tree for one trace's spans. Cycles are cut: a span in a cycle becomes an orphan. */
export function assemble(traceId: string, spans: readonly Span[]): Trace {
  const byId = new Map<string, Span>();
  for (const s of spans) if (!byId.has(s.spanId)) byId.set(s.spanId, s);
  const kids = new Map<string, Span[]>();
  const rootSpans: Span[] = [];
  const orphanSpans: Span[] = [];
  for (const s of byId.values()) {
    if (s.parentSpanId === undefined) rootSpans.push(s);
    else if (byId.has(s.parentSpanId)) (kids.get(s.parentSpanId) ?? kids.set(s.parentSpanId, []).get(s.parentSpanId)!).push(s);
    else orphanSpans.push(s);
  }
  const placed = new Set<string>();
  const build = (s: Span, depth: number): SpanNode => {
    placed.add(s.spanId);
    const children = (kids.get(s.spanId) ?? [])
      .filter((c) => !placed.has(c.spanId))
      .sort((a, b) => a.startMs - b.startMs || a.spanId.localeCompare(b.spanId))
      .map((c) => build(c, depth + 1));
    const end = s.startMs + s.durationMs;
    const selfMs = s.durationMs - covered(children.map((c) => [c.span.startMs, c.endMs] as const), s.startMs, end);
    return { span: s, children, depth, selfMs: Math.max(0, selfMs), endMs: end };
  };
  const order = (a: Span, b: Span) => a.startMs - b.startMs || a.spanId.localeCompare(b.spanId);
  const roots = rootSpans.sort(order).map((s) => build(s, 0));
  const orphans = orphanSpans.sort(order).map((s) => build(s, 0));
  // Anything still unplaced is in a cycle with no entry from a root: make the earliest of each cycle an orphan.
  const rest = [...byId.values()].filter((s) => !placed.has(s.spanId)).sort(order);
  for (const s of rest) if (!placed.has(s.spanId)) orphans.push(build(s, 0));

  const all = [...byId.values()];
  const start = all.length ? Math.min(...all.map((s) => s.startMs)) : 0;
  const end = all.length ? Math.max(...all.map((s) => s.startMs + s.durationMs)) : 0;
  const services = [...new Set(all.map((s) => s.service))].sort();

  const critical: Span[] = [];
  const primary = roots[0] ?? orphans[0];
  let node: SpanNode | undefined = primary;
  while (node) {
    critical.push(node.span);
    let next: SpanNode | undefined;
    for (const c of node.children) if (!next || c.endMs > next.endMs) next = c;
    node = next;
  }

  return {
    traceId,
    roots,
    orphans,
    spanCount: byId.size,
    services,
    startMs: start,
    endMs: end,
    durationMs: end - start,
    errorCount: all.filter(hasError).length,
    criticalPath: critical,
    complete: roots.length === 1 && orphans.length === 0,
  };
}

/** The service graph over a set of traces' spans. */
export function serviceGraph(spans: readonly Span[]): GraphEdge[] {
  const byTrace = new Map<string, Map<string, Span>>();
  for (const s of spans) (byTrace.get(s.traceId) ?? byTrace.set(s.traceId, new Map()).get(s.traceId)!).set(s.spanId, s);
  const acc = new Map<string, { from: string; to: string; durations: number[]; errors: number; inferred: boolean }>();
  const add = (from: string, to: string, ms: number, err: boolean, inferred: boolean) => {
    const key = `${from}\u0000${to}`;
    const e = acc.get(key) ?? { from, to, durations: [], errors: 0, inferred };
    e.durations.push(ms);
    if (err) e.errors++;
    if (!inferred) e.inferred = false;
    acc.set(key, e);
  };
  for (const [, ids] of byTrace) {
    const hasChild = new Set<string>();
    for (const s of ids.values()) if (s.parentSpanId) hasChild.add(s.parentSpanId);
    for (const s of ids.values()) {
      const parent = s.parentSpanId ? ids.get(s.parentSpanId) : undefined;
      if (parent && parent.service !== s.service) add(parent.service, s.service, s.durationMs, hasError(s), false);
      const peer = s.attributes?.['peer.service'];
      if (s.kind === 'client' && typeof peer === 'string' && peer !== '' && peer !== s.service && !hasChild.has(s.spanId)) {
        add(s.service, peer, s.durationMs, hasError(s), true);
      }
    }
  }
  return [...acc.values()]
    .map((e) => ({
      from: e.from,
      to: e.to,
      calls: e.durations.length,
      errors: e.errors,
      p50Ms: percentile(e.durations, 50),
      p95Ms: percentile(e.durations, 95),
      p99Ms: percentile(e.durations, 99),
      inferred: e.inferred,
    }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

interface Stored {
  readonly spans: Map<string, Span>;
  firstSeenMs: number;
  lastSeenMs: number;
}

/** In-memory span storage keyed by trace. */
export class TraceStore {
  readonly limits: Limits;
  private readonly traces = new Map<string, Stored>();

  constructor(limits: Partial<Limits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  get size(): number {
    return this.traces.size;
  }

  ingest(span: Span, nowMs: number): IngestResult {
    validateSpan(span, this.limits);
    let t = this.traces.get(span.traceId);
    if (!t) {
      if (this.traces.size >= this.limits.maxTraces) throw new TraceError(`the store holds ${this.limits.maxTraces} traces already; evict first`);
      t = { spans: new Map(), firstSeenMs: nowMs, lastSeenMs: nowMs };
      this.traces.set(span.traceId, t);
    }
    if (t.spans.has(span.spanId)) return 'duplicate';
    if (t.spans.size >= this.limits.maxSpansPerTrace) return 'trace-full';
    t.spans.set(span.spanId, span);
    t.lastSeenMs = nowMs;
    return 'stored';
  }

  has(traceId: string): boolean {
    return this.traces.has(traceId);
  }

  spans(traceId: string): Span[] {
    return [...(this.traces.get(traceId)?.spans.values() ?? [])];
  }

  lastSeen(traceId: string): number | undefined {
    return this.traces.get(traceId)?.lastSeenMs;
  }

  trace(traceId: string): Trace | undefined {
    const t = this.traces.get(traceId);
    return t ? assemble(traceId, [...t.spans.values()]) : undefined;
  }

  delete(traceId: string): boolean {
    return this.traces.delete(traceId);
  }

  /** Remove traces not written to for `ttlMs`. Returns the ids removed. */
  evict(nowMs: number, ttlMs: number): string[] {
    const gone: string[] = [];
    for (const [id, t] of this.traces) {
      if (nowMs - t.lastSeenMs >= ttlMs) {
        this.traces.delete(id);
        gone.push(id);
      }
    }
    return gone;
  }

  search(q: SearchQuery = {}): TraceSummary[] {
    const out: TraceSummary[] = [];
    for (const [id, stored] of this.traces) {
      const spans = [...stored.spans.values()];
      const tr = assemble(id, spans);
      if (q.fromMs !== undefined && tr.endMs < q.fromMs) continue;
      if (q.toMs !== undefined && tr.startMs > q.toMs) continue;
      if (q.minDurationMs !== undefined && tr.durationMs < q.minDurationMs) continue;
      if (q.maxDurationMs !== undefined && tr.durationMs > q.maxDurationMs) continue;
      if (q.errorsOnly && tr.errorCount === 0) continue;
      if (q.service !== undefined && !tr.services.includes(q.service)) continue;
      if (q.name !== undefined && !spans.some((s) => s.name === q.name)) continue;
      if (q.attribute && !spans.some((s) => s.attributes?.[q.attribute!.key] === q.attribute!.value)) continue;
      const root = tr.roots[0]?.span;
      out.push({ traceId: id, rootName: root?.name, rootService: root?.service, startMs: tr.startMs, durationMs: tr.durationMs, spanCount: tr.spanCount, errorCount: tr.errorCount, services: tr.services });
    }
    out.sort((a, b) => b.startMs - a.startMs || a.traceId.localeCompare(b.traceId));
    return q.limit === undefined ? out : out.slice(0, q.limit);
  }

  /** The service graph over every trace (or those touching the window). */
  graph(window?: { readonly fromMs?: number; readonly toMs?: number }): GraphEdge[] {
    const spans: Span[] = [];
    for (const t of this.traces.values()) {
      for (const s of t.spans.values()) {
        if (window?.fromMs !== undefined && s.startMs + s.durationMs < window.fromMs) continue;
        if (window?.toMs !== undefined && s.startMs > window.toMs) continue;
        spans.push(s);
      }
    }
    return serviceGraph(spans);
  }
}

// ------------------------------------------------------------------------------------------------ sampling

export type Policy =
  | { readonly type: 'errors' }
  | { readonly type: 'latency'; readonly thresholdMs: number }
  | { readonly type: 'attribute'; readonly key: string; readonly value: AttributeValue }
  | { readonly type: 'service'; readonly service: string }
  | { readonly type: 'probabilistic'; readonly percent: number }
  /** A baseline: keeps at most `perSecond` traces per second that no other policy kept. Always evaluated last. */
  | { readonly type: 'rate'; readonly perSecond: number };

export interface SamplerOptions {
  readonly policies: readonly Policy[];
  /** A trace is decided once no span arrived for this long. Default 30000. */
  readonly decisionWaitMs?: number;
  /** A trace is decided early when it reaches this many spans. Default 5000. */
  readonly maxSpansPerTrace?: number;
  /** Most traces held undecided; the oldest is decided early beyond this. Default 50000. */
  readonly maxPending?: number;
  /** Salt for the hash, so two deployments do not sample the same ids. */
  readonly salt?: string;
}

export interface Decision {
  readonly traceId: string;
  readonly keep: boolean;
  /** The policies that said keep (empty when dropped). */
  readonly reasons: readonly string[];
  readonly spans: readonly Span[];
}

/** Stable value in [0, 100) from a trace id: every collector sees the same number. */
export function hashPercent(traceId: string, salt = ''): number {
  const h = createHash('sha256').update(`${salt}:${traceId}`).digest();
  return (h.readUInt32BE(0) / 0x1_0000_0000) * 100;
}

export class TailSampler {
  private readonly opts: Required<Omit<SamplerOptions, 'policies'>> & { policies: readonly Policy[] };
  private readonly pending = new Map<string, { spans: Map<string, Span>; lastMs: number; firstMs: number }>();
  private readonly rateWindow = new Map<number, number>();

  constructor(options: SamplerOptions) {
    if (options.policies.length === 0) throw new TraceError('a sampler needs at least one policy');
    for (const p of options.policies) {
      if (p.type === 'probabilistic' && !(p.percent >= 0 && p.percent <= 100)) throw new TraceError('probabilistic percent must be between 0 and 100');
      if (p.type === 'rate' && !(p.perSecond > 0)) throw new TraceError('rate perSecond must be above zero');
      if (p.type === 'latency' && !(p.thresholdMs >= 0)) throw new TraceError('latency threshold must be zero or more');
    }
    this.opts = {
      policies: [...options.policies.filter((p) => p.type !== 'rate'), ...options.policies.filter((p) => p.type === 'rate')],
      decisionWaitMs: options.decisionWaitMs ?? 30_000,
      maxSpansPerTrace: options.maxSpansPerTrace ?? 5000,
      maxPending: options.maxPending ?? 50_000,
      salt: options.salt ?? '',
    };
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Take a span. Returns decisions made right away (a trace that hit its span cap, or the oldest when full). */
  add(span: Span, nowMs: number): Decision[] {
    validateSpan(span);
    const out: Decision[] = [];
    let t = this.pending.get(span.traceId);
    if (!t) {
      t = { spans: new Map(), lastMs: nowMs, firstMs: nowMs };
      this.pending.set(span.traceId, t);
    }
    if (!t.spans.has(span.spanId)) t.spans.set(span.spanId, span);
    t.lastMs = nowMs;
    if (t.spans.size >= this.opts.maxSpansPerTrace) out.push(this.decide(span.traceId, nowMs));
    while (this.pending.size > this.opts.maxPending) {
      let oldest: string | undefined;
      let oldestMs = Infinity;
      for (const [id, p] of this.pending) if (p.firstMs < oldestMs) [oldest, oldestMs] = [id, p.firstMs];
      if (oldest === undefined) break;
      out.push(this.decide(oldest, nowMs));
    }
    return out;
  }

  /** Decide every trace that has been quiet for the decision wait. */
  flush(nowMs: number): Decision[] {
    const due = [...this.pending].filter(([, t]) => nowMs - t.lastMs >= this.opts.decisionWaitMs).map(([id]) => id).sort();
    return due.map((id) => this.decide(id, nowMs));
  }

  /** Decide everything now, e.g. at shutdown. */
  drain(nowMs: number): Decision[] {
    return [...this.pending.keys()].sort().map((id) => this.decide(id, nowMs));
  }

  private decide(traceId: string, nowMs: number): Decision {
    const t = this.pending.get(traceId);
    this.pending.delete(traceId);
    const spans = t ? [...t.spans.values()] : [];
    const tr = assemble(traceId, spans);
    const reasons: string[] = [];
    const second = Math.floor(nowMs / 1000);
    for (const p of this.opts.policies) {
      switch (p.type) {
        case 'errors': if (tr.errorCount > 0) reasons.push('errors'); break;
        case 'latency': if (tr.durationMs >= p.thresholdMs) reasons.push(`latency>=${p.thresholdMs}ms`); break;
        case 'attribute': if (spans.some((s) => s.attributes?.[p.key] === p.value)) reasons.push(`attribute:${p.key}`); break;
        case 'service': if (tr.services.includes(p.service)) reasons.push(`service:${p.service}`); break;
        case 'probabilistic': if (hashPercent(traceId, this.opts.salt) < p.percent) reasons.push(`probabilistic:${p.percent}%`); break;
        case 'rate': {
          const used = this.rateWindow.get(second) ?? 0;
          if (reasons.length === 0 && used < p.perSecond) {
            this.rateWindow.set(second, used + 1);
            reasons.push(`rate:${p.perSecond}/s`);
          }
          break;
        }
      }
    }
    for (const k of this.rateWindow.keys()) if (k < second - 1) this.rateWindow.delete(k);
    return { traceId, keep: reasons.length > 0, reasons, spans };
  }
}
