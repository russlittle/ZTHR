/**
 * The property and namespace-operation side of a WebDAV server (RFC 4918) over the tree block: PROPFIND, PROPPATCH,
 * COPY, MOVE and SEARCH (DASL basicsearch, RFC 5323), each taking the request's pieces and returning status,
 * headers and an XML body, so any HTTP layer can call them. XML is read with the dav block (no DTDs, no entities)
 * and written with its writer.
 *
 * Live properties are computed from the node, never stored: resourcetype, displayname, getlastmodified, getetag
 * (strong, quoted), getcontentlength (files), getcontenttype (the stored type; "httpd/unix-directory" for folders).
 * Extensions are returned only when asked for by name: quota-used-bytes and quota-available-bytes (RFC 4331, on
 * folders; available only when the owner has a limit), the calendarserver getctag (a folder's etag, which changes
 * whenever anything inside does), and ownCloud/Nextcloud fileid, size and checksums. `allprop` is the RFC 4918
 * set plus dead properties; `propname` lists names. Dead properties are the client's: they live on the node keyed by
 * "{namespace}name", move with it and are copied by COPY, hold text values (a value with child elements is refused,
 * never silently flattened), have size and count limits, and changing them does not change the etag or ctag,
 * because the content did not change. PROPPATCH is atomic: every instruction is checked first, and if any would
 * fail, nothing is applied and the rest report 424 Failed Dependency, as RFC 4918 section 9.2 requires; a remove
 * followed by a set of the same property leaves it set. Live properties are protected (403).
 *
 * Depth: PROPFIND Depth 0 and 1 are served; infinity is refused with the `propfind-finite-depth` precondition
 * (RFC 4918 section 9.1) unless the caller allows it, and then is capped. COPY accepts Depth 0 on a collection
 * (the collection and its properties, none of its members) and infinity; MOVE accepts only infinity. COPY and MOVE
 * answer 201 when the destination was made and 204 when it was replaced, 412 when it exists and Overwrite is F,
 * 409 when the destination's parent is missing, 403 when source and destination are the same or one is inside the
 * other, and 507 when a COPY would take the owner past their quota. A MOVE keeps node ids and dead properties;
 * a COPY gets new ones, with the properties copied. SEARCH supports eq, lt, lte, gt, gte, like (with % _ and
 * backslash escape, matched without regular expressions), and, or, not, is-defined and is-collection over
 * displayname, getcontentlength, getlastmodified, getcontenttype; select, orderby and limit; and bounds on
 * nesting, pattern length and entries scanned. Results beyond the limit are cut and marked with a 507 status on
 * the scope, as RFC 5323 describes.
 *
 * Out of scope: locking (LOCK, UNLOCK and If headers), ACLs, DeltaV versioning, bind, cross-owner COPY/MOVE
 * (see the tree block's moveAcross), element-valued dead properties, and the HTTP layer itself.
 */
import { BadXml, DAV, depth as parseDepth, destination, el, isQName, overwrite as parseOverwrite, parseXml, propfindRequest, statusLine, writeXml } from '../dav/index.ts';
import type { El, Out, PropRequest } from '../dav/index.ts';
import { Exists, IntoItself, InvalidName, MissingParent, NotFound, steps } from '../tree/index.ts';
import type { Node, Tree } from '../tree/index.ts';

export class DavPropsError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface DavResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface Context {
  readonly owner: string;
  /** The URL path that is this owner's root, e.g. "/remote.php/dav/files/ana". Hrefs are built from it. */
  readonly base: string;
}

export interface Options {
  /** The owner's storage limit in bytes, or undefined for none. */
  readonly quota?: (owner: string) => Promise<number | undefined> | number | undefined;
  readonly allowInfinity?: boolean;
  readonly maxDeadProps?: number;
  readonly maxPropValue?: number;
  /** Most resources a PROPFIND or SEARCH will visit. */
  readonly maxResources?: number;
  readonly maxResults?: number;
}

