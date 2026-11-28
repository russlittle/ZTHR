/**
 * Object versioning, object lock and lifecycle over any object store (the objects block), with S3's semantics.
 *
 * Versioning has three states: unversioned (a write replaces, a delete deletes), enabled (every write adds a
 * version with a new id; a delete without an id adds a delete marker and removes nothing), and suspended (new
 * writes take the id "null", replacing only the null version; earlier versions stay). A bucket cannot go back to
 * unversioned. A read without an id gets the newest version, or NoSuchKey when that is a delete marker; a read with
 * an id gets exactly that version; deleting an id removes it for good, and deleting a delete marker brings the
 * previous version back. `restore` copies an old version forward as a new one, so history is never rewritten.
 * Listing shows keys in UTF-8 byte order with versions newest first, `isLatest`, prefixes and delimiters, and
 * resumes from a key and version marker.
 *
 * Object lock (WORM) needs versioning and is switched on when the bucket is made. A version can carry a
 * retention mode and date: COMPLIANCE cannot be deleted, shortened or removed by anyone before its date;
 * GOVERNANCE can be, by a caller who asks to bypass and whom `canBypass` accepts. A legal hold blocks deletion
 * whatever the retention says, until it is lifted. A default retention rule stamps every new version. Retention
 * can only be lengthened under COMPLIANCE, and a mode cannot be weakened from COMPLIANCE to GOVERNANCE.
 *
 * Lifecycle rules (by key prefix) expire current versions after N days (by adding a delete marker when versioned),
 * remove noncurrent versions N days after they stopped being current while keeping the newest K noncurrent ones,
 * and remove delete markers that are the only thing left of a key. Planning which noncurrent versions go uses the
 * retention block's sweep, with a lock or hold counted as a legal hold, so locked versions are never planned for
 * removal and are reported as skipped. `sweep` takes the clock from the caller and returns what it did.
 *
 * Out of scope: multipart uploads (see s3-api), replication, storage classes and transitions, per-tag rules, and
 * persistence of the index (it is in memory; the store keeps the bytes).
 */
import { Missing, parseRange } from '../objects/index.ts';
import type { ObjectStore, Range } from '../objects/index.ts';
import { sweep as retentionSweep } from '../retention/index.ts';
import type { Item } from '../retention/index.ts';

export type VersionErrorCode = 'NoSuchKey' | 'NoSuchVersion' | 'MethodNotAllowed' | 'ObjectLocked' | 'InvalidState' | 'InvalidArgument' | 'InvalidRange' | 'AccessDenied' | 'TooManyVersions';

export class VersionError extends Error {
  readonly code: VersionErrorCode;
  /** True when the newest version is a delete marker, for a NoSuchKey on a plain read. */
  readonly deleteMarker: boolean;
  constructor(code: VersionErrorCode, message: string, deleteMarker = false) {
    super(message);
    this.code = code;
    this.deleteMarker = deleteMarker;
  }
}

export type Versioning = 'unversioned' | 'enabled' | 'suspended';
export type LockMode = 'GOVERNANCE' | 'COMPLIANCE';

export interface Retention {
  readonly mode: LockMode;
  /** Epoch ms. */
  readonly until: number;
}

export interface Version {
  readonly key: string;
  readonly versionId: string;
  readonly isDeleteMarker: boolean;
  readonly blob: string | undefined;
  readonly size: number;
  readonly etag: string;
  readonly modified: number;
  readonly contentType: string;
  readonly user: Readonly<Record<string, string>>;
  retention: Retention | undefined;
  legalHold: boolean;
  /** When it stopped being the newest version; undefined while it is. */
  noncurrentSince: number | undefined;
}

export interface Rule {
  readonly id: string;
  readonly prefix: string;
  readonly enabled: boolean;
  /** Days after creation at which the current version expires. */
  readonly expireDays?: number;
  /** Days after a version stops being current before it is removed. */
  readonly noncurrentDays?: number;
  /** Newest noncurrent versions to keep whatever their age. */
  readonly keepNoncurrent?: number;
  /** Remove a delete marker that is the only version of its key. */
  readonly removeExpiredMarkers?: boolean;
}

