import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { factoryIntent, referenceStages, statusOf, studioIntent, tally, type Feed } from '../src/console/feed.ts';
import { headline, journeyDetail, readings } from '../src/console/views.ts';

const feed: Feed = {
  schema: 'zthr-factory/1',
  app: { name: 'Student Advocate', href: '/studentadvocate', evidence: '/reference/factory/index.html' },
  commit: 'abc1234def',
  builtAt: '2026-11-25T00:00:00Z',
  readings: [
    { id: 'tests', label: 'Tests passing', value: 10, of: 10, href: 'tests.html' },
    { id: 'mutation', label: 'Mutation score', value: null, of: 100, floor: 76, unit: '%', href: 'mutation.html' },
  ],
  journeys: [
    { id: 'a', persona: 'maria', goal: 'Maria gets to class on time', phase: 1, modes: ['standard'], channels: ['app'], status: 'pass' },
    { id: 'b', persona: 'luis', goal: 'Luis finds a program', phase: 1, modes: ['standard'], channels: ['app'], status: 'fail' },
    { id: 'c', persona: 'alex', goal: 'Alex files the form', phase: 2, modes: ['brief'], channels: ['text'], status: 'skipped' },
  ],
  phases: [{ n: 1, name: 'Run my day', certified: null, certifiedAt: null, features: [{ name: 'Today', what: 'w', status: 'built', journeys: ['a'] }] }],
  gates: [{ id: 'g', protects: 'p', proof: 'valid' }],
  ratchets: [{ id: 'mutation-score', floor: 76 }],
};

test('a verdict is pass or fail only when the build said so; anything else is not measured', () => {
  assert.equal(statusOf('pass'), 'pass');
  assert.equal(statusOf('fail'), 'fail');
  assert.equal(statusOf('skipped'), 'not measured');
  assert.deepEqual(tally(factoryIntent(feed)), { pass: 1, fail: 1, 'not measured': 1 });
});

test('the measure says what failed and what was not measured, and never calls it working software', () => {
  const h = headline(factoryIntent(feed), feed);
  assert.match(h, /1<\/span> of <span class="num">3<\/span> journeys pass/);
  assert.match(h, /Not working yet: 1 fail, 1 not measured/);
  assert.doesNotMatch(h, /Working software<\/p>/);
});

test('a reading the build did not take is shown as not measured, not as zero', () => {
  const r = readings(feed);
  assert.match(r, /Mutation score.*not measured/s);
  assert.doesNotMatch(r, /Mutation score[^<]*<\/span><span class="rval">[^<]*0%/);
});

test('the studio intent is measured against the factory: unbuilt journeys are not measured', () => {
  const fx = (n: string) => readFileSync(new URL(`fixtures/${n}`, import.meta.url), 'utf8');
  const saved = JSON.stringify({ path: 'rough.md', words: fx('rough.md'), readings: [JSON.parse(fx('reading-a.json')), JSON.parse(fx('reading-b.json'))], answers: {} });
  const row = studioIntent(saved, feed)!;
  assert.ok(row.journeys.length > 0);
  assert.ok(row.journeys.every((j) => j.status === 'not measured'));
  assert.match(journeyDetail(row, row.journeys[0]!.id)!.html, /Not built yet/);
});

test('planted: no saved intent, broken saved state, or an empty one shows nothing rather than failing', () => {
  assert.equal(studioIntent(null, feed), null);
  assert.equal(studioIntent('{not json', feed), null);
  assert.equal(studioIntent(JSON.stringify({ words: '  ' }), feed), null);
});

test('planted: hostile text from a feed is escaped', () => {
  const bad = { ...feed, journeys: [{ ...feed.journeys[0]!, goal: '<img src=x onerror=alert(1)>' }] };
  assert.doesNotMatch(journeyDetail(factoryIntent(bad), 'a')!.html, /<img/);
});

test('the platform: every intent gets a station for each area that reports, and each item a trail through all of them', async () => {
  const { factoryFlow, studioFlow, STAGES } = await import('../src/console/pipeline.ts');
  const f = factoryFlow(feed);
  assert.deepEqual(f.stages.map((s) => s.key), STAGES.map((s) => s.key));
  for (const i of f.items) assert.deepEqual(Object.keys(i.trail).sort(), STAGES.map((s) => s.key).sort());
  const fx = (n: string) => readFileSync(new URL(`fixtures/${n}`, import.meta.url), 'utf8');
  const s = studioFlow(JSON.stringify({ path: 'rough.md', words: fx('rough.md'), readings: [JSON.parse(fx('reading-a.json')), JSON.parse(fx('reading-b.json'))], answers: {} }), feed)!;
  assert.equal(s.stages.find((x) => x.key === 'build')!.light, 'waiting', 'nothing is built until the factory says so');
  assert.ok(s.stages.find((x) => x.key === 'design')!.headline.includes('custom'), 'design reports the build manifest');
});

test('the measure is said honestly: nothing walked is waiting, not zero passing', async () => {
  const { factoryFlow } = await import('../src/console/pipeline.ts');
  const { measureLine } = await import('../src/console/missionViews.ts');
  const none = factoryFlow({ ...feed, journeys: feed.journeys.map((j) => ({ ...j, status: 'not measured' })) });
  assert.match(measureLine(none).big, /waiting to be walked/);
  assert.doesNotMatch(measureLine(none).big, /0 of/);
  const all = factoryFlow({ ...feed, journeys: feed.journeys.map((j) => ({ ...j, status: 'pass' })) });
  assert.equal(measureLine(all).verdict, 'Working software');
  assert.match(measureLine(factoryFlow(feed)).verdict, /Not working yet/);
});

test('planted: a broken or empty saved intent never reaches the platform', async () => {
  const { studioFlow } = await import('../src/console/pipeline.ts');
  assert.equal(studioFlow('{nope', feed), null);
  assert.equal(studioFlow(JSON.stringify({ words: '' }), feed), null);
});

test('each delivery stage is judged only from what the build and the deploy recorded', () => {
  const by = (f: Feed, d: Parameters<typeof referenceStages>[1]) => Object.fromEntries(referenceStages(f, d).map((x) => [x.id, x.status]));
  const green: Feed = { ...feed, readings: [feed.readings[0]!, { id: 'gates', label: 'g', value: 1, of: 1, href: 'gates.html' }, { id: 'mutation', label: 'm', value: 76.1, of: 100, floor: 76, href: 'mutation.html' }], journeys: feed.journeys.map((j) => ({ ...j, status: 'pass' })) };
  const served = { schema: 'zthr-delivery/1' as const, commit: green.commit, verifiedAt: '2026-11-26T17:00:00Z', served: 'https://app' };
  const s = by(green, served);
  assert.equal(s['build'], 'pass');
  assert.equal(s['test'], 'pass');
  assert.equal(s['release'], 'pass');
  for (const id of ['data', 'package', 'deploy', 'canary', 'operate']) assert.equal(s[id], 'not measured', id);
  assert.equal(by(green, { ...served, commit: 'other' })['release'], 'not measured', 'serving another commit is not this build released');
  assert.equal(by(green, null)['release'], 'not measured');
  assert.equal(by(feed, served)['test'], 'fail', 'a failing journey fails the test stage');
  assert.equal(by({ ...green, readings: [{ ...green.readings[2]!, value: 70 }] }, served)['test'], 'fail', 'mutation under its floor fails it');
  assert.equal(by({ ...green, readings: [] }, served)['build'], 'not measured', 'no tests reported, no claim about the build');
});
