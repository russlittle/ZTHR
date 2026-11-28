/**
 * Internet messages (RFC 5322) and their MIME structure (RFCs 2045 to 2049, 2183, 2231, 2392): read a message into a
 * tree of parts with decoded headers, bodies and attachments, and build one from text, html, inline images and
 * attachments. Covers quoted-printable and base64 bodies, RFC 2047 encoded words in headers (with the rule that
 * whitespace between two of them is dropped), RFC 2231 parameter continuations and extended values, charsets through
 * the platform's decoders, header folding at 78 columns, address lists with display names, groups and comments,
 * Content-ID references (`cid:`) for inline images, and attachment names made safe to store.
 *
 * Reading refuses to be a way in: sizes, nesting and part counts are capped; header values containing a bare CR or LF
 * cannot be built (header injection); attachment names lose path parts, control characters and bidi overrides.
 * Building takes the clock and random source as arguments. Out of scope: SMTP itself, S/MIME and PGP, internationalised
 * mailbox local parts (SMTPUTF8; domains are converted to punycode), TNEF, and transport of 8-bit bodies (non-ASCII text
 * is always sent quoted-printable).
 */
import { domainToASCII } from 'node:url';

export class MimeError extends Error {
  constructor(why: string) {
    super(why);
  }
}

// ---------------------------------------------------------------- transfer encodings

/** Quoted-printable (RFC 2045 6.7) decoding; soft line breaks removed, invalid escapes kept as written. */
export function decodeQuotedPrintable(input: string): Buffer {
  const out: number[] = [];
  const s = input.replace(/\r\n/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x3d) {
      if (s[i + 1] === '\n') {
        i += 1;
        continue;
      }
      if (s[i + 1] === ' ' || s[i + 1] === '\t') {
        // A soft break with trailing whitespace before the newline: tolerated.
        const m = /^[ \t]*\n/.exec(s.slice(i + 1));
        if (m) {
          i += m[0].length;
          continue;
        }
      }
      const h = s.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(h)) {
        out.push(parseInt(h, 16));
        i += 2;
        continue;
      }
      out.push(c);
    } else if (c === 0x0a) out.push(0x0d, 0x0a);
    else out.push(c & 0xff);
  }
  return Buffer.from(out);
}

/** Quoted-printable encoding with lines of at most 76 characters. `binary` encodes line breaks too (for non-text data). */
export function encodeQuotedPrintable(data: Uint8Array, binary = false): string {
  const bytes = Buffer.from(data);
  const lines: string[] = [];
  let line = '';
  const flush = (soft: boolean) => {
    lines.push(soft ? `${line}=` : line);
    line = '';
  };
  const add = (tok: string) => {
    // Leave room for the "=" a soft break needs.
    if (line.length + tok.length > 75) flush(true);
    line += tok;
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (!binary && b === 0x0d && bytes[i + 1] === 0x0a) {
      i++;
      endLine();
    } else if (!binary && b === 0x0a) endLine();
    else if ((b >= 33 && b <= 126 && b !== 0x3d) || ((b === 0x20 || b === 0x09) && !atEnd(i))) add(String.fromCharCode(b));
    else add(`=${b.toString(16).toUpperCase().padStart(2, '0')}`);
  }
  function atEnd(i: number): boolean {
    // Whitespace before a line break (or the end) must be encoded, or a gateway may strip it.
    const n = bytes[i + 1];
    return n === undefined || n === 0x0d || n === 0x0a;
  }
  function endLine() {
    lines.push(line);
    line = '';
  }
  lines.push(line);
  return lines.join('\r\n');
}