export interface Options {
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Turn object lock on for this bucket (needs versioning, which is then enabled). */
  readonly objectLock?: boolean;
  readonly defaultRetention?: { readonly mode: LockMode; readonly days: number };
  /** Whether a caller may bypass GOVERNANCE retention. Default: nobody. */
  readonly canBypass?: (who: string | undefined) => boolean;
  readonly maxVersionsPerKey?: number;
  readonly maxKeys?: number;
}

export interface PutOptions {
  readonly contentType?: string;
  readonly user?: Readonly<Record<string, string>>;
  readonly retention?: Retention;
  readonly legalHold?: boolean;
  readonly maxBytes?: number;
}

export interface DeleteResult {
  /** The version removed, or the delete marker added. */
  readonly versionId: string | undefined;
  readonly deleteMarker: boolean;
}

export interface Entry {
  readonly key: string;
  readonly versionId: string;
  readonly isLatest: boolean;
  readonly isDeleteMarker: boolean;
  readonly size: number;
  readonly etag: string;
  readonly modified: number;
}

export interface Listing {
  readonly entries: Entry[];
  readonly commonPrefixes: string[];
  readonly truncated: boolean;
  readonly nextKeyMarker: string | undefined;
  readonly nextVersionIdMarker: string | undefined;
}

export interface SweepReport {
  readonly expired: { key: string; marker: string }[];
  readonly purged: { key: string; versionId: string; rule: string }[];
  readonly markersRemoved: { key: string; versionId: string }[];
  readonly skippedLocked: { key: string; versionId: string; rule: string }[];
}

const DAY = 86_400_000;
const byteCompare = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function checkKey(key: string) {
  if (key.length === 0 || Buffer.byteLength(key, 'utf8') > 1024 || LONE.test(key) || /[\u0000-\u001f\u007f]/.test(key)) throw new VersionError('InvalidArgument', 'a key is 1 to 1024 UTF-8 bytes without control characters');
}

export class VersionedBucket {
  private readonly keys = new Map<string, Version[]>();
  private state: Versioning = 'unversioned';
  private rules: Rule[] = [];
  private readonly store: ObjectStore;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly lock: boolean;
  private readonly defaultRetention: Options['defaultRetention'];
  private readonly canBypass: (who: string | undefined) => boolean;
  private readonly maxVersions: number;
  private readonly maxKeys: number;
  private seq = 0;

  constructor(store: ObjectStore, o: Options = {}) {
    this.store = store;
    this.now = o.now ?? Date.now;
    this.newId = o.newId ?? (() => `v${++this.seq}`);
    this.lock = o.objectLock ?? false;
    this.defaultRetention = o.defaultRetention;
    this.canBypass = o.canBypass ?? (() => false);
    this.maxVersions = o.maxVersionsPerKey ?? 10_000;
    this.maxKeys = o.maxKeys ?? 1000;
    if (this.defaultRetention && !this.lock) throw new VersionError('InvalidArgument', 'a default retention needs object lock');
    if (this.defaultRetention && (!Number.isInteger(this.defaultRetention.days) || this.defaultRetention.days < 1)) throw new VersionError('InvalidArgument', 'default retention is a whole number of days');
    if (this.lock) this.state = 'enabled';
  }

  get versioning(): Versioning {
    return this.state;
  }

  setVersioning(s: 'enabled' | 'suspended'): void {
    if (s !== 'enabled' && s !== 'suspended') throw new VersionError('InvalidArgument', 'versioning is enabled or suspended');
    if (s === 'suspended' && this.lock) throw new VersionError('InvalidState', 'versioning cannot be suspended while object lock is on');
    this.state = s;
  }

  // --- internals ------------------------------------------------------------------------------------------

  private chain(key: string): Version[] {
    return this.keys.get(key) ?? [];
  }

  private locked(v: Version, now: number): 'compliance' | 'governance' | 'hold' | undefined {
    if (v.legalHold) return 'hold';
    if (v.retention && v.retention.until > now) return v.retention.mode === 'COMPLIANCE' ? 'compliance' : 'governance';
    return undefined;
  }

  private checkRetention(r: Retention | undefined, now: number) {
    if (!r) return;
    if (!this.lock) throw new VersionError('InvalidState', 'object lock is not enabled on this bucket');
    if (r.mode !== 'GOVERNANCE' && r.mode !== 'COMPLIANCE') throw new VersionError('InvalidArgument', 'the retention mode is GOVERNANCE or COMPLIANCE');
    if (!Number.isFinite(r.until) || r.until <= now) throw new VersionError('InvalidArgument', 'the retain-until date must be in the future');
  }

