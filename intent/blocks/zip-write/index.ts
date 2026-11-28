/**
 * ZIP and tar archives written, streamed and checked. ZIP follows PKWARE's APPNOTE 6.3 (local headers, data
 * descriptors for streamed entries, central directory, UTF-8 names with flag bit 11, DOS time plus the extended
 * timestamp field, Unix modes, ZIP64 for sizes or offsets of 4 GiB or more and for 65,535 or more entries), and
 * tar is POSIX.1-2001 ustar with pax extended headers for long or non-ASCII names, huge sizes and sub-second
 * times. Entries come from bytes, text or any async iterable and are written as they arrive, so a large export
 * never sits in memory: entries of known size are written with their sizes up front, streamed entries use data
 * descriptors and, unless a size hint says they are small, ZIP64-ready headers. Deflate is used unless it does not
 * help (or the name is an already-compressed type), when the bytes are stored.
 *
 * Path safety is built in: names are refused when absolute, drive-lettered, Windows-separated, holding "..",
 * control characters, NUL or empty parts, over the length limits, or colliding with another entry (also ignoring
 * case, since many systems do), and symbolic links are not written at all, so an archive made here cannot write
 * outside the folder it is unpacked into. listZip and readZipEntry read archives back (ZIP64 included), checking
 * CRC-32 and bounds, so output can be verified without another tool. Not here: encryption, multi-disk archives,
 * Zstandard or other compression methods, appending to an existing archive, or reading archives from untrusted
 * sources (docparse's unzip has the bomb limits for that).
 */
import { Readable, Transform, pipeline } from 'node:stream';
import { crc32, deflateRawSync, createDeflateRaw, inflateRawSync } from 'node:zlib';

export class UnsafePath extends Error {}
export class ArchiveError extends Error {}
export class SizeMismatch extends ArchiveError {}
export class Zip64Required extends ArchiveError {}

// ---------------------------------------------------------------- paths

