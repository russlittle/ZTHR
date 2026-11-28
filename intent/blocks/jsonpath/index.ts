/**
 * JSONPath as standardised in RFC 9535, and a small jq-like transform language, both with bounded evaluation.
 *
 * JSONPath: the root `$`, child segments (`.name`, `.*`, `[...]`) and descendant segments (`..name`, `..[...]`,
 * `..*`); selectors for names (quoted with the RFC's escapes), wildcards, indexes (negative from the end, within
 * the safe-integer range), slices `start:end:step` with the RFC's exact bounds rules, and filters `?expr` with
 * comparisons, `&&`, `||`, `!`, parentheses, existence tests on relative (`@`) and absolute (`$`) queries, and the
 * function extensions length, count, match, search and value, type-checked when the path is compiled (so
 * `$[?length(@.*) > 1]` is refused as the RFC requires). Each result carries its normalised path
 * (`$['store']['book'][0]`). Comparison follows the RFC: an empty result equals only another empty result, objects
 * and arrays compare deeply, and ordering applies to two numbers or two strings only.
 *
 * Bounds: every node visited counts as a step, results are capped, and descent depth is capped, so a hostile path
 * or document ends in `LimitExceeded` instead of a stuck process. Regular expressions given to match and search
 * (I-Regexp, RFC 9485) are refused when they could backtrack exponentially.
 *
 * Transform: `transform(doc, program)` runs a jq-like subset: `.`, `.a.b`, `.["k"]`, `.[0]`, `.[2:4]`, `.[]`, `..`,
 * the optional `?`, pipes, commas, array and object construction, literals, arithmetic, comparisons, `and` `or`
 * `not`, `//`, `if then else end`, and functions select, map, length, keys, values, has, type, first, last, add,
 * sort, sort_by, unique, reverse, join, tostring, tonumber, min, max, flatten, to_entries, from_entries, empty,
 * not, ascii_downcase, ascii_upcase, test, split, contains, any, all, range. No variables, no user functions, no
 * input/output side effects, no `env`, no `$__loc__`: a program can only read the document it is given.
 */

export class PathSyntaxError extends Error {
  readonly at: number;
  constructor(why: string, at: number) {
    super(`${why} (at position ${at})`);
    this.at = at;
  }
}

export class LimitExceeded extends Error {
  constructor(why: string) {
    super(why);
  }
}

export interface Limits {
  /** Nodes visited. */
  readonly maxSteps?: number;
  /** Results returned. */
  readonly maxResults?: number;
  /** Deepest descent into the document. */
  readonly maxDepth?: number;
}
const DEFAULTS = { maxSteps: 100_000, maxResults: 10_000, maxDepth: 128 } as const;

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Nothing = typeof NOTHING;
const NOTHING = Symbol('Nothing');

// ---------------------------------------------------------------- AST

type Selector =
  | { k: 'name'; name: string }
  | { k: 'wild' }
  | { k: 'index'; i: number }
  | { k: 'slice'; start: number | undefined; end: number | undefined; step: number }
  | { k: 'filter'; e: LogicalExpr };
interface Segment {
  readonly descendant: boolean;
  readonly selectors: readonly Selector[];
}
interface Query {
  readonly relative: boolean;
  readonly segments: readonly Segment[];
}
type Operand = { k: 'lit'; v: Json } | { k: 'query'; q: Query } | { k: 'call'; name: string; args: Arg[] };
type Arg = Operand | LogicalExpr;
type LogicalExpr =
  | { k: 'or' | 'and'; l: LogicalExpr; r: LogicalExpr }
  | { k: 'not'; e: LogicalExpr }
  | { k: 'cmp'; op: '==' | '!=' | '<' | '<=' | '>' | '>='; l: Operand; r: Operand }
  | { k: 'test'; q: Query }
  | { k: 'fn'; call: Extract<Operand, { k: 'call' }> };

export interface Compiled {
  readonly source: string;
  readonly query: Query;
}

// ---------------------------------------------------------------- parser

const MAX_INT = 9007199254740991;
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isNameFirst = (c: string | undefined) => c !== undefined && (/[A-Za-z_]/.test(c) || c.codePointAt(0)! >= 0x80);
const isNameChar = (c: string | undefined) => isNameFirst(c) || isDigit(c);
type FnSig = { params: ('value' | 'nodes' | 'logical')[]; result: 'value' | 'logical' | 'nodes' };
const FUNCS: Record<string, FnSig> = {
  length: { params: ['value'], result: 'value' },
  count: { params: ['nodes'], result: 'value' },
  match: { params: ['value', 'value'], result: 'logical' },
  search: { params: ['value', 'value'], result: 'logical' },
  value: { params: ['nodes'], result: 'value' },
};

class Parser {
  p = 0;
  readonly s: string;
  constructor(s: string) {
    this.s = s;
  }
  err(why: string, at = this.p): never { throw new PathSyntaxError(why, at); }
  ws() { while (' \t\n\r'.includes(this.s[this.p] ?? 'x')) this.p++; }
  eat(t: string) { if (this.s.startsWith(t, this.p)) { this.p += t.length; return true; } return false; }

  parse(): Query {
    if (this.s.length && ' \t\n\r'.includes(this.s[0]!)) this.err('a path cannot start with blank space', 0);
    if (!this.eat('$')) this.err('a path starts with $');
    const segments = this.segments();
    if (this.p < this.s.length) this.err(`unexpected "${this.s[this.p]}"`);
    return { relative: false, segments };
  }

  segments(): Segment[] {
    const out: Segment[] = [];
    for (;;) {
      const save = this.p;
      this.ws();
      const c = this.s[this.p];
      if (c === '.' || c === '[') out.push(this.segment());
      else { this.p = save; return out; }
    }
  }

  segment(): Segment {
    if (this.eat('..')) {
      if (this.s[this.p] === '[') return { descendant: true, selectors: this.bracketed() };
      if (this.eat('*')) return { descendant: true, selectors: [{ k: 'wild' }] };
      return { descendant: true, selectors: [{ k: 'name', name: this.member() }] };
    }
    if (this.eat('.')) {
      if (this.eat('*')) return { descendant: false, selectors: [{ k: 'wild' }] };
      return { descendant: false, selectors: [{ k: 'name', name: this.member() }] };
    }
    return { descendant: false, selectors: this.bracketed() };
  }

  member(): string {
    if (!isNameFirst(this.s[this.p])) this.err('expected a member name');
    const st = this.p;
    while (isNameChar(this.s[this.p])) this.p++;
    return this.s.slice(st, this.p);
  }

