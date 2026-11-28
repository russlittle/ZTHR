/**
 * Event data in columns, aggregated with bounded memory. A column store keeps each field as a typed array in
 * fixed-size chunks (numbers and times as Float64Array, booleans as bytes, strings as dictionary codes), so scans
 * touch only the columns a query names; it holds at most `maxRows` rows (the oldest chunks are dropped and counted),
 * and at most `maxDistinct` values per string column (further new values are recorded as "__other__" and counted),
 * so a hostile or buggy field cannot grow it without limit. Queries filter (equals, in, ranges, prefix), group by
 * columns and/or a UTC time bucket (minute, hour, day, week, month), and compute count, sum, average, min, max and
 * approximate distinct count (a HyperLogLog with 1024 registers, about 3% error), with a cap on groups (the rest fold
 * into one "__other__" group) and ordering with a limit. Every aggregate is kept as a mergeable partial state, which
 * is what makes rollups work: a Rollup table keeps pre-aggregated buckets by time and chosen dimensions as events
 * arrive, in event time. Late data: a row for a bucket that has already been reported is still accepted while the
 * watermark (the latest event time seen) is within the allowed lateness of that bucket's end, and the bucket is
 * reported again as a correction with a higher revision; after that the bucket is closed and later rows are refused
 * and counted (and handed to a callback). Buckets older than the retention are dropped. A rollup can be queried at a
 * coarser grain (hours into days) or over fewer dimensions by merging partial states, never by re-reading events.
 * Out of scope: persistence, joins, percentiles (not exactly mergeable without a sketch), time zones other than UTC,
 * and multi-threaded scans.
 */

export class ColumnarError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export type ColumnType = 'time' | 'int' | 'float' | 'string' | 'bool';
export interface ColumnDef {
  readonly name: string;
  readonly type: ColumnType;
}
export type Value = number | string | boolean | null | undefined;
export type InputRow = Readonly<Record<string, Value>>;
export type OutputRow = Record<string, number | string | boolean | null>;

export const OTHER = '__other__';

// ---------------------------------------------------------------------------------------------------------------
// Time buckets

export type Every = 'minute' | 'hour' | 'day' | 'week' | 'month';
const MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };

