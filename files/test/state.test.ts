import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { State, diskPersist, memoryPersist, removeDiskState } from '../src/state.ts';
import { PASS, start } from './helpers.ts';

test('a change writes only the records it touched, however big the tree is', async () => {
  const persist = memoryPersist();
  const s = await start({ persist });
  const ana = s.as('ana', PASS);
  try {
    for (let i = 0; i < 200; i++) await ana(`/remote.php/dav/files/ana/f${i}.txt`, { method: 'PUT', body: 'x' });
    const before = persist.entries.size;
    await ana('/remote.php/dav/files/ana/one-more.txt', { method: 'PUT', body: 'x' });
    const last = [...persist.entries.values()].pop()!;
    assert.ok(persist.entries.size > before);
    assert.ok(last.length < 2000, `one file write logged ${last.length} bytes, not the whole tree`);
  } finally {
    await s.close();
  }
});

test('the log replays on restart, and a snapshot every so often keeps it short', async () => {
  const persist = memoryPersist();
  const st = await State.open(persist, { snapshotEvery: 5 });
  for (let i = 0; i < 12; i++) {
    st.doc.people[`p${i}`] = { id: `p${i}`, display: 'x', passwordHash: 'h', quota: null, admin: false, groups: [], created: 0 };
    st.mark('people', `p${i}`);
    await st.flush();
  }
  delete st.doc.people['p3'];
  st.mark('people', 'p3');
  await st.flush();
  assert.ok(persist.entries.size < 5, 'entries before the last snapshot are dropped');
  const again = await State.open(persist);
  assert.equal(Object.keys(again.doc.people).length, 11);
  assert.equal(again.doc.people['p3'], undefined, 'a removal replays as a removal');
  assert.equal(again.doc.instance, st.doc.instance);
});

test('on disk: a line torn by a crash mid-write is dropped, and everything before it is kept', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'files-state-'));
  try {
    const st = await State.open(diskPersist(dir));
    st.doc.people['a'] = { id: 'a', display: 'a', passwordHash: 'h', quota: null, admin: false, groups: [], created: 0 };
    st.mark('people', 'a');
    await st.flush();
    await appendFile(join(dir, 'log.jsonl'), '{"n":2,"seq":{"node":0,"gr');
    const again = await State.open(diskPersist(dir));
    assert.ok(again.doc.people['a']);
    await again.compact();
    assert.equal((await readFile(join(dir, 'log.jsonl'), 'utf8')).trim(), '', 'a compaction leaves an empty log');
  } finally {
    await removeDiskState(dir);
  }
});
