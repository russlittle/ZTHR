import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AREAS, CHECKS, FLOWS, GROUPS, area, standingOf, type Facts } from '../src/console/plant-model.ts';
import { plantFacts } from '../tools/plant-facts.ts';

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

test('every area has a standing computed from the repository, with one met-or-not per need and one check per need', () => {
  const facts = plantFacts();
  const standing = standingOf(facts);
  for (const a of AREAS) {
    const s = standing[a.key];
    assert.ok(s, `${a.key} has a standing`);
    assert.equal(CHECKS[a.key].length, a.needs.length, `${a.key}: one check per need`);
    assert.equal(s.met.length, a.needs.length, `${a.key}: one answer per need`);
    if (s.lamp === 'go') assert.ok(s.met.every(Boolean), `${a.key} is lit green only with every need met`);
    if (s.lamp === 'off') assert.ok(!s.met.some(Boolean), `${a.key} is off only with nothing met`);
  }
});

test('the standing is counted, never typed: it follows the repository', () => {
  const facts = plantFacts();
  const here = standingOf(facts);
  const fact = (area: keyof typeof here, label: string) => here[area].facts.find(([k]) => k === label)?.[1];
  assert.equal(fact('maintenance', 'Work orders waiting'), facts.queue.workOrders.toLocaleString('en-US'), 'work orders are the files in factory/queue');
  assert.equal(fact('metrology', 'Surviving planted defects'), facts.blocks.survivors.toLocaleString('en-US'), 'survivors are summed from the calibration certificates');
  assert.match(fact('design', 'Blocks built') ?? '', new RegExp(`^${facts.blocks.own}, plus ${facts.blocks.plant} that run the plant`));
  assert.match(fact('design', 'Block tests') ?? '', new RegExp(String(facts.blocks.tests.toLocaleString('en-US'))));
  assert.ok(facts.asOf.revision === null || /^[0-9a-f]{7,}$/.test(facts.asOf.revision), 'the revision is read from git');
  // A different repository gives a different standing.
  const none: Facts = { ...facts, queue: { workOrders: 0, done: 0 }, blocks: { ...facts.blocks, survivors: 0, certified: facts.blocks.own, calibrated: facts.blocks.own } };
  assert.equal(standingOf(none).maintenance.facts.find(([k]) => k === 'Work orders waiting')?.[1], '0');
  assert.notEqual(standingOf(none).metrology.lamp, 'stop', 'a certified lab is not stopped');
});

test('the fleet is not lit unless something is in service, and no area claims what has no record', () => {
  const facts = plantFacts();
  assert.equal(facts.inService, 0, 'nothing from the line is in service in this repository');
  assert.equal(standingOf(facts).fleet.lamp, 'off');
  const live: Facts = { ...facts, inService: 1, has: (p) => facts.has(p) || p === 'intent/factory/fleet/ota.json' };
  assert.notEqual(standingOf(live).fleet.lamp, 'off', 'something in service lights it');
  assert.equal(standingOf(facts).shipping.met[3], false, 'a person approving production needs a release to approve');
  assert.equal(standingOf(facts).process.met[2], false, 'required checks are enforced on the branch only where the live rules are recorded');
});
