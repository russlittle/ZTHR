/**
 * Fidelity to the recording of a stock Nextcloud (oracle/nextcloud.json): each test pins one answer Files once
 * gave differently from Nextcloud, at the level a client sees it. The oracle comparison itself is the overarching
 * check; these keep each fix from coming undone without a Nextcloud to compare against.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PASS, parseMultistatus, start } from './helpers.ts';

const PROPS = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:prop><d:resourcetype/><d:getcontentlength/><oc:fileid/><nc:is-encrypted/><nc:has-preview/></d:prop></d:propfind>';
const dest = (s: { base: string }, p: string) => ({ destination: `${s.base}/remote.php/dav/files/ana${p}` });

test('headers on every answer: a request id except on status.php and a WebDAV error, text/html on an empty 201', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  try {
    const made = await ana('/remote.php/dav/files/ana/A', { method: 'MKCOL' });
    assert.equal(made.status, 201);
    assert.match(made.headers.get('x-request-id') ?? '', /^[A-Za-z0-9_-]{20}$/);
    assert.equal(made.headers.get('content-type'), 'text/html; charset=UTF-8', 'PHP names a type on an empty 201');
    const again = await ana('/remote.php/dav/files/ana/A', { method: 'MKCOL' });
    assert.equal(again.status, 405);
    assert.equal(again.headers.get('x-request-id'), null, 'Nextcloud adds the id only after a WebDAV method completes');
    const gone = await ana('/remote.php/dav/files/ana/A', { method: 'DELETE' });
    assert.equal(gone.status, 204);
    assert.ok(gone.headers.get('x-request-id'));
    assert.equal(gone.headers.get('content-type'), null, 'no type on a 204');
    assert.ok((await ana('/ocs/v2.php/cloud/user?format=json')).headers.get('x-request-id'));
    assert.equal((await s.anon('/status.php')).headers.get('x-request-id'), null);
  } finally {
    await s.close();
  }
});

test('PROPFIND: the DAV header on every answer, claiming only what Files has, and is-encrypted not found', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  try {
    await ana('/remote.php/dav/files/ana/a.txt', { method: 'PUT', body: 'hello' });
    const r = await ana('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '1' }, body: PROPS });
    assert.equal(r.status, 207);
    assert.equal(r.headers.get('dav'), '1, 3');
    const [root, file] = parseMultistatus(await r.text());
    assert.ok(root!.missing.includes('nc:is-encrypted') && root!.missing.includes('d:getcontentlength'));
    assert.ok(file!.missing.includes('nc:is-encrypted'), 'Nextcloud answers is-encrypted only for an encrypted folder');
    assert.equal(file!.props['nc:has-preview'], 'false');
    const missing = await ana('/remote.php/dav/files/ana/none.txt', { method: 'PROPFIND', headers: { depth: '0' }, body: PROPS });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('dav'), '1, 3');
    const opts = await ana('/remote.php/dav/files/ana/', { method: 'OPTIONS' });
    assert.doesNotMatch(opts.headers.get('dav') ?? '', /extended-mkcol|access-control|calendar/, 'features Files lacks are not claimed');
  } finally {
    await s.close();
  }
});

test('WebDAV errors carry Sabre\'s exception and wording, and the header an Overwrite refusal is about', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  const error = async (r: Response) => {
    const t = await r.text();
    return { status: r.status, exception: /<s:exception>([^<]*)</.exec(t)?.[1], message: /<s:message>([^<]*)</.exec(t)?.[1], header: /<s:header>([^<]*)</.exec(t)?.[1] };
  };
  try {
    await ana('/remote.php/dav/files/ana/A', { method: 'MKCOL' });
    assert.deepEqual(await error(await ana('/remote.php/dav/files/ana/A', { method: 'MKCOL' })), { status: 405, exception: 'Sabre\\DAV\\Exception\\MethodNotAllowed', message: 'The resource you tried to create already exists', header: undefined });
    assert.deepEqual(await error(await ana('/remote.php/dav/files/ana/missing/inner', { method: 'MKCOL' })), { status: 409, exception: 'Sabre\\DAV\\Exception\\Conflict', message: 'Parent node does not exist', header: undefined });
    assert.deepEqual(await error(await ana('/remote.php/dav/files/ana/A/none.txt', { method: 'PROPFIND', headers: { depth: '0' } })), { status: 404, exception: 'Sabre\\DAV\\Exception\\NotFound', message: 'File with name /A/none.txt could not be located', header: undefined });
    await ana('/remote.php/dav/files/ana/A/b.txt', { method: 'PUT', body: 'b' });
    await ana('/remote.php/dav/files/ana/A/c.txt', { method: 'PUT', body: 'c' });
    assert.deepEqual(await error(await ana('/remote.php/dav/files/ana/A/b.txt', { method: 'COPY', headers: { ...dest(s, '/A/c.txt'), overwrite: 'F' } })), { status: 412, exception: 'Sabre\\DAV\\Exception\\PreconditionFailed', message: 'The destination node already exists, and the overwrite header is set to false', header: 'Overwrite' });
    assert.equal((await error(await ana('/remote.php/dav/files/ana/A/b.txt', { method: 'MOVE', headers: { ...dest(s, '/A/c.txt'), overwrite: 'F' } }))).header, 'Overwrite');
    assert.equal((await error(await ana('/remote.php/dav/files/ana/A/b.txt', { method: 'PROPFIND', headers: { depth: 'infinity' } }))).exception, 'Sabre\\DAV\\Exception\\Forbidden');
  } finally {
    await s.close();
  }
});

test('reads, copies and moves name the headers Nextcloud names: no file id on a read, no etag on a copy', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  try {
    await ana('/remote.php/dav/files/ana/a.txt', { method: 'PUT', body: 'hello again' });
    const read = await ana('/remote.php/dav/files/ana/a.txt');
    assert.ok(read.headers.get('etag'));
    assert.equal(read.headers.get('oc-fileid'), null);
    const range = await ana('/remote.php/dav/files/ana/a.txt', { headers: { range: 'bytes=6-' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('oc-fileid'), null);
    const copy = await ana('/remote.php/dav/files/ana/a.txt', { method: 'COPY', headers: dest(s, '/c.txt') });
    assert.equal(copy.status, 201);
    assert.ok(copy.headers.get('oc-fileid'));
    assert.equal(copy.headers.get('etag'), null);
    assert.equal(copy.headers.get('oc-etag'), null);
    const move = await ana('/remote.php/dav/files/ana/a.txt', { method: 'MOVE', headers: dest(s, '/b.txt') });
    assert.ok(move.headers.get('etag') && move.headers.get('oc-etag') && move.headers.get('oc-fileid'));
  } finally {
    await s.close();
  }
});

test('the trash itself answers only resourcetype; what else is asked of it is not found', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  try {
    await ana('/remote.php/dav/files/ana/c.txt', { method: 'PUT', body: 'c' });
    await ana('/remote.php/dav/files/ana/c.txt', { method: 'DELETE' });
    const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:prop><nc:trashbin-filename/><nc:trashbin-original-location/><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>';
    const r = await ana('/remote.php/dav/trashbin/ana/trash/', { method: 'PROPFIND', headers: { depth: '1' }, body });
    assert.equal(r.headers.get('dav'), '1, 3');
    const [head, item] = parseMultistatus(await r.text());
    assert.deepEqual(Object.keys(head!.props), ['d:resourcetype']);
    assert.deepEqual(head!.missing.sort(), ['d:getcontentlength', 'nc:trashbin-filename', 'nc:trashbin-original-location']);
    assert.equal(item!.props['nc:trashbin-filename'], 'c.txt');
  } finally {
    await s.close();
  }
});

test('OCS: version 2 leaves the paging fields out of meta, version 1 keeps them', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  try {
    const v2 = await (await ana('/ocs/v2.php/cloud/user?format=json')).json();
    assert.deepEqual(v2.ocs.meta, { status: 'ok', statuscode: 200, message: 'OK' });
    const v1 = await (await ana('/ocs/v1.php/cloud/user?format=json')).json();
    assert.deepEqual(v1.ocs.meta, { status: 'ok', statuscode: 100, message: 'OK', totalitems: '', itemsperpage: '' });
  } finally {
    await s.close();
  }
});

test('capabilities: an etag with 304, only features Files has, and the person\'s own settings when signed in', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  try {
    const r = await ana('/ocs/v2.php/cloud/capabilities?format=json');
    const etag = r.headers.get('etag');
    assert.match(etag ?? '', /^"[0-9a-f]{32}"$/);
    const c = (await r.json()).ocs.data.capabilities;
    assert.equal((await ana('/ocs/v2.php/cloud/capabilities?format=json', { headers: { 'if-none-match': etag! } })).status, 304);
    assert.deepEqual(c.core.user, { language: '', locale: '', timezone: 'UTC' });
    assert.equal((await (await s.anon('/ocs/v2.php/cloud/capabilities?format=json')).json()).ocs.data.capabilities.core.user, undefined, 'no person, no settings');
    assert.deepEqual(c.dav, { chunking: '1.0', public_shares_chunking: false }, 'no bulk upload, out-of-office or search is claimed');
    assert.deepEqual(c.bruteforce, { 'allow-listed': false, delay: 0 });
    assert.equal(c.user, undefined);
    assert.equal(c.files.delete_from_trash, true);
    assert.equal(c.files.version_labeling, true);
    assert.equal(c.files.version_deletion, true);
    assert.deepEqual(c.files.file_conversions, []);
    assert.deepEqual(c.files_sharing.public.expire_date, { enabled: false }, 'no default expiry for links');
    assert.deepEqual(c.files_sharing.public.expire_date_internal, { enabled: false });
    assert.equal(c.theming.productName, 'Files');
    // What is claimed as refused is refused.
    for (const name of c.files.forbidden_filename_basenames as string[]) assert.equal((await ana(`/remote.php/dav/files/ana/${name}.txt`, { method: 'PUT', body: 'x' })).status, 400, name);
    for (const end of c.files.forbidden_filename_extensions as string[]) assert.equal((await ana(`/remote.php/dav/files/ana/${encodeURIComponent(`x${end}`)}`, { method: 'PUT', body: 'x' })).status, 400, JSON.stringify(end));
    assert.equal((await ana('/remote.php/dav/files/ana/console.txt', { method: 'PUT', body: 'x' })).status, 201, 'a longer name is not reserved');
  } finally {
    await s.close();
  }
});

test('who am I: the profile fields Nextcloud lists for everyone are there, empty', async () => {
  const s = await start();
  try {
    const d = (await (await s.as('ana', PASS)('/ocs/v2.php/cloud/user?format=json')).json()).ocs.data;
    for (const k of ['biography', 'bluesky', 'fediverse', 'headline', 'manager', 'organisation', 'pronouns', 'role', 'timezone']) assert.equal(d[k], '', k);
    assert.deepEqual(d.additional_mail, []);
    assert.equal(d.notify_email, null);
    assert.equal(typeof d.firstLoginTimestamp, 'number');
    assert.equal(typeof d.lastLoginTimestamp, 'number');
  } finally {
    await s.close();
  }
});

test('a share names its item as Nextcloud does: size, time, the asker\'s permissions on it, and its mount', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  const ben = s.as('ben', PASS);
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  try {
    await ana('/remote.php/dav/files/ana/b.txt', { method: 'PUT', headers: { 'x-oc-mtime': '1700000100' }, body: 'hello again' });
    const link = (await (await ana('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', { method: 'POST', headers: form, body: 'path=/b.txt&shareType=3&permissions=1' })).json()).ocs.data;
    assert.equal(link.item_size, 11);
    assert.equal(link.item_mtime, 1700000100);
    assert.equal(link.item_permissions, 27, 'everything but create, on a file the asker owns');
    assert.equal(link['is-mount-root'], false);
    assert.equal(link['mount-type'], '');
    assert.equal(link.share_with_displayname, '(Shared link)');
    await ana('/remote.php/dav/files/ana/D', { method: 'MKCOL' });
    await ana('/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', { method: 'POST', headers: form, body: 'path=/D&shareType=0&shareWith=ben&permissions=1' });
    const mine = (await (await ben('/ocs/v2.php/apps/files_sharing/api/v1/shares?shared_with_me=true&format=json')).json()).ocs.data;
    assert.equal(mine[0].item_permissions, 1, 'what the recipient may do');
    assert.equal(mine[0]['is-mount-root'], true);
    assert.equal(mine[0]['mount-type'], 'shared');
  } finally {
    await s.close();
  }
});

test('versions: a version can be labelled, the label kept, and a version deleted for good', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  const ben = s.as('ben', PASS);
  try {
    const id = Number((await ana('/remote.php/dav/files/ana/v.txt', { method: 'PUT', headers: { 'x-oc-mtime': '1700000000' }, body: 'one' })).headers.get('oc-fileid')!.slice(0, 8));
    await ana('/remote.php/dav/files/ana/v.txt', { method: 'PUT', headers: { 'x-oc-mtime': '1700000100' }, body: 'two' });
    await ana('/remote.php/dav/files/ana/v.txt', { method: 'PUT', headers: { 'x-oc-mtime': '1700000200' }, body: 'three' });
    const list = async () => parseMultistatus(await (await ana(`/remote.php/dav/versions/ana/versions/${id}`, { method: 'PROPFIND', headers: { depth: '1' }, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:prop><nc:version-label/><d:getcontentlength/></d:prop></d:propfind>' })).text()).slice(1);
    const before = await list();
    assert.equal(before.length, 2);
    const href = before[0]!.href;
    const label = (who: typeof ana, text: string, at = href) => who(at, { method: 'PROPPATCH', body: `<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:set><d:prop><nc:version-label>${text}</nc:version-label></d:prop></d:set></d:propertyupdate>` });
    assert.equal((await label(ana, 'Draft for review')).status, 207);
    assert.equal((await list())[0]!.props['nc:version-label'], 'Draft for review');
    assert.equal((await label(ben, 'mine', href.replace('/versions/ana/', '/versions/ben/'))).status, 404, 'someone the file is not shared with cannot see its versions');
    const other = await ana(href, { method: 'PROPPATCH', body: '<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:set><d:prop><oc:size>1</oc:size></d:prop></d:set></d:propertyupdate>' });
    assert.match(await other.text(), /403 Forbidden/, 'only the label of a version can be written');
    const used = await s.files.used('ana');
    assert.equal((await ana(before[1]!.href, { method: 'DELETE' })).status, 204);
    const after = await list();
    assert.equal(after.length, 1);
    assert.equal(after[0]!.href, href);
    assert.equal(await s.files.used('ana'), used - Number(before[1]!.props['d:getcontentlength']), 'its bytes are given back');
    assert.equal((await ana(before[1]!.href, { method: 'DELETE' })).status, 404);
  } finally {
    await s.close();
  }
});

test('a version label survives a restart', async () => {
  const s = await start();
  const ana = s.as('ana', PASS);
  const id = Number((await ana('/remote.php/dav/files/ana/v.txt', { method: 'PUT', body: 'one' })).headers.get('oc-fileid')!.slice(0, 8));
  await ana('/remote.php/dav/files/ana/v.txt', { method: 'PUT', body: 'two' });
  const vid = s.files.versionsOf(id)[0]!.id;
  await s.files.labelVersion('ana', id, vid, 'kept');
  await s.close();
  const again = await start({ persist: s.persist, objects: s.objects });
  try {
    assert.equal(again.files.versionsOf(id)[0]!.label, 'kept');
  } finally {
    await again.close();
  }
});
