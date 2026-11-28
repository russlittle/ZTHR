/**
 * iCalendar (RFC 5545) read and write. Text is unfolded and split into content lines (property, parameters, value;
 * parameter quoting and the RFC 6868 caret encoding), nested into components (VCALENDAR holding VEVENT, VTODO,
 * VJOURNAL, VFREEBUSY, VTIMEZONE with its STANDARD and DAYLIGHT, and VALARM inside events and todos), and written
 * back folded at 75 octets without splitting a character. A component keeps every property it was given, so
 * unknown and X- properties survive a round trip. On top of that sit typed readers and builders for events, todos
 * and alarms (dates, date-times in UTC, floating or with a TZID, durations, periods, text escaping), a VTIMEZONE
 * evaluator that gives the UTC offset at any instant from the observances' onsets (yearly BYMONTH rules and RDATEs),
 * a generator that writes a VTIMEZONE for any IANA zone and year range, and expansion of recurring events into
 * instances: RRULE, RDATE and EXDATE, with RECURRENCE-ID overrides replacing or cancelling single instances. Recurrence
 * itself is computed by the time block in wall time, so a 9:00 meeting stays at 9:00 across daylight-saving changes;
 * its supported RRULE subset applies (other parts, such as BYMONTH on a rule or BYSETPOS, are refused, not ignored).
 *
 * Input is bounded (size, lines, depth, components) and nothing is fetched or evaluated. Floating times are read
 * as wall times in UTC; all-day events (VALUE=DATE) are expanded as whole days.
 *
 * Out of scope: iTIP scheduling methods (the caldav block carries the scheduling inbox), RRULE parts beyond the
 * time block's subset, and VFREEBUSY computation.
 */
import { instant, occurrences, offset, parseRule, wallOf } from '../time/index.ts';
import type { Wall } from '../time/index.ts';

export class BadCalendar extends Error {}

export interface Param { readonly [name: string]: readonly string[] }
export interface Property { readonly name: string; readonly params: Param; readonly value: string }
export interface Component { readonly name: string; readonly properties: Property[]; readonly components: Component[] }

export interface Limits { readonly maxBytes?: number; readonly maxLines?: number; readonly maxDepth?: number; readonly maxComponents?: number }

// --- content lines ----------------------------------------------------------------------------------------------

/** Join folded lines (a line break followed by one space or tab continues the previous line). */
export function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length) out[out.length - 1] += raw.slice(1);
    else out.push(raw);
  }
  while (out.length && out.at(-1) === '') out.pop();
  return out;
}

/** Fold a line at 75 octets, never inside a UTF-8 character; continuation lines start with one space. */
export function fold(line: string): string {
  if (Buffer.byteLength(line) <= 75) return line;
  const parts: string[] = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > limit) { parts.push(cur); cur = ''; bytes = 0; limit = 74; }
    cur += ch;
    bytes += n;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

