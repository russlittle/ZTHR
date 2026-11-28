import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAV, parseXml } from '../dav/index.ts';
import type { El } from '../dav/index.ts';
import { Tree, memoryNodes } from '../tree/index.ts';
import { CS, OC, WebdavProps, hrefFor, like, relPath } from './index.ts';
import type { Options } from './index.ts';

const BASE = '/remote.php/dav/files/ana';
const ctx = { owner: 'ana', base: BASE };
const MTIME = 1_700_000_000;

function mk(o: Options = {}) {
  let n = 0;
  const tree = new Tree(memoryNodes(), { now: () => MTIME, etag: () => `e${++n}` });
  const dav = new WebdavProps(tree, o);
  return { tree, dav };
}
const file = async (tree: Tree, path: string, size = 10, extra: { mime?: string; checksums?: string[] } = {}, owner = 'ana') => (await tree.put(owner, path, { size, blob: `blob:${path}`, mtime: MTIME, ...extra })).node;

interface Row { href: string; props: Map<string, string>; status: Map<string, number>; rawStatus: number[] }
function rows(xml: string): Row[] {
  const root = parseXml(xml);
  assert.deepEqual([root.ns, root.name], [DAV, 'multistatus']);
  return root.children.map((r) => {
    const props = new Map<string, string>();
    const status = new Map<string, number>();
    const rawStatus: number[] = [];
    for (const c of r.children) {
      if (c.name === 'status') rawStatus.push(Number(/ (\d{3})/.exec(c.text)![1]));
      if (c.name !== 'propstat') continue;
      const st = Number(/ (\d{3})/.exec(c.children.find((x) => x.name === 'status')!.text)![1]);
      for (const p of c.children.find((x) => x.name === 'prop')!.children) {
        const key = `{${p.ns}}${p.name}`;
        props.set(key, p.children.length ? `<${p.children.map((x) => x.name).join(',')}>` : p.text);
        status.set(key, st);
      }
    }
    return { href: r.children.find((c) => c.name === 'href')!.text, props, status, rawStatus };
  });
}
const d = (name: string) => `{${DAV}}${name}`;
const propBody = (...names: [string, string][]) => `<d:propfind xmlns:d="DAV:"><d:prop>${names.map(([ns, n]) => (ns === DAV ? `<d:${n}/>` : `<x:${n} xmlns:x="${ns}"/>`)).join('')}</d:prop></d:propfind>`;
const patch = (body: string) => `<d:propertyupdate xmlns:d="DAV:" xmlns:p="urn:test">${body}</d:propertyupdate>`;
const setP = (name: string, v: string) => `<d:set><d:prop><p:${name}>${v}</p:${name}></d:prop></d:set>`;
const rmP = (name: string) => `<d:remove><d:prop><p:${name}/></d:prop></d:remove>`;
const P = (name: string) => `{urn:test}${name}`;

test('PROPFIND Depth 0 on a file returns the live properties, quoted etag and HTTP dates; unknown ones are 404', async () => {
  const { tree, dav } = mk();
  const f = await file(tree, '/a.txt', 1234, { mime: 'text/plain' });
  const r = await dav.propfind(ctx, '/a.txt', { depth: '0', body: propBody([DAV, 'getetag'], [DAV, 'getcontentlength'], [DAV, 'getcontenttype'], [DAV, 'getlastmodified'], [DAV, 'resourcetype'], [DAV, 'displayname'], ['urn:x', 'nothing']) });
  assert.equal(r.status, 207);
  assert.match(r.headers['content-type']!, /^application\/xml/);
  const [row] = rows(r.body);
  assert.equal(row!.href, `${BASE}/a.txt`);
  assert.deepEqual([...row!.props].filter(([key]) => key !== '{urn:x}nothing'), [
    [d('getetag'), `"${f.etag}"`],
    [d('getcontentlength'), '1234'],
    [d('getcontenttype'), 'text/plain'],
    [d('getlastmodified'), 'Tue, 14 Nov 2023 22:13:20 GMT'],
    [d('resourcetype'), ''],
    [d('displayname'), 'a.txt'],
  ]);
  assert.equal(row!.status.get('{urn:x}nothing'), 404);
  assert.equal(row!.status.get(d('getetag')), 200);
  const noMime = await file(tree, '/b.bin', 1);
  assert.equal(rows((await dav.propfind(ctx, '/b.bin', { depth: '0', body: propBody([DAV, 'getcontenttype']) })).body)[0]!.props.get(d('getcontenttype')), 'application/octet-stream');
  assert.ok(noMime.id);
});

