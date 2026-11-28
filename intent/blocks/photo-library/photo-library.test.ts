import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Grants, memoryGrants } from '../grants/index.ts';
import { Tree, memoryNodes } from '../tree/index.ts';
import { LibraryError, PhotoLibrary, bucketOf, checkTemplate, cleanStep, renderTemplate, withSuffix } from './index.ts';

const DAY = 86_400_000;
const at = (s: string) => Date.parse(s);

const make = (o: { template?: string; trashDays?: number; groups?: Record<string, string[]> } = {}) => {
  let t = at('2024-06-01T00:00:00Z');
  const now = () => t;
  const tree = new Tree(memoryNodes(), { now: () => Math.floor(t / 1000) });
  const grants = new Grants(memoryGrants(), { now });
  const lib = new PhotoLibrary({ tree, grants, now, ...(o.template ? { template: o.template } : {}), ...(o.trashDays !== undefined ? { trashDays: o.trashDays } : {}), groupsOf: (p) => o.groups?.[p] ?? [] });
  let n = 0;
  const add = (owner: string, takenAt: string, filename = `IMG_${++n}.jpg`, checksum = `sum${n}`) => lib.add({ owner, filename, size: 100, blob: `b${n}`, checksum, mime: 'image/jpeg', takenAt: at(takenAt) });
  return { lib, tree, grants, add, tick: (ms: number) => (t += ms) };
};
const code = (e: unknown) => e instanceof LibraryError && e.code;

// ------------------------------------------------------------ templates

test('a template fills dates in UTC, pads, and keeps the file name', () => {
  const v = { takenAt: at('2024-03-09T07:05:03Z'), filename: 'Beach Day.JPG', assetId: 7, owner: 'ana' };
  assert.equal(renderTemplate('{{y}}/{{MM}}/{{dd}}/{{filename}}', v), '/2024/03/09/Beach Day.JPG');
  assert.equal(renderTemplate('{{yy}}{{MMM}}/{{HH}}{{mm}}{{ss}}-{{filenameNoExt}}.{{ext}}', v), '/24Mar/070503-Beach Day.jpg');
  assert.equal(renderTemplate('{{owner}}/{{assetId}}.{{ext}}', v), '/ana/7.jpg');
  assert.equal(renderTemplate('{{ y }}/{{filename}}', v), '/2024/Beach Day.JPG');
});

test('a bad template is refused when configured: unknown token, absolute, traversal, no file name, stray brace', () => {
  for (const [t, m] of [
    ['{{y}}/{{nope}}/{{filename}}', /unknown template token/],
    ['/abs/{{filename}}', /relative/],
    ['C:/x/{{filename}}', /relative/],
    ['../{{filename}}', /step up/],
    ['a/./{{filename}}', /step up/],
    ['{{y}}/photo', /must name the file/],
    ['{{y}}/{{filename}}{{', /unclosed/],
    ['', /empty/],
    ['{{filenameNoExt}}', /extension/],
  ] as const) assert.throws(() => checkTemplate(t), m, t);
  assert.throws(() => make({ template: '../x/{{filename}}' }), /step up/);
});

test('values with slashes or dots cannot make the path leave its folder', () => {
  const v = { takenAt: at('2024-01-01T00:00:00Z'), filename: '../../etc/passwd', album: '..' };
  assert.equal(renderTemplate('{{album}}/{{filename}}', v), '/__/.._.._etc_passwd');
  assert.equal(cleanStep('a/b\\c'), 'a_b_c');
  assert.equal(cleanStep('..'), '__');
  assert.ok(!renderTemplate('{{filename}}', v).slice(1).includes('/'));
  assert.throws(() => renderTemplate('{{y}}/{{filename}}', { takenAt: NaN, filename: 'a.jpg' }), /not a date/);
  assert.equal(withSuffix('/2024/a.b.jpg', 2), '/2024/a.b+2.jpg');
  assert.equal(withSuffix('/2024/noext', 1), '/2024/noext+1');
});

// ------------------------------------------------------------ assets

test('an upload is filed by the template in the owner tree, and the same bytes twice add nothing', async () => {
  const { lib, tree, add } = make();
  const { asset, duplicate } = await add('ana', '2024-03-09T10:00:00Z', 'a.jpg', 'x1');
  assert.equal(duplicate, false);
  assert.equal(asset.path, '/2024/2024-03-09/a.jpg');
  const node = await tree.resolve('ana', asset.path);
  assert.equal(node?.size, 100);
  assert.deepEqual(node?.checksums, ['SHA256:x1']);
  const again = await add('ana', '2024-03-10T10:00:00Z', 'renamed.jpg', 'x1');
  assert.deepEqual([again.duplicate, again.asset.id], [true, asset.id]);
  const other = await add('bob', '2024-03-09T10:00:00Z', 'a.jpg', 'x1'); // another owner's copy is theirs
  assert.equal(other.duplicate, false);
  assert.equal(lib.snapshot().assets.length, 2);
});

