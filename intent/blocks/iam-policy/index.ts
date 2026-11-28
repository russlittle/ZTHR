/**
 * AWS-style policy documents (the IAM JSON policy grammar, version 2012-10-17) evaluated the way AWS documents it:
 * a request is denied unless some statement allows it, and any matching Deny wins over every Allow. Statements name
 * Action or NotAction and Resource or NotResource (with * and ? wildcards, matched by a loop, never by a regular
 * expression, so a hostile pattern cannot take long), an optional Principal or NotPrincipal for resource policies,
 * and Conditions: String, Numeric, Date, Bool, Binary, IpAddress (IPv4 and IPv6 CIDR), Arn and Null operators, the
 * negated and IgnoreCase forms, the IfExists suffix, and the ForAnyValue and ForAllValues set operators; operators
 * are ANDed, a key's several values are ORed (negated operators AND their negations), and a missing key makes a
 * positive operator false and a negated one true. Policy variables such as ${aws:username} are substituted as
 * literal text, so a value of "*" or "?" can never turn into a wildcard. Permission boundaries and session policies
 * are further policy sets that must each also allow. Every decision comes with a trace that says, for each
 * statement, whether it matched and the first reason it did not ("resource did not match", "condition
 * StringEquals aws:username failed"), and a one-line explanation. validatePolicy checks a document before it is
 * stored: structure, effects, action and ARN shapes, known condition operators, duplicate Sids and size.
 * Out of scope: resource-based cross-account logic, service control policies' organisational inheritance (pass them
 * as a boundary set), tag-based key derivation (pass tags in the context), and the exact AWS size accounting.
 */

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type OneOrMany<T> = T | readonly T[];

export interface Statement {
  readonly Sid?: string;
  readonly Effect: 'Allow' | 'Deny';
  readonly Principal?: '*' | { readonly [type: string]: OneOrMany<string> };
  readonly NotPrincipal?: '*' | { readonly [type: string]: OneOrMany<string> };
  readonly Action?: OneOrMany<string>;
  readonly NotAction?: OneOrMany<string>;
  readonly Resource?: OneOrMany<string>;
  readonly NotResource?: OneOrMany<string>;
  readonly Condition?: { readonly [operator: string]: { readonly [key: string]: OneOrMany<string | number | boolean> } };
}

export interface Policy {
  readonly Version?: string;
  readonly Id?: string;
  readonly Statement: OneOrMany<Statement>;
}

export type ContextValue = string | number | boolean | readonly (string | number | boolean)[];

export interface Request {
  /** A concrete action such as "s3:GetObject". */
  readonly action: string;
  readonly resource: string;
  /** For policies with a Principal: the caller as { AWS: "arn:..." } or a bare ARN or "*" free string. */
  readonly principal?: string | { readonly [type: string]: string };
  /** Condition keys (aws:username, s3:prefix, aws:SourceIp, ...). Key names are case-insensitive. */
  readonly context?: { readonly [key: string]: ContextValue };
}

export interface EvaluationSets {
  /** The identity and resource policies that grant (or deny). */
  readonly policies: readonly Policy[];
  /** Permission boundaries, session policies, organisation guardrails: each set must also allow the request. */
  readonly boundaries?: readonly (readonly Policy[])[];
}

export interface TraceEntry {
  readonly source: string;
  readonly statement: number;
  readonly sid?: string;
  readonly effect: 'Allow' | 'Deny';
  readonly matched: boolean;
  readonly why: string;
}

