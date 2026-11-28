/**
 * Streaming multipart/form-data parser: RFC 7578 (form-data), RFC 2046 section 5.1 (multipart framing), RFC 6266 and
 * RFC 5987 (filename and filename*), RFC 2183 (Content-Disposition).
 *
 * `MultipartParser` takes the body in chunks of any size (a boundary may be split anywhere) and returns events:
 * a part's headers, its data in pieces, and its end. Nothing is held beyond a small tail, so a file of any size
 * streams through. `parseStream` and `collect` wrap it for async iterables (a request body) and `parse` for a
 * buffer already in memory.
 *
 * Limits are enforced as bytes arrive, before anything is stored: total body size, number of parts, files and
 * fields, bytes per field and per file, header bytes and count per part, and name lengths. Files can be limited to
 * allowed media types, and their first bytes are checked with the uploadsafe block, so a program named `.png` or an
 * image that is not one is refused (executables are refused unless allowed). Every file name is sanitised: path
 * parts removed, characters a file system or a reader would trip over replaced, Windows reserved names prefixed,
 * length cut on a character boundary; the name the client sent is kept as `rawFilename`.
 *
 * Strict by design, because a parser that is lenient differs from the proxy in front of it: only CRLF line ends,
 * no folded headers, a delimiter followed by anything but padding then CRLF or `--` is an error, nested multipart
 * and a Content-Transfer-Encoding other than 7bit, 8bit or binary are refused, duplicate parameters are refused,
 * and a body that ends before its closing delimiter is an error. Text after the closing delimiter is ignored.
 *
 * Out of scope: nested multipart/mixed, base64 and quoted-printable transfer encodings, saving files to disk
 * (the caller decides where bytes go), and multipart types other than form-data.
 */

import { checkName, inspect, Unsafe } from '../uploadsafe/index.ts';

export type MultipartErrorCode =
  | 'bad-content-type' | 'bad-boundary' | 'malformed' | 'bad-headers' | 'bad-encoding' | 'unsupported-encoding' | 'truncated'
  | 'limit-total' | 'limit-parts' | 'limit-files' | 'limit-fields' | 'limit-field-size' | 'limit-file-size' | 'limit-headers'
  | 'type-not-allowed' | 'type-mismatch' | 'executable' | 'unsafe-filename' | 'unexpected-file';

export class MultipartError extends Error {
  readonly code: MultipartErrorCode;
  /** The HTTP status a server should answer with. */
  readonly status: 400 | 413 | 415;
  constructor(code: MultipartErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status = code.startsWith('limit-') ? 413 : code === 'type-not-allowed' || code === 'type-mismatch' || code === 'executable' ? 415 : 400;
  }
}

export interface Limits {
  /** Bytes in the whole body (default 100 MiB). */
  readonly maxTotalBytes?: number;
  readonly maxParts?: number;
  readonly maxFiles?: number;
  readonly maxFields?: number;
  /** Bytes in one text field (default 1 MiB). */
  readonly maxFieldBytes?: number;
  /** Bytes in one file (default 50 MiB). */
  readonly maxFileBytes?: number;
  /** Bytes of headers in one part (default 8 KiB). */
  readonly maxHeaderBytes?: number;
  readonly maxHeaders?: number;
  readonly maxNameLength?: number;
}

export interface MultipartOptions extends Limits {
  /** Allowed media types for files: "image/png", "image/*". Both the declared type and the sniffed type must match. Default: any. */
  readonly allowedTypes?: readonly string[];
  /** Allow files whose bytes are a program (default false). */
  readonly allowExecutables?: boolean;
  /** Refuse a file whose name's extension disagrees with what its bytes are (default true). */
  readonly rejectMismatch?: boolean;
  /** Refuse any file part (default false). */
  readonly forbidFiles?: boolean;
  /** Names accepted for parts; others are refused. Default: any. */
  readonly allowedNames?: readonly string[];
}

