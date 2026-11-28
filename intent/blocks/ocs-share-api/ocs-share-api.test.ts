import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALL, Grants, memoryGrants } from '../grants/index.ts';
import { CREATE, DELETE, FILE_MAX, OcsShares, READ, SHARE, UPDATE, parseParams, permissionNames, toXml } from './index.ts';
import type { Env, Reply, Target } from './index.ts';

const NOW = Date.UTC(2026, 2, 10, 15, 30);
const BASEPATH = '/ocs/v2.php/apps/files_sharing/api/v1/shares';

interface Node extends Target {
  parent?: number;
}
function world() {
  const nodes: Node[] = [
    { id: 1, kind: 'folder', path: '/Docs', owner: 'ana' },
    { id: 2, kind: 'file', path: '/Docs/plan.txt', owner: 'ana', mimetype: 'text/plain', parent: 1 },
    { id: 3, kind: 'file', path: '/notes.md', owner: 'ana', mimetype: 'text/markdown' },
    { id: 4, kind: 'folder', path: '/Docs/Sub', owner: 'ana', parent: 1 },
  ];
  const groups: Record<string, string[]> = { bo: ['team'], cy: ['team'], ana: [] };
  const grants = new Grants(memoryGrants(), { now: () => NOW });
  const chainOf = (n: Node) => {
    const c: { id: number; kind: 'file' | 'folder' }[] = [];
    for (let x: Node | undefined = n; x; x = nodes.find((y) => y.id === x!.parent)) c.push({ id: x.id, kind: x.kind });
    return c;
  };
  const env: Env = {
    find: async (user, path) => {
      const n = nodes.find((x) => x.path === path);
      if (!n) return undefined;
      return (await env.permissionsOf(user, n.id)) ? n : undefined;
    },
    byId: async (id) => nodes.find((x) => x.id === id),
    permissionsOf: async (user, id) => {
      const n = nodes.find((x) => x.id === id)!;
      if (n.owner === user) return n.kind === 'file' ? FILE_MAX : ALL;
      return grants.effective(user, groups[user] ?? [], chainOf(n), { owner: n.owner, groupsOf: (p) => groups[p] });
    },
    children: async (id) => nodes.filter((n) => n.parent === id).map((n) => n.id),
    userExists: async (u) => u in groups,
    groupExists: async (g) => g === 'team',
    groupsOf: async (u) => groups[u] ?? [],
    displayName: async (u) => u.toUpperCase(),
  };
  const ocs = new OcsShares(grants, env, { baseUrl: 'https://cloud.example.org/', now: () => NOW, maxLinkDays: 30 });
  const call = async (user: string, method: string, path: string, params: Record<string, string> = {}, o: { v?: 1 | 2; headers?: Record<string, string>; json?: boolean } = {}): Promise<Reply> =>
    ocs.handle({ method, path: `/ocs/v${o.v ?? 2}.php/apps/files_sharing/api/v1/shares${path}`, user, body: new URLSearchParams(params).toString(), headers: { 'ocs-apirequest': 'true', accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', ...o.headers } });
  return { ocs, grants, call };
}
const data = (r: Reply) => JSON.parse(r.body).ocs.data;
const meta = (r: Reply) => JSON.parse(r.body).ocs.meta;

test('sharing a folder with a person: the share has the shape Nextcloud clients read', async () => {
  const { call } = world();
  const r = await call('ana', 'POST', '', { path: '/Docs', shareType: '0', shareWith: 'bo' });
  assert.equal(r.status, 200);
  assert.deepEqual(meta(r), { status: 'ok', statuscode: 200, message: 'OK' });
  const s = data(r);
  assert.equal(s.id, '1');
  assert.equal(s.share_type, 0);
  assert.equal(s.share_with, 'bo');
  assert.equal(s.share_with_displayname, 'BO');
  assert.equal(s.uid_owner, 'ana');
  assert.equal(s.permissions, 31, 'a folder share defaults to everything');
  assert.equal(s.can_edit, true);
  assert.equal(s.item_type, 'folder');
  assert.equal(s.mimetype, 'httpd/unix-directory');
  assert.equal(s.file_target, '/Docs');
  assert.equal(s.stime, Math.floor(NOW / 1000));
  assert.equal(s.expiration, null);
  assert.equal(s.token, null);
});

test('a file share defaults to read, update and share; create and delete are never granted on a file', async () => {
  const { call } = world();
  const a = data(await call('ana', 'POST', '', { path: '/notes.md', shareType: '0', shareWith: 'bo' }));
  assert.equal(a.permissions, READ | UPDATE | SHARE);
  assert.equal(a.mimetype, 'text/markdown');
  const b = data(await call('ana', 'POST', '', { path: '/notes.md', shareType: '1', shareWith: 'team', permissions: '31' }));
  assert.equal(b.permissions, FILE_MAX, 'asking for create and delete on a file gets what a file can hold');
  assert.deepEqual(permissionNames(31), ['read', 'update', 'create', 'delete', 'share']);
  assert.deepEqual(permissionNames(READ | DELETE), ['read', 'delete']);
});

test('a public link: token, url, read-only by default, upload on request, never with the right to share', async () => {
  const { call } = world();
  const a = data(await call('ana', 'POST', '', { path: '/Docs', shareType: '3' }));
  assert.match(a.token, /^[abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789]{15}$/);
  assert.equal(a.url, `https://cloud.example.org/s/${a.token}`);
  assert.equal(a.permissions, READ);
  const b = data(await call('ana', 'POST', '', { path: '/Docs', shareType: '3', publicUpload: 'true' }));
  assert.equal(b.permissions, READ | UPDATE | CREATE | DELETE);
  const c = data(await call('ana', 'POST', '', { path: '/Docs', shareType: '3', permissions: '31' }));
  assert.equal(c.permissions, 15, 'share is stripped from a link');
  const bad = await call('ana', 'POST', '', { path: '/notes.md', shareType: '3', publicUpload: 'true' });
  assert.equal(bad.status, 403);
  assert.match(meta(bad).message, /only possible for publicly shared folders/);
  assert.notEqual(a.token, b.token);
});

test('link passwords are hashed, never returned, and too-short ones are refused', async () => {
  const { call, grants } = world();
  const r = await call('ana', 'POST', '', { path: '/Docs', shareType: '3', password: 'correct horse battery' });
  const s = data(r);
  assert.equal(s.password_protected, true);
  assert.equal(JSON.stringify(s).includes('correct horse'), false);
  assert.equal(s.share_with, 'password');
  const opened = await grants.open(s.token, 'correct horse battery');
  assert.equal(opened.id, 1);
  await assert.rejects(grants.open(s.token, 'wrong'), /password is wrong/);
  const short = await call('ana', 'POST', '', { path: '/Docs', shareType: '3', password: 'abc' });
  assert.equal(short.status, 400);
  assert.match(meta(short).message, /at least 8 characters/);
  const onUser = await call('ana', 'POST', '', { path: '/Docs', shareType: '0', shareWith: 'bo', password: 'correct horse battery' });
  assert.equal(onUser.status, 400);
});

test('expiry: a day, shown as midnight, valid through that whole day; the past and too far ahead are refused', async () => {
  const { call, grants } = world();
  const s = data(await call('ana', 'POST', '', { path: '/Docs', shareType: '3', expireDate: '2026-03-12' }));
  assert.equal(s.expiration, '2026-03-12 00:00:00');
  const g = (await grants.get(1))!;
  assert.equal(g.expires, Date.UTC(2026, 2, 13), 'it stops at the start of the next day');
  const today = data(await call('ana', 'POST', '', { path: '/Docs', shareType: '3', expireDate: '2026-03-10' }));
  assert.equal(today.expiration, '2026-03-10 00:00:00', 'today is allowed, it is still running');
  const past = await call('ana', 'POST', '', { path: '/Docs', shareType: '3', expireDate: '2026-03-09' });
  assert.equal(past.status, 400);
  assert.match(meta(past).message, /in the past/);
  const far = await call('ana', 'POST', '', { path: '/Docs', shareType: '3', expireDate: '2026-12-01' });
  assert.equal(far.status, 400);
  assert.match(meta(far).message, /more than 30 days/);
  for (const bad of ['2026-02-30', '12/03/2026', 'tomorrow', '2026-3-1']) assert.equal((await call('ana', 'POST', '', { path: '/Docs', shareType: '3', expireDate: bad })).status, 400, bad);
  assert.equal(data(await call('ana', 'GET', '/1')).length, 1);
});

test('a share cannot give more than the giver has, and only people who may share can share', async () => {
  const { call } = world();
  await call('ana', 'POST', '', { path: '/Docs', shareType: '0', shareWith: 'bo', permissions: String(READ | SHARE) });
  const over = await call('bo', 'POST', '', { path: '/Docs', shareType: '0', shareWith: 'cy', permissions: String(READ | UPDATE) });
  assert.equal(over.status, 403);
  assert.match(meta(over).message, /more than the giver has/);
  const ok = await call('bo', 'POST', '', { path: '/Docs', shareType: '0', shareWith: 'cy', permissions: String(READ) });
  assert.equal(ok.status, 200);
  const nobody = await call('cy', 'POST', '', { path: '/Docs', shareType: '3' });
  assert.equal(nobody.status, 403, 'cy has read only, no share right');
  assert.match(meta(nobody).message, /not allowed to share/);
  const unseen = await call('bo', 'POST', '', { path: '/notes.md', shareType: '3' });
  assert.equal(unseen.status, 404, 'a file bo cannot see is not confirmed to exist');
});

test('wrong input gets the status Nextcloud uses', async () => {
  const { call } = world();
  const cases: [Record<string, string>, number, RegExp][] = [
    [{ shareType: '0', shareWith: 'bo' }, 400, /specify a file or folder path/],
    [{ path: '/Docs' }, 400, /specify a share type/],
    [{ path: '/Docs', shareType: '9', shareWith: 'bo' }, 400, /Unknown share type/],
    [{ path: '/Docs', shareType: '4', shareWith: 'a@b.c' }, 400, /Unknown share type/],
    [{ path: '/Nope', shareType: '0', shareWith: 'bo' }, 404, /does not exist/],
    [{ path: '/Docs', shareType: '0' }, 400, /who to share with/],
    [{ path: '/Docs', shareType: '0', shareWith: 'zed' }, 404, /user zed does not exist/],
    [{ path: '/Docs', shareType: '1', shareWith: 'ghosts' }, 404, /group ghosts does not exist/],
    [{ path: '/Docs', shareType: '0', shareWith: 'ana' }, 403, /themselves/],
    [{ path: '/Docs', shareType: '0', shareWith: 'bo', permissions: '2' }, 400, /invalid permissions/],
    [{ path: '/Docs', shareType: '0', shareWith: 'bo', permissions: '99' }, 400, /invalid permissions/],
    [{ path: '/Docs', shareType: 'x', shareWith: 'bo' }, 400, /whole number/],
    [{ path: '/Docs/../../etc', shareType: '3' }, 400, /not a path/],
    [{ path: '/Docs', shareType: '3', shareWith: 'bo' }, 400, /not shared with anyone/],
  ];
  for (const [p, status, msg] of cases) {
    const r = await call('ana', 'POST', '', p);
    assert.equal(r.status, status, JSON.stringify(p));
    assert.match(meta(r).message, msg, JSON.stringify(p));
    assert.equal(meta(r).status, 'failure');
  }
});

test('listing: my shares, those on a path, those shared with me through a person or a group, and inside a folder', async () => {
  const { call } = world();
  await call('ana', 'POST', '', { path: '/Docs', shareType: '0', shareWith: 'bo' });
  await call('ana', 'POST', '', { path: '/notes.md', shareType: '1', shareWith: 'team' });
  await call('ana', 'POST', '', { path: '/Docs/plan.txt', shareType: '3' });
  await call('ana', 'POST', '', { path: '/Docs/Sub', shareType: '3' });
  assert.deepEqual(data(await call('ana', 'GET', '')).map((s: { id: string }) => s.id), ['1', '2', '3', '4']);
  assert.deepEqual(data(await call('ana', 'GET', '', { path: '/Docs' })).map((s: { id: string }) => s.id), ['1']);
  assert.deepEqual(data(await call('ana', 'GET', '', { path: '/Docs', subfiles: 'true' })).map((s: { id: string }) => s.id), ['3', '4']);
  assert.deepEqual(data(await call('bo', 'GET', '', { shared_with_me: 'true' })).map((s: { id: string }) => s.id), ['1', '2'], 'one through bo, one through team');
  assert.deepEqual(data(await call('cy', 'GET', '', { shared_with_me: 'true' })).map((s: { id: string }) => s.id), ['2']);
  assert.deepEqual(data(await call('bo', 'GET', '')), [], 'bo made none');
  assert.equal((await call('ana', 'GET', '', { subfiles: 'true', path: '/notes.md' })).status, 400);
  assert.equal((await call('ana', 'GET', '', { path: '/Nope' })).status, 404);
  const reshares = await call('ana', 'GET', '', { path: '/Docs', reshares: 'true' });
  assert.equal(data(reshares).length, 1);
  assert.equal((await call('cy', 'GET', '', { path: '/Docs', reshares: 'true' })).status, 404, 'cy cannot even see /Docs');
});

test('reading one share: the giver and the receiver may; anyone else is told it does not exist', async () => {
  const { call } = world();
  await call('ana', 'POST', '', { path: '/Docs', shareType: '0', shareWith: 'bo' });
  assert.equal(data(await call('ana', 'GET', '/1'))[0].id, '1');
  assert.equal(data(await call('bo', 'GET', '/1'))[0].id, '1');
  const other = await call('cy', 'GET', '/1');
  assert.equal(other.status, 404);
  assert.match(meta(other).message, /Wrong share ID/);
  for (const bad of ['/99', '/abc', '/1e3', '/-1', '/0x1', '/1%20OR%201']) assert.equal((await call('ana', 'GET', bad)).status, 404, bad);
});

test('updating: permissions, expiry, note, label, password; clearing with empty values; only the giver may', async () => {
  const { call } = world();
  await call('ana', 'POST', '', { path: '/Docs', shareType: '3', label: 'for press' });
  let s = data(await call('ana', 'PUT', '/1', { permissions: '31', note: 'hello', expireDate: '2026-03-20', password: 'a long password' }));
  assert.equal(s.permissions, 15);
  assert.equal(s.note, 'hello');
  assert.equal(s.label, 'for press', 'untouched');
  assert.equal(s.expiration, '2026-03-20 00:00:00');
  assert.equal(s.password_protected, true);
  s = data(await call('ana', 'PUT', '/1', { expireDate: '', password: '' }));
  assert.equal(s.expiration, null);
  assert.equal(s.password_protected, false);
  s = data(await call('ana', 'PUT', '/1', { publicUpload: 'true' }));
  assert.equal(s.permissions, 15);
  s = data(await call('ana', 'PUT', '/1', { publicUpload: 'false' }));
  assert.equal(s.permissions, 1);
  assert.equal((await call('bo', 'PUT', '/1', { note: 'mine now' })).status, 404);
  assert.equal((await call('ana', 'PUT', '/1', { permissions: '0' })).status, 400);
  assert.equal((await call('ana', 'PUT', '/1', { expireDate: '2020-01-01' })).status, 400);
  assert.equal((await call('ana', 'PUT', '', { note: 'x' })).status, 405);
  await call('ana', 'POST', '', { path: '/Docs', shareType: '0', shareWith: 'bo' });
  assert.equal((await call('ana', 'PUT', '/2', { password: 'a long password' })).status, 400, 'a person share has no password');
});

test('lowering a share lowers the reshares made from it; deleting ends them', async () => {
  const { call, grants } = world();
  await call('ana', 'POST', '', { path: '/Docs', shareType: '0', shareWith: 'bo' });
  await call('bo', 'POST', '', { path: '/Docs', shareType: '0', shareWith: 'cy', permissions: '17' });
  assert.equal(data(await call('cy', 'GET', '/2'))[0].permissions, 17);
  await call('ana', 'PUT', '/1', { permissions: '1' });
  const cyDocs = await call('cy', 'POST', '', { path: '/Docs', shareType: '3' });
  assert.equal(cyDocs.status, 403, 'cy now holds only read through bo, who holds only read');
  assert.equal((await call('bo', 'DELETE', '/1')).status, 404, 'bo did not make share 1');
  const del = await call('ana', 'DELETE', '/1');
  assert.equal(del.status, 200);
  assert.deepEqual(data(del), []);
  assert.equal((await call('ana', 'GET', '/1')).status, 404);
  assert.equal(await grants.get(1), undefined);
  assert.equal((await call('cy', 'GET', '', { shared_with_me: 'true' })).status, 200);
});

test('v1 answers HTTP 200 with status 100 in the meta; v2 uses the real status', async () => {
  const { call } = world();
  const ok = await call('ana', 'POST', '', { path: '/Docs', shareType: '3' }, { v: 1 });
  assert.equal(ok.status, 200);
  assert.deepEqual(meta(ok), { status: 'ok', statuscode: 100, message: 'OK' });
  const missing = await call('ana', 'GET', '/77', {}, { v: 1 });
  assert.equal(missing.status, 200);
  assert.equal(meta(missing).statuscode, 404);
  assert.equal(meta(missing).status, 'failure');
  assert.equal((await call('ana', 'GET', '/77')).status, 404);
});

test('the OCS-APIRequest header is required, and unknown paths and methods are refused', async () => {
  const { call, ocs } = world();
  const r = await call('ana', 'GET', '', {}, { headers: { 'ocs-apirequest': 'false' } });
  assert.equal(r.status, 412);
  assert.equal((await ocs.handle({ method: 'GET', path: BASEPATH, user: 'ana', headers: { accept: 'application/json' } })).status, 412);
  assert.equal((await call('ana', 'PATCH', '/1')).status, 405);
  assert.equal((await call('ana', 'POST', '/1', { path: '/Docs', shareType: '3' })).status, 405);
  assert.equal((await ocs.handle({ method: 'GET', path: '/ocs/v2.php/apps/files_sharing/api/v1/other', user: 'ana', headers: { 'ocs-apirequest': 'true' } })).status, 404);
  assert.equal((await ocs.handle({ method: 'GET', path: '/ocs/v3.php/apps/files_sharing/api/v1/shares', user: 'ana', headers: { 'ocs-apirequest': 'true' } })).status, 404);
});

test('XML is the default answer, JSON when asked; XML is escaped and has no control characters', async () => {
  const { ocs, call } = world();
  const r = await ocs.handle({ method: 'POST', path: BASEPATH, user: 'ana', headers: { 'ocs-apirequest': 'true', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ path: '/Docs', shareType: '3', note: '<b>&"hi"\u0001</b>' }).toString() });
  assert.match(r.headers['content-type']!, /xml/);
  assert.match(r.body, /^<\?xml version="1\.0"\?>\n<ocs><meta><status>ok<\/status><statuscode>200<\/statuscode>/);
  assert.match(r.body, /<note>&lt;b&gt;&amp;&quot;hi&quot;&lt;\/b&gt;<\/note>/);
  assert.equal(r.body.includes('\u0001'), false);
  assert.match(r.body, /<can_edit>0<\/can_edit>/);
  const list = await call('ana', 'GET', '', { format: 'json' }, { headers: { accept: '*/*' } });
  assert.match(list.headers['content-type']!, /json/);
  assert.equal(toXml({ ocs: { meta: { status: 'ok' }, data: [] } }), '<?xml version="1.0"?>\n<ocs><meta><status>ok</status></meta><data/></ocs>');
  assert.equal(toXml({ ocs: { data: ['a', 'b'] } }), '<?xml version="1.0"?>\n<ocs><data><element>a</element><element>b</element></data></ocs>');
});

test('request parameters: urlencoded or JSON, with hostile keys ignored and wrong types refused', async () => {
  assert.deepEqual({ ...parseParams('a=1&b=x%20y', 'application/x-www-form-urlencoded') }, { a: '1', b: 'x y' });
  assert.deepEqual({ ...parseParams('{"a":1,"b":true,"c":null}', 'application/json') }, { a: '1', b: 'true' });
  assert.equal(Object.keys(parseParams('__proto__=x&a=1', undefined)).join(), 'a');
  assert.equal(({} as Record<string, string>).polluted, undefined);
  assert.throws(() => parseParams('{"a":{"b":1}}', 'application/json'), /must be text/);
  assert.throws(() => parseParams('[1]', 'application/json'), /must be an object/);
  assert.throws(() => parseParams('{nope', 'application/json'), /not valid JSON/);
  const { ocs } = world();
  const r = await ocs.handle({ method: 'POST', path: BASEPATH, user: 'ana', headers: { 'ocs-apirequest': 'true', 'content-type': 'application/json' }, body: JSON.stringify({ path: '/Docs', shareType: 0, shareWith: 'bo', permissions: 17 }) });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).ocs.data.permissions, 17);
});

test('shares to a group reach its members; a share to a person is not visible to the group', async () => {
  const { call } = world();
  const g = data(await call('ana', 'POST', '', { path: '/Docs', shareType: '1', shareWith: 'team', permissions: '1' }));
  assert.equal(g.share_with, 'team');
  assert.equal(g.share_with_displayname, 'team');
  assert.equal(data(await call('cy', 'GET', `/${g.id}`))[0].share_type, 1);
  await call('ana', 'POST', '', { path: '/notes.md', shareType: '0', shareWith: 'bo' });
  assert.equal((await call('cy', 'GET', '/2')).status, 404);
});
