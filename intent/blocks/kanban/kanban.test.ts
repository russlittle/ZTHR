import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkOrder } from '../fractional-index/index.ts';
import { BadOp, Blocked, Board, NotFound, WipLimit } from './index.ts';
import type { Op } from './index.ts';

const seeded = (seed: number) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
const mk = (actor: string, seed = 1) => new Board({ actor, random: seeded(seed) });

function basic(b = mk('ana')) {
  b.addList('todo', 'To do');
  b.addList('doing', 'Doing', { kind: 'doing', after: 'todo' });
  b.addList('done', 'Done', { kind: 'done', after: 'doing' });
  return b;
}

test('lists keep their order, cards keep theirs, and a move puts a card exactly where it was dropped', () => {
  const b = basic();
  assert.deepEqual(b.lists().map((l) => l.id), ['todo', 'doing', 'done']);
  b.addCard('c1', 'todo', 'One');
  b.addCard('c2', 'todo', 'Two');
  b.addCard('c3', 'todo', 'Three');
  assert.deepEqual(b.cards('todo').map((c) => c.id), ['c1', 'c2', 'c3']);
  b.moveCard('c3', 'todo', { before: 'c1' });
  assert.deepEqual(b.cards('todo').map((c) => c.id), ['c3', 'c1', 'c2']);
  b.moveCard('c1', 'todo', { after: 'c2' });
  assert.deepEqual(b.cards('todo').map((c) => c.id), ['c3', 'c2', 'c1']);
  b.moveCard('c2', 'doing');
  assert.deepEqual(b.cards('doing').map((c) => c.id), ['c2']);
  assert.deepEqual(b.cards('todo').map((c) => c.id), ['c3', 'c1']);
  b.moveList('done', { before: 'todo' });
  assert.deepEqual(b.lists().map((l) => l.id), ['done', 'todo', 'doing']);
  assert.equal(checkOrder(b.lists().map((l) => l.key)), null);
});

test('a block-mode WIP limit refuses a card past it; moving within the list, forcing and warn mode are allowed', () => {
  const b = basic();
  b.setWip('doing', { limit: 2, mode: 'block' });
  b.addCard('a', 'doing', 'A');
  b.addCard('b', 'doing', 'B');
  assert.throws(() => b.addCard('c', 'doing', 'C'), WipLimit);
  b.addCard('c', 'todo', 'C');
  assert.throws(() => b.moveCard('c', 'doing'), (e) => e instanceof WipLimit && e.limit === 2 && e.list === 'doing');
  b.moveCard('a', 'doing', { after: 'b' });
  assert.deepEqual(b.cards('doing').map((c) => c.id), ['b', 'a'], 'reordering inside a full list is fine');
  b.moveCard('c', 'doing', { force: true });
  assert.deepEqual(b.wip('doing'), { count: 3, limit: 2, over: true, mode: 'block' });
  b.setWip('todo', { limit: 1, mode: 'warn' });
  b.addCard('d', 'todo', 'D');
  assert.equal(b.wip('todo').over, false, 'at the limit is not over it');
  b.addCard('e', 'todo', 'E');
  assert.equal(b.wip('todo').over, true);
  assert.deepEqual(b.violations().map((v) => [v.list, v.count, v.limit, v.mode]), [['todo', 2, 1, 'warn'], ['doing', 3, 2, 'block']]);
  assert.throws(() => b.setWip('doing', { limit: 0, mode: 'block' }), BadOp);
});

test('two clients make changes while apart; once they exchange them both show the same board', () => {
  const ana = basic(mk('ana', 3));
  const bo = mk('bo', 9);
  bo.receive(ana.opsSince(0));
  ana.addCard('x', 'todo', 'From Ana');
  bo.addCard('y', 'todo', 'From Bo');
  ana.editCard('x', { title: 'Ana edits' });
  bo.moveList('doing', { before: 'todo' });
  const fromAna = ana.opsSince(0);
  const fromBo = bo.opsSince(0);
  ana.receive(fromBo);
  bo.receive(fromAna);
  assert.deepEqual(ana.lists(), bo.lists());
  assert.deepEqual(ana.cards('todo'), bo.cards('todo'));
  assert.equal(ana.cards('todo').length, 2);
  assert.equal(ana.card('x').title, 'Ana edits');
  assert.deepEqual(ana.lists().map((l) => l.id), ['doing', 'todo', 'done']);
});

