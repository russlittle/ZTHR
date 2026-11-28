/**
 * Content-defined chunking and a deduplicating chunk store, for backups and sync. A file is cut into chunks where
 * its own bytes say to (FastCDC: a gear hash over a 32-byte window, with a stricter test before the average size
 * and a looser one after, so sizes stay close to the average between a minimum and a maximum), so inserting or
 * deleting bytes early in a file moves only the chunks around the edit and every other chunk keeps its identity.
 * Each chunk is stored once, under its SHA-256 (or an HMAC-SHA-256 when a hash key is set, so a store cannot be
 * asked "do you hold this known file?"), in an `objects` store; a manifest of chunk ids is the file. Reading
 * verifies every chunk against its id before returning it, ranges read only the chunks they cover, and deleting a
 * file releases its chunks and removes those nothing else uses. A chunk written for a file that never committed is
 * swept after a grace period. `plan` says which chunks a peer lacks, so a sync sends only those.
 *
 * Boundaries are derived from a gear table seeded by name (and an optional salt): two deployments with the same
 * seed agree on chunks, and a private salt stops an outsider predicting boundaries. The clock is an argument.
 * Out of scope: compression and encryption of chunks (layer them on the objects store), erasure coding, and
 * variable-size packing of small chunks into packs.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readAll } from '../objects/index.ts';
import type { ObjectStore, Range } from '../objects/index.ts';

export class ChunkError extends Error {}

export interface ChunkParams {
  readonly min: number;
  readonly avg: number;
  readonly max: number;
  /** Mixed into the gear table so boundaries cannot be predicted without it. */
  readonly salt?: string;
}

export const DEFAULT_PARAMS: ChunkParams = { min: 2048, avg: 8192, max: 65536 };

function checkParams(p: ChunkParams): void {
  if (!Number.isInteger(p.min) || !Number.isInteger(p.avg) || !Number.isInteger(p.max)) throw new ChunkError('chunk sizes must be whole numbers');
  if (p.min < 64) throw new ChunkError('the minimum chunk size must be at least 64 bytes (the hash window is 32)');
  if (!(p.min < p.avg && p.avg < p.max)) throw new ChunkError('chunk sizes must satisfy min < avg < max');
  if (p.max > 16 * 1024 * 1024) throw new ChunkError('the maximum chunk size is 16 MiB');
  if (Math.round(Math.log2(p.avg)) < 6) throw new ChunkError('the average chunk size is too small');
}

const tables = new Map<string, Uint32Array>();
function gearTable(salt = ''): Uint32Array {
  let t = tables.get(salt);
  if (!t) {
    t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) t[i] = createHash('sha256').update(`content-chunking/gear/${salt}/${i}`).digest().readUInt32BE(0);
    tables.set(salt, t);
  }
  return t;
}

const topBits = (n: number) => (n <= 0 ? 0 : n >= 32 ? 0xffffffff : (((1 << n) - 1) << (32 - n)) >>> 0);

/** Length of the first chunk of `data` (which holds at most `max` bytes unless the stream has ended earlier). */
export function cutPoint(data: Uint8Array, p: ChunkParams = DEFAULT_PARAMS): number {
  const gear = gearTable(p.salt);
  const n = Math.min(data.length, p.max);
  if (n <= p.min) return n;
  const bits = Math.round(Math.log2(p.avg));
  const maskS = topBits(bits + 2);
  const maskL = topBits(bits - 2);
  const normal = Math.min(p.avg, n);
  let fp = 0;
  let i = p.min - 32; // warm the window; the 32 bytes before min decide the first possible cut as they would anywhere
  if (i < 0) i = 0;
  for (; i < p.min; i++) fp = ((fp << 1) + gear[data[i]!]!) >>> 0;
  for (; i < normal; i++) {
    fp = ((fp << 1) + gear[data[i]!]!) >>> 0;
    if ((fp & maskS) === 0) return i + 1;
  }
  for (; i < n; i++) {
    fp = ((fp << 1) + gear[data[i]!]!) >>> 0;
    if ((fp & maskL) === 0) return i + 1;
  }
  return n;
}

/** Splits a whole buffer into chunks (lengths) with the same rule the streaming chunker uses. */
export function chunkLengths(data: Uint8Array, p: ChunkParams = DEFAULT_PARAMS): number[] {
  checkParams(p);
  const out: number[] = [];
  for (let at = 0; at < data.length; ) {
    const len = cutPoint(data.subarray(at, at + p.max), p);
    out.push(len);
    at += len;
  }
  return out;
}

