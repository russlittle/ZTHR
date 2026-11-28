/**
 * Perceptual hashes for finding duplicates and near-duplicates: average hash, difference hash and the DCT-based
 * pHash, each 64 bits; Hamming distance; and grouping under a threshold.
 *
 * The image is first reduced to grey on a white background (so a transparent corner is white, not black), then
 * shrunk with the thumbnails block's box filter, which averages every source pixel, so the same picture at two sizes
 * gives nearly the same hash.
 */
import { raster, resize, type Raster } from '../thumbnails/index.ts';

export type Algorithm = 'ahash' | 'dhash' | 'phash';
export const ALGORITHMS: readonly Algorithm[] = ['ahash', 'dhash', 'phash'];

export class HashError extends Error {}

/** Hamming distances at or below which two pictures are called the same, per algorithm, for 64-bit hashes. */
export const DEFAULT_THRESHOLDS: Readonly<Record<Algorithm, { duplicate: number; similar: number }>> = {
  ahash: { duplicate: 2, similar: 6 },
  dhash: { duplicate: 3, similar: 8 },
  phash: { duplicate: 4, similar: 10 },
};

/** Luma on white, 0..255 per pixel. */
export function toGray(src: Raster): Raster {
  const out = raster(src.width, src.height);
  for (let i = 0; i < src.data.length; i += 4) {
    const a = (src.data[i + 3] as number) / 255;
    const mix = (c: number) => c * a + 255 * (1 - a);
    const y = 0.299 * mix(src.data[i] as number) + 0.587 * mix(src.data[i + 1] as number) + 0.114 * mix(src.data[i + 2] as number);
    out.data[i] = out.data[i + 1] = out.data[i + 2] = Math.round(y);
    out.data[i + 3] = 255;
  }
  return out;
}

function lumaAt(src: Raster, w: number, h: number): Float64Array {
  const small = resize(toGray(src), w, h, 'box');
  const out = new Float64Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = small.data[i * 4] as number;
  return out;
}

const toHex = (bits: readonly boolean[]): string => {
  let out = '';
  for (let i = 0; i < bits.length; i += 4) out += ((bits[i] ? 8 : 0) | (bits[i + 1] ? 4 : 0) | (bits[i + 2] ? 2 : 0) | (bits[i + 3] ? 1 : 0)).toString(16);
  return out;
};

export function aHash(src: Raster): string {
  const p = lumaAt(src, 8, 8);
  const mean = p.reduce((a, b) => a + b, 0) / 64;
  return toHex(Array.from(p, (v) => v > mean));
}

/** Each bit says whether a pixel is brighter than the one on its right, over 9x8 pixels. */
export function dHash(src: Raster): string {
  const p = lumaAt(src, 9, 8);
  const bits: boolean[] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push((p[y * 9 + x] as number) > (p[y * 9 + x + 1] as number));
  return toHex(bits);
}

const N = 32;
const COS = Array.from({ length: 8 }, (_, u) => Float64Array.from({ length: N }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N))));

/** The 8x8 lowest-frequency block of the 2-D DCT of a 32x32 grey image. */
export function dct8(p: Float64Array): Float64Array {
  const rows = new Float64Array(8 * N); // [u][y]: horizontal frequency u of each row
  for (let y = 0; y < N; y++) for (let u = 0; u < 8; u++) {
    let s = 0;
    for (let x = 0; x < N; x++) s += (p[y * N + x] as number) * (COS[u] as Float64Array)[x]!;
    rows[u * N + y] = s;
  }
  const out = new Float64Array(64);
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
    let s = 0;
    for (let y = 0; y < N; y++) s += (rows[u * N + y] as number) * (COS[v] as Float64Array)[y]!;
    out[v * 8 + u] = s;
  }
  return out;
}

/** Bits are the low frequencies above the median; the flat DC term is left out of the median so brightness does not skew it. */
export function pHash(src: Raster): string {
  const d = dct8(lumaAt(src, N, N));
  const rest = Array.from(d.subarray(1)).sort((a, b) => a - b);
  const median = ((rest[30] as number) + (rest[31] as number)) / 2;
  return toHex(Array.from(d, (v, i) => i !== 0 && v - median > 1e-6));
}

export function hash(src: Raster, algorithm: Algorithm): string {
  if (algorithm === 'ahash') return aHash(src);
  if (algorithm === 'dhash') return dHash(src);
  if (algorithm === 'phash') return pHash(src);
  throw new HashError(`unknown algorithm ${String(algorithm)}`);
}

const POP = Uint8Array.from({ length: 16 }, (_, n) => (n & 1) + ((n >> 1) & 1) + ((n >> 2) & 1) + ((n >> 3) & 1));

export function checkHash(h: string): void {
  if (!/^[0-9a-f]+$/.test(h) || h.length === 0) throw new HashError(`${h} is not a hex hash`);
}

/** Number of differing bits. Hashes must be the same length. */
export function distance(a: string, b: string): number {
  checkHash(a);
  checkHash(b);
  if (a.length !== b.length) throw new HashError('hashes of different sizes cannot be compared');
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POP[parseInt(a[i] as string, 16) ^ parseInt(b[i] as string, 16)] as number;
  return d;
}

/** 1 for identical, 0 for every bit different. */
export const similarity = (a: string, b: string): number => 1 - distance(a, b) / (a.length * 4);

export type Verdict = 'duplicate' | 'similar' | 'different';

