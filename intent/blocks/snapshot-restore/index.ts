/**
 * Point-in-time snapshots of structured data (collections of keyed rows), and the three things you do with them:
 * compare, plan a restore, and prove it worked.
 *
 *  - snapshot: every row is stored with its key and a content hash, every collection has a hash that does not depend
 *    on row order (the same one the backups block computes), and the snapshot has a root hash over them all and a
 *    link to its parent snapshot, so a damaged or edited snapshot is detected before it is used. Snapshots can be
 *    written out and read back; reading refuses any whose hashes do not hold.
 *  - diff: between two snapshots or a snapshot and the live data: rows added, removed and changed, with the fields
 *    that changed and their old and new values, per collection, with totals.
 *  - restore plan: what restoring would do, as a list of inserts, updates and deletes, in `replace` mode (the data
 *    becomes the snapshot), `merge` (snapshot rows come back, newer rows stay) or `missing` (only rows that were
 *    deleted come back); limited to chosen collections. The plan says how many rows it would overwrite or lose,
 *    shows a preview, warns about dangling references the result would contain (from declared references), and
 *    refuses a destructive plan unless it is acknowledged by its own confirmation code.
 *  - apply and verify: applying takes a safety snapshot of the current data first (the undo), writes the result,
 *    and re-reads the store to check every collection against what the plan promised.
 *
 * Out of scope: streaming very large datasets (a snapshot holds its rows in memory), binary or file contents, and
 * encryption of snapshots at rest (hand the serialised text to the crypto block).
 */
import { createHash } from 'node:crypto';
import { digest } from '../backups/index.ts';
import type { Data, Store } from '../backups/index.ts';

export type Row = Readonly<Record<string, unknown>>;

export class SnapshotError extends Error {
  constructor(why: string) {
    super(why);
  }
}

