/**
 * HTTP message signatures, in both dialects that federation uses today: RFC 9421 (`Signature-Input` and `Signature`
 * with structured fields) and the draft-cavage-http-signatures header (`Signature: keyId="...",headers="..."`) that
 * Mastodon and most of the fediverse still send. Also the `Digest` and `Content-Digest` headers that bind a body to
 * its signature, key id resolution with a cache, and the clock skew and replay limits a receiver needs.
 *
 * The rules a receiver must hold to, and this block enforces:
 *  - the key decides the algorithm, never the message: a signature that names a different algorithm than the key's is
 *    refused, so a signer cannot downgrade a key to a weaker scheme;
 *  - what is signed must cover what matters: the method and target, the host, a time (created or Date), and the body
 *    digest when there is a body (the caller can ask for more, never less than these unless it turns them off);
 *  - a digest that is present is checked against the body, not trusted;
 *  - a signature made too long ago, or too far in the future, or past its expiry, is refused (default skew 5 minutes);
 *  - a key id is only fetched from a public https address: no credentials, no localhost, no private ranges.
 *
 * No key lives in this file: keys come in as Node `KeyObject`s (or an HMAC secret) from the caller.
 */
import { createHash, createHmac, createPublicKey, constants, sign as nodeSign, verify as nodeVerify, type KeyObject } from 'node:crypto';
import { equal } from '../crypto/index.ts';

export type ErrorCode = 'missing' | 'malformed' | 'unknown-key' | 'bad-signature' | 'expired' | 'skew' | 'digest' | 'policy' | 'alg' | 'replay' | 'key-url' | 'key';

export class SignatureError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type Headers = Record<string, string | readonly string[] | undefined>;

export interface Req {
  readonly method: string;
  /** Absolute, or a path when a Host header is present. */
  readonly url: string;
  readonly headers: Headers;
  readonly body?: string | Uint8Array;
}

export type Alg = 'ed25519' | 'rsa-v1_5-sha256' | 'rsa-pss-sha512' | 'ecdsa-p256-sha256' | 'ecdsa-p384-sha384' | 'hmac-sha256';
export const ALGS: readonly Alg[] = ['ed25519', 'rsa-v1_5-sha256', 'rsa-pss-sha512', 'ecdsa-p256-sha256', 'ecdsa-p384-sha384', 'hmac-sha256'];

/** A key a signature may be checked with, and the one algorithm it may be used for. */
export interface VerificationKey {
  readonly key: KeyObject | Uint8Array;
  readonly alg: Alg;
  /** Whoever owns it, for the caller's use (an actor URL). */
  readonly owner?: string;
}

// ------------------------------------------------------------ headers and bodies

export const lower = (h: Headers): Map<string, string> => {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    const name = k.toLowerCase();
    const val = (typeof v === 'string' ? [v] : [...v]).map((x) => x.trim().replace(/\s*\r?\n\s*/g, ' ')).join(', ');
    m.set(name, m.has(name) ? `${m.get(name)}, ${val}` : val);
  }
  return m;
};

const bytes = (b: string | Uint8Array | undefined): Uint8Array => (b === undefined ? new Uint8Array(0) : typeof b === 'string' ? new TextEncoder().encode(b) : b);
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const unb64 = (s: string): Buffer => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new SignatureError('malformed', 'a base64 value has characters that do not belong');
  return Buffer.from(s, 'base64');
};

export type DigestAlg = 'sha-256' | 'sha-512';
const NODE_DIGEST: Record<DigestAlg, string> = { 'sha-256': 'sha256', 'sha-512': 'sha512' };

const digestOf = (body: string | Uint8Array | undefined, alg: DigestAlg): string => b64(createHash(NODE_DIGEST[alg]).update(bytes(body)).digest());

/** `Digest: SHA-256=base64`, the form draft-cavage senders use. */
export function digestHeader(body: string | Uint8Array | undefined, alg: DigestAlg = 'sha-256'): string {
  return `${alg.toUpperCase()}=${digestOf(body, alg)}`;
}

/** `Content-Digest: sha-256=:base64:`, RFC 9530. */
export function contentDigest(body: string | Uint8Array | undefined, alg: DigestAlg = 'sha-256'): string {
  return `${alg}=:${digestOf(body, alg)}:`;
}

/**
 * Checks the body against whichever digest headers are present. Returns the algorithms that matched. A digest that
 * is present and wrong, or names only algorithms this does not know, is an error; no digest at all returns [].
 */
