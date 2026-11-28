/**
 * A sandboxed expression language for `{{ }}` bindings in templates, workflows and forms, so that user-written
 * formulas run safely inside the product. The syntax is the familiar JavaScript expression subset (literals,
 * arithmetic, comparison, && || ??, ?:, member access with ?., calls, array and object literals, arrow functions as
 * arguments) and nothing else: no statements, assignment, `new`, `this`, loops, template literals, regular
 * expressions, imports or eval.
 *
 * It cannot reach the host. Names resolve only from the context the caller passes in and from an allow-list of
 * functions; there is no `globalThis`, `process` or `require`. Property reads see only own properties of plain
 * data (`constructor`, `__proto__` and `prototype` are refused outright, and class instances in the context are
 * refused). Methods come from per-type allow-lists (strings, arrays, numbers, objects), never from the prototype
 * chain, and arrow functions can only be handed to those methods. Functions the caller adds return data only.
 *
 * It cannot run away. Source length, nesting depth, evaluation steps, the size of any string or array built, a total
 * allocation budget and the length of rendered output are all limited, and exceeding one raises ExpressionLimitError.
 * Evaluation is deterministic: the only clock is the one the caller injects for `now()`.
 *
 * Out of scope: asynchronous functions, user-defined function declarations, and Date arithmetic beyond `now()`
 * and `toISOString` (put dates in as ISO text).
 */

export class ExpressionSyntaxError extends Error {
  readonly at: number;
  constructor(why: string, at: number) {
    super(`${why} (at position ${at})`);
    this.at = at;
  }
}
export class ExpressionRuntimeError extends Error {}
export class ExpressionLimitError extends Error {}
export class ExpressionForbidden extends Error {}

export interface Limits {
  readonly maxSourceLength?: number;
  readonly maxDepth?: number;
  readonly maxSteps?: number;
  /** Longest string or array that may exist. */
  readonly maxSize?: number;
  /** Total allocation units (characters and elements built) in one evaluation. */
  readonly maxMemory?: number;
  /** Longest rendered template output. */
  readonly maxOutput?: number;
}

export interface Options {
  readonly limits?: Limits;
  /** Extra functions, called by name. They must return plain data (null, booleans, numbers, strings, arrays, plain objects). */
  readonly functions?: Readonly<Record<string, (...args: unknown[]) => unknown>>;
  /** The only clock; `now()` returns this as an ISO string. */
  readonly now?: () => number;
  /** Throw for names that are not defined instead of giving undefined. */
  readonly strict?: boolean;
}

const DEFAULTS = { maxSourceLength: 4096, maxDepth: 40, maxSteps: 20_000, maxSize: 100_000, maxMemory: 2_000_000, maxOutput: 1_000_000 };

// ---------------------------------------------------------------- lexer

type Tok = { k: 'num' | 'str' | 'id' | 'op' | 'end' | 'eof'; v: string; at: number };

const OPS = ['===', '!==', '**', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '+', '-', '*', '/', '%', '<', '>', '!', '?', ':', '.', ',', '(', ')', '[', ']', '{', '}'];

function lex(src: string, start: number, inTemplate: boolean): Tok[] {
  const out: Tok[] = [];
  let i = start;
  let braces = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (inTemplate && braces === 0 && src.startsWith('}}', i)) { out.push({ k: 'end', v: '}}', at: i }); return out; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let v = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') {
          const e = src[j + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'", '0': '\0' };
          if (e === 'u') { const h = src.slice(j + 2, j + 6); if (!/^[0-9a-fA-F]{4}$/.test(h)) throw new ExpressionSyntaxError('a bad \\u escape', j); v += String.fromCharCode(parseInt(h, 16)); j += 6; continue; }
          if (e === undefined || !(e in map)) throw new ExpressionSyntaxError('a bad escape', j);
          v += map[e]; j += 2; continue;
        }
        v += src[j++];
      }
      if (j >= src.length) throw new ExpressionSyntaxError('an unterminated string', i);
      out.push({ k: 'str', v, at: i });
      i = j + 1;
      continue;
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(src.slice(i));
    if (num && !(c === '.' && !/\d/.test(src[i + 1] ?? ''))) { out.push({ k: 'num', v: num[0], at: i }); i += num[0].length; continue; }
    const id = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
    if (id) { out.push({ k: 'id', v: id[0], at: i }); i += id[0].length; continue; }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExpressionSyntaxError(`cannot read "${c}"`, i);
    if (op === '?.' && /\d/.test(src[i + 2] ?? '')) { out.push({ k: 'op', v: '?', at: i }); i++; continue; }
    if (op === '{') braces++;
    if (op === '}') braces--;
    out.push({ k: 'op', v: op, at: i });
    i += op.length;
  }
  if (inTemplate) throw new ExpressionSyntaxError('a {{ without a closing }}', start);
  out.push({ k: 'eof', v: '', at: src.length });
  return out;
}

// ---------------------------------------------------------------- parser

type Ast =
  | { t: 'lit'; v: unknown } | { t: 'id'; name: string; at: number } | { t: 'arr'; items: Ast[] } | { t: 'obj'; props: { k: Ast; v: Ast }[] }
  | { t: 'member'; obj: Ast; prop: Ast; opt: boolean; at: number } | { t: 'call'; callee: Ast; args: Ast[]; opt: boolean; at: number }
  | { t: 'un'; op: string; e: Ast } | { t: 'bin'; op: string; l: Ast; r: Ast; at: number } | { t: 'logic'; op: string; l: Ast; r: Ast }
  | { t: 'cond'; c: Ast; a: Ast; b: Ast } | { t: 'arrow'; params: string[]; body: Ast };

