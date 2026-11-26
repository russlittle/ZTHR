/**
 * The small-files journey as a measurement: N small files written at the desktop client's parallelism (six at a
 * time), then the whole tree listed folder by folder as a sync client would, against a server in this process.
 *
 *   node tools/load.ts [files=25000] [store=disk|memory]
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskObjects, memoryObjects } from '../../intent/blocks/objects/index.ts';
import { diskPersist, memoryPersist } from '../src/state.ts';
import { start } from '../test/helpers.ts';

const total = Number(process.argv[2] ?? 25_000);
const kind = process.argv[3] ?? 'disk';
const dir = await mkdtemp(join(tmpdir(), 'files-load-'));
const s = await start(kind === 'disk' ? { objects: diskObjects(join(dir, 'objects')), persist: diskPersist(join(dir, 'state')), people: [{ id: 'ana' }] } : { objects: memoryObjects(), persist: memoryPersist(), people: [{ id: 'ana' }] });
// The desktop app signs in with an app password, as every Nextcloud app does after its first sign-in.
const ana = s.as('ana', (await s.files.devices.issue('ana', 'load test')).password);
const perFolder = 250;
const folders = Math.ceil(total / perFolder);
const t0 = performance.now();
for (let f = 0; f < folders; f++) await ana(`/remote.php/dav/files/ana/d${f}`, { method: 'MKCOL' });
let next = 0;
const latencies: number[] = [];
const worker = async () => {
  for (;;) {
    const i = next++;
    if (i >= total) return;
    const t = performance.now();
    const r = await ana(`/remote.php/dav/files/ana/d${Math.floor(i / perFolder)}/file-${i}.txt`, { method: 'PUT', body: `file ${i}\n`, headers: { 'x-oc-mtime': '1700000000' } });
    if (r.status !== 201) throw new Error(`file ${i}: ${r.status}`);
    latencies.push(performance.now() - t);
  }
};
await Promise.all(Array.from({ length: 6 }, worker));
const upload = performance.now() - t0;
const t1 = performance.now();
const root = await ana('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '1' } });
await root.text();
for (let f = 0; f < folders; f++) await (await ana(`/remote.php/dav/files/ana/d${f}/`, { method: 'PROPFIND', headers: { depth: '1' } })).text();
const list = performance.now() - t1;
const t2 = performance.now();
await (await ana('/remote.php/dav/files/ana/', { method: 'PROPFIND', headers: { depth: '0' } })).text();
const recheck = performance.now() - t2;
latencies.sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]!.toFixed(1);
console.log(JSON.stringify({ files: total, store: kind, uploadSeconds: +(upload / 1000).toFixed(1), perSecond: Math.round(total / (upload / 1000)), p50ms: pct(50), p95ms: pct(95), p99ms: pct(99), fullListingSeconds: +(list / 1000).toFixed(2), unchangedRecheckMs: +recheck.toFixed(1) }));
await s.close();
await rm(dir, { recursive: true, force: true });