/** A streaming chunker: push bytes as they arrive, collect finished chunks, call `end` for the last one. */
export class Chunker {
  private buf = Buffer.alloc(0);
  private readonly p: ChunkParams;
  constructor(p: ChunkParams = DEFAULT_PARAMS) {
    checkParams(p);
    this.p = p;
  }
  push(bytes: Uint8Array): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, bytes]) : Buffer.from(bytes);
    const out: Buffer[] = [];
    let at = 0;
    while (this.buf.length - at >= this.p.max) {
      const len = cutPoint(this.buf.subarray(at, at + this.p.max), this.p);
      out.push(Buffer.from(this.buf.subarray(at, at + len)));
      at += len;
    }
    this.buf = this.buf.subarray(at);
    return out;
  }
  end(): Buffer[] {
    const out: Buffer[] = [];
    let at = 0;
    while (at < this.buf.length) {
      const len = cutPoint(this.buf.subarray(at, at + this.p.max), this.p);
      out.push(Buffer.from(this.buf.subarray(at, at + len)));
      at += len;
    }
    this.buf = Buffer.alloc(0);
    return out;
  }
}

// --- the store -------------------------------------------------------------------------------------------------------

export interface ChunkRef {
  /** Hex chunk id. */
  readonly id: string;
  readonly size: number;
}

export interface Manifest {
  readonly name: string;
  readonly size: number;
  /** Hex digest of the whole content (same hash as chunk ids). */
  readonly digest: string;
  readonly chunks: readonly ChunkRef[];
  readonly params: ChunkParams;
}

export interface IndexEntry {
  readonly key: string;
  readonly size: number;
  refs: number;
  readonly createdAt: number;
}

/** Where the chunk id → stored object map lives: memory here, a database in production. */
export interface ChunkIndex {
  get(id: string): IndexEntry | undefined;
  set(id: string, e: IndexEntry): void;
  delete(id: string): void;
  entries(): Iterable<[string, IndexEntry]>;
}

export function memoryIndex(): ChunkIndex {
  const m = new Map<string, IndexEntry>();
  return { get: (id) => m.get(id), set: (id, e) => void m.set(id, e), delete: (id) => void m.delete(id), entries: () => m.entries() };
}

export interface ChunkStoreOptions {
  readonly objects: ObjectStore;
  readonly index?: ChunkIndex;
  readonly params?: ChunkParams;
  /** Makes chunk ids HMACs, so the store cannot be asked about known content. */
  readonly hashKey?: Uint8Array;
  readonly now?: () => number;
  /** Largest file accepted (default 64 GiB). */
  readonly maxBytes?: number;
}

export interface Stats {
  /** Sum of file sizes. */
  readonly logicalBytes: number;
  /** Bytes of chunks in use. */
  readonly storedBytes: number;
  readonly files: number;
  readonly chunkRefs: number;
  readonly uniqueChunks: number;
  /** logicalBytes / storedBytes (1 when empty). */
  readonly ratio: number;
  readonly savedBytes: number;
  /** Chunks written but not (yet) in any file. */
  readonly orphanChunks: number;
}

export class ChunkStore {
  private readonly o: ChunkStoreOptions;
  private readonly index: ChunkIndex;
  private readonly params: ChunkParams;
  private readonly files = new Map<string, Manifest>();
  private readonly now: () => number;

  constructor(o: ChunkStoreOptions) {
    this.o = o;
    this.index = o.index ?? memoryIndex();
    this.params = o.params ?? DEFAULT_PARAMS;
    checkParams(this.params);
    this.now = o.now ?? Date.now;
  }

  /** The id of a chunk of bytes. */
  chunkId(b: Uint8Array): string {
    return this.o.hashKey ? createHmac('sha256', this.o.hashKey).update(b).digest('hex') : createHash('sha256').update(b).digest('hex');
  }

  /**
   * Chunks a stream and stores each new chunk once. The file exists (and holds its chunks) only after this
   * returns, so a failure part-way leaves unreferenced chunks for `sweep`, never a half-written file.
   */
  async put(name: string, source: AsyncIterable<Uint8Array> | Uint8Array): Promise<Manifest> {
    if (this.files.has(name)) throw new ChunkError(`${name} already exists`);
    const chunker = new Chunker(this.params);
    const whole = this.o.hashKey ? createHmac('sha256', this.o.hashKey) : createHash('sha256');
    const refs: ChunkRef[] = [];
    const max = this.o.maxBytes ?? 64 * 1024 ** 3;
    let size = 0;
    const take = async (chunks: Buffer[]) => {
      for (const c of chunks) {
        const id = this.chunkId(c);
        if (!this.index.get(id)) {
          const w = await this.o.objects.put(c, { algos: ['SHA256'] });
          this.index.set(id, { key: w.key, size: c.length, refs: 0, createdAt: this.now() });
        }
        refs.push({ id, size: c.length });
      }
    };
    const feed = async (b: Uint8Array) => {
      size += b.length;
      if (size > max) throw new ChunkError(`more than ${max} bytes`);
      whole.update(b);
      await take(chunker.push(b));
    };
    if (source instanceof Uint8Array) await feed(source);
    else for await (const b of source) await feed(b);
    await take(chunker.end());
    const m: Manifest = { name, size, digest: whole.digest('hex'), chunks: refs, params: this.params };
    for (const r of refs) this.index.get(r.id)!.refs++;
    this.files.set(name, m);
    return m;
  }

  manifest(name: string): Manifest | undefined {
    return this.files.get(name);
  }

  has(chunkId: string): boolean {
    return this.index.get(chunkId) !== undefined;
  }

