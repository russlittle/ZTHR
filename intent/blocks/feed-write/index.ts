/**
 * Feeds written correctly: RSS 2.0, Atom 1.0 (RFC 4287) and JSON Feed 1.1 from one description of a feed and its
 * items. Podcasts get the iTunes namespace (duration, episode, season, type, explicit, nested categories, owner,
 * image, block, complete, new-feed-url) and the Podcast Index tags for transcripts, chapters and funding; media
 * gets the Media RSS subset (content, thumbnail, description, credit). Everything is checked before a byte is
 * written, and every problem is reported at once: required elements, absolute http(s) addresses (a relative or
 * `javascript:` address is refused), valid dates (RFC 822 for RSS, RFC 3339 for Atom and JSON Feed, always in UTC),
 * enclosure sizes and types, durations, and ids that are not repeated. Text is escaped and stripped of characters
 * XML cannot hold (control codes, lone surrogates), HTML bodies go into CDATA with any `]]>` split safely, and a
 * namespace is declared only when used. A response helper answers conditional requests the way RFC 9110 says: a
 * matching If-None-Match (weak comparison) wins over If-Modified-Since, a 304 repeats the validators, and a
 * Last-Modified in the future is held back to now.
 *
 * Out of scope: reading feeds (see the importer for that), WebSub pings, and signing; and `itunes:category` is
 * written as given, since Apple's list changes, with only its shape checked.
 */
import { createHash } from 'node:crypto';

export class FeedError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`the feed cannot be written: ${problems.join('; ')}`);
    this.problems = problems;
  }
}

export type DateLike = Date | number | string;

export interface Person {
  readonly name: string;
  readonly email?: string;
  readonly url?: string;
  readonly avatar?: string;
}

export interface Enclosure {
  readonly url: string;
  /** Size in bytes; RSS requires it. */
  readonly length: number;
  readonly type: string;
  readonly duration?: number;
}

export interface MediaContent {
  readonly url: string;
  readonly type?: string;
  readonly medium?: 'image' | 'video' | 'audio' | 'document' | 'executable';
  readonly width?: number;
  readonly height?: number;
  readonly duration?: number;
  readonly fileSize?: number;
}

export interface Media {
  readonly content?: readonly MediaContent[];
  readonly thumbnail?: { readonly url: string; readonly width?: number; readonly height?: number };
  readonly description?: string;
  readonly credit?: string;
}

export interface PodcastEpisode {
  /** Seconds, or "HH:MM:SS" or "MM:SS". */
  readonly duration?: number | string;
  readonly episode?: number;
  readonly season?: number;
  readonly episodeType?: 'full' | 'trailer' | 'bonus';
  readonly explicit?: boolean;
  readonly image?: string;
  readonly subtitle?: string;
  readonly summary?: string;
  readonly transcript?: { readonly url: string; readonly type: string; readonly language?: string };
  readonly chapters?: { readonly url: string; readonly type: string };
  readonly block?: boolean;
}

export interface Item {
  /** A permanent id; a link is the usual choice. It must be unique in the feed. */
  readonly id: string;
  readonly title: string;
  readonly link?: string;
  /** Short plain text. */
  readonly summary?: string;
  /** The full body as HTML. */
  readonly contentHtml?: string;
  readonly contentText?: string;
  readonly published?: DateLike;
  readonly updated?: DateLike;
  readonly authors?: readonly Person[];
  readonly categories?: readonly string[];
  readonly enclosure?: Enclosure;
  readonly image?: string;
  readonly commentsUrl?: string;
  readonly media?: Media;
  readonly podcast?: PodcastEpisode;
  readonly language?: string;
}

export interface PodcastShow {
  readonly author?: string;
  readonly summary?: string;
  readonly subtitle?: string;
  readonly explicit?: boolean;
  readonly type?: 'episodic' | 'serial';
  readonly owner?: { readonly name: string; readonly email: string };
  readonly image?: string;
  /** Each a top category with optional subcategory: ["Technology", "Tech News"]. */
  readonly categories?: readonly (readonly [string] | readonly [string, string])[];
  readonly block?: boolean;
  readonly complete?: boolean;
  readonly newFeedUrl?: string;
  readonly locked?: { readonly value: boolean; readonly owner?: string };
  readonly funding?: readonly { readonly url: string; readonly text: string }[];
}