  bracketed(): Selector[] {
    this.eat('[');
    const out: Selector[] = [];
    for (;;) {
      this.ws();
      out.push(this.selector());
      this.ws();
      if (this.eat(',')) continue;
      if (this.eat(']')) return out;
      this.err('expected , or ]');
    }
  }

  int(): number {
    const st = this.p;
    if (this.s[this.p] === '-') this.p++;
    if (!isDigit(this.s[this.p])) this.err('expected a number', st);
    if (this.s[this.p] === '0' && isDigit(this.s[this.p + 1])) this.err('no leading zeros', st);
    while (isDigit(this.s[this.p])) this.p++;
    const t = this.s.slice(st, this.p);
    if (t === '-0') this.err('-0 is not a valid index', st);
    const n = Number(t);
    if (!Number.isSafeInteger(n) || Math.abs(n) > MAX_INT) this.err('the number is out of range', st);
    return n;
  }

  selector(): Selector {
    const c = this.s[this.p];
    if (c === '*') { this.p++; return { k: 'wild' }; }
    if (c === '"' || c === "'") return { k: 'name', name: this.string() };
    if (c === '?') { this.p++; this.ws(); return { k: 'filter', e: this.logicalOr(0) }; }
    if (c === ':' || c === '-' || isDigit(c)) {
      const first = c === ':' ? undefined : this.int();
      this.ws();
      if (!this.eat(':')) {
        if (first === undefined) this.err('expected a selector');
        return { k: 'index', i: first };
      }
      this.ws();
      const nextIsNum = this.s[this.p] === '-' || isDigit(this.s[this.p]);
      const end = nextIsNum ? this.int() : undefined;
      this.ws();
      let step = 1;
      if (this.eat(':')) {
        this.ws();
        if (this.s[this.p] === '-' || isDigit(this.s[this.p])) step = this.int();
      }
      return { k: 'slice', start: first, end, step };
    }
    return this.err('expected a selector');
  }

  string(): string {
    const q = this.s[this.p++]!;
    let out = '';
    for (;;) {
      const c = this.s[this.p];
      if (c === undefined) this.err('an unterminated string');
      if (c === q) { this.p++; return out; }
      if (c === '\\') {
        const e = this.s[this.p + 1];
        this.p += 2;
        switch (e) {
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case '/': out += '/'; break;
          case '\\': out += '\\'; break;
          case q: out += q; break;
          case 'u': {
            const hex = this.s.slice(this.p, this.p + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.err('a bad \\u escape');
            let cp = parseInt(hex, 16);
            this.p += 4;
            if (cp >= 0xd800 && cp <= 0xdbff) {
              const lo = /^\\u([dD][c-fC-F][0-9a-fA-F]{2})/.exec(this.s.slice(this.p, this.p + 6));
              if (!lo) this.err('a high surrogate needs a low surrogate');
              cp = 0x10000 + ((cp - 0xd800) << 10) + (parseInt(lo![1]!, 16) - 0xdc00);
              this.p += 6;
            } else if (cp >= 0xdc00 && cp <= 0xdfff) this.err('a lone low surrogate');
            out += String.fromCodePoint(cp);
            break;
          }
          default: this.err('a bad escape');
        }
        continue;
      }
      if (c.charCodeAt(0) < 0x20) this.err('a control character in a string');
      out += c;
      this.p++;
    }
  }

  // Filter expressions. `depth` bounds nesting.
  logicalOr(depth: number): LogicalExpr {
    if (depth > 32) this.err('the filter is nested too deeply');
    let l = this.logicalAnd(depth);
    for (;;) {
      this.ws();
      if (this.eat('||')) { this.ws(); l = { k: 'or', l, r: this.logicalAnd(depth) }; } else return l;
    }
  }
  logicalAnd(depth: number): LogicalExpr {
    let l = this.basic(depth);
    for (;;) {
      this.ws();
      if (this.eat('&&')) { this.ws(); l = { k: 'and', l, r: this.basic(depth) }; } else return l;
    }
  }
  basic(depth: number): LogicalExpr {
    this.ws();
    if (this.s[this.p] === '!') {
      this.p++;
      this.ws();
      if (this.s[this.p] === '(') return { k: 'not', e: this.paren(depth) };
      const t = this.testOrCall();
      return { k: 'not', e: t };
    }
    if (this.s[this.p] === '(') return this.paren(depth);
    const save = this.p;
    const l = this.operand();
    this.ws();
    const m = /^(==|!=|<=|>=|<|>)/.exec(this.s.slice(this.p, this.p + 2));
    if (m) {
      this.p += m[1]!.length;
      this.ws();
      const r = this.operand();
      this.comparable(l, save);
      this.comparable(r, this.p);
      return { k: 'cmp', op: m[1] as '==', l, r };
    }
    this.p = save;
    return this.testOrCall();
  }
  paren(depth: number): LogicalExpr {
    this.eat('(');
    const e = this.logicalOr(depth + 1);
    this.ws();
    if (!this.eat(')')) this.err('expected )');
    return e;
  }
  testOrCall(): LogicalExpr {
    this.ws();
    const c = this.s[this.p];
    if (c === '@' || c === '$') return { k: 'test', q: this.filterQuery() };
    const call = this.operand();
    if (call.k !== 'call') this.err('a literal cannot be tested');
    if (FUNCS[call.name]!.result !== 'logical') this.err(`${call.name}() does not give true or false`);
    return { k: 'fn', call };
  }
  comparable(o: Operand, at: number) {
    if (o.k === 'query' && !isSingular(o.q)) this.err('a comparison needs a query that gives at most one value', at);
    if (o.k === 'call' && FUNCS[o.name]!.result !== 'value') this.err(`${o.name}() cannot be compared`, at);
  }
  filterQuery(): Query {
    const relative = this.s[this.p] === '@';
    this.p++;
    return { relative, segments: this.segments() };
  }
  operand(): Operand {
    this.ws();
    const c = this.s[this.p];
    if (c === '@' || c === '$') return { k: 'query', q: this.filterQuery() };
    if (c === '"' || c === "'") return { k: 'lit', v: this.string() };
    if (c === '-' || isDigit(c)) {
      const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/.exec(this.s.slice(this.p));
      if (!m) this.err('a bad number');
      this.p += m![0].length;
      const n = Number(m![0]);
      if (!Number.isFinite(n)) this.err('the number is out of range');
      return { k: 'lit', v: n };
    }
    for (const [w, v] of [['true', true], ['false', false], ['null', null]] as const) {
      if (this.s.startsWith(w, this.p) && !isNameChar(this.s[this.p + w.length]) && this.s[this.p + w.length] !== '(') { this.p += w.length; return { k: 'lit', v }; }
    }
    if (c !== undefined && /[a-z]/.test(c)) {
      const st = this.p;
      while (/[a-z0-9_]/.test(this.s[this.p] ?? '')) this.p++;
      const name = this.s.slice(st, this.p);
      if (this.s[this.p] !== '(' || !Object.hasOwn(FUNCS, name)) this.err(`${name} is not a function`, st);
      this.p++;
      const sig = FUNCS[name]!;
      const args: Arg[] = [];
      this.ws();
      if (this.s[this.p] !== ')') {
        for (;;) {
          this.ws();
          args.push(this.arg());
          this.ws();
          if (this.eat(',')) continue;
          break;
        }
      }
      if (!this.eat(')')) this.err('expected )');
      if (args.length !== sig.params.length) this.err(`${name}() takes ${sig.params.length} argument(s)`, st);
      args.forEach((a, i) => this.checkArg(name, a, sig.params[i]!, st));
      return { k: 'call', name, args };
    }
    return this.err('expected a value, a query or a function');
  }
  arg(): Arg {
    const save = this.p;
    const c = this.s[this.p];
    if (c === '!' || c === '(') return this.logicalOr(0);
    const o = this.operand();
    this.ws();
    if (/^(==|!=|<=|>=|<|>|&&|\|\|)/.test(this.s.slice(this.p, this.p + 2))) { this.p = save; return this.logicalOr(0); }
    return o;
  }
  checkArg(fn: string, a: Arg, want: 'value' | 'nodes' | 'logical', at: number) {
    const kind = 'k' in a && (a.k === 'lit' || a.k === 'query' || a.k === 'call') ? (a as Operand) : undefined;
    if (want === 'logical') {
      if (!kind || kind.k === 'query' || (kind.k === 'call' && FUNCS[kind.name]!.result === 'logical')) return;
      this.err(`${fn}() needs a true or false argument`, at);
    }
    if (!kind) this.err(`${fn}() needs a value or a query`, at);
    if (want === 'nodes') { if (kind!.k !== 'query') this.err(`${fn}() needs a query`, at); return; }
    if (kind!.k === 'lit') return;
    if (kind!.k === 'query') { if (!isSingular(kind!.q)) this.err(`${fn}() needs a query that gives at most one value`, at); return; }
    if (FUNCS[kind!.name]!.result !== 'value') this.err(`${fn}() cannot take ${kind!.name}() here`, at);
  }
}

function isSingular(q: Query): boolean {
  return q.segments.every((s) => !s.descendant && s.selectors.length === 1 && (s.selectors[0]!.k === 'name' || s.selectors[0]!.k === 'index'));
}

/** Parses and type-checks a JSONPath. Throws PathSyntaxError with the position. */
export function compile(path: string): Compiled {
  if (path.length > 4096) throw new PathSyntaxError('a path may be at most 4096 characters', 0);
  return { source: path, query: new Parser(path).parse() };
}

// ---------------------------------------------------------------- evaluation

export interface Node {
  readonly value: Json;
  /** The normalised path (RFC 9535 2.7), e.g. $['store']['book'][0]. */
  readonly path: string;
}

const isObj = (v: unknown): v is { [k: string]: Json } => typeof v === 'object' && v !== null && !Array.isArray(v);
const quote = (s: string) => `'${[...s].map((c) => { const n = c.codePointAt(0)!; return c === "'" ? "\\'" : c === '\\' ? '\\\\' : c === '\b' ? '\\b' : c === '\f' ? '\\f' : c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : n < 0x20 ? `\\u${n.toString(16).padStart(4, '0')}` : c; }).join('')}'`;

class Run {
  steps = 0;
  results = 0;
  readonly lim: Required<Limits>;
  readonly root: Json;
  constructor(root: Json, limits: Limits) {
    this.root = root;
    this.lim = { ...DEFAULTS, ...limits };
  }
  step() { if (++this.steps > this.lim.maxSteps) throw new LimitExceeded(`more than ${this.lim.maxSteps} nodes visited`); }

