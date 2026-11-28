/**
 * A library of media assets: folders (a tree that cannot loop, with names that cannot collide), assets whose real
 * format and pixel size are read from their first bytes (PNG, JPEG, GIF, WebP, AVIF, SVG, PDF, MP4, WebM, MP3;
 * never from the file name), a focal point per image, planned derivatives (a named preset says how an image is
 * cropped around its focal point and sized, never enlarged, with a key that changes when the file or the focal
 * point does, so a cache never serves a stale crop), responsive width sets, format negotiation from an Accept
 * header, usage tracking (which document uses which asset, replaced as a set when a document is saved, so deleting
 * an asset in use is refused with the list), duplicate detection by SHA-256, and an alt text report: coverage per
 * language, decorative images that must have no alt, and weak alt text (the file name, "image of ...", too long).
 *
 * Active content is refused by default: an SVG with scripts, event handlers, foreign objects or external references
 * does not enter the library, and a file whose bytes say one format while its name or claimed type says another is
 * refused.
 *
 * Out of scope: making the derivative pictures (this plans them: the source crop box, output size and key), and
 * storing the bytes (see objects); the library keeps what is known about each file.
 */
import { createHash } from 'node:crypto';

export class MediaError extends Error {
  constructor(message: string) {
    super(message);
  }
}
export class InUse extends MediaError {
  readonly usages: readonly Usage[];
  constructor(usages: readonly Usage[]) {
    super(`the asset is used by ${usages.map((u) => `${u.kind} ${u.id}`).join(', ')}`);
    this.usages = usages;
  }
}

// ================================================================== reading the bytes

export interface Sniffed {
  readonly mime: string;
  readonly ext: string;
  readonly width?: number;
  readonly height?: number;
}

