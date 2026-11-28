/**
 * Forms as data. A form definition is plain JSON: pages of fields, each with a type (text, long text, number,
 * whole number, email, date, yes/no, one choice, many choices, rating, hidden, calculated), its own limits, and
 * optional rules written as spreadsheet formulas over other fields ("{age} >= 18", "{country} = \"US\""): when a
 * field or a whole page shows, when a field is required, and how a calculated field is worked out
 * ("{qty} * {price}"). Rules run on the formula-engine block, so they mean what they mean in a spreadsheet. A
 * hidden field's answer is dropped and counts as blank in every other rule, which can hide more fields, so the
 * evaluation repeats until nothing changes (and stops with an error if rules contradict each other). Answers
 * are checked with the validate block, every problem at once, worded with the field's label. Pages are walked in
 * order skipping hidden ones. Submissions are routed by rules to destinations (email, webhook, queue), with a
 * confirmation message that fills in answers. Query-string prefill is read per field's own type, ignoring what
 * does not fit. `checkForm` finds authoring mistakes before anyone fills the form in: duplicate ids, rules that name
 * fields that do not exist, formulas that do not parse, circular calculations, choices without options.
 *
 * Out of scope: rendering, file upload fields, repeating groups, saving partial answers (the drafts block), and
 * sending to the destinations (the caller does that with `route`'s answer).
 */
import { calc, display, isError, parse as parseFormula, serialOf, Workbook, FormulaSyntaxError, type Scalar } from '../formula-engine/index.ts';
import { boolean, date, email, integer, number, oneOf, text, type Problem, type Schema } from '../validate/index.ts';

export type Expr = string;
export type FieldType = 'text' | 'longtext' | 'number' | 'integer' | 'email' | 'date' | 'boolean' | 'select' | 'multiselect' | 'rating' | 'hidden' | 'calculated';
export interface Option {
  readonly value: string;
  readonly label: string;
}
export interface Field {
  readonly id: string;
  readonly type: FieldType;
  readonly label: string;
  readonly help?: string;
  /** Required always (true) or when a rule says so. A required yes/no must be yes. */
  readonly required?: boolean | Expr;
  readonly visibleWhen?: Expr;
  readonly options?: readonly Option[];
  readonly min?: number | string;
  readonly max?: number | string;
  readonly pattern?: string;
  readonly patternMessage?: string;
  readonly formula?: Expr;
  /** The query parameter that fills this field; false turns prefill off. Default: the field's id. */
  readonly prefill?: string | false;
  readonly default?: string | number | boolean;
}
export interface Page {
  readonly id: string;
  readonly title: string;
  readonly visibleWhen?: Expr;
  readonly fields: readonly Field[];
}
export interface Destination {
  readonly kind: 'email' | 'webhook' | 'queue';
  readonly target: string;
}
export interface Route {
  readonly id: string;
  /** Absent: always. */
  readonly when?: Expr;
  /** Used only when no other route matched. */
  readonly otherwise?: boolean;
  readonly to: Destination;
}
export interface FormDef {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly pages: readonly Page[];
  readonly routes?: readonly Route[];
  /** "all" sends to every matching route, "first" to the first one. Default "all". */
  readonly routing?: 'all' | 'first';
  readonly confirmation?: string;
}

export type Answer = string | number | boolean | readonly string[];
export type Answers = Readonly<Record<string, unknown>>;
export type Cleaned = Record<string, Answer>;

export class FormError extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'FormError';
  }
}

const ID = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const TYPES: readonly FieldType[] = ['text', 'longtext', 'number', 'integer', 'email', 'date', 'boolean', 'select', 'multiselect', 'rating', 'hidden', 'calculated'];
export const FIELD_TYPES = TYPES;

const fieldsOf = (f: FormDef): { field: Field; page: Page }[] => f.pages.flatMap((page) => page.fields.map((field) => ({ field, page })));

/** "{id}" in an expression becomes a reference to that field's cell; text inside quotes is left alone. */
function translate(expr: string, rows: ReadonlyMap<string, number>): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (ch === '"') inStr = !inStr;
    if (!inStr && ch === '{') {
      const end = expr.indexOf('}', i);
      const id = end < 0 ? '' : expr.slice(i + 1, end).trim();
      out += rows.has(id) ? `$A$${rows.get(id)}` : '#REF!';
      i = end < 0 ? expr.length : end;
    } else out += ch;
  }
  return out.startsWith('=') ? out : `=${out}`;
}
const refsIn = (expr: string): string[] => {
  const out: string[] = [];
  let inStr = false;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '"') inStr = !inStr;
    if (!inStr && expr[i] === '{') {
      const end = expr.indexOf('}', i);
      out.push(end < 0 ? '' : expr.slice(i + 1, end).trim());
      i = end < 0 ? expr.length : end;
    }
  }
  return out;
};

