/**
 * Reading and rearranging PDFs that are made of text (ISO 32000-1/-2). Reads the file structure, including
 * incremental updates, cross-reference tables and cross-reference streams, compressed object streams, and a rebuild
 * by scanning when the table is damaged; decodes streams (Flate with PNG predictors, ASCIIHex, ASCII85, RunLength);
 * walks the page tree with inherited attributes and cycle checks; extracts text with its position, font size and page,
 * mapping codes to characters through ToUnicode maps, WinAnsi, MacRoman and /Differences; and plans and performs
 * page splitting, merging and rotation by copying exactly the objects each page needs into a new, valid file.
 *
 * It reads; it does not render. Out of scope, and said so plainly: decrypting (an encrypted file is recognised and
 * refused for text and edits, with the encryption described), OCR, glyph-level decoding of fonts that have no
 * ToUnicode map and a custom encoding, LZW/CCITT/JBIG2/JPX/DCT stream filters (their streams are kept but not decoded),
 * form fields, outlines and links (not carried into edited files), digital signatures (editing invalidates them), and
 * text in reading order across columns (items come with positions; lines are grouped by baseline).
 * Hostile input is expected: sizes, object counts, nesting, decompressed size and page-tree depth are capped.
 */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

export class PdfError extends Error {
  constructor(why: string) {
    super(why);
  }
}
/** The file is encrypted; this block does not decrypt. */
export class Encrypted extends PdfError {
  constructor() {
    super('this PDF is encrypted: it cannot be read or edited here');
  }
}

// ---------------------------------------------------------------- objects

export class Name {
  readonly name: string;
  constructor(n: string) {
    this.name = n;
  }
}
export class Ref {
  readonly num: number;
  readonly gen: number;
  constructor(num: number, gen: number) {
    this.num = num;
    this.gen = gen;
  }
}
export class PdfString {
  readonly bytes: Buffer;
  constructor(b: Buffer) {
    this.bytes = b;
  }
  /** The string as text: UTF-16BE with a byte-order mark, UTF-8 with one, else PDFDocEncoding (approximated by Latin-1). */
  get text(): string {
    const b = this.bytes;
    if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
    if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8');
    return b.toString('latin1');
  }
}
export type Dict = Map<string, Obj>;
export interface Stream {
  readonly dict: Dict;
  readonly raw: Buffer;
}
export type Obj = null | boolean | number | Name | PdfString | Obj[] | Dict | Ref | Stream;

const isDict = (o: unknown): o is Dict => o instanceof Map;
const isStream = (o: unknown): o is Stream => typeof o === 'object' && o !== null && 'dict' in o && 'raw' in o;
const isName = (o: unknown, n?: string): o is Name => o instanceof Name && (n === undefined || o.name === n);

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isReg = (c: number) => !WS.has(c) && !DELIM.has(c);

export interface Limits {
  readonly maxBytes: number;
  readonly maxObjects: number;
  readonly maxDepth: number;
  readonly maxStreamBytes: number;
  readonly maxPages: number;
}
const DEFAULT_LIMITS: Limits = { maxBytes: 200 * 1024 * 1024, maxObjects: 500_000, maxDepth: 64, maxStreamBytes: 64 * 1024 * 1024, maxPages: 20_000 };

/** A lexer and object parser over a buffer. */
class Lexer {
  pos: number;
  readonly buf: Buffer;
  private depth = 0;
  private readonly maxDepth: number;
  constructor(buf: Buffer, pos = 0, maxDepth = 64) {
    this.buf = buf;
    this.pos = pos;
    this.maxDepth = maxDepth;
  }
  skipWs(): void {
    const b = this.buf;
    while (this.pos < b.length) {
      const c = b[this.pos]!;
      if (WS.has(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      } else break;
    }
  }
  /** Reads a bare word (number, keyword, operator). */
  word(): string {
    this.skipWs();
    const s = this.pos;
    while (this.pos < this.buf.length && isReg(this.buf[this.pos]!)) this.pos++;
    return this.buf.toString('latin1', s, this.pos);
  }
  peekWord(): string {
    const p = this.pos;
    const w = this.word();
    this.pos = p;
    return w;
  }
  /** One object; `Ref`s are recognised ("12 0 R"); returns the keyword as a string-tagged object for operators. */
  object(allowOps = false): Obj | { op: string } {
    this.skipWs();
    const b = this.buf;
    if (this.pos >= b.length) throw new PdfError('unexpected end of data');
    const c = b[this.pos]!;
    if (++this.depth > this.maxDepth) throw new PdfError('objects nested too deeply');
    try {
      if (c === 0x2f) return this.name();
      if (c === 0x28) return this.literal();
      if (c === 0x3c && b[this.pos + 1] === 0x3c) return this.dict();
      if (c === 0x3c) return this.hex();
      if (c === 0x5b) {
        this.pos++;
        const out: Obj[] = [];
        for (;;) {
          this.skipWs();
          if (this.pos >= b.length) throw new PdfError('an array that never ends');
          if (b[this.pos] === 0x5d) {
            this.pos++;
            return out;
          }
          const o = this.object(allowOps);
          if (typeof o === 'object' && o !== null && 'op' in o && Object.keys(o).length === 1) throw new PdfError('a keyword inside an array');
          out.push(o as Obj);
          if (out.length > 5_000_000) throw new PdfError('an array that is too long');
        }
      }
      const w = this.word();
      if (!w) {
        this.pos++;
        throw new PdfError(`unexpected character ${JSON.stringify(String.fromCharCode(c))}`);
      }
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
        const n = Number(w);
        if (/^\d+$/.test(w)) {
          // "n g R" is a reference.
          const save = this.pos;
          const g = this.word();
          if (/^\d+$/.test(g) && this.word() === 'R') return new Ref(n, Number(g));
          this.pos = save;
        }
        return n;
      }
      if (w === 'true') return true;
      if (w === 'false') return false;
      if (w === 'null') return null;
      if (allowOps) return { op: w };
      throw new PdfError(`unexpected keyword ${JSON.stringify(w.slice(0, 20))}`);
    } finally {
      this.depth--;
    }
  }
  private name(): Name {
    this.pos++;
    const s = this.pos;
    while (this.pos < this.buf.length && isReg(this.buf[this.pos]!)) this.pos++;
    const raw = this.buf.toString('latin1', s, this.pos);
    return new Name(raw.replace(/#([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))));
  }
  private literal(): PdfString {
    const b = this.buf;
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < b.length) {
      const c = b[this.pos++]!;
      if (c === 0x5c) {
        const n = b[this.pos++];
        if (n === undefined) break;
        if (n >= 0x30 && n <= 0x37) {
          let v = n - 0x30;
          for (let k = 0; k < 2 && b[this.pos]! >= 0x30 && b[this.pos]! <= 0x37; k++) v = v * 8 + (b[this.pos++]! - 0x30);
          out.push(v & 255);
        } else if (n === 0x6e) out.push(10);
        else if (n === 0x72) out.push(13);
        else if (n === 0x74) out.push(9);
        else if (n === 0x62) out.push(8);
        else if (n === 0x66) out.push(12);
        else if (n === 13) {
          if (b[this.pos] === 10) this.pos++;
        } else if (n === 10) {
          // a line continuation
        } else out.push(n);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) return new PdfString(Buffer.from(out));
        out.push(c);
      } else out.push(c);
    }
    throw new PdfError('a string that never ends');
  }
  private hex(): PdfString {
    const b = this.buf;
    this.pos++;
    let h = '';
    while (this.pos < b.length && b[this.pos] !== 0x3e) {
      const c = String.fromCharCode(b[this.pos++]!);
      if (/[0-9A-Fa-f]/.test(c)) h += c;
      else if (!WS.has(c.charCodeAt(0))) throw new PdfError('a bad character in a hex string');
    }
    if (this.pos >= b.length) throw new PdfError('a hex string that never ends');
    this.pos++;
    return new PdfString(Buffer.from(h.length % 2 ? `${h}0` : h, 'hex'));
  }
  private dict(): Dict {
    this.pos += 2;
    const d: Dict = new Map();
    for (;;) {
      this.skipWs();
      if (this.pos >= this.buf.length) throw new PdfError('a dictionary that never ends');
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
        this.pos += 2;
        return d;
      }
      const k = this.object();
      if (!(k instanceof Name)) throw new PdfError('a dictionary key that is not a name');
      this.skipWs();
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) throw new PdfError('a dictionary key with no value');
      if (!d.has(k.name)) d.set(k.name, this.object() as Obj);
      else this.object();
      if (d.size > 100_000) throw new PdfError('a dictionary that is too large');
    }
  }
}

