/**
 * SAML 2.0 Web Browser SSO for a service provider (SP): the AuthnRequest out, the Response in, and the metadata on
 * both sides. Sans-IO: strings in and strings out, with the clock and randomness injected, and the request memory and
 * replay cache behind small interfaces (in-memory versions included).
 *
 * `Sp.authnRequest` builds the request (HTTP-Redirect with the query-string signature, or HTTP-POST with an enveloped
 * signature) and remembers its ID. `Sp.consume` takes the posted SAMLResponse and either returns the verified
 * facts or throws SamlError: signature by xml-dsig against the IdP's pinned certificates (Response, Assertion, or
 * both; an unsigned message is refused), with every claim then read from the bytes that were digested, never from the
 * original document, which is what defeats signature wrapping; exactly one assertion; Status Success; Issuer;
 * Destination and Recipient equal to our ACS URL; InResponseTo equal to a request we sent and have not used before (or
 * absent, only when IdP-initiated login is switched on); bearer confirmation with a deadline; NotBefore and
 * NotOnOrAfter with a stated clock skew; an AudienceRestriction naming us; unknown conditions refused; AuthnInstant
 * (and a maximum authentication age); and a replay cache keyed on the assertion ID. Times must be UTC ("Z").
 * `spMetadata` writes our EntityDescriptor; `parseIdpMetadata` reads the IdP's, requires it to be signed by a pinned
 * certificate unless told otherwise, and honours validUntil.
 *
 * Out of scope: encrypted assertions and NameIDs (refused with a clear error, so ask the IdP to send them signed and
 * plain over TLS), Single Logout, artifact binding, the IdP side (issuing responses), EntitiesDescriptor federations,
 * attribute queries, and signed-request verification on the redirect binding by an IdP.
 */
import { createSign, createVerify, createPublicKey, X509Certificate, type KeyObject, createPrivateKey } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { escapeXml } from '../dav/index.ts';
import { readXml, verifyElement, sign as signXml, childNamed, childrenNamed, childEls, textOf, attr, NS_DSIG, XmlDsigError, type XEl, type Doc, type Verified } from '../xml-dsig/index.ts';

export const NS = {
  samlp: 'urn:oasis:names:tc:SAML:2.0:protocol',
  saml: 'urn:oasis:names:tc:SAML:2.0:assertion',
  md: 'urn:oasis:names:tc:SAML:2.0:metadata',
} as const;
export const BINDING = {
  post: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
  redirect: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
} as const;
const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success';
const CM_BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';
export const NAMEID = {
  unspecified: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
  email: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  persistent: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  transient: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
} as const;