test('Depth 1 lists the folder and its children with encoded hrefs and a trailing slash on collections', async () => {
  const { tree, dav } = mk();
  await tree.mkdir('ana', '/My Docs');
  await file(tree, '/My Docs/café #1 100%.txt', 5);
  await tree.mkdir('ana', '/My Docs/sub');
  await file(tree, '/My Docs/sub/deep.txt', 5);
  const r = rows((await dav.propfind(ctx, '/My Docs', { depth: '1', body: propBody([DAV, 'resourcetype'], [DAV, 'getcontenttype']) })).body);
  assert.deepEqual(r.map((x) => x.href), [`${BASE}/My%20Docs/`, `${BASE}/My%20Docs/caf%C3%A9%20%231%20100%25.txt`, `${BASE}/My%20Docs/sub/`]);
  assert.deepEqual(r.map((x) => x.props.get(d('resourcetype'))), ['<collection>', '', '<collection>']);
  assert.equal(r[0]!.props.get(d('getcontenttype')), 'httpd/unix-directory');
  const root = rows((await dav.propfind(ctx, '/', { depth: '0', body: propBody([DAV, 'displayname']) })).body)[0]!;
  assert.deepEqual([root.href, root.props.get(d('displayname'))], [`${BASE}/`, 'ana']);
  const missing = await dav.propfind(ctx, '/nope', { depth: '0' });
  assert.equal(missing.status, 404);
  const onFile = rows((await dav.propfind(ctx, '/My Docs/sub/deep.txt', { depth: '1', body: propBody([DAV, 'displayname']) })).body);
  assert.equal(onFile.length, 1, 'Depth 1 on a file is the file alone');
});

test('Depth infinity is refused with propfind-finite-depth unless allowed, and then capped', async () => {
  const { tree, dav } = mk();
  await tree.mkdir('ana', '/d');
  await file(tree, '/d/x', 1);
  for (const depth of ['infinity', undefined, null, 'garbage']) {
    const r = await dav.propfind(ctx, '/', depth === undefined ? {} : { depth });
    assert.equal(r.status, 403, String(depth));
    assert.match(r.body, /<d:error[^>]*><d:propfind-finite-depth\/><\/d:error>/);
  }
  const open = mk({ allowInfinity: true });
  await open.tree.mkdir('ana', '/d');
  await file(open.tree, '/d/x', 1);
  assert.deepEqual(rows((await open.dav.propfind(ctx, '/', { depth: 'infinity' })).body).map((x) => x.href), [`${BASE}/`, `${BASE}/d/`, `${BASE}/d/x`]);
  const capped = mk({ allowInfinity: true, maxResources: 2 });
  await capped.tree.mkdir('ana', '/d');
  await file(capped.tree, '/d/x', 1);
  await file(capped.tree, '/d/y', 1);
  assert.equal((await capped.dav.propfind(ctx, '/', { depth: 'infinity' })).status, 403);
});

test('allprop is the RFC 4918 set plus dead properties; extensions come only when asked; propname lists names', async () => {
  const { tree, dav } = mk({ quota: () => 1000 });
  await tree.mkdir('ana', '/f');
  await file(tree, '/f/a', 300, { checksums: ['SHA1:abc', 'MD5:def'] });
  await dav.proppatch(ctx, '/f', patch(setP('color', 'red')));
  const all = rows((await dav.propfind(ctx, '/f', { depth: '0' })).body)[0]!;
  assert.deepEqual([...all.props.keys()].sort(), [d('displayname'), d('getcontenttype'), d('getetag'), d('getlastmodified'), d('resourcetype'), P('color')].sort());
  const ext = rows((await dav.propfind(ctx, '/f', { depth: '0', body: propBody([DAV, 'quota-used-bytes'], [DAV, 'quota-available-bytes'], [CS, 'getctag'], [OC, 'size'], [OC, 'fileid']) })).body)[0]!;
  assert.deepEqual([ext.props.get(d('quota-used-bytes')), ext.props.get(d('quota-available-bytes')), ext.props.get(`{${OC}}size`)], ['300', '700', '300']);
  const node = (await tree.resolve('ana', '/f'))!;
  assert.deepEqual([ext.props.get(`{${CS}}getctag`), ext.props.get(`{${OC}}fileid`)], [node.etag, String(node.id)]);
  const fileExt = rows((await dav.propfind(ctx, '/f/a', { depth: '0', body: propBody([OC, 'checksums'], [CS, 'getctag'], [DAV, 'quota-used-bytes']) })).body)[0]!;
  assert.equal(fileExt.props.get(`{${OC}}checksums`), '<checksum>');
  assert.deepEqual([fileExt.status.get(`{${CS}}getctag`), fileExt.status.get(d('quota-used-bytes'))], [404, 404], 'files have no ctag or quota');
  const names = rows((await dav.propfind(ctx, '/f', { depth: '0', body: '<d:propfind xmlns:d="DAV:"><d:propname/></d:propfind>' })).body)[0]!;
  assert.ok(names.props.has(P('color')) && names.props.has(d('getetag')) && names.props.has(`{${CS}}getctag`));
  assert.equal(names.props.get(d('getetag')), '', 'propname returns empty elements');
  const unlimited = mk();
  await unlimited.tree.mkdir('ana', '/f');
  const u = rows((await unlimited.dav.propfind(ctx, '/f', { depth: '0', body: propBody([DAV, 'quota-available-bytes'], [DAV, 'quota-used-bytes']) })).body)[0]!;
  assert.deepEqual([u.status.get(d('quota-available-bytes')), u.status.get(d('quota-used-bytes'))], [404, 200], 'no limit, no available figure');
});

