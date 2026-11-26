import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { parse } from 'yaml';
import { FRAMEWORKS, coverageOf, forbiddenFields, inventory, scopeOf } from '../src/compliance.ts';
import { objectives } from '../src/delivery.ts';
import { manifest } from '../src/manifest.ts';
import { prepare, type Input } from '../src/pipeline.ts';
import { release } from '../src/release.ts';
import { schemaOf } from '../src/schema.ts';

const intent = (extra = '', info: string[] = ['A bill has an amount, a due date and who it is for.']) => `# Student bill reminders

${extra}

## What I want

- Remind students before bills are due
- When a bill is paid then reminders stop
- Staff should see who is struggling
- Never message during quiet hours

## The information

${info.map((l) => `- ${l}`).join('\n')}
`;
const build = (text: string, options?: Input['options']) => {
  const p = prepare({ files: [{ path: 'i.md', text }], ...(options ? { options } : {}) });
  return { p, s: schemaOf(p), r: release(p, { revision: 1 }) };
};

test('frameworks named in the words are in scope; what it keeps suggests the rest, and nothing is added silently', () => {
  const { p, s } = build(intent('It must meet FERPA and SOC 2.', ['A bill has an amount and who it is for.', 'A student has a diagnosis.']));
  const sc = scopeOf(p, s);
  assert.deepEqual(sc.inScope.map((x) => x.id), ['soc2', 'ferpa']);
  assert.ok(sc.suggested.some((x) => x.id === 'hipaa' && /health/.test(x.why)), 'a diagnosis suggests HIPAA');
  assert.ok(!sc.inScope.some((x) => x.id === 'hipaa'), 'a suggestion is not scope until someone decides');
  const chosen = build(intent('', ['A student has a diagnosis.']), { compliance: ['hipaa'] });
  assert.deepEqual(scopeOf(chosen.p, chosen.s).inScope, [{ id: 'hipaa', why: 'Chosen on the spec sheet' }]);
});

test('every control is met by named evidence, and every evidence source is defined', () => {
  for (const f of FRAMEWORKS.frameworks)
    for (const c of f.controls) {
      assert.ok(c.by.length, `${f.id} ${c.id} names how it is met`);
      for (const b of c.by) assert.ok(FRAMEWORKS.evidence[b], `${f.id} ${c.id}: evidence "${b}" is defined`);
      assert.ok(['factory', 'configured', 'shared', 'platform', 'organization'].includes(coverageOf(c)));
    }
  assert.equal(coverageOf({ id: 'x', title: 'x', by: ['organization'] }), 'organization');
  assert.equal(coverageOf({ id: 'x', title: 'x', by: ['access', 'audit'] }), 'factory');
});

test('the sensitive-data inventory names every sensitive field, its class, frameworks, readers and flows', () => {
  const { p, s, r } = build(intent('It must meet FERPA and SOC 2. It must meet HIPAA.', ['A bill has an amount and who it is for.', 'A student has a phone and a diagnosis.']));
  const inv = inventory(p, s, scopeOf(p, s));
  const dx = inv.find((i) => i.field === 'person.diagnosis')!;
  assert.equal(dx.class, 'health');
  assert.deepEqual([...dx.frameworks].sort(), ['ferpa', 'hipaa', 'soc2']);
  assert.ok(dx.flows.some((f) => /never in production/.test(f)));
  assert.ok(inv.some((i) => i.field === 'bill.amount' && i.class === 'financial'));
  const file = JSON.parse(r.files['compliance/data-inventory.json']!) as { schema: string; schemaHash: string; classes: Record<string, number> };
  assert.equal(file.schema, 'zthr-data-inventory/1');
  assert.equal(file.schemaHash, s.hash);
  assert.equal(file.classes['health'], 1);
});

test('card numbers are refused: the release is not ready until they are gone', () => {
  const { s, r } = build(intent('', ['A payment has an amount, a card number and who it is for.']));
  assert.deepEqual(forbiddenFields(s), ['payment.card_number']);
  assert.ok(r.problems.some((x) => x.includes('card number is never stored')));
});

