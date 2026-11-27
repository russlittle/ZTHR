/**
 * Reports from rows: a report names its filters, the dimensions to group by, and measures (count, sum, average,
 * min, max, distinct count), and comes back as a table with a totals row, or pivoted with one dimension across the
 * columns. Groups smaller than a threshold can be suppressed. Saved templates have parameters with defaults; a
 * schedule (5-field cron, UTC) decides when a template is run and delivered, and every delivery is logged.
 */
import { cron } from '../jobs/index.ts';
import { toCsv } from '../tabular/index.ts';

export type Row = Readonly<Record<string, unknown>>;

export interface Measure {
  readonly name: string;
  readonly op: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'distinct';
  readonly field?: string;
}

export type Filter = { readonly field: string } & ({ readonly eq: unknown } | { readonly in: readonly unknown[] } | { readonly gte?: number | string; readonly lt?: number | string });

export interface Spec {
  readonly filters?: readonly Filter[];
  readonly groupBy: readonly string[];
  readonly measures: readonly Measure[];
  readonly sort?: { readonly by: string; readonly desc?: boolean };
  /** Groups with fewer rows than this are hidden; their rows still count in the totals. */
  readonly minGroup?: number;
}

const pass = (r: Row, f: Filter) => {
  const v = r[f.field];
  if ('eq' in f) return v === f.eq;
  if ('in' in f) return f.in.includes(v);
  const x = v as number | string;
  return (f.gte === undefined || x >= f.gte) && (f.lt === undefined || x < f.lt);
};

