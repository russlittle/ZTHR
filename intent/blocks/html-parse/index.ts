/**
 * A tolerant HTML reader. It turns any text, however broken, into a tree of elements, text, comments and a doctype,
 * following the tokenising rules of the WHATWG HTML Standard (named and numeric character references, raw text in
 * script and style, escapable raw text in title and textarea, bogus comments for stray markup, the first of two
 * duplicate attributes winning, a tag cut off by the end of input dropped) and the parts of its tree-building rules
 * that matter for fragments: void elements, paragraphs ended by block starts, list items, definition items, table
 * cells and rows, options and headings that end their predecessors, and end tags that close the nearest open match
 * but never reach across a table cell or similar boundary. It then offers what the sanitiser, the extractor and the
 * differ above it need: a selector subset (type, #id, .class, attributes with = ~= |= ^= $= *=, descendant, child,
 * next and later sibling, :first-child, :last-child, :only-child, :empty, :nth-child, :not), text content, a
 * serialiser that escapes what must be escaped so output re-parses to the same tree, and a structural diff.
 *
 * Hostile input is bounded, not trusted: input size, nesting depth, node count and attributes per tag have limits and
 * exceeding one throws LimitExceeded; everything is a linear scan with no backtracking patterns.
 *
 * Not here: the full HTML5 tree constructor (no implied html, head and body; no reconstruction of misnested
 * formatting elements, so `<b><i></b></i>` closes both at the first end tag and drops the second); foreign content
 * is kept as ordinary elements with self-closing tags honoured inside svg and math; the full table of 2231 named
 * character references (the common ones are here, an unknown name is left as written); scripting, CSS and layout.
 */

export class LimitExceeded extends Error {
  constructor(what: string, limit: number) {
    super(`the markup has more ${what} than the limit of ${limit}`);
    this.name = 'LimitExceeded';
  }
}

export class InvalidSelector extends Error {
  constructor(selector: string, why: string) {
    super(`"${selector}" is not a supported selector: ${why}`);
    this.name = 'InvalidSelector';
  }
}

export interface Attr {
  name: string;
  value: string;
}
export interface Element {
  readonly type: 'element';
  tag: string;
  attrs: Attr[];
  children: Node[];
  parent: Element | Document | null;
}
export interface Text {
  readonly type: 'text';
  value: string;
  parent: Element | Document | null;
}
export interface Comment {
  readonly type: 'comment';
  value: string;
  parent: Element | Document | null;
}
export interface Doctype {
  readonly type: 'doctype';
  name: string;
  parent: Element | Document | null;
}
export interface Document {
  readonly type: 'document';
  children: Node[];
  parent: null;
}
export type Node = Element | Text | Comment | Doctype;
export type Parent = Element | Document;

export interface Limits {
  readonly maxLength?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxAttributes?: number;
}
const DEFAULTS = { maxLength: 5_000_000, maxDepth: 512, maxNodes: 1_000_000, maxAttributes: 256 };

// ---------------------------------------------------------------- character references

const NAMED: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', middot: '·', bull: '•',
  deg: '°', plusmn: '±', times: '×', divide: '÷', frac12: '½', frac14: '¼', frac34: '¾',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', hearts: '♥', check: '✓', eacute: 'é', egrave: 'è',
  agrave: 'à', aacute: 'á', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', ntilde: 'ñ', ccedil: 'ç',
  shy: '­', zwj: '‍', zwnj: '‌', ensp: ' ', emsp: ' ', thinsp: ' ',
};
/** Numeric references 0x80-0x9F mean the Windows-1252 characters, as browsers read them. */
const C1: Readonly<Record<number, number>> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039,
  0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122,
  0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '�';
  return String.fromCodePoint(C1[n] ?? n);
}

