import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Drain, ShuttingDown, allowedDuring, badge, maintenance, readiness, statusPage, version } from './index.ts';

test('readiness: down when a critical dependency fails, degraded for the rest, and slow is a failure', async () => {
  const fine = { name: 'db', critical: true, run: async () => undefined };
  const slow = { name: 'search', critical: false, run: () => new Promise<void>((ok) => setTimeout(ok, 200)) };
  const broken = { name: 'storage', critical: true, run: async () => Promise.reject(new Error('refused')) };
  assert.equal((await readiness([fine])).status, 'ok');
  const d = await readiness([fine, slow], 50);
  assert.equal(d.status, 'degraded');
  assert.match(d.checks[1]!.error!, /no answer within 50 ms/);
  assert.equal((await readiness([fine, broken])).status, 'down');
  assert.deepEqual(version({ commit: 'abc', built: '2026-11-26' }), { commit: 'abc', built: '2026-11-26' });
});

test('a shutdown stops new work, lets work in flight finish, and reports what it had to cut off', async () => {
  const d = new Drain();
  let finished = 0;
  const work = d.track(async () => {
    await new Promise((ok) => setTimeout(ok, 30));
    finished++;
  });
  const stopping = d.stop(1000);
  await assert.rejects(d.track(async () => undefined), ShuttingDown);
  assert.equal(await stopping, 0);
  await work;
  assert.equal(finished, 1);
  const d2 = new Drain();
  void d2.track(() => new Promise((ok) => setTimeout(ok, 500)));
  assert.equal(await d2.stop(20), 1, 'one request was still running when the grace ran out');
});

test('maintenance: announced ahead, read-only during, gone after', () => {
  const w = [{ from: 1000, to: 2000, message: 'Database upgrade', noticeMs: 500 }];
  assert.equal(maintenance(w, 100).phase, 'none');
  assert.equal(maintenance(w, 600).phase, 'notice');
  const on = maintenance(w, 1500);
  assert.equal(on.phase, 'active');
  assert.equal(allowedDuring(on, 'GET'), true);
  assert.equal(allowedDuring(on, 'PUT'), false);
  assert.equal(maintenance(w, 2000).phase, 'none');
});

test('the badge marks every environment but production, and the status page shows the worst', () => {
  assert.equal(badge('production', 'abc'), null);
  assert.equal(badge('uat', 'abcdef123')!.text, 'UAT · abcdef1');
  const s = statusPage(
    [
      { name: 'Sync', status: 'ok' },
      { name: 'Sharing', status: 'ok' },
    ],
    [{ title: 'Slow uploads', components: ['Sync'], status: 'identified', updates: [{ at: '10:00', text: 'Looking' }, { at: '10:20', text: 'Found it' }] }],
  );
  assert.equal(s.overall, 'degraded');
  assert.equal(s.incidents[0]!.latest!.text, 'Found it');
  assert.equal(statusPage([{ name: 'Sync', status: 'down' }], []).headline, 'The service is down');
});

test('readiness judges each check by its own criticality, even when two share a name', async () => {
  const r = await readiness([
    { name: 'db', critical: false, run: async () => undefined },
    { name: 'db', critical: true, run: async () => Promise.reject(new Error('primary unreachable')) },
  ]);
  assert.equal(r.status, 'down', 'the critical one failed');
});
