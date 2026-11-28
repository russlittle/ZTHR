/**
 * Saved queries for no-code apps: a screen names a query and passes arguments, and never sends SQL. A query is
 * defined once with typed parameters, then run for a session (a user and their roles) against a data source.
 *
 * - Query definitions: either a `spec` (the sql-builder block's JSON select, with `{ $param: "name" }` standing where
 *   a value goes, and `optional` conditions that drop out when the argument is absent, which is how filters on a
 *   screen behave) or a `sql` template with `{{name}}` placeholders. A placeholder always becomes a bound parameter
 *   ($1 or ?); a list becomes one parameter per item; a name inside quotes is refused. Template SQL must pass the
 *   sql-builder read-only checker (tables on the list, no comments, limit within the cap) before it is ever run.
 * - Params: typed (string, number, boolean, date), required or defaulted, with min, max, length, choices and a list
 *   form, checked with the validate block's messages; unknown arguments are refused, not ignored.
 * - Pagination: offset (page and page size, size capped) or keyset (a signed cursor bound to this query and these
 *   arguments, so it cannot be edited, replayed on another query or used with other filters); one extra row is read to
 *   know whether there is a next page.
 * - Cache: per query time to live, single flight on a miss, the key covers the query, arguments, page and who may see
 *   the result (roles, and the user when the result depends on them), so one person's rows are never served to
 *   another; `invalidateTable` drops everything that read a table.
 * - Permission mapping: per table, which roles may read it, which columns each role sees, and a row filter built from
 *   the session ("owner_id = the user"). A spec query is narrowed to what the session may see; a template query is
 *   refused if it touches a column the session cannot see or a table that has a row filter.
 *
 * Out of scope: connecting to a database (the caller supplies `run`), writes, and caching across processes.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { selectSql, checkReadOnly, limitTo, SqlError } from '../sql-builder/index.ts';
import type { SelectSpec, Where, Built, Dialect, Scalar } from '../sql-builder/index.ts';
import type { Collection } from '../query/index.ts';
import { Cache } from '../cache/index.ts';
import { withTimeout, TimedOut } from '../resilience/index.ts';
import * as v from '../validate/index.ts';

export class QueryDefError extends Error {}
export class BadArguments extends Error {
  readonly problems: readonly v.Problem[];
  constructor(problems: readonly v.Problem[]) {
    super(problems.map((p) => `${p.path}: ${p.message}`).join('; '));
    this.problems = problems;
  }
}
export class Forbidden extends Error {}
export class BadCursor extends Error {}
export { TimedOut };

export interface Session {
  readonly user: string;
  readonly roles: readonly string[];
  readonly attrs?: Readonly<Record<string, string | number>>;
}

export interface ParamDef {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean' | 'date';
  readonly required?: boolean;
  readonly default?: Scalar;
  readonly list?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly maxLength?: number;
  readonly options?: readonly string[];
}

export interface ParamRef {
  readonly $param: string;
}
export type TWhere =
  | { readonly and: readonly TWhere[] }
  | { readonly or: readonly TWhere[] }
  | { readonly not: TWhere }
  | { readonly column: string; readonly op: Extract<Where, { column: string }>['op']; readonly value?: Scalar | readonly Scalar[] | ParamRef; readonly optional?: boolean };
export type TSpec = Omit<SelectSpec, 'where' | 'limit' | 'offset'> & { readonly where?: TWhere };

export interface QueryDef {
  readonly id: string;
  readonly datasource: string;
  readonly params?: readonly ParamDef[];
  readonly spec?: TSpec;
  readonly sql?: string;
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  readonly maxRows?: number;
  readonly pagination?: { readonly mode: 'offset' | 'keyset'; readonly defaultSize?: number; readonly maxSize?: number };
}

export interface TablePolicy {
  readonly roles: readonly string[];
  /** Columns each role sees; a role not listed sees every column that is not sensitive. */
  readonly columns?: Readonly<Record<string, readonly string[]>>;
  /** Rows the session may see; spec queries only. */
  readonly rowFilter?: (s: Session) => Where | undefined;
}
export type Policy = Readonly<Record<string, TablePolicy>>;

export interface DataSource {
  readonly name: string;
  readonly dialect: Dialect;
  readonly collections: readonly Collection[];
  readonly policy: Policy;
  readonly run: (q: Built, info: { datasource: string; query: string; signal: AbortSignal }) => Promise<readonly Record<string, unknown>[]>;
}

