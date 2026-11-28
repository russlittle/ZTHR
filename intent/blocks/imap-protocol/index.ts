/**
 * The IMAP wire format, as data. Reads server responses (RFC 3501 IMAP4rev1, with the IMAP4rev2 additions of
 * RFC 9051 that matter to a client: ESEARCH, ENABLED, literal8) into plain values: tagged, untagged and
 * continuation responses, atoms, quoted strings, NIL, parenthesised lists and literals, whether a literal arrives
 * whole or across many chunks; the response codes (UIDVALIDITY, UIDNEXT, PERMANENTFLAGS, APPENDUID, COPYUID,
 * HIGHESTMODSEQ and the rest) with their arguments; and FETCH data (FLAGS, UID, INTERNALDATE, RFC822.SIZE,
 * ENVELOPE, BODYSTRUCTURE, BODY[section]) as typed records. Builds commands the other way: arguments quoted or sent
 * as literals as needed, with refusal of anything that could inject a second command (NUL, bare CR or LF in a
 * quoted value, a tag with spaces). Also holds the small things a client keeps getting wrong: UID and sequence sets
 * ("1:5,7,10:*") parsed, compressed and tested; the modified UTF-7 of mailbox names (RFC 3501 6.3.x and 5.1.3);
 * SEARCH criteria written safely; the session state machine (not authenticated, authenticated, selected, logout,
 * and IDLE of RFC 2177 inside it); UIDVALIDITY handling that says when cached UIDs are no longer true, and the
 * fetch ranges that bring a cache up to date; and the IDLE loop plan (re-issue before the 29-minute limit, fall
 * back to polling where IDLE is not offered).
 *
 * Parsing is bounded: lines, literals, nesting and response sizes have limits, and a response that breaks them is
 * refused with a typed error rather than buffered without end. Out of scope: the socket and TLS, SASL mechanisms,
 * decoding RFC 2047 words in headers and MIME bodies (the bytes are returned as they came), and the extensions
 * not named above (CONDSTORE and QRESYNC beyond carrying HIGHESTMODSEQ, METADATA, ACL, QUOTA).
 */

export class ImapParseError extends Error {
  constructor(why: string) {
    super(`IMAP response not understood: ${why}`);
    this.name = 'ImapParseError';
  }
}
export class ImapCommandError extends Error {
  constructor(why: string) {
    super(`IMAP command refused: ${why}`);
    this.name = 'ImapCommandError';
  }
}
export class ImapStateError extends Error {
  constructor(why: string) {
    super(`IMAP state: ${why}`);
    this.name = 'ImapStateError';
  }
}

// ------------------------------------------------------------------------------------------------------ values

export type Node = { readonly kind: 'nil' } | { readonly kind: 'atom'; readonly value: string } | { readonly kind: 'string'; readonly value: string; readonly bytes?: Buffer } | { readonly kind: 'list'; readonly items: readonly Node[] };

export interface Limits {
  readonly maxLine: number;
  readonly maxLiteral: number;
  readonly maxResponse: number;
  readonly maxDepth: number;
}
export const DEFAULT_LIMITS: Limits = { maxLine: 65_536, maxLiteral: 64 * 1024 * 1024, maxResponse: 128 * 1024 * 1024, maxDepth: 32 };

export interface Code {
  readonly name: string;
  readonly args: readonly Node[];
}
export type Status = 'OK' | 'NO' | 'BAD' | 'PREAUTH' | 'BYE';

export type Response =
  | { readonly kind: 'continuation'; readonly text: string }
  | { readonly kind: 'tagged'; readonly tag: string; readonly status: 'OK' | 'NO' | 'BAD'; readonly code?: Code; readonly text: string }
  | { readonly kind: 'untagged'; readonly type: string; readonly number?: number; readonly status?: Status; readonly code?: Code; readonly text?: string; readonly data: readonly Node[] };

class Reader {
  i = 0;
  readonly b: Buffer;
  readonly lim: Limits;
  constructor(b: Buffer, lim: Limits) {
    this.b = b;
    this.lim = lim;
  }
  peek(): string {
    return this.i < this.b.length ? String.fromCharCode(this.b[this.i]!) : '';
  }
  atEnd(): boolean {
    return this.i >= this.b.length || (this.b[this.i] === 13 && this.b[this.i + 1] === 10);
  }
  spaces(): void {
    while (this.peek() === ' ') this.i++;
  }
  /** The rest of the line, as text, without the CRLF. */
  restOfLine(): string {
    const end = this.b.indexOf('\r\n', this.i, 'latin1');
    const s = this.b.toString('utf8', this.i, end < 0 ? this.b.length : end);
    this.i = end < 0 ? this.b.length : end;
    return s;
  }
}

const ATOM_STOP = new Set([' ', '(', ')', '{', '"', '\r', '\n', '']);

