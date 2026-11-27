/**
 * WebDAV as Nextcloud's clients speak it: files under /remote.php/dav/files/<user> (and the older
 * /remote.php/webdav), chunked uploads under /uploads, the trash under /trashbin and old copies under /versions.
 * Each answer carries the properties clients read to sync: ids, etags, permission letters, sizes, checksums.
 */
import { DAV, child, depth as depthOf, destination as davDestination, el, encodePath, httpDate, ifTokens, keyOf, multistatus, overwrite as overwriteOf, parseXml, propfindRequest, proppatchRequest, timeout, type Out, type PropRequest } from '../../intent/blocks/dav/index.ts';
import { parseChecksums, parseRange } from '../../intent/blocks/objects/index.ts';
import { NotFound, type Node } from '../../intent/blocks/tree/index.ts';
import type { Files, Where } from './app.ts';
import { davError, header, statusOf, stream, text, xml, type Reply, type Req } from './http.ts';
import { mimeOf } from './mime.ts';

export const OC = 'http://owncloud.org/ns';
export const NC = 'http://nextcloud.org/ns';
const PREFIXES = { [DAV]: 'd', [OC]: 'oc', [NC]: 'nc', 'http://sabredav.org/ns': 's' };
const k = (ns: string, n: string) => `{${ns}}${n}`;

/** The properties a bare PROPFIND (allprop) answers with. */
const ALLPROP = [k(DAV, 'getlastmodified'), k(DAV, 'getcontentlength'), k(DAV, 'resourcetype'), k(DAV, 'getetag'), k(DAV, 'getcontenttype'), k(DAV, 'quota-used-bytes'), k(DAV, 'quota-available-bytes')];

interface Seen {
  readonly href: string;
  readonly node: Node;
  readonly w: Where;
  readonly mountRoot: boolean;
  readonly isRoot: boolean;
  readonly user: string;
}

const pad = (id: number, instance: string) => `${String(id).padStart(8, '0')}${instance}`;