const FORBIDDEN_NAMES = new Set(['this', 'new', 'delete', 'void', 'function', 'class', 'import', 'await', 'yield', 'var', 'let', 'const', 'return', 'throw', 'in', 'instanceof', 'typeof']);
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);

class Parser {
  p = 0;
  depth = 0;
  readonly toks: Tok[];
  readonly maxDepth: number;
  constructor(toks: Tok[], maxDepth: number) {
    this.toks = toks;
    this.maxDepth = maxDepth;
  }
  get cur() { return this.toks[this.p]!; }
  err(why: string, at = this.cur.at): never { throw new ExpressionSyntaxError(why, at); }
  is(v: string) { return this.cur.k === 'op' && this.cur.v === v; }
  eat(v: string) { if (this.is(v)) { this.p++; return true; } return false; }
  need(v: string) { if (!this.eat(v)) this.err(`expected ${v}`); }
  nest<T>(f: () => T): T { if (++this.depth > this.maxDepth) this.err('the expression is nested too deeply'); const r = f(); this.depth--; return r; }

  expression(): Ast { return this.nest(() => this.ternary()); }
  ternary(): Ast {
    const c = this.binary(0);
    if (this.eat('?')) { const a = this.expression(); this.need(':'); return { t: 'cond', c, a, b: this.expression() }; }
    return c;
  }
  static readonly LEVELS: string[][] = [['??'], ['||'], ['&&'], ['===', '!==', '==', '!='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];
  binary(level: number): Ast {
    if (level >= Parser.LEVELS.length) return this.power();
    let l = this.binary(level + 1);
    for (;;) {
      const t = this.cur;
      if (t.k === 'op' && Parser.LEVELS[level]!.includes(t.v)) {
        this.p++;
        const r = this.binary(level + 1);
        l = ['&&', '||', '??'].includes(t.v) ? { t: 'logic', op: t.v, l, r } : { t: 'bin', op: t.v, l, r, at: t.at };
      } else return l;
    }
  }
  power(): Ast {
    const l = this.unary();
    if (this.is('**')) { const at = this.cur.at; this.p++; return { t: 'bin', op: '**', l, r: this.nest(() => this.power()), at }; }
    return l;
  }
  unary(): Ast {
    if (this.cur.k === 'op' && ['!', '-', '+'].includes(this.cur.v)) { const op = this.cur.v; this.p++; return { t: 'un', op, e: this.nest(() => this.unary()) }; }
    return this.postfix();
  }
  postfix(): Ast {
    let e = this.primary();
    for (;;) {
      const at = this.cur.at;
      if (this.eat('.')) {
        if (this.cur.k !== 'id') this.err('expected a property name');
        e = { t: 'member', obj: e, prop: { t: 'lit', v: this.cur.v }, opt: false, at }; this.p++;
      } else if (this.eat('?.')) {
        if (this.eat('(')) e = { t: 'call', callee: e, args: this.args(), opt: true, at };
        else if (this.eat('[')) { const prop = this.expression(); this.need(']'); e = { t: 'member', obj: e, prop, opt: true, at }; }
        else { if (this.cur.k !== 'id') this.err('expected a property name'); e = { t: 'member', obj: e, prop: { t: 'lit', v: this.cur.v }, opt: true, at }; this.p++; }
      } else if (this.eat('[')) { const prop = this.expression(); this.need(']'); e = { t: 'member', obj: e, prop, opt: false, at }; }
      else if (this.eat('(')) e = { t: 'call', callee: e, args: this.args(), opt: false, at };
      else return e;
    }
  }
  args(): Ast[] {
    const out: Ast[] = [];
    if (this.eat(')')) return out;
    for (;;) { out.push(this.expression()); if (this.eat(',')) { if (out.length > 32) this.err('too many arguments'); continue; } this.need(')'); return out; }
  }
  primary(): Ast {
    const t = this.cur;
    if (t.k === 'num') { this.p++; return { t: 'lit', v: Number(t.v) }; }
    if (t.k === 'str') { this.p++; return { t: 'lit', v: t.v }; }
    if (t.k === 'id') {
      if (FORBIDDEN_NAMES.has(t.v)) this.err(`"${t.v}" is not allowed in an expression`);
      this.p++;
      if (this.is('=>')) { this.p++; return { t: 'arrow', params: [t.v], body: this.expression() }; }
      if (t.v === 'true') return { t: 'lit', v: true };
      if (t.v === 'false') return { t: 'lit', v: false };
      if (t.v === 'null') return { t: 'lit', v: null };
      if (t.v === 'undefined') return { t: 'lit', v: undefined };
      return { t: 'id', name: t.v, at: t.at };
    }
    if (t.k === 'op') {
      if (t.v === '(') {
        const arrow = this.tryArrow();
        if (arrow) return arrow;
        this.p++;
        const e = this.expression();
        this.need(')');
        return e;
      }
      if (t.v === '[') {
        this.p++;
        const items: Ast[] = [];
        if (!this.eat(']')) for (;;) { items.push(this.expression()); if (this.eat(',')) { if (this.is(']')) { this.p++; break; } continue; } this.need(']'); break; }
        return { t: 'arr', items };
      }
      if (t.v === '{') {
        this.p++;
        const props: { k: Ast; v: Ast }[] = [];
        if (!this.eat('}')) for (;;) {
          const kt = this.cur;
          let k: Ast;
          if (kt.k === 'id' || kt.k === 'str') { this.p++; k = { t: 'lit', v: kt.v }; }
          else if (kt.k === 'num') { this.p++; k = { t: 'lit', v: String(Number(kt.v)) }; }
          else if (this.eat('[')) { k = this.expression(); this.need(']'); }
          else return this.err('expected a property name');
          if (this.eat(':')) props.push({ k, v: this.expression() });
          else if (kt.k === 'id') props.push({ k, v: { t: 'id', name: kt.v, at: kt.at } });
          else this.err('expected :');
          if (this.eat(',')) { if (this.is('}')) { this.p++; break; } continue; }
          this.need('}');
          break;
        }
        return { t: 'obj', props };
      }
    }
    return this.err(t.k === 'eof' || t.k === 'end' ? 'the expression ends too soon' : `unexpected "${t.v}"`);
  }
  tryArrow(): Ast | undefined {
    let i = this.p + 1;
    const params: string[] = [];
    if (this.toks[i]?.k === 'op' && this.toks[i]!.v === ')') i++;
    else for (;;) {
      const t = this.toks[i];
      if (t?.k !== 'id') return undefined;
      params.push(t.v);
      i++;
      if (this.toks[i]?.k === 'op' && this.toks[i]!.v === ',') { i++; continue; }
      if (this.toks[i]?.k === 'op' && this.toks[i]!.v === ')') { i++; break; }
      return undefined;
    }
    if (!(this.toks[i]?.k === 'op' && this.toks[i]!.v === '=>')) return undefined;
    this.p = i + 1;
    return { t: 'arrow', params, body: this.expression() };
  }
}

export interface Compiled {
  readonly source: string;
  readonly ast: Ast;
}

/** Parses one expression. Throws ExpressionSyntaxError with the position. */
export function compile(source: string, limits: Limits = {}): Compiled {
  const max = limits.maxSourceLength ?? DEFAULTS.maxSourceLength;
  if (source.length > max) throw new ExpressionSyntaxError(`an expression may be at most ${max} characters`, 0);
  const p = new Parser(lex(source, 0, false), limits.maxDepth ?? DEFAULTS.maxDepth);
  const ast = p.expression();
  if (p.cur.k !== 'eof') p.err(`unexpected "${p.cur.v}"`);
  return { source, ast };
}

/** The names an expression reads from its context (free identifiers), for dependency tracking. */
export function references(c: Compiled | string): string[] {
  const ast = typeof c === 'string' ? compile(c).ast : c.ast;
  const out = new Set<string>();
  const walk = (a: Ast, bound: ReadonlySet<string>) => {
    switch (a.t) {
      case 'id': if (!bound.has(a.name) && !BUILTIN_NAMES.has(a.name)) out.add(a.name); return;
      case 'arr': a.items.forEach((x) => walk(x, bound)); return;
      case 'obj': a.props.forEach((x) => { walk(x.k, bound); walk(x.v, bound); }); return;
      case 'member': walk(a.obj, bound); walk(a.prop, bound); return;
      case 'call': walk(a.callee, bound); a.args.forEach((x) => walk(x, bound)); return;
      case 'un': walk(a.e, bound); return;
      case 'bin': case 'logic': walk(a.l, bound); walk(a.r, bound); return;
      case 'cond': walk(a.c, bound); walk(a.a, bound); walk(a.b, bound); return;
      case 'arrow': walk(a.body, new Set([...bound, ...a.params])); return;
      default: return;
    }
  };
  walk(ast, new Set());
  return [...out].sort();
}

// ---------------------------------------------------------------- runtime

class Fn {
  readonly name: string;
  readonly impl: (args: unknown[], rt: Runtime) => unknown;
  constructor(name: string, impl: (args: unknown[], rt: Runtime) => unknown) {
    this.name = name;
    this.impl = impl;
  }
}
class Closure {
  readonly params: readonly string[];
  readonly body: Ast;
  readonly scope: Scope;
  constructor(params: readonly string[], body: Ast, scope: Scope) {
    this.params = params;
    this.body = body;
    this.scope = scope;
  }
}
class Namespace {
  readonly members: Readonly<Record<string, unknown>>;
  constructor(members: Record<string, unknown>) {
    this.members = members;
  }
}
interface Scope {
  readonly vars: Map<string, unknown>;
  readonly parent: Scope | undefined;
}

const err = (m: string) => new ExpressionRuntimeError(m);
const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

class Runtime {
  steps = 0;
  memory = 0;
  depth = 0;
  readonly lim: Required<Limits>;
  readonly ctx: unknown;
  readonly o: Options;
  constructor(ctx: unknown, o: Options) {
    this.ctx = ctx;
    this.o = o;
    this.lim = { ...DEFAULTS, ...o.limits };
  }
  tick() { if (++this.steps > this.lim.maxSteps) throw new ExpressionLimitError(`more than ${this.lim.maxSteps} steps`); }
  alloc(n: number) {
    if (n > this.lim.maxSize) throw new ExpressionLimitError(`a string or list larger than ${this.lim.maxSize}`);
    this.memory += n;
    if (this.memory > this.lim.maxMemory) throw new ExpressionLimitError(`more than ${this.lim.maxMemory} units of memory`);
  }
  str(s: string): string { this.alloc(s.length); return s; }
  arr<T>(a: T[]): T[] { this.alloc(a.length); return a; }
}

const isPlain = (v: object) => { const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null; };

function checkData(v: unknown): unknown {
  if (v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Fn || v instanceof Closure || v instanceof Namespace) return v;
  if (typeof v === 'function') throw new ExpressionForbidden('functions in the context cannot be used');
  if (typeof v === 'object') {
    if (Array.isArray(v)) return v;
    if (isPlain(v)) return v;
    throw new ExpressionForbidden('only plain data (objects, lists, text, numbers) can be used; convert other values first');
  }
  throw new ExpressionForbidden(`a ${typeof v} cannot be used`);
}

function getProp(rt: Runtime, obj: unknown, key: unknown, opt: boolean): unknown {
  if (obj === null || obj === undefined) { if (opt) return undefined; throw err(`cannot read "${String(key)}" of ${obj === null ? 'null' : 'undefined'}`); }
  if (typeof key !== 'string' && typeof key !== 'number') throw err('a property name must be text or a number');
  const k = String(key);
  if (BAD_KEYS.has(k)) throw new ExpressionForbidden(`access to ${k} is not allowed`);
  void rt;
  if (typeof obj === 'string') return k === 'length' ? [...obj].length : /^\d+$/.test(k) ? obj[Number(k)] : undefined;
  if (Array.isArray(obj)) return k === 'length' ? obj.length : /^\d+$/.test(k) ? obj[Number(k)] : undefined;
  if (obj instanceof Namespace) return Object.hasOwn(obj.members, k) ? obj.members[k] : undefined;
  if (typeof obj === 'object') { checkData(obj); return Object.hasOwn(obj as object, k) ? checkData((obj as Record<string, unknown>)[k]) : undefined; }
  return undefined;
}

const num = (v: unknown, what: string): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null) return 0;
  throw err(`${what} needs a number, not ${typeOf(v)}`);
};

