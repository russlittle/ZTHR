/**
 * One way in for data from anywhere. Uploaded bytes or pasted text are recognised as CSV or TSV, an .xlsx workbook,
 * a .docx document, a JSON array, JSON lines, vCard contacts, iCalendar events, or a pasted table or list of email
 * addresses, and become a table with one header row. Text is read as UTF-8 (with or without a byte-order mark) or
 * UTF-16 with a byte-order mark; anything else is refused with what to do instead. Sizes, rows and columns have
 * limits that are checked before the rows are used. The table's columns are matched to the declared fields and
 * every row is checked: good rows come back as records, and each bad row goes to quarantine with where it was in
 * the source and every problem with it, so nothing is silently lost.
 */
import { Refused, docx, unzip, xlsx } from '../docparse/index.ts';
import { importRows, parseCsv, suggestMapping, type Field } from '../tabular/index.ts';
import { magicPaste } from '../ux/index.ts';

export { Refused };

export type Kind = 'csv' | 'tsv' | 'xlsx' | 'docx' | 'json' | 'jsonl' | 'vcard' | 'ical' | 'pasted table' | 'pasted emails';
export type Encoding = 'utf-8' | 'utf-8 with BOM' | 'utf-16le' | 'utf-16be';

export interface Input {
  /** The uploaded file's bytes. */
  readonly bytes?: Uint8Array;
  /** Text that was pasted or is already decoded. */
  readonly text?: string;
  /** The file name, used only as a hint for CSV and TSV. */
  readonly name?: string;
  /** True when the text came from the clipboard rather than a file. */
  readonly pasted?: boolean;
  /** For a workbook: the sheet to read; the first sheet with any cells otherwise. */
  readonly sheet?: string;
}

export interface Limits {
  readonly maxBytes?: number;
  readonly maxRows?: number;
  readonly maxColumns?: number;
}

export const DEFAULT_LIMITS = { maxBytes: 10 * 1024 * 1024, maxRows: 50_000, maxColumns: 500 } as const;

/** What was read: a header row, the rows under it, and where each row was in the source. */
export interface Table {
  readonly kind: Kind;
  readonly encoding?: Encoding;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** For each row, its place in the source, counted the way the source counts (row, line, item, contact, event, paragraph). */
  readonly at: readonly number[];
  readonly unit: 'row' | 'line' | 'item' | 'contact' | 'event' | 'paragraph';
  /** For a workbook, the names of all its sheets. */
  readonly sheets?: readonly string[];
  /** Pieces of the source that could not become rows, with why. */
  readonly skipped: readonly { readonly at: number; readonly raw: string; readonly problem: string }[];
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** Text from bytes: UTF-8 with or without BOM, or UTF-16 LE/BE with BOM. Anything else is refused. */
export function decode(bytes: Uint8Array): { text: string; encoding: Encoding } {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { text: utf8(b.subarray(3)), encoding: 'utf-8 with BOM' };
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) {
    const le = b[0] === 0xff;
    const body = b.subarray(2);
    if (body.length % 2) throw new Refused('The file says it is UTF-16 text but ends half way through a character. Save it again and retry.');
    const copy = Buffer.from(body);
    if (!le) copy.swap16();
    return { text: new TextDecoder('utf-16le', { fatal: true }).decode(copy), encoding: le ? 'utf-16le' : 'utf-16be' };
  }
  return { text: utf8(b), encoding: 'utf-8' };
}

function utf8(b: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    throw new Refused('The file is not UTF-8 text. Save it as CSV UTF-8 (or as UTF-16 with a byte-order mark) and try again.');
  }
  if (text.includes('\u0000')) throw new Refused('The file looks like binary data or UTF-16 without a byte-order mark. Save it as CSV UTF-8 and try again.');
  return text;
}