  private add(key: string, v: Version) {
    let list = this.keys.get(key);
    if (!list) this.keys.set(key, (list = []));
    const head = list[0];
    if (head && head.noncurrentSince === undefined) head.noncurrentSince = v.modified;
    list.unshift(v);
  }

  private async drop(key: string, v: Version): Promise<void> {
    const list = this.chain(key);
    const i = list.indexOf(v);
    if (i < 0) return;
    list.splice(i, 1);
    if (i === 0 && list[0]) list[0].noncurrentSince = undefined;
    if (list.length === 0) this.keys.delete(key);
    if (v.blob) await this.store.delete(v.blob);
  }

  private find(key: string, versionId: string | undefined): Version {
    const list = this.chain(key);
    if (versionId === undefined) {
      const head = list[0];
      if (!head) throw new VersionError('NoSuchKey', 'the specified key does not exist');
      if (head.isDeleteMarker) throw new VersionError('NoSuchKey', 'the specified key does not exist', true);
      return head;
    }
    const v = list.find((x) => x.versionId === versionId);
    if (!v) throw new VersionError('NoSuchVersion', 'the specified version does not exist');
    return v;
  }

  // --- writes ---------------------------------------------------------------------------------------------

  async put(key: string, data: AsyncIterable<Uint8Array> | Uint8Array, o: PutOptions = {}): Promise<Version> {
    checkKey(key);
    const now = this.now();
    this.checkRetention(o.retention, now);
    if (o.legalHold && !this.lock) throw new VersionError('InvalidState', 'object lock is not enabled on this bucket');
    const list = this.chain(key);
    if (this.state !== 'unversioned' && list.length >= this.maxVersions) throw new VersionError('TooManyVersions', `a key can have at most ${this.maxVersions} versions`);
    const w = await this.store.put(data, { algos: ['MD5'], ...(o.maxBytes !== undefined ? { maxBytes: o.maxBytes } : {}) });
    const etag = w.checksums.find((c) => c.startsWith('MD5:'))!.slice(4);
    let retention = o.retention;
    if (!retention && this.defaultRetention) retention = { mode: this.defaultRetention.mode, until: now + this.defaultRetention.days * DAY };
    const v: Version = { key, versionId: this.state === 'enabled' ? this.newId() : 'null', isDeleteMarker: false, blob: w.key, size: w.size, etag, modified: now, contentType: o.contentType ?? 'binary/octet-stream', user: { ...(o.user ?? {}) }, retention, legalHold: o.legalHold ?? false, noncurrentSince: undefined };
    if (this.state !== 'enabled') {
      // unversioned and suspended: the null version is replaced, which a lock forbids
      const old = list.find((x) => x.versionId === 'null');
      if (old) {
        if (this.locked(old, now)) {
          await this.store.delete(w.key);
          throw new VersionError('ObjectLocked', 'the null version is locked and cannot be replaced');
        }
        await this.drop(key, old);
      }
    }
    this.add(key, v);
    return v;
  }

  /** Deletes. Without a versionId: removes (unversioned) or adds a delete marker. With one: removes that version for good. */
  async delete(key: string, o: { versionId?: string; bypassGovernance?: boolean; who?: string } = {}): Promise<DeleteResult> {
    checkKey(key);
    const now = this.now();
    if (o.versionId === undefined) {
      if (this.state === 'unversioned') {
        const head = this.chain(key)[0];
        if (head) await this.drop(key, head);
        return { versionId: undefined, deleteMarker: false };
      }
      const list = this.chain(key);
      if (list.length >= this.maxVersions) throw new VersionError('TooManyVersions', `a key can have at most ${this.maxVersions} versions`);
      if (this.state === 'suspended') {
        const old = list.find((x) => x.versionId === 'null');
        if (old) {
          if (this.locked(old, now)) throw new VersionError('ObjectLocked', 'the null version is locked');
          await this.drop(key, old);
        }
      }
      const m: Version = { key, versionId: this.state === 'enabled' ? this.newId() : 'null', isDeleteMarker: true, blob: undefined, size: 0, etag: '', modified: now, contentType: '', user: {}, retention: undefined, legalHold: false, noncurrentSince: undefined };
      this.add(key, m);
      return { versionId: m.versionId, deleteMarker: true };
    }
    const v = this.find(key, o.versionId);
    const why = this.locked(v, now);
    if (why === 'hold') throw new VersionError('ObjectLocked', 'the version is under a legal hold');
    if (why === 'compliance') throw new VersionError('ObjectLocked', 'the version is under compliance retention until ' + new Date(v.retention!.until).toISOString());
    if (why === 'governance') {
      if (!o.bypassGovernance) throw new VersionError('ObjectLocked', 'the version is under governance retention until ' + new Date(v.retention!.until).toISOString());
      if (!this.canBypass(o.who)) throw new VersionError('AccessDenied', 'you may not bypass governance retention');
    }
    await this.drop(key, v);
    return { versionId: v.versionId, deleteMarker: v.isDeleteMarker };
  }