const decodeParam = (v: string) => v.replace(/\^(\^|n|')/g, (_, c: string) => (c === '^' ? '^' : c === 'n' ? '\n' : '"'));
const encodeParam = (v: string) => v.replace(/\^/g, '^^').replace(/\r?\n/g, '^n').replace(/"/g, "^'");

export function parseContentLine(line: string): Property {
  let i = 0;
  const n = line.length;
  while (i < n && /[A-Za-z0-9-]/.test(line[i]!)) i++;
  const name = line.slice(0, i).toUpperCase();
  if (!name) throw new BadCalendar(`line has no property name: ${line.slice(0, 40)}`);
  const params: Record<string, string[]> = Object.create(null);
  while (line[i] === ';') {
    i++;
    const s = i;
    while (i < n && /[A-Za-z0-9-]/.test(line[i]!)) i++;
    const pname = line.slice(s, i).toUpperCase();
    if (!pname || line[i] !== '=') throw new BadCalendar(`bad parameter in: ${line.slice(0, 60)}`);
    i++;
    const values: string[] = [];
    for (;;) {
      if (line[i] === '"') {
        const e = line.indexOf('"', i + 1);
        if (e < 0) throw new BadCalendar('an unclosed quote in a parameter');
        values.push(decodeParam(line.slice(i + 1, e)));
        i = e + 1;
      } else {
        const s2 = i;
        while (i < n && !';:,'.includes(line[i]!)) i++;
        values.push(decodeParam(line.slice(s2, i)));
      }
      if (line[i] === ',') { i++; continue; }
      break;
    }
    (params[pname] ??= []).push(...values);
  }
  if (line[i] !== ':') throw new BadCalendar(`missing ":" in: ${line.slice(0, 60)}`);
  return { name, params, value: line.slice(i + 1) };
}

export function formatContentLine(p: Property): string {
  let s = p.name;
  for (const [k, vs] of Object.entries(p.params)) s += `;${k}=${vs.map((v) => { const e = encodeParam(v); return /[;:,]/.test(e) || e === '' ? `"${e}"` : e; }).join(',')}`;
  return fold(`${s}:${p.value}`);
}

// --- components -------------------------------------------------------------------------------------------------

export function parseComponents(text: string, limits: Limits = {}): Component[] {
  const maxBytes = limits.maxBytes ?? 5_000_000;
  if (Buffer.byteLength(text) > maxBytes) throw new BadCalendar(`the calendar is larger than ${maxBytes} bytes`);
  if (text.includes('\u0000')) throw new BadCalendar('the calendar has a NUL character');
  const lines = unfold(text.replace(/^\uFEFF/, ''));
  if (lines.length > (limits.maxLines ?? 200_000)) throw new BadCalendar('the calendar has too many lines');
  const roots: Component[] = [];
  const stack: Component[] = [];
  let count = 0;
  for (const line of lines) {
    if (line === '') continue;
    const p = parseContentLine(line);
    if (p.name === 'BEGIN') {
      const c: Component = { name: p.value.toUpperCase(), properties: [], components: [] };
      if (++count > (limits.maxComponents ?? 50_000)) throw new BadCalendar('the calendar has too many components');
      if (stack.length >= (limits.maxDepth ?? 8)) throw new BadCalendar('components are nested too deeply');
      if (stack.length === 0 && c.name !== 'VCALENDAR') throw new BadCalendar(`expected BEGIN:VCALENDAR, found BEGIN:${c.name}`);
      (stack.at(-1)?.components ?? roots).push(c);
      stack.push(c);
    } else if (p.name === 'END') {
      const top = stack.pop();
      if (!top) throw new BadCalendar(`END:${p.value} without BEGIN`);
      if (top.name !== p.value.toUpperCase()) throw new BadCalendar(`END:${p.value} does not match BEGIN:${top.name}`);
    } else {
      const top = stack.at(-1);
      if (!top) throw new BadCalendar(`property ${p.name} outside any component`);
      top.properties.push(p);
    }
  }
  if (stack.length) throw new BadCalendar(`BEGIN:${stack.at(-1)!.name} is never closed`);
  if (roots.length === 0) throw new BadCalendar('there is no VCALENDAR');
  return roots;
}

export function writeComponent(c: Component): string {
  const out: string[] = [`BEGIN:${c.name}`];
  for (const p of c.properties) out.push(formatContentLine(p));
  for (const sub of c.components) out.push(writeComponent(sub).replace(/\r\n$/, ''));
  out.push(`END:${c.name}`);
  return `${out.join('\r\n')}\r\n`;
}

export const prop = (name: string, value: string, params: Record<string, string | readonly string[]> = {}): Property => ({
  name: name.toUpperCase(),
  params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k.toUpperCase(), typeof v === 'string' ? [v] : [...v]])),
  value,
});

export const first = (c: Component, name: string): Property | undefined => c.properties.find((p) => p.name === name);
export const all = (c: Component, name: string): Property[] => c.properties.filter((p) => p.name === name);
export const param = (p: Property, name: string): string | undefined => p.params[name]?.[0];

// --- values -----------------------------------------------------------------------------------------------------

/** TEXT values: backslash, semicolon, comma and newline are escaped. */
export const escapeText = (s: string): string => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
export const unescapeText = (s: string): string => s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
/** Split a list of text values on unescaped commas (CATEGORIES). */
export const splitList = (s: string): string[] => { const out: string[] = []; let cur = ''; for (let i = 0; i < s.length; i++) { if (s[i] === '\\' && i + 1 < s.length) { cur += s[i]! + s[++i]!; } else if (s[i] === ',') { out.push(cur); cur = ''; } else cur += s[i]; } out.push(cur); return out; };

export type DateValue =
  | { readonly kind: 'date'; readonly y: number; readonly m: number; readonly d: number }
  | { readonly kind: 'floating'; readonly wall: Wall & { readonly s?: number } }
  | { readonly kind: 'utc'; readonly at: Date }
  | { readonly kind: 'zoned'; readonly wall: Wall; readonly tzid: string };

const dim = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function parseDateValue(value: string, tzid?: string, asDate = false): DateValue {
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (d) {
    const [y, m, dd] = [Number(d[1]), Number(d[2]), Number(d[3])];
    if (m < 1 || m > 12 || dd < 1 || dd > dim(y, m)) throw new BadCalendar(`${value} is not a real date`);
    return { kind: 'date', y, m, d: dd };
  }
  if (asDate) throw new BadCalendar(`${value} is not a DATE`);
  const t = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!t) throw new BadCalendar(`${value} is not a DATE or DATE-TIME`);
  const [y, m, dd, h, min, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(t[i]));
  if (m! < 1 || m! > 12 || dd! < 1 || dd! > dim(y!, m!) || h! > 23 || min! > 59 || s! > 60) throw new BadCalendar(`${value} is not a real date and time`);
  if (t[7]) return { kind: 'utc', at: new Date(Date.UTC(y!, m! - 1, dd!, h!, min!, Math.min(s!, 59))) };
  const wall = { y: y!, m: m!, d: dd!, h: h!, min: min! };
  return tzid ? { kind: 'zoned', wall, tzid } : { kind: 'floating', wall };
}