/** Refuses well-known binary formats that are not tables, with what to do instead. */
function refuseBinary(b: Uint8Array): void {
  const hex = Buffer.from(b.subarray(0, 8)).toString('hex');
  if (hex.startsWith('d0cf11e0')) throw new Refused('This is an older Excel (.xls) or Word (.doc) file, which cannot be read. Save it as .xlsx, .docx or CSV and try again.');
  if (hex.startsWith('25504446')) throw new Refused('PDF files cannot be imported. Export the table from the original as CSV or .xlsx and try again.');
  if (hex.startsWith('89504e47') || hex.startsWith('ffd8ff') || hex.startsWith('47494638')) throw new Refused('This is an image, not data. Copy the table as text, or save it as CSV, and try again.');
}

const unfold = (s: string) => s.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '');
const unescapeText = (v: string) => v.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));

interface Prop {
  readonly name: string;
  readonly params: Readonly<Record<string, string>>;
  readonly value: string;
}

/** One content line of vCard or iCalendar: GROUP.NAME;PARAM=V:value. */
function prop(line: string): Prop | undefined {
  let q = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') q = !q;
    else if (line[i] === ':' && !q) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return undefined;
  const [head, ...ps] = line.slice(0, colon).split(';');
  const params: Record<string, string> = {};
  for (const p of ps) {
    const [k, v] = p.split('=');
    if (k) params[k.toUpperCase()] = (v ?? '').replace(/^"|"$/g, '');
  }
  return { name: (head ?? '').toUpperCase().replace(/^.*\./, ''), params, value: line.slice(colon + 1) };
}

/** Keeps only the columns that have a value somewhere, in the declared order. */
function compact(cols: readonly string[], recs: readonly Record<string, string>[]): { headers: string[]; rows: string[][] } {
  const headers = cols.filter((c) => recs.some((r) => (r[c] ?? '') !== ''));
  return { headers, rows: recs.map((r) => headers.map((h) => r[h] ?? '')) };
}

const VCARD_COLS = ['Name', 'Given name', 'Family name', 'Email', 'Other emails', 'Phone', 'Other phones', 'Organization', 'Title', 'Address', 'Birthday', 'Note'];

function vcards(text: string): Omit<Table, 'kind'> {
  const recs: Record<string, string>[] = [];
  const at: number[] = [];
  let cur: { r: Record<string, string>; emails: string[]; phones: string[] } | undefined;
  for (const line of unfold(text).split('\n')) {
    const p = prop(line.trim());
    if (!p) continue;
    if (p.name === 'BEGIN' && p.value.toUpperCase() === 'VCARD') cur = { r: {}, emails: [], phones: [] };
    else if (p.name === 'END' && p.value.toUpperCase() === 'VCARD' && cur) {
      cur.r['Email'] = cur.emails[0] ?? '';
      cur.r['Other emails'] = cur.emails.slice(1).join(', ');
      cur.r['Phone'] = cur.phones[0] ?? '';
      cur.r['Other phones'] = cur.phones.slice(1).join(', ');
      recs.push(cur.r);
      at.push(recs.length);
      cur = undefined;
    } else if (cur) {
      const v = unescapeText(p.value);
      const parts = p.value.split(/(?<!\\);/).map((x) => unescapeText(x).trim());
      if (p.name === 'FN') cur.r['Name'] = v.trim();
      else if (p.name === 'N') {
        cur.r['Family name'] = parts[0] ?? '';
        cur.r['Given name'] = parts[1] ?? '';
      } else if (p.name === 'EMAIL') cur.emails.push(v.trim());
      else if (p.name === 'TEL') cur.phones.push(v.trim().replace(/^tel:/i, ''));
      else if (p.name === 'ORG') cur.r['Organization'] = parts.filter(Boolean).join(', ');
      else if (p.name === 'TITLE') cur.r['Title'] = v.trim();
      else if (p.name === 'ADR' && !cur.r['Address']) cur.r['Address'] = parts.filter(Boolean).join(', ');
      else if (p.name === 'BDAY') cur.r['Birthday'] = v.trim();
      else if (p.name === 'NOTE') cur.r['Note'] = v;
    }
  }
  if (cur) throw new Refused('The contacts file ends in the middle of a contact (a BEGIN:VCARD has no END:VCARD). Export the contacts again and retry.');
  for (const r of recs) if (!r['Name']) r['Name'] = [r['Given name'], r['Family name']].filter(Boolean).join(' ');
  return { ...compact(VCARD_COLS, recs), at, unit: 'contact', skipped: [] };
}

