/**
 * Observability: structured logs with sensitive fields redacted where they are written, errors grouped by where
 * they happened and linked to the request, the build and the feature, metrics (counters and latency histograms),
 * and traces that follow one request through every block it touches. A request's trace id rides along in an
 * async context, so every log line and span written while handling it carries the id without being passed.
 * Output is one JSON object per line in the field names Cloud Logging and Cloud Trace read.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';

export type Severity = 'DEBUG' | 'INFO' | 'NOTICE' | 'WARNING' | 'ERROR' | 'CRITICAL';

interface Ctx {
  readonly trace: string;
  readonly span: string;
  readonly feature?: string;
  readonly spans: SpanRecord[];
}

export interface SpanRecord {
  readonly trace: string;
  readonly span: string;
  readonly parent?: string;
  readonly name: string;
  readonly start: number;
  end?: number;
  status?: 'ok' | 'error';
  readonly attrs: Record<string, string | number | boolean>;
}

const als = new AsyncLocalStorage<Ctx>();
const hex = (n: number) => randomBytes(n).toString('hex');

/**
 * Keys whose values are never written, at any depth (short ones exactly, the rest wherever they appear in the key,
 * so "client_secret", "x-api-key" and "newPassword" are caught too), and value shapes that look like secrets
 * wherever they appear.
 */
export const SENSITIVE_KEYS = /^(?:ssn|card|cardnumber|cvv|cvc|pin|dob|dateofbirth)$|pass(?:wd|word)|secret|token|api[-_]?key|authorization|cookie|private[-_]?key|credential/i;
const SENSITIVE_VALUES: readonly [RegExp, string][] = [
  [/\b(?:\d[ -]?){13,19}\b/g, '[card]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[ssn]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, '$1 [redacted]'],
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}\b/g, '[key]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[jwt]'],
];

/** A copy with sensitive keys and secret-shaped values replaced, so nothing sensitive is ever written. */
export function redact(v: unknown, extraKeys: readonly string[] = [], depth = 0): unknown {
  if (depth > 8) return '[deep]';
  if (typeof v === 'string') return SENSITIVE_VALUES.reduce((s, [re, rep]) => s.replace(re, rep), v);
  if (Array.isArray(v)) return v.map((x) => redact(x, extraKeys, depth + 1));
  if (v instanceof Error) return { name: v.name, message: redact(v.message, extraKeys, depth + 1) };
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SENSITIVE_KEYS.test(k) || extraKeys.includes(k) ? '[redacted]' : redact(x, extraKeys, depth + 1)]));
  return v;
}

export interface LoggerOptions {
  readonly write?: (line: string) => void;
  readonly project?: string;
  readonly build?: string;
  readonly min?: Severity;
  readonly extraSensitive?: readonly string[];
}

const ORDER: Severity[] = ['DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL'];

export class Logger {
  private readonly o: LoggerOptions;
  constructor(o: LoggerOptions = {}) {
    this.o = o;
  }
  log(severity: Severity, message: string, fields: Record<string, unknown> = {}): void {
    if (ORDER.indexOf(severity) < ORDER.indexOf(this.o.min ?? 'DEBUG')) return;
    const c = als.getStore();
    // Fields first, so none of them can overwrite the severity, message or time the line is filed under.
    const line: Record<string, unknown> = { ...(redact(fields, this.o.extraSensitive) as object), severity, message: redact(message), time: new Date().toISOString() };
    if (this.o.build) line['build'] = this.o.build;
    if (c) {
      line['logging.googleapis.com/trace'] = this.o.project ? `projects/${this.o.project}/traces/${c.trace}` : c.trace;
      line['logging.googleapis.com/spanId'] = c.span;
      if (c.feature) line['feature'] = c.feature;
    }
    (this.o.write ?? ((l) => process.stdout.write(`${l}\n`)))(JSON.stringify(line));
  }
  info(m: string, f?: Record<string, unknown>) {
    this.log('INFO', m, f);
  }
  warn(m: string, f?: Record<string, unknown>) {
    this.log('WARNING', m, f);
  }
  error(m: string, f?: Record<string, unknown>) {
    this.log('ERROR', m, f);
  }
}

/** The trace id from a W3C traceparent header, or a new one (an all-zero trace or parent id is invalid there). */
export function traceFrom(header: string | undefined): { trace: string; parent?: string } {
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(header ?? '');
  return m && !/^0+$/.test(m[1]!) && !/^0+$/.test(m[2]!) ? { trace: m[1]!, parent: m[2]! } : { trace: hex(16) };
}