/** Decodes character references in text or an attribute value. An unknown or unfinished reference stays as written. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const amp = s.indexOf('&', i);
    if (amp < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, amp);
    const semi = s.indexOf(';', amp);
    const ref = semi > amp && semi - amp <= 32 ? s.slice(amp + 1, semi) : '';
    let rep: string | undefined;
    if (ref.startsWith('#x') || ref.startsWith('#X')) rep = /^[0-9a-fA-F]{1,8}$/.test(ref.slice(2)) ? codePoint(parseInt(ref.slice(2), 16)) : undefined;
    else if (ref.startsWith('#')) rep = /^\d{1,9}$/.test(ref.slice(1)) ? codePoint(Number(ref.slice(1))) : undefined;
    else if (ref) rep = Object.hasOwn(NAMED, ref) ? NAMED[ref] : undefined;
    if (rep === undefined) {
      out += '&';
      i = amp + 1;
    } else {
      out += rep;
      i = semi + 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------- tokenizer

export type Token =
  | { readonly kind: 'start'; readonly tag: string; readonly attrs: readonly Attr[]; readonly selfClosing: boolean }
  | { readonly kind: 'end'; readonly tag: string }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'comment'; readonly value: string }
  | { readonly kind: 'doctype'; readonly name: string };

const RAW = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes']);
const ESCAPABLE_RAW = new Set(['textarea', 'title']);
const isAlpha = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/** The tokens of a text. Limits on length and attributes apply. */
export function tokenize(input: string, limits: Limits = {}): Token[] {
  const L = { ...DEFAULTS, ...limits };
  if (typeof input !== 'string') throw new TypeError('the markup must be a string');
  if (input.length > L.maxLength) throw new LimitExceeded('characters', L.maxLength);
  const out: Token[] = [];
  const lower = input.toLowerCase();
  const n = input.length;
  let i = 0;
  let textStart = 0;
  const flush = (end: number) => {
    if (end > textStart) out.push({ kind: 'text', value: decodeEntities(input.slice(textStart, end)) });
  };
  while (i < n) {
    const lt = input.indexOf('<', i);
    if (lt < 0) break;
    const c1 = input[lt + 1];
    if (c1 === '!') {
      flush(lt);
      if (input.startsWith('<!--', lt)) {
        let end = input.indexOf('-->', lt + 4);
        if (input.startsWith('<!-->', lt)) end = lt + 2;
        if (input.startsWith('<!--->', lt)) end = lt + 3;
        const stop = end < 0 ? n : end;
        out.push({ kind: 'comment', value: input.slice(lt + 4, Math.max(lt + 4, stop)) });
        i = end < 0 ? n : end + 3;
      } else if (lower.startsWith('<!doctype', lt)) {
        const gt = input.indexOf('>', lt);
        const body = input.slice(lt + 9, gt < 0 ? n : gt).trim();
        out.push({ kind: 'doctype', name: (body.split(/\s+/)[0] ?? '').toLowerCase() });
        i = gt < 0 ? n : gt + 1;
      } else {
        const gt = input.indexOf('>', lt);
        out.push({ kind: 'comment', value: input.slice(lt + 2, gt < 0 ? n : gt) });
        i = gt < 0 ? n : gt + 1;
      }
      textStart = i;
      continue;
    }
    if (c1 === '?') {
      flush(lt);
      const gt = input.indexOf('>', lt);
      out.push({ kind: 'comment', value: input.slice(lt + 1, gt < 0 ? n : gt) });
      i = textStart = gt < 0 ? n : gt + 1;
      continue;
    }
    if (c1 === '/') {
      const c2 = input[lt + 2];
      if (c2 !== undefined && isAlpha(c2)) {
        flush(lt);
        let j = lt + 2;
        while (j < n && !isSpace(input[j]) && input[j] !== '>' && input[j] !== '/') j++;
        const gt = input.indexOf('>', j);
        out.push({ kind: 'end', tag: lower.slice(lt + 2, j) });
        i = textStart = gt < 0 ? n : gt + 1;
        continue;
      }
      if (c2 === '>') {
        flush(lt);
        i = textStart = lt + 3;
        continue;
      }
      if (c2 !== undefined) {
        flush(lt);
        const gt = input.indexOf('>', lt);
        out.push({ kind: 'comment', value: input.slice(lt + 2, gt < 0 ? n : gt) });
        i = textStart = gt < 0 ? n : gt + 1;
        continue;
      }
      i = lt + 2;
      continue;
    }
    if (c1 !== undefined && isAlpha(c1)) {
      let j = lt + 1;
      while (j < n && !isSpace(input[j]) && input[j] !== '>' && input[j] !== '/') j++;
      const tag = lower.slice(lt + 1, j);
      const attrs: Attr[] = [];
      let selfClosing = false;
      let closed = false;
      while (j < n) {
        while (j < n && (isSpace(input[j]) || input[j] === '/')) {
          if (input[j] === '/' && input[j + 1] === '>') selfClosing = true;
          j++;
        }
        if (input[j] === '>') {
          closed = true;
          j++;
          break;
        }
        if (j >= n) break;
        let k = j + 1;
        while (k < n && !isSpace(input[k]) && input[k] !== '=' && input[k] !== '>' && input[k] !== '/') k++;
        const name = lower.slice(j, k);
        j = k;
        while (isSpace(input[j])) j++;
        let value = '';
        if (input[j] === '=') {
          j++;
          while (isSpace(input[j])) j++;
          const q = input[j];
          if (q === '"' || q === "'") {
            const end = input.indexOf(q, j + 1);
            if (end < 0) {
              j = n;
              break;
            }
            value = decodeEntities(input.slice(j + 1, end));
            j = end + 1;
          } else {
            let e = j;
            while (e < n && !isSpace(input[e]) && input[e] !== '>') e++;
            value = decodeEntities(input.slice(j, e));
            j = e;
          }
        }
        if (!attrs.some((a) => a.name === name)) {
          if (attrs.length >= L.maxAttributes) throw new LimitExceeded('attributes on one tag', L.maxAttributes);
          attrs.push({ name, value });
        }
        selfClosing = false;
      }
      flush(lt);
      if (!closed) {
        // The input ended inside the tag: the tag is dropped, as browsers do.
        i = textStart = n;
        break;
      }
      out.push({ kind: 'start', tag, attrs, selfClosing });
      i = textStart = j;
      if (RAW.has(tag) || ESCAPABLE_RAW.has(tag)) {
        let from = i;
        let at = -1;
        while (from <= n) {
          const p = lower.indexOf(`</${tag}`, from);
          if (p < 0) break;
          const after = input[p + 2 + tag.length];
          if (after === undefined || isSpace(after) || after === '>' || after === '/') {
            at = p;
            break;
          }
          from = p + 2;
        }
        const end = at < 0 ? n : at;
        if (end > i) {
          const raw = input.slice(i, end);
          out.push({ kind: 'text', value: ESCAPABLE_RAW.has(tag) ? decodeEntities(raw) : raw });
        }
        i = textStart = end;
      }
      continue;
    }
    i = lt + 1;
  }
  flush(n);
  return out;
}

