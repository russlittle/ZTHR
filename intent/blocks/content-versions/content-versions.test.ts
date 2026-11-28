import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { sign } from '../crypto/index.ts';
import { Conflict, Refused, VersionError, Versions, diffFields, diffText } from './index.ts';
import type { Options } from './index.ts';

const HOUR = 3_600_000;
const s1 = createHash('sha256').update('preview-test-one').digest('hex');
const s2 = createHash('sha256').update('preview-test-two').digest('hex');

const make = (o: Partial<Options> = {}) => {
  const clock = { now: 1_000_000 };
  const v = new Versions({ now: () => clock.now, previewSecrets: [s1], ...o });
  return { v, clock };
};

// ------------------------------------------------------------ revisions

test('every save is a numbered revision based on the one before, and a save that changes nothing makes none', () => {
  const { v, clock } = make();
  const r1 = v.create('p', { title: 'Hello', body: 'a' }, 'ana');
  clock.now += 10;
  const r2 = v.save('p', { body: 'b' }, 'bo', { note: 'tweak' });
  assert.deepEqual([r1.number, r2.number, r2.basedOn, r2.by, r2.at, r2.note], [1, 2, 1, 'bo', 1_000_010, 'tweak']);
  assert.deepEqual(r2.fields, { title: 'Hello', body: 'b' });
  assert.equal(v.save('p', { body: 'b' }, 'bo').number, 2, 'the same content is not a new revision');
  assert.equal(v.save('p', { title: 'Hello' }, 'bo').number, 2);
  const r3 = v.save('p', { title: undefined }, 'bo');
  assert.deepEqual(r3.fields, { body: 'b' }, 'undefined removes a field');
  assert.deepEqual(v.save('p', { only: 1 }, 'bo', { replace: true }).fields, { only: 1 });
  assert.deepEqual(v.history('p').map((h) => h.number), [1, 2, 3, 4]);
  assert.deepEqual(v.revision('p', 1)?.fields, { title: 'Hello', body: 'a' }, 'old revisions never change');
  assert.throws(() => v.create('p', {}, 'x'), /already exists/);
  assert.throws(() => v.save('nope', {}, 'x'), /no content nope/);
});

test('stored fields are copies and cannot be changed afterwards, even nested ones', () => {
  const { v } = make();
  const input = { tags: ['a'], meta: { n: 1 } };
  const r = v.create('p', input, 'ana');
  input.tags.push('b');
  input.meta.n = 2;
  assert.deepEqual(r.fields, { tags: ['a'], meta: { n: 1 } });
  assert.throws(() => (r.fields.tags as string[]).push('x'), TypeError);
  assert.throws(() => ((r.fields.meta as { n: number }).n = 5), TypeError);
});

test('hostile field names and sizes are handled', () => {
  const { v } = make({ maxBytes: 100 });
  const evil = JSON.parse('{"__proto__":{"polluted":true},"constructor":"x"}') as Record<string, unknown>;
  v.create('p', {}, 'a');
  const r = v.save('p', evil, 'a');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.deepEqual(Object.keys(r.fields).sort(), ['__proto__', 'constructor']);
  assert.throws(() => v.save('p', { big: 'x'.repeat(200) }, 'a'), /too large/);
  assert.throws(() => v.create('q', { f: undefined as unknown as string, g: 1n as unknown as string }, 'a'), TypeError);
  assert.throws(() => v.create('', {}, 'a'), /1 to 200/);
});

test('saving from an old revision is refused with the fields the other person changed', () => {
  const { v } = make();
  v.create('p', { title: 'T', body: 'b', tags: 'x' }, 'ana');
  const mine = v.draft('p').number;
  v.save('p', { body: 'bo edited' }, 'bo', { expected: mine });
  try {
    v.save('p', { title: 'Ana title' }, 'ana', { expected: mine });
    assert.fail('should conflict');
  } catch (e) {
    assert.ok(e instanceof Conflict);
    assert.equal(e.current, 2);
    assert.deepEqual(e.changedFields, ['body']);
  }
  assert.equal(v.draft('p').fields.title, 'T', 'a refused save changed nothing');
  assert.equal(v.save('p', { title: 'Ana title' }, 'ana', { expected: 2 }).number, 3);
});

