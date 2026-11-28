/**
 * Email addresses read the way RFC 5322 writes them: single addresses and address lists with display names
 * (plain, quoted, or encoded as RFC 2047 "=?UTF-8?B?...?=" words), comments in parentheses, and groups
 * ("Team: a@x, b@y;"). Local parts follow dot-atom or quoted-string rules, with non-ASCII letters allowed (RFC
 * 6531); domains are checked label by label (RFC 1035 lengths), internationalised domains are turned into their
 * ASCII form with Punycode (RFC 3492, written out here and tested with its published vectors), and an address
 * literal such as [192.0.2.1] is refused unless asked for. A canonical form lower-cases the domain and can drop a
 * "+tag" and, for Gmail, the dots, so one person's address is stored once. Role addresses (RFC 2142 and the usual
 * "info@" and "noreply@") are recognised. Output formatting quotes and encodes display names and refuses line
 * breaks, so an address cannot start a new header. Obsolete forms (source routes, comments inside addresses in
 * odd places) are refused rather than guessed at.
 */

export class BadAddress extends Error {
  readonly at: number | undefined;
  constructor(why: string, at?: number) {
    super(why);
    this.at = at;
  }
}

// ---------------------------------------------------------------- punycode (RFC 3492)

const BASE = 36, TMIN = 1, TMAX = 26, SKEW = 38, DAMP = 700, INITIAL_BIAS = 72, INITIAL_N = 128;

const adapt = (delta: number, points: number, first: boolean) => {
  let d = first ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / points);
  let k = 0;
  while (d > ((BASE - TMIN) * TMAX) >> 1) {
    d = Math.floor(d / (BASE - TMIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - TMIN + 1) * d) / (d + SKEW));
};
const digit = (d: number) => String.fromCharCode(d < 26 ? d + 97 : d + 22);

/** Encodes one label's code points to Punycode (without the "xn--"). */
export function punycodeEncode(input: string): string {
  const cps = Array.from(input).map((c) => c.codePointAt(0)!);
  let out = cps.filter((c) => c < 128).map((c) => String.fromCharCode(c)).join('');
  const b = out.length;
  let h = b;
  if (b) out += '-';
  let n = INITIAL_N, delta = 0, bias = INITIAL_BIAS;
  while (h < cps.length) {
    const m = Math.min(...cps.filter((c) => c >= n));
    delta += (m - n) * (h + 1);
    n = m;
    for (const c of cps) {
      if (c < n) delta++;
      if (c === n) {
        let q = delta;
        for (let k = BASE; ; k += BASE) {
          const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
          if (q < t) break;
          out += digit(t + ((q - t) % (BASE - t)));
          q = Math.floor((q - t) / (BASE - t));
        }
        out += digit(q);
        bias = adapt(delta, h + 1, h === b);
        delta = 0;
        h++;
      }
    }
    delta++;
    n++;
  }
  return out;
}

