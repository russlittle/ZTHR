/**
 * Dashboards: a titled page of panels on a 24-column grid, with variables that people pick (a region, a team, an
 * interval), a time range that may be relative ("now-6h", "now-7d/d") or fixed, and sharing. A panel asks one
 * question of one table: a measure (count, sum, average, minimum or maximum), optionally grouped by a field and bucketed
 * over time, over rows chosen by a filter tree. Panels do not read data on their own authority: each runs through the
 * view-engine block for the person looking, so row scope and field permissions apply exactly as they do on the
 * table, and sharing a dashboard never shares data; someone who cannot read a field sees that panel refused, not
 * filled in. Variables are values, never text spliced into a query: a selection must be one of the variable's
 * options (or short plain text for a textbox), `$name` in a filter value becomes that value, a multi-select turns
 * equals into in, and "All" removes the comparison.
 *
 * Layout is validated (inside the grid, no overlaps) and compacted upward the way a grid editor does it. Public
 * links are random tokens kept only as hashes, with an expiry, and show the dashboard as a person named
 * `link:<id>` whose access the application decides. Dashboards can be provisioned from JSON files: each file names its
 * dashboards by uid, repeat runs change nothing unless the content changed (checksum), provisioned dashboards cannot
 * be edited by hand unless the file allows it, and dashboards whose files are gone are kept or removed as asked.
 * Files are size- and depth-limited and refused if their paths climb out of the provisioning folder.
 *
 * Out of scope: drawing panels, alert rules, and fetching rows (the caller supplies `fetch`).
 */
import { createHash, randomBytes } from 'node:crypto';
import { instant, wallOf } from '../time/index.ts';
import type { Node, Person, View, ViewEngine } from '../view-engine/index.ts';
import { matches } from '../rest-filter-syntax/index.ts';

export class DashboardError extends Error {}
export class NotAllowed extends DashboardError {}
export class NotFound extends DashboardError {}
export class VersionConflict extends DashboardError {}
export class BadLayout extends DashboardError {}

export const GRID_COLUMNS = 24;

// --- time ------------------------------------------------------------------------------------------------------

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/**
 * One end of a time range. "now", "now-6h", "now+1d", "now/d" (start of today), "now-1d/d", "now/M" (start of month),
 * "now/w" (start of week, Monday), or an ISO instant. Rounding follows the time zone; `up` rounds to the end of the
 * unit instead of the start (used for the "to" end).
 */
export function timeExpr(expr: string, now: Date, tz: string, up = false): Date {
  const iso = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(expr) ? new Date(expr) : undefined;
  if (iso) { if (Number.isNaN(iso.getTime())) throw new DashboardError(`${expr} is not a time`); return iso; }
  const m = /^now(?:([+-])(\d{1,6})([smhdwM]))?(?:\/([dwMy]))?$/.exec(expr.trim());
  if (!m) throw new DashboardError(`${JSON.stringify(expr.slice(0, 40))} is not a time; use now, now-6h, now/d or an ISO time`);
  let t = now.getTime();
  if (m[1]) {
    const n = Number(m[2]) * (m[1] === '-' ? -1 : 1);
    if (m[3] === 'M') { const w = wallOf(new Date(t), tz); t = instant({ y: w.y, m: w.m + n, d: Math.min(w.d, 28), h: w.h, min: w.min }, tz).getTime(); } else t += n * UNIT_MS[m[3]!]!;
  }
  if (m[4]) {
    const w = wallOf(new Date(t), tz);
    const unit = m[4];
    const start = unit === 'd' ? { y: w.y, m: w.m, d: w.d } : unit === 'w' ? (() => { const d = new Date(Date.UTC(w.y, w.m - 1, w.d - ((w.weekday + 6) % 7))); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; })() : unit === 'M' ? { y: w.y, m: w.m, d: 1 } : { y: w.y, m: 1, d: 1 };
    const s = instant({ ...start, h: 0, min: 0 }, tz);
    if (!up) return s;
    const next = unit === 'd' ? { ...start, d: start.d + 1 } : unit === 'w' ? { ...start, d: start.d + 7 } : unit === 'M' ? { ...start, m: start.m + 1 } : { y: start.y + 1, m: 1, d: 1 };
    const nd = new Date(Date.UTC(next.y, next.m - 1, next.d));
    return new Date(instant({ y: nd.getUTCFullYear(), m: nd.getUTCMonth() + 1, d: nd.getUTCDate(), h: 0, min: 0 }, tz).getTime() - 1);
  }
  return new Date(t);
}