export const OC = 'http://owncloud.org/ns';
export const CS = 'http://calendarserver.org/ns/';
const PREFIXES = { [DAV]: 'd', [OC]: 'oc', [CS]: 'cs' };
const k = (ns: string, name: string) => `{${ns}}${name}`;
const DEAD = /^\{([^}]*)\}(.+)$/;

const xmlResponse = (status: number, body: string, headers: Record<string, string> = {}): DavResponse => ({ status, headers: { 'content-type': 'application/xml; charset=utf-8', ...headers }, body });
const errorBody = (name: string) => writeXml(el(DAV, 'error', [el(DAV, name)]), PREFIXES);
const plain = (status: number, message: string): DavResponse => ({ status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: message });

export function hrefFor(base: string, path: string, folder: boolean): string {
  const s = steps(path).map(encodeURIComponent).join('/');
  const b = base.replace(/\/+$/, '');
  return `${b}/${s}${folder && s ? '/' : ''}`;
}

/** The decoded path under `base` that a request URL or href names, or undefined when it is outside. */
export function relPath(href: string, base: string): string | undefined {
  return destination(href, 'localhost', base) ?? undefined;
}

type Status = 200 | 403 | 404 | 409 | 424 | 507;

export class WebdavProps {
  private readonly tree: Tree;
  private readonly o: Required<Pick<Options, 'allowInfinity' | 'maxDeadProps' | 'maxPropValue' | 'maxResources' | 'maxResults'>> & Pick<Options, 'quota'>;

  constructor(tree: Tree, o: Options = {}) {
    this.tree = tree;
    this.o = { allowInfinity: false, maxDeadProps: 100, maxPropValue: 4096, maxResources: 10_000, maxResults: 1000, ...o };
  }

  private async limit(owner: string): Promise<number | undefined> {
    return this.o.quota?.(owner);
  }

  /** Bytes used and still available for an owner (available is undefined when there is no limit). */
  async quotaOf(owner: string): Promise<{ used: number; available: number | undefined }> {
    const used = (await this.tree.root(owner)).size;
    const lim = await this.limit(owner);
    return { used, available: lim === undefined ? undefined : Math.max(0, lim - used) };
  }

  // --- properties ------------------------------------------------------------------------------------------

  private async liveProps(n: Node, ctx: Context): Promise<Map<string, Out>> {
    const m = new Map<string, Out>();
    const folder = n.kind === 'folder';
    const put = (ns: string, name: string, v: Out) => m.set(k(ns, name), v);
    put(DAV, 'resourcetype', el(DAV, 'resourcetype', folder ? [el(DAV, 'collection')] : undefined));
    put(DAV, 'displayname', el(DAV, 'displayname', n.name || ctx.owner));
    put(DAV, 'getlastmodified', el(DAV, 'getlastmodified', new Date(n.mtime * 1000).toUTCString()));
    put(DAV, 'getetag', el(DAV, 'getetag', `"${n.etag}"`));
    put(DAV, 'getcontenttype', el(DAV, 'getcontenttype', folder ? 'httpd/unix-directory' : (n.mime ?? 'application/octet-stream')));
    if (!folder) put(DAV, 'getcontentlength', el(DAV, 'getcontentlength', String(n.size)));
    return m;
  }

  private async extensionProps(n: Node, ctx: Context): Promise<Map<string, Out>> {
    const m = new Map<string, Out>();
    const folder = n.kind === 'folder';
    if (folder) {
      m.set(k(CS, 'getctag'), el(CS, 'getctag', n.etag));
      const q = await this.quotaOf(ctx.owner);
      m.set(k(DAV, 'quota-used-bytes'), el(DAV, 'quota-used-bytes', String(n.size)));
      if (q.available !== undefined) m.set(k(DAV, 'quota-available-bytes'), el(DAV, 'quota-available-bytes', String(q.available)));
    }
    m.set(k(OC, 'fileid'), el(OC, 'fileid', String(n.id)));
    m.set(k(OC, 'size'), el(OC, 'size', String(n.size)));
    if (n.checksums?.length) m.set(k(OC, 'checksums'), el(OC, 'checksums', [el(OC, 'checksum', n.checksums.join(' '))]));
    return m;
  }

