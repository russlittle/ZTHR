/**
 * What an uploaded image really is, read from its bytes rather than its name: PNG, JPEG, GIF or WebP, with width,
 * height and (for JPEG) the EXIF orientation, so a phone photo can be shown the right way up. Images whose pixel
 * count would exhaust memory when decoded are refused before anything decodes them. For JPEG, the metadata that
 * can give away where and on what a photo was taken (EXIF, including GPS, XMP, and Photoshop blocks) is stripped
 * while the colour profile is kept.
 */

export type Kind = 'png' | 'jpeg' | 'gif' | 'webp';

export interface Info {
  readonly kind: Kind;
  readonly width: number;
  readonly height: number;
  /** EXIF orientation 1 to 8; 1 is upright. */
  readonly orientation: number;
  readonly mime: string;
}

export class Refused extends Error {}

export function sniff(b: Buffer): Kind | undefined {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return undefined;
}

function exifOrientation(seg: Buffer): number {
  if (seg.subarray(0, 6).toString('latin1') !== 'Exif\0\0') return 1;
  const t = seg.subarray(6);
  if (t.length < 8) return 1;
  const le = t.subarray(0, 2).toString('latin1') === 'II';
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const ifd = u32(4);
  if (ifd + 2 > t.length) return 1;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) break;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

/** Walks JPEG segments up to the image data. */
function* segments(b: Buffer): Generator<{ marker: number; start: number; end: number }> {
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) throw new Refused('the JPEG is damaged');
    const marker = b[p + 1]!;
    if (marker === 0xd9 || marker === 0xda) {
      yield { marker, start: p, end: b.length };
      return;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    const len = b.readUInt16BE(p + 2);
    yield { marker, start: p, end: p + 2 + len };
    p += 2 + len;
  }
}

export function inspect(b: Buffer, o: { maxPixels?: number } = {}): Info {
  const kind = sniff(b);
  if (!kind) throw new Refused('this is not a PNG, JPEG, GIF or WebP image');
  let width = 0;
  let height = 0;
  let orientation = 1;
  if (kind === 'png') {
    if (b.subarray(12, 16).toString('latin1') !== 'IHDR') throw new Refused('the PNG is damaged');
    width = b.readUInt32BE(16);
    height = b.readUInt32BE(20);
  } else if (kind === 'gif') {
    width = b.readUInt16LE(6);
    height = b.readUInt16LE(8);
  } else if (kind === 'webp') {
    const chunk = b.subarray(12, 16).toString('latin1');
    if (chunk === 'VP8 ') {
      width = b.readUInt16LE(26) & 0x3fff;
      height = b.readUInt16LE(28) & 0x3fff;
    } else if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
    } else if (chunk === 'VP8X') {
      width = b.readUIntLE(24, 3) + 1;
      height = b.readUIntLE(27, 3) + 1;
    } else throw new Refused('the WebP is damaged');
  } else {
    for (const s of segments(b)) {
      if (s.marker === 0xe1 && orientation === 1) orientation = exifOrientation(b.subarray(s.start + 4, s.end));
      if ((s.marker >= 0xc0 && s.marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(s.marker))) {
        height = b.readUInt16BE(s.start + 5);
        width = b.readUInt16BE(s.start + 7);
        break;
      }
    }
  }
  if (!width || !height) throw new Refused('the image has no size');
  if (width * height > (o.maxPixels ?? 50_000_000)) throw new Refused(`${width}×${height} is too many pixels to process`);
  return { kind, width, height, orientation, mime: `image/${kind}` };
}

/** Width and height as displayed, after the orientation is applied. */
export const displayed = (i: Info) => (i.orientation >= 5 ? { width: i.height, height: i.width } : { width: i.width, height: i.height });

/** A JPEG without EXIF (and its GPS), XMP, Photoshop blocks or comments; the ICC colour profile stays. */
export function stripJpeg(b: Buffer): Buffer {
  if (sniff(b) !== 'jpeg') throw new Refused('not a JPEG');
  const keep: Buffer[] = [b.subarray(0, 2)];
  for (const s of segments(b)) {
    const drop = s.marker === 0xe1 || s.marker === 0xed || s.marker === 0xfe || (s.marker >= 0xe3 && s.marker <= 0xef);
    if (!drop) keep.push(b.subarray(s.start, s.end));
  }
  return Buffer.concat(keep);
}
