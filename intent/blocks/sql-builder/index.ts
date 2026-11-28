/**
 * Two halves of one rule, that no text from a person ever becomes SQL: a builder that makes parameterised
 * statements from declared tables, and a checker that decides whether SQL somebody wrote is safe to run read-only.
 *
 * The builder works from the query block's collections (a table is a collection, a column a field; a field marked
 * sensitive is never selected, filtered, grouped or sorted on unless asked). Table and column names are never
 * taken from the caller as text: each must be one the declaration names, and is then written quoted for the
 * dialect (pg, sqlite or mysql); values only ever travel in the parameter list, as $1, $2 (pg) or ? (others), type
 * checked against the column; operators, functions and join kinds come from fixed lists; limits are whole numbers
 * within a cap; lists have a size cap; an UPDATE or DELETE without a condition is refused. `selectSql` takes a plain
 * JSON description (from, columns, joins, where, groupBy, having, orderBy, limit), which is what a no-code app sends;
 * `planToSql` turns a plan from the query block's own small language into the same.
 *
 * The checker reads SQL text with a tokenizer that treats the dialects the same way, by refusing what they read
 * differently: comments (including MySQL's executable ones), backslashes and E'' strings, dollar quoting,
 * non-ASCII outside quotes, bracketed names, `:=` and `@`. What remains must be one SELECT (or WITH ... SELECT, or
 * VALUES) statement: a second statement, any write, SELECT INTO, locking clauses and the other keywords that change
 * state are refused wherever they appear; every table must be on the allow list (a name qualified with a schema
 * such as pg_catalog is a different name; CTE names are allowed where they are defined); every function call must be
 * on the function list and never on the never list (pg_sleep, file and network functions, set_config and the
 * like); sensitive columns may not be named and `*` is refused when it would reveal them. Cost caps: statement
 * length, number of joins and tables, subquery depth, a required LIMIT within a cap and an offset cap, no cross
 * joins unless allowed; `limitTo` clamps or adds the outer LIMIT, and `checkExplain` refuses a plan whose estimated
 * cost or rows (from EXPLAIN (FORMAT JSON)) are over the caps.
 *
 * Out of scope: running the SQL, row-level security (the database's job), and SQL dialects beyond reading them for
 * safety; when the checker cannot tell whether something is safe, it says no.
 */
import type { Collection, Plan } from '../query/index.ts';

export class SqlError extends Error {
  constructor(why: string) {
    super(why);
  }
}
export class UnsafeSql extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`this SQL is not allowed: ${problems.join('; ')}`);
    this.problems = problems;
  }
}

export type Dialect = 'pg' | 'sqlite' | 'mysql';
export interface Built {
  readonly text: string;
  readonly params: readonly (string | number | boolean | null)[];
}

// ---------------------------------------------------------------------------------------------------------------
// The builder

export type Op = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'contains' | 'startsWith' | 'in' | 'notIn' | 'isNull' | 'notNull' | 'between';
export type Scalar = string | number | boolean | Date;
export type Where =
  | { readonly and: readonly Where[] }
  | { readonly or: readonly Where[] }
  | { readonly not: Where }
  | { readonly column: string; readonly op: Op; readonly value?: Scalar | readonly Scalar[] };
export type Agg = 'count' | 'sum' | 'avg' | 'min' | 'max';
export type ColumnSpec = string | { readonly fn: Agg; readonly column?: string; readonly as?: string; readonly distinct?: boolean };
export interface JoinSpec {
  readonly table: string;
  /** Two columns, one from a table already in the query, one from this table: "orders.customer_id", "customers.id". */
  readonly on: readonly [string, string];
  readonly type?: 'inner' | 'left';
}
export interface SelectSpec {
  readonly from: string;
  readonly columns?: readonly ColumnSpec[];
  readonly joins?: readonly JoinSpec[];
  readonly where?: Where;
  readonly groupBy?: readonly string[];
  readonly having?: { readonly fn: Agg; readonly column?: string; readonly op: '=' | '!=' | '<' | '<=' | '>' | '>='; readonly value: number };
  readonly orderBy?: readonly { readonly column: string; readonly dir?: 'asc' | 'desc' }[];
  readonly limit?: number;
  readonly offset?: number;
  readonly distinct?: boolean;
}