/** iCalendar date or date-time as ISO 8601: UTC keeps its Z, local times have none. */
function icalTime(p: Prop): { value: string; allDay: boolean; tz: string } {
  const v = p.value.trim();
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (d) return { value: `${d[1]}-${d[2]}-${d[3]}`, allDay: true, tz: '' };
  const t = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!t) return { value: v, allDay: false, tz: p.params['TZID'] ?? '' };
  return { value: `${t[1]}-${t[2]}-${t[3]}T${t[4]}:${t[5]}:${t[6]}${t[7]}`, allDay: false, tz: t[7] ? 'UTC' : p.params['TZID'] ?? '' };
}

const ICAL_COLS = ['Summary', 'Starts', 'Ends', 'Time zone', 'All day', 'Location', 'Description', 'Repeats', 'Status', 'UID'];

function icalendar(text: string): Omit<Table, 'kind'> {
  const recs: Record<string, string>[] = [];
  const at: number[] = [];
  const stack: string[] = [];
  let cur: Record<string, string> | undefined;
  for (const line of unfold(text).split('\n')) {
    const p = prop(line.trim());
    if (!p) continue;
    if (p.name === 'BEGIN') {
      stack.push(p.value.toUpperCase());
      if (p.value.toUpperCase() === 'VEVENT') cur = {};
      continue;
    }
    if (p.name === 'END') {
      const was = stack.pop();
      if (was === 'VEVENT' && cur) {
        recs.push(cur);
        at.push(recs.length);
        cur = undefined;
      }
      continue;
    }
    if (!cur || stack.at(-1) !== 'VEVENT') continue;
    if (p.name === 'SUMMARY') cur['Summary'] = unescapeText(p.value);
    else if (p.name === 'DTSTART' || p.name === 'DTEND') {
      const t = icalTime(p);
      cur[p.name === 'DTSTART' ? 'Starts' : 'Ends'] = t.value;
      if (p.name === 'DTSTART') {
        cur['All day'] = t.allDay ? 'yes' : '';
        cur['Time zone'] = t.tz;
      }
    } else if (p.name === 'LOCATION') cur['Location'] = unescapeText(p.value);
    else if (p.name === 'DESCRIPTION') cur['Description'] = unescapeText(p.value);
    else if (p.name === 'RRULE') cur['Repeats'] = p.value;
    else if (p.name === 'STATUS') cur['Status'] = p.value.toLowerCase();
    else if (p.name === 'UID') cur['UID'] = p.value;
  }
  if (stack.length) throw new Refused(`The calendar file ends inside a ${stack.at(-1)} that is never closed. Export the calendar again and retry.`);
  return { ...compact(ICAL_COLS, recs), at, unit: 'event', skipped: [] };
}

const cell = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function objects(items: readonly { at: number; value: Record<string, unknown> }[]): { headers: string[]; rows: string[][]; at: number[] } {
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const it of items)
    for (const k of Object.keys(it.value))
      if (!seen.has(k)) {
        seen.add(k);
        headers.push(k);
      }
  return { headers, rows: items.map((it) => headers.map((h) => cell(it.value[h]))), at: items.map((it) => it.at) };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function jsonArray(text: string): Omit<Table, 'kind'> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Refused(`The file starts like JSON but is not valid JSON (${e instanceof Error ? e.message : String(e)}). Fix it, or export the data as CSV, and try again.`);
  }
  if (!Array.isArray(v)) throw new Refused('The JSON is not a list of records. Give a list like [{"name": "Ana"}, {"name": "Ben"}].');
  const items: { at: number; value: Record<string, unknown> }[] = [];
  const skipped: { at: number; raw: string; problem: string }[] = [];
  v.forEach((x: unknown, i) => (isRecord(x) ? items.push({ at: i + 1, value: x }) : skipped.push({ at: i + 1, raw: cell(x), problem: 'is not a record with named fields' })));
  return { ...objects(items), unit: 'item', skipped };
}