const truthy = (v: unknown) => !(v === undefined || v === null || v === false || v === 0 || v === '' || (typeof v === 'number' && Number.isNaN(v)));

function show(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Fn || v instanceof Closure || v instanceof Namespace) throw err('a function cannot be shown as text');
  try { return JSON.stringify(v) ?? ''; } catch { throw err('that value cannot be shown as text'); }
}

const sortKey = (a: unknown, b: unknown) => { const x = show(a), y = show(b); return x < y ? -1 : x > y ? 1 : 0; };

function callClosure(rt: Runtime, c: unknown, args: unknown[]): unknown {
  if (!(c instanceof Closure)) throw err('a function was expected here');
  if (++rt.depth > rt.lim.maxDepth) throw new ExpressionLimitError('functions nested too deeply');
  const vars = new Map<string, unknown>();
  c.params.forEach((p, i) => vars.set(p, args[i]));
  const r = evalAst(rt, c.body, { vars, parent: c.scope });
  rt.depth--;
  return r;
}

function needArr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw err(`${what} needs a list`);
  return v;
}
const strArg = (v: unknown, what: string): string => { if (typeof v !== 'string') throw err(`${what} needs text`); return v; };
const intArg = (v: unknown, d: number, what: string): number => (v === undefined ? d : Math.trunc(num(v, what)));