export interface BuilderOptions {
  readonly dialect?: Dialect;
  /** Largest LIMIT, and the default one (default 1000 / 100). */
  readonly maxLimit?: number;
  readonly defaultLimit?: number;
  readonly maxOffset?: number;
  readonly maxIn?: number;
  readonly maxJoins?: number;
  readonly maxConditions?: number;
  /** Allow sensitive fields to be used. */
  readonly allowSensitive?: boolean;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const OPS: Record<string, string> = { '=': '=', '!=': '<>', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };

class Ctx {
  readonly params: (string | number | boolean | null)[] = [];
  conditions = 0;
  readonly dialect: Dialect;
  constructor(d: Dialect) {
    this.dialect = d;
  }
  bind(v: string | number | boolean | null): string {
    this.params.push(v);
    return this.dialect === 'pg' ? `$${this.params.length}` : '?';
  }
}

const quote = (d: Dialect, id: string): string => {
  if (!IDENT.test(id)) throw new SqlError(`${JSON.stringify(id.slice(0, 40))} is not a name this builder will write`);
  return d === 'mysql' ? `\`${id}\`` : `"${id}"`;
};

/** A table of the declaration and the names its columns go by in one query. */
interface Scope {
  readonly tables: readonly Collection[];
  readonly o: Required<Omit<BuilderOptions, 'dialect'>> & { dialect: Dialect };
}

function resolve(s: Scope, name: string, what: string): { table: Collection; column: string; type: 'string' | 'number' | 'boolean' | 'date' } {
  const parts = name.split('.');
  if (parts.length > 2 || parts.some((p) => p === '')) throw new SqlError(`${what} ${JSON.stringify(name.slice(0, 60))} is not a column`);
  const column = parts[parts.length - 1]!;
  let table: Collection | undefined;
  if (parts.length === 2) {
    table = s.tables.find((t) => t.name === parts[0]);
    if (!table) throw new SqlError(`${what} ${name}: ${parts[0]} is not in this query`);
  } else {
    const hits = s.tables.filter((t) => Object.hasOwn(t.fields, column));
    if (hits.length > 1) throw new SqlError(`${what} ${column} is in more than one table (${hits.map((h) => h.name).join(', ')}); say which`);
    table = hits[0];
    if (!table) throw new SqlError(`${what} ${JSON.stringify(column.slice(0, 60))} is not a column of ${s.tables.map((t) => t.name).join(', ')}`);
  }
  if (!Object.hasOwn(table.fields, column)) throw new SqlError(`${table.name} has no column ${JSON.stringify(column.slice(0, 60))}`);
  const f = table.fields[column]!;
  if (f.sensitive && !s.o.allowSensitive) throw new SqlError(`${table.name}.${column} is sensitive and cannot be used here`);
  return { table, column, type: f.type };
}

const ref = (s: Scope, r: { table: Collection; column: string }) => `${quote(s.o.dialect, r.table.name)}.${quote(s.o.dialect, r.column)}`;

function value(ctx: Ctx, type: 'string' | 'number' | 'boolean' | 'date', v: unknown, what: string): string {
  let out: string | number | boolean;
  if (type === 'number') {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new SqlError(`${what} is a number; ${JSON.stringify(String(v).slice(0, 40))} is not`);
    out = v;
  } else if (type === 'boolean') {
    if (typeof v !== 'boolean') throw new SqlError(`${what} is true or false`);
    out = v;
  } else if (type === 'date') {
    const iso = v instanceof Date ? (Number.isNaN(v.getTime()) ? '' : v.toISOString()) : typeof v === 'string' ? v : '';
    if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(iso) || Number.isNaN(Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso))) throw new SqlError(`${what} is a date like 2026-03-01 or 2026-03-01T12:00:00Z`);
    out = iso;
  } else {
    if (typeof v !== 'string') throw new SqlError(`${what} is text`);
    if (v.length > 10_000) throw new SqlError(`${what} is longer than 10000 characters`);
    if (v.includes('\u0000')) throw new SqlError(`${what} contains a null character`);
    out = v;
  }
  return ctx.bind(out);
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function where(s: Scope, ctx: Ctx, w: Where, depth = 0): string {
  if (depth > 8) throw new SqlError('the condition is nested too deeply');
  if (++ctx.conditions > s.o.maxConditions) throw new SqlError(`at most ${s.o.maxConditions} conditions`);
  if ('and' in w || 'or' in w) {
    const list = 'and' in w ? w.and : w.or;
    if (!Array.isArray(list) || list.length === 0) throw new SqlError('and and or need at least one condition');
    return `(${list.map((x) => where(s, ctx, x, depth + 1)).join('and' in w ? ' AND ' : ' OR ')})`;
  }
  if ('not' in w) return `(NOT ${where(s, ctx, w.not, depth + 1)})`;
  if (typeof w !== 'object' || w === null || typeof w.column !== 'string') throw new SqlError('a condition names a column, an operator and a value');
  const c = resolve(s, w.column, 'column');
  const col = ref(s, c);
  const label = `${c.table.name}.${c.column}`;
  const op = w.op;
  if (op === 'isNull') return `${col} IS NULL`;
  if (op === 'notNull') return `${col} IS NOT NULL`;
  if (Object.hasOwn(OPS, op)) {
    if ((c.type === 'boolean') && op !== '=' && op !== '!=') throw new SqlError(`${label} is true or false; it only compares with = and !=`);
    return `${col} ${OPS[op]} ${value(ctx, c.type, w.value, label)}`;
  }
  if (op === 'contains' || op === 'startsWith') {
    if (c.type !== 'string') throw new SqlError(`${label} is not text, so ${op} does not apply`);
    if (typeof w.value !== 'string') throw new SqlError(`${label}: ${op} needs text`);
    const p = ctx.bind(op === 'contains' ? `%${likeEscape(w.value)}%` : `${likeEscape(w.value)}%`);
    return ctx.dialect === 'pg' ? `${col} ILIKE ${p} ESCAPE '\\'` : `${col} LIKE ${p} ESCAPE '\\'`;
  }
  if (op === 'in' || op === 'notIn') {
    const list = w.value;
    if (!Array.isArray(list) || list.length === 0 || list.length > s.o.maxIn) throw new SqlError(`${op} needs a list of 1 to ${s.o.maxIn} values`);
    return `${col} ${op === 'in' ? 'IN' : 'NOT IN'} (${list.map((v) => value(ctx, c.type, v, label)).join(', ')})`;
  }
  if (op === 'between') {
    const list = w.value;
    if (!Array.isArray(list) || list.length !== 2) throw new SqlError('between needs two values');
    if (c.type === 'boolean') throw new SqlError(`${label} is true or false; between does not apply`);
    return `${col} BETWEEN ${value(ctx, c.type, list[0], label)} AND ${value(ctx, c.type, list[1], label)}`;
  }
  throw new SqlError(`unknown operator ${JSON.stringify(String(op).slice(0, 20))}`);
}

function whole(v: unknown, what: string, max: number, min = 0): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new SqlError(`${what} is a whole number from ${min} to ${max}`);
  return v;
}

const AGGS = new Set(['count', 'sum', 'avg', 'min', 'max']);

