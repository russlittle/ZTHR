/**
 * Saved views on any table: a named filter, sort order, grouping and set of hidden columns that a person keeps for
 * themselves or shares. A table is declared once (its fields, their types, which are sensitive); a view is checked
 * against that declaration when saved and again each time it is used. Filters are the rest-filter-syntax block's tree,
 * so a view can be written from a PostgREST, Strapi or Directus query string and compiled back to that one tree.
 *
 * What a view may never do is widen access. Compiling a view for a person always ANDs in the row scope the caller
 * supplies (their own rows, their team's) and drops or refuses fields they cannot read: columns they cannot read
 * are removed, and a view whose filter, sort or grouping relies on a field they cannot read is refused rather than
 * run, because the rows that pass such a filter would tell them what the field holds. Views are private, shared with
 * named people as viewer or editor, or public to everyone who can use the table (publishing needs the right to).
 * Only the owner shares, only to people who can read every field the view depends on, and an editor can change the
 * view but not who sees it. Saves carry a version so two people editing the same view do not silently overwrite one
 * another. Values `@me` and `@today` in a filter are filled in per person at compile time.
 *
 * Out of scope: rendering, SQL generation, and storing views durably (the store is an in-memory map behind an
 * interface).
 */
import { canonical, matches, parseQuery } from '../rest-filter-syntax/index.ts';
import type { Node, Options as FilterOptions, Sort } from '../rest-filter-syntax/index.ts';

export type { Node, Sort };

export class ViewError extends Error {}
export class NotAllowed extends ViewError {}
export class NotFound extends ViewError {}
export class VersionConflict extends ViewError {}
export class FieldDenied extends ViewError {
  readonly fields: readonly string[];
  constructor(message: string, fields: readonly string[]) { super(message); this.fields = fields; }
}

export interface FieldDef { readonly name: string; readonly type: 'text' | 'number' | 'boolean' | 'date' | 'select'; readonly label?: string; readonly sensitive?: boolean }
export interface TableDef { readonly name: string; readonly fields: readonly FieldDef[] }

export interface Person {
  readonly id: string;
  /** May publish a view to everyone. */
  readonly canPublish?: boolean;
  /** May manage the table's shared defaults. */
  readonly admin?: boolean;
}

export interface Access {
  /** Can this person read the field? Called with the table and field name. */
  readonly canRead: (who: string, table: string, field: string) => boolean;
}

export type Visibility = 'private' | 'shared' | 'public';
export interface Share { readonly who: string; readonly role: 'viewer' | 'editor' }

export interface View {
  readonly id: string;
  readonly table: string;
  readonly name: string;
  readonly owner: string;
  readonly visibility: Visibility;
  readonly shares: readonly Share[];
  readonly filter?: Node;
  readonly sort: readonly Sort[];
  readonly groupBy: readonly string[];
  readonly hidden: readonly string[];
  readonly version: number;
  readonly created: string;
  readonly updated: string;
}

export interface ViewInput {
  readonly name: string;
  readonly filter?: Node | undefined;
  readonly sort?: readonly Sort[];
  readonly groupBy?: readonly string[];
  readonly hidden?: readonly string[];
}

export interface Compiled {
  readonly table: string;
  readonly filter?: Node;
  readonly sort: readonly Sort[];
  readonly groupBy: readonly string[];
  readonly columns: readonly string[];
}

export interface ViewStore { get(id: string): View | undefined; put(v: View): void; delete(id: string): void; all(): View[] }
export function memoryViews(): ViewStore {
  const m = new Map<string, View>();
  return { get: (id) => { const v = m.get(id); return v ? structuredClone(v) : undefined; }, put: (v) => void m.set(v.id, structuredClone(v)), delete: (id) => void m.delete(id), all: () => [...m.values()].map((v) => structuredClone(v)) };
}

export interface EngineOptions {
  readonly tables: readonly TableDef[];
  readonly access: Access;
  readonly store?: ViewStore;
  readonly now?: () => Date;
  readonly id?: () => string;
  readonly maxViewsPerOwner?: number;
  readonly maxGroupBy?: number;
}

const fieldsIn = (n: Node | undefined): string[] => (!n ? [] : n.kind === 'cmp' ? [n.path[0]!] : n.kind === 'not' ? fieldsIn(n.child) : n.children.flatMap(fieldsIn));

