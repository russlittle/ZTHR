/**
 * Block markup: documents made of typed blocks stored as ordinary HTML with comment delimiters, the format the
 * WordPress block editor (Gutenberg) uses and that plain HTML readers simply ignore the comments of:
 *
 *     <!-- wp:heading {"level":3} -->
 *     <h3>Title</h3>
 *     <!-- /wp:heading -->
 *
 *     <!-- wp:separator /-->
 *
 * A block has a name (`core/paragraph`, written `paragraph` for the core namespace), attributes as JSON, its own HTML,
 * and inner blocks; `innerContent` interleaves the block's HTML chunks with `null` where each inner block goes, so a
 * document parses and writes back without losing a byte of what lies between blocks. HTML outside any block is a
 * freeform block (name null). Attribute JSON is written with `--`, `<`, `>`, `&` and `"` escaped as \uXXXX so it can
 * never close the comment or read as markup, exactly as Gutenberg does.
 *
 * Parsing is tolerant by default and reports what it repaired as problems (an unclosed block is closed at the end of
 * input, a stray closer becomes text, bad attribute JSON becomes empty attributes); strict mode throws instead.
 * Limits on length, depth, blocks and attribute size bound hostile input. `validate` checks a parse against registered
 * block types (attribute types, enums, required attributes, allowed parents and children, unbalanced or forbidden
 * HTML in a block, read with the html-parse block) and `normalise` fills defaults and turns blocks that are unknown or
 * invalid into `core/missing` fallback blocks that keep the original markup and write it back untouched.
 *
 * Not here: block rendering, the editor, deprecation migrations that rewrite old markup (a registered type may list
 * old names to accept), and the "save" function a type uses to generate its HTML.
 */
import { elements, parse as parseHtml, text as textOf, tokenize } from '../html-parse/index.ts';

export class MarkupError extends Error {
  readonly offset: number;
  constructor(why: string, offset: number) {
    super(`${why} (at character ${offset})`);
    this.name = 'MarkupError';
    this.offset = offset;
  }
}
export class LimitExceeded extends Error {
  constructor(what: string, limit: number) {
    super(`the document has more ${what} than the limit of ${limit}`);
    this.name = 'LimitExceeded';
  }
}

export interface Block {
  /** `core/paragraph`; null for freeform HTML outside any block. */
  name: string | null;
  attrs: Record<string, unknown>;
  innerBlocks: Block[];
  /** The block's own HTML with inner blocks left out. */
  innerHTML: string;
  /** HTML chunks and null where each inner block goes; always (inner blocks + 1) chunks when there are inner blocks. */
  innerContent: (string | null)[];
}

export interface Problem {
  readonly code: string;
  readonly message: string;
  /** Path of block indexes, such as 2.0.1. */
  readonly path: string;
  readonly block: string | null;
}

export interface Limits {
  readonly maxLength?: number;
  readonly maxDepth?: number;
  readonly maxBlocks?: number;
  readonly maxAttrBytes?: number;
}
const DEFAULTS = { maxLength: 5_000_000, maxDepth: 64, maxBlocks: 100_000, maxAttrBytes: 65_536 };

export interface ParseOptions extends Limits {
  /** The comment prefix; `wp` for WordPress documents. */
  readonly prefix?: string;
  /** Throw MarkupError for anything that would be repaired. */
  readonly strict?: boolean;
}
export interface Parsed {
  readonly blocks: Block[];
  readonly problems: Problem[];
}

const NAME = '[a-z][a-z0-9_-]*(?:/[a-z][a-z0-9_-]*)?';

/** `paragraph` becomes `core/paragraph`; names with a namespace stay as they are. */
export function qualify(name: string): string {
  return name.includes('/') ? name : `core/${name}`;
}
/** The short form used in comments: `core/paragraph` is written `paragraph`. */
export function short(name: string): string {
  return name.startsWith('core/') ? name.slice(5) : name;
}