// ---------------------------------------------------------------- stream decoding

const filtersOf = (d: Dict): { name: string; parms: Dict | null }[] => {
  const f = d.get('Filter') ?? d.get('F');
  const p = d.get('DecodeParms') ?? d.get('DP');
  const names = f === undefined || f === null ? [] : Array.isArray(f) ? f : [f];
  const parms = p === undefined || p === null ? [] : Array.isArray(p) ? p : [p];
  return names.map((n, i) => ({ name: isName(n) ? n.name : '?', parms: isDict(parms[i]) ? (parms[i] as Dict) : null }));
};

function unpredict(data: Buffer, parms: Dict | null): Buffer {
  const pred = Number(parms?.get('Predictor') ?? 1);
  if (pred < 10) return data;
  const colors = Number(parms?.get('Colors') ?? 1);
  const bpc = Number(parms?.get('BitsPerComponent') ?? 8);
  const cols = Number(parms?.get('Columns') ?? 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const row = Math.ceil((colors * bpc * cols) / 8);
  if (!(row > 0) || row > 1 << 24) throw new PdfError('an impossible predictor width');
  const rows = Math.floor(data.length / (row + 1));
  const out = Buffer.alloc(rows * row);
  for (let r = 0; r < rows; r++) {
    const t = data[r * (row + 1)]!;
    const src = r * (row + 1) + 1;
    const dst = r * row;
    for (let i = 0; i < row; i++) {
      const x = data[src + i]!;
      const a = i >= bpp ? out[dst + i - bpp]! : 0;
      const b = r > 0 ? out[dst - row + i]! : 0;
      const c = r > 0 && i >= bpp ? out[dst - row + i - bpp]! : 0;
      let v: number;
      switch (t) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new PdfError('an unknown PNG predictor');
      }
      out[dst + i] = v & 255;
    }
  }
  return out;
}

function ascii85(data: Buffer): Buffer {
  const out: number[] = [];
  let group: number[] = [];
  const s = data.toString('latin1').replace(/\s+/g, '');
  const end = s.indexOf('~>');
  for (const ch of end >= 0 ? s.slice(0, end) : s) {
    if (ch === 'z' && !group.length) out.push(0, 0, 0, 0);
    else {
      const c = ch.charCodeAt(0) - 33;
      if (c < 0 || c > 84) throw new PdfError('a bad ASCII85 character');
      group.push(c);
      if (group.length === 5) {
        let v = 0;
        for (const g of group) v = v * 85 + g;
        out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
        group = [];
      }
    }
  }
  if (group.length > 1) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return Buffer.from(out);
}

function runLength(data: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < data.length; ) {
    const n = data[i++]!;
    if (n === 128) break;
    if (n < 128) {
      for (let k = 0; k <= n && i < data.length; k++) out.push(data[i++]!);
    } else {
      const v = data[i++];
      if (v === undefined) break;
      for (let k = 0; k < 257 - n; k++) out.push(v);
    }
    if (out.length > 1 << 28) throw new PdfError('a run-length stream that is too large');
  }
  return Buffer.from(out);
}

export class UnsupportedFilter extends PdfError {
  readonly filter: string;
  constructor(f: string) {
    super(`the ${f} filter is not decoded here`);
    this.filter = f;
  }
}

/** Decodes a stream's data through its filters. Decompression is capped, so a small file cannot become gigabytes. */
export function decodeStream(s: Stream, maxBytes = DEFAULT_LIMITS.maxStreamBytes): Buffer {
  let data = s.raw;
  for (const f of filtersOf(s.dict)) {
    switch (f.name) {
      case 'FlateDecode':
      case 'Fl':
        try {
          data = inflateSync(data, { maxOutputLength: maxBytes, finishFlush: 2 /* Z_SYNC_FLUSH: tolerate a truncated tail */ });
        } catch (e) {
          if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new PdfError('a stream that expands past the limit');
          throw new PdfError('a stream that cannot be inflated');
        }
        data = unpredict(data, f.parms);
        break;
      case 'ASCIIHexDecode':
      case 'AHx': {
        const h = data.toString('latin1').replace(/>.*$/s, '').replace(/\s+/g, '');
        data = Buffer.from(h.length % 2 ? `${h}0` : h, 'hex');
        break;
      }
      case 'ASCII85Decode':
      case 'A85':
        data = ascii85(data);
        break;
      case 'RunLengthDecode':
      case 'RL':
        data = runLength(data);
        break;
      default:
        throw new UnsupportedFilter(f.name);
    }
  }
  return data;
}