/** JSON with sorted keys, dates as ISO text and absent keys left out: the form every hash is taken over. */
function canon(v: unknown): string {
  const j = v !== null && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function' ? (v as { toJSON: () => unknown }).toJSON() : v;
  if (Array.isArray(j)) return `[${j.map((x) => (x === undefined || typeof x === 'function' ? 'null' : canon(x))).join(',')}]`;
  if (j !== null && typeof j === 'object') {
    const o = j as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined && typeof o[k] !== 'function').sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(j) ?? 'null';
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const plain = (v: unknown): Row => JSON.parse(canon(v)) as Row;

export interface CollectionSnapshot {
  readonly key: string;
  /** Rows by key, as plain JSON. */
  readonly rows: Readonly<Record<string, Row>>;
  /** Hash of each row, by key. */
  readonly hashes: Readonly<Record<string, string>>;
  /** Row count and order-free hash, equal to the backups block's digest for the same rows. */
  readonly digest: { readonly rows: number; readonly hash: string };
}

export interface Snapshot {
  readonly id: string;
  readonly at: string;
  readonly label?: string;
  readonly parent?: string;
  readonly collections: Readonly<Record<string, CollectionSnapshot>>;
  /** Hash over the collections' names, keys and digests; any edit to the snapshot changes it. */
  readonly root: string;
}

export interface SnapshotOptions {
  readonly at: Date;
  readonly id?: string;
  readonly label?: string;
  readonly parent?: string;
  /** The key field of each collection (default "id"). */
  readonly keys?: Readonly<Record<string, string>>;
  /** Collections to leave out (sessions, caches). */
  readonly exclude?: readonly string[];
  /** Fields to remove from every row before it is kept, as "collection.field" (secrets that must not sit in a snapshot). */
  readonly omitFields?: readonly string[];
}

const keyOfRow = (r: Row, key: string, coll: string): string => {
  const k = r[key];
  if (typeof k !== 'string' && typeof k !== 'number') throw new SnapshotError(`a row in ${coll} has no usable ${key} (found ${JSON.stringify(k) ?? 'nothing'})`);
  return String(k);
};

function rootOf(collections: Readonly<Record<string, CollectionSnapshot>>): string {
  return sha(Object.keys(collections).sort().map((n) => `${n}|${collections[n]!.key}|${collections[n]!.digest.rows}|${collections[n]!.digest.hash}`).join('\n'));
}

/** Builds a snapshot from data already in hand. */
export function snapshotOf(data: Data, o: SnapshotOptions): Snapshot {
  const collections: Record<string, CollectionSnapshot> = {};
  const omit = new Set(o.omitFields ?? []);
  for (const [name, rows] of Object.entries(data)) {
    if (o.exclude?.includes(name)) continue;
    const key = o.keys?.[name] ?? 'id';
    const map: Record<string, Row> = Object.create(null);
    const hashes: Record<string, string> = Object.create(null);
    const kept: Row[] = [];
    for (const raw of rows) {
      const row = plain(raw) as Record<string, unknown>;
      const k = keyOfRow(row, key, name);
      if (k in map) throw new SnapshotError(`${name} has two rows with ${key} ${k}`);
      for (const f of Object.keys(row)) if (omit.has(`${name}.${f}`)) delete row[f];
      map[k] = row;
      hashes[k] = sha(canon(row));
      kept.push(row);
    }
    collections[name] = { key, rows: map, hashes, digest: digest({ [name]: kept })[name]! };
  }
  const id = o.id ?? `s-${o.at.toISOString().replace(/[-:.]/g, '').slice(0, 15)}`;
  return { id, at: o.at.toISOString(), ...(o.label ? { label: o.label } : {}), ...(o.parent ? { parent: o.parent } : {}), collections, root: rootOf(collections) };
}

export async function takeSnapshot(store: Store, o: SnapshotOptions): Promise<Snapshot> {
  return snapshotOf(await store.dump(), o);
}

/** Checks a snapshot's own hashes: every row, every collection, the root. Returns what does not hold. */
export function verifySnapshot(s: Snapshot): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const [name, c] of Object.entries(s.collections)) {
    const keys = Object.keys(c.rows);
    for (const k of keys) if (sha(canon(c.rows[k])) !== c.hashes[k]) problems.push(`${name}: row ${k} does not match its hash`);
    if (Object.keys(c.hashes).length !== keys.length) problems.push(`${name}: the rows and their hashes differ in number`);
    const d = digest({ [name]: keys.map((k) => c.rows[k]!) })[name]!;
    if (d.hash !== c.digest.hash || d.rows !== c.digest.rows) problems.push(`${name}: the collection hash does not match its rows`);
  }
  if (rootOf(s.collections) !== s.root) problems.push('the root hash does not match the collections');
  return { ok: problems.length === 0, problems };
}

export function serialize(s: Snapshot): string {
  return JSON.stringify(s);
}

/** Reads a serialised snapshot and refuses it if its hashes do not hold. */
export function deserialize(text: string): Snapshot {
  let s: Snapshot;
  try { s = JSON.parse(text) as Snapshot; } catch { throw new SnapshotError('that is not a snapshot'); }
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || typeof s.root !== 'string' || typeof s.collections !== 'object' || s.collections === null) throw new SnapshotError('that is not a snapshot');
  const v = verifySnapshot(s);
  if (!v.ok) throw new SnapshotError(`the snapshot is damaged: ${v.problems[0]}`);
  return s;
}

// ---------------------------------------------------------------- the history of snapshots

export class SnapshotLog {
  private readonly list: Snapshot[] = [];

  add(s: Snapshot): void {
    if (this.list.some((x) => x.id === s.id)) throw new SnapshotError(`a snapshot ${s.id} already exists`);
    if (s.parent && !this.list.some((x) => x.id === s.parent)) throw new SnapshotError(`the parent ${s.parent} is not in the log`);
    const v = verifySnapshot(s);
    if (!v.ok) throw new SnapshotError(`the snapshot is damaged: ${v.problems[0]}`);
    this.list.push(s);
    this.list.sort((a, b) => a.at.localeCompare(b.at));
  }
  get(id: string): Snapshot | undefined {
    return this.list.find((s) => s.id === id);
  }
  all(): readonly Snapshot[] {
    return this.list;
  }
  /** The newest snapshot taken at or before an instant: the data as it was then. */
  asOf(t: Date): Snapshot | undefined {
    const iso = t.toISOString();
    return [...this.list].reverse().find((s) => s.at <= iso);
  }
}