const p2 = (n: number) => String(n).padStart(2, '0');
const p4 = (n: number) => String(n).padStart(4, '0');

export function formatDateValue(v: DateValue): { value: string; params: Record<string, string> } {
  if (v.kind === 'date') return { value: `${p4(v.y)}${p2(v.m)}${p2(v.d)}`, params: { VALUE: 'DATE' } };
  if (v.kind === 'utc') { const a = v.at; return { value: `${p4(a.getUTCFullYear())}${p2(a.getUTCMonth() + 1)}${p2(a.getUTCDate())}T${p2(a.getUTCHours())}${p2(a.getUTCMinutes())}${p2(a.getUTCSeconds())}Z`, params: {} }; }
  const w = v.wall;
  return { value: `${p4(w.y)}${p2(w.m)}${p2(w.d)}T${p2(w.h)}${p2(w.min)}00`, params: v.kind === 'zoned' ? { TZID: v.tzid } : {} };
}

export const dateProp = (name: string, v: DateValue): Property => { const f = formatDateValue(v); return prop(name, f.value, f.params); };
export const readDate = (p: Property): DateValue => parseDateValue(p.value, param(p, 'TZID'), param(p, 'VALUE') === 'DATE');

export interface Duration { readonly sign: 1 | -1; readonly weeks: number; readonly days: number; readonly hours: number; readonly minutes: number; readonly seconds: number }