export function checkDigests(headers: Headers, body: string | Uint8Array | undefined): DigestAlg[] {
  const h = lower(headers);
  const ok: DigestAlg[] = [];
  let seen = 0;
  const legacy = h.get('digest');
  if (legacy !== undefined) {
    for (const part of splitTop(legacy, ',')) {
      const eq = part.indexOf('=');
      if (eq < 1) throw new SignatureError('malformed', 'a Digest value is "ALGORITHM=base64"');
      const alg = part.slice(0, eq).trim().toLowerCase() as DigestAlg;
      if (!(alg in NODE_DIGEST)) continue;
      seen++;
      if (!equal(digestOf(body, alg), part.slice(eq + 1).trim())) throw new SignatureError('digest', `the ${alg} digest does not match the body`);
      ok.push(alg);
    }
  }
  const modern = h.get('content-digest');
  if (modern !== undefined) {
    for (const part of splitTop(modern, ',')) {
      const m = /^\s*([a-z0-9-]+)=:([A-Za-z0-9+/]*={0,2}):\s*$/.exec(part);
      if (!m) throw new SignatureError('malformed', 'a Content-Digest value is "algorithm=:base64:"');
      const alg = m[1] as DigestAlg;
      if (!(alg in NODE_DIGEST)) continue;
      seen++;
      if (!equal(digestOf(body, alg), m[2] as string)) throw new SignatureError('digest', `the ${alg} content digest does not match the body`);
      ok.push(alg);
    }
  }
  if ((legacy !== undefined || modern !== undefined) && seen === 0) throw new SignatureError('digest', 'the digest uses only algorithms that are not supported');
  return ok;
}

/** Splits on a separator outside quotes, parentheses and :byte sequences:. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = false;
  let paren = 0;
  let bs = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (quote) {
      cur += c;
      if (c === '\\') cur += s[++i] ?? '';
      else if (c === '"') quote = false;
      continue;
    }
    if (c === '"') quote = true;
    else if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === ':' && paren === 0) bs = !bs;
    if (c === sep && paren === 0 && !quote && !bs) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (quote || paren !== 0) throw new SignatureError('malformed', 'an unclosed quote or parenthesis');
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== '');
}

// ------------------------------------------------------------ keys and algorithms

function checkKey(alg: Alg, key: KeyObject | Uint8Array): void {
  if (alg === 'hmac-sha256') {
    if (key instanceof Uint8Array ? key.length < 16 : key.type !== 'secret') throw new SignatureError('key', 'an HMAC key must be a secret of at least 16 bytes');
    return;
  }
  if (key instanceof Uint8Array) throw new SignatureError('key', `${alg} needs an asymmetric key`);
  const t = key.asymmetricKeyType;
  const d = key.asymmetricKeyDetails;
  const bad = (m: string) => new SignatureError('key', m);
  if (alg === 'ed25519' && t !== 'ed25519') throw bad('the key is not an Ed25519 key');
  if (alg.startsWith('rsa')) {
    if (t !== 'rsa' && t !== 'rsa-pss') throw bad('the key is not an RSA key');
    if ((d?.modulusLength ?? 0) < 2048) throw bad('an RSA key must be at least 2048 bits');
  }
  if (alg === 'ecdsa-p256-sha256' && !(t === 'ec' && d?.namedCurve === 'prime256v1')) throw bad('the key is not a P-256 key');
  if (alg === 'ecdsa-p384-sha384' && !(t === 'ec' && d?.namedCurve === 'secp384r1')) throw bad('the key is not a P-384 key');
}

function signBytes(alg: Alg, key: KeyObject | Uint8Array, data: Buffer): Buffer {
  checkKey(alg, key);
  const k = key;
  if (!(key instanceof Uint8Array) && key.type === 'public') throw new SignatureError('key', 'signing needs a private key');
  if (alg === 'hmac-sha256') return createHmac('sha256', k as Uint8Array | KeyObject).update(data).digest();
  if (alg === 'ed25519') return nodeSign(null, data, k as KeyObject);
  if (alg === 'rsa-v1_5-sha256') return nodeSign('sha256', data, k as KeyObject);
  if (alg === 'rsa-pss-sha512') return nodeSign('sha512', data, { key: k as KeyObject, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 64 });
  return nodeSign(alg === 'ecdsa-p256-sha256' ? 'sha256' : 'sha384', data, { key: k as KeyObject, dsaEncoding: 'ieee-p1363' });
}

function verifyBytes(alg: Alg, key: KeyObject | Uint8Array, data: Buffer, sig: Buffer): boolean {
  checkKey(alg, key);
  if (alg === 'hmac-sha256') {
    const mac = createHmac('sha256', key as Uint8Array | KeyObject).update(data).digest();
    return mac.length === sig.length && equal(mac.toString('base64'), sig.toString('base64'));
  }
  const pub = key as KeyObject;
  const k = pub.type === 'private' ? createPublicKey(pub) : pub;
  try {
    if (alg === 'ed25519') return nodeVerify(null, data, k, sig);
    if (alg === 'rsa-v1_5-sha256') return nodeVerify('sha256', data, k, sig);
    if (alg === 'rsa-pss-sha512') return nodeVerify('sha512', data, { key: k, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 64 }, sig);
    return nodeVerify(alg === 'ecdsa-p256-sha256' ? 'sha256' : 'sha384', data, { key: k, dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return false; // a signature of the wrong shape is a wrong signature
  }
}

// ------------------------------------------------------------ request parts

interface Target {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string | undefined;
  readonly uri: string;
}

function target(req: Req, h: Map<string, string>): Target {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(req.url);
  if (!absolute && !h.get('host')) throw new SignatureError('missing', 'a relative request target needs a Host header');
  let u: URL;
  try {
    u = absolute ? new URL(req.url) : new URL(req.url, `https://${h.get('host') ?? ''}`);
  } catch {
    throw new SignatureError('malformed', `${req.url} is not a usable request target`);
  }
  const q = u.search === '' ? (req.url.includes('?') ? '' : undefined) : u.search.slice(1);
  return { scheme: u.protocol.slice(0, -1), authority: u.host, path: u.pathname === '' ? '/' : u.pathname, query: q, uri: /^[a-z][a-z0-9+.-]*:\/\//i.test(req.url) ? req.url : u.href };
}

const requestTarget = (m: string, t: Target) => `${m.toLowerCase()} ${t.path}${t.query === undefined ? '' : `?${t.query}`}`;

// ------------------------------------------------------------ draft-cavage

export interface CavageParams {
  readonly keyId: string;
  readonly algorithm?: string;
  readonly headers: readonly string[];
  readonly signature: string;
  readonly created?: number;
  readonly expires?: number;
}

/** Parses `keyId="...",algorithm="...",headers="...",signature="..."`; a repeated or unquoted parameter is refused. */
export function parseCavage(value: string): CavageParams {
  const out = new Map<string, string>();
  for (const part of splitTop(value, ',')) {
    const m = /^([A-Za-z]+)=(?:"((?:[^"\\]|\\.)*)"|([0-9]+))$/.exec(part);
    if (!m) throw new SignatureError('malformed', 'the Signature header is not a list of key="value" pairs');
    const k = (m[1] as string).toLowerCase();
    if (out.has(k)) throw new SignatureError('malformed', `the Signature header repeats ${k}`);
    out.set(k, (m[2] ?? m[3]) as string);
  }
  const keyId = out.get('keyid');
  const signature = out.get('signature');
  if (!keyId) throw new SignatureError('malformed', 'the Signature header has no keyId');
  if (!signature) throw new SignatureError('malformed', 'the Signature header has no signature');
  const num = (k: string) => {
    const v = out.get(k);
    if (v === undefined) return undefined;
    if (!/^[0-9]{1,15}$/.test(v)) throw new SignatureError('malformed', `${k} is not a whole number of seconds`);
    return Number(v);
  };
  const headers = (out.get('headers') ?? 'date').toLowerCase().split(/\s+/).filter(Boolean);
  if (headers.length === 0) throw new SignatureError('malformed', 'the headers list is empty');
  if (new Set(headers).size !== headers.length) throw new SignatureError('malformed', 'the headers list names a header twice');
  const created = num('created');
  const expires = num('expires');
  const algorithm = out.get('algorithm');
  return { keyId, signature, headers, ...(algorithm ? { algorithm } : {}), ...(created !== undefined ? { created } : {}), ...(expires !== undefined ? { expires } : {}) };
}