async function propValue(files: Files, s: Seen, key: string): Promise<Out | null> {
  const n = s.node;
  const [ns, name] = [key.slice(1, key.indexOf('}')), key.slice(key.indexOf('}') + 1)];
  const v = (t: string | number) => el(ns, name, String(t));
  switch (key) {
    case k(DAV, 'resourcetype'):
      return el(DAV, 'resourcetype', n.kind === 'folder' ? [el(DAV, 'collection')] : undefined);
    case k(DAV, 'getetag'):
      return v(`"${s.isRoot ? await files.rootEtag(s.user) : n.etag}"`);
    case k(DAV, 'getlastmodified'):
      return v(httpDate(n.mtime));
    case k(DAV, 'getcontentlength'):
      return n.kind === 'file' ? v(n.size) : null;
    case k(DAV, 'getcontenttype'):
      return n.kind === 'file' ? v(n.mime ?? mimeOf(n.name)) : v('httpd/unix-directory');
    case k(DAV, 'displayname'):
      return v(s.href.split('/').filter(Boolean).pop() ? decodeURIComponent(s.href.split('/').filter(Boolean).pop()!) : '');
    case k(DAV, 'quota-used-bytes'):
      return n.kind === 'folder' ? v(n.size) : null;
    case k(DAV, 'quota-available-bytes'): {
      if (n.kind !== 'folder') return null;
      const f = await files.free(s.w.owner);
      return v(f === undefined ? -3 : f);
    }
    case k(OC, 'id'):
      return v(pad(n.id, files.instance));
    case k(OC, 'fileid'):
      return v(n.id);
    case k(OC, 'permissions'):
      return v(files.letters(n, s.w, s.mountRoot));
    case k(OC, 'size'):
      return v(n.size);
    case k(OC, 'favorite'):
      return v(n.props?.[k(OC, 'favorite')] ?? '0');
    case k(OC, 'owner-id'):
      return v(n.owner);
    case k(OC, 'owner-display-name'):
      return v(files.person(n.owner)?.display ?? n.owner);
    case k(OC, 'share-types'): {
      const ts = await files.shareTypes(n);
      return el(OC, 'share-types', ts.map((t) => el(OC, 'share-type', String(t))));
    }
    case k(OC, 'checksums'):
      return n.checksums?.length ? el(OC, 'checksums', [el(OC, 'checksum', n.checksums.join(' '))]) : el(OC, 'checksums');
    case k(OC, 'comments-count'):
    case k(OC, 'comments-unread'):
      return v(0);
    case k(OC, 'comments-href'):
      return v(`/remote.php/dav/comments/files/${n.id}`);
    case k(OC, 'tags'):
      return el(OC, 'tags');
    case k(OC, 'downloadURL'):
      return v('');
    case k(OC, 'data-fingerprint'):
    case k(NC, 'data-fingerprint'):
      return v('');
    case k(NC, 'has-preview'):
      return v('false');
    case k(NC, 'mount-type'):
      return v(s.w.via ? 'shared' : '');
    case k(NC, 'is-mount-root'):
      return v(s.mountRoot ? 'true' : 'false');
    case k(NC, 'is-encrypted'):
      return v(0);
    case k(NC, 'hidden'):
      return v('false');
    case k(NC, 'creation_time'):
    case k(NC, 'upload_time'):
      return v(0);
    case k(NC, 'note'):
      return v(s.w.via?.grant.note ?? '');
    case k(NC, 'sharees'):
      return el(NC, 'sharees');
    case k(NC, 'rich-workspace'):
    case k(NC, 'rich-workspace-file'):
      return v('');
    case k(NC, 'contained-file-count'):
    case k(NC, 'contained-folder-count'): {
      if (n.kind !== 'folder') return null;
      const kids = await files.tree.list(n);
      return v(kids.filter((c) => (name === 'contained-file-count' ? c.kind === 'file' : c.kind === 'folder')).length);
    }
    case k(NC, 'lock'): {
      const l = await files.leases.heldOn(`/${s.w.owner}${s.w.path}`);
      return v(l ? 1 : 0);
    }
    case k(NC, 'lock-owner'):
    case k(NC, 'lock-owner-displayname'):
    case k(NC, 'lock-owner-type'):
    case k(NC, 'lock-time'):
    case k(NC, 'lock-timeout'): {
      const l = await files.leases.heldOn(`/${s.w.owner}${s.w.path}`);
      if (!l) return null;
      const val = name === 'lock-owner' ? l.owner : name === 'lock-owner-displayname' ? l.holder : name === 'lock-owner-type' ? 2 : name === 'lock-time' ? Math.floor(l.since / 1000) : l.until ? Math.floor((l.until - l.since) / 1000) : 0;
      return v(val);
    }
    default: {
      const custom = n.props?.[key];
      return custom === undefined ? null : v(custom);
    }
  }
}

async function answer(files: Files, s: Seen, req: PropRequest): Promise<{ status: number; props: Out[] }[]> {
  const keys = req.kind === 'prop' ? req.props.map(keyOf) : ALLPROP;
  if (req.kind === 'propname') return [{ status: 200, props: ALLPROP.map((x) => el(x.slice(1, x.indexOf('}')), x.slice(x.indexOf('}') + 1))) }];
  const found: Out[] = [];
  const missing: Out[] = [];
  for (const key of keys) {
    const o = await propValue(files, s, key);
    if (o) found.push(o);
    else missing.push(el(key.slice(1, key.indexOf('}')), key.slice(key.indexOf('}') + 1)));
  }
  return [
    { status: 200, props: found },
    { status: 404, props: missing },
  ];
}

/** The parts of a /remote.php/dav path: which collection, whose, and the rest. */
export interface DavPath {
  readonly area: 'files' | 'uploads' | 'trashbin' | 'versions' | 'root';
  readonly user: string;
  readonly rest: string;
  /** The URL prefix the rest hangs from, for hrefs and Destination headers. */
  readonly base: string;
}

export function davPath(path: string): DavPath | null {
  if (path === '/remote.php/webdav' || path.startsWith('/remote.php/webdav/')) return { area: 'files', user: '', rest: path.slice('/remote.php/webdav'.length) || '/', base: '/remote.php/webdav' };
  const m = /^\/remote\.php\/dav(?:\/(files|uploads|trashbin|versions)\/([^/]+))?(\/.*)?$/.exec(path);
  if (!m) return null;
  if (!m[1]) return { area: 'root', user: '', rest: '/', base: '/remote.php/dav' };
  const user = decodeURIComponent(m[2]!);
  return { area: m[1] as DavPath['area'], user, rest: m[3] ?? '/', base: `/remote.php/dav/${m[1]}/${encodePath(user)}` };
}