export interface Feed {
  readonly title: string;
  /** The address of the site this feed is about. */
  readonly link: string;
  /** The address of this feed itself. */
  readonly selfUrl?: string;
  readonly description: string;
  readonly language?: string;
  readonly updated?: DateLike;
  readonly authors?: readonly Person[];
  readonly image?: string;
  readonly icon?: string;
  readonly copyright?: string;
  readonly generator?: string;
  readonly categories?: readonly string[];
  /** Minutes caches may keep the feed (RSS ttl). */
  readonly ttlMinutes?: number;
  readonly podcast?: PodcastShow;
  readonly items: readonly Item[];
  /** Atom feed id; default the feed's address or site address. */
  readonly id?: string;
}

export interface WriteOptions {
  /** Most items written, newest first. Default 100. */
  readonly maxItems?: number;
  /** Used when a feed or item has no date. Never invented silently: without it, a missing required date is an error. */
  readonly now?: () => number;
}

export type Format = 'rss' | 'atom' | 'json';

// ================================================================== text and dates

/** Removes what XML 1.0 cannot hold: control codes except tab, newline and return, lone surrogates, U+FFFE and U+FFFF. */
export function xmlSafe(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        out += s[i]! + s[i + 1]!;
        i++;
      }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    if (c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c !== 0xfffe && c !== 0xffff)) out += s[i]!;
  }
  return out;
}

export const escapeText = (s: string) => xmlSafe(s).replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
export const escapeAttr = (s: string) => xmlSafe(s).replace(/[&<>"'\t\n\r]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\t': '&#9;', '\n': '&#10;', '\r': '&#13;' })[c]!);

/** HTML as XML character data: CDATA, with `]]>` split across two sections. */
export const cdata = (s: string) => `<![CDATA[${xmlSafe(s).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function toDate(v: DateLike): Date | undefined {
  const d = v instanceof Date ? new Date(v.getTime()) : typeof v === 'number' ? new Date(v) : /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(v) ? new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(v) || v.length === 10 ? v : `${v}Z`) : new Date(Number.NaN);
  const y = d.getUTCFullYear();
  return Number.isNaN(d.getTime()) || y < 1970 || y > 9999 ? undefined : d;
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** RFC 822 / RFC 5322 date as RSS wants it, always in GMT: "Sat, 07 Sep 2002 00:00:01 GMT". */
export function rfc822(d: Date): string {
  return `${DAYS[d.getUTCDay()]}, ${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).padStart(4, '0')} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} GMT`;
}

/** RFC 3339 date as Atom and JSON Feed want it, in UTC, to the second: "2003-12-13T18:30:02Z". */
export function rfc3339(d: Date): string {
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}Z`;
}

/** An iTunes duration: whole seconds, or HH:MM:SS or MM:SS, as the form the spec allows. */
export function itunesDuration(v: number | string): string | undefined {
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0 || v > 359_999) return undefined;
    const h = Math.floor(v / 3600);
    const m = Math.floor((v % 3600) / 60);
    const s = v % 60;
    return h ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
  }
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m || Number(m[2]) > 59 && m[1] !== undefined || Number(m[3]) > 59) return undefined;
  return m[1] !== undefined ? `${Number(m[1])}:${m[2]!.padStart(2, '0')}:${m[3]}` : `${Number(m[2])}:${m[3]}`;
}

export function durationSeconds(v: number | string): number | undefined {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : undefined;
  const t = itunesDuration(v);
  if (!t) return undefined;
  const parts = t.split(':').map(Number);
  return parts.length === 3 ? parts[0]! * 3600 + parts[1]! * 60 + parts[2]! : parts[0]! * 60 + parts[1]!;
}

