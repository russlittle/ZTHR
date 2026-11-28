/**
 * vCard 3.0 (RFC 2426) and 4.0 (RFC 6350) read and write, as address books and CardDAV carry them. A file holds any
 * number of cards; lines are unfolded and folded at 75 octets without splitting a UTF-8 character, text is escaped
 * (backslash, comma, semicolon, newline), property groups (item1.TEL with item1.X-ABLabel) and parameters are kept,
 * and every property the reader does not know, including X- extensions, survives a round trip untouched. The typed
 * view gives names, emails, phones (optionally normalised to E.164 with the contact block), addresses, organisation,
 * birthday, categories, kind (individual, group, org, location) with MEMBER lists, and a photo; `convert` moves a
 * card between 3.0 and 4.0 (photo encoding, TYPE=pref against PREF=1, Apple's group markers) and `merge` is a
 * three-way merge for two edits of one card: a field changed on one side takes that side, multi-valued properties
 * merge as sets (adds and removes from both sides survive), and only a field changed differently on both sides is
 * reported as a conflict.
 *
 * Hostile input is bounded: file size, card count, line length, properties per card, photo size; a photo's bytes must
 * be the image type they claim (read from the bytes with the imagemeta block) and a photo link must be https or a
 * data URI. vCard 2.1 and unknown versions are refused with a plain message.
 * Out of scope: vCard 2.1, quoted-printable, VCARD-XML/jCard, and CardDAV transport (see the dav block).
 */
import { phone as toE164 } from '../contact/index.ts';
import { sniff } from '../imagemeta/index.ts';

export class VCardError extends Error {}

export type Value = string | string[] | string[][];

export interface Prop {
  readonly group?: string;
  /** Upper case. */
  readonly name: string;
  /** Parameter names upper case; each value list as given (TYPE values lower case). */
  readonly params: Readonly<Record<string, readonly string[]>>;
  /** Text (unescaped), or components for the structured properties N, ADR, ORG, GENDER (each component may hold several values). */
  readonly value: Value;
}

export interface Card {
  readonly version: '3.0' | '4.0';
  /** Every property but BEGIN, END and VERSION, in file order. */
  readonly props: readonly Prop[];
}

export interface ParseLimits {
  readonly maxBytes?: number;
  readonly maxCards?: number;
  readonly maxLine?: number;
  readonly maxProps?: number;
}

const STRUCTURED = new Set(['N', 'ADR', 'ORG', 'GENDER']);
const NO_ESCAPE_VALUE = new Set(['VERSION']);

function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length) out[out.length - 1] += raw.slice(1);
    else out.push(raw);
  }
  return out;
}

const BS = String.fromCharCode(92);
const unescapeText = (s: string) => s.replace(/\\([\\,;nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
const escapeText = (s: string) => s.replace(/\x5c/g, BS + BS).replace(/\r\n|\r|\n/g, BS + 'n').replace(/,/g, BS + ',').replace(/;/g, BS + ';');
const escapeComponent = escapeText;

/** Splits on separators that are not escaped. */
function splitUnescaped(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      cur += s[i]! + s[i + 1]!;
      i++;
    } else if (s[i] === sep) {
      out.push(cur);
      cur = '';
    } else cur += s[i];
  }
  out.push(cur);
  return out;
}

function parseLine(line: string, n: number): { group?: string; name: string; params: Record<string, string[]>; raw: string } {
  // name part ends at the first ; or : outside quotes
  let i = 0;
  let inQ = false;
  let colon = -1;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ':' && !inQ) {
      colon = i;
      break;
    }
  }
  if (colon < 0) throw new VCardError(`line ${n}: there is no ":" in "${line.slice(0, 30)}"`);
  const head = line.slice(0, colon);
  const raw = line.slice(colon + 1);
  const segs: string[] = [];
  let cur = '';
  inQ = false;
  for (const c of head) {
    if (c === '"') {
      inQ = !inQ;
      cur += c;
    } else if (c === ';' && !inQ) {
      segs.push(cur);
      cur = '';
    } else cur += c;
  }
  segs.push(cur);
  const nameFull = segs[0]!;
  const dot = nameFull.lastIndexOf('.');
  const group = dot >= 0 ? nameFull.slice(0, dot) : undefined;
  const name = (dot >= 0 ? nameFull.slice(dot + 1) : nameFull).toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name) || (group !== undefined && !/^[A-Za-z0-9-]+$/.test(group))) throw new VCardError(`line ${n}: "${nameFull.slice(0, 30)}" is not a valid property name`);
  const params: Record<string, string[]> = {};
  for (const seg of segs.slice(1)) {
    const eq = seg.indexOf('=');
    const pn = (eq < 0 ? 'TYPE' : seg.slice(0, eq)).toUpperCase();
    const pv = eq < 0 ? seg : seg.slice(eq + 1);
    const vals: string[] = [];
    let v = '';
    let q = false;
    for (const c of pv) {
      if (c === '"') q = !q;
      else if (c === ',' && !q) {
        vals.push(v);
        v = '';
      } else v += c;
    }
    vals.push(v);
    (params[pn] ??= []).push(...vals.map((x) => (pn === 'TYPE' ? x.toLowerCase() : x)));
  }
  return { ...(group !== undefined ? { group } : {}), name, params, raw };
}

