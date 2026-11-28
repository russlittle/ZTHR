/**
 * Spreadsheet formulas, parsed and evaluated the way people expect from Excel and Google Sheets. A formula such as
 * =IF(SUM(B2:B9)>100, "big", TEXT(A1,"0.00")) is tokenized and parsed into a tree (Excel's operator precedence,
 * including that -2^2 is 4 and ^ is left-associative; ranges, absolute references, references across sheets,
 * percent, text joining), then evaluated against a workbook of cells. Values are numbers, text, booleans, blanks
 * and error values (#DIV/0!, #VALUE!, #REF!, #NAME?, #NUM!, #N/A, #CIRC!) that travel through formulas the way
 * they do in a spreadsheet and are caught by IFERROR. Text converts to numbers and back by the usual rules, and
 * comparison orders numbers before text before booleans, text without regard to case. The workbook keeps a
 * dependency graph: it knows what each cell reads and what reads it, recalculates only what a change can reach,
 * evaluates precedents first so long chains do not overflow the stack, and marks every cell in a reference cycle
 * (and anything reading one) #CIRC! instead of looping. There are more than 80 functions across maths, logic, text,
 * lookup, conditional aggregates and dates; the clock and the random source are given in, so TODAY() and RAND()
 * are testable. Dates are Excel serial numbers (1900 system, including its famous leap-day quirk).
 *
 * Out of scope: array constants and array formulas (a range is only expanded inside functions that take one,
 * such as SUM and SUMPRODUCT; "=A1:A3+1" is #VALUE!), whole-column references (A:A), defined names, volatile OFFSET
 * and INDIRECT, and locale-specific separators and date formats.
 */

export type ErrorCode = '#DIV/0!' | '#VALUE!' | '#REF!' | '#NAME?' | '#NUM!' | '#N/A' | '#NULL!' | '#CIRC!';
export class FormulaError {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    this.code = code;
  }
  toString(): string {
    return this.code;
  }
}
const E = {
  div0: new FormulaError('#DIV/0!'),
  value: new FormulaError('#VALUE!'),
  ref: new FormulaError('#REF!'),
  name: new FormulaError('#NAME?'),
  num: new FormulaError('#NUM!'),
  na: new FormulaError('#N/A'),
  circ: new FormulaError('#CIRC!'),
};
export type Scalar = number | string | boolean | null | FormulaError;
export type Value = Scalar;
type Grid = Scalar[][];
type Arg = Scalar | Grid;
export const isError = (v: unknown): v is FormulaError => v instanceof FormulaError;

export class FormulaSyntaxError extends Error {
  readonly at: number;
  constructor(why: string, at: number) {
    super(`${why} (at position ${at + 1})`);
    this.name = 'FormulaSyntaxError';
    this.at = at;
  }
}

// ---------------------------------------------------------------------------------------------------------- refs

const MAX_COL = 16384;
const MAX_ROW = 1_048_576;
export const colName = (n: number): string => {
  let s = '';
  for (let c = n; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
  return s;
};
export const colNumber = (s: string): number => [...s.toUpperCase()].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
export interface CellRef {
  readonly col: number;
  readonly row: number;
  readonly absCol: boolean;
  readonly absRow: boolean;
}
const REF = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d{0,6})$/;
export function parseRef(s: string): CellRef | undefined {
  const m = REF.exec(s);
  if (!m) return undefined;
  const col = colNumber(m[2]!);
  const row = Number(m[4]);
  if (col > MAX_COL || row > MAX_ROW) return undefined;
  return { col, row, absCol: m[1] === '$', absRow: m[3] === '$' };
}
export const refName = (c: { col: number; row: number }): string => `${colName(c.col)}${c.row}`;

// ----------------------------------------------------------------------------------------------------- tokenizer

type Tok =
  | { t: 'num'; v: number; at: number }
  | { t: 'str'; v: string; at: number }
  | { t: 'err'; v: FormulaError; at: number }
  | { t: 'ref'; v: string; sheet?: string; at: number }
  | { t: 'name'; v: string; at: number }
  | { t: 'func'; v: string; at: number }
  | { t: 'op'; v: string; at: number };

const ERRORS: Readonly<Record<string, FormulaError>> = { '#DIV/0!': E.div0, '#VALUE!': E.value, '#REF!': E.ref, '#NAME?': E.name, '#NUM!': E.num, '#N/A': E.na, '#NULL!': new FormulaError('#NULL!'), '#CIRC!': E.circ };

function tokenize(src: string, from = 0): Tok[] {
  const out: Tok[] = [];
  let i = from;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    const at = i;
    if (c === '"') {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new FormulaSyntaxError('text is not closed', at);
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            s += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i++];
      }
      out.push({ t: 'str', v: s, at });
      continue;
    }
    if (c === '#') {
      const m = /^#(?:DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|NULL!|CIRC!)/i.exec(src.slice(i));
      if (!m) throw new FormulaSyntaxError('unknown error value', at);
      out.push({ t: 'err', v: ERRORS[m[0].toUpperCase()]!, at });
      i += m[0].length;
      continue;
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (num && !/[A-Za-z_$]/.test(src[i - 1] ?? '')) {
      out.push({ t: 'num', v: Number(num[0]), at });
      i += num[0].length;
      continue;
    }
    // sheet-qualified or plain identifiers / references
    const q = c === "'" ? /^'((?:[^']|'')+)'!/.exec(src.slice(i)) : undefined;
    const idm = /^[A-Za-z_$][A-Za-z0-9_.$]*/.exec(src.slice(i));
    if (q || idm) {
      let sheet: string | undefined;
      if (q) {
        sheet = q[1]!.replace(/''/g, "'");
        i += q[0].length;
      } else if (idm && src[i + idm[0].length] === '!') {
        sheet = idm[0];
        i += idm[0].length + 1;
      }
      const word = /^[A-Za-z_$][A-Za-z0-9_.$]*/.exec(src.slice(i));
      if (!word) throw new FormulaSyntaxError('a sheet name must be followed by a reference', at);
      const w = word[0];
      i += w.length;
      if (sheet !== undefined) {
        if (!REF.test(w)) throw new FormulaSyntaxError(`"${w}" is not a cell reference`, at);
        out.push({ t: 'ref', v: w, sheet, at });
      } else if (src[i] === '(') out.push({ t: 'func', v: w.toUpperCase(), at });
      else if (REF.test(w)) out.push({ t: 'ref', v: w, at });
      else out.push({ t: 'name', v: w, at });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') {
      out.push({ t: 'op', v: two, at });
      i += 2;
      continue;
    }
    if ('+-*/^&=<>(),:%'.includes(c)) {
      out.push({ t: 'op', v: c, at });
      i++;
      continue;
    }
    throw new FormulaSyntaxError(`unexpected "${c}"`, at);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------- parser

export type Ast =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'err'; v: FormulaError }
  | { k: 'blank' }
  | { k: 'ref'; sheet?: string; ref: CellRef }
  | { k: 'range'; sheet?: string; from: CellRef; to: CellRef }
  | { k: 'name'; v: string }
  | { k: 'call'; fn: string; args: Ast[] }
  | { k: 'un'; op: '-' | '+'; a: Ast }
  | { k: 'pct'; a: Ast }
  | { k: 'bin'; op: string; a: Ast; b: Ast };

const MAX_DEPTH = 200;

