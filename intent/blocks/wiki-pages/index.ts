/**
 * Wiki pages: a tree of pages addressed by slug paths ("handbook/onboarding/laptops"), with a revision for every
 * save, templates, per-page permissions that children inherit, edit locks and backlinks.
 *
 * - Page tree: create under a parent, move (refusing a move into the page's own subtree or onto a taken slug),
 *   delete (refusing a page with children unless asked), breadcrumbs and children in title order.
 * - Revisions: every save is a numbered revision kept by the history block (title, body, slug and parent). A save
 *   names the revision it started from and is refused as a Conflict if someone saved since; revisions can be read,
 *   compared line by line, and restored (as a new revision, never by rewriting the past).
 * - Templates: named title and body with `{{name}}` placeholders (plus `{{title}}`, `{{date}}`, `{{user}}`); a page
 *   made from one fills every placeholder or the creation is refused.
 * - Permissions: roles none < read < edit < admin, granted to a user id, a `group:<name>` or `*`. The nearest page up
 *   the tree that has an entry for the person decides; a user entry beats a group entry beats `*`; nothing granted
 *   means `defaultRole` (none). Listing, search and backlinks only show what the person may read.
 * - Locks: a person can hold a page for a time (injected clock). Others cannot save while it is held; the holder
 *   can renew or release, and an admin can break it.
 * - Backlinks: `[[Target]]` and `[[Target|label]]` in a page body (not inside code) link to other pages by path
 *   (absolute from the root when it starts with "/", otherwise beside the page, then from the root). Links to pages
 *   that do not exist yet are remembered and become backlinks when the page is created. Rendering turns them into
 *   links, with a "?new=1" link for missing pages.
 *
 * Clock and ids are injected. Bodies are rendered through the markdown block, which never passes raw HTML.
 *
 * Out of scope: deleted pages keep no recoverable revisions, backlinks are computed by scanning all pages (fine to a
 * few thousand pages, put an index in the store beyond that), no attachments, no full-text search (title and slug
 * search only), and no real-time co-editing.
 */

import { History, Conflict as HistoryConflict } from '../history/index.ts';
import { parse, render as renderMarkdown, slugify, walk, type Node as MdNode } from '../markdown/index.ts';

export type Role = 'none' | 'read' | 'edit' | 'admin';
const RANK: Record<Role, number> = { none: 0, read: 1, edit: 2, admin: 3 };

export interface User {
  readonly id: string;
  readonly groups?: readonly string[];
}

export type WikiErrorCode = 'not-found' | 'forbidden' | 'conflict' | 'locked' | 'exists' | 'invalid' | 'cycle' | 'limit' | 'has-children';
export class WikiError extends Error {
  readonly code: WikiErrorCode;
  constructor(code: WikiErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface WikiOptions {
  readonly now: () => Date;
  readonly id: () => string;
  /** People who may do anything. */
  readonly admins?: readonly string[];
  /** Role when no page up the tree names the person (default 'none'). */
  readonly defaultRole?: Role;
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly maxChildren?: number;
  readonly maxPages?: number;
  readonly lockSeconds?: number;
  /** Prefix of page links in rendered HTML (default "/wiki/"). */
  readonly linkBase?: string;
}

export interface Page {
  readonly id: string;
  readonly path: string;
  readonly slug: string;
  readonly parent: string | null;
  readonly title: string;
  readonly body: string;
  readonly version: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface Revision {
  readonly version: number;
  readonly by: string;
  readonly at: string;
  readonly note?: string;
  readonly changed: readonly string[];
}

export interface LineOp {
  readonly op: 'same' | 'add' | 'del';
  readonly line: string;
}

export interface Template {
  readonly name: string;
  readonly title: string;
  readonly body: string;
}

export interface Lock {
  readonly page: string;
  readonly by: string;
  readonly since: string;
  readonly expires: string;
}

interface Stored {
  id: string;
  parent: string | null;
  slug: string;
  title: string;
  body: string;
  acl: Map<string, Role>;
  createdBy: string;
  createdAt: string;
  links: string[];
}

const RESERVED = new Set(['new', 'edit', 'history', 'api', 'admin', '_', 'index']);
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

/** Line diff by longest common subsequence; refuses very large inputs. */
export function diffLines(a: string, b: string, max = 3000): LineOp[] {
  const x = a === '' ? [] : a.split('\n'), y = b === '' ? [] : b.split('\n');
  if (x.length > max || y.length > max) throw new WikiError('limit', `pages longer than ${max} lines cannot be compared`);
  const n = x.length, m = y.length;
  const t: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i]![j] = x[i] === y[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
  const out: LineOp[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ op: 'same', line: x[i]! }); i++; j++; }
    else if (t[i + 1]![j]! >= t[i]![j + 1]!) out.push({ op: 'del', line: x[i++]! });
    else out.push({ op: 'add', line: y[j++]! });
  }
  while (i < n) out.push({ op: 'del', line: x[i++]! });
  while (j < m) out.push({ op: 'add', line: y[j++]! });
  return out;
}

