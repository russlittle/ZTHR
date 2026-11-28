/**
 * Permalinks: the contract between an address and the content behind it, in both directions from one declaration.
 * A route has a name, a pattern and the content query it stands for:
 *
 *     { name: 'post',     pattern: '/:year/:month/:slug',        query: { type: 'post', year: ':year', month: ':month', slug: ':slug' } }
 *     { name: 'category', pattern: '/category/:path*',           query: { type: 'category', path: ':path' }, paginate: true }
 *
 * - Compile: patterns are checked when the table is built (names, duplicates, ambiguity, a wildcard only last) and
 *   ordered so the most specific wins: literal segments before constrained parameters before plain ones, then the
 *   order declared.
 * - Rewrite: `match` turns a request path into the route, its parameters (typed by their constraint: years and ids
 *   are numbers) and the content query with the parameters filled in. A path is only matched in its canonical
 *   form; `match` says where to redirect when it is not (wrong trailing slash, doubled slashes, a page-1 suffix,
 *   upper-case percent escapes).
 * - Reverse: `build` makes the address for a route and its parameters, validating each against its constraint and
 *   encoding it, so a link can never be written that the table would not route back.
 * - Canonical URLs: one address per content (a trailing-slash policy applied everywhere, page 1 without a page
 *   suffix), absolute against the site's base, and `pagination` gives the first, previous, next and last links.
 *
 * Constraints are named, not regular expressions (`:year<year>`, `:id<int>`, `:slug<slug>`, `:uuid<uuid>`), so a
 * pattern cannot hide a slow expression. Hostile paths (encoded slashes and dots, null bytes, bad escapes, very long
 * or deep paths) are refused, never routed.
 *
 * Not here: serving the content, query strings of the request (they pass through the caller), and host or method
 * routing. Pure: no clock, no network.
 */

export class InvalidPattern extends Error {
  constructor(pattern: string, why: string) {
    super(`the pattern "${pattern}" is not valid: ${why}`);
    this.name = 'InvalidPattern';
  }
}
export class CannotBuild extends Error {
  constructor(route: string, why: string) {
    super(`cannot make an address for ${route}: ${why}`);
    this.name = 'CannotBuild';
  }
}

export type ConstraintName = 'any' | 'int' | 'year' | 'month' | 'day' | 'slug' | 'uuid' | 'alpha';
interface Constraint {
  readonly test: (s: string) => boolean;
  readonly number: boolean;
  readonly rank: number;
}
const CONSTRAINTS: Readonly<Record<ConstraintName, Constraint>> = {
  any: { test: (s) => s.length > 0, number: false, rank: 1 },
  int: { test: (s) => /^(?:0|[1-9]\d{0,14})$/.test(s), number: true, rank: 2 },
  year: { test: (s) => /^\d{4}$/.test(s), number: true, rank: 2 },
  month: { test: (s) => /^(?:0[1-9]|1[0-2])$/.test(s), number: false, rank: 2 },
  day: { test: (s) => /^(?:0[1-9]|[12]\d|3[01])$/.test(s), number: false, rank: 2 },
  slug: { test: (s) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s), number: false, rank: 2 },
  uuid: { test: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s), number: false, rank: 2 },
  alpha: { test: (s) => /^[A-Za-z]+$/.test(s), number: false, rank: 2 },
};

export interface RouteDef {
  readonly name: string;
  readonly pattern: string;
  /** The content query; a string like ":year" is replaced by that parameter's value. */
  readonly query?: Readonly<Record<string, unknown>>;
  /** Accept a /page/N suffix. */
  readonly paginate?: boolean;
}

type Segment =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'param'; readonly name: string; readonly constraint: ConstraintName; readonly optional: boolean }
  | { readonly kind: 'rest'; readonly name: string; readonly constraint: ConstraintName };

interface Compiled {
  readonly def: RouteDef;
  readonly segments: readonly Segment[];
  readonly order: number;
  readonly literals: number;
  readonly constrained: number;
}

export interface Options {
  /** Every canonical address ends with a slash ('always') or none does ('never'). */
  readonly trailingSlash: 'always' | 'never';
  /** The page segment: /page/2. Default 'page'. */
  readonly pageSegment?: string;
  /** Longest path accepted, in characters. Default 2048. */
  readonly maxPathLength?: number;
  readonly maxSegments?: number;
}

export type Params = Readonly<Record<string, string | number>>;

export interface Match {
  readonly route: string;
  readonly params: Readonly<Record<string, string | number>>;
  /** The content query with parameters filled in; includes `page` when the route paginates. */
  readonly query: Readonly<Record<string, unknown>>;
  readonly page: number;
  /** The canonical path for this content, e.g. "/2026/11/hello/". */
  readonly canonical: string;
  /** Set when the request path is not the canonical one: send a permanent redirect there. */
  readonly redirectTo?: string;
}