export const DEFAULT_LIMITS: Required<Limits> = {
  maxTotalBytes: 100 * 1024 * 1024, maxParts: 200, maxFiles: 20, maxFields: 200, maxFieldBytes: 1024 * 1024,
  maxFileBytes: 50 * 1024 * 1024, maxHeaderBytes: 8 * 1024, maxHeaders: 16, maxNameLength: 200,
};

export interface PartInfo {
  readonly index: number;
  readonly kind: 'field' | 'file';
  /** The form field name. */
  readonly name: string;
  /** The sanitised file name, for a file. */
  readonly filename?: string;
  /** The name the client sent (decoded from filename* when present), for a file. */
  readonly rawFilename?: string;
  /** Declared media type, lower-cased ("text/plain" for a field and "application/octet-stream" for a file by default). */
  readonly contentType: string;
  readonly charset?: string;
  /** What the first bytes of a file say it is, when known. */
  readonly sniffed?: string | null;
  readonly headers: Readonly<Record<string, string>>;
}

export type MultipartEvent =
  | { readonly kind: 'part'; readonly part: PartInfo }
  | { readonly kind: 'data'; readonly chunk: Uint8Array }
  | { readonly kind: 'end'; readonly size: number };

// ------------------------------------------------------------------ headers

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export interface HeaderValue {
  readonly value: string;
  readonly params: ReadonlyMap<string, string>;
  /** Names of parameters written as name* (RFC 5987). */
  readonly extended: ReadonlySet<string>;
}

/** Parses `value; a=b; c="d \"e\""`. Rejects repeated parameters and unterminated quotes. */
export function parseHeaderValue(s: string): HeaderValue {
  let i = 0;
  const n = s.length;
  const skip = () => { while (i < n && (s[i] === ' ' || s[i] === '\t')) i++; };
  let end = s.indexOf(';');
  if (end < 0) end = n;
  const value = s.slice(0, end).trim();
  i = end;
  const params = new Map<string, string>();
  const extended = new Set<string>();
  while (i < n) {
    i++; // ;
    skip();
    if (i >= n) break;
    let j = i;
    while (j < n && s[j] !== '=' && s[j] !== ';') j++;
    if (s[j] !== '=') { if (s.slice(i, j).trim() === '') { i = j; continue; } throw new MultipartError('bad-headers', 'a header parameter has no value'); }
    let key = s.slice(i, j).trim().toLowerCase();
    if (!TOKEN.test(key)) throw new MultipartError('bad-headers', 'a header parameter has a bad name');
    i = j + 1;
    skip();
    let v = '';
    if (s[i] === '"') {
      i++;
      let closed = false;
      while (i < n) {
        const c = s[i++]!;
        if (c === '\\' && i < n) v += s[i++];
        else if (c === '"') { closed = true; break; }
        else v += c;
      }
      if (!closed) throw new MultipartError('bad-headers', 'a quoted header value is not closed');
      skip();
      if (i < n && s[i] !== ';') throw new MultipartError('bad-headers', 'unexpected text after a quoted header value');
    } else {
      let k = i;
      while (k < n && s[k] !== ';') k++;
      v = s.slice(i, k).trim();
      i = k;
    }
    let ext = false;
    if (key.endsWith('*')) { key = key.slice(0, -1); ext = true; }
    const id = ext ? `${key}*` : key;
    if (params.has(id)) throw new MultipartError('bad-headers', `the header parameter "${key}" is given twice`);
    params.set(id, v);
    if (ext) extended.add(key);
  }
  return { value, params, extended };
}

