import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Microblog, type NewStatus, type Status } from '../microblog/index.ts';
import { TimelineError, Timelines, mergeItems, type Mode, type TimelineKind } from './index.ts';

const A = 'https://a.example/users/alice';
const B = 'https://b.example/users/bob';
const C = 'https://c.example/users/carol';
const D = 'https://a.example/users/dan';
const E = 'https://e.example/users/eve';
const HOME: TimelineKind = { kind: 'home' };

function world(mode: Mode, o: { celebrity?: number; maxFeed?: number } = {}) {
  let t = Date.UTC(2026, 10, 28, 12, 0, 0);
  let n = 0;
  const follows = new Map<string, Set<string>>();
  const blocks = new Set<string>();
  const graph = {
    followersOf: (a: string) => [...follows].filter(([, s]) => s.has(a)).map(([u]) => u),
    followingOf: (u: string) => [...(follows.get(u) ?? [])],
  };
  const mb = new Microblog({
    now: () => t,
    newId: () => `s${String(++n).padStart(4, '0')}`,
    relations: { follows: (a, b) => follows.get(a)?.has(b) ?? false, blocks: (a, b) => blocks.has(`${a}>${b}`) },
    resolveMention: () => undefined,
  });
  const tl = new Timelines({ mb, graph, isLocal: (a) => a.startsWith('https://a.example/'), domainOf: (a) => new URL(a).host, now: () => t, mode, ...(o.celebrity ? { celebrityFollowers: o.celebrity } : {}), ...(o.maxFeed ? { maxFeed: o.maxFeed } : {}) });
  const w = {
    mb, tl,
    tick: (ms = 1000) => (t += ms),
    at: (ms: number) => (t = ms),
    now: () => t,
    follow: (u: string, a: string) => follows.set(u, (follows.get(u) ?? new Set()).add(a)),
    unfollow: (u: string, a: string) => follows.get(u)?.delete(a),
    block: (a: string, b: string) => blocks.add(`${a}>${b}`),
    post(author: string, text: string, extra: Partial<NewStatus> = {}): Status {
      w.tick();
      const s = mb.post(author, { text, ...extra });
      tl.publish(s);
      return s;
    },
    boost(by: string, id: string): Status {
      w.tick();
      const b = mb.boost(by, id);
      tl.publish(b);
      return b;
    },
    texts: (viewer: string | undefined, k: TimelineKind = HOME) => tl.view(viewer, k, { limit: 40 }).items.map((i) => (i.original ?? i.status).text),
  };
  return w;
}

test('home shows the people you follow and yourself, newest first, and nobody else', () => {
  const w = world('write');
  w.follow(A, B);
  w.post(B, 'b1');
  w.post(C, 'c1 not followed');
  w.post(A, 'a1 mine');
  w.post(B, 'b2');
  assert.deepEqual(w.texts(A), ['b2', 'a1 mine', 'b1']);
  assert.deepEqual(w.texts(C), ['c1 not followed']);
  assert.throws(() => w.tl.view(undefined, HOME), TimelineError);
});

test('write, read and hybrid fan-out give the same timeline; the writes differ', () => {
  const results: Record<string, { texts: string[]; writes: number }> = {};
  for (const mode of ['write', 'read', 'hybrid'] as const) {
    const w = world(mode, { celebrity: 3 });
    for (const u of [A, C, D]) w.follow(u, B);
    w.follow(A, E);
    for (const u of [A, C]) w.follow(u, E);
    w.follow(D, E);
    w.post(B, 'b1');
    w.post(E, 'e1');
    w.post(B, 'b2');
    w.post(A, 'mine');
    results[mode] = { texts: w.texts(A), writes: w.tl.stats().fanoutWrites };
  }
  assert.deepEqual(results['write']!.texts, ['mine', 'b2', 'e1', 'b1']);
  assert.deepEqual(results['read']!.texts, results['write']!.texts);
  assert.deepEqual(results['hybrid']!.texts, results['write']!.texts);
  assert.equal(results['write']!.writes, 3 + 3 + 3 + 0, 'b: 3 followers twice (6), e: 3 followers (3), a: none');
  assert.equal(results['read']!.writes, 0);
  assert.equal(results['hybrid']!.writes, 0, 'both bob and eve have three followers, so both are merged at read time');
});

