/**
 * A small template language for text people write and the app fills in: the logic-light core of Liquid (with the
 * parts of Handlebars and Jinja that people reach for). Output tags {{ name | filter: arg }} are HTML-escaped by
 * default; only the `safe` filter lets markup through. Tags: if / elsif / else / unless, for (limit, offset,
 * reversed, else, forloop.*, break, continue, ranges like 1..5), case / when, assign, capture, include (shares
 * variables), render (sees only what it is passed), comment and raw, with {{- and -}} to trim whitespace. Values
 * are read only through own, plain data: never prototypes, constructors, functions or methods, so a template cannot
 * reach into the program. Comparisons: == != < > <= >= contains, joined by and / or; only false and nil are false.
 *
 * A sandbox holds every render to limits (template size, nesting, steps, loop iterations, include depth, output
 * size) and refuses with LimitExceeded rather than hang or exhaust memory. Time is an argument (`now`) so the
 * `date` filter is repeatable. In strict mode a missing variable is an error that names it; otherwise it is empty.
 * Dates use strftime codes in UTC. Not here: arithmetic expressions, user-defined tags, macros, or inheritance.
 */

export class TemplateError extends Error {
  readonly line: number;
  constructor(message: string, line = 0) {
    super(line ? `line ${line}: ${message}` : message);
    this.line = line;
  }
}
export class TemplateSyntaxError extends TemplateError {}
export class UndefinedVariable extends TemplateError {}
export class LimitExceeded extends TemplateError {}
export class FilterError extends TemplateError {}

/** Markup that has been escaped or vouched for, and is not escaped again. */
export class SafeString {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

export interface Limits {
  /** Template source length. */
  readonly maxTemplate: number;
  /** Nesting of blocks and expressions. */
  readonly maxDepth: number;
  /** Nodes evaluated in one render, counting included templates. */
  readonly maxSteps: number;
  /** Loop passes in one render, all loops together. */
  readonly maxIterations: number;
  readonly maxIncludeDepth: number;
  /** Characters of output, and of any one string a filter or assign builds. */
  readonly maxOutput: number;
}

export const DEFAULT_LIMITS: Limits = { maxTemplate: 256 * 1024, maxDepth: 32, maxSteps: 100_000, maxIterations: 10_000, maxIncludeDepth: 8, maxOutput: 1024 * 1024 };

// ---------------------------------------------------------------- expressions

type Expr =
  | { readonly t: 'lit'; readonly v: unknown }
  | { readonly t: 'var'; readonly path: readonly (string | Expr)[] }
  | { readonly t: 'range'; readonly from: Expr; readonly to: Expr }
  | { readonly t: 'bin'; readonly op: string; readonly l: Expr; readonly r: Expr }
  | { readonly t: 'filtered'; readonly base: Expr; readonly filters: readonly { readonly name: string; readonly args: readonly Expr[]; readonly named: readonly [string, Expr][] }[] };

type Tok = { readonly k: 'str' | 'num' | 'id' | 'p'; readonly v: string };

function lex(src: string, line: number): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) i++;
    else if (c === '"' || c === "'") {
      const j = src.indexOf(c, i + 1);
      if (j < 0) throw new TemplateSyntaxError('a string is not closed', line);
      out.push({ k: 'str', v: src.slice(i + 1, j) });
      i = j + 1;
    } else if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? '') && !(out.length && (out[out.length - 1]!.k === 'num' || out[out.length - 1]!.k === 'id' || out[out.length - 1]!.v === ']' || out[out.length - 1]!.v === ')')))) {
      const m = /^-?\d+(\.(?!\.)\d+)?/.exec(src.slice(i))!;
      out.push({ k: 'num', v: m[0] });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_-]*\??/.exec(src.slice(i))!;
      out.push({ k: 'id', v: m[0] });
      i += m[0].length;
    } else {
      const two = src.slice(i, i + 2);
      if (['==', '!=', '<>', '<=', '>=', '..'].includes(two)) {
        out.push({ k: 'p', v: two === '<>' ? '!=' : two });
        i += 2;
      } else if ('.[]()<>,:|'.includes(c)) {
        out.push({ k: 'p', v: c });
        i++;
      } else throw new TemplateSyntaxError(`unexpected character "${c}"`, line);
    }
  }
  return out;
}

