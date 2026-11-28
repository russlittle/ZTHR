/**
 * Themes that override each other in a known order. A site has an active theme, which may name a parent, which may
 * name another (up to five deep); a template is found by walking a request's template hierarchy (the WordPress
 * hierarchy: single-post-hello, single-post, single, singular, index; page-about, page-7, page; category-news,
 * category-3, category, archive; author, date, search, 404, attachment by MIME type, and the rest) and, for each
 * name in turn, asking the site's own edits first, then the child, then the parent. Classic themes keep templates
 * at `name.html`; block themes keep them at `templates/name.html`, parts at `parts/name.html`, and their settings in
 * `theme.json`, which is deep-merged parent under child (arrays are replaced, never concatenated; `__proto__`,
 * `constructor` and `prototype` keys are dropped). Every name that reaches a path is reduced to `[a-z0-9_-]`, so a
 * slug cannot walk out of the theme. Assets resolve the same way and are versioned by content: the URL carries the
 * first eight hex digits of the file's SHA-256 (`?ver=`), so a changed file busts caches and an unchanged one never
 * does, and an SRI value (sha384) is available for script and style tags.
 *
 * A small template language renders what is found: `{{ a.b }}` (HTML-escaped), `{{{ a.b }}}` (raw), `{% include "x" %}`
 * (a part, resolved through the same theme chain), `{% extends "layout" %}` with `{% block name %}...{% endblock %}`,
 * `{% if a.b %}...{% else %}...{% endif %}`, `{% for x in list %}...{% endfor %}` and `{# comments #}`. Lookups read
 * own properties only (no prototype access, no calls), and size, nesting, loop and output are capped.
 *
 * Out of scope: compiling or caching templates, the full Full Site Editing style system (theme.json is merged and
 * read, not turned into CSS), child themes of block themes mixing both layouts beyond per-theme path rules, and
 * pretty permalinks (the caller turns a request into a context).
 */
import { createHash } from 'node:crypto';

export class ThemeError extends Error {}
export class ThemeChainError extends ThemeError {}
export class TemplateNotFound extends ThemeError {
  readonly tried: readonly string[];
  constructor(tried: readonly string[]) {
    super(`no template found; tried ${tried.slice(0, 12).join(', ')}`);
    this.tried = tried;
  }
}
export class TemplateSyntaxError extends ThemeError {}
export class TemplateLimitError extends ThemeError {}
export class BadAssetPath extends ThemeError {}

export interface Theme {
  readonly id: string;
  readonly parent?: string;
  readonly kind?: 'classic' | 'block';
  /** Template files by path inside the theme: "single.html", "templates/single.html", "parts/header.html". */
  readonly files?: Readonly<Record<string, string>>;
  /** Static files by path: "css/site.css". */
  readonly assets?: Readonly<Record<string, string | Uint8Array>>;
  /** The parsed theme.json, if any. */
  readonly themeJson?: Readonly<Record<string, unknown>>;
}

export type Context =
  | { readonly kind: 'front'; readonly staticPage?: { readonly slug?: string; readonly id?: number; readonly template?: string } }
  | { readonly kind: 'home' }
  | { readonly kind: 'single'; readonly postType: string; readonly slug?: string; readonly id?: number }
  | { readonly kind: 'page'; readonly slug?: string; readonly id?: number; readonly template?: string }
  | { readonly kind: 'taxonomy'; readonly taxonomy: string; readonly term?: string; readonly id?: number }
  | { readonly kind: 'author'; readonly nicename?: string; readonly id?: number }
  | { readonly kind: 'date' }
  | { readonly kind: 'archive'; readonly postType?: string }
  | { readonly kind: 'search' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'attachment'; readonly mime: string };

