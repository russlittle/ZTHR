/**
 * SCIM 2.0 (RFC 7642, 7643, 7644): the endpoints an identity provider such as Okta or Entra uses to create, update
 * and remove users and groups in an app, as a handler over plain request objects.
 *
 *  - Resources: User (with the enterprise extension) and Group, with the attribute table that drives validation
 *    (types, multi-valued, required, read-only, write-only), unknown attributes refused, the password never stored or
 *    returned (it is handed to a callback), `groups` on a user derived from group membership, one `primary` per list.
 *  - Filters (RFC 7644 3.4.2.2): the full grammar, parsed to a tree with bounded length and depth: eq ne co sw ew gt
 *    ge lt le pr, and or not, parentheses, and value filters like `emails[type eq "work" and value co "@x.org"]`.
 *    Attribute names and string comparisons are case-insensitive except id and externalId.
 *  - Lists with filter, sortBy and sortOrder, 1-based startIndex, count, attributes and excludedAttributes.
 *  - PatchOp (3.5.2): add, remove and replace, with and without a path, value filters and sub-attributes, operation
 *    names in any case, and the string booleans ("True") some providers send; mutability enforced; atomic (all
 *    operations apply or none do).
 *  - ETags: a weak ETag in meta.version, If-Match (412), If-None-Match (304).
 *  - Bulk (3.7): ordered operations with bulkId references, failOnErrors, and limits.
 *  - Discovery: ServiceProviderConfig, ResourceTypes, Schemas.
 *
 * Not here: authentication (the caller authenticates the request), the /.search and /Me endpoints, custom resource
 * types, and attribute-level `returned: request` semantics. Storage is in memory.
 */
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- errors and constants

export const SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCHEMA_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCHEMA_ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
export const SCHEMA_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCHEMA_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCHEMA_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCHEMA_BULK_REQUEST = 'urn:ietf:params:scim:api:messages:2.0:BulkRequest';
export const SCHEMA_BULK_RESPONSE = 'urn:ietf:params:scim:api:messages:2.0:BulkResponse';
export const SCHEMA_SPC = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';

export type ScimType = 'invalidFilter' | 'tooMany' | 'uniqueness' | 'mutability' | 'invalidSyntax' | 'invalidPath' | 'noTarget' | 'invalidValue' | 'invalidVers' | 'sensitive';

export class ScimError extends Error {
  readonly status: number;
  readonly scimType: ScimType | undefined;
  constructor(status: number, detail: string, scimType?: ScimType) {
    super(detail);
    this.status = status;
    this.scimType = scimType;
  }
  toBody() {
    return { schemas: [SCHEMA_ERROR], status: String(this.status), ...(this.scimType ? { scimType: this.scimType } : {}), detail: this.message };
  }
}

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Resource = { [k: string]: Json };

// ---------------------------------------------------------------- attribute tables

type AttrType = 'string' | 'boolean' | 'integer' | 'complex' | 'dateTime' | 'reference';
interface AttrDef {
  readonly type: AttrType;
  readonly multi?: boolean;
  readonly sub?: Readonly<Record<string, AttrDef>>;
  readonly mutability?: 'readOnly' | 'readWrite' | 'immutable' | 'writeOnly';
  readonly required?: boolean;
  readonly caseExact?: boolean;
}
const S: AttrDef = { type: 'string' };
const B: AttrDef = { type: 'boolean' };
const multiValue = (extra: Record<string, AttrDef> = {}): AttrDef => ({ type: 'complex', multi: true, sub: { value: S, display: S, type: S, primary: B, ...extra } });

const USER_ATTRS: Record<string, AttrDef> = {
  externalId: { type: 'string', caseExact: true },
  userName: { type: 'string', required: true },
  name: { type: 'complex', sub: { formatted: S, familyName: S, givenName: S, middleName: S, honorificPrefix: S, honorificSuffix: S } },
  displayName: S, nickName: S, profileUrl: { type: 'reference' }, title: S, userType: S, preferredLanguage: S, locale: S, timezone: S,
  active: B,
  password: { type: 'string', mutability: 'writeOnly' },
  emails: multiValue(), phoneNumbers: multiValue(), ims: multiValue(), photos: multiValue(),
  addresses: { type: 'complex', multi: true, sub: { formatted: S, streetAddress: S, locality: S, region: S, postalCode: S, country: S, type: S, primary: B } },
  groups: { type: 'complex', multi: true, mutability: 'readOnly', sub: { value: S, $ref: { type: 'reference' }, display: S, type: S } },
  entitlements: multiValue(), roles: multiValue(), x509Certificates: multiValue(),
};
const ENTERPRISE_ATTRS: Record<string, AttrDef> = {
  employeeNumber: S, costCenter: S, organization: S, division: S, department: S,
  manager: { type: 'complex', sub: { value: S, $ref: { type: 'reference' }, displayName: { type: 'string', mutability: 'readOnly' } } },
};
const GROUP_ATTRS: Record<string, AttrDef> = {
  externalId: { type: 'string', caseExact: true },
  displayName: { type: 'string', required: true },
  members: { type: 'complex', multi: true, sub: { value: { type: 'string', mutability: 'immutable' }, $ref: { type: 'reference' }, type: S, display: S } },
};
const COMMON: Record<string, AttrDef> = {
  schemas: { type: 'string', multi: true },
  id: { type: 'string', mutability: 'readOnly', caseExact: true },
  meta: { type: 'complex', mutability: 'readOnly', sub: { resourceType: S, created: { type: 'dateTime' }, lastModified: { type: 'dateTime' }, location: { type: 'reference' }, version: S } },
};