// ---------------------------------------------------------------- the document

interface XEntry {
  readonly type: 0 | 1 | 2;
  /** offset (type 1), or the object stream's number (type 2) */
  readonly a: number;
  /** generation (type 1), or the index in the object stream (type 2) */
  readonly b: number;
}

export interface EncryptionInfo {
  readonly filter: string;
  readonly version: number;
  readonly revision: number;
  readonly keyBits: number;
  readonly method: string;
}

export interface PageInfo {
  readonly index: number;
  readonly ref: Ref | undefined;
  readonly dict: Dict;
  readonly width: number;
  readonly height: number;
  readonly rotate: number;
}

export class PdfDocument {
  readonly bytes: Buffer;
  readonly version: string;
  /** Whether the cross-reference data was damaged and rebuilt by scanning. */
  readonly rebuilt: boolean;
  private readonly offset: number;
  private readonly xref = new Map<number, XEntry>();
  private trailer: Dict = new Map();
  private readonly cache = new Map<number, Obj>();
  private readonly objstm = new Map<number, Map<number, Obj>>();
  private readonly resolving = new Set<number>();
  private readonly limits: Limits;
  private pageList: PageInfo[] | undefined;

  private constructor(bytes: Buffer, offset: number, version: string, limits: Limits) {
    this.bytes = bytes;
    this.offset = offset;
    this.version = version;
    this.limits = limits;
    let ok = false;
    try {
      ok = this.readXrefChain();
    } catch {
      ok = false;
    }
    if (ok) {
      try {
        ok = this.root() !== undefined;
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      this.xref.clear();
      this.cache.clear();
      this.objstm.clear();
      this.trailer = new Map();
      this.rebuild();
    }
    this.rebuilt = !ok;
  }

  static open(input: Uint8Array, o: Partial<Limits> = {}): PdfDocument {
    const limits = { ...DEFAULT_LIMITS, ...o };
    const bytes = Buffer.from(input);
    if (bytes.length > limits.maxBytes) throw new PdfError(`a file over ${limits.maxBytes} bytes`);
    const head = bytes.subarray(0, 1024).toString('latin1');
    const m = /%PDF-(\d\.\d)/.exec(head);
    if (!m) throw new PdfError('not a PDF: no %PDF- header');
    const doc = new PdfDocument(bytes, m.index, m[1]!, limits);
    if (!doc.root()) throw new PdfError('no document catalog could be found');
    return doc;
  }

  // -------- cross references

  private readXrefChain(): boolean {
    const tail = this.bytes.subarray(Math.max(0, this.bytes.length - 2048)).toString('latin1');
    const i = tail.lastIndexOf('startxref');
    if (i < 0) return false;
    const m = /startxref\s+(\d+)/.exec(tail.slice(i));
    if (!m) return false;
    const seen = new Set<number>();
    let next: number | undefined = Number(m[1]) + this.offset;
    let first = true;
    while (next !== undefined) {
      if (seen.has(next) || next < 0 || next >= this.bytes.length) return false;
      seen.add(next);
      const t = this.readXrefSection(next);
      if (!t) return false;
      if (first) {
        this.trailer = t;
        first = false;
      }
      const stm = t.get('XRefStm');
      if (typeof stm === 'number' && !seen.has(stm + this.offset)) {
        seen.add(stm + this.offset);
        if (!this.readXrefSection(stm + this.offset)) return false;
      }
      const prev = t.get('Prev');
      next = typeof prev === 'number' ? prev + this.offset : undefined;
    }
    return true;
  }

  private readXrefSection(at: number): Dict | undefined {
    const lx = new Lexer(this.bytes, at, this.limits.maxDepth);
    lx.skipWs();
    if (this.bytes.toString('latin1', lx.pos, lx.pos + 4) === 'xref') {
      lx.pos += 4;
      for (;;) {
        lx.skipWs();
        if (this.bytes.toString('latin1', lx.pos, lx.pos + 7) === 'trailer') {
          lx.pos += 7;
          const t = lx.object();
          return isDict(t) ? t : undefined;
        }
        const start = Number(lx.word());
        const count = Number(lx.word());
        if (!Number.isInteger(start) || !Number.isInteger(count) || count < 0 || count > this.limits.maxObjects) return undefined;
        for (let k = 0; k < count; k++) {
          const off = Number(lx.word());
          const gen = Number(lx.word());
          const kind = lx.word();
          if (!Number.isFinite(off) || !Number.isFinite(gen)) return undefined;
          const num = start + k;
          if (!this.xref.has(num)) this.xref.set(num, kind === 'n' ? { type: 1, a: off + this.offset, b: gen } : { type: 0, a: 0, b: gen });
        }
      }
    }
    // A cross-reference stream: "n g obj << /Type /XRef ... >> stream".
    const obj = this.parseIndirectAt(at);
    if (!obj || !isStream(obj.value) || !isName(obj.value.dict.get('Type'), 'XRef')) return undefined;
    const st = obj.value;
    const data = decodeStream(st, this.limits.maxStreamBytes);
    const w = (st.dict.get('W') as Obj[] | undefined)?.map(Number);
    if (!w || w.length !== 3 || w.some((x) => !(x >= 0 && x <= 8))) return undefined;
    const size = Number(st.dict.get('Size'));
    const index = (st.dict.get('Index') as Obj[] | undefined)?.map(Number) ?? [0, size];
    const rowLen = w[0]! + w[1]! + w[2]!;
    let p = 0;
    const field = (n: number, dflt: number) => {
      if (n === 0) return dflt;
      let v = 0;
      for (let k = 0; k < n; k++) v = v * 256 + data[p++]!;
      return v;
    };
    for (let s = 0; s + 1 < index.length; s += 2) {
      for (let k = 0; k < index[s + 1]!; k++) {
        if (p + rowLen > data.length) return undefined;
        const type = field(w[0]!, 1);
        const a = field(w[1]!, 0);
        const b = field(w[2]!, 0);
        const num = index[s]! + k;
        if (this.xref.has(num)) continue;
        if (type === 1) this.xref.set(num, { type: 1, a: a + this.offset, b });
        else if (type === 2) this.xref.set(num, { type: 2, a, b });
        else this.xref.set(num, { type: 0, a: 0, b });
      }
    }
    return st.dict;
  }

  /** Last resort: find every "n g obj" by scanning, and the trailer or catalog. */
  private rebuild(): void {
    const s = this.bytes.toString('latin1');
    const re = /(?:^|[\r\n\s])(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
    let count = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      if (++count > this.limits.maxObjects) throw new PdfError('too many objects');
      this.xref.set(Number(m[1]), { type: 1, a: m.index + m[0].indexOf(m[1]!), b: Number(m[2]) });
    }
    let t: Dict | undefined;
    for (let i = s.indexOf('trailer'); i >= 0; i = s.indexOf('trailer', i + 7)) {
      try {
        const d = new Lexer(this.bytes, i + 7, this.limits.maxDepth).object();
        if (isDict(d) && d.has('Root')) t = d;
      } catch {
        // keep looking
      }
    }
    // Compressed objects can only be found through their object streams, so those are indexed too.
    for (const [num, e] of [...this.xref]) {
      if (e.type !== 1) continue;
      let o: Obj | undefined;
      try {
        o = this.parseIndirectAt(e.a)?.value;
      } catch {
        this.xref.delete(num);
        continue;
      }
      if (isStream(o)) {
        const ty = o.dict.get('Type');
        if (isName(ty, 'XRef') && !t && o.dict.has('Root')) t = o.dict;
        if (isName(ty, 'ObjStm')) {
          try {
            const objs = this.loadObjStm(num);
            let k = 0;
            for (const n of objs.keys()) if (!this.xref.has(n) || this.xref.get(n)!.type !== 1) this.xref.set(n, { type: 2, a: num, b: k++ });
          } catch {
            // an unreadable object stream hides only its own objects
          }
        }
      }
    }
    if (!t) {
      for (const num of [...this.xref.keys()]) {
        try {
          const o = this.get(new Ref(num, 0));
          if (isDict(o) && isName(o.get('Type'), 'Catalog')) {
            t = new Map<string, Obj>([['Root', new Ref(num, 0)]]);
            break;
          }
        } catch {
          // skip
        }
      }
    }
    if (!t) throw new PdfError('no document catalog could be found');
    this.trailer = t;
  }

  // -------- objects

  private parseIndirectAt(at: number, expect?: number): { num: number; gen: number; value: Obj } | undefined {
    if (at < 0 || at >= this.bytes.length) return undefined;
    const lx = new Lexer(this.bytes, at, this.limits.maxDepth);
    const num = Number(lx.word());
    const gen = Number(lx.word());
    if (lx.word() !== 'obj' || !Number.isInteger(num) || (expect !== undefined && num !== expect)) return undefined;
    const value = lx.object() as Obj;
    if (isDict(value)) {
      lx.skipWs();
      if (this.bytes.toString('latin1', lx.pos, lx.pos + 6) === 'stream') {
        lx.pos += 6;
        if (this.bytes[lx.pos] === 13) lx.pos++;
        if (this.bytes[lx.pos] === 10) lx.pos++;
        const start = lx.pos;
        let len = value.get('Length');
        if (len instanceof Ref) {
          try {
            len = this.get(len) as Obj;
          } catch {
            len = undefined;
          }
        }
        let end = -1;
        if (typeof len === 'number' && len >= 0 && start + len <= this.bytes.length) {
          const after = this.bytes.toString('latin1', start + len, start + len + 20);
          if (/^\s*endstream/.test(after)) end = start + len;
        }
        if (end < 0) {
          const i = this.bytes.indexOf('endstream', start, 'latin1');
          if (i < 0) throw new PdfError('a stream that never ends');
          end = i;
          if (this.bytes[end - 1] === 10) end--;
          if (this.bytes[end - 1] === 13) end--;
        }
        return { num, gen, value: { dict: value, raw: this.bytes.subarray(start, end) } };
      }
    }
    return { num, gen, value };
  }

  private loadObjStm(num: number): Map<number, Obj> {
    const hit = this.objstm.get(num);
    if (hit) return hit;
    const st = this.get(new Ref(num, 0));
    if (!isStream(st)) throw new PdfError('an object stream that is not a stream');
    const data = decodeStream(st, this.limits.maxStreamBytes);
    const n = Number(st.dict.get('N'));
    const first = Number(st.dict.get('First'));
    if (!(n >= 0 && n <= this.limits.maxObjects) || !(first >= 0 && first <= data.length)) throw new PdfError('a malformed object stream');
    const lx = new Lexer(data, 0, this.limits.maxDepth);
    const heads: [number, number][] = [];
    for (let i = 0; i < n; i++) heads.push([Number(lx.word()), Number(lx.word())]);
    const out = new Map<number, Obj>();
    for (const [onum, off] of heads) {
      if (!Number.isInteger(onum) || !Number.isFinite(off)) throw new PdfError('a malformed object stream');
      out.set(onum, new Lexer(data, first + off, this.limits.maxDepth).object() as Obj);
    }
    this.objstm.set(num, out);
    return out;
  }

  /** Follows a reference (and references to references) to the object. A missing object is null, as the format says. */
  get(o: Obj | undefined): Obj {
    let cur: Obj | undefined = o;
    for (let hops = 0; cur instanceof Ref; hops++) {
      if (hops > 32) throw new PdfError('a reference chain that does not end');
      cur = this.getNum(cur.num);
    }
    return cur === undefined ? null : cur;
  }

  private getNum(num: number): Obj {
    if (this.cache.has(num)) return this.cache.get(num)!;
    if (this.resolving.has(num)) throw new PdfError('an object that refers to itself while being read');
    const e = this.xref.get(num);
    if (!e || e.type === 0) return null;
    this.resolving.add(num);
    try {
      let v: Obj;
      if (e.type === 1) {
        const r = this.parseIndirectAt(e.a, num);
        if (!r) throw new PdfError(`object ${num} is not where the cross-reference table says`);
        v = r.value;
      } else v = this.loadObjStm(e.a).get(num) ?? null;
      if (this.cache.size > this.limits.maxObjects) throw new PdfError('too many objects read');
      this.cache.set(num, v);
      return v;
    } finally {
      this.resolving.delete(num);
    }
  }

  get objectCount(): number {
    return this.xref.size;
  }
  objectNumbers(): number[] {
    return [...this.xref.entries()].filter(([, e]) => e.type !== 0).map(([n]) => n).sort((a, b) => a - b);
  }

  root(): Dict | undefined {
    const r = this.get(this.trailer.get('Root'));
    return isDict(r) ? r : undefined;
  }
  info(): { title?: string; author?: string; subject?: string; creator?: string; producer?: string } {
    const d = this.get(this.trailer.get('Info'));
    const out: Record<string, string> = {};
    if (isDict(d)) for (const [k, key] of [['Title', 'title'], ['Author', 'author'], ['Subject', 'subject'], ['Creator', 'creator'], ['Producer', 'producer']] as const) {
      const v = this.get(d.get(k));
      if (v instanceof PdfString) out[key] = v.text;
    }
    return out;
  }

  // -------- encryption

  /** Whether the file is encrypted, and how. This block does not decrypt. */
  encryption(): EncryptionInfo | undefined {
    const e = this.get(this.trailer.get('Encrypt'));
    if (!isDict(e)) return undefined;
    const num = (k: string, d: number) => {
      const v = this.get(e.get(k));
      return typeof v === 'number' ? v : d;
    };
    const filter = this.get(e.get('Filter'));
    let method = 'RC4';
    const cf = this.get(e.get('CF'));
    if (isDict(cf)) {
      const std = this.get(cf.get('StdCF'));
      const cfm = isDict(std) ? this.get(std.get('CFM')) : undefined;
      if (isName(cfm)) method = cfm.name === 'AESV2' ? 'AES-128' : cfm.name === 'AESV3' ? 'AES-256' : cfm.name;
    }
    return { filter: isName(filter) ? filter.name : 'Standard', version: num('V', 0), revision: num('R', 0), keyBits: num('Length', 40), method };
  }

  private refuseEncrypted(): void {
    if (this.encryption()) throw new Encrypted();
  }

  // -------- pages

  pages(): PageInfo[] {
    if (this.pageList) return this.pageList;
    const root = this.root();
    const out: PageInfo[] = [];
    const seen = new Set<number>();
    const inheritable = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];
    const walk = (node: Obj, ref: Ref | undefined, inherited: Map<string, Obj>, depth: number) => {
      if (depth > 40) throw new PdfError('a page tree nested too deeply');
      const d = this.get(node);
      if (!isDict(d)) return;
      if (ref) {
        if (seen.has(ref.num)) throw new PdfError('a page tree that loops back on itself');
        seen.add(ref.num);
      }
      const kids = this.get(d.get('Kids'));
      if (Array.isArray(kids) && !isName(this.get(d.get('Type')), 'Page')) {
        const next = new Map(inherited);
        for (const k of inheritable) if (d.has(k)) next.set(k, d.get(k)!);
        for (const kid of kids) walk(kid, kid instanceof Ref ? kid : undefined, next, depth + 1);
        return;
      }
      if (out.length >= this.limits.maxPages) throw new PdfError('too many pages');
      const merged: Dict = new Map(d);
      for (const [k, v] of inherited) if (!merged.has(k)) merged.set(k, v);
      const box = this.get(merged.get('CropBox') ?? merged.get('MediaBox'));
      const nums = Array.isArray(box) ? box.map((x) => Number(this.get(x))) : [0, 0, 612, 792];
      const [x0, y0, x1, y1] = nums.length === 4 && nums.every(Number.isFinite) ? nums : [0, 0, 612, 792];
      const rot = Number(this.get(merged.get('Rotate')) ?? 0);
      out.push({ index: out.length, ref, dict: merged, width: Math.abs(x1! - x0!), height: Math.abs(y1! - y0!), rotate: Number.isFinite(rot) ? ((rot % 360) + 360) % 360 : 0 });
    };
    walk(root?.get('Pages') ?? null, root?.get('Pages') instanceof Ref ? (root!.get('Pages') as Ref) : undefined, new Map(), 0);
    this.pageList = out;
    return out;
  }

