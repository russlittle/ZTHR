/**
 * What a reader needs to find their way around a document, taken from its Markdown tree (the markdown block):
 *  - the outline: headings nested by level, tolerating skipped levels (an h3 straight under an h1) and several h1s,
 *    with each heading's source position, plus checks for the things that confuse readers and screen readers;
 *  - stable anchors: ids that do not move when the document is edited. A heading keeps its id while its text is
 *    unchanged, a new heading with a repeated text gets the next free suffix instead of taking an older one, and
 *    ids that disappeared are reported with the id to redirect them to, so old links keep working;
 *  - reading time: words counted by Unicode word segmentation (CJK by character, at its own pace), code read slower,
 *    and a few seconds for each image, so a figure-heavy post is not "1 minute";
 *  - an excerpt: the first prose, as plain text, cut at a sentence or word and never inside a character, with a
 *    manual `<!--more-->` marker honoured;
 *  - a table of contents rendered as escaped HTML or Markdown, the section that owns a source line, and per-section
 *    word counts.
 *
 * Out of scope: reading time for languages the segmenter does not know (it falls back to spaces), and any
 * rendering of the document itself (that is the markdown block).
 */
import { parse, slugify, textContent, escapeHtml } from '../markdown/index.ts';
import type { Node, Position } from '../markdown/index.ts';

export interface Heading {
  readonly depth: number;
  readonly text: string;
  readonly id: string;
  readonly position: Position | undefined;
  readonly children: Heading[];
}

export interface Lint {
  readonly code: 'no-title' | 'many-titles' | 'skipped-level' | 'empty-heading' | 'duplicate-text';
  readonly message: string;
  readonly heading?: string;
}

const asTree = (src: string | Node): Node => (typeof src === 'string' ? parse(src) : src);
const headingNodes = (root: Node): Node[] => (root.children ?? []).filter((n) => n.type === 'heading');

// ---------------------------------------------------------------- stable anchors

export interface AnchorRecord {
  readonly id: string;
  readonly text: string;
}

export interface AnchorResult {
  /** One per heading in document order. */
  readonly anchors: AnchorRecord[];
  /** Ids that existed and do not now, each with where its link should go (undefined if nothing is close). */
  readonly redirects: { from: string; to: string | undefined }[];
}

/**
 * Gives each heading an id. `previous` is the list from the last published version. A heading whose text is the same
 * as a previous one keeps that one's id (the first unused match, in order), so editing elsewhere does not change it;
 * a new heading gets the slug of its text, or the next free suffix. A previous heading with no match is a rename or
 * a removal: if exactly one heading at the same position in the order is new, links to the old id go there.
 */
export function stableAnchors(headings: readonly { text: string }[], previous: readonly AnchorRecord[] = []): AnchorResult {
  const ids: (string | undefined)[] = headings.map(() => undefined);
  const claimed = new Set<number>();
  headings.forEach((h, i) => {
    const j = previous.findIndex((p, k) => !claimed.has(k) && p.text === h.text);
    if (j >= 0) { claimed.add(j); ids[i] = previous[j]!.id; }
  });
  const taken = new Set<string>(ids.filter((x): x is string => x !== undefined));
  const matched = new Set(ids.map((id, i) => (id !== undefined ? i : -1)).filter((i) => i >= 0));
  headings.forEach((h, i) => {
    if (ids[i] !== undefined) return;
    const base = slugify(h.text);
    let id = base;
    let n = 0;
    while (taken.has(id)) id = `${base}-${++n}`;
    ids[i] = id;
    taken.add(id);
  });
  const redirects: { from: string; to: string | undefined }[] = [];
  previous.forEach((p, k) => {
    if (claimed.has(k) || taken.has(p.id)) return;
    // A rename keeps its place in the order: the heading now at that position, if it is new, is where the link goes.
    redirects.push({ from: p.id, to: k < headings.length && !matched.has(k) ? ids[k] : undefined });
  });
  return { anchors: headings.map((h, i) => ({ id: ids[i]!, text: h.text })), redirects };
}

// ---------------------------------------------------------------- outline

export interface OutlineOptions {
  readonly previous?: readonly AnchorRecord[];
  readonly minDepth?: number;
  readonly maxDepth?: number;
}

export interface Outline {
  readonly headings: Heading[];
  /** Every heading, in document order, with its id. */
  readonly flat: Heading[];
  readonly anchors: AnchorResult;
  readonly lint: Lint[];
}