function cavageString(req: Req, h: Map<string, string>, p: { headers: readonly string[]; created?: number; expires?: number }): string {
  const t = target(req, h);
  return p.headers
    .map((name) => {
      if (name === '(request-target)') return `(request-target): ${requestTarget(req.method, t)}`;
      if (name === '(created)') {
        if (p.created === undefined) throw new SignatureError('malformed', '(created) is signed but the signature has no created time');
        return `(created): ${p.created}`;
      }
      if (name === '(expires)') {
        if (p.expires === undefined) throw new SignatureError('malformed', '(expires) is signed but the signature has no expiry');
        return `(expires): ${p.expires}`;
      }
      const v = h.get(name);
      if (v === undefined) throw new SignatureError('missing', `the signed header ${name} is not in the request`);
      return `${name}: ${v}`;
    })
    .join('\n');
}

const CAVAGE_ALG: Record<string, Alg | 'hs2019'> = { 'rsa-sha256': 'rsa-v1_5-sha256', 'hmac-sha256': 'hmac-sha256', 'ecdsa-sha256': 'ecdsa-p256-sha256', ed25519: 'ed25519', hs2019: 'hs2019' };

export interface CavageSignOptions {
  readonly keyId: string;
  readonly key: KeyObject | Uint8Array;
  readonly alg: Alg;
  /** What to sign. The default is the target, host, date, and the digest when the request has a body. */
  readonly headers?: readonly string[];
  /** Seconds since the epoch; when given, `(created)` is not signed unless listed, but is sent. */
  readonly created?: number;
  readonly expires?: number;
  /** "hs2019" (default) says the key decides; the legacy names are for old receivers. */
  readonly algorithmName?: 'hs2019' | 'rsa-sha256' | 'hmac-sha256';
}

/**
 * The value of the `Signature` header. The request must already carry every header that is signed, including Date and
 * Digest: use `signRequest` to have them added.
 */
export function signCavage(req: Req, o: CavageSignOptions): string {
  const h = lower(req.headers);
  const headers = o.headers ?? defaultCavageHeaders(req);
  const name = o.algorithmName ?? 'hs2019';
  if (name !== 'hs2019' && CAVAGE_ALG[name] !== o.alg) throw new SignatureError('alg', `the name ${name} does not match the key algorithm ${o.alg}`);
  const base = cavageString(req, h, { headers, ...(o.created !== undefined ? { created: o.created } : {}), ...(o.expires !== undefined ? { expires: o.expires } : {}) });
  const sig = b64(signBytes(o.alg, o.key, Buffer.from(base)));
  const q = (v: string) => `"${v.replace(/[\\"]/g, '\\$&')}"`;
  return [`keyId=${q(o.keyId)}`, `algorithm=${q(name)}`, ...(o.created !== undefined ? [`created=${o.created}`] : []), ...(o.expires !== undefined ? [`expires=${o.expires}`] : []), `headers=${q(headers.join(' '))}`, `signature=${q(sig)}`].join(',');
}

