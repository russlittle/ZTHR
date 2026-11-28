/**
 * DKIM (RFC 6376) signing and verification of mail, with the two canonicalisations ("simple", which keeps the
 * message nearly as written, and "relaxed", which survives mail servers that re-wrap headers and trim blanks)
 * and the two algorithms in use: rsa-sha256 (keys of 1024 bits or more; 2048 to sign) and ed25519-sha256
 * (RFC 8463: the raw 32-byte public key in DNS, and the signature made over the SHA-256 of the header data).
 * rsa-sha1 is refused outright (RFC 8301). Signing covers headers from the bottom up, can "over-sign" a header
 * so a later added copy breaks the signature, and sets expiry. Verification checks every rule that matters: the
 * body hash, the From header being signed, expiry and future dates, a key record that is present and not revoked,
 * the key type matching the algorithm, and the signing domain matching. Selector records are produced in the
 * form DNS wants (split into 255-character strings), and a rotation schedule says, for any day, which selector
 * signs, which must be published, and which can be removed. DNS and the clock are passed in.
 * A small header splitter is inside, as only header lines and the body are needed.
 */
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export class DkimRefused extends Error {
  constructor(why: string) {
    super(why);
  }
}

export type Algorithm = 'rsa-sha256' | 'ed25519-sha256';
export type Canon = 'simple' | 'relaxed';

// ---------------------------------------------------------------- message and canonicalisation

export interface HeaderLine {
  readonly name: string;
  /** The line exactly as written, folds included, without the final CRLF. */
  readonly raw: string;
}

const MAX_MESSAGE = 25_000_000;

export function splitMessage(message: string | Uint8Array): { headers: HeaderLine[]; body: string } {
  const text = (typeof message === 'string' ? message : Buffer.from(message).toString('latin1')).replace(/\r?\n/g, '\r\n');
  if (text.length > MAX_MESSAGE) throw new DkimRefused('the message is larger than 25 MB');
  const end = text.indexOf('\r\n\r\n');
  const head = end < 0 ? text.replace(/\r\n$/, '') : text.slice(0, end);
  const body = end < 0 ? '' : text.slice(end + 4);
  const headers: HeaderLine[] = [];
  for (const line of head.split('\r\n')) {
    if (/^[ \t]/.test(line) && headers.length) {
      const last = headers.pop()!;
      headers.push({ name: last.name, raw: `${last.raw}\r\n${line}` });
    } else {
      const i = line.indexOf(':');
      if (i < 1 || /[\s\x00-\x1f]/.test(line.slice(0, i).trimEnd().replace(/\s+$/, ''))) throw new DkimRefused(`a header line has no name: ${JSON.stringify(line.slice(0, 30))}`);
      headers.push({ name: line.slice(0, i).trim().toLowerCase(), raw: line });
    }
  }
  return { headers, body };
}

export function canonBody(body: string, mode: Canon): string {
  let b = body;
  if (mode === 'relaxed') b = b.split('\r\n').map((l) => l.replace(/[ \t]+$/, '').replace(/[ \t]+/g, ' ')).join('\r\n');
  b = b.replace(/(\r\n)+$/, '');
  if (mode === 'simple') return `${b}\r\n`;
  return b.length ? `${b}\r\n` : '';
}

export function canonHeader(h: HeaderLine, mode: Canon): string {
  if (mode === 'simple') return `${h.raw}\r\n`;
  const i = h.raw.indexOf(':');
  const value = h.raw.slice(i + 1).replace(/\r\n(?=[ \t])/g, '').replace(/[ \t]+/g, ' ').trim();
  return `${h.name}:${value}\r\n`;
}

export const bodyHash = (body: string, mode: Canon, limit?: number): string => {
  const c = Buffer.from(canonBody(body, mode), 'latin1');
  return createHash('sha256').update(limit === undefined ? c : c.subarray(0, limit)).digest('base64');
};

/** Picks the headers named in `h`, each name from the bottom of the message upwards, one occurrence per mention. */
function selectHeaders(headers: readonly HeaderLine[], names: readonly string[]): HeaderLine[] {
  const used = new Map<string, number>();
  const out: HeaderLine[] = [];
  for (const n of names) {
    const lc = n.toLowerCase();
    const same = headers.filter((x) => x.name === lc);
    const k = used.get(lc) ?? 0;
    used.set(lc, k + 1);
    const pick = same[same.length - 1 - k];
    if (pick) out.push(pick);
  }
  return out;
}