const WIKILINK = /\[\[([^\][|\n]{1,200})(?:\|([^\][\n]{1,200}))?\]\]/g;

/** The targets named by `[[...]]` in a body, outside code, in order and without repeats. */
export function extractLinks(body: string): { target: string; label: string }[] {
  const out: { target: string; label: string }[] = [];
  const seen = new Set<string>();
  walk(parse(body, { maxLength: 2_000_000 }), {
    enter(n) {
      if (n.type !== 'text' || n.value === undefined) return;
      for (const m of n.value.matchAll(WIKILINK)) {
        const target = m[1]!.trim();
        if (target && !seen.has(target)) { seen.add(target); out.push({ target, label: (m[2] ?? m[1])!.trim() }); }
      }
    },
  });
  return out;
}

export class Wiki {
  private readonly o: Required<Omit<WikiOptions, 'admins'>> & { admins: ReadonlySet<string> };
  private readonly pages = new Map<string, Stored>();
  private readonly kids = new Map<string, Map<string, string>>();
  private readonly rootAcl = new Map<string, Role>();
  private readonly history: History;
  private readonly templates = new Map<string, Template>();
  private readonly locks = new Map<string, { by: string; since: Date; expires: Date }>();

  constructor(o: WikiOptions) {
    this.o = {
      now: o.now, id: o.id, admins: new Set(o.admins ?? []), defaultRole: o.defaultRole ?? 'none',
      maxBytes: o.maxBytes ?? 1_000_000, maxDepth: o.maxDepth ?? 12, maxChildren: o.maxChildren ?? 1000,
      maxPages: o.maxPages ?? 100_000, lockSeconds: o.lockSeconds ?? 900, linkBase: o.linkBase ?? '/wiki/',
    };
    this.history = new History(o.now);
  }

  // ---------------------------------------------------------------- lookup and permissions

  private childMap(parent: string | null): Map<string, string> {
    const k = parent ?? '';
    let m = this.kids.get(k);
    if (!m) { m = new Map(); this.kids.set(k, m); }
    return m;
  }

  private pathOf(id: string): string {
    const parts: string[] = [];
    for (let cur: string | null = id, n = 0; cur !== null; n++) {
      const p = this.pages.get(cur);
      if (!p || n > 100) break;
      parts.unshift(p.slug);
      cur = p.parent;
    }
    return parts.join('/');
  }

  private depthOf(id: string | null): number {
    let d = 0;
    for (let cur = id; cur !== null && d < 200; d++) cur = this.pages.get(cur)?.parent ?? null;
    return d;
  }

  private find(path: string): Stored | undefined {
    if (typeof path !== 'string' || path === '' || path.length > 2000) return undefined;
    let parent: string | null = null;
    let cur: Stored | undefined;
    for (const seg of path.split('/')) {
      const id: string | undefined = this.kids.get(parent ?? '')?.get(seg);
      cur = id === undefined ? undefined : this.pages.get(id);
      if (!cur) return undefined;
      parent = cur.id;
    }
    return cur;
  }