test('hybrid pushes small authors and merges celebrities', () => {
  const w = world('hybrid', { celebrity: 2 });
  w.follow(A, B);
  w.follow(C, B);
  w.follow(A, D);
  w.post(B, 'celeb');
  assert.equal(w.tl.stats().fanoutWrites, 0);
  w.post(D, 'small');
  assert.equal(w.tl.stats().fanoutWrites, 1);
  assert.deepEqual(w.texts(A), ['small', 'celeb']);
});

test('paging by cursor walks the whole timeline once, with a cap of 40 a page', () => {
  const w = world('write');
  w.follow(A, B);
  for (let i = 0; i < 25; i++) w.post(B, `p${i}`);
  const seen: string[] = [];
  let after: string | undefined;
  for (;;) {
    const p = w.tl.view(A, HOME, { limit: 10, ...(after ? { after } : {}) });
    seen.push(...p.items.map((i) => i.status.text));
    if (!p.next) break;
    after = p.next;
  }
  assert.equal(seen.length, 25);
  assert.equal(new Set(seen).size, 25);
  assert.equal(seen[0], 'p24');
  assert.equal(seen[24], 'p0');
  assert.equal(w.tl.view(A, HOME, { limit: 1000 }).items.length, 25);
  w.post(B, 'new');
  const second = w.tl.view(A, HOME, { limit: 10, after: w.tl.view(A, HOME, { limit: 10 }).next! });
  assert.equal(second.items[0]!.status.text, 'p15', 'a status added at the top does not shift later pages');
});

test('a capped stored feed falls back to merging, so deep pages are still complete', () => {
  const w = world('write', { maxFeed: 3 });
  w.follow(A, B);
  for (let i = 0; i < 8; i++) w.post(B, `p${i}`);
  assert.deepEqual(w.texts(A), ['p7', 'p6', 'p5', 'p4', 'p3', 'p2', 'p1', 'p0']);
});

test('visibility holds in every timeline: followers-only needs a follow, direct never appears, blocks hide', () => {
  const w = world('write');
  w.follow(A, B);
  w.follow(C, B);
  w.post(B, 'public');
  w.post(B, 'friends', { visibility: 'private' });
  w.post(B, 'direct', { visibility: 'direct' });
  w.post(B, 'unlisted', { visibility: 'unlisted' });
  assert.deepEqual(w.texts(A), ['unlisted', 'friends', 'public']);
  w.block(B, C);
  assert.deepEqual(w.texts(C), []);
  assert.deepEqual(w.texts(undefined, { kind: 'federated' }), ['public']);
});

test('mutes (with expiry), muted threads, blocked domains and hidden boosts', () => {
  const w = world('write');
  for (const a of [B, C, E]) w.follow(A, a);
  const root = w.post(B, 'root');
  const reply = w.post(C, 'reply', { inReplyTo: root.id });
  w.post(E, 'from eve');
  w.tick();
  w.tl.setSettings(A, { mutedAccounts: { [E]: w.now() + 60_000 } });
  assert.deepEqual(w.texts(A), ['reply', 'root']);
  w.tick(61_000);
  assert.deepEqual(w.texts(A), ['from eve', 'reply', 'root'], 'the mute has ended');
  w.tl.setSettings(A, { mutedAccounts: { [E]: null } });
  assert.equal(w.texts(A).includes('from eve'), false);
  w.tl.setSettings(A, { mutedThreads: [root.id] });
  assert.deepEqual(w.texts(A), ['from eve']);
  w.tl.setSettings(A, { blockedDomains: ['e.example', 'c.example'] });
  assert.deepEqual(w.texts(A), ['root']);
  w.tl.setSettings(A, {});
  const bst = w.boost(B, reply.id);
  void bst;
  w.tl.setSettings(A, { hideBoostsFrom: [B] });
  assert.equal(w.tl.ids(A, HOME).includes(bst.id), false);
});