export interface Page {
  readonly mode: 'offset' | 'keyset';
  readonly size: number;
  readonly page?: number;
  readonly hasMore: boolean;
  readonly next?: string;
}
export interface QueryResult {
  readonly query: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly page: Page;
  readonly fromCache: boolean;
}

export interface Request {
  readonly args?: Readonly<Record<string, unknown>>;
  readonly page?: number;
  readonly size?: number;
  readonly cursor?: string;
}

const NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;

function paramSchema(p: ParamDef): v.Schema<unknown> {
  let one: v.Schema<unknown>;
  switch (p.type) {
    case 'number':
      one = v.number({ ...(p.min !== undefined ? { min: p.min } : {}), ...(p.max !== undefined ? { max: p.max } : {}) });
      break;
    case 'boolean':
      one = v.boolean();
      break;
    case 'date':
      one = v.date();
      break;
    default:
      one = p.options ? v.oneOf(p.options) : v.text({ min: 0, max: p.maxLength ?? 500, trim: false });
  }
  return p.list ? v.list(one, { max: 100 }) : one;
}

// Template parsing: `{{name}}` outside quotes.
interface Piece {
  readonly lit?: string;
  readonly param?: string;
}
function splitTemplate(sql: string): Piece[] {
  const out: Piece[] = [];
  let cur = '';
  let i = 0;
  let quote: string | undefined;
  while (i < sql.length) {
    const c = sql[i]!;
    if (quote) {
      if (sql.startsWith('{{', i)) throw new QueryDefError('a {{parameter}} cannot be written inside quotes; the value is bound, never pasted in');
      cur += c;
      if (c === quote) {
        if (sql[i + 1] === quote) {
          cur += quote;
          i++;
        } else quote = undefined;
      }
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      cur += c;
      i++;
      continue;
    }
    if (sql.startsWith('{{', i)) {
      const end = sql.indexOf('}}', i);
      const nm = end < 0 ? '' : sql.slice(i + 2, end).trim();
      if (!/^(?:session\.)?[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(nm)) throw new QueryDefError(`bad parameter ${JSON.stringify(nm.slice(0, 30))}`);
      if (cur) out.push({ lit: cur });
      cur = '';
      out.push({ param: nm });
      i = end + 2;
      continue;
    }
    cur += c;
    i++;
  }
  if (quote) throw new QueryDefError('a quote is not closed');
  if (cur) out.push({ lit: cur });
  return out;
}

function walkWhere(w: TWhere | undefined, f: (leaf: Extract<TWhere, { column: string }>) => void): void {
  if (!w) return;
  if ('and' in w) w.and.forEach((x) => walkWhere(x, f));
  else if ('or' in w) w.or.forEach((x) => walkWhere(x, f));
  else if ('not' in w) walkWhere(w.not, f);
  else f(w);
}

function bindWhere(w: TWhere, args: Readonly<Record<string, unknown>>): Where | undefined {
  if ('and' in w || 'or' in w) {
    const list = ('and' in w ? w.and : w.or).map((x) => bindWhere(x, args)).filter((x): x is Where => x !== undefined);
    if (!list.length) return undefined;
    return 'and' in w ? { and: list } : { or: list };
  }
  if ('not' in w) {
    const inner = bindWhere(w.not, args);
    return inner ? { not: inner } : undefined;
  }
  const val = w.value;
  if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date) && '$param' in val) {
    const a = args[(val as ParamRef).$param];
    if (a === undefined || a === null) {
      if (w.optional) return undefined;
      throw new BadArguments([{ path: (val as ParamRef).$param, code: 'required', message: `${(val as ParamRef).$param} is needed` }]);
    }
    return { column: w.column, op: w.op, value: a as Scalar | readonly Scalar[] };
  }
  return { column: w.column, op: w.op, ...(val !== undefined ? { value: val as Scalar | readonly Scalar[] } : {}) };
}

const stable = (x: unknown): string => JSON.stringify(x, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : val));

export interface EngineOptions {
  readonly signingKey: Uint8Array | string;
  readonly now?: () => number;
  readonly defaultTtlMs?: number;
}

