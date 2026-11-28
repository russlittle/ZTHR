import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Gate, inventory, mask, type Decision, type Field } from './index.ts';

const fields: Field[] = [
  { collection: 'users', field: 'id', level: 'internal' },
  { collection: 'users', field: 'email', level: 'personal' },
  { collection: 'users', field: 'password_hash', level: 'secret' },
  { collection: 'users', field: 'plan', level: 'internal' },
  { collection: 'users', field: 'phone', level: 'internal' },
  { collection: 'users', field: 'nickname' },
];

test('the inventory groups by level and flags unclassified and under-classified fields', () => {
  const i = inventory(fields);
  assert.deepEqual(i.byLevel.secret, ['users.password_hash']);
  assert.deepEqual(i.findings, ['users.phone is internal but its name suggests personal', 'users.nickname has no classification']);
});

test('the gate allows, masks or denies each field by destination, with the rule, and keeps evidence', () => {
  const g = new Gate(fields, [
    { destination: 'staging', allow: 'internal', mask: 'personal', why: 'staging gets masked personal data and nothing more sensitive' },
    { destination: /^vendor:/, allow: 'public', why: 'outside services get nothing we have not agreed to share' },
  ], () => new Date('2026-11-26T00:00:00Z'));
  const rows = g.apply('users', [{ id: 1, email: 'ana@example.org', password_hash: 'x', plan: 'pro', nickname: 'A' }], 'staging', 'ci');
  assert.deepEqual(rows, [{ id: 1, email: 'a••@e••••••.org', plan: 'pro' }]);
  assert.deepEqual(g.decide('users', ['email'], 'vendor:mailer', 'ana').map((v) => v.action), ['deny']);
  assert.deepEqual(g.decide('users', ['id'], 'laptop', 'ana')[0], { field: 'id', action: 'deny', level: 'internal', rule: 'no rule for laptop' });
  assert.equal(g.evidence.length, 3);
  assert.deepEqual(g.evidence[0]!.verdicts.find((v) => v.field === 'nickname'), { field: 'nickname', action: 'deny', level: 'unclassified', rule: 'unclassified fields never leave' });
});

test('masking keeps the shape and hides the content', () => {
  assert.equal(mask('+1 937 555 0142'), '•••••••••42');
  assert.equal(mask('Ana Okafor'), 'A•••••••••');
  assert.equal(mask(null), null);
});

test('a field classified twice is held to the higher level, and the inventory says so', () => {
  const twice: Field[] = [{ collection: 'users', field: 'notes', level: 'sensitive' }, { collection: 'users', field: 'notes', level: 'public' }];
  const g = new Gate(twice, [{ destination: 'vendor:crm', allow: 'public', why: 'only public data leaves' }]);
  assert.deepEqual(g.decide('users', ['notes'], 'vendor:crm', 'ci').map((v) => [v.action, v.level]), [['deny', 'sensitive']]);
  assert.deepEqual(inventory(twice).findings, ['users.notes is classified twice (sensitive, public); the higher level holds']);
});

test('a destination pattern with the global flag decides the same way every time', () => {
  const g = new Gate(fields, [{ destination: /^staging/g, allow: 'internal', why: 'staging' }]);
  const a = g.decide('users', ['plan'], 'staging', 'ci')[0]!.action;
  const b = g.decide('users', ['plan'], 'staging', 'ci')[0]!.action;
  assert.deepEqual([a, b], ['allow', 'allow']);
});

test('evidence keeps the most recent decisions in memory and hands every one to the sink', () => {
  const stored: Decision[] = [];
  const g = new Gate(fields, [{ destination: 'staging', allow: 'internal', why: 'staging' }], () => new Date('2026-11-26T00:00:00Z'), { keep: 2, sink: (e) => void stored.push(e) });
  for (let i = 0; i < 4; i++) g.decide('users', ['plan'], 'staging', `job-${i}`);
  assert.deepEqual(g.evidence.map((e) => e.who), ['job-2', 'job-3']);
  assert.deepEqual(stored.map((e) => e.who), ['job-0', 'job-1', 'job-2', 'job-3']);
  assert.deepEqual([g.decisions.recorded, g.decisions.handed, g.decisions.evicted], [4, 4, 2]);
});
