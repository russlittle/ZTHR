/**
 * One filter tree from three query-string dialects that apps copy from each other. PostgREST style
 * (`age=gte.18&or=(a.eq.1,b.lt.2)&select=id,posts(id,title)&order=age.desc&limit=10&offset=20`, as Supabase speaks),
 * Strapi style (`filters[age][$gte]=18&filters[$or][0][name][$eq]=x&populate[posts][fields][0]=title&sort=name:asc&
 * pagination[page]=2`) and Directus style (`filter[age][_gte]=18&filter[_or][0][a][_eq]=1&fields=id,posts.title&
 * sort=-age&limit=10&page=2`, or the filter as JSON) all parse into the same thing: a tree of and, or and not over
 * comparisons on field paths (a path through relations is just a longer path), a sort list, a limit and offset, and
 * a populate tree of related records to include. `OPERATORS` is the one table that says what each dialect calls each
 * operator. Negated forms fold into their positive twins where one exists (not.eq is ne, not.in is nin).
 *
 * Everything the caller did not ask the app to allow is refused, with the problems listed all at once in the
 * validate block's format: nesting deeper than a cap, too many comparisons, too many values in a list, populate
 * trees deeper or wider than the caps, limits above the maximum, field names that are not plain identifiers, and keys
 * that would pollute prototypes. An optional allow-list limits which field paths may be filtered, sorted or populated.
 * Values stay strings unless a field's type is declared. `matches` evaluates a tree against a row in memory, and
 * `toPagingQuery` turns a simple flat tree into the paging block's query.
 *
 * Out of scope: SQL generation, PostgREST JSON-path operators (`col->>key`), full-text and range operators, and
 * Directus dynamic variables and `deep` (all refused with a message).
 */
import type { Query as PagingQuery } from '../paging/index.ts';
import { Invalid } from '../validate/index.ts';
import type { Problem } from '../validate/index.ts';

export { Invalid };
export type FilterOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'nin' | 'contains' | 'icontains' | 'starts' | 'istarts' | 'ends' | 'iends' | 'null' | 'between';

export type Node =
  | { readonly kind: 'and'; readonly children: readonly Node[] }
  | { readonly kind: 'or'; readonly children: readonly Node[] }
  | { readonly kind: 'not'; readonly child: Node }
  | { readonly kind: 'cmp'; readonly path: readonly string[]; readonly op: FilterOp; readonly value: unknown };

export interface Sort { readonly path: readonly string[]; readonly dir: 'asc' | 'desc'; readonly nulls?: 'first' | 'last' }
export interface Populate { readonly fields: readonly string[] | '*'; readonly relations: Readonly<Record<string, Populate>>; readonly inner?: boolean; readonly alias?: string }
export interface Parsed {
  readonly style: Style;
  readonly filter?: Node;
  readonly sort: readonly Sort[];
  readonly limit: number;
  readonly offset: number;
  readonly populate: Populate;
}
export type Style = 'postgrest' | 'strapi' | 'directus';

/** What each dialect calls each operator. */
export const OPERATORS: Readonly<Record<FilterOp, { readonly postgrest: string; readonly strapi: string; readonly directus: string }>> = {
  eq: { postgrest: 'eq', strapi: '$eq', directus: '_eq' },
  ne: { postgrest: 'neq', strapi: '$ne', directus: '_neq' },
  lt: { postgrest: 'lt', strapi: '$lt', directus: '_lt' },
  lte: { postgrest: 'lte', strapi: '$lte', directus: '_lte' },
  gt: { postgrest: 'gt', strapi: '$gt', directus: '_gt' },
  gte: { postgrest: 'gte', strapi: '$gte', directus: '_gte' },
  in: { postgrest: 'in', strapi: '$in', directus: '_in' },
  nin: { postgrest: 'not.in', strapi: '$notIn', directus: '_nin' },
  contains: { postgrest: 'like', strapi: '$contains', directus: '_contains' },
  icontains: { postgrest: 'ilike', strapi: '$containsi', directus: '_icontains' },
  starts: { postgrest: 'like', strapi: '$startsWith', directus: '_starts_with' },
  istarts: { postgrest: 'ilike', strapi: '$startsWithi', directus: '_istarts_with' },
  ends: { postgrest: 'like', strapi: '$endsWith', directus: '_ends_with' },
  iends: { postgrest: 'ilike', strapi: '$endsWithi', directus: '_iends_with' },
  null: { postgrest: 'is', strapi: '$null', directus: '_null' },
  between: { postgrest: '(two comparisons)', strapi: '$between', directus: '_between' },
};

export interface Limits {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxListLength?: number;
  readonly maxLimit?: number;
  readonly defaultLimit?: number;
  readonly maxPopulateDepth?: number;
  readonly maxPopulateNodes?: number;
  readonly maxParams?: number;
  readonly maxValueLength?: number;
  readonly maxPathLength?: number;
}

