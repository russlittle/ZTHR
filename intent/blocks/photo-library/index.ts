/**
 * A photo library: assets filed in an owner's tree by a storage template, albums that can be shared through grants,
 * stacks of near-identical shots, a trash with a retention window, and timeline buckets for a scrolling grid.
 *
 * The file bytes live wherever the tree's `blob` points; this block keeps the metadata and the rules. Everything is
 * held in memory behind one class so the rules can be tested; a deployment persists `snapshot()`.
 *
 * Albums are shared through the grants block, using the negative of the album id as the resource id so an album
 * never collides with a tree node id in the same grants store.
 */
import { ALL, CREATE, READ, UPDATE, type Grant, type Grants } from '../grants/index.ts';
import { Exists, NotFound, type Tree } from '../tree/index.ts';

export class LibraryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type AssetType = 'image' | 'video';

export interface Asset {
  readonly id: number;
  readonly owner: string;
  readonly type: AssetType;
  readonly filename: string;
  /** Where the original sits in the owner's tree. */
  readonly path: string;
  readonly checksum: string;
  readonly mime: string;
  readonly size: number;
  /** Milliseconds since the epoch: when the picture was taken, else when the file was made. */
  readonly takenAt: number;
  readonly favourite: boolean;
  readonly archived: boolean;
  /** Set while the asset is in the trash. */
  readonly deletedAt?: number;
  readonly stackId?: number;
}

export interface Stack {
  readonly id: number;
  readonly owner: string;
  /** The one shown in the timeline. */
  readonly primary: number;
  readonly members: readonly number[];
}

export type Role = 'viewer' | 'editor';

export interface Album {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly assets: readonly number[];
  readonly cover?: number;
  readonly created: number;
}

export interface Bucket {
  readonly bucket: string;
  readonly count: number;
}

export interface AddInput {
  readonly owner: string;
  readonly filename: string;
  readonly size: number;
  readonly blob: string;
  readonly checksum: string;
  readonly mime: string;
  readonly takenAt?: number;
  readonly type?: AssetType;
}

export interface Options {
  readonly tree: Tree;
  readonly grants: Grants;
  readonly now?: () => number;
  /** Where originals go; see `renderTemplate`. */
  readonly template?: string;
  /** Days an asset stays in the trash before `purgeExpired` removes it. */
  readonly trashDays?: number;
  /** The groups a person belongs to, for group shares. */
  readonly groupsOf?: (person: string) => readonly string[];
}

// ------------------------------------------------------------ storage templates

export const TEMPLATE_TOKENS = ['y', 'yy', 'MM', 'MMM', 'dd', 'HH', 'mm', 'ss', 'filename', 'filenameNoExt', 'ext', 'assetId', 'album', 'owner'] as const;
export const DEFAULT_TEMPLATE = '{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TOKEN = /\{\{\s*([A-Za-z]+)\s*\}\}/g;

export interface TemplateVars {
  readonly takenAt: number;
  readonly filename: string;
  readonly assetId?: number;
  readonly album?: string;
  readonly owner?: string;
}

/** A path piece made safe to be one step of a path. */
export function cleanStep(s: string): string {
  let out = s.normalize('NFC').replace(/[/\\\0]/g, '_').replace(/[\u0000-\u001f]/g, '').trim();
  if (out === '.' || out === '..') out = out.replace(/\./g, '_');
  return out;
}

/** Checks a template at configuration time, so a typo fails then and not on the thousandth upload. */
export function checkTemplate(t: string): void {
  if (!t.trim()) throw new LibraryError('template', 'the storage template is empty');
  if (t.startsWith('/') || /^[A-Za-z]:/.test(t)) throw new LibraryError('template', 'the storage template must be relative');
  if (t.split('/').some((p) => p === '..' || p === '.')) throw new LibraryError('template', 'the storage template cannot step up or stay');
  const used = new Set<string>();
  for (const m of t.matchAll(TOKEN)) {
    const name = m[1] as string;
    if (!(TEMPLATE_TOKENS as readonly string[]).includes(name)) throw new LibraryError('template', `unknown template token {{${name}}}`);
    used.add(name);
  }
  const stripped = t.replace(TOKEN, '');
  if (/\{\{|\}\}/.test(stripped)) throw new LibraryError('template', 'the storage template has an unclosed brace');
  if (!['filename', 'filenameNoExt', 'assetId'].some((k) => used.has(k))) throw new LibraryError('template', 'the storage template must name the file with {{filename}}, {{filenameNoExt}} or {{assetId}}');
  if (used.has('filenameNoExt') && !used.has('ext') && !used.has('filename') && !t.includes('.')) throw new LibraryError('template', 'a template with {{filenameNoExt}} must also give the extension with {{ext}}');
}