// ---------------------------------------------------------------- keys

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

export interface Signer {
  readonly domain: string;
  readonly selector: string;
  readonly privateKey: KeyObject | string;
  readonly algorithm: Algorithm;
}

const keyObject = (k: KeyObject | string): KeyObject => (typeof k === 'string' ? createPrivateKey(k) : k);

/** The value of the selector's DNS TXT record for a key: "v=DKIM1; k=rsa; p=..." (RFC 6376 section 3.6.1, RFC 8463). */
export function selectorRecord(publicKey: KeyObject, algorithm: Algorithm, o: { testing?: boolean; strict?: boolean } = {}): string {
  const spki = (publicKey.type === 'private' ? createPublicKey(publicKey) : publicKey).export({ type: 'spki', format: 'der' });
  const p = algorithm === 'ed25519-sha256' ? spki.subarray(spki.length - 32) : spki;
  const flags = [o.testing ? 'y' : '', o.strict ? 's' : ''].filter(Boolean).join(':');
  return `v=DKIM1; k=${algorithm === 'ed25519-sha256' ? 'ed25519' : 'rsa'}; ${flags ? `t=${flags}; ` : ''}p=${p.toString('base64')}`;
}

/** A TXT record longer than 255 characters goes into DNS as several quoted strings. */
export const txtChunks = (value: string, size = 255): string[] => Array.from({ length: Math.ceil(value.length / size) }, (_, i) => value.slice(i * size, (i + 1) * size));

export interface KeyRecord {
  readonly version: string;
  readonly keyType: 'rsa' | 'ed25519';
  readonly key: KeyObject | undefined;
  readonly revoked: boolean;
  readonly testing: boolean;
  readonly strict: boolean;
  readonly hashes: readonly string[] | undefined;
}

function tagList(s: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of s.split(';')) {
    if (!part.trim()) continue;
    const i = part.indexOf('=');
    if (i < 1) throw new DkimRefused('a tag has no value');
    const k = part.slice(0, i).trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(k)) throw new DkimRefused(`${JSON.stringify(k.slice(0, 20))} is not a tag name`);
    if (m.has(k)) throw new DkimRefused(`the tag ${k} appears twice`);
    m.set(k, part.slice(i + 1).replace(/\s+/g, ' ').trim());
  }
  return m;
}

export function parseKeyRecord(txt: string): KeyRecord {
  if (txt.length > 4096) throw new DkimRefused('the key record is too long');
  const t = tagList(txt);
  const v = t.get('v');
  if (v !== undefined && v !== 'DKIM1') throw new DkimRefused('the key record is not DKIM1');
  const k = t.get('k') ?? 'rsa';
  if (k !== 'rsa' && k !== 'ed25519') throw new DkimRefused(`key type ${k} is not supported`);
  const p = (t.get('p') ?? '').replace(/\s+/g, '');
  const flags = (t.get('t') ?? '').split(':').map((x) => x.trim());
  const base = { version: 'DKIM1', keyType: k, testing: flags.includes('y'), strict: flags.includes('s'), hashes: t.has('h') ? t.get('h')!.split(':').map((x) => x.trim()) : undefined } as const;
  if (!t.has('p')) throw new DkimRefused('the key record has no p= tag');
  if (p === '') return { ...base, key: undefined, revoked: true };
  const raw = Buffer.from(p, 'base64');
  try {
    const key = k === 'ed25519' ? createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' }) : createPublicKey({ key: raw, format: 'der', type: 'spki' });
    if (k === 'ed25519' && raw.length !== 32) throw new Error('length');
    if (k === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 1024) throw new DkimRefused('RSA keys under 1024 bits are not accepted');
    return { ...base, key, revoked: false };
  } catch (e) {
    if (e instanceof DkimRefused) throw e;
    throw new DkimRefused('the key in the record cannot be read');
  }
}

// ---------------------------------------------------------------- signing

export interface SignOptions {
  readonly now: () => number;
  /** Header names to sign; default the common set. */
  readonly headers?: readonly string[];
  /** Name each signed header once more, so one added later breaks the signature. Default true. */
  readonly oversign?: boolean;
  readonly canon?: { readonly header: Canon; readonly body: Canon };
  /** Seconds the signature stays valid; omit for no expiry. */
  readonly expiresInSeconds?: number;
}