function parsePattern(def: RouteDef): Segment[] {
  const p = def.pattern;
  if (!p.startsWith('/')) throw new InvalidPattern(p, 'it must start with /');
  const parts = p === '/' ? [] : p.slice(1).replace(/\/$/, '').split('/');
  const segs: Segment[] = [];
  const names = new Set<string>();
  parts.forEach((part, i) => {
    if (part === '') throw new InvalidPattern(p, 'it has an empty segment');
    const m = /^:([A-Za-z_][A-Za-z0-9_]*)(?:<([a-z0-9]+)>)?([?*])?$/.exec(part);
    if (!m) {
      if (part.includes(':') || /[<>*?]/.test(part)) throw new InvalidPattern(p, `"${part}" is not a literal or a parameter`);
      if (/[%\\]/.test(part) || part === '.' || part === '..') throw new InvalidPattern(p, `"${part}" cannot be a literal segment`);
      segs.push({ kind: 'literal', value: part });
      return;
    }
    const name = m[1]!;
    const c = (m[2] ?? 'any') as ConstraintName;
    if (!(c in CONSTRAINTS)) throw new InvalidPattern(p, `"${m[2]}" is not a constraint (${Object.keys(CONSTRAINTS).join(', ')})`);
    if (names.has(name)) throw new InvalidPattern(p, `the parameter "${name}" appears twice`);
    names.add(name);
    const last = i === parts.length - 1;
    if (m[3] && !last) throw new InvalidPattern(p, `"${part}" can only be the last segment`);
    if (m[3] === '*') segs.push({ kind: 'rest', name, constraint: c });
    else segs.push({ kind: 'param', name, constraint: c, optional: m[3] === '?' });
  });
  return segs;
}