/** SELECT from a JSON description, with every name checked against the declaration and every value a parameter. */
export function selectSql(spec: SelectSpec, collections: readonly Collection[], o: BuilderOptions = {}): Built {
  const opts = { dialect: o.dialect ?? 'pg', maxLimit: o.maxLimit ?? 1000, defaultLimit: o.defaultLimit ?? 100, maxOffset: o.maxOffset ?? 100_000, maxIn: o.maxIn ?? 500, maxJoins: o.maxJoins ?? 4, maxConditions: o.maxConditions ?? 50, allowSensitive: o.allowSensitive ?? false } as const;
  const ctx = new Ctx(opts.dialect);
  const find = (n: string) => {
    const t = collections.find((c) => c.name === n);
    if (!t) throw new SqlError(`there is no table ${JSON.stringify(String(n).slice(0, 60))}; the tables are ${collections.map((c) => c.name).join(', ')}`);
    return t;
  };
  const from = find(spec.from);
  const tables: Collection[] = [from];
  const joinSql: string[] = [];
  const joins = spec.joins ?? [];
  if (joins.length > opts.maxJoins) throw new SqlError(`at most ${opts.maxJoins} joins`);
  for (const j of joins) {
    const t = find(j.table);
    if (tables.includes(t)) throw new SqlError(`${t.name} is already in the query`);
    tables.push(t);
    const sc: Scope = { tables, o: opts };
    if (!Array.isArray(j.on) || j.on.length !== 2) throw new SqlError('a join says which two columns match');
    const a = resolve(sc, j.on[0], 'join column');
    const b = resolve(sc, j.on[1], 'join column');
    if (a.table === b.table || (a.table !== t && b.table !== t)) throw new SqlError(`a join on ${t.name} matches a column of ${t.name} with a column of a table already in the query`);
    if (a.type !== b.type) throw new SqlError(`${a.table.name}.${a.column} (${a.type}) and ${b.table.name}.${b.column} (${b.type}) are not the same kind of value`);
    const kind = j.type === 'left' ? 'LEFT JOIN' : j.type === undefined || j.type === 'inner' ? 'INNER JOIN' : (() => { throw new SqlError('a join is inner or left'); })();
    joinSql.push(`${kind} ${quote(opts.dialect, t.name)} ON ${ref(sc, a)} = ${ref(sc, b)}`);
  }
  const s: Scope = { tables, o: opts };
  const sel: string[] = [];
  const aliases = new Set<string>();
  const cols: readonly ColumnSpec[] = spec.columns?.length ? spec.columns : Object.keys(from.fields).filter((f) => !from.fields[f]!.sensitive || opts.allowSensitive);
  if (cols.length > 100) throw new SqlError('at most 100 columns');
  for (const c of cols) {
    if (typeof c === 'string') {
      const r = resolve(s, c, 'column');
      sel.push(ref(s, r));
    } else {
      if (!AGGS.has(c.fn)) throw new SqlError(`unknown function ${JSON.stringify(String(c.fn).slice(0, 20))}`);
      let inner: string;
      if (c.column === undefined || c.column === '*') {
        if (c.fn !== 'count') throw new SqlError(`${c.fn} needs a column`);
        inner = '*';
      } else {
        const r = resolve(s, c.column, 'column');
        if ((c.fn === 'sum' || c.fn === 'avg') && r.type !== 'number') throw new SqlError(`${c.fn} needs a number column; ${r.table.name}.${r.column} is ${r.type}`);
        inner = `${c.distinct ? 'DISTINCT ' : ''}${ref(s, r)}`;
      }
      const alias = c.as ?? (c.column && c.column !== '*' ? `${c.fn}_${c.column.split('.').pop()}` : c.fn);
      if (!IDENT.test(alias)) throw new SqlError(`${JSON.stringify(alias.slice(0, 40))} is not a name for a result column`);
      if (aliases.has(alias)) throw new SqlError(`two result columns are called ${alias}`);
      aliases.add(alias);
      sel.push(`${c.fn.toUpperCase()}(${inner}) AS ${quote(opts.dialect, alias)}`);
    }
  }
  const hasAgg = cols.some((c) => typeof c !== 'string');
  const group = (spec.groupBy ?? []).map((g) => ref(s, resolve(s, g, 'group column')));
  if (hasAgg && cols.some((c) => typeof c === 'string')) {
    // Plain columns next to aggregates must be grouped, or the database would refuse (or pick a row at random).
    for (const c of cols) if (typeof c === 'string' && !group.includes(ref(s, resolve(s, c, 'column')))) throw new SqlError(`${c} is selected next to an aggregate, so it must be in groupBy`);
  }
  let text = `SELECT ${spec.distinct ? 'DISTINCT ' : ''}${sel.join(', ')} FROM ${quote(opts.dialect, from.name)}`;
  if (joinSql.length) text += ` ${joinSql.join(' ')}`;
  if (spec.where) text += ` WHERE ${where(s, ctx, spec.where)}`;
  if (group.length) text += ` GROUP BY ${group.join(', ')}`;
  if (spec.having) {
    const h = spec.having;
    if (!AGGS.has(h.fn) || !Object.hasOwn(OPS, h.op)) throw new SqlError('having needs an aggregate and a comparison');
    if (typeof h.value !== 'number' || !Number.isFinite(h.value)) throw new SqlError('having compares with a number');
    let inner = '*';
    if (h.column !== undefined && h.column !== '*') {
      const r = resolve(s, h.column, 'column');
      if ((h.fn === 'sum' || h.fn === 'avg') && r.type !== 'number') throw new SqlError(`${h.fn} needs a number column`);
      inner = ref(s, r);
    } else if (h.fn !== 'count') throw new SqlError(`${h.fn} needs a column`);
    text += ` HAVING ${h.fn.toUpperCase()}(${inner}) ${OPS[h.op]} ${ctx.bind(h.value)}`;
  }
  if (spec.orderBy?.length) {
    const parts = spec.orderBy.map((ob) => {
      const dir = ob.dir === undefined || ob.dir === 'asc' ? 'ASC' : ob.dir === 'desc' ? 'DESC' : (() => { throw new SqlError('order is asc or desc'); })();
      if (aliases.has(ob.column)) return `${quote(opts.dialect, ob.column)} ${dir}`;
      return `${ref(s, resolve(s, ob.column, 'order column'))} ${dir}`;
    });
    text += ` ORDER BY ${parts.join(', ')}`;
  }
  const limit = spec.limit === undefined ? opts.defaultLimit : whole(spec.limit, 'limit', opts.maxLimit, 1);
  text += ` LIMIT ${ctx.bind(limit)}`;
  if (spec.offset !== undefined) text += ` OFFSET ${ctx.bind(whole(spec.offset, 'offset', opts.maxOffset))}`;
  return { text, params: ctx.params };
}