test('two different pictures with the same name and day do not overwrite each other', async () => {
  const { tree, add } = make();
  const a = await add('ana', '2024-03-09T10:00:00Z', 'IMG_1.jpg', 'c1');
  const b = await add('ana', '2024-03-09T11:00:00Z', 'IMG_1.jpg', 'c2');
  const c = await add('ana', '2024-03-09T12:00:00Z', 'IMG_1.jpg', 'c3');
  assert.deepEqual([a.asset.path, b.asset.path, c.asset.path], ['/2024/2024-03-09/IMG_1.jpg', '/2024/2024-03-09/IMG_1+1.jpg', '/2024/2024-03-09/IMG_1+2.jpg']);
  assert.equal((await tree.list((await tree.resolve('ana', '/2024/2024-03-09'))!)).length, 3);
});

test('input is checked: mime, checksum, size', async () => {
  const { lib } = make();
  const base = { owner: 'ana', filename: 'a.jpg', size: 1, blob: 'b', checksum: 'c', mime: 'image/jpeg' };
  await assert.rejects(lib.add({ ...base, mime: 'application/pdf' }), (e) => code(e) === 'type');
  await assert.rejects(lib.add({ ...base, checksum: '' }), (e) => code(e) === 'input');
  await assert.rejects(lib.add({ ...base, size: -1 }), (e) => code(e) === 'input');
  const v = await lib.add({ ...base, filename: 'm.mp4', mime: 'video/mp4' });
  assert.equal(v.asset.type, 'video');
});

// ------------------------------------------------------------ trash

test('trash hides an asset from the timeline and restoring brings it back; purge removes the file', async () => {
  const { lib, tree, add } = make();
  const { asset } = await add('ana', '2024-03-09T10:00:00Z', 'a.jpg');
  lib.trash('ana', [asset.id]);
  assert.deepEqual(lib.timelineBuckets('ana'), []);
  assert.deepEqual(lib.trashed('ana').map((a) => a.id), [asset.id]);
  assert.deepEqual(lib.timelineBuckets('ana', { trashed: true }), [{ bucket: '2024-03', count: 1 }]);
  assert.throws(() => lib.update('ana', asset.id, { favourite: true }), (e) => code(e) === 'trashed');
  lib.untrash('ana', [asset.id]);
  assert.equal(lib.timelineBuckets('ana').length, 1);
  await assert.rejects(lib.purge('ana', [asset.id]), (e) => code(e) === 'not-trashed');
  lib.trash('ana', [asset.id]);
  assert.equal(await lib.purge('ana', [asset.id]), 1);
  assert.equal(await tree.resolve('ana', asset.path), undefined);
  assert.equal(lib.get(asset.id), undefined);
});

test('the trash empties itself after the retention window and not before', async () => {
  const { lib, add, tick } = make({ trashDays: 30 });
  const a = (await add('ana', '2024-03-09T10:00:00Z')).asset;
  const b = (await add('ana', '2024-03-10T10:00:00Z')).asset;
  lib.trash('ana', [a.id]);
  tick(20 * DAY);
  lib.trash('ana', [b.id]);
  tick(11 * DAY); // a is 31 days in, b 11
  assert.equal(await lib.purgeExpired(), 1);
  assert.deepEqual(lib.trashed('ana').map((x) => x.id), [b.id]);
  assert.equal(await lib.emptyTrash('ana'), 1);
  assert.equal(lib.snapshot().assets.length, 0);
});

test('people can only touch their own assets', async () => {
  const { lib, add } = make();
  const { asset } = await add('ana', '2024-03-09T10:00:00Z');
  assert.throws(() => lib.trash('bob', [asset.id]), (e) => code(e) === 'not-found');
  assert.throws(() => lib.update('bob', asset.id, { favourite: true }), (e) => code(e) === 'not-found');
  assert.throws(() => lib.createAlbum('bob', 'mine', [asset.id]), (e) => code(e) === 'not-found');
});

// ------------------------------------------------------------ stacks

test('a stack shows only its primary in the timeline, and every member on request', async () => {
  const { lib, add } = make();
  const ids = [] as number[];
  for (let i = 0; i < 3; i++) ids.push((await add('ana', `2024-03-09T10:0${i}:00Z`)).asset.id);
  const s = lib.createStack('ana', ids[1] as number, [ids[0] as number, ids[2] as number]);
  assert.deepEqual(lib.timelineBucket('ana', '2024-03').map((a) => a.id), [ids[1]]);
  assert.equal(lib.timelineBuckets('ana')[0]?.count, 1);
  assert.equal(lib.timelineBucket('ana', '2024-03', { withStacked: true }).length, 3);
  assert.equal(lib.setPrimary('ana', s.id, ids[2] as number).primary, ids[2]);
  assert.deepEqual(lib.timelineBucket('ana', '2024-03').map((a) => a.id), [ids[2]]);
  assert.throws(() => lib.setPrimary('ana', s.id, 999), (e) => code(e) === 'stack');
});

