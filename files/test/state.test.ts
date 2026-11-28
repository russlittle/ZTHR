import assert from 'node:assert/strict';
import { appendFile, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
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

/** Counts fsync calls on files and folders while `run` runs. */
async function syncs(run: () => Promise<void>): Promise<number> {
  const probe = await open(tmpdir(), 'r');
  const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  const m = mock.method(proto, 'sync');
  try {
    await run();
    return m.mock.callCount();
  } finally {
    m.mock.restore();
  }
}

const person = (id: string) => ({ id, display: id, passwordHash: 'h', quota: null, admin: false, groups: [], created: 0 });

test('on disk: every log entry is forced to disk before it counts as saved, and a snapshot forces the file and its folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'files-state-'));
  try {
    const p = diskPersist(dir);
    await p.load();
    assert.ok((await syncs(() => p.append(1, JSON.stringify({ n: 1, seq: { node: 0, grant: 0, device: 0 }, put: {} })))) >= 1, 'append calls fsync');
    assert.ok((await syncs(() => p.snapshot(1, JSON.stringify({ n: 1, doc: {} })))) >= 3, 'the snapshot file, the new log and their folder');
  } finally {
    await removeDiskState(dir);
  }
});

test('on disk: a torn last line is reported and cut off, so the next entry starts on a line of its own', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'files-state-'));
  try {
    const st = await State.open(diskPersist(dir));
    st.doc.people['a'] = person('a');
    st.mark('people', 'a');
    await st.flush();
    await appendFile(join(dir, 'log.jsonl'), '{"n":2,"seq":{"node":0,"gr');
    const reports: string[] = [];
    const again = await State.open(diskPersist(dir, { report: (m) => reports.push(m) }));
    assert.equal(reports.length, 1);
    assert.match(reports[0]!, /torn/);
    again.doc.people['b'] = person('b');
    again.mark('people', 'b');
    await again.flush();
    const third = await State.open(diskPersist(dir));
    assert.ok(third.doc.people['a'] && third.doc.people['b'], 'the entry after the torn one was kept, and the log still reads');
  } finally {
    await removeDiskState(dir);
  }
});

test('on disk: a damaged line that is not the last is corruption, and the server refuses to start with a clear message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'files-state-'));
  try {
    const st = await State.open(diskPersist(dir));
    for (const id of ['a', 'b', 'c']) {
      st.doc.people[id] = person(id);
      st.mark('people', id);
      await st.flush();
    }
    const log = join(dir, 'log.jsonl');
    const lines = (await readFile(log, 'utf8')).split('\n');
    lines[1] = lines[1]!.slice(0, 20);
    await writeFile(log, lines.join('\n'));
    await assert.rejects(State.open(diskPersist(dir)), /line 2 of 3.*not the last.*corrupt/s);
  } finally {
    await removeDiskState(dir);
  }
});
