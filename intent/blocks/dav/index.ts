/**
 * The DAV core: a small namespace-aware XML reader and writer, the multistatus response every DAV method answers
 * with, and the headers WebDAV adds (Depth, Destination, Overwrite, If, Timeout). It serves files today, and
 * calendars and contacts (CalDAV, CardDAV) the same way: each is a registry of properties over the same core.
 *
 * The reader refuses document type declarations outright, so external entities and entity expansion attacks
 * have nothing to work with, and it caps size and depth. Only the five predefined entities and character
 * references are understood.
 */

export interface El {
  readonly ns: string;
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly El[];
  readonly text: string;
}

export const DAV = 'DAV:';

export class BadXml extends Error {
  constructor(why: string) {
    super(`the request body is not acceptable XML: ${why}`);
  }
}

/** The XML Name production's characters (XML 1.0 fifth edition, 2.3), without the colon: an NCName. */
const START = 'A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const CHAR = `${START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;
const NCNAME = `[${START}][${CHAR}]*`;
const QNAME = new RegExp(`^${NCNAME}(?::${NCNAME})?$`, 'u');

/** A name with at most one colon, each side an XML name, as element and attribute names must be with namespaces. */
export const isQName = (s: string) => QNAME.test(s);

const ENT = new Map<string, string>([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
]);

/** XML 1.0's Char production: what a character reference may name. */
const isXmlChar = (cp: number) => cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);

/**
 * Replaces references in text or an attribute value. Every & must begin one: one of the five predefined entities,
 * or a character reference to a character XML allows. Anything else (another entity, a bare &) is refused.
 */
const unescape = (s: string) => {
  if (!s.includes('&')) return s;
  return s.replace(/&([^&;]*)(;?)/g, (m, e: string, semi: string) => {
    if (!semi) throw new BadXml(`an & that does not begin a reference: ${JSON.stringify(m.slice(0, 20))}`);
    const ref = /^#(?:x([0-9a-fA-F]{1,8})|([0-9]{1,10}))$/.exec(e);
    if (ref) {
      const cp = ref[1] !== undefined ? parseInt(ref[1], 16) : parseInt(ref[2]!, 10);
      if (!isXmlChar(cp)) throw new BadXml(`the character reference ${m} names a character XML does not allow`);
      return String.fromCodePoint(cp);
    }
    const v = ENT.get(e);
    if (v === undefined) throw new BadXml(`unknown entity ${m.slice(0, 40)}`);
    return v;
  });
};

/**
 * Namespace bindings as a chain: an element that declares nothing shares its parent's scope, one that declares
 * some adds a link with only those, so declaring k prefixes costs k once, not k for every element below. Lookups
 * walk at most the nesting depth. Maps, so a prefix named like an Object member is only ever a prefix.
 */
interface Scope {
  readonly parent: Scope | null;
  readonly own: ReadonlyMap<string, string>;
}
const lookup = (scope: Scope | null, prefix: string): string | undefined => {
  for (let s = scope; s; s = s.parent) {
    const v = s.own.get(prefix);
    if (v !== undefined) return v;
  }
  return undefined;
};

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/** The attributes after an element's name, read in one pass: whitespace, name, =, a quoted value; nothing else. */
function readAttrs(rest: string, tag: string): [string, string][] {
  const out: [string, string][] = [];
  const seen = new Set<string>();
  let p = 0;
  for (;;) {
    const before = p;
    while (isSpace(rest[p])) p++;
    if (p >= rest.length) return out;
    if (p === before) throw new BadXml(`the attributes of <${tag}> are not well formed`);
    const start = p;
    while (p < rest.length && !isSpace(rest[p]) && rest[p] !== '=') p++;
    const k = rest.slice(start, p);
    while (isSpace(rest[p])) p++;
    if (rest[p] !== '=') throw new BadXml(`the attributes of <${tag}> are not well formed`);
    p++;
    while (isSpace(rest[p])) p++;
    const q = rest[p];
    if (q !== '"' && q !== "'") throw new BadXml(`the attributes of <${tag}> are not well formed`);
    const end = rest.indexOf(q, p + 1);
    if (end < 0) throw new BadXml(`the attributes of <${tag}> are not well formed`);
    const raw = rest.slice(p + 1, end);
    p = end + 1;
    if (!isQName(k)) throw new BadXml(`${JSON.stringify(k.slice(0, 40))} is not an attribute name`);
    if (seen.has(k)) throw new BadXml(`the attribute ${k} is given twice`);
    if (raw.includes('<')) throw new BadXml(`the value of ${k} contains <`);
    seen.add(k);
    out.push([k, unescape(raw)]);
  }
}

