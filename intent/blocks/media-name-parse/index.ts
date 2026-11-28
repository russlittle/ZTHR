/**
 * What a media file's path says it is. Movies, episodes, music tracks and extras, from the file name and the
 * folders it sits in, the way a library scanner needs them: a title to look up, and enough numbers and ids to
 * look it up exactly.
 *
 *  - Movies: "The.Matrix.1999.1080p.BluRay.x264-GRP", "Blade Runner 2049 (2017)", "1917.2019.2160p", a year that is
 *    also the title, editions ("Director's Cut", `{edition-Final Cut}`), parts (CD1, Part 2), ids in folder names
 *    (`{tmdb-603}`, `[imdbid-tt0133093]`).
 *  - Episodes: S01E02, S01E02E03, S01E02-E04, S01E02-04, 1x02, "Season 1 Episode 2", dates (2024-03-15), the
 *    concatenated 102 inside a season folder, Specials and S00, and anime: `[Group] Title - 05 [1080p][ABCD1234]`,
 *    absolute numbers, ranges, versions (`05v2`), and "S02E05 (053)" carrying both.
 *  - Folders: season folders in several languages, series and movie folders with a year and ids, album and disc
 *    folders, extras folders.
 *  - Music: "01 - Title", "1-02 Title", "Artist - Title", the artist and album from the folders, disc folders,
 *    various artists.
 *  - Quality words stripped from titles and kept: resolution, source, codecs, audio, HDR, languages, flags, group.
 *  - Sidecar names: "Movie.en.forced.srt" as a language and flags.
 *
 * Every pattern is anchored and bounded, input is cut at 1000 characters, and nothing is ever looked up on disk.
 * The clock is an argument (it decides which years count as years). Not here: looking titles up in a provider.
 */

export interface Quality {
  readonly resolution?: string;
  readonly source?: string;
  readonly videoCodec?: string;
  readonly audio: readonly string[];
  readonly hdr: readonly string[];
  readonly languages: readonly string[];
  readonly flags: readonly string[];
  readonly group?: string;
}

export interface Ids {
  readonly tmdb?: string;
  readonly imdb?: string;
  readonly tvdb?: string;
  readonly anidb?: string;
  readonly musicbrainz?: string;
}

interface Common {
  readonly source: string;
  /** The pattern that decided it; for debugging a wrong guess. */
  readonly pattern: string;
  readonly quality: Quality;
  readonly ids: Ids;
}

export interface Movie extends Common {
  readonly kind: 'movie';
  readonly title: string;
  readonly year?: number;
  readonly edition?: string;
  readonly part?: number;
}

export interface Episode extends Common {
  readonly kind: 'episode';
  readonly series: string;
  readonly seriesYear?: number;
  readonly season?: number;
  readonly episodes: readonly number[];
  readonly absolute?: readonly number[];
  /** ISO date for daily shows. */
  readonly date?: string;
  readonly title?: string;
  readonly special: boolean;
}

export interface Track extends Common {
  readonly kind: 'track';
  readonly title: string;
  readonly artist?: string;
  readonly albumArtist?: string;
  readonly album?: string;
  readonly year?: number;
  readonly disc?: number;
  readonly track?: number;
  readonly compilation: boolean;
}

export interface Extra extends Common {
  readonly kind: 'extra';
  readonly category: string;
  readonly title: string;
  /** The title of the movie or series it belongs to, when the path says. */
  readonly of?: string;
}

export interface Unknown {
  readonly kind: 'unknown';
  readonly source: string;
  readonly reason: string;
}

export type Identity = Movie | Episode | Track | Extra | Unknown;

export interface Options {
  /** For what counts as a plausible year: up to this year plus two. */
  readonly now?: () => number;
  /** Treat names like 102 as season 1 episode 2 even outside a season folder. */
  readonly concatenated?: boolean;
  /** When both name a series: the folder (default) or the file. */
  readonly prefer?: 'folder' | 'file';
  /** What the library is, if known: skips guessing between series and movie. */
  readonly library?: 'movies' | 'series' | 'music';
}

const MAX = 1000;

// ---------------------------------------------------------------- extensions

export const VIDEO_EXT: ReadonlySet<string> = new Set(['mkv', 'mp4', 'avi', 'm4v', 'mov', 'wmv', 'ts', 'm2ts', 'mpg', 'mpeg', 'webm', 'flv', 'iso', 'ogm', 'ogv', 'divx', 'vob', '3gp']);
export const AUDIO_EXT: ReadonlySet<string> = new Set(['mp3', 'flac', 'm4a', 'm4b', 'aac', 'ogg', 'oga', 'opus', 'wav', 'wma', 'alac', 'ape', 'wv', 'aiff', 'aif', 'dsf', 'mka']);
export const SUBTITLE_EXT: ReadonlySet<string> = new Set(['srt', 'vtt', 'ass', 'ssa', 'sub', 'idx', 'sup', 'ttml', 'smi']);