/** Reads one or more cards. Throws VCardError naming the line when something is wrong. */
export function parse(text: string, lim: ParseLimits = {}): Card[] {
  const maxBytes = lim.maxBytes ?? 10_000_000;
  if (Buffer.byteLength(text) > maxBytes) throw new VCardError(`the file is larger than ${maxBytes} bytes`);
  const maxLine = lim.maxLine ?? 1_000_000;
  const maxCards = lim.maxCards ?? 10_000;
  const maxProps = lim.maxProps ?? 2_000;
  const lines = unfold(text.replace(/^\uFEFF/, ''));
  const cards: Card[] = [];
  let version: '3.0' | '4.0' | undefined;
  let props: Prop[] | undefined;
  lines.forEach((line, idx) => {
    const n = idx + 1;
    if (line === '') return;
    if (line.length > maxLine) throw new VCardError(`line ${n}: longer than ${maxLine} characters`);
    const pl = parseLine(line, n);
    if (pl.name === 'BEGIN' && !pl.group) {
      if (props) throw new VCardError(`line ${n}: BEGIN inside a card (nested cards are not supported)`);
      if (pl.raw.trim().toUpperCase() !== 'VCARD') throw new VCardError(`line ${n}: only VCARD objects are supported`);
      props = [];
      version = undefined;
      return;
    }
    if (!props) throw new VCardError(`line ${n}: text outside BEGIN:VCARD`);
    if (pl.name === 'END' && !pl.group) {
      if (pl.raw.trim().toUpperCase() !== 'VCARD') throw new VCardError(`line ${n}: END does not match BEGIN`);
      if (!version) throw new VCardError(`line ${n}: the card has no VERSION`);
      if (cards.length >= maxCards) throw new VCardError(`more than ${maxCards} cards`);
      cards.push({ version, props });
      props = undefined;
      return;
    }
    if (pl.name === 'VERSION') {
      const v = pl.raw.trim();
      if (v !== '3.0' && v !== '4.0') throw new VCardError(`line ${n}: vCard version ${v} is not supported (3.0 and 4.0 are)`);
      version = v;
      return;
    }
    if (props.length >= maxProps) throw new VCardError(`line ${n}: more than ${maxProps} properties in one card`);
    let value: Value;
    if (STRUCTURED.has(pl.name)) value = splitUnescaped(pl.raw, ';').map((comp) => (pl.name === 'ORG' || pl.name === 'GENDER' ? unescapeText(comp) : splitUnescaped(comp, ',').map(unescapeText))) as Value;
    else if (NO_ESCAPE_VALUE.has(pl.name) || pl.name === 'PHOTO' || pl.name === 'LOGO' || pl.name === 'KEY' || pl.name === 'SOUND') value = pl.raw;
    else if (pl.name === 'CATEGORIES' || pl.name === 'NICKNAME') value = splitUnescaped(pl.raw, ',').map(unescapeText);
    else value = unescapeText(pl.raw);
    props.push({ ...(pl.group !== undefined ? { group: pl.group } : {}), name: pl.name, params: pl.params, value });
  });
  if (props) throw new VCardError('the last card has no END:VCARD');
  if (cards.length === 0) throw new VCardError('there is no vCard in this text');
  return cards;
}

