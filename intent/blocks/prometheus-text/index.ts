/**
 * Metrics in the Prometheus text exposition format (version 0.0.4) and OpenMetrics 1.0 text, both ways. Writing: a
 * registry of counters, gauges and histograms whose names and labels are checked against the format's grammar
 * (reserved names and "le" refused), whose series are capped per metric so a label fed from user input cannot eat
 * memory (a new series beyond the cap is refused, or folded into one "__overflow__" series, and counted), and whose
 * exposition escapes help text and label values, spells NaN and infinities the way scrapers expect, and in
 * OpenMetrics form names counter families without "_total" and ends with "# EOF". Reading: a strict parser for what a
 * scrape returns, with line numbers on every error, TYPE and HELP lines, escapes, timestamps (OpenMetrics seconds
 * become milliseconds), duplicate-series and late-TYPE detection, histogram consistency checks, hard limits on
 * body size, line length, samples, labels and label value length, and a per-family series cap that drops or fails.
 * Quantiles from histogram buckets use the same linear interpolation as PromQL's histogram_quantile.
 * Out of scope: exemplars (read and ignored), native histograms, UTF-8 quoted metric and label names (Prometheus 3),
 * summaries on the writing side, the protobuf exposition format, and serving or compressing the response.
 */

export class MetricsError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class CardinalityError extends MetricsError {}

export class ParseError extends MetricsError {
  readonly line: number;
  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}

export type Format = 'prometheus' | 'openmetrics';
export type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary' | 'untyped' | 'unknown' | 'info' | 'stateset' | 'gaugehistogram';

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_LABEL_VALUE = 1024;

// ---------------------------------------------------------------------------------------------------------------
// Writing

export type Labels = Readonly<Record<string, string>>;

export interface RegistryOptions {
  /** The most series any one metric may hold. Default 1000. */
  readonly maxSeriesPerMetric?: number;
  /** What a new series beyond the cap does: throw a CardinalityError, or be added to one "__overflow__" series. Default "reject". */
  readonly onOverflow?: 'reject' | 'fold';
}

/** A value as written: integers without a point, NaN, +Inf and -Inf by name. */
export function formatValue(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  return String(v);
}

const escapeHelp = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
const escapeLabel = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

interface Series {
  values: string[];
  value: number;
  buckets?: number[];
  sum?: number;
  count?: number;
}

abstract class Metric {
  readonly series = new Map<string, Series>();
  overflowed = 0;
  readonly family: string;
  readonly help: string;
  readonly labelNames: readonly string[];
  private readonly reg: RegistryOptions;
  constructor(family: string, help: string, labelNames: readonly string[], reg: RegistryOptions) {
    this.family = family;
    this.help = help;
    this.labelNames = labelNames;
    this.reg = reg;
  }

  protected get(labels: Labels | undefined): Series {
    const given = Object.keys(labels ?? {});
    if (given.length !== this.labelNames.length || !this.labelNames.every((n) => given.includes(n))) throw new MetricsError(`${this.family} takes exactly the labels ${this.labelNames.join(', ') || '(none)'}; got ${given.join(', ') || '(none)'}`);
    let values = this.labelNames.map((n) => labels![n]!);
    for (const v of values) {
      if (typeof v !== 'string') throw new MetricsError(`label values of ${this.family} must be strings`);
      if (v.length > MAX_LABEL_VALUE) throw new MetricsError(`a label value of ${this.family} may be at most ${MAX_LABEL_VALUE} characters`);
    }
    let key = values.join('\u0000');
    let s = this.series.get(key);
    if (s) return s;
    if (this.series.size >= (this.reg.maxSeriesPerMetric ?? 1000)) {
      if ((this.reg.onOverflow ?? 'reject') === 'reject') {
        this.overflowed++;
        throw new CardinalityError(`${this.family} already has ${this.series.size} series; refusing another (a label is probably fed from unbounded input)`);
      }
      this.overflowed++;
      values = this.labelNames.map(() => '__overflow__');
      key = values.join('\u0000');
      s = this.series.get(key);
      if (s) return s;
    }
    s = this.fresh(values);
    this.series.set(key, s);
    return s;
  }

