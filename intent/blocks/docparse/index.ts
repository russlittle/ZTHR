/**
 * Reads the text out of Office files people upload: .docx paragraphs (with headings and list items marked) and
 * .xlsx sheets as rows of cells (shared strings, inline strings, numbers, booleans). Both are zip files, read here
 * from the central directory with limits on entry count, total size and compression ratio, so a zip bomb or a
 * path-traversal name is refused rather than unpacked, and so is an entry whose CRC-32 does not match or whose name
 * another entry already has. The XML is scanned in linear time, and a sheet that reaches past Excel's grid or would pad out to millions of cells is
 * refused; every refusal is a Refused error.
 */
import { crc32, inflateRawSync } from 'node:zlib';

export interface ZipLimits {
  readonly maxEntries?: number;
  readonly maxTotalBytes?: number;
  readonly maxRatio?: number;
}

export class Refused extends Error {}

/**
 * The entries of a zip, by name. Two entries with the same name, compared ignoring ASCII case as Office part names
 * are, are refused: which one a reader takes would otherwise depend on the reader.
 */
export function unzip(buf: Buffer, o: ZipLimits = {}): Map<string, Buffer> {
  const maxEntries = o.maxEntries ?? 2000;
  const maxTotal = o.maxTotalBytes ?? 200 * 1024 * 1024;
  const maxRatio = o.maxRatio ?? 200;
  let eocd = -1;
  if (buf.length < 22) throw new Refused('not a zip file');
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
  const names = new Set<string>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Refused('the zip directory is damaged');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (name.startsWith('/') || name.split(/[\\/]/).includes('..')) throw new Refused(`unsafe path ${name}`);
    const folded = name.replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (names.has(folded)) throw new Refused(`${name} appears more than once`);
    names.add(folded);
    if (name.endsWith('/')) continue;
    total += usize;
    if (total > maxTotal) throw new Refused('the contents are too large');
    if (csize && usize / csize > maxRatio) throw new Refused(`${name} expands too much to be a real document`);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Refused('the zip entries are damaged');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > buf.length) throw new Refused(`${name} runs past the end of the file`);
    const raw = buf.subarray(start, start + csize);
    if (method !== 0 && method !== 8) throw new Refused(`${name} uses an unsupported compression method`);
    let data: Buffer;
    try {
      // Inflation stops at the size the directory declares, so a lying entry cannot expand past the limits.
      data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) });
    } catch {
      throw new Refused(`${name} is damaged or larger than the directory says`);
    }
    if (data.length !== usize) throw new Refused(`${name} is not the size the directory says`);
    if (crc32(data) !== crc) throw new Refused(`${name} is damaged (its CRC-32 does not match)`);
    out.set(name, data);
  }
  return out;
}

