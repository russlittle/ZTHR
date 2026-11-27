/**
 * The OCS API Nextcloud's apps call alongside WebDAV: what the server can do, who is signed in and their space,
 * sharing, managing people (for admins), and app passwords. Version 1 answers 200 with the outcome in the body;
 * version 2 answers with the real HTTP status. JSON when asked for, XML otherwise.
 */
import { ALL, READ, type Grant } from '../../intent/blocks/grants/index.ts';
import { NotFound } from '../../intent/blocks/tree/index.ts';
import { Denied, type Files } from './app.ts';
import { fields, header, statusOf, type Reply, type Req } from './http.ts';
import { mimeOf } from './mime.ts';

export const VERSION = { major: 32, minor: 0, micro: 0, string: '32.0.0', edition: '', extendedSupport: false };

type Data = unknown;

function toXml(v: Data, tag: string): string {
  if (Array.isArray(v)) return `<${tag}>${v.map((x) => toXml(x, 'element')).join('')}</${tag}>`;
  if (v && typeof v === 'object') return `<${tag}>${Object.entries(v as Record<string, unknown>).map(([k, x]) => toXml(x, /^[a-zA-Z_][\w.-]*$/.test(k) ? k : 'element')).join('')}</${tag}>`;
  if (v === null || v === undefined || v === '') return `<${tag}/>`;
  return `<${tag}>${String(v).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!)}</${tag}>`;
}

export function ocs(r: Req, v: 1 | 2, status: number, data: Data, message = ''): Reply {
  const ok = status >= 200 && status < 300;
  const code = ok ? (v === 1 ? 100 : 200) : v === 1 ? ({ 400: 400, 401: 997, 403: 403, 404: 998 } as Record<number, number>)[status] ?? 996 : status;
  const meta = { status: ok ? 'ok' : 'failure', statuscode: code, message: message || (ok ? 'OK' : ''), totalitems: '', itemsperpage: '' };
  const asJson = r.url.searchParams.get('format') === 'json' || (header(r, 'accept') ?? '').includes('application/json');
  const http = v === 1 ? (status === 401 ? 401 : 200) : status;
  if (asJson) return { status: http, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ ocs: { meta, data: ok ? data : [] } }) };
  return { status: http, headers: { 'content-type': 'text/xml; charset=UTF-8' }, body: `<?xml version="1.0"?>\n<ocs>${toXml(meta, 'meta')}${toXml(ok ? data : [], 'data')}</ocs>\n` };
}

export function capabilities(files: Files) {
  return {
    version: VERSION,
    capabilities: {
      core: { pollinterval: 60, 'webdav-root': 'remote.php/webdav', 'reference-api': false, 'mod-rewrite-working': true },
      dav: { chunking: '1.0', bulkupload: '', 'absence-supported': false, 'absence-replacement': false },
      files: { bigfilechunking: true, blacklisted_files: ['.htaccess'], forbidden_filenames: ['.htaccess'], forbidden_filename_characters: ['\\', '/'], forbidden_filename_extensions: [' ', '.part', '.filepart'], undelete: true, versioning: true, version_labeling: false, version_deletion: false, chunked_upload: { max_size: files.maxChunk, max_parallel_count: 5 } },
      files_sharing: {
        api_enabled: true,
        public: { enabled: true, password: { enforced: false, askForOptionalPassword: false }, expire_date: { enabled: true, enforced: false }, multiple_links: true, upload: false, upload_files_drop: false, send_mail: false, custom_tokens: false },
        resharing: true,
        user: { send_mail: false, expire_date: { enabled: true } },
        group_sharing: true,
        group: { enabled: true, expire_date: { enabled: true } },
        default_permissions: ALL,
        federation: { outgoing: false, incoming: false, expire_date: { enabled: false } },
        sharee: { query_lookup_default: false, always_show_unique: true },
      },
      theming: { name: 'Files', url: 'https://zthr.ai', slogan: 'Your files, on your own server', color: '#1f5f8b', 'color-text': '#ffffff', 'color-element': '#1f5f8b', 'color-element-bright': '#1f5f8b', 'color-element-dark': '#1f5f8b', logo: '', background: '', 'background-plain': true, 'background-default': true, logoheader: '', favicon: '' },
      user: { expose_categories: false },
      notifications: { 'ocs-endpoints': ['list', 'get', 'delete', 'delete-all'], push: [] },
    },
  };
}

const date = (ms: number | undefined) => (ms === undefined ? null : `${new Date(ms).toISOString().slice(0, 10)} 00:00:00`);

