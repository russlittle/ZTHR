/**
 * XML Signature (XML-DSig) for the enveloped signatures SAML and similar protocols use, built to resist signature
 * wrapping. Holds: a lossless XML reader (keeps prefixes and namespace declarations, merges the text around comments so
 * a comment cannot split a value, refuses DOCTYPE, entities and processing instructions, rejects duplicate ID values,
 * caps size, depth and node count); Exclusive XML Canonicalization 1.0 without comments (with InclusiveNamespaces
 * PrefixList and subtree output), checked against xmllint --exc-c14n in the tests; `verifyElement`, which checks one
 * signature over one element; and `sign`, which adds an enveloped signature at a stated position.
 *
 * What verification insists on, because each is a known way to get a forged document accepted: the signature is a
 * direct child of the element it protects, in the stated position (after Issuer, say); that element is what its single
 * Reference points at (same-document "#id" or "" only, never a URL); IDs are unique in the whole document; only
 * exclusive c14n, enveloped-signature and an allow-list of digest and signature algorithms are accepted (SHA-1 and HMAC
 * are not, unless SHA-1 is allowed on purpose); the key comes from the caller's pinned keys or certificates, and a
 * certificate in KeyInfo counts only if it is byte-identical to a pinned one; the key type must match the algorithm
 * (an RSA algorithm does not take an EC key, nor the reverse) with RSA at 2048 bits or more; digests and signatures are
 * compared in constant time. The result carries the signed element re-read from the exact canonical bytes that were
 * digested: read the assertion data from `element`, never from the original document, and a second copy of an
 * element elsewhere in the message cannot matter.
 *
 * The dav block's reader drops prefixes and mixed content, which canonicalisation needs, so the reader here is its own;
 * dav supplies the error base class and the escaping used for the signature template. Out of scope: inclusive c14n
 * (1.0 and 1.1), WithComments variants, XPath and XSLT transforms, base64 and decryption transforms, detached
 * and enveloping signatures over other documents (`allowTarget` can allow another element of the same one), DSA, HMAC,
 * KeyValue and retrieval methods, and xml:* attribute inheritance (exclusive c14n does not inherit them).
 */
import { createHash, createPrivateKey, createPublicKey, createVerify, createSign, timingSafeEqual, X509Certificate, type KeyObject } from 'node:crypto';
import { BadXml, escapeXml } from '../dav/index.ts';

export const NS_DSIG = 'http://www.w3.org/2000/09/xmldsig#';
export const NS_EXC = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

export const ALG = {
  excC14n: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  enveloped: 'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
  sha1: 'http://www.w3.org/2000/09/xmldsig#sha1',
  sha256: 'http://www.w3.org/2001/04/xmlenc#sha256',
  sha384: 'http://www.w3.org/2001/04/xmldsig-more#sha384',
  sha512: 'http://www.w3.org/2001/04/xmlenc#sha512',
  rsaSha1: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
  rsaSha256: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  rsaSha384: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha384',
  rsaSha512: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512',
  ecdsaSha256: 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256',
  ecdsaSha384: 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha384',
  ecdsaSha512: 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512',
} as const;

const DIGESTS: Record<string, { node: string; sha1?: boolean }> = {
  [ALG.sha1]: { node: 'sha1', sha1: true },
  [ALG.sha256]: { node: 'sha256' },
  [ALG.sha384]: { node: 'sha384' },
  [ALG.sha512]: { node: 'sha512' },
};
const SIGNATURES: Record<string, { node: string; kind: 'rsa' | 'ec'; sha1?: boolean }> = {
  [ALG.rsaSha1]: { node: 'sha1', kind: 'rsa', sha1: true },
  [ALG.rsaSha256]: { node: 'sha256', kind: 'rsa' },
  [ALG.rsaSha384]: { node: 'sha384', kind: 'rsa' },
  [ALG.rsaSha512]: { node: 'sha512', kind: 'rsa' },
  [ALG.ecdsaSha256]: { node: 'sha256', kind: 'ec' },
  [ALG.ecdsaSha384]: { node: 'sha384', kind: 'ec' },
  [ALG.ecdsaSha512]: { node: 'sha512', kind: 'ec' },
};

export class XmlDsigError extends BadXml {
  constructor(why: string) {
    super(why);
    this.name = 'XmlDsigError';
  }
}