export function judge(a: string, b: string, algorithm: Algorithm, t = DEFAULT_THRESHOLDS[algorithm]): Verdict {
  const d = distance(a, b);
  return d <= t.duplicate ? 'duplicate' : d <= t.similar ? 'similar' : 'different';
}

/** The same picture turned or flipped hashes differently; these are the eight hashes to compare against. */
export function transforms(src: Raster): Raster[] {
  const { width: w, height: h } = src;
  const px = (r: Raster, x: number, y: number) => (y * r.width + x) * 4;
  const make = (nw: number, nh: number, from: (x: number, y: number) => [number, number]) => {
    const out = raster(nw, nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const [sx, sy] = from(x, y);
      out.data.set(src.data.subarray(px(src, sx, sy), px(src, sx, sy) + 4), px(out, x, y));
    }
    return out;
  };
  return [
    src,
    make(w, h, (x, y) => [w - 1 - x, y]),
    make(w, h, (x, y) => [w - 1 - x, h - 1 - y]),
    make(w, h, (x, y) => [x, h - 1 - y]),
    make(h, w, (x, y) => [y, x]),
    make(h, w, (x, y) => [y, h - 1 - x]),
    make(h, w, (x, y) => [w - 1 - y, x]),
    make(h, w, (x, y) => [w - 1 - y, h - 1 - x]),
  ];
}

/** The smallest distance between a hash and any rotation or flip of a picture. */
export function distanceAnyOrientation(a: string, src: Raster, algorithm: Algorithm): number {
  return Math.min(...transforms(src).map((r) => distance(a, hash(r, algorithm))));
}

// ------------------------------------------------------------ grouping

export interface Item {
  readonly id: string;
  readonly hash: string;
}

export interface GroupOptions {
  /** Largest distance at which two pictures are in one group. */
  readonly threshold: number;
  /**
   * single: any close pair joins two groups, so a slow drift can chain far-apart pictures together (fast, groups
   * may be loose). complete: a picture joins only if it is within the threshold of every member (strict).
   */
  readonly linkage?: 'single' | 'complete';
  /** Smallest group to report; singles are dropped by default. */
  readonly minSize?: number;
}

export interface Group {
  readonly ids: readonly string[];
  /** The member closest to all the others: the one to keep. */
  readonly representative: string;
  /** Largest distance between any two members. */
  readonly diameter: number;
}

export function group(items: readonly Item[], o: GroupOptions): Group[] {
  if (!Number.isInteger(o.threshold) || o.threshold < 0) throw new HashError('the threshold must be a whole number of bits, zero or more');
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id)) throw new HashError(`duplicate item id ${it.id}`);
    seen.add(it.id);
    checkHash(it.hash);
  }
  const n = items.length;
  const dist = new Map<number, number>();
  const d = (i: number, j: number) => {
    const k = i < j ? i * n + j : j * n + i;
    let v = dist.get(k);
    if (v === undefined) {
      v = distance((items[i] as Item).hash, (items[j] as Item).hash);
      dist.set(k, v);
    }
    return v;
  };
  let clusters: number[][];
  if ((o.linkage ?? 'single') === 'single') {
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) x = parent[x] = parent[parent[x] as number] as number;
      return x;
    };
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (d(i, j) <= o.threshold) parent[find(i)] = find(j);
    const by = new Map<number, number[]>();
    for (let i = 0; i < n; i++) (by.get(find(i)) ?? by.set(find(i), []).get(find(i)))!.push(i);
    clusters = [...by.values()];
  } else {
    // Complete linkage, greedy and order independent: repeatedly merge the pair of clusters with the smallest
    // largest-distance, while that is within the threshold.
    clusters = items.map((_, i) => [i]);
    const worst = (a: number[], b: number[]) => Math.max(...a.flatMap((i) => b.map((j) => d(i, j))));
    for (;;) {
      let best = Infinity;
      let bi = -1;
      let bj = -1;
      for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
        const w = worst(clusters[i] as number[], clusters[j] as number[]);
        if (w <= o.threshold && w < best) [best, bi, bj] = [w, i, j];
      }
      if (bi < 0) break;
      clusters[bi] = [...(clusters[bi] as number[]), ...(clusters[bj] as number[])];
      clusters.splice(bj, 1);
    }
  }
  const min = o.minSize ?? 2;
  return clusters
    .filter((c) => c.length >= min)
    .map((c) => {
      const sorted = [...c].sort((a, b) => a - b);
      let rep = sorted[0] as number;
      let repSum = Infinity;
      let diameter = 0;
      for (const i of sorted) {
        let sum = 0;
        for (const j of sorted) if (i !== j) {
          sum += d(i, j);
          diameter = Math.max(diameter, d(i, j));
        }
        if (sum < repSum) [rep, repSum] = [i, sum];
      }
      return { ids: sorted.map((i) => (items[i] as Item).id), representative: (items[rep] as Item).id, diameter };
    })
    .sort((a, b) => b.ids.length - a.ids.length || (a.ids[0] as string).localeCompare(b.ids[0] as string));
}

/** Pictures whose hash is within `threshold` of the query, nearest first, ties by id. */
export function nearest(query: string, items: readonly Item[], threshold: number, limit = 20): { id: string; distance: number }[] {
  return items
    .map((it) => ({ id: it.id, distance: distance(query, it.hash) }))
    .filter((r) => r.distance <= threshold)
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
    .slice(0, limit);
}