type Kind = 'User' | 'Group';
const attrsOf = (k: Kind) => ({ ...COMMON, ...(k === 'User' ? USER_ATTRS : GROUP_ATTRS) });

/** The key of `obj` equal to `name` ignoring case, or undefined. */
function keyOf(obj: object, name: string): string | undefined {
  const l = name.toLowerCase();
  return Object.keys(obj).find((k) => k.toLowerCase() === l);
}

// ---------------------------------------------------------------- filters

export type Filter =
  | { t: 'cmp'; path: string[]; op: 'eq' | 'ne' | 'co' | 'sw' | 'ew' | 'gt' | 'ge' | 'lt' | 'le'; value: string | number | boolean | null }
  | { t: 'pr'; path: string[] }
  | { t: 'and' | 'or'; l: Filter; r: Filter }
  | { t: 'not'; f: Filter }
  | { t: 'val'; path: string[]; f: Filter };

type Tok = { k: 'id' | 'str' | 'num' | 'lp' | 'rp' | 'lb' | 'rb'; v: string };
const MAX_FILTER = 2000;
const MAX_DEPTH = 20;
const OPS = new Set(['eq', 'ne', 'co', 'sw', 'ew', 'gt', 'ge', 'lt', 'le']);
const bad = (d: string) => new ScimError(400, d, 'invalidFilter');

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { out.push({ k: 'lp', v: c }); i++; }
    else if (c === ')') { out.push({ k: 'rp', v: c }); i++; }
    else if (c === '[') { out.push({ k: 'lb', v: c }); i++; }
    else if (c === ']') { out.push({ k: 'rb', v: c }); i++; }
    else if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      if (j >= s.length) throw bad('an unterminated string in the filter');
      try { out.push({ k: 'str', v: JSON.parse(s.slice(i, j + 1)) as string }); } catch { throw bad('a bad escape in a filter string'); }
      i = j + 1;
    } else if (/[-\d]/.test(c)) {
      const m = /^-?\d+(\.\d+)?([eE][-+]?\d+)?/.exec(s.slice(i));
      if (!m) throw bad(`cannot read "${s.slice(i, i + 10)}"`);
      out.push({ k: 'num', v: m[0] });
      i += m[0].length;
    } else if (/[A-Za-z$]/.test(c)) {
      const m = /^[A-Za-z$][A-Za-z0-9$_.:-]*/.exec(s.slice(i))!;
      out.push({ k: 'id', v: m[0] });
      i += m[0].length;
    } else throw bad(`cannot read "${s.slice(i, i + 10)}" in the filter`);
  }
  return out;
}

/** Splits an attribute path ("name.givenName" or "urn:...:User:manager.value") into its parts. */
export function splitPath(p: string): string[] {
  const m = /^(urn:[^\s]*:)([A-Za-z$][A-Za-z0-9$_.-]*)$/.exec(p);
  return m ? [m[1]!.slice(0, -1), ...m[2]!.split('.')] : p.split('.');
}

/** Parses a SCIM filter. Throws ScimError(400, invalidFilter). */
export function parseFilter(src: string): Filter {
  if (src.length > MAX_FILTER) throw bad(`a filter may be at most ${MAX_FILTER} characters`);
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isWord = (t: Tok | undefined, w: string) => t?.k === 'id' && t.v.toLowerCase() === w;
  const expr = (depth: number, inVal: boolean): Filter => {
    if (depth > MAX_DEPTH) throw bad('the filter is nested too deeply');
    let left = term(depth, inVal);
    while (isWord(peek(), 'or')) { p++; left = { t: 'or', l: left, r: term(depth, inVal) }; }
    return left;
  };
  const term = (depth: number, inVal: boolean): Filter => {
    let left = factor(depth, inVal);
    while (isWord(peek(), 'and')) { p++; left = { t: 'and', l: left, r: factor(depth, inVal) }; }
    return left;
  };
  const factor = (depth: number, inVal: boolean): Filter => {
    const t = peek();
    if (!t) throw bad('the filter ends too soon');
    if (isWord(t, 'not')) {
      p++;
      if (peek()?.k !== 'lp') throw bad('"not" must be followed by (');
      p++;
      const f = expr(depth + 1, inVal);
      if (peek()?.k !== 'rp') throw bad('a missing )');
      p++;
      return { t: 'not', f };
    }
    if (t.k === 'lp') {
      p++;
      const f = expr(depth + 1, inVal);
      if (peek()?.k !== 'rp') throw bad('a missing )');
      p++;
      return f;
    }
    if (t.k !== 'id') throw bad(`expected an attribute, found "${t.v}"`);
    p++;
    const path = splitPath(t.v);
    if (peek()?.k === 'lb') {
      if (inVal) throw bad('value filters cannot be nested');
      p++;
      const f = expr(depth + 1, true);
      if (peek()?.k !== 'rb') throw bad('a missing ]');
      p++;
      return { t: 'val', path, f };
    }
    const opTok = peek();
    if (!opTok || opTok.k !== 'id') throw bad(`"${t.v}" needs an operator`);
    const op = opTok.v.toLowerCase();
    p++;
    if (op === 'pr') return { t: 'pr', path };
    if (!OPS.has(op)) throw bad(`"${opTok.v}" is not an operator`);
    const v = peek();
    if (!v) throw bad(`"${t.v} ${op}" needs a value`);
    p++;
    let value: string | number | boolean | null;
    if (v.k === 'str') value = v.v;
    else if (v.k === 'num') value = Number(v.v);
    else if (v.k === 'id' && ['true', 'false', 'null'].includes(v.v)) value = v.v === 'null' ? null : v.v === 'true';
    else throw bad(`"${v.v}" is not a value`);
    if (['co', 'sw', 'ew'].includes(op) && typeof value !== 'string') throw bad(`${op} needs a string`);
    return { t: 'cmp', path, op: op as 'eq', value };
  };
  const f = expr(0, false);
  if (p < toks.length) throw bad(`unexpected "${toks[p]!.v}"`);
  return f;
}

