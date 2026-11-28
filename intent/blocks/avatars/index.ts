/**
 * Pictures for people who have not uploaded one, made the same every time from what is known about them.
 * Identicons: a symmetric 5 by 5 pattern and a colour drawn from a SHA-256 of any seed, so a person keeps the same
 * face across pages and devices. Initials: the letters a person's name stands for (Unicode-aware, so "Zoë van
 * der Berg" is ZB, "王伟" is 王伟, and an address such as ana.lopez@example.com is AL) on one of twelve colours
 * chosen from the name, with the text colour picked by WCAG contrast. Gravatar-style hashing: an email is
 * trimmed, lower-cased and hashed (MD5 as Gravatar began, or SHA-256), and the avatar address is built with a size,
 * a default and a rating, all checked. A small directory answers "which person owns this hash" and an avatar
 * server function answers a request for a hash the way Gravatar does: the person's choice, or a generated default,
 * or a 404 when asked. All SVG is built from numbers and escaped text, never from a caller's markup.
 *
 * Out of scope: raster formats (PNG and JPEG output), fetching remote avatars, and uploading pictures (see media-assets).
 */
import { createHash } from 'node:crypto';

export class AvatarError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export type HashAlgorithm = 'md5' | 'sha256';

/** Sizes an avatar is offered in, in pixels. */
export const SIZE_SET: readonly number[] = [16, 24, 32, 48, 64, 96, 128, 256, 512];

const escapeXml = (s: string) => s.replace(/[&<>"'\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : c === "'" ? '&apos;' : ''));

// ================================================================== hashing

/** The hash an avatar service looks a person up by: trimmed, lower-cased, then hashed. */
export function emailHash(email: string, algorithm: HashAlgorithm = 'sha256'): string {
  const e = email.trim().toLowerCase();
  if (!e || e.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(e)) throw new AvatarError('that is not an email address');
  return createHash(algorithm).update(e, 'utf8').digest('hex');
}

const HASH = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/;
export const isAvatarHash = (s: string) => HASH.test(s);

export interface GravatarOptions {
  readonly size?: number;
  /** 404, mp, identicon, monsterid, wavatar, retro, robohash, blank, or an https address. */
  readonly fallback?: string;
  readonly rating?: 'g' | 'pg' | 'r' | 'x';
  readonly forceDefault?: boolean;
  readonly algorithm?: HashAlgorithm;
  readonly host?: string;
}

const FALLBACKS = new Set(['404', 'mp', 'identicon', 'monsterid', 'wavatar', 'retro', 'robohash', 'blank']);

/** The address of a Gravatar-style avatar, with every option checked and encoded. */
export function gravatarUrl(email: string, o: GravatarOptions = {}): string {
  const size = o.size ?? 80;
  if (!Number.isInteger(size) || size < 1 || size > 2048) throw new AvatarError('a size is a whole number of pixels from 1 to 2048');
  const q: string[] = [`s=${size}`];
  if (o.fallback !== undefined) {
    if (!FALLBACKS.has(o.fallback)) {
      let ok = false;
      try {
        ok = new URL(o.fallback).protocol === 'https:';
      } catch {
        ok = false;
      }
      if (!ok) throw new AvatarError('the fallback is a named style or an https address');
    }
    q.push(`d=${encodeURIComponent(o.fallback)}`);
  }
  if (o.rating !== undefined) {
    if (!['g', 'pg', 'r', 'x'].includes(o.rating)) throw new AvatarError('a rating is g, pg, r or x');
    q.push(`r=${o.rating}`);
  }
  if (o.forceDefault) q.push('f=y');
  const host = o.host ?? 'www.gravatar.com';
  if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) throw new AvatarError('the host is not a host name');
  return `https://${host}/avatar/${emailHash(email, o.algorithm ?? 'sha256')}?${q.join('&')}`;
}

/** The smallest offered size that is at least as large as needed, after allowing for a denser screen. */
export function sizeFor(cssPixels: number, o: { density?: number; sizes?: readonly number[] } = {}): number {
  const sizes = [...(o.sizes ?? SIZE_SET)].sort((a, b) => a - b);
  if (!sizes.length) throw new AvatarError('there are no sizes to choose from');
  if (!Number.isFinite(cssPixels) || cssPixels <= 0) throw new AvatarError('a size must be more than zero');
  const need = Math.ceil(cssPixels * Math.max(1, o.density ?? 1));
  return sizes.find((s) => s >= need) ?? sizes[sizes.length - 1]!;
}

/** `srcset` text for 1x and 2x of a displayed size, for any function that makes an address for a size. */
export function srcset(url: (size: number) => string, cssPixels: number, sizes: readonly number[] = SIZE_SET): string {
  const one = sizeFor(cssPixels, { sizes });
  const two = sizeFor(cssPixels, { sizes, density: 2 });
  return one === two ? `${url(one)} 1x` : `${url(one)} 1x, ${url(two)} 2x`;
}

// ================================================================== colours

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new AvatarError(`"${hex.slice(0, 12)}" is not a #rrggbb colour`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, from 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Twelve backgrounds, each readable with white text at WCAG AA. */
export const PALETTE: readonly string[] = ['#b3261e', '#a1306b', '#7b3fa0', '#5a4bb0', '#3a5bb5', '#1f6a9a', '#0f6b73', '#1f7a4d', '#587a1c', '#8a6a00', '#a35200', '#7a4a3a'];

function textOn(bg: string): '#ffffff' | '#000000' {
  return contrast(bg, '#ffffff') >= contrast(bg, '#000000') ? '#ffffff' : '#000000';
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();

// ================================================================== identicons

export interface IdenticonOptions {
  readonly size?: number;
  readonly shape?: 'square' | 'circle';
  /** Background as #rrggbb; default a light neutral. */
  readonly background?: string;
  /** Text for screen readers; default "Avatar". */
  readonly label?: string;
}

function checkSize(size: number) {
  if (!Number.isInteger(size) || size < 8 || size > 2048) throw new AvatarError('a size is a whole number of pixels from 8 to 2048');
}

/** The 5 by 5 pattern for a seed, as rows of booleans, mirrored left to right, never empty. */
export function identiconCells(seed: string): boolean[][] {
  const b = sha(seed);
  const rows: boolean[][] = [];
  let bit = 0;
  for (let r = 0; r < 5; r++) {
    const half: boolean[] = [];
    for (let c = 0; c < 3; c++, bit++) half.push(((b[2 + (bit >> 3)]! >> (bit & 7)) & 1) === 1);
    rows.push([half[0]!, half[1]!, half[2]!, half[1]!, half[0]!]);
  }
  if (!rows.some((r) => r.some(Boolean))) rows[2]![2] = true;
  return rows;
}

/** The colour drawn for a seed. */
export function identiconColor(seed: string): string {
  const b = sha(seed);
  const hue = ((b[0]! << 8) | b[1]!) % 360;
  return hslToHex(hue, 0.62, 0.42);
}

function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** An SVG identicon: the same seed always gives the same picture. */
export function identicon(seed: string, o: IdenticonOptions = {}): string {
  const size = o.size ?? 64;
  checkSize(size);
  const bg = o.background ?? '#f0f0f0';
  hexToRgb(bg);
  const fg = identiconColor(seed);
  const cells = identiconCells(seed);
  const id = `av-${sha(seed).toString('hex').slice(0, 8)}`;
  const rects: string[] = [];
  cells.forEach((row, r) => row.forEach((on, c) => on && rects.push(`<rect x="${10 + c * 10}" y="${10 + r * 10}" width="10" height="10"/>`)));
  const clip = o.shape === 'circle' ? ` clip-path="url(#${id})"` : '';
  const defs = o.shape === 'circle' ? `<defs><clipPath id="${id}"><circle cx="35" cy="35" r="35"/></clipPath></defs>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 70 70" width="${size}" height="${size}" role="img" aria-label="${escapeXml(o.label ?? 'Avatar')}">${defs}<g${clip}><rect width="70" height="70" fill="${bg}"/><g fill="${fg}">${rects.join('')}</g></g></svg>`;
}

// ================================================================== initials

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'sir', 'dame', 'rev', 'jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md']);
const PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'du', 'la', 'le', 'bin', 'ibn', 'al', 'el', 'st', 'ter', 'ten', 'af']);
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const graphemes = (s: string): string[] => [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(s)].map((x) => x.segment);
const isLetter = (g: string) => /^[\p{L}\p{N}]/u.test(g);