class ExprParser {
  private i = 0;
  private readonly toks: Tok[];
  private readonly line: number;
  private readonly known: (f: string) => boolean;
  constructor(src: string, line: number, known: (f: string) => boolean) {
    this.toks = lex(src, line);
    this.line = line;
    this.known = known;
  }
  private peek(): Tok | undefined {
    return this.toks[this.i];
  }
  private is(v: string): boolean {
    const t = this.peek();
    return t !== undefined && t.k !== 'str' && t.v === v;
  }
  private eat(v: string): void {
    if (!this.is(v)) throw new TemplateSyntaxError(`expected "${v}"${this.peek() ? ` but found "${this.peek()!.v}"` : ' but the expression ended'}`, this.line);
    this.i++;
  }
  done(): boolean {
    return this.i >= this.toks.length;
  }
  /** value | filter: arg, name: arg | filter */
  output(): Expr {
    const base = this.value();
    const filters: { name: string; args: Expr[]; named: [string, Expr][] }[] = [];
    while (this.is('|')) {
      this.i++;
      const t = this.peek();
      if (!t || t.k !== 'id') throw new TemplateSyntaxError('expected a filter name after "|"', this.line);
      this.i++;
      if (!this.known(t.v)) throw new TemplateSyntaxError(`unknown filter "${t.v}"`, this.line);
      const args: Expr[] = [];
      const named: [string, Expr][] = [];
      if (this.is(':')) {
        this.i++;
        do {
          if (this.is(',')) this.i++;
          const n = this.toks[this.i + 1];
          if (this.peek()?.k === 'id' && n && n.k === 'p' && n.v === ':') {
            const key = this.peek()!.v;
            this.i += 2;
            named.push([key, this.value()]);
          } else args.push(this.value());
        } while (this.is(','));
      }
      filters.push({ name: t.v, args, named });
    }
    return filters.length ? { t: 'filtered', base, filters } : base;
  }
  /** a and b or c == d */
  condition(): Expr {
    return this.or();
  }
  private or(): Expr {
    let l = this.and();
    while (this.is('or')) {
      this.i++;
      l = { t: 'bin', op: 'or', l, r: this.and() };
    }
    return l;
  }
  private and(): Expr {
    let l = this.cmp();
    while (this.is('and')) {
      this.i++;
      l = { t: 'bin', op: 'and', l, r: this.cmp() };
    }
    return l;
  }
  private cmp(): Expr {
    const l = this.value();
    const t = this.peek();
    if (t && ((t.k === 'p' && ['==', '!=', '<', '>', '<=', '>='].includes(t.v)) || (t.k === 'id' && t.v === 'contains'))) {
      this.i++;
      return { t: 'bin', op: t.v, l, r: this.value() };
    }
    return l;
  }
  value(): Expr {
    const t = this.peek();
    if (!t) throw new TemplateSyntaxError('the expression ended too soon', this.line);
    if (t.k === 'str') {
      this.i++;
      return { t: 'lit', v: t.v };
    }
    if (t.k === 'num') {
      this.i++;
      return { t: 'lit', v: Number(t.v) };
    }
    if (t.k === 'p' && t.v === '(') {
      this.i++;
      const from = this.value();
      this.eat('..');
      const to = this.value();
      this.eat(')');
      return { t: 'range', from, to };
    }
    if (t.k === 'id') {
      if (t.v === 'true') return this.lit(true);
      if (t.v === 'false') return this.lit(false);
      if (t.v === 'nil' || t.v === 'null') return this.lit(null);
      this.i++;
      const path: (string | Expr)[] = [t.v];
      for (;;) {
        if (this.is('.')) {
          this.i++;
          const n = this.peek();
          if (!n || n.k !== 'id') throw new TemplateSyntaxError('expected a name after "."', this.line);
          this.i++;
          path.push(n.v);
        } else if (this.is('[')) {
          this.i++;
          path.push(this.value());
          this.eat(']');
        } else break;
      }
      return { t: 'var', path };
    }
    throw new TemplateSyntaxError(`unexpected "${t.v}"`, this.line);
  }
  private lit(v: unknown): Expr {
    this.i++;
    return { t: 'lit', v };
  }
}

// ---------------------------------------------------------------- tokens and tree

type Tok2 = { readonly k: 'text'; readonly text: string } | { readonly k: 'out'; readonly src: string; readonly line: number } | { readonly k: 'tag'; readonly name: string; readonly src: string; readonly line: number };

function tokenize(src: string): Tok2[] {
  const out: Tok2[] = [];
  let i = 0;
  let line = 1;
  let trimNext = false;
  const text = (s: string) => {
    if (trimNext) s = s.replace(/^\s+/, '');
    trimNext = false;
    if (s) out.push({ k: 'text', text: s });
  };
  const count = (s: string) => (s.match(/\n/g) ?? []).length;
  while (i < src.length) {
    const a = src.indexOf('{{', i);
    const b = src.indexOf('{%', i);
    const at = a < 0 ? b : b < 0 ? a : Math.min(a, b);
    if (at < 0) {
      text(src.slice(i));
      break;
    }
    let before = src.slice(i, at);
    const isOut = src.startsWith('{{', at);
    const close = isOut ? '}}' : '%}';
    const end = src.indexOf(close, at + 2);
    if (end < 0) throw new TemplateSyntaxError(`"${isOut ? '{{' : '{%'}" is never closed`, line + count(before));
    let inner = src.slice(at + 2, end);
    if (inner.startsWith('-')) {
      before = before.replace(/\s+$/, '');
      inner = inner.slice(1);
    }
    const trimAfter = inner.endsWith('-');
    if (trimAfter) inner = inner.slice(0, -1);
    text(before);
    line += count(src.slice(i, at));
    const tagLine = line;
    line += count(src.slice(at, end + 2));
    i = end + 2;
    if (isOut) out.push({ k: 'out', src: inner.trim(), line: tagLine });
    else {
      const m = /^\s*([A-Za-z_]+)\s*([\s\S]*)$/.exec(inner);
      if (!m) throw new TemplateSyntaxError('an empty or unreadable tag', tagLine);
      const name = m[1]!;
      if (name === 'raw' || name === 'comment') {
        const re = new RegExp(`\\{%-?\\s*end${name}\\s*-?%\\}`);
        const rest = src.slice(i);
        const e = re.exec(rest);
        if (!e) throw new TemplateSyntaxError(`{% ${name} %} is never closed`, tagLine);
        const body = rest.slice(0, e.index);
        if (name === 'raw') {
          if (trimAfter) trimNext = true;
          const t = body;
          if (t) out.push({ k: 'text', text: trimNext ? t.replace(/^\s+/, '') : t });
          trimNext = false;
        }
        line += count(rest.slice(0, e.index + e[0].length));
        i += e.index + e[0].length;
        if (/-%\}$/.test(e[0])) trimNext = true;
        continue;
      }
      out.push({ k: 'tag', name, src: m[2]!.trim(), line: tagLine });
    }
    if (trimAfter) trimNext = true;
  }
  return out;
}

