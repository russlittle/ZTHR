/**
 * Files: what a person sees and may do, assembled from the standard blocks. The tree keeps folders, ids, etags
 * and sizes; the object store keeps bytes; uploads joins chunks; leases holds locks; grants decides sharing;
 * devices signs apps in; retention plans what the trash and old versions give up. What is particular to Files is
 * here: each person's view of their own files plus what is shared with them, the permission letters clients read,
 * quota, the trash, and versions.
 */
import { createHash } from 'node:crypto';
import { Devices, NotSignedIn } from '../../intent/blocks/devices/index.ts';
import { ALL, CREATE, DELETE, FILE_MAX, Grants, READ, SHARE, UPDATE, checkPassword, hashPassword, type Grant } from '../../intent/blocks/grants/index.ts';
import { Leases, memoryLeases } from '../../intent/blocks/leases/index.ts';
import type { ObjectStore } from '../../intent/blocks/objects/index.ts';
import { sweep as plan, type Item, type Policy } from '../../intent/blocks/retention/index.ts';
import { Exists, MissingParent, NotFound, Tree, steps, type Node } from '../../intent/blocks/tree/index.ts';
import { checkName as safeName } from '../../intent/blocks/uploadsafe/index.ts';
import { NEXTCLOUD_RULES, Uploads } from '../../intent/blocks/uploads/index.ts';
import type { Person, State, Trashed, Version } from './state.ts';

export class Denied extends Error {
  readonly status: number;
  constructor(why: string, status = 403) {
    super(why);
    this.status = status;
  }
}

export class Insufficient extends Error {
  constructor(needed: number, free: number) {
    super(`needs ${needed} bytes, ${free} free`);
  }
}

export class PreconditionFailed extends Error {
  constructor(why: string) {
    super(why);
  }
}

/** Where a path a person sees lands: whose tree, the path within it, and what the person may do there. */
export interface Where {
  readonly owner: string;
  readonly path: string;
  readonly perms: number;
  /** Set when the path runs through something shared with them. */
  readonly via?: { readonly grant: Grant; readonly at: string };
}

export interface Options {
  readonly now?: () => number;
  readonly trashDays?: number;
  /** How many old copies a file keeps, and for how long. */
  readonly versions?: { readonly max: number; readonly days: number };
  readonly defaultQuota?: number | null;
  /** The largest chunk a client may send; Cloud Run's HTTP/1 limit is 32 MiB, so it runs with 30. */
  readonly maxChunk?: number;
}

const DAY = 86_400_000;

export class Files {
  readonly state: State;
  readonly objects: ObjectStore;
  readonly tree: Tree;
  readonly uploads: Uploads;
  readonly leases: Leases;
  readonly grants: Grants;
  readonly devices: Devices;
  readonly now: () => number;
  private readonly o: Options;

  constructor(state: State, objects: ObjectStore, o: Options = {}) {
    this.state = state;
    this.objects = objects;
    this.o = o;
    this.now = o.now ?? Date.now;
    this.tree = new Tree(state.nodes, { now: () => Math.floor(this.now() / 1000) });
    this.uploads = new Uploads(objects, state.sessions, { now: this.now, free: (u) => this.free(u), rules: { ...NEXTCLOUD_RULES, maxBytes: o.maxChunk ?? NEXTCLOUD_RULES.maxBytes } });
    this.leases = new Leases(memoryLeases(), { now: this.now });
    this.grants = new Grants(state.grants, { now: this.now });
    this.devices = new Devices(state.devices, { now: this.now });
  }

  get maxChunk(): number {
    return this.o.maxChunk ?? NEXTCLOUD_RULES.maxBytes;
  }

  get instance(): string {
    return this.state.doc.instance;
  }

  // ---------------------------------------------------------------- people

  person(id: string): Person | undefined {
    const p = this.state.doc.people[id];
    return p && !p.disabled ? p : undefined;
  }

  people(): Person[] {
    return Object.values(this.state.doc.people).sort((a, b) => a.id.localeCompare(b.id));
  }

