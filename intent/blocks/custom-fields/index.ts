/**
 * Typed custom fields that an organisation adds to any kind of record (a contact, a ticket, an asset) without a
 * schema change. A field definition says its kind (text, long text, number, whole number, yes/no, date, date and
 * time, one choice, several choices, email, https link), its limits, and where it takes part: whether it is searched,
 * filtered on, reported on, who may read it and who may write it. From the definitions this block gives:
 *  - validation of a record's values, built on the validate block, with every problem at once and a path like
 *    "custom.warranty_end", refusing keys that are not defined and values the definition does not allow;
 *  - safe evolution: a key is never reused, a kind never changes, a choice that is dropped is retired (old records
 *    keep it, new writes cannot choose it), and a tightening change reports exactly which records it would break;
 *  - storage as typed rows (one row per value, a column per type, one row per chosen option), and the way back;
 *  - indexing hints (which columns to index and how) derived from how each field is used;
 *  - search text with weights, simple filters, and the dimensions and measures a report can offer;
 *  - read and write permission by role, with redaction of what a reader may not see.
 *
 * Patterns given by users are refused when they could run for exponential time. Out of scope: computed fields,
 * file fields, and per-tenant storage (the registry is in memory; rows and hints are returned for the caller's store).
 */
import { boolean, date, email, list, number, oneOf, text } from '../validate/index.ts';
import type { Problem, Result, Schema } from '../validate/index.ts';

export type FieldKind = 'text' | 'longtext' | 'number' | 'integer' | 'boolean' | 'date' | 'datetime' | 'select' | 'multiselect' | 'email' | 'url';
export const FIELD_KINDS: readonly FieldKind[] = ['text', 'longtext', 'number', 'integer', 'boolean', 'date', 'datetime', 'select', 'multiselect', 'email', 'url'];

export class FieldError extends Error {
  constructor(why: string) {
    super(why);
  }
}

export interface Choice {
  readonly value: string;
  readonly label: string;
  /** A retired choice stays valid on records that already have it and cannot be chosen again. */
  readonly retired?: boolean;
}

export interface FieldDef {
  readonly key: string;
  readonly recordKind: string;
  readonly kind: FieldKind;
  readonly label: string;
  readonly help?: string;
  readonly required: boolean;
  readonly unique: boolean;
  readonly choices?: readonly Choice[];
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: string;
  readonly default?: unknown;
  readonly searchable: boolean;
  /** Weight in search ranking when searchable. */
  readonly searchWeight: number;
  readonly filterable: boolean;
  readonly reportable: boolean;
  /** Roles that may read it; undefined is everyone. */
  readonly readRoles?: readonly string[];
  readonly writeRoles?: readonly string[];
  readonly archived: boolean;
  readonly createdAt: number;
}

export type FieldInput = {
  key: string;
  recordKind: string;
  kind: FieldKind;
  label: string;
  help?: string;
  required?: boolean;
  unique?: boolean;
  choices?: readonly (string | Choice)[];
  min?: number;
  max?: number;
  pattern?: string;
  default?: unknown;
  searchable?: boolean;
  searchWeight?: number;
  filterable?: boolean;
  reportable?: boolean;
  readRoles?: readonly string[];
  writeRoles?: readonly string[];
};

export type Values = Readonly<Record<string, unknown>>;

const RESERVED = new Set(['id', 'kind', 'type', 'created_at', 'updated_at', 'deleted_at', 'owner', 'tenant', 'version', 'custom', 'constructor', 'prototype', 'proto']);