  get pageCount(): number {
    return this.pages().length;
  }

  // -------- text

  /** Text items with positions for one page (zero-based). Throws Encrypted for an encrypted file. */
  pageItems(index: number): TextItem[] {
    this.refuseEncrypted();
    const page = this.pages()[index];
    if (!page) throw new PdfError(`no page ${index + 1}`);
    return extractItems(this, page);
  }

  /** The text of a page as lines: items grouped by baseline, left to right, with a space where there is a gap. */
  pageText(index: number): string {
    return itemsToText(this.pageItems(index));
  }

  text(): string {
    return this.pages().map((_p, i) => this.pageText(i)).join('\n\n');
  }

  // -------- for editing

  /** The raw bytes of an object's content, decoded. */
  streamData(s: Stream): Buffer {
    return decodeStream(s, this.limits.maxStreamBytes);
  }
  refuseIfEncrypted(): void {
    this.refuseEncrypted();
  }
}

// ---------------------------------------------------------------- fonts and text

export interface TextItem {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly font: string;
  readonly page: number;
  /** Estimated end of the text along the baseline, from font widths where the file has them. */
  readonly x2: number;
}

interface FontInfo {
  readonly name: string;
  readonly map: Map<number, string> | undefined;
  readonly twoByte: boolean;
  readonly widths: Map<number, number> | undefined;
  readonly defaultWidth: number;
  readonly encoding: string | undefined;
}

