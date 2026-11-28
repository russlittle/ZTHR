import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskError, Tasks, rankBetween } from './index.ts';

const H = 3_600_000;
const D = 24 * H;
function mk(start = Date.UTC(2026, 0, 5, 12, 0)) {
  let t = start;
  const s = new Tasks({ now: () => t });
  return { s, at: (ms: number) => void (t = ms), now: () => t };
}

test('a task is created with trimmed, normalised fields and recorded in the log', () => {
  const { s } = mk();
  const t = s.create({ title: '  Write the report  ', labels: ['Q1 Plan', 'q1  plan', 'Urgent'], assignees: ['ana', 'ana', 'bo'], priority: 'high', checklist: ['draft', 'review'] }, 'ana');
  assert.equal(t.title, 'Write the report');
  assert.deepEqual(t.labels, ['q1-plan', 'urgent']);
  assert.deepEqual(t.assignees, ['ana', 'bo']);
  assert.deepEqual(t.checklist.map((c) => c.id), ['c1', 'c2']);
  assert.equal(t.status, 'todo');
  assert.deepEqual(s.log.map((l) => l.what), ['created']);
  assert.throws(() => s.create({ title: '   ' }, 'x'), /1 to 500/);
  assert.throws(() => s.create({ title: 'x', priority: 'huge' as 'low' }, 'x'), /priority must be one of/);
  assert.throws(() => s.create({ title: 'x', start: 10, due: 5 }, 'x'), /start is after the due/);
  assert.throws(() => s.create({ title: 'x', reminders: [-1] }, 'x'), /reminder is 0 to 366 days/);
  assert.throws(() => s.create({ title: 'x', recurrence: { rule: 'FREQ=DAILY', tz: 'UTC', mode: 'fixed' } }, 'x'), /needs a due date/);
  assert.throws(() => s.create({ title: 'x', due: 1, recurrence: { rule: 'FREQ=SECONDLY', tz: 'UTC', mode: 'fixed' } }, 'x'), /recurrence is not valid/);
  assert.throws(() => s.create({ title: 'x', due: 1, recurrence: { rule: 'FREQ=DAILY', tz: 'Not/AZone', mode: 'fixed' } }, 'x'), /recurrence is not valid/);
});

test('status follows the workflow: allowed actions go through, others say why not', () => {
  const { s } = mk();
  const t = s.create({ title: 'A' }, 'u');
  assert.deepEqual(s.actions(t.id).map((a) => a.action).sort(), ['cancel', 'complete', 'start']);
  s.start(t.id, 'u');
  assert.equal(t.status, 'doing');
  assert.throws(() => s.start(t.id, 'u'), /start is not possible from doing/);
  s.pause(t.id, 'u');
  s.complete(t.id, 'u');
  assert.equal(t.status, 'done');
  assert.equal(typeof t.completedAt, 'number');
  assert.throws(() => s.cancel(t.id, 'u'), /cancel is not possible from done/);
  s.reopen(t.id, 'u');
  assert.equal(t.status, 'todo');
  assert.equal(t.completedAt, undefined);
  s.cancel(t.id, 'u');
  assert.equal(t.status, 'cancelled');
  s.reopen(t.id, 'u');
  assert.deepEqual(s.log.map((l) => l.what).slice(-5), ['paused', 'completed', 'reopened', 'cancelled', 'reopened']);
});

test('a parent cannot be completed while subtasks are open, unless they complete with it', () => {
  const { s } = mk();
  const p = s.create({ title: 'parent' }, 'u');
  const c1 = s.create({ title: 'c1', parent: p.id }, 'u');
  const c2 = s.create({ title: 'c2', parent: p.id }, 'u');
  const g = s.create({ title: 'grandchild', parent: c1.id }, 'u');
  assert.throws(() => s.complete(p.id, 'u'), /3 subtask\(s\) are still open/);
  assert.deepEqual(s.actions(p.id).find((a) => a.action === 'complete'), { action: 'complete', ok: false, why: '3 subtask(s) are still open' });
  s.complete(g.id, 'u');
  s.complete(c1.id, 'u');
  s.cancel(c2.id, 'u');
  assert.equal(s.complete(p.id, 'u').task.status, 'done', 'cancelled subtasks do not block');
  const p2 = s.create({ title: 'p2' }, 'u');
  const k = s.create({ title: 'k', parent: p2.id }, 'u');
  s.complete(p2.id, 'u', { withSubtasks: true });
  assert.equal(k.status, 'done');
});

