/**
 * HTML for email clients, which read a small and uneven subset of the web. Takes an HTML body and gives back what is
 * safe and likely to render: a sanitiser with an allow-list of tags, attributes, URL schemes and style properties (no
 * scripts, forms, frames, event handlers or javascript: links, whatever the input says); a CSS inliner that applies
 * <style> rules to elements as style attributes with real specificity, source order and !important, and keeps the rules
 * that cannot be inlined (@media, :hover, @font-face) in one retained <style> block; link rewriting for click tracking
 * that leaves mailto:, tel:, anchors and links marked data-no-track alone; a plain-text alternative (headings, lists,
 * links as "text (url)", tables as rows, hidden preheader text skipped, wrapped at 78 columns); dark-mode hints (color-
 * scheme meta tags and a prefers-color-scheme block with the Outlook.com selector twin); and a report of what the
 * common clients will drop or break, from a compact built-in table of client support (it is a table, not a live
 * lookup: review it against caniemail.com now and then).
 *
 * The HTML reader is tolerant, not a browser: it builds a tree with implied end tags for the usual suspects (p, li, td,
 * tr), decodes the common named entities and every numeric one, and caps size, depth and node count. Out of scope:
 * rendering, CSS shorthand expansion, @import (dropped and reported), nth-child and other structural selectors beyond
 * :first-child and :last-child (kept in the retained block), and images' bytes.
 */

export class EmailHtmlError extends Error {
  constructor(why: string) {
    super(why);
  }
}

// ---------------------------------------------------------------- HTML tree

export interface El {
  readonly kind: 'el';
  readonly tag: string;
  attrs: Map<string, string>;
  children: Node[];
  parent: El | undefined;
}
export interface Text {
  readonly kind: 'text';
  text: string;
  parent: El | undefined;
}
export interface Comment {
  readonly kind: 'comment';
  text: string;
  parent: El | undefined;
}
export type Node = El | Text | Comment;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);
const LIMITS = { bytes: 2 * 1024 * 1024, depth: 200, nodes: 200_000, rules: 20_000 };

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', mdash: '—', ndash: '–', hellip: '…', euro: '€', pound: '£', yen: '¥', cent: '¢', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', deg: '°', times: '×', divide: '÷', eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', ntilde: 'ñ', ccedil: 'ç', zwnj: '‌', shy: '­' };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�';
    }
    return NAMED[e] ?? m;
  });
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => esc(s).replace(/"/g, '&quot;');

const AUTO_CLOSE: Record<string, readonly string[]> = {
  p: ['p'], li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], tr: ['tr', 'td', 'th'], td: ['td', 'th'], th: ['td', 'th'], option: ['option'], thead: ['tbody', 'tfoot'], tbody: ['thead', 'tbody', 'tfoot'],
};
const BLOCKS_CLOSE_P = new Set(['div', 'table', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'hr', 'form', 'section', 'p']);

/** Reads HTML into a tree. Never throws on malformed markup; throws EmailHtmlError on input that is too large. */
export function parseHtml(html: string): El {
  if (html.length > LIMITS.bytes) throw new EmailHtmlError(`HTML over ${LIMITS.bytes} characters`);
  const root: El = { kind: 'el', tag: '#root', attrs: new Map(), children: [], parent: undefined };
  let cur = root;
  let depth = 0;
  let nodes = 0;
  const add = <T extends Node>(n: T): T => {
    if (++nodes > LIMITS.nodes) throw new EmailHtmlError('too many nodes');
    n.parent = cur;
    cur.children.push(n);
    return n;
  };
  const text = (s: string) => {
    if (!s) return;
    const last = cur.children.at(-1);
    if (last?.kind === 'text') last.text += s;
    else add({ kind: 'text', text: s, parent: cur });
  };
  const closeTo = (tag: string): boolean => {
    for (let e: El | undefined = cur; e && e !== root; e = e.parent) {
      if (e.tag === tag) {
        cur = e.parent ?? root;
        depth = Math.max(0, depth - 1);
        // depth counts open elements; recompute cheaply
        depth = 0;
        for (let x: El | undefined = cur; x && x !== root; x = x.parent) depth++;
        return true;
      }
    }
    return false;
  };
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      text(decodeEntities(html.slice(i)));
      break;
    }
    if (lt > i) text(decodeEntities(html.slice(i, lt)));
    i = lt;
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      const body = html.slice(i + 4, end < 0 ? n : end);
      add({ kind: 'comment', text: body, parent: cur });
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[i + 1] === '!' || html[i + 1] === '?') {
      const end = html.indexOf('>', i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const close = /^<\/([A-Za-z][A-Za-z0-9:-]*)\s*>/.exec(html.slice(i, i + 80));
    if (close) {
      closeTo(close[1]!.toLowerCase());
      i += close[0].length;
      continue;
    }
    const open = /^<([A-Za-z][A-Za-z0-9:-]*)/.exec(html.slice(i, i + 80));
    if (!open) {
      text('<');
      i++;
      continue;
    }
    const tag = open[1]!.toLowerCase();
    let j = i + open[0].length;
    const attrs = new Map<string, string>();
    let selfClose = false;
    // attributes
    for (;;) {
      while (j < n && /\s/.test(html[j]!)) j++;
      if (j >= n) break;
      if (html[j] === '>') {
        j++;
        break;
      }
      if (html[j] === '/' && html[j + 1] === '>') {
        selfClose = true;
        j += 2;
        break;
      }
      if (html[j] === '/') {
        j++;
        continue;
      }
      const m = /^([^\s"'<>/=]+)/.exec(html.slice(j, j + 200));
      if (!m) {
        j++;
        continue;
      }
      j += m[0].length;
      const name = m[1]!.toLowerCase();
      while (j < n && /\s/.test(html[j]!)) j++;
      let val = '';
      if (html[j] === '=') {
        j++;
        while (j < n && /\s/.test(html[j]!)) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const end = html.indexOf(q, j + 1);
          val = html.slice(j + 1, end < 0 ? n : end);
          j = end < 0 ? n : end + 1;
        } else {
          const um = /^[^\s>]*/.exec(html.slice(j, j + 4000))!;
          val = um[0];
          j += um[0].length;
        }
      }
      if (!attrs.has(name)) attrs.set(name, decodeEntities(val));
    }
    i = j;
    // implied end tags
    const closes = AUTO_CLOSE[tag];
    if (closes) {
      for (let e: El | undefined = cur; e && e !== root; e = e.parent) {
        if (['table', 'ul', 'ol', 'div', 'body'].includes(e.tag)) break;
        if (closes.includes(e.tag)) {
          closeTo(e.tag);
          break;
        }
      }
    }
    if (BLOCKS_CLOSE_P.has(tag) && cur.tag === 'p') closeTo('p');
    if (depth >= LIMITS.depth) throw new EmailHtmlError('nested too deeply');
    const el = add<El>({ kind: 'el', tag, attrs, children: [], parent: cur });
    if (RAW.has(tag) && !selfClose) {
      const m = new RegExp(`</${tag}\\s*>`, 'i').exec(html.slice(i));
      const body = m ? html.slice(i, i + m.index) : html.slice(i);
      if (body) el.children.push({ kind: 'text', text: body, parent: el });
      i = m ? i + m.index + m[0].length : n;
      continue;
    }
    if (!VOID.has(tag) && !selfClose) {
      cur = el;
      depth++;
    }
  }
  return root;
}

export function serialize(n: Node): string {
  if (n.kind === 'text') return n.parent && RAW.has(n.parent.tag) ? n.text : esc(n.text);
  if (n.kind === 'comment') return `<!--${n.text}-->`;
  if (n.tag === '#root') return n.children.map(serialize).join('');
  const attrs = [...n.attrs].map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
  if (VOID.has(n.tag)) return `<${n.tag}${attrs}>`;
  return `<${n.tag}${attrs}>${n.children.map(serialize).join('')}</${n.tag}>`;
}

function* walk(n: El): Generator<El> {
  yield n;
  for (const c of n.children) if (c.kind === 'el') yield* walk(c);
}

const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.kind === 'el' ? n.children.map(textOf).join('') : '');