type Node =
  | { readonly t: 'text'; readonly text: string }
  | { readonly t: 'out'; readonly e: Expr; readonly line: number }
  | { readonly t: 'if'; readonly branches: readonly { readonly cond: Expr; readonly body: readonly Node[] }[]; readonly otherwise: readonly Node[]; readonly negate: boolean; readonly line: number }
  | { readonly t: 'for'; readonly v: string; readonly coll: Expr; readonly opts: readonly [string, Expr][]; readonly reversed: boolean; readonly body: readonly Node[]; readonly otherwise: readonly Node[]; readonly line: number }
  | { readonly t: 'case'; readonly subject: Expr; readonly whens: readonly { readonly vals: readonly Expr[]; readonly body: readonly Node[] }[]; readonly otherwise: readonly Node[]; readonly line: number }
  | { readonly t: 'assign'; readonly name: string; readonly e: Expr; readonly line: number }
  | { readonly t: 'capture'; readonly name: string; readonly body: readonly Node[]; readonly line: number }
  | { readonly t: 'include'; readonly name: string; readonly args: readonly [string, Expr][]; readonly isolated: boolean; readonly line: number }
  | { readonly t: 'break' | 'continue'; readonly line: number };

/** A parsed template: safe to keep and render many times. */
export interface Template {
  readonly nodes: readonly Node[];
}

const BLOCKS = new Set(['if', 'unless', 'for', 'case', 'capture']);