/** Every value at a path in a resource, flattening multi-valued attributes. Names match ignoring case. */
function valuesAt(node: unknown, path: readonly string[]): unknown[] {
  if (path.length === 0) return Array.isArray(node) ? node : [node];
  if (Array.isArray(node)) return node.flatMap((x) => valuesAt(x, path));
  if (node === null || typeof node !== 'object') return [];
  const k = keyOf(node, path[0]!);
  return k === undefined ? [] : valuesAt((node as Record<string, unknown>)[k], path.slice(1));
}

const rootPath = (path: readonly string[]) => (path[0]?.startsWith('urn:') ? path : path);

function compare(a: unknown, op: string, b: string | number | boolean | null, exact: boolean): boolean {
  if (b === null) return op === 'eq' ? a === null || a === undefined : op === 'ne' ? a !== null && a !== undefined : false;
  if (typeof b === 'boolean') return typeof a === 'boolean' && (op === 'eq' ? a === b : op === 'ne' ? a !== b : false);
  if (typeof b === 'number') {
    if (typeof a !== 'number') return false;
    return op === 'eq' ? a === b : op === 'ne' ? a !== b : op === 'gt' ? a > b : op === 'ge' ? a >= b : op === 'lt' ? a < b : op === 'le' ? a <= b : false;
  }
  if (typeof a !== 'string') return false;
  const x = exact ? a : a.toLowerCase();
  const y = exact ? b : b.toLowerCase();
  switch (op) {
    case 'eq': return x === y;
    case 'ne': return x !== y;
    case 'co': return x.includes(y);
    case 'sw': return x.startsWith(y);
    case 'ew': return x.endsWith(y);
    case 'gt': return x > y;
    case 'ge': return x >= y;
    case 'lt': return x < y;
    default: return x <= y;
  }
}

const EXACT = new Set(['id', 'externalid']);
const present = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0) && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** Whether a resource (or one element of a multi-valued attribute) satisfies a filter. */
export function matches(f: Filter, node: unknown): boolean {
  switch (f.t) {
    case 'and': return matches(f.l, node) && matches(f.r, node);
    case 'or': return matches(f.l, node) || matches(f.r, node);
    case 'not': return !matches(f.f, node);
    case 'pr': return valuesAt(node, rootPath(f.path)).some(present);
    case 'val': return valuesAt(node, rootPath(f.path)).some((el) => matches(f.f, el));
    case 'cmp': {
      const vs = valuesAt(node, rootPath(f.path));
      const exact = EXACT.has(f.path[f.path.length - 1]!.toLowerCase());
      if (f.op === 'ne') return vs.length === 0 ? true : vs.every((v) => compare(v, 'ne', f.value, exact));
      if (vs.length === 0) return f.op === 'eq' && f.value === null;
      return vs.some((v) => compare(v, f.op, f.value, exact));
    }
  }
}

// ---------------------------------------------------------------- validation of resources

const isObj = (v: unknown): v is { [k: string]: Json } => typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => structuredClone(v);
const invalid = (d: string) => new ScimError(400, d, 'invalidValue');

function coerce(def: AttrDef, v: unknown, where: string): Json {
  switch (def.type) {
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string' && /^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
      throw invalid(`${where} must be true or false`);
    case 'integer':
      if (typeof v === 'number' && Number.isInteger(v)) return v;
      throw invalid(`${where} must be a whole number`);
    case 'complex': {
      if (!isObj(v)) throw invalid(`${where} must be an object`);
      const out: { [k: string]: Json } = {};
      for (const [k, x] of Object.entries(v)) {
        const sk = def.sub ? keyOf(def.sub, k) : undefined;
        if (!sk) throw invalid(`${where}.${k} is not an attribute`);
        const sd = def.sub![sk]!;
        if (sd.mutability === 'readOnly') continue;
        out[sk] = coerce(sd, x, `${where}.${sk}`);
      }
      return out;
    }
    default:
      if (typeof v === 'string') {
        if (v.length > 10_000) throw invalid(`${where} is too long`);
        return v;
      }
      throw invalid(`${where} must be text`);
  }
}

function coerceAttr(def: AttrDef, v: unknown, where: string): Json {
  if (def.multi) {
    if (!Array.isArray(v)) throw invalid(`${where} must be a list`);
    if (v.length > 1000) throw invalid(`${where} has too many values`);
    return v.map((x, i) => coerce(def, x, `${where}[${i}]`));
  }
  return coerce(def, v, where);
}

/** At most one `primary: true` per list. */
function checkPrimary(res: { [k: string]: Json }) {
  for (const [k, v] of Object.entries(res)) if (Array.isArray(v) && v.filter((e) => isObj(e) && e.primary === true).length > 1) throw invalid(`${k} has more than one primary value`);
}

