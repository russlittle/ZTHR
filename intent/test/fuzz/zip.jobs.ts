/** Bounded (worker) jobs for zip.test.ts: damaged and hostile zips must be refused or read correctly, and finish. */
import { Refused, unzip } from '../../blocks/docparse/index.ts';
import { zip } from '../../blocks/tabular/index.ts';
import { runCases, type Rand } from './harness.ts';

export interface FileSet {
  readonly files: { name: string; data: Buffer }[];
}

const SEG = ['a', 'b', 'docs', 'x.txt', 'é', '中文', 'data.bin', '😀', 'a b', 'A-1_2', '.hidden', 'v1.2'];

/** Distinct, safe names with random contents (bytes, repetitive text, or empty). */
export const fileSet = (r: Rand, max = 6): FileSet => {
  const names = new Set<string>();
  const n = r.int(0, max);
  while (names.size < n) names.add(r.array(1, 3, () => r.pick(SEG)).join('/'));
  return {
    files: [...names].map((name) => ({ name, data: r.pick([() => r.bytes(0, 300), () => Buffer.from(r.str(0, 400, ['ab', 'ab', 'c', '\n', '<x/>', 'é'])), () => Buffer.alloc(0)])() })),
  };
};

/** Whether a name could land outside the extraction folder on POSIX: a leading slash or a .. segment. */
export const posixUnsafe = (name: string) => name.startsWith('/') || name.split(/[\\/]/).includes('..');

export const UNZIP_LIMITS = { maxTotalBytes: 2 * 1024 * 1024 } as const;

/**
 * Mutated zips: unzip returns only entries whose data is exactly what was zipped under that name, or throws an
 * Error. It never returns a path with .. or a leading /, never more than the size cap.
 */
export function mutated(seed: number, cases: number, only: number | undefined, report: (i: number, input: unknown) => void): void {
  runCases('unzip of a mutated zip is right or refused', seed, cases, only, report, (r) => {
    const set = fileSet(r, 4);
    return { set, bytes: r.mutate(zip(set.files), r.int(1, 3)) };
  }, ({ set, bytes }) => {
    let out: Map<string, Buffer>;
    try {
      out = unzip(bytes, UNZIP_LIMITS);
    } catch (e) {
      if (!(e instanceof Error)) throw new Error(`threw a non-Error ${String(e)}`);
      return;
    }
    const orig = new Map(set.files.map((f) => [f.name, f.data]));
    let total = 0;
    for (const [name, data] of out) {
      if (posixUnsafe(name)) throw new Error(`returned an unsafe path ${JSON.stringify(name)}`);
      total += data.length;
      const want = orig.get(name);
      if (want && want.length !== data.length) throw new Error(`${name}: returned ${data.length} bytes, zipped ${want.length}`);
      if (want && !want.equals(data)) throw new Error(`${name}: returned different bytes of the right length (the CRC-32 is not checked)`);
    }
    if (total > UNZIP_LIMITS.maxTotalBytes) throw new Error(`returned ${total} bytes past the cap`);
  });
}

/** Same as `mutated`, but only Refused may be thrown: any other error means the reader trusted a field. */
export function mutatedRefusedOnly(seed: number, cases: number, only: number | undefined, report: (i: number, input: unknown) => void): void {
  runCases('unzip of a mutated zip throws only Refused', seed, cases, only, report, (r) => {
    const set = fileSet(r, 4);
    return { bytes: r.mutate(zip(set.files), r.int(1, 3)) };
  }, ({ bytes }) => {
    try {
      unzip(bytes, UNZIP_LIMITS);
    } catch (e) {
      if (!(e instanceof Refused)) throw new Error(`threw ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)} instead of Refused`);
    }
  });
}

const BIG = [0, 1, 0xff, 0xffff, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff];

/** A valid zip, then random values in the central directory's size, offset and length fields and the EOCD's. */
export const hostileLengths = (r: Rand): { bytes: Buffer; edits: string[] } => {
  const set = fileSet(r, 3);
  if (!set.files.length) set.files.push({ name: 'a', data: Buffer.from('hello hello hello') });
  const b = zip(set.files);
  const eocd = b.length - 22;
  const cd = b.readUInt32LE(eocd + 16);
  const edits: string[] = [];
  const val = (bits: 16 | 32) => (r.bool(0.6) ? r.pick(BIG) : r.int(0, 2 ** bits - 1)) % 2 ** bits;
  const put = (at: number, bits: 16 | 32, what: string) => {
    const v = val(bits);
    if (bits === 16) b.writeUInt16LE(v & 0xffff, at);
    else b.writeUInt32LE(v >>> 0, at);
    edits.push(`${what}=${v}`);
  };
  for (let k = r.int(1, 3); k > 0; k--) {
    const f = r.pick(['csize', 'usize', 'nlen', 'xlen', 'clen', 'local', 'count', 'cdoff', 'lnlen', 'lxlen'] as const);
    if (f === 'csize') put(cd + 20, 32, f);
    else if (f === 'usize') put(cd + 24, 32, f);
    else if (f === 'nlen') put(cd + 28, 16, f);
    else if (f === 'xlen') put(cd + 30, 16, f);
    else if (f === 'clen') put(cd + 32, 16, f);
    else if (f === 'local') put(cd + 42, 32, f);
    else if (f === 'count') put(eocd + 10, 16, f);
    else if (f === 'cdoff') put(eocd + 16, 32, f);
    else if (f === 'lnlen') put(26, 16, f);
    else put(28, 16, f);
  }
  return { bytes: b, edits };
};

/** Random length fields never make unzip allocate much past maxTotalBytes, and it finishes. */
export function lengths(seed: number, cases: number, only: number | undefined, report: (i: number, input: unknown) => void): void {
  runCases('unzip with hostile length fields stays within the cap', seed, cases, only, report, hostileLengths, ({ bytes }) => {
    const before = process.memoryUsage().arrayBuffers;
    let total = 0;
    try {
      for (const d of unzip(bytes, UNZIP_LIMITS).values()) total += d.length;
    } catch (e) {
      if (!(e instanceof Error)) throw new Error(`threw a non-Error ${String(e)}`);
    }
    const grew = process.memoryUsage().arrayBuffers - before;
    if (total > UNZIP_LIMITS.maxTotalBytes) throw new Error(`returned ${total} bytes past the cap`);
    if (grew > 4 * UNZIP_LIMITS.maxTotalBytes) throw new Error(`external memory grew by ${grew} bytes`);
  });
}
