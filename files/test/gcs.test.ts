import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { readAll } from '../../intent/blocks/objects/index.ts';
import { gcsObjects, gcsPersist } from '../src/gcs.ts';
import { PASS, start } from './helpers.ts';

/** A stand-in for Cloud Storage's JSON API: media upload, download with ranges, metadata, delete, compose, generations. */
async function fakeGcs() {
  const objects = new Map<string, { data: Buffer; generation: number }>();
  let gen = 0;
  const calls: string[] = [];
  const s = createServer(async (req, res) => {
    const u = new URL(req.url!, 'http://x');
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const body = Buffer.concat(parts);
    calls.push(`${req.method} ${u.pathname.split('/o/')[1] ? 'object' : u.pathname.includes('/upload/') ? 'upload' : u.pathname}`);
    if (req.headers.authorization !== 'Bearer t0ken') return void res.writeHead(401).end();
    const up = /^\/upload\/storage\/v1\/b\/([^/]+)\/o$/.exec(u.pathname);
    if (up && req.method === 'POST') {
      const name = u.searchParams.get('name')!;
      const want = u.searchParams.get('ifGenerationMatch');
      const have = objects.get(name)?.generation ?? 0;
      if (want !== null && Number(want) !== have) return void res.writeHead(412).end();
      objects.set(name, { data: body, generation: ++gen });
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ name, size: String(body.length), generation: String(gen) }));
    }
    if (/^\/storage\/v1\/b\/[^/]+\/o$/.test(u.pathname) && req.method === 'GET') {
      const prefix = u.searchParams.get('prefix') ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ items: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }));
    }
    const m = /^\/storage\/v1\/b\/([^/]+)\/o\/([^/]+)(\/compose)?$/.exec(u.pathname);
    if (!m) return void res.writeHead(404).end();
    const name = decodeURIComponent(m[2]!);
    if (m[3]) {
      const src = (JSON.parse(body.toString()) as { sourceObjects: { name: string }[] }).sourceObjects;
      if (src.length > 32) return void res.writeHead(400).end();
      const bufs = src.map((x) => objects.get(x.name)?.data);
      if (bufs.some((b) => !b)) return void res.writeHead(404).end();
      const data = Buffer.concat(bufs as Buffer[]);
      objects.set(name, { data, generation: ++gen });
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ name, size: String(data.length) }));
    }
    const o = objects.get(name);
    if (req.method === 'DELETE') {
      if (!o) return void res.writeHead(404).end();
      objects.delete(name);
      return void res.writeHead(204).end();
    }
    if (!o) return void res.writeHead(404).end();
    if (u.searchParams.get('alt') === 'media') {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
      const data = r ? o.data.subarray(Number(r[1]), Number(r[2]) + 1) : o.data;
      res.writeHead(r ? 206 : 200, { 'x-goog-generation': String(o.generation) });
      return void res.end(data);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ size: String(o.data.length) }));
  });
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', () => ok()));
  return { api: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, objects, calls, close: () => s.close() };
}

const token = async () => 't0ken';

test('objects in Cloud Storage: write with checksums, read by range, join, delete', async () => {
  const g = await fakeGcs();
  try {
    const s = gcsObjects({ bucket: 'b', api: g.api, token });
    const a = await s.put(new TextEncoder().encode('hello '));
    const b = await s.put(new TextEncoder().encode('world'));
    assert.ok(a.checksums.some((c) => c.startsWith('SHA1:')));
    const c = await s.compose([a.key, b.key]);
    assert.equal(c.size, 11);
    assert.equal((await readAll(await s.get(c.key))).toString(), 'hello world');
    assert.equal((await readAll(await s.get(c.key, { start: 6, end: 10 }))).toString(), 'world');
    assert.equal(await s.size(c.key), 11);
    await s.delete(a.key);
    await s.delete(a.key);
    assert.equal(await s.size(a.key), undefined);
    assert.ok([...g.objects.keys()].every((k) => k.startsWith('objects/')));
  } finally {
    g.close();
  }
});

test('the state log in the bucket: entries replay after the snapshot, and a second writer is refused', async () => {
  const g = await fakeGcs();
  try {
    const one = gcsPersist({ bucket: 'b', api: g.api, token });
    assert.deepEqual(await one.load(), { snapshot: null, log: [] });
    await one.append(1, '{"n":1}');
    await one.append(2, '{"n":2}');
    await assert.rejects(gcsPersist({ bucket: 'b', api: g.api, token }).append(2, '{"n":2,"other":true}'), /another instance/);
    await one.snapshot(1, '{"n":1,"doc":{}}');
    const back = await gcsPersist({ bucket: 'b', api: g.api, token }).load();
    assert.equal(back.snapshot, '{"n":1,"doc":{}}');
    assert.deepEqual(back.log, ['{"n":2}'], 'only entries after the snapshot are replayed, and the older ones are gone');
    assert.equal([...g.objects.keys()].filter((k) => k.startsWith('state/log/')).length, 1);
  } finally {
    g.close();
  }
});

test('Files runs end to end on Cloud Storage: a chunked upload is joined in the bucket', async () => {
  const g = await fakeGcs();
  const objects = gcsObjects({ bucket: 'b', api: g.api, token });
  const persist = gcsPersist({ bucket: 'b', api: g.api, token });
  const s = await start({ objects, persist });
  const ana = s.as('ana', PASS);
  const up = '/remote.php/dav/uploads/ana/u1';
  const dest = { destination: `${s.base}/remote.php/dav/files/ana/big.bin` };
  try {
    await ana(up, { method: 'MKCOL', headers: dest });
    await ana(`${up}/1`, { method: 'PUT', body: Buffer.alloc(5 * 1024 * 1024, 7), headers: dest });
    await ana(`${up}/2`, { method: 'PUT', body: Buffer.from('tail'), headers: dest });
    assert.equal((await ana(`${up}/.file`, { method: 'MOVE', headers: dest })).status, 201);
    const got = Buffer.from(await (await ana('/remote.php/dav/files/ana/big.bin')).arrayBuffer());
    assert.equal(got.length, 5 * 1024 * 1024 + 4);
    assert.equal(got.subarray(-4).toString(), 'tail');
    assert.ok(g.calls.some((c) => c.startsWith('POST object')), 'joined by compose in the bucket, not re-uploaded');
    const objectCount = [...g.objects.keys()].filter((k) => k.startsWith('objects/')).length;
    assert.equal(objectCount, 1, 'the chunks are gone once joined');
  } finally {
    await s.close();
    g.close();
  }
  const saved = [...g.objects.entries()].filter(([k]) => k.startsWith('state/')).map(([, v]) => v.data.toString()).join('');
  assert.match(saved, /big\.bin/, 'the state is saved in the bucket');
});
