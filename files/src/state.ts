/**
 * Everything Files remembers, other than file bytes: the folder tree, people, devices, grants, upload sessions,
 * the trash and file versions. Each block reads and writes it through its own store interface.
 *
 * It is kept as a write-ahead log. Each change appends only the records it touched (a file write is a few hundred
 * bytes, whatever the size of the tree), a snapshot is written every so often and the log before it dropped, and
 * a restart reads the snapshot and replays what came after. The server waits for a change to be in the log before
 * it answers, so nothing a client was told is saved can be lost.
 *
 * One writer at a time suits Files on Cloud Run (one instance, scaling to zero). The log refuses a second writer
 * rather than interleave with it. The stores are interfaces, so a document database replaces this without any
 * block changing.
 */
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeviceStore, Device, Flow } from '../../intent/blocks/devices/index.ts';
import type { Grant, GrantStore } from '../../intent/blocks/grants/index.ts';
import type { Node, NodeStore } from '../../intent/blocks/tree/index.ts';
import type { Session, SessionStore } from '../../intent/blocks/uploads/index.ts';

export interface Person {
  readonly id: string;
  readonly display: string;
  readonly passwordHash: string;
  /** Bytes they may store; null means no limit. */
  readonly quota: number | null;
  readonly admin: boolean;
  readonly groups: readonly string[];
  readonly email?: string;
  readonly created: number;
  readonly disabled?: boolean;
}

export interface Trashed {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  /** Where it was, from the owner's root. */
  readonly original: string;
  readonly deletedAt: number;
  /** The removed node first, then everything that was under it. */
  readonly nodes: readonly Node[];
}

export interface Version {
  /** The modification time it had, which is what clients see as the version's name. */
  readonly id: string;
  readonly blob: string;
  readonly size: number;
  readonly mtime: number;
  readonly etag: string;
  /** When a newer copy replaced it. */
  readonly closedAt: number;
  readonly author: string;
}

export interface Doc {
  schema: 'zthr-files/1';
  instance: string;
  seq: { node: number; grant: number; device: number };
  nodes: Record<string, Node>;
  people: Record<string, Person>;
  devices: Record<string, Device>;
  grants: Record<string, Grant>;
  sessions: Record<string, Session>;
  trash: Record<string, Trashed>;
  versions: Record<string, Version[]>;
}

export type Collection = 'nodes' | 'people' | 'devices' | 'grants' | 'sessions' | 'trash' | 'versions';
const COLLECTIONS: readonly Collection[] = ['nodes', 'people', 'devices', 'grants', 'sessions', 'trash', 'versions'];

/** One entry in the log: the records written (a value) or removed (null), and the counters as they now stand. */
interface Delta {
  readonly n: number;
  readonly seq: Doc['seq'];
  readonly put: Partial<Record<Collection, Record<string, unknown>>>;
}

export interface Persist {
  /** The last snapshot and every log entry after it, in order. */
  load(): Promise<{ snapshot: string | null; log: string[] }>;
  /** Adds entry `n` to the log; an entry that already exists is a second writer, and is refused. */
  append(n: number, text: string): Promise<void>;
  /** Writes a snapshot that includes every entry up to `n`, then drops those entries. */
  snapshot(n: number, text: string): Promise<void>;
}

export const memoryPersist = (): Persist & { snap: string | null; entries: Map<number, string> } => {
  const p = {
    snap: null as string | null,
    entries: new Map<number, string>(),
    load: async () => ({ snapshot: p.snap, log: [...p.entries.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]) }),
    append: async (n: number, t: string) => {
      if (p.entries.has(n)) throw new Error(`log entry ${n} exists: another writer`);
      p.entries.set(n, t);
    },
    snapshot: async (n: number, t: string) => {
      p.snap = t;
      for (const k of [...p.entries.keys()]) if (k <= n) p.entries.delete(k);
    },
  };
  return p;
};