export function parseDuration(s: string): Duration {
  const m = /^([+-])?P(?:(\d+)W|(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/.exec(s);
  if (!m || s.endsWith('T') || s === 'P' || s === '+P' || s === '-P') throw new BadCalendar(`${s} is not a DURATION`);
  const n = (x: string | undefined) => Number(x ?? 0);
  return { sign: m[1] === '-' ? -1 : 1, weeks: n(m[2]), days: n(m[3]), hours: n(m[4]), minutes: n(m[5]), seconds: n(m[6]) };
}

export const durationMs = (d: Duration): number => d.sign * (((d.weeks * 7 + d.days) * 24 + d.hours) * 3600 + d.minutes * 60 + d.seconds) * 1000;

export function formatDuration(d: Duration): string {
  if (d.weeks) return `${d.sign < 0 ? '-' : ''}P${d.weeks}W`;
  const t = `${d.hours ? `${d.hours}H` : ''}${d.minutes ? `${d.minutes}M` : ''}${d.seconds ? `${d.seconds}S` : ''}`;
  if (!d.days && !t) return 'PT0S';
  return `${d.sign < 0 ? '-' : ''}P${d.days ? `${d.days}D` : ''}${t ? `T${t}` : ''}`;
}

export function parseUtcOffset(s: string): number {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(s);
  if (!m || Number(m[2]) > 23 || Number(m[3]) > 59) throw new BadCalendar(`${s} is not a UTC-OFFSET`);
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}
export const formatUtcOffset = (minutes: number): string => `${minutes < 0 ? '-' : '+'}${p2(Math.floor(Math.abs(minutes) / 60))}${p2(Math.abs(minutes) % 60)}`;

export function parsePeriod(s: string, tzid?: string): { start: DateValue; end?: DateValue; duration?: Duration } {
  const [a, b] = s.split('/');
  if (!a || !b) throw new BadCalendar(`${s} is not a PERIOD`);
  const start = parseDateValue(a, tzid);
  return b.startsWith('P') || b.startsWith('+P') || b.startsWith('-P') ? { start, duration: parseDuration(b) } : { start, end: parseDateValue(b, tzid) };
}

// --- time zones -------------------------------------------------------------------------------------------------

export interface Observance { readonly kind: 'STANDARD' | 'DAYLIGHT'; readonly name?: string; readonly from: number; readonly to: number; readonly onsets: (year: number) => number[] }

export interface Zone {
  readonly tzid: string;
  readonly observances: readonly Observance[];
  /** Minutes ahead of UTC at an instant. */
  offsetAt(at: Date): number;
  /** The instant for a wall time; a time in a gap moves forward, a repeated time takes the first. */
  toInstant(w: Wall): Date;
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** The wall-clock ms (as if UTC) of a yearly onset in a given year, or none. */
function yearlyOnset(start: DateValue & { kind: 'floating' | 'zoned' | 'utc' | 'date' }, rule: Record<string, string>, year: number): number[] {
  const w = start.kind === 'floating' || start.kind === 'zoned' ? start.wall : start.kind === 'utc' ? wallOf(start.at, 'UTC') : { y: start.y, m: start.m, d: start.d, h: 0, min: 0 };
  const months = (rule.BYMONTH ?? String(w.m)).split(',').map(Number);
  const out: number[] = [];
  for (const m of months) {
    const n = dim(year, m);
    let days: number[];
    if (rule.BYDAY) {
      days = rule.BYDAY.split(',').flatMap((x) => {
        const r = /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x);
        if (!r) throw new BadCalendar(`bad BYDAY ${x} in a time zone rule`);
        const dow = DAYS.indexOf(r[2]!);
        const list = Array.from({ length: n }, (_, i) => i + 1).filter((d) => new Date(Date.UTC(year, m - 1, d)).getUTCDay() === dow);
        if (!r[1]) return list;
        const k = Number(r[1]);
        const pick = k > 0 ? list[k - 1] : list[list.length + k];
        return pick ? [pick] : [];
      });
      if (rule.BYMONTHDAY) { const md = rule.BYMONTHDAY.split(',').map((x) => (Number(x) < 0 ? n + Number(x) + 1 : Number(x))); days = days.filter((d) => md.includes(d)); }
    } else if (rule.BYMONTHDAY) days = rule.BYMONTHDAY.split(',').map((x) => (Number(x) < 0 ? n + Number(x) + 1 : Number(x)));
    else days = [w.d];
    for (const d of days) out.push(Date.UTC(year, m - 1, d, w.h, w.min));
  }
  return out;
}

/** Read a VTIMEZONE component into something that can answer "what is the offset then". */
export function readZone(c: Component): Zone {
  if (c.name !== 'VTIMEZONE') throw new BadCalendar(`expected VTIMEZONE, got ${c.name}`);
  const tzid = first(c, 'TZID')?.value;
  if (!tzid) throw new BadCalendar('a VTIMEZONE needs a TZID');
  const obs: Observance[] = c.components.filter((x) => x.name === 'STANDARD' || x.name === 'DAYLIGHT').map((x) => {
    const dt = first(x, 'DTSTART');
    const f = first(x, 'TZOFFSETFROM'), t = first(x, 'TZOFFSETTO');
    if (!dt || !f || !t) throw new BadCalendar(`${x.name} in ${tzid} needs DTSTART, TZOFFSETFROM and TZOFFSETTO`);
    const start = readDate(dt);
    if (start.kind === 'utc') throw new BadCalendar('an observance DTSTART must be local time');
    const from = parseUtcOffset(f.value), to = parseUtcOffset(t.value);
    const rr = first(x, 'RRULE');
    const rule: Record<string, string> = Object.create(null);
    if (rr) for (const part of rr.value.split(';')) { const [k, v] = part.split('='); if (k && v !== undefined) rule[k.toUpperCase()] = v; }
    if (rr && rule.FREQ !== 'YEARLY') throw new BadCalendar(`time zone ${tzid}: only FREQ=YEARLY rules are supported`);
    const untilMs = rule.UNTIL ? (() => { const u = parseDateValue(rule.UNTIL!); return u.kind === 'utc' ? u.at.getTime() : u.kind === 'date' ? Date.UTC(u.y, u.m - 1, u.d, 23, 59) : Date.UTC(u.wall.y, u.wall.m - 1, u.wall.d, u.wall.h, u.wall.min) - from * 60_000; })() : Infinity;
    const rdates = all(x, 'RDATE').flatMap((r) => r.value.split(',').map((v) => parseDateValue(v)).map((v) => (v.kind === 'floating' || v.kind === 'zoned' ? Date.UTC(v.wall.y, v.wall.m - 1, v.wall.d, v.wall.h, v.wall.min) : v.kind === 'utc' ? v.at.getTime() + from * 60_000 : Date.UTC(v.y, v.m - 1, v.d))));
    const startWallMs = start.kind === 'date' ? Date.UTC(start.y, start.m - 1, start.d) : Date.UTC(start.wall.y, start.wall.m - 1, start.wall.d, start.wall.h, start.wall.min);
    const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
    return {
      kind: x.name as 'STANDARD' | 'DAYLIGHT',
      ...(first(x, 'TZNAME') ? { name: first(x, 'TZNAME')!.value } : {}),
      from, to,
      onsets: (year: number) => {
        const list = new Set<number>();
        if (!rr) list.add(startWallMs); else {
          const startYear = new Date(startWallMs).getUTCFullYear();
          const step = Number(rule.INTERVAL ?? 1);
          if (year >= startYear && (year - startYear) % step === 0) {
            const nth = (year - startYear) / step;
            if (nth < count) for (const ms of yearlyOnset(start, rule, year)) if (ms >= startWallMs && ms - from * 60_000 <= untilMs) list.add(ms);
          }
        }
        for (const r of rdates) if (new Date(r).getUTCFullYear() === year) list.add(r);
        if (!rr && !rdates.length) return [...list].filter((ms) => new Date(ms).getUTCFullYear() === year).map((ms) => ms - from * 60_000);
        return [...list].map((ms) => ms - from * 60_000);
      },
    };
  });
  if (obs.length === 0) throw new BadCalendar(`time zone ${tzid} has no STANDARD or DAYLIGHT part`);
  const transitions = (fromYear: number, toYear: number) => obs.flatMap((o) => { const r: { at: number; to: number }[] = []; for (let y = fromYear; y <= toYear; y++) for (const at of o.onsets(y)) r.push({ at, to: o.to }); return r; }).sort((a, b) => a.at - b.at);
  const offsetAt = (at: Date): number => {
    const y = at.getUTCFullYear();
    const tr = transitions(Math.max(1900, y - 2), y + 1).filter((t) => t.at <= at.getTime());
    if (tr.length) return tr.at(-1)!.to;
    const earliest = [...obs].sort((a, b) => Math.min(...a.onsets(y)) - Math.min(...b.onsets(y)))[0]!;
    return earliest.from;
  };
  const toInstant = (w: Wall): Date => {
    const guess = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min);
    const cands = [...new Set([offsetAt(new Date(guess - 86_400_000)), offsetAt(new Date(guess + 86_400_000))])].map((o) => guess - o * 60_000).filter((t) => { const o = offsetAt(new Date(t)); return t + o * 60_000 === guess; });
    if (cands.length) return new Date(Math.min(...cands));
    return new Date(guess - offsetAt(new Date(guess - 86_400_000)) * 60_000);
  };
  return { tzid, observances: obs, offsetAt, toInstant };
}

/** A VTIMEZONE for an IANA zone covering a range of years, with one observance per distinct change. */
export function zoneComponent(tzid: string, fromYear: number, toYear: number): Component {
  if (fromYear > toYear || toYear - fromYear > 100) throw new BadCalendar('choose a year range of at most 100 years');
  const changes: { at: Date; from: number; to: number }[] = [];
  let prev = offset(new Date(Date.UTC(fromYear, 0, 1)), tzid);
  for (let t = Date.UTC(fromYear, 0, 1); t < Date.UTC(toYear + 1, 0, 1); t += 3_600_000 * 6) {
    const o = offset(new Date(t + 3_600_000 * 6), tzid);
    if (o !== prev) {
      let lo = t, hi = t + 3_600_000 * 6;
      while (hi - lo > 60_000) { const mid = Math.floor((lo + hi) / 2 / 60_000) * 60_000; if (offset(new Date(mid), tzid) === prev) lo = mid; else hi = mid; }
      changes.push({ at: new Date(hi), from: prev, to: o });
      prev = o;
    }
  }
  const comp: Component = { name: 'VTIMEZONE', properties: [prop('TZID', tzid), prop('X-LIC-LOCATION', tzid)], components: [] };
  const base = offset(new Date(Date.UTC(fromYear, 0, 1)), tzid);
  const stdOffset = Math.min(...[base, ...changes.map((c) => c.to)]);
  const group = new Map<string, { kind: 'STANDARD' | 'DAYLIGHT'; from: number; to: number; rdates: string[]; first: string }>();
  for (const c of changes) {
    const kind = c.to > stdOffset ? 'DAYLIGHT' : 'STANDARD';
    const wall = wallOf(new Date(c.at.getTime() + c.from * 60_000), 'UTC');
    const w = formatDateValue({ kind: 'floating', wall }).value;
    const key = `${kind}:${c.from}:${c.to}`;
    const g = group.get(key) ?? { kind, from: c.from, to: c.to, rdates: [], first: w };
    g.rdates.push(w);
    group.set(key, g);
  }
  if (changes.length === 0) comp.components.push({ name: 'STANDARD', properties: [prop('DTSTART', `${p4(fromYear)}0101T000000`), prop('TZOFFSETFROM', formatUtcOffset(base)), prop('TZOFFSETTO', formatUtcOffset(base))], components: [] });
  for (const g of group.values()) comp.components.push({ name: g.kind, properties: [prop('DTSTART', g.first), ...g.rdates.map((r) => prop('RDATE', r)), prop('TZOFFSETFROM', formatUtcOffset(g.from)), prop('TZOFFSETTO', formatUtcOffset(g.to))], components: [] });
  return comp;
}

// --- events, todos, alarms --------------------------------------------------------------------------------------

export interface Alarm {
  readonly action: 'DISPLAY' | 'AUDIO' | 'EMAIL';
  /** Either a time relative to the start or end of the parent, or an absolute instant. */
  readonly trigger: { readonly relative: Duration; readonly from: 'START' | 'END' } | { readonly at: Date };
  readonly description?: string;
  readonly repeat?: number;
  readonly duration?: Duration;
}

export interface Event {
  readonly kind: 'VEVENT' | 'VTODO';
  readonly uid: string;
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly categories: readonly string[];
  readonly status?: string;
  readonly sequence: number;
  readonly dtstamp?: Date;
  readonly start?: DateValue;
  /** VEVENT DTEND, or VTODO DUE. */
  readonly end?: DateValue;
  readonly duration?: Duration;
  readonly rrule?: string;
  readonly rdates: readonly DateValue[];
  readonly exdates: readonly DateValue[];
  readonly recurrenceId?: DateValue;
  readonly alarms: readonly Alarm[];
  readonly percentComplete?: number;
  readonly completed?: Date;
}

const textOf = (c: Component, n: string) => { const p = first(c, n); return p ? unescapeText(p.value) : undefined; };
const dates = (c: Component, n: string) => all(c, n).flatMap((p) => p.value.split(',').map((v) => readDate({ ...p, value: v })));

export function readAlarm(c: Component): Alarm {
  const action = first(c, 'ACTION')?.value.toUpperCase();
  if (action !== 'DISPLAY' && action !== 'AUDIO' && action !== 'EMAIL') throw new BadCalendar(`VALARM action ${action ?? '(none)'} is not supported`);
  const t = first(c, 'TRIGGER');
  if (!t) throw new BadCalendar('a VALARM needs a TRIGGER');
  const d = textOf(c, 'DESCRIPTION');
  const rep = first(c, 'REPEAT'), dur = first(c, 'DURATION');
  return {
    action,
    trigger: param(t, 'VALUE') === 'DATE-TIME' ? (() => { const v = parseDateValue(t.value); if (v.kind !== 'utc') throw new BadCalendar('an absolute TRIGGER must be in UTC'); return { at: v.at }; })() : { relative: parseDuration(t.value), from: param(t, 'RELATED') === 'END' ? 'END' as const : 'START' as const },
    ...(d !== undefined ? { description: d } : {}),
    ...(rep ? { repeat: Number(rep.value) } : {}),
    ...(dur ? { duration: parseDuration(dur.value) } : {}),
  };
}

export function readEvent(c: Component): Event {
  if (c.name !== 'VEVENT' && c.name !== 'VTODO') throw new BadCalendar(`expected VEVENT or VTODO, got ${c.name}`);
  const uid = first(c, 'UID')?.value;
  if (!uid) throw new BadCalendar(`a ${c.name} needs a UID`);
  const kind = c.name;
  const startP = first(c, 'DTSTART'), endP = first(c, kind === 'VEVENT' ? 'DTEND' : 'DUE'), dur = first(c, 'DURATION'), rr = first(c, 'RRULE'), rid = first(c, 'RECURRENCE-ID'), stamp = first(c, 'DTSTAMP');
  if (endP && dur) throw new BadCalendar(`${uid}: ${kind === 'VEVENT' ? 'DTEND' : 'DUE'} and DURATION cannot both be given`);
  const summary = textOf(c, 'SUMMARY'), description = textOf(c, 'DESCRIPTION'), location = textOf(c, 'LOCATION'), status = first(c, 'STATUS')?.value.toUpperCase();
  const pc = first(c, 'PERCENT-COMPLETE'), done = first(c, 'COMPLETED');
  return {
    kind, uid,
    ...(summary !== undefined ? { summary } : {}), ...(description !== undefined ? { description } : {}), ...(location !== undefined ? { location } : {}),
    categories: all(c, 'CATEGORIES').flatMap((p) => splitList(p.value).map(unescapeText)),
    ...(status ? { status } : {}),
    sequence: Number(first(c, 'SEQUENCE')?.value ?? 0),
    ...(stamp ? (() => { const v = readDate(stamp); return v.kind === 'utc' ? { dtstamp: v.at } : {}; })() : {}),
    ...(startP ? { start: readDate(startP) } : {}), ...(endP ? { end: readDate(endP) } : {}), ...(dur ? { duration: parseDuration(dur.value) } : {}),
    ...(rr ? { rrule: rr.value } : {}),
    rdates: dates(c, 'RDATE'), exdates: dates(c, 'EXDATE'),
    ...(rid ? { recurrenceId: readDate(rid) } : {}),
    alarms: c.components.filter((x) => x.name === 'VALARM').map(readAlarm),
    ...(pc ? { percentComplete: Number(pc.value) } : {}),
    ...(done ? (() => { const v = readDate(done); return v.kind === 'utc' ? { completed: v.at } : {}; })() : {}),
  };
}

export function buildEvent(e: Event): Component {
  const ps: Property[] = [prop('UID', e.uid)];
  if (e.dtstamp) ps.push(dateProp('DTSTAMP', { kind: 'utc', at: e.dtstamp }));
  if (e.start) ps.push(dateProp('DTSTART', e.start));
  if (e.end) ps.push(dateProp(e.kind === 'VEVENT' ? 'DTEND' : 'DUE', e.end));
  if (e.duration) ps.push(prop('DURATION', formatDuration(e.duration)));
  if (e.summary !== undefined) ps.push(prop('SUMMARY', escapeText(e.summary)));
  if (e.description !== undefined) ps.push(prop('DESCRIPTION', escapeText(e.description)));
  if (e.location !== undefined) ps.push(prop('LOCATION', escapeText(e.location)));
  if (e.categories.length) ps.push(prop('CATEGORIES', e.categories.map(escapeText).join(',')));
  if (e.status) ps.push(prop('STATUS', e.status));
  if (e.sequence) ps.push(prop('SEQUENCE', String(e.sequence)));
  if (e.rrule) ps.push(prop('RRULE', e.rrule));
  for (const d of e.rdates) ps.push(dateProp('RDATE', d));
  for (const d of e.exdates) ps.push(dateProp('EXDATE', d));
  if (e.recurrenceId) ps.push(dateProp('RECURRENCE-ID', e.recurrenceId));
  if (e.percentComplete !== undefined) ps.push(prop('PERCENT-COMPLETE', String(e.percentComplete)));
  if (e.completed) ps.push(dateProp('COMPLETED', { kind: 'utc', at: e.completed }));
  const alarms: Component[] = e.alarms.map((a) => ({
    name: 'VALARM',
    properties: [prop('ACTION', a.action), 'at' in a.trigger ? prop('TRIGGER', formatDateValue({ kind: 'utc', at: a.trigger.at }).value, { VALUE: 'DATE-TIME' }) : prop('TRIGGER', formatDuration(a.trigger.relative), a.trigger.from === 'END' ? { RELATED: 'END' } : {}), ...(a.description !== undefined ? [prop('DESCRIPTION', escapeText(a.description))] : a.action === 'DISPLAY' ? [prop('DESCRIPTION', 'Reminder')] : []), ...(a.repeat !== undefined ? [prop('REPEAT', String(a.repeat))] : []), ...(a.duration ? [prop('DURATION', formatDuration(a.duration))] : [])],
    components: [],
  }));
  return { name: e.kind, properties: ps, components: alarms };
}

/** A whole calendar from parts, with the version and product identifiers every calendar needs. */
export function buildCalendar(prodId: string, parts: readonly Component[]): Component {
  return { name: 'VCALENDAR', properties: [prop('VERSION', '2.0'), prop('PRODID', prodId), prop('CALSCALE', 'GREGORIAN')], components: [...parts] };
}

// --- expansion --------------------------------------------------------------------------------------------------

export interface Instance {
  readonly uid: string;
  readonly start: Date;
  readonly end: Date;
  readonly allDay: boolean;
  /** The original start of this instance when it is a changed one from a RECURRENCE-ID override. */
  readonly recurrenceId?: Date;
  readonly event: Event;
}

export type ZoneLookup = (tzid: string) => Zone | undefined;

/** Zones found in a calendar's VTIMEZONE components. */
export function zonesOf(cal: Component): ZoneLookup {
  const zs = new Map(cal.components.filter((c) => c.name === 'VTIMEZONE').map((c) => { const z = readZone(c); return [z.tzid, z] as const; }));
  return (id) => zs.get(id);
}

const isIana = (tz: string): boolean => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

function toInstant(v: DateValue, zones: ZoneLookup): Date {
  if (v.kind === 'utc') return v.at;
  if (v.kind === 'date') return new Date(Date.UTC(v.y, v.m - 1, v.d));
  if (v.kind === 'floating') return new Date(Date.UTC(v.wall.y, v.wall.m - 1, v.wall.d, v.wall.h, v.wall.min));
  const z = zones(v.tzid);
  if (z) return z.toInstant(v.wall);
  if (isIana(v.tzid)) return instant(v.wall, v.tzid);
  throw new BadCalendar(`time zone ${v.tzid} is neither a known zone nor defined by a VTIMEZONE`);
}

export const instantOf = toInstant;

/**
 * The times an event happens within a window. A non-recurring event gives its one instance if it overlaps the
 * window. Recurring events are expanded by the time block in wall time; EXDATEs are removed, RDATEs added.
 */
export function expand(e: Event, range: { from: Date; to: Date }, o: { zones?: ZoneLookup; limit?: number } = {}): Instance[] {
  if (!e.start) return [];
  const zones = o.zones ?? (() => undefined);
  const limit = o.limit ?? 1000;
  const allDay = e.start.kind === 'date';
  const s0 = toInstant(e.start, zones);
  const length = e.end ? toInstant(e.end, zones).getTime() - s0.getTime() : e.duration ? durationMs(e.duration) : allDay ? 86_400_000 : 0;
  if (length < 0) throw new BadCalendar(`${e.uid}: the end is before the start`);
  const mk = (start: Date): Instance => ({ uid: e.uid, start, end: new Date(start.getTime() + length), allDay, event: e });
  const overlaps = (i: Instance) => i.start < range.to && (i.end > range.from || (i.end.getTime() === i.start.getTime() && i.start >= range.from));
  const exdates = new Set(e.exdates.map((d) => toInstant(d, zones).getTime()));
  const starts = new Map<number, Date>();
  starts.set(s0.getTime(), s0);
  for (const r of e.rdates) { const t = toInstant(r, zones); starts.set(t.getTime(), t); }
  if (e.rrule) {
    const rule = parseRule(e.rrule);
    const wall: Wall = e.start.kind === 'date' ? { y: e.start.y, m: e.start.m, d: e.start.d, h: 0, min: 0 } : e.start.kind === 'utc' ? wallOf(e.start.at, 'UTC') : e.start.wall;
    const tzid = e.start.kind === 'zoned' ? e.start.tzid : undefined;
    const horizon = new Date(range.to.getTime() + 2 * 86_400_000);
    const custom = tzid !== undefined && (zones(tzid) !== undefined && !isIana(tzid));
    if (tzid !== undefined && !custom && !isIana(tzid) && !zones(tzid)) throw new BadCalendar(`time zone ${tzid} is neither a known zone nor defined by a VTIMEZONE`);
    const zone = tzid !== undefined && !custom ? tzid : 'UTC';
    const list = occurrences(wall, zone, rule, { limit: limit * 4, before: custom ? new Date(horizon.getTime() + 86_400_000) : horizon });
    for (const t of list) {
      const at = custom ? zones(tzid!)!.toInstant(wallOf(t, 'UTC')) : t;
      starts.set(at.getTime(), at);
    }
  }
  for (const x of exdates) starts.delete(x);
  return [...starts.values()].sort((a, b) => a.getTime() - b.getTime()).map(mk).filter(overlaps).slice(0, limit);
}

/**
 * Every instance in a window for a whole calendar. Overrides (components with a RECURRENCE-ID and the same UID)
 * replace the instance they name; an override whose STATUS is CANCELLED removes it.
 */
export function expandCalendar(cal: Component, range: { from: Date; to: Date }, o: { limit?: number } = {}): Instance[] {
  const zones = zonesOf(cal);
  const events = cal.components.filter((c) => c.name === 'VEVENT' || c.name === 'VTODO').map(readEvent);
  const masters = events.filter((e) => !e.recurrenceId);
  const overrides = events.filter((e) => e.recurrenceId);
  const out: Instance[] = [];
  for (const m of masters) {
    const mine = overrides.filter((x) => x.uid === m.uid);
    const replaced = new Map(mine.map((x) => [toInstant(x.recurrenceId!, zones).getTime(), x] as const));
    // Expand wide enough that an override moved into the window from outside is still found by its own dates.
    for (const inst of expand(m, { from: new Date(range.from.getTime() - 366 * 86_400_000), to: new Date(range.to.getTime() + 366 * 86_400_000) }, { zones, ...(o.limit ? { limit: o.limit * 4 } : {}) })) {
      const ov = replaced.get(inst.start.getTime());
      if (ov) continue;
      if (inst.start < range.to && inst.end > range.from || (inst.end.getTime() === inst.start.getTime() && inst.start >= range.from && inst.start < range.to)) out.push(inst);
    }
    for (const ov of mine) {
      if (ov.status === 'CANCELLED') continue;
      const rid = toInstant(ov.recurrenceId!, zones);
      for (const inst of expand({ ...ov, rrule: undefined as never, rdates: [], exdates: [] }, range, { zones })) out.push({ ...inst, recurrenceId: rid });
    }
  }
  for (const ov of overrides) if (!masters.some((m) => m.uid === ov.uid)) for (const inst of expand({ ...ov, rdates: [], exdates: [] }, range, { zones })) out.push({ ...inst, recurrenceId: toInstant(ov.recurrenceId!, zones) });
  return out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.uid.localeCompare(b.uid)).slice(0, o.limit ?? 1000);
}

/** When an instance's alarms go off. */
export function alarmTimes(i: Instance): { at: Date; action: Alarm['action'] }[] {
  const out: { at: Date; action: Alarm['action'] }[] = [];
  for (const a of i.event.alarms) {
    const base = 'at' in a.trigger ? a.trigger.at : new Date((a.trigger.from === 'END' ? i.end : i.start).getTime() + durationMs(a.trigger.relative));
    out.push({ at: base, action: a.action });
    if (a.repeat && a.duration) for (let r = 1; r <= Math.min(a.repeat, 100); r++) out.push({ at: new Date(base.getTime() + r * durationMs(a.duration)), action: a.action });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}
