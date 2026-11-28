/**
 * A subset of PromQL (the Prometheus query language) that parses real queries and evaluates them over series held in
 * memory. Supported: instant vector selectors with label matchers (`=`, `!=`, `=~`, `!~`, regex fully anchored),
 * range selectors (`[5m]`, compound durations like `1h30m`) and `offset`; the functions rate, irate, increase, delta,
 * idelta, sum/avg/min/max/count/last_over_time, histogram_quantile, abs, ceil, floor, round, sqrt, exp, ln, log2,
 * log10, clamp, clamp_min, clamp_max, absent, scalar, vector, time, sort, sort_desc, label_replace; the aggregations
 * sum, avg, min, max, count, topk and bottomk with `by` or `without` before or after the argument; binary operators
 * (`+ - * / % ^`, comparisons with optional `bool`, `and or unless`) between scalars, vectors and mixes, with `on(...)`
 * and `ignoring(...)` one-to-one matching; unary minus; parentheses.
 *
 * Semantics follow Prometheus: an instant selector takes the newest sample inside the lookback window (default 5
 * minutes); `rate` and `increase` extrapolate to the window edges the way Prometheus does (a counter is not
 * extrapolated below zero), handle counter resets, and need two samples; the window is open at its start and closed at
 * its end; functions drop the metric name; histogram_quantile groups series by every label but `le` and uses the
 * interpolation of the prometheus-text block; a range query evaluates at start, start + step, ... up to end, so
 * `alignRange` can snap start to a multiple of the step the way dashboards do, and the number of steps is capped.
 *
 * Safety: expression depth, regex length, series selected and steps are capped; a regex with a nested quantifier is
 * refused (it could take forever); many-to-many matching is an error, as in Prometheus.
 *
 * Out of scope: subqueries, `group_left` and `group_right`, `@` modifiers, native histograms, recording and alerting
 * rules, and any I/O (series come from `ingest` or `ingestText`).
 */
import { counterDelta } from '../timeseries/index.ts';
import type { Point } from '../timeseries/index.ts';
import { histogramQuantile, parseExposition } from '../prometheus-text/index.ts';

export class PromQLError extends Error {
  readonly position: number | undefined;
  constructor(message: string, position?: number) {
    super(position === undefined ? message : `${message} (at position ${position})`);
    this.position = position;
  }
}

export type Labels = Readonly<Record<string, string>>;
export interface Limits {
  readonly lookbackMs: number;
  readonly maxDepth: number;
  readonly maxRegexLength: number;
  readonly maxSeries: number;
  readonly maxSteps: number;
}
export const DEFAULT_LIMITS: Limits = { lookbackMs: 300_000, maxDepth: 64, maxRegexLength: 256, maxSeries: 50_000, maxSteps: 11_000 };

// ------------------------------------------------------------------------------------------------ lexer

type Tok =
  | { k: 'num'; v: number; pos: number }
  | { k: 'dur'; v: number; pos: number }
  | { k: 'str'; v: string; pos: number }
  | { k: 'id'; v: string; pos: number }
  | { k: 'op'; v: string; pos: number }
  | { k: 'eof'; pos: number };

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, y: 31_536_000_000 };

export function parseDuration(text: string): number {
  const re = /(\d+)(ms|s|m|h|d|w|y)/y;
  let total = 0;
  let i = 0;
  while (i < text.length) {
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) throw new PromQLError(`"${text}" is not a duration`);
    total += Number(m[1]) * (UNIT_MS[m[2] as string] as number);
    i = re.lastIndex;
  }
  if (text === '') throw new PromQLError('empty duration');
  return total;
}

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const OPS = ['==', '!=', '>=', '<=', '=~', '!~', '+', '-', '*', '/', '%', '^', '>', '<', '=', '(', ')', '{', '}', '[', ']', ','];
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^(?:\d+(?:ms|s|m|h|d|w|y))+(?![A-Za-z0-9_])/.exec(rest))) {
      out.push({ k: 'dur', v: parseDuration(m[0]), pos: i });
      i += m[0].length;
    } else if ((m = /^(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(rest))) {
      out.push({ k: 'num', v: Number(m[0]), pos: i });
      i += m[0].length;
    } else if ((m = /^[A-Za-z_:][A-Za-z0-9_:]*/.exec(rest))) {
      out.push({ k: 'id', v: m[0], pos: i });
      i += m[0].length;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      for (;;) {
        if (j >= src.length) throw new PromQLError('unterminated string', i);
        const ch = src[j] as string;
        if (ch === c) break;
        if (ch === '\\') {
          const e = src[j + 1];
          if (e === undefined) throw new PromQLError('unterminated string', i);
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          j += 2;
        } else {
          s += ch;
          j++;
        }
      }
      out.push({ k: 'str', v: s, pos: i });
      i = j + 1;
    } else {
      const op = OPS.find((o) => rest.startsWith(o));
      if (!op) throw new PromQLError(`unexpected character "${c}"`, i);
      out.push({ k: 'op', v: op, pos: i });
      i += op.length;
    }
  }
  out.push({ k: 'eof', pos: src.length });
  return out;
}