/** Everything wrong with a form definition, in words. An empty list means it is safe to publish. */
export function checkForm(form: FormDef): string[] {
  const out: string[] = [];
  if (!ID.test(form.id.replace(/-/g, '_'))) out.push(`the form id "${form.id}" is letters, digits, dash or underscore`);
  if (!form.pages.length) out.push('a form needs at least one page');
  const seenPages = new Set<string>();
  const ids = new Set<string>();
  const all = fieldsOf(form);
  for (const p of form.pages) {
    if (seenPages.has(p.id)) out.push(`page id "${p.id}" is used twice`);
    seenPages.add(p.id);
    if (!p.fields.length) out.push(`page "${p.id}" has no fields`);
  }
  for (const { field: f } of all) {
    if (!ID.test(f.id)) out.push(`field id "${f.id}" is not allowed (letters, digits, underscore; starts with a letter)`);
    if (ids.has(f.id)) out.push(`field id "${f.id}" is used twice`);
    ids.add(f.id);
  }
  const check = (where: string, expr: string | undefined) => {
    if (expr === undefined) return;
    for (const r of refsIn(expr)) if (!ids.has(r)) out.push(`${where} names the field "${r}", which does not exist`);
    try {
      parseFormula(translate(expr, new Map([...ids].map((x, i) => [x, i + 1]))));
    } catch (e) {
      if (!(e instanceof FormulaSyntaxError)) throw e;
      out.push(`${where} is not a valid rule: ${e.message}`);
    }
  };
  for (const p of form.pages) check(`the visibility of page "${p.id}"`, p.visibleWhen);
  for (const { field: f } of all) {
    if (!TYPES.includes(f.type)) out.push(`field "${f.id}" has unknown type "${f.type}"`);
    if (!f.label.trim()) out.push(`field "${f.id}" needs a label`);
    check(`the visibility of "${f.id}"`, f.visibleWhen);
    if (typeof f.required === 'string') check(`the required rule of "${f.id}"`, f.required);
    if (f.type === 'calculated') {
      if (!f.formula) out.push(`calculated field "${f.id}" needs a formula`);
      else {
        check(`the formula of "${f.id}"`, f.formula);
        if (refsIn(f.formula).includes(f.id)) out.push(`calculated field "${f.id}" uses itself`);
      }
      if (f.required) out.push(`calculated field "${f.id}" cannot be required`);
    } else if (f.formula) out.push(`field "${f.id}" is not calculated but has a formula`);
    if (f.type === 'select' || f.type === 'multiselect') {
      if (!f.options?.length) out.push(`field "${f.id}" needs options`);
      else {
        const vals = f.options.map((o) => o.value);
        if (new Set(vals).size !== vals.length) out.push(`field "${f.id}" has the same option value twice`);
        if (vals.some((v) => !v.length)) out.push(`field "${f.id}" has an empty option value`);
      }
    } else if (f.options) out.push(`field "${f.id}" has options but is not a choice`);
    if (typeof f.min === 'number' && typeof f.max === 'number' && f.min > f.max) out.push(`field "${f.id}" has min above max`);
    if (f.pattern !== undefined) {
      if (f.pattern.length > 200) out.push(`the pattern of "${f.id}" is too long`);
      else
        try {
          new RegExp(f.pattern);
        } catch {
          out.push(`the pattern of "${f.id}" is not a valid pattern`);
        }
    }
  }
  const rids = new Set<string>();
  for (const r of form.routes ?? []) {
    if (rids.has(r.id)) out.push(`route id "${r.id}" is used twice`);
    rids.add(r.id);
    check(`route "${r.id}"`, r.when);
    if (r.when !== undefined && r.otherwise) out.push(`route "${r.id}" has a rule and is also the fallback`);
    if (!r.to.target.trim()) out.push(`route "${r.id}" has no target`);
    if (r.to.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.to.target)) out.push(`route "${r.id}" sends to "${r.to.target}", which is not an email address`);
    if (r.to.kind === 'webhook' && !/^https:\/\//i.test(r.to.target)) out.push(`route "${r.id}" posts to "${r.to.target}": webhooks must be https`);
  }
  for (const m of form.confirmation?.matchAll(/\{([^}]*)\}/g) ?? []) if (!ids.has(m[1]!.trim())) out.push(`the confirmation names the field "${m[1]}", which does not exist`);
  // circular calculations
  const wb = new Workbook();
  const rows = new Map(all.map(({ field }, i) => [field.id, i + 1]));
  all.forEach(({ field }, i) => {
    if (field.type === 'calculated' && field.formula) wb.set('F', `A${i + 1}`, translate(field.formula, rows));
    else wb.set('F', `A${i + 1}`, 0);
  });
  if (wb.cycles().length) out.push(`calculated fields depend on each other in a circle: ${wb.cycles().map((c) => all[Number(/(\d+)$/.exec(c)![1]) - 1]!.field.id).join(', ')}`);
  return out;
}

