/**
 * Forward-auth access rules, the kind a reverse proxy asks about before it lets a request through: given the host,
 * path, method, client network and who (if anyone) is signed in and how strongly, answer allow, deny, "sign in" or
 * "step up to a second factor", and say why. Rules are tried in order and the first match wins (as in Authelia):
 * each can name domains (exact or "*.example.com"), paths (exact, prefix, "*" globs, or a guarded regular
 * expression), methods, networks (CIDR blocks, IPv4 and IPv6) and subjects (a list of alternatives, each a list
 * of "user:name" / "group:name" that must all hold), and sets a policy of deny, bypass, one_factor or two_factor,
 * optionally with a maximum age for the sign-in. When no rule matches, a per-domain default applies, then the global
 * default (deny unless configured). An anonymous request that reaches a rule which depends on who the caller is
 * is sent to sign in rather than guessed at. The path is normalised before matching (one percent-decoding, dot
 * segments and duplicate slashes removed) and requests with an encoded slash, backslash, NUL or broken escape are
 * refused, so "/public/../admin" can never ride a bypass rule. Hosts are lower-cased without port or trailing dot.
 * Regular expressions are refused when they could backtrack catastrophically (nested quantifiers, lookarounds,
 * back-references) or are long. Every decision carries its reasons and a log entry; a bounded decision log keeps the
 * recent ones, with the query string never recorded; explain() shows every rule and why it did or did not match.
 * clientIp() picks the real client address from X-Forwarded-For by skipping only the proxies you trust.
 * Out of scope: authenticating anyone (sessions, oidc), the HTTP plumbing of the forward-auth call, and rate limiting.
 */

export class AccessPolicyError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export type Policy = 'deny' | 'bypass' | 'one_factor' | 'two_factor';
export type Level = 'none' | 'one_factor' | 'two_factor';

export interface Rule {
  readonly id?: string;
  /** Exact hosts or "*.example.com" (one or more labels below). Absent: any host. */
  readonly domain?: string | readonly string[];
  /** Exact path, a prefix ending in "/*" or "*", or any "*" glob. Matched against the normalised path. */
  readonly path?: string | readonly string[];
  /** A regular expression the whole normalised path must match. Guarded against catastrophic patterns. */
  readonly pathRegex?: string | readonly string[];
  readonly methods?: readonly string[];
  /** CIDR blocks, bare addresses, or names from `networks` in the configuration. */
  readonly networks?: readonly string[];
  /** Alternatives; each alternative is a list that must all hold: "user:alice", "group:admins". */
  readonly subject?: readonly (readonly string[])[];
  readonly policy: Policy;
  /** For one_factor and two_factor: the sign-in must be at most this many seconds old, or the caller is asked again. */
  readonly maxAgeSec?: number;
}

export interface DomainDefault {
  readonly domain: string | readonly string[];
  readonly policy: Policy;
}

export interface Config {
  readonly rules: readonly Rule[];
  readonly domains?: readonly DomainDefault[];
  /** Applied when nothing else matches. Default "deny". */
  readonly defaultPolicy?: Policy;
  /** Named network lists usable in rules. */
  readonly networks?: Readonly<Record<string, readonly string[]>>;
}

export interface Subject {
  readonly user: string;
  readonly groups?: readonly string[];
  readonly level: Level;
  /** When the person last signed in, ms since the epoch; used with maxAgeSec. */
  readonly authenticatedAt?: number;
}

export interface AccessRequest {
  readonly host: string;
  /** The path with or without a query string. */
  readonly path: string;
  readonly method: string;
  readonly remoteIp?: string;
  readonly subject?: Subject | null;
}

export type Action = 'allow' | 'deny' | 'authenticate' | 'step-up';

export interface LogEntry {
  readonly at: number;
  readonly host: string;
  readonly path: string;
  readonly method: string;
  readonly remoteIp: string | null;
  readonly user: string | null;
  readonly action: Action;
  readonly rule: string;
  readonly reasons: readonly string[];
}

