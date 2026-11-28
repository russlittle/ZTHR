/**
 * Text comparison: line, word and character diffs with Myers' O(ND) algorithm, three ways to show the result (unified
 * patch text, a side-by-side table, an inline model), patch reading and applying, and hints for blocks of lines that
 * moved. Standards and sources: E. Myers, "An O(ND) Difference Algorithm and Its Variations" (Algorithmica 1986),
 * here in its linear-space form (the middle snake found from both ends), so memory stays proportional to the input;
 * the unified format as GNU diffutils writes it (hunk headers, "\ No newline at end of file", a zero-length range
 * numbered as the line before it); POSIX patch's idea of applying hunks by their context, with an offset search.
 *
 * What it holds: `diffTokens` (any sequence of strings or numbers, giving equal, delete and insert runs);
 * `diffLines` with options to ignore case or whitespace; `diffWords` and `diffChars` (characters are code points,
 * so an emoji is never cut in two); `unified` (GNU-style hunks with any amount of context); `parsePatch`,
 * `applyPatch` and `reversePatch` (context is checked line by line, a hunk may slide a limited distance, and a
 * hunk that does not match is a conflict, never a guess); `sideBySide` and `inlineModel` for screens, with
 * word-level parts inside lines that were changed rather than replaced; `findMoves` for blocks of lines that were
 * deleted in one place and added in another; `stats`.
 *
 * Safety: input size, line count and the amount of work are limited. When the work limit is reached the diff falls
 * back to a coarse one (common head and tail kept, the middle replaced) and says so with `approximate: true`; it is
 * still a correct diff, only not a minimal one. A patch is checked against its own counts before anything is
 * applied, and applying never reads files or runs anything.
 *
 * Out of scope: diffing binary files, three-way merge, patience or histogram heuristics (the result is minimal, not
 * "pretty"), reading diff formats other than unified, and applying patches to file systems.
 */

export class DiffError extends Error {
  constructor(message: string) { super(message); this.name = new.target.name; }
}
/** The input is larger than the limits allow. */
export class TooLarge extends DiffError {}
/** A patch is not well formed. */
export class PatchError extends DiffError {
  readonly line: number;
  constructor(message: string, line: number) { super(`line ${line}: ${message}`); this.line = line; }
}
/** A hunk does not fit the text it is applied to. */
export class PatchConflict extends DiffError {
  readonly hunk: number;
  constructor(message: string, hunk: number) { super(`hunk ${hunk + 1}: ${message}`); this.hunk = hunk; }
}

// ---------------------------------------------------------------------------------------------------------------
// Myers, linear space
// ---------------------------------------------------------------------------------------------------------------

export interface Seg { readonly type: 'equal' | 'delete' | 'insert'; readonly aStart: number; readonly bStart: number; readonly len: number }
export interface TokenDiff { readonly segs: Seg[]; readonly approximate: boolean }
export interface TokenOptions {
  /** The most inner-loop steps to spend. Default 20 million. */
  readonly maxWork?: number;
}

class OutOfWork extends Error {}

