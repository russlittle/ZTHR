/**
 * Electronic programme guides in XMLTV, and what a recorder does with them.
 *
 *  - Reading XMLTV: channels (names, numbers in the names, icons, urls) and programmes (titles, sub-titles,
 *    descriptions, credits with roles, dates, categories, length, episode numbers in every system, video and
 *    audio flags, previously-shown, new, premiere, ratings), with times parsed from XMLTV's "20260115203000 +0100"
 *    in every shortened form and checked as a calendar date. A bad programme is skipped and counted; the rest
 *    still loads. The file's `<!DOCTYPE tv SYSTEM "xmltv.dtd">` is accepted; a doctype with an internal subset is
 *    refused by the XML reader, so entity tricks have nothing to work with, and a stray `&` or an HTML entity
 *    that XML does not define stays as text instead of failing the file.
 *  - Writing it back, for exports and for tests.
 *  - Episode numbers: `xmltv_ns` ("0.4.0/2" is season 1, episode 5, part 1 of 2), on-screen "S01E05" or "1x05",
 *    and the ids of `dd_progid`, imdb and thetvdb, as one `Episode`.
 *  - A channel map from guide channels to the channels a tuner or playlist has: by id, by name with quality words
 *    and "+1" stripped, by number; with a confidence, ambiguity reported, and a time shift for "+1" channels.
 *  - A `Guide` over many sources: sorted per channel, duplicates removed, a missing stop taken from the next
 *    start, overlaps clipped, what is on now and what is on between two times, gaps, search.
 *  - Recording rules: title (exact, contains, starts with, glob), channels, categories, people, words, new only,
 *    days and hours in a time zone, length limits, padding; a plan that picks one airing per episode, skips
 *    what is already recorded, and resolves clashes for a number of tuners by priority.
 *
 * Not here: fetching guides, recording, or the library of recordings. Clock and time zone are arguments.
 */
import { escapeAttr, escapeText } from '../feed-write/index.ts';
import { parseXml } from '../dav/index.ts';
import type { El } from '../dav/index.ts';

export class XmltvError extends Error {}

// ---------------------------------------------------------------- times

/** "YYYY[MM[DD[hh[mm[ss]]]]] [+-hhmm]" as epoch milliseconds; no zone means UTC. Impossible dates are refused. */
export function parseXmltvTime(s: string): number | undefined {
  const m = /^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(?:(Z|UTC|GMT)|([+-])(\d{2}):?(\d{2}))?$/.exec(s.trim());
  if (!m) return undefined;
  const [y, mo, d, h, mi, se] = [m[1], m[2] ?? '01', m[3] ?? '01', m[4] ?? '00', m[5] ?? '00', m[6] ?? '00'].map(Number) as [number, number, number, number, number, number];
  const t = Date.UTC(y, mo - 1, d, h, mi, se);
  const c = new Date(t);
  if (c.getUTCFullYear() !== y || c.getUTCMonth() !== mo - 1 || c.getUTCDate() !== d || h > 23 || mi > 59 || se > 60) return undefined;
  let off = 0;
  if (m[8]) {
    if (Number(m[9]) > 14 || Number(m[10]) > 59) return undefined;
    off = (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10]));
  }
  return t - off * 60_000;
}