// ---------------------------------------------------------------- diff

export interface FieldChange {
  readonly field: string;
  readonly from: unknown;
  readonly to: unknown;
}
export interface CollectionDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly { readonly key: string; readonly fields: readonly FieldChange[] }[];
  readonly unchanged: number;
}
export interface Diff {
  readonly collections: Readonly<Record<string, CollectionDiff>>;
  /** Collections present in only one side. */
  readonly onlyInFrom: readonly string[];
  readonly onlyInTo: readonly string[];
  readonly totals: { readonly added: number; readonly removed: number; readonly changed: number };
  readonly identical: boolean;
}

const sameJson = (a: unknown, b: unknown) => canon(a) === canon(b);

function fieldChanges(a: Row, b: Row): FieldChange[] {
  const out: FieldChange[] = [];
  for (const f of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) if (!sameJson(a[f], b[f])) out.push({ field: f, from: a[f], to: b[f] });
  return out;
}

/** What changed from `from` to `to`. */
export function diff(from: Snapshot, to: Snapshot): Diff {
  const names = new Set([...Object.keys(from.collections), ...Object.keys(to.collections)]);
  const collections: Record<string, CollectionDiff> = {};
  const onlyInFrom: string[] = [];
  const onlyInTo: string[] = [];
  let added = 0, removed = 0, changed = 0;
  for (const n of [...names].sort()) {
    const a = from.collections[n], b = to.collections[n];
    if (!a) { onlyInTo.push(n); continue; }
    if (!b) { onlyInFrom.push(n); continue; }
    const ad: string[] = [], rm: string[] = [], ch: { key: string; fields: FieldChange[] }[] = [];
    let same = 0;
    for (const k of Object.keys(b.rows)) {
      if (!(k in a.rows)) ad.push(k);
      else if (a.hashes[k] === b.hashes[k]) same++;
      else ch.push({ key: k, fields: fieldChanges(a.rows[k]!, b.rows[k]!) });
    }
    for (const k of Object.keys(a.rows)) if (!(k in b.rows)) rm.push(k);
    collections[n] = { added: ad.sort(), removed: rm.sort(), changed: ch.sort((x, y) => x.key.localeCompare(y.key)), unchanged: same };
    added += ad.length; removed += rm.length; changed += ch.length;
  }
  return { collections, onlyInFrom, onlyInTo, totals: { added, removed, changed }, identical: added + removed + changed === 0 && onlyInFrom.length === 0 && onlyInTo.length === 0 };
}

// ---------------------------------------------------------------- restore plan

export type Mode = 'replace' | 'merge' | 'missing';

export interface PlanOptions {
  readonly mode: Mode;
  /** Collections to restore; default all in the snapshot. */
  readonly collections?: readonly string[];
  /** Declared references, as "collection.field" -> target collection, to find dangling ones in the result. */
  readonly references?: Readonly<Record<string, string>>;
  /** A plan that deletes or overwrites more than this share of a collection's current rows is destructive (default 0.2). */
  readonly destructiveShare?: number;
  /** Rows shown per collection and kind in the preview (default 5). */
  readonly previewRows?: number;
}

export interface Op {
  readonly op: 'insert' | 'update' | 'delete';
  readonly collection: string;
  readonly key: string;
  readonly fields?: readonly FieldChange[];
}

