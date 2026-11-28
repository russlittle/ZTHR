/**
 * Rule-based segments over a collection of records: define who is in with a small rule tree, preview the count before
 * saving, refresh the membership on a schedule, say how fresh it is, and export it safely.
 *
 *  - Rules: all-of, any-of, not, and conditions on a field (the field types of the query block's `Collection`):
 *    = != < <= > >= contains, in (a list), between, is-set, is-not-set, and for date fields within-days / older-than-days
 *    measured from the injected clock. A rule can also say "is in segment X", and cycles between segments are refused.
 *    A rule list is checked before it is stored: unknown fields, values that do not fit the field's type, depth over
 *    8, more than 100 conditions, and conditions on fields marked sensitive (unless the segment is allowed to use them).
 *  - `fromQuery` turns the where-clause of a query (the query block's read-only language) into rules, so one grammar
 *    serves the console and the segment builder.
 *  - Preview: matches, total, share, and a short sample of ids, plus how many records each condition matches alone, so
 *    a builder can see which condition is doing the work. Nothing is stored by a preview.
 *  - Refresh: the membership is computed once and kept as a snapshot with the time it was taken; the next refresh
 *    reports who was added and who left. `freshness` says how old a snapshot is against the segment's own limit;
 *    `due` lists segments that need refreshing.
 *  - Export: CSV (RFC 4180 quoting, with the spreadsheet formula guard: a cell that starts with = + - @ tab or CR gets a
 *    leading apostrophe) or JSON lines. Sensitive fields are left out unless the caller may see them, the row count is
 *    capped, a stale snapshot is refused unless the caller says otherwise, and every export is written to an audit log.
 *
 * Out of scope: storage of records (they are passed in), sending to a destination, and per-record consent (filter
 * the records before they come here).
 */
import type { Collection } from '../query/index.ts';
import { parse, checkPlan } from '../query/index.ts';

export class SegmentError extends Error {
  constructor(why: string) {
    super(why);
  }
}

const DAY = 86_400_000;
export type Record_ = Readonly<Record<string, unknown>>;

export type Cmp = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'contains' | 'in' | 'between' | 'is-set' | 'is-not-set' | 'within-days' | 'older-than-days';
export type Rule =
  | { readonly op: 'all' | 'any'; readonly rules: readonly Rule[] }
  | { readonly op: 'not'; readonly rule: Rule }
  | { readonly segment: string }
  | { readonly field: string; readonly cmp: Cmp; readonly value?: unknown };

export interface Segment {
  readonly id: string;
  readonly name: string;
  readonly rules: Rule;
  /** Refresh at least this often (ms). */
  readonly maxAgeMs: number;
  /** May this segment filter on fields marked sensitive? */
  readonly allowSensitive?: boolean;
}

export interface Snapshot {
  readonly takenAt: number;
  readonly ids: readonly string[];
  readonly total: number;
  readonly added: number;
  readonly removed: number;
}

const MAX_DEPTH = 8;
const MAX_CONDITIONS = 100;
const NEEDS_VALUE: ReadonlySet<Cmp> = new Set(['=', '!=', '<', '<=', '>', '>=', 'contains', 'in', 'between', 'within-days', 'older-than-days']);

// ---------------------------------------------------------------- validation

const isLeaf = (r: Rule): r is Extract<Rule, { field: string }> => 'field' in r;
const isRef = (r: Rule): r is Extract<Rule, { segment: string }> => 'segment' in r;