export function parse(src: string): Ast {
  const text = src;
  if (text.length > 8192) throw new FormulaSyntaxError('formula is too long', 0);
  const toks = tokenize(text, src.startsWith('=') ? 1 : 0);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === 'op' && (peek() as { v: string }).v === v;
  const need = (v: string) => {
    if (!isOp(v)) throw new FormulaSyntaxError(`expected "${v}"`, peek()?.at ?? text.length);
    p++;
  };
  const level = <T>(f: () => T): T => {
    if (++depth > MAX_DEPTH) throw new FormulaSyntaxError('formula is nested too deeply', peek()?.at ?? 0);
    try {
      return f();
    } finally {
      depth--;
    }
  };
  const cmp = (): Ast => {
    let a = concat();
    while (peek()?.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes((peek() as { v: string }).v)) {
      const op = (toks[p++] as { v: string }).v;
      a = { k: 'bin', op, a, b: concat() };
    }
    return a;
  };
  const concat = (): Ast => {
    let a = add();
    while (isOp('&')) {
      p++;
      a = { k: 'bin', op: '&', a, b: add() };
    }
    return a;
  };
  const add = (): Ast => {
    let a = mul();
    while (isOp('+') || isOp('-')) {
      const op = (toks[p++] as { v: string }).v;
      a = { k: 'bin', op, a, b: mul() };
    }
    return a;
  };
  const mul = (): Ast => {
    let a = pow();
    while (isOp('*') || isOp('/')) {
      const op = (toks[p++] as { v: string }).v;
      a = { k: 'bin', op, a, b: pow() };
    }
    return a;
  };
  const pow = (): Ast => {
    let a = unary();
    while (isOp('^')) {
      p++;
      a = { k: 'bin', op: '^', a, b: unary() };
    }
    return a;
  };
  const unary = (): Ast => {
    if (isOp('-') || isOp('+')) {
      const op = (toks[p++] as { v: '-' | '+' }).v;
      return level(() => ({ k: 'un', op, a: unary() }) as Ast);
    }
    let a = primary();
    while (isOp('%')) {
      p++;
      a = { k: 'pct', a };
    }
    return a;
  };
  const refOf = (t: Extract<Tok, { t: 'ref' }>): { ref: CellRef; sheet?: string } => ({ ref: parseRef(t.v)!, ...(t.sheet !== undefined ? { sheet: t.sheet } : {}) });
  const primary = (): Ast => {
    const t = toks[p];
    if (!t) throw new FormulaSyntaxError('the formula ends too soon', text.length);
    p++;
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'err') return { k: 'err', v: t.v };
    if (t.t === 'ref') {
      const a = refOf(t);
      if (isOp(':')) {
        p++;
        const r = toks[p++];
        if (!r || r.t !== 'ref') throw new FormulaSyntaxError('a range needs a cell after ":"', r?.at ?? text.length);
        const b = refOf(r);
        if (b.sheet !== undefined && b.sheet !== a.sheet) throw new FormulaSyntaxError('a range stays on one sheet', r.at);
        return { k: 'range', ...(a.sheet !== undefined ? { sheet: a.sheet } : {}), from: a.ref, to: b.ref };
      }
      return { k: 'ref', ...a };
    }
    if (t.t === 'name') {
      if (/^TRUE$/i.test(t.v)) return { k: 'bool', v: true };
      if (/^FALSE$/i.test(t.v)) return { k: 'bool', v: false };
      return { k: 'name', v: t.v };
    }
    if (t.t === 'func') {
      need('(');
      const args: Ast[] = [];
      if (!isOp(')')) {
        for (;;) {
          // an omitted argument is blank, as in IF(A1,,2)
          args.push(isOp(',') || isOp(')') ? ({ k: 'blank' } as Ast) : level(cmp));
          if (isOp(',')) {
            p++;
            continue;
          }
          break;
        }
      }
      need(')');
      if (t.v === 'TRUE' || t.v === 'FALSE') return { k: 'bool', v: t.v === 'TRUE' };
      return { k: 'call', fn: t.v, args };
    }
    if (t.v === '(') {
      const a = level(cmp);
      need(')');
      return a;
    }
    throw new FormulaSyntaxError(`unexpected "${t.v}"`, t.at);
  };
  const ast = cmp();
  if (p < toks.length) throw new FormulaSyntaxError(`unexpected "${(toks[p] as { v: unknown }).v}"`, toks[p]!.at);
  return ast;
}

// ----------------------------------------------------------------------------------------------------- coercion