// ---------------------------------------------------------------- tree builder

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul', 'li', 'dd', 'dt']);
const SCOPE = new Set(['html', 'table', 'td', 'th', 'caption', 'template', 'object', 'applet', 'marquee', 'button', 'svg', 'math']);
const HEADING = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** Starting the key ends an open one of these, looking down to the first boundary. */
const IMPLIED: Readonly<Record<string, { closes: readonly string[]; stop: readonly string[] }>> = {
  li: { closes: ['li'], stop: ['ul', 'ol', 'menu'] },
  dd: { closes: ['dd', 'dt'], stop: ['dl'] },
  dt: { closes: ['dd', 'dt'], stop: ['dl'] },
  option: { closes: ['option'], stop: ['select', 'datalist'] },
  optgroup: { closes: ['option', 'optgroup'], stop: ['select'] },
  tr: { closes: ['tr', 'td', 'th'], stop: ['table'] },
  td: { closes: ['td', 'th'], stop: ['table', 'tr'] },
  th: { closes: ['td', 'th'], stop: ['table', 'tr'] },
  thead: { closes: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], stop: ['table'] },
  tbody: { closes: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], stop: ['table'] },
  tfoot: { closes: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], stop: ['table'] },
};

/** Reads a fragment of HTML into a tree. Never throws on malformed markup; throws LimitExceeded on hostile size. */
export function parse(input: string, limits: Limits = {}): Document {
  const L = { ...DEFAULTS, ...limits };
  if (L.maxDepth > 5000) throw new RangeError('maxDepth above 5000 is not allowed: the walkers are recursive');
  const doc: Document = { type: 'document', children: [], parent: null };
  const stack: Element[] = [];
  let nodes = 0;
  const top = (): Parent => stack[stack.length - 1] ?? doc;
  const add = (node: Node) => {
    if (++nodes > L.maxNodes) throw new LimitExceeded('nodes', L.maxNodes);
    const p = top();
    node.parent = p;
    p.children.push(node);
  };
  const popTo = (idx: number) => {
    stack.length = idx;
  };
  const foreign = () => stack.some((e) => e.tag === 'svg' || e.tag === 'math');
  const closeP = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const t = stack[i]!.tag;
      if (t === 'p') return popTo(i);
      if (SCOPE.has(t)) return;
    }
  };

  for (const t of tokenize(input, limits)) {
    switch (t.kind) {
      case 'text': {
        const p = top();
        const last = p.children[p.children.length - 1];
        if (last && last.type === 'text') last.value += t.value;
        else add({ type: 'text', value: t.value, parent: null });
        break;
      }
      case 'comment':
        add({ type: 'comment', value: t.value, parent: null });
        break;
      case 'doctype':
        add({ type: 'doctype', name: t.name, parent: null });
        break;
      case 'start': {
        if (CLOSES_P.has(t.tag)) closeP();
        if (HEADING.has(t.tag) && stack.length && HEADING.has(stack[stack.length - 1]!.tag)) stack.pop();
        const rule = IMPLIED[t.tag];
        if (rule) {
          let found = -1;
          for (let i = stack.length - 1; i >= 0; i--) {
            const name = stack[i]!.tag;
            if (rule.closes.includes(name)) found = i;
            else if (rule.stop.includes(name) || SCOPE.has(name)) break;
          }
          if (found >= 0) popTo(found);
        }
        const el: Element = { type: 'element', tag: t.tag, attrs: t.attrs.map((a) => ({ ...a })), children: [], parent: null };
        add(el);
        if (VOID.has(t.tag) || (t.selfClosing && (foreign() || t.tag === 'svg' || t.tag === 'math'))) break;
        if (stack.length >= L.maxDepth) throw new LimitExceeded('levels of nesting', L.maxDepth);
        stack.push(el);
        break;
      }
      case 'end': {
        if (t.tag === 'br') {
          add({ type: 'element', tag: 'br', attrs: [], children: [], parent: null });
          break;
        }
        if (t.tag === 'p' && !stack.some((e) => e.tag === 'p')) {
          add({ type: 'element', tag: 'p', attrs: [], children: [], parent: null });
          break;
        }
        for (let i = stack.length - 1; i >= 0; i--) {
          const name = stack[i]!.tag;
          if (name === t.tag) {
            popTo(i);
            break;
          }
          if (SCOPE.has(name)) break;
        }
        break;
      }
    }
  }
  return doc;
}

