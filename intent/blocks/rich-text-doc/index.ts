/**
 * A ProseMirror-style document model: a schema of node and mark types, documents as plain JSON trees, integer
 * positions, steps that change a document and can be inverted and mapped, and transforms that build steps.
 *
 * Schema. Node types have a content expression (`paragraph+`, `(paragraph | heading)* hard_break?`, group names
 * such as `block`, quantifiers `* + ? {n,m}`), optional groups, attributes with defaults and validators, and the
 * marks they allow. `Schema.check` reports every way a tree breaks the schema, with its path; `nodeFromJSON`
 * reads untrusted JSON (unknown keys, types, attributes, depth and size are refused) and gives back a normalised
 * node (default attributes filled, marks in schema order with excluded ones removed).
 *
 * Positions follow ProseMirror: a text character and a leaf count one, any other node counts one at each end plus
 * its content; `resolve` gives the path, depth, index and offsets at a position; `slice` cuts a fragment with its
 * open depths; `replace` is ProseMirror's replace algorithm (joins and re-closes the open sides, and refuses what
 * the schema does not allow).
 *
 * Steps are the changes: ReplaceStep, ReplaceAroundStep (wrap and lift), AddMarkStep, RemoveMarkStep and AttrStep.
 * Each applies to a document (or fails with a message, never half-applies), inverts against the document it was
 * applied to, maps through the steps that came before it (or vanishes if what it touched was deleted), and has a
 * StepMap saying how positions move. A Mapping chains maps with mirrors, so a step undone and redone maps back to
 * where it was (what rebasing for collaboration needs). A Transform applies steps in turn and keeps the documents
 * and maps; it has insert, delete, replace, insertText, addMark, removeMark, setNodeAttr, split, join, wrap and
 * lift (of a whole range of children, splitting the parent when the range does not reach both of its ends).
 *
 * Serialisation: JSON is the node itself; `toHTML` writes escaped HTML from the schema's own rules (link
 * addresses are checked, so a javascript: link is left out), and `fromHTML` reads HTML by first passing it through
 * the html-sanitize block with a policy made from the schema, then fitting what is left to the schema: text outside a
 * textblock gets a paragraph, what the schema does not allow in a place is unwrapped or dropped.
 *
 * Out of scope: selections and the editor view, plugins and input rules, tables, and parsing HTML that relies on
 * CSS to say what it means.
 */
import { parse as parseHtml, attr as htmlAttr } from '../html-parse/index.ts';
import type { Element as HtmlElement, Node as HtmlNode } from '../html-parse/index.ts';
import { cleanUrl, escapeAttr, escapeText, sanitize } from '../html-sanitize/index.ts';
import type { Policy } from '../html-sanitize/index.ts';

export type Json = string | number | boolean | null | readonly Json[] | { readonly [k: string]: Json };
export type Attrs = Readonly<Record<string, Json>>;

export interface Mark {
  readonly type: string;
  readonly attrs?: Attrs;
}
export interface Node {
  readonly type: string;
  readonly attrs?: Attrs;
  /** Present on every node that may have children, even when empty; absent on leaves and text. */
  readonly content?: readonly Node[];
  readonly text?: string;
  readonly marks?: readonly Mark[];
}

export class InvalidContent extends Error {
  constructor(why: string) {
    super(why);
  }
}
export class ReplaceError extends Error {
  constructor(why: string) {
    super(why);
  }
}
export class TransformError extends Error {
  constructor(why: string) {
    super(why);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Schema

export interface AttrSpec {
  readonly default?: Json;
  /** Without a default the attribute is required. */
  readonly validate?: (v: Json) => boolean;
}
export interface HtmlRule {
  readonly tag: string;
  /** Attributes for the node or mark from the element; false refuses the element for this rule. */
  readonly attrs?: Attrs | ((el: HtmlElement) => Attrs | false);
  /** The element holds preformatted text: whitespace is kept. */
  readonly preserveWhitespace?: boolean;
}
/** How a node or mark is written as HTML: a tag, attributes, and whether it has content. */
export interface HtmlOut {
  readonly tag: string;
  readonly attrs?: Readonly<Record<string, string>>;
}
export interface NodeSpec {
  readonly content?: string;
  readonly group?: string;
  readonly inline?: boolean;
  readonly attrs?: Readonly<Record<string, AttrSpec>>;
  /** Names of marks allowed on the content: "_" for all, "" for none; default all in a textblock, none elsewhere. */
  readonly marks?: string;
  readonly toHTML?: (n: Node) => HtmlOut | null;
  readonly parseHTML?: readonly HtmlRule[];
  /** Written as <tag/> with no children. */
  readonly void?: boolean;
}
export interface MarkSpec {
  readonly attrs?: Readonly<Record<string, AttrSpec>>;
  /** Marks that cannot go with this one: "_" all, "" none; default only itself. */
  readonly excludes?: string;
  readonly toHTML?: (m: Mark) => HtmlOut | null;
  readonly parseHTML?: readonly HtmlRule[];
}
export interface SchemaSpec {
  readonly nodes: Readonly<Record<string, NodeSpec>>;
  readonly marks?: Readonly<Record<string, MarkSpec>>;
  readonly topNode?: string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Compiled {
  readonly re: RegExp;
  readonly names: ReadonlySet<string>;
  readonly first: ReadonlySet<string>;
  readonly source: string;
}

export class NodeType {
  readonly name: string;
  readonly spec: NodeSpec;
  readonly isText: boolean;
  readonly isInline: boolean;
  readonly isLeaf: boolean;
  compiled: Compiled | null = null;
  markNames: ReadonlySet<string> = new Set();
  constructor(name: string, spec: NodeSpec) {
    this.name = name;
    this.spec = spec;
    this.isText = name === 'text';
    this.isInline = this.isText || spec.inline === true;
    this.isLeaf = !this.isText && (spec.content === undefined || spec.content.trim() === '');
  }
  get isBlock(): boolean {
    return !this.isInline;
  }
  get isTextblock(): boolean {
    return !this.isLeaf && !this.isText && this.compiled !== null && this.compiled.names.size > 0 && [...this.compiled.names].every((n) => this.schema.nodes.get(n)?.isInline);
  }
  schema!: Schema;
  /** Whether a child of this type name may appear at all in this type's content. */
  allows(child: string): boolean {
    return this.compiled?.names.has(child) ?? false;
  }
  /** ProseMirror's compatibleContent: the same type, or some child type may start the content of both. */
  compatible(other: NodeType): boolean {
    if (this === other) return true;
    const a = this.compiled?.first;
    const b = other.compiled?.first;
    if (!a || !b) return false;
    for (const n of a) if (b.has(n)) return true;
    return false;
  }
}

export class MarkType {
  readonly name: string;
  readonly spec: MarkSpec;
  readonly rank: number;
  excludedNames: ReadonlySet<string> = new Set();
  constructor(name: string, spec: MarkSpec, rank: number) {
    this.name = name;
    this.spec = spec;
    this.rank = rank;
  }
}

class Expr {
  private readonly s: string;
  private i = 0;
  private readonly resolve: (name: string) => string[];
  readonly names = new Set<string>();
  constructor(s: string, resolve: (name: string) => string[]) {
    this.s = s;
    this.resolve = resolve;
  }
  private ws() {
    while (/\s/.test(this.s[this.i] ?? '')) this.i++;
  }
  /** Returns the regular expression source and the set of types that can come first. */
  parse(): { src: string; first: Set<string> } {
    const r = this.alt();
    this.ws();
    if (this.i < this.s.length) throw new InvalidContent(`unexpected "${this.s[this.i]}" in content expression "${this.s}"`);
    return r;
  }
  private alt(): { src: string; first: Set<string>; nullable: boolean } {
    const parts = [this.seq()];
    this.ws();
    while (this.s[this.i] === '|') {
      this.i++;
      parts.push(this.seq());
      this.ws();
    }
    if (parts.length === 1) return parts[0]!;
    return { src: `(?:${parts.map((p) => p.src).join('|')})`, first: new Set(parts.flatMap((p) => [...p.first])), nullable: parts.some((p) => p.nullable) };
  }
  private seq(): { src: string; first: Set<string>; nullable: boolean } {
    let src = '';
    const first = new Set<string>();
    let nullable = true;
    let any = false;
    for (;;) {
      this.ws();
      const c = this.s[this.i];
      if (c === undefined || c === '|' || c === ')') break;
      const a = this.atom();
      any = true;
      if (nullable) for (const f of a.first) first.add(f);
      nullable = nullable && a.nullable;
      src += a.src;
    }
    if (!any) throw new InvalidContent(`empty part in content expression "${this.s}"`);
    return { src, first, nullable };
  }
  private atom(): { src: string; first: Set<string>; nullable: boolean } {
    let a: { src: string; first: Set<string>; nullable: boolean };
    if (this.s[this.i] === '(') {
      this.i++;
      const inner = this.alt();
      this.ws();
      if (this.s[this.i] !== ')') throw new InvalidContent(`missing ) in content expression "${this.s}"`);
      this.i++;
      a = { src: `(?:${inner.src})`, first: inner.first, nullable: inner.nullable };
    } else {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i));
      if (!m) throw new InvalidContent(`unexpected "${this.s[this.i]}" in content expression "${this.s}"`);
      this.i += m[0].length;
      const names = this.resolve(m[0]);
      if (!names.length) throw new InvalidContent(`no node type or group named "${m[0]}" in content expression "${this.s}"`);
      for (const n of names) this.names.add(n);
      a = { src: `(?:${names.map((n) => `\\[${n}\\]`).join('|')})`, first: new Set(names), nullable: false };
    }
    const q = this.s[this.i];
    if (q === '*') {
      this.i++;
      return { src: `${a.src}*`, first: a.first, nullable: true };
    }
    if (q === '+') {
      this.i++;
      return { src: `${a.src}+`, first: a.first, nullable: a.nullable };
    }
    if (q === '?') {
      this.i++;
      return { src: `${a.src}?`, first: a.first, nullable: true };
    }
    if (q === '{') {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(this.s.slice(this.i));
      if (!m) throw new InvalidContent(`bad repeat in content expression "${this.s}"`);
      this.i += m[0].length;
      const lo = Number(m[1]);
      const hi = m[2] ? (m[3] === '' ? '' : Number(m[3])) : lo;
      if (typeof hi === 'number' && hi < lo) throw new InvalidContent(`bad repeat in content expression "${this.s}"`);
      return { src: `${a.src}{${lo},${hi}}`, first: a.first, nullable: lo === 0 };
    }
    return a;
  }
}

const sameJson = (a: Json | undefined, b: Json | undefined): boolean => {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as readonly Json[]).length && a.every((x, i) => sameJson(x, (b as readonly Json[])[i]));
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b as object, k) && sameJson((a as Record<string, Json>)[k], (b as Record<string, Json>)[k]));
};
export const sameAttrs = (a: Attrs | undefined, b: Attrs | undefined) => sameJson((a ?? {}) as Json, (b ?? {}) as Json);
export const sameMark = (a: Mark, b: Mark) => a.type === b.type && sameAttrs(a.attrs, b.attrs);
export const sameMarks = (a: readonly Mark[] | undefined, b: readonly Mark[] | undefined) => {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((m, i) => sameMark(m, y[i]!));
};
/** Same type, attributes and marks: text nodes that are the same markup can be joined. */
export const sameMarkup = (a: Node, b: Node) => a.type === b.type && sameAttrs(a.attrs, b.attrs) && sameMarks(a.marks, b.marks);