  private dead(n: Node): Map<string, Out> {
    const m = new Map<string, Out>();
    for (const [key, v] of Object.entries(n.props ?? {})) {
      const d = DEAD.exec(key);
      if (d) m.set(key, el(d[1]!, d[2]!, v));
    }
    return m;
  }

  private async select(n: Node, ctx: Context, req: PropRequest): Promise<{ status: number; props: Out[] }[]> {
    const live = await this.liveProps(n, ctx);
    const dead = this.dead(n);
    if (req.kind === 'allprop') return [{ status: 200, props: [...live.values(), ...dead.values()] }];
    if (req.kind === 'propname') {
      const names = [...live.values(), ...dead.values(), ...(await this.extensionProps(n, ctx)).values()];
      return [{ status: 200, props: names.map((p) => el(p.ns, p.name)) }];
    }
    const ext = await this.extensionProps(n, ctx);
    const found: Out[] = [];
    const missing: Out[] = [];
    for (const p of req.props) {
      const key = k(p.ns, p.name);
      const v = live.get(key) ?? ext.get(key) ?? dead.get(key);
      if (v) found.push(v);
      else missing.push(el(p.ns, p.name));
    }
    return [
      { status: 200, props: found },
      { status: 404, props: missing },
    ];
  }

  private response(href: string, propstats: readonly { status: number; props: readonly Out[] }[]): Out {
    return el(DAV, 'response', [el(DAV, 'href', href), ...propstats.filter((p) => p.props.length).map((p) => el(DAV, 'propstat', [el(DAV, 'prop', p.props as Out[]), el(DAV, 'status', statusLine(p.status))]))]);
  }

  async propfind(ctx: Context, path: string, o: { body?: string; depth?: string | null } = {}): Promise<DavResponse> {
    let req: PropRequest;
    try {
      req = propfindRequest(o.body ?? '');
    } catch (e) {
      if (e instanceof BadXml) return plain(400, e.message);
      throw e;
    }
    const d = parseDepth(o.depth, 'infinity');
    if (d === 'infinity' && !this.o.allowInfinity) return xmlResponse(403, errorBody('propfind-finite-depth'));
    let node: Node | undefined;
    try {
      node = await this.tree.resolve(ctx.owner, path);
    } catch (e) {
      if (e instanceof InvalidName) return plain(400, e.message);
      throw e;
    }
    if (!node) return plain(404, 'not found');
    const rows: { n: Node; path: string }[] = [{ n: node, path }];
    const walk = async (n: Node, p: string, level: number) => {
      if (n.kind !== 'folder' || (d !== 'infinity' && level >= d)) return;
      for (const c of await this.tree.list(n)) {
        if (rows.length >= this.o.maxResources) throw new DavPropsError(403, 'too many resources for one PROPFIND');
        const cp = `${p.replace(/\/+$/, '')}/${c.name}`;
        rows.push({ n: c, path: cp });
        await walk(c, cp, level + 1);
      }
    };
    try {
      await walk(node, path, 0);
    } catch (e) {
      if (e instanceof DavPropsError) return xmlResponse(403, errorBody('propfind-finite-depth'));
      throw e;
    }
    const out: Out[] = [];
    for (const r of rows) out.push(this.response(hrefFor(ctx.base, r.path, r.n.kind === 'folder'), await this.select(r.n, ctx, req)));
    return xmlResponse(207, writeXml(el(DAV, 'multistatus', out), PREFIXES));
  }

  // --- PROPPATCH --------------------------------------------------------------------------------------------

