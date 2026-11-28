/**
 * DNS filtering: blocklists and allow-lists, matched against the name in a DNS query, with groups of clients that
 * each get their own policy, a block answer in the shape the client asked for, and a query log that sums up.
 *
 * Lists come in three text forms, read by `parseList`: hosts files (`0.0.0.0 ads.example.com`), plain domain
 * lists (one name per line; `*.example.com` means every subdomain; a `*` inside a name is a glob) and Adblock-style
 * domain rules (`||ads.example.com^`, `@@||ok.example.com^` for an exception, `/regex/`). Names are matched on
 * the DNS label tree with a suffix trie, so a rule for `example.com` also blocks `a.b.example.com` in one walk,
 * however many rules are loaded. Names are normalised with the dns-wire block (RFC 4343 case folding, RFC 1035
 * limits), and a name that cannot be a DNS name is refused rather than matched.
 *
 * Policy: a client (an IPv4 or IPv6 address, or a CIDR range) belongs to groups; a group switches lists on; a
 * client in no group gets the `default` group. An allow entry from any list in force beats a block entry
 * (allow-list wins, as in Pi-hole and AdGuard Home). A block answers by the configured mode: a null address
 * (0.0.0.0 / ::; other types get an empty NOERROR answer), NXDOMAIN or REFUSED. `inspectResponse` re-checks the
 * CNAME chain of an upstream answer so a tracker hidden behind an innocent name is still blocked (CNAME cloaking).
 *
 * Out of scope: forwarding queries, caching, DNSSEC, DoH/DoT transport, and downloading lists. Regexes in lists
 * are limited in length and refused when they nest repeats.
 */
import { canonicalName, decode, encode, formatIPv4, parseIPv4, parseIPv6, typeName, type DnsRecord, type Message } from '../dns-wire/index.ts';

export class FilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilterError';
  }
}

export type ListKind = 'block' | 'allow';
export type EntryKind = 'suffix' | 'exact' | 'subdomains' | 'glob' | 'regex';

export interface Entry {
  readonly action: ListKind;
  readonly kind: EntryKind;
  /** The domain, or the glob, or the regex source. */
  readonly value: string;
  readonly list: string;
}

export interface ParsedEntries {
  readonly entries: Omit<Entry, 'list'>[];
  readonly errors: { readonly line: number; readonly message: string }[];
  /** Hosts lines that point a name at a real address (local overrides): not filter rules, so not loaded. */
  readonly skipped: number;
}

const MAX_REGEX = 256;
const NULL_ADDRS = new Set(['0.0.0.0', '127.0.0.1', '::', '::1', '0:0:0:0:0:0:0:0', '0:0:0:0:0:0:0:1']);
const LOCAL_NAMES = new Set(['localhost', 'localhost.localdomain', 'local', 'broadcasthost', 'ip6-localhost', 'ip6-loopback', 'ip6-localnet', 'ip6-mcastprefix', 'ip6-allnodes', 'ip6-allrouters', 'ip6-allhosts', '0.0.0.0']);

/** A name as the filter keys it: lower case, no trailing dot. Throws FilterError when it cannot be a DNS name. */
export function normalizeName(name: string): string {
  try {
    const c = canonicalName(name.trim());
    return c === '.' ? '.' : c.replace(/\.$/, '');
  } catch {
    throw new FilterError(`${JSON.stringify(name.length > 80 ? `${name.slice(0, 80)}...` : name)} is not a DNS name`);
  }
}

