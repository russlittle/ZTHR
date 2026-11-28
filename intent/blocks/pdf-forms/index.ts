/**
 * PDF forms (AcroForm, ISO 32000-1 section 12.7): read the fields of a document with their types, values, options,
 * flags and where they sit on the pages; fill them (text, comb and multiline text, check boxes, radio groups, combo
 * and list boxes) with appearance streams drawn so every viewer shows the value; flatten them (draw each widget's
 * appearance into the page, then remove the field) so the filled form is plain page content; add new fields at a
 * place on a page; and turn a place given the way a screen or a person thinks (pixels or millimetres from the
 * top-left of the page as displayed, or a fraction of the page) into PDF user-space coordinates, correct for crop
 * boxes and for pages rotated 90, 180 or 270 degrees.
 *
 * Every change is an incremental update appended to the original bytes (a classic cross-reference section, or a
 * cross-reference stream when the file already uses one), so earlier signatures still verify over the revision
 * they signed, and the original is always recoverable by cutting the file back. Fields are validated before
 * anything is written and every problem is reported at once: unknown names, read-only fields, values over the
 * maximum length, newlines in a single-line field, values that are not among a choice field's options, and
 * buttons that are not fillable. Text is drawn in Helvetica (WinAnsi); characters outside that set are shown as
 * "?" in the appearance, while the field value keeps the real text.
 *
 * Reading handles classic and stream cross-references and object streams (Flate, PNG predictors); encrypted files
 * are refused. Out of scope: JavaScript and calculation order, XFA forms, rich text, digital signature creation
 * (the pdf-sign block), fonts other than Helvetica for new appearances, and rotated widgets (/MK /R).
 */
import { inflateSync } from 'node:zlib';
import { width, winAnsi, wrap } from '../pdf/index.ts';

export class FormsError extends Error {
  constructor(why: string) {
    super(why);
  }
}

// ================================================================ PDF objects

export interface PdfName { readonly kind: 'name'; readonly value: string }
export interface PdfRef { readonly kind: 'ref'; readonly num: number; readonly gen: number }
export interface PdfString { readonly kind: 'string'; readonly bytes: Uint8Array }
export interface PdfDict { readonly kind: 'dict'; readonly entries: Map<string, PdfObj> }
export type PdfObj = null | boolean | number | PdfName | PdfRef | PdfString | PdfObj[] | PdfDict;

export const name = (value: string): PdfName => ({ kind: 'name', value });
export const ref = (num: number, gen = 0): PdfRef => ({ kind: 'ref', num, gen });
export const dict = (o: Record<string, PdfObj>): PdfDict => ({ kind: 'dict', entries: new Map(Object.entries(o)) });
const isDict = (o: PdfObj | undefined): o is PdfDict => typeof o === 'object' && o !== null && !Array.isArray(o) && o.kind === 'dict';
const isRef = (o: PdfObj | undefined): o is PdfRef => typeof o === 'object' && o !== null && !Array.isArray(o) && o.kind === 'ref';
const isName = (o: PdfObj | undefined): o is PdfName => typeof o === 'object' && o !== null && !Array.isArray(o) && o.kind === 'name';
const isString = (o: PdfObj | undefined): o is PdfString => typeof o === 'object' && o !== null && !Array.isArray(o) && o.kind === 'string';

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));
const isRegular = (c: number) => !WS.has(c) && !DELIM.has(c);
const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');

class Lexer {
  pos: number;
  private readonly b: Uint8Array;
  constructor(b: Uint8Array, pos = 0) {
    this.b = b;
    this.pos = pos;
  }
  skip(): void {
    for (;;) {
      while (this.pos < this.b.length && WS.has(this.b[this.pos]!)) this.pos++;
      if (this.b[this.pos] === 0x25) while (this.pos < this.b.length && this.b[this.pos] !== 10 && this.b[this.pos] !== 13) this.pos++;
      else return;
    }
  }
  word(): string {
    this.skip();
    const s = this.pos;
    while (this.pos < this.b.length && isRegular(this.b[this.pos]!)) this.pos++;
    return latin1(this.b.subarray(s, this.pos));
  }
  peekWord(): string {
    const p = this.pos;
    const w = this.word();
    this.pos = p;
    return w;
  }
  object(depth = 0): PdfObj {
    if (depth > 32) throw new FormsError('PDF objects are nested too deeply');
    this.skip();
    const c = this.b[this.pos];
    if (c === undefined) throw new FormsError('the PDF ends in the middle of an object');
    if (c === 0x2f) {
      this.pos++;
      const s = this.pos;
      while (this.pos < this.b.length && isRegular(this.b[this.pos]!)) this.pos++;
      return name(latin1(this.b.subarray(s, this.pos)).replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))));
    }
    if (c === 0x28) return this.literal();
    if (c === 0x3c && this.b[this.pos + 1] === 0x3c) {
      this.pos += 2;
      const entries = new Map<string, PdfObj>();
      for (;;) {
        this.skip();
        if (this.b[this.pos] === 0x3e && this.b[this.pos + 1] === 0x3e) {
          this.pos += 2;
          return { kind: 'dict', entries };
        }
        const k = this.object(depth + 1);
        if (!isName(k)) throw new FormsError('a PDF dictionary key is not a name');
        entries.set(k.value, this.object(depth + 1));
      }
    }
    if (c === 0x3c) {
      const end = this.b.indexOf(0x3e, this.pos);
      if (end < 0) throw new FormsError('a hex string is not closed');
      const hex = latin1(this.b.subarray(this.pos + 1, end)).replace(/\s+/g, '');
      if (!/^[0-9A-Fa-f]*$/.test(hex)) throw new FormsError('a hex string has other characters in it');
      this.pos = end + 1;
      return { kind: 'string', bytes: Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex') };
    }
    if (c === 0x5b) {
      this.pos++;
      const out: PdfObj[] = [];
      for (;;) {
        this.skip();
        if (this.b[this.pos] === 0x5d) {
          this.pos++;
          return out;
        }
        out.push(this.object(depth + 1));
      }
    }
    const w = this.word();
    if (!w) throw new FormsError(`unexpected "${String.fromCharCode(c)}" in a PDF object`);
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(w)) {
      const n = Number(w);
      if (/^\d+$/.test(w)) {
        const save = this.pos;
        const g = this.word();
        if (/^\d+$/.test(g) && this.word() === 'R') return ref(n, Number(g));
        this.pos = save;
      }
      return n;
    }
    throw new FormsError(`"${w.slice(0, 20)}" is not a PDF object`);
  }
  private literal(): PdfString {
    const out: number[] = [];
    let depthP = 0;
    this.pos++;
    for (;;) {
      const c = this.b[this.pos++];
      if (c === undefined) throw new FormsError('a string is not closed');
      if (c === 0x5c) {
        const n = this.b[this.pos++];
        if (n === undefined) throw new FormsError('a string is not closed');
        const map: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 };
        if (n in map) out.push(map[n]!);
        else if (n >= 0x30 && n <= 0x37) {
          let v = n - 0x30;
          for (let i = 0; i < 2 && this.b[this.pos]! >= 0x30 && this.b[this.pos]! <= 0x37; i++) v = v * 8 + this.b[this.pos++]! - 0x30;
          out.push(v & 0xff);
        } else if (n === 13) {
          if (this.b[this.pos] === 10) this.pos++;
        } else if (n !== 10) out.push(n);
      } else if (c === 0x28) {
        depthP++;
        out.push(c);
      } else if (c === 0x29) {
        if (depthP === 0) return { kind: 'string', bytes: Uint8Array.from(out) };
        depthP--;
        out.push(c);
      } else out.push(c);
    }
  }
}

const escapeLiteral = (b: Uint8Array): string => latin1(b).replace(/[\\()\r]/g, (c) => (c === '\r' ? '\\r' : `\\${c}`));

/** PDF text string: plain ASCII as a literal, anything else as UTF-16BE with a byte order mark in hex. */
export function textString(s: string): PdfString {
  if (/^[\x20-\x7e]*$/.test(s)) return { kind: 'string', bytes: Buffer.from(s, 'latin1') };
  const u = Buffer.from(s, 'utf16le');
  u.swap16();
  return { kind: 'string', bytes: Buffer.concat([Buffer.from([0xfe, 0xff]), u]) };
}

/** The text of a PDF text string (PDFDocEncoding is read as Latin-1). */
export function textOf(o: PdfObj | undefined): string | null {
  if (!isString(o)) return null;
  const b = Buffer.from(o.bytes);
  if (b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2)).swap16().toString('utf16le');
  return b.toString('latin1');
}