  async addPerson(id: string, password: string, o: { display?: string; quota?: number | null; admin?: boolean; groups?: string[]; email?: string } = {}): Promise<Person> {
    if (!/^[a-zA-Z0-9_.@-]{1,64}$/.test(id)) throw new Denied('a login name is 1 to 64 letters, digits, dots, dashes, underscores or @', 400);
    if (this.state.doc.people[id]) throw new Exists(id);
    if (password.length < 10) throw new Denied('a password needs at least 10 characters', 400);
    const p: Person = { id, display: o.display ?? id, passwordHash: await hashPassword(password), quota: o.quota === undefined ? (this.o.defaultQuota ?? null) : o.quota, admin: !!o.admin, groups: o.groups ?? [], ...(o.email ? { email: o.email } : {}), created: this.now() };
    this.state.doc.people[id] = p;
    this.state.mark('people', id);
    await this.tree.root(id);
    return p;
  }

  updatePerson(id: string, change: Partial<Pick<Person, 'display' | 'quota' | 'admin' | 'groups' | 'email' | 'disabled'>>): Person {
    const p = this.state.doc.people[id];
    if (!p) throw new NotFound(id);
    const next: Person = { ...p, ...change };
    this.state.doc.people[id] = next;
    this.state.mark('people', id);
    return next;
  }

  async setPassword(id: string, password: string): Promise<void> {
    const p = this.state.doc.people[id];
    if (!p) throw new NotFound(id);
    if (password.length < 10) throw new Denied('a password needs at least 10 characters', 400);
    this.state.doc.people[id] = { ...p, passwordHash: await hashPassword(password) };
    this.state.mark('people', id);
  }

  /** Removes a person and everything they own: their files, their grants, their devices. */
  async removePerson(id: string): Promise<void> {
    const p = this.state.doc.people[id];
    if (!p) throw new NotFound(id);
    const root = await this.tree.root(id);
    for (const n of [root, ...(await this.tree.descendants(root))]) if (n.blob) await this.objects.delete(n.blob);
    await this.state.nodes.commit([], [root.id, ...(await this.tree.descendants(root)).map((n) => n.id)]);
    for (const g of await this.grants.live((g) => g.by === id || g.to === id)) await this.state.grants.delete(g.id);
    for (const d of await this.devices.list(id)) await this.devices.revoke(id, d.id);
    for (const t of Object.values(this.state.doc.trash).filter((t) => t.owner === id)) await this.purgeTrash(t);
    delete this.state.doc.people[id];
    this.state.mark('people', id);
  }

  /** A login name and either the person's password or one of their app passwords. */
  /**
   * A login password is checked with a deliberately slow hash; a success is remembered for five minutes, keyed by a
   * fast hash of the password and the stored hash, so a changed password or a removed person signs nothing in.
   */
  private readonly recent = new Map<string, number>();

  async signIn(user: string, password: string): Promise<{ person: Person; device?: number }> {
    const p = this.person(user);
    if (!p) throw new NotSignedIn();
    try {
      const d = await this.devices.verify(user, password);
      return { person: p, device: d.id };
    } catch {
      const key = createHash('sha256').update(`${user}\u0000${p.passwordHash}\u0000${password}`).digest('hex');
      const until = this.recent.get(key);
      if (until && until > this.now()) return { person: p };
      if (await checkPassword(password, p.passwordHash)) {
        if (this.recent.size > 10_000) this.recent.clear();
        this.recent.set(key, this.now() + 5 * 60_000);
        return { person: p };
      }
      throw new NotSignedIn();
    }
  }

  // ---------------------------------------------------------------- space

  async used(user: string): Promise<number> {
    return (await this.tree.root(user)).size;
  }

  /** Bytes left; undefined when the person has no limit. */
  async free(user: string): Promise<number | undefined> {
    const q = this.person(user)?.quota;
    if (q === null || q === undefined) return undefined;
    return Math.max(0, q - (await this.used(user)));
  }

  // ---------------------------------------------------------------- what a person sees