  async proppatch(ctx: Context, path: string, body: string): Promise<DavResponse> {
    let root: El;
    try {
      root = parseXml(body);
      if (root.ns !== DAV || root.name !== 'propertyupdate') throw new BadXml('the body is not a propertyupdate');
    } catch (e) {
      if (e instanceof BadXml) return plain(400, e.message);
      throw e;
    }
    const node = await this.tree.resolve(ctx.owner, path).catch(() => undefined);
    if (!node) return plain(404, 'not found');
    type Op = { op: 'set' | 'remove'; ns: string; name: string; value: string; status: Status };
    const ops: Op[] = [];
    for (const group of root.children) {
      if (group.ns !== DAV || (group.name !== 'set' && group.name !== 'remove')) continue;
      for (const prop of group.children.filter((c) => c.ns === DAV && c.name === 'prop')) {
        for (const p of prop.children) {
          let status: Status = 200;
          const key = k(p.ns, p.name);
          if (p.ns === '' || !isQName(p.name) || p.ns.length > 255 || p.name.length > 100) status = 409;
          else if ((await this.liveProps(node, ctx)).has(key) || (await this.extensionProps(node, ctx)).has(key) || p.ns === DAV) status = 403;
          else if (group.name === 'set' && p.children.length > 0) status = 409;
          else if (group.name === 'set' && p.text.length > this.o.maxPropValue) status = 409;
          ops.push({ op: group.name, ns: p.ns, name: p.name, value: group.name === 'set' ? p.text : '', status });
        }
      }
    }
    if (ops.length === 0) return plain(400, 'the propertyupdate changes nothing');
    // net result, in document order, to check the count limit
    const final = new Map(Object.entries(node.props ?? {}));
    for (const o of ops) {
      if (o.status !== 200) continue;
      if (o.op === 'set') final.set(k(o.ns, o.name), o.value);
      else final.delete(k(o.ns, o.name));
    }
    if (final.size > this.o.maxDeadProps) for (const o of ops) if (o.op === 'set' && o.status === 200) o.status = 409;
    const failed = ops.some((o) => o.status !== 200);
    if (!failed) {
      const set: Record<string, string> = {};
      const clear = new Set<string>();
      for (const o of ops) {
        const key = k(o.ns, o.name);
        if (o.op === 'set') (set[key] = o.value, clear.delete(key));
        else (delete set[key], clear.add(key));
      }
      await this.tree.setProps(ctx.owner, path, set, [...clear]);
    }
    const groups = new Map<number, Out[]>();
    for (const o of ops) {
      const status = failed && o.status === 200 ? 424 : o.status;
      groups.set(status, [...(groups.get(status) ?? []), el(o.ns, o.name)]);
    }
    const href = hrefFor(ctx.base, path, node.kind === 'folder');
    const res = el(DAV, 'multistatus', [el(DAV, 'response', [el(DAV, 'href', href), ...[...groups].map(([status, props]) => el(DAV, 'propstat', [el(DAV, 'prop', props), el(DAV, 'status', statusLine(status))]))])]);
    return xmlResponse(207, writeXml(res, PREFIXES));
  }

  // --- COPY and MOVE ----------------------------------------------------------------------------------------