/** Base64 in lines of 76 characters, CRLF separated. */
export const encodeBase64Lines = (data: Uint8Array): string => (Buffer.from(data).toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');

/** Base64 that ignores whitespace and missing padding; characters outside the alphabet make it fail. */
export function decodeBase64Lenient(s: string): { data: Buffer; clean: boolean } {
  const stripped = s.replace(/[\r\n\t ]+/g, '');
  const clean = /^[A-Za-z0-9+/]*={0,2}$/.test(stripped);
  return { data: Buffer.from(stripped.replace(/[^A-Za-z0-9+/]/g, ''), 'base64'), clean };
}

// ---------------------------------------------------------------- charsets

export function decodeCharset(bytes: Uint8Array, charset: string | undefined): { text: string; fallback: boolean } {
  const label = (charset ?? 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '') || 'utf-8';
  try {
    // Mail says us-ascii; the web's us-ascii decoder is windows-1252, which is what readers expect.
    return { text: new TextDecoder(label === 'us-ascii' ? 'windows-1252' : label).decode(bytes), fallback: false };
  } catch {
    return { text: new TextDecoder('utf-8').decode(bytes), fallback: true };
  }
}

// ---------------------------------------------------------------- RFC 2047 encoded words

const WORD = /=\?([^?\s]+)\?([QqBb])\?([^?\s]*)\?=/g;

/** Decodes encoded words in an unstructured header value. Whitespace between two encoded words is not text. */
export function decodeWords(value: string): string {
  let out = '';
  let last = 0;
  let prevWord = false;
  for (const m of value.matchAll(WORD)) {
    const between = value.slice(last, m.index);
    let text: string;
    try {
      const charset = m[1]!.replace(/\*[^*]*$/, '');
      const bytes = m[2]!.toLowerCase() === 'b' ? Buffer.from(m[3]!, 'base64') : decodeQuotedPrintable(m[3]!.replace(/_/g, ' ').replace(/=(?![0-9A-Fa-f]{2})/g, '=3D'));
      text = decodeCharset(bytes, charset).text;
    } catch {
      continue;
    }
    out += prevWord && /^[ \t\r\n]*$/.test(between) ? '' : between;
    out += text;
    last = m.index! + m[0].length;
    prevWord = true;
  }
  return out + value.slice(last);
}

/** Splits UTF-8 text into chunks of at most `max` bytes without cutting a character. */
function utf8Chunks(s: string, max: number): Buffer[] {
  const out: Buffer[] = [];
  let cur: number[] = [];
  for (const ch of s) {
    const b = Buffer.from(ch, 'utf8');
    if (cur.length + b.length > max) {
      out.push(Buffer.from(cur));
      cur = [];
    }
    cur.push(...b);
  }
  if (cur.length) out.push(Buffer.from(cur));
  return out;
}

/** Encodes text as RFC 2047 words (UTF-8, base64), each at most 75 characters, never splitting a character. */
export function encodeWords(s: string): string[] {
  return utf8Chunks(s, 45).map((c) => `=?UTF-8?B?${c.toString('base64')}?=`);
}

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** Rejects a bare CR or LF in anything that will become a header (it would start another header). */
export function safeHeaderValue(v: string, what = 'header'): string {
  if (/[\r\n\0]/.test(v)) throw new MimeError(`a line break in ${what}: that would inject a header`);
  return v;
}

/** Folds a header to lines of at most 78 columns where there is whitespace to fold at. */
export function foldHeader(name: string, value: string): string {
  const words = value.split(/ +/);
  const lines: string[] = [];
  let line = `${name}:`;
  for (const w of words) {
    if (line.length + 1 + w.length > 78 && line.length > 0) {
      lines.push(line);
      line = ` ${w}`;
    } else line += ` ${w}`;
  }
  lines.push(line);
  return lines.join('\r\n');
}

/** A header value for free text (a subject): as is when ASCII, otherwise encoded words separated by spaces. */
export function textValue(s: string): string {
  safeHeaderValue(s);
  return isAscii(s) ? s : encodeWords(s).join(' ');
}

// ---------------------------------------------------------------- addresses

export interface Mailbox {
  readonly name?: string;
  readonly address: string;
  readonly group?: string;
}

const SPECIALS = /[()<>[\]:;@\\,."]/;
const ATOM_LIST = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]+$/;

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(.)/g, '$1');
  return t;
}