// ---------------------------------------------------------------- CSS

export interface Decl {
  readonly prop: string;
  readonly value: string;
  readonly important: boolean;
}
export interface Rule {
  readonly selector: string;
  readonly decls: readonly Decl[];
  readonly order: number;
}
export interface Stylesheet {
  readonly rules: readonly Rule[];
  /** At-rules that cannot be inlined, as written (media queries, font faces, keyframes). */
  readonly kept: readonly string[];
  readonly dropped: readonly string[];
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Splits on a separator outside quotes and parentheses. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let q = '';
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      cur += c;
      if (c === '\\') cur += s[++i] ?? '';
      else if (c === q) q = '';
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === '(') {
      depth++;
      cur += c;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
      cur += c;
    } else if (c === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export function parseDeclarations(body: string): Decl[] {
  const out: Decl[] = [];
  for (const d of splitTop(stripComments(body), ';')) {
    const i = d.indexOf(':');
    if (i < 1) continue;
    const prop = d.slice(0, i).trim().toLowerCase();
    let value = d.slice(i + 1).trim();
    const important = /\s*!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/\s*!\s*important\s*$/i, '');
    if (prop && value && /^[a-z-]+$|^--[\w-]+$/.test(prop)) out.push({ prop, value, important });
  }
  return out;
}

/** Reads a stylesheet into style rules and the at-rules kept as written. */
export function parseCss(css: string): Stylesheet {
  const src = stripComments(css);
  const rules: Rule[] = [];
  const kept: string[] = [];
  const dropped: string[] = [];
  let order = 0;
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (i >= src.length) break;
    if (src[i] === '@') {
      const semi = src.indexOf(';', i);
      const brace = src.indexOf('{', i);
      if (brace < 0 || (semi >= 0 && semi < brace)) {
        const stmt = src.slice(i, semi < 0 ? src.length : semi + 1);
        if (/^@import/i.test(stmt)) dropped.push(stmt.trim());
        else kept.push(stmt.trim());
        i = semi < 0 ? src.length : semi + 1;
        continue;
      }
      const end = matchBrace(src, brace);
      const block = src.slice(i, end + 1).trim();
      kept.push(block);
      i = end + 1;
      continue;
    }
    const brace = src.indexOf('{', i);
    if (brace < 0) break;
    const end = matchBrace(src, brace);
    const selector = src.slice(i, brace).trim();
    const decls = parseDeclarations(src.slice(brace + 1, end));
    for (const s of splitTop(selector, ',')) if (s.trim() && decls.length) rules.push({ selector: s.trim(), decls, order: order++ });
    if (rules.length > LIMITS.rules) throw new EmailHtmlError('too many CSS rules');
    i = end + 1;
  }
  return { rules, kept, dropped };
}

function matchBrace(s: string, open: number): number {
  let depth = 0;
  let q = '';
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = '';
    } else if (c === '"' || c === "'") q = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return s.length - 1;
}

// ---------------------------------------------------------------- selectors

interface Simple {
  readonly tag: string | undefined;
  readonly id: string | undefined;
  readonly classes: readonly string[];
  readonly attrs: readonly { name: string; op: string; value: string }[];
  readonly pseudos: readonly string[];
}
interface Compound {
  readonly comb: ' ' | '>' | '+' | '~' | '';
  readonly sel: Simple;
}

const INLINABLE_PSEUDO = new Set(['first-child', 'last-child']);