function readNode(r: Reader, depth: number, inCode: boolean): Node {
  if (depth > r.lim.maxDepth) throw new ImapParseError('lists nested too deeply');
  r.spaces();
  const c = r.peek();
  if (c === '(') {
    r.i++;
    const items: Node[] = [];
    for (;;) {
      r.spaces();
      if (r.peek() === ')') {
        r.i++;
        return { kind: 'list', items };
      }
      if (r.atEnd()) throw new ImapParseError('a list is not closed');
      items.push(readNode(r, depth + 1, inCode));
    }
  }
  if (c === '"') {
    r.i++;
    const out: number[] = [];
    for (;;) {
      if (r.i >= r.b.length) throw new ImapParseError('a quoted string is not closed');
      const ch = r.b[r.i++]!;
      if (ch === 0x22) break;
      if (ch === 0x5c) {
        const n = r.b[r.i++];
        if (n !== 0x22 && n !== 0x5c) throw new ImapParseError('a quoted string has a bad escape');
        out.push(n);
      } else if (ch === 13 || ch === 10 || ch === 0) throw new ImapParseError('a quoted string holds a line break');
      else out.push(ch);
    }
    return { kind: 'string', value: Buffer.from(out).toString('utf8') };
  }
  if (c === '{' || (c === '~' && r.b[r.i + 1] === 0x7b)) {
    if (c === '~') r.i++;
    const close = r.b.indexOf('}', r.i, 'latin1');
    const m = close < 0 ? null : /^\{(\d{1,10})\+?$/.exec(r.b.toString('latin1', r.i, close));
    if (!m || r.b[close + 1] !== 13 || r.b[close + 2] !== 10) throw new ImapParseError('a literal header is malformed');
    const n = Number(m[1]);
    if (n > r.lim.maxLiteral) throw new ImapParseError(`a literal of ${n} bytes is over the limit of ${r.lim.maxLiteral}`);
    const start = close + 3;
    if (start + n > r.b.length) throw new ImapParseError('a literal is cut short');
    r.i = start + n;
    const bytes = Buffer.from(r.b.subarray(start, start + n));
    return { kind: 'string', value: bytes.toString('utf8'), bytes };
  }
  // an atom, which may carry a [section] with spaces and parentheses inside it
  const start = r.i;
  let depthBr = 0;
  while (r.i < r.b.length) {
    const ch = r.peek();
    if (ch === '[') depthBr++;
    else if (ch === ']') {
      if (depthBr === 0) {
        if (inCode) break;
      } else depthBr--;
    } else if (depthBr === 0 && ATOM_STOP.has(ch)) break;
    else if (depthBr > 0 && (ch === '\r' || ch === '\n')) throw new ImapParseError('a section is not closed');
    r.i++;
  }
  if (depthBr !== 0) throw new ImapParseError('a section is not closed');
  if (r.i === start) throw new ImapParseError(`unexpected "${r.peek() || 'end of line'}"`);
  const value = r.b.toString('latin1', start, r.i);
  return /^NIL$/i.test(value) ? { kind: 'nil' } : { kind: 'atom', value };
}

function readCode(r: Reader): Code | undefined {
  r.spaces();
  if (r.peek() !== '[') return undefined;
  r.i++;
  const name = readNode(r, 0, true);
  if (name.kind !== 'atom') throw new ImapParseError('a response code has no name');
  const args: Node[] = [];
  for (;;) {
    r.spaces();
    if (r.peek() === ']') {
      r.i++;
      break;
    }
    if (r.atEnd()) throw new ImapParseError('a response code is not closed');
    args.push(readNode(r, 0, true));
  }
  return { name: name.value.toUpperCase(), args };
}

/** Parse one complete response (its literals embedded, ending in CRLF). */
export function parseResponse(raw: Buffer, limits: Limits = DEFAULT_LIMITS): Response {
  const r = new Reader(raw, limits);
  if (r.peek() === '+') {
    r.i++;
    return { kind: 'continuation', text: (r.spaces(), r.restOfLine()) };
  }
  const tagNode = readNode(r, 0, false);
  if (tagNode.kind !== 'atom') throw new ImapParseError('a response must begin with a tag, "*" or "+"');
  const tag = tagNode.value;
  r.spaces();
  if (tag !== '*') {
    if (/[\s"(){%*\\\]]/.test(tag)) throw new ImapParseError('a tag holds a character a tag cannot');
    const st = readNode(r, 0, false);
    const status = st.kind === 'atom' ? st.value.toUpperCase() : '';
    if (status !== 'OK' && status !== 'NO' && status !== 'BAD') throw new ImapParseError('a tagged response needs OK, NO or BAD');
    const code = readCode(r);
    r.spaces();
    return { kind: 'tagged', tag, status, ...(code ? { code } : {}), text: r.restOfLine() };
  }
  const first = readNode(r, 0, false);
  if (first.kind !== 'atom') throw new ImapParseError('an untagged response needs a keyword');
  let number: number | undefined;
  let word = first.value.toUpperCase();
  if (/^\d+$/.test(first.value)) {
    number = Number(first.value);
    if (!Number.isSafeInteger(number)) throw new ImapParseError('a number is too large');
    const w = readNode(r, 0, false);
    if (w.kind !== 'atom') throw new ImapParseError('a numbered response needs a keyword');
    word = w.value.toUpperCase();
  }
  if (number === undefined && (word === 'OK' || word === 'NO' || word === 'BAD' || word === 'PREAUTH' || word === 'BYE')) {
    const code = readCode(r);
    r.spaces();
    return { kind: 'untagged', type: 'status', status: word, ...(code ? { code } : {}), text: r.restOfLine(), data: [] };
  }
  const data: Node[] = [];
  for (;;) {
    r.spaces();
    if (r.atEnd()) break;
    data.push(readNode(r, 0, false));
  }
  return { kind: 'untagged', type: word.toLowerCase(), ...(number !== undefined ? { number } : {}), data };
}

/** Collects bytes from a socket and yields whole responses; a literal split across chunks is waited for. */
export class ResponseStream {
  private buf: Buffer = Buffer.alloc(0);
  private readonly lim: Limits;
  constructor(lim: Limits = DEFAULT_LIMITS) {
    this.lim = lim;
  }
  /** Bytes held back, waiting for the rest of a response. */
  get pending(): number {
    return this.buf.length;
  }
  push(chunk: Uint8Array): Response[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: Response[] = [];
    for (;;) {
      const end = this.whole();
      if (end < 0) break;
      const raw = this.buf.subarray(0, end);
      this.buf = this.buf.subarray(end);
      out.push(parseResponse(raw, this.lim));
    }
    if (this.buf.length > this.lim.maxResponse) throw new ImapParseError('a response is larger than the limit');
    return out;
  }
  /** The length of the first complete response in the buffer, or -1 if more bytes are needed. */
  private whole(): number {
    let at = 0;
    for (;;) {
      const nl = this.buf.indexOf('\r\n', at, 'latin1');
      if (nl < 0) {
        if (this.buf.length - at > this.lim.maxLine) throw new ImapParseError('a line is longer than the limit');
        return -1;
      }
      if (nl - at > this.lim.maxLine) throw new ImapParseError('a line is longer than the limit');
      const m = /~?\{(\d{1,10})\+?\}$/.exec(this.buf.toString('latin1', at, nl));
      if (!m) return nl + 2;
      const n = Number(m[1]);
      if (n > this.lim.maxLiteral) throw new ImapParseError(`a literal of ${n} bytes is over the limit of ${this.lim.maxLiteral}`);
      if (this.buf.length < nl + 2 + n) return -1;
      at = nl + 2 + n;
    }
  }
}

// ------------------------------------------------------------------------------------------------ typed helpers

export const text = (n: Node | undefined): string | undefined => (n && (n.kind === 'atom' || n.kind === 'string') ? n.value : undefined);
const listOf = (n: Node | undefined): readonly Node[] => (n && n.kind === 'list' ? n.items : []);
const numOf = (n: Node | undefined): number | undefined => {
  const t = text(n);
  return t !== undefined && /^\d+$/.test(t) ? Number(t) : undefined;
};

export interface Address {
  readonly name?: string;
  readonly mailbox: string;
  readonly host: string;
  readonly address: string;
}
export interface Envelope {
  readonly date?: string;
  readonly subject?: string;
  readonly from: readonly Address[];
  readonly sender: readonly Address[];
  readonly replyTo: readonly Address[];
  readonly to: readonly Address[];
  readonly cc: readonly Address[];
  readonly bcc: readonly Address[];
  readonly inReplyTo?: string;
  readonly messageId?: string;
}
function addresses(n: Node | undefined): Address[] {
  const out: Address[] = [];
  for (const a of listOf(n)) {
    const [name, , mailbox, host] = listOf(a);
    const m = text(mailbox);
    const h = text(host);
    if (m === undefined || h === undefined) continue; // group start or end markers
    const nm = text(name);
    out.push({ ...(nm !== undefined ? { name: nm } : {}), mailbox: m, host: h, address: `${m}@${h}` });
  }
  return out;
}
export function envelope(n: Node): Envelope {
  const f = listOf(n);
  if (f.length < 10) throw new ImapParseError('an envelope has ten fields');
  const opt = (i: number) => text(f[i]);
  return {
    ...(opt(0) !== undefined ? { date: opt(0)! } : {}),
    ...(opt(1) !== undefined ? { subject: opt(1)! } : {}),
    from: addresses(f[2]),
    sender: addresses(f[3]),
    replyTo: addresses(f[4]),
    to: addresses(f[5]),
    cc: addresses(f[6]),
    bcc: addresses(f[7]),
    ...(opt(8) !== undefined ? { inReplyTo: opt(8)! } : {}),
    ...(opt(9) !== undefined ? { messageId: opt(9)! } : {}),
  };
}

export type Part = { readonly multipart: true; readonly section: string; readonly subtype: string; readonly parts: readonly Part[] } | { readonly multipart: false; readonly section: string; readonly type: string; readonly subtype: string; readonly params: Readonly<Record<string, string>>; readonly id?: string; readonly encoding: string; readonly size: number };

export function bodyStructure(n: Node, section = ''): Part {
  const f = listOf(n);
  if (!f.length) throw new ImapParseError('a body structure is empty');
  const sec = (i: number) => (section ? `${section}.${i}` : String(i));
  if (f[0]!.kind === 'list') {
    const parts: Part[] = [];
    let i = 0;
    while (f[i]?.kind === 'list') parts.push(bodyStructure(f[i]!, sec(i++ + 1)));
    return { multipart: true, section, subtype: (text(f[i]) ?? 'mixed').toLowerCase(), parts };
  }
  const params: Record<string, string> = {};
  const p = listOf(f[2]);
  for (let i = 0; i + 1 < p.length; i += 2) params[(text(p[i]) ?? '').toLowerCase()] = text(p[i + 1]) ?? '';
  const id = text(f[3]);
  return { multipart: false, section: section || '1', type: (text(f[0]) ?? 'text').toLowerCase(), subtype: (text(f[1]) ?? 'plain').toLowerCase(), params, ...(id !== undefined ? { id } : {}), encoding: (text(f[5]) ?? '7bit').toLowerCase(), size: numOf(f[6]) ?? 0 };
}

export interface Fetched {
  readonly seq: number;
  readonly uid?: number;
  readonly flags?: readonly string[];
  readonly internalDate?: string;
  readonly size?: number;
  readonly modseq?: number;
  readonly envelope?: Envelope;
  readonly structure?: Part;
  /** Body sections by name, e.g. "BODY[1]" or "BODY[HEADER.FIELDS (FROM)]", as the bytes the server sent. */
  readonly body: Readonly<Record<string, Buffer>>;
}

/** FETCH data from an untagged FETCH response. */
export function fetched(r: Response): Fetched {
  if (r.kind !== 'untagged' || r.type !== 'fetch' || r.number === undefined) throw new ImapParseError('not a FETCH response');
  const items = listOf(r.data[0]);
  const out: { -readonly [K in keyof Fetched]: Fetched[K] } & { body: Record<string, Buffer> } = { seq: r.number, body: {} };
  for (let i = 0; i + 1 < items.length; i += 2) {
    const key = (text(items[i]) ?? '').toUpperCase();
    const v = items[i + 1]!;
    if (key === 'UID') {
      const u = numOf(v);
      if (u !== undefined) out.uid = u;
    } else if (key === 'FLAGS') out.flags = listOf(v).map((x) => text(x) ?? '');
    else if (key === 'INTERNALDATE') {
      const d = text(v);
      if (d !== undefined) out.internalDate = d;
    } else if (key === 'RFC822.SIZE') {
      const s = numOf(v);
      if (s !== undefined) out.size = s;
    } else if (key === 'MODSEQ') {
      const m = numOf(listOf(v)[0]);
      if (m !== undefined) out.modseq = m;
    } else if (key === 'ENVELOPE') out.envelope = envelope(v);
    else if (key === 'BODYSTRUCTURE' || key === 'BODY') out.structure = bodyStructure(v);
    else if (key.startsWith('BODY[') || key.startsWith('BINARY[')) {
      const s = v.kind === 'string' ? (v.bytes ?? Buffer.from(v.value, 'utf8')) : undefined;
      if (s) out.body[key] = s;
    }
  }
  return out;
}

/** The mailbox state an untagged status response or SELECT's untagged data adds up to. */
export interface MailboxInfo {
  readonly exists?: number;
  readonly recent?: number;
  readonly uidValidity?: number;
  readonly uidNext?: number;
  readonly highestModSeq?: number;
  readonly flags?: readonly string[];
  readonly permanentFlags?: readonly string[];
  readonly readOnly?: boolean;
}
export function mailboxInfo(rs: readonly Response[]): MailboxInfo {
  const o: { -readonly [K in keyof MailboxInfo]: MailboxInfo[K] } = {};
  for (const r of rs) {
    if (r.kind === 'tagged' && r.code?.name === 'READ-ONLY') o.readOnly = true;
    if (r.kind === 'tagged' && r.code?.name === 'READ-WRITE') o.readOnly = false;
    if (r.kind !== 'untagged') continue;
    if (r.type === 'exists' && r.number !== undefined) o.exists = r.number;
    else if (r.type === 'recent' && r.number !== undefined) o.recent = r.number;
    else if (r.type === 'flags') o.flags = listOf(r.data[0]).map((x) => text(x) ?? '');
    else if (r.type === 'status' && r.code) {
      const a = numOf(r.code.args[0]);
      if (r.code.name === 'UIDVALIDITY' && a !== undefined) o.uidValidity = a;
      else if (r.code.name === 'UIDNEXT' && a !== undefined) o.uidNext = a;
      else if (r.code.name === 'HIGHESTMODSEQ' && a !== undefined) o.highestModSeq = a;
      else if (r.code.name === 'PERMANENTFLAGS') o.permanentFlags = listOf(r.code.args[0]).map((x) => text(x) ?? '');
    }
  }
  return o;
}

/** Numbers from SEARCH (rev1) or the ALL and COUNT parts of ESEARCH (rev2), as a plain list of ids. */
export function searchResult(r: Response): { ids: number[]; uid: boolean; count?: number } {
  if (r.kind !== 'untagged') throw new ImapParseError('not a SEARCH response');
  if (r.type === 'search') return { ids: r.data.map((n) => numOf(n)).filter((n): n is number => n !== undefined), uid: false };
  if (r.type !== 'esearch') throw new ImapParseError('not a SEARCH response');
  let uid = false;
  let ids: number[] = [];
  let count: number | undefined;
  for (let i = 0; i < r.data.length; i++) {
    const k = (text(r.data[i]) ?? '').toUpperCase();
    if (k === 'UID') uid = true;
    else if (k === 'COUNT') count = numOf(r.data[++i]);
    else if (k === 'ALL') ids = parseSet(text(r.data[++i]) ?? '', Number.MAX_SAFE_INTEGER, 1_000_000);
  }
  return { ids, uid, ...(count !== undefined ? { count } : {}) };
}

// ------------------------------------------------------------------------------------------------------ sets

/** A set such as "1:5,7,10:*" read into ids. "*" means `max`; ranges may be written either way round. At most `cap` ids. */
export function parseSet(s: string, max: number, cap = 1_000_000): number[] {
  if (!/^(?:(?:\d+|\*)(?::(?:\d+|\*))?)(?:,(?:\d+|\*)(?::(?:\d+|\*))?)*$/.test(s)) throw new ImapParseError(`not a sequence set: ${s.slice(0, 40)}`);
  const val = (t: string) => (t === '*' ? max : Number(t));
  const out = new Set<number>();
  for (const part of s.split(',')) {
    const [a, b] = part.split(':').map(val) as [number, number | undefined];
    const lo = Math.min(a, b ?? a);
    const hi = Math.max(a, b ?? a);
    if (lo < 1) throw new ImapParseError('a sequence set starts at 1');
    if (hi - lo + 1 + out.size > cap) throw new ImapParseError(`a sequence set holds more than ${cap} ids`);
    for (let n = lo; n <= hi; n++) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

/** The shortest set for these ids: sorted, repeats removed, runs written as ranges. */
export function formatSet(ids: readonly number[]): string {
  const u = [...new Set(ids)].sort((a, b) => a - b);
  if (u.some((n) => !Number.isInteger(n) || n < 1)) throw new RangeError('ids are whole numbers from 1');
  const out: string[] = [];
  for (let i = 0; i < u.length; ) {
    let j = i;
    while (u[j + 1] === u[j]! + 1) j++;
    out.push(j > i ? `${u[i]}:${u[j]}` : String(u[i]));
    i = j + 1;
  }
  return out.join(',');
}

// ---------------------------------------------------------------------------------------- mailbox name encoding

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,';

/** Modified UTF-7 (RFC 3501 5.1.3): printable ASCII as is, "&" as "&-", anything else in "&...-" runs of base64 UTF-16. */
export function encodeMailbox(name: string): string {
  let out = '';
  let run: number[] = [];
  const flush = () => {
    if (!run.length) return;
    const bytes = Buffer.alloc(run.length * 2);
    run.forEach((u, i) => bytes.writeUInt16BE(u, i * 2));
    let bits = '';
    for (const b of bytes) bits += b.toString(2).padStart(8, '0');
    let enc = '';
    for (let i = 0; i < bits.length; i += 6) enc += B64[parseInt(bits.slice(i, i + 6).padEnd(6, '0'), 2)];
    out += `&${enc}-`;
    run = [];
  };
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) {
      flush();
      out += c === 0x26 ? '&-' : name[i];
    } else run.push(c);
  }
  flush();
  return out;
}

export function decodeMailbox(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; ) {
    if (s[i] !== '&') {
      out += s[i++];
      continue;
    }
    const end = s.indexOf('-', i);
    if (end < 0) throw new ImapParseError('a mailbox name has an unclosed "&"');
    const body = s.slice(i + 1, end);
    if (body === '') out += '&';
    else {
      let bits = '';
      for (const ch of body) {
        const v = B64.indexOf(ch);
        if (v < 0) throw new ImapParseError('a mailbox name has a bad base64 letter');
        bits += v.toString(2).padStart(6, '0');
      }
      const usable = bits.length - (bits.length % 16);
      if (usable === 0 || /1/.test(bits.slice(usable))) throw new ImapParseError('a mailbox name has bad padding');
      for (let k = 0; k < usable; k += 16) out += String.fromCharCode(parseInt(bits.slice(k, k + 16), 2));
    }
    i = end + 1;
  }
  return out;
}

// -------------------------------------------------------------------------------------------------- commands

export type Arg =
  | { readonly atom: string }
  | { readonly text: string }
  | { readonly mailbox: string }
  | { readonly number: number }
  | { readonly set: string }
  | { readonly list: readonly Arg[] }
  | { readonly raw: string }
  | { readonly bytes: Uint8Array };

export interface Segment {
  readonly data: Buffer;
  /** Send nothing more until the server answers "+" (a synchronising literal). */
  readonly waitForContinuation: boolean;
}

const ATOM_OK = /^[A-Za-z0-9!#$&'+,\-./:;<=>?@^_`|~[\]]+$/;
export function checkTag(tag: string): string {
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(tag)) throw new ImapCommandError('a tag is letters, digits, dot, dash or underscore, up to 32');
  return tag;
}
/** Tags A0001, A0002 ... in order, so a response can be matched to its command. */
export function tagger(prefix = 'A'): () => string {
  let n = 0;
  return () => checkTag(`${prefix}${String(++n).padStart(4, '0')}`);
}

/**
 * One command line as segments. Text that cannot be a quoted string (line breaks, 8-bit, over 1000 characters)
 * goes as a literal; with `nonSync` (the server offers LITERAL+) the literal does not wait for a continuation.
 */
export function command(tag: string, name: string, args: readonly Arg[] = [], o: { nonSync?: boolean } = {}): Segment[] {
  if (!/^[A-Z]+(?: [A-Z]+)?$/.test(name)) throw new ImapCommandError('a command name is capital letters');
  const segs: Segment[] = [];
  let cur: Buffer[] = [];
  const text_ = (s: string) => void cur.push(Buffer.from(s, 'latin1'));
  const flush = (waitForContinuation: boolean) => {
    segs.push({ data: Buffer.concat(cur), waitForContinuation });
    cur = [];
  };
  const literal = (bytes: Buffer) => {
    text_(`{${bytes.length}${o.nonSync ? '+' : ''}}\r\n`);
    if (!o.nonSync) flush(true);
    cur.push(bytes);
  };
  const emit = (a: Arg): void => {
    if ('atom' in a) {
      if (!ATOM_OK.test(a.atom) && !/^\\[A-Za-z]+$/.test(a.atom)) throw new ImapCommandError(`not an atom: ${a.atom.slice(0, 20)}`);
      text_(a.atom);
    } else if ('number' in a) {
      if (!Number.isSafeInteger(a.number) || a.number < 0) throw new ImapCommandError('a number is a whole number, zero or more');
      text_(String(a.number));
    } else if ('set' in a) {
      try {
        parseSet(a.set, 1, Number.MAX_SAFE_INTEGER);
      } catch {
        throw new ImapCommandError(`not a sequence set: ${a.set.slice(0, 20)}`);
      }
      text_(a.set);
    } else if ('raw' in a) {
      if (/[\r\n\0]/.test(a.raw)) throw new ImapCommandError('raw text holds a line break');
      text_(a.raw);
    } else if ('list' in a) {
      text_('(');
      a.list.forEach((x, i) => {
        if (i) text_(' ');
        emit(x);
      });
      text_(')');
    } else if ('bytes' in a) {
      if (a.bytes.includes(0)) throw new ImapCommandError('text holds a NUL');
      literal(Buffer.from(a.bytes));
    } else {
      const s = 'mailbox' in a ? encodeMailbox(a.mailbox) : a.text;
      if (s.includes('\0')) throw new ImapCommandError('text holds a NUL');
      if (/[\r\n\u0080-\uffff]/.test(s) || s.length > 1000) literal(Buffer.from(s, 'utf8'));
      else text_(`"${s.replace(/[\\"]/g, '\\$&')}"`);
    }
  };
  text_(`${checkTag(tag)} ${name}`);
  for (const a of args) {
    text_(' ');
    emit(a);
  }
  text_('\r\n');
  flush(false);
  return segs;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A date as SEARCH wants it: 1-Feb-1994, in UTC. */
export const searchDate = (d: Date): string => `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
/** INTERNALDATE ("17-Jul-1996 02:44:25 -0700") as an instant. */
export function parseInternalDate(s: string): Date {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(s);
  const mon = m ? MONTHS.findIndex((x) => x.toLowerCase() === m[2]!.toLowerCase()) : -1;
  if (!m || mon < 0) throw new ImapParseError(`not an internal date: ${s.slice(0, 40)}`);
  const off = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
  return new Date(Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - off * 60_000);
}

export type SearchKey =
  | 'ALL' | 'ANSWERED' | 'DELETED' | 'DRAFT' | 'FLAGGED' | 'NEW' | 'OLD' | 'RECENT' | 'SEEN' | 'UNANSWERED' | 'UNDELETED' | 'UNDRAFT' | 'UNFLAGGED' | 'UNSEEN'
  | { readonly from: string } | { readonly to: string } | { readonly cc: string } | { readonly subject: string } | { readonly body: string } | { readonly text: string }
  | { readonly header: readonly [string, string] } | { readonly since: Date } | { readonly before: Date } | { readonly on: Date }
  | { readonly larger: number } | { readonly smaller: number } | { readonly keyword: string } | { readonly uid: string }
  | { readonly not: SearchKey } | { readonly or: readonly [SearchKey, SearchKey] } | { readonly and: readonly SearchKey[] };

/** SEARCH criteria as arguments: strings quoted or sent as literals, never pasted in. */
export function searchArgs(k: SearchKey): Arg[] {
  if (typeof k === 'string') return [{ atom: k }];
  if ('from' in k) return [{ atom: 'FROM' }, { text: k.from }];
  if ('to' in k) return [{ atom: 'TO' }, { text: k.to }];
  if ('cc' in k) return [{ atom: 'CC' }, { text: k.cc }];
  if ('subject' in k) return [{ atom: 'SUBJECT' }, { text: k.subject }];
  if ('body' in k) return [{ atom: 'BODY' }, { text: k.body }];
  if ('text' in k) return [{ atom: 'TEXT' }, { text: k.text }];
  if ('header' in k) return [{ atom: 'HEADER' }, { text: k.header[0] }, { text: k.header[1] }];
  if ('since' in k) return [{ atom: 'SINCE' }, { atom: searchDate(k.since) }];
  if ('before' in k) return [{ atom: 'BEFORE' }, { atom: searchDate(k.before) }];
  if ('on' in k) return [{ atom: 'ON' }, { atom: searchDate(k.on) }];
  if ('larger' in k) return [{ atom: 'LARGER' }, { number: k.larger }];
  if ('smaller' in k) return [{ atom: 'SMALLER' }, { number: k.smaller }];
  if ('keyword' in k) return [{ atom: 'KEYWORD' }, { atom: k.keyword }];
  if ('uid' in k) return [{ atom: 'UID' }, { set: k.uid }];
  if ('not' in k) return [{ atom: 'NOT' }, ...group(k.not)];
  if ('or' in k) return [{ atom: 'OR' }, ...group(k.or[0]), ...group(k.or[1])];
  return k.and.flatMap((x) => group(x));
}
const group = (k: SearchKey): Arg[] => (typeof k === 'object' && 'and' in k && k.and.length !== 1 ? [{ list: searchArgs(k) }] : searchArgs(k));

// ---------------------------------------------------------------------------------------------- session state

export type State = 'not-authenticated' | 'authenticated' | 'selected' | 'logout';

const ANY = new Set(['CAPABILITY', 'NOOP', 'LOGOUT']);
const NOT_AUTH = new Set(['STARTTLS', 'AUTHENTICATE', 'LOGIN']);
const AUTH = new Set(['ENABLE', 'SELECT', 'EXAMINE', 'CREATE', 'DELETE', 'RENAME', 'SUBSCRIBE', 'UNSUBSCRIBE', 'LIST', 'LSUB', 'NAMESPACE', 'STATUS', 'APPEND', 'IDLE']);
const SELECTED = new Set(['CLOSE', 'UNSELECT', 'EXPUNGE', 'SEARCH', 'FETCH', 'STORE', 'COPY', 'MOVE', 'UID']);

export interface Event {
  readonly type: 'exists' | 'expunge' | 'flags' | 'recent' | 'vanished' | 'bye';
  readonly number?: number;
  readonly text?: string;
}

/** What the connection may do now. It follows the server's answers, not the client's hopes. */
export class Session {
  state: State = 'not-authenticated';
  idling = false;
  mailbox: string | undefined;
  private idleTag: string | undefined;
  private readonly pending = new Map<string, { name: string; arg?: string }>();
  private idleReady = false;

  /** Register a command about to be sent; refuses the ones that make no sense in the current state. */
  send(tag: string, name: string, mailbox?: string): void {
    if (this.state === 'logout') throw new ImapStateError('the connection is closing');
    if (this.idling) throw new ImapStateError('IDLE is running: send DONE first');
    const ok = ANY.has(name) || (this.state === 'not-authenticated' && NOT_AUTH.has(name)) || (this.state !== 'not-authenticated' && AUTH.has(name)) || (this.state === 'selected' && SELECTED.has(name));
    if (!ok) throw new ImapStateError(`${name} is not allowed when ${this.state.replace('-', ' ')}`);
    if (name === 'IDLE') this.idleTag = tag;
    this.pending.set(tag, { name, ...(mailbox !== undefined ? { arg: mailbox } : {}) });
    // a failed SELECT leaves no mailbox selected, so the state changes when it is tried
    if (name === 'SELECT' || name === 'EXAMINE') if (this.state === 'selected') (this.state = 'authenticated'), (this.mailbox = undefined);
  }

  /** Feed each response in; the state follows, and mailbox events are returned for the caller to act on. */
  receive(r: Response): Event[] {
    const events: Event[] = [];
    if (r.kind === 'continuation') {
      if (this.idleTag !== undefined && !this.idleReady) {
        this.idleReady = true;
        this.idling = true;
      }
      return events;
    }
    if (r.kind === 'untagged') {
      if (r.type === 'status' && r.status === 'PREAUTH') this.state = 'authenticated';
      if (r.type === 'status' && r.status === 'BYE') {
        this.state = 'logout';
        events.push({ type: 'bye', ...(r.text ? { text: r.text } : {}) });
      }
      if (r.number !== undefined && (r.type === 'exists' || r.type === 'expunge' || r.type === 'recent')) events.push({ type: r.type, number: r.number });
      if (r.type === 'fetch' && r.number !== undefined) events.push({ type: 'flags', number: r.number });
      if (r.type === 'vanished') events.push({ type: 'vanished', ...(r.data.length ? { text: text(r.data.at(-1)) ?? '' } : {}) });
      return events;
    }
    const cmd = this.pending.get(r.tag);
    if (!cmd) throw new ImapStateError(`an answer for a command never sent: ${r.tag}`);
    this.pending.delete(r.tag);
    if (r.tag === this.idleTag) {
      this.idleTag = undefined;
      this.idling = false;
      this.idleReady = false;
    }
    const ok = r.status === 'OK';
    if (cmd.name === 'LOGIN' || cmd.name === 'AUTHENTICATE') {
      if (ok) this.state = 'authenticated';
    } else if (cmd.name === 'SELECT' || cmd.name === 'EXAMINE') {
      if (ok) (this.state = 'selected'), (this.mailbox = cmd.arg);
      else (this.state = 'authenticated'), (this.mailbox = undefined);
    } else if ((cmd.name === 'CLOSE' || cmd.name === 'UNSELECT') && ok) (this.state = 'authenticated'), (this.mailbox = undefined);
    else if (cmd.name === 'LOGOUT') this.state = 'logout';
    return events;
  }

  /** The tag of the running IDLE, which DONE (not a tagged command) ends. */
  doneBytes(): Buffer {
    if (!this.idling) throw new ImapStateError('IDLE is not running');
    return Buffer.from('DONE\r\n', 'latin1');
  }
}

// ----------------------------------------------------------------------------------------------- UID handling

export interface Cached {
  readonly uidValidity: number;
  /** The highest UID already stored. */
  readonly lastUid: number;
  readonly uids: readonly number[];
}
export interface SelectedState {
  readonly uidValidity: number;
  readonly uidNext: number;
  readonly exists: number;
}
export type SyncPlan =
  | { readonly action: 'start-over'; readonly reason: string; readonly fetch: string }
  | { readonly action: 'catch-up'; readonly fetch: string; readonly check: string; readonly expectNew: number };

/**
 * Decide what a cache may keep after SELECT. UIDs are only meaningful with their UIDVALIDITY (RFC 3501 2.3.1.1):
 * a different one means every cached UID refers to something else, so everything is dropped and refetched.
 * Otherwise fetch what is above the last stored UID, and ask for the flags of what is held, to find changes.
 */
export function planSync(cached: Cached | undefined, now: SelectedState): SyncPlan {
  if (now.uidValidity <= 0) throw new ImapParseError('UIDVALIDITY is a positive number');
  if (!cached) return { action: 'start-over', reason: 'nothing is cached', fetch: now.exists ? '1:*' : '' };
  if (cached.uidValidity !== now.uidValidity) return { action: 'start-over', reason: `UIDVALIDITY changed from ${cached.uidValidity} to ${now.uidValidity}`, fetch: now.exists ? '1:*' : '' };
  const from = cached.lastUid + 1;
  return { action: 'catch-up', fetch: from < now.uidNext ? `${from}:*` : '', check: cached.uids.length ? formatSet(cached.uids) : '', expectNew: Math.max(0, now.uidNext - from) };
}

/** Which cached UIDs are gone, given the UIDs the server still has. */
export const expunged = (cached: readonly number[], server: readonly number[]): number[] => {
  const have = new Set(server);
  return cached.filter((u) => !have.has(u));
};

// ------------------------------------------------------------------------------------------------- IDLE plan

export interface IdleState {
  readonly supportsIdle: boolean;
  /** When the current IDLE was started, or undefined if not idling. */
  readonly idleSince?: number;
  readonly lastPollAt?: number;
  readonly now: number;
}
export type IdleAction = { readonly do: 'idle' } | { readonly do: 'restart-idle'; readonly why: string } | { readonly do: 'wait'; readonly until: number } | { readonly do: 'poll' };

/** RFC 2177: a server may drop a client idle for 30 minutes, so IDLE is re-issued every 29 at most. Without IDLE, poll with NOOP. */
export function idlePlan(s: IdleState, o: { maxIdleMs?: number; pollMs?: number } = {}): IdleAction {
  const maxIdle = Math.min(o.maxIdleMs ?? 29 * 60_000, 29 * 60_000);
  const poll = o.pollMs ?? 60_000;
  if (!s.supportsIdle) {
    if (s.lastPollAt === undefined || s.now - s.lastPollAt >= poll) return { do: 'poll' };
    return { do: 'wait', until: s.lastPollAt + poll };
  }
  if (s.idleSince === undefined) return { do: 'idle' };
  if (s.now - s.idleSince >= maxIdle) return { do: 'restart-idle', why: `idle for ${Math.floor((s.now - s.idleSince) / 60_000)} minutes, under the 30-minute server limit` };
  return { do: 'wait', until: s.idleSince + maxIdle };
}