export function checkRules(rule: Rule, c: Collection, o: { allowSensitive?: boolean; known?: (segment: string) => boolean } = {}): string[] {
  const problems: string[] = [];
  let conditions = 0;
  const walk = (r: Rule, depth: number, path: string) => {
    if (depth > MAX_DEPTH) return void problems.push(`${path}: rules nest deeper than ${MAX_DEPTH}`);
    if (isRef(r)) {
      if (o.known && !o.known(r.segment)) problems.push(`${path}: there is no segment ${r.segment}`);
      conditions++;
      return;
    }
    if (isLeaf(r)) {
      conditions++;
      if (!Object.hasOwn(c.fields, r.field)) return void problems.push(`${path}: ${c.name} has no field ${r.field}`);
      const f = c.fields[r.field]!;
      if (f.sensitive && !o.allowSensitive) problems.push(`${path}: ${r.field} is sensitive and cannot be used here`);
      if (NEEDS_VALUE.has(r.cmp) && r.value === undefined) return void problems.push(`${path}: ${r.cmp} needs a value`);
      if (!NEEDS_VALUE.has(r.cmp) && r.cmp !== 'is-set' && r.cmp !== 'is-not-set') return void problems.push(`${path}: "${String(r.cmp)}" is not a comparison`);
      const fits = (v: unknown) => (f.type === 'number' || f.type === 'date' ? typeof v === 'number' && Number.isFinite(v) : f.type === 'boolean' ? typeof v === 'boolean' : typeof v === 'string');
      if (r.cmp === 'contains' && f.type !== 'string') problems.push(`${path}: contains needs a text field`);
      else if (r.cmp === 'in') { if (!Array.isArray(r.value) || !r.value.length || r.value.length > 1000 || !r.value.every(fits)) problems.push(`${path}: in needs a list of 1 to 1000 ${f.type} values`); }
      else if (r.cmp === 'between') { if (!Array.isArray(r.value) || r.value.length !== 2 || !r.value.every(fits) || (r.value[0] as number) > (r.value[1] as number)) problems.push(`${path}: between needs [low, high]`); else if (f.type === 'boolean') problems.push(`${path}: between does not apply to true/false`); }
      else if (r.cmp === 'within-days' || r.cmp === 'older-than-days') { if (f.type !== 'date') problems.push(`${path}: ${r.cmp} needs a date field`); else if (typeof r.value !== 'number' || !(r.value >= 0 && r.value <= 36500)) problems.push(`${path}: ${r.cmp} needs a number of days`); }
      else if (NEEDS_VALUE.has(r.cmp) && !fits(r.value)) problems.push(`${path}: ${JSON.stringify(r.value)} does not fit ${r.cmp} on a ${f.type} field`);
      else if (['<', '<=', '>', '>='].includes(r.cmp) && (f.type === 'boolean')) problems.push(`${path}: ${r.cmp} does not apply to true/false`);
      return;
    }
    if (r.op === 'not') return walk(r.rule, depth + 1, `${path}.not`);
    if (r.op !== 'all' && r.op !== 'any') return void problems.push(`${path}: unknown operator`);
    if (!r.rules.length) problems.push(`${path}: ${r.op} of nothing`);
    r.rules.forEach((x, i) => walk(x, depth + 1, `${path}.${r.op}[${i}]`));
  };
  walk(rule, 1, 'rules');
  if (conditions > MAX_CONDITIONS) problems.push(`more than ${MAX_CONDITIONS} conditions`);
  return problems;
}

/** Turns the where-clause of a console query into rules (an all-of), checking it against the collection. */
export function fromQuery(text: string, collections: readonly Collection[]): { rules: Rule; collection: Collection } {
  const plan = parse(text.trim().toLowerCase().startsWith('from ') ? text : `from ${collections[0]?.name ?? 'x'} where ${text}`);
  const c = checkPlan(plan, collections);
  if (!plan.where.length) throw new SegmentError('that query has no conditions');
  return { collection: c, rules: { op: 'all', rules: plan.where.map((w) => ({ field: w.field, cmp: w.op, value: w.value })) } };
}

// ---------------------------------------------------------------- evaluation

export interface Context {
  readonly now: number;
  readonly members?: (segment: string) => ReadonlySet<string> | undefined;
  readonly idOf: (r: Record_) => string;
}

function leaf(r: Extract<Rule, { field: string }>, rec: Record_, now: number): boolean {
  const v = rec[r.field];
  const set = v !== undefined && v !== null && v !== '';
  switch (r.cmp) {
    case 'is-set': return set;
    case 'is-not-set': return !set;
    case '=': return set && v === r.value;
    case '!=': return v !== r.value;
    case 'contains': return typeof v === 'string' && v.toLowerCase().includes(String(r.value).toLowerCase());
    case 'in': return set && (r.value as unknown[]).includes(v);
    case 'between': return typeof v === 'number' && v >= (r.value as number[])[0]! && v <= (r.value as number[])[1]!;
    case 'within-days': return typeof v === 'number' && v <= now && now - v <= (r.value as number) * DAY;
    case 'older-than-days': return typeof v === 'number' && v <= now && now - v > (r.value as number) * DAY;
    default: {
      if (typeof v !== typeof r.value || v === undefined) return false;
      const a = v as number | string;
      const b = r.value as number | string;
      return r.cmp === '<' ? a < b : r.cmp === '<=' ? a <= b : r.cmp === '>' ? a > b : a >= b;
    }
  }
}

export function matches(rule: Rule, rec: Record_, ctx: Context): boolean {
  if (isRef(rule)) return ctx.members?.(rule.segment)?.has(ctx.idOf(rec)) ?? false;
  if (isLeaf(rule)) return leaf(rule, rec, ctx.now);
  if (rule.op === 'not') return !matches(rule.rule, rec, ctx);
  return rule.op === 'all' ? rule.rules.every((x) => matches(x, rec, ctx)) : rule.rules.some((x) => matches(x, rec, ctx));
}

