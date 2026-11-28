/**
 * Questions in plain words over a declared dataset. A model (a language model in production, a deterministic twin
 * in tests) proposes a report for the question; its proposal is untrusted data and is never run as given. It is
 * checked against the dataset's declaration: only declared fields the person may see, only measures that make
 * sense for each field's type, only filters on filterable fields with values of the right kind, and nothing else.
 * The model is shown only the fields the person may see, and the rows are cut down to those fields before any
 * report runs, so a hidden field cannot reach the answer however the proposal is worded. Groups smaller than the
 * dataset's floor are hidden, with a second group hidden when one alone would be recoverable from the total, and
 * a total from too few records is withheld. The answer comes with the records behind it, a plain-English
 * description of exactly what was computed, written from the checked report rather than from the model, and the
 * report itself so it can be saved or rerun.
 */
import { run, type Filter, type Measure, type Row, type Spec } from '../reports/index.ts';

export type FieldType = 'text' | 'number' | 'date';

export interface DatasetField {
  readonly name: string;
  readonly label: string;
  readonly type: FieldType;
  /** Can rows be grouped by it? Defaults to true for text and date fields. */
  readonly groupable?: boolean;
  /** Can it be filtered on? Defaults to true. */
  readonly filterable?: boolean;
  /** The values it may take; equality filters must use one of them. */
  readonly values?: readonly (string | number | boolean)[];
  /** The roles that may see it; everyone may when absent. */
  readonly seenBy?: readonly string[];
}

export interface Dataset {
  readonly name: string;
  /** What one row is, for descriptions: { one: 'student', many: 'students' }. */
  readonly noun: { readonly one: string; readonly many: string };
  readonly fields: readonly DatasetField[];
  /** Groups with fewer rows are hidden. Defaults to 5; the model cannot change it. */
  readonly minGroup?: number;
}

export interface Person {
  readonly id: string;
  readonly roles: readonly string[];
}

/** What the model is told about the dataset: only what this person may see. */
export interface Schema {
  readonly name: string;
  readonly noun: { readonly one: string; readonly many: string };
  readonly fields: readonly { readonly name: string; readonly label: string; readonly type: FieldType; readonly groupable: boolean; readonly filterable: boolean; readonly values?: readonly (string | number | boolean)[] }[];
  readonly ops: readonly Measure['op'][];
}

/**
 * The shape a model must propose. Anything else is refused.
 * `sort.measure` is an index into `measures`; `sort.field` names a groupBy field.
 */
export interface Proposal {
  readonly groupBy?: readonly string[];
  readonly measures: readonly { readonly op: Measure['op']; readonly field?: string }[];
  readonly filters?: readonly Filter[];
  readonly sort?: { readonly measure?: number; readonly field?: string; readonly desc?: boolean };
  readonly limit?: number;
}

export interface Model {
  propose(question: string, schema: Schema): Promise<unknown>;
}

export const LIMITS = { question: 500, groupBy: 2, measures: 4, filters: 6, inValues: 50, rows: 100, records: 20 } as const;

const OPS: readonly Measure['op'][] = ['count', 'sum', 'avg', 'min', 'max', 'distinct'];

const mayView = (f: DatasetField, p: Person) => !f.seenBy || f.seenBy.some((r) => p.roles.includes(r));
const groupable = (f: DatasetField) => f.groupable ?? f.type !== 'number';
const filterable = (f: DatasetField) => f.filterable ?? true;