const MAC_ROMAN = new TextDecoder('macintosh');
const WIN_ANSI = new TextDecoder('windows-1252');

const GLYPH: Record<string, string> = { space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'", parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', minus: '−', period: '.', slash: '/', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~', bullet: '•', endash: '–', emdash: '—', quoteleft: '‘', quoteright: '’', quotedblleft: '“', quotedblright: '”', ellipsis: '…', Euro: '€', fi: 'ﬁ', fl: 'ﬂ', eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', adieresis: 'ä', odieresis: 'ö', udieresis: 'ü', germandbls: 'ß', ntilde: 'ñ', ccedilla: 'ç', copyright: '©', registered: '®', degree: '°', multiply: '×', divide: '÷' };

function glyphToText(g: string): string | undefined {
  if (g in GLYPH) return GLYPH[g];
  if (/^[A-Za-z]$/.test(g)) return g;
  const u = /^uni([0-9A-Fa-f]{4})$/.exec(g) ?? /^u([0-9A-Fa-f]{4,6})$/.exec(g);
  if (u) return String.fromCodePoint(parseInt(u[1]!, 16));
  return undefined;
}

/** Parses a ToUnicode CMap: bfchar and bfrange sections, with the code length from the codespace. */
export function parseToUnicode(cmap: string): { map: Map<number, string>; twoByte: boolean } {
  const map = new Map<number, string>();
  let twoByte = false;
  const u16 = (h: string) => {
    const b = Buffer.from(h.length % 2 ? `${h}0` : h, 'hex');
    try {
      return new TextDecoder('utf-16be').decode(b);
    } catch {
      return '';
    }
  };
  for (const m of cmap.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) if (/<[0-9A-Fa-f]{4}>/.test(m[1]!)) twoByte = true;
  for (const m of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const e of m[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      map.set(parseInt(e[1]!, 16), u16(e[2]!));
      if (e[1]!.length >= 4) twoByte = true;
    }
  for (const m of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const e of m[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f]*>)/g)) {
      const lo = parseInt(e[1]!, 16);
      const hi = parseInt(e[2]!, 16);
      if (e[1]!.length >= 4) twoByte = true;
      if (hi < lo || hi - lo > 0xffff) continue;
      if (e[3]!.startsWith('[')) {
        [...e[3]!.matchAll(/<([0-9A-Fa-f]*)>/g)].forEach((d, i) => lo + i <= hi && map.set(lo + i, u16(d[1]!)));
      } else {
        const base = e[3]!.slice(1, -1);
        for (let c = lo; c <= hi; c++) {
          const chars = [...u16(base)];
          if (!chars.length) continue;
          const last = chars.pop()!;
          map.set(c, chars.join('') + String.fromCodePoint(last.codePointAt(0)! + (c - lo)));
        }
      }
    }
  }
  return { map, twoByte };
}

