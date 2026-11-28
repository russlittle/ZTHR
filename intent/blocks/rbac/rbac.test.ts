import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Forbidden, check, decide, filter, matrix, require, rolesOf, type Condition, type Policy } from './index.ts';

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

const R: Policy['roles'] = { r: { label: 'R' } };
const who = { id: 'u', roles: ['r'] };

test('a rule that holds for any record says so, for a grant and for a refusal', () => {
  const allow: Policy = { roles: R, grants: [{ role: 'r', kind: 'doc', actions: ['read'], when: [{ any: true }] }] };
  const d = decide(allow, who, 'read', 'doc', { x: 1 });
  assert.equal(d.allowed, true);
  assert.equal(d.because, 'the R role allows read on doc because any record');
  const deny: Policy = { roles: R, grants: [...allow.grants, { role: 'r', kind: 'doc', actions: ['read'], deny: true, when: [{ any: true }], note: 'frozen' }] };
  const e = decide(deny, who, 'read', 'doc', {});
  assert.equal(e.allowed, false);
  assert.equal(e.because, 'the R role is refused read on doc where any record (frozen)');
});

test('a record field is read from the record itself, never from what every object inherits', () => {
  const inheritedOnly: Policy = { roles: R, grants: [{ role: 'r', kind: 'doc', actions: ['read'], when: [{ field: 'constructor', in: [Object] }] }] };
  assert.equal(decide(inheritedOnly, who, 'read', 'doc', {}).allowed, false, 'an empty record has no constructor field');
  const own: Policy = { roles: R, grants: [{ role: 'r', kind: 'doc', actions: ['read'], when: [{ field: 'constructor', in: ['x'] }] }] };
  assert.equal(decide(own, who, 'read', 'doc', { constructor: 'x' }).allowed, true, 'a record may have a field of its own with such a name');
  assert.equal(decide(own, who, 'read', 'doc', { constructor: 'y' }).allowed, false);
});

test('when the record or the subject lacks what a rule compares, a grant is not given and a refusal still applies, saying so', () => {
  const mine: Policy = { roles: R, grants: [{ role: 'r', kind: 'doc', actions: ['read'], when: [{ field: 'owner', equalsSubject: 'id' }] }] };
  const unknownOwner = 'the R role would, but whether owner is theirs is not known';
  assert.equal(decide(mine, who, 'read', 'doc', {}).because, unknownOwner);
  assert.equal(decide(mine, who, 'read', 'doc', { owner: null }).because, unknownOwner);
  assert.equal(decide(mine, who, 'read', 'doc', { owner: 'u' }).allowed, true);
  assert.equal(decide(mine, who, 'read', 'doc', { owner: 'z' }).because, 'the R role would, but owner is not theirs');

  const team: Policy = { roles: R, grants: [{ role: 'r', kind: 'doc', actions: ['read'], when: [{ field: 'team', equalsSubject: 'team' }] }] };
  const unknownTeam = 'the R role would, but whether team is their team is not known';
  assert.equal(decide(team, who, 'read', 'doc', { team: 'x' }).because, unknownTeam, 'the subject has no team');
  assert.equal(decide(team, { ...who, attrs: { team: 'x' } }, 'read', 'doc', {}).because, unknownTeam, 'the record has no team');
  assert.equal(decide(team, { ...who, attrs: { team: 'x' } }, 'read', 'doc', { team: 'x' }).because, 'the R role allows read on doc because team is their team');
  assert.equal(decide(team, { ...who, attrs: { team: 'y' } }, 'read', 'doc', { team: 'x' }).because, 'the R role would, but team is not their team');

  const refuse = (c: readonly Condition[]): Policy => ({ roles: R, grants: [{ role: 'r', kind: 'doc', actions: ['read'] }, { role: 'r', kind: 'doc', actions: ['read'], deny: true, when: c }] });
  const noOwner = refuse([{ field: 'owner', equalsSubject: 'id' }]);
  assert.equal(decide(noOwner, who, 'read', 'doc', {}).because, 'the R role is refused read on doc where whether owner is theirs is not known');
  assert.equal(decide(noOwner, who, 'read', 'doc', { owner: null }).allowed, false);
  assert.equal(decide(noOwner, who, 'read', 'doc', { owner: 'u' }).because, 'the R role is refused read on doc where owner is theirs');
  assert.equal(decide(noOwner, who, 'read', 'doc', { owner: 'z' }).allowed, true);
  const noTeam = refuse([{ field: 'team', equalsSubject: 'team' }]);
  assert.equal(decide(noTeam, who, 'read', 'doc', { team: 'x' }).because, 'the R role is refused read on doc where whether team is their team is not known');
  assert.equal(decide(noTeam, { ...who, attrs: { team: 'y' } }, 'read', 'doc', { team: 'x' }).allowed, true);
});