// ------------------------------------------------------------------------------------------------ AST

export type MatchOp = '=' | '!=' | '=~' | '!~';
export interface Matcher { readonly label: string; readonly op: MatchOp; readonly value: string }
export type Matching = { readonly on: boolean; readonly labels: readonly string[] };

export type Node =
  | { readonly t: 'num'; readonly v: number }
  | { readonly t: 'selector'; readonly name: string | undefined; readonly matchers: readonly Matcher[]; readonly rangeMs: number | undefined; readonly offsetMs: number }
  | { readonly t: 'call'; readonly fn: string; readonly args: readonly Node[]; readonly strs: readonly string[] }
  | { readonly t: 'agg'; readonly op: string; readonly param: Node | undefined; readonly expr: Node; readonly by: readonly string[] | undefined; readonly without: readonly string[] | undefined }
  | { readonly t: 'bin'; readonly op: string; readonly l: Node; readonly r: Node; readonly bool: boolean; readonly matching: Matching | undefined }
  | { readonly t: 'neg'; readonly e: Node };

const AGGS = new Set(['sum', 'avg', 'min', 'max', 'count', 'topk', 'bottomk']);
const FUNCS: Record<string, { min: number; max: number }> = {
  rate: { min: 1, max: 1 }, irate: { min: 1, max: 1 }, increase: { min: 1, max: 1 }, delta: { min: 1, max: 1 }, idelta: { min: 1, max: 1 },
  sum_over_time: { min: 1, max: 1 }, avg_over_time: { min: 1, max: 1 }, min_over_time: { min: 1, max: 1 }, max_over_time: { min: 1, max: 1 },
  count_over_time: { min: 1, max: 1 }, last_over_time: { min: 1, max: 1 },
  histogram_quantile: { min: 2, max: 2 },
  abs: { min: 1, max: 1 }, ceil: { min: 1, max: 1 }, floor: { min: 1, max: 1 }, round: { min: 1, max: 2 }, sqrt: { min: 1, max: 1 },
  exp: { min: 1, max: 1 }, ln: { min: 1, max: 1 }, log2: { min: 1, max: 1 }, log10: { min: 1, max: 1 },
  clamp: { min: 3, max: 3 }, clamp_min: { min: 2, max: 2 }, clamp_max: { min: 2, max: 2 },
  absent: { min: 1, max: 1 }, scalar: { min: 1, max: 1 }, vector: { min: 1, max: 1 }, time: { min: 0, max: 0 },
  sort: { min: 1, max: 1 }, sort_desc: { min: 1, max: 1 }, label_replace: { min: 5, max: 5 },
};
const RANGE_FUNCS = new Set(['rate', 'irate', 'increase', 'delta', 'idelta', 'sum_over_time', 'avg_over_time', 'min_over_time', 'max_over_time', 'count_over_time', 'last_over_time']);

const PREC: Record<string, number> = { or: 1, and: 2, unless: 2, '==': 3, '!=': 3, '<': 3, '>': 3, '<=': 3, '>=': 3, '+': 4, '-': 4, '*': 5, '/': 5, '%': 5, '^': 6 };

class Parser {
  private i = 0;
  private depth = 0;
  private readonly toks: Tok[];
  private readonly limits: Limits;
  constructor(toks: Tok[], limits: Limits) {
    this.toks = toks;
    this.limits = limits;
  }

  private get cur(): Tok { return this.toks[this.i] as Tok; }
  private next(): Tok { return this.toks[this.i++] as Tok; }
  private isOp(v: string): boolean { return this.cur.k === 'op' && this.cur.v === v; }
  private isId(v: string): boolean { return this.cur.k === 'id' && this.cur.v === v; }
  private expectOp(v: string): void {
    if (!this.isOp(v)) throw new PromQLError(`expected "${v}"`, this.cur.pos);
    this.i++;
  }

  parse(): Node {
    const e = this.expr(0);
    if (this.cur.k !== 'eof') throw new PromQLError('unexpected input after the expression', this.cur.pos);
    return e;
  }

  private binOpAt(): string | undefined {
    const c = this.cur;
    if (c.k === 'op' && PREC[c.v] !== undefined) return c.v;
    if (c.k === 'id' && (c.v === 'and' || c.v === 'or' || c.v === 'unless')) return c.v;
    return undefined;
  }

  private expr(minPrec: number): Node {
    if (++this.depth > this.limits.maxDepth) throw new PromQLError('expression nested too deeply', this.cur.pos);
    let left = this.unary();
    for (;;) {
      const op = this.binOpAt();
      if (op === undefined) break;
      const prec = PREC[op] as number;
      if (prec < minPrec) break;
      this.i++;
      let bool = false;
      let matching: Matching | undefined;
      if (this.isId('bool')) {
        if (prec !== 3) throw new PromQLError('"bool" is only for comparisons', this.cur.pos);
        bool = true;
        this.i++;
      }
      if (this.isId('on') || this.isId('ignoring')) {
        const on = this.next().k === 'id' && (this.toks[this.i - 1] as { v: string }).v === 'on';
        matching = { on, labels: this.labelList() };
      }
      if (this.isId('group_left') || this.isId('group_right')) throw new PromQLError('group_left and group_right are not supported', this.cur.pos);
      const right = this.expr(op === '^' ? prec : prec + 1);
      left = { t: 'bin', op, l: left, r: right, bool, matching };
    }
    this.depth--;
    return left;
  }