type Method = (self: never, a: unknown[], rt: Runtime) => unknown;
const STRING_METHODS: Record<string, Method> = {
  toUpperCase: ((s: string, _a, rt) => rt.str(s.toUpperCase())) as Method,
  toLowerCase: ((s: string, _a, rt) => rt.str(s.toLowerCase())) as Method,
  trim: ((s: string) => s.trim()) as Method,
  trimStart: ((s: string) => s.trimStart()) as Method,
  trimEnd: ((s: string) => s.trimEnd()) as Method,
  split: ((s: string, a: unknown[], rt) => { const p = a[0] === undefined ? undefined : strArg(a[0], 'split'); return rt.arr(p === undefined ? [s] : s.split(p, a[1] === undefined ? undefined : intArg(a[1], 0, 'split'))); }) as Method,
  includes: ((s: string, a) => s.includes(strArg(a[0], 'includes'))) as Method,
  startsWith: ((s: string, a) => s.startsWith(strArg(a[0], 'startsWith'))) as Method,
  endsWith: ((s: string, a) => s.endsWith(strArg(a[0], 'endsWith'))) as Method,
  indexOf: ((s: string, a) => s.indexOf(strArg(a[0], 'indexOf'))) as Method,
  lastIndexOf: ((s: string, a) => s.lastIndexOf(strArg(a[0], 'lastIndexOf'))) as Method,
  slice: ((s: string, a, rt) => rt.str(s.slice(intArg(a[0], 0, 'slice'), a[1] === undefined ? undefined : intArg(a[1], 0, 'slice')))) as Method,
  substring: ((s: string, a, rt) => rt.str(s.substring(intArg(a[0], 0, 'substring'), a[1] === undefined ? undefined : intArg(a[1], 0, 'substring')))) as Method,
  charAt: ((s: string, a) => s.charAt(intArg(a[0], 0, 'charAt'))) as Method,
  at: ((s: string, a) => s.at(intArg(a[0], 0, 'at'))) as Method,
  concat: ((s: string, a, rt) => rt.str(s + a.map(show).join(''))) as Method,
  replace: ((s: string, a, rt) => rt.str(s.replace(strArg(a[0], 'replace'), () => strArg(a[1], 'replace')))) as Method,
  replaceAll: ((s: string, a, rt) => rt.str(s.split(strArg(a[0], 'replaceAll')).join(strArg(a[1], 'replaceAll')))) as Method,
  padStart: ((s: string, a, rt) => { rt.alloc(intArg(a[0], 0, 'padStart')); return s.padStart(intArg(a[0], 0, 'padStart'), a[1] === undefined ? ' ' : strArg(a[1], 'padStart')); }) as Method,
  padEnd: ((s: string, a, rt) => { rt.alloc(intArg(a[0], 0, 'padEnd')); return s.padEnd(intArg(a[0], 0, 'padEnd'), a[1] === undefined ? ' ' : strArg(a[1], 'padEnd')); }) as Method,
  repeat: ((s: string, a, rt) => { const n = intArg(a[0], 0, 'repeat'); if (n < 0) throw err('repeat needs zero or more'); rt.alloc(s.length * n); return s.repeat(n); }) as Method,
  toString: ((s: string) => s) as Method,
};
const NUMBER_METHODS: Record<string, Method> = {
  toFixed: ((n: number, a) => { const d = intArg(a[0], 0, 'toFixed'); if (d < 0 || d > 20) throw err('toFixed takes 0 to 20 digits'); return n.toFixed(d); }) as Method,
  toString: ((n: number, a) => { const r = intArg(a[0], 10, 'toString'); if (r < 2 || r > 36) throw err('radix must be 2 to 36'); return n.toString(r); }) as Method,
};
const ARRAY_METHODS: Record<string, Method> = {
  includes: ((a: unknown[], x) => a.includes(x[0])) as Method,
  indexOf: ((a: unknown[], x) => a.indexOf(x[0])) as Method,
  join: ((a: unknown[], x, rt) => rt.str(a.map(show).join(x[0] === undefined ? ',' : strArg(x[0], 'join')))) as Method,
  slice: ((a: unknown[], x, rt) => rt.arr(a.slice(intArg(x[0], 0, 'slice'), x[1] === undefined ? undefined : intArg(x[1], 0, 'slice')))) as Method,
  concat: ((a: unknown[], x, rt) => rt.arr([...a, ...x.flatMap((y) => (Array.isArray(y) ? y : [y]))])) as Method,
  at: ((a: unknown[], x) => a.at(intArg(x[0], 0, 'at'))) as Method,
  reverse: ((a: unknown[], _x, rt) => rt.arr([...a].reverse())) as Method,
  first: ((a: unknown[]) => a[0]) as Method,
  last: ((a: unknown[]) => a[a.length - 1]) as Method,
  unique: ((a: unknown[], _x, rt) => rt.arr([...new Set(a)])) as Method,
  flat: ((a: unknown[], x, rt) => rt.arr(a.flat(Math.min(10, intArg(x[0], 1, 'flat'))))) as Method,
  sort: ((a: unknown[], x, rt) => {
    const cmp = x[0];
    const copy = rt.arr([...a]);
    return cmp === undefined ? copy.sort((p, q) => (typeof p === 'number' && typeof q === 'number' ? p - q : sortKey(p, q))) : copy.sort((p, q) => { rt.tick(); return num(callClosure(rt, cmp, [p, q]), 'a sort comparison'); });
  }) as Method,
  map: ((a: unknown[], x, rt) => rt.arr(a.map((v, i) => { rt.tick(); return callClosure(rt, x[0], [v, i]); }))) as Method,
  filter: ((a: unknown[], x, rt) => rt.arr(a.filter((v, i) => { rt.tick(); return truthy(callClosure(rt, x[0], [v, i])); }))) as Method,
  flatMap: ((a: unknown[], x, rt) => rt.arr(a.flatMap((v, i) => { rt.tick(); const r = callClosure(rt, x[0], [v, i]); return Array.isArray(r) ? r : [r]; }))) as Method,
  find: ((a: unknown[], x, rt) => a.find((v, i) => { rt.tick(); return truthy(callClosure(rt, x[0], [v, i])); })) as Method,
  findIndex: ((a: unknown[], x, rt) => a.findIndex((v, i) => { rt.tick(); return truthy(callClosure(rt, x[0], [v, i])); })) as Method,
  some: ((a: unknown[], x, rt) => a.some((v, i) => { rt.tick(); return truthy(callClosure(rt, x[0], [v, i])); })) as Method,
  every: ((a: unknown[], x, rt) => a.every((v, i) => { rt.tick(); return truthy(callClosure(rt, x[0], [v, i])); })) as Method,
  reduce: ((a: unknown[], x, rt) => { let acc = x[1]; let from = 0; if (x.length < 2) { if (!a.length) throw err('reduce of an empty list needs a starting value'); acc = a[0]; from = 1; } for (let i = from; i < a.length; i++) { rt.tick(); acc = callClosure(rt, x[0], [acc, a[i], i]); } return acc; }) as Method,
  toString: ((a: unknown[]) => show(a)) as Method,
};
const BOOL_METHODS: Record<string, Method> = { toString: ((b: boolean) => String(b)) as Method };