function diffInts(a: Int32Array, b: Int32Array, maxWork: number): { ops: Uint8Array; approximate: boolean } {
  // ops: 0 equal, 1 delete, 2 insert, in order.
  const out: number[] = [];
  let work = 0;
  const push = (op: number, n: number): void => { for (let i = 0; i < n; i++) out.push(op); };

  const rec = (a0: number, a1: number, b0: number, b1: number): void => {
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) { a0++; b0++; push(0, 1); }
    let tail = 0;
    while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) { a1--; b1--; tail++; }
    if (a0 === a1) push(2, b1 - b0);
    else if (b0 === b1) push(1, a1 - a0);
    else {
      const n = a1 - a0; const m = b1 - b0;
      const maxD = Math.ceil((n + m) / 2);
      const off = maxD;
      const len = 2 * maxD;
      const v1 = new Int32Array(len).fill(-1);
      const v2 = new Int32Array(len).fill(-1);
      v1[off + 1] = 0; v2[off + 1] = 0;
      const delta = n - m;
      const front = delta % 2 !== 0;
      let k1s = 0; let k1e = 0; let k2s = 0; let k2e = 0;
      let split: [number, number] | undefined;
      search: for (let d = 0; d < maxD; d++) {
        for (let k1 = -d + k1s; k1 <= d - k1e; k1 += 2) {
          const o1 = off + k1;
          let x1 = k1 === -d || (k1 !== d && v1[o1 - 1]! < v1[o1 + 1]!) ? v1[o1 + 1]! : v1[o1 - 1]! + 1;
          let y1 = x1 - k1;
          while (x1 < n && y1 < m && a[a0 + x1] === b[b0 + y1]) { x1++; y1++; work++; }
          work++;
          v1[o1] = x1;
          if (x1 > n) k1e += 2;
          else if (y1 > m) k1s += 2;
          else if (front) {
            const o2 = off + delta - k1;
            if (o2 >= 0 && o2 < len && v2[o2] !== -1 && x1 >= n - v2[o2]!) { split = [x1, y1]; break search; }
          }
        }
        for (let k2 = -d + k2s; k2 <= d - k2e; k2 += 2) {
          const o2 = off + k2;
          let x2 = k2 === -d || (k2 !== d && v2[o2 - 1]! < v2[o2 + 1]!) ? v2[o2 + 1]! : v2[o2 - 1]! + 1;
          let y2 = x2 - k2;
          while (x2 < n && y2 < m && a[a0 + n - x2 - 1] === b[b0 + m - y2 - 1]) { x2++; y2++; work++; }
          work++;
          v2[o2] = x2;
          if (x2 > n) k2e += 2;
          else if (y2 > m) k2s += 2;
          else if (!front) {
            const o1 = off + delta - k2;
            if (o1 >= 0 && o1 < len && v1[o1] !== -1) {
              const x1 = v1[o1]!;
              const y1 = off + x1 - o1;
              if (x1 >= n - x2) { split = [x1, y1]; break search; }
            }
          }
        }
        if (work > maxWork) throw new OutOfWork();
      }
      if (split) {
        rec(a0, a0 + split[0], b0, b0 + split[1]);
        rec(a0 + split[0], a1, b0 + split[1], b1);
      } else { push(1, a1 - a0); push(2, b1 - b0); }
    }
    push(0, tail);
  };

  try {
    rec(0, a.length, 0, b.length);
    return { ops: Uint8Array.from(out), approximate: false };
  } catch (e) {
    if (!(e instanceof OutOfWork)) throw e;
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    const ops: number[] = [];
    for (let i = 0; i < p; i++) ops.push(0);
    for (let i = 0; i < a.length - p - s; i++) ops.push(1);
    for (let i = 0; i < b.length - p - s; i++) ops.push(2);
    for (let i = 0; i < s; i++) ops.push(0);
    return { ops: Uint8Array.from(ops), approximate: true };
  }
}

function coalesce(ops: Uint8Array): Seg[] {
  const segs: Seg[] = [];
  let a = 0; let b = 0;
  for (let i = 0; i < ops.length;) {
    if (ops[i] === 0) {
      let j = i;
      while (j < ops.length && ops[j] === 0) j++;
      segs.push({ type: 'equal', aStart: a, bStart: b, len: j - i });
      a += j - i; b += j - i; i = j;
    } else {
      let j = i; let dels = 0; let ins = 0;
      while (j < ops.length && ops[j] !== 0) { if (ops[j] === 1) dels++; else ins++; j++; }
      if (dels) segs.push({ type: 'delete', aStart: a, bStart: b, len: dels });
      if (ins) segs.push({ type: 'insert', aStart: a + dels, bStart: b, len: ins });
      a += dels; b += ins; i = j;
    }
  }
  return segs;
}

function intern(a: readonly (string | number)[], b: readonly (string | number)[]): [Int32Array, Int32Array] {
  const ids = new Map<string | number, number>();
  const id = (x: string | number): number => { let v = ids.get(x); if (v === undefined) { v = ids.size; ids.set(x, v); } return v; };
  return [Int32Array.from(a, id), Int32Array.from(b, id)];
}

/** The minimal edit script between two sequences, as runs of equal, deleted and inserted items. */
export function diffTokens(a: readonly (string | number)[], b: readonly (string | number)[], o: TokenOptions = {}): TokenDiff {
  const [ia, ib] = intern(a, b);
  const { ops, approximate } = diffInts(ia, ib, o.maxWork ?? 20_000_000);
  return { segs: coalesce(ops), approximate };
}

// ---------------------------------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------------------------------

export interface LineOptions {
  readonly ignoreCase?: boolean;
  /** 'all' ignores every space and tab; 'change' treats a run of them as one space; 'eol' ignores them (and a carriage return) at the end of a line. */
  readonly ignoreWhitespace?: 'none' | 'all' | 'change' | 'eol';
  readonly maxBytes?: number;
  readonly maxLines?: number;
  readonly maxWork?: number;
}
export interface Side { readonly lines: string[]; readonly endsWithNewline: boolean }
export interface LineDiff {
  readonly a: Side;
  readonly b: Side;
  readonly segs: Seg[];
  readonly approximate: boolean;
  /** The comparison keys: two lines are equal when their keys are. */
  readonly keysA: string[];
  readonly keysB: string[];
}

