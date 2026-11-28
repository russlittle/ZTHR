/**
 * Slugs: the readable, URL-safe names for pages, posts, categories and people that must not change or collide.
 * Four jobs, each small and tested:
 *
 * 1. Transliteration: accents folded away (Unicode NFKD), the letters that do not decompose mapped by table (ß, æ, ø,
 *    þ, ł and kin), German umlauts as ae/oe/ue on request, Cyrillic and Greek romanised (ISO 9 and ELOT 743 style,
 *    simplified), symbols such as & and @ given words, emoji and other marks dropped. Scripts without a table here
 *    (Chinese, Japanese, Thai, Arabic and so on) are dropped, or kept as they are when `allowUnicode` is on.
 * 2. Slugging: lower case, one separator between words, apostrophes removed (it's becomes its), no leading or
 *    trailing separator, cut to a length at a word boundary, with a fallback when nothing is left.
 * 3. Uniqueness: the slug, then slug-2, slug-3 and so on, within a scope, never a reserved word (admin, api, new,
 *    login and the rest of a list the application supplies, plus device names such as con and nul), never a bare
 *    number (it would be read as an id), and always within the length limit including the suffix; after a bounded
 *    number of tries a random suffix from the injected randomness.
 * 4. Stability: a registry that gives every record one slug, keeps it when the title changes, and when a slug is
 *    changed on purpose remembers the old one, so the old address answers with where the record is now (the
 *    redirect to send) and nobody else can take the old name until it is released. Renaming back reclaims it.
 *
 * Not here: sending the redirects (the registry says what to redirect to; the redirects block or the web layer
 * does it), and per-language romanisation beyond the tables below. Pure: no clock, randomness is an argument.
 */

export class InvalidSlug extends Error {
  constructor(slug: string, why: string) {
    super(`"${slug}" cannot be used as a slug: ${why}`);
    this.name = 'InvalidSlug';
  }
}
export class SlugTaken extends Error {
  constructor(slug: string, scope: string) {
    super(`the slug "${slug}" is already used in ${scope}`);
    this.name = 'SlugTaken';
  }
}
export class NotFound extends Error {
  constructor(id: string) {
    super(`there is no record ${id} in the slug registry`);
    this.name = 'NotFound';
  }
}

// ---------------------------------------------------------------- transliteration

const LETTERS: Readonly<Record<string, string>> = {
  'ß': 'ss', 'ẞ': 'SS', 'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE', 'ø': 'o', 'Ø': 'O', 'đ': 'd', 'Đ': 'D', 'ð': 'd', 'Ð': 'D', 'þ': 'th', 'Þ': 'TH', 'ł': 'l', 'Ł': 'L',
  'ħ': 'h', 'Ħ': 'H', 'ı': 'i', 'İ': 'I', 'ĳ': 'ij', 'Ĳ': 'IJ', 'ŋ': 'ng', 'Ŋ': 'NG', 'ŧ': 't', 'Ŧ': 'T', 'ſ': 's',
};
const SYMBOLS: Readonly<Record<string, string>> = { '&': ' and ', '@': ' at ', '%': ' percent ', '+': ' plus ', '€': ' euro ', '£': ' pound ', '$': ' dollar ', '¥': ' yen ', '©': ' ', '®': ' ', '™': ' ' };
const GERMAN: Readonly<Record<string, string>> = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue' };
const CYRILLIC: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u', ј: 'j', љ: 'lj', њ: 'nj', ћ: 'c', џ: 'dz',
};
const GREEK: Readonly<Record<string, string>> = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
};