/** Splits at top level on a separator, ignoring any inside quotes, comments and angle brackets. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = false;
  let comment = 0;
  let angle = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      cur += c;
      if (c === '\\') cur += s[++i] ?? '';
      else if (c === '"') quote = false;
      continue;
    }
    if (comment) {
      cur += c;
      if (c === '\\') cur += s[++i] ?? '';
      else if (c === '(') comment++;
      else if (c === ')') comment--;
      continue;
    }
    if (c === '"') quote = true;
    else if (c === '(') comment = 1;
    else if (c === '<') angle = true;
    else if (c === '>') angle = false;
    if (c === sep && !angle) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const stripComments = (s: string): string => {
  let out = '';
  let depth = 0;
  let quote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      out += c;
      if (c === '\\') out += s[++i] ?? '';
      else if (c === '"') quote = false;
    } else if (depth) {
      if (c === '\\') i++;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    } else if (c === '"') {
      quote = true;
      out += c;
    } else if (c === '(') depth = 1;
    else out += c;
  }
  return out;
};

const ADDR = /^[^\s@<>(),;:\\"[\]]+@[^\s@<>(),;:\\"[\]]+$/;

function mailbox(s: string, group?: string): Mailbox | undefined {
  const t = stripComments(s).trim();
  if (!t) return undefined;
  const lt = t.lastIndexOf('<');
  if (lt >= 0 && t.endsWith('>')) {
    const address = t.slice(lt + 1, -1).replace(/^@[^:]*:/, '').trim();
    if (!ADDR.test(address)) return undefined;
    const raw = t.slice(0, lt).trim();
    const name = raw ? decodeWords(unquote(raw)).trim() : '';
    return { ...(name ? { name } : {}), address, ...(group ? { group } : {}) };
  }
  if (ADDR.test(t)) return { address: t, ...(group ? { group } : {}) };
  return undefined;
}

/** Reads an address header: mailboxes, display names (quoted or encoded), comments, and groups. Unreadable entries are skipped. */
export function parseAddresses(value: string): Mailbox[] {
  const out: Mailbox[] = [];
  let group: string | undefined;
  for (let item of splitTop(value, ',')) {
    if (group === undefined) {
      const colon = splitTop(item, ':');
      if (colon.length > 1) {
        group = decodeWords(unquote(stripComments(colon[0]!))).trim() || undefined;
        item = colon.slice(1).join(':');
        if (group === undefined) group = '';
      }
    }
    let ends = false;
    const t = item.trim();
    if (group !== undefined && t.endsWith(';')) {
      ends = true;
      item = t.slice(0, -1);
    }
    const b = mailbox(item, group || undefined);
    if (b) out.push(b);
    if (ends) group = undefined;
  }
  return out;
}

/** An address as it goes into a header: names quoted or encoded as needed, the domain as punycode. */
export function formatMailbox(m: { name?: string; address: string }): string {
  safeHeaderValue(m.address, 'an address');
  const at = m.address.lastIndexOf('@');
  if (at < 1) throw new MimeError(`${JSON.stringify(m.address)} is not an address`);
  const local = m.address.slice(0, at);
  const domain = domainToASCII(m.address.slice(at + 1));
  if (!domain || !isAscii(local) || !ADDR.test(`${local}@${domain}`)) throw new MimeError(`${JSON.stringify(m.address)} is not an address this block can send to`);
  const addr = `${local}@${domain}`;
  if (!m.name) return addr;
  safeHeaderValue(m.name, 'a name');
  if (!isAscii(m.name)) return `${encodeWords(m.name).join(' ')} <${addr}>`;
  return `${ATOM_LIST.test(m.name) && !SPECIALS.test(m.name) ? m.name : `"${m.name.replace(/(["\\])/g, '\\$1')}"`} <${addr}>`;
}

// ---------------------------------------------------------------- parameters (RFC 2045, 2231)

export interface ParamValue {
  readonly value: string;
  readonly params: Readonly<Record<string, string>>;
}

