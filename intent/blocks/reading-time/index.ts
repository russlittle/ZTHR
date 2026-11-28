/**
 * How long a text takes to read or to hear, how many words it holds in any language, and where to cut it for an
 * excerpt. Words are found with the Unicode word-boundary rules (UAX #29, through Intl.Segmenter), so Thai and
 * other scripts written without spaces still count; Chinese, Japanese and Korean are counted in characters, the
 * unit their reading speeds are measured in, and a text that mixes them is timed as the sum of both. Reading speeds
 * are defaults to be overridden by what a publisher has measured; images add the time a reader spends on them
 * (twelve seconds for the first, one less for each after, three at the least). An excerpt ends at a sentence when
 * one fits in the limit, otherwise at a word, never inside a word, a letter with its accents, or an emoji, and
 * carries an ellipsis when it cut something off.
 *
 * Not here: syllable counting, language detection (the caller names the locale), and text-to-speech timing beyond
 * a words-per-minute rate. Pure: no clock, no network.
 */

export class InvalidInput extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'InvalidInput';
  }
}

export interface Count {
  /** Words in scripts that put spaces or boundaries between words. */
  readonly words: number;
  /** Han, kana and Hangul characters, each counted once. */
  readonly cjk: number;
  readonly images: number;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_G = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const MAX_INPUT = 20_000_000;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…' };

/** Plain text from HTML: scripts, styles and comments dropped, tags removed, common entities decoded. */
export function stripHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|th|blockquote|section|article|figure|figcaption|pre)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name) return NAMED[name.toLowerCase()] ?? m;
      const cp = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    });
}

function check(text: string): void {
  if (typeof text !== 'string') throw new InvalidInput('the text must be a string');
  if (text.length > MAX_INPUT) throw new InvalidInput(`the text is longer than ${MAX_INPUT} characters`);
}

/** Words, CJK characters and images in a text. With `html: true` markup is removed first and `<img>` tags are counted. */
export function count(text: string, o: { locale?: string; html?: boolean } = {}): Count {
  check(text);
  const images = o.html ? (text.match(/<img\b/gi) ?? []).length : 0;
  const plain = o.html ? stripHtml(text) : text;
  const seg = new Intl.Segmenter(o.locale, { granularity: 'word' });
  let words = 0;
  let cjk = 0;
  for (const s of seg.segment(plain)) {
    if (!s.isWordLike) continue;
    if (CJK.test(s.segment)) {
      cjk += (s.segment.match(CJK_G) ?? []).length;
      if (/[\p{L}\p{N}]/u.test(s.segment.replace(CJK_G, ''))) words++;
    } else words++;
  }
  return { words, cjk, images };
}

/** Typical silent reading speeds, per minute, by language: words, or characters for zh, ja and ko. Measured speeds beat these. */
export const READING_SPEEDS: Readonly<Record<string, { words: number; cjk: number }>> = {
  en: { words: 238, cjk: 300 },
  fr: { words: 214, cjk: 300 },
  de: { words: 179, cjk: 300 },
  es: { words: 218, cjk: 300 },
  it: { words: 188, cjk: 300 },
  pt: { words: 181, cjk: 300 },
  ru: { words: 184, cjk: 300 },
  zh: { words: 238, cjk: 255 },
  ja: { words: 238, cjk: 357 },
  ko: { words: 238, cjk: 226 },
};
const FALLBACK = READING_SPEEDS.en!;

export function speedFor(locale?: string): { words: number; cjk: number } {
  const lang = (locale ?? 'en').toLowerCase().split(/[-_]/)[0]!;
  return READING_SPEEDS[lang] ?? FALLBACK;
}

/** Seconds a reader spends on `n` images: 12, 11, 10 ... down to 3 each. */
export function imageSeconds(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.max(3, 12 - i);
  return s;
}

export interface Timing {
  readonly words: number;
  readonly cjk: number;
  readonly images: number;
  readonly seconds: number;
  /** Whole minutes for display: rounded, and never zero for a text that has anything in it. */
  readonly minutes: number;
}

export interface TimeOptions {
  readonly locale?: string;
  readonly html?: boolean;
  /** Words per minute; the language default when left out. */
  readonly wordsPerMinute?: number;
  readonly cjkPerMinute?: number;
}

function timing(c: Count, wpm: number, cpm: number, withImages: boolean): Timing {
  if (!(wpm > 0) || !(cpm > 0)) throw new InvalidInput('a speed must be more than zero');
  const seconds = Math.round((c.words / wpm + c.cjk / cpm) * 60 + (withImages ? imageSeconds(c.images) : 0));
  const empty = c.words + c.cjk + c.images === 0;
  return { ...c, seconds, minutes: empty ? 0 : Math.max(1, Math.round(seconds / 60)) };
}

export function readingTime(text: string, o: TimeOptions = {}): Timing {
  const c = count(text, { ...(o.locale ? { locale: o.locale } : {}), ...(o.html ? { html: true } : {}) });
  const d = speedFor(o.locale);
  return timing(c, o.wordsPerMinute ?? d.words, o.cjkPerMinute ?? d.cjk, true);
}