test('etag and ctag: a change anywhere below changes every ancestor, not siblings; changing properties changes neither', async () => {
  const { tree, dav } = mk();
  await tree.mkdir('ana', '/a');
  await tree.mkdir('ana', '/a/b');
  await tree.mkdir('ana', '/sibling');
  await file(tree, '/a/b/f', 1);
  const tag = async (path: string) => rows((await dav.propfind(ctx, path, { depth: '0', body: propBody([CS, 'getctag'], [DAV, 'getetag']) })).body)[0]!.props;
  const before = { root: await tag('/'), a: await tag('/a'), b: await tag('/a/b'), s: await tag('/sibling'), f: await tag('/a/b/f') };
  for (const x of Object.values(before)) if (x.get(`{${CS}}getctag`)) assert.equal(`"${x.get(`{${CS}}getctag`)}"`, x.get(d('getetag')), 'ctag is the folder etag');
  await dav.proppatch(ctx, '/a/b/f', patch(setP('tag', 'x')));
  assert.deepEqual(await tag('/a/b/f'), before.f);
  assert.deepEqual(await tag('/'), before.root, 'properties are not content');
  await file(tree, '/a/b/f', 2);
  const after = { root: await tag('/'), a: await tag('/a'), b: await tag('/a/b'), s: await tag('/sibling'), f: await tag('/a/b/f') };
  for (const key of ['root', 'a', 'b', 'f'] as const) assert.notEqual(after[key].get(d('getetag')), before[key].get(d('getetag')), key);
  assert.deepEqual(after.s, before.s, 'the sibling folder is untouched');
});

test('PROPPATCH sets and removes dead properties in document order; removing a missing one is fine', async () => {
  const { tree, dav } = mk();
  await file(tree, '/f', 1);
  const get = async () => rows((await dav.propfind(ctx, '/f', { depth: '0' })).body)[0]!.props;
  const r = await dav.proppatch(ctx, '/f', patch(setP('one', 'a &amp; b') + setP('two', 'x') + rmP('never-existed')));
  assert.equal(r.status, 207);
  assert.deepEqual(rows(r.body)[0]!.rawStatus, []);
  assert.deepEqual([...rows(r.body)[0]!.status.values()], [200, 200, 200]);
  assert.equal((await get()).get(P('one')), 'a & b');
  await dav.proppatch(ctx, '/f', patch(rmP('one') + setP('one', 'again')));
  assert.equal((await get()).get(P('one')), 'again', 'remove then set leaves it set');
  await dav.proppatch(ctx, '/f', patch(setP('two', 'y') + rmP('two')));
  assert.equal((await get()).has(P('two')), false, 'set then remove leaves it removed');
  assert.equal((await tree.resolve('ana', '/f'))!.props![P('one')], 'again');
  const other = '<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><q:p xmlns:q="urn:other">o</q:p></d:prop></d:set></d:propertyupdate>';
  await dav.proppatch(ctx, '/f', other);
  assert.deepEqual([(await get()).get('{urn:other}p'), (await get()).get(P('one'))], ['o', 'again'], 'the same local name in two namespaces is two properties');
});