test('the same changes in any order, and repeated, give the same board', () => {
  const src = basic(mk('ana', 5));
  src.addCard('a', 'todo', 'A');
  src.addCard('b', 'todo', 'B');
  src.moveCard('b', 'doing');
  src.editCard('a', { labels: ['z', 'y', 'z'], assignee: 'ana', due: '2026-03-01' });
  src.deleteCard('b');
  const ops = src.opsSince(0);
  const shuffled = (seed: number) => {
    const r = seeded(seed);
    return [...ops, ...ops].sort(() => r() - 0.5);
  };
  const want = JSON.stringify([src.lists(), src.cards('todo'), src.cards('doing')]);
  for (const seed of [1, 2, 3, 4]) {
    const other = mk('zed');
    other.receive(shuffled(seed));
    assert.equal(JSON.stringify([other.lists(), other.cards('todo'), other.cards('doing')]), want);
  }
  assert.deepEqual(src.card('a').labels, ['y', 'z'], 'labels are a sorted set');
});

test('concurrent edits to one field: the later stamp wins on every client; different fields both survive', () => {
  const ana = basic(mk('ana', 3));
  ana.addCard('c', 'todo', 'Start');
  const bo = mk('bo', 4);
  bo.receive(ana.opsSince(0));
  ana.editCard('c', { title: 'Ana title', notes: 'Ana notes' });
  bo.editCard('c', { title: 'Bo title' });
  bo.editCard('c', { assignee: 'bo' });
  ana.receive(bo.opsSince(0));
  bo.receive(ana.opsSince(0));
  assert.equal(ana.card('c').title, bo.card('c').title);
  assert.equal(ana.card('c').title, 'Bo title', 'bo wrote at a higher clock');
  assert.equal(ana.card('c').notes, 'Ana notes');
  assert.equal(bo.card('c').assignee, 'bo');
  const t1 = mk('aaa'), t2 = mk('bbb');
  t1.addList('l', 'L');
  t2.receive(t1.opsSince(0));
  t1.addCard('k', 'l', 'K');
  t2.receive(t1.opsSince(0));
  t1.editCard('k', { title: 'from aaa' });
  t2.editCard('k', { title: 'from bbb' });
  t1.receive(t2.opsSince(0));
  t2.receive(t1.opsSince(0));
  assert.equal(t1.card('k').title, 'from bbb', 'equal clocks: the larger writer id wins, on both');
  assert.equal(t2.card('k').title, 'from bbb');
});

test('a card dragged to two lists at once ends in exactly one, the same one everywhere', () => {
  const ana = basic(mk('ana', 3));
  ana.addCard('c', 'todo', 'C');
  const bo = mk('bo', 4);
  bo.receive(ana.opsSince(0));
  ana.moveCard('c', 'doing');
  bo.moveCard('c', 'done');
  ana.receive(bo.opsSince(0));
  bo.receive(ana.opsSince(0));
  assert.equal(ana.card('c').list, bo.card('c').list);
  assert.equal(ana.cards('todo').length + ana.cards('doing').length + ana.cards('done').length, 1);
});

test('two clients dropping a card into the same gap: both land between the neighbours and the order is the same on both', () => {
  const ana = basic(mk('ana', 11));
  ana.addCard('a', 'todo', 'A');
  ana.addCard('z', 'todo', 'Z');
  const bo = mk('bo', 22);
  bo.receive(ana.opsSince(0));
  ana.addCard('m1', 'todo', 'M1', { after: 'a' });
  bo.addCard('m2', 'todo', 'M2', { after: 'a' });
  ana.receive(bo.opsSince(0));
  bo.receive(ana.opsSince(0));
  const order = ana.cards('todo').map((c) => c.id);
  assert.deepEqual(order, bo.cards('todo').map((c) => c.id));
  assert.equal(order[0], 'a');
  assert.equal(order.at(-1), 'z');
  assert.equal(order.length, 4);
});

test('a tie of keys is shown in id order, and new drops after a tie go past it', () => {
  const b = basic(mk('ana', 1));
  const ops: Op[] = [];
  const mkOp = (ref: string, key: string, c: number): Op => ({ id: `t:${ref}`, stamp: { c, a: 't' }, entity: 'card', ref, field: 'pos', value: { list: 'todo', key, lane: null } });
  for (const ref of ['q', 'p']) {
    ops.push({ id: `t:${ref}:c`, stamp: { c: 50, a: 't' }, entity: 'card', ref, field: 'create', value: true }, mkOp(ref, 'a0', 51));
  }
  b.receive(ops);
  assert.deepEqual(b.cards('todo').map((c) => c.id), ['p', 'q']);
  b.addCard('after', 'todo', 'After', { after: 'p' });
  assert.deepEqual(b.cards('todo').map((c) => c.id).at(-1), 'after');
});

