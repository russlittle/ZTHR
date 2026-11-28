/**
 * Automations as data: triggers say when, conditions say whether, actions say what, and templates fill in values.
 * Shaped after the automations of Home Assistant. Triggers: a state change (optionally held for a time), a number
 * crossing a line, an event, a time of day, a repeating time pattern, a template turning true, and a webhook.
 * Conditions form a tree (and, or, not, state, numeric state, template, time window, which trigger fired). Actions:
 * a service call, delay, wait for a template, stop, set variables, fire an event, if/then/else, choose, repeat
 * (count, while, until, for each), and parallel branches. The run modes are single (a new trigger while running is
 * refused and recorded), restart (the running copy is stopped), queued (waits its turn, up to a limit) and parallel
 * (up to a limit). Every run leaves a trace: the trigger, each step's path, time and result, and how it ended.
 *
 * The engine owns no clock and no timers: it is given events and "now", and delays, state holds and wait timeouts
 * are deadlines it settles when `tick(now)` is called (`nextDue()` says when to call it next). Services, states
 * and ids come from an injected environment, so a run can be replayed exactly.
 *
 * Templates are a small safe expression language written as `{{ expression }}`: dotted paths, indexing, numbers,
 * strings, comparison, and/or/not, arithmetic, `in`, filters (`| round(1)`, `| int`, `| default(x)`, ...), and a short
 * list of functions (`is_state`, `states`, ...). They cannot reach the prototype chain, call anything not listed,
 * or loop, and their size is capped. A template that is only one `{{ }}` keeps its type; otherwise the result is text.
 *
 * Out of scope: calendars and sun events, wait-for-trigger, blueprints, and saving traces anywhere (they are returned).
 */

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
  }
}
export class AutomationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// ================================================================== templates

type Tok = { t: 'num' | 'str' | 'id' | 'op'; v: string };
const MAX_TEMPLATE = 4096;
const MAX_OUTPUT = 65_536;
const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) i++;
    else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(src.slice(i))!;
      out.push({ t: 'num', v: m[0] });
      i += m[0].length;
    } else if (c === '"' || c === "'") {
      let s = '';
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const n = src[i + 1]!;
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          i += 2;
        } else s += src[i++];
      }
      if (src[i] !== c) throw new TemplateError('unterminated string');
      i++;
      out.push({ t: 'str', v: s });
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
    } else {
      const two = src.slice(i, i + 2);
      if (['==', '!=', '<=', '>=', '//'].includes(two)) {
        out.push({ t: 'op', v: two });
        i += 2;
      } else if ('+-*/%<>()[].,|~'.includes(c)) {
        out.push({ t: 'op', v: c });
        i++;
      } else throw new TemplateError(`unexpected "${c}"`);
    }
  }
  return out;
}

type Node =
  | { k: 'lit'; v: unknown }
  | { k: 'list'; items: Node[] }
  | { k: 'var'; name: string }
  | { k: 'get'; of: Node; key: Node }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'filter'; of: Node; name: string; args: Node[] }
  | { k: 'un'; op: string; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node };

class Parser {
  private i = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }
  private peek = () => this.toks[this.i];
  private is(v: string) {
    const p = this.peek();
    return p !== undefined && p.t !== 'str' && p.v === v;
  }
  private eat(v: string) {
    if (!this.is(v)) throw new TemplateError(`expected "${v}"`);
    this.i++;
  }
  parse(): Node {
    const n = this.or();
    if (this.i < this.toks.length) throw new TemplateError(`unexpected "${this.toks[this.i]!.v}"`);
    return n;
  }
  private or(): Node {
    let a = this.and();
    while (this.is('or')) (this.i++, (a = { k: 'bin', op: 'or', a, b: this.and() }));
    return a;
  }
  private and(): Node {
    let a = this.not();
    while (this.is('and')) (this.i++, (a = { k: 'bin', op: 'and', a, b: this.not() }));
    return a;
  }
  private not(): Node {
    if (this.is('not')) {
      this.i++;
      return { k: 'un', op: 'not', a: this.not() };
    }
    return this.cmp();
  }
  private cmp(): Node {
    let a = this.add();
    for (;;) {
      const p = this.peek();
      if (p && p.t === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(p.v)) {
        this.i++;
        a = { k: 'bin', op: p.v, a, b: this.add() };
      } else if (this.is('in')) {
        this.i++;
        a = { k: 'bin', op: 'in', a, b: this.add() };
      } else if (this.is('not') && this.toks[this.i + 1]?.v === 'in') {
        this.i += 2;
        a = { k: 'un', op: 'not', a: { k: 'bin', op: 'in', a, b: this.add() } };
      } else return a;
    }
  }
  private add(): Node {
    let a = this.mul();
    for (;;) {
      const p = this.peek();
      if (p && p.t === 'op' && ['+', '-', '~'].includes(p.v)) {
        this.i++;
        a = { k: 'bin', op: p.v, a, b: this.mul() };
      } else return a;
    }
  }
  private mul(): Node {
    let a = this.unary();
    for (;;) {
      const p = this.peek();
      if (p && p.t === 'op' && ['*', '/', '%', '//'].includes(p.v)) {
        this.i++;
        a = { k: 'bin', op: p.v, a, b: this.unary() };
      } else return a;
    }
  }
  private unary(): Node {
    if (this.is('-')) {
      this.i++;
      return { k: 'un', op: '-', a: this.unary() };
    }
    return this.filters();
  }
  private filters(): Node {
    let a = this.postfix();
    while (this.is('|')) {
      this.i++;
      const name = this.toks[this.i++];
      if (!name || name.t !== 'id') throw new TemplateError('a filter name must follow "|"');
      a = { k: 'filter', of: a, name: name.v, args: this.is('(') ? this.args() : [] };
    }
    return a;
  }
  private args(): Node[] {
    this.eat('(');
    const out: Node[] = [];
    if (!this.is(')')) {
      do out.push(this.or());
      while (this.is(',') && (this.i++, true));
    }
    this.eat(')');
    return out;
  }
  private postfix(): Node {
    let a = this.primary();
    for (;;) {
      if (this.is('.')) {
        this.i++;
        const n = this.toks[this.i++];
        if (!n || (n.t !== 'id' && n.t !== 'num')) throw new TemplateError('a name must follow "."');
        a = { k: 'get', of: a, key: { k: 'lit', v: n.v } };
      } else if (this.is('[')) {
        this.i++;
        const key = this.or();
        this.eat(']');
        a = { k: 'get', of: a, key };
      } else return a;
    }
  }
  private primary(): Node {
    const p = this.toks[this.i++];
    if (!p) throw new TemplateError('the expression ends too soon');
    if (p.t === 'num') return { k: 'lit', v: Number(p.v) };
    if (p.t === 'str') return { k: 'lit', v: p.v };
    if (p.t === 'id') {
      if (p.v === 'true' || p.v === 'True') return { k: 'lit', v: true };
      if (p.v === 'false' || p.v === 'False') return { k: 'lit', v: false };
      if (p.v === 'none' || p.v === 'None') return { k: 'lit', v: null };
      if (this.is('(')) return { k: 'call', name: p.v, args: this.args() };
      return { k: 'var', name: p.v };
    }
    if (p.v === '(') {
      const n = this.or();
      this.eat(')');
      return n;
    }
    if (p.v === '[') {
      const items: Node[] = [];
      if (!this.is(']')) {
        do items.push(this.or());
        while (this.is(',') && (this.i++, true));
      }
      this.eat(']');
      if (items.length > 100) throw new TemplateError('a list may hold at most 100 items');
      return { k: 'list', items };
    }
    throw new TemplateError(`unexpected "${p.v}"`);
  }
}