/** RFC 5987 ext-value: charset'language'percent-encoded. Only UTF-8 and ISO-8859-1. */
export function decodeExtValue(v: string): string {
  const m = /^([A-Za-z0-9!#$%&+^_`{}~-]+)'[A-Za-z0-9-]*'(.*)$/s.exec(v);
  if (!m) throw new MultipartError('bad-headers', 'a filename* value is not in charset\'language\'text form');
  const cs = m[1]!.toLowerCase();
  const bytes: number[] = [];
  const t = m[2]!;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (c === '%') {
      const h = t.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(h)) throw new MultipartError('bad-headers', 'a filename* value has a bad percent escape');
      bytes.push(parseInt(h, 16));
      i += 2;
    } else if (c.charCodeAt(0) < 128) bytes.push(c.charCodeAt(0));
    else throw new MultipartError('bad-headers', 'a filename* value has an unencoded non-ASCII character');
  }
  const buf = Buffer.from(bytes);
  if (cs === 'utf-8') { try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { throw new MultipartError('bad-encoding', 'a filename* value is not valid UTF-8'); } }
  if (cs === 'iso-8859-1') return buf.toString('latin1');
  throw new MultipartError('bad-headers', `a filename* value uses the unsupported charset ${cs}`);
}

const BCHARS = /^[0-9A-Za-z'()+_,\-./:=? ]{1,70}$/;

export function checkBoundary(b: string): string {
  if (typeof b !== 'string' || !BCHARS.test(b) || b.endsWith(' ')) throw new MultipartError('bad-boundary', 'the boundary must be 1 to 70 characters from the RFC 2046 set and not end in a space');
  return b;
}

/** Reads a request's Content-Type and returns its boundary; refuses anything but multipart/form-data. */
export function parseContentType(header: string | undefined | null): { boundary: string; charset?: string } {
  if (typeof header !== 'string' || header === '' || header.length > 1000) throw new MultipartError('bad-content-type', 'the Content-Type header is missing or too long');
  const h = parseHeaderValue(header);
  if (h.value.toLowerCase() !== 'multipart/form-data') throw new MultipartError('bad-content-type', `expected multipart/form-data, got ${h.value.slice(0, 80)}`);
  const b = h.params.get('boundary');
  if (b === undefined) throw new MultipartError('bad-boundary', 'the Content-Type has no boundary');
  const cs = h.params.get('charset');
  return { boundary: checkBoundary(b), ...(cs ? { charset: cs.toLowerCase() } : {}) };
}

// ------------------------------------------------------------------ file names

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const DANGEROUS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/g;

function cutBytes(s: string, max: number): string {
  let out = '';
  let n = 0;
  for (const c of s) {
    const b = Buffer.byteLength(c);
    if (n + b > max) break;
    out += c;
    n += b;
  }
  return out;
}

/** Turns whatever a client sent into a name that is safe to store and to show: never a path, never hidden, never reserved. */
export function sanitizeFilename(raw: string, o: { maxBytes?: number } = {}): string {
  const max = o.maxBytes ?? 255;
  let s = String(raw).normalize('NFC');
  s = s.slice(s.search(/[^/\\]*$/)); // basename of / and \ paths
  s = s.replace(DANGEROUS, '').replace(/[<>:"|?*\\/]/g, '_').replace(/\s+/g, ' ');
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (s === '') s = 'unnamed';
  if (WIN_RESERVED.test(s)) s = `_${s}`;
  if (Buffer.byteLength(s) > max) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && Buffer.byteLength(s.slice(dot)) <= 16 ? s.slice(dot) : '';
    s = cutBytes(dot > 0 && ext ? s.slice(0, dot) : s, max - Buffer.byteLength(ext)).replace(/[.\s]+$/, '') + ext;
    if (s === '' || s === ext) s = `unnamed${ext}`;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try { checkName(s); return s; } catch (e) {
      if (!(e instanceof Unsafe) || attempt === 1) throw new MultipartError('unsafe-filename', `"${s.slice(0, 80)}" is not an acceptable file name`);
      s = `${s}_`;
    }
  }
  return s;
}

// ------------------------------------------------------------------ parser

type State = 'preamble' | 'after' | 'headers' | 'body' | 'epilogue' | 'failed';

const CRLF = Buffer.from('\r\n');
const CRLFCRLF = Buffer.from('\r\n\r\n');
const PCT = (s: string) => s.replace(/%22/g, '"').replace(/%0D/gi, '\r').replace(/%0A/gi, '\n');

const typeMatches = (allowed: readonly string[], t: string): boolean => allowed.some((a) => { const p = a.toLowerCase(); return p === t || (p.endsWith('/*') && t.startsWith(p.slice(0, -1))); });

export class MultipartParser {
  private readonly lim: Required<Limits>;
  private readonly delim: Buffer;
  private state: State = 'preamble';
  private buf: Buffer = Buffer.from('\r\n'); // the first delimiter may start the body, so pretend a CRLF came before it
  private total = 0;
  private parts = 0;
  private files = 0;
  private fields = 0;
  private cur: { info: PartInfo; size: number; limit: number; head: Buffer[]; headLen: number; announced: boolean } | undefined;
  private done = false;
  private readonly o: MultipartOptions;

  constructor(boundary: string, o: MultipartOptions = {}) {
    checkBoundary(boundary);
    this.o = o;
    this.lim = { ...DEFAULT_LIMITS, ...Object.fromEntries(Object.entries(o).filter(([k]) => k in DEFAULT_LIMITS)) } as Required<Limits>;
    this.delim = Buffer.from(`\r\n--${boundary}`);
  }

  private fail(code: MultipartErrorCode, message: string): never {
    this.state = 'failed';
    throw new MultipartError(code, message);
  }

  /** Feeds a chunk and returns the events it completes. Throws MultipartError and then stays failed. */
  write(chunk: Uint8Array): MultipartEvent[] {
    if (this.state === 'failed') throw new MultipartError('malformed', 'the parser has already failed');
    if (this.done) { this.total += chunk.length; if (this.total > this.lim.maxTotalBytes) this.fail('limit-total', `the body is larger than ${this.lim.maxTotalBytes} bytes`); return []; }
    this.total += chunk.length;
    if (this.total > this.lim.maxTotalBytes) this.fail('limit-total', `the body is larger than ${this.lim.maxTotalBytes} bytes`);
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out: MultipartEvent[] = [];
    for (;;) if (!this.step(out)) break;
    return out;
  }

  /** Signals the end of the body. Throws when the closing delimiter never came. */
  end(): MultipartEvent[] {
    if (this.state === 'failed') throw new MultipartError('malformed', 'the parser has already failed');
    if (this.state !== 'epilogue') this.fail('truncated', 'the body ended before the closing boundary');
    return [];
  }

  private step(out: MultipartEvent[]): boolean {
    const buf = this.buf;
    switch (this.state) {
      case 'preamble': {
        const i = buf.indexOf(this.delim);
        if (i < 0) { this.buf = buf.subarray(Math.max(0, buf.length - this.delim.length + 1)); return false; }
        this.buf = buf.subarray(i + this.delim.length);
        this.state = 'after';
        return true;
      }
      case 'after': {
        let i = 0;
        while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09) && i < 100) i++;
        if (i >= 100) this.fail('malformed', 'too much padding after a boundary');
        if (buf.length < i + 2) return false;
        if (buf[i] === 0x2d && buf[i + 1] === 0x2d) { this.state = 'epilogue'; this.done = true; this.buf = Buffer.alloc(0); return false; }
        if (buf[i] === 0x0d && buf[i + 1] === 0x0a) { this.buf = buf.subarray(i + 2); this.state = 'headers'; return true; }
        return this.fail('malformed', 'a boundary is followed by something other than a line end or --');
      }
      case 'headers': {
        let end: number;
        let skip: number;
        if (buf.length >= 2 && buf[0] === 0x0d && buf[1] === 0x0a) { end = 0; skip = 2; }
        else { end = buf.indexOf(CRLFCRLF); skip = 4; }
        if (end < 0) { if (buf.length > this.lim.maxHeaderBytes) this.fail('limit-headers', `part headers are longer than ${this.lim.maxHeaderBytes} bytes`); return false; }
        if (end > this.lim.maxHeaderBytes) this.fail('limit-headers', `part headers are longer than ${this.lim.maxHeaderBytes} bytes`);
        const raw = buf.subarray(0, end);
        this.buf = buf.subarray(end + skip);
        this.startPart(raw, out);
        this.state = 'body';
        return true;
      }
      case 'body': {
        const i = buf.indexOf(this.delim);
        if (i >= 0) {
          this.data(buf.subarray(0, i), out);
          this.finishPart(out);
          this.buf = buf.subarray(i + this.delim.length);
          this.state = 'after';
          return true;
        }
        const keep = this.delim.length - 1;
        if (buf.length > keep) { this.data(buf.subarray(0, buf.length - keep), out); this.buf = buf.subarray(buf.length - keep); }
        return false;
      }
      default:
        this.buf = Buffer.alloc(0);
        return false;
    }
  }

  private decodeHeaders(raw: Buffer): string {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { return raw.toString('latin1'); }
  }

  private startPart(raw: Buffer, out: MultipartEvent[]): void {
    const text = this.decodeHeaders(raw);
    const headers: Record<string, string> = Object.create(null) as Record<string, string>;
    let count = 0;
    if (text !== '') for (const line of text.split('\r\n')) {
      if (/^[ \t]/.test(line)) this.fail('bad-headers', 'folded header lines are not accepted');
      if (/[\r\n\0]/.test(line)) this.fail('bad-headers', 'a header line contains a stray line end or NUL');
      const c = line.indexOf(':');
      if (c <= 0) this.fail('bad-headers', 'a part header line has no name');
      const name = line.slice(0, c).toLowerCase();
      if (!TOKEN.test(name)) this.fail('bad-headers', 'a part header has a bad name');
      if (++count > this.lim.maxHeaders) this.fail('limit-headers', `a part may have at most ${this.lim.maxHeaders} headers`);
      if (name in headers) this.fail('bad-headers', `the header ${name} is given twice`);
      headers[name] = line.slice(c + 1).trim();
    }
    const disp = headers['content-disposition'];
    if (disp === undefined) this.fail('bad-headers', 'a part has no Content-Disposition');
    const d = parseHeaderValue(disp);
    if (d.value.toLowerCase() !== 'form-data') this.fail('bad-headers', 'a part is not form-data');
    const nameRaw = d.params.get('name');
    if (nameRaw === undefined) this.fail('bad-headers', 'a part has no name');
    const name = PCT(nameRaw);
    if (name.length > this.lim.maxNameLength) this.fail('bad-headers', `a field name is longer than ${this.lim.maxNameLength}`);
    if (this.o.allowedNames && !this.o.allowedNames.includes(name)) this.fail('bad-headers', `the field "${name.slice(0, 80)}" is not expected`);
    const te = headers['content-transfer-encoding']?.toLowerCase();
    if (te !== undefined && !['7bit', '8bit', 'binary'].includes(te)) this.fail('unsupported-encoding', `Content-Transfer-Encoding ${te.slice(0, 40)} is not supported`);
    const ct = headers['content-type'] !== undefined ? parseHeaderValue(headers['content-type']) : undefined;
    if (ct && /^multipart\//i.test(ct.value)) this.fail('bad-headers', 'nested multipart is not supported');
    let rawFilename: string | undefined;
    if (d.params.has('filename*')) rawFilename = decodeExtValue(d.params.get('filename*')!);
    else if (d.params.has('filename')) rawFilename = PCT(d.params.get('filename')!);
    if (++this.parts > this.lim.maxParts) this.fail('limit-parts', `a body may have at most ${this.lim.maxParts} parts`);
    const declared = ct?.value.toLowerCase();
    const charset = ct?.params.get('charset')?.toLowerCase();
    let info: PartInfo;
    let limit: number;
    if (rawFilename === undefined) {
      if (++this.fields > this.lim.maxFields) this.fail('limit-fields', `a body may have at most ${this.lim.maxFields} fields`);
      info = { index: this.parts - 1, kind: 'field', name, contentType: declared ?? 'text/plain', ...(charset ? { charset } : {}), headers };
      limit = this.lim.maxFieldBytes;
    } else {
      if (this.o.forbidFiles) this.fail('unexpected-file', 'file uploads are not accepted here');
      if (++this.files > this.lim.maxFiles) this.fail('limit-files', `a body may have at most ${this.lim.maxFiles} files`);
      const type = declared ?? 'application/octet-stream';
      if (this.o.allowedTypes && rawFilename !== '' && !typeMatches(this.o.allowedTypes, type)) this.fail('type-not-allowed', `files of type ${type.slice(0, 80)} are not accepted`);
      const filename = rawFilename === '' ? '' : sanitizeFilename(rawFilename);
      info = { index: this.parts - 1, kind: 'file', name, filename, rawFilename, contentType: type, ...(charset ? { charset } : {}), headers };
      limit = this.lim.maxFileBytes;
    }
    this.cur = { info, size: 0, limit, head: [], headLen: 0, announced: info.kind === 'field' };
    if (info.kind === 'field') out.push({ kind: 'part', part: info });
  }

  private data(chunk: Buffer, out: MultipartEvent[]): void {
    const c = this.cur!;
    if (chunk.length === 0) return;
    c.size += chunk.length;
    if (c.size > c.limit) this.fail(c.info.kind === 'file' ? 'limit-file-size' : 'limit-field-size', `${c.info.kind === 'file' ? 'the file' : 'the field'} "${c.info.name.slice(0, 80)}" is larger than ${c.limit} bytes`);
    if (c.announced) { out.push({ kind: 'data', chunk: new Uint8Array(chunk) }); return; }
    c.head.push(Buffer.from(chunk));
    c.headLen += chunk.length;
    if (c.headLen >= 16) this.announceFile(out);
  }

  /** A file part is only announced once its first bytes have been checked, so nothing is stored for a refused file. */
  private announceFile(out: MultipartEvent[]): void {
    const c = this.cur!;
    const head = Buffer.concat(c.head);
    c.head = [];
    c.announced = true;
    const info = c.info;
    if (info.filename === '') { out.push({ kind: 'part', part: { ...info, sniffed: null } }); if (head.length) out.push({ kind: 'data', chunk: new Uint8Array(head) }); return; }
    const f = inspect(info.filename!, head);
    if (f.executable && !this.o.allowExecutables) this.fail('executable', `"${info.filename}" is a program and programs are not accepted`);
    if (f.mismatch && this.o.rejectMismatch !== false) this.fail('type-mismatch', `"${info.filename}" does not look like its name says (the bytes are ${f.actual})`);
    if (this.o.allowedTypes && f.actual && !typeMatches(this.o.allowedTypes, f.actual)) this.fail('type-not-allowed', `the bytes of "${info.filename}" are ${f.actual}, which is not accepted`);
    c.info = { ...info, sniffed: f.actual };
    out.push({ kind: 'part', part: c.info });
    if (head.length) out.push({ kind: 'data', chunk: new Uint8Array(head) });
  }

  private finishPart(out: MultipartEvent[]): void {
    const c = this.cur!;
    if (!c.announced) this.announceFile(out);
    out.push({ kind: 'end', size: c.size });
    this.cur = undefined;
  }
}

// ------------------------------------------------------------------ helpers

export interface Field {
  readonly name: string;
  readonly value: string;
}
export interface FileUpload {
  readonly name: string;
  readonly filename: string;
  readonly rawFilename: string;
  readonly contentType: string;
  readonly sniffed: string | null;
  readonly size: number;
  readonly bytes: Uint8Array;
}
export interface Parsed {
  /** In the order sent; the same name may appear more than once. */
  readonly fields: readonly Field[];
  readonly files: readonly FileUpload[];
  /** Field values by name; repeated names give a list. Has no prototype, so any name is safe. */
  readonly values: Readonly<Record<string, string | string[]>>;
}

function decodeText(b: Uint8Array, charset: string | undefined, name: string): string {
  const cs = charset ?? 'utf-8';
  if (cs === 'iso-8859-1' || cs === 'latin1' || cs === 'us-ascii') return Buffer.from(b).toString('latin1');
  if (cs !== 'utf-8' && cs !== 'utf8') throw new MultipartError('bad-encoding', `the field "${name.slice(0, 80)}" uses the unsupported charset ${cs.slice(0, 40)}`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { throw new MultipartError('bad-encoding', `the field "${name.slice(0, 80)}" is not valid UTF-8`); }
}

class Collector {
  readonly fields: Field[] = [];
  readonly files: FileUpload[] = [];
  private cur: { info: PartInfo; chunks: Uint8Array[] } | undefined;
  add(e: MultipartEvent): void {
    if (e.kind === 'part') this.cur = { info: e.part, chunks: [] };
    else if (e.kind === 'data') this.cur!.chunks.push(e.chunk);
    else {
      const { info, chunks } = this.cur!;
      const bytes = Buffer.concat(chunks);
      if (info.kind === 'field') this.fields.push({ name: info.name, value: decodeText(bytes, info.charset, info.name) });
      else if (!(info.filename === '' && bytes.length === 0)) this.files.push({ name: info.name, filename: info.filename!, rawFilename: info.rawFilename!, contentType: info.contentType, sniffed: info.sniffed ?? null, size: bytes.length, bytes: new Uint8Array(bytes) });
      this.cur = undefined;
    }
  }
  result(): Parsed {
    const values: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
    for (const f of this.fields) {
      const old = values[f.name];
      values[f.name] = old === undefined ? f.value : Array.isArray(old) ? [...old, f.value] : [old, f.value];
    }
    return { fields: this.fields, files: this.files, values };
  }
}

/** Parses a body already in memory. */
export function parse(body: Uint8Array, contentType: string, o: MultipartOptions = {}): Parsed {
  const p = new MultipartParser(parseContentType(contentType).boundary, o);
  const c = new Collector();
  for (const e of p.write(body)) c.add(e);
  p.end();
  return c.result();
}

/** Streams events from a request body (any async or sync iterable of byte chunks). */
export async function* parseStream(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, contentType: string, o: MultipartOptions = {}): AsyncGenerator<MultipartEvent> {
  const p = new MultipartParser(parseContentType(contentType).boundary, o);
  for await (const chunk of source as AsyncIterable<Uint8Array>) yield* p.write(chunk);
  yield* p.end();
}

/** Reads a whole stream into fields and files, enforcing every limit while it arrives. */
export async function collect(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, contentType: string, o: MultipartOptions = {}): Promise<Parsed> {
  const c = new Collector();
  for await (const e of parseStream(source, contentType, o)) c.add(e);
  return c.result();
}

/** Builds a multipart/form-data body, for tests and clients. Header values are escaped the way browsers do. */
export function build(boundary: string, parts: readonly ({ name: string; value: string } | { name: string; filename: string; contentType?: string; bytes: Uint8Array })[]): Uint8Array {
  checkBoundary(boundary);
  const esc = (s: string) => s.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22');
  const chunks: Buffer[] = [];
  for (const p of parts) {
    if ('filename' in p) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${esc(p.name)}"; filename="${esc(p.filename)}"\r\nContent-Type: ${p.contentType ?? 'application/octet-stream'}\r\n\r\n`), Buffer.from(p.bytes), CRLF);
    } else chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${esc(p.name)}"\r\n\r\n${p.value}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return new Uint8Array(Buffer.concat(chunks));
}