export function block(name: string, attrs: Record<string, unknown> = {}, inner: Block[] = [], html: { html?: string; before?: string; after?: string } = {}): Block {
  const q = qualify(name);
  if (!new RegExp(`^${NAME}$`).test(short(q)) && !/^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/.test(q)) throw new MarkupError(`"${name}" is not a block name`, 0);
  if (inner.length) {
    const before = html.before ? `\n${html.before}\n` : '\n';
    const after = html.after ? `\n${html.after}\n` : '\n';
    const content: (string | null)[] = [before];
    inner.forEach((_b, i) => {
      content.push(null);
      content.push(i < inner.length - 1 ? '\n\n' : after);
    });
    return { name: q, attrs, innerBlocks: inner, innerHTML: content.filter((c): c is string => c !== null).join(''), innerContent: content };
  }
  const h = html.html === undefined ? '' : `\n${html.html}\n`;
  return { name: q, attrs, innerBlocks: [], innerHTML: h, innerContent: h ? [h] : [] };
}

// ---------------------------------------------------------------- parse

interface Delimiter {
  kind: 'open' | 'close' | 'void';
  name: string;
  attrsText: string | null;
  start: number;
  end: number;
}

/** Finds the next block delimiter at or after `from`, or null. Linear: no backtracking over the text. */
function nextDelimiter(src: string, from: number, prefix: string, maxAttr: number): Delimiter | null | 'badjson' {
  let i = from;
  const lead = `${prefix}:`;
  while (true) {
    const at = src.indexOf('<!--', i);
    if (at < 0) return null;
    i = at + 4;
    let j = i;
    if (!/\s/.test(src[j] ?? '')) continue;
    while (/\s/.test(src[j] ?? '')) j++;
    let closing = false;
    if (src[j] === '/') {
      closing = true;
      j++;
    }
    if (!src.startsWith(lead, j)) continue;
    j += lead.length;
    const nameRe = new RegExp(`^${NAME}`);
    const m = nameRe.exec(src.slice(j, j + 128));
    if (!m) continue;
    const name = m[0];
    j += name.length;
    if (!/\s|\//.test(src[j] ?? '')) continue;
    while (/\s/.test(src[j] ?? '')) j++;
    let attrsText: string | null = null;
    if (!closing && src[j] === '{') {
      // The attribute JSON ends at the first "}" followed by space and "-->" or "/-->".
      const end = /\}\s+\/?-->/g;
      end.lastIndex = j;
      const f = end.exec(src);
      if (!f) continue;
      attrsText = src.slice(j, f.index + 1);
      if (attrsText.length > maxAttr) return 'badjson';
      j = f.index + 1;
      while (/\s/.test(src[j] ?? '')) j++;
    }
    let kind: Delimiter['kind'] = closing ? 'close' : 'open';
    if (src[j] === '/' && src.startsWith('/-->', j) && !closing) {
      kind = 'void';
      j += 1;
    }
    if (!src.startsWith('-->', j)) continue;
    return { kind, name, attrsText, start: at, end: j + 3 };
  }
}