export interface Options {
  readonly limits?: Limits;
  /** Field paths ("author.name") that may be used, or a test for them. Omit to allow any plain path. */
  readonly fields?: readonly string[] | ((path: readonly string[]) => boolean);
  /** The operators allowed at all (default every one). */
  readonly ops?: readonly FilterOp[];
  /** Declared types turn the strings of a query into numbers, booleans and dates for those fields. */
  readonly types?: Readonly<Record<string, 'number' | 'boolean' | 'string' | 'date'>>;
}

export class BadFilter extends Invalid {}

const DEFAULTS = { maxDepth: 5, maxNodes: 50, maxListLength: 200, maxLimit: 100, defaultLimit: 25, maxPopulateDepth: 3, maxPopulateNodes: 30, maxParams: 200, maxValueLength: 500, maxPathLength: 5 } as const;

interface Ctx {
  readonly L: Required<Limits>;
  readonly o: Options;
  readonly problems: Problem[];
  nodes: number;
  popNodes: number;
}

const problem = (c: Ctx, path: string, code: string, message: string) => { c.problems.push({ path, code, message }); };

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

function fieldPath(c: Ctx, raw: readonly string[], where: string): readonly string[] | undefined {
  if (raw.length === 0 || raw.length > c.L.maxPathLength) { problem(c, where, 'path', `a field path has 1 to ${c.L.maxPathLength} parts`); return undefined; }
  for (const p of raw) if (!IDENT.test(p) || FORBIDDEN.has(p)) { problem(c, where, 'field', `${JSON.stringify(p.slice(0, 40))} is not a plain field name`); return undefined; }
  const allowed = c.o.fields;
  if (allowed) {
    const ok = typeof allowed === 'function' ? allowed(raw) : allowed.includes(raw.join('.'));
    if (!ok) { problem(c, where, 'unknown-field', `${raw.join('.')} cannot be used here`); return undefined; }
  }
  return raw;
}

function coerce(c: Ctx, path: readonly string[], v: string, where: string): unknown {
  if (v.length > c.L.maxValueLength) { problem(c, where, 'too-long', `a value is longer than ${c.L.maxValueLength} characters`); return v.slice(0, 20); }
  const t = c.o.types?.[path.join('.')];
  if (!t || t === 'string') return v;
  if (t === 'number') { if (!/^-?\d+(\.\d+)?$/.test(v)) { problem(c, where, 'type', `${path.join('.')} needs a number, not ${JSON.stringify(v.slice(0, 20))}`); return v; } return Number(v); }
  if (t === 'boolean') { if (v !== 'true' && v !== 'false') { problem(c, where, 'type', `${path.join('.')} needs true or false`); return v; } return v === 'true'; }
  if (Number.isNaN(Date.parse(v))) { problem(c, where, 'type', `${path.join('.')} needs a date`); return v; }
  return v;
}

function cmp(c: Ctx, path: readonly string[], op: FilterOp, value: unknown, where: string): Node | undefined {
  if (c.o.ops && !c.o.ops.includes(op)) { problem(c, where, 'operator', `the ${op} operator is not allowed`); return undefined; }
  if (++c.nodes > c.L.maxNodes) { if (c.nodes === c.L.maxNodes + 1) problem(c, where, 'too-many', `more than ${c.L.maxNodes} comparisons`); return undefined; }
  if (op === 'in' || op === 'nin') {
    const list = value as string[];
    if (list.length > c.L.maxListLength) { problem(c, where, 'too-long', `a list may hold at most ${c.L.maxListLength} values`); return undefined; }
    return { kind: 'cmp', path, op, value: list.map((v) => coerce(c, path, v, where)) };
  }
  if (op === 'between') {
    const list = value as string[];
    if (list.length !== 2) { problem(c, where, 'between', 'between needs exactly two values'); return undefined; }
    return { kind: 'cmp', path, op, value: list.map((v) => coerce(c, path, v, where)) };
  }
  if (op === 'null') return { kind: 'cmp', path, op, value: value === true };
  return { kind: 'cmp', path, op, value: coerce(c, path, String(value), where) };
}

const group = (kind: 'and' | 'or', children: (Node | undefined)[]): Node | undefined => { const k = children.filter((x): x is Node => x !== undefined); return k.length === 0 ? undefined : k.length === 1 ? k[0]! : kind === 'and' ? { kind: 'and', children: k } : { kind: 'or', children: k }; };

function makeCtx(o: Options): Ctx {
  return { L: { ...DEFAULTS, ...o.limits } as Required<Limits>, o, problems: [], nodes: 0, popNodes: 0 };
}

function pairsOf(q: URLSearchParams | string, c: Ctx): [string, string][] {
  const p = typeof q === 'string' ? new URLSearchParams(q.replace(/^\?/, '')) : q;
  const out = [...p];
  if (out.length > c.L.maxParams) throw new BadFilter([{ path: '(query)', code: 'too-many', message: `more than ${c.L.maxParams} parameters` }]);
  return out;
}

const plain = (p: MPop): Populate => ({ fields: p.fields, ...(p.inner ? { inner: true } : {}), ...(p.alias ? { alias: p.alias } : {}), relations: Object.fromEntries(Object.entries(p.relations).map(([k, v]) => [k, plain(v)])) });

