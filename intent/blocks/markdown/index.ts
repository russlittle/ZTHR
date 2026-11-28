/**
 * Markdown to an AST and to escaped HTML: CommonMark block and inline structure (ATX and setext headings, thematic
 * breaks, indented and fenced code, block quotes, bullet and ordered lists with tight and loose items, link
 * reference definitions, emphasis by the delimiter-run rules, links, images, autolinks, code spans, hard and soft
 * breaks, backslash escapes, entities) plus the GitHub extensions: tables with alignment, task lists,
 * strikethrough, bare URL autolinks and footnotes. Every block node carries its source position (1-based line and
 * column, end exclusive); inline nodes sit inside their block's range. Also here: heading ids that are stable and unique within a document, YAML-subset front
 * matter, and a walker.
 *
 * Safe by default. The renderer escapes all text and attributes; raw HTML in the source is shown as text (or
 * dropped, or passed to a function you supply, such as the html-sanitize block); link and image URLs with a scheme
 * outside http, https, mailto and tel (javascript:, data:, vbscript: and the rest) are never written. Nesting and
 * input size are bounded so hostile documents cannot exhaust the stack or the time.
 *
 * Not here: HTML blocks are recognised by a simplified rule (a line starting with a tag, comment or declaration
 * runs to the next blank line), setext headings cannot span a list marker line, and only a common set of named
 * entities is decoded (numeric ones always are). Front matter is a YAML subset: scalars, inline lists, block lists.
 */

export type NodeType =
  | 'document' | 'paragraph' | 'heading' | 'thematicBreak' | 'code' | 'blockquote' | 'list' | 'listItem' | 'html'
  | 'table' | 'tableRow' | 'tableCell' | 'footnoteDefinition'
  | 'text' | 'emphasis' | 'strong' | 'delete' | 'inlineCode' | 'link' | 'image' | 'break' | 'inlineHtml' | 'footnoteReference';

export interface Point {
  readonly line: number;
  readonly column: number;
}
export interface Position {
  readonly start: Point;
  readonly end: Point;
}

export interface Node {
  type: NodeType;
  position?: Position | undefined;
  children?: Node[] | undefined;
  value?: string | undefined;
  /** Heading level 1 to 6. */
  depth?: number | undefined;
  /** Heading id (see `headingIds`). */
  id?: string | undefined;
  lang?: string | undefined;
  fenced?: boolean | undefined;
  ordered?: boolean | undefined;
  start?: number | undefined;
  tight?: boolean | undefined;
  /** Task list item: true or false; undefined for an ordinary item. */
  checked?: boolean | undefined;
  url?: string | undefined;
  title?: string | undefined;
  align?: ('left' | 'center' | 'right' | null)[] | undefined;
  header?: boolean | undefined;
  label?: string | undefined;
  index?: number | undefined;
  hard?: boolean | undefined;
}

export class MarkdownError extends Error {
  constructor(why: string) {
    super(why);
  }
}

export interface ParseOptions {
  /** Longest source accepted, in characters. */
  readonly maxLength?: number;
  /** Deepest nesting of quotes and lists. */
  readonly maxDepth?: number;
  /** GitHub extensions (tables, task lists, strikethrough, autolinks, footnotes). */
  readonly gfm?: boolean;
}

// ---------------------------------------------------------------- small helpers

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—',
  ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', times: '×', trade: '™', euro: '€',
  pound: '£', yen: '¥', cent: '¢', sect: '§', deg: '°', middot: '·', bull: '•', larr: '←', rarr: '→',
  auml: 'ä', ouml: 'ö', uuml: 'ü', eacute: 'é', egrave: 'è', ntilde: 'ñ', szlig: 'ß',
};

/** Decodes character references; unknown names and out-of-range numbers stay as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (m, body: string) => {
    if (body[0] === '#') {
      const n = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�';
    }
    return Object.hasOwn(NAMED, body) ? NAMED[body]! : m;
  });
}

export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));

const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const unescapeMd = (s: string) => decodeEntities(s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1'));
const normLabel = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** The GitHub-style slug of a heading's text: lower case, punctuation dropped, spaces as hyphens. */
export function slugify(text: string): string {
  const s = text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').trim().replace(/\s/g, '-');
  return s || 'section';
}

/** Plain text of a node and everything inside it. */
export function textContent(n: Node): string {
  if (n.type === 'text' || n.type === 'inlineCode') return n.value ?? '';
  if (n.type === 'break') return n.hard ? '\n' : ' ';
  return (n.children ?? []).map(textContent).join(n.type === 'document' || n.type === 'blockquote' || n.type === 'list' ? '\n' : '');
}

export interface Visitor {
  /** Return false to skip the node's children. */
  enter?: (n: Node, parent: Node | undefined) => boolean | void;
  leave?: (n: Node, parent: Node | undefined) => void;
}

/** Depth-first walk. */
export function walk(n: Node, v: Visitor, parent?: Node): void {
  if (v.enter?.(n, parent) === false) return;
  for (const c of n.children ?? []) walk(c, v, n);
  v.leave?.(n, parent);
}

export const collect = (root: Node, type: NodeType): Node[] => {
  const out: Node[] = [];
  walk(root, { enter: (n) => void (n.type === type && out.push(n)) });
  return out;
};

/** Gives every heading an id from its text, unique in the document (-1, -2 on repeats). Returns the headings. */
export function headingIds(root: Node): Node[] {
  const used = new Set<string>();
  const counts = new Map<string, number>();
  const hs = collect(root, 'heading');
  for (const h of hs) {
    const base = slugify(textContent(h));
    let id = base;
    let n = counts.get(base) ?? 0;
    while (used.has(id)) id = `${base}-${++n}`;
    counts.set(base, n);
    used.add(id);
    h.id = id;
  }
  return hs;
}

