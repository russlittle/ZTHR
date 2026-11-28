/**
 * JSON Pointer (RFC 6901), JSON Patch (RFC 6902) and JSON Merge Patch (RFC 7396), done so that a patch from outside
 * cannot do harm. Holds: pointers parsed and formatted with the ~0 and ~1 escapes and the URI fragment form, array
 * indexes accepted only in their canonical form (no "01", no "+1", no "-0"); patches checked for shape before
 * anything runs; apply that is atomic (the input is never changed; a failure at operation 7 leaves nothing of
 * operations 1 to 6), with every RFC rule: add at an index or "-", remove and replace that need the target,
 * move that refuses to move a value into itself, copy, and test that compares by JSON equality (key order and 1
 * versus 1.0 do not matter); errors that name the operation, its index and a code; a dry run that reports every
 * failing operation instead of the first; refusal of "__proto__" as a key (a patch cannot reach into prototypes),
 * limits on operation count, document depth and pointer length; merge patch with its known limit (null means
 * delete, so a null cannot be set that way); making patches (diff, with an option to guard each change with a test
 * of the old value, and a merge patch from two documents); inverting a patch for undo; stale-patch checking (which
 * operations touch values that changed since the patch was made); and a three-way merge of two edited copies of one
 * base that applies both where they do not collide and reports each collision with all three values. Not here:
 * JSON Patch extensions (move detection in diffs, array merge by key beyond the `idKey` option), schema validation,
 * and streaming of big documents.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type PatchErrorCode = 'invalid_patch' | 'invalid_pointer' | 'not_found' | 'out_of_range' | 'test_failed' | 'bad_target' | 'forbidden_key' | 'limit' | 'invalid_move';

export class PatchError extends Error {
  readonly code: PatchErrorCode;
  readonly index: number;
  readonly path: string | undefined;
  constructor(code: PatchErrorCode, message: string, index = -1, path?: string) {
    super(index >= 0 ? `operation ${index}${path !== undefined ? ` (${path})` : ''}: ${message}` : message);
    this.code = code;
    this.index = index;
    this.path = path;
  }
}

const MAX_OPS = 10_000;
const MAX_DEPTH = 200;
const MAX_POINTER = 4096;

// ---------------------------------------------------------------- pointers

export const escapeToken = (t: string): string => t.replace(/~/g, '~0').replace(/\//g, '~1');

export function unescapeToken(t: string): string {
  if (/~(?![01])/.test(t) || t.endsWith('~')) throw new PatchError('invalid_pointer', `bad escape in ${JSON.stringify(t)}: ~ must be followed by 0 or 1`);
  return t.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** "/a/b~1c/0" to ["a", "b/c", "0"]. The empty string is the whole document (no tokens). */
export function parsePointer(p: string): string[] {
  if (typeof p !== 'string') throw new PatchError('invalid_pointer', 'a pointer must be a string');
  if (p.length > MAX_POINTER) throw new PatchError('limit', `a pointer may be at most ${MAX_POINTER} characters`);
  if (p === '') return [];
  if (!p.startsWith('/')) throw new PatchError('invalid_pointer', `a pointer is empty or starts with "/": ${JSON.stringify(p.slice(0, 40))}`);
  return p.slice(1).split('/').map(unescapeToken);
}

export const formatPointer = (tokens: readonly string[]): string => tokens.map((t) => `/${escapeToken(t)}`).join('');

/** The URI fragment form: "#/a%20b". */
export function fromFragment(f: string): string[] {
  if (!f.startsWith('#')) throw new PatchError('invalid_pointer', 'a fragment pointer starts with #');
  let d: string;
  try {
    d = decodeURIComponent(f.slice(1));
  } catch {
    throw new PatchError('invalid_pointer', 'bad percent-encoding');
  }
  return parsePointer(d);
}

export const toFragment = (tokens: readonly string[]): string => `#${formatPointer(tokens).split('').map((c) => (/[A-Za-z0-9\-._~!$&'()*+,;=:@/]/.test(c) ? c : encodeURIComponent(c))).join('')}`;