  /** Copies an old version forward as the new current version. */
  async restore(key: string, versionId: string): Promise<Version> {
    const v = this.find(key, versionId);
    if (v.isDeleteMarker || !v.blob) throw new VersionError('MethodNotAllowed', 'a delete marker has nothing to restore');
    if (this.state === 'unversioned') throw new VersionError('InvalidState', 'versioning is not enabled');
    const w = await this.store.compose([v.blob]);
    const now = this.now();
    const copy: Version = { key, versionId: this.state === 'enabled' ? this.newId() : 'null', isDeleteMarker: false, blob: w.key, size: v.size, etag: v.etag, modified: now, contentType: v.contentType, user: { ...v.user }, retention: undefined, legalHold: false, noncurrentSince: undefined };
    if (this.state === 'suspended') {
      const old = this.chain(key).find((x) => x.versionId === 'null');
      if (old) {
        if (this.locked(old, now)) {
          await this.store.delete(w.key);
          throw new VersionError('ObjectLocked', 'the null version is locked');
        }
        await this.drop(key, old);
      }
    }
    if (this.defaultRetention) copy.retention = { mode: this.defaultRetention.mode, until: now + this.defaultRetention.days * DAY };
    this.add(key, copy);
    return copy;
  }

  // --- reads ----------------------------------------------------------------------------------------------

  head(key: string, versionId?: string): Version {
    checkKey(key);
    const v = this.find(key, versionId);
    if (v.isDeleteMarker) throw new VersionError('MethodNotAllowed', 'the version is a delete marker');
    return v;
  }

  async get(key: string, o: { versionId?: string; rangeHeader?: string } = {}): Promise<{ version: Version; range: Range | undefined; stream: AsyncIterable<Uint8Array> }> {
    const v = this.head(key, o.versionId);
    const r = parseRange(o.rangeHeader, v.size);
    if (r === 'unsatisfiable') throw new VersionError('InvalidRange', 'the requested range is not satisfiable');
    try {
      const stream = v.size === 0 ? (async function* () {})() : await this.store.get(v.blob!, r ?? undefined);
      return { version: v, range: r ?? undefined, stream };
    } catch (e) {
      if (e instanceof Missing) throw new VersionError('InvalidState', 'the stored bytes are missing');
      throw e;
    }
  }

