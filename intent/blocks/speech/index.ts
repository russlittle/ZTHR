/**
 * Speak instead of type. The browser turns speech into a transcript; this block turns the transcript into
 * something the app can use, so that part is tested like any other code.
 *
 * A spoken command is matched against the command palette's commands, word by word, forgiving a misheard word,
 * and only among commands the person may use. A clear match runs; a near tie asks which one was meant; a command
 * that deletes, removes or otherwise cannot be undone is never run until the person says yes.
 *
 * Dictation into a field understands spoken punctuation ("comma", "full stop", "question mark", "new line", "new
 * paragraph", quotes and brackets), capitalises the start of each sentence, keeps the speaker's own casing
 * otherwise, types a punctuation word itself when it is preceded by "literal", and takes back the last thing said
 * on "scratch that". Numbers and dates spoken in words are read for the common English forms ("two hundred and
 * forty five", "three point five", "the third of March twenty twenty six", "next Friday", "in two weeks"), and
 * anything that does not read cleanly is refused with a sentence to say, never guessed.
 *
 * The browser adapter wires the Web Speech API to these when the browser has it, and does nothing when it does not.
 */
import type { Command, Palette } from '../palette/index.ts';

const clean = (s: string) => s.toLowerCase().replace(/[“”"]/g, '').replace(/[.,!?;:]+(?=\s|$)/g, '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- commands

const FILLER = new Set(['please', 'the', 'a', 'an', 'my', 'can', 'could', 'you', 'i', 'want', 'to', 'would', 'like', 'go', 'now', 'just', 'for', 'me', 'as']);
export const DESTRUCTIVE = /\b(delete|remove|erase|destroy|discard|wipe|revoke|purge|empty|reset|deactivate|cancel)\b/i;

function edits(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length]!;
}

const sameWord = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 3 && Math.abs(a.length - b.length) === 1 && (a.startsWith(b) || b.startsWith(a))) || (a.length >= 4 && b.length >= 4 && edits(a, b) <= 1) || (a.length > 3 && b.length > 3 && (a === `${b}s` || b === `${a}s`));
const tokens = (s: string) => clean(s).split(' ').filter((w) => w && !FILLER.has(w));

/** How well spoken words match a command's words, 0 to 1: shared words over all words, forgiving one misheard letter. */
export function similarity(spoken: string, text: string): number {
  const a = tokens(spoken);
  const b = tokens(text);
  if (!a.length || !b.length) return 0;
  const used = new Set<number>();
  let n = 0;
  for (const w of a) {
    const i = b.findIndex((x, k) => !used.has(k) && sameWord(w, x));
    if (i >= 0) {
      used.add(i);
      n++;
    }
  }
  return (2 * n) / (a.length + b.length);
}

/** Permitted commands that match the words, best first, each with its score. */
export function matchCommands(spoken: string, commands: readonly Command[], threshold = 0.6): { command: Command; score: number }[] {
  return commands
    .map((c) => ({ command: c, score: Math.max(similarity(spoken, c.title), ...(c.keywords ?? []).map((k) => similarity(spoken, k) - 0.05)) }))
    .filter((m) => m.score >= threshold)
    .sort((x, y) => y.score - x.score || x.command.title.localeCompare(y.command.title));
}

const YES = new Set(['yes', 'yeah', 'yep', 'confirm', 'do it', 'go ahead', 'yes please', 'ok', 'okay', 'sure']);
const NO = new Set(['no', 'nope', 'stop', 'cancel', 'never mind', 'no thanks', 'dont', "don't"]);
const ORDINAL_PICK: Readonly<Record<string, number>> = { one: 1, first: 1, 'the first one': 1, two: 2, second: 2, 'the second one': 2, three: 3, third: 3, 'the third one': 3 };

export type Heard =
  | { readonly kind: 'ran'; readonly command: Command }
  | { readonly kind: 'confirm'; readonly command: Command; readonly say: string }
  | { readonly kind: 'choose'; readonly options: readonly Command[]; readonly say: string }
  | { readonly kind: 'cancelled'; readonly say: string }
  | { readonly kind: 'none'; readonly say: string };

/** Spoken commands against the palette, with confirmation for anything that cannot be undone. */
export class VoiceCommands {
  private readonly palette: Palette;
  private readonly can: (permission: string) => boolean;
  private readonly destructive: (c: Command) => boolean;
  private readonly threshold: number;
  private pending: { kind: 'confirm'; command: Command } | { kind: 'choose'; options: readonly Command[] } | null = null;