  children(n: Node, f: (c: Node) => void) {
    if (Array.isArray(n.value)) n.value.forEach((v, i) => f({ value: v, path: `${n.path}[${i}]` }));
    else if (isObj(n.value)) for (const k of Object.keys(n.value)) f({ value: n.value[k]!, path: `${n.path}[${quote(k)}]` });
  }

  query(q: Query, current: Node): Node[] {
    let nodes: Node[] = [q.relative ? current : { value: this.root, path: '$' }];
    for (const seg of q.segments) {
      const next: Node[] = [];
      for (const n of nodes) {
        const targets: Node[] = [];
        if (seg.descendant) this.descend(n, 0, (d) => targets.push(d));
        else targets.push(n);
        for (const t of targets) for (const sel of seg.selectors) this.select(sel, t, current, (r) => {
          this.step();
          if (++this.results > this.lim.maxResults * 10) throw new LimitExceeded(`more than ${this.lim.maxResults} results`);
          next.push(r);
        });
      }
      nodes = next;
      if (nodes.length > this.lim.maxResults) throw new LimitExceeded(`more than ${this.lim.maxResults} results`);
    }
    return nodes;
  }

  descend(n: Node, depth: number, f: (n: Node) => void) {
    if (depth > this.lim.maxDepth) throw new LimitExceeded(`deeper than ${this.lim.maxDepth} levels`);
    this.step();
    f(n);
    this.children(n, (c) => this.descend(c, depth + 1, f));
  }