const p2 = (n: number) => String(n).padStart(2, '0');

export function renderTemplate(template: string, v: TemplateVars): string {
  checkTemplate(template);
  const d = new Date(v.takenAt);
  if (Number.isNaN(d.getTime())) throw new LibraryError('date', 'the taken-at time is not a date');
  const dot = v.filename.lastIndexOf('.');
  const ext = dot > 0 ? v.filename.slice(dot + 1).toLowerCase() : '';
  const base = dot > 0 ? v.filename.slice(0, dot) : v.filename;
  const vals: Record<string, string> = {
    y: String(d.getUTCFullYear()).padStart(4, '0'),
    yy: p2(d.getUTCFullYear() % 100),
    MM: p2(d.getUTCMonth() + 1),
    MMM: MONTHS[d.getUTCMonth()] as string,
    dd: p2(d.getUTCDate()),
    HH: p2(d.getUTCHours()),
    mm: p2(d.getUTCMinutes()),
    ss: p2(d.getUTCSeconds()),
    filename: v.filename,
    filenameNoExt: base,
    ext,
    assetId: v.assetId === undefined ? '' : String(v.assetId),
    album: v.album ?? 'No album',
    owner: v.owner ?? '',
  };
  const out = template
    .replace(TOKEN, (_m, name: string) => cleanStep(vals[name] ?? ''))
    .split('/')
    .filter((s) => s !== '')
    .map(cleanStep)
    .filter((s) => s !== '');
  if (out.length === 0) throw new LibraryError('template', 'the storage template produced no path');
  return `/${out.join('/')}`;
}

/** "photo.jpg" taken twice at the same moment becomes "photo+1.jpg". */
export function withSuffix(path: string, n: number): string {
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const at = dot > 0 ? dot : name.length;
  return `${path.slice(0, slash + 1)}${name.slice(0, at)}+${n}${name.slice(at)}`;
}

// ------------------------------------------------------------ timeline

export type Granularity = 'month' | 'day';

/** The bucket a time falls in, at a fixed offset from UTC (minutes east), as a viewer's local day. */
export function bucketOf(ms: number, g: Granularity, offsetMinutes = 0): string {
  const d = new Date(ms + offsetMinutes * 60_000);
  const month = `${String(d.getUTCFullYear()).padStart(4, '0')}-${p2(d.getUTCMonth() + 1)}`;
  return g === 'month' ? month : `${month}-${p2(d.getUTCDate())}`;
}

export interface TimelineQuery {
  readonly granularity?: Granularity;
  readonly offsetMinutes?: number;
  readonly favourite?: boolean;
  readonly archived?: boolean;
  readonly type?: AssetType;
  readonly album?: number;
  /** Show every member of a stack, not only the primary. */
  readonly withStacked?: boolean;
  readonly trashed?: boolean;
}

const isBucket = (b: string) => /^\d{4}-\d{2}(-\d{2})?$/.test(b);

// ------------------------------------------------------------ library

export interface Snapshot {
  readonly assets: readonly Asset[];
  readonly stacks: readonly Stack[];
  readonly albums: readonly Album[];
}

export class PhotoLibrary {
  private readonly tree: Tree;
  private readonly grants: Grants;
  private readonly now: () => number;
  private readonly template: string;
  private readonly trashDays: number;
  private readonly groupsOf: (person: string) => readonly string[];
  private readonly assets = new Map<number, Asset>();
  private readonly stacks = new Map<number, Stack>();
  private readonly albums = new Map<number, Album>();
  private seq = 0;