/** Split into lines at \n. A trailing \r stays on its line, so CRLF and LF files differ unless whitespace is ignored. */
export function splitLines(text: string): Side {
  if (text === '') return { lines: [], endsWithNewline: true };
  const lines = text.split('\n');
  const ends = text.endsWith('\n');
  if (ends) lines.pop();
  return { lines, endsWithNewline: ends };
}
export function joinLines(side: Side): string {
  if (side.lines.length === 0) return '';
  return side.lines.join('\n') + (side.endsWithNewline ? '\n' : '');
}

function keyOf(line: string, o: LineOptions): string {
  let k = line;
  switch (o.ignoreWhitespace) {
    case 'all': k = k.replace(/[ \t\r]+/g, ''); break;
    case 'change': k = k.replace(/[ \t\r]+/g, ' ').replace(/ $/, ''); break;
    case 'eol': k = k.replace(/[ \t\r]+$/, ''); break;
    default: break;
  }
  return o.ignoreCase ? k.toLowerCase() : k;
}

export function diffLines(a: string, b: string, o: LineOptions = {}): LineDiff {
  const maxBytes = o.maxBytes ?? 5_000_000;
  const maxLines = o.maxLines ?? 200_000;
  if (a.length > maxBytes || b.length > maxBytes) throw new TooLarge(`a text is larger than ${maxBytes} characters`);
  const sa = splitLines(a); const sb = splitLines(b);
  if (sa.lines.length > maxLines || sb.lines.length > maxLines) throw new TooLarge(`a text has more than ${maxLines} lines`);
  const keysA = sa.lines.map((l) => keyOf(l, o));
  const keysB = sb.lines.map((l) => keyOf(l, o));
  // A last line with no newline is not the same line as one with a newline.
  if (!sa.endsWithNewline && keysA.length) keysA[keysA.length - 1] += '\u0000';
  if (!sb.endsWithNewline && keysB.length) keysB[keysB.length - 1] += '\u0000';
  const { segs, approximate } = diffTokens(keysA, keysB, o.maxWork === undefined ? {} : { maxWork: o.maxWork });
  return { a: sa, b: sb, segs, approximate, keysA, keysB };
}

export interface Stats { readonly additions: number; readonly deletions: number; readonly unchanged: number; readonly similarity: number }
export function stats(d: { readonly segs: readonly Seg[] }): Stats {
  let additions = 0; let deletions = 0; let unchanged = 0;
  for (const s of d.segs) { if (s.type === 'insert') additions += s.len; else if (s.type === 'delete') deletions += s.len; else unchanged += s.len; }
  const total = unchanged * 2 + additions + deletions;
  return { additions, deletions, unchanged, similarity: total === 0 ? 1 : (unchanged * 2) / total };
}

// ---------------------------------------------------------------------------------------------------------------
// Unified format
// ---------------------------------------------------------------------------------------------------------------

export interface HunkLine { readonly type: ' ' | '-' | '+'; readonly text: string; /** The line has no newline after it. */ readonly noEol?: true }
export interface Hunk { readonly oldStart: number; readonly oldLines: number; readonly newStart: number; readonly newLines: number; readonly section?: string; readonly lines: HunkLine[] }
export interface FilePatch { readonly oldName: string; readonly newName: string; readonly hunks: Hunk[] }

export interface UnifiedOptions { readonly context?: number; readonly oldName?: string; readonly newName?: string }

