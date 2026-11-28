import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PASS, start } from './helpers.ts';

const form = (o: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

test('in a browser: sign in, make a folder, upload over WebDAV with the request token, share a link, delete', async () => {
  const s = await start();
  try {
    const first = await s.anon('/apps/files');
    assert.equal(first.status, 303);
    assert.match(first.headers.get('location')!, /^\/login\?next=/);
    const bad = await s.anon('/login', form({ user: 'ana', password: 'nope', next: '/apps/files' }));
    assert.equal(bad.status, 401);
    const ok = await s.anon('/login', form({ user: 'ana', password: PASS, next: '/apps/files' }));
    assert.equal(ok.status, 303);
    const cookie = ok.headers.get('set-cookie')!.split(';')[0]!;
    assert.match(ok.headers.get('set-cookie')!, /HttpOnly; Secure; SameSite=Lax/);
    const as = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => s.anon(path, { ...init, headers: { cookie, ...((init.headers ?? {}) as Record<string, string>) } });
    const list = await (await as('/apps/files')).text();
    const token = /name="requesttoken" value="([^"]+)"/.exec(list)![1]!;
    assert.match(list, /This folder is empty/);

    assert.equal((await as('/apps/files/mkdir', form({ name: 'Trip', dir: '/' }))).status, 403, 'a change without the request token is refused');
    const made = await as('/apps/files/mkdir', form({ name: 'Trip', dir: '/', requesttoken: token }));
    assert.equal(made.status, 303);
    assert.equal((await as('/remote.php/dav/files/ana/Trip/plan.txt', { method: 'PUT', body: 'day one' })).status, 401, 'the cookie alone does not reach WebDAV');
    assert.equal((await as('/remote.php/dav/files/ana/Trip/plan.txt', { method: 'PUT', body: 'day one', headers: { requesttoken: token } })).status, 201);
    const trip = await (await as('/apps/files?dir=/Trip')).text();
    assert.match(trip, /plan\.txt/);
    assert.match(trip, /aria-current="page">Trip</);
    assert.equal(await (await as('/apps/files/download?path=/Trip/plan.txt')).text(), 'day one');
    const shared = await as('/apps/files/share', form({ path: '/Trip/plan.txt', dir: '/Trip', requesttoken: token }));
    const note = decodeURIComponent(/note=([^&]+)/.exec(shared.headers.get('location')!)![1]!);
    assert.match(note, /^link:[A-Za-z0-9]{15}$/);
    assert.equal(await (await s.anon(`/s/${note.slice(5)}/download`)).text(), 'day one', 'the link works for anyone');
    assert.equal((await as('/apps/files/delete', form({ path: '/Trip/plan.txt', dir: '/Trip', requesttoken: token }))).status, 303);
    assert.equal(s.files.trashOf('ana').length, 1, 'deleted to the trash');
    const out = await as('/logout', form({ requesttoken: token }));
    assert.equal(out.status, 303);
    assert.equal((await as('/apps/files')).status, 303, 'signed out');
  } finally {
    await s.close();
  }
});

test('the web interface never redirects off the site after sign-in', async () => {
  const s = await start();
  try {
    const r = await s.anon('/login', form({ user: 'ana', password: PASS, next: 'https://evil.example/' }));
    assert.equal(r.headers.get('location'), '/apps/files');
  } finally {
    await s.close();
  }
});