test('OSCAL for every framework validates against NIST’s OSCAL 1.2.3 component-definition schema', () => {
  const req = createRequire(import.meta.url);
  const Ajv = (req('ajv') as { default: new (o: object) => { compile(s: object): ((d: unknown) => boolean) & { errors?: unknown } } }).default;
  const ajv = new Ajv({ strict: false, allErrors: true });
  (req('ajv-formats') as (a: unknown) => void)(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(new URL('fixtures/oscal_component_schema_1.2.3.json', import.meta.url), 'utf8')));
  const { r } = build(intent(''), { compliance: FRAMEWORKS.frameworks.map((f) => f.id) });
  const docs = Object.keys(r.files).filter((k) => k.startsWith('compliance/oscal/'));
  assert.equal(docs.length, FRAMEWORKS.frameworks.length);
  for (const k of docs) assert.ok(validate(JSON.parse(r.files[k]!)), `${k}: ${JSON.stringify(validate.errors)}`);
  assert.deepEqual(r.files, build(intent(''), { compliance: FRAMEWORKS.frameworks.map((f) => f.id) }).r.files, 'the same bytes every time');
});

test('the gate policy classes every sensitive field and names the scope each action needs', () => {
  const { r } = build(intent('', ['A bill has an amount and who it is for.', 'A student has a diagnosis.']));
  const data = JSON.parse(r.files['compliance/gate/data.json']!) as { fields: Record<string, string>; classes: Record<string, { read: string; production_query: boolean }> };
  assert.equal(data.fields['person.diagnosis'], 'health');
  assert.equal(data.classes['health']!.production_query, false);
  assert.equal(data.classes['financial']!.read, 'data:financial');
  assert.match(r.files['compliance/gate/policy.rego']!, /^package zthr\.gate$/m);
  assert.match(r.files['compliance/gate/policy.rego']!, /^default allow := false$/m, 'deny unless a rule allows');
});

test('the compliance and delivery parts are in the team minimum', () => {
  const { p } = build(intent(''));
  const m = manifest(p);
  for (const part of ['Compliance evidence', 'Sensitive data inventory', 'Data gate', 'Delivery pipeline', 'Service levels and alerts']) assert.ok(m.lines.some((l) => l.part === part && l.floor), part);
});

test('delivery: the Cloud Build pipeline is valid YAML, signs provenance, and gates each stage in order', () => {
  const { r } = build(intent(''));
  const cb = parse(r.files['delivery/gcp/cloudbuild.yaml']!) as { steps: { id: string; waitFor?: string[] }[]; options: Record<string, string>; images: string[] };
  assert.equal(cb.options['requestedVerifyOption'], 'VERIFIED');
  const ids = cb.steps.map((s) => s.id);
  assert.deepEqual(ids, ['build', 'test', 'rehearsal-db', 'data', 'image', 'push', 'scan', 'sbom', 'deploy', 'candidate-url', 'smoke', 'canary']);
  for (const s of cb.steps) for (const w of s.waitFor ?? []) assert.ok(ids.indexOf(w) < ids.indexOf(s.id), `${s.id} waits only on earlier steps`);
  const run = r.files['delivery/gcp/cloudbuild.yaml']!;
  assert.match(run, /--no-traffic/);
  assert.match(run, /--binary-authorization=default/);
  parse(r.files['delivery/gcp/service.yaml']!);
  parse(r.files['delivery/gcp/binauthz-policy.yaml']!);
  assert.doesNotMatch(r.files['delivery/gcp/setup.md']!, /roles\/(owner|editor)\b/, 'no broad roles');
});

test('operations: service levels come from the schematic, every one has alerts, and every alert has a runbook entry', () => {
  const text = intent('It works when: no student loses power over a missed bill');
  const p = prepare({ files: [{ path: 'i.md', text }] });
  const q = p.questions.find((x) => x.id.startsWith('pair:achieved:'))!;
  const p2 = prepare({ files: [{ path: 'i.md', text }], answers: { [q.id]: { pick: 'nine in ten people' } } });
  const { list, latencyMs } = objectives(p2);
  assert.equal(latencyMs, 1000);
  assert.ok(list.some((o) => o.id.startsWith('achieved-') && o.goal === 0.9), 'an outcome target becomes a service level');
  const f = release(p2, { revision: 1 }).files;
  const alerts = JSON.parse(f['ops/alerts.json']!) as { alertPolicies: { displayName: string; documentation: { content: string } }[] };
  for (const o of list) assert.equal(alerts.alertPolicies.filter((a) => a.displayName.startsWith(o.what)).length, 2, `fast and slow burn for ${o.id}`);
  assert.ok(alerts.alertPolicies.some((a) => /must never happen/.test(a.displayName)), 'a forbidden outcome pages');
  const runbook = f['ops/runbook.md']!;
  for (const a of alerts.alertPolicies) {
    const entry = /"([^"]+)"/.exec(a.documentation.content)![1]!;
    assert.ok(runbook.includes(`## ${entry}`), `runbook has "${entry}"`);
  }
});