export class Engine {
  private readonly sources = new Map<string, DataSource>();
  private readonly queries = new Map<string, QueryDef>();
  private readonly caches = new Map<string, Cache<QueryResult>>();
  private readonly key: Buffer;
  private readonly now: () => number;
  constructor(o: EngineOptions) {
    this.key = Buffer.from(o.signingKey);
    if (this.key.length < 16) throw new QueryDefError('the signing key must be at least 16 bytes');
    this.now = o.now ?? Date.now;
  }

  addSource(s: DataSource): void {
    if (this.sources.has(s.name)) throw new QueryDefError(`data source ${s.name} is already defined`);
    for (const t of Object.keys(s.policy)) if (!s.collections.some((c) => c.name === t)) throw new QueryDefError(`the policy names ${t}, which is not a table of ${s.name}`);
    this.sources.set(s.name, s);
  }

  /** Checks a definition against its source and keeps it. */
  define(q: QueryDef): void {
    if (!NAME.test(q.id)) throw new QueryDefError(`query id ${JSON.stringify(q.id.slice(0, 30))} is not allowed`);
    if (this.queries.has(q.id)) throw new QueryDefError(`query ${q.id} is already defined`);
    const src = this.sources.get(q.datasource);
    if (!src) throw new QueryDefError(`${q.id}: no data source ${q.datasource}`);
    if (!!q.spec === !!q.sql) throw new QueryDefError(`${q.id}: give either spec or sql`);
    const names = new Set<string>();
    for (const p of q.params ?? []) {
      if (!NAME.test(p.name) || names.has(p.name)) throw new QueryDefError(`${q.id}: parameter ${JSON.stringify(p.name.slice(0, 30))} is not allowed or repeated`);
      names.add(p.name);
      if (p.default !== undefined && !paramSchema(p).check(p.list ? [p.default] : p.default, p.name).ok) throw new QueryDefError(`${q.id}: the default for ${p.name} is not valid`);
    }
    const pg = q.pagination;
    if (pg) {
      if ((pg.defaultSize ?? 25) > (pg.maxSize ?? 100)) throw new QueryDefError(`${q.id}: the default page size is above the maximum`);
      if (pg.mode === 'keyset' && !q.spec?.orderBy?.length) throw new QueryDefError(`${q.id}: keyset paging needs an orderBy on a spec query, ending in a unique column`);
      if (pg.mode === 'keyset' && q.spec) {
        const cols = q.spec.columns?.length ? q.spec.columns.filter((c): c is string => typeof c === 'string') : undefined;
        for (const ob of q.spec.orderBy!) if (cols && !cols.includes(ob.column)) throw new QueryDefError(`${q.id}: the order column ${ob.column} must be one of the selected columns`);
        if (q.spec.groupBy?.length) throw new QueryDefError(`${q.id}: keyset paging does not work with groupBy`);
      }
      if (!q.spec && pg.mode === 'keyset') throw new QueryDefError(`${q.id}: keyset paging is for spec queries`);
    }
    if (q.spec) {
      walkWhere(q.spec.where, (leaf) => {
        const val = leaf.value;
        if (val && typeof val === 'object' && !Array.isArray(val) && '$param' in val && !names.has((val as ParamRef).$param)) throw new QueryDefError(`${q.id}: ${(val as ParamRef).$param} is not a declared parameter`);
      });
      try {
        this.buildSpec(q, src, { user: 'u', roles: [] }, this.sample(q), 1, 0, undefined, true);
      } catch (e) {
        if (e instanceof SqlError) throw new QueryDefError(`${q.id}: ${e.message}`);
        if (!(e instanceof Forbidden)) throw e;
      }
    } else {
      const pieces = splitTemplate(q.sql!);
      for (const pc of pieces) if (pc.param && !pc.param.startsWith('session.') && !names.has(pc.param)) throw new QueryDefError(`${q.id}: {{${pc.param}}} is not a declared parameter`);
      const all = src.collections.map((c) => c.name.toLowerCase());
      const probe = this.compileTemplate(pieces, this.sample(q), { user: 'u', roles: [], attrs: {} }, src.dialect);
      const chk = checkReadOnly(probe.text, { tables: all, maxLimit: q.maxRows ?? 1000, requireLimit: false });
      if (!chk.ok) throw new QueryDefError(`${q.id}: ${chk.problems.join('; ')}`);
    }
    this.queries.set(q.id, q);
  }

