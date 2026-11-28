/**
 * Subtitles in the four formats media servers meet: SRT, WebVTT, ASS/SSA and TTML (as used by streaming and
 * broadcast), one cue model between them, and the changes people ask of a subtitle file.
 *
 *  - One model: a `Doc` of cues (start and end in whole milliseconds, text, optional id, style name, numpad
 *    alignment and a position in percent of the frame), a map of named styles, and the warnings the reader
 *    collected. Cue text is a small markup: `<b> <i> <u> <font color="#rrggbb">` and text with `&amp; &lt; &gt;`
 *    escaped, always properly nested, never anything else, so every writer and renderer sees the same thing.
 *    Whatever a format has beyond that (karaoke timing, vector drawings, fonts, rotation) is dropped.
 *  - Readers that forgive what real files do: BOMs, CRLF, missing or wrong indexes, dots or commas before
 *    milliseconds, short timestamps, missing blank lines, text with commas in ASS, `\N`, `{\an8}`, `{\pos}`,
 *    colours in ASS's BGR order, TTML clock, offset and frame times, TTML styles by reference. A bad cue is
 *    skipped with a warning and does not stop the file. Bytes in UTF-8, UTF-16 or Windows-1252 are decoded.
 *  - Writers for all four, and `convert`.
 *  - Changes: shift (with a start point), stretch, frame-rate change, two-point sync, timing repair (sort, minimum
 *    and maximum duration, gaps, overlaps), merge, and a list of overlaps.
 *  - A burn-in plan: each cue with its styled runs, resolved style and screen anchor in pixels for a given video
 *    size, and the escaped `subtitles=` filter text for ffmpeg, so a path or style cannot break out of it.
 *
 * Not here: drawing the text, fonts, OCR of bitmap subtitles, karaoke. XML is read with the dav block's parser,
 * which refuses document type declarations.
 */
import { escapeAttr, escapeText } from '../feed-write/index.ts';
import { parseXml } from '../dav/index.ts';
import type { El } from '../dav/index.ts';

export class SubtitleError extends Error {}

export type Format = 'srt' | 'vtt' | 'ass' | 'ttml';

export interface Style {
  readonly name: string;
  readonly fontName?: string;
  readonly fontSize?: number;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  /** "#rrggbb". */
  readonly colour?: string;
  readonly outlineColour?: string;
  readonly backColour?: string;
  readonly outline?: number;
  readonly shadow?: number;
  /** Numpad: 1-3 bottom, 4-6 middle, 7-9 top; left, centre, right. */
  readonly align?: number;
  readonly marginL?: number;
  readonly marginR?: number;
  readonly marginV?: number;
}

export interface Cue {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly id?: string;
  readonly style?: string;
  readonly align?: number;
  /** Position of the anchor, percent of the frame width and height. */
  readonly x?: number;
  readonly y?: number;
}

export interface Doc {
  readonly cues: readonly Cue[];
  readonly styles: ReadonlyMap<string, Style>;
  readonly meta: { readonly title?: string; readonly language?: string; readonly playResX?: number; readonly playResY?: number };
  readonly warnings: readonly string[];
}

export interface Limits {
  readonly maxBytes?: number;
  readonly maxCues?: number;
}

const MAX_TIME = 100 * 3_600_000;

// ---------------------------------------------------------------- text, markup and runs

export interface Run {
  readonly text: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly colour?: string;
}

const NAMED: Record<string, string> = { white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff', lime: '#00ff00', orange: '#ffa500', gray: '#808080', grey: '#808080', silver: '#c0c0c0' };

export function normaliseColour(c: string): string | undefined {
  const v = c.trim().toLowerCase();
  if (NAMED[v]) return NAMED[v];
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return `#${m[1]![0]!.repeat(2)}${m[1]![1]!.repeat(2)}${m[1]![2]!.repeat(2)}`;
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(v);
  if (m) return `#${m[1]}`;
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(v);
  if (m && [m[1], m[2], m[3]].every((x) => Number(x) <= 255)) return '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('');
  return undefined;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', lrm: '\u200e', rlm: '\u200f' };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Runs of styled text from markup. Tags other than b, i, u and font are dropped; a `<` that opens no tag stays text. */
export function parseMarkup(raw: string): Run[] {
  const runs: Run[] = [];
  const stack: { tag: string; colour?: string }[] = [];
  let pos = 0;
  const state = () => ({ bold: stack.some((s) => s.tag === 'b'), italic: stack.some((s) => s.tag === 'i'), underline: stack.some((s) => s.tag === 'u'), colour: [...stack].reverse().find((s) => s.colour)?.colour });
  const push = (t: string) => {
    if (!t) return;
    const st = state();
    runs.push({ text: t, bold: st.bold, italic: st.italic, underline: st.underline, ...(st.colour ? { colour: st.colour } : {}) });
  };
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)(?:[.\s][^<>]*)?>|<\d{1,2}:\d{2}[:.\d]*>/g;
  for (let m: RegExpExecArray | null; (m = tag.exec(raw)); ) {
    push(decode(raw.slice(pos, m.index)));
    pos = m.index + m[0].length;
    const name = m[2]?.toLowerCase();
    if (!name) continue;
    if (name !== 'b' && name !== 'i' && name !== 'u' && name !== 'font') continue;
    if (m[1]) {
      const at = stack.map((s) => s.tag).lastIndexOf(name);
      if (at >= 0) stack.splice(at, 1);
    } else {
      const c = name === 'font' ? /\bcolou?r\s*=\s*["']?([^"'\s>]+)/i.exec(m[0])?.[1] : undefined;
      const colour = c ? normaliseColour(c) : undefined;
      stack.push({ tag: name, ...(colour ? { colour } : {}) });
    }
  }
  push(decode(raw.slice(pos)));
  return mergeRuns(runs);
}

function mergeRuns(runs: readonly Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const p = out[out.length - 1];
    if (p && p.bold === r.bold && p.italic === r.italic && p.underline === r.underline && p.colour === r.colour) out[out.length - 1] = { ...p, text: p.text + r.text };
    else if (r.text) out.push(r);
  }
  return out;
}

/** Canonical cue text from runs: nested, minimal, escaped. */
export function toMarkup(runs: readonly Run[]): string {
  let out = '';
  for (const r of mergeRuns(runs)) {
    const open = [r.colour ? `<font color="${r.colour}">` : '', r.bold ? '<b>' : '', r.italic ? '<i>' : '', r.underline ? '<u>' : ''].filter(Boolean);
    const close = [r.underline ? '</u>' : '', r.italic ? '</i>' : '', r.bold ? '</b>' : '', r.colour ? '</font>' : ''].filter(Boolean);
    // Tags may not span a line break in the players that matter, so each line is wrapped on its own.
    out += r.text.split('\n').map((l) => (l ? open.join('') + esc(l) + close.join('') : '')).join('\n');
  }
  return out;
}

/** Cue text in canonical form from any markup. */
export const cleanText = (raw: string): string => toMarkup(parseMarkup(raw.replace(/\r\n?/g, '\n'))).replace(/^\n+|\n+$/g, '').replace(/[ \t]+\n/g, '\n');

export const plainText = (cue: Pick<Cue, 'text'>): string => parseMarkup(cue.text).map((r) => r.text).join('');

// ---------------------------------------------------------------- times

const frac = (s: string | undefined) => (s ? Math.round(Number(`0.${s}`) * 1000) : 0);

/** SRT and VTT timestamps, with a comma or a dot, hours optional. Milliseconds from the digits as a fraction. */
export function parseTime(s: string): number | undefined {
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,:](\d{1,9}))?$/.exec(s.trim());
  if (!m) return undefined;
  if (Number(m[2]) > 59 && m[1] !== undefined) return undefined;
  const t = Number(m[1] ?? 0) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + frac(m[4]);
  return t <= MAX_TIME ? t : undefined;
}