/** Reads a selector; returns undefined for one that cannot be applied by inlining (pseudo-elements, :hover and the like). */
export function parseSelector(sel: string): Compound[] | undefined {
  const s = sel.trim();
  if (!s || /::|:(hover|focus|active|visited|link|before|after|checked|disabled|target|nth-|not|is|where|has)/i.test(s) && !/^[^:]*(:(first|last)-child)?[^:]*$/.test(s)) {
    if (!s || /::|:(hover|focus|active|visited|link|before|after|checked|disabled|target|nth-|not|is|where|has)/i.test(s)) return undefined;
  }
  const out: Compound[] = [];
  const re = /\s*([>+~])\s*|\s+/y;
  let i = 0;
  let comb: Compound['comb'] = '';
  while (i < s.length) {
    const m = /^(\*|[A-Za-z][\w-]*)?((?:#[\w-]+|\.[\w-]+|\[[^\]]+\]|:[\w-]+)*)/.exec(s.slice(i));
    if (!m || !m[0]) return undefined;
    i += m[0].length;
    let id: string | undefined;
    const classes: string[] = [];
    const attrs: Simple['attrs'][number][] = [];
    const pseudos: string[] = [];
    for (const part of m[2]!.match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) ?? []) {
      if (part[0] === '#') id = part.slice(1);
      else if (part[0] === '.') classes.push(part.slice(1));
      else if (part[0] === '[') {
        const a = /^\[\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*))\s*)?\]$/.exec(part);
        if (!a) return undefined;
        attrs.push({ name: a[1]!.toLowerCase(), op: a[2] ?? '', value: a[3] ?? a[4] ?? a[5] ?? '' });
      } else {
        const p = part.slice(1).toLowerCase();
        if (!INLINABLE_PSEUDO.has(p)) return undefined;
        pseudos.push(p);
      }
    }
    out.push({ comb, sel: { tag: m[1] && m[1] !== '*' ? m[1].toLowerCase() : undefined, id, classes, attrs, pseudos } });
    re.lastIndex = i;
    const c = re.exec(s);
    if (c && c.index === i) {
      comb = c[1] ? (c[1] as Compound['comb']) : ' ';
      i += c[0].length;
      if (i >= s.length) return undefined;
    } else if (i < s.length) return undefined;
  }
  return out;
}

export const specificity = (c: readonly Compound[]): [number, number, number] => {
  let a = 0;
  let b = 0;
  let d = 0;
  for (const { sel } of c) {
    if (sel.id) a++;
    b += sel.classes.length + sel.attrs.length + sel.pseudos.length;
    if (sel.tag) d++;
  }
  return [a, b, d];
};

function simpleMatches(e: El, s: Simple): boolean {
  if (s.tag && e.tag !== s.tag) return false;
  if (s.id && e.attrs.get('id') !== s.id) return false;
  if (s.classes.length) {
    const cl = (e.attrs.get('class') ?? '').split(/\s+/);
    if (!s.classes.every((c) => cl.includes(c))) return false;
  }
  for (const a of s.attrs) {
    const v = e.attrs.get(a.name);
    if (v === undefined) return false;
    if (a.op === '=' && v !== a.value) return false;
    if (a.op === '~=' && !v.split(/\s+/).includes(a.value)) return false;
    if (a.op === '^=' && !v.startsWith(a.value)) return false;
    if (a.op === '$=' && !v.endsWith(a.value)) return false;
    if (a.op === '*=' && !v.includes(a.value)) return false;
    if (a.op === '|=' && v !== a.value && !v.startsWith(`${a.value}-`)) return false;
  }
  for (const p of s.pseudos) {
    const sibs = e.parent?.children.filter((c): c is El => c.kind === 'el') ?? [];
    if (p === 'first-child' && sibs[0] !== e) return false;
    if (p === 'last-child' && sibs.at(-1) !== e) return false;
  }
  return true;
}