/** One path segment: lower-case letters, digits, underscore and hyphen only. Empty if nothing is left. */
export function slugPart(s: string | number | undefined): string {
  if (s === undefined) return '';
  return String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/** The template names to try for a request, most specific first. */
export function hierarchy(ctx: Context): string[] {
  const out: string[] = [];
  const add = (...n: string[]) => {
    for (const x of n) if (x && !x.endsWith('-') && !out.includes(x)) out.push(x);
  };
  const withKey = (prefix: string, a: string | number | undefined, b?: string | number) => {
    const s = slugPart(a);
    if (s) add(`${prefix}-${s}`);
    const i = slugPart(b);
    if (i) add(`${prefix}-${i}`);
  };
  const pageNames = (p: { slug?: string | undefined; id?: number | undefined; template?: string | undefined }) => {
    const t = slugPart(p.template?.replace(/\.(html|php)$/, ''));
    if (t) add(t);
    withKey('page', p.slug, p.id);
    add('page', 'singular');
  };
  switch (ctx.kind) {
    case 'front':
      add('front-page');
      if (ctx.staticPage) pageNames(ctx.staticPage);
      else add('home');
      break;
    case 'home':
      add('home');
      break;
    case 'single': {
      const t = slugPart(ctx.postType) || 'post';
      if (t === 'post') withKey('single-post', ctx.slug);
      else withKey(`single-${t}`, ctx.slug);
      add(`single-${t}`, 'single', 'singular');
      break;
    }
    case 'page':
      pageNames(ctx);
      break;
    case 'taxonomy': {
      const tax = slugPart(ctx.taxonomy);
      if (tax === 'category' || tax === 'tag') {
        withKey(tax, ctx.term, ctx.id);
        add(tax);
      } else if (tax) {
        const term = slugPart(ctx.term);
        if (term) add(`taxonomy-${tax}-${term}`);
        add(`taxonomy-${tax}`, 'taxonomy');
      }
      add('archive');
      break;
    }
    case 'author':
      withKey('author', ctx.nicename, ctx.id);
      add('author', 'archive');
      break;
    case 'date':
      add('date', 'archive');
      break;
    case 'archive': {
      const t = slugPart(ctx.postType);
      if (t) add(`archive-${t}`);
      add('archive');
      break;
    }
    case 'search':
      add('search');
      break;
    case 'notFound':
      add('404');
      break;
    case 'attachment': {
      const [type, sub] = ctx.mime.toLowerCase().split('/');
      const a = slugPart(type);
      const b = slugPart(sub?.split(/[;+]/)[0]);
      if (a) add(a);
      if (b) add(b);
      if (a && b) add(`${a}-${b}`);
      add('attachment', 'single', 'singular');
      break;
    }
  }
  add('index');
  return out;
}

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/** Deep merge for theme.json: objects merge, everything else (arrays included) is replaced. */
export function mergeSettings(parent: unknown, child: unknown): unknown {
  if (!isPlain(parent) || !isPlain(child)) return clean(child === undefined ? parent : child);
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(parent), ...Object.keys(child)])) {
    if (FORBIDDEN.has(k)) continue;
    out[k] = k in child ? (k in parent ? mergeSettings(parent[k], child[k]) : clean(child[k])) : clean(parent[k]);
  }
  return out;
}
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean);
  if (!isPlain(v)) return v;
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (!FORBIDDEN.has(k)) o[k] = clean(x);
  return o;
}

const sha = (algo: 'sha256' | 'sha384', data: string | Uint8Array) => createHash(algo).update(data);

function safeAssetPath(p: string): string {
  if (!p || p.length > 300 || p.startsWith('/') || /[\\\u0000-\u001f]/.test(p)) throw new BadAssetPath(`not a theme path: ${JSON.stringify(p.slice(0, 60))}`);
  const segs = p.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) throw new BadAssetPath(`not a theme path: ${JSON.stringify(p.slice(0, 60))}`);
  return p;
}

export interface Found {
  readonly name: string;
  /** Which theme supplied it, or "(site)" for the site's own edits. */
  readonly theme: string;
  readonly path: string;
  readonly source: string;
  readonly tried: readonly string[];
}

export interface AssetInfo {
  readonly theme: string;
  readonly path: string;
  readonly hash: string;
  readonly url: string;
  readonly integrity: string;
  readonly bytes: number;
}

export interface ResolverOptions {
  /** URL prefix the theme assets are served under. Default "/themes". */
  readonly assetBase?: string;
  readonly maxTemplateBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxDepth?: number;
  readonly maxLoopIterations?: number;
}

const SITE = '(site)';

export class Resolver {
  readonly chain: readonly Theme[];
  readonly #custom = new Map<string, string>();
  readonly #o: Required<ResolverOptions>;