const DEFAULT_HEADERS = ['from', 'to', 'cc', 'subject', 'date', 'message-id', 'reply-to', 'in-reply-to', 'references', 'mime-version', 'content-type', 'content-transfer-encoding', 'list-unsubscribe', 'list-unsubscribe-post'];

const fold = (s: string, width = 76): string => {
  const lines: string[] = [];
  let cur = '';
  for (const word of s.split(' ')) {
    if (cur && cur.length + 1 + word.length > width) {
      lines.push(cur);
      cur = `\t${word}`;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  lines.push(cur);
  return lines.join('\r\n');
};

const validDomain = (d: string) => /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9-]{2,63}$/.test(d);
const validSelector = (s: string) => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(s);

function signData(alg: Algorithm, key: KeyObject, data: Buffer): Buffer {
  if (alg === 'rsa-sha256') return nodeSign('sha256', data, key);
  return nodeSign(null, createHash('sha256').update(data).digest(), key);
}

/** The DKIM-Signature header line for a message, ready to put at its top. */
export function sign(message: string | Uint8Array, s: Signer, o: SignOptions): string {
  if (!validDomain(s.domain)) throw new DkimRefused('the signing domain is not a valid domain name');
  if (!validSelector(s.selector)) throw new DkimRefused('the selector is not valid');
  const key = keyObject(s.privateKey);
  if (s.algorithm === 'rsa-sha256' && (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 1024)) throw new DkimRefused('rsa-sha256 needs an RSA key of at least 1024 bits (2048 is advised)');
  if (s.algorithm === 'ed25519-sha256' && key.asymmetricKeyType !== 'ed25519') throw new DkimRefused('ed25519-sha256 needs an Ed25519 key');
  const m = splitMessage(message);
  const canon = o.canon ?? { header: 'relaxed', body: 'relaxed' };
  const present = new Set(m.headers.map((h) => h.name));
  if (!present.has('from')) throw new DkimRefused('the message has no From header, so it cannot be signed');
  const wanted = (o.headers ?? DEFAULT_HEADERS).map((n) => n.toLowerCase());
  if (wanted.includes('dkim-signature')) throw new DkimRefused('the DKIM-Signature header is not signed by name');
  const names = wanted.filter((n) => present.has(n));
  const counts = new Map<string, number>();
  for (const h of m.headers) counts.set(h.name, (counts.get(h.name) ?? 0) + 1);
  const h: string[] = [];
  for (const n of names) {
    for (let i = 0; i < counts.get(n)!; i++) h.push(n);
    if (o.oversign ?? true) h.push(n);
  }
  const t = Math.floor(o.now() / 1000);
  const tags = [`v=1`, `a=${s.algorithm}`, `c=${canon.header}/${canon.body}`, `d=${s.domain}`, `s=${s.selector}`, `t=${t}`, ...(o.expiresInSeconds ? [`x=${t + o.expiresInSeconds}`] : []), `h=${h.join(':')}`, `bh=${bodyHash(m.body, canon.body)}`];
  const head = fold(`DKIM-Signature: ${tags.join('; ')}; b=`);
  const hdr: HeaderLine = { name: 'dkim-signature', raw: head };
  const data = Buffer.from(selectHeaders(m.headers, h).map((x) => canonHeader(x, canon.header)).join('') + canonHeader(hdr, canon.header).replace(/\r\n$/, ''), 'latin1');
  const b = signData(s.algorithm, key, data).toString('base64');
  const chunks = b.match(/.{1,64}/g) ?? [];
  return `${head}\r\n\t${chunks.join('\r\n\t')}`;
}

// ---------------------------------------------------------------- verification

export type Result = 'pass' | 'fail' | 'permerror' | 'temperror' | 'none';

export interface Verdict {
  readonly result: Result;
  readonly reason: string;
  readonly domain?: string;
  readonly selector?: string;
  /** The signature covered only the first N bytes of the body (an l= tag). */
  readonly bodyLimited?: boolean;
  /** The key record was marked as a test. */
  readonly testing?: boolean;
  readonly algorithm?: string;
}

/** Finds the TXT records at a name; may throw to mean a temporary DNS failure. Returns [] when there are none. */
export type Lookup = (name: string) => Promise<readonly string[]> | readonly string[];

export interface VerifyOptions {
  readonly lookup: Lookup;
  readonly now: () => number;
  /** Seconds of clock difference to allow; default 300. */
  readonly skewSeconds?: number;
}

/** Verifies every DKIM-Signature header on a message; one verdict each (or one "none"). */
export async function verify(message: string | Uint8Array, o: VerifyOptions): Promise<Verdict[]> {
  const m = splitMessage(message);
  const sigs = m.headers.filter((h) => h.name === 'dkim-signature');
  if (!sigs.length) return [{ result: 'none', reason: 'the message has no DKIM signature' }];
  if (sigs.length > 5) return [{ result: 'permerror', reason: 'more than five signatures; none are checked' }];
  const out: Verdict[] = [];
  for (const sig of sigs) out.push(await verifyOne(m, sig, o));
  return out;
}

async function verifyOne(m: { headers: HeaderLine[]; body: string }, sig: HeaderLine, o: VerifyOptions): Promise<Verdict> {
  const perm = (reason: string, extra: Partial<Verdict> = {}): Verdict => ({ result: 'permerror', reason, ...extra });
  let t: Map<string, string>;
  try {
    t = tagList(sig.raw.slice(sig.raw.indexOf(':') + 1));
  } catch (e) {
    return perm(`the signature is malformed: ${(e as Error).message}`);
  }
  for (const req of ['v', 'a', 'b', 'bh', 'd', 'h', 's']) if (!t.has(req)) return perm(`the signature has no ${req}= tag`);
  const d = t.get('d')!.toLowerCase();
  const sel = t.get('s')!;
  const id = { domain: d, selector: sel };
  if (t.get('v') !== '1') return perm('the signature version is not 1', id);
  const alg = t.get('a')!;
  if (alg === 'rsa-sha1') return perm('rsa-sha1 signatures are not accepted (RFC 8301)', id);
  if (alg !== 'rsa-sha256' && alg !== 'ed25519-sha256') return perm(`the algorithm ${alg} is not supported`, id);
  if (!validDomain(d) || !validSelector(sel)) return perm('the domain or selector is not valid', id);
  const [hc = 'simple', bc = hc === 'simple' ? 'simple' : 'simple'] = (t.get('c') ?? 'simple/simple').split('/');
  if (!['simple', 'relaxed'].includes(hc) || !['simple', 'relaxed'].includes(bc)) return perm('the canonicalisation is not simple or relaxed', id);
  const hNames = t.get('h')!.split(':').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!hNames.includes('from')) return perm('the signature does not cover the From header', id);
  const now = Math.floor(o.now() / 1000);
  const skew = o.skewSeconds ?? 300;
  const ts = t.get('t');
  if (ts !== undefined && (!/^\d{1,12}$/.test(ts) || Number(ts) > now + skew)) return { result: 'fail', reason: 'the signature is dated in the future', ...id };
  const x = t.get('x');
  if (x !== undefined) {
    if (!/^\d{1,12}$/.test(x)) return perm('the expiry is not a number', id);
    if (Number(x) + skew < now) return { result: 'fail', reason: 'the signature has expired', ...id };
  }
  const idTag = t.get('i');
  if (idTag !== undefined) {
    const at = idTag.lastIndexOf('@');
    const idDomain = (at >= 0 ? idTag.slice(at + 1) : idTag).toLowerCase();
    if (idDomain !== d && !idDomain.endsWith(`.${d}`)) return perm('the signing identity is outside the signing domain', id);
  }
  const l = t.get('l');
  if (l !== undefined && !/^\d{1,12}$/.test(l)) return perm('the body length is not a number', id);
  let record: KeyRecord;
  try {
    const txt = await o.lookup(`${sel}._domainkey.${d}`);
    const rec = txt.map((x) => x.trim()).filter((x) => x.length);
    if (!rec.length) return perm('there is no key record for that selector', id);
    if (rec.length > 1) return perm('there is more than one key record', id);
    record = parseKeyRecord(rec[0]!);
  } catch (e) {
    return e instanceof DkimRefused ? perm(e.message, id) : { result: 'temperror', reason: 'the key could not be looked up just now', ...id };
  }
  if (record.revoked || !record.key) return { result: 'fail', reason: 'the key has been revoked (its record is empty)', ...id };
  const need = alg === 'rsa-sha256' ? 'rsa' : 'ed25519';
  if (record.keyType !== need) return perm(`the key is ${record.keyType}, the signature says ${alg}`, id);
  if (record.hashes && !record.hashes.includes('sha256')) return perm('the key does not allow sha256', id);
  const bodyLimited = l !== undefined;
  const bh = bodyHash(m.body, bc as Canon, l === undefined ? undefined : Number(l));
  const common = { ...id, algorithm: alg, ...(bodyLimited ? { bodyLimited: true } : {}), ...(record.testing ? { testing: true } : {}) };
  if (l !== undefined && Number(l) > Buffer.byteLength(canonBody(m.body, bc as Canon), 'latin1')) return { result: 'fail', reason: 'the signature claims more body than the message has', ...common };
  if (bh !== t.get('bh')!.replace(/\s+/g, '')) return { result: 'fail', reason: 'the body hash does not match: the body was changed', ...common };
  const colon = sig.raw.indexOf(':');
  const stripped: HeaderLine = { name: 'dkim-signature', raw: sig.raw.slice(0, colon + 1) + sig.raw.slice(colon + 1).replace(/(^|;)(\s*)b(\s*)=[^;]*/, '$1$2b$3=') };
  const data = Buffer.from(selectHeaders(m.headers.filter((h) => h !== sig), hNames).map((h) => canonHeader(h, hc as Canon)).join('') + canonHeader(stripped, hc as Canon).replace(/\r\n$/, ''), 'latin1');
  const sigBytes = Buffer.from(t.get('b')!.replace(/\s+/g, ''), 'base64');
  let ok = false;
  try {
    ok = alg === 'rsa-sha256' ? nodeVerify('sha256', data, record.key, sigBytes) : nodeVerify(null, createHash('sha256').update(data).digest(), record.key, sigBytes);
  } catch {
    ok = false;
  }
  if (!ok) return { result: 'fail', reason: 'the signature does not match the headers: they were changed, or it was not made with this key', ...common };
  return { result: 'pass', reason: record.testing ? 'the signature is good (the key is marked as a test)' : 'the signature is good', ...common };
}

