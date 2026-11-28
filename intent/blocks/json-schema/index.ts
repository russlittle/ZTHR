/**
 * JSON Schema 2020-12 (draft https://json-schema.org/draft/2020-12/json-schema-core and -validation) for API and
 * form contracts: compile a schema once, validate many instances, and get every problem with the path to the field,
 * in the same `Problem` shape the validate block uses (`items[2].qty`), plus the JSON Pointer of the instance
 * and of the failing keyword.
 *
 * Covered: type, enum, const, multipleOf, minimum/maximum (and exclusive), minLength/maxLength, pattern, format
 * (asserted by default), minItems/maxItems/uniqueItems, prefixItems/items, contains/minContains/maxContains,
 * minProperties/maxProperties, required, dependentRequired, dependentSchemas, properties, patternProperties,
 * additionalProperties, propertyNames, allOf/anyOf/oneOf/not, if/then/else, unevaluatedProperties/unevaluatedItems,
 * $id/$anchor/$defs/$ref (and $dynamicRef resolved as a plain reference). Boolean schemas work everywhere.
 * Also: `infer` builds a schema from sample data, `example` generates a valid instance from a schema, and
 * `diff` classifies the changes between two versions of a schema as breaking or compatible.
 *
 * Security: no network access. A `$ref` to another document resolves only against schemas the caller has added
 * with `addSchema`. Patterns use the unicode regex engine, are length-limited, and are only run against strings up
 * to `maxPatternInput` characters. Reference cycles and deep instances stop at `maxDepth`. At most `maxProblems`
 * problems are collected.
 *
 * Out of scope: $vocabulary and meta-schema validation, $dynamicRef/$dynamicAnchor dynamic scope (treated as a
 * static $ref to the anchor), contentEncoding/contentMediaType assertions, and the iri/uri-template/relative-json-pointer
 * formats (accepted as annotations only). `diff` compares the common keywords structurally and does not follow $ref.
 */

import type { Problem } from '../validate/index.ts';

export class SchemaError extends Error {}
export class SchemaLimitError extends Error {}

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type SchemaValue = boolean | { [k: string]: unknown };

export interface SchemaProblem extends Problem {
  /** JSON Pointer of the failing instance location: "/items/2/qty". */
  readonly pointer: string;
  /** JSON Pointer of the failing keyword inside the schema, relative to the root: "/properties/qty/minimum". */
  readonly schemaPath: string;
}

export interface CompileOptions {
  /** 'assert' (default) makes `format` fail validation; 'annotate' ignores it. */
  readonly formats?: 'assert' | 'annotate';
  readonly maxDepth?: number;
  readonly maxProblems?: number;
  readonly maxPatternInput?: number;
  /** Other documents that `$ref` may point at, keyed by their `$id`. */
  readonly schemas?: readonly SchemaValue[];
}

export type ValidationResult = { readonly valid: true; readonly problems: readonly [] } | { readonly valid: false; readonly problems: readonly SchemaProblem[] };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o: object, k: string) => Object.hasOwn(o, k);

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
const matchesType = (v: unknown, t: string): boolean => {
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (t === 'integer') return typeof v === 'number' && Number.isInteger(v);
  return typeName(v) === t || (t === 'object' && isObj(v));
};

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'undefined';
}
export const jsonEqual = (a: unknown, b: unknown): boolean => canon(a) === canon(b);

const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
function pathOf(ptr: string[]): string {
  let out = '';
  for (const p of ptr) out += /^\d+$/.test(p) ? `[${p}]` : out ? `.${p}` : p;
  return out || '(input)';
}