// ---------------------------------------------------------------- the lossless reader

export interface XAttr {
  readonly prefix: string;
  readonly local: string;
  readonly ns: string;
  readonly value: string;
}
export interface XEl {
  readonly kind: 'el';
  readonly prefix: string;
  readonly local: string;
  readonly ns: string;
  readonly attrs: XAttr[];
  /** Namespace declarations made on this element: [prefix, uri], prefix '' for the default namespace. */
  readonly decls: [string, string][];
  children: XNode[];
  parent: XEl | undefined;
  /** Offsets into the normalised source: start of "<", just after the start tag, and just after the end tag. */
  readonly span: { start: number; open: number; end: number };
}
export interface XText {
  readonly kind: 'text';
  text: string;
  parent: XEl | undefined;
}
export type XNode = XEl | XText;

export interface Doc {
  readonly root: XEl;
  /** The source after line-ending normalisation, which the offsets in `span` refer to. */
  readonly source: string;
  readonly ids: ReadonlyMap<string, XEl>;
}

export interface ReadLimits {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly idAttributes?: readonly string[];
}

const NAME = /^[\p{L}_][\p{L}\p{N}._-]*$/u;
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const isWs = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const validChar = (cp: number) => cp === 9 || cp === 10 || cp === 13 || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);

function unescapeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(?:(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);)?/g, (_m, e: string | undefined) => {
    if (e === undefined) throw new XmlDsigError('a bare & in the text');
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!validChar(cp)) throw new XmlDsigError('a character reference names a character XML does not allow');
      return String.fromCodePoint(cp);
    }
    const r = NAMED[e];
    if (r === undefined) throw new XmlDsigError(`the entity &${e}; is not defined`);
    return r;
  });
}