export function schemaFor(d: Dataset, p: Person): Schema {
  return {
    name: d.name,
    noun: d.noun,
    fields: d.fields.filter((f) => mayView(f, p)).map((f) => ({ name: f.name, label: f.label, type: f.type, groupable: groupable(f), filterable: filterable(f), ...(f.values ? { values: f.values } : {}) })),
    ops: OPS,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isScalar = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
const show = (v: unknown) => (typeof v === 'string' ? `"${v.length > 40 ? `${v.slice(0, 40)}…` : v}"` : String(v));

export const measureKey = (m: { op: Measure['op']; field?: string }) => (m.op === 'count' ? 'count' : `${m.op}_${m.field}`);

/**
 * Checks a proposal against the dataset for this person and returns the report to run, or every reason it was
 * refused. A field the person may not see is refused with the same words as a field that does not exist.
 */
export function check(raw: unknown, d: Dataset, p: Person): { ok: true; spec: Spec; limit: number } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const visible = new Map(d.fields.filter((f) => mayView(f, p)).map((f) => [f.name, f]));
  const field = (name: unknown, where: string): DatasetField | undefined => {
    if (typeof name !== 'string') {
      problems.push(`${where} must name a field.`);
      return undefined;
    }
    const f = visible.get(name);
    if (!f) problems.push(`${where} uses ${show(name)}, which is not something you can ask about in ${d.name}.`);
    return f;
  };
  const only = (o: Record<string, unknown>, keys: readonly string[], where: string) => {
    const extra = Object.keys(o).filter((k) => !keys.includes(k));
    if (extra.length) problems.push(`${where} has ${extra.map((k) => show(k)).join(', ')}, which ${extra.length === 1 ? 'is' : 'are'} not allowed.`);
  };
  if (!isObj(raw)) return { ok: false, problems: ['The proposal is not a report.'] };
  only(raw, ['groupBy', 'measures', 'filters', 'sort', 'limit'], 'The proposal');

  const groupBy: string[] = [];
  if (raw.groupBy !== undefined) {
    if (!Array.isArray(raw.groupBy)) problems.push('groupBy must be a list of fields.');
    else {
      if (raw.groupBy.length > LIMITS.groupBy) problems.push(`A question can be grouped by at most ${LIMITS.groupBy} fields.`);
      for (const g of raw.groupBy) {
        const f = field(g, 'Grouping');
        if (f && !groupable(f)) problems.push(`${f.label} cannot be used to group ${d.noun.many}.`);
        else if (f && groupBy.includes(f.name)) problems.push(`${f.label} is grouped by twice.`);
        else if (f) groupBy.push(f.name);
      }
    }
  }

  const measures: Measure[] = [];
  if (!Array.isArray(raw.measures) || raw.measures.length === 0) problems.push('The proposal must ask for at least one measure.');
  else {
    if (raw.measures.length > LIMITS.measures) problems.push(`A question can ask for at most ${LIMITS.measures} measures.`);
    for (const m of raw.measures) {
      if (!isObj(m)) {
        problems.push('Each measure must be an object with an op.');
        continue;
      }
      only(m, ['op', 'field'], 'A measure');
      if (typeof m.op !== 'string' || !OPS.includes(m.op as Measure['op'])) {
        problems.push(`${show(m.op)} is not a measure; use one of ${OPS.join(', ')}.`);
        continue;
      }
      const op = m.op as Measure['op'];
      if (op === 'count') {
        if (m.field !== undefined) problems.push('count counts records and takes no field.');
        if (!measures.some((x) => x.op === 'count')) measures.push({ name: 'count', op: 'count' });
        continue;
      }
      const f = field(m.field, `The ${op} measure`);
      if (!f) continue;
      if (op !== 'distinct' && f.type !== 'number' && !(f.type === 'date' && (op === 'min' || op === 'max'))) {
        problems.push(`${f.label} is not a number, so it cannot be ${({ sum: 'added up', avg: 'averaged', min: 'compared', max: 'compared' } as const)[op]}.`);
        continue;
      }
      const name = measureKey({ op, field: f.name });
      if (!measures.some((x) => x.name === name)) measures.push({ name, op, field: f.name });
    }
  }

  const filters: Filter[] = [];
  if (raw.filters !== undefined) {
    if (!Array.isArray(raw.filters)) problems.push('filters must be a list.');
    else {
      if (raw.filters.length > LIMITS.filters) problems.push(`A question can have at most ${LIMITS.filters} filters.`);
      for (const x of raw.filters) {
        if (!isObj(x)) {
          problems.push('Each filter must be an object with a field.');
          continue;
        }
        const f = field(x.field, 'A filter');
        if (!f) continue;
        if (!filterable(f)) {
          problems.push(`${f.label} cannot be filtered on.`);
          continue;
        }
        const forms = ['eq', 'in'].filter((k) => k in x).length + ('gte' in x || 'lt' in x ? 1 : 0);
        if (forms !== 1) {
          problems.push(`The filter on ${f.label} must use exactly one of eq, in, or a range (gte and lt).`);
          continue;
        }
        const typeOk = (v: unknown) => (f.type === 'number' ? typeof v === 'number' && Number.isFinite(v) : f.type === 'date' ? typeof v === 'string' && /^\d{4}(-\d{2}(-\d{2}(T[\d:.]+Z?)?)?)?$/.test(v) : isScalar(v));
        const allowed = (v: unknown) => !f.values || f.values.includes(v as string | number | boolean);
        if ('eq' in x) {
          only(x, ['field', 'eq'], `The filter on ${f.label}`);
          if (!typeOk(x.eq) || !allowed(x.eq)) problems.push(`${show(x.eq)} is not a value ${f.label} can have.`);
          else filters.push({ field: f.name, eq: x.eq });
        } else if ('in' in x) {
          only(x, ['field', 'in'], `The filter on ${f.label}`);
          if (!Array.isArray(x.in) || x.in.length === 0 || x.in.length > LIMITS.inValues) problems.push(`The filter on ${f.label} must list between 1 and ${LIMITS.inValues} values.`);
          else {
            const bad = x.in.filter((v: unknown) => !typeOk(v) || !allowed(v));
            if (bad.length) problems.push(`${bad.map(show).join(', ')} ${bad.length === 1 ? 'is not a value' : 'are not values'} ${f.label} can have.`);
            else filters.push({ field: f.name, in: [...(x.in as unknown[])] });
          }
        } else {
          only(x, ['field', 'gte', 'lt'], `The filter on ${f.label}`);
          if (f.type === 'text') problems.push(`${f.label} is text, so it cannot be filtered by a range.`);
          else {
            const ends = [x.gte, x.lt].filter((v) => v !== undefined);
            if (!ends.every(typeOk)) problems.push(`The range on ${f.label} must use ${f.type === 'number' ? 'numbers' : 'dates like 2026-01-31'}.`);
            else filters.push({ field: f.name, ...(x.gte !== undefined ? { gte: x.gte as number | string } : {}), ...(x.lt !== undefined ? { lt: x.lt as number | string } : {}) });
          }
        }
      }
    }
  }

  let sort: Spec['sort'];
  if (raw.sort !== undefined) {
    if (!isObj(raw.sort)) problems.push('sort must be an object.');
    else {
      only(raw.sort, ['measure', 'field', 'desc'], 'The sort');
      const desc = raw.sort.desc === true;
      if (raw.sort.desc !== undefined && typeof raw.sort.desc !== 'boolean') problems.push('sort.desc must be true or false.');
      const rawMeasures = Array.isArray(raw.measures) ? raw.measures : [];
      if (typeof raw.sort.measure === 'number' && Number.isInteger(raw.sort.measure) && raw.sort.field === undefined) {
        const m = rawMeasures[raw.sort.measure] as unknown;
        const key = isObj(m) && typeof m.op === 'string' ? measureKey({ op: m.op as Measure['op'], ...(typeof m.field === 'string' ? { field: m.field } : {}) }) : undefined;
        if (key && measures.some((x) => x.name === key)) sort = { by: key, desc };
        else problems.push('The sort names a measure that is not in the question.');
      } else if (typeof raw.sort.field === 'string' && raw.sort.measure === undefined) {
        if (groupBy.includes(raw.sort.field)) sort = { by: raw.sort.field, desc };
        else problems.push(`The sort uses ${show(raw.sort.field)}, which is not one of the groupings.`);
      } else problems.push('The sort must name either a measure or a grouping field.');
    }
  }

  let limit: number = LIMITS.rows;
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > LIMITS.rows) problems.push(`limit must be a whole number from 1 to ${LIMITS.rows}.`);
    else limit = raw.limit;
  }

  if (problems.length) return { ok: false, problems: [...new Set(problems)] };
  return { ok: true, spec: { ...(filters.length ? { filters } : {}), groupBy, measures, ...(sort ? { sort } : {}), minGroup: d.minGroup ?? 5 }, limit };
}