  private async transfer(method: 'COPY' | 'MOVE', ctx: Context, path: string, o: { destination?: string | null; host?: string; overwrite?: string | null; depth?: string | null }): Promise<DavResponse> {
    const dst = destination(o.destination, o.host ?? 'localhost', ctx.base);
    if (dst === null) return plain(400, 'the Destination header is missing or not under this resource tree');
    const d = parseDepth(o.depth, 'infinity');
    if (method === 'MOVE' && d !== 'infinity') return plain(400, 'MOVE on a collection acts with Depth infinity');
    if (method === 'COPY' && d === 1) return plain(400, 'COPY accepts Depth 0 or infinity');
    let from: string;
    let to: string;
    try {
      from = steps(path).join('/');
      to = steps(dst).join('/');
    } catch (e) {
      if (e instanceof InvalidName) return plain(403, e.message);
      throw e;
    }
    const src = await this.tree.resolve(ctx.owner, path);
    if (!src) return plain(404, 'the source does not exist');
    if (from === to || to.startsWith(`${from}/`) || from.startsWith(`${to}/`) || to === '') return plain(403, 'the source and destination are the same, or one is inside the other');
    const existing = await this.tree.resolve(ctx.owner, dst);
    const replace = parseOverwrite(o.overwrite);
    if (existing && !replace) return plain(412, 'the destination exists and Overwrite is F');
    if (method === 'COPY') {
      const lim = await this.limit(ctx.owner);
      const need = (src.kind === 'folder' && d === 0 ? 0 : src.size) - (existing?.size ?? 0);
      if (lim !== undefined && (await this.quotaOf(ctx.owner)).used + need > lim) return xmlResponse(507, errorBody('quota-not-exceeded'));
    }
    try {
      if (method === 'MOVE') await this.tree.move(ctx.owner, path, dst, true);
      else if (src.kind === 'folder' && d === 0) {
        if (existing) await this.tree.remove(ctx.owner, dst);
        await this.tree.mkdir(ctx.owner, dst);
        if (src.props && Object.keys(src.props).length) await this.tree.setProps(ctx.owner, dst, src.props);
      } else await this.tree.copy(ctx.owner, path, dst, true);
    } catch (e) {
      if (e instanceof MissingParent) return plain(409, 'the destination\'s parent does not exist');
      if (e instanceof Exists) return plain(412, 'the destination exists');
      if (e instanceof IntoItself || e instanceof InvalidName) return plain(403, (e as Error).message);
      if (e instanceof NotFound) return plain(404, (e as Error).message);
      throw e;
    }
    return { status: existing ? 204 : 201, headers: {}, body: '' };
  }

  copy(ctx: Context, path: string, o: { destination?: string | null; host?: string; overwrite?: string | null; depth?: string | null }): Promise<DavResponse> {
    return this.transfer('COPY', ctx, path, o);
  }

  move(ctx: Context, path: string, o: { destination?: string | null; host?: string; overwrite?: string | null; depth?: string | null }): Promise<DavResponse> {
    return this.transfer('MOVE', ctx, path, o);
  }

  // --- SEARCH (DASL basicsearch) -----------------------------------------------------------------------------

  async search(ctx: Context, body: string): Promise<DavResponse> {
    let root: El;
    try {
      root = parseXml(body);
    } catch (e) {
      if (e instanceof BadXml) return plain(400, e.message);
      throw e;
    }
    try {
      return await this.runSearch(ctx, root);
    } catch (e) {
      if (e instanceof DavPropsError) return plain(e.status, e.message);
      throw e;
    }
  }