export interface Decision {
  readonly allowed: boolean;
  readonly reason: 'explicit-deny' | 'allowed' | 'implicit-deny' | 'boundary-no-allow';
  readonly matched: readonly TraceEntry[];
  readonly trace: readonly TraceEntry[];
  readonly explanation: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Wildcards and variables

const MAX_PATTERN = 2048;

type Token = { readonly lit: string } | 'star' | 'any';

/** Splits a policy string into literal text and wildcards, substituting ${variables} as literal text. Returns null when a variable has no value. */
function tokens(pattern: string, ctx: Context | null, wildcards: boolean): Token[] | null {
  if (pattern.length > MAX_PATTERN) throw new PolicyError(`a policy string may be at most ${MAX_PATTERN} characters`);
  const out: Token[] = [];
  let lit = '';
  const flush = () => {
    if (lit) out.push({ lit });
    lit = '';
  };
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '$' && pattern[i + 1] === '{') {
      const end = pattern.indexOf('}', i);
      if (end < 0) throw new PolicyError(`an unclosed "\${" in "${pattern}"`);
      const body = pattern.slice(i + 2, end);
      i = end;
      if (body === '*' || body === '?' || body === '$') {
        lit += body;
        continue;
      }
      if (!ctx) {
        lit += `\${${body}}`;
        continue;
      }
      const m = /^([^,]+?)(?:\s*,\s*'([^']*)')?$/.exec(body);
      if (!m) throw new PolicyError(`"\${${body}}" is not a policy variable`);
      const v = ctx.get(m[1]!.trim().toLowerCase());
      if (v && v.length === 1) lit += v[0]!;
      else if (m[2] !== undefined) lit += m[2];
      else return null;
    } else if (wildcards && c === '*') {
      flush();
      if (out[out.length - 1] !== 'star') out.push('star');
    } else if (wildcards && c === '?') {
      flush();
      out.push('any');
    } else lit += c;
  }
  flush();
  return out;
}

/** Whether tokens match the whole string; a linear-time two-pointer match with backtracking only to the last star. */
function matchTokens(toks: readonly Token[], s: string, ignoreCase = false): boolean {
  const text = ignoreCase ? s.toLowerCase() : s;
  // Expand to a flat pattern of single-character matchers, so the classic star algorithm applies.
  const flat: (string | 'star' | 'any')[] = [];
  for (const t of toks) {
    if (t === 'star' || t === 'any') flat.push(t);
    else for (const ch of ignoreCase ? t.lit.toLowerCase() : t.lit) flat.push(ch);
  }
  let p = 0;
  let i = 0;
  let star = -1;
  let mark = 0;
  const chars = [...text];
  while (i < chars.length) {
    const f = flat[p];
    if (f === 'star') {
      star = p++;
      mark = i;
    } else if (f === 'any' || f === chars[i]) {
      p++;
      i++;
    } else if (star >= 0) {
      p = star + 1;
      i = ++mark;
    } else return false;
  }
  while (flat[p] === 'star') p++;
  return p === flat.length;
}

/** Wildcard match of a policy pattern against text, with no variable substitution. */
export function wildcardMatch(pattern: string, text: string, ignoreCase = false): boolean {
  return matchTokens(tokens(pattern, null, true)!, text, ignoreCase);
}

type Context = Map<string, readonly string[]>;

function makeContext(ctx: Request['context']): Context {
  const m: Context = new Map();
  for (const [k, v] of Object.entries(ctx ?? {})) m.set(k.toLowerCase(), (Array.isArray(v) ? v : [v]).map((x) => String(x)));
  return m;
}

const list = <T>(v: OneOrMany<T> | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? [...(v as readonly T[])] : [v as T]);

// ---------------------------------------------------------------------------------------------------------------
// Condition operators

const BASES = ['String', 'Numeric', 'Date', 'Bool', 'Binary', 'Ip', 'Arn', 'Null'] as const;
const OPS: Record<string, { base: (typeof BASES)[number]; negate: boolean; test: (c: string, p: Token[]) => boolean }> = {};

function ipParse(text: string): { v6: boolean; value: bigint } | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    const parts = text.split('.').map(Number);
    if (parts.some((n) => n > 255)) return null;
    return { v6: false, value: parts.reduce((a, n) => (a << 8n) | BigInt(n), 0n) };
  }
  if (!/^[0-9a-fA-F:.]+$/.test(text) || !text.includes(':')) return null;
  let t = text;
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(t);
  if (tail) {
    const v4 = ipParse(tail[1]!);
    if (!v4) return null;
    t = `${t.slice(0, -tail[1]!.length)}${Number((v4.value >> 16n) & 0xffffn).toString(16)}:${Number(v4.value & 0xffffn).toString(16)}`;
  }
  const halves = t.split('::');
  if (halves.length > 2) return null;
  const groups = (s: string) => (s === '' ? [] : s.split(':'));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + rest.length > 7) return null;
  const all = halves.length === 2 ? [...head, ...Array(8 - head.length - rest.length).fill('0'), ...rest] : head;
  let value = 0n;
  for (const g of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return { v6: true, value };
}