export interface TemplateEnv {
  /** State text of an entity, or undefined if it does not exist. */
  readonly state?: (entityId: string) => string | undefined;
  /** Current time in milliseconds. */
  readonly now?: () => number;
}

const truthy = (v: unknown) => !(v === undefined || v === null || v === false || v === 0 || v === '' || (Array.isArray(v) && v.length === 0));
const num = (v: unknown, name: string): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (Number.isNaN(n)) throw new TemplateError(`${name}: "${String(v)}" is not a number`);
  return n;
};
const text = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function getKey(of: unknown, key: unknown): unknown {
  if (of === null || of === undefined) return undefined;
  const k = typeof key === 'number' ? String(key) : String(key);
  if (BLOCKED.has(k)) return undefined;
  if (Array.isArray(of)) return k === 'length' ? of.length : /^\d+$/.test(k) ? of[Number(k)] : undefined;
  if (typeof of === 'string') return k === 'length' ? of.length : /^\d+$/.test(k) ? of[Number(k)] : undefined;
  if (typeof of === 'object') return Object.hasOwn(of, k) ? (of as Record<string, unknown>)[k] : undefined;
  return undefined;
}

function applyFilter(name: string, v: unknown, a: unknown[]): unknown {
  switch (name) {
    case 'int': {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isNaN(n) ? (a.length ? a[0] : 0) : Math.trunc(n);
    }
    case 'float': {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isNaN(n) || v === '' || v === null ? (a.length ? a[0] : 0) : n;
    }
    case 'round': {
      const d = a.length ? num(a[0], 'round') : 0;
      const f = 10 ** d;
      return Math.round(num(v, 'round') * f) / f;
    }
    case 'abs':
      return Math.abs(num(v, 'abs'));
    case 'string':
      return text(v);
    case 'upper':
      return text(v).toUpperCase();
    case 'lower':
      return text(v).toLowerCase();
    case 'trim':
      return text(v).trim();
    case 'length':
      return typeof v === 'string' || Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0;
    case 'default':
      return v === undefined || v === null || v === '' ? a[0] : v;
    case 'bool':
      return typeof v === 'string' ? ['1', 'true', 'yes', 'on', 'enable'].includes(v.toLowerCase()) : truthy(v);
    case 'first':
      return Array.isArray(v) ? v[0] : undefined;
    case 'last':
      return Array.isArray(v) ? v[v.length - 1] : undefined;
    case 'join':
      return Array.isArray(v) ? v.map(text).join(a.length ? text(a[0]) : '') : text(v);
    default:
      throw new TemplateError(`there is no filter "${name}"`);
  }
}