/** Whether a verdict vouches for a From domain: it passed and the signing domain is the From domain or its parent (relaxed alignment). */
export function aligned(v: Verdict, fromDomain: string, strict = false): boolean {
  if (v.result !== 'pass' || !v.domain) return false;
  const f = fromDomain.toLowerCase();
  return strict ? v.domain === f : f === v.domain || f.endsWith(`.${v.domain}`);
}

/** The domain in the From header of a message, for alignment. */
export function fromDomain(message: string | Uint8Array): string | undefined {
  const h = splitMessage(message).headers.filter((x) => x.name === 'from').at(-1);
  const m = h && /@([A-Za-z0-9.-]+)\s*>?\s*(?:\(.*\))?\s*$/.exec(h.raw.replace(/\r\n[ \t]/g, ' '));
  return m ? m[1]!.toLowerCase() : undefined;
}

// ---------------------------------------------------------------- selector rotation

export interface RotationOptions {
  /** Selectors are named prefix + period number (e.g. "s" + "2025q2"-style by day count). */
  readonly prefix: string;
  /** Days each selector signs. */
  readonly periodDays: number;
  /** Days before a period starts when its record is already published. */
  readonly publishAheadDays: number;
  /** Days after a period ends when its record stays published, for mail still in flight. */
  readonly keepDays: number;
}