const isHttp = (u: string) => {
  if (!u || /[\s\u0000-\u001f]/.test(u)) return false;
  try {
    const x = new URL(u);
    return (x.protocol === 'http:' || x.protocol === 'https:') && x.hostname !== '';
  } catch {
    return false;
  }
};
const LANG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

// ================================================================== checking

/** Every problem with a feed, so a person fixes them in one go. Empty means it can be written. */
export function feedProblems(f: Feed, o: WriteOptions = {}): string[] {
  const out: string[] = [];
  const need = (v: string | undefined, what: string) => {
    if (typeof v !== 'string' || !v.trim()) out.push(`${what} is required`);
  };
  need(f.title, 'the feed title');
  need(f.description, 'the feed description');
  if (!isHttp(f.link)) out.push('the feed link must be an absolute http or https address');
  if (f.selfUrl !== undefined && !isHttp(f.selfUrl)) out.push('selfUrl must be an absolute http or https address');
  for (const [k, v] of [['image', f.image], ['icon', f.icon]] as const) if (v !== undefined && !isHttp(v)) out.push(`the feed ${k} must be an absolute http or https address`);
  if (f.language !== undefined && !LANG.test(f.language)) out.push(`language "${f.language}" is not a language tag`);
  if (f.updated !== undefined && !toDate(f.updated)) out.push('the feed date is not a valid date');
  if (f.ttlMinutes !== undefined && (!Number.isInteger(f.ttlMinutes) || f.ttlMinutes < 0)) out.push('ttlMinutes must be a whole number of minutes');
  for (const a of f.authors ?? []) personProblems(a, 'feed author', out);
  const ids = new Set<string>();
  if (f.items.length > (o.maxItems ?? 100) * 100) out.push('there are far too many items');
  f.items.forEach((it, i) => {
    const w = `item ${i + 1}${it.title ? ` ("${it.title.slice(0, 30)}")` : ''}`;
    if (!it.id || !it.id.trim()) out.push(`${w}: an id is required`);
    else if (ids.has(it.id)) out.push(`${w}: the id "${it.id.slice(0, 60)}" is used twice`);
    else ids.add(it.id);
    if (!it.title || !it.title.trim()) out.push(`${w}: a title is required`);
    if (it.link !== undefined && !isHttp(it.link)) out.push(`${w}: the link must be an absolute http or https address`);
    if (it.commentsUrl !== undefined && !isHttp(it.commentsUrl)) out.push(`${w}: commentsUrl must be an absolute http or https address`);
    if (it.image !== undefined && !isHttp(it.image)) out.push(`${w}: the image must be an absolute http or https address`);
    if (it.language !== undefined && !LANG.test(it.language)) out.push(`${w}: language is not a language tag`);
    for (const k of ['published', 'updated'] as const) if (it[k] !== undefined && !toDate(it[k]!)) out.push(`${w}: ${k} is not a valid date`);
    for (const a of it.authors ?? []) personProblems(a, `${w} author`, out);
    const e = it.enclosure;
    if (e) {
      if (!isHttp(e.url)) out.push(`${w}: the enclosure address must be an absolute http or https address`);
      if (!Number.isInteger(e.length) || e.length < 0) out.push(`${w}: the enclosure length must be a whole number of bytes`);
      if (!MIME.test(e.type)) out.push(`${w}: the enclosure type is not a media type`);
    }
    const p = it.podcast;
    if (p) {
      if (p.duration !== undefined && itunesDuration(p.duration) === undefined) out.push(`${w}: the duration "${String(p.duration)}" is not seconds or HH:MM:SS`);
      for (const k of ['episode', 'season'] as const) if (p[k] !== undefined && (!Number.isInteger(p[k]) || p[k]! < 0)) out.push(`${w}: ${k} must be a whole number`);
      if (p.image !== undefined && !isHttp(p.image)) out.push(`${w}: the podcast image must be an absolute http or https address`);
      if (p.transcript && (!isHttp(p.transcript.url) || !MIME.test(p.transcript.type))) out.push(`${w}: the transcript needs an address and a media type`);
      if (p.chapters && (!isHttp(p.chapters.url) || !MIME.test(p.chapters.type))) out.push(`${w}: the chapters need an address and a media type`);
    }
    for (const c of it.media?.content ?? []) {
      if (!isHttp(c.url)) out.push(`${w}: a media content address must be an absolute http or https address`);
      if (c.type !== undefined && !MIME.test(c.type)) out.push(`${w}: a media content type is not a media type`);
      for (const k of ['width', 'height', 'duration', 'fileSize'] as const) if (c[k] !== undefined && (!Number.isInteger(c[k]) || c[k]! < 0)) out.push(`${w}: media ${k} must be a whole number`);
    }
    if (it.media?.thumbnail && !isHttp(it.media.thumbnail.url)) out.push(`${w}: the thumbnail must be an absolute http or https address`);
  });
  const sp = f.podcast;
  if (sp) {
    if (sp.image !== undefined && !isHttp(sp.image)) out.push('the podcast image must be an absolute http or https address');
    if (sp.newFeedUrl !== undefined && !isHttp(sp.newFeedUrl)) out.push('newFeedUrl must be an absolute http or https address');
    if (sp.owner && (!sp.owner.name.trim() || !EMAIL.test(sp.owner.email))) out.push('the podcast owner needs a name and an email address');
    for (const c of sp.categories ?? []) if (c.some((x) => !x.trim())) out.push('a podcast category cannot be empty');
    for (const fu of sp.funding ?? []) if (!isHttp(fu.url) || !fu.text.trim()) out.push('podcast funding needs an address and a text');
    if (f.items.length && !f.items.every((i) => i.enclosure) && f.items.some((i) => i.podcast)) out.push('every podcast episode needs an enclosure with the audio');
  }
  return out;
}