test('the same original boosted by several people shows once, at its newest appearance', () => {
  const w = world('write');
  for (const a of [B, C, E]) w.follow(A, a);
  const orig = w.post(B, 'original');
  w.post(C, 'between');
  const b1 = w.boost(C, orig.id);
  const b2 = w.boost(E, orig.id);
  const ids = w.tl.ids(A, HOME);
  assert.equal(ids.filter((i) => i === b2.id || i === b1.id || i === orig.id).length, 1);
  assert.equal(ids[0], b2.id);
  const view = w.tl.view(A, HOME).items;
  assert.equal(view[0]!.original?.id, orig.id);
  assert.equal(view[0]!.status.author, E);
});

test('replies: the followed-only setting shows replies to you, to people you follow, and a person’s own thread', () => {
  const w = world('write');
  w.follow(A, B);
  w.follow(A, C);
  const stranger = w.post(E, 'stranger post');
  const mine = w.post(A, 'my post');
  const bobPost = w.post(B, 'bob post');
  w.post(B, 'bob replies to stranger', { inReplyTo: stranger.id });
  w.post(B, 'bob replies to me', { inReplyTo: mine.id });
  w.post(C, 'carol replies to bob', { inReplyTo: bobPost.id });
  w.post(B, 'bob replies to himself', { inReplyTo: bobPost.id });
  assert.equal(w.texts(A).length, 6);
  w.tl.setSettings(A, { replies: 'followed' });
  assert.deepEqual(w.texts(A), ['bob replies to himself', 'carol replies to bob', 'bob replies to me', 'bob post', 'my post']);
});

test('keyword filters hide or warn by context, whole word or not, and lapse', () => {
  const w = world('write');
  w.follow(A, B);
  w.post(B, 'a cat story');
  w.post(B, 'concatenate strings');
  w.post(B, 'spoilers ahead', { spoilerText: 'movie' });
  w.tick();
  w.tl.setSettings(A, { filters: [
    { id: 'f1', title: 'cats', keywords: [{ text: 'cat', wholeWord: true }], contexts: ['home'], action: 'hide' },
    { id: 'f2', title: 'movies', keywords: [{ text: 'MOVIE' }], contexts: ['home', 'public'], action: 'warn' },
    { id: 'f3', title: 'old', keywords: [{ text: 'strings' }], contexts: ['home'], action: 'hide', expiresAt: w.now() - 1 },
  ] });
  const items = w.tl.view(A, HOME).items;
  assert.deepEqual(items.map((i) => [i.status.text, i.filtered]), [['spoilers ahead', ['movies']], ['concatenate strings', []]]);
  w.tl.setSettings(A, { filters: [{ id: 'f4', title: 'public only', keywords: [{ text: 'cat' }], contexts: ['public'], action: 'hide' }] });
  assert.equal(w.texts(A).length, 3, 'a public-context filter does not touch home');
  assert.throws(() => w.tl.setSettings(A, { filters: [{ id: 'x', title: 'x', keywords: [{ text: ' ' }], contexts: ['home'], action: 'hide' }] }), TimelineError);
  assert.throws(() => w.tl.setSettings(A, { filters: Array.from({ length: 51 }, (_, i) => ({ id: `${i}`, title: 't', keywords: [{ text: 'k' }], contexts: ['home' as const], action: 'hide' as const })) }), /at most 50/);
});