test('subtasks: depth limit, loops refused, moves keep sibling order by rank', () => {
  const s = new Tasks({ maxDepth: 3 });
  const a = s.create({ title: 'a' }, 'u');
  const b = s.create({ title: 'b', parent: a.id }, 'u');
  const c = s.create({ title: 'c', parent: b.id }, 'u');
  assert.throws(() => s.create({ title: 'd', parent: c.id }, 'u'), /at most 3 levels/);
  assert.throws(() => s.move(a.id, c.id, undefined, 'u'), /under itself/);
  assert.throws(() => s.move(a.id, a.id, undefined, 'u'), /under itself/);
  const t = [1, 2, 3, 4].map((i) => s.create({ title: `t${i}` }, 'u'));
  assert.deepEqual(s.children(undefined).filter((x) => x.title.startsWith('t')).map((x) => x.title), ['t1', 't2', 't3', 't4']);
  s.move(t[3]!.id, undefined, t[1]!.id, 'u');
  assert.deepEqual(s.children(undefined).filter((x) => x.title.startsWith('t')).map((x) => x.title), ['t1', 't4', 't2', 't3']);
  s.move(t[0]!.id, undefined, undefined, 'u');
  assert.deepEqual(s.children(undefined).filter((x) => x.title.startsWith('t')).map((x) => x.title), ['t4', 't2', 't3', 't1']);
  assert.throws(() => s.move(t[0]!.id, undefined, 'nope', 'u'), /not under that parent/);
  const x = s.create({ title: 'x' }, 'u');
  assert.throws(() => s.move(a.id, x.id, undefined, 'u'), /at most 3 levels/, 'moving a deep subtree under another task counts its height');
});

test('rankBetween always finds a rank strictly between, and survives repeated insertion at one spot', () => {
  assert.ok(rankBetween(undefined, undefined) > '');
  const lo = rankBetween(undefined, undefined);
  const hi = rankBetween(lo, undefined);
  assert.ok(lo < hi);
  let a = lo;
  const b = hi;
  for (let i = 0; i < 200; i++) {
    const m = rankBetween(a, b);
    assert.ok(a < m && m < b, `${a} < ${m} < ${b}`);
    a = m;
  }
  assert.ok(rankBetween(undefined, lo) < lo);
  assert.throws(() => rankBetween('b', 'a'), /a < b/);
});

test('assignees, labels and checklist items have limits and toggles', () => {
  const { s } = mk();
  const t = s.create({ title: 'A' }, 'u');
  s.assign(t.id, 'ana', 'u');
  s.assign(t.id, 'ana', 'u');
  s.assign(t.id, 'bo', 'u');
  assert.deepEqual(t.assignees, ['ana', 'bo']);
  s.unassign(t.id, 'ana', 'u');
  s.unassign(t.id, 'nobody', 'u');
  assert.deepEqual(t.assignees, ['bo']);
  const small = new Tasks({ maxAssignees: 2, maxLabels: 1, maxChecklist: 1 });
  const u = small.create({ title: 'x' }, 'u');
  small.assign(u.id, 'a', 'u');
  small.assign(u.id, 'b', 'u');
  assert.throws(() => small.assign(u.id, 'c', 'u'), /at most 2 assignees/);
  small.label(u.id, 'One', true, 'u');
  assert.throws(() => small.label(u.id, 'two', true, 'u'), /at most 1 labels/);
  small.label(u.id, 'one', false, 'u');
  assert.deepEqual(u.labels, []);
  const item = small.addChecklist(u.id, ' step ', 'u');
  assert.equal(item.text, 'step');
  assert.throws(() => small.addChecklist(u.id, 'more', 'u'), /at most 1 checklist/);
  assert.equal(small.tick(u.id, item.id, true, 'u').done, true);
  assert.throws(() => small.tick(u.id, 'zz', true, 'u'), /no checklist item zz/);
});

test('progress rolls up through subtasks and checklists and ignores cancelled work', () => {
  const { s } = mk();
  const p = s.create({ title: 'p' }, 'u');
  const a = s.create({ title: 'a', parent: p.id }, 'u');
  const b = s.create({ title: 'b', parent: p.id, checklist: ['x', 'y'] }, 'u');
  const c = s.create({ title: 'c', parent: p.id }, 'u');
  assert.deepEqual(s.progress(p.id), { done: 0, total: 4, percent: 0 }, 'a, c and two checklist items');
  s.complete(a.id, 'u');
  s.tick(b.id, 'c1', true, 'u');
  assert.deepEqual(s.progress(p.id), { done: 2, total: 4, percent: 50 });
  s.cancel(c.id, 'u');
  assert.deepEqual(s.progress(p.id), { done: 2, total: 3, percent: 67 });
  s.complete(b.id, 'u');
  assert.deepEqual(s.progress(p.id), { done: 3, total: 3, percent: 100 }, 'a completed task counts its checklist done');
});