const finish = (c: Ctx, style: Style, filter: Node | undefined, sort: Sort[], limit: number | undefined, offset: number, populate: MPop): Parsed => {
  if (c.problems.length) throw new BadFilter(c.problems);
  return { style, ...(filter ? { filter } : {}), sort, limit: limit ?? c.L.defaultLimit, offset, populate: plain(populate) };
};

function whole(c: Ctx, name: string, v: string | undefined, min: number): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d{1,9}$/.test(v) || Number(v) < min) { problem(c, name, 'number', `${name} must be a whole number from ${min}`); return undefined; }
  return Number(v);
}

function capLimit(c: Ctx, limit: number | undefined): number | undefined {
  if (limit !== undefined && limit > c.L.maxLimit) { problem(c, 'limit', 'limit', `limit may be at most ${c.L.maxLimit}`); return undefined; }
  return limit;
}

interface MPop { fields: string[] | '*'; relations: Record<string, MPop>; inner?: boolean; alias?: string }

function addPopulate(c: Ctx, root: MPop, path: string[], where: string, o: { fields?: string[] | '*'; inner?: boolean; alias?: string } = {}) {
  if (path.length > c.L.maxPopulateDepth) { problem(c, where, 'populate-depth', `related records may be included ${c.L.maxPopulateDepth} levels deep at most`); return; }
  let cur = root;
  for (const seg of path) {
    if (!IDENT.test(seg) || FORBIDDEN.has(seg)) { problem(c, where, 'field', `${JSON.stringify(seg.slice(0, 40))} is not a plain relation name`); return; }
    if (c.o.fields && typeof c.o.fields !== 'function' && !c.o.fields.some((f) => f === seg || f.startsWith(`${seg}.`) || f.startsWith(`${path.slice(0, path.indexOf(seg) + 1).join('.')}.`))) { problem(c, where, 'unknown-field', `${path.join('.')} cannot be included`); return; }
    if (!Object.hasOwn(cur.relations, seg)) {
      if (++c.popNodes > c.L.maxPopulateNodes) { if (c.popNodes === c.L.maxPopulateNodes + 1) problem(c, where, 'populate-size', `more than ${c.L.maxPopulateNodes} related records included`); return; }
      cur.relations[seg] = { fields: '*', relations: Object.create(null) as Record<string, MPop> };
    }
    cur = cur.relations[seg]!;
  }
  if (o.fields !== undefined) cur.fields = o.fields;
  if (o.inner) cur.inner = true;
  if (o.alias) cur.alias = o.alias;
}

// --- PostgREST -------------------------------------------------------------------------------------------------

