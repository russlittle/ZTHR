import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { features } from '../src/interfaces.ts';
import { manifest } from '../src/manifest.ts';
import { prepare, type Input } from '../src/pipeline.ts';
import { release } from '../src/release.ts';

const fx = (n: string) => readFileSync(new URL(`fixtures/${n}`, import.meta.url), 'utf8');
const files = [{ path: 'rough.md', text: fx('rough.md') }];
const readings = [JSON.parse(fx('reading-a.json')), JSON.parse(fx('reading-b.json'))];
const build = (options?: Input['options']) => {
  const p = prepare({ files, readings, ...(options ? { options } : {}) });
  return { p, m: manifest(p), f: release(p, { revision: 1 }).files };
};
type Catalogue = { usage: string; reports: { id: string; scope: string; runs: boolean; query: string }[]; loop: unknown[] };
const cat = (f: Record<string, string>) => JSON.parse(f['reports/catalogue.json']!) as Catalogue;

test('every feature has its own report, and the system and use as a whole have theirs', () => {
  const { m, f } = build();
  const c = cat(f);
  for (const x of features(m)) assert.ok(c.reports.some((r) => r.id === `feature-${x.id}`), `a report for ${x.id}`);
  for (const id of ['ops-health', 'ops-runs', 'ops-access', 'ops-cost', 'usage-overview', 'usage-by-revision', 'journeys-observed', 'journeys-unmapped', 'people-observed', 'measures-live', 'improvement-brief']) assert.ok(c.reports.some((r) => r.id === id), id);
  for (const r of c.reports) assert.ok(f[r.query], `${r.id} has its query`);
  assert.ok(c.loop.length >= 5, 'findings come back to the intent as proposals');
});

test('counted use is the default, and it names no one and records no assistive technology', () => {
  const { f } = build();
  const plan = JSON.parse(f['analytics/tracking-plan.json']!) as { level: string; keys: string[]; events: { name: string; props: string[] }[]; neverRecorded: string[] };
  assert.equal(plan.level, 'counts');
  assert.ok(!plan.keys.some((k) => /person_key/.test(k)));
  assert.ok(!JSON.stringify(plan.events).includes('assistive'));
  assert.ok(plan.neverRecorded.some((n) => /free text/.test(n)) && plan.neverRecorded.some((n) => /sensitive/.test(n)));
  assert.doesNotMatch(f['reports/people-observed.sql']!, /assistive/);
});

test('with consent, people are followed over time and assistive technology is recorded for those who opt in', () => {
  const { f } = build({ usage: 'consented' });
  const plan = JSON.parse(f['analytics/tracking-plan.json']!) as { keys: string[]; events: { name: string; props: string[] }[] };
  assert.ok(plan.keys.some((k) => /person_key.*consent/.test(k)));
  assert.ok(plan.events.some((e) => e.props.some((p) => /assistive \(opt-in only\)/.test(p))));
  assert.match(f['reports/people-observed.sql']!, /assistive/);
});

test('with use tracking off, only the operations reports run, and nothing is recorded', () => {
  const { f } = build({ usage: 'off' });
  const c = cat(f);
  for (const r of c.reports) assert.equal(r.runs, r.scope === 'operations', r.id);
  assert.deepEqual((JSON.parse(f['analytics/tracking-plan.json']!) as { events: unknown[] }).events, []);
});

test('no report about people shows a group smaller than the small-cell threshold', () => {
  const { f } = build();
  for (const r of cat(f).reports.filter((x) => ['feature', 'journeys', 'usage'].includes(x.scope))) assert.match(f[r.query]!, /having count\([^)]*\) >= 10|having count\(\*\) filter \(where e\.kind = 'journey\.started'\) >= 10/, `${r.id} suppresses small groups`);
});

test('reports are the same bytes for the same spec sheet', () => {
  const a = build({ usage: 'consented', connect: { chat: 'slack' } }).f;
  const b = build({ usage: 'consented', connect: { chat: 'slack' } }).f;
  for (const k of Object.keys(a).filter((x) => x.startsWith('reports/') || x.startsWith('analytics/'))) assert.equal(a[k], b[k], k);
  assert.match(a['reports/catalogue.json']!, /a note in Slack/);
});

test('the reporting suite is in the team minimum on every manifest', () => {
  const { m } = build();
  for (const part of ['Report builder', 'Feature reports', 'Operations reports', 'Journey analytics', 'Improvement brief', 'Report delivery']) assert.ok(m.lines.some((l) => l.part === part && l.floor), part);
});

test('every report query runs, against tables shaped like the query console views', async () => {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  for (const usage of ['counts', 'consented'] as const) {
    const { f } = build({ usage, api: { reach: 'all' } });
    const db = await (await DuckDBInstance.create(':memory:')).connect();
    for (const ddl of [
      'create table events(occurred timestamp, session varchar, person_key varchar, persona varchar, feature varchar, journey varchar, step varchar, kind varchar, ms double, actions int, reason varchar, revision int, device_class varchar, language varchar, assistive varchar)',
      'create table journeys(id varchar, budget_ms int, budget_actions int)',
      'create table walks(session varchar, path varchar, journey varchar, ms double)',
      'create table requests(occurred timestamp, feature varchar, channel varchar, route varchar, ms double, status int)',
      'create table runs(occurred timestamp, kind varchar, name varchar, outcome varchar, created int, changed int, quarantined int)',
      'create table audit(occurred timestamp, kind varchar, feature varchar, reason varchar, actor varchar)',
      'create table measures(balloon int, text varchar, tolerance varchar, value varchar, in_tolerance boolean, floor varchar)',
      'create table costs(occurred timestamp, feature varchar, answered_by varchar, tokens int, cost double)',
    ])
      await db.run(ddl);
    const body = (id: string) => f[`reports/${id}.sql`]!.split('\n').filter((l) => !l.startsWith('--')).join('\n').trim().replace(/;$/, '').replace(/\norder by[^\n]*$/, '');
    for (const v of ['journeys-observed', 'journeys-unmapped', 'measures-live']) await db.run(`create view report_${v.replace(/-/g, '_')} as ${body(v)}`);
    for (const r of cat(f).reports) await assert.doesNotReject(db.run(f[r.query]!), `${usage}: ${r.id} runs`);
  }
});