  protected abstract fresh(values: string[]): Series;
}

export class Counter extends Metric {
  protected fresh(values: string[]): Series {
    return { values, value: 0 };
  }
  inc(labels?: Labels, by = 1): void {
    if (!(by >= 0) || !Number.isFinite(by)) throw new MetricsError('a counter only goes up by a finite amount');
    this.get(labels).value += by;
  }
  value(labels?: Labels): number {
    return this.get(labels).value;
  }
}

export class Gauge extends Metric {
  protected fresh(values: string[]): Series {
    return { values, value: 0 };
  }
  set(value: number, labels?: Labels): void {
    this.get(labels).value = value;
  }
  inc(labels?: Labels, by = 1): void {
    this.get(labels).value += by;
  }
  dec(labels?: Labels, by = 1): void {
    this.get(labels).value -= by;
  }
  value(labels?: Labels): number {
    return this.get(labels).value;
  }
}

export class Histogram extends Metric {
  readonly bounds: readonly number[];
  constructor(family: string, help: string, labelNames: readonly string[], reg: RegistryOptions, bounds: readonly number[]) {
    super(family, help, labelNames, reg);
    this.bounds = bounds;
  }
  protected fresh(values: string[]): Series {
    return { values, value: 0, buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
  }
  observe(value: number, labels?: Labels): void {
    if (Number.isNaN(value)) throw new MetricsError('a histogram cannot observe NaN');
    const s = this.get(labels);
    for (let i = 0; i < this.bounds.length; i++) if (value <= this.bounds[i]!) s.buckets![i]!++;
    s.sum! += value;
    s.count!++;
  }
}

export const DEFAULT_BUCKETS: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Registry {
  private readonly metrics = new Map<string, { kind: 'counter' | 'gauge' | 'histogram'; m: Metric }>();
  private readonly taken = new Set<string>();
  private readonly o: RegistryOptions;

  constructor(o: RegistryOptions = {}) {
    this.o = o;
  }

  private add<T extends Metric>(kind: 'counter' | 'gauge' | 'histogram', name: string, help: string, labelNames: readonly string[], make: (family: string) => T, derived: (family: string) => string[]): T {
    if (!METRIC_NAME.test(name)) throw new MetricsError(`"${name}" is not a valid metric name`);
    const family = kind === 'counter' ? name.replace(/_total$/, '') : name;
    if (!family) throw new MetricsError('a counter needs a name besides "_total"');
    for (const l of labelNames) {
      if (!LABEL_NAME.test(l) || l.startsWith('__')) throw new MetricsError(`"${l}" is not a usable label name`);
      if (kind === 'histogram' && l === 'le') throw new MetricsError('"le" is reserved for histogram buckets');
    }
    if (new Set(labelNames).size !== labelNames.length) throw new MetricsError('label names must be distinct');
    const names = derived(family);
    for (const n of names) if (this.taken.has(n)) throw new MetricsError(`"${n}" collides with a metric already registered`);
    const m = make(family);
    for (const n of names) this.taken.add(n);
    this.metrics.set(family, { kind, m });
    return m;
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.add('counter', name, help, labelNames, (f) => new Counter(f, help, labelNames, this.o), (f) => [f, `${f}_total`, `${f}_created`]);
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.add('gauge', name, help, labelNames, (f) => new Gauge(f, help, labelNames, this.o), (f) => [f]);
  }

  histogram(name: string, help: string, labelNames: readonly string[] = [], buckets: readonly number[] = DEFAULT_BUCKETS): Histogram {
    if (!buckets.length || buckets.length > 200) throw new MetricsError('a histogram needs between 1 and 200 buckets');
    for (let i = 0; i < buckets.length; i++) {
      if (!Number.isFinite(buckets[i]!)) throw new MetricsError('bucket bounds must be finite; +Inf is added for you');
      if (i > 0 && buckets[i]! <= buckets[i - 1]!) throw new MetricsError('bucket bounds must be strictly increasing');
    }
    return this.add('histogram', name, help, labelNames, (f) => new Histogram(f, help, labelNames, this.o, [...buckets]), (f) => [f, `${f}_bucket`, `${f}_sum`, `${f}_count`]);
  }

  /** How many times each metric's series cap was hit. */
  overflow(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [f, { m }] of this.metrics) if (m.overflowed) out[f] = m.overflowed;
    return out;
  }