/** Whether an address is inside a CIDR block (or equals a bare address). */
export function ipInCidr(address: string, cidr: string): boolean {
  const [net, bitsText] = cidr.split('/');
  const a = ipParse(address);
  const n = ipParse(net ?? '');
  if (!a || !n || a.v6 !== n.v6) return false;
  const total = n.v6 ? 128 : 32;
  const bits = bitsText === undefined ? total : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > total || (bitsText !== undefined && !/^\d+$/.test(bitsText))) return false;
  const shift = BigInt(total - bits);
  return a.value >> shift === n.value >> shift;
}

const num = (s: string): number => (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s.trim()) ? Number(s) : Number.NaN);
const date = (s: string): number => (/^\d+$/.test(s.trim()) ? Number(s) * 1000 : Date.parse(s));
const str = (p: Token[]): string => p.map((t) => (typeof t === 'string' ? (t === 'star' ? '*' : '?') : t.lit)).join('');

function addOp(name: string, base: (typeof BASES)[number], negate: boolean, test: (c: string, p: Token[]) => boolean): void {
  OPS[name] = { base, negate, test };
}
addOp('StringEquals', 'String', false, (c, p) => c === str(p));
addOp('StringNotEquals', 'String', true, (c, p) => c === str(p));
addOp('StringEqualsIgnoreCase', 'String', false, (c, p) => c.toLowerCase() === str(p).toLowerCase());
addOp('StringNotEqualsIgnoreCase', 'String', true, (c, p) => c.toLowerCase() === str(p).toLowerCase());
addOp('StringLike', 'String', false, (c, p) => matchTokens(p as Token[], c));
addOp('StringNotLike', 'String', true, (c, p) => matchTokens(p as Token[], c));
for (const [n, f] of [['Equals', (a: number, b: number) => a === b], ['LessThan', (a: number, b: number) => a < b], ['LessThanEquals', (a: number, b: number) => a <= b], ['GreaterThan', (a: number, b: number) => a > b], ['GreaterThanEquals', (a: number, b: number) => a >= b]] as const) {
  addOp(`Numeric${n}`, 'Numeric', false, (c, p) => { const a = num(c); const b = num(str(p)); return !Number.isNaN(a) && !Number.isNaN(b) && f(a, b); });
  addOp(`Date${n}`, 'Date', false, (c, p) => { const a = date(c); const b = date(str(p)); return !Number.isNaN(a) && !Number.isNaN(b) && f(a, b); });
}
addOp('NumericNotEquals', 'Numeric', true, (c, p) => { const a = num(c); const b = num(str(p)); return !Number.isNaN(a) && a === b; });
addOp('DateNotEquals', 'Date', true, (c, p) => { const a = date(c); const b = date(str(p)); return !Number.isNaN(a) && a === b; });
addOp('Bool', 'Bool', false, (c, p) => c.toLowerCase() === str(p).toLowerCase());
addOp('BinaryEquals', 'Binary', false, (c, p) => c === str(p));
addOp('IpAddress', 'Ip', false, (c, p) => ipInCidr(c, str(p)));
addOp('NotIpAddress', 'Ip', true, (c, p) => ipInCidr(c, str(p)));
/** Splits tokens at the first five literal colons, so each ARN part can be matched on its own. */
function arnParts(toks: readonly Token[]): Token[][] | null {
  const parts: Token[][] = [[]];
  for (const t of toks) {
    if (typeof t === 'string' || parts.length === 6) {
      parts[parts.length - 1]!.push(t);
      continue;
    }
    const pieces = t.lit.split(':');
    pieces.forEach((piece, i) => {
      if (i > 0 && parts.length < 6) parts.push([]);
      else if (i > 0) piece = `:${piece}`;
      if (piece) parts[parts.length - 1]!.push({ lit: piece });
    });
  }
  return parts.length === 6 ? parts : null;
}
const arnLike = (c: string, p: Token[]): boolean => {
  const a = arnParts([{ lit: c }]);
  const b = arnParts(p);
  if (!a || !b) return false;
  return b.every((seg, i) => matchTokens(seg, str(a[i]!)));
};
addOp('ArnEquals', 'Arn', false, arnLike);
addOp('ArnLike', 'Arn', false, arnLike);
addOp('ArnNotEquals', 'Arn', true, arnLike);
addOp('ArnNotLike', 'Arn', true, arnLike);
addOp('Null', 'Null', false, () => false);

