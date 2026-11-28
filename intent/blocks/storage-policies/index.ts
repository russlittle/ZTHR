/**
 * Who may do what to which stored file. Files live in buckets, and a bucket has rules for what may be put in it
 * (largest size, allowed types and extensions, with the real type read from the first bytes and compared to the one
 * claimed) and policies for who may list, read, create, update or delete which paths. A policy names a path pattern
 * (`*` is one segment, `**` is the rest, `{id}` and `{tenant}` are filled in from the person asking, so
 * `users/{id}/**` is "your own folder"), the actions it covers, optionally the roles it needs, and whether it allows
 * or denies. Nothing is allowed unless a policy allows it, and any matching deny wins. Public buckets let anyone read
 * (never list) but still check writes. Paths are refused if they could climb out of the bucket. Signed URLs carry
 * the bucket, path, action, expiry and any image transform inside an HMAC, verified in constant time against the
 * current key or a previous one, so a link can be shared for a short time without opening the bucket and cannot be
 * edited to ask for a bigger picture. Image transform parameters (width, height, resize, quality, format) are parsed
 * against caps and turned into one canonical string, so equal requests share a cache entry.
 *
 * Out of scope: doing the image resize itself and the storage of the bytes (see the objects block).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { CREATE, DELETE, READ, UPDATE } from '../grants/index.ts';

export type Action = 'list' | 'read' | 'create' | 'update' | 'delete';

/** The grants block's permission bit for an action, so a policy result can be stored or compared as a grant. */
export const grantBit = (a: Action): number => ({ list: READ, read: READ, create: CREATE, update: UPDATE, delete: DELETE })[a];

export class BadPath extends Error {}
export class Refused extends Error {}
export class BadSignature extends Error {}
export class BadTransform extends Error {}

export interface Bucket {
  readonly name: string;
  /** Anyone may read an object whose path they know; nobody may list it without a policy. */
  readonly public?: boolean;
  readonly maxBytes?: number;
  /** Allowed content types; `image/*` allows a family. Empty or missing allows any. */
  readonly allowedTypes?: readonly string[];
  /** Allowed file extensions, lower case without the dot. */
  readonly allowedExtensions?: readonly string[];
}

export interface Policy {
  readonly id: string;
  readonly bucket: string;
  readonly effect: 'allow' | 'deny';
  readonly actions: readonly Action[];
  readonly path: string;
  /** Roles of which the person needs at least one. */
  readonly roles?: readonly string[];
  /** The person must be signed in (default true). */
  readonly signedIn?: boolean;
}

export interface Principal {
  readonly id?: string;
  readonly tenant?: string;
  readonly roles?: readonly string[];
}

export interface Decision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly policy?: string;
}

/** Reject paths that could leave the bucket or confuse a store. Returns the path without a leading slash. */
export function cleanPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) throw new BadPath('the path is empty');
  if (path.length > 1024) throw new BadPath('the path is longer than 1024 characters');
  if (/[\u0000-\u001f\u007f\\]/.test(path)) throw new BadPath('the path has a control character or a backslash');
  const p = path.replace(/^\/+/, '');
  if (!p) throw new BadPath('the path is empty');
  for (const seg of p.split('/')) {
    if (seg === '' ) throw new BadPath('the path has an empty segment');
    if (seg === '.' || seg === '..') throw new BadPath('the path has a . or .. segment');
    if (/%2e|%2f|%5c|%00/i.test(seg)) throw new BadPath('the path has an encoded dot, slash or NUL');
  }
  return p;
}

function matches(pattern: string, path: string, who: Principal): boolean {
  const pat = pattern.split('/');
  const segs = path.split('/');
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i]!;
    if (p === '**') return i === pat.length - 1 && segs.length > i;
    const s = segs[i];
    if (s === undefined) return false;
    if (p === '*') continue;
    if (p === '{id}') { if (who.id === undefined || s !== who.id) return false; continue; }
    if (p === '{tenant}') { if (who.tenant === undefined || s !== who.tenant) return false; continue; }
    if (p.includes('*') || p.includes('{')) throw new Refused(`pattern segment ${p} must be a whole segment: *, **, {id}, {tenant} or plain text`);
    if (p !== s) return false;
  }
  return pat.length === segs.length;
}

/** Magic numbers for the types worth checking; others cannot be confirmed from their bytes. */
export function sniff(head: Uint8Array): string | undefined {
  const b = Buffer.from(head.subarray(0, 16));
  const starts = (...bytes: number[]) => bytes.every((x, i) => b[i] === x);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (starts(0x50, 0x4b, 0x03, 0x04)) return 'application/zip';
  if (/^\s*<(!doctype html|html|script|svg)/i.test(b.toString('latin1'))) return 'text/html';
  return undefined;
}