function jsonLines(text: string): Omit<Table, 'kind'> {
  const items: { at: number; value: Record<string, unknown> }[] = [];
  const skipped: { at: number; raw: string; problem: string }[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const x: unknown = JSON.parse(line);
      if (isRecord(x)) items.push({ at: i + 1, value: x });
      else skipped.push({ at: i + 1, raw: line, problem: 'is not a record with named fields' });
    } catch {
      skipped.push({ at: i + 1, raw: line, problem: 'is not valid JSON' });
    }
  });
  return { ...objects(items), unit: 'line', skipped };
}

function separated(text: string, sep: string): Omit<Table, 'kind'> {
  let all: string[][];
  try {
    all = parseCsv(text, sep);
  } catch {
    throw new Refused('A quoted cell is opened and never closed, so the rows cannot be told apart. Check the file for a stray " and try again.');
  }
  const [headers = [], ...rows] = all;
  return { headers, rows, at: rows.map((_, i) => i + 2), unit: 'row', skipped: [] };
}

function pickSeparator(text: string, name: string | undefined): ',' | '\t' | ';' {
  const ext = name?.toLowerCase().match(/\.([a-z]+)$/)?.[1];
  const first = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const count = (c: string) => first.split(c).length - 1;
  if (ext === 'tsv' || ext === 'tab') return '\t';
  if (ext === 'csv') return count(';') > count(',') ? ';' : ',';
  const tabs = count('\t');
  const commas = count(',');
  const semis = count(';');
  if (tabs > commas && tabs >= semis) return '\t';
  return semis > commas ? ';' : ',';
}

function fromText(text: string, input: Input): Table {
  const t = text.replace(/^﻿/, '');
  const head = t.trimStart();
  if (!head) throw new Refused(input.pasted ? 'Nothing was pasted.' : 'The file is empty.');
  if (/^BEGIN:VCARD/i.test(head)) return { kind: 'vcard', ...vcards(t) };
  if (/^BEGIN:VCALENDAR/i.test(head)) return { kind: 'ical', ...icalendar(t) };
  if (head.startsWith('[')) return { kind: 'json', ...jsonArray(t) };
  if (head.startsWith('{')) return { kind: 'jsonl', ...jsonLines(t) };
  if (input.pasted) {
    const p = magicPaste(t);
    if (p.kind === 'table') {
      const [headers = [], ...rows] = p.rows;
      return { kind: 'pasted table', headers, rows, at: rows.map((_, i) => i + 2), unit: 'row', skipped: [] };
    }
    if (p.kind === 'emails') return { kind: 'pasted emails', headers: ['Email'], rows: p.emails.map((e) => [e]), at: p.emails.map((_, i) => i + 1), unit: 'item', skipped: p.rejected.map((r, i) => ({ at: p.emails.length + i + 1, raw: r, problem: 'is not an email address' })) };
    if (p.kind === 'url') throw new Refused('That is a link, not data. Download the file it points to and drop the file here instead.');
    throw new Refused('The pasted text is not a table or a list of email addresses. Copy cells from a spreadsheet, or paste one address per line.');
  }
  const sep = pickSeparator(t, input.name);
  return { kind: sep === '\t' ? 'tsv' : 'csv', ...separated(t, sep) };
}

