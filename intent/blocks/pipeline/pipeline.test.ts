import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pipeline } from './index.ts';

const make = () => new Pipeline([{ id: 'review', title: 'In review', stuckAfterHours: 24 }, { id: 'checks', title: 'Checks running', stuckAfterHours: 2 }, { id: 'staging', title: 'On staging', stuckAfterHours: 48 }, { id: 'prod', title: 'In production' }]);
const go = (p: Pipeline, change: string, steps: [string, 'entered' | 'passed' | 'failed' | 'waiting' | 'rolledBack', string, string?][]) => steps.forEach(([stage, kind, at, note]) => p.record({ change, stage, kind, at, ...(note ? { note } : {}) }));

test('where is my change: stage, state, what it waits for, what is next, and whether it is stuck', () => {
  const p = make();
  go(p, 'c1', [['review', 'entered', '2026-11-24T09:00:00Z'], ['review', 'passed', '2026-11-24T12:00:00Z'], ['checks', 'entered', '2026-11-24T12:00:00Z'], ['checks', 'passed', '2026-11-24T12:30:00Z'], ['staging', 'entered', '2026-11-24T12:30:00Z'], ['staging', 'waiting', '2026-11-24T13:00:00Z', 'product owner sign-off']]);
  const w = p.where('c1', new Date('2026-11-26T15:00:00Z'))!;
  assert.deepEqual({ ...w }, { change: 'c1', stage: 'staging', title: 'On staging', state: 'waiting', sinceHours: 50, stuck: true, waitingFor: 'product owner sign-off', done: ['review', 'checks'], next: 'staging' });
  assert.throws(() => p.record({ change: 'c2', stage: 'prod', kind: 'entered', at: '2026-11-25T00:00:00Z' }), /before passing staging/);
  assert.equal(p.where('nope', new Date()), undefined);
  assert.deepEqual(p.stuck(new Date('2026-11-26T15:00:00Z')).map((x) => x.change), ['c1']);
});

test('flow measures: deploys a day, median lead time, change failure rate and time to restore', () => {
  const p = make();
  const ship = (c: string, start: string, end: string) => go(p, c, [['review', 'entered', start], ['review', 'passed', start], ['checks', 'entered', start], ['checks', 'passed', start], ['staging', 'entered', start], ['staging', 'passed', end], ['prod', 'entered', end], ['prod', 'passed', end]]);
  ship('a', '2026-11-01T00:00:00Z', '2026-11-01T04:00:00Z');
  ship('b', '2026-11-02T00:00:00Z', '2026-11-02T10:00:00Z');
  ship('c', '2026-11-03T00:00:00Z', '2026-11-03T06:00:00Z');
  ship('d', '2026-11-04T00:00:00Z', '2026-11-04T08:00:00Z');
  p.record({ change: 'b', stage: 'prod', kind: 'rolledBack', at: '2026-11-02T10:30:00Z' });
  assert.equal(p.where('b', new Date('2026-11-05T00:00:00Z'))!.state, 'rolled back');
  assert.equal(p.where('a', new Date('2026-11-05T00:00:00Z'))!.state, 'done');
  assert.deepEqual(p.measures('2026-11-01T00:00:00Z', '2026-11-05T00:00:00Z'), { deploys: 4, perDay: 1, leadTimeHoursMedian: 7, changeFailureRate: 0.25, restoreHoursMedian: 0.5 });
});

test('a change shipped, rolled back and shipped again: only the failed deploy counts, and restore time is never negative', () => {
  const p = make();
  const at = (h: number) => new Date(Date.UTC(2026, 10, 1, h)).toISOString();
  go(p, 'x', [['review', 'entered', at(0)], ['review', 'passed', at(0)], ['checks', 'entered', at(0)], ['checks', 'passed', at(0)], ['staging', 'entered', at(0)], ['staging', 'passed', at(1)], ['prod', 'entered', at(1)], ['prod', 'passed', at(2)], ['prod', 'rolledBack', at(3)], ['prod', 'entered', at(5)], ['prod', 'passed', at(6)]]);
  go(p, 'y', [['review', 'entered', at(0)], ['review', 'passed', at(0)], ['checks', 'entered', at(0)], ['checks', 'passed', at(0)], ['staging', 'entered', at(0)], ['staging', 'rolledBack', at(1)], ['staging', 'passed', at(2)], ['prod', 'entered', at(2)], ['prod', 'passed', at(3)]]);
  const m = p.measures(at(0), at(24));
  assert.equal(m.deploys, 3);
  assert.equal(m.changeFailureRate, 1 / 3, 'a rollback on staging is not a failed deployment');
  assert.equal(m.restoreHoursMedian, 1);
});