// ------------------------------------------------------------ publishing

test('readers see only the published revision, so editing a live page does not change it until publish', () => {
  const { v } = make();
  v.create('p', { title: 'One' }, 'ana');
  assert.equal(v.state('p'), 'draft');
  assert.equal(v.published('p'), undefined);
  v.publish('p', 'ana');
  assert.equal(v.state('p'), 'published');
  v.save('p', { title: 'Two' }, 'ana');
  assert.equal(v.state('p'), 'modified');
  assert.equal(v.published('p')?.fields.title, 'One');
  assert.equal(v.draft('p').fields.title, 'Two');
  assert.deepEqual(v.pendingChanges('p'), [{ field: 'title', kind: 'changed', before: 'One', after: 'Two' }]);
  v.publish('p', 'ana');
  assert.equal(v.published('p')?.fields.title, 'Two');
  assert.deepEqual(v.pendingChanges('p'), []);
});

test('discarding the draft goes back to what is live, and the discarded revisions stay in history', () => {
  const { v } = make();
  v.create('p', { title: 'One' }, 'ana');
  assert.throws(() => v.discardDraft('p', 'ana'), /nothing is published/);
  v.publish('p', 'ana');
  v.save('p', { title: 'Oops' }, 'ana');
  assert.equal(v.discardDraft('p', 'ana'), 1);
  assert.equal(v.state('p'), 'published');
  assert.equal(v.draft('p').fields.title, 'One');
  assert.equal(v.save('p', { body: 'x' }, 'ana').number, 3, 'numbering carries on');
  assert.equal(v.revision('p', 2)?.fields.title, 'Oops');
  assert.equal(v.revision('p', 3)?.basedOn, 1);
});

test('a particular older revision can be published, and unpublishing takes the page down but keeps everything', () => {
  const { v } = make();
  v.create('p', { title: 'One' }, 'ana');
  v.save('p', { title: 'Two' }, 'ana');
  v.publish('p', 'ana', { revision: 1 });
  assert.equal(v.published('p')?.number, 1);
  assert.equal(v.state('p'), 'modified');
  assert.throws(() => v.publish('p', 'ana', { revision: 9 }), /no revision 9/);
  v.unpublish('p', 'ana');
  assert.equal(v.state('p'), 'unpublished');
  assert.equal(v.published('p'), undefined);
  assert.throws(() => v.unpublish('p', 'ana'), /not published/);
  v.publish('p', 'ana');
  assert.equal(v.state('p'), 'published');
});

test('a guard can refuse publishing, unpublishing and rollback with its reason, and nothing changes', () => {
  const { v } = make({ guard: ({ by, action }) => (by === 'intern' ? `${by} may not ${action}` : undefined) });
  v.create('p', { t: 1 }, 'ana');
  assert.throws(() => v.publish('p', 'intern'), (e: unknown) => e instanceof Refused && e.message === 'intern may not publish');
  assert.equal(v.state('p'), 'draft');
  v.publish('p', 'ana');
  assert.throws(() => v.unpublish('p', 'intern'), /may not unpublish/);
  assert.throws(() => v.schedule('p', 'intern', { unpublishAt: 2_000_000 }), /may not schedule/);
  v.save('p', { t: 2 }, 'ana');
  assert.throws(() => v.rollback('p', 1, 'intern'), /may not rollback/);
  assert.equal(v.draft('p').fields.t, 2);
  assert.equal(v.published('p')?.number, 1);
});

// ------------------------------------------------------------ schedules