function defaultCavageHeaders(req: Req): string[] {
  const h = lower(req.headers);
  return ['(request-target)', 'host', 'date', ...(bytes(req.body).length > 0 || h.has('digest') ? ['digest'] : [])];
}

// ------------------------------------------------------------ RFC 9421

export interface ComponentId {
  readonly name: string;
  readonly params: readonly (readonly [string, string | number | boolean])[];
}

export interface SigParams {
  readonly label: string;
  readonly components: readonly ComponentId[];
  readonly created?: number;
  readonly expires?: number;
  readonly nonce?: string;
  readonly alg?: string;
  readonly keyid?: string;
  readonly tag?: string;
  /** The inner list as serialised, which is what the signature base ends with. */
  readonly serialised: string;
}

const quoteSf = (s: string) => `"${s.replace(/[\\"]/g, '\\$&')}"`;
const sfParam = ([k, v]: readonly [string, string | number | boolean]) => (v === true ? `;${k}` : typeof v === 'number' ? `;${k}=${v}` : `;${k}=${quoteSf(String(v))}`);
const serialiseId = (c: ComponentId) => `${quoteSf(c.name)}${c.params.map(sfParam).join('')}`;

function parseParams(s: string, at: { i: number }): [string, string | number | boolean][] {
  const out: [string, string | number | boolean][] = [];
  while (s[at.i] === ';') {
    at.i++;
    const m = /^([a-z*][a-z0-9_.*-]*)/.exec(s.slice(at.i));
    if (!m) throw new SignatureError('malformed', 'a parameter name is not valid');
    at.i += (m[1] as string).length;
    const k = m[1] as string;
    if (out.some((p) => p[0] === k)) throw new SignatureError('malformed', `the parameter ${k} is repeated`);
    if (s[at.i] !== '=') {
      out.push([k, true]);
      continue;
    }
    at.i++;
    if (s[at.i] === '"') {
      let v = '';
      at.i++;
      for (;;) {
        const c = s[at.i++];
        if (c === undefined) throw new SignatureError('malformed', 'an unclosed quote');
        if (c === '\\') {
          const e = s[at.i++];
          if (e !== '"' && e !== '\\') throw new SignatureError('malformed', 'a bad escape in a string');
          v += e;
        } else if (c === '"') break;
        else v += c;
      }
      out.push([k, v]);
    } else {
      const n = /^-?[0-9]{1,15}/.exec(s.slice(at.i));
      if (n) {
        out.push([k, Number(n[0])]);
        at.i += n[0].length;
      } else {
        const t = /^[A-Za-z][A-Za-z0-9:/_.*%+-]*/.exec(s.slice(at.i));
        if (!t) throw new SignatureError('malformed', 'a parameter value is not valid');
        out.push([k, t[0]]);
        at.i += t[0].length;
      }
    }
  }
  return out;
}

/** Parses a `Signature-Input` dictionary into its labelled signatures. */
export function parseSignatureInput(value: string): SigParams[] {
  const out: SigParams[] = [];
  for (const member of splitTop(value, ',')) {
    const m = /^([a-z*][a-z0-9_.*-]*)=\(/.exec(member);
    if (!m) throw new SignatureError('malformed', 'Signature-Input members look like label=("component" ...);params');
    const label = m[1] as string;
    if (out.some((x) => x.label === label)) throw new SignatureError('malformed', `the label ${label} is repeated`);
    const s = member.slice(label.length + 1);
    const at = { i: 1 };
    const components: ComponentId[] = [];
    for (;;) {
      while (s[at.i] === ' ') at.i++;
      if (s[at.i] === ')') {
        at.i++;
        break;
      }
      if (s[at.i] !== '"') throw new SignatureError('malformed', 'a component must be a quoted name');
      at.i++;
      let name = '';
      for (;;) {
        const c = s[at.i++];
        if (c === undefined) throw new SignatureError('malformed', 'an unclosed quote');
        if (c === '\\') name += s[at.i++] ?? '';
        else if (c === '"') break;
        else name += c;
      }
      if (name !== name.toLowerCase()) throw new SignatureError('malformed', `component names are lower case: ${name}`);
      components.push({ name, params: parseParams(s, at) });
    }
    const params = parseParams(s, at);
    if (at.i !== s.length) throw new SignatureError('malformed', 'unexpected text after the signature parameters');
    const get = (k: string) => params.find((p) => p[0] === k)?.[1];
    const str = (k: string) => {
      const v = get(k);
      if (v !== undefined && typeof v !== 'string') throw new SignatureError('malformed', `${k} must be a string`);
      return v;
    };
    const int = (k: string) => {
      const v = get(k);
      if (v !== undefined && typeof v !== 'number') throw new SignatureError('malformed', `${k} must be a whole number`);
      return v;
    };
    const created = int('created');
    const expires = int('expires');
    const nonce = str('nonce');
    const alg = str('alg');
    const keyid = str('keyid');
    const tag = str('tag');
    const names = components.map(serialiseId);
    if (new Set(names).size !== names.length) throw new SignatureError('malformed', 'a component is listed twice');
    out.push({
      label,
      components,
      ...(created !== undefined ? { created } : {}),
      ...(expires !== undefined ? { expires } : {}),
      ...(nonce !== undefined ? { nonce } : {}),
      ...(alg !== undefined ? { alg } : {}),
      ...(keyid !== undefined ? { keyid } : {}),
      ...(tag !== undefined ? { tag } : {}),
      serialised: `(${names.join(' ')})${params.map(sfParam).join('')}`,
    });
  }
  if (out.length === 0) throw new SignatureError('malformed', 'Signature-Input is empty');
  return out;
}

function parseSignatureDict(value: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const member of splitTop(value, ',')) {
    const m = /^([a-z*][a-z0-9_.*-]*)=:([A-Za-z0-9+/]*={0,2}):$/.exec(member);
    if (!m) throw new SignatureError('malformed', 'Signature members look like label=:base64:');
    if (out.has(m[1] as string)) throw new SignatureError('malformed', `the label ${m[1]} is repeated`);
    out.set(m[1] as string, unb64(m[2] as string));
  }
  return out;
}