export function punycodeDecode(input: string): string {
  const out: number[] = [];
  const bd = input.lastIndexOf('-');
  for (let j = 0; j < Math.max(bd, 0); j++) {
    if (input.charCodeAt(j) >= 128) throw new BadAddress('bad punycode');
    out.push(input.charCodeAt(j));
  }
  let n = INITIAL_N, i = 0, bias = INITIAL_BIAS;
  for (let idx = bd > 0 ? bd + 1 : 0; idx < input.length; ) {
    const oldi = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (idx >= input.length) throw new BadAddress('bad punycode');
      const c = input.charCodeAt(idx++);
      const dgt = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : BASE;
      if (dgt >= BASE) throw new BadAddress('bad punycode');
      i += dgt * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (dgt < t) break;
      w *= BASE - t;
      if (w > 0x7fffffff) throw new BadAddress('bad punycode');
    }
    bias = adapt(i - oldi, out.length + 1, oldi === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    if (n > 0x10ffff) throw new BadAddress('bad punycode');
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

/** A domain name to its ASCII form: each non-ASCII label lower-cased, normalised and Punycode-encoded. */
export function domainToAscii(domain: string): string {
  return domain
    .split('.')
    .map((l) => {
      if (/^[\x00-\x7f]*$/.test(l)) return l.toLowerCase();
      const n = l.normalize('NFKC').toLowerCase();
      if (/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/.test(n)) throw new BadAddress('a domain has invisible characters');
      return `xn--${punycodeEncode(n)}`;
    })
    .join('.');
}

export function domainToUnicode(domain: string): string {
  return domain.split('.').map((l) => (l.toLowerCase().startsWith('xn--') ? punycodeDecode(l.slice(4)) : l)).join('.');
}

// ---------------------------------------------------------------- encoded words (RFC 2047)

/** Decodes "=?charset?B|Q?text?=" words; neighbouring encoded words join without the space between them. */
export function decodeWords(s: string): string {
  const re = /=\?([A-Za-z0-9_-]{1,40})\?([BbQq])\?([^?\s]{0,200})\?=/g;
  let out = '';
  let last = 0;
  let prevEncoded = false;
  for (const m of s.matchAll(re)) {
    const gap = s.slice(last, m.index);
    out += prevEncoded && /^\s*$/.test(gap) ? '' : gap;
    let bytes: Buffer;
    if (m[2]!.toUpperCase() === 'B') bytes = Buffer.from(m[3]!, 'base64');
    else {
      const q = m[3]!.replace(/_/g, ' ');
      const arr: number[] = [];
      for (let i = 0; i < q.length; i++) {
        if (q[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(q.slice(i + 1, i + 3))) {
          arr.push(parseInt(q.slice(i + 1, i + 3), 16));
          i += 2;
        } else arr.push(q.charCodeAt(i) & 0xff);
      }
      bytes = Buffer.from(arr);
    }
    try {
      out += new TextDecoder(m[1]!.toLowerCase(), { fatal: false }).decode(bytes);
    } catch {
      out += m[0];
    }
    last = m.index! + m[0].length;
    prevEncoded = true;
  }
  return out + s.slice(last);
}

const encodeWord = (s: string) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

// ---------------------------------------------------------------- parsing

export interface Mailbox {
  readonly name?: string;
  readonly local: string;
  /** ASCII form, lower case. */
  readonly domain: string;
  readonly address: string;
  /** The domain as a person would read it. */
  readonly domainUnicode: string;
  readonly comments: readonly string[];
}
export interface Group {
  readonly group: string;
  readonly members: readonly Mailbox[];
}
export type Entry = Mailbox | Group;
export const isGroup = (e: Entry): e is Group => 'group' in e;

export interface ParseOptions {
  /** Allow [192.0.2.1] and [IPv6:...] as the domain; default false. */
  readonly allowLiteral?: boolean;
  /** Allow non-ASCII in the local part (RFC 6531); default true. */
  readonly smtputf8?: boolean;
}

const MAX_INPUT = 20_000;
const MAX_ENTRIES = 1000;
const ATEXT = /[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]/;
const isAtext = (c: string, utf8: boolean) => ATEXT.test(c) || (utf8 && c.codePointAt(0)! > 127 && !/[\u2028\u2029\u0085\u00a0]/.test(c));

class Reader {
  i = 0;
  comments: string[] = [];
  readonly s: string;
  readonly o: Required<ParseOptions>;
  constructor(s: string, o: ParseOptions) {
    this.s = s;
    this.o = { allowLiteral: o.allowLiteral ?? false, smtputf8: o.smtputf8 ?? true };
  }
  get done() {
    return this.i >= this.s.length;
  }
  peek() {
    return this.s[this.i] ?? '';
  }
  fail(why: string): never {
    throw new BadAddress(why, this.i);
  }
  /** Whitespace and comments (which nest, and may hold quoted pairs). */
  cfws() {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') this.i++;
      else if (c === '(') {
        let depth = 0;
        let text = '';
        do {
          const d = this.s[this.i++];
          if (d === undefined) this.fail('a comment is not closed');
          if (d === '\\') text += this.s[this.i++] ?? '';
          else if (d === '(') {
            if (depth++ > 0) text += d;
          } else if (d === ')') {
            if (--depth > 0) text += d;
          } else text += d;
        } while (depth > 0);
        this.comments.push(text.trim());
      } else return;
    }
  }
  atom(): string {
    const st = this.i;
    while (!this.done && isAtext(this.peek(), this.o.smtputf8)) this.i++;
    if (st === this.i) this.fail(`expected a word at "${this.s.slice(st, st + 10)}"`);
    return this.s.slice(st, this.i);
  }
  dotAtom(): string {
    let out = this.atom();
    while (this.peek() === '.') {
      this.i++;
      if (!isAtext(this.peek(), this.o.smtputf8)) this.fail('a dot must be followed by more letters');
      out += `.${this.atom()}`;
    }
    return out;
  }
  quoted(): string {
    if (this.peek() !== '"') this.fail('expected a quoted string');
    this.i++;
    let out = '';
    for (;;) {
      const c = this.s[this.i++];
      if (c === undefined) this.fail('a quoted string is not closed');
      if (c === '"') return out;
      if (c === '\\') {
        const d = this.s[this.i++];
        if (d === undefined) this.fail('a quoted string ends with a backslash');
        out += d;
      } else if (c === '\r' || c === '\n') this.fail('a quoted string has a line break');
      else out += c;
    }
  }
}

const CTL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function checkLocal(local: string): void {
  if (local.length === 0) throw new BadAddress('the part before @ is empty');
  if (Buffer.byteLength(local) > 64) throw new BadAddress('the part before @ is longer than 64 bytes');
  if (CTL.test(local)) throw new BadAddress('the part before @ has control characters');
}

function checkDomain(domain: string): string {
  const ascii = domainToAscii(domain);
  if (ascii.length > 253 || ascii.length === 0) throw new BadAddress('the domain is longer than 253 characters');
  const labels = ascii.split('.');
  if (labels.length < 2) throw new BadAddress('the domain needs a dot, like example.com');
  for (const l of labels) {
    if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(l)) throw new BadAddress(`"${l.slice(0, 20)}" is not a valid domain label`);
    if (l.length > 63) throw new BadAddress('a domain label is longer than 63 characters');
    if (l.startsWith('xn--')) {
      try {
        if (punycodeEncode(punycodeDecode(l.slice(4))) !== l.slice(4).toLowerCase()) throw new BadAddress('bad punycode');
      } catch {
        throw new BadAddress(`"${l.slice(0, 20)}" is not valid Punycode`);
      }
    }
  }
  if (/^\d+$/.test(labels.at(-1)!)) throw new BadAddress('the last part of a domain is not all digits');
  return ascii.toLowerCase();
}

function addrSpec(r: Reader): { local: string; domain: string; literal: boolean } {
  r.cfws();
  const local = r.peek() === '"' ? r.quoted() : r.dotAtom();
  checkLocal(local);
  r.cfws();
  if (r.peek() !== '@') r.fail('an address needs @');
  r.i++;
  r.cfws();
  if (r.peek() === '[') {
    const end = r.s.indexOf(']', r.i);
    if (end < 0) r.fail('an address literal is not closed');
    const lit = r.s.slice(r.i + 1, end);
    r.i = end + 1;
    if (!r.o.allowLiteral) r.fail('addresses at an IP number are not accepted');
    if (!/^(?:\d{1,3}(?:\.\d{1,3}){3}|IPv6:[0-9A-Fa-f:.]+)$/.test(lit)) r.fail('that is not an address literal');
    return { local, domain: `[${lit}]`, literal: true };
  }
  const st = r.i;
  while (!r.done && (isAtext(r.peek(), true) || r.peek() === '.') ) r.i++;
  const d = r.s.slice(st, r.i);
  if (!d) r.fail('an address needs a domain after @');
  return { local, domain: checkDomain(d), literal: false };
}

const mailboxOf = (a: { local: string; domain: string; literal: boolean }, name: string | undefined, comments: readonly string[]): Mailbox => ({
  ...(name ? { name } : {}),
  local: a.local,
  domain: a.domain,
  address: `${a.local}@${a.domain}`,
  domainUnicode: a.literal ? a.domain : domainToUnicode(a.domain),
  comments,
});

/** A display-name phrase: words, quoted strings and encoded words, with dots allowed (old style). */
function phrase(r: Reader): string {
  const parts: string[] = [];
  for (;;) {
    r.cfws();
    const c = r.peek();
    if (c === '"') parts.push(r.quoted());
    else if (isAtext(c, true) && c !== '') {
      const st = r.i;
      while (!r.done && (isAtext(r.peek(), true) || r.peek() === '.')) r.i++;
      parts.push(r.s.slice(st, r.i));
    } else break;
  }
  if (!parts.length) r.fail('expected a name');
  return decodeWords(parts.join(' '));
}

function mailbox(r: Reader): Mailbox {
  r.cfws();
  const start = r.i;
  const c0 = r.comments.length;
  if (r.peek() === '<') {
    const a = angle(r);
    return mailboxOf(a, undefined, r.comments.slice(c0));
  }
  let first: BadAddress | undefined;
  try {
    const a = addrSpec(r);
    r.cfws();
    if (r.done || r.peek() === ',' || r.peek() === ';') {
      const cm = r.comments.slice(c0);
      return mailboxOf(a, undefined, cm);
    }
  } catch (e) {
    if (!(e instanceof BadAddress)) throw e;
    first = e;
  }
  r.i = start;
  r.comments.length = c0;
  let name: string;
  try {
    name = phrase(r);
  } catch (e) {
    throw first ?? e;
  }
  r.cfws();
  if (r.peek() !== '<') {
    if (first && !/needs @|expected a word/.test(first.message)) throw first;
    if (r.done || r.peek() === ',' || r.peek() === ';') r.fail('an address needs @');
    r.fail('a name must be followed by <address>');
  }
  const a = angle(r);
  return mailboxOf(a, name, r.comments.slice(c0));
}

function angle(r: Reader) {
  r.i++; // <
  r.cfws();
  if (r.peek() === '@') r.fail('old-style source routes (<@a,@b:x@y>) are not accepted');
  const a = addrSpec(r);
  r.cfws();
  if (r.peek() !== '>') r.fail('an address in <> is not closed');
  r.i++;
  return a;
}

/** One mailbox: "Ann <ann@example.com>" or "ann@example.com". */
export function parseAddress(s: string, o: ParseOptions = {}): Mailbox {
  const list = parseAddressList(s, o);
  if (list.length !== 1 || isGroup(list[0]!)) throw new BadAddress('expected exactly one address');
  return list[0]!;
}

/** A list of addresses and groups, as in a To header. */
export function parseAddressList(s: string, o: ParseOptions = {}): Entry[] {
  if (typeof s !== 'string' || s.length > MAX_INPUT) throw new BadAddress('the address list is too long');
  if (/[\x00]/.test(s)) throw new BadAddress('the text has a NUL character');
  const r = new Reader(s.replace(/\r?\n(?=[ \t])/g, ' '), o);
  if (/[\r\n]/.test(r.s)) throw new BadAddress('a line break inside an address list');
  const out: Entry[] = [];
  for (;;) {
    r.cfws();
    if (r.done) break;
    if (r.peek() === ',') {
      r.i++;
      continue;
    }
    const st = r.i;
    let grp: string | undefined;
    try {
      const n = phrase(r);
      r.cfws();
      if (r.peek() === ':') grp = n;
    } catch (e) {
      if (!(e instanceof BadAddress)) throw e;
    }
    if (grp !== undefined) {
      r.i++;
      const members: Mailbox[] = [];
      for (;;) {
        r.cfws();
        if (r.peek() === ';') {
          r.i++;
          break;
        }
        if (r.done) r.fail('a group is not closed with ;');
        if (r.peek() === ',') {
          r.i++;
          continue;
        }
        members.push(mailbox(r));
        r.cfws();
        if (r.done) r.fail('a group is not closed with ;');
        if (r.peek() !== ',' && r.peek() !== ';') r.fail('expected a comma or ; after an address');
      }
      out.push({ group: grp, members });
    } else {
      r.i = st;
      out.push(mailbox(r));
      r.cfws();
      if (!r.done && r.peek() !== ',') r.fail(`unexpected "${r.peek()}" after an address`);
    }
    if (out.length > MAX_ENTRIES) throw new BadAddress('more than 1000 addresses');
  }
  if (!out.length) throw new BadAddress('there is no address');
  return out;
}

/** Every mailbox in a list, groups opened up. */
export const flatten = (l: readonly Entry[]): Mailbox[] => l.flatMap((e) => (isGroup(e) ? [...e.members] : [e]));

// ---------------------------------------------------------------- canonical form and roles

export interface CanonicalOptions {
  /** Drop "+tag" from the local part; default true. */
  readonly plus?: boolean;
  /** Lower-case the local part; default true (most providers ignore case). */
  readonly lowercase?: boolean;
  /** Gmail ignores dots and treats googlemail.com as gmail.com; default true. */
  readonly gmail?: boolean;
}

/** One stored form for one mailbox: ASCII lower-case domain, and by default no +tag, no case, and no Gmail dots. */
export function canonical(m: Mailbox | string, o: CanonicalOptions = {}): string {
  const b = typeof m === 'string' ? parseAddress(m) : m;
  let local = b.local;
  let domain = b.domain;
  if (o.lowercase ?? true) local = local.toLowerCase();
  if (o.gmail ?? true) {
    if (domain === 'googlemail.com') domain = 'gmail.com';
    if (domain === 'gmail.com') local = local.replace(/\./g, '');
  }
  if ((o.plus ?? true) && !local.startsWith('+')) {
    const i = local.indexOf('+');
    if (i > 0) local = local.slice(0, i);
  }
  return `${local}@${domain}`;
}

/** The "+tag" of an address, if there is one. */
export const plusTag = (m: Mailbox): string | undefined => {
  const i = m.local.indexOf('+');
  return i > 0 && i < m.local.length - 1 ? m.local.slice(i + 1) : undefined;
};

const ROLES = new Set(['abuse', 'postmaster', 'hostmaster', 'webmaster', 'noc', 'security', 'info', 'marketing', 'sales', 'support', 'admin', 'administrator', 'root', 'contact', 'help', 'billing', 'office', 'hello', 'mailer-daemon', 'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'ftp', 'www', 'usenet', 'news', 'uucp', 'postmaster']);

/** Whether the address belongs to a function and not a person (RFC 2142 names and common others). */
export function isRoleAddress(m: Mailbox | string): boolean {
  const b = typeof m === 'string' ? parseAddress(m) : m;
  return ROLES.has(b.local.toLowerCase().replace(/\+.*/, ''));
}

/** Whether replies to the address are not read: "noreply" and its spellings. */
export const isNoReply = (m: Mailbox | string) => /^(?:no-?reply|do-?not-?reply|mailer-daemon)$/i.test((typeof m === 'string' ? parseAddress(m) : m).local.replace(/\+.*/, ''));

// ---------------------------------------------------------------- output

const needsQuote = (s: string) => !/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(s);

function formatPhrase(name: string): string {
  if (/[\r\n]/.test(name)) throw new BadAddress('a line break cannot go into an address header');
  const n = name.normalize('NFC');
  if (/[^\x20-\x7e]/.test(n)) return encodeWord(n);
  return needsQuote(n) ? `"${n.replace(/["\\]/g, '\\$&')}"` : n;
}

/** A header-ready mailbox. Display names are quoted or encoded as needed; line breaks are refused. */
export function formatMailbox(m: { name?: string; local: string; domain: string }): string {
  if (/[\r\n]/.test(m.local) || /[\r\n]/.test(m.domain) || /[\r\n]/.test(m.name ?? '')) throw new BadAddress('a line break cannot go into an address header');
  const local = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/.test(m.local) ? m.local : `"${m.local.replace(/["\\]/g, '\\$&')}"`;
  const spec = `${local}@${domainToAscii(m.domain)}`;
  if (!m.name) return spec;
  const name = m.name.normalize('NFC');
  if (/[^\x20-\x7e]/.test(name)) return `${encodeWord(name)} <${spec}>`;
  return `${needsQuote(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : name} <${spec}>`;
}

export const formatList = (l: readonly Entry[]): string => l.map((e) => (isGroup(e) ? `${formatPhrase(e.group)}: ${e.members.map(formatMailbox).join(', ')};` : formatMailbox(e))).join(', ');