export interface WriteOptions extends BuilderOptions {
  /** Columns of the table that may be written (default: every column that is not sensitive). */
  readonly writable?: readonly string[];
}

function writableScope(table: string, collections: readonly Collection[], o: WriteOptions) {
  const t = collections.find((c) => c.name === table);
  if (!t) throw new SqlError(`there is no table ${JSON.stringify(String(table).slice(0, 60))}`);
  const dialect = o.dialect ?? 'pg';
  const opts = { dialect, maxLimit: o.maxLimit ?? 1000, defaultLimit: o.defaultLimit ?? 100, maxOffset: o.maxOffset ?? 100_000, maxIn: o.maxIn ?? 500, maxJoins: 0, maxConditions: o.maxConditions ?? 50, allowSensitive: o.allowSensitive ?? false } as const;
  const scope: Scope = { tables: [t], o: opts };
  const allowed = new Set(o.writable ?? Object.keys(t.fields).filter((f) => !t.fields[f]!.sensitive || opts.allowSensitive));
  const col = (name: string) => {
    if (!allowed.has(name)) throw new SqlError(`${table}.${name} cannot be written`);
    return resolve(scope, name, 'column');
  };
  return { t, scope, ctx: new Ctx(dialect), col, d: dialect };
}

/** INSERT one row. Every value is a parameter and every column must be a writable column of the table. */
export function insertSql(table: string, values: Readonly<Record<string, Scalar | null>>, collections: readonly Collection[], o: WriteOptions = {}): Built {
  const w = writableScope(table, collections, o);
  const keys = Object.keys(values);
  if (!keys.length || keys.length > 100) throw new SqlError('an insert has 1 to 100 columns');
  const vals = keys.map((k) => {
    const c = w.col(k);
    const v = values[k];
    return v === null ? w.ctx.bind(null) : value(w.ctx, c.type, v, `${table}.${k}`);
  });
  return { text: `INSERT INTO ${quote(w.d, table)} (${keys.map((k) => quote(w.d, k)).join(', ')}) VALUES (${vals.join(', ')})`, params: w.ctx.params };
}

/** UPDATE rows. A condition is required: there is no way to ask for every row by leaving it out. */
export function updateSql(table: string, set: Readonly<Record<string, Scalar | null>>, cond: Where, collections: readonly Collection[], o: WriteOptions = {}): Built {
  const w = writableScope(table, collections, o);
  const keys = Object.keys(set);
  if (!keys.length || keys.length > 100) throw new SqlError('an update sets 1 to 100 columns');
  if (!cond) throw new SqlError('an update needs a condition');
  const sets = keys.map((k) => {
    const c = w.col(k);
    const v = set[k];
    return `${quote(w.d, k)} = ${v === null ? w.ctx.bind(null) : value(w.ctx, c.type, v, `${table}.${k}`)}`;
  });
  const wh = where(w.scope, w.ctx, cond);
  return { text: `UPDATE ${quote(w.d, table)} SET ${sets.join(', ')} WHERE ${wh}`, params: w.ctx.params };
}

export function deleteSql(table: string, cond: Where, collections: readonly Collection[], o: WriteOptions = {}): Built {
  const w = writableScope(table, collections, o);
  if (!cond) throw new SqlError('a delete needs a condition');
  return { text: `DELETE FROM ${quote(w.d, table)} WHERE ${where(w.scope, w.ctx, cond)}`, params: w.ctx.params };
}

/** A plan from the query block's language as SQL. */
export function planToSql(plan: Plan, collections: readonly Collection[], o: BuilderOptions = {}): Built {
  return selectSql(
    {
      from: plan.from,
      ...(plan.select?.length ? { columns: plan.select } : {}),
      ...(plan.where.length ? { where: { and: plan.where.map((c) => ({ column: c.field, op: c.op, value: c.value })) } } : {}),
      ...(plan.order ? { orderBy: [{ column: plan.order.field, dir: plan.order.desc ? 'desc' as const : 'asc' as const }] } : {}),
      limit: plan.limit,
    },
    collections,
    o,
  );
}

