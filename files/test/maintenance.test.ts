/**
 * Defects found in a security and protocol review, and by litmus, each kept as a test so it stays fixed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseXml } from '../../intent/blocks/dav/index.ts';
import { PASS, PROPS, parseMultistatus, start, type Running } from './helpers.ts';

const MB = 1024 * 1024;
const ocsForm = { 'content-type': 'application/x-www-form-urlencoded', 'ocs-apirequest': 'true' };
const form = (o: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
const NFC = 'résumé.txt';
const NFD = 'résumé.txt';

/** Signs in in the browser; returns a fetch carrying the cookie, and the request token. */
async function browser(s: Running, user: string, password = PASS) {
  const ok = await s.anon('/login', form({ user, password, next: '/apps/files' }));
  assert.equal(ok.status, 303, 'signed in');
  const cookie = ok.headers.get('set-cookie')!.split(';')[0]!;
  const as = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => s.anon(path, { ...init, headers: { cookie, ...((init.headers ?? {}) as Record<string, string>) } });
  const token = /name="requesttoken" value="([^"]+)"/.exec(await (await as('/apps/files')).text())![1]!;
  return { as, token };
}

async function appPassword(s: Running, user: string, password = PASS): Promise<string> {
  const r = await (await s.as(user, password)('/ocs/v2.php/core/getapppassword?format=json', { headers: { 'ocs-apirequest': 'true', 'user-agent': 'Nextcloud-android' } })).json();
  return r.ocs.data.apppassword;
}

// ---------------------------------------------------------------- litmus props

test('litmus: a PROPFIND body with an invalid namespace declaration is a bad request', async () => {
  const s = await start();
  try {
    const r = await s.as('ana', PASS)('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0' }, body: '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><bar:foo xmlns:bar=""/></prop></propfind>' });
    assert.equal(r.status, 400);
  } finally {
    await s.close();
  }
});