const PG_OPS: Record<string, FilterOp> = { eq: 'eq', neq: 'ne', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte', in: 'in' };

/** Split "a,b,(c,d),e" at top-level commas (parentheses and double quotes respected). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) { cur += ch; if (ch === '\\' && i + 1 < s.length) cur += s[++i]!; else if (ch === '"') q = false; continue; }
    if (ch === '"') { q = true; cur += ch; } else if (ch === '(') { depth++; cur += ch; } else if (ch === ')') { depth--; cur += ch; } else if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

const unquote = (s: string) => (s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1).replace(/\\(["\\])/g, '$1') : s);

function pgLeaf(c: Ctx, col: string, rest: string, where: string): Node | undefined {
  const path = fieldPath(c, col.split('.'), where);
  let not = false;
  let r = rest;
  if (r.startsWith('not.')) { not = true; r = r.slice(4); }
  const dot = r.indexOf('.');
  const opName = dot < 0 ? r : r.slice(0, dot);
  const val = dot < 0 ? '' : r.slice(dot + 1);
  if (!path) return undefined;
  let node: Node | undefined;
  if (opName === 'in') {
    if (!/^\(.*\)$/.test(val)) { problem(c, where, 'syntax', 'in needs a list like in.(1,2,3)'); return undefined; }
    const list = val === '()' ? [] : splitTop(val.slice(1, -1)).map(unquote);
    node = cmp(c, path, not ? 'nin' : 'in', list, where);
    return node;
  }
  if (opName === 'is') {
    if (val === 'null') return cmp(c, path, 'null', !not, where);
    if (val === 'true' || val === 'false') { node = cmp(c, path, not ? 'ne' : 'eq', val, where); return node && node.kind === 'cmp' ? { ...node, value: val === 'true' } : node; }
    problem(c, where, 'syntax', 'is takes null, true or false'); return undefined;
  }
  if (opName === 'like' || opName === 'ilike') {
    const ci = opName === 'ilike';
    const lead = val.startsWith('*'), trail = val.endsWith('*') && val.length > 1;
    const core = val.slice(lead ? 1 : 0, trail ? -1 : undefined);
    if (core.includes('*') || core.includes('%')) { problem(c, where, 'pattern', 'only a * at the start or end of a pattern is supported'); return undefined; }
    const op: FilterOp = lead && trail ? (ci ? 'icontains' : 'contains') : lead ? (ci ? 'iends' : 'ends') : trail ? (ci ? 'istarts' : 'starts') : 'eq';
    node = cmp(c, path, op, core, where);
    return node && not ? { kind: 'not', child: node } : node;
  }
  const op = Object.hasOwn(PG_OPS, opName) ? PG_OPS[opName]! : undefined;
  if (!op) { problem(c, where, 'operator', `${JSON.stringify(opName.slice(0, 20))} is not an operator`); return undefined; }
  const inverse: Partial<Record<FilterOp, FilterOp>> = { eq: 'ne', ne: 'eq', lt: 'gte', gte: 'lt', gt: 'lte', lte: 'gt' };
  node = cmp(c, path, not ? inverse[op]! : op, val, where);
  return node;
}

function pgGroup(c: Ctx, kind: 'and' | 'or', body: string, depth: number, where: string): Node | undefined {
  if (depth > c.L.maxDepth) { problem(c, where, 'depth', `filters may be nested ${c.L.maxDepth} levels deep at most`); return undefined; }
  if (!/^\(.*\)$/.test(body)) { problem(c, where, 'syntax', `${kind} needs a list like ${kind}=(a.eq.1,b.eq.2)`); return undefined; }
  const parts = splitTop(body.slice(1, -1));
  const kids = parts.map((p) => {
    const m = /^(not\.)?(and|or)(\(.*\))$/.exec(p);
    if (m) { const g = pgGroup(c, m[2] as 'and' | 'or', m[3]!, depth + 1, where); return g && m[1] ? { kind: 'not', child: g } as Node : g; }
    const d = p.indexOf('.');
    if (d < 1) { problem(c, where, 'syntax', `${JSON.stringify(p.slice(0, 30))} should look like column.operator.value`); return undefined; }
    // A dotted column path inside a group is not distinguishable from operator syntax; groups take plain columns.
    const col = p.slice(0, d);
    return pgLeaf(c, col, p.slice(d + 1), where);
  });
  return group(kind, kids);
}

function pgSelect(c: Ctx, s: string, root: MPop, path: string[], depth: number) {
  const fields: string[] = [];
  for (const item of splitTop(s)) {
    const t = item.trim();
    if (!t) continue;
    const m = /^(?:([A-Za-z_]\w*):)?([A-Za-z_]\w*)(!inner|!left|![A-Za-z_]\w*)?\((.*)\)$/s.exec(t);
    if (m) {
      const [, alias, rel, hint, inner] = m;
      if (depth + 1 > c.L.maxPopulateDepth) { problem(c, 'select', 'populate-depth', `related records may be included ${c.L.maxPopulateDepth} levels deep at most`); continue; }
      addPopulate(c, root, [...path, rel!], 'select', { ...(hint === '!inner' ? { inner: true } : {}), ...(alias ? { alias } : {}) });
      pgSelect(c, inner!, root, [...path, rel!], depth + 1);
    } else if (t === '*' || IDENT.test(t)) fields.push(t);
    else problem(c, 'select', 'field', `${JSON.stringify(t.slice(0, 40))} is not a field or a related record`);
  }
  let node: MPop | undefined = root;
  for (const p of path) node = node?.relations[p];
  if (node && fields.length) node.fields = fields.includes('*') ? '*' : fields;
}

export function parsePostgrest(q: URLSearchParams | string, o: Options = {}): Parsed {
  const c = makeCtx(o);
  const kids: (Node | undefined)[] = [];
  const sort: Sort[] = [];
  let limit: number | undefined, offset = 0;
  const pop: MPop = { fields: '*', relations: Object.create(null) as Record<string, MPop> };
  for (const [k, v] of pairsOf(q, c)) {
    if (k === 'select') pgSelect(c, v, pop, [], 0);
    else if (k === 'order') {
      for (const part of v.split(',').filter(Boolean)) {
        const [col, ...mods] = part.split('.');
        const path = fieldPath(c, (col ?? '').split('.'), 'order');
        if (!path) continue;
        const bad = mods.filter((m) => !['asc', 'desc', 'nullsfirst', 'nullslast'].includes(m));
        if (bad.length) { problem(c, 'order', 'syntax', `${JSON.stringify(bad[0])} is not asc, desc, nullsfirst or nullslast`); continue; }
        sort.push({ path, dir: mods.includes('desc') ? 'desc' : 'asc', ...(mods.includes('nullsfirst') ? { nulls: 'first' as const } : mods.includes('nullslast') ? { nulls: 'last' as const } : {}) });
      }
    } else if (k === 'limit') limit = capLimit(c, whole(c, 'limit', v, 1));
    else if (k === 'offset') offset = whole(c, 'offset', v, 0) ?? 0;
    else if (k === 'and' || k === 'or') kids.push(pgGroup(c, k, v, 1, k));
    else if (k === 'not.and' || k === 'not.or') { const g = pgGroup(c, k === 'not.and' ? 'and' : 'or', v, 1, k); if (g) kids.push({ kind: 'not', child: g }); }
    else if (k.includes('->')) problem(c, k, 'unsupported', 'JSON path columns are not supported');
    else kids.push(pgLeaf(c, k, v, k));
  }
  return finish(c, 'postgrest', group('and', kids), sort, limit, offset, pop);
}

/** "items=0-24" or "0-24" (a PostgREST Range header) as offset and limit. */
export function parseRangeHeader(h: string, o: { maxLimit?: number } = {}): { offset: number; limit: number } {
  const m = /^(?:[a-z]+=)?(\d{1,9})-(\d{1,9})?$/.exec(h.trim());
  if (!m) throw new BadFilter([{ path: 'range', code: 'range', message: 'a range looks like 0-24' }]);
  const from = Number(m[1]);
  const to = m[2] === undefined ? undefined : Number(m[2]);
  if (to !== undefined && to < from) throw new BadFilter([{ path: 'range', code: 'range', message: 'the end of a range cannot be before its start' }]);
  const max = o.maxLimit ?? DEFAULTS.maxLimit;
  const limit = to === undefined ? max : to - from + 1;
  if (limit > max) throw new BadFilter([{ path: 'range', code: 'limit', message: `a range may cover at most ${max} items` }]);
  return { offset: from, limit };
}

// --- bracket keys (Strapi, Directus) -----------------------------------------------------------------------------

type Tree = { [key: string]: Tree | string };

function bracketTree(c: Ctx, pairs: [string, string][], rootName: string): Tree | string | undefined {
  const root: Tree = Object.create(null);
  let found = false;
  for (const [k, v] of pairs) {
    const m = /^([A-Za-z_]\w*)((?:\[[^\]]*\])*)$/.exec(k);
    if (!m || m[1] !== rootName) continue;
    found = true;
    const keys = [...m[2]!.matchAll(/\[([^\]]*)\]/g)].map((x) => x[1]!);
    if (keys.length === 0) return v;
    if (keys.length > c.L.maxDepth * 3 + 3) { problem(c, k, 'depth', 'this parameter is nested too deeply'); continue; }
    let cur = root;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      if (FORBIDDEN.has(key)) { problem(c, k, 'field', `${JSON.stringify(key)} is not allowed in a key`); break; }
      const k2 = key === '' ? String(Object.keys(cur).length) : key;
      if (i === keys.length - 1) { cur[k2] = v; break; }
      const next = cur[k2];
      if (typeof next === 'string') { problem(c, k, 'syntax', `${k2} is given both a value and a nested value`); break; }
      cur = (cur[k2] ??= Object.create(null) as Tree) as Tree;
    }
  }
  return found ? root : undefined;
}