export interface PathRules {
  readonly maxLength?: number;
  readonly maxDepth?: number;
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * A name made safe to store, or UnsafePath. Directories end with "/". A leading "./" is dropped; nothing else is
 * rewritten, because a name that needed rewriting to be safe is usually an attack or a mistake.
 */
export function safePath(name: string, rules: PathRules = {}): string {
  if (typeof name !== 'string' || name === '') throw new UnsafePath('an entry needs a name');
  const maxLength = rules.maxLength ?? 1024;
  let n = name.normalize('NFC');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(n)) throw new UnsafePath(`${JSON.stringify(name.slice(0, 60))} holds a control character`);
  if (n.includes('\\')) throw new UnsafePath(`${JSON.stringify(name.slice(0, 60))} uses a backslash; use / between folders`);
  if (n.startsWith('/')) throw new UnsafePath(`${JSON.stringify(name.slice(0, 60))} is an absolute path`);
  if (/^[A-Za-z]:/.test(n)) throw new UnsafePath(`${JSON.stringify(name.slice(0, 60))} starts with a drive letter`);
  while (n.startsWith('./')) n = n.slice(2);
  const dir = n.endsWith('/');
  const parts = (dir ? n.slice(0, -1) : n).split('/');
  if (parts.length > (rules.maxDepth ?? 64)) throw new UnsafePath(`${JSON.stringify(name.slice(0, 60))} is nested too deeply`);
  for (const p of parts) {
    if (p === '' || p === '.') throw new UnsafePath(`${JSON.stringify(name.slice(0, 60))} has an empty or "." part`);
    if (p === '..') throw new UnsafePath(`${JSON.stringify(name.slice(0, 60))} climbs out with ".."`);
    if (Buffer.byteLength(p) > 255) throw new UnsafePath(`a part of ${JSON.stringify(name.slice(0, 60))} is longer than 255 bytes`);
    if (/[ .]$/.test(p) || RESERVED.test(p) || /[<>:"|?*]/.test(p)) throw new UnsafePath(`${JSON.stringify(p.slice(0, 60))} is not a name every system can hold`);
  }
  const out = parts.join('/') + (dir ? '/' : '');
  if (Buffer.byteLength(out) > maxLength) throw new UnsafePath(`the name is longer than ${maxLength} bytes`);
  return out;
}

/** "report.pdf" taken: "report (1).pdf", "report (2).pdf"; comparison ignores case. */
export function uniquePath(name: string, taken: ReadonlySet<string>): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  const slash = name.lastIndexOf('/') + 1;
  const dot = name.indexOf('.', slash + 1);
  const stem = dot < 0 ? name : name.slice(0, dot);
  const ext = dot < 0 ? '' : name.slice(dot);
  for (let i = 1; ; i++) {
    const c = `${stem} (${i})${ext}`;
    if (!lower.has(c.toLowerCase())) return c;
  }
}

// ---------------------------------------------------------------- entries

export type Source = Buffer | Uint8Array | string | AsyncIterable<Buffer | Uint8Array | string> | Iterable<Buffer | Uint8Array | string>;

export interface Entry {
  readonly name: string;
  /** Absent for a folder (a name ending in "/" also means a folder). */
  readonly data?: Source;
  readonly mtime?: Date;
  /** Unix permission bits, like 0o644. */
  readonly mode?: number;
  /** For a streamed source: its size when known. ZIP uses it to decide on ZIP64; tar needs it. */
  readonly size?: number;
  readonly method?: 'auto' | 'deflate' | 'store';
  readonly comment?: string;
}

const NO_DEFLATE = /\.(zip|gz|tgz|bz2|xz|zst|7z|rar|jpe?g|png|gif|webp|avif|heic|mp3|m4a|aac|ogg|opus|flac|mp4|m4v|mov|webm|mkv|avi|pdf|docx|xlsx|pptx|odt|ods|jar|woff2?)$/i;

const bytesOf = (c: Buffer | Uint8Array | string): Buffer => (typeof c === 'string' ? Buffer.from(c, 'utf8') : Buffer.from(c.buffer, c.byteOffset, c.byteLength));
const isBytes = (d: Source): d is Buffer | Uint8Array | string => typeof d === 'string' || d instanceof Uint8Array;

async function* chunksOf(d: Source): AsyncGenerator<Buffer> {
  if (isBytes(d)) {
    yield bytesOf(d);
    return;
  }
  for await (const c of d as AsyncIterable<Buffer | Uint8Array | string>) yield bytesOf(c);
}

// ---------------------------------------------------------------- ZIP

export interface ZipOptions {
  /** auto: ZIP64 where needed; always: everywhere (for readers under test); never: refuse what needs it. */
  readonly zip64?: 'auto' | 'always' | 'never';
  /** The size at which 32-bit fields overflow, 0xFFFFFFFF; lowered only to test ZIP64 without writing gigabytes. */
  readonly zip64Threshold?: number;
  readonly comment?: string;
  readonly maxEntries?: number;
  readonly maxTotalBytes?: number;
  readonly paths?: PathRules;
  /** Used when an entry has no time. */
  readonly now?: Date;
}

export interface ZipSummary {
  readonly entries: readonly { name: string; size: number; compressed: number; crc32: number; offset: number; method: 'store' | 'deflate' }[];
  readonly zip64: boolean;
  readonly bytes: number;
}

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

/** DOS date and time, 2-second resolution, from 1980 to 2107, in UTC (zip has no zone; the UT field carries the exact time). */
export function dosTime(d: Date): { date: number; time: number } {
  const y = d.getUTCFullYear();
  if (y < 1980) return { date: (1 << 5) | 1, time: 0 };
  if (y > 2107) return { date: (127 << 9) | (12 << 5) | 31, time: (23 << 11) | (59 << 5) | 29 };
  return { date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(), time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1) };
}

const FROM_DOS = (date: number, time: number) => new Date(Date.UTC(((date >> 9) & 127) + 1980, ((date >> 5) & 15) - 1, date & 31, (time >> 11) & 31, (time >> 5) & 63, (time & 31) * 2));

interface Done {
  name: Buffer;
  rawName: string;
  flags: number;
  method: 0 | 8;
  date: number;
  time: number;
  mtimeSec: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
  zip64Local: boolean;
  mode: number;
  dir: boolean;
  comment: Buffer;
}

/**
 * Writes entries as a ZIP, yielding the archive's bytes as they are made, and returns a summary when it ends.
 * Each entry is written when it is reached; a streamed entry is read once.
 */
