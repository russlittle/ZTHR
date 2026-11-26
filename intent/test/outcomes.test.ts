import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { suggestJourneys } from '../src/journeys.ts';
import { manifest } from '../src/manifest.ts';
import { framework, PLATFORM } from '../src/outcomes.ts';
import { prepare, type Input } from '../src/pipeline.ts';
import { release } from '../src/release.ts';

const fx = (n: string) => readFileSync(new URL(`fixtures/${n}`, import.meta.url), 'utf8');
const files = [{ path: 'rough.md', text: fx('rough.md') }];
const readings = [JSON.parse(fx('reading-a.json')), JSON.parse(fx('reading-b.json'))];
const build = (extra: Partial<Input> = {}) => {
  const p = prepare({ files, readings, ...extra });
  return { p, m: manifest(p), fw: framework(p, manifest(p)) };
};

test('every outcome is assessed by a journey before release and observed in use after, each with criteria and evidence', () => {
  const { fw } = build();
  assert.ok(fw.outcomes.length > 0);
  for (const o of fw.outcomes) {
    const walk = o.assessments.find((a) => a.method === 'journey walk')!;
    const use = o.assessments.find((a) => a.method === 'observed in use')!;
    assert.equal(walk.when, 'before release');
    assert.equal(use.when, 'in use');
    for (const a of o.assessments) {
      assert.ok(a.criteria.length > 0, `${a.id} has criteria`);
      assert.ok(a.evidence.length > 0, `${a.id} links its evidence`);
    }
    assert.ok(walk.criteria.some((c) => c.startsWith('Never: ')), 'what must never happen is a criterion');
  }
});

test('the target is set before building: until it is, the framework is incomplete, a question is open, and the release is not ready', () => {
  const { p, fw } = build();
  const o = fw.outcomes[0]!;
  assert.equal(o.complete, false);
  assert.match(o.missing.join(), /target/);
  const q = p.questions.find((x) => x.id.startsWith('pair:achieved:'))!;
  assert.ok(q, 'the target is asked');
  const r = release(p, { revision: 1 });
  assert.ok(r.problems.some((x) => x.includes('needs a target')));

  const set = build({ answers: { [q.id]: { pick: 'nine in ten people' } } });
  const o2 = set.fw.outcomes.find((x) => x.balloon === o.balloon) ?? set.fw.outcomes[0]!;
  const use = o2.assessments.find((a) => a.method === 'observed in use')!;
  assert.equal(use.passing, 'nine in ten people achieve it');
  assert.ok(!set.p.questions.some((x) => x.id === q.id));
  assert.ok(JSON.parse(release(set.p, { revision: 1 }).files['ratchets.json']!).some((r: { metric: string; floor: number }) => r.metric.startsWith('Achieved in use:') && r.floor === 90), 'the target becomes a ratchet floor');
});

test('every platform outcome is mapped across every feature, introduced by default', () => {
  const { fw } = build();
  assert.equal(fw.map.length, fw.features.length * PLATFORM.outcomes.length);
  assert.ok(fw.map.every((c) => ['I', 'R', 'M'].includes(c.level) && c.because.length > 0));
  assert.ok(fw.platform.every((x) => x.highest !== 'M'), 'nothing is mastered until a journey proves it');
});

test('a journey that proves a platform outcome masters it in the feature it walks', () => {
  const base = build();
  const low = suggestJourneys(base.p).find((s) => s.kind === 'low vision');
  assert.ok(low, 'low vision is suggested');
  const after = build({ journeys: { accepted: [low!.id] } });
  const acc = after.fw.platform.find((x) => x.id === 'accessible')!;
  assert.equal(acc.highest, 'M');
  assert.ok(after.fw.map.some((c) => c.platform === 'accessible' && c.level === 'M' && /low vision/.test(c.because)));
});

test('the framework travels in the package as data, with its documents built from it', () => {
  const { p } = build();
  const f = release(p, { revision: 1 }).files;
  const j = JSON.parse(f['outcomes/framework.json']!) as { schema: string; outcomes: unknown[]; map: unknown[] };
  assert.equal(j.schema, 'zthr-outcome-framework/1');
  assert.ok(j.outcomes.length && j.map.length);
  assert.match(f['outcomes/framework.md']!, /erDiagram/);
  assert.match(f['outcomes/map.md']!, /\| \*\*Highest\*\* \|/);
  assert.deepEqual(f, release(p, { revision: 1 }).files);
});