  private roleIn(acl: Map<string, Role>, u: User): Role | undefined {
    const direct = acl.get(`user:${u.id}`);
    if (direct !== undefined) return direct;
    let best: Role | undefined;
    for (const g of u.groups ?? []) {
      const r = acl.get(`group:${g}`);
      if (r !== undefined && (best === undefined || RANK[r] > RANK[best])) best = r;
    }
    return best ?? acl.get('*');
  }

  private roleFor(u: User, id: string | null): Role {
    if (this.o.admins.has(u.id)) return 'admin';
    for (let cur = id, n = 0; cur !== null && n < 200; n++) {
      const p = this.pages.get(cur);
      if (!p) break;
      const r = this.roleIn(p.acl, u);
      if (r !== undefined) return r;
      cur = p.parent;
    }
    return this.roleIn(this.rootAcl, u) ?? this.o.defaultRole;
  }

  private need(u: User, id: string | null, role: Exclude<Role, 'none'>, what: string): void {
    if (RANK[this.roleFor(u, id)] < RANK[role]) throw new WikiError('forbidden', `you do not have permission to ${what}`);
  }

  /** Looks a page up for someone who must be able to read it; a page they cannot read looks like a missing one. */
  private open(u: User, path: string): Stored {
    const p = this.find(path);
    if (!p || RANK[this.roleFor(u, p.id)] < RANK.read) throw new WikiError('not-found', `there is no page "${String(path).slice(0, 200)}"`);
    return p;
  }

  private view(p: Stored): Page {
    const log = this.history.log(p.id);
    const last = log[log.length - 1]!;
    return { id: p.id, path: this.pathOf(p.id), slug: p.slug, parent: p.parent, title: p.title, body: p.body, version: log.length, createdBy: p.createdBy, createdAt: p.createdAt, updatedBy: last.by, updatedAt: last.at };
  }

  private checkContent(title: string, body: string): void {
    if (typeof title !== 'string' || title.trim() === '' || title.length > 200 || /[\u0000-\u001f\u007f]/.test(title)) throw new WikiError('invalid', 'a title is 1 to 200 characters with no control characters');
    if (typeof body !== 'string' || Buffer.byteLength(body) > this.o.maxBytes) throw new WikiError('limit', `a page body may be at most ${this.o.maxBytes} bytes`);
  }

  private checkSlug(slug: string): void {
    if (!SLUG.test(slug) || RESERVED.has(slug)) throw new WikiError('invalid', `"${slug}" cannot be a page name: use lower-case letters, digits and hyphens, and not ${[...RESERVED].join(', ')}`);
  }

  private fields(p: Stored) {
    return { title: p.title, body: p.body, slug: p.slug, parent: p.parent };
  }

  private heldByOther(u: User, id: string): Lock | undefined {
    const l = this.locks.get(id);
    if (!l) return undefined;
    if (l.expires <= this.o.now()) { this.locks.delete(id); return undefined; }
    return l.by === u.id ? undefined : { page: this.pathOf(id), by: l.by, since: l.since.toISOString(), expires: l.expires.toISOString() };
  }

  private mustNotBeLocked(u: User, id: string): void {
    const l = this.heldByOther(u, id);
    if (l) throw new WikiError('locked', `${l.page} is being edited by ${l.by} until ${l.expires}`);
  }

  // ---------------------------------------------------------------- templates