/** The one or two letters a name stands for, in capitals. Returns "?" when the name holds no letters. */
export function initials(name: string): string {
  let n = name.normalize('NFC').trim();
  if (n.length > 200) n = n.slice(0, 200);
  const at = n.indexOf('@');
  if (at > 0 && !/\s/.test(n)) n = n.slice(0, at);
  const raw = n.split(/[\s._\-+,]+/u).map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
  let toks = raw.filter((t) => !TITLES.has(t.toLowerCase().replace(/\.$/, '')));
  if (!toks.length) toks = raw;
  const words = toks.filter((t) => !(PARTICLES.has(t) && t === t.toLowerCase()));
  const use = words.length ? words : toks;
  if (!use.length) return '?';
  const first = graphemes(use[0]!).filter(isLetter);
  if (use.length === 1) {
    if (!first.length) return '?';
    return CJK.test(first[0]!) ? first.slice(0, 2).join('') : first.slice(0, 2).join('').toUpperCase();
  }
  const last = graphemes(use[use.length - 1]!).filter(isLetter);
  if (!first.length || !last.length) return '?';
  const pair = [first[0]!, last[0]!];
  return pair.map((g) => (CJK.test(g) ? g : g.toUpperCase())).join('');
}

export interface InitialsOptions {
  readonly size?: number;
  readonly shape?: 'square' | 'circle';
  /** Pins the background to #rrggbb instead of choosing from the palette by name. */
  readonly background?: string;
  readonly label?: string;
}