const leaves = (r: Rule, out: Rule[] = []): Rule[] => {
  if (isLeaf(r) || isRef(r)) out.push(r);
  else if (r.op === 'not') leaves(r.rule, out);
  else r.rules.forEach((x) => leaves(x, out));
  return out;
};

export const describe = (r: Rule): string => {
  if (isRef(r)) return `in segment ${r.segment}`;
  if (isLeaf(r)) return `${r.field} ${r.cmp}${r.value === undefined ? '' : ` ${JSON.stringify(r.value)}`}`;
  if (r.op === 'not') return `not (${describe(r.rule)})`;
  return r.rules.map((x) => (isLeaf(x) || isRef(x) ? describe(x) : `(${describe(x)})`)).join(r.op === 'all' ? ' and ' : ' or ');
};

// ---------------------------------------------------------------- preview

export interface Preview {
  readonly matches: number;
  readonly total: number;
  readonly share: number;
  readonly sample: string[];
  /** Records each condition matches on its own, in rule order. */
  readonly perCondition: { readonly condition: string; readonly matches: number }[];
}

export function preview(rules: Rule, records: readonly Record_[], ctx: Context, o: { sample?: number } = {}): Preview {
  const n = o.sample ?? 5;
  if (!Number.isInteger(n) || n < 0 || n > 100) throw new SegmentError('the sample is 0 to 100 records');
  const ls = leaves(rules);
  const per = new Array<number>(ls.length).fill(0);
  const sample: string[] = [];
  let m = 0;
  for (const r of records) {
    ls.forEach((l, i) => { if (matches(l, r, ctx)) per[i]!++; });
    if (matches(rules, r, ctx)) { m++; if (sample.length < n) sample.push(ctx.idOf(r)); }
  }
  return { matches: m, total: records.length, share: records.length ? m / records.length : 0, sample, perCondition: ls.map((l, i) => ({ condition: describe(l), matches: per[i]! })) };
}

// ---------------------------------------------------------------- store

export interface ExportEntry {
  readonly at: number;
  readonly who: string;
  readonly segment: string;
  readonly format: 'csv' | 'jsonl';
  readonly rows: number;
  readonly fields: readonly string[];
  readonly stale: boolean;
}

export interface Freshness {
  readonly fresh: boolean;
  readonly ageMs: number | null;
  readonly dueAt: number | null;
}

const MAX_EXPORT = 100_000;

export class Segments {
  private defs = new Map<string, Segment>();
  private snaps = new Map<string, Snapshot>();
  readonly audit: ExportEntry[] = [];
  private readonly collection: Collection;
  private readonly idField: string;

  constructor(collection: Collection, idField: string) {
    if (!Object.hasOwn(collection.fields, idField)) throw new SegmentError(`${collection.name} has no field ${idField} to identify records`);
    this.collection = collection;
    this.idField = idField;
  }

  private readonly idOf = (r: Record_): string => String(r[this.idField]);

