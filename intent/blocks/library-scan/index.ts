/**
 * Library scans: what changed in a store (a disk, a share, a bucket listing) compared with what the catalogue holds.
 *
 *  - The diff: every scanned file is added, changed, unchanged or (by being absent) removed; a file whose path
 *    vanished and whose twin appeared elsewhere is moved, not removed and added, so its catalogue id, and
 *    everything hung on that id (watch history, ratings, matches), survives. Moves are found three ways, strongest
 *    first: the store's own file id (inode and device) when both sides have one; an equal content hash and size;
 *    and, without hashes, an equal size and modified time (within the file system's time resolution) when the pair
 *    is unique, which is reported as probable. A tie between equally good partners is never guessed: the files are
 *    reported as removed and added, except that the same file name breaks a tie. Directory renames are summarised
 *    (`dirMoves`) from the file moves under them.
 *  - Changed is size, or modified time beyond the tolerance (2 seconds, for FAT), unless both sides have hashes and
 *    they agree (a touch). Case-only renames on case-insensitive stores and composed or decomposed accents (macOS
 *    lists decomposed names) are the same path, not a remove and an add.
 *  - Ignore rules: gitignore syntax (`*`, `**`, `?`, `[a-z]`, a leading `/`, a trailing `/` for directories, `!` to
 *    re-include, `#` comments; an ignored directory hides everything in it), with defaults for the files operating
 *    systems and downloaders leave behind.
 *  - A safety check: a store that lists nothing, or a scan that would remove most of a catalogue, is almost always
 *    an unmounted share rather than a deleted library, so `checkSafety` flags it and `applyDiff` refuses unless
 *    told to go ahead.
 *  - Watch events from a file system watcher (create, modify, delete, moved-from and moved-to with a cookie) are
 *    coalesced: a file still being written is not reported until it has been quiet for the settle time, a create
 *    followed by a delete reports nothing, and a moved-from paired with a moved-to is one move. The clock is injected.
 *  - `loadCatalogue` and `applyDiff` keep the catalogue in the tree block: a move there is a rename of the same
 *    node, so ids are stable.
 *
 * Not here: reading the store (the caller lists it, and hashes whatever it chooses to), media probing, and
 * following symbolic links (the listing should not contain them).
 */
import { Tree, type Node } from '../tree/index.ts';

export class ScanError extends Error {}
export class SuspiciousScan extends ScanError {
  readonly reason: string;
  constructor(reason: string) {
    super(`this scan looks wrong: ${reason}. Check the store is mounted, then apply with confirm.`);
    this.reason = reason;
  }
}

export interface ScanEntry {
  /** Path relative to the library root, with "/" separators. */
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  /** Content hash in any one algorithm, the same one everywhere ("sha256:..."). */
  readonly hash?: string;
  /** The store's own stable id for the file (inode and device). */
  readonly fileId?: string;
}

export interface CatalogueEntry extends ScanEntry {
  /** The catalogue's id, kept through moves. */
  readonly id: number;
}

export interface Moved {
  readonly id: number;
  readonly from: string;
  readonly to: string;
  readonly how: 'fileId' | 'hash' | 'fingerprint' | 'case';
  /** False for the size-and-time guess. */
  readonly certain: boolean;
  /** The content also changed (only known when the store's file id proves it is the same file). */
  readonly alsoChanged: boolean;
  readonly entry: ScanEntry;
}

export interface Changed {
  readonly id: number;
  readonly path: string;
  readonly entry: ScanEntry;
  readonly why: readonly ('size' | 'mtime' | 'hash')[];
}

export interface ScanDiff {
  readonly added: readonly ScanEntry[];
  readonly removed: readonly CatalogueEntry[];
  readonly changed: readonly Changed[];
  readonly moved: readonly Moved[];
  readonly unchanged: number;
  readonly dirMoves: readonly { from: string; to: string; count: number }[];
  /** Paths that matched a rule and were left out of the comparison. */
  readonly ignored: number;
}