  constructor(palette: Palette, can: (permission: string) => boolean, o: { destructive?: (c: Command) => boolean; threshold?: number } = {}) {
    this.palette = palette;
    this.can = can;
    this.destructive = o.destructive ?? ((c) => DESTRUCTIVE.test(c.title) || DESTRUCTIVE.test(c.id));
    this.threshold = o.threshold ?? 0.6;
  }

  /** What is waiting on the person's answer, if anything. */
  get waiting(): 'confirm' | 'choose' | null {
    return this.pending?.kind ?? null;
  }

  async hear(transcript: string): Promise<Heard> {
    const said = clean(transcript);
    const p = this.pending;
    if (p?.kind === 'confirm') {
      if (YES.has(said)) {
        this.pending = null;
        await this.palette.run(p.command.id, this.can);
        return { kind: 'ran', command: p.command };
      }
      if (NO.has(said)) {
        this.pending = null;
        return { kind: 'cancelled', say: 'Nothing was done.' };
      }
      return { kind: 'confirm', command: p.command, say: confirmWords(p.command) };
    }
    if (p?.kind === 'choose') {
      if (NO.has(said)) {
        this.pending = null;
        return { kind: 'cancelled', say: 'Nothing was done.' };
      }
      const n = ORDINAL_PICK[said];
      const picked = n !== undefined ? p.options[n - 1] : matchCommands(said, p.options, this.threshold)[0]?.command;
      if (!picked) return { kind: 'choose', options: p.options, say: chooseWords(p.options) };
      this.pending = null;
      return this.act(picked);
    }
    if (!said) return { kind: 'none', say: 'I did not hear anything. Try again.' };
    const all = this.palette.search('', this.can, Number.POSITIVE_INFINITY).map((r) => r.command);
    const hits = matchCommands(said, all, this.threshold);
    const top = hits[0];
    if (!top) return { kind: 'none', say: `I did not find a command for “${transcript.trim()}”. Try saying it another way.` };
    const close = hits.filter((h) => top.score - h.score < 0.1).slice(0, 3);
    if (close.length > 1) {
      this.pending = { kind: 'choose', options: close.map((h) => h.command) };
      return { kind: 'choose', options: this.pending.options, say: chooseWords(this.pending.options) };
    }
    return this.act(top.command);
  }

  private async act(c: Command): Promise<Heard> {
    if (this.destructive(c)) {
      this.pending = { kind: 'confirm', command: c };
      return { kind: 'confirm', command: c, say: confirmWords(c) };
    }
    await this.palette.run(c.id, this.can);
    return { kind: 'ran', command: c };
  }
}

const confirmWords = (c: Command) => `${c.title} cannot be undone. Say “yes” to go ahead, or “no” to stop.`;
const chooseWords = (cs: readonly Command[]) => `Did you mean ${cs.map((c, i) => `${['one', 'two', 'three'][i]}: ${c.title}`).join('; ')}? Say the number, or “no” to stop.`;

// ---------------------------------------------------------------- dictation

type Tok = { readonly t: 'word'; readonly v: string } | { readonly t: 'punct' | 'break' | 'open' | 'close'; readonly v: string };

const SPOKEN: readonly [string, Tok][] = [
  ['new paragraph', { t: 'break', v: '\n\n' }],
  ['new line', { t: 'break', v: '\n' }],
  ['full stop', { t: 'punct', v: '.' }],
  ['period', { t: 'punct', v: '.' }],
  ['comma', { t: 'punct', v: ',' }],
  ['question mark', { t: 'punct', v: '?' }],
  ['exclamation mark', { t: 'punct', v: '!' }],
  ['exclamation point', { t: 'punct', v: '!' }],
  ['semicolon', { t: 'punct', v: ';' }],
  ['colon', { t: 'punct', v: ':' }],
  ['open quote', { t: 'open', v: '“' }],
  ['close quote', { t: 'close', v: '”' }],
  ['open bracket', { t: 'open', v: '(' }],
  ['close bracket', { t: 'close', v: ')' }],
];
const SCRATCH = ['scratch that', 'undo that'];

