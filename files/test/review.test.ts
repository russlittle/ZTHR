/**
 * Defects found in an independent review, each kept as a test so it stays fixed.
 */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { memoryObjects } from '../../intent/blocks/objects/index.ts';
import { State, memoryPersist } from '../src/state.ts';
import { PASS, start } from './helpers.ts';

const KB = 1024;
const MB = 1024 * KB;
const ocsForm = { 'content-type': 'application/x-www-form-urlencoded', 'ocs-apirequest': 'true' };
const form = (o: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

test('a reshare cannot be raised above what the resharer has', async () => {
  const s = await start({ people: [{ id: 'ana' }, { id: 'ben' }, { id: 'cy' }] });
  const ana = s.as('ana', PASS);
  const ben = s.as('ben', PASS);
  const cy = s.as('cy', PASS);
  try {
    await ana('/remote.php/dav/files/ana/Projects', { method: 'MKCOL' });
    await ana('/remote.php/dav/files/ana/Projects/Team', { method: 'MKCOL' });
    await ana('/remote.php/dav/files/ana/Projects/Team/plan.txt', { method: 'PUT', body: 'ana wrote this' });
    // Ben may read and reshare, nothing more.
    const sh = await (await ana('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', { method: 'POST', headers: ocsForm, body: 'path=/Projects/Team&shareType=0&shareWith=ben&permissions=17' })).json();
    assert.equal(sh.ocs.meta.statuscode, 200);
    const re = await (await ben('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', { method: 'POST', headers: ocsForm, body: 'path=/Team&shareType=0&shareWith=cy&permissions=1' })).json();
    assert.equal(re.ocs.meta.statuscode, 200);
    const raise = await (await ben(`/ocs/v2.php/apps/files_sharing/api/v1/shares/${re.ocs.data.id}?format=json`, { method: 'PUT', headers: ocsForm, body: 'permissions=31' })).json();
    assert.notEqual(raise.ocs.meta.statuscode, 200, 'ben cannot give cy more than he has');
    assert.equal((await cy('/remote.php/dav/files/cy/Team/plan.txt', { method: 'PUT', body: 'cy overwrote it' })).status, 403);
    assert.equal(await (await ana('/remote.php/dav/files/ana/Projects/Team/plan.txt')).text(), 'ana wrote this');
  } finally {
    await s.close();
  }
});

test('a forwarded-for header the client sets does not reset the sign-in limit', async () => {
  const s = await start();
  const wrong = s.as('ana', 'not the password');
  try {
    let limited = false;
    for (let i = 0; i < 15 && !limited; i++) {
      const r = await wrong('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0', 'x-forwarded-for': `10.0.0.${i}` } });
      limited = r.status === 429;
    }
    assert.ok(limited, 'the address is the connection, not what the client claims');
  } finally {
    await s.close();
  }
});