const typeAllowed = (allowed: readonly string[], type: string) => allowed.some((a) => (a.endsWith('/*') ? type.startsWith(a.slice(0, -1)) : a === type));

export class Storage {
  readonly #buckets = new Map<string, Bucket>();
  readonly #policies: Policy[] = [];

  addBucket(b: Bucket): void {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(b.name)) throw new Refused(`bucket name ${b.name} must be 2 to 63 lower-case letters, digits or hyphens`);
    if (this.#buckets.has(b.name)) throw new Refused(`bucket ${b.name} already exists`);
    this.#buckets.set(b.name, b);
  }

  addPolicy(p: Policy): void {
    if (!this.#buckets.has(p.bucket)) throw new Refused(`no bucket ${p.bucket}`);
    if (this.#policies.some((x) => x.id === p.id)) throw new Refused(`policy ${p.id} already exists`);
    if (p.actions.length === 0) throw new Refused(`policy ${p.id} covers no actions`);
    for (const seg of p.path.split('/')) if (!['*', '**', '{id}', '{tenant}'].includes(seg) && /[*{}]/.test(seg)) throw new Refused(`pattern segment ${seg} must be a whole segment: *, **, {id}, {tenant} or plain text`);
    this.#policies.push(p);
  }

  bucket(name: string): Bucket {
    const b = this.#buckets.get(name);
    if (!b) throw new Refused(`no bucket ${name}`);
    return b;
  }

  /** Decide one action. The reason names the policy that decided it, or says nothing allowed it. */
  decide(who: Principal, action: Action, bucket: string, rawPath: string): Decision {
    const b = this.#buckets.get(bucket);
    if (!b) return { allowed: false, reason: `no bucket ${bucket}` };
    let path: string;
    try { path = action === 'list' ? (rawPath.replace(/\/+$/, '') === '' ? '' : cleanPath(rawPath.replace(/\/+$/, ''))) : cleanPath(rawPath); } catch (e) { return { allowed: false, reason: (e as Error).message }; }
    const signedIn = who.id !== undefined;
    const applicable = this.#policies.filter((p) => {
      if (p.bucket !== bucket || !p.actions.includes(action)) return false;
      if ((p.signedIn ?? true) && !signedIn) return false;
      if (p.roles && !p.roles.some((r) => who.roles?.includes(r))) return false;
      return action === 'list' ? coversFolder(p.path, path, who) : matches(p.path, path, who);
    });
    const deny = applicable.find((p) => p.effect === 'deny');
    if (deny) return { allowed: false, reason: `denied by policy ${deny.id}`, policy: deny.id };
    const allow = applicable.find((p) => p.effect === 'allow');
    if (allow) return { allowed: true, reason: `allowed by policy ${allow.id}`, policy: allow.id };
    if (b.public && action === 'read') return { allowed: true, reason: `bucket ${bucket} is public for reading` };
    return { allowed: false, reason: signedIn ? 'no policy allows this' : 'sign in first; no policy allows anonymous access to this' };
  }

  /** Throws Refused with the reason unless the action is allowed. */
  require(who: Principal, action: Action, bucket: string, path: string): Decision {
    const d = this.decide(who, action, bucket, path);
    if (!d.allowed) throw new Refused(d.reason);
    return d;
  }

  /**
   * Check a file about to be stored: path, size, extension and type. `head` is the first bytes; when the bucket
   * restricts types and the bytes show a different type than the one claimed, the upload is refused.
   */
  checkUpload(bucket: string, file: { path: string; size: number; contentType: string; head?: Uint8Array }): { path: string; contentType: string } {
    const b = this.bucket(bucket);
    const path = cleanPath(file.path);
    if (!Number.isFinite(file.size) || file.size < 0) throw new Refused('the size is not a number');
    if (b.maxBytes !== undefined && file.size > b.maxBytes) throw new Refused(`${file.size} bytes is over this bucket's limit of ${b.maxBytes}`);
    const claimed = file.contentType.split(';')[0]!.trim().toLowerCase();
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(claimed)) throw new Refused(`${file.contentType} is not a content type`);
    const ext = /\.([A-Za-z0-9]+)$/.exec(path.split('/').at(-1)!)?.[1]?.toLowerCase();
    if (b.allowedExtensions?.length && (!ext || !b.allowedExtensions.includes(ext))) throw new Refused(`files ending .${ext ?? '(none)'} are not allowed in ${bucket}`);
    if (b.allowedTypes?.length) {
      if (!typeAllowed(b.allowedTypes, claimed)) throw new Refused(`${claimed} is not an allowed type in ${bucket}`);
      const real = file.head ? sniff(file.head) : undefined;
      if (file.head && real === 'text/html' && !typeAllowed(b.allowedTypes, 'text/html')) throw new Refused('the bytes look like a web page, not the type claimed');
      if (real && real !== claimed && !(claimed === 'image/jpg' && real === 'image/jpeg')) throw new Refused(`the bytes are ${real}, not the claimed ${claimed}`);
      if (real && !typeAllowed(b.allowedTypes, real)) throw new Refused(`${real} is not an allowed type in ${bucket}`);
    }
    return { path, contentType: claimed };
  }
}