const listOf = (t: Tree | string): string[] => (typeof t === 'string' ? [t] : Object.keys(t).sort((a, b) => Number(a) - Number(b)).map((k) => (typeof t[k] === 'string' ? (t[k] as string) : '')));

function sortList(c: Ctx, raw: string[], style: 'strapi' | 'directus'): Sort[] {
  const out: Sort[] = [];
  for (const part of raw.flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean)) {
    let field = part, dir: 'asc' | 'desc' = 'asc';
    if (style === 'strapi') { const m = /^(.+?)(?::(asc|desc))?$/.exec(part)!; field = m[1]!; dir = (m[2] as 'asc' | 'desc' | undefined) ?? 'asc'; } else if (part.startsWith('-')) { field = part.slice(1); dir = 'desc'; }
    const path = fieldPath(c, field.split(style === 'strapi' ? '.' : '.'), 'sort');
    if (path) out.push({ path, dir });
  }
  return out;
}

// --- Strapi ----------------------------------------------------------------------------------------------------

const STRAPI_OPS: Record<string, FilterOp> = { $eq: 'eq', $ne: 'ne', $lt: 'lt', $lte: 'lte', $gt: 'gt', $gte: 'gte', $in: 'in', $notIn: 'nin', $contains: 'contains', $containsi: 'icontains', $startsWith: 'starts', $startsWithi: 'istarts', $endsWith: 'ends', $endsWithi: 'iends', $null: 'null', $between: 'between' };
const STRAPI_NEG: Record<string, FilterOp> = { $notContains: 'contains', $notContainsi: 'icontains' };

function strapiNode(c: Ctx, t: Tree | string, path: readonly string[], depth: number, where: string): Node | undefined {
  if (depth > c.L.maxDepth) { problem(c, where, 'depth', `filters may be nested ${c.L.maxDepth} levels deep at most`); return undefined; }
  if (typeof t === 'string') { const p = fieldPath(c, path, where); return p ? cmp(c, p, 'eq', t, where) : undefined; }
  const kids: (Node | undefined)[] = [];
  for (const key of Object.keys(t)) {
    const v = t[key]!;
    if (key === '$and' || key === '$or') {
      if (typeof v === 'string') { problem(c, where, 'syntax', `${key} needs a list`); continue; }
      kids.push(group(key === '$and' ? 'and' : 'or', Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((i) => strapiNode(c, v[i]!, path, depth + 1, `${where}[${key}][${i}]`))));
    } else if (key === '$not') { const n = strapiNode(c, v, path, depth + 1, `${where}[$not]`); if (n) kids.push({ kind: 'not', child: n }); }
    else if (key.startsWith('$')) {
      const p = fieldPath(c, path, where);
      if (!p) continue;
      if (Object.hasOwn(STRAPI_NEG, key)) { const n = cmp(c, p, STRAPI_NEG[key]!, typeof v === 'string' ? v : '', where); if (n) kids.push({ kind: 'not', child: n }); continue; }
      const op = Object.hasOwn(STRAPI_OPS, key) ? STRAPI_OPS[key]! : (key === '$notNull' ? 'null' : undefined);
      if (!op) { problem(c, where, 'operator', `${JSON.stringify(key.slice(0, 20))} is not an operator`); continue; }
      if (key === '$notNull') kids.push(cmp(c, p, 'null', v === 'false', where));
      else if (op === 'in' || op === 'nin' || op === 'between') kids.push(cmp(c, p, op, listOf(v), where));
      else if (op === 'null') kids.push(cmp(c, p, 'null', v !== 'false', where));
      else if (typeof v === 'string') kids.push(cmp(c, p, op, v, where));
      else problem(c, where, 'syntax', `${key} needs one value`);
    } else kids.push(strapiNode(c, v, [...path, key], depth, `${where}[${key}]`));
  }
  return group('and', kids);
}

