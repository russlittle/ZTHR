/**
 * Tables in and out. CSV is read and written to RFC 4180 (quoted fields, doubled quotes, line breaks inside quotes,
 * a byte-order mark tolerated) and cells that a spreadsheet would run as a formula are defused on export. An import
 * maps columns to fields (suggesting a mapping from the headers), checks every row and keeps the good ones while
 * the bad ones go to quarantine with their row number and reasons, to be fixed and retried. Headers that repeat
 * are told apart ("Name", "Name (2)") and reported. Duplicates are found by a key and merged by rules that say
 * which value wins. Exports go to CSV, JSON lines, or a real .xlsx file.
 */
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Reads CSV text into rows of cells. A U+FEFF as the very first character is a byte-order mark and is dropped;
 * `toCsv` quotes a cell that starts with U+FEFF, so such a cell never reaches this position bare.
 */
export function parseCsv(text: string, sep = ','): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  let i = 0;
  let any = false;
  while (i < s.length) {
    const c = s[i]!;
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          f += '"';
          i += 2;
          continue;
        }
        q = false;
      } else f += c;
      i++;
      continue;
    }
    if (c === '"' && f === '') q = true;
    else if (c === sep) row.push(f), (f = '');
    else if (c === '\r' || c === '\n') {
      row.push(f);
      rows.push(row);
      row = [];
      f = '';
      if (c === '\r' && s[i + 1] === '\n') i++;
      any = false;
      i++;
      continue;
    } else f += c;
    any = true;
    i++;
  }
  if (q) throw new Error('a quoted field is never closed');
  if (any || f !== '' || row.length) row.push(f), rows.push(row);
  return rows;
}

/** A cell a spreadsheet would treat as a formula gets a leading apostrophe (CSV injection). */
const defuse = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

/**
 * Writes rows as RFC 4180 CSV, lines joined by CRLF. Every value written as text is defused (unless `defuse` is
 * false): strings, String objects and any other object, by what it prints as. Numbers, bigints, booleans and dates
 * are written as they are, so -3 stays a number. A row that is one empty cell is written as `""`, so it reads back
 * as a row even at the end of the text, and a cell starting with U+FEFF is quoted so it is not read as a byte-order
 * mark.
 */