function personProblems(p: Person, what: string, out: string[]) {
  if (!p.name || !p.name.trim()) out.push(`${what}: a name is required`);
  if (p.email !== undefined && !EMAIL.test(p.email)) out.push(`${what}: the email address is not valid`);
  if (p.url !== undefined && !isHttp(p.url)) out.push(`${what}: the url must be an absolute http or https address`);
  if (p.avatar !== undefined && !isHttp(p.avatar)) out.push(`${what}: the avatar must be an absolute http or https address`);
}

const newest = (f: Feed): Date | undefined => {
  const ds = [f.updated, ...f.items.flatMap((i) => [i.updated, i.published])].filter((x): x is DateLike => x !== undefined).map((x) => toDate(x)).filter((x): x is Date => x !== undefined);
  return ds.length ? new Date(Math.max(...ds.map((d) => d.getTime()))) : undefined;
};

/** The time of the newest change in the feed, for Last-Modified and for the feed's own date. */
export function lastChange(f: Feed): Date | undefined {
  return newest(f);
}

function prepare(f: Feed, o: WriteOptions): Feed {
  const problems = feedProblems(f, o);
  if (problems.length) throw new FeedError(problems);
  const sorted = [...f.items].sort((a, b) => (toDate(b.updated ?? b.published ?? 0)?.getTime() ?? 0) - (toDate(a.updated ?? a.published ?? 0)?.getTime() ?? 0));
  return { ...f, items: sorted.slice(0, o.maxItems ?? 100) };
}

// ================================================================== XML helpers

const tag = (name: string, text: string | undefined, attrs?: Record<string, string>) => (text === undefined ? '' : `<${name}${attrString(attrs)}>${escapeText(text)}</${name}>`);
const attrString = (a?: Record<string, string | undefined>) => (a ? Object.entries(a).filter(([, v]) => v !== undefined).map(([k, v]) => ` ${k}="${escapeAttr(v!)}"`).join('') : '');
const empty = (name: string, attrs: Record<string, string | undefined>) => `<${name}${attrString(attrs)}/>`;
const yesNo = (b: boolean) => (b ? 'true' : 'false');

// ================================================================== RSS 2.0