export interface TimeRange { readonly from: string; readonly to: string }

export function resolveRange(r: TimeRange, now: Date, tz: string, o: { maxSpanMs?: number } = {}): { from: Date; to: Date } {
  const from = timeExpr(r.from, now, tz), to = timeExpr(r.to, now, tz, true);
  if (!(from < to)) throw new DashboardError('the time range must end after it starts');
  if (to.getTime() - from.getTime() > (o.maxSpanMs ?? 3660 * 86_400_000)) throw new DashboardError('the time range is longer than ten years');
  return { from, to };
}

// --- variables -------------------------------------------------------------------------------------------------

export type Variable = { readonly name: string; readonly label?: string; readonly multi?: boolean; readonly includeAll?: boolean; readonly current?: readonly string[] } & (
  | { readonly kind: 'custom'; readonly options: readonly string[] }
  | { readonly kind: 'interval'; readonly options: readonly string[] }
  | { readonly kind: 'query'; readonly table: string; readonly field: string; readonly filter?: Node }
  | { readonly kind: 'textbox'; readonly default?: string }
  | { readonly kind: 'constant'; readonly value: string }
);

export interface Resolved { readonly name: string; readonly values: readonly string[]; readonly all: boolean; readonly options: readonly string[] }

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

/** `$name`, `${name}`, `${name:csv}` and `${name:pipe}` in text. "All" reads as All. */
export function interpolateText(s: string, vars: Readonly<Record<string, Resolved>>): string {
  return s.replace(/\$(?:\{([A-Za-z_]\w*)(?::(csv|pipe|text))?\}|([A-Za-z_]\w*))/g, (m, a: string | undefined, fmt: string | undefined, b: string | undefined) => {
    const v = vars[(a ?? b)!];
    if (!v) return m;
    if (v.all) return 'All';
    return v.values.join(fmt === 'pipe' ? '|' : fmt === 'text' ? ' + ' : ',');
  });
}

/** Put variable values into a filter tree. Unknown variables are an error. "All" removes the comparison. */
export function interpolateNode(n: Node | undefined, vars: Readonly<Record<string, Resolved>>): Node | undefined {
  if (!n) return n;
  if (n.kind === 'and' || n.kind === 'or') { const kids = n.children.map((c) => interpolateNode(c, vars)).filter((c): c is Node => c !== undefined); return kids.length === 0 ? undefined : kids.length === 1 ? kids[0]! : { kind: n.kind, children: kids }; }
  if (n.kind === 'not') { const c = interpolateNode(n.child, vars); return c ? { kind: 'not', child: c } : undefined; }
  const ref = (v: unknown): string | undefined => { const m = typeof v === 'string' ? /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))$/.exec(v) : null; return m ? (m[1] ?? m[2]) : undefined; };
  if (Array.isArray(n.value)) {
    const out: unknown[] = [];
    for (const x of n.value) { const r = ref(x); if (r === undefined) { out.push(x); continue; } const v = vars[r]; if (!v) throw new DashboardError(`the filter uses $${r}, which is not a variable of this dashboard`); if (v.all) return undefined; out.push(...v.values); }
    return { ...n, value: out };
  }
  const r = ref(n.value);
  if (r === undefined) return n;
  const v = vars[r];
  if (!v) throw new DashboardError(`the filter uses $${r}, which is not a variable of this dashboard`);
  if (v.all) return undefined;
  if (v.values.length === 1 && n.op !== 'in' && n.op !== 'nin') return { ...n, value: v.values[0]! };
  if (n.op === 'eq') return { ...n, op: 'in', value: [...v.values] };
  if (n.op === 'ne') return { ...n, op: 'nin', value: [...v.values] };
  if (n.op === 'in' || n.op === 'nin') return { ...n, value: [...v.values] };
  throw new DashboardError(`$${r} has several values and cannot be used with ${n.op}`);
}

// --- panels, layout --------------------------------------------------------------------------------------------