export interface RestorePlan {
  readonly snapshot: string;
  readonly mode: Mode;
  readonly ops: readonly Op[];
  readonly counts: Readonly<Record<string, { insert: number; update: number; delete: number }>>;
  readonly totals: { readonly insert: number; readonly update: number; readonly delete: number };
  /** Rows that would be lost (deleted) or overwritten with older content. */
  readonly rowsAtRisk: number;
  readonly destructive: boolean;
  readonly preview: readonly Op[];
  readonly warnings: readonly string[];
  /** Pass this to `applyPlan` to acknowledge a destructive plan; it is tied to this exact plan. */
  readonly confirmation: string;
  /** What each collection must hold after the restore, for verification. */
  readonly expected: Readonly<Record<string, { rows: number; hash: string }>>;
  /** The data as the plan would leave it. */
  readonly result: Data;
}

/** What restoring `snap` over `current` would do. Nothing is written. */
export function planRestore(snap: Snapshot, current: Data, keys: Readonly<Record<string, string>>, o: PlanOptions): RestorePlan {
  const v = verifySnapshot(snap);
  if (!v.ok) throw new SnapshotError(`the snapshot is damaged: ${v.problems[0]}`);
  const wanted = o.collections ?? Object.keys(snap.collections);
  const warnings: string[] = [];
  for (const w of wanted) if (!snap.collections[w]) throw new SnapshotError(`the snapshot has no collection ${w}`);
  const ops: Op[] = [];
  const counts: Record<string, { insert: number; update: number; delete: number }> = {};
  const result: Record<string, Row[]> = {};
  for (const [n, rows] of Object.entries(current)) result[n] = rows.map((r) => plain(r));
  let atRisk = 0;
  let destructive = false;
  const share = o.destructiveShare ?? 0.2;
  for (const n of wanted) {
    const sc = snap.collections[n]!;
    const key = sc.key;
    if (keys[n] !== undefined && keys[n] !== key) throw new SnapshotError(`${n} is keyed by ${keys[n]} now but the snapshot used ${key}`);
    const cur = new Map<string, Row>();
    for (const r of current[n] ?? []) cur.set(keyOfRow(r, key, n), plain(r));
    if (!(n in current)) warnings.push(`${n} does not exist in the current data; it will be created`);
    const c = { insert: 0, update: 0, delete: 0 };
    const next = new Map(cur);
    for (const k of Object.keys(sc.rows)) {
      const want = sc.rows[k]!;
      const have = cur.get(k);
      if (!have) { ops.push({ op: 'insert', collection: n, key: k }); c.insert++; next.set(k, want); }
      else if (sha(canon(have)) !== sc.hashes[k] && o.mode !== 'missing') {
        if (o.mode === 'merge' && typeof have.updatedAt === 'string' && typeof want.updatedAt === 'string' && have.updatedAt > want.updatedAt) continue;
        ops.push({ op: 'update', collection: n, key: k, fields: fieldChanges(have, want) });
        c.update++;
        atRisk++;
        next.set(k, want);
      }
    }
    if (o.mode === 'replace') for (const k of cur.keys()) if (!(k in sc.rows)) { ops.push({ op: 'delete', collection: n, key: k }); c.delete++; atRisk++; next.delete(k); }
    counts[n] = c;
    result[n] = [...next.values()];
    const base = Math.max(1, cur.size);
    if ((c.delete + c.update) / base > share && c.delete + c.update > 0) { destructive = true; warnings.push(`${n}: ${c.delete} deleted and ${c.update} overwritten of ${cur.size} current rows`); }
    else if (c.delete > 0) destructive = true;
    if (c.update > 0) {
      const fields = new Set<string>();
      for (const op of ops) if (op.collection === n && op.fields) for (const f of op.fields) if (f.to === undefined) fields.add(f.field);
      if (fields.size) warnings.push(`${n}: restoring drops the field(s) ${[...fields].sort().join(', ')} that exist now`);
    }
  }
  // Dangling references in the result.
  for (const [ref, target] of Object.entries(o.references ?? {})) {
    const [coll, field] = ref.split('.') as [string, string];
    if (!wanted.includes(coll) && !wanted.includes(target)) continue;
    const ids = new Set((result[target] ?? []).map((r) => String(r[snap.collections[target]?.key ?? keys[target] ?? 'id'])));
    let dangling = 0;
    for (const r of result[coll] ?? []) { const v2 = r[field]; if (v2 !== undefined && v2 !== null && !ids.has(String(v2))) dangling++; }
    if (dangling) warnings.push(`${dangling} row(s) in ${coll} would point at a missing ${target} through ${field}`);
  }
  const totals = { insert: 0, update: 0, delete: 0 };
  for (const c of Object.values(counts)) { totals.insert += c.insert; totals.update += c.update; totals.delete += c.delete; }
  const preview: Op[] = [];
  const per = o.previewRows ?? 5;
  const seen = new Map<string, number>();
  for (const op of ops) { const k = `${op.collection}|${op.op}`; const n = seen.get(k) ?? 0; if (n < per) preview.push(op); seen.set(k, n + 1); }
  const expected = digest(Object.fromEntries(wanted.map((n) => [n, result[n] ?? []])));
  const confirmation = sha(`${snap.root}|${o.mode}|${wanted.join(',')}|${totals.insert}|${totals.update}|${totals.delete}|${sha(canon(ops.map((x) => [x.op, x.collection, x.key])))}`).slice(0, 12);
  return { snapshot: snap.id, mode: o.mode, ops, counts, totals, rowsAtRisk: atRisk, destructive, preview, warnings, confirmation, expected, result };
}