function matches(e: El, chain: readonly Compound[], at = chain.length - 1): boolean {
  const c = chain[at]!;
  if (!simpleMatches(e, c.sel)) return false;
  if (at === 0) return true;
  switch (c.comb) {
    case '>':
      return !!e.parent && e.parent.tag !== '#root' && matches(e.parent, chain, at - 1);
    case ' ':
      for (let p = e.parent; p && p.tag !== '#root'; p = p.parent) if (matches(p, chain, at - 1)) return true;
      return false;
    case '+': {
      const sibs = e.parent?.children.filter((x): x is El => x.kind === 'el') ?? [];
      const prev = sibs[sibs.indexOf(e) - 1];
      return !!prev && matches(prev, chain, at - 1);
    }
    case '~': {
      const sibs = e.parent?.children.filter((x): x is El => x.kind === 'el') ?? [];
      return sibs.slice(0, sibs.indexOf(e)).some((p) => matches(p, chain, at - 1));
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------- inlining

export interface InlineResult {
  readonly html: string;
  /** Rules that stay in a <style> block because an attribute cannot express them. */
  readonly retainedCss: string;
  readonly warnings: readonly string[];
}

const styleOf = (e: El): Decl[] => parseDeclarations(e.attrs.get('style') ?? '');
const fmt = (ds: readonly Decl[]) => ds.map((d) => `${d.prop}: ${d.value}${d.important ? ' !important' : ''}`).join('; ');

/**
 * Applies <style> rules (and `extraCss`) to the elements they match, as style attributes. Precedence follows CSS:
 * important beats not, then specificity, then later source order; the element's own style attribute beats every
 * non-important rule. The <style> elements are removed; what cannot be inlined is returned and, unless `keep` is false,
 * put back in one <style> block in the head.
 */
export function inlineCss(html: string, o: { extraCss?: string; keep?: boolean; removeClasses?: boolean } = {}): InlineResult {
  const root = parseHtml(html);
  const warnings: string[] = [];
  let css = o.extraCss ?? '';
  const styles: El[] = [];
  for (const e of walk(root)) if (e.tag === 'style') styles.push(e);
  for (const s of styles) {
    css += `\n${textOf(s)}`;
  }
  const sheet = parseCss(css);
  for (const d of sheet.dropped) warnings.push(`${d} was dropped: email clients do not fetch stylesheets`);
  const retained: string[] = [...sheet.kept];
  const applicable: { chain: Compound[]; spec: [number, number, number]; rule: Rule }[] = [];
  for (const r of sheet.rules) {
    const chain = parseSelector(r.selector);
    if (!chain) {
      retained.push(`${r.selector} { ${fmt(r.decls)} }`);
      continue;
    }
    applicable.push({ chain, spec: specificity(chain), rule: r });
  }
  for (const e of walk(root)) {
    if (['style', 'script', 'head', 'title', 'meta', 'link', '#root', 'html'].includes(e.tag)) continue;
    const found = applicable.filter((a) => matches(e, a.chain));
    const own = styleOf(e);
    if (!found.length && !own.length) continue;
    const winners = new Map<string, { d: Decl; key: number[] }>();
    const offer = (d: Decl, key: number[]) => {
      const cur = winners.get(d.prop);
      if (!cur || cmp(key, cur.key) >= 0) winners.set(d.prop, { d, key });
    };
    for (const f of found) for (const d of f.rule.decls) offer(d, [d.important ? 1 : 0, 0, ...f.spec, f.rule.order]);
    // the inline style attribute: above every non-important rule, below important ones from the sheet
    own.forEach((d, i) => offer(d, [d.important ? 1 : 0, 1, 0, 0, 0, 1_000_000 + i]));
    e.attrs.set('style', fmt([...winners.values()].map((w) => w.d)));
    if (o.removeClasses) e.attrs.delete('class');
  }
  for (const s of styles) {
    const parent = s.parent;
    if (parent) parent.children = parent.children.filter((c) => c !== s);
  }
  const retainedCss = retained.join('\n');
  let out = serialize(root);
  if (retainedCss && o.keep !== false) out = placeInHead(out, `<style>${retainedCss}</style>`);
  return { html: out, retainedCss, warnings };
}

const cmp = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
};

function placeInHead(html: string, snippet: string): string {
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${snippet}</head>`);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${snippet}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${snippet}</head>`);
  return `${snippet}${html}`;
}

// ---------------------------------------------------------------- sanitising

const TAGS = new Set('a abbr b blockquote body br caption center code col colgroup dd div dl dt em font h1 h2 h3 h4 h5 h6 head hr html i img li meta ol p pre s small span strike strong style sub sup table tbody td tfoot th thead title tr u ul'.split(' '));
const DROP_WITH_CONTENT = new Set(['script', 'iframe', 'object', 'embed', 'applet', 'noscript', 'template', 'frame', 'frameset', 'svg', 'math', 'audio', 'video', 'canvas', 'form', 'select', 'textarea', 'button', 'head-script']);
const ATTRS: Record<string, readonly string[]> = {
  '*': ['style', 'class', 'id', 'title', 'lang', 'dir', 'align', 'valign', 'bgcolor', 'width', 'height', 'role', 'aria-label', 'aria-hidden', 'data-no-track'],
  a: ['href', 'target', 'name', 'rel'],
  img: ['src', 'alt', 'width', 'height', 'border'],
  table: ['border', 'cellpadding', 'cellspacing', 'background'],
  td: ['colspan', 'rowspan', 'background', 'nowrap'],
  th: ['colspan', 'rowspan', 'nowrap'],
  col: ['span'],
  colgroup: ['span'],
  font: ['color', 'face', 'size'],
  ol: ['start', 'type'],
  meta: ['name', 'content', 'charset', 'http-equiv'],
};
const SAFE_PROPS = new Set('azimuth background background-color background-image background-position background-repeat background-size border border-bottom border-collapse border-color border-left border-radius border-right border-spacing border-style border-top border-width box-sizing clear color direction display float font font-family font-size font-style font-variant font-weight height letter-spacing line-height list-style list-style-type margin margin-bottom margin-left margin-right margin-top max-height max-width min-height min-width mso-hide mso-line-height-rule mso-table-lspace mso-table-rspace opacity outline overflow padding padding-bottom padding-left padding-right padding-top table-layout text-align text-decoration text-indent text-overflow text-shadow text-transform vertical-align visibility white-space width word-break word-spacing word-wrap -webkit-text-size-adjust -ms-text-size-adjust'.split(' '));

/** Whether a URL may appear in an email: http(s), mailto, tel, an anchor or a cid: reference. Control characters are ignored first. */
export function safeUrl(u: string, o: { allowDataImage?: boolean; image?: boolean } = {}): boolean {
  // Browsers drop tabs, newlines and other control characters inside a scheme, so "java\tscript:" is javascript.
  const v = u.replace(new RegExp('[\\u0000-\\u0020\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\ufeff]', 'g'), '').toLowerCase();
  if (!v) return false;
  if (v.startsWith('#') || v.startsWith('/') || v.startsWith('?')) return !v.startsWith('//') || false;
  const m = /^([a-z][a-z0-9+.-]*):/.exec(v);
  if (!m) return true;
  if (['http', 'https', 'mailto', 'tel'].includes(m[1]!)) return true;
  if (m[1] === 'cid') return !!o.image || true;
  if (m[1] === 'data') return !!o.allowDataImage && !!o.image && /^data:image\/(png|gif|jpe?g|webp);base64,[a-z0-9+/=]+$/.test(v);
  return false;
}

function cleanStyle(value: string): string {
  const ok: Decl[] = [];
  for (const d of parseDeclarations(value)) {
    if (!SAFE_PROPS.has(d.prop)) continue;
    const v = d.value;
    // old script-in-CSS routes, and any url() that is not a plain http(s) or cid address
    if (/expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|@import/i.test(v)) continue;
    if (/url\s*\(/i.test(v) && ![...v.matchAll(/url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)].every((m) => /^(https?:|cid:)/i.test((m[1] ?? m[2] ?? m[3] ?? '').trim()))) continue;
    if (/\\[0-9a-f]{1,6}/i.test(v) && /(expression|javascript|url)/i.test(v.replace(/\\[0-9a-f]{1,6}\s?/gi, ''))) continue;
    ok.push(d);
  }
  return fmt(ok);
}

export interface SanitizeOptions {
  /** Let small base64 images in src (they are large, and some clients block them). */
  readonly allowDataImages?: boolean;
  readonly extraTags?: readonly string[];
}

/** Reduces HTML to what an email may carry. Everything not allowed is removed; nothing in the input can add to the list. */
export function sanitize(html: string, o: SanitizeOptions = {}): string {
  const root = parseHtml(html);
  const allowed = new Set([...TAGS, ...(o.extraTags ?? [])]);
  const clean = (e: El): void => {
    const out: Node[] = [];
    for (const c of e.children) {
      if (c.kind === 'comment') {
        // Conditional comments are how Outlook gets its own markup; they are kept only when they carry no active content.
        if (/^\[if [^\]]*\]>/.test(c.text) && !/<\s*(script|iframe|object|embed|form|link)\b|\bon[a-z]+\s*=|javascript:/i.test(c.text)) out.push(c);
        continue;
      }
      if (c.kind === 'text') {
        out.push(c);
        continue;
      }
      if (DROP_WITH_CONTENT.has(c.tag) || c.tag === 'link' || c.tag === 'base') continue;
      if (c.tag === 'style') {
        const css = parseCss(textOf(c));
        const keep = css.rules.map((r) => `${r.selector} { ${cleanStyle(fmt(r.decls))} }`).filter((r) => !/\{\s*\}$/.test(r));
        const text = [...keep, ...css.kept.filter((k) => /^@media|^@font-face/i.test(k) && !/expression|javascript:|@import|url\s*\(\s*['"]?(?!https?:|cid:)/i.test(k))].join('\n');
        c.children = text ? [{ kind: 'text', text, parent: c }] : [];
        if (text) out.push(c);
        continue;
      }
      clean(c);
      if (!allowed.has(c.tag)) {
        // An unknown element is unwrapped: its text and allowed children stay.
        for (const g of c.children) {
          g.parent = e;
          out.push(g);
        }
        continue;
      }
      const ok = new Set([...(ATTRS['*'] ?? []), ...(ATTRS[c.tag] ?? [])]);
      for (const [k, v] of [...c.attrs]) {
        if (k.startsWith('on') || !ok.has(k)) {
          c.attrs.delete(k);
          continue;
        }
        if (k === 'href' && !safeUrl(v)) c.attrs.delete(k);
        else if ((k === 'src' || k === 'background') && !safeUrl(v, { image: true, allowDataImage: !!o.allowDataImages })) c.attrs.delete(k);
        else if (k === 'style') {
          const s = cleanStyle(v);
          if (s) c.attrs.set('style', s);
          else c.attrs.delete('style');
        } else if (k === 'target') c.attrs.set('target', '_blank');
      }
      if (c.tag === 'a' && c.attrs.get('target') === '_blank') c.attrs.set('rel', 'noopener noreferrer');
      if (c.tag === 'meta' && !['viewport', 'color-scheme', 'supported-color-schemes', 'x-apple-disable-message-reformatting', 'format-detection'].includes((c.attrs.get('name') ?? '').toLowerCase()) && !c.attrs.has('charset') && (c.attrs.get('http-equiv') ?? '').toLowerCase() !== 'content-type') continue;
      out.push(c);
    }
    e.children = out;
  };
  clean(root);
  return serialize(root);
}

// ---------------------------------------------------------------- links

export interface LinkContext {
  readonly text: string;
}

/**
 * Rewrites the href of each link through `fn` (to a click-tracking address, say). mailto:, tel:, anchors and links
 * marked data-no-track are not passed to `fn`; a link whose visible text is itself an address is passed too, and it is
 * for `fn` to decide whether rewriting it would show a different address from the one on screen.
 */
export function rewriteLinks(html: string, fn: (url: string, ctx: LinkContext) => string | undefined): string {
  const root = parseHtml(html);
  for (const e of walk(root)) {
    if (e.tag !== 'a') continue;
    const href = e.attrs.get('href');
    if (href === undefined || e.attrs.has('data-no-track')) continue;
    if (!/^https?:/i.test(href.trim())) continue;
    const next = fn(href.trim(), { text: textOf(e).replace(/\s+/g, ' ').trim() });
    if (next !== undefined) {
      if (!safeUrl(next)) throw new EmailHtmlError(`the rewritten link ${JSON.stringify(next.slice(0, 40))} is not a safe address`);
      e.attrs.set('href', next);
    }
  }
  return serialize(root);
}

/** Links whose visible text shows one web address while the href goes to another host: a pattern phishing uses. */
export function misleadingLinks(html: string): { text: string; href: string }[] {
  const root = parseHtml(html);
  const out: { text: string; href: string }[] = [];
  for (const e of walk(root)) {
    if (e.tag !== 'a') continue;
    const href = e.attrs.get('href') ?? '';
    const t = textOf(e).trim();
    const shown = /^(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:[/:?#]|$)/i.exec(t);
    if (!shown || !/^https?:/i.test(href)) continue;
    let host: string;
    try {
      host = new URL(href).hostname.toLowerCase();
    } catch {
      continue;
    }
    const s = shown[1]!.toLowerCase();
    if (host !== s && !host.endsWith(`.${s}`) && !s.endsWith(`.${host}`)) out.push({ text: t, href });
  }
  return out;
}

// ---------------------------------------------------------------- plain text

const isHidden = (e: El): boolean => {
  const st = e.attrs.get('style') ?? '';
  return e.attrs.has('hidden') || /display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all|font-size\s*:\s*0(px)?\s*(;|$)|max-height\s*:\s*0/i.test(st) || e.attrs.get('aria-hidden') === 'true' && /opacity\s*:\s*0/.test(st);
};

export function wrapText(s: string, width = 78): string {
  return s
    .split('\n')
    .map((line) => {
      if (line.length <= width || /^\s*(\||-{3,}|={3,})/.test(line)) return line;
      const indent = /^(\s*(?:[-*]|\d+\.)\s+)/.exec(line)?.[1] ?? '';
      const pad = ' '.repeat(indent.length);
      const out: string[] = [];
      let cur = '';
      for (const w of line.slice(indent.length).split(' ')) {
        const first = out.length === 0;
        const prefix = first ? indent : pad;
        if (cur && (prefix + cur + ' ' + w).length > width) {
          out.push(prefix + cur);
          cur = w;
        } else cur = cur ? `${cur} ${w}` : w;
      }
      out.push((out.length === 0 ? indent : pad) + cur);
      return out.join('\n');
    })
    .join('\n');
}

/** The plain-text alternative for an HTML email. */
export function toText(html: string, o: { width?: number } = {}): string {
  const root = parseHtml(html);
  const blocks = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'blockquote', 'pre', 'hr', 'section']);
  let out = '';
  const nl = (n: number) => {
    const have = /\n*$/.exec(out)![0].length;
    if (out && have < n) out += '\n'.repeat(n - have);
  };
  const inline = (e: El): string => {
    let s = '';
    for (const c of e.children) {
      if (c.kind === 'text') s += c.text.replace(/\s+/g, ' ');
      else if (c.kind === 'el' && !isHidden(c) && !['script', 'style', 'head', 'title'].includes(c.tag)) {
        if (c.tag === 'br') s += '\n';
        else if (c.tag === 'img') s += c.attrs.get('alt') ? c.attrs.get('alt')! : '';
        else if (c.tag === 'a') {
          const t = inline(c).trim();
          const href = (c.attrs.get('href') ?? '').trim();
          s += !href || href.startsWith('#') || t === href || t === href.replace(/^mailto:/, '') ? t || href : t ? `${t} (${href.replace(/^mailto:/, 'mailto:')})` : href;
        } else s += inline(c);
      }
    }
    return s;
  };
  const visit = (e: El, listCtx?: { ordered: boolean; n: number }): void => {
    for (const c of e.children) {
      if (c.kind === 'text') {
        const t = c.text.replace(/\s+/g, ' ');
        if (t.trim()) out += out.endsWith('\n') || !out ? t.trimStart() : t;
        continue;
      }
      if (c.kind !== 'el' || isHidden(c) || ['script', 'style', 'head', 'title'].includes(c.tag)) continue;
      switch (c.tag) {
        case 'br':
          out += '\n';
          break;
        case 'hr':
          nl(2);
          out += '-'.repeat(40);
          nl(2);
          break;
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6': {
          nl(2);
          const t = inline(c).trim();
          out += c.tag === 'h1' ? t.toUpperCase() : t;
          if (c.tag === 'h1' || c.tag === 'h2') out += `\n${(c.tag === 'h1' ? '=' : '-').repeat(Math.min(t.length, 78))}`;
          nl(2);
          break;
        }
        case 'ul':
        case 'ol': {
          nl(listCtx ? 1 : 2);
          const ctx = { ordered: c.tag === 'ol', n: Number(c.attrs.get('start') ?? 1) };
          visit(c, ctx);
          nl(listCtx ? 1 : 2);
          break;
        }
        case 'li': {
          nl(1);
          const bullet = listCtx?.ordered ? `${listCtx.n++}. ` : '- ';
          const before = out.length;
          out += bullet;
          const sub = c.children.some((x) => x.kind === 'el' && (x.tag === 'ul' || x.tag === 'ol'));
          if (sub) {
            const own = { ...c, children: c.children.filter((x) => !(x.kind === 'el' && (x.tag === 'ul' || x.tag === 'ol'))) } as El;
            out += inline(own).trim();
            for (const x of c.children) if (x.kind === 'el' && (x.tag === 'ul' || x.tag === 'ol')) {
              const saved = out;
              out = '';
              visit({ ...c, children: [x] } as El, { ordered: false, n: 1 });
              out = saved + out.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n');
            }
          } else out += inline(c).trim();
          void before;
          nl(1);
          break;
        }
        case 'table': {
          nl(2);
          const rows: string[][] = [];
          const collect = (n: El) => {
            for (const r of n.children) if (r.kind === 'el') {
              if (r.tag === 'tr') {
                const cells = r.children.filter((x): x is El => x.kind === 'el' && (x.tag === 'td' || x.tag === 'th') && !isHidden(x));
                rows.push(cells.map((x) => (x.children.some((y) => y.kind === 'el' && ['table', 'ul', 'ol', 'p', 'div'].includes(y.tag)) ? toText(serialize(x), o).trim().replace(/\n+/g, ' ') : inline(x).trim().replace(/\s+/g, ' '))).filter((t) => t));
              } else if (['thead', 'tbody', 'tfoot'].includes(r.tag)) collect(r);
            }
          };
          collect(c);
          const nonEmpty = rows.filter((r) => r.length);
          // A layout table has one cell per row: its cells read as paragraphs. A data table keeps its columns.
          if (nonEmpty.every((r) => r.length === 1)) out += nonEmpty.map((r) => r[0]).join('\n\n');
          else out += nonEmpty.map((r) => r.join(' | ')).join('\n');
          nl(2);
          break;
        }
        case 'blockquote': {
          nl(2);
          const saved = out;
          out = '';
          visit(c);
          out = saved + out.trim().split('\n').map((l) => `> ${l}`).join('\n');
          nl(2);
          break;
        }
        case 'pre':
          nl(2);
          out += textOf(c).replace(/\n$/, '');
          nl(2);
          break;
        case 'img':
          if (c.attrs.get('alt')) out += `[${c.attrs.get('alt')}]`;
          break;
        case 'a': {
          const t = inline(c).trim();
          const href = (c.attrs.get('href') ?? '').trim();
          out += !href || href.startsWith('#') || t === href || t === href.replace(/^mailto:/, '') ? t || href : t ? `${t} (${href})` : href;
          break;
        }
        default:
          if (blocks.has(c.tag)) {
            nl(2);
            if (c.tag === 'p' || c.tag === 'div' || c.tag === 'section') {
              const hasBlock = c.children.some((x) => x.kind === 'el' && (blocks.has(x.tag) || x.tag === 'table' || x.tag === 'li'));
              if (hasBlock) visit(c, listCtx);
              else out += inline(c).trim();
            } else visit(c, listCtx);
            nl(2);
          } else visit(c, listCtx);
      }
    }
  };
  visit(root);
  const text = out.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').replace(/ /g, ' ').trim();
  return `${wrapText(text, o.width ?? 78)}\n`;
}

// ---------------------------------------------------------------- dark mode

/**
 * Adds what lets a client switch to a dark scheme: the color-scheme meta tags, a root declaration, and a
 * prefers-color-scheme block built from `dark` (selector to declarations), repeated for Outlook.com's [data-ogsc] and
 * [data-ogsb] selectors. Declarations are marked !important, since the inlined light styles would otherwise win.
 */
export function darkModeHints(html: string, dark: Readonly<Record<string, string>>): string {
  const root = parseHtml(html);
  let head: El | undefined;
  for (const e of walk(root)) if (e.tag === 'head') head = e;
  const metas = '<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">';
  const rules: string[] = [];
  const outlook: string[] = [];
  for (const [sel, body] of Object.entries(dark)) {
    if (!parseSelector(sel) && !/^[\w.#\s>,:[\]="-]+$/.test(sel)) throw new EmailHtmlError(`${JSON.stringify(sel)} is not a selector`);
    const decls = parseDeclarations(body).filter((d) => SAFE_PROPS.has(d.prop)).map((d) => ({ ...d, important: true }));
    if (!decls.length) continue;
    rules.push(`${sel} { ${fmt(decls)} }`);
    const bgOnly = decls.filter((d) => d.prop.startsWith('background'));
    const fgOnly = decls.filter((d) => !d.prop.startsWith('background'));
    if (fgOnly.length) outlook.push(`[data-ogsc] ${sel} { ${fmt(fgOnly)} }`);
    if (bgOnly.length) outlook.push(`[data-ogsb] ${sel} { ${fmt(bgOnly)} }`);
  }
  const css = `:root { color-scheme: light dark; supported-color-schemes: light dark; }${rules.length ? `\n@media (prefers-color-scheme: dark) { ${rules.join(' ')} }` : ''}${outlook.length ? `\n${outlook.join('\n')}` : ''}`;
  const snippet = `${metas}<style>${css}</style>`;
  if (head) return placeInHead(serialize(root), snippet);
  return placeInHead(serialize(root), snippet);
}

// ---------------------------------------------------------------- support report

export type Client = 'gmail' | 'outlook-windows' | 'outlook.com' | 'apple-mail' | 'yahoo' | 'samsung';
export interface Finding {
  readonly severity: 'error' | 'warning' | 'info';
  readonly feature: string;
  readonly clients: readonly Client[];
  readonly advice: string;
  readonly count: number;
}

interface Check {
  readonly feature: string;
  readonly severity: Finding['severity'];
  readonly clients: readonly Client[];
  readonly advice: string;
  readonly test: (ctx: { root: El; html: string; css: string; inlineStyles: string[] }) => number;
}

const cssHas = (re: RegExp) => (c: { css: string; inlineStyles: string[] }) => (c.css.match(new RegExp(re.source, `${re.flags.replace('g', '')}g`)) ?? []).length + c.inlineStyles.reduce((n, s) => n + (s.match(new RegExp(re.source, `${re.flags.replace('g', '')}g`)) ?? []).length, 0);
const tagCount = (...tags: string[]) => (c: { root: El }) => [...walk(c.root)].filter((e) => tags.includes(e.tag)).length;

const CHECKS: readonly Check[] = [
  { feature: 'display: flex / grid', severity: 'error', clients: ['outlook-windows'], advice: 'Use nested tables for layout: Outlook for Windows renders with Word and ignores flexbox and grid.', test: cssHas(/display\s*:\s*(inline-)?(flex|grid)/i) },
  { feature: 'position: absolute / fixed', severity: 'error', clients: ['gmail', 'outlook-windows', 'yahoo'], advice: 'Positioning is stripped by most clients; lay out with tables.', test: cssHas(/position\s*:\s*(absolute|fixed|sticky)/i) },
  { feature: 'CSS variables (var())', severity: 'error', clients: ['gmail', 'outlook-windows', 'outlook.com', 'yahoo'], advice: 'Write the literal value; these clients do not resolve custom properties.', test: cssHas(/var\(\s*--/i) },
  { feature: 'calc()', severity: 'warning', clients: ['gmail', 'outlook-windows'], advice: 'Compute the value ahead of time.', test: cssHas(/calc\(/i) },
  { feature: 'float', severity: 'warning', clients: ['outlook-windows'], advice: 'Word ignores float on most elements; use table cells with align.', test: cssHas(/float\s*:\s*(left|right)/i) },
  { feature: 'background-image', severity: 'warning', clients: ['outlook-windows', 'gmail'], advice: 'Outlook needs VML for background images; give a solid background-color as the fallback.', test: cssHas(/background(-image)?\s*:[^;]*url\(/i) },
  { feature: 'margin: auto / max-width', severity: 'warning', clients: ['outlook-windows'], advice: 'Centre with align="center" on a table; use width attributes with an Outlook-only fixed-width wrapper.', test: cssHas(/max-width\s*:|margin[^;:]*:\s*[^;]*\bauto\b/i) },
  { feature: 'border-radius', severity: 'info', clients: ['outlook-windows'], advice: 'Square corners in Outlook for Windows; make sure that looks acceptable.', test: cssHas(/border-radius/i) },
  { feature: '@font-face web fonts', severity: 'info', clients: ['gmail', 'outlook-windows', 'yahoo'], advice: 'Name a web-safe fallback font after the web font.', test: cssHas(/@font-face/i) },
  { feature: 'rgba() / hsl() colours', severity: 'info', clients: ['outlook-windows'], advice: 'Give a hex colour as the fallback.', test: cssHas(/\b(rgba|hsla?)\(/i) },
  { feature: ':hover and other interactive pseudo-classes', severity: 'info', clients: ['gmail', 'outlook-windows'], advice: 'Treat hover styles as an enhancement only.', test: cssHas(/:(hover|focus|active)\b/i) },
  { feature: 'object-fit, filters, transforms, animation', severity: 'warning', clients: ['gmail', 'outlook-windows', 'outlook.com'], advice: 'These are dropped; do not rely on them.', test: cssHas(/\b(object-fit|filter|transform|animation|transition)\s*:/i) },
  { feature: '<svg> / <canvas> / <video> / <audio>', severity: 'error', clients: ['gmail', 'outlook-windows', 'outlook.com', 'yahoo'], advice: 'Use a PNG or GIF (a poster frame for video, linked to the page).', test: tagCount('svg', 'canvas', 'video', 'audio') },
  { feature: '<form> and form controls', severity: 'error', clients: ['gmail', 'outlook-windows', 'outlook.com', 'yahoo', 'apple-mail'], advice: 'Forms are removed or do not submit; link to a web page instead.', test: tagCount('form', 'input', 'select', 'textarea', 'button') },
  { feature: '<script>, <iframe>, <object>, <embed>', severity: 'error', clients: ['gmail', 'outlook-windows', 'outlook.com', 'yahoo', 'apple-mail', 'samsung'], advice: 'Removed everywhere; do not use.', test: tagCount('script', 'iframe', 'object', 'embed') },
  { feature: '<link> stylesheets', severity: 'error', clients: ['gmail', 'outlook-windows', 'outlook.com', 'yahoo'], advice: 'External stylesheets are not fetched; inline the CSS.', test: tagCount('link') },
  { feature: '<style> inside <body>', severity: 'warning', clients: ['gmail'], advice: 'Gmail ignores style blocks outside the head.', test: (c) => [...walk(c.root)].filter((e) => e.tag === 'style' && e.parent?.tag !== 'head' && e.parent?.tag !== 'html' && e.parent?.tag !== '#root').length },
  { feature: 'image without alt text', severity: 'warning', clients: ['gmail', 'outlook-windows', 'outlook.com', 'yahoo', 'apple-mail', 'samsung'], advice: 'Images are blocked by default in many clients; alt text is all some readers see.', test: (c) => [...walk(c.root)].filter((e) => e.tag === 'img' && !e.attrs.has('alt')).length },
  { feature: 'image without width', severity: 'info', clients: ['outlook-windows'], advice: 'Outlook for Windows ignores CSS width on images; give a width attribute.', test: (c) => [...walk(c.root)].filter((e) => e.tag === 'img' && !e.attrs.has('width')).length },
  { feature: 'data: URI images', severity: 'warning', clients: ['gmail', 'outlook-windows', 'outlook.com', 'yahoo'], advice: 'Not shown; attach as cid: or host the image.', test: (c) => [...walk(c.root)].filter((e) => e.tag === 'img' && /^data:/i.test(e.attrs.get('src') ?? '')).length },
  { feature: 'no table layout', severity: 'info', clients: ['outlook-windows'], advice: 'A layout with no tables at all will render unpredictably in Outlook for Windows.', test: (c) => ([...walk(c.root)].some((e) => e.tag === 'table') || ![...walk(c.root)].some((e) => e.tag === 'div') ? 0 : 1) },
  { feature: 'no lang attribute on <html>', severity: 'info', clients: ['apple-mail', 'gmail'], advice: 'Set lang for screen readers and hyphenation.', test: (c) => ([...walk(c.root)].find((e) => e.tag === 'html')?.attrs.has('lang') === false ? 1 : 0) },
];

/** What the common clients will drop or break in this HTML, and what to do instead. */
export function supportReport(html: string): Finding[] {
  const root = parseHtml(html);
  const els = [...walk(root)];
  const css = els.filter((e) => e.tag === 'style').map(textOf).join('\n');
  const inlineStyles = els.map((e) => e.attrs.get('style') ?? '').filter(Boolean);
  const out: Finding[] = [];
  for (const c of CHECKS) {
    const count = c.test({ root, html, css, inlineStyles });
    if (count > 0) out.push({ severity: c.severity, feature: c.feature, clients: c.clients, advice: c.advice, count });
  }
  const bytes = Buffer.byteLength(html);
  if (bytes > 102 * 1024) out.push({ severity: 'error', feature: `message is ${Math.round(bytes / 1024)} KB`, clients: ['gmail'], advice: 'Gmail clips messages over about 102 KB and hides the rest behind "View entire message", including the unsubscribe link.', count: 1 });
  else if (bytes > 90 * 1024) out.push({ severity: 'warning', feature: `message is ${Math.round(bytes / 1024)} KB`, clients: ['gmail'], advice: 'Close to the 102 KB point where Gmail clips a message.', count: 1 });
  const order = { error: 0, warning: 1, info: 2 } as const;
  return out.sort((a, b) => order[a.severity] - order[b.severity] || a.feature.localeCompare(b.feature));
}

/** The usual pipeline: sanitise, inline, add dark-mode hints, rewrite links, and make the text alternative. */
export function prepareEmail(html: string, o: { dark?: Readonly<Record<string, string>>; rewrite?: (url: string, ctx: LinkContext) => string | undefined; extraCss?: string } = {}): { html: string; text: string; report: Finding[]; warnings: readonly string[] } {
  const clean = sanitize(html);
  const inl = inlineCss(clean, o.extraCss !== undefined ? { extraCss: o.extraCss } : {});
  let out = inl.html;
  if (o.dark) out = darkModeHints(out, o.dark);
  if (o.rewrite) out = rewriteLinks(out, o.rewrite);
  return { html: out, text: toText(out), report: supportReport(out), warnings: inl.warnings };
}
