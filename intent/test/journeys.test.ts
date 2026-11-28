import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { graph, instruments, uncovered } from '../src/graph.ts';
import { suggestJourneys } from '../src/journeys.ts';
import { prepare } from '../src/pipeline.ts';
import { gauges, release } from '../src/release.ts';

const fx = (n: string) => readFileSync(new URL(`fixtures/${n}`, import.meta.url), 'utf8');
const files = [{ path: 'rough.md', text: fx('rough.md') }];
const readings = [JSON.parse(fx('reading-a.json')), JSON.parse(fx('reading-b.json'))];

/** The factory's own card rules (packages/intent JourneyCard), restated so a suggestion can never break them. */
const factoryAccepts = (c: ReturnType<typeof gauges>[number]) =>
  /^[a-z0-9-]+$/.test(c.id) &&
  c.goal.length >= 10 &&
  c.forbidden.length >= 1 &&
  c.phase >= 1 &&
  c.phase <= 9 &&
  c.budget.actions > 0 &&
  c.modes.every((m) => ['brief', 'standard', 'walk-me-through'].includes(m)) &&
  c.channels.every((m) => ['app', 'text'].includes(m));

test('suggested journeys are many, by rule, each traced, and every one is a card the factory accepts', () => {
  const p = prepare({ files, readings });
  const s = suggestJourneys(p);
  assert.ok(s.length >= 8, `only ${s.length} suggestions`);
  assert.deepEqual(suggestJourneys(prepare({ files, readings })), s, 'the same datum suggests the same journeys');
  assert.equal(new Set(s.map((x) => x.id)).size, s.length, 'no two share an id');
  for (const x of s) assert.ok(factoryAccepts(x.card), `${x.id} breaks the factory card rules`);
});

test('a journey is in the package only once the person adds it, with their own beside it', () => {
  const p = prepare({ files, readings });
  const s = suggestJourneys(p);
  const before = gauges(p).length;
  const own = { goal: 'Find out what is owed this week in one look', persona: 'student' };
  const q = prepare({ files, readings, journeys: { accepted: [s[0]!.id], own: [own] } });
  const g = gauges(q);
  assert.equal(g.length, before + 2);
  assert.ok(g.every(factoryAccepts));
  const r = release(q, { revision: 1 });
  assert.ok(r.files[`gauges/${s[0]!.id}.yaml`]);
  assert.ok(Object.keys(r.files).some((f) => f.startsWith('gauges/own-')));
});

test('planted: an own journey too short to judge is not added; an unknown suggestion id adds nothing', () => {
  const p = prepare({ files, readings });
  const q = prepare({ files, readings, journeys: { accepted: ['no-such-journey'], own: [{ goal: 'go', persona: 'x' }] } });
  assert.equal(gauges(q).length, gauges(p).length);
});

test('the graph: every edge joins real nodes, every instrument kind is counted, and gaps are named', () => {
  const p = prepare({ files, readings });
  const g = graph(p);
  const ids = new Set(g.nodes.map((n) => n.id));
  for (const e of g.edges) assert.ok(ids.has(e.from) && ids.has(e.to), `${e.from} to ${e.to}`);
  assert.equal(instruments(g).find((i) => i.kind === 'gauge')!.count, gauges(p).length);
  for (const u of uncovered(g)) assert.ok(u.why.length > 5);
});