export async function* zipStream(entries: Iterable<Entry> | AsyncIterable<Entry>, o: ZipOptions = {}): AsyncGenerator<Buffer, ZipSummary> {
  const mode64 = o.zip64 ?? 'auto';
  const T = o.zip64Threshold ?? 0xffffffff;
  const maxEntries = o.maxEntries ?? 1_000_000;
  const now = o.now ?? new Date();
  const seen = new Set<string>();
  const done: Done[] = [];
  let pos = 0;
  let total = 0;
  const out = (b: Buffer) => {
    pos += b.length;
    return b;
  };
  for await (const e of entries as AsyncIterable<Entry>) {
    if (done.length >= maxEntries) throw new ArchiveError(`more than ${maxEntries} entries`);
    const name = safePath(e.name, o.paths);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new UnsafePath(`${name} is already in the archive (names are compared ignoring case)`);
    seen.add(key);
    const dir = name.endsWith('/');
    if (dir && e.data !== undefined) throw new ArchiveError(`${name} is a folder and cannot have content`);
    const nameBuf = Buffer.from(name, 'utf8');
    const mtime = e.mtime ?? now;
    const { date, time } = dosTime(mtime);
    const mtimeSec = Math.max(0, Math.min(0xffffffff, Math.floor(mtime.getTime() / 1000)));
    const mode = (e.mode ?? (dir ? 0o755 : 0o644)) & 0o7777;
    const comment = Buffer.from(e.comment ?? '', 'utf8');
    if (comment.length > 0xffff) throw new ArchiveError('an entry comment is longer than 65535 bytes');
    const base = { name: nameBuf, rawName: name, date, time, mtimeSec, mode, dir, comment };
    const ut = Buffer.concat([u16(0x5455), u16(5), Buffer.from([1]), u32(mtimeSec)]);
    const known: Buffer | undefined = dir ? Buffer.alloc(0) : e.data !== undefined && isBytes(e.data) ? bytesOf(e.data) : undefined;

    if (known) {
      // Size known: compress in memory, then write the header with the real CRC and sizes. No data descriptor.
      const wantDeflate = e.method === 'deflate' || (e.method !== 'store' && !NO_DEFLATE.test(name) && known.length > 0);
      let body = known;
      let method: 0 | 8 = 0;
      if (wantDeflate) {
        const d = deflateRawSync(known);
        if (d.length < known.length || e.method === 'deflate') {
          body = d;
          method = 8;
        }
      }
      const crc = crc32(known);
      const big = mode64 === 'always' || known.length >= T || body.length >= T || pos >= T;
      if (big && mode64 === 'never') throw new Zip64Required(`${name} needs ZIP64 and it is turned off`);
      const offset = pos;
      const z64 = big;
      const extra = Buffer.concat([ut, ...(z64 ? [Buffer.concat([u16(1), u16(16), u64(known.length), u64(body.length)])] : [])]);
      yield out(Buffer.concat([u32(0x04034b50), u16(z64 ? 45 : 20), u16(0x0800), u16(method), u16(time), u16(date), u32(crc), u32(z64 ? 0xffffffff : body.length), u32(z64 ? 0xffffffff : known.length), u16(nameBuf.length), u16(extra.length), nameBuf, extra]));
      if (body.length) yield out(body);
      total += known.length;
      if (o.maxTotalBytes !== undefined && total > o.maxTotalBytes) throw new ArchiveError(`the archive would hold more than ${o.maxTotalBytes} bytes`);
      done.push({ ...base, flags: 0x0800, method, crc, csize: body.length, usize: known.length, offset, zip64Local: z64 });
      continue;
    }

    // Streamed: the sizes are unknown until the end, so they follow the data in a descriptor.
    const hint = e.size;
    const z64 = mode64 === 'always' || (mode64 === 'auto' && (hint === undefined || hint >= T / 2)) || pos >= T;
    const offset = pos;
    const extra = Buffer.concat([ut, ...(z64 ? [Buffer.concat([u16(1), u16(16), u64(0), u64(0)])] : [])]);
    const method: 0 | 8 = e.method === 'store' || (e.method !== 'deflate' && NO_DEFLATE.test(name)) ? 0 : 8;
    yield out(Buffer.concat([u32(0x04034b50), u16(z64 ? 45 : 20), u16(0x0808), u16(method), u16(time), u16(date), u32(0), u32(z64 ? 0xffffffff : 0), u32(z64 ? 0xffffffff : 0), u16(nameBuf.length), u16(extra.length), nameBuf, extra]));
    let crc = 0;
    let usize = 0;
    let csize = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        crc = crc32(chunk, crc);
        usize += chunk.length;
        cb(null, chunk);
      },
    });
    const chain = method === 8 ? pipeline(Readable.from(chunksOf(e.data!), { objectMode: false }), tap, createDeflateRaw(), () => undefined) : pipeline(Readable.from(chunksOf(e.data!), { objectMode: false }), tap, () => undefined);
    for await (const c of chain as AsyncIterable<Buffer>) {
      csize += c.length;
      yield out(c);
    }
    if (!z64 && (usize >= T || csize >= T)) throw new Zip64Required(`${name} grew past 4 GiB; give a size hint or allow ZIP64 so its header is written for it`);
    if (mode64 === 'never' && (usize >= T || csize >= T)) throw new Zip64Required(`${name} needs ZIP64 and it is turned off`);
    if (hint !== undefined && hint !== usize) throw new SizeMismatch(`${name}: the size hint was ${hint} but ${usize} bytes arrived`);
    yield out(Buffer.concat([u32(0x08074b50), u32(crc), z64 ? Buffer.concat([u64(csize), u64(usize)]) : Buffer.concat([u32(csize), u32(usize)])]));
    total += usize;
    if (o.maxTotalBytes !== undefined && total > o.maxTotalBytes) throw new ArchiveError(`the archive would hold more than ${o.maxTotalBytes} bytes`);
    done.push({ ...base, flags: 0x0808, method, crc, csize, usize, offset, zip64Local: z64 });
  }

  // Central directory.
  const cdStart = pos;
  for (const d of done) {
    const over = { usize: d.usize >= T || mode64 === 'always', csize: d.csize >= T || mode64 === 'always', offset: d.offset >= T || mode64 === 'always' };
    const z: Buffer[] = [];
    if (over.usize) z.push(u64(d.usize));
    if (over.csize) z.push(u64(d.csize));
    if (over.offset) z.push(u64(d.offset));
    const zextra = z.length ? Buffer.concat([u16(1), u16(z.length * 8), ...z]) : Buffer.alloc(0);
    const ut = Buffer.concat([u16(0x5455), u16(5), Buffer.from([1]), u32(d.mtimeSec)]);
    const extra = Buffer.concat([ut, zextra]);
    const need = z.length || d.zip64Local ? 45 : 20;
    const attrs = ((d.dir ? 0o040000 : 0o100000) | d.mode) * 0x10000 + (d.dir ? 0x10 : 0);
    yield out(Buffer.concat([u32(0x02014b50), u16((3 << 8) | 45), u16(need), u16(d.flags), u16(d.method), u16(d.time), u16(d.date), u32(d.crc), u32(over.csize ? 0xffffffff : d.csize), u32(over.usize ? 0xffffffff : d.usize), u16(d.name.length), u16(extra.length), u16(d.comment.length), u16(0), u16(0), u32(attrs >>> 0), u32(over.offset ? 0xffffffff : d.offset), d.name, extra, d.comment]));
  }
  const cdSize = pos - cdStart;
  const zipComment = Buffer.from(o.comment ?? '', 'utf8');
  if (zipComment.length > 0xffff) throw new ArchiveError('the archive comment is longer than 65535 bytes');
  const needEnd64 = mode64 === 'always' || done.length >= 0xffff || cdStart >= T || cdSize >= T;
  if (needEnd64 && mode64 === 'never') throw new Zip64Required('the archive needs ZIP64 and it is turned off');
  if (needEnd64) {
    const z64pos = pos;
    yield out(Buffer.concat([u32(0x06064b50), u64(44), u16((3 << 8) | 45), u16(45), u32(0), u32(0), u64(done.length), u64(done.length), u64(cdSize), u64(cdStart)]));
    yield out(Buffer.concat([u32(0x07064b50), u32(0), u64(z64pos), u32(1)]));
  }
  yield out(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(needEnd64 ? 0xffff : done.length), u16(needEnd64 ? 0xffff : done.length), u32(needEnd64 ? 0xffffffff : cdSize), u32(needEnd64 ? 0xffffffff : cdStart), u16(zipComment.length), zipComment]));
  return { entries: done.map((d) => ({ name: d.rawName, size: d.usize, compressed: d.csize, crc32: d.crc, offset: d.offset, method: d.method === 8 ? ('deflate' as const) : ('store' as const) })), zip64: needEnd64 || done.some((d) => d.zip64Local), bytes: pos };
}

