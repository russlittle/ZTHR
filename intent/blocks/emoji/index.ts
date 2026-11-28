/**
 * Emoji for chat and content: shortcodes to characters and back (`:thumbsup:`, `:+1:`, `:wave::skin-tone-4:`),
 * skin tones done by the Unicode rules (a modifier goes after each person or hand in the sequence, replaces a
 * variation selector, and is never put on a face, an object or a family), detection of what in a text is an emoji
 * (flags, keycaps, joined sequences and all, by grapheme), a registry of custom emoji (names, https images, aliases,
 * and no shadowing of the built-in names), text rendering that escapes HTML and leaves code alone, and reaction sets:
 * who reacted with what on a message, with limits on how many different reactions a message may hold and how many
 * one person may add, toggling, ordering by first use, a viewer's own marks, and a person's most used emoji.
 *
 * The built-in table holds the shortcodes people use most (about 150, named as GitHub's gemoji and Slack name
 * them); it is data and can be extended with `Shortcodes.add`. The rest of Unicode is still recognised and
 * carried through; it just has no short name until one is added.
 *
 * Out of scope: the images behind custom emoji (their addresses are kept), search by keyword, and the full CLDR annotation set.
 */

export class EmojiError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// ================================================================== detecting emoji

const seg = new Intl.Segmenter('und', { granularity: 'grapheme' });
export const graphemesOf = (s: string): string[] => [...seg.segment(s)].map((x) => x.segment);

/** Whether a single grapheme is an emoji (not a plain digit, a copyright sign without selector, or a letter). */
export function isEmoji(g: string): boolean {
  if (!g || [...g].length > 40) return false;
  if (/^\p{Regional_Indicator}{2}$/u.test(g)) return true;
  if (/^[0-9#*]️?⃣$/u.test(g)) return true;
  return /^(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️)/u.test(g);
}

/** Every emoji in a text, in order, with repeats. */
export function extractEmoji(text: string): string[] {
  return graphemesOf(text).filter(isEmoji);
}

// ================================================================== skin tones

/** Tones are numbered as Slack does: 2 (light, U+1F3FB) up to 6 (dark, U+1F3FF). */
export type Tone = 2 | 3 | 4 | 5 | 6;
const TONE_BASE = 0x1f3fb;
const toneOfCode = (cp: number): Tone | undefined => (cp >= TONE_BASE && cp <= TONE_BASE + 4 ? ((cp - TONE_BASE + 2) as Tone) : undefined);

/** Unicode Emoji_Modifier_Base, as ranges. */
const BASES: readonly (readonly [number, number])[] = [
  [0x261d, 0x261d], [0x26f9, 0x26f9], [0x270a, 0x270d], [0x1f385, 0x1f385], [0x1f3c2, 0x1f3c4], [0x1f3c7, 0x1f3c7], [0x1f3ca, 0x1f3cc],
  [0x1f442, 0x1f443], [0x1f446, 0x1f450], [0x1f466, 0x1f478], [0x1f47c, 0x1f47c], [0x1f481, 0x1f483], [0x1f485, 0x1f487], [0x1f48f, 0x1f48f],
  [0x1f491, 0x1f491], [0x1f4aa, 0x1f4aa], [0x1f574, 0x1f575], [0x1f57a, 0x1f57a], [0x1f590, 0x1f590], [0x1f595, 0x1f596], [0x1f645, 0x1f647],
  [0x1f64b, 0x1f64f], [0x1f6a3, 0x1f6a3], [0x1f6b4, 0x1f6b6], [0x1f6c0, 0x1f6c0], [0x1f6cc, 0x1f6cc], [0x1f90c, 0x1f90c], [0x1f90f, 0x1f90f],
  [0x1f918, 0x1f91f], [0x1f926, 0x1f926], [0x1f930, 0x1f939], [0x1f93c, 0x1f93e], [0x1f977, 0x1f977], [0x1f9b5, 0x1f9b6], [0x1f9b8, 0x1f9b9],
  [0x1f9bb, 0x1f9bb], [0x1f9cd, 0x1f9cf], [0x1f9d1, 0x1f9dd], [0x1fac3, 0x1fac5], [0x1faf0, 0x1faf8],
];

export const isModifierBase = (cp: number) => BASES.some(([a, b]) => cp >= a && cp <= b);
const isChild = (cp: number) => cp === 0x1f466 || cp === 0x1f467 || cp === 0x1f9d2;

/** The tone in an emoji, if it has one. */
export function toneOf(emoji: string): Tone | undefined {
  for (const c of emoji) {
    const t = toneOfCode(c.codePointAt(0)!);
    if (t !== undefined) return t;
  }
  return undefined;
}

export function stripTone(emoji: string): string {
  return [...emoji].filter((c) => toneOfCode(c.codePointAt(0)!) === undefined).join('');
}

/** Whether this emoji can take a skin tone: it has a person or hand in it, and is not a family. */
export function canTone(emoji: string): boolean {
  const cps = [...stripTone(emoji)].map((c) => c.codePointAt(0)!);
  const joined = cps.includes(0x200d);
  const bases = cps.filter((c) => takesTone(c, joined));
  if (!bases.length) return false;
  return !(joined && cps.some(isChild) && bases.length >= 2);
}

/** Inside a joined sequence only the people take the tone: the handshake in "people holding hands" does not. */
const takesTone = (cp: number, joined: boolean) => isModifierBase(cp) && !(joined && cp === 0x1f91d);

/** Puts a tone on every person or hand in the emoji (replacing any it had); an emoji that cannot take one is returned as it is. */
export function withTone(emoji: string, tone: Tone | undefined): string {
  const plain = stripTone(emoji);
  if (tone === undefined || !canTone(plain)) return tone === undefined ? plain : emoji;
  if (tone < 2 || tone > 6) throw new EmojiError('a skin tone is 2 to 6');
  const out: string[] = [];
  const cps = [...plain];
  const joined = cps.includes('\u200d');
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i]!;
    out.push(c);
    if (takesTone(c.codePointAt(0)!, joined)) {
      out.push(String.fromCodePoint(TONE_BASE + tone - 2));
      if (cps[i + 1] === '️') i++;
    }
  }
  return out.join('');
}