/** A folder holding snapshot.json and one log file of JSON lines, appended and replaced atomically. */
export function diskPersist(dir: string): Persist {
  const snap = join(dir, 'snapshot.json');
  const log = join(dir, 'log.jsonl');
  return {
    async load() {
      await mkdir(dir, { recursive: true });
      const s = await readFile(snap, 'utf8').catch(() => null);
      const lines = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
      // A line torn by a crash mid-write is the last one, and was never acknowledged: it is dropped.
      const whole = lines.filter((l, i) => {
        if (i < lines.length - 1) return true;
        try {
          JSON.parse(l);
          return true;
        } catch {
          return false;
        }
      });
      const after = s ? (JSON.parse(s) as { n: number }).n : 0;
      return { snapshot: s, log: whole.filter((l) => (JSON.parse(l) as Delta).n > after) };
    },
    append: async (_n, text) => appendFile(log, `${text}\n`),
    async snapshot(n, text) {
      const tmp = `${snap}.${process.pid}.tmp`;
      await writeFile(tmp, text);
      await rename(tmp, snap);
      const lines = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
      const keep = lines.filter((l) => {
        try {
          return (JSON.parse(l) as Delta).n > n;
        } catch {
          return false;
        }
      });
      const t2 = `${log}.${process.pid}.tmp`;
      await writeFile(t2, keep.map((l) => `${l}\n`).join(''));
      await rename(t2, log);
    },
  };
}

/** For tools and tests: every file a disk store has. */
export const diskStateFiles = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort();
export const removeDiskState = (dir: string) => rm(dir, { recursive: true, force: true });