test('PROPPATCH is all or nothing: any failure applies nothing and the rest report 424', async () => {
  const { tree, dav } = mk({ maxPropValue: 10 });
  await file(tree, '/f', 1);
  await dav.proppatch(ctx, '/f', patch(setP('keep', 'v')));
  const before = (await tree.resolve('ana', '/f'))!.props;
  const status = async (xml: string) => rows((await dav.proppatch(ctx, '/f', xml)).body)[0]!.status;
  const protectedSet = '<d:set><d:prop><d:getetag>"x"</d:getetag></d:prop></d:set>';
  let s = await status(patch(setP('a', 'v') + protectedSet + rmP('keep')));
  assert.deepEqual([s.get(P('a')), s.get(d('getetag')), s.get(P('keep'))], [424, 403, 424]);
  assert.deepEqual((await tree.resolve('ana', '/f'))!.props, before, 'nothing was applied');
  s = await status(patch(setP('a', '<child/>') + setP('b', 'v')));
  assert.deepEqual([s.get(P('a')), s.get(P('b'))], [409, 424], 'a value with markup is refused, not flattened');
  s = await status(patch(setP('a', 'x'.repeat(11))));
  assert.equal(s.get(P('a')), 409);
  s = await status('<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><bare xmlns="">v</bare></d:prop></d:set></d:propertyupdate>');
  assert.equal(s.get('{}bare'), 409, 'a property in no namespace is refused');
  s = await status('<d:propertyupdate xmlns:d="DAV:"><d:remove><d:prop><d:displayname/></d:prop></d:remove></d:propertyupdate>');
  assert.equal(s.get(d('displayname')), 403);
  s = await status('<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:never-heard-of>v</d:never-heard-of></d:prop></d:set></d:propertyupdate>');
  assert.equal(s.get(d('never-heard-of')), 403, 'anything in DAV: is reserved');
  s = await status(patch(setP('quota-used-bytes', '1')));
  assert.equal(s.get(P('quota-used-bytes')), 200, 'the same name in another namespace is an ordinary dead property');
  const limited = mk({ maxDeadProps: 2 });
  await file(limited.tree, '/f', 1);
  await limited.dav.proppatch(ctx, '/f', patch(setP('a', '1') + setP('b', '2')));
  const over = rows((await limited.dav.proppatch(ctx, '/f', patch(setP('c', '3')))).body)[0]!.status;
  assert.equal(over.get(P('c')), 409);
  assert.equal(rows((await limited.dav.proppatch(ctx, '/f', patch(rmP('a') + setP('c', '3')))).body)[0]!.status.get(P('c')), 200, 'the count is of the result, not of the steps');
});

test('PROPPATCH refuses what it cannot read: bad XML, DTDs, wrong roots, empty updates, missing resources', async () => {
  const { tree, dav } = mk();
  await file(tree, '/f', 1);
  for (const [body, why] of [['<d:propertyupdate xmlns:d="DAV:">', 'unclosed'], ['<d:propfind xmlns:d="DAV:"/>', 'wrong root'], ['<propertyupdate/>', 'no namespace'], ['<!DOCTYPE x [<!ENTITY e "v">]><d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><p:a xmlns:p="urn:t">&e;</p:a></d:prop></d:set></d:propertyupdate>', 'entity'], ['<d:propertyupdate xmlns:d="DAV:"/>', 'empty'], ['', 'blank']] as const)
    assert.equal((await dav.proppatch(ctx, '/f', body)).status, 400, why);
  assert.equal((await dav.proppatch(ctx, '/nope', patch(setP('a', '1')))).status, 404);
  assert.equal((await dav.propfind(ctx, '/f', { depth: '0', body: '<d:propfind xmlns:d="DAV:"><d:prop>' })).status, 400);
  assert.equal((await dav.propfind(ctx, '/f', { depth: '0', body: '<!DOCTYPE x [<!ENTITY e "v">]><d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>' })).status, 400);
  assert.equal((await dav.propfind(ctx, '/../etc', { depth: '0' })).status, 400, 'path steps are refused');
});

test('dead properties move with a MOVE (same node) and are copied by a COPY (new node)', async () => {
  const { tree, dav } = mk();
  const f = await file(tree, '/src.txt', 7);
  await dav.proppatch(ctx, '/src.txt', patch(setP('fav', 'yes')));
  const c = await dav.copy(ctx, '/src.txt', { destination: `${BASE}/copy.txt` });
  assert.deepEqual([c.status, c.body], [201, '']);
  const copy = (await tree.resolve('ana', '/copy.txt'))!;
  assert.notEqual(copy.id, f.id);
  assert.equal(copy.props![P('fav')], 'yes');
  assert.notEqual(copy.etag, f.etag, 'a copy is new content with its own etag');
  const m = await dav.move(ctx, '/src.txt', { destination: `${BASE}/moved.txt` });
  assert.equal(m.status, 201);
  const moved = (await tree.resolve('ana', '/moved.txt'))!;
  assert.deepEqual([moved.id, moved.props![P('fav')]], [f.id, 'yes']);
  assert.equal(await tree.resolve('ana', '/src.txt'), undefined);
});