// ---------------------------------------------------------------- walking and reading

/** Every node below `root`, in document order. */
export function* walk(root: Parent): Generator<Node> {
  const todo: Node[] = [...root.children].reverse();
  while (todo.length) {
    const n = todo.pop()!;
    yield n;
    if (n.type === 'element') for (let i = n.children.length - 1; i >= 0; i--) todo.push(n.children[i]!);
  }
}

export function attr(el: Element, name: string): string | undefined {
  const lc = name.toLowerCase();
  return el.attrs.find((a) => a.name === lc)?.value;
}

/** The text a node holds, comments left out. */
export function text(node: Node | Document): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'comment' || node.type === 'doctype') return '';
  let s = '';
  for (const n of walk(node)) if (n.type === 'text') s += n.value;
  return s;
}

export function elements(root: Parent): Element[] {
  const out: Element[] = [];
  for (const n of walk(root)) if (n.type === 'element') out.push(n);
  return out;
}

// ---------------------------------------------------------------- selectors

type AttrOp = '' | '=' | '~=' | '|=' | '^=' | '$=' | '*=';
interface Simple {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: { name: string; op: AttrOp; value: string; ci: boolean }[];
  pseudos: ({ name: 'first-child' | 'last-child' | 'only-child' | 'empty' } | { name: 'nth-child'; a: number; b: number } | { name: 'not'; inner: Simple[][] })[];
}
interface Compound {
  simple: Simple;
  /** How this compound relates to the one before it. */
  combinator: ' ' | '>' | '+' | '~' | null;
}
type Complex = Compound[];

const IDENT = /^-?[_a-zA-Z -￿][\w -￿-]*/;

function parseNth(arg: string, sel: string): { a: number; b: number } {
  const s = arg.trim().toLowerCase().replace(/\s+/g, '');
  if (s === 'odd') return { a: 2, b: 1 };
  if (s === 'even') return { a: 2, b: 0 };
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(s);
  if (m) {
    const a = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : Number(m[1]);
    return { a, b: m[2] ? Number(m[2]) : 0 };
  }
  if (/^[+-]?\d+$/.test(s)) return { a: 0, b: Number(s) };
  throw new InvalidSelector(sel, `:nth-child(${arg}) is not understood`);
}

