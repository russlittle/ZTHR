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
  return { p, m: manifest(p), r: release(p, { revision: 1 }) };
};

test('by default every feature has an API contract, documented and closed', () => {
  const { m, r } = build();
  const fs = features(m);
  assert.ok(fs.length > 0);
  const api = r.files['api/openapi.yaml']!;
  assert.match(api, /^openapi: "3\.2\.0"$/m);
  assert.match(api, /^ {8}"200":$/m, 'response codes are strings, as OpenAPI requires');
  assert.doesNotMatch(api, / $/m, 'no trailing spaces');
  for (const f of fs) assert.ok(api.includes(`"/v1/${f.id}":`), `${f.id} is defined`);
  assert.doesNotMatch(api, /x-zthr-enabled: true/);
  assert.equal(r.files['api/agent-tools.json'], undefined, 'no agent tools unless asked for');
  assert.ok(!m.lines.some((l) => l.part === 'API keys and tokens'), 'nothing that opens the app is on the manifest while it is closed');
});

test('some features: only the ones named are switched on, and their scopes are separate', () => {
  const { m: m0 } = build();
  const [first, second] = features(m0);
  const { m, r } = build({ api: { reach: 'some', features: [first!.id], agents: true } });
  const api = r.files['api/openapi.yaml']!;
  const block = (id: string) => {
    const at = api.indexOf(`"/v1/${id}":`);
    return api.slice(at, api.indexOf('"/v1/', at + 5));
  };
  assert.match(block(first!.id), /x-zthr-enabled: true/);
  if (second) assert.match(block(second.id), /x-zthr-enabled: false/, 'a feature not named stays closed');
  assert.ok(api.includes(`${first!.id}:read`) && api.includes(`${first!.id}:write`));
  const tools = JSON.parse(r.files['api/agent-tools.json']!) as { tools: { scope: string }[] };
  assert.ok(tools.tools.length && tools.tools.every((t) => t.scope.startsWith(`${first!.id}:`)), 'agents reach only what is switched on');
  for (const part of ['API keys and tokens', 'Rate limiting and abuse protection', 'Agent tools (MCP)']) assert.ok(m.lines.some((l) => l.part === part), `${part} is on the manifest`);
});

test('documentation is for two audiences, whatever the spec sheet says', () => {
  for (const o of [undefined, { api: { reach: 'all' as const } }]) {
    const { m, r } = build(o);
    assert.ok(r.files['docs/users/README.md'] && r.files['docs/technical/README.md']);
    for (const f of features(m)) assert.ok(r.files[`docs/users/${f.id}.md`], `a user guide for ${f.id}`);
  }
});

test('training is written for every feature, and only what is switched on is in the course', () => {
  const { m: m0 } = build();
  const [first] = features(m0);
  const off = build().r.files['training/cmi5.xml']!;
  assert.doesNotMatch(off, /<au /);
  const some = build({ training: { reach: 'some', features: [first!.id] } });
  assert.equal((some.r.files['training/cmi5.xml']!.match(/<au /g) ?? []).length, 1);
  for (const f of features(some.m)) assert.ok(some.r.files[`training/${f.id}.md`]);
});

test('the query console is left out of production unless the spec sheet says otherwise', () => {
  const env = (o?: Input['options']) => JSON.parse(build(o).r.files['admin/environments.json']!) as { tools: Record<string, Record<string, boolean>> };
  assert.equal(env().tools['Query console']!['production'], false);
  assert.equal(env().tools['Query console']!['uat'], true);
  assert.equal(env({ admin: { query: 'everywhere' } }).tools['Query console']!['production'], true);
  assert.ok(Object.values(env({ admin: { query: 'off' } }).tools['Query console']!).every((v) => !v));
  for (const o of [undefined, { admin: { query: 'everywhere' as const } }]) {
    const t = env(o).tools;
    assert.equal(t['Test data generator']!['production'], false, 'synthetic records never reach production');
    assert.equal(t['UAT overrides']!['production'], false);
  }
});

test('the admin suite is in the team minimum on every manifest', () => {
  const { m } = build();
  for (const part of ['Feature explorer', 'Record inspector', 'Query console', 'Test data generator', 'UAT overrides', 'Confidence walkthrough', 'Permission explainer', 'Tamper-evident audit chain']) assert.ok(m.lines.some((l) => l.part === part && l.floor), `${part} is inherited`);
});

