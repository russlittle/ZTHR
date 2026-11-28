/**
 * Published and draft copies of content. Every save is a numbered revision that is never changed or renumbered; two
 * pointers say which revision is live and which is the working draft, so editing a published page never changes
 * what readers see until it is published. Handled here: saving with a check that nobody else saved first, publish
 * and unpublish with an injected policy that can refuse, discarding a draft, scheduled publish and unpublish pinned
 * to the revision chosen when scheduling (so a later edit does not slip into a scheduled release, and the schedule
 * says so), catching up on schedules that came due while nothing was running, rollback as a new revision that
 * copies an old one, signed preview links for a draft that expire and can be revoked one by one or per document, a
 * field-level diff between any two revisions with a word or line diff for text, pruning of old revisions that never
 * removes what is live, scheduled or in draft, and a plain event log of who did what.
 *
 * Preview tokens are the signed, purpose-bound tokens of the crypto block, with an id so each can be revoked.
 *
 * Out of scope: storage (the store is in memory; `export` and `restore` move it), approval flows (see workflow:
 * pass its answer in as the `guard`), and rendering.
 */
import { sign, verify, BadToken } from '../crypto/index.ts';

export class VersionError extends Error {
  constructor(message: string) {
    super(message);
  }
}
export class Conflict extends VersionError {
  readonly current: number;
  readonly changedFields: readonly string[];
  constructor(expected: number, current: number, changed: readonly string[]) {
    super(`someone saved revision ${current} after revision ${expected}; changed: ${changed.join(', ') || 'nothing you edited'}`);
    this.current = current;
    this.changedFields = changed;
  }
}
export class Refused extends VersionError {}

export type Fields = Readonly<Record<string, unknown>>;

export interface Revision {
  readonly number: number;
  readonly fields: Fields;
  readonly by: string;
  readonly at: number;
  readonly basedOn?: number;
  readonly note?: string;
  /** Set when this revision was made by rolling back to another. */
  readonly restoredFrom?: number;
}

export interface Schedule {
  readonly publishAt?: number;
  readonly unpublishAt?: number;
  /** The revision that goes live; fixed when scheduling. */
  readonly revision: number;
}

export type Action = 'create' | 'save' | 'publish' | 'unpublish' | 'schedule' | 'unschedule' | 'rollback' | 'discard' | 'prune';

export interface LogEntry {
  readonly at: number;
  readonly by: string;
  readonly action: Action;
  readonly revision?: number;
  readonly note?: string;
}

export type State = 'draft' | 'published' | 'modified' | 'scheduled' | 'unpublished';

export interface Options {
  readonly now: () => number;
  /** Secret(s) for preview links; the first signs, all verify, so a secret can be rotated. */
  readonly previewSecrets?: readonly string[];
  /** May refuse an action with a reason, for approvals and permissions. */
  readonly guard?: (ctx: { id: string; by: string; action: 'publish' | 'unpublish' | 'schedule' | 'rollback'; revision: number }) => string | undefined;
  /** Largest revision, as JSON bytes. Default 1 MiB. */
  readonly maxBytes?: number;
}

export interface DueEvent {
  readonly id: string;
  readonly action: 'publish' | 'unpublish';
  readonly revision: number;
  readonly dueAt: number;
}

interface Doc {
  readonly id: string;
  readonly revisions: Map<number, Revision>;
  next: number;
  publishedRev: number | undefined;
  draftRev: number;
  everPublished: boolean;
  schedule: Schedule | undefined;
  log: LogEntry[];
}

const MAX_LOG = 200;
const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
const same = (a: unknown, b: unknown) => canon(a) === canon(b);
const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
};

// ================================================================== diffs

export interface FieldChange {
  readonly field: string;
  readonly kind: 'added' | 'removed' | 'changed';
  readonly before?: unknown;
  readonly after?: unknown;
}