/** A share as the API returns it, with paths as the person asking sees them. */
async function shareJson(files: Files, g: Grant, viewer: string, origin: string) {
  const node = await files.tree.get(g.resource);
  const owner = node ? node.owner : g.by;
  const path = node ? await files.tree.pathOf(node) : '/';
  const parent = node?.parent ?? null;
  const viewPath = viewer === owner ? path : `/${node?.name ?? ''}`;
  return {
    id: String(g.id),
    share_type: g.kind === 'person' ? 0 : g.kind === 'group' ? 1 : 3,
    uid_owner: g.by,
    displayname_owner: files.person(g.by)?.display ?? g.by,
    permissions: g.permissions,
    can_edit: g.by === viewer,
    can_delete: g.by === viewer || g.to === viewer,
    stime: Math.floor(g.created / 1000),
    parent: null,
    expiration: date(g.expires),
    token: g.token ?? null,
    uid_file_owner: owner,
    note: g.note ?? '',
    label: g.label ?? '',
    displayname_file_owner: files.person(owner)?.display ?? owner,
    path: viewPath,
    item_type: g.resourceKind,
    mimetype: g.resourceKind === 'folder' ? 'httpd/unix-directory' : mimeOf(node?.name ?? ''),
    has_preview: false,
    storage_id: `home::${owner}`,
    storage: 1,
    item_source: g.resource,
    file_source: g.resource,
    file_parent: parent,
    file_target: `/${node?.name ?? ''}`,
    share_with: g.kind === 'link' ? (g.passwordHash ? '***redacted***' : null) : (g.to ?? null),
    share_with_displayname: g.kind === 'link' ? (g.label ?? '') : g.kind === 'person' ? (files.person(g.to ?? '')?.display ?? g.to) : g.to,
    password: g.passwordHash ? '***redacted***' : null,
    send_password_by_talk: false,
    url: g.token ? `${origin}/s/${g.token}` : undefined,
    mail_send: 0,
    hide_download: 0,
    attributes: null,
  };
}

const dateMs = (s: string | undefined) => {
  if (!s) return undefined;
  const t = Date.parse(s.length === 10 ? `${s}T23:59:59Z` : s);
  if (Number.isNaN(t)) throw new SyntaxError(`"${s}" is not a date`);
  return t;
};

export async function ocsRoute(files: Files, r: Req, v: 1 | 2, rest: string, origin: string): Promise<Reply> {
  const me = r.person;
  try {
    if (rest === '/cloud/capabilities') return ocs(r, v, 200, capabilities(files));
    if (!me) return ocs(r, v, 401, [], 'sign in first');
    if (rest === '/cloud/user' && r.method === 'GET') return ocs(r, v, 200, await userJson(files, me.id));
    if (rest.startsWith('/cloud/users')) return await provisioning(files, r, v, rest.slice('/cloud/users'.length));
    if (rest === '/cloud/groups' && r.method === 'GET') {
      if (!me.admin) return ocs(r, v, 403, [], 'only an admin lists groups');
      return ocs(r, v, 200, { groups: [...new Set(files.people().flatMap((p) => p.groups))].sort() });
    }
    if (rest === '/core/getapppassword' && r.method === 'GET') {
      if (r.device !== undefined) return ocs(r, v, 403, [], 'you are already using an app password');
      const { password } = await files.devices.issue(me.id, header(r, 'user-agent') ?? 'app');
      return ocs(r, v, 200, { apppassword: password });
    }
    if (rest === '/core/apppassword' && r.method === 'DELETE') {
      if (r.device === undefined) return ocs(r, v, 403, [], 'sign in with an app password to remove it');
      await files.devices.revoke(me.id, r.device);
      return ocs(r, v, 200, []);
    }
    if (rest.startsWith('/apps/notifications/')) return ocs(r, v, 200, []);
    if (rest.startsWith('/apps/files_sharing/api/v1/sharees')) {
      const q = (r.url.searchParams.get('search') ?? '').toLowerCase();
      const ppl = files.people().filter((p) => p.id !== me.id && (p.id.toLowerCase().includes(q) || p.display.toLowerCase().includes(q))).slice(0, 25);
      return ocs(r, v, 200, { exact: { users: [], groups: [], remotes: [] }, users: ppl.map((p) => ({ label: p.display, value: { shareType: 0, shareWith: p.id } })), groups: [], remotes: [] });
    }
    if (rest.startsWith('/apps/files_sharing/api/v1/shares')) return await shares(files, r, v, rest.slice('/apps/files_sharing/api/v1/shares'.length), origin);
    return ocs(r, v, 404, [], 'no such endpoint');
  } catch (e) {
    const s = statusOf(e);
    return ocs(r, v, s.status === 405 ? 400 : s.status, [], s.message);
  }
}