export function parseStrapi(q: URLSearchParams | string, o: Options = {}): Parsed {
  const c = makeCtx(o);
  const pairs = pairsOf(q, c);
  const ft = bracketTree(c, pairs, 'filters');
  const filter = ft && typeof ft !== 'string' ? strapiNode(c, ft, [], 1, 'filters') : undefined;
  const st = bracketTree(c, pairs, 'sort');
  const sort = st === undefined ? [] : sortList(c, listOf(st), 'strapi');
  const pg = bracketTree(c, pairs, 'pagination');
  let limit: number | undefined, offset = 0;
  if (pg && typeof pg !== 'string') {
    const size = whole(c, 'pagination[pageSize]', pg.pageSize as string | undefined, 1) ?? whole(c, 'pagination[limit]', pg.limit as string | undefined, 1);
    limit = capLimit(c, size);
    const page = whole(c, 'pagination[page]', pg.page as string | undefined, 1);
    offset = page !== undefined ? (page - 1) * (limit ?? c.L.defaultLimit) : (whole(c, 'pagination[start]', pg.start as string | undefined, 0) ?? 0);
  }
  const pop: MPop = { fields: '*', relations: Object.create(null) as Record<string, MPop> };
  const fl = bracketTree(c, pairs, 'fields');
  if (fl !== undefined) pop.fields = listOf(fl).flatMap((x) => x.split(',')).filter((x) => { if (IDENT.test(x) || x === '*') return true; problem(c, 'fields', 'field', `${JSON.stringify(x.slice(0, 40))} is not a field`); return false; });
  const pt = bracketTree(c, pairs, 'populate');
  if (typeof pt === 'string') {
    if (pt !== '*') for (const rel of pt.split(',').filter(Boolean)) addPopulate(c, pop, rel.split('.'), 'populate');
  } else if (pt) strapiPopulate(c, pop, [], pt, 'populate');
  return finish(c, 'strapi', filter, sort, limit, offset, pop);
}

function strapiPopulate(c: Ctx, root: MPop, path: string[], t: Tree, where: string) {
  for (const key of Object.keys(t)) {
    const v = t[key]!;
    if (key === 'fields') { addPopulate(c, root, path, where, { fields: listOf(v).flatMap((x) => x.split(',')) }); continue; }
    if (key === 'populate') { if (typeof v === 'string') { if (v !== '*') for (const r of v.split(',').filter(Boolean)) addPopulate(c, root, [...path, r], where); } else strapiPopulate(c, root, path, v, `${where}[populate]`); continue; }
    if (key === 'filters' || key === 'sort' || key === 'pagination') { problem(c, `${where}[${key}]`, 'unsupported', `${key} inside populate is not supported; filter the related records with their own request`); continue; }
    if (typeof v === 'string') { if (v === '*' || v === 'true') addPopulate(c, root, [...path, key], where); else problem(c, `${where}[${key}]`, 'syntax', 'populate takes * or a nested object'); }
    else { addPopulate(c, root, [...path, key], where); strapiPopulate(c, root, [...path, key], v, `${where}[${key}]`); }
  }
}

// --- Directus --------------------------------------------------------------------------------------------------

const DIRECTUS_OPS: Record<string, FilterOp> = { _eq: 'eq', _neq: 'ne', _lt: 'lt', _lte: 'lte', _gt: 'gt', _gte: 'gte', _in: 'in', _nin: 'nin', _contains: 'contains', _icontains: 'icontains', _starts_with: 'starts', _istarts_with: 'istarts', _ends_with: 'ends', _iends_with: 'iends', _null: 'null', _between: 'between' };
const DIRECTUS_NEG: Record<string, FilterOp> = { _ncontains: 'contains', _nicontains: 'icontains', _nstarts_with: 'starts', _nistarts_with: 'istarts', _nends_with: 'ends', _niends_with: 'iends', _nbetween: 'between' };

