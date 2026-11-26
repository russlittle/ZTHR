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

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unescape = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(cp) || cp > 0x10ffff) throw new BadXml(`bad character reference ${m}`);
      return String.fromCodePoint(cp);
    }
    const v = ENT[e];
    if (v === undefined) throw new BadXml(`unknown entity ${m}`);
    return v;
  });

/** Parses one XML document. Namespaces resolve to their URIs; prefixes are not kept. */
export function parseXml(src: string, o: { maxBytes?: number; maxDepth?: number } = {}): El {
  if (src.length > (o.maxBytes ?? 1_000_000)) throw new BadXml('too large');
  const maxDepth = o.maxDepth ?? 64;
  if (/<!DOCTYPE|<!ENTITY/i.test(src)) throw new BadXml('document type declarations are not accepted');
  let i = 0;
  type Frame = { ns: string; name: string; attrs: Record<string, string>; children: El[]; text: string; scope: Record<string, string>; raw: string };
  const stack: Frame[] = [];
  let root: El | undefined;
  const base: Record<string, string> = { xml: 'http://www.w3.org/XML/1998/namespace' };
  const resolve = (qname: string, scope: Record<string, string>, isAttr: boolean) => {
    const c = qname.indexOf(':');
    if (c < 0) return { ns: isAttr ? '' : (scope[''] ?? ''), name: qname };
    const p = qname.slice(0, c);
    const ns = scope[p];
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
      if (stack.length) stack[stack.length - 1]!.text += src.slice(lt + 9, e);
      i = e + 3;
    } else if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt);
      if (e < 0) throw new BadXml('unclosed end tag');
      const name = src.slice(lt + 2, e).trim();
      const f = stack.pop();
      if (!f || f.raw !== name) throw new BadXml(`unexpected </${name}>`);
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
      const m = /^([^\s/>]+)/.exec(inner);
      if (!m) throw new BadXml('a tag without a name');
      const raw = m[1]!;
      const rawAttrs: [string, string][] = [];
      const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a: RegExpExecArray | null;
      const rest = inner.slice(raw.length);
      while ((a = re.exec(rest))) rawAttrs.push([a[1]!, unescape(a[3] ?? a[4] ?? '')]);
      const scope = { ...(stack.length ? stack[stack.length - 1]!.scope : base) };
      for (const [k, v] of rawAttrs) {
        if (k === 'xmlns') scope[''] = v;
        else if (k.startsWith('xmlns:')) scope[k.slice(6)] = v;
      }
      const attrs: Record<string, string> = {};
      for (const [k, v] of rawAttrs) {
        if (k === 'xmlns' || k.startsWith('xmlns:')) continue;
        const r = resolve(k, scope, true);
        attrs[r.ns ? `{${r.ns}}${r.name}` : r.name] = v;
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
    if (!pre.has(o.ns)) pre.set(o.ns, `x${++n}`);
    o.children?.forEach(collect);
  };
  collect(root);
  const used = new Set<string>();
  const mark = (o: Out) => {
    used.add(o.ns);
    o.children?.forEach(mark);
  };
  mark(root);
  const decl = [...used].map((ns) => ` xmlns:${pre.get(ns)}="${escapeXml(ns)}"`).join('');
  const w = (o: Out, top: boolean): string => {
    const tag = `${pre.get(o.ns)}:${o.name}`;
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

/** What a PROPPATCH sets and removes, in document order. */
export function proppatchRequest(body: string): { set: { ns: string; name: string; value: string }[]; remove: { ns: string; name: string }[] } {
  const r = parseXml(body);
  if (r.ns !== DAV || r.name !== 'propertyupdate') throw new BadXml('the body is not a propertyupdate');
  const set: { ns: string; name: string; value: string }[] = [];
  const remove: { ns: string; name: string }[] = [];
  for (const op of r.children) {
    const p = child(op, DAV, 'prop');
    if (!p) continue;
    if (op.ns === DAV && op.name === 'set') for (const c of p.children) set.push({ ns: c.ns, name: c.name, value: c.text.trim() });
    else if (op.ns === DAV && op.name === 'remove') for (const c of p.children) remove.push({ ns: c.ns, name: c.name });
  }
  return { set, remove };
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
  if (!p.startsWith(base)) return null;
  return p.slice(base.length) || '/';
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
