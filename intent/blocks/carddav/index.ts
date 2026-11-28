/**
 * CardDAV (RFC 6352) address books over the dav block's XML reader and multistatus writer, with a vCard reader and
 * writer of its own (vCard 3.0, RFC 2426, and 4.0, RFC 6350: line unfolding and folding, groups, parameters with
 * quoted values, escaped text). It holds address book collections in a store and answers the methods a contacts app
 * sends: MKCOL with an addressbook resource type, PROPFIND, PROPPATCH (display name and description), PUT and DELETE
 * with ETag preconditions, GET and HEAD, and REPORT.
 *
 * Reports: addressbook-query (prop-filter and param-filter, test anyof or allof, text-match with equals, contains,
 * starts-with and ends-with, negate-condition, is-not-defined, collations i;unicode-casemap, i;ascii-casemap and
 * i;octet, and a limit that answers 507 for the address book when there are more matches), addressbook-multiget, and
 * sync-collection (RFC 6578: a sync token names a position in a change log, one older than the log kept is refused
 * with DAV:valid-sync-token so the client lists everything again). address-data may name the properties wanted.
 * A text-match is applied to the whole value of a property with its escapes resolved; for a structured value such as
 * N or ADR that is its parts joined by semicolons.
 *
 * Writes enforce the RFC's preconditions with the DAV error elements: supported-address-data (it must be a vCard of
 * a supported version), valid-address-data (exactly one card, with FN and UID), no-uid-conflict (naming the resource
 * that has the UID), and max-resource-size. Names are plain file names ending .vcf.
 *
 * Out of scope: authentication and access control (the caller decides who may reach which path), principals and
 * address-book-home discovery, conversion between vCard versions, and vCard parameters beyond reading and keeping them.
 */
import { createHash } from 'node:crypto';
import { BadXml, DAV, child, children, depth as davDepth, el, parseXml, propfindRequest, writeXml } from '../dav/index.ts';
import type { El, Out } from '../dav/index.ts';

export const CARDDAV = 'urn:ietf:params:xml:ns:carddav';
export const CS = 'http://calendarserver.org/ns/';
const PREFIXES = { [DAV]: 'd', [CARDDAV]: 'card', [CS]: 'cs' };

// --- vCard ---------------------------------------------------------------------------------------------------------

export class BadVCard extends Error {
  constructor(why: string) {
    super(why);
  }
}

export interface VProp {
  readonly group?: string;
  readonly name: string;
  /** Parameter names upper-case; each value list split on commas, quotes removed. */
  readonly params: Readonly<Record<string, readonly string[]>>;
  /** The value as written, escapes intact. */
  readonly raw: string;
}
export interface VCard {
  readonly props: readonly VProp[];
}

const unescapeText = (s: string) => s.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
const escapeText = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\;');

/** The value with escapes resolved; for a structured value the parts are kept, joined by semicolons. */
export function textOf(p: VProp): string {
  return splitUnescaped(p.raw, ';').map((part) => splitUnescaped(part, ',').map(unescapeText).join(',')).join(';');
}

function splitUnescaped(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length) {
      cur += c + s[++i];
    } else if (c === sep) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function parseLine(line: string): VProp {
  let i = 0;
  let quoted = false;
  let colon = -1;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) throw new BadVCard(`a line that is not a property: ${JSON.stringify(line.slice(0, 40))}`);
  const head = line.slice(0, colon);
  const raw = line.slice(colon + 1);
  const parts: string[] = [];
  let cur = '';
  quoted = false;
  for (const c of head) {
    if (c === '"') {
      quoted = !quoted;
      cur += c;
    } else if (c === ';' && !quoted) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  if (quoted) throw new BadVCard('an unclosed quote in a parameter');
  parts.push(cur);
  const full = parts.shift()!;
  const dot = full.indexOf('.');
  const group = dot >= 0 ? full.slice(0, dot) : undefined;
  const name = (dot >= 0 ? full.slice(dot + 1) : full).toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name) || (group !== undefined && !/^[A-Za-z0-9-]+$/.test(group))) throw new BadVCard(`${JSON.stringify(full.slice(0, 40))} is not a property name`);
  const params: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const p of parts) {
    const eq = p.indexOf('=');
    // vCard 2.1 style, a bare TYPE value, is read as TYPE.
    const k = (eq < 0 ? 'TYPE' : p.slice(0, eq)).toUpperCase();
    const v = eq < 0 ? p : p.slice(eq + 1);
    if (!/^[A-Z0-9-]+$/.test(k)) throw new BadVCard(`${JSON.stringify(k.slice(0, 40))} is not a parameter name`);
    const vals: string[] = [];
    let c2 = '';
    let q = false;
    for (const ch of v) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) {
        vals.push(c2);
        c2 = '';
      } else c2 += ch;
    }
    vals.push(c2);
    // vCard 4.0 writes a list as TYPE="work,home"; for TYPE the commas separate values even inside quotes.
    (params[k] ??= []).push(...(k === 'TYPE' ? vals.flatMap((x) => x.split(',')) : vals));
  }
  return { ...(group !== undefined ? { group } : {}), name, params, raw };
}