test('connections are named, never credentials, and the same spec sheet gives the same bytes', () => {
  const o = { connect: { tickets: 'Jira', wiki: 'Confluence', chat: 'slack', feed: true, feedTo: 'bigquery' } };
  const a = build(o).r;
  const c = JSON.parse(a.files['connections.json']!) as { chosen: { id: string }[] };
  assert.deepEqual(c.chosen.map((x) => x.id), ['jira', 'confluence', 'slack', 'bigquery', 'google']);
  for (const id of ['jira', 'confluence', 'slack', 'bigquery', 'google']) assert.ok(a.files[`connections/outbox/${id}.json`], `${id} has an outbox`);
  assert.deepEqual(a.files, build(o).r.files);
});

test('every connector stub writes requests it never sends, with every credential a named placeholder', async () => {
  const { CONNECTORS, outbox } = await import('../src/connectors.ts');
  const { m, p } = build();
  const plan = { title: p.model.title, revision: 1, end: p.model.end, features: features(m).map((f) => ({ id: f.id, gives: f.line.gives, balloons: f.line.balloons, journeys: f.line.journeys })), docs: { 'docs/users/README.md': '# Guide\n\nHello.' } };
  assert.ok(CONNECTORS.length >= 20);
  for (const x of CONNECTORS) {
    const box = JSON.parse(outbox(x, plan)) as { sent: boolean; requests: { url: string; headers: Record<string, string> }[] };
    assert.equal(box.sent, false);
    assert.ok(box.requests.length > 0, `${x.id} plans at least one request`);
    for (const r of box.requests) {
      assert.match(r.url, /^(https:\/\/|\{\{(config|secret)\.)/, `${x.id} speaks HTTPS, or to an address set where it runs`);
      for (const [k, v] of Object.entries(r.headers)) if (/^authorization$/i.test(k)) assert.match(v, /\{\{secret\.[A-Z_]+\}\}/, `${x.id} carries no credential, only the name of one`);
    }
    for (const n of x.secrets) assert.match(n, /^[A-Z][A-Z0-9_]+$/);
    assert.ok(x.reference.startsWith('https://'), `${x.id} points at the vendor's reference`);
  }
});

test('people sign in with Google unless the spec sheet says otherwise', () => {
  const { r } = build();
  const c = JSON.parse(r.files['connections.json']!) as { chosen: { id: string }[] };
  assert.deepEqual(c.chosen.map((x) => x.id), ['google']);
  assert.ok(build().m.lines.some((l) => l.part === 'Single sign-on' && l.why.some((w) => /Google/.test(w.text))));
});

test('report a problem: on by default, its records and parts follow the spec sheet, and it is switchable at runtime', async () => {
  const { schemaOf } = await import('../src/schema.ts');
  const on = build();
  assert.ok(schemaOf(on.p).entities.some((e) => e.name === 'Ticket'), 'tickets are kept when it is on');
  assert.ok(on.m.lines.some((l) => l.part === 'Triage board'));
  const env = JSON.parse(on.r.files['admin/environments.json']!) as { tools: Record<string, Record<string, boolean>>; runtimeSwitches: Record<string, string> };
  assert.equal(env.tools['Report a problem']!['production'], true);
  assert.match(env.runtimeSwitches['Report a problem']!, /feedback\.enabled/);
  const testing = build({ feedback: 'testing' });
  const env2 = JSON.parse(testing.r.files['admin/environments.json']!) as { tools: Record<string, Record<string, boolean>> };
  assert.equal(env2.tools['Report a problem']!['production'], false);
  assert.equal(env2.tools['Report a problem']!['uat'], true);
  const off = build({ feedback: 'off' });
  assert.ok(!schemaOf(off.p).entities.some((e) => e.name === 'Ticket'), 'no tickets when it is off');
  assert.ok(!off.m.lines.some((l) => l.part === 'Report a problem'));
  const ticket = schemaOf(on.p).entities.find((e) => e.name === 'Ticket')!;
  assert.equal(ticket.fields.find((f) => f.key === 'what_happened')!.sensitivity, 'private', 'what people write is private');
});