  select(sel: Selector, n: Node, current: Node, out: (r: Node) => void) {
    const v = n.value;
    switch (sel.k) {
      case 'name':
        if (isObj(v) && Object.hasOwn(v, sel.name)) out({ value: v[sel.name]!, path: `${n.path}[${quote(sel.name)}]` });
        return;
      case 'wild': this.children(n, out); return;
      case 'index':
        if (Array.isArray(v)) {
          const i = sel.i >= 0 ? sel.i : v.length + sel.i;
          if (i >= 0 && i < v.length) out({ value: v[i]!, path: `${n.path}[${i}]` });
        }
        return;
      case 'slice': {
        if (!Array.isArray(v) || sel.step === 0) return;
        const len = v.length;
        const norm = (i: number) => (i >= 0 ? i : len + i);
        const step = sel.step;
        const ns = norm(sel.start ?? (step > 0 ? 0 : len - 1));
        const ne = norm(sel.end ?? (step > 0 ? len : -len - 1));
        if (step > 0) {
          const lo = Math.min(Math.max(ns, 0), len), hi = Math.min(Math.max(ne, 0), len);
          for (let i = lo; i < hi; i += step) { this.step(); out({ value: v[i]!, path: `${n.path}[${i}]` }); }
        } else {
          const hi = Math.min(Math.max(ns, -1), len - 1), lo = Math.min(Math.max(ne, -1), len - 1);
          for (let i = hi; lo < i; i += step) { this.step(); out({ value: v[i]!, path: `${n.path}[${i}]` }); }
        }
        return;
      }
      case 'filter':
        this.children(n, (c) => { this.step(); if (this.logical(sel.e, c)) out(c); });
        return;
    }
    void current;
  }

  logical(e: LogicalExpr, cur: Node): boolean {
    switch (e.k) {
      case 'or': return this.logical(e.l, cur) || this.logical(e.r, cur);
      case 'and': return this.logical(e.l, cur) && this.logical(e.r, cur);
      case 'not': return !this.logical(e.e, cur);
      case 'test': return this.query(e.q, cur).length > 0;
      case 'fn': return this.call(e.call, cur) === true;
      case 'cmp': return compareValues(e.op, this.value(e.l, cur), this.value(e.r, cur));
    }
  }

  value(o: Operand, cur: Node): Json | Nothing {
    if (o.k === 'lit') return o.v;
    if (o.k === 'query') { const r = this.query(o.q, cur); return r.length === 1 ? r[0]!.value : NOTHING; }
    return this.call(o, cur) as Json | Nothing;
  }

  call(c: Extract<Operand, { k: 'call' }>, cur: Node): Json | Nothing {
    const arg = (i: number): Json | Nothing => { const a = c.args[i]!; return 'k' in a && (a.k === 'lit' || a.k === 'query' || a.k === 'call') ? this.value(a as Operand, cur) : this.logical(a as LogicalExpr, cur); };
    switch (c.name) {
      case 'length': {
        const v = arg(0);
        if (typeof v === 'string') return [...v].length;
        if (Array.isArray(v)) return v.length;
        if (v !== NOTHING && isObj(v)) return Object.keys(v).length;
        return NOTHING;
      }
      case 'count': return this.query((c.args[0] as { q: Query }).q, cur).length;
      case 'value': { const r = this.query((c.args[0] as { q: Query }).q, cur); return r.length === 1 ? r[0]!.value : NOTHING; }
      default: {
        const s = arg(0), p = arg(1);
        if (typeof s !== 'string' || typeof p !== 'string') return false;
        const re = iregexp(p, c.name === 'match');
        return re ? re.test(s) : false;
      }
    }
  }
}

function deepEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]!));
  if (isObj(a) && isObj(b)) { const ka = Object.keys(a); return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k]!, b[k]!)); }
  return false;
}

function compareValues(op: string, l: Json | Nothing, r: Json | Nothing): boolean {
  const eq = l === NOTHING || r === NOTHING ? l === r : deepEqual(l, r);
  switch (op) {
    case '==': return eq;
    case '!=': return !eq;
  }
  const lt = (a: Json | Nothing, b: Json | Nothing) => (typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string') ? (a as number) < (b as number) : false;
  switch (op) {
    case '<': return lt(l, r);
    case '>': return lt(r, l);
    case '<=': return lt(l, r) || eq;
    default: return lt(r, l) || eq;
  }
}

const reCache = new Map<string, RegExp | undefined>();
/** An I-Regexp (RFC 9485) as a JavaScript regular expression, anchored for match; undefined if it is invalid or unsafe. */
function iregexp(p: string, anchored: boolean): RegExp | undefined {
  const key = `${anchored ? 'm' : 's'}${p}`;
  if (reCache.has(key)) return reCache.get(key);
  let re: RegExp | undefined;
  if (p.length <= 200 && !/\\[1-9kpP]|\(\?|[+*}]\)[+*{]|\([^)]*[+*][^)]*\)[+*{]/.test(p)) {
    try {
      const body = p.replace(/\\.|\[(?:\\.|[^\]\\])*\]|\./g, (m) => (m === '.' ? '[^\\n\\r]' : m));
      re = new RegExp(anchored ? `^(?:${body})$` : body, 'u');
    } catch { re = undefined; }
  }
  if (reCache.size > 500) reCache.clear();
  reCache.set(key, re);
  return re;
}

/** Runs a JSONPath over a document and returns every matched node with its normalised path. */
export function query(doc: unknown, path: string | Compiled, limits: Limits = {}): Node[] {
  const c = typeof path === 'string' ? compile(path) : path;
  const run = new Run(doc as Json, limits);
  const out = run.query(c.query, { value: doc as Json, path: '$' });
  if (out.length > run.lim.maxResults) throw new LimitExceeded(`more than ${run.lim.maxResults} results`);
  return out;
}

export const values = (doc: unknown, path: string | Compiled, limits?: Limits): Json[] => query(doc, path, limits).map((n) => n.value);
export const paths = (doc: unknown, path: string | Compiled, limits?: Limits): string[] => query(doc, path, limits).map((n) => n.path);

// ---------------------------------------------------------------- transform (jq-like subset)

export class TransformError extends Error {
  constructor(why: string) {
    super(why);
  }
}

type Ast =
  | { t: 'id' } | { t: 'recurse' } | { t: 'lit'; v: Json } | { t: 'field'; of: Ast; name: Ast; opt: boolean }
  | { t: 'index'; of: Ast; at: Ast; opt: boolean } | { t: 'slice'; of: Ast; from: Ast | undefined; to: Ast | undefined; opt: boolean }
  | { t: 'iter'; of: Ast; opt: boolean } | { t: 'pipe' | 'comma' | 'alt' | 'or' | 'and'; l: Ast; r: Ast }
  | { t: 'bin'; op: string; l: Ast; r: Ast } | { t: 'neg'; e: Ast } | { t: 'array'; e: Ast | undefined }
  | { t: 'object'; entries: { k: Ast; v: Ast }[] } | { t: 'if'; c: Ast; a: Ast; b: Ast | undefined }
  | { t: 'call'; name: string; args: Ast[] } | { t: 'try'; e: Ast };

type Tk = { k: 'num' | 'str' | 'id' | 'op' | 'field'; v: string; at: number };
const jqErr = (m: string, at: number) => new TransformError(`${m} (at position ${at})`);