/** Reads "value; name=token; name="quoted"; name*0*=...; name*=charset'lang'%XX" into decoded parameters. */
export function parseParams(header: string): ParamValue {
  const parts = splitTop(stripComments(header), ';');
  const value = parts[0]!.trim().toLowerCase();
  const raw = new Map<string, { n: number; ext: boolean; v: string }[]>();
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    let name = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim();
    v = v.startsWith('"') ? unquote(v) : v;
    let n = 0;
    let ext = false;
    const m = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(name);
    if (m) {
      name = m[1]!;
      if (m[2] !== undefined) n = Number(m[2]);
      ext = m[3] === '*';
    }
    const list = raw.get(name) ?? [];
    list.push({ n, ext, v });
    raw.set(name, list);
  }
  const params: Record<string, string> = {};
  for (const [name, list] of raw) {
    // A plain value and an extended one for the same part: the extended one is the one meant.
    const byN = new Map<number, { n: number; ext: boolean; v: string }>();
    for (const seg of list) if (!byN.has(seg.n) || (seg.ext && !byN.get(seg.n)!.ext)) byN.set(seg.n, seg);
    list.splice(0, list.length, ...byN.values());
    list.sort((a, b) => a.n - b.n);
    if (list.length > 50) continue;
    let charset = 'utf-8';
    const bytes: number[] = [];
    let text = '';
    let extended = false;
    list.forEach((seg, i) => {
      let v = seg.v;
      if (seg.ext) {
        extended = true;
        if (i === 0) {
          const m = /^([^']*)'[^']*'(.*)$/s.exec(v);
          if (m) {
            charset = m[1] || 'utf-8';
            v = m[2]!;
          }
        }
        for (let k = 0; k < v.length; k++) {
          if (v[k] === '%' && /^[0-9A-Fa-f]{2}$/.test(v.slice(k + 1, k + 3))) {
            bytes.push(parseInt(v.slice(k + 1, k + 3), 16));
            k += 2;
          } else bytes.push(...Buffer.from(v[k]!, 'utf8'));
        }
      } else {
        if (extended || bytes.length) bytes.push(...Buffer.from(v, 'utf8'));
        else text += v;
      }
    });
    params[name] = extended || bytes.length ? decodeCharset(Buffer.from([...Buffer.from(text, 'utf8'), ...bytes]), charset).text : text;
  }
  // The extended form wins over a plain one with the same name (RFC 2231 section 4.1 ordering for compatibility).
  return { value, params };
}

/** One parameter for a header: plain when it can be, RFC 2231 extended (with a plain ASCII fallback) when not. */
export function formatParam(name: string, value: string): string {
  safeHeaderValue(value, `parameter ${name}`);
  if (/^[\x20-\x7e]*$/.test(value)) return /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(value) ? `${name}=${value}` : `${name}="${value.replace(/(["\\])/g, '\\$1')}"`;
  const enc = [...Buffer.from(value, 'utf8')].map((b) => (/[A-Za-z0-9!#$&+.^_`|~-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`)).join('');
  const fallback = value.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\x20-\x7e]/g, '_').replace(/(["\\])/g, '\\$1');
  return `${name}*=UTF-8''${enc}; ${name}="${fallback}"`;
}

/** A name safe to store: no path, no control or bidi override characters, no leading dots, at most 255 bytes. */
export function safeFilename(name: string | undefined, fallback = 'attachment'): string {
  let n = (name ?? '').normalize('NFC').replace(/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  n = n.split(/[\\/]/).pop()!.replace(/[:*?"<>|]/g, '_').replace(/^[. ]+/, '').replace(/[. ]+$/, '');
  if (!n || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = n ? `_${n}` : fallback;
  while (Buffer.byteLength(n) > 255) n = n.slice(0, -1);
  return n;
}

// ---------------------------------------------------------------- parsing

export interface Header {
  readonly name: string;
  /** Unfolded, as received. */
  readonly raw: string;
}

export interface Part {
  readonly headers: readonly Header[];
  readonly type: string;
  readonly params: Readonly<Record<string, string>>;
  readonly disposition: 'inline' | 'attachment' | undefined;
  readonly filename: string | undefined;
  readonly contentId: string | undefined;
  readonly encoding: string;
  /** The body after transfer decoding (for multipart, the raw text between the boundaries is not kept). */
  readonly body: Buffer;
  /** Text bodies decoded from their charset. */
  readonly text: string | undefined;
  readonly parts: readonly Part[];
  readonly problems: readonly string[];
}

export interface ParseOptions {
  readonly maxBytes?: number;
  readonly maxParts?: number;
  readonly maxDepth?: number;
  readonly maxHeaders?: number;
}

export const header = (p: { headers: readonly Header[] }, name: string): string | undefined => p.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.raw;
export const headers = (p: { headers: readonly Header[] }, name: string): string[] => p.headers.filter((h) => h.name.toLowerCase() === name.toLowerCase()).map((h) => h.raw);
/** A header's value as text, with encoded words decoded. */
export const headerText = (p: { headers: readonly Header[] }, name: string): string | undefined => {
  const v = header(p, name);
  return v === undefined ? undefined : decodeWords(v).trim();
};

function splitHead(s: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(s);
  if (!m) return /^[^\s:]+:/.test(s) ? { head: s, body: '' } : { head: '', body: s };
  return { head: s.slice(0, m.index), body: s.slice(m.index + m[0].length) };
}

function parseHeaders(head: string, max: number, problems: string[]): Header[] {
  const out: Header[] = [];
  let cur: { name: string; raw: string } | undefined;
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (cur) cur.raw = cur.raw ? `${cur.raw} ${line.trim()}` : line.trim();
      continue;
    }
    if (cur) out.push(cur);
    cur = undefined;
    const i = line.indexOf(':');
    if (i < 1 || /[\s\x00-\x1f]/.test(line.slice(0, i))) {
      if (line.trim()) problems.push(`a header line without a name: ${JSON.stringify(line.slice(0, 30))}`);
      continue;
    }
    cur = { name: line.slice(0, i), raw: line.slice(i + 1).trim() };
    if (out.length >= max) throw new MimeError('too many headers');
  }
  if (cur) out.push(cur);
  return out;
}

export function parseMessage(input: Uint8Array | string, o: ParseOptions = {}): Part {
  const max = o.maxBytes ?? 25 * 1024 * 1024;
  const bytes = typeof input === 'string' ? Buffer.from(input, 'latin1') : Buffer.from(input);
  if (bytes.length > max) throw new MimeError(`a message over ${max} bytes`);
  const budget = { parts: o.maxParts ?? 1000, bytes: max };
  // Bytes are held as latin1 text so every byte survives to its own part's charset decoding.
  return parsePart(bytes.toString('latin1'), 0, o.maxDepth ?? 20, o.maxHeaders ?? 500, budget, 'text/plain');
}

function parsePart(s: string, depth: number, maxDepth: number, maxHeaders: number, budget: { parts: number; bytes: number }, defaultType: string): Part {
  if (--budget.parts < 0) throw new MimeError('too many parts');
  if (depth > maxDepth) throw new MimeError('parts nested too deeply');
  const problems: string[] = [];
  const { head, body } = splitHead(s);
  const hs = parseHeaders(head, maxHeaders, problems);
  const ct = parseParams(header({ headers: hs }, 'content-type') ?? defaultType);
  const type = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(ct.value) ? ct.value : 'text/plain';
  const cd = header({ headers: hs }, 'content-disposition');
  const disp = cd ? parseParams(cd) : undefined;
  const dv: 'inline' | 'attachment' | undefined = disp?.value === 'attachment' ? 'attachment' : disp?.value === 'inline' ? 'inline' : undefined;
  const nameParam = disp?.params['filename'] ?? ct.params['name'];
  const filename = nameParam === undefined ? undefined : safeFilename(decodeWords(nameParam));
  const cid = header({ headers: hs }, 'content-id')?.replace(/^<|>$/g, '').trim();
  const encoding = (header({ headers: hs }, 'content-transfer-encoding') ?? '7bit').trim().toLowerCase();
  const common = { headers: hs, type, params: ct.params, disposition: dv, filename, contentId: cid || undefined, encoding };
  if (type.startsWith('multipart/')) {
    const boundary = ct.params['boundary'];
    if (!boundary || boundary.length > 200) {
      problems.push('multipart without a usable boundary');
      return { ...common, body: Buffer.alloc(0), text: undefined, parts: [], problems };
    }
    const sub = splitMultipart(body, boundary, problems).map((p) => parsePart(p, depth + 1, maxDepth, maxHeaders, budget, type === 'multipart/digest' ? 'message/rfc822' : 'text/plain'));
    return { ...common, body: Buffer.alloc(0), text: undefined, parts: sub, problems };
  }
  let data: Buffer;
  if (encoding === 'base64') {
    const r = decodeBase64Lenient(body);
    if (!r.clean) problems.push('base64 with characters outside the alphabet');
    data = r.data;
  } else if (encoding === 'quoted-printable') data = decodeQuotedPrintable(body);
  else {
    if (!['7bit', '8bit', 'binary'].includes(encoding)) problems.push(`unknown transfer encoding ${JSON.stringify(encoding.slice(0, 20))}`);
    data = Buffer.from(body, 'latin1');
  }
  budget.bytes -= data.length;
  if (budget.bytes < 0) throw new MimeError('decoded parts are larger than allowed');
  if (type === 'message/rfc822' && depth < maxDepth) {
    const inner = parsePart(data.toString('latin1'), depth + 1, maxDepth, maxHeaders, budget, 'text/plain');
    return { ...common, body: data, text: undefined, parts: [inner], problems };
  }
  let text: string | undefined;
  if (type.startsWith('text/')) {
    const r = decodeCharset(data, ct.params['charset']);
    text = r.text;
    if (r.fallback) problems.push(`unknown charset ${JSON.stringify(String(ct.params['charset']).slice(0, 30))}, read as UTF-8`);
  }
  return { ...common, body: data, text, parts: [], problems };
}

function splitMultipart(body: string, boundary: string, problems: string[]): string[] {
  const delim = `--${boundary}`;
  const parts: string[] = [];
  const lines = body.split(/\r?\n/);
  let cur: string[] | undefined;
  let closed = false;
  for (const line of lines) {
    const t = line.replace(/[ \t]+$/, '');
    if (t === delim) {
      if (cur) parts.push(cur.join('\r\n'));
      cur = [];
    } else if (t === `${delim}--`) {
      if (cur) parts.push(cur.join('\r\n'));
      cur = undefined;
      closed = true;
      break;
    } else if (cur) cur.push(line);
  }
  if (cur) parts.push(cur.join('\r\n'));
  if (!closed) problems.push('the closing boundary is missing');
  return parts;
}

// ---------------------------------------------------------------- reading a message the way a person does

export interface Attachment {
  readonly filename: string;
  readonly type: string;
  readonly data: Buffer;
  readonly inline: boolean;
  readonly contentId: string | undefined;
}

/** Walks all parts, depth first, not entering attached messages unless asked. */
export function* walk(p: Part, intoMessages = false): Generator<Part> {
  yield p;
  if (p.type === 'message/rfc822' && !intoMessages) return;
  for (const c of p.parts) yield* walk(c, intoMessages);
}

/** The text and html bodies a reader would show: the first non-attachment of each, looking inside alternatives. */
export function bodies(root: Part): { text: string | undefined; html: string | undefined } {
  let text: string | undefined;
  let html: string | undefined;
  for (const p of walk(root)) {
    if (p.parts.length || p.disposition === 'attachment' || p.text === undefined) continue;
    if (p.type === 'text/plain' && text === undefined) text = p.text;
    else if (p.type === 'text/html' && html === undefined) html = p.text;
  }
  return { text, html };
}

/** Parts that are files: marked as attachments, or inline with a name or Content-ID, or not text at all. Names are made safe and unique. */
export function attachments(root: Part): Attachment[] {
  const out: Attachment[] = [];
  const used = new Set<string>();
  let n = 0;
  for (const p of walk(root)) {
    if ((p.parts.length && p.type !== 'message/rfc822') || p === root) continue;
    const isBody = (p.type === 'text/plain' || p.type === 'text/html') && p.disposition !== 'attachment' && !p.filename;
    if (isBody) continue;
    let name = p.filename ?? safeFilename(undefined, `attachment-${++n}`);
    if (used.has(name.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      let k = 2;
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      while (used.has(`${stem} (${k})${ext}`.toLowerCase())) k++;
      name = `${stem} (${k})${ext}`;
    }
    used.add(name.toLowerCase());
    out.push({ filename: name, type: p.type, data: p.body, inline: p.disposition === 'inline' || (p.disposition === undefined && p.contentId !== undefined), contentId: p.contentId });
  }
  return out;
}

/** Content-ID to part, for inline images. */
export function contentIds(root: Part): Map<string, Part> {
  const m = new Map<string, Part>();
  for (const p of walk(root)) if (p.contentId && !m.has(p.contentId)) m.set(p.contentId, p);
  return m;
}

/** Replaces cid: references in html (RFC 2392) with whatever `to` returns for that part; unknown ids are left for the caller to drop. */
export function rewriteCids(html: string, root: Part, to: (part: Part, cid: string) => string | undefined): string {
  const ids = contentIds(root);
  return html.replace(/\b(src|href|background)\s*=\s*(["'])cid:([^"']+)\2/gi, (m, attr: string, q: string, raw: string) => {
    const cid = decodeURIComponent(raw.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'));
    const part = ids.get(cid);
    const url = part && to(part, cid);
    return url === undefined ? m : `${attr}=${q}${url.replace(/"/g, '&quot;')}${q}`;
  });
}

// ---------------------------------------------------------------- building

export interface OutAttachment {
  readonly filename: string;
  readonly data: Uint8Array;
  readonly type?: string;
  /** For an inline image referenced as cid:<contentId> in the html. */
  readonly contentId?: string;
}

export interface OutMessage {
  readonly from: { name?: string; address: string };
  readonly to: readonly { name?: string; address: string }[];
  readonly cc?: readonly { name?: string; address: string }[];
  readonly bcc?: readonly { name?: string; address: string }[];
  readonly replyTo?: { name?: string; address: string };
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly attachments?: readonly OutAttachment[];
  readonly date: Date;
  readonly messageId: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  /** Extra headers (List-Unsubscribe and the like); names are checked. */
  readonly headers?: Readonly<Record<string, string>>;
}

export const formatDate = (d: Date): string => {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]}, ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
};

interface Built {
  readonly headers: string[];
  readonly body: string;
}

const textPart = (type: string, s: string): Built => {
  const ascii = /^[\x00-\x7f]*$/.test(s) && !/[^\r\n]{999}/.test(s) && !/\0/.test(s);
  if (ascii) return { headers: [`Content-Type: ${type}; charset=us-ascii`, 'Content-Transfer-Encoding: 7bit'], body: s.replace(/\r?\n/g, '\r\n') };
  return { headers: [`Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: quoted-printable'], body: encodeQuotedPrintable(Buffer.from(s, 'utf8')) };
};

/** Builds the message, CRLF line ends, ready to hand to an SMTP DATA command. The random source makes boundaries. */
export function buildMessage(m: OutMessage, o: { random?: (n: number) => Buffer } = {}): Buffer {
  const random = o.random ?? ((n: number) => Buffer.from(Array.from({ length: n }, () => Math.floor(Math.random() * 256))));
  if (!m.to.length && !m.cc?.length && !m.bcc?.length) throw new MimeError('a message needs a recipient');
  if (m.text === undefined && m.html === undefined) throw new MimeError('a message needs a text or an html body');
  const checkId = (id: string, what: string) => {
    if (!/^<[^\s<>@]+@[^\s<>@]+>$/.test(id)) throw new MimeError(`${what} looks like <unique@domain>`);
    return id;
  };
  checkId(m.messageId, 'a Message-ID');
  const atts = m.attachments ?? [];
  let boundaryCount = 0;
  const boundaryFor = (...contents: string[]): string => {
    for (let i = 0; i < 10; i++) {
      const b = `=_${random(15).toString('base64url')}${boundaryCount++}`;
      if (!contents.some((c) => c.includes(b))) return b;
    }
    throw new MimeError('could not find a boundary that is not in the content');
  };
  const multipart = (sub: string, parts: Built[]): Built => {
    const b = boundaryFor(...parts.map((p) => p.body));
    const rendered = parts.map((p) => `--${b}\r\n${p.headers.join('\r\n')}\r\n\r\n${p.body}`).join('\r\n');
    return { headers: [`Content-Type: multipart/${sub}; boundary="${b}"`], body: `${rendered}\r\n--${b}--\r\n` };
  };
  const filePart = (a: OutAttachment, inline: boolean): Built => {
    const type = a.type ?? 'application/octet-stream';
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(type)) throw new MimeError(`${JSON.stringify(type)} is not a media type`);
    const name = safeFilename(a.filename);
    const h = [`Content-Type: ${type}; ${formatParam('name', name)}`, 'Content-Transfer-Encoding: base64', `Content-Disposition: ${inline ? 'inline' : 'attachment'}; ${formatParam('filename', name)}`];
    if (a.contentId) {
      if (!/^[^\s<>]+$/.test(a.contentId)) throw new MimeError('a Content-ID has no spaces or angle brackets');
      h.push(`Content-ID: <${a.contentId}>`);
    }
    return { headers: h, body: encodeBase64Lines(a.data) };
  };
  const t = m.text !== undefined ? textPart('text/plain', m.text) : undefined;
  const h = m.html !== undefined ? textPart('text/html', m.html) : undefined;
  const bodyPart = t && h ? multipart('alternative', [t, h]) : (t ?? h)!;
  const inline = atts.filter((a) => a.contentId);
  const plain = atts.filter((a) => !a.contentId);
  const related = inline.length ? multipart('related', [bodyPart, ...inline.map((a) => filePart(a, true))]) : bodyPart;
  const content = plain.length ? multipart('mixed', [related, ...plain.map((a) => filePart(a, false))]) : related;
  const hs: string[] = [
    foldHeader('From', formatMailbox(m.from)),
    foldHeader('To', m.to.map(formatMailbox).join(', ')),
    ...(m.cc?.length ? [foldHeader('Cc', m.cc.map(formatMailbox).join(', '))] : []),
    ...(m.replyTo ? [foldHeader('Reply-To', formatMailbox(m.replyTo))] : []),
    foldHeader('Subject', textValue(m.subject)),
    `Date: ${formatDate(m.date)}`,
    `Message-ID: ${m.messageId}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${checkId(m.inReplyTo, 'In-Reply-To')}`] : []),
    ...(m.references?.length ? [foldHeader('References', m.references.map((r) => checkId(r, 'References')).join(' '))] : []),
    'MIME-Version: 1.0',
  ];
  for (const [k, v] of Object.entries(m.headers ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(k)) throw new MimeError(`${JSON.stringify(k)} is not a header name`);
    if (/^(from|to|cc|bcc|subject|date|message-id|mime-version|content-.*)$/i.test(k)) throw new MimeError(`${k} is set by the message itself`);
    hs.push(foldHeader(k, textValue(v)));
  }
  // Bcc recipients are for the envelope only; the header is never written.
  return Buffer.from(`${[...hs, ...content.headers].join('\r\n')}\r\n\r\n${content.body}`, 'latin1');
}