function parseSelectorList(sel: string, depth = 0): Complex[] {
  if (depth > 3) throw new InvalidSelector(sel, ':not nested too deeply');
  if (sel.length > 2000) throw new InvalidSelector(sel.slice(0, 20) + '...', 'too long');
  const lists: Complex[] = [];
  let cur: Complex = [];
  let simple: Simple | null = null;
  let pending: Compound['combinator'] = null;
  let i = 0;
  const endCompound = () => {
    if (simple) {
      cur.push({ simple, combinator: cur.length ? (pending ?? ' ') : null });
      simple = null;
      pending = null;
    }
  };
  const need = (): Simple => (simple ??= { classes: [], attrs: [], pseudos: [] });
  const fail = (why: string): never => {
    throw new InvalidSelector(sel, why);
  };
  while (i < sel.length) {
    const ch = sel[i]!;
    if (isSpace(ch)) {
      let j = i;
      while (isSpace(sel[j])) j++;
      const nx = sel[j];
      if (simple && nx !== undefined && !'>+~,'.includes(nx)) {
        endCompound();
        pending = ' ';
      }
      i = j;
      continue;
    }
    if (ch === ',') {
      if (!simple) fail('an empty selector before a comma');
      endCompound();
      lists.push(cur);
      cur = [];
      i++;
      continue;
    }
    if ('>+~'.includes(ch)) {
      if (!simple && !cur.length) fail(`"${ch}" with nothing before it`);
      endCompound();
      if (!cur.length) fail('a combinator with nothing before it');
      pending = ch as '>' | '+' | '~';
      i++;
      continue;
    }
    if (ch === '*') {
      need();
      i++;
      continue;
    }
    if (ch === '#' || ch === '.') {
      const m = IDENT.exec(sel.slice(i + 1));
      if (!m) fail(`a name must follow "${ch}"`);
      if (ch === '#') need().id = m![0];
      else need().classes.push(m![0]);
      i += 1 + m![0].length;
      continue;
    }
    if (ch === '[') {
      const end = sel.indexOf(']', i);
      if (end < 0) fail('unclosed [');
      const inner = sel.slice(i + 1, end);
      const m = /^\s*([^\s=~|^$*\]]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]"']+))\s*(i|I)?)?\s*$/.exec(inner);
      if (!m) fail(`cannot read [${inner}]`);
      need().attrs.push({ name: m![1]!.toLowerCase(), op: (m![2] ?? '') as AttrOp, value: m![3] ?? m![4] ?? m![5] ?? '', ci: m![6] !== undefined });
      i = end + 1;
      continue;
    }
    if (ch === ':') {
      const m = /^:([a-z-]+)(\()?/.exec(sel.slice(i));
      if (!m) fail('a name must follow ":"');
      const name = m![1]!;
      let arg = '';
      let len = m![0].length;
      if (m![2]) {
        let d = 1;
        let j = i + len;
        while (j < sel.length && d > 0) {
          if (sel[j] === '(') d++;
          else if (sel[j] === ')') d--;
          j++;
        }
        if (d) fail('unclosed (');
        arg = sel.slice(i + len, j - 1);
        len = j - i;
      }
      const s = need();
      if (name === 'first-child' || name === 'last-child' || name === 'only-child' || name === 'empty') s.pseudos.push({ name });
      else if (name === 'nth-child') s.pseudos.push({ name, ...parseNth(arg, sel) });
      else if (name === 'not') s.pseudos.push({ name, inner: parseSelectorList(arg, depth + 1).map((c) => c.map((x) => x.simple)) });
      else fail(`:${name} is not supported`);
      i += len;
      continue;
    }
    const m = IDENT.exec(sel.slice(i));
    if (!m) fail(`unexpected "${ch}"`);
    if (simple) fail('a tag name must come first in a compound selector');
    need().tag = m![0].toLowerCase();
    i += m![0].length;
  }
  if (!simple && (pending === '>' || pending === '+' || pending === '~')) fail('a combinator with nothing after it');
  endCompound();
  if (!cur.length) fail('empty selector');
  lists.push(cur);
  return lists;
}