function lex(src: string): Tk[] {
  const out: Tk[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\') j++; j++; }
      if (j >= src.length) throw jqErr('an unterminated string', i);
      let v: string;
      try { v = JSON.parse(src.slice(i, j + 1)) as string; } catch { throw jqErr('a bad string escape', i); }
      if (v.includes('\\(')) throw jqErr('string interpolation is not supported', i);
      out.push({ k: 'str', v, at: i });
      i = j + 1;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i));
    if (num && !(c === '.' && !/\d/.test(src[i + 1] ?? ''))) { out.push({ k: 'num', v: num[0], at: i }); i += num[0].length; continue; }
    const fld = /^\.([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i));
    if (fld) { out.push({ k: 'field', v: fld[1]!, at: i }); i += fld[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { out.push({ k: 'id', v: id[0], at: i }); i += id[0].length; continue; }
    const op = ['..', '==', '!=', '<=', '>=', '//'].find((o) => src.startsWith(o, i)) ?? (/[.|,()[\]{}:?+\-*/%<>;]/.test(c) ? c : undefined);
    if (!op) throw jqErr(`cannot read "${c}"`, i);
    out.push({ k: 'op', v: op, at: i });
    i += op.length;
  }
  return out;
}

const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'end', 'and', 'or', 'not']);

function parseJq(src: string): Ast {
  if (src.length > 10_000) throw jqErr('a program may be at most 10000 characters', 0);
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => toks[p]?.k === 'op' && toks[p]!.v === v;
  const isId = (v: string) => toks[p]?.k === 'id' && toks[p]!.v === v;
  const need = (v: string) => { if (!isOp(v)) throw jqErr(`expected ${v}`, toks[p]?.at ?? src.length); p++; };
  let depth = 0;
  const guard = () => { if (++depth > 100) throw jqErr('the program is nested too deeply', toks[p]?.at ?? 0); };
  const pipe = (): Ast => {
    guard();
    const l = comma();
    let out = l;
    if (isOp('|')) { p++; out = { t: 'pipe', l, r: pipe() }; }
    depth--;
    return out;
  };
  const comma = (): Ast => { let l = alt(); while (isOp(',')) { p++; l = { t: 'comma', l, r: alt() }; } return l; };
  const alt = (): Ast => { const l = or(); if (isOp('//')) { p++; return { t: 'alt', l, r: alt() }; } return l; };
  const or = (): Ast => { let l = and(); while (isId('or')) { p++; l = { t: 'or', l, r: and() }; } return l; };
  const and = (): Ast => { let l = cmp(); while (isId('and')) { p++; l = { t: 'and', l, r: cmp() }; } return l; };
  const cmp = (): Ast => {
    const l = add();
    const t = peek();
    if (t?.k === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) { p++; return { t: 'bin', op: t.v, l, r: add() }; }
    return l;
  };
  const add = (): Ast => { let l = mul(); while (isOp('+') || isOp('-')) { const op = toks[p++]!.v; l = { t: 'bin', op, l, r: mul() }; } return l; };
  const mul = (): Ast => { let l = postfix(); while (isOp('*') || isOp('/') || isOp('%')) { const op = toks[p++]!.v; l = { t: 'bin', op, l, r: postfix() }; } return l; };
  const postfix = (): Ast => {
    let e = primary();
    for (;;) {
      const t = peek();
      if (t?.k === 'field') { p++; e = { t: 'field', of: e, name: { t: 'lit', v: t.v }, opt: opt() }; }
      else if (isOp('.') && toks[p + 1]?.k === 'str') { p++; const s = toks[p++]!; e = { t: 'field', of: e, name: { t: 'lit', v: s.v }, opt: opt() }; }
      else if (isOp('[')) { p++; e = bracket(e); }
      else if (isOp('.') && toks[p + 1]?.v === '[') { p++; }
      else if (isOp('?')) { p++; e = { t: 'try', e }; }
      else return e;
    }
  };
  const opt = () => { if (isOp('?')) { p++; return true; } return false; };
  const bracket = (of: Ast): Ast => {
    if (isOp(']')) { p++; return { t: 'iter', of, opt: opt() }; }
    if (isOp(':')) { p++; const to = pipe(); need(']'); return { t: 'slice', of, from: undefined, to, opt: opt() }; }
    const a = pipe();
    if (isOp(':')) { p++; const to = isOp(']') ? undefined : pipe(); need(']'); return { t: 'slice', of, from: a, to, opt: opt() }; }
    need(']');
    return { t: 'index', of, at: a, opt: opt() };
  };
  const primary = (): Ast => {
    const t = peek();
    if (!t) throw jqErr('the program ends too soon', src.length);
    if (t.k === 'num') { p++; return { t: 'lit', v: Number(t.v) }; }
    if (t.k === 'str') { p++; return { t: 'lit', v: t.v }; }
    if (t.k === 'field') { p++; return { t: 'field', of: { t: 'id' }, name: { t: 'lit', v: t.v }, opt: opt() }; }
    if (t.k === 'op') {
      if (t.v === '.') {
        p++;
        if (peek()?.k === 'str') { const s = toks[p++]!; return { t: 'field', of: { t: 'id' }, name: { t: 'lit', v: s.v }, opt: opt() }; }
        if (isOp('[')) { p++; return bracket({ t: 'id' }); }
        return { t: 'id' };
      }
      if (t.v === '..') { p++; return { t: 'recurse' }; }
      if (t.v === '(') { p++; const e = pipe(); need(')'); return e; }
      if (t.v === '-') { p++; return { t: 'neg', e: postfix() }; }
      if (t.v === '[') { p++; if (isOp(']')) { p++; return { t: 'array', e: undefined }; } const e = pipe(); need(']'); return { t: 'array', e }; }
      if (t.v === '{') return object();
    }
    if (t.k === 'id') {
      if (t.v === 'if') return ifExpr();
      if (['true', 'false', 'null'].includes(t.v)) { p++; return { t: 'lit', v: t.v === 'null' ? null : t.v === 'true' }; }
      if (KEYWORDS.has(t.v) && t.v !== 'not') throw jqErr(`unexpected ${t.v}`, t.at);
      p++;
      const args: Ast[] = [];
      if (isOp('(')) { p++; for (;;) { args.push(pipe()); if (isOp(';')) { p++; continue; } break; } need(')'); }
      return { t: 'call', name: t.v, args };
    }
    throw jqErr(`unexpected "${t.v}"`, t.at);
  };
  const ifExpr = (): Ast => {
    p++;
    const c = pipe();
    if (!isId('then')) throw jqErr('expected then', toks[p]?.at ?? 0);
    p++;
    const a = pipe();
    let b: Ast | undefined;
    if (isId('elif')) { toks[p] = { k: 'id', v: 'if', at: toks[p]!.at }; b = ifExpr(); return { t: 'if', c, a, b }; }
    if (isId('else')) { p++; b = pipe(); }
    if (!isId('end')) throw jqErr('expected end', toks[p]?.at ?? 0);
    p++;
    return { t: 'if', c, a, b };
  };
  const object = (): Ast => {
    p++;
    const entries: { k: Ast; v: Ast }[] = [];
    if (isOp('}')) { p++; return { t: 'object', entries }; }
    for (;;) {
      const t = peek();
      let k: Ast;
      if (t?.k === 'id' || t?.k === 'str') { p++; k = { t: 'lit', v: t.v }; }
      else if (isOp('(')) { p++; k = pipe(); need(')'); }
      else throw jqErr('expected an object key', t?.at ?? 0);
      if (isOp(':')) { p++; entries.push({ k, v: alt() }); }
      else entries.push({ k, v: { t: 'field', of: { t: 'id' }, name: k, opt: false } });
      if (isOp(',')) { p++; continue; }
      need('}');
      return { t: 'object', entries };
    }
  };
  const ast = pipe();
  if (p < toks.length) throw jqErr(`unexpected "${toks[p]!.v}"`, toks[p]!.at);
  return ast;
}

