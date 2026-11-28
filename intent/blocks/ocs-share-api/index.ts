/**
 * The sharing API of Nextcloud's OCS interface (/ocs/v1.php and /ocs/v2.php, apps/files_sharing/api/v1/shares),
 * answered over the grants block: create a share with a person, a group or a public link; list them (a path's, the
 * ones shared with me, the ones inside a folder); read, change and delete one. A share is a grant; this block is
 * the wire shape, not another store.
 *
 * Shape as Nextcloud has it: shareType 0 person, 1 group, 3 public link (others are answered 400 "unsupported",
 * since there is no grant to map them onto); permissions are the bitmask read 1, update 2, create 4, delete 8, share
 * 16 (a file never holds create or delete; a link never holds share; `publicUpload=true` on a folder link means
 * read, update, create and delete); `expireDate` is a day YYYY-MM-DD, shown as "YYYY-MM-DD 00:00:00", and a share
 * works through the whole of that day (UTC); ids are strings; links have a 15-character token and a url under
 * /s/<token>. The envelope is `ocs.meta` plus `ocs.data`, as JSON when the request says `format=json` or accepts
 * application/json, otherwise as XML. v2 answers with the real HTTP status; v1 always answers HTTP 200 with the
 * status in the meta, 100 for success.
 *
 * Refused up front, with the status Nextcloud uses: a missing `OCS-APIRequest: true` header (412, the cross-site
 * request check), a path that does not exist or the caller cannot see (404), a caller who may not share it or would
 * give more than they have (403), an unknown person or group (404), a link password on a person share (400), an
 * expiry in the past or beyond the configured maximum (400), and a share that is not the caller's (404, so ids of
 * other people's shares are not confirmed). Passwords are never returned.
 *
 * Out of scope: authentication (the caller passes the signed-in user), shares by e-mail, federated and circle
 * shares, share notifications, and the public page that opens a link (use `Grants.open`).
 */
import { ALL, FILE_MAX, READ, SHARE, UPDATE, CREATE, DELETE, Refused } from '../grants/index.ts';
import type { Grant, Grants } from '../grants/index.ts';

export { READ, UPDATE, CREATE, DELETE, SHARE, ALL, FILE_MAX };

export const SHARE_USER = 0;
export const SHARE_GROUP = 1;
export const SHARE_LINK = 3;

/** What the file system behind the shares tells this block. Paths are as the signed-in person sees them. */
export interface Target {
  readonly id: number;
  readonly kind: 'file' | 'folder';
  readonly path: string;
  readonly owner: string;
  readonly mimetype?: string;
}

export interface Env {
  /** The item at a path as `user` sees it; undefined when it does not exist or they cannot see it. */
  find(user: string, path: string): Promise<Target | undefined>;
  byId(id: number): Promise<Target | undefined>;
  /** What `user` may do with the item: their own rights, through ownership or shares to them. */
  permissionsOf(user: string, id: number): Promise<number>;
  /** Ids of the items directly inside a folder. */
  children?(id: number): Promise<readonly number[]>;
  userExists(id: string): Promise<boolean>;
  groupExists(id: string): Promise<boolean>;
  groupsOf(user: string): Promise<readonly string[]>;
  displayName(user: string): Promise<string>;
}

export interface OcsOptions {
  /** Public address of the server, for link urls: https://cloud.example.org */
  readonly baseUrl: string;
  readonly now?: () => number;
  /** Require the OCS-APIRequest header (default true). */
  readonly requireHeader?: boolean;
  /** Longest a link may live, in days; a link without an expiry is refused when this is set and `enforceLinkExpiry` is. */
  readonly maxLinkDays?: number;
  readonly enforceLinkExpiry?: boolean;
}