const isObj = (v: unknown): v is { [k: string]: Json } => v !== null && typeof v === 'object' && !Array.isArray(v);
const FORBIDDEN = new Set(['__proto__']);

/** An array index in canonical form, or null. */
const asIndex = (t: string): number | null => (/^(0|[1-9][0-9]*)$/.test(t) && t.length < 16 ? Number(t) : null);

function step(cur: Json | undefined, tok: string): Json | undefined {
  if (Array.isArray(cur)) {
    const i = asIndex(tok);
    return i !== null && i < cur.length ? cur[i] : undefined;
  }
  if (isObj(cur) && Object.hasOwn(cur, tok)) return cur[tok];
  return undefined;
}

/** The value at a pointer, or undefined. Never reads inherited properties. */
export function getPointer(doc: Json, pointer: string | readonly string[]): Json | undefined {
  const tokens = typeof pointer === 'string' ? parsePointer(pointer) : pointer;
  let cur: Json | undefined = doc;
  for (const t of tokens) {
    cur = step(cur, t);
    if (cur === undefined) return undefined;
  }
  return cur;
}

// ---------------------------------------------------------------- equality and checks

export function jsonEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) throw new PatchError('limit', `nested more than ${MAX_DEPTH} deep`);
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return typeof a === 'number' && typeof b === 'number' ? Object.is(a, b) || a === b : false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => jsonEqual(x, (b as unknown[])[i], depth + 1));
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b as object, k) && jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth + 1));
}

/** Throws if a document is nested too deep or has a forbidden key; the shape a patch must not be able to build. */
function checkDoc(v: unknown, depth = 0): void {
  if (depth > MAX_DEPTH) throw new PatchError('limit', `nested more than ${MAX_DEPTH} deep`);
  if (Array.isArray(v)) for (const x of v) checkDoc(x, depth + 1);
  else if (v !== null && typeof v === 'object') for (const k of Object.keys(v)) {
    if (FORBIDDEN.has(k)) throw new PatchError('forbidden_key', `the key ${k} is not allowed`);
    checkDoc((v as Record<string, unknown>)[k], depth + 1);
  }
}

const clone = <T extends Json>(v: T): T => structuredClone(v);

// ---------------------------------------------------------------- patch

export type Operation =
  | { readonly op: 'add' | 'replace' | 'test'; readonly path: string; readonly value: Json }
  | { readonly op: 'remove'; readonly path: string }
  | { readonly op: 'move' | 'copy'; readonly path: string; readonly from: string };

export type Patch = readonly Operation[];

/** Shape checks that need no document; returns one message per problem. */
export function validatePatch(patch: unknown): string[] {
  if (!Array.isArray(patch)) return ['a patch is an array of operations'];
  const out: string[] = [];
  if (patch.length > MAX_OPS) out.push(`more than ${MAX_OPS} operations`);
  patch.slice(0, MAX_OPS).forEach((o, i) => {
    if (!isObj(o)) return void out.push(`operation ${i} is not an object`);
    if (typeof o.op !== 'string' || !['add', 'remove', 'replace', 'move', 'copy', 'test'].includes(o.op)) return void out.push(`operation ${i} has unknown op ${JSON.stringify(o.op)}`);
    if (typeof o.path !== 'string') out.push(`operation ${i} needs a string path`);
    else
      try {
        parsePointer(o.path);
      } catch (e) {
        out.push(`operation ${i}: ${(e as Error).message}`);
      }
    if (['add', 'replace', 'test'].includes(o.op) && !Object.hasOwn(o, 'value')) out.push(`operation ${i} (${o.op}) needs a value`);
    if (['move', 'copy'].includes(o.op)) {
      if (typeof o.from !== 'string') out.push(`operation ${i} (${o.op}) needs a string from`);
      else
        try {
          parsePointer(o.from);
        } catch (e) {
          out.push(`operation ${i}: ${(e as Error).message}`);
        }
    }
  });
  return out;
}

export interface ApplyOptions {
  /** Change the given document instead of a copy (faster; on failure it is left partly changed, so default is false). */
  readonly mutate?: boolean;
}

