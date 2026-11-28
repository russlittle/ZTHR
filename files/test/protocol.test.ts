import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { PASS, PROPS, parseMultistatus, start } from './helpers.ts';

const MB = 1024 * 1024;

test('a client checks the server: status, then capabilities without signing in', async () => {
  const s = await start();
  try {
    const st = await (await s.anon('/status.php')).json();
    assert.equal(st.installed, true);
    assert.match(st.version, /^\d+\.\d+\.\d+\.\d+$/);
    const caps = await (await s.anon('/ocs/v2.php/cloud/capabilities?format=json', { headers: { 'ocs-apirequest': 'true' } })).json();
    assert.equal(caps.ocs.meta.statuscode, 200);
    assert.equal(caps.ocs.data.capabilities.dav.chunking, '1.0');
    assert.equal(caps.ocs.data.capabilities.files.undelete, true);
    const xml = await (await s.anon('/ocs/v1.php/cloud/capabilities')).text();
    assert.match(xml, /<statuscode>100<\/statuscode>/);
  } finally {
    await s.close();
  }
});

test('login flow v2: the app polls, the person signs in in a browser, and the app gets its own password once', async () => {
  const s = await start();
  try {
    const start1 = await (await s.anon('/index.php/login/v2', { method: 'POST', headers: { 'user-agent': 'Nextcloud desktop' } })).json();
    const poll = () => s.anon('/index.php/login/v2/poll', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${start1.poll.token}` });
    assert.equal((await poll()).status, 404, 'nothing until the person signs in');
    const loginPath = new URL(start1.login).pathname;
    const form = await s.anon(loginPath);
    assert.match(await form.text(), /Sign in and allow/);
    const bad = await s.anon(loginPath, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'user=ana&password=wrong' });
    assert.equal(bad.status, 401);
    const ok = await s.anon(loginPath, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `user=ana&password=${encodeURIComponent(PASS)}` });
    assert.equal(ok.status, 200);
    const creds = await (await poll()).json();
    assert.equal(creds.loginName, 'ana');
    assert.equal((await poll()).status, 404, 'handed over once');
    const dav = await s.as('ana', creds.appPassword)('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0' }, body: PROPS });
    assert.equal(dav.status, 207);
    const devices = await s.files.devices.list('ana');
    assert.equal(devices[0]?.name, 'Nextcloud desktop');
  } finally {
    await s.close();
  }
});

test('files: write, read whole and by range, list with the properties sync depends on', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  try {
    const root0 = parseMultistatus(await (await ana('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0' }, body: PROPS })).text())[0]!;
    assert.equal((await ana('/remote.php/dav/files/ana/Docs', { method: 'MKCOL' })).status, 201);
    const body = 'hello, files';
    const put = await ana('/remote.php/dav/files/ana/Docs/hello.txt', { method: 'PUT', body, headers: { 'x-oc-mtime': '1700000000', 'oc-checksum': `SHA1:${createHash('sha1').update(body).digest('hex')}` } });
    assert.equal(put.status, 201);
    assert.ok(put.headers.get('oc-fileid'));
    assert.equal(put.headers.get('x-oc-mtime'), 'accepted');
    const get = await ana('/remote.php/dav/files/ana/Docs/hello.txt');
    assert.equal(await get.text(), body);
    assert.equal(get.headers.get('etag'), put.headers.get('etag'));
    const part = await ana('/remote.php/dav/files/ana/Docs/hello.txt', { headers: { range: 'bytes=7-' } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), 'files');
    const list = parseMultistatus(await (await ana('/remote.php/dav/files/ana/Docs/', { method: 'PROPFIND', headers: { depth: '1' }, body: PROPS })).text());
    assert.equal(list.length, 2);
    const f = list.find((x) => x.href.endsWith('hello.txt'))!;
    assert.equal(f.props['oc:permissions'], 'RGDNVW');
    assert.equal(f.props['oc:size'], String(body.length));
    assert.match(f.props['oc:id']!, /^\d{8}oc/);
    assert.match(f.props['oc:checksums']!, /SHA1:/);
    assert.ok(f.missing.includes('nc:nope'), 'an unknown property is a 404 in its own propstat');
    assert.equal(list[0]!.props['oc:permissions'], 'RGDNVCK');
    assert.equal(list[0]!.props['oc:size'], String(body.length));
    const root1 = parseMultistatus(await (await ana('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0' }, body: PROPS })).text())[0]!;
    assert.notEqual(root1.props['d:getetag'], root0.props['d:getetag'], 'the root etag changes when anything below it changes');
    const wrong = await ana('/remote.php/dav/files/ana/Docs/bad.txt', { method: 'PUT', body: 'x', headers: { 'oc-checksum': 'SHA1:0000000000000000000000000000000000000000' } });
    assert.equal(wrong.status, 400, 'a checksum that does not match is refused');
    assert.equal((await ana('/remote.php/dav/files/ana/Docs/bad.txt')).status, 404);
    assert.equal((await ana('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: 'infinity' } })).status, 403);
  } finally {
    await s.close();
  }
});

test('nothing is lost silently: a write against an old etag is refused, and an overwrite keeps a version', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  try {
    const a = await ana('/remote.php/dav/files/ana/notes.txt', { method: 'PUT', body: 'first' });
    const etag = a.headers.get('etag')!;
    assert.equal((await ana('/remote.php/dav/files/ana/notes.txt', { method: 'PUT', body: 'second', headers: { 'if-match': etag } })).status, 204);
    const stale = await ana('/remote.php/dav/files/ana/notes.txt', { method: 'PUT', body: 'third', headers: { 'if-match': etag } });
    assert.equal(stale.status, 412, 'the client was told it changed, so it makes a conflict copy instead of overwriting');
    assert.equal(await (await ana('/remote.php/dav/files/ana/notes.txt')).text(), 'second');
    const id = a.headers.get('oc-fileid')!.slice(0, 8).replace(/^0+/, '');
    const vs = parseMultistatus(await (await ana(`/remote.php/dav/versions/ana/versions/${id}`, { method: 'PROPFIND', headers: { depth: '1' } })).text());
    assert.equal(vs.length, 2, 'the folder and one version');
    const v = vs[1]!.href;
    assert.equal(await (await ana(v)).text(), 'first');
    const restore = await ana(v, { method: 'MOVE', headers: { destination: `${s.base}/remote.php/dav/versions/ana/restore/target` } });
    assert.equal(restore.status, 204);
    assert.equal(await (await ana('/remote.php/dav/files/ana/notes.txt')).text(), 'first');
    assert.equal(s.files.versionsOf(Number(id)).length, 2, 'the copy replaced by the restore is itself kept');
    assert.equal((await ana('/remote.php/dav/files/ana/notes.txt', { method: 'PUT', body: 'x', headers: { 'if-none-match': '*' } })).status, 412);
  } finally {
    await s.close();
  }
});

test('move, copy, delete to the trash, and restore with the same id', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  const dest = (p: string) => ({ destination: `${s.base}/remote.php/dav/files/ana${p}` });
  try {
    await ana('/remote.php/dav/files/ana/A', { method: 'MKCOL' });
    const put = await ana('/remote.php/dav/files/ana/A/x.txt', { method: 'PUT', body: 'x' });
    const id = put.headers.get('oc-fileid');
    assert.equal((await ana('/remote.php/dav/files/ana/A/x.txt', { method: 'MOVE', headers: dest('/A/y%20z.txt') })).status, 201);
    assert.equal((await ana('/remote.php/dav/files/ana/A/y%20z.txt', { method: 'MOVE', headers: dest('/y.txt') })).headers.get('oc-fileid'), id, 'a move keeps the id');
    assert.equal((await ana('/remote.php/dav/files/ana/y.txt', { method: 'COPY', headers: dest('/A/copy.txt') })).status, 201);
    assert.equal(await (await ana('/remote.php/dav/files/ana/A/copy.txt')).text(), 'x');
    assert.equal((await ana('/remote.php/dav/files/ana/y.txt', { method: 'COPY', headers: { ...dest('/A/copy.txt'), overwrite: 'F' } })).status, 412, 'overwrite F on an existing target is a failed precondition');
    assert.equal((await ana('/remote.php/dav/files/ana/A', { method: 'MOVE', headers: dest('/A/inside') })).status, 403);
    assert.equal((await ana('/remote.php/dav/files/ana/y.txt', { method: 'DELETE' })).status, 204);
    assert.equal((await ana('/remote.php/dav/files/ana/y.txt')).status, 404);
    const trash = parseMultistatus(await (await ana('/remote.php/dav/trashbin/ana/trash', { method: 'PROPFIND', headers: { depth: '1' } })).text());
    assert.equal(trash.length, 2);
    assert.equal(trash[1]!.props['nc:trashbin-original-location'], 'y.txt');
    const back = await ana(trash[1]!.href, { method: 'MOVE', headers: { destination: `${s.base}/remote.php/dav/trashbin/ana/restore/y.txt` } });
    assert.equal(back.status, 201);
    assert.equal(back.headers.get('oc-fileid'), id, 'restored with the same id, so clients see the same file');
    assert.equal(await (await ana('/remote.php/dav/files/ana/y.txt')).text(), 'x');
    await ana('/remote.php/dav/files/ana/A', { method: 'DELETE' });
    assert.equal((await ana('/remote.php/dav/trashbin/ana/trash', { method: 'DELETE' })).status, 204);
    assert.equal(s.files.trashOf('ana').length, 0);
  } finally {
    await s.close();
  }
});

test('chunked upload v2: chunks out of order, a quota check up front, assembly at the destination', async () => {
  const s = await start({ people: [{ id: 'ana', quota: 12 * MB }] });
  const ana = s.as('ana', PASS);
  const up = '/remote.php/dav/uploads/ana/web-file-upload-123';
  const dest = { destination: `${s.base}/remote.php/dav/files/ana/big.bin` };
  try {
    assert.equal((await ana(up, { method: 'MKCOL', headers: dest })).status, 201);
    const a = Buffer.alloc(5 * MB, 1);
    const b = Buffer.alloc(1024, 2);
    assert.equal((await ana(`${up}/00002`, { method: 'PUT', body: b, headers: { ...dest, 'oc-total-length': String(a.length + b.length) } })).status, 201);
    assert.equal((await ana(`${up}/00001`, { method: 'PUT', body: a, headers: { ...dest, 'oc-total-length': String(a.length + b.length) } })).status, 201);
    const chunks = parseMultistatus(await (await ana(up, { method: 'PROPFIND', headers: { depth: '1' } })).text());
    assert.equal(chunks.length, 3, 'a resuming client sees what already arrived');
    const done = await ana(`${up}/.file`, { method: 'MOVE', headers: { ...dest, 'oc-total-length': String(a.length + b.length), 'x-oc-mtime': '1700000000' } });
    assert.equal(done.status, 201);
    const got = Buffer.from(await (await ana('/remote.php/dav/files/ana/big.bin')).arrayBuffer());
    assert.equal(got.length, a.length + b.length);
    assert.equal(got[0], 1);
    assert.equal(got[got.length - 1], 2);
    const over = await ana('/remote.php/dav/uploads/ana/two', { method: 'MKCOL', headers: { destination: `${s.base}/remote.php/dav/files/ana/huge.bin`, 'oc-total-length': String(50 * MB) } });
    assert.equal(over.status, 507, 'too big for the space left: refused before any bytes are sent');
    assert.equal((await ana('/remote.php/dav/files/ana/small.txt', { method: 'PUT', body: Buffer.alloc(7 * MB) })).status, 507);
  } finally {
    await s.close();
  }
});

test('an upload whose Destination Files cannot place is refused as a bad Destination, not as an existing folder', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  try {
    const odd = await ana('/remote.php/dav/uploads/ana/u9', { method: 'MKCOL', headers: { destination: `${s.base}/remote.php/dav/files/ben/big/large.bin` } });
    assert.equal(odd.status, 400, 'the Destination is the problem, and the reply says so');
    assert.match(await odd.text(), /Destination/);
    const stray = await ana('/remote.php/dav/uploads/ana/u9', { method: 'PROPFIND', headers: { depth: '1' } });
    assert.notEqual(stray.status, 207, 'no upload session was opened for it');
  } finally {
    await s.close();
  }
});

test('sharing with a person: they see it at their root, with only the permissions given', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  const ben = s.as('ben', PASS);
  const form = { 'content-type': 'application/x-www-form-urlencoded', 'ocs-apirequest': 'true' };
  try {
    await ana('/remote.php/dav/files/ana/Trip', { method: 'MKCOL' });
    await ana('/remote.php/dav/files/ana/Trip/plan.txt', { method: 'PUT', body: 'day one' });
    const sh = await (await ana('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', { method: 'POST', headers: form, body: 'path=/Trip&shareType=0&shareWith=ben&permissions=1' })).json();
    assert.equal(sh.ocs.meta.statuscode, 200);
    assert.equal(sh.ocs.data.permissions, 1);
    const root = parseMultistatus(await (await ben('/remote.php/dav/files/ben/', { method: 'PROPFIND', headers: { depth: '1' }, body: PROPS })).text());
    const trip = root.find((x) => x.href.endsWith('/Trip/'))!;
    assert.ok(trip, 'the share is mounted at his root');
    assert.equal(trip.props['nc:mount-type'], 'shared');
    assert.equal(trip.props['oc:permissions'], 'SMGDNV');
    assert.equal(trip.props['oc:owner-id'], 'ana');
    assert.equal(await (await ben('/remote.php/dav/files/ben/Trip/plan.txt')).text(), 'day one');
    assert.equal((await ben('/remote.php/dav/files/ben/Trip/plan.txt', { method: 'PUT', body: 'changed' })).status, 403, 'read-only means read-only');
    assert.equal((await ben('/remote.php/dav/files/ben/Trip/new.txt', { method: 'PUT', body: 'x' })).status, 403);
    const mine = await (await ben('/ocs/v2.php/apps/files_sharing/api/v1/shares?shared_with_me=true&format=json', { headers: form })).json();
    assert.equal(mine.ocs.data.length, 1);
    await ana(`/ocs/v2.php/apps/files_sharing/api/v1/shares/${sh.ocs.data.id}?format=json`, { method: 'PUT', headers: form, body: 'permissions=15' });
    assert.equal((await ben('/remote.php/dav/files/ben/Trip/plan.txt', { method: 'PUT', body: 'changed' })).status, 204, 'with update permission he can change it');
    assert.equal(await (await ana('/remote.php/dav/files/ana/Trip/plan.txt')).text(), 'changed', 'and the change is in her file');
    const before = parseMultistatus(await (await ben('/remote.php/dav/files/ben/', { method: 'PROPFIND', headers: { depth: '0' }, body: PROPS })).text())[0]!.props['d:getetag'];
    await ana('/remote.php/dav/files/ana/Trip/more.txt', { method: 'PUT', body: 'x' });
    const after = parseMultistatus(await (await ben('/remote.php/dav/files/ben/', { method: 'PROPFIND', headers: { depth: '0' }, body: PROPS })).text())[0]!.props['d:getetag'];
    assert.notEqual(after, before, 'his root etag changes when her shared folder changes, so his app syncs it');
    assert.equal((await ben('/remote.php/dav/files/ben/Trip', { method: 'DELETE' })).status, 204, 'he can leave the share');
    assert.equal((await ana('/remote.php/dav/files/ana/Trip/plan.txt')).status, 200, 'and her files stay');
    assert.equal((await ben('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0' } })).status, 403, 'nobody reaches another person’s files directly');
  } finally {
    await s.close();
  }
});

test('a public link with a password and an expiry', async () => {
  let now = Date.UTC(2026, 10, 1);
  const s = await start({ now: () => now });
  const ana = s.as('ana', PASS);
  const form = { 'content-type': 'application/x-www-form-urlencoded', 'ocs-apirequest': 'true' };
  try {
    await ana('/remote.php/dav/files/ana/photo.jpg', { method: 'PUT', body: 'jpegbytes' });
    const sh = await (await ana('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', { method: 'POST', headers: form, body: 'path=/photo.jpg&shareType=3&password=summer%20trip%202026&expireDate=2026-11-10' })).json();
    const url = new URL(sh.ocs.data.url).pathname;
    assert.equal(sh.ocs.data.expiration, '2026-11-10 00:00:00');
    assert.ok(!JSON.stringify(sh).includes('summer trip'), 'the password never comes back');
    assert.match(await (await s.anon(url)).text(), /This link has a password/);
    assert.doesNotMatch(await (await s.anon(`${url}/download`)).text(), /jpegbytes/, 'no bytes without the password');
    const wrong = await s.anon(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=nope' });
    assert.equal(wrong.status, 401);
    const right = await s.anon(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=summer%20trip%202026' });
    assert.equal(right.status, 303);
    const cookie = right.headers.get('set-cookie')!.split(';')[0]!;
    const dl = await s.anon(`${url}/download`, { headers: { cookie } });
    assert.equal(await dl.text(), 'jpegbytes');
    now = Date.UTC(2026, 10, 11);
    assert.equal((await s.anon(`${url}/download`, { headers: { cookie } })).status, 404, 'after its expiry the link stops working');
  } finally {
    await s.close();
  }
});

test('an app password can be revoked, and a lost device wiped', async () => {
  const s = await start();
  try {
    const { password, device } = await s.files.devices.issue('ana', 'old phone');
    const phone = s.as('ana', password);
    assert.equal((await phone('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0' } })).status, 207);
    await s.files.devices.markWipe('ana', device.id);
    assert.equal((await phone('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0' } })).status, 401);
    const check = await s.anon('/index.php/core/wipe/check', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(password)}` });
    assert.deepEqual(await check.json(), { wipe: true });
    assert.equal((await s.anon('/index.php/core/wipe/success', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(password)}` })).status, 200);
    const laptop = await s.files.devices.issue('ana', 'laptop');
    const l = s.as('ana', laptop.password);
    const del = await l('/ocs/v2.php/core/apppassword?format=json', { method: 'DELETE', headers: { 'ocs-apirequest': 'true' } });
    assert.equal(del.status, 200);
    assert.equal((await l('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0' } })).status, 401);
  } finally {
    await s.close();
  }
});

test('an admin adds people and sets quotas; nobody else can', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  const ben = s.as('ben', PASS);
  const form = { 'content-type': 'application/x-www-form-urlencoded', 'ocs-apirequest': 'true' };
  try {
    const add = await (await ana('/ocs/v1.php/cloud/users?format=json', { method: 'POST', headers: form, body: 'userid=cy&password=a%20long%20password&displayName=Cy' })).json();
    assert.equal(add.ocs.meta.statuscode, 100);
    await ana('/ocs/v1.php/cloud/users/cy?format=json', { method: 'PUT', headers: form, body: 'key=quota&value=1%20GB' });
    const cy = await (await ana('/ocs/v1.php/cloud/users/cy?format=json', { headers: form })).json();
    assert.equal(cy.ocs.data.quota.total, 1024 ** 3);
    const refused = await (await ben('/ocs/v1.php/cloud/users?format=json', { method: 'POST', headers: form, body: 'userid=dee&password=a%20long%20password' })).json();
    assert.equal(refused.ocs.meta.statuscode, 403);
    const me = await (await ben('/ocs/v2.php/cloud/user?format=json', { headers: form })).json();
    assert.equal(me.ocs.data.id, 'ben');
    assert.equal(me.ocs.data.quota.total, -3, 'no limit reads as -3, as the apps expect');
  } finally {
    await s.close();
  }
});

test('everything survives a restart: the document is saved and read back', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  await ana('/remote.php/dav/files/ana/keep.txt', { method: 'PUT', body: 'kept' });
  await s.close();
  const again = await start({ persist: s.persist, objects: s.objects });
  try {
    assert.equal(await (await again.as('ana', PASS)('/remote.php/dav/files/ana/keep.txt')).text(), 'kept');
  } finally {
    await again.close();
  }
});

test('the nightly sweep purges the trash after its days, and old versions after theirs', async () => {
  let now = Date.UTC(2026, 0, 1);
  const s = await start({ now: () => now, trashDays: 30, versions: { max: 50, days: 10 } });
  const ana = s.as('ana', PASS);
  try {
    await ana('/remote.php/dav/files/ana/a.txt', { method: 'PUT', body: '1' });
    await ana('/remote.php/dav/files/ana/a.txt', { method: 'PUT', body: '2' });
    await ana('/remote.php/dav/files/ana/b.txt', { method: 'PUT', body: 'b' });
    await ana('/remote.php/dav/files/ana/b.txt', { method: 'DELETE' });
    now += 11 * 86_400_000;
    assert.deepEqual(await s.files.sweep(), { trash: 0, versions: 1, uploads: 0, grants: 0 });
    now += 20 * 86_400_000;
    assert.deepEqual(await s.files.sweep(), { trash: 1, versions: 0, uploads: 0, grants: 0 });
  } finally {
    await s.close();
  }
});

test('names the apps cannot hold are refused before anything is kept, and failed sign-ins slow down', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  try {
    const part = await ana('/remote.php/dav/files/ana/report.docx.part', { method: 'PUT', body: 'x' });
    assert.equal(part.status, 400);
    assert.match(await part.text(), /unfinished uploads/);
    assert.equal((await ana('/remote.php/dav/files/ana/CON', { method: 'MKCOL' })).status, 400);
    await ana('/remote.php/dav/files/ana/ok.txt', { method: 'PUT', body: 'x' });
    assert.equal((await ana('/remote.php/dav/files/ana/ok.txt', { method: 'MOVE', headers: { destination: `${s.base}/remote.php/dav/files/ana/.htaccess` } })).status, 400);
    assert.equal((await ana('/remote.php/dav/files/ana/ok.txt')).status, 200, 'the refused move left the file where it was');
    const wrong = s.as('ana', 'not the password');
    for (let i = 0; i < 10; i++) assert.equal((await wrong('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0' } })).status, 401);
    const limited = await wrong('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0' } });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0, 'the client is told how long to wait');
    assert.equal((await ana('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0' } })).status, 429, 'the address waits, even with the right password');
  } finally {
    await s.close();
  }
});