export class SamlError extends Error {
  readonly code: string;
  constructor(code: string, why: string) {
    super(why);
    this.name = 'SamlError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- time

/** Strict xs:dateTime in UTC: 2024-05-01T12:00:00Z, optional fractional seconds. Returns milliseconds. */
export function parseTime(s: string | undefined, what: string): number {
  if (s === undefined) throw new SamlError('time', `${what} is missing`);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?Z$/.exec(s.trim());
  if (!m) throw new SamlError('time', `${what} is not a UTC time`);
  const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, m[7] ? Math.floor(Number(m[7]) * 1000) : 0);
  const d = new Date(ms);
  if (d.getUTCMonth() !== +m[2]! - 1 || d.getUTCDate() !== +m[3]! || +m[4]! > 23 || +m[5]! > 59 || +m[6]! > 60) throw new SamlError('time', `${what} is not a real time`);
  return ms;
}
export const formatTime = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---------------------------------------------------------------- stores

export interface PendingRequest {
  readonly id: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly forceAuthn: boolean;
  readonly relayState?: string;
}
export interface RequestStore {
  put(r: PendingRequest): void;
  /** Returns the request and removes it, so that a response can answer it once. */
  take(id: string, now: number): PendingRequest | undefined;
}
export class MemoryRequestStore implements RequestStore {
  readonly #m = new Map<string, PendingRequest>();
  readonly #cap: number;
  constructor(cap = 10_000) {
    this.#cap = cap;
  }
  put(r: PendingRequest): void {
    if (this.#m.size >= this.#cap) {
      this.sweep(r.issuedAt);
      if (this.#m.size >= this.#cap) this.#m.delete(this.#m.keys().next().value!);
    }
    this.#m.set(r.id, r);
  }
  take(id: string, now: number): PendingRequest | undefined {
    const r = this.#m.get(id);
    if (!r) return undefined;
    this.#m.delete(id);
    return r.expiresAt > now ? r : undefined;
  }
  sweep(now: number): number {
    let n = 0;
    for (const [k, v] of this.#m) if (v.expiresAt <= now) (this.#m.delete(k), n++);
    return n;
  }
  get size() {
    return this.#m.size;
  }
}

export interface ReplayCache {
  /** True when the ID was seen before; otherwise remembers it until `until` and returns false. */
  seen(id: string, until: number, now: number): boolean;
}
export class MemoryReplayCache implements ReplayCache {
  readonly #m = new Map<string, number>();
  readonly #cap: number;
  constructor(cap = 100_000) {
    this.#cap = cap;
  }
  seen(id: string, until: number, now: number): boolean {
    const u = this.#m.get(id);
    if (u !== undefined && u > now) return true;
    if (this.#m.size >= this.#cap) {
      this.sweep(now);
      // full of live entries: refuse rather than forget, since forgetting is how a replay gets through
      if (this.#m.size >= this.#cap) throw new SamlError('replay-cache-full', 'the replay cache is full');
    }
    this.#m.set(id, until);
    return false;
  }
  sweep(now: number): number {
    let n = 0;
    for (const [k, v] of this.#m) if (v <= now) (this.#m.delete(k), n++);
    return n;
  }
  get size() {
    return this.#m.size;
  }
}

// ---------------------------------------------------------------- configuration

export interface IdpConfig {
  readonly entityId: string;
  readonly ssoUrl: string;
  readonly ssoBinding?: 'redirect' | 'post';
  /** Pinned signing certificates (PEM). */
  readonly certificates: readonly string[];
}

export interface SpConfig {
  readonly entityId: string;
  readonly acsUrl: string;
  readonly idp: IdpConfig;
  readonly now: () => number;
  readonly random: (n: number) => Uint8Array;
  readonly requests?: RequestStore;
  readonly replay?: ReplayCache;
  /** Allowed clock difference between the IdP and us, in seconds (default 120). */
  readonly skewSeconds?: number;
  /** How long a request may wait for its response, in seconds (default 600). */
  readonly requestTtlSeconds?: number;
  /** Largest SAMLResponse accepted, in bytes of XML (default 1,000,000). */
  readonly maxResponseBytes?: number;
  /** Accept responses with no InResponseTo (IdP-initiated). Off by default. */
  readonly allowIdpInitiated?: boolean;
  /** Longest time since the user authenticated at the IdP, in seconds. */
  readonly maxAuthAgeSeconds?: number;
  /** Our key and certificate, to sign requests. */
  readonly signingKey?: KeyObject | string;
  readonly signingCertificate?: string;
  readonly nameIdFormat?: string;
  readonly allowSha1?: boolean;
}

// ---------------------------------------------------------------- request

export interface AuthnRequestOptions {
  readonly relayState?: string;
  readonly forceAuthn?: boolean;
  readonly binding?: 'redirect' | 'post';
}
export interface BuiltRequest {
  readonly id: string;
  readonly xml: string;
  /** For the redirect binding: the full URL to send the browser to. */
  readonly redirectUrl?: string;
  /** For the post binding: the form fields to post to `action`. */
  readonly post?: { readonly action: string; readonly fields: Readonly<Record<string, string>> };
}

export interface SamlFacts {
  readonly nameId: string;
  readonly nameIdFormat: string | undefined;
  readonly sessionIndex: string | undefined;
  readonly attributes: Readonly<Record<string, readonly string[]>>;
  readonly authnInstant: number;
  readonly authnContext: string | undefined;
  readonly sessionNotOnOrAfter: number | undefined;
  readonly assertionId: string;
  readonly issuer: string;
  readonly inResponseTo: string | undefined;
  readonly relayState: string | undefined;
  /** Which messages carried a verified signature. */
  readonly signed: readonly ('response' | 'assertion')[];
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const q = (s: string) => encodeURIComponent(s);

export class Sp {
  readonly #c: SpConfig;
  readonly #requests: RequestStore;
  readonly #replay: ReplayCache;
  readonly #skew: number;

  constructor(cfg: SpConfig) {
    this.#c = cfg;
    this.#requests = cfg.requests ?? new MemoryRequestStore();
    this.#replay = cfg.replay ?? new MemoryReplayCache();
    this.#skew = (cfg.skewSeconds ?? 120) * 1000;
    for (const u of [cfg.acsUrl, cfg.idp.ssoUrl]) if (!/^https:\/\/|^http:\/\/localhost[:/]/.test(u)) throw new SamlError('config', `${u} must be an https URL`);
    if (!cfg.idp.certificates.length) throw new SamlError('config', 'the IdP needs at least one pinned certificate');
    for (const c of cfg.idp.certificates) new X509Certificate(c);
  }

  /** Builds an AuthnRequest and remembers its ID until the response arrives or the request expires. */
  authnRequest(o: AuthnRequestOptions = {}): BuiltRequest {
    const c = this.#c;
    const now = c.now();
    const id = `_${hex(c.random(20))}`;
    const binding = o.binding ?? c.idp.ssoBinding ?? 'redirect';
    const xml =
      `<samlp:AuthnRequest xmlns:samlp="${NS.samlp}" xmlns:saml="${NS.saml}" ID="${id}" Version="2.0" IssueInstant="${formatTime(now)}" ` +
      `Destination="${escapeXml(c.idp.ssoUrl)}" ProtocolBinding="${BINDING.post}" AssertionConsumerServiceURL="${escapeXml(c.acsUrl)}"${o.forceAuthn ? ' ForceAuthn="true"' : ''}>` +
      `<saml:Issuer>${escapeXml(c.entityId)}</saml:Issuer><samlp:NameIDPolicy Format="${escapeXml(c.nameIdFormat ?? NAMEID.unspecified)}" AllowCreate="true"/></samlp:AuthnRequest>`;
    this.#requests.put({ id, issuedAt: now, expiresAt: now + (c.requestTtlSeconds ?? 600) * 1000, forceAuthn: !!o.forceAuthn, ...(o.relayState !== undefined ? { relayState: o.relayState } : {}) });
    if (binding === 'post') {
      const signed = c.signingKey ? signXml(xml, { privateKey: c.signingKey, id, after: { ns: NS.saml, local: 'Issuer' }, ...(c.signingCertificate ? { certificate: c.signingCertificate } : {}) }) : xml;
      return { id, xml: signed, post: { action: c.idp.ssoUrl, fields: { SAMLRequest: Buffer.from(signed).toString('base64'), ...(o.relayState !== undefined ? { RelayState: o.relayState } : {}) } } };
    }
    const sep = c.idp.ssoUrl.includes('?') ? '&' : '?';
    let query = `SAMLRequest=${q(deflateRawSync(Buffer.from(xml)).toString('base64'))}`;
    if (o.relayState !== undefined) query += `&RelayState=${q(o.relayState)}`;
    if (c.signingKey) {
      const key = typeof c.signingKey === 'string' ? createPrivateKey(c.signingKey) : c.signingKey;
      const ec = key.asymmetricKeyType === 'ec';
      const alg = ec ? 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256' : 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
      query += `&SigAlg=${q(alg)}`;
      const s = createSign('sha256').update(query);
      query += `&Signature=${q((ec ? s.sign({ key, dsaEncoding: 'ieee-p1363' }) : s.sign(key)).toString('base64'))}`;
    }
    return { id, xml, redirectUrl: `${c.idp.ssoUrl}${sep}${query}` };
  }

  /** Checks a posted SAMLResponse (base64) and returns what it proves. Throws SamlError for anything else. */
  consume(samlResponse: string, relayState?: string): SamlFacts {
    const c = this.#c;
    const now = c.now();
    const skew = this.#skew;
    const bytes = Buffer.from(samlResponse.replace(/\s+/g, ''), 'base64');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(samlResponse.replace(/\s+/g, '')) || bytes.length === 0) throw new SamlError('format', 'SAMLResponse is not base64');
    if (bytes.length > (c.maxResponseBytes ?? 1_000_000)) throw new SamlError('format', 'SAMLResponse is too large');
    let doc: Doc;
    try {
      doc = readXml(bytes.toString('utf8'), { maxBytes: c.maxResponseBytes ?? 1_000_000 });
    } catch (e) {
      throw new SamlError('xml', `the response is not acceptable XML: ${(e as Error).message}`);
    }
    if (doc.root.ns !== NS.samlp || doc.root.local !== 'Response') throw new SamlError('format', 'the document is not a samlp:Response');
    const vo = { certificates: c.idp.certificates, after: { ns: NS.saml, local: 'Issuer' }, now: c.now, allowSha1: !!c.allowSha1 } as const;
    const wrap = (f: () => Verified): Verified => {
      try {
        return f();
      } catch (e) {
        if (e instanceof XmlDsigError) throw new SamlError('signature', e.message);
        throw e;
      }
    };
    const signed: ('response' | 'assertion')[] = [];
    let work: Doc = doc;
    let env: XEl = doc.root;
    if (childNamed(doc.root, NS_DSIG, 'Signature')) {
      const v = wrap(() => verifyElement(doc, doc.root, vo));
      // from here on, everything comes from the digested bytes
      work = readXml(v.canonical);
      env = work.root;
      signed.push('response');
    }
    // no encrypted parts
    for (const e of childEls(env)) if (e.ns === NS.saml && e.local === 'EncryptedAssertion') throw new SamlError('unsupported', 'encrypted assertions are not supported');
    const assertions = childrenNamed(env, NS.saml, 'Assertion');
    if (assertions.length !== 1) throw new SamlError('assertion', `expected exactly one Assertion, found ${assertions.length}`);
    let a = assertions[0]!;
    if (childNamed(a, NS_DSIG, 'Signature')) {
      const v = wrap(() => verifyElement(work, a, vo));
      a = readXml(v.canonical).root;
      signed.push('assertion');
    }
    if (!signed.length) throw new SamlError('signature', 'neither the Response nor the Assertion is signed');
    // response-level checks, from signed material only when the response is signed
    const respSigned = signed.includes('response');
    const status = childNamed(env, NS.samlp, 'Status');
    const code = status && childNamed(status, NS.samlp, 'StatusCode');
    if (attr(code ?? env, 'Value') !== STATUS_SUCCESS) throw new SamlError('status', `the IdP did not report success: ${(attr(code ?? env, 'Value') ?? 'no status').split(':').pop()}`);
    if (respSigned) {
      const dest = attr(env, 'Destination');
      if (dest !== c.acsUrl) throw new SamlError('destination', 'the Destination is not our assertion consumer URL');
      const ri = childNamed(env, NS.saml, 'Issuer');
      if (ri && textOf(ri).trim() !== c.idp.entityId) throw new SamlError('issuer', 'the Response issuer is not the IdP');
    } else if (attr(env, 'Destination') !== undefined && attr(env, 'Destination') !== c.acsUrl) throw new SamlError('destination', 'the Destination is not our assertion consumer URL');
    // assertion
    if (attr(a, 'Version') !== '2.0') throw new SamlError('assertion', 'the Assertion is not SAML 2.0');
    const assertionId = attr(a, 'ID');
    if (!assertionId) throw new SamlError('assertion', 'the Assertion has no ID');
    const iss = childNamed(a, NS.saml, 'Issuer');
    if (!iss || textOf(iss).trim() !== c.idp.entityId) throw new SamlError('issuer', 'the Assertion issuer is not the IdP');
    const issueInstant = parseTime(attr(a, 'IssueInstant'), 'IssueInstant');
    if (issueInstant > now + skew) throw new SamlError('time', 'the Assertion was issued in the future');
    // subject
    const subject = childNamed(a, NS.saml, 'Subject');
    if (!subject) throw new SamlError('subject', 'the Assertion has no Subject');
    if (childNamed(subject, NS.saml, 'EncryptedID')) throw new SamlError('unsupported', 'encrypted NameIDs are not supported');
    const nameIdEl = childNamed(subject, NS.saml, 'NameID');
    const nameId = nameIdEl ? textOf(nameIdEl).trim() : '';
    if (!nameId) throw new SamlError('subject', 'the Subject has no NameID');
    const confirmations = childrenNamed(subject, NS.saml, 'SubjectConfirmation').filter((s) => attr(s, 'Method') === CM_BEARER);
    let inResponseTo: string | undefined;
    let confirmedUntil = Infinity;
    let good = false;
    let lastWhy = 'the Subject has no bearer confirmation';
    for (const sc of confirmations) {
      const d = childNamed(sc, NS.saml, 'SubjectConfirmationData');
      if (!d) {
        lastWhy = 'the bearer confirmation has no data';
        continue;
      }
      if (attr(d, 'Recipient') !== c.acsUrl) {
        lastWhy = 'the Recipient is not our assertion consumer URL';
        continue;
      }
      if (attr(d, 'NotBefore') !== undefined) {
        lastWhy = 'a bearer confirmation must not carry NotBefore';
        continue;
      }
      const until = parseTime(attr(d, 'NotOnOrAfter'), 'SubjectConfirmationData NotOnOrAfter');
      if (until + skew <= now) {
        lastWhy = 'the bearer confirmation has expired';
        continue;
      }
      inResponseTo = attr(d, 'InResponseTo');
      confirmedUntil = until;
      good = true;
      break;
    }
    if (!good) throw new SamlError('confirmation', lastWhy);
    // request correlation
    const respIrt = respSigned ? attr(env, 'InResponseTo') : undefined;
    if (respIrt !== undefined && inResponseTo !== undefined && respIrt !== inResponseTo) throw new SamlError('in-response-to', 'the Response and the Assertion answer different requests');
    const irt = inResponseTo ?? respIrt;
    let pending: PendingRequest | undefined;
    if (irt === undefined) {
      if (!c.allowIdpInitiated) throw new SamlError('in-response-to', 'the response answers no request of ours (IdP-initiated login is off)');
    } else {
      pending = this.#requests.take(irt, now);
      if (!pending) throw new SamlError('in-response-to', 'the response answers an unknown, expired or already used request');
    }
    // conditions
    const cond = childNamed(a, NS.saml, 'Conditions');
    if (!cond) throw new SamlError('conditions', 'the Assertion has no Conditions');
    const nb = attr(cond, 'NotBefore');
    const noa = attr(cond, 'NotOnOrAfter');
    if (nb !== undefined && parseTime(nb, 'NotBefore') > now + skew) throw new SamlError('time', 'the Assertion is not valid yet');
    if (noa === undefined) throw new SamlError('conditions', 'the Conditions have no NotOnOrAfter');
    const condEnd = parseTime(noa, 'NotOnOrAfter');
    if (condEnd + skew <= now) throw new SamlError('time', 'the Assertion has expired');
    let audienceRestrictions = 0;
    for (const k of childEls(cond)) {
      if (k.ns === NS.saml && k.local === 'AudienceRestriction') {
        audienceRestrictions++;
        if (!childrenNamed(k, NS.saml, 'Audience').some((x) => textOf(x).trim() === c.entityId)) throw new SamlError('audience', 'the Assertion is meant for another audience');
      } else if (k.ns === NS.saml && k.local === 'OneTimeUse') continue;
      else throw new SamlError('conditions', `unknown condition <${k.local}>`);
    }
    if (!audienceRestrictions) throw new SamlError('audience', 'the Assertion has no AudienceRestriction');
    // authentication
    const authn = childNamed(a, NS.saml, 'AuthnStatement');
    if (!authn) throw new SamlError('authn', 'the Assertion has no AuthnStatement');
    const authnInstant = parseTime(attr(authn, 'AuthnInstant'), 'AuthnInstant');
    if (authnInstant > now + skew) throw new SamlError('time', 'AuthnInstant is in the future');
    if (c.maxAuthAgeSeconds !== undefined && now - authnInstant > c.maxAuthAgeSeconds * 1000 + skew) throw new SamlError('time', 'the user authenticated too long ago');
    if (pending?.forceAuthn && authnInstant + skew < pending.issuedAt) throw new SamlError('time', 'ForceAuthn was asked for but the authentication is older than the request');
    const sna = attr(authn, 'SessionNotOnOrAfter');
    const sessionNotOnOrAfter = sna !== undefined ? parseTime(sna, 'SessionNotOnOrAfter') : undefined;
    if (sessionNotOnOrAfter !== undefined && sessionNotOnOrAfter + skew <= now) throw new SamlError('time', 'the IdP session has already ended');
    const ctx = childNamed(authn, NS.saml, 'AuthnContext');
    const classRef = ctx && childNamed(ctx, NS.saml, 'AuthnContextClassRef');
    // replay: after every other check, so a bad message never uses up an ID
    const until = Math.min(confirmedUntil, condEnd) + skew;
    if (this.#replay.seen(assertionId, until, now)) throw new SamlError('replay', 'this assertion has already been used');
    const attributes: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
    for (const st of childrenNamed(a, NS.saml, 'AttributeStatement')) {
      if (childNamed(st, NS.saml, 'EncryptedAttribute')) throw new SamlError('unsupported', 'encrypted attributes are not supported');
      for (const at of childrenNamed(st, NS.saml, 'Attribute')) {
        const name = attr(at, 'Name');
        if (!name) continue;
        (attributes[name] ??= []).push(...childrenNamed(at, NS.saml, 'AttributeValue').map((v) => textOf(v).trim()));
      }
    }
    return {
      nameId,
      nameIdFormat: nameIdEl ? attr(nameIdEl, 'Format') : undefined,
      sessionIndex: attr(authn, 'SessionIndex'),
      attributes,
      authnInstant,
      authnContext: classRef ? textOf(classRef).trim() : undefined,
      sessionNotOnOrAfter,
      assertionId,
      issuer: c.idp.entityId,
      inResponseTo: irt,
      relayState: pending?.relayState ?? relayState,
      signed,
    };
  }

  /** Our metadata for the IdP administrator. */
  metadata(o: { validUntilMs?: number; organization?: { name: string; url: string }; wantAssertionsSigned?: boolean } = {}): string {
    const c = this.#c;
    return spMetadata({ entityId: c.entityId, acsUrl: c.acsUrl, ...(c.signingCertificate ? { signingCertificate: c.signingCertificate } : {}), authnRequestsSigned: !!c.signingKey, nameIdFormats: [c.nameIdFormat ?? NAMEID.unspecified], ...o });
  }
}

// ---------------------------------------------------------------- redirect binding helpers

/** Reads a redirect-binding SAMLRequest/SAMLResponse parameter: base64, raw deflate, with a cap on the inflated size. */
export function inflateRedirect(param: string, maxBytes = 1_000_000): string {
  const raw = Buffer.from(param, 'base64');
  try {
    return inflateRawSync(raw, { maxOutputLength: maxBytes }).toString('utf8');
  } catch {
    throw new SamlError('format', 'the message is not valid deflate data, or inflates beyond the limit');
  }
}

/** Verifies the query-string signature of a redirect-binding message against a trusted key or certificate. */
export function verifyRedirectSignature(rawQuery: string, trusted: { key?: KeyObject | string; certificate?: string }): boolean {
  const parts = rawQuery.split('&');
  const get = (n: string) => parts.find((p) => p.startsWith(`${n}=`));
  const msg = get('SAMLRequest') ?? get('SAMLResponse');
  const sig = get('Signature');
  const alg = get('SigAlg');
  if (!msg || !sig || !alg) return false;
  const signedPart = [msg, get('RelayState'), alg].filter(Boolean).join('&');
  const algUri = decodeURIComponent(alg.slice(7));
  const map: Record<string, ['sha256' | 'sha384' | 'sha512', boolean]> = {
    'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256': ['sha256', false],
    'http://www.w3.org/2001/04/xmldsig-more#rsa-sha384': ['sha384', false],
    'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512': ['sha512', false],
    'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256': ['sha256', true],
  };
  const m = map[algUri];
  if (!m) return false;
  const key = trusted.certificate ? new X509Certificate(trusted.certificate).publicKey : typeof trusted.key === 'string' ? createPublicKey(trusted.key) : trusted.key;
  if (!key || key.asymmetricKeyType !== (m[1] ? 'ec' : 'rsa')) return false;
  const v = createVerify(m[0]).update(signedPart);
  const value = Buffer.from(decodeURIComponent(sig.slice(10)), 'base64');
  return m[1] ? v.verify({ key, dsaEncoding: 'ieee-p1363' }, value) : v.verify(key, value);
}

// ---------------------------------------------------------------- metadata

const certB64 = (pem: string) => new X509Certificate(pem).raw.toString('base64');
const toPem = (b64: string) => `-----BEGIN CERTIFICATE-----\n${b64.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').trimEnd()}\n-----END CERTIFICATE-----\n`;

export interface SpMetadataOptions {
  readonly entityId: string;
  readonly acsUrl: string;
  readonly signingCertificate?: string;
  readonly authnRequestsSigned?: boolean;
  readonly wantAssertionsSigned?: boolean;
  readonly nameIdFormats?: readonly string[];
  readonly validUntilMs?: number;
  readonly organization?: { readonly name: string; readonly url: string };
}

export function spMetadata(o: SpMetadataOptions): string {
  const kd = o.signingCertificate ? `<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="${NS_DSIG}"><ds:X509Data><ds:X509Certificate>${certB64(o.signingCertificate)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` : '';
  const fmts = (o.nameIdFormats ?? []).map((f) => `<md:NameIDFormat>${escapeXml(f)}</md:NameIDFormat>`).join('');
  const org = o.organization ? `<md:Organization><md:OrganizationName xml:lang="en">${escapeXml(o.organization.name)}</md:OrganizationName><md:OrganizationDisplayName xml:lang="en">${escapeXml(o.organization.name)}</md:OrganizationDisplayName><md:OrganizationURL xml:lang="en">${escapeXml(o.organization.url)}</md:OrganizationURL></md:Organization>` : '';
  return (
    `<md:EntityDescriptor xmlns:md="${NS.md}" entityID="${escapeXml(o.entityId)}"${o.validUntilMs !== undefined ? ` validUntil="${formatTime(o.validUntilMs)}"` : ''}>` +
    `<md:SPSSODescriptor AuthnRequestsSigned="${!!o.authnRequestsSigned}" WantAssertionsSigned="${o.wantAssertionsSigned ?? true}" protocolSupportEnumeration="${NS.samlp}">` +
    `${kd}${fmts}<md:AssertionConsumerService Binding="${BINDING.post}" Location="${escapeXml(o.acsUrl)}" index="0" isDefault="true"/></md:SPSSODescriptor>${org}</md:EntityDescriptor>`
  );
}

export interface IdpMetadata {
  readonly entityId: string;
  readonly sso: readonly { readonly binding: string; readonly location: string }[];
  readonly certificates: readonly string[];
  readonly validUntil: number | undefined;
  readonly signed: boolean;
}

export interface ParseIdpOptions {
  /** Certificates that must have signed the metadata. */
  readonly pinned?: readonly string[];
  /** Accept unsigned metadata (for example fetched over a channel you trust some other way). */
  readonly allowUnsigned?: boolean;
  readonly now: () => number;
}

export function parseIdpMetadata(xml: string, o: ParseIdpOptions): IdpMetadata {
  let doc = readXml(xml);
  if (doc.root.ns === NS.md && doc.root.local === 'EntitiesDescriptor') throw new SamlError('unsupported', 'EntitiesDescriptor federations are not supported: pass one EntityDescriptor');
  if (doc.root.ns !== NS.md || doc.root.local !== 'EntityDescriptor') throw new SamlError('format', 'not a metadata EntityDescriptor');
  let signed = false;
  if (o.pinned?.length) {
    try {
      const v = verifyElement(doc, doc.root, { certificates: o.pinned, now: o.now });
      doc = readXml(v.canonical);
      signed = true;
    } catch (e) {
      throw new SamlError('signature', `the metadata is not signed by a pinned certificate: ${(e as Error).message}`);
    }
  } else if (!o.allowUnsigned) throw new SamlError('signature', 'metadata must be verified: give pinned certificates, or allowUnsigned to accept it as is');
  const root = doc.root;
  const entityId = attr(root, 'entityID');
  if (!entityId) throw new SamlError('format', 'the EntityDescriptor has no entityID');
  const vu = attr(root, 'validUntil');
  const validUntil = vu !== undefined ? parseTime(vu, 'validUntil') : undefined;
  if (validUntil !== undefined && validUntil <= o.now()) throw new SamlError('time', 'the metadata has expired (validUntil is in the past)');
  const idp = childNamed(root, NS.md, 'IDPSSODescriptor');
  if (!idp) throw new SamlError('format', 'no IDPSSODescriptor');
  const sso = childrenNamed(idp, NS.md, 'SingleSignOnService').map((s) => ({ binding: attr(s, 'Binding') ?? '', location: attr(s, 'Location') ?? '' })).filter((s) => s.binding && /^https:\/\//.test(s.location));
  if (!sso.length) throw new SamlError('format', 'no https SingleSignOnService');
  const certificates: string[] = [];
  for (const kd of childrenNamed(idp, NS.md, 'KeyDescriptor')) {
    const use = attr(kd, 'use');
    if (use !== undefined && use !== 'signing') continue;
    const ki = childNamed(kd, NS_DSIG, 'KeyInfo');
    const x = ki && childNamed(ki, NS_DSIG, 'X509Data');
    for (const c of x ? childrenNamed(x, NS_DSIG, 'X509Certificate') : []) {
      const pem = toPem(textOf(c));
      try {
        new X509Certificate(pem);
        certificates.push(pem);
      } catch {
        throw new SamlError('format', 'a certificate in the metadata cannot be read');
      }
    }
  }
  if (!certificates.length) throw new SamlError('format', 'no signing certificate in the metadata');
  return { entityId, sso, certificates, validUntil, signed };
}