const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export class Permalinks {
  private readonly routes: Compiled[];
  private readonly byName = new Map<string, Compiled>();
  private readonly o: Options;
  private readonly page: string;
  private readonly maxPath: number;
  private readonly maxSegs: number;

  constructor(defs: readonly RouteDef[], o: Options) {
    this.o = o;
    this.page = o.pageSegment ?? 'page';
    if (!/^[a-z][a-z0-9-]*$/.test(this.page)) throw new InvalidPattern(this.page, 'the page segment must be a plain word');
    this.maxPath = o.maxPathLength ?? 2048;
    this.maxSegs = o.maxSegments ?? 32;
    const compiled = defs.map((def, order) => {
      if (this.byName.has(def.name)) throw new InvalidPattern(def.pattern, `the route name "${def.name}" is used twice`);
      const segments = parsePattern(def);
      const c: Compiled = { def, segments, order, literals: segments.filter((s) => s.kind === 'literal').length, constrained: segments.filter((s) => s.kind === 'param' && s.constraint !== 'any').length };
      this.byName.set(def.name, c);
      return c;
    });
    // Two routes that accept exactly the same paths: the later could never be reached.
    const shape = (c: Compiled) => c.segments.map((s) => (s.kind === 'literal' ? `L:${s.value}` : s.kind === 'rest' ? `R:${s.constraint}` : `P:${s.constraint}${s.optional ? '?' : ''}`)).join('/');
    const seen = new Map<string, string>();
    for (const c of compiled) {
      const k = shape(c);
      if (seen.has(k)) throw new InvalidPattern(c.def.pattern, `it accepts the same paths as the route "${seen.get(k)}"`);
      seen.set(k, c.def.name);
    }
    this.routes = [...compiled].sort((a, b) => b.literals - a.literals || b.constrained - a.constrained || a.order - b.order);
  }

  private slash(path: string): string {
    if (path === '/') return '/';
    const bare = path.replace(/\/+$/, '');
    return this.o.trailingSlash === 'always' ? `${bare}/` : bare;
  }

  /** Matches a request path (without its query string). Null when no route takes it. */
  match(rawPath: string): Match | null {
    if (typeof rawPath !== 'string' || rawPath.length > this.maxPath || !rawPath.startsWith('/')) return null;
    if (/[\u0000-\u001f\u007f\\]/.test(rawPath)) return null;
    const parts: string[] = [];
    for (const s of rawPath.split('/').slice(1)) {
      if (s === '') continue;
      let d: string;
      try {
        d = decodeURIComponent(s);
      } catch {
        return null;
      }
      if (d === '.' || d === '..' || d.includes('/') || d.includes('\\') || /[\u0000-\u001f\u007f]/.test(d)) return null;
      parts.push(d);
    }
    if (parts.length > this.maxSegs) return null;
    const n = parts.length;
    if (n >= 2 && parts[n - 2] === this.page && /^[1-9]\d{0,8}$/.test(parts[n - 1]!)) {
      const m = this.route(rawPath, parts.slice(0, n - 2), true, Number(parts[n - 1]));
      if (m) return m;
    }
    return this.route(rawPath, parts, false, 1);
  }

  private route(rawPath: string, parts: readonly string[], paged: boolean, page: number): Match | null {
    for (const r of this.routes) {
      if (paged && !r.def.paginate) continue;
      const params = this.fit(r, parts);
      if (!params) continue;
      const query: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r.def.query ?? {})) query[k] = typeof v === 'string' && v.startsWith(':') ? params[v.slice(1)] : v;
      if (r.def.paginate) query['page'] = page;
      const canonical = this.slash(this.canonicalPath(r, params, page));
      return { route: r.def.name, params, query, page, canonical, ...(rawPath === canonical ? {} : { redirectTo: canonical }) };
    }
    return null;
  }

  private fit(r: Compiled, parts: readonly string[]): Record<string, string | number> | null {
    const params: Record<string, string | number> = {};
    let i = 0;
    for (const s of r.segments) {
      if (s.kind === 'literal') {
        if (parts[i] !== s.value) return null;
        i++;
      } else if (s.kind === 'param') {
        const v = parts[i];
        if (v === undefined) {
          if (s.optional) continue;
          return null;
        }
        const c = CONSTRAINTS[s.constraint];
        if (!c.test(v)) return null;
        params[s.name] = c.number ? Number(v) : v;
        i++;
      } else {
        const rest = parts.slice(i);
        if (!rest.length) return null;
        const c = CONSTRAINTS[s.constraint];
        if (!rest.every((p) => c.test(p))) return null;
        params[s.name] = rest.join('/');
        i = parts.length;
      }
    }
    return i === parts.length ? params : null;
  }

  private canonicalPath(r: Compiled, params: Params, page: number): string {
    const out: string[] = [];
    for (const s of r.segments) {
      if (s.kind === 'literal') out.push(encode(s.value));
      else if (s.kind === 'param') {
        const v = params[s.name];
        if (v !== undefined) out.push(encode(String(v)));
      } else out.push(...String(params[s.name]).split('/').map(encode));
    }
    if (page > 1) out.push(this.page, String(page));
    return `/${out.join('/')}`;
  }

  /** The canonical path for a route and its parameters. Throws CannotBuild if a parameter is missing or does not fit. */
  build(name: string, params: Params = {}, o: { page?: number } = {}): string {
    const r = this.byName.get(name);
    if (!r) throw new CannotBuild(name, 'there is no such route');
    const page = o.page ?? 1;
    if (!Number.isInteger(page) || page < 1) throw new CannotBuild(name, 'the page must be a whole number from 1');
    if (page > 1 && !r.def.paginate) throw new CannotBuild(name, 'this route is not paginated');
    const clean: Record<string, string | number> = {};
    for (const s of r.segments) {
      if (s.kind === 'literal') continue;
      const v = params[s.name];
      if (v === undefined) {
        if (s.kind === 'param' && s.optional) continue;
        throw new CannotBuild(name, `the parameter "${s.name}" is missing`);
      }
      const text = String(v);
      const c = CONSTRAINTS[s.constraint];
      const parts = s.kind === 'rest' ? text.split('/') : [text];
      if (!parts.every((p) => c.test(p)) || (s.kind === 'param' && text.includes('/'))) throw new CannotBuild(name, `"${text}" does not fit ${s.name}<${s.constraint}>`);
      clean[s.name] = c.number && s.kind === 'param' ? Number(text) : text;
    }
    for (const k of Object.keys(params)) if (!r.segments.some((s) => s.kind !== 'literal' && s.name === k)) throw new CannotBuild(name, `"${k}" is not a parameter of this route`);
    const path = this.slash(this.canonicalPath(r, clean, page));
    const back = this.match(path);
    if (!back || back.route !== name) throw new CannotBuild(name, `the address ${path} would be routed to ${back ? back.route : 'nothing'}; make the patterns less ambiguous`);
    return path;
  }

  /** The absolute canonical URL, against the site's base address. */
  canonicalUrl(base: string, name: string, params: Params = {}, o: { page?: number } = {}): string {
    const b = new URL(base);
    if (b.protocol !== 'https:' && b.protocol !== 'http:') throw new CannotBuild(name, 'the base must be an http or https address');
    return `${b.origin}${this.build(name, params, o)}`;
  }

  /** The canonical address for any request path that routes, or null. */
  canonicalFor(path: string): string | null {
    const m = this.match(path);
    return m ? m.canonical : null;
  }

  /** First, previous, next and last addresses of a paginated route, with the rel values for link tags. */
  pagination(name: string, params: Params, o: { page: number; totalPages: number }): { canonical: string; first: string | null; prev: string | null; next: string | null; last: string | null; links: { rel: string; href: string }[] } {
    const { page, totalPages } = o;
    if (!Number.isInteger(totalPages) || totalPages < 1) throw new CannotBuild(name, 'totalPages must be a whole number from 1');
    if (!Number.isInteger(page) || page < 1 || page > totalPages) throw new CannotBuild(name, `page ${page} is outside 1 to ${totalPages}`);
    const at = (n: number) => this.build(name, params, { page: n });
    const first = page > 1 ? at(1) : null;
    const prev = page > 1 ? at(page - 1) : null;
    const next = page < totalPages ? at(page + 1) : null;
    const last = page < totalPages ? at(totalPages) : null;
    const links = [
      ...(prev ? [{ rel: 'prev', href: prev }] : []),
      ...(next ? [{ rel: 'next', href: next }] : []),
    ];
    return { canonical: at(page), first, prev, next, last, links };
  }

  get names(): string[] {
    return [...this.byName.keys()];
  }
}