const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, i: number) => (((b[i] ?? 0) * 2 ** 24) + (((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)));
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
const MAX_DIMENSION = 65_535;

function sized(mime: string, ext: string, w: number, h: number): Sniffed {
  if (w < 1 || h < 1 || w > MAX_DIMENSION * 4 || h > MAX_DIMENSION * 4) return { mime, ext };
  return { mime, ext, width: w, height: h };
}

/** What the bytes really are, from their start. Returns undefined for anything not recognised. */
export function sniff(bytes: Uint8Array): Sniffed | undefined {
  const b = bytes;
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return ascii(b, 12, 4) === 'IHDR' ? sized('image/png', 'png', u32be(b, 16), u32be(b, 20)) : { mime: 'image/png', ext: 'png' };
  }
  if (b.length >= 10 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return sized('image/gif', 'gif', u16le(b, 6), u16le(b, 8));
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1]!;
      if (m === 0xff) {
        i++;
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2;
        continue;
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return sized('image/jpeg', 'jpg', u16be(b, i + 7), u16be(b, i + 5));
      const len = u16be(b, i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (b.length >= 16 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const kind = ascii(b, 12, 4);
    if (kind === 'VP8X' && b.length >= 30) return sized('image/webp', 'webp', u24le(b, 24) + 1, u24le(b, 27) + 1);
    if (kind === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return sized('image/webp', 'webp', u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
    if (kind === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
      const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
      return sized('image/webp', 'webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    return { mime: 'image/webp', ext: 'webp' };
  }
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (brand === 'avif' || brand === 'avis') {
      const text = ascii(b, 0, Math.min(b.length, 4096));
      const at = text.indexOf('ispe');
      return at >= 0 && at + 16 <= b.length ? sized('image/avif', 'avif', u32be(b, at + 8), u32be(b, at + 12)) : { mime: 'image/avif', ext: 'avif' };
    }
    return { mime: 'video/mp4', ext: 'mp4' };
  }
  if (b.length >= 5 && ascii(b, 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: 'video/webm', ext: 'webm' };
  if (b.length >= 3 && (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0))) return { mime: 'audio/mpeg', ext: 'mp3' };
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, Math.min(b.length, 2048))).replace(/^﻿/, '').trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return { mime: 'image/svg+xml', ext: 'svg', ...svgSize(head) };
  return undefined;
}

function svgSize(head: string): { width?: number; height?: number } {
  const tag = /<svg\b[^>]*>/i.exec(head)?.[0] ?? '';
  const num = (n: string) => {
    const m = new RegExp(`\\b${n}\\s*=\\s*["']\\s*([0-9.]+)(?:px)?\\s*["']`, 'i').exec(tag);
    return m ? Math.round(Number(m[1])) : undefined;
  };
  const w = num('width');
  const h = num('height');
  if (w && h) return { width: w, height: h };
  const vb = /viewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i.exec(tag);
  return vb ? { width: Math.round(Number(vb[1])), height: Math.round(Number(vb[2])) } : {};
}

/** Why an SVG could run code or fetch things, or undefined when it is plain drawing. */
export function svgDanger(svg: string): string | undefined {
  if (/<!ENTITY/i.test(svg)) return 'it declares entities';
  if (/<\s*script\b/i.test(svg)) return 'it contains a script';
  if (/<\s*foreignObject\b/i.test(svg)) return 'it embeds foreign content';
  if (/\son[a-z]+\s*=/i.test(svg)) return 'it has an event handler';
  if (/(?:href|src)\s*=\s*["']\s*(?:javascript|data:text\/html|vbscript)/i.test(svg)) return 'it links to script';
  if (/(?:xlink:)?href\s*=\s*["']\s*(?:https?:)?\/\//i.test(svg)) return 'it refers to another site';
  if (/url\(\s*["']?\s*(?:https?:)?\/\//i.test(svg)) return 'it loads a style or image from another site';
  if (/<\s*(?:iframe|embed|object)\b/i.test(svg)) return 'it embeds a page or plug-in';
  return undefined;
}

// ================================================================== names

const BAD_NAME = /[\u0000-\u001f\u007f/\\:*?"<>|]/;
export function cleanName(name: string): string {
  const n = name.normalize('NFC').trim();
  if (!n || n.length > 200) throw new MediaError('a name must be 1 to 200 characters');
  if (BAD_NAME.test(n)) throw new MediaError(`"${n.slice(0, 40)}" has a character a file name cannot have`);
  if (n === '.' || n === '..' || /^\.+$/.test(n) || /[. ]$/.test(n)) throw new MediaError(`"${n.slice(0, 40)}" is not a usable name`);
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(n)) throw new MediaError(`"${n}" is a reserved name`);
  return n;
}

// ================================================================== model

export interface Folder {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string;
}

export interface Focal {
  /** From 0 (left) to 1 (right), and 0 (top) to 1 (bottom). */
  readonly x: number;
  readonly y: number;
}

export interface Asset {
  readonly id: string;
  readonly name: string;
  readonly folderId?: string;
  readonly mime: string;
  readonly ext: string;
  readonly size: number;
  readonly sha256: string;
  readonly width?: number;
  readonly height?: number;
  readonly focal: Focal;
  /** Alt text by language; an empty text with `decorative` is deliberate. */
  readonly alt: Readonly<Record<string, string>>;
  readonly decorative: boolean;
  readonly title?: string;
  readonly caption?: string;
  readonly tags: readonly string[];
  /** Goes up each time the file is replaced. */
  readonly revision: number;
  readonly createdAt: number;
  readonly modifiedAt: number;
}

export interface Usage {
  readonly kind: string;
  readonly id: string;
  readonly field?: string;
}

export interface LibraryOptions {
  readonly newId: () => string;
  readonly now?: () => number;
  /** Largest file accepted, in bytes. Default 50 MiB. */
  readonly maxBytes?: number;
  /** Mime types accepted; default every kind this block can recognise. */
  readonly allowed?: readonly string[];
  /** Allow SVG that would normally be refused. Default false. */
  readonly allowActiveSvg?: boolean;
}

export interface UploadInput {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly folderId?: string;
  /** What the browser claimed; a different real type is refused. */
  readonly claimedMime?: string;
  readonly alt?: Readonly<Record<string, string>>;
  readonly decorative?: boolean;
  readonly tags?: readonly string[];
}

const IMAGE = (mime: string) => mime.startsWith('image/');
const ALL_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml', 'application/pdf', 'video/mp4', 'video/webm', 'audio/mpeg'];
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const keyOf = (u: Usage) => `${u.kind}\u0000${u.id}\u0000${u.field ?? ''}`;
const lower = (s: string) => s.normalize('NFC').toLowerCase();

export class Library {
  private readonly o: Required<Pick<LibraryOptions, 'newId' | 'maxBytes'>> & LibraryOptions;
  private readonly folders = new Map<string, Folder>();
  private readonly assets = new Map<string, Asset>();
  /** Which usages each document holds, by "kind\0id" then assets. */
  private readonly uses = new Map<string, { readonly usage: Usage; readonly assets: ReadonlySet<string> }[]>();

  constructor(o: LibraryOptions) {
    this.o = { maxBytes: 50 * 1024 * 1024, ...o };
  }

  private now = () => (this.o.now ? this.o.now() : Date.now());

  // ------------------------------------------------------------ folders

  createFolder(name: string, parentId?: string): Folder {
    const n = cleanName(name);
    if (parentId !== undefined && !this.folders.has(parentId)) throw new MediaError(`no folder ${parentId}`);
    this.freeInFolder(parentId, n);
    const f: Folder = { id: this.o.newId(), name: n, ...(parentId !== undefined ? { parentId } : {}) };
    this.folders.set(f.id, f);
    return f;
  }

  folder(id: string): Folder | undefined {
    return this.folders.get(id);
  }

  private freeInFolder(folderId: string | undefined, name: string, except?: string) {
    const k = lower(name);
    for (const f of this.folders.values()) if (f.parentId === folderId && f.id !== except && lower(f.name) === k) throw new MediaError(`there is already a folder called "${f.name}" here`);
    for (const a of this.assets.values()) if (a.folderId === folderId && a.id !== except && lower(a.name) === k) throw new MediaError(`there is already a file called "${a.name}" here`);
  }

  renameFolder(id: string, name: string): Folder {
    const f = this.folders.get(id);
    if (!f) throw new MediaError(`no folder ${id}`);
    const n = cleanName(name);
    this.freeInFolder(f.parentId, n, id);
    const nf = { ...f, name: n };
    this.folders.set(id, nf);
    return nf;
  }

  moveFolder(id: string, parentId: string | undefined): Folder {
    const f = this.folders.get(id);
    if (!f) throw new MediaError(`no folder ${id}`);
    if (parentId !== undefined) {
      if (!this.folders.has(parentId)) throw new MediaError(`no folder ${parentId}`);
      for (let c: string | undefined = parentId; c; c = this.folders.get(c)?.parentId) if (c === id) throw new MediaError('a folder cannot be moved inside itself');
    }
    this.freeInFolder(parentId, f.name, id);
    const { parentId: _old, ...rest } = f;
    const nf: Folder = parentId === undefined ? rest : { ...rest, parentId };
    this.folders.set(id, nf);
    return nf;
  }

  /** Removes an empty folder; a folder with anything in it is refused. */
  deleteFolder(id: string): void {
    if (!this.folders.has(id)) throw new MediaError(`no folder ${id}`);
    const kids = [...this.folders.values()].filter((f) => f.parentId === id).length;
    const files = [...this.assets.values()].filter((a) => a.folderId === id).length;
    if (kids || files) throw new MediaError(`the folder holds ${kids} folder(s) and ${files} file(s)`);
    this.folders.delete(id);
  }

  folderPath(id: string): string {
    const parts: string[] = [];
    for (let c: string | undefined = id; c; c = this.folders.get(c)?.parentId) {
      const f = this.folders.get(c);
      if (!f) throw new MediaError(`no folder ${c}`);
      parts.unshift(f.name);
      if (parts.length > 100) throw new MediaError('the folders are nested too deeply');
    }
    return parts.join('/');
  }

  private inside(folderId: string | undefined, root: string): boolean {
    for (let c = folderId; c; c = this.folders.get(c)?.parentId) if (c === root) return true;
    return false;
  }

  // ------------------------------------------------------------ assets

  /** Reads the bytes, refuses what is unsafe or mislabelled, and adds the file; a name already taken gets " (2)". */
  upload(i: UploadInput): Asset {
    if (i.folderId !== undefined && !this.folders.has(i.folderId)) throw new MediaError(`no folder ${i.folderId}`);
    const info = this.inspect(i.name, i.bytes, i.claimedMime);
    const name = this.uniqueName(i.folderId, cleanName(i.name));
    const t = this.now();
    const a: Asset = {
      id: this.o.newId(),
      name,
      mime: info.mime,
      ext: info.ext,
      size: i.bytes.length,
      sha256: sha(i.bytes),
      focal: { x: 0.5, y: 0.5 },
      alt: { ...(i.alt ?? {}) },
      decorative: i.decorative === true,
      tags: [...new Set(i.tags ?? [])],
      revision: 1,
      createdAt: t,
      modifiedAt: t,
      ...(i.folderId !== undefined ? { folderId: i.folderId } : {}),
      ...(info.width !== undefined ? { width: info.width, height: info.height! } : {}),
    };
    if (a.decorative && Object.values(a.alt).some((v) => v.trim())) throw new MediaError('a decorative image has no alt text');
    this.assets.set(a.id, a);
    return a;
  }

  private inspect(name: string, bytes: Uint8Array, claimed?: string): Sniffed {
    if (bytes.length === 0) throw new MediaError('the file is empty');
    if (bytes.length > this.o.maxBytes) throw new MediaError(`the file is ${bytes.length} bytes; the limit is ${this.o.maxBytes}`);
    const info = sniff(bytes);
    if (!info) throw new MediaError('the file is not a kind this library holds');
    if (!(this.o.allowed ?? ALL_TYPES).includes(info.mime)) throw new MediaError(`${info.mime} files are not accepted here`);
    if (claimed !== undefined && claimed.split(';')[0]!.trim().toLowerCase() !== info.mime) throw new MediaError(`the file says ${claimed} but its bytes are ${info.mime}`);
    const dot = name.lastIndexOf('.');
    const given = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    const same = given === info.ext || (info.ext === 'jpg' && given === 'jpeg') || (info.ext === 'mp4' && ['m4v', 'mov'].includes(given));
    if (given && !same) throw new MediaError(`the name ends in .${given} but the bytes are ${info.mime}`);
    if (info.mime === 'image/svg+xml' && !this.o.allowActiveSvg) {
      const why = svgDanger(new TextDecoder().decode(bytes));
      if (why) throw new MediaError(`the SVG was refused: ${why}`);
    }
    return info;
  }

  private uniqueName(folderId: string | undefined, name: string, except?: string): string {
    const taken = (n: string) => {
      const k = lower(n);
      return [...this.assets.values()].some((a) => a.folderId === folderId && a.id !== except && lower(a.name) === k) || [...this.folders.values()].some((f) => f.parentId === folderId && lower(f.name) === k);
    };
    if (!taken(name)) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const tail = dot > 0 ? name.slice(dot) : '';
    for (let n = 2; n < 10_000; n++) if (!taken(`${stem} (${n})${tail}`)) return `${stem} (${n})${tail}`;
    throw new MediaError('too many files with that name');
  }

  get(id: string): Asset | undefined {
    return this.assets.get(id);
  }

  private need(id: string): Asset {
    const a = this.assets.get(id);
    if (!a) throw new MediaError(`no asset ${id}`);
    return a;
  }

  private put(a: Asset): Asset {
    const n = { ...a, modifiedAt: this.now() };
    this.assets.set(a.id, n);
    return n;
  }

  rename(id: string, name: string): Asset {
    const a = this.need(id);
    const n = cleanName(name);
    const dot = n.lastIndexOf('.');
    const given = dot > 0 ? n.slice(dot + 1).toLowerCase() : '';
    if (given && given !== a.ext && !(a.ext === 'jpg' && given === 'jpeg')) throw new MediaError(`a ${a.mime} file cannot be renamed .${given}`);
    this.freeInFolder(a.folderId, n, id);
    return this.put({ ...a, name: n });
  }

  moveAsset(id: string, folderId: string | undefined): Asset {
    const a = this.need(id);
    if (folderId !== undefined && !this.folders.has(folderId)) throw new MediaError(`no folder ${folderId}`);
    this.freeInFolder(folderId, a.name, id);
    const { folderId: _f, ...rest } = a;
    return this.put(folderId === undefined ? rest : { ...rest, folderId });
  }

  /** Sets the point of an image that must stay in view when it is cropped. */
  setFocal(id: string, focal: Focal): Asset {
    const a = this.need(id);
    if (!IMAGE(a.mime)) throw new MediaError('only an image has a focal point');
    if (!(focal.x >= 0 && focal.x <= 1 && focal.y >= 0 && focal.y <= 1)) throw new MediaError('a focal point is between 0 and 1 in both directions');
    return this.put({ ...a, focal: { x: focal.x, y: focal.y } });
  }

  setAlt(id: string, locale: string, text: string): Asset {
    const a = this.need(id);
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) throw new MediaError(`"${locale.slice(0, 20)}" is not a language tag`);
    if (a.decorative && text.trim()) throw new MediaError('a decorative image has no alt text');
    if (text.length > 1000) throw new MediaError('alt text is longer than 1000 characters');
    return this.put({ ...a, alt: { ...a.alt, [locale]: text } });
  }

  /** Marks an image as decoration: its alt text is cleared and must stay empty. */
  setDecorative(id: string, decorative: boolean): Asset {
    const a = this.need(id);
    return this.put({ ...a, decorative, ...(decorative ? { alt: {} } : {}) });
  }

  update(id: string, p: { title?: string; caption?: string; tags?: readonly string[] }): Asset {
    const a = this.need(id);
    return this.put({ ...a, ...(p.title !== undefined ? { title: p.title } : {}), ...(p.caption !== undefined ? { caption: p.caption } : {}), ...(p.tags !== undefined ? { tags: [...new Set(p.tags)] } : {}) });
  }

  /** Puts a new file under the same asset, so everything that uses it follows. It must be the same kind of file. */
  replaceFile(id: string, bytes: Uint8Array, claimedMime?: string): Asset {
    const a = this.need(id);
    const info = this.inspect('replacement', bytes, claimedMime);
    if (info.mime !== a.mime) throw new MediaError(`the new file is ${info.mime}, not ${a.mime}`);
    const { width: _w, height: _h, ...rest } = a;
    return this.put({ ...rest, size: bytes.length, sha256: sha(bytes), revision: a.revision + 1, ...(info.width !== undefined ? { width: info.width, height: info.height! } : {}) });
  }

  /** Deletes an asset; one that is in use is refused with the list, unless forced. */
  delete(id: string, o: { force?: boolean } = {}): void {
    this.need(id);
    const used = this.usages(id);
    if (used.length && !o.force) throw new InUse(used);
    this.assets.delete(id);
  }

  duplicates(): Asset[][] {
    const by = new Map<string, Asset[]>();
    for (const a of this.assets.values()) by.set(a.sha256, [...(by.get(a.sha256) ?? []), a]);
    return [...by.values()].filter((g) => g.length > 1);
  }

  find(q: { folderId?: string; deep?: boolean; mime?: string; tag?: string; text?: string; unused?: boolean; missingAlt?: string } = {}): Asset[] {
    return [...this.assets.values()]
      .filter((a) => (q.folderId === undefined || (q.deep ? this.inside(a.folderId, q.folderId) : a.folderId === q.folderId)))
      .filter((a) => q.mime === undefined || (q.mime.endsWith('/*') ? a.mime.startsWith(q.mime.slice(0, -1)) : a.mime === q.mime))
      .filter((a) => q.tag === undefined || a.tags.includes(q.tag))
      .filter((a) => q.text === undefined || lower(`${a.name} ${a.title ?? ''} ${a.caption ?? ''} ${Object.values(a.alt).join(' ')}`).includes(lower(q.text)))
      .filter((a) => q.unused === undefined || (this.usages(a.id).length === 0) === q.unused)
      .filter((a) => q.missingAlt === undefined || (IMAGE(a.mime) && !a.decorative && !(a.alt[q.missingAlt] ?? '').trim()))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ------------------------------------------------------------ usage

  /**
   * Says which assets a document uses, replacing what it used before. Call it each time the document is saved,
   * with every place it holds an asset; an asset it no longer holds stops counting.
   */
  setUsage(doc: { kind: string; id: string }, held: readonly { assetId: string; field?: string }[]): void {
    for (const h of held) this.need(h.assetId);
    const groups = new Map<string, { usage: Usage; assets: Set<string> }>();
    for (const h of held) {
      const u: Usage = { kind: doc.kind, id: doc.id, ...(h.field !== undefined ? { field: h.field } : {}) };
      const g = groups.get(keyOf(u)) ?? { usage: u, assets: new Set<string>() };
      g.assets.add(h.assetId);
      groups.set(keyOf(u), g);
    }
    const k = `${doc.kind}\u0000${doc.id}`;
    if (groups.size) this.uses.set(k, [...groups.values()]);
    else this.uses.delete(k);
  }

  /** Every place an asset is used. */
  usages(assetId: string): Usage[] {
    const out: Usage[] = [];
    for (const list of this.uses.values()) for (const g of list) if (g.assets.has(assetId)) out.push(g.usage);
    return out.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  }

  /** Assets used nowhere. */
  unused(): Asset[] {
    return this.find({ unused: true });
  }

  /** Usages that name an asset which is gone (after a forced delete). */
  danglingUsage(): { usage: Usage; assetId: string }[] {
    const out: { usage: Usage; assetId: string }[] = [];
    for (const list of this.uses.values()) for (const g of list) for (const id of g.assets) if (!this.assets.has(id)) out.push({ usage: g.usage, assetId: id });
    return out;
  }

  // ------------------------------------------------------------ derivatives

  /** The part of the original to keep, and the size to make it. Nothing is ever enlarged. */
  plan(asset: Asset, spec: Preset): DerivativePlan {
    if (!IMAGE(asset.mime) || asset.width === undefined || asset.height === undefined) throw new MediaError('only an image with a known size has derivatives');
    return planDerivative(asset, spec);
  }

  /** Picks the best format a client accepts that this library can name for an image. */
  static negotiateFormat(accept: string | undefined, original: string, offered: readonly string[] = ['image/avif', 'image/webp']): string {
    const wants = new Map<string, number>();
    for (const part of (accept ?? '').split(',')) {
      const [t, ...params] = part.trim().toLowerCase().split(';');
      if (!t) continue;
      const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)?.[1]).find(Boolean);
      wants.set(t.trim(), q === undefined ? 1 : Number(q));
    }
    for (const f of offered) if ((wants.get(f) ?? 0) > 0) return f;
    return original;
  }

  // ------------------------------------------------------------ alt text report

  altReport(o: { locales: readonly string[]; usedOnly?: boolean }): AltReport {
    const images = [...this.assets.values()].filter((a) => IMAGE(a.mime)).filter((a) => !o.usedOnly || this.usages(a.id).length > 0);
    const needing = images.filter((a) => !a.decorative);
    const perLocale: Record<string, { covered: number; missing: string[]; coverage: number }> = {};
    const issues: AltReport['issues'][number][] = [];
    for (const loc of o.locales) {
      const missing: string[] = [];
      for (const a of needing) {
        const t = (a.alt[loc] ?? '').trim();
        if (!t) missing.push(a.id);
        else {
          const p = altProblem(t, a.name);
          if (p) issues.push({ assetId: a.id, locale: loc, problem: p });
        }
      }
      perLocale[loc] = { covered: needing.length - missing.length, missing, coverage: needing.length ? (needing.length - missing.length) / needing.length : 1 };
    }
    for (const a of images) if (a.decorative && Object.values(a.alt).some((v) => v.trim())) issues.push({ assetId: a.id, locale: '', problem: 'a decorative image has alt text' });
    const byFolder: Record<string, { images: number; missing: number }> = {};
    for (const a of needing) {
      const k = a.folderId === undefined ? '/' : this.folderPath(a.folderId);
      const e = byFolder[k] ?? { images: 0, missing: 0 };
      e.images++;
      if (o.locales.some((l) => !(a.alt[l] ?? '').trim())) e.missing++;
      byFolder[k] = e;
    }
    const priority = needing.filter((a) => o.locales.some((l) => !(a.alt[l] ?? '').trim())).map((a) => ({ assetId: a.id, uses: this.usages(a.id).length })).sort((x, y) => y.uses - x.uses || x.assetId.localeCompare(y.assetId));
    return { images: images.length, decorative: images.length - needing.length, perLocale, issues, byFolder, priority };
  }
}

export interface AltReport {
  readonly images: number;
  readonly decorative: number;
  readonly perLocale: Readonly<Record<string, { covered: number; missing: string[]; coverage: number }>>;
  readonly issues: readonly { assetId: string; locale: string; problem: string }[];
  readonly byFolder: Readonly<Record<string, { images: number; missing: number }>>;
  /** Images missing alt text in some language, those used in the most places first. */
  readonly priority: readonly { assetId: string; uses: number }[];
}

/** What is wrong with a piece of alt text, if anything. */
export function altProblem(alt: string, fileName = ''): string | undefined {
  const t = alt.trim();
  if (t.length < 3) return 'too short to describe anything';
  if (t.length > 150) return 'longer than 150 characters; put the detail in a caption';
  if (/^(?:an? )?(?:image|picture|photo|graphic|icon)(?: of| for)?\b/i.test(t)) return 'starts with "image of" or the like; the reader already knows it is an image';
  const stem = fileName.replace(/\.[^.]+$/, '');
  if (stem && lower(t) === lower(stem)) return 'is just the file name';
  if (/\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(t)) return 'looks like a file name';
  if (/^(?:img|dsc|image|photo|screenshot)[-_ ]?\d+/i.test(t)) return 'looks like a camera or screenshot name';
  return undefined;
}

// ================================================================== derivative planning

export type Fit = 'cover' | 'inside';

export interface Preset {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** cover crops around the focal point to fill the box; inside shrinks the whole picture to fit it. */
  readonly fit: Fit;
  readonly format?: string;
  readonly quality?: number;
}

export interface DerivativePlan {
  readonly preset: string;
  /** The rectangle of the original to use. */
  readonly source: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly output: { readonly width: number; readonly height: number };
  readonly format: string;
  /** Changes whenever the file, its revision, the focal point or the preset changes. */
  readonly key: string;
  readonly path: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const EXT_OF: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif', 'image/svg+xml': 'svg' };

export function planDerivative(asset: Pick<Asset, 'id' | 'mime' | 'sha256' | 'revision' | 'focal'> & { width?: number; height?: number }, p: Preset): DerivativePlan {
  const W = asset.width;
  const H = asset.height;
  if (!W || !H) throw new MediaError('the image size is not known');
  if (!/^[a-z][a-z0-9-]*$/.test(p.name)) throw new MediaError('a preset name is lower-case words');
  if (!Number.isInteger(p.width) || !Number.isInteger(p.height) || p.width < 1 || p.height < 1 || p.width > 16_384 || p.height > 16_384) throw new MediaError('a preset size is whole pixels from 1 to 16384');
  let source: DerivativePlan['source'];
  let out: { width: number; height: number };
  if (p.fit === 'cover') {
    const target = p.width / p.height;
    const w = W / H > target ? Math.max(1, Math.round(H * target)) : W;
    const h = W / H > target ? H : Math.max(1, Math.round(W / target));
    const x = clamp(Math.round(asset.focal.x * W - w / 2), 0, W - w);
    const y = clamp(Math.round(asset.focal.y * H - h / 2), 0, H - h);
    source = { x, y, width: w, height: h };
    const scale = Math.min(1, w / p.width);
    out = { width: Math.max(1, Math.round(p.width * scale)), height: Math.max(1, Math.round(p.height * scale)) };
  } else {
    source = { x: 0, y: 0, width: W, height: H };
    const scale = Math.min(1, p.width / W, p.height / H);
    out = { width: Math.max(1, Math.round(W * scale)), height: Math.max(1, Math.round(H * scale)) };
  }
  const format = p.format ?? asset.mime;
  const ext = EXT_OF[format];
  if (!ext) throw new MediaError(`cannot make ${format}`);
  const key = createHash('sha256').update(JSON.stringify([asset.sha256, asset.revision, asset.focal, p])).digest('hex').slice(0, 16);
  return { preset: p.name, source, output: out, format, key, path: `${asset.id}/${p.name}-${key}.${ext}` };
}

/** Widths for an `srcset`: those asked for that the original can supply, plus the original's own width. */
export function srcsetWidths(asset: Pick<Asset, 'width' | 'height'>, widths: readonly number[]): { width: number; height: number }[] {
  const W = asset.width;
  const H = asset.height;
  if (!W || !H) return [];
  const set = new Set(widths.filter((w) => Number.isInteger(w) && w >= 1 && w < W));
  set.add(W);
  return [...set].sort((a, b) => a - b).map((w) => ({ width: w, height: Math.max(1, Math.round((H * w) / W)) }));
}
