/**
 * A structured query: the model behind a point-and-click question builder (Metabase's MBQL, Superset's query object,
 * Grafana's query builder), kept as plain data and compiled to parameterised SQL. A query names a source table, joins
 * (inner, left, right, full) on column pairs, custom columns built from expressions, a filter tree (and, or, not,
 * comparisons, between, in, null checks, contains, starts and ends with), aggregations (count, sum, avg, min, max,
 * distinct count), breakouts (group by) with binning (a time unit, or a numeric bucket width), order and limit.
 *
 * Rules: every value becomes a parameter, never text in the SQL; every identifier must be a plain name and is quoted
 * for the dialect; with a schema given, a table or column that is not in it is refused; LIKE patterns are escaped so
 * a user's % or _ means itself; division is guarded against a zero divisor; a named parameter (`{ param: 'x' }`) is
 * filled from the values handed to compile and refused when missing. Dialects (postgres, mysql, sqlite, bigquery)
 * differ in quoting, placeholders, date truncation and concat, and live in one map.
 *
 * Out of scope: running the SQL, nested sub-queries (a source is a table), window functions, and a query-builder UI.
 */

export class QueryModelError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export type DialectName = 'postgres' | 'mysql' | 'sqlite' | 'bigquery';
export type TimeUnit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';

/** A column: `orders.total`, or a bare `total` belonging to the source table. */
export type FieldRef = string | { readonly table?: string; readonly column: string };

export type Value = string | number | boolean | null | Date;
export type ParamRef = { readonly param: string };

export type Expr =
  | { readonly field: FieldRef }
  | { readonly value: Value }
  | ParamRef
  | { readonly op: '+' | '-' | '*' | '/' | '%'; readonly args: readonly Expr[] }
  | { readonly op: 'concat' | 'coalesce'; readonly args: readonly Expr[] }
  | { readonly op: 'abs' | 'round' | 'lower' | 'upper' | 'length'; readonly args: readonly Expr[] }
  | { readonly op: 'case'; readonly cases: readonly { readonly when: Filter; readonly then: Expr }[]; readonly else?: Expr };

export type Filter =
  | { readonly and: readonly Filter[] }
  | { readonly or: readonly Filter[] }
  | { readonly not: Filter }
  | { readonly op: '=' | '!=' | '<' | '<=' | '>' | '>='; readonly left: Expr; readonly right: Expr }
  | { readonly op: 'between'; readonly left: Expr; readonly low: Expr; readonly high: Expr }
  | { readonly op: 'in' | 'not-in'; readonly left: Expr; readonly values: readonly (Value | ParamRef)[] }
  | { readonly op: 'is-null' | 'not-null'; readonly left: Expr }
  | { readonly op: 'contains' | 'starts-with' | 'ends-with'; readonly left: Expr; readonly text: string | ParamRef; readonly caseSensitive?: boolean };

export interface Join {
  readonly table: string;
  readonly alias?: string;
  readonly type?: 'inner' | 'left' | 'right' | 'full';
  /** Pairs that must be equal: each side a field. */
  readonly on: readonly { readonly left: FieldRef; readonly right: FieldRef }[];
}

export type Binning = { readonly time: TimeUnit } | { readonly width: number; readonly offset?: number };

export interface Breakout {
  readonly field: FieldRef;
  readonly binning?: Binning;
  /** The output column name. Defaults to the column name, with `_<unit>` or `_binned` after a binning. */
  readonly as?: string;
}

export interface Aggregation {
  readonly op: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'distinct';
  /** Absent for `count` of rows. */
  readonly field?: FieldRef;
  readonly expr?: Expr;
  readonly as?: string;
  /** Only rows matching this are counted (a conditional aggregate). */
  readonly where?: Filter;
}

export interface Selected {
  readonly field?: FieldRef;
  readonly expr?: Expr;
  readonly as?: string;
}

export interface StructuredQuery {
  readonly source: string;
  readonly alias?: string;
  readonly joins?: readonly Join[];
  /** Custom columns: named expressions usable by name in select, filter, breakout and order. */
  readonly expressions?: readonly { readonly name: string; readonly expr: Expr }[];
  /** Plain columns to return when there are no aggregations or breakouts. Empty: all columns of the source. */
  readonly fields?: readonly Selected[];
  readonly breakouts?: readonly Breakout[];
  readonly aggregations?: readonly Aggregation[];
  /** Filter on rows, before grouping. */
  readonly filter?: Filter;
  /** Filter on groups, after aggregation; fields name an output column. */
  readonly having?: Filter;
  readonly orderBy?: readonly { readonly by: string; readonly dir?: 'asc' | 'desc' }[];
  readonly limit?: number;
  readonly offset?: number;
}

