/**
 * Document chunking for retrieval: split a document by its structure first and by tokens second, with overlap,
 * and give every chunk an anchor back to the exact place in the source so an answer can cite it.
 *
 * How it cuts (markdown input, parsed with the markdown block; `format: 'text'` splits plain text on blank lines):
 *  1. A heading of depth `splitDepth` or shallower (default 3) starts a new section; a chunk never spans two
 *     sections unless the earlier one is under `minTokens`, in which case the small section is merged forward.
 *  2. Whole blocks (paragraphs, lists, tables, code blocks) are packed into a chunk until `maxTokens` is reached.
 *  3. A block too big for one chunk is cut at sentence ends (code blocks at line ends), then at words, then at
 *     characters as a last resort, never inside a UTF-16 pair.
 *  4. When a chunk ends because it is full (not because a section ended) the next chunk begins `overlapTokens`
 *     earlier, at a sentence start, so a fact on the seam appears whole in one of them.
 * Every chunk's text is a verbatim slice of the source, so `verifyAnchor` can prove an anchor still points at what
 * it cites, and `locateQuote` finds where a quoted passage lives. The token counter is an argument; the default
 * counts a token per four UTF-8 bytes, an approximation to replace with a real tokenizer for hard limits.
 *
 * Out of scope: embedding, storing, and splitting by meaning. YAML front matter is skipped, not chunked.
 */
import { createHash } from 'node:crypto';
import { headingIds, parse, type Node } from '../markdown/index.ts';

export class ChunkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChunkError';
  }
}

export type Counter = (text: string) => number;

/** A token per four UTF-8 bytes, rounded up. */
export const defaultCounter: Counter = (t) => Math.ceil(new TextEncoder().encode(t).length / 4);

export interface ChunkOptions {
  /** Most tokens in a chunk's text. */
  readonly maxTokens: number;
  /** Tokens repeated at the start of a chunk that continues a full one. Default 0. */
  readonly overlapTokens?: number;
  /** A section shorter than this is merged into the next one. Default 0. */
  readonly minTokens?: number;
  /** Headings of this depth or shallower start a new section. Default 3. */
  readonly splitDepth?: number;
  readonly format?: 'markdown' | 'text';
  readonly count?: Counter;
  /** Mixed into chunk ids so the same text in two documents has two ids. */
  readonly docId?: string;
  /** Longest document accepted, in characters. Default 5,000,000. */
  readonly maxChars?: number;
}

export interface Chunk {
  readonly index: number;
  /** A stable id from the document id, the range and the text. */
  readonly id: string;
  /** Verbatim slice of the source, overlap included. */
  readonly text: string;
  readonly tokens: number;
  /** Source offsets: start inclusive, end exclusive. */
  readonly start: number;
  readonly end: number;
  /** Where this chunk's own text begins; before it, up to `start`, is overlap repeated from the previous chunk. */
  readonly coreStart: number;
  /** 1-based lines of start and of the last character. */
  readonly startLine: number;
  readonly endLine: number;
  /** Headings above the chunk's start, outermost first. */
  readonly headingPath: readonly string[];
  /** The slug of the nearest heading, for a `#fragment` link; undefined before the first heading. */
  readonly headingId: string | undefined;
}

interface Atom {
  readonly start: number;
  readonly end: number;
  readonly headingDepth: number | undefined;
  readonly path: readonly string[];
  readonly headingId: string | undefined;
}

