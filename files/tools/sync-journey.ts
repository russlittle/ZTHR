/**
 * The unchanged Nextcloud desktop client (nextcloudcmd) against a server, step by step, each step pass or fail
 * with its time. Run once against a real Nextcloud (the control) and once against Files on the same runner; the
 * first-article workflow then says, for every step, whether a failure is Files' alone or the reference's too.
 *
 *   node tools/sync-journey.ts --url <base> --user <u> --password <p> --label <name> --out <result.json>
 *        [--files 25000] [--work <dir>] [--client nextcloudcmd] [--timeout 2400]
 *
 * The client talks to the server through a small recording proxy in this process, so the journey can show what
 * went over the wire (chunks, MOVEs) and can cut the client off at a chosen request to test resuming.
 *
 * Steps: initial sync of the small-files tree; a resync with nothing changed; an edit on each side; the same file
 * edited on both sides (a conflict copy); an interrupted sync resumed; a large file (chunked upload, and the
 * server's copy of it downloaded); a rename and a delete each way.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { JourneyResult, StepResult } from '../oracle/inspect.ts';
import { children, chunkedUpload, counts, isConflictCopy, transfers, type Logged } from './journey.ts';
import { PER_FOLDER, folders, seededBytes, smallTree } from './tree.ts';

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = args.indexOf(`--${k}`);
  const v = i >= 0 ? args[i + 1] : d;
  if (v === undefined) throw new Error(`--${k} is needed`);
  return v;
};
const base = opt('url').replace(/\/+$/, '');
const user = opt('user');
const password = opt('password');
const label = opt('label');
const outFile = opt('out');
const total = Number(opt('files', '25000'));
const work = opt('work', `/tmp/journey-${label}`);
const client = opt('client', 'nextcloudcmd');
const runTimeout = Number(opt('timeout', '2400')) * 1000;
if (!Number.isInteger(total) || total < 5 * PER_FOLDER) throw new Error(`--files must be at least ${5 * PER_FOLDER}: the rename and delete steps use folders d1 to d4`);

const local = join(work, 'local');
const logs = join(work, 'logs');
await rm(work, { recursive: true, force: true });
await mkdir(local, { recursive: true });
await mkdir(logs, { recursive: true });

// ---------------------------------------------------------------- the recording proxy

const upstream = new URL(base);
let log: Logged[] = [];
let onRequest: ((l: { method: string; path: string }) => void) | undefined;
const proxy = createServer((req: IncomingMessage, res: ServerResponse) => {
  const method = req.method ?? 'GET';
  const path = req.url ?? '/';
  onRequest?.({ method, path });
  const headers = { ...req.headers, host: upstream.host };
  const up = httpRequest({ host: upstream.hostname, port: upstream.port || 80, method, path, headers }, (r) => {
    log.push({ method, path, status: r.statusCode ?? 0 });
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => {
    log.push({ method, path, status: 502 });
    if (!res.headersSent) res.writeHead(502);
    res.end(String(e));
  });
  req.pipe(up);
});
await new Promise<void>((ok) => proxy.listen(0, '127.0.0.1', ok));
const proxied = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

// ---------------------------------------------------------------- the server side, directly

const auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const root = `/remote.php/dav/files/${encodeURIComponent(user)}`;
const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const dav = (method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}) =>
  fetch(`${base}${root}/${enc(path.replace(/^\/+/, ""))}`, { method, headers: { authorization: auth, 'ocs-apirequest': 'true', ...(init.headers ?? {}) }, ...(init.body !== undefined ? { body: init.body } : {}), redirect: 'manual' });
const PROPS = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>';
const list = async (folder: string) => {
  const r = await dav('PROPFIND', `${folder}/`, { headers: { depth: '1', 'content-type': 'application/xml' }, body: PROPS });
  const text = await r.text();
  return { status: r.status, entries: r.status === 207 ? children(text, `${root}/${enc(folder)}`) : new Map() };
};
const serverBytes = async (path: string): Promise<Buffer | null> => {
  const r = await dav('GET', path);
  if (r.status !== 200) {
    await r.body?.cancel();
    return null;
  }
  return Buffer.from(await r.arrayBuffer());
};
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- the client

let version = 'unknown';
async function runClient(name: string, killAt?: (l: { method: string; path: string }) => boolean): Promise<{ code: number | null; seconds: number; killed: boolean; tail: string }> {
  const file = join(logs, `${label}-${name.replace(/[^a-z0-9]+/gi, '-')}.log`);
  const out = createWriteStream(file);
  const t0 = performance.now();
  let tail = '';
  let killed = false;
  const child: ChildProcess = spawn(client, ['--non-interactive', '-u', user, '-p', password, local, proxied], { env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' } });
  const keep = (d: Buffer) => {
    out.write(d);
    tail = (tail + d.toString()).slice(-4000);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  if (killAt)
    onRequest = (l) => {
      if (!killed && killAt(l)) {
        killed = true;
        child.kill('SIGKILL');
      }
    };
  const timer = setTimeout(() => child.kill('SIGKILL'), runTimeout);
  const code = await new Promise<number | null>((ok) => child.on('close', (c) => ok(c)));
  clearTimeout(timer);
  onRequest = undefined;
  out.end();
  return { code, seconds: (performance.now() - t0) / 1000, killed, tail: tail.split('\n').filter((l) => /error|fail|warn|conflict/i.test(l)).slice(-8).join(' / ') };
}

// ---------------------------------------------------------------- the steps

const steps: StepResult[] = [];
const save = async () => {
  const result: JourneyResult = { server: label, client: version, files: total, steps };
  await writeFile(outFile, `${JSON.stringify(result, null, 1)}\n`);
};
async function step(name: string, fn: () => Promise<{ pass: boolean; seconds: number; detail: string }>) {
  const t0 = performance.now();
  let r: { pass: boolean; seconds: number; detail: string };
  try {
    log = [];
    r = await fn();
  } catch (e) {
    r = { pass: false, seconds: (performance.now() - t0) / 1000, detail: `threw: ${e instanceof Error ? e.message : String(e)}` };
  }
  steps.push({ step: name, ...r, seconds: +r.seconds.toFixed(2) });
  console.log(`${r.pass ? 'pass' : 'FAIL'}  ${name}  ${r.seconds.toFixed(1)} s  ${r.detail}`);
  await save();
}
const ran = (c: { code: number | null; tail: string }) => (c.code === 0 ? '' : `client exit ${c.code}${c.tail ? `: ${c.tail}` : ''}; `);

version = await new Promise<string>((ok) => {
  const c = spawn(client, ['--version'], { env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' } });
  let s = '';
  c.stdout?.on('data', (d: Buffer) => (s += d.toString()));
  c.stderr?.on('data', (d: Buffer) => (s += d.toString()));
  c.on('error', () => ok('not installed'));
  c.on('close', () => ok(s.split('\n').find((l) => /\d+\.\d+/.test(l))?.trim() ?? (s.trim() || 'unknown')));
});

const tree = [...smallTree(total)];
const dirs = folders(total);

await step(`initial sync of ${total} small files`, async () => {
  const already = (await list('')).entries.size;
  if (already) return { pass: false, seconds: 0, detail: `the account must start empty; it holds ${already} entries` };
  for (const d of dirs) await mkdir(join(local, d), { recursive: true });
  for (const f of tree) await writeFile(join(local, f.path), f.content);
  const c = await runClient('initial');
  let missing = 0;
  let wrong = 0;
  for (const d of dirs) {
    const { entries } = await list(d);
    for (const f of tree.filter((x) => x.folder === d)) {
      const e = entries.get(f.path.slice(d.length + 1));
      if (!e) missing++;
      else if (e.size !== Buffer.byteLength(f.content)) wrong++;
    }
  }
  return { pass: c.code === 0 && missing === 0 && wrong === 0, seconds: c.seconds, detail: `${ran(c)}${total - missing} of ${total} on the server, ${wrong} with the wrong size; requests ${JSON.stringify(counts(log))}` };
});

await step('resync with nothing changed moves no file contents', async () => {
  const c = await runClient('unchanged');
  const moved = transfers(log);
  return { pass: c.code === 0 && moved === 0, seconds: c.seconds, detail: `${ran(c)}${moved} file transfers; requests ${JSON.stringify(counts(log))}` };
});

await step('an edit on each side propagates', async () => {
  const up = tree[1]!;
  const down = tree[2]!;
  await writeFile(join(local, up.path), 'edited on this computer\n');
  const put = await dav('PUT', down.path, { body: 'edited on the server\n' });
  await put.body?.cancel();
  const c = await runClient('edits');
  const there = (await serverBytes(up.path))?.toString();
  const here = await readFile(join(local, down.path), 'utf8');
  const ok = there === 'edited on this computer\n' && here === 'edited on the server\n';
  return { pass: c.code === 0 && ok && put.status < 300, seconds: c.seconds, detail: `${ran(c)}server PUT ${put.status}; uploaded edit ${there === 'edited on this computer\n' ? 'arrived' : 'missing'}; downloaded edit ${here === 'edited on the server\n' ? 'arrived' : 'missing'}` };
});

await step('the same file edited on both sides leaves a conflict copy', async () => {
  const f = tree[0]!;
  const name = f.path.slice(f.folder.length + 1);
  await writeFile(join(local, f.path), 'the local side of the conflict\n');
  const put = await dav('PUT', f.path, { body: 'the server side of the conflict\n' });
  await put.body?.cancel();
  const c = await runClient('conflict');
  const here = await readFile(join(local, f.path), 'utf8');
  const copies = (await readdir(join(local, f.folder))).filter((n) => isConflictCopy(n, name));
  const copyText = copies[0] ? await readFile(join(local, f.folder, copies[0]), 'utf8') : '';
  const there = (await serverBytes(f.path))?.toString();
  const ok = here === 'the server side of the conflict\n' && copies.length === 1 && copyText === 'the local side of the conflict\n' && there === 'the server side of the conflict\n';
  return { pass: c.code === 0 && ok, seconds: c.seconds, detail: `${ran(c)}local file has the ${here.includes('server side') ? 'server' : 'local'} text; conflict copies: ${copies.length ? copies.join(', ') : 'none'}${copies.length ? ` (${copyText === 'the local side of the conflict\n' ? 'holds the local edit' : 'wrong content'})` : ''}; server keeps the ${there?.includes('server side') ? 'server' : 'other'} text` };
});

await step('an interrupted sync resumes and completes', async () => {
  const n = 2000;
  await mkdir(join(local, 'resume'), { recursive: true });
  for (let i = 0; i < n; i++) await writeFile(join(local, 'resume', `r-${i}.txt`), `resume ${i}\n`);
  // Cut the client off once a tenth of the files are on their way: 200 single PUTs, or 3 bulk uploads where the
  // server offers bulk upload (a real Nextcloud does; the client then sends small files 100 to a request).
  const enough = () => log.filter((x) => x.method === 'PUT').length >= 200 || log.filter((x) => x.method === 'POST' && x.path.includes('/dav/bulk')).length >= 3;
  const first = await runClient('interrupted', () => enough());
  const before = (await list('resume')).entries.size;
  log = [];
  const second = await runClient('resumed');
  const after = (await list('resume')).entries;
  const all = Array.from({ length: n }, (_, i) => `r-${i}.txt`).every((k) => after.has(k));
  const reuploads = log.filter((l) => l.method === 'PUT').length;
  return {
    pass: first.killed && second.code === 0 && all,
    seconds: first.seconds + second.seconds,
    detail: `${first.killed ? `cut off after ${before} of ${n} files had arrived` : 'the first run finished before it could be cut off'}; ${ran(second)}${after.size} of ${n} present after resuming; the resumed run sent ${reuploads} PUTs`,
  };
});

await step('a large file goes up in chunks and comes back intact', async () => {
  const size = 48 * 1024 * 1024 + 12345;
  const bytes = seededBytes(size, 7);
  await mkdir(join(local, 'big'), { recursive: true });
  await writeFile(join(local, 'big', 'large.bin'), bytes);
  const c = await runClient('large-up');
  const chunks = chunkedUpload(log);
  const there = await serverBytes('big/large.bin');
  const copy = await dav('COPY', 'big/large.bin', { headers: { destination: `${base}${root}/big/large-copy.bin` } });
  await copy.body?.cancel();
  log = [];
  const d = await runClient('large-down');
  const back = existsSync(join(local, 'big', 'large-copy.bin')) ? await readFile(join(local, 'big', 'large-copy.bin')) : null;
  const ok = chunks.started && chunks.chunks > 1 && chunks.assembled && there !== null && sha(there) === sha(bytes) && back !== null && sha(back) === sha(bytes);
  return { pass: c.code === 0 && d.code === 0 && ok, seconds: c.seconds + d.seconds, detail: `${ran(c)}${ran(d)}${size} bytes; upload session ${chunks.started ? 'opened' : 'not opened'}, ${chunks.chunks} chunks, ${chunks.assembled ? 'assembled' : 'not assembled'}; server copy ${there ? (sha(there) === sha(bytes) ? 'matches' : 'differs') : 'missing'}; downloaded copy ${back ? (sha(back) === sha(bytes) ? 'matches' : 'differs') : 'missing'}` };
});

await step('renames and deletes propagate both ways', async () => {
  const gone = tree.find((f) => f.folder === 'd2')!;
  const gone2 = tree.find((f) => f.folder === 'd4')!;
  await rename(join(local, 'd1'), join(local, 'd1-renamed'));
  await rm(join(local, gone.path));
  const up = await runClient('rename-up');
  const moves = log.filter((l) => l.method === 'MOVE').length;
  const reputs = log.filter((l) => l.method === 'PUT' && l.path.includes('d1-renamed')).length;
  const oldThere = (await list('d1')).status;
  const newThere = (await list('d1-renamed')).entries.size;
  const goneThere = (await dav('PROPFIND', gone.path, { headers: { depth: '0' } })).status;
  const mv = await dav('MOVE', 'd3', { headers: { destination: `${base}${root}/d3-moved` } });
  await mv.body?.cancel();
  const del = await dav('DELETE', gone2.path);
  await del.body?.cancel();
  const downRun = await runClient('rename-down');
  const localOld = existsSync(join(local, 'd3'));
  const localNew = existsSync(join(local, 'd3-moved')) ? (await readdir(join(local, 'd3-moved'))).length : 0;
  const localGone = existsSync(join(local, gone2.path));
  const upOk = oldThere === 404 && newThere === PER_FOLDER && goneThere === 404 && moves > 0 && reputs === 0;
  const downOk = mv.status < 300 && del.status < 300 && !localOld && localNew === PER_FOLDER && !localGone;
  return {
    pass: up.code === 0 && downRun.code === 0 && upOk && downOk,
    seconds: up.seconds + downRun.seconds,
    detail: `${ran(up)}${ran(downRun)}up: old folder ${oldThere}, renamed folder holds ${newThere}, deleted file ${goneThere}, ${moves} MOVE and ${reputs} re-uploads; down: server MOVE ${mv.status}, DELETE ${del.status}, old folder ${localOld ? 'still here' : 'gone'}, moved folder holds ${localNew}, deleted file ${localGone ? 'still here' : 'gone'}`,
  };
});

await save();
proxy.close();
process.exit(steps.every((s) => s.pass) ? 0 : 1);
