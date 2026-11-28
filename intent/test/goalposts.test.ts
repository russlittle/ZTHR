/**
 * An agent cannot move its own goalposts. Planted: an agent's commit loosens a locked journey card and rewrites the
 * lock to match, so the lock's own hash check passes; the gate must refuse it because no person signed it. And the
 * rule must not pass by default when the base (the deployed commit) predates it.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { gather, judge, RULE_FILE } from '../src/governance/goalposts.ts';
import { main } from '../tools/goalposts.ts';
import { testKey, testRepo, type TestKey } from './governance-kit.ts';

const card = (budget: number, forbidden: string[]) => `id: p2-bus-to-class\npersona: a student who rides the bus\ngoal: get to class on time\nbudget:\n  actions: ${budget}\nforbidden:\n${forbidden.map((f) => `  - ${f}`).join('\n')}\n`;
const lockOf = (text: string) => `${JSON.stringify({ cards: { 'p2-bus-to-class': createHash('sha256').update(text).digest('hex') } }, null, 2)}\n`;

function plant(opts: { rule?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zthr-goalposts-'));
  const r = testRepo(dir);
  const russ = testKey();
  const write = (p: string, body: string) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  };
  const tight = card(5, ['the student is shown another student’s schedule', 'a bus time older than ten minutes is shown as live']);
  write('control/journeys/p2-bus-to-class.yaml', tight);
  write('control/lock.json', lockOf(tight));
  write('control/people.json', JSON.stringify({ people: ['russ'], keys: { russ: [russ.line] } }));
  write('apps/bus.ts', 'export const bus = 1;\n');
  if (opts.rule !== false) write(RULE_FILE, '// the rule\n');
  const base = r.commit('the locked journeys, signed by a person', russ, 'russ <russ@zthr>');
  /** The agent's change: loosen the card (more actions, a forbidden outcome gone) and rewrite the lock to match. */
  const loosen = (key?: TestKey, extra?: () => void) => {
    const loose = card(12, ['the student is shown another student’s schedule']);
    write('control/journeys/p2-bus-to-class.yaml', loose);
    write('control/lock.json', lockOf(loose));
    extra?.();
    return r.commit('Relax the bus journey so the walk passes', key);
  };
  const work = (key?: TestKey) => {
    write('apps/bus.ts', `export const bus = ${Math.random()};\n`);
    return r.commit('Show the next bus', key);
  };
  return { dir, r, russ, base, loosen, work, write };
}

