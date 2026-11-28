/**
 * Shortcodes: small bracketed tags that authors put in text and the application expands into markup, in the form
 * WordPress made familiar:
 *
 *     [gallery ids="1,2,3" columns=2]    [quote cite='Ann']Words[/quote]    [button "Buy now" primary /]
 *     [[gallery]]                        (escaped: shows the text [gallery])
 *
 * Only tags that have a registered handler are shortcodes; every other bracket is ordinary text, so prose with
 * brackets is never touched. Nesting works (an enclosing tag's content is expanded first and handed to its handler),
 * an opening tag with no closer is self-closing, and attributes are plain strings: named, positional and bare flags.
 *
 * The rules that make it safe to run on text people write:
 * - an allow-list: handlers are the only tags that run;
 * - limits on input length, tag count, nesting depth, attributes, attribute size and total output; going over one
 *   leaves the markup as written and reports it, it never loops;
 * - a handler's output is not scanned again unless that handler asks (and then only within the depth cap), so an
 *   attribute value cannot smuggle in another shortcode;
 * - a handler that throws is reported and its tag left as written (or dropped), and the rest of the text expands.
 *
 * Also here: `expandTags` for the simpler `{{name}}` short tags, with HTML escaping by default and a policy for
 * missing values; and `build`, which writes a shortcode back out with correct quoting.
 *
 * Not here: asynchronous handlers (expand first, fetch in the handler's caller), and the handlers themselves.
 */

export class LimitExceeded extends Error {
  constructor(what: string, limit: number) {
    super(`the text has more ${what} than the limit of ${limit}`);
    this.name = 'LimitExceeded';
  }
}
export class MissingValue extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`no value for {{${path}}}`);
    this.name = 'MissingValue';
    this.path = path;
  }
}

export interface Limits {
  readonly maxLength?: number;
  readonly maxShortcodes?: number;
  readonly maxDepth?: number;
  readonly maxAttributes?: number;
  readonly maxAttributeLength?: number;
  readonly maxOutput?: number;
}
const DEFAULTS = { maxLength: 500_000, maxShortcodes: 500, maxDepth: 5, maxAttributes: 50, maxAttributeLength: 4096, maxOutput: 2_000_000 };

export interface Text {
  readonly type: 'text';
  readonly value: string;
}
export interface Shortcode {
  readonly type: 'shortcode';
  readonly tag: string;
  /** Named attributes. */
  readonly attrs: Readonly<Record<string, string>>;
  /** Attributes without a name, in order; bare words (flags) are here too. */
  readonly positional: readonly string[];
  /** Nodes between the opening and closing tag; null when self-closing. */
  readonly content: readonly Node[] | null;
  /** The source text of the whole shortcode, as written. */
  readonly raw: string;
  /** The source text between the opening and closing tags. */
  readonly rawContent: string | null;
}
export type Node = Text | Shortcode;

interface Marker {
  kind: 'open' | 'close';
  tag: string;
  start: number;
  end: number;
  attrText: string;
  selfClosing: boolean;
  /** An extra [ before an opening tag, or an extra ] after a closing one: the escape form. */
  esc: boolean;
}

const NAME = /[A-Za-z0-9_-]/;
const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/** Every opening and closing marker of an allowed tag, in order. One linear pass. */
function markers(text: string, tags: ReadonlySet<string>): Marker[] {
  const out: Marker[] = [];
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('[', i);
    if (at < 0) break;
    let p = at + 1;
    let esc = false;
    if (text[p] === '[') {
      esc = true;
      p++;
    }
    const closing = text[p] === '/';
    if (closing) p++;
    let q = p;
    while (q < text.length && q - p <= 64 && NAME.test(text[q]!)) q++;
    const tag = text.slice(p, q);
    if (!tag || !tags.has(tag) || (closing && esc)) {
      i = at + 1;
      continue;
    }
    const t = text[q];
    if (!(t === ']' || t === '/' || isSpace(t))) {
      i = at + 1;
      continue;
    }
    // Scan to the closing bracket, respecting quotes; a bare [ inside is not allowed.
    let j = q;
    let quote = '';
    let ok = false;
    while (j < text.length) {
      const c = text[j]!;
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '[') break;
      else if (c === ']') {
        ok = true;
        break;
      }
      j++;
    }
    if (!ok) {
      i = at + 1;
      continue;
    }
    let attrText = text.slice(q, j);
    let selfClosing = false;
    if (!closing && attrText.trimEnd().endsWith('/')) {
      selfClosing = true;
      attrText = attrText.trimEnd().slice(0, -1);
    }
    if (closing && attrText.trim() !== '') {
      i = at + 1;
      continue;
    }
    let end = j + 1;
    let escClose = false;
    if (closing && text[end] === ']') {
      escClose = true;
      end++;
    }
    out.push({ kind: closing ? 'close' : 'open', tag, start: at, end, attrText, selfClosing, esc: closing ? escClose : esc });
    i = end;
  }
  return out;
}