function parentOf(root: Json, tokens: string[], i: number, p: string): { parent: Json; last: string } {
  if (tokens.length === 0) throw new PatchError('bad_target', 'the document root has no parent', i, p);
  let cur: Json | undefined = root;
  for (const t of tokens.slice(0, -1)) {
    cur = step(cur, t);
    if (cur === undefined) throw new PatchError('not_found', `${formatPointer(tokens.slice(0, tokens.indexOf(t) + 1))} does not exist`, i, p);
  }
  return { parent: cur as Json, last: tokens[tokens.length - 1]! };
}

function addAt(root: Json, tokens: string[], value: Json, i: number, p: string): Json {
  if (tokens.length === 0) return value;
  const { parent, last } = parentOf(root, tokens, i, p);
  if (Array.isArray(parent)) {
    const idx = last === '-' ? parent.length : asIndex(last);
    if (idx === null) throw new PatchError('invalid_pointer', `${JSON.stringify(last)} is not an array index`, i, p);
    if (idx > parent.length) throw new PatchError('out_of_range', `index ${idx} is past the end (${parent.length} items)`, i, p);
    parent.splice(idx, 0, value);
  } else if (isObj(parent)) {
    if (FORBIDDEN.has(last)) throw new PatchError('forbidden_key', `the key ${last} is not allowed`, i, p);
    Object.defineProperty(parent, last, { value, writable: true, enumerable: true, configurable: true });
  } else throw new PatchError('bad_target', 'the parent is not an object or array', i, p);
  return root;
}

function removeAt(root: Json, tokens: string[], i: number, p: string): { root: Json; removed: Json } {
  if (tokens.length === 0) throw new PatchError('bad_target', 'the document root cannot be removed', i, p);
  const { parent, last } = parentOf(root, tokens, i, p);
  if (Array.isArray(parent)) {
    const idx = asIndex(last);
    if (idx === null || idx >= parent.length) throw new PatchError(idx === null ? 'invalid_pointer' : 'not_found', `no item ${JSON.stringify(last)}`, i, p);
    return { root, removed: parent.splice(idx, 1)[0]! };
  }
  if (isObj(parent) && Object.hasOwn(parent, last)) {
    const removed = parent[last]!;
    delete parent[last];
    return { root, removed };
  }
  throw new PatchError('not_found', `no member ${JSON.stringify(last)}`, i, p);
}

function applyOne(root: Json, o: Operation, i: number): Json {
  const tokens = parsePointer(o.path);
  switch (o.op) {
    case 'add': {
      checkDoc(o.value);
      return addAt(root, tokens, clone(o.value), i, o.path);
    }
    case 'remove': return removeAt(root, tokens, i, o.path).root;
    case 'replace': {
      checkDoc(o.value);
      if (getPointer(root, tokens) === undefined) throw new PatchError('not_found', 'there is nothing to replace', i, o.path);
      if (tokens.length === 0) return clone(o.value);
      removeAt(root, tokens, i, o.path);
      return addAt(root, tokens, clone(o.value), i, o.path);
    }
    case 'test': {
      const cur = getPointer(root, tokens);
      if (cur === undefined || !jsonEqual(cur, o.value)) throw new PatchError('test_failed', `the value there is ${cur === undefined ? 'missing' : JSON.stringify(cur).slice(0, 80)}, not ${JSON.stringify(o.value).slice(0, 80)}`, i, o.path);
      return root;
    }
    case 'copy': {
      const from = parsePointer(o.from);
      const v = getPointer(root, from);
      if (v === undefined) throw new PatchError('not_found', `${o.from} does not exist`, i, o.path);
      return addAt(root, tokens, clone(v), i, o.path);
    }
    case 'move': {
      const from = parsePointer(o.from);
      if (getPointer(root, from) === undefined) throw new PatchError('not_found', `${o.from} does not exist`, i, o.path);
      if (from.length < tokens.length && from.every((t, k) => tokens[k] === t)) throw new PatchError('invalid_move', 'a value cannot be moved into itself', i, o.path);
      if (from.length === tokens.length && from.every((t, k) => tokens[k] === t)) return root;
      const r = removeAt(root, from, i, o.path);
      return addAt(r.root, tokens, r.removed, i, o.path);
    }
  }
}