export interface Request {
  readonly method: string;
  /** The path as requested, e.g. /ocs/v2.php/apps/files_sharing/api/v1/shares/12 */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** The signed-in person. */
  readonly user: string;
}
export interface Reply {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** A share as the API shows it. */
export interface ShareJson {
  id: string;
  share_type: number;
  uid_owner: string;
  displayname_owner: string;
  permissions: number;
  can_edit: boolean;
  can_delete: boolean;
  stime: number;
  parent: null;
  expiration: string | null;
  token: string | null;
  uid_file_owner: string;
  note: string;
  label: string;
  path: string;
  item_type: 'file' | 'folder';
  mimetype: string;
  file_target: string;
  share_with: string | null;
  share_with_displayname: string | null;
  url?: string;
  password_protected: boolean;
  mail_send: 0;
  hide_download: 0;
}

class Fail extends Error {
  readonly code: number;
  constructor(code: number, why: string) {
    super(why);
    this.code = code;
  }
}

const BASE = /^\/ocs\/v([12])\.php\/apps\/files_sharing\/api\/v1\/shares(?:\/([^/]+))?\/?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** "read, update, share" for a mask, for messages and logs. */
export function permissionNames(mask: number): string[] {
  return (['read', 'update', 'create', 'delete', 'share'] as const).filter((_, i) => mask & (1 << i));
}

const truthy = (v: string | undefined) => v === 'true' || v === '1' || v === 'yes' || v === 'on';

/** Request parameters from a JSON body or a urlencoded form, with the query string under them. */
export function parseParams(body: string | undefined, contentType: string | undefined, query: Readonly<Record<string, string>> = {}): Record<string, string> {
  const out: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, query);
  if (!body) return out;
  if ((contentType ?? '').toLowerCase().includes('json')) {
    let j: unknown;
    try {
      j = JSON.parse(body);
    } catch {
      throw new Fail(400, 'the body is not valid JSON');
    }
    if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new Fail(400, 'the body must be an object');
    for (const [k, v] of Object.entries(j)) {
      if (k === '__proto__') continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
      else if (v !== null) throw new Fail(400, `${k} must be text, a number or true or false`);
    }
    return out;
  }
  for (const [k, v] of new URLSearchParams(body)) if (k !== '__proto__') out[k] = v;
  return out;
}

function cleanPath(p: string | undefined): string {
  if (p === undefined || p === '') throw new Fail(400, 'Please specify a file or folder path');
  if (p.length > 4096 || /[\u0000-\u001f]/.test(p)) throw new Fail(400, 'that is not a path');
  const parts = `/${p}`.split('/').filter((s) => s !== '');
  if (parts.some((s) => s === '..' || s === '.')) throw new Fail(400, 'that is not a path');
  return `/${parts.join('/')}`;
}

function wholeNumber(v: string, what: string): number {
  if (!/^\d{1,6}$/.test(v)) throw new Fail(400, `${what} must be a whole number`);
  return Number(v);
}

export class OcsShares {
  private readonly grants: Grants;
  private readonly env: Env;
  private readonly o: OcsOptions;
  private readonly now: () => number;

  constructor(grants: Grants, env: Env, o: OcsOptions) {
    this.grants = grants;
    this.env = env;
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  // --- dates -------------------------------------------------------------------------------------------------

  private day(s: string): number {
    if (!DAY.test(s)) throw new Fail(400, 'Invalid date. Format must be YYYY-MM-DD');
    const t = Date.parse(`${s}T00:00:00Z`);
    if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) throw new Fail(400, 'Invalid date. Format must be YYYY-MM-DD');
    return t;
  }

  /** A day's last moment as the moment the share stops: the start of the next day. */
  private expiryOf(s: string, link: boolean): number {
    const end = this.day(s) + DAY_MS;
    if (end <= this.now()) throw new Fail(400, 'Expiration date is in the past');
    const max = this.o.maxLinkDays;
    if (link && max !== undefined && end > this.now() + (max + 1) * DAY_MS) throw new Fail(400, `Cannot set expiration date more than ${max} days in the future`);
    return end;
  }

  private shown(expires: number | undefined): string | null {
    return expires === undefined ? null : `${new Date(expires - DAY_MS).toISOString().slice(0, 10)} 00:00:00`;
  }

  // --- shaping -------------------------------------------------------------------------------------------------

  private async json(g: Grant): Promise<ShareJson | undefined> {
    const t = await this.env.byId(g.resource);
    if (!t) return undefined;
    const type = g.kind === 'person' ? SHARE_USER : g.kind === 'group' ? SHARE_GROUP : SHARE_LINK;
    const out: ShareJson = {
      id: String(g.id),
      share_type: type,
      uid_owner: g.by,
      displayname_owner: await this.env.displayName(g.by),
      permissions: g.permissions,
      can_edit: (g.permissions & UPDATE) !== 0,
      can_delete: (g.permissions & DELETE) !== 0,
      stime: Math.floor(g.created / 1000),
      parent: null,
      expiration: this.shown(g.expires),
      token: g.token ?? null,
      uid_file_owner: t.owner,
      note: g.note ?? '',
      label: g.label ?? '',
      path: t.path,
      item_type: t.kind,
      mimetype: t.mimetype ?? (t.kind === 'folder' ? 'httpd/unix-directory' : 'application/octet-stream'),
      file_target: `/${t.path.split('/').filter(Boolean).at(-1) ?? ''}`,
      share_with: g.kind === 'link' ? (g.passwordHash ? 'password' : null) : (g.to ?? null),
      share_with_displayname: g.kind === 'link' ? (g.passwordHash ? '(Shared link)' : null) : g.kind === 'person' ? await this.env.displayName(g.to!) : g.to!,
      password_protected: g.passwordHash !== undefined,
      mail_send: 0,
      hide_download: 0,
    };
    if (g.token) out.url = `${this.o.baseUrl.replace(/\/+$/, '')}/s/${g.token}`;
    return out;
  }

