/**
 * Backups that are proved by restoring them. A backup records, per collection, a row count and a content hash; a
 * drill restores it into a scratch store, recomputes both, and times the whole restore against the target, so
 * "we have backups" becomes "we restored last Tuesday's in 4 minutes and every collection matched". Retention keeps
 * the newest daily, weekly and monthly backups (grandfather-father-son) and says why each one is kept.
 */
import { createHash } from 'node:crypto';

export type Data = Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;

export interface Store {
  dump(): Promise<Data>;
  load(d: Data): Promise<void>;
}

export interface Backup {
  readonly id: string;
  readonly at: string;
  readonly blob: string;
  readonly digest: Readonly<Record<string, { rows: number; hash: string }>>;
}

const canon = (v: unknown): string => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v));

/** Per collection: rows and a hash independent of row order. */
export function digest(d: Data): Record<string, { rows: number; hash: string }> {
  const out: Record<string, { rows: number; hash: string }> = {};
  for (const [k, rows] of Object.entries(d)) out[k] = { rows: rows.length, hash: createHash('sha256').update(rows.map(canon).sort().join('\n')).digest('hex') };
  return out;
}

export async function backup(s: Store, at: Date): Promise<Backup> {
  const d = await s.dump();
  return { id: `b-${at.toISOString().replace(/[-:]/g, '').slice(0, 15)}`, at: at.toISOString(), blob: JSON.stringify(d), digest: digest(d) };
}

export interface Drill {
  readonly backup: string;
  readonly ran: string;
  readonly ms: number;
  readonly targetMs: number;
  readonly ok: boolean;
  readonly collections: readonly { name: string; expected: number; got: number; match: boolean }[];
  readonly problems: readonly string[];
}

/** Restores a backup into a scratch store and checks it, timing the restore against the recovery-time target. */
export async function drill(b: Backup, scratch: Store, o: { targetMs: number; now?: () => number }): Promise<Drill> {
  const now = o.now ?? Date.now;
  const t0 = now();
  const problems: string[] = [];
  let after: Record<string, { rows: number; hash: string }> = {};
  try {
    await scratch.load(JSON.parse(b.blob) as Data);
    after = digest(await scratch.dump());
  } catch (e) {
    problems.push(`the restore failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const ms = now() - t0;
  const collections = Object.entries(b.digest).map(([name, d]) => {
    const got = after[name];
    const match = !!got && got.rows === d.rows && got.hash === d.hash;
    if (!got) problems.push(`${name} is missing after the restore`);
    else if (!match) problems.push(`${name} restored ${got.rows} of ${d.rows} rows${got.rows === d.rows ? ' but the contents differ' : ''}`);
    return { name, expected: d.rows, got: got?.rows ?? 0, match };
  });
  if (ms > o.targetMs) problems.push(`the restore took ${ms} ms, over the ${o.targetMs} ms target`);
  return { backup: b.id, ran: new Date(t0).toISOString(), ms, targetMs: o.targetMs, ok: problems.length === 0, collections, problems };
}

/** Which backups to keep: the newest per day for `days`, per ISO week for `weeks`, per month for `months`. */
export function retain(list: readonly Backup[], o: { days: number; weeks: number; months: number }): { keep: { id: string; why: string[] }[]; drop: string[] } {
  const sorted = [...list].sort((a, b) => b.at.localeCompare(a.at));
  const why = new Map<string, string[]>();
  const pick = (key: (d: Date) => string, n: number, label: string) => {
    const seen = new Set<string>();
    for (const b of sorted) {
      const k = key(new Date(b.at));
      if (seen.has(k)) continue;
      if (seen.size >= n) break;
      seen.add(k);
      why.set(b.id, [...(why.get(b.id) ?? []), `${label} ${k}`]);
    }
  };
  const isoWeek = (d: Date) => {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const y = t.getUTCFullYear();
    return `${y}-W${String(Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7)).padStart(2, '0')}`;
  };
  pick((d) => d.toISOString().slice(0, 10), o.days, 'daily');
  pick(isoWeek, o.weeks, 'weekly');
  pick((d) => d.toISOString().slice(0, 7), o.months, 'monthly');
  return { keep: sorted.filter((b) => why.has(b.id)).map((b) => ({ id: b.id, why: why.get(b.id)! })), drop: sorted.filter((b) => !why.has(b.id)).map((b) => b.id) };
}

export function memoryStore(initial: Data = {}): Store & { data: Record<string, Readonly<Record<string, unknown>>[]> } {
  const s = {
    data: Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, [...v]])) as Record<string, Readonly<Record<string, unknown>>[]>,
    async dump() {
      return JSON.parse(JSON.stringify(s.data)) as Data;
    },
    async load(d: Data) {
      s.data = JSON.parse(JSON.stringify(d));
    },
  };
  return s;
}