/** One utterance as tokens, and whether it began by taking back what came before. */
function parseUtterance(transcript: string): { scratches: number; toks: Tok[] }[] {
  const words = transcript.replace(/[.,!?;:]+(?=\s|$)/g, '').split(/\s+/).filter(Boolean);
  const groups: { scratches: number; toks: Tok[] }[] = [{ scratches: 0, toks: [] }];
  for (let i = 0; i < words.length; ) {
    const at = (n: number) => words.slice(i, i + n).join(' ').toLowerCase();
    const cur = groups.at(-1)!;
    if (at(1) === 'literal' && words[i + 1]) {
      const two = words.slice(i + 1, i + 3).join(' ');
      const isTwo = SPOKEN.some(([p]) => p === two.toLowerCase() && p.includes(' '));
      cur.toks.push({ t: 'word', v: isTwo ? two : words[i + 1]! });
      i += isTwo ? 3 : 2;
      continue;
    }
    if (SCRATCH.includes(at(2))) {
      if (cur.toks.length) cur.toks.length = 0;
      else cur.scratches++;
      i += 2;
      continue;
    }
    const hit = SPOKEN.find(([p]) => at(p.split(' ').length) === p);
    if (hit) {
      cur.toks.push(hit[1]);
      i += hit[0].split(' ').length;
      continue;
    }
    cur.toks.push({ t: 'word', v: words[i]! });
    i++;
  }
  return groups;
}

