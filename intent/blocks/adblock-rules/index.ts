/**
 * Adblock-style filter rules: a parser and a matcher for the syntax Adblock Plus, uBlock Origin and AdGuard lists
 * share, as documented in the Adblock Plus filter guide. A rule names a domain, a path or a pattern, with options
 * after a `$`. Supported: `||domain^` anchors, `|` start and end anchors, `*` wildcards, the `^` separator,
 * `/regex/` rules, `@@` exceptions, comments (`!`), the `[Adblock Plus 2.0]` header, and the options `script`,
 * `image`, `stylesheet`, `font`, `media`, `xmlhttprequest`, `subdocument`, `document`, `ping`, `websocket`, `other`
 * (each negated with `~`), `third-party` / `~third-party` (and `3p` / `1p`), `domain=a.com|~b.com`, `important`,
 * `match-case` and `badfilter`.
 *
 * Decision order, as lists define it: an `important` block wins over everything; otherwise an exception rule
 * (`@@`) beats a block rule; otherwise a block rule blocks. A `badfilter` rule switches off the rule whose text it
 * repeats. Element-hiding rules (`##`, `#@#`, `#?#`) are recognised and kept apart; they are not request rules.
 *
 * Safe by default: a line over 2000 characters, an option it does not know, a regex over 512 characters or with a
 * nested repeat that could run for ever, and a pattern that is only wildcards are refused with a typed error, and
 * `parseList` reports each bad line by number instead of dropping the list.
 *
 * Out of scope: scriptlets and redirect resources, `$removeparam`, `$csp`, and cosmetic rule application.
 * "Third party" compares registrable domains with a small built-in suffix list; pass `registrableDomain` to use
 * the full Public Suffix List.
 */

export class RuleError extends Error {
  readonly line: string;
  constructor(message: string, line: string) {
    super(message);
    this.name = 'RuleError';
    this.line = line.length > 120 ? `${line.slice(0, 120)}...` : line;
  }
}

export const REQUEST_TYPES = ['script', 'image', 'stylesheet', 'font', 'media', 'xmlhttprequest', 'subdocument', 'document', 'ping', 'websocket', 'other'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const MAX_LINE = 2000;
export const MAX_REGEX = 512;

export interface RuleOptions {
  /** Types the rule is limited to; empty means every type except `document`. */
  readonly types: readonly RequestType[];
  /** Types the rule never applies to. */
  readonly notTypes: readonly RequestType[];
  /** true: third-party requests only; false: first-party only; undefined: either. */
  readonly thirdParty: boolean | undefined;
  readonly domains: readonly string[];
  readonly notDomains: readonly string[];
  readonly important: boolean;
  readonly matchCase: boolean;
  readonly badfilter: boolean;
}

export interface NetworkRule {
  readonly kind: 'network';
  /** The line as written. */
  readonly text: string;
  readonly exception: boolean;
  /** The pattern part without the `@@` and the options. */
  readonly pattern: string;
  readonly isRegex: boolean;
  readonly options: RuleOptions;
  /** For `||host^` rules, the host the pattern is anchored to; used to index the rule. */
  readonly anchorHost: string | undefined;
  readonly re: RegExp;
}

export interface CosmeticRule {
  readonly kind: 'cosmetic';
  readonly text: string;
  readonly exception: boolean;
  /** Domains the rule is limited to; empty means everywhere. */
  readonly domains: readonly string[];
  readonly selector: string;
}

export type Rule = NetworkRule | CosmeticRule;

const OPTION_TYPE = new Set<string>(REQUEST_TYPES);

/** Two-label public suffixes the built-in registrable-domain guess knows about. */
const TWO_LABEL_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.in', 'com.br', 'com.cn', 'com.mx', 'co.za', 'github.io', 'herokuapp.com', 'appspot.com']);

export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(h) || h.includes(':')) return h;
  const labels = h.split('.');
  if (labels.length <= 2) return h;
  const last2 = labels.slice(-2).join('.');
  return TWO_LABEL_SUFFIXES.has(last2) ? labels.slice(-3).join('.') : last2;
}

