/**
 * One sync engine for every outside system (a ticket tracker, a wiki, a data warehouse). An adapter says how to
 * list changes since a cursor and how to upsert by an external id; the engine pulls and pushes in pages, keeps the
 * cursor only after a page is fully applied (so a crash repeats a page rather than skipping one), maps records both
 * ways, merges edits to different fields made on each side, and settles a field changed on both sides by a declared
 * rule, reporting each conflict. Twins of the three kinds of system make every path testable without an account
 * anywhere; like the real ones, they send our own writes back in the change feed, and the engine recognises that
 * echo by comparing with what the remote held at the last sync.
 */

export interface Remote {
  readonly id: string;
  readonly updated: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface Adapter {
  readonly name: string;
  changes(cursor: string | undefined, limit: number): Promise<{ items: readonly Remote[]; cursor: string | undefined; more: boolean }>;
  upsert(id: string | undefined, fields: Readonly<Record<string, unknown>>): Promise<Remote>;
}

export interface Local {
  readonly id: string;
  readonly updated: string;
  fields: Record<string, unknown>;
  remoteId?: string;
  syncedAt?: string;
  /** The remote record's fields, mapped to ours, as of the last sync: what tells a remote change from an echo. */
  base?: Record<string, unknown>;
}

export type ConflictRule = 'remote' | 'local' | 'newest';

export interface SyncReport {
  readonly pulled: number;
  readonly pushed: number;
  readonly conflicts: readonly { local: string; remote: string; kept: 'local' | 'remote'; fields: readonly string[] }[];
  readonly cursor: string | undefined;
}

export class Sync {
  cursor: string | undefined;
  private readonly a: Adapter;
  private readonly local: Map<string, Local>;
  private readonly toLocal: (r: Remote) => Record<string, unknown>;
  private readonly toRemote: (l: Local) => Record<string, unknown>;
  private readonly rule: ConflictRule;
  private readonly now: () => Date;

  constructor(a: Adapter, local: Map<string, Local>, o: { toLocal: (r: Remote) => Record<string, unknown>; toRemote: (l: Local) => Record<string, unknown>; rule?: ConflictRule; now?: () => Date }) {
    this.a = a;
    this.local = local;
    this.toLocal = o.toLocal;
    this.toRemote = o.toRemote;
    this.rule = o.rule ?? 'newest';
    this.now = o.now ?? (() => new Date());
  }

  private byRemote(id: string): Local | undefined {
    for (const l of this.local.values()) if (l.remoteId === id) return l;
    return undefined;
  }

  async run(page = 100): Promise<SyncReport> {
    let pulled = 0;
    let pushed = 0;
    const conflicts: { local: string; remote: string; kept: 'local' | 'remote'; fields: string[] }[] = [];
    const touched = new Set<string>();
    for (;;) {
      const r = await this.a.changes(this.cursor, page);
      for (const item of r.items) {
        const mapped = this.toLocal(item);
        const keys = Object.keys(mapped);
        const l = this.byRemote(item.id);
        const at = this.now().toISOString();
        if (!l) {
          const id = `${this.a.name}:${item.id}`;
          this.local.set(id, { id, updated: at, fields: mapped, remoteId: item.id, syncedAt: at, base: snapshot(mapped) });
          pulled++;
          continue;
        }
        const localChanged = !!l.syncedAt && l.updated > l.syncedAt;
        // What the remote side held at the last sync; without it, every field that differs counts as changed on both sides.
        const base = l.base ?? (localChanged ? undefined : l.fields);
        const remoteKeys = keys.filter((k) => !base || !same(mapped[k], base[k]));
        if (!remoteKeys.length || keys.every((k) => same(mapped[k], l.fields[k]))) {
          l.base = snapshot(mapped); // the echo of our own push, or a change that is already here
          continue;
        }
        const localKeys = localChanged ? keys.filter((k) => !base || !same(l.fields[k], base[k])) : [];
        const both = remoteKeys.filter((k) => localKeys.includes(k) && !same(mapped[k], l.fields[k]));
        let keep: 'local' | 'remote' = 'remote';
        if (both.length) {
          keep = this.rule === 'local' ? 'local' : this.rule === 'remote' ? 'remote' : l.updated >= item.updated ? 'local' : 'remote';
          conflicts.push({ local: l.id, remote: item.id, kept: keep, fields: both });
        }
        const take = remoteKeys.filter((k) => keep === 'remote' || !both.includes(k));
        l.fields = { ...l.fields, ...Object.fromEntries(take.map((k) => [k, mapped[k]])) };
        l.base = snapshot(mapped);
        if (take.length) pulled++;
        // Local edits that survive (on other fields, or kept by the rule) stay pending and are pushed below.
        if (!localKeys.some((k) => !same(l.fields[k], mapped[k]))) {
          l.syncedAt = at;
          (l as { updated: string }).updated = at;
          touched.add(l.id);
        }
      }
      this.cursor = r.cursor;
      if (!r.more) break;
    }
    for (const l of this.local.values()) {
      if (touched.has(l.id)) continue;
      if (l.remoteId && l.syncedAt && l.updated <= l.syncedAt) continue;
      const out = await this.a.upsert(l.remoteId, this.toRemote(l));
      l.remoteId = out.id;
      l.base = snapshot(this.toLocal(out));
      l.syncedAt = this.now().toISOString();
      (l as { updated: string }).updated = l.syncedAt;
      pushed++;
    }
    return { pulled, pushed, conflicts, cursor: this.cursor };
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** A copy that later edits to the record's fields cannot reach. */
const snapshot = (o: Record<string, unknown>): Record<string, unknown> => JSON.parse(JSON.stringify(o)) as Record<string, unknown>;

/** A twin for any of the three kinds: records with ids, update times and a change feed ordered by a counter. */
export class Twin implements Adapter {
  readonly name: string;
  readonly records = new Map<string, Remote & { seq: number }>();
  private seq = 0;
  private n = 0;
  failNextUpsert = false;
  private readonly now: () => Date;
  constructor(name: string, now: () => Date = () => new Date()) {
    this.name = name;
    this.now = now;
  }
  /** A change made by someone in the outside system. */
  edit(id: string | undefined, fields: Record<string, unknown>): Remote & { seq: number } {
    const rid = id ?? `${this.name.toUpperCase()}-${++this.n}`;
    const prev = this.records.get(rid);
    const r = { id: rid, updated: this.now().toISOString(), fields: { ...(prev?.fields ?? {}), ...fields }, seq: ++this.seq };
    this.records.set(rid, r);
    return r;
  }
  async changes(cursor: string | undefined, limit: number) {
    const after = Number(cursor ?? 0);
    const all = [...this.records.values()].filter((r) => r.seq > after).sort((a, b) => a.seq - b.seq);
    const items = all.slice(0, limit);
    return { items: items.map(({ seq: _s, ...r }) => r), cursor: String(items.at(-1)?.seq ?? after), more: all.length > limit };
  }
  async upsert(id: string | undefined, fields: Readonly<Record<string, unknown>>) {
    if (this.failNextUpsert) {
      this.failNextUpsert = false;
      throw new Error(`${this.name} is unavailable`);
    }
    const r = this.edit(id, { ...fields });
    return { id: r.id, updated: r.updated, fields: r.fields };
  }
}