const p = (n: number, w = 2) => String(n).padStart(w, '0');
function parts(ms: number) {
  const t = Math.max(0, Math.round(ms));
  return { h: Math.floor(t / 3_600_000), m: Math.floor(t / 60_000) % 60, s: Math.floor(t / 1000) % 60, ms: t % 1000 };
}
export const formatTime = (ms: number, sep: ',' | '.' = '.'): string => {
  const t = parts(ms);
  return `${p(t.h)}:${p(t.m)}:${p(t.s)}${sep}${p(t.ms, 3)}`;
};
const assTime = (ms: number) => {
  const t = parts(Math.round(ms / 10) * 10);
  return `${t.h}:${p(t.m)}:${p(t.s)}.${p(Math.floor(t.ms / 10))}`;
};

// ---------------------------------------------------------------- bytes to text, and format detection

/** Text from subtitle bytes: a BOM decides; else UTF-8 if valid, else Windows-1252. */
export function decodeBytes(b: Buffer): string {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8');
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2)).swap16().toString('utf16le');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('windows-1252').decode(b);
  }
}

export function detect(text: string): Format | undefined {
  const t = text.replace(/^\uFEFF/, '').trimStart();
  if (t.startsWith('WEBVTT')) return 'vtt';
  if (/^\[Script Info\]/i.test(t) || /^\s*\[V4\+? Styles\]/im.test(t)) return 'ass';
  if (/^<\?xml[^>]*\?>\s*<tt[\s>:]/.test(t) || /^<tt[\s>:]/.test(t) || (t.startsWith('<?xml') && /<tt[\s>]/.test(t.slice(0, 2000)))) return 'ttml';
  if (/\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/.test(t.slice(0, 5000))) return 'srt';
  return undefined;
}

function prep(text: string, o: Limits): { lines: string[]; max: number } {
  if (text.length > (o.maxBytes ?? 20_000_000)) throw new SubtitleError('the subtitle file is too large');
  return { lines: text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/), max: o.maxCues ?? 100_000 };
}

const doc = (cues: Cue[], warnings: string[], styles: Map<string, Style> = new Map(), meta: Doc['meta'] = {}): Doc => ({ cues, styles, meta, warnings });
const cue = (start: number, end: number, text: string, extra: Partial<Cue> = {}): Cue => ({ start, end, text, ...extra });

// ---------------------------------------------------------------- SRT

const ARROW = /^\s*(\S+)\s*-->\s*(\S+)(.*)$/;

export function parseSrt(text: string, o: Limits = {}): Doc {
  const { lines, max } = prep(text, o);
  const cues: Cue[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = ARROW.exec(lines[i]!);
    if (!m) continue;
    const start = parseTime(m[1]!);
    const end = parseTime(m[2]!);
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && lines[j]!.trim() !== ''; j++) {
      if (/^\d+$/.test(lines[j]!.trim()) && j + 1 < lines.length && ARROW.test(lines[j + 1]!)) break;
      body.push(lines[j]!);
    }
    i = j - 1;
    if (start === undefined || end === undefined) {
      warnings.push(`line ${i + 1 - body.length}: the times are not valid`);
      continue;
    }
    const t = cleanText(body.join('\n'));
    if (!t) continue;
    if (cues.length >= max) throw new SubtitleError(`more than ${max} cues`);
    cues.push(cue(start, end, t));
  }
  if (!cues.length && text.trim()) warnings.push('no cues were found');
  return doc(cues, warnings);
}

export function toSrt(d: Doc): string {
  return d.cues.map((c, i) => `${i + 1}\n${formatTime(c.start, ',')} --> ${formatTime(c.end, ',')}\n${srtText(c.text)}\n`).join('\n');
}
/** SRT players read a little HTML: tags stay, `>` is plain, `&` and `<` stay escaped. A blank line would end the cue. */
const srtText = (t: string) => t.replace(/\n{2,}/g, '\n').replace(/&gt;/g, '>');