  constructor(themes: readonly Theme[], active: string, o: ResolverOptions = {}) {
    const byId = new Map<string, Theme>();
    for (const t of themes) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(t.id)) throw new ThemeError(`bad theme id ${JSON.stringify(t.id.slice(0, 40))}`);
      if (byId.has(t.id)) throw new ThemeError(`theme "${t.id}" is listed twice`);
      byId.set(t.id, t);
    }
    const chain: Theme[] = [];
    const seen = new Set<string>();
    let id: string | undefined = active;
    while (id !== undefined) {
      if (seen.has(id)) throw new ThemeChainError(`theme parents loop: ${[...seen, id].join(' -> ')}`);
      const t = byId.get(id);
      if (!t) throw new ThemeChainError(chain.length ? `theme "${chain[chain.length - 1]!.id}" names a parent "${id}" that is not installed` : `theme "${id}" is not installed`);
      seen.add(id);
      chain.push(t);
      if (chain.length > 5) throw new ThemeChainError('theme parents are nested more than five deep');
      id = t.parent;
    }
    this.chain = chain;
    this.#o = { assetBase: (o.assetBase ?? '/themes').replace(/\/+$/, ''), maxTemplateBytes: o.maxTemplateBytes ?? 200_000, maxOutputBytes: o.maxOutputBytes ?? 1_000_000, maxDepth: o.maxDepth ?? 16, maxLoopIterations: o.maxLoopIterations ?? 10_000 };
  }

  /** The site's own edit of a template (what an editor saved), above every theme. Pass undefined to remove it. */
  setCustom(name: string, source: string | undefined): void {
    const n = slugPart(name);
    if (!n) throw new ThemeError('a template name is needed');
    if (source === undefined) this.#custom.delete(n);
    else {
      if (source.length > this.#o.maxTemplateBytes) throw new TemplateLimitError('the template is too large');
      this.#custom.set(n, source);
    }
  }

  #pathFor(t: Theme, name: string): string {
    return t.kind === 'block' ? `templates/${name}.html` : `${name}.html`;
  }

  /** Find the first template in the hierarchy; for each name: site edits, then the child, then the parents. */
  resolve(ctx: Context | readonly string[]): Found {
    const names = Array.isArray(ctx) ? (ctx as readonly string[]).map(slugPart).filter(Boolean) : hierarchy(ctx as Context);
    const tried: string[] = [];
    for (const name of names) {
      const c = this.#custom.get(name);
      if (c !== undefined) return { name, theme: SITE, path: `(custom)/${name}`, source: c, tried: [...tried, `${SITE}:${name}`] };
      tried.push(`${SITE}:${name}`);
      for (const t of this.chain) {
        const path = this.#pathFor(t, name);
        const src = t.files?.[path];
        tried.push(`${t.id}:${path}`);
        if (src !== undefined) return { name, theme: t.id, path, source: src, tried };
      }
    }
    throw new TemplateNotFound(tried);
  }

  /** A part ("header") from parts/header.html, child before parent. */
  part(name: string): Found {
    const n = slugPart(name);
    if (!n) throw new ThemeError('a part name is needed');
    const tried: string[] = [];
    const c = this.#custom.get(`part-${n}`);
    if (c !== undefined) return { name: n, theme: SITE, path: `(custom)/part-${n}`, source: c, tried: [`${SITE}:part-${n}`] };
    for (const t of this.chain) {
      const path = `parts/${n}.html`;
      tried.push(`${t.id}:${path}`);
      const src = t.files?.[path];
      if (src !== undefined) return { name: n, theme: t.id, path, source: src, tried };
    }
    throw new TemplateNotFound(tried);
  }

  /** theme.json merged from the oldest parent to the child. */
  settings(): Record<string, unknown> {
    let out: unknown = {};
    for (const t of [...this.chain].reverse()) if (t.themeJson) out = mergeSettings(out, t.themeJson);
    return out as Record<string, unknown>;
  }

  /** A setting by dotted path, or the fallback. */
  setting<T = unknown>(path: string, fallback?: T): T | undefined {
    let cur: unknown = this.settings();
    for (const seg of path.split('.')) {
      if (FORBIDDEN.has(seg) || !isPlain(cur) || !Object.hasOwn(cur, seg)) return fallback;
      cur = cur[seg];
    }
    return cur as T;
  }

  asset(path: string): AssetInfo {
    safeAssetPath(path);
    for (const t of this.chain) {
      const data = t.assets && Object.hasOwn(t.assets, path) ? t.assets[path] : undefined;
      if (data === undefined) continue;
      const hash = sha('sha256', data).digest('hex');
      return {
        theme: t.id,
        path,
        hash,
        url: `${this.#o.assetBase}/${t.id}/${path.split('/').map(encodeURIComponent).join('/')}?ver=${hash.slice(0, 8)}`,
        integrity: `sha384-${sha('sha384', data).digest('base64')}`,
        bytes: typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength,
      };
    }
    throw new TemplateNotFound([`asset:${path}`]);
  }

  /** Every asset as the active theme sees it: a child's file hides the parent's of the same path. */
  assets(): AssetInfo[] {
    const paths = new Set<string>();
    for (const t of this.chain) for (const p of Object.keys(t.assets ?? {})) paths.add(p);
    return [...paths].sort().map((p) => this.asset(p));
  }

  /** One value that changes when any asset the active theme serves changes. */
  version(): string {
    const h = createHash('sha256');
    for (const a of this.assets()) h.update(`${a.path}\0${a.theme}\0${a.hash}\n`);
    return h.digest('hex').slice(0, 12);
  }

  // ---------------------------------------------------------------- rendering

  render(ctx: Context | readonly string[], data: unknown = {}): { html: string; found: Found } {
    const found = this.resolve(ctx);
    return { html: this.renderSource(found.source, data, found.name), found };
  }

  renderSource(source: string, data: unknown, label = 'template'): string {
    const st = { out: 0, loops: 0 };
    return this.#run(parse(source, this.#o.maxTemplateBytes, label), data, new Map(), [label], st);
  }

  #run(ast: Node[], data: unknown, over: Map<string, Node[]>, stack: string[], st: { out: number; loops: number }): string {
    if (stack.length > this.#o.maxDepth) throw new TemplateLimitError(`templates are nested too deep: ${stack.slice(-4).join(' -> ')}`);
    const ext = ast.find((n): n is Extends => n.t === 'extends');
    if (ext) {
      const next = new Map(over);
      for (const n of ast) if (n.t === 'block' && !next.has(n.name)) next.set(n.name, n.body);
      const parent = this.resolve([ext.name]);
      if (stack.includes(`extends:${parent.path}`)) throw new TemplateLimitError(`templates extend each other in a loop: ${parent.name}`);
      return this.#run(parse(parent.source, this.#o.maxTemplateBytes, parent.name), data, next, [...stack, `extends:${parent.path}`], st);
    }
    return this.#emit(ast, [data], over, stack, st);
  }

  #emit(ast: Node[], scopes: unknown[], over: Map<string, Node[]>, stack: string[], st: { out: number; loops: number }): string {
    let s = '';
    const put = (x: string) => {
      st.out += x.length;
      if (st.out > this.#o.maxOutputBytes) throw new TemplateLimitError('the output is too large');
      s += x;
    };
    for (const n of ast) {
      switch (n.t) {
        case 'text':
          put(n.v);
          break;
        case 'var': {
          const v = show(lookup(scopes, n.path));
          put(n.raw ? v : escapeHtml(v));
          break;
        }
        case 'if':
          put(this.#emit(truthy(lookup(scopes, n.path)) ? n.then : n.else, scopes, over, stack, st));
          break;
        case 'for': {
          const list = lookup(scopes, n.path);
          if (!Array.isArray(list)) break;
          for (const item of list) {
            if (++st.loops > this.#o.maxLoopIterations) throw new TemplateLimitError('a loop ran too many times');
            put(this.#emit(n.body, [...scopes, { [n.name]: item }], over, stack, st));
          }
          break;
        }
        case 'block':
          put(this.#emit(over.get(n.name) ?? n.body, scopes, over, stack, st));
          break;
        case 'include': {
          const p = this.part(n.name);
          const key = `include:${p.path}:${p.theme}`;
          if (stack.includes(key)) throw new TemplateLimitError(`parts include each other in a loop: ${p.name}`);
          put(this.#emit(parse(p.source, this.#o.maxTemplateBytes, p.name), scopes, new Map(), [...stack, key], st));
          break;
        }
        case 'extends':
          break;
      }
    }
    return s;
  }
}

// ==================================================================== template language

type Text = { t: 'text'; v: string };
type Var = { t: 'var'; path: string; raw: boolean };
type If = { t: 'if'; path: string; then: Node[]; else: Node[] };
type For = { t: 'for'; name: string; path: string; body: Node[] };
type Block = { t: 'block'; name: string; body: Node[] };
type Include = { t: 'include'; name: string };
type Extends = { t: 'extends'; name: string };
type Node = Text | Var | If | For | Block | Include | Extends;

const TOKEN = /\{#[\s\S]*?#\}|\{\{\{\s*([^{}]*?)\s*\}\}\}|\{\{\s*([^{}]*?)\s*\}\}|\{%\s*([^%]*?)\s*%\}/g;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|\d+))*$/;

function parse(src: string, max: number, label: string): Node[] {
  if (src.length > max) throw new TemplateLimitError(`${label} is too large`);
  const root: Node[] = [];
  type Open = { kind: 'if' | 'for' | 'block'; node: If | For | Block; list: Node[] };
  const stack: Open[] = [];
  let cur = root;
  let last = 0;
  const line = (i: number) => src.slice(0, i).split('\n').length;
  const text = (v: string) => {
    if (v) cur.push({ t: 'text', v });
  };
  for (const m of src.matchAll(TOKEN)) {
    text(src.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[0].startsWith('{#')) continue;
    if (m[1] !== undefined || m[2] !== undefined) {
      const path = (m[1] ?? m[2])!;
      if (!PATH.test(path)) throw new TemplateSyntaxError(`${label} line ${line(m.index)}: "${path.slice(0, 40)}" is not a plain name; calls and expressions are not allowed`);
      cur.push({ t: 'var', path, raw: m[1] !== undefined });
      continue;
    }
    const tag = m[3]!;
    const here = `${label} line ${line(m.index)}`;
    let a: RegExpExecArray | null;
    if ((a = /^(include|extends)\s+"([A-Za-z0-9_-]{1,80})"$/.exec(tag))) {
      cur.push({ t: a[1] as 'include' | 'extends', name: a[2]! });
    } else if ((a = /^if\s+(\S+)$/.exec(tag))) {
      if (!PATH.test(a[1]!)) throw new TemplateSyntaxError(`${here}: bad name in if`);
      const node: If = { t: 'if', path: a[1]!, then: [], else: [] };
      cur.push(node);
      stack.push({ kind: 'if', node, list: cur });
      cur = node.then;
    } else if (tag === 'else') {
      const top = stack[stack.length - 1];
      if (!top || top.kind !== 'if') throw new TemplateSyntaxError(`${here}: else without if`);
      cur = (top.node as If).else;
    } else if ((a = /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(\S+)$/.exec(tag))) {
      if (!PATH.test(a[2]!)) throw new TemplateSyntaxError(`${here}: bad name in for`);
      const node: For = { t: 'for', name: a[1]!, path: a[2]!, body: [] };
      cur.push(node);
      stack.push({ kind: 'for', node, list: cur });
      cur = node.body;
    } else if ((a = /^block\s+([A-Za-z0-9_-]{1,80})$/.exec(tag))) {
      const node: Block = { t: 'block', name: a[1]!, body: [] };
      cur.push(node);
      stack.push({ kind: 'block', node, list: cur });
      cur = node.body;
    } else if (tag === 'endif' || tag === 'endfor' || tag === 'endblock') {
      const top = stack.pop();
      if (!top || `end${top.kind}` !== tag) throw new TemplateSyntaxError(`${here}: ${tag} does not match an open tag`);
      cur = top.list;
    } else {
      throw new TemplateSyntaxError(`${here}: unknown tag "${tag.slice(0, 30)}"`);
    }
    if (stack.length > 32) throw new TemplateLimitError(`${label} is nested too deep`);
  }
  text(src.slice(last));
  if (stack.length) throw new TemplateSyntaxError(`${label}: ${stack[stack.length - 1]!.kind} is never closed`);
  return root;
}

function lookup(scopes: unknown[], path: string): unknown {
  const segs = path.split('.');
  for (let i = scopes.length - 1; i >= 0; i--) {
    const s = scopes[i];
    if (isObj(s) && !FORBIDDEN.has(segs[0]!) && Object.hasOwn(s, segs[0]!)) {
      let cur: unknown = (s as Record<string, unknown>)[segs[0]!];
      for (const seg of segs.slice(1)) {
        if (FORBIDDEN.has(seg)) return undefined;
        if (Array.isArray(cur)) cur = /^\d+$/.test(seg) ? cur[Number(seg)] : undefined;
        else if (isObj(cur) && Object.hasOwn(cur, seg)) cur = (cur as Record<string, unknown>)[seg];
        else return undefined;
      }
      return cur;
    }
  }
  return undefined;
}
const isObj = (v: unknown): v is object => typeof v === 'object' && v !== null;
const show = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' ? String(v) : '');
const truthy = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : isObj(v) ? true : Boolean(v));
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