export function writeRss(feed: Feed, o: WriteOptions = {}): string {
  const f = prepare(feed, o);
  const usesItunes = !!f.podcast || f.items.some((i) => i.podcast);
  const usesMedia = f.items.some((i) => i.media);
  const usesPodcast = !!f.podcast?.locked || !!f.podcast?.funding?.length || f.items.some((i) => i.podcast?.transcript || i.podcast?.chapters);
  const usesContent = f.items.some((i) => i.contentHtml);
  const usesAtom = !!f.selfUrl;
  const usesDc = f.items.some((i) => i.authors?.length && !i.authors[0]!.email);
  const ns = [
    usesAtom ? ' xmlns:atom="http://www.w3.org/2005/Atom"' : '',
    usesContent ? ' xmlns:content="http://purl.org/rss/1.0/modules/content/"' : '',
    usesDc ? ' xmlns:dc="http://purl.org/dc/elements/1.1/"' : '',
    usesItunes ? ' xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"' : '',
    usesMedia ? ' xmlns:media="http://search.yahoo.com/mrss/"' : '',
    usesPodcast ? ' xmlns:podcast="https://podcastindex.org/namespace/1.0"' : '',
  ].join('');
  const built = newest(f);
  const L: string[] = [`<?xml version="1.0" encoding="UTF-8"?>`, `<rss version="2.0"${ns}>`, '<channel>'];
  L.push(tag('title', f.title), tag('link', f.link), tag('description', f.description));
  if (f.language) L.push(tag('language', f.language));
  if (f.copyright) L.push(tag('copyright', f.copyright));
  const upd = f.updated !== undefined ? toDate(f.updated) : built;
  if (upd) L.push(tag('lastBuildDate', rfc822(upd)));
  if (f.generator) L.push(tag('generator', f.generator));
  L.push(tag('docs', 'https://www.rssboard.org/rss-specification'));
  if (f.ttlMinutes !== undefined) L.push(tag('ttl', String(f.ttlMinutes)));
  for (const c of f.categories ?? []) L.push(tag('category', c));
  if (f.image) L.push(`<image>${tag('url', f.image)}${tag('title', f.title)}${tag('link', f.link)}</image>`);
  if (f.selfUrl) L.push(empty('atom:link', { href: f.selfUrl, rel: 'self', type: 'application/rss+xml' }));
  const sp = f.podcast;
  if (sp) {
    if (sp.author) L.push(tag('itunes:author', sp.author));
    if (sp.subtitle) L.push(tag('itunes:subtitle', sp.subtitle));
    if (sp.summary) L.push(tag('itunes:summary', sp.summary));
    if (sp.explicit !== undefined) L.push(tag('itunes:explicit', yesNo(sp.explicit)));
    if (sp.type) L.push(tag('itunes:type', sp.type));
    if (sp.image) L.push(empty('itunes:image', { href: sp.image }));
    if (sp.owner) L.push(`<itunes:owner>${tag('itunes:name', sp.owner.name)}${tag('itunes:email', sp.owner.email)}</itunes:owner>`);
    for (const c of sp.categories ?? []) L.push(c.length === 2 ? `<itunes:category text="${escapeAttr(c[0])}"><itunes:category text="${escapeAttr(c[1])}"/></itunes:category>` : empty('itunes:category', { text: c[0] }));
    if (sp.block) L.push(tag('itunes:block', 'Yes'));
    if (sp.complete) L.push(tag('itunes:complete', 'Yes'));
    if (sp.newFeedUrl) L.push(tag('itunes:new-feed-url', sp.newFeedUrl));
    if (sp.locked) L.push(`<podcast:locked${attrString({ owner: sp.locked.owner })}>${sp.locked.value ? 'yes' : 'no'}</podcast:locked>`);
    for (const fu of sp.funding ?? []) L.push(`<podcast:funding url="${escapeAttr(fu.url)}">${escapeText(fu.text)}</podcast:funding>`);
  }
  for (const it of f.items) L.push(rssItem(it));
  L.push('</channel>', '</rss>', '');
  return L.join('\n');
}