/** Time to hear the text read aloud: images take none, and a speaking rate (150 words a minute by default) applies. */
export function listeningTime(text: string, o: TimeOptions = {}): Timing {
  const c = count(text, { ...(o.locale ? { locale: o.locale } : {}), ...(o.html ? { html: true } : {}) });
  const d = speedFor(o.locale);
  return timing(c, o.wordsPerMinute ?? 150, o.cjkPerMinute ?? Math.min(d.cjk, 300), false);
}

/** "5 min read", with the minutes the caller's wording asks for; a one-line helper, not a localisation system. */
export function label(t: Timing, words: { one: string; other: string } = { one: 'min read', other: 'min read' }): string {
  return t.minutes === 0 ? '' : `${t.minutes} ${t.minutes === 1 ? words.one : words.other}`;
}

export interface ExcerptOptions {
  readonly locale?: string;
  readonly html?: boolean;
  /** Longest result in characters (grapheme clusters), ellipsis included. */
  readonly maxChars?: number;
  /** Longest result in words; applies as well as maxChars. */
  readonly maxWords?: number;
  readonly ellipsis?: string;
  /** A sentence ending is used when it falls in the last half of the allowance or later. Default 0.5. */
  readonly sentenceFrom?: number;
}

export interface Excerpt {
  readonly text: string;
  readonly truncated: boolean;
  readonly cutAt: 'none' | 'sentence' | 'word' | 'character';
}

const TRAILING = /[\s,;:\-–—([{"'“‘、，]+$/u;

/** A short beginning of the text for a list or a preview, cut where a reader would cut it. */
export function excerpt(text: string, o: ExcerptOptions = {}): Excerpt {
  check(text);
  const maxChars = o.maxChars ?? 160;
  if (!(maxChars >= 1)) throw new InvalidInput('maxChars must be at least 1');
  const ellipsis = o.ellipsis ?? '…';
  const plain = (o.html ? stripHtml(text) : text).replace(/\s+/g, ' ').trim();
  const graphemes = [...new Intl.Segmenter(o.locale, { granularity: 'grapheme' }).segment(plain)].map((s) => s.segment);
  const wordSeg = [...new Intl.Segmenter(o.locale, { granularity: 'word' }).segment(plain)];

  // How far the text may run: the character allowance, then the word allowance.
  let limit = graphemes.length;
  const room = maxChars - [...ellipsis].length;
  let fits = graphemes.length <= maxChars;
  if (!fits) limit = Math.max(0, room);
  if (o.maxWords !== undefined) {
    let n = 0;
    let end = plain.length;
    for (const s of wordSeg) {
      if (s.isWordLike && CJK.test(s.segment)) n += (s.segment.match(CJK_G) ?? []).length;
      else if (s.isWordLike) n++;
      if (n > o.maxWords) {
        end = s.index;
        break;
      }
    }
    if (end < plain.length) {
      const g = [...new Intl.Segmenter(o.locale, { granularity: 'grapheme' }).segment(plain.slice(0, end))].length;
      if (g < limit || fits) {
        limit = Math.min(limit, g);
        fits = false;
      }
    }
  }
  if (fits) return { text: plain, truncated: false, cutAt: 'none' };

  // Offsets (in UTF-16 units) of grapheme boundaries, so cuts stay on them.
  const bounds: number[] = [0];
  for (const g of graphemes) bounds.push(bounds[bounds.length - 1]! + g.length);
  const cut = bounds[Math.min(limit, graphemes.length)]!;
  const head = plain.slice(0, cut);

  // 1. A sentence end inside the head, late enough to be worth it.
  const from = Math.floor(cut * (o.sentenceFrom ?? 0.5));
  let sentenceEnd = -1;
  for (const s of new Intl.Segmenter(o.locale, { granularity: 'sentence' }).segment(plain)) {
    const end = s.index + s.segment.trimEnd().length;
    if (end <= cut && end >= from && end > 0) sentenceEnd = end;
    if (s.index > cut) break;
  }
  if (sentenceEnd > 0) {
    const t = plain.slice(0, sentenceEnd);
    const wholeSentenceFits = sentenceEnd < plain.length;
    return { text: wholeSentenceFits ? t + ellipsis : t, truncated: wholeSentenceFits, cutAt: 'sentence' };
  }

  // 2. The last word boundary at or before the cut.
  let wordEnd = -1;
  for (const s of wordSeg) {
    const end = s.index + s.segment.length;
    if (end > cut) {
      // A word that straddles the cut is dropped, unless it is CJK, where a character is the unit.
      if (s.isWordLike && CJK.test(s.segment) && s.index < cut) wordEnd = cut;
      break;
    }
    wordEnd = end;
  }
  if (wordEnd > 0) {
    const t = plain.slice(0, wordEnd).replace(TRAILING, '');
    if (t.length > 0) return { text: t + ellipsis, truncated: true, cutAt: CJK.test(plain.slice(wordEnd - 1, wordEnd)) ? 'character' : 'word' };
  }

  // 3. One long unbroken word: cut inside it, on a character boundary.
  const t = head.replace(TRAILING, '');
  return { text: t + ellipsis, truncated: true, cutAt: 'character' };
}