/** A folder may be listed only when the policy covers everything directly or deeply inside it. */
function coversFolder(pattern: string, folder: string, who: Principal): boolean {
  const pat = pattern.split('/');
  const segs = folder === '' ? [] : folder.split('/');
  for (let i = 0; i < segs.length; i++) {
    const p = pat[i];
    if (p === undefined) return false;
    if (p === '**') return true;
    if (!matches(p, segs[i]!, who)) return false;
  }
  const rest = pat.slice(segs.length);
  return rest.length === 1 && (rest[0] === '**' || rest[0] === '*');
}

// --- signed URLs -----------------------------------------------------------------------------------------------

export interface SignInput {
  readonly bucket: string;
  readonly path: string;
  readonly action: 'read' | 'create';
  readonly ttlSeconds: number;
  readonly transform?: Transform;
  readonly by?: string;
}

export interface SignedClaims {
  readonly b: string;
  readonly p: string;
  readonly a: 'read' | 'create';
  readonly exp: number;
  readonly t?: string;
  readonly by?: string;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export class Signer {
  readonly #keys: readonly string[];
  readonly #now: () => number;
  readonly #maxTtl: number;

  /** The first key signs; all keys verify, so a key can be rotated without breaking links still in the wild. */
  constructor(keys: readonly string[], o: { now?: () => number; maxTtlSeconds?: number } = {}) {
    if (keys.length === 0 || keys.some((k) => k.length < 16)) throw new Refused('signing keys must be at least 16 characters');
    this.#keys = keys;
    this.#now = o.now ?? Date.now;
    this.#maxTtl = o.maxTtlSeconds ?? 7 * 86_400;
  }

  #mac(key: string, body: string) {
    return createHmac('sha256', key).update(body).digest();
  }