test('COPY and MOVE status codes: created, replaced, Overwrite F, missing parent, same place, inside itself, bad Destination', async () => {
  const { tree, dav } = mk();
  await tree.mkdir('ana', '/a');
  await tree.mkdir('ana', '/a/b');
  await file(tree, '/a/b/f', 5);
  await file(tree, '/x', 3);
  await file(tree, '/y', 4);
  const to = (p: string) => ({ destination: `${BASE}${p}` });
  assert.equal((await dav.copy(ctx, '/x', to('/z'))).status, 201);
  assert.equal((await dav.copy(ctx, '/x', to('/y'))).status, 204, 'replacing is 204');
  assert.equal((await tree.resolve('ana', '/y'))!.size, 3);
  assert.equal((await dav.copy(ctx, '/x', { ...to('/z'), overwrite: 'F' })).status, 412);
  assert.equal((await dav.move(ctx, '/x', { ...to('/z'), overwrite: 'F' })).status, 412);
  assert.equal((await tree.resolve('ana', '/x'))!.size, 3, 'a refused move changed nothing');
  assert.equal((await dav.copy(ctx, '/x', to('/no/parent'))).status, 409);
  assert.equal((await dav.move(ctx, '/x', to('/x'))).status, 403);
  assert.equal((await dav.copy(ctx, '/a', to('/a/b/inner'))).status, 403, 'a folder into itself');
  assert.equal((await dav.move(ctx, '/a', to('/a/b'))).status, 403);
  assert.equal((await dav.move(ctx, '/a/b', to('/a'))).status, 403, 'onto its own parent would delete the source');
  assert.equal((await tree.resolve('ana', '/a/b/f'))!.size, 5);
  assert.equal((await dav.copy(ctx, '/nope', to('/q'))).status, 404);
  assert.equal((await dav.copy(ctx, '/x', {})).status, 400);
  assert.equal((await dav.copy(ctx, '/x', { destination: '/elsewhere/q' })).status, 400, 'outside this tree');
  assert.equal((await dav.copy(ctx, '/x', { destination: `${BASE}2/q` })).status, 400, 'a path that only starts the same');
  assert.equal((await dav.copy(ctx, '/x', { destination: 'ftp://h/q' })).status, 400);
  assert.equal((await dav.copy(ctx, '/x', { destination: `https://other.host${BASE}/viahost`, host: 'cloud.example' })).status, 201, 'only the path counts');
  assert.equal((await dav.move(ctx, '/', to('/rootcopy'))).status, 403);
  assert.equal((await dav.copy(ctx, '/x', to('/'))).status, 403);
  assert.equal((await dav.copy(ctx, '/x', { destination: `${BASE}/../bo/x` })).status, 400, 'climbing out of the base');
  assert.equal((await dav.copy(ctx, '/x', { destination: `${BASE}/a/%2e%2e/esc` })).status, 201, 'dot steps are resolved first, and the result is checked');
  assert.ok(await tree.resolve('ana', '/esc'));
  const bigMove = await dav.move(ctx, '/a', to('/renamed'));
  assert.equal(bigMove.status, 201);
  assert.equal((await tree.resolve('ana', '/renamed/b/f'))!.size, 5);
});

test('Depth rules for COPY and MOVE: Depth 0 copies a collection without members; MOVE needs infinity', async () => {
  const { tree, dav } = mk();
  await tree.mkdir('ana', '/dir');
  await file(tree, '/dir/inside', 5);
  await dav.proppatch(ctx, '/dir', patch(setP('label', 'L')));
  const to = (p: string) => ({ destination: `${BASE}${p}` });
  assert.equal((await dav.copy(ctx, '/dir', { ...to('/shallow'), depth: '0' })).status, 201);
  assert.deepEqual((await tree.list((await tree.resolve('ana', '/shallow'))!)).map((n) => n.name), []);
  assert.equal((await tree.resolve('ana', '/shallow'))!.props![P('label')], 'L');
  assert.equal((await dav.copy(ctx, '/dir', to('/deep'))).status, 201);
  assert.deepEqual((await tree.list((await tree.resolve('ana', '/deep'))!)).map((n) => n.name), ['inside']);
  await tree.mkdir('ana', '/target');
  await file(tree, '/target/old', 1);
  assert.equal((await dav.copy(ctx, '/dir', { ...to('/target'), depth: '0' })).status, 204);
  assert.deepEqual((await tree.list((await tree.resolve('ana', '/target'))!)).map((n) => n.name), [], 'a Depth 0 overwrite replaces the old members too');
  assert.equal((await dav.copy(ctx, '/dir', { ...to('/one'), depth: '1' })).status, 400);
  assert.equal((await dav.move(ctx, '/dir', { ...to('/mv'), depth: '0' })).status, 400);
  assert.equal((await dav.move(ctx, '/dir', { ...to('/mv'), depth: '1' })).status, 400);
  assert.equal((await dav.move(ctx, '/dir', { ...to('/mv'), depth: 'infinity' })).status, 201);
});