const MAX_DEPTH = 100;

export class Schema {
  readonly nodes = new Map<string, NodeType>();
  readonly marks = new Map<string, MarkType>();
  readonly topNode: NodeType;

  constructor(spec: SchemaSpec) {
    for (const [n, s] of Object.entries(spec.nodes)) {
      if (!NAME.test(n)) throw new InvalidContent(`"${n}" is not a good node name`);
      const t = new NodeType(n, s);
      t.schema = this;
      this.nodes.set(n, t);
    }
    let rank = 0;
    for (const [n, s] of Object.entries(spec.marks ?? {})) {
      if (!NAME.test(n)) throw new InvalidContent(`"${n}" is not a good mark name`);
      this.marks.set(n, new MarkType(n, s, rank++));
    }
    const text = this.nodes.get('text');
    if (!text) throw new InvalidContent('a schema needs a text node');
    if (text.spec.content !== undefined || text.spec.attrs !== undefined) throw new InvalidContent('the text node has no content or attributes');
    const groups = new Map<string, string[]>();
    for (const t of this.nodes.values()) for (const g of (t.spec.group ?? '').split(/\s+/).filter(Boolean)) groups.set(g, [...(groups.get(g) ?? []), t.name]);
    const resolveName = (name: string) => (this.nodes.has(name) ? [name] : (groups.get(name) ?? []));
    for (const t of this.nodes.values()) {
      if (t.isLeaf || t.isText) continue;
      const e = new Expr(t.spec.content!, resolveName);
      const { src, first } = e.parse();
      t.compiled = { re: new RegExp(`^${src}$`), names: e.names, first, source: t.spec.content! };
    }
    for (const t of this.nodes.values()) {
      const m = t.spec.marks;
      const textblock = t.isTextblock;
      const names = m === undefined ? (textblock ? '_' : '') : m;
      t.markNames = names === '_' ? new Set(this.marks.keys()) : new Set(names.split(/\s+/).filter(Boolean));
      for (const n of t.markNames) if (!this.marks.has(n)) throw new InvalidContent(`node ${t.name} allows the unknown mark ${n}`);
    }
    for (const m of this.marks.values()) {
      const ex = m.spec.excludes;
      m.excludedNames = ex === undefined ? new Set([m.name]) : ex === '_' ? new Set(this.marks.keys()) : new Set(ex.split(/\s+/).filter(Boolean));
    }
    const top = this.nodes.get(spec.topNode ?? 'doc');
    if (!top || top.isLeaf || top.isInline) throw new InvalidContent('the top node must be a block with content');
    this.topNode = top;
  }

  type(name: string): NodeType {
    const t = this.nodes.get(name);
    if (!t) throw new InvalidContent(`unknown node type ${name}`);
    return t;
  }

  private fillAttrs(specs: Readonly<Record<string, AttrSpec>> | undefined, given: Attrs | undefined, what: string): Attrs {
    const out: Record<string, Json> = {};
    const s = specs ?? {};
    for (const k of Object.keys(given ?? {})) if (!Object.hasOwn(s, k)) throw new InvalidContent(`${what} has no attribute ${k}`);
    for (const [k, a] of Object.entries(s)) {
      const v = given && Object.hasOwn(given, k) ? given[k]! : a.default;
      if (v === undefined) throw new InvalidContent(`${what} needs the attribute ${k}`);
      if (a.validate && !a.validate(v)) throw new InvalidContent(`${what} does not accept that ${k}`);
      out[k] = v;
    }
    return out;
  }

  /** A node of a type; content is checked unless `unchecked`. */
  node(type: string, attrs?: Attrs, content?: readonly Node[], marks?: readonly Mark[], o: { unchecked?: boolean } = {}): Node {
    const t = this.type(type);
    if (t.isText) throw new InvalidContent('make text with schema.text');
    const a = this.fillAttrs(t.spec.attrs, attrs, `a ${type}`);
    const n: Node = {
      type,
      ...(Object.keys(a).length ? { attrs: a } : {}),
      ...(t.isLeaf ? {} : { content: content ?? [] }),
      ...(marks?.length ? { marks: this.normMarks(marks) } : {}),
    };
    if (t.isLeaf && content?.length) throw new InvalidContent(`a ${type} has no content`);
    if (!o.unchecked) this.checkContent(n);
    return n;
  }

  text(text: string, marks?: readonly Mark[]): Node {
    if (text === '') throw new InvalidContent('empty text nodes are not allowed');
    return { type: 'text', text, ...(marks?.length ? { marks: this.normMarks(marks) } : {}) };
  }

  mark(type: string, attrs?: Attrs): Mark {
    const t = this.marks.get(type);
    if (!t) throw new InvalidContent(`unknown mark ${type}`);
    const a = this.fillAttrs(t.spec.attrs, attrs, `a ${type} mark`);
    return { type, ...(Object.keys(a).length ? { attrs: a } : {}) };
  }

  private normMarks(marks: readonly Mark[]): Mark[] {
    let set: readonly Mark[] = [];
    for (const m of marks) set = this.addToSet(set, this.mark(m.type, m.attrs));
    return [...set];
  }

  addToSet(set: readonly Mark[], mark: Mark): readonly Mark[] {
    const mt = this.marks.get(mark.type)!;
    let copy: Mark[] | undefined;
    let placed = false;
    for (let i = 0; i < set.length; i++) {
      const other = set[i]!;
      if (sameMark(mark, other)) return set;
      const ot = this.marks.get(other.type)!;
      if (mt.excludedNames.has(other.type)) {
        copy ??= set.slice(0, i);
      } else if (ot.excludedNames.has(mark.type)) return set;
      else {
        if (!placed && ot.rank > mt.rank) {
          copy ??= set.slice(0, i);
          copy.push(mark);
          placed = true;
        }
        if (copy) copy.push(other);
      }
    }
    copy ??= set.slice();
    if (!placed) copy.push(mark);
    return copy;
  }

  removeFromSet(set: readonly Mark[], mark: Mark | string): readonly Mark[] {
    const out = set.filter((m) => (typeof mark === 'string' ? m.type !== mark : !sameMark(m, mark)));
    return out.length === set.length ? set : out;
  }

  private childName(n: Node) {
    return n.type;
  }

  /** Whether a list of children is valid content for a node of this type. */
  matches(parent: string, children: readonly Node[]): boolean {
    const t = this.type(parent);
    if (t.isLeaf) return children.length === 0;
    return t.compiled!.re.test(children.map((c) => `[${this.childName(c)}]`).join(''));
  }

  /** Throws InvalidContent when a node's own children (one level) do not fit its type. */
  checkContent(n: Node): void {
    const t = this.type(n.type);
    if (t.isText) return;
    if (!this.matches(n.type, n.content ?? [])) throw new InvalidContent(`invalid content for ${n.type}: ${(n.content ?? []).map((c) => c.type).join(', ') || 'nothing'} does not fit ${t.spec.content ?? 'nothing'}`);
    for (const c of n.content ?? []) for (const m of c.marks ?? []) if (!t.markNames.has(m.type)) throw new InvalidContent(`a ${n.type} does not allow the ${m.type} mark`);
  }

  /** Every way a tree breaks the schema, each with the path to it; empty when valid. */
  check(root: Node): string[] {
    const problems: string[] = [];
    const walk = (n: Node, path: string, depth: number, isRoot: boolean) => {
      if (problems.length >= 50) return;
      if (depth > MAX_DEPTH) {
        problems.push(`${path}: nested deeper than ${MAX_DEPTH}`);
        return;
      }
      const t = this.nodes.get(n.type);
      if (!t) {
        problems.push(`${path}: unknown node type ${String(n.type)}`);
        return;
      }
      if (isRoot && t !== this.topNode) problems.push(`${path}: the top node must be a ${this.topNode.name}`);
      if (t.isText) {
        if (typeof n.text !== 'string' || n.text === '') problems.push(`${path}: text nodes hold text`);
        if (n.content !== undefined) problems.push(`${path}: text has no content`);
      } else if (n.text !== undefined) problems.push(`${path}: only text nodes hold text`);
      try {
        this.fillAttrs(t.spec.attrs, n.attrs, `${path} (${n.type})`);
      } catch (e) {
        problems.push((e as Error).message);
      }
      if (t.isLeaf && n.content !== undefined && n.content.length) problems.push(`${path}: a ${n.type} has no content`);
      if (!t.isLeaf && !t.isText) {
        if (n.content === undefined) problems.push(`${path}: a ${n.type} needs a content list`);
        else {
          try {
            this.checkContent(n);
          } catch (e) {
            problems.push(`${path}: ${(e as Error).message}`);
          }
          for (let i = 0; i < n.content.length - 1; i++) {
            const a = n.content[i]!;
            const b = n.content[i + 1]!;
            if (a.type === 'text' && b.type === 'text' && sameMarks(a.marks, b.marks)) problems.push(`${path}/${i}: adjacent text with the same marks should be one node`);
          }
          n.content.forEach((c, i) => walk(c, `${path}/${i}`, depth + 1, false));
        }
      }
      const ms = n.marks ?? [];
      for (let i = 0; i < ms.length; i++) {
        const m = ms[i]!;
        const mt = this.marks.get(m.type);
        if (!mt) problems.push(`${path}: unknown mark ${String(m.type)}`);
        else {
          try {
            this.fillAttrs(mt.spec.attrs, m.attrs, `a ${m.type} mark at ${path}`);
          } catch (e) {
            problems.push((e as Error).message);
          }
          if (i > 0) {
            const prev = this.marks.get(ms[i - 1]!.type);
            if (prev && prev.rank >= mt.rank) problems.push(`${path}: marks are not in schema order or repeat`);
            if (prev && (mt.excludedNames.has(prev.name) || prev.excludedNames.has(mt.name))) problems.push(`${path}: the marks ${prev.name} and ${m.type} exclude each other`);
          }
        }
      }
    };
    walk(root, '', 0, true);
    return problems;
  }