/** Replace @me and @today in comparison values. */
function fill(n: Node | undefined, who: string, today: string): Node | undefined {
  if (!n) return n;
  if (n.kind === 'and' || n.kind === 'or') return { kind: n.kind, children: n.children.map((c) => fill(c, who, today)!) };
  if (n.kind === 'not') return { kind: 'not', child: fill(n.child, who, today)! };
  const sub = (v: unknown) => (v === '@me' ? who : v === '@today' ? today : v);
  return { ...n, value: Array.isArray(n.value) ? n.value.map(sub) : sub(n.value) };
}

export class ViewEngine {
  readonly #tables: Map<string, TableDef>;
  readonly #store: ViewStore;
  readonly #o: EngineOptions;
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #defaults = new Map<string, string>();
  #seq = 0;

  constructor(o: EngineOptions) {
    this.#o = o;
    this.#tables = new Map(o.tables.map((t) => [t.name, t]));
    this.#store = o.store ?? memoryViews();
    this.#now = o.now ?? (() => new Date());
    this.#id = o.id ?? (() => `view-${++this.#seq}`);
  }

  table(name: string): TableDef {
    const t = this.#tables.get(name);
    if (!t) throw new NotFound(`no table ${name}`);
    return t;
  }

  /** Options for rest-filter-syntax so a query string can only mention this table's fields. */
  filterOptions(table: string): FilterOptions {
    const t = this.table(table);
    const types: Record<string, 'number' | 'boolean' | 'string' | 'date'> = {};
    for (const f of t.fields) types[f.name] = f.type === 'number' ? 'number' : f.type === 'boolean' ? 'boolean' : f.type === 'date' ? 'date' : 'string';
    return { fields: (p) => p.length === 1 && t.fields.some((f) => f.name === p[0]), types };
  }

  /** A view's content written as a query string in any of the three dialects. */
  fromQuery(table: string, name: string, query: string): ViewInput {
    const p = parseQuery(query, this.filterOptions(table));
    return { name, ...(p.filter ? { filter: p.filter } : {}), sort: p.sort, ...(p.populate.fields !== '*' ? { hidden: this.table(table).fields.map((f) => f.name).filter((f) => !(p.populate.fields as readonly string[]).includes(f)) } : {}) };
  }