const encodeQuery = (s: string) => encodeURIComponent(s.replace(/\+/g, ' ')).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function componentValue(c: ComponentId, req: Req, h: Map<string, string>): string {
  const name = c.name;
  if (name.startsWith('@')) {
    const t = target(req, h);
    switch (name) {
      case '@method':
        return req.method.toUpperCase();
      case '@target-uri':
        return t.uri;
      case '@authority':
        return t.authority.toLowerCase();
      case '@scheme':
        return t.scheme.toLowerCase();
      case '@request-target':
        return `${t.path}${t.query === undefined ? '' : `?${t.query}`}`;
      case '@path':
        return t.path;
      case '@query':
        return `?${t.query ?? ''}`;
      case '@query-param': {
        const want = c.params.find((p) => p[0] === 'name')?.[1];
        if (typeof want !== 'string') throw new SignatureError('malformed', '@query-param needs a name parameter');
        const hits = (t.query ?? '').split('&').filter((kv) => kv !== '').map((kv) => {
          const eq = kv.indexOf('=');
          return [eq < 0 ? kv : kv.slice(0, eq), eq < 0 ? '' : kv.slice(eq + 1)] as const;
        });
        const found = hits.filter(([k]) => encodeQuery(decodeURIComponent(k)) === encodeQuery(want));
        if (found.length !== 1) throw new SignatureError('missing', `the query parameter ${want} must appear exactly once`);
        return encodeQuery(decodeURIComponent((found[0] as readonly [string, string])[1]));
      }
      default:
        throw new SignatureError('malformed', `${name} is not a component this supports`);
    }
  }
  for (const [k] of c.params) if (k !== 'sf' && k !== 'bs' && k !== 'key') throw new SignatureError('malformed', `the component parameter ;${k} is not supported`);
  if (c.params.length > 0) throw new SignatureError('malformed', 'component parameters on header fields are not supported');
  const v = h.get(name);
  if (v === undefined) throw new SignatureError('missing', `the signed header ${name} is not in the request`);
  return v;
}

export function signatureBase(req: Req, p: SigParams | { components: readonly ComponentId[]; serialised: string }): string {
  const h = lower(req.headers);
  const lines = p.components.map((c) => `${serialiseId(c)}: ${componentValue(c, req, h)}`);
  lines.push(`"@signature-params": ${p.serialised}`);
  return lines.join('\n');
}

const idOf = (c: string | ComponentId): ComponentId => (typeof c === 'string' ? { name: c, params: [] } : c);

export interface Rfc9421SignOptions {
  readonly keyId: string;
  readonly key: KeyObject | Uint8Array;
  readonly alg: Alg;
  readonly label?: string;
  readonly components?: readonly (string | ComponentId)[];
  readonly created?: number;
  readonly expires?: number;
  readonly nonce?: string;
  readonly tag?: string;
}

export function signRfc9421(req: Req, o: Rfc9421SignOptions): { signatureInput: string; signature: string } {
  const label = o.label ?? 'sig1';
  if (!/^[a-z*][a-z0-9_.*-]*$/.test(label)) throw new SignatureError('malformed', 'a label is lower case letters, digits and _ . * -');
  const h = lower(req.headers);
  const comps = (o.components ?? ['@method', '@authority', '@path', ...(h.has('content-digest') ? ['content-digest'] : [])]).map(idOf);
  const params: [string, string | number | boolean][] = [];
  if (o.created !== undefined) params.push(['created', o.created]);
  if (o.expires !== undefined) params.push(['expires', o.expires]);
  if (o.nonce !== undefined) params.push(['nonce', o.nonce]);
  params.push(['alg', o.alg], ['keyid', o.keyId]);
  if (o.tag !== undefined) params.push(['tag', o.tag]);
  const serialised = `(${comps.map(serialiseId).join(' ')})${params.map(sfParam).join('')}`;
  const base = signatureBase(req, { components: comps, serialised });
  return { signatureInput: `${label}=${serialised}`, signature: `${label}=:${b64(signBytes(o.alg, o.key, Buffer.from(base)))}:` };
}

// ------------------------------------------------------------ signing a whole request