/** Parses one XML document. Namespaces resolve to their URIs; prefixes are not kept. */
export function parseXml(src: string, o: { maxBytes?: number; maxDepth?: number } = {}): El {
  const maxBytes = o.maxBytes ?? 1_000_000;
  // UTF-8 bytes, as the body arrived: a UTF-16 unit is one to three bytes, so the length alone undercounts.
  if (src.length > maxBytes || Buffer.byteLength(src, 'utf8') > maxBytes) throw new BadXml('too large');
  const maxDepth = o.maxDepth ?? 64;
  if (/<!DOCTYPE|<!ENTITY/i.test(src)) throw new BadXml('document type declarations are not accepted');
  let i = 0;
  type Frame = { ns: string; name: string; attrs: Record<string, string>; children: El[]; text: string; scope: Scope; raw: string };
  const stack: Frame[] = [];
  let root: El | undefined;
  const base: Scope = { parent: null, own: new Map([['xml', XML_NS]]) };
  const resolve = (qname: string, scope: Scope, isAttr: boolean) => {
    const c = qname.indexOf(':');
    if (c < 0) return { ns: isAttr ? '' : (lookup(scope, '') ?? ''), name: qname };
    const p = qname.slice(0, c);
    const ns = lookup(scope, p);
    if (ns === undefined) throw new BadXml(`undeclared prefix ${p}`);
    return { ns, name: qname.slice(c + 1) };
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const text = lt < 0 ? src.slice(i) : src.slice(i, lt);
    if (text && stack.length) stack[stack.length - 1]!.text += unescape(text);
    else if (text.trim() && !stack.length) throw new BadXml('text outside the root element');
    if (lt < 0) break;
    if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt);
      if (e < 0) throw new BadXml('unclosed processing instruction');
      i = e + 2;
    } else if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt);
      if (e < 0) throw new BadXml('unclosed comment');
      i = e + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt);
      if (e < 0) throw new BadXml('unclosed CDATA');
      // Character data, like text: only inside the root element.
      if (!stack.length) throw new BadXml('text outside the root element');
      stack[stack.length - 1]!.text += src.slice(lt + 9, e);
      i = e + 3;
    } else if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt);
      if (e < 0) throw new BadXml('unclosed end tag');
      const name = src.slice(lt + 2, e).trim();
      const f = stack.pop();
      if (!f || f.raw !== name) throw new BadXml(`unexpected </${name.slice(0, 40)}>`);
      const el: El = { ns: f.ns, name: f.name, attrs: f.attrs, children: f.children, text: f.text };
      if (stack.length) stack[stack.length - 1]!.children.push(el);
      else root = el;
      i = e + 1;
    } else {
      if (root) throw new BadXml('more than one root element');
      let j = lt + 1;
      let quote = '';
      for (; j < src.length; j++) {
        const ch = src[j];
        if (quote) {
          if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') break;
      }
      if (j >= src.length) throw new BadXml('unclosed start tag');
      let inner = src.slice(lt + 1, j);
      const selfClose = inner.endsWith('/');
      if (selfClose) inner = inner.slice(0, -1);
      let n = 0;
      while (n < inner.length && !isSpace(inner[n]) && inner[n] !== '/' && inner[n] !== '>') n++;
      if (!n) throw new BadXml('a tag without a name');
      const raw = inner.slice(0, n);
      if (!isQName(raw)) throw new BadXml(`${JSON.stringify(raw.slice(0, 40))} is not an element name`);
      const rawAttrs = readAttrs(inner.slice(n), raw.slice(0, 40));
      const parentScope = stack.length ? stack[stack.length - 1]!.scope : base;
      let own: Map<string, string> | undefined;
      for (const [k, v] of rawAttrs) {
        if (k === 'xmlns') (own ??= new Map()).set('', v);
        else if (k.startsWith('xmlns:')) {
          const p = k.slice(6);
          // Namespaces in XML 1.0: a prefix cannot be bound to the empty name, and xml and xmlns are reserved.
          if (v === '') throw new BadXml(`invalid namespace declaration: the prefix ${p} is bound to an empty namespace`);
          if (p === 'xmlns' || (p === 'xml') !== (v === XML_NS)) throw new BadXml(`invalid namespace declaration for the prefix ${p}`);
          (own ??= new Map()).set(p, v);
        }
      }
      const scope: Scope = own ? { parent: parentScope, own } : parentScope;
      // No prototype, so an attribute named __proto__ is an attribute like any other.
      const attrs = Object.create(null) as Record<string, string>;
      for (const [k, v] of rawAttrs) {
        if (k === 'xmlns' || k.startsWith('xmlns:')) continue;
        const r = resolve(k, scope, true);
        const ek = r.ns ? `{${r.ns}}${r.name}` : r.name;
        if (Object.hasOwn(attrs, ek)) throw new BadXml(`the attribute ${ek} is given twice`);
        attrs[ek] = v;
      }
      const { ns, name } = resolve(raw, scope, false);
      if (stack.length >= maxDepth) throw new BadXml('nested too deeply');
      const f: Frame = { ns, name, attrs, children: [], text: '', scope, raw };
      if (selfClose) {
        const el: El = { ns, name, attrs, children: [], text: '' };
        if (stack.length) stack[stack.length - 1]!.children.push(el);
        else root = el;
      } else stack.push(f);
      i = j + 1;
    }
  }
  if (stack.length) throw new BadXml(`<${stack[stack.length - 1]!.raw}> is not closed`);
  if (!root) throw new BadXml('no root element');
  return root;
}