export function splitExt(name: string): { base: string; ext: string } {
  const m = /^(.*)\.([A-Za-z0-9]{1,5})$/.exec(name);
  if (m && m[1] && (VIDEO_EXT.has(m[2]!.toLowerCase()) || AUDIO_EXT.has(m[2]!.toLowerCase()) || SUBTITLE_EXT.has(m[2]!.toLowerCase()) || ['nfo', 'jpg', 'jpeg', 'png', 'txt'].includes(m[2]!.toLowerCase()))) return { base: m[1], ext: m[2]!.toLowerCase() };
  return { base: name, ext: '' };
}

// ---------------------------------------------------------------- text

/** A title as a comparison key: no case, accents, leading article or punctuation; & is "and". */
export function titleKey(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{Nd}]+/gu, ' ').trim().replace(/^(the|a|an)\s+/, '');
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Dots and underscores between words become spaces; acronyms like S.W.A.T. and numbers like 5.1 survive. */
function despace(s: string): string {
  const spaces = (s.match(/ /g) ?? []).length;
  const seps = (s.match(/[._]/g) ?? []).length;
  if (spaces >= seps) return s;
  let t = s.replace(/(?<![A-Za-z])((?:[A-Za-z]\.){2,}[A-Za-z]?)(?![A-Za-z])/g, (m) => m.replace(/\./g, '\u0001'));
  t = t.replace(/(?<=\d)\.(?=\d)/g, '\u0002').replace(/[._]+/g, ' ');
  return t.replace(/\u0001/g, '.').replace(/\u0002/g, '.');
}