/** The hunks of a diff with `context` unchanged lines around each change (default 3). */
export function hunks(d: LineDiff, context = 3): Hunk[] {
  if (!Number.isInteger(context) || context < 0 || context > 1000) throw new DiffError('context must be 0 to 1000');
  const changes = d.segs.map((s, i) => [s, i] as const).filter(([s]) => s.type !== 'equal');
  if (changes.length === 0) return [];
  // Merge changes that are close: groups of segment indexes separated by at most 2*context equal lines.
  const groups: [number, number][] = [];
  for (const [, i] of changes) {
    const last = groups[groups.length - 1];
    if (last) {
      let gap = 0;
      for (let j = last[1] + 1; j < i; j++) gap += d.segs[j]!.type === 'equal' ? d.segs[j]!.len : 0;
      if (gap <= 2 * context) { last[1] = i; continue; }
    }
    groups.push([i, i]);
  }
  const out: Hunk[] = [];
  const last = (side: Side, idx: number): boolean => idx === side.lines.length - 1 && !side.endsWithNewline;
  for (const [first, lastSeg] of groups) {
    const lines: HunkLine[] = [];
    const s0 = d.segs[first]!;
    let a = s0.aStart; let b = s0.bStart;
    const before = Math.min(context, first > 0 && d.segs[first - 1]!.type === 'equal' ? d.segs[first - 1]!.len : 0);
    a -= before; b -= before;
    const oldStart = a; const newStart = b;
    for (let i = 0; i < before; i++) lines.push(mk(' ', d.a.lines[a + i]!, last(d.a, a + i) || last(d.b, b + i)));
    for (let i = first; i <= lastSeg; i++) {
      const s = d.segs[i]!;
      if (s.type === 'equal') {
        for (let k = 0; k < s.len; k++) lines.push(mk(' ', d.a.lines[s.aStart + k]!, last(d.a, s.aStart + k) && last(d.b, s.bStart + k)));
      } else if (s.type === 'delete') {
        for (let k = 0; k < s.len; k++) lines.push(mk('-', d.a.lines[s.aStart + k]!, last(d.a, s.aStart + k)));
      } else {
        for (let k = 0; k < s.len; k++) lines.push(mk('+', d.b.lines[s.bStart + k]!, last(d.b, s.bStart + k)));
      }
    }
    const tailSeg = d.segs[lastSeg + 1];
    if (tailSeg && tailSeg.type === 'equal') {
      const n = Math.min(context, tailSeg.len);
      for (let k = 0; k < n; k++) lines.push(mk(' ', d.a.lines[tailSeg.aStart + k]!, last(d.a, tailSeg.aStart + k) && last(d.b, tailSeg.bStart + k)));
    }
    const oldLines = lines.filter((l) => l.type !== '+').length;
    const newLines = lines.filter((l) => l.type !== '-').length;
    out.push({ oldStart: oldLines === 0 ? oldStart : oldStart + 1, oldLines, newStart: newLines === 0 ? newStart : newStart + 1, newLines, lines });
  }
  return out;
}
const mk = (type: ' ' | '-' | '+', text: string, noEol: boolean): HunkLine => (noEol ? { type, text, noEol: true } : { type, text });

const range = (start: number, n: number): string => (n === 1 ? `${start}` : `${start},${n}`);
export function formatHunk(h: Hunk): string {
  let s = `@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@${h.section ? ` ${h.section}` : ''}\n`;
  for (const l of h.lines) { s += `${l.type}${l.text}\n`; if (l.noEol) s += '\\ No newline at end of file\n'; }
  return s;
}
export function formatPatch(p: FilePatch): string {
  return p.hunks.length === 0 ? '' : `--- ${p.oldName}\n+++ ${p.newName}\n${p.hunks.map(formatHunk).join('')}`;
}

/** GNU `diff -u` style text. Empty when the two texts are the same. */
export function unified(a: string, b: string, o: UnifiedOptions & LineOptions = {}): string {
  const d = diffLines(a, b, o);
  return formatPatch({ oldName: o.oldName ?? 'a', newName: o.newName ?? 'b', hunks: hunks(d, o.context ?? 3) });
}

// ---------------------------------------------------------------------------------------------------------------
// Reading and applying patches
// ---------------------------------------------------------------------------------------------------------------

export interface ParseOptions { readonly maxHunks?: number; readonly maxLines?: number }