/** Whether text and parameters agree: as many placeholders as values, none left unbound. Used by tests and guards. */
export function placeholdersMatch(b: Built, dialect: Dialect = 'pg'): boolean {
  const stripped = b.text.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""').replace(/`[^`]*`/g, '``');
  if (dialect === 'pg') {
    const nums = [...stripped.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    return nums.length === b.params.length && nums.every((n, i) => n === i + 1) && !stripped.includes('?');
  }
  return (stripped.match(/\?/g)?.length ?? 0) === b.params.length && !/\$\d/.test(stripped);
}

// ---------------------------------------------------------------------------------------------------------------
// The checker

export interface CheckPolicy {
  /** Tables the SQL may read, lower case; "schema.table" for a qualified name. */
  readonly tables: readonly string[];
  /** Sensitive column names (lower case) that may not be named; filled from the collections by `policyFor`. */
  readonly deniedColumns?: readonly string[];
  /** Functions that may be called, lower case. Defaults to a list of common safe ones. */
  readonly functions?: readonly string[];
  readonly maxLength?: number;
  readonly maxJoins?: number;
  readonly maxTables?: number;
  readonly maxSubqueryDepth?: number;
  /** Largest LIMIT, required unless `requireLimit` is false (default 1000). */
  readonly maxLimit?: number;
  readonly requireLimit?: boolean;
  readonly maxOffset?: number;
  readonly allowStar?: boolean;
  readonly allowCrossJoin?: boolean;
}

export interface Checked {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly tables: readonly string[];
  readonly functions: readonly string[];
  readonly joins: number;
  readonly subqueryDepth: number;
  readonly limit: number | undefined;
}

/** Functions that are safe to call from a read-only query written by a person. */
export const SAFE_FUNCTIONS: readonly string[] = [
  'count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif', 'greatest', 'least', 'lower', 'upper', 'length', 'char_length', 'substr', 'substring', 'trim', 'ltrim', 'rtrim', 'replace', 'concat', 'concat_ws', 'left', 'right', 'abs', 'round', 'floor', 'ceil', 'ceiling', 'trunc', 'mod', 'power', 'sqrt', 'sign', 'date_trunc', 'extract', 'date', 'year', 'month', 'day', 'now', 'current_date', 'current_timestamp', 'to_char', 'cast', 'row_number', 'rank', 'dense_rank', 'lag', 'lead', 'first_value', 'last_value', 'ntile', 'string_agg', 'array_agg', 'bool_and', 'bool_or', 'position', 'strpos', 'initcap', 'md5', 'abs', 'age', 'date_part', 'ifnull', 'if', 'iif', 'typeof', 'cume_dist', 'percent_rank', 'stddev', 'variance', 'overlay', 'lpad', 'rpad', 'reverse', 'split_part', 'regexp_replace',
];

/** Never callable, whatever the function list says: they read files, sleep, reach the network, change settings or end sessions. */
export const NEVER_FUNCTIONS: ReadonlySet<string> = new Set([
  'pg_sleep', 'pg_sleep_for', 'pg_sleep_until', 'sleep', 'benchmark', 'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file', 'lo_import', 'lo_export', 'lo_open', 'lo_get', 'lo_from_bytea', 'dblink', 'dblink_exec', 'dblink_connect', 'set_config', 'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf', 'pg_rotate_logfile', 'pg_advisory_lock', 'pg_try_advisory_lock', 'pg_notify', 'nextval', 'setval', 'currval', 'load_extension', 'load_file', 'readfile', 'writefile', 'edit', 'sys_exec', 'sys_eval', 'xp_cmdshell', 'query_to_xml', 'table_to_xml', 'database_to_xml', 'current_setting', 'pg_logical_emit_message', 'txid_current', 'gen_random_bytes', 'random', 'rand', 'randomblob', 'last_insert_rowid', 'get_lock', 'release_lock', 'uuid_generate_v4', 'generate_series', 'unnest', 'regexp_matches', 'regexp_split_to_table',
]);

const DENY_KEYWORDS = new Set(['insert', 'update', 'delete', 'merge', 'into', 'drop', 'alter', 'create', 'truncate', 'grant', 'revoke', 'copy', 'call', 'exec', 'execute', 'set', 'reset', 'lock', 'vacuum', 'attach', 'detach', 'pragma', 'returning', 'outfile', 'dumpfile', 'procedure', 'share', 'handler', 'replace_into', 'listen', 'notify', 'prepare', 'deallocate', 'discard', 'load', 'reindex', 'cluster', 'rename', 'begin', 'commit', 'rollback', 'savepoint', 'do', 'explain']);
// REPLACE is a function in every dialect and a write statement in MySQL; it is a write only as the first word.
const NOT_CALLS = new Set(['in', 'exists', 'any', 'all', 'some', 'and', 'or', 'not', 'on', 'using', 'as', 'over', 'filter', 'within', 'select', 'from', 'where', 'values', 'union', 'intersect', 'except', 'case', 'when', 'then', 'else', 'end', 'is', 'like', 'ilike', 'between', 'join', 'lateral', 'distinct', 'by', 'having', 'limit', 'offset', 'partition', 'order', 'group', 'with', 'recursive', 'array', 'row', 'interval', 'similar', 'to', 'at', 'escape', 'fetch', 'rows', 'range', 'groups', 'unbounded', 'preceding', 'following', 'current', 'asc', 'desc', 'nulls', 'first', 'last', 'collate', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'natural', 'materialized', 'only', 'ties', 'next', 'window', 'tablesample']);
const TYPE_NAMES = new Set(['varchar', 'char', 'character', 'numeric', 'decimal', 'timestamp', 'timestamptz', 'time', 'timetz', 'float', 'double', 'bit', 'varbit', 'nvarchar', 'nchar', 'int', 'integer', 'bigint', 'smallint', 'real', 'boolean', 'bool', 'text', 'date']);
const FROM_END = new Set(['where', 'group', 'order', 'having', 'limit', 'offset', 'union', 'intersect', 'except', 'window', 'fetch', 'returning']);
const FROM_FUNCTIONS = new Set(['extract', 'substring', 'trim', 'overlay', 'position']);

type Tok = { k: 'word' | 'qid' | 'str' | 'num' | 'op' | 'punct' | 'param'; v: string; i: number };

function tokenize(sql: string, problems: string[]): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = sql.length;
  const fail = (m: string) => {
    if (!problems.includes(m)) problems.push(m);
  };
  while (i < n) {
    const c = sql[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      i++;
      continue;
    }
    if (c.charCodeAt(0) < 32 || c === '\u007f') {
      fail('control characters are not allowed');
      i++;
      continue;
    }
    if (c.charCodeAt(0) > 127) {
      fail('only plain ASCII is allowed outside quotes');
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') return fail('comments are not allowed'), out;
    if (c === '#') return fail('comments are not allowed'), out;
    if (c === '/' && sql[i + 1] === '*') return fail('comments are not allowed'), out;
    if (c === "'") {
      let j = i + 1;
      let s = '';
      for (;;) {
        if (j >= n) {
          fail('a string is not closed');
          return out;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            s += "'";
            j += 2;
            continue;
          }
          break;
        }
        s += sql[j];
        j++;
      }
      if (s.includes('\\')) fail('a backslash in a string means different things in different databases, so it is refused');
      if (s.includes('\u0000')) fail('null characters are not allowed');
      out.push({ k: 'str', v: s, i });
      i = j + 1;
      continue;
    }
    if (c === '"' || c === '`') {
      let j = i + 1;
      let s = '';
      for (;;) {
        if (j >= n) {
          fail('a quoted name is not closed');
          return out;
        }
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            s += c;
            j += 2;
            continue;
          }
          break;
        }
        s += sql[j];
        j++;
      }
      if (/[^\x20-\x7e]/.test(s)) fail('only plain ASCII is allowed in a quoted name');
      out.push({ k: 'qid', v: s, i });
      i = j + 1;
      continue;
    }
    if (c === '[') {
      fail('bracketed names are not allowed');
      i++;
      continue;
    }
    if (c === '$') {
      const m = /^\$(\d+)/.exec(sql.slice(i, i + 12));
      if (m) {
        out.push({ k: 'param', v: m[0], i });
        i += m[0].length;
        continue;
      }
      fail('dollar quoting is not allowed');
      i++;
      continue;
    }
    if (c === '?') {
      out.push({ k: 'param', v: '?', i });
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j]!)) j++;
      const w = sql.slice(i, j);
      if ((w === 'E' || w === 'e' || w === 'N' || w === 'n' || w === 'B' || w === 'b' || w === 'X' || w === 'x' || w === 'U' || w === 'u') && sql[j] === "'") {
        fail('prefixed strings (E, N, B, X, U&) are not allowed');
        i = j;
        continue;
      }
      out.push({ k: 'word', v: w, i });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(sql.slice(i))!;
      out.push({ k: 'num', v: m[0], i });
      i += m[0].length;
      continue;
    }
    if (c === '.' && /[0-9]/.test(sql[i + 1] ?? '')) {
      const m = /^\.\d+(?:[eE][+-]?\d+)?/.exec(sql.slice(i))!;
      out.push({ k: 'num', v: m[0], i });
      i += m[0].length;
      continue;
    }
    if ('(),;.'.includes(c)) {
      out.push({ k: 'punct', v: c, i });
      i++;
      continue;
    }
    if (c === '\\') {
      fail('a backslash outside a string is not allowed');
      i++;
      continue;
    }
    if (c === '@' || c === ':') {
      if (c === ':' && sql[i + 1] === ':') {
        out.push({ k: 'op', v: '::', i });
        i += 2;
        continue;
      }
      fail(c === '@' ? 'variables (@) are not allowed' : 'assignment and named parameters (:) are not allowed');
      i++;
      continue;
    }
    if ('+-*/%<>=!|&^~'.includes(c)) {
      let j = i + 1;
      while (j < n && '+-*/%<>=!|&^~'.includes(sql[j]!)) j++;
      const op = sql.slice(i, j);
      if (op.includes('--') || op.includes('/*')) fail('comments are not allowed');
      out.push({ k: 'op', v: op, i });
      i = j;
      continue;
    }
    fail(`the character ${JSON.stringify(c)} is not allowed`);
    i++;
  }
  return out;
}