  constructor(o: Options) {
    this.tree = o.tree;
    this.grants = o.grants;
    this.now = o.now ?? Date.now;
    this.template = o.template ?? DEFAULT_TEMPLATE;
    checkTemplate(this.template);
    this.trashDays = o.trashDays ?? 30;
    if (!(this.trashDays >= 0)) throw new LibraryError('options', 'trashDays cannot be negative');
    this.groupsOf = o.groupsOf ?? (() => []);
  }

  snapshot(): Snapshot {
    return { assets: [...this.assets.values()], stacks: [...this.stacks.values()], albums: [...this.albums.values()] };
  }

  // ---------------------------------------------------------- assets

  /** Files an asset by the storage template. A second upload of the same bytes by the same owner is a duplicate and adds nothing. */
  async add(i: AddInput): Promise<{ asset: Asset; duplicate: boolean }> {
    if (!i.checksum) throw new LibraryError('input', 'an asset needs a checksum');
    if (!Number.isInteger(i.size) || i.size < 0) throw new LibraryError('input', 'size must be a whole number of bytes');
    const type: AssetType = i.type ?? (i.mime.startsWith('video/') ? 'video' : 'image');
    if (!i.mime.startsWith('image/') && !i.mime.startsWith('video/')) throw new LibraryError('type', `${i.mime} is not a photo or video`);
    for (const a of this.assets.values()) if (a.owner === i.owner && a.checksum === i.checksum) return { asset: a, duplicate: true };
    const takenAt = i.takenAt ?? this.now();
    const id = ++this.seq;
    let path = renderTemplate(this.template, { takenAt, filename: i.filename, assetId: id, owner: i.owner });
    const parts = path.split('/').filter(Boolean);
    for (let k = 1; k < parts.length; k++) {
      const dir = `/${parts.slice(0, k).join('/')}`;
      try {
        await this.tree.mkdir(i.owner, dir);
      } catch (e) {
        if (!(e instanceof Exists)) throw e;
      }
    }
    for (let n = 1; await this.tree.resolve(i.owner, path); n++) {
      path = withSuffix(renderTemplate(this.template, { takenAt, filename: i.filename, assetId: id, owner: i.owner }), n);
      if (n > 1000) throw new LibraryError('path', 'too many files with the same name');
    }
    await this.tree.put(i.owner, path, { size: i.size, blob: i.blob, mime: i.mime, checksums: [`SHA256:${i.checksum}`] });
    const asset: Asset = { id, owner: i.owner, type, filename: i.filename, path, checksum: i.checksum, mime: i.mime, size: i.size, takenAt, favourite: false, archived: false };
    this.assets.set(id, asset);
    return { asset, duplicate: false };
  }

  get(id: number): Asset | undefined {
    return this.assets.get(id);
  }

  private own(owner: string, id: number): Asset {
    const a = this.assets.get(id);
    if (!a || a.owner !== owner) throw new LibraryError('not-found', `no asset ${id} of yours`);
    return a;
  }

  update(owner: string, id: number, change: { favourite?: boolean; archived?: boolean; takenAt?: number }): Asset {
    const a = this.own(owner, id);
    if (a.deletedAt !== undefined) throw new LibraryError('trashed', 'restore the asset before changing it');
    const next: Asset = { ...a, ...(change.favourite !== undefined ? { favourite: change.favourite } : {}), ...(change.archived !== undefined ? { archived: change.archived } : {}), ...(change.takenAt !== undefined ? { takenAt: change.takenAt } : {}) };
    this.assets.set(id, next);
    return next;
  }

  // ---------------------------------------------------------- trash

  /** Moves assets to the trash. They leave the timeline, albums keep their place, and a stack loses them. */
  trash(owner: string, ids: readonly number[]): Asset[] {
    const out: Asset[] = [];
    for (const id of ids) {
      const a = this.own(owner, id);
      if (a.deletedAt !== undefined) continue;
      if (a.stackId !== undefined) this.leaveStack(a);
      const next: Asset = { ...(this.assets.get(id) as Asset), deletedAt: this.now() };
      this.assets.set(id, next);
      out.push(next);
    }
    return out;
  }