  #check(table: string, i: ViewInput): void {
    const t = this.table(table);
    const known = new Set(t.fields.map((f) => f.name));
    const name = i.name?.trim();
    if (!name || name.length > 80) throw new ViewError('a view needs a name of 1 to 80 characters');
    if (/[\u0000-\u001f<>]/.test(name)) throw new ViewError('a view name cannot hold control characters or angle brackets');
    const bad = [...fieldsIn(i.filter), ...(i.sort ?? []).map((s) => s.path[0]!), ...(i.groupBy ?? []), ...(i.hidden ?? [])].filter((f) => !known.has(f));
    if ([...(i.sort ?? [])].some((s) => s.path.length !== 1)) throw new ViewError('a view can sort only by this table\'s own fields');
    if (bad.length) throw new ViewError(`${table} has no field ${[...new Set(bad)].join(', ')}`);
    if ((i.groupBy ?? []).length > (this.#o.maxGroupBy ?? 3)) throw new ViewError(`a view may group by at most ${this.#o.maxGroupBy ?? 3} fields`);
    if (new Set(i.groupBy ?? []).size !== (i.groupBy ?? []).length) throw new ViewError('a field is named twice in the grouping');
    if ((i.hidden ?? []).length >= t.fields.length) throw new ViewError('a view cannot hide every field');
  }

  /** Make a view. The creator owns it, and it starts private. */
  create(who: Person, table: string, i: ViewInput): View {
    this.#check(table, i);
    const mine = this.#store.all().filter((v) => v.owner === who.id).length;
    if (mine >= (this.#o.maxViewsPerOwner ?? 100)) throw new ViewError(`you already have ${mine} views; delete one first`);
    if (this.#store.all().some((v) => v.owner === who.id && v.table === table && v.name === i.name.trim())) throw new ViewError(`you already have a view called ${i.name.trim()} on ${table}`);
    const t = this.#now().toISOString();
    const v: View = { id: this.#id(), table, name: i.name.trim(), owner: who.id, visibility: 'private', shares: [], ...(i.filter ? { filter: i.filter } : {}), sort: i.sort ?? [], groupBy: i.groupBy ?? [], hidden: i.hidden ?? [], version: 1, created: t, updated: t };
    this.#store.put(v);
    return v;
  }

  get(id: string): View {
    const v = this.#store.get(id);
    if (!v) throw new NotFound(`no view ${id}`);
    return v;
  }

  role(who: string, v: View): 'owner' | 'editor' | 'viewer' | null {
    if (v.owner === who) return 'owner';
    const s = v.shares.find((x) => x.who === who);
    if (s && v.visibility !== 'private') return s.role;
    return v.visibility === 'public' ? 'viewer' : null;
  }

  /** The view if this person may see it, else a NotFound (so a private view's existence is not confirmed). */
  see(who: Person, id: string): View {
    const v = this.#store.get(id);
    if (!v || !this.role(who.id, v)) throw new NotFound(`no view ${id}`);
    return v;
  }

  /** Change a view. Needs owner or editor, and the version you read; a stale version is refused. */
  update(who: Person, id: string, patch: Partial<ViewInput>, ifVersion: number): View {
    const v = this.see(who, id);
    const r = this.role(who.id, v);
    if (r !== 'owner' && r !== 'editor') throw new NotAllowed('you can use this view but not change it');
    if (v.version !== ifVersion) throw new VersionConflict(`the view is at version ${v.version}, not ${ifVersion}; reload it and apply your change again`);
    const next: ViewInput = { name: patch.name ?? v.name, filter: 'filter' in patch ? patch.filter : v.filter, sort: patch.sort ?? v.sort, groupBy: patch.groupBy ?? v.groupBy, hidden: patch.hidden ?? v.hidden };
    this.#check(v.table, next);
    const { filter: _old, ...rest } = v;
    void _old;
    const u: View = { ...rest, name: next.name.trim(), ...(next.filter ? { filter: next.filter } : {}), sort: next.sort ?? [], groupBy: next.groupBy ?? [], hidden: next.hidden ?? [], version: v.version + 1, updated: this.#now().toISOString() };
    // Anyone the view is shared with must still be able to read what it now depends on.
    for (const s of v.shares) this.#checkReadable(v.table, s.who, this.#needs(u));
    this.#store.put(u);
    return u;
  }

  delete(who: Person, id: string): void {
    const v = who.admin ? this.get(id) : this.see(who, id);
    if (v.owner !== who.id && !who.admin) throw new NotAllowed('only the owner can delete a view');
    this.#store.delete(id);
    for (const [k, d] of this.#defaults) if (d === id) this.#defaults.delete(k);
  }

  #needs(v: Pick<View, 'filter' | 'sort' | 'groupBy'>): string[] {
    return [...new Set([...fieldsIn(v.filter), ...v.sort.map((s) => s.path[0]!), ...v.groupBy])];
  }

  #checkReadable(table: string, who: string, fields: readonly string[]) {
    const no = fields.filter((f) => !this.#o.access.canRead(who, table, f));
    if (no.length) throw new FieldDenied(`${who} cannot read ${no.join(', ')}, which the view depends on`, no);
  }

  /** Share with one person as viewer or editor. Only the owner shares, and only with someone who can read what the view uses. */
  share(who: Person, id: string, withWho: string, role: 'viewer' | 'editor'): View {
    const v = this.see(who, id);
    if (v.owner !== who.id) throw new NotAllowed('only the owner can share a view');
    if (withWho === who.id) throw new ViewError('a view is already yours');
    this.#checkReadable(v.table, withWho, this.#needs(v));
    const shares = [...v.shares.filter((s) => s.who !== withWho), { who: withWho, role }];
    const u: View = { ...v, shares, visibility: v.visibility === 'public' ? 'public' : 'shared', version: v.version + 1, updated: this.#now().toISOString() };
    this.#store.put(u);
    return u;
  }

  unshare(who: Person, id: string, withWho: string): View {
    const v = this.see(who, id);
    if (v.owner !== who.id) throw new NotAllowed('only the owner can change who a view is shared with');
    const shares = v.shares.filter((s) => s.who !== withWho);
    const u: View = { ...v, shares, visibility: shares.length === 0 && v.visibility === 'shared' ? 'private' : v.visibility, version: v.version + 1, updated: this.#now().toISOString() };
    this.#store.put(u);
    return u;
  }

  /** Make a view visible to everyone who can use the table. Needs the right to publish. */
  publish(who: Person, id: string, on = true): View {
    const v = this.see(who, id);
    if (v.owner !== who.id) throw new NotAllowed('only the owner can publish a view');
    if (on && !who.canPublish) throw new NotAllowed('you do not have the right to publish views to everyone');
    const u: View = { ...v, visibility: on ? 'public' : v.shares.length ? 'shared' : 'private', version: v.version + 1, updated: this.#now().toISOString() };
    this.#store.put(u);
    return u;
  }

  /** Copy a view you can see into one you own, private, with its own name. */
  duplicate(who: Person, id: string, name: string): View {
    const v = this.see(who, id);
    return this.create(who, v.table, { name, ...(v.filter ? { filter: v.filter } : {}), sort: v.sort, groupBy: v.groupBy, hidden: v.hidden });
  }

  /** Views a person can use on a table: their own, those shared with them, and public ones. */
  list(who: Person, table: string): (View & { role: 'owner' | 'editor' | 'viewer' })[] {
    this.table(table);
    return this.#store.all().filter((v) => v.table === table).flatMap((v) => { const r = this.role(who.id, v); return r ? [{ ...v, role: r }] : []; }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  /** Make a view the one that opens first for this person (or, for an admin with `forEveryone`, for the table). */
  setDefault(who: Person, table: string, id: string | null, o: { forEveryone?: boolean } = {}): void {
    if (o.forEveryone && !who.admin) throw new NotAllowed('only an admin can set the default for everyone');
    const key = `${o.forEveryone ? '*' : who.id}|${table}`;
    if (id === null) { this.#defaults.delete(key); return; }
    const v = this.see(who, id);
    if (v.table !== table) throw new ViewError('that view is on another table');
    if (o.forEveryone && v.visibility !== 'public') throw new ViewError('a default for everyone must be a public view');
    this.#defaults.set(key, id);
  }

  /** The view to open: the person's own default, else the table's, else the unfiltered view (null). */
  resolveDefault(who: Person, table: string): View | null {
    for (const key of [`${who.id}|${table}`, `*|${table}`]) {
      const id = this.#defaults.get(key);
      const v = id ? this.#store.get(id) : undefined;
      if (v && this.role(who.id, v)) return v;
    }
    return null;
  }

  /**
   * Turn a view into what a data layer runs for this person: the filter (the view's, with @me and @today filled in,
   * ANDed with an optional extra filter and the mandatory row scope), the sort, the grouping and the columns they
   * may see. Refuses when the view relies on a field this person cannot read.
   */
  compile(who: Person, v: View, o: { scope?: Node; extra?: Node; today?: string } = {}): Compiled {
    if (!this.role(who.id, v)) throw new NotFound(`no view ${v.id}`);
    const t = this.table(v.table);
    this.#checkReadable(v.table, who.id, [...this.#needs(v), ...fieldsIn(o.extra)]);
    const columns = t.fields.map((f) => f.name).filter((f) => !v.hidden.includes(f) && this.#o.access.canRead(who.id, v.table, f));
    const today = o.today ?? this.#now().toISOString().slice(0, 10);
    const parts = [o.scope, fill(v.filter, who.id, today), o.extra].filter((x): x is Node => x !== undefined);
    const filter: Node | undefined = parts.length === 0 ? undefined : parts.length === 1 ? parts[0]! : { kind: 'and', children: parts };
    return { table: v.table, ...(filter ? { filter } : {}), sort: v.sort, groupBy: v.groupBy, columns };
  }

  /** Run a compiled view over rows in memory: filter, sort, group, and keep only the columns allowed. */
  run(c: Compiled, rows: readonly Record<string, unknown>[], o: { limit?: number; offset?: number } = {}): { total: number; rows: Record<string, unknown>[]; groups?: { key: unknown[]; count: number; rows: Record<string, unknown>[] }[] } {
    const kept = rows.filter((r) => matches(c.filter, r));
    const cmpv = (a: unknown, b: unknown) => (a === b ? 0 : a === null || a === undefined ? 1 : b === null || b === undefined ? -1 : (a as never) < (b as never) ? -1 : 1);
    const order: Sort[] = [...c.groupBy.map((g) => ({ path: [g], dir: 'asc' as const })), ...c.sort];
    const sorted = [...kept].sort((a, b) => { for (const s of order) { const d = cmpv(a[s.path[0]!], b[s.path[0]!]); if (d) return s.dir === 'desc' ? -d : d; } return 0; });
    const project = (r: Record<string, unknown>) => Object.fromEntries(c.columns.map((k) => [k, r[k]]));
    const page = sorted.slice(o.offset ?? 0, o.limit === undefined ? undefined : (o.offset ?? 0) + o.limit);
    if (c.groupBy.length === 0) return { total: kept.length, rows: page.map(project) };
    const groups: { key: unknown[]; count: number; rows: Record<string, unknown>[] }[] = [];
    for (const r of page) {
      const key = c.groupBy.map((g) => r[g] ?? null);
      const last = groups.at(-1);
      if (last && JSON.stringify(last.key) === JSON.stringify(key)) { last.rows.push(project(r)); last.count++; } else groups.push({ key, count: 1, rows: [project(r)] });
    }
    return { total: kept.length, rows: page.map(project), groups };
  }

  /** A stable identity for what a view does, so two views with the same effect are noticed. */
  fingerprint(v: View): string {
    return `${v.table}|${canonical(v.filter)}|${v.sort.map((s) => `${s.path.join('.')}:${s.dir}`).join(',')}|${v.groupBy.join(',')}|${[...v.hidden].sort().join(',')}`;
  }

  /** The view as plain JSON, without identity or owner, for provisioning from a file. */
  exportView(v: View): { table: string; name: string; filter?: Node; sort: readonly Sort[]; groupBy: readonly string[]; hidden: readonly string[] } {
    return { table: v.table, name: v.name, ...(v.filter ? { filter: v.filter } : {}), sort: v.sort, groupBy: v.groupBy, hidden: v.hidden };
  }

  /** Create a view from exported JSON, checking everything again. */
  importView(who: Person, json: unknown): View {
    if (!json || typeof json !== 'object') throw new ViewError('a view file must be an object');
    const j = json as Record<string, unknown>;
    if (typeof j.table !== 'string' || typeof j.name !== 'string') throw new ViewError('a view file needs a table and a name');
    const arr = (x: unknown): string[] => { if (x === undefined) return []; if (!Array.isArray(x) || x.some((y) => typeof y !== 'string')) throw new ViewError('groupBy and hidden must be lists of field names'); return x as string[]; };
    const sort = (j.sort === undefined ? [] : j.sort) as unknown;
    if (!Array.isArray(sort) || sort.some((s) => !s || !Array.isArray((s as Sort).path) || ((s as Sort).dir !== 'asc' && (s as Sort).dir !== 'desc'))) throw new ViewError('sort must be a list of { path, dir }');
    const filter = j.filter === undefined ? undefined : this.#node(j.filter, 1);
    return this.create(who, j.table, { name: j.name, ...(filter ? { filter } : {}), sort: sort as Sort[], groupBy: arr(j.groupBy), hidden: arr(j.hidden) });
  }

  #node(x: unknown, depth: number): Node {
    if (depth > 8 || !x || typeof x !== 'object') throw new ViewError('a filter in a view file is malformed or nested too deeply');
    const n = x as Record<string, unknown>;
    if (n.kind === 'and' || n.kind === 'or') { if (!Array.isArray(n.children) || n.children.length > 50) throw new ViewError('a group in a filter needs a list of up to 50 children'); return { kind: n.kind, children: n.children.map((c) => this.#node(c, depth + 1)) }; }
    if (n.kind === 'not') return { kind: 'not', child: this.#node(n.child, depth + 1) };
    if (n.kind === 'cmp' && Array.isArray(n.path) && n.path.every((p) => typeof p === 'string') && typeof n.op === 'string') {
      if (!['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'nin', 'contains', 'icontains', 'starts', 'istarts', 'ends', 'iends', 'null', 'between'].includes(n.op)) throw new ViewError(`${n.op} is not a filter operator`);
      return { kind: 'cmp', path: n.path as string[], op: n.op as never, value: n.value };
    }
    throw new ViewError('a filter in a view file is malformed');
  }
}