/** The names a person's SQL reads and the ways it could do harm or cost too much, without running it. */
export function checkReadOnly(sql: string, policy: CheckPolicy): Checked {
  const problems: string[] = [];
  const maxLength = policy.maxLength ?? 20_000;
  const fns = new Set(policy.functions ?? SAFE_FUNCTIONS);
  const tablesAllowed = new Set(policy.tables.map((t) => t.toLowerCase()));
  const denied = new Set((policy.deniedColumns ?? []).map((c) => c.toLowerCase()));
  const maxLimit = policy.maxLimit ?? 1000;
  const requireLimit = policy.requireLimit ?? true;
  const done = (extra: Partial<Checked> = {}): Checked => ({ ok: problems.length === 0, problems, tables: [], functions: [], joins: 0, subqueryDepth: 0, limit: undefined, ...extra });
  if (typeof sql !== 'string') return (problems.push('the SQL must be text'), done());
  if (sql.length > maxLength) return (problems.push(`the SQL is longer than ${maxLength} characters`), done());
  const toks = tokenize(sql, problems);
  if (toks.length > 5000) return (problems.push('the SQL has more than 5000 tokens'), done());
  if (!toks.length) return (problems.push('there is no SQL'), done());
  const w = (t: Tok | undefined) => (t && t.k === 'word' ? t.v.toLowerCase() : undefined);
  // One statement: a single trailing semicolon is allowed, nothing after one.
  const semi = toks.findIndex((t) => t.k === 'punct' && t.v === ';');
  let body = toks;
  if (semi >= 0) {
    if (semi !== toks.length - 1) problems.push('more than one statement');
    body = toks.slice(0, semi);
  }
  const first = w(body[0]);
  if (first !== 'select' && first !== 'with' && first !== 'values') problems.push(`only SELECT is allowed, not ${body[0] ? JSON.stringify(body[0].v.slice(0, 20)) : 'nothing'}`);
  // CTE names: WITH [RECURSIVE] name [(cols)] AS [NOT] [MATERIALIZED] ( ... ) [, ...] then the statement.
  const ctes = new Set<string>();
  if (first === 'with') {
    let i = 1;
    if (w(body[i]) === 'recursive') i++;
    for (;;) {
      const nm = body[i];
      if (!nm || (nm.k !== 'word' && nm.k !== 'qid')) {
        problems.push('a WITH clause names each query');
        break;
      }
      ctes.add(nm.v.toLowerCase());
      i++;
      if (body[i]?.v === '(') i = skipParens(body, i) + 1;
      if (w(body[i]) !== 'as') {
        problems.push('a WITH query needs AS');
        break;
      }
      i++;
      if (w(body[i]) === 'not') i++;
      if (w(body[i]) === 'materialized') i++;
      if (body[i]?.v !== '(') {
        problems.push('a WITH query is written in parentheses');
        break;
      }
      i = skipParens(body, i) + 1;
      if (body[i]?.k === 'punct' && body[i]!.v === ',') {
        i++;
        continue;
      }
      break;
    }
  }
  const tables: string[] = [];
  const funcs: string[] = [];
  let joins = 0;
  let depth = 0;
  let subDepth = 0;
  let maxSub = 0;
  // Each open parenthesis: what it belongs to, and the state of a FROM list directly inside it.
  type Frame = { fn?: string; sub: boolean; from: boolean; expectTable: boolean };
  const stack: Frame[] = [{ sub: false, from: false, expectTable: false }];
  let limit: number | undefined;
  let offset: number | undefined;
  const top = () => stack[stack.length - 1]!;
  const checkTable = (parts: string[]) => {
    const full = parts.join('.').toLowerCase();
    tables.push(full);
    if (parts.length === 1 && ctes.has(full)) return;
    if (!tablesAllowed.has(full)) problems.push(`the table ${JSON.stringify(full.slice(0, 60))} is not allowed`);
  };
  for (let i = 0; i < body.length; i++) {
    const t = body[i]!;
    const lw = w(t);
    const prev = body[i - 1];
    const next = body[i + 1];
    if (t.k === 'qid' && denied.has(t.v.toLowerCase())) problems.push(`the column ${t.v} may not be used`);
    if (lw !== undefined) {
      if (DENY_KEYWORDS.has(lw) && !(lw === 'set' && false)) {
        if (!(lw === 'do' && false)) problems.push(`${lw.toUpperCase()} is not allowed`);
      }
      if (lw === 'for' && ['update', 'share', 'no', 'key'].includes(w(next) ?? '')) problems.push('locking clauses are not allowed');
      if (lw === 'cross' && w(next) === 'join' && !policy.allowCrossJoin) problems.push('cross joins are not allowed');
      if (lw === 'with' && i > 0 && prev?.v !== '(') problems.push('WITH is only allowed at the start');
      if (denied.has(lw)) problems.push(`the column ${lw} may not be used`);
    }
    if (t.k === 'punct' && t.v === '(') {
      const before = prev && (prev.k === 'word' || prev.k === 'qid') ? prev : undefined;
      const isSub = ['select', 'with', 'values'].includes(w(next) ?? '');
      let fnName: string | undefined;
      if (before && before.k === 'word' && !NOT_CALLS.has(before.v.toLowerCase())) {
        const name = before.v.toLowerCase();
        const dotted = body[i - 2]?.v === '.';
        const inFromPos = top().from && top().expectTable;
        const typeCast = w(body[i - 2]) === 'as' && TYPE_NAMES.has(name);
        const cteDef = first === 'with' && ctes.has(name) && (w(body[i - 2]) === 'with' || w(body[i - 2]) === 'recursive' || body[i - 2]?.v === ',' || body[i - 2]?.v === ')') && depth === 0;
        if (typeCast || cteDef || (TYPE_NAMES.has(name) && body[i - 2]?.v === '::')) {
          // A type with a size, or the column list of a WITH query: not a call.
        } else if (inFromPos && !dotted) {
          problems.push(`a function in FROM (${name}) is not allowed`);
        } else {
          funcs.push(name);
          if (dotted) problems.push(`the qualified function ${body[i - 3]?.v ?? ''}.${name} is not allowed`);
          else if (NEVER_FUNCTIONS.has(name)) problems.push(`the function ${name} is never allowed`);
          else if (!fns.has(name)) problems.push(`the function ${name} is not on the allowed list`);
          fnName = name;
        }
      } else if (before && before.k === 'qid' && !(w(body[i - 2]) === 'as')) {
        problems.push(`a quoted function name (${before.v}) is not allowed`);
      }
      depth++;
      if (isSub) {
        subDepth++;
        maxSub = Math.max(maxSub, subDepth);
      }
      stack.push({ ...(fnName ? { fn: fnName } : {}), sub: isSub, from: false, expectTable: false });
      continue;
    }
    if (t.k === 'punct' && t.v === ')') {
      if (stack.length === 1) {
        problems.push('a closing parenthesis has no opening one');
        continue;
      }
      const f = stack.pop()!;
      depth--;
      if (f.sub) subDepth--;
      continue;
    }
    const fr = top();
    if (lw === 'from' && !FROM_FUNCTIONS.has(fr.fn ?? '') && w(prev) !== 'distinct') {
      fr.from = true;
      fr.expectTable = true;
      continue;
    }
    if (lw && FROM_END.has(lw)) fr.from = false, (fr.expectTable = false);
    if (lw === 'join' && fr.from) {
      fr.expectTable = true;
      joins++;
      continue;
    }
    if (t.k === 'punct' && t.v === ',' && fr.from) {
      fr.expectTable = true;
      joins++;
      if (!policy.allowCrossJoin) problems.push('a comma between tables is a cross join; write JOIN ... ON');
      continue;
    }
    if (fr.from && fr.expectTable) {
      if (t.k === 'punct' && t.v === '(') continue;
      if (t.k === 'word' || t.k === 'qid') {
        const parts = [t.v];
        let j = i;
        while (body[j + 1]?.v === '.' && body[j + 1]?.k === 'punct' && (body[j + 2]?.k === 'word' || body[j + 2]?.k === 'qid')) {
          parts.push(body[j + 2]!.v);
          j += 2;
        }
        if (body[j + 1]?.v === '(') {
          // A function: handled when the parenthesis is reached.
          continue;
        }
        if (t.k === 'word' && NOT_CALLS.has(parts[0]!.toLowerCase()) && parts.length === 1 && !['left', 'right'].includes(parts[0]!.toLowerCase()) && lw !== 'only' && lw !== 'lateral') continue;
        if (lw === 'only' || lw === 'lateral') continue;
        checkTable(parts);
        fr.expectTable = false;
        i = j;
        continue;
      }
    }
    if (lw === 'limit' && depth === 0) {
      const a = body[i + 1];
      if (a?.k === 'num' && /^\d+$/.test(a.v)) {
        limit = Number(a.v);
        if (body[i + 2]?.v === ',' && body[i + 3]?.k === 'num' && /^\d+$/.test(body[i + 3]!.v)) {
          offset = limit;
          limit = Number(body[i + 3]!.v);
        }
      } else if (a?.k === 'param') limit = undefined;
      else problems.push('LIMIT must be a whole number');
    }
    if (lw === 'offset' && depth === 0 && body[i + 1]?.k === 'num' && /^\d+$/.test(body[i + 1]!.v)) offset = Number(body[i + 1]!.v);
    if (t.k === 'op' && t.v.startsWith('*') === false && t.v === ':=') problems.push('assignment is not allowed');
    if (t.k === 'op' && t.v === '*' && (w(prev) === 'select' || w(prev) === 'distinct' || prev?.v === ',' || prev?.v === '.') && !(fr.fn === 'count')) {
      if (!policy.allowStar) problems.push('SELECT * is not allowed; name the columns');
      else if (denied.size) problems.push('SELECT * is not allowed because some columns of these tables are sensitive');
    }
  }
  if (stack.length > 1) problems.push('a parenthesis is not closed');
  if (joins > (policy.maxJoins ?? 5)) problems.push(`more than ${policy.maxJoins ?? 5} joins`);
  if (new Set(tables).size > (policy.maxTables ?? 8)) problems.push(`more than ${policy.maxTables ?? 8} tables`);
  if (maxSub > (policy.maxSubqueryDepth ?? 3)) problems.push(`subqueries nested more than ${policy.maxSubqueryDepth ?? 3} deep`);
  if (requireLimit && limit === undefined && !toks.some((t) => t.k === 'param')) problems.push('a LIMIT is required');
  if (limit !== undefined && limit > maxLimit) problems.push(`LIMIT ${limit} is more than ${maxLimit}`);
  if (limit === 0 && false) problems.push('LIMIT 0');
  if (offset !== undefined && offset > (policy.maxOffset ?? 100_000)) problems.push(`OFFSET ${offset} is more than ${policy.maxOffset ?? 100_000}`);
  return done({ tables: [...new Set(tables)], functions: [...new Set(funcs)], joins, subqueryDepth: maxSub, limit });
}