test('swimlanes: cards sit in a lane, the grid groups by lane, assignee and label, and a lane that is deleted shows its cards under none', () => {
  const b = basic();
  b.addLane('urgent', 'Urgent');
  b.addLane('later', 'Later', { after: 'urgent' });
  b.addCard('c1', 'todo', 'One', { lane: 'urgent', assignee: 'bo', labels: ['bug'] });
  b.addCard('c2', 'todo', 'Two', { lane: 'later', labels: ['bug', 'ui'] });
  b.addCard('c3', 'doing', 'Three');
  const g = b.grid('lane');
  assert.deepEqual(g.map((r) => r.title), ['Urgent', 'Later', 'No lane']);
  assert.deepEqual(g[0]!.cells.todo!.map((c) => c.id), ['c1']);
  assert.deepEqual(g[2]!.cells.doing!.map((c) => c.id), ['c3']);
  assert.deepEqual(b.grid('assignee').map((r) => [r.title, r.cells.todo!.length]), [['bo', 1], ['Unassigned', 1]]);
  assert.deepEqual(b.grid('label').map((r) => [r.title, r.cells.todo!.length]), [['bug', 2], ['ui', 1], ['No label', 0]]);
  assert.deepEqual(b.cards('todo', 'urgent').map((c) => c.id), ['c1']);
  b.moveCard('c2', 'doing', { lane: 'urgent' });
  assert.equal(b.card('c2').lane, 'urgent');
  b.deleteLane('urgent');
  assert.deepEqual(b.grid('lane').at(-1)!.cells.todo!.map((c) => c.id), ['c1'], 'its cards fall into the no-lane row');
  assert.throws(() => b.moveCard('c1', 'todo', { lane: 'gone' }), NotFound);
});

test('blocked cards may not start or finish until what blocks them is done; loops are refused', () => {
  const b = basic();
  b.addCard('a', 'todo', 'A');
  b.addCard('b', 'todo', 'B');
  b.addCard('c', 'todo', 'C');
  b.block('b', ['a']);
  assert.throws(() => b.moveCard('b', 'doing'), (e) => e instanceof Blocked && e.by[0] === 'a');
  assert.deepEqual(b.ready().map((c) => c.id), ['a', 'c']);
  b.moveCard('a', 'done');
  assert.equal(b.isDone('a'), true);
  b.moveCard('b', 'doing');
  assert.deepEqual(b.ready().map((c) => c.id), ['b', 'c']);
  assert.throws(() => b.block('a', ['b']), /wait on each other/);
  assert.throws(() => b.block('a', ['a']), /itself/);
  assert.throws(() => b.block('a', ['nope']), NotFound);
});

test('concurrent blocking that makes a loop, a deleted list and an over-full list are reported, not hidden', () => {
  const ana = basic(mk('ana', 3));
  ana.addCard('a', 'todo', 'A');
  ana.addCard('b', 'todo', 'B');
  ana.setWip('doing', { limit: 1, mode: 'block' });
  const bo = mk('bo', 4);
  bo.receive(ana.opsSince(0));
  ana.moveCard('a', 'doing');
  bo.moveCard('b', 'doing');
  ana.block('a', ['b']);
  bo.block('b', ['a']);
  bo.deleteList('done');
  ana.addCard('s', 'done', 'Stray');
  ana.receive(bo.opsSince(0));
  bo.receive(ana.opsSince(0));
  for (const x of [ana, bo]) {
    assert.deepEqual(x.cycles(), ['a', 'b']);
    assert.deepEqual(x.violations().map((v) => [v.list, v.count]), [['doing', 2]]);
    assert.deepEqual(x.strays().map((c) => c.id), ['s']);
  }
});