/** Reads unified diff text. Lines before the first `---` (a `diff --git` line, `index` lines, mail headers) are ignored. */
export function parsePatch(text: string, o: ParseOptions = {}): FilePatch[] {
  const maxHunks = o.maxHunks ?? 10_000;
  const maxLines = o.maxLines ?? 1_000_000;
  const src = text.split('\n');
  if (src.length > maxLines) throw new TooLarge(`a patch has more than ${maxLines} lines`);
  if (src[src.length - 1] === '') src.pop();
  const out: FilePatch[] = [];
  let i = 0;
  const name = (s: string): string => { const t = s.indexOf('\t'); return (t < 0 ? s : s.slice(0, t)).trim(); };
  let total = 0;
  while (i < src.length) {
    const line = src[i]!;
    if (!line.startsWith('--- ') || !(src[i + 1] ?? '').startsWith('+++ ')) { i++; continue; }
    const oldName = name(line.slice(4)); const newName = name(src[i + 1]!.slice(4));
    i += 2;
    const hs: Hunk[] = [];
    while (i < src.length && src[i]!.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/.exec(src[i]!);
      if (!m) throw new PatchError('a hunk header is not in the form @@ -a,b +c,d @@', i + 1);
      const oldLines = m[2] === undefined ? 1 : Number(m[2]);
      const newLines = m[4] === undefined ? 1 : Number(m[4]);
      if (oldLines > maxLines || newLines > maxLines) throw new TooLarge('a hunk claims more lines than the limit');
      if (++total > maxHunks) throw new TooLarge(`more than ${maxHunks} hunks`);
      const header = i + 1;
      i++;
      const lines: HunkLine[] = [];
      let ol = 0; let nl = 0;
      while ((ol < oldLines || nl < newLines) && i < src.length) {
        const l = src[i]!;
        const c = l[0];
        if (c === '\\') { const prev = lines[lines.length - 1]; if (!prev) throw new PatchError('a "no newline" marker with no line before it', i + 1); lines[lines.length - 1] = { ...prev, noEol: true }; i++; continue; }
        if (c !== ' ' && c !== '-' && c !== '+' && l !== '') throw new PatchError('a hunk line must start with a space, - or +', i + 1);
        const type = (l === '' ? ' ' : c) as ' ' | '-' | '+';
        lines.push({ type, text: l.slice(1) });
        if (type !== '+') ol++;
        if (type !== '-') nl++;
        i++;
      }
      if (ol !== oldLines || nl !== newLines) throw new PatchError(`the hunk says ${oldLines} old and ${newLines} new lines but has ${ol} and ${nl}`, header);
      while (i < src.length && src[i]!.startsWith('\\')) { const prev = lines[lines.length - 1]; if (prev) lines[lines.length - 1] = { ...prev, noEol: true }; i++; }
      hs.push({ oldStart: Number(m[1]), oldLines, newStart: Number(m[3]), newLines, ...(m[5] ? { section: m[5] } : {}), lines });
    }
    out.push({ oldName, newName, hunks: hs });
  }
  if (out.length === 0) throw new PatchError('no file patch found (expected a --- and +++ line)', 1);
  return out;
}

export interface ApplyOptions {
  /** How far, in lines, a hunk may be from where its header says. Default 100. */
  readonly maxOffset?: number;
  /** Compare lines with these options (for example ignoring trailing whitespace). */
  readonly compare?: LineOptions;
}

/** Applies one file's patch to `text`. Every context and deleted line must match exactly (or as `compare` says); a hunk that cannot be placed is a PatchConflict. */
export function applyPatch(text: string, patch: FilePatch, o: ApplyOptions = {}): string {
  const side = splitLines(text);
  const lines = side.lines.slice();
  let endsWithNewline = side.endsWithNewline;
  const maxOffset = o.maxOffset ?? 100;
  const key = (l: string): string => keyOf(l, o.compare ?? {});
  let shift = 0;
  let prevEnd = 0;
  patch.hunks.forEach((h, hi) => {
    const oldSide = h.lines.filter((l) => l.type !== '+');
    const newSide = h.lines.filter((l) => l.type !== '-');
    const want = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
    const base = want + shift;
    const fits = (at: number): boolean => {
      if (at < prevEnd || at + oldSide.length > lines.length) return false;
      for (let k = 0; k < oldSide.length; k++) if (key(lines[at + k]!) !== key(oldSide[k]!.text)) return false;
      // A line the hunk says has no newline must be the last line of a text without one, and the other way round.
      const lastOld = oldSide[oldSide.length - 1];
      const reachesEnd = at + oldSide.length === lines.length;
      if (lastOld?.noEol && !(reachesEnd && !endsWithNewline)) return false;
      if (reachesEnd && !endsWithNewline && oldSide.length > 0 && !lastOld?.noEol) return false;
      return true;
    };
    let at = -1;
    for (let d = 0; d <= maxOffset && at < 0; d++) {
      if (fits(base + d)) at = base + d;
      else if (d > 0 && fits(base - d)) at = base - d;
    }
    if (at < 0) throw new PatchConflict(oldSide.length === 0 ? 'cannot place an insertion there' : 'the lines to change are not where the patch expects them', hi);
    const reachesEnd = at + oldSide.length === lines.length;
    lines.splice(at, oldSide.length, ...newSide.map((l) => l.text));
    if (reachesEnd) {
      const lastNew = newSide[newSide.length - 1];
      if (lastNew) endsWithNewline = !lastNew.noEol;
      else endsWithNewline = true; // what is left now ends with a line that used to be followed by another one
    }
    shift += newSide.length - oldSide.length + (at - base);
    prevEnd = at + newSide.length;
  });
  return joinLines({ lines, endsWithNewline });
}