test('behind a proxy, the address is the one the proxy appended, not the first the client sent', async () => {
  const s = await start({ proxyHops: 1 });
  const wrong = s.as('ana', 'not the password');
  try {
    let limited = false;
    for (let i = 0; i < 15 && !limited; i++) {
      const r = await wrong('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0', 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` } });
      limited = r.status === 429;
    }
    assert.ok(limited);
    const other = await wrong('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0', 'x-forwarded-for': '198.51.100.9' } });
    assert.equal(other.status, 401, 'another real address is not held back');
  } finally {
    await s.close();
  }
});

test('the browser sign-in forms are throttled like Basic sign-ins', async () => {
  const s = await start();
  try {
    let limited = false;
    for (let i = 0; i < 15 && !limited; i++) limited = (await s.anon('/login', form({ user: 'ana', password: `guess ${i}`, next: '/apps/files' }))).status === 429;
    assert.ok(limited, 'the web sign-in slows down after wrong passwords');
    const s2 = await start();
    try {
      const flow = await (await s2.anon('/index.php/login/v2', { method: 'POST' })).json();
      const path = new URL(flow.login).pathname;
      let limited2 = false;
      for (let i = 0; i < 15 && !limited2; i++) limited2 = (await s2.anon(path, form({ user: 'ana', password: `guess ${i}` }))).status === 429;
      assert.ok(limited2, 'the app sign-in page slows down after wrong passwords');
    } finally {
      await s2.close();
    }
  } finally {
    await s.close();
  }
});

test('signing in to your own account does not clear the wrong guesses at someone else’s', async () => {
  const s = await start();
  const wrong = s.as('ana', 'not the password');
  const ben = s.as('ben', PASS);
  try {
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) {
      if (i % 5 === 4) await ben('/remote.php/dav/files/ben/', { method: 'PROPFIND', headers: { depth: '0' } });
      else limited = (await wrong('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0' } })).status === 429;
    }
    assert.ok(limited, 'guesses keep counting');
  } finally {
    await s.close();
  }
});

test('a log write that fails is not forgotten: the next write carries it, and no waiting request is told it was saved', async () => {
  const inner = memoryPersist();
  let failNext = 0;
  const persist = {
    ...inner,
    load: inner.load,
    snapshot: inner.snapshot,
    append: async (n: number, t: string) => {
      if (failNext > 0) {
        failNext--;
        throw new Error('the bucket is unreachable');
      }
      return inner.append(n, t);
    },
  };
  const st = await State.open(persist);
  const person = (id: string) => ({ id, display: id, passwordHash: 'h', quota: null, admin: false, groups: [], created: 0 });
  st.doc.people['a'] = person('a');
  st.mark('people', 'a');
  failNext = 1;
  const a = st.flush().then(
    () => 'saved',
    () => 'failed',
  );
  const b = st.flush().then(
    () => 'saved',
    () => 'failed',
  );
  const [ra, rb] = await Promise.all([a, b]);
  // Either both learn of the failure, or the change was retried and really saved.
  const again1 = await State.open(inner);
  for (const r of [ra, rb]) if (r === 'saved') assert.ok(again1.doc.people['a'], 'a request told "saved" must find it in the log');
  st.doc.people['b'] = person('b');
  st.mark('people', 'b');
  await st.flush();
  const again = await State.open(inner);
  assert.ok(again.doc.people['b']);
  assert.ok(again.doc.people['a'], 'the change whose write failed is written with the next one');
});

test('old versions and the trash count against the quota', async () => {
  const s = await start({ people: [{ id: 'ana', quota: 100 * KB }] });
  const ana = s.as('ana', PASS);
  try {
    const body = Buffer.alloc(40 * KB, 1);
    assert.equal((await ana('/remote.php/dav/files/ana/a.bin', { method: 'PUT', body })).status, 201);
    let stored = 0;
    for (let i = 0; i < 6; i++) {
      const r = await ana('/remote.php/dav/files/ana/a.bin', { method: 'PUT', body: Buffer.alloc(40 * KB, i + 2) });
      if (r.status < 300) stored++;
    }
    const versionBytes = s.files.versionsOf((await s.files.tree.resolve('ana', '/a.bin'))!.id).reduce((x, v) => x + v.size, 0);
    assert.ok(40 * KB + versionBytes <= 100 * KB, `a 100 KB quota holds ${40 * KB + versionBytes} bytes of file and versions`);
    await ana('/remote.php/dav/files/ana/a.bin', { method: 'DELETE' });
    for (let i = 0; i < 4; i++) {
      await ana(`/remote.php/dav/files/ana/t${i}.bin`, { method: 'PUT', body });
      await ana(`/remote.php/dav/files/ana/t${i}.bin`, { method: 'DELETE' });
    }
    const trashBytes = s.files.trashOf('ana').reduce((x, t) => x + t.nodes[0]!.size, 0);
    assert.ok(trashBytes <= 100 * KB, `a 100 KB quota holds ${trashBytes} bytes in the trash`);
    assert.ok(stored > 0, 'overwrites still work: the oldest versions make room');
  } finally {
    await s.close();
  }
});

test('chunks beyond the quota or the declared total are refused as they arrive', async () => {
  const s = await start({ people: [{ id: 'ana', quota: 12 * MB }] });
  const ana = s.as('ana', PASS);
  const up = '/remote.php/dav/uploads/ana/sneaky';
  const dest = { destination: `${s.base}/remote.php/dav/files/ana/x.bin`, 'oc-total-length': String(1024) };
  try {
    assert.equal((await ana(up, { method: 'MKCOL', headers: dest })).status, 201);
    const statuses: number[] = [];
    for (let i = 1; i <= 4; i++) statuses.push((await ana(`${up}/${i}`, { method: 'PUT', body: Buffer.alloc(5 * MB, i), headers: dest })).status);
    assert.ok(statuses.every((x) => x >= 400), `chunks larger than the declared 1 KB total: ${statuses.join(', ')}`);
    const up2 = '/remote.php/dav/uploads/ana/undeclared';
    const dest2 = { destination: `${s.base}/remote.php/dav/files/ana/y.bin` };
    assert.equal((await ana(up2, { method: 'MKCOL', headers: dest2 })).status, 201);
    const st2: number[] = [];
    for (let i = 1; i <= 4; i++) st2.push((await ana(`${up2}/${i}`, { method: 'PUT', body: Buffer.alloc(5 * MB, i), headers: dest2 })).status);
    assert.equal(st2.filter((x) => x === 201).length, 2, `a 12 MB quota takes two 5 MB chunks, then refuses: ${st2.join(', ')}`);
    assert.equal(st2[2], 507);
  } finally {
    await s.close();
  }
});

test('a share without delete cannot lose a file by moving it out', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  const ben = s.as('ben', PASS);
  try {
    await ana('/remote.php/dav/files/ana/Team', { method: 'MKCOL' });
    await ana('/remote.php/dav/files/ana/Team/keep.txt', { method: 'PUT', body: 'keep' });
    // read, update, create, share: no delete
    await ana('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', { method: 'POST', headers: ocsForm, body: 'path=/Team&shareType=0&shareWith=ben&permissions=23' });
    assert.equal((await ben('/remote.php/dav/files/ben/Team/keep.txt', { method: 'DELETE' })).status, 403, 'no delete means no delete');
    const mv = await ben('/remote.php/dav/files/ben/Team/keep.txt', { method: 'MOVE', headers: { destination: `${s.base}/remote.php/dav/files/ben/mine.txt` } });
    assert.equal(mv.status, 403, 'moving it out of her folder deletes it from her folder');
    assert.equal(await (await ana('/remote.php/dav/files/ana/Team/keep.txt')).text(), 'keep');
    const rename = await ben('/remote.php/dav/files/ben/Team/keep.txt', { method: 'MOVE', headers: { destination: `${s.base}/remote.php/dav/files/ben/Team/kept.txt` } });
    assert.equal(rename.status, 201, 'renaming in place needs only update');
  } finally {
    await s.close();
  }
});

test('copying or moving over an existing file needs the right to change it, and respects its lock', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  const ben = s.as('ben', PASS);
  try {
    await ana('/remote.php/dav/files/ana/Drop', { method: 'MKCOL' });
    await ana('/remote.php/dav/files/ana/Drop/report.txt', { method: 'PUT', body: 'the real report' });
    // read, create, share: he may add files but not change or delete hers
    await ana('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', { method: 'POST', headers: ocsForm, body: 'path=/Drop&shareType=0&shareWith=ben&permissions=21' });
    await ben('/remote.php/dav/files/ben/junk.txt', { method: 'PUT', body: 'junk' });
    const cp = await ben('/remote.php/dav/files/ben/junk.txt', { method: 'COPY', headers: { destination: `${s.base}/remote.php/dav/files/ben/Drop/report.txt`, overwrite: 'T' } });
    assert.equal(cp.status, 403);
    const mv = await ben('/remote.php/dav/files/ben/junk.txt', { method: 'MOVE', headers: { destination: `${s.base}/remote.php/dav/files/ben/Drop/report.txt`, overwrite: 'T' } });
    assert.equal(mv.status, 403);
    assert.equal(await (await ana('/remote.php/dav/files/ana/Drop/report.txt')).text(), 'the real report');
    // a lock on the target
    await ana('/remote.php/dav/files/ana/locked.txt', { method: 'PUT', body: 'locked' });
    await ana('/remote.php/dav/files/ana/other.txt', { method: 'PUT', body: 'other' });
    await s.files.leases.acquire('/ana/locked.txt', 'someone-else', { holder: 'x', deep: false, ms: 60_000 });
    const over = await ana('/remote.php/dav/files/ana/other.txt', { method: 'COPY', headers: { destination: `${s.base}/remote.php/dav/files/ana/locked.txt` } });
    assert.equal(over.status, 423);
    assert.equal(await (await ana('/remote.php/dav/files/ana/locked.txt')).text(), 'locked');
  } finally {
    await s.close();
  }
});

test('an app password cannot change the account password', async () => {
  const s = await start();
  try {
    const { password } = await s.files.devices.issue('ana', 'phone');
    const phone = s.as('ana', password);
    const r = await (await phone('/ocs/v2.php/cloud/users/ana?format=json', { method: 'PUT', headers: ocsForm, body: 'key=password&value=taken%20over%20now' })).json();
    assert.equal(r.ocs.meta.statuscode, 403);
    assert.equal((await s.as('ana', PASS)('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0' } })).status, 207, 'the account password still signs in');
  } finally {
    await s.close();
  }
});

test('opening a password link page does not count as a wrong password', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  try {
    await ana('/remote.php/dav/files/ana/p.txt', { method: 'PUT', body: 'secret' });
    const sh = await (await ana('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', { method: 'POST', headers: ocsForm, body: 'path=/p.txt&shareType=3&password=long%20enough%20pw' })).json();
    const url = new URL(sh.ocs.data.url).pathname;
    for (let i = 0; i < 8; i++) await s.anon(url);
    const right = await s.anon(url, form({ password: 'long enough pw' }));
    assert.equal(right.status, 303, 'the right password still opens it after the page was viewed a few times');
  } finally {
    await s.close();
  }
});

test('malformed percent-encoding is a bad request, not a server error', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  try {
    assert.equal((await ana('/remote.php/dav/files/ana/%E0%A4%A', { method: 'PROPFIND', headers: { depth: '0' } })).status, 400);
    const r = await s.anon('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0', authorization: `Basic ${Buffer.from('%zz:x').toString('base64')}` } });
    assert.equal(r.status, 401);
  } finally {
    await s.close();
  }
});

test('listing the shares on a folder shared with you does not show other people’s links', async () => {
  const s = await start({ people: [{ id: 'ana' }, { id: 'ben' }, { id: 'cy' }] });
  const ana = s.as('ana', PASS);
  const ben = s.as('ben', PASS);
  try {
    await ana('/remote.php/dav/files/ana/Team', { method: 'MKCOL' });
    await ana('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', { method: 'POST', headers: ocsForm, body: 'path=/Team&shareType=0&shareWith=ben&permissions=1' });
    const link = await (await ana('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', { method: 'POST', headers: ocsForm, body: 'path=/Team&shareType=3' })).json();
    const seen = await (await ben('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json&path=/Team&reshares=true', { headers: ocsForm })).text();
    assert.ok(!seen.includes(link.ocs.data.token), 'her link token is not his to see');
  } finally {
    await s.close();
  }
});

test('a Destination that only begins like your files folder is refused', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  try {
    await ana('/remote.php/dav/files/ana/doc.txt', { method: 'PUT', body: 'x' });
    await ana('/remote.php/dav/files/ana/bel', { method: 'MKCOL' });
    const r = await ana('/remote.php/dav/files/ana/doc.txt', { method: 'MOVE', headers: { destination: `${s.base}/remote.php/dav/files/anabel/doc.txt` } });
    assert.ok(r.status === 400 || r.status === 403 || r.status === 502, `status ${r.status}`);
    assert.equal((await ana('/remote.php/dav/files/ana/bel/doc.txt')).status, 404);
    assert.equal((await ana('/remote.php/dav/files/ana/doc.txt')).status, 200);
  } finally {
    await s.close();
  }
});

test('a disabled person’s public links stop working', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  try {
    await ana('/remote.php/dav/files/ana/p.txt', { method: 'PUT', body: 'public' });
    const sh = await (await ana('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', { method: 'POST', headers: ocsForm, body: 'path=/p.txt&shareType=3' })).json();
    const url = new URL(sh.ocs.data.url).pathname;
    assert.equal(await (await s.anon(`${url}/download`)).text(), 'public');
    s.files.updatePerson('ana', { disabled: true });
    assert.equal((await s.anon(`${url}/download`)).status, 404);
  } finally {
    await s.close();
  }
});

test('a write into a folder you may not write to is refused before the bytes are stored', async () => {
  const objects = memoryObjects();
  let puts = 0;
  const counting = { ...objects, put: (...a: Parameters<typeof objects.put>) => (puts++, objects.put(...a)) };
  const s = await start({ objects: counting });
  const ana = s.as('ana', PASS);
  const ben = s.as('ben', PASS);
  try {
    await ana('/remote.php/dav/files/ana/Read', { method: 'MKCOL' });
    await ana('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', { method: 'POST', headers: ocsForm, body: 'path=/Read&shareType=0&shareWith=ben&permissions=1' });
    puts = 0;
    assert.equal((await ben('/remote.php/dav/files/ben/Read/x.bin', { method: 'PUT', body: Buffer.alloc(64 * KB) })).status, 403);
    assert.equal(puts, 0, 'nothing was streamed into the store');
  } finally {
    await s.close();
  }
});

test('a body shorter than its Content-Length is not kept as the file', async () => {
  const s = await start();
  try {
    const url = new URL(`${s.base}/remote.php/dav/files/ana/short.txt`);
    const status = await new Promise<number | 'reset'>((ok) => {
      const req = request(url, { method: 'PUT', headers: { authorization: `Basic ${Buffer.from(`ana:${PASS}`).toString('base64')}`, 'content-length': '100' } }, (res) => {
        res.resume();
        ok(res.statusCode ?? 0);
      });
      req.on('error', () => ok('reset'));
      req.write('only twenty bytes...');
      setTimeout(() => req.destroy(), 200);
    });
    await s.files.state.flush();
    assert.ok(status === 'reset' || status >= 400, `status ${status}`);
    assert.equal(await s.files.tree.resolve('ana', '/short.txt'), undefined, 'no truncated file');
  } finally {
    await s.close();
  }
});

test('lowering a share lowers every reshare made from it, and revoking it ends them', async () => {
  const s = await start({ people: [{ id: 'ana' }, { id: 'ben' }, { id: 'cy' }] });
  const ana = s.as('ana', PASS);
  const ben = s.as('ben', PASS);
  const cy = s.as('cy', PASS);
  try {
    await ana('/remote.php/dav/files/ana/Team', { method: 'MKCOL' });
    await ana('/remote.php/dav/files/ana/Team/plan.txt', { method: 'PUT', body: 'ana wrote this' });
    const sh = await (await ana('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', { method: 'POST', headers: ocsForm, body: 'path=/Team&shareType=0&shareWith=ben&permissions=31' })).json();
    await ben('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', { method: 'POST', headers: ocsForm, body: 'path=/Team&shareType=0&shareWith=cy&permissions=31' });
    await ana(`/ocs/v2.php/apps/files_sharing/api/v1/shares/${sh.ocs.data.id}?format=json`, { method: 'PUT', headers: ocsForm, body: 'permissions=17' });
    assert.equal((await cy('/remote.php/dav/files/cy/Team/plan.txt', { method: 'PUT', body: 'cy overwrote it' })).status, 403, 'cy has no more than ben now has');
    await ana(`/ocs/v2.php/apps/files_sharing/api/v1/shares/${sh.ocs.data.id}?format=json`, { method: 'DELETE', headers: ocsForm });
    assert.equal((await cy('/remote.php/dav/files/cy/Team/plan.txt')).status, 404, 'and nothing once ben has nothing');
    assert.equal(await (await ana('/remote.php/dav/files/ana/Team/plan.txt')).text(), 'ana wrote this');
  } finally {
    await s.close();
  }
});

test('a folder share with delete lets the files in it be deleted, and shows D on them', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  const ben = s.as('ben', PASS);
  try {
    await ana('/remote.php/dav/files/ana/Team', { method: 'MKCOL' });
    await ana('/remote.php/dav/files/ana/Team/old.txt', { method: 'PUT', body: 'x' });
    await ana('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', { method: 'POST', headers: ocsForm, body: 'path=/Team&shareType=0&shareWith=ben&permissions=15' });
    const list = await (await ben('/remote.php/dav/files/ben/Team/', { method: 'PROPFIND', headers: { depth: '1' }, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:permissions/></d:prop></d:propfind>' })).text();
    assert.match(list, /old\.txt[\s\S]*<oc:permissions>SGDNVW<\/oc:permissions>/);
    assert.equal((await ben('/remote.php/dav/files/ben/Team/old.txt', { method: 'DELETE' })).status, 204);
    assert.equal(s.files.trashOf('ana').length, 1, 'into her trash');
  } finally {
    await s.close();
  }
});