/** Latin letters, digits and punctuation from any text the tables cover; other scripts and emoji are dropped unless kept. */
export function transliterate(text: string, o: { locale?: string; keepUnicode?: boolean } = {}): string {
  const german = (o.locale ?? '').toLowerCase().split(/[-_]/)[0] === 'de';
  let out = '';
  for (const ch of text.normalize('NFC')) {
    if (german && GERMAN[ch]) {
      out += GERMAN[ch];
      continue;
    }
    const lower = ch.toLowerCase();
    const isUpper = ch !== lower;
    const cyr = CYRILLIC[lower];
    if (cyr !== undefined) {
      out += isUpper && cyr ? cyr[0]!.toUpperCase() + cyr.slice(1) : cyr;
      continue;
    }
    const grk = GREEK[lower.normalize('NFD').replace(/\p{M}/gu, '')];
    if (grk !== undefined) {
      out += isUpper && grk ? grk[0]!.toUpperCase() + grk.slice(1) : grk;
      continue;
    }
    if (LETTERS[ch] !== undefined) {
      out += LETTERS[ch];
      continue;
    }
    if (SYMBOLS[ch] !== undefined) {
      out += SYMBOLS[ch];
      continue;
    }
    const base = ch.normalize('NFKD').replace(/\p{M}/gu, '');
    if (/^[\x00-\x7f]*$/.test(base)) out += base;
    else if (o.keepUnicode && /^[\p{L}\p{N}]+$/u.test(base)) out += base;
    else if (o.keepUnicode && /\p{M}/u.test(ch)) out += ch;
    else out += ' ';
  }
  return out;
}

// ---------------------------------------------------------------- slugging

export interface SlugOptions {
  readonly separator?: string;
  /** Longest slug in characters (code points). Default 80. */
  readonly maxLength?: number;
  readonly locale?: string;
  /** Keep letters and digits of scripts that have no table here, instead of dropping them. */
  readonly allowUnicode?: boolean;
  /** What to return when nothing is left. Default 'n-a'. */
  readonly fallback?: string;
}

/** A slug for a title. Deterministic: the same title always gives the same slug. */
export function slugify(title: string, o: SlugOptions = {}): string {
  const sep = o.separator ?? '-';
  if (!/^[a-z0-9_.~-]$/.test(sep)) throw new InvalidSlug(sep, 'the separator must be one of a-z 0-9 _ . ~ -');
  const max = o.maxLength ?? 80;
  if (!(max >= 1)) throw new InvalidSlug('', 'maxLength must be at least 1');
  const apostrophes = /['\u2019\u02bc\u2018`]/g;
  const t = transliterate((title.length > 10_000 ? title.slice(0, 10_000) : title).replace(apostrophes, ''), { ...(o.locale ? { locale: o.locale } : {}), ...(o.allowUnicode ? { keepUnicode: true } : {}) }).toLowerCase();
  const words = (o.allowUnicode ? t.match(/[\p{L}\p{N}\p{M}]+/gu) : t.match(/[a-z0-9]+/g)) ?? [];
  let slug = words.join(sep);
  if ([...slug].length > max) {
    const cut = [...slug].slice(0, max).join('');
    const at = cut.lastIndexOf(sep);
    slug = at > 0 && [...slug][max] !== undefined && [...slug][max] !== sep ? cut.slice(0, at) : cut.replace(new RegExp(`${escapeRe(sep)}+$`), '');
    if (!slug) slug = [...words.join(sep)].slice(0, max).join('');
  }
  return slug || (o.fallback ?? 'n-a');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\\-~]/g, '\\$&');

