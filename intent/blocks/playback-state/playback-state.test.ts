import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlaybackError, PlaybackStore, QueueStore, addToQueue, advance, classify, current, emptyQueue, jumpTo, moveInQueue, playOrder, previous, removeFromQueue, withRepeat, withShuffle, type Kind, type Report, type Snapshot } from './index.ts';

const MIN = 60_000;
const HOUR = 3_600_000;
const NOW = 10 * HOUR;

const store = (o: { now?: () => number } = {}) => new PlaybackStore({ now: o.now ?? (() => NOW) });
const rep = (over: Partial<Report> & { item?: string }): Report => ({ user: 'ann', item: 'movie1', kind: 'video', device: 'tv', positionMs: 0, durationMs: 2 * HOUR, at: 1000, event: 'stop', ...over });
let seq = 0;
const newId = () => `e${++seq}`;

test('thresholds turn a stop into nothing, a resume point or watched, by kind and length', () => {
  const dur = 2 * HOUR;
  assert.deepEqual(classify('video', 0.03 * dur, dur), { resumeMs: undefined, watched: false }, 'under 5%: not started');
  assert.deepEqual(classify('video', 0.05 * dur, dur), { resumeMs: 360_000, watched: false });
  assert.deepEqual(classify('video', 3600_000.9, dur), { resumeMs: 3_600_000, watched: false }, 'whole milliseconds');
  assert.deepEqual(classify('video', 0.9 * dur, dur), { resumeMs: undefined, watched: true });
  assert.deepEqual(classify('video', 0.89 * dur, dur).watched, false);
  assert.deepEqual(classify('video', 2 * MIN, 4 * MIN), { resumeMs: undefined, watched: false }, 'a short item has no resume point');
  assert.deepEqual(classify('video', 3.7 * MIN, 4 * MIN), { resumeMs: undefined, watched: true });
  assert.deepEqual(classify('music', 2 * MIN, 3 * MIN), { resumeMs: undefined, watched: true }, 'music: counted as played past half, never resumed');
  assert.deepEqual(classify('music', 1 * MIN, 3 * MIN), { resumeMs: undefined, watched: false });
  assert.deepEqual(classify('audiobook', 60_000, 10 * HOUR), { resumeMs: 60_000, watched: false }, 'an audiobook resumes from any point');
  assert.deepEqual(classify('audiobook', 10 * HOUR - 20_000, 10 * HOUR), { resumeMs: undefined, watched: true }, 'the last 30 seconds count as the end');
  assert.deepEqual(classify('podcast', 30 * MIN, 31 * MIN), { resumeMs: undefined, watched: true });
  assert.deepEqual(classify('video', 5000, 0), { resumeMs: 5000, watched: false }, 'unknown length: keep the position');
});

test('progress and a stop make a resume point; passing the end makes it watched, counted once', () => {
  const s = store();
  s.report(rep({ positionMs: 10 * MIN, at: 1000, event: 'progress' }));
  assert.equal(s.view('ann', 'movie1').resumeMs, 10 * MIN);
  s.report(rep({ positionMs: 41 * MIN, at: 2000 }));
  assert.deepEqual(s.view('ann', 'movie1'), { watched: false, resumeMs: 41 * MIN, playCount: 0, lastPlayedAt: 2000, durationMs: 2 * HOUR });
  s.report(rep({ positionMs: 115 * MIN, at: 3000 }));
  assert.deepEqual(s.view('ann', 'movie1'), { watched: true, resumeMs: undefined, playCount: 1, lastPlayedAt: 3000, durationMs: 2 * HOUR });
  s.report(rep({ positionMs: 2 * HOUR, at: 4000, event: 'finish' }));
  assert.equal(s.view('ann', 'movie1').playCount, 2, 'a second finish is a second play');
  assert.equal(s.view('ann', 'nothing').playCount, 0);
});

test('a repeated or older report is not counted twice, even after another device has reported', () => {
  const s = store();
  const fin = rep({ positionMs: 2 * HOUR, at: 5000, event: 'finish' });
  assert.ok(s.report(fin));
  assert.equal(s.report(fin), undefined, 'the same report again');
  assert.equal(s.report({ ...fin, at: 4000 }), undefined, 'an older one from the same device');
  s.report(rep({ device: 'phone', positionMs: 10 * MIN, at: 6000, event: 'progress' }));
  assert.equal(s.report(fin), undefined, 'a retry after the phone reported');
  assert.equal(s.view('ann', 'movie1').playCount, 1);
});