// ---------------------------------------------------------------- WebVTT

function vttSettings(s: string): Partial<Cue> {
  const out: { align?: number; x?: number; y?: number } = {};
  let h: 'l' | 'c' | 'r' = 'c';
  let v: 'b' | 'm' | 't' = 'b';
  for (const tok of s.trim().split(/\s+/)) {
    const [k, val] = tok.split(':');
    if (!val) continue;
    if (k === 'align') h = val === 'left' || val === 'start' ? 'l' : val === 'right' || val === 'end' ? 'r' : 'c';
    else if (k === 'line') {
      const n = parseFloat(val);
      if (Number.isFinite(n) && val.endsWith('%')) {
        out.y = Math.min(100, Math.max(0, n));
        v = n < 33 ? 't' : n < 66 ? 'm' : 'b';
      } else if (Number.isFinite(n)) v = n >= 0 && n < 4 ? 't' : 'b';
    } else if (k === 'position') {
      const n = parseFloat(val);
      if (Number.isFinite(n) && val.endsWith('%')) out.x = Math.min(100, Math.max(0, n));
    }
  }
  const hasPos = s.includes('line:') || s.includes('align:');
  if (hasPos) out.align = (v === 't' ? 6 : v === 'm' ? 3 : 0) + (h === 'l' ? 1 : h === 'c' ? 2 : 3);
  return out;
}

export function parseVtt(text: string, o: Limits = {}): Doc {
  const { lines, max } = prep(text, o);
  if (!/^WEBVTT(?:[ \t].*)?$/.test(lines[0] ?? '')) throw new SubtitleError('a WebVTT file starts with WEBVTT');
  const cues: Cue[] = [];
  const warnings: string[] = [];
  const meta: { title?: string } = {};
  const title = /^WEBVTT[ \t]+-?\s*(.+)$/.exec(lines[0]!)?.[1];
  if (title) meta.title = title.trim();
  let i = 1;
  while (i < lines.length && lines[i]!.trim() !== '') i++;
  while (i < lines.length) {
    while (i < lines.length && lines[i]!.trim() === '') i++;
    const block: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '') block.push(lines[i++]!);
    if (!block.length) break;
    if (/^(NOTE|STYLE|REGION)(\s|$)/.test(block[0]!)) continue;
    const at = block[0]!.includes('-->') ? 0 : block[1]?.includes('-->') ? 1 : -1;
    if (at < 0) {
      warnings.push(`a block without times was skipped: ${JSON.stringify(block[0]!.slice(0, 40))}`);
      continue;
    }
    const m = ARROW.exec(block[at]!);
    const start = m ? parseTime(m[1]!) : undefined;
    const end = m ? parseTime(m[2]!) : undefined;
    if (start === undefined || end === undefined) {
      warnings.push(`the times ${JSON.stringify(block[at]!.slice(0, 50))} are not valid`);
      continue;
    }
    const t = cleanText(block.slice(at + 1).join('\n'));
    if (!t) continue;
    if (cues.length >= max) throw new SubtitleError(`more than ${max} cues`);
    cues.push(cue(start, end, t, { ...(at === 1 ? { id: block[0]!.trim() } : {}), ...vttSettings(m![3]!) }));
  }
  return doc(cues, warnings, new Map(), meta);
}

export function toVtt(d: Doc): string {
  const body = d.cues.map((c) => {
    let set = '';
    if (c.align !== undefined || c.y !== undefined) {
      const a = c.align ?? 2;
      const col = ((a - 1) % 3) + 1;
      const row = Math.floor((a - 1) / 3);
      set += ` line:${c.y !== undefined ? `${Math.round(c.y)}%` : row === 2 ? '10%' : row === 1 ? '50%' : '-1'}`;
      if (c.x !== undefined) set += ` position:${Math.round(c.x)}%`;
      set += ` align:${col === 1 ? 'left' : col === 3 ? 'right' : 'center'}`;
    }
    const text = c.text.replace(/<font color="(#[0-9a-f]{6})">/g, '<c.c$1>').replace(/<\/font>/g, '</c>').replace(/\n{2,}/g, '\n');
    return `${c.id && !c.id.includes('-->') && !/[\r\n]/.test(c.id) ? `${c.id}\n` : ''}${formatTime(c.start)} --> ${formatTime(c.end)}${set}\n${text.replace(/<c\.c#([0-9a-f]{6})>/g, '<c.c$1>')}\n`;
  });
  return `WEBVTT\n\n${body.join('\n')}`;
}

// ---------------------------------------------------------------- ASS / SSA

/** &HAABBGGRR, &HBBGGRR& or a decimal, as "#rrggbb" and opacity 0..1. */
export function parseAssColour(s: string): { colour: string; opacity: number } | undefined {
  const t = s.trim();
  let n: number;
  const h = /^&?H([0-9a-f]{1,8})&?$/i.exec(t);
  if (h) n = parseInt(h[1]!, 16);
  else if (/^-?\d+$/.test(t)) n = Number(t) >>> 0;
  else return undefined;
  const r = n & 0xff;
  const g = (n >>> 8) & 0xff;
  const b = (n >>> 16) & 0xff;
  const a = (n >>> 24) & 0xff;
  return { colour: '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join(''), opacity: 1 - a / 255 };
}

export function assColour(c: string, opacity = 1): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
  if (!m) return '&H00FFFFFF';
  return `&H${Math.round((1 - opacity) * 255).toString(16).padStart(2, '0')}${m[3]}${m[2]}${m[1]}`.toUpperCase();
}