// ---------------------------------------------------------------- front matter

export interface FrontMatter {
  readonly data: Record<string, unknown>;
  readonly body: string;
  /** Lines the front matter took, so positions in the body can be mapped back. */
  readonly lines: number;
}

function scalar(raw: string): unknown {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) return s.slice(1, -1);
  if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1).split(',').map((x) => x.trim()).filter((x) => x !== '').map(scalar);
  return s;
}

/** Splits `---` delimited front matter from the body. Anything this subset cannot read is an error, not a guess. */
export function frontMatter(src: string): FrontMatter {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { data: {}, body: src, lines: 0 };
  const data: Record<string, unknown> = Object.create(null);
  let list: unknown[] | undefined;
  for (const line of m[1]!.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item) {
      if (!list) throw new MarkdownError('front matter: a list item with no key above it');
      list.push(scalar(item[1]!));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):(?:\s+(.*)|\s*)$/.exec(line);
    if (!kv) throw new MarkdownError(`front matter: cannot read "${line.slice(0, 40)}"`);
    const key = kv[1]!;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new MarkdownError(`front matter: the key ${key} is not allowed`);
    if (kv[2] === undefined || kv[2] === '') {
      list = [];
      data[key] = list;
    } else {
      list = undefined;
      data[key] = scalar(kv[2]);
    }
  }
  for (const k of Object.keys(data)) if (Array.isArray(data[k]) && (data[k] as unknown[]).length === 0) data[k] = null;
  return { data, body: src.slice(m[0].length), lines: m[0].split('\n').length - 1 };
}

// ---------------------------------------------------------------- blocks

interface L {
  readonly t: string;
  readonly line: number;
  /** Columns already consumed by container prefixes. */
  readonly col: number;
}
interface Ctx {
  readonly refs: Map<string, { url: string; title?: string }>;
  readonly footnotes: Map<string, Node>;
  readonly maxDepth: number;
  readonly gfm: boolean;
}

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul|pre|script|style|textarea';
const HTML_START = /^ {0,3}<(?:[A-Za-z][A-Za-z0-9-]*(?:\s|\/?>|$)|\/[A-Za-z][A-Za-z0-9-]*\s*>|!--|\?|![A-Z])/;
const HTML_BLOCK_INTERRUPT = new RegExp(`^ {0,3}<(?:/?(?:${BLOCK_TAGS})(?:\\s|/?>|$)|!--|\\?|![A-Z])`, 'i');
const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?=[ \t]|$)[ \t]*(.*)$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])( +|\t|$)(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const FOOTDEF = /^ {0,3}\[\^([^\]\s]{1,100})\]:[ \t]*(.*)$/;

const indentOf = (t: string) => {
  let n = 0;
  while (t[n] === ' ') n++;
  return n;
};
const isBlank = (t: string) => /^[ \t]*$/.test(t);
const endPos = (l: L) => ({ line: l.line, column: l.col + l.t.length + 1 });
const startPos = (l: L) => ({ line: l.line, column: l.col + indentOf(l.t) + 1 });
const pos = (a: L, b: L): Position => ({ start: startPos(a), end: endPos(b) });
const strip = (l: L, n: number): L => ({ t: l.t.slice(n), line: l.line, col: l.col + n });

function expandTabs(s: string): string {
  const m = /^[ \t]*/.exec(s)![0];
  if (!m.includes('\t')) return s;
  let out = '';
  for (const ch of m) out += ch === '\t' ? ' '.repeat(4 - (out.length % 4)) : ch;
  return out + s.slice(m.length);
}