export function serialize(o: PdfObj): string {
  if (o === null) return 'null';
  if (typeof o === 'boolean') return String(o);
  if (typeof o === 'number') {
    if (!Number.isFinite(o)) throw new FormsError('a PDF number must be finite');
    return Number.isInteger(o) ? String(o) : String(Math.round(o * 1e4) / 1e4);
  }
  if (Array.isArray(o)) return `[${o.map(serialize).join(' ')}]`;
  switch (o.kind) {
    case 'name':
      return `/${o.value.replace(/[^!-~]|[#()<>[\]{}/%]/g, (c) => `#${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}`;
    case 'ref':
      return `${o.num} ${o.gen} R`;
    case 'string':
      return o.bytes.some((c) => c < 0x20 || c > 0x7e) ? `<${Buffer.from(o.bytes).toString('hex').toUpperCase()}>` : `(${escapeLiteral(o.bytes)})`;
    case 'dict':
      return `<<${[...o.entries].map(([k, v]) => `${serialize(name(k))} ${serialize(v)}`).join(' ')}>>`;
  }
}

// ================================================================ document structure

interface XrefEntry {
  readonly type: 1 | 2;
  /** Offset (type 1) or the number of the object stream (type 2). */
  readonly a: number;
  /** Generation (type 1) or the index within the object stream (type 2). */
  readonly b: number;
}

export interface Doc {
  readonly bytes: Uint8Array;
  readonly entries: ReadonlyMap<number, XrefEntry>;
  readonly trailer: PdfDict;
  readonly lastXref: number;
  readonly usesXrefStream: boolean;
  get(num: number): PdfObj;
  resolve(o: PdfObj | undefined): PdfObj;
}

const MAX_INFLATE = 64 * 1024 * 1024;

function unpredict(data: Uint8Array, parms: PdfDict | undefined): Uint8Array {
  const predictor = Number(parms?.entries.get('Predictor') ?? 1);
  if (predictor < 10) {
    if (predictor !== 1) throw new FormsError('this stream uses a predictor that is not supported');
    return data;
  }
  const columns = Number(parms?.entries.get('Columns') ?? 1);
  const colors = Number(parms?.entries.get('Colors') ?? 1);
  const bpc = Number(parms?.entries.get('BitsPerComponent') ?? 8);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((columns * colors * bpc) / 8);
  if (!(rowLen > 0) || !Number.isFinite(rowLen)) throw new FormsError('a stream predictor has impossible parameters');
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const f = data[r * (rowLen + 1)]!;
    for (let i = 0; i < rowLen; i++) {
      const x = data[r * (rowLen + 1) + 1 + i]!;
      const a = i >= bpp ? out[r * rowLen + i - bpp]! : 0;
      const b = r > 0 ? out[(r - 1) * rowLen + i]! : 0;
      const c = r > 0 && i >= bpp ? out[(r - 1) * rowLen + i - bpp]! : 0;
      let v: number;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new FormsError('a stream row has an unknown predictor');
      out[r * rowLen + i] = v & 0xff;
    }
  }
  return out;
}

function streamData(bytes: Uint8Array, d: PdfDict, start: number, doc?: { resolve(o: PdfObj | undefined): PdfObj }): Uint8Array {
  let len = d.entries.get('Length');
  if (doc) len = doc.resolve(len);
  let raw: Uint8Array;
  if (typeof len === 'number' && len >= 0 && start + len <= bytes.length && /^\s*endstream/.test(latin1(bytes.subarray(start + len, start + len + 16)))) raw = bytes.subarray(start, start + len);
  else {
    const end = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).indexOf('endstream', start, 'latin1');
    if (end < 0) throw new FormsError('a stream has no end');
    raw = bytes.subarray(start, end);
  }
  let filter = d.entries.get('Filter');
  if (Array.isArray(filter)) {
    if (filter.length > 1) throw new FormsError('stacked stream filters are not supported');
    filter = filter[0];
  }
  if (filter === undefined) return raw;
  if (!isName(filter) || (filter.value !== 'FlateDecode' && filter.value !== 'Fl')) throw new FormsError('only Flate-compressed streams are read');
  let parms = d.entries.get('DecodeParms');
  if (Array.isArray(parms)) parms = parms[0];
  try {
    return unpredict(inflateSync(raw, { maxOutputLength: MAX_INFLATE }), isDict(parms) ? parms : undefined);
  } catch (e) {
    if (e instanceof FormsError) throw e;
    throw new FormsError('a compressed stream is damaged or too large');
  }
}

function indirectAt(bytes: Uint8Array, offset: number): { num: number; gen: number; lex: Lexer } {
  if (!(offset >= 0 && offset < bytes.length)) throw new FormsError('an offset points outside the file');
  const lex = new Lexer(bytes, offset);
  const n = lex.word();
  const g = lex.word();
  if (!/^\d+$/.test(n) || !/^\d+$/.test(g) || lex.word() !== 'obj') throw new FormsError(`no object where the cross-reference says at ${offset}`);
  return { num: Number(n), gen: Number(g), lex };
}

export function readDoc(bytes: Uint8Array): Doc {
  if (bytes.length < 20 || latin1(bytes.subarray(0, 1024)).indexOf('%PDF-') < 0) throw new FormsError('that is not a PDF');
  const tail = latin1(bytes.subarray(Math.max(0, bytes.length - 2048)));
  const sx = tail.lastIndexOf('startxref');
  const m = sx < 0 ? null : /^startxref\s+(\d{1,12})/.exec(tail.slice(sx));
  if (!m) throw new FormsError('the PDF has no startxref');
  const lastXref = Number(m[1]);
  const entries = new Map<number, XrefEntry>();
  let trailer: PdfDict | null = null;
  let usesXrefStream = false;
  const seen = new Set<number>();
  const load = (offset: number, first: boolean): number | null => {
    if (seen.has(offset) || seen.size > 1000) throw new FormsError('the cross-reference sections loop');
    seen.add(offset);
    const lex = new Lexer(bytes, offset);
    let t: PdfDict;
    if (lex.peekWord() === 'xref') {
      lex.word();
      for (;;) {
        if (lex.peekWord() === 'trailer') break;
        const s = Number(lex.word());
        const c = Number(lex.word());
        if (!Number.isInteger(s) || !Number.isInteger(c) || c < 0 || c > 10_000_000) throw new FormsError('a cross-reference subsection is not valid');
        for (let i = 0; i < c; i++) {
          const off = lex.word();
          const gen = lex.word();
          const kind = lex.word();
          if (!/^\d{10}$/.test(off) || !/^\d{5}$/.test(gen) || (kind !== 'n' && kind !== 'f')) throw new FormsError('a cross-reference entry is not valid');
          if (kind === 'n' && !entries.has(s + i)) entries.set(s + i, { type: 1, a: Number(off), b: Number(gen) });
          else if (kind === 'f' && !entries.has(s + i)) entries.set(s + i, { type: 1, a: -1, b: Number(gen) });
        }
      }
      lex.word();
      const o = lex.object();
      if (!isDict(o)) throw new FormsError('the trailer is not a dictionary');
      t = o;
      const hybrid = t.entries.get('XRefStm');
      if (typeof hybrid === 'number' && !seen.has(hybrid)) load(hybrid, false);
    } else {
      const { lex: l2 } = indirectAt(bytes, offset);
      const o = l2.object();
      if (!isDict(o) || !isName(o.entries.get('Type')) || (o.entries.get('Type') as PdfName).value !== 'XRef') throw new FormsError('the cross-reference is neither a table nor a stream');
      if (first) usesXrefStream = true;
      if (l2.word() !== 'stream') throw new FormsError('a cross-reference stream has no data');
      let p = l2.pos;
      if (bytes[p] === 13) p++;
      if (bytes[p] === 10) p++;
      const data = streamData(bytes, o, p);
      const w = (o.entries.get('W') as PdfObj[] | undefined) ?? [];
      if (w.length !== 3 || w.some((x) => typeof x !== 'number' || x < 0 || x > 8)) throw new FormsError('a cross-reference stream has bad field widths');
      const [w0, w1, w2] = w as [number, number, number];
      const size = Number(o.entries.get('Size'));
      const index = (o.entries.get('Index') as number[] | undefined) ?? [0, size];
      const rec = w0 + w1 + w2;
      let q = 0;
      const num = (n: number) => {
        let v = 0;
        for (let i = 0; i < n; i++) v = v * 256 + data[q++]!;
        return v;
      };
      for (let i = 0; i + 1 < index.length; i += 2) {
        for (let k = 0; k < index[i + 1]!; k++) {
          if (q + rec > data.length) throw new FormsError('a cross-reference stream is cut short');
          const type = w0 === 0 ? 1 : num(w0);
          const a = num(w1);
          const b = num(w2);
          const n = index[i]! + k;
          if (entries.has(n)) continue;
          if (type === 1) entries.set(n, { type: 1, a, b });
          else if (type === 2) entries.set(n, { type: 2, a, b });
          else entries.set(n, { type: 1, a: -1, b });
        }
      }
      t = o;
    }
    if (first) trailer = t;
    const prev = t.entries.get('Prev');
    return typeof prev === 'number' ? prev : null;
  };
  let next: number | null = lastXref;
  let first = true;
  while (next !== null) {
    next = load(next, first);
    first = false;
  }
  if (!trailer) throw new FormsError('the PDF has no trailer');
  const tr: PdfDict = trailer;
  if (tr.entries.has('Encrypt')) throw new FormsError('encrypted PDFs are not supported');
  if (!isRef(tr.entries.get('Root'))) throw new FormsError('the PDF has no document catalog');

  const cache = new Map<number, PdfObj>();
  const objstm = new Map<number, { objs: Map<number, PdfObj> }>();
  const doc: Doc = {
    bytes,
    entries,
    trailer: tr,
    lastXref,
    usesXrefStream,
    get(num: number): PdfObj {
      if (cache.has(num)) return cache.get(num)!;
      const e = entries.get(num);
      let v: PdfObj = null;
      if (e && e.type === 1 && e.a >= 0) {
        const at = indirectAt(bytes, e.a);
        if (at.num !== num) throw new FormsError(`object ${num} is not where the cross-reference says`);
        v = at.lex.object();
      } else if (e && e.type === 2) {
        if (!objstm.has(e.a)) {
          const holder = doc.get(e.a);
          const pos = entries.get(e.a);
          if (!isDict(holder) || !pos || pos.type !== 1) throw new FormsError(`object stream ${e.a} is missing`);
          const lex = indirectAt(bytes, pos.a).lex;
          lex.object();
          if (lex.word() !== 'stream') throw new FormsError('an object stream has no data');
          let p = lex.pos;
          if (bytes[p] === 13) p++;
          if (bytes[p] === 10) p++;
          const data = streamData(bytes, holder, p, doc);
          const n = Number(doc.resolve(holder.entries.get('N')));
          const firstOff = Number(doc.resolve(holder.entries.get('First')));
          if (!(n >= 0 && n <= 1_000_000) || !(firstOff >= 0)) throw new FormsError('an object stream header is not valid');
          const hl = new Lexer(data, 0);
          const pairs: [number, number][] = [];
          for (let i = 0; i < n; i++) pairs.push([Number(hl.word()), Number(hl.word())]);
          const objs = new Map<number, PdfObj>();
          for (const [on, off] of pairs) objs.set(on, new Lexer(data, firstOff + off).object());
          objstm.set(e.a, { objs });
        }
        v = objstm.get(e.a)!.objs.get(num) ?? null;
      }
      cache.set(num, v);
      return v;
    },
    resolve(o: PdfObj | undefined): PdfObj {
      let cur: PdfObj = o ?? null;
      for (let i = 0; i < 16 && isRef(cur); i++) cur = doc.get(cur.num);
      return cur;
    },
  };
  return doc;
}