  /** Grants that reach this person, each mounted at their root under the shared item's name. */
  async mounts(user: string): Promise<{ name: string; grant: Grant; node: Node }[]> {
    const p = this.person(user);
    if (!p) return [];
    const own = await this.tree.root(user);
    const taken = new Set((await this.tree.list(own)).map((n) => n.name));
    const out: { name: string; grant: Grant; node: Node }[] = [];
    const seen = new Set<number>();
    for (const g of await this.grants.live((g) => g.by !== user && ((g.kind === 'person' && g.to === user) || (g.kind === 'group' && !!g.to && p.groups.includes(g.to))))) {
      if (seen.has(g.resource)) continue;
      const node = await this.tree.get(g.resource);
      if (!node || !this.person(node.owner) || node.owner === user) continue;
      seen.add(g.resource);
      let name = node.name;
      for (let i = 2; taken.has(name); i++) name = node.kind === 'file' && node.name.includes('.') ? node.name.replace(/(\.[^.]*)$/, ` (${i})$1`) : `${node.name} (${i})`;
      taken.add(name);
      out.push({ name, grant: g, node });
    }
    return out;
  }

  async where(user: string, path: string): Promise<Where> {
    const s = steps(path);
    if (!s.length || (await this.tree.resolve(user, s[0]!))) return { owner: user, path: `/${s.join('/')}`, perms: ALL };
    const m = (await this.mounts(user)).find((x) => x.name === s[0]);
    if (!m) return { owner: user, path: `/${s.join('/')}`, perms: ALL };
    const base = await this.tree.pathOf(m.node);
    const rest = s.slice(1);
    const owner = m.node.owner;
    const inner = rest.length ? await this.tree.resolve(owner, `${base}/${rest.join('/')}`) : m.node;
    const p = this.person(user)!;
    const chain = inner ? [inner, ...(await this.tree.ancestors(inner))] : [m.node, ...(await this.tree.ancestors(m.node))];
    const bits = (await this.grants.effective(user, p.groups, chain.map((n) => ({ id: n.id, kind: n.kind })))) | m.grant.permissions;
    return { owner, path: rest.length ? `${base}/${rest.join('/')}` : base, perms: inner?.kind === 'file' ? bits & ~CREATE : bits, via: { grant: m.grant, at: `/${s[0]}` } };
  }

  async resolve(user: string, path: string): Promise<{ w: Where; node: Node | undefined }> {
    const w = await this.where(user, path);
    return { w, node: await this.tree.resolve(w.owner, w.path) };
  }

  /** A person's root etag also changes when anything shared with them changes, without writing to their tree. */
  async rootEtag(user: string): Promise<string> {
    const own = await this.tree.root(user);
    const ms = await this.mounts(user);
    if (!ms.length) return own.etag;
    return createHash('sha1')
      .update([own.etag, ...ms.map((m) => `${m.name}:${m.node.etag}`)].join('|'))
      .digest('hex')
      .slice(0, 16);
  }