/** Reads a document into blocks. */
export function parse(markup: string, o: ParseOptions = {}): Parsed {
  const L = { ...DEFAULTS, ...o };
  const prefix = o.prefix ?? 'wp';
  if (typeof markup !== 'string') throw new TypeError('the document must be a string');
  if (markup.length > L.maxLength) throw new LimitExceeded('characters', L.maxLength);
  const problems: Problem[] = [];
  const top: Block[] = [];
  type Frame = { block: Block };
  const stack: Frame[] = [];
  let count = 0;
  let pending = '';
  const problem = (code: string, message: string, offset: number, b: string | null = null) => {
    if (o.strict) throw new MarkupError(message, offset);
    problems.push({ code, message, path: '', block: b });
  };
  const target = (): Block[] => (stack.length ? stack[stack.length - 1]!.block.innerBlocks : top);
  const newBlock = (name: string | null, attrs: Record<string, unknown>): Block => {
    if (++count > L.maxBlocks) throw new LimitExceeded('blocks', L.maxBlocks);
    return { name, attrs, innerBlocks: [], innerHTML: '', innerContent: [] };
  };
  const addText = (s: string) => {
    if (!s) return;
    if (stack.length) {
      const f = stack[stack.length - 1]!.block;
      const last = f.innerContent[f.innerContent.length - 1];
      if (typeof last === 'string') f.innerContent[f.innerContent.length - 1] = last + s;
      else f.innerContent.push(s);
      f.innerHTML += s;
    } else pending += s;
  };
  const flush = () => {
    const t = pending.trim();
    pending = '';
    if (!t) return;
    const b = newBlock(null, {});
    b.innerHTML = t;
    b.innerContent = [t];
    top.push(b);
  };
  const attach = (b: Block) => {
    if (!stack.length) flush();
    const into = target();
    if (stack.length) {
      const f = stack[stack.length - 1]!.block;
      if (f.innerContent.length === 0 || f.innerContent[f.innerContent.length - 1] === null) f.innerContent.push('');
      f.innerContent.push(null);
    }
    into.push(b);
  };
  const readAttrs = (d: Delimiter): Record<string, unknown> => {
    if (d.attrsText === null) return {};
    try {
      const v: unknown = JSON.parse(d.attrsText);
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) return safeObject(v as Record<string, unknown>);
    } catch {
      /* reported below */
    }
    problem('bad-attributes', `the attributes of ${d.name} are not a JSON object`, d.start, qualify(d.name));
    return {};
  };
  const closeTop = () => {
    const f = stack.pop()!;
    const b = f.block;
    if (b.innerContent.length && b.innerContent[b.innerContent.length - 1] === null) b.innerContent.push('');
  };

  let pos = 0;
  while (pos <= markup.length) {
    const d = nextDelimiter(markup, pos, prefix, L.maxAttrBytes);
    if (d === 'badjson') throw new LimitExceeded('bytes of attributes in one block', L.maxAttrBytes);
    if (!d) {
      addText(markup.slice(pos));
      break;
    }
    addText(markup.slice(pos, d.start));
    pos = d.end;
    const name = qualify(d.name);
    if (d.kind === 'open' || d.kind === 'void') {
      if (stack.length >= L.maxDepth) throw new LimitExceeded('levels of nesting', L.maxDepth);
      const b = newBlock(name, readAttrs(d));
      attach(b);
      if (d.kind === 'open') stack.push({ block: b });
    } else {
      const at = stack.map((f) => f.block.name).lastIndexOf(name);
      if (at < 0) {
        problem('stray-closer', `a closing ${d.name} has nothing open to close`, d.start);
        addText(markup.slice(d.start, d.end));
        continue;
      }
      while (stack.length - 1 > at) {
        problem('unclosed', `${short(stack[stack.length - 1]!.block.name!)} was not closed before ${d.name} ended`, d.start, stack[stack.length - 1]!.block.name);
        closeTop();
      }
      closeTop();
    }
  }
  while (stack.length) {
    problem('unclosed', `${short(stack[stack.length - 1]!.block.name!)} was never closed`, markup.length, stack[stack.length - 1]!.block.name);
    closeTop();
  }
  flush();
  return { blocks: top, problems };
}

/** A copy without keys that could change an object's prototype. */
function safeObject(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = val && typeof val === 'object' && !Array.isArray(val) ? safeObject(val as Record<string, unknown>) : val;
  }
  return out;
}

// ---------------------------------------------------------------- serialise