export interface Grid { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export type Agg = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface PanelQuery {
  readonly table: string;
  readonly filter?: Node;
  readonly measure: { readonly agg: Agg; readonly field?: string };
  readonly groupBy?: string;
  readonly timeField?: string;
  /** Bucket size such as 15m, 1h, 1d, 1w (needs timeField). */
  readonly interval?: string;
}

export interface Panel {
  readonly id: number;
  readonly title: string;
  readonly type: 'timeseries' | 'bar' | 'stat' | 'table' | 'text';
  readonly grid: Grid;
  readonly query?: PanelQuery;
  readonly text?: string;
}

export function validateLayout(panels: readonly Panel[]): void {
  const seen = new Set<number>();
  for (const p of panels) {
    if (!Number.isInteger(p.id) || p.id < 1) throw new BadLayout(`panel ids are whole numbers from 1 (got ${p.id})`);
    if (seen.has(p.id)) throw new BadLayout(`panel id ${p.id} is used twice`);
    seen.add(p.id);
    const g = p.grid;
    if (![g.x, g.y, g.w, g.h].every(Number.isInteger)) throw new BadLayout(`panel ${p.id}: the grid position must be whole numbers`);
    if (g.x < 0 || g.y < 0) throw new BadLayout(`panel ${p.id}: x and y cannot be negative`);
    if (g.w < 1 || g.h < 1 || g.h > 100) throw new BadLayout(`panel ${p.id}: width is 1 to ${GRID_COLUMNS}, height 1 to 100`);
    if (g.x + g.w > GRID_COLUMNS) throw new BadLayout(`panel ${p.id}: it reaches column ${g.x + g.w}, past the ${GRID_COLUMNS}-column grid`);
  }
  for (let i = 0; i < panels.length; i++) for (let j = i + 1; j < panels.length; j++) if (overlap(panels[i]!.grid, panels[j]!.grid)) throw new BadLayout(`panels ${panels[i]!.id} and ${panels[j]!.id} overlap`);
}

const overlap = (a: Grid, b: Grid) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Move every panel up as far as it will go, keeping left-to-right and top-to-bottom order. */
export function compact(panels: readonly Panel[]): Panel[] {
  const placed: Panel[] = [];
  for (const p of [...panels].sort((a, b) => a.grid.y - b.grid.y || a.grid.x - b.grid.x || a.id - b.id)) {
    let y = p.grid.y;
    while (y > 0 && !placed.some((q) => overlap({ ...p.grid, y: y - 1 }, q.grid))) y--;
    placed.push({ ...p, grid: { ...p.grid, y } });
  }
  return placed.sort((a, b) => a.id - b.id);
}

/** The first free position for a panel of a given size, scanning rows left to right. */
export function place(panels: readonly Panel[], size: { w: number; h: number }): Grid {
  if (size.w < 1 || size.w > GRID_COLUMNS || size.h < 1) throw new BadLayout('a new panel is 1 to 24 columns wide and at least 1 tall');
  for (let y = 0; y < 10_000; y++) for (let x = 0; x + size.w <= GRID_COLUMNS; x++) if (!panels.some((q) => overlap({ x, y, ...size }, q.grid))) return { x, y, ...size };
  throw new BadLayout('there is no room for another panel');
}

// --- dashboards ------------------------------------------------------------------------------------------------

export interface Dashboard {
  readonly uid: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly owner: string;
  readonly timezone: string;
  readonly time: TimeRange;
  readonly refresh?: string;
  readonly variables: readonly Variable[];
  readonly panels: readonly Panel[];
  readonly shares: readonly { readonly who: string; readonly role: 'viewer' | 'editor' }[];
  readonly version: number;
  readonly provisioned?: { readonly file: string; readonly checksum: string; readonly allowUiUpdates: boolean };
}

export type DashboardInput = Pick<Dashboard, 'title'> & Partial<Pick<Dashboard, 'tags' | 'timezone' | 'time' | 'refresh' | 'variables' | 'panels' | 'uid'>>;

export interface Link { readonly hash: string; readonly uid: string; readonly expires: number; readonly createdBy: string }

export interface PanelResult {
  readonly panel: number;
  readonly title: string;
  readonly kind: 'series' | 'scalar' | 'rows' | 'text';
  readonly series?: readonly { name: string; points: readonly [number, number | null][] }[];
  readonly value?: number | null;
  readonly rows?: readonly Record<string, unknown>[];
  readonly text?: string;
  readonly truncated?: boolean;
}

export interface Options {
  readonly engine: ViewEngine;
  readonly now?: () => Date;
  readonly id?: () => string;
  /** The row scope this person gets on a table: their own rows, their team's. Applied to every panel. */
  readonly scopeFor?: (who: Person, table: string) => Node | undefined;
  readonly maxPanels?: number;
  readonly maxSeries?: number;
  readonly maxRows?: number;
}

const checksum = (s: string) => createHash('sha256').update(s).digest('hex');
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export function parseInterval(s: string): { n: number; unit: 'm' | 'h' | 'd' | 'w' } {
  const m = /^(\d{1,4})([mhdw])$/.exec(s);
  if (!m || Number(m[1]) < 1) throw new DashboardError(`${JSON.stringify(s.slice(0, 10))} is not an interval like 15m, 1h, 1d or 1w`);
  return { n: Number(m[1]), unit: m[2] as 'm' | 'h' | 'd' | 'w' };
}

/** The start of the bucket a time falls in. Days and weeks follow the time zone. */
export function bucketStart(t: number, iv: { n: number; unit: 'm' | 'h' | 'd' | 'w' }, tz: string): number {
  if (iv.unit === 'm' || iv.unit === 'h') { const size = iv.n * UNIT_MS[iv.unit]!; return Math.floor(t / size) * size; }
  const w = wallOf(new Date(t), tz);
  if (iv.unit === 'd') {
    const day = Math.floor(Date.UTC(w.y, w.m - 1, w.d) / 86_400_000);
    const b = day - (day % iv.n);
    const d = new Date(b * 86_400_000);
    return instant({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: 0, min: 0 }, tz).getTime();
  }
  const d = new Date(Date.UTC(w.y, w.m - 1, w.d - ((w.weekday + 6) % 7)));
  return instant({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: 0, min: 0 }, tz).getTime();
}

export class Dashboards {
  readonly #d = new Map<string, Dashboard>();
  readonly #links = new Map<string, Link>();
  /** People handed out by viewByLink, and the dashboard each may see. Only these objects count as link viewers. */
  readonly #linkPeople = new WeakMap<Person, string>();
  readonly #o: Options;
  readonly #now: () => Date;
  readonly #id: () => string;
  #seq = 0;