async function userJson(files: Files, id: string) {
  const p = files.person(id);
  if (!p) throw new NotFound(id);
  const used = await files.used(id);
  const free = await files.free(id);
  return {
    enabled: !p.disabled,
    id: p.id,
    lastLogin: 0,
    backend: 'Database',
    subadmin: [],
    quota: { free: free ?? -3, used, total: p.quota ?? -3, relative: p.quota ? Math.round((used / p.quota) * 10000) / 100 : 0, quota: p.quota ?? -3 },
    email: p.email ?? null,
    'display-name': p.display,
    displayname: p.display,
    phone: '',
    address: '',
    website: '',
    twitter: '',
    groups: p.groups,
    language: 'en',
    locale: '',
    backendCapabilities: { setDisplayName: true, setPassword: true },
  };
}

async function provisioning(files: Files, r: Req, v: 1 | 2, rest: string): Promise<Reply> {
  const me = r.person!;
  const parts = rest.split('/').filter(Boolean).map(decodeURIComponent);
  const [id, action] = parts;
  if (!id) {
    if (!me.admin) return ocs(r, v, 403, [], 'only an admin manages people');
    if (r.method === 'GET') {
      const q = (r.url.searchParams.get('search') ?? '').toLowerCase();
      return ocs(r, v, 200, { users: files.people().filter((p) => p.id.toLowerCase().includes(q)).map((p) => p.id) });
    }
    if (r.method === 'POST') {
      const f = await fields(r);
      const p = await files.addPerson(f['userid'] ?? '', f['password'] ?? '', { ...(f['displayName'] ? { display: f['displayName'] } : {}), ...(f['email'] ? { email: f['email'] } : {}), ...(f['quota'] ? { quota: quotaBytes(f['quota']) } : {}), groups: Object.entries(f).filter(([k2]) => k2.startsWith('groups')).map(([, x]) => x) });
      return ocs(r, v, 200, { id: p.id });
    }
    return ocs(r, v, 405, [], 'not allowed');
  }
  if (id !== me.id && !me.admin) return ocs(r, v, 403, [], 'only an admin sees other people');
  if (!files.state.doc.people[id]) return ocs(r, v, 404, [], 'no such person');
  if (r.method === 'GET' && !action) return ocs(r, v, 200, await userJson(files, id));
  if (r.method === 'PUT' && !action) {
    const f = await fields(r);
    const key = f['key'];
    const value = f['value'] ?? '';
    if (key === 'password') {
      // An app password is one device's key; it must not be able to take the whole account.
      if (r.device !== undefined) return ocs(r, v, 403, [], 'sign in with your account password to change it');
      await files.setPassword(id, value);
    }
    else if (key === 'displayname' || key === 'display') files.updatePerson(id, { display: value });
    else if (key === 'email') files.updatePerson(id, { email: value });
    else if (key === 'quota') {
      if (!me.admin) return ocs(r, v, 403, [], 'only an admin sets quotas');
      files.updatePerson(id, { quota: quotaBytes(value) });
    } else return ocs(r, v, 400, [], `cannot change ${key ?? 'that'}`);
    return ocs(r, v, 200, []);
  }
  if (!me.admin) return ocs(r, v, 403, [], 'only an admin does that');
  if (r.method === 'DELETE' && !action) {
    if (id === me.id) return ocs(r, v, 400, [], 'you cannot remove yourself');
    await files.removePerson(id);
    return ocs(r, v, 200, []);
  }
  if (r.method === 'PUT' && (action === 'disable' || action === 'enable')) {
    files.updatePerson(id, { disabled: action === 'disable' });
    return ocs(r, v, 200, []);
  }
  if (action === 'groups' && (r.method === 'POST' || r.method === 'DELETE')) {
    const g = (await fields(r))['groupid'];
    if (!g) return ocs(r, v, 400, [], 'name the group');
    const p = files.state.doc.people[id]!;
    files.updatePerson(id, { groups: r.method === 'POST' ? [...new Set([...p.groups, g])] : p.groups.filter((x) => x !== g) });
    return ocs(r, v, 200, []);
  }
  return ocs(r, v, 404, [], 'no such endpoint');
}