// ------------------------------------------------------------------------------------------------- answers

const isBlank = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/** What a field's answer looks like inside a rule: numbers as numbers, dates as serials, many choices as one comma-joined text. */
function cellValue(f: Field, v: unknown): Scalar {
  if (isBlank(v)) return null;
  switch (f.type) {
    case 'number':
    case 'integer':
    case 'rating': {
      const n = typeof v === 'string' ? Number(v.trim()) : v;
      return typeof n === 'number' && Number.isFinite(n) ? n : String(v);
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      return v === 'true' || v === 'on' || v === '1' ? true : v === 'false' || v === 'off' || v === '0' ? false : String(v);
    }
    case 'date': {
      const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
      return m ? serialOf(Number(m[1]), Number(m[2]), Number(m[3])) : String(v);
    }
    case 'multiselect':
      return Array.isArray(v) ? v.map(String).join(',') : String(v);
    default:
      return typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? v : String(v);
  }
}

export interface State {
  readonly visible: Readonly<Record<string, boolean>>;
  readonly required: Readonly<Record<string, boolean>>;
  readonly pageVisible: Readonly<Record<string, boolean>>;
  /** Calculated values and the answers of visible fields as rules see them. */
  readonly values: Readonly<Record<string, Scalar>>;
  /** Answers given for fields that are hidden (or calculated) and so dropped. */
  readonly ignored: readonly string[];
  /** A rule that did not work (the field stays visible; the rule is not applied). */
  readonly warnings: readonly string[];
}

/** Work out what shows, what is required and what is calculated for these answers. Repeats until hiding settles. */
export function evaluate(form: FormDef, answers: Answers): State {
  const all = fieldsOf(form);
  const rows = new Map(all.map(({ field }, i) => [field.id, i + 1]));
  const n = all.length;
  let eff: Record<string, unknown> = {};
  for (const { field: f } of all) if (f.type !== 'calculated' && Object.hasOwn(answers, f.id) && !isBlank(answers[f.id])) eff[f.id] = answers[f.id];
  for (const { field: f } of all) if (f.type !== 'calculated' && !Object.hasOwn(eff, f.id) && f.default !== undefined) eff[f.id] = f.default;
  for (let pass = 0; pass <= n + 1; pass++) {
    const wb = new Workbook();
    wb.addSheet('F');
    all.forEach(({ field: f }, i) => {
      const r = i + 1;
      if (f.type === 'calculated' && f.formula) wb.set('F', `A${r}`, translate(f.formula, rows));
      else wb.set('F', `A${r}`, cellValue(f, eff[f.id]) as string | number | boolean | null, { literal: true });
      if (f.visibleWhen !== undefined) wb.set('F', `B${r}`, translate(f.visibleWhen, rows));
      if (typeof f.required === 'string') wb.set('F', `C${r}`, translate(f.required, rows));
    });
    form.pages.forEach((p, i) => {
      if (p.visibleWhen !== undefined) wb.set('F', `D${i + 1}`, translate(p.visibleWhen, rows));
    });
    const warnings: string[] = [];
    const truth = (cell: string, what: string, dflt: boolean): boolean => {
      const v = wb.get('F', cell);
      if (isError(v)) {
        warnings.push(`${what} could not be worked out (${v.code}); it was ignored`);
        return dflt;
      }
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      if (typeof v === 'string') return /^true$/i.test(v);
      return false;
    };
    const pageVisible: Record<string, boolean> = {};
    form.pages.forEach((p, i) => (pageVisible[p.id] = p.visibleWhen === undefined ? true : truth(`D${i + 1}`, `the rule for page "${p.id}"`, true)));
    const visible: Record<string, boolean> = {};
    const required: Record<string, boolean> = {};
    all.forEach(({ field: f, page }, i) => {
      const r = i + 1;
      visible[f.id] = pageVisible[page.id]! && f.type !== 'hidden' ? (f.visibleWhen === undefined ? true : truth(`B${r}`, `the rule for "${f.id}"`, true)) : pageVisible[page.id]! && f.type === 'hidden';
      required[f.id] = f.type === 'calculated' ? false : f.required === true ? true : typeof f.required === 'string' ? truth(`C${r}`, `the required rule of "${f.id}"`, false) : false;
    });
    const next: Record<string, unknown> = {};
    for (const { field: f } of all) if (f.type !== 'calculated' && visible[f.id] && Object.hasOwn(eff, f.id)) next[f.id] = eff[f.id];
    const same = Object.keys(next).length === Object.keys(eff).length && Object.keys(next).every((k) => next[k] === eff[k]);
    if (same || pass === n + 1) {
      if (!same) throw new FormError('the rules of this form did not settle');
      const values: Record<string, Scalar> = {};
      all.forEach(({ field: f }, i) => {
        if (f.type === 'calculated') {
          const v = visible[f.id] ? wb.get('F', `A${i + 1}`) : null;
          if (isError(v)) warnings.push(`"${f.id}" could not be calculated (${v.code})`);
          values[f.id] = isError(v) ? null : v;
        } else if (visible[f.id] && Object.hasOwn(eff, f.id)) values[f.id] = wb.get('F', `A${i + 1}`);
      });
      const ignored = all.filter(({ field: f }) => Object.hasOwn(answers, f.id) && !isBlank(answers[f.id]) && (f.type === 'calculated' || !visible[f.id])).map(({ field: f }) => f.id);
      return { visible, required, pageVisible, values, ignored, warnings };
    }
    eff = next;
  }
  throw new FormError('the rules of this form did not settle');
}