function loadFont(doc: PdfDocument, name: string, fobj: Obj): FontInfo {
  const f = doc.get(fobj);
  const empty: FontInfo = { name, map: undefined, twoByte: false, widths: undefined, defaultWidth: 500, encoding: undefined };
  if (!isDict(f)) return empty;
  let map: Map<number, string> | undefined;
  let twoByte = false;
  const tu = doc.get(f.get('ToUnicode'));
  if (isStream(tu)) {
    try {
      const r = parseToUnicode(doc.streamData(tu).toString('latin1'));
      map = r.map;
      twoByte = r.twoByte;
    } catch {
      // a broken map falls back to the font's encoding
    }
  }
  const sub = doc.get(f.get('Subtype'));
  if (isName(sub, 'Type0')) twoByte = true;
  let encoding: string | undefined;
  const enc = doc.get(f.get('Encoding'));
  const diffs = new Map<number, string>();
  if (isName(enc)) encoding = enc.name;
  else if (isDict(enc)) {
    const base = doc.get(enc.get('BaseEncoding'));
    if (isName(base)) encoding = base.name;
    const d = doc.get(enc.get('Differences'));
    if (Array.isArray(d)) {
      let code = 0;
      for (const x of d) {
        const v = doc.get(x);
        if (typeof v === 'number') code = v;
        else if (isName(v)) {
          const t = glyphToText(v.name);
          if (t !== undefined) diffs.set(code, t);
          code++;
        }
      }
    }
  }
  let widths: Map<number, number> | undefined;
  const w = doc.get(f.get('Widths'));
  const first = Number(doc.get(f.get('FirstChar')) ?? 0);
  if (Array.isArray(w)) {
    widths = new Map();
    w.forEach((x, i) => widths!.set(first + i, Number(doc.get(x))));
  }
  const info: FontInfo = { name, map: map ?? (diffs.size ? diffs : undefined), twoByte, widths, defaultWidth: 500, encoding };
  if (map && diffs.size) for (const [k, v] of diffs) if (!map.has(k)) map.set(k, v);
  return info;
}

function decodeText(font: FontInfo, bytes: Buffer): string {
  if (font.twoByte) {
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i]! << 8) | bytes[i + 1]!;
      out += font.map?.get(code) ?? '';
    }
    return out;
  }
  const fallback = font.encoding === 'MacRomanEncoding' ? MAC_ROMAN.decode(bytes) : WIN_ANSI.decode(bytes);
  if (!font.map) return fallback;
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += font.map.get(bytes[i]!) ?? [...fallback][i] ?? '';
  return out;
}

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
const ID: M = [1, 0, 0, 1, 0, 0];