function parseNodes(toks: Tok2[], known: (f: string) => boolean, maxDepth: number): Node[] {
  let i = 0;
  const body = (stops: readonly string[], depth: number, open?: { name: string; line: number }): { nodes: Node[]; stop?: Extract<Tok2, { k: 'tag' }> } => {
    if (depth > maxDepth) throw new LimitExceeded('blocks are nested too deeply', toks[i] && toks[i]!.k !== 'text' ? (toks[i] as { line: number }).line : 0);
    const nodes: Node[] = [];
    while (i < toks.length) {
      const t = toks[i++]!;
      if (t.k === 'text') nodes.push({ t: 'text', text: t.text });
      else if (t.k === 'out') {
        const p = new ExprParser(t.src, t.line, known);
        const e = p.output();
        if (!p.done()) throw new TemplateSyntaxError('something follows the expression that does not belong', t.line);
        nodes.push({ t: 'out', e, line: t.line });
      } else {
        if (stops.includes(t.name)) return { nodes, stop: t };
        nodes.push(tag(t, depth));
      }
    }
    if (open) throw new TemplateSyntaxError(`{% ${open.name} %} is never closed`, open.line);
    return { nodes };
  };
  const cond = (src: string, line: number): Expr => {
    const p = new ExprParser(src, line, known);
    const e = p.condition();
    if (!p.done()) throw new TemplateSyntaxError('something follows the condition that does not belong', line);
    return e;
  };
  const args = (src: string, line: number): [string, Expr][] => {
    const out: [string, Expr][] = [];
    const p = new ExprParser(src, line, known);
    const toks2 = lex(src, line);
    let n = 0;
    while (n < toks2.length) {
      const k = toks2[n]!;
      if (k.k === 'p' && k.v === ',') {
        n++;
        continue;
      }
      if (k.k !== 'id' || toks2[n + 1]?.v !== ':') throw new TemplateSyntaxError('arguments are written name: value', line);
      // Find the end of this value: the next comma at depth zero.
      let m = n + 2;
      let d = 0;
      while (m < toks2.length && !(d === 0 && toks2[m]!.k === 'p' && toks2[m]!.v === ',')) {
        if (toks2[m]!.k === 'p' && '([' .includes(toks2[m]!.v)) d++;
        if (toks2[m]!.k === 'p' && ')]'.includes(toks2[m]!.v)) d--;
        m++;
      }
      const sub = toks2.slice(n + 2, m).map((x) => (x.k === 'str' ? `"${x.v}"` : x.v)).join(' ');
      void p;
      out.push([k.v, valueOf(sub, line)]);
      n = m;
    }
    return out;
  };
  const valueOf = (src: string, line: number): Expr => {
    const p = new ExprParser(src.replace(/\s*\.\s*/g, '.').replace(/\s*\[\s*/g, '[').replace(/\s*\]/g, ']'), line, known);
    const e = p.value();
    if (!p.done()) throw new TemplateSyntaxError('something follows the value that does not belong', line);
    return e;
  };
  const tag = (t: Extract<Tok2, { k: 'tag' }>, depth: number): Node => {
    const { name, src, line } = t;
    switch (name) {
      case 'if':
      case 'unless': {
        const branches: { cond: Expr; body: Node[] }[] = [];
        let c = cond(src, line);
        let otherwise: Node[] = [];
        for (;;) {
          const r = body(['elsif', 'else', `end${name}`], depth + 1, { name, line });
          if (r.stop!.name === 'elsif') {
            branches.push({ cond: c, body: r.nodes });
            c = cond(r.stop!.src, r.stop!.line);
          } else if (r.stop!.name === 'else') {
            branches.push({ cond: c, body: r.nodes });
            otherwise = body([`end${name}`], depth + 1, { name, line }).nodes;
            break;
          } else {
            branches.push({ cond: c, body: r.nodes });
            break;
          }
        }
        return { t: 'if', branches, otherwise, negate: name === 'unless', line };
      }
      case 'for': {
        const m = /^([A-Za-z_][\w-]*)\s+in\s+(.+)$/.exec(src);
        if (!m) throw new TemplateSyntaxError('a loop is written {% for item in items %}', line);
        let rest = m[2]!;
        let reversed = false;
        if (/\s+reversed\s*$/.test(rest)) {
          reversed = true;
          rest = rest.replace(/\s+reversed\s*$/, '');
        }
        const om = /^(.*?)((?:\s+(?:limit|offset)\s*:\s*[^\s]+)*)\s*$/.exec(rest)!;
        const opts: [string, Expr][] = [];
        for (const o of om[2]!.matchAll(/(limit|offset)\s*:\s*([^\s]+)/g)) opts.push([o[1]!, valueOf(o[2]!, line)]);
        const collSrc = om[1]!.trim();
        const rm = /^\(\s*(.+?)\s*\.\.\s*(.+?)\s*\)$/.exec(collSrc);
        const coll: Expr = rm ? { t: 'range', from: valueOf(rm[1]!, line), to: valueOf(rm[2]!, line) } : valueOf(collSrc, line);
        const r = body(['else', 'endfor'], depth + 1, { name, line });
        const otherwise = r.stop!.name === 'else' ? body(['endfor'], depth + 1, { name, line }).nodes : [];
        return { t: 'for', v: m[1]!, coll, opts, reversed, body: r.nodes, otherwise, line };
      }
      case 'case': {
        const subject = valueOf(src, line);
        const whens: { vals: Expr[]; body: Node[] }[] = [];
        let otherwise: Node[] = [];
        const first = body(['when', 'else', 'endcase'], depth + 1, { name, line });
        if (first.nodes.some((n) => n.t !== 'text' || n.text.trim())) throw new TemplateSyntaxError('nothing may come between {% case %} and its first {% when %}', line);
        let stop = first.stop!;
        while (stop.name !== 'endcase') {
          if (stop.name === 'when') {
            const vals = stop.src.split(/\s*,\s*|\s+or\s+/).map((v) => valueOf(v, stop.line));
            const r = body(['when', 'else', 'endcase'], depth + 1, { name, line });
            whens.push({ vals, body: r.nodes });
            stop = r.stop!;
          } else {
            const r = body(['endcase'], depth + 1, { name, line });
            otherwise = r.nodes;
            stop = r.stop!;
          }
        }
        return { t: 'case', subject, whens, otherwise, line };
      }
      case 'assign': {
        const m = /^([A-Za-z_][\w-]*)\s*=\s*(.+)$/s.exec(src);
        if (!m) throw new TemplateSyntaxError('an assignment is written {% assign name = value %}', line);
        const p = new ExprParser(m[2]!, line, known);
        const e = p.output();
        if (!p.done()) throw new TemplateSyntaxError('something follows the value that does not belong', line);
        return { t: 'assign', name: m[1]!, e, line };
      }
      case 'capture': {
        if (!/^[A-Za-z_][\w-]*$/.test(src)) throw new TemplateSyntaxError('a capture is written {% capture name %}', line);
        return { t: 'capture', name: src, body: body(['endcapture'], depth + 1, { name, line }).nodes, line };
      }
      case 'include':
      case 'render': {
        const m = /^(?:"([^"]*)"|'([^']*)')\s*(?:,\s*(.*))?$/s.exec(src);
        if (!m) throw new TemplateSyntaxError(`${name} takes the name of a partial in quotes`, line);
        const pn = (m[1] ?? m[2])!;
        if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(pn)) throw new TemplateSyntaxError(`"${pn}" is not a partial name (letters, digits, - _ and / between parts)`, line);
        return { t: 'include', name: pn, args: m[3] ? args(m[3], line) : [], isolated: name === 'render', line };
      }
      case 'break':
      case 'continue':
        return { t: name, line };
      default:
        if (name.startsWith('end') || name === 'else' || name === 'elsif' || name === 'when') throw new TemplateSyntaxError(`{% ${name} %} has no matching opening tag`, line);
        throw new TemplateSyntaxError(`unknown tag "${name}"`, line);
    }
  };
  const r = body([], 0);
  return r.nodes;
}

