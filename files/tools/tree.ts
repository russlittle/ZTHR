/**
 * The small-files tree the benchmark and the sync journey both use: the same names and the same bytes on every
 * machine for a given seed, so a run on a laptop, a run on a GitHub runner and the control run against a real
 * Nextcloud all move exactly the same files.
 *
 *   folder d{f} holds files file-{i}.txt, 250 to a folder; each file is "file {i}\n" and 0 to 63 seeded letters.
 */

export const PER_FOLDER = 250;

/** mulberry32: a small, fast, seeded generator; good enough for test data, never for secrets. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TreeFile {
  readonly folder: string;
  readonly path: string;
  readonly content: string;
}

export function folders(total: number): string[] {
  return Array.from({ length: Math.ceil(total / PER_FOLDER) }, (_, f) => `d${f}`);
}

/** Every file of the tree, in order. */
export function* smallTree(total: number, seed = 25_000): Generator<TreeFile> {
  const rnd = seeded(seed);
  for (let i = 0; i < total; i++) {
    const n = Math.floor(rnd() * 64);
    let pad = '';
    for (let k = 0; k < n; k++) pad += String.fromCharCode(97 + Math.floor(rnd() * 26));
    const folder = `d${Math.floor(i / PER_FOLDER)}`;
    yield { folder, path: `${folder}/file-${i}.txt`, content: `file ${i}\n${pad}` };
  }
}

/** Seeded bytes, for the large file. */
export function seededBytes(size: number, seed: number): Buffer {
  const rnd = seeded(seed);
  const b = Buffer.allocUnsafe(size);
  for (let i = 0; i + 4 <= size; i += 4) b.writeUInt32LE(Math.floor(rnd() * 4294967296), i);
  for (let i = size - (size % 4); i < size; i++) b[i] = Math.floor(rnd() * 256);
  return b;
}