function extractItems(doc: PdfDocument, page: PageInfo): TextItem[] {
  const items: TextItem[] = [];
  const contents = doc.get(page.dict.get('Contents'));
  const streams = (Array.isArray(contents) ? contents : [contents]).map((c) => doc.get(c as Obj)).filter(isStream);
  const resources = doc.get(page.dict.get('Resources'));
  const fontCache = new Map<string, FontInfo>();
  const run = (data: Buffer, res: Obj, ctm0: M, depth: number) => {
    const fonts = isDict(res) ? doc.get(res.get('Font')) : null;
    const xobjs = isDict(res) ? doc.get(res.get('XObject')) : null;
    const lx = new Lexer(data, 0, 64);
    const stack: (Obj | { op: string })[] = [];
    let ctm = ctm0;
    const saved: M[] = [];
    let tm: M = ID;
    let tlm: M = ID;
    let font: FontInfo | undefined;
    let size = 0;
    let leading = 0;
    let charSp = 0;
    let wordSp = 0;
    let hScale = 1;
    const fontFor = (n: string) => {
      const key = `${depth}:${n}`;
      if (!fontCache.has(key) && isDict(fonts)) fontCache.set(key, loadFont(doc, n, fonts.get(n) ?? null));
      return fontCache.get(key);
    };
    const num = (i: number) => Number(stack[i] ?? 0);
    const show = (bytes: Buffer) => {
      if (!font) return;
      const text = decodeText(font, bytes);
      const trm = mul(tm, ctm);
      let adv = 0;
      if (font.twoByte) adv = (bytes.length / 2) * (font.defaultWidth / 1000) * size;
      else for (const b of bytes) adv += ((font.widths?.get(b) ?? font.defaultWidth) / 1000) * size + charSp + (b === 32 ? wordSp : 0);
      adv *= hScale;
      const unit = Math.hypot(ctm[0], ctm[1]) || 1;
      if (text.length) items.push({ text, x: trm[4], y: trm[5], size: Math.abs(size * Math.hypot(trm[2], trm[3])) || size, font: font.name, page: page.index, x2: trm[4] + adv * unit });
      tm = mul([1, 0, 0, 1, adv, 0], tm);
    };
    for (;;) {
      lx.skipWs();
      if (lx.pos >= data.length) break;
      let o: Obj | { op: string };
      try {
        o = lx.object(true);
      } catch {
        // skip a byte of garbage and carry on: a damaged stream still yields what precedes and follows it
        lx.pos++;
        continue;
      }
      if (typeof o === 'object' && o !== null && 'op' in o && Object.keys(o).length === 1) {
        const op = (o as { op: string }).op;
        switch (op) {
          case 'q': saved.push(ctm); break;
          case 'Q': ctm = saved.pop() ?? ctm; break;
          case 'cm': ctm = mul([num(0), num(1), num(2), num(3), num(4), num(5)], ctm); break;
          case 'BT': tm = ID; tlm = ID; break;
          case 'Tf': {
            const n = stack[0];
            font = isName(n) ? fontFor(n.name) : font;
            size = num(1);
            break;
          }
          case 'Tc': charSp = num(0); break;
          case 'Tw': wordSp = num(0); break;
          case 'Tz': hScale = num(0) / 100; break;
          case 'TL': leading = num(0); break;
          case 'Td': tlm = mul([1, 0, 0, 1, num(0), num(1)], tlm); tm = tlm; break;
          case 'TD': leading = -num(1); tlm = mul([1, 0, 0, 1, num(0), num(1)], tlm); tm = tlm; break;
          case 'Tm': tlm = [num(0), num(1), num(2), num(3), num(4), num(5)]; tm = tlm; break;
          case 'T*': tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; break;
          case 'Tj': if (stack[0] instanceof PdfString) show(stack[0].bytes); break;
          case "'": tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; if (stack[0] instanceof PdfString) show(stack[0].bytes); break;
          case '"': wordSp = num(0); charSp = num(1); tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; if (stack[2] instanceof PdfString) show(stack[2].bytes); break;
          case 'TJ': {
            const arr = stack[0];
            if (Array.isArray(arr))
              for (const el of arr) {
                if (el instanceof PdfString) show(el.bytes);
                else if (typeof el === 'number') tm = mul([1, 0, 0, 1, (-el / 1000) * size * hScale, 0], tm);
              }
            break;
          }
          case 'Do': {
            const n = stack[0];
            const x = isName(n) && isDict(xobjs) ? doc.get(xobjs.get(n.name) ?? null) : null;
            if (isStream(x) && isName(doc.get(x.dict.get('Subtype')), 'Form') && depth < 5) {
              const mat = doc.get(x.dict.get('Matrix'));
              const fm: M = Array.isArray(mat) && mat.length === 6 ? (mat.map((v) => Number(doc.get(v))) as M) : ID;
              try {
                run(doc.streamData(x), doc.get(x.dict.get('Resources')) ?? res, mul(fm, ctm), depth + 1);
              } catch {
                // a form we cannot read contributes no text
              }
            }
            break;
          }
          case 'BI': {
            // An inline image: skip its data up to "EI" surrounded by whitespace.
            let i = data.indexOf('EI', lx.pos, 'latin1');
            while (i >= 0 && !(WS.has(data[i - 1] ?? 32) && (i + 2 >= data.length || WS.has(data[i + 2]!)))) i = data.indexOf('EI', i + 1, 'latin1');
            lx.pos = i < 0 ? data.length : i + 2;
            break;
          }
        }
        stack.length = 0;
      } else {
        stack.push(o);
        if (stack.length > 512) stack.shift();
      }
    }
  };
  for (const s of streams) {
    try {
      run(doc.streamData(s), resources, ID, 0);
    } catch (e) {
      if (!(e instanceof PdfError)) throw e;
    }
  }
  return items;
}

/** Items to text: baselines within half a font size are one line; a gap wider than a fifth of the size is a space. */
export function itemsToText(items: readonly TextItem[]): string {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: TextItem[][] = [];
  for (const it of sorted) {
    const line = lines.find((l) => Math.abs(l[0]!.y - it.y) <= Math.max(1, it.size * 0.5));
    if (line) line.push(it);
    else lines.push([it]);
  }
  return lines
    .map((l) => {
      l.sort((a, b) => a.x - b.x);
      let s = '';
      let end = -Infinity;
      for (const it of l) {
        if (s && it.x - end > it.size * 0.2 && !s.endsWith(' ') && !it.text.startsWith(' ')) s += ' ';
        s += it.text;
        end = it.x2;
      }
      return s.trimEnd();
    })
    .join('\n');
}

// ---------------------------------------------------------------- writing and page edits