// ---------------------------------------------------------------- values and filters

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);

/** Reads one step of a path from plain data: own properties and array positions only; never methods or prototypes. */
function step(v: unknown, key: unknown): unknown {
  if (v instanceof SafeString) v = v.value;
  if (Array.isArray(v)) {
    if (key === 'size') return v.length;
    if (key === 'first') return v[0] ?? null;
    if (key === 'last') return v[v.length - 1] ?? null;
    return typeof key === 'number' && Number.isInteger(key) ? (v[key < 0 ? v.length + key : key] ?? null) : null;
  }
  if (typeof v === 'string') return key === 'size' ? v.length : null;
  if (v !== null && typeof v === 'object') {
    const k = typeof key === 'number' ? String(key) : key;
    if (typeof k !== 'string' || BLOCKED.has(k) || !Object.hasOwn(v, k)) return null;
    const r = (v as Record<string, unknown>)[k];
    return typeof r === 'function' || typeof r === 'symbol' || typeof r === 'bigint' ? null : r;
  }
  return null;
}

const truthy = (v: unknown) => v !== false && v !== null && v !== undefined;
const str = (v: unknown): string => (v === null || v === undefined ? '' : v instanceof SafeString ? v.value : Array.isArray(v) ? v.map(str).join('') : typeof v === 'object' ? JSON.stringify(v) : String(v));
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(str(v));
  return Number.isFinite(n) ? n : 0;
};
const looseEq = (a: unknown, b: unknown): boolean => {
  if (a instanceof SafeString) a = a.value;
  if (b instanceof SafeString) b = b.value;
  a = a ?? null;
  b = b ?? null;
  if (a === b) return true;
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) return JSON.stringify(a) === JSON.stringify(b);
  return false;
};
const order = (a: unknown, b: unknown): number | null => {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const p2 = (n: number) => String(n).padStart(2, '0');

/** strftime in UTC: %Y %y %m %d %e %H %I %M %S %p %B %b %A %a %j %Z %% */
export function strftime(d: Date, f: string): string {
  return f.replace(/%([YymdeHIMSpBbAajZ%])/g, (_m, c: string) => {
    switch (c) {
      case 'Y': return String(d.getUTCFullYear());
      case 'y': return p2(d.getUTCFullYear() % 100);
      case 'm': return p2(d.getUTCMonth() + 1);
      case 'd': return p2(d.getUTCDate());
      case 'e': return String(d.getUTCDate()).padStart(2, ' ');
      case 'H': return p2(d.getUTCHours());
      case 'I': return p2(d.getUTCHours() % 12 || 12);
      case 'M': return p2(d.getUTCMinutes());
      case 'S': return p2(d.getUTCSeconds());
      case 'p': return d.getUTCHours() < 12 ? 'AM' : 'PM';
      case 'B': return MONTHS[d.getUTCMonth()]!;
      case 'b': return MONTHS[d.getUTCMonth()]!.slice(0, 3);
      case 'A': return WEEKDAYS[d.getUTCDay()]!;
      case 'a': return WEEKDAYS[d.getUTCDay()]!.slice(0, 3);
      case 'j': return String(Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000)).padStart(3, '0');
      case 'Z': return 'UTC';
      default: return '%';
    }
  });
}

interface FilterContext {
  readonly now: Date;
  readonly line: number;
}
export type Filter = (input: unknown, args: readonly unknown[], ctx: FilterContext) => unknown;

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]);