const mathFn = (name: string, f: (...n: number[]) => number) => new Fn(name, (a) => f(...a.map((x) => num(x, name))));
const MATH = new Namespace({
  PI: Math.PI, E: Math.E,
  abs: mathFn('abs', Math.abs), round: mathFn('round', Math.round), floor: mathFn('floor', Math.floor), ceil: mathFn('ceil', Math.ceil), trunc: mathFn('trunc', Math.trunc),
  sqrt: mathFn('sqrt', Math.sqrt), min: mathFn('min', Math.min), max: mathFn('max', Math.max), sign: mathFn('sign', Math.sign),
  pow: new Fn('pow', (a) => { const e = num(a[1], 'pow'); if (Math.abs(e) > 1000) throw new ExpressionLimitError('an exponent over 1000'); return num(a[0], 'pow') ** e; }),
});

const BUILTINS: Record<string, unknown> = {
  Math: MATH, NaN: NaN, Infinity: Infinity,
  min: MATH.members.min, max: MATH.members.max, abs: MATH.members.abs, round: MATH.members.round, floor: MATH.members.floor, ceil: MATH.members.ceil, sqrt: MATH.members.sqrt, pow: MATH.members.pow,
  sum: new Fn('sum', (a) => needArr(a[0], 'sum').reduce<number>((s, x) => s + num(x, 'sum'), 0)),
  avg: new Fn('avg', (a) => { const l = needArr(a[0], 'avg'); return l.length ? l.reduce<number>((s, x) => s + num(x, 'avg'), 0) / l.length : undefined; }),
  len: new Fn('len', (a) => (typeof a[0] === 'string' ? [...a[0]].length : Array.isArray(a[0]) ? a[0].length : a[0] && typeof a[0] === 'object' ? Object.keys(a[0]).length : 0)),
  keys: new Fn('keys', (a, rt) => (a[0] && typeof a[0] === 'object' && !Array.isArray(a[0]) ? rt.arr(Object.keys(checkData(a[0]) as object)) : [])),
  values: new Fn('values', (a, rt) => (a[0] && typeof a[0] === 'object' && !Array.isArray(a[0]) ? rt.arr(Object.values(checkData(a[0]) as object)) : [])),
  entries: new Fn('entries', (a, rt) => (a[0] && typeof a[0] === 'object' && !Array.isArray(a[0]) ? rt.arr(Object.entries(checkData(a[0]) as object)) : [])),
  range: new Fn('range', (a, rt) => { const lo = a.length > 1 ? num(a[0], 'range') : 0; const hi = num(a.length > 1 ? a[1] : a[0], 'range'); const st = a[2] === undefined ? 1 : num(a[2], 'range'); if (st === 0) throw err('range needs a step other than 0'); rt.alloc(Math.max(0, Math.ceil((hi - lo) / st))); const out: number[] = []; for (let i = lo; st > 0 ? i < hi : i > hi; i += st) out.push(i); return out; }),
  String: new Fn('String', (a, rt) => rt.str(show(a[0]))),
  Number: new Fn('Number', (a) => (typeof a[0] === 'string' && a[0].trim() === '' ? 0 : typeof a[0] === 'number' ? a[0] : typeof a[0] === 'string' || typeof a[0] === 'boolean' || a[0] === null ? Number(a[0]) : NaN)),
  Boolean: new Fn('Boolean', (a) => truthy(a[0])),
  parseInt: new Fn('parseInt', (a) => parseInt(show(a[0]), a[1] === undefined ? 10 : num(a[1], 'parseInt'))),
  parseFloat: new Fn('parseFloat', (a) => parseFloat(show(a[0]))),
  isNaN: new Fn('isNaN', (a) => Number.isNaN(typeof a[0] === 'number' ? a[0] : Number(a[0]))),
  json: new Fn('json', (a, rt) => rt.str(show(a[0]))),
  isEmpty: new Fn('isEmpty', (a) => a[0] === undefined || a[0] === null || a[0] === '' || (Array.isArray(a[0]) && a[0].length === 0) || (typeof a[0] === 'object' && !Array.isArray(a[0]) && Object.keys(a[0] as object).length === 0)),
};
const BUILTIN_NAMES = new Set([...Object.keys(BUILTINS), 'now', 'undefined']);