/** Runs a request's work in a trace; everything logged or spanned inside carries its id. */
export function withTrace<T>(o: { traceparent?: string; feature?: string; name: string }, run: () => Promise<T>): Promise<{ result: T; spans: SpanRecord[] }> {
  const t = traceFrom(o.traceparent);
  const root: SpanRecord = { trace: t.trace, span: hex(8), ...(t.parent ? { parent: t.parent } : {}), name: o.name, start: performance.now(), attrs: {} };
  const ctx: Ctx = { trace: t.trace, span: root.span, ...(o.feature ? { feature: o.feature } : {}), spans: [root] };
  return als.run(ctx, async () => {
    try {
      const result = await run();
      root.end = performance.now();
      root.status = 'ok';
      return { result, spans: ctx.spans };
    } catch (e) {
      root.end = performance.now();
      root.status = 'error';
      throw e;
    }
  });
}

/** A named step inside the current trace: one span, timed, with its outcome. */
export async function span<T>(name: string, run: () => Promise<T>, attrs: Record<string, string | number | boolean> = {}): Promise<T> {
  const c = als.getStore();
  if (!c) return run();
  const s: SpanRecord = { trace: c.trace, span: hex(8), parent: c.span, name, start: performance.now(), attrs };
  c.spans.push(s);
  return als.run({ ...c, span: s.span }, async () => {
    try {
      const r = await run();
      s.status = 'ok';
      return r;
    } catch (e) {
      s.status = 'error';
      throw e;
    } finally {
      s.end = performance.now();
    }
  });
}

export const currentTrace = () => als.getStore()?.trace;

/** A traceparent header to pass the current trace to another service. */
export const traceparent = () => {
  const c = als.getStore();
  return c ? `00-${c.trace}-${c.span}-01` : undefined;
};

// ---------------------------------------------------------------- errors, grouped

export interface ErrorGroup {
  readonly fingerprint: string;
  readonly name: string;
  readonly message: string;
  readonly where: string;
  count: number;
  first: string;
  last: string;
  readonly builds: Set<string>;
  readonly features: Set<string>;
  readonly traces: string[];
}

