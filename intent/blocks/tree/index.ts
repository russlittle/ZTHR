/**
 * A namespace tree: folders and files with stable ids, where every change gives the changed node and each of its
 * ancestors a new etag, and keeps each folder's total size. A sync client compares one folder etag and skips the
 * whole subtree when it is unchanged, so a change costs one write per ancestor, never a scan. Moves and renames are
 * one record each: no path is stored anywhere but in a node's name and parent.
 *
 * Every mutation runs inside one owner's queue, so two changes to the same tree never interleave. The store is
 * an interface: memory here, a document database in production. A store that can write many records atomically
 * keeps every etag and size consistent after a crash as well.
 */

export type Kind = 'file' | 'folder';

export interface Node {
  readonly id: number;
  readonly parent: number | null;
  readonly owner: string;
  readonly name: string;
  readonly kind: Kind;
  /** Bytes for a file; the sum of everything inside for a folder. */
  readonly size: number;
  /** Seconds since the epoch, as clients send and expect it. */
  readonly mtime: number;
  readonly etag: string;
  /** Where the bytes live, for a file. */
  readonly blob?: string;
  readonly mime?: string;
  /** Checksums as "ALGO:hex" pairs, as clients store them. */
  readonly checksums?: readonly string[];
  /** Properties set by clients (favourite, tags), keyed by "{namespace}name". */
  readonly props?: Readonly<Record<string, string>>;
}

export interface NodeStore {
  get(id: number): Promise<Node | undefined>;
  child(parent: number, name: string): Promise<Node | undefined>;
  children(parent: number): Promise<Node[]>;
  root(owner: string): Promise<Node | undefined>;
  /** Writes and deletes together: a store that can, does both atomically. */
  commit(put: readonly Node[], remove: readonly number[]): Promise<void>;
  nextId(): Promise<number>;
}

export class NotFound extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`nothing at ${path}`);
    this.path = path;
  }
}

/** The parent of the target does not exist (WebDAV answers 409). */
export class MissingParent extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`the folder for ${path} does not exist`);
    this.path = path;
  }
}

export class Exists extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`${path} already exists`);
    this.path = path;
  }
}

export class InvalidName extends Error {
  readonly name_: string;
  constructor(name: string, why: string) {
    super(`"${name}" is not a valid name: ${why}`);
    this.name_ = name;
  }
}

/** A move or copy into itself or below itself. */
export class IntoItself extends Error {
  constructor(from: string, to: string) {
    super(`cannot put ${from} inside itself at ${to}`);
  }
}

export function memoryNodes(): NodeStore {
  const byId = new Map<number, Node>();
  const kids = new Map<number, Map<string, number>>();
  const roots = new Map<string, number>();
  let seq = 0;
  const index = (n: Node) => {
    if (n.parent === null) roots.set(n.owner, n.id);
    else {
      const m = kids.get(n.parent) ?? new Map<string, number>();
      m.set(n.name, n.id);
      kids.set(n.parent, m);
    }
  };
  const unindex = (n: Node) => {
    if (n.parent === null) roots.delete(n.owner);
    else kids.get(n.parent)?.delete(n.name);
  };
  return {
    get: async (id) => byId.get(id),
    child: async (p, name) => {
      const id = kids.get(p)?.get(name);
      return id === undefined ? undefined : byId.get(id);
    },
    children: async (p) => [...(kids.get(p)?.values() ?? [])].map((id) => byId.get(id)!).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    root: async (owner) => {
      const id = roots.get(owner);
      return id === undefined ? undefined : byId.get(id);
    },
    commit: async (put, remove) => {
      for (const id of remove) {
        const n = byId.get(id);
        if (n) {
          unindex(n);
          byId.delete(id);
          kids.delete(id);
        }
      }
      for (const n of put) {
        const old = byId.get(n.id);
        if (old) unindex(old);
        byId.set(n.id, n);
        index(n);
      }
    },
    nextId: async () => ++seq,
  };
}

