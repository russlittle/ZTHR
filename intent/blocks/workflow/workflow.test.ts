import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Refused, Workflow, check, type Definition } from './index.ts';

const expense: Definition = {
  name: 'expense',
  start: 'draft',
  final: ['paid', 'withdrawn'],
  transitions: [
    { from: 'draft', to: 'review', action: 'submit', roles: ['staff'], guard: (r) => (typeof r.amount === 'number' && r.amount > 0 ? undefined : 'add an amount first') },
    { from: 'draft', to: 'withdrawn', action: 'withdraw', roles: ['staff'] },
    { from: 'approved', to: 'paid', action: 'pay', roles: ['finance'] },
  ],
  approvals: [{ state: 'review', approvers: 2, roles: ['manager'], onApproved: 'approved', onRejected: 'draft', dueHours: 48 }],
};

test('a definition that could strand a record is refused when loaded', () => {
  assert.deepEqual(check({ name: 'x', start: 'a', final: ['c'], transitions: [{ from: 'a', to: 'b', action: 'go', roles: ['r'] }, { from: 'z', to: 'c', action: 'go', roles: ['r'] }] }), ['b has no way out and is not final', 'c cannot be reached from a', 'z cannot be reached from a']);
  assert.throws(() => new Workflow({ ...expense, final: ['paid'] }), /withdrawn has no way out/);
});

test('guards explain, approvals need distinct people who did not ask, rejection needs a reason, and late steps escalate', () => {
  let t = 0;
  const w = new Workflow(expense, () => t);
  const i = w.start('e1', 'ana', {});
  assert.deepEqual(w.actions(i, ['staff']), [{ action: 'submit', ok: false, why: 'add an amount first' }, { action: 'withdraw', ok: true }]);
  i.data.amount = 120;
  w.act(i, 'submit', 'ana', ['staff']);
  assert.throws(() => w.act(i, 'pay', 'fin', ['finance']), Refused);
  assert.throws(() => w.decide(i, 'ana', ['manager'], true), /who asked/);
  w.decide(i, 'ben', ['manager'], true);
  assert.throws(() => w.decide(i, 'ben', ['manager'], true), /already decided/);
  assert.equal(w.overdue([i]).length, 0);
  t = 49 * 3_600_000;
  assert.equal(w.overdue([i]).length, 1);
  assert.equal(w.overdue([i]).length, 0, 'escalated once');
  assert.throws(() => w.decide(i, 'cy', ['manager'], false), /say why/);
  w.decide(i, 'cy', ['manager'], false, 'receipt is missing');
  assert.equal(i.state, 'draft');
  w.act(i, 'submit', 'ana', ['staff']);
  w.decide(i, 'ben', ['manager'], true);
  w.decide(i, 'cy', ['manager'], true);
  w.act(i, 'pay', 'fin', ['finance']);
  assert.deepEqual(i.trail.map((x) => x.to), ['review', 'draft', 'review', 'approved', 'paid']);
  assert.equal(i.trail[1]!.why, 'receipt is missing');
});