  defineTemplate(u: User, t: Template): void {
    if (!this.o.admins.has(u.id)) throw new WikiError('forbidden', 'only an administrator can define templates');
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(t.name)) throw new WikiError('invalid', 'a template name is lower-case letters, digits and hyphens');
    this.checkContent(t.title, t.body);
    this.templates.set(t.name, { name: t.name, title: t.title, body: t.body });
  }

  removeTemplate(u: User, name: string): boolean {
    if (!this.o.admins.has(u.id)) throw new WikiError('forbidden', 'only an administrator can remove templates');
    return this.templates.delete(name);
  }

  listTemplates(): string[] {
    return [...this.templates.keys()].sort();
  }

  private fill(text: string, vars: Record<string, string>, what: string): string {
    return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,40})\s*\}\}/g, (_m, k: string) => {
      if (!Object.hasOwn(vars, k)) throw new WikiError('invalid', `the template needs a value for "${k}" in its ${what}`);
      return vars[k]!;
    });
  }

  // ---------------------------------------------------------------- pages

  create(u: User, input: { parent?: string | null; title?: string; slug?: string; body?: string; template?: string; vars?: Record<string, string> }): Page {
    const parent = input.parent ? this.open(u, input.parent) : undefined;
    this.need(u, parent?.id ?? null, 'edit', parent ? `add pages under ${input.parent}` : 'add pages at the top level');
    let title = input.title, body = input.body ?? '';
    if (input.template !== undefined) {
      const t = this.templates.get(input.template);
      if (!t) throw new WikiError('not-found', `there is no template "${input.template}"`);
      const vars: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, { title: input.title ?? '', date: this.o.now().toISOString().slice(0, 10), user: u.id });
      for (const [k, v] of Object.entries(input.vars ?? {})) if (typeof v === 'string') Object.defineProperty(vars, k, { value: v, enumerable: true, writable: true, configurable: true });
      title = this.fill(input.title ?? t.title, vars, 'title');
      body = this.fill(t.body, vars, 'body');
    }
    if (title === undefined) throw new WikiError('invalid', 'a page needs a title');
    this.checkContent(title, body);
    const slug = input.slug ?? slugify(title);
    this.checkSlug(slug);
    if (this.pages.size >= this.o.maxPages) throw new WikiError('limit', `the wiki is limited to ${this.o.maxPages} pages`);
    if (this.depthOf(parent?.id ?? null) + 1 > this.o.maxDepth) throw new WikiError('limit', `pages may be nested at most ${this.o.maxDepth} deep`);
    const siblings = this.childMap(parent?.id ?? null);
    if (siblings.has(slug)) throw new WikiError('exists', `there is already a page called "${slug}" there`);
    if (siblings.size >= this.o.maxChildren) throw new WikiError('limit', `a page may have at most ${this.o.maxChildren} sub-pages`);
    const id = this.o.id();
    if (this.pages.has(id)) throw new WikiError('invalid', 'the id generator returned an id already in use');
    const p: Stored = { id, parent: parent?.id ?? null, slug, title, body, acl: new Map(), createdBy: u.id, createdAt: this.o.now().toISOString(), links: extractLinks(body).map((l) => l.target) };
    this.pages.set(id, p);
    siblings.set(slug, id);
    this.history.change(id, u.id, this.fields(p), { note: 'created' });
    return this.view(p);
  }

  get(u: User, path: string): Page {
    return this.view(this.open(u, path));
  }

  save(u: User, path: string, change: { title?: string; body?: string; expected: number; note?: string }): Page {
    const p = this.open(u, path);
    this.need(u, p.id, 'edit', `change ${path}`);
    this.mustNotBeLocked(u, p.id);
    const title = change.title ?? p.title, body = change.body ?? p.body;
    this.checkContent(title, body);
    if (title === p.title && body === p.body) {
      if (change.expected !== this.history.version(p.id)) throw new WikiError('conflict', `the page is at revision ${this.history.version(p.id)}, not ${change.expected}`);
      return this.view(p);
    }
    try {
      this.history.change(p.id, u.id, { title, body }, { expected: change.expected, ...(change.note ? { note: change.note.slice(0, 200) } : {}) });
    } catch (e) {
      if (e instanceof HistoryConflict) throw new WikiError('conflict', `the page is at revision ${this.history.version(p.id)}, not ${change.expected}; reload and merge`);
      throw e;
    }
    p.title = title;
    p.body = body;
    p.links = extractLinks(body).map((l) => l.target);
    return this.view(p);
  }

  move(u: User, path: string, to: { parent: string | null; slug?: string }): Page {
    const p = this.open(u, path);
    this.need(u, p.id, 'edit', `move ${path}`);
    this.mustNotBeLocked(u, p.id);
    const target = to.parent ? this.open(u, to.parent) : undefined;
    this.need(u, target?.id ?? null, 'edit', 'move pages there');
    for (let cur: string | null = target?.id ?? null, n = 0; cur !== null && n < 200; n++) {
      if (cur === p.id) throw new WikiError('cycle', 'a page cannot be moved into itself or one of its own sub-pages');
      cur = this.pages.get(cur)?.parent ?? null;
    }
    const slug = to.slug ?? p.slug;
    this.checkSlug(slug);
    const height = (id: string): number => Math.max(0, ...[...(this.kids.get(id)?.values() ?? [])].map((c) => 1 + height(c)));
    if (this.depthOf(target?.id ?? null) + 1 + height(p.id) > this.o.maxDepth) throw new WikiError('limit', `pages may be nested at most ${this.o.maxDepth} deep`);
    const siblings = this.childMap(target?.id ?? null);
    if (siblings.has(slug) && siblings.get(slug) !== p.id) throw new WikiError('exists', `there is already a page called "${slug}" there`);
    if (siblings.size >= this.o.maxChildren && !siblings.has(slug)) throw new WikiError('limit', `a page may have at most ${this.o.maxChildren} sub-pages`);
    if ((p.parent ?? null) === (target?.id ?? null) && slug === p.slug) return this.view(p);
    this.childMap(p.parent).delete(p.slug);
    p.parent = target?.id ?? null;
    p.slug = slug;
    siblings.set(slug, p.id);
    this.history.change(p.id, u.id, { slug, parent: p.parent }, { note: 'moved' });
    return this.view(p);
  }

  remove(u: User, path: string, o: { recursive?: boolean } = {}): number {
    const p = this.open(u, path);
    this.need(u, p.id, 'admin', `delete ${path}`);
    const all: string[] = [];
    const collect = (id: string) => { all.push(id); for (const c of this.kids.get(id)?.values() ?? []) collect(c); };
    collect(p.id);
    if (all.length > 1 && !o.recursive) throw new WikiError('has-children', `${path} has ${all.length - 1} sub-pages; delete them too by asking for a recursive delete`);
    for (const id of all) {
      this.mustNotBeLocked(u, id);
      if (RANK[this.roleFor(u, id)] < RANK.admin) throw new WikiError('forbidden', `you do not have permission to delete ${this.pathOf(id)}`);
    }
    this.childMap(p.parent).delete(p.slug);
    for (const id of all) { this.pages.delete(id); this.kids.delete(id); this.locks.delete(id); }
    return all.length;
  }

  children(u: User, path: string | null): Page[] {
    const id = path === null ? null : this.open(u, path).id;
    const out: Page[] = [];
    for (const c of this.kids.get(id ?? '')?.values() ?? []) if (RANK[this.roleFor(u, c)] >= RANK.read) out.push(this.view(this.pages.get(c)!));
    return out.sort((a, b) => a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug));
  }

  breadcrumbs(u: User, path: string): { path: string; title: string }[] {
    const p = this.open(u, path);
    const out: { path: string; title: string }[] = [];
    for (let cur: string | null = p.id, n = 0; cur !== null && n < 200; n++) {
      const q: Stored = this.pages.get(cur)!;
      if (RANK[this.roleFor(u, cur)] >= RANK.read) out.unshift({ path: this.pathOf(cur), title: q.title });
      cur = q.parent;
    }
    return out;
  }

  /** The readable part of the tree below a page (or the whole wiki), to a depth. */
  tree(u: User, path: string | null = null, depth = 3): { path: string; title: string; children: unknown[] }[] {
    const walkKids = (id: string | null, d: number): { path: string; title: string; children: unknown[] }[] => {
      if (d <= 0) return [];
      const out: { path: string; title: string; children: unknown[] }[] = [];
      for (const c of this.kids.get(id ?? '')?.values() ?? []) {
        if (RANK[this.roleFor(u, c)] < RANK.read) continue;
        const q: Stored = this.pages.get(c)!;
        out.push({ path: this.pathOf(c), title: q.title, children: walkKids(c, d - 1) });
      }
      return out.sort((a, b) => a.title.localeCompare(b.title));
    };
    return walkKids(path === null ? null : this.open(u, path).id, Math.min(depth, 20));
  }

  search(u: User, query: string, limit = 20): Page[] {
    const q = query.trim().toLowerCase();
    if (q === '') return [];
    const hits: { p: Stored; score: number }[] = [];
    for (const p of this.pages.values()) {
      if (RANK[this.roleFor(u, p.id)] < RANK.read) continue;
      const t = p.title.toLowerCase();
      const score = t === q ? 3 : t.startsWith(q) ? 2 : t.includes(q) || p.slug.includes(q) ? 1 : 0;
      if (score) hits.push({ p, score });
    }
    return hits.sort((a, b) => b.score - a.score || a.p.title.localeCompare(b.p.title)).slice(0, Math.min(limit, 100)).map((h) => this.view(h.p));
  }

  // ---------------------------------------------------------------- revisions

  revisions(u: User, path: string): Revision[] {
    const p = this.open(u, path);
    return this.history.log(p.id).map((c) => ({ version: c.version, by: c.by, at: c.at, ...(c.note ? { note: c.note } : {}), changed: Object.keys(c.after).sort() }));
  }

  /** The page as it was at a revision. */
  revision(u: User, path: string, version: number): { version: number; title: string; body: string; slug: string } {
    const p = this.open(u, path);
    if (!Number.isInteger(version) || version < 1 || version > this.history.version(p.id)) throw new WikiError('not-found', `${path} has no revision ${version}`);
    const f = this.history.at(p.id, version);
    return { version, title: String(f.title ?? ''), body: String(f.body ?? ''), slug: String(f.slug ?? '') };
  }

  compare(u: User, path: string, from: number, to: number): { fields: string[]; lines: LineOp[] } {
    const a = this.revision(u, path, from), b = this.revision(u, path, to);
    const fields = (['title', 'slug', 'body'] as const).filter((k) => a[k] !== b[k]);
    return { fields, lines: diffLines(a.body, b.body) };
  }

  /** Puts an older revision's title and body back as a new revision. */
  restore(u: User, path: string, version: number, expected: number): Page {
    const r = this.revision(u, path, version);
    return this.save(u, path, { title: r.title, body: r.body, expected, note: `restored revision ${version}` });
  }

  // ---------------------------------------------------------------- permissions

  /** Grants a role on a page (or the whole wiki when path is null) to "user:<id>", "group:<name>" or "*"; null removes the entry. */
  setAccess(u: User, path: string | null, subject: string, role: Role | null): void {
    const p = path === null ? undefined : this.open(u, path);
    this.need(u, p?.id ?? null, 'admin', 'change who can use this page');
    if (!/^(\*|user:[^\s]{1,100}|group:[^\s]{1,100})$/.test(subject)) throw new WikiError('invalid', 'a subject is "*", "user:<id>" or "group:<name>"');
    if (role !== null && !(role in RANK)) throw new WikiError('invalid', `"${String(role)}" is not a role`);
    const acl = p ? p.acl : this.rootAcl;
    if (role === null) acl.delete(subject);
    else acl.set(subject, role);
  }

  access(u: User, path: string | null): { subject: string; role: Role }[] {
    const p = path === null ? undefined : this.open(u, path);
    this.need(u, p?.id ?? null, 'admin', 'see who can use this page');
    return [...(p ? p.acl : this.rootAcl)].map(([subject, role]) => ({ subject, role })).sort((a, b) => a.subject.localeCompare(b.subject));
  }

  /** The role a person has on a page, after inheritance. */
  roleOn(u: User, path: string | null): Role {
    return this.roleFor(u, path === null ? null : (this.find(path)?.id ?? null));
  }

  // ---------------------------------------------------------------- locks

  lock(u: User, path: string): Lock {
    const p = this.open(u, path);
    this.need(u, p.id, 'edit', `edit ${path}`);
    this.mustNotBeLocked(u, p.id);
    const now = this.o.now();
    const l = { by: u.id, since: this.locks.get(p.id)?.since ?? now, expires: new Date(now.getTime() + this.o.lockSeconds * 1000) };
    this.locks.set(p.id, l);
    return { page: this.pathOf(p.id), by: l.by, since: l.since.toISOString(), expires: l.expires.toISOString() };
  }

  unlock(u: User, path: string): boolean {
    const p = this.open(u, path);
    const l = this.locks.get(p.id);
    if (!l) return false;
    if (l.by !== u.id) throw new WikiError('locked', `${path} is locked by ${l.by}`);
    return this.locks.delete(p.id);
  }

  breakLock(u: User, path: string): boolean {
    const p = this.open(u, path);
    this.need(u, p.id, 'admin', `break the lock on ${path}`);
    return this.locks.delete(p.id);
  }

  lockOf(u: User, path: string): Lock | undefined {
    const p = this.open(u, path);
    const l = this.locks.get(p.id);
    if (!l || l.expires <= this.o.now()) return undefined;
    return { page: this.pathOf(p.id), by: l.by, since: l.since.toISOString(), expires: l.expires.toISOString() };
  }

  // ---------------------------------------------------------------- links

  /** Resolves link text from a page to the path it names (existing or not): "/a/b" is from the root, otherwise beside the page, then from the root. */
  private resolveLink(from: Stored, target: string): { path: string; id: string | undefined } {
    const segs = target.replace(/^\//, '').split('/').map((s) => slugify(s.trim())).filter(Boolean);
    const abs = segs.join('/');
    if (target.startsWith('/')) return { path: abs, id: this.find(abs)?.id };
    const parentPath = from.parent === null ? '' : this.pathOf(from.parent);
    const beside = parentPath ? `${parentPath}/${abs}` : abs;
    const hit = this.find(beside) ?? this.find(abs);
    return hit ? { path: this.pathOf(hit.id), id: hit.id } : { path: beside, id: undefined };
  }

  backlinks(u: User, path: string): Page[] {
    const p = this.open(u, path);
    const out: Page[] = [];
    for (const q of this.pages.values()) {
      if (q.id === p.id || RANK[this.roleFor(u, q.id)] < RANK.read) continue;
      if (q.links.some((t) => this.resolveLink(q, t).id === p.id)) out.push(this.view(q));
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Links in readable pages that point at pages which do not exist. */
  brokenLinks(u: User): { from: string; target: string }[] {
    const out: { from: string; target: string }[] = [];
    for (const q of this.pages.values()) {
      if (RANK[this.roleFor(u, q.id)] < RANK.read) continue;
      for (const t of q.links) if (!this.resolveLink(q, t).id) out.push({ from: this.pathOf(q.id), target: t });
    }
    return out.sort((a, b) => a.from.localeCompare(b.from) || a.target.localeCompare(b.target));
  }

  /** The page body as safe HTML, with `[[links]]` turned into links. */
  html(u: User, path: string): string {
    const p = this.open(u, path);
    const root = parse(p.body, { maxLength: this.o.maxBytes });
    const base = this.o.linkBase;
    const link = (target: string, label: string): MdNode => {
      const r = this.resolveLink(p, target);
      const url = base + r.path.split('/').map(encodeURIComponent).join('/') + (r.id ? '' : '?new=1');
      return { type: 'link', url, children: [{ type: 'text', value: label }] };
    };
    const rewrite = (n: MdNode): void => {
      if (!n.children) return;
      const next: MdNode[] = [];
      for (const c of n.children) {
        if (c.type === 'text' && c.value !== undefined && c.value.includes('[[')) {
          let last = 0;
          for (const m of c.value.matchAll(WIKILINK)) {
            if (m.index > last) next.push({ type: 'text', value: c.value.slice(last, m.index) });
            next.push(link(m[1]!.trim(), (m[2] ?? m[1])!.trim()));
            last = m.index + m[0].length;
          }
          if (last < c.value.length) next.push({ type: 'text', value: c.value.slice(last) });
        } else { rewrite(c); next.push(c); }
      }
      n.children = next;
    };
    rewrite(root);
    return renderMarkdown(root, { headingIds: true, externalLinks: true });
  }
}