/** What differs between two sets of fields, field by field, in name order. */
export function diffFields(a: Fields, b: Fields): FieldChange[] {
  const out: FieldChange[] = [];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const has = (o: Fields) => Object.hasOwn(o, k) && o[k] !== undefined;
    if (has(a) && !has(b)) out.push({ field: k, kind: 'removed', before: a[k] });
    else if (!has(a) && has(b)) out.push({ field: k, kind: 'added', after: b[k] });
    else if (has(a) && has(b) && !same(a[k], b[k])) out.push({ field: k, kind: 'changed', before: a[k], after: b[k] });
  }
  return out;
}

export interface TextOp {
  readonly op: 'equal' | 'insert' | 'delete';
  readonly text: string;
}

const MAX_TOKENS = 3000;

/** A word or line diff by longest common subsequence; texts too large for that give one delete and one insert. */
export function diffText(a: string, b: string, by: 'word' | 'line' = 'word'): TextOp[] {
  if (a === b) return a ? [{ op: 'equal', text: a }] : [];
  const split = (s: string) => (by === 'line' ? s.split(/(?<=\n)/) : s.split(/(\s+)/).filter((x) => x !== ''));
  const x = split(a);
  const y = split(b);
  if (x.length > MAX_TOKENS || y.length > MAX_TOKENS) return [...(a ? [{ op: 'delete' as const, text: a }] : []), ...(b ? [{ op: 'insert' as const, text: b }] : [])];
  const n = x.length;
  const m = y.length;
  const t: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i]![j] = x[i] === y[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
  const ops: TextOp[] = [];
  const push = (op: TextOp['op'], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.op === op) ops[ops.length - 1] = { op, text: last.text + text };
    else ops.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) (push('equal', x[i]!), i++, j++);
    else if (t[i + 1]![j]! >= t[i]![j + 1]!) push('delete', x[i++]!);
    else push('insert', y[j++]!);
  }
  while (i < n) push('delete', x[i++]!);
  while (j < m) push('insert', y[j++]!);
  return ops;
}

// ================================================================== the store

export class Versions {
  private readonly o: Options;
  private readonly docs = new Map<string, Doc>();
  private readonly previews = new Map<string, { docId: string; expiresAt: number; revoked: boolean; by: string; revision: number | 'latest' }>();
  private previewSeq = 0;
  private secretList: readonly string[];

  constructor(o: Options) {
    this.o = o;
    this.secretList = o.previewSecrets ?? [];
  }

  /** Replaces the preview secrets: put the new one first and keep the old one until its links have expired. */
  setPreviewSecrets(secrets: readonly string[]): void {
    this.secretList = [...secrets];
  }

  private doc(id: string): Doc {
    const d = this.docs.get(id);
    if (!d) throw new VersionError(`no content ${id}`);
    return d;
  }

  private note(d: Doc, by: string, action: Action, revision?: number, note?: string) {
    d.log.push({ at: this.o.now(), by, action, ...(revision !== undefined ? { revision } : {}), ...(note !== undefined ? { note } : {}) });
    if (d.log.length > MAX_LOG) d.log.shift();
  }

  private clone(fields: Fields): Fields {
    const json = JSON.stringify(fields);
    if (json === undefined || json.length > (this.o.maxBytes ?? 1_048_576)) throw new VersionError('the content is too large');
    return deepFreeze(JSON.parse(json) as Fields);
  }

  private add(d: Doc, fields: Fields, by: string, extra: { note?: string; restoredFrom?: number } = {}): Revision {
    const r: Revision = { number: d.next++, fields: this.clone(fields), by, at: this.o.now(), ...(d.draftRev ? { basedOn: d.draftRev } : {}), ...extra };
    d.revisions.set(r.number, r);
    d.draftRev = r.number;
    return r;
  }

  has(id: string): boolean {
    return this.docs.has(id);
  }