/** Names as a file system allows them everywhere a client runs. */
export function checkName(name: string): void {
  if (!name) throw new InvalidName(name, 'it is empty');
  if (name === '.' || name === '..') throw new InvalidName(name, 'it is a path step');
  if (/[/\\\0]/.test(name)) throw new InvalidName(name, 'it contains a slash or a null');
  if (new TextEncoder().encode(name).length > 250) throw new InvalidName(name, 'it is longer than 250 bytes');
  if (name !== name.trim()) throw new InvalidName(name, 'it starts or ends with a space');
}

/** A path's steps: "/a/b/" and "a/b" are the same; "." and ".." are refused rather than resolved. */
export function steps(path: string): string[] {
  const s = path.split('/').filter((x) => x !== '');
  for (const x of s) checkName(x);
  return s;
}

export interface TreeOptions {
  readonly now?: () => number;
  readonly etag?: () => string;
}

export interface FileInput {
  readonly size: number;
  readonly blob: string;
  readonly mtime?: number;
  readonly mime?: string;
  readonly checksums?: readonly string[];
}

export interface Change {
  /** The node as it was before, when it existed. */
  readonly before?: Node;
  readonly node: Node;
}

const randomEtag = () => {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

export class Tree {
  private readonly store: NodeStore;
  private readonly now: () => number;
  private readonly etag: () => string;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(store: NodeStore, o: TreeOptions = {}) {
    this.store = store;
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    this.etag = o.etag ?? randomEtag;
  }

  /** Runs one change to an owner's tree after every change queued before it. */
  private serial<T>(owner: string, run: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(owner) ?? Promise.resolve();
    const next = prev.then(run, run);
    const tail = next.catch(() => undefined);
    this.queues.set(owner, tail);
    void tail.then(() => {
      if (this.queues.get(owner) === tail) this.queues.delete(owner);
    });
    return next;
  }

  async root(owner: string): Promise<Node> {
    const r = await this.store.root(owner);
    if (r) return r;
    // Its own queue: a change already queued for this owner looks the root up, and must not wait on itself.
    return this.serial(`\0root:${owner}`, async () => {
      const again = await this.store.root(owner);
      if (again) return again;
      const n: Node = { id: await this.store.nextId(), parent: null, owner, name: '', kind: 'folder', size: 0, mtime: this.now(), etag: this.etag() };
      await this.store.commit([n], []);
      return n;
    });
  }

  async resolve(owner: string, path: string): Promise<Node | undefined> {
    let n: Node | undefined = await this.root(owner);
    for (const s of steps(path)) {
      if (!n || n.kind !== 'folder') return undefined;
      n = await this.store.child(n.id, s);
    }
    return n;
  }

  async get(id: number): Promise<Node | undefined> {
    return this.store.get(id);
  }

  async list(folder: Node): Promise<Node[]> {
    return folder.kind === 'folder' ? this.store.children(folder.id) : [];
  }

  /** The node's path from its owner's root, as "/a/b". */
  async pathOf(n: Node): Promise<string> {
    const names: string[] = [];
    let cur: Node | undefined = n;
    while (cur && cur.parent !== null) {
      names.unshift(cur.name);
      cur = await this.store.get(cur.parent);
    }
    return `/${names.join('/')}`;
  }

  async ancestors(n: Node): Promise<Node[]> {
    const out: Node[] = [];
    let p = n.parent;
    while (p !== null) {
      const a = await this.store.get(p);
      if (!a) break;
      out.push(a);
      p = a.parent;
    }
    return out;
  }

  /** Every node below a folder, depth first; a file has none. */
  async descendants(n: Node): Promise<Node[]> {
    if (n.kind !== 'folder') return [];
    const out: Node[] = [];
    for (const c of await this.store.children(n.id)) {
      out.push(c);
      out.push(...(await this.descendants(c)));
    }
    return out;
  }

  private async parentFor(owner: string, path: string): Promise<{ parent: Node; name: string }> {
    const s = steps(path);
    if (!s.length) throw new Exists('/');
    const name = s.pop()!;
    const parent = await this.resolve(owner, s.join('/'));
    if (!parent || parent.kind !== 'folder') throw new MissingParent(path);
    return { parent, name };
  }

  /**
   * New etags and sizes for every ancestor of a change. `delta` is the change in bytes under them. The nodes
   * returned are written together with the change itself.
   */
  private async bubble(from: Node | null, delta: number, mtime: number, skip: ReadonlySet<number> = new Set()): Promise<Node[]> {
    const out: Node[] = [];
    let cur = from;
    while (cur) {
      if (!skip.has(cur.id)) out.push({ ...cur, size: Math.max(0, cur.size + delta), mtime: Math.max(cur.mtime, mtime), etag: this.etag() });
      cur = cur.parent === null ? null : ((await this.store.get(cur.parent)) ?? null);
    }
    return out;
  }

  async mkdir(owner: string, path: string): Promise<Node> {
    return this.serial(owner, async () => {
      const { parent, name } = await this.parentFor(owner, path);
      if (await this.store.child(parent.id, name)) throw new Exists(path);
      const t = this.now();
      const n: Node = { id: await this.store.nextId(), parent: parent.id, owner, name, kind: 'folder', size: 0, mtime: t, etag: this.etag() };
      await this.store.commit([n, ...(await this.bubble(parent, 0, t))], []);
      return n;
    });
  }

  /** Writes a file, new or over an existing one; a folder in the way is refused. */
  async put(owner: string, path: string, f: FileInput): Promise<Change> {
    return this.serial(owner, async () => {
      const { parent, name } = await this.parentFor(owner, path);
      const before = await this.store.child(parent.id, name);
      if (before?.kind === 'folder') throw new Exists(path);
      const t = f.mtime ?? this.now();
      const node: Node = {
        id: before?.id ?? (await this.store.nextId()),
        parent: parent.id,
        owner,
        name,
        kind: 'file',
        size: f.size,
        mtime: t,
        etag: this.etag(),
        blob: f.blob,
        ...(f.mime ? { mime: f.mime } : {}),
        ...(f.checksums?.length ? { checksums: f.checksums } : {}),
        ...(before?.props ? { props: before.props } : {}),
      };
      await this.store.commit([node, ...(await this.bubble(parent, f.size - (before?.size ?? 0), this.now()))], []);
      return { ...(before ? { before } : {}), node };
    });
  }

  /** Removes a node and everything under it; returns what was removed, the node first, for a trash to keep. */
  async remove(owner: string, path: string): Promise<Node[]> {
    return this.serial(owner, async () => {
      const n = await this.resolve(owner, path);
      if (!n) throw new NotFound(path);
      if (n.parent === null) throw new InvalidName('/', 'the root cannot be removed');
      const gone = [n, ...(await this.descendants(n))];
      const parent = (await this.store.get(n.parent))!;
      await this.store.commit(await this.bubble(parent, -n.size, this.now()), gone.map((x) => x.id));
      return gone;
    });
  }

  /** Puts a removed subtree back under the folder at `path`'s parent, keeping every id. */
  async restore(owner: string, path: string, nodes: readonly Node[]): Promise<Node> {
    return this.serial(owner, async () => {
      const { parent, name } = await this.parentFor(owner, path);
      if (await this.store.child(parent.id, name)) throw new Exists(path);
      const [top, ...rest] = nodes;
      if (!top) throw new NotFound(path);
      const placed: Node = { ...top, parent: parent.id, name, etag: this.etag() };
      await this.store.commit([placed, ...rest, ...(await this.bubble(parent, top.size, this.now()))], []);
      return placed;
    });
  }

  /** Moves or renames: one record changes, and both old and new ancestors get new etags. */
  async move(owner: string, from: string, to: string, overwrite = false): Promise<{ node: Node; replaced: Node[] }> {
    return this.serial(owner, async () => {
      const n = await this.resolve(owner, from);
      if (!n) throw new NotFound(from);
      if (n.parent === null) throw new InvalidName('/', 'the root cannot be moved');
      const { parent, name } = await this.parentFor(owner, to);
      if (parent.id === n.id || (await this.ancestors(parent)).some((a) => a.id === n.id)) throw new IntoItself(from, to);
      const existing = await this.store.child(parent.id, name);
      if (existing?.id === n.id) return { node: n, replaced: [] };
      if (existing && !overwrite) throw new Exists(to);
      const replaced = existing ? [existing, ...(await this.descendants(existing))] : [];
      const t = this.now();
      const moved: Node = { ...n, parent: parent.id, name, etag: this.etag() };
      const oldParent = (await this.store.get(n.parent))!;
      // Each ancestor is written once with its net change: shared ancestors of both folders see only what was replaced.
      const up = oldParent.id === parent.id ? await this.bubble(parent, -(existing?.size ?? 0), t) : await this.netBubble(oldParent, parent, n.size, existing?.size ?? 0, t);
      await this.store.commit([moved, ...up], replaced.map((x) => x.id));
      return { node: moved, replaced };
    });
  }

  /** Sizes and etags for a move between two folders: each ancestor written once, with its net change. */
  private async netBubble(from: Node, to: Node, size: number, replaced: number, t: number): Promise<Node[]> {
    const delta = new Map<number, number>();
    const nodes = new Map<number, Node>();
    for (const [start, d] of [
      [from, -size],
      [to, size - replaced],
    ] as const) {
      let cur: Node | null = start;
      while (cur) {
        nodes.set(cur.id, cur);
        delta.set(cur.id, (delta.get(cur.id) ?? 0) + d);
        cur = cur.parent === null ? null : ((await this.store.get(cur.parent)) ?? null);
      }
    }
    return [...nodes.values()].map((n) => ({ ...n, size: Math.max(0, n.size + delta.get(n.id)!), mtime: Math.max(n.mtime, t), etag: this.etag() }));
  }

  /** Copies a subtree; files point at the same bytes (`share` decides whether a blob may be shared or must be copied). */
  async copy(owner: string, from: string, to: string, overwrite = false, share: (blob: string) => Promise<string> = async (b) => b): Promise<{ node: Node; replaced: Node[] }> {
    return this.serial(owner, async () => {
      const n = await this.resolve(owner, from);
      if (!n) throw new NotFound(from);
      const { parent, name } = await this.parentFor(owner, to);
      if (n.kind === 'folder' && (parent.id === n.id || (await this.ancestors(parent)).some((a) => a.id === n.id))) throw new IntoItself(from, to);
      const existing = await this.store.child(parent.id, name);
      if (existing && !overwrite) throw new Exists(to);
      const replaced = existing ? [existing, ...(await this.descendants(existing))] : [];
      const t = this.now();
      const made: Node[] = [];
      const clone = async (src: Node, into: number, as: string): Promise<Node> => {
        const c: Node = { ...src, id: await this.store.nextId(), parent: into, name: as, etag: this.etag(), ...(src.blob ? { blob: await share(src.blob) } : {}) };
        made.push(c);
        if (src.kind === 'folder') for (const k of await this.store.children(src.id)) await clone(k, c.id, k.name);
        return c;
      };
      const top = await clone(n, parent.id, name);
      await this.store.commit([...made, ...(await this.bubble(parent, n.size - (existing?.size ?? 0), t))], replaced.map((x) => x.id));
      return { node: top, replaced };
    });
  }

  /** Sets or clears client properties; the node keeps its etag, since its content did not change. */
  async setProps(owner: string, path: string, set: Readonly<Record<string, string>>, clear: readonly string[] = []): Promise<Node> {
    return this.serial(owner, async () => {
      const n = await this.resolve(owner, path);
      if (!n) throw new NotFound(path);
      const props = { ...(n.props ?? {}), ...set };
      for (const k of clear) delete props[k];
      const next: Node = { ...n, props };
      await this.store.commit([next], []);
      return next;
    });
  }

  /** Sets a file's modification time, as clients do after an upload. */
  async touch(owner: string, path: string, mtime: number): Promise<Node> {
    return this.serial(owner, async () => {
      const n = await this.resolve(owner, path);
      if (!n) throw new NotFound(path);
      const next: Node = { ...n, mtime };
      await this.store.commit([next], []);
      return next;
    });
  }
}