/** Reads exactly one vCard. */
export function parseVCard(text: string, o: { maxBytes?: number; maxLines?: number } = {}): VCard {
  const maxBytes = o.maxBytes ?? 1_000_000;
  if (text.length > maxBytes || Buffer.byteLength(text, 'utf8') > maxBytes) throw new BadVCard('too large');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new BadVCard('control characters are not allowed');
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter((l) => l !== '');
  if (lines.length > (o.maxLines ?? 5000)) throw new BadVCard('too many lines');
  if (lines[0]?.toUpperCase() !== 'BEGIN:VCARD') throw new BadVCard('a vCard begins with BEGIN:VCARD');
  if (lines.at(-1)?.toUpperCase() !== 'END:VCARD') throw new BadVCard('a vCard ends with END:VCARD');
  const props: VProp[] = [];
  for (const l of lines.slice(1, -1)) {
    const u = l.slice(0, 6).toUpperCase();
    if (u === 'BEGIN:' || u === 'END:VC') throw new BadVCard('a resource holds one vCard');
    props.push(parseLine(l));
  }
  return { props };
}

const fold = (line: string): string => {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > limit) {
      out.push(cur);
      cur = ' ';
      bytes = 1;
      limit = 75;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
};

export function writeVCard(c: VCard): string {
  const lines = ['BEGIN:VCARD'];
  for (const p of c.props) {
    const ps = Object.entries(p.params)
      .map(([k, vs]) => `;${k}=${vs.map((v) => (/[;:]/.test(v) || (k !== 'TYPE' && v.includes(',')) ? `"${v}"` : v)).join(',')}`)
      .join('');
    lines.push(fold(`${p.group ? `${p.group}.` : ''}${p.name}${ps}:${p.raw}`));
  }
  lines.push('END:VCARD');
  return `${lines.join('\r\n')}\r\n`;
}

/** A card from plain facts, for callers that make contacts rather than read them. */
export function makeCard(f: { uid: string; fn: string; version?: '3.0' | '4.0'; emails?: readonly string[]; tels?: readonly string[]; org?: string; n?: readonly [string, string, string?, string?, string?]; extra?: readonly VProp[] }): string {
  const p = (name: string, raw: string, params: Record<string, readonly string[]> = {}): VProp => ({ name, params, raw });
  const props: VProp[] = [p('VERSION', f.version ?? '4.0')];
  if (f.n) props.push(p('N', f.n.map((x) => escapeText(x ?? '')).join(';')));
  props.push(p('FN', escapeText(f.fn)));
  for (const e of f.emails ?? []) props.push(p('EMAIL', escapeText(e), { TYPE: ['work'] }));
  for (const t of f.tels ?? []) props.push(p('TEL', t, { TYPE: ['cell'] }));
  if (f.org) props.push(p('ORG', escapeText(f.org)));
  props.push(p('UID', f.uid), ...(f.extra ?? []));
  return writeVCard({ props });
}

const first = (c: VCard, name: string) => c.props.find((p) => p.name === name);

// --- the store and the protocol ----------------------------------------------------------------------------------------

export class DavError extends Error {
  readonly status: number;
  readonly precondition: { ns: string; name: string; href?: string } | undefined;
  constructor(status: number, message: string, precondition?: { ns: string; name: string; href?: string }) {
    super(message);
    this.status = status;
    this.precondition = precondition;
  }
}