  untrash(owner: string, ids: readonly number[]): Asset[] {
    return ids.map((id) => {
      const a = this.own(owner, id);
      if (a.deletedAt === undefined) return a;
      const { deletedAt: _gone, ...rest } = a;
      this.assets.set(id, rest);
      return rest;
    });
  }

  trashed(owner: string): Asset[] {
    return [...this.assets.values()].filter((a) => a.owner === owner && a.deletedAt !== undefined).sort((x, y) => (y.deletedAt as number) - (x.deletedAt as number) || y.id - x.id);
  }

  /** Removes the file and every trace of the asset. Only a trashed asset can be deleted for good. */
  async purge(owner: string, ids: readonly number[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      const a = this.own(owner, id);
      if (a.deletedAt === undefined) throw new LibraryError('not-trashed', 'only a trashed asset can be deleted for good');
      try {
        await this.tree.remove(owner, a.path);
      } catch (e) {
        if (!(e instanceof NotFound)) throw e;
      }
      this.assets.delete(id);
      for (const al of this.albums.values()) if (al.assets.includes(id)) this.albums.set(al.id, this.withoutAsset(al, id));
      n++;
    }
    return n;
  }

  /** Deletes what has been in the trash longer than the retention window. */
  async purgeExpired(): Promise<number> {
    const cutoff = this.now() - this.trashDays * 86_400_000;
    let n = 0;
    for (const a of [...this.assets.values()]) if (a.deletedAt !== undefined && a.deletedAt <= cutoff) n += await this.purge(a.owner, [a.id]);
    return n;
  }

  async emptyTrash(owner: string): Promise<number> {
    return this.purge(owner, this.trashed(owner).map((a) => a.id));
  }

  // ---------------------------------------------------------- stacks

  stackOf(id: number): Stack | undefined {
    const a = this.assets.get(id);
    return a?.stackId === undefined ? undefined : this.stacks.get(a.stackId);
  }

  /** Groups two or more assets under one primary. An asset is in at most one stack. */
  createStack(owner: string, primary: number, others: readonly number[]): Stack {
    const members = [...new Set([primary, ...others])];
    if (members.length < 2) throw new LibraryError('stack', 'a stack needs at least two assets');
    for (const id of members) {
      const a = this.own(owner, id);
      if (a.deletedAt !== undefined) throw new LibraryError('stack', 'a trashed asset cannot be stacked');
      if (a.stackId !== undefined) throw new LibraryError('stack', `asset ${id} is already in a stack`);
    }
    const id = ++this.seq;
    const s: Stack = { id, owner, primary, members };
    this.stacks.set(id, s);
    for (const m of members) this.assets.set(m, { ...(this.assets.get(m) as Asset), stackId: id });
    return s;
  }

  setPrimary(owner: string, stackId: number, primary: number): Stack {
    const s = this.stacks.get(stackId);
    if (!s || s.owner !== owner) throw new LibraryError('not-found', 'no such stack of yours');
    if (!s.members.includes(primary)) throw new LibraryError('stack', 'the primary must be a member');
    const next = { ...s, primary };
    this.stacks.set(stackId, next);
    return next;
  }

  /** Takes one asset out; a stack left with one asset is dissolved. */
  removeFromStack(owner: string, id: number): void {
    const a = this.own(owner, id);
    if (a.stackId === undefined) throw new LibraryError('stack', 'that asset is not in a stack');
    this.leaveStack(a);
  }

  dissolveStack(owner: string, stackId: number): void {
    const s = this.stacks.get(stackId);
    if (!s || s.owner !== owner) throw new LibraryError('not-found', 'no such stack of yours');
    this.dropStack(s);
  }

  private dropStack(s: Stack): void {
    for (const m of s.members) {
      const a = this.assets.get(m);
      if (a) {
        const { stackId: _s, ...rest } = a;
        this.assets.set(m, rest);
      }
    }
    this.stacks.delete(s.id);
  }