/** Applies a patch atomically and returns the new document. */
export function applyPatch<T extends Json>(doc: T, patch: Patch, o: ApplyOptions = {}): Json {
  const problems = validatePatch(patch);
  if (problems.length) throw new PatchError('invalid_patch', problems.join('; '));
  checkDoc(doc);
  let work: Json = o.mutate ? doc : clone(doc);
  patch.forEach((op, i) => {
    work = applyOne(work, op, i);
  });
  return work;
}

export interface DryRun {
  readonly ok: boolean;
  /** The document with every operation that could be applied, applied. */
  readonly doc: Json;
  readonly errors: { readonly index: number; readonly op: string; readonly path: string; readonly code: PatchErrorCode; readonly message: string }[];
}

/** Runs every operation, skipping those that fail, and reports all failures at once. The input is not changed. */
export function dryRun(doc: Json, patch: Patch): DryRun {
  const problems = validatePatch(patch);
  if (problems.length) throw new PatchError('invalid_patch', problems.join('; '));
  let work = clone(doc);
  const errors: DryRun['errors'][number][] = [];
  patch.forEach((op, i) => {
    const before = clone(work);
    try {
      work = applyOne(work, op, i);
    } catch (e) {
      work = before;
      const pe = e as PatchError;
      errors.push({ index: i, op: op.op, path: op.path, code: pe.code ?? 'invalid_patch', message: pe.message });
    }
  });
  return { ok: errors.length === 0, doc: work, errors };
}

/** The patch that undoes `patch` on `doc`: apply the result to the patched document to get `doc` back. */
export function invertPatch(doc: Json, patch: Patch): Operation[] {
  let work = clone(doc);
  const undo: Operation[][] = [];
  patch.forEach((op, i) => {
    const tokens = parsePointer(op.path);
    const u: Operation[] = [];
    if (op.op === 'add') {
      const parent = tokens.length ? getPointer(work, tokens.slice(0, -1)) : undefined;
      const last = tokens[tokens.length - 1];
      if (tokens.length === 0) u.push({ op: 'replace', path: '', value: clone(work) });
      else if (Array.isArray(parent)) u.push({ op: 'remove', path: formatPointer([...tokens.slice(0, -1), String(last === '-' ? parent.length : Number(last))]) });
      else if (getPointer(work, tokens) !== undefined) u.push({ op: 'replace', path: op.path, value: clone(getPointer(work, tokens)!) });
      else u.push({ op: 'remove', path: op.path });
    } else if (op.op === 'remove') {
      const v = getPointer(work, tokens);
      if (v !== undefined) u.push({ op: 'add', path: op.path, value: clone(v) });
    } else if (op.op === 'replace') {
      const v = getPointer(work, tokens);
      if (v !== undefined) u.push({ op: 'replace', path: op.path, value: clone(v) });
    } else if (op.op === 'copy') {
      const v = getPointer(work, tokens);
      const parent = tokens.length ? getPointer(work, tokens.slice(0, -1)) : undefined;
      if (v !== undefined && !Array.isArray(parent)) u.push({ op: 'replace', path: op.path, value: clone(v) });
      else u.push({ op: 'remove', path: Array.isArray(parent) ? formatPointer([...tokens.slice(0, -1), tokens[tokens.length - 1] === '-' ? String(parent.length) : tokens[tokens.length - 1]!]) : op.path });
    } else if (op.op === 'move') u.push({ op: 'move', path: op.from, from: op.path });
    work = applyOne(work, op, i);
    undo.push(u);
  });
  return undo.reverse().flat();
}

// ---------------------------------------------------------------- diff

export interface DiffOptions {
  /** Put a test of the old value before each replace and remove, so the patch fails on a document that has moved on. */
  readonly guard?: boolean;
  /** "index" compares arrays item by item; "replace" replaces a changed array whole. Default index. */
  readonly arrays?: 'index' | 'replace';
}