function splitCells(row: string): string[] {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function startsBlock(t: string, inParagraph: boolean): boolean {
  if (FENCE.test(t) && !(t.trimStart().startsWith('`') && /`/.test(FENCE.exec(t)![3]!))) return true;
  if (ATX.test(t) || HR.test(t) || /^ {0,3}>/.test(t)) return true;
  const m = ITEM.exec(t);
  if (m) {
    const empty = m[4]!.trim() === '';
    const isOrdered = /\d/.test(m[2]!);
    if (!inParagraph) return true;
    if (!empty && (!isOrdered || /^0*1[.)]$/.test(m[2]!))) return true;
  }
  return HTML_BLOCK_INTERRUPT.test(t);
}

/** Link reference definitions at the start of a paragraph's text; returns what is left. */
function takeDefinitions(text: string, ctx: Ctx): string {
  const re = /^ {0,3}\[((?:[^\\[\]]|\\.){1,999})\]:[ \t]*\n?[ \t]*(<[^<>\n]*>|[^\s<][^\s]*)(?:(?:[ \t]+|[ \t]*\n[ \t]*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?[ \t]*(?:\n|$)/;
  for (;;) {
    if (/^ {0,3}\[\^/.test(text) && ctx.gfm) return text;
    const m = re.exec(text);
    if (!m || normLabel(m[1]!) === '') return text;
    const key = normLabel(m[1]!);
    let url = m[2]!;
    if (url.startsWith('<')) url = url.slice(1, -1);
    if (!ctx.refs.has(key)) {
      const title = m[3] === undefined ? undefined : unescapeMd(m[3].slice(1, -1));
      ctx.refs.set(key, { url: unescapeMd(url), ...(title === undefined ? {} : { title }) });
    }
    text = text.slice(m[0].length);
  }
}

function parseBlocks(lines: readonly L[], ctx: Ctx, depth: number): Node[] {
  if (depth > ctx.maxDepth) throw new MarkdownError(`nesting deeper than ${ctx.maxDepth} levels`);
  const out: Node[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (isBlank(l.t)) { i++; continue; }
    const ind = indentOf(l.t);
    if (ind >= 4) {
      const code: L[] = [];
      let j = i;
      while (j < lines.length && (isBlank(lines[j]!.t) || indentOf(lines[j]!.t) >= 4)) code.push(lines[j++]!);
      while (code.length && isBlank(code[code.length - 1]!.t)) code.pop();
      out.push({ type: 'code', fenced: false, value: code.map((c) => (c.t.length >= 4 ? c.t.slice(4) : '')).join('\n') + '\n', position: pos(code[0]!, code[code.length - 1]!) });
      i += code.length;
      continue;
    }
    const f = FENCE.exec(l.t);
    if (f && !(f[2]![0] === '`' && f[3]!.includes('`'))) {
      const fence = f[2]!;
      const body: string[] = [];
      let j = i + 1;
      const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
      while (j < lines.length && !close.test(lines[j]!.t)) {
        const t = lines[j]!.t;
        body.push(t.slice(Math.min(f[1]!.length, indentOf(t))));
        j++;
      }
      const last = lines[Math.min(j, lines.length - 1)]!;
      const lang = unescapeMd(f[3]!.trim().split(/\s+/)[0] ?? '');
      out.push({ type: 'code', fenced: true, ...(lang ? { lang } : {}), value: body.length ? body.join('\n') + '\n' : '', position: pos(l, last) });
      i = j + 1;
      continue;
    }
    const h = ATX.exec(l.t);
    if (h) {
      let c = h[2]!.replace(/[ \t]+$/, '');
      c = c.replace(/(^|[ \t]+)#+$/, '');
      out.push({ type: 'heading', depth: h[1]!.length, value: c.trim(), position: pos(l, l) });
      i++;
      continue;
    }
    if (HR.test(l.t)) { out.push({ type: 'thematicBreak', position: pos(l, l) }); i++; continue; }
    if (/^ {0,3}>/.test(l.t)) {
      const inner: L[] = [];
      let j = i;
      let lazyOk = false;
      while (j < lines.length) {
        const t = lines[j]!;
        const q = /^ {0,3}> ?/.exec(t.t);
        if (q) {
          const s = strip(t, q[0].length);
          inner.push(s);
          lazyOk = !isBlank(s.t) && !FENCE.test(s.t) && !ATX.test(s.t) && !HR.test(s.t);
        } else if (lazyOk && !isBlank(t.t) && !startsBlock(t.t, true) && indentOf(t.t) < 4 + 99) {
          inner.push(t);
        } else break;
        j++;
      }
      out.push({ type: 'blockquote', children: parseBlocks(inner, ctx, depth + 1), position: pos(l, lines[j - 1]!) });
      i = j;
      continue;
    }
    const it = ITEM.exec(l.t);
    if (it) {
      const { list, next } = parseList(lines, i, ctx, depth);
      out.push(list);
      i = next;
      continue;
    }
    if (ctx.gfm) {
      const fd = FOOTDEF.exec(l.t);
      if (fd) {
        const body: L[] = [strip(l, l.t.length - fd[2]!.length)];
        let j = i + 1;
        while (j < lines.length) {
          const t = lines[j]!;
          if (isBlank(t.t)) {
            let k = j;
            while (k < lines.length && isBlank(lines[k]!.t)) k++;
            if (k < lines.length && indentOf(lines[k]!.t) >= 4) { for (; j < k; j++) body.push(lines[j]!); continue; }
            break;
          }
          if (indentOf(t.t) >= 4) body.push(strip(t, 4));
          else if (!startsBlock(t.t, true) && !FOOTDEF.test(t.t) && !isBlank(body[body.length - 1]!.t)) body.push(t);
          else break;
          j++;
        }
        const label = normLabel(fd[1]!);
        const node: Node = { type: 'footnoteDefinition', label, children: parseBlocks(body, ctx, depth + 1), position: pos(l, lines[j - 1]!) };
        if (!ctx.footnotes.has(label)) ctx.footnotes.set(label, node);
        i = j;
        continue;
      }
    }
    if (HTML_START.test(l.t) && (/^ {0,3}<(?:!--|\?|![A-Z])/.test(l.t) || HTML_BLOCK_INTERRUPT.test(l.t) || /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?\/?>[ \t]*$/.test(l.t))) {
      const body: L[] = [];
      let j = i;
      const comment = /^ {0,3}<!--/.test(l.t);
      while (j < lines.length) {
        body.push(lines[j]!);
        if (comment && lines[j]!.t.includes('-->')) { j++; break; }
        j++;
        if (!comment && (j >= lines.length || isBlank(lines[j]!.t))) break;
      }
      out.push({ type: 'html', value: body.map((b) => b.t).join('\n') + '\n', position: pos(l, body[body.length - 1]!) });
      i = j;
      continue;
    }
    if (ctx.gfm && i + 1 < lines.length && l.t.includes('|') && TABLE_DELIM.test(lines[i + 1]!.t)) {
      const head = splitCells(l.t);
      const delim = splitCells(lines[i + 1]!.t);
      if (head.length === delim.length) {
        const align = delim.map((d) => (d.startsWith(':') && d.endsWith(':') ? 'center' : d.startsWith(':') ? 'left' : d.endsWith(':') ? 'right' : null)) as ('left' | 'center' | 'right' | null)[];
        const mk = (cells: string[], header: boolean, row: L): Node => ({
          type: 'tableRow', header, position: pos(row, row),
          children: head.map((_, k) => ({ type: 'tableCell', header, value: cells[k] ?? '', position: pos(row, row) })),
        });
        const rows: Node[] = [mk(head, true, l)];
        let j = i + 2;
        while (j < lines.length && !isBlank(lines[j]!.t) && !startsBlock(lines[j]!.t, true)) rows.push(mk(splitCells(lines[j]!.t), false, lines[j++]!));
        out.push({ type: 'table', align, children: rows, position: pos(l, lines[j - 1]!) });
        i = j;
        continue;
      }
    }
    // A paragraph, possibly turned into a setext heading, possibly starting with link reference definitions.
    const para: L[] = [l];
    let j = i + 1;
    let setext = 0;
    while (j < lines.length) {
      const t = lines[j]!;
      if (isBlank(t.t)) break;
      const se = SETEXT.exec(t.t);
      if (se && indentOf(t.t) < 4) { setext = se[1]![0] === '=' ? 1 : 2; j++; break; }
      if (startsBlock(t.t, true) && indentOf(t.t) < 4) break;
      if (ctx.gfm && j + 1 < lines.length && t.t.includes('|') && TABLE_DELIM.test(lines[j + 1]!.t) && splitCells(t.t).length === splitCells(lines[j + 1]!.t).length) break;
      para.push(t);
      j++;
    }
    const raw = para.map((p) => p.t.replace(/^ +/, '')).join('\n');
    const rest = takeDefinitions(raw, ctx);
    if (rest.trim() !== '') {
      const text = rest.replace(/[ \t]+$/, '');
      out.push(setext ? { type: 'heading', depth: setext, value: text.replace(/\n/g, ' ').trim(), position: pos(para[0]!, lines[j - 1]!) } : { type: 'paragraph', value: text, position: pos(para[0]!, para[para.length - 1]!) });
    } else if (setext) {
      // "[foo]: /url\n===" : the definition is taken and the underline is a paragraph.
      out.push({ type: 'paragraph', value: lines[j - 1]!.t.trim(), position: pos(lines[j - 1]!, lines[j - 1]!) });
    }
    i = j;
  }
  return out;
}

function parseList(lines: readonly L[], i: number, ctx: Ctx, depth: number): { list: Node; next: number } {
  const first = ITEM.exec(lines[i]!.t)!;
  const ordered = /\d/.test(first[2]!);
  const kind = ordered ? first[2]!.slice(-1) : first[2]!;
  const items: Node[] = [];
  let j = i;
  while (j < lines.length) {
    const m = ITEM.exec(lines[j]!.t);
    if (!m || HR.test(lines[j]!.t) || (/\d/.test(m[2]!) ? m[2]!.slice(-1) : m[2]!) !== kind || /\d/.test(m[2]!) !== ordered) break;
    const l = lines[j]!;
    const markerLen = m[1]!.length + m[2]!.length;
    let spaces = m[3] === '\t' ? 1 : m[3]!.length;
    const restEmpty = m[4]!.trim() === '';
    if (restEmpty) spaces = 1;
    else if (spaces > 4) spaces = 1;
    const offset = markerLen + spaces;
    const body: L[] = [restEmpty ? { t: '', line: l.line, col: l.col + offset } : strip(l, offset)];
    let k = j + 1;
    let lazyOk = !restEmpty;
    while (k < lines.length) {
      const t = lines[k]!;
      if (isBlank(t.t)) {
        if (restEmpty && body.length === 1) break;
        let n = k;
        while (n < lines.length && isBlank(lines[n]!.t)) n++;
        if (n < lines.length && indentOf(lines[n]!.t) >= offset) { for (; k < n; k++) body.push({ t: '', line: lines[k]!.line, col: 0 }); continue; }
        break;
      }
      if (indentOf(t.t) >= offset) {
        body.push(strip(t, offset));
        lazyOk = !FENCE.test(t.t.slice(offset)) && !HR.test(t.t.slice(offset));
      } else if (lazyOk && !isBlank(body[body.length - 1]!.t) && !startsBlock(t.t, true) && !ITEM.test(t.t)) body.push(t);
      else break;
      k++;
    }
    while (body.length > 1 && isBlank(body[body.length - 1]!.t)) body.pop();
    const children = parseBlocks(body, ctx, depth + 1);
    const item: Node = { type: 'listItem', children, position: pos(l, body[body.length - 1]!) };
    const p0 = children[0];
    if (ctx.gfm && p0?.type === 'paragraph') {
      const tm = /^\[([ xX])\](?:[ \t]+|$)/.exec(p0.value ?? '');
      if (tm) {
        item.checked = tm[1] !== ' ';
        p0.value = (p0.value ?? '').slice(tm[0].length);
      }
    }
    items.push(item);
    j = k;
    // Blank lines between items are skipped here; a different marker or non-item ends the list.
    let n = j;
    while (n < lines.length && isBlank(lines[n]!.t)) n++;
    if (n > j && n < lines.length && ITEM.test(lines[n]!.t) && !HR.test(lines[n]!.t)) j = n;
    else if (n === j) continue;
    else break;
  }
  let loose = false;
  items.forEach((it, k) => {
    const nx = items[k + 1];
    if (nx && nx.position!.start.line > it.position!.end.line + 1) loose = true;
    const ch = it.children ?? [];
    for (let c = 0; c + 1 < ch.length; c++) if (ch[c + 1]!.position!.start.line > ch[c]!.position!.end.line + 1) loose = true;
  });
  const list: Node = { type: 'list', ordered, tight: !loose, children: items, position: { start: items[0]!.position!.start, end: items[items.length - 1]!.position!.end } };
  if (ordered) list.start = parseInt(first[2]!, 10);
  return { list, next: j };
}

// ---------------------------------------------------------------- inlines

interface Delim {
  node: Node;
  ch: string;
  count: number;
  readonly orig: number;
  readonly canOpen: boolean;
  readonly canClose: boolean;
}
interface Bracket {
  readonly node: Node;
  readonly image: boolean;
  active: boolean;
  readonly delimBottom: number;
  readonly textEnd: number;
}

const isWs = (c: string | undefined) => c === undefined || /\s/u.test(c);
const isPunct = (c: string | undefined) => c !== undefined && /[\p{P}\p{S}]/u.test(c);
const MAX_DELIMS = 3000;

function parseDest(s: string, at: number): { url: string; title?: string; end: number } | undefined {
  let i = at;
  while (i < s.length && /[ \t\n]/.test(s[i]!)) i++;
  let url = '';
  if (s[i] === '<') {
    const e = s.indexOf('>', i);
    if (e < 0 || s.slice(i, e).includes('\n')) return undefined;
    url = s.slice(i + 1, e);
    if (/(^|[^\\])(\\\\)*</.test(url.replace(/^/, ' '))) return undefined;
    i = e + 1;
  } else {
    let depth = 0;
    const st = i;
    while (i < s.length && !/[\s\u0000-\u001f]/.test(s[i]!)) {
      if (s[i] === '\\' && i + 1 < s.length) { i += 2; continue; }
      if (s[i] === '(') depth++;
      else if (s[i] === ')') { if (depth === 0) break; depth--; }
      i++;
    }
    if (depth !== 0) return undefined;
    url = s.slice(st, i);
  }
  const afterDest = i;
  while (i < s.length && /[ \t\n]/.test(s[i]!)) i++;
  let title: string | undefined;
  const q = s[i];
  if (i > afterDest && (q === '"' || q === "'" || q === '(')) {
    const close = q === '(' ? ')' : q;
    let j = i + 1;
    while (j < s.length && s[j] !== close) j += s[j] === '\\' ? 2 : 1;
    if (j >= s.length) return undefined;
    title = unescapeMd(s.slice(i + 1, j));
    i = j + 1;
    while (i < s.length && /[ \t\n]/.test(s[i]!)) i++;
  }
  if (s[i] !== ')') return undefined;
  return { url: unescapeMd(url), ...(title === undefined ? {} : { title }), end: i + 1 };
}

function parseInlines(text: string, ctx: Ctx, refCount: { next: number; order: string[] }): Node[] {
  const nodes: Node[] = [];
  const delims: Delim[] = [];
  const brackets: Bracket[] = [];
  let buf = '';
  const flush = () => {
    if (buf) nodes.push({ type: 'text', value: buf });
    buf = '';
  };
  const wrap = (from: number, to: number, type: NodeType, extra: Partial<Node> = {}): Node => {
    const kids = nodes.splice(from, to - from);
    return { type, ...extra, children: kids };
  };

  const processEmphasis = (bottom: number) => {
    let c = bottom;
    while (c < delims.length) {
      const closer = delims[c]!;
      if (!closer.canClose) { c++; continue; }
      let o = c - 1;
      let found = -1;
      for (; o >= bottom; o--) {
        const op = delims[o]!;
        if (op.ch !== closer.ch || !op.canOpen) continue;
        if (op.ch === '~') { if (op.count === closer.count) { found = o; break; } continue; }
        const odd = (op.canClose || closer.canOpen) && (op.orig + closer.orig) % 3 === 0 && !(op.orig % 3 === 0 && closer.orig % 3 === 0);
        if (!odd) { found = o; break; }
      }
      if (found < 0) {
        if (!closer.canOpen) delims.splice(c, 1);
        else c++;
        continue;
      }
      const op = delims[found]!;
      const use = closer.ch === '~' ? closer.count : closer.count >= 2 && op.count >= 2 ? 2 : 1;
      const oi = nodes.indexOf(op.node);
      const ci = nodes.indexOf(closer.node);
      const em = wrap(oi + 1, ci, closer.ch === '~' ? 'delete' : use === 2 ? 'strong' : 'emphasis');
      nodes.splice(oi + 1, 0, em);
      op.count -= use;
      closer.count -= use;
      op.node.value = op.ch.repeat(op.count);
      closer.node.value = closer.ch.repeat(closer.count);
      // Delimiters between opener and closer can no longer match anything.
      delims.splice(found + 1, c - found - 1);
      c = found + 1;
      if (op.count === 0) { nodes.splice(nodes.indexOf(op.node), 1); delims.splice(found, 1); c--; }
      if (closer.count === 0) { nodes.splice(nodes.indexOf(closer.node), 1); delims.splice(c, 1); }
    }
    delims.splice(bottom);
  };

  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '\\') {
      if (text[i + 1] === '\n') { flush(); nodes.push({ type: 'break', hard: true }); i += 2; while (text[i] === ' ') i++; continue; }
      if (i + 1 < n && ESCAPABLE.test(text[i + 1]!)) { buf += text[i + 1]; i += 2; continue; }
      buf += ch; i++; continue;
    }
    if (ch === '\n') {
      const hard = / {2,}$/.test(buf);
      buf = buf.replace(/ +$/, '');
      flush();
      nodes.push({ type: 'break', hard });
      i++;
      while (text[i] === ' ') i++;
      continue;
    }
    if (ch === '`') {
      let r = i;
      while (text[r] === '`') r++;
      const len = r - i;
      let k = r;
      let close = -1;
      while (k < n) {
        if (text[k] === '`') {
          let e = k;
          while (text[e] === '`') e++;
          if (e - k === len) { close = k; break; }
          k = e;
        } else k++;
      }
      if (close < 0) { buf += text.slice(i, r); i = r; continue; }
      let code = text.slice(r, close).replace(/\n/g, ' ');
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1);
      flush();
      nodes.push({ type: 'inlineCode', value: code });
      i = close + len;
      continue;
    }
    if (ch === '*' || ch === '_' || (ch === '~' && ctx.gfm)) {
      let r = i;
      while (text[r] === ch) r++;
      const count = r - i;
      const before = text[i - 1];
      const after = text[r];
      const leftF = !isWs(after) && (!isPunct(after) || isWs(before) || isPunct(before));
      const rightF = !isWs(before) && (!isPunct(before) || isWs(after) || isPunct(after));
      const canOpen = ch === '_' ? leftF && (!rightF || isPunct(before)) : leftF;
      const canClose = ch === '_' ? rightF && (!leftF || isPunct(after)) : rightF;
      const ok = ch !== '~' || count <= 2;
      flush();
      const node: Node = { type: 'text', value: text.slice(i, r) };
      nodes.push(node);
      if (ok && (canOpen || canClose) && delims.length < MAX_DELIMS) delims.push({ node, ch, count, orig: count, canOpen, canClose });
      i = r;
      continue;
    }
    if (ch === '!' && text[i + 1] === '[') {
      flush();
      const node: Node = { type: 'text', value: '![' };
      nodes.push(node);
      brackets.push({ node, image: true, active: true, delimBottom: delims.length, textEnd: nodes.length });
      i += 2;
      continue;
    }
    if (ch === '[') {
      flush();
      const node: Node = { type: 'text', value: '[' };
      nodes.push(node);
      brackets.push({ node, image: false, active: true, delimBottom: delims.length, textEnd: nodes.length });
      i++;
      continue;
    }
    if (ch === ']') {
      const b = brackets.pop();
      if (!b) { buf += ch; i++; continue; }
      flush();
      if (!b.active) { buf += ']'; i++; continue; }
      const startIdx = nodes.indexOf(b.node);
      const inner = text.slice(0, 0);
      void inner;
      let dest: { url: string; title?: string; end: number } | undefined;
      let label: string | undefined;
      if (text[i + 1] === '(') {
        dest = parseDest(text, i + 2);
      }
      let consumed = 0;
      let ref: { url: string; title?: string } | undefined;
      if (!dest) {
        // Reference forms: [text][label], [text][], [text].
        const raw = rawBetween(text, nodes, b, i);
        const m = /^\[((?:[^\\[\]]|\\.){1,999})\]/.exec(text.slice(i + 1));
        if (m) { label = m[1]!; consumed = m[0].length; ref = ctx.refs.get(normLabel(label)); }
        else if (text.slice(i + 1, i + 3) === '[]') { consumed = 2; ref = ctx.refs.get(normLabel(raw)); }
        else { ref = ctx.refs.get(normLabel(raw)); }
        if (!ref && m) { consumed = 0; ref = undefined; }
        if (!ref && text.slice(i + 1, i + 3) === '[]') { consumed = 0; }
        // Footnote reference [^label].
        if (!ref && ctx.gfm && !b.image && /^\^[^\]\s]+$/.test(raw) && ctx.footnotes.has(normLabel(raw.slice(1)))) {
          const lab = normLabel(raw.slice(1));
          let idx = refCount.order.indexOf(lab);
          if (idx < 0) { refCount.order.push(lab); idx = refCount.order.length - 1; }
          nodes.splice(startIdx);
          nodes.push({ type: 'footnoteReference', label: lab, index: idx + 1 });
          delims.splice(b.delimBottom);
          i++;
          continue;
        }
      }
      if (dest || ref) {
        const target = dest ?? ref!;
        processEmphasis(b.delimBottom);
        const kids = nodes.splice(startIdx + 1);
        nodes.splice(startIdx, 1);
        const link: Node = { type: b.image ? 'image' : 'link', url: target.url, ...(target.title === undefined ? {} : { title: target.title }), children: kids };
        nodes.push(link);
        if (!b.image) for (const o of brackets) if (!o.image) o.active = false;
        i = dest ? dest.end : i + 1 + consumed;
        continue;
      }
      brackets.push(b);
      brackets.pop();
      buf += ']';
      i++;
      continue;
    }
    if (ch === '<') {
      const rest = text.slice(i);
      const au = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/.exec(rest);
      const em = /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/.exec(rest);
      if (au || em) {
        flush();
        const target = (au ?? em)![1]!;
        nodes.push({ type: 'link', url: au ? target : `mailto:${target}`, children: [{ type: 'text', value: target }] });
        i += (au ?? em)![0].length;
        continue;
      }
      const html = /^<(?:[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?|\/[A-Za-z][A-Za-z0-9-]*\s*|!--[\s\S]*?--|\?[\s\S]*?\?|![A-Z][\s\S]*?)>/.exec(rest);
      if (html) { flush(); nodes.push({ type: 'inlineHtml', value: html[0] }); i += html[0].length; continue; }
      buf += ch; i++; continue;
    }
    if (ch === '&') {
      const m = /^&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(text.slice(i));
      if (m) { buf += decodeEntities(m[0]); i += m[0].length; continue; }
    }
    if (ctx.gfm && (ch === 'h' || ch === 'w') && (i === 0 || /[\s*_~(]/.test(text[i - 1]!))) {
      const m = /^(?:https?:\/\/|www\.)[^\s<]+/.exec(text.slice(i));
      if (m && /^(?:https?:\/\/[^\s/.]+\.[^\s]|www\.[^\s.]+\.[^\s])/.test(m[0])) {
        let u = m[0];
        for (;;) {
          const t = u.replace(/[?!.,:*_~'"]+$/, '');
          const opens = (t.match(/\(/g) ?? []).length;
          const closes = (t.match(/\)/g) ?? []).length;
          const t2 = closes > opens && t.endsWith(')') ? t.slice(0, -1) : t;
          if (t2 === u) break;
          u = t2;
        }
        flush();
        nodes.push({ type: 'link', url: u.startsWith('www.') ? `http://${u}` : u, children: [{ type: 'text', value: u }] });
        i += u.length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  processEmphasis(0);
  return mergeText(nodes);
}

/** The source text between a bracket and the closing bracket at `at`, for reference labels. */
function rawBetween(text: string, nodes: Node[], b: Bracket, at: number): string {
  void nodes;
  // Walk back from `at` to the matching opener in the source text.
  let depth = 0;
  for (let k = at - 1; k >= 0; k--) {
    const c = text[k];
    if (c === ']' && text[k - 1] !== '\\') depth++;
    else if (c === '[' && text[k - 1] !== '\\') {
      if (depth === 0) return text.slice(k + 1, at);
      depth--;
    }
  }
  void b;
  return '';
}

function mergeText(ns: Node[]): Node[] {
  const out: Node[] = [];
  for (const nd of ns) {
    if (nd.type === 'text' && (nd.value ?? '') === '') continue;
    const last = out[out.length - 1];
    if (nd.type === 'text' && last?.type === 'text') last.value = (last.value ?? '') + (nd.value ?? '');
    else out.push(nd);
  }
  for (const nd of out) if (nd.children) nd.children = mergeText(nd.children);
  return out;
}

// ---------------------------------------------------------------- parse

/** Parses Markdown source into a document node. Throws MarkdownError for input past the limits. */
export function parse(src: string, o: ParseOptions = {}): Node {
  const maxLength = o.maxLength ?? 2_000_000;
  if (src.length > maxLength) throw new MarkdownError(`the document is ${src.length} characters; the limit is ${maxLength}`);
  const ctx: Ctx = { refs: new Map(), footnotes: new Map(), maxDepth: o.maxDepth ?? 32, gfm: o.gfm ?? true };
  const lines: L[] = src.replace(/\r\n?/g, '\n').replace(/\u0000/g, '�').split('\n').map((t, k) => ({ t: expandTabs(t), line: k + 1, col: 0 }));
  const doc: Node = { type: 'document', children: parseBlocks(lines, ctx, 0), position: { start: { line: 1, column: 1 }, end: endPos(lines[lines.length - 1]!) } };
  const refs = { next: 1, order: [] as string[] };
  const inlineify = (nd: Node) => {
    if (nd.value !== undefined && (nd.type === 'paragraph' || nd.type === 'heading' || nd.type === 'tableCell')) {
      nd.children = parseInlines(nd.value, ctx, refs);
      delete nd.value;
    }
    for (const c of nd.children ?? []) inlineify(c);
  };
  inlineify(doc);
  // Footnote definitions, in the order they were first cited; citations inside definitions are followed too.
  for (let k = 0; k < refs.order.length; k++) {
    const def = ctx.footnotes.get(refs.order[k]!)!;
    const copy: Node = { ...def, index: k + 1 };
    inlineify(copy);
    doc.children!.push(copy);
  }
  return doc;
}

/** Front matter and body together: the data, and the tree of the body with positions in the whole file's lines. */
export function parseWithFrontMatter(src: string, o: ParseOptions = {}): { data: Record<string, unknown>; tree: Node } {
  const fm = frontMatter(src);
  const tree = parse(fm.body, o);
  if (fm.lines > 0) {
    walk(tree, { enter: (nd) => {
      if (nd.position) nd.position = { start: { ...nd.position.start, line: nd.position.start.line + fm.lines }, end: { ...nd.position.end, line: nd.position.end.line + fm.lines } };
    } });
  }
  return { data: fm.data, tree };
}

// ---------------------------------------------------------------- HTML

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

/** A URL fit for href or src, or undefined when its scheme is not one of http, https, mailto, tel. Relative URLs pass. */
export function safeUrl(url: string): string | undefined {
  const t = url.trim().replace(/[\u0000-\u001f\u007f-\u009f\u200b\u2028\u2029\ufeff]/g, '');
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(t.replace(/\s/g, ''));
  if (m && !SAFE_SCHEMES.has(m[1]!.toLowerCase())) return undefined;
  if (!m && /^[^/?#]*:/.test(t)) return undefined;
  return t.replace(/%(?![0-9A-Fa-f]{2})|[^A-Za-z0-9\-._~:/?#@!$&'()*+,;=%[\]]/gu, (c) => (c === '%' ? '%25' : encodeURIComponent(c)));
}

export interface RenderOptions {
  /** Raw HTML in the source: shown as text (default), dropped, or passed through a function such as a sanitizer. */
  readonly rawHtml?: 'escape' | 'omit' | ((html: string) => string);
  /** Write id attributes on headings (assigns them with headingIds when missing). */
  readonly headingIds?: boolean;
  /** Open links with rel="nofollow noopener" and, for absolute links, target="_blank". */
  readonly externalLinks?: boolean;
}

export function render(root: Node, o: RenderOptions = {}): string {
  if (o.headingIds) headingIds(root);
  const raw = (v: string) => (typeof o.rawHtml === 'function' ? o.rawHtml(v) : o.rawHtml === 'omit' ? '' : escapeHtml(v));
  const inline = (ns: readonly Node[] | undefined): string => (ns ?? []).map(inl).join('');
  const inl = (nd: Node): string => {
    switch (nd.type) {
      case 'text': return escapeHtml(nd.value ?? '');
      case 'emphasis': return `<em>${inline(nd.children)}</em>`;
      case 'strong': return `<strong>${inline(nd.children)}</strong>`;
      case 'delete': return `<del>${inline(nd.children)}</del>`;
      case 'inlineCode': return `<code>${escapeHtml(nd.value ?? '')}</code>`;
      case 'break': return nd.hard ? '<br />\n' : '\n';
      case 'inlineHtml': return raw(nd.value ?? '');
      case 'link': {
        const u = safeUrl(nd.url ?? '');
        if (u === undefined) return inline(nd.children);
        const ext = o.externalLinks && /^[a-z][a-z0-9+.-]*:/i.test(u) ? ' target="_blank" rel="nofollow noopener"' : '';
        return `<a href="${escapeHtml(u)}"${nd.title ? ` title="${escapeHtml(nd.title)}"` : ''}${ext}>${inline(nd.children)}</a>`;
      }
      case 'image': {
        const u = safeUrl(nd.url ?? '');
        const alt = escapeHtml(textContent(nd));
        if (u === undefined) return alt;
        return `<img src="${escapeHtml(u)}" alt="${alt}"${nd.title ? ` title="${escapeHtml(nd.title)}"` : ''} />`;
      }
      case 'footnoteReference': return `<sup class="footnote-ref"><a href="#fn-${escapeHtml(encodeURIComponent(nd.label ?? ''))}" id="fnref-${escapeHtml(encodeURIComponent(nd.label ?? ''))}">${nd.index}</a></sup>`;
      default: return '';
    }
  };
  const blocks = (ns: readonly Node[] | undefined): string => (ns ?? []).map((b) => blk(b, false)).join('');
  const blk = (nd: Node, tight: boolean): string => {
    switch (nd.type) {
      case 'paragraph': return tight ? inline(nd.children) : `<p>${inline(nd.children)}</p>\n`;
      case 'heading': return `<h${nd.depth}${o.headingIds && nd.id ? ` id="${escapeHtml(nd.id)}"` : ''}>${inline(nd.children)}</h${nd.depth}>\n`;
      case 'thematicBreak': return '<hr />\n';
      case 'code': return `<pre><code${nd.lang ? ` class="language-${escapeHtml(nd.lang)}"` : ''}>${escapeHtml(nd.value ?? '')}</code></pre>\n`;
      case 'blockquote': return `<blockquote>\n${blocks(nd.children)}</blockquote>\n`;
      case 'html': {
        const r = raw((nd.value ?? '').replace(/\n$/, ''));
        return r === '' ? '' : typeof o.rawHtml === 'function' ? `${r}\n` : `<p>${r}</p>\n`;
      }
      case 'list': {
        const tag = nd.ordered ? 'ol' : 'ul';
        return `<${tag}${nd.ordered && nd.start !== undefined && nd.start !== 1 ? ` start="${nd.start}"` : ''}>\n${(nd.children ?? []).map((it) => item(it, !!nd.tight)).join('')}</${tag}>\n`;
      }
      case 'table': {
        const [head, ...body] = nd.children ?? [];
        const row = (r: Node) => `<tr>\n${(r.children ?? []).map((c, k) => { const a = nd.align?.[k]; const t = r.header ? 'th' : 'td'; return `<${t}${a ? ` align="${a}"` : ''}>${inline(c.children)}</${t}>\n`; }).join('')}</tr>\n`;
        return `<table>\n<thead>\n${head ? row(head) : ''}</thead>\n${body.length ? `<tbody>\n${body.map(row).join('')}</tbody>\n` : ''}</table>\n`;
      }
      case 'footnoteDefinition': return '';
      default: return '';
    }
  };
  const item = (it: Node, tight: boolean): string => {
    const kids = it.children ?? [];
    const box = it.checked === undefined ? '' : `<input${it.checked ? ' checked=""' : ''} disabled="" type="checkbox"> `;
    if (kids.length === 0) return `<li>${box.trimEnd()}</li>\n`;
    if (!tight) {
      const body = kids.map((c, k) => (k === 0 && box && c.type === 'paragraph' ? `<p>${box}${inline(c.children)}</p>\n` : blk(c, false))).join('');
      return `<li>\n${body}</li>\n`;
    }
    let s = '<li>' + box;
    kids.forEach((c, k) => {
      if (c.type === 'paragraph') s += inline(c.children) + (k + 1 < kids.length ? '\n' : '');
      else s += (k === 0 ? '\n' : '') + blk(c, true);
    });
    return `${s}</li>\n`;
  };
  const defs = (root.children ?? []).filter((c) => c.type === 'footnoteDefinition');
  const main = (root.children ?? []).filter((c) => c.type !== 'footnoteDefinition');
  let html = blocks(main);
  if (defs.length) {
    html += '<section class="footnotes">\n<ol>\n';
    for (const d of defs) {
      const id = escapeHtml(encodeURIComponent(d.label ?? ''));
      const body = blocks(d.children).replace(/<\/p>\n$/, ` <a href="#fnref-${id}" class="footnote-backref">↩</a></p>\n`);
      html += `<li id="fn-${id}">\n${body}</li>\n`;
    }
    html += '</ol>\n</section>\n';
  }
  return html;
}

/** Source to HTML in one step. */
export const toHtml = (src: string, o: ParseOptions & RenderOptions = {}): string => render(parse(src, o), o);
