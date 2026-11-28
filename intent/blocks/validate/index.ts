/**
 * Validation: one schema for every input, and one error format for every failure. A schema is built from small
 * checks (text, number, whole number, boolean, one of, date, email, list, record) and returns either the cleaned
 * value or every problem at once, each with the path to the field and a message a person can act on. Forms show
 * the same problems beside the same fields, so the server and the screen never disagree.
 */

export interface Problem {
  /** Where the problem is: "email", "items[2].qty". */
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: readonly Problem[] };

export interface Schema<T> {
  readonly check: (v: unknown, path: string) => Result<T>;
  readonly optional: () => Schema<T | undefined>;
  readonly label?: string;
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const bad = (path: string, code: string, message: string): Result<never> => ({ ok: false, problems: [{ path: path || '(input)', code, message }] });

function schema<T>(check: (v: unknown, path: string) => Result<T>): Schema<T> {
  const s: Schema<T> = {
    check,
    optional: () => schema<T | undefined>((v, p) => (v === undefined || v === null || v === '' ? ok(undefined) : check(v, p))),
  };
  return s;
}

const name = (path: string) => path.split(/[.[]/).pop()!.replace(/]$/, '') || 'this';

export const text = (o: { min?: number; max?: number; pattern?: RegExp; patternMessage?: string; trim?: boolean } = {}) =>
  schema<string>((v, p) => {
    if (typeof v !== 'string') return v === undefined || v === null ? bad(p, 'required', `${name(p)} is needed`) : bad(p, 'type', `${name(p)} must be text`);
    const s = o.trim === false ? v : v.trim().normalize('NFC');
    if (!s.length && (o.min ?? 1) > 0) return bad(p, 'required', `${name(p)} is needed`);
    const len = [...s].length;
    if (o.min !== undefined && len < o.min) return bad(p, 'short', `${name(p)} needs at least ${o.min} characters`);
    if (o.max !== undefined && len > o.max) return bad(p, 'long', `${name(p)} can have at most ${o.max} characters`);
    if (o.pattern && ((o.pattern.lastIndex = 0), !o.pattern.test(s))) return bad(p, 'pattern', o.patternMessage ?? `${name(p)} is not in the expected form`);
    return ok(s);
  });

export const number = (o: { min?: number; max?: number; integer?: boolean } = {}) =>
  schema<number>((v, p) => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) return v === undefined || v === null || v === '' ? bad(p, 'required', `${name(p)} is needed`) : bad(p, 'type', `${name(p)} must be a number`);
    if (o.integer && !Number.isInteger(n)) return bad(p, 'integer', `${name(p)} must be a whole number`);
    if (o.min !== undefined && n < o.min) return bad(p, 'min', `${name(p)} must be at least ${o.min}`);
    if (o.max !== undefined && n > o.max) return bad(p, 'max', `${name(p)} must be at most ${o.max}`);
    return ok(n);
  });

export const integer = (o: { min?: number; max?: number } = {}) => number({ ...o, integer: true });

export const boolean = () =>
  schema<boolean>((v, p) => {
    if (typeof v === 'boolean') return ok(v);
    if (v === 'true' || v === 'on' || v === '1') return ok(true);
    if (v === 'false' || v === 'off' || v === '0') return ok(false);
    return bad(p, 'type', `${name(p)} must be yes or no`);
  });

export const oneOf = <const T extends readonly string[]>(values: T) =>
  schema<T[number]>((v, p) => (typeof v === 'string' && values.includes(v) ? ok(v as T[number]) : v === undefined || v === null || v === '' ? bad(p, 'required', `${name(p)} is needed`) : bad(p, 'choice', `${name(p)} must be one of: ${values.join(', ')}`)));

/** An email address as people type it: one @, a dot in the domain, no spaces. Delivery is the only real proof. */
export const email = () => text({ max: 254, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, patternMessage: 'that does not look like an email address' });

/** A calendar date as YYYY-MM-DD, checked to exist (no 31 February). */
export const date = () =>
  schema<string>((v, p) => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return v === undefined || v === null || v === '' ? bad(p, 'required', `${name(p)} is needed`) : bad(p, 'date', `${name(p)} must be a date like 2026-11-26`);
    const d = new Date(`${v}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return bad(p, 'date', `${v} is not a real date`);
    return ok(v);
  });

export const list = <T>(item: Schema<T>, o: { min?: number; max?: number } = {}) =>
  schema<T[]>((v, p) => {
    if (!Array.isArray(v)) return bad(p, 'type', `${name(p)} must be a list`);
    if (o.min !== undefined && v.length < o.min) return bad(p, 'min', `${name(p)} needs at least ${o.min}`);
    if (o.max !== undefined && v.length > o.max) return bad(p, 'max', `${name(p)} can have at most ${o.max}`);
    const out: T[] = [];
    const problems: Problem[] = [];
    v.forEach((x, i) => {
      const r = item.check(x, `${p}[${i}]`);
      if (r.ok) out.push(r.value);
      else problems.push(...r.problems);
    });
    return problems.length ? { ok: false, problems } : ok(out);
  });

type Shape = Record<string, Schema<unknown>>;
type Out<S extends Shape> = { [K in keyof S]: S[K] extends Schema<infer T> ? T : never };

/** A record of named fields; fields it does not name are refused, so nothing unexpected slips through. */
export const record = <S extends Shape>(shape: S, o: { allowExtra?: boolean } = {}) =>
  schema<Out<S>>((v, p) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return bad(p, 'type', `${p ? name(p) : 'the input'} must be a set of fields`);
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const problems: Problem[] = [];
    for (const [k, s] of Object.entries(shape)) {
      const r = s.check(Object.hasOwn(src, k) ? src[k] : undefined, p ? `${p}.${k}` : k);
      if (r.ok) {
        if (r.value !== undefined) Object.defineProperty(out, k, { value: r.value, enumerable: true, writable: true, configurable: true });
      } else problems.push(...r.problems);
    }
    if (!o.allowExtra) for (const k of Object.keys(src)) if (!Object.hasOwn(shape, k)) problems.push({ path: p ? `${p}.${k}` : k, code: 'unknown', message: `${k} is not a field here` });
    return problems.length ? { ok: false, problems } : ok(out as Out<S>);
  });

/** Checks a value; returns the cleaned value, or throws Invalid carrying every problem. */
export class Invalid extends Error {
  readonly problems: readonly Problem[];
  constructor(problems: readonly Problem[]) {
    super(problems.map((x) => `${x.path}: ${x.message}`).join('; '));
    this.problems = problems;
  }
}

export function parse<T>(s: Schema<T>, v: unknown): T {
  const r = s.check(v, '');
  if (!r.ok) throw new Invalid(r.problems);
  return r.value;
}

/**
 * The one error body every API returns for invalid input (RFC 9457 problem details, with the field problems as
 * the "errors" extension). With type "about:blank" the title is the status code's phrase (RFC 9457 4.2.1); the
 * words for a person go in "detail".
 */
export function problemDetails(problems: readonly Problem[], instance?: string) {
  return { type: 'about:blank', title: 'Unprocessable Content', status: 422, detail: 'Some of what was sent needs fixing', ...(instance ? { instance } : {}), errors: problems.map((x) => ({ path: x.path, code: x.code, detail: x.message })) };
}

/** For a form: each field's first problem, keyed by path, so it is shown beside that field. */
export function fieldErrors(problems: readonly Problem[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const x of problems) if (!Object.hasOwn(out, x.path)) Object.defineProperty(out, x.path, { value: x.message, enumerable: true, writable: true, configurable: true });
  return out;
}