function lookup(rt: Runtime, name: string, scope: Scope | undefined, at: number): unknown {
  for (let s = scope; s; s = s.parent) if (s.vars.has(name)) return s.vars.get(name);
  if (BAD_KEYS.has(name)) throw new ExpressionForbidden(`access to ${name} is not allowed`);
  if (rt.ctx !== null && typeof rt.ctx === 'object' && Object.hasOwn(rt.ctx, name)) return checkData((rt.ctx as Record<string, unknown>)[name]);
  if (Object.hasOwn(BUILTINS, name)) return BUILTINS[name];
  if (name === 'now') return new Fn('now', () => new Date((rt.o.now ?? Date.now)()).toISOString());
  if (rt.o.functions && Object.hasOwn(rt.o.functions, name)) {
    const f = rt.o.functions[name]!;
    return new Fn(name, (a) => sanitize(f(...a), rt, 0));
  }
  if (rt.o.strict) throw err(`${name} is not defined (at position ${at})`);
  return undefined;
}

/** Results of caller-supplied functions must be plain data; anything else is refused. */
function sanitize(v: unknown, rt: Runtime, depth: number): unknown {
  if (depth > 20) throw new ExpressionLimitError('a function returned data nested too deeply');
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) { rt.alloc(v.length); return v.map((x) => sanitize(x, rt, depth + 1)); }
  if (typeof v === 'object' && isPlain(v)) { const o: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v)) { if (BAD_KEYS.has(k)) continue; rt.alloc(1); Object.defineProperty(o, k, { value: sanitize(x, rt, depth + 1), enumerable: true, writable: true, configurable: true }); } return o; }
  throw new ExpressionForbidden('a function returned something that is not plain data');
}