/** Refuses patterns with nested or adjacent unbounded repeats, the shape behind catastrophic backtracking. */
export function checkPattern(p: string): RegExp {
  if (p.length > 200) throw new FieldError('a pattern may be at most 200 characters');
  if (/(\([^)]*[+*][^)]*\)|\[[^\]]*\])[+*{]/.test(p) && /\([^)]*[+*}][^)]*\)[+*{]/.test(p)) throw new FieldError('that pattern repeats a repeat, which can take exponential time');
  if (/\\[1-9]/.test(p)) throw new FieldError('back-references are not allowed in a pattern');
  if (/\(\?[<=!]/.test(p) && /[+*]/.test(p) && /\(\?<?[=!]/.test(p)) throw new FieldError('look-around is not allowed in a pattern');
  try {
    return new RegExp(p, 'u');
  } catch {
    throw new FieldError('that pattern is not a valid regular expression');
  }
}

const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function datetime(): Schema<string> {
  const base = text({ trim: true });
  return {
    ...base,
    check: (v, p): Result<string> => {
      const label = p.split(/[.[]/).pop() || 'this';
      if (typeof v !== 'string' || !DATETIME.test(v.trim())) return { ok: false, problems: [{ path: p, code: 'datetime', message: `${label} must be a date and time like 2026-11-26T14:30:00Z` }] };
      const t = Date.parse(v.trim());
      if (Number.isNaN(t)) return { ok: false, problems: [{ path: p, code: 'datetime', message: `${v} is not a real date and time` }] };
      return { ok: true, value: new Date(t).toISOString() };
    },
  };
}

function url(): Schema<string> {
  return text({ max: 2048, pattern: /^https:\/\/[^\s/]+(\/\S*)?$/, patternMessage: 'must be an https link' });
}

/** The validate schema for one field's value, honouring retired choices unless `keep` says the value is unchanged. */
export function valueSchema(d: FieldDef, keep?: unknown): Schema<unknown> {
  const o: { min?: number; max?: number } = {};
  if (d.min !== undefined) o.min = d.min;
  if (d.max !== undefined) o.max = d.max;
  const live = (d.choices ?? []).filter((c) => !c.retired).map((c) => c.value);
  const kept = (d.choices ?? []).filter((c) => c.retired && (keep === c.value || (Array.isArray(keep) && keep.includes(c.value)))).map((c) => c.value);
  switch (d.kind) {
    case 'text': return text({ ...o, min: o.min ?? 1, ...(d.pattern ? { pattern: checkPattern(d.pattern) } : {}) });
    case 'longtext': return text({ ...o, min: o.min ?? 1, max: o.max ?? 20_000 });
    case 'number': return number(o);
    case 'integer': return number({ ...o, integer: true });
    case 'boolean': return boolean();
    case 'date': return date();
    case 'datetime': return datetime();
    case 'email': return email();
    case 'url': return url();
    case 'select': return oneOf([...live, ...kept]);
    case 'multiselect': return list(oneOf([...live, ...kept]), { min: d.min ?? 0, max: d.max ?? 50 });
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class CustomFields {
  private readonly defs = new Map<string, FieldDef>();
  private readonly now: () => number;

  constructor(o: { now?: () => number } = {}) {
    this.now = o.now ?? Date.now;
  }

  private id = (kind: string, key: string) => `${kind}\u0000${key}`;

  define(input: FieldInput): FieldDef {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(input.key)) throw new FieldError('a key is lower case letters, digits and underscores, starting with a letter, up to 40 characters');
    if (RESERVED.has(input.key)) throw new FieldError(`${input.key} is reserved`);
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(input.recordKind)) throw new FieldError('a record kind is lower case words, up to 40 characters');
    if (!FIELD_KINDS.includes(input.kind)) throw new FieldError(`the kind must be one of ${FIELD_KINDS.join(', ')}`);
    if (this.defs.has(this.id(input.recordKind, input.key))) throw new FieldError(`${input.recordKind} already has a field ${input.key} (keys are never reused, even after archiving)`);
    if (!input.label.trim() || input.label.length > 100) throw new FieldError('a label is 1 to 100 characters');
    const choices = input.choices?.map((c) => (typeof c === 'string' ? { value: c, label: c } : c));
    if (input.kind === 'select' || input.kind === 'multiselect') {
      if (!choices || choices.length === 0) throw new FieldError('a choice field needs at least one choice');
      if (new Set(choices.map((c) => c.value)).size !== choices.length) throw new FieldError('choice values must be different from each other');
      for (const c of choices) if (!/^[A-Za-z0-9_-]{1,40}$/.test(c.value)) throw new FieldError(`the choice value ${JSON.stringify(c.value)} is not letters, digits, hyphen or underscore`);
    } else if (choices) throw new FieldError('only select and multiselect fields have choices');
    if (input.min !== undefined && input.max !== undefined && input.min > input.max) throw new FieldError('min is more than max');
    if (input.pattern !== undefined) {
      if (input.kind !== 'text') throw new FieldError('only a text field has a pattern');
      checkPattern(input.pattern);
    }
    if (input.unique && (input.kind === 'multiselect' || input.kind === 'longtext' || input.kind === 'boolean')) throw new FieldError(`a ${input.kind} field cannot be unique`);
    const def: FieldDef = {
      key: input.key, recordKind: input.recordKind, kind: input.kind, label: input.label.trim(),
      ...(input.help ? { help: input.help } : {}),
      required: input.required ?? false, unique: input.unique ?? false,
      ...(choices ? { choices } : {}),
      ...(input.min === undefined ? {} : { min: input.min }), ...(input.max === undefined ? {} : { max: input.max }),
      ...(input.pattern === undefined ? {} : { pattern: input.pattern }),
      ...(input.default === undefined ? {} : { default: input.default }),
      searchable: input.searchable ?? (input.kind === 'text' || input.kind === 'longtext'),
      searchWeight: input.searchWeight ?? 1,
      filterable: input.filterable ?? !(input.kind === 'longtext'),
      reportable: input.reportable ?? ['number', 'integer', 'boolean', 'date', 'select'].includes(input.kind),
      ...(input.readRoles ? { readRoles: input.readRoles } : {}), ...(input.writeRoles ? { writeRoles: input.writeRoles } : {}),
      archived: false, createdAt: this.now(),
    };
    if (def.default !== undefined) {
      const r = valueSchema(def).check(def.default, def.key);
      if (!r.ok) throw new FieldError(`the default is not valid: ${r.problems[0]!.message}`);
    }
    this.defs.set(this.id(def.recordKind, def.key), def);
    return def;
  }

  get(recordKind: string, key: string): FieldDef | undefined {
    return this.defs.get(this.id(recordKind, key));
  }

  list(recordKind: string, o: { includeArchived?: boolean } = {}): FieldDef[] {
    return [...this.defs.values()].filter((d) => d.recordKind === recordKind && (o.includeArchived || !d.archived)).sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
  }

  /**
   * Which stored records would break under `patch`: each with the field and why. Used before a tightening change;
   * `update` calls it when given the existing records.
   */
  preview(recordKind: string, key: string, patch: Partial<Pick<FieldInput, 'label' | 'help' | 'required' | 'min' | 'max' | 'choices' | 'searchable' | 'filterable' | 'reportable' | 'readRoles' | 'writeRoles'>>, existing: Iterable<{ id: string; values: Values }> = []): { recordId: string; problem: string }[] {
    const next = this.merged(this.must(recordKind, key), patch);
    const out: { recordId: string; problem: string }[] = [];
    for (const rec of existing) {
      const v = Object.hasOwn(rec.values, key) ? rec.values[key] : undefined;
      if (v === undefined || v === null) {
        if (next.required && next.default === undefined) out.push({ recordId: rec.id, problem: `${key} would become required but this record has none` });
        continue;
      }
      const r = valueSchema(next, v).check(v, key);
      if (!r.ok) out.push({ recordId: rec.id, problem: r.problems[0]!.message });
    }
    return out;
  }

  private must(recordKind: string, key: string): FieldDef {
    const d = this.get(recordKind, key);
    if (!d) throw new FieldError(`${recordKind} has no field ${key}`);
    return d;
  }

  private merged(d: FieldDef, patch: Parameters<CustomFields['preview']>[2]): FieldDef {
    let choices = d.choices;
    if (patch.choices) {
      if (d.kind !== 'select' && d.kind !== 'multiselect') throw new FieldError('only select and multiselect fields have choices');
      const given = patch.choices.map((c) => (typeof c === 'string' ? { value: c, label: c } : c));
      if (new Set(given.map((c) => c.value)).size !== given.length) throw new FieldError('choice values must be different from each other');
      for (const c of given) if (!/^[A-Za-z0-9_-]{1,40}$/.test(c.value)) throw new FieldError(`the choice value ${JSON.stringify(c.value)} is not letters, digits, hyphen or underscore`);
      // A choice left out of the new list is retired, never deleted, so stored values stay readable.
      const gone = (d.choices ?? []).filter((c) => !given.some((g) => g.value === c.value)).map((c) => ({ ...c, retired: true }));
      choices = [...given, ...gone];
      if (choices.every((c) => c.retired)) throw new FieldError('a choice field needs at least one live choice');
    }
    const { choices: _c, ...rest } = patch;
    void _c;
    return { ...d, ...(rest as object), ...(choices ? { choices } : {}) } as FieldDef;
  }

  /**
   * Changes a field. The kind, key and record kind never change. Tightening (required, narrower limits, dropped
   * choices) is refused when `existing` records would break, unless `force` is set; the problems are in the error.
   */
  update(recordKind: string, key: string, patch: Parameters<CustomFields['preview']>[2], o: { existing?: Iterable<{ id: string; values: Values }>; force?: boolean } = {}): FieldDef {
    const d = this.must(recordKind, key);
    if (d.archived) throw new FieldError(`${key} is archived`);
    if ('kind' in patch || 'key' in patch || 'recordKind' in patch) throw new FieldError('the key, kind and record kind of a field never change; add a new field instead');
    const next = this.merged(d, patch);
    if (next.min !== undefined && next.max !== undefined && next.min > next.max) throw new FieldError('min is more than max');
    const broken = this.preview(recordKind, key, patch, o.existing ?? []);
    if (broken.length && !o.force) throw new FieldError(`${broken.length} record(s) would break, for example ${broken[0]!.recordId}: ${broken[0]!.problem}`);
    this.defs.set(this.id(recordKind, key), next);
    return next;
  }

  /** Hides a field from new writes and lists; the key stays taken and stored values stay. */
  archive(recordKind: string, key: string, archived = true): FieldDef {
    const d = { ...this.must(recordKind, key), archived };
    this.defs.set(this.id(recordKind, key), d);
    return d;
  }

  // ------------------------------------------------------------ validation

  /**
   * Checks the custom values of a record. Every problem is returned at once with the path "custom.<key>". With
   * `partial` (an update that sends only some fields) a missing required field is not a problem. `existing` is
   * the record's current values, so an unchanged retired choice is allowed. A null clears an optional field.
   * `roles` limits writing to the fields those roles may write.
   */
  validate(recordKind: string, input: Record<string, unknown>, o: { partial?: boolean; existing?: Values; roles?: readonly string[] } = {}): Result<Values> {
    const problems: Problem[] = [];
    const out: Record<string, unknown> = {};
    const p = (key: string) => `custom.${key}`;
    for (const key of Object.keys(input)) {
      const d = this.get(recordKind, key);
      if (!d || d.archived) problems.push({ path: p(key), code: 'unknown', message: `${key} is not a field of ${recordKind}` });
    }
    for (const d of this.list(recordKind)) {
      const given = Object.hasOwn(input, d.key);
      let v = given ? input[d.key] : undefined;
      if (given && o.roles && d.writeRoles && !d.writeRoles.some((r) => o.roles!.includes(r))) {
        problems.push({ path: p(d.key), code: 'forbidden', message: `you may not change ${d.label}` });
        continue;
      }
      if (!given && !o.partial && d.default !== undefined) v = d.default;
      if (v === undefined && !given && o.partial) continue;
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0 && d.kind === 'multiselect' && !(d.min && d.min > 0))) {
        if (d.required && (!o.partial || given) && !(o.partial && !given)) problems.push({ path: p(d.key), code: 'required', message: `${d.label} is needed` });
        else if (given && v === null) out[d.key] = null;
        continue;
      }
      const prior = o.existing && Object.hasOwn(o.existing, d.key) ? o.existing[d.key] : undefined;
      const r = valueSchema(d, same(prior, v) ? v : undefined).check(v, p(d.key));
      if (r.ok) out[d.key] = r.value;
      else problems.push(...r.problems.map((x) => ({ ...x, message: x.message.replace(new RegExp(`^${d.key}\\b`), d.label) })));
    }
    return problems.length ? { ok: false, problems } : { ok: true, value: out };
  }

  /** Records among `others` that already hold the same value for a unique field. */
  uniqueClash(recordKind: string, values: Values, others: Iterable<{ id: string; values: Values }>, selfId?: string): { key: string; recordId: string }[] {
    const out: { key: string; recordId: string }[] = [];
    for (const d of this.list(recordKind).filter((x) => x.unique)) {
      const v = values[d.key];
      if (v === undefined || v === null) continue;
      const norm = (x: unknown) => (typeof x === 'string' ? x.toLowerCase() : x);
      for (const r of others) if (r.id !== selfId && norm(r.values[d.key]) === norm(v)) out.push({ key: d.key, recordId: r.id });
    }
    return out;
  }

  // ------------------------------------------------------------ roles

  /** The values a reader with `roles` may see: fields with read roles the reader lacks are dropped. */
  redact(recordKind: string, values: Values, roles: readonly string[]): Values {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      const d = this.get(recordKind, k);
      if (d?.readRoles && !d.readRoles.some((r) => roles.includes(r))) continue;
      out[k] = v;
    }
    return out;
  }

  // ------------------------------------------------------------ storage, indexing, search, reports

  /** Typed rows for a record's values: one per value, one per chosen option, in stable order. */
  toRows(recordKind: string, recordId: string, values: Values): ValueRow[] {
    const rows: ValueRow[] = [];
    for (const d of this.list(recordKind, { includeArchived: true })) {
      const v = values[d.key];
      if (v === undefined || v === null) continue;
      const base = { recordKind, recordId, key: d.key, valueText: null, valueNumber: null, valueBool: null, valueDate: null } as const;
      if (d.kind === 'number' || d.kind === 'integer') rows.push({ ...base, valueNumber: v as number, position: 0 });
      else if (d.kind === 'boolean') rows.push({ ...base, valueBool: v as boolean, position: 0 });
      else if (d.kind === 'date' || d.kind === 'datetime') rows.push({ ...base, valueDate: v as string, position: 0 });
      else if (d.kind === 'multiselect') (v as string[]).forEach((x, i) => rows.push({ ...base, valueText: x, position: i }));
      else rows.push({ ...base, valueText: v as string, position: 0 });
    }
    return rows;
  }

  /** The values back from rows (for one record). */
  fromRows(recordKind: string, rows: readonly ValueRow[]): Values {
    const out: Record<string, unknown> = {};
    for (const r of [...rows].sort((a, b) => a.position - b.position)) {
      const d = this.get(recordKind, r.key);
      if (!d) continue;
      const v = d.kind === 'number' || d.kind === 'integer' ? r.valueNumber : d.kind === 'boolean' ? r.valueBool : d.kind === 'date' || d.kind === 'datetime' ? r.valueDate : r.valueText;
      if (v === null) continue;
      if (d.kind === 'multiselect') ((out[d.key] ??= []) as unknown[]).push(v);
      else out[d.key] = v;
    }
    return out;
  }

  /** What to index for the way each field is used. */
  indexHints(recordKind: string): IndexHint[] {
    const hints: IndexHint[] = [];
    for (const d of this.list(recordKind)) {
      const column = d.kind === 'number' || d.kind === 'integer' ? 'value_number' : d.kind === 'boolean' ? 'value_bool' : d.kind === 'date' || d.kind === 'datetime' ? 'value_date' : 'value_text';
      if (d.unique) hints.push({ key: d.key, column, index: 'unique', reason: 'values must be unique' });
      else if (d.filterable && (d.kind === 'boolean')) hints.push({ key: d.key, column, index: 'partial-true', reason: 'filtered on; a yes/no field is best indexed for its rarer value' });
      else if (d.filterable && column !== 'value_text') hints.push({ key: d.key, column, index: 'btree', reason: 'filtered on, with ranges' });
      else if (d.filterable && ['select', 'multiselect', 'email', 'url'].includes(d.kind)) hints.push({ key: d.key, column, index: 'btree', reason: 'filtered on by exact value' });
      else if (d.filterable && d.searchable) hints.push({ key: d.key, column, index: 'btree', reason: 'filtered on by exact value' });
      if (d.searchable && (d.kind === 'text' || d.kind === 'longtext')) hints.push({ key: d.key, column, index: 'fulltext', reason: 'searched' });
      if (d.reportable && !hints.some((h) => h.key === d.key && h.index === 'btree')) hints.push({ key: d.key, column, index: 'btree', reason: 'grouped in reports' });
    }
    return hints;
  }

  /** Text for the search block: each searchable field with its weight; choices are searched by their labels. */
  searchFields(recordKind: string, values: Values): { field: string; text: string; weight: number }[] {
    const out: { field: string; text: string; weight: number }[] = [];
    for (const d of this.list(recordKind).filter((x) => x.searchable)) {
      const v = values[d.key];
      if (v === undefined || v === null) continue;
      const label = (x: unknown) => d.choices?.find((c) => c.value === x)?.label ?? String(x);
      out.push({ field: `custom.${d.key}`, text: Array.isArray(v) ? v.map(label).join(' ') : label(v), weight: d.searchWeight });
    }
    return out;
  }

  /** Whether a record's values satisfy a filter on a filterable field. */
  matches(recordKind: string, values: Values, f: Filter): boolean {
    const d = this.must(recordKind, f.key);
    if (!d.filterable) throw new FieldError(`${f.key} is not filterable`);
    const v = Object.hasOwn(values, f.key) ? values[f.key] : undefined;
    if (f.op === 'isEmpty') return v === undefined || v === null || (Array.isArray(v) && v.length === 0);
    if (v === undefined || v === null) return f.op === 'ne';
    const has = (x: unknown) => (Array.isArray(v) ? v.includes(x) : v === x);
    switch (f.op) {
      case 'eq': return has(f.value);
      case 'ne': return !has(f.value);
      case 'in': return Array.isArray(f.value) && f.value.some(has);
      case 'contains': return typeof v === 'string' ? v.toLowerCase().includes(String(f.value).toLowerCase()) : Array.isArray(v) && v.includes(f.value);
      case 'gt': return (v as number | string) > (f.value as number | string);
      case 'gte': return (v as number | string) >= (f.value as number | string);
      case 'lt': return (v as number | string) < (f.value as number | string);
      case 'lte': return (v as number | string) <= (f.value as number | string);
    }
  }

  /** What a report may group by and total, from the fields marked reportable. */
  reportFields(recordKind: string): { dimensions: { key: string; label: string; kind: FieldKind }[]; measures: { key: string; label: string; aggregates: string[] }[] } {
    const dims: { key: string; label: string; kind: FieldKind }[] = [];
    const measures: { key: string; label: string; aggregates: string[] }[] = [];
    for (const d of this.list(recordKind).filter((x) => x.reportable)) {
      if (d.kind === 'number' || d.kind === 'integer') measures.push({ key: `custom.${d.key}`, label: d.label, aggregates: ['count', 'sum', 'avg', 'min', 'max'] });
      else if (['boolean', 'date', 'select', 'datetime', 'multiselect'].includes(d.kind)) dims.push({ key: `custom.${d.key}`, label: d.label, kind: d.kind });
    }
    return { dimensions: dims, measures };
  }
}

export interface ValueRow {
  readonly recordKind: string;
  readonly recordId: string;
  readonly key: string;
  readonly valueText: string | null;
  readonly valueNumber: number | null;
  readonly valueBool: boolean | null;
  readonly valueDate: string | null;
  readonly position: number;
}

export interface IndexHint {
  readonly key: string;
  readonly column: 'value_text' | 'value_number' | 'value_bool' | 'value_date';
  readonly index: 'unique' | 'btree' | 'fulltext' | 'partial-true';
  readonly reason: string;
}

export interface Filter {
  readonly key: string;
  readonly op: 'eq' | 'ne' | 'in' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'isEmpty';
  readonly value?: unknown;
}