export interface SignRequestOptions {
  readonly keyId: string;
  readonly key: KeyObject | Uint8Array;
  readonly alg: Alg;
  readonly dialect: 'cavage' | 'rfc9421';
  readonly now?: () => number;
  /** Extra headers or components to sign beyond the defaults. */
  readonly extra?: readonly string[];
  readonly expiresInSeconds?: number;
}

/**
 * Returns the headers to add to a request to sign it: Host, Date and Digest (or Content-Digest) when missing, and the
 * signature itself.
 */
export function signRequest(req: Req, o: SignRequestOptions): Record<string, string> {
  const now = (o.now ?? Date.now)();
  const add: Record<string, string> = {};
  const h = lower(req.headers);
  const t = target(req, h);
  const hasBody = bytes(req.body).length > 0 || ['POST', 'PUT', 'PATCH'].includes(req.method.toUpperCase());
  if (!h.has('host')) add.host = t.authority;
  if (o.dialect === 'cavage') {
    if (!h.has('date')) add.date = new Date(now).toUTCString();
    if (hasBody && !h.has('digest')) add.digest = digestHeader(req.body);
    const withAdded = { ...req, headers: { ...req.headers, ...add } };
    const headers = [...defaultCavageHeaders(withAdded), ...(o.extra ?? [])];
    return { ...add, signature: signCavage(withAdded, { keyId: o.keyId, key: o.key, alg: o.alg, headers }) };
  }
  if (hasBody && !h.has('content-digest')) add['content-digest'] = contentDigest(req.body);
  const withAdded = { ...req, headers: { ...req.headers, ...add } };
  const created = Math.floor(now / 1000);
  const components = ['@method', '@authority', '@path', ...(t.query !== undefined ? ['@query'] : []), ...(lower(withAdded.headers).has('content-digest') ? ['content-digest'] : []), ...(o.extra ?? [])];
  const r = signRfc9421(withAdded, { keyId: o.keyId, key: o.key, alg: o.alg, components, created, ...(o.expiresInSeconds !== undefined ? { expires: created + o.expiresInSeconds } : {}) });
  return { ...add, 'signature-input': r.signatureInput, signature: r.signature };
}

// ------------------------------------------------------------ key ids

/**
 * The document to fetch for a key id: https only, no credentials, no port other than 443, no localhost or private
 * address literal, and the fragment ("#main-key") removed. `allowHosts`, when given, limits it further.
 */
export function keyDocumentUrl(keyId: string, o: { allowHosts?: readonly string[]; allowHttp?: boolean } = {}): string {
  let u: URL;
  try {
    u = new URL(keyId);
  } catch {
    throw new SignatureError('key-url', 'the key id is not a URL');
  }
  if (u.protocol !== 'https:' && !(o.allowHttp && u.protocol === 'http:')) throw new SignatureError('key-url', 'a key id must be an https URL');
  if (u.username || u.password) throw new SignatureError('key-url', 'a key id cannot carry credentials');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (u.port && !(o.allowHttp)) throw new SignatureError('key-url', 'a key id must use the standard port');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !host.includes(':')) throw new SignatureError('key-url', 'a key id cannot point at a local name');
  if (isPrivateAddress(host)) throw new SignatureError('key-url', 'a key id cannot point at a private address');
  if (o.allowHosts && !o.allowHosts.map((x) => x.toLowerCase()).includes(host)) throw new SignatureError('key-url', `${host} is not an allowed key host`);
  u.hash = '';
  return u.href;
}

export function isPrivateAddress(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (host.includes(':')) {
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (m) return isPrivateAddress(m[1] as string);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host); // the form URL parsing leaves an IPv4-mapped address in
    if (hex) {
      const [hi, lo] = [parseInt(hex[1] as string, 16), parseInt(hex[2] as string, 16)];
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  }
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true; // 2130706433 and 0x7f000001 spell 127.0.0.1
  return false;
}

export type KeyResolver = (keyId: string, o?: { fresh?: boolean }) => Promise<VerificationKey | undefined>;

export interface CacheOptions {
  readonly ttlMs?: number;
  readonly negativeTtlMs?: number;
  readonly max?: number;
  readonly now?: () => number;
}

/**
 * Wraps a fetch with a cache: found keys for `ttlMs`, misses for a shorter `negativeTtlMs` (so a bad actor cannot make
 * the server fetch the same address over and over), one fetch at a time per key id, and `fresh` to bypass the cache when
 * a signature failed and the key may have been rotated. Failed fetches are not cached.
 */
export function cachedResolver(fetch: (keyId: string) => Promise<VerificationKey | undefined>, o: CacheOptions = {}): KeyResolver & { size: () => number; clear: () => void } {
  const now = o.now ?? Date.now;
  const ttl = o.ttlMs ?? 3_600_000;
  const neg = o.negativeTtlMs ?? 60_000;
  const max = o.max ?? 10_000;
  const cache = new Map<string, { until: number; v: VerificationKey | undefined }>();
  const inflight = new Map<string, Promise<VerificationKey | undefined>>();
  const resolver = async (keyId: string, opt: { fresh?: boolean } = {}) => {
    const hit = cache.get(keyId);
    if (hit && hit.until > now() && !opt.fresh) return hit.v;
    const running = inflight.get(keyId);
    if (running) return running;
    const p = (async () => {
      try {
        const v = await fetch(keyId);
        if (cache.size >= max) cache.delete(cache.keys().next().value as string);
        cache.set(keyId, { until: now() + (v ? ttl : neg), v });
        return v;
      } finally {
        inflight.delete(keyId);
      }
    })();
    inflight.set(keyId, p);
    return p;
  };
  return Object.assign(resolver, { size: () => cache.size, clear: () => cache.clear() });
}

