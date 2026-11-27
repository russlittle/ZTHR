import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Forbidden, check, decide, filter, matrix, require, rolesOf, type Policy } from './index.ts';

const P: Policy = {
  roles: { student: { label: 'Student' }, advisor: { label: 'Advisor' }, lead: { label: 'Lead advisor', inherits: ['advisor'] }, admin: { label: 'Admin' } },
  grants: [
    { role: 'student', kind: 'note', actions: ['read'], when: [{ field: 'student', equalsSubject: 'id' }, { field: 'visibility', in: ['shared'] }] },
    { role: 'advisor', kind: 'note', actions: ['read', 'write'], when: [{ field: 'team', equalsSubject: 'teams' }] },
    { role: 'lead', kind: 'note', actions: ['delete'], when: [{ field: 'team', equalsSubject: 'teams' }] },
    { role: 'admin', kind: 'note', actions: ['read'] },
    { role: 'admin', kind: 'note', actions: ['read'], deny: true, when: [{ field: 'sensitivity', in: ['health'] }], note: 'health notes need break-glass' },
  ],
};

const ana = { id: 'ana', roles: ['student'] };
const ben = { id: 'ben', roles: ['advisor'], attrs: { teams: ['north'] } };
const lee = { id: 'lee', roles: ['lead'], attrs: { teams: ['north', 'east'] } };
const adm = { id: 'adm', roles: ['admin'] };
const shared = { student: 'ana', visibility: 'shared', team: 'north' };
const priv = { student: 'ana', visibility: 'advisors', team: 'north' };

test('grants are narrowed by rules on the record, and inherited roles carry their grants', () => {
  assert.equal(decide(P, ana, 'read', 'note', shared).allowed, true);
  assert.equal(decide(P, ana, 'read', 'note', priv).allowed, false);
  assert.equal(decide(P, ben, 'write', 'note', priv).allowed, true);
  assert.equal(decide(P, ben, 'write', 'note', { ...priv, team: 'south' }).allowed, false);
  assert.deepEqual([...rolesOf(P, lee)].sort(), ['advisor', 'lead']);
  assert.equal(decide(P, lee, 'read', 'note', { ...priv, team: 'east' }).allowed, true);
  assert.equal(decide(P, ben, 'delete', 'note', priv).allowed, false);
});

test('a refusal wins over any grant', () => {
  assert.equal(decide(P, adm, 'read', 'note', priv).allowed, true);
  const d = decide(P, adm, 'read', 'note', { ...priv, sensitivity: 'health' });
  assert.equal(d.allowed, false);
  assert.match(d.because, /health notes need break-glass/);
});

test('the explanation comes from the evaluator, naming the role and the field that decided it', () => {
  assert.equal(decide(P, ana, 'read', 'note', shared).because, 'the Student role allows read on note because student is theirs and visibility is one of shared');
  assert.equal(decide(P, ana, 'read', 'note', priv).because, 'the Student role would, but student is theirs and visibility is not one of shared');
  assert.equal(decide(P, ben, 'delete', 'note', priv).because, 'none of their roles allows delete on note; Lead advisor would');
  assert.equal(decide(P, ben, 'fly', 'note').because, 'no role allows fly on note');
  assert.throws(() => require(P, ana, 'write', 'note', shared), Forbidden);
});

test('lists are filtered by the same rules; the matrix and policy checks are generated from the declaration', () => {
  assert.deepEqual(filter(P, ana, 'read', 'note', [shared, priv, { ...shared, student: 'cy' }]), [shared]);
  assert.equal(matrix(P).length, 5);
  assert.equal(matrix(P)[1]!.scope, 'team = their teams');
  assert.deepEqual(check({ roles: { a: { label: 'A', inherits: ['b'] }, b: { label: 'B', inherits: ['a'] } }, grants: [{ role: 'zz', kind: 'x', actions: ['read'] }] }), ['a grant names the role "zz", which is not declared', 'the role "a" inherits itself', 'the role "b" inherits itself']);
});

test('a rule comparing with a subject attribute never holds because both sides are missing', () => {
  const noTeam = { id: 'cy', roles: ['advisor'] };
  assert.equal(decide(P, noTeam, 'write', 'note', { student: 'ana' }).allowed, false, 'no team on either side is not the same team');
  assert.equal(decide(P, noTeam, 'write', 'note').allowed, false);
  const Q: Policy = { roles: { r: { label: 'R' } }, grants: [{ role: 'r', kind: 'doc', actions: ['read'] }, { role: 'r', kind: 'doc', actions: ['read'], deny: true, when: [{ field: 'region', equalsSubject: 'region' }] }] };
  assert.equal(decide(Q, { id: 'x', roles: ['r'] }, 'read', 'doc', {}).allowed, false, 'a refusal that cannot be ruled out still refuses');
});

test('role names that are inherited object properties are neither roles nor declared', () => {
  assert.deepEqual([...rolesOf(P, { id: 'x', roles: ['constructor', 'toString', '__proto__'] })], []);
  assert.deepEqual(check({ roles: {}, grants: [{ role: 'constructor', kind: 'x', actions: ['read'] }] }), ['a grant names the role "constructor", which is not declared']);
});