  private leaveStack(a: Asset): void {
    const s = this.stacks.get(a.stackId as number);
    if (!s) return;
    const { stackId: _s, ...rest } = this.assets.get(a.id) as Asset;
    this.assets.set(a.id, rest);
    const members = s.members.filter((m) => m !== a.id);
    if (members.length < 2) {
      this.dropStack({ ...s, members });
      return;
    }
    this.stacks.set(s.id, { ...s, members, primary: s.primary === a.id ? (members[0] as number) : s.primary });
  }

  // ---------------------------------------------------------- albums

  private withoutAsset(al: Album, id: number): Album {
    const assets = al.assets.filter((x) => x !== id);
    const { cover, ...rest } = al;
    return { ...rest, assets, ...(cover !== undefined && cover !== id ? { cover } : {}) };
  }

  createAlbum(owner: string, name: string, assets: readonly number[] = []): Album {
    const n = name.trim();
    if (!n) throw new LibraryError('album', 'an album needs a name');
    if (n.length > 200) throw new LibraryError('album', 'an album name is at most 200 characters');
    for (const id of assets) this.own(owner, id);
    const album: Album = { id: ++this.seq, owner, name: n, assets: [...new Set(assets)], created: this.now() };
    this.albums.set(album.id, album);
    return album;
  }

  album(id: number): Album | undefined {
    return this.albums.get(id);
  }

  /** What a person may do with an album, as grants permission bits. The owner may do everything. */
  async albumAccess(person: string, albumId: number): Promise<number> {
    const al = this.albums.get(albumId);
    if (!al) return 0;
    if (al.owner === person) return ALL;
    return this.grants.effective(person, this.groupsOf(person), [{ id: -albumId, kind: 'folder' }], { owner: al.owner, groupsOf: (p) => this.groupsOf(p) });
  }

  private async need(person: string, albumId: number, bit: number): Promise<Album> {
    const al = this.albums.get(albumId);
    const bits = await this.albumAccess(person, albumId);
    // Someone with no access learns nothing, not even that the album exists.
    if (!al || !(bits & READ)) throw new LibraryError('not-found', 'no such album');
    if (!(bits & bit)) throw new LibraryError('forbidden', 'you may not do that in this album');
    return al;
  }

  /** The owner adds their own assets; an editor adds their own assets too, and the album keeps them. */
  async addToAlbum(person: string, albumId: number, ids: readonly number[]): Promise<Album> {
    const al = await this.need(person, albumId, CREATE);
    const mine = ids.map((id) => this.own(person, id));
    for (const a of mine) if (a.deletedAt !== undefined) throw new LibraryError('trashed', 'a trashed asset cannot go in an album');
    const assets = [...new Set([...al.assets, ...ids])];
    const next = { ...al, assets };
    this.albums.set(albumId, next);
    return next;
  }

  /** The owner removes anything; an editor removes only what they put there. */
  async removeFromAlbum(person: string, albumId: number, ids: readonly number[]): Promise<Album> {
    let al = await this.need(person, albumId, UPDATE);
    for (const id of ids) {
      const a = this.assets.get(id);
      if (al.owner !== person && a?.owner !== person) throw new LibraryError('forbidden', 'an editor can only remove their own assets');
      al = this.withoutAsset(al, id);
    }
    this.albums.set(albumId, al);
    return al;
  }

  async setCover(person: string, albumId: number, id: number): Promise<Album> {
    const al = await this.need(person, albumId, UPDATE);
    if (!al.assets.includes(id)) throw new LibraryError('album', 'the cover must be in the album');
    const next = { ...al, cover: id };
    this.albums.set(albumId, next);
    return next;
  }

  async deleteAlbum(owner: string, albumId: number): Promise<void> {
    const al = this.albums.get(albumId);
    if (!al || al.owner !== owner) throw new LibraryError('not-found', 'no such album of yours');
    this.albums.delete(albumId);
    for (const g of await this.grants.live((x) => x.resource === -albumId)) await this.grants.revoke(g.id, g.by);
  }

  /** Shares an album with a person or a group. A viewer looks; an editor also adds their own assets. */
  async share(owner: string, albumId: number, to: string, role: Role, kind: 'person' | 'group' = 'person'): Promise<Grant> {
    const al = this.albums.get(albumId);
    if (!al || al.owner !== owner) throw new LibraryError('not-found', 'no such album of yours');
    return this.grants.create({ resource: -albumId, resourceKind: 'folder', by: owner, giverHas: ALL, kind, to, permissions: role === 'editor' ? READ | UPDATE | CREATE : READ });
  }

