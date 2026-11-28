import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AREAS, FLOWS, GROUPS, area } from '../src/console/plant-model.ts';

test('every area belongs to a group, and every reference names an area that exists', () => {
  const keys = new Set(AREAS.map((a) => a.key));
  assert.equal(keys.size, AREAS.length, 'area keys are unique');
  for (const a of AREAS) {
    assert.ok(GROUPS.some((g) => g.key === a.group), `${a.key} has a known group`);
    if (a.inside) assert.ok(keys.has(a.inside), `${a.key} sits inside ${a.inside}`);
    for (const s of a.serves ?? []) assert.ok(keys.has(s), `${a.key} serves ${s}`);
    assert.ok(a.needs.length > 0, `${a.key} says what it needs`);
  }
  for (const f of FLOWS) assert.ok(keys.has(f.from) && keys.has(f.to), `${f.from} → ${f.to}`);
});

test('work flows from the intent studio to the field without a gap, and what fails goes back for rework', () => {
  const next = (k: string) => FLOWS.filter((f) => f.from === k && f.kind !== 'rework').map((f) => f.to);
  const path = ['intent'];
  for (let k = 'intent'; k !== 'fleet'; ) {
    const n = next(k).filter((x) => x !== 'rework');
    assert.equal(n.length >= 1, true, `${k} hands work on`);
    k = n.includes('shipping') ? 'shipping' : n[0]!;
    path.push(k);
    assert.ok(path.length < 12, 'the flow does not loop forever');
  }
  assert.deepEqual(path, ['intent', 'design', 'process', 'factory', 'qa', 'shipping', 'fleet']);
  assert.ok(FLOWS.some((f) => f.from === 'qa' && f.to === 'rework' && f.kind === 'rework'), 'QA sends failures to rework');
  assert.ok(FLOWS.some((f) => f.from === 'rework' && f.to === 'qa'), 'rework goes back through QA');
  assert.ok(FLOWS.some((f) => f.from === 'fleet' && f.to === 'mission' && f.kind === 'report'), 'the field reports to the office');
});

test('mission control runs the plant rather than standing in the flow, and support crews serve their parts', () => {
  assert.ok(!FLOWS.some((f) => f.kind === 'work' && (f.from === 'mission' || f.to === 'mission')), 'no work step passes through mission control');
  assert.equal(area('lines').inside, 'mission');
  assert.equal(area('intent').inside, 'lines');
  assert.deepEqual(area('maintenance').serves, ['factory']);
  assert.deepEqual(area('metrology').serves, ['qa']);
  assert.deepEqual(area('deploy').serves, ['shipping', 'fleet']);
  assert.ok(area('process').serves?.includes('factory'), 'manufacturing engineering keeps improving the line');
  assert.throws(() => area('nowhere'), /no area/);
});

test('every area has a standing, with one met-or-not per need', async () => {
  const { STANDING } = await import('../src/console/plant-model.ts');
  for (const a of AREAS) {
    const s = STANDING[a.key];
    assert.ok(s, `${a.key} has a standing`);
    assert.equal(s.met.length, a.needs.length, `${a.key}: one answer per need`);
    if (s.lamp === 'go') assert.ok(s.met.filter((m) => !m).length <= 1, `${a.key} is lit green with at most one need unmet`);
  }
});