export function readXml(input: string, lim: ReadLimits = {}): Doc {
  const maxBytes = lim.maxBytes ?? 1_000_000;
  if (input.length > maxBytes || Buffer.byteLength(input, 'utf8') > maxBytes) throw new XmlDsigError('document too large');
  const maxDepth = lim.maxDepth ?? 100;
  const maxNodes = lim.maxNodes ?? 100_000;
  const idNames = new Set(lim.idAttributes ?? ['ID', 'Id', 'id']);
  let src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  src = src.replace(/\r\n?/g, '\n');
  if (/<!DOCTYPE|<!ENTITY|<!ELEMENT|<!ATTLIST/i.test(src)) throw new XmlDsigError('document type declarations are not accepted');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(src)) throw new XmlDsigError('control characters are not allowed in XML');
  let i = 0;
  if (src.startsWith('<?xml') && isWs(src[5])) {
    const e = src.indexOf('?>');
    if (e < 0) throw new XmlDsigError('unclosed XML declaration');
    i = e + 2;
  }
  const stack: XEl[] = [];
  let root: XEl | undefined;
  let nodes = 0;
  const ids = new Map<string, XEl>();
  const scopeOf = (e: XEl | undefined): Map<string, string> => {
    const m = new Map<string, string>([['xml', XML_NS]]);
    const chain: XEl[] = [];
    for (let x = e; x; x = x.parent) chain.unshift(x);
    for (const x of chain) for (const [p, u] of x.decls) m.set(p, u);
    return m;
  };
  const addText = (t: string) => {
    if (!t) return;
    const top = stack.at(-1);
    if (!top) {
      if (t.trim()) throw new XmlDsigError('text outside the root element');
      return;
    }
    const last = top.children.at(-1);
    if (last?.kind === 'text') last.text += t;
    else {
      if (++nodes > maxNodes) throw new XmlDsigError('too many nodes');
      top.children.push({ kind: 'text', text: t, parent: top });
    }
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      addText(unescapeXml(src.slice(i)));
      break;
    }
    if (lt > i) addText(unescapeXml(src.slice(i, lt)));
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      if (e < 0) throw new XmlDsigError('unclosed comment');
      if (src.slice(lt + 4, e).includes('--')) throw new XmlDsigError('"--" inside a comment');
      i = e + 3; // dropped: the text on both sides merges in addText
    } else if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt);
      if (e < 0) throw new XmlDsigError('unclosed CDATA');
      if (!stack.length) throw new XmlDsigError('text outside the root element');
      addText(src.slice(lt + 9, e));
      i = e + 3;
    } else if (src.startsWith('<?', lt)) {
      throw new XmlDsigError('processing instructions are not accepted');
    } else if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt);
      if (e < 0) throw new XmlDsigError('unclosed end tag');
      const name = src.slice(lt + 2, e).trimEnd();
      const top = stack.pop();
      if (!top || (top.prefix ? `${top.prefix}:${top.local}` : top.local) !== name) throw new XmlDsigError(`unexpected </${name.slice(0, 40)}>`);
      (top.span as { end: number }).end = e + 1;
      i = e + 1;
    } else {
      if (!stack.length && root) throw new XmlDsigError('more than one root element');
      let j = lt + 1;
      let q = '';
      for (; j < src.length; j++) {
        const c = src[j]!;
        if (q) {
          if (c === q) q = '';
        } else if (c === '"' || c === "'") q = c;
        else if (c === '>') break;
      }
      if (j >= src.length) throw new XmlDsigError('unclosed start tag');
      let inner = src.slice(lt + 1, j);
      const selfClose = inner.endsWith('/');
      if (selfClose) inner = inner.slice(0, -1);
      let n = 0;
      while (n < inner.length && !isWs(inner[n])) n++;
      const qname = inner.slice(0, n);
      const raw: [string, string][] = [];
      let p = n;
      const seen = new Set<string>();
      for (;;) {
        while (isWs(inner[p])) p++;
        if (p >= inner.length) break;
        const m = /^([^\s=<>"'/]+)\s*=\s*("([^"]*)"|'([^']*)')/.exec(inner.slice(p));
        if (!m) throw new XmlDsigError(`the attributes of <${qname.slice(0, 40)}> are not well formed`);
        const val = m[3] ?? m[4] ?? '';
        if (val.includes('<')) throw new XmlDsigError('"<" inside an attribute value');
        if (seen.has(m[1]!)) throw new XmlDsigError(`the attribute ${m[1]} is given twice`);
        seen.add(m[1]!);
        // attribute-value normalisation: literal whitespace becomes a space, character references stay as they are
        raw.push([m[1]!, unescapeAttr(val)]);
        p += m[0].length;
        if (p < inner.length && !isWs(inner[p])) throw new XmlDsigError('attributes must be separated by white space');
      }
      const colon = qname.indexOf(':');
      const prefix = colon < 0 ? '' : qname.slice(0, colon);
      const local = colon < 0 ? qname : qname.slice(colon + 1);
      if (!NAME.test(local) || (prefix && !NAME.test(prefix)) || qname.split(':').length > 2) throw new XmlDsigError(`${JSON.stringify(qname.slice(0, 40))} is not an element name`);
      const decls: [string, string][] = [];
      const plain: [string, string][] = [];
      for (const [k, v] of raw) {
        if (k === 'xmlns') decls.push(['', v]);
        else if (k.startsWith('xmlns:')) {
          const pf = k.slice(6);
          if (!v || pf === 'xmlns' || (pf === 'xml') !== (v === XML_NS)) throw new XmlDsigError(`invalid namespace declaration for ${pf}`);
          decls.push([pf, v]);
        } else plain.push([k, v]);
      }
      const parent = stack.at(-1);
      if (stack.length >= maxDepth) throw new XmlDsigError('nested too deeply');
      if (++nodes > maxNodes) throw new XmlDsigError('too many nodes');
      const el: XEl = { kind: 'el', prefix, local, ns: '', attrs: [], decls, children: [], parent, span: { start: lt, open: j + 1, end: j + 1 } };
      const scope = scopeOf(el);
      const ns = prefix ? scope.get(prefix) : (scope.get('') ?? '');
      if (ns === undefined) throw new XmlDsigError(`undeclared prefix ${prefix}`);
      (el as { ns: string }).ns = ns;
      const aseen = new Set<string>();
      for (const [k, v] of plain) {
        const c = k.indexOf(':');
        const ap = c < 0 ? '' : k.slice(0, c);
        const al = c < 0 ? k : k.slice(c + 1);
        if (!NAME.test(al) || (ap && !NAME.test(ap))) throw new XmlDsigError(`${JSON.stringify(k.slice(0, 40))} is not an attribute name`);
        const ans = ap ? scope.get(ap) : '';
        if (ans === undefined) throw new XmlDsigError(`undeclared prefix ${ap}`);
        const key = `{${ans}}${al}`;
        if (aseen.has(key)) throw new XmlDsigError(`the attribute ${k} is given twice`);
        aseen.add(key);
        el.attrs.push({ prefix: ap, local: al, ns: ans, value: v });
        if (!ap && idNames.has(al)) {
          if (ids.has(v)) throw new XmlDsigError(`the ID ${JSON.stringify(v.slice(0, 40))} appears more than once`);
          ids.set(v, el);
        }
      }
      if (parent) parent.children.push(el);
      else root = el;
      if (selfClose) (el.span as { end: number }).end = j + 1;
      else stack.push(el);
      i = j + 1;
    }
  }
  if (stack.length) throw new XmlDsigError('an element is not closed');
  if (!root) throw new XmlDsigError('no root element');
  return { root, source: src, ids };
}