function directusNode(c: Ctx, t: Tree | string | unknown, path: readonly string[], depth: number, where: string): Node | undefined {
  if (depth > c.L.maxDepth) { problem(c, where, 'depth', `filters may be nested ${c.L.maxDepth} levels deep at most`); return undefined; }
  if (t === null || typeof t !== 'object') { const p = fieldPath(c, path, where); return p ? cmp(c, p, 'eq', String(t), where) : undefined; }
  const obj = t as Record<string, unknown>;
  const kids: (Node | undefined)[] = [];
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN.has(key)) { problem(c, where, 'field', `${JSON.stringify(key)} is not allowed in a key`); continue; }
    const v = obj[key];
    if (key === '_and' || key === '_or') {
      const items = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((i) => (v as Record<string, unknown>)[i]) : [];
      kids.push(group(key === '_and' ? 'and' : 'or', items.map((x, i) => directusNode(c, x, path, depth + 1, `${where}[${key}][${i}]`))));
    } else if (key.startsWith('_')) {
      const p = fieldPath(c, path, where);
      if (!p) continue;
      if (key === '_nnull') { kids.push(cmp(c, p, 'null', false, where)); continue; }
      if (key === '_empty' || key === '_nempty') { const n = cmp(c, p, 'eq', '', where); if (n) kids.push(key === '_empty' ? n : { kind: 'not', child: n }); continue; }
      const neg = Object.hasOwn(DIRECTUS_NEG, key);
      const op = neg ? DIRECTUS_NEG[key]! : Object.hasOwn(DIRECTUS_OPS, key) ? DIRECTUS_OPS[key]! : undefined;
      if (!op) { problem(c, where, 'operator', `${JSON.stringify(key.slice(0, 20))} is not an operator`); continue; }
      const sv = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v : v && typeof v === 'object' ? listOf(v as Tree) : String(v);
      if (typeof sv === 'string' && sv.startsWith('$')) { problem(c, where, 'unsupported', 'dynamic variables such as $CURRENT_USER are not supported'); continue; }
      let n: Node | undefined;
      if (op === 'in' || op === 'nin' || op === 'between') n = cmp(c, p, op, Array.isArray(sv) ? sv : sv.split(','), where);
      else if (op === 'null') n = cmp(c, p, 'null', sv !== 'false', where);
      else if (typeof sv === 'string') n = cmp(c, p, op, sv, where);
      else problem(c, where, 'syntax', `${key} needs one value`);
      if (n) kids.push(neg ? { kind: 'not', child: n } : n);
    } else kids.push(directusNode(c, v, [...path, key], depth, `${where}[${key}]`));
  }
  return group('and', kids);
}

export function parseDirectus(q: URLSearchParams | string, o: Options = {}): Parsed {
  const c = makeCtx(o);
  const pairs = pairsOf(q, c);
  let filter: Node | undefined;
  const direct = pairs.find(([k]) => k === 'filter');
  if (direct) {
    if (direct[1].length > 10_000) problem(c, 'filter', 'too-long', 'the filter JSON is too long');
    else {
      try {
        const j = JSON.parse(direct[1], (k, v) => (FORBIDDEN.has(k) ? undefined : v)) as unknown;
        filter = directusNode(c, j, [], 1, 'filter');
      } catch { problem(c, 'filter', 'json', 'the filter is not valid JSON'); }
    }
  } else {
    const ft = bracketTree(c, pairs, 'filter');
    if (ft && typeof ft !== 'string') filter = directusNode(c, ft, [], 1, 'filter');
  }
  if (pairs.some(([k]) => k === 'deep' || k.startsWith('deep['))) problem(c, 'deep', 'unsupported', 'deep (filters on related lists) is not supported');
  const sortRaw = pairs.filter(([k]) => k === 'sort' || k.startsWith('sort[')).map(([, v]) => v);
  const sort = sortList(c, sortRaw, 'directus');
  const lp = pairs.find(([k]) => k === 'limit')?.[1];
  if (lp === '-1') problem(c, 'limit', 'limit', `all items cannot be requested; limit may be at most ${c.L.maxLimit}`);
  const limit = lp === '-1' ? undefined : capLimit(c, whole(c, 'limit', lp, 1));
  const pageP = whole(c, 'page', pairs.find(([k]) => k === 'page')?.[1], 1);
  const offset = pageP !== undefined ? (pageP - 1) * (limit ?? c.L.defaultLimit) : (whole(c, 'offset', pairs.find(([k]) => k === 'offset')?.[1], 0) ?? 0);
  const pop: MPop = { fields: '*', relations: Object.create(null) as Record<string, MPop> };
  const fp = pairs.find(([k]) => k === 'fields')?.[1];
  if (fp !== undefined) {
    const own: string[] = [];
    for (const f of fp.split(',').map((x) => x.trim()).filter(Boolean)) {
      const parts = f.split('.');
      const last = parts.pop()!;
      if (last !== '*' && !IDENT.test(last)) { problem(c, 'fields', 'field', `${JSON.stringify(f.slice(0, 40))} is not a field`); continue; }
      if (parts.length === 0) own.push(last);
      else { addPopulate(c, pop, parts, 'fields'); let n: MPop | undefined = pop; for (const p of parts) n = n?.relations[p]; if (n) n.fields = n.fields === '*' && last === '*' ? '*' : [...(n.fields === '*' ? [] : n.fields), last].filter((x: string, i: number, a: string[]) => a.indexOf(x) === i); }
    }
    pop.fields = own.length ? (own.includes('*') ? '*' : own) : '*';
  }
  return finish(c, 'directus', filter, sort, limit, offset, pop);
}