  constructor(o: Options) {
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
    this.#id = o.id ?? (() => `dash-${++this.#seq}`);
  }

  #check(d: Omit<Dashboard, 'version' | 'owner' | 'shares'>): void {
    if (!d.title.trim() || d.title.length > 120) throw new DashboardError('a dashboard needs a title of 1 to 120 characters');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(d.uid)) throw new DashboardError('a uid is 1 to 40 letters, digits, - or _');
    try { new Intl.DateTimeFormat('en-US', { timeZone: d.timezone }); } catch { throw new DashboardError(`${d.timezone} is not a time zone`); }
    resolveRange(d.time, new Date('2026-01-01T00:00:00Z'), d.timezone);
    if (d.refresh !== undefined && !/^\d+[smh]$/.test(d.refresh)) throw new DashboardError('refresh looks like 30s, 5m or 1h');
    if (d.refresh !== undefined && Number(d.refresh.slice(0, -1)) * UNIT_MS[d.refresh.slice(-1)]! < 5000) throw new DashboardError('refresh may not be faster than every 5 seconds');
    if (d.tags.length > 20 || d.tags.some((t) => t.length > 40)) throw new DashboardError('at most 20 tags of up to 40 characters');
    const names = new Set<string>();
    for (const v of d.variables) {
      if (!NAME.test(v.name)) throw new DashboardError(`variable name ${JSON.stringify(v.name.slice(0, 30))} must be letters, digits and _`);
      if (names.has(v.name)) throw new DashboardError(`variable ${v.name} is defined twice`);
      names.add(v.name);
      if ((v.kind === 'custom' || v.kind === 'interval') && (v.options.length === 0 || v.options.length > 200)) throw new DashboardError(`variable ${v.name} needs 1 to 200 options`);
      if (v.kind === 'interval') for (const o of v.options) parseInterval(o);
      if (v.kind === 'query') this.#o.engine.table(v.table);
    }
    if (d.panels.length > (this.#o.maxPanels ?? 60)) throw new DashboardError(`at most ${this.#o.maxPanels ?? 60} panels`);
    validateLayout(d.panels);
    for (const p of d.panels) this.#checkPanel(p, names);
  }

  #checkPanel(p: Panel, vars: ReadonlySet<string>): void {
    if (!p.title || p.title.length > 120) throw new DashboardError(`panel ${p.id} needs a title of 1 to 120 characters`);
    if (p.type === 'text') { if (p.query) throw new DashboardError(`panel ${p.id}: a text panel has no query`); if ((p.text ?? '').length > 10_000) throw new DashboardError(`panel ${p.id}: text is too long`); return; }
    const q = p.query;
    if (!q) throw new DashboardError(`panel ${p.id} needs a query`);
    const t = this.#o.engine.table(q.table);
    const known = new Set(t.fields.map((f) => f.name));
    const need = [q.groupBy, q.timeField, q.measure.field].filter((x): x is string => x !== undefined);
    const bad = need.find((f) => !known.has(f));
    if (bad) throw new DashboardError(`panel ${p.id}: ${q.table} has no field ${bad}`);
    if (q.measure.agg !== 'count' && !q.measure.field) throw new DashboardError(`panel ${p.id}: ${q.measure.agg} needs a field`);
    if (q.measure.field && q.measure.agg !== 'count' && t.fields.find((f) => f.name === q.measure.field)!.type !== 'number') throw new DashboardError(`panel ${p.id}: ${q.measure.agg} needs a number field`);
    if (q.interval !== undefined) { parseInterval(q.interval); if (!q.timeField) throw new DashboardError(`panel ${p.id}: an interval needs a timeField`); }
    if ((p.type === 'timeseries') && !q.timeField) throw new DashboardError(`panel ${p.id}: a time series needs a timeField`);
    const used = (n: Node | undefined): string[] => (!n ? [] : n.kind === 'cmp' ? [n.path[0]!, ...(typeof n.value === 'string' ? [n.value] : Array.isArray(n.value) ? n.value.filter((x): x is string => typeof x === 'string') : []).filter((v) => v.startsWith('$'))] : n.kind === 'not' ? used(n.child) : n.children.flatMap(used));
    for (const f of used(q.filter)) { if (f.startsWith('$')) { const nm = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(f)?.[1]; if (nm && !vars.has(nm)) throw new DashboardError(`panel ${p.id}: the filter uses $${nm}, which is not a variable of this dashboard`); } else if (!known.has(f)) throw new DashboardError(`panel ${p.id}: ${q.table} has no field ${f}`); }
  }