const SENTENCE_END = /(?<=[.!?。！？]["'”’)\]]*)\s+(?=\S)|\n+/g;

/** Offsets where a new sentence (or line) starts inside text, always beginning with 0. */
function boundaries(text: string, mode: 'prose' | 'code'): number[] {
  const out = [0];
  if (mode === 'code') {
    for (let i = 0; i < text.length; i++) if (text[i] === '\n' && i + 1 < text.length) out.push(i + 1);
    return out;
  }
  for (const m of text.matchAll(SENTENCE_END)) {
    const at = m.index + m[0].length;
    if (at < text.length) out.push(at);
  }
  return out;
}

const cpSafe = (s: string, i: number): number => (i > 0 && i < s.length && /[\uDC00-\uDFFF]/.test(s[i]!) && /[\uD800-\uDBFF]/.test(s[i - 1]!) ? i - 1 : i);

/** Cut a range that is too big for one chunk into pieces that each fit, by sentence, then word, then character. */
function cutBig(src: string, start: number, end: number, max: number, count: Counter, mode: 'prose' | 'code'): [number, number][] {
  const out: [number, number][] = [];
  const text = src.slice(start, end);
  const marks = [...boundaries(text, mode), text.length];
  let from = 0;
  const flushTo = (to: number) => {
    const trimmed = text.slice(from, to).replace(/\s+$/, '').length;
    if (trimmed > 0) out.push([start + from, start + from + trimmed]);
    from = to;
  };
  let i = 0;
  while (i < marks.length - 1) {
    const unitEnd = marks[i + 1]!;
    if (count(text.slice(from, unitEnd)) <= max) {
      i++;
      continue;
    }
    if (marks[i]! > from) {
      flushTo(marks[i]!);
      continue;
    }
    // a single unit is too big: cut it by words, then characters
    const unit = text.slice(from, unitEnd);
    let off = 0;
    while (off < unit.length) {
      let lo = 1;
      let hi = unit.length - off;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (count(unit.slice(off, cpSafe(unit, off + mid))) <= max) lo = mid;
        else hi = mid - 1;
      }
      let cut = cpSafe(unit, off + lo);
      if (cut <= off) cut = Math.min(unit.length, off + 2);
      if (cut < unit.length) {
        const sp = unit.lastIndexOf(' ', cut - 1);
        if (sp > off + (cut - off) / 2) cut = sp + 1;
      }
      out.push([start + from + off, start + from + cut]);
      off = cut;
    }
    from = unitEnd;
    i++;
  }
  flushTo(text.length);
  return out;
}

function frontMatterEnd(src: string): number {
  const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  return m ? m[0].length : 0;
}

function atomsOf(src: string, o: Required<Pick<ChunkOptions, 'maxTokens' | 'format'>> & { count: Counter }): Atom[] {
  const fm = o.format === 'markdown' ? frontMatterEnd(src) : 0;
  const body = src.slice(fm);
  const lineStart: number[] = [0];
  for (let i = 0; i < body.length; i++) if (body[i] === '\n') lineStart.push(i + 1);
  const atoms: Atom[] = [];
  const split = (start: number, end: number, mode: 'prose' | 'code'): [number, number][] => (o.count(src.slice(start, end)) <= o.maxTokens ? [[start, end]] : cutBig(src, start, end, o.maxTokens, o.count, mode));
  if (o.format === 'text') {
    for (const m of body.matchAll(/\S[\s\S]*?(?=\n[ \t]*\n|\s*$)/g)) {
      for (const [s, e] of split(fm + m.index, fm + m.index + m[0].replace(/\s+$/, '').length, 'prose')) atoms.push({ start: s, end: e, headingDepth: undefined, path: [], headingId: undefined });
    }
    return atoms;
  }
  const tree = parse(body, { gfm: true, maxLength: Math.max(body.length, 1) });
  const heads = headingIds(tree);
  const stack: { depth: number; text: string }[] = [];
  let hi = 0;
  const headIdOf = new Map<Node, string>(heads.map((h) => [h, h.id!]));
  let currentId: string | undefined;
  for (const n of tree.children ?? []) {
    if (!n.position) continue;
    let start = fm + lineStart[n.position.start.line - 1]!;
    let end = fm + (lineStart[n.position.end.line] ?? body.length + 1) - 1;
    if (end > src.length) end = src.length;
    while (end > start && /\s/.test(src[end - 1]!)) end--;
    if (end <= start) continue;
    let depth: number | undefined;
    if (n.type === 'heading') {
      depth = n.depth ?? 1;
      const text = src.slice(start, end).replace(/^#{1,6}[ \t]*/, '').replace(/[ \t]*#*[ \t]*$/, '').split('\n')[0]!.trim();
      while (stack.length && stack[stack.length - 1]!.depth >= depth) stack.pop();
      stack.push({ depth, text });
      currentId = headIdOf.get(n) ?? heads[hi]?.id;
      hi++;
    }
    const path = stack.map((s) => s.text);
    for (const [s, e] of split(start, end, n.type === 'code' ? 'code' : 'prose')) {
      atoms.push({ start: s, end: e, headingDepth: s === start ? depth : undefined, path, headingId: currentId });
      start = e;
    }
  }
  return atoms;
}

/** Split a document into chunks. */
export function chunk(source: string, o: ChunkOptions): Chunk[] {
  const max = o.maxTokens;
  if (!Number.isInteger(max) || max < 1) throw new ChunkError('maxTokens must be a whole number from 1');
  const overlap = o.overlapTokens ?? 0;
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= max) throw new ChunkError('overlapTokens must be a whole number from 0 and less than maxTokens');
  const minTokens = o.minTokens ?? 0;
  if (!Number.isInteger(minTokens) || minTokens < 0 || minTokens >= max) throw new ChunkError('minTokens must be a whole number from 0 and less than maxTokens');
  if (source.length > (o.maxChars ?? 5_000_000)) throw new ChunkError(`a document over ${o.maxChars ?? 5_000_000} characters`);
  const count = o.count ?? defaultCounter;
  const splitDepth = o.splitDepth ?? 3;
  const atoms = atomsOf(source, { maxTokens: max, format: o.format ?? 'markdown', count });
  const lineAt = (offset: number): number => {
    let n = 1;
    for (let i = source.indexOf('\n'); i >= 0 && i < offset; i = source.indexOf('\n', i + 1)) n++;
    return n;
  };
  const out: Chunk[] = [];
  const emit = (start: number, end: number, coreStart: number, first: Atom) => {
    const text = source.slice(start, end);
    const id = createHash('sha256').update(`${o.docId ?? ''}\0${start}\0${end}\0${text}`).digest('hex').slice(0, 16);
    out.push({
      index: out.length,
      id,
      text,
      tokens: count(text),
      start,
      end,
      coreStart,
      startLine: lineAt(start),
      endLine: lineAt(Math.max(start, end - 1)),
      headingPath: first.path,
      headingId: first.headingId,
    });
  };
  const overlapStart = (from: number, to: number): number | undefined => {
    if (overlap === 0) return undefined;
    const cands = new Set<number>();
    for (const b of boundaries(source.slice(from, to), 'prose')) cands.add(from + b);
    for (const a of atoms) if (a.start > from && a.start < to) cands.add(a.start);
    return [...cands].filter((c) => c > from && count(source.slice(c, to)) <= overlap).sort((a, b) => a - b)[0];
  };
  let i = 0;
  while (i < atoms.length) {
    const first = atoms[i]!;
    let start = first.start;
    let coreStart = first.start;
    const prev = out[out.length - 1];
    const sameSection = prev !== undefined && !(first.headingDepth !== undefined && first.headingDepth <= splitDepth);
    if (sameSection && prev.end <= first.start) {
      let os = overlapStart(prev.coreStart, prev.end);
      while (os !== undefined && count(source.slice(os, first.end)) > max) os = overlapStart(os, prev.end);
      if (os !== undefined) start = os;
    }
    let end = first.end;
    i++;
    while (i < atoms.length) {
      const a = atoms[i]!;
      const startsSection = a.headingDepth !== undefined && a.headingDepth <= splitDepth;
      if (startsSection && count(source.slice(coreStart, end)) >= minTokens) break;
      if (count(source.slice(start, a.end)) > max) break;
      end = a.end;
      i++;
    }
    emit(start, end, coreStart, first);
  }
  return out;
}

export interface Citation {
  readonly docId: string | undefined;
  readonly chunkId: string;
  /** `doc#heading-slug:L12-L30`, a stable reference to put next to an answer. */
  readonly ref: string;
  readonly headingPath: readonly string[];
  readonly start: number;
  readonly end: number;
  readonly startLine: number;
  readonly endLine: number;
  /** The first 120 characters, so a reader can recognise the place. */
  readonly quote: string;
}

export function cite(c: Chunk, docId?: string): Citation {
  return {
    docId,
    chunkId: c.id,
    ref: `${docId ?? ''}${c.headingId ? `#${c.headingId}` : ''}:L${c.startLine}-L${c.endLine}`,
    headingPath: c.headingPath,
    start: c.start,
    end: c.end,
    startLine: c.startLine,
    endLine: c.endLine,
    quote: c.text.replace(/\s+/g, ' ').trim().slice(0, 120),
  };
}

/** True when the chunk's anchor still points at exactly the text it holds; false once the source has changed. */
export function verifyAnchor(source: string, c: Pick<Chunk, 'start' | 'end' | 'text'>): boolean {
  return c.start >= 0 && c.end <= source.length && source.slice(c.start, c.end) === c.text;
}

/** Where a quoted passage sits in the source: exact first, then ignoring differences in white space. */
export function locateQuote(source: string, quote: string): { start: number; end: number; line: number } | undefined {
  const q = quote.trim();
  if (q === '') return undefined;
  const lineOf = (off: number) => source.slice(0, off).split('\n').length;
  const at = source.indexOf(q);
  if (at >= 0) return { start: at, end: at + q.length, line: lineOf(at) };
  const words = q.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (words.length > 2000) return undefined;
  const m = new RegExp(words.join('\\s+')).exec(source);
  return m ? { start: m.index, end: m.index + m[0].length, line: lineOf(m.index) } : undefined;
}

/** The chunk that holds an offset's own text (not just overlap). */
export function chunkAt(chunks: readonly Chunk[], offset: number): Chunk | undefined {
  return chunks.find((c) => offset >= c.coreStart && offset < c.end);
}