  private async many(gs: readonly Grant[]): Promise<ShareJson[]> {
    const out: ShareJson[] = [];
    for (const g of [...gs].sort((a, b) => a.id - b.id)) {
      const j = await this.json(g);
      if (j) out.push(j);
    }
    return out;
  }

  // --- the calls -------------------------------------------------------------------------------------------------

  /** POST /shares: create. */
  async create(user: string, p: Readonly<Record<string, string>>): Promise<ShareJson> {
    const path = cleanPath(p.path);
    if (p.shareType === undefined) throw new Fail(400, 'Please specify a share type');
    const type = wholeNumber(p.shareType, 'shareType');
    if (type !== SHARE_USER && type !== SHARE_GROUP && type !== SHARE_LINK) throw new Fail(400, 'Unknown share type');
    const target = await this.env.find(user, path);
    if (!target) throw new Fail(404, 'Wrong path, file/folder does not exist');
    const giverHas = await this.env.permissionsOf(user, target.id);
    if (!(giverHas & SHARE)) throw new Fail(403, `You are not allowed to share ${path}`);
    let wanted = p.permissions !== undefined && p.permissions !== '' ? wholeNumber(p.permissions, 'permissions') : undefined;
    if (wanted !== undefined && (wanted < 1 || wanted > ALL || !(wanted & READ))) throw new Fail(400, 'invalid permissions');
    // A file has no inside: what cannot apply to it is dropped, as Nextcloud does, rather than refused.
    if (wanted !== undefined && target.kind === 'file') wanted &= FILE_MAX;
    const note = p.note;
    if (note !== undefined && note.length > 1000) throw new Fail(400, 'the note is too long');
    const label = p.label;
    if (label !== undefined && label.length > 255) throw new Fail(400, 'the label is too long');
    if (type === SHARE_LINK) {
      if (p.shareWith) throw new Fail(400, 'a public link is not shared with anyone');
      let perms = wanted ?? READ;
      if (truthy(p.publicUpload)) {
        if (target.kind !== 'folder') throw new Fail(403, 'Public upload is only possible for publicly shared folders');
        perms = READ | UPDATE | CREATE | DELETE;
      }
      perms &= ~SHARE;
      if (p.expireDate === undefined && this.o.enforceLinkExpiry && this.o.maxLinkDays !== undefined) throw new Fail(400, 'An expiration date is required for links');
      const g = await this.guard(() =>
        this.grants.create({
          resource: target.id,
          resourceKind: target.kind,
          by: user,
          giverHas,
          kind: 'link',
          permissions: perms,
          ...(p.password ? { password: p.password } : {}),
          ...(p.expireDate ? { expires: this.expiryOf(p.expireDate, true) } : {}),
          ...(note ? { note } : {}),
          ...(label ? { label } : {}),
        }),
      );
      return (await this.json(g))!;
    }
    if (p.password) throw new Fail(400, 'Passwords are only for public links');
    if (truthy(p.publicUpload)) throw new Fail(400, 'publicUpload is only for public links');
    const who = p.shareWith;
    if (!who || who.length > 255) throw new Fail(400, 'Please specify who to share with');
    if (type === SHARE_USER ? !(await this.env.userExists(who)) : !(await this.env.groupExists(who))) throw new Fail(404, `Sharing ${path} failed, because the ${type === SHARE_USER ? 'user' : 'group'} ${who} does not exist`);
    const g = await this.guard(() =>
      this.grants.create({
        resource: target.id,
        resourceKind: target.kind,
        by: user,
        giverHas,
        kind: type === SHARE_USER ? 'person' : 'group',
        to: who,
        ...(wanted !== undefined ? { permissions: wanted } : {}),
        ...(p.expireDate ? { expires: this.expiryOf(p.expireDate, false) } : {}),
        ...(note ? { note } : {}),
      }),
    );
    return (await this.json(g))!;
  }