function rssItem(it: Item): string {
  const L: string[] = ['<item>', tag('title', it.title)];
  if (it.link) L.push(tag('link', it.link));
  L.push(`<guid isPermaLink="${/^https?:\/\//.test(it.id) && it.id === it.link ? 'true' : 'false'}">${escapeText(it.id)}</guid>`);
  if (it.summary) L.push(tag('description', it.summary));
  else if (it.contentHtml) L.push(`<description>${cdata(it.contentHtml)}</description>`);
  if (it.contentHtml && it.summary) L.push(`<content:encoded>${cdata(it.contentHtml)}</content:encoded>`);
  else if (it.contentHtml && !it.summary) L.push(`<content:encoded>${cdata(it.contentHtml)}</content:encoded>`);
  const pub = it.published !== undefined ? toDate(it.published) : it.updated !== undefined ? toDate(it.updated) : undefined;
  if (pub) L.push(tag('pubDate', rfc822(pub)));
  const a = it.authors?.[0];
  if (a) L.push(a.email ? tag('author', `${a.email} (${a.name})`) : tag('dc:creator', a.name));
  for (const c of it.categories ?? []) L.push(tag('category', c));
  if (it.commentsUrl) L.push(tag('comments', it.commentsUrl));
  if (it.enclosure) L.push(empty('enclosure', { url: it.enclosure.url, length: String(it.enclosure.length), type: it.enclosure.type }));
  const m = it.media;
  if (m) {
    for (const c of m.content ?? []) L.push(empty('media:content', { url: c.url, type: c.type, medium: c.medium, width: c.width?.toString(), height: c.height?.toString(), duration: c.duration?.toString(), fileSize: c.fileSize?.toString() }));
    if (m.thumbnail) L.push(empty('media:thumbnail', { url: m.thumbnail.url, width: m.thumbnail.width?.toString(), height: m.thumbnail.height?.toString() }));
    if (m.description) L.push(tag('media:description', m.description, { type: 'plain' }));
    if (m.credit) L.push(tag('media:credit', m.credit, { role: 'author' }));
  }
  const p = it.podcast;
  if (p) {
    if (p.duration !== undefined) L.push(tag('itunes:duration', itunesDuration(p.duration)!));
    if (p.episode !== undefined) L.push(tag('itunes:episode', String(p.episode)));
    if (p.season !== undefined) L.push(tag('itunes:season', String(p.season)));
    if (p.episodeType) L.push(tag('itunes:episodeType', p.episodeType));
    if (p.explicit !== undefined) L.push(tag('itunes:explicit', yesNo(p.explicit)));
    if (p.image) L.push(empty('itunes:image', { href: p.image }));
    if (p.subtitle) L.push(tag('itunes:subtitle', p.subtitle));
    if (p.summary) L.push(tag('itunes:summary', p.summary));
    if (p.block) L.push(tag('itunes:block', 'Yes'));
    if (p.transcript) L.push(empty('podcast:transcript', { url: p.transcript.url, type: p.transcript.type, language: p.transcript.language }));
    if (p.chapters) L.push(empty('podcast:chapters', { url: p.chapters.url, type: p.chapters.type }));
  }
  L.push('</item>');
  return L.join('\n');
}

// ================================================================== Atom 1.0