export function render(base: string, toks: readonly Tok[], capitalise = true): string {
  let out = base;
  const sentenceStart = () => /(^|[.?!]["”)]?\s*|\n\s*)[“(]?$/.test(out) || !out.replace(/[“(]/g, '').trim();
  for (const k of toks) {
    if (k.t === 'word') {
      let w = k.v === 'i' ? 'I' : k.v;
      if (capitalise && sentenceStart()) w = w.charAt(0).toUpperCase() + w.slice(1);
      out += (out && !/[\s“(]$/.test(out) ? ' ' : '') + w;
    } else if (k.t === 'open') out += (out && !/[\s“(]$/.test(out) ? ' ' : '') + k.v;
    else out = out.replace(/[ \t]+$/, '') + k.v;
  }
  return out;
}

/** Dictation into one field: each utterance is kept, so "scratch that" takes back exactly the last thing said. */
export class Dictation {
  private readonly base: string;
  private readonly said: Tok[][] = [];
  private readonly capitalise: boolean;
  constructor(initial = '', o: { capitalise?: boolean } = {}) {
    this.base = initial;
    this.capitalise = o.capitalise ?? true;
  }
  get text(): string {
    return render(this.base, this.said.flat(), this.capitalise);
  }
  /** Adds one final transcript and returns the field's new text. */
  hear(transcript: string): string {
    for (const g of parseUtterance(transcript)) {
      for (let i = 0; i < g.scratches; i++) this.said.pop();
      if (g.toks.length) this.said.push(g.toks);
    }
    return this.text;
  }
}

// ---------------------------------------------------------------- numbers

const UNITS: Readonly<Record<string, number>> = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS: Readonly<Record<string, number>> = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Readonly<Record<string, number>> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Readonly<Record<string, number>> = { thousand: 1000, million: 1_000_000 };

function whole(words: readonly string[]): number | null {
  if (!words.length) return null;
  let total = 0;
  let cur = 0;
  let last: 'none' | 'unit' | 'teen' | 'ten' | 'hundred' = 'none';
  let lastScale = Infinity;
  let any = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const next = words[i + 1];
    if (w === 'and') {
      if (last !== 'hundred' && lastScale === Infinity) return null;
      continue;
    }
    if (w === 'a') {
      if (last !== 'none' || !next || (next !== 'hundred' && !(next in SCALES))) return null;
      cur = 1;
      last = 'unit';
      continue;
    }
    if (/^\d+$/.test(w)) {
      if (last !== 'none' || words.length > 1) return null;
      return Number(w);
    }
    if (w in UNITS && w !== 'oh') {
      if (last === 'unit' || last === 'teen') return null;
      cur += UNITS[w]!;
      last = 'unit';
    } else if (w in TEENS) {
      if (last !== 'none' && last !== 'hundred') return null;
      cur += TEENS[w]!;
      last = 'teen';
    } else if (w in TENS) {
      if (last !== 'none' && last !== 'hundred') return null;
      cur += TENS[w]!;
      last = 'ten';
    } else if (w === 'hundred') {
      if (last !== 'unit' && last !== 'teen' && last !== 'ten') return null;
      if (cur >= 100) return null;
      cur *= 100;
      last = 'hundred';
    } else if (w in SCALES) {
      const s = SCALES[w]!;
      if (last === 'none' || s >= lastScale) return null;
      total += cur * s;
      cur = 0;
      last = 'none';
      lastScale = s;
    } else return null;
    any = true;
  }
  if (!any || (last === 'none' && lastScale === Infinity)) return null;
  return total + cur;
}

/** A number spoken in words ("minus two hundred and forty five", "three point one four"), or null if it does not read cleanly. */
export function spokenNumber(text: string): number | null {
  const words = clean(text).split(' ').filter(Boolean);
  let sign = 1;
  if (words[0] === 'minus' || words[0] === 'negative') {
    sign = -1;
    words.shift();
  }
  if (words.length === 1 && /^\d+(\.\d+)?$/.test(words[0]!)) return sign * Number(words[0]);
  const p = words.indexOf('point');
  const int = whole(p < 0 ? words : words.slice(0, p));
  if (int === null) return null;
  if (p < 0) return sign * int;
  const frac = words.slice(p + 1);
  if (!frac.length || !frac.every((w) => w in UNITS)) return null;
  return sign * Number(`${int}.${frac.map((w) => UNITS[w]).join('')}`);
}

// ---------------------------------------------------------------- dates

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const ORD_UNITS: Readonly<Record<string, number>> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9 };
const ORD_TEENS: Readonly<Record<string, number>> = { tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30 };

/** A day of the month spoken as an ordinal or a number: "third", "twenty first", "21st", "twelve". */
function dayOfMonth(words: readonly string[]): number | null {
  const s = words.join(' ');
  const digits = /^(\d{1,2})(st|nd|rd|th)?$/.exec(s);
  if (digits) return Number(digits[1]);
  if (words.length === 1 && (words[0]! in ORD_UNITS || words[0]! in ORD_TEENS)) return ORD_UNITS[words[0]!] ?? ORD_TEENS[words[0]!]!;
  if (words.length === 2 && (words[0] === 'twenty' || words[0] === 'thirty') && words[1]! in ORD_UNITS) return TENS[words[0]!]! + ORD_UNITS[words[1]!]!;
  const n = whole(words);
  return n !== null && n >= 1 && n <= 31 ? n : null;
}

/** A year: "2026", "twenty twenty six", "two thousand and twenty six", "nineteen eighty four", "twenty oh five". */
export function spokenYear(words: readonly string[]): number | null {
  if (words.length === 1 && /^\d{4}$/.test(words[0]!)) return Number(words[0]);
  const n = whole(words);
  if (n !== null && n >= 1000 && n <= 2999) return n;
  for (let i = 1; i < words.length; i++) {
    const hi = whole(words.slice(0, i));
    const rest = words.slice(i);
    const lo = rest.length === 1 && rest[0] === 'hundred' ? 0 : rest.length === 2 && rest[0] === 'oh' && rest[1]! in UNITS ? UNITS[rest[1]!]! : (() => { const n = whole(rest); return n !== null && n >= 10 && n <= 99 ? n : null; })();
    if (hi !== null && hi >= 10 && hi <= 29 && lo !== null) return hi * 100 + lo;
  }
  return null;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** A date spoken in words, as YYYY-MM-DD, relative to today (YYYY-MM-DD); null if it does not read as one real date. */
export function spokenDate(text: string, today: string, o: { future?: boolean } = {}): string | null {
  const t = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(t.getTime())) throw new Error('today must be a date like 2026-11-27');
  const s = clean(text).replace(/^on /, '');
  const rel: Readonly<Record<string, number>> = { today: 0, tomorrow: 1, yesterday: -1, 'the day after tomorrow': 2, 'day after tomorrow': 2, 'the day before yesterday': -2 };
  if (s in rel) return ymd(addDays(t, rel[s]!));
  const inN = /^in (.+) (days?|weeks?)$/.exec(s);
  if (inN) {
    const n = inN[1] === 'a' ? 1 : spokenNumber(inN[1]!);
    return n !== null && Number.isInteger(n) && n >= 0 ? ymd(addDays(t, n * (inN[2]!.startsWith('week') ? 7 : 1))) : null;
  }
  // A weekday on its own, or after "this", "next" or "coming", is the first one after today; "last" is the one before.
  const wd = /^(next|this|last|coming)? ?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(s);
  if (wd) {
    const want = DAYS.indexOf(wd[2]!);
    const now = t.getUTCDay();
    if (wd[1] === 'last') return ymd(addDays(t, -(((now - want + 7) % 7) || 7)));
    const ahead = (want - now + 7) % 7 || 7;
    return ymd(addDays(t, ahead));
  }
  // "the third of march [year]" or "march the third [year]" or "march third [year]"
  const words = s.split(' ').filter((w) => w && w !== 'the');
  const mi = words.findIndex((w) => MONTHS.includes(w));
  if (mi < 0) return null;
  const month = MONTHS.indexOf(words[mi]!);
  const before = words.slice(0, mi).filter((w) => w !== 'of');
  const after = words.slice(mi + 1);
  let day: number | null = null;
  let yearWords: string[] = [];
  if (before.length) {
    day = dayOfMonth(before);
    yearWords = after;
  } else {
    for (let k = Math.min(2, after.length); k >= 1 && day === null; k--) {
      const d = dayOfMonth(after.slice(0, k));
      if (d !== null) {
        day = d;
        yearWords = after.slice(k);
      }
    }
  }
  if (day === null) return null;
  let year = t.getUTCFullYear();
  if (yearWords.length) {
    const y = spokenYear(yearWords);
    if (y === null) return null;
    year = y;
  }
  const make = (y: number) => {
    const d = new Date(Date.UTC(y, month, day!));
    return d.getUTCMonth() === month ? ymd(d) : null;
  };
  const got = make(year);
  if (got && !yearWords.length && o.future && got < today) return make(year + 1);
  return got;
}

// ---------------------------------------------------------------- any field

export type FieldKind = 'text' | 'number' | 'date';

/** A spoken value for one field of the given kind, or a sentence to say back when it cannot be read. */
export function forField(kind: FieldKind, transcript: string, today?: string, o: { future?: boolean } = {}): { ok: true; value: string | number } | { ok: false; say: string } {
  const heard = transcript.trim();
  if (!heard) return { ok: false, say: 'I did not hear anything. Try again.' };
  if (kind === 'number') {
    const n = spokenNumber(heard);
    return n === null ? { ok: false, say: `I heard “${heard}” but could not read it as a number. Try saying it again, one number at a time.` } : { ok: true, value: n };
  }
  if (kind === 'date') {
    if (!today) throw new Error('a date field needs today’s date');
    const d = spokenDate(heard, today, o);
    return d === null ? { ok: false, say: `I heard “${heard}” but could not read it as a date. Try “the third of March” or “next Friday”.` } : { ok: true, value: d };
  }
  return { ok: true, value: new Dictation().hear(heard) };
}

// ---------------------------------------------------------------- browser adapter

export interface RecognitionAlternative {
  readonly transcript: string;
  readonly confidence?: number;
}
export interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [i: number]: RecognitionAlternative;
}
export interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [i: number]: RecognitionResult };
}
export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
export type RecognitionConstructor = new () => Recognition;