export interface DiffOptions {
  readonly ignore?: IgnoreRules;
  /** Modified times closer than this are equal. Default 2000 ms. */
  readonly mtimeToleranceMs?: number;
  readonly caseInsensitive?: boolean;
  /** Guess moves from size and time when there is no id or hash. Default true. */
  readonly fingerprint?: boolean;
  readonly maxEntries?: number;
}

// ---------------------------------------------------------------- paths

function cleanPath(p: string): string {
  if (typeof p !== 'string' || !p || p.length > 4096) throw new ScanError('a path is 1 to 4096 characters');
  if (/[\u0000-\u001f]/.test(p) || p.includes('\\')) throw new ScanError(`a path has control characters or a backslash: ${JSON.stringify(p.slice(0, 80))}`);
  const parts = p.normalize('NFC').split('/');
  if (parts[0] === '' ) throw new ScanError(`a path is relative to the library root: ${p.slice(0, 80)}`);
  if (parts.some((s) => s === '' || s === '.' || s === '..')) throw new ScanError(`a path has an empty, . or .. part: ${p.slice(0, 80)}`);
  return parts.join('/');
}

const keyOf = (p: string, ci: boolean) => (ci ? p.toLowerCase() : p);
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);

// ---------------------------------------------------------------- ignore rules

interface Rule {
  readonly re: RegExp;
  readonly negate: boolean;
  readonly dirOnly: boolean;
}

