/**
 * Delta sync: moving only what changed of a file, and deciding what to move of a folder.
 *
 * Inside a file (the rsync algorithm of Tridgell and Mackerras, 1996). The side that holds the old copy cuts it into
 * fixed blocks and sends an index of each block's weak rolling checksum and strong hash. The side that holds the new
 * copy slides a window one byte at a time over it, finds blocks of the old copy wherever they now sit (the rolling
 * checksum updates in constant time, and a strong hash confirms every weak hit, so a collision never corrupts a
 * file), and sends a plan: "copy blocks 4 to 9 of the old file", "here are these new bytes", and so on. Applying the
 * plan to the old copy gives the new one, and its whole-file SHA-256 is checked, so a damaged plan or index is
 * caught rather than saved.
 *
 * Across a folder. Two file lists are compared with the list from the last time they agreed: a file changed on one
 * side goes to the other, a file deleted on one side and untouched on the other is deleted there, and a file changed
 * on both sides (or edited on one and deleted on the other) is kept rather than lost: one version stays, the other is
 * saved as a conflict copy with a name that cannot collide. Ignore patterns follow the .gitignore rules (comments,
 * negation, anchoring, trailing slash for folders, `*`, `?`, `[a-z]` and `**`), including that a file inside an
 * ignored folder cannot be re-included.
 *
 * Not here: moving the bytes (the plan and the index are plain data to send however you like), folders as entries
 * (paths of files only), renames (a rename is a delete and an add; a content hash lets the caller spot it), and
 * variable-size (content-defined) chunking. Pure: no clock, no randomness, no file access; dates are arguments.
 * The tree and sync blocks hold the namespace and the transport; this block holds the arithmetic between them.
 */
import { createHash } from 'node:crypto';

export class CorruptPlan extends Error {
  constructor(why: string) {
    super(`the sync plan cannot be applied: ${why}`);
    this.name = 'CorruptPlan';
  }
}
export class InvalidInput extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'InvalidInput';
  }
}

// ---------------------------------------------------------------- rolling checksum

/**
 * The weak checksum of rsync: a is the sum of the bytes and b the sum of each byte times its distance from the end of
 * the window, both modulo 65536; the value is b in the high half and a in the low half. Sliding the window one byte
 * is two additions.
 */
export class Rolling {
  private a = 0;
  private b = 0;
  readonly length: number;

  constructor(window: Uint8Array) {
    this.length = window.length;
    const l = window.length;
    for (let i = 0; i < l; i++) {
      this.a = (this.a + window[i]!) & 0xffff;
      this.b = (this.b + (l - i) * window[i]!) & 0xffff;
    }
  }

  get value(): number {
    return ((this.b << 16) | this.a) >>> 0;
  }

  /** Drops the first byte of the window and adds `next` at the end. */
  roll(out: number, next: number): void {
    this.a = (this.a - out + next) & 0xffff;
    this.b = (this.b - this.length * out + this.a) & 0xffff;
  }
}

export const weakChecksum = (data: Uint8Array): number => new Rolling(data).value;
const strongHash = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex').slice(0, 32);
const fileHash = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

// ---------------------------------------------------------------- index and plan

export interface BlockEntry {
  readonly index: number;
  readonly length: number;
  readonly weak: number;
  readonly strong: string;
}
export interface BlockIndex {
  readonly blockSize: number;
  readonly size: number;
  readonly fileHash: string;
  readonly blocks: readonly BlockEntry[];
}

const MIN_BLOCK = 16;
const MAX_BLOCK = 1 << 20;

/** A good block size for a file: about its square root, between 700 and 128 KiB, as rsync chooses. */
export function chooseBlockSize(size: number): number {
  const b = Math.round(Math.sqrt(Math.max(size, 0)) / 16) * 16;
  return Math.min(Math.max(b, 704), 131_072);
}

/** The index of the old copy: sent to the side that holds the new one. */
export function buildIndex(data: Uint8Array, blockSize: number = chooseBlockSize(data.length)): BlockIndex {
  if (!Number.isInteger(blockSize) || blockSize < MIN_BLOCK || blockSize > MAX_BLOCK) throw new InvalidInput(`the block size must be a whole number from ${MIN_BLOCK} to ${MAX_BLOCK}`);
  const blocks: BlockEntry[] = [];
  for (let off = 0, i = 0; off < data.length; off += blockSize, i++) {
    const part = data.subarray(off, Math.min(off + blockSize, data.length));
    blocks.push({ index: i, length: part.length, weak: weakChecksum(part), strong: strongHash(part) });
  }
  return { blockSize, size: data.length, fileHash: fileHash(data), blocks };
}