/** Pick the dialect from what the query looks like. */
export function detectStyle(q: URLSearchParams | string): Style {
  const keys = [...(typeof q === 'string' ? new URLSearchParams(q.replace(/^\?/, '')) : q).keys()];
  if (keys.some((k) => k.startsWith('filters[') || k.startsWith('pagination[') || k.startsWith('populate'))) return 'strapi';
  if (keys.some((k) => k === 'filter' || k.startsWith('filter[') || k === 'fields' || k === 'page')) return 'directus';
  return 'postgrest';
}

export function parseQuery(q: URLSearchParams | string, o: Options = {}, style: Style = detectStyle(q)): Parsed {
  return style === 'strapi' ? parseStrapi(q, o) : style === 'directus' ? parseDirectus(q, o) : parsePostgrest(q, o);
}

// --- use of the tree -------------------------------------------------------------------------------------------

const valueAt = (row: unknown, path: readonly string[]): unknown => { let v = row; for (const p of path) { if (v === null || typeof v !== 'object' || !Object.hasOwn(v, p)) return undefined; v = (v as Record<string, unknown>)[p]; } return v; };
const order = (a: unknown, b: unknown): number => (a === b ? 0 : (a as never) < (b as never) ? -1 : 1);

/** Does the row satisfy the tree. A missing value satisfies only `null` and `ne`/`nin`/negations. */
export function matches(n: Node | undefined, row: unknown): boolean {
  if (!n) return true;
  if (n.kind === 'and') return n.children.every((k) => matches(k, row));
  if (n.kind === 'or') return n.children.some((k) => matches(k, row));
  if (n.kind === 'not') return !matches(n.child, row);
  const v = valueAt(row, n.path);
  const missing = v === undefined || v === null;
  const ci = (x: unknown) => String(x).toLowerCase();
  switch (n.op) {
    case 'eq': return !missing && String(v) === String(n.value);
    case 'ne': return missing || String(v) !== String(n.value);
    case 'lt': return !missing && order(v, n.value) < 0;
    case 'lte': return !missing && order(v, n.value) <= 0;
    case 'gt': return !missing && order(v, n.value) > 0;
    case 'gte': return !missing && order(v, n.value) >= 0;
    case 'in': return !missing && (n.value as unknown[]).some((x) => String(x) === String(v));
    case 'nin': return missing || !(n.value as unknown[]).some((x) => String(x) === String(v));
    case 'contains': return !missing && String(v).includes(String(n.value));
    case 'icontains': return !missing && ci(v).includes(ci(n.value));
    case 'starts': return !missing && String(v).startsWith(String(n.value));
    case 'istarts': return !missing && ci(v).startsWith(ci(n.value));
    case 'ends': return !missing && String(v).endsWith(String(n.value));
    case 'iends': return !missing && ci(v).endsWith(ci(n.value));
    case 'null': return n.value === true ? missing : !missing;
    case 'between': { const [a, b] = n.value as unknown[]; return !missing && order(v, a) >= 0 && order(v, b) <= 0; }
  }
}

/** The same tree written one way, whatever dialect it came from, for cache keys and logs. */
export function canonical(n: Node | undefined): string {
  if (!n) return '';
  if (n.kind === 'and' || n.kind === 'or') return `${n.kind}(${n.children.map(canonical).sort().join(',')})`;
  if (n.kind === 'not') return `not(${canonical(n.child)})`;
  return `${n.path.join('.')} ${n.op} ${JSON.stringify(n.value)}`;
}

/** The paging block's query for a tree that is a plain AND of simple comparisons; otherwise says why not. */
export function toPagingQuery(p: Parsed): PagingQuery {
  const nodes = !p.filter ? [] : p.filter.kind === 'and' ? p.filter.children : [p.filter];
  const filters = nodes.map((n) => {
    if (n.kind !== 'cmp' || n.path.length !== 1) throw new BadFilter([{ path: 'filter', code: 'unsupported', message: 'only a flat list of comparisons on this record\'s own fields can be used here' }]);
    if (!['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'contains'].includes(n.op)) throw new BadFilter([{ path: n.path.join('.'), code: 'operator', message: `${n.op} cannot be used here` }]);
    return { field: n.path[0]!, op: n.op as 'eq', value: n.value };
  });
  if (p.sort.length > 1 || p.sort.some((s) => s.path.length !== 1)) throw new BadFilter([{ path: 'sort', code: 'unsupported', message: 'only one sort on this record\'s own fields can be used here' }]);
  return { ...(p.sort[0] ? { sort: { field: p.sort[0].path[0]!, dir: p.sort[0].dir } } : {}), ...(filters.length ? { filters } : {}), limit: p.limit };
}