test('quota: a COPY that would pass the limit is 507; replacing counts only the difference; folder sizes are used', async () => {
  const { tree, dav } = mk({ quota: () => 100 });
  await file(tree, '/big', 60);
  await file(tree, '/small', 10);
  await tree.mkdir('ana', '/dir');
  await file(tree, '/dir/a', 20);
  const to = (p: string) => ({ destination: `${BASE}${p}` });
  const over = await dav.copy(ctx, '/big', to('/big2'));
  assert.deepEqual([over.status, /quota-not-exceeded/.test(over.body)], [507, true]);
  assert.equal(await tree.resolve('ana', '/big2'), undefined);
  assert.equal((await dav.copy(ctx, '/small', to('/small2'))).status, 201);
  assert.equal((await dav.copy(ctx, '/small', to('/big'))).status, 204, 'replacing 60 bytes by 10 frees room');
  assert.equal((await dav.copy(ctx, '/dir', to('/dir2'))).status, 201);
  assert.equal((await dav.copy(ctx, '/dir', to('/dir3'))).status, 201, 'exactly up to the limit is allowed');
  assert.equal((await dav.copy(ctx, '/dir', to('/dir4'))).status, 507);
  assert.equal((await dav.copy(ctx, '/dir', { ...to('/dir4'), depth: '0' })).status, 201, 'an empty copy needs no room');
  assert.equal((await dav.move(ctx, '/dir', to('/dirm'))).status, 201, 'a move needs none');
  assert.deepEqual(await dav.quotaOf('ana'), { used: 90, available: 10 });
});

test('SEARCH: comparisons, like, and/or/not, scope, select, ordering, limits', async () => {
  const { tree, dav } = mk();
  await tree.mkdir('ana', '/docs');
  await tree.mkdir('ana', '/docs/sub');
  await file(tree, '/docs/report.pdf', 5000, { mime: 'application/pdf' });
  await file(tree, '/docs/notes.txt', 100, { mime: 'text/plain' });
  await file(tree, '/docs/sub/deep.txt', 300, { mime: 'text/plain' });
  await file(tree, '/top.txt', 50, { mime: 'text/plain' });
  await tree.touch('ana', '/docs/notes.txt', MTIME + 86400);
  const q = (where: string, o: { scope?: string; depth?: string; select?: string; order?: string; limit?: string } = {}) =>
    `<d:searchrequest xmlns:d="DAV:"><d:basicsearch><d:select>${o.select ?? '<d:prop><d:displayname/><d:getcontentlength/></d:prop>'}</d:select><d:from><d:scope><d:href>${BASE}${o.scope ?? '/'}</d:href><d:depth>${o.depth ?? 'infinity'}</d:depth></d:scope></d:from>${where ? `<d:where>${where}</d:where>` : ''}${o.order ? `<d:orderby>${o.order}</d:orderby>` : ''}${o.limit ? `<d:limit><d:nresults>${o.limit}</d:nresults></d:limit>` : ''}</d:basicsearch></d:searchrequest>`;
  const names = async (xml: string) => {
    const r = await dav.search(ctx, xml);
    assert.equal(r.status, 207, r.body);
    return rows(r.body).filter((x) => x.rawStatus.length === 0).map((x) => x.href.slice(BASE.length));
  };
  const prop = (n: string) => `<d:prop><d:${n}/></d:prop>`;
  assert.deepEqual(await names(q('')), ['/docs/', '/docs/notes.txt', '/docs/report.pdf', '/docs/sub/', '/docs/sub/deep.txt', '/top.txt'].sort(), 'no where: everything, in path order... sorted');
  assert.deepEqual(await names(q(`<d:like>${prop('displayname')}<d:literal>%.txt</d:literal></d:like>`)), ['/docs/notes.txt', '/docs/sub/deep.txt', '/top.txt']);
  assert.deepEqual(await names(q(`<d:gt>${prop('getcontentlength')}<d:literal>99</d:literal></d:gt>`)), ['/docs/notes.txt', '/docs/report.pdf', '/docs/sub/deep.txt']);
  assert.deepEqual(await names(q(`<d:and><d:eq>${prop('getcontenttype')}<d:literal>text/plain</d:literal></d:eq><d:lte>${prop('getcontentlength')}<d:literal>100</d:literal></d:lte></d:and>`)), ['/docs/notes.txt', '/top.txt']);
  assert.deepEqual(await names(q(`<d:or><d:eq>${prop('displayname')}<d:literal>top.txt</d:literal></d:eq><d:is-collection/></d:or>`)), ['/docs/', '/docs/sub/', '/top.txt']);
  assert.deepEqual(await names(q(`<d:not><d:or><d:is-collection/><d:like>${prop('displayname')}<d:literal>%.txt</d:literal></d:like></d:or></d:not>`)), ['/docs/report.pdf']);
  assert.deepEqual(await names(q(`<d:gt>${prop('getlastmodified')}<d:literal>${new Date((MTIME + 3600) * 1000).toISOString()}</d:literal></d:gt>`)), ['/docs/notes.txt']);
  assert.deepEqual(await names(q(`<d:eq caseless="yes">${prop('displayname')}<d:literal>TOP.TXT</d:literal></d:eq>`)), ['/top.txt']);
  assert.deepEqual(await names(q(`<d:eq>${prop('displayname')}<d:literal>TOP.TXT</d:literal></d:eq>`)), [], 'case matters unless asked');
  assert.deepEqual(await names(q(`<d:is-defined>${prop('getcontentlength')}</d:is-defined>`)), ['/docs/notes.txt', '/docs/report.pdf', '/docs/sub/deep.txt', '/top.txt'], 'folders have no length');
  assert.deepEqual(await names(q('', { scope: '/docs', depth: '1' })), ['/docs/notes.txt', '/docs/report.pdf', '/docs/sub/']);
  assert.deepEqual(await names(q('', { scope: '/docs', depth: '0' })), []);
  assert.deepEqual(await names(q(`<d:like>${prop('displayname')}<d:literal>%.txt</d:literal></d:like>`, { scope: '/docs' })), ['/docs/notes.txt', '/docs/sub/deep.txt']);
  const ordered = rows((await dav.search(ctx, q(`<d:like>${prop('displayname')}<d:literal>%.%</d:literal></d:like>`, { order: `<d:order>${prop('getcontentlength')}<d:descending/></d:order>` }))).body).map((x) => x.href.slice(BASE.length));
  assert.deepEqual(ordered, ['/docs/report.pdf', '/docs/sub/deep.txt', '/docs/notes.txt', '/top.txt']);
  const sel = rows((await dav.search(ctx, q(`<d:eq>${prop('displayname')}<d:literal>top.txt</d:literal></d:eq>`, { select: '<d:prop><d:getcontentlength/><d:getetag/></d:prop>' }))).body)[0]!;
  assert.deepEqual([...sel.props.keys()], [d('getcontentlength'), d('getetag')]);
  const lim = rows((await dav.search(ctx, q('', { limit: '2' }))).body);
  assert.equal(lim.length, 3, 'two hits and a truncation marker');
  assert.deepEqual([lim[2]!.rawStatus, lim[2]!.href], [[507], `${BASE}/`]);
  assert.equal(rows((await dav.search(ctx, q('', { limit: '0' }))).body).length, 1);
});

