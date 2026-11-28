/**
 * Everything Files remembers, other than file bytes: the folder tree, people, devices, grants, upload sessions,
 * the trash and file versions. Each block reads and writes it through its own store interface.
 *
 * It is kept as a write-ahead log. Each change appends only the records it touched (a file write is a few hundred
 * bytes, whatever the size of the tree), a snapshot is written every so often and the log before it dropped, and
 * a restart reads the snapshot and replays what came after. The server waits for a change to be in the log, forced
 * to disk, before it answers, so nothing a client was told is saved can be lost.
 *
 * One writer at a time suits Files on Cloud Run (one instance, scaling to zero). The log refuses a second writer
 * rather than interleave with it. The stores are interfaces, so a document database replaces this without any
 * block changing.
 */
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
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
  /** Raised on a password change and on disabling: a web session made before it no longer signs in. */
  readonly epoch?: number;
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

/** Writes a whole file and forces it to disk before returning. */
async function writeDurable(path: string, text: string): Promise<void> {
  const fh = await open(path, 'w');
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Forces a folder's entries (a file made or renamed in it) to disk. */
async function syncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export interface DiskPersistOptions {
  /** Told about anything repaired on load, such as a torn last line; it goes to the server's log. */
  readonly report?: (message: string) => void;
}

/**
 * A folder holding snapshot.json and one log file of JSON lines. Every entry is forced to disk (fsync) before
 * append returns, so a machine crash cannot lose a change a client was told is saved; a snapshot is written to a
 * temporary file, forced to disk, renamed into place, and the folder forced too, before the log is cut.
 */
export function diskPersist(dir: string, o: DiskPersistOptions = {}): Persist {
  const snap = join(dir, 'snapshot.json');
  const log = join(dir, 'log.jsonl');
  const report = o.report ?? ((m: string) => process.stderr.write(`${JSON.stringify({ severity: 'WARNING', message: m })}\n`));
  let dirSynced = false;
  return {
    async load() {
      await mkdir(dir, { recursive: true });
      const s = await readFile(snap, 'utf8').catch(() => null);
      const raw = await readFile(log, 'utf8').catch(() => '');
      const lines = raw.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      const parsed: Delta[] = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]!;
        try {
          parsed.push(JSON.parse(l) as Delta);
        } catch {
          if (i < lines.length - 1)
            throw new Error(`the state log ${log} is damaged at line ${i + 1} of ${lines.length}, which is not the last line: that is corruption, not a write cut short by a crash. Files will not start on it; restore the state folder from a backup, or inspect that line.`);
          // The last line torn by a crash mid-write was never acknowledged: it is reported and cut off, so the next
          // entry starts on a line of its own.
          report(`the state log ended in a torn line of ${l.length} characters, written when a crash cut a write short; it was never acknowledged and has been dropped`);
          const keep = Buffer.byteLength(lines.slice(0, i).map((x) => `${x}\n`).join(''));
          const fh = await open(log, 'r+');
          try {
            await fh.truncate(keep);
            await fh.sync();
          } finally {
            await fh.close();
          }
        }
      }
      // A whole last entry whose newline was lost gets it back before anything is appended after it.
      if (raw && !raw.endsWith('\n') && parsed.length === lines.length) {
        const fh = await open(log, 'a');
        try {
          await fh.write('\n');
          await fh.sync();
        } finally {
          await fh.close();
        }
      }
      const after = s ? (JSON.parse(s) as { n: number }).n : 0;
      return { snapshot: s, log: parsed.filter((d) => d.n > after).map((d) => JSON.stringify(d)) };
    },
    async append(_n, text) {
      const fh = await open(log, 'a');
      try {
        await fh.write(`${text}\n`);
        await fh.sync();
      } finally {
        await fh.close();
      }
      // The first append may have made the log file: its folder entry is forced to disk too.
      if (!dirSynced) {
        await syncDir(dir);
        dirSynced = true;
      }
    },
    async snapshot(n, text) {
      const tmp = `${snap}.${process.pid}.tmp`;
      await writeDurable(tmp, text);
      await rename(tmp, snap);
      // The new snapshot must be on disk before the log entries it holds are dropped.
      await syncDir(dir);
      const lines = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
      const keep = lines.filter((l) => {
        try {
          return (JSON.parse(l) as Delta).n > n;
        } catch {
          return false;
        }
      });
      const t2 = `${log}.${process.pid}.tmp`;
      await writeDurable(t2, keep.map((l) => `${l}\n`).join(''));
      await rename(t2, log);
      await syncDir(dir);
      dirSynced = true;
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
      this.writing = this.writing.then(() => this.write()).catch(() => {
        // The records stay marked (write puts them back), so the next write, or the flush waiting on this one,
        // tries them again; nobody is told they are saved until an append that holds them succeeds.
      });
    });
  }

  private async write(): Promise<void> {
    if (!this.dirty.size) return;
    const taken = this.dirty;
    this.dirty = new Map();
    const put: Delta['put'] = {};
    for (const [c, keys] of taken) {
      const src = this.doc[c] as Record<string, unknown>;
      const rec: Record<string, unknown> = {};
      for (const k of keys) rec[k] = k in src ? src[k] : null;
      if (keys.size) put[c] = rec;
    }
    const d: Delta = { n: this.n + 1, seq: { ...this.doc.seq }, put };
    try {
      await this.persist.append(d.n, JSON.stringify(d));
    } catch (e) {
      // Not in the log: mark the records again, merged with anything changed meanwhile, so they are not forgotten.
      for (const [c, keys] of taken) {
        const now = this.dirty.get(c) ?? new Set<string>();
        for (const k of keys) now.add(k);
        this.dirty.set(c, now);
      }
      throw e;
    }
    this.n = d.n;
    if (++this.sinceSnapshot >= this.every) {
      // The entry is in the log, so the change is saved whatever happens here; a snapshot that fails is tried
      // again after the next entry.
      try {
        await this.persist.snapshot(this.n, JSON.stringify({ n: this.n, doc: this.doc }));
        this.sinceSnapshot = 0;
      } catch {
        /* retried with the next entry */
      }
    }
  }

  /**
   * Waits until every change so far is in the log. If a write failed, its records are still marked and are
   * written again here; a failure of that write is thrown to the request that waits, so every waiting request
   * either sees its change in the log or hears that it is not.
   */
  async flush(): Promise<void> {
    if (this.scheduled) await new Promise<void>((ok) => setImmediate(ok));
    await this.writing;
    if (this.dirty.size) {
      const p = this.writing.then(() => this.write());
      this.writing = p.catch(() => {});
      await p;
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