test('local, federated, tag and list timelines', () => {
  const w = world('write');
  w.follow(A, B);
  w.follow(A, C);
  w.post(A, 'local one #news');
  w.post(B, 'remote one #news');
  const d = w.post(D, 'local two', { visibility: 'unlisted' });
  w.boost(A, w.post(C, 'carol #other').id);
  assert.deepEqual(w.texts(undefined, { kind: 'local' }), ['local one #news']);
  assert.deepEqual(w.texts(undefined, { kind: 'federated' }), ['carol #other', 'remote one #news', 'local one #news']);
  assert.deepEqual(w.texts(undefined, { kind: 'tag', tag: '#News' }), ['remote one #news', 'local one #news']);
  assert.equal(w.tl.ids(undefined, { kind: 'federated' }).includes(d.id), false, 'unlisted stays out of public timelines');
  const l = w.mb.createList(A, 'friends');
  w.mb.addToList(A, l.id, B);
  assert.deepEqual(w.texts(A, { kind: 'list', id: l.id }), ['remote one #news']);
  assert.throws(() => w.tl.view(undefined, { kind: 'list', id: l.id }), TimelineError);
});

test('gaps: late arrivals are placed by time, detected against what a client holds, and filled exactly', () => {
  const w = world('write');
  w.follow(A, B);
  const t0 = w.now();
  const ids = [1, 2, 3, 4, 5, 6].map((i) => w.post(B, `p${i}`).id);
  const clientHas = w.tl.view(A, HOME, { limit: 40 }).items.map((i) => i.status.id);
  assert.deepEqual(w.tl.detectGaps(A, HOME, clientHas), []);
  w.at(t0 + 3500);
  const late = w.mb.post(B, { text: 'late arrival' });
  w.tl.publish(late);
  w.at(t0 + 10_000);
  const fresh = w.post(B, 'fresh');
  const gaps = w.tl.detectGaps(A, HOME, clientHas);
  assert.deepEqual(gaps, [{ above: undefined, below: ids[5]!, missing: 1 }, { above: ids[3]!, below: ids[2]!, missing: 1 }]);
  assert.deepEqual(w.tl.fillGap(A, HOME, gaps[0]!).map((i) => i.status.id), [fresh.id]);
  assert.deepEqual(w.tl.fillGap(A, HOME, gaps[1]!).map((i) => i.status.id), [late.id]);
  const merged = mergeItems(w.tl.view(A, HOME, { limit: 40 }).items.filter((i) => clientHas.includes(i.status.id)), [...w.tl.fillGap(A, HOME, gaps[0]!), ...w.tl.fillGap(A, HOME, gaps[1]!)]);
  assert.equal(merged.length, 8);
  assert.deepEqual(merged.map((i) => i.status.id), w.tl.ids(A, HOME));
  assert.deepEqual(w.tl.detectGaps(A, HOME, merged.map((i) => i.status.id)), []);
  assert.deepEqual(w.tl.fillGap(A, HOME, { above: 'nope', below: ids[2]!, missing: 1 }), []);
});

test('rebuild, backfill and forget repair a stored feed from the follow graph', () => {
  const w = world('write');
  w.follow(A, B);
  for (let i = 0; i < 3; i++) w.post(B, `b${i}`);
  w.post(C, 'c0');
  w.follow(A, C);
  assert.deepEqual(w.texts(A), ['b2', 'b1', 'b0'], 'carol was posted before the follow: not in the stored feed');
  assert.equal(w.tl.backfill(A, C), 1);
  assert.equal(w.tl.backfill(A, C), 0, 'backfill is idempotent');
  assert.deepEqual(w.texts(A), ['c0', 'b2', 'b1', 'b0']);
  assert.equal(w.tl.forget(A, B), 3);
  assert.deepEqual(w.texts(A), ['c0']);
  const n = w.tl.rebuildHome(A);
  assert.equal(n, 4);
  assert.deepEqual(w.texts(A), ['c0', 'b2', 'b1', 'b0']);
  w.unfollow(A, B);
  assert.deepEqual(w.texts(A), ['c0'], 'an unfollow takes effect at read time without cleanup');
});

test('deleted statuses vanish from every timeline', () => {
  const w = world('write');
  w.follow(A, B);
  const s = w.post(B, 'oops');
  w.post(B, 'fine');
  w.mb.delete(B, s.id);
  assert.deepEqual(w.texts(A), ['fine']);
  assert.deepEqual(w.texts(undefined, { kind: 'federated' }), ['fine']);
});