export function formatXmltvTime(ms: number, offsetMinutes = 0): string {
  const d = new Date(ms + offsetMinutes * 60_000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const a = Math.abs(offsetMinutes);
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} ${offsetMinutes < 0 ? '-' : '+'}${p(Math.floor(a / 60))}${p(a % 60)}`;
}

// ---------------------------------------------------------------- the model

export interface Text {
  readonly lang?: string;
  readonly text: string;
}

export interface Channel {
  readonly id: string;
  readonly names: readonly Text[];
  readonly icons: readonly string[];
  readonly urls: readonly string[];
}

export interface Person {
  readonly name: string;
  readonly role?: string;
}

export interface Programme {
  readonly channel: string;
  /** Epoch ms. */
  readonly start: number;
  readonly stop?: number;
  readonly title: readonly Text[];
  readonly subTitle: readonly Text[];
  readonly desc: readonly Text[];
  /** Credit kind (director, actor, writer, presenter...) to people. */
  readonly credits: Readonly<Record<string, readonly Person[]>>;
  readonly date?: string;
  readonly categories: readonly Text[];
  readonly keywords: readonly string[];
  readonly language?: string;
  readonly lengthMs?: number;
  readonly icons: readonly string[];
  readonly urls: readonly string[];
  readonly episodeNums: readonly { readonly system: string; readonly value: string }[];
  readonly aspect?: string;
  readonly quality?: string;
  readonly stereo?: string;
  readonly previouslyShown: boolean;
  readonly premiere: boolean;
  readonly lastChance: boolean;
  readonly isNew: boolean;
  readonly subtitles: readonly string[];
  readonly ratings: readonly { readonly system?: string; readonly value: string }[];
  readonly stars: readonly { readonly system?: string; readonly value: string }[];
}

export interface Problem {
  readonly what: string;
}

export interface Xmltv {
  readonly channels: readonly Channel[];
  readonly programmes: readonly Programme[];
  readonly generator?: string;
  readonly source?: string;
  /** How many things were skipped, and the first few reasons. */
  readonly skipped: number;
  readonly problems: readonly string[];
}

export const pick = (list: readonly Text[], prefer: readonly string[] = []): string | undefined => {
  for (const l of prefer) {
    const hit = list.find((t) => t.lang?.toLowerCase().split('-')[0] === l.toLowerCase().split('-')[0]);
    if (hit) return hit.text;
  }
  return (list.find((t) => !t.lang) ?? list[0])?.text;
};

// ---------------------------------------------------------------- reading

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const txt = (e: El) => squash(e.text);
const kids = (e: El, n: string) => e.children.filter((c) => c.name === n);
const lang = (e: El) => (e.attrs.lang ? { lang: e.attrs.lang } : {});
const texts = (e: El, n: string): Text[] => kids(e, n).map((c) => ({ ...lang(c), text: txt(c) })).filter((t) => t.text);

/** Valid XML from what XMLTV files really hold: plain doctype removed, stray ampersands and control codes made safe. */
function sanitise(src: string): string {
  return src
    .replace(/^﻿/, '')
    .replace(/<!DOCTYPE\s+tv\s+SYSTEM\s+(?:"[^"]*"|'[^']*')\s*>/i, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g, '&amp;');
}

export function parseXmltv(src: string, o: { maxBytes?: number; maxProgrammes?: number; maxStopAfterMs?: number } = {}): Xmltv {
  let root: El;
  try {
    root = parseXml(sanitise(src), { maxBytes: o.maxBytes ?? 150_000_000, maxDepth: 16 });
  } catch (e) {
    throw new XmltvError(`not XMLTV: ${(e as Error).message}`);
  }
  if (root.name !== 'tv') throw new XmltvError('the document does not start with <tv>');
  const problems: string[] = [];
  let skipped = 0;
  const bad = (why: string) => {
    skipped++;
    if (problems.length < 20) problems.push(why);
  };
  const channels: Channel[] = [];
  const seen = new Set<string>();
  for (const c of kids(root, 'channel')) {
    const id = c.attrs.id;
    if (!id) {
      bad('a channel has no id');
      continue;
    }
    if (seen.has(id)) {
      bad(`the channel ${JSON.stringify(id.slice(0, 40))} is declared twice`);
      continue;
    }
    seen.add(id);
    channels.push({ id, names: texts(c, 'display-name'), icons: kids(c, 'icon').map((i) => i.attrs.src ?? '').filter(Boolean), urls: kids(c, 'url').map(txt).filter(Boolean) });
  }
  const max = o.maxProgrammes ?? 2_000_000;
  const progs: Programme[] = [];
  const unknown = new Set<string>();
  for (const p of kids(root, 'programme')) {
    const channel = p.attrs.channel;
    const start = p.attrs.start ? parseXmltvTime(p.attrs.start) : undefined;
    let stop = p.attrs.stop ? parseXmltvTime(p.attrs.stop) : undefined;
    if (!channel || start === undefined) {
      bad(`a programme has no usable channel or start (${JSON.stringify((p.attrs.start ?? '').slice(0, 30))})`);
      continue;
    }
    if (p.attrs.stop && stop === undefined) {
      bad(`a programme has a stop time that is not valid (${JSON.stringify(p.attrs.stop.slice(0, 30))})`);
      continue;
    }
    if (stop !== undefined && (stop <= start || stop - start > (o.maxStopAfterMs ?? 48 * 3_600_000))) {
      bad(`a programme on ${JSON.stringify(channel.slice(0, 40))} has a stop that is not after its start or is over two days later`);
      stop = undefined;
    }
    const title = texts(p, 'title');
    if (!title.length) {
      bad(`a programme on ${JSON.stringify(channel.slice(0, 40))} has no title`);
      continue;
    }
    if (!seen.has(channel) && !unknown.has(channel)) {
      unknown.add(channel);
      bad(`programmes refer to the channel ${JSON.stringify(channel.slice(0, 40))}, which is not declared`);
    }
    if (progs.length >= max) throw new XmltvError(`more than ${max} programmes`);
    const credits: Record<string, Person[]> = {};
    const cr = kids(p, 'credits')[0];
    for (const c of cr?.children ?? []) if (txt(c)) (credits[c.name] ??= []).push({ name: txt(c), ...(c.attrs.role ? { role: c.attrs.role } : {}) });
    const len = kids(p, 'length')[0];
    const lenN = len ? Number(txt(len)) : NaN;
    const unit = len?.attrs.units === 'seconds' ? 1000 : len?.attrs.units === 'hours' ? 3_600_000 : 60_000;
    const video = kids(p, 'video')[0];
    const audio = kids(p, 'audio')[0];
    const one = (el: El | undefined, n: string) => {
      const c = el ? kids(el, n)[0] : undefined;
      return c && txt(c) ? txt(c) : undefined;
    };
    const date = kids(p, 'date')[0];
    const language = kids(p, 'language')[0];
    progs.push({
      channel, start, ...(stop !== undefined ? { stop } : {}), title, subTitle: texts(p, 'sub-title'), desc: texts(p, 'desc'), credits,
      ...(date && txt(date) ? { date: txt(date) } : {}), categories: texts(p, 'category'), keywords: kids(p, 'keyword').map(txt).filter(Boolean), ...(language && txt(language) ? { language: txt(language) } : {}),
      ...(Number.isFinite(lenN) && lenN > 0 ? { lengthMs: Math.round(lenN * unit) } : {}), icons: kids(p, 'icon').map((i) => i.attrs.src ?? '').filter(Boolean), urls: kids(p, 'url').map(txt).filter(Boolean),
      episodeNums: kids(p, 'episode-num').map((e) => ({ system: e.attrs.system ?? 'onscreen', value: txt(e) })).filter((e) => e.value),
      ...(one(video, 'aspect') ? { aspect: one(video, 'aspect')! } : {}), ...(one(video, 'quality') ? { quality: one(video, 'quality')! } : {}), ...(one(audio, 'stereo') ? { stereo: one(audio, 'stereo')! } : {}),
      previouslyShown: kids(p, 'previously-shown').length > 0, premiere: kids(p, 'premiere').length > 0, lastChance: kids(p, 'last-chance').length > 0, isNew: kids(p, 'new').length > 0,
      subtitles: kids(p, 'subtitles').map((s) => s.attrs.type ?? 'teletext'),
      ratings: kids(p, 'rating').map((r) => ({ ...(r.attrs.system ? { system: r.attrs.system } : {}), value: one(r, 'value') ?? '' })).filter((r) => r.value),
      stars: kids(p, 'star-rating').map((r) => ({ ...(r.attrs.system ? { system: r.attrs.system } : {}), value: one(r, 'value') ?? '' })).filter((r) => r.value),
    });
  }
  return { channels, programmes: progs, ...(root.attrs['generator-info-name'] ? { generator: root.attrs['generator-info-name'] } : {}), ...(root.attrs['source-info-name'] ? { source: root.attrs['source-info-name'] } : {}), skipped, problems };
}

// ---------------------------------------------------------------- writing

export function toXmltv(x: { channels: readonly Channel[]; programmes: readonly Programme[] }, o: { generator?: string; offsetMinutes?: number } = {}): string {
  const l = (t: Text) => (t.lang ? ` lang="${escapeAttr(t.lang)}"` : '');
  const out = [`<?xml version="1.0" encoding="UTF-8"?>`, `<tv${o.generator ? ` generator-info-name="${escapeAttr(o.generator)}"` : ''}>`];
  for (const c of x.channels) out.push(`<channel id="${escapeAttr(c.id)}">${c.names.map((n) => `<display-name${l(n)}>${escapeText(n.text)}</display-name>`).join('')}${c.icons.map((i) => `<icon src="${escapeAttr(i)}"/>`).join('')}${c.urls.map((u) => `<url>${escapeText(u)}</url>`).join('')}</channel>`);
  const off = o.offsetMinutes ?? 0;
  for (const p of x.programmes) {
    for (const k of Object.keys(p.credits)) if (!/^[a-z][a-z-]{0,30}$/.test(k)) throw new XmltvError('a credit kind is not a name XML allows');
    const credits = Object.entries(p.credits).flatMap(([k, ps]) => ps.map((q) => `<${k}${q.role ? ` role="${escapeAttr(q.role)}"` : ''}>${escapeText(q.name)}</${k}>`));
    out.push(
      `<programme start="${formatXmltvTime(p.start, off)}"${p.stop !== undefined ? ` stop="${formatXmltvTime(p.stop, off)}"` : ''} channel="${escapeAttr(p.channel)}">`,
      ...p.title.map((t) => `<title${l(t)}>${escapeText(t.text)}</title>`), ...p.subTitle.map((t) => `<sub-title${l(t)}>${escapeText(t.text)}</sub-title>`), ...p.desc.map((t) => `<desc${l(t)}>${escapeText(t.text)}</desc>`),
      ...(credits.length ? [`<credits>${credits.join('')}</credits>`] : []), ...(p.date ? [`<date>${escapeText(p.date)}</date>`] : []), ...p.categories.map((t) => `<category${l(t)}>${escapeText(t.text)}</category>`),
      ...p.keywords.map((k) => `<keyword>${escapeText(k)}</keyword>`), ...(p.language ? [`<language>${escapeText(p.language)}</language>`] : []), ...(p.lengthMs ? [`<length units="seconds">${Math.round(p.lengthMs / 1000)}</length>`] : []),
      ...p.icons.map((i) => `<icon src="${escapeAttr(i)}"/>`), ...p.urls.map((u) => `<url>${escapeText(u)}</url>`), ...p.episodeNums.map((e) => `<episode-num system="${escapeAttr(e.system)}">${escapeText(e.value)}</episode-num>`),
      ...(p.aspect || p.quality ? [`<video>${p.aspect ? `<aspect>${escapeText(p.aspect)}</aspect>` : ''}${p.quality ? `<quality>${escapeText(p.quality)}</quality>` : ''}</video>`] : []), ...(p.stereo ? [`<audio><stereo>${escapeText(p.stereo)}</stereo></audio>`] : []),
      ...(p.previouslyShown ? ['<previously-shown/>'] : []), ...(p.premiere ? ['<premiere/>'] : []), ...(p.lastChance ? ['<last-chance/>'] : []), ...(p.isNew ? ['<new/>'] : []),
      ...p.subtitles.map((s) => `<subtitles type="${escapeAttr(s)}"/>`), ...p.ratings.map((r) => `<rating${r.system ? ` system="${escapeAttr(r.system)}"` : ''}><value>${escapeText(r.value)}</value></rating>`),
      ...p.stars.map((r) => `<star-rating${r.system ? ` system="${escapeAttr(r.system)}"` : ''}><value>${escapeText(r.value)}</value></star-rating>`), '</programme>',
    );
  }
  out.push('</tv>');
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- episode numbers

export interface Episode {
  readonly season?: number;
  readonly episode?: number;
  readonly part?: number;
  readonly parts?: number;
  readonly ids: Readonly<Record<string, string>>;
}

/** The episode a programme is, from whichever numbering systems it carries. */
export function episodeOf(p: Pick<Programme, 'episodeNums'>): Episode {
  let season: number | undefined;
  let episode: number | undefined;
  let part: number | undefined;
  let parts: number | undefined;
  const ids: Record<string, string> = {};
  const ns = (v: string) => {
    const m = /^\s*(\d*)(?:\s*\/\s*(\d+))?\s*\.\s*(\d*)(?:\s*\/\s*(\d+))?\s*\.\s*(\d*)(?:\s*\/\s*(\d+))?\s*$/.exec(v);
    if (!m) return;
    if (m[1]) season = Number(m[1]) + 1;
    if (m[3]) episode = Number(m[3]) + 1;
    if (m[5]) part = Number(m[5]) + 1;
    if (m[6]) parts = Number(m[6]);
  };
  for (const e of p.episodeNums) {
    const sys = e.system.toLowerCase();
    if (sys === 'xmltv_ns') ns(e.value);
    else if (sys === 'onscreen') {
      const m = /\bS(\d{1,3})\s*E(\d{1,4})\b/i.exec(e.value) ?? /\b(\d{1,2})x(\d{1,3})\b/i.exec(e.value);
      if (m && season === undefined) {
        season = Number(m[1]);
        episode = Number(m[2]);
      } else if (!m && episode === undefined) {
        const only = /^\s*(?:E(?:p(?:isode)?)?\.?\s*)?(\d{1,4})\s*$/i.exec(e.value);
        if (only) episode = Number(only[1]);
      }
    } else if (sys === 'dd_progid' || sys === 'imdb.com' || sys === 'thetvdb.com' || sys === 'themoviedb.org') ids[sys] = e.value.trim();
    else if (sys === 'season-episode') {
      const m = /^(\d+)\.(\d+)$/.exec(e.value.trim());
      if (m && season === undefined) {
        season = Number(m[1]);
        episode = Number(m[2]);
      }
    }
  }
  return { ...(season !== undefined ? { season } : {}), ...(episode !== undefined ? { episode } : {}), ...(part !== undefined ? { part } : {}), ...(parts !== undefined ? { parts } : {}), ids };
}

export const fold = (s: string): string => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{Nd}]+/gu, ' ').trim();

/** A key for "the same episode", whichever airing: ids, then season and episode, then the sub-title. Undefined for a one-off with nothing to go on. */
export function episodeKey(p: Programme): string {
  const e = episodeOf(p);
  const series = fold(pick(p.title) ?? '');
  const id = e.ids.dd_progid ?? e.ids['thetvdb.com'] ?? e.ids['imdb.com'];
  if (id && !/^SH/i.test(id) && !/0000$/.test(id)) return `id:${id}${e.part ? `:p${e.part}` : ''}`;
  if (e.episode !== undefined) return `${series}|s${e.season ?? 0}e${e.episode}${e.part ? `p${e.part}` : ''}`;
  const sub = pick(p.subTitle);
  if (sub) return `${series}|${fold(sub)}`;
  return `${series}|@${p.start}`;
}

// ---------------------------------------------------------------- channel map

export interface LocalChannel {
  readonly id: string;
  readonly name: string;
  readonly number?: string;
}

export interface Mapping {
  readonly xmltv: string;
  readonly local?: string;
  readonly confidence: number;
  readonly how: 'id' | 'name' | 'name-loose' | 'number' | 'none';
  /** Milliseconds the guide must be moved for a "+1" channel. */
  readonly shiftMs: number;
  readonly ambiguous: readonly string[];
}

const QUALITY = /\b(hd|sd|uhd|4k|fhd|hevc|h265|tv|channel|ch)\b/g;

/** A channel name made comparable: lower case, no accents, no quality words; and the "+N" hours shift it names. */
export function normaliseChannelName(name: string): { key: string; loose: string; shiftHours: number } {
  const shift = /(?:^|\s)\+\s?(\d{1,2})\b/.exec(name) ?? /\bplus\s?(\d{1,2})\b/i.exec(name);
  const base = fold(name.replace(/\+\s?\d{1,2}\b/g, ' ').replace(/\bplus\s?\d{1,2}\b/gi, ' '));
  return { key: base, loose: base.replace(QUALITY, ' ').replace(/\s+/g, ' ').trim(), shiftHours: shift ? Number(shift[1]) : 0 };
}

/**
 * Map each guide channel to a local channel. Exact id first (also against local number), then name, then name
 * with quality words dropped, then a channel number written in a display name. A tie between local channels is
 * reported as ambiguous and left unmapped; two guide channels claiming one local channel keep the stronger.
 */
export function mapChannels(guide: readonly Channel[], local: readonly LocalChannel[], explicit: Readonly<Record<string, string>> = {}): Mapping[] {
  const byId = new Map(local.map((l) => [l.id, l]));
  const norm = local.map((l) => ({ l, n: normaliseChannelName(l.name) }));
  const out: Mapping[] = guide.map((g) => {
    const none = (ambiguous: readonly string[] = []): Mapping => ({ xmltv: g.id, confidence: 0, how: 'none', shiftMs: 0, ambiguous });
    const ex = explicit[g.id];
    if (ex !== undefined) return byId.has(ex) ? { xmltv: g.id, local: ex, confidence: 1, how: 'id', shiftMs: 0, ambiguous: [] } : none();
    if (byId.has(g.id)) return { xmltv: g.id, local: g.id, confidence: 1, how: 'id', shiftMs: 0, ambiguous: [] };
    const names = g.names.map((n) => normaliseChannelName(n.text)).filter((n) => n.key);
    for (const [how, conf, field] of [['name', 0.9, 'key'], ['name-loose', 0.75, 'loose']] as const) {
      const hits = new Map<string, number>();
      for (const n of names) for (const c of norm) if (n[field] && n[field] === c.n[field] && n.shiftHours === c.n.shiftHours) hits.set(c.l.id, n.shiftHours);
      if (hits.size === 1) return { xmltv: g.id, local: [...hits.keys()][0]!, confidence: conf, how, shiftMs: 0, ambiguous: [] };
      if (hits.size > 1) return none([...hits.keys()].sort());
      // A "+1" channel with no "+1" local channel maps to the base channel, shifted.
      const sh = new Map<string, number>();
      for (const n of names) if (n.shiftHours) for (const c of norm) if (n[field] && n[field] === c.n[field] && c.n.shiftHours === 0) sh.set(c.l.id, n.shiftHours);
      if (sh.size === 1) return { xmltv: g.id, local: [...sh.keys()][0]!, confidence: conf - 0.1, how, shiftMs: [...sh.values()][0]! * 3_600_000, ambiguous: [] };
    }
    const nums = new Set<string>();
    for (const n of g.names) {
      const m = /^\d{1,4}(?:\.\d{1,3})?$/.exec(n.text.trim());
      if (m) nums.add(m[0]);
    }
    const hits = local.filter((l) => l.number !== undefined && nums.has(l.number));
    if (hits.length === 1) return { xmltv: g.id, local: hits[0]!.id, confidence: 0.6, how: 'number', shiftMs: 0, ambiguous: [] };
    return none(hits.length > 1 ? hits.map((h) => h.id).sort() : []);
  });
  const best = new Map<string, Mapping>();
  for (const m of out) if (m.local && (best.get(m.local) === undefined || m.confidence > best.get(m.local)!.confidence)) best.set(m.local, m);
  return out.map((m): Mapping => (m.local && best.get(m.local) !== m ? { xmltv: m.xmltv, confidence: 0, how: 'none', shiftMs: 0, ambiguous: [m.local] } : m));
}

// ---------------------------------------------------------------- the guide

export interface Airing extends Programme {
  /** Always set in a guide. */
  readonly end: number;
  /** The source's priority that won, larger wins. */
  readonly source: number;
}

export class Guide {
  private readonly byChannel = new Map<string, Airing[]>();
  private dirty = new Set<string>();
  private readonly defaultLengthMs: number;
  private readonly maxLengthMs: number;

  constructor(o: { defaultLengthMs?: number; maxLengthMs?: number } = {}) {
    this.defaultLengthMs = o.defaultLengthMs ?? 30 * 60_000;
    this.maxLengthMs = o.maxLengthMs ?? 24 * 3_600_000;
  }

  /** Add a source's programmes. A programme with the same channel and start as an existing one replaces it when the source has the higher priority (or equal and later). */
  add(programmes: readonly Programme[], source = 0, o: { shiftMs?: (channel: string) => number; rename?: (channel: string) => string | undefined } = {}): void {
    for (const p of programmes) {
      const channel = o.rename ? o.rename(p.channel) : p.channel;
      if (channel === undefined) continue;
      const sh = o.shiftMs?.(p.channel) ?? 0;
      const start = p.start + sh;
      const list = this.byChannel.get(channel) ?? [];
      const at = list.findIndex((a) => a.start === start);
      const a: Airing = { ...p, channel, start, ...(p.stop !== undefined ? { stop: p.stop + sh } : {}), end: p.stop !== undefined ? p.stop + sh : start + (p.lengthMs ?? this.defaultLengthMs), source };
      if (at >= 0) {
        if (source >= list[at]!.source) list[at] = { ...a, ...(p.stop === undefined && list[at]!.stop !== undefined ? { stop: list[at]!.stop!, end: list[at]!.end } : {}) };
      } else list.push(a);
      this.byChannel.set(channel, list);
      this.dirty.add(channel);
    }
  }

  private tidy(channel: string): Airing[] {
    const list = this.byChannel.get(channel) ?? [];
    if (this.dirty.has(channel)) {
      list.sort((a, b) => a.start - b.start || b.source - a.source);
      for (let i = 0; i < list.length; i++) {
        const a = list[i]!;
        const next = list[i + 1];
        let end = a.end;
        if (a.stop === undefined && next) end = Math.min(next.start, a.start + this.maxLengthMs);
        else if (next && end > next.start) end = next.start;
        end = Math.min(end, a.start + this.maxLengthMs);
        list[i] = end > a.start ? { ...a, end } : { ...a, end: a.start + 1 };
      }
      this.dirty.delete(channel);
    }
    return list;
  }

  channels(): string[] {
    return [...this.byChannel.keys()].sort();
  }

  /** Everything on a channel that overlaps [from, to). */
  between(channel: string, from: number, to: number): Airing[] {
    return this.tidy(channel).filter((a) => a.start < to && a.end > from);
  }

  now(channel: string, at: number): { current?: Airing; next?: Airing } {
    const list = this.tidy(channel);
    const current = list.find((a) => a.start <= at && at < a.end);
    const next = list.find((a) => a.start > at);
    return { ...(current ? { current } : {}), ...(next ? { next } : {}) };
  }

  /** Times in [from, to) with nothing scheduled, longer than `minMs`. */
  gaps(channel: string, from: number, to: number, minMs = 60_000): { from: number; to: number }[] {
    const out: { from: number; to: number }[] = [];
    let at = from;
    for (const a of this.between(channel, from, to)) {
      if (a.start - at >= minMs) out.push({ from: at, to: a.start });
      at = Math.max(at, a.end);
    }
    if (to - at >= minMs) out.push({ from: at, to });
    return out;
  }

  /** Every word must appear in the title, sub-title or description. */
  search(query: string, o: { from?: number; to?: number; limit?: number } = {}): Airing[] {
    const words = fold(query).split(' ').filter(Boolean);
    if (!words.length) return [];
    const hits: Airing[] = [];
    for (const ch of this.channels()) {
      for (const a of this.tidy(ch)) {
        if ((o.from !== undefined && a.end <= o.from) || (o.to !== undefined && a.start >= o.to)) continue;
        const hay = fold([...a.title, ...a.subTitle, ...a.desc].map((t) => t.text).join(' '));
        if (words.every((w) => hay.includes(w))) hits.push(a);
      }
    }
    return hits.sort((x, y) => x.start - y.start || x.channel.localeCompare(y.channel)).slice(0, o.limit ?? 200);
  }

  all(): Airing[] {
    return this.channels().flatMap((c) => this.tidy(c));
  }
}

// ---------------------------------------------------------------- recording rules

export interface RecordingRule {
  readonly id: string;
  readonly priority?: number;
  readonly enabled?: boolean;
  readonly title?: { readonly is?: string; readonly contains?: string; readonly startsWith?: string; readonly glob?: string };
  readonly channels?: readonly string[];
  readonly categories?: readonly string[];
  readonly people?: readonly string[];
  /** Every word must appear in the title, sub-title or description. */
  readonly words?: readonly string[];
  readonly newOnly?: boolean;
  readonly window?: { readonly timeZone: string; readonly days?: readonly number[]; readonly from?: string; readonly to?: string };
  readonly minMinutes?: number;
  readonly maxMinutes?: number;
  readonly padBeforeMs?: number;
  readonly padAfterMs?: number;
  /** "episode" (default): one airing per episode. "all": every airing. */
  readonly keep?: 'episode' | 'all';
}

/** A glob with `*` and `?` only; matched without case or accents. No regular expressions, so no backtracking blow-up. */
export function globMatch(pattern: string, s: string): boolean {
  const keep = (x: string) => x.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{Nd}\u0001\u0002]+/gu, ' ').trim();
  const p = keep(pattern.replace(/\*/g, '\u0001').replace(/\?/g, '\u0002')).replace(/\u0001/g, '*').replace(/\u0002/g, '?');
  const t = keep(s);
  let pi = 0;
  let ti = 0;
  let star = -1;
  let mark = 0;
  while (ti < t.length) {
    if (pi < p.length && (p[pi] === '?' || p[pi] === t[ti])) {
      pi++;
      ti++;
    } else if (pi < p.length && p[pi] === '*') {
      star = pi++;
      mark = ti;
    } else if (star >= 0) {
      pi = star + 1;
      ti = ++mark;
    } else return false;
  }
  while (p[pi] === '*') pi++;
  return pi === p.length;
}

/** The local day of week (0 = Sunday) and minutes since midnight in a time zone. */
export function localParts(ms: number, timeZone: string): { day: number; minutes: number } {
  let f: Intl.DateTimeFormat;
  try {
    f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch {
    throw new XmltvError(`${JSON.stringify(timeZone)} is not a time zone`);
  }
  const parts = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!), minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const hm = (s: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m || Number(m[1]) > 24 || Number(m[2]) > 59) throw new XmltvError(`${JSON.stringify(s)} is not a time like 20:30`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/** Does the rule match the airing? Throws only for a rule that is itself wrong. */
export function ruleMatches(r: RecordingRule, p: Programme, channelOf: (id: string) => string = (x) => x): boolean {
  if (r.enabled === false) return false;
  const title = pick(p.title) ?? '';
  if (r.title) {
    const t = fold(title);
    if (r.title.is !== undefined && t !== fold(r.title.is)) return false;
    if (r.title.contains !== undefined && !t.includes(fold(r.title.contains))) return false;
    if (r.title.startsWith !== undefined && !t.startsWith(fold(r.title.startsWith))) return false;
    if (r.title.glob !== undefined && !globMatch(r.title.glob, title)) return false;
  }
  if (r.channels && !r.channels.includes(channelOf(p.channel))) return false;
  if (r.categories?.length) {
    const have = p.categories.map((c) => fold(c.text));
    if (!r.categories.some((c) => have.includes(fold(c)))) return false;
  }
  if (r.people?.length) {
    const have = Object.values(p.credits).flat().map((x) => fold(x.name));
    if (!r.people.some((x) => have.includes(fold(x)))) return false;
  }
  if (r.words?.length) {
    const hay = fold([...p.title, ...p.subTitle, ...p.desc].map((t) => t.text).join(' '));
    if (!r.words.every((w) => hay.includes(fold(w)))) return false;
  }
  if (r.newOnly && p.previouslyShown && !p.isNew && !p.premiere) return false;
  const len = p.stop !== undefined ? (p.stop - p.start) / 60_000 : p.lengthMs !== undefined ? p.lengthMs / 60_000 : undefined;
  if (r.minMinutes !== undefined && (len === undefined || len < r.minMinutes)) return false;
  if (r.maxMinutes !== undefined && (len === undefined || len > r.maxMinutes)) return false;
  if (r.window) {
    const { day, minutes } = localParts(p.start, r.window.timeZone);
    if (r.window.days && !r.window.days.includes(day)) return false;
    if (r.window.from !== undefined || r.window.to !== undefined) {
      const from = r.window.from !== undefined ? hm(r.window.from) : 0;
      const to = r.window.to !== undefined ? hm(r.window.to) : 24 * 60;
      const inside = from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
      if (!inside) return false;
    }
  }
  return true;
}

export interface Recording {
  readonly rule: string;
  readonly programme: Airing;
  /** With padding, and not before `now`. */
  readonly start: number;
  readonly end: number;
  readonly key: string;
  /** True if it began before the plan was made, so only the rest can be recorded. */
  readonly partial: boolean;
}

export interface Skipped {
  readonly programme: Airing;
  readonly rule: string;
  readonly reason: 'already-recorded' | 'another-airing' | 'conflict';
}

export interface PlanOptions {
  readonly now: number;
  readonly tuners: number;
  /** Episode keys already recorded. */
  readonly recorded?: ReadonlySet<string>;
  /** Only airings starting before this. */
  readonly until?: number;
  readonly channelOf?: (guideChannel: string) => string;
}

/** Choose what to record: one airing per episode that fits the tuners, higher priority first. */
export function plan(rules: readonly RecordingRule[], guide: Guide, o: PlanOptions): { scheduled: Recording[]; skipped: Skipped[] } {
  if (!Number.isInteger(o.tuners) || o.tuners < 1) throw new XmltvError('tuners is a whole number of at least one');
  const order = rules.map((r, i) => ({ r, i })).sort((a, b) => (b.r.priority ?? 0) - (a.r.priority ?? 0) || a.i - b.i);
  const skipped: Skipped[] = [];
  type Cand = { rule: RecordingRule; a: Airing; key: string; start: number; end: number; partial: boolean };
  const cands: Cand[] = [];
  for (const a of guide.all()) {
    if (a.end <= o.now || (o.until !== undefined && a.start >= o.until)) continue;
    const hit = order.find(({ r }) => ruleMatches(r, a, o.channelOf));
    if (!hit) continue;
    const r = hit.r;
    const start = a.start - (r.padBeforeMs ?? 0);
    cands.push({ rule: r, a, key: episodeKey(a), start: Math.max(start, o.now), end: a.end + (r.padAfterMs ?? 0), partial: start < o.now });
  }
  // One group per (rule, episode); every airing of an episode is a way to get it.
  const groups = new Map<string, Cand[]>();
  for (const c of cands) {
    const k = c.rule.keep === 'all' ? `${c.rule.id}\u0000${c.a.channel}\u0000${c.a.start}` : `${c.rule.id}\u0000${c.key}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const ranked = [...groups.values()].map((g) => g.sort((x, y) => x.a.start - y.a.start || x.a.channel.localeCompare(y.a.channel))).sort((x, y) => (y[0]!.rule.priority ?? 0) - (x[0]!.rule.priority ?? 0) || x[0]!.a.start - y[0]!.a.start || x[0]!.a.channel.localeCompare(y[0]!.a.channel));
  const taken: Cand[] = [];
  const fits = (c: Cand) => {
    const edges = taken.filter((t) => t.start < c.end && t.end > c.start);
    // A recording of the same airing (same channel and start) shares its tuner.
    if (edges.some((t) => t.a.channel === c.a.channel && t.a.start === c.a.start)) return true;
    const pts = [c.start, ...edges.map((t) => t.start).filter((s) => s > c.start)];
    for (const at of pts) {
      const live = new Set(edges.filter((t) => t.start <= at && t.end > at).map((t) => `${t.a.channel}\u0000${t.a.start}`));
      if (live.size + 1 > o.tuners) return false;
    }
    return true;
  };
  for (const g of ranked) {
    if (g[0]!.rule.keep !== 'all' && o.recorded?.has(g[0]!.key)) {
      for (const c of g) skipped.push({ programme: c.a, rule: c.rule.id, reason: 'already-recorded' });
      continue;
    }
    if (g[0]!.rule.keep !== 'all' && taken.some((t) => t.key === g[0]!.key && t.rule.id === g[0]!.rule.id)) continue;
    const pick1 = g.find(fits);
    if (!pick1) {
      for (const c of g) skipped.push({ programme: c.a, rule: c.rule.id, reason: 'conflict' });
      continue;
    }
    taken.push(pick1);
    for (const c of g) if (c !== pick1) skipped.push({ programme: c.a, rule: c.rule.id, reason: 'another-airing' });
  }
  const scheduled = taken.sort((x, y) => x.start - y.start || x.a.channel.localeCompare(y.a.channel)).map((c): Recording => ({ rule: c.rule.id, programme: c.a, start: c.start, end: c.end, key: c.key, partial: c.partial }));
  return { scheduled, skipped };
}