/** Collects an archive into one buffer, for small archives and for tests. */
export async function collect(gen: AsyncGenerator<Buffer, unknown>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) break;
    parts.push(r.value);
  }
  return Buffer.concat(parts);
}

export const zipBuffer = (entries: Iterable<Entry> | AsyncIterable<Entry>, o: ZipOptions = {}): Promise<Buffer> => collect(zipStream(entries, o));

// ---------------------------------------------------------------- reading back

export interface ZipEntryInfo {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly offset: number;
  readonly mode: number;
  readonly mtime: Date;
  readonly dir: boolean;
}

/** The entries of a ZIP from its central directory, reading ZIP64 where present. Throws ArchiveError when damaged. */
export function listZip(buf: Buffer): { entries: ZipEntryInfo[]; zip64: boolean; comment: string } {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new ArchiveError('no end-of-central-directory record');
  let count = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  const commentLen = buf.readUInt16LE(eocd + 20);
  if (eocd + 22 + commentLen !== buf.length) throw new ArchiveError('the archive comment does not end the file');
  let zip64 = false;
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || buf.readUInt32LE(loc) !== 0x07064b50) throw new ArchiveError('ZIP64 is signalled but the locator is missing');
    const z = Number(buf.readBigUInt64LE(loc + 8));
    if (z + 56 > buf.length || buf.readUInt32LE(z) !== 0x06064b50) throw new ArchiveError('the ZIP64 end record is missing');
    count = Number(buf.readBigUInt64LE(z + 32));
    cdSize = Number(buf.readBigUInt64LE(z + 40));
    cdOffset = Number(buf.readBigUInt64LE(z + 48));
    zip64 = true;
  }
  if (cdOffset + cdSize > buf.length) throw new ArchiveError('the central directory is outside the file');
  const entries: ZipEntryInfo[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ArchiveError('the central directory is damaged');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12);
    const date = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38);
    let offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString((flags & 0x0800) !== 0 ? 'utf8' : 'latin1');
    let mtime = FROM_DOS(date, time);
    for (let x = p + 46 + nlen, end = x + xlen; x + 4 <= end; ) {
      const id = buf.readUInt16LE(x);
      const len = buf.readUInt16LE(x + 2);
      if (x + 4 + len > end) throw new ArchiveError('an extra field runs past its entry');
      let q = x + 4;
      if (id === 1) {
        if (usize === 0xffffffff) {
          usize = Number(buf.readBigUInt64LE(q));
          q += 8;
        }
        if (csize === 0xffffffff) {
          csize = Number(buf.readBigUInt64LE(q));
          q += 8;
        }
        if (offset === 0xffffffff) offset = Number(buf.readBigUInt64LE(q));
      } else if (id === 0x5455 && (buf[q]! & 1) !== 0) mtime = new Date(buf.readUInt32LE(q + 1) * 1000);
      x += 4 + len;
    }
    entries.push({ name, method, flags, crc32: crc, compressedSize: csize, uncompressedSize: usize, offset, mode: (attrs >>> 16) & 0o7777, mtime, dir: name.endsWith('/') });
    p += 46 + nlen + xlen + clen;
  }
  return { entries, zip64, comment: buf.subarray(eocd + 22).toString('utf8') };
}