export type Op =
  /** `count` consecutive blocks of the old copy, starting at block `index`. */
  | { readonly type: 'copy'; readonly index: number; readonly count: number }
  /** New bytes that match nothing in the old copy. */
  | { readonly type: 'data'; readonly bytes: Uint8Array };

export interface Plan {
  readonly blockSize: number;
  readonly oldSize: number;
  readonly newSize: number;
  readonly newHash: string;
  readonly ops: readonly Op[];
  readonly stats: { readonly copiedBytes: number; readonly literalBytes: number; readonly copyOps: number };
}

/** The plan that turns the old copy (known by its index) into `data`. */
export function plan(old: BlockIndex, data: Uint8Array): Plan {
  const bs = old.blockSize;
  const n = data.length;
  const ops: Op[] = [];
  const full = new Map<number, BlockEntry[]>();
  let short: BlockEntry | null = null;
  for (const b of old.blocks) {
    if (b.length === bs) full.set(b.weak, [...(full.get(b.weak) ?? []), b]);
    else short = b;
  }
  let literalStart = 0;
  let copiedBytes = 0;
  const flush = (end: number) => {
    if (end > literalStart) ops.push({ type: 'data', bytes: data.slice(literalStart, end) });
  };
  const copy = (b: BlockEntry) => {
    const last = ops[ops.length - 1];
    if (last && last.type === 'copy' && last.index + last.count === b.index) ops[ops.length - 1] = { type: 'copy', index: last.index, count: last.count + 1 };
    else ops.push({ type: 'copy', index: b.index, count: 1 });
    copiedBytes += b.length;
  };

  let i = 0;
  if (full.size && n >= bs) {
    let rolling = new Rolling(data.subarray(0, bs));
    while (i + bs <= n) {
      const cands = full.get(rolling.value);
      let hit: BlockEntry | undefined;
      if (cands) {
        const s = strongHash(data.subarray(i, i + bs));
        hit = cands.find((c) => c.strong === s);
      }
      if (hit) {
        flush(i);
        copy(hit);
        i += bs;
        literalStart = i;
        if (i + bs <= n) rolling = new Rolling(data.subarray(i, i + bs));
      } else {
        if (i + bs < n) rolling.roll(data[i]!, data[i + bs]!);
        i++;
      }
    }
  }
  // The old file's last block is short; it can only match the end of the new data.
  const sb: BlockEntry | null = short;
  if (sb && n - sb.length >= literalStart) {
    const at = n - sb.length;
    const tail = data.subarray(at);
    if (weakChecksum(tail) === sb.weak && strongHash(tail) === sb.strong) {
      flush(at);
      copy(sb);
      literalStart = n;
    }
  }
  flush(n);
  let literalBytes = 0;
  let copyOps = 0;
  for (const o of ops) {
    if (o.type === 'data') literalBytes += o.bytes.length;
    else copyOps++;
  }
  return { blockSize: bs, oldSize: old.size, newSize: n, newHash: fileHash(data), ops, stats: { copiedBytes, literalBytes, copyOps } };
}

/** Builds the new copy from the old one and a plan, and checks it against the plan's hash. */
export function apply(old: Uint8Array, p: Plan, o: { maxSize?: number } = {}): Uint8Array {
  if (old.length !== p.oldSize) throw new CorruptPlan(`the plan is for an old file of ${p.oldSize} bytes, this one has ${old.length}`);
  if (p.newSize > (o.maxSize ?? 4 * 2 ** 30)) throw new CorruptPlan(`the new file would be ${p.newSize} bytes, over the limit`);
  const out = new Uint8Array(p.newSize);
  let at = 0;
  for (const op of p.ops) {
    if (op.type === 'data') {
      if (at + op.bytes.length > p.newSize) throw new CorruptPlan('the plan writes past the end of the new file');
      out.set(op.bytes, at);
      at += op.bytes.length;
    } else {
      if (!Number.isInteger(op.index) || !Number.isInteger(op.count) || op.index < 0 || op.count < 1) throw new CorruptPlan('a copy names blocks that do not exist');
      const from = op.index * p.blockSize;
      const to = Math.min((op.index + op.count) * p.blockSize, old.length);
      if (from >= old.length || from >= to) throw new CorruptPlan('a copy starts past the end of the old file');
      if (at + (to - from) > p.newSize) throw new CorruptPlan('the plan writes past the end of the new file');
      out.set(old.subarray(from, to), at);
      at += to - from;
    }
  }
  if (at !== p.newSize) throw new CorruptPlan(`the plan makes ${at} bytes, not ${p.newSize}`);
  if (fileHash(out) !== p.newHash) throw new CorruptPlan('the result does not match the hash of the new file');
  return out;
}