function schemaFor(f: Field): Schema<unknown> {
  const lim = (x: number | string | undefined) => (typeof x === 'number' ? x : undefined);
  switch (f.type) {
    case 'text':
    case 'hidden': {
      const rx = f.pattern !== undefined ? new RegExp(f.pattern) : undefined;
      return text({ max: lim(f.max) ?? 500, ...(lim(f.min) !== undefined ? { min: lim(f.min)! } : {}), ...(rx ? { pattern: rx, ...(f.patternMessage ? { patternMessage: f.patternMessage } : {}) } : {}) });
    }
    case 'longtext':
      return text({ max: lim(f.max) ?? 10_000, ...(lim(f.min) !== undefined ? { min: lim(f.min)! } : {}) });
    case 'number':
      return number({ ...(lim(f.min) !== undefined ? { min: lim(f.min)! } : {}), ...(lim(f.max) !== undefined ? { max: lim(f.max)! } : {}) });
    case 'integer':
      return integer({ ...(lim(f.min) !== undefined ? { min: lim(f.min)! } : {}), ...(lim(f.max) !== undefined ? { max: lim(f.max)! } : {}) });
    case 'rating':
      return integer({ min: lim(f.min) ?? 1, max: lim(f.max) ?? 5 });
    case 'email':
      return email();
    case 'date':
      return date();
    case 'boolean':
      return boolean();
    case 'select':
      return oneOf((f.options ?? []).map((o) => o.value) as readonly string[]);
    default:
      return text();
  }
}

const label = (f: Field, p: Problem): Problem => {
  const lead = `${p.path.replace(/\[\d+\]$/, '')} `;
  return { ...p, path: p.path, message: p.message.startsWith(lead) ? `${f.label}${p.message.slice(lead.length - 1)}` : p.message };
};

export type Checked = { readonly ok: true; readonly values: Cleaned; readonly state: State } | { readonly ok: false; readonly problems: readonly Problem[]; readonly state: State };