  create(id: string, fields: Fields, by: string): Revision {
    if (this.docs.has(id)) throw new VersionError(`content ${id} already exists`);
    if (!id || id.length > 200) throw new VersionError('an id is 1 to 200 characters');
    const d: Doc = { id, revisions: new Map(), next: 1, publishedRev: undefined, draftRev: 0, everPublished: false, schedule: undefined, log: [] };
    this.docs.set(id, d);
    const r = this.add(d, fields, by);
    this.note(d, by, 'create', r.number);
    return r;
  }

  /**
   * Saves a new revision as the working draft. `expected` is the revision the editor started from; if another
   * revision was saved since, nothing is saved and the error names the fields the other save changed. Saving
   * changes that make no difference creates no revision.
   */
  save(id: string, patch: Fields, by: string, o: { expected?: number; note?: string; replace?: boolean } = {}): Revision {
    const d = this.doc(id);
    const cur = d.revisions.get(d.draftRev)!;
    if (o.expected !== undefined && o.expected !== d.draftRev) {
      const base = d.revisions.get(o.expected);
      throw new Conflict(o.expected, d.draftRev, base ? diffFields(base.fields, cur.fields).map((c) => c.field) : []);
    }
    const next: Record<string, unknown> = o.replace ? {} : { ...cur.fields };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete next[k];
      else Object.defineProperty(next, k, { value: v, enumerable: true, writable: true, configurable: true });
    }
    if (same(next, cur.fields)) return cur;
    const r = this.add(d, next, by, o.note !== undefined ? { note: o.note } : {});
    this.note(d, by, 'save', r.number, o.note);
    return r;
  }

  /** Throws away unpublished changes: the draft goes back to what is live (or stays, when nothing is). */
  discardDraft(id: string, by: string): number {
    const d = this.doc(id);
    if (d.publishedRev === undefined) throw new VersionError('nothing is published to go back to');
    if (d.draftRev === d.publishedRev) return d.draftRev;
    d.draftRev = d.publishedRev;
    this.note(d, by, 'discard', d.publishedRev);
    return d.draftRev;
  }

  private ask(id: string, by: string, action: 'publish' | 'unpublish' | 'schedule' | 'rollback', revision: number) {
    const why = this.o.guard?.({ id, by, action, revision });
    if (why) throw new Refused(why);
  }

  /** Makes a revision live (the working draft unless one is named). */
  publish(id: string, by: string, o: { revision?: number } = {}): Revision {
    const d = this.doc(id);
    const n = o.revision ?? d.draftRev;
    const r = d.revisions.get(n);
    if (!r) throw new VersionError(`there is no revision ${n}`);
    this.ask(id, by, 'publish', n);
    d.publishedRev = n;
    d.everPublished = true;
    if (d.schedule?.publishAt !== undefined && d.schedule.revision === n) d.schedule = d.schedule.unpublishAt !== undefined ? { revision: n, unpublishAt: d.schedule.unpublishAt } : undefined;
    this.note(d, by, 'publish', n);
    return r;
  }

  unpublish(id: string, by: string): void {
    const d = this.doc(id);
    if (d.publishedRev === undefined) throw new VersionError('it is not published');
    this.ask(id, by, 'unpublish', d.publishedRev);
    this.note(d, by, 'unpublish', d.publishedRev);
    d.publishedRev = undefined;
    if (d.schedule?.unpublishAt !== undefined && d.schedule.publishAt === undefined) d.schedule = undefined;
  }

  // ------------------------------------------------------------ schedules

  /**
   * Schedules a revision to go live (and optionally to come down). The revision is fixed now: later saves do not
   * enter the release. Returns whether a newer draft exists that will not be in it.
   */
  schedule(id: string, by: string, when: { publishAt?: number; unpublishAt?: number; revision?: number }): { schedule: Schedule; newerDraft: boolean } {
    const d = this.doc(id);
    const now = this.o.now();
    const rev = when.revision ?? d.draftRev;
    if (!d.revisions.has(rev)) throw new VersionError(`there is no revision ${rev}`);
    const { publishAt, unpublishAt } = when;
    if (publishAt === undefined && unpublishAt === undefined) throw new VersionError('give a time to publish or to unpublish');
    for (const t of [publishAt, unpublishAt]) if (t !== undefined && !Number.isFinite(t)) throw new VersionError('a time must be a number of milliseconds');
    if (publishAt !== undefined && publishAt <= now) throw new VersionError('the publish time is not in the future');
    if (unpublishAt !== undefined && unpublishAt <= now) throw new VersionError('the unpublish time is not in the future');
    if (publishAt !== undefined && unpublishAt !== undefined && unpublishAt <= publishAt) throw new VersionError('it must come down after it goes live');
    if (publishAt === undefined && d.publishedRev === undefined) throw new VersionError('only something published can be scheduled to come down');
    this.ask(id, by, 'schedule', rev);
    const s: Schedule = { revision: rev, ...(publishAt !== undefined ? { publishAt } : {}), ...(unpublishAt !== undefined ? { unpublishAt } : {}) };
    d.schedule = s;
    this.note(d, by, 'schedule', rev, `${publishAt ?? ''}..${unpublishAt ?? ''}`);
    return { schedule: s, newerDraft: d.draftRev > rev };
  }

  cancelSchedule(id: string, by: string): void {
    const d = this.doc(id);
    if (!d.schedule) throw new VersionError('nothing is scheduled');
    d.schedule = undefined;
    this.note(d, by, 'unschedule');
  }

  scheduleOf(id: string): Schedule | undefined {
    return this.doc(id).schedule;
  }

  /** The next time something is due, if any. */
  nextDue(): number | undefined {
    const ts: number[] = [];
    for (const d of this.docs.values()) if (d.schedule) for (const t of [d.schedule.publishAt, d.schedule.unpublishAt]) if (t !== undefined) ts.push(t);
    return ts.length ? Math.min(...ts) : undefined;
  }

  /**
   * Carries out every schedule that has come due, oldest first. A run that was late still does everything in
   * order, so a release whose whole window passed ends unpublished; running again does nothing twice.
   */
  runDue(by = 'scheduler'): DueEvent[] {
    const now = this.o.now();
    const events: { ev: DueEvent; d: Doc }[] = [];
    for (const d of this.docs.values()) {
      const s = d.schedule;
      if (!s) continue;
      if (s.publishAt !== undefined && s.publishAt <= now) events.push({ ev: { id: d.id, action: 'publish', revision: s.revision, dueAt: s.publishAt }, d });
      if (s.unpublishAt !== undefined && s.unpublishAt <= now) events.push({ ev: { id: d.id, action: 'unpublish', revision: s.revision, dueAt: s.unpublishAt }, d });
    }
    events.sort((a, b) => a.ev.dueAt - b.ev.dueAt || (a.ev.action === 'publish' ? -1 : 1));
    const done: DueEvent[] = [];
    for (const { ev, d } of events) {
      try {
        if (ev.action === 'publish') {
          this.ask(d.id, by, 'publish', ev.revision);
          d.publishedRev = ev.revision;
          d.everPublished = true;
          d.schedule = d.schedule?.unpublishAt !== undefined ? { revision: ev.revision, unpublishAt: d.schedule.unpublishAt } : undefined;
          this.note(d, by, 'publish', ev.revision, 'scheduled');
        } else {
          if (d.publishedRev !== undefined) {
            this.ask(d.id, by, 'unpublish', d.publishedRev);
            this.note(d, by, 'unpublish', d.publishedRev, 'scheduled');
            d.publishedRev = undefined;
          }
          d.schedule = undefined;
        }
        done.push(ev);
      } catch (e) {
        if (!(e instanceof Refused)) throw e;
        this.note(d, by, 'schedule', ev.revision, `refused: ${e.message}`);
        d.schedule = undefined;
      }
    }
    return done;
  }

  // ------------------------------------------------------------ rollback

  /** Makes a new revision with the content of an old one (history is never rewritten); optionally makes it live. */
  rollback(id: string, toRevision: number, by: string, o: { publish?: boolean } = {}): Revision {
    const d = this.doc(id);
    const old = d.revisions.get(toRevision);
    if (!old) throw new VersionError(`there is no revision ${toRevision}`);
    const cur = d.revisions.get(d.draftRev)!;
    if (same(old.fields, cur.fields) && (!o.publish || d.publishedRev === d.draftRev)) throw new VersionError(`revision ${toRevision} is already the current content`);
    this.ask(id, by, 'rollback', toRevision);
    const r = same(old.fields, cur.fields) ? cur : this.add(d, old.fields, by, { restoredFrom: toRevision });
    this.note(d, by, 'rollback', r.number, `to ${toRevision}`);
    if (o.publish) this.publish(id, by, { revision: r.number });
    return r;
  }

  // ------------------------------------------------------------ reading

  state(id: string): State {
    const d = this.doc(id);
    if (d.schedule?.publishAt !== undefined && d.publishedRev === undefined) return 'scheduled';
    if (d.publishedRev === undefined) return d.everPublished ? 'unpublished' : 'draft';
    const live = d.revisions.get(d.publishedRev)!;
    const draft = d.revisions.get(d.draftRev)!;
    return same(live.fields, draft.fields) ? 'published' : 'modified';
  }

  /** What readers see: the live revision, or nothing. */
  published(id: string): Revision | undefined {
    const d = this.doc(id);
    return d.publishedRev === undefined ? undefined : d.revisions.get(d.publishedRev);
  }

  /** What editors see: the working draft. */
  draft(id: string): Revision {
    const d = this.doc(id);
    return d.revisions.get(d.draftRev)!;
  }

  revision(id: string, n: number): Revision | undefined {
    return this.doc(id).revisions.get(n);
  }

  /** Revision numbers, oldest first, with who made each and what it was. */
  history(id: string): { number: number; by: string; at: number; note?: string; restoredFrom?: number; live: boolean; draft: boolean; scheduled: boolean }[] {
    const d = this.doc(id);
    return [...d.revisions.values()].map((r) => ({
      number: r.number,
      by: r.by,
      at: r.at,
      ...(r.note !== undefined ? { note: r.note } : {}),
      ...(r.restoredFrom !== undefined ? { restoredFrom: r.restoredFrom } : {}),
      live: d.publishedRev === r.number,
      draft: d.draftRev === r.number,
      scheduled: d.schedule?.revision === r.number,
    }));
  }

  log(id: string): readonly LogEntry[] {
    return this.doc(id).log;
  }

  /** The differences between two revisions; with one number, between it and the live content. */
  diff(id: string, from: number, to?: number): FieldChange[] {
    const d = this.doc(id);
    const a = d.revisions.get(from);
    const bn = to ?? d.publishedRev;
    const b = bn === undefined ? undefined : d.revisions.get(bn);
    if (!a) throw new VersionError(`there is no revision ${from}`);
    if (!b) throw new VersionError(bn === undefined ? 'nothing is published to compare with' : `there is no revision ${bn}`);
    return diffFields(a.fields, b.fields);
  }

  /** Whether there are unpublished changes, and what they are. */
  pendingChanges(id: string): FieldChange[] {
    const d = this.doc(id);
    if (d.publishedRev === undefined) return diffFields({}, d.revisions.get(d.draftRev)!.fields);
    return diffFields(d.revisions.get(d.publishedRev)!.fields, d.revisions.get(d.draftRev)!.fields);
  }

  /**
   * Drops old revisions, keeping the newest `keep` and always the live, draft, scheduled ones and the one each of
   * those was based on is not needed. Returns the numbers removed.
   */
  prune(id: string, keep: number, by = 'system'): number[] {
    const d = this.doc(id);
    if (!Number.isInteger(keep) || keep < 1) throw new VersionError('keep at least one revision');
    const protectedNums = new Set<number>([d.draftRev, ...(d.publishedRev !== undefined ? [d.publishedRev] : []), ...(d.schedule ? [d.schedule.revision] : [])]);
    const all = [...d.revisions.keys()].sort((a, b) => b - a);
    const keepSet = new Set([...all.slice(0, keep), ...protectedNums]);
    const removed = all.filter((n) => !keepSet.has(n)).sort((a, b) => a - b);
    for (const n of removed) d.revisions.delete(n);
    if (removed.length) this.note(d, by, 'prune', undefined, `${removed.length} removed`);
    return removed;
  }

  // ------------------------------------------------------------ preview links

  private secrets(): readonly string[] {
    const s = this.secretList;
    if (!s.length) throw new VersionError('no preview secret is set');
    return s;
  }

  /** A signed link token for looking at a draft without signing in. `revision` fixes one, or follows the latest draft. */
  previewToken(id: string, by: string, o: { ttlMs?: number; revision?: number | 'latest' } = {}): { token: string; tokenId: string; expiresAt: number } {
    const d = this.doc(id);
    const ttl = o.ttlMs ?? 24 * 3600_000;
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 30 * 86_400_000) throw new VersionError('a preview lasts from a moment to 30 days');
    const rev = o.revision ?? 'latest';
    if (rev !== 'latest' && !d.revisions.has(rev)) throw new VersionError(`there is no revision ${rev}`);
    const now = this.o.now();
    const tokenId = `pv${++this.previewSeq}`;
    const token = sign(this.secrets()[0]!, 'content-preview', { id, tid: tokenId, rev }, ttl, now);
    this.previews.set(tokenId, { docId: id, expiresAt: now + ttl, revoked: false, by, revision: rev });
    return { token, tokenId, expiresAt: now + ttl };
  }

  /** Checks a preview token and returns what it shows. */
  resolvePreview(token: string): { id: string; revision: Revision } {
    let data: Record<string, unknown>;
    try {
      data = verify(this.secrets(), 'content-preview', token, this.o.now());
    } catch (e) {
      if (e instanceof BadToken) throw new VersionError(`the preview link is not valid: ${e.message}`);
      throw e;
    }
    const id = String(data.id);
    const rec = this.previews.get(String(data.tid));
    if (!rec || rec.docId !== id) throw new VersionError('the preview link is not valid: it is not known here');
    if (rec.revoked) throw new VersionError('the preview link was revoked');
    const d = this.docs.get(id);
    if (!d) throw new VersionError('the content no longer exists');
    const want = data.rev === 'latest' ? d.draftRev : Number(data.rev);
    const r = d.revisions.get(want);
    if (!r) throw new VersionError('that revision was removed');
    return { id, revision: r };
  }

  revokePreview(tokenId: string): boolean {
    const p = this.previews.get(tokenId);
    if (!p || p.revoked) return false;
    p.revoked = true;
    return true;
  }

  /** Revokes every preview of a document, as when it is deleted or its secret leaked. */
  revokePreviewsOf(id: string): number {
    let n = 0;
    for (const p of this.previews.values()) if (p.docId === id && !p.revoked) {
      p.revoked = true;
      n++;
    }
    return n;
  }

  activePreviews(id: string): { tokenId: string; by: string; expiresAt: number; revision: number | 'latest' }[] {
    const now = this.o.now();
    return [...this.previews].filter(([, p]) => p.docId === id && !p.revoked && p.expiresAt > now).map(([tokenId, p]) => ({ tokenId, by: p.by, expiresAt: p.expiresAt, revision: p.revision }));
  }

  /** Removes a document and revokes its previews. */
  delete(id: string): void {
    this.doc(id);
    this.revokePreviewsOf(id);
    this.docs.delete(id);
  }
}