export const child = (e: El, ns: string, name: string) => e.children.find((c) => c.ns === ns && c.name === name);
export const children = (e: El, ns: string, name: string) => e.children.filter((c) => c.ns === ns && c.name === name);
export const key = (ns: string, name: string) => `{${ns}}${name}`;
export const keyOf = (e: { ns: string; name: string }) => key(e.ns, e.name);

/** Text content needs only <, > and & escaped; quotes stay literal, as Nextcloud writes etags. */
export const escapeText = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);

export const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

/** A node to write: text, or children, or empty. */
export interface Out {
  readonly ns: string;
  readonly name: string;
  readonly text?: string;
  readonly children?: readonly Out[];
  readonly attrs?: Readonly<Record<string, string>>;
}

export const el = (ns: string, name: string, body?: string | readonly Out[], attrs?: Record<string, string>): Out => ({ ns, name, ...(typeof body === 'string' ? { text: body } : body ? { children: body } : {}), ...(attrs ? { attrs } : {}) });

/** Writes XML with stable prefixes: `prefixes` names the usual ones, anything else gets x1, x2… declared at the root. */
export function writeXml(root: Out, prefixes: Readonly<Record<string, string>> = { [DAV]: 'd' }): string {
  const pre = new Map(Object.entries(prefixes));
  let n = 0;
  const collect = (o: Out) => {
    if (o.ns !== '' && !pre.has(o.ns)) pre.set(o.ns, `x${++n}`);
    o.children?.forEach(collect);
  };
  collect(root);
  const used = new Set<string>();
  const mark = (o: Out) => {
    if (o.ns !== '') used.add(o.ns);
    o.children?.forEach(mark);
  };
  mark(root);
  const decl = [...used].map((ns) => ` xmlns:${pre.get(ns)}="${escapeXml(ns)}"`).join('');
  const w = (o: Out, top: boolean): string => {
    // An element in no namespace has no prefix; no default namespace is ever declared, so it stays in none.
    const tag = o.ns === '' ? o.name : `${pre.get(o.ns)}:${o.name}`;
    const at = Object.entries(o.attrs ?? {})
      .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
      .join('');
    const head = `<${tag}${top ? decl : ''}${at}`;
    if (o.children?.length) return `${head}>${o.children.map((c) => w(c, false)).join('')}</${tag}>`;
    if (o.text !== undefined && o.text !== '') return `${head}>${escapeText(o.text)}</${tag}>`;
    return `${head}/>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n${w(root, true)}`;
}

export const STATUS: Record<number, string> = { 200: 'OK', 201: 'Created', 204: 'No Content', 207: 'Multi-Status', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 412: 'Precondition Failed', 423: 'Locked', 424: 'Failed Dependency', 507: 'Insufficient Storage' };
export const statusLine = (code: number) => `HTTP/1.1 ${code} ${STATUS[code] ?? ''}`.trim();

export interface Response {
  readonly href: string;
  /** Properties found, grouped by status; usually 200 and 404. */
  readonly propstats: readonly { readonly status: number; readonly props: readonly Out[] }[];
}

export function multistatus(responses: readonly Response[], prefixes?: Readonly<Record<string, string>>): string {
  return writeXml(
    el(
      DAV,
      'multistatus',
      responses.map((r) =>
        el(DAV, 'response', [
          el(DAV, 'href', r.href),
          ...r.propstats.filter((p) => p.props.length).map((p) => el(DAV, 'propstat', [el(DAV, 'prop', p.props as Out[]), el(DAV, 'status', statusLine(p.status))])),
        ]),
      ),
    ),
    prefixes,
  );
}

export type PropRequest = { kind: 'allprop' } | { kind: 'propname' } | { kind: 'prop'; props: readonly { ns: string; name: string }[] };

/** What a PROPFIND asks for; an empty body means every property, as the RFC says. */
export function propfindRequest(body: string): PropRequest {
  if (!body.trim()) return { kind: 'allprop' };
  const r = parseXml(body);
  if (r.ns !== DAV || r.name !== 'propfind') throw new BadXml('the body is not a propfind');
  if (child(r, DAV, 'propname')) return { kind: 'propname' };
  const p = child(r, DAV, 'prop');
  if (p) return { kind: 'prop', props: p.children.map((c) => ({ ns: c.ns, name: c.name })) };
  return { kind: 'allprop' };
}

export type PropOp = { readonly op: 'set'; readonly ns: string; readonly name: string; readonly value: string } | { readonly op: 'remove'; readonly ns: string; readonly name: string };

/** Every instruction of a PROPPATCH in document order, which is the order RFC 4918 (9.2) says they apply in. */
export function proppatchOps(body: string): PropOp[] {
  const r = parseXml(body);
  if (r.ns !== DAV || r.name !== 'propertyupdate') throw new BadXml('the body is not a propertyupdate');
  const ops: PropOp[] = [];
  for (const op of r.children) {
    const p = child(op, DAV, 'prop');
    if (!p) continue;
    if (op.ns === DAV && op.name === 'set') for (const c of p.children) ops.push({ op: 'set', ns: c.ns, name: c.name, value: c.text.trim() });
    else if (op.ns === DAV && op.name === 'remove') for (const c of p.children) ops.push({ op: 'remove', ns: c.ns, name: c.name });
  }
  return ops;
}

/**
 * What a PROPPATCH sets and removes, by kind. It loses the order between kinds, so a caller that applies the
 * changes uses proppatchOps and netPropChanges instead: a remove followed by a set of one property leaves it set.
 */
export function proppatchRequest(body: string): { set: { ns: string; name: string; value: string }[]; remove: { ns: string; name: string }[] } {
  const ops = proppatchOps(body);
  return {
    set: ops.flatMap((o) => (o.op === 'set' ? [{ ns: o.ns, name: o.name, value: o.value }] : [])),
    remove: ops.flatMap((o) => (o.op === 'remove' ? [{ ns: o.ns, name: o.name }] : [])),
  };
}

/** The properties a PROPPATCH leaves set, and those it leaves removed, after applying its instructions in order. */
export function netPropChanges(ops: readonly PropOp[]): { set: Record<string, string>; clear: string[] } {
  const set: Record<string, string> = {};
  const clear = new Set<string>();
  for (const o of ops) {
    const k = key(o.ns, o.name);
    if (o.op === 'set') {
      set[k] = o.value;
      clear.delete(k);
    } else {
      delete set[k];
      clear.add(k);
    }
  }
  return { set, clear: [...clear] };
}

export type Depth = 0 | 1 | 'infinity';

export function depth(header: string | null | undefined, fallback: Depth = 'infinity'): Depth {
  const h = header?.trim().toLowerCase();
  return h === '0' ? 0 : h === '1' ? 1 : h === 'infinity' ? 'infinity' : fallback;
}

/** Overwrite: T unless the client says F. */
export const overwrite = (header: string | null | undefined) => header?.trim().toUpperCase() !== 'F';

/** The path a Destination header points at, decoded, when it is on this server under `base`. */
export function destination(header: string | null | undefined, host: string, base: string): string | null {
  if (!header) return null;
  let u: URL;
  try {
    u = new URL(header, `http://${host}`);
  } catch {
    return null;
  }
  if (u.host && u.host !== host) return null;
  let p: string;
  try {
    p = decodePath(u.pathname);
  } catch {
    return null;
  }
  // Under `base` means `base` itself or a path below it: /files/anabel only begins like /files/ana.
  const b = base.replace(/\/+$/, '');
  if (p !== b && !p.startsWith(`${b}/`)) return null;
  return p.slice(b.length) || '/';
}

export class BadIf extends Error {
  constructor(why: string) {
    super(`the If header cannot be read: ${why}`);
  }
}

export interface IfCondition {
  readonly not: boolean;
  /** A state token (a lock token, or any URI such as DAV:no-lock). */
  readonly token?: string;
  /** An entity tag as sent, quotes and any W/ included. */
  readonly etag?: string;
}

export interface IfList {
  /** The resource a tagged list is about; none means the request's own resource. */
  readonly resource?: string;
  readonly conditions: readonly IfCondition[];
}

/**
 * Parses an If header (RFC 4918 10.4): untagged lists, or lists tagged with the resource they are about; each list
 * holds state tokens and entity tags, each possibly negated with Not. Returns null when there is no header.
 */
export function parseIf(header: string | null | undefined): IfList[] | null {
  if (header === null || header === undefined || !header.trim()) return null;
  const s = header;
  let i = 0;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i]!)) i++;
  };
  const until = (close: string) => {
    const e = s.indexOf(close, i);
    if (e < 0) throw new BadIf(`an unclosed ${s[i - 1]}`);
    const v = s.slice(i, e);
    i = e + 1;
    return v;
  };
  const out: IfList[] = [];
  let tagged: boolean | undefined;
  let resource: string | undefined;
  for (ws(); i < s.length; ws()) {
    const c = s[i]!;
    if (c === '<') {
      if (tagged === false) throw new BadIf('tagged and untagged lists are mixed');
      tagged = true;
      i++;
      resource = until('>');
      if (!resource) throw new BadIf('an empty resource tag');
      ws();
      if (s[i] !== '(') throw new BadIf('a resource tag needs a list after it');
    } else if (c === '(') {
      if (tagged === undefined) tagged = false;
      i++;
      const conditions: IfCondition[] = [];
      for (ws(); s[i] !== ')'; ws()) {
        if (i >= s.length) throw new BadIf('an unclosed list');
        let not = false;
        if (/^not\b/i.test(s.slice(i, i + 4)) && /\s|<|\[/.test(s[i + 3] ?? '')) {
          not = true;
          i += 3;
          ws();
        }
        if (s[i] === '<') {
          i++;
          const token = until('>');
          if (!token) throw new BadIf('an empty state token');
          conditions.push({ not, token });
        } else if (s[i] === '[') {
          i++;
          const etag = until(']').trim();
          if (!/^(W\/)?"[^"]*"$/.test(etag)) throw new BadIf(`${etag} is not an entity tag`);
          conditions.push({ not, etag });
        } else throw new BadIf(`unexpected ${JSON.stringify(s[i] ?? 'end')}`);
      }
      i++;
      if (!conditions.length) throw new BadIf('an empty list');
      out.push({ ...(tagged && resource !== undefined ? { resource } : {}), conditions });
    } else throw new BadIf(`unexpected ${JSON.stringify(c)}`);
  }
  if (!out.length) throw new BadIf('no list');
  return out;
}