  /** The exposition text for a scrape. Metrics are sorted by name and series by label values, so output is stable. */
  expose(format: Format = 'prometheus'): string {
    const om = format === 'openmetrics';
    const lines: string[] = [];
    for (const [family, { kind, m }] of [...this.metrics].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const head = kind === 'counter' && !om ? `${family}_total` : family;
      if (m.help) lines.push(`# HELP ${head} ${escapeHelp(m.help)}`);
      lines.push(`# TYPE ${head} ${kind}`);
      const series = [...m.series.values()].sort((a, b) => (a.values.join('\u0000') < b.values.join('\u0000') ? -1 : 1));
      const lbl = (s: Series, extra?: [string, string]) => {
        const parts = m.labelNames.map((n, i) => `${n}="${escapeLabel(s.values[i]!)}"`);
        if (extra) parts.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
        return parts.length ? `{${parts.join(',')}}` : '';
      };
      for (const s of series) {
        if (kind === 'histogram') {
          const h = m as Histogram;
          h.bounds.forEach((b, i) => lines.push(`${family}_bucket${lbl(s, ['le', formatValue(b)])} ${s.buckets![i]}`));
          lines.push(`${family}_bucket${lbl(s, ['le', '+Inf'])} ${s.count}`);
          lines.push(`${family}_sum${lbl(s)} ${formatValue(s.sum!)}`);
          lines.push(`${family}_count${lbl(s)} ${s.count}`);
        } else lines.push(`${kind === 'counter' ? `${family}_total` : family}${lbl(s)} ${formatValue(s.value)}`);
      }
    }
    if (om) lines.push('# EOF');
    return `${lines.join('\n')}${lines.length ? '\n' : ''}`;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Reading

export interface ParsedSample {
  /** The full sample name, for example "http_request_duration_seconds_bucket". */
  readonly name: string;
  readonly labels: Labels;
  readonly value: number;
  /** Milliseconds since the epoch, when the sample carries a timestamp. */
  readonly timestampMs?: number;
}

export interface Family {
  readonly name: string;
  type: MetricType;
  help?: string;
  unit?: string;
  readonly samples: ParsedSample[];
}

export interface ParseLimits {
  readonly maxBytes?: number;
  readonly maxLineLength?: number;
  readonly maxSamples?: number;
  readonly maxLabelsPerSample?: number;
  readonly maxSeriesPerFamily?: number;
  /** What happens to series beyond maxSeriesPerFamily: "fail" throws, "drop" skips them and counts. Default "fail". */
  readonly onSeriesLimit?: 'fail' | 'drop';
  /** Force a format instead of detecting OpenMetrics by a "# EOF" line. */
  readonly format?: Format;
}

export interface ParseResult {
  readonly format: Format;
  readonly families: Family[];
  readonly samples: number;
  /** Series dropped for exceeding the per-family cap, by family. */
  readonly dropped: Readonly<Record<string, number>>;
}

const TYPES = new Set(['counter', 'gauge', 'histogram', 'summary', 'untyped', 'unknown', 'info', 'stateset', 'gaugehistogram']);
const VALUE = /^[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|Inf|NaN|Infinity)$/i;

function parseValue(text: string, line: number): number {
  if (!VALUE.test(text)) throw new ParseError(line, `"${text}" is not a number`);
  const t = text.toLowerCase();
  if (t.endsWith('nan')) return Number.NaN;
  if (t.endsWith('inf') || t.endsWith('infinity')) return t.startsWith('-') ? -Infinity : Infinity;
  return Number(text);
}

/** Splits a sample line into name, labels and the rest, reading escapes in label values. */
function parseSampleLine(s: string, line: number, maxLabels: number): { name: string; labels: Record<string, string>; rest: string } {
  const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)/.exec(s);
  if (!m) throw new ParseError(line, 'a sample must start with a metric name');
  const name = m[1]!;
  let i = name.length;
  const labels: Record<string, string> = {};
  if (s[i] === '{') {
    i++;
    let count = 0;
    for (;;) {
      while (s[i] === ' ' || s[i] === '\t') i++;
      if (s[i] === '}') {
        i++;
        break;
      }
      const ln = /^([a-zA-Z_][a-zA-Z0-9_]*)/.exec(s.slice(i));
      if (!ln) throw new ParseError(line, 'expected a label name');
      i += ln[1]!.length;
      while (s[i] === ' ') i++;
      if (s[i] !== '=') throw new ParseError(line, `expected "=" after label ${ln[1]}`);
      i++;
      while (s[i] === ' ') i++;
      if (s[i] !== '"') throw new ParseError(line, `the value of label ${ln[1]} must be in double quotes`);
      i++;
      let v = '';
      for (;;) {
        if (i >= s.length) throw new ParseError(line, 'a label value is not closed');
        const c = s[i]!;
        if (c === '"') {
          i++;
          break;
        }
        if (c === '\\') {
          const n = s[i + 1];
          if (n === 'n') v += '\n';
          else if (n === '\\' || n === '"') v += n;
          else throw new ParseError(line, `"\\${n ?? ''}" is not a valid escape in a label value`);
          i += 2;
        } else {
          v += c;
          i++;
        }
      }
      if (ln[1]! in labels) throw new ParseError(line, `label ${ln[1]} appears twice`);
      if (++count > maxLabels) throw new ParseError(line, `more than ${maxLabels} labels`);
      labels[ln[1]!] = v;
      while (s[i] === ' ') i++;
      if (s[i] === ',') {
        i++;
        continue;
      }
      if (s[i] === '}') {
        i++;
        break;
      }
      throw new ParseError(line, 'expected "," or "}" after a label value');
    }
  }
  return { name, labels, rest: s.slice(i) };
}

/** The family a sample belongs to, given the families seen so far. */
function familyFor(fams: Map<string, Family>, sample: string): Family | undefined {
  const direct = fams.get(sample);
  if (direct) return direct;
  for (const [suffix, types] of [['_bucket', ['histogram', 'gaugehistogram']], ['_sum', ['histogram', 'summary', 'gaugehistogram']], ['_count', ['histogram', 'summary', 'gaugehistogram']], ['_gcount', ['gaugehistogram']], ['_gsum', ['gaugehistogram']], ['_total', ['counter']], ['_created', ['counter', 'histogram', 'summary']], ['_info', ['info']]] as const)
    if (sample.endsWith(suffix)) {
      const f = fams.get(sample.slice(0, -suffix.length));
      if (f && (types as readonly string[]).includes(f.type)) return f;
    }
  return undefined;
}

const seriesKey = (name: string, labels: Labels) => `${name}\u0001${JSON.stringify(Object.keys(labels).sort().map((k) => [k, labels[k]]))}`;

/** Parses an exposition body with strict checks and hard limits. */
export function parseExposition(text: string, limits: ParseLimits = {}): ParseResult {
  const maxBytes = limits.maxBytes ?? 10 * 1024 * 1024;
  const maxLine = limits.maxLineLength ?? 64 * 1024;
  const maxSamples = limits.maxSamples ?? 100_000;
  const maxLabels = limits.maxLabelsPerSample ?? 30;
  if (Buffer.byteLength(text) > maxBytes) throw new ParseError(0, `the body is larger than ${maxBytes} bytes`);
  const format: Format = limits.format ?? (/(^|\n)# EOF\s*(\n|$)/.test(text) ? 'openmetrics' : 'prometheus');
  const om = format === 'openmetrics';
  const fams = new Map<string, Family>();
  const seen = new Set<string>();
  const perFamily = new Map<string, Set<string>>();
  const dropped: Record<string, number> = {};
  const started = new Set<string>();
  const typed = new Set<string>();
  let samples = 0;
  let eof = false;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  lines.forEach((raw, idx) => {
    const n = idx + 1;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length > maxLine) throw new ParseError(n, `the line is longer than ${maxLine} characters`);
    if (eof) {
      if (line.trim() === '') return;
      throw new ParseError(n, 'content after "# EOF"');
    }
    const t = line.trim();
    if (t === '') {
      if (om) throw new ParseError(n, 'OpenMetrics does not allow blank lines');
      return;
    }
    if (t.startsWith('#')) {
      const m = /^#\s*(HELP|TYPE|UNIT|EOF)\b\s*(.*)$/.exec(t);
      if (!m) return;
      if (m[1] === 'EOF') {
        if (!om) throw new ParseError(n, '"# EOF" in a body not detected as OpenMetrics');
        eof = true;
        return;
      }
      const kind = m[1]!;
      const arg = m[2]!;
      const sp = arg.search(/\s/);
      const name = sp < 0 ? arg : arg.slice(0, sp);
      const rest = sp < 0 ? '' : arg.slice(sp).replace(/^\s/, '');
      if (!METRIC_NAME.test(name)) throw new ParseError(n, `"${name}" is not a valid metric name`);
      let f = fams.get(name);
      if (!f) fams.set(name, (f = { name, type: 'untyped', samples: [] }));
      if (kind === 'TYPE') {
        const ty = rest.trim().toLowerCase();
        if (!TYPES.has(ty)) throw new ParseError(n, `"${rest.trim()}" is not a metric type`);
        if (started.has(name) || typed.has(name)) throw new ParseError(n, `the TYPE of ${name} comes after its samples or twice`);
        f.type = ty as MetricType;
        typed.add(name);
      } else if (kind === 'HELP') f.help = rest.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
      else f.unit = rest.trim();
      return;
    }
    if (++samples > maxSamples) throw new ParseError(n, `more than ${maxSamples} samples`);
    const { name, labels, rest } = parseSampleLine(t, n, maxLabels);
    const parts = rest.trim().split(/\s+/).filter(Boolean);
    const hash = parts.indexOf('#');
    const fields = hash >= 0 ? parts.slice(0, hash) : parts;
    if (hash >= 0 && !om) throw new ParseError(n, 'an exemplar is only allowed in OpenMetrics');
    if (fields.length < 1 || fields.length > 2) throw new ParseError(n, 'a sample is a name, labels, a value, and optionally a timestamp');
    const value = parseValue(fields[0]!, n);
    let timestampMs: number | undefined;
    if (fields[1] !== undefined) {
      if (!/^-?\d+(\.\d+)?$/.test(fields[1])) throw new ParseError(n, `"${fields[1]}" is not a timestamp`);
      timestampMs = om ? Math.round(Number(fields[1]) * 1000) : Number(fields[1]);
    }
    let f = familyFor(fams, name);
    if (!f) fams.set(name, (f = { name, type: 'untyped', samples: [] }));
    started.add(f.name);
    for (const [k, v] of Object.entries(labels)) if (v.length > MAX_LABEL_VALUE * 4) throw new ParseError(n, `the value of label ${k} is too long`);
    const key = seriesKey(name, labels);
    if (seen.has(key)) throw new ParseError(n, `the series ${name}${JSON.stringify(labels)} appears twice`);
    // Series, not samples: all the buckets of one label set are one series for the cap.
    const own = JSON.stringify(Object.keys(labels).filter((k) => k !== 'le' && k !== 'quantile').sort().map((k) => [k, labels[k]]));
    let set = perFamily.get(f.name);
    if (!set) perFamily.set(f.name, (set = new Set()));
    const cap = limits.maxSeriesPerFamily;
    if (!set.has(own) && cap !== undefined && set.size >= cap) {
      if ((limits.onSeriesLimit ?? 'fail') === 'fail') throw new ParseError(n, `${f.name} has more than ${cap} series`);
      dropped[f.name] = (dropped[f.name] ?? 0) + 1;
      return;
    }
    set.add(own);
    seen.add(key);
    f.samples.push({ name, labels, value, ...(timestampMs !== undefined ? { timestampMs } : {}) });
  });
  if (om && !eof) throw new ParseError(lines.length, 'an OpenMetrics body must end with "# EOF"');
  return { format, families: [...fams.values()], samples, dropped };
}

/** Finds the sample of a family by full name and exact labels. */
export function findSample(f: Family, name: string, labels: Labels = {}): ParsedSample | undefined {
  const want = JSON.stringify(Object.keys(labels).sort().map((k) => [k, labels[k]]));
  return f.samples.find((s) => s.name === name && JSON.stringify(Object.keys(s.labels).sort().map((k) => [k, s.labels[k]])) === want);
}

export interface Bucket {
  readonly le: number;
  readonly count: number;
}

/** The cumulative buckets of one histogram series (labels other than "le"), in order. */
export function histogramBuckets(f: Family, labels: Labels = {}): Bucket[] {
  const want = JSON.stringify(Object.keys(labels).sort().map((k) => [k, labels[k]]));
  return f.samples
    .filter((s) => s.name === `${f.name}_bucket` && JSON.stringify(Object.keys(s.labels).filter((k) => k !== 'le').sort().map((k) => [k, s.labels[k]])) === want)
    .map((s) => ({ le: s.labels['le'] === '+Inf' ? Infinity : Number(s.labels['le']), count: s.value }))
    .sort((a, b) => a.le - b.le);
}

/** Problems with a histogram family: buckets that fall, a missing +Inf bucket, a count that is not the +Inf bucket. Empty when sound. */
export function checkHistogram(f: Family): string[] {
  const problems: string[] = [];
  const groups = new Map<string, Labels>();
  for (const s of f.samples) {
    if (s.name !== `${f.name}_bucket`) continue;
    const rest = Object.fromEntries(Object.entries(s.labels).filter(([k]) => k !== 'le'));
    groups.set(JSON.stringify(Object.keys(rest).sort().map((k) => [k, rest[k]])), rest);
    if (s.labels['le'] === undefined) problems.push(`a ${f.name}_bucket sample has no le label`);
  }
  for (const [g, labels] of groups) {
    const b = histogramBuckets(f, labels);
    if (b.some((x) => Number.isNaN(x.le))) {
      problems.push(`${g}: a bucket bound is not a number`);
      continue;
    }
    if (!b.length || b[b.length - 1]!.le !== Infinity) problems.push(`${g}: no le="+Inf" bucket`);
    for (let i = 1; i < b.length; i++) if (b[i]!.count < b[i - 1]!.count) problems.push(`${g}: bucket le=${b[i]!.le} has a smaller count than le=${b[i - 1]!.le}`);
    const c = findSample(f, `${f.name}_count`, labels);
    if (c && b.length && b[b.length - 1]!.le === Infinity && c.value !== b[b.length - 1]!.count) problems.push(`${g}: _count differs from the +Inf bucket`);
  }
  return problems;
}

/** The q-quantile (0 to 1) from cumulative buckets by linear interpolation inside the bucket, as PromQL's histogram_quantile does. NaN when there are no observations. */
export function histogramQuantile(q: number, buckets: readonly Bucket[]): number {
  if (!(q >= 0 && q <= 1)) return q < 0 ? -Infinity : q > 1 ? Infinity : Number.NaN;
  if (buckets.length < 2 || buckets[buckets.length - 1]!.le !== Infinity) return Number.NaN;
  const total = buckets[buckets.length - 1]!.count;
  if (total === 0) return Number.NaN;
  const rank = q * total;
  let i = buckets.findIndex((b) => b.count >= rank);
  if (i < 0) i = buckets.length - 1;
  if (i === buckets.length - 1) return buckets[buckets.length - 2]!.le;
  if (i === 0 && buckets[0]!.le <= 0) return buckets[0]!.le;
  const lower = i === 0 ? 0 : buckets[i - 1]!.le;
  const below = i === 0 ? 0 : buckets[i - 1]!.count;
  const inBucket = buckets[i]!.count - below;
  return inBucket === 0 ? lower : lower + (buckets[i]!.le - lower) * ((rank - below) / inBucket);
}