function evalNode(n: Node, vars: Readonly<Record<string, unknown>>, env: TemplateEnv): unknown {
  switch (n.k) {
    case 'lit':
      return n.v;
    case 'list':
      return n.items.map((x) => evalNode(x, vars, env));
    case 'var':
      return Object.hasOwn(vars, n.name) && !BLOCKED.has(n.name) ? vars[n.name] : undefined;
    case 'get':
      return getKey(evalNode(n.of, vars, env), evalNode(n.key, vars, env));
    case 'filter':
      return applyFilter(n.name, evalNode(n.of, vars, env), n.args.map((x) => evalNode(x, vars, env)));
    case 'call': {
      const a = n.args.map((x) => evalNode(x, vars, env));
      switch (n.name) {
        case 'is_state': {
          const s = env.state?.(text(a[0]));
          const want = a[1];
          return s !== undefined && (Array.isArray(want) ? want.map(text).includes(s) : s === text(want));
        }
        case 'states':
          return env.state?.(text(a[0])) ?? 'unknown';
        case 'now':
          return env.now?.() ?? 0;
        case 'float':
          return applyFilter('float', a[0], a.slice(1));
        case 'int':
          return applyFilter('int', a[0], a.slice(1));
        case 'abs':
          return Math.abs(num(a[0], 'abs'));
        case 'min':
          return Math.min(...a.map((x) => num(x, 'min')));
        case 'max':
          return Math.max(...a.map((x) => num(x, 'max')));
        case 'length':
          return applyFilter('length', a[0], []);
        default:
          throw new TemplateError(`there is no function "${n.name}"`);
      }
    }
    case 'un': {
      const a = evalNode(n.a, vars, env);
      return n.op === 'not' ? !truthy(a) : -num(a, 'minus');
    }
    case 'bin': {
      if (n.op === 'and') {
        const a = evalNode(n.a, vars, env);
        return truthy(a) ? evalNode(n.b, vars, env) : a;
      }
      if (n.op === 'or') {
        const a = evalNode(n.a, vars, env);
        return truthy(a) ? a : evalNode(n.b, vars, env);
      }
      const a = evalNode(n.a, vars, env);
      const b = evalNode(n.b, vars, env);
      switch (n.op) {
        case '==':
          return a === b;
        case '!=':
          return a !== b;
        case '<':
        case '>':
        case '<=':
        case '>=': {
          if (typeof a === 'string' && typeof b === 'string') return n.op === '<' ? a < b : n.op === '>' ? a > b : n.op === '<=' ? a <= b : a >= b;
          const x = num(a, n.op);
          const y = num(b, n.op);
          return n.op === '<' ? x < y : n.op === '>' ? x > y : n.op === '<=' ? x <= y : x >= y;
        }
        case 'in':
          return Array.isArray(b) ? b.some((x) => x === a) : typeof b === 'string' ? b.includes(text(a)) : b && typeof b === 'object' ? Object.hasOwn(b, text(a)) : false;
        case '~':
          return text(a) + text(b);
        case '+':
          return typeof a === 'string' && typeof b === 'string' ? a + b : num(a, '+') + num(b, '+');
        case '-':
          return num(a, '-') - num(b, '-');
        case '*':
          return num(a, '*') * num(b, '*');
        case '/': {
          const d = num(b, '/');
          if (d === 0) throw new TemplateError('division by zero');
          return num(a, '/') / d;
        }
        case '//': {
          const d = num(b, '//');
          if (d === 0) throw new TemplateError('division by zero');
          return Math.floor(num(a, '//') / d);
        }
        case '%': {
          const d = num(b, '%');
          if (d === 0) throw new TemplateError('division by zero');
          return num(a, '%') % d;
        }
      }
      throw new TemplateError(`unknown operator ${n.op}`);
    }
  }
}

const compiled = new Map<string, Node>();
function compile(src: string): Node {
  let n = compiled.get(src);
  if (!n) {
    if (src.length > MAX_TEMPLATE) throw new TemplateError('the template is too long');
    n = new Parser(tokenize(src)).parse();
    if (compiled.size > 500) compiled.clear();
    compiled.set(src, n);
  }
  return n;
}

/** Evaluates one expression (no braces) to a value. */
export function evaluate(expression: string, vars: Readonly<Record<string, unknown>> = {}, env: TemplateEnv = {}): unknown {
  return evalNode(compile(expression), vars, env);
}

/** Renders a text with `{{ }}` parts. A text that is only one part keeps the type of its value. */
export function render(template: string, vars: Readonly<Record<string, unknown>> = {}, env: TemplateEnv = {}): unknown {
  if (template.length > MAX_TEMPLATE) throw new TemplateError('the template is too long');
  if (!template.includes('{{')) return template;
  const whole = /^\s*\{\{([\s\S]*?)\}\}\s*$/.exec(template);
  if (whole && !whole[1]!.includes('}}')) return evaluate(whole[1]!, vars, env);
  let out = '';
  let at = 0;
  for (const m of template.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    out += template.slice(at, m.index) + text(evaluate(m[1]!, vars, env));
    at = m.index + m[0].length;
    if (out.length > MAX_OUTPUT) throw new TemplateError('the result is too long');
  }
  return out + template.slice(at);
}

/** Renders every string inside plain data, keeping its shape. */
export function renderData(v: unknown, vars: Readonly<Record<string, unknown>>, env: TemplateEnv, depth = 0): unknown {
  if (depth > 20) throw new TemplateError('the data is nested too deeply');
  if (typeof v === 'string') return render(v, vars, env);
  if (Array.isArray(v)) return v.map((x) => renderData(x, vars, env, depth + 1));
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) Object.defineProperty(o, k, { value: renderData(x, vars, env, depth + 1), enumerable: true, writable: true, configurable: true });
    return o;
  }
  return v;
}

// ================================================================== definitions

export type Mode = 'single' | 'restart' | 'queued' | 'parallel';

export type Trigger =
  | { platform: 'state'; id?: string; entity: string; from?: string; to?: string; forSeconds?: number }
  | { platform: 'numeric_state'; id?: string; entity: string; above?: number; below?: number }
  | { platform: 'event'; id?: string; eventType: string; data?: Readonly<Record<string, unknown>> }
  | { platform: 'time'; id?: string; at: string }
  | { platform: 'time_pattern'; id?: string; everySeconds: number }
  | { platform: 'template'; id?: string; valueTemplate: string }
  | { platform: 'webhook'; id?: string; webhookId: string };

export type Condition =
  | { condition: 'and' | 'or' | 'not'; conditions: readonly Condition[] }
  | { condition: 'state'; entity: string; state: string | readonly string[] }
  | { condition: 'numeric_state'; entity: string; above?: number; below?: number }
  | { condition: 'template'; valueTemplate: string }
  | { condition: 'time'; after?: string; before?: string; weekday?: readonly number[] }
  | { condition: 'trigger'; id: string | readonly string[] };