const list = (xs: readonly string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

export function measureLabel(m: Measure, d: Dataset): string {
  const f = d.fields.find((x) => x.name === m.field)?.label ?? m.field ?? '';
  return m.op === 'count' ? `Number of ${d.noun.many}` : `${({ sum: 'Total', avg: 'Average', min: 'Lowest', max: 'Highest', distinct: 'Distinct' } as const)[m.op]} ${f}`;
}

/** Exactly what a checked report computes, in plain English, written from the report itself. */
export function describe(s: Spec, d: Dataset, limit: number = LIMITS.rows): string {
  const label = (n: string) => d.fields.find((f) => f.name === n)?.label ?? n;
  const val = (v: unknown) => (typeof v === 'string' ? v : String(v));
  const parts: string[] = [];
  const ms = s.measures.map((m) => (m.op === 'count' ? `counted the ${d.noun.many}` : `${({ sum: 'added up', avg: 'averaged', min: 'found the lowest', max: 'found the highest', distinct: 'counted the different values of' } as const)[m.op]} ${label(m.field!)}`));
  parts.push(`Of all ${d.noun.many} in ${d.name}`);
  const fs = (s.filters ?? []).map((f) => {
    if ('eq' in f) return `${label(f.field)} is ${val(f.eq)}`;
    if ('in' in f) return `${label(f.field)} is one of ${list(f.in.map(val))}`;
    const r = f as { field: string; gte?: number | string; lt?: number | string };
    if (r.gte !== undefined && r.lt !== undefined) return `${label(f.field)} is from ${r.gte} up to but not including ${r.lt}`;
    return r.gte !== undefined ? `${label(f.field)} is ${r.gte} or more` : `${label(f.field)} is before ${r.lt}`;
  });
  let text = `${parts[0]}${fs.length ? ` where ${list(fs)}` : ''}, ${list(ms)}`;
  text += s.groupBy.length ? ` for each ${list(s.groupBy.map(label))}.` : '.';
  if (s.sort) {
    const m = s.measures.find((x) => x.name === s.sort!.by);
    text += ` Sorted by ${m ? measureLabel(m, d) : label(s.sort.by)}, ${s.sort.desc ? 'highest' : 'lowest'} first.`;
  }
  if (s.groupBy.length && limit < LIMITS.rows) text += ` Only the first ${limit} groups are shown.`;
  if (s.minGroup) text += ` Groups of fewer than ${s.minGroup} ${d.noun.many} are hidden to protect privacy.`;
  return text;
}

export interface Answer {
  readonly ok: true;
  readonly columns: readonly { readonly key: string; readonly label: string }[];
  readonly rows: readonly Record<string, unknown>[];
  /** The totals over every matching record, or null where too few records match to show them. */
  readonly totals: Readonly<Record<string, unknown>> | null;
  /** Groups not shown because they were too small, or would have revealed one that was. */
  readonly hidden: number;
  /** The matching records behind the shown groups, cut to the fields the person may see. */
  readonly records: readonly Record<string, unknown>[];
  readonly recordsTotal: number;
  readonly description: string;
  readonly spec: Spec;
  /** A sentence about what was held back, if anything was. */
  readonly note?: string;
}

export interface Refusal {
  readonly ok: false;
  readonly say: string;
  readonly problems: readonly string[];
}

const ROWS = '__rows';

/**
 * Answers a question about `rows` (the records the person is allowed to see) using the dataset's declaration.
 * The model's proposal is checked first; nothing it says runs unless the check passes.
 */
export async function ask(question: string, o: { dataset: Dataset; rows: readonly Row[]; person: Person; model: Model }): Promise<Answer | Refusal> {
  const d = o.dataset;
  const q = question.trim();
  if (!q) return { ok: false, say: 'Ask a question about your data, for example "how many by status?".', problems: [] };
  if (q.length > LIMITS.question) return { ok: false, say: `The question is ${q.length} characters long; keep it under ${LIMITS.question}.`, problems: [] };
  const schema = schemaFor(d, o.person);
  let proposed: unknown;
  try {
    proposed = await o.model.propose(q, schema);
    if (typeof proposed === 'string') proposed = JSON.parse(proposed);
  } catch {
    return { ok: false, say: 'The question could not be turned into a report. Try asking it another way, naming what to count and how to group it.', problems: [] };
  }
  const c = check(proposed, d, o.person);
  if (!c.ok) return { ok: false, say: 'That question cannot be answered from this data, so nothing was run. Try asking it another way.', problems: c.problems };

  const seen = schema.fields.map((f) => f.name);
  const visibleRows = o.rows.map((r) => Object.fromEntries(seen.filter((k) => k in r).map((k) => [k, r[k]])));
  const floor = c.spec.minGroup ?? 5;
  const { minGroup: _floor, ...unsuppressed } = c.spec;
  const r = run(visibleRows, { ...unsuppressed, measures: [...c.spec.measures, { name: ROWS, op: 'count' }] });

  let hidden = 0;
  let shown = r.rows.filter((x) => {
    const small = (x[ROWS] as number) < floor;
    if (small) hidden++;
    return !small;
  });
  if (hidden === 1 && shown.length > 0) {
    const smallest = [...shown].sort((a, b) => (a[ROWS] as number) - (b[ROWS] as number))[0]!;
    shown = shown.filter((x) => x !== smallest);
    hidden++;
  }
  const matched = (r.totals[ROWS] as number) ?? 0;
  const totalsShown = matched >= floor;
  const strip = (x: Record<string, unknown>) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== ROWS));
  const rows = shown.slice(0, c.limit).map(strip);

  const key = (x: Record<string, unknown>) => JSON.stringify(c.spec.groupBy.map((g) => x[g] ?? null));
  const keep = new Set(rows.map(key));
  const filtersOk = (x: Row) => run([x], { ...(c.spec.filters ? { filters: c.spec.filters } : {}), groupBy: [], measures: [{ name: 'n', op: 'count' }] }).totals.n === 1;
  const behind = visibleRows.filter((x) => filtersOk(x) && keep.has(key(x)));

  const notes: string[] = [];
  if (hidden) notes.push(`${hidden} ${hidden === 1 ? 'group is' : 'groups are'} hidden because ${hidden === 1 ? 'it has' : 'they have, or would reveal one that has,'} fewer than ${floor} ${d.noun.many}.`);
  if (!totalsShown) notes.push(`Fewer than ${floor} ${d.noun.many} match, so the totals are not shown.`);
  if (shown.length > c.limit) notes.push(`Only the first ${c.limit} of ${shown.length} groups are shown.`);
  return {
    ok: true,
    columns: [...c.spec.groupBy.map((g) => ({ key: g, label: d.fields.find((f) => f.name === g)!.label })), ...c.spec.measures.map((m) => ({ key: m.name, label: measureLabel(m, d) }))],
    rows,
    totals: totalsShown ? strip(r.totals) : null,
    hidden,
    records: behind.slice(0, LIMITS.records),
    recordsTotal: behind.length,
    description: describe(c.spec, d, c.limit),
    spec: c.spec,
    ...(notes.length ? { note: notes.join(' ') } : {}),
  };
}