test('litmus: a property set in no namespace comes back in a multistatus that parses', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  try {
    await ana('/remote.php/dav/files/ana/prop2', { method: 'PUT', body: 'x' });
    const set = await ana('/remote.php/dav/files/ana/prop2', { method: 'PROPPATCH', body: '<?xml version="1.0"?><propertyupdate xmlns="DAV:"><set><prop><nonamespace xmlns="">randomvalue</nonamespace></prop></set></propertyupdate>' });
    assert.equal(set.status, 207);
    const body = await (await ana('/remote.php/dav/files/ana/prop2', { method: 'PROPFIND', headers: { depth: '0' }, body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><nonamespace xmlns=""/></prop></propfind>' })).text();
    const doc = parseXml(body);
    const prop = doc.children[0]!.children.find((c) => c.name === 'propstat')!.children.find((c) => c.name === 'prop')!;
    assert.deepEqual(
      prop.children.map((c) => [c.ns, c.name, c.text]),
      [['', 'nonamespace', 'randomvalue']],
    );
  } finally {
    await s.close();
  }
});

test('litmus: a PROPPATCH that removes then sets one property applies them in order, leaving it set', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  try {
    await ana('/remote.php/dav/files/ana/p', { method: 'PUT', body: 'x' });
    const ns = 'http://example.com/neon/litmus/';
    const r = await ana('/remote.php/dav/files/ana/p', { method: 'PROPPATCH', body: `<?xml version="1.0"?><propertyupdate xmlns="DAV:" xmlns:z="${ns}"><remove><prop><z:removeset/></prop></remove><set><prop><z:removeset>x</z:removeset></prop></set></propertyupdate>` });
    assert.equal(r.status, 207);
    const got = await (await ana('/remote.php/dav/files/ana/p', { method: 'PROPFIND', headers: { depth: '0' }, body: `<?xml version="1.0"?><propfind xmlns="DAV:"><prop><z:removeset xmlns:z="${ns}"/></prop></propfind>` })).text();
    assert.match(got, /<x1:removeset>x<\/x1:removeset>/);
  } finally {
    await s.close();
  }
});

test('a property name that is not an XML name is refused, not echoed into a broken multistatus', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  try {
    const r = await ana('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0' }, body: '<d:propfind xmlns:d="DAV:"><d:prop><d:a"b/></d:prop></d:propfind>' });
    assert.equal(r.status, 400);
    await ana('/remote.php/dav/files/ana/f', { method: 'PUT', body: 'x' });
    assert.equal((await ana('/remote.php/dav/files/ana/f', { method: 'PROPPATCH', body: '<d:propertyupdate xmlns:d="DAV:" xmlns:x="urn:x"><d:set><d:prop><x:a&amp;b>1</x:a&amp;b></d:prop></d:set></d:propertyupdate>' })).status, 400);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- uploads

test('a chunked upload whose assembly is refused keeps its chunks, so the client can retry', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  const up = '/remote.php/dav/uploads/ana/retry';
  const dest = { destination: `${s.base}/remote.php/dav/files/ana/big.bin` };
  try {
    await ana('/remote.php/dav/files/ana/big.bin', { method: 'PUT', body: 'old' });
    assert.equal((await ana(up, { method: 'MKCOL', headers: dest })).status, 201);
    assert.equal((await ana(`${up}/1`, { method: 'PUT', body: Buffer.alloc(5 * MB, 1), headers: dest })).status, 201);
    assert.equal((await ana(`${up}/2`, { method: 'PUT', body: 'tail', headers: dest })).status, 201);
    const objectsBefore = (s.objects as unknown as { count(): number }).count();
    const refused = await ana(`${up}/.file`, { method: 'MOVE', headers: { ...dest, 'if-match': '"not-the-etag"' } });
    assert.equal(refused.status, 412);
    assert.equal((s.objects as unknown as { count(): number }).count(), objectsBefore, 'the joined copy that was not committed is gone, the chunks stay');
    const done = await ana(`${up}/.file`, { method: 'MOVE', headers: dest });
    assert.equal(done.status, 204);
    assert.equal((await (await ana('/remote.php/dav/files/ana/big.bin')).arrayBuffer()).byteLength, 5 * MB + 4);
    assert.equal((await ana(up, { method: 'PROPFIND', headers: { depth: '1' } })).status, 404, 'the session ends once the file is saved');
    assert.equal(Object.keys(s.files.state.doc.sessions).length, 0);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- sign-in limits

test('a person who mistypes their own password is not held back once they get it right', async () => {
  const s = await start();
  try {
    for (let i = 0; i < 9; i++) assert.equal((await s.as('ana', 'typo')('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0' } })).status, 401);
    assert.equal((await s.as('ana', PASS)('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0' } })).status, 207);
    for (let i = 0; i < 5; i++) assert.equal((await s.as('ana', 'typo')('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0' } })).status, 401);
    assert.equal((await s.as('ana', PASS)('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0' } })).status, 207);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- Unicode