function measure(rows: readonly Row[], m: Measure): number | null {
  if (m.op === 'count') return rows.length;
  const vals = rows.map((r) => r[m.field!]).filter((v) => v !== null && v !== undefined);
  if (m.op === 'distinct') return new Set(vals.map((v) => JSON.stringify(v))).size;
  const nums = vals.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return null;
  if (m.op === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (m.op === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
  // A loop, not Math.min(...nums): spreading a large group overflows the call stack.
  let best = nums[0]!;
  for (const n of nums) if (m.op === 'min' ? n < best : n > best) best = n;
  return best;
}

export interface Result {
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  readonly totals: Record<string, unknown>;
  readonly hidden: number;
}

export function run(data: readonly Row[], s: Spec): Result {
  for (const m of s.measures) if (m.op !== 'count' && !m.field) throw new Error(`${m.name} needs a field to ${m.op}`);
  const rows = data.filter((r) => (s.filters ?? []).every((f) => pass(r, f)));
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = JSON.stringify(s.groupBy.map((g) => r[g] ?? null));
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  let hidden = 0;
  let out: Record<string, unknown>[] = [];
  for (const [k, g] of groups) {
    if (s.minGroup && g.length < s.minGroup) {
      hidden++;
      continue;
    }
    const keys = JSON.parse(k) as unknown[];
    const rec: Record<string, unknown> = {};
    s.groupBy.forEach((d, i) => (rec[d] = keys[i]));
    for (const m of s.measures) rec[m.name] = measure(g, m);
    out.push(rec);
  }
  const by = s.sort?.by ?? s.groupBy[0];
  const cmp = (x: unknown, y: unknown) => (x === y ? 0 : x === null || x === undefined ? 1 : y === null || y === undefined ? -1 : (x as number | string) < (y as number | string) ? -1 : 1);
  if (by)
    out = out.sort((a, b) => {
      const c = cmp(a[by], b[by]);
      if (c) return s.sort?.desc ? -c : c;
      for (const g of s.groupBy) if (cmp(a[g], b[g])) return cmp(a[g], b[g]);
      return 0;
    });
  const totals: Record<string, unknown> = {};
  s.groupBy.forEach((d, i) => (totals[d] = i === 0 ? 'Total' : ''));
  for (const m of s.measures) totals[m.name] = measure(rows, m);
  return { columns: [...s.groupBy, ...s.measures.map((m) => m.name)], rows: out, totals, hidden };
}

/** One dimension down, one across, one measure in the cells. */
export function pivot(data: readonly Row[], down: string, across: string, m: Measure, filters: readonly Filter[] = []): { columns: string[]; rows: Record<string, unknown>[] } {
  const r = run(data, { filters, groupBy: [down, across], measures: [m] });
  const cols = [...new Set(r.rows.map((x) => String(x[across])))].sort();
  // Cells are kept in Maps: column names come from the data, and a value such as "constructor" must not read an
  // object's inherited property.
  const byDown = new Map<string, { key: unknown; cells: Map<string, unknown> }>();
  for (const x of r.rows) {
    const k = String(x[down]);
    const rec = byDown.get(k) ?? { key: x[down], cells: new Map<string, unknown>() };
    rec.cells.set(String(x[across]), x[m.name]);
    byDown.set(k, rec);
  }
  return { columns: [down, ...cols], rows: [...byDown.values()].map((rec) => Object.fromEntries([[down, rec.key], ...cols.map((c) => [c, rec.cells.get(c) ?? null])])) };
}

export const asCsv = (r: Result) => toCsv([r.columns, ...r.rows.map((x) => r.columns.map((c) => x[c])), r.columns.map((c) => r.totals[c])]);

export interface Template {
  readonly id: string;
  readonly title: string;
  readonly params: Readonly<Record<string, { default: string; options?: readonly string[] }>>;
  readonly build: (p: Readonly<Record<string, string>>) => Spec;
}

export function fromTemplate(t: Template, given: Readonly<Record<string, string>> = {}): Spec {
  const p: Record<string, string> = {};
  for (const [k, d] of Object.entries(t.params)) {
    const v = (Object.hasOwn(given, k) ? given[k] : undefined) ?? d.default;
    if (d.options && !d.options.includes(v)) throw new Error(`${k} must be one of ${d.options.join(', ')}`);
    p[k] = v;
  }
  const extra = Object.keys(given).filter((k) => !Object.hasOwn(t.params, k));
  if (extra.length) throw new Error(`${t.title} has no parameter ${extra.join(', ')}`);
  return t.build(p);
}

export interface Schedule {
  readonly template: string;
  readonly params: Readonly<Record<string, string>>;
  readonly cron: string;
  readonly to: readonly string[];
  next: number;
}

export class Delivery {
  readonly log: { template: string; to: readonly string[]; at: string; rows: number; ok: boolean; error?: string }[] = [];
  private readonly templates: Map<string, Template>;
  private readonly data: () => Promise<readonly Row[]>;
  private readonly send: (to: readonly string[], title: string, csv: string) => Promise<void>;
  readonly schedules: Schedule[] = [];
  constructor(templates: readonly Template[], data: () => Promise<readonly Row[]>, send: (to: readonly string[], title: string, csv: string) => Promise<void>) {
    this.templates = new Map(templates.map((t) => [t.id, t]));
    this.data = data;
    this.send = send;
  }
  schedule(template: string, params: Record<string, string>, expr: string, to: readonly string[], now: Date): Schedule {
    const t = this.templates.get(template);
    if (!t) throw new Error(`no template ${template}`);
    fromTemplate(t, params);
    const s: Schedule = { template, params, cron: expr, to, next: cron(expr).next(now).getTime() };
    this.schedules.push(s);
    return s;
  }
  /** Runs and delivers every schedule that is due; a failure is logged and does not stop the rest. */
  async tick(now: Date): Promise<number> {
    let n = 0;
    for (const s of this.schedules) {
      if (s.next > now.getTime()) continue;
      // Claim the run before any await, so a tick that overlaps this one does not deliver it again.
      s.next = cron(s.cron).next(now).getTime();
      const t = this.templates.get(s.template)!;
      try {
        const r = run(await this.data(), fromTemplate(t, s.params));
        await this.send(s.to, t.title, asCsv(r));
        this.log.push({ template: t.id, to: s.to, at: now.toISOString(), rows: r.rows.length, ok: true });
      } catch (e) {
        this.log.push({ template: t.id, to: s.to, at: now.toISOString(), rows: 0, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      n++;
    }
    return n;
  }
}