  /** Reads untrusted JSON into a valid, normalised document, or throws InvalidContent saying what is wrong. */
  nodeFromJSON(json: unknown, o: { maxNodes?: number } = {}): Node {
    let count = 0;
    const max = o.maxNodes ?? 200_000;
    const read = (j: unknown, depth: number, top: boolean): Node => {
      if (++count > max) throw new InvalidContent(`more than ${max} nodes`);
      if (depth > MAX_DEPTH) throw new InvalidContent(`nested deeper than ${MAX_DEPTH}`);
      if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new InvalidContent('a node is an object');
      const o2 = j as Record<string, unknown>;
      for (const k of Object.keys(o2)) if (!['type', 'attrs', 'content', 'text', 'marks'].includes(k)) throw new InvalidContent(`unknown key ${k} in a node`);
      if (typeof o2.type !== 'string') throw new InvalidContent('a node needs a type');
      const t = this.type(o2.type);
      if (top && t !== this.topNode) throw new InvalidContent(`the top node must be a ${this.topNode.name}`);
      const attrs = o2.attrs === undefined ? undefined : isAttrs(o2.attrs) ? o2.attrs : (() => { throw new InvalidContent('attrs must be an object of plain values'); })();
      let marks: Mark[] | undefined;
      if (o2.marks !== undefined) {
        if (!Array.isArray(o2.marks)) throw new InvalidContent('marks must be a list');
        marks = o2.marks.map((m) => {
          if (typeof m !== 'object' || m === null || Array.isArray(m)) throw new InvalidContent('a mark is an object');
          const mo = m as Record<string, unknown>;
          for (const k of Object.keys(mo)) if (k !== 'type' && k !== 'attrs') throw new InvalidContent(`unknown key ${k} in a mark`);
          if (typeof mo.type !== 'string') throw new InvalidContent('a mark needs a type');
          if (mo.attrs !== undefined && !isAttrs(mo.attrs)) throw new InvalidContent('attrs must be an object of plain values');
          return this.mark(mo.type, mo.attrs as Attrs | undefined);
        });
      }
      if (t.isText) {
        if (typeof o2.text !== 'string') throw new InvalidContent('text nodes hold text');
        if (o2.content !== undefined || o2.attrs !== undefined) throw new InvalidContent('text has no content or attributes');
        return this.text(o2.text, marks);
      }
      if (o2.text !== undefined) throw new InvalidContent('only text nodes hold text');
      let content: Node[] | undefined;
      if (o2.content !== undefined) {
        if (!Array.isArray(o2.content)) throw new InvalidContent('content must be a list');
        content = [];
        for (const c of o2.content) {
          const n = read(c, depth + 1, false);
          const last = content[content.length - 1];
          content.push(n);
          if (last && last.type === 'text' && n.type === 'text' && sameMarks(last.marks, n.marks)) {
            content.splice(content.length - 2, 2, { ...last, text: last.text! + n.text! });
          }
        }
      }
      return this.node(o2.type, attrs, content, marks);
    };
    return read(json, 0, true);
  }
}

const isAttrs = (v: unknown): v is Attrs => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const plain = (x: unknown, d: number): boolean => {
    if (d > 8) return false;
    if (x === null || typeof x === 'string' || typeof x === 'boolean') return true;
    if (typeof x === 'number') return Number.isFinite(x);
    if (Array.isArray(x)) return x.every((y) => plain(y, d + 1));
    if (typeof x === 'object') return Object.keys(x).every((k) => k !== '__proto__' && plain((x as Record<string, unknown>)[k], d + 1));
    return false;
  };
  return plain(v, 0);
};

// ---------------------------------------------------------------------------------------------------------------
// Sizes, fragments, slices

export const isText = (n: Node) => n.type === 'text';
export const nodeSize = (n: Node): number => (n.text !== undefined ? n.text.length : n.content === undefined ? 1 : 2 + fragSize(n.content));
export const fragSize = (f: readonly Node[]): number => {
  let s = 0;
  for (const n of f) s += nodeSize(n);
  return s;
};
const copyNode = (n: Node, content: readonly Node[]): Node => ({ ...n, content });
const withText = (n: Node, text: string): Node => ({ ...n, text });

function cutText(n: Node, from: number, to: number): Node {
  return from === 0 && to === n.text!.length ? n : withText(n, n.text!.slice(from, to));
}

function addNode(child: Node, target: Node[]) {
  const last = target.length - 1;
  if (last >= 0 && isText(child) && isText(target[last]!) && sameMarkup(child, target[last]!)) target[last] = withText(child, target[last]!.text! + child.text!);
  else target.push(child);
}

export function cut(f: readonly Node[], from = 0, to = fragSize(f)): readonly Node[] {
  if (from === 0 && to === fragSize(f)) return f;
  const res: Node[] = [];
  if (to > from) {
    for (let i = 0, pos = 0; pos < to; i++) {
      let child = f[i]!;
      const end = pos + nodeSize(child);
      if (end > from) {
        if (pos < from || end > to) {
          child = isText(child) ? cutText(child, Math.max(0, from - pos), Math.min(child.text!.length, to - pos)) : copyNode(child, cut(child.content ?? [], Math.max(0, from - pos - 1), Math.min(fragSize(child.content ?? []), to - pos - 1)));
        }
        res.push(child);
      }
      pos = end;
    }
  }
  return res;
}

export function append(a: readonly Node[], b: readonly Node[]): Node[] {
  if (!b.length) return [...a];
  if (!a.length) return [...b];
  const res = [...a];
  const [first, ...rest] = b;
  addNode(first!, res);
  res.push(...rest);
  return res;
}

function findIndex(f: readonly Node[], pos: number, round = -1): { index: number; offset: number } {
  if (pos === 0) return { index: 0, offset: pos };
  const size = fragSize(f);
  if (pos === size) return { index: f.length, offset: pos };
  if (pos > size || pos < 0) throw new RangeError(`position ${pos} outside the fragment of size ${size}`);
  for (let i = 0, cur = 0; ; i++) {
    const end = cur + nodeSize(f[i]!);
    if (end >= pos) {
      if (end === pos || round > 0) return { index: i + 1, offset: end };
      return { index: i, offset: cur };
    }
    cur = end;
  }
}

export interface Slice {
  readonly content: readonly Node[];
  readonly openStart: number;
  readonly openEnd: number;
}
export const emptySlice: Slice = { content: [], openStart: 0, openEnd: 0 };
export const sliceSize = (s: Slice) => fragSize(s.content) - s.openStart - s.openEnd;
export const slice = (content: readonly Node[], openStart = 0, openEnd = 0): Slice => ({ content, openStart, openEnd });

export class Pos {
  readonly pos: number;
  readonly path: readonly (Node | number)[];
  readonly depth: number;
  readonly parentOffset: number;
  constructor(pos: number, path: readonly (Node | number)[], parentOffset: number) {
    this.pos = pos;
    this.path = path;
    this.depth = path.length / 3 - 1;
    this.parentOffset = parentOffset;
  }
  get parent(): Node {
    return this.node(this.depth);
  }
  node(d: number): Node {
    return this.path[d * 3] as Node;
  }
  index(d: number): number {
    return this.path[d * 3 + 1] as number;
  }
  indexAfter(d: number): number {
    return this.index(d) + (d === this.depth && !this.textOffset ? 0 : 1);
  }
  start(d: number): number {
    return d === 0 ? 0 : (this.path[d * 3 - 1] as number) + 1;
  }
  end(d: number): number {
    return this.start(d) + fragSize(this.node(d).content ?? []);
  }
  before(d: number): number {
    if (d === 0) throw new RangeError('There is no position before the top-level node');
    return d === this.depth + 1 ? this.pos : (this.path[d * 3 - 1] as number);
  }
  after(d: number): number {
    if (d === 0) throw new RangeError('There is no position after the top-level node');
    return d === this.depth + 1 ? this.pos : (this.path[d * 3 - 1] as number) + nodeSize(this.path[d * 3] as Node);
  }
  get textOffset(): number {
    return this.pos - (this.path[this.path.length - 1] as number);
  }
  get nodeAfter(): Node | null {
    const c = this.parent.content ?? [];
    const i = this.index(this.depth);
    if (i === c.length) return null;
    const d = this.textOffset;
    return d ? cut(c, 0, 0) && cutNode(c[i]!, d) : c[i]!;
  }
  get nodeBefore(): Node | null {
    const c = this.parent.content ?? [];
    const i = this.index(this.depth);
    const d = this.textOffset;
    if (d) return cutNode(c[i]!, 0, d);
    return i === 0 ? null : c[i - 1]!;
  }
  sharedDepth(pos: number): number {
    for (let d = this.depth; d > 0; d--) if (this.start(d) <= pos && this.end(d) >= pos) return d;
    return 0;
  }
}