  /** Every version and delete marker, keys in UTF-8 byte order, newest version first. */
  listVersions(o: { prefix?: string; delimiter?: string; keyMarker?: string; versionIdMarker?: string; maxKeys?: number } = {}): Listing {
    const prefix = o.prefix ?? '';
    const delimiter = o.delimiter ?? '';
    const max = Math.min(Math.max(o.maxKeys ?? this.maxKeys, 0), this.maxKeys);
    if (o.versionIdMarker !== undefined && o.keyMarker === undefined) throw new VersionError('InvalidArgument', 'a version marker needs a key marker');
    const entries: Entry[] = [];
    const prefixes: string[] = [];
    let truncated = false;
    let nextKey: string | undefined;
    let nextVer: string | undefined;
    let count = 0;
    let last: { key: string; versionId: string } | undefined;
    for (const key of [...this.keys.keys()].sort(byteCompare)) {
      if (!key.startsWith(prefix)) continue;
      if (o.keyMarker !== undefined) {
        const c = byteCompare(key, o.keyMarker);
        if (c < 0) continue;
        if (c === 0 && o.versionIdMarker === undefined) continue;
        if (delimiter && c > 0 && o.keyMarker.endsWith(delimiter) && key.startsWith(o.keyMarker)) continue;
      }
      let cp: string | undefined;
      if (delimiter) {
        const i = key.slice(prefix.length).indexOf(delimiter);
        if (i >= 0) cp = key.slice(0, prefix.length + i + delimiter.length);
      }
      if (cp !== undefined) {
        if (prefixes[prefixes.length - 1] === cp) continue;
        if (o.keyMarker === cp) continue;
        if (count >= max) {
          truncated = true;
          break;
        }
        prefixes.push(cp);
        count++;
        last = { key: cp, versionId: '' };
        continue;
      }
      const list = this.chain(key);
      let start = 0;
      if (o.keyMarker === key && o.versionIdMarker !== undefined) {
        const at = list.findIndex((v) => v.versionId === o.versionIdMarker);
        if (at < 0) throw new VersionError('NoSuchVersion', 'the version marker does not exist');
        start = at + 1;
      }
      for (let i = start; i < list.length; i++) {
        if (count >= max) {
          truncated = true;
          break;
        }
        const v = list[i]!;
        entries.push({ key, versionId: v.versionId, isLatest: i === 0, isDeleteMarker: v.isDeleteMarker, size: v.size, etag: v.etag, modified: v.modified });
        count++;
        last = { key, versionId: v.versionId };
      }
      if (truncated) break;
    }
    if (truncated && last) {
      nextKey = last.key;
      nextVer = last.versionId === '' ? undefined : last.versionId;
    }
    return { entries, commonPrefixes: prefixes, truncated, nextKeyMarker: nextKey, nextVersionIdMarker: nextVer };
  }

  /** Current objects only (no delete markers, no history), as a plain list. */
  list(o: { prefix?: string } = {}): Entry[] {
    const out: Entry[] = [];
    for (const key of [...this.keys.keys()].sort(byteCompare)) {
      if (!key.startsWith(o.prefix ?? '')) continue;
      const head = this.chain(key)[0]!;
      if (!head.isDeleteMarker) out.push({ key, versionId: head.versionId, isLatest: true, isDeleteMarker: false, size: head.size, etag: head.etag, modified: head.modified });
    }
    return out;
  }

  stats(): { keys: number; versions: number; deleteMarkers: number; currentBytes: number; noncurrentBytes: number } {
    let versions = 0;
    let markers = 0;
    let cur = 0;
    let non = 0;
    for (const list of this.keys.values())
      list.forEach((v, i) => {
        versions++;
        if (v.isDeleteMarker) markers++;
        if (i === 0) cur += v.size;
        else non += v.size;
      });
    return { keys: this.keys.size, versions, deleteMarkers: markers, currentBytes: cur, noncurrentBytes: non };
  }

  // --- object lock ----------------------------------------------------------------------------------------

  lockOf(key: string, versionId?: string): { retention: Retention | undefined; legalHold: boolean; lockedNow: boolean } {
    const v = this.head(key, versionId);
    return { retention: v.retention, legalHold: v.legalHold, lockedNow: this.locked(v, this.now()) !== undefined };
  }

  setRetention(key: string, versionId: string | undefined, r: Retention | undefined, o: { bypassGovernance?: boolean; who?: string } = {}): void {
    if (!this.lock) throw new VersionError('InvalidState', 'object lock is not enabled on this bucket');
    const v = this.head(key, versionId);
    const now = this.now();
    this.checkRetention(r, now);
    const cur = v.retention && v.retention.until > now ? v.retention : undefined;
    if (cur) {
      const shortens = r === undefined || r.until < cur.until;
      const weakens = r !== undefined && cur.mode === 'COMPLIANCE' && r.mode === 'GOVERNANCE';
      if (cur.mode === 'COMPLIANCE' && (shortens || weakens)) throw new VersionError('ObjectLocked', 'compliance retention can only be lengthened');
      if (cur.mode === 'GOVERNANCE' && shortens) {
        if (!o.bypassGovernance) throw new VersionError('ObjectLocked', 'shortening governance retention needs bypass');
        if (!this.canBypass(o.who)) throw new VersionError('AccessDenied', 'you may not bypass governance retention');
      }
    }
    v.retention = r;
  }

  setLegalHold(key: string, versionId: string | undefined, on: boolean): void {
    if (!this.lock) throw new VersionError('InvalidState', 'object lock is not enabled on this bucket');
    this.head(key, versionId).legalHold = on;
  }