test('watching again after finishing gives a resume point and keeps the watched flag', () => {
  const s = store();
  s.report(rep({ positionMs: 2 * HOUR, at: 1000, event: 'finish' }));
  s.report(rep({ positionMs: 30 * MIN, at: 2000 }));
  assert.deepEqual([s.view('ann', 'movie1').watched, s.view('ann', 'movie1').resumeMs], [true, 30 * MIN]);
  s.report(rep({ positionMs: 3 * MIN, at: 3000 }));
  assert.deepEqual([s.view('ann', 'movie1').watched, s.view('ann', 'movie1').resumeMs], [true, undefined], 'under the minimum: no resume point');
});

test('marking by hand wins over older plays and loses to newer ones', () => {
  const s = store();
  s.report(rep({ positionMs: 30 * MIN, at: 1000 }));
  s.mark('ann', 'movie1', 'video', true, 2000, 'phone');
  assert.deepEqual([s.view('ann', 'movie1').watched, s.view('ann', 'movie1').resumeMs], [true, undefined]);
  s.mark('ann', 'movie1', 'video', false, 3000, 'phone');
  assert.deepEqual([s.view('ann', 'movie1').watched, s.view('ann', 'movie1').resumeMs], [false, undefined], 'unwatched clears the old resume point');
  s.mark('ann', 'movie1', 'video', true, 2500, 'tv');
  assert.equal(s.view('ann', 'movie1').watched, false, 'an older mark arriving late does not undo a newer one');
  s.report(rep({ positionMs: 20 * MIN, at: 4000 }));
  assert.deepEqual([s.view('ann', 'movie1').watched, s.view('ann', 'movie1').resumeMs], [false, 20 * MIN]);
  assert.throws(() => s.mark('ann', 'movie1', 'video', true, NOW + 10 * MIN, 'tv'), /future/);
});

test('across devices the later report wins, a tie goes to the device name, and plays add up per device', () => {
  const s = store();
  s.report(rep({ device: 'tv', positionMs: 20 * MIN, at: 1000 }));
  s.report(rep({ device: 'phone', positionMs: 5 * MIN, at: 2000 }));
  assert.equal(s.view('ann', 'movie1').resumeMs, undefined, 'the phone is later, and 5 minutes of 2 hours is under 5%, so there is no resume point');
  const t = store();
  t.report(rep({ device: 'tv', positionMs: 20 * MIN, at: 1000 }));
  t.report(rep({ device: 'phone', positionMs: 30 * MIN, at: 2000 }));
  assert.equal(t.view('ann', 'movie1').resumeMs, 30 * MIN);
  const u = store();
  u.report(rep({ device: 'tv', positionMs: 20 * MIN, at: 1000 }));
  u.report(rep({ device: 'web', positionMs: 40 * MIN, at: 1000 }));
  assert.equal(u.view('ann', 'movie1').resumeMs, 40 * MIN, 'equal times: "web" beats "tv"');
  u.report(rep({ device: 'tv', positionMs: 2 * HOUR, at: 3000, event: 'finish' }));
  u.report(rep({ device: 'web', positionMs: 2 * HOUR, at: 3500, event: 'finish' }));
  assert.equal(u.view('ann', 'movie1').playCount, 2);
});

test('continue watching lists unfinished items by most recent play, and next-up follows the series', () => {
  const s = store();
  s.report(rep({ item: 'a', positionMs: 30 * MIN, at: 1000 }));
  s.report(rep({ item: 'b', positionMs: 40 * MIN, at: 3000 }));
  s.report(rep({ item: 'c', positionMs: 50 * MIN, at: 2000 }));
  s.report(rep({ item: 'd', positionMs: 2 * HOUR, at: 4000, event: 'finish' }));
  s.report(rep({ item: 'e', positionMs: MIN, at: 5000 }));
  assert.deepEqual(s.continueWatching('ann').map((x) => x.item), ['b', 'c', 'a']);
  assert.deepEqual(s.continueWatching('ann', 2).map((x) => x.item), ['b', 'c']);
  assert.deepEqual(s.continueWatching('bob'), []);
  const series = ['e1', 'e2', 'e3'];
  const w = (item: string, at: number) => s.report(rep({ user: 'u', item, kind: 'episode', durationMs: 40 * MIN, positionMs: 40 * MIN, at, event: 'finish' }));
  assert.equal(s.nextUp('u', series), 'e1');
  w('e1', 1000);
  assert.equal(s.nextUp('u', series), 'e2');
  w('e3', 2000);
  assert.equal(s.nextUp('u', series), undefined, 'nothing unwatched after the last watched');
  w('e2', 3000);
  assert.equal(s.nextUp('u', series), undefined);
  assert.equal(s.nextUp('u', []), undefined);
});