test('completing a fixed recurring task creates the next one on schedule, keeping its fields', () => {
  const due = Date.UTC(2026, 0, 5, 14, 0); // Monday 9:00 New York
  const { s, at } = mk(due - H);
  const t = s.create({ title: 'Weekly review', labels: ['ops'], assignees: ['ana'], priority: 'medium', due, reminders: [D, H], checklist: ['notes'], recurrence: { rule: 'FREQ=WEEKLY;BYDAY=MO,TH', tz: 'America/New_York', mode: 'fixed' } }, 'u');
  const r = s.complete(t.id, 'u');
  assert.equal(r.next!.due, Date.UTC(2026, 0, 8, 14, 0), 'Thursday 9:00');
  assert.deepEqual([r.next!.title, r.next!.labels, r.next!.assignees, r.next!.priority, r.next!.reminders], ['Weekly review', ['ops'], ['ana'], 'medium', [D, H]]);
  assert.deepEqual(r.next!.checklist.map((c) => [c.text, c.done]), [['notes', false]]);
  assert.equal(r.next!.previous, t.id);
  assert.equal(r.next!.seriesIndex, 1);
  assert.equal(r.next!.status, 'todo');
  at(Date.UTC(2026, 0, 8, 14, 0));
  assert.equal(s.complete(r.next!.id, 'u').next!.due, Date.UTC(2026, 0, 12, 14, 0));
});

