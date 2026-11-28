/**
 * Wiki links: the `[[Page]]` syntax, the graph of who links to whom, backlinks, orphan and broken-link reports,
 * and a rename that rewrites every link that pointed at the old title.
 *
 * Syntax (the Obsidian, Wiki.js and Outline convention): `[[Target]]`, `[[Target|label]]`, `[[Target#Heading]]`,
 * `[[Target#Heading|label]]`, `[[#Heading]]` for the same page, and `![[Target]]` to embed. A backslash before
 * the brackets (`\[[x]]`) is not a link. Links inside fenced or indented code (found with the markdown block's
 * parser) and inside inline code spans are not links either, so a rename never touches code samples.
 *
 * Titles compare the way people read them: Unicode-normalised, case-insensitive, with runs of spaces and
 * underscores the same. A heading anchor is checked against the target page's headings with the markdown block's
 * slug rules. Two pages with one title make a link to it `ambiguous`, which is reported, never guessed at.
 *
 * Out of scope: rendering links to HTML (the markdown block renders; this block finds and rewrites), namespaces
 * beyond a `folder/Title` path in the title, and fetching pages from a store.
 */
import { collect, headingIds, parse, slugify } from '../markdown/index.ts';

export class WikiLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WikiLinkError';
  }
}

export const MAX_LINK = 300;
export const MAX_PAGE = 2_000_000;

export interface WikiLink {
  /** The link as written, brackets included. */
  readonly raw: string;
  /** Offsets into the source: start inclusive, end exclusive. */
  readonly start: number;
  readonly end: number;
  /** The target title as written, trimmed; empty for `[[#Heading]]`. */
  readonly target: string;
  readonly heading: string | undefined;
  readonly label: string | undefined;
  readonly embed: boolean;
  /** 1-based line the link starts on. */
  readonly line: number;
}

/** The key two titles are equal under. */
export function titleKey(title: string): string {
  return title.normalize('NFKC').replace(/[\s_]+/g, ' ').trim().toLowerCase();
}

/** Which characters of a source are code, by block structure (markdown parser) and inline backtick spans. */
function codeMask(src: string): Uint8Array {
  const mask = new Uint8Array(src.length);
  const lineStart: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStart.push(i + 1);
  const tree = parse(src, { gfm: true, maxLength: MAX_PAGE });
  for (const c of collect(tree, 'code')) {
    if (!c.position) continue;
    const from = lineStart[c.position.start.line - 1] ?? 0;
    const to = lineStart[c.position.end.line] ?? src.length;
    mask.fill(1, from, to);
  }
  for (const m of src.matchAll(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g)) mask.fill(1, m.index, m.index + m[0].length);
  return mask;
}

/** Every wiki link in a source, in order. Links over 300 characters or across a line break are not links. */
export function parseLinks(src: string): WikiLink[] {
  if (src.length > MAX_PAGE) throw new WikiLinkError(`a page over ${MAX_PAGE} characters`);
  if (!src.includes('[[')) return [];
  const mask = codeMask(src);
  const out: WikiLink[] = [];
  const re = /(!?)\[\[([^\[\]\n]{1,300})\]\]/g;
  for (const m of src.matchAll(re)) {
    const embed = m[1] === '!';
    const at = m.index;
    const bracket = at + (embed ? 1 : 0);
    if (mask[bracket] === 1) continue;
    let backslashes = 0;
    for (let i = at - 1; i >= 0 && src[i] === '\\'; i--) backslashes++;
    if (backslashes % 2 === 1) continue;
    const inner = m[2]!;
    const bar = inner.indexOf('|');
    const path = (bar < 0 ? inner : inner.slice(0, bar)).trim();
    const label = bar < 0 ? undefined : inner.slice(bar + 1).trim();
    const hash = path.indexOf('#');
    const target = (hash < 0 ? path : path.slice(0, hash)).trim();
    const heading = hash < 0 ? undefined : path.slice(hash + 1).trim();
    if (target === '' && (heading === undefined || heading === '')) continue;
    out.push({
      raw: m[0],
      start: at,
      end: at + m[0].length,
      target,
      heading: heading === '' ? undefined : heading,
      label: label === '' ? undefined : label,
      embed,
      line: src.slice(0, at).split('\n').length,
    });
  }
  return out;
}

export interface Page {
  readonly id: string;
  readonly title: string;
  readonly aliases?: readonly string[];
  readonly body: string;
}

export type Resolution =
  | { readonly status: 'ok'; readonly page: string }
  | { readonly status: 'missing' }
  | { readonly status: 'ambiguous'; readonly pages: readonly string[] };