test('a schedule fixes the revision, warns about a newer draft, and publishes exactly that revision when due', () => {
  const { v, clock } = make();
  v.create('p', { title: 'Launch' }, 'ana');
  const { schedule, newerDraft } = v.schedule('p', 'ana', { publishAt: clock.now + HOUR });
  assert.deepEqual(schedule, { revision: 1, publishAt: clock.now + HOUR });
  assert.equal(newerDraft, false);
  assert.equal(v.state('p'), 'scheduled');
  v.save('p', { title: 'Launch (edited later)' }, 'bo');
  assert.equal(v.nextDue(), clock.now + HOUR);
  assert.deepEqual(v.runDue(), [], 'not yet');
  clock.now += HOUR;
  const done = v.runDue();
  assert.deepEqual(done, [{ id: 'p', action: 'publish', revision: 1, dueAt: 1_000_000 + HOUR }]);
  assert.equal(v.published('p')?.fields.title, 'Launch', 'the later edit stayed out of the release');
  assert.equal(v.state('p'), 'modified');
  assert.deepEqual(v.runDue(), [], 'running again does nothing twice');
  assert.equal(v.scheduleOf('p'), undefined);
  assert.equal(v.nextDue(), undefined);
  assert.equal(v.schedule('p', 'ana', { publishAt: clock.now + HOUR, revision: 1 }).newerDraft, true);
});

test('a schedule is checked: future times, the right order, an existing revision, and something to come down', () => {
  const { v, clock } = make();
  v.create('p', { t: 1 }, 'ana');
  const at = clock.now;
  assert.throws(() => v.schedule('p', 'a', {}), /give a time/);
  assert.throws(() => v.schedule('p', 'a', { publishAt: at }), /not in the future/);
  assert.throws(() => v.schedule('p', 'a', { publishAt: at + 10, unpublishAt: at + 5 }), /come down after/);
  assert.throws(() => v.schedule('p', 'a', { publishAt: at + 10, revision: 9 }), /no revision 9/);
  assert.throws(() => v.schedule('p', 'a', { publishAt: NaN }), /number of milliseconds/);
  assert.throws(() => v.schedule('p', 'a', { unpublishAt: at + 10 }), /only something published/);
  assert.throws(() => v.cancelSchedule('p', 'a'), /nothing is scheduled/);
  v.schedule('p', 'a', { publishAt: at + 10 });
  v.cancelSchedule('p', 'a');
  assert.equal(v.scheduleOf('p'), undefined);
  assert.equal(v.state('p'), 'draft');
});

test('a live page can be scheduled to come down, and a whole window that passed unseen ends unpublished', () => {
  const { v, clock } = make();
  v.create('a', { t: 1 }, 'ana');
  v.publish('a', 'ana');
  v.schedule('a', 'ana', { unpublishAt: clock.now + HOUR });
  clock.now += HOUR;
  assert.deepEqual(v.runDue().map((e) => e.action), ['unpublish']);
  assert.equal(v.state('a'), 'unpublished');
  v.create('b', { t: 1 }, 'ana');
  v.schedule('b', 'ana', { publishAt: clock.now + HOUR, unpublishAt: clock.now + 2 * HOUR });
  clock.now += 5 * HOUR;
  assert.deepEqual(v.runDue().map((e) => e.action), ['publish', 'unpublish'], 'in order, though the runner was late');
  assert.equal(v.state('b'), 'unpublished');
  assert.deepEqual(v.log('b').map((l) => l.action), ['create', 'schedule', 'publish', 'unpublish']);
});

test('a schedule that the guard refuses when it comes due is logged and dropped, not retried forever', () => {
  let allow = true;
  const { v, clock } = make({ guard: ({ action }) => (action === 'publish' && !allow ? 'approval was withdrawn' : undefined) });
  v.create('p', { t: 1 }, 'ana');
  v.schedule('p', 'ana', { publishAt: clock.now + HOUR });
  allow = false;
  clock.now += HOUR;
  assert.deepEqual(v.runDue(), []);
  assert.equal(v.state('p'), 'draft');
  assert.equal(v.scheduleOf('p'), undefined);
  assert.match(v.log('p').at(-1)?.note ?? '', /refused: approval was withdrawn/);
});