/** A patch that turns `a` into `b`. apply(a, diff(a, b)) equals b. */
export function diff(a: Json, b: Json, o: DiffOptions = {}): Operation[] {
  const out: Operation[] = [];
  const guard = o.guard ?? false;
  const walk = (x: Json, y: Json, tokens: string[], depth: number) => {
    if (depth > MAX_DEPTH) throw new PatchError('limit', `nested more than ${MAX_DEPTH} deep`);
    if (jsonEqual(x, y)) return;
    const path = formatPointer(tokens);
    if (isObj(x) && isObj(y)) {
      for (const k of Object.keys(x)) if (!Object.hasOwn(y, k)) {
        if (guard) out.push({ op: 'test', path: formatPointer([...tokens, k]), value: clone(x[k]!) });
        out.push({ op: 'remove', path: formatPointer([...tokens, k]) });
      }
      for (const k of Object.keys(y)) {
        if (!Object.hasOwn(x, k)) out.push({ op: 'add', path: formatPointer([...tokens, k]), value: clone(y[k]!) });
        else walk(x[k]!, y[k]!, [...tokens, k], depth + 1);
      }
    } else if (Array.isArray(x) && Array.isArray(y) && (o.arrays ?? 'index') === 'index') {
      let pre = 0;
      while (pre < x.length && pre < y.length && jsonEqual(x[pre], y[pre])) pre++;
      let suf = 0;
      while (suf < x.length - pre && suf < y.length - pre && jsonEqual(x[x.length - 1 - suf], y[y.length - 1 - suf])) suf++;
      const xm = x.slice(pre, x.length - suf);
      const ym = y.slice(pre, y.length - suf);
      const common = Math.min(xm.length, ym.length);
      for (let i = 0; i < common; i++) walk(xm[i]!, ym[i]!, [...tokens, String(pre + i)], depth + 1);
      for (let i = xm.length - 1; i >= common; i--) {
        if (guard) out.push({ op: 'test', path: formatPointer([...tokens, String(pre + i)]), value: clone(xm[i]!) });
        out.push({ op: 'remove', path: formatPointer([...tokens, String(pre + i)]) });
      }
      for (let i = common; i < ym.length; i++) out.push({ op: 'add', path: formatPointer([...tokens, String(pre + i)]), value: clone(ym[i]!) });
    } else {
      if (guard) out.push({ op: 'test', path, value: clone(x) });
      out.push({ op: 'replace', path, value: clone(y) });
    }
  };
  walk(a, b, [], 0);
  return out;
}

// ---------------------------------------------------------------- merge patch (RFC 7396)

/** Applies a merge patch: null deletes a member, an object merges, anything else replaces. The target is not changed. */
export function mergePatch(target: Json, patch: Json, depth = 0): Json {
  if (depth > MAX_DEPTH) throw new PatchError('limit', `nested more than ${MAX_DEPTH} deep`);
  if (!isObj(patch)) {
    checkDoc(patch);
    return clone(patch);
  }
  const out: { [k: string]: Json } = isObj(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (FORBIDDEN.has(k)) throw new PatchError('forbidden_key', `the key ${k} is not allowed`);
    if (v === null) delete out[k];
    else Object.defineProperty(out, k, { value: mergePatch(Object.hasOwn(out, k) ? out[k]! : null, v, depth + 1), writable: true, enumerable: true, configurable: true });
  }
  return out;
}

/** The merge patch from a to b. Returns null when b has a null member that would be read as a delete (it cannot be expressed). */
export function createMergePatch(a: Json, b: Json): Json | null {
  const hasNull = (v: Json): boolean => (isObj(v) ? Object.values(v).some((x) => x === null || hasNull(x)) : false);
  if (hasNull(b)) return null;
  const walk = (x: Json, y: Json): Json => {
    if (!isObj(y) || !isObj(x)) return clone(y);
    const p: { [k: string]: Json } = {};
    for (const k of Object.keys(x)) if (!Object.hasOwn(y, k)) p[k] = null;
    for (const k of Object.keys(y)) if (!Object.hasOwn(x, k)) p[k] = clone(y[k]!);
    else if (!jsonEqual(x[k], y[k])) p[k] = walk(x[k]!, y[k]!);
    return p;
  };
  return walk(a, b);
}

// ---------------------------------------------------------------- stale patches and three-way merge