/** The outline of a document (source text or tree). */
export function outline(src: string | Node, o: OutlineOptions = {}): Outline {
  const nodes = headingNodes(asTree(src));
  const texts = nodes.map((n) => textContent(n).trim());
  const anchors = stableAnchors(texts.map((text) => ({ text })), o.previous ?? []);
  const min = o.minDepth ?? 1;
  const max = o.maxDepth ?? 6;
  const flat: Heading[] = [];
  const roots: Heading[] = [];
  const stack: Heading[] = [];
  nodes.forEach((n, i) => {
    const h: Heading = { depth: n.depth!, text: texts[i]!, id: anchors.anchors[i]!.id, position: n.position, children: [] };
    if (h.depth < min || h.depth > max) return;
    flat.push(h);
    while (stack.length && stack[stack.length - 1]!.depth >= h.depth) stack.pop();
    (stack.length ? stack[stack.length - 1]!.children : roots).push(h);
    stack.push(h);
  });
  return { headings: roots, flat, anchors, lint: lintOutline(nodes.map((n, i) => ({ depth: n.depth!, text: texts[i]! }))) };
}

function lintOutline(hs: readonly { depth: number; text: string }[]): Lint[] {
  const out: Lint[] = [];
  const h1 = hs.filter((h) => h.depth === 1);
  if (hs.length > 0 && h1.length === 0) out.push({ code: 'no-title', message: 'the document has no level 1 heading' });
  if (h1.length > 1) out.push({ code: 'many-titles', message: `the document has ${h1.length} level 1 headings; a page should have one` });
  const seen = new Set<string>();
  let last = 0;
  for (const h of hs) {
    if (h.text === '') out.push({ code: 'empty-heading', message: 'a heading has no text' });
    if (last > 0 && h.depth > last + 1) out.push({ code: 'skipped-level', message: `"${h.text}" jumps from level ${last} to level ${h.depth}`, heading: h.text });
    if (h.text && seen.has(h.text)) out.push({ code: 'duplicate-text', message: `"${h.text}" is used for more than one heading`, heading: h.text });
    seen.add(h.text);
    last = h.depth;
  }
  return out;
}

// ---------------------------------------------------------------- table of contents

export interface TocOptions {
  readonly maxDepth?: number;
  readonly ordered?: boolean;
  /** Prefix for the links, e.g. "/docs/page" to give "/docs/page#id". */
  readonly base?: string;
}

/** The table of contents as nested lists of links, every string escaped. */
export function tocHtml(headings: readonly Heading[], o: TocOptions = {}): string {
  const tag = o.ordered ? 'ol' : 'ul';
  const max = o.maxDepth ?? 6;
  const list = (hs: readonly Heading[]): string => {
    const items = hs.filter((h) => h.depth <= max).map((h) => {
      const kids = list(h.children);
      return `<li><a href="${escapeHtml(`${o.base ?? ''}#${encodeURIComponent(h.id)}`)}">${escapeHtml(h.text)}</a>${kids}</li>`;
    });
    return items.length ? `<${tag}>${items.join('')}</${tag}>` : '';
  };
  return list(headings);
}