// ---------------------------------------------------------------- comparing two file lists

export interface FileEntry {
  readonly path: string;
  readonly hash: string;
  readonly size?: number;
}
export type ActionType = 'upload' | 'download' | 'delete-local' | 'delete-remote' | 'conflict';
export interface Action {
  readonly type: ActionType;
  readonly path: string;
  readonly reason: string;
  /** For a conflict: the name the local version is saved under, so both survive. */
  readonly localCopyAs?: string;
}

export interface CompareOptions {
  /** The list from the last time both sides agreed (path and hash). */
  readonly base?: readonly FileEntry[];
  readonly ignore?: Ignore;
  readonly device?: string;
  readonly date?: Date;
}

const byPath = (list: readonly FileEntry[]) => new Map(list.map((e) => [e.path, e]));

/**
 * What to do so both sides end up the same, without losing anyone's edit. With no base list, a path on one side only
 * is copied across and a path whose two versions differ is a conflict. Nothing is listed for files already equal.
 */
export function compare(local: readonly FileEntry[], remote: readonly FileEntry[], o: CompareOptions = {}): Action[] {
  const L = byPath(local);
  const R = byPath(remote);
  const B = byPath(o.base ?? []);
  const paths = new Set([...L.keys(), ...R.keys()]);
  const taken = new Set(paths);
  const actions: Action[] = [];
  for (const path of [...paths].sort()) {
    if (o.ignore?.ignores(path)) continue;
    const l = L.get(path);
    const r = R.get(path);
    const b = B.get(path);
    if (l && r && l.hash === r.hash) continue;
    const conflict = (reason: string): Action => {
      const name = conflictName(path, { device: o.device ?? 'this device', date: o.date ?? new Date(0), existing: taken });
      taken.add(name);
      return { type: 'conflict', path, reason, localCopyAs: name };
    };
    if (!b) {
      if (l && !r) actions.push({ type: 'upload', path, reason: 'new here' });
      else if (!l && r) actions.push({ type: 'download', path, reason: 'new there' });
      else actions.push(conflict('different on both sides and no common ancestor'));
      continue;
    }
    if (!l && r) actions.push(r.hash === b.hash ? { type: 'delete-remote', path, reason: 'deleted here, unchanged there' } : { type: 'download', path, reason: 'deleted here but changed there: the change is kept' });
    else if (l && !r) actions.push(l.hash === b.hash ? { type: 'delete-local', path, reason: 'deleted there, unchanged here' } : { type: 'upload', path, reason: 'deleted there but changed here: the change is kept' });
    else if (l && r) {
      if (l.hash === b.hash) actions.push({ type: 'download', path, reason: 'changed there' });
      else if (r.hash === b.hash) actions.push({ type: 'upload', path, reason: 'changed here' });
      else actions.push(conflict('changed on both sides'));
    }
  }
  return actions;
}

/** Groups of paths that differ only in letter case or in how an accent is encoded, which a case-insensitive disk would merge. */
export function nameClashes(paths: readonly string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const k = p.normalize('NFC').toLowerCase();
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort());
}

// ---------------------------------------------------------------- conflict names

const utf8 = (s: string) => new TextEncoder().encode(s).length;

/**
 * The name for the copy kept when two edits clash: "report (conflicted copy from laptop 2026-11-28).txt". The device
 * is made safe for a file name, the date is the day in UTC, a number is added if the name is taken, and the stem is
 * shortened (never in the middle of a character) so the whole name fits 255 bytes.
 */
export function conflictName(path: string, o: { device: string; date: Date; existing?: ReadonlySet<string> | ((name: string) => boolean) }): string {
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const file = path.slice(slash + 1);
  if (!file) throw new InvalidInput('the path has no file name');
  const dot = file.lastIndexOf('.');
  let stem = file;
  let ext = '';
  if (dot > 0 && /^\.[A-Za-z0-9]{1,16}$/.test(file.slice(dot))) {
    stem = file.slice(0, dot);
    ext = file.slice(dot);
    if (/\.tar$/i.test(stem)) {
      ext = stem.slice(-4) + ext;
      stem = stem.slice(0, -4);
    }
  }
  // eslint-disable-next-line no-control-regex
  const device = o.device.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32) || 'device';
  const day = o.date.toISOString().slice(0, 10);
  const taken = (n: string) => (typeof o.existing === 'function' ? o.existing(n) : (o.existing?.has(n) ?? false));
  for (let n = 1; ; n++) {
    const mark = ` (conflicted copy from ${device} ${day})${n > 1 ? ` ${n}` : ''}`;
    let s = stem;
    while (utf8(s + mark + ext) > 255 && s.length > 1) s = [...s].slice(0, -1).join('');
    const name = `${dir}${s}${mark}${ext}`;
    if (!taken(name)) return name;
    if (n > 10_000) throw new InvalidInput('no free conflict name');
  }
}