  private unary(): Node {
    if (this.isOp('-') || this.isOp('+')) {
      const neg = this.next();
      // unary minus binds looser than ^: -2^2 is -4
      const e = this.expr(6);
      return (neg as { v: string }).v === '-' ? { t: 'neg', e } : e;
    }
    return this.postfix();
  }

  private labelList(): string[] {
    this.expectOp('(');
    const out: string[] = [];
    while (!this.isOp(')')) {
      const t = this.next();
      if (t.k !== 'id') throw new PromQLError('expected a label name', t.pos);
      out.push(t.v);
      if (this.isOp(',')) this.i++;
      else if (!this.isOp(')')) throw new PromQLError('expected "," or ")"', this.cur.pos);
    }
    this.i++;
    return out;
  }

  private postfix(): Node {
    const t = this.cur;
    if (t.k === 'num') { this.i++; return { t: 'num', v: t.v }; }
    if (t.k === 'dur') throw new PromQLError('a duration is not a value here', t.pos);
    if (t.k === 'str') throw new PromQLError('a string is not a value here', t.pos);
    if (t.k === 'op' && t.v === '(') {
      this.i++;
      const e = this.expr(0);
      this.expectOp(')');
      return e;
    }
    if (t.k === 'op' && t.v === '{') return this.selector(undefined);
    if (t.k === 'id') {
      const lower = t.v.toLowerCase();
      if (lower === 'inf') { this.i++; return { t: 'num', v: Infinity }; }
      if (lower === 'nan') { this.i++; return { t: 'num', v: NaN }; }
      if (AGGS.has(t.v)) return this.aggregation();
      const nxt = this.toks[this.i + 1] as Tok;
      if (nxt.k === 'op' && nxt.v === '(' && t.v in FUNCS) return this.call();
      if (nxt.k === 'op' && nxt.v === '(') throw new PromQLError(`unknown function "${t.v}"`, t.pos);
      this.i++;
      return this.selector(t.v);
    }
    throw new PromQLError('unexpected input', t.pos);
  }

  private selector(name: string | undefined): Node {
    const matchers: Matcher[] = [];
    if (this.isOp('{')) {
      this.i++;
      while (!this.isOp('}')) {
        const l = this.next();
        if (l.k !== 'id') throw new PromQLError('expected a label name', l.pos);
        const op = this.next();
        if (op.k !== 'op' || !['=', '!=', '=~', '!~'].includes(op.v)) throw new PromQLError('expected =, !=, =~ or !~', op.pos);
        const v = this.next();
        if (v.k !== 'str') throw new PromQLError('a label value must be a quoted string', v.pos);
        if ((op.v === '=~' || op.v === '!~') && v.v.length > this.limits.maxRegexLength) throw new PromQLError(`regex longer than ${this.limits.maxRegexLength} characters`, v.pos);
        if (op.v === '=~' || op.v === '!~') safeRegex(v.v, v.pos);
        matchers.push({ label: l.v, op: op.v as MatchOp, value: v.v });
        if (this.isOp(',')) this.i++;
        else if (!this.isOp('}')) throw new PromQLError('expected "," or "}"', this.cur.pos);
      }
      this.i++;
    }
    if (name === undefined && matchers.length === 0) throw new PromQLError('a selector needs a name or a matcher', this.cur.pos);
    if (name === undefined && matchers.every((m) => matches('', m))) throw new PromQLError('a selector must match something other than the empty string', this.cur.pos);
    let rangeMs: number | undefined;
    if (this.isOp('[')) {
      this.i++;
      const d = this.next();
      if (d.k !== 'dur') throw new PromQLError('expected a duration like 5m', d.pos);
      if (d.v <= 0) throw new PromQLError('a range must be longer than zero', d.pos);
      rangeMs = d.v;
      this.expectOp(']');
    }
    let offsetMs = 0;
    if (this.isId('offset')) {
      this.i++;
      let sign = 1;
      if (this.isOp('-')) { sign = -1; this.i++; }
      const d = this.next();
      if (d.k !== 'dur') throw new PromQLError('expected a duration after offset', d.pos);
      offsetMs = sign * d.v;
    }
    return { t: 'selector', name, matchers, rangeMs, offsetMs };
  }