function callFn(rt: Runtime, f: unknown, args: unknown[], at: number): unknown {
  if (f instanceof Fn) return f.impl(args, rt);
  if (f instanceof Closure) return callClosure(rt, f, args);
  throw err(`that is not a function (at position ${at})`);
}

function evalAst(rt: Runtime, a: Ast, scope: Scope | undefined): unknown {
  rt.tick();
  if (rt.depth > rt.lim.maxDepth) throw new ExpressionLimitError('evaluation nested too deeply');
  switch (a.t) {
    case 'lit': return typeof a.v === 'string' ? rt.str(a.v) : a.v;
    case 'id': return lookup(rt, a.name, scope, a.at);
    case 'arr': return rt.arr(a.items.map((x) => evalAst(rt, x, scope)));
    case 'obj': {
      const o: Record<string, unknown> = {};
      for (const p of a.props) {
        const k = evalAst(rt, p.k, scope);
        if (typeof k !== 'string' && typeof k !== 'number') throw err('an object key must be text or a number');
        if (BAD_KEYS.has(String(k))) throw new ExpressionForbidden(`${String(k)} cannot be a key`);
        rt.alloc(1);
        Object.defineProperty(o, String(k), { value: evalAst(rt, p.v, scope), enumerable: true, writable: true, configurable: true });
      }
      return o;
    }
    case 'arrow': return new Closure(a.params, a.body, scope ?? { vars: new Map(), parent: undefined });
    case 'member': {
      const obj = evalAst(rt, a.obj, scope);
      if (a.opt && (obj === null || obj === undefined)) return undefined;
      return getProp(rt, obj, evalAst(rt, a.prop, scope), a.opt);
    }
    case 'call': {
      if (a.callee.t === 'member') {
        const m = a.callee;
        const obj = evalAst(rt, m.obj, scope);
        if (m.opt && (obj === null || obj === undefined)) return undefined;
        const name = evalAst(rt, m.prop, scope);
        if (typeof name !== 'string' || BAD_KEYS.has(name)) throw new ExpressionForbidden(`calling ${String(name)} is not allowed`);
        const args = a.args.map((x) => evalAst(rt, x, scope));
        if (obj instanceof Namespace) return callFn(rt, Object.hasOwn(obj.members, name) ? obj.members[name] : undefined, args, m.at);
        const table = typeof obj === 'string' ? STRING_METHODS : typeof obj === 'number' ? NUMBER_METHODS : typeof obj === 'boolean' ? BOOL_METHODS : Array.isArray(obj) ? ARRAY_METHODS : undefined;
        if (obj === null || obj === undefined) throw err(`cannot call ${name} on ${obj === null ? 'null' : 'undefined'}`);
        if (!table || !Object.hasOwn(table, name)) throw err(`${typeOf(obj)} has no method ${name}`);
        return (table[name] as unknown as (s: unknown, a: unknown[], rt: Runtime) => unknown)(obj, args, rt);
      }
      const f = evalAst(rt, a.callee, scope);
      if (a.opt && (f === null || f === undefined)) return undefined;
      return callFn(rt, f, a.args.map((x) => evalAst(rt, x, scope)), a.at);
    }
    case 'un': {
      const v = evalAst(rt, a.e, scope);
      if (a.op === '!') return !truthy(v);
      return a.op === '-' ? -num(v, 'negation') : num(v, 'unary plus');
    }
    case 'logic': {
      const l = evalAst(rt, a.l, scope);
      if (a.op === '&&') return truthy(l) ? evalAst(rt, a.r, scope) : l;
      if (a.op === '||') return truthy(l) ? l : evalAst(rt, a.r, scope);
      return l === null || l === undefined ? evalAst(rt, a.r, scope) : l;
    }
    case 'cond': return truthy(evalAst(rt, a.c, scope)) ? evalAst(rt, a.a, scope) : evalAst(rt, a.b, scope);
    case 'bin': {
      const l = evalAst(rt, a.l, scope), r = evalAst(rt, a.r, scope);
      switch (a.op) {
        case '+':
          if (typeof l === 'number' && typeof r === 'number') return l + r;
          if (typeof l === 'string' || typeof r === 'string') return rt.str(show(l) + show(r));
          if (Array.isArray(l) && Array.isArray(r)) return rt.arr([...l, ...r]);
          return num(l, 'adding') + num(r, 'adding');
        case '-': return num(l, 'subtraction') - num(r, 'subtraction');
        case '*': return num(l, 'multiplication') * num(r, 'multiplication');
        case '/': return num(l, 'division') / num(r, 'division');
        case '%': return num(l, 'modulo') % num(r, 'modulo');
        case '**': { const e = num(r, 'power'); if (Math.abs(e) > 1000) throw new ExpressionLimitError('an exponent over 1000'); return num(l, 'power') ** e; }
        case '===': return l === r;
        case '!==': return l !== r;
        case '==': return typeof l === 'object' && l !== null || typeof r === 'object' && r !== null ? l === r : l == r; // eslint-disable-line eqeqeq
        case '!=': return typeof l === 'object' && l !== null || typeof r === 'object' && r !== null ? l !== r : l != r; // eslint-disable-line eqeqeq
        default: {
          const both = (typeof l === 'string' && typeof r === 'string') ? [l, r] : [num(l, 'comparison'), num(r, 'comparison')];
          const [x, y] = both as [number, number];
          return a.op === '<' ? x < y : a.op === '>' ? x > y : a.op === '<=' ? x <= y : x >= y;
        }
      }
    }
  }
}