export interface Decision {
  readonly action: Action;
  readonly policy: Policy;
  /** The authentication level the matched policy needs. */
  readonly required: Level | 'deny';
  /** The matched rule's id, "rule-N", "domain-default" or "default". */
  readonly rule: string;
  readonly reasons: readonly string[];
  readonly log: LogEntry;
}

export interface RuleTrace {
  readonly rule: string;
  readonly matched: boolean;
  readonly why: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Normalisation

/** The host as matched: lower case, no port, no trailing dot, no userinfo. Throws on anything that is not a host name. */
export function normalizeHost(raw: string): string {
  let h = raw.trim().toLowerCase();
  if (!h || /[\s/\\@?#]/.test(h)) throw new AccessPolicyError(`"${raw}" is not a host`);
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end < 0) throw new AccessPolicyError(`"${raw}" is not a host`);
    return h.slice(0, end + 1);
  }
  h = h.replace(/:\d{1,5}$/, '').replace(/\.$/, '');
  if (!/^[a-z0-9._-]+$/.test(h) || h.startsWith('.') || h.includes('..')) throw new AccessPolicyError(`"${raw}" is not a host`);
  return h;
}

/**
 * The path as matched: query and fragment removed, percent-decoded once, dot segments resolved, duplicate slashes
 * collapsed. Returns null for paths that cannot be matched safely: an encoded slash or backslash, a NUL, a broken
 * escape, a raw backslash, control characters, or one longer than 2048 characters.
 */
export function normalizePath(raw: string): string | null {
  if (raw.length > 4096) return null;
  const cut = raw.search(/[?#]/);
  const p = cut < 0 ? raw : raw.slice(0, cut);
  if (!p.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(p)) return null;
  if (/%(?![0-9a-fA-F]{2})/.test(p) || /%(2f|5c|00)/i.test(p)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    return null;
  }
  if (/[\\\u0000-\u001f\u007f]/.test(decoded) || /%(2f|5c|00)/i.test(decoded)) return null;
  const out: string[] = [];
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  const trailing = decoded.length > 1 && decoded.endsWith('/') && out.length > 0;
  const result = `/${out.join('/')}${trailing ? '/' : ''}`;
  return result.length > 2048 ? null : result;
}

// ---------------------------------------------------------------------------------------------------------------
// Matching helpers

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

/** Whether an address is inside a CIDR block, or equals a bare address. False for anything malformed. */
export function inCidr(address: string, cidr: string): boolean {
  const [net, bitsText] = cidr.split('/');
  const a = ipParse(address);
  const n = ipParse(net ?? '');
  if (!a || !n || a.v6 !== n.v6) return false;
  const total = n.v6 ? 128 : 32;
  if (bitsText !== undefined && !/^\d+$/.test(bitsText)) return false;
  const bits = bitsText === undefined ? total : Number(bitsText);
  if (bits > total) return false;
  const shift = BigInt(total - bits);
  return a.value >> shift === n.value >> shift;
}

/**
 * The client's address from X-Forwarded-For and the connecting address: walking the chain from the right, skip
 * addresses that belong to trusted proxies, and take the first that does not. Anything a client put to the left of
 * a trusted proxy is never believed past the first untrusted hop.
 */
export function clientIp(forwardedFor: string | undefined, connecting: string, trustedProxies: readonly string[]): string {
  const trusted = (ip: string) => trustedProxies.some((c) => inCidr(ip, c));
  if (!trusted(connecting)) return connecting;
  const chain = (forwardedFor ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    const ip = chain[i]!;
    if (!ipParse(ip)) return connecting;
    if (!trusted(ip)) return ip;
  }
  return chain[0] && ipParse(chain[0]) ? chain[0] : connecting;
}

function globToMatch(pattern: string): (s: string) => boolean {
  // A loop, not a regular expression: * matches any run of characters (including "/").
  const parts = pattern.split('*');
  return (s) => {
    if (parts.length === 1) return s === pattern;
    if (!s.startsWith(parts[0]!)) return false;
    let pos = parts[0]!.length;
    const last = parts[parts.length - 1]!;
    for (let i = 1; i < parts.length - 1; i++) {
      const at = s.indexOf(parts[i]!, pos);
      if (at < 0) return false;
      pos = at + parts[i]!.length;
    }
    return s.length - last.length >= pos && s.endsWith(last);
  };
}

function matchDomain(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  if (p === '*') return true;
  if (p.startsWith('*.')) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
  return host === p;
}

/** Throws unless a pattern is short and free of constructs that backtrack catastrophically. */
export function checkRegex(pattern: string): void {
  if (pattern.length > 200) throw new AccessPolicyError('a path regular expression may be at most 200 characters');
  if (/\(\?[=!<]|\\[1-9]|\\k</.test(pattern)) throw new AccessPolicyError(`"${pattern}": lookarounds and back-references are not allowed`);
  // A group that contains a quantifier and is itself quantified, such as (a+)+ or (.*){2,}.
  const stack: boolean[] = [];
  let escaped = false;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\') escaped = true;
    else if (inClass) inClass = c !== ']';
    else if (c === '[') inClass = true;
    else if (c === '(') stack.push(false);
    else if (c === ')') {
      const had = stack.pop() ?? false;
      const next = pattern.slice(i + 1, i + 12);
      if (had && /^(?:[*+]|\{\d*,\d*\})/.test(next)) throw new AccessPolicyError(`"${pattern}": a repeated group that itself repeats can take exponential time`);
      if (had && stack.length) stack[stack.length - 1] = true;
    } else if ((c === '*' || c === '+' || c === '{') && stack.length) stack[stack.length - 1] = true;
  }
  try {
    new RegExp(`^(?:${pattern})$`, 'u');
  } catch {
    throw new AccessPolicyError(`"${pattern}" is not a valid regular expression`);
  }
}

const list = <T>(v: T | readonly T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? [...(v as readonly T[])] : [v as T]);
const POLICIES = new Set(['deny', 'bypass', 'one_factor', 'two_factor']);
const requiredOf = (p: Policy): Level | 'deny' => (p === 'deny' ? 'deny' : p === 'bypass' ? 'none' : p);
const RANK: Record<Level, number> = { none: 0, one_factor: 1, two_factor: 2 };

interface Compiled {
  readonly rule: Rule;
  readonly id: string;
  readonly regexes: RegExp[];
  readonly globs: ((s: string) => boolean)[];
}

// ---------------------------------------------------------------------------------------------------------------
// The engine

export class AccessPolicy {
  private readonly rules: Compiled[];
  private readonly cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
    const ids = new Set<string>();
    this.rules = cfg.rules.map((rule, i) => {
      const id = rule.id ?? `rule-${i + 1}`;
      if (ids.has(id)) throw new AccessPolicyError(`two rules are called "${id}"`);
      ids.add(id);
      if (!POLICIES.has(rule.policy)) throw new AccessPolicyError(`${id}: "${String(rule.policy)}" is not a policy`);
      if (rule.maxAgeSec !== undefined && !(rule.maxAgeSec > 0)) throw new AccessPolicyError(`${id}: maxAgeSec must be positive`);
      if (rule.maxAgeSec !== undefined && (rule.policy === 'deny' || rule.policy === 'bypass')) throw new AccessPolicyError(`${id}: maxAgeSec only applies to one_factor and two_factor`);
      if (rule.policy === 'bypass' && rule.subject?.length) throw new AccessPolicyError(`${id}: a bypass rule cannot depend on who the caller is`);
      for (const p of list(rule.path)) if (!p.startsWith('/') && p !== '*') throw new AccessPolicyError(`${id}: path "${p}" must start with "/"`);
      for (const d of list(rule.domain)) if (!/^(\*|(\*\.)?[a-zA-Z0-9.-]+)$/.test(d)) throw new AccessPolicyError(`${id}: "${d}" is not a domain pattern`);
      for (const m of rule.methods ?? []) if (!/^[A-Z]+$/.test(m)) throw new AccessPolicyError(`${id}: "${m}" is not a method (upper case)`);
      for (const n of rule.networks ?? []) if (!(n in (cfg.networks ?? {})) && !ipParse(n.split('/')[0]!)) throw new AccessPolicyError(`${id}: "${n}" is not a network or a name from "networks"`);
      for (const alt of rule.subject ?? []) for (const s of alt) if (!/^(user|group):.+$/.test(s)) throw new AccessPolicyError(`${id}: subject "${s}" must be "user:name" or "group:name"`);
      for (const r of list(rule.pathRegex)) checkRegex(r);
      return { rule, id, regexes: list(rule.pathRegex).map((r) => new RegExp(`^(?:${r})$`, 'u')), globs: list(rule.path).map(globToMatch) };
    });
    for (const d of cfg.domains ?? []) if (!POLICIES.has(d.policy)) throw new AccessPolicyError(`domain default: "${String(d.policy)}" is not a policy`);
    for (const [name, nets] of Object.entries(cfg.networks ?? {})) for (const n of nets) if (!ipParse(n.split('/')[0]!)) throw new AccessPolicyError(`network "${name}": "${n}" is not an address or CIDR block`);
  }

  private inNetworks(ip: string, names: readonly string[]): boolean {
    return names.some((n) => (this.cfg.networks?.[n] ?? [n]).some((c) => inCidr(ip, c)));
  }

  private why(c: Compiled, host: string, path: string, method: string, ip: string | undefined, subj: Subject | null | undefined): string | null {
    const r = c.rule;
    if (r.domain !== undefined && !list(r.domain).some((d) => matchDomain(d, host))) return 'domain did not match';
    if (r.path !== undefined || r.pathRegex !== undefined) {
      const byPath = c.globs.some((g, i) => {
        const pat = list(r.path)[i]!;
        return g(path) || (pat.endsWith('/*') && path === pat.slice(0, -2));
      });
      if (!byPath && !c.regexes.some((re) => re.test(path))) return 'path did not match';
    }
    if (r.methods && !r.methods.includes(method)) return 'method did not match';
    if (r.networks) {
      if (!ip) return 'the client address is unknown, so networks cannot match';
      if (!this.inNetworks(ip, r.networks)) return 'network did not match';
    }
    if (r.subject?.length) {
      if (!subj) return 'SUBJECT'; // resolved by the caller: depends on who signs in
      const groups = new Set(subj.groups ?? []);
      const ok = r.subject.some((alt) => alt.every((s) => (s.startsWith('user:') ? s.slice(5) === subj.user : groups.has(s.slice(6)))));
      if (!ok) return 'subject did not match';
    }
    return null;
  }

  /** Every rule in order, with whether it matched this request and the first reason it did not. */
  explain(req: AccessRequest): RuleTrace[] {
    const { host, path, method, ip } = this.prepare(req) ?? {};
    if (host === undefined || path === undefined) return [];
    return this.rules.map((c) => {
      const w = this.why(c, host, path, method!, ip, req.subject);
      return { rule: c.id, matched: w === null, why: w === null ? 'matched' : w === 'SUBJECT' ? 'depends on who the caller is' : w };
    });
  }

  private prepare(req: AccessRequest): { host: string; path: string; method: string; ip: string | undefined } | null {
    try {
      const host = normalizeHost(req.host);
      const path = normalizePath(req.path);
      if (path === null) return null;
      return { host, path, method: req.method.toUpperCase(), ip: req.remoteIp };
    } catch {
      return null;
    }
  }

  /** Decides one request. `now` (ms) is only used for sign-in age checks and the log. */
  decide(req: AccessRequest, now: number): Decision {
    const prep = this.prepare(req);
    const safePath = (() => { try { const p = normalizePath(req.path); return p ?? '(invalid)'; } catch { return '(invalid)'; } })();
    const mk = (action: Action, policy: Policy, rule: string, reasons: string[]): Decision => ({
      action,
      policy,
      required: requiredOf(policy),
      rule,
      reasons,
      log: { at: now, host: safeHost(req.host), path: safePath, method: req.method.toUpperCase(), remoteIp: req.remoteIp ?? null, user: req.subject?.user ?? null, action, rule, reasons },
    });
    if (!prep) return mk('deny', 'deny', 'invalid-request', ['the host or path cannot be matched safely: encoded slash, backslash, NUL, broken escape, control character or oversize']);
    const { host, path, method, ip } = prep;
    const subj = req.subject ?? null;
    for (const c of this.rules) {
      const w = this.why(c, host, path, method, ip, subj);
      if (w !== null && w !== 'SUBJECT') continue;
      if (w === 'SUBJECT') {
        // Anonymous, and this rule depends on who the caller is: they must sign in before it can be decided.
        return mk('authenticate', 'one_factor', c.id, [`${c.id} depends on who the caller is; sign in first`]);
      }
      return this.apply(c.rule.policy, c.id, c.rule, subj, now, mk, [`matched ${c.id}`]);
    }
    const dom = (this.cfg.domains ?? []).find((d) => list(d.domain).some((p) => matchDomain(p, host)));
    if (dom) return this.apply(dom.policy, 'domain-default', undefined, subj, now, mk, [`no rule matched; the default for ${host} applies`]);
    return this.apply(this.cfg.defaultPolicy ?? 'deny', 'default', undefined, subj, now, mk, ['no rule or domain default matched; the global default applies']);
  }

  private apply(policy: Policy, rule: string, r: Rule | undefined, subj: Subject | null, now: number, mk: (a: Action, p: Policy, rule: string, reasons: string[]) => Decision, reasons: string[]): Decision {
    if (policy === 'deny') return mk('deny', policy, rule, [...reasons, 'policy is deny']);
    if (policy === 'bypass') return mk('allow', policy, rule, [...reasons, 'policy is bypass: no sign-in needed']);
    const need: Level = policy;
    if (!subj || subj.level === 'none') return mk('authenticate', policy, rule, [...reasons, `needs ${need}; the caller is not signed in`]);
    if (r?.maxAgeSec !== undefined && (subj.authenticatedAt === undefined || now - subj.authenticatedAt > r.maxAgeSec * 1000)) {
      return mk('authenticate', policy, rule, [...reasons, `the sign-in is older than ${r.maxAgeSec} seconds; sign in again`]);
    }
    if (RANK[subj.level] >= RANK[need]) return mk('allow', policy, rule, [...reasons, `signed in as ${subj.user} at ${subj.level}, which meets ${need}`]);
    return mk('step-up', policy, rule, [...reasons, `signed in at ${subj.level} but ${need} is needed`]);
  }
}

function safeHost(h: string): string {
  try {
    return normalizeHost(h);
  } catch {
    return '(invalid)';
  }
}

/** A bounded record of recent decisions. The query string is never stored (only the normalised path is). */
export class DecisionLog {
  private readonly entries: LogEntry[] = [];
  private readonly max: number;
  constructor(max = 1000) {
    if (!(max >= 1)) throw new AccessPolicyError('the log must hold at least one entry');
    this.max = max;
  }
  record(d: Decision): void {
    this.entries.push(d.log);
    if (this.entries.length > this.max) this.entries.shift();
  }
  recent(n = 50, filter?: { action?: Action; user?: string; host?: string }): LogEntry[] {
    return this.entries.filter((e) => (!filter?.action || e.action === filter.action) && (!filter?.user || e.user === filter.user) && (!filter?.host || e.host === filter.host)).slice(-n).reverse();
  }
  get size(): number {
    return this.entries.length;
  }
}