  private async runSearch(ctx: Context, root: El): Promise<DavResponse> {
    const bad = (m: string) => new DavPropsError(400, m);
    if (root.ns !== DAV || root.name !== 'searchrequest') throw bad('the body is not a searchrequest');
    const basic = root.children.find((c) => c.ns === DAV && c.name === 'basicsearch');
    if (!basic) throw bad('only basicsearch is supported');
    const sub = (e: El, name: string) => e.children.find((c) => c.ns === DAV && c.name === name);
    const scope = sub(sub(basic, 'from') ?? basic, 'scope');
    const href = scope && sub(scope, 'href')?.text.trim();
    if (!href) throw bad('a scope href is required');
    const sd = sub(scope, 'depth')?.text.trim().toLowerCase();
    if (sd !== undefined && sd !== '0' && sd !== '1' && sd !== 'infinity') throw bad('the scope depth is 0, 1 or infinity');
    const scopePath = relPath(href, ctx.base);
    if (scopePath === undefined) throw bad('the scope is outside your files');
    const start = await this.tree.resolve(ctx.owner, scopePath).catch(() => undefined);
    if (!start) throw new DavPropsError(404, 'the scope does not exist');
    const sel = sub(basic, 'select');
    let req: PropRequest = { kind: 'allprop' };
    if (sel) {
      const p = sub(sel, 'prop');
      if (p) req = { kind: 'prop', props: p.children.map((c) => ({ ns: c.ns, name: c.name })) };
    }
    const where = sub(basic, 'where');
    const test = where ? compile(where.children[0], 0) : () => true;
    if (where && where.children.length !== 1) throw bad('where holds exactly one operator');
    const orders = (sub(basic, 'orderby')?.children ?? []).filter((c) => c.name === 'order').map((o) => {
      const p = sub(o, 'prop')?.children[0];
      if (!p || p.ns !== DAV || !(p.name in PROP_READERS)) throw bad('orderby uses displayname, getcontentlength, getlastmodified or getcontenttype');
      return { prop: p.name, desc: !!sub(o, 'descending') };
    });
    const nr = sub(sub(basic, 'limit') ?? basic, 'nresults')?.text.trim();
    if (nr !== undefined && !/^\d{1,9}$/.test(nr)) throw bad('nresults is a non-negative integer');
    const cap = Math.min(nr === undefined ? this.o.maxResults : Number(nr), this.o.maxResults);
    // walk the scope
    const rows: { n: Node; path: string }[] = [];
    let scanned = 0;
    const maxLevel = sd === '0' ? 0 : sd === '1' ? 1 : Infinity;
    const walk = async (n: Node, p: string, level: number) => {
      if (n.kind !== 'folder' || level >= maxLevel) return;
      for (const c of await this.tree.list(n)) {
        if (++scanned > this.o.maxResources) throw new DavPropsError(507, 'too many resources to search');
        const cp = `${p.replace(/\/+$/, '')}/${c.name}`;
        rows.push({ n: c, path: cp });
        await walk(c, cp, level + 1);
      }
    };
    await walk(start, scopePath, 0);
    let hits = rows.filter((r) => test(r.n));
    for (const ord of [...orders].reverse()) {
      const read = PROP_READERS[ord.prop]!;
      hits = [...hits].sort((a, b) => {
        const x = read(a.n);
        const y = read(b.n);
        const c = x === undefined ? (y === undefined ? 0 : -1) : y === undefined ? 1 : x < y ? -1 : x > y ? 1 : 0;
        return ord.desc ? -c : c;
      });
    }
    const truncated = hits.length > cap;
    hits = hits.slice(0, cap);
    const out: Out[] = [];
    for (const r of hits) out.push(this.response(hrefFor(ctx.base, r.path, r.n.kind === 'folder'), await this.select(r.n, ctx, req)));
    if (truncated) out.push(el(DAV, 'response', [el(DAV, 'href', hrefFor(ctx.base, scopePath, true)), el(DAV, 'status', statusLine(507))]));
    return xmlResponse(207, writeXml(el(DAV, 'multistatus', out), PREFIXES));
  }
}

// --- search expressions ---------------------------------------------------------------------------------------

type Value = string | number | undefined;
const PROP_READERS: Record<string, (n: Node) => Value> = {
  displayname: (n) => n.name,
  getcontentlength: (n) => (n.kind === 'file' ? n.size : undefined),
  getlastmodified: (n) => n.mtime * 1000,
  getcontenttype: (n) => (n.kind === 'folder' ? 'httpd/unix-directory' : (n.mime ?? 'application/octet-stream')),
};
const NUMERIC = new Set(['getcontentlength', 'getlastmodified']);

/** LIKE without regular expressions: % any run, _ one character, backslash escapes. Linear in the text per wildcard. */
export function like(text: string, pattern: string): boolean {
  const t = [...text];
  const toks: { any?: true; one?: true; ch?: string }[] = [];
  const p = [...pattern];
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '\\' && i + 1 < p.length) toks.push({ ch: p[++i]! });
    else if (p[i] === '%') {
      if (!toks.length || !toks[toks.length - 1]!.any) toks.push({ any: true });
    } else if (p[i] === '_') toks.push({ one: true });
    else toks.push({ ch: p[i]! });
  }
  let ti = 0;
  let pi = 0;
  let star = -1;
  let mark = 0;
  while (ti < t.length) {
    const tok = toks[pi];
    if (tok && (tok.one || (tok.ch !== undefined && tok.ch === t[ti]))) (pi++, ti++);
    else if (tok?.any) (star = pi++, (mark = ti));
    else if (star >= 0) (pi = star + 1, (ti = ++mark));
    else return false;
  }
  while (toks[pi]?.any) pi++;
  return pi === toks.length;
}

