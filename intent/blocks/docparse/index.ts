/**
 * Reads the text out of Office files people upload: .docx paragraphs (with headings and list items marked) and
 * .xlsx sheets as rows of cells (shared strings, inline strings, numbers, booleans). Both are zip files, read here
 * from the central directory with limits on entry count, total size and compression ratio, so a zip bomb or a
 * path-traversal name is refused rather than unpacked.
 */
import { inflateRawSync } from 'node:zlib';

export interface ZipLimits {
  readonly maxEntries?: number;
  readonly maxTotalBytes?: number;
  readonly maxRatio?: number;
}

export class Refused extends Error {}

export function unzip(buf: Buffer, o: ZipLimits = {}): Map<string, Buffer> {
  const maxEntries = o.maxEntries ?? 2000;
  const maxTotal = o.maxTotalBytes ?? 200 * 1024 * 1024;
  const maxRatio = o.maxRatio ?? 200;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Refused('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  if (count > maxEntries) throw new Refused(`too many entries (${count})`);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Refused('the zip directory is damaged');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (name.startsWith('/') || name.split(/[\\/]/).includes('..')) throw new Refused(`unsafe path ${name}`);
    if (name.endsWith('/')) continue;
    total += usize;
    if (total > maxTotal) throw new Refused('the contents are too large');
    if (csize && usize / csize > maxRatio) throw new Refused(`${name} expands too much to be a real document`);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Refused('the zip entries are damaged');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) }) : undefined;
    if (!data) throw new Refused(`${name} uses an unsupported compression method`);
    if (data.length !== usize) throw new Refused(`${name} is not the size the directory says`);
    out.set(name, data);
  }
  return out;
}

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

export interface Para {
  readonly text: string;
  readonly heading?: number;
  readonly list?: boolean;
}

export function docx(buf: Buffer, o: ZipLimits = {}): Para[] {
  const z = unzip(buf, o);
  const doc = z.get('word/document.xml');
  if (!doc) throw new Refused('not a Word document');
  const xml = doc.toString('utf8');
  const out: Para[] = [];
  for (const m of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    const p = m[0];
    const text = unxml([...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map((t) => (t[0].startsWith('<w:tab') ? '\t' : t[0].startsWith('<w:br') ? '\n' : t[1]!)).join(''));
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1];
    const h = style && /^(?:Heading|heading)\s?(\d)$/.exec(style)?.[1];
    const list = /<w:numPr>/.test(p) || /^List/i.test(style ?? '');
    if (!text.trim() && !h) continue;
    out.push({ text, ...(h ? { heading: Number(h) } : {}), ...(list ? { list: true } : {}) });
  }
  return out;
}

/** "B12" → [11, 1]. */
const ref = (r: string): [number, number] => {
  const m = /^([A-Z]+)(\d+)$/.exec(r)!;
  let c = 0;
  for (const ch of m[1]!) c = c * 26 + ch.charCodeAt(0) - 64;
  return [Number(m[2]) - 1, c - 1];
};

export function xlsx(buf: Buffer, o: ZipLimits = {}): { name: string; rows: (string | number | boolean | null)[][] }[] {
  const z = unzip(buf, o);
  const wb = z.get('xl/workbook.xml')?.toString('utf8');
  if (!wb) throw new Refused('not an Excel workbook');
  const shared = [...(z.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unxml([...m[1]!.matchAll(/<t(?: [^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join('')));
  const rels = new Map([...(z.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '').matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1]!, m[2]!.replace(/^\/?xl\//, '')]));
  return [...wb.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map((s) => {
    const target = rels.get(s[2]!) ?? `worksheets/sheet1.xml`;
    const xml = z.get(`xl/${target}`)?.toString('utf8') ?? '';
    const rows: (string | number | boolean | null)[][] = [];
    for (const c of xml.matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const [r, col] = ref(c[1]!);
      const t = /t="([^"]+)"/.exec(c[2]!)?.[1];
      const inner = c[3] ?? '';
      const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
      let val: string | number | boolean | null = null;
      if (t === 's' && v !== undefined) val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = unxml([...inner.matchAll(/<t(?: [^>]*)?>([^<]*)<\/t>/g)].map((x) => x[1]).join(''));
      else if (t === 'b') val = v === '1';
      else if (t === 'str' || t === 'e') val = v !== undefined ? unxml(v) : null;
      else if (v !== undefined) val = Number(v);
      while (rows.length <= r) rows.push([]);
      const row = rows[r]!;
      while (row.length < col) row.push(null);
      row[col] = val;
    }
    return { name: unxml(s[1]!), rows };
  });
}