  /** Streams a file, or a byte range of it, reading only the chunks that cover it and checking each one's id. */
  async *read(name: string, range?: Range): AsyncGenerator<Uint8Array> {
    const m = this.files.get(name);
    if (!m) throw new ChunkError(`no file ${name}`);
    const start = range?.start ?? 0;
    const end = range?.end ?? m.size - 1;
    if (m.size === 0) return;
    if (start < 0 || end < start || end >= m.size) throw new ChunkError('the range is outside the file');
    let at = 0;
    for (const c of m.chunks) {
      const cs = at;
      const ce = at + c.size - 1;
      at += c.size;
      if (ce < start) continue;
      if (cs > end) break;
      const e = this.index.get(c.id);
      if (!e) throw new ChunkError(`chunk ${c.id} is missing`);
      const bytes = await readAll(await this.o.objects.get(e.key));
      const got = Buffer.from(this.chunkId(bytes), 'hex');
      const want = Buffer.from(c.id, 'hex');
      if (bytes.length !== c.size || got.length !== want.length || !timingSafeEqual(got, want)) throw new ChunkError(`chunk ${c.id} does not match its id: the stored bytes are damaged`);
      yield bytes.subarray(Math.max(0, start - cs), Math.min(c.size, end - cs + 1));
    }
  }

  async readAll(name: string, range?: Range): Promise<Buffer> {
    const parts: Uint8Array[] = [];
    for await (const b of this.read(name, range)) parts.push(b);
    return Buffer.concat(parts);
  }

  /** Removes a file and every chunk no other file uses. Returns the bytes freed. */
  async delete(name: string): Promise<number> {
    const m = this.files.get(name);
    if (!m) return 0;
    this.files.delete(name);
    let freed = 0;
    for (const r of m.chunks) {
      const e = this.index.get(r.id);
      if (!e) continue;
      e.refs--;
      if (e.refs <= 0) {
        await this.o.objects.delete(e.key);
        this.index.delete(r.id);
        freed += e.size;
      }
    }
    return freed;
  }

  /** Deletes chunks that no file holds and that are older than the grace period (a put in progress is younger). */
  async sweep(graceMs = 3_600_000): Promise<{ removed: number; bytes: number }> {
    const cutoff = this.now() - graceMs;
    let removed = 0;
    let bytes = 0;
    for (const [id, e] of [...this.index.entries()])
      if (e.refs <= 0 && e.createdAt <= cutoff) {
        await this.o.objects.delete(e.key);
        this.index.delete(id);
        removed++;
        bytes += e.size;
      }
    return { removed, bytes };
  }

  /** Reads every stored chunk and returns the ids whose bytes no longer match. */
  async verify(): Promise<string[]> {
    const bad: string[] = [];
    for (const [id, e] of [...this.index.entries()]) {
      try {
        const b = await readAll(await this.o.objects.get(e.key));
        if (this.chunkId(b) !== id) bad.push(id);
      } catch {
        bad.push(id);
      }
    }
    return bad;
  }

  stats(): Stats {
    let logical = 0;
    let chunkRefs = 0;
    for (const m of this.files.values()) {
      logical += m.size;
      chunkRefs += m.chunks.length;
    }
    let stored = 0;
    let unique = 0;
    let orphan = 0;
    for (const [, e] of this.index.entries()) {
      if (e.refs > 0) {
        stored += e.size;
        unique++;
      } else orphan++;
    }
    return { logicalBytes: logical, storedBytes: stored, files: this.files.size, chunkRefs, uniqueChunks: unique, ratio: stored === 0 ? 1 : logical / stored, savedBytes: logical - stored, orphanChunks: orphan };
  }
}

/** What a sync must send: the distinct chunks of a manifest the peer does not have, and what it saves. */
export function plan(m: Manifest, peerHas: (chunkId: string) => boolean): { send: ChunkRef[]; sendBytes: number; skipBytes: number } {
  const seen = new Set<string>();
  const send: ChunkRef[] = [];
  let sendBytes = 0;
  for (const c of m.chunks) {
    if (seen.has(c.id) || peerHas(c.id)) continue;
    seen.add(c.id);
    send.push(c);
    sendBytes += c.size;
  }
  return { send, sendBytes, skipBytes: m.size - sendBytes };
}

/** How two versions of a file relate chunk by chunk: shared, only in the old, only in the new. */
export function compare(a: Manifest, b: Manifest): { shared: number; onlyOld: number; onlyNew: number; sharedBytes: number; newBytes: number } {
  const old = new Set(a.chunks.map((c) => c.id));
  const cur = new Set(b.chunks.map((c) => c.id));
  let shared = 0;
  let sharedBytes = 0;
  let newBytes = 0;
  const done = new Set<string>();
  for (const c of b.chunks) {
    if (old.has(c.id)) {
      shared++;
      sharedBytes += c.size;
    } else if (!done.has(c.id)) newBytes += c.size;
    done.add(c.id);
  }
  return { shared, onlyOld: [...old].filter((x) => !cur.has(x)).length, onlyNew: [...cur].filter((x) => !old.has(x)).length, sharedBytes, newBytes };
}