const flag = (v: string | undefined) => (v === undefined ? undefined : v.trim() !== '0' && v.trim() !== '');
const num = (v: string | undefined) => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export function parseAss(text: string, o: Limits = {}): Doc {
  const { lines, max } = prep(text, o);
  const warnings: string[] = [];
  const styles = new Map<string, Style>();
  const meta: { title?: string; language?: string; playResX?: number; playResY?: number } = {};
  let section = '';
  let styleFmt: string[] = [];
  let evFmt: string[] = [];
  const events: { fields: Record<string, string> }[] = [];
  let ssa = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1]!.toLowerCase();
      ssa = section === 'v4 styles' || ssa;
      continue;
    }
    const kv = /^([A-Za-z ]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.trim().toLowerCase();
    const val = kv[2]!;
    if (section === 'script info') {
      if (key === 'title') meta.title = val.trim();
      else if (key === 'playresx' && num(val)) meta.playResX = num(val)!;
      else if (key === 'playresy' && num(val)) meta.playResY = num(val)!;
      else if (key === 'language') meta.language = val.trim();
    } else if (section === 'v4+ styles' || section === 'v4 styles') {
      if (key === 'format') styleFmt = val.split(',').map((x) => x.trim().toLowerCase());
      else if (key === 'style' && styleFmt.length) {
        const v = val.split(',');
        const f = (n: string) => v[styleFmt.indexOf(n)]?.trim();
        const name = f('name');
        if (!name) continue;
        let a = num(f('alignment'));
        if (a !== undefined && ssa) a = a >= 9 ? a - 5 : a >= 5 ? a + 2 : a;
        const prim = f('primarycolour') ? parseAssColour(f('primarycolour')!) : undefined;
        const out = f('outlinecolour') ? parseAssColour(f('outlinecolour')!) : undefined;
        const back = (f('backcolour') ?? f('tertiarycolour')) ? parseAssColour((f('backcolour') ?? f('tertiarycolour'))!) : undefined;
        styles.set(name, {
          name, ...(f('fontname') ? { fontName: f('fontname')! } : {}), ...(num(f('fontsize')) ? { fontSize: num(f('fontsize'))! } : {}),
          ...(flag(f('bold')) !== undefined ? { bold: flag(f('bold'))! } : {}), ...(flag(f('italic')) !== undefined ? { italic: flag(f('italic'))! } : {}), ...(flag(f('underline')) !== undefined ? { underline: flag(f('underline'))! } : {}),
          ...(prim ? { colour: prim.colour } : {}), ...(out ? { outlineColour: out.colour } : {}), ...(back ? { backColour: back.colour } : {}),
          ...(num(f('outline')) !== undefined ? { outline: num(f('outline'))! } : {}), ...(num(f('shadow')) !== undefined ? { shadow: num(f('shadow'))! } : {}),
          ...(a !== undefined && a >= 1 && a <= 9 ? { align: a } : {}),
          ...(num(f('marginl')) !== undefined ? { marginL: num(f('marginl'))! } : {}), ...(num(f('marginr')) !== undefined ? { marginR: num(f('marginr'))! } : {}), ...(num(f('marginv')) !== undefined ? { marginV: num(f('marginv'))! } : {}),
        });
      }
    } else if (section === 'events') {
      if (key === 'format') evFmt = val.split(',').map((x) => x.trim().toLowerCase());
      else if (key === 'dialogue' && evFmt.length) {
        const parts2: string[] = [];
        let rest = val;
        for (let k = 0; k < evFmt.length - 1; k++) {
          const c = rest.indexOf(',');
          if (c < 0) break;
          parts2.push(rest.slice(0, c));
          rest = rest.slice(c + 1);
        }
        parts2.push(rest);
        const fields: Record<string, string> = Object.create(null) as Record<string, string>;
        evFmt.forEach((n, k) => (fields[n] = parts2[k] ?? ''));
        events.push({ fields });
      }
    }
  }
  const resX = meta.playResX ?? 384;
  const resY = meta.playResY ?? 288;
  const cues: Cue[] = [];
  for (const { fields } of events) {
    const start = parseTime(fields.start ?? '');
    const end = parseTime(fields.end ?? '');
    if (start === undefined || end === undefined) {
      warnings.push(`an event has times that are not valid: ${JSON.stringify((fields.start ?? '').slice(0, 20))}`);
      continue;
    }
    const r = assText(fields.text ?? '', styles.get(fields.style ?? 'Default'), resX, resY);
    if (!r.text) continue;
    if (cues.length >= max) throw new SubtitleError(`more than ${max} cues`);
    cues.push(cue(start, end, r.text, { ...(fields.style ? { style: fields.style } : {}), ...(r.align ? { align: r.align } : {}), ...(r.x !== undefined ? { x: r.x, y: r.y! } : {}) }));
  }
  if (!cues.length && events.length === 0 && text.trim()) warnings.push('no events were found');
  return doc(cues, warnings, styles, meta);
}

/** ASS text with its override blocks as runs; {\an}, {\pos} are read, drawings dropped. */
function assText(raw: string, base: Style | undefined, resX: number, resY: number): { text: string; align?: number; x?: number; y?: number } {
  const runs: Run[] = [];
  let b = base?.bold ?? false;
  let i = base?.italic ?? false;
  let u = base?.underline ?? false;
  let colour: string | undefined;
  let align: number | undefined;
  let x: number | undefined;
  let y: number | undefined;
  let drawing = false;
  const emit = (t: string) => {
    if (t && !drawing) runs.push({ text: t, bold: b && !(base?.bold), italic: i && !(base?.italic), underline: u && !(base?.underline), ...(colour ? { colour } : {}) });
  };
  let pos = 0;
  const re = /\{([^}]*)\}/g;
  const lit = (s: string) => s.replace(/\\[Nn]/g, '\n').replace(/\\h/g, '\u00a0');
  for (let m: RegExpExecArray | null; (m = re.exec(raw)); ) {
    emit(lit(raw.slice(pos, m.index)));
    pos = m.index + m[0].length;
    for (const t of m[1]!.split('\\').slice(1)) {
      let k: RegExpExecArray | null;
      if ((k = /^b(\d+)?$/.exec(t))) b = k[1] === undefined ? false : Number(k[1]) !== 0;
      else if ((k = /^i(\d)?$/.exec(t))) i = k[1] === '1';
      else if ((k = /^u(\d)?$/.exec(t))) u = k[1] === '1';
      else if ((k = /^an(\d)$/.exec(t))) align = Number(k[1]);
      else if ((k = /^a(\d{1,2})$/.exec(t))) {
        const a = Number(k[1]);
        align = a >= 9 ? a - 5 : a >= 5 ? a + 2 : a;
      } else if ((k = /^pos\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/.exec(t))) {
        x = Math.min(100, Math.max(0, (Number(k[1]) / resX) * 100));
        y = Math.min(100, Math.max(0, (Number(k[2]) / resY) * 100));
      } else if ((k = /^(?:1c|c)(&H[0-9a-f]+&?)?$/i.exec(t))) colour = k[1] ? parseAssColour(k[1])?.colour : undefined;
      else if ((k = /^p(\d+)$/.exec(t))) drawing = Number(k[1]) > 0;
      else if (t === 'r') {
        b = base?.bold ?? false;
        i = base?.italic ?? false;
        u = base?.underline ?? false;
        colour = undefined;
      }
    }
  }
  emit(lit(raw.slice(pos)));
  const text = toMarkup(runs).replace(/^\n+|\n+$/g, '');
  return { text, ...(align ? { align } : {}), ...(x !== undefined ? { x, y: y! } : {}) };
}