// ------------------------------------------------------------ replay

export class NonceCache {
  private readonly seen = new Map<string, number>();
  private readonly now: () => number;
  private readonly max: number;
  constructor(o: { now?: () => number; max?: number } = {}) {
    this.now = o.now ?? Date.now;
    this.max = o.max ?? 100_000;
  }
  /** Records a nonce; returns false when it was already seen and has not yet expired. */
  claim(key: string, ttlMs: number): boolean {
    const t = this.now();
    const until = this.seen.get(key);
    if (until !== undefined && until > t) return false;
    if (this.seen.size >= this.max) for (const [k, u] of this.seen) if (u <= t || this.seen.size >= this.max) this.seen.delete(k);
    this.seen.set(key, t + ttlMs);
    return true;
  }
}

// ------------------------------------------------------------ verifying

export interface VerifyOptions {
  readonly resolve: KeyResolver;
  readonly now?: () => number;
  /** Seconds a signature's time may differ from now, either way. Default 300. */
  readonly skewSeconds?: number;
  /** Oldest a signature may be, in seconds. Default 3600 */
  readonly maxAgeSeconds?: number;
  /** Components (or cavage headers) that must be signed, besides the defaults. */
  readonly require?: readonly string[];
  /** Turns off the default coverage rules (method and target, host, time, and the digest of a body). */
  readonly lax?: boolean;
  readonly nonces?: NonceCache;
  /** Which dialects to accept. Both by default. */
  readonly dialects?: readonly ('cavage' | 'rfc9421')[];
  /** An RFC 9421 `tag` this receiver requires, if any. */
  readonly tag?: string;
  /** For a relative request target. */
  readonly scheme?: string;
}