const hostOk = (d: string) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(d) && !d.includes('..');

function parseOptions(raw: string, line: string): RuleOptions {
  const types: RequestType[] = [];
  const notTypes: RequestType[] = [];
  let thirdParty: boolean | undefined;
  let domains: string[] = [];
  let notDomains: string[] = [];
  let important = false;
  let matchCase = false;
  let badfilter = false;
  for (const part of raw.split(',')) {
    const opt = part.trim();
    if (opt === '') throw new RuleError('an empty option', line);
    const neg = opt.startsWith('~');
    const name = (neg ? opt.slice(1) : opt).toLowerCase();
    if (name.startsWith('domain=')) {
      if (neg) throw new RuleError('domain= cannot be negated as a whole', line);
      domains = [];
      notDomains = [];
      for (const d0 of opt.slice(7).split('|')) {
        const n = d0.startsWith('~');
        const d = (n ? d0.slice(1) : d0).toLowerCase();
        if (!hostOk(d)) throw new RuleError(`${JSON.stringify(d0)} is not a domain`, line);
        (n ? notDomains : domains).push(d);
      }
      continue;
    }
    if (OPTION_TYPE.has(name)) {
      (neg ? notTypes : types).push(name as RequestType);
    } else if (name === 'third-party' || name === '3p') {
      thirdParty = !neg;
    } else if (name === 'first-party' || name === '1p') {
      thirdParty = neg;
    } else if (name === 'important' && !neg) {
      important = true;
    } else if (name === 'match-case' && !neg) {
      matchCase = true;
    } else if (name === 'badfilter' && !neg) {
      badfilter = true;
    } else {
      throw new RuleError(`unknown option ${JSON.stringify(opt)}`, line);
    }
  }
  return { types, notTypes, thirdParty, domains, notDomains, important, matchCase, badfilter };
}