/** Cleans a resource body for POST or PUT: unknown attributes are refused, read-only ones ignored, types coerced. */
export function cleanResource(kind: Kind, body: unknown): { [k: string]: Json } {
  if (!isObj(body)) throw new ScimError(400, 'the body must be a JSON object', 'invalidSyntax');
  const defs = attrsOf(kind);
  const out: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === SCHEMA_ENTERPRISE) {
      if (kind !== 'User') throw invalid('the enterprise extension is for users');
      out[SCHEMA_ENTERPRISE] = coerce({ type: 'complex', sub: ENTERPRISE_ATTRS }, v, 'enterprise');
      continue;
    }
    const dk = keyOf(defs, k);
    if (!dk) throw invalid(`${k} is not an attribute of ${kind}`);
    const d = defs[dk]!;
    if (d.mutability === 'readOnly' || dk === 'schemas') continue;
    out[dk] = coerceAttr(d, v, dk);
  }
  const req = kind === 'User' ? 'userName' : 'displayName';
  if (typeof out[req] !== 'string' || (out[req] as string).trim() === '') throw invalid(`${req} is required`);
  checkPrimary(out);
  return out;
}

// ---------------------------------------------------------------- PatchOp

export interface PatchOperation {
  readonly op: string;
  readonly path?: string;
  readonly value?: unknown;
}

interface PatchPath {
  readonly urn: string | undefined;
  readonly attr: string;
  readonly filter: Filter | undefined;
  readonly sub: string | undefined;
}

export function parsePatchPath(path: string): PatchPath {
  const lb = path.indexOf('[');
  let head = lb < 0 ? path : path.slice(0, lb);
  let filter: Filter | undefined;
  let tail = '';
  if (lb >= 0) {
    let depth = 0, inStr = false, end = -1;
    for (let i = lb; i < path.length; i++) {
      const c = path[i]!;
      if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '[') depth++;
      else if (c === ']' && --depth === 0) { end = i; break; }
    }
    if (end < 0) throw new ScimError(400, 'a missing ] in the path', 'invalidPath');
    filter = parseFilter(path.slice(lb + 1, end));
    tail = path.slice(end + 1);
    if (tail !== '' && !/^\.[A-Za-z$][A-Za-z0-9$_-]*$/.test(tail)) throw new ScimError(400, 'only a sub-attribute may follow a value filter', 'invalidPath');
  }
  let urn: string | undefined;
  if (head.toLowerCase().startsWith('urn:')) {
    const k = head.lastIndexOf(':');
    urn = head.slice(0, k);
    head = head.slice(k + 1);
  }
  const parts = head.split('.');
  if (parts.length > 2 || parts.some((x) => !/^[A-Za-z$][A-Za-z0-9$_-]*$/.test(x))) throw new ScimError(400, `"${path}" is not a valid path`, 'invalidPath');
  const sub = tail ? tail.slice(1) : parts[1];
  if (tail && parts[1]) throw new ScimError(400, `"${path}" is not a valid path`, 'invalidPath');
  return { urn, attr: parts[0]!, filter, sub };
}

const sameValue = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);

function fixPrimary(list: Json[], winner?: Json) {
  if (!winner || !isObj(winner) || winner.primary !== true) return;
  for (const e of list) if (isObj(e) && e !== winner && e.primary === true) e.primary = false;
}