function fromZip(b: Buffer, input: Input): Table {
  let names: string[];
  try {
    names = [...unzip(b).keys()];
  } catch (e) {
    throw new Refused(`The file could not be opened safely: ${e instanceof Error ? e.message : String(e)}. Save it again from the original program and retry.`);
  }
  if (names.includes('xl/workbook.xml')) {
    const sheets = xlsx(b);
    const names = sheets.map((s) => s.name);
    const s = input.sheet !== undefined ? sheets.find((x) => x.name === input.sheet) : sheets.find((x) => x.rows.some((r) => r.some((c) => c !== null && c !== '')));
    if (input.sheet !== undefined && !s) throw new Refused(`This workbook has no sheet called "${input.sheet}". Its sheets are ${names.join(', ')}.`);
    if (!s) throw new Refused('Every sheet in this workbook is empty.');
    const all = s.rows.map((r) => r.map((c) => (c === null ? '' : String(c))));
    let lastFilled = all.length;
    while (lastFilled > 0 && all[lastFilled - 1]!.every((c) => c === '')) lastFilled--;
    const firstIdx = all.findIndex((r) => r.some((c) => c !== ''));
    const used = all.slice(firstIdx, lastFilled);
    const width = Math.max(...used.map((r) => r.length));
    const [headers = [], ...rows] = used.map((r) => [...r, ...Array<string>(width - r.length).fill('')]);
    return { kind: 'xlsx', headers, rows, at: rows.map((_, i) => firstIdx + i + 2), unit: 'row', sheets: names, skipped: [] };
  }
  if (names.includes('word/document.xml')) {
    const paras = docx(b);
    const body = paras.filter((p) => p.heading === undefined);
    const cols = body[0]?.text.split('\t').length ?? 0;
    if (body.length >= 2 && cols >= 2 && body.every((p) => p.text.split('\t').length === cols)) {
      const [headers = [], ...rows] = body.map((p) => p.text.split('\t').map((c) => c.trim()));
      return { kind: 'docx', headers, rows, at: rows.map((_, i) => i + 2), unit: 'paragraph', skipped: [] };
    }
    const hasHeadings = paras.some((p) => p.heading !== undefined);
    const rows: string[][] = [];
    const at: number[] = [];
    let section = '';
    paras.forEach((p, i) => {
      if (p.heading !== undefined) section = p.text.trim();
      else {
        rows.push(hasHeadings ? [p.text.trim(), section] : [p.text.trim()]);
        at.push(i + 1);
      }
    });
    return { kind: 'docx', headers: hasHeadings ? ['Text', 'Section'] : ['Text'], rows, at, unit: 'paragraph', skipped: [] };
  }
  throw new Refused('This is a zip file, but not a spreadsheet (.xlsx) or a Word document (.docx). Unzip it and import the file inside.');
}