/**
 * A deterministic stand-in for a language model, for tests and for running without one. It reads "how many",
 * "total", "average", "highest", "lowest" and "different" for measures, "by", "per" and "for each" for groupings,
 * declared values for filters, and "most" or "top N" for sorting. Canned answers can be given for exact questions,
 * to test what happens when a model proposes something it should not.
 */
export function twinModel(canned: Readonly<Record<string, unknown>> = {}): Model & { asked: { question: string; schema: Schema }[] } {
  const asked: { question: string; schema: Schema }[] = [];
  return {
    asked,
    async propose(question: string, schema: Schema): Promise<unknown> {
      asked.push({ question, schema });
      if (Object.hasOwn(canned, question)) {
        const v = canned[question];
        if (v instanceof Error) throw v;
        return v;
      }
      const q = ` ${question.toLowerCase().replace(/[?!.,]/g, ' ')} `;
      const mentions = (label: string) => q.includes(` ${label.toLowerCase()} `) || q.includes(` ${label.toLowerCase()}s `);
      const numeric = schema.fields.filter((f) => f.type === 'number' && mentions(f.label));
      const measures: { op: Measure['op']; field?: string }[] = [];
      const ops: [RegExp, Measure['op']][] = [[/ (total|sum of) /, 'sum'], [/ (average|mean) /, 'avg'], [/ (highest|largest|maximum) /, 'max'], [/ (lowest|smallest|minimum) /, 'min']];
      for (const [re, op] of ops) if (re.test(q) && numeric[0]) measures.push({ op, field: numeric[0].name });
      const distinct = / (different|distinct|unique) (\w+)/.exec(q)?.[2];
      const df = distinct && schema.fields.find((f) => mentions(f.label) && distinct.startsWith(f.label.toLowerCase().slice(0, 4)));
      if (df) measures.push({ op: 'distinct', field: df.name });
      if (/ (how many|number of|count) /.test(q) || !measures.length) measures.unshift({ op: 'count' });
      const groupBy = schema.fields.filter((f) => f.groupable && new RegExp(` (by|per|for each|each) ${f.label.toLowerCase()}s? `).test(q)).map((f) => f.name);
      const filters: Filter[] = [];
      for (const f of schema.fields) {
        const hits = (f.values ?? []).filter((v) => q.includes(` ${String(v).toLowerCase()} `));
        if (hits.length === 1) filters.push({ field: f.name, eq: hits[0] });
        else if (hits.length > 1) filters.push({ field: f.name, in: hits });
      }
      const year = / in (\d{4}) /.exec(q)?.[1];
      const dateField = schema.fields.find((f) => f.type === 'date' && f.filterable);
      if (year && dateField) filters.push({ field: dateField.name, gte: `${year}-01-01`, lt: `${Number(year) + 1}-01-01` });
      const top = / top (\d+) /.exec(q)?.[1];
      const proposal: Record<string, unknown> = { groupBy, measures };
      if (filters.length) proposal.filters = filters;
      if (groupBy.length && (top || / most /.test(q))) proposal.sort = { measure: measures.length - 1, desc: true };
      if (top) proposal.limit = Number(top);
      return proposal;
    },
  };
}