const tidyTitle = (s: string): string => {
  const t = squash(s.replace(/^[\s\-–—_.,:;]+|[\s\-–—_,:;(\[{]+$/g, ''));
  return /(?:^|[ .])(?:[A-Za-z]\.){2,}$/.test(t) ? t : t.replace(/\.+$/, '');
};

// ---------------------------------------------------------------- quality words

const RES = /(?<![A-Za-z0-9])(2160p|1440p|1080[pi]|720p|576[pi]|540p|480[pi]|360p|4k|uhd)(?![A-Za-z0-9])/i;
const SRC = /(?<![A-Za-z0-9])(blu-?ray|bdremux|remux|bdrip|brrip|bd25|bd50|web-?dl|web-?rip|webrip|web|hdtv|pdtv|dsr|dvdrip|dvd-?r|dvdscr|dvd|hdrip|hdcam|camrip|telesync|hdts|r5|vhsrip|amzn|nf|dsnp|atvp|hmax)(?![A-Za-z0-9])/i;
const VCODEC = /(?<![A-Za-z0-9])(x264|x265|h\.?264|h\.?265|hevc|avc|xvid|divx|av1|vp9|mpeg-?2)(?![A-Za-z0-9])/i;
const ACODEC = /(?<![A-Za-z0-9])(dts-?hd(?:\.?ma)?|dts-?x|dts|truehd|atmos|e-?ac-?3|dd\+|ddp?\.?\d(?:\.\d)?|dd\.?\d\.\d|ac-?3|aac(?:\.?\d\.\d)?|flac|opus|mp3|lpcm|pcm)(?![A-Za-z0-9])/gi;
const CH = /(?<![A-Za-z0-9])([1-9]\.[01])(?![A-Za-z0-9])/;
const HDR = /(?<![A-Za-z0-9])(hdr10\+|hdr10|hdr|dolby\.?vision|dovi|dv|hlg|sdr)(?![A-Za-z0-9])/gi;
const LANG = /(?<![A-Za-z0-9])(multi|dual|vostfr|truefrench|french|german|spanish|italian|japanese|korean|russian|swedish|dutch|polish|portuguese|hindi|subbed|dubbed|eng|ita|ger|fre|spa|jpn)(?![A-Za-z0-9])/gi;
const FLAGS = /(?<![A-Za-z0-9])(proper|repack|rerip|internal|limited|extended|unrated|uncut|remastered|imax|3d|hsbs|hou|read\.?nfo|complete|hybrid|sample|criterion)(?![A-Za-z0-9])/gi;
const GROUP = /-([A-Za-z0-9]{2,12})$/;

const canon = (s: string) => s.toLowerCase().replace(/\./g, '').replace(/^blu-?ray$/, 'bluray').replace(/^web-?dl$/, 'web-dl').replace(/^web-?rip$|^webrip$/, 'webrip');

/** Where the first quality word starts in `s`, or -1. Ambiguous short words only count when another follows them. */
function firstQualityIndex(s: string): number {
  let best = -1;
  for (const re of [RES, VCODEC, new RegExp(SRC.source, 'i'), new RegExp(LANG.source.replace('|eng|ita|ger|fre|spa|jpn', ''), 'i'), new RegExp(FLAGS.source, 'i')]) {
    const m = re.exec(s);
    if (m && m.index > 0 && (best < 0 || m.index < best)) best = m.index;
  }
  return best;
}

export function parseQuality(s: string): Quality {
  const res = RES.exec(s)?.[1];
  const src = SRC.exec(s)?.[1];
  const v = VCODEC.exec(s)?.[1];
  const audio = [...s.matchAll(ACODEC)].map((m) => canon(m[1]!));
  const ch = CH.exec(s)?.[1];
  const group = GROUP.exec(s.trim())?.[1];
  const hdr = [...new Set([...s.matchAll(HDR)].map((m) => canon(m[1]!)))].map((h) => (h === 'dovi' || h === 'dolbyvision' ? 'dv' : h));
  const langs = [...new Set([...s.matchAll(LANG)].map((m) => m[1]!.toLowerCase()))];
  const flags = [...new Set([...s.matchAll(FLAGS)].map((m) => canon(m[1]!)))];
  const upper = res ? res.toLowerCase().replace('4k', '2160p').replace('uhd', '2160p') : undefined;
  return {
    ...(upper ? { resolution: upper } : {}), ...(src ? { source: canon(src) } : {}), ...(v ? { videoCodec: canon(v).replace(/^h?26(4|5)$/, 'h26$1').replace('hevc', 'h265').replace('avc', 'h264') } : {}),
    audio: [...new Set([...audio, ...(ch ? [ch] : [])])], hdr, languages: langs, flags, ...(group && !/^(\d+|dl|rip)$/i.test(group) ? { group } : {}),
  };
}

// ---------------------------------------------------------------- ids and tags

function takeIds(s: string): { s: string; ids: Ids; edition?: string } {
  const ids: { -readonly [K in keyof Ids]: string } = {};
  let edition: string | undefined;
  let t = s.replace(/[\[{(]\s*(tmdb|tmdbid|imdb|imdbid|tvdb|tvdbid|anidb|anidbid|mbid|musicbrainz)[-= :]*((?:tt)?[0-9a-f-]{1,40})\s*[\]})]/gi, (_m, k: string, v: string) => {
    const key = k.toLowerCase().replace(/id$/, '');
    if (key === 'tmdb') ids.tmdb = v;
    else if (key === 'imdb') ids.imdb = v;
    else if (key === 'tvdb') ids.tvdb = v;
    else if (key === 'anidb') ids.anidb = v;
    else ids.musicbrainz = v;
    return ' ';
  });
  t = t.replace(/\{edition-([^}]{1,60})\}/gi, (_m, e: string) => {
    edition = squash(e);
    return ' ';
  });
  const imdb = /(?<![A-Za-z0-9])(tt\d{7,9})(?![A-Za-z0-9])/.exec(t);
  if (imdb && !ids.imdb) {
    ids.imdb = imdb[1]!;
    t = t.replace(imdb[0], ' ');
  }
  return { s: t, ids, ...(edition ? { edition } : {}) };
}

const EDITION = /(?<![A-Za-z0-9])((?:director'?s|final|extended|theatrical|unrated|ultimate|special|collector'?s|anniversary|redux|uncut|imax|remastered|restored)(?:[ .]+(?:cut|edition|version))?)(?![A-Za-z0-9])/i;

// ---------------------------------------------------------------- years

function maxYear(o: Options): number {
  return new Date(o.now ? o.now() : Date.now()).getUTCFullYear() + 2;
}

/** The year a movie or series was made, from candidates in `s`, and where its token starts. */
function pickYear(s: string, limit: number, o: Options): { year: number; at: number; inBrackets: boolean } | undefined {
  const hits = [...s.matchAll(/(?<![0-9A-Za-z])([\(\[]?)(18[89]\d|19\d\d|20\d\d)([\)\]]?)(?![0-9A-Za-z])/g)]
    .map((m) => ({ year: Number(m[2]), at: m.index!, inBrackets: !!m[1] && !!m[3] }))
    .filter((h) => h.year <= maxYear(o));
  if (!hits.length) return undefined;
  const before = hits.filter((h) => limit < 0 || h.at < limit);
  const pool = before.length ? before : hits;
  const bracketed = pool.filter((h) => h.inBrackets);
  return (bracketed.length ? bracketed : pool)[(bracketed.length ? bracketed : pool).length - 1];
}

// ---------------------------------------------------------------- episodes

const SEASON_DIR = /^(?:season|series|staffel|saison|temporada|stagione|seizoen|s)[ ._-]*(\d{1,3})(?:\s*\(.*\)|\s*[-–].*)?$/i;
const SPECIALS_DIR = /^(?:specials?|extras?\s+season|season\s*0+)$/i;

/** The season a folder name says, 0 for Specials, undefined for anything else. */
export function parseSeasonDir(name: string): number | undefined {
  const n = squash(name);
  if (SPECIALS_DIR.test(n)) return 0;
  const m = SEASON_DIR.exec(n);
  return m ? Number(m[1]) : undefined;
}

const MAX_RANGE = 60;

function expandTail(first: number, tail: string): number[] {
  const out = [first];
  let prev = first;
  for (const m of tail.matchAll(/(-?E|-|\+E?)(\d{1,4})/gi)) {
    const n = Number(m[2]);
    const range = m[1]!.startsWith('-');
    if (range && n > prev && n - prev <= MAX_RANGE) for (let k = prev + 1; k <= n; k++) out.push(k);
    else out.push(n);
    prev = n;
  }
  return [...new Set(out)];
}

interface EpHit {
  readonly pattern: string;
  readonly index: number;
  readonly length: number;
  readonly season?: number;
  readonly episodes?: number[];
  readonly absolute?: number[];
  readonly date?: string;
}

const isoDate = (y: number, m: number, d: number): string | undefined => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y >= 1900 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : undefined;
};

function findEpisode(s: string, ctx: { seriesContext: boolean; seasonDir: boolean; concatenated: boolean; anime: boolean }, o: Options): EpHit | undefined {
  let m: RegExpExecArray | null;
  if ((m = /(?<![A-Za-z0-9])S(\d{1,3})[ ._-]?E(\d{1,4})((?:[ ._]?(?:-?E|-|\+E?)\d{1,4}){0,20})(?:[ ._-]*\((\d{1,4})\))?/i.exec(s)))
    return { pattern: 'sxxexx', index: m.index, length: m[0].length, season: Number(m[1]), episodes: expandTail(Number(m[2]), m[3] ?? ''), ...(m[4] ? { absolute: [Number(m[4])] } : {}) };
  if ((m = /(?<![A-Za-z0-9])S(\d{1,3})[ ._-]*-[ ._-]*E(\d{1,4})/i.exec(s))) return { pattern: 'sxx-exx', index: m.index, length: m[0].length, season: Number(m[1]), episodes: [Number(m[2])] };
  if ((m = /(?<![0-9A-Za-z])(\d{1,2})x(\d{2,3})((?:-\d{2,3}){0,5})(?![0-9A-Za-z])/i.exec(s)) && !/^\d{3,4}$/.test(m[1]!)) {
    const tail = m[3] ? m[3].replace(/-(\d+)/g, '-$1') : '';
    return { pattern: 'nxnn', index: m.index, length: m[0].length, season: Number(m[1]), episodes: expandTail(Number(m[2]), tail) };
  }
  if ((m = /(?<![A-Za-z0-9])(?:season|series|staffel|saison)[ ._-]*(\d{1,3})[ ._,-]*(?:episode|ep|e)[ ._-]*(\d{1,4})(?![0-9])/i.exec(s))) return { pattern: 'season-episode-words', index: m.index, length: m[0].length, season: Number(m[1]), episodes: [Number(m[2])] };
  if ((m = /(?<![0-9])((?:19|20)\d\d)[-. _/](0[1-9]|1[0-2])[-. _/](0[1-9]|[12]\d|3[01])(?![0-9])/.exec(s))) {
    const d = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (d) return { pattern: 'date-ymd', index: m.index, length: m[0].length, date: d };
  }
  if ((m = /(?<![0-9])(0[1-9]|[12]\d|3[01])[-. _/](0[1-9]|1[0-2])[-. _/]((?:19|20)\d\d)(?![0-9])/.exec(s))) {
    const d = isoDate(Number(m[3]), Number(m[2]), Number(m[1]));
    if (d && Number(m[1]) > 12) return { pattern: 'date-dmy', index: m.index, length: m[0].length, date: d };
  }
  if ((m = /(?<![A-Za-z0-9])(?:episode|ep|e|#)[ ._-]?(\d{1,4})(?:v\d)?(?:-(\d{1,4}))?(?![0-9A-Za-z])/i.exec(s)) && (ctx.seriesContext || ctx.anime || /^(?:episode|ep)/i.test(m[0]))) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : undefined;
    const eps = b !== undefined && b > a && b - a <= MAX_RANGE ? Array.from({ length: b - a + 1 }, (_, k) => a + k) : [a];
    return { pattern: 'episode-word', index: m.index, length: m[0].length, episodes: eps };
  }
  if (ctx.anime && (m = /(?:^|\s)-\s+(\d{1,4})(?:v\d)?(?:-(\d{1,4})(?:v\d)?)?(?=\s|$|\[|\()/.exec(s))) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : undefined;
    const abs = b !== undefined && b > a && b - a <= MAX_RANGE ? Array.from({ length: b - a + 1 }, (_, k) => a + k) : [a];
    return { pattern: 'absolute', index: m.index, length: m[0].length, absolute: abs, episodes: abs };
  }
  if (ctx.seriesContext || ctx.concatenated) {
    const lim = maxYear(o);
    for (const t of s.matchAll(/(?<![0-9A-Za-z])(\d{3,4})(?![0-9A-Za-z])/g)) {
      const n = t[1]!;
      const v = Number(n);
      if ([480, 576, 720, 1080, 1440, 2160].includes(v) || (v >= 1900 && v <= lim)) continue;
      const se = Number(n.slice(0, -2));
      const ep = Number(n.slice(-2));
      if (se >= 1 && se <= 30 && ep >= 1 && t.index! > 0) return { pattern: 'concatenated', index: t.index!, length: n.length, season: se, episodes: [ep] };
    }
  }
  if (ctx.seriesContext && (m = /^(\d{1,3})(?:v\d)?(?:\s*[-.)]\s*|\s+)(?=\S)/.exec(s))) return { pattern: 'leading-number', index: 0, length: m[0].length, episodes: [Number(m[1])] };
  if (ctx.seasonDir && (m = /(?<=\S)\s+(\d{1,3})$/.exec(s)) && !(Number(m[1]) >= 1900)) return { pattern: 'trailing-number', index: m.index, length: m[0].length, episodes: [Number(m[1])] };
  if ((m = /(?<![A-Za-z0-9])(?:special|sp|ova|oad|ona)[ ._-]?(\d{1,3})(?![0-9])/i.exec(s))) return { pattern: 'special-word', index: m.index, length: m[0].length, season: 0, episodes: [Number(m[1])] };
  return undefined;
}

// ---------------------------------------------------------------- the main parse of one name

interface Ctx {
  readonly seasonDir?: boolean;
  readonly seriesName?: string;
  readonly seriesYear?: number;
  readonly season?: number;
  readonly seriesIds?: Ids;
  readonly seriesContext: boolean;
}

function prepare(raw: string): { s: string; ids: Ids; edition?: string; group?: string; anime: boolean } {
  let name = raw.normalize('NFC').slice(0, MAX);
  let group: string | undefined;
  let anime = false;
  const fan = /^\[([^\]]{1,40})\][ ._]*/.exec(name);
  if (fan) {
    group = fan[1]!;
    anime = true;
    name = name.slice(fan[0].length);
  }
  if (/\[[0-9A-Fa-f]{8}\]|\([0-9A-Fa-f]{8}\)/.test(name)) anime = true;
  name = name.replace(/[\[(][0-9A-Fa-f]{8}[\])]/g, ' ');
  const t = takeIds(name);
  const s = squash(despace(t.s).replace(/[\[\]{}]/g, ' ').replace(/\(\s*\)/g, ' '));
  return { s, ids: t.ids, ...(t.edition ? { edition: t.edition } : {}), ...(group ? { group } : {}), anime };
}

function qualityOf(s: string, group?: string): Quality {
  const q = parseQuality(s);
  return group && !q.group ? { ...q, group } : q;
}

function parseEpisodeName(raw: string, ctx: Ctx, o: Options): Episode | undefined {
  const p = prepare(raw);
  const hit = findEpisode(p.s, { seriesContext: ctx.seriesContext, seasonDir: !!ctx.seasonDir, concatenated: !!o.concatenated, anime: p.anime || !!p.group }, o);
  if (!hit) return undefined;
  const head = p.s.slice(0, hit.index);
  const tail = p.s.slice(hit.index + hit.length);
  const q = firstQualityIndex(tail);
  const epTitle = tidyTitle(tail.slice(0, q < 0 ? undefined : q).replace(/(?:^|\s)\(?\d{1,4}\)?(?=\s*$)/, ''));
  const y = pickYear(head, -1, o);
  let series = tidyTitle(y ? head.replace(/[(\[]?\s*(?:18|19|20)\d\d\s*[)\]]?\s*$/, '') : head);
  series = tidyTitle(series.replace(/\s+-\s*$/, ''));
  const special = hit.season === 0 || hit.pattern === 'special-word' || ctx.season === 0;
  return {
    kind: 'episode', source: raw, pattern: hit.pattern, quality: qualityOf(p.s, p.group), ids: { ...(ctx.seriesIds ?? {}), ...p.ids },
    series: o.prefer === 'file' || !ctx.seriesName ? series || ctx.seriesName || '' : ctx.seriesName, ...(y ? { seriesYear: y.year } : ctx.seriesYear ? { seriesYear: ctx.seriesYear } : {}),
    ...(hit.season !== undefined ? { season: hit.season } : ctx.season !== undefined ? { season: ctx.season } : hit.date || hit.pattern === 'absolute' ? {} : hit.episodes ? { season: 1 } : {}),
    episodes: hit.episodes ?? [], ...(hit.absolute ? { absolute: hit.absolute } : {}), ...(hit.date ? { date: hit.date } : {}), ...(epTitle && !/^(?:v\d)$/i.test(epTitle) ? { title: epTitle } : {}), special,
  };
}

function parseMovieName(raw: string, o: Options): Movie {
  const p = prepare(raw);
  const q = firstQualityIndex(p.s);
  const ed = EDITION.exec(p.s);
  const y = pickYear(p.s, q, o);
  const partM = [...p.s.matchAll(/(?<![A-Za-z0-9])(?:cd|disc|disk|part|pt)[ ._-]?(\d{1,2})(?![A-Za-z0-9])/gi)].filter((x) => x.index! > 0).pop();
  const cuts = [q, y && y.at > 0 ? y.at : -1, ed && ed.index > 0 ? ed.index : -1, partM ? partM.index : -1].filter((x) => x > 0);
  const cut = cuts.length ? Math.min(...cuts) : p.s.length;
  let title = tidyTitle(p.s.slice(0, cut).replace(/\s*[\(\[]\s*$/, ''));
  if (!title && y) title = String(y.year);
  const edition = p.edition ?? (ed ? squash(ed[1]!.replace(/\./g, ' ')) : undefined);
  return {
    kind: 'movie', source: raw, pattern: y ? (y.inBrackets ? 'title-(year)' : 'title-year') : q >= 0 ? 'title-quality' : 'title', quality: qualityOf(p.s, p.group), ids: p.ids, title,
    ...(y && !(y.at === 0 && !title.length) ? (y.at === 0 && title === String(y.year) ? {} : { year: y.year }) : {}), ...(edition ? { edition } : {}), ...(partM ? { part: Number(partM[1]) } : {}),
  };
}

// ---------------------------------------------------------------- music

const DISC_DIR = /^(?:cd|disc|disk|dvd)[ ._-]?(\d{1,2})(?:\s*[-–:].*)?$/i;
const VA = /^(?:various(?: artists?)?|va|v\.a\.|compilation)$/i;

export function parseDiscDir(name: string): number | undefined {
  const m = DISC_DIR.exec(squash(name));
  return m ? Number(m[1]) : undefined;
}

/** "Artist - Album (Year) [FLAC]" or "Album (Year)": the parts a folder name has. */
export function parseAlbumDir(name: string, o: Options = {}): { artist?: string; album: string; year?: number; tags: string[] } {
  const p = prepare(name);
  const tags: string[] = [];
  let s = p.s.replace(/\b(flac|mp3|aac|alac|wav|ape|24[- ]?bit|16[- ]?bit|320|v0|v2|vbr|cbr|web|cd|vinyl|lossless)\b/gi, (m) => {
    tags.push(m.toLowerCase());
    return ' ';
  });
  const y = pickYear(s, -1, o);
  if (y) s = s.replace(/[(\[]?\s*(?:18|19|20)\d\d\s*[)\]]?/, (m) => (Number(m.replace(/\D/g, '')) === y.year ? ' ' : m));
  s = tidyTitle(s);
  const m = /^(.{1,100}?)\s+-\s+(.{1,150})$/.exec(s);
  return { ...(m ? { artist: tidyTitle(m[1]!), album: tidyTitle(m[2]!) } : { album: s }), ...(y ? { year: y.year } : {}), tags };
}

interface TrackName {
  readonly title: string;
  readonly track?: number;
  readonly disc?: number;
  readonly artist?: string;
  readonly pattern: string;
}

export function parseTrackName(base: string, hint: { artists?: readonly string[] } = {}): TrackName {
  const s = squash(base.normalize('NFC').slice(0, MAX).replace(/_/g, ' '));
  let m: RegExpExecArray | null;
  const isHinted = (a: string) => (hint.artists ?? []).some((x) => titleKey(x) === titleKey(a));
  if ((m = /^(\d{1,2})[-.](\d{2,3})\s*[-._) ]\s*(.+)$/.exec(s)) && Number(m[1]) <= 30) return { title: m[3]!, track: Number(m[2]), disc: Number(m[1]), pattern: 'disc-track' };
  if ((m = /^(\d{1,3})\s*[-._)]\s*(.+)$/.exec(s)) || (m = /^(0\d{1,2})\s+(.+)$/.exec(s))) {
    const rest = m[2]!;
    const a = /^(.{1,80}?)\s+-\s+(.+)$/.exec(rest);
    if (a && isHinted(a[1]!)) return { title: a[2]!, track: Number(m[1]), artist: a[1]!, pattern: 'track-artist-title' };
    if (a && !hint.artists?.length) return { title: a[2]!, track: Number(m[1]), artist: a[1]!, pattern: 'track-artist-title' };
    return { title: rest, track: Number(m[1]), pattern: 'track-title' };
  }
  if ((m = /^(.{1,80}?)\s+-\s+(.+)$/.exec(s))) return { title: m[2]!, artist: m[1]!, pattern: 'artist-title' };
  return { title: s, pattern: 'title' };
}

// ---------------------------------------------------------------- identify a path

const EXTRAS_DIRS: Record<string, string> = {
  extras: 'extra', featurettes: 'featurette', 'behind the scenes': 'behindthescenes', 'deleted scenes': 'deletedscene', interviews: 'interview', trailers: 'trailer', samples: 'sample', shorts: 'short', scenes: 'scene', 'other': 'other',
};
const EXTRA_SUFFIX = /[-. _](trailer|sample|featurette|behindthescenes|deleted|interview|scene|short|other)$/i;

function splitPath(p: string): string[] {
  return p.replace(/\\/g, '/').split('/').filter((x) => x && x !== '.');
}

/**
 * What a path is. `path` is relative to the library root, so the first folder is the series, movie or artist.
 * With `library` set that decides between series, movies and music; without, the name and the extension do.
 */
export function identify(path: string, o: Options = {}): Identity {
  const parts = splitPath(path.slice(0, 4096));
  if (parts.length === 0) return { kind: 'unknown', source: path, reason: 'empty path' };
  if (parts.some((x) => x.length > 255)) return { kind: 'unknown', source: path.slice(0, 100), reason: 'a name is longer than 255 characters' };
  if (parts.includes('..')) return { kind: 'unknown', source: path, reason: 'path climbs out of the library' };
  const file = parts[parts.length - 1]!;
  const dirs = parts.slice(0, -1);
  const { base, ext } = splitExt(file);
  const audio = AUDIO_EXT.has(ext);
  const lib = o.library ?? (audio ? 'music' : undefined);

  // extras: a known folder, or a suffix on the file name
  const xd = [...dirs].reverse().findIndex((d) => EXTRAS_DIRS[d.toLowerCase()] !== undefined);
  const sfx = EXTRA_SUFFIX.exec(base);
  if (lib !== 'music' && (xd >= 0 || sfx)) {
    const dir = xd >= 0 ? dirs[dirs.length - 1 - xd]! : undefined;
    const owner = xd >= 0 ? dirs[dirs.length - 2 - xd] : undefined;
    const category = dir ? EXTRAS_DIRS[dir.toLowerCase()]! : sfx![1]!.toLowerCase().replace('deleted', 'deletedscene');
    const ownerName = owner ? (lib === 'series' ? tidyTitle(prepare(owner).s.replace(/\s*\(?(?:18|19|20)\d\d\)?\s*$/, '')) : parseMovieName(owner, o).title) : sfx ? parseMovieName(base.slice(0, sfx.index), o).title : undefined;
    const p = prepare(sfx ? base.slice(0, sfx.index) : base);
    return { kind: 'extra', source: path, pattern: dir ? 'extras-folder' : 'extra-suffix', quality: qualityOf(p.s, p.group), ids: p.ids, category, title: tidyTitle(sfx ? category : p.s.slice(0, Math.max(0, firstQualityIndex(p.s)) || undefined) || p.s), ...(ownerName ? { of: ownerName } : {}) };
  }

  if (lib === 'music') return identifyTrack(path, dirs, base, o);

  // series context from the folders
  let season: number | undefined;
  let seasonAt = -1;
  for (let i = dirs.length - 1; i >= 0; i--) {
    const sn = parseSeasonDir(dirs[i]!);
    if (sn !== undefined) {
      season = sn;
      seasonAt = i;
      break;
    }
  }
  const seriesDir = seasonAt > 0 ? dirs[seasonAt - 1] : seasonAt === 0 ? undefined : lib === 'series' && dirs.length ? dirs[dirs.length - 1] : undefined;
  const sp = seriesDir ? prepare(seriesDir) : undefined;
  const sy = sp ? pickYear(sp.s, -1, o) : undefined;
  const seriesName = sp ? tidyTitle(sp.s.replace(/\s*[(\[]?(?:18|19|20)\d\d[)\]]?\s*$/, '')) : undefined;
  const ctx: Ctx = {
    seriesContext: seasonAt >= 0 || lib === 'series', seasonDir: seasonAt >= 0,
    ...(seriesName ? { seriesName } : {}), ...(sy ? { seriesYear: sy.year } : {}), ...(season !== undefined ? { season } : {}), ...(sp ? { seriesIds: sp.ids } : {}),
  };
  if (lib !== 'movies') {
    const ep = parseEpisodeName(base, ctx, o);
    if (ep && (ep.episodes.length || ep.date)) return ep.series || !ctx.seriesContext ? ep : { ...ep, series: seriesName ?? '' };
  }
  if (lib === 'series') return { kind: 'unknown', source: path, reason: 'no episode number found' };
  // a movie: the file name, falling back to the folder it sits in
  const m = parseMovieName(base, o);
  const folder = dirs.length ? parseMovieName(dirs[dirs.length - 1]!, o) : undefined;
  if (folder && (!m.title || (folder.year !== undefined && m.year === undefined && titleKey(m.title) === titleKey(folder.title)) || /^(?:movie|film|video|main|title)$/i.test(m.title))) {
    return { ...m, title: folder.title || m.title, ...(folder.year ? { year: folder.year } : {}), ids: { ...folder.ids, ...m.ids }, ...(m.part ? { part: m.part } : {}), pattern: 'folder+file' };
  }
  if (!m.title) return { kind: 'unknown', source: path, reason: 'no title in the name' };
  return folder?.ids && Object.keys(folder.ids).length ? { ...m, ids: { ...folder.ids, ...m.ids } } : m;
}

function identifyTrack(path: string, dirs: readonly string[], base: string, o: Options): Identity {
  let disc: number | undefined;
  let d = [...dirs];
  const last = d[d.length - 1];
  if (last !== undefined && parseDiscDir(last) !== undefined) {
    disc = parseDiscDir(last)!;
    d = d.slice(0, -1);
  }
  const albumDir = d[d.length - 1];
  const parent = d.length >= 2 ? d[d.length - 2] : undefined;
  const al = albumDir ? parseAlbumDir(albumDir, o) : undefined;
  const folderArtist = parent ?? al?.artist;
  const compilation = !!folderArtist && VA.test(folderArtist.trim());
  const t = parseTrackName(base, { artists: folderArtist && !compilation ? [folderArtist] : [] });
  const artist = t.artist ?? (compilation ? undefined : folderArtist);
  const q = prepare(base);
  return {
    kind: 'track', source: path, pattern: t.pattern, quality: qualityOf(q.s, q.group), ids: {}, title: tidyTitle(t.title),
    ...(artist ? { artist } : {}), ...(folderArtist ? { albumArtist: folderArtist } : {}), ...(al ? { album: al.album } : {}), ...(al?.year ? { year: al.year } : {}),
    ...(t.disc ?? disc ? { disc: (t.disc ?? disc)! } : {}), ...(t.track !== undefined ? { track: t.track } : {}), compilation,
  };
}

// ---------------------------------------------------------------- sidecars

export interface Sidecar {
  /** The media file name it belongs next to, without extension. */
  readonly stem: string;
  readonly ext: string;
  readonly language?: string;
  readonly flags: readonly string[];
}

const LANG2 = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;
const SIDE_FLAGS = new Set(['forced', 'sdh', 'cc', 'hi', 'default', 'commentary']);

/** "Movie (2019).en.forced.srt": the media stem, a language code, and flags. */
export function parseSidecar(name: string): Sidecar | undefined {
  const { base, ext } = splitExt(name.slice(0, MAX));
  if (!ext || !(SUBTITLE_EXT.has(ext) || AUDIO_EXT.has(ext))) return undefined;
  const parts = base.split('.');
  const flags: string[] = [];
  let language: string | undefined;
  while (parts.length > 1) {
    const x = parts[parts.length - 1]!;
    if (SIDE_FLAGS.has(x.toLowerCase())) flags.unshift(x.toLowerCase());
    else if (!language && LANG2.test(x) && !/^\d+$/.test(x)) language = x.toLowerCase();
    else break;
    parts.pop();
  }
  return { stem: parts.join('.'), ext, ...(language ? { language } : {}), flags };
}

// ---------------------------------------------------------------- keys

/** A stable key for "the same episode": series, season and the first episode (or the date). */
export function episodeKey(e: Episode): string {
  const s = titleKey(e.series);
  if (e.date) return `${s}|${e.date}`;
  if (e.season === undefined && e.absolute?.length) return `${s}|abs${e.absolute[0]}`;
  return `${s}|s${e.season ?? 0}e${e.episodes[0] ?? 0}`;
}

export const movieKey = (m: Movie): string => `${titleKey(m.title)}|${m.year ?? ''}`;
