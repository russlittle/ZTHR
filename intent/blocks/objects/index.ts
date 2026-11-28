/**
 * An object store for file bytes: write a stream once and get back its size and checksums computed on the way
 * through, read all of it or a byte range, and join stored parts into one object without passing the bytes back
 * through the caller. Keys are random, never derived from names, so a rename never touches the bytes.
 *
 * The interface is small enough for memory, a local folder or a cloud bucket. A bucket that can compose objects
 * server-side does the join itself; the rest join by streaming.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type Algo = 'MD5' | 'SHA1' | 'SHA256' | 'ADLER32';

export interface Written {
  readonly key: string;
  readonly size: number;
  /** "ALGO:hex" for each algorithm asked for. */
  readonly checksums: readonly string[];
}

export interface Range {
  readonly start: number;
  /** Inclusive, as HTTP counts it. */
  readonly end: number;
}

export interface ObjectStore {
  put(data: AsyncIterable<Uint8Array> | Uint8Array, o?: { algos?: readonly Algo[]; maxBytes?: number }): Promise<Written>;
  get(key: string, range?: Range): Promise<AsyncIterable<Uint8Array>>;
  size(key: string): Promise<number | undefined>;
  delete(key: string): Promise<void>;
  /** One new object holding the parts in order; the parts stay until deleted. */
  compose(keys: readonly string[]): Promise<Written>;
}

export class TooLarge extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`more than ${limit} bytes`);
    this.limit = limit;
  }
}

export class Missing extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`no object ${key}`);
    this.key = key;
  }
}

/** Adler-32, which some clients send alongside the stronger hashes. */
export class Adler32 {
  private a = 1;
  private b = 0;
  update(chunk: Uint8Array): this {
    let a = this.a;
    let b = this.b;
    for (let i = 0; i < chunk.length; ) {
      const end = Math.min(chunk.length, i + 3800);
      for (; i < end; i++) {
        a += chunk[i]!;
        b += a;
      }
      a %= 65521;
      b %= 65521;
    }
    this.a = a;
    this.b = b;
    return this;
  }
  hex(): string {
    return (((this.b << 16) | this.a) >>> 0).toString(16).padStart(8, '0');
  }
}

/** Hashes a stream as it passes, without holding it. */
export class Digest {
  private readonly hashes: { algo: Algo; h: { update(c: Uint8Array): unknown; digest?(e: 'hex'): string; hex?(): string } }[];
  size = 0;
  constructor(algos: readonly Algo[]) {
    this.hashes = algos.map((algo) => ({ algo, h: algo === 'ADLER32' ? new Adler32() : createHash(algo === 'SHA1' ? 'sha1' : algo === 'SHA256' ? 'sha256' : 'md5') }));
  }
  update(c: Uint8Array): void {
    this.size += c.length;
    for (const x of this.hashes) x.h.update(c);
  }
  result(): string[] {
    return this.hashes.map((x) => `${x.algo}:${x.algo === 'ADLER32' ? (x.h as Adler32).hex() : (x.h as { digest(e: 'hex'): string }).digest('hex')}`);
  }
}

/** Parses a checksum header ("SHA1:abc" or "MD5:x SHA256:y"): unknown algorithms are ignored, not refused. */
export function parseChecksums(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter((x) => /^(MD5|SHA1|SHA256|SHA3-256|ADLER32):[0-9a-fA-F]+$/i.test(x))
    .map((x) => {
      const [a, h] = x.split(':');
      return `${a!.toUpperCase()}:${h!.toLowerCase()}`;
    });
}

/**
 * One HTTP byte range against an object of `size` bytes. Returns null for a header that asks for something
 * other than a single satisfiable range, so the caller sends the whole object or a 416.
 */
export function parseRange(header: string | null | undefined, size: number): Range | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

async function* once(b: Uint8Array): AsyncIterable<Uint8Array> {
  yield b;
}

async function* limit(src: AsyncIterable<Uint8Array>, d: Digest, max: number | undefined): AsyncIterable<Uint8Array> {
  for await (const c of src) {
    d.update(c);
    if (max !== undefined && d.size > max) throw new TooLarge(max);
    yield c;
  }
}

