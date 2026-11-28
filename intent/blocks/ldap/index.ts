/**
 * LDAP the way an application uses it, over a directory model held in memory (the same code can sit in front of a
 * real server's results). Holds: distinguished names (RFC 4514: escapes, hex pairs, multi-valued RDNs, #hex values)
 * parsed, normalised, compared, and built with escaping so a user name can never change the shape of a DN; search
 * filters (RFC 4515) parsed to a tree and evaluated with the three-valued logic of RFC 4511 (equality, substring,
 * ordering, approximate, presence, and extensible match with :dn, the Active Directory bit rules 1.2.840.113556.1.4.803
 * and .804 and the in-chain rule .1941 for nested groups), with escaping for values put into filters; a directory
 * with add, modify, delete and search by base, one level or subtree, size limits, attribute selection that never
 * returns userPassword, and paged results (RFC 2696) whose cookie belongs to one query; simple bind with {SSHA},
 * {SSHA256}, {SSHA512}, {SHA} and cleartext values compared in constant time, where an empty password is refused
 * (never read as an anonymous bind), a wrong password and a missing user look the same, and repeated failures lock
 * the account for a while; attribute mapping from entries to application users with required fields; group
 * membership resolved through nesting with cycle protection and mapped to roles; and a user sync plan (create,
 * update, disable) that refuses to disable most of the users at once, the sign of a broken query. Hostile input is
 * limited: filter and DN length and depth, and result counts. Not here: the LDAP wire protocol (BER), TLS and
 * SASL, referrals, schema checking beyond objectClass, and server-side sorting.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export class LdapError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export const RC = { success: 0, operationsError: 1, protocolError: 2, timeLimitExceeded: 3, sizeLimitExceeded: 4, noSuchAttribute: 16, noSuchObject: 32, invalidDNSyntax: 34, invalidCredentials: 49, insufficientAccess: 50, busy: 51, unwillingToPerform: 53, notAllowedOnNonLeaf: 66, entryAlreadyExists: 68, other: 80 } as const;

// ---------------------------------------------------------------- DNs

export interface Ava {
  readonly type: string;
  /** The value, unescaped. */
  readonly value: string;
  /** The value was written as #hex (a BER value): kept as that hex, compared as bytes. */
  readonly hex?: boolean;
}
export type Rdn = readonly Ava[];

const MAX_DN = 2048;
const SPECIAL = new Set([',', '+', '"', '\\', '<', '>', ';', '=', ' ', '#']);

/** Reads a DN (RFC 4514). The empty string is the root DSE, an empty list. Throws LdapError(invalidDNSyntax). */
export function parseDn(s: string): Rdn[] {
  const bad = (why: string): never => {
    throw new LdapError(RC.invalidDNSyntax, `bad DN ${JSON.stringify(s.slice(0, 60))}: ${why}`);
  };
  if (s.length > MAX_DN) bad(`longer than ${MAX_DN}`);
  if (s === '') return [];
  const rdns: Ava[][] = [];
  let i = 0;
  const n = s.length;
  for (;;) {
    const avas: Ava[] = [];
    for (;;) {
      while (s[i] === ' ') i++;
      const tm = /^(?:[A-Za-z][A-Za-z0-9-]*|\d+(?:\.\d+)*)/.exec(s.slice(i));
      if (!tm) bad(`expected an attribute name at position ${i}`);
      const type = tm![0];
      i += type.length;
      if (s[i] !== '=') bad(`expected "=" after ${type}`);
      i++;
      let value = '';
      let hex = false;
      if (s[i] === '#') {
        const hm = /^#((?:[0-9A-Fa-f]{2})+)/.exec(s.slice(i));
        if (!hm) bad('a #value must be hex digits in pairs');
        value = hm![1]!.toLowerCase();
        hex = true;
        i += 1 + hm![1]!.length;
      } else {
        const bytes: number[] = [];
        const flush = () => {
          if (bytes.length) {
            const d = new TextDecoder('utf-8', { fatal: true });
            try {
              value += d.decode(Buffer.from(bytes));
            } catch {
              bad('escaped bytes are not valid UTF-8');
            }
            bytes.length = 0;
          }
        };
        let trailingSpaces = 0;
        while (i < n && s[i] !== ',' && s[i] !== '+') {
          const c = s[i]!;
          if (c === '\\') {
            const nx = s[i + 1];
            if (nx === undefined) bad('ends with a backslash');
            if (/^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
              bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
              i += 3;
              trailingSpaces = 0;
              continue;
            }
            if (!SPECIAL.has(nx!)) bad(`"\\${nx}" is not an escape`);
            flush();
            value += nx;
            i += 2;
            trailingSpaces = 0;
            continue;
          }
          flush();
          if (c === '"' || c === '<' || c === '>' || c === ';' || c === '\u0000') bad(`"${c === '\u0000' ? 'NUL' : c}" must be escaped`);
          value += c;
          trailingSpaces = c === ' ' ? trailingSpaces + 1 : 0;
          i++;
        }
        flush();
        if (trailingSpaces) value = value.slice(0, -trailingSpaces);
      }
      avas.push({ type, value, ...(hex ? { hex } : {}) });
      if (s[i] === '+') {
        i++;
        continue;
      }
      break;
    }
    rdns.push(avas);
    if (i >= n) break;
    // s[i] is ","
    i++;
    if (i >= n) bad('ends with a comma');
  }
  if (rdns.length > 64) bad('too many parts');
  return rdns;
}