export function writeAtom(feed: Feed, o: WriteOptions = {}): string {
  const f = prepare(feed, o);
  const upd = f.updated !== undefined ? toDate(f.updated) : newest(f);
  if (!upd) throw new FeedError(['an Atom feed needs a date: give the feed or an item an updated time']);
  const itemsMissing = f.items.filter((i) => !toDate(i.updated ?? i.published ?? Number.NaN)).map((i) => i.id);
  if (itemsMissing.length) throw new FeedError([`Atom entries need an updated or published date: ${itemsMissing.slice(0, 5).join(', ')}`]);
  const usesMedia = f.items.some((i) => i.media);
  const L: string[] = [`<?xml version="1.0" encoding="UTF-8"?>`, `<feed xmlns="http://www.w3.org/2005/Atom"${f.language ? ` xml:lang="${escapeAttr(f.language)}"` : ''}${usesMedia ? ' xmlns:media="http://search.yahoo.com/mrss/"' : ''}>`];
  L.push(tag('id', f.id ?? f.selfUrl ?? f.link), tag('title', f.title, { type: 'text' }), tag('subtitle', f.description, { type: 'text' }), tag('updated', rfc3339(upd)));
  L.push(empty('link', { rel: 'alternate', type: 'text/html', href: f.link }));
  if (f.selfUrl) L.push(empty('link', { rel: 'self', type: 'application/atom+xml', href: f.selfUrl }));
  for (const a of f.authors ?? []) L.push(atomPerson('author', a));
  for (const c of f.categories ?? []) L.push(empty('category', { term: c }));
  if (f.generator) L.push(tag('generator', f.generator));
  if (f.icon) L.push(tag('icon', f.icon));
  if (f.image) L.push(tag('logo', f.image));
  if (f.copyright) L.push(tag('rights', f.copyright, { type: 'text' }));
  for (const it of f.items) {
    L.push('<entry>', tag('id', it.id), tag('title', it.title, { type: 'text' }));
    L.push(tag('updated', rfc3339(toDate(it.updated ?? it.published!)!)));
    if (it.published !== undefined) L.push(tag('published', rfc3339(toDate(it.published)!)));
    if (it.link) L.push(empty('link', { rel: 'alternate', type: 'text/html', href: it.link }));
    if (it.enclosure) L.push(empty('link', { rel: 'enclosure', type: it.enclosure.type, href: it.enclosure.url, length: String(it.enclosure.length) }));
    if (it.commentsUrl) L.push(empty('link', { rel: 'replies', href: it.commentsUrl }));
    if (it.authors?.length) for (const a of it.authors) L.push(atomPerson('author', a));
    else if (!f.authors?.length) L.push('<author><name>Unknown</name></author>');
    for (const c of it.categories ?? []) L.push(empty('category', { term: c }));
    if (it.summary) L.push(tag('summary', it.summary, { type: 'text' }));
    if (it.contentHtml) L.push(`<content type="html">${escapeText(it.contentHtml)}</content>`);
    else if (it.contentText) L.push(tag('content', it.contentText, { type: 'text' }));
    const m = it.media;
    if (m) {
      for (const c of m.content ?? []) L.push(empty('media:content', { url: c.url, type: c.type, medium: c.medium, width: c.width?.toString(), height: c.height?.toString() }));
      if (m.thumbnail) L.push(empty('media:thumbnail', { url: m.thumbnail.url }));
    }
    L.push('</entry>');
  }
  L.push('</feed>', '');
  return L.join('\n');
}

function atomPerson(name: string, p: Person): string {
  return `<${name}>${tag('name', p.name)}${p.email ? tag('email', p.email) : ''}${p.url ? tag('uri', p.url) : ''}</${name}>`;
}

// ================================================================== JSON Feed 1.1