function siblings(el: Element): Element[] {
  return (el.parent?.children ?? [el]).filter((n): n is Element => n.type === 'element');
}

function matchSimple(s: Simple, el: Element): boolean {
  if (s.tag && el.tag !== s.tag) return false;
  if (s.id !== undefined && attr(el, 'id') !== s.id) return false;
  if (s.classes.length) {
    const have = (attr(el, 'class') ?? '').split(/\s+/);
    if (!s.classes.every((c) => have.includes(c))) return false;
  }
  for (const a of s.attrs) {
    const v0 = attr(el, a.name);
    if (v0 === undefined) return false;
    if (a.op === '') continue;
    const v = a.ci ? v0.toLowerCase() : v0;
    const w = a.ci ? a.value.toLowerCase() : a.value;
    const ok =
      a.op === '=' ? v === w
      : a.op === '~=' ? w !== '' && !/\s/.test(w) && v.split(/\s+/).includes(w)
      : a.op === '|=' ? v === w || v.startsWith(w + '-')
      : a.op === '^=' ? w !== '' && v.startsWith(w)
      : a.op === '$=' ? w !== '' && v.endsWith(w)
      : w !== '' && v.includes(w);
    if (!ok) return false;
  }
  for (const p of s.pseudos) {
    if (p.name === 'first-child' && siblings(el)[0] !== el) return false;
    if (p.name === 'last-child' && siblings(el).at(-1) !== el) return false;
    if (p.name === 'only-child' && siblings(el).length !== 1) return false;
    if (p.name === 'empty' && el.children.some((c) => c.type === 'element' || (c.type === 'text' && c.value !== ''))) return false;
    if (p.name === 'nth-child') {
      const pos = siblings(el).indexOf(el) + 1;
      const ok = p.a === 0 ? pos === p.b : (pos - p.b) / p.a >= 0 && Number.isInteger((pos - p.b) / p.a);
      if (!ok) return false;
    }
    if (p.name === 'not' && p.inner.some((chain) => chain.length === 1 && matchSimple(chain[0]!, el))) return false;
  }
  return true;
}

function matchComplex(c: Complex, idx: number, el: Element): boolean {
  if (!matchSimple(c[idx]!.simple, el)) return false;
  if (idx === 0) return true;
  const comb = c[idx]!.combinator;
  if (comb === '>') return el.parent?.type === 'element' && matchComplex(c, idx - 1, el.parent);
  if (comb === ' ') {
    for (let p = el.parent; p && p.type === 'element'; p = p.parent) if (matchComplex(c, idx - 1, p)) return true;
    return false;
  }
  const sibs = siblings(el);
  const at = sibs.indexOf(el);
  if (comb === '+') return at > 0 && matchComplex(c, idx - 1, sibs[at - 1]!);
  for (let j = at - 1; j >= 0; j--) if (matchComplex(c, idx - 1, sibs[j]!)) return true;
  return false;
}

export function matches(el: Element, selector: string): boolean {
  return parseSelectorList(selector).some((c) => matchComplex(c, c.length - 1, el));
}

/** Elements under `root` that match the selector, in document order. */
export function query(root: Parent, selector: string): Element[] {
  const list = parseSelectorList(selector);
  return elements(root).filter((el) => list.some((c) => matchComplex(c, c.length - 1, el)));
}

export function queryOne(root: Parent, selector: string): Element | null {
  return query(root, selector)[0] ?? null;
}

// ---------------------------------------------------------------- serialising

export const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
export const escapeAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;');

const RAW_OUT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes']);