/** Named and positional attributes from the text inside a tag. */
export function parseAttributes(s: string, o: { maxAttributes?: number; maxAttributeLength?: number } = {}): { attrs: Record<string, string>; positional: string[] } {
  const maxA = o.maxAttributes ?? DEFAULTS.maxAttributes;
  const maxL = o.maxAttributeLength ?? DEFAULTS.maxAttributeLength;
  const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
  const positional: string[] = [];
  let i = 0;
  let count = 0;
  const take = (v: string) => {
    if (v.length > maxL) throw new LimitExceeded('characters in one attribute', maxL);
    if (++count > maxA) throw new LimitExceeded('attributes', maxA);
    return v;
  };
  while (i < s.length) {
    while (isSpace(s[i])) i++;
    if (i >= s.length) break;
    const c = s[i]!;
    if (c === '"' || c === "'") {
      const end = s.indexOf(c, i + 1);
      const stop = end < 0 ? s.length : end;
      positional.push(take(s.slice(i + 1, stop)));
      i = stop + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !isSpace(s[j]) && s[j] !== '=') j++;
    const word = s.slice(i, j);
    let k = j;
    while (isSpace(s[k])) k++;
    if (s[k] === '=' && /^[A-Za-z0-9_:-]{1,64}$/.test(word)) {
      k++;
      while (isSpace(s[k])) k++;
      const q = s[k];
      let value: string;
      if (q === '"' || q === "'") {
        const end = s.indexOf(q, k + 1);
        const stop = end < 0 ? s.length : end;
        value = s.slice(k + 1, stop);
        i = stop + 1;
      } else {
        let e = k;
        while (e < s.length && !isSpace(s[e])) e++;
        value = s.slice(k, e);
        i = e;
      }
      if (word === '__proto__') continue;
      attrs[word] = take(value);
    } else {
      positional.push(take(word));
      i = j === i ? i + 1 : j;
    }
  }
  return { attrs: { ...attrs }, positional };
}

/** Reads text into plain text and shortcodes. Only tags in `tags` are shortcodes. */
export function parse(text: string, tags: Iterable<string>, limits: Limits = {}): Node[] {
  const L = { ...DEFAULTS, ...limits };
  if (typeof text !== 'string') throw new TypeError('the text must be a string');
  if (text.length > L.maxLength) throw new LimitExceeded('characters', L.maxLength);
  const allowed = new Set(tags);
  const ms = markers(text, allowed);
  if (ms.length > L.maxShortcodes * 2) throw new LimitExceeded('shortcodes', L.maxShortcodes);

  // Match closers to openers with a stack: an opener passed over by a closer of an outer tag is self-closing.
  interface Span { open: Marker; close: Marker | null; kids: Span[] }
  const roots: Span[] = [];
  const stack: Span[] = [];
  const add = (s: Span) => (stack.length ? stack[stack.length - 1]!.kids : roots).push(s);
  const literalSpans: [number, number, string][] = [];
  let shortcodes = 0;
  for (const m of ms) {
    if (m.kind === 'open') {
      if (m.esc && m.selfClosing) {
        literalSpans.push([m.start, m.end, text.slice(m.start + 1, m.end)]);
        continue;
      }
      if (m.esc && text[m.end] === ']') {
        // [[tag]] : the escape form of a self-closing tag.
        literalSpans.push([m.start, m.end + 1, text.slice(m.start + 1, m.end)]);
        continue;
      }
      if (++shortcodes > L.maxShortcodes) throw new LimitExceeded('shortcodes', L.maxShortcodes);
      const span: Span = { open: m, close: null, kids: [] };
      if (m.selfClosing) add(span);
      else stack.push(span);
    } else {
      let k = stack.length - 1;
      while (k >= 0 && stack[k]!.open.tag !== m.tag) k--;
      if (k < 0) continue;
      const span = stack[k]!;
      const passed = stack.splice(k);
      passed.shift();
      // Openers above the matched one have no closer: they become self-closing siblings inside it.
      for (const p of passed) span.kids.push(p, ...p.kids.splice(0));
      span.close = m;
      add(span);
    }
  }
  // Openers never closed are self-closing at their level.
  for (const s of stack) roots.push(s, ...s.kids.splice(0));
  roots.sort((a, b) => a.open.start - b.open.start);
  const flat = (spans: Span[]) => spans.sort((a, b) => a.open.start - b.open.start);

  const build = (from: number, to: number, spans: Span[], depth: number): Node[] => {
    const nodes: Node[] = [];
    let pos = from;
    const lits = literalSpans.filter(([s, e]) => s >= from && e <= to);
    const events = [
      ...flat(spans).map((s) => ({ at: s.open.start, span: s, lit: null as null | [number, number, string] })),
      ...lits.map((l) => ({ at: l[0], span: null as Span | null, lit: l as [number, number, string] | null })),
    ].sort((a, b) => a.at - b.at);
    const pushText = (s: string) => {
      if (!s) return;
      const last = nodes[nodes.length - 1];
      if (last && last.type === 'text') nodes[nodes.length - 1] = { type: 'text', value: last.value + s };
      else nodes.push({ type: 'text', value: s });
    };
    for (const ev of events) {
      if (ev.at < pos) continue;
      pushText(text.slice(pos, ev.at));
      if (ev.lit) {
        pushText(ev.lit[2]);
        pos = ev.lit[1];
        continue;
      }
      const span = ev.span!;
      const m = span.open;
      const end = span.close ? span.close.end : m.end;
      // The escape form [[tag]...[/tag]] shows the text between the outer brackets.
      if (m.esc) {
        if (span.close?.esc) {
          pushText(text.slice(m.start + 1, end - 1));
          pos = end;
          continue;
        }
        pushText(text.slice(m.start, m.end));
        pos = m.end;
        // The tag was not a shortcode after all; its inner spans still are.
        const inner = span.kids;
        if (inner.length) {
          const sub = build(m.end, span.close ? span.close.start : to, inner, depth);
          for (const n of sub) n.type === 'text' ? pushText(n.value) : nodes.push(n);
          pos = span.close ? span.close.start : to;
        }
        continue;
      }
      if (span.close?.esc) {
        pushText(text.slice(m.start, m.end));
        pos = m.end;
        continue;
      }
      const { attrs, positional } = parseAttributes(m.attrText, L);
      const inner = span.close ? build(m.end, span.close.start, span.kids, depth + 1) : null;
      nodes.push({
        type: 'shortcode',
        tag: m.tag,
        attrs,
        positional,
        content: inner,
        raw: text.slice(m.start, end),
        rawContent: span.close ? text.slice(m.end, span.close.start) : null,
      });
      pos = end;
    }
    pushText(text.slice(pos, to));
    return nodes;
  };
  literalSpans.sort((a, b) => a[0] - b[0]);
  return build(0, text.length, roots, 1);
}