// ================================================================== shortcodes

const u = (...cps: number[]) => String.fromCodePoint(...cps);
const FE = '️';
const flag = (cc: string) => u(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

/** [names, emoji]; the first name is the canonical one. */
const BUILTIN: readonly (readonly [readonly string[], string])[] = [
  [['grinning'], '😀'], [['smiley'], '😃'], [['smile'], '😄'], [['grin'], '😁'], [['laughing', 'satisfied'], '😆'], [['sweat_smile'], '😅'], [['joy'], '😂'], [['rofl'], '🤣'],
  [['slightly_smiling_face', 'slight_smile'], '🙂'], [['upside_down_face'], '🙃'], [['wink'], '😉'], [['blush'], '😊'], [['innocent'], '😇'], [['heart_eyes'], '😍'],
  [['kissing_heart'], '😘'], [['yum'], '😋'], [['stuck_out_tongue'], '😛'], [['thinking', 'thinking_face'], '🤔'], [['neutral_face'], '😐'], [['expressionless'], '😑'],
  [['unamused'], '😒'], [['roll_eyes', 'rolling_eyes'], '🙄'], [['relieved'], '😌'], [['pensive'], '😔'], [['sleeping'], '😴'], [['sunglasses'], '😎'], [['nerd_face'], '🤓'],
  [['confused'], '😕'], [['worried'], '😟'], [['open_mouth'], '😮'], [['hushed'], '😯'], [['astonished'], '😲'], [['flushed'], '😳'], [['pleading_face'], '🥺'],
  [['cry'], '😢'], [['sob'], '😭'], [['scream'], '😱'], [['angry'], '😠'], [['rage'], '😡'], [['partying_face'], '🥳'], [['face_with_monocle'], '🧐'], [['mask'], '😷'],
  [['skull'], '💀'], [['ghost'], '👻'], [['poop', 'hankey'], '💩'], [['see_no_evil'], '🙈'], [['hear_no_evil'], '🙉'], [['speak_no_evil'], '🙊'],
  [['+1', 'thumbsup', 'thumbs_up'], '👍'], [['-1', 'thumbsdown', 'thumbs_down'], '👎'], [['clap'], '👏'], [['wave'], '👋'], [['raised_hands'], '🙌'], [['pray'], '🙏'],
  [['ok_hand'], '👌'], [['muscle'], '💪'], [['point_up'], u(0x261d, 0xfe0f)], [['point_up_2'], '👆'], [['point_down'], '👇'], [['point_left'], '👈'], [['point_right'], '👉'],
  [['v'], u(0x270c, 0xfe0f)], [['fist', 'fist_raised'], '✊'], [['punch', 'facepunch'], '👊'], [['raised_hand', 'hand'], '✋'], [['handshake'], '🤝'], [['crossed_fingers', 'fingers_crossed'], '🤞'],
  [['metal'], '🤘'], [['call_me_hand'], '🤙'], [['writing_hand'], u(0x270d, 0xfe0f)], [['heart_hands'], '🫶'], [['saluting_face'], '🫡'], [['eyes'], '👀'],
  [['shrug', 'person_shrugging'], '🤷'], [['facepalm', 'face_palm', 'person_facepalming'], '🤦'], [['raising_hand', 'person_raising_hand'], '🙋'], [['bow', 'person_bowing'], '🙇'],
  [['technologist'], u(0x1f9d1, 0x200d, 0x1f4bb)], [['man_technologist'], u(0x1f468, 0x200d, 0x1f4bb)], [['woman_technologist'], u(0x1f469, 0x200d, 0x1f4bb)], [['family_man_woman_girl'], u(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)],
  [['heart', 'red_heart'], u(0x2764, 0xfe0f)], [['orange_heart'], '🧡'], [['yellow_heart'], '💛'], [['green_heart'], '💚'], [['blue_heart'], '💙'], [['purple_heart'], '💜'], [['black_heart'], '🖤'],
  [['broken_heart'], '💔'], [['sparkling_heart'], '💖'], [['two_hearts'], '💕'], [['100'], '💯'],
  [['fire'], '🔥'], [['star'], '⭐'], [['star2'], '🌟'], [['sparkles'], '✨'], [['zap'], '⚡'], [['boom', 'collision'], '💥'], [['tada'], '🎉'], [['confetti_ball'], '🎊'], [['balloon'], '🎈'],
  [['gift'], '🎁'], [['trophy'], '🏆'], [['medal'], '🏅'], [['white_check_mark'], '✅'], [['heavy_check_mark'], u(0x2714, 0xfe0f)], [['x'], '❌'], [['no_entry'], '⛔'], [['warning'], u(0x26a0, 0xfe0f)],
  [['question'], '❓'], [['exclamation', 'heavy_exclamation_mark'], '❗'], [['bulb'], '💡'], [['rocket'], '🚀'], [['bug'], '🐛'], [['lock'], '🔒'], [['unlock'], '🔓'], [['key'], '🔑'],
  [['mag'], '🔍'], [['memo', 'pencil'], '📝'], [['bell'], '🔔'], [['calendar'], '📆'], [['hourglass'], '⌛'], [['alarm_clock'], '⏰'], [['link'], '🔗'], [['paperclip'], '📎'],
  [['pushpin'], '📌'], [['books'], '📚'], [['book'], '📖'], [['computer'], '💻'], [['phone', 'iphone'], '📱'], [['email', 'e-mail'], '📧'], [['package'], '📦'], [['hammer'], '🔨'], [['wrench'], '🔧'],
  [['gear'], u(0x2699, 0xfe0f)], [['shield'], u(0x1f6e1, 0xfe0f)], [['chart_with_upwards_trend'], '📈'], [['chart_with_downwards_trend'], '📉'], [['bar_chart'], '📊'], [['moneybag'], '💰'],
  [['coffee'], '☕'], [['pizza'], '🍕'], [['beer'], '🍺'], [['beers'], '🍻'], [['wine_glass'], '🍷'], [['cake'], '🍰'], [['apple'], '🍎'], [['banana'], '🍌'], [['taco'], '🌮'], [['hamburger'], '🍔'],
  [['dog', 'dog_face'], '🐶'], [['cat', 'cat_face'], '🐱'], [['unicorn'], '🦄'], [['bee', 'honeybee'], '🐝'], [['turtle'], '🐢'], [['penguin'], '🐧'], [['octopus'], '🐙'],
  [['sunny'], u(0x2600, 0xfe0f)], [['cloud'], u(0x2601, 0xfe0f)], [['snowflake'], u(0x2744, 0xfe0f)], [['rainbow'], '🌈'], [['umbrella'], '☔'], [['earth_africa'], '🌍'], [['seedling'], '🌱'],
  [['evergreen_tree'], '🌲'], [['eight_ball'], '🎱'], [['soccer'], '⚽'], [['musical_note'], '🎵'], [['microphone'], '🎤'], [['movie_camera'], '🎥'], [['art'], '🎨'],
  [['car', 'red_car'], '🚗'], [['airplane'], u(0x2708, 0xfe0f)], [['house'], '🏠'], [['office'], '🏢'], [['construction'], '🚧'], [['checkered_flag'], '🏁'], [['triangular_flag_on_post'], '🚩'],
  [['arrow_up'], u(0x2b06, 0xfe0f)], [['arrow_down'], u(0x2b07, 0xfe0f)], [['arrow_right'], u(0x27a1, 0xfe0f)], [['arrow_left'], u(0x2b05, 0xfe0f)], [['recycle'], u(0x267b, 0xfe0f)], [['infinity'], u(0x267e, 0xfe0f)],
  [['keycap_1'], u(0x31, 0xfe0f, 0x20e3)], [['keycap_2'], u(0x32, 0xfe0f, 0x20e3)], [['keycap_3'], u(0x33, 0xfe0f, 0x20e3)], [['keycap_ten'], '🔟'],
  [['flag_us'], flag('US')], [['flag_gb'], flag('GB')], [['flag_fr'], flag('FR')], [['flag_de'], flag('DE')], [['flag_jp'], flag('JP')], [['flag_ca'], flag('CA')],
  [['flag_br'], flag('BR')], [['flag_in'], flag('IN')], [['flag_es'], flag('ES')], [['flag_it'], flag('IT')], [['flag_mx'], flag('MX')], [['flag_au'], flag('AU')],
];

const NAME = /^(?:[a-z0-9_+-]{1,64})$/;
const RESERVED = /^skin-tone-[2-6]$/;
const key = (e: string) => e.replace(/️/g, '');

export class Shortcodes {
  private readonly toEmoji = new Map<string, string>();
  private readonly toName = new Map<string, string>();

  constructor(extra: readonly (readonly [readonly string[], string])[] = []) {
    for (const [names, e] of [...BUILTIN, ...extra]) this.add(names, e);
  }

  /** Adds names for an emoji; a name already used for another emoji is refused. */
  add(names: readonly string[], emoji: string): void {
    const g = graphemesOf(emoji);
    if (g.length !== 1 || !isEmoji(g[0]!)) throw new EmojiError('a shortcode names exactly one emoji');
    for (const n of names) {
      if (!NAME.test(n) || RESERVED.test(n)) throw new EmojiError(`"${n.slice(0, 30)}" is not a usable shortcode`);
      const have = this.toEmoji.get(n);
      if (have !== undefined && key(have) !== key(emoji)) throw new EmojiError(`:${n}: already means ${have}`);
    }
    for (const n of names) this.toEmoji.set(n, emoji);
    if (!this.toName.has(key(emoji))) this.toName.set(key(emoji), names[0]!);
  }

  has(name: string): boolean {
    return this.toEmoji.has(name);
  }

  get size(): number {
    return this.toEmoji.size;
  }

  names(): string[] {
    return [...this.toEmoji.keys()].sort();
  }

  /** The emoji a name stands for. */
  emoji(name: string): string | undefined {
    return this.toEmoji.get(name.replace(/^:|:$/g, ''));
  }

  /** The canonical name for an emoji; its tone is ignored, so 👍🏽 is "+1" too. */
  nameOf(emoji: string): string | undefined {
    return this.toName.get(key(stripTone(emoji)));
  }

  /** The shortcode text for an emoji, with a skin-tone suffix when it has one: `:+1::skin-tone-4:`. */
  shortcodeFor(emoji: string): string | undefined {
    const n = this.nameOf(emoji);
    if (n === undefined) return undefined;
    const t = toneOf(emoji);
    return `:${n}:${t === undefined ? '' : `:skin-tone-${t}:`}`;
  }

  /**
   * Replaces shortcodes in a text with emoji. `:wave::skin-tone-4:` gives a toned wave; a tone on something that
   * cannot take one is dropped; an unknown name is left as typed. Fenced and inline code is left alone.
   */
  replace(text: string, o: { defaultTone?: Tone } = {}): string {
    return mapOutsideCode(text, (chunk) =>
      chunk.replace(/:([a-z0-9_+-]{1,64}):(?::skin-tone-([2-6]):)?/g, (m, name: string, tone: string | undefined) => {
        const e = this.toEmoji.get(name);
        if (e === undefined) return m;
        if (tone !== undefined) return withTone(e, Number(tone) as Tone);
        return o.defaultTone !== undefined ? withTone(e, o.defaultTone) : e;
      }),
    );
  }

  /** The reverse: emoji in a text become shortcodes where a name is known. */
  toShortcodes(text: string): string {
    return graphemesOf(text).map((g) => (isEmoji(g) ? (this.shortcodeFor(g) ?? g) : g)).join('');
  }
}

/** Applies a function to the parts of a text that are not code. */
function mapOutsideCode(text: string, f: (chunk: string) => string): string {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts.map((p, i) => (i % 2 === 1 ? p : f(p))).join('');
}

// ================================================================== custom emoji

export interface CustomEmoji {
  readonly name: string;
  readonly url: string;
  readonly animated: boolean;
  readonly aliases: readonly string[];
  readonly category?: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly disabled: boolean;
}

export class CustomRegistry {
  private readonly byName = new Map<string, CustomEmoji>();
  private readonly builtin: Shortcodes;
  private readonly now: () => number;

  constructor(builtin: Shortcodes, now: () => number = () => Date.now()) {
    this.builtin = builtin;
    this.now = now;
  }

  /** Adds an emoji. The name is 2 to 32 lower-case letters, digits and underscores, and cannot be a built-in name. */
  add(e: { name: string; url: string; animated?: boolean; aliases?: readonly string[]; category?: string; createdBy: string }): CustomEmoji {
    const names = [e.name, ...(e.aliases ?? [])];
    for (const n of names) {
      if (!/^[a-z0-9_]{2,32}$/.test(n)) throw new EmojiError(`"${n.slice(0, 40)}" is not a usable name: 2 to 32 lower-case letters, digits or underscores`);
      if (this.builtin.has(n)) throw new EmojiError(`:${n}: is a built-in emoji name`);
      if (this.find(n)) throw new EmojiError(`:${n}: is already taken`);
    }
    if (new Set(names).size !== names.length) throw new EmojiError('a name is listed twice');
    let ok = false;
    try {
      const url = new URL(e.url);
      ok = url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      ok = false;
    }
    if (!ok) throw new EmojiError('the image address must be an https address');
    const c: CustomEmoji = { name: e.name, url: e.url, animated: e.animated === true, aliases: [...(e.aliases ?? [])], createdBy: e.createdBy, createdAt: this.now(), disabled: false, ...(e.category !== undefined ? { category: e.category } : {}) };
    this.byName.set(e.name, c);
    return c;
  }

  /** Finds by name or alias. */
  find(name: string): CustomEmoji | undefined {
    const n = name.replace(/^:|:$/g, '');
    const direct = this.byName.get(n);
    if (direct) return direct;
    for (const c of this.byName.values()) if (c.aliases.includes(n)) return c;
    return undefined;
  }

  setDisabled(name: string, disabled: boolean): void {
    const c = this.byName.get(name);
    if (!c) throw new EmojiError(`no custom emoji :${name}:`);
    this.byName.set(name, { ...c, disabled });
  }

  remove(name: string): void {
    if (!this.byName.delete(name)) throw new EmojiError(`no custom emoji :${name}:`);
  }

  list(o: { includeDisabled?: boolean; category?: string } = {}): CustomEmoji[] {
    return [...this.byName.values()].filter((c) => (o.includeDisabled || !c.disabled) && (o.category === undefined || c.category === o.category)).sort((a, b) => a.name.localeCompare(b.name));
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'));

/**
 * Turns text into safe HTML with emoji in place: built-in shortcodes become characters, custom ones become
 * `<img class="emoji">` with the name as alt text. Everything else is escaped; code spans and fences are kept as
 * escaped literal text.
 */
export function renderHtml(text: string, codes: Shortcodes, custom?: CustomRegistry, o: { defaultTone?: Tone } = {}): string {
  return mapOutsideCodeKeep(text, (chunk) => {
    let out = '';
    let at = 0;
    for (const m of chunk.matchAll(/:([a-z0-9_+-]{1,64}):(?::skin-tone-([2-6]):)?/g)) {
      out += escapeHtml(chunk.slice(at, m.index));
      at = m.index + m[0].length;
      const name = m[1]!;
      const built = codes.emoji(name);
      const c = built === undefined ? custom?.find(name) : undefined;
      if (built !== undefined) {
        const tone = m[2] !== undefined ? (Number(m[2]) as Tone) : o.defaultTone;
        out += escapeHtml(tone === undefined ? built : withTone(built, tone));
      } else if (c && !c.disabled) out += `<img class="emoji" src="${escapeHtml(c.url)}" alt=":${escapeHtml(c.name)}:" title=":${escapeHtml(c.name)}:" draggable="false">`;
      else out += escapeHtml(m[0]);
    }
    return out + escapeHtml(chunk.slice(at));
  });
}

function mapOutsideCodeKeep(text: string, f: (chunk: string) => string): string {
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((p, i) => (i % 2 === 1 ? `<code>${escapeHtml(p.replace(/^`+|`+$/g, ''))}</code>` : f(p))).join('');
}

// ================================================================== reactions

export class ReactionError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export interface ReactionOptions {
  readonly codes: Shortcodes;
  readonly custom?: CustomRegistry;
  /** Most different reactions on one message. Default 20. */
  readonly maxDistinct?: number;
  /** Most reactions one person may put on one message. Default 10. */
  readonly maxPerUser?: number;
  /** Treat 👍 and 👍🏽 as the same reaction. Default false. */
  readonly foldTones?: boolean;
  /** Only these may be used: unicode emoji or `:name:` of custom emoji. Default anything. */
  readonly allowed?: readonly string[];
  readonly now?: () => number;
}

export interface ReactionSummary {
  readonly emoji: string;
  readonly count: number;
  /** Whether the viewer has reacted with it. */
  readonly me: boolean;
  /** The first people to react, in order. */
  readonly users: readonly string[];
  readonly custom: boolean;
}

interface Entry {
  readonly shown: string;
  readonly custom: boolean;
  readonly users: { id: string; at: number }[];
  readonly first: number;
}

export class Reactions {
  private readonly o: ReactionOptions;
  private readonly byMessage = new Map<string, Map<string, Entry>>();
  private readonly usage = new Map<string, Map<string, number>>();
  private readonly allowed: Set<string> | undefined;
  private clock = 0;

  constructor(o: ReactionOptions) {
    this.o = o;
    this.allowed = o.allowed ? new Set(o.allowed.map((a) => this.normalize(a).key)) : undefined;
  }

  private now() {
    return this.o.now ? this.o.now() : ++this.clock;
  }

  /** What a reaction really is: a unicode emoji (from the character or a built-in shortcode) or a registered custom one. */
  normalize(input: string): { key: string; shown: string; custom: boolean } {
    const s = input.trim();
    const m = /^:([a-z0-9_+-]{1,64}):$/.exec(s);
    if (m) {
      const built = this.o.codes.emoji(m[1]!);
      if (built !== undefined) return this.fromUnicode(built);
      const c = this.o.custom?.find(m[1]!);
      if (c && !c.disabled) return { key: `:${c.name}:`, shown: `:${c.name}:`, custom: true };
      throw new ReactionError(`there is no emoji ${s}`);
    }
    const g = graphemesOf(s);
    if (g.length !== 1 || !isEmoji(g[0]!)) throw new ReactionError('a reaction is one emoji');
    return this.fromUnicode(g[0]!);
  }

  private fromUnicode(e: string) {
    const folded = this.o.foldTones ? stripTone(e) : e;
    return { key: key(folded), shown: folded, custom: false };
  }

  private entries(messageId: string): Map<string, Entry> {
    let m = this.byMessage.get(messageId);
    if (!m) {
      m = new Map();
      this.byMessage.set(messageId, m);
    }
    return m;
  }

  /** Adds a reaction; false if the person already had it. */
  react(messageId: string, userId: string, emoji: string): boolean {
    const n = this.normalize(emoji);
    if (this.allowed && !this.allowed.has(n.key)) throw new ReactionError('that reaction is not on the list for this place');
    const es = this.entries(messageId);
    const e = es.get(n.key);
    if (e?.users.some((u) => u.id === userId)) return false;
    let mine = 0;
    for (const x of es.values()) if (x.users.some((u) => u.id === userId)) mine++;
    if (mine >= (this.o.maxPerUser ?? 10)) throw new ReactionError(`one person can add at most ${this.o.maxPerUser ?? 10} reactions to a message`);
    if (!e && es.size >= (this.o.maxDistinct ?? 20)) throw new ReactionError(`a message can hold at most ${this.o.maxDistinct ?? 20} different reactions`);
    const t = this.now();
    if (e) e.users.push({ id: userId, at: t });
    else es.set(n.key, { shown: n.shown, custom: n.custom, users: [{ id: userId, at: t }], first: t });
    const u = this.usage.get(userId) ?? new Map<string, number>();
    u.set(n.key, (u.get(n.key) ?? 0) + 1);
    this.usage.set(userId, u);
    return true;
  }

  /** Removes a person's reaction; false if they had none. A reaction nobody holds disappears. */
  unreact(messageId: string, userId: string, emoji: string): boolean {
    const n = this.normalize(emoji);
    const es = this.byMessage.get(messageId);
    const e = es?.get(n.key);
    if (!es || !e) return false;
    const i = e.users.findIndex((u) => u.id === userId);
    if (i < 0) return false;
    e.users.splice(i, 1);
    if (!e.users.length) es.delete(n.key);
    if (!es.size) this.byMessage.delete(messageId);
    return true;
  }

  /** Adds the reaction, or removes it if the person already had it. Returns whether they now have it. */
  toggle(messageId: string, userId: string, emoji: string): boolean {
    return this.react(messageId, userId, emoji) ? true : (this.unreact(messageId, userId, emoji), false);
  }

  /** The reactions on a message, oldest first, with the viewer's own marked. */
  summary(messageId: string, viewerId?: string, o: { maxUsers?: number } = {}): ReactionSummary[] {
    const es = this.byMessage.get(messageId);
    if (!es) return [];
    return [...es.values()]
      .sort((a, b) => a.first - b.first)
      .map((e) => ({ emoji: e.shown, count: e.users.length, me: viewerId !== undefined && e.users.some((u) => u.id === viewerId), users: e.users.slice(0, o.maxUsers ?? 5).map((u) => u.id), custom: e.custom }));
  }

  /** Drops everything on a message, as when it is deleted. */
  clear(messageId: string): void {
    this.byMessage.delete(messageId);
  }

  /** Drops a person's reactions everywhere, as when an account is deleted. */
  forget(userId: string): number {
    let n = 0;
    for (const [mid, es] of [...this.byMessage]) {
      for (const [k, e] of [...es]) {
        const before = e.users.length;
        e.users.splice(0, e.users.length, ...e.users.filter((u) => u.id !== userId));
        n += before - e.users.length;
        if (!e.users.length) es.delete(k);
      }
      if (!es.size) this.byMessage.delete(mid);
    }
    this.usage.delete(userId);
    return n;
  }

  /** The emoji a person uses most, most used first, ties by name. */
  frequent(userId: string, n = 8): string[] {
    return [...(this.usage.get(userId) ?? [])].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k]) => k);
  }
}
