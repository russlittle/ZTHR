import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { suggestJourneys } from '../src/journeys.ts';
import { prepare } from '../src/pipeline.ts';
import { review } from '../src/review.ts';

const fx = (n: string) => readFileSync(new URL(`fixtures/${n}`, import.meta.url), 'utf8');
const files = [{ path: 'rough.md', text: fx('rough.md') }];
const readings = [JSON.parse(fx('reading-a.json')), JSON.parse(fx('reading-b.json'))];

test('the review is by rule: the same schematic gets the same grades, and every failed check says where it is fixed', () => {
  const a = review(prepare({ files, readings }));
  assert.deepEqual(review(prepare({ files, readings })), a);
  for (const r of [...a.panel, ...a.people]) for (const c of r.checks) if (!c.holds) assert.ok(c.why.length > 10, `${c.id} says why`);
  assert.deepEqual(a.panel.map((r) => r.id), ['product', 'engineering', 'qa', 'design', 'security']);
});

test('adding the journeys the raters ask for raises QA and design, and the people walk their own journeys', () => {
  const p = prepare({ files, readings });
  const before = review(p);
  const all = suggestJourneys(p).map((s) => s.id);
  const after = review(prepare({ files, readings, journeys: { accepted: all } }));
  const g = (r: typeof before, id: string) => r.panel.find((x) => x.id === id)!.checks.filter((c) => c.holds).length;
  assert.ok(g(after, 'qa') > g(before, 'qa'));
  assert.ok(after.people.every((x) => x.journeys.length > 0));
});

test('tuning a person changes what counts as walked for them, and moves their journeys to the top', () => {
  const p0 = prepare({ files, readings });
  const primary = review(p0).people.find((x) => x.side === 'primary')!;
  const tuned = prepare({ files, readings, people: { tune: { [primary.name]: { device: 'phone', language: 'Spanish' } } } });
  const r = review(tuned).people.find((x) => x.side === 'primary')!;
  assert.ok(r.checks.some((c) => c.id === 'needs-another language' && !c.holds), 'needs a Spanish journey and has none');
  const lang = suggestJourneys(tuned).find((s) => s.kind === 'another language');
  assert.equal(lang?.priority, 'first');
  assert.equal(suggestJourneys(p0).find((s) => s.kind === 'another language')?.priority, 'next');
});

test('planted: a journey walked by someone the schematic never names is a mismatch', () => {
  const r = review(prepare({ files, readings, journeys: { own: [{ goal: 'A visiting auditor reads every record', persona: 'auditor' }] } }));
  assert.ok(r.mismatches.some((m) => /auditor/.test(m.text)));
});

test('who holds the intent is recorded with the release, apart from who will use it', async () => {
  const { release } = await import('../src/release.ts');
  const p = prepare({ files, readings, people: { holder: { name: 'Denise', role: 'Director of Student Success' } } });
  const d = JSON.parse(release(p, { revision: 1 }).files['datum.json']!);
  assert.deepEqual(d.heldBy, { name: 'Denise', role: 'Director of Student Success' });
});