  private call(): Node {
    const nameTok = this.next() as { v: string; pos: number };
    this.expectOp('(');
    const args: Node[] = [];
    const strs: string[] = [];
    while (!this.isOp(')')) {
      if (this.cur.k === 'str') strs.push(this.next().k === 'str' ? (this.toks[this.i - 1] as { v: string }).v : '');
      else args.push(this.expr(0));
      if (this.isOp(',')) this.i++;
      else if (!this.isOp(')')) throw new PromQLError('expected "," or ")"', this.cur.pos);
    }
    this.i++;
    const spec = FUNCS[nameTok.v] as { min: number; max: number };
    const total = args.length + strs.length;
    if (nameTok.v !== 'label_replace' && strs.length) throw new PromQLError(`${nameTok.v} takes no string arguments`, nameTok.pos);
    if (total < spec.min || total > spec.max) throw new PromQLError(`${nameTok.v} takes ${spec.min === spec.max ? spec.min : `${spec.min} to ${spec.max}`} argument(s), got ${total}`, nameTok.pos);
    if (nameTok.v === 'label_replace' && (strs.length !== 4 || args.length !== 1)) throw new PromQLError('label_replace(v, "dst", "replacement", "src", "regex")', nameTok.pos);
    if (RANGE_FUNCS.has(nameTok.v)) {
      const a = args[0] as Node;
      if (a.t !== 'selector' || a.rangeMs === undefined) throw new PromQLError(`${nameTok.v} needs a range vector such as metric[5m]`, nameTok.pos);
    }
    return { t: 'call', fn: nameTok.v, args, strs };
  }

  private aggregation(): Node {
    const op = (this.next() as { v: string }).v;
    let by: string[] | undefined;
    let without: string[] | undefined;
    const grouping = () => {
      if (this.isId('by')) { this.i++; by = this.labelList(); }
      else if (this.isId('without')) { this.i++; without = this.labelList(); }
    };
    grouping();
    this.expectOp('(');
    let param: Node | undefined;
    if (op === 'topk' || op === 'bottomk') {
      param = this.expr(0);
      this.expectOp(',');
    }
    const expr = this.expr(0);
    this.expectOp(')');
    if (by === undefined && without === undefined) grouping();
    return { t: 'agg', op, param, expr, by, without };
  }
}

/** Refuse a regex that could backtrack without end: a group holding a quantifier that is itself quantified. */
function safeRegex(src: string, pos: number): RegExp {
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)/.test(src) || /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*[+*]/.test(src)) {
    throw new PromQLError('regex with a nested quantifier is refused', pos);
  }
  try {
    return new RegExp(`^(?:${src})$`, 's');
  } catch {
    throw new PromQLError(`"${src}" is not a valid regex`, pos);
  }
}

export function parse(src: string, limits: Partial<Limits> = {}): Node {
  if (src.trim() === '') throw new PromQLError('empty query');
  return new Parser(lex(src), { ...DEFAULT_LIMITS, ...limits }).parse();
}

// ------------------------------------------------------------------------------------------------ store

interface Series {
  readonly labels: Labels; // includes __name__
  readonly points: Point[]; // sorted by t
}

const key = (labels: Labels) => JSON.stringify(Object.keys(labels).sort().map((k) => [k, labels[k]]));

function matches(actual: string, m: Matcher): boolean {
  switch (m.op) {
    case '=': return actual === m.value;
    case '!=': return actual !== m.value;
    case '=~': return safeRegex(m.value, 0).test(actual);
    case '!~': return !safeRegex(m.value, 0).test(actual);
  }
}

export class SeriesStore {
  private readonly series = new Map<string, Series>();

  get size(): number {
    return this.series.size;
  }