/** The same as Markdown, indented two spaces per level of nesting. */
export function tocMarkdown(headings: readonly Heading[], o: TocOptions = {}): string {
  const max = o.maxDepth ?? 6;
  const esc = (s: string) => s.replace(/([\\[\]`*_])/g, '\\$1');
  const lines: string[] = [];
  const walkH = (hs: readonly Heading[], level: number) => {
    let n = 0;
    for (const h of hs) {
      if (h.depth > max) continue;
      lines.push(`${'  '.repeat(level)}${o.ordered ? `${++n}.` : '-'} [${esc(h.text)}](${o.base ?? ''}#${encodeURIComponent(h.id)})`);
      walkH(h.children, level + 1);
    }
  };
  walkH(headings, 0);
  return lines.join('\n');
}

// ---------------------------------------------------------------- sections

export interface Section {
  readonly heading: Heading;
  /** First and last source line of the section, from its heading to just before the next heading of the same or higher level. */
  readonly lines: { readonly from: number; readonly to: number };
  readonly words: number;
}

/** Each heading's section and its word count, from source text. */
export function sections(src: string): Section[] {
  const tree = parse(src);
  const o = outline(tree);
  const total = src.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').length;
  const blocks = tree.children ?? [];
  return o.flat.map((h, i) => {
    const from = h.position?.start.line ?? 1;
    const next = o.flat.slice(i + 1).find((x) => x.depth <= h.depth);
    const to = (next?.position?.start.line ?? total + 1) - 1;
    const own = blocks.filter((b) => b.type !== 'heading' && (b.position?.start.line ?? 0) > from && (b.position?.start.line ?? 0) <= to);
    return { heading: h, lines: { from, to }, words: own.reduce((n, b) => n + countWords(blockText(b)).words, 0) };
  });
}

/** The heading whose section contains a source line (for "you are here" while scrolling). */
export function headingAtLine(o: Outline, line: number): Heading | undefined {
  let best: Heading | undefined;
  for (const h of o.flat) if ((h.position?.start.line ?? Infinity) <= line) best = h;
  return best;
}

// ---------------------------------------------------------------- reading time and excerpt

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/u;

/** Words in a string: Unicode word segmentation for most scripts, one per character for CJK. */
export function countWords(s: string): { words: number; cjk: number } {
  let words = 0;
  let cjk = 0;
  const seg = new Intl.Segmenter(undefined, { granularity: 'word' });
  for (const part of seg.segment(s)) {
    if (!part.isWordLike) continue;
    if (CJK.test(part.segment)) cjk += [...part.segment].filter((c) => CJK.test(c)).length;
    else words++;
  }
  return { words, cjk };
}

function blockText(n: Node): string {
  if (n.type === 'code' || n.type === 'html' || n.type === 'footnoteDefinition') return '';
  if (n.type === 'table') return (n.children ?? []).map((r) => (r.children ?? []).map(textContent).join(' ')).join('\n');
  if (n.type === 'paragraph' || n.type === 'heading') return textContent(n);
  return (n.children ?? []).map(blockText).join('\n');
}

export interface ReadingTime {
  readonly minutes: number;
  readonly seconds: number;
  readonly words: number;
  readonly codeWords: number;
  readonly images: number;
  readonly label: string;
}

export interface ReadingOptions {
  /** Words per minute for prose (default 230). */
  readonly wordsPerMinute?: number;
  /** CJK characters per minute (default 450). */
  readonly cjkPerMinute?: number;
  /** Code is read at this fraction of prose speed (default 0.5). */
  readonly codeSpeed?: number;
}

/** How long a document takes to read, rounded up to whole minutes for the label. Each image costs 12 s, the next 11 s, down to 3 s. */
export function readingTime(src: string | Node, o: ReadingOptions = {}): ReadingTime {
  const tree = asTree(src);
  const wpm = o.wordsPerMinute ?? 230;
  const cpm = o.cjkPerMinute ?? 450;
  const codeSpeed = o.codeSpeed ?? 0.5;
  let words = 0, cjk = 0, codeWords = 0, images = 0;
  const visit = (n: Node) => {
    if (n.type === 'code') codeWords += countWords(n.value ?? '').words;
    else if (n.type === 'image') {
      images++;
      return;
    }
    else if (n.type === 'text' || n.type === 'inlineCode') {
      const c = countWords(n.value ?? '');
      words += c.words;
      cjk += c.cjk;
    }
    for (const c of n.children ?? []) visit(c);
  };
  visit(tree);
  let imageSeconds = 0;
  for (let i = 0; i < images; i++) imageSeconds += Math.max(3, 12 - i);
  const seconds = Math.round((words / wpm) * 60 + (cjk / cpm) * 60 + (codeWords / (wpm * codeSpeed)) * 60 + imageSeconds);
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return { minutes, seconds, words: words + cjk, codeWords, images, label: `${minutes} min read` };
}

export interface ExcerptOptions {
  /** Longest excerpt in characters (default 200). */
  readonly maxChars?: number;
  readonly ellipsis?: string;
}

/**
 * The opening of a document as plain text. Headings, code, tables, HTML and footnotes are skipped. A line holding only
 * `<!--more-->` ends the excerpt there. Otherwise the text is cut at the last sentence end that fits, or else at the
 * last space, or else at a whole character, and `…` is added when something was left out.
 */
export function excerpt(src: string | Node, o: ExcerptOptions = {}): string {
  const tree = asTree(src);
  const max = o.maxChars ?? 200;
  const ell = o.ellipsis ?? '…';
  const parts: string[] = [];
  let cut = false;
  for (const b of tree.children ?? []) {
    if (b.type === 'html' && /<!--\s*more\s*-->/i.test(b.value ?? '')) { cut = true; break; }
    const t = (b.type === 'paragraph' || b.type === 'blockquote' || b.type === 'list' ? blockText(b) : '').replace(/\s+/g, ' ').trim();
    if (t) parts.push(t);
    if (parts.join(' ').length > max * 3) break;
  }
  const all = parts.join(' ');
  if (all.length <= max) return cut ? (all ? all : '') : all;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(all.slice(0, max * 40))].map((g) => g.segment);
  const head = graphemes.slice(0, max).join('');
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (sentence >= max * 0.5) return head.slice(0, sentence + 1);
  const space = head.lastIndexOf(' ');
  return (space >= max * 0.5 ? head.slice(0, space) : head).replace(/[\s,;:—-]+$/, '') + ell;
}