/** Tables and their columns, when the caller wants anything else refused. */
export type Schema = Readonly<Record<string, readonly string[]>>;

export interface Compiled {
  readonly sql: string;
  readonly params: readonly unknown[];
  /** Output column names in order. */
  readonly columns: readonly string[];
}

export interface Dialect {
  readonly name: DialectName;
  readonly quote: (id: string) => string;
  readonly placeholder: (n: number) => string;
  readonly truncate: (unit: TimeUnit, sql: string) => string;
  readonly concat: (parts: readonly string[]) => string;
  readonly floorDiv: (sql: string) => string;
  readonly likeEscapeClause: string;
  readonly ilike: boolean;
  readonly limit: (limit: number | undefined, offset: number | undefined) => string;
}

const q = (ch: string) => (id: string) => ch + id.split(ch).join(ch + ch) + ch;

function pgTrunc(unit: TimeUnit, sql: string): string {
  return `date_trunc('${unit}', ${sql})`;
}

function limitClause(limit: number | undefined, offset: number | undefined, needLimitForOffset: string | null): string {
  let out = '';
  if (limit !== undefined) out += ` LIMIT ${limit}`;
  else if (offset !== undefined && needLimitForOffset) out += ` LIMIT ${needLimitForOffset}`;
  if (offset !== undefined) out += ` OFFSET ${offset}`;
  return out;
}

export const DIALECTS: Readonly<Record<DialectName, Dialect>> = {
  postgres: {
    name: 'postgres',
    quote: q('"'),
    placeholder: (n) => `$${n}`,
    truncate: pgTrunc,
    concat: (p) => `(${p.join(' || ')})`,
    floorDiv: (s) => `floor(${s})`,
    likeEscapeClause: " ESCAPE '\\'",
    ilike: true,
    limit: (l, o) => limitClause(l, o, null),
  },
  mysql: {
    name: 'mysql',
    quote: q('`'),
    placeholder: () => '?',
    truncate: (unit, s) => {
      switch (unit) {
        case 'minute': return `DATE_FORMAT(${s}, '%Y-%m-%d %H:%i:00')`;
        case 'hour': return `DATE_FORMAT(${s}, '%Y-%m-%d %H:00:00')`;
        case 'day': return `DATE(${s})`;
        case 'week': return `DATE(DATE_SUB(${s}, INTERVAL WEEKDAY(${s}) DAY))`;
        case 'month': return `DATE_FORMAT(${s}, '%Y-%m-01')`;
        case 'quarter': return `MAKEDATE(YEAR(${s}), 1) + INTERVAL (QUARTER(${s}) - 1) QUARTER`;
        case 'year': return `DATE_FORMAT(${s}, '%Y-01-01')`;
      }
    },
    concat: (p) => `CONCAT(${p.join(', ')})`,
    floorDiv: (s) => `FLOOR(${s})`,
    likeEscapeClause: " ESCAPE '\\\\'",
    ilike: false,
    limit: (l, o) => limitClause(l, o, '18446744073709551615'),
  },
  sqlite: {
    name: 'sqlite',
    quote: q('"'),
    placeholder: () => '?',
    truncate: (unit, s) => {
      switch (unit) {
        case 'minute': return `strftime('%Y-%m-%d %H:%M:00', ${s})`;
        case 'hour': return `strftime('%Y-%m-%d %H:00:00', ${s})`;
        case 'day': return `date(${s})`;
        case 'week': return `date(${s}, 'weekday 0', '-6 days')`;
        case 'month': return `strftime('%Y-%m-01', ${s})`;
        case 'quarter': return `strftime('%Y-', ${s}) || substr('0102030405060708091011', ((cast(strftime('%m', ${s}) as integer) - 1) / 3) * 6 + 1, 2) || '-01'`;
        case 'year': return `strftime('%Y-01-01', ${s})`;
      }
    },
    concat: (p) => `(${p.join(' || ')})`,
    floorDiv: (s) => `cast(floor(${s}) as integer)`,
    likeEscapeClause: " ESCAPE '\\'",
    ilike: false,
    limit: (l, o) => limitClause(l, o, '-1'),
  },
  bigquery: {
    name: 'bigquery',
    quote: q('`'),
    placeholder: (n) => `@p${n}`,
    truncate: (unit, s) => `TIMESTAMP_TRUNC(${s}, ${unit.toUpperCase()})`,
    concat: (p) => `CONCAT(${p.join(', ')})`,
    floorDiv: (s) => `FLOOR(${s})`,
    likeEscapeClause: '',
    ilike: false,
    limit: (l, o) => limitClause(l, o, null),
  },
};

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const UNITS: readonly TimeUnit[] = ['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'];