/** The bytes of one entry, inflated and checked against its CRC-32 and size. */
export function readZipEntry(buf: Buffer, e: ZipEntryInfo): Buffer {
  const p = e.offset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw new ArchiveError(`${e.name}: no local header at its offset`);
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const raw = buf.subarray(start, start + e.compressedSize);
  if (raw.length !== e.compressedSize) throw new ArchiveError(`${e.name}: the data runs past the end of the file`);
  const data = e.method === 0 ? raw : e.method === 8 ? inflateRawSync(raw) : (() => { throw new ArchiveError(`${e.name}: unsupported method ${e.method}`); })();
  if (data.length !== e.uncompressedSize) throw new ArchiveError(`${e.name}: the size is ${data.length}, the directory says ${e.uncompressedSize}`);
  if (crc32(data) !== e.crc32) throw new ArchiveError(`${e.name}: the CRC-32 does not match`);
  return data;
}

// ---------------------------------------------------------------- tar

export interface TarOptions {
  readonly now?: Date;
  readonly paths?: PathRules;
  /** The largest streamed entry buffered when its size is not given. */
  readonly maxBuffer?: number;
  readonly uid?: number;
  readonly gid?: number;
  readonly uname?: string;
  readonly gname?: string;
}

const octal = (n: number, width: number): Buffer => {
  const s = n.toString(8).padStart(width - 1, '0');
  if (s.length > width - 1) throw new ArchiveError(`${n} does not fit in ${width - 1} octal digits`);
  return Buffer.from(`${s}\0`, 'latin1');
};