export interface Resource {
  readonly name: string;
  readonly vcf: string;
  readonly etag: string;
  readonly uid: string;
  readonly version: '3.0' | '4.0';
  readonly modified: number;
}

export interface AddressBook {
  readonly path: string;
  displayName: string;
  description?: string;
  readonly resources: Map<string, Resource>;
  seq: number;
  readonly log: { seq: number; name: string; deleted: boolean }[];
  logFloor: number;
}

export interface Request { readonly method: string; readonly path: string; readonly headers: Readonly<Record<string, string>>; readonly body: string }
export interface Reply { readonly status: number; readonly headers: Record<string, string>; readonly body: string }

export interface CardDavOptions {
  readonly now?: () => number;
  /** Largest card accepted (default 1 MB; RFC 6352 advertises it as max-resource-size). */
  readonly maxResourceBytes?: number;
  /** How many changes each address book remembers for sync (default 1000). */
  readonly logSize?: number;
  /** Where address books live; requests outside it get 404 (default /addressbooks/). */
  readonly base?: string;
  /** Most cards one address book holds (default 50000). */
  readonly maxCards?: number;
}

const etagOf = (s: string) => `"${createHash('sha256').update(s).digest('hex').slice(0, 16)}"`;

type Want = readonly { ns: string; name: string }[] | 'all';

/** The collations RFC 6352 names. Unicode-casemap is a case-insensitive comparison after compatibility folding. */
function collator(name: string | undefined): (s: string) => string {
  const c = name ?? 'i;unicode-casemap';
  if (c === 'i;octet') return (s) => s;
  if (c === 'i;ascii-casemap') return (s) => s.replace(/[a-z]/g, (x) => x.toUpperCase());
  if (c === 'i;unicode-casemap') return (s) => s.normalize('NFKC').toUpperCase().toLowerCase();
  throw new DavError(403, `collation ${c} is not supported`, { ns: CARDDAV, name: 'supported-collation' });
}

export class CardDav {
  readonly #books = new Map<string, AddressBook>();
  readonly #o: Required<CardDavOptions>;

  constructor(o: CardDavOptions = {}) {
    this.#o = { now: o.now ?? Date.now, maxResourceBytes: o.maxResourceBytes ?? 1_000_000, logSize: o.logSize ?? 1000, base: (o.base ?? '/addressbooks/').replace(/\/?$/, '/'), maxCards: o.maxCards ?? 50_000 };
  }