function name(id: string, what: string): string {
  if (typeof id !== 'string' || !NAME.test(id)) throw new QueryModelError(`${what} "${String(id)}" is not a plain name (letters, digits, underscore; not starting with a digit)`);
  return id;
}

export interface CompileOptions {
  readonly dialect?: DialectName;
  readonly schema?: Schema;
  /** Values for `{ param: 'name' }` references. */
  readonly values?: Readonly<Record<string, Value>>;
  /** Refuse a query with no limit, or one above this. */
  readonly maxLimit?: number;
}

/** Compile a structured query into SQL and parameters. */
export function compile(query: StructuredQuery, options: CompileOptions = {}): Compiled {
  const d = DIALECTS[options.dialect ?? 'postgres'];
  if (!d) throw new QueryModelError(`unknown dialect "${String(options.dialect)}"`);
  const params: unknown[] = [];
  const values = options.values ?? {};
  const schema = options.schema;

  const sourceName = name(query.source, 'table');
  const sourceAlias = name(query.alias ?? query.source, 'alias');
  const tables = new Map<string, string>(); // alias -> real table
  tables.set(sourceAlias, sourceName);
  const checkTable = (t: string) => {
    if (schema && !Object.hasOwn(schema, t)) throw new QueryModelError(`table "${t}" is not in the schema`);
  };
  checkTable(sourceName);
  for (const j of query.joins ?? []) {
    const al = name(j.alias ?? j.table, 'alias');
    if (tables.has(al)) throw new QueryModelError(`alias "${al}" is used twice; give the join an alias`);
    checkTable(name(j.table, 'table'));
    tables.set(al, j.table);
  }

  const custom = new Map<string, Expr>();
  for (const e of query.expressions ?? []) {
    const n = name(e.name, 'custom column');
    if (custom.has(n)) throw new QueryModelError(`custom column "${n}" is defined twice`);
    custom.set(n, e.expr);
  }

  const param = (v: unknown): string => {
    if (v instanceof Date && Number.isNaN(v.getTime())) throw new QueryModelError('invalid date value');
    if (typeof v === 'number' && !Number.isFinite(v)) throw new QueryModelError('numbers must be finite');
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) throw new QueryModelError('a value must be a string, number, boolean, null or Date');
    params.push(v);
    return d.placeholder(params.length);
  };

  const resolveParam = (p: ParamRef): Value => {
    if (!Object.hasOwn(values, p.param)) throw new QueryModelError(`parameter "${p.param}" has no value`);
    return values[p.param] as Value;
  };

  let havingScope: Map<string, () => string> | null = null;

  const fieldSql = (f: FieldRef, expanding: Set<string>): string => {
    let table: string | undefined;
    let column: string;
    if (typeof f === 'string') {
      const parts = f.split('.');
      if (parts.length === 2) [table, column] = [parts[0] as string, parts[1] as string];
      else if (parts.length === 1) column = parts[0] as string;
      else throw new QueryModelError(`field "${f}" has too many parts`);
    } else {
      table = f.table;
      column = f.column;
    }
    name(column, 'column');
    if (table === undefined && havingScope?.has(column)) return (havingScope.get(column) as () => string)();
    if (table === undefined) {
      if (custom.has(column)) {
        if (expanding.has(column)) throw new QueryModelError(`custom column "${column}" refers to itself`);
        const next = new Set(expanding).add(column);
        return `(${exprSql(custom.get(column) as Expr, next)})`;
      }
      table = sourceAlias;
    }
    name(table, 'table');
    const real = tables.get(table);
    if (real === undefined) throw new QueryModelError(`table "${table}" is not part of this query`);
    if (schema && !(schema[real] ?? []).includes(column)) throw new QueryModelError(`column "${column}" is not in table "${real}"`);
    return `${d.quote(table)}.${d.quote(column)}`;
  };

  const valueSql = (v: Value | ParamRef): string => (typeof v === 'object' && v !== null && !(v instanceof Date) ? param(resolveParam(v)) : param(v));

  const exprSql = (e: Expr, expanding: Set<string>): string => {
    if ('field' in e) return fieldSql(e.field, expanding);
    if ('value' in e) return param(e.value);
    if ('param' in e) return param(resolveParam(e));
    switch (e.op) {
      case '+': case '-': case '*': case '%': {
        if (e.args.length < 2) throw new QueryModelError(`"${e.op}" needs at least two arguments`);
        return `(${e.args.map((a) => exprSql(a, expanding)).join(` ${e.op} `)})`;
      }
      case '/': {
        if (e.args.length !== 2) throw new QueryModelError('"/" takes exactly two arguments');
        const [a, b] = e.args as [Expr, Expr];
        return `(${exprSql(a, expanding)} / NULLIF(${exprSql(b, expanding)}, 0))`;
      }
      case 'concat': {
        if (e.args.length < 1) throw new QueryModelError('"concat" needs arguments');
        return d.concat(e.args.map((a) => (d.name === 'postgres' || d.name === 'sqlite' ? `COALESCE(CAST(${exprSql(a, expanding)} AS TEXT), '')` : exprSql(a, expanding))));
      }
      case 'coalesce': {
        if (e.args.length < 2) throw new QueryModelError('"coalesce" needs at least two arguments');
        return `COALESCE(${e.args.map((a) => exprSql(a, expanding)).join(', ')})`;
      }
      case 'abs': case 'lower': case 'upper': case 'length': {
        if (e.args.length !== 1) throw new QueryModelError(`"${e.op}" takes one argument`);
        return `${e.op === 'length' ? 'LENGTH' : e.op.toUpperCase()}(${exprSql(e.args[0] as Expr, expanding)})`;
      }
      case 'round': {
        if (e.args.length < 1 || e.args.length > 2) throw new QueryModelError('"round" takes one or two arguments');
        return `ROUND(${e.args.map((a) => exprSql(a, expanding)).join(', ')})`;
      }
      case 'case': {
        if (e.cases.length === 0) throw new QueryModelError('"case" needs at least one branch');
        const whens = e.cases.map((c) => `WHEN ${filterSql(c.when, expanding)} THEN ${exprSql(c.then, expanding)}`);
        return `CASE ${whens.join(' ')}${e.else ? ` ELSE ${exprSql(e.else, expanding)}` : ''} END`;
      }
      default:
        throw new QueryModelError(`unknown expression operator "${(e as { op: string }).op}"`);
    }
  };

  const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

  const filterSql = (f: Filter, expanding: Set<string>): string => {
    if ('and' in f || 'or' in f) {
      const list = 'and' in f ? f.and : f.or;
      const word = 'and' in f ? 'AND' : 'OR';
      if (list.length === 0) throw new QueryModelError(`"${word.toLowerCase()}" needs at least one condition`);
      return list.length === 1 ? filterSql(list[0] as Filter, expanding) : `(${list.map((x) => filterSql(x, expanding)).join(` ${word} `)})`;
    }
    if ('not' in f) return `NOT (${filterSql(f.not, expanding)})`;
    switch (f.op) {
      case '=': case '!=': case '<': case '<=': case '>': case '>=': {
        // comparing to a null value means IS NULL, because = NULL never matches
        if ('value' in f.right && f.right.value === null && (f.op === '=' || f.op === '!=')) return `${exprSql(f.left, expanding)} IS ${f.op === '=' ? '' : 'NOT '}NULL`;
        return `${exprSql(f.left, expanding)} ${f.op === '!=' ? '<>' : f.op} ${exprSql(f.right, expanding)}`;
      }
      case 'between': return `${exprSql(f.left, expanding)} BETWEEN ${exprSql(f.low, expanding)} AND ${exprSql(f.high, expanding)}`;
      case 'in': case 'not-in': {
        if (f.values.length === 0) return f.op === 'in' ? '1 = 0' : '1 = 1';
        return `${exprSql(f.left, expanding)} ${f.op === 'in' ? 'IN' : 'NOT IN'} (${f.values.map(valueSql).join(', ')})`;
      }
      case 'is-null': return `${exprSql(f.left, expanding)} IS NULL`;
      case 'not-null': return `${exprSql(f.left, expanding)} IS NOT NULL`;
      case 'contains': case 'starts-with': case 'ends-with': {
        const raw = typeof f.text === 'string' ? f.text : String(resolveParam(f.text));
        if (d.name === 'sqlite' && f.caseSensitive === true) {
          // sqlite's LIKE ignores case and cannot be told otherwise, so compare the text itself
          const l = exprSql(f.left, expanding);
          if (raw === '') return `${l} IS NOT NULL`;
          if (f.op === 'contains') return `instr(${l}, ${param(raw)}) > 0`;
          const a = param(raw);
          const b = param(raw);
          return f.op === 'starts-with' ? `substr(${l}, 1, length(${a})) = ${b}` : `substr(${l}, -length(${a})) = ${b}`;
        }
        const body = escapeLike(raw);
        const pattern = f.op === 'contains' ? `%${body}%` : f.op === 'starts-with' ? `${body}%` : `%${body}`;
        let left = exprSql(f.left, expanding);
        const sensitive = f.caseSensitive === true;
        const op = !sensitive && d.ilike ? 'ILIKE' : sensitive && d.name === 'mysql' ? 'LIKE BINARY' : 'LIKE';
        let right = param(pattern);
        if (!sensitive && !d.ilike) {
          left = `LOWER(${left})`;
          right = `LOWER(${right})`;
        }
        return `${left} ${op} ${right}${d.likeEscapeClause}`;
      }
      default:
        throw new QueryModelError(`unknown filter operator "${(f as { op: string }).op}"`);
    }
  };

  const none = new Set<string>();
  const outputs: string[] = [];
  /** Each output column as SQL. A function, because every use writes its parameters again, in text order. */
  const outputSql = new Map<string, () => string>();
  const defineOutput = (n: string, sql: () => string) => {
    name(n, 'output column');
    if (outputSql.has(n)) throw new QueryModelError(`output column "${n}" appears twice; give one an "as" name`);
    outputs.push(n);
    outputSql.set(n, sql);
  };
  const baseName = (f: FieldRef) => (typeof f === 'string' ? (f.split('.').pop() as string) : f.column);

  const groupExprs: (() => string)[] = [];
  const selectParts: (() => string)[] = [];
  const checked: string[] = [];

  for (const b of query.breakouts ?? []) {
    let n = b.as ?? baseName(b.field);
    let make: () => string = () => fieldSql(b.field, none);
    if (b.binning) {
      const binning = b.binning;
      if ('time' in binning) {
        if (!UNITS.includes(binning.time)) throw new QueryModelError(`unknown time unit "${String(binning.time)}"`);
        make = () => d.truncate(binning.time, fieldSql(b.field, none));
        n = b.as ?? `${n}_${binning.time}`;
      } else {
        const { width, offset = 0 } = binning;
        if (!(typeof width === 'number' && Number.isFinite(width) && width > 0)) throw new QueryModelError('bin width must be a positive number');
        if (!Number.isFinite(offset)) throw new QueryModelError('bin offset must be a number');
        make = () => {
          const base = fieldSql(b.field, none);
          // the placeholders are written in the order they appear in the text
          const o1 = param(offset);
          const w1 = param(width);
          const w2 = param(width);
          const o2 = param(offset);
          return `(${d.floorDiv(`((${base} - ${o1}) / ${w1})`)} * ${w2} + ${o2})`;
        };
        n = b.as ?? `${n}_binned`;
      }
    }
    make(); // validates now; its parameters are discarded below
    params.length = 0;
    defineOutput(n, make);
    groupExprs.push(make);
  }

  let aggIndex = 0;
  for (const a of query.aggregations ?? []) {
    aggIndex++;
    if (a.op !== 'count' && a.field === undefined && a.expr === undefined) throw new QueryModelError(`"${a.op}" needs a field`);
    const make = (): string => {
      const target = a.expr ? exprSql(a.expr, none) : a.field !== undefined ? fieldSql(a.field, none) : null;
      const inner = (t: string) => (a.where ? `CASE WHEN ${filterSql(a.where, none)} THEN ${t} END` : t);
      switch (a.op) {
        case 'count': return target === null ? (a.where ? `COUNT(${inner('1')})` : 'COUNT(*)') : `COUNT(${inner(target)})`;
        case 'distinct': return `COUNT(DISTINCT ${inner(target as string)})`;
        case 'sum': case 'min': case 'max': return `${a.op.toUpperCase()}(${inner(target as string)})`;
        case 'avg': return `AVG(${inner(target as string)})`;
        default: throw new QueryModelError(`unknown aggregation "${String((a as { op: string }).op)}"`);
      }
    };
    make();
    params.length = 0;
    const n = a.as ?? (a.field !== undefined ? `${a.op}_${baseName(a.field)}` : a.op === 'count' ? 'count' : `${a.op}_${aggIndex}`);
    defineOutput(n, make);
  }
  for (const n of outputs) selectParts.push(() => `${outputSql.get(n)!()} AS ${d.quote(n)}`);

  const grouped = (query.breakouts?.length ?? 0) > 0 || (query.aggregations?.length ?? 0) > 0;
  let star = false;
  if (!grouped) {
    const sel = query.fields ?? [];
    if (sel.length === 0) {
      star = true;
      selectParts.push(() => `${d.quote(sourceAlias)}.*`);
      checked.push(...(schema?.[sourceName] ?? []));
      for (const [n, e] of custom) {
        defineOutput(n, () => exprSql(e, new Set([n])));
        selectParts.push(() => `${outputSql.get(n)!()} AS ${d.quote(n)}`);
      }
    }
    for (const s of sel) {
      if (s.field === undefined && s.expr === undefined) throw new QueryModelError('a selected column needs a field or an expression');
      const n = s.as ?? (s.field !== undefined ? baseName(s.field) : '');
      if (!n) throw new QueryModelError('a selected expression needs an "as" name');
      const make = () => (s.expr ? exprSql(s.expr, none) : fieldSql(s.field as FieldRef, none));
      make();
      params.length = 0;
      defineOutput(n, make);
      selectParts.push(() => `${make()} AS ${d.quote(n)}`);
    }
  }

  // Text order from here: SELECT, FROM and joins, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT. Params are pushed in that order.
  const selectText = selectParts.map((p) => p()).join(', ');
  let sql = `SELECT ${selectText} FROM ${d.quote(sourceName)}`;
  if (sourceAlias !== sourceName) sql += ` AS ${d.quote(sourceAlias)}`;
  for (const j of query.joins ?? []) {
    const type = j.type ?? 'inner';
    if (!['inner', 'left', 'right', 'full'].includes(type)) throw new QueryModelError(`unknown join type "${String(type)}"`);
    if ((type === 'right' || type === 'full') && (d.name === 'sqlite' || (d.name === 'mysql' && type === 'full'))) {
      throw new QueryModelError(`${d.name} does not support ${type.toUpperCase()} JOIN`);
    }
    if (j.on.length === 0) throw new QueryModelError(`join of "${j.table}" needs at least one pair of columns to match`);
    const al = j.alias ?? j.table;
    const on = j.on.map((p) => `${fieldSql(p.left, none)} = ${fieldSql(p.right, none)}`).join(' AND ');
    sql += ` ${type.toUpperCase()} JOIN ${d.quote(j.table)}${al !== j.table ? ` AS ${d.quote(al)}` : ''} ON ${on}`;
  }
  if (query.filter) sql += ` WHERE ${filterSql(query.filter, none)}`;
  if (groupExprs.length > 0) sql += ` GROUP BY ${groupExprs.map((g) => g()).join(', ')}`;
  if (query.having) {
    if (!grouped) throw new QueryModelError('"having" needs aggregations or breakouts');
    havingScope = outputSql;
    try {
      sql += ` HAVING ${filterSql(query.having, none)}`;
    } finally {
      havingScope = null;
    }
  }
  if (query.orderBy?.length) {
    const parts = query.orderBy.map((o) => {
      if (o.dir !== undefined && o.dir !== 'asc' && o.dir !== 'desc') throw new QueryModelError(`order direction "${String(o.dir)}" must be asc or desc`);
      const dir = o.dir === 'desc' ? 'DESC' : 'ASC';
      if (outputSql.has(o.by)) return `${d.quote(o.by)} ${dir}`;
      if (grouped) throw new QueryModelError(`cannot order by "${o.by}": it is not a column of the result`);
      return `${fieldSql(o.by, none)} ${dir}`;
    });
    sql += ` ORDER BY ${parts.join(', ')}`;
  }
  const checkInt = (n: number | undefined, what: string) => {
    if (n !== undefined && !(Number.isInteger(n) && n >= 0)) throw new QueryModelError(`${what} must be a whole number, zero or more`);
  };
  checkInt(query.limit, 'limit');
  checkInt(query.offset, 'offset');
  if (options.maxLimit !== undefined) {
    if (query.limit === undefined) throw new QueryModelError(`a limit is required (at most ${options.maxLimit})`);
    if (query.limit > options.maxLimit) throw new QueryModelError(`limit ${query.limit} is above the maximum of ${options.maxLimit}`);
  }
  sql += d.limit(query.limit, query.offset);

  return { sql, params, columns: star ? (checked.length > 0 ? [...checked, ...outputs] : ['*', ...outputs]) : outputs };
}