export interface ResolvedLink {
  readonly from: string;
  readonly link: WikiLink;
  readonly resolution: Resolution;
  /** For a link with a heading: whether the heading exists in the page it points at. */
  readonly anchorOk: boolean | undefined;
}

export interface BrokenLink {
  readonly from: string;
  readonly line: number;
  readonly raw: string;
  readonly reason: 'missing page' | 'missing heading' | 'ambiguous title';
  /** Near matches for a missing page, closest first. */
  readonly suggestions: readonly string[];
}

export interface Backlink {
  readonly from: string;
  readonly line: number;
  /** The line the link sits on, trimmed and cut to 200 characters. */
  readonly context: string;
  readonly embed: boolean;
}

export interface Health {
  readonly pages: number;
  readonly links: number;
  readonly orphans: string[];
  readonly broken: BrokenLink[];
  readonly ambiguousTitles: { title: string; pages: string[] }[];
}

const distance = (a: string, b: string): number => {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
};

export class LinkGraph {
  readonly pages: ReadonlyMap<string, Page>;
  readonly #byKey = new Map<string, string[]>();
  readonly #links = new Map<string, ResolvedLink[]>();
  readonly #headings = new Map<string, Set<string>>();

  constructor(pages: readonly Page[]) {
    const m = new Map<string, Page>();
    for (const p of pages) {
      if (m.has(p.id)) throw new WikiLinkError(`two pages have the id ${p.id}`);
      m.set(p.id, p);
    }
    this.pages = m;
    for (const p of pages) {
      for (const t of new Set([titleKey(p.title), ...(p.aliases ?? []).map(titleKey)])) {
        const l = this.#byKey.get(t) ?? [];
        l.push(p.id);
        this.#byKey.set(t, l);
      }
      this.#headings.set(p.id, new Set(headingIds(parse(p.body, { gfm: true, maxLength: MAX_PAGE })).map((h) => h.id!)));
    }
    for (const p of pages) {
      this.#links.set(p.id, parseLinks(p.body).map((link) => {
        const resolution: Resolution = link.target === '' ? { status: 'ok', page: p.id } : this.resolve(link.target);
        let anchorOk: boolean | undefined;
        if (link.heading !== undefined && resolution.status === 'ok') anchorOk = this.#headings.get(resolution.page)!.has(slugify(link.heading));
        return { from: p.id, link, resolution, anchorOk };
      }));
    }
  }

  /** Which page a title (or alias) names. */
  resolve(title: string): Resolution {
    const ids = this.#byKey.get(titleKey(title));
    if (!ids || ids.length === 0) return { status: 'missing' };
    if (ids.length > 1) return { status: 'ambiguous', pages: [...ids] };
    return { status: 'ok', page: ids[0]! };
  }

  /** Links going out of a page. */
  outgoing(id: string): readonly ResolvedLink[] {
    return this.#links.get(id) ?? [];
  }

  /** Pages that link to this one, once per link, other pages first-come in page order; a page's links to itself are left out. */
  backlinks(id: string): Backlink[] {
    const out: Backlink[] = [];
    for (const [from, links] of this.#links) {
      if (from === id) continue;
      const lines = this.pages.get(from)!.body.split('\n');
      for (const r of links) {
        if (r.resolution.status === 'ok' && r.resolution.page === id) {
          out.push({ from, line: r.link.line, context: (lines[r.link.line - 1] ?? '').trim().slice(0, 200), embed: r.link.embed });
        }
      }
    }
    return out;
  }

  /** Pages nothing else links to. `except` names pages that are entry points on purpose, such as the home page. */
  orphans(except: readonly string[] = []): string[] {
    const linked = new Set<string>();
    for (const [from, links] of this.#links) for (const r of links) if (r.resolution.status === 'ok' && r.resolution.page !== from) linked.add(r.resolution.page);
    return [...this.pages.keys()].filter((id) => !linked.has(id) && !except.includes(id));
  }

  broken(): BrokenLink[] {
    const titles = [...this.pages.values()].map((p) => p.title);
    const out: BrokenLink[] = [];
    for (const [from, links] of this.#links) {
      for (const r of links) {
        const base = { from, line: r.link.line, raw: r.link.raw };
        if (r.resolution.status === 'missing') {
          const key = titleKey(r.link.target);
          const suggestions = titles
            .map((t) => [t, distance(key, titleKey(t))] as const)
            .filter(([, d]) => d <= 2)
            .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
            .map(([t]) => t);
          out.push({ ...base, reason: 'missing page', suggestions });
        } else if (r.resolution.status === 'ambiguous') out.push({ ...base, reason: 'ambiguous title', suggestions: [] });
        else if (r.anchorOk === false) out.push({ ...base, reason: 'missing heading', suggestions: [] });
      }
    }
    return out;
  }

  health(o: { entryPages?: readonly string[] } = {}): Health {
    const amb: { title: string; pages: string[] }[] = [];
    for (const [k, ids] of this.#byKey) if (ids.length > 1) amb.push({ title: k, pages: [...ids] });
    let n = 0;
    for (const l of this.#links.values()) n += l.length;
    return { pages: this.pages.size, links: n, orphans: this.orphans(o.entryPages ?? []), broken: this.broken(), ambiguousTitles: amb };
  }
}

export interface RenameEdit {
  readonly pageId: string;
  readonly body: string;
  /** How many links were rewritten in the page. */
  readonly rewritten: number;
}

export interface RenamePlan {
  /** The renamed page with its new title (and the old one kept as an alias when asked). */
  readonly page: Page;
  /** Other pages whose bodies change. */
  readonly edits: RenameEdit[];
  /** Links left alone because their target was ambiguous, with where they are. */
  readonly skipped: { pageId: string; line: number; raw: string }[];
}

export interface RenameOptions {
  /** Keep what readers see: `[[Old]]` becomes `[[New|Old]]`. Default true. Links with a label are never relabelled. */
  readonly keepDisplay?: boolean;
  /** Keep the old title as an alias so old external references still resolve. Default false. */
  readonly keepOldAsAlias?: boolean;
}

/**
 * Plan a rename: the page's new title and every body that must change. Nothing is applied; the caller saves the
 * edits together. Refuses a new title another page already uses.
 */
export function planRename(pages: readonly Page[], id: string, newTitle: string, o: RenameOptions = {}): RenamePlan {
  const title = newTitle.trim().replace(/\s+/g, ' ');
  if (title === '' || /[\[\]|#\n]/.test(title)) throw new WikiLinkError('a title cannot be empty or contain [ ] | # or a line break');
  if (title.length > MAX_LINK) throw new WikiLinkError(`a title over ${MAX_LINK} characters`);
  const target = pages.find((p) => p.id === id);
  if (!target) throw new WikiLinkError(`there is no page ${id}`);
  const clash = pages.find((p) => p.id !== id && [p.title, ...(p.aliases ?? [])].some((t) => titleKey(t) === titleKey(title)));
  if (clash) throw new WikiLinkError(`${JSON.stringify(title)} is already the title of page ${clash.id}`);
  const graph = new LinkGraph(pages);
  const keep = o.keepDisplay ?? true;
  const edits: RenameEdit[] = [];
  const skipped: RenamePlan['skipped'] = [];
  const oldKey = titleKey(target.title);
  for (const p of pages) {
    let body = p.body;
    let n = 0;
    const mine = [...graph.outgoing(p.id)].reverse();
    for (const r of mine) {
      if (r.resolution.status === 'ambiguous') {
        if (r.resolution.pages.includes(id)) skipped.push({ pageId: p.id, line: r.link.line, raw: r.link.raw });
        continue;
      }
      if (r.resolution.status !== 'ok' || r.resolution.page !== id) continue;
      if (r.link.target === '') continue;
      // a link through an alias still resolves after the rename, so only links that use the old title change
      if (titleKey(r.link.target) !== oldKey) continue;
      const label = r.link.label ?? (keep && r.link.target !== title ? r.link.target : undefined);
      const text = `${r.link.embed ? '!' : ''}[[${title}${r.link.heading !== undefined ? `#${r.link.heading}` : ''}${label !== undefined ? `|${label}` : ''}]]`;
      body = body.slice(0, r.link.start) + text + body.slice(r.link.end);
      n++;
    }
    if (n > 0) edits.push({ pageId: p.id, body, rewritten: n });
  }
  const aliases = o.keepOldAsAlias ? [...(target.aliases ?? []), target.title] : target.aliases;
  const page: Page = aliases ? { ...target, title, aliases } : { id: target.id, title, body: target.body };
  // links inside the renamed page that point at itself were edited above under its own id
  const selfEdit = edits.find((e) => e.pageId === id);
  return { page: selfEdit ? { ...page, body: selfEdit.body } : page, edits: edits.filter((e) => e.pageId !== id), skipped };
}

/** Apply a plan to a list of pages, returning the new list. */
export function applyRename(pages: readonly Page[], plan: RenamePlan): Page[] {
  const edits = new Map(plan.edits.map((e) => [e.pageId, e.body]));
  return pages.map((p) => (p.id === plan.page.id ? plan.page : edits.has(p.id) ? { ...p, body: edits.get(p.id)! } : p));
}