/** The patch that undoes `patch`. */
export function reversePatch(patch: FilePatch): FilePatch {
  return {
    oldName: patch.newName,
    newName: patch.oldName,
    hunks: patch.hunks.map((h) => ({
      oldStart: h.newStart, oldLines: h.newLines, newStart: h.oldStart, newLines: h.oldLines,
      ...(h.section ? { section: h.section } : {}),
      lines: h.lines.map((l) => ({ ...l, type: l.type === '+' ? '-' as const : l.type === '-' ? '+' as const : ' ' as const })),
    })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Words and characters
// ---------------------------------------------------------------------------------------------------------------

export interface Part { readonly type: 'equal' | 'delete' | 'insert'; readonly text: string }

export function tokenizeWords(s: string): string[] { return s.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? []; }

function partsOf(tokensA: readonly string[], tokensB: readonly string[], maxWork: number): { parts: Part[]; approximate: boolean } {
  const d = diffTokens(tokensA, tokensB, { maxWork });
  const parts: Part[] = [];
  const add = (type: Part['type'], text: string): void => {
    const last = parts[parts.length - 1];
    if (last && last.type === type) parts[parts.length - 1] = { type, text: last.text + text };
    else parts.push({ type, text });
  };
  for (const s of d.segs) {
    const toks = s.type === 'insert' ? tokensB.slice(s.bStart, s.bStart + s.len) : tokensA.slice(s.aStart, s.aStart + s.len);
    add(s.type, toks.join(''));
  }
  return { parts, approximate: d.approximate };
}

export interface PartsOptions { readonly maxChars?: number; readonly maxWork?: number }
export function diffWords(a: string, b: string, o: PartsOptions = {}): Part[] {
  const max = o.maxChars ?? 1_000_000;
  if (a.length > max || b.length > max) throw new TooLarge(`a text is longer than ${max} characters`);
  return partsOf(tokenizeWords(a), tokenizeWords(b), o.maxWork ?? 20_000_000).parts;
}
/** Character diff by code point. */
export function diffChars(a: string, b: string, o: PartsOptions = {}): Part[] {
  const max = o.maxChars ?? 200_000;
  if (a.length > max || b.length > max) throw new TooLarge(`a text is longer than ${max} characters`);
  return partsOf(Array.from(a), Array.from(b), o.maxWork ?? 20_000_000).parts;
}
/** The text of one side of a parts list: `old` is the equal and deleted parts, `new` the equal and inserted ones. */
export function sideText(parts: readonly Part[], which: 'old' | 'new'): string {
  return parts.filter((p) => p.type === 'equal' || p.type === (which === 'old' ? 'delete' : 'insert')).map((p) => p.text).join('');
}
const equalRatio = (parts: readonly Part[]): number => {
  const eq = parts.filter((p) => p.type === 'equal').reduce((n, p) => n + p.text.length, 0);
  const all = parts.reduce((n, p) => n + p.text.length, 0);
  return all === 0 ? 1 : (eq * 2) / (all + eq);
};

// ---------------------------------------------------------------------------------------------------------------
// Moved blocks
// ---------------------------------------------------------------------------------------------------------------

export interface Move { readonly id: number; readonly from: { readonly aStart: number; readonly len: number }; readonly to: { readonly bStart: number; readonly len: number } }
export interface MoveOptions { readonly minLines?: number; readonly minChars?: number }

/**
 * Blocks of at least `minLines` lines (and `minChars` non-blank characters) that were deleted in one place and added,
 * unchanged, in another. Only lines that the diff reported as deleted or inserted are considered, and each line
 * belongs to at most one move; longer blocks are claimed first.
 */
export function findMoves(d: LineDiff, o: MoveOptions = {}): Move[] {
  const minLines = o.minLines ?? 3;
  const minChars = o.minChars ?? 20;
  const del = new Set<number>(); const ins = new Set<number>();
  for (const s of d.segs) { if (s.type === 'delete') for (let k = 0; k < s.len; k++) del.add(s.aStart + k); else if (s.type === 'insert') for (let k = 0; k < s.len; k++) ins.add(s.bStart + k); }
  const byKey = new Map<string, number[]>();
  for (const i of del) { const k = d.keysA[i]!; if (k.trim().length < 3) continue; (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(i); }
  const cands: { i: number; j: number; len: number }[] = [];
  for (const j of ins) {
    if (j > 0 && ins.has(j - 1)) { /* a block may start mid-way only if its predecessor differs; handled by maximality below */ }
    const list = byKey.get(d.keysB[j]!);
    if (!list) continue;
    for (const i of list.slice(0, 50)) {
      if (i > 0 && j > 0 && del.has(i - 1) && ins.has(j - 1) && d.keysA[i - 1] === d.keysB[j - 1]) continue;
      let len = 0;
      while (del.has(i + len) && ins.has(j + len) && d.keysA[i + len] === d.keysB[j + len]) len++;
      if (len >= minLines) cands.push({ i, j, len });
    }
  }
  cands.sort((x, y) => y.len - x.len || x.i - y.i || x.j - y.j);
  const usedA = new Set<number>(); const usedB = new Set<number>();
  const moves: Move[] = [];
  for (const c of cands) {
    let chars = 0; let free = true;
    for (let k = 0; k < c.len; k++) { if (usedA.has(c.i + k) || usedB.has(c.j + k)) { free = false; break; } chars += d.keysA[c.i + k]!.replace(/\s/g, '').length; }
    if (!free || chars < minChars) continue;
    for (let k = 0; k < c.len; k++) { usedA.add(c.i + k); usedB.add(c.j + k); }
    moves.push({ id: moves.length + 1, from: { aStart: c.i, len: c.len }, to: { bStart: c.j, len: c.len } });
  }
  return moves.sort((x, y) => x.from.aStart - y.from.aStart);
}

// ---------------------------------------------------------------------------------------------------------------
// Models for screens
// ---------------------------------------------------------------------------------------------------------------

export interface ModelOptions extends LineOptions {
  /** Unchanged lines kept around changes; the rest become one `gap` row. Default: keep all. */
  readonly context?: number;
  /** Mark moved blocks (default false). */
  readonly moves?: boolean | MoveOptions;
  /** Show word-level parts inside lines that were changed, not replaced (default true). */
  readonly intraline?: boolean;
  /** Lines longer than this get no word-level parts. Default 2000. */
  readonly maxIntralineChars?: number;
}
export interface Cell { readonly no: number; readonly text: string; readonly parts?: Part[]; readonly moved?: number }
export type Row =
  | { readonly kind: 'equal'; readonly left: Cell; readonly right: Cell }
  | { readonly kind: 'change'; readonly left: Cell; readonly right: Cell }
  | { readonly kind: 'delete'; readonly left: Cell }
  | { readonly kind: 'insert'; readonly right: Cell }
  | { readonly kind: 'gap'; readonly skipped: number };

function moveMaps(d: LineDiff, o: ModelOptions): { a: Map<number, number>; b: Map<number, number>; moves: Move[] } {
  const a = new Map<number, number>(); const b = new Map<number, number>();
  if (!o.moves) return { a, b, moves: [] };
  const moves = findMoves(d, o.moves === true ? {} : o.moves);
  for (const m of moves) for (let k = 0; k < m.from.len; k++) { a.set(m.from.aStart + k, m.id); b.set(m.to.bStart + k, m.id); }
  return { a, b, moves };
}

/** Rows for a two-column view. Deleted and inserted lines in the same place are paired up row by row as `change`. */
export function sideBySide(a: string, b: string, o: ModelOptions = {}): { rows: Row[]; moves: Move[]; approximate: boolean; stats: Stats } {
  const d = diffLines(a, b, o);
  const mv = moveMaps(d, o);
  const rows: Row[] = [];
  const cell = (side: Side, i: number, m: Map<number, number>, parts?: Part[]): Cell => {
    const id = m.get(i);
    return { no: i + 1, text: side.lines[i]!, ...(parts ? { parts } : {}), ...(id !== undefined ? { moved: id } : {}) };
  };
  const maxIn = o.maxIntralineChars ?? 2000;
  for (let s = 0; s < d.segs.length; s++) {
    const seg = d.segs[s]!;
    if (seg.type === 'equal') { for (let k = 0; k < seg.len; k++) rows.push({ kind: 'equal', left: cell(d.a, seg.aStart + k, mv.a), right: cell(d.b, seg.bStart + k, mv.b) }); continue; }
    if (seg.type === 'insert') {
      if (d.segs[s - 1]?.type !== 'delete') for (let k = 0; k < seg.len; k++) rows.push({ kind: 'insert', right: cell(d.b, seg.bStart + k, mv.b) });
      continue;
    }
    const next = d.segs[s + 1];
    const ins = next && next.type === 'insert' ? next : undefined;
    const pairs = ins ? Math.min(seg.len, ins.len) : 0;
    for (let k = 0; k < seg.len; k++) {
      const ai = seg.aStart + k;
      if (k < pairs) {
        const bi = ins!.bStart + k;
        let pa: Part[] | undefined; let pb: Part[] | undefined;
        if (o.intraline !== false && !mv.a.has(ai) && !mv.b.has(bi) && d.a.lines[ai]!.length <= maxIn && d.b.lines[bi]!.length <= maxIn) {
          const parts = diffWords(d.a.lines[ai]!, d.b.lines[bi]!, { maxWork: 200_000 });
          if (equalRatio(parts) >= 0.3) { pa = parts; pb = parts; }
        }
        rows.push({ kind: 'change', left: cell(d.a, ai, mv.a, pa), right: cell(d.b, bi, mv.b, pb) });
      } else rows.push({ kind: 'delete', left: cell(d.a, ai, mv.a) });
    }
    if (ins) for (let k = pairs; k < ins.len; k++) rows.push({ kind: 'insert', right: cell(d.b, ins.bStart + k, mv.b) });
  }
  return { rows: o.context === undefined ? rows : collapse(rows, o.context), moves: mv.moves, approximate: d.approximate, stats: stats(d) };
}

function collapse(rows: Row[], context: number): Row[] {
  if (!Number.isInteger(context) || context < 0) throw new DiffError('context must be a whole number, 0 or more');
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, i) => { if (r.kind !== 'equal') for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true; });
  const out: Row[] = [];
  let skipped = 0;
  rows.forEach((r, i) => {
    if (keep[i]) { if (skipped) { out.push({ kind: 'gap', skipped }); skipped = 0; } out.push(r); } else skipped++;
  });
  if (skipped) out.push({ kind: 'gap', skipped });
  return out;
}

export type InlineLine =
  | { readonly kind: 'equal'; readonly oldNo: number; readonly newNo: number; readonly text: string }
  | { readonly kind: 'delete'; readonly oldNo: number; readonly text: string; readonly moved?: number }
  | { readonly kind: 'insert'; readonly newNo: number; readonly text: string; readonly moved?: number }
  /** One line showing an old line turned into a new one, with deleted and inserted words in place. */
  | { readonly kind: 'change'; readonly oldNo: number; readonly newNo: number; readonly parts: Part[] }
  | { readonly kind: 'gap'; readonly skipped: number };

/** A single column: unchanged lines, whole deleted and inserted lines, and `change` lines with the words that changed marked in place. */
export function inlineModel(a: string, b: string, o: ModelOptions = {}): { lines: InlineLine[]; moves: Move[]; approximate: boolean; stats: Stats } {
  const sbs = sideBySide(a, b, { ...o, context: undefined as never });
  const lines: InlineLine[] = [];
  for (const r of sbs.rows) {
    if (r.kind === 'equal') lines.push({ kind: 'equal', oldNo: r.left.no, newNo: r.right.no, text: r.left.text });
    else if (r.kind === 'delete') lines.push({ kind: 'delete', oldNo: r.left.no, text: r.left.text, ...(r.left.moved !== undefined ? { moved: r.left.moved } : {}) });
    else if (r.kind === 'insert') lines.push({ kind: 'insert', newNo: r.right.no, text: r.right.text, ...(r.right.moved !== undefined ? { moved: r.right.moved } : {}) });
    else if (r.kind === 'change') {
      if (r.left.parts) lines.push({ kind: 'change', oldNo: r.left.no, newNo: r.right.no, parts: r.left.parts });
      else {
        lines.push({ kind: 'delete', oldNo: r.left.no, text: r.left.text, ...(r.left.moved !== undefined ? { moved: r.left.moved } : {}) });
        lines.push({ kind: 'insert', newNo: r.right.no, text: r.right.text, ...(r.right.moved !== undefined ? { moved: r.right.moved } : {}) });
      }
    }
  }
  const out = o.context === undefined ? lines : collapseInline(lines, o.context);
  return { lines: out, moves: sbs.moves, approximate: sbs.approximate, stats: sbs.stats };
}
function collapseInline(lines: InlineLine[], context: number): InlineLine[] {
  if (!Number.isInteger(context) || context < 0) throw new DiffError('context must be a whole number, 0 or more');
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => { if (l.kind !== 'equal') for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true; });
  const out: InlineLine[] = [];
  let skipped = 0;
  lines.forEach((l, i) => { if (keep[i]) { if (skipped) { out.push({ kind: 'gap', skipped }); skipped = 0; } out.push(l); } else skipped++; });
  if (skipped) out.push({ kind: 'gap', skipped });
  return out;
}