function cutNode(n: Node, from: number, to = nodeSize(n)): Node {
  if (isText(n)) return cutText(n, from, to);
  return n;
}

export function resolve(doc: Node, pos: number): Pos {
  const size = fragSize(doc.content ?? []);
  if (!Number.isInteger(pos) || pos < 0 || pos > size) throw new RangeError(`Position ${pos} out of range`);
  const path: (Node | number)[] = [];
  let start = 0;
  let parentOffset = pos;
  for (let node = doc; ; ) {
    const { index, offset } = findIndex(node.content ?? [], parentOffset);
    const rem = parentOffset - offset;
    path.push(node, index, start + offset);
    if (!rem) break;
    node = node.content![index]!;
    if (isText(node)) break;
    parentOffset = rem - 1;
    start += offset + 1;
  }
  return new Pos(pos, path, parentOffset);
}

/** The slice of a document between two positions. */
export function sliceOf(doc: Node, from: number, to: number, includeParents = false): Slice {
  if (from === to) return emptySlice;
  const $from = resolve(doc, from);
  const $to = resolve(doc, to);
  const depth = includeParents ? 0 : $from.sharedDepth(to);
  const start = $from.start(depth);
  const node = $from.node(depth);
  return slice(cut(node.content ?? [], from - start, to - start), $from.depth - depth, $to.depth - depth);
}

/** Calls f for each node overlapping from..to, with its position and parent; f may return false to skip its children. */
export function nodesBetween(doc: Node, from: number, to: number, f: (n: Node, pos: number, parent: Node, index: number) => boolean | void): void {
  const go = (parent: Node, offset: number, start: number, end: number) => {
    let pos = 0;
    const content = parent.content ?? [];
    for (let i = 0; pos < end && i < content.length; i++) {
      const child = content[i]!;
      const e = pos + nodeSize(child);
      if (e > start && f(child, offset + pos, parent, i) !== false && child.content?.length) {
        const s = pos + 1;
        go(child, offset + s, Math.max(0, start - s), Math.min(fragSize(child.content), end - s));
      }
      pos = e;
    }
  };
  go(doc, 0, from, to);
}

export function textBetween(schema: Schema, doc: Node, from: number, to: number, blockSeparator = '\n'): string {
  let out = '';
  let first = true;
  nodesBetween(doc, from, to, (n, pos) => {
    if (isText(n)) {
      out += n.text!.slice(Math.max(from, pos) - pos, to - pos);
      first = false;
    } else if (n.content === undefined) {
      first = false;
    } else if (!first && blockSeparator && schema.type(n.type).isBlock) out += blockSeparator;
    return undefined;
  });
  return out;
}

export const textContent = (n: Node): string => (n.text !== undefined ? n.text : (n.content ?? []).map(textContent).join(''));

// ---------------------------------------------------------------------------------------------------------------
// Replace

function checkJoin(schema: Schema, main: Node, sub: Node) {
  if (!schema.type(sub.type).compatible(schema.type(main.type))) throw new ReplaceError(`Cannot join ${sub.type} onto ${main.type}`);
}
function joinable(schema: Schema, $before: Pos, $after: Pos, depth: number): Node {
  const node = $before.node(depth);
  checkJoin(schema, node, $after.node(depth));
  return node;
}
function addRange($start: Pos | null, $end: Pos | null, depth: number, target: Node[]) {
  const node = ($end ?? $start)!.node(depth);
  let startIndex = 0;
  const endIndex = $end ? $end.index(depth) : (node.content ?? []).length;
  if ($start) {
    startIndex = $start.index(depth);
    if ($start.depth > depth) startIndex++;
    else if ($start.textOffset) {
      addNode($start.nodeAfter!, target);
      startIndex++;
    }
  }
  for (let i = startIndex; i < endIndex; i++) addNode(node.content![i]!, target);
  if ($end && $end.depth === depth && $end.textOffset) addNode($end.nodeBefore!, target);
}
function close(schema: Schema, node: Node, content: readonly Node[]): Node {
  const n = copyNode(node, content);
  try {
    schema.checkContent(n);
  } catch (e) {
    throw new ReplaceError((e as Error).message.startsWith('invalid content') ? `Invalid content for node ${node.type}` : (e as Error).message);
  }
  return n;
}
function replaceThreeWay(schema: Schema, $from: Pos, $start: Pos, $end: Pos, $to: Pos, depth: number): Node[] {
  const openStart = $from.depth > depth ? joinable(schema, $from, $start, depth + 1) : null;
  const openEnd = $to.depth > depth ? joinable(schema, $end, $to, depth + 1) : null;
  const content: Node[] = [];
  addRange(null, $from, depth, content);
  if (openStart && openEnd && $start.index(depth) === $end.index(depth)) {
    checkJoin(schema, openStart, openEnd);
    addNode(close(schema, openStart, replaceThreeWay(schema, $from, $start, $end, $to, depth + 1)), content);
  } else {
    if (openStart) addNode(close(schema, openStart, replaceTwoWay(schema, $from, $start, depth + 1)), content);
    addRange($start, $end, depth, content);
    if (openEnd) addNode(close(schema, openEnd, replaceTwoWay(schema, $end, $to, depth + 1)), content);
  }
  addRange($to, null, depth, content);
  return content;
}
function replaceTwoWay(schema: Schema, $from: Pos, $to: Pos, depth: number): Node[] {
  const content: Node[] = [];
  addRange(null, $from, depth, content);
  if ($from.depth > depth) {
    const type = joinable(schema, $from, $to, depth + 1);
    addNode(close(schema, type, replaceTwoWay(schema, $from, $to, depth + 1)), content);
  }
  addRange($to, null, depth, content);
  return content;
}
function prepareSliceForReplace(doc: Node, s: Slice, $along: Pos): { start: Pos; end: Pos } {
  const extra = $along.depth - s.openStart;
  const parent = $along.node(extra);
  let node = copyNode(parent, s.content);
  for (let i = extra - 1; i >= 0; i--) node = copyNode($along.node(i), [node]);
  return { start: resolve(node, s.openStart + extra), end: resolve(node, fragSize(node.content ?? []) - s.openEnd - extra) };
}
function replaceOuter(schema: Schema, doc: Node, $from: Pos, $to: Pos, s: Slice, depth: number): Node {
  const index = $from.index(depth);
  const node = $from.node(depth);
  if (index === $to.index(depth) && depth < $from.depth - s.openStart) {
    const inner = replaceOuter(schema, doc, $from, $to, s, depth + 1);
    const content = [...node.content!];
    content[index] = inner;
    return copyNode(node, content);
  } else if (!fragSize(s.content)) {
    return close(schema, node, replaceTwoWay(schema, $from, $to, depth));
  } else if (!s.openStart && !s.openEnd && $from.depth === depth && $to.depth === depth) {
    const parent = $from.parent;
    const content = parent.content ?? [];
    return close(schema, parent, append(append(cut(content, 0, $from.parentOffset), s.content), cut(content, $to.parentOffset)));
  }
  const { start, end } = prepareSliceForReplace(doc, s, $from);
  return close(schema, node, replaceThreeWay(schema, $from, start, end, $to, depth));
}