function skipParens(toks: readonly Tok[], open: number): number {
  let d = 0;
  for (let i = open; i < toks.length; i++) {
    if (toks[i]!.k === 'punct' && toks[i]!.v === '(') d++;
    else if (toks[i]!.k === 'punct' && toks[i]!.v === ')' && --d === 0) return i;
  }
  return toks.length;
}

/** Throws UnsafeSql with every problem, or returns what was found. */
export function assertReadOnly(sql: string, policy: CheckPolicy): Checked {
  const c = checkReadOnly(sql, policy);
  if (!c.ok) throw new UnsafeSql(c.problems);
  return c;
}

/** A policy for the tables of a declaration: their names, and their sensitive columns as the denied ones. */
export function policyFor(collections: readonly Collection[], o: Omit<CheckPolicy, 'tables' | 'deniedColumns'> = {}): CheckPolicy {
  return {
    ...o,
    tables: collections.map((c) => c.name.toLowerCase()),
    deniedColumns: collections.flatMap((c) => Object.entries(c.fields).filter(([, f]) => f.sensitive).map(([n]) => n.toLowerCase())),
  };
}

/**
 * The statement with its outer LIMIT clamped to `max`, or added if there is none. Only call it on SQL that has
 * passed `checkReadOnly`: it works on tokens, and refuses (throws) anything it cannot place the limit in.
 */