function multipleOf(x: number, m: number): boolean {
  if (!(m > 0)) return false;
  const q = x / m;
  if (Number.isInteger(q)) return true;
  const dec = (n: number) => { const s = String(n); if (/e-/i.test(s)) return Number(s.split(/e-/i)[1]); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
  const d = Math.min(Math.max(dec(x), dec(m)), 15);
  const f = 10 ** d;
  return Math.round(x * f) % Math.round(m * f) === 0;
}

// ------------------------------------------------------------------ formats

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function validDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dim = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return d <= dim;
}
const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})(\.\d+)?(z|[+-](\d{2}):(\d{2}))$/i;
function validTime(s: string): boolean {
  const m = TIME_RE.exec(s);
  if (!m) return false;
  const h = Number(m[1]), mi = Number(m[2]), se = Number(m[3]);
  if (h > 23 || mi > 59 || se > 60) return false;
  if (m[6] !== undefined && (Number(m[6]) > 23 || Number(m[7]) > 59)) return false;
  return true;
}
function validIPv4(s: string): boolean {
  const p = s.split('.');
  return p.length === 4 && p.every((x) => /^(0|[1-9]\d{0,2})$/.test(x) && Number(x) <= 255);
}
function validIPv6(s: string): boolean {
  if (!/^[0-9a-f:.]+$/i.test(s)) return false;
  let groups = s;
  let extra = 0;
  const lastColon = s.lastIndexOf(':');
  if (s.includes('.')) { if (!validIPv4(s.slice(lastColon + 1))) return false; groups = `${s.slice(0, lastColon + 1)}0:0`; extra = 0; }
  const dbl = groups.split('::');
  if (dbl.length > 2) return false;
  const parts = (x: string) => (x === '' ? [] : x.split(':'));
  const all = dbl.flatMap(parts);
  if (!all.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return false;
  return (dbl.length === 2 ? all.length < 8 : all.length === 8) && extra === 0;
}
function validHostname(s: string): boolean {
  if (s.length === 0 || s.length > 253) return false;
  return s.replace(/\.$/, '').split('.').every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(l));
}
const FORMATS: Record<string, (s: string) => boolean> = {
  'date': validDate,
  'time': validTime,
  'date-time': (s) => { const i = s.search(/t/i); return i > 0 && validDate(s.slice(0, i)) && validTime(s.slice(i + 1)); },
  'email': (s) => /^[^\s@"(),:;<>[\\\]]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254 && !s.includes('..'),
  'uuid': (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  'uri': (s) => /^[a-z][a-z0-9+.-]*:[^\s]*$/i.test(s) && !/[<>"\\^`{|}]/.test(s),
  'uri-reference': (s) => !/[\s<>"\\^`{|}]/.test(s),
  'ipv4': validIPv4,
  'ipv6': validIPv6,
  'hostname': validHostname,
  'json-pointer': (s) => s === '' || (/^(\/([^~/]|~[01])*)+$/.test(s)),
  'regex': (s) => { try { new RegExp(s, 'u'); return true; } catch { return false; } },
  'duration': (s) => /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/.test(s),
};
export const formatNames = (): string[] => Object.keys(FORMATS);

// ------------------------------------------------------------------ registry

const ROOT = 'urn:jsonschema:root';
const SKIP_WALK = new Set(['enum', 'const', 'default', 'examples', 'required', 'type']);
interface Doc { readonly root: SchemaValue; readonly anchors: Map<string, SchemaValue> }

function hereOf(u: string): string { const i = u.indexOf('#'); return i < 0 ? u : u.slice(0, i); }
function resolveUri(ref: string, base: string): URL {
  try { return new URL(ref, base); } catch { throw new SchemaError(`cannot resolve "${ref}" against "${base}"`); }
}

class Registry {
  readonly docs = new Map<string, Doc>();
  readonly baseOf = new WeakMap<object, string>();
  readonly refs: { readonly node: Record<string, unknown>; readonly ref: string; readonly keyword: string }[] = [];
  readonly targets = new WeakMap<object, SchemaValue>();

  add(schema: SchemaValue, defaultBase: string): void {
    const root = isObj(schema) && typeof schema.$id === 'string' ? hereOf(resolveUri(schema.$id, defaultBase).href) : defaultBase;
    if (this.docs.has(root)) { if (this.docs.get(root)!.root !== schema) throw new SchemaError(`two different schemas have the id ${root}`); return; }
    this.walk(schema, root, root, 0);
  }

  private walk(s: unknown, base: string, doc: string, depth: number): void {
    if (depth > 200) throw new SchemaError('the schema is nested too deeply');
    if (Array.isArray(s)) { for (const x of s) this.walk(x, base, doc, depth + 1); return; }
    if (!isObj(s)) return;
    let b = base, d = doc;
    if (typeof s.$id === 'string') {
      const u = resolveUri(s.$id, base);
      if (u.hash && u.hash !== '#') throw new SchemaError(`$id "${s.$id}" must not have a fragment`);
      b = hereOf(u.href);
      d = b;
      const old = this.docs.get(b);
      if (old && old.root !== s) throw new SchemaError(`two different schemas have the id ${b}`);
      if (!old) this.docs.set(b, { root: s, anchors: new Map() });
    } else if (!this.docs.has(doc)) {
      this.docs.set(doc, { root: s, anchors: new Map() });
    }
    this.baseOf.set(s, b);
    if (typeof s.$anchor === 'string') {
      if (!/^[A-Za-z_][A-Za-z0-9._-]*$/.test(s.$anchor)) throw new SchemaError(`$anchor "${s.$anchor}" is not valid`);
      const a = this.docs.get(d)!.anchors;
      if (a.has(s.$anchor)) throw new SchemaError(`$anchor "${s.$anchor}" is defined twice`);
      a.set(s.$anchor, s);
    }
    for (const kw of ['$ref', '$dynamicRef'] as const) {
      const r = s[kw];
      if (typeof r === 'string') this.refs.push({ node: s, ref: r, keyword: kw });
    }
    for (const [k, v] of Object.entries(s)) if (!SKIP_WALK.has(k) && v !== null && typeof v === 'object') this.walk(v, b, d, depth + 1);
  }

  resolveAll(): void {
    for (const r of this.refs) this.targets.set(r.node, this.lookup(r.ref, this.baseOf.get(r.node) ?? ROOT));
  }

  private lookup(ref: string, base: string): SchemaValue {
    const u = resolveUri(ref, base);
    const docUri = hereOf(u.href);
    const doc = this.docs.get(docUri);
    if (!doc) throw new SchemaError(`$ref "${ref}" points at ${docUri}, which was not provided (remote schemas are never fetched)`);
    const frag = decodeURIComponent(u.hash.replace(/^#/, ''));
    if (frag === '') return doc.root;
    if (frag.startsWith('/')) {
      let cur: unknown = doc.root;
      for (const raw of frag.slice(1).split('/')) {
        const k = raw.replace(/~1/g, '/').replace(/~0/g, '~');
        if (Array.isArray(cur) && /^\d+$/.test(k)) cur = cur[Number(k)];
        else if (isObj(cur) && own(cur, k)) cur = cur[k];
        else throw new SchemaError(`$ref "${ref}" does not point at anything`);
      }
      if (typeof cur !== 'boolean' && !isObj(cur)) throw new SchemaError(`$ref "${ref}" does not point at a schema`);
      return cur;
    }
    const a = doc.anchors.get(frag);
    if (!a) throw new SchemaError(`$ref "${ref}" names an anchor that does not exist`);
    return a;
  }
}

// ------------------------------------------------------------------ validation

interface Ev { valid: boolean; props: Set<string>; items: Set<number> }
interface Run { readonly depth: { n: number }; readonly root: SchemaValue }

export interface Validator {
  readonly schema: SchemaValue;
  validate(instance: unknown): ValidationResult;
  /** Resolves a `$ref` string found in this schema's documents (used by `example`). */
  resolve(node: Record<string, unknown>): SchemaValue | undefined;
}

export function compile(schema: SchemaValue, o: CompileOptions = {}): Validator {
  if (typeof schema !== 'boolean' && !isObj(schema)) throw new SchemaError('a schema must be an object or a boolean');
  const reg = new Registry();
  for (const s of o.schemas ?? []) reg.add(s, `urn:jsonschema:extra:${reg.docs.size}`);
  reg.add(schema, ROOT);
  reg.resolveAll();
  const maxDepth = o.maxDepth ?? 64;
  const maxProblems = o.maxProblems ?? 100;
  const maxPat = o.maxPatternInput ?? 10_000;
  const assertFormats = (o.formats ?? 'assert') === 'assert';
  const rx = new Map<string, RegExp>();
  const regex = (p: string): RegExp => {
    let r = rx.get(p);
    if (!r) {
      if (p.length > 1000) throw new SchemaError('a pattern may be at most 1000 characters');
      try { r = new RegExp(p, 'u'); } catch { throw new SchemaError(`"${p}" is not a valid pattern`); }
      rx.set(p, r);
    }
    return r;
  };
  // fail early on bad patterns
  const checkPatterns = (s: unknown, d: number): void => {
    if (d > 200) return;
    if (Array.isArray(s)) { s.forEach((x) => checkPatterns(x, d + 1)); return; }
    if (!isObj(s)) return;
    if (typeof s.pattern === 'string') regex(s.pattern);
    if (isObj(s.patternProperties)) Object.keys(s.patternProperties).forEach(regex);
    for (const [k, v] of Object.entries(s)) if (!SKIP_WALK.has(k)) checkPatterns(v, d + 1);
  };
  checkPatterns(schema, 0);

  const test = (p: string, s: string): boolean => s.length <= maxPat && regex(p).test(s);

  function run(s: SchemaValue, inst: unknown, ptr: string[], sp: string[], errs: SchemaProblem[], st: Run): Ev {
    const ev: Ev = { valid: true, props: new Set(), items: new Set() };
    if (s === true) return ev;
    const before = errs.length;
    const fail = (kw: string, code: string, message: string) => {
      errs.push({ path: pathOf(ptr), code, message, pointer: ptr.map((p) => `/${esc(p)}`).join(''), schemaPath: [...sp, kw].map((p) => `/${esc(p)}`).join('') });
    };
    if (s === false) { fail('', 'false', 'nothing is allowed here'); ev.valid = false; return ev; }
    if (++st.depth.n > maxDepth) throw new SchemaLimitError(`validation went deeper than ${maxDepth} levels (a $ref cycle or a very deep instance)`);
    try {
      const sub = (kw: string, child: SchemaValue, i: unknown, p: string[], extraSp: string[] = [], e = errs) => run(child, i, p, [...sp, kw, ...extraSp], e, st);
      const merge = (r: Ev) => { r.props.forEach((x) => ev.props.add(x)); r.items.forEach((x) => ev.items.add(x)); };

      // references first so their annotations count for unevaluated*
      for (const kw of ['$ref', '$dynamicRef']) {
        if (typeof s[kw] === 'string') {
          const t = reg.targets.get(s);
          if (t !== undefined) merge(sub(kw, t, inst, ptr));
        }
      }

      const t = s.type;
      if (t !== undefined) {
        const types = Array.isArray(t) ? (t as string[]) : [t as string];
        if (!types.some((x) => matchesType(inst, x))) fail('type', 'type', `expected ${types.join(' or ')}, got ${typeName(inst)}`);
      }
      if (Array.isArray(s.enum) && !s.enum.some((x) => jsonEqual(x, inst))) fail('enum', 'enum', `must be one of ${s.enum.map((x) => JSON.stringify(x)).join(', ')}`);
      if (own(s, 'const') && !jsonEqual(s.const, inst)) fail('const', 'const', `must equal ${JSON.stringify(s.const)}`);

      if (typeof inst === 'number') {
        if (typeof s.multipleOf === 'number' && !multipleOf(inst, s.multipleOf)) fail('multipleOf', 'multipleOf', `must be a multiple of ${s.multipleOf}`);
        if (typeof s.minimum === 'number' && inst < s.minimum) fail('minimum', 'minimum', `must be at least ${s.minimum}`);
        if (typeof s.maximum === 'number' && inst > s.maximum) fail('maximum', 'maximum', `must be at most ${s.maximum}`);
        if (typeof s.exclusiveMinimum === 'number' && inst <= s.exclusiveMinimum) fail('exclusiveMinimum', 'exclusiveMinimum', `must be more than ${s.exclusiveMinimum}`);
        if (typeof s.exclusiveMaximum === 'number' && inst >= s.exclusiveMaximum) fail('exclusiveMaximum', 'exclusiveMaximum', `must be less than ${s.exclusiveMaximum}`);
      }

      if (typeof inst === 'string') {
        const len = [...inst].length;
        if (typeof s.minLength === 'number' && len < s.minLength) fail('minLength', 'minLength', `must have at least ${s.minLength} characters`);
        if (typeof s.maxLength === 'number' && len > s.maxLength) fail('maxLength', 'maxLength', `must have at most ${s.maxLength} characters`);
        if (typeof s.pattern === 'string' && !test(s.pattern, inst)) fail('pattern', 'pattern', inst.length > maxPat ? `is too long to check against the pattern (over ${maxPat} characters)` : `does not match the pattern ${s.pattern}`);
        if (assertFormats && typeof s.format === 'string' && own(FORMATS, s.format) && !FORMATS[s.format]!(inst)) fail('format', 'format', `is not a valid ${s.format}`);
      }

      if (Array.isArray(inst)) {
        if (typeof s.minItems === 'number' && inst.length < s.minItems) fail('minItems', 'minItems', `must have at least ${s.minItems} items`);
        if (typeof s.maxItems === 'number' && inst.length > s.maxItems) fail('maxItems', 'maxItems', `must have at most ${s.maxItems} items`);
        if (s.uniqueItems === true) {
          const seen = new Set<string>();
          for (let i = 0; i < inst.length; i++) {
            const c = canon(inst[i]);
            if (seen.has(c)) { fail('uniqueItems', 'uniqueItems', `items must be unique (item ${i} repeats an earlier one)`); break; }
            seen.add(c);
          }
        }
        const prefix = Array.isArray(s.prefixItems) ? (s.prefixItems as SchemaValue[]) : [];
        for (let i = 0; i < prefix.length && i < inst.length; i++) { merge2(ev, sub('prefixItems', prefix[i]!, inst[i], [...ptr, String(i)], [String(i)])); ev.items.add(i); }
        if (s.items !== undefined && (typeof s.items === 'boolean' || isObj(s.items))) {
          for (let i = prefix.length; i < inst.length; i++) { merge2(ev, sub('items', s.items as SchemaValue, inst[i], [...ptr, String(i)])); ev.items.add(i); }
        }
        if (s.contains !== undefined) {
          const min = typeof s.minContains === 'number' ? s.minContains : 1;
          let n = 0;
          for (let i = 0; i < inst.length; i++) {
            const tmp: SchemaProblem[] = [];
            const r = run(s.contains as SchemaValue, inst[i], [...ptr, String(i)], [...sp, 'contains'], tmp, st);
            if (tmp.length === 0) { n++; r.items.forEach(() => 0); ev.items.add(i); }
          }
          if (n < min) fail('contains', 'contains', n === 0 ? 'must contain at least one matching item' : `must contain at least ${min} matching items, found ${n}`);
          if (typeof s.maxContains === 'number' && n > s.maxContains) fail('maxContains', 'maxContains', `must contain at most ${s.maxContains} matching items, found ${n}`);
        }
      }

      if (isObj(inst)) {
        const keys = Object.keys(inst);
        if (typeof s.minProperties === 'number' && keys.length < s.minProperties) fail('minProperties', 'minProperties', `must have at least ${s.minProperties} properties`);
        if (typeof s.maxProperties === 'number' && keys.length > s.maxProperties) fail('maxProperties', 'maxProperties', `must have at most ${s.maxProperties} properties`);
        if (Array.isArray(s.required)) for (const r of s.required as string[]) if (!own(inst, r)) errs.push({ path: pathOf([...ptr, r]), code: 'required', message: `${r} is required`, pointer: [...ptr, r].map((p) => `/${esc(p)}`).join(''), schemaPath: [...sp, 'required'].map((p) => `/${esc(p)}`).join('') });
        if (isObj(s.dependentRequired)) for (const [k, deps] of Object.entries(s.dependentRequired)) if (own(inst, k) && Array.isArray(deps)) for (const d of deps as string[]) if (!own(inst, d)) fail('dependentRequired', 'dependentRequired', `${d} is required when ${k} is present`);
        if (isObj(s.dependentSchemas)) for (const [k, ds] of Object.entries(s.dependentSchemas)) if (own(inst, k)) merge2(ev, sub('dependentSchemas', ds as SchemaValue, inst, ptr, [k]));
        const props = isObj(s.properties) ? s.properties : {};
        const pats = isObj(s.patternProperties) ? Object.keys(s.patternProperties) : [];
        for (const k of keys) {
          let matched = false;
          if (own(props, k)) { matched = true; merge2(ev, sub('properties', props[k] as SchemaValue, inst[k], [...ptr, k], [k])); }
          for (const p of pats) if (test(p, k)) { matched = true; merge2(ev, sub('patternProperties', (s.patternProperties as Record<string, SchemaValue>)[p]!, inst[k], [...ptr, k], [p])); }
          if (matched) ev.props.add(k);
          else if (s.additionalProperties !== undefined) { merge2(ev, sub('additionalProperties', s.additionalProperties as SchemaValue, inst[k], [...ptr, k])); ev.props.add(k); }
        }
        if (s.propertyNames !== undefined) for (const k of keys) { const tmp: SchemaProblem[] = []; run(s.propertyNames as SchemaValue, k, ptr, [...sp, 'propertyNames'], tmp, st); if (tmp.length) fail('propertyNames', 'propertyNames', `the name "${k}" is not allowed: ${tmp[0]!.message}`); }
      }

      if (Array.isArray(s.allOf)) (s.allOf as SchemaValue[]).forEach((c, i) => merge2(ev, sub('allOf', c, inst, ptr, [String(i)])));
      if (Array.isArray(s.anyOf)) {
        let any = false;
        (s.anyOf as SchemaValue[]).forEach((c, i) => { const tmp: SchemaProblem[] = []; const r = run(c, inst, ptr, [...sp, 'anyOf', String(i)], tmp, st); if (!tmp.length) { any = true; merge(r); } });
        if (!any) fail('anyOf', 'anyOf', 'does not match any of the allowed shapes');
      }
      if (Array.isArray(s.oneOf)) {
        let n = 0;
        (s.oneOf as SchemaValue[]).forEach((c, i) => { const tmp: SchemaProblem[] = []; const r = run(c, inst, ptr, [...sp, 'oneOf', String(i)], tmp, st); if (!tmp.length) { n++; merge(r); } });
        if (n === 0) fail('oneOf', 'oneOf', 'does not match any of the allowed shapes');
        else if (n > 1) fail('oneOf', 'oneOf', `matches ${n} of the allowed shapes but must match exactly one`);
      }
      if (s.not !== undefined) { const tmp: SchemaProblem[] = []; run(s.not as SchemaValue, inst, ptr, [...sp, 'not'], tmp, st); if (!tmp.length) fail('not', 'not', 'must not match the forbidden shape'); }
      if (s.if !== undefined) {
        const tmp: SchemaProblem[] = [];
        const r = run(s.if as SchemaValue, inst, ptr, [...sp, 'if'], tmp, st);
        if (!tmp.length) { merge(r); if (s.then !== undefined) merge2(ev, sub('then', s.then as SchemaValue, inst, ptr)); }
        else if (s.else !== undefined) merge2(ev, sub('else', s.else as SchemaValue, inst, ptr));
      }

      if (s.unevaluatedItems !== undefined && Array.isArray(inst)) {
        for (let i = 0; i < inst.length; i++) if (!ev.items.has(i)) { merge2(ev, sub('unevaluatedItems', s.unevaluatedItems as SchemaValue, inst[i], [...ptr, String(i)])); ev.items.add(i); }
      }
      if (s.unevaluatedProperties !== undefined && isObj(inst)) {
        for (const k of Object.keys(inst)) if (!ev.props.has(k)) { merge2(ev, sub('unevaluatedProperties', s.unevaluatedProperties as SchemaValue, inst[k], [...ptr, k])); ev.props.add(k); }
      }
    } finally { st.depth.n--; }
    ev.valid = errs.length === before;
    if (!ev.valid) { ev.props = new Set(); ev.items = new Set(); }
    return ev;
  }
  const merge2 = (ev: Ev, r: Ev) => { r.props.forEach((x) => ev.props.add(x)); r.items.forEach((x) => ev.items.add(x)); };

  return {
    schema,
    validate(instance) {
      const errs: SchemaProblem[] = [];
      run(schema, instance, [], [], errs, { depth: { n: 0 }, root: schema });
      return errs.length === 0 ? { valid: true, problems: [] } : { valid: false, problems: errs.slice(0, maxProblems) };
    },
    resolve(node) { return reg.targets.get(node); },
  };
}

/** Validates once without keeping the compiled form. */
export function validate(schema: SchemaValue, instance: unknown, o: CompileOptions = {}): ValidationResult {
  return compile(schema, o).validate(instance);
}

// ------------------------------------------------------------------ infer

export interface InferOptions {
  /** Mark properties present in every sample as required (default true). */
  readonly required?: boolean;
  /** Add `format` when every string sample is a date, date-time, email, uuid or ipv4 (default true). */
  readonly formats?: boolean;
  /** Forbid properties that no sample had (default false). */
  readonly closed?: boolean;
}

function inferFormat(strs: string[]): string | undefined {
  for (const f of ['date-time', 'date', 'uuid', 'email', 'ipv4']) if (strs.length && strs.every((s) => FORMATS[f]!(s))) return f;
  return undefined;
}

/** Builds a schema that accepts every sample: types, properties, required, array items, numeric bounds are not guessed. */
export function infer(samples: readonly unknown[], o: InferOptions = {}, depth = 0): SchemaValue {
  if (depth > 32) throw new SchemaLimitError('the samples are nested too deeply to infer from');
  if (samples.length === 0) return true;
  const kinds = new Set(samples.map(typeName));
  if (kinds.has('integer') && kinds.has('number')) kinds.delete('integer');
  const out: Record<string, unknown> = {};
  const list = [...kinds].sort();
  out.type = list.length === 1 ? list[0] : list;
  const strs = samples.filter((x): x is string => typeof x === 'string');
  if (strs.length && o.formats !== false) { const f = inferFormat(strs); if (f && strs.length === samples.length) out.format = f; }
  const arrs = samples.filter(Array.isArray) as unknown[][];
  if (arrs.length) { const items = arrs.flat(); if (items.length) out.items = infer(items, o, depth + 1); }
  const objs = samples.filter(isObj);
  if (objs.length) {
    const names = [...new Set(objs.flatMap((x) => Object.keys(x)))].sort();
    const props: Record<string, unknown> = {};
    for (const n of names) {
      if (n === '__proto__') continue;
      Object.defineProperty(props, n, { value: infer(objs.filter((x) => own(x, n)).map((x) => x[n]), o, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    out.properties = props;
    if (o.required !== false) { const req = names.filter((n) => objs.every((x) => own(x, n))); if (req.length) out.required = req; }
    if (o.closed) out.additionalProperties = false;
  }
  return out;
}

// ------------------------------------------------------------------ example

export interface ExampleOptions extends CompileOptions {
  /** Picks among alternatives (enum, anyOf, oneOf, optional properties). Without it, the first choice and required properties only. */
  readonly rng?: () => number;
  readonly maxDepth?: number;
}

const EXAMPLE_FORMATS: Record<string, string> = {
  'date': '2024-01-15', 'time': '12:00:00Z', 'date-time': '2024-01-15T12:00:00Z', 'email': 'user@example.com',
  'uuid': '123e4567-e89b-42d3-a456-426614174000', 'uri': 'https://example.com/', 'uri-reference': '/path', 'ipv4': '192.0.2.1',
  'ipv6': '2001:db8::1', 'hostname': 'example.com', 'json-pointer': '/a', 'regex': '^a$', 'duration': 'P1D',
};

/** Generates an instance that validates against the schema, or throws SchemaError when it cannot (pattern, not, unevaluated*). */
export function example(schema: SchemaValue, o: ExampleOptions = {}): unknown {
  const v = compile(schema, o);
  const rng = o.rng;
  const pick = <T>(xs: readonly T[]): T => xs[rng ? Math.min(xs.length - 1, Math.floor(rng() * xs.length)) : 0]!;
  const limit = o.maxDepth ?? 12;
  const gen = (s: SchemaValue, d: number): unknown => {
    if (d > limit) throw new SchemaError('the schema recurses too deeply to generate an example (make the recursive part optional)');
    if (s === true) return null;
    if (s === false) throw new SchemaError('a false schema has no valid instance');
    if (own(s, 'const')) return s.const;
    if (Array.isArray(s.enum) && s.enum.length) return pick(s.enum);
    if (own(s, 'default')) return s.default;
    if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
    let base: Record<string, unknown> = {};
    const target = v.resolve(s);
    if (target !== undefined) { const r = gen(target, d + 1); if (!isObj(r) || (!Array.isArray(s.allOf) && Object.keys(s).filter((k) => !k.startsWith('$') && k !== 'description' && k !== 'title').length === 0)) return r; base = r; }
    if (Array.isArray(s.allOf)) {
      const parts = (s.allOf as SchemaValue[]).map((c) => gen(c, d + 1));
      if (parts.every(isObj)) base = Object.assign(base, ...parts);
      else if (parts.length) return parts[0];
      if (s.type === undefined && s.properties === undefined && s.required === undefined && s.items === undefined) return base;
    }
    for (const kw of ['oneOf', 'anyOf'] as const) {
      if (Array.isArray(s[kw]) && (s[kw] as unknown[]).length) {
        const opts = (s[kw] as SchemaValue[]);
        let last: unknown;
        for (const c of rng ? [pick(opts), ...opts] : opts) {
          try { last = gen(c, d + 1); const r = isObj(last) && isObj(base) ? { ...base, ...last } : last; if (v.validate(r).valid || !isObj(s) ) return r; } catch (e) { if (!(e instanceof SchemaError)) throw e; }
        }
        return last;
      }
    }
    const types = Array.isArray(s.type) ? (s.type as string[]) : typeof s.type === 'string' ? [s.type] : [isObj(s.properties) || s.required ? 'object' : s.items || s.prefixItems ? 'array' : typeof s.minimum === 'number' || typeof s.maximum === 'number' ? 'number' : typeof s.minLength === 'number' || s.format ? 'string' : 'null'];
    const t = types.includes('null') && types.length > 1 ? types.find((x) => x !== 'null')! : types[0]!;
    switch (t) {
      case 'null': return null;
      case 'boolean': return true;
      case 'integer': case 'number': {
        const lo = typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + (t === 'integer' ? 1 : 0.5) : undefined;
        const hi = typeof s.maximum === 'number' ? s.maximum : typeof s.exclusiveMaximum === 'number' ? s.exclusiveMaximum - (t === 'integer' ? 1 : 0.5) : undefined;
        const m = typeof s.multipleOf === 'number' && s.multipleOf > 0 ? s.multipleOf : t === 'integer' ? 1 : undefined;
        let x = lo ?? (hi !== undefined && hi < 0 ? hi : 0);
        if (hi !== undefined && x > hi) x = hi;
        if (m !== undefined) { x = Math.ceil(x / m) * m; if (hi !== undefined && x > hi) x = Math.floor(hi / m) * m; }
        return Number(x.toPrecision(12));
      }
      case 'string': {
        if (typeof s.format === 'string' && EXAMPLE_FORMATS[s.format]) return EXAMPLE_FORMATS[s.format];
        if (typeof s.pattern === 'string') throw new SchemaError('cannot generate a string for a pattern; give the schema an example or default');
        const min = typeof s.minLength === 'number' ? s.minLength : 0;
        const max = typeof s.maxLength === 'number' ? s.maxLength : Infinity;
        return 'a'.repeat(Math.min(Math.max(min, 1), max));
      }
      case 'array': {
        const out: unknown[] = [];
        const pre = Array.isArray(s.prefixItems) ? (s.prefixItems as SchemaValue[]) : [];
        const min = typeof s.minItems === 'number' ? s.minItems : 0;
        for (let i = 0; i < pre.length && i < min; i++) out.push(gen(pre[i]!, d + 1));
        while (out.length < min) {
          if (s.items === undefined || s.items === true) out.push(null);
          else if (out.length < pre.length) out.push(gen(pre[out.length]!, d + 1));
          else out.push(s.uniqueItems === true && typeof s.items !== 'boolean' ? uniq(gen(s.items as SchemaValue, d + 1), out.length) : gen(s.items as SchemaValue, d + 1));
        }
        if (s.contains !== undefined) { const need2 = typeof s.minContains === 'number' ? s.minContains : 1; for (let i = 0; i < need2; i++) out.push(gen(s.contains as SchemaValue, d + 1)); }
        return out;
      }
      case 'object': {
        const out: Record<string, unknown> = {};
        const props = isObj(s.properties) ? s.properties : {};
        const req = Array.isArray(s.required) ? (s.required as string[]) : [];
        for (const k of req) Object.defineProperty(out, k, { value: own(props, k) ? gen(props[k] as SchemaValue, d + 1) : null, enumerable: true, writable: true, configurable: true });
        for (const k of Object.keys(props)) if (!own(out, k) && rng && rng() < 0.5) Object.defineProperty(out, k, { value: gen(props[k] as SchemaValue, d + 1), enumerable: true, writable: true, configurable: true });
        const min = typeof s.minProperties === 'number' ? s.minProperties : 0;
        for (let i = 0; Object.keys(out).length < min; i++) { const k = `extra${i}`; Object.defineProperty(out, k, { value: isObj(s.additionalProperties) ? gen(s.additionalProperties as SchemaValue, d + 1) : null, enumerable: true, writable: true, configurable: true }); }
        return Object.assign(base, out);
      }
      default: throw new SchemaError(`cannot generate a ${t}`);
    }
  };
  const uniq = (x: unknown, i: number): unknown => (typeof x === 'number' ? x + i : typeof x === 'string' ? `${x}${i}` : x);
  const r = gen(schema, 0);
  const check = v.validate(r);
  if (!check.valid) throw new SchemaError(`could not generate a valid example: ${check.problems[0]!.path} ${check.problems[0]!.message}`);
  return r;
}

// ------------------------------------------------------------------ diff

export interface Change {
  /** JSON Pointer into the schema, e.g. "/properties/age/minimum". */
  readonly at: string;
  readonly kind: 'breaking' | 'compatible';
  readonly code: string;
  readonly message: string;
}

export interface DiffOptions {
  /**
   * 'input' (default): the schema describes what a server accepts, so accepting less is breaking.
   * 'output': the schema describes what a server returns, so promising less is breaking.
   */
  readonly direction?: 'input' | 'output';
}

/**
 * Compares two versions of a schema and classifies each difference. Handles type, enum, const, numeric and length
 * bounds, pattern, format, required, properties, additionalProperties, items and nested schemas. A changed `$ref`
 * is reported but never followed, and unknown keywords are compared by value and reported as breaking.
 */
export function diff(oldS: SchemaValue, newS: SchemaValue, o: DiffOptions = {}): Change[] {
  const out: Change[] = [];
  const output = o.direction === 'output';
  // narrower = accepts or promises fewer values
  const narrower = (at: string, code: string, message: string) => out.push({ at, kind: output ? 'compatible' : 'breaking', code, message });
  const wider = (at: string, code: string, message: string) => out.push({ at, kind: output ? 'breaking' : 'compatible', code, message });
  const unknown = (at: string, code: string, message: string) => out.push({ at, kind: 'breaking', code, message });

  const typesOf = (s: Record<string, unknown>): string[] | undefined => (s.type === undefined ? undefined : (Array.isArray(s.type) ? (s.type as string[]) : [s.type as string]));
  const covers = (wide: string[], t: string) => wide.includes(t) || (t === 'integer' && wide.includes('number'));

  const walk = (a: SchemaValue, b: SchemaValue, at: string, depth: number): void => {
    if (depth > 50) return;
    if (a === b) return;
    if (typeof a === 'boolean' || typeof b === 'boolean') {
      if (a === true && b !== true) narrower(at, 'restricted', 'anything was allowed; now it is restricted');
      else if (b === true && a !== true) wider(at, 'relaxed', 'it is now unrestricted');
      else if (typeof a === 'boolean' && typeof b === 'boolean') narrower(at, 'restricted', 'nothing is allowed now');
      else if (a === false) wider(at, 'relaxed', 'nothing was allowed; now something is');
      else if (b === false) narrower(at, 'restricted', 'nothing is allowed now');
      return;
    }
    if (a.$ref !== b.$ref) unknown(`${at}/$ref`, 'ref', `the reference changed from ${String(a.$ref)} to ${String(b.$ref)}`);

    const ta = typesOf(a), tb = typesOf(b);
    if (ta === undefined && tb !== undefined) narrower(`${at}/type`, 'type', `the type is now restricted to ${tb.join(' or ')}`);
    else if (ta !== undefined && tb === undefined) wider(`${at}/type`, 'type', 'the type is no longer restricted');
    else if (ta && tb) {
      const removed = ta.filter((t) => !covers(tb, t));
      const added = tb.filter((t) => !covers(ta, t));
      if (removed.length) narrower(`${at}/type`, 'type', `no longer allows ${removed.join(', ')}`);
      if (added.length) wider(`${at}/type`, 'type', `now also allows ${added.join(', ')}`);
    }

    if (Array.isArray(a.enum) || Array.isArray(b.enum)) {
      const ea = a.enum as unknown[] | undefined, eb = b.enum as unknown[] | undefined;
      if (!ea && eb) narrower(`${at}/enum`, 'enum', 'values are now limited to a fixed list');
      else if (ea && !eb) wider(`${at}/enum`, 'enum', 'values are no longer limited to a fixed list');
      else if (ea && eb) {
        const gone = ea.filter((x) => !eb.some((y) => jsonEqual(x, y)));
        const added = eb.filter((x) => !ea.some((y) => jsonEqual(x, y)));
        if (gone.length) narrower(`${at}/enum`, 'enum', `removed ${gone.map((x) => JSON.stringify(x)).join(', ')}`);
        if (added.length) wider(`${at}/enum`, 'enum', `added ${added.map((x) => JSON.stringify(x)).join(', ')}`);
      }
    }
    if (own(a, 'const') !== own(b, 'const') || (own(a, 'const') && !jsonEqual(a.const, b.const))) {
      if (!own(a, 'const')) narrower(`${at}/const`, 'const', 'the value is now fixed');
      else if (!own(b, 'const')) wider(`${at}/const`, 'const', 'the value is no longer fixed');
      else unknown(`${at}/const`, 'const', 'the fixed value changed');
    }

    const bound = (kw: string, lowerIsWider: boolean) => {
      const x = a[kw], y = b[kw];
      if (x === y) return;
      if (typeof x !== 'number' && typeof y === 'number') narrower(`${at}/${kw}`, kw, `${kw} ${y} was added`);
      else if (typeof x === 'number' && typeof y !== 'number') wider(`${at}/${kw}`, kw, `${kw} was removed`);
      else if (typeof x === 'number' && typeof y === 'number') {
        const looser = lowerIsWider ? y < x : y > x;
        (looser ? wider : narrower)(`${at}/${kw}`, kw, `${kw} changed from ${x} to ${y}`);
      }
    };
    // for minimum-style keywords a smaller number is wider; for maximum-style a larger one is
    for (const kw of ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties', 'minContains']) bound(kw, true);
    for (const kw of ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties', 'maxContains']) bound(kw, false);
    if (a.multipleOf !== b.multipleOf) { if (b.multipleOf === undefined) wider(`${at}/multipleOf`, 'multipleOf', 'multipleOf was removed'); else narrower(`${at}/multipleOf`, 'multipleOf', `multipleOf is now ${String(b.multipleOf)}`); }
    if (a.pattern !== b.pattern) { if (b.pattern === undefined) wider(`${at}/pattern`, 'pattern', 'the pattern was removed'); else if (a.pattern === undefined) narrower(`${at}/pattern`, 'pattern', 'a pattern was added'); else unknown(`${at}/pattern`, 'pattern', 'the pattern changed'); }
    if (a.format !== b.format) { if (b.format === undefined) wider(`${at}/format`, 'format', 'the format was removed'); else if (a.format === undefined) narrower(`${at}/format`, 'format', `format ${String(b.format)} was added`); else unknown(`${at}/format`, 'format', `the format changed from ${String(a.format)} to ${String(b.format)}`); }
    if (a.uniqueItems !== b.uniqueItems) { if (b.uniqueItems === true) narrower(`${at}/uniqueItems`, 'uniqueItems', 'items must now be unique'); else wider(`${at}/uniqueItems`, 'uniqueItems', 'items need no longer be unique'); }

    const ra = new Set((a.required as string[] | undefined) ?? []), rb = new Set((b.required as string[] | undefined) ?? []);
    for (const k of rb) if (!ra.has(k)) narrower(`${at}/required`, 'required', `${k} is now required`);
    for (const k of ra) if (!rb.has(k)) wider(`${at}/required`, 'required', `${k} is no longer required`);

    const pa = isObj(a.properties) ? a.properties : {}, pb = isObj(b.properties) ? b.properties : {};
    const closedA = a.additionalProperties === false, closedB = b.additionalProperties === false;
    for (const k of Object.keys(pa)) {
      if (own(pb, k)) walk(pa[k] as SchemaValue, pb[k] as SchemaValue, `${at}/properties/${esc(k)}`, depth + 1);
      else if (closedB) narrower(`${at}/properties/${esc(k)}`, 'property-removed', `${k} is no longer accepted`);
      else wider(`${at}/properties/${esc(k)}`, 'property-removed', `${k} is no longer described`);
    }
    for (const k of Object.keys(pb)) {
      if (own(pa, k)) continue;
      if (closedA) wider(`${at}/properties/${esc(k)}`, 'property-added', `${k} is now accepted`);
      else if (pb[k] === true || pb[k] === undefined) wider(`${at}/properties/${esc(k)}`, 'property-added', `${k} was added`);
      else narrower(`${at}/properties/${esc(k)}`, 'property-added', `${k} was added with its own rules`);
    }
    if (closedA !== closedB) { if (closedB) narrower(`${at}/additionalProperties`, 'additionalProperties', 'extra properties are now rejected'); else wider(`${at}/additionalProperties`, 'additionalProperties', 'extra properties are now allowed'); }
    else if (isObj(a.additionalProperties) && isObj(b.additionalProperties)) walk(a.additionalProperties as SchemaValue, b.additionalProperties as SchemaValue, `${at}/additionalProperties`, depth + 1);

    if (a.items !== undefined && b.items !== undefined) walk(a.items as SchemaValue, b.items as SchemaValue, `${at}/items`, depth + 1);
    else if (a.items === undefined && b.items !== undefined) narrower(`${at}/items`, 'items', 'items now have rules');
    else if (a.items !== undefined && b.items === undefined) wider(`${at}/items`, 'items', 'items no longer have rules');
    if (Array.isArray(a.prefixItems) && Array.isArray(b.prefixItems)) (a.prefixItems as SchemaValue[]).forEach((x, i) => { if (i < (b.prefixItems as unknown[]).length) walk(x, (b.prefixItems as SchemaValue[])[i]!, `${at}/prefixItems/${i}`, depth + 1); else wider(`${at}/prefixItems/${i}`, 'prefixItems', 'a positional rule was removed'); });

    for (const kw of ['allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else']) if (!jsonEqual(a[kw], b[kw])) {
      if (a[kw] === undefined) narrower(`${at}/${kw}`, kw, `${kw} was added`);
      else if (b[kw] === undefined) wider(`${at}/${kw}`, kw, `${kw} was removed`);
      else if (kw === 'anyOf' && Array.isArray(a[kw]) && Array.isArray(b[kw])) {
        const A = a[kw] as unknown[], B = b[kw] as unknown[];
        if (A.every((x) => B.some((y) => jsonEqual(x, y))) && B.length > A.length) wider(`${at}/anyOf`, 'anyOf', 'alternatives were added');
        else if (B.every((x) => A.some((y) => jsonEqual(x, y))) && A.length > B.length) narrower(`${at}/anyOf`, 'anyOf', 'alternatives were removed');
        else unknown(`${at}/anyOf`, 'anyOf', 'the alternatives changed');
      } else unknown(`${at}/${kw}`, kw, `${kw} changed`);
    }
    for (const kw of ['$defs', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'patternProperties', 'dependentRequired', 'dependentSchemas', 'contains']) {
      if (!jsonEqual(a[kw], b[kw])) unknown(`${at}/${kw}`, kw, `${kw} changed`);
    }
  };
  walk(oldS, newS, '', 0);
  return out;
}

/** True when no change breaks existing users. */
export const isCompatible = (oldS: SchemaValue, newS: SchemaValue, o: DiffOptions = {}): boolean => diff(oldS, newS, o).every((c) => c.kind === 'compatible');