/** Gives each header a usable, unique name: blanks become "Column N", repeats get "(2)". */
function cleanHeaders(h: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return h.map((x, i) => {
    const base = x.trim() || `Column ${i + 1}`;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

/** Works out what the input is and reads it into one table, within the limits. */
export function read(input: Input, limits: Limits = {}): Table {
  const L = { ...DEFAULT_LIMITS, ...limits };
  if (input.bytes === undefined && input.text === undefined) throw new Refused('Nothing was given to import. Drop a file or paste some data.');
  const size = input.bytes ? input.bytes.byteLength : Buffer.byteLength(input.text ?? '');
  if (size > L.maxBytes) throw new Refused(`The ${input.pasted ? 'pasted text' : 'file'} is ${fmt(size)} bytes; the limit is ${fmt(L.maxBytes)}. Split it into smaller parts and import each.`);
  let t: Table;
  if (input.bytes) {
    const b = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
    if (!b.length) throw new Refused('The file is empty.');
    if (b.length >= 4 && b.readUInt32LE(0) === 0x04034b50) t = fromZip(b, input);
    else {
      refuseBinary(b);
      const d = decode(b);
      t = { ...fromText(d.text, input), encoding: d.encoding };
    }
  } else t = fromText(input.text ?? '', input);
  const firstSkip = t.skipped[0];
  if (!t.rows.length && firstSkip) throw new Refused(`None of the ${t.unit}s could be read; the first problem is ${t.unit} ${firstSkip.at}, which ${firstSkip.problem}.`);
  if (!t.headers.length || t.headers.every((h) => h.trim() === '')) throw new Refused(`No columns were found in the ${t.kind} data. The first row should name the columns.`);
  if (t.headers.length > L.maxColumns) throw new Refused(`There are ${fmt(t.headers.length)} columns; the limit is ${fmt(L.maxColumns)}. Remove the columns you do not need and try again.`);
  if (t.rows.length > L.maxRows) throw new Refused(`There are ${fmt(t.rows.length)} rows; the limit is ${fmt(L.maxRows)}. Split the data into smaller files and import each.`);
  if (!t.rows.length && !t.skipped.length) throw new Refused('There is a header row but no rows under it.');
  return { ...t, headers: cleanHeaders(t.headers) };
}

export interface Quarantined {
  /** The place in the source, counted in `unit`s. */
  readonly at: number;
  /** The same place in words, for the person: "row 3", "line 7", "contact 2". */
  readonly where: string;
  readonly raw: Readonly<Record<string, string>>;
  readonly problems: readonly string[];
}

export interface Imported {
  readonly kind: Kind;
  readonly encoding?: Encoding;
  readonly sheets?: readonly string[];
  readonly headers: readonly string[];
  readonly mapping: Readonly<Record<string, string | undefined>>;
  readonly good: Record<string, unknown>[];
  readonly quarantine: readonly Quarantined[];
  readonly unmapped: readonly string[];
  /** One sentence for the person: what was read and what needs fixing. */
  readonly summary: string;
}

const KIND_WORDS: Record<Kind, string> = { csv: 'a CSV file', tsv: 'a tab-separated file', xlsx: 'a spreadsheet', docx: 'a Word document', json: 'a JSON list', jsonl: 'a JSON lines file', vcard: 'a contacts file', ical: 'a calendar file', 'pasted table': 'a pasted table', 'pasted emails': 'a pasted list of addresses' };

/**
 * Reads anything `read` understands, matches its columns to the fields (the given mapping, or a suggested one),
 * and checks every row. A field that must be filled but has no column is refused before any row is kept.
 */
export function importFrom(input: Input, fields: readonly Field[], o: { mapping?: Readonly<Record<string, string | undefined>>; limits?: Limits } = {}): Imported {
  const t = read(input, o.limits);
  const mapping = o.mapping ?? suggestMapping(t.headers, fields);
  const unknown = Object.values(mapping).filter((f): f is string => f !== undefined && !fields.some((x) => x.name === f));
  if (unknown.length) throw new Refused(`The mapping names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is not a field' : 'are not fields'} here.`);
  let r: ReturnType<typeof importRows>;
  try {
    r = importRows([t.headers, ...t.rows], fields, mapping);
  } catch (e) {
    throw new Refused(`${(e instanceof Error ? e.message : String(e)).replace(/^no column/, 'No column')}. Choose which column holds it and try again.`);
  }
  const unit = t.unit;
  const quarantine: Quarantined[] = [
    ...r.quarantine.map((q) => {
      const at = t.at[q.row - 2] ?? q.row;
      return { at, where: `${unit} ${at}`, raw: q.raw, problems: q.problems };
    }),
    ...t.skipped.map((s) => ({ at: s.at, where: `${unit} ${s.at}`, raw: { [t.headers[0] ?? 'value']: s.raw }, problems: [s.problem] })),
  ].sort((a, b) => a.at - b.at);
  const n = r.good.length;
  const bad = quarantine.length;
  const plural = (k: number, w: string) => `${fmt(k)} ${w}${k === 1 ? '' : 's'}`;
  const summary = bad
    ? `Read ${KIND_WORDS[t.kind]}: ${plural(n, 'record')} ready, ${plural(bad, unit)} need${bad === 1 ? 's' : ''} fixing (${quarantine.slice(0, 5).map((q) => q.where).join(', ')}${bad > 5 ? ', …' : ''}).`
    : `Read ${KIND_WORDS[t.kind]}: ${n === 1 ? '1 record' : `all ${fmt(n)} records`} ready.`;
  return { kind: t.kind, ...(t.encoding ? { encoding: t.encoding } : {}), ...(t.sheets ? { sheets: t.sheets } : {}), headers: t.headers, mapping, good: r.good, quarantine, unmapped: r.unmapped, summary };
}