/** The page objects in order, from the page tree (cycles and absurd depth refused). */
export function pageRefs(doc: Doc): PdfRef[] {
  const root = doc.resolve(doc.trailer.entries.get('Root'));
  if (!isDict(root)) throw new FormsError('the document catalog is not a dictionary');
  const out: PdfRef[] = [];
  const seen = new Set<number>();
  const walk = (r: PdfObj | undefined, depth: number) => {
    if (!isRef(r) || seen.has(r.num) || depth > 32 || out.length > 100_000) return;
    seen.add(r.num);
    const d = doc.get(r.num);
    if (!isDict(d)) return;
    const kids = doc.resolve(d.entries.get('Kids'));
    if (Array.isArray(kids)) kids.forEach((k) => walk(k, depth + 1));
    else out.push(r);
  };
  walk(root.entries.get('Pages'), 0);
  return out;
}


const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const num = (o: PdfObj | undefined, d = 0): number => (typeof o === 'number' && Number.isFinite(o) ? o : d);
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

// ================================================================ writing an update

/** One object to append: its number, generation and everything between `obj` and `endobj`. */
interface NewObj {
  readonly num: number;
  readonly gen: number;
  readonly body: Uint8Array;
}

const streamBody = (d: Record<string, PdfObj>, data: string): Uint8Array => {
  const bytes = Buffer.from(data, 'latin1');
  return Buffer.concat([Buffer.from(`${serialize(dict({ ...d, Length: bytes.length }))}\nstream\n`, 'latin1'), bytes, Buffer.from('\nendstream', 'latin1')]);
};