export function toCsv(rows: readonly (readonly unknown[])[], o: { defuse?: boolean } = {}): string {
  return rows
    .map((r) => {
      if (r.length === 1 && (r[0] === null || r[0] === undefined || String(r[0]) === '')) return '""';
      return r
        .map((v) => {
          let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
          const literal = typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean' || v instanceof Date;
          if (o.defuse !== false && !literal) s = defuse(s);
          return /[",\r\n]|^\uFEFF/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(',');
    })
    .join('\r\n');
}

export interface Field {
  readonly name: string;
  readonly label: string;
  readonly aliases?: readonly string[];
  readonly required?: boolean;
  /** Returns the value, or throws with a message for the row. */
  readonly parse?: (raw: string) => unknown;
}

/** Sets a key as plain data, so a column or field called `__proto__` never changes an object's prototype. */
const put = (o: Record<string, unknown>, k: string, v: unknown) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
const own = <V>(o: Readonly<Record<string, V>>, k: string): V | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * For each header, the field it most likely is (exact, alias, then contained), or undefined. Headers that repeat
 * are keyed by their distinct names ("Name (2)"), as `importRows` reads them.
 */
export function suggestMapping(given: readonly string[], fields: readonly Field[]): Record<string, string | undefined> {
  const { headers } = distinctHeaders(given);
  const out: Record<string, string | undefined> = {};
  const taken = new Set<string>();
  const pick = (h: string) => {
    const n = norm(h);
    const tests = [(f: Field) => norm(f.name) === n || norm(f.label) === n, (f: Field) => (f.aliases ?? []).some((a) => norm(a) === n), (f: Field) => n.length > 2 && (n.includes(norm(f.name)) || norm(f.name).includes(n))];
    for (const t of tests) {
      const f = fields.find((x) => !taken.has(x.name) && t(x));
      if (f) return f.name;
    }
    return undefined;
  };
  for (const h of headers) {
    const f = pick(h);
    if (f) taken.add(f);
    put(out, h, f);
  }
  return out;
}

export interface Quarantined {
  readonly row: number;
  readonly raw: Readonly<Record<string, string>>;
  readonly problems: readonly string[];
}

/** A header that repeats an earlier one: its column (from 0), the header as written, and the name it is known by. */
export interface RenamedHeader {
  readonly column: number;
  readonly header: string;
  readonly as: string;
}

/**
 * Makes every header distinct: the first of a name keeps it, later ones become "Name (2)", "Name (3)" and so on
 * (skipping any name already taken), and each one renamed is reported. `suggestMapping` and `importRows` both use
 * these names, so a mapping is keyed by them.
 */
export function distinctHeaders(headers: readonly string[]): { headers: string[]; renamed: RenamedHeader[] } {
  const taken = new Set(headers);
  const seen = new Set<string>();
  const renamed: RenamedHeader[] = [];
  const out = headers.map((h, column) => {
    if (!seen.has(h)) {
      seen.add(h);
      return h;
    }
    let n = 2;
    while (taken.has(`${h} (${n})`)) n++;
    const as = `${h} (${n})`;
    taken.add(as);
    seen.add(as);
    renamed.push({ column, header: h, as });
    return as;
  });
  return { headers: out, renamed };
}

/**
 * Checks every row against the fields through the mapping (keyed by the distinct header names). Headers that
 * repeat are renamed as `distinctHeaders` does and listed in `renamed`, so no column overwrites another.
 */
export function importRows(table: readonly (readonly string[])[], fields: readonly Field[], mapping: Readonly<Record<string, string | undefined>>): { good: Record<string, unknown>[]; quarantine: Quarantined[]; unmapped: string[]; renamed: RenamedHeader[] } {
  const [given, ...rows] = table;
  if (!given) return { good: [], quarantine: [], unmapped: [], renamed: [] };
  const { headers, renamed } = distinctHeaders(given);
  const missingCols = fields.filter((f) => f.required && !headers.some((h) => own(mapping, h) === f.name)).map((f) => f.label);
  if (missingCols.length) throw new Error(`no column is mapped to ${missingCols.join(', ')}`);
  const good: Record<string, unknown>[] = [];
  const quarantine: Quarantined[] = [];
  rows.forEach((cells, i) => {
    if (cells.every((c) => c.trim() === '')) return;
    const raw: Record<string, string> = {};
    headers.forEach((h, j) => put(raw, h, cells[j] ?? ''));
    const rec: Record<string, unknown> = {};
    const problems: string[] = [];
    if (cells.length !== headers.length) problems.push(`has ${cells.length} cells, the header has ${headers.length}`);
    for (const f of fields) {
      const h = headers.find((x) => own(mapping, x) === f.name);
      const v = h === undefined ? '' : (own(raw, h) ?? '').trim();
      if (v === '') {
        if (f.required) problems.push(`${f.label} is empty`);
        continue;
      }
      try {
        put(rec, f.name, f.parse ? f.parse(v) : v);
      } catch (e) {
        problems.push(`${f.label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (problems.length) quarantine.push({ row: i + 2, raw, problems });
    else good.push(rec);
  });
  return { good, quarantine, unmapped: headers.filter((h) => !own(mapping, h)), renamed };
}

export type MergeRule = 'first' | 'last' | 'longest' | 'nonEmpty' | ((values: unknown[]) => unknown);

/**
 * Groups by a key and merges each group by per-field rules; reports which source rows each merged row came from.
 * `nonEmpty` (the default) and `longest` pick among values that are not empty, and keep the first value when all are.
 */
export function dedupe<T extends Record<string, unknown>>(rows: readonly T[], key: (r: T) => string, rules: Readonly<Partial<Record<keyof T & string, MergeRule>>> = {} as Readonly<Partial<Record<keyof T & string, MergeRule>>>): { rows: T[]; merged: { key: string; from: number[] }[] } {
  const groups = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const k = key(r);
    const g = groups.get(k);
    if (g) g.push(i);
    else groups.set(k, [i]);
  });
  const out: T[] = [];
  const merged: { key: string; from: number[] }[] = [];
  for (const [k, idx] of groups) {
    const members = idx.map((i) => rows[i]!);
    if (idx.length > 1) merged.push({ key: k, from: idx });
    const fieldsSeen = [...new Set(members.flatMap((m) => Object.keys(m)))];
    const rec: Record<string, unknown> = {};
    for (const f of fieldsSeen) {
      const vals = members.map((m) => own(m, f));
      const rule = own(rules as Readonly<Record<string, MergeRule | undefined>>, f) ?? 'nonEmpty';
      const present = vals.filter((v) => v !== undefined && v !== null && v !== '');
      const picked = typeof rule === 'function' ? rule(vals) : rule === 'first' ? vals[0] : rule === 'last' ? vals.at(-1) : rule === 'longest' ? [...present].sort((a, b) => String(b).length - String(a).length)[0] : present[0];
      put(rec, f, typeof rule !== 'function' && present.length === 0 && (rule === 'nonEmpty' || rule === 'longest') ? vals.find((v) => v !== undefined) : picked);
    }
    out.push(rec as T);
  }
  return { rows: out, merged };
}

export const toJsonLines = (rows: readonly unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

/** A minimal zip writer (deflate), enough for .xlsx and .docx. */
export function zip(files: readonly { name: string; data: string | Uint8Array }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = typeof f.data === 'string' ? Buffer.from(f.data) : Buffer.from(f.data);
    const comp = deflateRawSync(raw);
    const name = Buffer.from(f.name);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0x00210000, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(0x00210000, 12);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/** Drops what XML 1.0 cannot carry at all: control characters, U+FFFE, U+FFFF, lone surrogates. */
const xclean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');

/** XML-escapes, after dropping what XML 1.0 cannot carry. */
const xesc = (s: string) => xclean(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A name Excel accepts for a sheet: none of \ / ? * : [ ], no apostrophe at either end, 1 to 31 UTF-16 units. */
const sheetName = (s: string) => {
  let n = '';
  for (const ch of s.replace(/[\\/?*:[\]]/g, ' ').replace(/^['\s]+|['\s]+$/g, '')) {
    if (n.length + ch.length > 31) break;
    n += ch;
  }
  return n.replace(/['\s]+$/, '') || 'Sheet1';
};

const colName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

/** The most text Excel keeps in one cell, in UTF-16 units. */
export const XLSX_CELL_LIMIT = 32767;

/** What `toXlsx` appends to text it cut to fit a cell. */
export const XLSX_TRUNCATED = '…[truncated]';

/** Cuts text to fit a cell with the marker at the end, never splitting a surrogate pair. */
const fitCell = (t: string) => {
  let end = XLSX_CELL_LIMIT - XLSX_TRUNCATED.length;
  const c = t.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return t.slice(0, end) + XLSX_TRUNCATED;
};

/**
 * An .xlsx workbook with one sheet; numbers and booleans stay as they are, null and undefined are blank cells,
 * everything else is inline text, and the first row is bold. Text longer than Excel's cell limit
 * (`XLSX_CELL_LIMIT`, 32,767 characters, counted after characters XML forbids are dropped) is refused with the
 * cell named, since Excel would cut it on opening; with `long: 'truncate'` it is cut to the limit instead, ending
 * in `XLSX_TRUNCATED` so a reader can see it was cut.
 */
export function toXlsx(rows: readonly (readonly unknown[])[], sheet = 'Sheet1', o: { long?: 'refuse' | 'truncate' } = {}): Buffer {
  const body = rows
    .map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      const ref = `${colName(ci)}${ri + 1}`;
      const s = ri === 0 ? ' s="1"' : '';
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
      if (typeof v === 'boolean') return `<c r="${ref}" t="b"${s}><v>${v ? 1 : 0}</v></c>`;
      if (v === null || v === undefined) return '';
      let text = xclean(v instanceof Date ? v.toISOString() : String(v));
      if (text.length > XLSX_CELL_LIMIT) {
        if (o.long !== 'truncate') throw new Error(`cell ${ref} holds ${text.length} characters, more than the ${XLSX_CELL_LIMIT} a spreadsheet cell can hold`);
        text = fitCell(text);
      }
      return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xesc(text)}</t></is></c>`;
    }).join('')}</row>`)
    .join('');
  const x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return zip([
    { name: '[Content_Types].xml', data: `${x}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: '_rels/.rels', data: `${x}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `${x}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xesc(sheetName(sheet))}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `${x}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: `${x}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
    { name: 'xl/worksheets/sheet1.xml', data: `${x}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>` },
  ]);
}