  private sample(q: QueryDef): Record<string, unknown> {
    const a: Record<string, unknown> = {};
    for (const p of q.params ?? []) {
      const one = p.type === 'number' ? 1 : p.type === 'boolean' ? true : p.type === 'date' ? '2026-01-01' : p.options?.[0] ?? 'x';
      a[p.name] = p.list ? [one] : one;
    }
    return a;
  }

  private checkArgs(q: QueryDef, args: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const problems: v.Problem[] = [];
    const defs = new Map((q.params ?? []).map((p) => [p.name, p]));
    for (const k of Object.keys(args)) if (!defs.has(k)) problems.push({ path: k, code: 'unknown', message: `${k} is not a parameter of ${q.id}` });
    for (const p of defs.values()) {
      let raw = Object.hasOwn(args, p.name) ? args[p.name] : undefined;
      if (raw === undefined || raw === null || raw === '') raw = p.default !== undefined ? (p.list ? [p.default] : p.default) : undefined;
      if (raw === undefined) {
        if (p.required) problems.push({ path: p.name, code: 'required', message: `${p.name} is needed` });
        continue;
      }
      const r = paramSchema(p).check(raw, p.name);
      if (r.ok) out[p.name] = r.value;
      else problems.push(...r.problems);
    }
    if (problems.length) throw new BadArguments(problems);
    return out;
  }

  private allowedColumns(src: DataSource, table: string, s: Session): Set<string> | undefined {
    const col = src.collections.find((c) => c.name === table)!;
    const pol = src.policy[table];
    if (!pol || !pol.roles.some((r) => s.roles.includes(r))) return undefined;
    const out = new Set<string>();
    for (const r of s.roles) {
      if (!pol.roles.includes(r)) continue;
      const list = pol.columns?.[r];
      for (const f of list ?? Object.keys(col.fields).filter((k) => !col.fields[k]!.sensitive)) if (Object.hasOwn(col.fields, f) && !col.fields[f]!.sensitive) out.add(f);
    }
    return out;
  }

  private buildSpec(q: QueryDef, src: DataSource, s: Session, args: Record<string, unknown>, size: number, offset: number, keyset: Where | undefined, dry = false): Built {
    const spec = q.spec!;
    const tables = [spec.from, ...(spec.joins ?? []).map((j) => j.table)];
    const filters: Where[] = [];
    const allowed = new Map<string, Set<string>>();
    for (const t of tables) {
      const coll = src.collections.find((c) => c.name === t);
      if (!coll) throw new SqlError(`there is no table ${JSON.stringify(t.slice(0, 60))}`);
      const a = dry ? new Set(Object.keys(coll.fields).filter((f) => !coll.fields[f]!.sensitive)) : this.allowedColumns(src, t, s);
      if (!a) throw new Forbidden(`you cannot read ${t}`);
      allowed.set(t, a);
      const rf = dry ? undefined : src.policy[t]?.rowFilter?.(s);
      if (rf) filters.push(rf);
    }
    const asked = (spec.columns?.length ? spec.columns : undefined) ?? Object.keys(src.collections.find((c) => c.name === spec.from)!.fields).filter((f) => allowed.get(spec.from)!.has(f));
    const cols = asked.filter((c) => {
      if (typeof c !== 'string') return true;
      const [t, f] = c.includes('.') ? (c.split('.') as [string, string]) : [spec.from, c];
      return allowed.get(t)?.has(f) ?? true;
    });
    for (const c of asked) {
      if (typeof c !== 'string') continue;
      const [t, f] = c.includes('.') ? (c.split('.') as [string, string]) : [spec.from, c];
      if (allowed.has(t) && !allowed.get(t)!.has(f) && spec.columns?.length) throw new Forbidden(`you cannot read ${t}.${f}`);
    }
    const base = spec.where ? bindWhere(spec.where, args) : undefined;
    const conds = [...(base ? [base] : []), ...filters, ...(keyset ? [keyset] : [])];
    const where: Where | undefined = conds.length === 0 ? undefined : conds.length === 1 ? conds[0]! : { and: conds };
    const { where: _unbound, ...rest } = spec;
    void _unbound;
    return selectSql({ ...rest, columns: cols, ...(where ? { where } : {}), limit: size, ...(offset ? { offset } : {}) } as SelectSpec, src.collections, { dialect: src.dialect, maxLimit: Math.max(size, q.maxRows ?? 1000), maxOffset: 1_000_000 });
  }

