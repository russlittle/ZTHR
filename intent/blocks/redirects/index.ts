/**
 * Redirect rules that are safe to run on a public URL. A rule maps a request path to a destination, with a status
 * (301, 302, 303, 307, 308, or 410 Gone), and comes in three kinds: exact (`/old`), glob (`/blog/:year/:slug`,
 * `/docs/*` where a trailing `*` takes the rest; placeholders `:year` and `:splat` are filled into the destination),
 * and regex (`^/p/(\d+)$` with `$1` in the destination). Matching is first-wins in priority order, case-insensitive
 * unless a rule says otherwise, ignores a trailing slash and repeated slashes, resolves dot segments, and treats a
 * malformed or over-long path as matching nothing. Glob rules are matched segment by segment with no regular
 * expression, so they cannot be made slow. Regex rules must pass a static cost check before they are accepted: they
 * must start with `^`, may not use backreferences or lookbehind, may not repeat a group that holds a repeat or an
 * alternation (the `(a+)+` family), are limited in length, capture groups and unbounded repeats, and run only
 * against paths up to a cap. This is a heuristic that rejects the known catastrophic shapes; it is not a proof, which
 * is why the input cap exists too.
 *
 * A destination is either a path or an absolute http(s) URL, never protocol-relative, never carrying credentials or
 * control characters, and never filled from the request inside the host part. After substitution the result is
 * checked again: a captured `//evil.example` becomes `/evil.example`, backslashes are escaped, so a rule cannot be turned
 * into an open redirect. The status is chosen for the method: a 301 or 302 on a POST becomes 308 or 307 so the body
 * and method survive. Checks over the whole set find loops (A to B to A), chains (A to B to C, with the flattened
 * target), self-redirects, and rules shadowed by an earlier one; `flatten` rewrites static chains. Hits are counted
 * per rule with an injected clock, so unused rules can be found. CSV import and export follow RFC 4180 (quotes,
 * doubled quotes, embedded newlines, BOM), report each bad row with its line, and neutralise spreadsheet formulas on
 * export.
 *
 * Out of scope: the HTTP server itself, host-wide rewrites (www to apex, http to https), regex flags beyond
 * case-insensitivity, and proof of regex safety.
 */

export class RedirectRuleError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`bad redirect rule: ${problems.join('; ')}`);
    this.problems = problems;
  }
}
export class CsvError extends Error {}

export type Status = 301 | 302 | 303 | 307 | 308 | 410;
export const STATUSES: readonly Status[] = [301, 302, 303, 307, 308, 410];
export type Kind = 'exact' | 'glob' | 'regex';

export interface Rule {
  readonly id?: string;
  readonly from: string;
  /** Required unless the status is 410. */
  readonly to?: string;
  readonly status?: number;
  readonly kind?: Kind;
  readonly caseSensitive?: boolean;
  /** "keep" (default) appends the request's query string to the destination; "drop" discards it. */
  readonly query?: 'keep' | 'drop';
  readonly methods?: readonly string[];
  readonly hosts?: readonly string[];
  /** Lower runs first. Default 100. */
  readonly priority?: number;
  readonly enabled?: boolean;
  readonly note?: string;
  /** A sample path for regex rules, so loop checks can run on them. */
  readonly sample?: string;
}

export interface Options {
  readonly now?: () => number;
  readonly maxRules?: number;
  readonly maxPathLength?: number;
  readonly maxRegexLength?: number;
  readonly maxUnbounded?: number;
  readonly maxRegexInput?: number;
  readonly maxHops?: number;
  /** Hosts that count as this site when a destination is an absolute URL (so chains can be followed). */
  readonly ownHosts?: readonly string[];
}

export interface Request {
  readonly path: string;
  readonly query?: string;
  readonly method?: string;
  readonly host?: string;
}

export interface Match {
  readonly rule: ResolvedRule;
  readonly status: Status;
  readonly location?: string;
}

export type ResolvedRule = Required<Pick<Rule, 'id' | 'from' | 'kind' | 'caseSensitive' | 'query' | 'priority' | 'enabled'>> & { readonly status: Status } & Pick<Rule, 'to' | 'methods' | 'hosts' | 'note' | 'sample'>;

// ==================================================================== paths