export const FILTERS: Readonly<Record<string, Filter>> = {
  safe: (v) => new SafeString(str(v)),
  escape: (v) => new SafeString(escapeHtml(str(v))),
  raw: (v) => new SafeString(str(v)),
  upcase: (v) => str(v).toUpperCase(),
  downcase: (v) => str(v).toLowerCase(),
  capitalize: (v) => str(v).charAt(0).toUpperCase() + str(v).slice(1).toLowerCase(),
  strip: (v) => str(v).trim(),
  lstrip: (v) => str(v).replace(/^\s+/, ''),
  rstrip: (v) => str(v).replace(/\s+$/, ''),
  strip_newlines: (v) => str(v).replace(/\r?\n/g, ''),
  newline_to_br: (v) => new SafeString(escapeHtml(str(v)).replace(/\r?\n/g, '<br>\n')),
  truncate: (v, [n, tail]) => {
    const s = str(v);
    const max = Math.max(0, Math.floor(num(n ?? 50)));
    const t = tail === undefined ? '...' : str(tail);
    return s.length <= max ? s : s.slice(0, Math.max(0, max - t.length)) + t;
  },
  truncatewords: (v, [n, tail]) => {
    const w = str(v).trim().split(/\s+/).filter(Boolean);
    const max = Math.max(1, Math.floor(num(n ?? 15)));
    return w.length <= max ? w.join(' ') : w.slice(0, max).join(' ') + (tail === undefined ? '...' : str(tail));
  },
  append: (v, [a]) => str(v) + str(a),
  prepend: (v, [a]) => str(a) + str(v),
  replace: (v, [a, b]) => str(v).split(str(a)).join(str(b)),
  replace_first: (v, [a, b]) => str(v).replace(str(a), () => str(b)),
  remove: (v, [a]) => str(v).split(str(a)).join(''),
  split: (v, [d]) => (str(d) === '' ? [...str(v)] : str(v).split(str(d))),
  join: (v, [d]) => arr(v).map(str).join(d === undefined ? ' ' : str(d)),
  size: (v) => (Array.isArray(v) ? v.length : str(v).length),
  first: (v) => (Array.isArray(v) ? (v[0] ?? null) : null),
  last: (v) => (Array.isArray(v) ? (v[v.length - 1] ?? null) : null),
  reverse: (v) => [...arr(v)].reverse(),
  sort: (v, [key]) => {
    const k = key === undefined ? undefined : str(key);
    const get = (x: unknown) => (k === undefined ? x : step(x, k));
    return [...arr(v)].sort((a, b) => order(get(a), get(b)) ?? (str(get(a)) < str(get(b)) ? -1 : 1));
  },
  map: (v, [key]) => arr(v).map((x) => step(x, str(key))),
  where: (v, [key, val]) => arr(v).filter((x) => (val === undefined ? truthy(step(x, str(key))) : looseEq(step(x, str(key)), val))),
  uniq: (v) => arr(v).filter((x, i, a) => a.findIndex((y) => looseEq(x, y)) === i),
  compact: (v) => arr(v).filter((x) => x !== null && x !== undefined),
  concat: (v, [o]) => [...arr(v), ...arr(o)],
  default: (v, [d]) => (v === null || v === undefined || v === false || str(v) === '' || (Array.isArray(v) && v.length === 0) ? (d ?? '') : v),
  plus: (v, [a]) => num(v) + num(a),
  minus: (v, [a]) => num(v) - num(a),
  times: (v, [a]) => num(v) * num(a),
  divided_by: (v, [a], c) => {
    if (num(a) === 0) throw new FilterError('cannot divide by zero', c.line);
    return Number.isInteger(num(v)) && Number.isInteger(num(a)) ? Math.floor(num(v) / num(a)) : num(v) / num(a);
  },
  modulo: (v, [a], c) => {
    if (num(a) === 0) throw new FilterError('cannot divide by zero', c.line);
    return num(v) % num(a);
  },
  abs: (v) => Math.abs(num(v)),
  ceil: (v) => Math.ceil(num(v)),
  floor: (v) => Math.floor(num(v)),
  round: (v, [n]) => {
    const p = 10 ** Math.min(10, Math.max(0, Math.floor(num(n ?? 0))));
    return Math.round(num(v) * p) / p;
  },
  url_encode: (v) => encodeURIComponent(str(v)),
  json: (v) => new SafeString(JSON.stringify(v instanceof SafeString ? v.value : (v ?? null)).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')),
  date: (v, [f], c) => {
    const raw = v instanceof SafeString ? v.value : v;
    const d = raw === 'now' || raw === 'today' ? c.now : typeof raw === 'number' ? new Date(raw * 1000) : new Date(String(raw));
    if (Number.isNaN(d.getTime())) throw new FilterError(`"${str(raw)}" is not a date`, c.line);
    return strftime(d, f === undefined ? '%Y-%m-%d' : str(f));
  },
};

// ---------------------------------------------------------------- rendering

export interface EngineOptions {
  /** Partials by name, for include and render. */
  readonly partials?: Readonly<Record<string, string>>;
  readonly filters?: Readonly<Record<string, Filter>>;
  readonly limits?: Partial<Limits>;
  /** The clock for the date filter's "now". */
  readonly now?: () => Date;
  /** A variable that is missing is an error, not empty. */
  readonly strict?: boolean;
}

class Scope {
  readonly vars = new Map<string, unknown>();
  readonly parent: Scope | undefined;
  /** Where assign and capture write: the top of the template that is running (an include shares its caller's). */
  readonly top: boolean;
  constructor(parent?: Scope, top = false) {
    this.parent = parent;
    this.top = top;
  }
  home(): Scope {
    let s: Scope = this;
    while (!s.top && s.parent) s = s.parent;
    return s;
  }
}

class Stop extends Error {
  readonly what: 'break' | 'continue';
  /** Output produced before the break, collected as the stop passes up through enclosing blocks. */
  partial = '';
  constructor(what: 'break' | 'continue') {
    super(what);
    this.what = what;
  }
}

export class Engine {
  private readonly limits: Limits;
  private readonly filters: Readonly<Record<string, Filter>>;
  private readonly partials: Readonly<Record<string, string>>;
  private readonly cache = new Map<string, Template>();
  private readonly now: () => Date;
  private readonly strict: boolean;

  constructor(o: EngineOptions = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...o.limits };
    this.filters = { ...FILTERS, ...o.filters };
    this.partials = o.partials ?? {};
    this.now = o.now ?? (() => new Date());
    this.strict = o.strict ?? false;
  }

  /** Checks a template without rendering it: its syntax errors, or none. */
  validate(source: string): TemplateError[] {
    try {
      this.parse(source);
      for (const [n, s] of Object.entries(this.partials)) void n, this.parse(s);
      return [];
    } catch (e) {
      if (e instanceof TemplateError) return [e];
      throw e;
    }
  }

  parse(source: string): Template {
    if (source.length > this.limits.maxTemplate) throw new LimitExceeded(`the template is ${source.length} characters; the limit is ${this.limits.maxTemplate}`);
    return { nodes: parseNodes(tokenize(source), (f) => Object.hasOwn(this.filters, f), this.limits.maxDepth) };
  }

  /** The variables a template reads from outside itself, for forms that ask for them. Names it assigns or loops over are excluded. */
  variables(source: string): string[] {
    const seen = new Set<string>();
    const local = new Set<string>(['forloop']);
    const expr = (e: Expr) => {
      if (e.t === 'var') {
        const root = e.path[0] as string;
        if (!local.has(root)) seen.add(root);
        for (const p of e.path) if (typeof p !== 'string') expr(p);
      } else if (e.t === 'range') (expr(e.from), expr(e.to));
      else if (e.t === 'bin') (expr(e.l), expr(e.r));
      else if (e.t === 'filtered') (expr(e.base), e.filters.forEach((f) => (f.args.forEach(expr), f.named.forEach(([, x]) => expr(x)))));
    };
    const walk = (ns: readonly Node[]) => {
      for (const n of ns) {
        if (n.t === 'out') expr(n.e);
        else if (n.t === 'assign') (expr(n.e), local.add(n.name));
        else if (n.t === 'capture') (local.add(n.name), walk(n.body));
        else if (n.t === 'if') (n.branches.forEach((b) => (expr(b.cond), walk(b.body))), walk(n.otherwise));
        else if (n.t === 'for') (expr(n.coll), n.opts.forEach(([, x]) => expr(x)), local.add(n.v), walk(n.body), walk(n.otherwise));
        else if (n.t === 'case') (expr(n.subject), n.whens.forEach((w) => (w.vals.forEach(expr), walk(w.body))), walk(n.otherwise));
        else if (n.t === 'include') n.args.forEach(([, x]) => expr(x));
      }
    };
    walk(this.parse(source).nodes);
    return [...seen].sort();
  }

  render(source: string | Template, data: unknown = {}): string {
    const tpl = typeof source === 'string' ? this.parse(source) : source;
    const st = { steps: 0, iterations: 0, out: 0 };
    const root = new Scope(undefined, true);
    try {
      return this.run(tpl.nodes, root, data, st, 0);
    } catch (e) {
      // A break or continue outside any loop ends the template there, as in Liquid.
      if (e instanceof Stop) return e.partial;
      throw e;
    }
  }

  private partial(name: string, line: number): Template {
    if (!Object.hasOwn(this.partials, name)) throw new TemplateError(`there is no partial named "${name}"`, line);
    let t = this.cache.get(name);
    if (!t) {
      t = this.parse(this.partials[name]!);
      this.cache.set(name, t);
    }
    return t;
  }

  private run(nodes: readonly Node[], scope: Scope, data: unknown, st: { steps: number; iterations: number; out: number }, depth: number): string {
    const L = this.limits;
    const tick = (line: number) => {
      if (++st.steps > L.maxSteps) throw new LimitExceeded(`the template took more than ${L.maxSteps} steps`, line);
    };
    const emit = (s: string, line: number): string => {
      st.out += s.length;
      if (st.out > L.maxOutput) throw new LimitExceeded(`the output is longer than ${L.maxOutput} characters`, line);
      return s;
    };
    const lookup = (name: string, line: number): { found: boolean; v: unknown } => {
      for (let s: Scope | undefined = scope; s; s = s.parent) if (s.vars.has(name)) return { found: true, v: s.vars.get(name) };
      if (data !== null && typeof data === 'object' && Object.hasOwn(data, name) && !BLOCKED.has(name)) return { found: true, v: step(data, name) };
      void line;
      return { found: false, v: null };
    };
    const ev = (e: Expr, line: number): unknown => {
      tick(line);
      switch (e.t) {
        case 'lit':
          return e.v;
        case 'var': {
          const root = e.path[0] as string;
          const r = lookup(root, line);
          if (!r.found && this.strict) throw new UndefinedVariable(`"${root}" is not defined`, line);
          let v = r.v;
          for (let i = 1; i < e.path.length; i++) {
            const k = e.path[i]!;
            const next = step(v, typeof k === 'string' ? k : ev(k, line));
            if (next === null && this.strict && !(Array.isArray(v) && ['first', 'last'].includes(String(k)))) {
              const nm = e.path.slice(0, i + 1).map((p) => (typeof p === 'string' ? p : '[…]')).join('.');
              throw new UndefinedVariable(`"${nm}" is not defined`, line);
            }
            v = next;
          }
          return v;
        }
        case 'range': {
          const a = Math.floor(num(ev(e.from, line)));
          const b = Math.floor(num(ev(e.to, line)));
          if (b - a + 1 > L.maxIterations) throw new LimitExceeded(`a range of ${b - a + 1} items is over the loop limit of ${L.maxIterations}`, line);
          return Array.from({ length: Math.max(0, b - a + 1) }, (_x, i) => a + i);
        }
        case 'bin': {
          if (e.op === 'and') return truthy(ev(e.l, line)) && truthy(ev(e.r, line));
          if (e.op === 'or') return truthy(ev(e.l, line)) || truthy(ev(e.r, line));
          const a = ev(e.l, line);
          const b = ev(e.r, line);
          if (e.op === '==') return looseEq(a, b);
          if (e.op === '!=') return !looseEq(a, b);
          if (e.op === 'contains') return Array.isArray(a) ? a.some((x) => looseEq(x, b)) : typeof a === 'string' && b !== null && b !== undefined ? a.includes(str(b)) : false;
          const c = order(a instanceof SafeString ? a.value : a, b instanceof SafeString ? b.value : b);
          if (c === null) return false;
          return e.op === '<' ? c < 0 : e.op === '>' ? c > 0 : e.op === '<=' ? c <= 0 : c >= 0;
        }
        case 'filtered': {
          let v = ev(e.base, line);
          for (const f of e.filters) {
            tick(line);
            const named = Object.fromEntries(f.named.map(([k, x]) => [k, ev(x, line)]));
            const args = [...f.args.map((x) => ev(x, line)), ...(f.named.length ? [named] : [])];
            v = this.filters[f.name]!(v, args, { now: this.now(), line });
            const size = typeof v === 'string' ? v.length : v instanceof SafeString ? v.value.length : Array.isArray(v) ? v.length : 0;
            if (size > L.maxOutput) throw new LimitExceeded(`a value built by "${f.name}" is longer than ${L.maxOutput}`, line);
          }
          return v;
        }
      }
    };
    let out = '';
    try {
    for (const n of nodes) {
      switch (n.t) {
        case 'text':
          tick(0);
          out += emit(n.text, 0);
          break;
        case 'out': {
          tick(n.line);
          const v = ev(n.e, n.line);
          out += emit(v instanceof SafeString ? v.value : escapeHtml(str(v)), n.line);
          break;
        }
        case 'if': {
          tick(n.line);
          let hit: readonly Node[] | undefined;
          for (const b of n.branches) {
            const c = truthy(ev(b.cond, n.line));
            if (n.negate ? !c : c) {
              hit = b.body;
              break;
            }
          }
          out += this.run(hit ?? n.otherwise, scope, data, st, depth);
          break;
        }
        case 'case': {
          tick(n.line);
          const s = ev(n.subject, n.line);
          const w = n.whens.find((x) => x.vals.some((v) => looseEq(s, ev(v, n.line))));
          out += this.run(w ? w.body : n.otherwise, scope, data, st, depth);
          break;
        }
        case 'assign': {
          tick(n.line);
          const v = ev(n.e, n.line);
          if (typeof v === 'string' && v.length > L.maxOutput) throw new LimitExceeded(`a value assigned is longer than ${L.maxOutput}`, n.line);
          scope.home().vars.set(n.name, v);
          break;
        }
        case 'capture': {
          tick(n.line);
          const s = this.run(n.body, scope, data, st, depth);
          scope.home().vars.set(n.name, new SafeString(s));
          break;
        }
        case 'for': {
          tick(n.line);
          let items = ev(n.coll, n.line);
          items = Array.isArray(items) ? [...items] : [];
          let list = items as unknown[];
          const opt = Object.fromEntries(n.opts.map(([k, e]) => [k, Math.max(0, Math.floor(num(ev(e, n.line))))]));
          if (n.reversed) list = list.reverse();
          if (opt.offset) list = list.slice(opt.offset);
          if (opt.limit !== undefined) list = list.slice(0, opt.limit);
          if (!list.length) {
            out += this.run(n.otherwise, scope, data, st, depth);
            break;
          }
          const inner = new Scope(scope);
          for (let i = 0; i < list.length; i++) {
            if (++st.iterations > L.maxIterations) throw new LimitExceeded(`loops ran more than ${L.maxIterations} passes`, n.line);
            inner.vars.set(n.v, list[i]);
            inner.vars.set('forloop', { index: i + 1, index0: i, rindex: list.length - i, rindex0: list.length - i - 1, first: i === 0, last: i === list.length - 1, length: list.length });
            try {
              out += this.run(n.body, inner, data, st, depth);
            } catch (e) {
              if (e instanceof Stop) {
                out += e.partial;
                if (e.what === 'break') break;
                continue;
              }
              throw e;
            }
          }
          break;
        }
        case 'include': {
          tick(n.line);
          if (depth + 1 > L.maxIncludeDepth) throw new LimitExceeded(`partials are nested more than ${L.maxIncludeDepth} deep`, n.line);
          const tpl = this.partial(n.name, n.line);
          const argv = n.args.map(([k, e]) => [k, ev(e, n.line)] as const);
          const sub = n.isolated ? new Scope(undefined, true) : new Scope(scope);
          for (const [k, v] of argv) sub.vars.set(k, v);
          out += this.run(tpl.nodes, sub, n.isolated ? {} : data, st, depth + 1);
          break;
        }
        case 'break':
        case 'continue':
          throw new Stop(n.t);
      }
    }
    } catch (e) {
      if (e instanceof Stop) e.partial = out + e.partial;
      throw e;
    }
    return out;
  }
}

/** Parses and renders in one call, with the default limits. */
export const render = (source: string, data: unknown = {}, o: EngineOptions = {}): string => new Engine(o).render(source, data);