/** "5 GB", "500 MB", "none", "default", or bytes. */
export function quotaBytes(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (t === 'none' || t === 'default' || t === 'unlimited' || t === '') return null;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/.exec(t);
  if (!m) throw new SyntaxError(`"${s}" is not a quota`);
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[m[2] ?? 'b']!;
  return Math.round(Number(m[1]) * mult);
}

async function shares(files: Files, r: Req, v: 1 | 2, rest: string, origin: string): Promise<Reply> {
  const me = r.person!;
  const id = rest.split('/').filter(Boolean)[0];
  if (!id) {
    if (r.method === 'GET') {
      const q = r.url.searchParams;
      let list: Grant[];
      if (q.get('shared_with_me') === 'true') list = await files.sharesWith(me.id);
      else {
        list = await files.sharesBy(me.id);
        const path = q.get('path');
        if (path) {
          const { node } = await files.resolve(me.id, path);
          if (!node) throw new NotFound(path);
          const kids = q.get('subfiles') === 'true' ? new Set((await files.tree.list(node)).map((n) => n.id)) : new Set([node.id]);
          // Others' shares on the same items are listed only to whoever owns them, as Nextcloud does.
          list = (await files.grants.live((g) => kids.has(g.resource))).filter((g) => g.by === me.id || (q.get('reshares') === 'true' && node.owner === me.id));
        }
      }
      return ocs(r, v, 200, await Promise.all(list.map((g) => shareJson(files, g, me.id, origin))));
    }
    if (r.method === 'POST') {
      const f = await fields(r);
      const type = Number(f['shareType']);
      const kind = type === 0 ? 'person' : type === 1 ? 'group' : type === 3 ? 'link' : null;
      if (!kind) return ocs(r, v, 400, [], 'shares are with a person (0), a group (1) or by link (3)');
      const exp = dateMs(f['expireDate']);
      const g = await files.share(me.id, f['path'] ?? '', { kind, ...(f['shareWith'] ? { to: f['shareWith'] } : {}), ...(f['permissions'] ? { permissions: Number(f['permissions']) } : kind === 'link' ? { permissions: READ } : {}), ...(f['password'] ? { password: f['password'] } : {}), ...(exp !== undefined ? { expires: exp } : {}), ...(f['note'] ? { note: f['note'] } : {}), ...(f['label'] ? { label: f['label'] } : {}) });
      return ocs(r, v, 200, await shareJson(files, g, me.id, origin));
    }
    return ocs(r, v, 405, [], 'not allowed');
  }
  const g = await files.grants.get(Number(id));
  const node = g ? await files.tree.get(g.resource) : undefined;
  const mine = g && (g.by === me.id || node?.owner === me.id);
  const toMe = g && (g.to === me.id || (g.kind === 'group' && !!g.to && me.groups.includes(g.to)));
  if (!g || (!mine && !toMe)) return ocs(r, v, 404, [], 'no such share');
  if (r.method === 'GET') return ocs(r, v, 200, [await shareJson(files, g, me.id, origin)]);
  if (r.method === 'DELETE') {
    if (mine) await files.grants.revoke(g.id, g.by);
    else if (g.kind === 'person') await files.state.grants.delete(g.id);
    else throw new Denied('a group share cannot be left by one member');
    return ocs(r, v, 200, []);
  }
  if (r.method === 'PUT') {
    if (!mine) return ocs(r, v, 403, [], 'only whoever shared it changes a share');
    const f = await fields(r);
    // What the giver may give is what they have on the node now, never more; the owner's path means nothing in a
    // resharer's view, so it is worked out from the node and the grants that reach them.
    if (!node) return ocs(r, v, 404, [], 'what was shared is gone');
    const has = await files.permsOn(g.by, node);
    const exp = f['expireDate'] === '' ? null : dateMs(f['expireDate']);
    const next = await files.grants.update(g.id, g.by, has, { ...(f['permissions'] ? { permissions: Number(f['permissions']) } : {}), ...(f['password'] !== undefined ? { password: f['password'] === '' ? null : f['password'] } : {}), ...(exp !== undefined ? { expires: exp } : {}), ...(f['note'] !== undefined ? { note: f['note'] } : {}), ...(f['label'] !== undefined ? { label: f['label'] } : {}) });
    return ocs(r, v, 200, await shareJson(files, next, me.id, origin));
  }
  return ocs(r, v, 405, [], 'not allowed');
}