/** Start of the UTC bucket containing the instant: weeks start on Monday, months on the 1st. */
export function bucketStart(ms: number, every: Every): number {
  if (every === 'minute' || every === 'hour' || every === 'day') return Math.floor(ms / MS[every]) * MS[every];
  if (every === 'week') {
    const day = Math.floor(ms / MS.day);
    return (day - ((day + 3) % 7)) * MS.day; // 1970-01-01 was a Thursday
  }
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Start of the next bucket. */
export function bucketEnd(start: number, every: Every): number {
  if (every === 'month') {
    const d = new Date(start);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return start + (every === 'week' ? 7 * MS.day : MS[every]);
}

const GRAIN: Record<Every, number> = { minute: 0, hour: 1, day: 2, week: 3, month: 4 };

// ---------------------------------------------------------------------------------------------------------------
// Distinct counting: HyperLogLog

function murmur3(s: string): number {
  const bytes = new TextEncoder().encode(s);
  let h = 0x9747b28c;
  const n = bytes.length & ~3;
  for (let i = 0; i < n; i += 4) {
    let k = bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24);
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  let k = 0;
  switch (bytes.length & 3) {
    case 3: k ^= bytes[n + 2]! << 16; // falls through
    case 2: k ^= bytes[n + 1]! << 8; // falls through
    case 1:
      k ^= bytes[n]!;
      k = Math.imul(k, 0xcc9e2d51);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, 0x1b873593);
      h ^= k;
  }
  h ^= bytes.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const HLL_BITS = 10;
const HLL_M = 1 << HLL_BITS;

export class Hll {
  readonly reg = new Uint8Array(HLL_M);
  add(value: string): void {
    const h = murmur3(value);
    const idx = h >>> (32 - HLL_BITS);
    const w = (h << HLL_BITS) >>> 0;
    const rank = w === 0 ? 33 - HLL_BITS : Math.clz32(w) + 1;
    if (rank > this.reg[idx]!) this.reg[idx] = rank;
  }
  merge(o: Hll): void {
    for (let i = 0; i < HLL_M; i++) if (o.reg[i]! > this.reg[i]!) this.reg[i] = o.reg[i]!;
  }
  estimate(): number {
    let sum = 0;
    let zeros = 0;
    for (const r of this.reg) {
      sum += 2 ** -r;
      if (r === 0) zeros++;
    }
    const est = (0.7213 / (1 + 1.079 / HLL_M)) * HLL_M * HLL_M / sum;
    return Math.round(est <= 2.5 * HLL_M && zeros > 0 ? HLL_M * Math.log(HLL_M / zeros) : est);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Aggregates

export interface Agg {
  readonly op: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'distinct';
  /** Required for everything but count; count with a column counts its non-null values. */
  readonly col?: string;
  readonly as?: string;
}

const aggName = (a: Agg) => a.as ?? (a.col ? `${a.op}_${a.col}` : a.op);

type State = { n: number; sum: number; min: number; max: number; hll?: Hll };

function fresh(a: Agg): State {
  return { n: 0, sum: 0, min: Infinity, max: -Infinity, ...(a.op === 'distinct' ? { hll: new Hll() } : {}) };
}

function mergeState(into: State, from: State): void {
  into.n += from.n;
  into.sum += from.sum;
  if (from.min < into.min) into.min = from.min;
  if (from.max > into.max) into.max = from.max;
  if (from.hll && into.hll) into.hll.merge(from.hll);
}

function finish(a: Agg, s: State): number | null {
  switch (a.op) {
    case 'count':
      return s.n;
    case 'sum':
      return s.sum;
    case 'avg':
      return s.n ? s.sum / s.n : null;
    case 'min':
      return s.n ? s.min : null;
    case 'max':
      return s.n ? s.max : null;
    case 'distinct':
      return s.hll!.estimate();
  }
}

function checkAggs(aggs: readonly Agg[]): void {
  if (!aggs.length) throw new ColumnarError('a query needs at least one aggregate');
  const names = new Set<string>();
  for (const a of aggs) {
    if (a.op !== 'count' && !a.col) throw new ColumnarError(`${a.op} needs a column`);
    const n = aggName(a);
    if (names.has(n)) throw new ColumnarError(`two aggregates are called "${n}"; name one with "as"`);
    names.add(n);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The column store

export type Filter =
  | { readonly col: string; readonly op: 'eq' | 'ne'; readonly value: number | string | boolean }
  | { readonly col: string; readonly op: 'in'; readonly values: readonly (number | string)[] }
  | { readonly col: string; readonly op: 'gt' | 'gte' | 'lt' | 'lte'; readonly value: number }
  | { readonly col: string; readonly op: 'between'; readonly from: number; readonly to: number }
  | { readonly col: string; readonly op: 'prefix'; readonly value: string };

export interface Query {
  readonly by?: readonly string[];
  /** Group by a UTC time bucket of a time column; the bucket start is returned as `bucket`. */
  readonly time?: { readonly col: string; readonly every: Every };
  readonly aggs: readonly Agg[];
  readonly where?: readonly Filter[];
  readonly orderBy?: { readonly key: string; readonly desc?: boolean };
  readonly limit?: number;
  /** Groups beyond this many fold into one "__other__" group. Default 10 000. */
  readonly maxGroups?: number;
}

interface Chunk {
  n: number;
  num: Map<string, Float64Array>;
  str: Map<string, Uint32Array>;
  bool: Map<string, Uint8Array>;
}

export interface StoreOptions {
  readonly maxRows?: number;
  readonly chunkRows?: number;
  readonly maxDistinct?: number;
}

export interface AppendResult {
  readonly accepted: number;
  readonly rejected: readonly { readonly index: number; readonly reason: string }[];
}

export class ColumnStore {
  readonly schema: readonly ColumnDef[];
  private readonly byName = new Map<string, ColumnDef>();
  private readonly chunks: Chunk[] = [];
  private readonly dict = new Map<string, { values: string[]; index: Map<string, number> }>();
  private readonly maxRows: number;
  private readonly chunkRows: number;
  private readonly maxDistinct: number;
  /** Rows dropped by retention, and string values folded into "__other__". */
  evicted = 0;
  overflowed = 0;

  constructor(schema: readonly ColumnDef[], o: StoreOptions = {}) {
    if (!schema.length) throw new ColumnarError('a store needs at least one column');
    for (const c of schema) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name)) throw new ColumnarError(`"${c.name}" is not a usable column name`);
      if (this.byName.has(c.name)) throw new ColumnarError(`column "${c.name}" is declared twice`);
      this.byName.set(c.name, c);
      if (c.type === 'string') this.dict.set(c.name, { values: [OTHER], index: new Map([[OTHER, 0]]) });
    }
    this.schema = schema;
    this.maxRows = o.maxRows ?? 1_000_000;
    this.chunkRows = o.chunkRows ?? 4096;
    this.maxDistinct = o.maxDistinct ?? 10_000;
    if (this.maxRows < this.chunkRows) this.chunkRows = Math.max(1, this.maxRows);
  }

  get length(): number {
    return this.chunks.reduce((a, c) => a + c.n, 0);
  }

  /** Bytes held in column arrays and dictionaries, approximately. */
  bytes(): number {
    let b = 0;
    for (const c of this.chunks) {
      for (const a of c.num.values()) b += a.byteLength;
      for (const a of c.str.values()) b += a.byteLength;
      for (const a of c.bool.values()) b += a.byteLength;
    }
    for (const d of this.dict.values()) for (const v of d.values) b += v.length * 2 + 16;
    return b;
  }

  private newChunk(): Chunk {
    const c: Chunk = { n: 0, num: new Map(), str: new Map(), bool: new Map() };
    for (const d of this.schema) {
      if (d.type === 'string') c.str.set(d.name, new Uint32Array(this.chunkRows));
      else if (d.type === 'bool') c.bool.set(d.name, new Uint8Array(this.chunkRows).fill(2));
      else c.num.set(d.name, new Float64Array(this.chunkRows).fill(Number.NaN));
    }
    return c;
  }

  private code(col: string, v: string): number {
    const d = this.dict.get(col)!;
    const hit = d.index.get(v);
    if (hit !== undefined) return hit;
    if (d.values.length > this.maxDistinct) {
      this.overflowed++;
      return 0;
    }
    d.values.push(v);
    d.index.set(v, d.values.length - 1);
    return d.values.length - 1;
  }

  /** Appends rows; a row with a bad value is rejected with its position and reason, and the rest are kept. */
  append(rows: readonly InputRow[]): AppendResult {
    const rejected: { index: number; reason: string }[] = [];
    let accepted = 0;
    rows.forEach((row, index) => {
      const vals: [ColumnDef, number | string | boolean | null][] = [];
      for (const d of this.schema) {
        const v = row[d.name];
        if (v === undefined || v === null) {
          vals.push([d, null]);
          continue;
        }
        const bad = (why: string) => rejected.push({ index, reason: `${d.name}: ${why}` });
        if (d.type === 'string') {
          if (typeof v !== 'string') return bad('expected a string');
          if (v.length > 1024) return bad('a string value may be at most 1024 characters');
        } else if (d.type === 'bool') {
          if (typeof v !== 'boolean') return bad('expected true or false');
        } else if (typeof v !== 'number' || !Number.isFinite(v)) return bad('expected a finite number');
        else if (d.type === 'int' && !Number.isInteger(v)) return bad('expected a whole number');
        else if (d.type === 'time' && v < 0) return bad('a time is milliseconds since 1970 and cannot be negative');
        vals.push([d, v]);
      }
      if (vals.length !== this.schema.length) return;
      let chunk = this.chunks[this.chunks.length - 1];
      if (!chunk || chunk.n === this.chunkRows) this.chunks.push((chunk = this.newChunk()));
      for (const [d, v] of vals) {
        if (v === null) continue;
        if (d.type === 'string') chunk.str.get(d.name)![chunk.n] = this.code(d.name, v as string) + 1;
        else if (d.type === 'bool') chunk.bool.get(d.name)![chunk.n] = v ? 1 : 0;
        else chunk.num.get(d.name)![chunk.n] = v as number;
      }
      chunk.n++;
      accepted++;
    });
    while (this.chunks.length > 1 && this.length > this.maxRows) this.evicted += this.chunks.shift()!.n;
    return { accepted, rejected };
  }

  private col(name: string, want?: ColumnType[]): ColumnDef {
    const d = this.byName.get(name);
    if (!d) throw new ColumnarError(`no column "${name}"`);
    if (want && !want.includes(d.type)) throw new ColumnarError(`column "${name}" is ${d.type}; this needs ${want.join(' or ')}`);
    return d;
  }

  private predicate(f: Filter): (c: Chunk, i: number) => boolean {
    const d = this.col(f.col);
    const dict = this.dict.get(f.col);
    const code = (v: string) => (dict!.index.get(v) ?? -1) + 1;
    const num = (c: Chunk, i: number) => c.num.get(f.col)![i]!;
    switch (f.op) {
      case 'eq':
      case 'ne': {
        const neg = f.op === 'ne';
        if (d.type === 'string') {
          if (typeof f.value !== 'string') throw new ColumnarError(`${f.col} is a string`);
          const k = code(f.value);
          return (c, i) => (c.str.get(f.col)![i]! === k && k > 0) !== neg;
        }
        if (d.type === 'bool') {
          if (typeof f.value !== 'boolean') throw new ColumnarError(`${f.col} is a bool`);
          const k = f.value ? 1 : 0;
          return (c, i) => (c.bool.get(f.col)![i]! === k) !== neg;
        }
        if (typeof f.value !== 'number') throw new ColumnarError(`${f.col} is a number`);
        return (c, i) => (num(c, i) === f.value) !== neg;
      }
      case 'in': {
        if (d.type === 'string') {
          const ks = new Set(f.values.map((v) => code(String(v))).filter((k) => k > 0));
          return (c, i) => ks.has(c.str.get(f.col)![i]!);
        }
        this.col(f.col, ['time', 'int', 'float']);
        const vs = new Set(f.values.map(Number));
        return (c, i) => vs.has(num(c, i));
      }
      case 'gt':
        this.col(f.col, ['time', 'int', 'float']);
        return (c, i) => num(c, i) > f.value;
      case 'gte':
        this.col(f.col, ['time', 'int', 'float']);
        return (c, i) => num(c, i) >= f.value;
      case 'lt':
        this.col(f.col, ['time', 'int', 'float']);
        return (c, i) => num(c, i) < f.value;
      case 'lte':
        this.col(f.col, ['time', 'int', 'float']);
        return (c, i) => num(c, i) <= f.value;
      case 'between':
        this.col(f.col, ['time', 'int', 'float']);
        return (c, i) => num(c, i) >= f.from && num(c, i) < f.to;
      case 'prefix': {
        this.col(f.col, ['string']);
        const ok = new Map<number, boolean>();
        return (c, i) => {
          const k = c.str.get(f.col)![i]!;
          if (k === 0) return false;
          let r = ok.get(k);
          if (r === undefined) ok.set(k, (r = dict!.values[k - 1]!.startsWith(f.value)));
          return r;
        };
      }
    }
  }

  /** Filters, groups and aggregates. Only the columns the query names are read. */
  query(q: Query): OutputRow[] {
    checkAggs(q.aggs);
    const by = q.by ?? [];
    for (const b of by) this.col(b, ['string', 'int', 'bool', 'float', 'time']);
    if (q.time) this.col(q.time.col, ['time']);
    for (const a of q.aggs) if (a.col) this.col(a.col, a.op === 'distinct' || a.op === 'count' ? undefined : ['int', 'float', 'time']);
    const preds = (q.where ?? []).map((f) => this.predicate(f));
    const maxGroups = q.maxGroups ?? 10_000;
    const groups = new Map<string, { dims: (string | number | boolean | null)[]; bucket?: number; states: State[] }>();
    let other: { dims: (string | number | boolean | null)[]; states: State[] } | undefined;
    for (const c of this.chunks) {
      rows: for (let i = 0; i < c.n; i++) {
        for (const p of preds) if (!p(c, i)) continue rows;
        const dims: (string | number | boolean | null)[] = by.map((b) => this.cell(c, b, i));
        let bucket: number | undefined;
        if (q.time) {
          const t = c.num.get(q.time.col)![i]!;
          if (Number.isNaN(t)) continue;
          bucket = bucketStart(t, q.time.every);
        }
        const key = JSON.stringify([bucket, dims]);
        let g = groups.get(key);
        if (!g) {
          if (groups.size >= maxGroups) {
            other ??= { dims: by.map(() => OTHER), states: q.aggs.map(fresh) };
            this.accumulate(q.aggs, other.states, c, i);
            continue;
          }
          groups.set(key, (g = { dims, ...(bucket !== undefined ? { bucket } : {}), states: q.aggs.map(fresh) }));
        }
        this.accumulate(q.aggs, g.states, c, i);
      }
    }
    const out: OutputRow[] = [...groups.values()].map((g) => {
      const row: OutputRow = {};
      if (g.bucket !== undefined) row['bucket'] = g.bucket;
      by.forEach((b, k) => (row[b] = g.dims[k]!));
      q.aggs.forEach((a, k) => (row[aggName(a)] = finish(a, g.states[k]!)));
      return row;
    });
    if (other) {
      const row: OutputRow = {};
      if (q.time) row['bucket'] = null;
      by.forEach((b, k) => (row[b] = other!.dims[k]!));
      q.aggs.forEach((a, k) => (row[aggName(a)] = finish(a, other!.states[k]!)));
      out.push(row);
    }
    return order(out, q);
  }

  private cell(c: Chunk, name: string, i: number): string | number | boolean | null {
    const d = this.byName.get(name)!;
    if (d.type === 'string') {
      const k = c.str.get(name)![i]!;
      return k === 0 ? null : this.dict.get(name)!.values[k - 1]!;
    }
    if (d.type === 'bool') {
      const b = c.bool.get(name)![i]!;
      return b === 2 ? null : b === 1;
    }
    const v = c.num.get(name)![i]!;
    return Number.isNaN(v) ? null : v;
  }

  private accumulate(aggs: readonly Agg[], states: State[], c: Chunk, i: number): void {
    aggs.forEach((a, k) => {
      const s = states[k]!;
      if (!a.col) {
        s.n++;
        return;
      }
      const v = this.cell(c, a.col, i);
      if (v === null) return;
      s.n++;
      if (a.op === 'distinct') s.hll!.add(String(v));
      else if (typeof v === 'number') {
        s.sum += v;
        if (v < s.min) s.min = v;
        if (v > s.max) s.max = v;
      }
    });
  }
}

function order(rows: OutputRow[], q: { orderBy?: { key: string; desc?: boolean }; limit?: number }): OutputRow[] {
  if (q.orderBy) {
    const { key, desc } = q.orderBy;
    rows.sort((a, b) => {
      const x = a[key] ?? null;
      const y = b[key] ?? null;
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * (desc ? -1 : 1);
    });
  }
  return q.limit === undefined ? rows : rows.slice(0, q.limit);
}

// ---------------------------------------------------------------------------------------------------------------
// Rollups

export interface RollupDef {
  readonly time: string;
  readonly every: 'minute' | 'hour' | 'day';
  readonly dims: readonly string[];
  readonly aggs: readonly Agg[];
  /** How far behind the newest event a row may arrive and still be counted. Default 0 (nothing late is accepted). */
  readonly allowedLatenessMs?: number;
  /** Buckets whose end is older than the newest event by more than this are dropped. Default 90 days. */
  readonly retentionMs?: number;
  /** Groups per bucket; more fold into "__other__". Default 1000. */
  readonly maxGroupsPerBucket?: number;
  readonly onTooLate?: (row: InputRow) => void;
}

interface RBucket {
  readonly start: number;
  groups: Map<string, { dims: (string | number | boolean | null)[]; states: State[] }>;
  revision: number;
  reportedRevision: number;
}

export interface Report {
  readonly bucket: number;
  readonly revision: number;
  /** True when this replaces an earlier report of the same bucket. */
  readonly correction: boolean;
  readonly rows: readonly OutputRow[];
}

export class Rollup {
  private readonly d: RollupDef;
  private readonly buckets = new Map<number, RBucket>();
  /** The newest event time seen. */
  watermark = -Infinity;
  readonly stats = { accepted: 0, invalid: 0, tooLate: 0, folded: 0, dropped: 0 };

  constructor(d: RollupDef) {
    checkAggs(d.aggs);
    if (new Set(d.dims).size !== d.dims.length) throw new ColumnarError('rollup dimensions must be distinct');
    this.d = d;
  }

  private closed(b: RBucket): boolean {
    return this.watermark - bucketEnd(b.start, this.d.every) >= (this.d.allowedLatenessMs ?? 0);
  }

  /** Adds events. A row whose bucket is closed is refused and counted; one for a reported bucket within the lateness revises it. */
  ingest(rows: readonly InputRow[]): void {
    for (const r of rows) {
      const t = r[this.d.time];
      if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) {
        this.stats.invalid++;
        continue;
      }
      const start = bucketStart(t, this.d.every);
      let b = this.buckets.get(start);
      if (!b && this.watermark - bucketEnd(start, this.d.every) >= (this.d.allowedLatenessMs ?? 0)) {
        this.stats.tooLate++;
        this.d.onTooLate?.(r);
        continue;
      }
      if (b && this.closed(b)) {
        this.stats.tooLate++;
        this.d.onTooLate?.(r);
        continue;
      }
      if (!b) this.buckets.set(start, (b = { start, groups: new Map(), revision: 0, reportedRevision: -1 }));
      if (t > this.watermark) this.watermark = t;
      const dims = this.d.dims.map((k) => {
        const v = r[k];
        return v === undefined ? null : v;
      });
      const key = JSON.stringify(dims);
      let g = b.groups.get(key);
      if (!g) {
        if (b.groups.size >= (this.d.maxGroupsPerBucket ?? 1000)) {
          const ok = JSON.stringify(this.d.dims.map(() => OTHER));
          g = b.groups.get(ok);
          if (!g) b.groups.set(ok, (g = { dims: this.d.dims.map(() => OTHER), states: this.d.aggs.map(fresh) }));
          this.stats.folded++;
        } else b.groups.set(key, (g = { dims, states: this.d.aggs.map(fresh) }));
      }
      this.d.aggs.forEach((a, k) => {
        const s = g!.states[k]!;
        if (!a.col) {
          s.n++;
          return;
        }
        const v = r[a.col];
        if (v === undefined || v === null) return;
        s.n++;
        if (a.op === 'distinct') s.hll!.add(String(v));
        else if (typeof v === 'number') {
          s.sum += v;
          if (v < s.min) s.min = v;
          if (v > s.max) s.max = v;
        }
      });
      b.revision++;
      this.stats.accepted++;
    }
    // Retention.
    const keep = this.d.retentionMs ?? 90 * MS.day;
    for (const [s, b] of this.buckets) if (this.watermark - bucketEnd(b.start, this.d.every) > keep) {
      this.buckets.delete(s);
      this.stats.dropped++;
    }
  }

  get size(): number {
    return this.buckets.size;
  }

  private rows(b: RBucket): OutputRow[] {
    return [...b.groups.values()].map((g) => {
      const row: OutputRow = { bucket: b.start };
      this.d.dims.forEach((k, i) => (row[k] = g.dims[i]!));
      this.d.aggs.forEach((a, i) => (row[aggName(a)] = finish(a, g.states[i]!)));
      return row;
    });
  }

  /** Reports buckets that have ended (by the watermark) and were not yet reported or have been revised since, oldest first. */
  report(): Report[] {
    const out: Report[] = [];
    for (const b of [...this.buckets.values()].sort((x, y) => x.start - y.start)) {
      if (bucketEnd(b.start, this.d.every) > this.watermark) continue;
      if (b.reportedRevision === b.revision) continue;
      out.push({ bucket: b.start, revision: b.revision, correction: b.reportedRevision >= 0, rows: this.rows(b) });
      b.reportedRevision = b.revision;
    }
    return out;
  }

  /** Reads the rollup between two instants at the same or a coarser grain, over some or all dimensions, merging partial states. */
  query(q: { from?: number; to?: number; every?: Every; by?: readonly string[]; where?: Readonly<Record<string, string | number | boolean>>; orderBy?: { key: string; desc?: boolean }; limit?: number }): OutputRow[] {
    const every = q.every ?? this.d.every;
    if (GRAIN[every] < GRAIN[this.d.every]) throw new ColumnarError(`the rollup is kept by ${this.d.every}; it cannot answer by ${every}`);
    const by = q.by ?? [];
    for (const b of by) if (!this.d.dims.includes(b)) throw new ColumnarError(`"${b}" is not a dimension of this rollup`);
    for (const k of Object.keys(q.where ?? {})) if (!this.d.dims.includes(k)) throw new ColumnarError(`"${k}" is not a dimension of this rollup`);
    const merged = new Map<string, { bucket: number; dims: (string | number | boolean | null)[]; states: State[] }>();
    for (const b of this.buckets.values()) {
      if ((q.from !== undefined && b.start < q.from) || (q.to !== undefined && b.start >= q.to)) continue;
      const start = bucketStart(b.start, every);
      for (const g of b.groups.values()) {
        if (Object.entries(q.where ?? {}).some(([k, v]) => g.dims[this.d.dims.indexOf(k)] !== v)) continue;
        const dims = by.map((k) => g.dims[this.d.dims.indexOf(k)]!);
        const key = JSON.stringify([start, dims]);
        let m = merged.get(key);
        if (!m) merged.set(key, (m = { bucket: start, dims, states: this.d.aggs.map(fresh) }));
        g.states.forEach((s, i) => mergeState(m!.states[i]!, s));
      }
    }
    const rows = [...merged.values()].sort((a, b) => a.bucket - b.bucket).map((m) => {
      const row: OutputRow = { bucket: m.bucket };
      by.forEach((k, i) => (row[k] = m.dims[i]!));
      this.d.aggs.forEach((a, i) => (row[aggName(a)] = finish(a, m.states[i]!)));
      return row;
    });
    return order(rows, q);
  }
}