test('SEARCH refuses what it should: unknown operators and properties, bad literals, deep nesting, outside scopes, entities', async () => {
  const { tree, dav } = mk();
  await file(tree, '/a', 1);
  const base = (inner: string, scope = `${BASE}/`) => `<d:searchrequest xmlns:d="DAV:"><d:basicsearch><d:select><d:prop><d:displayname/></d:prop></d:select><d:from><d:scope><d:href>${scope}</d:href><d:depth>infinity</d:depth></d:scope></d:from><d:where>${inner}</d:where></d:basicsearch></d:searchrequest>`;
  const p = (n: string) => `<d:prop><d:${n}/></d:prop>`;
  const bad = async (xml: string, status = 400) => assert.equal((await dav.search(ctx, xml)).status, status, xml.slice(0, 160));
  await bad(base(`<d:regex>${p('displayname')}<d:literal>.*</d:literal></d:regex>`));
  await bad(base(`<d:eq>${p('getetag')}<d:literal>x</d:literal></d:eq>`));
  await bad(base(`<d:eq><p:x xmlns:p="urn:t"/><d:literal>x</d:literal></d:eq>`));
  await bad(base(`<d:gt>${p('getcontentlength')}<d:literal>many</d:literal></d:gt>`));
  await bad(base(`<d:gt>${p('getcontentlength')}<d:literal></d:literal></d:gt>`));
  await bad(base(`<d:gt>${p('getlastmodified')}<d:literal>yesterday-ish</d:literal></d:gt>`));
  await bad(base(`<d:like>${p('getcontentlength')}<d:literal>1%</d:literal></d:like>`));
  await bad(base(`<d:eq>${p('displayname')}<d:literal>${'x'.repeat(257)}</d:literal></d:eq>`));
  await bad(base('<d:and/>'));
  await bad(base('<d:not><d:is-collection/><d:is-collection/></d:not>'));
  await bad(base('<d:is-collection/><d:is-collection/>'));
  let nested = '<d:is-collection/>';
  for (let i = 0; i < 20; i++) nested = `<d:not>${nested}</d:not>`;
  await bad(base(nested));
  let ok = '<d:is-collection/>';
  for (let i = 0; i < 8; i++) ok = `<d:not>${ok}</d:not>`;
  assert.equal((await dav.search(ctx, base(ok))).status, 207);
  await bad(base('<d:is-collection/>', '/somewhere/else'));
  await bad(base('<d:is-collection/>', `${BASE}/missing/`), 404);
  await bad(base('<d:is-collection/>').replace('<d:depth>infinity', '<d:depth>7'));
  await bad(base('<d:is-collection/>').replace('<d:basicsearch>', '<d:basicsearch><d:orderby><d:order><d:prop><d:getetag/></d:prop></d:order></d:orderby>'));
  await bad(base('<d:is-collection/>').replace('</d:basicsearch>', '<d:limit><d:nresults>-1</d:nresults></d:limit></d:basicsearch>'));
  await bad('<d:searchrequest xmlns:d="DAV:"><d:sql/></d:searchrequest>');
  await bad('<d:propfind xmlns:d="DAV:"/>');
  await bad('<!DOCTYPE x [<!ENTITY e "v">]>' + base('<d:is-collection/>'));
  await bad('<d:searchrequest');
  const tiny = mk({ maxResources: 3 });
  for (const n of ['a', 'b', 'c', 'd']) await file(tiny.tree, `/${n}`, 1);
  assert.equal((await tiny.dav.search(ctx, base('<d:is-collection/>'))).status, 507);
});