// ---------------------------------------------------------------- expanding

export interface Context {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly positional: readonly string[];
  /** The expanded content (or the raw content for a raw handler); null when self-closing. */
  readonly content: string | null;
  readonly depth: number;
}
export interface Handler {
  readonly run: (ctx: Context) => string;
  /** Hand the content over exactly as written, without expanding shortcodes inside it. */
  readonly raw?: boolean;
  /** Expand shortcodes in this handler's output too (within the depth cap). Default false. */
  readonly rescan?: boolean;
}
export type Handlers = Readonly<Record<string, Handler | ((ctx: Context) => string)>>;

export interface ExpandOptions extends Limits {
  /** What to do with a shortcode whose handler throws or whose limit was hit: keep it as written, or drop it. Default keep. */
  readonly onError?: 'keep' | 'drop';
  /** Most handler calls in one text. Default 1000. */
  readonly maxExpansions?: number;
}
export interface Expanded {
  readonly text: string;
  readonly expansions: number;
  readonly errors: readonly { readonly tag: string; readonly message: string }[];
  /** True when the output limit stopped the expansion. */
  readonly truncated: boolean;
}

/** Expands the registered shortcodes in a text and reports what happened. */
export function expand(text: string, handlers: Handlers, o: ExpandOptions = {}): Expanded {
  const L = { ...DEFAULTS, ...o };
  const maxExpansions = o.maxExpansions ?? 1000;
  const errors: { tag: string; message: string }[] = [];
  let expansions = 0;
  let truncated = false;
  let produced = 0;
  const norm = (h: Handlers[string]): Handler => (typeof h === 'function' ? { run: h } : h);
  const names = Object.keys(handlers).filter((k) => Object.hasOwn(handlers, k));
  let nodes: Node[];
  try {
    nodes = parse(text, names, L);
  } catch (e) {
    if (!(e instanceof LimitExceeded)) throw e;
    return { text, expansions: 0, errors: [{ tag: '', message: e.message }], truncated: false };
  }
  const run = (list: readonly Node[], depth: number): string => {
    let out = '';
    for (const n of list) {
      if (truncated) break;
      let piece: string;
      if (n.type === 'text') piece = n.value;
      else {
        const h = norm(handlers[n.tag]!);
        if (depth > L.maxDepth) {
          errors.push({ tag: n.tag, message: `nesting deeper than ${L.maxDepth}` });
          piece = o.onError === 'drop' ? '' : n.raw;
        } else if (expansions >= maxExpansions) {
          errors.push({ tag: n.tag, message: `more than ${maxExpansions} expansions` });
          piece = o.onError === 'drop' ? '' : n.raw;
        } else {
          expansions++;
          try {
            const content = n.content === null ? null : h.raw ? (n.rawContent ?? '') : run(n.content, depth + 1);
            let r = h.run({ tag: n.tag, attrs: n.attrs, positional: n.positional, content, depth });
            if (typeof r !== 'string') throw new TypeError('a handler must return a string');
            if (h.rescan && depth < L.maxDepth) r = run(parse(r, names, L), depth + 1);
            piece = r;
          } catch (e) {
            errors.push({ tag: n.tag, message: e instanceof Error ? e.message : String(e) });
            piece = o.onError === 'drop' ? '' : n.raw;
          }
        }
      }
      if (produced + piece.length > L.maxOutput && depth === 1) {
        truncated = true;
        errors.push({ tag: '', message: `output longer than ${L.maxOutput} characters` });
        break;
      }
      out += piece;
      if (depth === 1) produced += piece.length;
    }
    return out;
  };
  const result = run(nodes, 1);
  return { text: truncated ? text : result, expansions, errors, truncated };
}