function unescapeAttr(v: string): string {
  // literal tab, newline and carriage return become a space; &#x9; and friends survive
  const parts = v.split(/(&#x?[0-9A-Fa-f]+;)/);
  return parts.map((p, k) => (k % 2 ? unescapeXml(p) : unescapeXml(p.replace(/[\t\n]/g, ' ')))).join('');
}

// ---------------------------------------------------------------- navigation

export const childEls = (e: XEl): XEl[] => e.children.filter((c): c is XEl => c.kind === 'el');
export const childNamed = (e: XEl, ns: string, local: string): XEl | undefined => childEls(e).find((c) => c.ns === ns && c.local === local);
export const childrenNamed = (e: XEl, ns: string, local: string): XEl[] => childEls(e).filter((c) => c.ns === ns && c.local === local);
export const textOf = (e: XEl): string => e.children.map((c) => (c.kind === 'text' ? c.text : textOf(c))).join('');
export const attr = (e: XEl, local: string): string | undefined => e.attrs.find((a) => a.local === local && a.ns === '')?.value;
export function* descendants(e: XEl): Generator<XEl> {
  yield e;
  for (const c of childEls(e)) yield* descendants(c);
}
export const isInside = (node: XEl, ancestor: XEl): boolean => {
  for (let x: XEl | undefined = node; x; x = x.parent) if (x === ancestor) return true;
  return false;
};

function inScope(e: XEl): Map<string, string> {
  const chain: XEl[] = [];
  for (let x: XEl | undefined = e; x; x = x.parent) chain.unshift(x);
  const m = new Map<string, string>();
  for (const x of chain) for (const [p, u] of x.decls) m.set(p, u);
  return m;
}

// ---------------------------------------------------------------- exclusive canonicalisation

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');

export interface C14nOptions {
  /** The InclusiveNamespaces PrefixList: prefixes ("#default" for the default namespace) treated inclusively. */
  readonly inclusivePrefixes?: readonly string[];
  /** Elements left out of the output together with their content (the enveloped-signature transform). */
  readonly exclude?: ReadonlySet<XEl>;
}

/** Exclusive Canonical XML 1.0 (without comments) of the subtree at `el`. */
export function exclusiveC14n(el: XEl, o: C14nOptions = {}): string {
  const inc = new Set((o.inclusivePrefixes ?? []).map((p) => (p === '#default' ? '' : p)));
  const out: string[] = [];
  const walk = (e: XEl, rendered: ReadonlyMap<string, string>): void => {
    if (o.exclude?.has(e)) return;
    const scope = inScope(e);
    const utilized = new Set<string>([e.prefix]);
    for (const a of e.attrs) if (a.prefix && a.prefix !== 'xml') utilized.add(a.prefix);
    for (const p of inc) if (scope.has(p) || p === '') utilized.add(p);
    const decls: [string, string][] = [];
    for (const p of utilized) {
      if (p === 'xml') continue;
      const uri = scope.get(p);
      if (p === '') {
        const want = uri ?? '';
        if ((rendered.get('') ?? '') !== want) decls.push(['', want]);
      } else if (uri !== undefined && rendered.get(p) !== uri) decls.push([p, uri]);
    }
    decls.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const next = new Map(rendered);
    for (const [p, u] of decls) next.set(p, u);
    const attrs = [...e.attrs].sort((a, b) => (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : a.local < b.local ? -1 : a.local > b.local ? 1 : 0));
    const name = e.prefix ? `${e.prefix}:${e.local}` : e.local;
    let s = `<${name}`;
    for (const [p, u] of decls) s += p ? ` xmlns:${p}="${escAttr(u)}"` : ` xmlns="${escAttr(u)}"`;
    for (const a of attrs) s += ` ${a.prefix ? `${a.prefix}:` : ''}${a.local}="${escAttr(a.value)}"`;
    out.push(`${s}>`);
    for (const c of e.children) {
      if (c.kind === 'text') out.push(escText(c.text));
      else walk(c, next);
    }
    out.push(`</${name}>`);
  };
  walk(el, new Map());
  return out.join('');
}

// ---------------------------------------------------------------- verification

export interface KeyOptions {
  /** Trusted public keys (KeyObject or PEM). */
  readonly keys?: readonly (KeyObject | string)[];
  /** Pinned certificates (PEM). A certificate in KeyInfo is used only if it is byte-identical to one of these. */
  readonly certificates?: readonly string[];
  /** Check notBefore/notAfter of the certificate used (default true). */
  readonly checkValidity?: boolean;
  readonly now?: () => number;
}

export interface VerifyOptions extends KeyOptions {
  /** Where the signature must sit: immediately after this element, or first among the children when it is absent. */
  readonly after?: { readonly ns: string; readonly local: string };
  readonly allowSha1?: boolean;
  /** Allow the Reference to point at another element of the same document than the signature's parent. */
  readonly allowTarget?: (target: XEl, signature: XEl) => boolean;
  readonly minRsaBits?: number;
}

export interface Verified {
  /** The element the signature covers, in the original document. */
  readonly signed: XEl;
  /** The canonical bytes that were digested. */
  readonly canonical: string;
  /** The signed element read again from `canonical`: take the data from here. */
  readonly element: XEl;
  readonly signatureAlgorithm: string;
  readonly digestAlgorithm: string;
  /** SHA-256 of the signing certificate or key, hex, for logging and pin comparison. */
  readonly keyFingerprint: string;
}

const b64decode = (s: string, what: string): Buffer => {
  const t = s.replace(/\s+/g, '');
  if (!t || !/^[A-Za-z0-9+/]+={0,2}$/.test(t) || t.length % 4 !== 0) throw new XmlDsigError(`${what} is not valid base64`);
  return Buffer.from(t, 'base64');
};

function prefixList(method: XEl): string[] {
  const inc = childEls(method).filter((c) => c.local === 'InclusiveNamespaces');
  if (inc.length > 1) throw new XmlDsigError('more than one InclusiveNamespaces');
  if (!inc.length) return [];
  if (inc[0]!.ns !== NS_EXC) throw new XmlDsigError('InclusiveNamespaces is in the wrong namespace');
  return (attr(inc[0]!, 'PrefixList') ?? '').split(/\s+/).filter(Boolean);
}

const fingerprint = (der: Buffer) => createHash('sha256').update(der).digest('hex');

function candidateKeys(sig: XEl, o: KeyOptions, kind: 'rsa' | 'ec'): { key: KeyObject; fp: string }[] {
  const out: { key: KeyObject; fp: string }[] = [];
  const now = o.now?.() ?? Date.now();
  const pinned = (o.certificates ?? []).map((pem) => new X509Certificate(pem));
  const fromKeyInfo = childNamed(sig, NS_DSIG, 'KeyInfo');
  const certs: X509Certificate[] = [];
  if (fromKeyInfo) {
    for (const x of descendants(fromKeyInfo)) {
      if (x.ns === NS_DSIG && x.local === 'X509Certificate') {
        const der = b64decode(textOf(x), 'X509Certificate');
        const match = pinned.find((p) => p.raw.equals(der));
        if (match) certs.push(match);
      }
    }
  }
  // With pinned certificates and none named in KeyInfo, those certificates are the candidates.
  const use = certs.length ? certs : pinned;
  for (const c of use) {
    if (o.checkValidity !== false) {
      const from = Date.parse(c.validFrom);
      const to = Date.parse(c.validTo);
      if (now < from || now > to) continue;
    }
    out.push({ key: c.publicKey, fp: fingerprint(c.raw) });
  }
  for (const k of o.keys ?? []) {
    const key = typeof k === 'string' ? createPublicKey(k) : k.type === 'private' ? createPublicKey(k) : k;
    out.push({ key, fp: fingerprint(key.export({ type: 'spki', format: 'der' }) as Buffer) });
  }
  return out.filter(({ key }) => key.asymmetricKeyType === (kind === 'rsa' ? 'rsa' : 'ec'));
}

/**
 * Verifies the one signature that protects `target`. Throws XmlDsigError on any failure and never returns partial
 * results: the caller gets a Verified or an exception.
 */
export function verifyElement(doc: Doc, target: XEl, o: VerifyOptions): Verified {
  const sigs = childrenNamed(target, NS_DSIG, 'Signature');
  if (!sigs.length) throw new XmlDsigError(`<${target.local}> is not signed`);
  if (sigs.length > 1) throw new XmlDsigError(`<${target.local}> has more than one Signature`);
  const sig = sigs[0]!;
  // position
  const kids = childEls(target);
  const at = kids.indexOf(sig);
  if (o.after) {
    const prev = kids[at - 1];
    const issuerPresent = kids.some((k) => k.ns === o.after!.ns && k.local === o.after!.local);
    if (issuerPresent ? !(prev && prev.ns === o.after.ns && prev.local === o.after.local) : at !== 0) throw new XmlDsigError(`the Signature is not in its required position (after ${o.after.local})`);
  }
  // structure
  const parts = childEls(sig);
  for (const c of parts) if (c.ns !== NS_DSIG || !['SignedInfo', 'SignatureValue', 'KeyInfo'].includes(c.local)) throw new XmlDsigError(`unexpected <${c.local}> in the Signature`);
  const si = parts.filter((c) => c.local === 'SignedInfo');
  const sv = parts.filter((c) => c.local === 'SignatureValue');
  if (si.length !== 1 || sv.length !== 1 || parts.filter((c) => c.local === 'KeyInfo').length > 1 || parts[0] !== si[0] || parts[1] !== sv[0]) throw new XmlDsigError('the Signature is not SignedInfo, SignatureValue, then optional KeyInfo');
  const signedInfo = si[0]!;
  const cm = childNamed(signedInfo, NS_DSIG, 'CanonicalizationMethod');
  const sm = childNamed(signedInfo, NS_DSIG, 'SignatureMethod');
  const refs = childrenNamed(signedInfo, NS_DSIG, 'Reference');
  if (!cm || !sm || childEls(signedInfo).length !== 2 + refs.length) throw new XmlDsigError('SignedInfo is malformed');
  if (attr(cm, 'Algorithm') !== ALG.excC14n) throw new XmlDsigError(`canonicalization ${JSON.stringify(attr(cm, 'Algorithm')?.slice(0, 80))} is not accepted; only exclusive c14n is`);
  const sigAlg = attr(sm, 'Algorithm') ?? '';
  const sinfo = SIGNATURES[sigAlg];
  if (!sinfo || (sinfo.sha1 && !o.allowSha1)) throw new XmlDsigError(`signature algorithm ${JSON.stringify(sigAlg.slice(0, 80))} is not accepted`);
  if (refs.length !== 1) throw new XmlDsigError('exactly one Reference is required');
  const ref = refs[0]!;
  // the reference
  const uri = attr(ref, 'URI');
  let signed: XEl | undefined;
  if (uri === '') signed = doc.root;
  else if (uri !== undefined && uri.startsWith('#') && uri.length > 1) {
    if (uri.startsWith('#xpointer')) throw new XmlDsigError('xpointer references are not accepted');
    signed = doc.ids.get(uri.slice(1));
  } else throw new XmlDsigError('the Reference URI must be "" or "#id"');
  if (!signed) throw new XmlDsigError(`the Reference points at ${JSON.stringify(uri)}, which is not in the document`);
  if (signed !== target && !o.allowTarget?.(signed, sig)) throw new XmlDsigError('the Reference does not point at the element the Signature sits in');
  const tr = childNamed(ref, NS_DSIG, 'Transforms');
  const transforms = tr ? childrenNamed(tr, NS_DSIG, 'Transform') : [];
  if (tr && childEls(tr).length !== transforms.length) throw new XmlDsigError('Transforms holds something other than Transform');
  if (transforms.length > 2) throw new XmlDsigError('too many transforms');
  let enveloped = false;
  let incl: string[] = [];
  let c14ns = 0;
  for (const t of transforms) {
    const a = attr(t, 'Algorithm');
    if (a === ALG.enveloped) {
      if (enveloped) throw new XmlDsigError('enveloped-signature given twice');
      enveloped = true;
    } else if (a === ALG.excC14n) {
      c14ns++;
      incl = prefixList(t);
    } else throw new XmlDsigError(`transform ${JSON.stringify(a?.slice(0, 80))} is not accepted`);
  }
  if (c14ns > 1) throw new XmlDsigError('canonicalization given twice');
  const dm = childNamed(ref, NS_DSIG, 'DigestMethod');
  const dv = childNamed(ref, NS_DSIG, 'DigestValue');
  const dAlg = attr(dm ?? ref, 'Algorithm') ?? '';
  const dinfo = DIGESTS[dAlg];
  if (!dm || !dv || !dinfo || (dinfo.sha1 && !o.allowSha1)) throw new XmlDsigError(`digest algorithm ${JSON.stringify(dAlg.slice(0, 80))} is not accepted`);
  // a signed element that holds the signature must say it is enveloped, or the digest could never match; require it explicitly
  if (isInside(sig, signed) && !enveloped) throw new XmlDsigError('the signed element contains the Signature but the enveloped-signature transform is missing');
  const canonical = exclusiveC14n(signed, { inclusivePrefixes: incl, exclude: enveloped ? new Set([sig]) : new Set() });
  const digest = createHash(dinfo.node).update(canonical, 'utf8').digest();
  const claimed = b64decode(textOf(dv), 'DigestValue');
  if (claimed.length !== digest.length || !timingSafeEqual(claimed, digest)) throw new XmlDsigError('the digest does not match the signed content');
  // the signature over SignedInfo
  const siCanon = exclusiveC14n(signedInfo, { inclusivePrefixes: prefixList(cm) });
  const value = b64decode(textOf(sv[0]!), 'SignatureValue');
  const cands = candidateKeys(sig, o, sinfo.kind);
  if (!cands.length) throw new XmlDsigError('no trusted key of the right type for this signature');
  let fp: string | undefined;
  for (const { key, fp: f } of cands) {
    if (sinfo.kind === 'rsa') {
      const bits = (key.asymmetricKeyDetails?.modulusLength as number | undefined) ?? 0;
      if (bits < (o.minRsaBits ?? 2048)) continue;
    }
    const v = createVerify(sinfo.node);
    v.update(siCanon, 'utf8');
    const ok = sinfo.kind === 'ec' ? v.verify({ key, dsaEncoding: 'ieee-p1363' }, value) : v.verify(key, value);
    if (ok) {
      fp = f;
      break;
    }
  }
  if (!fp) throw new XmlDsigError('the signature value is not valid for any trusted key');
  const element = readXml(canonical).root;
  return { signed, canonical, element, signatureAlgorithm: sigAlg, digestAlgorithm: dAlg, keyFingerprint: fp };
}

/** Reads and verifies a document signed at its root. */
export function verifyDocument(xml: string, o: VerifyOptions, lim?: ReadLimits): Verified {
  const doc = readXml(xml, lim);
  return verifyElement(doc, doc.root, o);
}

// ---------------------------------------------------------------- signing

export interface SignOptions {
  readonly privateKey: KeyObject | string;
  readonly algorithm?: 'rsa-sha256' | 'rsa-sha384' | 'rsa-sha512' | 'ecdsa-sha256' | 'ecdsa-sha384' | 'ecdsa-sha512';
  /** Which element to sign: the one with this ID, or the root when absent. */
  readonly id?: string;
  /** Place the Signature right after this child of the signed element, or first when the child is absent. */
  readonly after?: { readonly ns: string; readonly local: string };
  /** Include this certificate (PEM) in KeyInfo. */
  readonly certificate?: string;
  readonly inclusivePrefixes?: readonly string[];
}

const SIGN_ALGS = {
  'rsa-sha256': [ALG.rsaSha256, 'sha256', ALG.sha256],
  'rsa-sha384': [ALG.rsaSha384, 'sha384', ALG.sha384],
  'rsa-sha512': [ALG.rsaSha512, 'sha512', ALG.sha512],
  'ecdsa-sha256': [ALG.ecdsaSha256, 'sha256', ALG.sha256],
  'ecdsa-sha384': [ALG.ecdsaSha384, 'sha384', ALG.sha384],
  'ecdsa-sha512': [ALG.ecdsaSha512, 'sha512', ALG.sha512],
} as const;

/** Adds an enveloped signature to the element named by `id` (or the root). The result is the document with a Signature inserted. */
export function sign(xml: string, o: SignOptions): string {
  const doc = readXml(xml);
  const target = o.id !== undefined ? doc.ids.get(o.id) : doc.root;
  if (!target) throw new XmlDsigError('the element to sign is not in the document');
  if (childNamed(target, NS_DSIG, 'Signature')) throw new XmlDsigError('the element already has a Signature');
  if (target.span.end === target.span.open && target.children.length === 0 && doc.source.slice(target.span.start, target.span.end).endsWith('/>')) throw new XmlDsigError('cannot sign an empty element written as <x/>');
  const key = typeof o.privateKey === 'string' ? createPrivateKey(o.privateKey) : o.privateKey;
  const alg = o.algorithm ?? (key.asymmetricKeyType === 'ec' ? 'ecdsa-sha256' : 'rsa-sha256');
  const [sigUri, nodeHash, digestUri] = SIGN_ALGS[alg];
  const incl = o.inclusivePrefixes ?? [];
  const attrId = target === doc.root && o.id === undefined ? '' : `#${o.id ?? attr(target, 'ID') ?? ''}`;
  if (attrId === '#') throw new XmlDsigError('the element to sign has no ID');
  const digest = createHash(nodeHash).update(exclusiveC14n(target, { inclusivePrefixes: incl }), 'utf8').digest('base64');
  const inclTag = incl.length ? `<ec:InclusiveNamespaces xmlns:ec="${NS_EXC}" PrefixList="${escapeXml(incl.join(' '))}"/>` : '';
  const signedInfo =
    `<ds:SignedInfo><ds:CanonicalizationMethod Algorithm="${ALG.excC14n}">${inclTag}</ds:CanonicalizationMethod>` +
    `<ds:SignatureMethod Algorithm="${sigUri}"/>` +
    `<ds:Reference URI="${escapeXml(attrId)}"><ds:Transforms><ds:Transform Algorithm="${ALG.enveloped}"/><ds:Transform Algorithm="${ALG.excC14n}">${inclTag}</ds:Transform></ds:Transforms>` +
    `<ds:DigestMethod Algorithm="${digestUri}"/><ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
  let keyInfo = '';
  if (o.certificate) {
    const der = new X509Certificate(o.certificate).raw.toString('base64');
    keyInfo = `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>${der}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>`;
  }
  const placeholder = '@@SIGNATURE_VALUE@@';
  const template = `<ds:Signature xmlns:ds="${NS_DSIG}">${signedInfo}<ds:SignatureValue>${placeholder}</ds:SignatureValue>${keyInfo}</ds:Signature>`;
  // where
  let at = target.span.open;
  if (o.after) {
    const prev = childEls(target).find((c) => c.ns === o.after!.ns && c.local === o.after!.local);
    if (prev) at = prev.span.end;
  }
  const withSig = doc.source.slice(0, at) + template + doc.source.slice(at);
  // The canonical form of SignedInfo depends on its place in the document, so it is computed there.
  const d2 = readXml(withSig);
  const t2 = o.id !== undefined ? d2.ids.get(o.id)! : d2.root;
  const sig = childNamed(t2, NS_DSIG, 'Signature')!;
  const si = childNamed(sig, NS_DSIG, 'SignedInfo')!;
  const canon = exclusiveC14n(si, { inclusivePrefixes: incl });
  const s = createSign(nodeHash);
  s.update(canon, 'utf8');
  const raw = alg.startsWith('ecdsa') ? s.sign({ key, dsaEncoding: 'ieee-p1363' }) : s.sign(key);
  return withSig.replace(placeholder, raw.toString('base64'));
}