/** Applies one operation to a copy of the resource and returns it. */
function applyOne(res: { [k: string]: Json }, kind: Kind, o: PatchOperation): void {
  const op = String(o.op ?? '').toLowerCase();
  if (!['add', 'remove', 'replace'].includes(op)) throw new ScimError(400, `"${String(o.op)}" is not an operation`, 'invalidSyntax');
  if (o.path !== undefined && typeof o.path !== 'string') throw new ScimError(400, 'path must be a string', 'invalidPath');
  if (o.path === undefined || o.path === '') {
    if (op === 'remove') throw new ScimError(400, 'remove needs a path', 'noTarget');
    if (!isObj(o.value)) throw new ScimError(400, `${op} without a path needs an object of attributes`, 'invalidValue');
    for (const [k, v] of Object.entries(o.value)) {
      if (k.toLowerCase().startsWith('urn:')) {
        if (!isObj(v)) throw invalid(`${k} must be an object`);
        for (const [sk, sv] of Object.entries(v)) applyOne(res, kind, { op, path: `${k}:${sk}`, value: sv });
      } else applyOne(res, kind, { op, path: k, value: v });
    }
    return;
  }
  const p = parsePatchPath(o.path);
  const defs = p.urn ? (p.urn.toLowerCase() === SCHEMA_ENTERPRISE.toLowerCase() && kind === 'User' ? ENTERPRISE_ATTRS : undefined) : attrsOf(kind);
  if (!defs) throw new ScimError(400, `the schema ${p.urn} is not known`, 'invalidPath');
  const name = keyOf(defs, p.attr);
  if (!name) throw new ScimError(400, `${p.attr} is not an attribute of ${kind}`, 'invalidPath');
  const def = defs[name]!;
  if (def.mutability === 'readOnly') throw new ScimError(400, `${name} is read-only`, 'mutability');
  const holder: { [k: string]: Json } = p.urn ? (isObj(res[SCHEMA_ENTERPRISE]) ? (res[SCHEMA_ENTERPRISE] as { [k: string]: Json }) : (res[SCHEMA_ENTERPRISE] = {})) : res;
  const subName = p.sub ? (def.sub ? keyOf(def.sub, p.sub) : undefined) : undefined;
  if (p.sub && (!def.sub || !subName)) throw new ScimError(400, `${p.sub} is not a sub-attribute of ${name}`, 'invalidPath');
  const subDef = subName ? def.sub![subName]! : undefined;
  if (subDef?.mutability === 'readOnly') throw new ScimError(400, `${name}.${subName} is read-only`, 'mutability');

  if (op === 'remove') {
    if (def.required && !p.filter && !p.sub) throw new ScimError(400, `${name} is required and cannot be removed`, 'mutability');
    const cur = holder[name];
    if (cur === undefined) return;
    if (p.filter) {
      if (!Array.isArray(cur)) throw new ScimError(400, `${name} is not multi-valued`, 'invalidPath');
      if (subName) { for (const e of cur) if (isObj(e) && matches(p.filter, e)) delete e[subName]; }
      else holder[name] = cur.filter((e) => !matches(p.filter!, e));
      if (Array.isArray(holder[name]) && (holder[name] as Json[]).length === 0) delete holder[name];
    } else if (subName) {
      if (Array.isArray(cur)) {
        for (const e of cur) if (isObj(e)) delete e[subName];
      } else if (isObj(cur)) delete cur[subName];
    } else if (op === 'remove' && Array.isArray(cur) && o.value !== undefined) {
      const rm = Array.isArray(o.value) ? o.value : [o.value];
      holder[name] = cur.filter((e) => !rm.some((r) => isObj(e) && isObj(r) && e.value === r.value));
      if ((holder[name] as Json[]).length === 0) delete holder[name];
    } else delete holder[name];
    return;
  }
  if (o.value === undefined) throw new ScimError(400, `${op} needs a value`, 'invalidValue');

  if (p.filter) {
    const cur = holder[name];
    if (!def.multi || !Array.isArray(cur)) throw new ScimError(400, `${name} has no values to match`, 'noTarget');
    const hit = cur.map((e, i) => [e, i] as const).filter(([e]) => matches(p.filter!, e));
    if (hit.length === 0) throw new ScimError(400, `nothing in ${name} matches the filter`, 'noTarget');
    for (const [e, i] of hit) {
      if (subName) {
        if (!isObj(e)) continue;
        e[subName] = coerce(subDef!, o.value, `${name}.${subName}`);
        if (subName === 'primary' && e.primary === true) fixPrimary(cur, e);
      } else {
        const v = coerce(def, o.value, name);
        const next = op === 'add' && isObj(e) && isObj(v) ? { ...e, ...v } : v;
        cur[i] = next;
        fixPrimary(cur, next);
      }
    }
    return;
  }
  if (subName) {
    const cur = holder[name];
    const val = coerce(subDef!, o.value, `${name}.${subName}`);
    if (def.multi) throw new ScimError(400, `use a filter to say which ${name} to change`, 'invalidPath');
    (isObj(cur) ? cur : (holder[name] = {}) as { [k: string]: Json })[subName] = val;
    return;
  }
  if (def.multi) {
    const incoming = coerceAttr(def, Array.isArray(o.value) ? o.value : [o.value], name) as Json[];
    if (op === 'replace') {
      holder[name] = incoming;
      const w = [...incoming].reverse().find((e) => isObj(e) && e.primary === true);
      fixPrimary(incoming, w);
    } else {
      const cur = Array.isArray(holder[name]) ? (holder[name] as Json[]) : (holder[name] = []);
      for (const e of incoming) {
        const dup = cur.findIndex((x) => (isObj(x) && isObj(e) && x.value !== undefined ? x.value === e.value && x.type === e.type : sameValue(x, e)));
        if (dup >= 0) cur[dup] = isObj(cur[dup]!) && isObj(e) ? { ...(cur[dup] as object), ...e } as Json : e;
        else cur.push(e);
        fixPrimary(cur, dup >= 0 ? cur[dup] : e);
      }
    }
    return;
  }
  const v = coerce(def, o.value, name);
  holder[name] = def.type === 'complex' && isObj(holder[name]) && isObj(v) ? { ...(holder[name] as object), ...v } as Json : v;
}

/**
 * Applies a PatchOp request body to a resource and returns the new resource; the original is untouched, and
 * if any operation fails none of them apply.
 */
export function applyPatch(kind: Kind, resource: Resource, body: unknown): Resource {
  if (!isObj(body) || !Array.isArray(body.schemas) || !body.schemas.includes(SCHEMA_PATCH)) throw new ScimError(400, `the body must have the schema ${SCHEMA_PATCH}`, 'invalidSyntax');
  const ops = body.Operations;
  if (!Array.isArray(ops) || ops.length === 0) throw new ScimError(400, 'Operations must be a non-empty list', 'invalidSyntax');
  if (ops.length > 1000) throw new ScimError(413, 'too many operations', 'tooMany');
  const res = clone(resource);
  for (const o of ops) {
    if (!isObj(o)) throw new ScimError(400, 'an operation must be an object', 'invalidSyntax');
    applyOne(res, kind, o as unknown as PatchOperation);
  }
  checkPrimary(res);
  return res;
}

// ---------------------------------------------------------------- the server

export interface ScimRequest {
  readonly method: string;
  /** The path under the SCIM base, e.g. "/Users/123". */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
}
export interface ScimResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface ScimOptions {
  /** Public base URL, for meta.location. */
  readonly baseUrl: string;
  readonly now?: () => number;
  /** A fresh unique id (injected so tests are deterministic). */
  readonly newId: () => string;
  readonly maxResults?: number;
  readonly maxBulkOperations?: number;
  readonly maxBulkBytes?: number;
  /** Receives a password from a create or update; it is never stored here. */
  readonly onPassword?: (userId: string, password: string) => void;
  /** Called after any change, for audit and downstream sync. */
  readonly onChange?: (e: { kind: Kind; id: string; action: 'create' | 'update' | 'delete' }) => void;
}

const CT = 'application/scim+json';
const etagOf = (r: Resource) => `W/"${createHash('sha256').update(JSON.stringify(sortKeys(r))).digest('hex').slice(0, 20)}"`;
function sortKeys(v: Json): Json {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k]!)]));
  return v;
}
const iso = (t: number) => new Date(t).toISOString();