/** Whether the text uses the tag as a shortcode. */
export function has(text: string, tag: string): boolean {
  const walk = (list: readonly Node[]): boolean => list.some((n) => n.type === 'shortcode' && (n.tag === tag || (n.content ? walk(n.content) : false)));
  return walk(parse(text, [tag]));
}

/** The text with the listed shortcodes removed; `keepContent` keeps what was between an opening and closing tag. */
export function strip(text: string, tags: readonly string[], o: { keepContent?: boolean } = {}): string {
  const walk = (list: readonly Node[]): string => list.map((n) => (n.type === 'text' ? n.value : o.keepContent && n.content ? walk(n.content) : '')).join('');
  return walk(parse(text, tags));
}

/** A shortcode written out: attribute values are quoted with whichever quote the value does not contain. */
export function build(tag: string, attrs: Readonly<Record<string, string>> = {}, content?: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(tag)) throw new TypeError(`"${tag}" is not a shortcode name`);
  const parts = Object.entries(attrs).map(([k, v]) => {
    if (!/^[A-Za-z0-9_:-]{1,64}$/.test(k)) throw new TypeError(`"${k}" is not an attribute name`);
    if (/[\]\n\r]/.test(v)) throw new TypeError(`the value of "${k}" holds a ] or a line break, which cannot be written safely`);
    if (v.includes('"') && v.includes("'")) throw new TypeError(`the value of "${k}" holds both kinds of quote`);
    return `${k}=${v.includes('"') ? `'${v}'` : `"${v}"`}`;
  });
  const open = `[${[tag, ...parts].join(' ')}`;
  return content === undefined ? `${open} /]` : `${open}]${content}[/${tag}]`;
}

// ---------------------------------------------------------------- {{short}} tags

export const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export interface TagOptions {
  readonly open?: string;
  readonly close?: string;
  /** Applied to every value. Default: HTML escaping. Pass (s) => s only for text that is not markup. */
  readonly escape?: (s: string) => string;
  /** A name with no value: keep the tag as written, make it empty, or throw MissingValue. Default 'keep'. */
  readonly missing?: 'keep' | 'empty' | 'throw';
}

/**
 * Replaces {{name}} and {{user.name}} with values, escaped. A backslash before the opening marker keeps it as
 * written. Values are looked up as the object's own properties only, and must be text, numbers or booleans.
 */
export function expandTags(text: string, values: Readonly<Record<string, unknown>>, o: TagOptions = {}): string {
  const open = o.open ?? '{{';
  const close = o.close ?? '}}';
  const esc = o.escape ?? escapeHtml;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf(open, i);
    if (at < 0) break;
    if (at > 0 && text[at - 1] === '\\') {
      out += text.slice(i, at - 1) + open;
      i = at + open.length;
      continue;
    }
    const end = text.indexOf(close, at + open.length);
    const name = end < 0 ? '' : text.slice(at + open.length, end).trim();
    if (end < 0 || !/^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*){0,5}$/.test(name)) {
      out += text.slice(i, at + open.length);
      i = at + open.length;
      continue;
    }
    out += text.slice(i, at);
    let v: unknown = values;
    for (const part of name.split('.')) {
      v = typeof v === 'object' && v !== null && Object.hasOwn(v, part) ? (v as Record<string, unknown>)[part] : undefined;
    }
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out += esc(String(v));
    else if (o.missing === 'throw') throw new MissingValue(name);
    else if (o.missing === 'empty') out += '';
    else out += text.slice(at, end + close.length);
    i = end + close.length;
  }
  return out + text.slice(i);
}