export function writeJsonFeed(feed: Feed, o: WriteOptions = {}): string {
  const f = prepare(feed, o);
  const author = (a: Person) => ({ name: a.name, ...(a.url ? { url: a.url } : {}), ...(a.avatar ? { avatar: a.avatar } : {}) });
  const obj = {
    version: 'https://jsonfeed.org/version/1.1',
    title: f.title,
    home_page_url: f.link,
    ...(f.selfUrl ? { feed_url: f.selfUrl } : {}),
    description: f.description,
    ...(f.image ? { icon: f.image } : {}),
    ...(f.icon ? { favicon: f.icon } : {}),
    ...(f.authors?.length ? { authors: f.authors.map(author) } : {}),
    ...(f.language ? { language: f.language } : {}),
    items: f.items.map((it) => ({
      id: it.id,
      ...(it.link ? { url: it.link } : {}),
      title: it.title,
      ...(it.contentHtml ? { content_html: it.contentHtml } : {}),
      ...(it.contentText ? { content_text: it.contentText } : !it.contentHtml ? { content_text: it.summary ?? '' } : {}),
      ...(it.summary ? { summary: it.summary } : {}),
      ...(it.image ? { image: it.image } : it.media?.thumbnail ? { image: it.media.thumbnail.url } : {}),
      ...(it.published !== undefined ? { date_published: rfc3339(toDate(it.published)!) } : {}),
      ...(it.updated !== undefined ? { date_modified: rfc3339(toDate(it.updated)!) } : {}),
      ...(it.authors?.length ? { authors: it.authors.map(author) } : {}),
      ...(it.categories?.length ? { tags: [...it.categories] } : {}),
      ...(it.language ? { language: it.language } : {}),
      ...(it.enclosure
        ? { attachments: [{ url: it.enclosure.url, mime_type: it.enclosure.type, size_in_bytes: it.enclosure.length, ...(it.podcast?.duration !== undefined ? { duration_in_seconds: durationSeconds(it.podcast.duration)! } : it.enclosure.duration !== undefined ? { duration_in_seconds: it.enclosure.duration } : {}) }] }
        : {}),
    })),
  };
  return `${JSON.stringify(obj, (_k, v: unknown) => (typeof v === 'string' ? xmlSafe(v) : v), 2)}\n`;
}

// ================================================================== serving

export const CONTENT_TYPES: Readonly<Record<Format, string>> = {
  rss: 'application/rss+xml; charset=utf-8',
  atom: 'application/atom+xml; charset=utf-8',
  json: 'application/feed+json; charset=utf-8',
};

export function write(format: Format, feed: Feed, o: WriteOptions = {}): string {
  return format === 'rss' ? writeRss(feed, o) : format === 'atom' ? writeAtom(feed, o) : writeJsonFeed(feed, o);
}

/** A strong validator for a body. */
export function etagOf(body: string): string {
  return `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`;
}

export interface FeedResponse {
  readonly status: 200 | 304 | 400 | 405;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const weakTag = (t: string) => t.trim().replace(/^W\//, '');

/**
 * Answers a request for a feed. `headers` are the request's (lower-case names). A matching If-None-Match gives
 * 304 and ignores If-Modified-Since; with no If-None-Match, a feed not newer than If-Modified-Since gives 304.
 * Only GET and HEAD are served. `Last-Modified` is the newest change in the feed, never later than now.
 */
export function respond(format: Format, feed: Feed, req: { method?: string; headers?: Readonly<Record<string, string | undefined>> }, o: WriteOptions & { maxAgeSeconds?: number } = {}): FeedResponse {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return { status: 405, headers: { Allow: 'GET, HEAD' }, body: '' };
  const body = write(format, feed, o);
  const etag = etagOf(body);
  const now = (o.now ?? (() => Date.now()))();
  const changed = lastChange(feed);
  const lm = changed ? new Date(Math.min(changed.getTime(), now)) : undefined;
  const lmSeconds = lm ? Math.floor(lm.getTime() / 1000) : undefined;
  const headers: Record<string, string> = {
    'Content-Type': CONTENT_TYPES[format],
    ETag: etag,
    'Cache-Control': `public, max-age=${o.maxAgeSeconds ?? 300}`,
    Vary: 'Accept-Encoding',
    ...(lm ? { 'Last-Modified': rfc822(lm) } : {}),
  };
  const inm = req.headers?.['if-none-match'];
  let fresh = false;
  if (inm !== undefined) {
    fresh = inm.trim() === '*' || inm.split(',').some((t) => weakTag(t) === weakTag(etag));
  } else {
    const ims = req.headers?.['if-modified-since'];
    if (ims !== undefined && lmSeconds !== undefined) {
      const t = Date.parse(ims);
      if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(ims.trim()) && !Number.isNaN(t)) fresh = lmSeconds * 1000 <= t;
    }
  }
  if (fresh) {
    const { 'Content-Type': _ct, ...keep } = headers;
    return { status: 304, headers: keep, body: '' };
  }
  return { status: 200, headers, body: method === 'HEAD' ? '' : body };
}