/**
 * The path a Destination header names under `base`. It must be `base` itself or below it: a name that only begins
 * like it (another person's folder, `/files/anabel` for `ana`) is not a path under it.
 */
function destination(h: string | undefined, host: string, base: string): string | null {
  const p = davDestination(h, host, base);
  return p !== null && p.startsWith('/') ? p : null;
}

const DAV_HEADERS = { dav: '1, 3, extended-mkcol, access-control, calendarserver-principal-property-search, nextcloud-checksum-update, nc-calendar-search, nc-enable-birthday-calendar', 'ms-author-via': 'DAV' };

export async function webdav(files: Files, r: Req, p: DavPath): Promise<Reply> {
  const user = r.person!.id;
  if (p.user && p.user !== user) return davError(403, 'you can only reach your own files here');
  const base = p.user ? p.base : '/remote.php/webdav';
  try {
    if (r.method === 'OPTIONS') return { status: 200, headers: { ...DAV_HEADERS, allow: 'OPTIONS, GET, HEAD, DELETE, PROPFIND, PUT, PROPPATCH, COPY, MOVE, REPORT, MKCOL, LOCK, UNLOCK' } };
    if (p.area === 'root') return xml(207, multistatus([{ href: '/remote.php/dav/', propstats: [{ status: 200, props: [el(DAV, 'resourcetype', [el(DAV, 'collection')])] }] }], PREFIXES));
    if (p.area === 'uploads') return await uploads(files, r, p, user);
    if (p.area === 'trashbin') return await trashbin(files, r, p, user);
    if (p.area === 'versions') return await versions(files, r, p, user);
    return await filesArea(files, r, decodeURIComponent(p.rest), user, base);
  } catch (e) {
    const s = statusOf(e);
    return davError(s.status, s.message);
  }
}

const hrefFor = (base: string, path: string, folder: boolean) => `${base}${encodePath(path === '/' ? '/' : path)}${folder && path !== '/' ? '/' : ''}`;