test('planted: an agent loosens a locked card and rewrites the lock to match; the gate refuses it', () => {
  const p = plant();
  const head = p.loosen();
  const j = judge(gather(p.dir, p.base, head));
  assert.equal(j.ok, false);
  assert.match(j.problems.join('\n'), /changes control\/journeys\/p2-bus-to-class\.yaml, control\/lock\.json, and is not a person's: unsigned/);
});

test('planted: the agent signs with its own key and lists that key in the same commit; still refused', () => {
  const p = plant();
  const agent = testKey();
  const head = p.loosen(agent, () => p.write('control/people.json', JSON.stringify({ people: ['russ', 'agent'], keys: { russ: [p.russ.line], agent: [agent.line] } })));
  const j = judge(gather(p.dir, p.base, head));
  assert.equal(j.ok, false, 'keys come from the base, never from the range being judged');
  assert.match(j.problems.join('\n'), /control\/people\.json.*not a listed key/);
  const env = judge(gather(p.dir, p.base, head, agent.line));
  assert.equal(env.ok, true, 'only an administrator’s ZTHR_PERSON_KEYS could make it pass: the trust root is outside the repository');
  assert.equal(judge(gather(p.dir, p.base, head, p.russ.line)).ok, false);
});

test('the person signing the same loosening passes, and ordinary work needs no signature', () => {
  const p = plant();
  const w1 = p.work();
  const signed = p.loosen(p.russ);
  const w2 = p.work();
  const j = judge(gather(p.dir, p.base, w2));
  assert.ok(j.ok, j.problems.join('\n'));
  assert.ok(j.notes.some((n) => n.startsWith(signed.slice(0, 12)) && /signed by SHA256:/.test(n)));
  assert.ok(!j.notes.some((n) => n.startsWith(w1.slice(0, 12))), 'a commit touching nothing protected is not judged');
});

test('planted: when the base predates the rule, nothing passes by default', () => {
  const p = plant({ rule: false });
  const unsigned = p.work();
  const j = judge(gather(p.dir, p.base, unsigned));
  assert.equal(j.ok, false, 'the reference rule exits 0 here ("it applies from the next deploy"); this one does not');
  assert.ok(j.notes.some((n) => /predates this rule, so nothing passes by default/.test(n)));
  assert.match(j.problems.join('\n'), /lands while the base predates the rule, and is not a person's/);
  const p2 = plant({ rule: false });
  p2.write(RULE_FILE, '// the rule arrives\n');
  const bringsRule = p2.r.commit('Bring the goalposts rule', p2.russ, 'russ <russ@zthr>');
  assert.ok(judge(gather(p2.dir, p2.base, bringsRule)).ok, 'the first push that carries the rule passes when a person signed it');
  const next = p2.work();
  assert.ok(judge(gather(p2.dir, bringsRule, next)).ok, 'and from then on ordinary work flows');
});

test('planted: no base, no key, or rewritten history is a failure, not a pass', () => {
  const p = plant();
  const head = p.work();
  assert.match(judge(gather(p.dir, null, head)).problems.join(), /no base/);
  const noKeys = plant();
  noKeys.write('control/people.json', JSON.stringify({ people: ['russ'] }));
  const b2 = noKeys.r.commit('people without keys', noKeys.russ);
  const h2 = noKeys.work();
  assert.match(judge(gather(noKeys.dir, b2, h2)).problems.join(), /no person's signing key/);
  assert.match(judge(gather(p.dir, p.base, head, 'not a key')).problems.join(), /no person's signing key \(ZTHR_PERSON_KEYS holds no Ed25519 key\)/, 'a garbled trust root does not fall back to the repository');
  p.r.git(['checkout', '-q', '--orphan', 'other']);
  const orphan = p.work();
  assert.match(judge(gather(p.dir, p.base, orphan)).problems.join(), /not an ancestor/);
});

test('planted: a merge is judged by what it adds; a protected change made in the merge itself is refused', () => {
  const p = plant();
  p.r.git(['checkout', '-q', '-b', 'person']);
  p.loosen(p.russ);
  p.r.git(['checkout', '-q', 'main']);
  p.work();
  p.r.git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-edit', '--no-gpg-sign', 'person']);
  const merged = p.r.git(['rev-parse', 'HEAD']);
  assert.ok(judge(gather(p.dir, p.base, merged)).ok, 'an unsigned merge of a person’s signed change passes');
  p.r.git(['checkout', '-q', '-b', 'evil', p.base]);
  p.r.git(['commit', '-q', '--allow-empty', '-m', 'side']);
  p.r.git(['checkout', '-q', 'main']);
  p.r.git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-commit', '--no-ff', 'evil']);
  p.write('control/lock.json', '{"cards":{}}\n');
  p.r.git(['add', '-A']);
  p.r.git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--no-gpg-sign', '-m', 'Merge evil']);
  const evil = p.r.git(['rev-parse', 'HEAD']);
  const j = judge(gather(p.dir, merged, evil));
  assert.equal(j.ok, false);
  assert.match(j.problems.join(), /Merge evil.*control\/lock\.json/);
});

test('the command fails on the planted loosening and passes on signed work', () => {
  const p = plant();
  const quiet = console.log;
  console.log = () => {};
  try {
    const head = p.loosen();
    assert.equal(main(['--repo', p.dir, '--base', p.base, '--head', head], {}), 1);
    assert.equal(main(['--repo', p.dir, '--head', head], {}), 1, 'with no base and no zthr-anchor tag, it fails');
    p.r.git(['reset', '-q', '--hard', p.base]);
    const signed = p.loosen(p.russ);
    p.r.git(['tag', 'zthr-anchor', p.base]);
    assert.equal(main(['--repo', p.dir, '--head', signed], {}), 0, 'the zthr-anchor tag is the base when none is given');
  } finally {
    console.log = quiet;
  }
});
