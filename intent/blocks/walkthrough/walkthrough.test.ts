import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Walkthrough, type Evidence, type Journey } from './index.ts';

const journeys: Journey[] = [
  {
    id: 'share', goal: 'Share a folder with a colleague', persona: 'owner',
    steps: [
      { id: 'pick', does: 'Ana opens Projects and chooses Share.', claim: 'Only the owner sees Share', balloon: 3, because: 'Ana holds the owner grant on Projects.', covers: ['src/grants.ts'] },
      { id: 'send', does: 'Ana adds Ben with view access.', claim: 'Ben can open Projects and nothing else', balloon: 4, covers: ['src/grants.ts', 'src/share.ts'] },
    ],
  },
  { id: 'revoke', goal: 'Take the share back', persona: 'owner', steps: [{ id: 'undo', does: 'Ana removes Ben.', claim: 'Ben loses access at once', balloon: 5, covers: ['src/grants.ts'] }] },
];
const changes = [
  { path: 'src/grants.ts', at: '2026-11-20T10:00:00Z' },
  { path: 'src/share.ts', at: '2026-11-21T10:00:00Z' },
  { path: 'src/grants.ts', at: '2026-11-19T10:00:00Z' },
];
const ev = (id: string, proves: string, at: string, passed = true, kind: Evidence['kind'] = 'test'): Evidence => ({ id, proves, kind, ref: `${kind}:${id}`, at, passed });

test('each step shows what it does, what it claims, its balloon, why the app decided, and whether its evidence is current', () => {
  const w = new Walkthrough({ id: 'sharing', name: 'Sharing' }, journeys, [ev('t1', 'share/pick', '2026-11-22T00:00:00Z'), ev('t2', 'share/send', '2026-11-21T09:00:00Z'), ev('s1', 'revoke/undo', '2026-11-22T00:00:00Z', false, 'screenshot')], changes);
  const steps = w.walk();
  assert.deepEqual(steps.map((s) => [s.n, s.key, s.status]), [[1, 'share/pick', 'current'], [2, 'share/send', 'stale'], [3, 'revoke/undo', 'failed']]);
  const [pick, send, undo] = steps as [typeof steps[0], typeof steps[0], typeof steps[0]];
  assert.deepEqual({ does: pick.does, claim: pick.claim, balloon: pick.balloon, because: pick.because, goal: pick.goal, persona: pick.persona, lastChange: pick.lastChange }, { does: 'Ana opens Projects and chooses Share.', claim: 'Only the owner sees Share', balloon: 3, because: 'Ana holds the owner grant on Projects.', goal: 'Share a folder with a colleague', persona: 'owner', lastChange: '2026-11-20T10:00:00Z' }, 'the latest change to a file is kept, whatever order changes arrive in');
  assert.equal(pick.reason, 't1 passed at 2026-11-22T00:00:00Z, after the last change to the code it covers at 2026-11-20T10:00:00Z.');
  assert.equal(send.reason, 't2 is from 2026-11-21T09:00:00Z, and the code it covers changed at 2026-11-21T10:00:00Z.', 'the newest change across every covered file counts');
  assert.equal(undo.reason, 'The latest evidence, s1, failed.');
  assert.equal(undo.because, null);
});

test('sign-off goes step by step, only on current evidence, and every refusal is kept with its reason', () => {
  const w = new Walkthrough({ id: 'sharing', name: 'Sharing' }, journeys, [ev('t1', 'share/pick', '2026-11-22T00:00:00Z'), ev('t2', 'share/send', '2026-11-21T09:00:00Z')], changes);
  assert.deepEqual(w.signOff('share/send', 'Russ', '2026-11-27T09:00:00Z'), { ok: false, why: 'Sign off the steps in order: step 1, "Only the owner sees Share", comes first.' });
  assert.deepEqual(w.signOff('share/pick', '  ', '2026-11-27T09:00:00Z'), { ok: false, why: 'A sign-off needs the name of the person giving it.' });
  const ok = w.signOff('share/pick', 'Russ', '2026-11-27T09:01:00Z', 'Watched it refuse Ben.');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok && ok.step.signed, { who: 'Russ', at: '2026-11-27T09:01:00Z', note: 'Watched it refuse Ben.', evidence: 't1', evidenceAt: '2026-11-22T00:00:00Z' });
  assert.deepEqual(w.signOff('share/pick', 'Ana', '2026-11-27T09:02:00Z'), { ok: false, why: 'Step 1 is already signed off by Russ.' });
  assert.deepEqual(w.signOff('share/send', 'Russ', '2026-11-27T09:03:00Z'), { ok: false, why: 'Step 2 cannot be signed off. t2 is from 2026-11-21T09:00:00Z, and the code it covers changed at 2026-11-21T10:00:00Z.' });
  assert.deepEqual(w.signOff('share/nope', 'Russ', '2026-11-27T09:04:00Z'), { ok: false, why: 'There is no step share/nope in Sharing.' });
  w.addEvidence(ev('t3', 'share/send', '2026-11-27T08:00:00Z', true, 'run'));
  assert.equal(w.signOff('share/send', 'Russ', '2026-11-27T09:05:00Z').ok, true, 'newer evidence makes it current');
  assert.deepEqual(w.signOff('revoke/undo', 'Russ', '2026-11-27T09:06:00Z'), { ok: false, why: 'Step 3 cannot be signed off. Nothing proves this step yet.' });
  const r = w.record();
  assert.equal(r.complete, false);
  assert.equal(r.summary, '2 of 3 steps signed off on current evidence. Next is step 3: "Ben loses access at once".');
  assert.deepEqual(r.refusals.map((x) => [x.key, x.who]), [['share/send', 'Russ'], ['share/pick', '  '], ['share/pick', 'Ana'], ['share/send', 'Russ'], ['share/nope', 'Russ'], ['revoke/undo', 'Russ']]);
  assert.match(r.digest, /^[0-9a-f]{64}$/);
  assert.equal(r.digest, w.record().digest, 'the same record gives the same digest');
});

