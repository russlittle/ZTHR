/**
 * A registry of the webhook events an app sends out. Each event type is declared once with a version, a JSON
 * Schema (the common subset: type, enum, const, required, properties, additionalProperties, items, length and range
 * limits, pattern and the formats date-time, date, uuid, email and uri), and a sample payload that must itself
 * satisfy the schema, so documentation can never drift from what is sent. Payloads are checked before they are
 * wrapped in the envelope (id, type, created, data), versions are compared for breaking changes, subscription
 * patterns ("invoice.*") are expanded against the catalogue, and a delivery log records every attempt (fields the
 * schema marks "x-sensitive" are redacted where written) so a person can explore what was sent, to whom, and why
 * it failed. It holds no network code: the Outbound sender in the webhooks block does the sending and reports
 * each attempt here.
 */

export interface Schema {
  readonly type?: string | readonly string[];
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly additionalProperties?: boolean | Schema;
  readonly items?: Schema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
  readonly format?: 'date-time' | 'date' | 'uuid' | 'email' | 'uri';
  readonly description?: string;
  /** The value is personal or secret: kept out of the delivery log. */
  readonly 'x-sensitive'?: boolean;
}

export interface Problem {
  readonly path: string;
  readonly message: string;
}

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class InvalidPayload extends CatalogError {
  readonly problems: readonly Problem[];
  constructor(type: string, problems: readonly Problem[]) {
    super(`${type}: ${problems.map((p) => `${p.path} ${p.message}`).join('; ')}`);
    this.problems = problems;
  }
}

const MAX_DEPTH = 32;

const kindOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

const FORMATS_DATE = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

const FORMATS: Readonly<Record<NonNullable<Schema['format']>, (s: string) => boolean>> = {
  'date-time': (s) => /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s) && FORMATS_DATE(s.slice(0, 10)),
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s),
  uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  email: (s) => /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s),
  uri: (s) => {
    try {
      return /^[a-z][a-z0-9+.-]*:/i.test(s) && !!new URL(s);
    } catch {
      return false;
    }
  },
};

