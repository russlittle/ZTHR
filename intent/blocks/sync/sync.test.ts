import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sync, Twin, type Local } from './index.ts';

const clock = () => {
  let t = Date.parse('2026-11-26T00:00:00Z');
  return { now: () => new Date(t), tick: (s = 1) => void (t += s * 1000) };
};
const map = { toLocal: (r: { fields: Readonly<Record<string, unknown>> }) => ({ title: r.fields.summary, status: r.fields.state }), toRemote: (l: Local) => ({ summary: l.fields.title, state: l.fields.status }) };

test('pulls in pages, pushes local changes, and our own pushes do not come back as changes', async () => {
  const c = clock();
  const jira = new Twin('tickets', c.now);
  for (let i = 0; i < 5; i++) jira.edit(undefined, { summary: `Bug ${i}`, state: 'open' });
  const local = new Map<string, Local>();
  const s = new Sync(jira, local, { ...map, now: c.now });
  c.tick();
  const r1 = await s.run(2);
  assert.equal(r1.pulled, 5);
  assert.equal(r1.cursor, '5');
  assert.equal(local.size, 5);
  c.tick();
  local.set('mine', { id: 'mine', updated: c.now().toISOString(), fields: { title: 'Found in Files', status: 'open' } });
  const r2 = await s.run();
  assert.deepEqual([r2.pulled, r2.pushed], [0, 1]);
  assert.match(local.get('mine')!.remoteId!, /^TICKETS-\d+$/);
  assert.equal(jira.records.get(local.get('mine')!.remoteId!)!.fields.summary, 'Found in Files');
  const r3 = await s.run();
  assert.deepEqual([r3.pulled, r3.pushed], [0, 0], 'our push comes back in the feed and is recognised, not re-applied or re-pushed');
  assert.equal(r3.cursor, '6');
});

test('a record changed on both sides is settled by the rule and reported; a failed push is retried next run', async () => {
  const c = clock();
  const wiki = new Twin('wiki', c.now);
  const page = wiki.edit(undefined, { summary: 'Runbook', state: 'draft' });
  const local = new Map<string, Local>();
  const s = new Sync(wiki, local, { ...map, now: c.now, rule: 'newest' });
  c.tick();
  await s.run();
  const l = [...local.values()][0]!;
  c.tick(10);
  wiki.edit(page.id, { state: 'published' });
  c.tick(10);
  l.fields.status = 'archived';
  (l as { updated: string }).updated = c.now().toISOString();
  const r = await s.run();
  assert.deepEqual(r.conflicts, [{ local: l.id, remote: page.id, kept: 'local', fields: ['status'] }]);
  assert.equal(wiki.records.get(page.id)!.fields.state, 'archived', 'the newer local edit was pushed');
  c.tick();
  local.set('new', { id: 'new', updated: c.now().toISOString(), fields: { title: 'x', status: 'draft' } });
  wiki.failNextUpsert = true;
  await assert.rejects(s.run(), /unavailable/);
  assert.equal(local.get('new')!.remoteId, undefined);
  const again = await s.run();
  assert.equal(again.pushed, 1);
});