export const CONDITION_OPERATORS: readonly string[] = [...Object.keys(OPS)];

function parseOperator(full: string): { name: string; qualifier: 'ForAnyValue' | 'ForAllValues' | null; ifExists: boolean } {
  let name = full;
  let qualifier: 'ForAnyValue' | 'ForAllValues' | null = null;
  const q = /^(ForAnyValue|ForAllValues):(.+)$/.exec(name);
  if (q) {
    qualifier = q[1] as 'ForAnyValue' | 'ForAllValues';
    name = q[2]!;
  }
  let ifExists = false;
  if (name.endsWith('IfExists')) {
    ifExists = true;
    name = name.slice(0, -'IfExists'.length);
  }
  if (!(name in OPS)) throw new PolicyError(`"${full}" is not a condition operator`);
  return { name, qualifier, ifExists };
}

/** Evaluates one condition block; returns null when it holds, or the first reason it does not. */
function conditionFailure(cond: NonNullable<Statement['Condition']>, ctx: Context): string | null {
  for (const [opFull, keys] of Object.entries(cond)) {
    const { name, qualifier, ifExists } = parseOperator(opFull);
    const op = OPS[name]!;
    for (const [key, raw] of Object.entries(keys)) {
      const have = ctx.get(key.toLowerCase());
      const values = list(raw).map(String);
      if (name === 'Null') {
        const wantNull = values[0]?.toLowerCase() === 'true';
        if ((have === undefined || have.length === 0) !== wantNull) return `condition ${opFull} ${key} failed: the key ${have ? 'is' : 'is not'} present`;
        continue;
      }
      if (have === undefined || have.length === 0) {
        if (ifExists) continue;
        if (qualifier === 'ForAllValues') continue;
        if (op.negate && !qualifier) continue;
        return `condition ${opFull} ${key} failed: the request has no ${key}`;
      }
      const wild = op.base === 'Arn' || name === 'StringLike' || name === 'StringNotLike';
      const patterns = values.map((v) => tokens(v, ctx, wild)).filter((t): t is Token[] => t !== null);
      // One context value against the values: positive operators OR them, negated operators need every one to differ.
      const one = (c: string): boolean => (op.negate ? patterns.every((p) => !op.test(c, p)) : patterns.some((p) => op.test(c, p)));
      let ok: boolean;
      if (qualifier === 'ForAnyValue') ok = have.some(one);
      else if (qualifier === 'ForAllValues') ok = have.every(one);
      else if (have.length !== 1) ok = false;
      else ok = one(have[0]!);
      if (!ok) return `condition ${opFull} ${key} failed: request value ${JSON.stringify(have.length === 1 ? have[0] : have)} against ${JSON.stringify(values)}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Statements

function principalMatches(spec: Statement['Principal'], who: Request['principal']): boolean {
  if (who === undefined) return false;
  if (spec === '*') return true;
  const ids = typeof who === 'string' ? [who] : Object.values(who);
  const allowed = Object.values(spec ?? {}).flatMap((v) => list(v));
  return ids.some((id) => allowed.some((a) => a === '*' || a === id || (/^\d{12}$/.test(a) && id.startsWith(`arn:aws:iam::${a}:`))));
}

function statementList(p: Policy): Statement[] {
  return list(p.Statement);
}

function why(st: Statement, req: Request, ctx: Context): string | null {
  const action = req.action;
  if (st.Principal !== undefined && !principalMatches(st.Principal, req.principal)) return 'principal did not match';
  if (st.NotPrincipal !== undefined && principalMatches(st.NotPrincipal, req.principal)) return 'principal is excluded by NotPrincipal';
  const patterns = (xs: string[], wild: boolean) => xs.map((x) => tokens(x, wild ? ctx : null, true)).filter((t): t is Token[] => t !== null);
  if (st.Action !== undefined && !list(st.Action).some((a) => wildcardMatch(a, action, true))) return 'action did not match';
  if (st.NotAction !== undefined && list(st.NotAction).some((a) => wildcardMatch(a, action, true))) return 'action is excluded by NotAction';
  if (st.Resource !== undefined && !patterns(list(st.Resource), true).some((t) => matchTokens(t, req.resource))) return 'resource did not match';
  if (st.NotResource !== undefined && patterns(list(st.NotResource), true).some((t) => matchTokens(t, req.resource))) return 'resource is excluded by NotResource';
  if (st.Condition) return conditionFailure(st.Condition, ctx);
  return null;
}

function checkRequest(req: Request): void {
  if (!/^[A-Za-z0-9-]+:[A-Za-z0-9_]+$/.test(req.action)) throw new PolicyError(`"${req.action}" is not an action such as "s3:GetObject" (a request names one concrete action)`);
  if (!req.resource || /[\u0000-\u001f]/.test(req.resource)) throw new PolicyError('a request needs a resource without control characters');
}

/** Evaluates a request: explicit Deny wins, then an Allow (in every boundary set too), otherwise implicit deny. */
export function evaluate(sets: EvaluationSets, req: Request): Decision {
  checkRequest(req);
  const ctx = makeContext(req.context);
  const trace: TraceEntry[] = [];
  const run = (source: string, policies: readonly Policy[]) => {
    const hits: TraceEntry[] = [];
    policies.forEach((p, pi) =>
      statementList(p).forEach((st, si) => {
        const reason = why(st, req, ctx);
        const e: TraceEntry = { source: `${source}[${pi}]`, statement: si, ...(st.Sid ? { sid: st.Sid } : {}), effect: st.Effect, matched: reason === null, why: reason ?? `${st.Effect.toLowerCase()} applies` };
        trace.push(e);
        if (reason === null) hits.push(e);
      }),
    );
    return hits;
  };
  const main = run('policy', sets.policies);
  const boundaries = (sets.boundaries ?? []).map((b, i) => run(`boundary${i}`, b));
  const denies = [...main, ...boundaries.flat()].filter((e) => e.effect === 'Deny');
  const name = (e: TraceEntry) => `${e.source} statement ${e.statement}${e.sid ? ` (${e.sid})` : ''}`;
  if (denies.length) return { allowed: false, reason: 'explicit-deny', matched: denies, trace, explanation: `denied: ${denies.map(name).join(', ')} explicitly denies ${req.action} on ${req.resource}` };
  const allows = main.filter((e) => e.effect === 'Allow');
  if (!allows.length) return { allowed: false, reason: 'implicit-deny', matched: [], trace, explanation: `denied: no statement allows ${req.action} on ${req.resource}` };
  const short = boundaries.findIndex((b) => !b.some((e) => e.effect === 'Allow'));
  if (short >= 0) return { allowed: false, reason: 'boundary-no-allow', matched: allows, trace, explanation: `denied: ${allows.map(name).join(', ')} allows it, but boundary set ${short} does not` };
  return { allowed: true, reason: 'allowed', matched: [...allows, ...boundaries.flat().filter((e) => e.effect === 'Allow')], trace, explanation: `allowed by ${allows.map(name).join(', ')}` };
}

/** Which of several actions are allowed on a resource: a map from action to its decision. */
export function evaluateMany(sets: EvaluationSets, actions: readonly string[], resource: string, rest: Omit<Request, 'action' | 'resource'> = {}): Record<string, Decision> {
  return Object.fromEntries(actions.map((a) => [a, evaluate(sets, { ...rest, action: a, resource })]));
}

// ---------------------------------------------------------------------------------------------------------------
// Validation

export interface ValidationOptions {
  /** Whether Resource is required (identity policies) or Principal is required (resource policies). Default "identity". */
  readonly kind?: 'identity' | 'resource';
  readonly maxChars?: number;
  readonly maxStatements?: number;
}

/** Problems in a policy document, as plain messages; an empty list means it can be stored. */
export function validatePolicy(doc: unknown, o: ValidationOptions = {}): string[] {
  const problems: string[] = [];
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return ['a policy is a JSON object'];
  const p = doc as Record<string, unknown>;
  const size = JSON.stringify(doc).replace(/\s+/g, '').length;
  if (size > (o.maxChars ?? 20_000)) problems.push(`the policy is ${size} characters; the limit is ${o.maxChars ?? 20_000}`);
  if (p['Version'] !== undefined && p['Version'] !== '2012-10-17' && p['Version'] !== '2008-10-17') problems.push(`Version "${String(p['Version'])}" is not 2012-10-17 or 2008-10-17`);
  const raw = p['Statement'];
  const sts = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  if (!sts.length) problems.push('Statement is required and cannot be empty');
  if (sts.length > (o.maxStatements ?? 100)) problems.push(`more than ${o.maxStatements ?? 100} statements`);
  const sids = new Set<string>();
  sts.forEach((s, i) => {
    const at = `Statement ${i}`;
    if (typeof s !== 'object' || s === null || Array.isArray(s)) {
      problems.push(`${at}: must be an object`);
      return;
    }
    const st = s as Record<string, unknown>;
    if (st['Effect'] !== 'Allow' && st['Effect'] !== 'Deny') problems.push(`${at}: Effect must be "Allow" or "Deny"`);
    if (typeof st['Sid'] === 'string') {
      if (!/^[A-Za-z0-9]+$/.test(st['Sid'])) problems.push(`${at}: Sid "${st['Sid']}" may only have letters and digits`);
      if (sids.has(st['Sid'])) problems.push(`${at}: Sid "${st['Sid']}" is used twice`);
      sids.add(st['Sid']);
    }
    if ((st['Action'] === undefined) === (st['NotAction'] === undefined)) problems.push(`${at}: give exactly one of Action and NotAction`);
    if (st['Resource'] !== undefined && st['NotResource'] !== undefined) problems.push(`${at}: give only one of Resource and NotResource`);
    if ((o.kind ?? 'identity') === 'identity' && st['Resource'] === undefined && st['NotResource'] === undefined) problems.push(`${at}: Resource or NotResource is required`);
    if (o.kind === 'resource' && st['Principal'] === undefined && st['NotPrincipal'] === undefined) problems.push(`${at}: Principal or NotPrincipal is required in a resource policy`);
    if ((o.kind ?? 'identity') === 'identity' && (st['Principal'] !== undefined || st['NotPrincipal'] !== undefined)) problems.push(`${at}: an identity policy has no Principal`);
    if (st['Principal'] !== undefined && st['NotPrincipal'] !== undefined) problems.push(`${at}: give only one of Principal and NotPrincipal`);
    for (const key of ['Action', 'NotAction'] as const) for (const a of list(st[key] as OneOrMany<unknown>)) if (typeof a !== 'string' || !(a === '*' || /^[A-Za-z0-9-]+:[A-Za-z0-9_*?]+$/.test(a))) problems.push(`${at}: ${key} "${String(a)}" is not "service:Action" or "*"`);
    for (const key of ['Resource', 'NotResource'] as const)
      for (const r of list(st[key] as OneOrMany<unknown>)) {
        if (typeof r !== 'string') problems.push(`${at}: ${key} must be strings`);
        else if (r !== '*' && !r.startsWith('arn:')) problems.push(`${at}: ${key} "${r}" is not "*" or an ARN`);
        else if ((r.match(/\$\{/g) ?? []).length !== (r.match(/\}/g) ?? []).length) problems.push(`${at}: ${key} "${r}" has an unclosed variable`);
      }
    const cond = st['Condition'];
    if (cond !== undefined) {
      if (typeof cond !== 'object' || cond === null || Array.isArray(cond)) problems.push(`${at}: Condition must be an object of operators`);
      else
        for (const [op, keys] of Object.entries(cond as Record<string, unknown>)) {
          try {
            parseOperator(op);
          } catch (e) {
            problems.push(`${at}: ${(e as Error).message}`);
            continue;
          }
          if (typeof keys !== 'object' || keys === null || Array.isArray(keys) || !Object.keys(keys).length) problems.push(`${at}: ${op} needs keys with values`);
          else if (op.startsWith('IpAddress') || op.startsWith('NotIpAddress'))
            for (const [k, v] of Object.entries(keys as Record<string, unknown>)) for (const c of list(v as OneOrMany<unknown>)) if (typeof c !== 'string' || !ipInCidr(c.split('/')[0]!, c)) problems.push(`${at}: ${op} ${k}: "${String(c)}" is not an address or CIDR block`);
        }
    }
  });
  return problems;
}