function checkRegex(src: string): void {
  if (src.length > MAX_REGEX) throw new FilterError(`a regex over ${MAX_REGEX} characters`);
  if (/\([^()]*[+*][^()]*\)[+*{]/.test(src)) throw new FilterError('a regex with a nested repeat that could run for ever');
  try {
    new RegExp(src, 'i');
  } catch {
    throw new FilterError('a regex that does not compile');
  }
}

function domainEntry(raw: string, action: ListKind, form: 'domain' | 'adblock'): Omit<Entry, 'list'> {
  let t = raw.trim();
  if (t.startsWith('/') && t.endsWith('/') && t.length > 2) {
    const src = t.slice(1, -1);
    checkRegex(src);
    return { action, kind: 'regex', value: src };
  }
  if (form === 'adblock') {
    const m = /^\|\|([^^/$|]+)\^?(?:\$.*)?$/.exec(t);
    if (!m) throw new FilterError('not a domain rule');
    t = m[1]!;
  }
  if (t.startsWith('*.') && !t.slice(2).includes('*')) return { action, kind: 'subdomains', value: normalizeName(t.slice(2)) };
  if (t.includes('*')) {
    if (/^[*.]*$/.test(t)) throw new FilterError('a pattern of only wildcards would match everything');
    return { action, kind: 'glob', value: t.toLowerCase().replace(/\.$/, '') };
  }
  return { action, kind: 'suffix', value: normalizeName(t) };
}

/** Read a list in one of its three forms. Bad lines are reported by number and skipped. */
export function parseList(text: string, form: 'hosts' | 'domains' | 'adblock', kind: ListKind = 'block'): ParsedEntries {
  const entries: Omit<Entry, 'list'>[] = [];
  const errors: { line: number; message: string }[] = [];
  let skipped = 0;
  text.split(/\r?\n/).forEach((raw, i) => {
    let line = raw.replace(/\s+#.*$/, '').trim();
    if (form === 'adblock') line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!') || (form === 'adblock' && /^\[.*\]$/.test(line))) return;
    if (line.length > 2000) {
      errors.push({ line: i + 1, message: 'a line over 2000 characters' });
      return;
    }
    try {
      if (form === 'hosts') {
        const [ip, ...names] = line.split(/\s+/);
        if (!ip || names.length === 0) throw new FilterError('a hosts line needs an address and a name');
        try {
          if (ip.includes(':')) parseIPv6(ip);
          else parseIPv4(ip);
        } catch {
          throw new FilterError(`${JSON.stringify(ip)} is not an address`);
        }
        if (!NULL_ADDRS.has(ip.toLowerCase())) {
          skipped++;
          return;
        }
        for (const n of names) {
          if (LOCAL_NAMES.has(n.toLowerCase())) continue;
          entries.push({ action: kind, kind: 'exact', value: normalizeName(n) });
        }
      } else if (form === 'adblock') {
        if (line.startsWith('@@')) entries.push(domainEntry(line.slice(2), 'allow', 'adblock'));
        else if (/^(?:##|[^|/]*#@?#)/.test(line) || line.includes('##')) return;
        else entries.push(domainEntry(line, kind, 'adblock'));
      } else {
        entries.push(domainEntry(line, kind, 'domain'));
      }
    } catch (e) {
      if (e instanceof FilterError) errors.push({ line: i + 1, message: e.message });
      else throw e;
    }
  });
  return { entries, errors, skipped };
}

interface TrieNode {
  readonly kids: Map<string, TrieNode>;
  suffix: Entry[];
  exact: Entry[];
  subdomains: Entry[];
}
const node = (): TrieNode => ({ kids: new Map(), suffix: [], exact: [], subdomains: [] });

const globRe = (g: string): RegExp => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]*')}$`, 'i');

/** Domain rules held as a trie of labels, last label first, plus the few glob and regex rules in lists. */
export class RuleSet {
  readonly #root = node();
  readonly #patterns: { entry: Entry; re: RegExp }[] = [];
  #count = 0;

  get size(): number {
    return this.#count;
  }

  add(e: Entry): void {
    this.#count++;
    if (e.kind === 'glob' || e.kind === 'regex') {
      this.#patterns.push({ entry: e, re: e.kind === 'glob' ? globRe(e.value) : new RegExp(e.value, 'i') });
      return;
    }
    let n = this.#root;
    const labels = e.value === '.' ? [] : e.value.split('.');
    for (let i = labels.length - 1; i >= 0; i--) {
      const l = labels[i]!;
      let k = n.kids.get(l);
      if (!k) n.kids.set(l, (k = node()));
      n = k;
    }
    (e.kind === 'suffix' ? n.suffix : e.kind === 'exact' ? n.exact : n.subdomains).push(e);
  }

  removeList(list: string): void {
    const sweep = (n: TrieNode) => {
      for (const f of ['suffix', 'exact', 'subdomains'] as const) {
        const before = n[f].length;
        n[f] = n[f].filter((e) => e.list !== list);
        this.#count -= before - n[f].length;
      }
      for (const k of n.kids.values()) sweep(k);
    };
    sweep(this.#root);
    const keep = this.#patterns.filter((p) => p.entry.list !== list);
    this.#count -= this.#patterns.length - keep.length;
    this.#patterns.length = 0;
    this.#patterns.push(...keep);
  }

  /** Every entry that matches a normalised name, most specific first. */
  matches(name: string): Entry[] {
    const labels = name === '.' || name === '' ? [] : name.split('.');
    const out: Entry[] = [];
    let n: TrieNode | undefined = this.#root;
    const path: { node: TrieNode; depth: number }[] = [];
    for (let i = labels.length - 1; i >= 0 && n; i--) {
      n = n.kids.get(labels[i]!);
      if (n) path.push({ node: n, depth: labels.length - i });
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const { node: nd, depth } = path[i]!;
      out.push(...nd.suffix);
      if (depth === labels.length) out.push(...nd.exact);
      else out.push(...nd.subdomains);
    }
    for (const p of this.#patterns) if (p.re.test(name)) out.push(p.entry);
    return out;
  }
}

export interface Group {
  /** Lists switched on for the group's clients. */
  readonly lists: readonly string[];
  /** When false the group's clients are not filtered at all. */
  readonly enabled?: boolean;
}

export type BlockMode = 'null-ip' | 'nxdomain' | 'refused';

export interface Verdict {
  readonly action: 'block' | 'allow' | 'pass';
  /** The rule that decided, when one did. */
  readonly entry: Entry | undefined;
  readonly groups: readonly string[];
  readonly name: string;
}

interface Cidr {
  readonly bytes: Uint8Array;
  readonly bits: number;
  readonly groups: readonly string[];
  readonly text: string;
}

function parseAddr(s: string): Uint8Array {
  try {
    return s.includes(':') ? parseIPv6(s) : parseIPv4(s);
  } catch {
    throw new FilterError(`${JSON.stringify(s)} is not an address`);
  }
}

const inCidr = (addr: Uint8Array, c: Cidr): boolean => {
  if (addr.length !== c.bytes.length) return false;
  const whole = Math.floor(c.bits / 8);
  for (let i = 0; i < whole; i++) if (addr[i] !== c.bytes[i]) return false;
  const rest = c.bits % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((addr[whole] ?? 0) & mask) === ((c.bytes[whole] ?? 0) & mask);
};

export interface QueryLogRecord {
  readonly time: number;
  readonly client: string;
  readonly name: string;
  readonly type: string;
  readonly action: 'block' | 'allow' | 'pass';
  readonly rule: string | undefined;
  readonly list: string | undefined;
}

export interface Summary {
  readonly total: number;
  readonly blocked: number;
  readonly allowed: number;
  readonly passed: number;
  /** blocked / total, 0 when there are no queries. */
  readonly blockedRatio: number;
  readonly topBlocked: { name: string; count: number }[];
  readonly topPermitted: { name: string; count: number }[];
  readonly topClients: { client: string; count: number; blocked: number }[];
  readonly byType: Record<string, number>;
  readonly timeline: { start: number; total: number; blocked: number }[];
}

const top = <K extends string>(m: Map<K, number>, n: number): [K, number][] => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);

/** A bounded log: the newest `max` queries, oldest dropped first. */
export class QueryLog {
  readonly #rows: QueryLogRecord[] = [];
  readonly max: number;
  constructor(max = 100_000) {
    if (!Number.isInteger(max) || max < 1) throw new FilterError('the log must hold at least one query');
    this.max = max;
  }
  get size(): number {
    return this.#rows.length;
  }
  add(r: QueryLogRecord): void {
    this.#rows.push(r);
    if (this.#rows.length > this.max) this.#rows.shift();
  }
  rows(): readonly QueryLogRecord[] {
    return this.#rows;
  }
  /** Totals, tops and a timeline over a time range (from inclusive, to exclusive). */
  summarize(o: { from?: number; to?: number; bucketMs?: number; top?: number } = {}): Summary {
    const from = o.from ?? -Infinity;
    const to = o.to ?? Infinity;
    const bucket = o.bucketMs ?? 3_600_000;
    const n = o.top ?? 10;
    const blocked = new Map<string, number>();
    const permitted = new Map<string, number>();
    const clients = new Map<string, number>();
    const clientBlocked = new Map<string, number>();
    const types: Record<string, number> = {};
    const tl = new Map<number, { total: number; blocked: number }>();
    let total = 0, b = 0, a = 0, p = 0;
    for (const r of this.#rows) {
      if (r.time < from || r.time >= to) continue;
      total++;
      clients.set(r.client, (clients.get(r.client) ?? 0) + 1);
      types[r.type] = (types[r.type] ?? 0) + 1;
      const start = Math.floor(r.time / bucket) * bucket;
      const t = tl.get(start) ?? { total: 0, blocked: 0 };
      t.total++;
      if (r.action === 'block') {
        b++;
        t.blocked++;
        blocked.set(r.name, (blocked.get(r.name) ?? 0) + 1);
        clientBlocked.set(r.client, (clientBlocked.get(r.client) ?? 0) + 1);
      } else {
        if (r.action === 'allow') a++;
        else p++;
        permitted.set(r.name, (permitted.get(r.name) ?? 0) + 1);
      }
      tl.set(start, t);
    }
    return {
      total,
      blocked: b,
      allowed: a,
      passed: p,
      blockedRatio: total === 0 ? 0 : b / total,
      topBlocked: top(blocked, n).map(([name, count]) => ({ name, count })),
      topPermitted: top(permitted, n).map(([name, count]) => ({ name, count })),
      topClients: top(clients, n).map(([client, count]) => ({ client, count, blocked: clientBlocked.get(client) ?? 0 })),
      byType: types,
      timeline: [...tl].sort((x, y) => x[0] - y[0]).map(([start, v]) => ({ start, ...v })),
    };
  }
}

export interface FilterOptions {
  readonly mode?: BlockMode;
  /** TTL on a block answer, in seconds. */
  readonly ttl?: number;
  readonly log?: QueryLog;
}

export class DnsFilter {
  readonly rules = new RuleSet();
  readonly log: QueryLog;
  readonly mode: BlockMode;
  readonly ttl: number;
  readonly #groups = new Map<string, Group>([['default', { lists: [] }]]);
  readonly #clients: Cidr[] = [];
  readonly #lists = new Map<string, { kind: ListKind; count: number }>();
  /** Client key to the time (ms) filtering is paused until. */
  readonly #snooze = new Map<string, number>();

  constructor(o: FilterOptions = {}) {
    this.mode = o.mode ?? 'null-ip';
    this.ttl = o.ttl ?? 2;
    this.log = o.log ?? new QueryLog();
  }

  /** Load or replace a list. Returns the parse report; bad lines never stop the good ones loading. */
  loadList(id: string, text: string, form: 'hosts' | 'domains' | 'adblock', kind: ListKind = 'block'): ParsedEntries {
    const parsed = parseList(text, form, kind);
    if (this.#lists.has(id)) this.rules.removeList(id);
    for (const e of parsed.entries) this.rules.add({ ...e, list: id });
    this.#lists.set(id, { kind, count: parsed.entries.length });
    return parsed;
  }

  lists(): { id: string; kind: ListKind; count: number }[] {
    return [...this.#lists].map(([id, v]) => ({ id, ...v }));
  }

  defineGroup(name: string, g: Group): void {
    for (const l of g.lists) if (!this.#lists.has(l)) throw new FilterError(`group ${name} uses list ${l}, which is not loaded`);
    this.#groups.set(name, g);
  }

  /** Put a client address, or a range like 10.0.0.0/24 or fd00::/8, into groups. The narrowest range wins; groups add up at the same width. */
  assignClients(range: string, groups: readonly string[]): void {
    for (const g of groups) if (!this.#groups.has(g)) throw new FilterError(`there is no group ${g}`);
    const [addr, len] = range.split('/') as [string, string | undefined];
    const bytes = parseAddr(addr);
    const max = bytes.length * 8;
    const bits = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : -1;
    if (bits < 0 || bits > max) throw new FilterError(`${JSON.stringify(range)} is not a valid range`);
    this.#clients.push({ bytes, bits, groups, text: range });
  }

  groupsFor(client: string): string[] {
    const addr = parseAddr(client);
    let best = -1;
    let found: string[] = [];
    for (const c of this.#clients) {
      if (!inCidr(addr, c)) continue;
      if (c.bits > best) {
        best = c.bits;
        found = [...c.groups];
      } else if (c.bits === best) found.push(...c.groups);
    }
    return best < 0 ? ['default'] : [...new Set(found)];
  }

  /** Pause filtering for a client until a time (ms), or resume it with undefined. */
  snooze(client: string, untilMs: number | undefined): void {
    parseAddr(client);
    if (untilMs === undefined) this.#snooze.delete(client);
    else this.#snooze.set(client, untilMs);
  }

  /** Decide a name for a client. */
  decide(client: string, name: string, nowMs: number): Verdict {
    const n = normalizeName(name);
    const groups = this.groupsFor(client);
    const until = this.#snooze.get(client);
    if (until !== undefined && nowMs < until) return { action: 'pass', entry: undefined, groups, name: n };
    const active = new Set<string>();
    let any = false;
    for (const g of groups) {
      const def = this.#groups.get(g);
      if (!def || def.enabled === false) continue;
      any = true;
      for (const l of def.lists) active.add(l);
    }
    if (!any) return { action: 'pass', entry: undefined, groups, name: n };
    const hits = this.rules.matches(n).filter((e) => active.has(e.list));
    const allow = hits.find((e) => e.action === 'allow');
    if (allow) return { action: 'allow', entry: allow, groups, name: n };
    const block = hits.find((e) => e.action === 'block');
    if (block) return { action: 'block', entry: block, groups, name: n };
    return { action: 'pass', entry: undefined, groups, name: n };
  }

  #blockMessage(q: Message): Message {
    const question = q.questions[0]!;
    const base = { id: q.id, qr: true, opcode: q.opcode, aa: false, tc: false, rd: q.rd, ra: true, ad: false, cd: false, questions: q.questions, authority: [], additional: [] };
    if (this.mode === 'nxdomain') return { ...base, rcode: 3, answers: [] };
    if (this.mode === 'refused') return { ...base, rcode: 5, answers: [] };
    const t = typeName(question.qtype);
    const rec = (data: DnsRecord['data']): DnsRecord => ({ name: question.name, ttl: this.ttl, cls: question.qclass, data });
    if (t === 'A') return { ...base, rcode: 0, answers: [rec({ type: 'A', address: formatIPv4(new Uint8Array(4)) })] };
    if (t === 'AAAA') return { ...base, rcode: 0, answers: [rec({ type: 'AAAA', address: '::' })] };
    return { ...base, rcode: 0, answers: [] };
  }

  /**
   * Answer one query message for a client. `response` is the block answer when the name is blocked, and undefined
   * when the query should be forwarded upstream (allowed or not matched). Every query is logged.
   */
  answer(query: Message, client: string, nowMs: number): { verdict: Verdict; response: Message | undefined } {
    if (query.qr || query.questions.length !== 1) throw new FilterError('expected one question in a query');
    const q = query.questions[0]!;
    const verdict = this.decide(client, q.name, nowMs);
    this.log.add({ time: nowMs, client, name: verdict.name, type: typeName(q.qtype), action: verdict.action, rule: verdict.entry?.value, list: verdict.entry?.list });
    return { verdict, response: verdict.action === 'block' ? this.#blockMessage(query) : undefined };
  }

  /** The same, from the bytes of a query to the bytes of a block answer. */
  answerBytes(packet: Uint8Array, client: string, nowMs: number): { verdict: Verdict; response: Uint8Array | undefined } {
    const r = this.answer(decode(packet), client, nowMs);
    return { verdict: r.verdict, response: r.response ? encode(r.response) : undefined };
  }

  /** Check the CNAME targets in an upstream answer; when one is blocked, return the block answer instead. */
  inspectResponse(query: Message, upstream: Message, client: string, nowMs: number): { verdict: Verdict; response: Message } {
    for (const r of upstream.answers) {
      if (r.data.type !== 'CNAME') continue;
      const v = this.decide(client, r.data.target, nowMs);
      if (v.action === 'block') {
        this.log.add({ time: nowMs, client, name: normalizeName(r.data.target), type: 'CNAME', action: 'block', rule: v.entry?.value, list: v.entry?.list });
        return { verdict: v, response: this.#blockMessage(query) };
      }
    }
    return { verdict: { action: 'pass', entry: undefined, groups: this.groupsFor(client), name: normalizeName(query.questions[0]?.name ?? '.') }, response: upstream };
  }
}