function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > limit) {
      out.push(cur);
      cur = '';
      bytes = 0;
      limit = 74; // continuation lines start with a space
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const paramValue = (v: string) => (/[;:,"]/.test(v) ? `"${v.replace(/"/g, "'")}"` : v);

function writeProp(p: Prop): string {
  let v: string;
  if (Array.isArray(p.value)) {
    if (p.name === 'N' || p.name === 'ADR') v = (p.value as (string | string[])[]).map((c) => (Array.isArray(c) ? c.map(escapeComponent).join(',') : escapeComponent(c))).join(';');
    else if (p.name === 'ORG' || p.name === 'GENDER') v = (p.value as (string | string[])[]).map((c) => escapeComponent(Array.isArray(c) ? c.join(',') : c)).join(';');
    else v = (p.value as string[]).map((c) => escapeText(String(c))).join(',');
  } else v = p.name === 'PHOTO' || p.name === 'LOGO' || p.name === 'KEY' || p.name === 'SOUND' ? p.value : escapeText(p.value);
  const params = Object.entries(p.params)
    .filter(([, vals]) => vals.length)
    .map(([k, vals]) => `;${k}=${vals.map(paramValue).join(',')}`)
    .join('');
  return foldLine(`${p.group ? `${p.group}.` : ''}${p.name}${params}:${v}`);
}

/** Writes cards as text with CRLF line ends. */
export function write(cards: Card | readonly Card[]): string {
  const list = 'props' in cards ? [cards] : cards;
  return list.map((c) => ['BEGIN:VCARD', `VERSION:${c.version}`, ...c.props.map(writeProp), 'END:VCARD'].join('\r\n')).join('\r\n') + '\r\n';
}

// --- typed view ------------------------------------------------------------------------------------------------------------

export interface Typed {
  readonly value: string;
  readonly types: readonly string[];
  readonly pref: boolean;
  readonly label?: string;
}
export interface Address {
  readonly pobox: string;
  readonly extended: string;
  readonly street: string;
  readonly locality: string;
  readonly region: string;
  readonly postal: string;
  readonly country: string;
  readonly types: readonly string[];
  readonly pref: boolean;
}
export type Kind = 'individual' | 'group' | 'org' | 'location';
export interface Photo {
  readonly mediaType?: string;
  readonly bytes?: Buffer;
  readonly uri?: string;
}
export interface Contact {
  readonly kind: Kind;
  readonly uid?: string;
  readonly fn: string;
  readonly name?: { readonly family: string; readonly given: string; readonly additional: string; readonly prefix: string; readonly suffix: string };
  readonly nicknames: readonly string[];
  readonly birthday?: string;
  readonly org?: { readonly name: string; readonly units: readonly string[] };
  readonly title?: string;
  readonly role?: string;
  readonly emails: readonly Typed[];
  readonly phones: readonly Typed[];
  readonly addresses: readonly Address[];
  readonly urls: readonly Typed[];
  readonly categories: readonly string[];
  readonly note?: string;
  readonly photo?: Photo;
  /** For a group: the members' ids (urn:uuid:..., mailto:...). */
  readonly members: readonly string[];
  readonly rev?: string;
}

export interface ViewOptions {
  /** Normalise phone numbers to E.164 assuming this country when there is no + prefix; numbers that cannot be normalised are kept as written. */
  readonly phoneCountry?: string;
  /** Largest photo accepted, in bytes (default 5 MiB). */
  readonly maxPhotoBytes?: number;
}

const first = (c: Card, name: string) => c.props.find((p) => p.name === name);
const all = (c: Card, name: string) => c.props.filter((p) => p.name === name);
const text = (p: Prop | undefined): string | undefined => (p === undefined ? undefined : Array.isArray(p.value) ? (p.value as unknown[]).flat().join(',') : p.value);

function isPref(p: Prop, v: '3.0' | '4.0'): boolean {
  return v === '4.0' ? (p.params['PREF'] ?? []).some((x) => Number(x) === 1) || (p.params['TYPE'] ?? []).includes('pref') : (p.params['TYPE'] ?? []).includes('pref') || (p.params['PREF'] ?? []).length > 0;
}

function typesOf(p: Prop): string[] {
  return (p.params['TYPE'] ?? []).filter((t) => t !== 'pref');
}

function typed(c: Card, name: string, norm: (v: string) => string = (v) => v): Typed[] {
  return all(c, name).map((p) => {
    const label = c.props.find((q) => q.group && q.group === p.group && q.name === 'X-ABLABEL');
    return { value: norm(text(p) ?? ''), types: typesOf(p), pref: isPref(p, c.version), ...(label ? { label: text(label) ?? '' } : {}) };
  });
}

function photoOf(p: Prop, max: number): Photo {
  const v = String(p.value);
  const enc = (p.params['ENCODING'] ?? []).join('').toLowerCase();
  let bytes: Buffer | undefined;
  let claimed = (p.params['MEDIATYPE']?.[0] ?? (p.params['TYPE']?.[0] ? `image/${p.params['TYPE']![0]!.toLowerCase().replace('jpg', 'jpeg')}` : undefined));
  if (/^data:/i.test(v)) {
    const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/is.exec(v);
    if (!m) throw new VCardError('a PHOTO data URI is malformed');
    claimed = m[1] || claimed;
    bytes = /;base64/i.test(m[2]!) ? Buffer.from(m[3]!.replace(/\s/g, ''), 'base64') : Buffer.from(decodeURIComponent(m[3]!), 'latin1');
  } else if (enc === 'b' || enc === 'base64') bytes = Buffer.from(v.replace(/\s/g, ''), 'base64');
  if (bytes) {
    if (bytes.length > max) throw new VCardError(`a photo of ${bytes.length} bytes is over the ${max} byte limit`);
    const kind = sniff(bytes);
    if (!kind) throw new VCardError('the photo is not a PNG, JPEG, GIF or WebP image');
    const real = `image/${kind}`;
    if (claimed && claimed.toLowerCase() !== real) throw new VCardError(`the photo says ${claimed} but its bytes are ${real}`);
    return { mediaType: real, bytes };
  }
  if (!/^https:\/\//i.test(v)) throw new VCardError('a photo link must be https or a data: URI');
  return { uri: v };
}

/** The typed view of a card. */
export function view(c: Card, o: ViewOptions = {}): Contact {
  const n = first(c, 'N');
  const comp = (i: number) => {
    const v = n && Array.isArray(n.value) ? (n.value as (string | string[])[])[i] : undefined;
    return Array.isArray(v) ? v.join(' ') : (v ?? '');
  };
  const orgP = first(c, 'ORG');
  const orgV = orgP && Array.isArray(orgP.value) ? (orgP.value as string[]) : undefined;
  const kindText = (text(first(c, 'KIND')) ?? text(first(c, 'X-ADDRESSBOOKSERVER-KIND')) ?? 'individual').toLowerCase();
  const kind: Kind = kindText === 'group' || kindText === 'org' || kindText === 'location' ? kindText : 'individual';
  const phoneNorm = (v: string) => {
    const bare = v.replace(/^tel:/i, '');
    if (!o.phoneCountry) return bare;
    try {
      return toE164(bare, o.phoneCountry);
    } catch {
      return bare;
    }
  };
  const photoP = first(c, 'PHOTO');
  const members = [...all(c, 'MEMBER'), ...all(c, 'X-ADDRESSBOOKSERVER-MEMBER')].map((p) => text(p) ?? '');
  const out: Contact = {
    kind,
    ...(text(first(c, 'UID')) ? { uid: text(first(c, 'UID'))! } : {}),
    fn: text(first(c, 'FN')) ?? '',
    ...(n ? { name: { family: comp(0), given: comp(1), additional: comp(2), prefix: comp(3), suffix: comp(4) } } : {}),
    nicknames: all(c, 'NICKNAME').flatMap((p) => (Array.isArray(p.value) ? (p.value as string[]) : [p.value])),
    ...(text(first(c, 'BDAY')) ? { birthday: text(first(c, 'BDAY'))! } : {}),
    ...(orgV ? { org: { name: String(orgV[0] ?? ''), units: orgV.slice(1).map(String) } } : {}),
    ...(text(first(c, 'TITLE')) ? { title: text(first(c, 'TITLE'))! } : {}),
    ...(text(first(c, 'ROLE')) ? { role: text(first(c, 'ROLE'))! } : {}),
    emails: typed(c, 'EMAIL'),
    phones: typed(c, 'TEL', phoneNorm),
    addresses: all(c, 'ADR').map((p) => {
      const v = (Array.isArray(p.value) ? p.value : []) as (string | string[])[];
      const g = (i: number) => (Array.isArray(v[i]) ? (v[i] as string[]).join(', ') : String(v[i] ?? ''));
      return { pobox: g(0), extended: g(1), street: g(2), locality: g(3), region: g(4), postal: g(5), country: g(6), types: typesOf(p), pref: isPref(p, c.version) };
    }),
    urls: typed(c, 'URL'),
    categories: all(c, 'CATEGORIES').flatMap((p) => (Array.isArray(p.value) ? (p.value as string[]) : [p.value])),
    ...(text(first(c, 'NOTE')) !== undefined ? { note: text(first(c, 'NOTE'))! } : {}),
    ...(photoP ? { photo: photoOf(photoP, o.maxPhotoBytes ?? 5 * 1024 * 1024) } : {}),
    members,
    ...(text(first(c, 'REV')) ? { rev: text(first(c, 'REV'))! } : {}),
  };
  return out;
}

function typedProps(name: string, list: readonly Typed[], v: '3.0' | '4.0'): Prop[] {
  return list.map((t) => {
    const params: Record<string, string[]> = {};
    const types = [...t.types];
    if (t.pref) {
      if (v === '4.0') params['PREF'] = ['1'];
      else types.push('pref');
    }
    if (types.length) params['TYPE'] = types;
    return { name, params, value: t.value };
  });
}

/** A card from a contact. A group gets KIND:group (4.0) or X-ADDRESSBOOKSERVER-KIND:group (3.0). */
export function build(c: Contact, version: '3.0' | '4.0' = '4.0'): Card {
  if (!c.fn && !c.name) throw new VCardError('a card needs a formatted name (FN)');
  const props: Prop[] = [];
  const add = (name: string, value: Value, params: Record<string, string[]> = {}) => void props.push({ name, params, value });
  if (c.kind !== 'individual') {
    if (version === '4.0') add('KIND', c.kind);
    else if (c.kind === 'group') add('X-ADDRESSBOOKSERVER-KIND', 'group');
    else add('X-ABShowAs', 'COMPANY');
  }
  if (c.uid) add('UID', c.uid);
  add('FN', c.fn || [c.name!.given, c.name!.family].filter(Boolean).join(' '));
  if (c.name) add('N', [[c.name.family], [c.name.given], [c.name.additional], [c.name.prefix], [c.name.suffix]]);
  if (c.nicknames.length) add('NICKNAME', [...c.nicknames]);
  if (c.birthday) add('BDAY', c.birthday);
  if (c.org) add('ORG', [c.org.name, ...c.org.units]);
  if (c.title) add('TITLE', c.title);
  if (c.role) add('ROLE', c.role);
  props.push(...typedProps('EMAIL', c.emails, version), ...typedProps('TEL', c.phones, version));
  for (const a of c.addresses) {
    const params: Record<string, string[]> = {};
    const types = [...a.types, ...(a.pref && version === '3.0' ? ['pref'] : [])];
    if (types.length) params['TYPE'] = types;
    if (a.pref && version === '4.0') params['PREF'] = ['1'];
    add('ADR', [[a.pobox], [a.extended], [a.street], [a.locality], [a.region], [a.postal], [a.country]], params);
  }
  props.push(...typedProps('URL', c.urls, version));
  if (c.categories.length) add('CATEGORIES', [...c.categories]);
  if (c.note) add('NOTE', c.note);
  if (c.photo) {
    if (c.photo.bytes) {
      const kind = sniff(c.photo.bytes);
      if (!kind) throw new VCardError('the photo is not a PNG, JPEG, GIF or WebP image');
      if (version === '4.0') add('PHOTO', `data:image/${kind};base64,${c.photo.bytes.toString('base64')}`);
      else add('PHOTO', c.photo.bytes.toString('base64'), { ENCODING: ['b'], TYPE: [kind.toUpperCase()] });
    } else if (c.photo.uri) {
      if (!/^https:\/\//i.test(c.photo.uri)) throw new VCardError('a photo link must be https or a data: URI');
      add('PHOTO', c.photo.uri, version === '3.0' ? { VALUE: ['uri'] } : {});
    }
  }
  for (const m of c.members) add(version === '4.0' ? 'MEMBER' : 'X-ADDRESSBOOKSERVER-MEMBER', m);
  if (c.rev) add('REV', c.rev);
  return { version, props };
}

/** Moves a card between versions, keeping every property. */
export function convert(c: Card, to: '3.0' | '4.0', o: ViewOptions = {}): Card {
  if (c.version === to) return c;
  const props: Prop[] = [];
  for (const p of c.props) {
    let q: Prop = p;
    const types = [...(p.params['TYPE'] ?? [])];
    const pref = isPref(p, c.version);
    if (['EMAIL', 'TEL', 'ADR', 'URL'].includes(p.name)) {
      const t = types.filter((x) => x !== 'pref');
      const params: Record<string, readonly string[]> = { ...p.params };
      delete params['PREF'];
      delete params['TYPE'];
      if (to === '4.0') {
        if (pref) params['PREF'] = ['1'];
        if (t.length) params['TYPE'] = t;
      } else {
        const tt = [...t, ...(pref ? ['pref'] : [])];
        if (tt.length) params['TYPE'] = tt;
      }
      q = { ...p, params };
    } else if (p.name === 'PHOTO') {
      const ph = photoOf(p, o.maxPhotoBytes ?? 5 * 1024 * 1024);
      if (ph.bytes) {
        const kind = sniff(ph.bytes)!;
        q = to === '4.0' ? { name: 'PHOTO', params: {}, value: `data:image/${kind};base64,${ph.bytes.toString('base64')}`, ...(p.group ? { group: p.group } : {}) } : { name: 'PHOTO', params: { ENCODING: ['b'], TYPE: [kind.toUpperCase()] }, value: ph.bytes.toString('base64'), ...(p.group ? { group: p.group } : {}) };
      } else q = { ...p, params: to === '3.0' ? { VALUE: ['uri'] } : {} };
    } else if (p.name === 'KIND' && to === '3.0') q = String(p.value) === 'group' ? { name: 'X-ADDRESSBOOKSERVER-KIND', params: {}, value: 'group' } : p;
    else if (p.name === 'X-ADDRESSBOOKSERVER-KIND' && to === '4.0') q = { name: 'KIND', params: {}, value: p.value };
    else if (p.name === 'MEMBER' && to === '3.0') q = { name: 'X-ADDRESSBOOKSERVER-MEMBER', params: {}, value: p.value };
    else if (p.name === 'X-ADDRESSBOOKSERVER-MEMBER' && to === '4.0') q = { name: 'MEMBER', params: {}, value: p.value };
    props.push(q);
  }
  return { version: to, props };
}

// --- merge -----------------------------------------------------------------------------------------------------------------

const SINGLE = new Set(['FN', 'N', 'BDAY', 'ANNIVERSARY', 'ORG', 'TITLE', 'ROLE', 'NOTE', 'KIND', 'X-ADDRESSBOOKSERVER-KIND', 'UID', 'PHOTO', 'GENDER', 'REV']);

const canon = (p: Prop): string => JSON.stringify([p.group ?? '', p.name, Object.entries(p.params).sort(([a], [b]) => (a < b ? -1 : 1)), p.value]);
function identity(p: Prop): string {
  const v = Array.isArray(p.value) ? JSON.stringify(p.value) : p.value;
  if (p.name === 'EMAIL') return `EMAIL|${String(v).trim().toLowerCase()}`;
  if (p.name === 'TEL') return `TEL|${String(v).replace(/^tel:/i, '').replace(/[^\d+]/g, '')}`;
  return `${p.name}|${p.group ?? ''}|${v}`;
}

export interface MergeResult {
  readonly card: Card;
  /** Fields changed differently on both sides; `ours` was kept for each. */
  readonly conflicts: readonly string[];
}

/** Three-way merge of two edits (`ours`, `theirs`) of the same card made from `base`. */
export function merge(base: Card, ours: Card, theirs: Card): MergeResult {
  if (ours.version !== theirs.version || base.version !== ours.version) throw new VCardError('convert the cards to one version before merging');
  const names = new Set([...base.props, ...ours.props, ...theirs.props].map((p) => p.name));
  const out: Prop[] = [];
  const conflicts: string[] = [];
  const order = new Map<string, number>();
  [...base.props, ...theirs.props, ...ours.props].forEach((p, i) => order.set(identity(p), i));
  for (const name of names) {
    const b = base.props.filter((p) => p.name === name);
    const o = ours.props.filter((p) => p.name === name);
    const t = theirs.props.filter((p) => p.name === name);
    if (name === 'REV') {
      const latest = [...o, ...t].map((p) => String(p.value)).sort().pop();
      if (latest !== undefined) out.push({ name, params: {}, value: latest });
      continue;
    }
    if (SINGLE.has(name)) {
      const cb = b.map(canon).join('\n');
      const co = o.map(canon).join('\n');
      const ct = t.map(canon).join('\n');
      if (co === ct || ct === cb) out.push(...o);
      else if (co === cb) out.push(...t);
      else {
        conflicts.push(name);
        out.push(...o);
      }
      continue;
    }
    const ib = new Map(b.map((p) => [identity(p), p]));
    const io = new Map(o.map((p) => [identity(p), p]));
    const it = new Map(t.map((p) => [identity(p), p]));
    const keys = new Set([...ib.keys(), ...io.keys(), ...it.keys()]);
    const kept: [number, Prop][] = [];
    for (const k of keys) {
      const inB = ib.has(k);
      const inO = io.has(k);
      const inT = it.has(k);
      if (inB && (!inO || !inT)) continue; // removed on one side
      if (!inO && !inT) continue;
      let chosen: Prop;
      if (inO && inT) {
        const po = io.get(k)!;
        const pt = it.get(k)!;
        const pb = ib.get(k);
        chosen = canon(po) === canon(pt) || !pb ? po : canon(po) === canon(pb) ? pt : po;
      } else chosen = (inO ? io.get(k) : it.get(k))!;
      kept.push([order.get(k) ?? 0, chosen]);
    }
    kept.sort((a, c) => a[0] - c[0]);
    out.push(...kept.map(([, p]) => p));
  }
  // FN first, then in the order of ours so the file reads naturally
  const rank = new Map(ours.props.map((p, i) => [p.name, i]));
  out.sort((a, c) => (rank.get(a.name) ?? 1e6) - (rank.get(c.name) ?? 1e6));
  return { card: { version: ours.version, props: out }, conflicts };
}

/** Whether a group card lists a member (by uid urn or other id). */
export const hasMember = (c: Card, id: string) => c.props.some((p) => (p.name === 'MEMBER' || p.name === 'X-ADDRESSBOOKSERVER-MEMBER') && String(p.value) === id);
