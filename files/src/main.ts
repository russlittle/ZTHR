/**
 * Starts Files from its environment:
 *
 *   PORT                 where to listen (Cloud Run sets it)
 *   FILES_STORE          memory | disk | gcs
 *   FILES_DIR            for disk: where bytes and the state document go
 *   FILES_BUCKET         for gcs: the bucket
 *   FILES_ORIGIN         the address people use, such as https://files.example.org
 *   FILES_ADMIN          the first admin's login name, created on first start
 *   FILES_ADMIN_PASSWORD their password, from Secret Manager; needed only on first start
 *   FILES_QUOTA          a default quota for new people ("50 GB", "none")
 *   FILES_MAX_CHUNK      the largest upload chunk ("30 MB" on Cloud Run, whose HTTP/1 limit is 32 MiB)
 *
 * The state is saved after every change and on shutdown; a sweep of the trash, old versions, idle uploads and
 * expired links runs every six hours.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { diskObjects, memoryObjects, type ObjectStore } from '../../intent/blocks/objects/index.ts';
import { Files } from './app.ts';
import { gcsObjects, gcsPersist } from './gcs.ts';
import { quotaBytes } from './ocs.ts';
import { serve } from './server.ts';
import { State, diskPersist, memoryPersist, type Persist } from './state.ts';

const env = process.env;
const log = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(line)}\n`);

async function stores(): Promise<{ objects: ObjectStore; persist: Persist }> {
  const kind = env['FILES_STORE'] ?? 'disk';
  if (kind === 'memory') return { objects: memoryObjects(), persist: memoryPersist() };
  if (kind === 'gcs') {
    const bucket = env['FILES_BUCKET'];
    if (!bucket) throw new Error('FILES_BUCKET names the bucket when FILES_STORE is gcs');
    return { objects: gcsObjects({ bucket }), persist: gcsPersist({ bucket }) };
  }
  const dir = env['FILES_DIR'] ?? './data';
  await mkdir(join(dir, 'objects'), { recursive: true });
  return { objects: diskObjects(join(dir, 'objects')), persist: diskPersist(join(dir, 'state')) };
}

async function main() {
  const { objects, persist } = await stores();
  const state = await State.open(persist);
  const maxChunk = env['FILES_MAX_CHUNK'] ? quotaBytes(env['FILES_MAX_CHUNK']) : null;
  const files = new Files(state, objects, { defaultQuota: env['FILES_QUOTA'] ? quotaBytes(env['FILES_QUOTA']) : null, ...(maxChunk ? { maxChunk } : {}) });
  if (!files.people().length) {
    const id = env['FILES_ADMIN'];
    const pw = env['FILES_ADMIN_PASSWORD'];
    if (!id || !pw) throw new Error('on first start, FILES_ADMIN and FILES_ADMIN_PASSWORD create the first admin');
    await files.addPerson(id, pw, { admin: true });
    await state.flush();
    log({ severity: 'NOTICE', message: `created the first admin, ${id}` });
  }
  const port = Number(env['PORT'] ?? 8080);
  const server = await serve(files, port, { ...(env['FILES_ORIGIN'] ? { origin: env['FILES_ORIGIN'] } : {}), log });
  log({ severity: 'NOTICE', message: `Files listening on ${port}`, store: env['FILES_STORE'] ?? 'disk' });
  const sweep = setInterval(async () => {
    try {
      log({ severity: 'INFO', message: 'sweep', ...(await files.sweep()) });
    } catch (e) {
      log({ severity: 'ERROR', message: `sweep failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, 6 * 3600_000);
  sweep.unref();
  const stop = async (signal: string) => {
    log({ severity: 'NOTICE', message: `${signal}: saving and stopping` });
    server.close();
    await state.compact();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((e) => {
  log({ severity: 'CRITICAL', message: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