const num2 = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''));
const escName = (n: string) => n.replace(/[^!-~]|[#/()<>[\]{}%]/g, (c) => `#${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

function serialize(o: Obj): Buffer {
  if (o === null) return Buffer.from('null');
  if (typeof o === 'boolean') return Buffer.from(o ? 'true' : 'false');
  if (typeof o === 'number') return Buffer.from(num2(o));
  if (o instanceof Name) return Buffer.from(`/${escName(o.name)}`);
  if (o instanceof Ref) return Buffer.from(`${o.num} ${o.gen} R`);
  if (o instanceof PdfString) return Buffer.from(`<${o.bytes.toString('hex')}>`);
  if (Array.isArray(o)) return Buffer.concat([Buffer.from('['), ...o.flatMap((x, i) => (i ? [Buffer.from(' '), serialize(x)] : [serialize(x)])), Buffer.from(']')]);
  if (isStream(o)) {
    const d: Dict = new Map(o.dict);
    d.set('Length', o.raw.length);
    return Buffer.concat([serialize(d), Buffer.from('\nstream\n'), o.raw, Buffer.from('\nendstream')]);
  }
  const parts: Buffer[] = [Buffer.from('<<')];
  for (const [k, v] of o as Dict) parts.push(Buffer.from(`/${escName(k)} `), serialize(v), Buffer.from(' '));
  parts.push(Buffer.from('>>'));
  return Buffer.concat(parts);
}

/** One page to take into a new file: which document, which page, and an extra turn in degrees. */
export interface PagePick {
  readonly doc: number;
  readonly page: number;
  readonly rotate?: 0 | 90 | 180 | 270;
}
export interface Plan {
  readonly outputs: readonly { readonly name: string; readonly pages: readonly PagePick[] }[];
}

/** "1-3,5,8-" (one-based, inclusive, open end allowed) to zero-based page numbers, in the order written. */
export function parseRanges(spec: string, pageCount: number): number[] {
  const out: number[] = [];
  for (const raw of spec.split(',')) {
    const part = raw.trim();
    const m = /^(\d+)?(?:(-)(\d+)?)?$/.exec(part);
    if (!part || !m || (m[1] === undefined && m[3] === undefined)) throw new PdfError(`${JSON.stringify(part)} is not a page range`);
    const from = m[1] === undefined ? 1 : Number(m[1]);
    const to = m[2] === undefined ? from : m[3] === undefined ? pageCount : Number(m[3]);
    if (from < 1 || to < from || to > pageCount) throw new PdfError(`${JSON.stringify(part)} is outside pages 1 to ${pageCount}`);
    for (let p = from; p <= to; p++) out.push(p - 1);
  }
  return out;
}

/** Splits one document: into pieces of `every` pages, or into the listed ranges (each range one output). */
export function splitPlan(pageCount: number, how: { every: number } | { ranges: string }): Plan {
  if ('every' in how) {
    if (!Number.isInteger(how.every) || how.every < 1) throw new PdfError('every needs a whole number of pages, at least 1');
    const outputs = [];
    for (let s = 0; s < pageCount; s += how.every) outputs.push({ name: `part-${outputs.length + 1}`, pages: Array.from({ length: Math.min(how.every, pageCount - s) }, (_, i) => ({ doc: 0, page: s + i })) });
    return { outputs };
  }
  return { outputs: how.ranges.split(';').map((r, i) => ({ name: `part-${i + 1}`, pages: parseRanges(r, pageCount).map((page) => ({ doc: 0, page })) })) };
}

/** One output holding every page of each document in turn. */
export const mergePlan = (pageCounts: readonly number[]): Plan => ({ outputs: [{ name: 'merged', pages: pageCounts.flatMap((n, doc) => Array.from({ length: n }, (_, page) => ({ doc, page }))) }] });

/** One output of the same document, the listed pages (default all) turned by `degrees` (a multiple of 90). */
export function rotatePlan(pageCount: number, degrees: number, ranges?: string): Plan {
  if (!Number.isInteger(degrees) || degrees % 90 !== 0) throw new PdfError('rotation is a multiple of 90 degrees');
  const turn = ((((degrees % 360) + 360) % 360) as 0 | 90 | 180 | 270);
  const chosen = new Set(ranges ? parseRanges(ranges, pageCount) : Array.from({ length: pageCount }, (_, i) => i));
  return { outputs: [{ name: 'rotated', pages: Array.from({ length: pageCount }, (_, page) => ({ doc: 0, page, rotate: chosen.has(page) ? turn : 0 })) }] };
}

/** Reads one object from text (for tests and tools): "<< /A [1 2 (x)] >>". References are returned as Ref. */
export function parseObjectText(src: string | Buffer, maxDepth = 64): Obj {
  return new Lexer(Buffer.from(src as string, 'latin1'), 0, maxDepth).object() as Obj;
}

const DROP_FROM_PAGES = new Set(['Parent', 'StructParents', 'B', 'Thumb', 'PieceInfo', 'AA', 'Metadata']);

/** Builds the files a plan describes. Encrypted sources are refused. */
export function execute(plan: Plan, docs: readonly PdfDocument[]): { name: string; pdf: Buffer }[] {
  for (const d of docs) d.refuseIfEncrypted();
  return plan.outputs.map((o) => ({ name: o.name, pdf: build(o.pages, docs) }));
}

function build(picks: readonly PagePick[], docs: readonly PdfDocument[]): Buffer {
  if (!picks.length) throw new PdfError('an output with no pages');
  const objects: Obj[] = [null, null];
  const pagesNum = 1;
  const mapping = new Map<string, number>();
  for (const p of picks) if (!docs[p.doc]?.pages()[p.page]) throw new PdfError(`no page ${p.page + 1} in document ${p.doc + 1}`);
  const copy = (di: number, o: Obj): Obj => {
    const doc = docs[di]!;
    if (o instanceof Ref) {
      const key = `${di}:${o.num}`;
      const have = mapping.get(key);
      if (have !== undefined) return new Ref(have, 0);
      const target = doc.get(o);
      // Links back to pages or the page tree would drag the whole source document along: they are cut.
      if (isDict(target) && (isName(target.get('Type'), 'Page') || isName(target.get('Type'), 'Pages'))) return null;
      const n = objects.length;
      objects.push(null);
      mapping.set(key, n);
      objects[n] = copy(di, target);
      return new Ref(n, 0);
    }
    if (Array.isArray(o)) return o.map((x) => copy(di, x));
    if (isStream(o)) return { dict: copy(di, o.dict) as Dict, raw: o.raw };
    if (isDict(o)) {
      const d: Dict = new Map();
      for (const [k, v] of o) d.set(k, copy(di, v));
      return d;
    }
    return o;
  };
  const kids: Ref[] = [];
  for (const p of picks) {
    const src = docs[p.doc]!.pages()[p.page]!;
    const d: Dict = new Map();
    for (const [k, v] of src.dict) if (!DROP_FROM_PAGES.has(k)) d.set(k, copy(p.doc, v));
    d.set('Type', new Name('Page'));
    d.set('Parent', new Ref(pagesNum, 0));
    if (p.rotate) d.set('Rotate', (src.rotate + p.rotate) % 360);
    // Annotations that point nowhere once copied (their targets were cut) are dropped.
    const annots = d.get('Annots');
    if (Array.isArray(annots)) d.set('Annots', annots.filter((a) => a !== null));
    const n = objects.length;
    objects.push(d);
    kids.push(new Ref(n, 0));
  }
  objects[pagesNum] = new Map<string, Obj>([['Type', new Name('Pages')], ['Kids', kids], ['Count', kids.length]]);
  const catalogNum = objects.length;
  objects.push(new Map<string, Obj>([['Type', new Name('Catalog')], ['Pages', new Ref(pagesNum, 0)]]));
  objects[0] = null;
  // Object numbers start at 1: slot 0 above is the free entry, slot 1 is the page tree.
  const version = docs.map((d) => d.version).sort().at(-1) ?? '1.7';
  const chunks: Buffer[] = [Buffer.from(`%PDF-${version}\n%\xe2\xe3\xcf\xd3\n`, 'latin1')];
  let len = chunks[0]!.length;
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = len;
    const b = Buffer.concat([Buffer.from(`${n} 0 obj\n`), serialize(objects[n] ?? null), Buffer.from('\nendobj\n')]);
    chunks.push(b);
    len += b.length;
  }
  const xref = len;
  const table = [`xref\n0 ${objects.length}\n0000000000 65535 f \n`, ...offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  const id = createHash('md5').update(Buffer.concat(chunks)).digest('hex');
  chunks.push(Buffer.from(`${table}trailer\n<< /Size ${objects.length} /Root ${catalogNum} 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