test('with several documents, only what is due is done, oldest first', () => {
  const { v, clock } = make();
  for (const id of ['a', 'b', 'c']) v.create(id, { t: id }, 'ana');
  v.schedule('a', 'x', { publishAt: clock.now + 3 * HOUR });
  v.schedule('b', 'x', { publishAt: clock.now + HOUR });
  v.schedule('c', 'x', { publishAt: clock.now + 2 * HOUR });
  clock.now += 2 * HOUR;
  assert.deepEqual(v.runDue().map((e) => e.id), ['b', 'c']);
  assert.equal(v.nextDue(), 1_000_000 + 3 * HOUR);
});

// ------------------------------------------------------------ rollback

test('rollback makes a new revision from an old one, can publish it, and refuses a no-op', () => {
  const { v } = make();
  v.create('p', { title: 'One' }, 'ana');
  v.publish('p', 'ana');
  v.save('p', { title: 'Two' }, 'ana');
  v.publish('p', 'ana');
  v.save('p', { title: 'Three' }, 'ana');
  const r = v.rollback('p', 1, 'bo');
  assert.deepEqual([r.number, r.restoredFrom, r.fields.title, r.by], [4, 1, 'One', 'bo']);
  assert.equal(v.published('p')?.fields.title, 'Two', 'rollback to draft does not touch the live page');
  assert.throws(() => v.rollback('p', 1, 'bo'), /already the current content/);
  const live = v.rollback('p', 2, 'bo', { publish: true });
  assert.equal(live.number, 5);
  assert.equal(v.published('p')?.number, 5);
  assert.equal(v.published('p')?.fields.title, 'Two');
  assert.throws(() => v.rollback('p', 99, 'bo'), /no revision 99/);
  assert.deepEqual(v.history('p').map((h) => [h.number, h.restoredFrom ?? null]), [[1, null], [2, null], [3, null], [4, 1], [5, 2]]);
  v.save('p', { title: 'Four' }, 'ana');
  v.publish('p', 'ana');
  const same = v.rollback('p', 4, 'ana');
  assert.equal(same.fields.title, 'One');
});

test('rolling back to content equal to the current draft only publishes it when asked', () => {
  const { v } = make();
  v.create('p', { t: 1 }, 'ana');
  v.save('p', { t: 2 }, 'ana');
  v.save('p', { t: 1 }, 'ana');
  assert.equal(v.rollback('p', 1, 'ana', { publish: true }).number, 3, 'no new revision, but it goes live');
  assert.equal(v.published('p')?.number, 3);
  assert.throws(() => v.rollback('p', 1, 'ana', { publish: true }), /already the current content/);
});

// ------------------------------------------------------------ diffs

test('field diffs name what was added, removed and changed, in order, ignoring key order', () => {
  assert.deepEqual(diffFields({ a: 1, b: 2, c: { x: 1, y: 2 }, d: [1] }, { c: { y: 2, x: 1 }, b: 3, e: 'new', d: [1, 2] }), [
    { field: 'a', kind: 'removed', before: 1 },
    { field: 'b', kind: 'changed', before: 2, after: 3 },
    { field: 'd', kind: 'changed', before: [1], after: [1, 2] },
    { field: 'e', kind: 'added', after: 'new' },
  ]);
  assert.deepEqual(diffFields({}, {}), []);
  const { v } = make();
  v.create('p', { t: 'a', u: 1 }, 'ana');
  v.save('p', { t: 'b' }, 'ana');
  v.publish('p', 'ana', { revision: 1 });
  assert.deepEqual(v.diff('p', 2).map((c) => c.field), ['t'], 'one number compares with what is live');
  assert.deepEqual(v.diff('p', 1, 2), [{ field: 't', kind: 'changed', before: 'a', after: 'b' }]);
  assert.throws(() => v.diff('p', 9), /no revision 9/);
  v.unpublish('p', 'ana');
  assert.throws(() => v.diff('p', 1), /nothing is published/);
});