test('one user cannot see or change another user’s state', () => {
  const s = store();
  s.report(rep({ user: 'ann', positionMs: 30 * MIN }));
  assert.equal(s.view('bob', 'movie1').resumeMs, undefined);
  assert.equal(s.get('bob', 'movie1'), undefined);
  s.report(rep({ user: 'bob', positionMs: 10 * MIN, at: 500 }));
  assert.equal(s.view('ann', 'movie1').resumeMs, 30 * MIN);
  assert.deepEqual(Object.keys(s.snapshot()).sort(), ['ann', 'bob']);
});

test('merging stores is commutative, associative and idempotent (40 random histories)', () => {
  for (let seed = 1; seed <= 40; seed++) {
    let x = seed;
    const r = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296);
    const stores = [store(), store(), store()];
    for (let i = 0; i < 20; i++) {
      const st = stores[Math.floor(r() * 3)]!;
      const dev = ['tv', 'phone', 'web'][Math.floor(r() * 3)]!;
      const item = `m${Math.floor(r() * 3)}`;
      if (r() < 0.2) st.mark('ann', item, 'video', r() < 0.5, 1 + Math.floor(r() * 9000), dev);
      else st.report(rep({ item, device: dev, positionMs: Math.floor(r() * 2 * HOUR), at: 1 + Math.floor(r() * 9000), event: (['progress', 'stop', 'finish'] as const)[Math.floor(r() * 3)]! }));
    }
    const [a, b, c] = stores.map((s) => s.snapshot()) as [Snapshot, Snapshot, Snapshot];
    const join = (...ss: Snapshot[]): Snapshot => {
      const out = store();
      for (const s of ss) out.merge(s);
      return out.snapshot();
    };
    const sorted = (s: Snapshot) => JSON.stringify(s, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));
    assert.equal(sorted(join(a, b)), sorted(join(b, a)), `commutative ${seed}`);
    assert.equal(sorted(join(join(a, b), c)), sorted(join(a, join(b, c))), `associative ${seed}`);
    assert.equal(sorted(join(a, a)), sorted(join(a)), `idempotent ${seed}`);
  }
});

test('hostile reports and snapshots are refused', () => {
  const s = store();
  const bad = (o: Partial<Report>, m: RegExp) => assert.throws(() => s.report(rep(o)), m);
  bad({ positionMs: -1 }, /zero or more/);
  bad({ positionMs: Number.NaN }, /zero or more/);
  bad({ durationMs: Infinity }, /zero to seven days/);
  bad({ durationMs: 8 * 86_400_000 }, /seven days/);
  bad({ positionMs: 3 * HOUR }, /past the end/);
  bad({ at: NOW + 6 * MIN }, /future/);
  bad({ user: '' }, /1 to 200/);
  bad({ item: 'x'.repeat(201) }, /1 to 200/);
  bad({ device: 'tv\u0000' }, /1 to 200/);
  assert.ok(s.report(rep({ positionMs: 2 * HOUR + 1000, at: 100 })), 'a little past the end is rounding, not hostile');
  assert.equal(s.get('ann', 'movie1')!.progress!.positionMs, 2 * HOUR, 'and is clamped');
  assert.throws(() => s.merge({ '': {} }), PlaybackError);
  assert.throws(() => s.merge({ u: { i: { kind: 'bogus' as Kind, plays: {}, last: {} } } }), /bad item/);
  assert.throws(() => s.merge({ u: { i: { kind: 'video', plays: { tv: -1 }, last: {} } } }), /bad play count/);
  assert.throws(() => s.merge({ u: { i: { kind: 'video' } as never } }), PlaybackError);
});

test('thresholds can be set per kind', () => {
  const s = new PlaybackStore({ now: () => NOW, thresholds: { video: { minResumePct: 1, maxResumePct: 50, minResumeDurationMs: 0, endWindowMs: 0, resume: true } } });
  s.report(rep({ positionMs: 61 * MIN }));
  assert.equal(s.view('ann', 'movie1').watched, true, '50% is now watched');
  s.report(rep({ item: 'm2', positionMs: 2 * MIN, at: 5000 }));
  assert.equal(s.view('ann', 'm2').resumeMs, 2 * MIN, '1.7% now resumes');
});