const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** The document with the objects appended as an incremental update, in the same kind of cross-reference the file already uses. */
function appendUpdate(doc: Doc, objs: readonly NewObj[]): Uint8Array {
  const input = doc.bytes;
  const need = input[input.length - 1] === 10 || input[input.length - 1] === 13 ? '' : '\n';
  const chunks: Buffer[] = [Buffer.from(need, 'latin1')];
  let at = input.length + need.length;
  const offsets = new Map<number, { at: number; gen: number }>();
  for (const o of [...objs].sort((a, b) => a.num - b.num)) {
    offsets.set(o.num, { at, gen: o.gen });
    const c = Buffer.concat([Buffer.from(`${o.num} ${o.gen} obj\n`, 'latin1'), o.body, Buffer.from('\nendobj\n', 'latin1')]);
    chunks.push(c);
    at += c.length;
  }
  const size = Math.max(Number(doc.trailer.entries.get('Size')), ...doc.entries.keys(), ...offsets.keys()) + 1;
  const total = doc.usesXrefStream ? size + 1 : size;
  const tr = doc.trailer.entries;
  const common: Record<string, PdfObj> = { Root: tr.get('Root')! };
  for (const k of ['Info', 'ID']) if (tr.has(k)) common[k] = tr.get(k)!;
  const nums = [...offsets.keys()];
  if (doc.usesXrefStream) {
    const xnum = size;
    const all = [...nums, xnum];
    const rows: number[] = [];
    for (const n of all) rows.push(1, ...u32(n === xnum ? at : offsets.get(n)!.at), 0, n === xnum ? 0 : Math.min(255, offsets.get(n)!.gen));
    const index: number[] = [];
    for (let i = 0; i < all.length; ) {
      let j = i;
      while (j + 1 < all.length && all[j + 1] === all[j]! + 1) j++;
      index.push(all[i]!, j - i + 1);
      i = j + 1;
    }
    chunks.push(Buffer.from(`${xnum} 0 obj\n${serialize(dict({ Type: name('XRef'), Size: total, W: [1, 4, 2], Index: index, Prev: doc.lastXref, Length: rows.length, ...common }))}\nstream\n`, 'latin1'));
    chunks.push(Buffer.from(rows));
    chunks.push(Buffer.from(`\nendstream\nendobj\nstartxref\n${at}\n%%EOF\n`, 'latin1'));
  } else {
    let x = 'xref\n';
    for (let i = 0; i < nums.length; ) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j]! + 1) j++;
      x += `${nums[i]} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) x += `${String(offsets.get(nums[k]!)!.at).padStart(10, '0')} ${String(offsets.get(nums[k]!)!.gen).padStart(5, '0')} n \n`;
      i = j + 1;
    }
    x += `trailer\n${serialize(dict({ Size: total, Prev: doc.lastXref, ...common }))}\nstartxref\n${at}\n%%EOF\n`;
    chunks.push(Buffer.from(x, 'latin1'));
  }
  return concat([input, ...chunks]);
}

const genOf = (doc: Doc, n: number): number => {
  const e = doc.entries.get(n);
  return e && e.type === 1 && e.a >= 0 ? e.b : 0;
};

class Numbers {
  private next: number;
  constructor(doc: Doc) {
    this.next = Math.max(Number(doc.trailer.entries.get('Size')), ...doc.entries.keys()) + 1;
  }
  take(): number {
    return this.next++;
  }
}

// ================================================================ the field model

export type FieldType = 'text' | 'checkbox' | 'radio' | 'pushbutton' | 'combo' | 'list' | 'signature';

export interface Widget {
  /** Object number of the widget annotation. */
  readonly object: number;
  /** Zero-based page, or null when no page lists it. */
  readonly page: number | null;
  readonly rect: readonly [number, number, number, number];
  /** For check boxes and radio buttons: the "on" state this widget can show. */
  readonly onState: string | null;
}

export interface Field {
  /** Full name, parents joined by dots. */
  readonly name: string;
  readonly type: FieldType;
  /** Text for text and choice fields (an array for a multiple-selection list), a state name for buttons, null if empty. */
  readonly value: string | readonly string[] | null;
  readonly defaultValue: string | readonly string[] | null;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly readOnly: boolean;
  readonly required: boolean;
  readonly multiline: boolean;
  readonly password: boolean;
  readonly comb: boolean;
  readonly editable: boolean;
  readonly multiSelect: boolean;
  readonly maxLen: number | null;
  readonly widgets: readonly Widget[];
  /** Object number of the field dictionary. */
  readonly object: number;
}

export interface Form {
  readonly fields: readonly Field[];
  readonly needAppearances: boolean;
  readonly pages: number;
}

interface Node {
  readonly num: number;
  readonly gen: number;
  readonly dict: PdfDict;
  readonly parent: Node | null;
  readonly name: string;
}

const FF = { readOnly: 1, required: 2, multiline: 1 << 12, password: 1 << 13, noToggleToOff: 1 << 14, radio: 1 << 15, pushbutton: 1 << 16, combo: 1 << 17, edit: 1 << 18, multiSelect: 1 << 21, comb: 1 << 24 };

function inherited(doc: Doc, n: Node, key: string): PdfObj {
  for (let cur: Node | null = n, i = 0; cur && i < 32; cur = cur.parent, i++) if (cur.dict.entries.has(key)) return doc.resolve(cur.dict.entries.get(key));
  return null;
}

function strings(doc: Doc, o: PdfObj): string | string[] | null {
  const v = doc.resolve(o);
  if (isString(v)) return textOf(v);
  if (isName(v)) return v.value;
  if (Array.isArray(v)) return v.map((x) => strings(doc, x)).filter((x): x is string => typeof x === 'string');
  return null;
}

interface Collected {
  readonly node: Node;
  readonly kids: { readonly num: number; readonly gen: number; readonly dict: PdfDict }[];
}

function collect(doc: Doc): { fields: Collected[]; acroNum: number | null; acro: PdfDict | null } {
  const root = doc.resolve(doc.trailer.entries.get('Root'));
  if (!isDict(root)) throw new FormsError('the document catalog is not a dictionary');
  const acroRaw = root.entries.get('AcroForm');
  const acro = doc.resolve(acroRaw);
  if (!isDict(acro)) return { fields: [], acroNum: null, acro: null };
  const out: Collected[] = [];
  const seen = new Set<number>();
  const walk = (o: PdfObj, parent: Node | null, depth: number) => {
    if (!isRef(o) || depth > 16 || seen.has(o.num) || out.length > 20_000) return;
    seen.add(o.num);
    const d = doc.get(o.num);
    if (!isDict(d)) return;
    const t = textOf(d.entries.get('T'));
    const full = t === null ? (parent?.name ?? '') : parent?.name ? `${parent.name}.${t}` : t;
    const node: Node = { num: o.num, gen: o.gen, dict: d, parent, name: full };
    const kids = doc.resolve(d.entries.get('Kids'));
    const kidRefs = Array.isArray(kids) ? kids.filter(isRef) : [];
    const fieldKids = kidRefs.filter((k) => {
      const kd = doc.get(k.num);
      return isDict(kd) && kd.entries.has('T');
    });
    if (fieldKids.length) fieldKids.forEach((k) => walk(k, node, depth + 1));
    else {
      const widgets = kidRefs.map((k) => ({ num: k.num, gen: k.gen, dict: doc.get(k.num) })).filter((k): k is { num: number; gen: number; dict: PdfDict } => isDict(k.dict));
      out.push({ node, kids: widgets.length ? widgets : [{ num: node.num, gen: node.gen, dict: d }] });
    }
  };
  const fields = doc.resolve(acro.entries.get('Fields'));
  if (Array.isArray(fields)) fields.forEach((f) => walk(f, null, 0));
  return { fields: out, acroNum: isRef(acroRaw) ? acroRaw.num : null, acro };
}

function pageOfAnnots(doc: Doc): Map<number, number> {
  const map = new Map<number, number>();
  pageRefs(doc).forEach((p, i) => {
    const d = doc.get(p.num);
    const a = isDict(d) ? doc.resolve(d.entries.get('Annots')) : null;
    if (Array.isArray(a)) for (const r of a) if (isRef(r) && !map.has(r.num)) map.set(r.num, i);
  });
  return map;
}

const rectOf = (doc: Doc, d: PdfDict): [number, number, number, number] => {
  const r = doc.resolve(d.entries.get('Rect'));
  const n = Array.isArray(r) && r.length === 4 ? r.map((x) => num(doc.resolve(x))) : [0, 0, 0, 0];
  return [Math.min(n[0]!, n[2]!), Math.min(n[1]!, n[3]!), Math.max(n[0]!, n[2]!), Math.max(n[1]!, n[3]!)];
};

function apStates(doc: Doc, d: PdfDict): string[] {
  const ap = doc.resolve(d.entries.get('AP'));
  const n = isDict(ap) ? doc.resolve(ap.entries.get('N')) : null;
  return isDict(n) ? [...n.entries.keys()] : [];
}

function typeOf(doc: Doc, n: Node, ff: number): FieldType | null {
  const ft = inherited(doc, n, 'FT');
  if (!isName(ft)) return null;
  if (ft.value === 'Tx') return 'text';
  if (ft.value === 'Sig') return 'signature';
  if (ft.value === 'Ch') return ff & FF.combo ? 'combo' : 'list';
  if (ft.value === 'Btn') return ff & FF.pushbutton ? 'pushbutton' : ff & FF.radio ? 'radio' : 'checkbox';
  return null;
}

/** Every field of the document with what a person needs to fill it. */
export function readForm(bytes: Uint8Array): Form {
  const doc = readDoc(bytes);
  const { fields } = collect(doc);
  const pages = pageOfAnnots(doc);
  const root = doc.resolve(doc.trailer.entries.get('Root')) as PdfDict;
  const acro = doc.resolve(root.entries.get('AcroForm'));
  const out: Field[] = [];
  for (const c of fields) {
    const ff = num(inherited(doc, c.node, 'Ff'));
    const type = typeOf(doc, c.node, ff);
    if (!type) continue;
    const optRaw = inherited(doc, c.node, 'Opt');
    const options = Array.isArray(optRaw)
      ? optRaw.map((o) => {
          const v = doc.resolve(o);
          if (Array.isArray(v) && v.length >= 2) return { value: String(strings(doc, v[0]!) ?? ''), label: String(strings(doc, v[1]!) ?? '') };
          const s = String(strings(doc, o) ?? '');
          return { value: s, label: s };
        })
      : [];
    const v = strings(doc, inherited(doc, c.node, 'V'));
    const dv = strings(doc, inherited(doc, c.node, 'DV'));
    const maxLen = num(inherited(doc, c.node, 'MaxLen'), 0);
    out.push({
      name: c.node.name,
      type,
      value: v === 'Off' && (type === 'checkbox' || type === 'radio') ? null : v,
      defaultValue: dv,
      options,
      readOnly: (ff & FF.readOnly) !== 0,
      required: (ff & FF.required) !== 0,
      multiline: type === 'text' && (ff & FF.multiline) !== 0,
      password: type === 'text' && (ff & FF.password) !== 0,
      comb: type === 'text' && (ff & FF.comb) !== 0 && maxLen > 0,
      editable: type === 'combo' && (ff & FF.edit) !== 0,
      multiSelect: type === 'list' && (ff & FF.multiSelect) !== 0,
      maxLen: maxLen > 0 ? maxLen : null,
      object: c.node.num,
      widgets: c.kids.map((k) => ({ object: k.num, page: pages.get(k.num) ?? null, rect: rectOf(doc, k.dict), onState: type === 'checkbox' || type === 'radio' ? (apStates(doc, k.dict).find((s) => s !== 'Off') ?? null) : null })),
    });
  }
  return { fields: out, needAppearances: isDict(acro) && doc.resolve(acro.entries.get('NeedAppearances')) === true, pages: pageRefs(doc).length };
}

/** The names of required fields that are empty, given the values that will be set. */
export function missingRequired(form: Form, values: Readonly<Record<string, FieldValue>> = {}): string[] {
  return form.fields
    .filter((f) => f.required && f.type !== 'signature' && f.type !== 'pushbutton')
    .filter((f) => {
      const v = Object.hasOwn(values, f.name) ? values[f.name] : f.value;
      return v === null || v === undefined || v === '' || v === false || (Array.isArray(v) && v.length === 0);
    })
    .map((f) => f.name);
}

// ================================================================ filling

export type FieldValue = string | boolean | readonly string[] | null;

export interface Problem {
  readonly field: string;
  readonly why: string;
}

export class FormError extends FormsError {
  readonly problems: readonly Problem[];
  constructor(problems: readonly Problem[]) {
    super(`${problems.length} problem${problems.length === 1 ? '' : 's'} with the values: ${problems.map((p) => `${p.field}: ${p.why}`).join('; ')}`);
    this.problems = problems;
  }
}

export interface FillOptions {
  /** Mark filled fields read-only, so a later viewer cannot change them. */
  readonly lock?: boolean;
}

export interface FillResult {
  readonly pdf: Uint8Array;
  readonly filled: readonly string[];
}

const HELV = (): PdfDict => dict({ Type: name('Font'), Subtype: name('Type1'), BaseFont: name('Helvetica'), Encoding: name('WinAnsiEncoding') });

const pdfText = (s: string): string => escapeLiteral(Buffer.from(winAnsi(s), 'latin1'));

interface Style {
  readonly size: number;
  readonly quad: number;
  readonly bg: number[] | null;
  readonly bc: number[] | null;
}

function styleOf(doc: Doc, c: Collected, widget: PdfDict): Style {
  const da = strings(doc, inherited(doc, c.node, 'DA') ?? doc.resolve(widget.entries.get('DA')));
  const m = typeof da === 'string' ? /(-?\d+(?:\.\d+)?)\s+Tf/.exec(da) : null;
  const mk = doc.resolve(widget.entries.get('MK'));
  const col = (k: string): number[] | null => {
    const a = isDict(mk) ? doc.resolve(mk.entries.get(k)) : null;
    return Array.isArray(a) && (a.length === 1 || a.length === 3) && a.every((x) => typeof x === 'number') ? (a as number[]) : null;
  };
  return { size: m ? Number(m[1]) : 0, quad: num(inherited(doc, c.node, 'Q')), bg: col('BG'), bc: col('BC') };
}

const colorOp = (c: number[], stroke: boolean): string => (c.length === 1 ? `${c[0]} ${stroke ? 'G' : 'g'}` : `${c.join(' ')} ${stroke ? 'RG' : 'rg'}`);

function frame(w: number, h: number, s: Style): string[] {
  const ops: string[] = [];
  if (s.bg) ops.push(`q ${colorOp(s.bg, false)} 0 0 ${r4(w)} ${r4(h)} re f Q`);
  if (s.bc) ops.push(`q ${colorOp(s.bc, true)} 1 w 0.5 0.5 ${r4(w - 1)} ${r4(h - 1)} re S Q`);
  return ops;
}

/** The appearance of a text-like value: single line, multiline, comb or password. */
function textAppearance(f: Pick<Field, 'multiline' | 'password' | 'comb' | 'maxLen'>, w: number, h: number, value: string, s: Style): { dict: Record<string, PdfObj>; data: string } {
  const shown = f.password ? '*'.repeat([...value].length) : value;
  const ops = frame(w, h, s);
  const body: string[] = [];
  const baseDict = { Type: name('XObject'), Subtype: name('Form'), BBox: [0, 0, r4(w), r4(h)], Resources: dict({ Font: dict({ F0: HELV() }) }) };
  if (shown !== '') {
    if (f.comb && f.maxLen) {
      const size = s.size > 0 ? s.size : Math.max(4, Math.min(12, h - 4));
      const cell = w / f.maxLen;
      [...shown].slice(0, f.maxLen).forEach((ch, i) => {
        const cw = width(winAnsi(ch), size);
        body.push(`BT /F0 ${r4(size)} Tf 0 g ${r4(cell * i + (cell - cw) / 2)} ${r4((h - 0.72 * size) / 2)} Td (${pdfText(ch)}) Tj ET`);
      });
    } else if (f.multiline) {
      const size = s.size > 0 ? s.size : 10;
      const lines = shown.split(/\r\n|\r|\n/).flatMap((l) => (l === '' ? [''] : wrap(winAnsi(l), size, w - 4)));
      lines.forEach((l, i) => {
        const y = h - 2 - size * (i + 1) * 1.15 + size * 0.15;
        if (y < -size) return;
        const x = s.quad === 1 ? (w - width(l, size)) / 2 : s.quad === 2 ? w - 2 - width(l, size) : 2;
        body.push(`BT /F0 ${r4(size)} Tf 0 g ${r4(x)} ${r4(y)} Td (${escapeLiteral(Buffer.from(l, 'latin1'))}) Tj ET`);
      });
    } else {
      let size = s.size > 0 ? s.size : Math.max(4, Math.min(12, h - 4));
      const t = winAnsi(shown);
      if (s.size === 0) while (size > 4 && width(t, size) > w - 4) size -= 0.5;
      const tw = width(t, size);
      const x = s.quad === 1 ? (w - tw) / 2 : s.quad === 2 ? w - 2 - tw : 2;
      body.push(`BT /F0 ${r4(size)} Tf 0 g ${r4(x)} ${r4((h - 0.72 * size) / 2)} Td (${escapeLiteral(Buffer.from(t, 'latin1'))}) Tj ET`);
    }
  }
  return { dict: baseDict, data: [...ops, '/Tx BMC', 'q', `1 1 ${r4(w - 2)} ${r4(h - 2)} re W n`, ...body, 'Q', 'EMC'].join('\n') };
}

function listAppearance(options: readonly { value: string; label: string }[], selected: readonly string[], w: number, h: number, s: Style): { dict: Record<string, PdfObj>; data: string } {
  const size = s.size > 0 ? s.size : 10;
  const ops = frame(w, h, s);
  options.forEach((o, i) => {
    const top = h - 2 - i * size * 1.2;
    if (top < 0) return;
    if (selected.includes(o.value)) ops.push(`q 0.6 0.75 0.85 rg 1 ${r4(top - size * 1.2)} ${r4(w - 2)} ${r4(size * 1.2)} re f Q`);
    ops.push(`BT /F0 ${r4(size)} Tf 0 g 3 ${r4(top - size)} Td (${pdfText(o.label)}) Tj ET`);
  });
  return { dict: { Type: name('XObject'), Subtype: name('Form'), BBox: [0, 0, r4(w), r4(h)], Resources: dict({ Font: dict({ F0: HELV() }) }) }, data: ['/Tx BMC', 'q', ...ops, 'Q', 'EMC'].join('\n') };
}

/** Appearances for a check box drawn from lines, so no symbol font is needed: the box alone, and the box with a tick. */
function checkAppearances(w: number, h: number, s: Style): { off: { dict: Record<string, PdfObj>; data: string }; on: { dict: Record<string, PdfObj>; data: string } } {
  const box = frame(w, h, { ...s, bc: s.bc ?? [0], bg: s.bg ?? [1] });
  const lw = r4(Math.max(0.8, Math.min(w, h) * 0.12));
  const tick = `q 0 G ${lw} w 1 J 1 j ${r4(w * 0.22)} ${r4(h * 0.52)} m ${r4(w * 0.42)} ${r4(h * 0.26)} l ${r4(w * 0.8)} ${r4(h * 0.76)} l S Q`;
  const d = { Type: name('XObject'), Subtype: name('Form'), BBox: [0, 0, r4(w), r4(h)] };
  return { off: { dict: d, data: box.join('\n') }, on: { dict: d, data: [...box, tick].join('\n') } };
}


/**
 * Fills fields by full name. Values: text for text and choice fields; true, false or the state name for check
 * boxes; the state name of the chosen button for radio groups; an array for multiple-selection lists; null or ""
 * clears. Everything is checked first; if anything is wrong nothing is written and a FormError lists every problem.
 */
export function fill(bytes: Uint8Array, values: Readonly<Record<string, FieldValue>>, options: FillOptions = {}): FillResult {
  const doc = readDoc(bytes);
  const { fields } = collect(doc);
  const form = readForm(bytes);
  const byName = new Map(form.fields.map((f) => [f.name, f]));
  const collected = new Map(fields.map((c) => [c.node.name, c]));
  const problems: Problem[] = [];
  const plan: { field: Field; c: Collected; value: FieldValue }[] = [];
  for (const [fname, value] of Object.entries(values)) {
    const f = byName.get(fname);
    const c = collected.get(fname);
    if (!f || !c) {
      problems.push({ field: fname, why: 'there is no field with that name' });
      continue;
    }
    if (f.readOnly) problems.push({ field: fname, why: 'the field is read-only' });
    else if (f.type === 'signature') problems.push({ field: fname, why: 'a signature field is signed, not filled' });
    else if (f.type === 'pushbutton') problems.push({ field: fname, why: 'a push button has no value' });
    else if (f.type === 'text') {
      if (value !== null && typeof value !== 'string') problems.push({ field: fname, why: 'a text field takes text' });
      else if (typeof value === 'string') {
        if (f.maxLen !== null && [...value].length > f.maxLen) problems.push({ field: fname, why: `the value has ${[...value].length} characters; at most ${f.maxLen} fit` });
        else if (!f.multiline && /[\r\n]/.test(value)) problems.push({ field: fname, why: 'a single-line field cannot hold a line break' });
        else plan.push({ field: f, c, value });
      } else plan.push({ field: f, c, value: '' });
    } else if (f.type === 'checkbox') {
      const on = f.widgets[0]?.onState ?? 'Yes';
      if (value === true || value === on) plan.push({ field: f, c, value: true });
      else if (value === false || value === null || value === '' || value === 'Off') plan.push({ field: f, c, value: false });
      else problems.push({ field: fname, why: `a check box is true, false or "${on}"` });
    } else if (f.type === 'radio') {
      const states = f.widgets.map((w) => w.onState).filter((s): s is string => s !== null);
      if (value === null || value === '' || value === 'Off') plan.push({ field: f, c, value: null });
      else if (typeof value === 'string' && states.includes(value)) plan.push({ field: f, c, value });
      else problems.push({ field: fname, why: `choose one of: ${states.join(', ') || '(no buttons have appearance states)'}` });
    } else {
      const list = value === null || value === '' ? [] : typeof value === 'string' ? [value] : Array.isArray(value) ? [...value] : null;
      if (list === null) problems.push({ field: fname, why: 'a choice field takes an option or a list of options' });
      else if (list.length > 1 && !f.multiSelect) problems.push({ field: fname, why: 'only one option can be chosen' });
      else {
        const bad = list.filter((v) => !f.options.some((o) => o.value === v));
        if (bad.length && !f.editable) problems.push({ field: fname, why: `not among the options: ${bad.join(', ')}` });
        else plan.push({ field: f, c, value: f.multiSelect ? list : (list[0] ?? null) });
      }
    }
  }
  if (problems.length) throw new FormError(problems);
  if (!plan.length) return { pdf: bytes, filled: [] };

  const numbers = new Numbers(doc);
  const out: NewObj[] = [];
  const emit = (n: number, d: PdfDict) => out.push({ num: n, gen: genOf(doc, n), body: Buffer.from(serialize(d), 'latin1') });
  const addStream = (a: { dict: Record<string, PdfObj>; data: string }): PdfRef => {
    const n = numbers.take();
    out.push({ num: n, gen: 0, body: streamBody(a.dict, a.data) });
    return ref(n);
  };
  const flagged = (d: PdfDict, c: Collected): PdfDict => {
    if (!options.lock) return d;
    const e = new Map(d.entries);
    e.set('Ff', num(inherited(doc, c.node, 'Ff')) | FF.readOnly);
    return { kind: 'dict', entries: e };
  };

  for (const { field, c, value } of plan) {
    const fieldEntries = new Map(c.node.dict.entries);
    const merged = c.kids.length === 1 && c.kids[0]!.num === c.node.num;
    const setV = (v: PdfObj) => (v === null ? fieldEntries.delete('V') : fieldEntries.set('V', v));
    const widgetUpdates = new Map<number, Map<string, PdfObj>>();
    const widgetEntries = (k: { num: number; dict: PdfDict }) => {
      if (merged) return fieldEntries;
      if (!widgetUpdates.has(k.num)) widgetUpdates.set(k.num, new Map(k.dict.entries));
      return widgetUpdates.get(k.num)!;
    };
    if (field.type === 'text' || field.type === 'combo' || field.type === 'list') {
      const list = field.type === 'text' ? [value as string] : Array.isArray(value) ? (value as string[]) : value === null ? [] : [value as string];
      const labels = list.map((v) => field.options.find((o) => o.value === v)?.label ?? v);
      if (field.type === 'text') setV(value === '' ? null : textString(value as string));
      else if (field.multiSelect) setV(list.length ? list.map(textString) : null);
      else setV(list.length ? textString(list[0]!) : null);
      if (field.multiSelect || field.type === 'list') fieldEntries.set('I', list.map((v) => field.options.findIndex((o) => o.value === v)).filter((i) => i >= 0).sort((a, b) => a - b));
      for (const k of c.kids) {
        const [x1, y1, x2, y2] = rectOf(doc, k.dict);
        const st = styleOf(doc, c, k.dict);
        const ap = field.type === 'list' ? listAppearance(field.options, list, x2 - x1, y2 - y1, st) : textAppearance(field, x2 - x1, y2 - y1, labels.join(', '), st);
        widgetEntries(k).set('AP', dict({ N: addStream(ap) }));
      }
    } else if (field.type === 'checkbox') {
      const on = value === true;
      const state = field.widgets[0]?.onState ?? 'Yes';
      setV(name(on ? state : 'Off'));
      for (const k of c.kids) {
        const e = widgetEntries(k);
        e.set('AS', name(on ? state : 'Off'));
        if (!apStates(doc, k.dict).length) {
          const [x1, y1, x2, y2] = rectOf(doc, k.dict);
          const a = checkAppearances(x2 - x1, y2 - y1, styleOf(doc, c, k.dict));
          e.set('AP', dict({ N: dict({ Off: addStream(a.off), [state]: addStream(a.on) }) }));
        }
      }
    } else {
      setV(value === null ? name('Off') : name(value as string));
      for (const k of c.kids) {
        const states = apStates(doc, k.dict).filter((s) => s !== 'Off');
        widgetEntries(k).set('AS', name(value !== null && states.includes(value as string) ? (value as string) : 'Off'));
      }
    }
    emit(c.node.num, flagged({ kind: 'dict', entries: fieldEntries }, c));
    for (const [n, e] of widgetUpdates) emit(n, { kind: 'dict', entries: e });
  }
  return { pdf: appendUpdate(doc, out), filled: plan.map((p) => p.field.name) };
}

// ================================================================ flattening

export interface FlattenResult {
  readonly pdf: Uint8Array;
  readonly flattened: readonly string[];
  /** Fields left in place, and why. */
  readonly skipped: readonly Problem[];
}

const mul = (a: number[], b: number[]): number[] => [a[0]! * b[0]! + a[1]! * b[2]!, a[0]! * b[1]! + a[1]! * b[3]!, a[2]! * b[0]! + a[3]! * b[2]!, a[2]! * b[1]! + a[3]! * b[3]!, a[4]! * b[0]! + a[5]! * b[2]! + b[4]!, a[4]! * b[1]! + a[5]! * b[3]! + b[5]!];

/** The matrix that places an appearance in its widget's rectangle (ISO 32000-1, 12.5.5 algorithm 8.1). */
export function appearanceMatrix(bbox: readonly number[], matrix: readonly number[], rect: readonly number[]): number[] {
  const m = matrix.length === 6 ? [...matrix] : [1, 0, 0, 1, 0, 0];
  const pts = [[bbox[0]!, bbox[1]!], [bbox[2]!, bbox[1]!], [bbox[2]!, bbox[3]!], [bbox[0]!, bbox[3]!]].map(([x, y]) => [m[0]! * x! + m[2]! * y! + m[4]!, m[1]! * x! + m[3]! * y! + m[5]!]);
  const xs = pts.map((p) => p[0]!);
  const ys = pts.map((p) => p[1]!);
  const [tx1, tx2, ty1, ty2] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sx = tx2 - tx1 === 0 ? 1 : (rect[2]! - rect[0]!) / (tx2 - tx1);
  const sy = ty2 - ty1 === 0 ? 1 : (rect[3]! - rect[1]!) / (ty2 - ty1);
  return [sx, 0, 0, sy, rect[0]! - tx1 * sx, rect[1]! - ty1 * sy];
}

function inheritedPage(doc: Doc, page: PdfDict, key: string): PdfObj {
  let cur: PdfDict | null = page;
  for (let i = 0; i < 32 && cur; i++) {
    if (cur.entries.has(key)) return doc.resolve(cur.entries.get(key));
    const p: PdfObj = doc.resolve(cur.entries.get('Parent'));
    cur = isDict(p) ? p : null;
  }
  return null;
}

/** Draws each field's current appearance into the page and removes the field. Pass names to flatten only those. */
export function flatten(bytes: Uint8Array, only?: readonly string[]): FlattenResult {
  const doc = readDoc(bytes);
  const { fields, acro, acroNum } = collect(doc);
  if (!acro) return { pdf: bytes, flattened: [], skipped: [] };
  const wanted = only ? new Set(only) : null;
  if (wanted) for (const w of wanted) if (!fields.some((c) => c.node.name === w)) throw new FormError([{ field: w, why: 'there is no field with that name' }]);
  const skipped: Problem[] = [];
  const flat: string[] = [];
  const perPage = new Map<number, { widget: number; ap: PdfRef; matrix: number[] }[]>();
  const removed = new Set<number>();
  const pageOf = pageOfAnnots(doc);
  const pages = pageRefs(doc);
  const fieldNums = new Set<number>();
  for (const c of fields) {
    if (wanted && !wanted.has(c.node.name)) continue;
    const ft = inherited(doc, c.node, 'FT');
    if (isName(ft) && ft.value === 'Sig') {
      skipped.push({ field: c.node.name, why: 'a signature field is not flattened' });
      continue;
    }
    let drawable = 0;
    let reason: string | null = null;
    const hide = new Set<number>();
    const draws: { widget: number; page: number; ap: PdfRef; matrix: number[] }[] = [];
    for (const k of c.kids) {
      const flags = num(doc.resolve(k.dict.entries.get('F')));
      if (flags & (2 | 32)) {
        hide.add(k.num);
        continue;
      }
      const as = doc.resolve(k.dict.entries.get('AS'));
      const ap = doc.resolve(k.dict.entries.get('AP'));
      const n = isDict(ap) ? ap.entries.get('N') : undefined;
      const resolvedN = doc.resolve(n);
      let stream: PdfRef | null = isRef(n) && isDict(resolvedN) && resolvedN.entries.has('BBox') ? n : null;
      if (!stream && isDict(resolvedN) && isName(as)) {
        const pick = resolvedN.entries.get(as.value);
        if (isRef(pick)) stream = pick;
      }
      if (!stream) {
        // A button showing its Off state has nothing to draw; any other widget without a drawing cannot be flattened.
        if (isName(as) && as.value === 'Off') {
          hide.add(k.num);
          drawable++;
        } else reason ??= 'the widget has no appearance to draw';
        continue;
      }
      const page = pageOf.get(k.num);
      if (page === undefined) {
        reason ??= 'no page lists this widget';
        continue;
      }
      const sd = doc.get(stream.num);
      if (!isDict(sd)) {
        reason ??= 'the appearance is not a drawing';
        continue;
      }
      const bbox = (doc.resolve(sd.entries.get('BBox')) as PdfObj[]).map((x) => num(doc.resolve(x)));
      const mat = doc.resolve(sd.entries.get('Matrix'));
      const matrix = appearanceMatrix(bbox, Array.isArray(mat) ? mat.map((x) => num(doc.resolve(x))) : [], rectOf(doc, k.dict));
      draws.push({ widget: k.num, page, ap: stream, matrix });
      drawable++;
    }
    if (reason || !(drawable || hide.size)) {
      skipped.push({ field: c.node.name, why: reason ?? 'the widget has no appearance to draw' });
      continue;
    }
    for (const h of hide) removed.add(h);
    for (const d of draws) {
      if (!perPage.has(d.page)) perPage.set(d.page, []);
      perPage.get(d.page)!.push(d);
      removed.add(d.widget);
    }
    for (const k of c.kids) removed.add(k.num);
    fieldNums.add(c.node.num);
    flat.push(c.node.name);
  }
  if (!flat.length) return { pdf: bytes, flattened: [], skipped };

  const numbers = new Numbers(doc);
  const out: NewObj[] = [];
  const emit = (n: number, d: PdfDict) => out.push({ num: n, gen: genOf(doc, n), body: Buffer.from(serialize(d), 'latin1') });
  const touched = new Set<number>([...perPage.keys()]);
  for (const [i, p] of pages.entries()) {
    const d = doc.get(p.num);
    const a = isDict(d) ? doc.resolve(d.entries.get('Annots')) : null;
    if (Array.isArray(a) && a.some((r) => isRef(r) && removed.has(r.num))) touched.add(i);
  }
  for (const i of touched) {
    const page = doc.get(pages[i]!.num) as PdfDict;
    const e = new Map(page.entries);
    const draws = perPage.get(i) ?? [];
    if (draws.length) {
      const res = inheritedPage(doc, page, 'Resources');
      const resEntries = isDict(res) ? new Map(res.entries) : new Map<string, PdfObj>();
      const xo = doc.resolve(resEntries.get('XObject'));
      const xoEntries = isDict(xo) ? new Map(xo.entries) : new Map<string, PdfObj>();
      const ops: string[] = [];
      draws.forEach((dr, j) => {
        const n = `FlatFm${j}`;
        xoEntries.set(n, dr.ap);
        ops.push(`q ${dr.matrix.map(r4).join(' ')} cm /${n} Do Q`);
      });
      resEntries.set('XObject', { kind: 'dict', entries: xoEntries });
      e.set('Resources', { kind: 'dict', entries: resEntries });
      const mk = (s: string): PdfRef => {
        const n = numbers.take();
        out.push({ num: n, gen: 0, body: streamBody({}, s) });
        return ref(n);
      };
      const old = doc.resolve(page.entries.get('Contents'));
      const oldRefs: PdfObj[] = isRef(page.entries.get('Contents')) && !Array.isArray(old) ? [page.entries.get('Contents')!] : Array.isArray(old) ? old : [];
      e.set('Contents', [mk('q'), ...oldRefs, mk('Q'), mk(ops.join('\n'))]);
    }
    const annots = doc.resolve(page.entries.get('Annots'));
    if (Array.isArray(annots)) e.set('Annots', annots.filter((r) => !(isRef(r) && removed.has(r.num))));
    emit(pages[i]!.num, { kind: 'dict', entries: e });
  }
  // The form: drop the flattened fields; with none left, drop the form.
  const root = doc.resolve(doc.trailer.entries.get('Root')) as PdfDict;
  const rootRef = doc.trailer.entries.get('Root') as PdfRef;
  const fieldList = doc.resolve(acro.entries.get('Fields'));
  // A parent goes when every field under it has gone; one that keeps some fields loses only the Kids that went.
  const kidsOf = new Map<number, Set<number>>();
  for (const c of fields) {
    for (let n: Node | null = c.node; n; n = n.parent) if (n.parent) kidsOf.set(n.parent.num, (kidsOf.get(n.parent.num) ?? new Set()).add(n.num));
  }
  const gone = new Set<number>(fieldNums);
  const isGone = (n: number): boolean => {
    if (gone.has(n)) return true;
    const k = kidsOf.get(n);
    if (k && [...k].every(isGone)) {
      gone.add(n);
      return true;
    }
    return false;
  };
  for (const n of kidsOf.keys()) isGone(n);
  for (const [p, ks] of kidsOf) {
    if (gone.has(p) || ![...ks].some((k) => gone.has(k))) continue;
    const pd = doc.get(p) as PdfDict;
    const e = new Map(pd.entries);
    const kids = doc.resolve(pd.entries.get('Kids'));
    e.set('Kids', (Array.isArray(kids) ? kids : []).filter((r) => !(isRef(r) && gone.has(r.num))));
    emit(p, { kind: 'dict', entries: e });
  }
  const remaining = (Array.isArray(fieldList) ? fieldList : []).filter((r) => !(isRef(r) && gone.has(r.num)));
  if (remaining.length === 0) {
    const c = new Map(root.entries);
    c.delete('AcroForm');
    emit(rootRef.num, { kind: 'dict', entries: c });
  } else {
    const a = new Map(acro.entries);
    a.set('Fields', remaining);
    if (acroNum !== null) emit(acroNum, { kind: 'dict', entries: a });
    else {
      const c = new Map(root.entries);
      c.set('AcroForm', { kind: 'dict', entries: a });
      emit(rootRef.num, { kind: 'dict', entries: c });
    }
  }
  return { pdf: appendUpdate(doc, out), flattened: flat, skipped };
}

// ================================================================ placement

export type Rect = readonly [number, number, number, number];

export interface PageGeometry {
  /** The visible area (crop box, else media box) in user space. */
  readonly box: Rect;
  readonly rotate: 0 | 90 | 180 | 270;
  /** User-space units per point (UserUnit; almost always 1). */
  readonly userUnit: number;
}

/** The geometry of a page, inherited attributes included. */
export function pageGeometry(bytes: Uint8Array, pageIndex: number): PageGeometry {
  const doc = readDoc(bytes);
  const pages = pageRefs(doc);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pages.length) throw new FormsError(`the document has ${pages.length} page(s); there is no page ${pageIndex + 1}`);
  const page = doc.get(pages[pageIndex]!.num) as PdfDict;
  const box = (k: string): Rect | null => {
    const b = inheritedPage(doc, page, k);
    if (!Array.isArray(b) || b.length !== 4) return null;
    const n = b.map((x) => num(doc.resolve(x)));
    return [Math.min(n[0]!, n[2]!), Math.min(n[1]!, n[3]!), Math.max(n[0]!, n[2]!), Math.max(n[1]!, n[3]!)];
  };
  const media = box('MediaBox') ?? [0, 0, 612, 792];
  let visible = box('CropBox') ?? media;
  // The crop box cannot show more than the media box.
  visible = [Math.max(visible[0], media[0]), Math.max(visible[1], media[1]), Math.min(visible[2], media[2]), Math.min(visible[3], media[3])];
  if (visible[2] <= visible[0] || visible[3] <= visible[1]) visible = media;
  const rot = ((num(inheritedPage(doc, page, 'Rotate')) % 360) + 360) % 360;
  if (rot % 90 !== 0) throw new FormsError(`a page rotation of ${rot} degrees is not a multiple of 90`);
  const uu = num(inheritedPage(doc, page, 'UserUnit'), 1);
  return { box: visible, rotate: rot as 0 | 90 | 180 | 270, userUnit: uu > 0 ? uu : 1 };
}

export interface PlacementSpec {
  /** Where the area sits, measured from the top-left of the page as it is displayed. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** pt (1/72 inch, the default), px (CSS pixels, 96 per inch), mm, in, or fraction (0 to 1 of the displayed page). */
  readonly unit?: 'pt' | 'px' | 'mm' | 'in' | 'fraction';
  /** Measure y upward from the bottom of the displayed page instead. */
  readonly fromBottom?: boolean;
}

const PER_POINT: Record<string, number> = { pt: 1, px: 72 / 96, mm: 72 / 25.4, in: 72 };

/** Turns a place on the displayed page into a rectangle in the page's own coordinates, for any rotation and crop. */
export function placement(g: PageGeometry, s: PlacementSpec): Rect {
  const unit = s.unit ?? 'pt';
  if (![s.x, s.y, s.width, s.height].every(Number.isFinite)) throw new FormsError('a placement needs finite numbers');
  if (!(s.width > 0 && s.height > 0)) throw new FormsError('a placement needs a width and height above zero');
  const w = g.box[2] - g.box[0];
  const h = g.box[3] - g.box[1];
  const rotated = g.rotate === 90 || g.rotate === 270;
  const dw = rotated ? h : w;
  const dh = rotated ? w : h;
  const k = (v: number, extent: number) => (unit === 'fraction' ? v * extent : (v * PER_POINT[unit]!) / g.userUnit);
  const x0 = k(s.x, dw);
  const bw = k(s.width, dw);
  const bh = k(s.height, dh);
  const yTop = k(s.y, dh);
  // Displayed coordinates with the origin bottom-left.
  const yBottom = s.fromBottom ? yTop : dh - yTop - bh;
  if (x0 < -1e-9 || yBottom < -1e-9 || x0 + bw > dw + 1e-6 || yBottom + bh > dh + 1e-6) throw new FormsError('that place is not on the page');
  const corners: [number, number][] = [[x0, yBottom], [x0 + bw, yBottom + bh]];
  const toUser = ([xd, yd]: [number, number]): [number, number] => {
    switch (g.rotate) {
      case 0: return [xd, yd];
      case 90: return [w - yd, xd];
      case 180: return [w - xd, h - yd];
      default: return [yd, h - xd];
    }
  };
  const [p, q] = corners.map(toUser) as [[number, number], [number, number]];
  return [r4(g.box[0] + Math.min(p[0], q[0])), r4(g.box[1] + Math.min(p[1], q[1])), r4(g.box[0] + Math.max(p[0], q[0])), r4(g.box[1] + Math.max(p[1], q[1]))];
}

/** The reverse: a rectangle in page coordinates as it appears on the displayed page, in points from its top-left. */
export function displayed(g: PageGeometry, rect: Rect): { x: number; y: number; width: number; height: number } {
  const w = g.box[2] - g.box[0];
  const h = g.box[3] - g.box[1];
  const rotated = g.rotate === 90 || g.rotate === 270;
  const dh = rotated ? w : h;
  const toDisp = ([u, v]: [number, number]): [number, number] => {
    switch (g.rotate) {
      case 0: return [u, v];
      case 90: return [v, w - u];
      case 180: return [w - u, h - v];
      default: return [h - v, u];
    }
  };
  const a = toDisp([rect[0] - g.box[0], rect[1] - g.box[1]]);
  const b = toDisp([rect[2] - g.box[0], rect[3] - g.box[1]]);
  const x = Math.min(a[0], b[0]);
  const yb = Math.min(a[1], b[1]);
  const bw = Math.abs(a[0] - b[0]);
  const bh = Math.abs(a[1] - b[1]);
  return { x: r4(x * g.userUnit), y: r4((dh - yb - bh) * g.userUnit), width: r4(bw * g.userUnit), height: r4(bh * g.userUnit) };
}

// ================================================================ adding fields

export interface NewField {
  readonly name: string;
  readonly type: 'text' | 'checkbox' | 'signature';
  readonly page: number;
  /** Either a rectangle in page coordinates, or a place on the displayed page. */
  readonly rect?: Rect;
  readonly at?: PlacementSpec;
  readonly required?: boolean;
  readonly readOnly?: boolean;
  readonly multiline?: boolean;
  readonly maxLen?: number;
  readonly fontSize?: number;
  readonly tooltip?: string;
  readonly value?: string;
}

/** Adds fields to pages, and the form itself if the document has none. Each name must be new and have no dots. */
export function addFields(bytes: Uint8Array, specs: readonly NewField[]): Uint8Array {
  if (!specs.length) return bytes;
  const doc = readDoc(bytes);
  const existing = new Set(readForm(bytes).fields.map((f) => f.name));
  const problems: Problem[] = [];
  for (const s of specs) {
    if (!s.name || /[.\0]/.test(s.name)) problems.push({ field: s.name, why: 'a field name is not empty and has no dots' });
    else if (existing.has(s.name)) problems.push({ field: s.name, why: 'a field with this name already exists' });
    existing.add(s.name);
    if (!s.rect && !s.at) problems.push({ field: s.name, why: 'give a rect or a place (at)' });
    if (s.maxLen !== undefined && (!Number.isInteger(s.maxLen) || s.maxLen < 1)) problems.push({ field: s.name, why: 'maxLen is a whole number above zero' });
    if (s.value !== undefined && s.type !== 'text') problems.push({ field: s.name, why: 'only text fields start with a value' });
  }
  if (problems.length) throw new FormError(problems);

  const pages = pageRefs(doc);
  const rootRef = doc.trailer.entries.get('Root') as PdfRef;
  const root = doc.get(rootRef.num) as PdfDict;
  const acroRaw = root.entries.get('AcroForm');
  const acro = doc.resolve(acroRaw);
  const acroEntries = isDict(acro) ? new Map(acro.entries) : new Map<string, PdfObj>();
  const fields: PdfObj[] = [...(Array.isArray(doc.resolve(acroEntries.get('Fields'))) ? (doc.resolve(acroEntries.get('Fields')) as PdfObj[]) : [])];
  const numbers = new Numbers(doc);
  const out: NewObj[] = [];
  const pageAnnots = new Map<number, PdfObj[]>();

  for (const s of specs) {
    if (!Number.isInteger(s.page) || s.page < 0 || s.page >= pages.length) throw new FormError([{ field: s.name, why: `the document has ${pages.length} page(s); there is no page ${s.page + 1}` }]);
    const rect = s.rect ?? placement(pageGeometry(bytes, s.page), s.at!);
    const w = rect[2] - rect[0];
    const h = rect[3] - rect[1];
    if (!(w > 0 && h > 0)) throw new FormError([{ field: s.name, why: 'the area has no size' }]);
    const wn = numbers.take();
    const pr = pages[s.page]!;
    const flags = (s.required ? FF.required : 0) | (s.readOnly ? FF.readOnly : 0) | (s.type === 'text' && s.multiline ? FF.multiline : 0);
    const d: Record<string, PdfObj> = { Type: name('Annot'), Subtype: name('Widget'), T: textString(s.name), Rect: [...rect], P: ref(pr.num, pr.gen), F: 4 };
    if (s.tooltip) d.TU = textString(s.tooltip);
    if (flags) d.Ff = flags;
    const style: Style = { size: s.fontSize ?? 0, quad: 0, bg: [0.93, 0.95, 1], bc: [0.3, 0.4, 0.7] };
    if (s.type === 'text') {
      d.FT = name('Tx');
      d.DA = { kind: 'string', bytes: Buffer.from(`/Helv ${s.fontSize ?? 0} Tf 0 g`, 'latin1') };
      if (s.maxLen) d.MaxLen = s.maxLen;
      d.MK = dict({ BG: style.bg!, BC: style.bc! });
      if (s.value) d.V = textString(s.value);
      const ap = textAppearance({ multiline: !!s.multiline, password: false, comb: false, maxLen: s.maxLen ?? null }, w, h, s.value ?? '', style);
      const an = numbers.take();
      out.push({ num: an, gen: 0, body: streamBody(ap.dict, ap.data) });
      d.AP = dict({ N: ref(an) });
    } else if (s.type === 'checkbox') {
      d.FT = name('Btn');
      d.V = name('Off');
      d.AS = name('Off');
      const a = checkAppearances(w, h, style);
      const off = numbers.take();
      const on = numbers.take();
      out.push({ num: off, gen: 0, body: streamBody(a.off.dict, a.off.data) }, { num: on, gen: 0, body: streamBody(a.on.dict, a.on.data) });
      d.AP = dict({ N: dict({ Off: ref(off), Yes: ref(on) }) });
    } else {
      d.FT = name('Sig');
      d.MK = dict({ BG: style.bg!, BC: style.bc! });
      const an = numbers.take();
      const ap = { dict: { Type: name('XObject'), Subtype: name('Form'), BBox: [0, 0, r4(w), r4(h)] } as Record<string, PdfObj>, data: frame(w, h, style).join('\n') };
      out.push({ num: an, gen: 0, body: streamBody(ap.dict, ap.data) });
      d.AP = dict({ N: ref(an) });
    }
    out.push({ num: wn, gen: 0, body: Buffer.from(serialize(dict(d)), 'latin1') });
    fields.push(ref(wn));
    if (!pageAnnots.has(s.page)) pageAnnots.set(s.page, []);
    pageAnnots.get(s.page)!.push(ref(wn));
  }
  for (const [i, added] of pageAnnots) {
    const page = doc.get(pages[i]!.num) as PdfDict;
    const e = new Map(page.entries);
    const old = doc.resolve(page.entries.get('Annots'));
    e.set('Annots', [...(Array.isArray(old) ? old : []), ...added]);
    out.push({ num: pages[i]!.num, gen: genOf(doc, pages[i]!.num), body: Buffer.from(serialize({ kind: 'dict', entries: e }), 'latin1') });
  }
  acroEntries.set('Fields', fields);
  const dr = doc.resolve(acroEntries.get('DR'));
  const drEntries = isDict(dr) ? new Map(dr.entries) : new Map<string, PdfObj>();
  const fonts = doc.resolve(drEntries.get('Font'));
  const fontEntries = isDict(fonts) ? new Map(fonts.entries) : new Map<string, PdfObj>();
  if (!fontEntries.has('Helv')) fontEntries.set('Helv', HELV());
  drEntries.set('Font', { kind: 'dict', entries: fontEntries });
  acroEntries.set('DR', { kind: 'dict', entries: drEntries });
  const sigFlags = specs.some((s) => s.type === 'signature') ? num(doc.resolve(acroEntries.get('SigFlags'))) | 1 : null;
  if (sigFlags !== null) acroEntries.set('SigFlags', sigFlags);
  const newAcro: PdfDict = { kind: 'dict', entries: acroEntries };
  if (isRef(acroRaw)) out.push({ num: acroRaw.num, gen: genOf(doc, acroRaw.num), body: Buffer.from(serialize(newAcro), 'latin1') });
  else {
    const c = new Map(root.entries);
    c.set('AcroForm', newAcro);
    out.push({ num: rootRef.num, gen: genOf(doc, rootRef.num), body: Buffer.from(serialize({ kind: 'dict', entries: c }), 'latin1') });
  }
  return appendUpdate(doc, out);
}