const instanceId = () => `oc${Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

export const emptyDoc = (): Doc => ({ schema: 'zthr-files/1', instance: instanceId(), seq: { node: 0, grant: 0, device: 0 }, nodes: {}, people: {}, devices: {}, grants: {}, sessions: {}, trash: {}, versions: {} });

export interface StateOptions {
  /** Write a snapshot after this many log entries. */
  readonly snapshotEvery?: number;
}

export class State {
  doc: Doc;
  private readonly persist: Persist;
  private readonly every: number;
  private n: number;
  private sinceSnapshot: number;
  private dirty = new Map<Collection, Set<string>>();
  private writing: Promise<void> = Promise.resolve();
  private scheduled = false;
  private failed: unknown = null;
  /** Indexes rebuilt from the document, never saved. */
  private kids = new Map<number, Map<string, number>>();
  private roots = new Map<string, number>();

  private constructor(doc: Doc, persist: Persist, n: number, since: number, o: StateOptions) {
    this.doc = doc;
    this.persist = persist;
    this.n = n;
    this.sinceSnapshot = since;
    this.every = o.snapshotEvery ?? 2000;
    this.reindex();
  }

  static async open(persist: Persist, o: StateOptions = {}): Promise<State> {
    const { snapshot, log } = await persist.load();
    const snap = snapshot ? (JSON.parse(snapshot) as { n: number; doc: Doc }) : { n: 0, doc: emptyDoc() };
    if (snap.doc.schema !== 'zthr-files/1') throw new Error(`cannot read a ${String(snap.doc.schema)} document`);
    const doc = snap.doc;
    let n = snap.n;
    for (const line of log) {
      const d = JSON.parse(line) as Delta;
      if (d.n !== n + 1) throw new Error(`the log jumps from entry ${n} to ${d.n}`);
      apply(doc, d);
      n = d.n;
    }
    const st = new State(doc, persist, n, log.length, o);
    // Without a snapshot, a new store writes its first one now, so the instance id is fixed from the start.
    if (!snapshot) await persist.snapshot(n, JSON.stringify({ n, doc }));
    return st;
  }

  private reindex() {
    this.kids.clear();
    this.roots.clear();
    for (const n of Object.values(this.doc.nodes)) this.index(n);
  }

  private index(n: Node) {
    if (n.parent === null) this.roots.set(n.owner, n.id);
    else {
      const m = this.kids.get(n.parent) ?? new Map<string, number>();
      m.set(n.name, n.id);
      this.kids.set(n.parent, m);
    }
  }

  private unindex(n: Node) {
    if (n.parent === null) this.roots.delete(n.owner);
    else this.kids.get(n.parent)?.delete(n.name);
  }

  /** Records that a record changed (or went); it is written with everything else changed in this tick. */
  mark(c: Collection, key: string): void {
    const s = this.dirty.get(c) ?? new Set<string>();
    s.add(key);
    this.dirty.set(c, s);
    this.schedule();
  }

  /** The counters changed. */
  markSeq(): void {
    this.dirty.set('nodes', this.dirty.get('nodes') ?? new Set());
    this.schedule();
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.writing = this.writing.then(() => this.write()).catch((e) => {
        this.failed = e;
      });
    });
  }

  private async write(): Promise<void> {
    if (!this.dirty.size) return;
    const put: Delta['put'] = {};
    for (const [c, keys] of this.dirty) {
      const src = this.doc[c] as Record<string, unknown>;
      const rec: Record<string, unknown> = {};
      for (const k of keys) rec[k] = k in src ? src[k] : null;
      if (keys.size) put[c] = rec;
    }
    this.dirty.clear();
    const d: Delta = { n: this.n + 1, seq: { ...this.doc.seq }, put };
    await this.persist.append(d.n, JSON.stringify(d));
    this.n = d.n;
    if (++this.sinceSnapshot >= this.every) {
      await this.persist.snapshot(this.n, JSON.stringify({ n: this.n, doc: this.doc }));
      this.sinceSnapshot = 0;
    }
  }

  /** Waits until every change so far is in the log; a failed write is reported here, to the request that waits. */
  async flush(): Promise<void> {
    if (this.scheduled || this.dirty.size) {
      await new Promise<void>((ok) => setImmediate(ok));
    }
    await this.writing;
    if (this.dirty.size) await (this.writing = this.writing.then(() => this.write()));
    if (this.failed) {
      const e = this.failed;
      this.failed = null;
      throw e;
    }
  }

  /** Writes a snapshot now, as on shutdown, so the next start replays nothing. */
  async compact(): Promise<void> {
    await this.flush();
    await this.persist.snapshot(this.n, JSON.stringify({ n: this.n, doc: this.doc }));
    this.sinceSnapshot = 0;
  }

  readonly nodes: NodeStore = {
    get: async (id) => this.doc.nodes[String(id)],
    child: async (p, name) => {
      const id = this.kids.get(p)?.get(name);
      return id === undefined ? undefined : this.doc.nodes[String(id)];
    },
    children: async (p) =>
      [...(this.kids.get(p)?.values() ?? [])]
        .map((id) => this.doc.nodes[String(id)]!)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    root: async (owner) => {
      const id = this.roots.get(owner);
      return id === undefined ? undefined : this.doc.nodes[String(id)];
    },
    commit: async (put, remove) => {
      for (const id of remove) {
        const n = this.doc.nodes[String(id)];
        if (n) {
          this.unindex(n);
          delete this.doc.nodes[String(id)];
          this.kids.delete(id);
          this.mark('nodes', String(id));
        }
      }
      for (const n of put) {
        const old = this.doc.nodes[String(n.id)];
        if (old) this.unindex(old);
        this.doc.nodes[String(n.id)] = n;
        this.index(n);
        this.mark('nodes', String(n.id));
      }
    },
    nextId: async () => {
      this.markSeq();
      return ++this.doc.seq.node;
    },
  };

  readonly grants: GrantStore = {
    all: async () => Object.values(this.doc.grants),
    get: async (id) => this.doc.grants[String(id)],
    set: async (g) => {
      this.doc.grants[String(g.id)] = g;
      this.mark('grants', String(g.id));
    },
    delete: async (id) => {
      delete this.doc.grants[String(id)];
      this.mark('grants', String(id));
    },
    nextId: async () => {
      this.markSeq();
      return ++this.doc.seq.grant;
    },
  };

  private flows = new Map<string, Flow>();
  readonly devices: DeviceStore = {
    all: async () => Object.values(this.doc.devices),
    byHash: async (h) => Object.values(this.doc.devices).find((d) => d.hash === h),
    set: async (d) => {
      this.doc.devices[String(d.id)] = d;
      this.mark('devices', String(d.id));
    },
    delete: async (id) => {
      delete this.doc.devices[String(id)];
      this.mark('devices', String(id));
    },
    nextId: async () => {
      this.markSeq();
      return ++this.doc.seq.device;
    },
    // Sign-in flows live twenty minutes and are never worth saving: a restart only means signing in again.
    flows: {
      get: async (k) => this.flows.get(k),
      set: async (f) => {
        this.flows.set(f.poll, f);
        this.flows.set(f.login, f);
      },
      delete: async (f) => {
        this.flows.delete(f.poll);
        this.flows.delete(f.login);
      },
    },
  };

  readonly sessions: SessionStore = {
    get: async (o, id) => this.doc.sessions[`${o}\u0000${id}`],
    set: async (s) => {
      this.doc.sessions[`${s.owner}\u0000${s.id}`] = s;
      this.mark('sessions', `${s.owner}\u0000${s.id}`);
    },
    delete: async (o, id) => {
      delete this.doc.sessions[`${o}\u0000${id}`];
      this.mark('sessions', `${o}\u0000${id}`);
    },
    all: async () => Object.values(this.doc.sessions),
  };
}

function apply(doc: Doc, d: Delta) {
  doc.seq = { ...d.seq };
  for (const c of COLLECTIONS) {
    const recs = d.put[c];
    if (!recs) continue;
    const dst = doc[c] as Record<string, unknown>;
    for (const [k, v] of Object.entries(recs)) {
      if (v === null) delete dst[k];
      else dst[k] = v;
    }
  }
}