/** An entity tag's opaque value, for the weak comparison If conditions use. */
const etagValue = (e: string) => e.replace(/^W\//, '').replace(/^"|"$/g, '');

/**
 * Whether an If header holds: some list whose every condition is true of its resource. A state token is true when
 * it is a lock token of a lock on the resource; an entity tag when it matches the resource's (a resource that does
 * not exist has none). `state` describes the resource a list names (undefined: the request's own).
 */
export function ifHolds(lists: readonly IfList[], state: (resource: string | undefined) => { readonly etag?: string; readonly tokens: readonly string[] }): boolean {
  return lists.some((l) => {
    const st = state(l.resource);
    return l.conditions.every((c) => {
      const t = c.token !== undefined ? st.tokens.includes(c.token) : st.etag !== undefined && etagValue(st.etag) === etagValue(c.etag!);
      return c.not ? !t : t;
    });
  });
}

/** Lock tokens named in an If header. */
export const ifTokens = (header: string | null | undefined): string[] => [...(header ?? '').matchAll(/<(opaquelocktoken:[^>]+)>/g)].map((m) => m[1]!);

/** A Timeout header in milliseconds; "Infinite" and anything unreadable become `max`. */
export function timeout(header: string | null | undefined, max: number): number {
  const m = /Second-(\d+)/i.exec(header ?? '');
  return m ? Math.min(Number(m[1]) * 1000, max) : max;
}

/** Percent-encodes each step of a path the way PHP's rawurlencode does, which is what Nextcloud clients compare. */
export function encodePath(path: string): string {
  return path
    .split('/')
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

export function decodePath(path: string): string {
  return path
    .split('/')
    .map((s) => decodeURIComponent(s))
    .join('/');
}

/** An HTTP date, as getlastmodified and Last-Modified want it. */
export const httpDate = (seconds: number) => new Date(seconds * 1000).toUTCString();