function compile(e: El | undefined, level: number): (n: Node) => boolean {
  const bad = (m: string) => new DavPropsError(400, m);
  if (!e) throw bad('an operator is missing');
  if (level > 16) throw bad('the where clause is nested too deeply');
  if (e.ns !== DAV) throw bad(`${e.name} is not a DAV: operator`);
  const arg = (): { prop: string; lit: string; caseless: boolean } => {
    const p = e.children.find((c) => c.ns === DAV && c.name === 'prop')?.children[0];
    const lit = e.children.find((c) => c.ns === DAV && c.name === 'literal');
    if (!p || !lit || p.ns !== DAV || !(p.name in PROP_READERS)) throw bad(`${e.name} compares displayname, getcontentlength, getlastmodified or getcontenttype with a literal`);
    if (lit.text.length > 256) throw bad('a literal is at most 256 characters');
    return { prop: p.name, lit: lit.text, caseless: (lit.attrs['caseless'] ?? e.attrs['caseless']) === 'yes' };
  };
  const kids = () => e.children.map((c) => compile(c, level + 1));
  switch (e.name) {
    case 'and': {
      const f = kids();
      if (!f.length) throw bad('and needs operands');
      return (n) => f.every((x) => x(n));
    }
    case 'or': {
      const f = kids();
      if (!f.length) throw bad('or needs operands');
      return (n) => f.some((x) => x(n));
    }
    case 'not': {
      const f = kids();
      if (f.length !== 1) throw bad('not needs one operand');
      return (n) => !f[0]!(n);
    }
    case 'is-collection':
      return (n) => n.kind === 'folder';
    case 'is-defined': {
      const p = e.children.find((c) => c.name === 'prop')?.children[0];
      if (!p || p.ns !== DAV || !(p.name in PROP_READERS)) throw bad('is-defined needs a supported property');
      const r = PROP_READERS[p.name]!;
      return (n) => r(n) !== undefined;
    }
    case 'eq': case 'lt': case 'lte': case 'gt': case 'gte': {
      const { prop, lit, caseless } = arg();
      const read = PROP_READERS[prop]!;
      let want: Value;
      if (NUMERIC.has(prop)) {
        want = prop === 'getcontentlength' ? Number(lit) : Date.parse(lit);
        if (lit.trim() === '' || Number.isNaN(want)) throw bad(`${lit.slice(0, 40)} is not a valid ${prop === 'getcontentlength' ? 'number' : 'date'}`);
      } else want = caseless ? lit.toLowerCase() : lit;
      return (n) => {
        let v = read(n);
        if (v === undefined) return false;
        if (caseless && typeof v === 'string') v = v.toLowerCase();
        const c = v < want! ? -1 : v > want! ? 1 : 0;
        return e.name === 'eq' ? c === 0 : e.name === 'lt' ? c < 0 : e.name === 'lte' ? c <= 0 : e.name === 'gt' ? c > 0 : c >= 0;
      };
    }
    case 'like': {
      const { prop, lit, caseless } = arg();
      if (NUMERIC.has(prop)) throw bad('like applies to text properties');
      const pat = caseless ? lit.toLowerCase() : lit;
      const read = PROP_READERS[prop]!;
      return (n) => {
        const v = read(n);
        return typeof v === 'string' && like(caseless ? v.toLowerCase() : v, pat);
      };
    }
    default:
      throw bad(`the operator ${e.name} is not supported`);
  }
}
