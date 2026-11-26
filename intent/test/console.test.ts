import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { factoryIntent, statusOf, studioIntent, tally, type Feed } from '../src/console/feed.ts';
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