export function toAss(d: Doc): string {
  const resX = d.meta.playResX ?? 384;
  const resY = d.meta.playResY ?? 288;
  const styles = new Map(d.styles);
  if (!styles.has('Default')) styles.set('Default', { name: 'Default', fontName: 'Arial', fontSize: 20, colour: '#ffffff', outlineColour: '#000000', backColour: '#000000', outline: 2, shadow: 0, align: 2, marginL: 10, marginR: 10, marginV: 10 });
  const safe = (s: string) => s.replace(/[,\r\n]/g, ' ');
  const sl = [...styles.values()].map((s) => `Style: ${safe(s.name)},${safe(s.fontName ?? 'Arial')},${s.fontSize ?? 20},${assColour(s.colour ?? '#ffffff')},${assColour(s.colour ?? '#ffffff')},${assColour(s.outlineColour ?? '#000000')},${assColour(s.backColour ?? '#000000')},${s.bold ? -1 : 0},${s.italic ? -1 : 0},${s.underline ? -1 : 0},0,100,100,0,0,1,${s.outline ?? 2},${s.shadow ?? 0},${s.align ?? 2},${s.marginL ?? 10},${s.marginR ?? 10},${s.marginV ?? 10},1`);
  const ev = d.cues.map((c) => {
    const pre = `${c.align ? `\\an${c.align}` : ''}${c.x !== undefined && c.y !== undefined ? `\\pos(${Math.round((c.x / 100) * resX)},${Math.round((c.y / 100) * resY)})` : ''}`;
    const text = parseMarkup(c.text).map((r) => {
      const t = r.text.replace(/[{}]/g, (x) => (x === '{' ? '(' : ')')).replace(/\r/g, '').replace(/\n/g, '\\N').replace(/\u00a0/g, '\\h');
      const o = `${r.bold ? '\\b1' : ''}${r.italic ? '\\i1' : ''}${r.underline ? '\\u1' : ''}${r.colour ? `\\c${assColour(r.colour).replace(/^&H00/, '&H')}&` : ''}`;
      return o ? `{${o}}${t}{\\r}` : t;
    }).join('');
    return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},${safe(c.style ?? 'Default')},,0,0,0,,${pre ? `{${pre}}` : ''}${text}`;
  });
  return `[Script Info]\n${d.meta.title ? `Title: ${safe(d.meta.title)}\n` : ''}ScriptType: v4.00+\nPlayResX: ${resX}\nPlayResY: ${resY}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n${sl.join('\n')}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${ev.join('\n')}\n`;
}

// ---------------------------------------------------------------- TTML

const TT = 'http://www.w3.org/ns/ttml';
const TTS = 'http://www.w3.org/ns/ttml#styling';
const TTP = 'http://www.w3.org/ns/ttml#parameter';
const XML = 'http://www.w3.org/XML/1998/namespace';

/** A TTML time expression in ms: clock (with frames), offset (h m s ms f t), as the file's frame and tick rates say. */
export function parseTtmlTime(s: string, frameRate = 30, tickRate?: number): number | undefined {
  const t = s.trim();
  let m = /^(\d{2,}):(\d{2}):(\d{2})(?:\.(\d+)|:(\d+)(?:\.\d+)?)?$/.exec(t);
  if (m) {
    const base = Number(m[1]) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000;
    return Math.round(base + (m[4] ? frac(m[4]) : m[5] ? (Number(m[5]) / frameRate) * 1000 : 0));
  }
  m = /^(\d+(?:\.\d+)?)(h|ms|m|s|f|t)$/.exec(t);
  if (!m) return undefined;
  const n = Number(m[1]);
  const v = m[2] === 'h' ? n * 3_600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1000 : m[2] === 'ms' ? n : m[2] === 'f' ? (n / frameRate) * 1000 : tickRate ? (n / tickRate) * 1000 : NaN;
  return Number.isFinite(v) ? Math.round(v) : undefined;
}

interface TProps {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  colour?: string;
}

/**
 * The XML reader keeps an element's text apart from its children, which loses the order in mixed content such as
 * `a <span>b</span> c`. So every text node is wrapped in its own element first, scanning as the reader does:
 * comments, CDATA and quoted attribute values are left alone for it to judge.
 */
function wrapText(src: string): string {
  let out = '';
  let i = 0;
  let depth = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const text = lt < 0 ? src.slice(i) : src.slice(i, lt);
    if (text) out += depth > 0 && text ? `<__t>${text}</__t>` : text;
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt);
      if (e < 0) return out + src.slice(lt);
      out += src.slice(lt, e + 3);
      i = e + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt);
      if (e < 0) return out + src.slice(lt);
      out += depth > 0 ? `<__t>${escapeText(src.slice(lt + 9, e))}</__t>` : '';
      i = e + 3;
    } else if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt);
      if (e < 0) return out + src.slice(lt);
      out += src.slice(lt, e + 2);
      i = e + 2;
    } else {
      let j = lt + 1;
      let q = '';
      for (; j < src.length; j++) {
        const ch = src[j]!;
        if (q) {
          if (ch === q) q = '';
        } else if (ch === '"' || ch === "'") q = ch;
        else if (ch === '>') break;
      }
      if (j >= src.length) return out + src.slice(lt);
      const tag = src.slice(lt, j + 1);
      if (tag[1] === '/') depth--;
      else if (!tag.endsWith('/>')) depth++;
      out += tag;
      i = j + 1;
    }
  }
  return out;
}

export function parseTtml(text: string, o: Limits = {}): Doc {
  if (text.length > (o.maxBytes ?? 20_000_000)) throw new SubtitleError('the subtitle file is too large');
  let root: El;
  try {
    root = parseXml(wrapText(text.replace(/^\uFEFF/, '')), { maxBytes: o.maxBytes ?? 20_000_000, maxDepth: 64 });
  } catch (e) {
    throw new SubtitleError(`not well-formed XML: ${(e as Error).message}`);
  }
  if (root.ns !== TT || root.name !== 'tt') throw new SubtitleError('not a TTML document');
  const warnings: string[] = [];
  const fps = num(root.attrs[`{${TTP}}frameRate`]) ?? 30;
  const mult = root.attrs[`{${TTP}}frameRateMultiplier`]?.split(/\s+/).map(Number);
  const frameRate = mult && mult.length === 2 && mult[1] ? (fps * mult[0]!) / mult[1]! : fps;
  const tickRate = num(root.attrs[`{${TTP}}tickRate`]);
  const lang = root.attrs[`{${XML}}lang`];
  const named = new Map<string, TProps>();
  const own = (e: El): TProps => {
    const a = (n: string) => e.attrs[`{${TTS}}${n}`];
    const r: TProps = {};
    if (a('fontWeight')) r.bold = a('fontWeight') === 'bold';
    if (a('fontStyle')) r.italic = a('fontStyle') === 'italic' || a('fontStyle') === 'oblique';
    if (a('textDecoration')) r.underline = a('textDecoration')!.split(/\s+/).includes('underline');
    const c = a('color') ? normaliseColour(a('color')!) : undefined;
    if (c) r.colour = c;
    return r;
  };
  const resolve = (e: El, parent: TProps): TProps => {
    let r: TProps = { ...parent };
    for (const id of (e.attrs.style ?? '').split(/\s+/).filter(Boolean)) r = { ...r, ...(named.get(id) ?? {}) };
    return { ...r, ...own(e) };
  };
  const find = (e: El, name: string): El[] => [...(e.name === name && e.ns === TT ? [e] : []), ...e.children.flatMap((c) => find(c, name))];
  for (const s of find(root, 'style')) {
    const id = s.attrs[`{${XML}}id`];
    if (id) named.set(id, resolve(s, {}));
  }
  const cues: Cue[] = [];
  const max = o.maxCues ?? 100_000;
  const t = (v: string | undefined) => (v === undefined ? undefined : parseTtmlTime(v, frameRate, tickRate));
  const runsOf = (e: El, props: TProps, out: Run[], preserve: boolean) => {
    const here = resolve(e, props);
    const keep = e.attrs[`{${XML}}space`] ? e.attrs[`{${XML}}space`] === 'preserve' : preserve;
    for (const c of e.children) {
      if (c.name === '__t') out.push({ text: keep ? c.text : c.text.replace(/\s+/g, ' '), bold: !!here.bold, italic: !!here.italic, underline: !!here.underline, ...(here.colour ? { colour: here.colour } : {}) });
      else if (c.name === 'br') out.push({ text: '\n', bold: false, italic: false, underline: false });
      else if (c.name === 'span') runsOf(c, here, out, keep);
    }
  };
  const walk = (e: El, offset: number, props: TProps) => {
    for (const c of e.children) {
      if (c.ns !== TT) continue;
      if (c.name === 'div' || c.name === 'body') {
        const b = t(c.attrs.begin) ?? 0;
        walk(c, offset + b, resolve(c, props));
      } else if (c.name === 'p') {
        const b = t(c.attrs.begin);
        const en = t(c.attrs.end);
        const dur = t(c.attrs.dur);
        if (b === undefined || (en === undefined && dur === undefined)) {
          warnings.push('a paragraph without usable begin and end was skipped');
          continue;
        }
        const out: Run[] = [];
        runsOf(c, props, out, false);
        const text = toMarkup(out).replace(/^\s+|\s+$/g, '');
        if (!text) continue;
        if (cues.length >= max) throw new SubtitleError(`more than ${max} cues`);
        const start = offset + b;
        const xs = c.attrs[`{${TTS}}textAlign`];
        cues.push(cue(start, en !== undefined ? offset + en : start + dur!, text, { ...(c.attrs[`{${XML}}id`] ? { id: c.attrs[`{${XML}}id`]! } : {}), ...(xs === 'left' || xs === 'start' ? { align: 1 } : xs === 'right' || xs === 'end' ? { align: 3 } : {}) }));
      }
    }
  };
  walk(root.children.find((c) => c.name === 'body' && c.ns === TT) ? { ...root, children: root.children.filter((c) => c.name === 'body') } : root, 0, {});
  return doc(cues, warnings, new Map(), lang ? { language: lang } : {});
}

export function toTtml(d: Doc): string {
  const ps = d.cues.map((c) => {
    const spans = parseMarkup(c.text).map((r) =>
      r.text.split('\n').map((l) => {
        const at = [r.bold ? ' tts:fontWeight="bold"' : '', r.italic ? ' tts:fontStyle="italic"' : '', r.underline ? ' tts:textDecoration="underline"' : '', r.colour ? ` tts:color="${r.colour}"` : ''].join('');
        return at ? `<span${at}>${escapeText(l)}</span>` : escapeText(l);
      }).join('<br/>'),
    ).join('');
    const al = c.align !== undefined ? ` tts:textAlign="${((c.align - 1) % 3) === 0 ? 'left' : ((c.align - 1) % 3) === 2 ? 'right' : 'center'}"` : '';
    return `<p${c.id && /^[A-Za-z_][\w.-]*$/.test(c.id) ? ` xml:id="${escapeAttr(c.id)}"` : ''} begin="${formatTime(c.start)}" end="${formatTime(c.end)}"${al}>${spans}</p>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<tt xmlns="${TT}" xmlns:tts="${TTS}" xmlns:ttp="${TTP}" xml:lang="${escapeAttr(d.meta.language ?? 'und')}"><body><div>\n${ps.join('\n')}\n</div></body></tt>\n`;
}

// ---------------------------------------------------------------- reading, writing, converting

export function parse(text: string, format?: Format, o: Limits = {}): Doc {
  const f = format ?? detect(text);
  if (!f) throw new SubtitleError('the format is not recognised');
  return f === 'srt' ? parseSrt(text, o) : f === 'vtt' ? parseVtt(text, o) : f === 'ass' ? parseAss(text, o) : parseTtml(text, o);
}

export function write(d: Doc, format: Format): string {
  return format === 'srt' ? toSrt(d) : format === 'vtt' ? toVtt(d) : format === 'ass' ? toAss(d) : toTtml(d);
}

export const convert = (text: string, to: Format, from?: Format, o: Limits = {}): string => write(parse(text, from, o), to);

// ---------------------------------------------------------------- changes

const withCues = (d: Doc, cues: Cue[], warnings: readonly string[] = d.warnings): Doc => ({ ...d, cues, warnings });
const retime = (c: Cue, f: (t: number) => number): Cue => ({ ...c, start: Math.round(f(c.start)), end: Math.round(f(c.end)) });

/** Move cues by `ms` (negative earlier). With `from`, only cues starting at or after it. Cues left wholly before zero are dropped, others start at zero. */
export function shift(d: Doc, ms: number, o: { from?: number } = {}): Doc {
  if (!Number.isFinite(ms)) throw new SubtitleError('the shift is not a number');
  const out: Cue[] = [];
  for (const c of d.cues) {
    if (o.from !== undefined && c.start < o.from) {
      out.push(c);
      continue;
    }
    const s = c.start + Math.round(ms);
    const e = c.end + Math.round(ms);
    if (e <= 0) continue;
    out.push({ ...c, start: Math.max(0, s), end: e });
  }
  return withCues(d, out);
}

export function stretch(d: Doc, factor: number): Doc {
  if (!Number.isFinite(factor) || factor <= 0) throw new SubtitleError('the factor must be above zero');
  return withCues(d, d.cues.map((c) => retime(c, (t) => t * factor)));
}

/** For subtitles timed against a video at `subtitleFps` that now play with a video at `videoFps`. */
export function changeFrameRate(d: Doc, subtitleFps: number, videoFps: number): Doc {
  if (!(subtitleFps > 0) || !(videoFps > 0)) throw new SubtitleError('frame rates must be above zero');
  return stretch(d, subtitleFps / videoFps);
}

/** Two known points, "this cue should be at that time": a straight line through both. */
export function syncTwoPoints(d: Doc, a: { from: number; to: number }, b: { from: number; to: number }): Doc {
  if (a.from === b.from) throw new SubtitleError('the two points must be at different times');
  const k = (b.to - a.to) / (b.from - a.from);
  const out = d.cues.map((c) => retime(c, (t) => a.to + (t - a.from) * k)).filter((c) => c.end > 0).map((c) => ({ ...c, start: Math.max(0, c.start) }));
  return withCues(d, out);
}

export interface Repair {
  readonly minDurationMs?: number;
  readonly maxDurationMs?: number;
  readonly minGapMs?: number;
  /** Shorten a cue that overlaps the next one (default true). */
  readonly trimOverlaps?: boolean;
}

/** Sorted, with each cue at least `minDurationMs` where the next cue allows, at most `maxDurationMs`, and no overlaps. */
export function repair(d: Doc, o: Repair = {}): Doc {
  const min = o.minDurationMs ?? 500;
  const max = o.maxDurationMs ?? 10_000;
  const gap = o.minGapMs ?? 0;
  const sorted = d.cues.map((c, i) => ({ c, i })).sort((x, y) => x.c.start - y.c.start || x.c.end - y.c.end || x.i - y.i).map((x) => x.c);
  const out: Cue[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let c = sorted[i]!;
    const next = sorted[i + 1];
    let end = Math.max(c.end, c.start + 1);
    end = Math.min(end, c.start + max);
    if (end - c.start < min) end = c.start + min;
    if (next && (o.trimOverlaps ?? true) && end > next.start - gap) end = Math.max(c.start + 1, Math.min(end, next.start - gap));
    c = { ...c, end };
    out.push(c);
  }
  return withCues(d, out);
}

export function overlaps(d: Doc): { a: number; b: number; ms: number }[] {
  const idx = d.cues.map((c, i) => ({ c, i })).sort((x, y) => x.c.start - y.c.start || x.i - y.i);
  const out: { a: number; b: number; ms: number }[] = [];
  for (let i = 0; i < idx.length; i++) for (let j = i + 1; j < idx.length && idx[j]!.c.start < idx[i]!.c.end; j++) out.push({ a: idx[i]!.i, b: idx[j]!.i, ms: Math.min(idx[i]!.c.end, idx[j]!.c.end) - idx[j]!.c.start });
  return out;
}

/** Two documents as one, in time order; styles of the second lose to the first on a name clash. */
export function merge(a: Doc, b: Doc): Doc {
  return { cues: [...a.cues, ...b.cues].map((c, i) => ({ c, i })).sort((x, y) => x.c.start - y.c.start || x.i - y.i).map((x) => x.c), styles: new Map([...b.styles, ...a.styles]), meta: { ...b.meta, ...a.meta }, warnings: [...a.warnings, ...b.warnings] };
}

/** The cues showing at a time. */
export const activeAt = (d: Doc, ms: number): Cue[] => d.cues.filter((c) => c.start <= ms && ms < c.end);

// ---------------------------------------------------------------- burn-in plan

export interface ResolvedStyle {
  readonly fontName: string;
  /** Pixels. */
  readonly fontSize: number;
  readonly colour: string;
  readonly outlineColour: string;
  readonly outline: number;
  readonly shadow: number;
  readonly align: number;
  readonly marginL: number;
  readonly marginR: number;
  readonly marginV: number;
}

export interface BurnIn {
  readonly start: number;
  readonly end: number;
  readonly runs: readonly Run[];
  readonly style: ResolvedStyle;
  /** Anchor in pixels, when the cue has a position. */
  readonly at?: { readonly x: number; readonly y: number };
}

export interface BurnInOptions {
  readonly width: number;
  readonly height: number;
  readonly defaults?: Partial<Omit<Style, 'name'>>;
}

/** Styles scale with the script's play height (288 when it names none) to the video's height. */
export function burnInPlan(d: Doc, o: BurnInOptions): { events: BurnIn[]; warnings: string[] } {
  if (!(o.width > 0) || !(o.height > 0) || o.width > 16384 || o.height > 16384) throw new SubtitleError('the video size is not usable');
  const resX = d.meta.playResX ?? 384;
  const resY = d.meta.playResY ?? 288;
  const sx = o.width / resX;
  const sy = o.height / resY;
  const warnings: string[] = [];
  const events: BurnIn[] = [];
  for (const c of d.cues) {
    const st: Partial<Style> = { ...(o.defaults ?? {}), ...(d.styles.get('Default') ?? {}), ...(c.style ? d.styles.get(c.style) ?? {} : {}) };
    if (c.style && !d.styles.has(c.style)) warnings.push(`style ${JSON.stringify(c.style.slice(0, 30))} is not defined; the default is used`);
    const style: ResolvedStyle = {
      fontName: st.fontName ?? 'Arial', fontSize: Math.round((st.fontSize ?? 20) * sy * 100) / 100, colour: st.colour ?? '#ffffff', outlineColour: st.outlineColour ?? '#000000',
      outline: Math.round((st.outline ?? 2) * sy * 100) / 100, shadow: Math.round((st.shadow ?? 0) * sy * 100) / 100, align: c.align ?? st.align ?? 2,
      marginL: Math.round((st.marginL ?? 10) * sx), marginR: Math.round((st.marginR ?? 10) * sx), marginV: Math.round((st.marginV ?? 10) * sy),
    };
    const runs = parseMarkup(c.text).map((r) => ({ ...r, bold: r.bold || !!st.bold, italic: r.italic || !!st.italic, underline: r.underline || !!st.underline, colour: r.colour ?? style.colour }));
    events.push({ start: c.start, end: c.end, runs, style, ...(c.x !== undefined && c.y !== undefined ? { at: { x: Math.round((c.x / 100) * o.width), y: Math.round((c.y / 100) * o.height) } } : {}) });
  }
  return { events, warnings };
}

/** Escape a value for ffmpeg's filter graph, both levels: option values (`\`, `'`, `:`), then the graph (`\`, `'`, `[`, `]`, `,`, `;`). */
export function ffmpegEscape(s: string): string {
  if (/[\u0000-\u001f]/.test(s)) throw new SubtitleError('a control character cannot go in a filter');
  return s.replace(/[\\':]/g, (c) => `\\${c}`).replace(/[\\'\[\],;]/g, (c) => `\\${c}`);
}

/** The ASS style override ffmpeg's `subtitles` filter takes in `force_style`. */
export function forceStyle(s: Partial<ResolvedStyle> & { bold?: boolean; italic?: boolean }): string {
  const bgr = (c: string) => assColour(c);
  const kv: string[] = [];
  if (s.fontName) kv.push(`FontName=${s.fontName.replace(/[,=\\]/g, ' ')}`);
  if (s.fontSize) kv.push(`FontSize=${Math.round(s.fontSize)}`);
  if (s.colour) kv.push(`PrimaryColour=${bgr(s.colour)}`);
  if (s.outlineColour) kv.push(`OutlineColour=${bgr(s.outlineColour)}`);
  if (s.bold !== undefined) kv.push(`Bold=${s.bold ? 1 : 0}`);
  if (s.italic !== undefined) kv.push(`Italic=${s.italic ? 1 : 0}`);
  if (s.outline !== undefined) kv.push(`Outline=${Math.round(s.outline)}`);
  if (s.shadow !== undefined) kv.push(`Shadow=${Math.round(s.shadow)}`);
  if (s.align) kv.push(`Alignment=${s.align}`);
  if (s.marginV !== undefined) kv.push(`MarginV=${Math.round(s.marginV)}`);
  return kv.join(',');
}

/** `subtitles=filename=...:force_style=...` with both levels of escaping, safe to put in a -vf argument whatever the path holds. */
export function subtitlesFilter(path: string, o: { style?: Parameters<typeof forceStyle>[0]; fontsDir?: string } = {}): string {
  const parts2 = [`filename=${ffmpegEscapeValue(path)}`];
  if (o.fontsDir) parts2.push(`fontsdir=${ffmpegEscapeValue(o.fontsDir)}`);
  if (o.style) parts2.push(`force_style=${ffmpegEscapeValue(forceStyle(o.style))}`);
  return `subtitles=${parts2.join(':')}`;
}

const ffmpegEscapeValue = ffmpegEscape;