/** HTML for a node. Text and attribute values are escaped, so the result parses back to the same tree. */
export function serialize(node: Node | Document): string {
  switch (node.type) {
    case 'text': {
      const p = node.parent;
      return p && p.type === 'element' && RAW_OUT.has(p.tag) ? node.value : escapeText(node.value);
    }
    case 'comment':
      return `<!--${node.value.replace(/-->/g, '-- >').replace(/--!>/g, '--! >')}-->`;
    case 'doctype':
      return `<!DOCTYPE ${node.name}>`;
    case 'document':
      return node.children.map(serialize).join('');
    case 'element': {
      if (!/^[a-z][^\s/>]*$/.test(node.tag)) return escapeText(`<${node.tag}>`);
      const attrs = node.attrs.filter((a) => a.name && !/[\s"'<>/=]/.test(a.name)).map((a) => ` ${a.name}="${escapeAttr(a.value)}"`).join('');
      if (VOID.has(node.tag)) return `<${node.tag}${attrs}>`;
      return `<${node.tag}${attrs}>${node.children.map(serialize).join('')}</${node.tag}>`;
    }
  }
}

// ---------------------------------------------------------------- diff

export interface Difference {
  /** Where, as /div[1]/p[2] (tag and its position among elements of that tag). */
  readonly path: string;
  readonly kind: 'added' | 'removed' | 'changed-text' | 'changed-tag' | 'changed-attributes';
  readonly before?: string;
  readonly after?: string;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

function meaningful(p: Parent): Node[] {
  return p.children.filter((c) => c.type === 'element' || (c.type === 'text' && squash(c.value) !== '') || c.type === 'comment');
}

function sig(n: Node): string {
  if (n.type === 'text') return `#${squash(n.value)}`;
  if (n.type === 'comment') return `!${n.value}`;
  if (n.type === 'doctype') return `?${n.name}`;
  return `<${n.tag} ${[...n.attrs].sort((a, b) => (a.name < b.name ? -1 : 1)).map((a) => `${a.name}=${a.value}`).join('&')}>${meaningful(n).map(sig).join('')}</>`;
}

/** The structural differences between two trees, ignoring whitespace runs and attribute order. */
export function diff(a: Parent, b: Parent): Difference[] {
  const out: Difference[] = [];
  const label = (n: Node, sibs: Node[]) => (n.type === 'element' ? `${n.tag}[${sibs.filter((s) => s.type === 'element' && s.tag === n.tag).indexOf(n) + 1}]` : n.type === 'text' ? 'text()' : 'comment()');
  const run = (x: Parent, y: Parent, path: string) => {
    const xs = meaningful(x);
    const ys = meaningful(y);
    const xk = xs.map(sig);
    const yk = ys.map(sig);
    // Longest common subsequence of identical children.
    const m = xk.length;
    const n = yk.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i]![j] = xk[i] === yk[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    let i = 0;
    let j = 0;
    const gapX: Node[] = [];
    const gapY: Node[] = [];
    const settle = () => {
      const pairs = Math.min(gapX.length, gapY.length);
      for (let k = 0; k < pairs; k++) change(gapX[k]!, gapY[k]!, xs, ys, path);
      for (const r of gapX.slice(pairs)) out.push({ path: `${path}/${label(r, xs)}`, kind: 'removed', before: r.type === 'text' ? squash(r.value) : serialize(r) });
      for (const r of gapY.slice(pairs)) out.push({ path: `${path}/${label(r, ys)}`, kind: 'added', after: r.type === 'text' ? squash(r.value) : serialize(r) });
      gapX.length = 0;
      gapY.length = 0;
    };
    while (i < m || j < n) {
      if (i < m && j < n && xk[i] === yk[j]) {
        settle();
        i++;
        j++;
      } else if (j >= n || (i < m && dp[i + 1]![j]! >= dp[i]![j + 1]!)) gapX.push(xs[i++]!);
      else gapY.push(ys[j++]!);
    }
    settle();
  };
  const change = (p: Node, q: Node, xs: Node[], ys: Node[], path: string) => {
    if (p.type === 'text' && q.type === 'text') out.push({ path: `${path}/text()`, kind: 'changed-text', before: squash(p.value), after: squash(q.value) });
    else if (p.type === 'element' && q.type === 'element') {
      const here = `${path}/${label(p, xs)}`;
      if (p.tag !== q.tag) out.push({ path: here, kind: 'changed-tag', before: p.tag, after: q.tag });
      const fmt = (e: Element) => [...e.attrs].sort((s, t) => (s.name < t.name ? -1 : 1)).map((s) => `${s.name}="${s.value}"`).join(' ');
      if (fmt(p) !== fmt(q)) out.push({ path: here, kind: 'changed-attributes', before: fmt(p), after: fmt(q) });
      run(p, q, here);
    } else {
      out.push({ path: `${path}/${label(p, xs)}`, kind: 'removed', before: p.type === 'text' ? squash(p.value) : serialize(p) });
      out.push({ path: `${path}/${label(q, ys)}`, kind: 'added', after: q.type === 'text' ? squash(q.value) : serialize(q) });
    }
  };
  run(a, b, '');
  return out;
}