  private async guard<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof Refused) throw new Fail(e.why.includes('password') ? 400 : 403, e.why);
      throw e;
    }
  }

  private async mine(user: string, rawId: string | undefined): Promise<Grant> {
    const id = rawId !== undefined && /^\d{1,12}$/.test(rawId) ? Number(rawId) : NaN;
    const g = Number.isNaN(id) ? undefined : await this.grants.get(id);
    if (!g) throw new Fail(404, 'Wrong share ID, share does not exist');
    return g;
  }

  /** GET /shares/{id}: a share the caller made or one made with them. */
  async get(user: string, id: string): Promise<ShareJson> {
    const g = await this.mine(user, id);
    const groups = await this.env.groupsOf(user);
    const seen = g.by === user || (g.kind === 'person' && g.to === user) || (g.kind === 'group' && !!g.to && groups.includes(g.to));
    if (!seen) throw new Fail(404, 'Wrong share ID, share does not exist');
    const j = await this.json(g);
    if (!j) throw new Fail(404, 'Wrong share ID, share does not exist');
    return j;
  }

  /** PUT /shares/{id}: change permissions, password, expiry, note, label. Only by the person who made it. */
  async update(user: string, id: string, p: Readonly<Record<string, string>>): Promise<ShareJson> {
    const g = await this.mine(user, id);
    if (g.by !== user) throw new Fail(404, 'Wrong share ID, share does not exist');
    const t = await this.env.byId(g.resource);
    if (!t) throw new Fail(404, 'Wrong share ID, share does not exist');
    const giverHas = await this.env.permissionsOf(user, g.resource);
    const change: { permissions?: number; password?: string | null; expires?: number | null; note?: string; label?: string } = {};
    if (p.permissions !== undefined && p.permissions !== '') {
      let perms = wholeNumber(p.permissions, 'permissions');
      if (perms < 1 || perms > ALL || !(perms & READ)) throw new Fail(400, 'invalid permissions');
      if (g.kind === 'link') perms &= ~SHARE;
      if (t.kind === 'file') perms &= FILE_MAX;
      change.permissions = perms;
    }
    if (truthy(p.publicUpload)) {
      if (g.kind !== 'link' || t.kind !== 'folder') throw new Fail(403, 'Public upload is only possible for publicly shared folders');
      change.permissions = READ | UPDATE | CREATE | DELETE;
    } else if (p.publicUpload !== undefined && g.kind === 'link' && change.permissions === undefined) change.permissions = READ;
    if (p.password !== undefined) {
      if (g.kind !== 'link') throw new Fail(400, 'Passwords are only for public links');
      change.password = p.password === '' ? null : p.password;
    }
    if (p.expireDate !== undefined) change.expires = p.expireDate === '' ? null : this.expiryOf(p.expireDate, g.kind === 'link');
    if (change.expires === null && g.kind === 'link' && this.o.enforceLinkExpiry && this.o.maxLinkDays !== undefined) throw new Fail(400, 'An expiration date is required for links');
    if (p.note !== undefined) {
      if (p.note.length > 1000) throw new Fail(400, 'the note is too long');
      change.note = p.note;
    }
    if (p.label !== undefined) {
      if (p.label.length > 255) throw new Fail(400, 'the label is too long');
      change.label = p.label;
    }
    const next = await this.guard(() => this.grants.update(g.id, user, giverHas, change));
    return (await this.json(next))!;
  }

  /** DELETE /shares/{id}. */
  async remove(user: string, id: string): Promise<void> {
    const g = await this.mine(user, id);
    if (g.by !== user) throw new Fail(404, 'Wrong share ID, share does not exist');
    await this.grants.revoke(g.id, user);
  }

  /** GET /shares: the caller's shares, or those on a path, with the caller, or inside a folder. */
  async list(user: string, p: Readonly<Record<string, string>>): Promise<ShareJson[]> {
    const path = p.path !== undefined && p.path !== '' ? cleanPath(p.path) : undefined;
    const target = path ? await this.env.find(user, path) : undefined;
    if (path && !target) throw new Fail(404, 'Wrong path, file/folder does not exist');
    if (truthy(p.shared_with_me)) {
      const groups = await this.env.groupsOf(user);
      return this.many(await this.grants.live((g) => ((g.kind === 'person' && g.to === user) || (g.kind === 'group' && !!g.to && groups.includes(g.to))) && (!target || g.resource === target.id)));
    }
    if (truthy(p.subfiles)) {
      if (!target || target.kind !== 'folder') throw new Fail(400, 'subfiles needs the path of a folder');
      const kids = new Set(await (this.env.children?.(target.id) ?? Promise.resolve([])));
      return this.many(await this.grants.live((g) => g.by === user && kids.has(g.resource)));
    }
    if (target && truthy(p.reshares)) {
      if (target.owner !== user && !((await this.env.permissionsOf(user, target.id)) & SHARE)) throw new Fail(403, `You are not allowed to see the shares of ${path}`);
      return this.many(await this.grants.live((g) => g.resource === target.id));
    }
    return this.many(await this.grants.live((g) => g.by === user && (!target || g.resource === target.id)));
  }

  // --- the wire --------------------------------------------------------------------------------------------------

  async handle(req: Request): Promise<Reply> {
    const m = BASE.exec(req.path);
    const v = m?.[1] === '1' ? 1 : 2;
    const h = (n: string) => req.headers?.[n] ?? req.headers?.[n.toLowerCase()];
    const params = (() => {
      try {
        return parseParams(req.body, h('content-type'), req.query);
      } catch {
        return undefined;
      }
    })();
    const json = params?.format === 'json' || (h('accept') ?? '').includes('application/json') || (h('content-type') ?? '').includes('json');
    const reply = (code: number, message: string, data: unknown): Reply => {
      const ok = code >= 200 && code < 300;
      const statuscode = v === 1 && ok ? 100 : code;
      const env = { ocs: { meta: { status: ok ? 'ok' : 'failure', statuscode, message: ok ? 'OK' : message }, data } };
      return { status: v === 1 ? 200 : code, headers: { 'content-type': json ? 'application/json; charset=utf-8' : 'text/xml; charset=utf-8', 'cache-control': 'no-store' }, body: json ? JSON.stringify(env) : toXml(env) };
    };
    try {
      if (!m) throw new Fail(404, 'not found');
      if (this.o.requireHeader !== false && h('ocs-apirequest') !== 'true') throw new Fail(412, 'The OCS-APIRequest header is required');
      if (!params) throw new Fail(400, 'the body could not be read');
      const id = m[2];
      switch (req.method.toUpperCase()) {
        case 'GET':
          return reply(200, 'OK', id === undefined ? await this.list(req.user, params) : [await this.get(req.user, id)]);
        case 'POST':
          if (id !== undefined) throw new Fail(405, 'POST is for creating a share');
          return reply(200, 'OK', await this.create(req.user, params));
        case 'PUT':
          if (id === undefined) throw new Fail(405, 'PUT needs a share id');
          return reply(200, 'OK', await this.update(req.user, id, params));
        case 'DELETE':
          if (id === undefined) throw new Fail(405, 'DELETE needs a share id');
          await this.remove(req.user, id);
          return reply(200, 'OK', []);
        default:
          throw new Fail(405, 'method not allowed');
      }
    } catch (e) {
      if (e instanceof Fail) return reply(e.code, e.message, []);
      throw e;
    }
  }
}

const xmlText = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
// XML 1.0 does not allow most control characters, even escaped.
const xmlSafe = (s: string) => xmlText(s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, ''));

/** Nextcloud's XML for an envelope: objects become elements, lists become <element> items, empty things are empty. */
export function toXml(v: unknown): string {
  const w = (name: string, x: unknown): string => {
    if (x === null || x === undefined) return `<${name}/>`;
    if (Array.isArray(x)) return x.length ? `<${name}>${x.map((i) => w('element', i)).join('')}</${name}>` : `<${name}/>`;
    if (typeof x === 'object') {
      const kids = Object.entries(x as Record<string, unknown>).map(([k, y]) => w(/^[A-Za-z_][\w.-]*$/.test(k) ? k : 'item', y));
      return kids.length ? `<${name}>${kids.join('')}</${name}>` : `<${name}/>`;
    }
    if (typeof x === 'boolean') return `<${name}>${x ? '1' : '0'}</${name}>`;
    return `<${name}>${xmlSafe(String(x))}</${name}>`;
  };
  const root = v as { ocs: unknown };
  return `<?xml version="1.0"?>\n${w('ocs', root.ocs)}`;
}