  private compileTemplate(pieces: readonly Piece[], args: Readonly<Record<string, unknown>>, s: Session, dialect: Dialect): Built {
    let text = '';
    const params: (string | number | boolean | null)[] = [];
    const bind = (x: unknown) => {
      params.push(x instanceof Date ? x.toISOString() : (x as string | number | boolean | null));
      return dialect === 'pg' ? `$${params.length}` : '?';
    };
    for (const pc of pieces) {
      if (pc.lit !== undefined) text += pc.lit;
      else {
        const nm = pc.param!;
        if (nm.startsWith('session.')) {
          const k = nm.slice(8);
          const val = k === 'user' ? s.user : s.attrs?.[k];
          if (val === undefined) throw new Forbidden(`the session has no ${k}`);
          text += bind(val);
        } else {
          const a = args[nm];
          if (Array.isArray(a)) {
            if (!a.length) throw new BadArguments([{ path: nm, code: 'min', message: `${nm} needs at least one value` }]);
            text += a.map(bind).join(', ');
          } else if (a === undefined) throw new BadArguments([{ path: nm, code: 'required', message: `${nm} is needed` }]);
          else text += bind(a);
        }
      }
    }
    return { text, params };
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url').slice(0, 22);
  }
  private argsHash(q: QueryDef, args: unknown, s: Session): string {
    return createHash('sha256').update(stable([q.id, args, s.roles.length ? [...s.roles].sort() : [], s.user])).digest('base64url').slice(0, 16);
  }
  private makeCursor(q: QueryDef, args: unknown, s: Session, last: readonly unknown[]): string {
    const body = Buffer.from(JSON.stringify({ q: q.id, h: this.argsHash(q, args, s), v: last })).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }
  private readCursor(q: QueryDef, args: unknown, s: Session, c: string): unknown[] {
    const [body, sig] = c.split('.');
    if (!body || !sig || c.length > 4000) throw new BadCursor('that is not a cursor');
    const a = Buffer.from(sig);
    const b = Buffer.from(this.sign(body));
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new BadCursor('that cursor was not issued here');
    let o: { q?: unknown; h?: unknown; v?: unknown };
    try {
      o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw new BadCursor('that is not a cursor');
    }
    if (o.q !== q.id) throw new BadCursor('that cursor belongs to another query');
    if (o.h !== this.argsHash(q, args, s)) throw new BadCursor('that cursor was made with other arguments');
    if (!Array.isArray(o.v)) throw new BadCursor('that is not a cursor');
    return o.v;
  }

  private cacheFor(q: QueryDef): Cache<QueryResult> {
    let c = this.caches.get(q.id);
    if (!c) this.caches.set(q.id, (c = new Cache<QueryResult>({ ttlMs: q.ttlMs!, max: 500, now: this.now })));
    return c;
  }

  private tablesOf(q: QueryDef, src: DataSource): string[] {
    if (q.spec) return [q.spec.from, ...(q.spec.joins ?? []).map((j) => j.table)];
    const text = (q.sql ?? '').toLowerCase();
    return src.collections.map((c) => c.name).filter((n) => new RegExp(`\\b${n}\\b`).test(text));
  }

  /** Drops every cached result that read `table`. */
  invalidateTable(table: string): number {
    let n = 0;
    for (const c of this.caches.values()) n += c.invalidateTag(`table:${table}`);
    return n;
  }