test('the queue keeps what is playing when entries are added, moved or removed', () => {
  seq = 0;
  let q = addToQueue(emptyQueue(), ['a', 'b', 'c'], newId);
  assert.deepEqual(q.entries.map((e) => [e.id, e.item]), [['e1', 'a'], ['e2', 'b'], ['e3', 'c']]);
  assert.equal(current(q)!.item, 'a');
  q = addToQueue(q, ['x'], newId, 'next');
  assert.deepEqual(q.entries.map((e) => e.item), ['a', 'x', 'b', 'c']);
  q = jumpTo(q, 'e3');
  q = moveInQueue(q, 'e3', 0);
  assert.deepEqual(q.entries.map((e) => e.item), ['c', 'a', 'x', 'b']);
  assert.equal(current(q)!.item, 'c', 'moving the current entry did not change what plays');
  q = removeFromQueue(q, 'e1');
  assert.deepEqual(q.entries.map((e) => e.item), ['c', 'a', 'x', 'b'].filter((i) => i !== 'a'));
  assert.equal(current(q)!.item, 'c');
  q = removeFromQueue(q, 'e3');
  assert.equal(current(q)!.item, 'x', 'removing the current one moves to the next');
  assert.throws(() => removeFromQueue(q, 'nope'), /no such entry/);
  assert.throws(() => moveInQueue(q, 'e2', 9), /no such position/);
  assert.throws(() => jumpTo(q, 'nope'), /no such entry/);
  assert.throws(() => addToQueue(q, ['ok', ''], newId), /bad item id/);
  assert.equal(addToQueue(q, [], newId), q);
});

test('advance, previous and the repeat modes', () => {
  seq = 0;
  let q = addToQueue(emptyQueue(), ['a', 'b'], newId);
  q = advance(q, true);
  assert.equal(current(q)!.item, 'b');
  assert.equal(current(advance(q, true)), undefined, 'the queue ends');
  assert.equal(current(advance(withRepeat(q, 'all'), true))!.item, 'a', 'repeat all wraps');
  assert.equal(current(advance(withRepeat(q, 'one'), true))!.item, 'b', 'repeat one plays it again when it ends');
  assert.equal(current(advance(withRepeat(q, 'one'), false))!.item, 'a', 'but a skip moves on, wrapping like repeat all');
  assert.equal(current(previous(q))!.item, 'a');
  assert.equal(current(previous(jumpTo(q, 'e1')))!.item, 'a', 'before the first stays on the first');
  assert.equal(current(previous(withRepeat(jumpTo(q, 'e1'), 'all')))!.item, 'b', 'or wraps when repeating');
  assert.equal(advance(emptyQueue(), true).currentId, undefined);
});

test('a shuffle is stable: the same seed gives the same order and adding entries does not reorder the rest', () => {
  seq = 0;
  let q = addToQueue(emptyQueue(), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], newId);
  const plain = playOrder(q).map((e) => e.id);
  q = withShuffle(q, 'seed-1');
  const one = playOrder(q).map((e) => e.id);
  assert.notDeepEqual(one, plain);
  assert.deepEqual(playOrder(q).map((e) => e.id), one, 'the same seed, the same order');
  assert.deepEqual([...one].sort(), [...plain].sort(), 'nothing lost or doubled');
  assert.notDeepEqual(playOrder(withShuffle(q, 'seed-2')).map((e) => e.id), one);
  const more = addToQueue(q, ['i', 'j'], newId);
  const after = playOrder(more).map((e) => e.id).filter((id) => one.includes(id));
  assert.deepEqual(after, one, 'the old entries keep their relative order');
  const first = one[0]!;
  q = jumpTo(q, first);
  q = advance(q, false);
  assert.equal(q.currentId, one[1]);
  assert.deepEqual(playOrder(withShuffle(q, undefined)).map((e) => e.id), plain, 'shuffle off restores the listed order');
});

test('saving the queue from two devices merges edits to different fields and reports the same field edited twice', () => {
  seq = 0;
  const qs = new QueueStore();
  assert.deepEqual(qs.get('ann'), { version: 0, state: emptyQueue() });
  const base0 = emptyQueue();
  const v1 = qs.save('ann', 0, base0, addToQueue(base0, ['a', 'b'], newId));
  assert.ok(v1.ok && v1.version === 1);
  const base = qs.get('ann').state;
  const phone = qs.save('ann', 1, base, withRepeat(base, 'all'));
  assert.ok(phone.ok && phone.version === 2);
  const tv = qs.save('ann', 1, base, addToQueue(base, ['c'], newId));
  assert.ok(tv.ok);
  if (tv.ok) {
    assert.deepEqual(tv.merged, ['entries']);
    assert.equal(tv.state.repeat, 'all', 'the phone’s change is kept');
    assert.deepEqual(tv.state.entries.map((e) => e.item), ['a', 'b', 'c']);
  }
  const b2 = qs.get('ann');
  const x = qs.save('ann', b2.version, b2.state, addToQueue(b2.state, ['x'], newId));
  assert.ok(x.ok);
  const y = qs.save('ann', b2.version, b2.state, addToQueue(b2.state, ['y'], newId));
  assert.equal(y.ok, false);
  if (!y.ok) assert.deepEqual(y.conflicts.map((c) => c.field), ['entries']);
  assert.throws(() => qs.save('ann', 99, b2.state, b2.state), RangeError);
  assert.deepEqual(qs.get('bob'), { version: 0, state: emptyQueue() }, 'queues are per user');
});