test('stack rules: two at least, one stack per asset, and losing a member to the trash re-picks or dissolves', async () => {
  const { lib, add } = make();
  const [a, b, c] = [(await add('ana', '2024-03-09T10:00:00Z')).asset.id, (await add('ana', '2024-03-09T10:01:00Z')).asset.id, (await add('ana', '2024-03-09T10:02:00Z')).asset.id];
  assert.throws(() => lib.createStack('ana', a, []), (e) => code(e) === 'stack');
  lib.createStack('ana', a, [b, c]);
  assert.throws(() => lib.createStack('ana', a, [b]), /already in a stack/);
  lib.trash('ana', [a]); // the primary leaves: another takes over
  assert.equal(lib.stackOf(b)?.primary, b);
  assert.equal(lib.get(a)?.stackId, undefined);
  lib.removeFromStack('ana', c); // one left: the stack is gone
  assert.equal(lib.stackOf(b), undefined);
  assert.equal(lib.get(b)?.stackId, undefined);
  assert.throws(() => lib.removeFromStack('ana', b), /not in a stack/);
});

// ------------------------------------------------------------ albums and sharing

test('an album holds the owner assets, ignores repeats, and shows them newest first', async () => {
  const { lib, add } = make();
  const a = (await add('ana', '2024-03-01T10:00:00Z')).asset.id;
  const b = (await add('ana', '2024-03-05T10:00:00Z')).asset.id;
  const al = lib.createAlbum('ana', '  Trip  ', [a, a]);
  assert.equal(al.name, 'Trip');
  await lib.addToAlbum('ana', al.id, [b, a]);
  assert.deepEqual((await lib.albumContents('ana', al.id)).map((x) => x.id), [b, a]);
  assert.throws(() => lib.createAlbum('ana', '   '), (e) => code(e) === 'album');
  lib.trash('ana', [b]);
  assert.deepEqual((await lib.albumContents('ana', al.id)).map((x) => x.id), [a]);
  lib.untrash('ana', [b]);
  assert.equal((await lib.albumContents('ana', al.id)).length, 2);
});

test('a viewer can look, an editor can add their own, and a stranger cannot even tell the album exists', async () => {
  const { lib, add } = make();
  const a = (await add('ana', '2024-03-01T10:00:00Z')).asset.id;
  const b = (await add('bob', '2024-03-02T10:00:00Z')).asset.id;
  const al = lib.createAlbum('ana', 'Shared', [a]);
  await lib.share('ana', al.id, 'bob', 'editor');
  await lib.share('ana', al.id, 'vic', 'viewer');
  assert.equal((await lib.albumContents('vic', al.id)).length, 1);
  await assert.rejects(lib.addToAlbum('vic', al.id, [a]), (e) => code(e) === 'forbidden');
  await assert.rejects(lib.albumContents('eve', al.id), (e) => code(e) === 'not-found');
  await lib.addToAlbum('bob', al.id, [b]);
  assert.equal((await lib.albumContents('vic', al.id)).length, 2);
  await assert.rejects(lib.addToAlbum('bob', al.id, [a]), (e) => code(e) === 'not-found'); // not bob's asset
  await assert.rejects(lib.removeFromAlbum('bob', al.id, [a]), (e) => code(e) === 'forbidden'); // editor removes only their own
  assert.equal((await lib.removeFromAlbum('bob', al.id, [b])).assets.length, 1);
  assert.deepEqual((await lib.albumsFor('bob')).map((x) => x.id), [al.id]);
  assert.deepEqual(await lib.albumsFor('eve'), []);
  assert.equal((await lib.removeFromAlbum('ana', al.id, [a])).assets.length, 0);
});

test('a group share reaches its members, and unsharing takes access away', async () => {
  const { lib, add } = make({ groups: { cy: ['family'] } });
  const a = (await add('ana', '2024-03-01T10:00:00Z')).asset.id;
  const al = lib.createAlbum('ana', 'Family', [a]);
  const g = await lib.share('ana', al.id, 'family', 'viewer', 'group');
  assert.equal((await lib.albumContents('cy', al.id)).length, 1);
  await lib.unshare('ana', g.id);
  await assert.rejects(lib.albumContents('cy', al.id), (e) => code(e) === 'not-found');
});