/** Whether a string is a well-formed slug: lower-case words joined by single hyphens. */
export function isValidSlug(slug: string, o: { allowUnicode?: boolean } = {}): boolean {
  return o.allowUnicode ? /^[\p{Ll}\p{Lo}\p{N}\p{M}]+(?:-[\p{Ll}\p{Lo}\p{N}\p{M}]+)*$/u.test(slug) : /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

// ---------------------------------------------------------------- reserved words

/** Names that would shadow routes or files: the application's list is added to these. */
export const ALWAYS_RESERVED: readonly string[] = ['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'lpt1', 'lpt2', 'lpt3', 'index', 'null', 'undefined', 'favicon-ico', 'robots-txt'];

export interface Reserved {
  readonly words: ReadonlySet<string>;
  /** Refuse slugs that are only digits, which would be read as an id. Default true. */
  readonly numeric: boolean;
}

export function reserved(words: readonly string[], o: { numeric?: boolean } = {}): Reserved {
  return { words: new Set([...ALWAYS_RESERVED, ...words].map((w) => w.toLowerCase())), numeric: o.numeric ?? true };
}

/** Why a slug may not be used, or null when it may. */
export function reservedReason(slug: string, r: Reserved): string | null {
  const s = slug.toLowerCase();
  if (r.words.has(s)) return `"${slug}" is a reserved word`;
  if (r.numeric && /^\d+$/.test(s)) return `"${slug}" is only digits, which would be read as an id`;
  if (s.startsWith('.') || s.startsWith('_')) return `"${slug}" starts with a dot or underscore`;
  return null;
}

// ---------------------------------------------------------------- uniqueness

export interface UniqueOptions {
  readonly reserved?: Reserved;
  readonly maxLength?: number;
  readonly separator?: string;
  /** Tries with a counter before a random suffix is used. Default 1000. */
  readonly attempts?: number;
  /** Randomness for the last resort, 0 up to 1. */
  readonly random?: () => number;
}

/**
 * The first free slug of base, base-2, base-3 ...: not taken (`taken` says so), not reserved, within the length
 * limit with the suffix counted. The base is cut, not the suffix, so slug-2 and slug-12 stay distinct.
 */
export async function uniqueSlug(base: string, taken: (slug: string) => boolean | Promise<boolean>, o: UniqueOptions = {}): Promise<string> {
  const sep = o.separator ?? '-';
  const max = o.maxLength ?? 80;
  const res = o.reserved;
  const ok = async (s: string) => !(res && reservedReason(s, res)) && !(await taken(s));
  const first = [...base].slice(0, max).join('');
  if (await ok(first)) return first;
  const attempts = o.attempts ?? 1000;
  for (let n = 2; n < 2 + attempts; n++) {
    const suffix = `${sep}${n}`;
    const cut = [...base].slice(0, Math.max(1, max - [...suffix].length)).join('').replace(new RegExp(`${escapeRe(sep)}+$`), '');
    const candidate = `${cut}${suffix}`;
    if (await ok(candidate)) return candidate;
  }
  const rnd = o.random ?? (() => { throw new Error('every numbered slug is taken and no randomness was given'); });
  for (let i = 0; i < 20; i++) {
    const suffix = `${sep}${Math.floor(rnd() * 36 ** 6).toString(36).padStart(6, '0')}`;
    const candidate = `${[...base].slice(0, Math.max(1, max - [...suffix].length)).join('')}${suffix}`;
    if (await ok(candidate)) return candidate;
  }
  throw new SlugTaken(base, 'every attempt');
}

// ---------------------------------------------------------------- the registry

export interface Record_ {
  readonly id: string;
  readonly scope: string;
  readonly slug: string;
  /** Slugs this record used before, newest last. */
  readonly history: readonly string[];
}

export type Resolution =
  | { readonly kind: 'current'; readonly id: string; readonly slug: string }
  | { readonly kind: 'redirect'; readonly id: string; readonly from: string; readonly to: string }
  | null;

export interface RegistryOptions extends UniqueOptions, SlugOptions {
  /** Most old slugs remembered per record. Default 20. */
  readonly historyLimit?: number;
}

/**
 * One slug per record, per scope (such as "post" or "category/7"). Slugs compare without regard to case. A record
 * keeps its slug when its title changes; `rename` changes it on purpose and remembers the old one.
 */
export class SlugRegistry {
  private readonly byId = new Map<string, { id: string; scope: string; slug: string; history: string[] }>();
  private readonly bySlug = new Map<string, string>();
  private readonly byOld = new Map<string, string>();
  private readonly o: RegistryOptions;

  constructor(o: RegistryOptions = {}) {
    this.o = o;
  }

  private key(scope: string, slug: string) {
    return `${scope}\u0000${slug.toLowerCase()}`;
  }

  /** Is the slug used, now or as an old name still held, in this scope? */
  isTaken(scope: string, slug: string, exceptId?: string): boolean {
    const now = this.bySlug.get(this.key(scope, slug));
    const old = this.byOld.get(this.key(scope, slug));
    return (now !== undefined && now !== exceptId) || (old !== undefined && old !== exceptId);
  }

  /** Gives a new record a slug made from its title. Throws if the record already has one. */
  async assign(id: string, scope: string, title: string): Promise<string> {
    if (this.byId.has(id)) throw new SlugTaken(this.byId.get(id)!.slug, `record ${id}`);
    const base = slugify(title, this.o);
    const slug = await uniqueSlug(base, (s) => this.isTaken(scope, s), this.o);
    this.byId.set(id, { id, scope, slug, history: [] });
    this.bySlug.set(this.key(scope, slug), id);
    return slug;
  }

  /**
   * Changes a record's slug on purpose. `wanted` is slugged first; if it is taken by another record the call fails
   * with SlugTaken rather than silently choosing another. The old slug is remembered and will redirect.
   */
  rename(id: string, wanted: string): { slug: string; redirect: { from: string; to: string } | null } {
    const r = this.byId.get(id);
    if (!r) throw new NotFound(id);
    const slug = slugify(wanted, this.o);
    if (slug === r.slug) return { slug, redirect: null };
    const why = this.o.reserved ? reservedReason(slug, this.o.reserved) : null;
    if (why) throw new InvalidSlug(slug, why);
    if (this.isTaken(r.scope, slug, id)) throw new SlugTaken(slug, r.scope);
    this.bySlug.delete(this.key(r.scope, r.slug));
    // Taking an old name back removes it from the history.
    if (this.byOld.get(this.key(r.scope, slug)) === id) {
      this.byOld.delete(this.key(r.scope, slug));
      r.history = r.history.filter((h) => h.toLowerCase() !== slug.toLowerCase());
    }
    const from = r.slug;
    r.history.push(from);
    this.byOld.set(this.key(r.scope, from), id);
    const limit = this.o.historyLimit ?? 20;
    while (r.history.length > limit) this.byOld.delete(this.key(r.scope, r.history.shift()!));
    r.slug = slug;
    this.bySlug.set(this.key(r.scope, slug), id);
    return { slug, redirect: { from, to: slug } };
  }

  /** What an incoming slug means: the record it names now, the record it used to name, or nothing. */
  resolve(scope: string, slug: string): Resolution {
    const k = this.key(scope, slug);
    const now = this.bySlug.get(k);
    if (now !== undefined) return { kind: 'current', id: now, slug: this.byId.get(now)!.slug };
    const old = this.byOld.get(k);
    if (old !== undefined) return { kind: 'redirect', id: old, from: slug, to: this.byId.get(old)!.slug };
    return null;
  }

  get(id: string): Record_ | undefined {
    const r = this.byId.get(id);
    return r ? { id: r.id, scope: r.scope, slug: r.slug, history: [...r.history] } : undefined;
  }

  /** Lets go of an old slug so another record may use it; its address stops redirecting. */
  release(scope: string, oldSlug: string): boolean {
    const k = this.key(scope, oldSlug);
    const id = this.byOld.get(k);
    if (id === undefined) return false;
    this.byOld.delete(k);
    const r = this.byId.get(id)!;
    r.history = r.history.filter((h) => h.toLowerCase() !== oldSlug.toLowerCase());
    return true;
  }

  /** Removes a record and everything it held, old names included. */
  remove(id: string): boolean {
    const r = this.byId.get(id);
    if (!r) return false;
    this.bySlug.delete(this.key(r.scope, r.slug));
    for (const h of r.history) this.byOld.delete(this.key(r.scope, h));
    this.byId.delete(id);
    return true;
  }

  /** Every record, for saving. */
  snapshot(): Record_[] {
    return [...this.byId.values()].map((r) => ({ id: r.id, scope: r.scope, slug: r.slug, history: [...r.history] }));
  }

  static restore(records: readonly Record_[], o: RegistryOptions = {}): SlugRegistry {
    const reg = new SlugRegistry(o);
    for (const r of records) {
      if (reg.byId.has(r.id) || reg.isTaken(r.scope, r.slug)) throw new SlugTaken(r.slug, r.scope);
      reg.byId.set(r.id, { id: r.id, scope: r.scope, slug: r.slug, history: [...r.history] });
      reg.bySlug.set(reg.key(r.scope, r.slug), r.id);
    }
    for (const r of records) for (const h of r.history) {
      if (reg.isTaken(r.scope, h)) throw new SlugTaken(h, r.scope);
      reg.byOld.set(reg.key(r.scope, h), r.id);
    }
    return reg;
  }
}