export type Action =
  | { enabled?: boolean; continueOnError?: boolean; alias?: string; service: string; data?: Readonly<Record<string, unknown>>; responseVariable?: string }
  | { enabled?: boolean; continueOnError?: boolean; alias?: string; delay: number | string }
  | { enabled?: boolean; continueOnError?: boolean; alias?: string; waitTemplate: string; timeoutSeconds?: number; continueOnTimeout?: boolean }
  | { enabled?: boolean; continueOnError?: boolean; alias?: string; condition: Condition }
  | { enabled?: boolean; continueOnError?: boolean; alias?: string; variables: Readonly<Record<string, unknown>> }
  | { enabled?: boolean; continueOnError?: boolean; alias?: string; event: string; eventData?: Readonly<Record<string, unknown>> }
  | { enabled?: boolean; continueOnError?: boolean; alias?: string; stop: string; error?: boolean }
  | { enabled?: boolean; continueOnError?: boolean; alias?: string; if: readonly Condition[]; then: readonly Action[]; else?: readonly Action[] }
  | { enabled?: boolean; continueOnError?: boolean; alias?: string; choose: readonly { conditions: readonly Condition[]; sequence: readonly Action[] }[]; default?: readonly Action[] }
  | { enabled?: boolean; continueOnError?: boolean; alias?: string; repeat: { count?: number | string; while?: readonly Condition[]; until?: readonly Condition[]; forEach?: readonly unknown[] | string; sequence: readonly Action[] } }
  | { enabled?: boolean; continueOnError?: boolean; alias?: string; parallel: readonly (readonly Action[])[] };

export interface Automation {
  readonly id: string;
  readonly alias: string;
  readonly mode?: Mode;
  /** Most runs at once for queued and parallel; default 10. */
  readonly max?: number;
  readonly enabled?: boolean;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly triggers: readonly Trigger[];
  readonly conditions?: readonly Condition[];
  readonly actions: readonly Action[];
}

export type RunStatus = 'running' | 'finished' | 'stopped' | 'condition-failed' | 'rejected' | 'aborted' | 'error';

export interface TraceStep {
  readonly path: string;
  readonly type: string;
  readonly at: number;
  readonly result?: unknown;
  readonly error?: string;
}

export interface Trace {
  readonly runId: string;
  readonly automationId: string;
  readonly trigger: Readonly<Record<string, unknown>>;
  readonly startedAt: number;
  finishedAt?: number;
  status: RunStatus;
  reason?: string;
  readonly steps: TraceStep[];
}

export interface Environment {
  now(): number;
  state(entityId: string): string | undefined;
  call(service: string, data: Readonly<Record<string, unknown>>): Promise<unknown>;
  fire?(eventType: string, data: Readonly<Record<string, unknown>>): void;
  newId(): string;
  /** Minutes east of UTC for local-time triggers and conditions; default 0. */
  zoneOffsetMinutes?(at: number): number;
}

export interface Run {
  readonly runId: string;
  /** Settles with the finished trace; a rejected run settles at once. */
  readonly done: Promise<Trace>;
}

const MAX_STEPS = 10_000;
const MAX_REPEAT = 1000;
const TRACES_KEPT = 5;

class Stop extends Error {
  readonly reason: string;
  readonly isError: boolean;
  constructor(reason: string, isError: boolean) {
    super(reason);
    this.reason = reason;
    this.isError = isError;
  }
}
class Aborted extends Error {}

const clockMinutes = (s: string): number => {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new AutomationError(`"${s}" is not a time of day`);
  return Number(m[1]) * 60 + Number(m[2]);
};