const DEFAULT: readonly Algo[] = ['MD5', 'SHA1', 'SHA256', 'ADLER32'];

export function memoryObjects(): ObjectStore & { readonly count: () => number } {
  const m = new Map<string, Uint8Array>();
  const store: ObjectStore & { readonly count: () => number } = {
    count: () => m.size,
    async put(data, o = {}) {
      const d = new Digest(o.algos ?? DEFAULT);
      const parts: Uint8Array[] = [];
      for await (const c of limit(data instanceof Uint8Array ? once(data) : data, d, o.maxBytes)) parts.push(c);
      const key = randomUUID();
      m.set(key, Buffer.concat(parts));
      return { key, size: d.size, checksums: d.result() };
    },
    async get(key, r) {
      const b = m.get(key);
      if (!b) throw new Missing(key);
      return once(r ? b.subarray(r.start, r.end + 1) : b);
    },
    size: async (key) => m.get(key)?.length,
    delete: async (key) => void m.delete(key),
    async compose(keys) {
      const bufs = keys.map((k) => {
        const b = m.get(k);
        if (!b) throw new Missing(k);
        return b;
      });
      return store.put(Buffer.concat(bufs));
    },
  };
  return store;
}

/** Forces a file or folder to disk. */
async function fsync(path: string): Promise<void> {
  const fh = await open(path, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Objects as files in a folder, two levels of fan-out so no folder grows large. A put returns only once the bytes,
 * and the folder entries that name them, are forced to disk, so a machine crash cannot lose an object whose key
 * the caller has already recorded.
 */
export function diskObjects(root: string): ObjectStore {
  const at = (key: string) => {
    if (!/^[0-9a-f-]{36}$/.test(key)) throw new Missing(key);
    return join(root, key.slice(0, 2), key.slice(2, 4), key);
  };
  const store: ObjectStore = {
    async put(data, o = {}) {
      const key = randomUUID();
      const path = at(key);
      const leaf = join(path, '..');
      const made = await mkdir(leaf, { recursive: true });
      const d = new Digest(o.algos ?? DEFAULT);
      try {
        await pipeline(Readable.from(limit(data instanceof Uint8Array ? once(data) : data, d, o.maxBytes)), createWriteStream(path));
        await fsync(path);
        await fsync(leaf);
        // Fan-out folders made for this object are entries in their own parents, which are forced too.
        if (made) {
          const top = resolve(made, '..');
          for (let p = resolve(leaf); p !== top && join(p, '..') !== p; ) {
            p = join(p, '..');
            await fsync(p);
          }
        }
      } catch (e) {
        await rm(path, { force: true });
        throw e;
      }
      return { key, size: d.size, checksums: d.result() };
    },
    async get(key, r) {
      const path = at(key);
      try {
        await stat(path);
      } catch {
        throw new Missing(key);
      }
      return createReadStream(path, r ? { start: r.start, end: r.end } : {});
    },
    async size(key) {
      try {
        return (await stat(at(key))).size;
      } catch {
        return undefined;
      }
    },
    delete: async (key) => rm(at(key), { force: true }),
    async compose(keys) {
      const parts = keys.map(at);
      for (const p of parts)
        try {
          await stat(p);
        } catch {
          throw new Missing(p);
        }
      async function* all() {
        for (const p of parts) for await (const c of createReadStream(p)) yield c as Uint8Array;
      }
      return store.put(all());
    },
  };
  return store;
}

/** Reads a whole object into memory: for small objects and tests only. */
export async function readAll(src: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const c of src) parts.push(c);
  return Buffer.concat(parts);
}

/** Everything under a disk store's root, for a sweep that compares it against what the tree still points at. */
export async function diskKeys(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const a of await readdir(root).catch(() => [] as string[]))
    for (const b of await readdir(join(root, a)).catch(() => [] as string[])) out.push(...(await readdir(join(root, a, b)).catch(() => [] as string[])));
  return out;
}