const codePoint = (n: number) => {
  if (!(n >= 0 && n <= 0x10ffff)) throw new Refused(`&#${n}; is not a character`);
  return String.fromCodePoint(n);
};

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d{1,8});/g, (_, n) => codePoint(Number(n))).replace(/&#x([0-9a-f]{1,8});/gi, (_, n) => codePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

/** Attributes of a start tag, in any order. Starts only after whitespace, so a long word cannot cause backtracking. */
const attrs = (head: string): Record<string, string> => {
  const out: Record<string, string> = Object.create(null);
  for (const m of head.matchAll(/(?:^|\s)([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]!] = m[2] ?? m[3] ?? '';
  return out;
};

/**
 * The elements named `tag` in order, by indexOf rather than a lazy regex, so unclosed tags cost linear time. Nested
 * elements of the same name are not expected in the parts read here.
 */
function* elements(xml: string, tag: string): Generator<{ attrs: Record<string, string>; inner?: string }> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let i = 0;
  while ((i = xml.indexOf(open, i)) >= 0) {
    const c = xml[i + open.length];
    if (c !== '>' && c !== '/' && !/\s/.test(c ?? '')) {
      i += open.length;
      continue;
    }
    const gt = xml.indexOf('>', i);
    if (gt < 0) return;
    const head = xml.slice(i + open.length, gt);
    if (head.endsWith('/')) {
      yield { attrs: attrs(head.slice(0, -1)) };
      i = gt + 1;
      continue;
    }
    const end = xml.indexOf(close, gt);
    if (end < 0) return;
    yield { attrs: attrs(head), inner: xml.slice(gt + 1, end) };
    i = end + close.length;
  }
}

/** The text of the <t> runs in a string item, leaving out phonetic guides (<rPh>). */
const runs = (inner: string) => {
  let kept = '';
  let i = 0;
  for (let at; (at = inner.indexOf('<rPh', i)) >= 0; ) {
    const end = inner.indexOf('</rPh>', at);
    kept += inner.slice(i, at);
    i = end < 0 ? inner.length : end + 6;
  }
  kept += inner.slice(i);
  let s = '';
  for (const r of elements(kept, 't')) s += r.inner ?? '';
  return unxml(s);
};

export interface Para {
  readonly text: string;
  readonly heading?: number;
  readonly list?: boolean;
}

/** Drops every <mc:Fallback> block, nesting included: it repeats what its <mc:Choice> holds (a text box twice). */
function withoutFallbacks(xml: string): string {
  const open = '<mc:Fallback';
  const close = '</mc:Fallback>';
  let out = '';
  let i = 0;
  let depth = 0;
  let from = 0;
  let a = -2;
  let b = -2;
  for (;;) {
    if (a !== -1 && a < i) a = xml.indexOf(open, i);
    if (b !== -1 && b < i) b = xml.indexOf(close, i);
    if (a < 0 && b < 0) break;
    if (a >= 0 && (b < 0 || a < b)) {
      const gt = xml.indexOf('>', a);
      if (gt < 0) break;
      if (xml[gt - 1] === '/') {
        if (depth === 0) out += xml.slice(from, a), (from = gt + 1);
        i = gt + 1;
        continue;
      }
      if (depth++ === 0) out += xml.slice(from, a);
      i = gt + 1;
    } else {
      i = b + close.length;
      if (depth > 0 && --depth === 0) from = i;
    }
  }
  return depth > 0 ? out : out + xml.slice(from);
}

/**
 * Each <w:p>'s own content, in document order: a paragraph inside another (a text box's) is its own paragraph,
 * coming after the one that holds it, and is left out of that one's content. Linear: one indexOf scan.
 */
function paragraphs(xml: string): string[] {
  const done: { order: number; own: string }[] = [];
  const stack: { order: number; parts: string[]; cursor: number }[] = [];
  let n = 0;
  let i = 0;
  // The next open and close found so far, kept while still ahead, so no stretch of the text is searched twice.
  let a = -2;
  let b = -2;
  for (;;) {
    if (a !== -1 && a < i) {
      a = xml.indexOf('<w:p', i);
      while (a >= 0 && !/[\s/>]/.test(xml[a + 4] ?? '')) a = xml.indexOf('<w:p', a + 4);
    }
    if (b !== -1 && b < i) b = xml.indexOf('</w:p>', i);
    if (a < 0 && b < 0) break;
    if (a >= 0 && (b < 0 || a < b)) {
      const gt = xml.indexOf('>', a);
      if (gt < 0) break;
      if (xml[gt - 1] === '/') {
        done.push({ order: n++, own: '' });
        i = gt + 1;
        continue;
      }
      const top = stack.at(-1);
      if (top) top.parts.push(xml.slice(top.cursor, a));
      stack.push({ order: n++, parts: [], cursor: gt + 1 });
      i = gt + 1;
    } else {
      const top = stack.pop();
      i = b + 6;
      if (!top) continue;
      top.parts.push(xml.slice(top.cursor, b));
      done.push({ order: top.order, own: top.parts.join('') });
      const parent = stack.at(-1);
      if (parent) parent.cursor = i;
    }
  }
  return done.sort((x, y) => x.order - y.order).map((d) => d.own);
}

/**
 * The paragraphs of a .docx, text boxes included (each of their paragraphs on its own, after the paragraph that
 * anchors it, and once, not again from the fallback copy Word writes beside it).
 */
export function docx(buf: Buffer, o: ZipLimits = {}): Para[] {
  const z = unzip(buf, o);
  const doc = z.get('word/document.xml');
  if (!doc) throw new Refused('not a Word document');
  const xml = withoutFallbacks(doc.toString('utf8'));
  const out: Para[] = [];
  for (const p of paragraphs(xml)) {
    const text = unxml([...p.matchAll(/<w:t(?:\s[^<>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br(?:\s[^<>]*)?\/>|<w:cr\/>/g)].map((t) => (t[0].startsWith('<w:tab') ? '\t' : t[0].startsWith('<w:br') || t[0].startsWith('<w:cr') ? '\n' : t[1]!)).join(''));
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1];
    const h = style && /^(?:Heading|heading)\s?(\d)$/.exec(style)?.[1];
    const list = /<w:numPr>/.test(p) || /^List/i.test(style ?? '');
    if (!text.trim() && !h) continue;
    out.push({ text, ...(h ? { heading: Number(h) } : {}), ...(list ? { list: true } : {}) });
  }
  return out;
}

/** Excel's grid: columns A to XFD, rows 1 to 1,048,576. */
const MAX_COL = 16_384;
const MAX_ROW = 1_048_576;

/** "B12" → [11, 1]. */
const ref = (r: string): [number, number] => {
  const m = /^([A-Z]{1,3})(\d{1,7})$/.exec(r);
  if (!m) throw new Refused(`${r.slice(0, 20)} is not a cell reference`);
  let c = 0;
  for (const ch of m[1]!) c = c * 26 + ch.charCodeAt(0) - 64;
  const row = Number(m[2]);
  if (c > MAX_COL || row < 1 || row > MAX_ROW) throw new Refused(`${r} is outside the Excel grid`);
  return [row - 1, c - 1];
};

/**
 * Sheets as rows of cells. Cells may come without a reference (they follow the previous one) and with attributes in
 * any order. Cells past Excel's grid are refused, and so is a sheet whose rows, padded out with empty cells, would
 * hold more than `maxCells` (default 5 million).
 */
export function xlsx(buf: Buffer, o: ZipLimits & { maxCells?: number } = {}): { name: string; rows: (string | number | boolean | null)[][] }[] {
  const z = unzip(buf, o);
  const maxCells = o.maxCells ?? 5_000_000;
  const wb = z.get('xl/workbook.xml')?.toString('utf8');
  if (!wb) throw new Refused('not an Excel workbook');
  const shared = [...elements(z.get('xl/sharedStrings.xml')?.toString('utf8') ?? '', 'si')].map((si) => runs(si.inner ?? ''));
  const rels = new Map<string, string>();
  for (const r of elements(z.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '', 'Relationship')) if (r.attrs.Id && r.attrs.Target) rels.set(r.attrs.Id, r.attrs.Target.replace(/^\/?xl\//, ''));
  const sheets = [...elements(wb, 'sheet')].filter((s) => s.attrs.name !== undefined && s.attrs['r:id'] !== undefined);
  return sheets.map((s) => {
    const target = rels.get(s.attrs['r:id']!) ?? `worksheets/sheet1.xml`;
    const xml = z.get(`xl/${target}`)?.toString('utf8') ?? '';
    const rows: (string | number | boolean | null)[][] = [];
    let cells = 0;
    let r = -1;
    for (const row of elements(xml, 'row')) {
      r = row.attrs.r !== undefined ? ref(`A${row.attrs.r}`)[0] : r + 1;
      let col = -1;
      for (const c of elements(row.inner ?? '', 'c')) {
        if (c.attrs.r !== undefined) {
          const [cr, cc] = ref(c.attrs.r);
          r = cr;
          col = cc;
        } else if (++col >= MAX_COL) throw new Refused('a row runs past the Excel grid');
        const t = c.attrs.t;
        const inner = c.inner ?? '';
        const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
        let val: string | number | boolean | null = null;
        if (t === 's' && v !== undefined) val = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') val = runs(inner);
        else if (t === 'b') val = v === '1';
        else if (t === 'str' || t === 'e') val = v !== undefined ? unxml(v) : null;
        else if (v !== undefined) val = Number(v);
        cells += Math.max(0, r + 1 - rows.length);
        if (cells > maxCells) throw new Refused('the sheet has too many cells');
        while (rows.length <= r) rows.push([]);
        const line = rows[r]!;
        cells += Math.max(0, col + 1 - line.length);
        if (cells > maxCells) throw new Refused('the sheet has too many cells');
        while (line.length < col) line.push(null);
        line[col] = val;
      }
    }
    return { name: unxml(s.attrs.name!), rows };
  });
}