async function filesArea(files: Files, r: Req, path: string, user: string, base: string): Promise<Reply> {
  const tokens = ifTokens(header(r, 'if'));
  switch (r.method) {
    case 'PROPFIND': {
      const req = propfindRequest(await text(r));
      const d = depthOf(header(r, 'depth'), 1);
      if (d === 'infinity') return davError(403, 'depth infinity is not allowed; ask one level at a time');
      const { w, node } = await files.resolve(user, path);
      if (!node) throw new NotFound(path);
      const isRoot = path.replace(/\/+$/, '') === '';
      const mountRoot = !!w.via && path.split('/').filter(Boolean).length === 1;
      const out = [{ href: hrefFor(base, path.replace(/\/+$/, '') || '/', node.kind === 'folder'), propstats: await answer(files, { href: path, node, w, mountRoot, isRoot, user }, req) }];
      if (d === 1 && node.kind === 'folder')
        for (const c of await files.children(user, path)) {
          const cp = `${path.replace(/\/+$/, '')}/${c.name}`;
          out.push({ href: hrefFor(base, cp, c.node.kind === 'folder'), propstats: await answer(files, { href: cp, node: c.node, w: c.w, mountRoot: !!c.w.via && isRoot, isRoot: false, user }, req) });
        }
      return xml(207, multistatus(out, PREFIXES));
    }
    case 'GET':
    case 'HEAD': {
      const { node } = await files.resolve(user, path);
      if (!node) throw new NotFound(path);
      if (node.kind === 'folder') return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'This is a folder. Open it with a Nextcloud app or a WebDAV client.\n' };
      const range = parseRange(header(r, 'range'), node.size);
      const common = { etag: `"${node.etag}"`, 'oc-etag': `"${node.etag}"`, 'oc-fileid': pad(node.id, files.instance), 'last-modified': httpDate(node.mtime), 'accept-ranges': 'bytes', 'content-type': node.mime ?? mimeOf(node.name), 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(node.name)}`, ...(node.checksums?.length ? { 'oc-checksum': node.checksums[0]! } : {}) };
      if (range === 'unsatisfiable') return { status: 416, headers: { 'content-range': `bytes */${node.size}` } };
      if (range) return { status: 206, headers: { ...common, 'content-range': `bytes ${range.start}-${range.end}/${node.size}`, 'content-length': String(range.end - range.start + 1) }, body: r.method === 'HEAD' ? '' : await files.objects.get(node.blob!, range) };
      return { status: 200, headers: { ...common, 'content-length': String(node.size) }, body: r.method === 'HEAD' || node.size === 0 ? '' : await files.objects.get(node.blob!) };
    }
    case 'PUT': {
      if (path.endsWith('/')) return davError(400, 'a file name is needed');
      const len = Number(header(r, 'content-length') ?? header(r, 'oc-total-length') ?? NaN);
      await files.mayWrite(user, path, tokens);
      const { w } = await files.resolve(user, path);
      // Old versions and the trash give way to new files, so what counts here is the room they could make.
      const free = await files.room(w.owner);
      const existing = (await files.tree.resolve(w.owner, w.path))?.size ?? 0;
      if (free !== undefined && Number.isFinite(len) && len > free + existing) return davError(507, `needs ${len} bytes, ${free} free`);
      const blob = await files.objects.put(stream(r), free !== undefined ? { maxBytes: free + existing } : {});
      const mtime = Number(header(r, 'x-oc-mtime'));
      const want = parseChecksums(header(r, 'oc-checksum'));
      for (const c of want.filter((x) => x.startsWith('SHA1:') || x.startsWith('MD5:') || x.startsWith('ADLER32:')))
        if (!blob.checksums.includes(c)) {
          await files.objects.delete(blob.key);
          return davError(400, `the checksum sent (${c}) does not match the bytes received`);
        }
      const { node, created } = await files.commitFile(user, path, blob, { ...(mtime > 0 ? { mtime: Math.floor(mtime) } : {}), ...(want.length ? { checksum: want } : {}), ifMatch: header(r, 'if-match') ?? null, ifNoneMatch: header(r, 'if-none-match') ?? null, tokens });
      return { status: created ? 201 : 204, headers: { etag: `"${node.etag}"`, 'oc-etag': `"${node.etag}"`, 'oc-fileid': pad(node.id, files.instance), ...(mtime > 0 ? { 'x-oc-mtime': 'accepted' } : {}) } };
    }
    case 'MKCOL': {
      if (Number(header(r, 'content-length') ?? 0) > 0) return davError(415, 'MKCOL with a body is not supported');
      const n = await files.mkdir(user, path);
      return { status: 201, headers: { 'oc-fileid': pad(n.id, files.instance) } };
    }
    case 'DELETE':
      await files.remove(user, path, tokens);
      return { status: 204 };
    case 'MOVE':
    case 'COPY': {
      const to = destination(header(r, 'destination'), header(r, 'host') ?? '', base);
      if (!to) return davError(400, 'the Destination header must name a path on this server, under your files');
      const ow = overwriteOf(header(r, 'overwrite'));
      const out = r.method === 'MOVE' ? await files.move(user, path, to, ow, tokens) : await files.copy(user, path, to, ow, tokens);
      return { status: out.created ? 201 : 204, headers: { etag: `"${out.node.etag}"`, 'oc-etag': `"${out.node.etag}"`, 'oc-fileid': pad(out.node.id, files.instance) } };
    }
    case 'PROPPATCH': {
      const { set, remove } = proppatchRequest(await text(r));
      const { w, node } = await files.resolve(user, path);
      if (!node) throw new NotFound(path);
      const writable = (ns: string) => ns === OC || ns === NC || (ns !== DAV && !!ns);
      const ok: Out[] = [];
      const refused: Out[] = [];
      const setMap: Record<string, string> = {};
      const clear: string[] = [];
      let mtime: number | undefined;
      for (const s of set) {
        if (s.ns === DAV && s.name === 'lastmodified') {
          const t = Date.parse(s.value);
          mtime = Number.isNaN(t) ? Number(s.value) : Math.floor(t / 1000);
          ok.push(el(DAV, s.name));
        } else if (writable(s.ns) && !(s.ns === OC && ['fileid', 'id', 'permissions', 'size'].includes(s.name))) {
          setMap[`{${s.ns}}${s.name}`] = s.value;
          ok.push(el(s.ns, s.name));
        } else refused.push(el(s.ns, s.name));
      }
      for (const x of remove) {
        clear.push(`{${x.ns}}${x.name}`);
        ok.push(el(x.ns, x.name));
      }
      if (refused.length) return xml(207, multistatus([{ href: hrefFor(base, path, node.kind === 'folder'), propstats: [{ status: 403, props: refused }, { status: 424, props: ok }] }], PREFIXES));
      if (Object.keys(setMap).length || clear.length) await files.tree.setProps(w.owner, w.path, setMap, clear);
      if (mtime && Number.isFinite(mtime)) await files.tree.touch(w.owner, w.path, mtime);
      return xml(207, multistatus([{ href: hrefFor(base, path, node.kind === 'folder'), propstats: [{ status: 200, props: ok }] }], PREFIXES));
    }
    case 'LOCK': {
      const body = await text(r);
      const { w, node } = await files.resolve(user, path);
      if (!node) throw new NotFound(path);
      const ms = timeout(header(r, 'timeout'), 30 * 60_000);
      if (!body.trim()) {
        const t = tokens[0];
        if (!t) return davError(400, 'a lock refresh names its token in the If header');
        const l = await files.leases.refresh(t, ms);
        return xml(200, lockXml(l, base, path), { 'lock-token': `<${l.token}>` });
      }
      const info = parseXml(body);
      const owner = info && child(info, DAV, 'owner');
      const holder = owner ? (child(owner, DAV, 'href')?.text ?? owner.text).trim() || r.person!.display : r.person!.display;
      const l = await files.leases.acquire(`/${w.owner}${w.path}`, user, { holder, deep: depthOf(header(r, 'depth'), 'infinity') !== 0 && node.kind === 'folder', ms });
      return xml(200, lockXml(l, base, path), { 'lock-token': `<${l.token}>` });
    }
    case 'UNLOCK': {
      const t = (header(r, 'lock-token') ?? '').replace(/[<>]/g, '').trim();
      if (!t) return davError(400, 'UNLOCK names its token in the Lock-Token header');
      await files.leases.release(t, user);
      return { status: 204 };
    }
    case 'REPORT': {
      const body = parseXml(await text(r));
      if (body.ns === OC && body.name === 'filter-files') {
        const rules = child(body, OC, 'filter-rules');
        const wantFav = rules && child(rules, OC, 'favorite')?.text.trim() === '1';
        const prop = child(body, DAV, 'prop');
        const req: PropRequest = prop ? { kind: 'prop', props: prop.children.map((c) => ({ ns: c.ns, name: c.name })) } : { kind: 'allprop' };
        const { w, node } = await files.resolve(user, path);
        if (!node) throw new NotFound(path);
        const hits = (await files.tree.descendants(node)).filter((n) => !wantFav || n.props?.[k(OC, 'favorite')] === '1');
        const out = [];
        for (const n of hits) {
          const np = `${path.replace(/\/+$/, '')}${(await files.tree.pathOf(n)).slice((await files.tree.pathOf(node)).length) || ''}`;
          out.push({ href: hrefFor(base, np, n.kind === 'folder'), propstats: await answer(files, { href: np, node: n, w: { ...w, path: await files.tree.pathOf(n) }, mountRoot: false, isRoot: false, user }, req) });
        }
        return xml(207, multistatus(out, PREFIXES));
      }
      return davError(415, `the ${body.name} report is not supported`);
    }
    default:
      return davError(405, `${r.method} is not supported here`);
  }
}

function lockXml(l: { token: string; owner: string; holder: string; deep: boolean; until: number; since: number }, base: string, path: string): string {
  const secs = l.until ? Math.max(1, Math.round((l.until - Date.now()) / 1000)) : 0;
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype><d:depth>${l.deep ? 'infinity' : '0'}</d:depth><d:owner>${l.holder.replace(/[<>&]/g, '')}</d:owner><d:timeout>${secs ? `Second-${secs}` : 'Infinite'}</d:timeout><d:locktoken><d:href>${l.token}</d:href></d:locktoken><d:lockroot><d:href>${encodePath(`${base}${path}`)}</d:href></d:lockroot></d:activelock></d:lockdiscovery></d:prop>`;
}

// ---------------------------------------------------------------- chunked uploads (v2)

async function uploads(files: Files, r: Req, p: DavPath, user: string): Promise<Reply> {
  const parts = p.rest.split('/').filter(Boolean).map(decodeURIComponent);
  const [id, name] = parts;
  const dest = (h: string | undefined) => destination(h, header(r, 'host') ?? '', `/remote.php/dav/files/${encodePath(user)}`);
  const total = header(r, 'oc-total-length') ? Number(header(r, 'oc-total-length')) : undefined;
  if (!id) {
    if (r.method === 'PROPFIND') return xml(207, multistatus([{ href: `${p.base}/`, propstats: [{ status: 200, props: [el(DAV, 'resourcetype', [el(DAV, 'collection')])] }] }], PREFIXES));
    return davError(405, 'name an upload folder');
  }
  switch (r.method) {
    case 'MKCOL': {
      const to = dest(header(r, 'destination')) ?? '/';
      if (header(r, 'destination')) await files.mayWrite(user, to);
      await files.uploads.start(user, id, to, total);
      return { status: 201 };
    }
    case 'PUT': {
      if (!name) return davError(400, 'name the chunk');
      if (!(await files.uploads.received(user, id).catch(() => null))) {
        // Clients that skipped MKCOL still get a session, as long as they say where the file goes.
        const to = dest(header(r, 'destination'));
        if (!to) return davError(404, 'no such upload; create it with MKCOL first');
        await files.uploads.start(user, id, to, total);
      }
      // The chunks together may not pass the declared total, nor the room the person has: checked from the
      // chunk's length before its bytes are kept, and again from what arrived when it had no length.
      const over = async (incoming: number): Promise<Reply | null> => {
        const sess = files.state.doc.sessions[`${user}\u0000${id}`];
        const others = Object.entries(sess?.chunks ?? {}).reduce((a, [n, c]) => (Number(n) === Number(name) ? a : a + c.size), 0);
        const declared = total ?? sess?.totalLength;
        if (declared !== undefined && others + incoming > declared) return davError(400, `the chunks come to more than the ${declared} bytes declared`);
        const room = await files.room(user);
        if (room !== undefined && others + incoming > room) return davError(507, `needs ${others + incoming} bytes, ${room} free`);
        return null;
      };
      const len = Number(header(r, 'content-length'));
      const early = Number.isFinite(len) ? await over(len) : null;
      if (early) return early;
      const got = await files.uploads.chunk(user, id, name, stream(r), total);
      const late = await over(got.size);
      if (late) {
        await files.uploads.abort(user, id);
        return late;
      }
      return { status: 201 };
    }
    case 'MOVE': {
      if (name !== '.file') return davError(400, 'assemble by moving the upload’s .file');
      const to = dest(header(r, 'destination'));
      if (!to) return davError(400, 'the Destination header must name a path under your files');
      const w = await files.uploads.assemble(user, id, total);
      const mtime = Number(header(r, 'x-oc-mtime'));
      const want = parseChecksums(header(r, 'oc-checksum'));
      const { node, created } = await files.commitFile(user, to, w, { ...(mtime > 0 ? { mtime: Math.floor(mtime) } : {}), ...(want.length ? { checksum: want } : {}), ifMatch: header(r, 'if-match') ?? null, ifNoneMatch: header(r, 'if-none-match') ?? null, tokens: ifTokens(header(r, 'if')) });
      return { status: created ? 201 : 204, headers: { etag: `"${node.etag}"`, 'oc-etag': `"${node.etag}"`, 'oc-fileid': pad(node.id, files.instance), ...(mtime > 0 ? { 'x-oc-mtime': 'accepted' } : {}) } };
    }
    case 'DELETE':
      await files.uploads.abort(user, id);
      return { status: 204 };
    case 'PROPFIND': {
      const got = await files.uploads.received(user, id);
      return xml(207, multistatus([{ href: `${p.base}/${encodePath(id)}/`, propstats: [{ status: 200, props: [el(DAV, 'resourcetype', [el(DAV, 'collection')])] }] }, ...got.map((c) => ({ href: `${p.base}/${encodePath(id)}/${String(c.n).padStart(5, '0')}`, propstats: [{ status: 200, props: [el(DAV, 'getcontentlength', String(c.size)), el(DAV, 'resourcetype')] }] }))], PREFIXES));
    }
    default:
      return davError(405, `${r.method} is not supported for uploads`);
  }
}

// ---------------------------------------------------------------- the trash

async function trashbin(files: Files, r: Req, p: DavPath, user: string): Promise<Reply> {
  const parts = p.rest.split('/').filter(Boolean).map(decodeURIComponent);
  const [area, id] = parts;
  if (area === 'restore' && r.method === 'PROPFIND') return xml(207, multistatus([{ href: `${p.base}/restore/`, propstats: [{ status: 200, props: [el(DAV, 'resourcetype', [el(DAV, 'collection')])] }] }], PREFIXES));
  if (area !== 'trash' && area !== undefined) return davError(404, 'nothing here');
  if (r.method === 'PROPFIND') {
    const req = propfindRequest(await text(r));
    const list = files.trashOf(user).filter((t) => !id || t.id === id);
    if (id && !list.length) throw new NotFound(id);
    const item = (t: ReturnType<Files['trashOf']>[number]): { href: string; propstats: { status: number; props: Out[] }[] } => {
      const n = t.nodes[0]!;
      const all: Record<string, Out> = {
        [k(NC, 'trashbin-filename')]: el(NC, 'trashbin-filename', t.name),
        [k(NC, 'trashbin-original-location')]: el(NC, 'trashbin-original-location', t.original.replace(/^\//, '')),
        [k(NC, 'trashbin-deletion-time')]: el(NC, 'trashbin-deletion-time', String(Math.floor(t.deletedAt / 1000))),
        [k(DAV, 'getcontentlength')]: el(DAV, 'getcontentlength', String(n.size)),
        [k(OC, 'size')]: el(OC, 'size', String(n.size)),
        [k(DAV, 'resourcetype')]: el(DAV, 'resourcetype', n.kind === 'folder' ? [el(DAV, 'collection')] : undefined),
        [k(OC, 'fileid')]: el(OC, 'fileid', String(n.id)),
        [k(OC, 'id')]: el(OC, 'id', pad(n.id, files.instance)),
        [k(DAV, 'getlastmodified')]: el(DAV, 'getlastmodified', httpDate(n.mtime)),
        [k(DAV, 'getetag')]: el(DAV, 'getetag', `"${n.etag}"`),
        [k(DAV, 'getcontenttype')]: el(DAV, 'getcontenttype', n.kind === 'folder' ? 'httpd/unix-directory' : mimeOf(n.name)),
        [k(OC, 'permissions')]: el(OC, 'permissions', 'GD'),
        [k(NC, 'has-preview')]: el(NC, 'has-preview', 'false'),
      };
      const keys = req.kind === 'prop' ? req.props.map(keyOf) : Object.keys(all);
      return { href: `${p.base}/trash/${encodePath(t.id)}`, propstats: [{ status: 200, props: keys.filter((x) => all[x]).map((x) => all[x]!) }, { status: 404, props: keys.filter((x) => !all[x]).map((x) => el(x.slice(1, x.indexOf('}')), x.slice(x.indexOf('}') + 1))) }] };
    };
    const head = { href: `${p.base}/trash/`, propstats: [{ status: 200, props: [el(DAV, 'resourcetype', [el(DAV, 'collection')])] }] };
    return xml(207, multistatus(id ? list.map(item) : depthOf(header(r, 'depth'), 1) === 0 ? [head] : [head, ...list.map(item)], PREFIXES));
  }
  if (r.method === 'MOVE' && id) {
    const to = destination(header(r, 'destination'), header(r, 'host') ?? '', `/remote.php/dav/trashbin/${encodePath(user)}/restore`);
    const filesTo = destination(header(r, 'destination'), header(r, 'host') ?? '', `/remote.php/dav/files/${encodePath(user)}`);
    if (!to && !filesTo) return davError(400, 'restore by moving into restore/, or to a path under your files');
    const n = await files.restoreTrash(user, id, filesTo ?? undefined);
    return { status: 201, headers: { 'oc-fileid': pad(n.id, files.instance) } };
  }
  if (r.method === 'DELETE') {
    if (!id) {
      await files.emptyTrash(user);
      return { status: 204 };
    }
    const t = files.trashOf(user).find((x) => x.id === id);
    if (!t) throw new NotFound(id);
    await files.purgeTrash(t);
    return { status: 204 };
  }
  return davError(405, `${r.method} is not supported in the trash`);
}

// ---------------------------------------------------------------- versions

async function versions(files: Files, r: Req, p: DavPath, user: string): Promise<Reply> {
  const parts = p.rest.split('/').filter(Boolean).map(decodeURIComponent);
  const [area, fid, vid] = parts;
  if (area === 'restore') {
    if (r.method === 'PROPFIND') return xml(207, multistatus([{ href: `${p.base}/restore/`, propstats: [{ status: 200, props: [el(DAV, 'resourcetype', [el(DAV, 'collection')])] }] }], PREFIXES));
    return davError(405, 'restore by moving a version here');
  }
  if (area !== 'versions' || !fid) return davError(404, 'name a file id under versions/');
  const node = await files.tree.get(Number(fid));
  if (!node || node.kind !== 'file') throw new NotFound(fid);
  const may = (await files.permsOn(user, node)) > 0;
  if (!may) throw new NotFound(fid);
  const list = files.versionsOf(node.id);
  if (r.method === 'PROPFIND') {
    const req = propfindRequest(await text(r));
    const one = (v: (typeof list)[number]) => {
      const all: Record<string, Out> = {
        [k(DAV, 'getcontentlength')]: el(DAV, 'getcontentlength', String(v.size)),
        [k(DAV, 'getlastmodified')]: el(DAV, 'getlastmodified', httpDate(v.mtime)),
        [k(DAV, 'getetag')]: el(DAV, 'getetag', `"${v.etag}"`),
        [k(DAV, 'getcontenttype')]: el(DAV, 'getcontenttype', mimeOf(node.name)),
        [k(DAV, 'resourcetype')]: el(DAV, 'resourcetype'),
        [k(NC, 'version-author')]: el(NC, 'version-author', v.author),
        [k(NC, 'version-label')]: el(NC, 'version-label', ''),
        [k(NC, 'has-preview')]: el(NC, 'has-preview', 'false'),
      };
      const keys = req.kind === 'prop' ? req.props.map(keyOf) : Object.keys(all);
      return { href: `${p.base}/versions/${fid}/${encodePath(v.id)}`, propstats: [{ status: 200, props: keys.filter((x) => all[x]).map((x) => all[x]!) }, { status: 404, props: keys.filter((x) => !all[x]).map((x) => el(x.slice(1, x.indexOf('}')), x.slice(x.indexOf('}') + 1))) }] };
    };
    const head = { href: `${p.base}/versions/${fid}/`, propstats: [{ status: 200, props: [el(DAV, 'resourcetype', [el(DAV, 'collection')])] }] };
    return xml(207, multistatus(vid ? list.filter((v) => v.id === vid).map(one) : [head, ...list.map(one)], PREFIXES));
  }
  const v = list.find((x) => x.id === vid);
  if (!v) throw new NotFound(vid ?? '');
  if (r.method === 'GET' || r.method === 'HEAD') return { status: 200, headers: { 'content-type': mimeOf(node.name), 'content-length': String(v.size), etag: `"${v.etag}"` }, body: r.method === 'HEAD' ? '' : await files.objects.get(v.blob) };
  if (r.method === 'MOVE') {
    const n = await files.restoreVersion(user, node.id, v.id);
    return { status: 204, headers: { etag: `"${n.etag}"`, 'oc-etag': `"${n.etag}"` } };
  }
  return davError(405, `${r.method} is not supported for versions`);
}
