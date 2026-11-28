/**
 * Tables that people define while the app runs. A table is a list of fields; a field has a stable `id`, a `name`
 * (a column name, safe to write in SQL), a type from a registry and the constraints that type allows. From that one
 * description this block gives four things:
 *
 * - the field type registry: text, longtext, integer, decimal, boolean, date, datetime, select, multiselect, email,
 *   url, uuid, json, each with its column type in pg, sqlite and mysql, and the checks for a value of that type;
 * - constraint checks: `checkRow` validates a row (using the validate block's schemas and its problem format, one
 *   problem per field with a path), refuses unknown fields, and `findDuplicates` finds the rows that would break a
 *   unique constraint before it is added;
 * - type conversion plans: `conversion(from, to)` says whether changing a field's type is lossless, lossy (values may
 *   be changed or refused), or impossible, with the SQL cast; `previewConversion` runs the conversion over sample
 *   values and lists the ones that would fail, so the person sees the damage before the change;
 * - the DDL plan: `createTable` and `diff(before, after)` produce ordered steps with the SQL for the dialect, each
 *   marked destructive or not (dropping a column, a lossy conversion, a new NOT NULL or UNIQUE that existing data may
 *   break), and `toMigration` wraps the steps as a migration for the migrations block, with a verify.
 *
 * Names are matched against a strict pattern and a reserved-word list; literals in DDL (defaults, options) are
 * written escaped and only from values that pass their type's check. Fields are matched between versions by `id`, so
 * a rename is a rename and not a drop plus an add. Out of scope: running the SQL, copying data between tables, and
 * foreign keys across tables.
 */
import * as v from '../validate/index.ts';
import type { Migration } from '../migrations/index.ts';

export class SchemaError extends Error {}

export type Dialect = 'pg' | 'sqlite' | 'mysql';
export type FieldType = 'text' | 'longtext' | 'integer' | 'decimal' | 'boolean' | 'date' | 'datetime' | 'select' | 'multiselect' | 'email' | 'url' | 'uuid' | 'json';

export interface Field {
  readonly id: string;
  readonly name: string;
  readonly type: FieldType;
  readonly required?: boolean;
  readonly unique?: boolean;
  readonly default?: string | number | boolean;
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
  /** For select and multiselect. */
  readonly options?: readonly string[];
  /** Digits after the point for decimal (default 2). */
  readonly scale?: number;
}
export interface Table {
  readonly name: string;
  readonly fields: readonly Field[];
}

const IDENT = /^[a-z][a-z0-9_]{0,40}$/;
const RESERVED = new Set(['select', 'insert', 'update', 'delete', 'drop', 'table', 'from', 'where', 'order', 'group', 'user', 'create', 'alter', 'index', 'primary', 'key', 'null', 'default', 'check', 'unique', 'references', 'constraint', 'column', 'and', 'or', 'not', 'in', 'is', 'like', 'join', 'on', 'as', 'union', 'limit', 'offset', 'values', 'set', 'grant', 'all', 'case', 'when', 'then', 'else', 'end', 'exists', 'having', 'distinct', 'desc', 'asc', 'by', 'to', 'with', 'into', 'trigger', 'view', 'rename']);
const MAX_FIELDS = 200;

interface TypeDef {
  readonly kind: 'string' | 'number' | 'boolean' | 'json';
  readonly sql: Record<Dialect, (f: Field) => string>;
  readonly schema: (f: Field) => v.Schema<unknown>;
  readonly allows: readonly (keyof Field)[];
}

const pgTimestamp = 'timestamptz';
const jsonOk = (): v.Schema<unknown> => ({
  check: (x, p) => {
    try {
      const s = JSON.stringify(x);
      if (s === undefined) return { ok: false, problems: [{ path: p || '(input)', code: 'type', message: 'that is not JSON' }] };
      if (s.length > 1_000_000) return { ok: false, problems: [{ path: p || '(input)', code: 'long', message: 'the JSON is too large' }] };
      return { ok: true, value: x };
    } catch {
      return { ok: false, problems: [{ path: p || '(input)', code: 'type', message: 'that is not JSON' }] };
    }
  },
  optional() {
    return this as never;
  },
});
const datetimeSchema = (): v.Schema<string> => ({
  check: (x, p) =>
    typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(x) && !Number.isNaN(Date.parse(x))
      ? { ok: true, value: x }
      : { ok: false, problems: [{ path: p || '(input)', code: 'datetime', message: `${p || 'this'} must be a date and time with a zone, like 2026-11-26T09:30:00Z` }] },
  optional() {
    return this as never;
  },
});