  create(path: string, o: { displayName?: string; description?: string } = {}): AddressBook {
    const p = this.#bookPath(path);
    if (this.#books.has(p)) throw new DavError(405, `${p} already exists`);
    const b: AddressBook = { path: p, displayName: o.displayName ?? p.split('/').filter(Boolean).at(-1)!, ...(o.description ? { description: o.description } : {}), resources: new Map(), seq: 0, log: [], logFloor: 0 };
    this.#books.set(p, b);
    return b;
  }

  book(path: string): AddressBook {
    const b = this.#books.get(this.#bookPath(path));
    if (!b) throw new DavError(404, `no address book at ${path}`);
    return b;
  }

  #bookPath(path: string): string {
    const p = path.endsWith('/') ? path : `${path}/`;
    if (!p.startsWith(this.#o.base) || p.includes('..') || p.includes('//') || p.length > 512 || /[\u0000-\u001f\\]/.test(p)) throw new DavError(404, 'not an address book path');
    return p;
  }

  #split(path: string): { book: AddressBook; name: string | undefined } {
    if (path.endsWith('/')) return { book: this.book(path), name: undefined };
    const i = path.lastIndexOf('/');
    return { book: this.book(path.slice(0, i + 1)), name: path.slice(i + 1) };
  }

  #bump(b: AddressBook, name: string, deleted: boolean) {
    b.seq++;
    b.log.push({ seq: b.seq, name, deleted });
    while (b.log.length > this.#o.logSize) b.logFloor = b.log.shift()!.seq;
  }

  ctag(b: AddressBook): string {
    return `${b.path}@${b.seq}`;
  }
  syncToken(b: AddressBook): string {
    return `urn:carddav-sync:${b.seq}`;
  }

  // --- store ---------------------------------------------------------------------------------------------------

  put(path: string, vcf: string, o: { ifMatch?: string; ifNoneMatch?: string } = {}): { status: 201 | 204; etag: string } {
    const { book, name } = this.#split(path);
    if (!name || !/^[A-Za-z0-9._@=+-]{1,200}\.vcf$/.test(name)) throw new DavError(403, 'a card must be a file ending .vcf with a plain name');
    if (Buffer.byteLength(vcf) > this.#o.maxResourceBytes) throw new DavError(403, `larger than ${this.#o.maxResourceBytes} bytes`, { ns: CARDDAV, name: 'max-resource-size' });
    const cur = book.resources.get(name);
    if (o.ifNoneMatch === '*' && cur) throw new DavError(412, 'the resource exists');
    if (o.ifMatch !== undefined && (!cur || (o.ifMatch !== '*' && o.ifMatch !== cur.etag))) throw new DavError(412, 'the resource has changed');
    if (!cur && book.resources.size >= this.#o.maxCards) throw new DavError(507, `an address book holds at most ${this.#o.maxCards} cards`);
    let card: VCard;
    try {
      card = parseVCard(vcf, { maxBytes: this.#o.maxResourceBytes });
    } catch (e) {
      throw new DavError(403, `not a vCard: ${(e as Error).message}`, { ns: CARDDAV, name: 'supported-address-data' });
    }
    const version = first(card, 'VERSION')?.raw;
    if (version !== '3.0' && version !== '4.0') throw new DavError(403, 'VERSION must be 3.0 or 4.0', { ns: CARDDAV, name: 'supported-address-data' });
    const bad = (why: string) => new DavError(403, why, { ns: CARDDAV, name: 'valid-address-data' });
    if (!first(card, 'FN') || !textOf(first(card, 'FN')!).trim()) throw bad('FN is required');
    const uid = first(card, 'UID')?.raw.trim();
    if (!uid) throw bad('UID is required');
    for (const other of book.resources.values()) if (other.uid === uid && other.name !== name) throw new DavError(403, `UID ${uid} is used by ${other.name}`, { ns: CARDDAV, name: 'no-uid-conflict', href: `${book.path}${other.name}` });
    const r: Resource = { name, vcf, etag: etagOf(vcf), uid, version, modified: this.#o.now() };
    book.resources.set(name, r);
    this.#bump(book, name, false);
    return { status: cur ? 204 : 201, etag: r.etag };
  }

  delete(path: string, o: { ifMatch?: string } = {}): void {
    const { book, name } = this.#split(path);
    if (!name) {
      this.#books.delete(book.path);
      return;
    }
    const cur = book.resources.get(name);
    if (!cur) throw new DavError(404, 'no such card');
    if (o.ifMatch !== undefined && o.ifMatch !== '*' && o.ifMatch !== cur.etag) throw new DavError(412, 'the resource has changed');
    book.resources.delete(name);
    this.#bump(book, name, true);
  }

  get(path: string): Resource {
    const { book, name } = this.#split(path);
    const r = name ? book.resources.get(name) : undefined;
    if (!r) throw new DavError(404, 'no such card');
    return r;
  }

  // --- properties ------------------------------------------------------------------------------------------------

  #bookProps(b: AddressBook, want: Want): { found: Out[]; missing: Out[] } {
    const all: Record<string, Out> = {
      '{DAV:}resourcetype': el(DAV, 'resourcetype', [el(DAV, 'collection'), el(CARDDAV, 'addressbook')]),
      '{DAV:}displayname': el(DAV, 'displayname', b.displayName),
      '{DAV:}sync-token': el(DAV, 'sync-token', this.syncToken(b)),
      [`{${CS}}getctag`]: el(CS, 'getctag', this.ctag(b)),
      [`{${CARDDAV}}supported-address-data`]: el(CARDDAV, 'supported-address-data', ['3.0', '4.0'].map((v) => el(CARDDAV, 'address-data-type', undefined, { 'content-type': 'text/vcard', version: v }))),
      [`{${CARDDAV}}max-resource-size`]: el(CARDDAV, 'max-resource-size', String(this.#o.maxResourceBytes)),
      [`{${CARDDAV}}supported-collation-set`]: el(CARDDAV, 'supported-collation-set', ['i;ascii-casemap', 'i;octet', 'i;unicode-casemap'].map((c) => el(CARDDAV, 'supported-collation', c))),
      '{DAV:}supported-report-set': el(DAV, 'supported-report-set', [el(CARDDAV, 'addressbook-query'), el(CARDDAV, 'addressbook-multiget'), el(DAV, 'sync-collection')].map((r) => el(DAV, 'supported-report', [el(DAV, 'report', [r])]))),
    };
    if (b.description) all[`{${CARDDAV}}addressbook-description`] = el(CARDDAV, 'addressbook-description', b.description);
    if (want === 'all') return { found: Object.values(all), missing: [] };
    const found: Out[] = [];
    const missing: Out[] = [];
    for (const w of want) {
      const o = all[`{${w.ns}}${w.name}`];
      (o ? found : missing).push(o ?? el(w.ns, w.name));
    }
    return { found, missing };
  }

  #resProps(r: Resource, want: Want, data?: El): { found: Out[]; missing: Out[] } {
    const mk = (ns: string, n: string): Out | undefined => {
      if (ns === DAV && n === 'getetag') return el(DAV, 'getetag', r.etag);
      if (ns === DAV && n === 'getcontenttype') return el(DAV, 'getcontenttype', `text/vcard; charset=utf-8; version=${r.version}`);
      if (ns === DAV && n === 'getcontentlength') return el(DAV, 'getcontentlength', String(Buffer.byteLength(r.vcf)));
      if (ns === DAV && n === 'getlastmodified') return el(DAV, 'getlastmodified', new Date(r.modified).toUTCString());
      if (ns === DAV && n === 'resourcetype') return el(DAV, 'resourcetype');
      if (ns === CARDDAV && n === 'address-data') return el(CARDDAV, 'address-data', this.#addressData(r, data));
      return undefined;
    };
    if (want === 'all') return { found: ['getetag', 'getcontenttype', 'getcontentlength', 'getlastmodified', 'resourcetype'].map((n) => mk(DAV, n)!), missing: [] };
    const found: Out[] = [];
    const missing: Out[] = [];
    for (const w of want) {
      const o = mk(w.ns, w.name);
      (o ? found : missing).push(o ?? el(w.ns, w.name));
    }
    return { found, missing };
  }

  /** The card, or only the properties asked for (VERSION is always kept, as the RFC says a vCard must have it). */
  #addressData(r: Resource, spec?: El): string {
    if (!spec) return r.vcf;
    const v = spec.attrs.version;
    if (v !== undefined && v !== r.version) throw new DavError(403, `cannot give version ${v} of a ${r.version} card`, { ns: CARDDAV, name: 'supported-address-data-conversion' });
    if (spec.attrs['content-type'] !== undefined && spec.attrs['content-type'] !== 'text/vcard') throw new DavError(403, 'only text/vcard is available', { ns: CARDDAV, name: 'supported-address-data-conversion' });
    if (child(spec, CARDDAV, 'allprop')) return r.vcf;
    const names = children(spec, CARDDAV, 'prop').map((p) => (p.attrs.name ?? '').toUpperCase());
    if (!names.length) return r.vcf;
    const card = parseVCard(r.vcf);
    return writeVCard({ props: card.props.filter((p) => p.name === 'VERSION' || names.includes(p.name)) });
  }

  // --- filters ---------------------------------------------------------------------------------------------------

  #textMatch(tm: El, value: string): boolean {
    const f = collator(tm.attrs.collation);
    const a = f(value);
    const b = f(tm.text);
    const type = tm.attrs['match-type'] ?? 'contains';
    const hit = type === 'equals' ? a === b : type === 'contains' ? a.includes(b) : type === 'starts-with' ? a.startsWith(b) : type === 'ends-with' ? a.endsWith(b) : undefined;
    if (hit === undefined) throw new DavError(400, `unknown match-type ${type}`);
    return tm.attrs['negate-condition'] === 'yes' ? !hit : hit;
  }

  #matchProp(pf: El, card: VCard): boolean {
    const name = (pf.attrs.name ?? '').toUpperCase();
    const props = card.props.filter((p) => p.name === name);
    if (child(pf, CARDDAV, 'is-not-defined')) return props.length === 0;
    if (props.length === 0) return false;
    const tests = pf.children.filter((c) => c.ns === CARDDAV && (c.name === 'text-match' || c.name === 'param-filter'));
    if (!tests.length) return true;
    const anyOf = (pf.attrs.test ?? 'anyof') === 'anyof';
    return props.some((p) => {
      const results = tests.map((t) => {
        if (t.name === 'text-match') return this.#textMatch(t, textOf(p));
        const pn = (t.attrs.name ?? '').toUpperCase();
        const vals = p.params[pn];
        if (child(t, CARDDAV, 'is-not-defined')) return vals === undefined;
        if (!vals) return false;
        const tm = child(t, CARDDAV, 'text-match');
        return tm ? vals.some((v) => this.#textMatch(tm, v)) : true;
      });
      return anyOf ? results.some(Boolean) : results.every(Boolean);
    });
  }

  #matchFilter(filter: El, r: Resource): boolean {
    const pfs = children(filter, CARDDAV, 'prop-filter');
    if (!pfs.length) return true;
    const card = parseVCard(r.vcf);
    const res = pfs.map((pf) => this.#matchProp(pf, card));
    return (filter.attrs.test ?? 'anyof') === 'allof' ? res.every(Boolean) : res.some(Boolean);
  }

  // --- reports ---------------------------------------------------------------------------------------------------

  report(path: string, body: string): { status: number; body: string } {
    const root = parseXml(body);
    const book = this.book(path);
    const wantOf = (): { want: Want; data: El | undefined } => {
      const p = child(root, DAV, 'prop');
      if (!p) return { want: [{ ns: DAV, name: 'getetag' }], data: undefined };
      return { want: p.children.map((c) => ({ ns: c.ns, name: c.name })), data: child(p, CARDDAV, 'address-data') };
    };
    const respFor = (r: Resource) => {
      const { want, data } = wantOf();
      const { found, missing } = this.#resProps(r, want, data);
      return propstatResponse(`${book.path}${r.name}`, found, missing);
    };
    const multi = (out: Out[]) => ({ status: 207, body: writeXml(el(DAV, 'multistatus', out), PREFIXES) });
    if (root.ns === CARDDAV && root.name === 'addressbook-query') {
      const filter = child(root, CARDDAV, 'filter');
      if (!filter) throw new DavError(400, 'addressbook-query needs a filter');
      const lim = child(root, CARDDAV, 'limit');
      const limit = lim ? Number(child(lim, CARDDAV, 'nresults')?.text.trim()) : Infinity;
      if (lim && (!Number.isInteger(limit) || limit < 0)) throw new DavError(400, 'nresults must be a whole number');
      const hits = [...book.resources.values()].filter((r) => this.#matchFilter(filter, r)).sort((a, b) => (a.name < b.name ? -1 : 1));
      const out = hits.slice(0, limit).map(respFor);
      if (hits.length > limit) out.push(el(DAV, 'response', [el(DAV, 'href', book.path), el(DAV, 'status', 'HTTP/1.1 507 Insufficient Storage'), el(DAV, 'error', [el(DAV, 'number-of-matches-within-limits')])]));
      return multi(out);
    }
    if (root.ns === CARDDAV && root.name === 'addressbook-multiget') {
      const hrefs = children(root, DAV, 'href');
      if (hrefs.length > 1000) throw new DavError(400, 'too many hrefs');
      const out: Out[] = [];
      for (const h of hrefs) {
        let href: string;
        try {
          href = decodeURIComponent(h.text.trim());
        } catch {
          throw new DavError(400, 'a href is not valid');
        }
        const name = href.startsWith(book.path) ? href.slice(book.path.length) : undefined;
        const r = name && !name.includes('/') ? book.resources.get(name) : undefined;
        out.push(r ? respFor(r) : el(DAV, 'response', [el(DAV, 'href', h.text.trim()), el(DAV, 'status', 'HTTP/1.1 404 Not Found')]));
      }
      return multi(out);
    }
    if (root.ns === DAV && root.name === 'sync-collection') return this.#sync(book, root);
    throw new DavError(403, `report ${root.name} is not supported`, { ns: DAV, name: 'supported-report' });
  }

  #sync(book: AddressBook, root: El): { status: number; body: string } {
    const token = child(root, DAV, 'sync-token')?.text.trim() ?? '';
    const m = /^urn:carddav-sync:(\d+)$/.exec(token);
    if (token && !m) throw new DavError(403, 'that sync token was not issued here', { ns: DAV, name: 'valid-sync-token' });
    const since = m ? Number(m[1]) : 0;
    if (since > book.seq || (since > 0 && since < book.logFloor)) throw new DavError(403, 'that sync token is too old or from the future; list the address book again', { ns: DAV, name: 'valid-sync-token' });
    const p = child(root, DAV, 'prop');
    const want = p ? p.children.map((c) => ({ ns: c.ns, name: c.name })) : [{ ns: DAV, name: 'getetag' }];
    const data = p && child(p, CARDDAV, 'address-data');
    const changed = new Map<string, boolean>();
    if (since === 0) for (const n of book.resources.keys()) changed.set(n, false);
    else for (const l of book.log) if (l.seq > since) changed.set(l.name, l.deleted);
    const limitEl = child(root, DAV, 'limit');
    const limit = limitEl ? Number(child(limitEl, DAV, 'nresults')?.text) : Infinity;
    const out: Out[] = [];
    for (const [name, deleted] of [...changed].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (out.length >= limit) throw new DavError(507, 'more changes than the limit; ask again from the returned token', { ns: DAV, name: 'number-of-matches-within-limits' });
      const r = book.resources.get(name);
      if (deleted || !r) {
        out.push(el(DAV, 'response', [el(DAV, 'href', `${book.path}${name}`), el(DAV, 'status', 'HTTP/1.1 404 Not Found')]));
        continue;
      }
      const { found, missing } = this.#resProps(r, want, data || undefined);
      out.push(propstatResponse(`${book.path}${name}`, found, missing));
    }
    return { status: 207, body: writeXml(el(DAV, 'multistatus', [...out, el(DAV, 'sync-token', this.syncToken(book))]), PREFIXES) };
  }

  // --- HTTP ------------------------------------------------------------------------------------------------------

  handle(req: Request): Reply {
    try {
      return this.#handle(req);
    } catch (e) {
      if (e instanceof DavError) {
        const body = e.precondition ? writeXml(el(DAV, 'error', [el(e.precondition.ns, e.precondition.name, e.precondition.href ? [el(DAV, 'href', e.precondition.href)] : undefined)]), PREFIXES) : e.message;
        return { status: e.status, headers: { 'content-type': e.precondition ? 'application/xml; charset=utf-8' : 'text/plain; charset=utf-8' }, body };
      }
      if (e instanceof BadXml || e instanceof BadVCard) return { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: e.message };
      throw e;
    }
  }

  #handle(req: Request): Reply {
    const h = (n: string) => req.headers[n] ?? req.headers[n.toLowerCase()];
    const xml = (status: number, body: string): Reply => ({ status, headers: { 'content-type': 'application/xml; charset=utf-8' }, body });
    const ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT, MKCOL';
    switch (req.method.toUpperCase()) {
      case 'OPTIONS':
        return { status: 200, headers: { dav: '1, 3, addressbook', allow: ALLOW }, body: '' };
      case 'MKCOL': {
        const p = this.#bookPath(req.path);
        let name: string | undefined;
        let desc: string | undefined;
        if (req.body.trim()) {
          const r = parseXml(req.body);
          if (r.ns !== DAV || r.name !== 'mkcol') throw new DavError(400, 'the body is not a mkcol');
          const set = child(r, DAV, 'set');
          const pr = set && child(set, DAV, 'prop');
          const rt = pr && child(pr, DAV, 'resourcetype');
          if (!rt || !child(rt, CARDDAV, 'addressbook')) throw new DavError(403, 'only address books can be made here', { ns: DAV, name: 'valid-resourcetype' });
          name = pr && child(pr, DAV, 'displayname')?.text.trim();
          desc = pr && child(pr, CARDDAV, 'addressbook-description')?.text.trim();
        }
        this.create(p, { ...(name ? { displayName: name.slice(0, 200) } : {}), ...(desc ? { description: desc.slice(0, 2000) } : {}) });
        return { status: 201, headers: { location: p }, body: '' };
      }
      case 'PROPFIND': {
        const { book, name } = this.#splitMaybeRes(req.path);
        const pr = propfindRequest(req.body);
        const want: Want = pr.kind === 'prop' ? pr.props : 'all';
        const d = davDepth(h('depth'), 0);
        if (d === 'infinity') throw new DavError(403, 'Depth: infinity is not allowed', { ns: DAV, name: 'propfind-finite-depth' });
        const out: Out[] = [];
        if (name) {
          const r = book.resources.get(name);
          if (!r) throw new DavError(404, 'no such card');
          const { found, missing } = this.#resProps(r, want);
          out.push(propstatResponse(`${book.path}${name}`, found, missing));
        } else {
          const { found, missing } = this.#bookProps(book, want);
          out.push(propstatResponse(book.path, found, missing));
          if (d === 1) for (const r of [...book.resources.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const f = this.#resProps(r, want);
            out.push(propstatResponse(`${book.path}${r.name}`, f.found, f.missing));
          }
        }
        return xml(207, writeXml(el(DAV, 'multistatus', out), PREFIXES));
      }
      case 'PROPPATCH': {
        const book = this.book(req.path);
        const r = parseXml(req.body);
        if (r.ns !== DAV || r.name !== 'propertyupdate') throw new DavError(400, 'the body is not a propertyupdate');
        const ops: (() => void)[] = [];
        for (const op of r.children) {
          const pr = child(op, DAV, 'prop');
          if (!pr) continue;
          for (const p of pr.children) {
            if (p.ns === DAV && p.name === 'displayname' && op.name === 'set') ops.push(() => void (book.displayName = p.text.trim().slice(0, 200)));
            else if (p.ns === CARDDAV && p.name === 'addressbook-description') ops.push(() => (op.name === 'set' ? void (book.description = p.text.trim().slice(0, 2000)) : void delete book.description));
            else throw new DavError(403, `${p.name} cannot be changed`, { ns: DAV, name: 'cannot-modify-protected-property' });
          }
        }
        for (const f of ops) f();
        return xml(207, writeXml(el(DAV, 'multistatus', [el(DAV, 'response', [el(DAV, 'href', book.path), el(DAV, 'status', 'HTTP/1.1 200 OK')])]), PREFIXES));
      }
      case 'REPORT': {
        const r = this.report(req.path, req.body);
        return xml(r.status, r.body);
      }
      case 'PUT': {
        const ct = (h('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
        if (ct !== 'text/vcard' && ct !== 'text/x-vcard') throw new DavError(415, 'the content type must be text/vcard');
        const r = this.put(req.path, req.body, { ...(h('if-match') ? { ifMatch: h('if-match')! } : {}), ...(h('if-none-match') ? { ifNoneMatch: h('if-none-match')! } : {}) });
        return { status: r.status, headers: { etag: r.etag }, body: '' };
      }
      case 'GET':
      case 'HEAD': {
        const r = this.get(req.path);
        return { status: 200, headers: { etag: r.etag, 'content-type': `text/vcard; charset=utf-8; version=${r.version}` }, body: req.method.toUpperCase() === 'HEAD' ? '' : r.vcf };
      }
      case 'DELETE':
        this.delete(req.path, h('if-match') ? { ifMatch: h('if-match')! } : {});
        return { status: 204, headers: {}, body: '' };
      default:
        return { status: 405, headers: { allow: ALLOW }, body: '' };
    }
  }

  #splitMaybeRes(path: string): { book: AddressBook; name: string | undefined } {
    if (this.#books.has(path.endsWith('/') ? path : `${path}/`) && !path.endsWith('.vcf')) return { book: this.book(path), name: undefined };
    return this.#split(path);
  }
}

function propstatResponse(href: string, found: readonly Out[], missing: readonly Out[]): Out {
  const ps: Out[] = [];
  if (found.length) ps.push(el(DAV, 'propstat', [el(DAV, 'prop', found as Out[]), el(DAV, 'status', 'HTTP/1.1 200 OK')]));
  if (missing.length) ps.push(el(DAV, 'propstat', [el(DAV, 'prop', missing as Out[]), el(DAV, 'status', 'HTTP/1.1 404 Not Found')]));
  return el(DAV, 'response', [el(DAV, 'href', href), ...ps]);
}
