/**
 * The small-files journey as a measurement: N small files written at the desktop client's parallelism (six at a
 * time), then the whole tree listed folder by folder as a sync client would, then the one-request "nothing
 * changed" check. By default against a Files server in this process; with --url against any server over HTTP,
 * which is how the first-article inspection runs it against a real Nextcloud (the control) and against Files on
 * the same runner.
 *
 *   node tools/load.ts [files=25000] [store=disk|memory] [--url <base> --user <u> --password <p>]
 *        [--time-limit 1800] [--max-seconds S] [--max-p95-ms MS] [--max-errors 0] [--seed 25000] [--out result.json]
 *
 * It prints one JSON line and exits 1 when any limit is broken: the time limit stops the journey where it is.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskObjects, memoryObjects } from '../../intent/blocks/objects/index.ts';
import { diskPersist, memoryPersist } from '../src/state.ts';
import { start } from '../test/helpers.ts';
import { parseLoadArgs, percentile, verdict, type LoadResult } from './bench.ts';
import { folders as folderNames, smallTree } from './tree.ts';

type Call = (path: string, init?: RequestInit & { headers?: Record<string, string> }) => Promise<Response>;

const o = parseLoadArgs(process.argv.slice(2));
let close = async () => {};
let call: Call;
let user: string;
let target: string;
if (o.url) {
  user = o.user!;
  target = o.url;
  const basic = (pw: string) => `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}`;
  // Sign in as the apps do: trade the password for an app password once, then use that on every request.
  let auth = basic(o.password!);
  const r = await fetch(`${o.url}/ocs/v2.php/core/getapppassword?format=json`, { headers: { authorization: auth, 'ocs-apirequest': 'true' } });
  if (r.ok) {
    const pw = ((await r.json()) as { ocs?: { data?: { apppassword?: string } } }).ocs?.data?.apppassword;
    if (pw) auth = basic(pw);
  } else await r.body?.cancel();
  call = (path, init = {}) => fetch(`${o.url}${path}`, { ...init, redirect: 'manual', headers: { authorization: auth, ...(init.headers ?? {}) } });
} else {
  user = 'ana';
  target = `in-process ${o.store}`;
  const dir = await mkdtemp(join(tmpdir(), 'files-load-'));
  const s = await start(o.store === 'disk' ? { objects: diskObjects(join(dir, 'objects')), persist: diskPersist(join(dir, 'state')), people: [{ id: 'ana' }] } : { objects: memoryObjects(), persist: memoryPersist(), people: [{ id: 'ana' }] });
  call = s.as('ana', (await s.files.devices.issue('ana', 'load test')).password);
  close = async () => {
    await s.close();
    await rm(dir, { recursive: true, force: true });
  };
}

const root = `/remote.php/dav/files/${encodeURIComponent(user)}`;
const deadline = performance.now() + o.timeLimit * 1000;
const late = () => performance.now() > deadline;
const tree = [...smallTree(o.files, o.seed)];
const dirs = folderNames(o.files);
let errors = 0;
let firstError: string | undefined;
const fail = (what: string) => {
  errors++;
  firstError ??= what;
};

const t0 = performance.now();
for (const d of dirs) {
  if (late()) break;
  const r = await call(`${root}/${d}`, { method: 'MKCOL' });
  await r.body?.cancel();
  if (r.status !== 201) fail(`MKCOL ${d}: ${r.status}`);
}
let next = 0;
let completed = 0;
const latencies: number[] = [];
const worker = async () => {
  for (;;) {
    if (late()) return;
    const i = next++;
    if (i >= tree.length) return;
    const f = tree[i]!;
    const t = performance.now();
    try {
      const r = await call(`${root}/${f.path}`, { method: 'PUT', body: f.content, headers: { 'x-oc-mtime': '1700000000' } });
      await r.body?.cancel();
      latencies.push(performance.now() - t);
      if (r.status === 201) completed++;
      else fail(`PUT ${f.path}: ${r.status}`);
    } catch (e) {
      fail(`PUT ${f.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
};
await Promise.all(Array.from({ length: 6 }, worker));
const upload = performance.now() - t0;
const t1 = performance.now();
if (!late()) {
  await (await call(`${root}/`, { method: 'PROPFIND', headers: { depth: '1' } })).text();
  for (const d of dirs) {
    if (late()) break;
    await (await call(`${root}/${d}/`, { method: 'PROPFIND', headers: { depth: '1' } })).text();
  }
}
const list = performance.now() - t1;
const t2 = performance.now();
if (!late()) await (await call(`${root}/`, { method: 'PROPFIND', headers: { depth: '0' } })).text();
const recheck = performance.now() - t2;
latencies.sort((a, b) => a - b);
const ms = (n: number) => +n.toFixed(1);
const result: LoadResult = {
  files: o.files,
  target,
  completed,
  errors,
  ...(firstError ? { firstError } : {}),
  timedOut: late(),
  uploadSeconds: +(upload / 1000).toFixed(2),
  perSecond: Math.round(completed / (upload / 1000)),
  p50ms: ms(percentile(latencies, 50)),
  p95ms: ms(percentile(latencies, 95)),
  p99ms: ms(percentile(latencies, 99)),
  fullListingSeconds: +(list / 1000).toFixed(2),
  unchangedRecheckMs: ms(recheck),
};
const broken = verdict(result, o);
const line = { ...result, limits: { timeLimit: o.timeLimit, maxSeconds: o.maxSeconds ?? null, maxP95Ms: o.maxP95Ms ?? null, maxErrors: o.maxErrors }, pass: broken.length === 0, broken };
console.log(JSON.stringify(line));
if (o.out) await writeFile(o.out, `${JSON.stringify(line, null, 1)}\n`);
await close();
process.exit(broken.length ? 1 : 0);