export interface RotationPlan {
  readonly signWith: string;
  /** Records that must exist in DNS today. */
  readonly publish: readonly string[];
  /** Selectors from earlier periods whose records may be removed. */
  readonly retire: readonly string[];
}

const DAY = 86_400_000;

export function rotationPlan(o: RotationOptions, now: number, known: readonly string[] = []): RotationPlan {
  if (!(o.periodDays >= 1 && o.publishAheadDays >= 0 && o.keepDays >= 0 && validSelector(`${o.prefix}0`))) throw new DkimRefused('the rotation settings are not valid');
  const day = Math.floor(now / DAY);
  const period = Math.floor(day / o.periodDays);
  const name = (p: number) => `${o.prefix}${p}`;
  const start = period * o.periodDays;
  const publish = new Set([name(period)]);
  if (start + o.periodDays - day <= o.publishAheadDays) publish.add(name(period + 1));
  if (day - start < o.keepDays) publish.add(name(period - 1));
  const retire = known.filter((k) => k.startsWith(o.prefix) && /^\d+$/.test(k.slice(o.prefix.length)) && !publish.has(k) && Number(k.slice(o.prefix.length)) < period);
  return { signWith: name(period), publish: [...publish].sort((a, b) => Number(a.slice(o.prefix.length)) - Number(b.slice(o.prefix.length))), retire: [...retire].sort() };
}