/** Evaluates one expression against a context and returns its value (undefined, null, text, number, boolean, list or object). */
export function evaluate(expression: string | Compiled, ctx: unknown, o: Options = {}): unknown {
  const c = typeof expression === 'string' ? compile(expression, o.limits) : expression;
  const rt = new Runtime(ctx, o);
  const v = evalAst(rt, c.ast, undefined);
  if (v instanceof Fn || v instanceof Closure || v instanceof Namespace) throw err('the result is a function, not a value');
  return v;
}

// ---------------------------------------------------------------- templates

export type Segment = { readonly text: string } | { readonly expr: Compiled; readonly at: number };
export interface Template {
  readonly source: string;
  readonly segments: readonly Segment[];
}

const MAX_EXPRESSIONS = 200;

/** Splits a template into text and `{{ }}` expressions. `\{{` is a literal `{{`. */
export function compileTemplate(source: string, limits: Limits = {}): Template {
  const max = (limits.maxSourceLength ?? DEFAULTS.maxSourceLength) * 16;
  if (source.length > max) throw new ExpressionSyntaxError(`a template may be at most ${max} characters`, 0);
  const segments: Segment[] = [];
  let text = '';
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('\\{{', i)) { text += '{{'; i += 3; continue; }
    if (source.startsWith('{{', i)) {
      const toks = lex(source, i + 2, true);
      const end = toks[toks.length - 1]!;
      const body = toks.slice(0, -1);
      if (body.length === 0) throw new ExpressionSyntaxError('an empty {{ }}', i);
      const p = new Parser([...body, { k: 'eof', v: '', at: end.at }], limits.maxDepth ?? DEFAULTS.maxDepth);
      const ast = p.expression();
      if (p.cur.k !== 'eof') p.err(`unexpected "${p.cur.v}"`);
      if (text) segments.push({ text });
      text = '';
      if (segments.filter((s) => 'expr' in s).length >= MAX_EXPRESSIONS) throw new ExpressionSyntaxError(`more than ${MAX_EXPRESSIONS} expressions in one template`, i);
      segments.push({ expr: { source: source.slice(i + 2, end.at).trim(), ast }, at: i });
      i = end.at + 2;
      continue;
    }
    text += source[i++];
  }
  if (text) segments.push({ text });
  return { source, segments };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface RenderOptions extends Options {
  /** Escape every expression's output (not the template's own text). */
  readonly escape?: 'html' | 'none';
}

/** Renders a template to text. Expression results are shown as text (null and undefined as nothing). */
export function render(template: string | Template, ctx: unknown, o: RenderOptions = {}): string {
  const t = typeof template === 'string' ? compileTemplate(template, o.limits) : template;
  const max = o.limits?.maxOutput ?? DEFAULTS.maxOutput;
  let out = '';
  const rt = new Runtime(ctx, o);
  for (const s of t.segments) {
    if ('text' in s) out += s.text;
    else {
      const v = evalAst(rt, s.expr.ast, undefined);
      const txt = show(v);
      out += o.escape === 'html' ? escapeHtml(txt) : txt;
    }
    if (out.length > max) throw new ExpressionLimitError(`the output is longer than ${max}`);
  }
  return out;
}

/**
 * Resolves a binding. When the whole text is a single `{{ expression }}` the value keeps its type (a number stays
 * a number, a list a list); anything else is rendered to text.
 */
export function resolve(template: string, ctx: unknown, o: Options = {}): unknown {
  const t = compileTemplate(template, o.limits);
  if (t.segments.length === 1 && 'expr' in t.segments[0]!) return evaluate(t.segments[0].expr, ctx, o);
  return render(t, ctx, o);
}

/** Resolves every string inside a JSON structure (keys are left alone), to a bounded depth. */
export function resolveDeep(value: unknown, ctx: unknown, o: Options = {}, depth = 0): unknown {
  if (depth > 32) throw new ExpressionLimitError('data nested too deeply');
  if (typeof value === 'string') return value.includes('{{') ? resolve(value, ctx, o) : value;
  if (Array.isArray(value)) return value.map((x) => resolveDeep(x, ctx, o, depth + 1));
  if (value !== null && typeof value === 'object' && isPlain(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!BAD_KEYS.has(k)) Object.defineProperty(out, k, { value: resolveDeep(v, ctx, o, depth + 1), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return value;
}