  create(who: Person, i: DashboardInput): Dashboard {
    const d: Dashboard = { uid: i.uid ?? this.#id(), title: i.title.trim(), tags: i.tags ?? [], owner: who.id, timezone: i.timezone ?? 'UTC', time: i.time ?? { from: 'now-6h', to: 'now' }, ...(i.refresh ? { refresh: i.refresh } : {}), variables: i.variables ?? [], panels: i.panels ?? [], shares: [], version: 1 };
    if (this.#d.has(d.uid)) throw new DashboardError(`a dashboard with uid ${d.uid} already exists`);
    this.#check(d);
    this.#d.set(d.uid, d);
    return d;
  }

  get(uid: string): Dashboard {
    const d = this.#d.get(uid);
    if (!d) throw new NotFound(`no dashboard ${uid}`);
    return d;
  }

  can(who: Person, d: Dashboard, need: 'view' | 'edit' | 'admin'): boolean {
    if (d.owner === who.id || who.admin) return true;
    const s = d.shares.find((x) => x.who === who.id);
    return !!s && (need === 'view' || (need === 'edit' && s.role === 'editor'));
  }

  see(who: Person, uid: string, need: 'view' | 'edit' | 'admin' = 'view'): Dashboard {
    const d = this.#d.get(uid);
    if (!d || !this.can(who, d, 'view')) throw new NotFound(`no dashboard ${uid}`);
    if (!this.can(who, d, need)) throw new NotAllowed(need === 'edit' ? 'you can view this dashboard but not change it' : 'only the owner can do that');
    return d;
  }

  list(who: Person, o: { tag?: string; text?: string } = {}): Dashboard[] {
    const t = o.text?.toLowerCase();
    return [...this.#d.values()].filter((d) => this.can(who, d, 'view') && (!o.tag || d.tags.includes(o.tag)) && (!t || d.title.toLowerCase().includes(t))).sort((a, b) => a.title.localeCompare(b.title) || a.uid.localeCompare(b.uid));
  }

  update(who: Person, uid: string, patch: Partial<Omit<DashboardInput, 'uid'>>, ifVersion: number): Dashboard {
    const d = this.see(who, uid, 'edit');
    if (d.provisioned && !d.provisioned.allowUiUpdates) throw new NotAllowed(`this dashboard is provisioned from ${d.provisioned.file}; change the file instead`);
    if (d.version !== ifVersion) throw new VersionConflict(`the dashboard is at version ${d.version}, not ${ifVersion}; reload and apply your change again`);
    const n: Dashboard = { ...d, title: (patch.title ?? d.title).trim(), tags: patch.tags ?? d.tags, timezone: patch.timezone ?? d.timezone, time: patch.time ?? d.time, ...(patch.refresh !== undefined ? { refresh: patch.refresh } : d.refresh ? { refresh: d.refresh } : {}), variables: patch.variables ?? d.variables, panels: patch.panels ?? d.panels, version: d.version + 1 };
    this.#check(n);
    this.#d.set(uid, n);
    return n;
  }

  delete(who: Person, uid: string): void {
    const d = this.see(who, uid, 'admin');
    if (d.provisioned && !d.provisioned.allowUiUpdates) throw new NotAllowed(`this dashboard is provisioned from ${d.provisioned.file}; remove the file instead`);
    this.#d.delete(uid);
    for (const [h, l] of this.#links) if (l.uid === uid) this.#links.delete(h);
  }

  share(who: Person, uid: string, withWho: string, role: 'viewer' | 'editor'): Dashboard {
    const d = this.see(who, uid, 'admin');
    if (withWho === d.owner) throw new DashboardError('the owner already has full access');
    const n: Dashboard = { ...d, shares: [...d.shares.filter((s) => s.who !== withWho), { who: withWho, role }], version: d.version + 1 };
    this.#d.set(uid, n);
    return n;
  }

  unshare(who: Person, uid: string, withWho: string): Dashboard {
    const d = this.see(who, uid, 'admin');
    const n: Dashboard = { ...d, shares: d.shares.filter((s) => s.who !== withWho), version: d.version + 1 };
    this.#d.set(uid, n);
    return n;
  }

  /** A public link: the token is returned once and only its hash is kept. */
  createLink(who: Person, uid: string, ttlMs: number): { token: string; expires: number } {
    this.see(who, uid, 'admin');
    if (!(ttlMs > 0) || ttlMs > 90 * 86_400_000) throw new DashboardError('a public link may last up to 90 days');
    const token = randomBytes(24).toString('base64url');
    const expires = this.#now().getTime() + ttlMs;
    this.#links.set(hashToken(token), { hash: hashToken(token), uid, expires, createdBy: who.id });
    return { token, expires };
  }

  revokeLink(who: Person, uid: string): number {
    this.see(who, uid, 'admin');
    let n = 0;
    for (const [h, l] of this.#links) if (l.uid === uid) { this.#links.delete(h); n++; }
    return n;
  }

  /** The dashboard and the person a link stands for, or null if it is unknown or expired. */
  viewByLink(token: string): { dashboard: Dashboard; person: Person } | null {
    const l = this.#links.get(hashToken(token));
    if (!l || l.expires <= this.#now().getTime()) return null;
    const d = this.#d.get(l.uid);
    if (!d) return null;
    const person: Person = { id: `link:${l.hash.slice(0, 12)}` };
    this.#linkPeople.set(person, d.uid);
    return { dashboard: d, person };
  }

  // --- variables and panels at run time ------------------------------------------------------------------------

  /** The variables' options and the chosen values. A choice that is not one of the options is refused. */
  async resolveVariables(who: Person, d: Dashboard, picks: Readonly<Record<string, readonly string[]>>, fetch: Fetch): Promise<Record<string, Resolved>> {
    const out: Record<string, Resolved> = {};
    for (const v of d.variables) {
      let options: string[] = [];
      if (v.kind === 'custom' || v.kind === 'interval') options = [...v.options];
      else if (v.kind === 'query') {
        const view = this.#pseudo(who, v.table, v.filter, [v.field]);
        const c = this.#o.engine.compile(who, view, { ...(this.#o.scopeFor?.(who, v.table) ? { scope: this.#o.scopeFor(who, v.table)! } : {}) });
        const rows = (await fetch(v.table, c)).filter((r) => matches(c.filter, r));
        options = [...new Set(rows.map((r) => r[v.field]).filter((x) => x !== null && x !== undefined).map(String))].sort().slice(0, 500);
      } else if (v.kind === 'constant') { out[v.name] = { name: v.name, values: [v.value], all: false, options: [v.value] }; continue; }
      const chosen = picks[v.name] ?? v.current ?? (v.kind === 'textbox' ? [v.default ?? ''] : v.includeAll ? ['$__all'] : options.slice(0, 1));
      if (chosen.length > 1 && !v.multi) throw new DashboardError(`${v.name} takes one value`);
      if (chosen.length === 1 && chosen[0] === '$__all') { if (!v.includeAll) throw new DashboardError(`${v.name} has no All option`); out[v.name] = { name: v.name, values: options, all: true, options }; continue; }
      for (const c of chosen) {
        if (v.kind === 'textbox') { if (c.length > 200 || /[\u0000-\u001f]/.test(c)) throw new DashboardError(`${v.name}: text may be up to 200 characters, no control characters`); } else if (!options.includes(c)) throw new DashboardError(`${JSON.stringify(c.slice(0, 40))} is not one of the choices for ${v.name}`);
      }
      out[v.name] = { name: v.name, values: [...chosen], all: false, options };
    }
    return out;
  }

  #pseudo(who: Person, table: string, filter: Node | undefined, extraFields: string[]): View {
    return { id: 'panel', table, name: 'panel', owner: who.id, visibility: 'private', shares: [], ...(filter ? { filter } : {}), sort: extraFields.map((f) => ({ path: [f], dir: 'asc' as const })), groupBy: [], hidden: [], version: 0, created: '', updated: '' };
  }

  /** Run one panel for a person. */
  async runPanel(who: Person, d: Dashboard, panelId: number, ctx: { vars: Record<string, Resolved>; fetch: Fetch; range?: TimeRange }): Promise<PanelResult> {
    const stored = this.#d.get(d.uid);
    if (!stored || (!this.can(who, stored, 'view') && this.#linkPeople.get(who) !== d.uid)) throw new NotFound(`no dashboard ${d.uid}`);
    d = stored;
    const p = d.panels.find((x) => x.id === panelId);
    if (!p) throw new NotFound(`no panel ${panelId}`);
    const title = interpolateText(p.title, ctx.vars);
    if (p.type === 'text') return { panel: p.id, title, kind: 'text', text: interpolateText(p.text ?? '', ctx.vars) };
    const q = p.query!;
    const range = resolveRange(ctx.range ?? d.time, this.#now(), d.timezone);
    const filter = interpolateNode(q.filter, ctx.vars);
    const need = [q.measure.field, q.groupBy, q.timeField].filter((x): x is string => x !== undefined);
    const view = this.#pseudo(who, q.table, filter, need);
    const scope = this.#o.scopeFor?.(who, q.table);
    const c = this.#o.engine.compile(who, view, { ...(scope ? { scope } : {}) });
    const rows = (await ctx.fetch(q.table, c)).filter((r) => matches(c.filter, r)).filter((r) => !q.timeField || (typeof r[q.timeField] === 'string' || r[q.timeField] instanceof Date) && new Date(r[q.timeField] as string).getTime() >= range.from.getTime() && new Date(r[q.timeField] as string).getTime() <= range.to.getTime());
    const agg = (rs: Record<string, unknown>[]): number | null => {
      if (q.measure.agg === 'count') return rs.length;
      const xs = rs.map((r) => r[q.measure.field!]).filter((x): x is number => typeof x === 'number');
      if (xs.length === 0) return null;
      return q.measure.agg === 'sum' ? xs.reduce((a, b) => a + b, 0) : q.measure.agg === 'avg' ? xs.reduce((a, b) => a + b, 0) / xs.length : q.measure.agg === 'min' ? Math.min(...xs) : Math.max(...xs);
    };
    const maxSeries = this.#o.maxSeries ?? 50;
    if (p.type === 'table') { const cap = this.#o.maxRows ?? 500; return { panel: p.id, title, kind: 'rows', rows: rows.slice(0, cap).map((r) => Object.fromEntries(c.columns.map((k) => [k, r[k]]))), truncated: rows.length > cap }; }
    if (p.type === 'stat' || (!q.timeField && !q.groupBy)) return { panel: p.id, title, kind: 'scalar', value: agg(rows) };
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) { const k = q.groupBy ? String(r[q.groupBy] ?? '(none)') : q.measure.agg === 'count' ? 'count' : `${q.measure.agg} ${q.measure.field}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
    const names = [...groups.keys()].sort();
    const series = names.slice(0, maxSeries).map((name) => {
      const rs = groups.get(name)!;
      if (!q.timeField) return { name, points: [[0, agg(rs)]] as [number, number | null][] };
      const iv = parseInterval(q.interval ?? '1h');
      const buckets = new Map<number, Record<string, unknown>[]>();
      for (const r of rs) { const b = bucketStart(new Date(r[q.timeField] as string).getTime(), iv, d.timezone); (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(r); }
      return { name, points: [...buckets].sort((a, b) => a[0] - b[0]).map(([t, xs]) => [t, agg(xs)] as [number, number | null]) };
    });
    return { panel: p.id, title, kind: 'series', series, truncated: names.length > maxSeries };
  }

  // --- provisioning --------------------------------------------------------------------------------------------

  /** Make the stored dashboards match a set of files. Safe to run again: unchanged files change nothing. */
  provision(files: readonly { path: string; content: string }[], o: { owner?: string; orphans?: 'keep' | 'delete'; maxFileBytes?: number } = {}): { created: string[]; updated: string[]; unchanged: string[]; deleted: string[]; errors: { file: string; message: string }[] } {
    const owner = o.owner ?? 'provisioner';
    const res = { created: [] as string[], updated: [] as string[], unchanged: [] as string[], deleted: [] as string[], errors: [] as { file: string; message: string }[] };
    const wanted = new Set<string>();
    for (const f of files) {
      try {
        if (f.path.includes('..') || f.path.startsWith('/') || /[\u0000-\u001f\\]/.test(f.path)) throw new DashboardError('the file path is not inside the provisioning folder');
        if (Buffer.byteLength(f.content) > (o.maxFileBytes ?? 1_000_000)) throw new DashboardError('the file is too large');
        const json = JSON.parse(f.content, (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v)) as unknown;
        const list = Array.isArray(json) ? json : [json];
        if (list.length > 100) throw new DashboardError('a file may hold up to 100 dashboards');
        for (const raw of list) {
          const j = raw as { dashboard?: Record<string, unknown>; allowUiUpdates?: boolean };
          const dj = (j && typeof j === 'object' && j.dashboard && typeof j.dashboard === 'object' ? j.dashboard : raw) as Record<string, unknown>;
          if (!dj || typeof dj !== 'object' || typeof dj.uid !== 'string' || typeof dj.title !== 'string') throw new DashboardError('each dashboard needs a uid and a title');
          const input: DashboardInput = { uid: dj.uid, title: dj.title, ...(Array.isArray(dj.tags) ? { tags: dj.tags as string[] } : {}), ...(typeof dj.timezone === 'string' ? { timezone: dj.timezone } : {}), ...(dj.time ? { time: dj.time as TimeRange } : {}), ...(typeof dj.refresh === 'string' ? { refresh: dj.refresh } : {}), ...(Array.isArray(dj.variables) ? { variables: dj.variables as Variable[] } : {}), ...(Array.isArray(dj.panels) ? { panels: dj.panels as Panel[] } : {}) };
          const sum = checksum(JSON.stringify(input));
          wanted.add(input.uid!);
          const cur = this.#d.get(input.uid!);
          if (cur && !cur.provisioned) throw new DashboardError(`${input.uid} already exists and was not provisioned from a file`);
          if (cur?.provisioned?.checksum === sum && cur.provisioned.file === f.path) { res.unchanged.push(input.uid!); continue; }
          const base: Dashboard = { uid: input.uid!, title: input.title.trim(), tags: input.tags ?? [], owner, timezone: input.timezone ?? 'UTC', time: input.time ?? { from: 'now-6h', to: 'now' }, ...(input.refresh ? { refresh: input.refresh } : {}), variables: input.variables ?? [], panels: input.panels ?? [], shares: cur?.shares ?? [], version: (cur?.version ?? 0) + 1, provisioned: { file: f.path, checksum: sum, allowUiUpdates: j?.allowUiUpdates === true } };
          this.#check(base);
          this.#d.set(base.uid, base);
          (cur ? res.updated : res.created).push(base.uid);
        }
      } catch (e) {
        res.errors.push({ file: f.path, message: e instanceof SyntaxError ? 'the file is not valid JSON' : (e as Error).message });
        for (const d of this.#d.values()) if (d.provisioned?.file === f.path) wanted.add(d.uid);
      }
    }
    if ((o.orphans ?? 'keep') === 'delete') for (const d of [...this.#d.values()]) if (d.provisioned && !wanted.has(d.uid)) { this.#d.delete(d.uid); res.deleted.push(d.uid); }
    return res;
  }

  /** A dashboard as JSON for a provisioning file, in a fixed key order. */
  export(d: Dashboard): string {
    return JSON.stringify({ uid: d.uid, title: d.title, tags: d.tags, timezone: d.timezone, time: d.time, ...(d.refresh ? { refresh: d.refresh } : {}), variables: d.variables, panels: [...d.panels].sort((a, b) => a.id - b.id) }, null, 2);
  }
}

export type Fetch = (table: string, compiled: import('../view-engine/index.ts').Compiled) => Promise<readonly Record<string, unknown>[]> | readonly Record<string, unknown>[];