export const REGISTRY: Readonly<Record<FieldType, TypeDef>> = {
  text: { kind: 'string', allows: ['maxLength', 'default'], sql: { pg: (f) => `varchar(${f.maxLength ?? 255})`, sqlite: () => 'TEXT', mysql: (f) => `varchar(${f.maxLength ?? 255})` }, schema: (f) => v.text({ min: 0, max: f.maxLength ?? 255 }) },
  longtext: { kind: 'string', allows: ['maxLength', 'default'], sql: { pg: () => 'text', sqlite: () => 'TEXT', mysql: () => 'longtext' }, schema: (f) => v.text({ min: 0, max: f.maxLength ?? 100_000, trim: false }) },
  integer: { kind: 'number', allows: ['min', 'max', 'default'], sql: { pg: () => 'bigint', sqlite: () => 'INTEGER', mysql: () => 'bigint' }, schema: (f) => v.integer({ ...(f.min !== undefined ? { min: f.min } : {}), ...(f.max !== undefined ? { max: f.max } : {}) }) },
  decimal: { kind: 'number', allows: ['min', 'max', 'default', 'scale'], sql: { pg: (f) => `numeric(20,${f.scale ?? 2})`, sqlite: () => 'NUMERIC', mysql: (f) => `decimal(20,${f.scale ?? 2})` }, schema: (f) => v.number({ ...(f.min !== undefined ? { min: f.min } : {}), ...(f.max !== undefined ? { max: f.max } : {}) }) },
  boolean: { kind: 'boolean', allows: ['default'], sql: { pg: () => 'boolean', sqlite: () => 'INTEGER', mysql: () => 'tinyint(1)' }, schema: () => v.boolean() },
  date: { kind: 'string', allows: ['default'], sql: { pg: () => 'date', sqlite: () => 'TEXT', mysql: () => 'date' }, schema: () => v.date() },
  datetime: { kind: 'string', allows: ['default'], sql: { pg: () => pgTimestamp, sqlite: () => 'TEXT', mysql: () => 'datetime(3)' }, schema: () => datetimeSchema() },
  select: { kind: 'string', allows: ['options', 'default'], sql: { pg: () => 'varchar(100)', sqlite: () => 'TEXT', mysql: () => 'varchar(100)' }, schema: (f) => v.oneOf(f.options ?? []) },
  multiselect: { kind: 'json', allows: ['options'], sql: { pg: () => 'jsonb', sqlite: () => 'TEXT', mysql: () => 'json' }, schema: (f) => v.list(v.oneOf(f.options ?? []), { max: 100 }) },
  email: { kind: 'string', allows: ['default'], sql: { pg: () => 'varchar(254)', sqlite: () => 'TEXT', mysql: () => 'varchar(254)' }, schema: () => v.email() },
  url: { kind: 'string', allows: ['default'], sql: { pg: () => 'varchar(2048)', sqlite: () => 'TEXT', mysql: () => 'varchar(2048)' }, schema: () => v.text({ max: 2048, pattern: /^https?:\/\/[^\s/$.?#][^\s]*$/i, patternMessage: 'that does not look like a web address' }) },
  uuid: { kind: 'string', allows: ['default'], sql: { pg: () => 'uuid', sqlite: () => 'TEXT', mysql: () => 'char(36)' }, schema: () => v.text({ pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, patternMessage: 'that is not a UUID' }) },
  json: { kind: 'json', allows: [], sql: { pg: () => 'jsonb', sqlite: () => 'TEXT', mysql: () => 'json' }, schema: () => jsonOk() },
};

export const fieldTypes = (): FieldType[] => Object.keys(REGISTRY) as FieldType[];

/** Every problem with a table definition, empty when it is sound. */
export function checkTable(t: Table): string[] {
  const out: string[] = [];
  if (!IDENT.test(t.name) || RESERVED.has(t.name)) out.push(`table name ${JSON.stringify(String(t.name).slice(0, 40))} is not allowed (lower case letters, digits and _, starting with a letter, not a SQL word)`);
  if (t.fields.length === 0) out.push('a table needs at least one field');
  if (t.fields.length > MAX_FIELDS) out.push(`at most ${MAX_FIELDS} fields`);
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const f of t.fields) {
    const where = `field ${JSON.stringify(String(f.name).slice(0, 40))}`;
    if (!IDENT.test(f.name) || RESERVED.has(f.name)) out.push(`${where}: that name is not allowed`);
    if (names.has(f.name)) out.push(`${where}: two fields have this name`);
    names.add(f.name);
    if (typeof f.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(f.id)) out.push(`${where}: id must be 1 to 40 letters, digits, - or _`);
    if (ids.has(f.id)) out.push(`${where}: two fields have id ${f.id}`);
    ids.add(f.id);
    const td = Object.hasOwn(REGISTRY, f.type) ? REGISTRY[f.type] : undefined;
    if (!td) {
      out.push(`${where}: unknown type ${JSON.stringify(String(f.type).slice(0, 20))}`);
      continue;
    }
    for (const k of ['maxLength', 'min', 'max', 'options', 'scale', 'default'] as const) if (f[k] !== undefined && !td.allows.includes(k)) out.push(`${where}: ${k} does not apply to ${f.type}`);
    if (f.maxLength !== undefined && (!Number.isInteger(f.maxLength) || f.maxLength < 1 || f.maxLength > (f.type === 'text' ? 4000 : 1_000_000))) out.push(`${where}: maxLength is out of range`);
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) out.push(`${where}: min is above max`);
    if (f.scale !== undefined && (!Number.isInteger(f.scale) || f.scale < 0 || f.scale > 10)) out.push(`${where}: scale is 0 to 10`);
    if (f.type === 'select' || f.type === 'multiselect') {
      const o = f.options;
      if (!o || o.length === 0 || o.length > 200) out.push(`${where}: options are 1 to 200 choices`);
      else {
        if (new Set(o).size !== o.length) out.push(`${where}: two options are the same`);
        for (const x of o) if (typeof x !== 'string' || x.length < 1 || x.length > 100 || /[\u0000-\u001f\\]/.test(x)) out.push(`${where}: option ${JSON.stringify(String(x).slice(0, 20))} is not allowed`);
      }
    }
    if (f.unique && (td.kind === 'json')) out.push(`${where}: ${f.type} cannot be unique`);
    if (f.default !== undefined) {
      const r = td.schema(f).check(f.default, f.name);
      if (!r.ok) out.push(`${where}: the default ${JSON.stringify(f.default)} is not valid for the field`);
      else if (td.kind === 'boolean' && typeof f.default !== 'boolean') out.push(`${where}: the default must be true or false`);
      else if (td.kind === 'number' && typeof f.default !== 'number') out.push(`${where}: the default must be a number`);
      else if (td.kind === 'string' && typeof f.default !== 'string') out.push(`${where}: the default must be text`);
    }
  }
  return out;
}

function assertTable(t: Table): void {
  const p = checkTable(t);
  if (p.length) throw new SchemaError(p.join('; '));
}

// -------------------------------------------------------------------------------------------------------------
// Row checks

/** The checks for a row: unknown fields refused, needed fields present, each value of the right type and range. */
export function checkRow(t: Table, row: Readonly<Record<string, unknown>>, o: { partial?: boolean } = {}): v.Result<Record<string, unknown>> {
  assertTable(t);
  const problems: v.Problem[] = [];
  const out: Record<string, unknown> = {};
  const known = new Map(t.fields.map((f) => [f.name, f]));
  for (const k of Object.keys(row)) if (!known.has(k)) problems.push({ path: k, code: 'unknown', message: `${k} is not a field of ${t.name}` });
  for (const f of t.fields) {
    const raw = Object.hasOwn(row, f.name) ? row[f.name] : undefined;
    if (raw === undefined || raw === null || raw === '') {
      if (o.partial && raw === undefined) continue;
      if (f.default !== undefined && raw === undefined) {
        out[f.name] = f.default;
        continue;
      }
      if (f.required) problems.push({ path: f.name, code: 'required', message: `${f.name} is needed` });
      else out[f.name] = null;
      continue;
    }
    const r = REGISTRY[f.type].schema(f).check(raw, f.name);
    if (r.ok) out[f.name] = r.value;
    else problems.push(...r.problems);
  }
  return problems.length ? { ok: false, problems } : { ok: true, value: out };
}

/** Rows (by index) that repeat a value of a unique field, so a unique constraint can be refused before it is added. */
export function findDuplicates(t: Table, rows: readonly Readonly<Record<string, unknown>>[]): { field: string; value: unknown; rows: number[] }[] {
  const out: { field: string; value: unknown; rows: number[] }[] = [];
  for (const f of t.fields) {
    if (!f.unique) continue;
    const seen = new Map<string, number[]>();
    rows.forEach((r, i) => {
      const x = r[f.name];
      if (x === undefined || x === null || x === '') return;
      const key = typeof x === 'string' && f.type === 'email' ? x.trim().toLowerCase() : String(x);
      (seen.get(key) ?? seen.set(key, []).get(key)!).push(i);
    });
    for (const [key, at] of seen) if (at.length > 1) out.push({ field: f.name, value: key, rows: at });
  }
  return out;
}

// -------------------------------------------------------------------------------------------------------------
// Conversions

export interface Conversion {
  readonly kind: 'same' | 'lossless' | 'lossy' | 'impossible';
  readonly note: string;
  /** Which dialects can cast in place: sqlite always goes through a new column. */
  readonly cast: (col: string, d: Dialect) => string;
}

const NUMERIC: FieldType[] = ['integer', 'decimal'];
const TEXTY: FieldType[] = ['text', 'longtext', 'email', 'url', 'uuid', 'select'];

export function conversion(from: Field, to: Field): Conversion {
  const same = (note: string, kind: Conversion['kind'] = 'lossless'): Conversion => ({ kind, note, cast: (c) => c });
  const q = (c: string) => c;
  if (from.type === to.type) {
    const narrower = (to.maxLength ?? 255) < (from.maxLength ?? 255) || (to.scale ?? 2) < (from.scale ?? 2) || (to.min !== undefined && (from.min === undefined || to.min > from.min)) || (to.max !== undefined && (from.max === undefined || to.max < from.max));
    const opts = from.options && to.options && from.options.some((o) => !to.options!.includes(o));
    return narrower || opts ? same('the new limits or choices are narrower; values outside them would be refused or changed', 'lossy') : same('same type');
  }
  if (TEXTY.includes(from.type) && (to.type === 'text' || to.type === 'longtext')) return same(to.type === 'text' && (from.type === 'longtext') ? 'long values would be cut or refused' : 'text stays text', from.type === 'longtext' && to.type === 'text' ? 'lossy' : 'lossless');
  if (from.type === 'text' && ['email', 'url', 'uuid', 'select'].includes(to.type)) return same('values that do not fit the new type would be refused', 'lossy');
  if (from.type === 'integer' && to.type === 'decimal') return same('whole numbers become decimals');
  if (from.type === 'decimal' && to.type === 'integer') return same('the fraction is lost', 'lossy');
  if (NUMERIC.includes(from.type) && TEXTY.includes(to.type) && !['email', 'url', 'uuid', 'select'].includes(to.type)) return { kind: 'lossless', note: 'numbers are written out as text', cast: (c, d) => (d === 'sqlite' ? `CAST(${q(c)} AS TEXT)` : `CAST(${q(c)} AS ${d === 'mysql' ? 'char' : 'text'})`) };
  if (from.type === 'text' || from.type === 'longtext') {
    if (NUMERIC.includes(to.type)) return { kind: 'lossy', note: 'text that is not a number would fail or become empty', cast: (c, d) => `CAST(${q(c)} AS ${to.type === 'integer' ? (d === 'mysql' ? 'signed' : d === 'sqlite' ? 'INTEGER' : 'bigint') : d === 'mysql' ? `decimal(20,${to.scale ?? 2})` : d === 'sqlite' ? 'NUMERIC' : `numeric(20,${to.scale ?? 2})`})` };
    if (to.type === 'boolean') return { kind: 'lossy', note: 'only true/false/yes/no/1/0 convert', cast: (c, d) => (d === 'pg' ? `(lower(${q(c)}) IN ('true','yes','1','on'))` : `(lower(${q(c)}) IN ('true','yes','1','on'))`) };
    if (to.type === 'date') return { kind: 'lossy', note: 'text that is not a date would fail', cast: (c, d) => (d === 'sqlite' ? `date(${q(c)})` : `CAST(${q(c)} AS date)`) };
    if (to.type === 'datetime') return { kind: 'lossy', note: 'text that is not a date and time would fail', cast: (c, d) => (d === 'pg' ? `CAST(${q(c)} AS timestamptz)` : d === 'mysql' ? `CAST(${q(c)} AS datetime(3))` : q(c)) };
    if (to.type === 'json' || to.type === 'multiselect') return { kind: 'lossy', note: 'text that is not JSON would fail', cast: (c, d) => (d === 'pg' ? `CAST(${q(c)} AS jsonb)` : d === 'mysql' ? `CAST(${q(c)} AS json)` : q(c)) };
  }
  if (from.type === 'boolean' && TEXTY.includes(to.type) && ['text', 'longtext'].includes(to.type)) return { kind: 'lossless', note: 'true and false become text', cast: (c, d) => (d === 'pg' ? `CAST(${q(c)} AS text)` : `CAST(${q(c)} AS ${d === 'mysql' ? 'char' : 'TEXT'})`) };
  if (from.type === 'boolean' && to.type === 'integer') return { kind: 'lossless', note: 'true is 1, false is 0', cast: (c, d) => (d === 'pg' ? `(${q(c)})::int` : q(c)) };
  if (from.type === 'integer' && to.type === 'boolean') return { kind: 'lossy', note: 'zero is false, anything else is true', cast: (c, d) => (d === 'pg' ? `(${q(c)} <> 0)` : `(${q(c)} <> 0)`) };
  if (from.type === 'date' && to.type === 'datetime') return { kind: 'lossless', note: 'dates become midnight UTC', cast: (c, d) => (d === 'pg' ? `(${q(c)}::timestamp AT TIME ZONE 'UTC')` : d === 'mysql' ? `CAST(${q(c)} AS datetime(3))` : `${q(c)} || 'T00:00:00Z'`) };
  if (from.type === 'datetime' && to.type === 'date') return { kind: 'lossy', note: 'the time of day is lost', cast: (c, d) => (d === 'sqlite' ? `date(${q(c)})` : `CAST(${q(c)} AS date)`) };
  if ((from.type === 'date' || from.type === 'datetime') && ['text', 'longtext'].includes(to.type)) return { kind: 'lossless', note: 'dates are written out as text', cast: (c, d) => (d === 'sqlite' ? q(c) : `CAST(${q(c)} AS ${d === 'mysql' ? 'char' : 'text'})`) };
  if (from.type === 'select' && to.type === 'multiselect') return { kind: 'lossless', note: 'each choice becomes a list of one', cast: (c, d) => (d === 'pg' ? `jsonb_build_array(${q(c)})` : d === 'mysql' ? `json_array(${q(c)})` : `json_array(${q(c)})`) };
  if (from.type === 'multiselect' && to.type === 'select') return { kind: 'lossy', note: 'only the first choice is kept', cast: (c, d) => (d === 'pg' ? `(${q(c)} ->> 0)` : d === 'mysql' ? `json_unquote(json_extract(${q(c)}, '$[0]'))` : `json_extract(${q(c)}, '$[0]')`) };
  return { kind: 'impossible', note: `a ${from.type} cannot be converted to a ${to.type}; add a new field and move the data by hand`, cast: (c) => c };
}

/** The value as the new type would hold it, or why it cannot be held. */
export function convertValue(from: Field, to: Field, value: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const c = conversion(from, to);
  if (c.kind === 'impossible') return { ok: false, reason: c.note };
  let x: unknown = value;
  if (from.type === 'decimal' && to.type === 'integer' && typeof x === 'number') x = Math.trunc(x);
  else if (from.type === 'integer' && to.type === 'boolean') x = x !== 0;
  else if (from.type === 'boolean' && to.type === 'integer') x = x ? 1 : 0;
  else if (from.type === 'date' && to.type === 'datetime') x = `${String(x)}T00:00:00Z`;
  else if (from.type === 'datetime' && to.type === 'date') x = String(x).slice(0, 10);
  else if (from.type === 'select' && to.type === 'multiselect') x = [x];
  else if (from.type === 'multiselect' && to.type === 'select') x = Array.isArray(x) ? x[0] : undefined;
  else if (typeof x === 'string' && to.type === 'boolean') {
    const s = x.trim().toLowerCase();
    x = ['true', 'yes', '1', 'on'].includes(s) ? true : ['false', 'no', '0', 'off'].includes(s) ? false : undefined;
  } else if (typeof x === 'string' && (to.type === 'json' || to.type === 'multiselect')) {
    try {
      x = JSON.parse(x);
    } catch {
      return { ok: false, reason: 'not valid JSON' };
    }
  } else if ((typeof x === 'number' || typeof x === 'boolean') && ['text', 'longtext'].includes(to.type)) x = String(x);
  if (x === undefined) return { ok: false, reason: `cannot be read as ${to.type}` };
  const r = REGISTRY[to.type].schema(to).check(x, to.name);
  return r.ok ? { ok: true, value: r.value } : { ok: false, reason: r.problems[0]!.message };
}

export interface Preview {
  readonly conversion: Conversion;
  readonly total: number;
  readonly converted: number;
  readonly failures: { index: number; value: unknown; reason: string }[];
}
export function previewConversion(from: Field, to: Field, values: readonly unknown[], maxFailures = 20): Preview {
  const failures: Preview['failures'] = [];
  let converted = 0;
  let failed = 0;
  values.forEach((x, index) => {
    const r = convertValue(from, to, x);
    if (r.ok) converted++;
    else {
      failed++;
      if (failures.length < maxFailures) failures.push({ index, value: x, reason: r.reason });
    }
  });
  return { conversion: conversion(from, to), total: values.length, converted, failures: failed > failures.length ? failures : failures };
}

// -------------------------------------------------------------------------------------------------------------
// DDL

const qi = (d: Dialect, id: string) => (d === 'mysql' ? `\`${id}\`` : `"${id}"`);
const lit = (x: string | number | boolean, d: Dialect): string => {
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) throw new SchemaError('a default is not a finite number');
    return String(x);
  }
  if (typeof x === 'boolean') return d === 'pg' ? (x ? 'true' : 'false') : x ? '1' : '0';
  if (/[\u0000-\u001f\\]/.test(x)) throw new SchemaError('a text value in DDL cannot contain control characters or backslashes');
  return `'${x.replace(/'/g, "''")}'`;
};