/** Replaces from..to with a slice, as ProseMirror does; throws ReplaceError for anything the schema refuses. */
export function replace(schema: Schema, doc: Node, from: number, to: number, s: Slice): Node {
  const $from = resolve(doc, from);
  const $to = resolve(doc, to);
  if (s.openStart > $from.depth) throw new ReplaceError('Inserted content deeper than insertion position');
  if ($from.depth - s.openStart !== $to.depth - s.openEnd) throw new ReplaceError('Inconsistent open depths');
  return replaceOuter(schema, doc, $from, $to, s, 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Step maps and mappings

const DEL_BEFORE = 1;
const DEL_AFTER = 2;
const DEL_ACROSS = 4;
const DEL_SIDE = 8;
const FACTOR = 2 ** 16;
const makeRecover = (index: number, offset: number) => index + offset * FACTOR;
const recoverIndex = (v: number) => v & 0xffff;
const recoverOffset = (v: number) => (v - (v & 0xffff)) / FACTOR;

export class MapResult {
  readonly pos: number;
  readonly delInfo: number;
  readonly recover: number | null;
  constructor(pos: number, delInfo: number, recover: number | null) {
    this.pos = pos;
    this.delInfo = delInfo;
    this.recover = recover;
  }
  get deleted(): boolean {
    return (this.delInfo & DEL_SIDE) > 0;
  }
  get deletedBefore(): boolean {
    return (this.delInfo & (DEL_BEFORE | DEL_ACROSS)) > 0;
  }
  get deletedAfter(): boolean {
    return (this.delInfo & (DEL_AFTER | DEL_ACROSS)) > 0;
  }
  get deletedAcross(): boolean {
    return (this.delInfo & DEL_ACROSS) > 0;
  }
}

/** How one step moved positions: ranges of [start, oldSize, newSize]. */
export class StepMap {
  readonly ranges: readonly number[];
  readonly inverted: boolean;
  constructor(ranges: readonly number[], inverted = false) {
    this.ranges = ranges;
    this.inverted = inverted;
  }
  static readonly empty = new StepMap([]);
  recover(value: number): number {
    let diff = 0;
    const index = recoverIndex(value);
    if (!this.inverted) for (let i = 0; i < index; i++) diff += this.ranges[i * 3 + 2]! - this.ranges[i * 3 + 1]!;
    return this.ranges[index * 3]! + diff + recoverOffset(value);
  }
  mapResult(pos: number, assoc = 1): MapResult {
    return this.run(pos, assoc, false) as MapResult;
  }
  map(pos: number, assoc = 1): number {
    return this.run(pos, assoc, true) as number;
  }
  private run(pos: number, assoc: number, simple: boolean): MapResult | number {
    let diff = 0;
    const oldIndex = this.inverted ? 2 : 1;
    const newIndex = this.inverted ? 1 : 2;
    for (let i = 0; i < this.ranges.length; i += 3) {
      const start = this.ranges[i]! - (this.inverted ? diff : 0);
      if (start > pos) break;
      const oldSize = this.ranges[i + oldIndex]!;
      const newSize = this.ranges[i + newIndex]!;
      const end = start + oldSize;
      if (pos <= end) {
        const side = !oldSize ? assoc : pos === start ? -1 : pos === end ? 1 : assoc;
        const result = start + diff + (side < 0 ? 0 : newSize);
        if (simple) return result;
        const recover = pos === (assoc < 0 ? start : end) ? null : makeRecover(i / 3, pos - start);
        let del = pos === start ? DEL_AFTER : pos === end ? DEL_BEFORE : DEL_ACROSS;
        if (assoc < 0 ? pos !== start : pos !== end) del |= DEL_SIDE;
        return new MapResult(result, del, recover);
      }
      diff += newSize - oldSize;
    }
    return simple ? pos + diff : new MapResult(pos + diff, 0, null);
  }
  invert(): StepMap {
    return new StepMap(this.ranges, !this.inverted);
  }
  forEach(f: (oldStart: number, oldEnd: number, newStart: number, newEnd: number) => void): void {
    const oldIndex = this.inverted ? 2 : 1;
    const newIndex = this.inverted ? 1 : 2;
    for (let i = 0, diff = 0; i < this.ranges.length; i += 3) {
      const start = this.ranges[i]!;
      const oldStart = start - (this.inverted ? diff : 0);
      const newStart = start + (this.inverted ? 0 : diff);
      const oldSize = this.ranges[i + oldIndex]!;
      const newSize = this.ranges[i + newIndex]!;
      f(oldStart, oldStart + oldSize, newStart, newStart + newSize);
      diff += newSize - oldSize;
    }
  }
}

/** A chain of step maps; mirrors say that a later map undoes an earlier one, so positions can be recovered. */
export class Mapping {
  readonly maps: StepMap[];
  private mirror: number[] | undefined;
  readonly from: number;
  to: number;
  constructor(maps: StepMap[] = [], mirror?: number[], from = 0, to = maps.length) {
    this.maps = maps;
    this.mirror = mirror;
    this.from = from;
    this.to = to;
  }
  slice(from = 0, to = this.maps.length): Mapping {
    return new Mapping(this.maps, this.mirror, from, to);
  }
  appendMap(map: StepMap, mirrors?: number): void {
    this.maps.push(map);
    this.to = this.maps.length;
    if (mirrors !== undefined) this.setMirror(this.maps.length - 1, mirrors);
  }
  /** The mirror pairs as [a, b] index pairs, for building another mapping from part of this one. */
  mirrorPairs(): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; this.mirror && i < this.mirror.length; i += 2) out.push([this.mirror[i]!, this.mirror[i + 1]!]);
    return out;
  }
  getMirror(n: number): number | undefined {
    if (this.mirror) for (let i = 0; i < this.mirror.length; i++) if (this.mirror[i] === n) return this.mirror[i + (i % 2 ? -1 : 1)];
    return undefined;
  }
  setMirror(n: number, m: number): void {
    (this.mirror ??= []).push(n, m);
  }
  map(pos: number, assoc = 1): number {
    return this.run(pos, assoc, true) as number;
  }
  mapResult(pos: number, assoc = 1): MapResult {
    return this.run(pos, assoc, false) as MapResult;
  }
  private run(pos: number, assoc: number, simple: boolean): MapResult | number {
    let delInfo = 0;
    for (let i = this.from; i < this.to; i++) {
      const map = this.maps[i]!;
      const result = map.mapResult(pos, assoc);
      if (result.recover !== null) {
        const corr = this.getMirror(i);
        if (corr !== undefined && corr > i && corr < this.to) {
          i = corr;
          pos = this.maps[corr]!.recover(result.recover);
          continue;
        }
      }
      delInfo |= result.delInfo;
      pos = result.pos;
    }
    return simple ? pos : new MapResult(pos, delInfo, null);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Steps

export type StepResult = { readonly doc: Node } | { readonly failed: string };

/** The nodes a slice brings must be valid wherever they are closed; the open edges are checked once joined. */
function checkSlice(schema: Schema, s: Slice): void {
  const go = (n: Node, openL: number, openR: number) => {
    if (isText(n)) return;
    const kids = n.content ?? [];
    if (openL === 0 && openR === 0) schema.checkContent(n);
    kids.forEach((c, i) => go(c, i === 0 ? Math.max(openL - 1, 0) : 0, i === kids.length - 1 ? Math.max(openR - 1, 0) : 0));
  };
  s.content.forEach((n, i) => go(n, i === 0 ? s.openStart : 0, i === s.content.length - 1 ? s.openEnd : 0));
}

function fromReplace(schema: Schema, doc: Node, from: number, to: number, s: Slice): StepResult {
  try {
    checkSlice(schema, s);
    return { doc: replace(schema, doc, from, to, s) };
  } catch (e) {
    if (e instanceof ReplaceError || e instanceof RangeError || e instanceof InvalidContent) return { failed: e.message };
    throw e;
  }
}

export interface StepJSON {
  readonly stepType: 'replace' | 'replaceAround' | 'addMark' | 'removeMark' | 'attr';
  readonly [k: string]: Json;
}

export interface Step {
  readonly kind: StepJSON['stepType'];
  apply(schema: Schema, doc: Node): StepResult;
  getMap(): StepMap;
  invert(schema: Schema, doc: Node): Step;
  /** The step as it should apply after `mapping`, or null if what it touched is gone. */
  map(mapping: Mapping): Step | null;
  toJSON(): StepJSON;
}

const sliceJSON = (s: Slice): Json => (s.content.length ? ({ content: s.content as unknown as Json, openStart: s.openStart, openEnd: s.openEnd } as Json) : null);
const sliceFromJSON = (schema: Schema, j: unknown): Slice => {
  if (j === null || j === undefined) return emptySlice;
  if (typeof j !== 'object' || Array.isArray(j)) throw new InvalidContent('a slice is an object');
  const o = j as Record<string, unknown>;
  const { openStart = 0, openEnd = 0 } = o;
  if (!Number.isInteger(openStart) || !Number.isInteger(openEnd) || (openStart as number) < 0 || (openEnd as number) < 0) throw new InvalidContent('open depths are whole numbers');
  if (!Array.isArray(o.content)) throw new InvalidContent('a slice has content');
  return slice(o.content.map((c) => readLoose(schema, c, 0)), openStart as number, openEnd as number);
};
/** Reads a node of a slice: any type but not checked for a full content match, since slices are open. */
function readLoose(schema: Schema, j: unknown, depth: number): Node {
  if (depth > MAX_DEPTH) throw new InvalidContent('nested too deeply');
  if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new InvalidContent('a node is an object');
  const o = j as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!['type', 'attrs', 'content', 'text', 'marks'].includes(k)) throw new InvalidContent(`unknown key ${k} in a node`);
  if (typeof o.type !== 'string') throw new InvalidContent('a node needs a type');
  const t = schema.type(o.type);
  const marks = Array.isArray(o.marks) ? o.marks.map((m) => schema.mark((m as { type: string }).type, (m as { attrs?: Attrs }).attrs)) : undefined;
  if (o.marks !== undefined && !marks) throw new InvalidContent('marks must be a list');
  if (o.attrs !== undefined && !isAttrs(o.attrs)) throw new InvalidContent('attrs must be an object of plain values');
  if (t.isText) {
    if (typeof o.text !== 'string') throw new InvalidContent('text nodes hold text');
    return schema.text(o.text, marks);
  }
  if (o.content !== undefined && !Array.isArray(o.content)) throw new InvalidContent('content must be a list');
  return schema.node(o.type, o.attrs as Attrs | undefined, o.content === undefined ? undefined : (o.content as unknown[]).map((c) => readLoose(schema, c, depth + 1)), marks, { unchecked: true });
}

const wholeNumbers = (...n: number[]) => n.every((x) => Number.isInteger(x) && x >= 0);

export class ReplaceStep implements Step {
  readonly kind = 'replace' as const;
  readonly from: number;
  readonly to: number;
  readonly slice: Slice;
  constructor(from: number, to: number, s: Slice) {
    if (!wholeNumbers(from, to) || to < from) throw new TransformError('a replace step needs from <= to, both whole numbers');
    this.from = from;
    this.to = to;
    this.slice = s;
  }
  apply(schema: Schema, doc: Node): StepResult {
    return fromReplace(schema, doc, this.from, this.to, this.slice);
  }
  getMap(): StepMap {
    return new StepMap([this.from, this.to - this.from, sliceSize(this.slice)]);
  }
  invert(_schema: Schema, doc: Node): Step {
    return new ReplaceStep(this.from, this.from + sliceSize(this.slice), sliceOf(doc, this.from, this.to));
  }
  map(mapping: Mapping): Step | null {
    const from = mapping.mapResult(this.from, 1);
    const to = mapping.mapResult(this.to, -1);
    if (from.deletedAcross && to.deletedAcross) return null;
    return new ReplaceStep(from.pos, Math.max(from.pos, to.pos), this.slice);
  }
  toJSON(): StepJSON {
    return { stepType: 'replace', from: this.from, to: this.to, slice: sliceJSON(this.slice) };
  }
}

export class ReplaceAroundStep implements Step {
  readonly kind = 'replaceAround' as const;
  readonly from: number;
  readonly to: number;
  readonly gapFrom: number;
  readonly gapTo: number;
  readonly slice: Slice;
  readonly insert: number;
  constructor(from: number, to: number, gapFrom: number, gapTo: number, s: Slice, insert: number) {
    if (!wholeNumbers(from, to, gapFrom, gapTo, insert) || from > gapFrom || gapFrom > gapTo || gapTo > to) throw new TransformError('a replace-around step needs from <= gapFrom <= gapTo <= to');
    this.from = from;
    this.to = to;
    this.gapFrom = gapFrom;
    this.gapTo = gapTo;
    this.slice = s;
    this.insert = insert;
  }
  apply(schema: Schema, doc: Node): StepResult {
    if (this.gapTo > this.to) return { failed: 'Structure gap-replace would overwrite content' };
    const gap = sliceOf(doc, this.gapFrom, this.gapTo);
    if (gap.openStart || gap.openEnd) return { failed: 'Gap is not a flat range' };
    const inserted = insertInto(this.slice.content, this.insert + this.slice.openStart, gap.content);
    if (!inserted) return { failed: 'Content does not fit in gap' };
    return fromReplace(schema, doc, this.from, this.to, slice(inserted, this.slice.openStart, this.slice.openEnd));
  }
  getMap(): StepMap {
    return new StepMap([this.from, this.gapFrom - this.from, this.insert, this.gapTo, this.to - this.gapTo, sliceSize(this.slice) - this.insert]);
  }
  invert(_schema: Schema, doc: Node): Step {
    const gap = this.gapTo - this.gapFrom;
    const kept = removeBetween(sliceOf(doc, this.from, this.to), this.gapFrom - this.from, this.gapTo - this.from);
    return new ReplaceAroundStep(this.from, this.from + sliceSize(this.slice) + gap, this.from + this.insert, this.from + this.insert + gap, kept, this.gapFrom - this.from);
  }
  map(mapping: Mapping): Step | null {
    const from = mapping.mapResult(this.from, 1);
    const to = mapping.mapResult(this.to, -1);
    const gapFrom = this.from === this.gapFrom ? from.pos : mapping.map(this.gapFrom, -1);
    const gapTo = this.to === this.gapTo ? to.pos : mapping.map(this.gapTo, 1);
    if ((from.deletedAcross && to.deletedAcross) || gapFrom < from.pos || gapTo > to.pos) return null;
    return new ReplaceAroundStep(from.pos, to.pos, gapFrom, gapTo, this.slice, this.insert);
  }
  toJSON(): StepJSON {
    return { stepType: 'replaceAround', from: this.from, to: this.to, gapFrom: this.gapFrom, gapTo: this.gapTo, insert: this.insert, slice: sliceJSON(this.slice) };
  }
}

function insertInto(content: readonly Node[], dist: number, insert: readonly Node[]): readonly Node[] | null {
  const { index, offset } = findIndex(content, dist);
  const child = content[index];
  if (offset === dist || (child && isText(child))) return append(append(cut(content, 0, dist), insert), cut(content, dist));
  if (!child) return null;
  const inner = insertInto(child.content ?? [], dist - offset - 1, insert);
  if (!inner) return null;
  const c = [...content];
  c[index] = copyNode(child, inner);
  return c;
}

function removeRange(content: readonly Node[], from: number, to: number): readonly Node[] {
  const { index, offset } = findIndex(content, from);
  const child = content[index];
  const { index: indexTo, offset: offsetTo } = findIndex(content, to);
  if (offset === from || (child && isText(child))) {
    if (offsetTo !== to && !isText(content[indexTo]!)) throw new RangeError('Removing non-flat range');
    return append(cut(content, 0, from), cut(content, to));
  }
  if (index !== indexTo || !child) throw new RangeError('Removing non-flat range');
  const c = [...content];
  c[index] = copyNode(child, removeRange(child.content ?? [], from - offset - 1, to - offset - 1));
  return c;
}
const removeBetween = (s: Slice, from: number, to: number): Slice => slice(removeRange(s.content, from + s.openStart, to + s.openStart), s.openStart, s.openEnd);

function mapFragment(f: readonly Node[], g: (n: Node, parent: Node) => Node, parent: Node): Node[] {
  return f.map((child) => {
    let c = g(child, parent);
    if (c.content?.length) c = copyNode(c, mapFragment(c.content, g, c));
    return c;
  });
}

abstract class MarkStep implements Step {
  abstract readonly kind: 'addMark' | 'removeMark';
  readonly from: number;
  readonly to: number;
  readonly mark: Mark;
  constructor(from: number, to: number, mark: Mark) {
    if (!wholeNumbers(from, to) || to < from) throw new TransformError('a mark step needs from <= to, both whole numbers');
    this.from = from;
    this.to = to;
    this.mark = mark;
  }
  protected abstract change(schema: Schema, marks: readonly Mark[]): readonly Mark[];
  apply(schema: Schema, doc: Node): StepResult {
    try {
      const old = sliceOf(doc, this.from, this.to);
      const $from = resolve(doc, this.from);
      const parent = $from.node($from.sharedDepth(this.to));
      const content = mapFragment(
        old.content,
        (n, p) => {
          if (!(isText(n) || (schema.type(n.type).isInline && schema.type(n.type).isLeaf))) return n;
          if (!schema.type(p.type).markNames.has(this.mark.type)) return n;
          const marks = this.change(schema, n.marks ?? []);
          return marks === (n.marks ?? []) || (marks.length === 0 && !n.marks?.length) ? n : { ...n, marks: marks.length ? marks : undefined } as Node;
        },
        parent,
      ).map(stripUndefined);
      return fromReplace(schema, doc, this.from, this.to, slice(joinText(content), old.openStart, old.openEnd));
    } catch (e) {
      if (e instanceof RangeError) return { failed: e.message };
      throw e;
    }
  }
  getMap(): StepMap {
    return StepMap.empty;
  }
  protected abstract opposite(): Step;
  /** The opposite mark step when it undoes this one exactly; otherwise a replace that puts the old content back. */
  invert(schema: Schema, doc: Node): Step {
    const done = this.apply(schema, doc);
    const opp = this.opposite();
    if (!('failed' in done)) {
      const back = opp.apply(schema, done.doc);
      if (!('failed' in back) && JSON.stringify(sliceOf(back.doc, this.from, this.to)) === JSON.stringify(sliceOf(doc, this.from, this.to))) return opp;
    }
    return new ReplaceStep(this.from, this.to, sliceOf(doc, this.from, this.to));
  }
  abstract map(mapping: Mapping): Step | null;
  protected mapRange(mapping: Mapping): { from: number; to: number } | null {
    const from = mapping.mapResult(this.from, 1);
    const to = mapping.mapResult(this.to, -1);
    if ((from.deleted && to.deleted) || from.pos >= to.pos) return null;
    return { from: from.pos, to: to.pos };
  }
  toJSON(): StepJSON {
    return { stepType: this.kind, mark: this.mark as unknown as Json, from: this.from, to: this.to };
  }
}

function stripUndefined(n: Node): Node {
  const o: Record<string, unknown> = { ...n };
  if (o.marks === undefined) delete o.marks;
  if (n.content) o.content = n.content.map(stripUndefined);
  return o as unknown as Node;
}
function joinText(f: readonly Node[]): Node[] {
  const out: Node[] = [];
  for (const n of f) addNode(n.content ? { ...n, content: joinText(n.content) } : n, out);
  return out;
}

export class AddMarkStep extends MarkStep {
  readonly kind = 'addMark' as const;
  protected change(schema: Schema, marks: readonly Mark[]) {
    return schema.addToSet(marks, this.mark);
  }
  protected opposite(): Step {
    return new RemoveMarkStep(this.from, this.to, this.mark);
  }
  map(mapping: Mapping): Step | null {
    const r = this.mapRange(mapping);
    return r && new AddMarkStep(r.from, r.to, this.mark);
  }
}
export class RemoveMarkStep extends MarkStep {
  readonly kind = 'removeMark' as const;
  protected change(schema: Schema, marks: readonly Mark[]) {
    return schema.removeFromSet(marks, this.mark);
  }
  protected opposite(): Step {
    return new AddMarkStep(this.from, this.to, this.mark);
  }
  map(mapping: Mapping): Step | null {
    const r = this.mapRange(mapping);
    return r && new RemoveMarkStep(r.from, r.to, this.mark);
  }
}

/** Sets one attribute of the node that starts at `pos`. */
export class AttrStep implements Step {
  readonly kind = 'attr' as const;
  readonly pos: number;
  readonly attr: string;
  readonly value: Json;
  constructor(pos: number, attr: string, value: Json) {
    if (!wholeNumbers(pos)) throw new TransformError('an attribute step needs a whole position');
    this.pos = pos;
    this.attr = attr;
    this.value = value;
  }
  apply(schema: Schema, doc: Node): StepResult {
    let $pos: Pos;
    try {
      $pos = resolve(doc, this.pos);
    } catch (e) {
      return { failed: (e as Error).message };
    }
    const node = $pos.nodeAfter;
    if (!node || isText(node) || $pos.textOffset) return { failed: 'No node at attribute step position' };
    const spec = schema.type(node.type).spec.attrs;
    if (!spec || !Object.hasOwn(spec, this.attr)) return { failed: `${node.type} has no attribute ${this.attr}` };
    if (spec[this.attr]!.validate && !spec[this.attr]!.validate!(this.value)) return { failed: `${node.type} does not accept that ${this.attr}` };
    const next: Node = { ...node, attrs: { ...(node.attrs ?? {}), [this.attr]: this.value } };
    const content = [...$pos.parent.content!];
    content[$pos.index($pos.depth)] = next;
    const rebuilt = fromReplace(schema, doc, $pos.start($pos.depth), $pos.end($pos.depth), slice(content, 0, 0));
    return rebuilt;
  }
  getMap(): StepMap {
    return StepMap.empty;
  }
  invert(_schema: Schema, doc: Node): Step {
    const node = resolve(doc, this.pos).nodeAfter;
    return new AttrStep(this.pos, this.attr, (node?.attrs?.[this.attr] ?? null) as Json);
  }
  map(mapping: Mapping): Step | null {
    const pos = mapping.mapResult(this.pos, 1);
    return pos.deletedAfter ? null : new AttrStep(pos.pos, this.attr, this.value);
  }
  toJSON(): StepJSON {
    return { stepType: 'attr', pos: this.pos, attr: this.attr, value: this.value };
  }
}

/** Reads a step from untrusted JSON. */
export function stepFromJSON(schema: Schema, json: unknown): Step {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new TransformError('a step is an object');
  const j = json as Record<string, unknown>;
  const num = (k: string) => {
    const v = j[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new TransformError(`${k} must be a whole number`);
    return v;
  };
  const mark = () => {
    const m = j.mark as { type?: unknown; attrs?: Attrs } | undefined;
    if (!m || typeof m.type !== 'string') throw new TransformError('a mark step needs a mark');
    return schema.mark(m.type, m.attrs);
  };
  try {
    switch (j.stepType) {
      case 'replace':
        return new ReplaceStep(num('from'), num('to'), sliceFromJSON(schema, j.slice));
      case 'replaceAround':
        return new ReplaceAroundStep(num('from'), num('to'), num('gapFrom'), num('gapTo'), sliceFromJSON(schema, j.slice), num('insert'));
      case 'addMark':
        return new AddMarkStep(num('from'), num('to'), mark());
      case 'removeMark':
        return new RemoveMarkStep(num('from'), num('to'), mark());
      case 'attr': {
        if (typeof j.attr !== 'string') throw new TransformError('an attribute step needs a name');
        if (!isAttrs({ v: j.value })) throw new TransformError('the value must be plain JSON');
        return new AttrStep(num('pos'), j.attr, j.value as Json);
      }
      default:
        throw new TransformError(`unknown step type ${String(j.stepType)}`);
    }
  } catch (e) {
    if (e instanceof InvalidContent) throw new TransformError(e.message);
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Transform

export class Transform {
  readonly schema: Schema;
  doc: Node;
  readonly steps: Step[] = [];
  readonly docs: Node[] = [];
  readonly mapping = new Mapping();
  readonly before: Node;
  constructor(schema: Schema, doc: Node) {
    this.schema = schema;
    this.doc = doc;
    this.before = doc;
  }
  get docChanged(): boolean {
    return this.steps.length > 0;
  }
  /** Tries a step; on failure the transform is unchanged. */
  maybeStep(step: Step): StepResult {
    const r = step.apply(this.schema, this.doc);
    if (!('failed' in r)) {
      this.docs.push(this.doc);
      this.steps.push(step);
      this.mapping.appendMap(step.getMap());
      this.doc = r.doc;
    }
    return r;
  }
  step(step: Step): this {
    const r = this.maybeStep(step);
    if ('failed' in r) throw new TransformError(r.failed);
    return this;
  }
  /** Steps that undo everything done here, last first, ready to apply to the current document. */
  inverted(): Step[] {
    return this.steps.map((s, i) => s.invert(this.schema, this.docs[i]!)).reverse();
  }

  replace(from: number, to = from, s: Slice = emptySlice): this {
    return this.step(new ReplaceStep(from, to, s));
  }
  replaceWith(from: number, to: number, nodes: Node | readonly Node[]): this {
    return this.replace(from, to, slice(Array.isArray(nodes) ? nodes : [nodes as Node]));
  }
  delete(from: number, to: number): this {
    return this.replace(from, to, emptySlice);
  }
  insert(pos: number, nodes: Node | readonly Node[]): this {
    return this.replaceWith(pos, pos, nodes);
  }
  insertText(pos: number, text: string, marks?: readonly Mark[]): this {
    return this.insert(pos, this.schema.text(text, marks));
  }

  addMark(from: number, to: number, mark: Mark): this {
    const m = this.schema.mark(mark.type, mark.attrs);
    const removed: Step[] = [];
    const added: AddMarkStep[] = [];
    let removing: { from: number; to: number; mark: Mark } | null = null;
    let adding: AddMarkStep | null = null;
    const removals: { from: number; to: number; mark: Mark }[] = [];
    nodesBetween(this.doc, from, to, (node, pos, parent) => {
      const t = this.schema.type(node.type);
      if (!t.isInline) return undefined;
      const marks = node.marks ?? [];
      if (!marks.some((x) => sameMark(x, m)) && this.schema.type(parent.type).markNames.has(m.type)) {
        const start = Math.max(pos, from);
        const end = Math.min(pos + nodeSize(node), to);
        const next = this.schema.addToSet(marks, m);
        for (const old of marks) {
          if (!next.some((x) => sameMark(x, old))) {
            if (removing && removing.to === start && sameMark(removing.mark, old)) removing.to = end;
            else removals.push((removing = { from: start, to: end, mark: old }));
          }
        }
        if (adding && adding.to === start) adding = new AddMarkStep(adding.from, end, m), added[added.length - 1] = adding;
        else added.push((adding = new AddMarkStep(start, end, m)));
      }
      return undefined;
    });
    for (const r of removals) removed.push(new RemoveMarkStep(r.from, r.to, r.mark));
    for (const s of removed) this.step(s);
    for (const s of added) this.step(s);
    return this;
  }

  /** Removes a mark (exactly), or every mark of a type when given its name, or all marks when given nothing. */
  removeMark(from: number, to: number, mark?: Mark | string): this {
    const found: { from: number; to: number; mark: Mark }[] = [];
    nodesBetween(this.doc, from, to, (node, pos) => {
      if (!this.schema.type(node.type).isInline) return undefined;
      const start = Math.max(pos, from);
      const end = Math.min(pos + nodeSize(node), to);
      for (const m of node.marks ?? []) {
        const hit = mark === undefined || (typeof mark === 'string' ? m.type === mark : sameMark(m, mark));
        if (!hit) continue;
        const last = found[found.length - 1];
        if (last && last.to === start && sameMark(last.mark, m)) last.to = end;
        else found.push({ from: start, to: end, mark: m });
      }
      return undefined;
    });
    for (const f of found) this.step(new RemoveMarkStep(f.from, f.to, f.mark));
    return this;
  }

  setNodeAttr(pos: number, attr: string, value: Json): this {
    return this.step(new AttrStep(pos, attr, value));
  }

  /** Splits the node(s) around pos, `depth` levels up. */
  split(pos: number, depth = 1, typesAfter?: readonly ({ type: string; attrs?: Attrs } | null)[]): this {
    const $pos = resolve(this.doc, pos);
    if (depth < 1 || depth > $pos.depth) throw new TransformError('cannot split that deep');
    let before: Node[] = [];
    let after: Node[] = [];
    for (let d = $pos.depth, e = $pos.depth - depth, i = depth - 1; d > e; d--, i--) {
      before = [copyNode($pos.node(d), before)];
      const ta = typesAfter?.[i];
      after = [ta ? this.schema.node(ta.type, ta.attrs, after, undefined, { unchecked: true }) : copyNode($pos.node(d), after)];
    }
    return this.step(new ReplaceStep(pos, pos, slice(append(before, after), depth, depth)));
  }

  /** Joins the nodes on either side of pos. */
  join(pos: number, depth = 1): this {
    return this.step(new ReplaceStep(pos - depth, pos + depth, emptySlice));
  }

  /** Wraps the nodes from..to (children of one parent) in a new node. */
  wrap(from: number, to: number, type: string, attrs?: Attrs): this {
    const $from = resolve(this.doc, from);
    const $to = resolve(this.doc, to);
    const d = $from.sharedDepth(to);
    if ($from.start(d) > from || $to.end(d) < to || $from.parentOffset !== from - $from.start($from.depth)) throw new TransformError('bad range');
    const start = $from.depth > d ? $from.before(d + 1) : from;
    const end = $to.depth > d ? $to.after(d + 1) : to;
    const wrapper = this.schema.node(type, attrs, [], undefined, { unchecked: true });
    return this.step(new ReplaceAroundStep(start, end, start, end, slice([wrapper], 0, 0), 1));
  }

  /** Lifts the children of one parent between from and to out of it, splitting the parent if the range is not all of it. */
  lift(from: number, to: number): this {
    const $from = resolve(this.doc, from);
    const $to = resolve(this.doc, to);
    const depth = $from.sharedDepth(to);
    if (depth < 1) throw new TransformError('there is nothing to lift out of');
    const gapStart = $from.depth > depth ? $from.before(depth + 1) : from;
    const gapEnd = $to.depth > depth ? $to.after(depth + 1) : to;
    let start = gapStart;
    let end = gapEnd;
    let before: Node[] = [];
    let openStart = 0;
    let splitting = false;
    const target = depth - 1;
    for (let d = depth; d > target; d--) {
      const idx = d === depth ? $from.index(d) + ($from.depth > d ? 0 : 0) : $from.index(d);
      if (splitting || (d === depth ? $from.index(d) > 0 && gapStart > $from.start(d) : idx > 0)) {
        splitting = true;
        before = [copyNode($from.node(d), before)];
        openStart++;
      } else start--;
    }
    let after: Node[] = [];
    let openEnd = 0;
    splitting = false;
    for (let d = depth; d > target; d--) {
      if (splitting || gapEnd < $from.end(d)) {
        splitting = true;
        after = [copyNode($from.node(d), after)];
        openEnd++;
      } else end++;
    }
    return this.step(new ReplaceAroundStep(start, end, gapStart, gapEnd, slice(append(before, after), openStart, openEnd), fragSize(before) - openStart));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// HTML

const SAFE_SCHEMES = ['http', 'https', 'mailto', 'tel'];

/** The URL a link or image may carry, or null if it must not be written. */
export function safeUrl(raw: string, schemes: readonly string[] = SAFE_SCHEMES): string | null {
  return cleanUrl(raw, { schemes, allowRelative: true });
}

function writeHtml(schema: Schema, n: Node): string {
  if (isText(n)) {
    let s = escapeText(n.text!);
    const marks = (n.marks ?? []).slice().reverse();
    for (const m of marks) {
      const o = schema.marks.get(m.type)?.spec.toHTML?.(m);
      if (!o) continue;
      s = `<${o.tag}${attrString(o.attrs)}>${s}</${o.tag}>`;
    }
    return s;
  }
  const t = schema.type(n.type);
  const o = t.spec.toHTML?.(n);
  const inner = (n.content ?? []).map((c) => writeHtml(schema, c)).join('');
  let s: string;
  if (!o) s = inner;
  else if (t.spec.void || t.isLeaf) s = `<${o.tag}${attrString(o.attrs)}>`;
  else s = `<${o.tag}${attrString(o.attrs)}>${inner}</${o.tag}>`;
  return s;
}
const attrString = (a?: Readonly<Record<string, string>>) =>
  Object.entries(a ?? {})
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('');

/** The document (or any node) as escaped HTML. Marks nest in schema order, outermost first. */
export function toHTML(schema: Schema, n: Node): string {
  return writeHtml(schema, n);
}

interface Ctx {
  readonly schema: Schema;
  readonly marks: readonly Mark[];
  readonly pre: boolean;
}

function policyFor(schema: Schema): Policy {
  const tags: Record<string, string[]> = {};
  const add = (rules: readonly HtmlRule[] | undefined) => {
    for (const r of rules ?? []) tags[r.tag] ??= ['href', 'title', 'src', 'alt', 'start', 'width', 'height'].filter(Boolean);
  };
  for (const t of schema.nodes.values()) add(t.spec.parseHTML);
  for (const m of schema.marks.values()) add(m.spec.parseHTML);
  return { tags, schemes: { href: SAFE_SCHEMES, src: ['http', 'https'] }, allowRelative: true, maxInput: 2_000_000 };
}

/**
 * Reads HTML into a document of the schema. The HTML goes through the sanitiser first, with a policy made from the
 * schema, so scripts, handlers and unsafe addresses never reach the document; then elements become nodes and marks by
 * the schema's rules and everything else is unwrapped, and what is left is fitted to the schema.
 */
export function fromHTML(schema: Schema, html: string): Node {
  const clean = sanitize(html, policyFor(schema));
  const tree = parseHtml(clean);
  const top = schema.topNode;
  const kids = readChildren(tree.children, { schema, marks: [], pre: false });
  return fit(schema, top, kids, true);
}

function ruleFor(rules: readonly HtmlRule[] | undefined, el: HtmlElement): { rule: HtmlRule; attrs: Attrs } | null {
  for (const r of rules ?? []) {
    if (r.tag !== el.tag) continue;
    const a = typeof r.attrs === 'function' ? r.attrs(el) : (r.attrs ?? {});
    if (a !== false) return { rule: r, attrs: a };
  }
  return null;
}

function readChildren(nodes: readonly HtmlNode[], ctx: Ctx): Node[] {
  const out: Node[] = [];
  for (const n of nodes) {
    if (n.type === 'text') {
      const text = ctx.pre ? n.value : n.value.replace(/[ \t\r\n\f]+/g, ' ');
      if (text) out.push({ type: 'text', text, ...(ctx.marks.length ? { marks: ctx.marks } : {}) });
    } else if (n.type === 'element') out.push(...readElement(n, ctx));
  }
  return out;
}

function readElement(el: HtmlElement, ctx: Ctx): Node[] {
  const { schema } = ctx;
  for (const mt of schema.marks.values()) {
    const hit = ruleFor(mt.spec.parseHTML, el);
    if (hit) {
      let mark: Mark;
      try {
        mark = schema.mark(mt.name, hit.attrs);
      } catch {
        return readChildren(el.children, ctx);
      }
      return readChildren(el.children, { ...ctx, marks: [...schema.addToSet(ctx.marks, mark)] });
    }
  }
  for (const t of schema.nodes.values()) {
    const hit = ruleFor(t.spec.parseHTML, el);
    if (!hit) continue;
    let node: Node;
    try {
      const kids = t.isLeaf ? [] : readChildren(el.children, { ...ctx, pre: ctx.pre || hit.rule.preserveWhitespace === true, marks: t.isInline ? ctx.marks : [] });
      node = schema.node(t.name, hit.attrs, t.isLeaf ? undefined : kids, t.isInline ? ctx.marks : undefined, { unchecked: true });
    } catch {
      return readChildren(el.children, ctx);
    }
    return [node];
  }
  return readChildren(el.children, ctx);
}

const defaultTextblock = (schema: Schema, parent: NodeType): NodeType | undefined => [...schema.nodes.values()].find((t) => t.isTextblock && parent.allows(t.name) && !requiresAttrs(t));
const requiresAttrs = (t: NodeType) => Object.values(t.spec.attrs ?? {}).some((a) => a.default === undefined);

/** Makes a list of children fit a parent type: wraps stray inline content, unwraps what is not allowed, drops the rest. */
function fit(schema: Schema, parent: NodeType, children: readonly Node[], isTop = false): Node {
  const out: Node[] = [];
  let wrapper: { type: NodeType; kids: Node[] } | null = null;
  const flush = () => {
    if (wrapper) {
      const kids = trimBlock(wrapper.kids);
      if (kids.length) out.push(fit(schema, wrapper.type, kids, false));
      wrapper = null;
    }
  };
  const place = (c: Node): void => {
    const ct = schema.type(c.type);
    if (parent.allows(c.type)) {
      flush();
      out.push(ct.isText || ct.isLeaf ? c : fit(schema, ct, c.content ?? []));
      return;
    }
    if (ct.isInline) {
      const w = wrapper?.type ?? defaultTextblock(schema, parent);
      if (w) {
        wrapper ??= { type: w, kids: [] };
        wrapper.kids.push(c);
      }
      return;
    }
    flush();
    for (const g of c.content ?? []) place(g);
  };
  for (const c of children) place(c);
  flush();
  let kids = out.filter((n) => !(n.type === 'text' && n.text === ''));
  if (!schema.matches(parent.name, kids)) {
    const filler = defaultTextblock(schema, parent);
    if (filler && schema.matches(parent.name, [...kids, schema.node(filler.name, undefined, [], undefined, { unchecked: true })])) kids = [...kids, schema.node(filler.name, undefined, [], undefined, { unchecked: true })];
  }
  const joined: Node[] = [];
  for (const k of kids) addNode(k, joined);
  const node = schema.node(parent.name, isTop ? undefined : undefined, joined, undefined, { unchecked: true });
  return node;
}

function trimBlock(kids: Node[]): Node[] {
  const k = [...kids];
  if (k[0] && isText(k[0])) {
    const t = k[0].text!.replace(/^ +/, '');
    if (t) k[0] = withText(k[0], t);
    else k.shift();
  }
  const last = k[k.length - 1];
  if (last && isText(last)) {
    const t = last.text!.replace(/ +$/, '');
    if (t) k[k.length - 1] = withText(last, t);
    else k.pop();
  }
  return k;
}

// ---------------------------------------------------------------------------------------------------------------
// A basic schema

const levelOk = (v: Json) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 6;

export const basicSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', toHTML: () => ({ tag: 'p' }), parseHTML: [{ tag: 'p' }] },
    heading: {
      content: 'inline*',
      group: 'block',
      attrs: { level: { default: 1, validate: levelOk } },
      toHTML: (n) => ({ tag: `h${n.attrs?.level ?? 1}` }),
      parseHTML: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
    },
    blockquote: { content: 'block+', group: 'block', toHTML: () => ({ tag: 'blockquote' }), parseHTML: [{ tag: 'blockquote' }] },
    code_block: { content: 'text*', group: 'block', marks: '', toHTML: () => ({ tag: 'pre' }), parseHTML: [{ tag: 'pre', preserveWhitespace: true }] },
    horizontal_rule: { group: 'block', toHTML: () => ({ tag: 'hr' }), parseHTML: [{ tag: 'hr' }] },
    bullet_list: { content: 'list_item+', group: 'block', toHTML: () => ({ tag: 'ul' }), parseHTML: [{ tag: 'ul' }] },
    ordered_list: {
      content: 'list_item+',
      group: 'block',
      attrs: { start: { default: 1, validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1_000_000 } },
      toHTML: (n) => ({ tag: 'ol', ...(n.attrs?.start !== 1 ? { attrs: { start: String(n.attrs?.start) } } : {}) }),
      parseHTML: [{ tag: 'ol', attrs: (el) => ({ start: /^\d{1,6}$/.test(htmlAttr(el, 'start') ?? '') ? Number(htmlAttr(el, 'start')) : 1 }) }],
    },
    list_item: { content: 'paragraph block*', toHTML: () => ({ tag: 'li' }), parseHTML: [{ tag: 'li' }] },
    hard_break: { inline: true, group: 'inline', toHTML: () => ({ tag: 'br' }), parseHTML: [{ tag: 'br' }] },
    image: {
      inline: true,
      group: 'inline',
      attrs: { src: { validate: (v) => typeof v === 'string' && safeUrl(v, ['http', 'https']) !== null }, alt: { default: '' }, title: { default: '' } },
      toHTML: (n) => {
        const src = safeUrl(String(n.attrs?.src), ['http', 'https']);
        return src === null ? null : { tag: 'img', attrs: { src, alt: String(n.attrs?.alt ?? ''), ...(n.attrs?.title ? { title: String(n.attrs.title) } : {}) } };
      },
      parseHTML: [{ tag: 'img', attrs: (el) => (htmlAttr(el, 'src') ? { src: htmlAttr(el, 'src')!, alt: htmlAttr(el, 'alt') ?? '', title: htmlAttr(el, 'title') ?? '' } : false) }],
    },
    text: { group: 'inline' },
  },
  marks: {
    link: {
      attrs: { href: { validate: (v) => typeof v === 'string' && safeUrl(v) !== null }, title: { default: '' } },
      excludes: 'link',
      toHTML: (m) => {
        const href = safeUrl(String(m.attrs?.href));
        return href === null ? null : { tag: 'a', attrs: { href, rel: 'noopener noreferrer', ...(m.attrs?.title ? { title: String(m.attrs.title) } : {}) } };
      },
      parseHTML: [{ tag: 'a', attrs: (el) => (htmlAttr(el, 'href') ? { href: htmlAttr(el, 'href')!, title: htmlAttr(el, 'title') ?? '' } : false) }],
    },
    em: { toHTML: () => ({ tag: 'em' }), parseHTML: [{ tag: 'em' }, { tag: 'i' }] },
    strong: { toHTML: () => ({ tag: 'strong' }), parseHTML: [{ tag: 'strong' }, { tag: 'b' }] },
    code: { excludes: '_', toHTML: () => ({ tag: 'code' }), parseHTML: [{ tag: 'code' }] },
  },
});