const typeName = (v: Json) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v);
const ORDER = ['null', 'boolean', 'number', 'string', 'array', 'object'];
function cmpJq(a: Json, b: Json): number {
  const ta = ORDER.indexOf(typeName(a) === 'boolean' ? 'boolean' : typeName(a)), tb = ORDER.indexOf(typeName(b));
  if (typeName(a) === 'boolean' && typeName(b) === 'boolean') return a === b ? 0 : a ? 1 : -1;
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (typeof a === 'number' || typeof a === 'string') return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  if (Array.isArray(a)) { const bb = b as Json[]; for (let i = 0; i < Math.min(a.length, bb.length); i++) { const c = cmpJq(a[i]!, bb[i]!); if (c) return c; } return a.length - bb.length < 0 ? -1 : a.length > bb.length ? 1 : 0; }
  if (isObj(a)) {
    const bo = b as { [k: string]: Json };
    const ka = Object.keys(a).sort(), kb = Object.keys(bo).sort();
    const kc = cmpJq(ka, kb);
    if (kc) return kc;
    for (const k of ka) { const c = cmpJq(a[k]!, bo[k]!); if (c) return c; }
  }
  return 0;
}
const truthy = (v: Json) => v !== null && v !== false;

export interface TransformLimits {
  readonly maxSteps?: number;
  readonly maxOutputs?: number;
  /** Longest array or string a program may build. */
  readonly maxSize?: number;
}