function columnSql(t: Table, f: Field, d: Dialect): string {
  const td = REGISTRY[f.type];
  const parts = [qi(d, f.name), td.sql[d](f)];
  if (f.required) parts.push('NOT NULL');
  if (f.default !== undefined) parts.push(`DEFAULT ${lit(f.default, d)}`);
  if (f.unique) parts.push('UNIQUE');
  const checks = checksFor(t, f, d);
  if (checks.length) parts.push(`CHECK (${checks.join(' AND ')})`);
  return parts.join(' ');
}

function checksFor(_t: Table, f: Field, d: Dialect): string[] {
  const c = qi(d, f.name);
  const out: string[] = [];
  if (f.min !== undefined) out.push(`${c} >= ${lit(f.min, d)}`);
  if (f.max !== undefined) out.push(`${c} <= ${lit(f.max, d)}`);
  if (f.type === 'select' && f.options) out.push(`${c} IN (${f.options.map((o) => lit(o, d)).join(', ')})`);
  if (f.type === 'boolean' && d !== 'pg') out.push(`${c} IN (0, 1)`);
  return out;
}

export interface Step {
  readonly kind: 'create-table' | 'add-column' | 'drop-column' | 'rename-column' | 'change-type' | 'set-required' | 'drop-required' | 'set-unique' | 'drop-unique' | 'set-default' | 'drop-default' | 'set-checks' | 'drop-table';
  readonly field?: string;
  readonly sql: readonly string[];
  /** Data may be lost or refused. */
  readonly destructive: boolean;
  readonly note: string;
}