test('a recurring task stays at its local time across a daylight-saving change', () => {
  const due = Date.UTC(2026, 2, 6, 14, 0); // Fri 9:00 EST, two days before the clocks go forward
  const { s, at } = mk(due);
  const t = s.create({ title: 'Standup', due, recurrence: { rule: 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', tz: 'America/New_York', mode: 'fixed' } }, 'u');
  at(due);
  const n = s.complete(t.id, 'u').next!;
  assert.equal(n.due, Date.UTC(2026, 2, 9, 13, 0), 'Monday 9:00 EDT is 13:00 UTC');
});

test('completing late skips occurrences already past, so no backlog is created', () => {
  const due = Date.UTC(2026, 0, 5, 12, 0);
  const { s, at } = mk(due);
  const t = s.create({ title: 'Daily', due, recurrence: { rule: 'FREQ=DAILY', tz: 'UTC', mode: 'fixed' } }, 'u');
  at(due + 10 * D + 3 * H);
  assert.equal(s.complete(t.id, 'u').next!.due, due + 11 * D);
});

test('after-completion recurrence counts from when the task was done', () => {
  const due = Date.UTC(2026, 0, 5, 12, 0);
  const { s, at } = mk(due);
  const t = s.create({ title: 'Water plants', due, recurrence: { rule: 'FREQ=DAILY;INTERVAL=3', tz: 'UTC', mode: 'afterCompletion' } }, 'u');
  at(due + 2 * D + 5 * H);
  const next = s.complete(t.id, 'u').next!;
  assert.equal(next.due, due + 2 * D + 5 * H + 3 * D, 'three days after it was done');
});

test('an ended recurrence creates nothing; non-recurring tasks create nothing', () => {
  const due = Date.UTC(2026, 0, 5, 12, 0);
  const { s, at } = mk(due);
  const t = s.create({ title: 'Twice', due, recurrence: { rule: 'FREQ=DAILY;COUNT=2', tz: 'UTC', mode: 'fixed' } }, 'u');
  const first = s.complete(t.id, 'u').next!;
  assert.equal(first.due, due + D);
  at(due + D);
  assert.equal(s.complete(first.id, 'u').next, undefined, 'COUNT=2 is used up');
  assert.equal(s.complete(s.create({ title: 'once', due }, 'u').id, 'u').next, undefined);
  const u = s.create({ title: 'bounded', due, recurrence: { rule: 'FREQ=DAILY;UNTIL=20260106T120000Z', tz: 'UTC', mode: 'fixed' } }, 'u');
  at(due);
  const n = s.complete(u.id, 'u').next!;
  assert.equal(s.complete(n.id, 'u').next, undefined);
});

test('reminders fire once per due date, only for open tasks, and again for the next occurrence', () => {
  const due = Date.UTC(2026, 0, 10, 12, 0);
  const { s, at } = mk(due - 3 * D);
  const t = s.create({ title: 'Pay rent', due, assignees: ['ana'], reminders: [2 * D, H], recurrence: { rule: 'FREQ=MONTHLY', tz: 'UTC', mode: 'fixed' } }, 'u');
  assert.deepEqual(s.dueReminders(), []);
  at(due - 2 * D);
  const r = s.dueReminders();
  assert.deepEqual(r.map((x) => [x.task, x.at, x.assignees]), [[t.id, due - 2 * D, ['ana']]]);
  assert.deepEqual(s.dueReminders(), [], 'once only');
  at(due - H + 1);
  assert.equal(s.dueReminders().length, 1);
  s.complete(t.id, 'u');
  at(Date.UTC(2026, 1, 8, 12, 0));
  const next = s.list({ status: ['todo'] })[0]!;
  assert.equal(next.due, Date.UTC(2026, 1, 10, 12, 0));
  assert.equal(s.dueReminders().length, 1, 'the new due date has its own reminders');
  const done = s.create({ title: 'done already', due, reminders: [0] }, 'u');
  s.complete(done.id, 'u');
  assert.deepEqual(s.dueReminders(due + D).filter((x) => x.task === done.id), []);
  const peek = s.create({ title: 'peek', due, reminders: [0] }, 'u');
  assert.equal(s.dueReminders(due + D, { mark: false }).filter((x) => x.task === peek.id).length, 1);
  assert.equal(s.dueReminders(due + D).filter((x) => x.task === peek.id).length, 1, 'peeking did not mark it sent');
  assert.equal(s.dueReminders(due + D).filter((x) => x.task === peek.id).length, 0);
});

test('list filters by status, assignee, label, priority, due, overdue, parent and text, highest priority first', () => {
  const { s, now } = mk();
  const a = s.create({ title: 'Fix login bug', priority: 'urgent', assignees: ['ana'], labels: ['bug'], due: now() + D }, 'u');
  const b = s.create({ title: 'Write docs', priority: 'low', assignees: ['bo'], labels: ['docs'], due: now() - D }, 'u');
  const c = s.create({ title: 'Login page copy', priority: 'low', parent: a.id, notes: 'check the BUG list' }, 'u');
  s.complete(c.id, 'u');
  assert.deepEqual(s.list().map((t) => t.id), [a.id, b.id, c.id]);
  assert.deepEqual(s.list({ assignee: 'bo' }).map((t) => t.id), [b.id]);
  assert.deepEqual(s.list({ label: 'BUG' }).map((t) => t.id), [a.id]);
  assert.deepEqual(s.list({ overdueAt: now() }).map((t) => t.id), [b.id]);
  assert.deepEqual(s.list({ status: ['done'] }).map((t) => t.id), [c.id]);
  assert.deepEqual(s.list({ parent: a.id }).map((t) => t.id), [c.id]);
  assert.deepEqual(s.list({ parent: null }).map((t) => t.id), [a.id, b.id]);
  assert.deepEqual(s.list({ text: 'bug' }).map((t) => t.id), [a.id, c.id], 'matches title or notes, any case');
  assert.deepEqual(s.list({ priority: 'low', dueBefore: now() }).map((t) => t.id), [b.id]);
});

test('delete removes the whole subtree; updates validate and record what changed', () => {
  const { s } = mk(1_000_000);
  const p = s.create({ title: 'p' }, 'u');
  s.create({ title: 'c', parent: p.id }, 'u');
  const u = s.update(p.id, { title: ' renamed ', notes: 'n', due: 5_000_000 }, 'ana');
  assert.equal(u.title, 'renamed');
  assert.equal(s.log.at(-1)!.what, 'changed title, notes, due');
  assert.throws(() => s.update(p.id, { start: 9_000_000 }, 'ana'), /start is after the due/);
  assert.equal(s.update(p.id, { due: undefined, start: 3 }, 'ana').due, undefined, 'a date can be cleared');
  assert.equal(s.delete(p.id, 'ana'), 2);
  assert.equal(s.list().length, 0);
  assert.throws(() => s.get('nope') ?? s.start('nope', 'u'), TaskError);
});