/** Check answers for some fields (a page, or the whole form) and return the cleaned values of what is shown. */
function check(form: FormDef, answers: Answers, only?: ReadonlySet<string>): Checked {
  const state = evaluate(form, answers);
  const known = new Set(fieldsOf(form).map((x) => x.field.id));
  const problems: Problem[] = [];
  const values: Cleaned = {};
  for (const k of Object.keys(answers)) if (!known.has(k) && (!only || only.size === 0)) problems.push({ path: k, code: 'unknown', message: `${k} is not a field of this form` });
  for (const { field: f } of fieldsOf(form)) {
    if (only && !only.has(f.id)) continue;
    if (f.type === 'calculated') {
      const v = state.values[f.id];
      if (v !== null && v !== undefined) Object.defineProperty(values, f.id, { value: v as Answer, enumerable: true, writable: true, configurable: true });
      continue;
    }
    if (!state.visible[f.id]) continue;
    const raw = Object.hasOwn(answers, f.id) ? answers[f.id] : f.default;
    if (isBlank(raw)) {
      if (state.required[f.id]) problems.push({ path: f.id, code: 'required', message: f.type === 'boolean' ? `${f.label} must be ticked` : `${f.label} is needed` });
      continue;
    }
    if (f.type === 'multiselect') {
      const opts = new Set((f.options ?? []).map((o) => o.value));
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) problems.push({ path: f.id, code: 'type', message: `${f.label} must be a list of choices` });
      else {
        const bad = raw.filter((x) => !opts.has(x));
        const lo = typeof f.min === 'number' ? f.min : undefined;
        const hi = typeof f.max === 'number' ? f.max : undefined;
        if (bad.length) problems.push({ path: f.id, code: 'choice', message: `${f.label}: "${String(bad[0]).slice(0, 40)}" is not one of the choices` });
        else if (new Set(raw).size !== raw.length) problems.push({ path: f.id, code: 'duplicate', message: `${f.label} lists a choice twice` });
        else if (lo !== undefined && raw.length < lo) problems.push({ path: f.id, code: 'min', message: `${f.label} needs at least ${lo} choices` });
        else if (hi !== undefined && raw.length > hi) problems.push({ path: f.id, code: 'max', message: `${f.label} can have at most ${hi} choices` });
        else Object.defineProperty(values, f.id, { value: [...raw] as string[], enumerable: true, writable: true, configurable: true });
      }
      continue;
    }
    const r = schemaFor(f).check(raw, f.id);
    if (!r.ok) {
      problems.push(...r.problems.map((p) => label(f, p)));
      continue;
    }
    if (f.type === 'boolean' && f.required === true && r.value !== true) {
      problems.push({ path: f.id, code: 'required', message: `${f.label} must be ticked` });
      continue;
    }
    if (f.type === 'boolean' && state.required[f.id] && r.value !== true) {
      problems.push({ path: f.id, code: 'required', message: `${f.label} must be ticked` });
      continue;
    }
    if (f.type === 'date') {
      const lo = typeof f.min === 'string' ? f.min : undefined;
      const hi = typeof f.max === 'string' ? f.max : undefined;
      if (lo !== undefined && (r.value as string) < lo) {
        problems.push({ path: f.id, code: 'min', message: `${f.label} must be on or after ${lo}` });
        continue;
      }
      if (hi !== undefined && (r.value as string) > hi) {
        problems.push({ path: f.id, code: 'max', message: `${f.label} must be on or before ${hi}` });
        continue;
      }
    }
    Object.defineProperty(values, f.id, { value: r.value as Answer, enumerable: true, writable: true, configurable: true });
  }
  return problems.length ? { ok: false, problems, state } : { ok: true, values, state };
}

/** Check the whole form. */
export const validateForm = (form: FormDef, answers: Answers): Checked => check(form, answers);

/** Check only the fields on one page, for multi-page forms that validate as people go. Unknown answers are not reported here. */
export function validatePage(form: FormDef, answers: Answers, pageId: string): Checked {
  const page = form.pages.find((p) => p.id === pageId);
  if (!page) throw new FormError(`no page "${pageId}"`);
  return check(form, answers, new Set(page.fields.map((f) => f.id)));
}

/** The pages that show for these answers, in order. */
export function visiblePages(form: FormDef, answers: Answers): Page[] {
  const s = evaluate(form, answers);
  return form.pages.filter((p) => s.pageVisible[p.id] && p.fields.some((f) => s.visible[f.id] || f.type === 'calculated'));
}

/** The page after this one that has something to show, or null at the end. `from` undefined asks for the first page. */
export function nextPage(form: FormDef, answers: Answers, from?: string): Page | null {
  const pages = visiblePages(form, answers);
  if (from === undefined) return pages[0] ?? null;
  const at = form.pages.findIndex((p) => p.id === from);
  if (at < 0) throw new FormError(`no page "${from}"`);
  return pages.find((p) => form.pages.indexOf(p) > at) ?? null;
}
export function previousPage(form: FormDef, answers: Answers, from: string): Page | null {
  const pages = visiblePages(form, answers);
  const at = form.pages.findIndex((p) => p.id === from);
  if (at < 0) throw new FormError(`no page "${from}"`);
  return [...pages].reverse().find((p) => form.pages.indexOf(p) < at) ?? null;
}