/** The browser's speech recognition, if it has one (standard or prefixed). */
export function recognitionIn(host: unknown): RecognitionConstructor | null {
  if (!host || typeof host !== 'object') return null;
  const h = host as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  const c = h.SpeechRecognition ?? h.webkitSpeechRecognition;
  return typeof c === 'function' ? (c as RecognitionConstructor) : null;
}

/** What to tell the person when recognition stops with an error; null when nothing needs saying. */
export function errorWords(code: string): string | null {
  switch (code) {
    case 'aborted': return null;
    case 'not-allowed':
    case 'service-not-allowed': return 'The microphone is blocked. Allow it in your browser’s settings to speak instead of type.';
    case 'no-speech': return 'Nothing was heard. Try again a little closer to the microphone.';
    case 'audio-capture': return 'No microphone was found.';
    case 'network': return 'Speech recognition needs a connection, and the connection dropped.';
    default: return 'Speech recognition stopped. You can keep typing.';
  }
}

export interface ListenOptions {
  readonly lang?: string;
  readonly continuous?: boolean;
  readonly onFinal: (transcript: string) => void;
  readonly onInterim?: (transcript: string) => void;
  readonly onError?: (message: string) => void;
  readonly onEnd?: () => void;
}

/** Starts listening when the browser can; returns null (and the app keeps its keyboard) when it cannot. */
export function listen(host: unknown, o: ListenOptions): { stop(): void } | null {
  const R = recognitionIn(host);
  if (!R) return null;
  const r = new R();
  r.lang = o.lang ?? 'en-GB';
  r.continuous = o.continuous ?? false;
  r.interimResults = !!o.onInterim;
  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const best = res?.[0];
      if (!res || !best) continue;
      if (res.isFinal) o.onFinal(best.transcript.trim());
      else interim += best.transcript;
    }
    if (interim && o.onInterim) o.onInterim(interim.trim());
  };
  r.onerror = (e) => {
    const m = errorWords(e.error);
    if (m && o.onError) o.onError(m);
  };
  r.onend = () => o.onEnd?.();
  r.start();
  return { stop: () => r.stop() };
}

/** Voice input on any text field: what is said is dictated into the field's value, after what is already there. */
export function dictateInto(host: unknown, field: { value: string }, o: Omit<ListenOptions, 'onFinal'> & { onChange?: (text: string) => void } = {}): { stop(): void } | null {
  const d = new Dictation(field.value);
  return listen(host, {
    ...o,
    onFinal: (t) => {
      field.value = d.hear(t);
      o.onChange?.(field.value);
    },
  });
}