/** Runs a jq-like program over a document and returns every output. */
export function transform(doc: unknown, program: string, limits: TransformLimits = {}): Json[] {
  const ast = parseJq(program);
  const maxSteps = limits.maxSteps ?? 1_000_000;
  const maxOut = limits.maxOutputs ?? 10_000;
  const maxSize = limits.maxSize ?? 1_000_000;
  let steps = 0;
  const tick = () => { if (++steps > maxSteps) throw new LimitExceeded(`more than ${maxSteps} steps`); };
  const size = (n: number) => { if (n > maxSize) throw new LimitExceeded(`a value larger than ${maxSize}`); };
  const fail = (m: string): never => { throw new TransformError(m); };
  const show = (v: Json) => JSON.stringify(v)?.slice(0, 30) ?? 'null';
  function collectAll(ast: Ast, input: Json, d: number): Json[] {
    const out: Json[] = [];
    for (const v of ev(ast, input, d)) { out.push(v); size(out.length); }
    return out;
  }
  function arith(op: string, a: Json, b: Json): Json {
    if (op === '+') {
      if (a === null) return b;
      if (b === null) return a;
      if (typeof a === 'number' && typeof b === 'number') return a + b;
      if (typeof a === 'string' && typeof b === 'string') { size(a.length + b.length); return a + b; }
      if (Array.isArray(a) && Array.isArray(b)) { size(a.length + b.length); return [...a, ...b]; }
      if (isObj(a) && isObj(b)) return { ...a, ...b };
    } else if (op === '-') {
      if (typeof a === 'number' && typeof b === 'number') return a - b;
      if (Array.isArray(a) && Array.isArray(b)) return a.filter((x) => !b.some((y) => cmpJq(x, y) === 0));
    } else if (op === '*') {
      if (typeof a === 'number' && typeof b === 'number') return a * b;
      if (typeof a === 'string' && typeof b === 'number') { size(a.length * Math.max(0, Math.ceil(b))); return b > 0 ? a.repeat(Math.ceil(b)) : null; }
      if (isObj(a) && isObj(b)) { const r: { [k: string]: Json } = { ...a }; for (const k of Object.keys(b)) r[k] = isObj(r[k]!) && isObj(b[k]!) ? (arith('*', r[k]!, b[k]!) as Json) : b[k]!; return r; }
    } else if (op === '/') {
      if (typeof a === 'number' && typeof b === 'number') { if (b === 0) fail(`${show(a)} and ${show(b)} cannot be divided because the divisor is zero`); return a / b; }
      if (typeof a === 'string' && typeof b === 'string') return a.split(b);
    } else if (op === '%') {
      if (typeof a === 'number' && typeof b === 'number') { const x = Math.trunc(a), y = Math.trunc(b); if (y === 0) fail('cannot be divided because the divisor is zero'); return x % y; }
    }
    return fail(`${typeName(a)} (${show(a)}) and ${typeName(b)} (${show(b)}) cannot be ${op === '+' ? 'added' : op === '-' ? 'subtracted' : op === '*' ? 'multiplied' : op === '/' ? 'divided' : 'taken modulo'}`);
  }
  function idx(v: Json, k: Json): Json {
    if (isObj(v) && typeof k === 'string') return Object.hasOwn(v, k) ? v[k]! : null;
    if (Array.isArray(v) && typeof k === 'number') { const i = Math.floor(k); const j = i < 0 ? v.length + i : i; return j >= 0 && j < v.length ? v[j]! : null; }
    if (v === null && (typeof k === 'string' || typeof k === 'number')) return null;
    return fail(`Cannot index ${typeName(v)} with ${typeof k === 'string' ? `"${k}"` : typeName(k)}`);
  }
  function* ev(a: Ast, input: Json, d: number): Generator<Json> {
    tick();
    if (d > 200) throw new LimitExceeded('evaluation nested too deeply');
    switch (a.t) {
      case 'id': yield input; return;
      case 'lit': yield a.v; return;
      case 'recurse': yield* recurse(input, 0); return;
      case 'pipe': for (const x of ev(a.l, input, d + 1)) yield* ev(a.r, x, d + 1); return;
      case 'comma': yield* ev(a.l, input, d + 1); yield* ev(a.r, input, d + 1); return;
      case 'field': case 'index':
        for (const base of ev(a.of, input, d + 1)) for (const k of ev(a.t === 'field' ? a.name : a.at, input, d + 1)) {
          try { yield idx(base, k); } catch (e) { if (!a.opt) throw e; }
        }
        return;
      case 'slice':
        for (const base of ev(a.of, input, d + 1)) {
          const froms = a.from ? [...ev(a.from, input, d + 1)] : [null];
          const tos = a.to ? [...ev(a.to, input, d + 1)] : [null];
          for (const f of froms) for (const t of tos) {
            try {
              if (base === null) { yield null; continue; }
              if (typeof base !== 'string' && !Array.isArray(base)) fail(`Cannot index ${typeName(base)} with object`);
              const len = (base as string | Json[]).length;
              const norm = (x: Json, dflt: number) => (x === null ? dflt : typeof x === 'number' ? Math.min(len, Math.max(0, x < 0 ? len + Math.floor(x) : Math.floor(x))) : fail('Start and end indices of an array slice must be numbers'));
              const s = norm(f, 0), e = norm(t, len);
              yield (base as string | Json[]).slice(s, Math.max(s, e));
            } catch (e) { if (!a.opt) throw e; }
          }
        }
        return;
      case 'iter':
        for (const base of ev(a.of, input, d + 1)) {
          if (Array.isArray(base)) yield* base;
          else if (isObj(base)) yield* Object.values(base);
          else if (!a.opt) fail(`Cannot iterate over ${typeName(base)}`);
        }
        return;
      case 'try': try { yield* collectAll(a.e, input, d + 1); } catch (e) { if (!(e instanceof TransformError)) throw e; } return;
      case 'neg': for (const v of ev(a.e, input, d + 1)) { if (typeof v !== 'number') return fail(`${typeName(v)} cannot be negated`); yield -v; } return;
      case 'bin':
        for (const r of ev(a.r, input, d + 1)) for (const l of ev(a.l, input, d + 1)) {
          if (['+', '-', '*', '/', '%'].includes(a.op)) yield arith(a.op, l, r);
          else { const c = cmpJq(l, r); yield a.op === '==' ? c === 0 : a.op === '!=' ? c !== 0 : a.op === '<' ? c < 0 : a.op === '<=' ? c <= 0 : a.op === '>' ? c > 0 : c >= 0; }
        }
        return;
      case 'and': for (const l of ev(a.l, input, d + 1)) { if (!truthy(l)) yield false; else for (const r of ev(a.r, input, d + 1)) yield truthy(r); } return;
      case 'or': for (const l of ev(a.l, input, d + 1)) { if (truthy(l)) yield true; else for (const r of ev(a.r, input, d + 1)) yield truthy(r); } return;
      case 'alt': { let any = false; try { for (const v of ev(a.l, input, d + 1)) if (truthy(v)) { any = true; yield v; } } catch (e) { if (!(e instanceof TransformError)) throw e; } if (!any) yield* ev(a.r, input, d + 1); return; }
      case 'if': for (const c of ev(a.c, input, d + 1)) { if (truthy(c)) yield* ev(a.a, input, d + 1); else if (a.b) yield* ev(a.b, input, d + 1); else yield input; } return;
      case 'array': { const out = a.e ? collectAll(a.e, input, d + 1) : []; size(out.length); yield out; return; }
      case 'object': {
        let acc: { [k: string]: Json }[] = [{}];
        for (const { k, v } of a.entries) {
          const next: { [k: string]: Json }[] = [];
          for (const kk of ev(k, input, d + 1)) {
            if (typeof kk !== 'string') fail(`Object keys must be strings, not ${typeName(kk)}`);
            for (const vv of ev(v, input, d + 1)) for (const o of acc) { next.push(kk === '__proto__' ? { ...o } : Object.defineProperty({ ...o }, kk as string, { value: vv, enumerable: true, writable: true, configurable: true })); }
          }
          acc = next;
          size(acc.length);
        }
        yield* acc;
        return;
      }
      case 'call': yield* call(a, input, d + 1); return;
    }
  }
  function* recurse(v: Json, depth: number): Generator<Json> {
    tick();
    if (depth > 128) throw new LimitExceeded('deeper than 128 levels');
    yield v;
    if (Array.isArray(v)) for (const x of v) yield* recurse(x, depth + 1);
    else if (isObj(v)) for (const x of Object.values(v)) yield* recurse(x, depth + 1);
  }
  function arr(v: Json, who: string): Json[] { return Array.isArray(v) ? v : fail(`${typeName(v)} (${show(v)}) cannot be used with ${who}; it needs an array`); }
  function* call(a: { name: string; args: Ast[] }, input: Json, d: number): Generator<Json> {
    const { name, args } = a;
    const one = (i: number) => collectAll(args[i]!, input, d);
    const need = (n: number) => { if (args.length !== n) fail(`${name}/${args.length} is not defined`); };
    switch (name) {
      case 'empty': need(0); return;
      case 'not': need(0); yield !truthy(input); return;
      case 'length': need(0); yield input === null ? 0 : typeof input === 'string' ? [...input].length : Array.isArray(input) ? input.length : isObj(input) ? Object.keys(input).length : typeof input === 'number' ? Math.abs(input) : fail(`${typeName(input)} has no length`); return;
      case 'keys': need(0); yield isObj(input) ? Object.keys(input).sort() : Array.isArray(input) ? input.map((_, i) => i) : fail(`${typeName(input)} has no keys`); return;
      case 'values': need(0); if (input !== null) yield input; return;
      case 'type': need(0); yield typeName(input); return;
      case 'tostring': need(0); yield typeof input === 'string' ? input : JSON.stringify(input); return;
      case 'tonumber': { need(0); const n = typeof input === 'number' ? input : typeof input === 'string' && input.trim() !== '' ? Number(input) : NaN; if (Number.isNaN(n)) fail(`${typeName(input)} (${show(input)}) cannot be parsed as a number`); yield n; return; }
      case 'ascii_downcase': need(0); yield typeof input === 'string' ? input.replace(/[A-Z]/g, (c) => c.toLowerCase()) : fail('ascii_downcase input must be a string'); return;
      case 'ascii_upcase': need(0); yield typeof input === 'string' ? input.replace(/[a-z]/g, (c) => c.toUpperCase()) : fail('ascii_upcase input must be a string'); return;
      case 'add': { need(0); const items = isObj(input) ? Object.values(input) : arr(input, 'add'); yield items.reduce<Json>((x, y) => arith('+', x, y), null); return; }
      case 'sort': need(0); yield [...arr(input, 'sort')].sort(cmpJq); return;
      case 'unique': { need(0); const s = [...arr(input, 'unique')].sort(cmpJq); yield s.filter((x, i) => i === 0 || cmpJq(x, s[i - 1]!) !== 0); return; }
      case 'reverse': need(0); yield typeof input === 'string' ? [...input].reverse().join('') : [...arr(input, 'reverse')].reverse(); return;
      case 'first': if (args.length === 0) { yield arr(input, 'first')[0] ?? null; return; } for (const v of ev(args[0]!, input, d)) { yield v; return; } return;
      case 'last': need(0); { const x = arr(input, 'last'); yield x.length ? x[x.length - 1]! : null; return; }
      case 'min': need(0); { const x = arr(input, 'min'); yield x.length ? x.reduce((m, y) => (cmpJq(y, m) < 0 ? y : m)) : null; return; }
      case 'max': need(0); { const x = arr(input, 'max'); yield x.length ? x.reduce((m, y) => (cmpJq(y, m) >= 0 ? y : m)) : null; return; }
      case 'flatten': { const depth = args.length ? Number(one(0)[0]) : 1e9; const fl = (x: Json[], dd: number): Json[] => x.flatMap((y) => (Array.isArray(y) && dd > 0 ? fl(y, dd - 1) : [y])); yield fl(arr(input, 'flatten'), depth); return; }
      case 'map': need(1); yield arr(input, 'map').flatMap((x) => collectAll(args[0]!, x, d)); return;
      case 'select': need(1); for (const c of ev(args[0]!, input, d)) if (truthy(c)) yield input; return;
      case 'sort_by': { need(1); const xs = arr(input, 'sort_by').map((x) => [collectAll(args[0]!, x, d), x] as const); yield xs.sort((p, q) => cmpJq(p[0], q[0])).map((p) => p[1]); return; }
      case 'group_by': { need(1); const xs = arr(input, 'group_by').map((x) => [collectAll(args[0]!, x, d), x] as const).sort((p, q) => cmpJq(p[0], q[0])); const out: Json[][] = []; xs.forEach((p, i) => { if (i && cmpJq(p[0], xs[i - 1]![0]) === 0) out[out.length - 1]!.push(p[1]); else out.push([p[1]]); }); yield out; return; }
      case 'any': case 'all': { const xs = arr(input, name); const f = (x: Json) => (args.length ? collectAll(args[0]!, x, d) : [x]).some(truthy); yield name === 'any' ? xs.some(f) : xs.every((x) => (args.length ? collectAll(args[0]!, x, d) : [x]).every(truthy)); return; }
      case 'has': { need(1); for (const k of ev(args[0]!, input, d)) yield isObj(input) && typeof k === 'string' ? Object.hasOwn(input, k) : Array.isArray(input) && typeof k === 'number' ? k >= 0 && k < input.length : fail(`Cannot check whether ${typeName(input)} has a ${typeName(k)} key`); return; }
      case 'contains': { need(1); const has = (x: Json, y: Json): boolean => typeof x === 'string' && typeof y === 'string' ? x.includes(y) : Array.isArray(x) && Array.isArray(y) ? y.every((e) => x.some((z) => has(z, e))) : isObj(x) && isObj(y) ? Object.keys(y).every((k) => Object.hasOwn(x, k) && has(x[k]!, y[k]!)) : cmpJq(x, y) === 0; for (const y of ev(args[0]!, input, d)) yield has(input, y); return; }
      case 'join': { need(1); for (const s of ev(args[0]!, input, d)) yield arr(input, 'join').map((x) => (x === null ? '' : typeof x === 'string' ? x : typeof x === 'number' || typeof x === 'boolean' ? String(x) : fail('Cannot join with an object or array'))).join(String(s)); return; }
      case 'split': { need(1); for (const s of ev(args[0]!, input, d)) yield typeof input === 'string' && typeof s === 'string' ? input.split(s) : fail('split input and separator must be strings'); return; }
      case 'test': { need(1); for (const p of ev(args[0]!, input, d)) { if (typeof input !== 'string' || typeof p !== 'string') fail('test needs strings'); const re = iregexp(p as string, false); if (!re) fail(`${show(p)} is not an accepted regular expression`); yield re!.test(input as string); } return; }
      case 'to_entries': need(0); yield isObj(input) ? Object.keys(input).map((k) => ({ key: k, value: input[k]! })) : fail('to_entries needs an object'); return;
      case 'from_entries': { need(0); const o: { [k: string]: Json } = {}; for (const e of arr(input, 'from_entries')) { if (!isObj(e)) fail('from_entries needs objects'); const k = (e as { [k: string]: Json }).key ?? (e as { [k: string]: Json }).name; if (typeof k !== 'string' || k === '__proto__') fail('from_entries needs string keys'); Object.defineProperty(o, k as string, { value: (e as { [k: string]: Json }).value ?? null, enumerable: true, writable: true, configurable: true }); } yield o; return; }
      case 'range': { const [lo, hi] = args.length === 1 ? [0, Number(one(0)[0])] : [Number(one(0)[0]), Number(one(1)[0])]; if (!Number.isFinite(lo) || !Number.isFinite(hi)) fail('range needs numbers'); size(hi - lo); for (let i = lo; i < hi; i++) { tick(); yield i; } return; }
      case 'limit': { need(2); for (const n of ev(args[0]!, input, d)) { let c = 0; if (Number(n) <= 0) continue; for (const v of ev(args[1]!, input, d)) { yield v; if (++c >= Number(n)) break; } } return; }
      default: fail(`${name}/${args.length} is not defined`);
    }
  }
  const out: Json[] = [];
  for (const v of ev(ast, doc as Json, 0)) { out.push(v); if (out.length > maxOut) throw new LimitExceeded(`more than ${maxOut} outputs`); }
  return out;
}