test('overdue lists open cards past their day, oldest first; done cards are never overdue', () => {
  const b = basic();
  b.addCard('a', 'todo', 'A', { due: '2026-02-01' });
  b.addCard('b', 'todo', 'B', { due: '2026-01-15' });
  b.addCard('c', 'done', 'C', { due: '2026-01-01' });
  b.addCard('d', 'todo', 'D', { due: '2026-03-01' });
  assert.deepEqual(b.overdue('2026-03-01').map((c) => c.id), ['b', 'a']);
  assert.throws(() => b.overdue('March'), BadOp);
  assert.throws(() => b.editCard('a', { due: '2026-02-30' }), BadOp);
  assert.throws(() => b.editCard('a', { due: 'soon' }), BadOp);
});

test('hostile or malformed changes from outside are refused before they touch the board', () => {
  const b = basic();
  const op = (o: Partial<Op>): Op => ({ id: 'x:1', stamp: { c: 5, a: 'evil' }, entity: 'card', ref: 'c9', field: 'title', value: 'hi', ...o });
  assert.throws(() => b.receive([op({ field: '__proto__' })]), BadOp);
  assert.throws(() => b.receive([op({ field: 'constructor' })]), BadOp);
  assert.throws(() => b.receive([op({ entity: 'user' as never })]), BadOp);
  assert.throws(() => b.receive([op({ ref: '../etc' })]), BadOp);
  assert.throws(() => b.receive([op({ value: 'x'.repeat(501) })]), BadOp);
  assert.throws(() => b.receive([op({ field: 'pos', value: { list: 'a b', key: 'a0', lane: null } })]), BadOp);
  assert.throws(() => b.receive([op({ field: 'pos', value: { list: 'todo', key: 'a00', lane: null } })]), BadOp, 'a key must be a well-formed order key');
  assert.throws(() => b.receive([op({ stamp: { c: -1, a: 'x' } })]), BadOp);
  assert.throws(() => b.receive([op({ stamp: { c: 1.5, a: 'x' } })]), BadOp);
  assert.throws(() => b.receive([op({ field: 'labels', value: Array.from({ length: 21 }, (_, i) => `l${i}`) })]), BadOp);
  assert.throws(() => b.receive([null as never]), BadOp);
  assert.throws(() => new Board({ actor: 'bad actor!' }), BadOp);
  assert.deepEqual(b.cards('todo'), []);
});

test('a change that arrives before the card it is about waits, and the card appears once created', () => {
  const src = basic(mk('ana', 3));
  src.addCard('c', 'todo', 'Created');
  src.editCard('c', { title: 'Edited' });
  const ops = src.opsSince(0);
  const late = ops.filter((o) => o.field === 'title' && o.value === 'Edited');
  const rest = ops.filter((o) => !late.includes(o));
  const dst = mk('bo');
  dst.receive(late);
  assert.equal(dst.lists().length, 0);
  dst.receive(rest);
  assert.equal(dst.card('c').title, 'Edited');
});

test('deleting wins over the card, ids cannot be reused, and limits on the size of a board hold', () => {
  const b = new Board({ actor: 'ana', limits: { maxCards: 3 } });
  b.addList('l', 'L');
  b.addCard('a', 'l', 'A');
  b.addCard('b', 'l', 'B');
  b.addCard('c', 'l', 'C');
  assert.throws(() => b.addCard('d', 'l', 'D'), /at most 3 cards/);
  assert.throws(() => b.addCard('a', 'l', 'Again'), /taken/);
  b.deleteCard('b');
  assert.throws(() => b.card('b'), NotFound);
  assert.throws(() => b.editCard('b', { title: 'ghost' }), NotFound);
  b.addCard('d', 'l', 'D');
  assert.deepEqual(b.cards('l').map((c) => c.id), ['a', 'c', 'd']);
  assert.throws(() => b.addCard('e', 'nolist', 'E'), NotFound);
  assert.throws(() => b.addList('l', 'again'), /taken/);
});

test('opsSince sends only what a client has not seen, and the clock moves past everything received', () => {
  const ana = basic(mk('ana', 3));
  const seen = ana.lamport;
  ana.addCard('c', 'todo', 'C');
  const delta = ana.opsSince(seen);
  assert.ok(delta.length > 0 && delta.every((o) => o.stamp.c > seen));
  const bo = mk('bo');
  bo.receive(ana.opsSince(0));
  bo.addCard('d', 'todo', 'D');
  assert.ok(bo.lamport > ana.lamport, "a client's next change is stamped after everything it has received");
  assert.equal(bo.receive(ana.opsSince(0)), 0, 'receiving the same changes again changes nothing');
});
