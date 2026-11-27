/**
 * One sync engine for every outside system (a ticket tracker, a wiki, a data warehouse). An adapter says how to
 * list changes since a cursor and how to upsert by an external id; the engine pulls and pushes in pages, keeps the
 * cursor only after a page is fully applied (so a crash repeats a page rather than skipping one), maps records both
 * ways, and settles a record changed on both sides by a declared rule, reporting each conflict. Twins of the three
 * kinds of system make every path testable without an account anywhere; like the real ones, they send our own
 * writes back in the change feed, and the engine recognises that echo.
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
        const l = this.byRemote(item.id);
        if (!l) {
          const id = `${this.a.name}:${item.id}`;
          this.local.set(id, { id, updated: item.updated, fields: mapped, remoteId: item.id, syncedAt: this.now().toISOString() });
          pulled++;
          continue;
        }
        const same = Object.keys(mapped).every((k) => JSON.stringify(mapped[k]) === JSON.stringify(l.fields[k]));
        if (same) continue; // the echo of our own push, or a change that is already here
        const localChanged = !!l.syncedAt && l.updated > l.syncedAt;
        if (localChanged) {
          const differ = Object.keys(mapped).filter((k) => JSON.stringify(mapped[k]) !== JSON.stringify(l.fields[k]));
          const keep = this.rule === 'local' ? 'local' : this.rule === 'remote' ? 'remote' : l.updated >= item.updated ? 'local' : 'remote';
          if (differ.length) conflicts.push({ local: l.id, remote: item.id, kept: keep, fields: differ });
          if (keep === 'local') continue;
        }
        l.fields = { ...l.fields, ...mapped };
        l.syncedAt = this.now().toISOString();
        (l as { updated: string }).updated = l.syncedAt;
        touched.add(l.id);
        pulled++;
      }
      this.cursor = r.cursor;
      if (!r.more) break;
    }
    for (const l of this.local.values()) {
      if (touched.has(l.id)) continue;
      if (l.remoteId && l.syncedAt && l.updated <= l.syncedAt) continue;
      const out = await this.a.upsert(l.remoteId, this.toRemote(l));
      l.remoteId = out.id;
      l.syncedAt = this.now().toISOString();
      (l as { updated: string }).updated = l.syncedAt;
      pushed++;
    }
    return { pulled, pushed, conflicts, cursor: this.cursor };
  }
}

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