function pax(records: Readonly<Record<string, string>>): Buffer {
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(records)) {
    const body = Buffer.from(` ${k}=${v}\n`, 'utf8');
    // The length counts its own digits.
    let len = body.length + 1;
    while (String(len).length + body.length !== len) len = String(len).length + body.length;
    parts.push(Buffer.from(String(len), 'ascii'), body);
  }
  return Buffer.concat(parts);
}

function header(o: { name: string; prefix?: string; mode: number; uid: number; gid: number; size: number; mtime: number; type: string; uname: string; gname: string }): Buffer {
  const h = Buffer.alloc(512);
  h.write(o.name, 0, 100, 'latin1');
  octal(o.mode, 8).copy(h, 100);
  octal(o.uid, 8).copy(h, 108);
  octal(o.gid, 8).copy(h, 116);
  octal(o.size, 12).copy(h, 124);
  octal(o.mtime, 12).copy(h, 136);
  h.fill(0x20, 148, 156);
  h.write(o.type, 156, 1, 'latin1');
  h.write('ustar\0', 257, 6, 'latin1');
  h.write('00', 263, 2, 'latin1');
  h.write(o.uname, 265, 32, 'latin1');
  h.write(o.gname, 297, 32, 'latin1');
  if (o.prefix) h.write(o.prefix, 345, 155, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return h;
}

const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512);
const ASCII = /^[\x20-\x7e]*$/;

/** The ustar name and prefix for a path, or null when it needs a pax header. */
function splitName(name: string): { name: string; prefix: string } | null {
  if (name.length <= 100 && ASCII.test(name)) return { name, prefix: '' };
  if (!ASCII.test(name)) return null;
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
  for (let i = trimmed.lastIndexOf('/'); i > 0; i = trimmed.lastIndexOf('/', i - 1)) {
    const prefix = trimmed.slice(0, i);
    const rest = name.slice(i + 1);
    if (prefix.length <= 155 && rest.length <= 100) return { name: rest, prefix };
  }
  return null;
}