// ---------------------------------------------------------------- apply and verify

export interface Applied {
  /** The state before the restore, kept so it can be undone. */
  readonly undo: Snapshot;
  readonly verified: boolean;
  readonly mismatches: readonly string[];
}

/**
 * Applies a plan: takes a safety snapshot of the current data (the undo), writes the planned result, re-reads the
 * store and checks each restored collection against what the plan promised. A destructive plan needs its own
 * `confirmation` code. The plan must have been made against the data the store holds now; if the store changed
 * since, nothing is written.
 */
export async function applyPlan(plan: RestorePlan, store: Store, keys: Readonly<Record<string, string>>, o: { at: Date; confirm?: string; basedOn: Data }): Promise<Applied> {
  if (plan.destructive && o.confirm !== plan.confirmation) throw new SnapshotError(`this restore would lose or overwrite ${plan.rowsAtRisk} row(s); pass its confirmation code ${plan.confirmation} to go ahead`);
  const now = await store.dump();
  if (JSON.stringify(digest(now)) !== JSON.stringify(digest(o.basedOn))) throw new SnapshotError('the data changed after the plan was made; plan again');
  const undo = snapshotOf(now, { at: o.at, id: `undo-${plan.snapshot}-${o.at.toISOString().replace(/[-:.]/g, '').slice(0, 15)}`, label: `before restoring ${plan.snapshot}`, keys });
  await store.load(plan.result);
  const after = digest(await store.dump());
  const mismatches: string[] = [];
  for (const [n, e] of Object.entries(plan.expected)) {
    const g = after[n];
    if (!g) mismatches.push(`${n}: missing after the restore`);
    else if (g.rows !== e.rows) mismatches.push(`${n}: expected ${e.rows} rows, found ${g.rows}`);
    else if (g.hash !== e.hash) mismatches.push(`${n}: the rows do not match what the plan promised`);
  }
  return { undo, verified: mismatches.length === 0, mismatches };
}

/** Whether live data equals a snapshot (for "is this restore still needed", and after restoring). */
export function matchesSnapshot(s: Snapshot, data: Data, collections?: readonly string[]): { ok: boolean; mismatches: string[] } {
  const d = digest(data);
  const mismatches: string[] = [];
  for (const n of collections ?? Object.keys(s.collections)) {
    const c = s.collections[n];
    if (!c) { mismatches.push(`${n}: not in the snapshot`); continue; }
    if (!d[n]) mismatches.push(`${n}: not in the data`);
    else if (d[n]!.hash !== c.digest.hash) mismatches.push(`${n}: ${d[n]!.rows} rows now against ${c.digest.rows} in the snapshot, with different content`);
  }
  return { ok: mismatches.length === 0, mismatches };
}