test('a link opens only that album, needs its password, stops at expiry and when the album is deleted', async () => {
  const { lib, add, grants, tick } = make();
  const a = (await add('ana', '2024-03-01T10:00:00Z')).asset.id;
  await add('ana', '2024-03-02T10:00:00Z'); // not in the album
  const al = lib.createAlbum('ana', 'Public', [a]);
  const link = await lib.shareLink('ana', al.id, { password: 'correct horse', expires: at('2024-06-01T00:00:00Z') + DAY });
  const opened = await lib.openLink(link.token as string, 'correct horse');
  assert.deepEqual(opened.assets.map((x) => x.id), [a]);
  await assert.rejects(lib.openLink(link.token as string, 'wrong'));
  tick(2 * DAY);
  await assert.rejects(lib.openLink(link.token as string, 'correct horse'));
  const l2 = await lib.shareLink('ana', al.id);
  assert.equal((await lib.openLink(l2.token as string)).album.name, 'Public');
  await lib.deleteAlbum('ana', al.id);
  await assert.rejects(lib.openLink(l2.token as string));
  assert.equal((await grants.live()).length, 0);
});

test('purging an asset removes it from every album; a trashed asset cannot be added', async () => {
  const { lib, add } = make();
  const a = (await add('ana', '2024-03-01T10:00:00Z')).asset.id;
  const b = (await add('ana', '2024-03-02T10:00:00Z')).asset.id;
  const al = lib.createAlbum('ana', 'X', [a, b]);
  await lib.setCover('ana', al.id, a);
  lib.trash('ana', [a]);
  await assert.rejects(lib.addToAlbum('ana', al.id, [a]), (e) => code(e) === 'trashed');
  await lib.purge('ana', [a]);
  const now = lib.album(al.id);
  assert.deepEqual(now?.assets, [b]);
  assert.equal(now?.cover, undefined);
  await assert.rejects(lib.setCover('ana', al.id, a), (e) => code(e) === 'album');
});

// ------------------------------------------------------------ timeline

test('buckets count per month or day newest first, honour the viewer offset, and skip archived assets', async () => {
  const { lib, add } = make();
  await add('ana', '2024-03-31T23:30:00Z');
  await add('ana', '2024-03-01T10:00:00Z');
  await add('ana', '2024-02-10T10:00:00Z');
  const arch = (await add('ana', '2024-02-11T10:00:00Z')).asset.id;
  lib.update('ana', arch, { archived: true });
  assert.deepEqual(lib.timelineBuckets('ana'), [{ bucket: '2024-03', count: 2 }, { bucket: '2024-02', count: 1 }]);
  assert.deepEqual(lib.timelineBuckets('ana', { archived: true }), [{ bucket: '2024-02', count: 1 }]);
  assert.deepEqual(lib.timelineBuckets('ana', { offsetMinutes: 120 }), [{ bucket: '2024-04', count: 1 }, { bucket: '2024-03', count: 1 }, { bucket: '2024-02', count: 1 }]);
  assert.deepEqual(lib.timelineBuckets('ana', { granularity: 'day' }).map((b) => b.bucket), ['2024-03-31', '2024-03-01', '2024-02-10']);
  assert.equal(bucketOf(at('2024-12-31T23:59:59Z'), 'day'), '2024-12-31');
  assert.equal(bucketOf(at('2024-12-31T23:59:59Z'), 'month', 1), '2025-01');
});

test('one bucket lists its assets newest first and filters by favourite, type and album; bad bucket names are refused', async () => {
  const { lib, add } = make();
  const a = (await add('ana', '2024-03-09T08:00:00Z')).asset.id;
  const b = (await add('ana', '2024-03-09T20:00:00Z')).asset.id;
  const c = (await add('ana', '2024-03-20T20:00:00Z')).asset.id;
  const v = (await lib.add({ owner: 'ana', filename: 'v.mp4', size: 1, blob: 'v', checksum: 'vv', mime: 'video/mp4', takenAt: at('2024-03-09T09:00:00Z') })).asset.id;
  assert.deepEqual(lib.timelineBucket('ana', '2024-03-09').map((x) => x.id), [b, v, a]);
  assert.deepEqual(lib.timelineBucket('ana', '2024-03').map((x) => x.id), [c, b, v, a]);
  lib.update('ana', a, { favourite: true });
  assert.deepEqual(lib.timelineBucket('ana', '2024-03', { favourite: true }).map((x) => x.id), [a]);
  assert.deepEqual(lib.timelineBucket('ana', '2024-03', { type: 'video' }).map((x) => x.id), [v]);
  const al = lib.createAlbum('ana', 'Al', [c]);
  assert.deepEqual(lib.timelineBucket('ana', '2024-03', { album: al.id }).map((x) => x.id), [c]);
  assert.deepEqual(lib.timelineBucket('bob', '2024-03'), []);
  for (const bad of ['2024', '2024-3', 'March', '2024-03-09T10']) assert.throws(() => lib.timelineBucket('ana', bad), (e) => code(e) === 'bucket');
});