  define(s: Segment): void {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(s.id)) throw new SegmentError('a segment id is lower-case letters, digits and dashes, starting with a letter');
    if (!s.name.trim()) throw new SegmentError('a segment needs a name');
    if (!(Number.isFinite(s.maxAgeMs) && s.maxAgeMs >= 60_000)) throw new SegmentError('a segment is refreshed at least every minute or less often');
    const problems = checkRules(s.rules, this.collection, { allowSensitive: s.allowSensitive === true, known: (id) => id !== s.id && this.defs.has(id) });
    if (problems.length) throw new SegmentError(problems.join('; '));
    const cycle = this.findCycle(s);
    if (cycle) throw new SegmentError(`segments would depend on each other in a loop: ${cycle.join(' -> ')}`);
    this.defs.set(s.id, s);
    this.snaps.delete(s.id);
  }

  private refsOf(rule: Rule): string[] {
    return leaves(rule).filter(isRef).map((r) => r.segment);
  }

  private findCycle(s: Segment): string[] | null {
    const stack = [s.id];
    const dfs = (id: string, rules: Rule): string[] | null => {
      for (const next of this.refsOf(rules)) {
        if (stack.includes(next)) return [...stack, next];
        const d = next === s.id ? s : this.defs.get(next);
        if (!d) continue;
        stack.push(next);
        const found = dfs(next, d.rules);
        if (found) return found;
        stack.pop();
      }
      return null;
    };
    return dfs(s.id, s.rules);
  }

  get(id: string): Segment | undefined {
    return this.defs.get(id);
  }

  snapshot(id: string): Snapshot | undefined {
    return this.snaps.get(id);
  }

  /** Segments this one reads from come first, so a refresh run can go in this order. */
  order(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const r of this.refsOf(this.defs.get(id)!.rules)) if (this.defs.has(r)) visit(r);
      out.push(id);
    };
    for (const id of [...this.defs.keys()].sort()) visit(id);
    return out;
  }

  private context(now: number): Context {
    return { now, idOf: this.idOf, members: (id) => { const s = this.snaps.get(id); return s ? new Set(s.ids) : undefined; } };
  }

  preview(rules: Rule, records: readonly Record_[], now: number, o: { allowSensitive?: boolean; sample?: number } = {}): Preview {
    const problems = checkRules(rules, this.collection, { allowSensitive: o.allowSensitive === true, known: (id) => this.snaps.has(id) });
    if (problems.length) throw new SegmentError(problems.join('; '));
    return preview(rules, records, this.context(now), o.sample === undefined ? {} : { sample: o.sample });
  }

  /** Computes membership and keeps it with the time and the change since last time. */
  refresh(id: string, records: readonly Record_[], now: number): Snapshot {
    const s = this.defs.get(id);
    if (!s) throw new SegmentError(`there is no segment ${id}`);
    for (const dep of this.refsOf(s.rules)) if (!this.snaps.has(dep)) throw new SegmentError(`segment ${id} reads from ${dep}, which has not been refreshed yet`);
    const ctx = this.context(now);
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const r of records) {
      const rid = this.idOf(r);
      if (seen.has(rid)) throw new SegmentError(`two records have the id ${rid}`);
      seen.add(rid);
      if (matches(s.rules, r, ctx)) ids.push(rid);
    }
    const before = new Set(this.snaps.get(id)?.ids ?? []);
    const after = new Set(ids);
    const snap: Snapshot = { takenAt: now, ids, total: records.length, added: ids.filter((x) => !before.has(x)).length, removed: [...before].filter((x) => !after.has(x)).length };
    this.snaps.set(id, snap);
    return snap;
  }

  freshness(id: string, now: number): Freshness {
    const s = this.defs.get(id);
    if (!s) throw new SegmentError(`there is no segment ${id}`);
    const snap = this.snaps.get(id);
    if (!snap) return { fresh: false, ageMs: null, dueAt: null };
    return { fresh: now - snap.takenAt <= s.maxAgeMs, ageMs: now - snap.takenAt, dueAt: snap.takenAt + s.maxAgeMs };
  }

  /** Segments whose snapshot is missing or older than their limit, dependencies first. */
  due(now: number): string[] {
    return this.order().filter((id) => !this.freshness(id, now).fresh);
  }

  /** Whether `recordId` is in the segment as of the last snapshot. */
  has(id: string, recordId: string): boolean {
    return this.snaps.get(id)?.ids.includes(recordId) ?? false;
  }

  export(id: string, records: readonly Record_[], o: { who: string; now: number; format: 'csv' | 'jsonl'; fields?: readonly string[]; seeSensitive?: boolean; allowStale?: boolean }): string {
    const s = this.defs.get(id);
    const snap = this.snaps.get(id);
    if (!s || !snap) throw new SegmentError(`segment ${id} has no snapshot to export; refresh it first`);
    if (!o.who.trim()) throw new SegmentError('an export records who asked for it');
    const stale = !this.freshness(id, o.now).fresh;
    if (stale && !o.allowStale) throw new SegmentError(`segment ${id} is out of date (taken ${Math.round((o.now - snap.takenAt) / 60_000)} minutes ago); refresh it or allow a stale export`);
    if (snap.ids.length > MAX_EXPORT) throw new SegmentError(`${snap.ids.length} rows is over the export limit of ${MAX_EXPORT}`);
    const all = Object.keys(this.collection.fields);
    const want = o.fields ?? all;
    for (const f of want) if (!all.includes(f)) throw new SegmentError(`${this.collection.name} has no field ${f}`);
    const fields = want.filter((f) => o.seeSensitive || !this.collection.fields[f]!.sensitive);
    const inSet = new Set(snap.ids);
    const rows = records.filter((r) => inSet.has(this.idOf(r)));
    const text = o.format === 'csv'
      ? [fields.map(csvCell).join(','), ...rows.map((r) => fields.map((f) => csvCell(r[f])).join(','))].join('\r\n') + '\r\n'
      : rows.map((r) => JSON.stringify(Object.fromEntries(fields.map((f) => [f, r[f] ?? null])))).join('\n') + (rows.length ? '\n' : '');
    this.audit.push({ at: o.now, who: o.who, segment: id, format: o.format, rows: rows.length, fields, stale });
    return text;
  }
}

/** One CSV cell: RFC 4180 quoting, and a leading apostrophe on anything a spreadsheet would run as a formula. */
export function csvCell(v: unknown): string {
  if (v === undefined || v === null) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