/** Where an error was thrown, from the first stack frame in the application's own code. */
const whereOf = (e: Error) =>
  (e.stack ?? '')
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .find((l) => !l.includes('node:') && !l.includes('node_modules'))
    ?.replace(/^at\s+/, '')
    .replace(/:\d+\)?$/, '')
    .replace(/\(.*[\\/]/, '(') ?? 'unknown';

/**
 * Errors grouped by kind and the place they were thrown, with numbers and ids stripped from the message, so a
 * thousand occurrences are one group with a count, linked to the builds, features and traces that saw it.
 */
export class Errors {
  readonly groups = new Map<string, ErrorGroup>();
  private readonly onNew?: (g: ErrorGroup) => void;
  constructor(o: { onNew?: (g: ErrorGroup) => void } = {}) {
    if (o.onNew) this.onNew = o.onNew;
  }
  capture(e: unknown, o: { build?: string; feature?: string } = {}): ErrorGroup {
    const err = e instanceof Error ? e : new Error(String(e));
    const shape = String(redact(err.message)).replace(/[0-9a-f]{8,}|\d+/gi, '#');
    const where = whereOf(err);
    const fingerprint = createHash('sha256').update(`${err.name}|${where}|${shape}`).digest('hex').slice(0, 16);
    const now = new Date().toISOString();
    let g = this.groups.get(fingerprint);
    if (!g) {
      g = { fingerprint, name: err.name, message: shape, where, count: 0, first: now, last: now, builds: new Set(), features: new Set(), traces: [] };
      this.groups.set(fingerprint, g);
      this.onNew?.(g);
    }
    g.count++;
    g.last = now;
    const feature = o.feature ?? als.getStore()?.feature;
    if (o.build) g.builds.add(o.build);
    if (feature) g.features.add(feature);
    const t = currentTrace();
    if (t && g.traces.length < 20) g.traces.push(t);
    return g;
  }
}

// ---------------------------------------------------------------- metrics

const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** A label value as the text format writes it: backslash, double quote and line feed escaped. */
const escapeLabel = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

interface Series {
  readonly name: string;
  /** The rendered label pairs, sorted by name, without braces. */
  readonly labels: string;
}

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly hist = new Map<string, { buckets: number[]; sum: number }>();
  private readonly samples = new Map<string, number[]>();
  private readonly series = new Map<string, Series>();
  private key(name: string, labels: Record<string, string>) {
    if (!METRIC_NAME.test(name)) throw new Error(`"${name}" is not a Prometheus metric name`);
    const l = Object.entries(labels)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => {
        if (!LABEL_NAME.test(k) || k.startsWith('__') || k === 'le') throw new Error(`"${k}" is not a label name that can be used`);
        return `${k}="${escapeLabel(String(v))}"`;
      })
      .join(',');
    const k = l ? `${name}{${l}}` : name;
    if (!this.series.has(k)) this.series.set(k, { name, labels: l });
    return k;
  }
  count(name: string, labels: Record<string, string> = {}, by = 1): void {
    const k = this.key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }
  observe(name: string, ms: number, labels: Record<string, string> = {}): void {
    const k = this.key(name, labels);
    const h = this.hist.get(k) ?? { buckets: new Array<number>(BUCKETS.length + 1).fill(0), sum: 0 };
    const i = BUCKETS.findIndex((b) => ms <= b);
    h.buckets[i < 0 ? BUCKETS.length : i]!++;
    h.sum += ms;
    this.hist.set(k, h);
    const s = this.samples.get(k) ?? [];
    s.push(ms);
    if (s.length > 2000) s.splice(0, s.length - 2000);
    this.samples.set(k, s);
  }
  value(name: string, labels: Record<string, string> = {}): number {
    return this.counters.get(this.key(name, labels)) ?? 0;
  }
  /** A percentile of recent observations. */
  percentile(name: string, p: number, labels: Record<string, string> = {}): number | null {
    const s = [...(this.samples.get(this.key(name, labels)) ?? [])].sort((a, b) => a - b);
    if (!s.length) return null;
    return s[Math.max(0, Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1))]!;
  }
  /**
   * Everything in the Prometheus text format (version 0.0.4): each family once, with its TYPE line and all its
   * series together; a histogram's buckets cumulative in increasing order, then +Inf, _sum and _count.
   */
  text(): string {
    const families = new Map<string, { type: 'counter' | 'histogram'; lines: string[] }>();
    const family = (name: string, type: 'counter' | 'histogram') => {
      let f = families.get(name);
      if (!f) families.set(name, (f = { type, lines: [] }));
      return f.lines;
    };
    const sortedKeys = (m: Map<string, unknown>) => [...m.keys()].sort();
    for (const k of sortedKeys(this.counters)) family(this.series.get(k)!.name, 'counter').push(`${k} ${this.counters.get(k)!}`);
    for (const k of sortedKeys(this.hist)) {
      const { name, labels } = this.series.get(k)!;
      const h = this.hist.get(k)!;
      const out = family(name, 'histogram');
      const braces = labels ? `{${labels}}` : '';
      let acc = 0;
      BUCKETS.forEach((b, i) => {
        acc += h.buckets[i]!;
        out.push(`${name}_bucket{${labels ? `${labels},` : ''}le="${b}"} ${acc}`);
      });
      acc += h.buckets[BUCKETS.length]!;
      out.push(`${name}_bucket{${labels ? `${labels},` : ''}le="+Inf"} ${acc}`);
      out.push(`${name}_sum${braces} ${h.sum}`);
      out.push(`${name}_count${braces} ${acc}`);
    }
    const lines: string[] = [];
    for (const name of [...families.keys()].sort()) {
      const f = families.get(name)!;
      lines.push(`# TYPE ${name} ${f.type}`, ...f.lines);
    }
    return `${lines.join('\n')}\n`;
  }
}

// ---------------------------------------------------------------- log retention

export interface RetentionRule {
  /** Matches a log line's severity or its "kind" field. */
  readonly match: { severity?: Severity; kind?: string };
  readonly days: number;
}

/** How long a line is kept: the longest matching rule, or the default. Audit-class lines are never matched shorter. */
export function keepDays(line: { severity: Severity; kind?: string }, rules: readonly RetentionRule[], fallback = 30): number {
  const hits = rules.filter((r) => (!r.match.severity || r.match.severity === line.severity) && (!r.match.kind || r.match.kind === line.kind));
  return hits.length ? Math.max(...hits.map((r) => r.days)) : fallback;
}