test('the text diff finds the words or lines that changed and gives back both texts exactly', () => {
  const a = 'The quick brown fox jumps over the lazy dog';
  const b = 'The quick red fox leaps over the lazy dog today';
  const ops = diffText(a, b);
  assert.deepEqual(ops.filter((o) => o.op !== 'equal').map((o) => [o.op, o.text]), [['delete', 'brown'], ['insert', 'red'], ['delete', 'jumps'], ['insert', 'leaps'], ['insert', ' today']]);
  assert.equal(ops.filter((o) => o.op !== 'insert').map((o) => o.text).join(''), a);
  assert.equal(ops.filter((o) => o.op !== 'delete').map((o) => o.text).join(''), b);
  const lines = diffText('one\ntwo\nthree\n', 'one\n2\nthree\nfour\n', 'line');
  assert.deepEqual(lines, [{ op: 'equal', text: 'one\n' }, { op: 'delete', text: 'two\n' }, { op: 'insert', text: '2\n' }, { op: 'equal', text: 'three\n' }, { op: 'insert', text: 'four\n' }]);
  assert.deepEqual(diffText('same', 'same'), [{ op: 'equal', text: 'same' }]);
  assert.deepEqual(diffText('', ''), []);
  assert.deepEqual(diffText('', 'new'), [{ op: 'insert', text: 'new' }]);
  assert.deepEqual(diffText('old', ''), [{ op: 'delete', text: 'old' }]);
});

test('a huge text gives a coarse diff instead of using unbounded time', () => {
  const big = 'w '.repeat(4000);
  assert.deepEqual(diffText(big, `${big}x`), [{ op: 'delete', text: big }, { op: 'insert', text: `${big}x` }]);
});

// ------------------------------------------------------------ previews

test('a preview link shows the latest draft, follows new drafts, and expires', () => {
  const { v, clock } = make();
  v.create('p', { title: 'One' }, 'ana');
  const { token, expiresAt } = v.previewToken('p', 'ana', { ttlMs: HOUR });
  assert.equal(expiresAt, clock.now + HOUR);
  assert.equal(v.resolvePreview(token).revision.fields.title, 'One');
  v.save('p', { title: 'Two' }, 'ana');
  assert.equal(v.resolvePreview(token).revision.fields.title, 'Two');
  clock.now += HOUR + 1;
  assert.throws(() => v.resolvePreview(token), /has expired/);
  assert.deepEqual(v.activePreviews('p'), []);
});

test('a preview can be fixed to one revision, and revoked one by one or for the whole document', () => {
  const { v } = make();
  v.create('p', { title: 'One' }, 'ana');
  v.save('p', { title: 'Two' }, 'ana');
  const fixed = v.previewToken('p', 'ana', { revision: 1 });
  const follow = v.previewToken('p', 'bo');
  assert.equal(v.resolvePreview(fixed.token).revision.number, 1);
  assert.equal(v.resolvePreview(follow.token).revision.number, 2);
  assert.deepEqual(v.activePreviews('p').map((x) => [x.tokenId, x.by, x.revision]), [[fixed.tokenId, 'ana', 1], [follow.tokenId, 'bo', 'latest']]);
  assert.equal(v.revokePreview(fixed.tokenId), true);
  assert.equal(v.revokePreview(fixed.tokenId), false);
  assert.throws(() => v.resolvePreview(fixed.token), /was revoked/);
  assert.equal(v.resolvePreview(follow.token).revision.number, 2, 'others are untouched');
  assert.equal(v.revokePreviewsOf('p'), 1);
  assert.throws(() => v.resolvePreview(follow.token), /was revoked/);
  assert.throws(() => v.previewToken('p', 'a', { revision: 9 }), /no revision 9/);
  assert.throws(() => v.previewToken('p', 'a', { ttlMs: 0 }), /moment to 30 days/);
  assert.throws(() => v.previewToken('p', 'a', { ttlMs: 31 * 86_400_000 }), /moment to 30 days/);
});