  /** A token for a path. The transform, if any, is part of what is signed. */
  sign(i: SignInput): string {
    if (!(i.ttlSeconds > 0) || i.ttlSeconds > this.#maxTtl) throw new Refused(`a signed link may last 1 to ${this.#maxTtl} seconds`);
    const claims: SignedClaims = { b: i.bucket, p: cleanPath(i.path), a: i.action, exp: Math.floor(this.#now() / 1000) + Math.floor(i.ttlSeconds), ...(i.transform ? { t: canonicalTransform(i.transform) } : {}), ...(i.by ? { by: i.by } : {}) };
    const body = b64(JSON.stringify(claims));
    return `${body}.${b64(this.#mac(this.#keys[0]!, body))}`;
  }

  /** The URL path and query for a token, with the transform spelled out so a cache can see it. */
  url(i: SignInput): string {
    const token = this.sign(i);
    const enc = cleanPath(i.path).split('/').map(encodeURIComponent).join('/');
    return `/object/sign/${i.bucket}/${enc}?token=${token}${i.transform ? `&${canonicalTransform(i.transform)}` : ''}`;
  }

  /** Check a token for exactly this bucket, path and action (and transform). Returns its claims. */
  verify(token: string, want: { bucket: string; path: string; action: 'read' | 'create'; transform?: Transform }): SignedClaims {
    const parts = token.split('.');
    if (parts.length !== 2) throw new BadSignature('the link is malformed');
    const [body, sig] = parts as [string, string];
    const given = Buffer.from(sig, 'base64url');
    const ok = this.#keys.map((k) => { const m = this.#mac(k, body); return given.length === m.length && timingSafeEqual(m, given); }).some(Boolean);
    if (!ok) throw new BadSignature('the signature does not match');
    let c: SignedClaims;
    try { c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedClaims; } catch { throw new BadSignature('the link is malformed'); }
    if (c.exp * 1000 <= this.#now()) throw new BadSignature('the link has expired');
    if (c.b !== want.bucket || c.p !== cleanPath(want.path)) throw new BadSignature('the link is for a different file');
    if (c.a !== want.action) throw new BadSignature(`the link allows ${c.a}, not ${want.action}`);
    const wantT = want.transform ? canonicalTransform(want.transform) : undefined;
    if (c.t !== wantT) throw new BadSignature('the link was signed for different image settings');
    return c;
  }
}

// --- image transforms ------------------------------------------------------------------------------------------

export interface Transform {
  readonly width?: number;
  readonly height?: number;
  readonly resize?: 'cover' | 'contain' | 'fill';
  readonly quality?: number;
  readonly format?: 'origin' | 'webp' | 'avif' | 'jpeg' | 'png';
}

export interface TransformLimits {
  readonly maxDimension?: number;
  readonly maxPixels?: number;
  readonly minQuality?: number;
}

const FORMATS = ['origin', 'webp', 'avif', 'jpeg', 'png'];
const RESIZE = ['cover', 'contain', 'fill'];

/** Parse transform parameters from a query string, refusing unknown names and out-of-range values. */
export function parseTransform(q: URLSearchParams | Record<string, string>, limits: TransformLimits = {}): Transform {
  const get = (k: string) => (q instanceof URLSearchParams ? q.get(k) : Object.hasOwn(q, k) ? q[k]! : null);
  const names = q instanceof URLSearchParams ? [...q.keys()] : Object.keys(q);
  const known = new Set(['width', 'height', 'resize', 'quality', 'format', 'token']);
  for (const n of names) if (!known.has(n)) throw new BadTransform(`unknown image setting ${n}`);
  const maxD = limits.maxDimension ?? 4096;
  const num = (k: string, lo: number, hi: number): number | undefined => {
    const v = get(k);
    if (v === null) return undefined;
    if (!/^\d{1,5}$/.test(v)) throw new BadTransform(`${k} must be a whole number`);
    const n = Number(v);
    if (n < lo || n > hi) throw new BadTransform(`${k} must be between ${lo} and ${hi}`);
    return n;
  };
  const width = num('width', 1, maxD);
  const height = num('height', 1, maxD);
  const quality = num('quality', limits.minQuality ?? 20, 100);
  if (width !== undefined && height !== undefined && width * height > (limits.maxPixels ?? 16_000_000)) throw new BadTransform(`${width}x${height} is more pixels than allowed`);
  const resize = get('resize');
  if (resize !== null && !RESIZE.includes(resize)) throw new BadTransform(`resize must be one of ${RESIZE.join(', ')}`);
  const format = get('format');
  if (format !== null && !FORMATS.includes(format)) throw new BadTransform(`format must be one of ${FORMATS.join(', ')}`);
  return { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}), ...(resize ? { resize: resize as Transform['resize'] & string } : {}), ...(quality !== undefined ? { quality } : {}), ...(format ? { format: format as Transform['format'] & string } : {}) };
}

/** One spelling for equal transforms: fixed order, defaults dropped. */
export function canonicalTransform(t: Transform): string {
  const parts: string[] = [];
  if (t.format && t.format !== 'origin') parts.push(`format=${t.format}`);
  if (t.height !== undefined) parts.push(`height=${t.height}`);
  if (t.quality !== undefined && t.quality !== 80) parts.push(`quality=${t.quality}`);
  if (t.resize && !(t.resize === 'cover')) parts.push(`resize=${t.resize}`);
  if (t.width !== undefined) parts.push(`width=${t.width}`);
  return parts.join('&');
}

/** The size an image of a given size will have after the transform. Never enlarges beyond what was asked. */
export function outputSize(source: { width: number; height: number }, t: Transform): { width: number; height: number } {
  const w = t.width, h = t.height;
  if (w === undefined && h === undefined) return { ...source };
  if (w !== undefined && h === undefined) return { width: w, height: Math.max(1, Math.round((source.height * w) / source.width)) };
  if (h !== undefined && w === undefined) return { width: Math.max(1, Math.round((source.width * h) / source.height)), height: h };
  const mode = t.resize ?? 'cover';
  if (mode === 'cover' || mode === 'fill') return { width: w!, height: h! };
  const scale = Math.min(w! / source.width, h! / source.height);
  return { width: Math.max(1, Math.round(source.width * scale)), height: Math.max(1, Math.round(source.height * scale)) };
}