  async shareLink(owner: string, albumId: number, o: { password?: string; expires?: number } = {}): Promise<Grant> {
    const al = this.albums.get(albumId);
    if (!al || al.owner !== owner) throw new LibraryError('not-found', 'no such album of yours');
    return this.grants.create({ resource: -albumId, resourceKind: 'folder', by: owner, giverHas: ALL, kind: 'link', ...(o.password ? { password: o.password } : {}), ...(o.expires !== undefined ? { expires: o.expires } : {}) });
  }

  /** What a link opens: the album and its live assets, never the owner's other assets. */
  async openLink(token: string, password?: string): Promise<{ album: Album; assets: Asset[] }> {
    const g = await this.grants.open(token, password);
    const al = this.albums.get(-g.resource);
    if (!al) throw new LibraryError('not-found', 'no such album');
    return { album: al, assets: this.albumAssets(al) };
  }

  async unshare(owner: string, grantId: number): Promise<void> {
    await this.grants.revoke(grantId, owner);
  }

  private albumAssets(al: Album): Asset[] {
    return al.assets
      .map((id) => this.assets.get(id))
      .filter((a): a is Asset => !!a && a.deletedAt === undefined)
      .sort((x, y) => y.takenAt - x.takenAt || y.id - x.id);
  }

  /** The album's live assets for someone allowed to see it. */
  async albumContents(person: string, albumId: number): Promise<Asset[]> {
    return this.albumAssets(await this.need(person, albumId, READ));
  }

  /** Albums a person owns or has been shown, newest first. */
  async albumsFor(person: string): Promise<Album[]> {
    const out: Album[] = [];
    for (const al of this.albums.values()) if ((await this.albumAccess(person, al.id)) & READ) out.push(al);
    return out.sort((a, b) => b.created - a.created || b.id - a.id);
  }

  // ---------------------------------------------------------- timeline

  private visible(owner: string, q: TimelineQuery): Asset[] {
    const inAlbum = q.album === undefined ? undefined : new Set(this.albums.get(q.album)?.assets ?? []);
    return [...this.assets.values()].filter((a) => {
      if (a.owner !== owner) return false;
      if (q.trashed ? a.deletedAt === undefined : a.deletedAt !== undefined) return false;
      if (!q.trashed && !q.archived && a.archived) return false;
      if (q.archived && !a.archived) return false;
      if (q.favourite && !a.favourite) return false;
      if (q.type && a.type !== q.type) return false;
      if (inAlbum && !inAlbum.has(a.id)) return false;
      if (!q.withStacked && a.stackId !== undefined && this.stacks.get(a.stackId)?.primary !== a.id) return false;
      return true;
    });
  }

  /** Counts per month or day, newest first, so a client sizes its scrollbar before loading any picture. */
  timelineBuckets(owner: string, q: TimelineQuery = {}): Bucket[] {
    const g = q.granularity ?? 'month';
    const counts = new Map<string, number>();
    for (const a of this.visible(owner, q)) {
      const b = bucketOf(a.takenAt, g, q.offsetMinutes ?? 0);
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    return [...counts].map(([bucket, count]) => ({ bucket, count })).sort((a, b) => (a.bucket < b.bucket ? 1 : -1));
  }

  /** One bucket's assets, newest first. A "2024-03" bucket holds the month; a "2024-03-09" bucket the day. */
  timelineBucket(owner: string, bucket: string, q: TimelineQuery = {}): Asset[] {
    if (!isBucket(bucket)) throw new LibraryError('bucket', `${bucket} is not a month or day bucket`);
    const g: Granularity = bucket.length === 7 ? 'month' : 'day';
    return this.visible(owner, q)
      .filter((a) => bucketOf(a.takenAt, g, q.offsetMinutes ?? 0) === bucket)
      .sort((x, y) => y.takenAt - x.takenAt || y.id - x.id);
  }
}