test('like(): wildcards, escapes, Unicode, and no blow-up on hostile patterns', () => {
  const cases: [string, string, boolean][] = [
    ['report.pdf', '%.pdf', true], ['report.pdf', 'report%', true], ['report.pdf', '%ort.p%', true], ['report.pdf', 'rep_rt.pdf', true], ['report.pdf', 'rep_rt.pd', false],
    ['', '', true], ['', '%', true], ['', '_', false], ['a', '', false], ['abc', '%%%', true], ['abc', 'a%c', true], ['ac', 'a%c', true], ['abc', 'a%b', false],
    ['100%', '100\\%', true], ['100x', '100\\%', false], ['a_b', 'a\\_b', true], ['axb', 'a\\_b', false], ['a\\b', 'a\\\\b', true],
    ['café', 'caf_', true], ['\u{1f600}', '_', true], ['\u{1f600}\u{1f600}', '_', false], ['ABC', 'abc', false],
  ];
  for (const [text, pat, want] of cases) assert.equal(like(text, pat), want, `${JSON.stringify(text)} like ${JSON.stringify(pat)}`);
  const long = 'a'.repeat(20_000);
  const t0 = Date.now();
  assert.equal(like(long, '%a%a%a%a%a%a%a%a%a%a%a%a%b'), false);
  assert.equal(like(long, '_'.repeat(19_999)), false);
  assert.equal(like(long, '%' + 'a%'.repeat(100) + 'b'), false);
  assert.ok(Date.now() - t0 < 2000, 'pattern matching is not exponential');
});

test('hrefs and request paths: encoding round trips, and paths outside the base or with dot steps are refused', () => {
  for (const p of ['/a', '/a b/c', '/café/日本', '/100% #?&=+', '/emoji-\u{1f600}']) {
    const href = hrefFor(BASE, p, false);
    assert.equal(relPath(href, BASE), p, p);
    assert.doesNotMatch(href.slice(BASE.length), /[ #?%](?![0-9A-F]{2})/);
  }
  assert.equal(hrefFor(BASE, '/', true), `${BASE}/`);
  assert.equal(hrefFor(`${BASE}/`, '/f', true), `${BASE}/f/`);
  assert.equal(relPath(BASE, BASE), '/');
  assert.equal(relPath('/other/x', BASE), undefined);
  assert.equal(relPath(`${BASE}x/y`, BASE), undefined);
  assert.equal(relPath(`${BASE}/%ZZ`, BASE), undefined);
  assert.throws(() => hrefFor(BASE, '/a/../b', false));
});

test('owners are separate: one owner\'s search, listing and copy never reach another\'s files', async () => {
  const { tree, dav } = mk();
  await file(tree, '/mine.txt', 1);
  await file(tree, '/theirs.txt', 2, {}, 'bo');
  const bo = { owner: 'bo', base: '/remote.php/dav/files/bo' };
  assert.deepEqual(rows((await dav.propfind(bo, '/', { depth: '1', body: propBody([DAV, 'displayname']) })).body).map((r) => r.props.get(d('displayname'))), ['bo', 'theirs.txt']);
  assert.equal((await dav.propfind(bo, '/mine.txt', { depth: '0' })).status, 404);
  const sr = await dav.search(bo, `<d:searchrequest xmlns:d="DAV:"><d:basicsearch><d:select><d:prop><d:displayname/></d:prop></d:select><d:from><d:scope><d:href>${bo.base}/</d:href><d:depth>infinity</d:depth></d:scope></d:from></d:basicsearch></d:searchrequest>`);
  assert.deepEqual(rows(sr.body).map((r) => r.props.get(d('displayname'))), ['theirs.txt']);
  assert.equal((await dav.copy(bo, '/mine.txt', { destination: `${bo.base}/stolen.txt` })).status, 404);
  const ana = `<d:searchrequest xmlns:d="DAV:"><d:basicsearch><d:select><d:prop><d:displayname/></d:prop></d:select><d:from><d:scope><d:href>${BASE}/</d:href><d:depth>infinity</d:depth></d:scope></d:from></d:basicsearch></d:searchrequest>`;
  assert.equal((await dav.search(bo, ana)).status, 400, 'a scope in someone else\'s tree is outside yours');
});

test('El type is exported by dav for callers who read request bodies', () => {
  const e: El = parseXml('<a xmlns="urn:x"><b/></a>');
  assert.equal(e.children[0]!.name, 'b');
});