test('preview tokens that are forged, altered, for another purpose or from another store are refused', () => {
  const { v, clock } = make();
  v.create('p', { t: 1 }, 'ana');
  const { token } = v.previewToken('p', 'ana');
  assert.throws(() => v.resolvePreview(`${token}x`), /not valid/);
  assert.throws(() => v.resolvePreview('garbage'), /not valid/);
  assert.throws(() => v.resolvePreview(''), /not valid/);
  const [body] = token.split('.');
  assert.throws(() => v.resolvePreview(`${body}.AAAA`), /not valid/);
  const other = sign(s1, 'password-reset', { id: 'p', tid: 'pv1', rev: 'latest' }, HOUR, clock.now);
  assert.throws(() => v.resolvePreview(other), /for something else/);
  const unknownId = sign(s1, 'content-preview', { id: 'p', tid: 'pv999', rev: 'latest' }, HOUR, clock.now);
  assert.throws(() => v.resolvePreview(unknownId), /not known here/);
  const mismatched = sign(s1, 'content-preview', { id: 'q', tid: 'pv1', rev: 'latest' }, HOUR, clock.now);
  assert.throws(() => v.resolvePreview(mismatched), /not known here/);
  const elsewhere = make({ previewSecrets: [s2] }).v;
  assert.throws(() => elsewhere.resolvePreview(token), /not valid/);
  assert.throws(() => make({ previewSecrets: [] }).v.previewToken('x', 'a'), /no content|no preview secret/);
});

test('a preview secret can be rotated: new links use the new one, old links open until the old secret is dropped', () => {
  const { v } = make({ previewSecrets: [s1] });
  v.create('p', { t: 1 }, 'ana');
  const old = v.previewToken('p', 'ana');
  v.setPreviewSecrets([s2, s1]);
  const fresh = v.previewToken('p', 'ana');
  assert.equal(v.resolvePreview(old.token).id, 'p');
  assert.equal(v.resolvePreview(fresh.token).id, 'p');
  v.setPreviewSecrets([s2]);
  assert.throws(() => v.resolvePreview(old.token), /not valid/);
  assert.equal(v.resolvePreview(fresh.token).id, 'p');
});

test('deleting a document revokes its previews', () => {
  const { v } = make();
  v.create('p', { t: 1 }, 'ana');
  const { token } = v.previewToken('p', 'ana');
  v.delete('p');
  assert.throws(() => v.resolvePreview(token), /was revoked/);
  assert.equal(v.has('p'), false);
  assert.throws(() => v.state('p'), /no content/);
});

// ------------------------------------------------------------ pruning and log

test('pruning keeps the newest revisions plus whatever is live, scheduled or in draft', () => {
  const { v, clock } = make();
  v.create('p', { n: 0 }, 'ana');
  v.publish('p', 'ana');
  for (let i = 1; i <= 9; i++) v.save('p', { n: i }, 'ana');
  v.schedule('p', 'ana', { publishAt: clock.now + HOUR, revision: 4 });
  const removed = v.prune('p', 2);
  assert.deepEqual(removed, [2, 3, 5, 6, 7, 8]);
  assert.deepEqual(v.history('p').map((h) => h.number), [1, 4, 9, 10]);
  assert.equal(v.published('p')?.number, 1);
  assert.deepEqual(v.prune('p', 2), []);
  assert.throws(() => v.prune('p', 0), /at least one/);
  clock.now += HOUR;
  v.runDue();
  assert.equal(v.published('p')?.number, 4);
});

test('the log says who did what, in order, and stays bounded', () => {
  const { v } = make();
  v.create('p', { n: 0 }, 'ana');
  v.save('p', { n: 1 }, 'bo', { note: 'fix' });
  v.publish('p', 'cy');
  v.unpublish('p', 'cy');
  assert.deepEqual(v.log('p').map((l) => [l.by, l.action, l.revision ?? null, l.note ?? null]), [['ana', 'create', 1, null], ['bo', 'save', 2, 'fix'], ['cy', 'publish', 2, null], ['cy', 'unpublish', 2, null]]);
  for (let i = 0; i < 300; i++) v.save('p', { n: i + 10 }, 'bo');
  assert.equal(v.log('p').length, 200);
  assert.equal(v.history('p').length, 302);
});