/** Every way a value departs from a schema, each with its path ("$.customer.email"). Empty means it conforms. */
export function check(schema: Schema, value: unknown, path = '$', depth = 0): Problem[] {
  if (depth > MAX_DEPTH) return [{ path, message: 'is nested too deeply' }];
  const out: Problem[] = [];
  const kind = kindOf(value);
  if (schema.type !== undefined) {
    const want = typeof schema.type === 'string' ? [schema.type] : schema.type;
    const ok = want.some((t) => t === kind || (t === 'number' && kind === 'integer'));
    if (!ok) return [{ path, message: `must be ${want.join(' or ')}, not ${kind}` }];
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) out.push({ path, message: `must be ${JSON.stringify(schema.const)}` });
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) out.push({ path, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}` });
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push({ path, message: `must be at least ${schema.minLength} characters` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push({ path, message: `must be at most ${schema.maxLength} characters` });
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) out.push({ path, message: `must match ${schema.pattern}` });
    if (schema.format !== undefined && !FORMATS[schema.format](value)) out.push({ path, message: `must be a valid ${schema.format}` });
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push({ path, message: 'must be a finite number' });
    if (schema.minimum !== undefined && value < schema.minimum) out.push({ path, message: `must be at least ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) out.push({ path, message: `must be at most ${schema.maximum}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push({ path, message: `must have at least ${schema.minItems} items` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push({ path, message: `must have at most ${schema.maxItems} items` });
    if (schema.items) value.forEach((v, i) => out.push(...check(schema.items!, v, `${path}[${i}]`, depth + 1)));
  }
  if (kind === 'object') {
    const o = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!Object.hasOwn(o, r)) out.push({ path: `${path}.${r}`, message: 'is required' });
    for (const [k, v] of Object.entries(o)) {
      const sub = schema.properties && Object.hasOwn(schema.properties, k) ? schema.properties[k] : undefined;
      if (sub) out.push(...check(sub, v, `${path}.${k}`, depth + 1));
      else if (schema.additionalProperties === false) out.push({ path: `${path}.${k}`, message: 'is not allowed' });
      else if (typeof schema.additionalProperties === 'object') out.push(...check(schema.additionalProperties, v, `${path}.${k}`, depth + 1));
    }
  }
  return out;
}

/** A copy of a value with everything the schema marks sensitive replaced, for logs. */
export function redact(schema: Schema, value: unknown, depth = 0): unknown {
  if (schema['x-sensitive']) return '[redacted]';
  if (depth > MAX_DEPTH) return '[too deep]';
  if (Array.isArray(value)) return value.map((v) => redact(schema.items ?? {}, v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties && Object.hasOwn(schema.properties, k) ? schema.properties[k] : typeof schema.additionalProperties === 'object' ? schema.additionalProperties : {};
      out[k] = redact(sub ?? {}, v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Deprecation {
  readonly since: string;
  readonly sunset?: string;
  readonly use?: string;
}

export interface EventDef {
  /** Lower-case and dotted: "invoice.paid". */
  readonly type: string;
  readonly version: number;
  readonly summary: string;
  readonly schema: Schema;
  readonly sample: unknown;
  readonly deprecated?: Deprecation;
}

export interface Change {
  readonly path: string;
  readonly change: string;
}

export interface Comparison {
  readonly breaking: readonly Change[];
  readonly additive: readonly Change[];
}

const TYPE_NAME = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/;

export interface Envelope {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly created: string;
  readonly data: unknown;
}

export class Catalog {
  private readonly defs = new Map<string, EventDef[]>();

  /** Declares an event version. The sample must satisfy the schema; versions only go up. */
  define(def: EventDef): EventDef {
    if (!TYPE_NAME.test(def.type)) throw new CatalogError(`${def.type}: event types are lower-case and dotted, like invoice.paid`);
    if (!Number.isInteger(def.version) || def.version < 1) throw new CatalogError(`${def.type}: the version must be a whole number from 1`);
    if (!def.summary.trim()) throw new CatalogError(`${def.type}: an event needs a summary`);
    if (def.schema.type !== 'object') throw new CatalogError(`${def.type}: the payload schema must describe an object`);
    const list = this.defs.get(def.type) ?? [];
    const last = list[list.length - 1];
    if (last && def.version <= last.version) throw new CatalogError(`${def.type}: version ${def.version} is not newer than ${last.version}`);
    const bad = check(def.schema, def.sample);
    if (bad.length) throw new CatalogError(`${def.type}: the sample does not satisfy its schema: ${bad.map((p) => `${p.path} ${p.message}`).join('; ')}`);
    list.push(def);
    this.defs.set(def.type, list);
    return def;
  }

  types(): string[] {
    return [...this.defs.keys()].sort();
  }

  /** The newest version, or the one asked for. */
  get(type: string, version?: number): EventDef | undefined {
    const list = this.defs.get(type);
    return version === undefined ? list?.[list.length - 1] : list?.find((d) => d.version === version);
  }

  versions(type: string): number[] {
    return (this.defs.get(type) ?? []).map((d) => d.version);
  }

  private need(type: string, version?: number): EventDef {
    const d = this.get(type, version);
    if (!d) throw new CatalogError(`${type}${version === undefined ? '' : ` v${version}`} is not in the webhook catalog`);
    return d;
  }

  /** Every problem with a payload for an event, or none. */
  validate(type: string, payload: unknown, version?: number): Problem[] {
    return check(this.need(type, version).schema, payload);
  }

  /** The body to send: refuses an undeclared event or a payload its schema does not allow. */
  envelope(type: string, data: unknown, o: { id: string; now: Date; version?: number }): Envelope {
    const d = this.need(type, o.version);
    const bad = check(d.schema, data);
    if (bad.length) throw new InvalidPayload(type, bad);
    return { id: o.id, type, version: d.version, created: o.now.toISOString(), data };
  }

  /** The sample as it would arrive, for documentation and for testing a receiver. */
  sampleEnvelope(type: string, o: { id: string; now: Date; version?: number }): Envelope {
    const d = this.need(type, o.version);
    return { id: o.id, type, version: d.version, created: o.now.toISOString(), data: structuredClone(d.sample) };
  }

  /** Expands subscription patterns ("*", "invoice.*", "invoice.paid") to event types, and names patterns that match nothing. */
  expand(patterns: readonly string[]): { types: string[]; unmatched: string[] } {
    const types = new Set<string>();
    const unmatched: string[] = [];
    for (const p of patterns) {
      const hit = this.types().filter((t) => p === '*' || t === p || (p.endsWith('.*') && t.startsWith(p.slice(0, -1))));
      if (!hit.length) unmatched.push(p);
      for (const t of hit) types.add(t);
    }
    return { types: [...types].sort(), unmatched };
  }

  /** What changed between two versions of an event: a new required field, a removed field or a changed type breaks receivers. */
  compare(type: string, from: number, to: number): Comparison {
    const a = this.need(type, from).schema;
    const b = this.need(type, to).schema;
    const breaking: Change[] = [];
    const additive: Change[] = [];
    const walk = (x: Schema, y: Schema, path: string, depth: number) => {
      if (depth > MAX_DEPTH) return;
      const tx = JSON.stringify(x.type);
      const ty = JSON.stringify(y.type);
      if (tx !== ty) breaking.push({ path, change: `type changed from ${tx ?? 'any'} to ${ty ?? 'any'}` });
      if (x.enum && y.enum) {
        for (const e of x.enum) if (!y.enum.some((z) => JSON.stringify(z) === JSON.stringify(e))) breaking.push({ path, change: `value ${JSON.stringify(e)} no longer allowed` });
        for (const e of y.enum) if (!x.enum.some((z) => JSON.stringify(z) === JSON.stringify(e))) additive.push({ path, change: `value ${JSON.stringify(e)} added` });
      }
      const px = x.properties ?? {};
      const py = y.properties ?? {};
      for (const k of Object.keys(px)) {
        if (!Object.hasOwn(py, k)) breaking.push({ path: `${path}.${k}`, change: 'field removed' });
        else walk(px[k]!, py[k]!, `${path}.${k}`, depth + 1);
      }
      for (const k of Object.keys(py)) {
        if (Object.hasOwn(px, k)) continue;
        if ((y.required ?? []).includes(k)) breaking.push({ path: `${path}.${k}`, change: 'new required field' });
        else additive.push({ path: `${path}.${k}`, change: 'optional field added' });
      }
      for (const k of y.required ?? []) if (Object.hasOwn(px, k) && !(x.required ?? []).includes(k)) breaking.push({ path: `${path}.${k}`, change: 'field became required' });
      for (const k of x.required ?? []) if (Object.hasOwn(py, k) && !(y.required ?? []).includes(k)) additive.push({ path: `${path}.${k}`, change: 'field became optional' });
      if (x.items && y.items) walk(x.items, y.items, `${path}[]`, depth + 1);
    };
    walk(a, b, '$', 0);
    return { breaking, additive };
  }

  /** The fields of an event as rows for a documentation table. */
  fields(type: string, version?: number): { path: string; type: string; required: boolean; description: string }[] {
    const rows: { path: string; type: string; required: boolean; description: string }[] = [];
    const walk = (s: Schema, path: string, required: boolean, depth: number) => {
      if (depth > MAX_DEPTH) return;
      if (path !== '$') rows.push({ path, type: Array.isArray(s.type) ? s.type.join('|') : ((s.type as string | undefined) ?? 'any'), required, description: s.description ?? '' });
      for (const [k, v] of Object.entries(s.properties ?? {})) walk(v, `${path}.${k}`, (s.required ?? []).includes(k), depth + 1);
      if (s.items) walk(s.items, `${path}[]`, true, depth + 1);
    };
    walk(this.need(type, version).schema, '$', true, 0);
    return rows;
  }

  /** Events that are deprecated, with the day each stops being sent, for the documentation and for owners to act on. */
  deprecations(): { type: string; version: number; since: string; sunset?: string; use?: string }[] {
    return [...this.defs.values()].flat().filter((d) => d.deprecated).map((d) => ({ type: d.type, version: d.version, ...d.deprecated! }));
  }

  /** The delivery log must know each event's schema to redact; this gives it one by type. */
  schemaOf(type: string, version?: number): Schema | undefined {
    return this.get(type, version)?.schema;
  }
}

// ---------------------------------------------------------------- delivery log

export interface Attempt {
  readonly id: string;
  readonly endpoint: string;
  readonly type: string;
  readonly version?: number;
  readonly attempt: number;
  readonly at: number;
  /** HTTP status when there was an answer. */
  readonly status?: number;
  readonly ms: number;
  readonly error?: string;
  readonly body: unknown;
}

export interface LoggedAttempt extends Attempt {
  readonly ok: boolean;
}

export interface Filter {
  readonly endpoint?: string;
  readonly type?: string;
  readonly ok?: boolean;
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;
}

export interface Summary {
  readonly total: number;
  readonly ok: number;
  readonly failed: number;
  readonly successRate: number;
  readonly p50: number;
  readonly p95: number;
  readonly consecutiveFailures: number;
  readonly lastFailure?: LoggedAttempt;
}

const pct = (sorted: readonly number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! : 0);

export class DeliveryLog {
  private readonly rows: LoggedAttempt[] = [];
  private readonly catalog: Catalog;
  private readonly keep: number;

  /** Keeps the newest `keep` attempts; older ones fall off so the log is bounded. */
  constructor(catalog: Catalog, keep = 10_000) {
    this.catalog = catalog;
    this.keep = keep;
  }

  /** An attempt is a success when it was answered 2xx and had no error. The body is stored with sensitive fields redacted. */
  record(a: Attempt): LoggedAttempt {
    const schema = this.catalog.schemaOf(a.type, a.version);
    const row: LoggedAttempt = { ...a, body: schema ? redact(schema, a.body) : '[unknown event: body not kept]', ok: a.error === undefined && a.status !== undefined && a.status >= 200 && a.status < 300 };
    this.rows.push(row);
    if (this.rows.length > this.keep) this.rows.splice(0, this.rows.length - this.keep);
    return row;
  }

  /** Matching attempts, newest first. */
  query(f: Filter = {}): LoggedAttempt[] {
    const out = this.rows.filter((r) => (f.endpoint === undefined || r.endpoint === f.endpoint) && (f.type === undefined || r.type === f.type) && (f.ok === undefined || r.ok === f.ok) && (f.since === undefined || r.at >= f.since) && (f.until === undefined || r.at <= f.until));
    out.sort((a, b) => b.at - a.at || 0);
    return out.slice(0, f.limit ?? 100);
  }

  /** Every attempt at one delivery, in order, to see how it went from first try to parked or delivered. */
  history(deliveryId: string): LoggedAttempt[] {
    return this.rows.filter((r) => r.id === deliveryId).sort((a, b) => a.attempt - b.attempt);
  }

  summary(endpoint: string): Summary {
    const mine = this.rows.filter((r) => r.endpoint === endpoint);
    const ms = mine.map((r) => r.ms).sort((a, b) => a - b);
    const ok = mine.filter((r) => r.ok).length;
    let streak = 0;
    for (let i = mine.length - 1; i >= 0 && !mine[i]!.ok; i--) streak++;
    const failed = mine.filter((r) => !r.ok);
    return { total: mine.length, ok, failed: mine.length - ok, successRate: mine.length ? ok / mine.length : 1, p50: pct(ms, 50), p95: pct(ms, 95), consecutiveFailures: streak, ...(failed.length ? { lastFailure: failed[failed.length - 1]! } : {}) };
  }

  /** Counts by event type, by outcome and by reason, over the matching attempts, for the explorer's side panel. */
  facets(f: Filter = {}): { byType: Record<string, number>; byOutcome: Record<string, number>; byReason: Record<string, number> } {
    const byType: Record<string, number> = {};
    const byOutcome: Record<string, number> = {};
    const byReason: Record<string, number> = {};
    for (const r of this.query({ ...f, limit: Number.MAX_SAFE_INTEGER })) {
      byType[r.type] = (byType[r.type] ?? 0) + 1;
      const o = r.ok ? 'delivered' : 'failed';
      byOutcome[o] = (byOutcome[o] ?? 0) + 1;
      if (!r.ok) {
        const why = r.error ?? `answered ${r.status}`;
        byReason[why] = (byReason[why] ?? 0) + 1;
      }
    }
    return { byType, byOutcome, byReason };
  }
}
