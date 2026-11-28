/**
 * Books and audiobooks as a media server sees them: the EPUB container and what is inside, and OPDS catalogues.
 *
 *  - Reading an EPUB (2 or 3): the zip container, `mimetype`, `META-INF/container.xml`, the OPF package (titles with
 *    subtitle and collection, creators and contributors with role and file-as, identifiers with the ISBN found and
 *    checked, language, publisher, date, subjects, description, series from EPUB 3 collections or calibre meta,
 *    narrator and duration for audiobooks), the manifest and spine, the cover by all three conventions, and the
 *    table of contents from an EPUB 3 nav document or an EPUB 2 NCX. Paths inside the package are resolved and
 *    refused if they climb out of it; sizes are capped and a zip bomb is refused; encryption.xml is read to tell
 *    DRM from font obfuscation. Nothing is rendered.
 *  - Writing an EPUB 3 (with an NCX for old readers) from chapters you give, for exports and for tests.
 *  - OPDS 1.2: navigation and acquisition feeds as Atom, with paging links, facets, acquisition kinds, covers,
 *    thumbnails, series, an OpenSearch description; a reader for catalogues from elsewhere that drops links with
 *    unsafe schemes; and an OPDS 2.0 JSON form of the same feed.
 *
 * Text is escaped with the feed-write block's escapers and XML is read with the dav block's parser, which refuses
 * document type declarations; the one simple HTML5 or NCX doctype EPUB files carry is removed first.
 * Not here: rendering, DRM removal, fonts, media overlays, fixed layouts.
 */
import { escapeAttr, escapeText, rfc3339, toDate } from '../feed-write/index.ts';
import type { DateLike } from '../feed-write/index.ts';
import { parseXml } from '../dav/index.ts';
import type { El } from '../dav/index.ts';
import { ArchiveError, listZip, readZipEntry, zipBuffer } from '../zip-write/index.ts';
import type { ZipEntryInfo } from '../zip-write/index.ts';

export class EpubError extends Error {}
export class OpdsError extends Error {}

const NS = {
  dc: 'http://purl.org/dc/elements/1.1/',
  opf: 'http://www.idpf.org/2007/opf',
  container: 'urn:oasis:names:tc:opendocument:xmlns:container',
  ncx: 'http://www.daisy.org/z3986/2005/ncx/',
  xhtml: 'http://www.w3.org/1999/xhtml',
  ops: 'http://www.idpf.org/2007/ops',
  atom: 'http://www.w3.org/2005/Atom',
  opds: 'http://opds-spec.org/2010/catalog',
  thr: 'http://purl.org/syndication/thread/1.0',
  dcterms: 'http://purl.org/dc/terms/',
  enc: 'http://www.w3.org/2001/04/xmlenc#',
  os: 'http://a9.com/-/spec/opensearch/1.1/',
} as const;

// ---------------------------------------------------------------- small helpers

const kids = (e: El, name: string, ns?: string) => e.children.filter((c) => c.name === name && (ns === undefined || c.ns === ns));
const kid = (e: El, name: string, ns?: string) => e.children.find((c) => c.name === name && (ns === undefined || c.ns === ns));
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const textOf = (e: El): string => e.text + e.children.map(textOf).join('');
const attr = (e: El, name: string, ns?: string) => e.attrs[ns ? `{${ns}}${name}` : name] ?? (ns ? e.attrs[name] : undefined);