/** Writes entries as a POSIX tar (pax for what ustar cannot hold). Streamed entries need `size`, or are buffered up to maxBuffer. */
export async function* tarStream(entries: Iterable<Entry> | AsyncIterable<Entry>, o: TarOptions = {}): AsyncGenerator<Buffer> {
  const seen = new Set<string>();
  const now = o.now ?? new Date();
  const maxBuffer = o.maxBuffer ?? 64 * 1024 * 1024;
  for await (const e of entries as AsyncIterable<Entry>) {
    const name = safePath(e.name, o.paths);
    if (seen.has(name.toLowerCase())) throw new UnsafePath(`${name} is already in the archive (names are compared ignoring case)`);
    seen.add(name.toLowerCase());
    const dir = name.endsWith('/');
    if (dir && e.data !== undefined) throw new ArchiveError(`${name} is a folder and cannot have content`);
    const mtimeMs = (e.mtime ?? now).getTime();
    const mtime = Math.max(0, Math.floor(mtimeMs / 1000));
    let body: Source | undefined = e.data;
    let size = dir ? 0 : e.size;
    if (!dir && size === undefined) {
      if (e.data !== undefined && isBytes(e.data)) size = bytesOf(e.data).length;
      else {
        const parts: Buffer[] = [];
        let n = 0;
        for await (const c of chunksOf(e.data ?? '')) {
          n += c.length;
          if (n > maxBuffer) throw new ArchiveError(`${name} is larger than ${maxBuffer} bytes and has no size to stream by; pass size`);
          parts.push(c);
        }
        body = Buffer.concat(parts);
        size = n;
      }
    }
    const sz = size ?? 0;
    const records: Record<string, string> = {};
    const split = splitName(name);
    if (!split) records.path = name;
    if (sz > 0o77777777777) records.size = String(sz);
    if (mtimeMs % 1000 !== 0) records.mtime = (mtimeMs / 1000).toFixed(3);
    const uname = o.uname ?? '';
    const gname = o.gname ?? '';
    if (!ASCII.test(uname) || !ASCII.test(gname)) throw new ArchiveError('user and group names must be ASCII');
    const stub = (split?.name ?? name.slice(0, 100).replace(/[^\x20-\x7e]/g, '_'));
    if (Object.keys(records).length) {
      const p = pax(records);
      yield header({ name: `PaxHeader/${stub}`.slice(0, 100), mode: 0o644, uid: 0, gid: 0, size: p.length, mtime, type: 'x', uname: '', gname: '' });
      yield p;
      yield pad(p.length);
    }
    yield header({ name: split?.name ?? stub, ...(split?.prefix ? { prefix: split.prefix } : {}), mode: (e.mode ?? (dir ? 0o755 : 0o644)) & 0o7777, uid: o.uid ?? 0, gid: o.gid ?? 0, size: Math.min(sz, 0o77777777777), mtime, type: dir ? '5' : '0', uname, gname });
    if (!dir) {
      let n = 0;
      for await (const c of chunksOf(body ?? '')) {
        n += c.length;
        if (n > sz) throw new SizeMismatch(`${name}: more than the declared ${sz} bytes arrived`);
        yield c;
      }
      if (n !== sz) throw new SizeMismatch(`${name}: declared ${sz} bytes but ${n} arrived`);
      yield pad(sz);
    }
  }
  yield Buffer.alloc(1024);
}

export const tarBuffer = async (entries: Iterable<Entry> | AsyncIterable<Entry>, o: TarOptions = {}): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const c of tarStream(entries, o)) parts.push(c);
  return Buffer.concat(parts);
};

export interface TarEntryInfo {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly mode: number;
  readonly mtime: number;
  readonly data: Buffer;
}

/** Reads a tar made here or by GNU tar's pax format (ustar, prefix, and pax path, size and mtime), verifying header checksums. */
export function listTar(buf: Buffer): TarEntryInfo[] {
  const out: TarEntryInfo[] = [];
  let p = 0;
  let paxRec: Record<string, string> = {};
  while (p + 512 <= buf.length) {
    const h = buf.subarray(p, p + 512);
    if (h.every((b) => b === 0)) break;
    const field = (a: number, b: number) => {
      const s = h.subarray(a, b);
      const z = s.indexOf(0);
      return s.subarray(0, z < 0 ? s.length : z).toString('latin1');
    };
    const sum = parseInt(field(148, 156).trim() || '0', 8);
    let calc = 0;
    for (let i = 0; i < 512; i++) calc += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (sum !== calc) throw new ArchiveError(`the checksum of the header at ${p} is wrong`);
    const type = field(156, 157) || '0';
    let size = parseInt(field(124, 136).trim() || '0', 8);
    if (paxRec.size) size = Number(paxRec.size);
    const dataStart = p + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    if (data.length !== size) throw new ArchiveError('the archive ends inside an entry');
    p = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      paxRec = {};
      let q = 0;
      while (q < data.length) {
        const sp = data.indexOf(0x20, q);
        const len = Number(data.subarray(q, sp).toString());
        const rec = data.subarray(sp + 1, q + len - 1).toString('utf8');
        const eq = rec.indexOf('=');
        paxRec[rec.slice(0, eq)] = rec.slice(eq + 1);
        q += len;
      }
      continue;
    }
    const prefix = field(345, 500);
    const name = paxRec.path ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    out.push({ name: type === '5' && !name.endsWith('/') ? `${name}/` : name, type, size, mode: parseInt(field(100, 108).trim() || '0', 8), mtime: paxRec.mtime ? Number(paxRec.mtime) : parseInt(field(136, 148).trim() || '0', 8), data });
    paxRec = {};
  }
  return out;
}