export interface Stale {
  readonly index: number;
  readonly path: string;
  readonly op: string;
  readonly was: Json | undefined;
  readonly now: Json | undefined;
}

/**
 * A patch was made against `base`; the document is now `current`. Lists the operations that read or write a value
 * that is no longer what the patch's author saw: those are the ones that may be overwriting someone else's change.
 */
export function stalePatch(base: Json, current: Json, patch: Patch): Stale[] {
  const out: Stale[] = [];
  patch.forEach((op, i) => {
    const targets = op.op === 'add' ? [] : [op.op === 'move' || op.op === 'copy' ? op.from : op.path];
    if (op.op === 'move') targets.push(op.path);
    for (const p of targets) {
      const was = getPointer(base, p);
      const now = getPointer(current, p);
      if (!(was === undefined && now === undefined) && !(was !== undefined && now !== undefined && jsonEqual(was, now))) out.push({ index: i, path: p, op: op.op, was, now });
    }
  });
  return out;
}

export interface Conflict {
  readonly path: string;
  readonly base: Json | undefined;
  readonly ours: Json | undefined;
  readonly theirs: Json | undefined;
}

export interface Merge3 {
  readonly merged: Json;
  readonly conflicts: Conflict[];
}

export interface Merge3Options {
  /** Which side wins in the merged output where there is a conflict. Default ours. */
  readonly prefer?: 'ours' | 'theirs';
  /** Merge arrays of objects by this member (an id) rather than treating each array as one value. */
  readonly idKey?: string;
}

/** Merges two edits of one base. Where only one side changed a value, that change is kept; where both changed it differently, it is reported. */
export function merge3(base: Json, ours: Json, theirs: Json, o: Merge3Options = {}): Merge3 {
  const conflicts: Conflict[] = [];
  const prefer = o.prefer ?? 'ours';
  const walk = (b: Json | undefined, x: Json | undefined, y: Json | undefined, tokens: string[], depth: number): Json | undefined => {
    if (depth > MAX_DEPTH) throw new PatchError('limit', `nested more than ${MAX_DEPTH} deep`);
    const eq = (p: Json | undefined, q: Json | undefined) => (p === undefined || q === undefined ? p === q : jsonEqual(p, q));
    if (eq(x, y)) return x;
    if (eq(b, x)) return y;
    if (eq(b, y)) return x;
    if (isObj(x) && isObj(y) && (isObj(b) || b === undefined)) {
      const out: { [k: string]: Json } = {};
      const keys = new Set([...Object.keys(b ?? {}), ...Object.keys(x), ...Object.keys(y)]);
      for (const k of keys) {
        const v = walk(b && Object.hasOwn(b, k) ? b[k] : undefined, Object.hasOwn(x, k) ? x[k] : undefined, Object.hasOwn(y, k) ? y[k] : undefined, [...tokens, k], depth + 1);
        if (v !== undefined) Object.defineProperty(out, k, { value: v, writable: true, enumerable: true, configurable: true });
      }
      return out;
    }
    const id = o.idKey;
    const bl: Json[] | null = Array.isArray(b) ? b : b === undefined ? [] : null;
    if (id && Array.isArray(x) && Array.isArray(y) && bl && [...x, ...y, ...bl].every((e) => isObj(e) && typeof e[id] !== 'undefined')) {
      const byId = (l: Json[] | undefined) => new Map((l ?? []).map((e) => [JSON.stringify((e as { [k: string]: Json })[id]), e]));
      const bm = byId(bl);
      const xm = byId(x);
      const ym = byId(y);
      const order = [...new Set([...xm.keys(), ...ym.keys()])];
      const res: Json[] = [];
      for (const k of order) {
        const v = walk(bm.get(k), xm.get(k), ym.get(k), [...tokens, `[${k}]`], depth + 1);
        if (v !== undefined) res.push(v);
      }
      return res;
    }
    conflicts.push({ path: formatPointer(tokens), base: b, ours: x, theirs: y });
    return prefer === 'ours' ? x : y;
  };
  const merged = walk(base, ours, theirs, [], 0);
  return { merged: merged === undefined ? null : merged, conflicts };
}