  async run(id: string, s: Session, r: Request = {}): Promise<QueryResult> {
    const q = this.queries.get(id);
    if (!q) throw new QueryDefError(`no query ${id}`);
    const src = this.sources.get(q.datasource)!;
    const args = this.checkArgs(q, r.args ?? {});
    const pg = q.pagination;
    const maxSize = pg?.maxSize ?? 100;
    const size = r.size === undefined ? pg?.defaultSize ?? 25 : r.size;
    if (!Number.isInteger(size) || size < 1 || size > maxSize) throw new BadArguments([{ path: 'size', code: 'range', message: `size is 1 to ${maxSize}` }]);
    const page = r.page ?? 1;
    if (!Number.isInteger(page) || page < 1 || page > 10_000) throw new BadArguments([{ path: 'page', code: 'range', message: 'page is 1 to 10000' }]);
    if (r.cursor !== undefined && pg?.mode !== 'keyset') throw new BadArguments([{ path: 'cursor', code: 'unknown', message: 'this query does not use cursors' }]);
    const tables = this.tablesOf(q, src);
    for (const t of tables) if (!this.allowedColumns(src, t, s)) throw new Forbidden(`you cannot read ${t}`);
    const userBound = (q.sql ?? '').includes('{{session.') || tables.some((t) => src.policy[t]?.rowFilter);
    const scope = createHash('sha256').update(stable([[...s.roles].sort(), userBound ? s.user : '', userBound ? s.attrs ?? {} : {}])).digest('base64url').slice(0, 12);
    const key = createHash('sha256').update(stable([q.id, args, pg ? [pg.mode, size, page, r.cursor ?? null] : null, scope])).digest('base64url');
    const exec = async (): Promise<QueryResult> => {
      let built: Built;
      let order: { column: string; dir: 'asc' | 'desc' }[] = [];
      if (q.spec) {
        let keyset: Where | undefined;
        if (pg?.mode === 'keyset') {
          order = q.spec.orderBy!.map((o) => ({ column: o.column, dir: o.dir === 'desc' ? ('desc' as const) : ('asc' as const) }));
          if (r.cursor) {
            const vals = this.readCursor(q, args, s, r.cursor);
            if (vals.length !== order.length) throw new BadCursor('that cursor does not fit this query');
            const ors: Where[] = order.map((o, i) => ({
              and: [...order.slice(0, i).map((p, j) => ({ column: p.column, op: '=' as const, value: vals[j] as Scalar })), { column: o.column, op: o.dir === 'asc' ? ('>' as const) : ('<' as const), value: vals[i] as Scalar }],
            }));
            keyset = ors.length === 1 ? ors[0]! : { or: ors };
          }
        }
        built = this.buildSpec(q, src, s, args, size + 1, pg?.mode === 'offset' ? (page - 1) * size : 0, keyset);
      } else {
        const compiled = this.compileTemplate(splitTemplate(q.sql!), args, s, src.dialect);
        const denied: string[] = [];
        for (const t of tables) {
          if (src.policy[t]?.rowFilter) throw new Forbidden(`${t} has row rules; use a spec query for it`);
          const ok = this.allowedColumns(src, t, s)!;
          for (const f of Object.keys(src.collections.find((c) => c.name === t)!.fields)) if (!ok.has(f)) denied.push(f.toLowerCase());
        }
        const chk = checkReadOnly(compiled.text, { tables: tables.map((t) => t.toLowerCase()), deniedColumns: denied, maxLimit: q.maxRows ?? 1000, requireLimit: false });
        if (!chk.ok) throw new Forbidden(`this query is not allowed for you: ${chk.problems.join('; ')}`);
        const cap = Math.min(q.maxRows ?? 1000, pg ? size + 1 : q.maxRows ?? 1000);
        built = { text: limitTo(compiled.text, pg?.mode === 'offset' ? size + 1 : cap), params: compiled.params };
        if (pg?.mode === 'offset') built = { text: `${built.text} OFFSET ${(page - 1) * size}`, params: built.params };
      }
      const rows = await withTimeout(q.timeoutMs ?? 10_000, (signal) => src.run(built, { datasource: src.name, query: q.id, signal }));
      const more = pg ? rows.length > size : false;
      const shown = pg ? rows.slice(0, size) : rows.slice(0, q.maxRows ?? 1000);
      let next: string | undefined;
      if (pg?.mode === 'keyset' && more) {
        const last = shown[shown.length - 1]!;
        const vals = order.map((o) => last[o.column]);
        if (vals.some((x) => x === null || x === undefined)) throw new SqlError('an order column is NULL in the last row; order by NOT NULL columns for keyset paging');
        next = this.makeCursor(q, args, s, vals.map((x) => (x instanceof Date ? x.toISOString() : x)));
      }
      return { query: q.id, rows: shown, page: { mode: pg?.mode ?? 'offset', size: pg ? size : shown.length, ...(pg?.mode === 'offset' ? { page } : {}), hasMore: more, ...(next ? { next } : {}) }, fromCache: false };
    };
    if (!q.ttlMs) return exec();
    const hit = { was: true };
    const res = await this.cacheFor(q).get(key, async () => ((hit.was = false), exec()), tables.map((t) => `table:${t}`));
    return hit.was ? { ...res, fromCache: true } : res;
  }
}
