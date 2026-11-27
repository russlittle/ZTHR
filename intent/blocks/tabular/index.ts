/**
 * Tables in and out. CSV is read and written to RFC 4180 (quoted fields, doubled quotes, line breaks inside quotes,
 * a byte-order mark tolerated) and cells that a spreadsheet would run as a formula are defused on export. An import
 * maps columns to fields (suggesting a mapping from the headers), checks every row and keeps the good ones while
 * the bad ones go to quarantine with their row number and reasons, to be fixed and retried. Duplicates are found
 * by a key and merged by rules that say which value wins. Exports go to CSV, JSON lines, or a real .xlsx file.
 */
import { crc32, deflateRawSync } from 'node:zlib';

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

export function toCsv(rows: readonly (readonly unknown[])[], o: { defuse?: boolean } = {}): string {
  return rows
    .map((r) =>
      r
        .map((v) => {
          let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
          if (o.defuse !== false && typeof v === 'string') s = defuse(s);
          return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    )
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

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** For each header, the field it most likely is (exact, alias, then contained), or undefined. */
export function suggestMapping(headers: readonly string[], fields: readonly Field[]): Record<string, string | undefined> {
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
    out[h] = f;
  }
  return out;
}

export interface Quarantined {
  readonly row: number;
  readonly raw: Readonly<Record<string, string>>;
  readonly problems: readonly string[];
}

export function importRows(table: readonly (readonly string[])[], fields: readonly Field[], mapping: Readonly<Record<string, string | undefined>>): { good: Record<string, unknown>[]; quarantine: Quarantined[]; unmapped: string[] } {
  const [headers, ...rows] = table;
  if (!headers) return { good: [], quarantine: [], unmapped: [] };
  const missingCols = fields.filter((f) => f.required && !Object.values(mapping).includes(f.name)).map((f) => f.label);
  if (missingCols.length) throw new Error(`no column is mapped to ${missingCols.join(', ')}`);
  const good: Record<string, unknown>[] = [];
  const quarantine: Quarantined[] = [];
  rows.forEach((cells, i) => {
    if (cells.every((c) => c.trim() === '')) return;
    const raw: Record<string, string> = {};
    headers.forEach((h, j) => (raw[h] = cells[j] ?? ''));
    const rec: Record<string, unknown> = {};
    const problems: string[] = [];
    if (cells.length !== headers.length) problems.push(`has ${cells.length} cells, the header has ${headers.length}`);
    for (const f of fields) {
      const h = headers.find((x) => mapping[x] === f.name);
      const v = h === undefined ? '' : (raw[h] ?? '').trim();
      if (v === '') {
        if (f.required) problems.push(`${f.label} is empty`);
        continue;
      }
      try {
        rec[f.name] = f.parse ? f.parse(v) : v;
      } catch (e) {
        problems.push(`${f.label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (problems.length) quarantine.push({ row: i + 2, raw, problems });
    else good.push(rec);
  });
  return { good, quarantine, unmapped: headers.filter((h) => !mapping[h]) };
}

export type MergeRule = 'first' | 'last' | 'longest' | 'nonEmpty' | ((values: unknown[]) => unknown);

/** Groups by a key and merges each group by per-field rules; reports which source rows each merged row came from. */
export function dedupe<T extends Record<string, unknown>>(rows: readonly T[], key: (r: T) => string, rules: Readonly<Partial<Record<keyof T & string, MergeRule>>> = {} as Readonly<Partial<Record<keyof T & string, MergeRule>>>): { rows: T[]; merged: { key: string; from: number[] }[] } {
  const groups = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const k = key(r);
    groups.set(k, [...(groups.get(k) ?? []), i]);
  });
  const out: T[] = [];
  const merged: { key: string; from: number[] }[] = [];
  for (const [k, idx] of groups) {
    const members = idx.map((i) => rows[i]!);
    if (idx.length > 1) merged.push({ key: k, from: idx });
    const fieldsSeen = [...new Set(members.flatMap((m) => Object.keys(m)))];
    const rec: Record<string, unknown> = {};
    for (const f of fieldsSeen) {
      const vals = members.map((m) => m[f]);
      const rule = rules[f as keyof T & string] ?? 'nonEmpty';
      const present = vals.filter((v) => v !== undefined && v !== null && v !== '');
      rec[f] = typeof rule === 'function' ? rule(vals) : rule === 'first' ? vals[0] : rule === 'last' ? vals.at(-1) : rule === 'longest' ? [...present].sort((a, b) => String(b).length - String(a).length)[0] : present[0];
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

const xesc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

const colName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

/** An .xlsx workbook with one sheet; numbers stay numbers, everything else is inline text, the first row is bold. */
export function toXlsx(rows: readonly (readonly unknown[])[], sheet = 'Sheet1'): Buffer {
  const body = rows
    .map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      const ref = `${colName(ci)}${ri + 1}`;
      const s = ri === 0 ? ' s="1"' : '';
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
      if (typeof v === 'boolean') return `<c r="${ref}" t="b"${s}><v>${v ? 1 : 0}</v></c>`;
      const text = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
      return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xesc(text)}</t></is></c>`;
    }).join('')}</row>`)
    .join('');
  const x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return zip([
    { name: '[Content_Types].xml', data: `${x}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: '_rels/.rels', data: `${x}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `${x}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xesc(sheet.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `${x}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: `${x}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font/><font><b/></font></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>` },
    { name: 'xl/worksheets/sheet1.xml', data: `${x}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>` },
  ]);
}