function seconds(v: number | string): number {
  if (typeof v === 'number') return v;
  const m = /^(\d+):(\d{2}):(\d{2})$/.exec(v);
  if (!m) throw new AutomationError(`"${v}" is not a duration`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

interface Live {
  readonly auto: Automation;
  readonly trace: Trace;
  aborted: boolean;
  wake: (() => void) | undefined;
}

interface Waiter {
  readonly run: Live;
  readonly check: () => boolean;
  readonly deadline: number | undefined;
  readonly settle: (timedOut: boolean) => void;
}

interface Hold {
  readonly auto: Automation;
  readonly trigger: Trigger;
  readonly index: number;
  readonly due: number;
  readonly vars: Record<string, unknown>;
}

export class Engine {
  private readonly autos = new Map<string, Automation>();
  private readonly traces = new Map<string, Trace[]>();
  private readonly running = new Map<string, Live[]>();
  private readonly queues = new Map<string, { vars: Record<string, unknown>; resolve: (t: Trace) => void; trace: Trace }[]>();
  private readonly waiters = new Set<Waiter>();
  private readonly holds: Hold[] = [];
  private readonly lastState = new Map<string, boolean>();
  private readonly lastTemplate = new Map<string, boolean>();
  private readonly firedDay = new Map<string, number>();
  private readonly lastPattern = new Map<string, number>();
  private readonly lastNumeric = new Map<string, boolean>();

  private readonly env: Environment;

  constructor(env: Environment) {
    this.env = env;
  }

  private tenv(): TemplateEnv {
    return { state: (e) => this.env.state(e), now: () => this.env.now() };
  }

  add(a: Automation): void {
    this.validate(a);
    this.autos.set(a.id, a);
  }

  remove(id: string): void {
    this.autos.delete(id);
    for (const r of this.running.get(id) ?? []) this.abort(r);
    this.queues.delete(id);
    for (let i = this.holds.length - 1; i >= 0; i--) if (this.holds[i]!.auto.id === id) this.holds.splice(i, 1);
  }

  setEnabled(id: string, enabled: boolean): void {
    const a = this.autos.get(id);
    if (!a) throw new AutomationError(`no automation ${id}`);
    this.autos.set(id, { ...a, enabled });
    if (!enabled) for (let i = this.holds.length - 1; i >= 0; i--) if (this.holds[i]!.auto.id === id) this.holds.splice(i, 1);
  }

  /** The kept traces of an automation, newest last. */
  tracesOf(id: string): readonly Trace[] {
    return this.traces.get(id) ?? [];
  }

  runningCount(id: string): number {
    return this.running.get(id)?.length ?? 0;
  }

  /** Checks a definition when it is added, so a mistake shows now and not at three in the morning. */
  validate(a: Automation): void {
    if (!a.id || !a.alias) throw new AutomationError('an automation needs an id and an alias');
    if (!a.triggers.length) throw new AutomationError(`${a.alias}: it needs at least one trigger`);
    const mode = a.mode ?? 'single';
    if (!['single', 'restart', 'queued', 'parallel'].includes(mode)) throw new AutomationError(`${a.alias}: unknown mode ${mode}`);
    if (a.max !== undefined && (!Number.isInteger(a.max) || a.max < 1 || a.max > 1000)) throw new AutomationError(`${a.alias}: max must be between 1 and 1000`);
    for (const t of a.triggers) {
      if (t.platform === 'time') clockMinutes(t.at);
      if (t.platform === 'time_pattern' && (!Number.isInteger(t.everySeconds) || t.everySeconds < 1)) throw new AutomationError(`${a.alias}: a time pattern needs whole seconds of 1 or more`);
      if (t.platform === 'template') compile(t.valueTemplate);
      if (t.platform === 'numeric_state' && t.above === undefined && t.below === undefined) throw new AutomationError(`${a.alias}: a numeric trigger needs above or below`);
    }
    const walk = (actions: readonly Action[], depth: number) => {
      if (depth > 10) throw new AutomationError(`${a.alias}: actions are nested too deeply`);
      for (const x of actions) {
        if ('delay' in x) seconds(x.delay);
        if ('if' in x) (walk(x.then, depth + 1), walk(x.else ?? [], depth + 1));
        if ('choose' in x) (x.choose.forEach((c) => walk(c.sequence, depth + 1)), walk(x.default ?? [], depth + 1));
        if ('repeat' in x) {
          const r = x.repeat;
          if (r.count === undefined && !r.while && !r.until && r.forEach === undefined) throw new AutomationError(`${a.alias}: a repeat needs count, while, until or for each`);
          walk(r.sequence, depth + 1);
        }
        if ('parallel' in x) x.parallel.forEach((s) => walk(s, depth + 1));
        if ('waitTemplate' in x) compile(x.waitTemplate);
      }
    };
    walk(a.actions, 0);
  }

  // ------------------------------------------------------------ inputs

  /** A state changed. Returns the runs it started. */
  handleState(entity: string, from: string | undefined, to: string | undefined, extra: Readonly<Record<string, unknown>> = {}): Run[] {
    const out: Run[] = [];
    for (const a of this.autos.values()) {
      if (a.enabled === false) continue;
      a.triggers.forEach((t, index) => {
        const key = `${a.id}#${index}`;
        if (t.platform === 'state' && t.entity === entity) {
          if (from === to) return;
          if ((t.from !== undefined && t.from !== from) || (t.to !== undefined && t.to !== to)) {
            this.cancelHold(a.id, index);
            return;
          }
          const vars = this.triggerVars(t, index, { entity_id: entity, from_state: from, to_state: to, ...extra });
          if (t.forSeconds && t.forSeconds > 0) {
            this.cancelHold(a.id, index);
            this.holds.push({ auto: a, trigger: t, index, due: this.env.now() + t.forSeconds * 1000, vars });
          } else out.push(this.fire(a, vars));
        }
        if (t.platform === 'numeric_state' && t.entity === entity) {
          const n = to === undefined || to.trim() === '' ? NaN : Number(to);
          const inside = !Number.isNaN(n) && (t.above === undefined || n > t.above) && (t.below === undefined || n < t.below);
          const was = this.lastNumeric.get(key) ?? false;
          this.lastNumeric.set(key, inside);
          if (inside && !was) out.push(this.fire(a, this.triggerVars(t, index, { entity_id: entity, from_state: from, to_state: to, ...extra })));
        }
      });
    }
    // A changed state may settle a template trigger or a wait.
    out.push(...this.checkTemplates());
    this.settleWaiters();
    return out;
  }

  private cancelHold(id: string, index: number) {
    for (let i = this.holds.length - 1; i >= 0; i--) if (this.holds[i]!.auto.id === id && this.holds[i]!.index === index) this.holds.splice(i, 1);
  }

  handleEvent(eventType: string, data: Readonly<Record<string, unknown>> = {}): Run[] {
    const out: Run[] = [];
    for (const a of this.autos.values()) {
      if (a.enabled === false) continue;
      a.triggers.forEach((t, index) => {
        if (t.platform === 'event' && t.eventType === eventType && Object.entries(t.data ?? {}).every(([k, v]) => Object.hasOwn(data, k) && data[k] === v)) {
          out.push(this.fire(a, this.triggerVars(t, index, { event: { event_type: eventType, data } })));
        }
      });
    }
    return out;
  }

  handleWebhook(webhookId: string, payload: unknown = null): Run[] {
    const out: Run[] = [];
    for (const a of this.autos.values()) {
      if (a.enabled === false) continue;
      a.triggers.forEach((t, index) => {
        if (t.platform === 'webhook' && t.webhookId === webhookId) out.push(this.fire(a, this.triggerVars(t, index, { webhook_id: webhookId, json: payload })));
      });
    }
    return out;
  }

  /** Runs an automation by hand, skipping triggers (conditions still apply unless `skipConditions`). */
  trigger(id: string, vars: Record<string, unknown> = {}, skipConditions = false): Run {
    const a = this.autos.get(id);
    if (!a) throw new AutomationError(`no automation ${id}`);
    return this.fire(a, { trigger: { platform: 'manual', id: 'manual', idx: -1, ...vars } }, skipConditions);
  }

  private triggerVars(t: Trigger, index: number, extra: Record<string, unknown>): Record<string, unknown> {
    return { trigger: { platform: t.platform, id: t.id ?? String(index), idx: index, ...extra } };
  }

  /** Settles every deadline now due: state holds, time triggers, delays and wait timeouts. */
  tick(): Run[] {
    const now = this.env.now();
    const out: Run[] = [];
    for (let i = 0; i < this.holds.length; ) {
      const h = this.holds[i]!;
      if (h.due <= now && h.auto.enabled !== false) {
        this.holds.splice(i, 1);
        out.push(this.fire(h.auto, h.vars));
      } else i++;
    }
    const off = (this.env.zoneOffsetMinutes?.(now) ?? 0) * 60_000;
    const local = new Date(now + off);
    const day = Math.floor((now + off) / 86_400_000);
    const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
    for (const a of this.autos.values()) {
      if (a.enabled === false) continue;
      a.triggers.forEach((t, index) => {
        const key = `${a.id}#${index}`;
        if (t.platform === 'time') {
          const at = clockMinutes(t.at);
          if (minutes >= at && this.firedDay.get(key) !== day && minutes - at < 60) {
            this.firedDay.set(key, day);
            out.push(this.fire(a, this.triggerVars(t, index, { now })));
          }
        } else if (t.platform === 'time_pattern') {
          const slot = Math.floor(now / (t.everySeconds * 1000));
          const prev = this.lastPattern.get(key);
          this.lastPattern.set(key, slot);
          if (prev !== undefined && slot > prev) out.push(this.fire(a, this.triggerVars(t, index, { now })));
        }
      });
    }
    out.push(...this.checkTemplates());
    this.settleWaiters();
    return out;
  }

  /** When `tick` is next needed for a hold, a wait timeout or a delay; undefined when nothing is waiting. */
  nextDue(): number | undefined {
    const ds = [...this.holds.map((h) => h.due), ...[...this.waiters].map((w) => w.deadline).filter((d): d is number => d !== undefined)];
    return ds.length ? Math.min(...ds) : undefined;
  }

  private checkTemplates(): Run[] {
    const out: Run[] = [];
    for (const a of this.autos.values()) {
      if (a.enabled === false) continue;
      a.triggers.forEach((t, index) => {
        if (t.platform !== 'template') return;
        const key = `${a.id}#${index}`;
        let now = false;
        try {
          now = truthy(evaluate(t.valueTemplate, {}, this.tenv()));
        } catch {
          now = false;
        }
        const was = this.lastTemplate.get(key);
        this.lastTemplate.set(key, now);
        if (now && was === false) out.push(this.fire(a, this.triggerVars(t, index, {})));
      });
    }
    return out;
  }

  private settleWaiters() {
    const now = this.env.now();
    for (const w of [...this.waiters]) {
      let ok = false;
      try {
        ok = w.check();
      } catch {
        ok = false;
      }
      if (ok) {
        this.waiters.delete(w);
        w.settle(false);
      } else if (w.deadline !== undefined && w.deadline <= now) {
        this.waiters.delete(w);
        w.settle(true);
      }
    }
  }

  // ------------------------------------------------------------ running

  private fire(a: Automation, vars: Record<string, unknown>, skipConditions = false): Run {
    const mode = a.mode ?? 'single';
    const max = a.max ?? 10;
    const runId = this.env.newId();
    const trace: Trace = { runId, automationId: a.id, trigger: (vars.trigger as Record<string, unknown>) ?? {}, startedAt: this.env.now(), status: 'running', steps: [] };
    const active = this.running.get(a.id) ?? [];
    const reject = (reason: string): Run => {
      trace.status = 'rejected';
      trace.reason = reason;
      trace.finishedAt = this.env.now();
      this.keep(a.id, trace);
      return { runId, done: Promise.resolve(trace) };
    };
    if (mode === 'single' && active.length) return reject('already running');
    if (mode === 'parallel' && active.length >= max) return reject(`already ${max} runs at once`);
    if (mode === 'restart') for (const r of active) this.abort(r);
    if (mode === 'queued' && active.length) {
      const q = this.queues.get(a.id) ?? [];
      if (q.length >= max - 1) return reject('the queue is full');
      let resolve!: (t: Trace) => void;
      const done = new Promise<Trace>((r) => (resolve = r));
      q.push({ vars: { ...vars, __skip: skipConditions }, resolve, trace });
      this.queues.set(a.id, q);
      return { runId, done };
    }
    return { runId, done: this.start(a, vars, trace, skipConditions) };
  }

  private keep(id: string, t: Trace) {
    const list = this.traces.get(id) ?? [];
    list.push(t);
    while (list.length > TRACES_KEPT) list.shift();
    this.traces.set(id, list);
  }

  private abort(r: Live) {
    r.aborted = true;
    r.wake?.();
    for (const w of [...this.waiters]) if (w.run === r) {
      this.waiters.delete(w);
      w.settle(true);
    }
  }

  private start(a: Automation, inVars: Record<string, unknown>, trace: Trace, skipConditions: boolean): Promise<Trace> {
    const live: Live = { auto: a, trace, aborted: false, wake: undefined };
    const list = this.running.get(a.id) ?? [];
    list.push(live);
    this.running.set(a.id, list);
    this.keep(a.id, trace);
    const finish = (status: RunStatus, reason?: string) => {
      trace.status = status;
      if (reason !== undefined) trace.reason = reason;
      trace.finishedAt = this.env.now();
      const l = this.running.get(a.id) ?? [];
      l.splice(l.indexOf(live), 1);
      const q = this.queues.get(a.id);
      const next = q?.shift();
      if (next) {
        const skip = next.vars.__skip === true;
        delete next.vars.__skip;
        void this.start(a, next.vars, next.trace, skip).then(next.resolve);
      }
      return trace;
    };
    const vars: Record<string, unknown> = { ...(a.variables ? (renderData(a.variables, inVars, this.tenv()) as Record<string, unknown>) : {}), ...inVars };
    const step = { n: 0 };
    return (async () => {
      try {
        if (!skipConditions && a.conditions) {
          const verdict = this.checkAll(a.conditions, vars, 'condition');
          trace.steps.push({ path: 'condition', type: 'condition', at: this.env.now(), result: verdict.ok, ...(verdict.ok ? {} : { error: verdict.why }) });
          if (!verdict.ok) return finish('condition-failed', verdict.why);
        }
        await this.runSeq(live, a.actions, 'action', vars, step);
        return finish('finished');
      } catch (e) {
        if (e instanceof Aborted || live.aborted) return finish('aborted', 'stopped by a newer run or by removal');
        if (e instanceof Stop) return finish(e.isError ? 'error' : 'stopped', e.reason);
        return finish('error', e instanceof Error ? e.message : String(e));
      }
    })();
  }

  private async runSeq(run: Live, actions: readonly Action[], path: string, vars: Record<string, unknown>, step: { n: number }): Promise<void> {
    for (let i = 0; i < actions.length; i++) {
      if (run.aborted) throw new Aborted();
      if (++step.n > MAX_STEPS) throw new Stop(`more than ${MAX_STEPS} steps in one run`, true);
      const x = actions[i]!;
      const p = `${path}/${i}`;
      if (x.enabled === false) {
        run.trace.steps.push({ path: p, type: 'skipped', at: this.env.now(), result: 'disabled' });
        continue;
      }
      try {
        await this.runOne(run, x, p, vars, step);
      } catch (e) {
        if (e instanceof Aborted || e instanceof Stop) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        run.trace.steps.push({ path: p, type: 'error', at: this.env.now(), error: msg });
        if (!x.continueOnError) throw new Stop(`${p}: ${msg}`, true);
      }
    }
  }

  private checkAll(cs: readonly Condition[], vars: Record<string, unknown>, path: string): { ok: boolean; why: string } {
    for (let i = 0; i < cs.length; i++) {
      const r = this.check(cs[i]!, vars, `${path}/${i}`);
      if (!r.ok) return r;
    }
    return { ok: true, why: '' };
  }

  private check(c: Condition, vars: Record<string, unknown>, path: string): { ok: boolean; why: string } {
    const no = (why: string) => ({ ok: false, why: `${path}: ${why}` });
    const yes = { ok: true, why: '' };
    switch (c.condition) {
      case 'and': {
        for (let i = 0; i < c.conditions.length; i++) {
          const r = this.check(c.conditions[i]!, vars, `${path}/${i}`);
          if (!r.ok) return r;
        }
        return yes;
      }
      case 'or': {
        const why: string[] = [];
        for (let i = 0; i < c.conditions.length; i++) {
          const r = this.check(c.conditions[i]!, vars, `${path}/${i}`);
          if (r.ok) return yes;
          why.push(r.why);
        }
        return no(`none of the alternatives held (${why.join('; ')})`);
      }
      case 'not': {
        for (let i = 0; i < c.conditions.length; i++) if (this.check(c.conditions[i]!, vars, `${path}/${i}`).ok) return no('something that must not hold did hold');
        return yes;
      }
      case 'state': {
        const s = this.env.state(c.entity);
        const want = typeof c.state === 'string' ? [c.state] : c.state;
        return s !== undefined && want.includes(s) ? yes : no(`${c.entity} is ${s ?? 'missing'}, not ${want.join(' or ')}`);
      }
      case 'numeric_state': {
        const s = this.env.state(c.entity);
        const n = s === undefined || s.trim() === '' ? NaN : Number(s);
        if (Number.isNaN(n)) return no(`${c.entity} is not a number`);
        if (c.above !== undefined && !(n > c.above)) return no(`${c.entity} is ${n}, not above ${c.above}`);
        if (c.below !== undefined && !(n < c.below)) return no(`${c.entity} is ${n}, not below ${c.below}`);
        return yes;
      }
      case 'template': {
        const v = evaluate(c.valueTemplate, vars, this.tenv());
        return truthy(v) ? yes : no(`the template was ${text(v) || 'empty'}`);
      }
      case 'time': {
        const now = this.env.now();
        const off = (this.env.zoneOffsetMinutes?.(now) ?? 0) * 60_000;
        const d = new Date(now + off);
        const m = d.getUTCHours() * 60 + d.getUTCMinutes();
        if (c.weekday && !c.weekday.includes(d.getUTCDay())) return no(`today is weekday ${d.getUTCDay()}`);
        const after = c.after === undefined ? undefined : clockMinutes(c.after);
        const before = c.before === undefined ? undefined : clockMinutes(c.before);
        let ok = true;
        if (after !== undefined && before !== undefined) ok = after <= before ? m >= after && m < before : m >= after || m < before;
        else if (after !== undefined) ok = m >= after;
        else if (before !== undefined) ok = m < before;
        return ok ? yes : no('it is outside the time window');
      }
      case 'trigger': {
        const id = (vars.trigger as { id?: string } | undefined)?.id;
        const ids = typeof c.id === 'string' ? [c.id] : c.id;
        return id !== undefined && ids.includes(id) ? yes : no(`the trigger was ${id ?? 'unknown'}`);
      }
    }
  }

  private async runOne(run: Live, x: Action, p: string, vars: Record<string, unknown>, step: { n: number }): Promise<void> {
    const t = this.tenv();
    const log = (type: string, result?: unknown) => run.trace.steps.push({ path: p, type, at: this.env.now(), ...(result !== undefined ? { result } : {}) });
    if ('service' in x) {
      const data = renderData(x.data ?? {}, vars, t) as Record<string, unknown>;
      const service = x.service;
      if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(service)) throw new AutomationError(`"${service}" is not a service name`);
      const res = await this.env.call(service, data);
      if (run.aborted) throw new Aborted();
      if (x.responseVariable) vars[x.responseVariable] = res;
      log('service', { service, data });
    } else if ('delay' in x) {
      const raw = typeof x.delay === 'string' && x.delay.includes('{{') ? render(x.delay, vars, t) : x.delay;
      const secs = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : seconds(raw as string);
      if (!(secs >= 0) || secs > 7 * 86_400) throw new AutomationError('a delay must be between 0 seconds and 7 days');
      log('delay', secs);
      await this.wait(run, () => false, secs * 1000);
      if (run.aborted) throw new Aborted();
    } else if ('waitTemplate' in x) {
      const check = () => truthy(evaluate(x.waitTemplate, vars, t));
      const timedOut = check() ? false : await this.wait(run, check, x.timeoutSeconds === undefined ? undefined : x.timeoutSeconds * 1000);
      if (run.aborted) throw new Aborted();
      vars.wait = { completed: !timedOut };
      log('wait_template', { completed: !timedOut });
      if (timedOut && !x.continueOnTimeout) throw new Stop(`${p}: timed out waiting for ${x.waitTemplate}`, true);
    } else if ('condition' in x) {
      const r = this.check(x.condition, vars, p);
      log('condition', r.ok);
      if (!r.ok) throw new Stop(r.why, false);
    } else if ('variables' in x) {
      Object.assign(vars, renderData(x.variables, vars, t) as Record<string, unknown>);
      log('variables', Object.keys(x.variables));
    } else if ('event' in x) {
      const data = renderData(x.eventData ?? {}, vars, t) as Record<string, unknown>;
      this.env.fire?.(x.event, data);
      log('event', x.event);
    } else if ('stop' in x) {
      log('stop', x.stop);
      throw new Stop(x.stop, x.error === true);
    } else if ('if' in x) {
      const r = this.checkAll(x.if, vars, `${p}/if`);
      log('if', r.ok);
      await this.runSeq(run, r.ok ? x.then : (x.else ?? []), `${p}/${r.ok ? 'then' : 'else'}`, vars, step);
    } else if ('choose' in x) {
      for (let i = 0; i < x.choose.length; i++) {
        const opt = x.choose[i]!;
        if (this.checkAll(opt.conditions, vars, `${p}/choose/${i}`).ok) {
          log('choose', i);
          await this.runSeq(run, opt.sequence, `${p}/choose/${i}/sequence`, vars, step);
          return;
        }
      }
      log('choose', 'default');
      await this.runSeq(run, x.default ?? [], `${p}/default`, vars, step);
    } else if ('repeat' in x) {
      const r = x.repeat;
      const items = r.forEach === undefined ? undefined : typeof r.forEach === 'string' ? render(r.forEach, vars, t) : r.forEach;
      if (items !== undefined && !Array.isArray(items)) throw new AutomationError('for each needs a list');
      const count = r.count === undefined ? undefined : Number(typeof r.count === 'string' ? render(r.count, vars, t) : r.count);
      if (count !== undefined && (!Number.isInteger(count) || count < 0)) throw new AutomationError('a repeat count must be a whole number of 0 or more');
      const limit = items?.length ?? count ?? MAX_REPEAT;
      if (limit > MAX_REPEAT) throw new Stop(`${p}: a repeat may run at most ${MAX_REPEAT} times`, true);
      log('repeat', limit);
      for (let n = 1; ; n++) {
        if (run.aborted) throw new Aborted();
        if (items === undefined && count === undefined && n > MAX_REPEAT) throw new Stop(`${p}: a repeat ran more than ${MAX_REPEAT} times`, true);
        if (items !== undefined && n > items.length) break;
        if (count !== undefined && n > count) break;
        if (r.while && !this.checkAll(r.while, vars, `${p}/while`).ok) break;
        vars.repeat = { index: n, first: n === 1, last: items ? n === items.length : count !== undefined ? n === count : false, ...(items ? { item: items[n - 1] } : {}) };
        await this.runSeq(run, r.sequence, `${p}/repeat/sequence`, vars, step);
        if (r.until && this.checkAll(r.until, vars, `${p}/until`).ok) break;
      }
    } else if ('parallel' in x) {
      log('parallel', x.parallel.length);
      await Promise.all(x.parallel.map((seq, i) => this.runSeq(run, seq, `${p}/parallel/${i}`, { ...vars } as Record<string, unknown>, step)));
    }
  }

  /** Waits until `check` holds (true) or the time passes (false), or the run is stopped. Returns whether it timed out. */
  private wait(run: Live, check: () => boolean, ms: number | undefined): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const deadline = ms === undefined ? undefined : this.env.now() + ms;
      if (deadline !== undefined && ms === 0) return resolve(true);
      const w: Waiter = { run, check, deadline, settle: (timedOut) => resolve(timedOut) };
      this.waiters.add(w);
      run.wake = () => {
        this.waiters.delete(w);
        resolve(true);
      };
    });
  }
}