const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** Nested repeats such as (a+)+ or (a*)* can take exponential time; refuse them. */
function dangerousRegex(src: string): boolean {
  return /\([^()]*[+*][^()]*\)[+*{]/.test(src);
}

function compilePattern(pattern: string, matchCase: boolean, line: string): { re: RegExp; anchorHost: string | undefined } {
  let p = pattern.replace(/\*{2,}/g, '*');
  let src = '';
  let anchorHost: string | undefined;
  if (p.startsWith('||')) {
    p = p.slice(2);
    src += '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#:]*\\.)?';
    const m = /^[a-z0-9.-]+/i.exec(p);
    if (m && /^(?:[\^/*?:|]|$)/.test(p.slice(m[0].length)) && !p.slice(m[0].length).startsWith('*')) anchorHost = m[0].toLowerCase();
  } else if (p.startsWith('|')) {
    p = p.slice(1);
    src += '^';
  }
  let endAnchor = false;
  if (p.endsWith('|')) {
    p = p.slice(0, -1);
    endAnchor = true;
  }
  if (/^\**$/.test(p) && !src) throw new RuleError('a pattern of only wildcards would match everything', line);
  for (const ch of p) {
    if (ch === '*') src += '.*';
    else if (ch === '^') src += '(?:[^\\w.%-]|$)';
    else src += escapeRe(ch);
  }
  if (endAnchor) src += '$';
  return { re: new RegExp(src, matchCase ? '' : 'i'), anchorHost };
}

/** Split `pattern$options`. A `$` inside a regex rule or without a valid option tail belongs to the pattern. */
function splitOptions(body: string): [string, string | undefined] {
  const i = body.lastIndexOf('$');
  if (i < 0) return [body, undefined];
  const tail = body.slice(i + 1);
  if (/^[~a-z0-9_=|.,-]+$/i.test(tail) && !tail.includes('/')) return [body.slice(0, i), tail];
  return [body, undefined];
}

/** Read one line. Returns undefined for blank lines, comments and the list header. Throws RuleError for bad rules. */
export function parseRule(line0: string): Rule | undefined {
  const line = line0.trim();
  if (line === '' || line.startsWith('!') || /^\[(?:adblock|ublock|adguard)[^\]]*\]$/i.test(line)) return undefined;
  if (line.length > MAX_LINE) throw new RuleError(`a rule over ${MAX_LINE} characters`, line);
  const cos = /^([^/*|@"!]*?)(#@?\??#)(.+)$/.exec(line);
  if (cos && !line.startsWith('/')) {
    const marker = cos[2]!;
    return {
      kind: 'cosmetic',
      text: line,
      exception: marker.includes('@'),
      domains: cos[1]!.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
      selector: cos[3]!,
    };
  }
  let body = line;
  let exception = false;
  if (body.startsWith('@@')) {
    exception = true;
    body = body.slice(2);
  }
  let pattern = body;
  let rawOpts: string | undefined;
  const isRegexForm = /^\/.+\/(?:\$[^/]*)?$/.test(body);
  if (isRegexForm) {
    const j = body.lastIndexOf('/');
    pattern = body.slice(0, j + 1);
    rawOpts = body.length > j + 2 ? body.slice(j + 2) : undefined;
  } else {
    [pattern, rawOpts] = splitOptions(body);
  }
  const options = rawOpts === undefined ? emptyOptions() : parseOptions(rawOpts, line);
  if (pattern === '') throw new RuleError('a rule with no pattern', line);
  if (isRegexForm) {
    const src = pattern.slice(1, -1);
    if (src.length > MAX_REGEX) throw new RuleError(`a regex over ${MAX_REGEX} characters`, line);
    if (dangerousRegex(src)) throw new RuleError('a regex with a nested repeat that could run for ever', line);
    let re: RegExp;
    try {
      re = new RegExp(src, options.matchCase ? '' : 'i');
    } catch {
      throw new RuleError('a regex that does not compile', line);
    }
    return { kind: 'network', text: line, exception, pattern, isRegex: true, options, anchorHost: undefined, re };
  }
  const { re, anchorHost } = compilePattern(pattern, options.matchCase, line);
  return { kind: 'network', text: line, exception, pattern, isRegex: false, options, anchorHost, re };
}

function emptyOptions(): RuleOptions {
  return { types: [], notTypes: [], thirdParty: undefined, domains: [], notDomains: [], important: false, matchCase: false, badfilter: false };
}

export interface ParsedList {
  readonly rules: Rule[];
  readonly errors: { readonly line: number; readonly message: string }[];
  readonly comments: number;
}

/** Parse a whole list. Bad lines are reported by number; the rest still load. */
export function parseList(text: string): ParsedList {
  const rules: Rule[] = [];
  const errors: { line: number; message: string }[] = [];
  let comments = 0;
  text.split(/\r?\n/).forEach((l, i) => {
    try {
      const r = parseRule(l);
      if (r) rules.push(r);
      else if (l.trim() !== '') comments++;
    } catch (e) {
      if (e instanceof RuleError) errors.push({ line: i + 1, message: e.message });
      else throw e;
    }
  });
  return { rules, errors, comments };
}

export interface Request {
  readonly url: string;
  readonly type?: RequestType;
  /** The page that made the request, as a URL or host name; absent means a top-level navigation. */
  readonly page?: string;
}

export interface Decision {
  readonly blocked: boolean;
  /** The rule that decided, when one did. */
  readonly rule: NetworkRule | undefined;
  /** True when an exception rule let the request through. */
  readonly excepted: boolean;
}

const hostOf = (s: string): string => {
  try {
    return new URL(s.includes('://') ? s : `http://${s}`).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
};

const inDomain = (host: string, d: string) => host === d || host.endsWith(`.${d}`);

export class Matcher {
  readonly #byHost = new Map<string, NetworkRule[]>();
  readonly #general: NetworkRule[] = [];
  readonly #registrable: (host: string) => string;
  /** Texts of rules switched off by a badfilter rule. */
  readonly disabled: ReadonlySet<string>;

  constructor(rules: readonly Rule[], o: { registrableDomain?: (host: string) => string } = {}) {
    this.#registrable = o.registrableDomain ?? registrableDomain;
    const off = new Set<string>();
    const net = rules.filter((r): r is NetworkRule => r.kind === 'network');
    for (const r of net) if (r.options.badfilter) off.add(this.#key(r));
    this.disabled = off;
    for (const r of net) {
      if (r.options.badfilter || off.has(this.#key(r))) continue;
      if (r.anchorHost) {
        const list = this.#byHost.get(r.anchorHost) ?? [];
        list.push(r);
        this.#byHost.set(r.anchorHost, list);
      } else this.#general.push(r);
    }
  }

  /** A rule's identity for badfilter: its text with the exception mark kept and `badfilter` removed. */
  #key(r: NetworkRule): string {
    const t = r.text.replace(/,?badfilter/i, '').replace(/\$$/, '');
    return t.replace(/\$,/, '$');
  }

  #applies(r: NetworkRule, req: Request, pageHost: string, third: boolean): boolean {
    const o = r.options;
    const type: RequestType = req.type ?? 'other';
    if (o.types.length ? !o.types.includes(type) : type === 'document') return false;
    if (o.notTypes.includes(type)) return false;
    if (o.thirdParty !== undefined && o.thirdParty !== third) return false;
    if (o.domains.length || o.notDomains.length) {
      if (!pageHost) return false;
      if (o.notDomains.some((d) => inDomain(pageHost, d))) return false;
      if (o.domains.length && !o.domains.some((d) => inDomain(pageHost, d))) return false;
    }
    return r.re.test(req.url);
  }

  /** Decide one request. */
  match(req: Request): Decision {
    const host = hostOf(req.url);
    if (!host) return { blocked: false, rule: undefined, excepted: false };
    const pageHost = req.page ? hostOf(req.page) : '';
    const third = pageHost !== '' && this.#registrable(host) !== this.#registrable(pageHost);
    const candidates: NetworkRule[] = [];
    const labels = host.split('.');
    for (let i = 0; i < labels.length; i++) {
      const hit = this.#byHost.get(labels.slice(i).join('.'));
      if (hit) candidates.push(...hit);
    }
    candidates.push(...this.#general);
    let block: NetworkRule | undefined;
    let allow: NetworkRule | undefined;
    for (const r of candidates) {
      if (!this.#applies(r, req, pageHost, third)) continue;
      if (r.exception) allow ??= r;
      else if (r.options.important) return { blocked: true, rule: r, excepted: false };
      else block ??= r;
    }
    if (block && allow) return { blocked: false, rule: allow, excepted: true };
    if (block) return { blocked: true, rule: block, excepted: false };
    if (allow) return { blocked: false, rule: allow, excepted: false };
    return { blocked: false, rule: undefined, excepted: false };
  }
}

/** Element-hiding selectors for a page host: those whose domains include it, less the ones an exception removes. */
export function cosmeticSelectors(rules: readonly Rule[], pageHost: string): string[] {
  const host = pageHost.toLowerCase();
  const cos = rules.filter((r): r is CosmeticRule => r.kind === 'cosmetic');
  const applies = (r: CosmeticRule) => r.domains.length === 0 || r.domains.some((d) => (d.startsWith('~') ? false : inDomain(host, d))) && !r.domains.some((d) => d.startsWith('~') && inDomain(host, d.slice(1)));
  const removed = new Set(cos.filter((r) => r.exception && applies(r)).map((r) => r.selector));
  return [...new Set(cos.filter((r) => !r.exception && applies(r) && !removed.has(r.selector)).map((r) => r.selector))];
}