  /** The children a person sees in a folder: their own, plus mounts at their root. */
  async children(user: string, path: string): Promise<{ name: string; node: Node; w: Where }[]> {
    const { w, node } = await this.resolve(user, path);
    if (!node || node.kind !== 'folder') return [];
    const base = path.replace(/\/+$/, '');
    const own = (await this.tree.list(node)).map((n) => ({ name: n.name, node: n, w: { ...w, path: `${w.path === '/' ? '' : w.path}/${n.name}`, perms: n.kind === 'file' ? w.perms & ~CREATE : w.perms } }));
    if (steps(path).length || w.owner !== user) return own;
    const ms = await this.mounts(user);
    const p = this.person(user)!;
    const mounted = await Promise.all(
      ms.map(async (m) => {
        const bits = (await this.grants.effective(user, p.groups, [m.node, ...(await this.tree.ancestors(m.node))].map((n) => ({ id: n.id, kind: n.kind })))) | m.grant.permissions;
        return { name: m.name, node: m.node, w: { owner: m.node.owner, path: await this.tree.pathOf(m.node), perms: m.node.kind === 'file' ? bits & ~CREATE : bits, via: { grant: m.grant, at: `${base}/${m.name}` } } };
      }),
    );
    return [...own, ...mounted].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The permission letters Nextcloud clients read: S shared, R reshare, M mounted, G read, D delete, NV rename and move, W write, CK create. */
  letters(node: Node, w: Where, mountRoot: boolean): string {
    const p = w.perms;
    const shared = !!w.via;
    let s = '';
    if (shared) s += 'S';
    if (p & SHARE) s += 'R';
    if (shared && mountRoot) s += 'M';
    if (p & READ) s += 'G';
    if (p & DELETE || (shared && mountRoot)) s += 'D';
    if (p & UPDATE || (shared && mountRoot)) s += 'NV';
    if (node.kind === 'file' && p & UPDATE) s += 'W';
    if (node.kind === 'folder' && p & CREATE) s += 'CK';
    return s;
  }

  /** Which kinds of share point at a node, as Nextcloud numbers them: 0 person, 1 group, 3 link. */
  async shareTypes(node: Node): Promise<number[]> {
    const gs = await this.grants.live((g) => g.resource === node.id);
    return [...new Set(gs.map((g) => (g.kind === 'person' ? 0 : g.kind === 'group' ? 1 : 3)))].sort();
  }

  // ---------------------------------------------------------------- changes

  /** The last step of a path a write would create, checked against the upload-safety policy before anything is kept. */
  private safe(path: string): void {
    const last = steps(path).pop();
    if (last) safeName(last);
  }

  private need(w: Where, bit: number, what: string) {
    if (!(w.perms & bit)) throw new Denied(`you may not ${what} here`);
  }

  private async parentWhere(user: string, path: string): Promise<Where> {
    const s = steps(path);
    if (!s.length) throw new Denied('the root cannot be written');
    return this.where(user, `/${s.slice(0, -1).join('/')}`);
  }

  async checkLock(w: Where, user: string, tokens: readonly string[], deep = false): Promise<void> {
    await this.leases.mayChange(`/${w.owner}${w.path}`, { owner: user, tokens }, deep);
  }

  /**
   * Writes a file from bytes already stored under `blob`. A file that existed keeps its id and gains a version;
   * `ifMatch` and `ifNoneMatch` make the write conditional on the etag the client last saw.
   */
  async commitFile(user: string, path: string, blob: { key: string; size: number; checksums: readonly string[] }, o: { mtime?: number; checksum?: string[]; ifMatch?: string | null; ifNoneMatch?: string | null; tokens?: readonly string[]; mime?: string } = {}): Promise<{ node: Node; created: boolean }> {
    const { w, node: before } = await this.resolve(user, path);
    try {
      this.safe(path);
      if (before?.kind === 'folder') throw new Exists(path);
      if (o.ifNoneMatch === '*' && before) throw new PreconditionFailed('the file exists');
      if (o.ifMatch && (!before || (o.ifMatch !== '*' && o.ifMatch.replace(/"/g, '') !== before.etag))) throw new PreconditionFailed('the file changed since you last read it');
      if (before) this.need(w, UPDATE, 'change this file');
      else this.need(await this.parentWhere(user, path), CREATE, 'add files');
      await this.checkLock(w, user, o.tokens ?? []);
      const free = await this.free(w.owner);
      const grow = blob.size - (before?.size ?? 0);
      if (free !== undefined && grow > free) throw new Insufficient(grow, free);
      const sums = o.checksum?.length ? o.checksum : blob.checksums.filter((c) => c.startsWith('SHA1:') || c.startsWith('MD5:') || c.startsWith('ADLER32:'));
      const { node } = await this.tree.put(w.owner, w.path, { size: blob.size, blob: blob.key, ...(o.mtime ? { mtime: o.mtime } : {}), ...(o.mime ? { mime: o.mime } : {}), checksums: sums });
      if (before?.blob) await this.keepVersion(before, user);
      return { node, created: !before };
    } catch (e) {
      await this.objects.delete(blob.key);
      throw e;
    }
  }

  async mkdir(user: string, path: string): Promise<Node> {
    this.safe(path);
    const w = await this.where(user, path);
    this.need(await this.parentWhere(user, path), CREATE, 'add folders');
    return this.tree.mkdir(w.owner, w.path);
  }

  /** Deletes to the trash: the item and everything under it can come back until the trash is swept. */
  async remove(user: string, path: string, tokens: readonly string[] = []): Promise<void> {
    const s = steps(path);
    const { w, node } = await this.resolve(user, path);
    if (!node) throw new NotFound(path);
    // Deleting a shared item at your own root leaves the share; the owner keeps it.
    if (w.via && s.length === 1) {
      if (w.via.grant.kind === 'person') await this.state.grants.delete(w.via.grant.id);
      else throw new Denied('a group share cannot be left by one member', 403);
      return;
    }
    this.need(w, DELETE, 'delete this');
    await this.checkLock(w, user, tokens, true);
    const gone = await this.tree.remove(w.owner, w.path);
    const t: Trashed = { id: `${node.name}.d${Math.floor(this.now() / 1000)}`, owner: w.owner, name: node.name, original: w.path, deletedAt: this.now(), nodes: gone };
    let id = t.id;
    for (let i = 1; this.state.doc.trash[`${w.owner}\u0000${id}`]; i++) id = `${t.id}.${i}`;
    this.state.doc.trash[`${w.owner}\u0000${id}`] = { ...t, id };
    this.state.mark('trash', `${w.owner}\u0000${id}`);
  }

  async move(user: string, from: string, to: string, overwrite: boolean, tokens: readonly string[] = []): Promise<{ node: Node; created: boolean }> {
    this.safe(to);
    const a = await this.resolve(user, from);
    if (!a.node) throw new NotFound(from);
    const b = await this.resolve(user, to);
    // Renaming a shared item at your root renames only where it sits for you; it is not supported yet, so say so.
    if (a.w.via && steps(from).length === 1) throw new Denied('a share mounted at your root cannot be moved yet', 403);
    this.need(a.w, a.node.kind === 'file' ? UPDATE : DELETE, 'move this');
    this.need(await this.parentWhere(user, to), CREATE, 'add things there');
    await this.checkLock(a.w, user, tokens, true);
    await this.checkLock(b.w, user, tokens, true);
    if (b.node && !overwrite) throw new PreconditionFailed(`${to} exists and overwrite is off`);
    if (a.w.owner === b.w.owner) {
      const r = await this.tree.move(a.w.owner, a.w.path, b.w.path, overwrite);
      await this.leases.rename(`/${a.w.owner}${a.w.path}`, `/${b.w.owner}${b.w.path}`);
      for (const n of r.replaced) if (n.blob) await this.objects.delete(n.blob);
      return { node: r.node, created: !b.node };
    }
    // Between two people's trees: the bytes are copied in the store, then the original goes.
    const c = await this.copy(user, from, to, overwrite);
    const gone = await this.tree.remove(a.w.owner, a.w.path);
    for (const n of gone) if (n.blob) await this.objects.delete(n.blob);
    return c;
  }

  async copy(user: string, from: string, to: string, overwrite: boolean): Promise<{ node: Node; created: boolean }> {
    this.safe(to);
    const a = await this.resolve(user, from);
    if (!a.node) throw new NotFound(from);
    this.need(a.w, READ, 'read this');
    const b = await this.resolve(user, to);
    this.need(await this.parentWhere(user, to), CREATE, 'add things there');
    if (b.node && !overwrite) throw new PreconditionFailed(`${to} exists and overwrite is off`);
    const free = await this.free(b.w.owner);
    if (free !== undefined && a.node.size - (b.node?.size ?? 0) > free) throw new Insufficient(a.node.size, free);
    const dup = async (blob: string) => (await this.objects.compose([blob])).key;
    if (a.w.owner === b.w.owner) {
      const r = await this.tree.copy(a.w.owner, a.w.path, b.w.path, overwrite, dup);
      for (const n of r.replaced) if (n.blob) await this.objects.delete(n.blob);
      return { node: r.node, created: !b.node };
    }
    const tree = this.tree;
    const into = async (src: Node, path: string): Promise<Node> => {
      if (src.kind === 'file') return (await tree.put(b.w.owner, path, { size: src.size, blob: await dup(src.blob!), mtime: src.mtime, ...(src.checksums ? { checksums: src.checksums } : {}) })).node;
      const made = (await tree.resolve(b.w.owner, path)) ?? (await tree.mkdir(b.w.owner, path));
      for (const k of await tree.list(src)) await into(k, `${path}/${k.name}`);
      return made;
    };
    if (b.node && overwrite) {
      const gone = await this.tree.remove(b.w.owner, b.w.path);
      for (const n of gone) if (n.blob) await this.objects.delete(n.blob);
    }
    return { node: await into(a.node, b.w.path), created: !b.node };
  }

  // ---------------------------------------------------------------- versions

  private async keepVersion(old: Node, author: string): Promise<void> {
    const list = this.state.doc.versions[String(old.id)] ?? [];
    list.push({ id: String(old.mtime), blob: old.blob!, size: old.size, mtime: old.mtime, etag: old.etag, closedAt: this.now(), author });
    const max = this.o.versions?.max ?? 50;
    while (list.length > max) {
      const v = list.shift()!;
      await this.objects.delete(v.blob);
    }
    this.state.doc.versions[String(old.id)] = list;
    this.state.mark('versions', String(old.id));
  }

  versionsOf(fileId: number): Version[] {
    return [...(this.state.doc.versions[String(fileId)] ?? [])].reverse();
  }

  /** Makes an old copy current again; the copy it replaces becomes a version, so nothing is lost. */
  async restoreVersion(user: string, fileId: number, versionId: string): Promise<Node> {
    const node = await this.tree.get(fileId);
    if (!node || node.kind !== 'file') throw new NotFound(String(fileId));
    const list = this.state.doc.versions[String(fileId)] ?? [];
    const v = list.find((x) => x.id === versionId);
    if (!v) throw new NotFound(versionId);
    const path = await this.tree.pathOf(node);
    if (node.owner !== user) {
      const p = this.person(user);
      const bits = p ? await this.grants.effective(user, p.groups, [node, ...(await this.tree.ancestors(node))].map((n) => ({ id: n.id, kind: n.kind }))) : 0;
      if (!(bits & UPDATE)) throw new Denied('you may not change this file');
    }
    const copy = await this.objects.compose([v.blob]);
    const { node: next } = await this.tree.put(node.owner, path, { size: v.size, blob: copy.key, mtime: v.mtime });
    await this.keepVersion(node, user);
    return next;
  }

  // ---------------------------------------------------------------- trash

  trashOf(owner: string): Trashed[] {
    return Object.values(this.state.doc.trash)
      .filter((t) => t.owner === owner)
      .sort((a, b) => b.deletedAt - a.deletedAt);
  }

  /** Puts a trashed item back where it was, or beside it with a suffix when that place is taken. */
  async restoreTrash(owner: string, id: string, to?: string): Promise<Node> {
    const t = this.state.doc.trash[`${owner}\u0000${id}`];
    if (!t) throw new NotFound(id);
    let want = to ?? t.original;
    const parentOf = (x: string) => x.split('/').slice(0, -1).join('/') || '/';
    if (!(await this.tree.resolve(owner, parentOf(want)))) want = `/${t.name}`;
    const dir = parentOf(want);
    const name = want.split('/').pop()!;
    const dot = t.nodes[0]!.kind === 'file' ? name.lastIndexOf('.') : -1;
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let target = want;
    for (let i = 2; await this.tree.resolve(owner, target); i++) target = `${dir === '/' ? '' : dir}/${stem} (${i})${ext}`;
    const free = await this.free(owner);
    if (free !== undefined && t.nodes[0]!.size > free) throw new Insufficient(t.nodes[0]!.size, free);
    const n = await this.tree.restore(owner, target, t.nodes);
    delete this.state.doc.trash[`${owner}\u0000${id}`];
    this.state.mark('trash', `${owner}\u0000${id}`);
    return n;
  }

  async purgeTrash(t: Trashed): Promise<void> {
    for (const n of t.nodes) {
      if (n.blob) await this.objects.delete(n.blob);
      for (const v of this.state.doc.versions[String(n.id)] ?? []) await this.objects.delete(v.blob);
      delete this.state.doc.versions[String(n.id)];
      this.state.mark('versions', String(n.id));
    }
    delete this.state.doc.trash[`${t.owner}\u0000${t.id}`];
    this.state.mark('trash', `${t.owner}\u0000${t.id}`);
  }

  async emptyTrash(owner: string): Promise<number> {
    const all = this.trashOf(owner);
    for (const t of all) await this.purgeTrash(t);
    return all.length;
  }

  /**
   * The nightly sweep, planned by the retention block: trash older than its days is purged, versions older than
   * theirs are dropped, idle uploads and expired grants go. Returns what it did, for the run record.
   */
  async sweep(): Promise<{ trash: number; versions: number; uploads: number; grants: number }> {
    const now = this.now();
    const items: Item[] = [
      ...Object.values(this.state.doc.trash).map((t) => ({ kind: 'trash', id: `${t.owner}\u0000${t.id}`, createdAt: t.deletedAt, trashedAt: t.deletedAt })),
      ...Object.entries(this.state.doc.versions).flatMap(([file, vs]) => vs.map((v) => ({ kind: 'version', id: `${file}\u0000${v.id}`, createdAt: v.mtime * 1000, closedAt: v.closedAt }))),
    ];
    const policies: Record<string, Policy> = { trash: { keepDays: null, then: 'purge', trashDays: this.o.trashDays ?? 30 }, version: { keepDays: this.o.versions?.days ?? 365, then: 'purge', trashDays: 0 } };
    const { steps: todo } = plan(items, policies, now);
    let trash = 0;
    let versions = 0;
    for (const s of todo) {
      if (s.kind === 'trash') {
        const t = this.state.doc.trash[s.id];
        if (t) {
          await this.purgeTrash(t);
          trash++;
        }
      } else {
        const [file, id] = s.id.split('\u0000');
        const list = this.state.doc.versions[file!] ?? [];
        const v = list.find((x) => x.id === id);
        if (v) {
          await this.objects.delete(v.blob);
          this.state.doc.versions[file!] = list.filter((x) => x !== v);
          this.state.mark('versions', file!);
          versions++;
        }
      }
    }
    const uploads = await this.uploads.sweep();
    const grants = await this.grants.sweep(async (id) => !!(await this.tree.get(id)));
    return { trash, versions, uploads, grants };
  }

  // ---------------------------------------------------------------- sharing

  /** Shares a path a person can see; what they may give is what they have there. */
  async share(user: string, path: string, i: { kind: 'person' | 'group' | 'link'; to?: string; permissions?: number; password?: string; expires?: number; note?: string; label?: string }): Promise<Grant> {
    const { w, node } = await this.resolve(user, path);
    if (!node) throw new NotFound(path);
    if (node.parent === null) throw new Denied('your whole folder cannot be shared', 400);
    if (i.kind === 'person' && i.to && !this.person(i.to)) throw new NotFound(i.to);
    return this.grants.create({ resource: node.id, resourceKind: node.kind, by: user, giverHas: w.perms, kind: i.kind, ...(i.to ? { to: i.to } : {}), ...(i.permissions !== undefined ? { permissions: i.permissions } : {}), ...(i.password ? { password: i.password } : {}), ...(i.expires !== undefined ? { expires: i.expires } : {}), ...(i.note ? { note: i.note } : {}), ...(i.label ? { label: i.label } : {}) });
  }

  /** Grants on paths a person owns, or made by them. */
  async sharesBy(user: string): Promise<Grant[]> {
    return this.grants.live((g) => g.by === user);
  }

  async sharesWith(user: string): Promise<Grant[]> {
    return (await this.mounts(user)).map((m) => m.grant);
  }
}