export interface Verified {
  readonly dialect: 'cavage' | 'rfc9421';
  readonly keyId: string;
  readonly alg: Alg;
  readonly owner?: string;
  /** The signed names. */
  readonly covered: readonly string[];
  /** Seconds since the epoch, when the signature says. */
  readonly created?: number;
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export async function verify(req: Req, o: VerifyOptions): Promise<Verified> {
  const h = lower(req.headers);
  const allowed = o.dialects ?? ['cavage', 'rfc9421'];
  if (h.has('signature-input') && h.has('signature')) {
    if (!allowed.includes('rfc9421')) throw new SignatureError('policy', 'RFC 9421 signatures are not accepted here');
    return verify9421(req, h, o);
  }
  if (h.has('signature')) {
    if (!allowed.includes('cavage')) throw new SignatureError('policy', 'draft-cavage signatures are not accepted here');
    return verifyCavage(req, h, o);
  }
  throw new SignatureError('missing', 'the request is not signed');
}

async function keyFor(o: VerifyOptions, keyId: string, alg: Alg | undefined, check: (k: VerificationKey) => boolean): Promise<VerificationKey> {
  let k = await o.resolve(keyId);
  if (!k) throw new SignatureError('unknown-key', `no key for ${keyId}`);
  if (alg !== undefined && k.alg !== alg) throw new SignatureError('alg', `the signature says ${alg} but the key is for ${k.alg}`);
  if (!check(k)) {
    // The key may have been rotated since it was cached: look once more, bypassing the cache.
    const again = await o.resolve(keyId, { fresh: true });
    if (!again) throw new SignatureError('unknown-key', `no key for ${keyId}`);
    k = again;
    if (alg !== undefined && k.alg !== alg) throw new SignatureError('alg', `the signature says ${alg} but the key is for ${k.alg}`);
    if (!check(k)) throw new SignatureError('bad-signature', 'the signature does not match');
  }
  return k;
}

function timeChecks(o: VerifyOptions, created: number | undefined, expires: number | undefined, dateHeader: string | undefined): number | undefined {
  const nowS = Math.floor((o.now ?? Date.now)() / 1000);
  const skew = o.skewSeconds ?? 300;
  const maxAge = o.maxAgeSeconds ?? 3600;
  let when = created;
  if (when === undefined && dateHeader !== undefined) {
    const t = Date.parse(dateHeader);
    if (Number.isNaN(t)) throw new SignatureError('malformed', 'the Date header is not a date');
    when = Math.floor(t / 1000);
  }
  if (when === undefined) throw new SignatureError('policy', 'the signature has no time: it needs created or a signed Date');
  if (when - nowS > skew) throw new SignatureError('skew', `the signature is dated ${when - nowS} seconds in the future`);
  if (nowS - when > maxAge + skew) throw new SignatureError('expired', `the signature is ${nowS - when} seconds old`);
  if (expires !== undefined && nowS - expires > skew) throw new SignatureError('expired', 'the signature has expired');
  return created ?? when;
}

function bodyChecks(req: Req, h: Map<string, string>, covered: readonly string[], digestNames: readonly string[], o: VerifyOptions): void {
  const hasBody = bytes(req.body).length > 0;
  const digestHeaders = digestNames.filter((n) => h.has(n));
  if (digestHeaders.length > 0) checkDigests(Object.fromEntries(digestHeaders.map((n) => [n, h.get(n) as string])), req.body);
  if (!o.lax && (hasBody || BODY_METHODS.has(req.method.toUpperCase()))) {
    const signed = digestNames.filter((n) => covered.includes(n));
    if (signed.length === 0) throw new SignatureError('policy', `a request with a body must sign its digest (${digestNames.join(' or ')})`);
    for (const n of signed) if (!h.has(n)) throw new SignatureError('missing', `the signed ${n} is not in the request`);
  }
}

async function verifyCavage(req: Req, h: Map<string, string>, o: VerifyOptions): Promise<Verified> {
  const p = parseCavage(h.get('signature') as string);
  const declared = p.algorithm === undefined ? 'hs2019' : CAVAGE_ALG[p.algorithm.toLowerCase()];
  if (declared === undefined) throw new SignatureError('alg', `the algorithm ${p.algorithm} is not supported`);
  const alg = declared === 'hs2019' ? undefined : declared;
  const base = Buffer.from(cavageString(req, h, p));
  const sig = unb64(p.signature);
  const k = await keyFor(o, p.keyId, alg, (key) => verifyBytes(key.alg, key.key, base, sig));
  const covered = p.headers;
  if (!o.lax) {
    for (const need of ['(request-target)', 'host']) if (!covered.includes(need)) throw new SignatureError('policy', `${need} must be signed`);
    if (!covered.includes('date') && !covered.includes('(created)')) throw new SignatureError('policy', 'a time must be signed: date or (created)');
  }
  for (const need of o.require ?? []) if (!covered.includes(need.toLowerCase())) throw new SignatureError('policy', `${need} must be signed`);
  const created = timeChecks(o, covered.includes('(created)') || p.created !== undefined ? p.created : undefined, p.expires, covered.includes('date') ? h.get('date') : undefined);
  bodyChecks(req, h, covered, ['digest', 'content-digest'], o);
  return { dialect: 'cavage', keyId: p.keyId, alg: k.alg, ...(k.owner ? { owner: k.owner } : {}), covered, ...(created !== undefined ? { created } : {}) };
}

async function verify9421(req: Req, h: Map<string, string>, o: VerifyOptions): Promise<Verified> {
  const inputs = parseSignatureInput(h.get('signature-input') as string);
  const sigs = parseSignatureDict(h.get('signature') as string);
  let lastErr: SignatureError | undefined;
  // A request may carry several signatures (a proxy adds one); one good signature that meets policy is enough.
  for (const p of inputs) {
    try {
      const sig = sigs.get(p.label);
      if (!sig) throw new SignatureError('malformed', `Signature-Input has ${p.label} but Signature does not`);
      if (o.tag !== undefined && p.tag !== o.tag) throw new SignatureError('policy', `the signature is not tagged ${o.tag}`);
      if (!p.keyid) throw new SignatureError('malformed', 'the signature has no keyid');
      const alg = p.alg === undefined ? undefined : (ALGS as readonly string[]).includes(p.alg) ? (p.alg as Alg) : undefined;
      if (p.alg !== undefined && alg === undefined) throw new SignatureError('alg', `the algorithm ${p.alg} is not supported`);
      const base = Buffer.from(signatureBase(req, p));
      const k = await keyFor(o, p.keyid, alg, (key) => verifyBytes(key.alg, key.key, base, sig));
      const names = p.components.map((c) => c.name);
      if (!o.lax) {
        if (!names.includes('@method')) throw new SignatureError('policy', '@method must be signed');
        if (!names.some((n) => n === '@target-uri' || n === '@path' || n === '@request-target')) throw new SignatureError('policy', 'the request target must be signed');
        if (!names.some((n) => n === '@authority' || n === '@target-uri' || n === 'host')) throw new SignatureError('policy', 'the authority must be signed');
        if (p.created === undefined && !names.includes('date')) throw new SignatureError('policy', 'a time must be signed: created or date');
      }
      for (const need of o.require ?? []) if (!names.includes(need.toLowerCase())) throw new SignatureError('policy', `${need} must be signed`);
      const created = timeChecks(o, p.created, p.expires, names.includes('date') ? h.get('date') : undefined);
      bodyChecks(req, h, names, ['content-digest', 'digest'], o);
      if (o.nonces) {
        const id = `${p.keyid}\0${p.nonce ?? `${p.created ?? ''}\0${b64(sig)}`}`;
        if (!o.nonces.claim(id, ((o.skewSeconds ?? 300) * 2 + (o.maxAgeSeconds ?? 3600)) * 1000)) throw new SignatureError('replay', 'this signature was already used');
      }
      return { dialect: 'rfc9421', keyId: p.keyid, alg: k.alg, ...(k.owner ? { owner: k.owner } : {}), covered: names, ...(created !== undefined ? { created } : {}) };
    } catch (e) {
      if (!(e instanceof SignatureError)) throw e;
      lastErr = e;
    }
  }
  throw lastErr as SignatureError;
}