const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
export function toNum(v: Scalar): number | FormulaError {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null) return 0;
  if (isError(v)) return v;
  const s = v.trim();
  if (NUMERIC.test(s)) return Number(s);
  const pct = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(s);
  return pct ? Number(pct[1]) / 100 : E.value;
}
export function toStr(v: Scalar): string | FormulaError {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(Number(v.toPrecision(15))) : E.num.code;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v === null) return '';
  return v;
}
function toBool(v: Scalar): boolean | FormulaError {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v === null) return false;
  if (isError(v)) return v;
  if (/^true$/i.test(v.trim())) return true;
  if (/^false$/i.test(v.trim())) return false;
  return E.value;
}
const rank = (v: Scalar) => (typeof v === 'number' ? 1 : typeof v === 'string' ? 2 : 3);
/** Excel's ordering: numbers, then text (case-blind), then booleans; a blank takes the type of what it meets. */
export function compare(a: Scalar, b: Scalar): number {
  if (a === null && b === null) return 0;
  if (a === null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (b === null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  if (isError(a) || isError(b)) return 0;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === 'string') {
    const x = a.toLowerCase();
    const y = (b as string).toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------- dates

const EPOCH = Date.UTC(1899, 11, 30);
/** Excel serial for a date (1900 system: serial 60 is the nonexistent 1900-02-29). */
export function serialOf(y: number, m: number, d: number): number {
  const t = Date.UTC(y, m - 1, d);
  const s = Math.round((t - EPOCH) / 86_400_000);
  return s < 61 ? s - 1 : s;
}
export function dateOf(serial: number): { y: number; m: number; d: number } | undefined {
  const s = Math.floor(serial);
  if (s < 0 || s > 2_958_465) return undefined;
  if (s === 60) return { y: 1900, m: 2, d: 29 };
  const t = new Date(EPOCH + (s < 60 ? s + 1 : s) * 86_400_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

// ------------------------------------------------------------------------------------------------- number format

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function roundHalfAway(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x;
  const sign = x < 0 ? -1 : 1;
  const [mant, exp = '0'] = Math.abs(x).toString().split('e');
  const shifted = Number(`${mant}e${Number(exp) + digits}`);
  const r = Math.round(shifted);
  return sign * Number(`${r}e${-digits}`);
}

/** TEXT(): numeric patterns (0 # , . %) and date patterns (yyyy yy mmmm mmm mm m dddd ddd dd d hh mm ss). */
export function formatText(v: number, fmt: string): string {
  if (/[ymdhs]/i.test(fmt.replace(/"[^"]*"/g, '')) && !/^[#0.,%\s$]+$/.test(fmt)) {
    const frac = v - Math.floor(v);
    const secs = Math.round(frac * 86400);
    const d = dateOf(v);
    if (!d) return E.num.code;
    const wd = (Math.floor(v) + 6) % 7;
    const hasH = /h/i.test(fmt);
    return fmt.replace(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s/gi, (tok, off: number) => {
      const l = tok.toLowerCase();
      const before = fmt.slice(0, off).toLowerCase();
      const minute = (l === 'mm' || l === 'm') && ((hasH && /h[^a-z]*$/.test(before)) || /^[^a-z]*s/.test(fmt.slice(off + tok.length).toLowerCase()));
      if (minute) return String(Math.floor((secs % 3600) / 60)).padStart(l.length, '0');
      switch (l) {
        case 'yyyy': return String(d.y);
        case 'yy': return String(d.y % 100).padStart(2, '0');
        case 'mmmm': return MONTHS[d.m - 1]!;
        case 'mmm': return MONTHS[d.m - 1]!.slice(0, 3);
        case 'mm': return String(d.m).padStart(2, '0');
        case 'm': return String(d.m);
        case 'dddd': return DAYS[wd]!;
        case 'ddd': return DAYS[wd]!.slice(0, 3);
        case 'dd': return String(d.d).padStart(2, '0');
        case 'd': return String(d.d);
        case 'hh': return String(Math.floor(secs / 3600)).padStart(2, '0');
        case 'h': return String(Math.floor(secs / 3600));
        case 'ss': return String(secs % 60).padStart(2, '0');
        default: return String(secs % 60);
      }
    });
  }
  const pct = fmt.includes('%');
  let n = pct ? v * 100 : v;
  const body = fmt.replace(/%/g, '');
  const m = /^([^#0,.]*)([#0,]*)(?:\.([#0]*))?(.*)$/.exec(body);
  if (!m) return String(v);
  const [, pre, intPart = '', decPart = '', post = ''] = m;
  const decimals = decPart.length;
  const neg = n < 0 && roundHalfAway(Math.abs(n), decimals) !== 0;
  n = roundHalfAway(Math.abs(n), decimals);
  let [i = '0', f = ''] = n.toFixed(decimals).split('.');
  const minInt = (intPart.match(/0/g) ?? []).length;
  i = i.replace(/^0+(?=\d)/, '');
  if (i === '0' && minInt === 0) i = '';
  i = i.padStart(minInt, '0');
  if (intPart.includes(',')) i = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const minDec = (decPart.match(/0/g) ?? []).length;
  f = f.replace(/0+$/, '').padEnd(minDec, '0');
  return `${neg ? '-' : ''}${pre}${i}${f ? `.${f}` : ''}${pct ? '%' : ''}${post}`;
}

// --------------------------------------------------------------------------------------------------- functions

export interface Clock {
  now(): Date;
  random(): number;
}
interface Ctx {
  readonly clock: Clock;
  readonly cell?: { sheet: string; col: number; row: number };
}
type Eager = (a: Arg[], c: Ctx) => Arg;
type Lazy = (nodes: Ast[], ev: (n: Ast) => Arg, c: Ctx) => Arg;
interface Def {
  readonly min: number;
  readonly max: number;
  readonly fn: Eager | Lazy;
  readonly lazy?: boolean;
}

const isGrid = (a: Arg): a is Grid => Array.isArray(a);
const flat = (a: Arg): Scalar[] => (isGrid(a) ? a.flat() : [a]);
const first = (a: Arg): Scalar => (isGrid(a) ? (a[0]?.[0] ?? null) : a);
const err = (xs: readonly Arg[]): FormulaError | undefined => {
  for (const x of xs) for (const v of flat(x)) if (isError(v)) return v;
  return undefined;
};
/** Numbers for SUM-like functions: typed-in arguments are coerced, cells in a range count only if they are numbers. */
function numbers(args: readonly Arg[]): number[] | FormulaError {
  const out: number[] = [];
  for (const a of args) {
    if (isGrid(a)) {
      for (const v of a.flat()) {
        if (isError(v)) return v;
        if (typeof v === 'number') out.push(v);
      }
    } else {
      if (isError(a)) return a;
      if (a === null) continue;
      const n = toNum(a);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}
const num1 = (a: Arg): number | FormulaError => toNum(first(a));
const str1 = (a: Arg): string | FormulaError => toStr(first(a));
const fin = (n: number): Scalar => (Number.isFinite(n) ? n : E.num);

/** A COUNTIF-style test: "=5", ">3", "<>x", "a*b" wildcards, or a plain value. */
function criterion(c: Scalar): (v: Scalar) => boolean {
  if (typeof c !== 'string') return (v) => v !== null && !isError(v) && compare(v, c) === 0 && rank(v) === rank(c);
  const m = /^(<=|>=|<>|=|<|>)?(.*)$/s.exec(c)!;
  const op = m[1] ?? '=';
  const rhs = m[2]!;
  const asNum = NUMERIC.test(rhs.trim()) ? Number(rhs) : undefined;
  const rx = /[*?]/.test(rhs) && asNum === undefined ? new RegExp(`^${rhs.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/~\*/g, '\\*').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'is') : undefined;
  return (v) => {
    if (isError(v)) return false;
    if (asNum !== undefined) {
      if (typeof v !== 'number') return op === '<>';
      return op === '=' ? v === asNum : op === '<>' ? v !== asNum : op === '<' ? v < asNum : op === '>' ? v > asNum : op === '<=' ? v <= asNum : v >= asNum;
    }
    if (rx) {
      const hit = typeof v === 'string' && rx.test(v);
      return op === '<>' ? !hit : hit;
    }
    const s = v === null ? '' : typeof v === 'string' ? v : toStr(v);
    const cmpv = compare(s as string, rhs);
    return op === '=' ? cmpv === 0 : op === '<>' ? cmpv !== 0 : op === '<' ? cmpv < 0 : op === '>' ? cmpv > 0 : op === '<=' ? cmpv <= 0 : cmpv >= 0;
  };
}

function matchIn(look: Scalar, arr: Scalar[], type: number): number {
  if (type === 0) {
    const t = criterion(typeof look === 'string' ? `=${look}` : look);
    return arr.findIndex((x) => t(x));
  }
  let best = -1;
  for (let i = 0; i < arr.length; i++) {
    const c = compare(arr[i]!, look);
    if (type === 1 ? c <= 0 : c >= 0) best = i;
    else break;
  }
  return best;
}

const gridOf = (a: Arg): Grid => (isGrid(a) ? a : [[a]]);
const numArg = (a: Arg, d?: number): number | FormulaError => (a === null && d !== undefined ? d : toNum(first(a)));

const D: Record<string, Def> = {};
const def = (name: string, min: number, max: number, fn: Eager) => void (D[name] = { min, max, fn });
const lazy = (name: string, min: number, max: number, fn: Lazy) => void (D[name] = { min, max, fn, lazy: true });
const unary = (name: string, f: (n: number) => number) => def(name, 1, 1, ([a]) => { const n = num1(a!); return isError(n) ? n : fin(f(n)); });
const factorial = (n: number): number => (n < 0 || n > 170 ? Number.NaN : n <= 1 ? 1 : n * factorial(n - 1));

// ---- maths and statistics
def('SUM', 1, 255, (a) => { const n = numbers(a); return isError(n) ? n : n.reduce((x, y) => x + y, 0); });
def('PRODUCT', 1, 255, (a) => { const n = numbers(a); return isError(n) ? n : n.length ? n.reduce((x, y) => x * y, 1) : 0; });
def('AVERAGE', 1, 255, (a) => { const n = numbers(a); return isError(n) ? n : n.length ? n.reduce((x, y) => x + y, 0) / n.length : E.div0; });
def('MIN', 1, 255, (a) => { const n = numbers(a); return isError(n) ? n : n.length ? Math.min(...n) : 0; });
def('MAX', 1, 255, (a) => { const n = numbers(a); return isError(n) ? n : n.length ? Math.max(...n) : 0; });
def('COUNT', 1, 255, (a) => a.reduce<number>((n, x) => n + (isGrid(x) ? x.flat().filter((v) => typeof v === 'number').length : typeof x === 'number' || (typeof x === 'string' && !isError(toNum(x))) || typeof x === 'boolean' ? 1 : 0), 0));
def('COUNTA', 1, 255, (a) => a.reduce<number>((n, x) => n + flat(x).filter((v) => v !== null).length, 0));
def('COUNTBLANK', 1, 1, ([a]) => flat(a!).filter((v) => v === null || v === '').length);
def('MEDIAN', 1, 255, (a) => { const n = numbers(a); if (isError(n)) return n; if (!n.length) return E.num; const s = [...n].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h]! : (s[h - 1]! + s[h]!) / 2; });
const variance = (a: Arg[], sample: boolean): Scalar => { const n = numbers(a); if (isError(n)) return n; const k = sample ? n.length - 1 : n.length; if (k < 1) return E.div0; const m = n.reduce((x, y) => x + y, 0) / n.length; return n.reduce((x, y) => x + (y - m) ** 2, 0) / k; };
def('VAR', 1, 255, (a) => variance(a, true));
def('VAR.S', 1, 255, (a) => variance(a, true));
def('VAR.P', 1, 255, (a) => variance(a, false));
def('STDEV', 1, 255, (a) => { const v = variance(a, true); return typeof v === 'number' ? Math.sqrt(v) : v; });
def('STDEV.S', 1, 255, (a) => { const v = variance(a, true); return typeof v === 'number' ? Math.sqrt(v) : v; });
def('STDEV.P', 1, 255, (a) => { const v = variance(a, false); return typeof v === 'number' ? Math.sqrt(v) : v; });
const kth = (a: Arg[], large: boolean): Scalar => { const n = numbers([a[0]!]); const k = num1(a[1]!); if (isError(n)) return n; if (isError(k)) return k; const s = [...n].sort((x, y) => (large ? y - x : x - y)); return Number.isInteger(k) && k >= 1 && k <= s.length ? s[k - 1]! : E.num; };
def('LARGE', 2, 2, (a) => kth(a, true));
def('SMALL', 2, 2, (a) => kth(a, false));
def('SUMPRODUCT', 1, 30, (a) => {
  const gs = a.map(gridOf);
  const w = gs[0]!.length;
  const h = gs[0]![0]?.length ?? 0;
  if (gs.some((g) => g.length !== w || (g[0]?.length ?? 0) !== h)) return E.value;
  let total = 0;
  for (let r = 0; r < w; r++) for (let c = 0; c < h; c++) {
    let p = 1;
    for (const g of gs) { const v = g[r]![c]!; if (isError(v)) return v; p *= typeof v === 'number' ? v : 0; }
    total += p;
  }
  return total;
});
def('ABS', 1, 1, ([a]) => { const n = num1(a!); return isError(n) ? n : Math.abs(n); });
unary('SQRT', (n) => (n < 0 ? Number.NaN : Math.sqrt(n)));
unary('EXP', Math.exp);
unary('LN', (n) => (n <= 0 ? Number.NaN : Math.log(n)));
unary('LOG10', (n) => (n <= 0 ? Number.NaN : Math.log10(n)));
unary('INT', Math.floor);
unary('SIGN', Math.sign);
unary('FACT', (n) => factorial(Math.floor(n)));
def('LOG', 1, 2, ([a, b]) => { const n = num1(a!); const base = b === undefined ? 10 : num1(b); if (isError(n)) return n; if (isError(base)) return base; return n <= 0 || base <= 0 || base === 1 ? E.num : Math.log(n) / Math.log(base); });
def('PI', 0, 0, () => Math.PI);
const rounder = (name: string, f: (x: number, d: number) => number) => def(name, 2, 2, ([a, d]) => { const n = num1(a!); const k = num1(d!); if (isError(n)) return n; if (isError(k)) return k; return fin(f(n, Math.trunc(k))); });
rounder('ROUND', roundHalfAway);
rounder('ROUNDUP', (x, d) => (x < 0 ? -1 : 1) * Number(`${Math.ceil(Number(`${Math.abs(x)}e${d}`))}e${-d}`));
rounder('ROUNDDOWN', (x, d) => (x < 0 ? -1 : 1) * Number(`${Math.floor(Number(`${Math.abs(x)}e${d}`))}e${-d}`));
def('TRUNC', 1, 2, ([a, d]) => { const n = num1(a!); const k = d === undefined ? 0 : num1(d); if (isError(n)) return n; if (isError(k)) return k; return (n < 0 ? -1 : 1) * Number(`${Math.floor(Number(`${Math.abs(n)}e${Math.trunc(k)}`))}e${-Math.trunc(k)}`); });
def('MOD', 2, 2, ([a, b]) => { const n = num1(a!); const d = num1(b!); if (isError(n)) return n; if (isError(d)) return d; return d === 0 ? E.div0 : n - d * Math.floor(n / d); });
def('POWER', 2, 2, ([a, b]) => { const n = num1(a!); const p = num1(b!); if (isError(n)) return n; if (isError(p)) return p; return n === 0 && p < 0 ? E.div0 : fin(n ** p); });
def('CEILING', 2, 2, ([a, b]) => { const n = num1(a!); const s = num1(b!); if (isError(n)) return n; if (isError(s)) return s; return s === 0 ? 0 : n > 0 && s < 0 ? E.num : Math.ceil(n / s) * s; });
def('FLOOR', 2, 2, ([a, b]) => { const n = num1(a!); const s = num1(b!); if (isError(n)) return n; if (isError(s)) return s; return s === 0 ? E.div0 : n > 0 && s < 0 ? E.num : Math.floor(n / s) * s; });
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
def('GCD', 1, 255, (a) => { const n = numbers(a); return isError(n) ? n : n.some((x) => x < 0) ? E.num : n.map(Math.floor).reduce(gcd, 0); });
def('LCM', 1, 255, (a) => { const n = numbers(a); return isError(n) ? n : n.some((x) => x < 0) ? E.num : n.map(Math.floor).reduce((x, y) => (x === 0 || y === 0 ? 0 : (x / gcd(x, y)) * y), 1); });
def('RAND', 0, 0, (_a, c) => c.clock.random());
def('RANDBETWEEN', 2, 2, ([a, b], c) => { const lo = num1(a!); const hi = num1(b!); if (isError(lo)) return lo; if (isError(hi)) return hi; return lo > hi ? E.num : Math.ceil(lo) + Math.floor(c.clock.random() * (Math.floor(hi) - Math.ceil(lo) + 1)); });

// ---- logic
lazy('IF', 2, 3, (n, ev) => { const c = toBool(first(ev(n[0]!))); if (isError(c)) return c; return c ? ev(n[1]!) : n[2] ? ev(n[2]) : false; });
lazy('IFS', 2, 254, (n, ev) => { if (n.length % 2) return E.na; for (let i = 0; i < n.length; i += 2) { const c = toBool(first(ev(n[i]!))); if (isError(c)) return c; if (c) return ev(n[i + 1]!); } return E.na; });
lazy('IFERROR', 2, 2, (n, ev) => { const v = ev(n[0]!); return isError(first(v)) ? ev(n[1]!) : v; });
lazy('IFNA', 2, 2, (n, ev) => { const v = ev(n[0]!); const f = first(v); return isError(f) && f.code === '#N/A' ? ev(n[1]!) : v; });
lazy('SWITCH', 3, 254, (n, ev) => { const x = first(ev(n[0]!)); if (isError(x)) return x; let i = 1; for (; i + 1 < n.length; i += 2) { const c = first(ev(n[i]!)); if (isError(c)) return c; if (compare(x, c) === 0 && rank(x) === rank(c)) return ev(n[i + 1]!); } return i < n.length ? ev(n[i]!) : E.na; });
lazy('CHOOSE', 2, 255, (n, ev) => { const i = toNum(first(ev(n[0]!))); if (isError(i)) return i; const k = Math.trunc(i); return k >= 1 && k < n.length ? ev(n[k]!) : E.value; });
const boolsOf = (a: Arg[]): boolean[] | FormulaError => { const out: boolean[] = []; for (const x of a) for (const v of flat(x)) { if (isError(v)) return v; if (isGrid(x) && (v === null || typeof v === 'string')) continue; const b = toBool(v); if (isError(b)) return b; out.push(b); } return out.length ? out : E.value; };
def('AND', 1, 255, (a) => { const b = boolsOf(a); return isError(b) ? b : b.every(Boolean); });
def('OR', 1, 255, (a) => { const b = boolsOf(a); return isError(b) ? b : b.some(Boolean); });
def('XOR', 1, 255, (a) => { const b = boolsOf(a); return isError(b) ? b : b.filter(Boolean).length % 2 === 1; });
def('NOT', 1, 1, ([a]) => { const b = toBool(first(a!)); return isError(b) ? b : !b; });
def('TRUE', 0, 0, () => true);
def('FALSE', 0, 0, () => false);
def('NA', 0, 0, () => E.na);
def('ISBLANK', 1, 1, ([a]) => first(a!) === null);
def('ISNUMBER', 1, 1, ([a]) => typeof first(a!) === 'number');
def('ISTEXT', 1, 1, ([a]) => typeof first(a!) === 'string');
def('ISLOGICAL', 1, 1, ([a]) => typeof first(a!) === 'boolean');
def('ISERROR', 1, 1, ([a]) => isError(first(a!)));
def('ISNA', 1, 1, ([a]) => { const v = first(a!); return isError(v) && v.code === '#N/A'; });
def('ISEVEN', 1, 1, ([a]) => { const n = num1(a!); return isError(n) ? n : Math.floor(Math.abs(n)) % 2 === 0; });
def('ISODD', 1, 1, ([a]) => { const n = num1(a!); return isError(n) ? n : Math.floor(Math.abs(n)) % 2 === 1; });

// ---- text
const joined = (a: Arg[]): string | FormulaError => { let s = ''; for (const x of a) for (const v of flat(x)) { const t = toStr(v); if (isError(t)) return t; s += t; } return s; };
def('CONCAT', 1, 255, (a) => joined(a));
def('CONCATENATE', 1, 255, (a) => joined(a.map(first)));
def('LEN', 1, 1, ([a]) => { const s = str1(a!); return isError(s) ? s : [...s].length; });
def('UPPER', 1, 1, ([a]) => { const s = str1(a!); return isError(s) ? s : s.toUpperCase(); });
def('LOWER', 1, 1, ([a]) => { const s = str1(a!); return isError(s) ? s : s.toLowerCase(); });
def('PROPER', 1, 1, ([a]) => { const s = str1(a!); return isError(s) ? s : s.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase()); });
def('TRIM', 1, 1, ([a]) => { const s = str1(a!); return isError(s) ? s : s.trim().replace(/ +/g, ' '); });
def('LEFT', 1, 2, ([a, n]) => { const s = str1(a!); const k = n === undefined ? 1 : num1(n); if (isError(s)) return s; if (isError(k)) return k; return k < 0 ? E.value : [...s].slice(0, Math.floor(k)).join(''); });
def('RIGHT', 1, 2, ([a, n]) => { const s = str1(a!); const k = n === undefined ? 1 : num1(n); if (isError(s)) return s; if (isError(k)) return k; const cs = [...s]; return k < 0 ? E.value : k === 0 ? '' : cs.slice(-Math.floor(k)).join(''); });
def('MID', 3, 3, ([a, st, n]) => { const s = str1(a!); const i = num1(st!); const k = num1(n!); if (isError(s)) return s; if (isError(i)) return i; if (isError(k)) return k; return i < 1 || k < 0 ? E.value : [...s].slice(Math.floor(i) - 1, Math.floor(i) - 1 + Math.floor(k)).join(''); });
def('SUBSTITUTE', 3, 4, ([a, o, n, inst]) => {
  const s = str1(a!); const from = str1(o!); const to = str1(n!);
  if (isError(s)) return s; if (isError(from)) return from; if (isError(to)) return to;
  if (from === '') return s;
  if (inst === undefined) return s.split(from).join(to);
  const k = num1(inst); if (isError(k)) return k; if (k < 1) return E.value;
  let at = -1;
  for (let i = 0; i < k; i++) { at = s.indexOf(from, at + 1); if (at < 0) return s; }
  return s.slice(0, at) + to + s.slice(at + from.length);
});
def('REPLACE', 4, 4, ([a, st, n, t]) => { const s = str1(a!); const i = num1(st!); const k = num1(n!); const r = str1(t!); if (isError(s)) return s; if (isError(i)) return i; if (isError(k)) return k; if (isError(r)) return r; if (i < 1 || k < 0) return E.value; const cs = [...s]; cs.splice(Math.floor(i) - 1, Math.floor(k), r); return cs.join(''); });
const finder = (name: string, ci: boolean) => def(name, 2, 3, ([f, w, st]) => {
  const needle = str1(f!); const hay = str1(w!); const from = st === undefined ? 1 : num1(st);
  if (isError(needle)) return needle; if (isError(hay)) return hay; if (isError(from)) return from;
  if (from < 1 || from > hay.length + 1) return E.value;
  if (ci) {
    const rx = new RegExp(needle.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/~\*/g, '\\*').replace(/\*/g, '.*').replace(/\?/g, '.'), 'is');
    const m = rx.exec(hay.slice(Math.floor(from) - 1));
    return m ? m.index + Math.floor(from) : E.value;
  }
  const i = hay.indexOf(needle, Math.floor(from) - 1);
  return i < 0 ? E.value : i + 1;
});
finder('FIND', false);
finder('SEARCH', true);
def('REPT', 2, 2, ([a, n]) => { const s = str1(a!); const k = num1(n!); if (isError(s)) return s; if (isError(k)) return k; return k < 0 || s.length * k > 32767 ? E.value : s.repeat(Math.floor(k)); });
def('EXACT', 2, 2, ([a, b]) => { const x = str1(a!); const y = str1(b!); return isError(x) ? x : isError(y) ? y : x === y; });
def('VALUE', 1, 1, ([a]) => { const v = first(a!); return typeof v === 'string' && v.trim() === '' ? E.value : toNum(v); });
def('TEXT', 2, 2, ([a, f]) => { const n = num1(a!); const fmt = str1(f!); if (isError(fmt)) return fmt; if (isError(n)) return n; return formatText(n, fmt); });
def('TEXTJOIN', 3, 255, ([d, skip, ...rest]) => { const sep = str1(d!); const sk = toBool(first(skip!)); if (isError(sep)) return sep; if (isError(sk)) return sk; const parts: string[] = []; for (const x of rest) for (const v of flat(x)) { const t = toStr(v); if (isError(t)) return t; if (t === '' && sk) continue; parts.push(t); } return parts.join(sep); });
def('CHAR', 1, 1, ([a]) => { const n = num1(a!); return isError(n) ? n : n < 1 || n > 255 ? E.value : String.fromCharCode(Math.floor(n)); });
def('CODE', 1, 1, ([a]) => { const s = str1(a!); return isError(s) ? s : s === '' ? E.value : s.charCodeAt(0); });

// ---- lookup
def('ROW', 0, 1, ([a], c) => (a === undefined ? c.cell?.row ?? E.value : E.value));
def('COLUMN', 0, 1, ([a], c) => (a === undefined ? c.cell?.col ?? E.value : E.value));
def('ROWS', 1, 1, ([a]) => gridOf(a!).length);
def('COLUMNS', 1, 1, ([a]) => gridOf(a!)[0]?.length ?? 0);
def('INDEX', 2, 3, ([a, r, c]) => {
  const g = gridOf(a!); const i = num1(r!); const j = c === undefined ? (g.length === 1 ? Number.NaN : 1) : num1(c);
  if (isError(i)) return i;
  if (g.length === 1 && c === undefined) return i >= 1 && i <= g[0]!.length ? g[0]![Math.floor(i) - 1]! : E.ref;
  if (isError(j)) return j;
  const row = Math.floor(i) || 1; const col = Math.floor(j) || 1;
  return row >= 1 && row <= g.length && col >= 1 && col <= (g[0]?.length ?? 0) ? g[row - 1]![col - 1]! : E.ref;
});
def('MATCH', 2, 3, ([l, a, t]) => { const look = first(l!); const ty = t === undefined ? 1 : num1(t); if (isError(look)) return look; if (isError(ty)) return ty; const i = matchIn(look, flat(a!), Math.sign(ty)); return i < 0 ? E.na : i + 1; });
const vh = (name: string, vertical: boolean) => def(name, 3, 4, ([l, tbl, idx, approx]) => {
  const look = first(l!); const g = gridOf(tbl!); const k = num1(idx!); const ap = approx === undefined ? true : toBool(first(approx));
  if (isError(look)) return look; if (isError(k)) return k; if (isError(ap)) return ap;
  const keys = vertical ? g.map((r) => r[0]!) : g[0]!;
  const n = vertical ? (g[0]?.length ?? 0) : g.length;
  if (k < 1 || k > n) return E.ref;
  const i = matchIn(look, keys, ap ? 1 : 0);
  if (i < 0) return E.na;
  return vertical ? g[i]![Math.floor(k) - 1]! : g[Math.floor(k) - 1]![i]!;
});
vh('VLOOKUP', true);
vh('HLOOKUP', false);

// ---- conditional aggregates
const pairs = (rest: Arg[]): { range: Scalar[]; test: (v: Scalar) => boolean }[] | FormulaError => {
  const out: { range: Scalar[]; test: (v: Scalar) => boolean }[] = [];
  for (let i = 0; i + 1 < rest.length; i += 2) { const c = first(rest[i + 1]!); if (isError(c)) return c; out.push({ range: flat(rest[i]!), test: criterion(c) }); }
  return out;
};
const selected = (ps: { range: Scalar[]; test: (v: Scalar) => boolean }[]): number[] | FormulaError => {
  const n = ps[0]!.range.length;
  if (ps.some((p) => p.range.length !== n)) return E.value;
  return Array.from({ length: n }, (_, i) => i).filter((i) => ps.every((p) => p.test(p.range[i]!)));
};
const sumOf = (vals: Scalar[], idx: number[]): number | FormulaError => { let s = 0; for (const i of idx) { const v = vals[i]!; if (isError(v)) return v; if (typeof v === 'number') s += v; } return s; };
def('COUNTIF', 2, 2, (a) => { const ps = pairs(a); if (isError(ps)) return ps; return ps[0]!.range.filter((v) => ps[0]!.test(v)).length; });
def('COUNTIFS', 2, 254, (a) => { const ps = pairs(a); if (isError(ps)) return ps; const s = selected(ps); return isError(s) ? s : s.length; });
def('SUMIF', 2, 3, ([r, c, s]) => { const ps = pairs([r!, c!]); if (isError(ps)) return ps; const sumR = s === undefined ? ps[0]!.range : flat(s); const idx = selected(ps); if (isError(idx)) return idx; return sumOf(sumR, idx.filter((i) => i < sumR.length)); });
def('SUMIFS', 3, 255, ([s, ...rest]) => { const ps = pairs(rest); if (isError(ps)) return ps; const sumR = flat(s!); if (ps.some((p) => p.range.length !== sumR.length)) return E.value; const idx = selected(ps); return isError(idx) ? idx : sumOf(sumR, idx); });
def('AVERAGEIF', 2, 3, ([r, c, s]) => { const ps = pairs([r!, c!]); if (isError(ps)) return ps; const avgR = s === undefined ? ps[0]!.range : flat(s); const idx = selected(ps); if (isError(idx)) return idx; const nums = idx.filter((i) => typeof avgR[i] === 'number').map((i) => avgR[i] as number); return nums.length ? nums.reduce((x, y) => x + y, 0) / nums.length : E.div0; });

// ---- dates
def('DATE', 3, 3, ([y, m, d]) => {
  const yy = num1(y!); const mm = num1(m!); const dd = num1(d!);
  if (isError(yy)) return yy; if (isError(mm)) return mm; if (isError(dd)) return dd;
  let Y = Math.trunc(yy); if (Y >= 0 && Y < 1900) Y += 1900;
  const t = new Date(Date.UTC(Y, Math.trunc(mm) - 1, Math.trunc(dd)));
  if (Number.isNaN(t.getTime()) || Y < 1900 || Y > 9999) return E.num;
  return serialOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
});
const part = (name: string, f: (d: { y: number; m: number; d: number }) => number) => def(name, 1, 1, ([a]) => { const n = num1(a!); if (isError(n)) return n; const d = dateOf(n); return d ? f(d) : E.num; });
part('YEAR', (d) => d.y);
part('MONTH', (d) => d.m);
part('DAY', (d) => d.d);
def('WEEKDAY', 1, 2, ([a, t]) => { const n = num1(a!); const ty = t === undefined ? 1 : num1(t); if (isError(n)) return n; if (isError(ty)) return ty; if (!dateOf(n)) return E.num; const sun0 = (Math.floor(n) + 6) % 7; return ty === 1 ? sun0 + 1 : ty === 2 ? ((sun0 + 6) % 7) + 1 : ty === 3 ? (sun0 + 6) % 7 : E.num; });
def('TODAY', 0, 0, (_a, c) => { const n = c.clock.now(); return serialOf(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate()); });
def('NOW', 0, 0, (_a, c) => { const n = c.clock.now(); return serialOf(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate()) + (n.getUTCHours() * 3600 + n.getUTCMinutes() * 60 + n.getUTCSeconds()) / 86400; });
def('DAYS', 2, 2, ([e, s]) => { const a = num1(e!); const b = num1(s!); return isError(a) ? a : isError(b) ? b : Math.floor(a) - Math.floor(b); });
const monthShift = (n: number, months: number, endOfMonth: boolean): Scalar => {
  const d = dateOf(n); if (!d) return E.num;
  const t = new Date(Date.UTC(d.y, d.m - 1 + months, endOfMonth ? 1 : d.d));
  if (endOfMonth) t.setUTCMonth(t.getUTCMonth() + 1, 0);
  else if (t.getUTCDate() !== d.d) t.setUTCDate(0);
  return serialOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};
def('EDATE', 2, 2, ([a, m]) => { const n = num1(a!); const k = num1(m!); return isError(n) ? n : isError(k) ? k : monthShift(n, Math.trunc(k), false); });
def('EOMONTH', 2, 2, ([a, m]) => { const n = num1(a!); const k = num1(m!); return isError(n) ? n : isError(k) ? k : monthShift(n, Math.trunc(k), true); });

export const FUNCTIONS: readonly string[] = Object.keys(D).sort();

// ------------------------------------------------------------------------------------------------- evaluation

interface Source {
  cell(sheet: string, col: number, row: number): Scalar;
  has(sheet: string): boolean;
}

function evalAst(n: Ast, src: Source, sheet: string, c: Ctx): Arg {
  const go = (x: Ast): Arg => evalAst(x, src, sheet, c);
  const sc = (x: Ast): Scalar => first(go(x));
  switch (n.k) {
    case 'num': return n.v;
    case 'str': return n.v;
    case 'bool': return n.v;
    case 'err': return n.v;
    case 'blank': return null;
    case 'name': return E.name;
    case 'ref': {
      const s = n.sheet ?? sheet;
      return src.has(s) ? src.cell(s, n.ref.col, n.ref.row) : E.ref;
    }
    case 'range': {
      const s = n.sheet ?? sheet;
      if (!src.has(s)) return E.ref;
      const [c1, c2] = [Math.min(n.from.col, n.to.col), Math.max(n.from.col, n.to.col)];
      const [r1, r2] = [Math.min(n.from.row, n.to.row), Math.max(n.from.row, n.to.row)];
      if ((c2 - c1 + 1) * (r2 - r1 + 1) > 1_000_000) return E.ref;
      const g: Grid = [];
      for (let r = r1; r <= r2; r++) {
        const row: Scalar[] = [];
        for (let col = c1; col <= c2; col++) row.push(src.cell(s, col, r));
        g.push(row);
      }
      return g;
    }
    case 'un': {
      const v = toNum(sc(n.a));
      return isError(v) ? v : n.op === '-' ? -v : v;
    }
    case 'pct': {
      const v = toNum(sc(n.a));
      return isError(v) ? v : v / 100;
    }
    case 'bin': {
      const a = sc(n.a);
      const b = sc(n.b);
      if (isError(a)) return a;
      if (isError(b)) return b;
      if (n.op === '&') {
        const x = toStr(a);
        const y = toStr(b);
        return isError(x) ? x : isError(y) ? y : x + y;
      }
      if (['=', '<>', '<', '>', '<=', '>='].includes(n.op)) {
        const k = compare(a, b);
        return n.op === '=' ? k === 0 : n.op === '<>' ? k !== 0 : n.op === '<' ? k < 0 : n.op === '>' ? k > 0 : n.op === '<=' ? k <= 0 : k >= 0;
      }
      const x = toNum(a);
      const y = toNum(b);
      if (isError(x)) return x;
      if (isError(y)) return y;
      if (n.op === '+') return fin(x + y);
      if (n.op === '-') return fin(x - y);
      if (n.op === '*') return fin(x * y);
      if (n.op === '/') return y === 0 ? E.div0 : fin(x / y);
      return x === 0 && y < 0 ? E.div0 : fin(x ** y);
    }
    case 'call': {
      const d = Object.hasOwn(D, n.fn) ? D[n.fn]! : undefined;
      if (!d) return E.name;
      if (n.args.length < d.min || n.args.length > d.max) return E.value;
      if (d.lazy) return (d.fn as Lazy)(n.args, go, c);
      const args = n.args.map(go);
      // errors in typed-in arguments stop most functions; the ones that inspect errors take them as values
      if (!['ISERROR', 'ISNA', 'ISBLANK', 'ISNUMBER', 'ISTEXT', 'ISLOGICAL', 'COUNTA', 'COUNTBLANK', 'MATCH'].includes(n.fn)) {
        for (const a of args) if (!isGrid(a) && isError(a)) return a;
      }
      return (d.fn as Eager)(args, c);
    }
  }
}

/** Evaluate one formula against a lookup of cells (default sheet "Sheet1"). */
export function calc(formula: string, cells: Readonly<Record<string, Scalar>> = {}, o: { clock?: Clock } = {}): Value {
  const ast = parse(formula);
  const src: Source = { has: (s) => s === 'Sheet1', cell: (_s, col, row) => cells[refName({ col, row })] ?? null };
  const clock = o.clock ?? { now: () => new Date(), random: Math.random };
  const v = first(evalAst(ast, src, 'Sheet1', { clock }));
  return v === null ? 0 : v;
}

// ------------------------------------------------------------------------------------------------- workbook

export type Input = string | number | boolean | null;
interface Bounds {
  sheet: string;
  c1: number;
  c2: number;
  r1: number;
  r2: number;
}
interface Cell {
  readonly input: Input;
  readonly ast?: Ast;
  readonly syntaxError?: FormulaSyntaxError;
  readonly points: string[];
  readonly ranges: Bounds[];
}
const key = (sheet: string, col: number, row: number) => `${sheet}\u0000${col}\u0000${row}`;
const unkey = (k: string) => { const [sheet, c, r] = k.split('\u0000') as [string, string, string]; return { sheet, col: Number(c), row: Number(r) }; };

function collect(ast: Ast, sheet: string, points: string[], ranges: Bounds[]): void {
  switch (ast.k) {
    case 'ref': points.push(key(ast.sheet ?? sheet, ast.ref.col, ast.ref.row)); break;
    case 'range': ranges.push({ sheet: ast.sheet ?? sheet, c1: Math.min(ast.from.col, ast.to.col), c2: Math.max(ast.from.col, ast.to.col), r1: Math.min(ast.from.row, ast.to.row), r2: Math.max(ast.from.row, ast.to.row) }); break;
    case 'call': ast.args.forEach((a) => collect(a, sheet, points, ranges)); break;
    case 'un': case 'pct': collect(ast.a, sheet, points, ranges); break;
    case 'bin': collect(ast.a, sheet, points, ranges); collect(ast.b, sheet, points, ranges); break;
    default: break;
  }
}

/** Sheets of cells. Setting a cell is cheap; reading one evaluates what it needs, once, until something it reads changes. */
export class Workbook {
  private readonly sheets = new Set<string>();
  private readonly cells = new Map<string, Cell>();
  private readonly cache = new Map<string, Scalar>();
  private readonly clock: Clock;
  private circ: Set<string> | undefined;
  /** For each cell, the formula cells that name it directly; kept up to date as cells are set. */
  private readonly reverse = new Map<string, Set<string>>();
  /** Formula cells that read a range; checked by position when something changes. */
  private readonly rangeCells = new Set<string>();

  constructor(o: { clock?: Clock } = {}) {
    this.clock = o.clock ?? { now: () => new Date(), random: Math.random };
  }

  addSheet(name: string): void {
    if (!name.trim() || name.includes('\u0000')) throw new RangeError('a sheet needs a name');
    this.sheets.add(name);
  }

  /** Put a value or a formula (text starting with "=") in a cell. Blank (null or "") clears it. With `literal`, text is always text, even when it starts with "=" (for what a person typed into a form). */
  set(sheet: string, ref: string, input: Input, o: { literal?: boolean } = {}): void {
    if (!this.sheets.has(sheet)) this.addSheet(sheet);
    const r = parseRef(ref);
    if (!r) throw new RangeError(`not a cell: ${ref}`);
    const k = key(sheet, r.col, r.row);
    this.invalidate(k);
    this.circ = undefined;
    const old = this.cells.get(k);
    if (old) for (const p of old.points) this.reverse.get(p)?.delete(k);
    this.rangeCells.delete(k);
    if (input === null || input === '') {
      this.cells.delete(k);
      return;
    }
    if (typeof input === 'string' && input.startsWith('=') && input.length > 1 && !o.literal) {
      const points: string[] = [];
      const ranges: Bounds[] = [];
      try {
        const ast = parse(input);
        collect(ast, sheet, points, ranges);
        this.cells.set(k, { input, ast, points, ranges });
      } catch (e) {
        if (!(e instanceof FormulaSyntaxError)) throw e;
        this.cells.set(k, { input, syntaxError: e, points, ranges });
      }
      for (const p of points) (this.reverse.get(p) ?? this.reverse.set(p, new Set()).get(p)!).add(k);
      if (ranges.length) this.rangeCells.add(k);
    } else this.cells.set(k, { input, points: [], ranges: [] });
  }

  /** Cell as typed: the formula text or the value. */
  input(sheet: string, ref: string): Input {
    const r = parseRef(ref);
    return r ? (this.cells.get(key(sheet, r.col, r.row))?.input ?? null) : null;
  }

  get(sheet: string, ref: string): Value {
    const r = parseRef(ref);
    if (!r || !this.sheets.has(sheet)) return E.ref;
    return this.value(key(sheet, r.col, r.row));
  }

  /** Values of every cell that holds something, by sheet and reference. */
  values(sheet: string): Record<string, Value> {
    const out: Record<string, Value> = {};
    for (const k of [...this.cells.keys()].filter((x) => x.startsWith(`${sheet}\u0000`)).sort()) {
      const u = unkey(k);
      out[refName(u)] = this.value(k);
    }
    return out;
  }

  /** The cells a formula cell reads (ranges expanded to the cells that exist in them). */
  dependencies(sheet: string, ref: string): string[] {
    const r = parseRef(ref);
    return r ? this.precedents(key(sheet, r.col, r.row)).map((k) => this.label(k, sheet)).sort() : [];
  }
  /** Every cell that would change if this one did, through any chain. */
  dependents(sheet: string, ref: string): string[] {
    const r = parseRef(ref);
    if (!r) return [];
    return [...this.reach(key(sheet, r.col, r.row))].map((k) => this.label(k, sheet)).sort();
  }
  /** The cells that are part of a reference cycle. */
  cycles(): string[] {
    return [...this.cycleSet()].map((k) => this.label(k, '')).sort();
  }

  private label(k: string, home: string): string {
    const u = unkey(k);
    return u.sheet === home ? refName(u) : `${u.sheet}!${refName(u)}`;
  }
  private precedents(k: string): string[] {
    const c = this.cells.get(k);
    if (!c) return [];
    const out = new Set(c.points);
    for (const b of c.ranges) {
      const area = (b.c2 - b.c1 + 1) * (b.r2 - b.r1 + 1);
      if (area <= this.cells.size) {
        for (let col = b.c1; col <= b.c2; col++) for (let row = b.r1; row <= b.r2; row++) { const kk = key(b.sheet, col, row); if (this.cells.has(kk)) out.add(kk); }
      } else {
        for (const kk of this.cells.keys()) { const u = unkey(kk); if (u.sheet === b.sheet && u.col >= b.c1 && u.col <= b.c2 && u.row >= b.r1 && u.row <= b.r2) out.add(kk); }
      }
    }
    return [...out];
  }
  /** Every cell that reads this one, directly, through a range that covers it, or through any chain of such cells. */
  private reach(k: string): Set<string> {
    const seen = new Set<string>();
    const stack = [k];
    const covers = (at: string) => {
      const u = unkey(at);
      for (const rc of this.rangeCells) {
        if (seen.has(rc)) continue;
        if (this.cells.get(rc)!.ranges.some((b) => b.sheet === u.sheet && u.col >= b.c1 && u.col <= b.c2 && u.row >= b.r1 && u.row <= b.r2)) {
          seen.add(rc);
          stack.push(rc);
        }
      }
    };
    covers(k);
    while (stack.length) {
      const v = stack.pop()!;
      for (const d of this.reverse.get(v) ?? []) if (!seen.has(d)) { seen.add(d); stack.push(d); covers(d); }
    }
    return seen;
  }
  private invalidate(k: string): void {
    this.cache.delete(k);
    for (const d of this.reach(k)) this.cache.delete(d);
  }

  /** Tarjan's strongly connected components over formula cells; any component of more than one cell, or a cell reading itself, is a cycle. */
  private cycleSet(): Set<string> {
    if (this.circ) return this.circ;
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const on = new Set<string>();
    const stack: string[] = [];
    const out = new Set<string>();
    let n = 0;
    const adj = new Map<string, string[]>();
    const next = (v: string) => adj.get(v) ?? adj.set(v, this.precedents(v).filter((p) => this.cells.get(p)?.ast)).get(v)!;
    for (const root of this.cells.keys()) {
      if (index.has(root) || !this.cells.get(root)?.ast) continue;
      const work: { v: string; i: number }[] = [{ v: root, i: 0 }];
      index.set(root, n); low.set(root, n); n++; stack.push(root); on.add(root);
      while (work.length) {
        const top = work[work.length - 1]!;
        const ws = next(top.v);
        if (top.i < ws.length) {
          const w = ws[top.i++]!;
          if (!index.has(w)) {
            index.set(w, n); low.set(w, n); n++; stack.push(w); on.add(w);
            work.push({ v: w, i: 0 });
          } else if (on.has(w)) low.set(top.v, Math.min(low.get(top.v)!, index.get(w)!));
        } else {
          work.pop();
          if (work.length) { const parent = work[work.length - 1]!.v; low.set(parent, Math.min(low.get(parent)!, low.get(top.v)!)); }
          if (low.get(top.v) === index.get(top.v)) {
            const comp: string[] = [];
            for (;;) { const w = stack.pop()!; on.delete(w); comp.push(w); if (w === top.v) break; }
            if (comp.length > 1 || next(top.v).includes(top.v)) comp.forEach((c) => out.add(c));
          }
        }
      }
    }
    this.circ = out;
    return out;
  }

  private value(k: string): Scalar {
    const hit = this.cache.get(k);
    if (hit !== undefined) return hit;
    const cell = this.cells.get(k);
    if (!cell) return null;
    if (!cell.ast && !cell.syntaxError) return cell.input as Scalar;
    // evaluate precedents first (iteratively), so a long chain never nests deeply
    const order: string[] = [];
    const seen = new Set<string>([k]);
    const stack: { v: string; deps: string[]; i: number }[] = [{ v: k, deps: this.precedents(k), i: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      if (top.i < top.deps.length) {
        const d = top.deps[top.i++]!;
        if (seen.has(d) || this.cache.has(d) || !this.cells.get(d)?.ast) continue;
        seen.add(d);
        stack.push({ v: d, deps: this.precedents(d), i: 0 });
      } else {
        order.push(top.v);
        stack.pop();
      }
    }
    const circ = this.cycleSet();
    for (const v of order) this.cache.set(v, circ.has(v) ? E.circ : this.compute(v));
    return this.cache.get(k)!;
  }

  private compute(k: string): Scalar {
    const cell = this.cells.get(k)!;
    if (cell.syntaxError) return E.name;
    const u = unkey(k);
    const src: Source = {
      has: (s) => this.sheets.has(s),
      cell: (s, col, row) => {
        const kk = key(s, col, row);
        const c = this.cells.get(kk);
        if (!c) return null;
        if (!c.ast && !c.syntaxError) return c.input as Scalar;
        return this.cache.get(kk) ?? (this.circ?.has(kk) ? E.circ : this.value(kk));
      },
    };
    const v = first(evalAst(cell.ast!, src, u.sheet, { clock: this.clock, cell: u }));
    return v === null ? 0 : v;
  }

  /** Why a formula cell could not be read, if its text did not parse. */
  syntaxError(sheet: string, ref: string): string | undefined {
    const r = parseRef(ref);
    return r ? this.cells.get(key(sheet, r.col, r.row))?.syntaxError?.message : undefined;
  }
}

/** Text typed into a cell box, read as a person means it: numbers, TRUE and FALSE, otherwise text, "=" for a formula. */
export function fromTyped(text: string): Input {
  const t = text.trim();
  if (t === '') return null;
  if (t.startsWith('=')) return t;
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;
  return NUMERIC.test(t) ? Number(t) : text;
}

/** How a value shows in a cell. */
export function display(v: Value): string {
  const s = toStr(v);
  return typeof s === 'string' ? s : s.code;
}