/** The background a name is given, the same each time. */
export function colorForName(name: string): string {
  return PALETTE[sha(name.normalize('NFC').trim().toLowerCase()).readUInt16BE(0) % PALETTE.length]!;
}

/** An SVG of the name's initials on a colour with readable text. */
export function initialsAvatar(name: string, o: InitialsOptions = {}): string {
  const size = o.size ?? 64;
  checkSize(size);
  const bg = o.background ?? colorForName(name);
  hexToRgb(bg);
  const text = initials(name);
  const fg = textOn(bg);
  const count = graphemes(text).length;
  const fs = count === 1 ? 48 : 38;
  const radius = o.shape === 'circle' ? ' rx="50"' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="${escapeXml(o.label ?? (name.trim().slice(0, 80) || 'Avatar'))}"><rect width="100" height="100"${radius} fill="${bg}"/><text x="50" y="50" text-anchor="middle" dominant-baseline="central" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="${fs}" font-weight="600" fill="${fg}">${escapeXml(text)}</text></svg>`;
}

/** The plain silhouette used for people with no picture and no name. */
export function silhouette(size = 64): string {
  checkSize(size);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="Avatar"><rect width="100" height="100" fill="#d9d9d9"/><circle cx="50" cy="38" r="18" fill="#8c8c8c"/><path d="M14 100c0-22 16-36 36-36s36 14 36 36z" fill="#8c8c8c"/></svg>`;
}

// ================================================================== directory and server

export interface Person {
  readonly id: string;
  readonly name?: string;
  /** The picture the person chose, as a ready address, if any. */
  readonly picture?: string;
  /** Prefer initials to an identicon when there is no picture. */
  readonly style?: 'identicon' | 'initials';
}

export class Directory {
  private readonly byHash = new Map<string, Person>();
  private readonly hashesOf = new Map<string, Set<string>>();

  /** Registers the emails of a person under both hashes. Another person's email cannot be taken over. */
  add(person: Person, emails: readonly string[]): void {
    for (const e of emails) {
      for (const a of ['md5', 'sha256'] as const) {
        const h = emailHash(e, a);
        const have = this.byHash.get(h);
        if (have && have.id !== person.id) throw new AvatarError('that email belongs to another person');
      }
    }
    for (const e of emails) {
      for (const a of ['md5', 'sha256'] as const) {
        const h = emailHash(e, a);
        this.byHash.set(h, person);
        this.hashesOf.set(person.id, (this.hashesOf.get(person.id) ?? new Set()).add(h));
      }
    }
  }

  remove(personId: string): void {
    for (const h of this.hashesOf.get(personId) ?? []) this.byHash.delete(h);
    this.hashesOf.delete(personId);
  }

  /** The person a hash belongs to. */
  lookup(hash: string): Person | undefined {
    return isAvatarHash(hash) ? this.byHash.get(hash) : undefined;
  }
}

export type AvatarResponse =
  | { status: 200; contentType: 'image/svg+xml'; body: string; cacheSeconds: number }
  | { status: 302; location: string }
  | { status: 400 | 404; message: string };

/**
 * Answers an avatar request the way Gravatar does. `hash` is the path part; `query` has s (size), d (default), r
 * (rating, ignored here), f=y (ignore the person's picture). A person's chosen picture is a redirect; otherwise
 * the default asked for is made here. d=404 gives a 404; an unknown hash with d=initials uses "?".
 */
export function serveAvatar(dir: Directory, hash: string, query: Readonly<Record<string, string>> = {}): AvatarResponse {
  const h = hash.toLowerCase().replace(/\.(?:svg|png|jpg|jpeg)$/, '');
  if (!isAvatarHash(h)) return { status: 400, message: 'not a hash' };
  let size = 80;
  if (query.s !== undefined) {
    const n = Number(query.s);
    if (!Number.isInteger(n) || n < 1 || n > 2048) return { status: 400, message: 'size must be 1 to 2048' };
    size = n;
  }
  const d = query.d ?? 'identicon';
  const person = query.f === 'y' ? undefined : dir.lookup(h);
  if (person?.picture !== undefined) return { status: 302, location: person.picture };
  const ok = (body: string): AvatarResponse => ({ status: 200, contentType: 'image/svg+xml', body, cacheSeconds: 3600 });
  const px = Math.max(8, size);
  if (d === '404') return { status: 404, message: 'no avatar' };
  if (d === 'blank') return ok(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" width="${size}" height="${size}" role="img" aria-label="Avatar"/>`);
  if (d === 'mp') return ok(silhouette(px));
  if (d === 'initials' || (person?.style === 'initials' && person.name)) return ok(initialsAvatar(person?.name ?? '?', { size: px, shape: 'circle', ...(person?.name === undefined ? { background: '#8c8c8c' } : {}) }));
  if (['identicon', 'monsterid', 'wavatar', 'retro', 'robohash'].includes(d)) return ok(identicon(h, { size: px, ...(person?.name ? { label: person.name } : {}) }));
  try {
    if (new URL(d).protocol === 'https:') return { status: 302, location: d };
  } catch {
    // falls through
  }
  return { status: 400, message: 'unknown default' };
}