  /** Add one sample. Samples may arrive out of order; the same timestamp replaces. */
  ingest(name: string, labels: Labels, t: number, v: number): void {
    if (!/^[A-Za-z_:][A-Za-z0-9_:]*$/.test(name)) throw new PromQLError(`"${name}" is not a metric name`);
    if (!Number.isFinite(t)) throw new PromQLError('timestamp must be finite');
    const full: Labels = { ...labels, __name__: name };
    for (const k of Object.keys(full)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new PromQLError(`"${k}" is not a label name`);
    const k = key(full);
    let s = this.series.get(k);
    if (!s) {
      s = { labels: full, points: [] };
      this.series.set(k, s);
    }
    const pts = s.points;
    if (pts.length === 0 || (pts[pts.length - 1] as Point).t < t) pts.push({ t, v });
    else {
      const at = pts.findIndex((p) => p.t >= t);
      if ((pts[at] as Point).t === t) pts[at] = { t, v };
      else pts.splice(at, 0, { t, v });
    }
  }

  /** Read a scrape in Prometheus or OpenMetrics text and store each sample at `t` (a sample's own timestamp wins). */
  ingestText(text: string, t: number): number {
    const r = parseExposition(text);
    let n = 0;
    for (const f of r.families) for (const s of f.samples) {
      this.ingest(s.name, s.labels, s.timestampMs ?? t, s.value);
      n++;
    }
    return n;
  }

  select(name: string | undefined, matchers: readonly Matcher[], limit: number): Series[] {
    const all: Matcher[] = name === undefined ? [...matchers] : [{ label: '__name__', op: '=', value: name }, ...matchers];
    const out: Series[] = [];
    for (const s of this.series.values()) {
      if (all.every((m) => matches(s.labels[m.label] ?? '', m))) {
        out.push(s);
        if (out.length > limit) throw new PromQLError(`query selects more than ${limit} series`);
      }
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------------ evaluation

export interface VectorSample { readonly labels: Labels; readonly value: number }
export interface MatrixSeries { readonly labels: Labels; readonly points: Point[] }
export type Result =
  | { readonly type: 'scalar'; readonly value: number }
  | { readonly type: 'vector'; readonly samples: VectorSample[] }
  | { readonly type: 'matrix'; readonly series: MatrixSeries[] };

type RangeVec = { readonly type: 'range'; readonly series: { labels: Labels; points: Point[] }[]; readonly startMs: number; readonly endMs: number };
type V = { type: 'scalar'; value: number } | { type: 'vector'; samples: VectorSample[] } | RangeVec;

const withoutName = (l: Labels): Labels => {
  const { __name__: _n, ...rest } = l as Record<string, string>;
  return rest;
};

function extrapolated(points: readonly Point[], startMs: number, endMs: number, isCounter: boolean, isRate: boolean): number | undefined {
  if (points.length < 2) return undefined;
  const first = points[0] as Point;
  const last = points[points.length - 1] as Point;
  let result = last.v - first.v;
  if (isCounter) for (let i = 1; i < points.length; i++) if ((points[i] as Point).v < (points[i - 1] as Point).v) result += (points[i - 1] as Point).v;
  let toStart = (first.t - startMs) / 1000;
  let toEnd = (endMs - last.t) / 1000;
  const sampled = (last.t - first.t) / 1000;
  if (sampled <= 0) return undefined;
  const avgBetween = sampled / (points.length - 1);
  const threshold = avgBetween * 1.1;
  if (isCounter && result > 0 && first.v >= 0) {
    const toZero = sampled * (first.v / result);
    if (toZero < toStart) toStart = toZero;
  }
  if (toStart >= threshold) toStart = avgBetween / 2;
  if (toEnd >= threshold) toEnd = avgBetween / 2;
  result *= (sampled + toStart + toEnd) / sampled;
  return isRate ? result / ((endMs - startMs) / 1000) : result;
}

function arith(op: string, a: number, b: number): number {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return a / b;
    case '%': return a % b;
    case '^': return Math.pow(a, b);
  }
  throw new PromQLError(`unknown operator ${op}`);
}
function compare(op: string, a: number, b: number): boolean {
  switch (op) {
    case '==': return a === b;
    case '!=': return a !== b;
    case '<': return a < b;
    case '>': return a > b;
    case '<=': return a <= b;
    case '>=': return a >= b;
  }
  throw new PromQLError(`unknown operator ${op}`);
}

class Evaluator {
  private readonly store: SeriesStore;
  private readonly limits: Limits;
  constructor(store: SeriesStore, limits: Limits) {
    this.store = store;
    this.limits = limits;
  }

  eval(n: Node, t: number): V {
    switch (n.t) {
      case 'num': return { type: 'scalar', value: n.v };
      case 'neg': {
        const v = this.eval(n.e, t);
        if (v.type === 'scalar') return { type: 'scalar', value: -v.value };
        if (v.type === 'vector') return { type: 'vector', samples: v.samples.map((s) => ({ labels: withoutName(s.labels), value: -s.value })) };
        throw new PromQLError('cannot negate a range vector');
      }
      case 'selector': return this.selector(n, t);
      case 'call': return this.call(n, t);
      case 'agg': return this.agg(n, t);
      case 'bin': return this.bin(n, t);
    }
  }

  private selector(n: Extract<Node, { t: 'selector' }>, t: number): V {
    const at = t - n.offsetMs;
    const found = this.store.select(n.name, n.matchers, this.limits.maxSeries);
    if (n.rangeMs !== undefined) {
      const startMs = at - n.rangeMs;
      const series = found
        .map((s) => ({ labels: s.labels, points: s.points.filter((p) => p.t > startMs && p.t <= at) }))
        .filter((s) => s.points.length > 0);
      return { type: 'range', series, startMs, endMs: at };
    }
    const samples: VectorSample[] = [];
    for (const s of found) {
      let best: Point | undefined;
      for (const p of s.points) if (p.t <= at && p.t > at - this.limits.lookbackMs) best = p;
      if (best) samples.push({ labels: s.labels, value: best.v });
    }
    return { type: 'vector', samples };
  }

  private scalarArg(n: Node, t: number, what: string): number {
    const v = this.eval(n, t);
    if (v.type !== 'scalar') throw new PromQLError(`${what} must be a scalar`);
    return v.value;
  }
  private vectorArg(n: Node, t: number, what: string): VectorSample[] {
    const v = this.eval(n, t);
    if (v.type !== 'vector') throw new PromQLError(`${what} must be an instant vector`);
    return v.samples;
  }

  private call(n: Extract<Node, { t: 'call' }>, t: number): V {
    const fn = n.fn;
    if (RANGE_FUNCS.has(fn)) {
      const r = this.eval(n.args[0] as Node, t) as RangeVec;
      const samples: VectorSample[] = [];
      for (const s of r.series) {
        const pts = s.points;
        let value: number | undefined;
        switch (fn) {
          case 'rate': value = extrapolated(pts, r.startMs, r.endMs, true, true); break;
          case 'increase': value = extrapolated(pts, r.startMs, r.endMs, true, false); break;
          case 'delta': value = extrapolated(pts, r.startMs, r.endMs, false, false); break;
          case 'irate': {
            if (pts.length < 2) break;
            const a = pts[pts.length - 2] as Point;
            const b = pts[pts.length - 1] as Point;
            value = counterDelta(a.v, b.v) / ((b.t - a.t) / 1000);
            break;
          }
          case 'idelta': {
            if (pts.length < 2) break;
            value = (pts[pts.length - 1] as Point).v - (pts[pts.length - 2] as Point).v;
            break;
          }
          case 'sum_over_time': value = pts.reduce((a, p) => a + p.v, 0); break;
          case 'avg_over_time': value = pts.reduce((a, p) => a + p.v, 0) / pts.length; break;
          case 'min_over_time': value = Math.min(...pts.map((p) => p.v)); break;
          case 'max_over_time': value = Math.max(...pts.map((p) => p.v)); break;
          case 'count_over_time': value = pts.length; break;
          case 'last_over_time': value = (pts[pts.length - 1] as Point).v; break;
        }
        if (value !== undefined) samples.push({ labels: withoutName(s.labels), value });
      }
      return { type: 'vector', samples };
    }
    switch (fn) {
      case 'time': return { type: 'scalar', value: t / 1000 };
      case 'vector': return { type: 'vector', samples: [{ labels: {}, value: this.scalarArg(n.args[0] as Node, t, 'vector() argument') }] };
      case 'scalar': {
        const v = this.vectorArg(n.args[0] as Node, t, 'scalar() argument');
        return { type: 'scalar', value: v.length === 1 ? (v[0] as VectorSample).value : NaN };
      }
      case 'absent': {
        const v = this.eval(n.args[0] as Node, t);
        const empty = v.type === 'vector' ? v.samples.length === 0 : v.type === 'range' ? v.series.length === 0 : false;
        const a = n.args[0] as Node;
        const labels: Record<string, string> = {};
        if (a.t === 'selector') for (const m of a.matchers) if (m.op === '=') labels[m.label] = m.value;
        return { type: 'vector', samples: empty ? [{ labels, value: 1 }] : [] };
      }
      case 'histogram_quantile': {
        const q = this.scalarArg(n.args[0] as Node, t, 'the quantile');
        const groups = new Map<string, { labels: Labels; buckets: { le: number; count: number }[] }>();
        for (const s of this.vectorArg(n.args[1] as Node, t, 'histogram_quantile input')) {
          const leText = s.labels['le'];
          if (leText === undefined) continue;
          const le = leText === '+Inf' ? Infinity : Number(leText);
          if (Number.isNaN(le)) continue;
          const { le: _le, ...rest } = withoutName(s.labels) as Record<string, string>;
          const k = key(rest);
          const g = groups.get(k) ?? { labels: rest, buckets: [] };
          g.buckets.push({ le, count: s.value });
          groups.set(k, g);
        }
        return { type: 'vector', samples: [...groups.values()].map((g) => ({ labels: g.labels, value: histogramQuantile(q, g.buckets.sort((a, b) => a.le - b.le)) })) };
      }
      case 'sort': case 'sort_desc': {
        const v = [...this.vectorArg(n.args[0] as Node, t, `${fn}() argument`)].sort((a, b) => (fn === 'sort' ? a.value - b.value : b.value - a.value));
        return { type: 'vector', samples: v };
      }
      case 'label_replace': {
        const [dst, repl, src, rx] = n.strs as [string, string, string, string];
        const re = safeRegex(rx, 0);
        return {
          type: 'vector',
          samples: this.vectorArg(n.args[0] as Node, t, 'label_replace input').map((s) => {
            const m = re.exec(s.labels[src] ?? '');
            if (!m) return s;
            const value = repl.replace(/\$(\d+|\{\w+\})/g, (_x, g: string) => m[Number(g.replace(/[{}]/g, ''))] ?? '');
            const labels: Record<string, string> = { ...s.labels };
            if (value === '') delete labels[dst];
            else labels[dst] = value;
            return { labels, value: s.value };
          }),
        };
      }
    }
    // element-wise math on a vector or scalar
    const f1 = (x: number): number => {
      switch (fn) {
        case 'abs': return Math.abs(x);
        case 'ceil': return Math.ceil(x);
        case 'floor': return Math.floor(x);
        case 'sqrt': return Math.sqrt(x);
        case 'exp': return Math.exp(x);
        case 'ln': return Math.log(x);
        case 'log2': return Math.log2(x);
        case 'log10': return Math.log10(x);
        case 'round': {
          const to = n.args[1] ? this.scalarArg(n.args[1], t, 'round() step') : 1;
          return Math.floor(x / to + 0.5) * to;
        }
        case 'clamp_min': return Math.max(x, this.scalarArg(n.args[1] as Node, t, 'clamp_min bound'));
        case 'clamp_max': return Math.min(x, this.scalarArg(n.args[1] as Node, t, 'clamp_max bound'));
        case 'clamp': {
          const lo = this.scalarArg(n.args[1] as Node, t, 'clamp lower bound');
          const hi = this.scalarArg(n.args[2] as Node, t, 'clamp upper bound');
          return lo > hi ? NaN : Math.min(hi, Math.max(lo, x));
        }
      }
      throw new PromQLError(`function ${fn} is not implemented`);
    };
    const arg = this.eval(n.args[0] as Node, t);
    if (arg.type === 'scalar') return { type: 'scalar', value: f1(arg.value) };
    if (arg.type === 'vector') return { type: 'vector', samples: arg.samples.map((s) => ({ labels: withoutName(s.labels), value: f1(s.value) })) };
    throw new PromQLError(`${fn} does not take a range vector`);
  }

  private agg(n: Extract<Node, { t: 'agg' }>, t: number): V {
    const input = this.vectorArg(n.expr, t, `${n.op} argument`);
    const groups = new Map<string, { labels: Labels; items: VectorSample[] }>();
    for (const s of input) {
      let labels: Record<string, string> = {};
      const l = withoutName(s.labels);
      if (n.by) for (const k of n.by) { if (l[k] !== undefined) labels[k] = l[k] as string; }
      else if (n.without) labels = Object.fromEntries(Object.entries(l).filter(([k]) => !(n.without as string[]).includes(k)));
      const k = key(labels);
      const g = groups.get(k) ?? { labels, items: [] };
      g.items.push(s);
      groups.set(k, g);
    }
    if (n.op === 'topk' || n.op === 'bottomk') {
      const k = Math.trunc(this.scalarArg(n.param as Node, t, `${n.op} count`));
      const out: VectorSample[] = [];
      for (const g of groups.values()) {
        const sorted = [...g.items].sort((a, b) => (n.op === 'topk' ? b.value - a.value : a.value - b.value));
        out.push(...sorted.slice(0, Math.max(0, k)));
      }
      return { type: 'vector', samples: out };
    }
    const samples: VectorSample[] = [];
    for (const g of groups.values()) {
      const vals = g.items.map((x) => x.value);
      let value: number;
      switch (n.op) {
        case 'sum': value = vals.reduce((a, b) => a + b, 0); break;
        case 'avg': value = vals.reduce((a, b) => a + b, 0) / vals.length; break;
        case 'min': value = vals.reduce((a, b) => (b < a || Number.isNaN(a) ? b : a)); break;
        case 'max': value = vals.reduce((a, b) => (b > a || Number.isNaN(a) ? b : a)); break;
        case 'count': value = vals.length; break;
        default: throw new PromQLError(`aggregation ${n.op} is not implemented`);
      }
      samples.push({ labels: g.labels, value });
    }
    return { type: 'vector', samples };
  }

  private bin(n: Extract<Node, { t: 'bin' }>, t: number): V {
    const l = this.eval(n.l, t);
    const r = this.eval(n.r, t);
    if (l.type === 'range' || r.type === 'range') throw new PromQLError('a range vector cannot be used in an operator');
    const isCmp = PREC[n.op] === 3;
    const isSet = n.op === 'and' || n.op === 'or' || n.op === 'unless';
    if (isSet) {
      if (l.type !== 'vector' || r.type !== 'vector') throw new PromQLError(`"${n.op}" needs vectors on both sides`);
      const sig = (labels: Labels) => signature(labels, n.matching);
      const rightSigs = new Set(r.samples.map((s) => sig(s.labels)));
      if (n.op === 'and') return { type: 'vector', samples: l.samples.filter((s) => rightSigs.has(sig(s.labels))) };
      if (n.op === 'unless') return { type: 'vector', samples: l.samples.filter((s) => !rightSigs.has(sig(s.labels))) };
      const leftSigs = new Set(l.samples.map((s) => sig(s.labels)));
      return { type: 'vector', samples: [...l.samples, ...r.samples.filter((s) => !leftSigs.has(sig(s.labels)))] };
    }
    if (l.type === 'scalar' && r.type === 'scalar') {
      if (isCmp) {
        if (!n.bool) throw new PromQLError('comparisons between scalars must use the bool modifier');
        return { type: 'scalar', value: compare(n.op, l.value, r.value) ? 1 : 0 };
      }
      return { type: 'scalar', value: arith(n.op, l.value, r.value) };
    }
    const apply = (a: number, b: number): number | undefined => {
      if (!isCmp) return arith(n.op, a, b);
      const ok = compare(n.op, a, b);
      return n.bool ? (ok ? 1 : 0) : ok ? a : undefined;
    };
    if (l.type === 'vector' && r.type === 'scalar') {
      const samples: VectorSample[] = [];
      for (const s of l.samples) {
        const v = apply(s.value, r.value);
        if (v !== undefined) samples.push({ labels: isCmp && !n.bool ? s.labels : withoutName(s.labels), value: v });
      }
      return { type: 'vector', samples };
    }
    if (l.type === 'scalar' && r.type === 'vector') {
      const samples: VectorSample[] = [];
      for (const s of r.samples) {
        const v = isCmp && !n.bool ? (compare(n.op, l.value, s.value) ? s.value : undefined) : apply(l.value, s.value);
        if (v !== undefined) samples.push({ labels: isCmp && !n.bool ? s.labels : withoutName(s.labels), value: v });
      }
      return { type: 'vector', samples };
    }
    // vector with vector, one to one
    const lv = (l as { samples: VectorSample[] }).samples;
    const rv = (r as { samples: VectorSample[] }).samples;
    const rightBy = new Map<string, VectorSample>();
    for (const s of rv) {
      const k = signature(s.labels, n.matching);
      if (rightBy.has(k)) throw new PromQLError('many-to-many matching not allowed: matching labels must be unique on the right side');
      rightBy.set(k, s);
    }
    const seen = new Set<string>();
    const samples: VectorSample[] = [];
    for (const s of lv) {
      const k = signature(s.labels, n.matching);
      if (seen.has(k)) throw new PromQLError('many-to-many matching not allowed: matching labels must be unique on the left side');
      seen.add(k);
      const o = rightBy.get(k);
      if (!o) continue;
      const v = apply(s.value, o.value);
      if (v === undefined) continue;
      let labels: Labels = isCmp && !n.bool ? s.labels : withoutName(s.labels);
      if (n.matching?.on) labels = Object.fromEntries(Object.entries(labels).filter(([x]) => n.matching!.labels.includes(x)));
      else if (n.matching && !n.matching.on) labels = Object.fromEntries(Object.entries(labels).filter(([x]) => !n.matching!.labels.includes(x)));
      samples.push({ labels, value: v });
    }
    return { type: 'vector', samples };
  }
}

function signature(labels: Labels, m: Matching | undefined): string {
  const l = withoutName(labels);
  let use: Record<string, string>;
  if (!m) use = { ...l };
  else if (m.on) use = Object.fromEntries(Object.entries(l).filter(([k]) => m.labels.includes(k)));
  else use = Object.fromEntries(Object.entries(l).filter(([k]) => !m.labels.includes(k)));
  return key(use);
}

export interface QueryOptions { readonly limits?: Partial<Limits> }

/** Evaluate at one instant (milliseconds). The top level may not be a range vector. */
export function instantQuery(store: SeriesStore, src: string, atMs: number, options: QueryOptions = {}): Result {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const ast = parse(src, limits);
  const v = new Evaluator(store, limits).eval(ast, atMs);
  if (v.type === 'range') throw new PromQLError('a range vector cannot be the result of an instant query; wrap it in a function such as rate()');
  return v;
}

/** Snap a start to a multiple of the step, as dashboards do so that panels line up from one refresh to the next. */
export function alignRange(startMs: number, endMs: number, stepMs: number): { startMs: number; endMs: number } {
  if (!(stepMs > 0)) throw new PromQLError('step must be above zero');
  return { startMs: Math.floor(startMs / stepMs) * stepMs, endMs: Math.ceil(endMs / stepMs) * stepMs };
}

/** Evaluate at start, start + step, ... up to end. Series are keyed by their labels; a scalar becomes one series. */
export function rangeQuery(store: SeriesStore, src: string, startMs: number, endMs: number, stepMs: number, options: QueryOptions = {}): MatrixSeries[] {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  if (!(stepMs > 0)) throw new PromQLError('step must be above zero');
  if (endMs < startMs) throw new PromQLError('end is before start');
  const steps = Math.floor((endMs - startMs) / stepMs) + 1;
  if (steps > limits.maxSteps) throw new PromQLError(`${steps} steps is more than the limit of ${limits.maxSteps}; use a larger step`);
  const ast = parse(src, limits);
  const ev = new Evaluator(store, limits);
  const out = new Map<string, MatrixSeries>();
  for (let t = startMs; t <= endMs; t += stepMs) {
    const v = ev.eval(ast, t);
    if (v.type === 'range') throw new PromQLError('a range vector cannot be the result of a range query; wrap it in a function such as rate()');
    const samples: VectorSample[] = v.type === 'scalar' ? [{ labels: {}, value: v.value }] : v.samples;
    for (const s of samples) {
      const k = key(s.labels);
      const m = out.get(k) ?? { labels: s.labels, points: [] };
      m.points.push({ t, v: s.value });
      out.set(k, m);
    }
  }
  return [...out.values()].sort((a, b) => key(a.labels).localeCompare(key(b.labels)));
}