/** Escapes a value for use in a DN (RFC 4514 section 2.4): the one safe way to put a user's text into a DN. */
export function escapeDnValue(v: string): string {
  let out = v.replace(/[\\,+"<>;=]/g, (c) => `\\${c}`).replace(/\u0000/g, '\\00');
  if (out.startsWith(' ') || out.startsWith('#')) out = `\\${out}`;
  if (out.endsWith(' ') && !out.endsWith('\\ ')) out = `${out.slice(0, -1)}\\ `;
  return out;
}

const avaOut = (a: Ava) => `${a.type}=${a.hex ? `#${a.value}` : escapeDnValue(a.value)}`;
export const formatDn = (rdns: readonly Rdn[]): string => rdns.map((r) => r.map(avaOut).join('+')).join(',');

const foldValue = (v: string) => v.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

/** The canonical form for comparing DNs: type names lower-cased, values folded, multi-valued RDN parts sorted. */
export function normalizeDn(s: string | readonly Rdn[]): string {
  const rdns = typeof s === 'string' ? parseDn(s) : s;
  return rdns.map((r) => [...r].map((a) => `${a.type.toLowerCase()}=${a.hex ? `#${a.value}` : escapeDnValue(foldValue(a.value))}`).sort().join('+')).join(',');
}

export const dnEquals = (a: string, b: string): boolean => normalizeDn(a) === normalizeDn(b);

/** The DN of the entry's parent, or null for a one-part DN or the root. */
export function parentDn(s: string): string | null {
  const r = parseDn(s);
  return r.length <= 1 ? null : formatDn(r.slice(1));
}

/** Whether `dn` is below `base` (or equal to it when `orSelf`). Compared on parsed, normalised parts, never as text. */
export function isUnder(dn: string, base: string, orSelf = true): boolean {
  const d = normalizeDn(dn).split(/(?<!\\),/);
  const b = base === '' ? [] : normalizeDn(base).split(/(?<!\\),/);
  if (d.length < b.length + (orSelf ? 0 : 1)) return false;
  return b.every((p, i) => d[d.length - b.length + i] === p);
}

/** The value of the first attribute of the entry's own RDN of a given type ("cn" from "cn=Ana,ou=x"). */
export function rdnValue(dn: string, type: string): string | undefined {
  return parseDn(dn)[0]?.find((a) => a.type.toLowerCase() === type.toLowerCase())?.value;
}

// ---------------------------------------------------------------- filters

export type Filter =
  | { readonly op: 'and' | 'or'; readonly items: readonly Filter[] }
  | { readonly op: 'not'; readonly item: Filter }
  | { readonly op: 'eq' | 'ge' | 'le' | 'approx'; readonly attr: string; readonly value: string }
  | { readonly op: 'present'; readonly attr: string }
  | { readonly op: 'substr'; readonly attr: string; readonly initial?: string; readonly any: readonly string[]; readonly final?: string }
  | { readonly op: 'ext'; readonly attr?: string; readonly rule?: string; readonly dn: boolean; readonly value: string };

const MAX_FILTER = 4096;
const MAX_FILTER_DEPTH = 20;
const MAX_FILTER_ITEMS = 200;

/** Escapes a value for use inside a filter (RFC 4515): the one safe way to put a user's text into a filter. */
export function escapeFilterValue(v: string): string {
  return v.replace(/[\\*()\u0000]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** A filter built from a template where each ${} is escaped: filter`(&(uid=${name})(objectClass=person))`. */
export function filterTemplate(parts: TemplateStringsArray, ...values: readonly unknown[]): string {
  return parts.reduce((acc, p, i) => acc + p + (i < values.length ? escapeFilterValue(String(values[i])) : ''), '');
}

function unescapeValue(raw: string, bad: (m: string) => never): string {
  if (/[()\u0000]/.test(raw)) bad('an unescaped ( ) or NUL in a value');
  const bytes: number[] = [];
  let out = '';
  const flush = () => {
    if (bytes.length) {
      try {
        out += new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bytes));
      } catch {
        bad('escaped bytes in a value are not valid UTF-8');
      }
      bytes.length = 0;
    }
  };
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\') {
      if (!/^[0-9A-Fa-f]{2}$/.test(raw.slice(i + 1, i + 3))) bad('a backslash must be followed by two hex digits');
      bytes.push(parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      flush();
      out += raw[i];
    }
  }
  flush();
  return out;
}

/** Reads a filter string (RFC 4515). Throws LdapError(protocolError) with the position of the problem. */
export function parseFilter(s: string): Filter {
  const bad = (m: string, at = 0): never => {
    throw new LdapError(RC.protocolError, `bad filter ${JSON.stringify(s.slice(0, 80))}: ${m}${at ? ` (at ${at})` : ''}`);
  };
  if (s.length > MAX_FILTER) bad(`longer than ${MAX_FILTER}`);
  let i = 0;
  let items = 0;
  const filter = (depth: number): Filter => {
    if (depth > MAX_FILTER_DEPTH) bad(`nested more than ${MAX_FILTER_DEPTH} deep`, i);
    if (s[i] !== '(') bad('expected "("', i);
    i++;
    let f: Filter;
    const c = s[i];
    if (c === '&' || c === '|') {
      i++;
      const list: Filter[] = [];
      while (s[i] === '(') list.push(filter(depth + 1));
      if (!list.length) bad('an empty & or | list', i);
      f = { op: c === '&' ? 'and' : 'or', items: list };
    } else if (c === '!') {
      i++;
      f = { op: 'not', item: filter(depth + 1) };
    } else {
      if (++items > MAX_FILTER_ITEMS) bad(`more than ${MAX_FILTER_ITEMS} conditions`, i);
      let j = i;
      let depthParen = 0;
      while (j < s.length && !(s[j] === ')' && depthParen === 0)) {
        if (s[j] === '(') bad('an unescaped "(" in an item', j);
        if (s[j] === '\\') j++;
        j++;
      }
      if (j >= s.length) bad('missing ")"', j);
      const item = s.slice(i, j);
      i = j;
      f = parseItem(item, bad);
    }
    if (s[i] !== ')') bad('expected ")"', i);
    i++;
    return f;
  };
  const f = filter(0);
  if (i !== s.length) bad('something follows the filter', i);
  return f;
}

function parseItem(item: string, bad: (m: string, at?: number) => never): Filter {
  const ext = /^(?:([A-Za-z][A-Za-z0-9-]*|\d+(?:\.\d+)*))?(:dn)?(?::([A-Za-z][A-Za-z0-9-]*|\d+(?:\.\d+)*))?:=([\s\S]*)$/.exec(item);
  if (ext && (ext[2] || ext[3] || item.includes(':='))) {
    if (!ext[1] && !ext[3]) bad('an extensible match needs an attribute or a rule');
    return { op: 'ext', ...(ext[1] ? { attr: ext[1] } : {}), ...(ext[3] ? { rule: ext[3] } : {}), dn: !!ext[2], value: unescapeValue(ext[4]!, bad) };
  }
  const m = /^([A-Za-z][A-Za-z0-9-]*(?:;[A-Za-z0-9-]+)*|\d+(?:\.\d+)*)(~=|>=|<=|=)([\s\S]*)$/.exec(item);
  if (!m) return bad(`"${item.slice(0, 30)}" is not attribute=value`);
  const [, attr, op, raw] = m as unknown as [string, string, string, string];
  if (op === '=') {
    if (raw === '*') return { op: 'present', attr };
    if (/(?<!\\)\*/.test(raw)) {
      const segs = raw.split(/(?<!\\)\*/);
      const un = (x: string) => unescapeValue(x, bad);
      const initial = segs[0]!;
      const fin = segs[segs.length - 1]!;
      const any = segs.slice(1, -1).filter((x) => x !== '');
      return { op: 'substr', attr, ...(initial ? { initial: un(initial) } : {}), any: any.map(un), ...(fin ? { final: un(fin) } : {}) };
    }
    return { op: 'eq', attr, value: unescapeValue(raw, bad) };
  }
  if (/(?<!\\)\*/.test(raw)) bad('"*" only means anything with "="');
  return { op: op === '~=' ? 'approx' : op === '>=' ? 'ge' : 'le', attr, value: unescapeValue(raw, bad) };
}

/** A filter back to its string form, escaped. parseFilter(formatFilter(f)) is f. */
export function formatFilter(f: Filter): string {
  switch (f.op) {
    case 'and': return `(&${f.items.map(formatFilter).join('')})`;
    case 'or': return `(|${f.items.map(formatFilter).join('')})`;
    case 'not': return `(!${formatFilter(f.item)})`;
    case 'present': return `(${f.attr}=*)`;
    case 'eq': return `(${f.attr}=${escapeFilterValue(f.value)})`;
    case 'ge': return `(${f.attr}>=${escapeFilterValue(f.value)})`;
    case 'le': return `(${f.attr}<=${escapeFilterValue(f.value)})`;
    case 'approx': return `(${f.attr}~=${escapeFilterValue(f.value)})`;
    case 'substr': return `(${f.attr}=${f.initial ? escapeFilterValue(f.initial) : ''}*${f.any.map((a) => `${escapeFilterValue(a)}*`).join('')}${f.final ? escapeFilterValue(f.final) : ''})`;
    case 'ext': return `(${f.attr ?? ''}${f.dn ? ':dn' : ''}${f.rule ? `:${f.rule}` : ''}:=${escapeFilterValue(f.value)})`;
  }
}

// ---------------------------------------------------------------- directory and evaluation

export interface Entry {
  readonly dn: string;
  /** Attribute names as written, with their values. */
  readonly attrs: Readonly<Record<string, readonly string[]>>;
}

interface Stored {
  dn: string;
  norm: string;
  attrs: Map<string, { name: string; values: string[] }>;
}

type Tri = true | false | undefined;
const and3 = (xs: Tri[]): Tri => (xs.includes(false) ? false : xs.includes(undefined) ? undefined : true);
const or3 = (xs: Tri[]): Tri => (xs.includes(true) ? true : xs.includes(undefined) ? undefined : false);
const not3 = (x: Tri): Tri => (x === undefined ? undefined : !x);

/** Attributes whose values are DNs, compared as DNs. */
const DN_ATTRS = new Set(['member', 'uniquemember', 'memberof', 'owner', 'manager', 'seealso', 'roleoccupant', 'distinguishedname', 'creatorsname', 'modifiersname']);
const EXACT_ATTRS = new Set(['userpassword', 'objectguid', 'objectsid', 'entryuuid']);

const BIT_AND = '1.2.840.113556.1.4.803';
const BIT_OR = '1.2.840.113556.1.4.804';
const IN_CHAIN = '1.2.840.113556.1.4.1941';

export interface DirectoryOptions {
  /** The naming contexts: entries directly under no parent are allowed only at these. */
  readonly suffixes: readonly string[];
  /** Attribute names the schema knows; with it, a filter on any other is Undefined (no match, and not negatable). Absent: all known. */
  readonly knownAttributes?: readonly string[];
  readonly now?: () => number;
  readonly bind?: { readonly maxFailures: number; readonly lockMs: number; readonly windowMs: number };
  /** Return userPassword to searches. Never by default. */
  readonly exposePasswords?: boolean;
}

export interface SearchOptions {
  readonly scope?: 'base' | 'one' | 'sub';
  readonly attrs?: readonly string[];
  readonly sizeLimit?: number;
  /** Paged results (RFC 2696): the page size and the cookie from the previous page. */
  readonly pageSize?: number;
  readonly cookie?: string;
}

export interface SearchResult {
  readonly entries: Entry[];
  readonly code: number;
  /** Present when more pages remain. */
  readonly cookie?: string;
}

const MAX_RESULTS = 100_000;

export class Directory {
  private readonly byNorm = new Map<string, Stored>();
  private readonly suffixes: Set<string>;
  private readonly known: ReadonlySet<string> | undefined;
  private readonly now: () => number;
  private readonly o: DirectoryOptions;
  private readonly failures = new Map<string, { at: number[]; lockedUntil: number }>();
  private readonly cookieKey = randomBytes(16).toString('hex');

  constructor(o: DirectoryOptions) {
    this.o = o;
    this.suffixes = new Set(o.suffixes.map((s) => normalizeDn(s)));
    this.known = o.knownAttributes ? new Set(o.knownAttributes.map((a) => a.toLowerCase())) : undefined;
    this.now = o.now ?? Date.now;
  }

  get size(): number {
    return this.byNorm.size;
  }

  add(dn: string, attrs: Readonly<Record<string, string | readonly string[]>>): void {
    const norm = normalizeDn(dn);
    if (this.byNorm.has(norm)) throw new LdapError(RC.entryAlreadyExists, `${dn} already exists`);
    const parent = parentDn(dn);
    if (!this.suffixes.has(norm) && (parent === null || !this.byNorm.has(normalizeDn(parent)))) throw new LdapError(RC.noSuchObject, `the parent of ${dn} does not exist`);
    const m = new Map<string, { name: string; values: string[] }>();
    for (const [k, v] of Object.entries(attrs)) {
      const lk = k.toLowerCase();
      if (m.has(lk)) throw new LdapError(RC.protocolError, `${k} is given twice`);
      m.set(lk, { name: k, values: typeof v === 'string' ? [v] : [...v] });
    }
    if (!m.has('objectclass')) throw new LdapError(RC.other, 'an entry needs an objectClass');
    this.byNorm.set(norm, { dn, norm, attrs: m });
  }

  delete(dn: string): void {
    const norm = normalizeDn(dn);
    if (!this.byNorm.has(norm)) throw new LdapError(RC.noSuchObject, `${dn} does not exist`);
    for (const o of this.byNorm.values()) if (o.norm !== norm && isUnder(o.dn, dn, false)) throw new LdapError(RC.notAllowedOnNonLeaf, `${dn} has entries below it`);
    this.byNorm.delete(norm);
  }

  modify(dn: string, changes: readonly { op: 'add' | 'replace' | 'delete'; attr: string; values?: readonly string[] }[]): void {
    const e = this.byNorm.get(normalizeDn(dn));
    if (!e) throw new LdapError(RC.noSuchObject, `${dn} does not exist`);
    for (const c of changes) {
      const lk = c.attr.toLowerCase();
      const cur = e.attrs.get(lk);
      if (c.op === 'add') e.attrs.set(lk, { name: cur?.name ?? c.attr, values: [...(cur?.values ?? []), ...(c.values ?? [])] });
      else if (c.op === 'replace') {
        if (c.values?.length) e.attrs.set(lk, { name: cur?.name ?? c.attr, values: [...c.values] });
        else e.attrs.delete(lk);
      } else if (!cur) throw new LdapError(RC.noSuchAttribute, `${dn} has no ${c.attr}`);
      else if (c.values?.length) {
        const left = cur.values.filter((v) => !c.values!.some((x) => this.valuesEqual(lk, v, x)));
        if (left.length) cur.values = left;
        else e.attrs.delete(lk);
      } else e.attrs.delete(lk);
    }
    if (!e.attrs.has('objectclass')) throw new LdapError(RC.other, 'an entry needs an objectClass');
  }

  get(dn: string): Entry | undefined {
    const e = this.byNorm.get(normalizeDn(dn));
    return e && this.view(e, ['*']);
  }

  private view(e: Stored, want: readonly string[] | undefined): Entry {
    const all = !want || want.length === 0 || want.includes('*');
    const out: Record<string, readonly string[]> = {};
    if (want?.includes('1.1')) return { dn: e.dn, attrs: {} };
    for (const [lk, a] of e.attrs) {
      if (lk === 'userpassword' && !this.o.exposePasswords) continue;
      if (all || want!.some((w) => w.toLowerCase() === lk)) out[a.name] = [...a.values];
    }
    return { dn: e.dn, attrs: out };
  }

  private valuesEqual(lk: string, a: string, b: string): boolean {
    if (DN_ATTRS.has(lk)) {
      try {
        return normalizeDn(a) === normalizeDn(b);
      } catch {
        return false;
      }
    }
    if (EXACT_ATTRS.has(lk)) return a === b;
    return foldValue(a) === foldValue(b);
  }

  private values(e: Stored, attr: string): string[] | undefined {
    const base = attr.split(';')[0]!.toLowerCase();
    if (this.known && !this.known.has(base) && base !== 'objectclass') return undefined;
    return e.attrs.get(base)?.values ?? [];
  }

  /** Entries that list `dn` as a member (directly), by member and uniqueMember, for group walks. */
  private groupsDirect(dn: string): Stored[] {
    const n = normalizeDn(dn);
    const out: Stored[] = [];
    for (const g of this.byNorm.values()) {
      for (const lk of ['member', 'uniquemember']) if (g.attrs.get(lk)?.values.some((v) => this.safeNorm(v) === n)) out.push(g);
    }
    return out;
  }

  private safeNorm(v: string): string | undefined {
    try {
      return normalizeDn(v);
    } catch {
      return undefined;
    }
  }

  /** The groups an entry belongs to, through nesting, with cycles stopped. */
  inChain(dn: string, maxDepth = 16): Set<string> {
    const seen = new Set<string>();
    const walk = (d: string, depth: number) => {
      if (depth > maxDepth) return;
      for (const g of this.groupsDirect(d)) {
        if (seen.has(g.norm)) continue;
        seen.add(g.norm);
        walk(g.dn, depth + 1);
      }
    };
    walk(dn, 0);
    return seen;
  }

  private evalItem(f: Filter, e: Stored): Tri {
    switch (f.op) {
      case 'and': return and3(f.items.map((x) => this.evalItem(x, e)));
      case 'or': return or3(f.items.map((x) => this.evalItem(x, e)));
      case 'not': return not3(this.evalItem(f.item, e));
      case 'present': {
        const v = this.values(e, f.attr);
        return v === undefined ? undefined : v.length > 0;
      }
      case 'eq': {
        const v = this.values(e, f.attr);
        if (v === undefined) return undefined;
        const lk = f.attr.split(';')[0]!.toLowerCase();
        if (lk === 'objectclass') return v.some((x) => foldValue(x) === foldValue(f.value));
        return v.some((x) => this.valuesEqual(lk, x, f.value));
      }
      case 'approx': {
        const v = this.values(e, f.attr);
        if (v === undefined) return undefined;
        const k = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        return v.some((x) => k(x) === k(f.value));
      }
      case 'ge':
      case 'le': {
        const v = this.values(e, f.attr);
        if (v === undefined) return undefined;
        const num = /^-?\d+$/.test(f.value);
        return v.some((x) => {
          const c = num && /^-?\d+$/.test(x) ? Number(x) - Number(f.value) : foldValue(x) < foldValue(f.value) ? -1 : foldValue(x) > foldValue(f.value) ? 1 : 0;
          return f.op === 'ge' ? c >= 0 : c <= 0;
        });
      }
      case 'substr': {
        const v = this.values(e, f.attr);
        if (v === undefined) return undefined;
        return v.some((x0) => {
          let x = foldValue(x0);
          if (f.initial !== undefined) {
            const p = foldValue(f.initial);
            if (!x.startsWith(p)) return false;
            x = x.slice(p.length);
          }
          const fin = f.final !== undefined ? foldValue(f.final) : undefined;
          if (fin !== undefined && !x.endsWith(fin)) return false;
          if (fin !== undefined) x = x.slice(0, x.length - fin.length);
          for (const a of f.any) {
            const at = x.indexOf(foldValue(a));
            if (at < 0) return false;
            x = x.slice(at + foldValue(a).length);
          }
          return true;
        });
      }
      case 'ext': {
        if (f.rule === IN_CHAIN) {
          // Is the entry named by the value in the chain of groups of this entry's attribute (memberOf-like)?
          if (!f.attr) return undefined;
          const lk = f.attr.toLowerCase();
          if (lk === 'memberof') return this.inChain(e.dn).has(this.safeNorm(f.value) ?? '\u0000');
          if (lk === 'member') return this.inChain(f.value).has(e.norm);
          return undefined;
        }
        if (f.rule === BIT_AND || f.rule === BIT_OR) {
          const v = f.attr ? this.values(e, f.attr) : undefined;
          if (v === undefined || !/^\d+$/.test(f.value)) return undefined;
          const want = BigInt(f.value);
          return v.some((x) => /^-?\d+$/.test(x) && (f.rule === BIT_AND ? (BigInt(x) & want) === want : (BigInt(x) & want) !== 0n));
        }
        if (f.rule && !['caseIgnoreMatch', 'caseExactMatch', 'distinguishedNameMatch'].includes(f.rule)) return undefined;
        const exact = f.rule === 'caseExactMatch';
        const test = (vals: string[] | undefined): Tri => (vals === undefined ? undefined : vals.some((x) => (exact ? x === f.value : foldValue(x) === foldValue(f.value))));
        if (f.attr) {
          const r = test(this.values(e, f.attr));
          if (r || !f.dn) return r;
        } else if (!f.dn) {
          return or3([...e.attrs.keys()].map((k) => test(e.attrs.get(k)!.values)));
        }
        // :dn also looks at the attributes in the entry's DN.
        return parseDn(e.dn).flat().some((a) => (!f.attr || a.type.toLowerCase() === f.attr.toLowerCase()) && (exact ? a.value === f.value : foldValue(a.value) === foldValue(f.value)));
      }
    }
  }

  /** Whether an entry matches a filter (the result Undefined counts as no match). */
  matches(e: Entry, filter: string | Filter): boolean {
    const s = this.byNorm.get(normalizeDn(e.dn));
    if (!s) return false;
    return this.evalItem(typeof filter === 'string' ? parseFilter(filter) : filter, s) === true;
  }

  /** Searches under a base. Entries come in DN order so pages are stable. A missing base is noSuchObject. */
  search(base: string, filter: string | Filter, o: SearchOptions = {}): SearchResult {
    const f = typeof filter === 'string' ? parseFilter(filter) : filter;
    const baseNorm = normalizeDn(base);
    if (base !== '' && !this.byNorm.has(baseNorm)) throw new LdapError(RC.noSuchObject, `the search base ${base} does not exist`);
    const scope = o.scope ?? 'sub';
    const sizeLimit = Math.min(o.sizeLimit ?? MAX_RESULTS, MAX_RESULTS);
    const sig = createHash('sha256').update(JSON.stringify([baseNorm, formatFilter(f), scope, o.attrs ?? null, this.cookieKey])).digest('hex').slice(0, 16);
    let after = '';
    if (o.cookie !== undefined) {
      let c: { s?: string; after?: string };
      try {
        c = JSON.parse(Buffer.from(o.cookie, 'base64url').toString());
      } catch {
        throw new LdapError(RC.protocolError, 'the paging cookie is not valid');
      }
      if (c.s !== sig || typeof c.after !== 'string') throw new LdapError(RC.protocolError, 'the paging cookie belongs to a different search');
      after = c.after;
    }
    const sorted = [...this.byNorm.values()].filter((e) => e.norm > after || o.cookie === undefined).sort((a, b) => (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0));
    const out: Entry[] = [];
    let code: number = RC.success;
    let last = '';
    let more = false;
    const pageSize = o.pageSize;
    for (const e of sorted) {
      const inScope = scope === 'base' ? e.norm === baseNorm : scope === 'one' ? parentOf(e) === baseNorm : base === '' || isUnder(e.dn, base, true);
      if (!inScope) continue;
      if (this.evalItem(f, e) !== true) continue;
      if (pageSize !== undefined && out.length >= pageSize) {
        more = true;
        break;
      }
      if (out.length >= sizeLimit) {
        code = RC.sizeLimitExceeded;
        break;
      }
      out.push(this.view(e, o.attrs));
      last = e.norm;
    }
    if (pageSize !== undefined && more && code === RC.success) return { entries: out, code, cookie: Buffer.from(JSON.stringify({ s: sig, after: last })).toString('base64url') };
    return { entries: out, code };
  }

  /** All results of a search, page by page (for a caller that wants the whole set but not one huge request). */
  searchAll(base: string, filter: string | Filter, o: Omit<SearchOptions, 'cookie'> & { pageSize: number; maxEntries?: number }): Entry[] {
    const all: Entry[] = [];
    let cookie: string | undefined;
    do {
      const r = this.search(base, filter, { ...o, ...(cookie ? { cookie } : {}) });
      all.push(...r.entries);
      if (all.length > (o.maxEntries ?? MAX_RESULTS)) throw new LdapError(RC.sizeLimitExceeded, 'more entries than the limit');
      cookie = r.cookie;
    } while (cookie);
    return all;
  }

  // ------------------------------------------------------------ bind

  /**
   * Simple bind. Returns success or throws LdapError: an empty password is unwillingToPerform (never anonymous), and
   * a missing user, a user with no password and a wrong password all give the same invalidCredentials, so the
   * answer does not reveal which names exist. After repeated failures the account is locked for a while.
   */
  bind(dn: string, password: string): void {
    if (password === '') throw new LdapError(RC.unwillingToPerform, 'a bind with a name and an empty password is refused (it would be an unauthenticated bind)');
    if (dn === '') throw new LdapError(RC.unwillingToPerform, 'anonymous bind is not allowed here');
    const norm = normalizeDn(dn);
    const pol = this.o.bind;
    const t = this.now();
    const f = this.failures.get(norm) ?? { at: [], lockedUntil: 0 };
    if (pol && f.lockedUntil > t) throw new LdapError(RC.invalidCredentials, 'invalid credentials');
    const e = this.byNorm.get(norm);
    const stored = e?.attrs.get('userpassword')?.values ?? [];
    // The comparison runs for every outcome, so a missing user takes as long as a wrong password.
    const ok = verifyPassword(stored, password) && e !== undefined;
    if (ok) {
      this.failures.delete(norm);
      return;
    }
    if (pol) {
      f.at = f.at.filter((x) => x > t - pol.windowMs);
      f.at.push(t);
      if (f.at.length >= pol.maxFailures) f.lockedUntil = t + pol.lockMs;
      this.failures.set(norm, f);
    }
    throw new LdapError(RC.invalidCredentials, 'invalid credentials');
  }
}

const parentOf = (e: Stored): string => {
  const p = parentDn(e.dn);
  return p === null ? '' : normalizeDn(p);
};

// ---------------------------------------------------------------- passwords

export type Scheme = 'SSHA' | 'SSHA256' | 'SSHA512' | 'SHA' | 'CLEARTEXT';
const SALTED: Readonly<Record<string, string>> = { SSHA: 'sha1', SSHA256: 'sha256', SSHA512: 'sha512' };

/** A userPassword value: {SSHA}, {SSHA256}, {SSHA512} (salted), {SHA} (unsalted), or {CLEARTEXT}. */
export function hashPassword(scheme: Scheme, password: string, salt: Buffer = randomBytes(8)): string {
  const pw = Buffer.from(password, 'utf8');
  if (scheme === 'CLEARTEXT') return `{CLEARTEXT}${password}`;
  if (scheme === 'SHA') return `{SHA}${createHash('sha1').update(pw).digest('base64')}`;
  return `{${scheme}}${Buffer.concat([createHash(SALTED[scheme]!).update(pw).update(salt).digest(), salt]).toString('base64')}`;
}

/** Whether a password matches any of the stored values, in constant time per comparison. */
export function verifyPassword(stored: readonly string[], password: string): boolean {
  const pw = Buffer.from(password, 'utf8');
  let ok = false;
  const eq = (a: Buffer, b: Buffer) => {
    const x = createHash('sha256').update(a).digest();
    const y = createHash('sha256').update(b).digest();
    return timingSafeEqual(x, y) && a.length === b.length;
  };
  for (const v of stored.length ? stored : ['{SHA}']) {
    const m = /^\{([A-Za-z0-9]+)\}([\s\S]*)$/.exec(v);
    if (!m) {
      ok = eq(Buffer.from(v), pw) || ok;
      continue;
    }
    const scheme = m[1]!.toUpperCase();
    if (scheme === 'CLEARTEXT') ok = eq(Buffer.from(m[2]!), pw) || ok;
    else if (scheme === 'SHA') ok = eq(Buffer.from(m[2]!, 'base64'), createHash('sha1').update(pw).digest()) || ok;
    else if (Object.hasOwn(SALTED, scheme)) {
      const raw = Buffer.from(m[2]!, 'base64');
      const len = scheme === 'SSHA' ? 20 : scheme === 'SSHA256' ? 32 : 64;
      if (raw.length > len) ok = eq(raw.subarray(0, len), createHash(SALTED[scheme]!).update(pw).update(raw.subarray(len)).digest()) || ok;
    }
  }
  return ok && stored.length > 0;
}

// ---------------------------------------------------------------- mapping and sync

export interface FieldMap {
  /** The LDAP attribute, or several (the first that has a value wins). */
  readonly from: string | readonly string[];
  /** Several values are kept as a list; otherwise the first is used. */
  readonly many?: boolean;
  readonly required?: boolean;
  readonly lowercase?: boolean;
  readonly default?: string;
  /** Joins other attributes: ["givenName", "sn"] with " ". */
  readonly join?: { readonly attrs: readonly string[]; readonly with: string };
}

export type Mapping = Readonly<Record<string, FieldMap>>;

export class MappingError extends Error {
  readonly dn: string;
  readonly field: string;
  constructor(dn: string, field: string, message: string) {
    super(`${dn}: ${message}`);
    this.dn = dn;
    this.field = field;
  }
}

const attrOf = (e: Entry, name: string): readonly string[] => {
  const k = Object.keys(e.attrs).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? e.attrs[k]! : [];
};

/** An application record from an entry: each field read from its attribute(s), with required fields enforced. */
export function mapEntry(e: Entry, m: Mapping): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [field, r] of Object.entries(m)) {
    let values: string[] = [];
    if (r.join) {
      const parts = r.join.attrs.map((a) => attrOf(e, a)[0]).filter((x): x is string => !!x);
      if (parts.length) values = [parts.join(r.join.with)];
    } else for (const a of typeof r.from === 'string' ? [r.from] : r.from) if (!values.length) values = [...attrOf(e, a)].filter((v) => v !== '');
    if (r.lowercase) values = values.map((v) => v.toLowerCase());
    if (!values.length && r.default !== undefined) values = [r.default];
    if (!values.length) {
      if (r.required) throw new MappingError(e.dn, field, `has no ${typeof r.from === 'string' ? r.from : r.from.join(' or ')}, which ${field} needs`);
      continue;
    }
    out[field] = r.many ? values : values[0]!;
  }
  return out;
}

export interface GroupConfig {
  /** Group DN or group name (its cn) to the roles it grants. */
  readonly roles: Readonly<Record<string, readonly string[]>>;
  /** Search base for groups; default: the whole directory. */
  readonly base?: string;
  readonly maxDepth?: number;
}

/** The groups a user belongs to (through nesting) and the roles they map to, with names and cycles handled. */
export function resolveGroups(dir: Directory, userDn: string, cfg: GroupConfig): { groups: string[]; roles: string[] } {
  const chain = dir.inChain(userDn, cfg.maxDepth ?? 16);
  const groups: string[] = [];
  const roles = new Set<string>();
  const byDn = new Map(Object.entries(cfg.roles).map(([k, v]) => [safeNormalize(k) ?? `name:${k.toLowerCase()}`, v]));
  for (const norm of chain) {
    const g = dir.get(norm);
    if (!g) continue;
    groups.push(g.dn);
    const cn = rdnValue(g.dn, 'cn');
    for (const r of byDn.get(norm) ?? (cn ? byDn.get(`name:${cn.toLowerCase()}`) : undefined) ?? []) roles.add(r);
  }
  return { groups: groups.sort(), roles: [...roles].sort() };
}

const safeNormalize = (s: string): string | undefined => {
  try {
    return s.includes('=') ? normalizeDn(s) : undefined;
  } catch {
    return undefined;
  }
};

export interface AppUser {
  readonly id: string;
  readonly fields: Readonly<Record<string, string | readonly string[]>>;
  readonly active: boolean;
}

export interface SyncPlan {
  readonly create: { id: string; fields: Record<string, string | string[]> }[];
  readonly update: { id: string; changes: Record<string, { from: unknown; to: unknown }> }[];
  readonly disable: string[];
  readonly reactivate: string[];
  readonly unchanged: number;
  readonly errors: { id: string; error: string }[];
}

export class SyncRefused extends Error {}

/**
 * What to change in the application so it matches the directory: users to create, update (with the exact fields
 * that differ), disable (they are gone from the directory) and reactivate. When the directory result would disable
 * more than `maxDisableFraction` of the active users, the plan is refused: an empty or partial answer from a broken
 * query or a lost connection must not lock everyone out.
 */
export function planUserSync(directory: readonly { id: string; fields: Record<string, string | string[]> }[], app: readonly AppUser[], o: { maxDisableFraction?: number } = {}): SyncPlan {
  const max = o.maxDisableFraction ?? 0.2;
  const dirIds = new Map<string, Record<string, string | string[]>>();
  const errors: { id: string; error: string }[] = [];
  for (const d of directory) {
    if (!d.id) {
      errors.push({ id: '', error: 'a directory user has no id' });
      continue;
    }
    if (dirIds.has(d.id)) {
      errors.push({ id: d.id, error: 'appears more than once in the directory result' });
      continue;
    }
    dirIds.set(d.id, d.fields);
  }
  const appById = new Map(app.map((a) => [a.id, a]));
  const create: SyncPlan['create'] = [];
  const update: SyncPlan['update'] = [];
  const reactivate: string[] = [];
  let unchanged = 0;
  for (const [id, fields] of dirIds) {
    const cur = appById.get(id);
    if (!cur) {
      create.push({ id, fields: { ...fields } });
      continue;
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(fields)) if (JSON.stringify(cur.fields[k] ?? null) !== JSON.stringify(v)) changes[k] = { from: cur.fields[k] ?? null, to: v };
    if (!cur.active) reactivate.push(id);
    if (Object.keys(changes).length) update.push({ id, changes });
    else if (cur.active) unchanged++;
  }
  const disable = app.filter((a) => a.active && !dirIds.has(a.id)).map((a) => a.id);
  const active = app.filter((a) => a.active).length;
  if (active > 0 && disable.length / active > max && disable.length > 1) throw new SyncRefused(`this would disable ${disable.length} of ${active} active users (more than ${Math.round(max * 100)}%); the directory answer looks incomplete`);
  return { create, update, disable, reactivate, unchanged, errors };
}