export class ScimServer {
  private readonly o: ScimOptions;
  private readonly now: () => number;
  private readonly store: Record<Kind, Map<string, Resource>> = { User: new Map(), Group: new Map() };

  constructor(o: ScimOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  // ------------------------------------------------------------ resource operations

  private location(kind: Kind, id: string) {
    return `${this.o.baseUrl.replace(/\/$/, '')}/${kind}s/${encodeURIComponent(id)}`;
  }

  private stamp(kind: Kind, id: string, body: { [k: string]: Json }, created: string): Resource {
    const base: Resource = { schemas: [kind === 'User' ? SCHEMA_USER : SCHEMA_GROUP, ...(body[SCHEMA_ENTERPRISE] ? [SCHEMA_ENTERPRISE] : [])], id, ...body };
    const withMeta: Resource = { ...base, meta: { resourceType: kind, created, lastModified: iso(this.now()), location: this.location(kind, id) } };
    (withMeta.meta as { [k: string]: Json }).version = etagOf({ ...withMeta, meta: {} });
    return withMeta;
  }

  /** What a client sees: groups derived for users, write-only attributes never present. */
  private view(kind: Kind, r: Resource): Resource {
    const out = clone(r);
    delete out.password;
    if (kind === 'User') {
      const gs = [...this.store.Group.values()].filter((g) => Array.isArray(g.members) && g.members.some((m) => isObj(m) && m.value === r.id));
      if (gs.length) out.groups = gs.map((g) => ({ value: g.id as string, $ref: this.location('Group', g.id as string), display: g.displayName as string, type: 'direct' }));
    }
    return out;
  }

  private uniqueName(kind: Kind, name: string, except?: string) {
    const f = kind === 'User' ? 'userName' : 'displayName';
    for (const r of this.store[kind].values()) if (r.id !== except && typeof r[f] === 'string' && (r[f] as string).toLowerCase() === name.toLowerCase()) throw new ScimError(409, `${f} "${name}" is already in use`, 'uniqueness');
  }

  private checkMembers(body: { [k: string]: Json }) {
    const ms = body.members;
    if (!Array.isArray(ms)) return;
    for (const m of ms) if (isObj(m)) {
      if (typeof m.value !== 'string' || !this.store.User.has(m.value) && !this.store.Group.has(m.value)) throw invalid(`member ${String(m.value)} does not exist`);
    }
    if (new Set(ms.map((m) => (isObj(m) ? m.value : m))).size !== ms.length) throw invalid('a member is listed twice');
  }

  create(kind: Kind, body: unknown): Resource {
    const clean = cleanResource(kind, body);
    this.uniqueName(kind, String(clean[kind === 'User' ? 'userName' : 'displayName']));
    if (typeof clean.externalId === 'string') for (const r of this.store[kind].values()) if (r.externalId === clean.externalId) throw new ScimError(409, `externalId "${clean.externalId}" is already in use`, 'uniqueness');
    if (kind === 'Group') this.checkMembers(clean);
    const id = this.o.newId();
    const pw = clean.password;
    delete clean.password;
    const r = this.stamp(kind, id, clean, iso(this.now()));
    this.store[kind].set(id, r);
    if (typeof pw === 'string') this.o.onPassword?.(id, pw);
    this.o.onChange?.({ kind, id, action: 'create' });
    return this.view(kind, r);
  }

  get(kind: Kind, id: string): Resource {
    const r = this.store[kind].get(id);
    if (!r) throw new ScimError(404, `${kind} ${id} not found`);
    return this.view(kind, r);
  }

  private mustHave(kind: Kind, id: string): Resource {
    const r = this.store[kind].get(id);
    if (!r) throw new ScimError(404, `${kind} ${id} not found`);
    return r;
  }

  private checkVersion(r: Resource, ifMatch: string | undefined) {
    if (ifMatch !== undefined && ifMatch !== '*' && !ifMatch.split(',').map((s) => s.trim()).includes((r.meta as { version: string }).version)) throw new ScimError(412, 'the resource has changed; read it again', 'invalidVers');
  }

  replace(kind: Kind, id: string, body: unknown, ifMatch?: string): Resource {
    const old = this.mustHave(kind, id);
    this.checkVersion(old, ifMatch);
    const clean = cleanResource(kind, body);
    this.uniqueName(kind, String(clean[kind === 'User' ? 'userName' : 'displayName']), id);
    if (kind === 'Group') this.checkMembers(clean);
    const pw = clean.password;
    delete clean.password;
    const next = this.stamp(kind, id, clean, (old.meta as { created: string }).created);
    this.store[kind].set(id, next);
    if (typeof pw === 'string') this.o.onPassword?.(id, pw);
    this.o.onChange?.({ kind, id, action: 'update' });
    return this.view(kind, next);
  }

  patch(kind: Kind, id: string, body: unknown, ifMatch?: string): Resource {
    const old = this.mustHave(kind, id);
    this.checkVersion(old, ifMatch);
    const { id: _i, schemas: _s, meta, ...rest } = applyPatch(kind, old, body);
    void _i; void _s;
    const clean = cleanResource(kind, rest);
    this.uniqueName(kind, String(clean[kind === 'User' ? 'userName' : 'displayName']), id);
    if (kind === 'Group') this.checkMembers(clean);
    const pw = (rest as { password?: Json }).password;
    delete clean.password;
    const next = this.stamp(kind, id, clean, (meta as { created: string }).created);
    this.store[kind].set(id, next);
    if (typeof pw === 'string') this.o.onPassword?.(id, pw);
    this.o.onChange?.({ kind, id, action: 'update' });
    return this.view(kind, next);
  }

  delete(kind: Kind, id: string, ifMatch?: string): void {
    const r = this.mustHave(kind, id);
    this.checkVersion(r, ifMatch);
    this.store[kind].delete(id);
    if (kind === 'User') for (const [gid, g] of this.store.Group) if (Array.isArray(g.members) && g.members.some((m) => isObj(m) && m.value === id)) {
      const next: Resource = { ...g, members: (g.members as Json[]).filter((m) => !(isObj(m) && m.value === id)) };
      if ((next.members as Json[]).length === 0) delete next.members;
      this.store.Group.set(gid, this.stamp('Group', gid, stripSystem(next), (g.meta as { created: string }).created));
    }
    this.o.onChange?.({ kind, id, action: 'delete' });
  }

  list(kind: Kind, q: Readonly<Record<string, string | undefined>> = {}): Resource {
    const max = this.o.maxResults ?? 200;
    const start = q.startIndex === undefined ? 1 : Number(q.startIndex);
    let count = q.count === undefined ? max : Number(q.count);
    if (!Number.isInteger(start) || !Number.isInteger(count) || (q.count !== undefined && !/^\d+$/.test(q.count)) || count < 0) throw new ScimError(400, 'startIndex and count must be whole numbers', 'invalidValue');
    count = Math.min(count, max);
    const filter = q.filter ? parseFilter(q.filter) : undefined;
    let rs = [...this.store[kind].values()].map((r) => this.view(kind, r));
    if (filter) rs = rs.filter((r) => matches(filter, r));
    if (q.sortBy) {
      const path = splitPath(q.sortBy);
      const dir = (q.sortOrder ?? 'ascending').toLowerCase() === 'descending' ? -1 : 1;
      if (q.sortOrder && !/^(ascending|descending)$/i.test(q.sortOrder)) throw new ScimError(400, 'sortOrder must be ascending or descending', 'invalidValue');
      const key = (r: Resource) => { const v = valuesAt(r, path)[0]; return typeof v === 'string' ? v.toLowerCase() : (v as number | undefined); };
      rs.sort((a, b) => { const x = key(a), y = key(b); return x === y ? 0 : x === undefined ? 1 : y === undefined ? -1 : x < y ? -dir : dir; });
    }
    const total = rs.length;
    const page = rs.slice(Math.max(1, start) - 1, Math.max(1, start) - 1 + count).map((r) => project(r, q.attributes, q.excludedAttributes));
    return { schemas: [SCHEMA_LIST], totalResults: total, startIndex: Math.max(1, start), itemsPerPage: page.length, Resources: page };
  }

  // ------------------------------------------------------------ HTTP-shaped entry

  handle(req: ScimRequest): ScimResponse {
    try {
      return this.route(req);
    } catch (e) {
      if (e instanceof ScimError) return { status: e.status, headers: { 'content-type': CT }, body: e.toBody() };
      throw e;
    }
  }

  private respond(status: number, r: Resource, extra: Record<string, string> = {}): ScimResponse {
    const meta = r.meta as { version?: string; location?: string } | undefined;
    return { status, headers: { 'content-type': CT, ...(meta?.version ? { etag: meta.version } : {}), ...(status === 201 && meta?.location ? { location: meta.location } : {}), ...extra }, body: r };
  }

  private route(req: ScimRequest): ScimResponse {
    const m = req.method.toUpperCase();
    const h = (n: string) => Object.entries(req.headers ?? {}).find(([k]) => k.toLowerCase() === n)?.[1];
    const parts = req.path.replace(/^\/+|\/+$/g, '').split('/').map((x) => { try { return decodeURIComponent(x); } catch { throw new ScimError(400, 'bad path', 'invalidSyntax'); } });
    const [coll, id] = parts;
    if (parts.length > 2) throw new ScimError(404, 'no such endpoint');
    if (coll === 'ServiceProviderConfig' && m === 'GET') return { status: 200, headers: { 'content-type': CT }, body: this.serviceProviderConfig() };
    if (coll === 'ResourceTypes' && m === 'GET') return { status: 200, headers: { 'content-type': CT }, body: resourceTypes(this.o.baseUrl) };
    if (coll === 'Schemas' && m === 'GET') return { status: 200, headers: { 'content-type': CT }, body: { schemas: [SCHEMA_LIST], totalResults: 3, Resources: [SCHEMA_USER, SCHEMA_GROUP, SCHEMA_ENTERPRISE].map((i) => ({ id: i, name: i.split(':').pop() })) } };
    if (coll === 'Bulk' && m === 'POST' && !id) return { status: 200, headers: { 'content-type': CT }, body: this.bulk(req.body, JSON.stringify(req.body ?? '').length) };
    const kind: Kind | undefined = coll === 'Users' ? 'User' : coll === 'Groups' ? 'Group' : undefined;
    if (!kind) throw new ScimError(404, 'no such endpoint');
    if (!id) {
      if (m === 'GET') return { status: 200, headers: { 'content-type': CT }, body: this.list(kind, req.query) };
      if (m === 'POST') return this.respond(201, this.create(kind, req.body));
      throw new ScimError(405, `${m} is not allowed here`);
    }
    if (m === 'GET') {
      const r = this.get(kind, id);
      const inm = h('if-none-match');
      if (inm !== undefined && (inm === '*' || inm.split(',').map((s) => s.trim()).includes((r.meta as { version: string }).version))) return { status: 304, headers: { etag: (r.meta as { version: string }).version } };
      return this.respond(200, project(r, req.query?.attributes, req.query?.excludedAttributes));
    }
    if (m === 'PUT') return this.respond(200, this.replace(kind, id, req.body, h('if-match')));
    if (m === 'PATCH') return this.respond(200, this.patch(kind, id, req.body, h('if-match')));
    if (m === 'DELETE') { this.delete(kind, id, h('if-match')); return { status: 204, headers: {} }; }
    throw new ScimError(405, `${m} is not allowed here`);
  }

  // ------------------------------------------------------------ bulk (RFC 7644 3.7)

  private bulk(body: unknown, size: number): Resource {
    if (!isObj(body) || !Array.isArray(body.schemas) || !body.schemas.includes(SCHEMA_BULK_REQUEST) || !Array.isArray(body.Operations)) throw new ScimError(400, `the body must have the schema ${SCHEMA_BULK_REQUEST} and Operations`, 'invalidSyntax');
    const maxOps = this.o.maxBulkOperations ?? 100;
    const maxBytes = this.o.maxBulkBytes ?? 1_048_576;
    if (body.Operations.length > maxOps) throw new ScimError(413, `at most ${maxOps} operations in one request`, 'tooMany');
    if (size > maxBytes) throw new ScimError(413, `a bulk request may be at most ${maxBytes} bytes`, 'tooMany');
    const failOn = body.failOnErrors === undefined ? Infinity : Number(body.failOnErrors);
    const ids = new Map<string, string>();
    const out: Json[] = [];
    let errors = 0;
    const resolve = (v: Json): Json => {
      if (typeof v === 'string' && v.startsWith('bulkId:')) {
        const real = ids.get(v.slice(7));
        if (!real) throw invalid(`the bulkId ${v.slice(7)} has not been created earlier in this request`);
        return real;
      }
      if (Array.isArray(v)) return v.map(resolve);
      if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
      return v;
    };
    for (const raw of body.Operations) {
      if (errors >= failOn) break;
      const op = raw as { [k: string]: Json };
      const rec: { [k: string]: Json } = { method: String(op.method ?? ''), ...(typeof op.bulkId === 'string' ? { bulkId: op.bulkId } : {}) };
      try {
        const method = String(op.method).toUpperCase();
        const path = String(op.path ?? '').replace(/bulkId:([^/]+)/g, (_, b: string) => { const real = ids.get(b); if (!real) throw invalid(`the bulkId ${b} has not been created earlier in this request`); return real; });
        if (method === 'POST' && typeof op.bulkId !== 'string') throw new ScimError(400, 'a POST in a bulk request needs a bulkId', 'invalidValue');
        const res = this.route({ method, path, ...(op.data === undefined ? {} : { body: resolve(op.data) }), ...(typeof op.version === 'string' ? { headers: { 'if-match': op.version } } : {}) });
        rec.status = String(res.status);
        const loc = (res.body as Resource | undefined)?.meta;
        if (isObj(loc) && typeof loc.location === 'string') rec.location = loc.location;
        if (method === 'POST' && typeof op.bulkId === 'string' && isObj(res.body) && typeof res.body.id === 'string') ids.set(op.bulkId, res.body.id);
        if (res.headers.etag) rec.version = res.headers.etag;
      } catch (e) {
        if (!(e instanceof ScimError)) throw e;
        errors++;
        rec.status = String(e.status);
        rec.response = e.toBody() as unknown as Json;
      }
      out.push(rec);
    }
    return { schemas: [SCHEMA_BULK_RESPONSE], Operations: out };
  }

  private serviceProviderConfig(): Resource {
    return {
      schemas: [SCHEMA_SPC],
      patch: { supported: true },
      bulk: { supported: true, maxOperations: this.o.maxBulkOperations ?? 100, maxPayloadSize: this.o.maxBulkBytes ?? 1_048_576 },
      filter: { supported: true, maxResults: this.o.maxResults ?? 200 },
      changePassword: { supported: false },
      sort: { supported: true },
      etag: { supported: true },
      authenticationSchemes: [{ type: 'oauthbearertoken', name: 'OAuth Bearer Token', description: 'Authentication by a bearer token' }],
    };
  }
}

function stripSystem(r: Resource): { [k: string]: Json } {
  const { id: _i, schemas: _s, meta: _m, ...rest } = r;
  void _i; void _s; void _m;
  return rest;
}

function resourceTypes(base: string): Resource {
  const b = base.replace(/\/$/, '');
  return {
    schemas: [SCHEMA_LIST], totalResults: 2,
    Resources: [
      { id: 'User', name: 'User', endpoint: '/Users', schema: SCHEMA_USER, schemaExtensions: [{ schema: SCHEMA_ENTERPRISE, required: false }], meta: { resourceType: 'ResourceType', location: `${b}/ResourceTypes/User` } },
      { id: 'Group', name: 'Group', endpoint: '/Groups', schema: SCHEMA_GROUP, meta: { resourceType: 'ResourceType', location: `${b}/ResourceTypes/Group` } },
    ],
  };
}

/** `attributes` keeps only the named top-level attributes (and always id and schemas); `excludedAttributes` drops some. */
function project(r: Resource, attributes: string | undefined, excluded: string | undefined): Resource {
  if (!attributes && !excluded) return r;
  const out: Resource = {};
  const want = attributes ? new Set(attributes.split(',').map((x) => x.trim().toLowerCase().split('.')[0]!)) : undefined;
  const drop = new Set((excluded ?? '').split(',').map((x) => x.trim().toLowerCase()));
  for (const [k, v] of Object.entries(r)) {
    const l = k.toLowerCase();
    if (l === 'id' || l === 'schemas') { out[k] = v; continue; }
    if (want ? want.has(l) : !drop.has(l)) out[k] = v;
  }
  return out;
}