function globToRegExp(glob: string, anchored: boolean): RegExp {
  if (glob.length > 500) throw new ScanError('an ignore pattern is at most 500 characters');
  if ((glob.match(/\*\*/g) ?? []).length > 4) throw new ScanError('an ignore pattern has at most four **');
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slashBefore = i === 0 || glob[i - 1] === '/';
        if (glob[i + 2] === '/' && slashBefore) {
          re += '(?:[^/]+/)*';
          i += 2;
        } else if (i + 2 >= glob.length && slashBefore) {
          re += '.*';
          i += 1;
        } else {
          re += '[^/]*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close < 0) re += '\\[';
      else {
        let cls = glob.slice(i + 1, close);
        const neg = cls[0] === '!' || cls[0] === '^';
        if (neg) cls = cls.slice(1);
        re += `[${neg ? '^' : ''}${cls.replace(/[\\\]^]/g, '\\$&')}]`;
        i = close;
      }
    } else if (c === '\\' && i + 1 < glob.length) re += glob[++i]!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(anchored ? `^${re}$` : `^(?:.*/)?${re}$`, 'su');
}

/** The files operating systems, NAS boxes and downloaders leave among media. */
export const DEFAULT_IGNORES: readonly string[] = ['.DS_Store', 'Thumbs.db', 'desktop.ini', '._*', '@eaDir/', '#recycle/', '.Trash-*/', '$RECYCLE.BIN/', '*.part', '*.crdownload', '*.tmp', '*.!qB', '.git/'];

export class IgnoreRules {
  private readonly rules: Rule[] = [];

  constructor(lines: readonly string[] = DEFAULT_IGNORES) {
    for (const raw of lines) {
      let line = raw.replace(/(?<!\\)\s+$/u, '');
      if (!line || line.startsWith('#')) continue;
      const negate = line.startsWith('!');
      if (negate) line = line.slice(1);
      const dirOnly = line.endsWith('/');
      if (dirOnly) line = line.slice(0, -1);
      const anchored = line.startsWith('/') || line.includes('/');
      if (line.startsWith('/')) line = line.slice(1);
      if (!line) continue;
      this.rules.push({ re: globToRegExp(line.normalize('NFC'), anchored), negate, dirOnly });
    }
  }

  private test(path: string, isDir: boolean): boolean | undefined {
    let out: boolean | undefined;
    for (const r of this.rules) if ((!r.dirOnly || isDir) && r.re.test(path)) out = !r.negate;
    return out;
  }

  /** True when the path, or any folder above it, is ignored. A folder that is ignored cannot be re-included inside. */
  ignores(path: string, isDir = false): boolean {
    const parts = path.normalize('NFC').split('/');
    for (let i = 1; i < parts.length; i++) if (this.test(parts.slice(0, i).join('/'), true) === true) return true;
    return this.test(path.normalize('NFC'), isDir) === true;
  }
}

// ---------------------------------------------------------------- the diff

function checkEntry(e: ScanEntry): void {
  if (!Number.isFinite(e.size) || e.size < 0) throw new ScanError(`bad size for ${e.path}`);
  if (!Number.isFinite(e.mtimeMs) || e.mtimeMs < 0) throw new ScanError(`bad modified time for ${e.path}`);
}

/** Compare a listing of the store with the catalogue. */
export function diffScan(catalogue: readonly CatalogueEntry[], scanned: readonly ScanEntry[], o: DiffOptions = {}): ScanDiff {
  const max = o.maxEntries ?? 2_000_000;
  if (catalogue.length > max || scanned.length > max) throw new ScanError(`more than ${max} entries`);
  const tol = o.mtimeToleranceMs ?? 2000;
  const ci = o.caseInsensitive === true;
  let ignored = 0;

  const scan = new Map<string, ScanEntry>();
  for (const e of scanned) {
    const path = cleanPath(e.path);
    checkEntry(e);
    if (o.ignore?.ignores(path)) {
      ignored++;
      continue;
    }
    const k = keyOf(path, ci);
    if (scan.has(k)) throw new ScanError(`the listing has ${path} twice`);
    scan.set(k, { ...e, path, ...(e.hash ? { hash: e.hash.toLowerCase() } : {}) });
  }
  const cat = new Map<string, CatalogueEntry>();
  for (const e of catalogue) {
    const path = cleanPath(e.path);
    const k = keyOf(path, ci);
    if (cat.has(k)) throw new ScanError(`the catalogue has ${path} twice`);
    cat.set(k, { ...e, path, ...(e.hash ? { hash: e.hash.toLowerCase() } : {}) });
  }

  const changed: Changed[] = [];
  const moved: Moved[] = [];
  let unchanged = 0;
  const gone: CatalogueEntry[] = [];
  for (const [k, c] of cat) {
    const s = scan.get(k);
    if (!s) {
      if (!o.ignore?.ignores(c.path)) gone.push(c);
      continue;
    }
    scan.delete(k);
    if (s.path !== c.path) {
      moved.push({ id: c.id, from: c.path, to: s.path, how: 'case', certain: true, alsoChanged: false, entry: s });
      continue;
    }
    const why: ('size' | 'mtime' | 'hash')[] = [];
    if (s.size !== c.size) why.push('size');
    if (s.hash && c.hash && s.hash !== c.hash) why.push('hash');
    const bothHash = s.hash !== undefined && c.hash !== undefined;
    if (Math.abs(s.mtimeMs - c.mtimeMs) > tol && !(bothHash && s.hash === c.hash && s.size === c.size)) why.push('mtime');
    if (why.length) changed.push({ id: c.id, path: c.path, entry: s, why });
    else unchanged++;
  }
  let fresh = [...scan.values()];
  let missing = gone;

  const claim = (c: CatalogueEntry, s: ScanEntry, how: Moved['how'], certain: boolean): void => {
    const alsoChanged = s.size !== c.size || (s.hash !== undefined && c.hash !== undefined && s.hash !== c.hash);
    moved.push({ id: c.id, from: c.path, to: s.path, how, certain, alsoChanged, entry: s });
    missing = missing.filter((x) => x !== c);
    fresh = fresh.filter((x) => x !== s);
  };

  // 1. the store's own id
  const byId = new Map<string, ScanEntry[]>();
  for (const s of fresh) if (s.fileId) byId.set(s.fileId, [...(byId.get(s.fileId) ?? []), s]);
  for (const c of [...missing]) {
    const m = c.fileId ? byId.get(c.fileId) : undefined;
    if (m && m.length === 1 && fresh.includes(m[0]!) && missing.filter((x) => x.fileId === c.fileId).length === 1) claim(c, m[0]!, 'fileId', true);
  }

  // 2. the content
  const match = (c: CatalogueEntry, how: Moved['how'], certain: boolean, ok: (c: CatalogueEntry, s: ScanEntry) => boolean): void => {
    const cands = fresh.filter((s) => ok(c, s));
    if (!cands.length) return;
    const rivals = missing.filter((x) => cands.some((s) => ok(x, s)));
    let target: ScanEntry | undefined;
    if (cands.length === 1 && rivals.length === 1) target = cands[0];
    else {
      const same = cands.filter((s) => base(s.path) === base(c.path));
      const sameRivals = rivals.filter((x) => same.some((s) => base(s.path) === base(x.path)));
      if (same.length === 1 && sameRivals.length === 1) target = same[0];
    }
    if (target) claim(c, target, how, certain);
  };
  for (const c of [...missing].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (!c.hash || !missing.includes(c)) continue;
    match(c, 'hash', true, (x, s) => x.hash !== undefined && s.hash === x.hash && s.size === x.size);
  }

  // 3. size and time, only with nothing better to go on
  if (o.fingerprint !== false) {
    for (const c of [...missing].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      if (!missing.includes(c) || c.size === 0 || c.hash) continue;
      match(c, 'fingerprint', false, (x, s) => x.size > 0 && s.size === x.size && !s.hash && Math.abs(s.mtimeMs - x.mtimeMs) <= tol);
    }
  }

  moved.sort((a, b) => (a.from < b.from ? -1 : 1));
  // a folder renamed or filed away shows as many files whose paths differ in the same middle part
  const dm = new Map<string, number>();
  for (const m of moved) {
    if (m.how === 'case') continue;
    const f = m.from.split('/');
    const t = m.to.split('/');
    let head = 0;
    while (head < f.length - 1 && head < t.length - 1 && f[head] === t[head]) head++;
    let tail = 0;
    while (tail < Math.min(f.length, t.length) - head && f[f.length - 1 - tail] === t[t.length - 1 - tail]) tail++;
    if (tail === 0) continue; // the file itself was renamed
    const from = f.slice(0, f.length - tail).join('/');
    const to = t.slice(0, t.length - tail).join('/');
    if (from !== to) dm.set(`${from}\u0000${to}`, (dm.get(`${from}\u0000${to}`) ?? 0) + 1);
  }
  const dirMoves = [...dm].filter(([, n]) => n >= 2).map(([k, count]) => ({ from: k.split('\u0000')[0]!, to: k.split('\u0000')[1]!, count })).sort((a, b) => (a.from < b.from ? -1 : 1));

  return {
    added: fresh.sort((a, b) => (a.path < b.path ? -1 : 1)),
    removed: missing.sort((a, b) => (a.path < b.path ? -1 : 1)),
    changed: changed.sort((a, b) => (a.path < b.path ? -1 : 1)),
    moved,
    unchanged,
    dirMoves,
    ignored,
  };
}

// ---------------------------------------------------------------- safety

export interface Safety {
  readonly ok: boolean;
  readonly reason?: string;
}

/** Does this diff look like a real change, or like a store that is not there? */
export function checkSafety(diff: ScanDiff, catalogueSize: number, scannedSize: number, o: { maxRemovedFraction?: number; minCatalogue?: number } = {}): Safety {
  const min = o.minCatalogue ?? 20;
  const frac = o.maxRemovedFraction ?? 0.5;
  if (catalogueSize > 0 && scannedSize === 0) return { ok: false, reason: 'the store listed no files at all' };
  if (catalogueSize >= min && diff.removed.length / catalogueSize > frac) return { ok: false, reason: `${diff.removed.length} of ${catalogueSize} catalogued files (${Math.round((diff.removed.length / catalogueSize) * 100)}%) would be removed` };
  return { ok: true };
}

// ---------------------------------------------------------------- watching

export type RawEvent =
  | { readonly type: 'create' | 'modify' | 'delete'; readonly path: string; readonly at: number }
  | { readonly type: 'moved_from' | 'moved_to'; readonly path: string; readonly cookie: string; readonly at: number };

export type WatchChange =
  | { readonly type: 'added' | 'changed' | 'removed'; readonly path: string }
  | { readonly type: 'moved'; readonly from: string; readonly path: string };

interface Pending {
  net: 'added' | 'changed' | 'removed';
  last: number;
  /** The path it was moved from, if it arrived by a move. */
  from?: string;
  existedBefore: boolean;
}

/** Turns bursts of file system events into the few changes worth rescanning. */
export class WatchCoalescer {
  private readonly pending = new Map<string, Pending>();
  private readonly froms = new Map<string, { path: string; at: number }>();
  private readonly settleMs: number;
  private readonly now: () => number;
  private readonly ignore: IgnoreRules | undefined;
  private readonly maxPending: number;

  constructor(o: { now: () => number; settleMs?: number; ignore?: IgnoreRules; maxPending?: number }) {
    this.now = o.now;
    this.settleMs = o.settleMs ?? 2000;
    this.ignore = o.ignore;
    this.maxPending = o.maxPending ?? 100_000;
  }

  get size(): number {
    return this.pending.size + this.froms.size;
  }

  private touch(path: string, at: number): Pending {
    let p = this.pending.get(path);
    if (!p) {
      if (this.pending.size >= this.maxPending) throw new ScanError('too many changes waiting; rescan the library instead');
      this.pending.set(path, (p = { net: 'changed', last: at, existedBefore: true }));
    }
    p.last = at;
    return p;
  }

  push(e: RawEvent): void {
    const path = cleanPath(e.path);
    if (this.ignore?.ignores(path)) return;
    if (e.type === 'moved_from') {
      this.froms.set(e.cookie, { path, at: e.at });
      return;
    }
    if (e.type === 'moved_to') {
      const f = this.froms.get(e.cookie);
      this.froms.delete(e.cookie);
      if (!f) {
        this.push({ type: 'create', path, at: e.at });
        return;
      }
      const old = this.pending.get(f.path);
      this.pending.delete(f.path);
      const p = this.touch(path, e.at);
      if (old && !old.existedBefore) {
        p.net = 'added';
        p.existedBefore = false;
      } else {
        p.net = 'changed';
        p.from = old?.from ?? f.path;
      }
      return;
    }
    if (e.type === 'create') {
      const had = this.pending.get(path);
      const p = this.touch(path, e.at);
      if (had?.net === 'removed') p.net = 'changed';
      else {
        p.net = 'added';
        p.existedBefore = false;
      }
    } else if (e.type === 'modify') {
      const had = this.pending.get(path);
      const p = this.touch(path, e.at);
      if (!had) p.net = 'changed';
    } else {
      const had = this.pending.get(path);
      if (had && !had.existedBefore) {
        this.pending.delete(path);
        return;
      }
      const p = this.touch(path, e.at);
      p.net = 'removed';
      if (had?.from !== undefined) {
        p.from = undefined as never;
        delete p.from;
        this.pending.set(had.from, { net: 'removed', last: e.at, existedBefore: true });
      }
    }
  }

  /** Changes that have been quiet for the settle time. A moved-from with no moved-to by then was a removal. */
  flush(): WatchChange[] {
    const t = this.now();
    for (const [cookie, f] of this.froms) {
      if (t - f.at >= this.settleMs) {
        this.froms.delete(cookie);
        const p = this.touch(f.path, f.at);
        p.net = 'removed';
      }
    }
    const out: WatchChange[] = [];
    for (const [path, p] of [...this.pending].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (t - p.last < this.settleMs) continue;
      this.pending.delete(path);
      if (p.from !== undefined) out.push({ type: 'moved', from: p.from, path });
      else out.push({ type: p.net, path });
    }
    return out;
  }
}

// ---------------------------------------------------------------- the catalogue in a tree

async function walk(tree: Tree, folder: Node, prefix: string, out: CatalogueEntry[]): Promise<void> {
  for (const n of await tree.list(folder)) {
    const path = prefix ? `${prefix}/${n.name}` : n.name;
    if (n.kind === 'folder') await walk(tree, n, path, out);
    else {
      const sum = n.checksums?.find((c) => c.startsWith('SHA256:'));
      out.push({ id: n.id, path, size: n.size, mtimeMs: n.mtime * 1000, ...(sum ? { hash: `sha256:${sum.slice(7).toLowerCase()}` } : {}), ...(n.props?.['{library}fileId'] ? { fileId: n.props['{library}fileId'] } : {}) });
    }
  }
}

/** Every file in the owner's tree as a catalogue entry. */
export async function loadCatalogue(tree: Tree, owner: string): Promise<CatalogueEntry[]> {
  const out: CatalogueEntry[] = [];
  await walk(tree, await tree.root(owner), '', out);
  return out;
}

export interface Applied {
  readonly added: number;
  readonly changed: number;
  readonly moved: number;
  readonly removed: number;
  /** Paths the tree could not hold (a name it refuses), with the reason. */
  readonly rejected: readonly { path: string; why: string }[];
}

async function ensureDir(tree: Tree, owner: string, dir: string): Promise<void> {
  if (!dir) return;
  let cur = '';
  for (const part of dir.split('/')) {
    cur = cur ? `${cur}/${part}` : part;
    if (!(await tree.resolve(owner, cur))) await tree.mkdir(owner, cur);
  }
}

/** Write a diff into the catalogue. Moves rename the node, so its id and properties stay. */
export async function applyDiff(tree: Tree, owner: string, diff: ScanDiff, o: { confirm?: boolean; catalogueSize?: number; scannedSize?: number } = {}): Promise<Applied> {
  if (!o.confirm) {
    const verdict = checkSafety(diff, o.catalogueSize ?? diff.removed.length + diff.changed.length + diff.moved.length + diff.unchanged, o.scannedSize ?? diff.added.length + diff.changed.length + diff.moved.length + diff.unchanged);
    if (!verdict.ok) throw new SuspiciousScan(verdict.reason!);
  }
  const rejected: { path: string; why: string }[] = [];
  const input = (e: ScanEntry) => ({ size: e.size, blob: `store:${e.path}`, mtime: Math.floor(e.mtimeMs / 1000), ...(e.hash ? { checksums: [e.hash.replace(/^sha256:/, 'SHA256:')] } : {}) });
  const props = async (e: ScanEntry) => {
    if (e.fileId) await tree.setProps(owner, e.path, { '{library}fileId': e.fileId });
  };
  let moved = 0;
  let removed = 0;
  let added = 0;
  let changed = 0;
  for (const m of diff.moved) {
    try {
      await ensureDir(tree, owner, m.to.split('/').slice(0, -1).join('/'));
      if (m.from !== m.to) await tree.move(owner, m.from, m.to, m.how === 'case');
      moved++;
      if (m.alsoChanged) await tree.put(owner, m.to, input(m.entry));
      await props(m.entry);
    } catch (e) {
      rejected.push({ path: m.to, why: (e as Error).message });
    }
  }
  for (const r of diff.removed) {
    try {
      await tree.remove(owner, r.path);
      removed++;
    } catch (e) {
      rejected.push({ path: r.path, why: (e as Error).message });
    }
  }
  for (const c of diff.changed) {
    try {
      await tree.put(owner, c.path, input(c.entry));
      await props(c.entry);
      changed++;
    } catch (e) {
      rejected.push({ path: c.path, why: (e as Error).message });
    }
  }
  for (const a of diff.added) {
    try {
      await ensureDir(tree, owner, a.path.split('/').slice(0, -1).join('/'));
      await tree.put(owner, a.path, input(a));
      await props(a);
      added++;
    } catch (e) {
      rejected.push({ path: a.path, why: (e as Error).message });
    }
  }
  return { added, changed, moved, removed, rejected };
}