test('names are NFC: a decomposed name reaches the composed file, over WebDAV, OCS and the web interface', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  try {
    assert.equal((await ana(`/remote.php/dav/files/ana/${encodeURIComponent(NFD)}`, { method: 'PUT', body: 'one' })).status, 201);
    assert.equal(await (await ana(`/remote.php/dav/files/ana/${encodeURIComponent(NFC)}`)).text(), 'one');
    assert.equal((await ana(`/remote.php/dav/files/ana/${encodeURIComponent(NFC)}`, { method: 'PUT', body: 'two' })).status, 204, 'the same file');
    const list = parseMultistatus(await (await ana('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '1' }, body: PROPS })).text());
    assert.deepEqual(
      list.map((x) => x.href).filter((h) => h.endsWith('.txt')),
      [`/remote.php/dav/files/ana/${NFC}`],
    );
    assert.equal((await ana(`/remote.php/dav/files/ana/${encodeURIComponent(NFD)}`, { method: 'MOVE', headers: { destination: `${s.base}/remote.php/dav/files/ana/caf${encodeURIComponent('é')}.txt` } })).status, 201);
    assert.equal(await (await ana(`/remote.php/dav/files/ana/caf${encodeURIComponent('é')}.txt`)).text(), 'two');
    const sh = await (await ana('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', { method: 'POST', headers: ocsForm, body: new URLSearchParams({ path: '/café.txt', shareType: '3' }).toString() })).json();
    assert.equal(sh.ocs.meta.statuscode, 200, 'OCS finds the file by its decomposed name');
    const { as, token } = await browser(s, 'ana');
    assert.equal((await as('/apps/files/mkdir', form({ name: 'Amélie', dir: '/', requesttoken: token }))).status, 303);
    assert.ok(await s.files.tree.resolve('ana', '/Amélie'));
    assert.equal(await (await as(`/apps/files/download?path=${encodeURIComponent('/café.txt')}`)).text(), 'two');
    const up = '/remote.php/dav/uploads/ana/nfd';
    const dest = { destination: `${s.base}/remote.php/dav/files/ana/${encodeURIComponent('naïve.txt')}` };
    await ana(up, { method: 'MKCOL', headers: dest });
    await ana(`${up}/1`, { method: 'PUT', body: 'chunked', headers: dest });
    assert.equal((await ana(`${up}/.file`, { method: 'MOVE', headers: dest })).status, 201);
    assert.equal(await (await ana(`/remote.php/dav/files/ana/${encodeURIComponent('naïve.txt')}`)).text(), 'chunked');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- quota

test('the space old versions and the trash take is kept as a running total that always matches a recount', async () => {
  let now = 1_000_000;
  const s = await start({ now: () => now, versions: { max: 2, days: 10 }, people: [{ id: 'ana', admin: true, quota: 100 }, { id: 'ben', quota: 1000 }] });
  const ana = s.as('ana', PASS);
  const ben = s.as('ben', PASS);
  const check = (what: string) => {
    for (const u of ['ana', 'ben']) {
      const c = s.files.usageCheck(u);
      assert.equal(c.running, c.recount, `${u} after ${what}: running ${c.running}, recount ${c.recount}`);
    }
  };
  try {
    // The scan is only for making room; checking the quota never needs it.
    let scans = 0;
    const real = (s.files as unknown as { kept: (u: string) => Promise<unknown> }).kept.bind(s.files);
    (s.files as unknown as { kept: (u: string) => Promise<unknown> }).kept = (u: string) => {
      scans++;
      return real(u);
    };
    await ana('/remote.php/dav/files/ana/a.txt', { method: 'PUT', body: 'x'.repeat(10) });
    check('a write');
    for (let i = 0; i < 4; i++) {
      now += 1000;
      await ana('/remote.php/dav/files/ana/a.txt', { method: 'PUT', body: 'y'.repeat(10 + i) });
      check(`overwrite ${i}`);
    }
    await ana('/remote.php/dav/files/ana/b.txt', { method: 'PUT', body: 'z'.repeat(5) });
    assert.equal(scans, 0, 'no write scanned the versions and trash');
    await ana('/remote.php/dav/files/ana/a.txt', { method: 'DELETE' });
    check('delete to the trash');
    const id = s.files.trashOf('ana')[0]!.id;
    await ana(`/remote.php/dav/trashbin/ana/trash/${encodeURIComponent(id)}`, { method: 'MOVE', headers: { destination: `${s.base}/remote.php/dav/trashbin/ana/restore/a.txt` } });
    check('restore from the trash');
    const fid = (await s.files.tree.resolve('ana', '/a.txt'))!.id;
    const v = s.files.versionsOf(fid)[0]!;
    await ana(`/remote.php/dav/versions/ana/versions/${fid}/${v.id}`, { method: 'MOVE', headers: { destination: `${s.base}/remote.php/dav/versions/ana/restore/target` } });
    check('restore a version');
    await ana('/remote.php/dav/files/ana/b.txt', { method: 'MOVE', headers: { destination: `${s.base}/remote.php/dav/files/ana/a.txt`, overwrite: 'T' } });
    check('move over a file that had versions');
    await ana('/remote.php/dav/files/ana/a.txt', { method: 'DELETE' });
    await ana('/remote.php/dav/trashbin/ana/trash', { method: 'DELETE' });
    check('empty the trash');
    // Near the quota, old copies give way: making room is the one place that lists them.
    await ana('/remote.php/dav/files/ana/c.txt', { method: 'PUT', body: 'c'.repeat(40) });
    await ana('/remote.php/dav/files/ana/c.txt', { method: 'PUT', body: 'd'.repeat(40) });
    await ana('/remote.php/dav/files/ana/c.txt', { method: 'PUT', body: 'e'.repeat(40) });
    check('versions dropped to make room');
    await ben('/remote.php/dav/files/ben/v.txt', { method: 'PUT', body: '1' });
    await ben('/remote.php/dav/files/ben/v.txt', { method: 'PUT', body: '22' });
    now += 11 * 86_400_000;
    await s.files.sweep();
    check('the sweep');
    await ana('/ocs/v2.php/cloud/users/ben', { method: 'DELETE', headers: { 'ocs-apirequest': 'true' } });
    check('removing a person');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- locks and If

test('a lock stops PROPPATCH and MKCOL by anyone who does not send its token', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  try {
    await ana('/remote.php/dav/files/ana/d', { method: 'MKCOL' });
    await ana('/remote.php/dav/files/ana/f.txt', { method: 'PUT', body: 'x' });
    const lockBody = '<?xml version="1.0"?><d:lockinfo xmlns:d="DAV:"><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockinfo>';
    const fl = (await ana('/remote.php/dav/files/ana/f.txt', { method: 'LOCK', body: lockBody })).headers.get('lock-token')!;
    const dl = (await ana('/remote.php/dav/files/ana/d', { method: 'LOCK', body: lockBody, headers: { depth: 'infinity' } })).headers.get('lock-token')!;
    const patch = '<d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:set><d:prop><oc:favorite>1</oc:favorite></d:prop></d:set></d:propertyupdate>';
    assert.equal((await ana('/remote.php/dav/files/ana/f.txt', { method: 'PROPPATCH', body: patch })).status, 423);
    assert.equal((await ana('/remote.php/dav/files/ana/f.txt', { method: 'PROPPATCH', body: patch, headers: { if: `(${fl})` } })).status, 207);
    assert.equal((await ana('/remote.php/dav/files/ana/d/sub', { method: 'MKCOL' })).status, 423);
    assert.equal((await ana('/remote.php/dav/files/ana/d/sub', { method: 'MKCOL', headers: { if: `<${s.base}/remote.php/dav/files/ana/d> (${dl})` } })).status, 201);
  } finally {
    await s.close();
  }
});

test('If headers are evaluated: etags and lock tokens that do not hold fail the request with 412', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  try {
    const put = await ana('/remote.php/dav/files/ana/f.txt', { method: 'PUT', body: 'one' });
    const etag = put.headers.get('etag')!;
    assert.equal((await ana('/remote.php/dav/files/ana/f.txt', { method: 'PUT', body: 'two', headers: { if: '(["not-it"])' } })).status, 412);
    assert.equal(await (await ana('/remote.php/dav/files/ana/f.txt')).text(), 'one');
    const ok = await ana('/remote.php/dav/files/ana/f.txt', { method: 'PUT', body: 'two', headers: { if: `([${etag}])` } });
    assert.equal(ok.status, 204);
    assert.equal((await ana('/remote.php/dav/files/ana/f.txt', { method: 'DELETE', headers: { if: '(<opaquelocktoken:00000000-0000-0000-0000-000000000000>)' } })).status, 412, 'a lock token for no lock on it');
    assert.equal((await ana('/remote.php/dav/files/ana/f.txt', { method: 'PROPPATCH', headers: { if: `(Not [${ok.headers.get('etag')}])` }, body: '<d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:set><d:prop><oc:favorite>1</oc:favorite></d:prop></d:set></d:propertyupdate>' })).status, 412);
    assert.equal((await ana('/remote.php/dav/files/ana/f.txt', { method: 'DELETE', headers: { if: `(Not <DAV:no-lock> [${ok.headers.get('etag')}])` } })).status, 204);
    assert.equal((await ana('/remote.php/dav/files/ana/g', { method: 'PUT', body: 'x', headers: { if: '(<broken' } })).status, 400);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- moving between trees

test('moving a file into a folder someone shared keeps its file id and its versions, as Nextcloud does', async () => {
  const s = await start({ people: [{ id: 'ana' }, { id: 'ben' }] });
  const ana = s.as('ana', PASS);
  const ben = s.as('ben', PASS);
  try {
    await ana('/remote.php/dav/files/ana/Team', { method: 'MKCOL' });
    const sh = await (await ana('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', { method: 'POST', headers: ocsForm, body: 'path=/Team&shareType=0&shareWith=ben&permissions=31' })).json();
    assert.equal(sh.ocs.meta.statuscode, 200);
    await ben('/remote.php/dav/files/ben/notes.txt', { method: 'PUT', body: 'v1' });
    const id = (await ben('/remote.php/dav/files/ben/notes.txt', { method: 'PUT', body: 'v2' })).headers.get('oc-fileid');
    const moved = await ben('/remote.php/dav/files/ben/notes.txt', { method: 'MOVE', headers: { destination: `${s.base}/remote.php/dav/files/ben/Team/notes.txt` } });
    assert.equal(moved.status, 201);
    assert.equal(moved.headers.get('oc-fileid'), id, 'the same file id');
    const node = (await s.files.tree.resolve('ana', '/Team/notes.txt'))!;
    assert.equal(node.owner, 'ana');
    assert.equal(s.files.versionsOf(node.id).length, 1, 'its old copy came with it');
    assert.equal(await (await ana('/remote.php/dav/files/ana/Team/notes.txt')).text(), 'v2');
    const vs = parseMultistatus(await (await ana(`/remote.php/dav/versions/ana/versions/${node.id}`, { method: 'PROPFIND', headers: { depth: '1' } })).text());
    assert.equal(vs.length, 2);
    assert.equal((await ben('/remote.php/dav/files/ben/notes.txt')).status, 404);
    for (const u of ['ana', 'ben']) {
      const c = s.files.usageCheck(u);
      assert.equal(c.running, c.recount, u);
    }
    assert.equal(await s.files.used('ana'), 4, 'the file and its old copy now count against the folder owner');
    assert.equal(await s.files.used('ben'), 0);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- removing a person

test('removing a person removes the bytes of their old versions and their unfinished uploads', async () => {
  const s = await start({ people: [{ id: 'ana', admin: true }, { id: 'ben' }] });
  const ana = s.as('ana', PASS);
  const ben = s.as('ben', PASS);
  const count = () => (s.objects as unknown as { count(): number }).count();
  try {
    const before = count();
    await ben('/remote.php/dav/files/ben/f.txt', { method: 'PUT', body: '1' });
    await ben('/remote.php/dav/files/ben/f.txt', { method: 'PUT', body: '2' });
    await ben('/remote.php/dav/files/ben/f.txt', { method: 'PUT', body: '3' });
    await ben('/remote.php/dav/files/ben/gone.txt', { method: 'PUT', body: 'g' });
    await ben('/remote.php/dav/files/ben/gone.txt', { method: 'PUT', body: 'h' });
    await ben('/remote.php/dav/files/ben/gone.txt', { method: 'DELETE' });
    const dest = { destination: `${s.base}/remote.php/dav/files/ben/big.bin` };
    await ben('/remote.php/dav/uploads/ben/u1', { method: 'MKCOL', headers: dest });
    await ben('/remote.php/dav/uploads/ben/u1/1', { method: 'PUT', body: Buffer.alloc(5 * MB), headers: dest });
    assert.ok(count() > before);
    assert.equal((await ana('/ocs/v2.php/cloud/users/ben', { method: 'DELETE', headers: { 'ocs-apirequest': 'true' } })).status, 200);
    assert.equal(count(), before, 'nothing of Ben’s is left in the store');
    assert.deepEqual(Object.keys(s.files.state.doc.sessions), []);
    assert.deepEqual(Object.keys(s.files.state.doc.versions), []);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- sessions and app passwords

test('a password change ends web sessions but keeps app passwords; disabling ends both', async () => {
  const s = await start({ people: [{ id: 'ana', admin: true }, { id: 'ben' }] });
  const ana = s.as('ana', PASS);
  try {
    const app = await appPassword(s, 'ben');
    const web = await browser(s, 'ben');
    assert.equal((await web.as('/apps/files')).status, 200);
    const NEW = 'a new password for ben';
    assert.equal((await ana('/ocs/v2.php/cloud/users/ben', { method: 'PUT', headers: ocsForm, body: new URLSearchParams({ key: 'password', value: NEW }).toString() })).status, 200);
    assert.equal((await web.as('/apps/files')).status, 303, 'the old web session ended');
    assert.equal((await s.as('ben', app)('/remote.php/dav/files/ben/', { method: 'PROPFIND', headers: { depth: '0' } })).status, 207, 'the app password still works, as in Nextcloud');
    const web2 = await browser(s, 'ben', NEW);
    assert.equal((await ana('/ocs/v2.php/cloud/users/ben/disable', { method: 'PUT', headers: ocsForm })).status, 200);
    assert.equal((await s.as('ben', app)('/remote.php/dav/files/ben/', { method: 'PROPFIND', headers: { depth: '0' } })).status, 401);
    assert.equal((await ana('/ocs/v2.php/cloud/users/ben/enable', { method: 'PUT', headers: ocsForm })).status, 200);
    assert.equal((await web2.as('/apps/files')).status, 303, 'enabling again does not bring back the web session');
    assert.equal((await s.as('ben', app)('/remote.php/dav/files/ben/', { method: 'PROPFIND', headers: { depth: '0' } })).status, 401, 'nor the app password');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- remote wipe

test('remote wipe: a person marks a device in the web interface, and the device is told to wipe and reports back', async () => {
  const s = await start();
  try {
    const app = await appPassword(s, 'ben');
    const other = await appPassword(s, 'ben');
    const { as, token } = await browser(s, 'ben');
    const page = await (await as('/apps/files/devices')).text();
    assert.match(page, /Nextcloud-android/);
    const id = /name="device" value="(\d+)"/.exec(page)![1]!;
    assert.equal((await as('/apps/files/devices/wipe', form({ device: id }))).status, 403, 'not without the request token');
    assert.equal((await as('/apps/files/devices/wipe', form({ device: id, requesttoken: token, password: PASS }))).status, 303);
    assert.equal((await s.as('ben', app)('/remote.php/dav/files/ben/', { method: 'PROPFIND', headers: { depth: '0' } })).status, 401);
    assert.equal((await s.as('ben', other)('/remote.php/dav/files/ben/', { method: 'PROPFIND', headers: { depth: '0' } })).status, 207, 'only that device');
    const check = await s.anon('/index.php/core/wipe/check', form({ token: app }));
    assert.equal(check.status, 200);
    assert.deepEqual(await check.json(), { wipe: true });
    assert.equal((await s.anon('/index.php/core/wipe/success', form({ token: app }))).status, 200);
    assert.equal((await s.anon('/index.php/core/wipe/check', form({ token: app }))).status, 404, 'done, and forgotten');
    // Ana, an admin, cannot be stopped by Ben's devices page, but someone else's device is not Ben's to wipe.
    const anas = await appPassword(s, 'ana');
    const anaId = (await s.files.devices.list('ana'))[0]!.id;
    await as('/apps/files/devices/wipe', form({ device: String(anaId), requesttoken: token, password: PASS }));
    assert.equal((await s.as('ana', anas)('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0' } })).status, 207);
  } finally {
    await s.close();
  }
});

test('remote wipe: an admin wipes every device of a person over the provisioning API, or one device on the web', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  try {
    const one = await appPassword(s, 'ben');
    const two = await appPassword(s, 'ben');
    assert.equal((await s.as('ben', PASS)('/ocs/v2.php/cloud/users/ana/wipe', { method: 'POST', headers: ocsForm })).status, 403, 'not for a person who is not an admin');
    assert.equal((await ana('/ocs/v2.php/cloud/users/ben/wipe', { method: 'POST', headers: ocsForm })).status, 200);
    for (const p of [one, two]) assert.deepEqual(await (await s.anon('/index.php/core/wipe/check', form({ token: p }))).json(), { wipe: true });
    const three = await appPassword(s, 'ben');
    const { as, token } = await browser(s, 'ana');
    const page = await (await as('/apps/files/devices?user=ben')).text();
    const ids = [...page.matchAll(/name="device" value="(\d+)"/g)].map((m) => m[1]);
    const id = String((await s.files.devices.list('ben')).find((d) => !d.wipe)!.id);
    assert.ok(ids.includes(id));
    assert.equal((await as('/apps/files/devices/wipe', form({ device: id, user: 'ben', requesttoken: token, password: PASS }))).status, 303);
    assert.deepEqual(await (await s.anon('/index.php/core/wipe/check', form({ token: three }))).json(), { wipe: true });
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- login flow v2

test('the app sign-in page says which app is asking, escaped', async () => {
  const s = await start();
  try {
    const f = await (await s.anon('/index.php/login/v2', { method: 'POST', headers: { 'user-agent': 'Evil <script>alert(1)</script> & "co"' } })).json();
    const page = await (await s.anon(new URL(f.login).pathname)).text();
    assert.ok(page.includes('Evil &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;co&quot;'), page);
    assert.ok(!page.includes('<script>'));
    const poll = new URL(f.poll.endpoint);
    assert.equal((await s.anon(`/index.php/login/v2/flow/${f.poll.token}`)).status, 410, 'the poll token does not open the page');
    assert.ok(poll);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- properties on shared nodes

const FAV = (v: string) => `<d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:set><d:prop><oc:favorite>${v}</oc:favorite></d:prop></d:set></d:propertyupdate>`;
const favOf = async (f: (p: string, i?: RequestInit & { headers?: Record<string, string> }) => Promise<Response>, path: string) =>
  parseMultistatus(await (await f(path, { method: 'PROPFIND', headers: { depth: '0' }, body: '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:favorite/></d:prop></d:propfind>' })).text())[0]!.props['oc:favorite'];

test('favourites are each person’s own: a recipient’s favourite never changes the owner’s, as in Nextcloud', async () => {
  const s = await start({ people: [{ id: 'ana' }, { id: 'ben' }, { id: 'cy' }] });
  const ana = s.as('ana', PASS);
  const ben = s.as('ben', PASS);
  const cy = s.as('cy', PASS);
  try {
    await ana('/remote.php/dav/files/ana/Team', { method: 'MKCOL' });
    await ana('/remote.php/dav/files/ana/Team/plan.txt', { method: 'PUT', body: 'x' });
    for (const who of ['ben', 'cy']) await ana('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', { method: 'POST', headers: ocsForm, body: `path=/Team&shareType=0&shareWith=${who}&permissions=1` });
    assert.equal((await ben('/remote.php/dav/files/ben/Team/plan.txt', { method: 'PROPPATCH', body: FAV('1') })).status, 207, 'a read-only recipient may favourite');
    assert.equal(await favOf(ben, '/remote.php/dav/files/ben/Team/plan.txt'), '1');
    assert.equal(await favOf(ana, '/remote.php/dav/files/ana/Team/plan.txt'), '0', 'the owner’s favourite is untouched');
    assert.equal(await favOf(cy, '/remote.php/dav/files/cy/Team/plan.txt'), '0', 'and so is every other recipient’s');
    await ana('/remote.php/dav/files/ana/Team/plan.txt', { method: 'PROPPATCH', body: FAV('1') });
    await ben('/remote.php/dav/files/ben/Team/plan.txt', { method: 'PROPPATCH', body: FAV('0') });
    assert.equal(await favOf(ana, '/remote.php/dav/files/ana/Team/plan.txt'), '1');
    assert.equal(await favOf(ben, '/remote.php/dav/files/ben/Team/plan.txt'), '0');
    const report = '<oc:filter-files xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/></d:prop><oc:filter-rules><oc:favorite>1</oc:favorite></oc:filter-rules></oc:filter-files>';
    assert.equal(parseMultistatus(await (await ana('/remote.php/dav/files/ana/', { method: 'REPORT', body: report })).text()).length, 1, 'the owner’s favourites report lists it');
    await cy('/remote.php/dav/files/cy/Team', { method: 'PROPPATCH', body: FAV('1') });
    assert.equal(parseMultistatus(await (await ben('/remote.php/dav/files/ben/Team', { method: 'REPORT', body: report })).text()).length, 0, 'Ben’s lists none of Ana’s or Cy’s');
  } finally {
    await s.close();
  }
});

test('any other property write on a shared node needs update permission', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  const ben = s.as('ben', PASS);
  const custom = '<d:propertyupdate xmlns:d="DAV:" xmlns:x="urn:x"><d:set><d:prop><x:colour>red</x:colour></d:prop></d:set></d:propertyupdate>';
  const mtime = '<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:lastmodified>1000</d:lastmodified></d:prop></d:set></d:propertyupdate>';
  try {
    await ana('/remote.php/dav/files/ana/Read', { method: 'MKCOL' });
    await ana('/remote.php/dav/files/ana/Read/f.txt', { method: 'PUT', body: 'x' });
    await ana('/remote.php/dav/files/ana/Write', { method: 'MKCOL' });
    await ana('/remote.php/dav/files/ana/Write/f.txt', { method: 'PUT', body: 'x' });
    await ana('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', { method: 'POST', headers: ocsForm, body: 'path=/Read&shareType=0&shareWith=ben&permissions=1' });
    await ana('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', { method: 'POST', headers: ocsForm, body: 'path=/Write&shareType=0&shareWith=ben&permissions=3' });
    const before = (await s.files.tree.resolve('ana', '/Read/f.txt'))!;
    assert.equal((await ben('/remote.php/dav/files/ben/Read/f.txt', { method: 'PROPPATCH', body: custom })).status, 403);
    assert.equal((await ben('/remote.php/dav/files/ben/Read/f.txt', { method: 'PROPPATCH', body: mtime })).status, 403);
    const after = (await s.files.tree.resolve('ana', '/Read/f.txt'))!;
    assert.deepEqual([after.props, after.mtime], [before.props, before.mtime], 'nothing on Ana’s file changed');
    assert.equal((await ben('/remote.php/dav/files/ben/Write/f.txt', { method: 'PROPPATCH', body: custom })).status, 207);
    assert.equal((await s.files.tree.resolve('ana', '/Write/f.txt'))!.props?.['{urn:x}colour'], 'red');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- confirming a wipe

test('wiping a device on the web takes the person’s password again, and an admin confirms with their own', async () => {
  const s = await start();
  try {
    const BEN = 'bens own password';
    await s.files.setPassword('ben', BEN);
    const app = await appPassword(s, 'ben', BEN);
    const id = String((await s.files.devices.list('ben'))[0]!.id);
    const ben = await browser(s, 'ben', BEN);
    const page = await (await ben.as('/apps/files/devices')).text();
    assert.match(page, /type="password"[^>]*name="password"|name="password"[^>]*type="password"/, 'the wipe form asks for the password');
    const stillWorks = async () => (await s.as('ben', app)('/remote.php/dav/files/ben/', { method: 'PROPFIND', headers: { depth: '0' } })).status === 207;
    assert.equal((await ben.as('/apps/files/devices/wipe', form({ device: id, requesttoken: ben.token }))).status, 403, 'no password');
    assert.ok(await stillWorks());
    assert.equal((await ben.as('/apps/files/devices/wipe', form({ device: id, requesttoken: ben.token, password: 'not it' }))).status, 403, 'a wrong password');
    assert.equal((await ben.as('/apps/files/devices/wipe', form({ device: id, requesttoken: ben.token, password: app }))).status, 403, 'an app password does not confirm');
    assert.ok(await stillWorks());
    const ana = await browser(s, 'ana');
    assert.equal((await ana.as('/apps/files/devices/wipe', form({ device: id, user: 'ben', requesttoken: ana.token, password: BEN }))).status, 403, 'the admin confirms with their own password, not Ben’s');
    assert.ok(await stillWorks());
    assert.equal((await ana.as('/apps/files/devices/wipe', form({ device: id, user: 'ben', requesttoken: ana.token, password: PASS }))).status, 303, 'the admin’s own password confirms');
    assert.ok(!(await stillWorks()));
    assert.deepEqual(await (await s.anon('/index.php/core/wipe/check', form({ token: app }))).json(), { wipe: true });
  } finally {
    await s.close();
  }
});