// ------------------------------------------------------------------------------------------------ routing

export interface Submission {
  readonly values: Cleaned;
  readonly destinations: readonly (Destination & { route: string })[];
  readonly confirmation: string;
}

const asCell = (v: Answer | undefined): Scalar => (v === undefined ? null : Array.isArray(v) ? v.join(',') : (v as Scalar));

/** Which destinations a submission goes to: every matching route (or the first), else the fallback routes. */
export function route(form: FormDef, values: Cleaned): (Destination & { route: string })[] {
  const all = fieldsOf(form);
  const rows = new Map(all.map(({ field }, i) => [field.id, i + 1]));
  const cells: Record<string, Scalar> = {};
  all.forEach(({ field }, i) => (cells[`A${i + 1}`] = asCell(values[field.id])));
  const hits: (Destination & { route: string })[] = [];
  const fallback: (Destination & { route: string })[] = [];
  for (const r of form.routes ?? []) {
    if (r.otherwise) {
      fallback.push({ ...r.to, route: r.id });
      continue;
    }
    if (r.when !== undefined) {
      const v = calc(translate(r.when, rows), cells);
      if (!(v === true || (typeof v === 'number' && v !== 0))) continue;
    }
    hits.push({ ...r.to, route: r.id });
    if (form.routing === 'first') break;
  }
  return hits.length ? hits : fallback.slice(0, form.routing === 'first' ? 1 : undefined);
}

/** The confirmation text with answers filled in ({name}); unknown or empty answers become nothing. */
export function confirmation(form: FormDef, values: Cleaned): string {
  return (form.confirmation ?? 'Thank you. Your answers were received.').replace(/\{([^}]*)\}/g, (_m, id: string) => {
    const v = values[id.trim()];
    return v === undefined ? '' : display(asCell(v));
  });
}

/** Check, then route: the one call a submit handler needs. */
export function submit(form: FormDef, answers: Answers): { ok: true; submission: Submission } | { ok: false; problems: readonly Problem[]; state: State } {
  const r = validateForm(form, answers);
  if (!r.ok) return { ok: false, problems: r.problems, state: r.state };
  return { ok: true, submission: { values: r.values, destinations: route(form, r.values), confirmation: confirmation(form, r.values) } };
}

// ------------------------------------------------------------------------------------------------- prefill

/** Answers from query parameters, each read by its field's type; anything that does not fit is ignored and listed. */
export function prefill(form: FormDef, params: Readonly<Record<string, string>>): { answers: Record<string, Answer>; ignored: string[] } {
  const answers: Record<string, Answer> = {};
  const used = new Set<string>();
  for (const { field: f } of fieldsOf(form)) {
    if (f.prefill === false || f.type === 'calculated') continue;
    const key = f.prefill ?? f.id;
    if (!Object.hasOwn(params, key)) continue;
    used.add(key);
    const raw = params[key]!;
    if (raw.length > 500) continue;
    let v: Answer | undefined;
    switch (f.type) {
      case 'number': v = /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : undefined; break;
      case 'integer':
      case 'rating': v = /^-?\d+$/.test(raw.trim()) ? Number(raw) : undefined; break;
      case 'boolean': v = raw === 'true' || raw === '1' || raw === 'on' ? true : raw === 'false' || raw === '0' || raw === 'off' ? false : undefined; break;
      case 'select': v = f.options?.some((o) => o.value === raw) ? raw : undefined; break;
      case 'multiselect': { const xs = raw.split(',').map((x) => x.trim()).filter(Boolean); v = xs.length && xs.every((x) => f.options?.some((o) => o.value === x)) && new Set(xs).size === xs.length ? xs : undefined; break; }
      case 'date': v = date().check(raw, f.id).ok ? raw : undefined; break;
      case 'email': v = email().check(raw, f.id).ok ? raw.trim() : undefined; break;
      default: v = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim() || undefined;
    }
    if (v === undefined) used.delete(key);
    else answers[f.id] = v;
  }
  return { answers, ignored: Object.keys(params).filter((k) => !used.has(k)).sort() };
}