test('a change to covered code after sign-off voids it until newer evidence is signed again; a complete walk says so', () => {
  const w = new Walkthrough({ id: 'sharing', name: 'Sharing' }, journeys, [ev('t1', 'share/pick', '2026-11-22T00:00:00Z'), ev('t3', 'share/send', '2026-11-22T00:00:00Z'), ev('t4', 'revoke/undo', '2026-11-22T00:00:00Z')], changes);
  for (const k of ['share/pick', 'share/send', 'revoke/undo']) assert.equal(w.signOff(k, 'Russ', '2026-11-27T09:00:00Z').ok, true);
  const done = w.record();
  assert.equal(done.complete, true);
  assert.equal(done.summary, 'Every step of Sharing is signed off on current evidence.');
  w.codeChanged('src/share.ts', '2026-11-27T10:00:00Z');
  const after = w.record();
  assert.notEqual(after.digest, done.digest);
  assert.deepEqual(after.steps.map((s) => [s.key, s.status, s.void]), [['share/pick', 'current', false], ['share/send', 'stale', true], ['revoke/undo', 'current', false]]);
  assert.equal(after.summary, '2 of 3 steps signed off on current evidence; 1 no longer count because the code changed. Next is step 2: "Ben can open Projects and nothing else".');
  assert.equal(w.next()!.key, 'share/send');
  assert.equal(w.signOff('share/send', 'Russ', '2026-11-27T11:00:00Z').ok, false, 'stale evidence is still refused');
  w.addEvidence(ev('t5', 'share/send', '2026-11-27T10:30:00Z'));
  assert.equal(w.signOff('share/send', 'Ana', '2026-11-27T11:00:00Z').ok, true);
  assert.equal(w.record().complete, true);
  assert.equal(w.next(), undefined);
});

test('a step that names no code, or code with no change record, can never be signed; newer failing evidence beats an older pass', () => {
  const w = new Walkthrough({ id: 'f', name: 'F' }, [{ id: 'j', goal: 'g', persona: 'p', steps: [{ id: 'a', does: 'd', claim: 'A', covers: [] }, { id: 'b', does: 'd', claim: 'B', covers: ['src/unknown.ts'] }, { id: 'c', does: 'd', claim: 'C', covers: ['src/x.ts'] }] }], [ev('e1', 'j/a', '2026-11-22T00:00:00Z'), ev('e2', 'j/b', '2026-11-22T00:00:00Z'), ev('e3', 'j/c', '2026-11-22T00:00:00Z'), ev('e4', 'j/c', '2026-11-23T00:00:00Z', false)], [{ path: 'src/x.ts', at: '2026-11-01T00:00:00Z' }]);
  assert.deepEqual(w.walk().map((s) => [s.status, s.reason, s.evidence?.id]), [
    ['uncovered', 'The step does not say which code it covers, so no evidence can be shown to be current.', 'e1'],
    ['untracked', 'There is no record of when src/unknown.ts last changed, so no evidence can be shown to be current.', 'e2'],
    ['failed', 'The latest evidence, e4, failed after e3 passed.', 'e4'],
  ]);
  assert.equal(w.signOff('j/a', 'Russ', '2026-11-27T00:00:00Z').ok, false);
});

test('the walk itself is checked: no empty journeys, no duplicate steps, no evidence for steps that do not exist', () => {
  assert.throws(() => new Walkthrough({ id: 'f', name: 'F' }, [], [], []), /F has no journeys to walk/);
  assert.throws(() => new Walkthrough({ id: 'f', name: 'F' }, [{ id: 'j', goal: 'g', persona: 'p', steps: [] }], [], []), /journey j has no steps/);
  const s = { id: 'a', does: 'd', claim: 'c', covers: ['x'] };
  assert.throws(() => new Walkthrough({ id: 'f', name: 'F' }, [{ id: 'j', goal: 'g', persona: 'p', steps: [s, s] }], [], []), /step j\/a appears twice/);
  assert.throws(() => new Walkthrough({ id: 'f', name: 'F' }, [{ id: 'j', goal: 'g', persona: 'p', steps: [s] }], [ev('e', 'j/zz', '2026-01-01')], []), /evidence e proves j\/zz, which is not a step of F/);
});