const UNRESERVED = /[A-Za-z0-9\-._~]/;
export interface NormPath {
  readonly path: string;
  readonly lower: string;
}

/** A request path in matching form, or undefined if it is not one worth matching. */
export function normalizePath(raw: string, maxLength = 2048): NormPath | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > maxLength || /[\u0000-\u001f\u007f\\]/.test(raw)) return undefined;
  let p = raw;
  const cut = p.search(/[?#]/);
  if (cut >= 0) p = p.slice(0, cut);
  if (!p.startsWith('/')) return undefined;
  let bad = false;
  p = p.replace(/%([0-9A-Fa-f]{2})/g, (_m, h: string) => {
    const c = String.fromCharCode(parseInt(h, 16));
    return UNRESERVED.test(c) ? c : `%${h.toUpperCase()}`;
  });
  if (/%(?![0-9A-F]{2})/.test(p)) bad = true;
  if (bad) return undefined;
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  const path = `/${out.join('/')}`;
  return { path, lower: path.toLowerCase() };
}

const stripSlash = (p: string) => (p.length > 1 && p.endsWith('/') ? p.replace(/\/+$/, '') || '/' : p);

// ==================================================================== regex cost

export interface RegexReport {
  readonly ok: boolean;
  readonly reasons: readonly string[];
  readonly unbounded: number;
  readonly groups: number;
}

/** A static check for the regex shapes that run away: nested repeats, repeated alternation, backreferences. */
export function regexRisk(src: string, o: { maxLength?: number; maxUnbounded?: number } = {}): RegexReport {
  const reasons: string[] = [];
  const maxLen = o.maxLength ?? 200;
  const maxUnb = o.maxUnbounded ?? 3;
  if (src.length > maxLen) reasons.push(`longer than ${maxLen} characters`);
  if (!src.startsWith('^')) reasons.push('must start with ^');
  if (/\\[1-9]|\\k</.test(src)) reasons.push('backreferences are not allowed');
  if (/\(\?<[=!]/.test(src)) reasons.push('lookbehind is not allowed');
  type G = { unbounded: number; alt: boolean; quant: boolean; capture: boolean };
  const stack: G[] = [{ unbounded: 0, alt: false, quant: false, capture: false }];
  let groups = 0;
  let unbounded = 0;
  let i = 0;
  const quantAt = (j: number): { len: number; unbounded: boolean; repeats: boolean } | undefined => {
    const c = src[j];
    if (c === '*' || c === '+') return { len: 1 + (src[j + 1] === '?' ? 1 : 0), unbounded: true, repeats: true };
    if (c === '?') return { len: 1 + (src[j + 1] === '?' ? 1 : 0), unbounded: false, repeats: false };
    if (c === '{') {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(src.slice(j));
      if (!m) return undefined;
      const hi = m[2] ? (m[3] === '' ? Infinity : Number(m[3])) : Number(m[1]);
      if (hi > 100 && hi !== Infinity) reasons.push('a repeat count above 100');
      return { len: m[0].length + (src[j + m[0].length] === '?' ? 1 : 0), unbounded: hi === Infinity, repeats: hi > 1 };
    }
    return undefined;
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') {
      i += 2;
      const q = quantAt(i);
      if (q) {
        stack[stack.length - 1]!.quant = true;
        if (q.unbounded) {
          stack[stack.length - 1]!.unbounded++;
          unbounded++;
        }
        i += q.len;
      }
      continue;
    }
    if (c === '[') {
      i++;
      while (i < src.length && src[i] !== ']') i += src[i] === '\\' ? 2 : 1;
      i++;
      const q = quantAt(i);
      if (q) {
        stack[stack.length - 1]!.quant = true;
        if (q.unbounded) {
          stack[stack.length - 1]!.unbounded++;
          unbounded++;
        }
        i += q.len;
      }
      continue;
    }
    if (c === '(') {
      const capture = !src.startsWith('(?', i) || src.startsWith('(?<', i) && !/^\(\?<[=!]/.test(src.slice(i));
      if (capture) groups++;
      stack.push({ unbounded: 0, alt: false, quant: false, capture });
      i += src.startsWith('(?', i) ? (src.startsWith('(?<', i) && !/^\(\?<[=!]/.test(src.slice(i)) ? src.indexOf('>', i) - i + 1 : 3) : 1;
      continue;
    }
    if (c === ')') {
      const g = stack.pop();
      if (!g || stack.length === 0) {
        reasons.push('unbalanced parentheses');
        break;
      }
      i++;
      const q = quantAt(i);
      const parent = stack[stack.length - 1]!;
      parent.unbounded += g.unbounded;
      parent.quant ||= g.quant;
      parent.alt ||= false;
      if (q) {
        if (q.repeats && (g.quant || g.unbounded > 0)) reasons.push('a repeated group contains a repeat (nested quantifiers)');
        if (q.repeats && g.alt) reasons.push('a repeated group contains alternatives');
        if (q.unbounded) {
          unbounded++;
          parent.unbounded++;
        }
        parent.quant = true;
        i += q.len;
      }
      continue;
    }
    if (c === '|') stack[stack.length - 1]!.alt = true;
    else {
      const q = quantAt(i + 1);
      if (c !== '^' && c !== '$' && q) {
        stack[stack.length - 1]!.quant = true;
        if (q.unbounded) {
          stack[stack.length - 1]!.unbounded++;
          unbounded++;
        }
        i += q.len;
      }
    }
    i++;
  }
  if (stack.length > 1) reasons.push('unbalanced parentheses');
  if (unbounded > maxUnb) reasons.push(`more than ${maxUnb} unbounded repeats`);
  if (groups > 9) reasons.push('more than nine capture groups');
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], unbounded, groups };
}

// ==================================================================== destinations

const PLACEHOLDER = /:([A-Za-z_][A-Za-z0-9_]*)|\*/g;
const GLOB_PARAM = /^:([A-Za-z_][A-Za-z0-9_]*)$/;

function inferKind(from: string): Kind {
  return from.startsWith('^') ? 'regex' : /[*]|\/:[A-Za-z_]/.test(from) ? 'glob' : 'exact';
}

/** A destination that is safe to send in a Location header, or undefined. */
export function safeLocation(loc: string): string | undefined {
  if (!loc || loc.length > 4096 || /[\u0000-\u001f\u007f\s]/.test(loc)) return undefined;
  if (loc.startsWith('/')) {
    const fixed = `/${loc.replace(/^[/\\]+/, '')}`.replace(/\\/g, '%5C');
    return fixed;
  }
  try {
    const u = new URL(loc);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || !u.hostname) return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

function authorityOf(to: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(to);
  return m ? m[0] : '';
}

// ==================================================================== compiled rules

interface Compiled {
  readonly rule: ResolvedRule;
  readonly index: number;
  test(n: NormPath): Record<string, string> | undefined;
}

function compile(rule: ResolvedRule, index: number, o: Required<Pick<Options, 'maxRegexInput'>>): Compiled {
  const cs = rule.caseSensitive;
  if (rule.kind === 'exact') {
    const want = stripSlash(cs ? normalizePath(rule.from)!.path : normalizePath(rule.from)!.lower);
    return { rule, index, test: (n) => (stripSlash(cs ? n.path : n.lower) === want ? {} : undefined) };
  }
  if (rule.kind === 'glob') {
    const segs = stripSlash(normalizePath(rule.from)!.path).split('/').slice(1);
    const splat = rule.from.replace(/\/+$/, '').endsWith('*');
    const fixed = splat ? segs.slice(0, -1) : segs;
    return {
      rule,
      index,
      test: (n) => {
        const have = stripSlash(n.path).split('/').slice(1).filter((_, i, a) => !(a.length === 1 && a[0] === ''));
        const rest = have.slice(fixed.length);
        if (splat ? have.length < fixed.length : have.length !== fixed.length) return undefined;
        const cap: Record<string, string> = {};
        for (let i = 0; i < fixed.length; i++) {
          const pat = fixed[i]!;
          const got = have[i]!;
          const m = GLOB_PARAM.exec(pat);
          if (m) {
            if (got === '') return undefined;
            cap[m[1]!] = got;
          } else if ((cs ? pat : pat.toLowerCase()) !== (cs ? got : got.toLowerCase())) return undefined;
        }
        if (splat) {
          cap['splat'] = rest.join('/');
        }
        return cap;
      },
    };
  }
  const re = new RegExp(rule.from, cs ? '' : 'i');
  return {
    rule,
    index,
    test: (n) => {
      const subject = n.path;
      if (subject.length > o.maxRegexInput) return undefined;
      const m = re.exec(subject);
      if (!m) return undefined;
      const cap: Record<string, string> = {};
      for (let i = 1; i < m.length; i++) cap[String(i)] = m[i] ?? '';
      return cap;
    },
  };
}

function fill(rule: ResolvedRule, cap: Record<string, string>): string {
  const to = rule.to!;
  if (rule.kind === 'regex') return to.replace(/\$([1-9])/g, (_m, d: string) => cap[d] ?? '');
  return to.replace(PLACEHOLDER, (m, name: string | undefined) => (name === undefined ? cap['splat'] ?? '' : name === 'splat' ? cap['splat'] ?? '' : cap[name] ?? m));
}

export interface Chain {
  readonly hops: readonly string[];
  readonly final: string;
  readonly status: Status | undefined;
  readonly loop: boolean;
  readonly tooLong: boolean;
  readonly ids: readonly string[];
}

export interface CheckReport {
  readonly loops: readonly { id: string; cycle: readonly string[] }[];
  readonly chains: readonly { id: string; hops: readonly string[]; final: string }[];
  readonly selfRedirects: readonly string[];
  readonly shadowed: readonly { id: string; by: string }[];
  readonly skipped: readonly string[];
}

export class RuleSet {
  readonly #o: Required<Omit<Options, 'now' | 'ownHosts'>> & { now: () => number; ownHosts: readonly string[] };
  #rules: ResolvedRule[] = [];
  #compiled: Compiled[] = [];
  #exact = new Map<string, Compiled[]>();
  #seq = 0;
  readonly #hits = new Map<string, { count: number; last: number }>();

  constructor(rules: readonly Rule[] = [], o: Options = {}) {
    this.#o = {
      now: o.now ?? (() => Date.now()),
      maxRules: o.maxRules ?? 50_000,
      maxPathLength: o.maxPathLength ?? 2048,
      maxRegexLength: o.maxRegexLength ?? 200,
      maxUnbounded: o.maxUnbounded ?? 3,
      maxRegexInput: o.maxRegexInput ?? 512,
      maxHops: o.maxHops ?? 10,
      ownHosts: (o.ownHosts ?? []).map((h) => h.toLowerCase()),
    };
    for (const r of rules) this.#push(this.#resolve(r));
    this.#rebuild();
  }

  /** Every problem with a rule, so they can be fixed at once. */
  problems(r: Rule): string[] {
    const out: string[] = [];
    const kind = r.kind ?? (typeof r.from === 'string' ? inferKind(r.from) : 'exact');
    const status = r.status ?? 301;
    if (typeof r.from !== 'string' || !r.from) return ['from is required'];
    if (!(STATUSES as readonly number[]).includes(status)) out.push(`status ${String(status)} is not one of ${STATUSES.join(', ')}`);
    if (status === 410) {
      if (r.to) out.push('a 410 rule has no destination');
    } else if (!r.to) out.push('a destination (to) is required');
    if (kind === 'regex') {
      const rep = regexRisk(r.from, { maxLength: this.#o.maxRegexLength, maxUnbounded: this.#o.maxUnbounded });
      out.push(...rep.reasons.map((x) => `regex: ${x}`));
      try {
        new RegExp(r.from);
      } catch (e) {
        out.push(`regex does not compile: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (r.to) {
        const used = [...r.to.matchAll(/\$([1-9])/g)].map((m) => Number(m[1]));
        if (used.some((n) => n > rep.groups)) out.push(`the destination uses $${Math.max(...used)} but the pattern has ${rep.groups} group${rep.groups === 1 ? '' : 's'}`);
        if (/\$[1-9]/.test(authorityOf(r.to))) out.push('the host part of the destination cannot be filled from the request');
      }
    } else {
      if (!r.from.startsWith('/')) out.push('from must start with /');
      else if (!normalizePath(r.from, this.#o.maxPathLength)) out.push('from is not a valid path');
      if (r.from.includes('?') || r.from.includes('#')) out.push('from is a path: query strings and fragments are not matched');
      if (kind === 'glob') {
        const segs = r.from.replace(/\/+$/, '').split('/').slice(1);
        const names = new Set<string>();
        segs.forEach((s, i) => {
          if (s.includes('*') && !(s === '*' && i === segs.length - 1)) out.push('* is only allowed as the last segment');
          const m = /^:(.*)$/.exec(s);
          if (m) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(m[1]!)) out.push(`"${s}" is not a placeholder name`);
            else if (names.has(m[1]!) || m[1] === 'splat') out.push(`placeholder :${m[1]} is repeated or reserved`);
            names.add(m[1]!);
          } else if (s.includes(':')) out.push(`"${s}" mixes text and a placeholder; a placeholder must be a whole segment`);
        });
        if (r.to) {
          const hasSplat = segs[segs.length - 1] === '*';
          const auth = authorityOf(r.to);
          for (const m of r.to.slice(auth.length).matchAll(PLACEHOLDER)) {
            const n = m[1];
            if (n === undefined ? !hasSplat : n === 'splat' ? !hasSplat : !names.has(n)) out.push(`the destination uses ${m[0]} which the pattern does not define`);
          }
          if (auth && /:[A-Za-z_]/.test(auth.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')) ) out.push('the host part of the destination cannot be filled from the request');
        }
      }
    }
    if (r.to !== undefined && r.to !== '') {
      const filled = r.to.replace(/\$[1-9]/g, 'x').replace(/:[A-Za-z_][A-Za-z0-9_]*/g, (m, off: number, s: string) => (/^[a-z][a-z0-9+.-]*$/i.test(s.slice(0, off)) ? m : 'x')).replace(/\*/g, 'x');
      if (/^\/[/\\]/.test(r.to)) out.push('a protocol-relative destination is not allowed');
      else if (safeLocation(filled) === undefined) out.push('the destination is not a path or an http(s) URL without credentials');
    }
    if (r.methods?.some((m) => !/^[A-Za-z]{3,10}$/.test(m))) out.push('methods must be HTTP method names');
    if (r.hosts?.some((h) => !/^[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/.test(h))) out.push('hosts must be host names');
    if (r.priority !== undefined && !Number.isFinite(r.priority)) out.push('priority must be a number');
    return out;
  }

  #resolve(r: Rule): ResolvedRule {
    const p = this.problems(r);
    if (p.length) throw new RedirectRuleError(p);
    const id = r.id ?? `r${++this.#seq}`;
    return {
      id,
      from: r.from,
      status: (r.status ?? 301) as Status,
      kind: r.kind ?? inferKind(r.from),
      caseSensitive: r.caseSensitive ?? false,
      query: r.query ?? 'keep',
      priority: r.priority ?? 100,
      enabled: r.enabled ?? true,
      ...(r.to !== undefined ? { to: r.to } : {}),
      ...(r.methods ? { methods: r.methods.map((m) => m.toUpperCase()) } : {}),
      ...(r.hosts ? { hosts: r.hosts.map((h) => h.toLowerCase()) } : {}),
      ...(r.note !== undefined ? { note: r.note } : {}),
      ...(r.sample !== undefined ? { sample: r.sample } : {}),
    };
  }

  #push(r: ResolvedRule): void {
    if (this.#rules.some((x) => x.id === r.id)) throw new RedirectRuleError([`id "${r.id}" is already used`]);
    if (this.#rules.length >= this.#o.maxRules) throw new RedirectRuleError([`more than ${this.#o.maxRules} rules`]);
    this.#rules.push(r);
  }

  #rebuild(): void {
    const sorted = this.#rules.map((r, i) => ({ r, i })).sort((a, b) => a.r.priority - b.r.priority || a.i - b.i);
    this.#compiled = sorted.map(({ r }, i) => compile(r, i, this.#o));
    this.#exact = new Map();
  }

  add(r: Rule): ResolvedRule {
    const rr = this.#resolve(r);
    this.#push(rr);
    this.#rebuild();
    return rr;
  }

  remove(id: string): boolean {
    const n = this.#rules.length;
    this.#rules = this.#rules.filter((r) => r.id !== id);
    this.#hits.delete(id);
    if (this.#rules.length === n) return false;
    this.#rebuild();
    return true;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const i = this.#rules.findIndex((r) => r.id === id);
    if (i < 0) return false;
    this.#rules[i] = { ...this.#rules[i]!, enabled };
    this.#rebuild();
    return true;
  }

  list(): readonly ResolvedRule[] {
    return this.#compiled.map((c) => c.rule);
  }
  get size(): number {
    return this.#rules.length;
  }

  /** The first rule that applies to a request, with the status and destination to send. Counts a hit. */
  match(req: Request, o: { record?: boolean } = {}): Match | undefined {
    const m = this.#find(req);
    if (m && o.record !== false) {
      const h = this.#hits.get(m.rule.id) ?? { count: 0, last: 0 };
      h.count++;
      h.last = this.#o.now();
      this.#hits.set(m.rule.id, h);
    }
    return m;
  }

  #find(req: Request): Match | undefined {
    const n = normalizePath(req.path, this.#o.maxPathLength);
    if (!n) return undefined;
    const method = (req.method ?? 'GET').toUpperCase();
    const host = req.host?.toLowerCase();
    for (const c of this.#compiled) {
      const r = c.rule;
      if (!r.enabled) continue;
      if (r.methods && !r.methods.includes(method)) continue;
      if (r.hosts && (host === undefined || !r.hosts.includes(host))) continue;
      const cap = c.test(n);
      if (!cap) continue;
      if (r.status === 410) return { rule: r, status: 410 };
      const status = this.#statusFor(r.status, method);
      let loc = fill(r, cap);
      const safe = safeLocation(loc);
      if (safe === undefined) continue;
      loc = safe;
      const q = (req.query ?? '').replace(/^\?/, '');
      if (r.query === 'keep' && q && !/[\u0000-\u001f\u007f\s#]/.test(q)) loc += `${loc.includes('?') ? '&' : '?'}${q}`;
      return { rule: r, status, location: loc };
    }
    return undefined;
  }

  /** 301 and 302 become 308 and 307 for anything but GET and HEAD, so the method and body are kept. */
  #statusFor(s: Status, method: string): Status {
    if (method === 'GET' || method === 'HEAD') return s;
    return s === 301 ? 308 : s === 302 ? 307 : s;
  }

  // ---------------------------------------------------------------- chains and checks

  /** Follow redirects from a path through this set, as a client would, until it settles, loops, or runs long. */
  follow(path: string, o: { method?: string; host?: string } = {}): Chain {
    const hops: string[] = [path];
    const ids: string[] = [];
    let cur = path;
    let status: Status | undefined;
    for (let i = 0; i < this.#o.maxHops; i++) {
      const m = this.#find({ path: cur, ...(o.method ? { method: o.method } : {}), ...(o.host ? { host: o.host } : {}), query: '' });
      if (!m || !m.location) {
        if (m) {
          ids.push(m.rule.id);
          status = m.status;
        }
        return { hops, final: cur, status, loop: false, tooLong: false, ids };
      }
      ids.push(m.rule.id);
      status = m.status;
      let next = m.location;
      if (!next.startsWith('/')) {
        const u = new URL(next);
        if (!this.#o.ownHosts.includes(u.host.toLowerCase())) {
          hops.push(next);
          return { hops, final: next, status, loop: false, tooLong: false, ids };
        }
        next = u.pathname + u.search;
      }
      const key = (x: string) => stripSlash(normalizePath(x)?.lower ?? x);
      if (hops.some((h) => key(h) === key(next))) {
        hops.push(next);
        return { hops, final: next, status, loop: true, tooLong: false, ids };
      }
      hops.push(next);
      cur = next;
    }
    return { hops, final: cur, status, loop: false, tooLong: true, ids };
  }

  #sample(r: ResolvedRule): string | undefined {
    if (r.kind === 'exact') return r.from;
    if (r.kind === 'glob') return r.from.replace(/\/\*$/, '/x/y').replace(/:[A-Za-z_][A-Za-z0-9_]*/g, 'x');
    return r.sample;
  }

  /** Loops, chains, self-redirects and shadowed rules across the whole set. */
  check(): CheckReport {
    const loops: { id: string; cycle: readonly string[] }[] = [];
    const chains: { id: string; hops: readonly string[]; final: string }[] = [];
    const self: string[] = [];
    const shadowed: { id: string; by: string }[] = [];
    const skipped: string[] = [];
    const seenCycles = new Set<string>();
    for (const c of this.#compiled) {
      const r = c.rule;
      if (!r.enabled) continue;
      const s = this.#sample(r);
      if (s === undefined) {
        skipped.push(r.id);
        continue;
      }
      const first = this.#find({ path: s, query: '', ...(r.methods?.[0] ? { method: r.methods[0] } : {}), ...(r.hosts?.[0] ? { host: r.hosts[0] } : {}) });
      if (first && first.rule.id !== r.id) shadowed.push({ id: r.id, by: first.rule.id });
      if (r.status === 410 || !r.to) continue;
      if (r.kind !== 'regex' && stripSlash(normalizePath(r.to)?.lower ?? r.to) === stripSlash(normalizePath(r.from)?.lower ?? r.from)) self.push(r.id);
      const ch = this.follow(s, { ...(r.methods?.[0] ? { method: r.methods[0] } : {}), ...(r.hosts?.[0] ? { host: r.hosts[0] } : {}) });
      if (ch.loop) {
        const idx = ch.hops.findIndex((h) => stripSlash(normalizePath(h)?.lower ?? h) === stripSlash(normalizePath(ch.final)?.lower ?? ch.final));
        const cycle = ch.hops.slice(idx, -1).map((h) => stripSlash(normalizePath(h)?.lower ?? h));
        const key = [...cycle].sort().join('|');
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          loops.push({ id: r.id, cycle });
        }
      } else if (ch.hops.length > 2) chains.push({ id: r.id, hops: ch.hops, final: ch.final });
    }
    return { loops, chains, selfRedirects: self, shadowed, skipped };
  }

  /** Rules rewritten so a static chain A to B to C goes A to C. Loops and pattern rules are left alone. */
  flatten(): Rule[] {
    const out: Rule[] = [];
    for (const r of this.list()) {
      const base: Rule = { id: r.id, from: r.from, kind: r.kind, status: r.status, caseSensitive: r.caseSensitive, query: r.query, priority: r.priority, enabled: r.enabled, ...(r.to !== undefined ? { to: r.to } : {}), ...(r.methods ? { methods: r.methods } : {}), ...(r.hosts ? { hosts: r.hosts } : {}), ...(r.note !== undefined ? { note: r.note } : {}), ...(r.sample !== undefined ? { sample: r.sample } : {}) };
      if (r.kind === 'exact' && r.to && r.status !== 410 && r.to.startsWith('/') && !/[:*]/.test(r.to)) {
        const ch = this.follow(r.to);
        if (!ch.loop && !ch.tooLong && (ch.hops.length > 1 || ch.status === 410)) {
          const { to: _drop, ...noTo } = base;
          out.push(ch.status === 410 ? { ...noTo, status: 410 } : { ...base, to: ch.final });
          continue;
        }
      }
      out.push(base);
    }
    return out;
  }

  // ---------------------------------------------------------------- hits

  hits(id: string): { count: number; last: number } | undefined {
    const h = this.#hits.get(id);
    return h ? { ...h } : undefined;
  }

  /** Rules by hits, most used first. */
  stats(): { id: string; from: string; count: number; last?: number }[] {
    return this.list().map((r) => {
      const h = this.#hits.get(r.id);
      return { id: r.id, from: r.from, count: h?.count ?? 0, ...(h ? { last: h.last } : {}) };
    }).sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1));
  }

  /** Enabled rules with no hit in the last `ms` milliseconds (or ever). */
  unused(ms: number): string[] {
    const cutoff = this.#o.now() - ms;
    return this.list().filter((r) => r.enabled && (this.#hits.get(r.id)?.last ?? -Infinity) < cutoff).map((r) => r.id);
  }

  resetHits(): void {
    this.#hits.clear();
  }
}

// ==================================================================== CSV (RFC 4180)

export function parseCsv(text: string, o: { maxRows?: number; maxField?: number } = {}): string[][] {
  const maxRows = o.maxRows ?? 20_000;
  const maxField = o.maxField ?? 4096;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  let any = false;
  const end = () => {
    row.push(f);
    f = '';
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += c;
    } else if (c === '"' && f === '') {
      q = true;
      any = true;
    } else if (c === ',') {
      end();
      any = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      end();
      if (row.length > 1 || row[0] !== '' || any) rows.push(row);
      row = [];
      any = false;
      if (rows.length > maxRows) throw new CsvError(`more than ${maxRows} rows`);
    } else {
      if (c === '"') throw new CsvError(`a quote in the middle of an unquoted field near character ${i}`);
      f += c;
    }
    if (f.length > maxField) throw new CsvError(`a field is longer than ${maxField} characters`);
  }
  if (q) throw new CsvError('a quoted field is never closed');
  if (f !== '' || row.length > 0 || any) {
    end();
    rows.push(row);
  }
  return rows;
}

export interface ImportResult {
  readonly rules: Rule[];
  readonly errors: { line: number; message: string }[];
}

const HEADER = new Set(['from', 'source', 'old', 'url', 'path', 'to', 'target', 'destination', 'new', 'status', 'code', 'type', 'kind']);

/** Rules from CSV text: from, to, then optional status and kind, with or without a header row. Bad rows are listed, not fatal. */
export function importCsv(text: string, set: RuleSet = new RuleSet()): ImportResult {
  const rows = parseCsv(text);
  const errors: ImportResult['errors'] = [];
  const rules: Rule[] = [];
  let cols = { from: 0, to: 1, status: 2, kind: 3 };
  let start = 0;
  if (rows[0] && rows[0].some((c) => HEADER.has(c.trim().toLowerCase())) && !rows[0].some((c) => c.trim().startsWith('/') || c.trim().startsWith('^'))) {
    const h = rows[0].map((c) => c.trim().toLowerCase());
    const at = (...names: string[]) => h.findIndex((x) => names.includes(x));
    cols = { from: at('from', 'source', 'old', 'url', 'path'), to: at('to', 'target', 'destination', 'new'), status: at('status', 'code'), kind: at('type', 'kind') };
    if (cols.from < 0) throw new CsvError('the header has no from column');
    start = 1;
  }
  const ids = new Set<string>();
  for (let i = start; i < rows.length; i++) {
    const r = rows[i]!;
    const line = i + 1;
    const cell = (k: number) => (k >= 0 && k < r.length ? r[k]!.trim().replace(/^'(?=[=+\-@\t\r])/, '') : '');
    const from = cell(cols.from);
    const to = cell(cols.to);
    const sRaw = cell(cols.status);
    const kRaw = cell(cols.kind).toLowerCase();
    if (!from && !to && !sRaw) continue;
    const status = sRaw === '' ? (to ? 301 : 410) : /^\d{3}$/.test(sRaw) ? Number(sRaw) : Number.NaN;
    if (Number.isNaN(status)) {
      errors.push({ line, message: `status "${sRaw.slice(0, 20)}" is not a number` });
      continue;
    }
    if (kRaw && !['exact', 'glob', 'regex'].includes(kRaw)) {
      errors.push({ line, message: `kind "${kRaw.slice(0, 20)}" is not exact, glob or regex` });
      continue;
    }
    const rule: Rule = { from, ...(to ? { to } : {}), status, ...(kRaw ? { kind: kRaw as Kind } : {}) };
    const problems = set.problems(rule);
    if (problems.length) {
      errors.push({ line, message: problems.join('; ') });
      continue;
    }
    const dupKey = `${rule.kind ?? inferKind(from)}\u0000${(rule.kind ?? inferKind(from)) === 'regex' ? from : stripSlash(normalizePath(from)!.lower)}`;
    if (ids.has(dupKey)) {
      errors.push({ line, message: `a rule for ${from} appeared earlier in the file` });
      continue;
    }
    ids.add(dupKey);
    rules.push(rule);
  }
  return { rules, errors };
}

const csvField = (v: string): string => {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function exportCsv(rules: readonly Pick<ResolvedRule, 'from' | 'to' | 'status' | 'kind'>[]): string {
  return `${['from,to,status,kind', ...rules.map((r) => [r.from, r.to ?? '', String(r.status), r.kind].map(csvField).join(','))].join('\r\n')}\r\n`;
}