/** Removes the plain doctype EPUB files carry; any other (one with an internal subset) is left for the parser to refuse. */
function stripDoctype(xml: string): string {
  return xml.replace(/^﻿/, '').replace(/<!DOCTYPE\s+[^\[>]*>/i, '');
}

function xml(buf: Buffer | string, what: string, maxBytes = 20_000_000): El {
  try {
    return parseXml(stripDoctype(typeof buf === 'string' ? buf : buf.toString('utf8')), { maxBytes, maxDepth: 128 });
  } catch (e) {
    throw new EpubError(`${what} is not well-formed XML: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------- ISBN

export function isValidIsbn10(s: string): boolean {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (10 - i) * (s[i] === 'X' ? 10 : Number(s[i]));
  return sum % 11 === 0;
}

export function isValidIsbn13(s: string): boolean {
  if (!/^97[89]\d{10}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 ? 3 : 1);
  return sum % 10 === 0;
}

/** The ISBN-13 for a valid ISBN-10 or ISBN-13, with hyphens and spaces allowed; undefined if neither. */
export function toIsbn13(raw: string): string | undefined {
  const s = raw.replace(/^urn:isbn:/i, '').replace(/^isbn[:\s]*/i, '').replace(/[\s-]/g, '').toUpperCase();
  if (isValidIsbn13(s)) return s;
  if (!isValidIsbn10(s)) return undefined;
  const core = '978' + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 ? 3 : 1);
  return core + String((10 - (sum % 10)) % 10);
}

// ---------------------------------------------------------------- paths inside the package

/** Resolve an href against the file it appears in. Returns the archive path and the fragment, or `external`. */
export function resolveHref(from: string, href: string): { path: string; fragment?: string } | { external: string } {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { external: href };
  if (href.includes('\\')) throw new EpubError(`${JSON.stringify(href.slice(0, 60))} uses a backslash`);
  const hash = href.indexOf('#');
  let p = hash < 0 ? href : href.slice(0, hash);
  const fragment = hash < 0 ? undefined : href.slice(hash + 1);
  const q = p.indexOf('?');
  if (q >= 0) p = p.slice(0, q);
  try {
    p = decodeURIComponent(p);
  } catch {
    throw new EpubError(`${JSON.stringify(href.slice(0, 60))} is not valid percent-encoding`);
  }
  if (/[\u0000-\u001f]/.test(p)) throw new EpubError('a path has a control character');
  const base = p.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!base.length) throw new EpubError(`${JSON.stringify(href.slice(0, 60))} climbs out of the package`);
      base.pop();
    } else base.push(part);
  }
  return fragment !== undefined ? { path: base.join('/'), fragment } : { path: base.join('/') };
}

// ---------------------------------------------------------------- duration

/** "1:02:03.5", "02:03", "1949.357s", "1h2m3s" or plain seconds, as seconds; undefined if it is none of them. */
export function parseClock(s: string): number | undefined {
  const t = s.trim();
  let m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (m) return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  m = /^(\d+(?:\.\d+)?)\s*(s|ms|min|h)?$/.exec(t);
  if (m) return Number(m[1]) * ({ s: 1, ms: 0.001, min: 60, h: 3600 } as Record<string, number>)[m[2] ?? 's']!;
  m = /^(?:(\d+(?:\.\d+)?)h)?\s*(?:(\d+(?:\.\d+)?)min|(\d+(?:\.\d+)?)m)?\s*(?:(\d+(?:\.\d+)?)s)?$/.exec(t);
  if (m && t) return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  return undefined;
}

// ---------------------------------------------------------------- reading an EPUB

export interface Creator {
  readonly name: string;
  /** "aut", "trl", "ill", "nrt" and the other MARC relators; "aut" for a creator without one. */
  readonly role: string;
  readonly fileAs?: string;
}

export interface Series {
  readonly name: string;
  readonly index?: number;
}

export interface ManifestItem {
  readonly id: string;
  /** Path inside the archive. */
  readonly path: string;
  readonly mediaType: string;
  readonly properties: readonly string[];
  readonly fallback?: string;
}

export interface SpineItem {
  readonly id: string;
  readonly path: string;
  readonly linear: boolean;
}

export interface TocEntry {
  readonly title: string;
  readonly path?: string;
  readonly fragment?: string;
  readonly href?: string;
  readonly children: readonly TocEntry[];
}

export interface Metadata {
  readonly title: string;
  readonly subtitle?: string;
  readonly creators: readonly Creator[];
  readonly contributors: readonly Creator[];
  readonly narrators: readonly string[];
  readonly language?: string;
  readonly languages: readonly string[];
  readonly publisher?: string;
  /** As written, trimmed: "2019", "2019-03" or a full date. */
  readonly date?: string;
  readonly description?: string;
  readonly subjects: readonly string[];
  readonly rights?: string;
  readonly identifiers: readonly { readonly value: string; readonly scheme?: string }[];
  readonly uniqueIdentifier?: string;
  readonly isbn?: string;
  readonly series?: Series;
  readonly modified?: string;
  readonly durationSec?: number;
}

export interface Epub {
  readonly version: string;
  readonly packagePath: string;
  readonly metadata: Metadata;
  readonly manifest: readonly ManifestItem[];
  readonly spine: readonly SpineItem[];
  readonly cover?: ManifestItem;
  readonly toc: readonly TocEntry[];
  readonly tocSource: 'nav' | 'ncx' | 'none';
  /** True if the book's text is protected by DRM (font obfuscation does not count). */
  readonly drm: boolean;
  readonly isAudiobook: boolean;
  readonly warnings: readonly string[];
  /** The bytes of a file in the archive, size-checked. */
  read(path: string): Buffer;
}

export interface EpubLimits {
  readonly maxEntries?: number;
  readonly maxEntryBytes?: number;
  readonly maxTotalBytes?: number;
}

const FONT_ALGS = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);

export function openEpub(zip: Buffer, limits: EpubLimits = {}): Epub {
  let listing: ReturnType<typeof listZip>;
  try {
    listing = listZip(zip);
  } catch (e) {
    if (e instanceof ArchiveError) throw new EpubError(`not a zip file: ${e.message}`);
    throw e;
  }
  const entries = listing.entries.filter((e) => !e.dir);
  if (entries.length > (limits.maxEntries ?? 20_000)) throw new EpubError('the archive has too many files');
  if (listing.entries.reduce((n, e) => n + e.uncompressedSize, 0) > (limits.maxTotalBytes ?? 8 * 2 ** 30)) throw new EpubError('the archive is larger than allowed when unpacked');
  const byName = new Map<string, ZipEntryInfo>();
  for (const e of entries) {
    byName.set(e.name, e);
    if (!byName.has(e.name.normalize('NFC'))) byName.set(e.name.normalize('NFC'), e);
  }
  const maxEntry = limits.maxEntryBytes ?? 50_000_000;
  const warnings: string[] = [];

  const read = (path: string): Buffer => {
    const e = byName.get(path) ?? byName.get(path.normalize('NFC'));
    if (!e) throw new EpubError(`${path} is not in the archive`);
    if (e.uncompressedSize > maxEntry) throw new EpubError(`${path} is larger than ${maxEntry} bytes`);
    if (e.compressedSize > 0 && e.uncompressedSize > 1_000_000 && e.uncompressedSize / e.compressedSize > 1000) throw new EpubError(`${path} expands more than a thousand times`);
    try {
      return readZipEntry(zip, e);
    } catch (err) {
      if (err instanceof ArchiveError || (err as { code?: string }).code?.startsWith('Z_')) throw new EpubError(`${path} is damaged: ${(err as Error).message}`);
      throw err;
    }
  };

  const first = listing.entries[0];
  const mt = byName.get('mimetype');
  if (!mt) throw new EpubError('there is no mimetype file; this is not an EPUB');
  if (read('mimetype').toString('latin1').trim() !== 'application/epub+zip') throw new EpubError('the mimetype is not application/epub+zip');
  if (first?.name !== 'mimetype') warnings.push('mimetype is not the first file in the archive');
  else if (mt.method !== 0) warnings.push('mimetype is compressed; it should be stored');

  if (!byName.has('META-INF/container.xml')) throw new EpubError('there is no META-INF/container.xml');
  const container = xml(read('META-INF/container.xml'), 'container.xml');
  const rootfiles = container.children.flatMap((c) => (c.name === 'rootfiles' ? c.children : [])).filter((c) => c.name === 'rootfile');
  const root = rootfiles.find((r) => attr(r, 'media-type') === 'application/oebps-package+xml') ?? rootfiles[0];
  const full = root ? attr(root, 'full-path') : undefined;
  if (!full) throw new EpubError('container.xml names no package document');
  const pr = resolveHref('x', full);
  if ('external' in pr) throw new EpubError('the package document is not inside the archive');
  const packagePath = pr.path;

  const pkg = xml(read(packagePath), 'the package document');
  if (pkg.name !== 'package') throw new EpubError('the package document does not start with <package>');
  const version = attr(pkg, 'version') ?? '2.0';
  const uidRef = attr(pkg, 'unique-identifier');

  const path = (href: string, from = packagePath): string | undefined => {
    const r = resolveHref(from, href);
    return 'external' in r ? undefined : r.path;
  };

  // ---- manifest and spine
  const manifestEl = kid(pkg, 'manifest');
  if (!manifestEl) throw new EpubError('the package has no manifest');
  const manifest: ManifestItem[] = [];
  const byId = new Map<string, ManifestItem>();
  for (const it of kids(manifestEl, 'item')) {
    const id = attr(it, 'id');
    const href = attr(it, 'href');
    const mediaType = attr(it, 'media-type');
    if (!id || !href || !mediaType) {
      warnings.push('a manifest item lacks id, href or media-type');
      continue;
    }
    if (byId.has(id)) {
      warnings.push(`the manifest id ${id} is used twice`);
      continue;
    }
    const p = path(href);
    if (p === undefined) {
      warnings.push(`the manifest item ${id} is outside the book`);
      continue;
    }
    const item: ManifestItem = { id, path: p, mediaType: mediaType.toLowerCase(), properties: (attr(it, 'properties') ?? '').split(/\s+/).filter(Boolean), ...(attr(it, 'fallback') ? { fallback: attr(it, 'fallback')! } : {}) };
    manifest.push(item);
    byId.set(id, item);
  }
  const spineEl = kid(pkg, 'spine');
  if (!spineEl) throw new EpubError('the package has no spine');
  const spine: SpineItem[] = [];
  for (const r of kids(spineEl, 'itemref')) {
    const m = byId.get(attr(r, 'idref') ?? '');
    if (!m) {
      warnings.push(`the spine names ${JSON.stringify((attr(r, 'idref') ?? '').slice(0, 40))}, which is not in the manifest`);
      continue;
    }
    spine.push({ id: m.id, path: m.path, linear: attr(r, 'linear') !== 'no' });
  }
  if (!spine.length) warnings.push('the spine is empty');

  // ---- metadata
  const md = kid(pkg, 'metadata');
  if (!md) throw new EpubError('the package has no metadata');
  const dc = (n: string) => kids(md, n, NS.dc);
  const metas = kids(md, 'meta');
  const refines = (id: string | undefined, property: string): string[] =>
    id ? metas.filter((m) => attr(m, 'refines')?.replace(/^#/, '') === id && attr(m, 'property') === property).map((m) => squash(textOf(m))).filter(Boolean) : [];
  const meta2 = (name: string) => metas.find((m) => attr(m, 'name') === name)?.attrs.content;

  const titleEls = dc('title');
  const titleOf = (e: El) => squash(textOf(e));
  const typed = (type: string) => titleEls.find((e) => refines(attr(e, 'id'), 'title-type')[0] === type);
  const mainTitle = typed('main') ?? titleEls[0];
  const title = mainTitle ? titleOf(mainTitle) : '';
  if (!title) warnings.push('the book has no title');
  const sub = typed('subtitle');
  const collectionTitle = typed('collection');

  const person = (e: El): Creator => {
    const id = attr(e, 'id');
    const role = (refines(id, 'role')[0] ?? attr(e, 'role', NS.opf) ?? 'aut').toLowerCase();
    const fileAs = refines(id, 'file-as')[0] ?? attr(e, 'file-as', NS.opf);
    return { name: squash(textOf(e)), role, ...(fileAs ? { fileAs } : {}) };
  };
  const creators = dc('creator').map(person).filter((c) => c.name);
  const contributors = dc('contributor').map(person).filter((c) => c.name);
  const narrators = [...contributors.filter((c) => c.role === 'nrt').map((c) => c.name), ...metas.filter((m) => attr(m, 'property') === 'media:narrator' || attr(m, 'name') === 'calibre:narrator' || attr(m, 'name') === 'narrator').map((m) => squash(textOf(m)) || (m.attrs.content ?? ''))].filter(Boolean);

  const ids = dc('identifier').map((e) => {
    const scheme = attr(e, 'scheme', NS.opf) ?? refines(attr(e, 'id'), 'identifier-type')[0];
    return { el: e, value: squash(textOf(e)), ...(scheme ? { scheme } : {}) };
  }).filter((i) => i.value);
  const identifiers = ids.map((i) => ({ value: i.value, ...(i.scheme ? { scheme: i.scheme } : {}) }));
  const uniq = ids.find((i) => uidRef && attr(i.el, 'id') === uidRef);
  let isbn: string | undefined;
  for (const i of ids) {
    const looksIsbn = /isbn/i.test(i.value) || /isbn/i.test(i.scheme ?? '') || /^[\d-]{10,17}[\dXx]?$/.test(i.value);
    if (looksIsbn && (isbn = toIsbn13(i.value))) break;
  }

  let series: Series | undefined;
  const coll = metas.find((m) => attr(m, 'property') === 'belongs-to-collection' && (refines(attr(m, 'id'), 'collection-type')[0] ?? 'series') === 'series');
  if (coll) {
    const pos = Number(refines(attr(coll, 'id'), 'group-position')[0]);
    series = { name: squash(textOf(coll)), ...(Number.isFinite(pos) && refines(attr(coll, 'id'), 'group-position').length ? { index: pos } : {}) };
  } else if (meta2('calibre:series')) {
    const idx = Number(meta2('calibre:series_index'));
    series = { name: squash(meta2('calibre:series')!), ...(meta2('calibre:series_index') !== undefined && Number.isFinite(idx) ? { index: idx } : {}) };
  } else if (collectionTitle) series = { name: titleOf(collectionTitle) };
  if (series && !series.name) series = undefined;

  const total = metas.find((m) => attr(m, 'property') === 'media:duration' && !attr(m, 'refines'));
  const durationSec = total ? parseClock(squash(textOf(total))) : undefined;

  const langs = dc('language').map((e) => squash(textOf(e)).toLowerCase().replace(/_/g, '-')).filter((l) => /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(l));
  const first1 = (n: string) => {
    const e = dc(n)[0];
    const v = e ? squash(textOf(e)) : '';
    return v || undefined;
  };
  const description = dc('description')[0] ? textOf(dc('description')[0]!).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || undefined : undefined;
  const modified = metas.find((m) => attr(m, 'property') === 'dcterms:modified');
  const metadata: Metadata = {
    title,
    ...(sub ? { subtitle: titleOf(sub) } : {}),
    creators, contributors, narrators,
    ...(langs[0] ? { language: langs[0] } : {}), languages: langs,
    ...(first1('publisher') ? { publisher: first1('publisher')! } : {}),
    ...(first1('date') ? { date: first1('date')! } : {}),
    ...(description ? { description } : {}),
    subjects: dc('subject').map((e) => squash(textOf(e))).filter(Boolean),
    ...(first1('rights') ? { rights: first1('rights')! } : {}),
    identifiers, ...(uniq ? { uniqueIdentifier: uniq.value } : {}), ...(isbn ? { isbn } : {}),
    ...(series ? { series } : {}), ...(modified ? { modified: squash(textOf(modified)) } : {}), ...(durationSec !== undefined ? { durationSec } : {}),
  };

  // ---- cover
  let cover = manifest.find((m) => m.properties.includes('cover-image'));
  if (!cover) {
    const id = meta2('cover');
    const m = id ? byId.get(id) : undefined;
    if (m?.mediaType.startsWith('image/')) cover = m;
  }
  if (!cover) {
    const ref = kid(pkg, 'guide') ? kids(kid(pkg, 'guide')!, 'reference').find((r) => attr(r, 'type') === 'cover') : undefined;
    const p = ref && attr(ref, 'href') ? path(attr(ref, 'href')!) : undefined;
    const m = p ? manifest.find((x) => x.path === p) : undefined;
    if (m?.mediaType.startsWith('image/')) cover = m;
  }
  if (!cover) cover = manifest.find((m) => /^cover(-?image)?$/i.test(m.id) && m.mediaType.startsWith('image/'));

  // ---- table of contents
  let toc: TocEntry[] = [];
  let tocSource: Epub['tocSource'] = 'none';
  const navItem = manifest.find((m) => m.properties.includes('nav'));
  const ncxItem = byId.get(attr(spineEl, 'toc') ?? '') ?? manifest.find((m) => m.mediaType === 'application/x-dtbncx+xml');
  try {
    if (navItem && byName.has(navItem.path)) {
      toc = readNav(xml(read(navItem.path), 'the navigation document'), navItem.path);
      tocSource = 'nav';
    }
  } catch (e) {
    warnings.push(String((e as Error).message));
  }
  if (!toc.length && ncxItem && byName.has(ncxItem.path)) {
    try {
      toc = readNcx(xml(read(ncxItem.path), 'the NCX'), ncxItem.path);
      tocSource = 'ncx';
    } catch (e) {
      warnings.push(String((e as Error).message));
    }
  }

  // ---- encryption
  let drm = false;
  if (byName.has('META-INF/encryption.xml')) {
    try {
      const enc = xml(read('META-INF/encryption.xml'), 'encryption.xml');
      for (const d of enc.children.filter((c) => c.name === 'EncryptedData')) {
        const alg = kid(d, 'EncryptionMethod', NS.enc)?.attrs.Algorithm ?? '';
        if (!FONT_ALGS.has(alg)) drm = true;
      }
    } catch (e) {
      warnings.push(String((e as Error).message));
      drm = true;
    }
  }
  if (byName.has('META-INF/rights.xml')) drm = true;

  const audioItems = spine.filter((s) => byId.get(s.id)!.mediaType.startsWith('audio/')).length;
  return { version, packagePath, metadata, manifest, spine, ...(cover ? { cover } : {}), toc, tocSource, drm, isAudiobook: audioItems > 0 || (spine.length > 0 && manifest.filter((m) => m.mediaType.startsWith('audio/')).length > spine.length), warnings, read };
}

const MAX_TOC_DEPTH = 24;

function target(from: string, href: string | undefined): { path?: string; fragment?: string; href?: string } {
  if (!href) return {};
  try {
    const r = resolveHref(from, href);
    return 'external' in r ? { href: r.external } : { path: r.path, ...(r.fragment ? { fragment: r.fragment } : {}) };
  } catch {
    return {};
  }
}

function readNav(doc: El, from: string): TocEntry[] {
  const walk = (el: El, anc: El[]): El | undefined => {
    if (el.name === 'nav' && (attr(el, 'type', NS.ops) ?? '').split(/\s+/).includes('toc')) return el;
    for (const c of el.children) {
      const f = walk(c, anc);
      if (f) return f;
    }
    return undefined;
  };
  const nav = walk(doc, []);
  if (!nav) return [];
  const list = (ol: El, depth: number): TocEntry[] => {
    if (depth > MAX_TOC_DEPTH) return [];
    return kids(ol, 'li').flatMap((li) => {
      const label = li.children.find((c) => c.name === 'a' || c.name === 'span');
      const sub = kid(li, 'ol');
      const title = label ? squash(textOf(label)) : '';
      if (!title && !sub) return [];
      return [{ title, ...(label?.name === 'a' ? target(from, attr(label, 'href')) : {}), children: sub ? list(sub, depth + 1) : [] }];
    });
  };
  const ol = kid(nav, 'ol');
  return ol ? list(ol, 0) : [];
}

function readNcx(doc: El, from: string): TocEntry[] {
  const map = kid(doc, 'navMap');
  if (!map) return [];
  const points = (el: El, depth: number): TocEntry[] =>
    depth > MAX_TOC_DEPTH ? [] : kids(el, 'navPoint').map((p) => {
      const label = kid(p, 'navLabel');
      const text = label ? kid(label, 'text') : undefined;
      return { title: text ? squash(textOf(text)) : '', ...target(from, kid(p, 'content') ? attr(kid(p, 'content')!, 'src') : undefined), children: points(p, depth + 1) };
    });
  return points(map, 0);
}

/** Spine items with the title the table of contents gives them, first entry for a file wins. */
export function chapters(e: Epub): { path: string; title?: string; linear: boolean }[] {
  const titles = new Map<string, string>();
  const walk = (t: readonly TocEntry[]) => {
    for (const x of t) {
      if (x.path && x.title && !titles.has(x.path)) titles.set(x.path, x.title);
      walk(x.children);
    }
  };
  walk(e.toc);
  return e.spine.map((s) => ({ path: s.path, linear: s.linear, ...(titles.has(s.path) ? { title: titles.get(s.path)! } : {}) }));
}

// ---------------------------------------------------------------- writing an EPUB

export interface Chapter {
  readonly title: string;
  /** XHTML that goes inside <body>; it must be well-formed, and is not checked. */
  readonly body: string;
}

export interface NewBook {
  readonly title: string;
  readonly identifier: string;
  readonly language: string;
  readonly creators?: readonly string[];
  readonly publisher?: string;
  readonly description?: string;
  readonly date?: string;
  readonly subjects?: readonly string[];
  readonly series?: Series;
  readonly modified: DateLike;
  readonly chapters: readonly Chapter[];
  readonly cover?: { readonly data: Buffer; readonly mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' };
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
const xhtml = (title: string, body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="${NS.xhtml}" xmlns:epub="${NS.ops}"><head><meta charset="utf-8"/><title>${escapeText(title)}</title></head><body>${body}</body></html>\n`;

export async function buildEpub(b: NewBook): Promise<Buffer> {
  if (!b.title.trim() || !b.identifier.trim() || !/^[a-zA-Z]{2,3}(-[A-Za-z0-9]+)*$/.test(b.language)) throw new EpubError('a book needs a title, an identifier and a language');
  if (!b.chapters.length) throw new EpubError('a book needs at least one chapter');
  const when = toDate(b.modified);
  if (!when) throw new EpubError('modified is not a date');
  const files: { name: string; data: Buffer | string; method?: 'store' | 'deflate' }[] = [
    { name: 'mimetype', data: 'application/epub+zip', method: 'store' },
    { name: 'META-INF/container.xml', data: `<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="${NS.container}"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n` },
  ];
  const manifest: string[] = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
  ];
  const spine: string[] = [];
  b.chapters.forEach((c, i) => {
    const name = `ch${i + 1}.xhtml`;
    files.push({ name: `OEBPS/${name}`, data: xhtml(c.title, c.body) });
    manifest.push(`<item id="ch${i + 1}" href="${name}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="ch${i + 1}"/>`);
  });
  if (b.cover) {
    const name = `cover.${EXT[b.cover.mediaType]}`;
    files.push({ name: `OEBPS/${name}`, data: b.cover.data, method: 'store' });
    manifest.push(`<item id="cover-image" href="${name}" media-type="${b.cover.mediaType}" properties="cover-image"/>`);
  }
  const md = [
    `<dc:identifier id="uid">${escapeText(b.identifier)}</dc:identifier>`,
    `<dc:title>${escapeText(b.title)}</dc:title>`,
    `<dc:language>${escapeText(b.language)}</dc:language>`,
    ...(b.creators ?? []).map((c) => `<dc:creator>${escapeText(c)}</dc:creator>`),
    ...(b.publisher ? [`<dc:publisher>${escapeText(b.publisher)}</dc:publisher>`] : []),
    ...(b.date ? [`<dc:date>${escapeText(b.date)}</dc:date>`] : []),
    ...(b.description ? [`<dc:description>${escapeText(b.description)}</dc:description>`] : []),
    ...(b.subjects ?? []).map((s) => `<dc:subject>${escapeText(s)}</dc:subject>`),
    ...(b.series ? [`<meta property="belongs-to-collection" id="series">${escapeText(b.series.name)}</meta>`, '<meta refines="#series" property="collection-type">series</meta>', ...(b.series.index !== undefined ? [`<meta refines="#series" property="group-position">${b.series.index}</meta>`] : [])] : []),
    `<meta property="dcterms:modified">${rfc3339(when)}</meta>`,
  ];
  files.push({ name: 'OEBPS/content.opf', data: `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="${NS.opf}" version="3.0" unique-identifier="uid"><metadata xmlns:dc="${NS.dc}">${md.join('')}</metadata><manifest>${manifest.join('')}</manifest><spine toc="ncx">${spine.join('')}</spine></package>\n` });
  const li = b.chapters.map((c, i) => `<li><a href="ch${i + 1}.xhtml">${escapeText(c.title)}</a></li>`).join('');
  files.push({ name: 'OEBPS/nav.xhtml', data: xhtml(b.title, `<nav epub:type="toc"><ol>${li}</ol></nav>`) });
  const points = b.chapters.map((c, i) => `<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${escapeText(c.title)}</text></navLabel><content src="ch${i + 1}.xhtml"/></navPoint>`).join('');
  files.push({ name: 'OEBPS/toc.ncx', data: `<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="${NS.ncx}" version="2005-1"><head><meta name="dtb:uid" content="${escapeAttr(b.identifier)}"/></head><docTitle><text>${escapeText(b.title)}</text></docTitle><navMap>${points}</navMap></ncx>\n` });
  return zipBuffer(files.map((f) => ({ name: f.name, data: f.data, method: f.method ?? 'deflate', mtime: when })), { now: when });
}

// ---------------------------------------------------------------- OPDS 1.2

export const OPDS_NAV = 'application/atom+xml;profile=opds-catalog;kind=navigation';
export const OPDS_ACQ = 'application/atom+xml;profile=opds-catalog;kind=acquisition';

export type AcquisitionKind = 'open-access' | 'generic' | 'borrow' | 'buy' | 'sample' | 'subscribe';

const ACQ_REL: Record<AcquisitionKind, string> = {
  'open-access': 'http://opds-spec.org/acquisition/open-access',
  generic: 'http://opds-spec.org/acquisition',
  borrow: 'http://opds-spec.org/acquisition/borrow',
  buy: 'http://opds-spec.org/acquisition/buy',
  sample: 'http://opds-spec.org/acquisition/sample',
  subscribe: 'http://opds-spec.org/acquisition/subscribe',
};

export interface Acquisition {
  readonly href: string;
  readonly type: string;
  readonly kind?: AcquisitionKind;
  readonly length?: number;
  readonly price?: { readonly value: string; readonly currency: string };
}

export interface BookEntry {
  readonly id: string;
  readonly title: string;
  readonly updated: DateLike;
  readonly authors?: readonly { name: string; uri?: string }[];
  readonly summary?: string;
  readonly categories?: readonly string[];
  readonly language?: string;
  readonly publisher?: string;
  readonly issued?: string;
  readonly identifiers?: readonly string[];
  readonly acquisitions: readonly Acquisition[];
  readonly cover?: string;
  readonly thumbnail?: string;
  readonly series?: Series & { readonly href?: string };
  /** Page for the entry itself. */
  readonly detail?: string;
}

export interface NavEntry {
  readonly id: string;
  readonly title: string;
  readonly updated: DateLike;
  readonly href: string;
  readonly kind?: 'navigation' | 'acquisition';
  readonly content?: string;
  /** "popular", "new" and the other rels OPDS defines, as a full rel URL or short name. */
  readonly rel?: string;
  readonly count?: number;
}

export interface Facet {
  readonly title: string;
  readonly href: string;
  readonly group: string;
  readonly active?: boolean;
  readonly count?: number;
}

export interface FeedHead {
  readonly id: string;
  readonly title: string;
  readonly updated: DateLike;
  readonly self: string;
  readonly start?: string;
  readonly up?: string;
  readonly search?: string;
  readonly author?: string;
  readonly icon?: string;
}

export interface Paging {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly href: (page: number) => string;
}

/** Only http, https, relative and (for acquisition) data-free hrefs: a catalogue link never runs script. */
export function safeHref(h: string): string {
  const v = h.trim();
  if (!v || /[\u0000-\u001f\u007f\s]/.test(v)) throw new OpdsError(`${JSON.stringify(h.slice(0, 60))} is not a usable link`);
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'https') throw new OpdsError(`${JSON.stringify(h.slice(0, 60))} uses the scheme ${scheme}`);
  return v;
}

const when = (v: DateLike): string => {
  const d = toDate(v);
  if (!d) throw new OpdsError('a date is not valid');
  return rfc3339(d);
};
const link = (rel: string | undefined, href: string, type?: string, extra = '') => `<link${rel ? ` rel="${escapeAttr(rel)}"` : ''} href="${escapeAttr(safeHref(href))}"${type ? ` type="${escapeAttr(type)}"` : ''}${extra}/>`;

/** The paging links and the OpenSearch counts for a page. Pages count from 1; out-of-range is an error. */
export function pageLinks(p: Paging): { rel: string; href: string }[] {
  if (!Number.isInteger(p.page) || p.page < 1 || p.pageSize < 1 || p.total < 0) throw new OpdsError('bad paging');
  const last = Math.max(1, Math.ceil(p.total / p.pageSize));
  if (p.page > last) throw new OpdsError('that page is past the end');
  const out = [{ rel: 'first', href: p.href(1) }];
  if (p.page > 1) out.push({ rel: 'previous', href: p.href(p.page - 1) });
  if (p.page < last) out.push({ rel: 'next', href: p.href(p.page + 1) });
  out.push({ rel: 'last', href: p.href(last) });
  return out;
}

function head(kind: 'navigation' | 'acquisition', h: FeedHead, p?: Paging): string[] {
  if (!h.id.trim() || !h.title.trim()) throw new OpdsError('a feed needs an id and a title');
  const out = [
    `<id>${escapeText(h.id)}</id>`, `<title>${escapeText(h.title)}</title>`, `<updated>${when(h.updated)}</updated>`,
    ...(h.author ? [`<author><name>${escapeText(h.author)}</name></author>`] : []),
    ...(h.icon ? [`<icon>${escapeText(safeHref(h.icon))}</icon>`] : []),
    link('self', h.self, kind === 'navigation' ? OPDS_NAV : OPDS_ACQ),
    ...(h.start ? [link('start', h.start, OPDS_NAV)] : []),
    ...(h.up ? [link('up', h.up, OPDS_NAV)] : []),
    ...(h.search ? [link('search', h.search, 'application/opensearchdescription+xml')] : []),
  ];
  if (p) {
    for (const l of pageLinks(p)) out.push(link(l.rel, l.href, OPDS_ACQ));
    out.push(`<opensearch:totalResults>${p.total}</opensearch:totalResults>`, `<opensearch:itemsPerPage>${p.pageSize}</opensearch:itemsPerPage>`, `<opensearch:startIndex>${(p.page - 1) * p.pageSize + 1}</opensearch:startIndex>`);
  }
  return out;
}

const FEED_OPEN = `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="${NS.atom}" xmlns:dc="${NS.dc}" xmlns:opds="${NS.opds}" xmlns:thr="${NS.thr}" xmlns:dcterms="${NS.dcterms}" xmlns:opensearch="${NS.os}">`;

export function navigationFeed(h: FeedHead, entries: readonly NavEntry[]): string {
  const body = entries.map((e) => {
    const t = e.kind === 'acquisition' ? OPDS_ACQ : OPDS_NAV;
    const rel = e.rel ? (e.rel.includes(':') ? e.rel : `http://opds-spec.org/sort/${e.rel}`) : undefined;
    return `<entry><title>${escapeText(e.title)}</title><id>${escapeText(e.id)}</id><updated>${when(e.updated)}</updated>${e.content ? `<content type="text">${escapeText(e.content)}</content>` : ''}${link(rel, e.href, t, e.count !== undefined ? ` thr:count="${e.count}"` : '')}</entry>`;
  });
  return `${FEED_OPEN}${head('navigation', h).join('')}${body.join('')}</feed>\n`;
}

export function acquisitionFeed(h: FeedHead, entries: readonly BookEntry[], o: { paging?: Paging; facets?: readonly Facet[] } = {}): string {
  const facets = (o.facets ?? []).map((f) => link('http://opds-spec.org/facet', f.href, OPDS_ACQ, ` title="${escapeAttr(f.title)}" opds:facetGroup="${escapeAttr(f.group)}"${f.active ? ' opds:activeFacet="true"' : ''}${f.count !== undefined ? ` thr:count="${f.count}"` : ''}`));
  return `${FEED_OPEN}${head('acquisition', h, o.paging).join('')}${facets.join('')}${entries.map(bookXml).join('')}</feed>\n`;
}

function bookXml(b: BookEntry): string {
  if (!b.id.trim() || !b.title.trim()) throw new OpdsError('an entry needs an id and a title');
  if (!b.acquisitions.length) throw new OpdsError(`${JSON.stringify(b.title.slice(0, 40))} has nothing to download`);
  const out = [`<title>${escapeText(b.title)}</title>`, `<id>${escapeText(b.id)}</id>`, `<updated>${when(b.updated)}</updated>`];
  for (const a of b.authors ?? []) out.push(`<author><name>${escapeText(a.name)}</name>${a.uri ? `<uri>${escapeText(safeHref(a.uri))}</uri>` : ''}</author>`);
  if (b.language) out.push(`<dc:language>${escapeText(b.language)}</dc:language>`);
  if (b.publisher) out.push(`<dc:publisher>${escapeText(b.publisher)}</dc:publisher>`);
  if (b.issued) out.push(`<dcterms:issued>${escapeText(b.issued)}</dcterms:issued>`);
  for (const i of b.identifiers ?? []) out.push(`<dc:identifier>${escapeText(i)}</dc:identifier>`);
  for (const c of b.categories ?? []) out.push(`<category term="${escapeAttr(c)}" label="${escapeAttr(c)}"/>`);
  if (b.summary) out.push(`<summary type="text">${escapeText(b.summary)}</summary>`);
  if (b.cover) out.push(link('http://opds-spec.org/image', b.cover, guessImage(b.cover)));
  if (b.thumbnail) out.push(link('http://opds-spec.org/image/thumbnail', b.thumbnail, guessImage(b.thumbnail)));
  if (b.detail) out.push(link('alternate', b.detail, OPDS_ACQ.replace('kind=acquisition', 'type=entry;kind=acquisition')));
  if (b.series) out.push(link('related', b.series.href ?? '#', OPDS_ACQ, ` title="${escapeAttr(b.series.name)}${b.series.index !== undefined ? ` #${b.series.index}` : ''}"`));
  for (const a of b.acquisitions) {
    const price = a.price ? `<opds:price currencycode="${escapeAttr(a.price.currency)}">${escapeText(a.price.value)}</opds:price>` : '';
    const l = link(ACQ_REL[a.kind ?? 'generic'], a.href, a.type, a.length !== undefined ? ` length="${a.length}"` : '');
    out.push(price ? l.replace(/\/>$/, `>${price}</link>`) : l);
  }
  return `<entry>${out.join('')}</entry>`;
}

function guessImage(href: string): string {
  const e = /\.(jpe?g|png|gif|webp)(?:[?#].*)?$/i.exec(href)?.[1]?.toLowerCase();
  return e === 'png' ? 'image/png' : e === 'gif' ? 'image/gif' : e === 'webp' ? 'image/webp' : 'image/jpeg';
}

/** The OpenSearch description a catalogue's `search` link points at. `template` must hold {searchTerms}. */
export function openSearchDescription(shortName: string, template: string): string {
  if (!template.includes('{searchTerms}')) throw new OpdsError('the template needs {searchTerms}');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><ShortName>${escapeText(shortName)}</ShortName><Description>${escapeText(`Search ${shortName}`)}</Description><InputEncoding>UTF-8</InputEncoding><Url type="${escapeAttr(OPDS_ACQ)}" template="${escapeAttr(safeHref(template))}"/></OpenSearchDescription>\n`;
}

/** A catalogue entry for a book on disk. */
export function entryFromEpub(e: Epub, o: { id: string; updated: DateLike; downloadHref: string; length?: number; coverHref?: string; thumbnailHref?: string }): BookEntry {
  const m = e.metadata;
  return {
    id: o.id, title: m.subtitle ? `${m.title}: ${m.subtitle}` : m.title, updated: o.updated,
    authors: m.creators.filter((c) => c.role === 'aut').map((c) => ({ name: c.name })),
    ...(m.description ? { summary: m.description } : {}), categories: m.subjects, ...(m.language ? { language: m.language } : {}),
    ...(m.publisher ? { publisher: m.publisher } : {}), ...(m.date ? { issued: m.date } : {}),
    identifiers: [...(m.isbn ? [`urn:isbn:${m.isbn}`] : []), ...(m.uniqueIdentifier && !m.isbn ? [m.uniqueIdentifier] : [])],
    acquisitions: [{ href: o.downloadHref, type: 'application/epub+zip', kind: 'generic', ...(o.length !== undefined ? { length: o.length } : {}) }],
    ...(o.coverHref ? { cover: o.coverHref } : {}), ...(o.thumbnailHref ? { thumbnail: o.thumbnailHref } : {}), ...(m.series ? { series: m.series } : {}),
  };
}

// ---------------------------------------------------------------- reading OPDS

export interface OpdsLink {
  readonly rel: string;
  readonly href: string;
  readonly type?: string;
  readonly title?: string;
  readonly length?: number;
  readonly facetGroup?: string;
  readonly active?: boolean;
  readonly count?: number;
}

export interface OpdsEntry {
  readonly id: string;
  readonly title: string;
  readonly updated?: string;
  readonly authors: readonly string[];
  readonly summary?: string;
  readonly categories: readonly string[];
  readonly links: readonly OpdsLink[];
  /** True when it has an acquisition link, so it is a book and not a shelf. */
  readonly isBook: boolean;
}

export interface OpdsFeed {
  readonly kind: 'navigation' | 'acquisition';
  readonly id: string;
  readonly title: string;
  readonly links: readonly OpdsLink[];
  readonly entries: readonly OpdsEntry[];
  readonly next?: string;
  readonly totalResults?: number;
  readonly dropped: number;
}

/** Read a catalogue. `base` is the URL it came from, for relative links; links that are not http(s) are dropped and counted. */
export function parseOpds(body: string, base: string, o: { maxBytes?: number } = {}): OpdsFeed {
  let root: El;
  try {
    root = parseXml(body, { maxBytes: o.maxBytes ?? 10_000_000, maxDepth: 32 });
  } catch (e) {
    throw new OpdsError(`not a catalogue: ${(e as Error).message}`);
  }
  if (root.ns !== NS.atom || root.name !== 'feed') throw new OpdsError('not an Atom feed');
  let dropped = 0;
  const links = (e: El): OpdsLink[] =>
    kids(e, 'link', NS.atom).flatMap((l) => {
      const href = l.attrs.href;
      if (!href) return [];
      let url: URL;
      try {
        url = new URL(href, base);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('scheme');
      } catch {
        dropped++;
        return [];
      }
      const len = Number(l.attrs.length);
      const count = Number(attr(l, 'count', NS.thr));
      const grp = attr(l, 'facetGroup', NS.opds);
      return [{ rel: l.attrs.rel ?? 'alternate', href: url.href, ...(l.attrs.type ? { type: l.attrs.type } : {}), ...(l.attrs.title ? { title: l.attrs.title } : {}), ...(l.attrs.length && Number.isFinite(len) ? { length: len } : {}), ...(grp ? { facetGroup: grp } : {}), ...(attr(l, 'activeFacet', NS.opds) === 'true' ? { active: true } : {}), ...(attr(l, 'count', NS.thr) !== undefined && Number.isFinite(count) ? { count } : {}) }];
    });
  const entries: OpdsEntry[] = kids(root, 'entry', NS.atom).map((e) => {
    const ls = links(e);
    const text = (n: string) => {
      const x = kid(e, n, NS.atom);
      return x ? squash(textOf(x)) : undefined;
    };
    const summary = text('summary') ?? text('content');
    return {
      id: text('id') ?? '', title: text('title') ?? '', ...(text('updated') ? { updated: text('updated')! } : {}),
      authors: kids(e, 'author', NS.atom).map((a) => squash(textOf(kid(a, 'name', NS.atom) ?? a))).filter(Boolean),
      ...(summary ? { summary } : {}), categories: kids(e, 'category', NS.atom).map((c) => c.attrs.label ?? c.attrs.term ?? '').filter(Boolean), links: ls,
      isBook: ls.some((l) => l.rel.startsWith('http://opds-spec.org/acquisition')),
    };
  });
  const fl = links(root);
  const self = fl.find((l) => l.rel === 'self');
  const kindParam = /kind=(navigation|acquisition)/.exec(self?.type ?? '')?.[1];
  const kind = kindParam === 'navigation' || kindParam === 'acquisition' ? kindParam : entries.some((e) => e.isBook) ? 'acquisition' : 'navigation';
  const total = kid(root, 'totalResults', NS.os);
  const n = total ? Number(squash(textOf(total))) : NaN;
  const nextLink = fl.find((l) => l.rel === 'next');
  const idEl = kid(root, 'id', NS.atom);
  return { kind, id: idEl ? squash(textOf(idEl)) : '', title: kid(root, 'title', NS.atom) ? squash(textOf(kid(root, 'title', NS.atom)!)) : '', links: fl, entries, ...(nextLink ? { next: nextLink.href } : {}), ...(Number.isFinite(n) ? { totalResults: n } : {}), dropped };
}

// ---------------------------------------------------------------- OPDS 2.0

export interface Opds2 {
  readonly metadata: { title: string; numberOfItems?: number; itemsPerPage?: number; currentPage?: number };
  readonly links: { rel: string; href: string; type: string }[];
  readonly navigation?: { title: string; href: string; type: string; rel?: string }[];
  readonly publications?: { metadata: Record<string, unknown>; links: { rel: string; href: string; type: string; properties?: Record<string, unknown> }[]; images?: { href: string; type: string }[] }[];
  readonly facets?: { metadata: { title: string }; links: { title: string; href: string; type: string; properties?: { numberOfItems: number } }[] }[];
}

/** The JSON (OPDS 2.0) form of a navigation list or a page of books. */
export function opds2(h: FeedHead, o: { nav?: readonly NavEntry[]; books?: readonly BookEntry[]; paging?: Paging; facets?: readonly Facet[] }): Opds2 {
  const json = 'application/opds+json';
  const rels = o.paging ? pageLinks(o.paging).map((l) => ({ rel: l.rel === 'previous' ? 'previous' : l.rel, href: safeHref(l.href), type: json })) : [];
  const groups = new Map<string, Facet[]>();
  for (const f of o.facets ?? []) groups.set(f.group, [...(groups.get(f.group) ?? []), f]);
  return {
    metadata: { title: h.title, ...(o.paging ? { numberOfItems: o.paging.total, itemsPerPage: o.paging.pageSize, currentPage: o.paging.page } : {}) },
    links: [{ rel: 'self', href: safeHref(h.self), type: json }, ...rels],
    ...(o.nav ? { navigation: o.nav.map((n) => ({ title: n.title, href: safeHref(n.href), type: json, ...(n.rel ? { rel: n.rel } : {}) })) } : {}),
    ...(o.books ? {
      publications: o.books.map((b) => ({
        metadata: { '@type': 'http://schema.org/Book', identifier: b.id, title: b.title, modified: when(b.updated), ...(b.authors?.length ? { author: b.authors.map((a) => a.name) } : {}), ...(b.language ? { language: b.language } : {}), ...(b.publisher ? { publisher: b.publisher } : {}), ...(b.summary ? { description: b.summary } : {}), ...(b.categories?.length ? { subject: [...b.categories] } : {}), ...(b.series ? { belongsTo: { series: { name: b.series.name, ...(b.series.index !== undefined ? { position: b.series.index } : {}) } } } : {}) },
        links: b.acquisitions.map((a) => ({ rel: ACQ_REL[a.kind ?? 'generic'], href: safeHref(a.href), type: a.type, ...(a.length !== undefined ? { properties: { length: a.length } } : {}) })),
        ...(b.cover || b.thumbnail ? { images: [...(b.cover ? [{ href: safeHref(b.cover), type: guessImage(b.cover) }] : []), ...(b.thumbnail ? [{ href: safeHref(b.thumbnail), type: guessImage(b.thumbnail) }] : [])] } : {}),
      })),
    } : {}),
    ...(groups.size ? { facets: [...groups].map(([title, fs]) => ({ metadata: { title }, links: fs.map((f) => ({ title: f.title, href: safeHref(f.href), type: json, ...(f.count !== undefined ? { properties: { numberOfItems: f.count } } : {}) })) })) } : {}),
  };
}