  // --- lifecycle ------------------------------------------------------------------------------------------

  setLifecycle(rules: readonly Rule[]): void {
    if (rules.length > 1000) throw new VersionError('InvalidArgument', 'at most 1000 lifecycle rules');
    const ids = new Set<string>();
    for (const r of rules) {
      if (!r.id || ids.has(r.id)) throw new VersionError('InvalidArgument', 'rule ids are required and must differ');
      ids.add(r.id);
      const whole = (n: number | undefined) => n === undefined || (Number.isInteger(n) && n >= 1);
      if (!whole(r.expireDays) || !whole(r.noncurrentDays)) throw new VersionError('InvalidArgument', `rule ${r.id}: days are whole numbers of at least 1`);
      if (r.keepNoncurrent !== undefined && (!Number.isInteger(r.keepNoncurrent) || r.keepNoncurrent < 0)) throw new VersionError('InvalidArgument', `rule ${r.id}: keepNoncurrent is a whole number`);
      if (r.expireDays === undefined && r.noncurrentDays === undefined && !r.removeExpiredMarkers) throw new VersionError('InvalidArgument', `rule ${r.id}: it does nothing`);
      if (r.removeExpiredMarkers && r.expireDays !== undefined) throw new VersionError('InvalidArgument', `rule ${r.id}: expireDays and removeExpiredMarkers cannot be combined`);
    }
    this.rules = rules.map((r) => ({ ...r }));
  }

  /** Applies the lifecycle rules as of now and reports what it did. */
  async sweep(): Promise<SweepReport> {
    const now = this.now();
    const report: { expired: SweepReport['expired']; purged: SweepReport['purged']; markersRemoved: SweepReport['markersRemoved']; skippedLocked: SweepReport['skippedLocked'] } = { expired: [], purged: [], markersRemoved: [], skippedLocked: [] };
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const keys = [...this.keys.keys()].filter((k) => k.startsWith(rule.prefix)).sort(byteCompare);
      // 1. expire current versions
      if (rule.expireDays !== undefined) {
        for (const key of keys) {
          const head = this.chain(key)[0];
          if (!head || head.isDeleteMarker || now - head.modified < rule.expireDays * DAY) continue;
          if (this.state === 'unversioned') {
            if (this.locked(head, now)) {
              report.skippedLocked.push({ key, versionId: head.versionId, rule: rule.id });
              continue;
            }
            await this.drop(key, head);
            report.expired.push({ key, marker: '' });
          } else {
            const r = await this.delete(key);
            report.expired.push({ key, marker: r.versionId! });
          }
        }
      }
      // 2. noncurrent versions: planned by the retention sweep, locks counted as holds
      if (rule.noncurrentDays !== undefined) {
        const items: Item[] = [];
        const byId = new Map<string, Version>();
        for (const key of keys) {
          const list = this.chain(key).slice(1);
          for (const [i, v] of list.entries()) {
            if (i < (rule.keepNoncurrent ?? 0) || v.noncurrentSince === undefined) continue;
            const id = `${key}\u0000${v.versionId}`;
            byId.set(id, v);
            items.push({ kind: 'version', id, createdAt: v.modified, closedAt: v.noncurrentSince, hold: this.locked(v, now) !== undefined });
          }
        }
        const plan = retentionSweep(items, { version: { keepDays: rule.noncurrentDays, then: 'purge', trashDays: 0 } }, now);
        for (const s of plan.steps) {
          const v = byId.get(s.id)!;
          await this.drop(v.key, v);
          report.purged.push({ key: v.key, versionId: v.versionId, rule: rule.id });
        }
        for (const it of items) {
          if (!it.hold) continue;
          const v = byId.get(it.id)!;
          if (now - v.noncurrentSince! >= rule.noncurrentDays * DAY) report.skippedLocked.push({ key: v.key, versionId: v.versionId, rule: rule.id });
        }
      }
      // 3. delete markers with nothing under them
      if (rule.removeExpiredMarkers) {
        for (const key of keys) {
          const list = this.chain(key);
          if (list.length === 1 && list[0]!.isDeleteMarker) {
            const m = list[0]!;
            await this.drop(key, m);
            report.markersRemoved.push({ key, versionId: m.versionId });
          }
        }
      }
    }
    return report;
  }
}