test('explanations name every value a rule lists, say what refused and why, and drop the parts that have nothing to say', () => {
  const lists: Policy = { roles: R, grants: [{ role: 'r', kind: 'doc', actions: ['read'], when: [{ field: 'f', in: ['a', 'b', 'c'] }] }] };
  assert.equal(decide(lists, who, 'read', 'doc', { f: 'b' }).because, 'the R role allows read on doc because f is one of a, b, c');
  assert.equal(decide(lists, who, 'read', 'doc', { f: 'z' }).because, 'the R role would, but f is not one of a, b, c');

  assert.equal(decide(P, adm, 'read', 'note', { sensitivity: 'health' }).because, 'the Admin role is refused read on note where sensitivity is one of health (health notes need break-glass)');
  assert.equal(decide(P, adm, 'read', 'note', priv).because, 'the Admin role allows read on note', 'a grant with no rule has nothing to add');
  assert.equal(decide(P, ben, 'write', 'note', priv).because, 'the Advisor role allows write on note because team is their teams');
  assert.equal(decide(P, ana, 'read', 'note', { ...shared, student: 'cy' }).because, 'the Student role would, but student is not theirs and visibility is one of shared');

  const bare: Policy = { roles: R, grants: [{ role: 'r', kind: 'doc', actions: ['read'] }, { role: 'r', kind: 'doc', actions: ['read'], deny: true }] };
  assert.equal(decide(bare, who, 'read', 'doc').because, 'the R role is refused read on doc', 'a refusal with no rule and no note is just the refusal');
  const noted: Policy = { roles: R, grants: [{ role: 'r', kind: 'doc', actions: ['read'], deny: true, when: [{ field: 'f', in: ['x'] }] }] };
  assert.equal(decide(noted, who, 'read', 'doc', { f: 'x' }).because, 'the R role is refused read on doc where f is one of x');
});

test('a refusal that does not apply to the record is not offered as something that would allow it', () => {
  const onlyRefusal: Policy = { roles: R, grants: [{ role: 'r', kind: 'doc', actions: ['read'], deny: true, when: [{ field: 'f', in: ['x'] }] }] };
  const d = decide(onlyRefusal, who, 'read', 'doc', { f: 'y' });
  assert.equal(d.allowed, false);
  assert.equal(d.because, 'no role allows read on doc');
});

test('when several roles would allow it but for a rule, each is told in turn; when none of their roles can, the roles that could are named', () => {
  const both = { id: 'ana', roles: ['student', 'advisor'] };
  assert.equal(decide(P, both, 'read', 'note', priv).because, 'the Student role would, but student is theirs and visibility is not one of shared; the Advisor role would, but whether team is their teams is not known');
  assert.equal(decide(P, { id: 'n', roles: [] }, 'read', 'note').because, 'none of their roles allows read on note; Student or Advisor or Admin would');
  const other = decide(P, adm, 'read', 'other');
  assert.equal(other.allowed, false, 'a grant on one kind of record gives nothing on another');
  assert.equal(other.because, 'no role allows read on other');
  const undeclared: Policy = { roles: R, grants: [{ role: 'zz', kind: 'x', actions: ['read'] }] };
  assert.equal(decide(undeclared, who, 'read', 'x').because, 'none of their roles allows read on x; zz would');
});

test('require lets an allowed action through and throws the decision for a refused one', () => {
  require(P, ana, 'read', 'note', shared);
  try {
    require(P, ana, 'read', 'note', priv);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof Forbidden);
    assert.equal(e.decision.allowed, false);
    assert.equal(e.message, e.decision.because);
  }
});

test('the matrix lists every grant with its role label, actions, scope and whether it refuses', () => {
  assert.deepEqual(matrix(P), [
    { role: 'Student', kind: 'note', action: 'read', scope: 'student = their id and visibility in shared', deny: false },
    { role: 'Advisor', kind: 'note', action: 'read, write', scope: 'team = their teams', deny: false },
    { role: 'Lead advisor', kind: 'note', action: 'delete', scope: 'team = their teams', deny: false },
    { role: 'Admin', kind: 'note', action: 'read', scope: 'all', deny: false },
    { role: 'Admin', kind: 'note', action: 'read', scope: 'sensitivity in health', deny: true },
  ]);
  const odd: Policy = { roles: R, grants: [{ role: 'r', kind: 'k', actions: ['a', 'b'], when: [{ any: true }] }, { role: 'r', kind: 'k', actions: ['a'], when: [{ field: 'f', in: ['x', 'y'] }, { field: 'g', equalsSubject: 'id' }] }, { role: 'zz', kind: 'k', actions: ['a'] }] };
  assert.deepEqual(matrix(odd), [
    { role: 'R', kind: 'k', action: 'a, b', scope: 'any', deny: false },
    { role: 'R', kind: 'k', action: 'a', scope: 'f in x/y and g = their id', deny: false },
    { role: 'zz', kind: 'k', action: 'a', scope: 'all', deny: false },
  ]);
});

test('a sound policy has no problems; only roles that lead back to themselves are reported', () => {
  assert.deepEqual(check(P), []);
  assert.deepEqual(check({ roles: { a: { label: 'A', inherits: ['b'] }, b: { label: 'B' } }, grants: [{ role: 'a', kind: 'x', actions: ['read'] }] }), []);
  assert.deepEqual(check({ roles: { a: { label: 'A', inherits: ['a'] } }, grants: [] }), ['the role "a" inherits itself']);
  const around: Policy = { roles: { a: { label: 'A', inherits: ['b'] }, b: { label: 'B', inherits: ['a'] }, c: { label: 'C', inherits: ['a'] } }, grants: [] };
  assert.deepEqual(check(around), ['the role "a" inherits itself', 'the role "b" inherits itself'], 'a role that only leads into a loop is not itself in it');
  const branching: Policy = { roles: { a: { label: 'A', inherits: ['z', 'b'] }, b: { label: 'B', inherits: ['z', 'a'] }, z: { label: 'Z' } }, grants: [] };
  assert.deepEqual(check(branching), ['the role "a" inherits itself', 'the role "b" inherits itself'], 'one way back is enough');
  assert.deepEqual(check({ roles: { a: { label: 'A', inherits: ['missing'] } }, grants: [] }), []);
});