/** Attribute JSON that can sit inside a comment: nothing in it can close the comment or open a tag. */
export function encodeAttrs(attrs: Record<string, unknown>): string {
  return JSON.stringify(attrs).replace(/\\"/g, '\\u0022').replace(/--/g, '\\u002d\\u002d').replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

/** Writes blocks as a document. Blocks are separated by a blank line. */
export function serialize(blocks: readonly Block[], o: { prefix?: string } = {}): string {
  const prefix = o.prefix ?? 'wp';
  const one = (b: Block): string => {
    if (b.name === null) return b.innerHTML;
    if (b.name === 'core/missing' && typeof b.attrs['originalContent'] === 'string') return b.attrs['originalContent'];
    const nm = short(b.name);
    if (!/^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)?$/.test(nm)) throw new MarkupError(`"${b.name}" cannot be written as a block name`, 0);
    const attrs = Object.keys(b.attrs).length ? ` ${encodeAttrs(b.attrs)}` : '';
    const content = innerOf(b);
    if (content === '' && !b.innerBlocks.length) return `<!-- ${prefix}:${nm}${attrs} /-->`;
    return `<!-- ${prefix}:${nm}${attrs} -->${content}<!-- /${prefix}:${nm} -->`;
  };
  const innerOf = (b: Block): string => {
    if (!b.innerBlocks.length) return b.innerContent.length ? b.innerContent.join('') : b.innerHTML;
    const slots = b.innerContent.filter((c) => c === null).length;
    if (slots !== b.innerBlocks.length) return `\n${b.innerBlocks.map(one).join('\n\n')}\n`;
    let i = 0;
    return b.innerContent.map((c) => (c === null ? one(b.innerBlocks[i++]!) : c)).join('');
  };
  return blocks.map(one).join('\n\n');
}

// ---------------------------------------------------------------- types, validation, fallback

export type AttrType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
export interface AttrSpec {
  readonly type: AttrType;
  readonly default?: unknown;
  readonly enum?: readonly unknown[];
  readonly required?: boolean;
}
export interface BlockType {
  readonly name: string;
  readonly attributes?: Readonly<Record<string, AttrSpec>>;
  /** Whether inner blocks are allowed; false when missing. */
  readonly inner?: boolean;
  /** Only these block names may be inside. */
  readonly allowedChildren?: readonly string[];
  /** This block may only appear inside these. */
  readonly allowedParents?: readonly string[];
  /** Older names whose markup is read as this type. */
  readonly aliases?: readonly string[];
  /** A check of the block's own HTML: a message when it is wrong. */
  readonly checkHTML?: (html: string) => string | null;
}
export type Registry = ReadonlyMap<string, BlockType>;

export function registry(types: readonly BlockType[]): Registry {
  const m = new Map<string, BlockType>();
  for (const t of types) {
    const n = qualify(t.name);
    if (m.has(n)) throw new Error(`block type ${n} is registered twice`);
    m.set(n, { ...t, name: n });
    for (const a of t.aliases ?? []) {
      const an = qualify(a);
      if (m.has(an)) throw new Error(`block type ${an} is registered twice`);
      m.set(an, { ...t, name: n });
    }
  }
  return m;
}

const typeOk = (t: AttrType, v: unknown): boolean =>
  t === 'string' ? typeof v === 'string'
  : t === 'number' ? typeof v === 'number' && Number.isFinite(v)
  : t === 'integer' ? Number.isInteger(v)
  : t === 'boolean' ? typeof v === 'boolean'
  : t === 'array' ? Array.isArray(v)
  : typeof v === 'object' && v !== null && !Array.isArray(v);

const DEFAULT_FORBIDDEN = ['script', 'style', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'form'];

export interface ValidateOptions {
  /** Tags that may not appear in a block's HTML. Defaults to script, style, iframe, object, embed, base, meta, link, form. */
  readonly forbidTags?: readonly string[];
  /** Report attributes the type does not declare. Default true. */
  readonly strictAttributes?: boolean;
}

/** Everything wrong with a parse, judged against the registered types. Blocks are not changed. */
export function validate(blocks: readonly Block[], reg: Registry, o: ValidateOptions = {}): Problem[] {
  const out: Problem[] = [];
  const forbidden = new Set(o.forbidTags ?? DEFAULT_FORBIDDEN);
  const walk = (list: readonly Block[], parent: Block | null, prefix: string) => {
    list.forEach((b, i) => {
      const path = prefix ? `${prefix}.${i}` : String(i);
      const p = (code: string, message: string) => out.push({ code, message, path, block: b.name });
      if (b.name === null) {
        checkHtml(b.innerHTML, p);
        return;
      }
      if (b.name === 'core/missing') {
        p('unregistered', `block ${String(b.attrs['originalName'])} is not a known block type`);
        return;
      }
      const t = reg.get(b.name);
      if (!t) {
        p('unregistered', `block ${b.name} is not a known block type`);
        return;
      }
      if (parent?.name) {
        const pt = reg.get(parent.name);
        if (pt?.allowedChildren && !pt.allowedChildren.map(qualify).includes(t.name)) p('child-not-allowed', `${parent.name} does not allow ${t.name} inside it`);
        if (t.allowedParents && !t.allowedParents.map(qualify).includes(pt?.name ?? parent.name)) p('parent-not-allowed', `${t.name} may only be inside ${t.allowedParents.join(', ')}`);
      } else if (t.allowedParents) p('parent-not-allowed', `${t.name} may only be inside ${t.allowedParents.join(', ')}`);
      if (b.innerBlocks.length && !t.inner) p('inner-not-allowed', `${t.name} cannot hold other blocks`);
      const specs = t.attributes ?? {};
      for (const [k, spec] of Object.entries(specs)) {
        const v = b.attrs[k];
        if (v === undefined) {
          if (spec.required) p('attribute-missing', `${t.name} needs the attribute "${k}"`);
          continue;
        }
        if (!typeOk(spec.type, v)) p('attribute-type', `"${k}" of ${t.name} must be ${spec.type}`);
        else if (spec.enum && !spec.enum.some((e) => e === v)) p('attribute-value', `"${k}" of ${t.name} must be one of ${spec.enum.map((e) => JSON.stringify(e)).join(', ')}`);
      }
      if (o.strictAttributes !== false) for (const k of Object.keys(b.attrs)) if (!(k in specs)) p('attribute-unknown', `${t.name} has no attribute "${k}"`);
      checkHtml(b.innerHTML, p);
      const own = t.checkHTML?.(b.innerHTML);
      if (own) p('html-invalid', own);
      walk(b.innerBlocks, b, path);
    });
  };
  const checkHtml = (html: string, p: (c: string, m: string) => void) => {
    if (!html.trim()) return;
    const stackTags: string[] = [];
    const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
    let bad = false;
    for (const t of tokenize(html)) {
      if (t.kind === 'start' && !VOID.has(t.tag) && !t.selfClosing) stackTags.push(t.tag);
      else if (t.kind === 'end') {
        const at = stackTags.lastIndexOf(t.tag);
        if (at < 0 || at !== stackTags.length - 1) bad = true;
        if (at >= 0) stackTags.length = at;
      }
    }
    if (bad || stackTags.length) p('html-unbalanced', 'the block HTML has tags that are not closed in order');
    for (const e of elements(parseHtml(html))) if (forbidden.has(e.tag)) p('forbidden-tag', `the block HTML contains <${e.tag}>, which is not allowed`);
  };
  walk(blocks, null, '');
  return out;
}

export interface Normalised {
  readonly blocks: Block[];
  readonly problems: Problem[];
}

/**
 * Fills attribute defaults and replaces blocks that are unregistered or invalid with core/missing fallbacks that
 * remember the original markup (so saving writes it back unchanged). Old aliases are renamed to the current name.
 */
export function normalise(blocks: readonly Block[], reg: Registry, o: ValidateOptions = {}): Normalised {
  const problems = validate(blocks, reg, o);
  const bad = new Set(problems.filter((p) => !['attribute-unknown'].includes(p.code) || o.strictAttributes !== false).map((p) => p.path));
  const walk = (list: readonly Block[], prefix: string): Block[] =>
    list.map((b, i) => {
      const path = prefix ? `${prefix}.${i}` : String(i);
      if (b.name === null || b.name === 'core/missing') return b;
      const t = reg.get(b.name);
      if (!t || bad.has(path)) {
        const original = serialize([b]);
        return { name: 'core/missing', attrs: { originalName: b.name, originalContent: original }, innerBlocks: [], innerHTML: original, innerContent: [original] };
      }
      const attrs = { ...b.attrs };
      for (const [k, spec] of Object.entries(t.attributes ?? {})) if (attrs[k] === undefined && spec.default !== undefined) attrs[k] = spec.default;
      return { ...b, name: t.name, attrs, innerBlocks: walk(b.innerBlocks, path) };
    });
  return { blocks: walk(blocks, ''), problems };
}

// ---------------------------------------------------------------- reading blocks

/** The plain text of a block and everything inside it. */
export function plainText(b: Block): string {
  const own = b.innerContent.length
    ? b.innerContent.map((c) => (c === null ? '' : textOf(parseHtml(c)))).join('')
    : textOf(parseHtml(b.innerHTML));
  return (own + b.innerBlocks.map(plainText).join(' ')).replace(/\s+/g, ' ').trim();
}

/** Every block in the tree, in document order, with its path. */
export function* walkBlocks(blocks: readonly Block[], prefix = ''): Generator<{ block: Block; path: string }> {
  for (let i = 0; i < blocks.length; i++) {
    const path = prefix ? `${prefix}.${i}` : String(i);
    yield { block: blocks[i]!, path };
    yield* walkBlocks(blocks[i]!.innerBlocks, path);
  }
}
