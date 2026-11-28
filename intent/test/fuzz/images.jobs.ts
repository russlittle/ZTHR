/** Bounded (worker) jobs for images.test.ts: image readers must answer or refuse, and finish. */
import { Refused, inspect, sniff, stripJpeg } from '../../blocks/imagemeta/index.ts';
import { runCases, type Rand } from './harness.ts';

export const png = (w: number, h: number) => {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

export const gif = (w: number, h: number) => {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
};

export const webp = (r: Rand, w: number, h: number) => {
  const b = Buffer.alloc(32);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(24, 4);
  b.write('WEBP', 8, 'latin1');
  const k = r.int(0, 2);
  if (k === 0) {
    b.write('VP8 ', 12, 'latin1');
    b.writeUInt16LE(w & 0x3fff, 26);
    b.writeUInt16LE(h & 0x3fff, 28);
  } else if (k === 1) {
    b.write('VP8L', 12, 'latin1');
    b.writeUInt32LE((((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)) >>> 0, 21);
  } else {
    b.write('VP8X', 12, 'latin1');
    b.writeUIntLE(w - 1, 24, 3);
    b.writeUIntLE(h - 1, 27, 3);
  }
  return b;
};

export const seg = (marker: number, body: Buffer) => {
  const h = Buffer.alloc(4);
  h[0] = 0xff;
  h[1] = marker;
  h.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([h, body]);
};

export const exif = (orientation: number, le: boolean) => {
  const t = Buffer.alloc(8 + 2 + 24 + 4);
  t.write(le ? 'II' : 'MM', 0, 'latin1');
  const u16 = (v: number, o: number) => (le ? t.writeUInt16LE(v, o) : t.writeUInt16BE(v, o));
  const u32 = (v: number, o: number) => (le ? t.writeUInt32LE(v, o) : t.writeUInt32BE(v, o));
  u16(42, 2);
  u32(8, 4);
  u16(2, 8);
  u16(0x0112, 10);
  u16(3, 12);
  u32(1, 14);
  u16(orientation, 18);
  u16(0x8825, 22);
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]);
};

/** Metadata the stripper must remove, by marker. */
export const PRIVATE = [0xe1, 0xed, 0xfe, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xef];

export interface Jpeg {
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
  readonly orientation: number;
}

/** A structurally valid JPEG: random APP/COM segments around a SOF, a scan with stuffing and restarts, EOI, maybe a trailer. */
export const jpeg = (r: Rand): Jpeg => {
  const width = r.int(1, 4000);
  const height = r.int(1, 4000);
  const orientation = r.int(1, 8);
  const sof = Buffer.alloc(15);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  const before: Buffer[] = [seg(0xe0, Buffer.from('JFIF\0\x01\x02', 'latin1')), seg(0xe1, exif(orientation, r.bool()))];
  for (let k = r.int(0, 5); k > 0; k--) before.push(seg(r.pick([0xe2, 0xe1, 0xed, 0xfe, 0xe5, 0xef, 0xdb, 0xc4, 0xee]), r.bytes(0, 40)));
  const scanData: number[] = [];
  for (let k = r.int(0, 60); k > 0; k--) {
    const x = r.int(0, 255);
    scanData.push(x);
    if (x === 0xff) scanData.push(r.bool(0.8) ? 0x00 : r.int(0xd0, 0xd7));
  }
  const scan = Buffer.concat([seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), Buffer.from(scanData)]);
  const trailer = r.bool(0.3) ? Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe1, exif(6, false)), Buffer.from([0xff, 0xd9])]) : Buffer.alloc(0);
  return { bytes: Buffer.concat([Buffer.from([0xff, 0xd8]), ...before, seg(0xc0, sof), scan, Buffer.from([0xff, 0xd9]), trailer]), width, height, orientation };
};

/** Random bytes, a valid header of each kind, or one of those mutated. */
export const imageish = (r: Rand): Buffer => {
  const w = r.int(1, 0x3fff);
  const h = r.int(1, 0x3fff);
  const base = r.pick([() => r.bytes(0, 64), () => png(w, h), () => gif(w & 0xffff, h & 0xffff), () => webp(r, w, h), () => jpeg(r).bytes])();
  const k = r.int(0, 3);
  return k === 0 ? base : k === 1 ? base.subarray(0, r.int(0, base.length)) : r.mutate(base, r.int(1, 6));
};

export const MAX_PIXELS = 50_000_000;

/** inspect returns a sane Info or throws Refused; nothing else. */
export function inspectAny(seed: number, cases: number, only: number | undefined, report: (i: number, input: unknown) => void): void {
  runCases('inspect answers or refuses', seed, cases, only, report, imageish, (b) => {
    let info;
    try {
      info = inspect(b);
    } catch (e) {
      if (!(e instanceof Refused)) throw new Error(`threw ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)} instead of Refused`);
      return;
    }
    if (info.kind !== sniff(b)) throw new Error(`kind ${info.kind} but sniff says ${sniff(b)}`);
    if (!(Number.isInteger(info.width) && Number.isInteger(info.height) && info.width > 0 && info.height > 0)) throw new Error(`size ${info.width}×${info.height}`);
    if (info.width * info.height > MAX_PIXELS) throw new Error('passed the pixel cap');
    if (!(info.orientation >= 1 && info.orientation <= 8)) throw new Error(`orientation ${info.orientation}`);
  });
}

/** stripJpeg on mutated JPEGs finishes, returns a JPEG no longer than its input, or throws Refused. */
export function stripMutated(seed: number, cases: number, only: number | undefined, report: (i: number, input: unknown) => void): void {
  runCases('stripJpeg on a mutated JPEG finishes', seed, cases, only, report, (r) => r.mutate(jpeg(r).bytes, r.int(1, 6)), (b) => {
    let out: Buffer;
    try {
      out = stripJpeg(b);
    } catch (e) {
      if (!(e instanceof Refused)) throw new Error(`threw ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)} instead of Refused`);
      return;
    }
    if (out.length > b.length) throw new Error(`output ${out.length} bytes from ${b.length}`);
    if (out[0] !== 0xff || out[1] !== 0xd8) throw new Error('output does not start with SOI');
  });
}

/** Segment lengths of 0 and 1 (and other small values) at random places: refused or read, quickly. */
export function tinyLengths(seed: number, cases: number, only: number | undefined, report: (i: number, input: unknown) => void): void {
  runCases('JPEG segment length 0 or 1 does not loop', seed, cases, only, report, (r) => {
    const j = jpeg(r).bytes;
    // Overwrite the length of a random marker segment (any FF xx not in the scan data) with 0, 1, 2 or 3.
    const at: number[] = [];
    for (let p = 2; p + 3 < j.length; p++) if (j[p] === 0xff && j[p + 1]! >= 0xc0 && j[p + 1]! !== 0xd9 && j[p + 1]! !== 0xff) at.push(p);
    const b = Buffer.from(j);
    for (let k = r.int(1, 3); k > 0 && at.length; k--) b.writeUInt16BE(r.pick([0, 1, 0, 1, 2, 3]), r.pick(at) + 2);
    return b;
  }, (b) => {
    for (const f of [() => inspect(b), () => stripJpeg(b)])
      try {
        f();
      } catch (e) {
        if (!(e instanceof Refused)) throw new Error(`threw ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)} instead of Refused`);
      }
  });
}