// ---------------------------------------------------------------- ignore patterns

interface Rule {
  readonly negate: boolean;
  readonly dirOnly: boolean;
  readonly anchored: boolean;
  readonly segments: readonly string[];
}

function matchSegment(pat: string, s: string): boolean {
  // Iterative glob with a single backtrack point for the last *: linear in practice, no regular expressions.
  let p = 0;
  let i = 0;
  let star = -1;
  let mark = 0;
  while (i < s.length) {
    const c = pat[p];
    if (c === '*') {
      star = p++;
      mark = i;
    } else if (c === '?' || (c !== undefined && c !== '[' && c !== '\\' && c === s[i])) {
      p++;
      i++;
    } else if (c === '\\' && pat[p + 1] === s[i]) {
      p += 2;
      i++;
    } else if (c === '[') {
      const end = pat.indexOf(']', p + 2);
      if (end > 0) {
        let set = pat.slice(p + 1, end);
        const neg = set[0] === '!' || set[0] === '^';
        if (neg) set = set.slice(1);
        let hit = false;
        for (let k = 0; k < set.length; k++) {
          if (set[k + 1] === '-' && k + 2 < set.length) {
            if (s[i]! >= set[k]! && s[i]! <= set[k + 2]!) hit = true;
            k += 2;
          } else if (set[k] === s[i]) hit = true;
        }
        if (hit !== neg) {
          p = end + 1;
          i++;
          continue;
        }
      } else if (s[i] === '[') {
        p++;
        i++;
        continue;
      }
      if (star >= 0) {
        p = star + 1;
        i = ++mark;
      } else return false;
    } else if (star >= 0) {
      p = star + 1;
      i = ++mark;
    } else return false;
  }
  while (pat[p] === '*') p++;
  return p === pat.length;
}

function matchPath(pat: readonly string[], pi: number, segs: readonly string[], si: number): boolean {
  while (pi < pat.length) {
    if (pat[pi] === '**') {
      while (pat[pi] === '**') pi++;
      if (pi === pat.length) return true;
      for (let k = si; k <= segs.length; k++) if (matchPath(pat, pi, segs, k)) return true;
      return false;
    }
    if (si >= segs.length || !matchSegment(pat[pi]!, segs[si]!)) return false;
    pi++;
    si++;
  }
  return si === segs.length;
}

/** Ignore patterns in .gitignore syntax. The last matching pattern decides; a file in an ignored folder stays ignored. */
export class Ignore {
  private readonly rules: Rule[] = [];

  constructor(patterns: readonly string[]) {
    for (const raw of patterns) {
      let line = raw.replace(/\r$/, '');
      if (!line.trim() || line.startsWith('#')) continue;
      line = line.replace(/(?<!\\)\s+$/, '');
      let negate = false;
      if (line.startsWith('!')) {
        negate = true;
        line = line.slice(1);
      }
      if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);
      let dirOnly = false;
      if (line.endsWith('/')) {
        dirOnly = true;
        line = line.replace(/\/+$/, '');
      }
      if (!line) continue;
      const anchored = line.includes('/');
      line = line.replace(/^\/+/, '');
      this.rules.push({ negate, dirOnly, anchored, segments: line.split('/') });
    }
  }

  /** Whether the path (relative, with "/" between parts; a trailing "/" marks a folder) is ignored. */
  ignores(path: string): boolean {
    const isDir = path.endsWith('/');
    const segs = path.split('/').filter((s) => s !== '' && s !== '.');
    for (let k = 1; k <= segs.length; k++) {
      const dir = k < segs.length || isDir;
      const prefix = segs.slice(0, k);
      let state: boolean | undefined;
      for (const r of this.rules) {
        if (r.dirOnly && !dir) continue;
        const hit = r.anchored ? matchPath(r.segments, 0, prefix, 0) : matchSegment(r.segments[0]!, prefix[k - 1]!);
        if (hit) state = !r.negate;
      }
      if (state === true) return true;
    }
    return false;
  }
}