export function limitTo(sql: string, max: number): string {
  if (!Number.isInteger(max) || max < 1) throw new SqlError('the limit is a whole number of at least 1');
  const problems: string[] = [];
  const toks = tokenize(sql, problems);
  if (problems.length) throw new UnsafeSql(problems);
  let depth = 0;
  let at = -1;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.k === 'punct' && t.v === '(') depth++;
    else if (t.k === 'punct' && t.v === ')') depth--;
    else if (depth === 0 && t.k === 'word' && t.v.toLowerCase() === 'limit') at = i;
  }
  const trimmed = sql.replace(/\s*;\s*$/, '');
  if (at < 0) return `${trimmed} LIMIT ${max}`;
  const num = toks[at + 1];
  if (!num || num.k !== 'num' || !/^\d+$/.test(num.v)) throw new SqlError('cannot place the limit: the existing LIMIT is not a plain number');
  const comma = toks[at + 2]?.v === ',' && toks[at + 3]?.k === 'num';
  const lim = comma ? toks[at + 3]! : num;
  const clamped = Math.min(Number(lim.v), max);
  return `${trimmed.slice(0, lim.i)}${clamped}${trimmed.slice(lim.i + lim.v.length)}`;
}

export interface CostCaps {
  readonly maxTotalCost?: number;
  readonly maxRows?: number;
  /** Largest estimated row count of a sequential scan anywhere in the plan. */
  readonly maxSeqScanRows?: number;
}

/** Judges a PostgreSQL EXPLAIN (FORMAT JSON) result against caps; returns the problems, empty when it is acceptable. */
export function checkExplain(explain: unknown, caps: CostCaps): string[] {
  const root = Array.isArray(explain) ? explain[0] : explain;
  const plan = (root as { Plan?: unknown } | undefined)?.Plan as Record<string, unknown> | undefined;
  if (!plan || typeof plan !== 'object') throw new SqlError('that is not an EXPLAIN (FORMAT JSON) result');
  const problems: string[] = [];
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const cost = num(plan['Total Cost']);
  const rows = num(plan['Plan Rows']);
  if (cost === undefined || rows === undefined) throw new SqlError('the plan has no Total Cost or Plan Rows');
  if (caps.maxTotalCost !== undefined && cost > caps.maxTotalCost) problems.push(`the estimated cost ${cost} is more than ${caps.maxTotalCost}`);
  if (caps.maxRows !== undefined && rows > caps.maxRows) problems.push(`the estimated ${rows} rows are more than ${caps.maxRows}`);
  const walk = (p: Record<string, unknown>, depth: number) => {
    if (depth > 64) throw new SqlError('the plan is nested too deeply');
    if (caps.maxSeqScanRows !== undefined && p['Node Type'] === 'Seq Scan') {
      const r = num(p['Plan Rows']);
      if (r !== undefined && r > caps.maxSeqScanRows) problems.push(`a sequential scan of ${String(p['Relation Name'] ?? 'a table')} reads an estimated ${r} rows, more than ${caps.maxSeqScanRows}`);
    }
    const kids = p.Plans;
    if (Array.isArray(kids)) for (const k of kids) if (k && typeof k === 'object') walk(k as Record<string, unknown>, depth + 1);
  };
  walk(plan, 0);
  return problems;
}