export function createTable(t: Table, d: Dialect = 'pg'): Step {
  assertTable(t);
  const cols = [`${qi(d, 'id')} ${d === 'pg' ? 'uuid PRIMARY KEY DEFAULT gen_random_uuid()' : d === 'mysql' ? 'char(36) PRIMARY KEY' : 'TEXT PRIMARY KEY'}`, ...t.fields.map((f) => columnSql(t, f, d))];
  return { kind: 'create-table', sql: [`CREATE TABLE ${qi(d, t.name)} (${cols.join(', ')})`], destructive: false, note: `create ${t.name} with ${t.fields.length} fields` };
}

export function dropTable(t: Table, d: Dialect = 'pg'): Step {
  assertTable(t);
  return { kind: 'drop-table', sql: [`DROP TABLE ${qi(d, t.name)}`], destructive: true, note: `delete ${t.name} and all its rows` };
}

const sameChecks = (a: Field, b: Field) => a.min === b.min && a.max === b.max && JSON.stringify(a.options ?? null) === JSON.stringify(b.options ?? null);

/** Ordered steps that turn `before` into `after`, matching fields by id. Throws when a change is impossible. */
export function diff(before: Table, after: Table, d: Dialect = 'pg'): Step[] {
  assertTable(before);
  assertTable(after);
  if (before.name !== after.name) throw new SchemaError('renaming a table is not part of a diff; create the new one and move the data');
  const t = qi(d, after.name);
  const steps: Step[] = [];
  const old = new Map(before.fields.map((f) => [f.id, f]));
  const now = new Map(after.fields.map((f) => [f.id, f]));
  // Drops first, so a name freed by a drop can be reused.
  for (const f of before.fields) if (!now.has(f.id)) steps.push({ kind: 'drop-column', field: f.name, sql: [`ALTER TABLE ${t} DROP COLUMN ${qi(d, f.name)}`], destructive: true, note: `delete the ${f.name} column and its values` });
  // Renames next, through temporary names when two fields swap names.
  const renames = after.fields.filter((f) => old.has(f.id) && old.get(f.id)!.name !== f.name);
  const clash = renames.filter((f) => before.fields.some((o) => o.name === f.name && o.id !== f.id && now.has(o.id)));
  for (const f of renames) {
    const o = old.get(f.id)!;
    const target = clash.includes(f) ? `${f.id.toLowerCase().replace(/[^a-z0-9_]/g, '_')}_tmp` : f.name;
    steps.push({ kind: 'rename-column', field: f.name, sql: [`ALTER TABLE ${t} RENAME COLUMN ${qi(d, o.name)} TO ${qi(d, target)}`], destructive: false, note: `rename ${o.name} to ${f.name}` });
  }
  for (const f of clash) steps.push({ kind: 'rename-column', field: f.name, sql: [`ALTER TABLE ${t} RENAME COLUMN ${qi(d, `${f.id.toLowerCase().replace(/[^a-z0-9_]/g, '_')}_tmp`)} TO ${qi(d, f.name)}`], destructive: false, note: `finish renaming to ${f.name}` });
  for (const f of after.fields) {
    const o = old.get(f.id);
    const c = qi(d, f.name);
    if (!o) {
      steps.push({ kind: 'add-column', field: f.name, sql: [`ALTER TABLE ${t} ADD COLUMN ${columnSql(after, f, d)}`], destructive: false, note: `add ${f.name} (${f.type})${f.required && f.default === undefined ? '; existing rows have no value, so the database will refuse unless the table is empty' : ''}` });
      continue;
    }
    if (o.type !== f.type) {
      const cv = conversion(o, f);
      if (cv.kind === 'impossible') throw new SchemaError(`${f.name}: ${cv.note}`);
      const tmp = `${f.name}_new`;
      if (d === 'sqlite' || !(d === 'pg' || d === 'mysql')) {
        steps.push({
          kind: 'change-type',
          field: f.name,
          sql: [`ALTER TABLE ${t} ADD COLUMN ${qi(d, tmp)} ${REGISTRY[f.type].sql[d](f)}`, `UPDATE ${t} SET ${qi(d, tmp)} = ${cv.cast(c, d)}`, `ALTER TABLE ${t} DROP COLUMN ${c}`, `ALTER TABLE ${t} RENAME COLUMN ${qi(d, tmp)} TO ${c}`],
          destructive: cv.kind === 'lossy',
          note: `${o.type} to ${f.type}: ${cv.note}`,
        });
      } else if (d === 'pg') {
        steps.push({ kind: 'change-type', field: f.name, sql: [`ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${REGISTRY[f.type].sql[d](f)} USING ${cv.cast(c, d)}`], destructive: cv.kind === 'lossy', note: `${o.type} to ${f.type}: ${cv.note}` });
      } else {
        steps.push({ kind: 'change-type', field: f.name, sql: [`ALTER TABLE ${t} MODIFY COLUMN ${c} ${REGISTRY[f.type].sql[d](f)}${f.required ? ' NOT NULL' : ''}`], destructive: cv.kind === 'lossy', note: `${o.type} to ${f.type}: ${cv.note}` });
      }
    } else if (conversion(o, f).kind === 'lossy' && (o.maxLength !== f.maxLength || o.scale !== f.scale)) {
      steps.push({ kind: 'change-type', field: f.name, sql: d === 'pg' ? [`ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${REGISTRY[f.type].sql[d](f)}`] : d === 'mysql' ? [`ALTER TABLE ${t} MODIFY COLUMN ${c} ${REGISTRY[f.type].sql[d](f)}`] : [], destructive: true, note: 'the new size is smaller; longer values would be refused' });
    } else if (o.maxLength !== f.maxLength || o.scale !== f.scale) {
      if (d !== 'sqlite') steps.push({ kind: 'change-type', field: f.name, sql: [d === 'pg' ? `ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${REGISTRY[f.type].sql[d](f)}` : `ALTER TABLE ${t} MODIFY COLUMN ${c} ${REGISTRY[f.type].sql[d](f)}`], destructive: false, note: 'the new size is larger' });
    }
    if (!o.required && f.required) steps.push({ kind: 'set-required', field: f.name, sql: [d === 'mysql' ? `ALTER TABLE ${t} MODIFY COLUMN ${c} ${REGISTRY[f.type].sql[d](f)} NOT NULL` : `ALTER TABLE ${t} ALTER COLUMN ${c} SET NOT NULL`], destructive: true, note: `${f.name} becomes required; rows with no value would block this` });
    if (o.required && !f.required) steps.push({ kind: 'drop-required', field: f.name, sql: [d === 'mysql' ? `ALTER TABLE ${t} MODIFY COLUMN ${c} ${REGISTRY[f.type].sql[d](f)} NULL` : `ALTER TABLE ${t} ALTER COLUMN ${c} DROP NOT NULL`], destructive: false, note: `${f.name} is optional again` });
    if (!o.unique && f.unique) steps.push({ kind: 'set-unique', field: f.name, sql: [`CREATE UNIQUE INDEX ${qi(d, `${after.name}_${f.name}_uq`)} ON ${t} (${c})`], destructive: true, note: `${f.name} must be unique; repeated values would block this` });
    if (o.unique && !f.unique) steps.push({ kind: 'drop-unique', field: f.name, sql: [d === 'mysql' ? `DROP INDEX ${qi(d, `${after.name}_${f.name}_uq`)} ON ${t}` : `DROP INDEX ${qi(d, `${after.name}_${f.name}_uq`)}`], destructive: false, note: `${f.name} no longer has to be unique` });
    if (o.default !== f.default) steps.push(f.default === undefined ? { kind: 'drop-default', field: f.name, sql: [d === 'sqlite' ? '' : `ALTER TABLE ${t} ALTER COLUMN ${c} DROP DEFAULT`].filter(Boolean), destructive: false, note: `${f.name} has no default` } : { kind: 'set-default', field: f.name, sql: d === 'sqlite' ? [] : [`ALTER TABLE ${t} ALTER COLUMN ${c} SET DEFAULT ${lit(f.default, d)}`], destructive: false, note: `${f.name} defaults to ${String(f.default)}` });
    if (!sameChecks(o, f) && o.type === f.type) steps.push({ kind: 'set-checks', field: f.name, sql: d === 'pg' ? [`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${qi(d, `${after.name}_${f.name}_chk`)}`, ...(checksFor(after, f, d).length ? [`ALTER TABLE ${t} ADD CONSTRAINT ${qi(d, `${after.name}_${f.name}_chk`)} CHECK (${checksFor(after, f, d).join(' AND ')})`] : [])] : [], destructive: true, note: `${f.name}: the allowed range or choices changed; existing values outside them would block this` });
  }
  return steps;
}

/** The migration for a list of steps. `db.exec` is given each statement in order; the verify checks the table exists. */
export function toMigration<Db extends { exec(sql: string): Promise<unknown> }>(id: string, description: string, steps: readonly Step[], verify?: (db: Db) => Promise<boolean | string>): Migration<Db> {
  const statements = steps.flatMap((s) => s.sql);
  return {
    id,
    description,
    up: async (db, lease) => {
      for (const s of statements) {
        await lease.renew();
        await db.exec(s);
      }
    },
    ...(verify ? { verify } : {}),
  };
}

/** Steps that need a person's yes: anything destructive. */
export const needsApproval = (steps: readonly Step[]): Step[] => steps.filter((s) => s.destructive);
