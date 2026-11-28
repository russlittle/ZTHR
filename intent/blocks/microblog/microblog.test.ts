import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PUBLIC } from '../activitypub/index.ts';
import { MicroblogError, Microblog, addressing, fromNote, parseText, renderHtml, toActivity, visibilityFrom, type Relations, type Status } from './index.ts';

const A = 'https://a.example/users/alice';
const B = 'https://b.example/users/bob';
const C = 'https://c.example/users/carol';
const D = 'https://d.example/users/dan';

function setup(follows: [string, string][] = [], blocks: [string, string][] = []) {
  let t = Date.UTC(2026, 10, 28, 12, 0, 0);
  let n = 0;
  const f = new Set(follows.map(([a, b]) => `${a}>${b}`));
  const bl = new Set(blocks.map(([a, b]) => `${a}>${b}`));
  const relations: Relations = { follows: (a, b) => f.has(`${a}>${b}`), blocks: (a, b) => bl.has(`${a}>${b}`) };
  const handles: Record<string, string> = { alice: A, bob: B, carol: C, dan: D };
  const mb = new Microblog({ now: () => t, newId: () => `s${++n}`, relations, resolveMention: (u) => handles[u] });
  return { mb, tick: (ms: number) => (t += ms), now: () => t, follow: (a: string, b: string) => f.add(`${a}>${b}`) };
}

test('mentions and hashtags are found in text; tags are lower-cased and unique; e-mail addresses and urls are not mentions', () => {
  const p = parseText('Hi @bob and @carol@c.example! #Fediverse #fediverse #日本語 mail me@x.org http://x.org/@nobody#frag');
  assert.deepEqual(p.mentions, [{ user: 'bob', host: undefined }, { user: 'carol', host: 'c.example' }]);
  assert.deepEqual(p.tags, ['fediverse', '日本語']);
});

test('html rendering escapes everything, then links urls, mentions and tags, and keeps line breaks', () => {
  const html = renderHtml('<b>x</b> & @bob see https://x.example/a?b=1&c=2. #Tag\nnext @ghost', {
    tagUrl: (t) => `https://a.example/tags/${t}`,
    mentionUrl: (u) => (u === 'bob' ? B : undefined),
  });
  assert.equal(html, '<p>&lt;b&gt;x&lt;/b&gt; &amp; <span class="h-card"><a href="https://b.example/users/bob" class="u-url mention">@<span>bob</span></a></span> see <a href="https://x.example/a?b=1&amp;c=2" rel="nofollow noopener noreferrer" target="_blank">https://x.example/a?b=1&amp;c=2</a>. <a href="https://a.example/tags/tag" class="hashtag" rel="tag">#<span>Tag</span></a><br>next @ghost</p>');
  assert.ok(!renderHtml('<script>alert(1)</script>', { tagUrl: () => '', mentionUrl: () => undefined }).includes('<script>'));
});

test('posting checks length, content warning length, empty statuses and gives mentions and tags', () => {
  const { mb } = setup();
  const s = mb.post(A, { text: 'hello @bob #Intro', spoilerText: 'greeting', language: 'en' });
  assert.deepEqual([s.visibility, s.sensitive, s.mentions, s.tags, s.spoilerText], ['public', true, [B], ['intro'], 'greeting']);
  assert.throws(() => mb.post(A, { text: 'x'.repeat(501) }), /at most 500/);
  assert.equal(mb.post(A, { text: '😀'.repeat(500) }).text.length, 1000, 'length counts characters, not UTF-16 units');
  assert.throws(() => mb.post(A, { text: 'ok', spoilerText: 'w'.repeat(101) }), /content warning/);
  assert.throws(() => mb.post(A, { text: '  ' }), /needs text, media or a poll/);
  assert.equal(mb.post(A, { text: 'plain' }).sensitive, false);
});

test('visibility: who can read public, unlisted, followers-only and direct statuses, and blocks hide everything', () => {
  const { mb } = setup([[B, A]], [[A, D]]);
  const pub = mb.post(A, { text: 'p' });
  const priv = mb.post(A, { text: 'f', visibility: 'private' });
  const direct = mb.post(A, { text: 'hey @carol', visibility: 'direct' });
  assert.deepEqual([pub, priv, direct].map((s) => [s.id, mb.canSee(undefined, s), mb.canSee(B, s), mb.canSee(C, s), mb.canSee(A, s)]), [
    [pub.id, true, true, true, true],
    [priv.id, false, true, false, true],
    [direct.id, false, false, true, true],
  ]);
  assert.equal(mb.canSee(D, pub), false, 'the author blocked dan');
  const un = mb.post(A, { text: 'u', visibility: 'unlisted' });
  assert.equal(mb.canSee(undefined, un), true);
});

test('a reply is never more public than a followers-only or direct parent, and answers notify the parent author', () => {
  const { mb } = setup([[B, A]]);
  const priv = mb.post(A, { text: 'secret', visibility: 'private' });
  const r = mb.post(B, { text: 'ok', inReplyTo: priv.id, visibility: 'public' });
  assert.equal(r.visibility, 'private');
  assert.deepEqual(r.mentions, [A]);
  assert.throws(() => mb.post(C, { text: 'nosy', inReplyTo: priv.id }), (e: unknown) => e instanceof MicroblogError && e.code === 'forbidden');
  const pub = mb.post(A, { text: 'open' });
  assert.equal(mb.post(B, { text: 're', inReplyTo: pub.id, visibility: 'unlisted' }).visibility, 'unlisted');
  assert.throws(() => mb.post(B, { text: 're', inReplyTo: 'nope' }), /no status nope/);
});

test('boosts: not for followers-only or direct, never more public than the original, once only, and a boost of a boost is the original', () => {
  const { mb } = setup();
  const pub = mb.post(A, { text: 'p' });
  const un = mb.post(A, { text: 'u', visibility: 'unlisted' });
  assert.throws(() => mb.boost(A, mb.post(A, { text: 'x', visibility: 'private' }).id), /cannot be boosted/);
  assert.throws(() => mb.boost(B, mb.post(A, { text: 'y', visibility: 'private' }).id), /not visible/);
  const b1 = mb.boost(B, pub.id);
  assert.equal(b1.boostOf, pub.id);
  assert.equal(mb.boost(B, pub.id).id, b1.id, 'a second boost is the first');
  assert.equal(mb.boost(C, b1.id).boostOf, pub.id);
  assert.equal(mb.boostCount(pub.id), 2);
  assert.equal(mb.boost(B, un.id, 'public').visibility, 'unlisted');
  assert.equal(mb.unboost(B, pub.id), true);
  assert.equal(mb.boostCount(pub.id), 1);
  assert.equal(mb.unboost(B, pub.id), false);
});

test('favourites and bookmarks: counted once, bookmarks are private, newest first, and hide what is no longer visible', () => {
  const { mb, tick, follow } = setup();
  const s1 = mb.post(A, { text: 'one' });
  const s2 = mb.post(A, { text: 'two' });
  assert.equal(mb.favourite(B, s1.id), true);
  assert.equal(mb.favourite(B, s1.id), false);
  mb.favourite(C, s1.id);
  assert.equal(mb.favouriteCount(s1.id), 2);
  assert.equal(mb.unfavourite(B, s1.id), true);
  assert.deepEqual(mb.favouritedBy(s1.id), [C]);
  mb.bookmark(B, s1.id);
  tick(1000);
  mb.bookmark(B, s2.id);
  mb.bookmark(B, s2.id);
  assert.deepEqual(mb.bookmarks(B).map((s) => s.id), [s2.id, s1.id]);
  assert.deepEqual(mb.bookmarks(C), []);
  const priv = mb.post(A, { text: 'friends', visibility: 'private' });
  follow(B, A);
  mb.bookmark(B, priv.id);
  assert.equal(mb.bookmarks(B).length, 3);
  mb.delete(A, s1.id);
  assert.deepEqual(mb.bookmarks(B).map((s) => s.id), [priv.id, s2.id]);
});

test('polls: option rules, one vote each, multiple choice, closing, and the author cannot vote', () => {
  const { mb, tick } = setup();
  const L = 3_600_000;
  assert.throws(() => mb.post(A, { text: 'q', poll: { options: ['only'], expiresInMs: L } }), /2 to 4 options/);
  assert.throws(() => mb.post(A, { text: 'q', poll: { options: ['a', 'A'], expiresInMs: L } }), /must differ/);
  assert.throws(() => mb.post(A, { text: 'q', poll: { options: ['a', 'b'], expiresInMs: 1000 } }), /5 minutes to 30 days/);
  assert.throws(() => mb.post(A, { text: 'q', poll: { options: ['a', 'x'.repeat(51)], expiresInMs: L } }), /1 to 50 characters/);
  const s = mb.post(A, { text: 'Tea or coffee?', poll: { options: ['tea', 'coffee', 'water'], expiresInMs: L } });
  assert.throws(() => mb.vote(A, s.id, [0]), /author cannot vote/);
  const after = mb.vote(B, s.id, [1]);
  assert.deepEqual(after.options.map((o) => o.votes), [0, 1, 0]);
  assert.equal(after.votersCount, 1);
  assert.deepEqual(mb.votedBy(s.id, B), [1]);
  assert.throws(() => mb.vote(B, s.id, [0]), (e: unknown) => e instanceof MicroblogError && e.code === 'conflict');
  assert.throws(() => mb.vote(C, s.id, [0, 1]), /one choice/);
  assert.throws(() => mb.vote(C, s.id, [7]), /existing options/);
  const m = mb.post(A, { text: 'many', poll: { options: ['x', 'y'], multiple: true, expiresInMs: L } });
  assert.deepEqual(mb.vote(C, m.id, [0, 1, 1]).options.map((o) => o.votes), [1, 1]);
  tick(L);
  assert.throws(() => mb.vote(D, s.id, [0]), (e: unknown) => e instanceof MicroblogError && e.code === 'closed');
});

test('media: up to four images or one video, alt text limits and a missing-alt check, https only', () => {
  const { mb } = setup();
  const img = (d: string) => ({ kind: 'image' as const, url: 'https://a.example/m.png', description: d });
  const s = mb.post(A, { text: 'pics', media: [img('a cat'), img('')] });
  assert.deepEqual(mb.missingAlt(s.id).map((m) => m.description), ['']);
  assert.equal(s.media.length, 2);
  assert.throws(() => mb.post(A, { text: 'x', media: [img('1'), img('2'), img('3'), img('4'), img('5')] }), /at most 4/);
  assert.throws(() => mb.post(A, { text: 'x', media: [img('1'), { kind: 'video', url: 'https://a.example/v.mp4', description: '' }] }), /go alone|all be images/);
  assert.equal(mb.post(A, { text: 'x', media: [{ kind: 'video', url: 'https://a.example/v.mp4', description: 'clip' }] }).media[0]!.kind, 'video');
  assert.throws(() => mb.post(A, { text: 'x', media: [img('x'.repeat(1501))] }), /alt text/);
  assert.throws(() => mb.post(A, { text: 'x', media: [{ kind: 'image', url: 'http://a.example/m.png', description: '' }] }), /https/);
  assert.throws(() => mb.post(A, { text: 'x', media: [img('a')], poll: { options: ['a', 'b'], expiresInMs: 600_000 } }), /not both/);
});

test('edit keeps history and re-reads tags; only the author edits; delete leaves a tombstone and removes boosts', () => {
  const { mb, tick } = setup();
  const s = mb.post(A, { text: 'first #one' });
  tick(5000);
  const e = mb.edit(A, s.id, { text: 'second #two' });
  assert.deepEqual([e.text, e.tags, e.history.map((h) => h.text)], ['second #two', ['two'], ['first #one']]);
  assert.equal(e.editedAt, s.createdAt + 5000);
  assert.equal(mb.edit(A, s.id, { text: 'second #two' }).history.length, 1, 'no change, no new version');
  assert.throws(() => mb.edit(B, s.id, { text: 'hijack' }), /only the author/);
  const boost = mb.boost(B, s.id);
  mb.delete(A, s.id);
  assert.equal(mb.get(s.id)!.deleted, true);
  assert.equal(mb.get(s.id)!.text, '');
  assert.equal(mb.get(boost.id)!.deleted, true);
  assert.throws(() => mb.edit(A, s.id, { text: 'x' }), /no status/);
  assert.equal(mb.canSee(A, mb.get(s.id)!), false);
  assert.throws(() => mb.delete(B, mb.post(A, { text: 'y' }).id), /only the author/);
});

test('threads show ancestors and descendants the viewer may see', () => {
  const { mb, tick, follow } = setup();
  const root = mb.post(A, { text: 'root' });
  tick(1);
  const r1 = mb.post(B, { text: 'r1', inReplyTo: root.id });
  tick(1);
  const hidden = mb.post(C, { text: 'r2', inReplyTo: r1.id, visibility: 'private' });
  tick(1);
  const deep = mb.post(D, { text: 'r3', inReplyTo: r1.id });
  const t = mb.thread(r1.id, D);
  assert.deepEqual(t.ancestors.map((s) => s.id), [root.id]);
  assert.deepEqual(t.descendants.map((s) => s.id), [deep.id]);
  follow(D, C);
  assert.equal(mb.thread(r1.id, C).descendants.length, 2, 'carol sees her own and dan’s');
  void hidden;
});

test('lists hold only people the owner follows, and show their statuses by the replies policy', () => {
  const { mb, tick } = setup([[A, B], [A, C]]);
  const l = mb.createList(A, 'Friends', { repliesPolicy: 'list' });
  assert.throws(() => mb.addToList(A, l.id, D), /only people its owner follows/);
  mb.addToList(A, l.id, B);
  assert.throws(() => mb.addToList(B, l.id, C), /not your list/);
  const post = mb.post(B, { text: 'hello' });
  tick(1);
  mb.post(C, { text: 'not on the list' });
  const reply = mb.post(B, { text: 'to a stranger', inReplyTo: mb.post(D, { text: 'stranger' }).id });
  tick(1);
  const own = mb.post(B, { text: 'reply to alice', inReplyTo: mb.post(A, { text: 'mine' }).id });
  assert.deepEqual(mb.listStatuses(A, l.id).map((s) => s.id), [own.id, post.id]);
  void reply;
  mb.removeFromList(A, l.id, B);
  assert.equal(mb.listStatuses(A, l.id).length, 0);
  assert.throws(() => mb.createList(A, ' '), /1 to 100/);
  const ex = mb.createList(A, 'Close', { exclusive: true });
  mb.addToList(A, ex.id, C);
  assert.equal(mb.inExclusiveList(A, mb.post(C, { text: 'x' })), true);
  assert.equal(mb.inExclusiveList(A, mb.post(B, { text: 'x' })), false);
  mb.deleteList(A, l.id);
  assert.equal(mb.list(l.id), undefined);
});

test('ActivityPub addressing for each visibility, and the reverse', () => {
  const f = `${A}/followers`;
  assert.deepEqual(addressing('public', f, [B]), { to: [PUBLIC], cc: [f, B] });
  assert.deepEqual(addressing('unlisted', f, [B]), { to: [f], cc: [PUBLIC, B] });
  assert.deepEqual(addressing('private', f, [B]), { to: [f], cc: [B] });
  assert.deepEqual(addressing('direct', f, [B]), { to: [B], cc: [] });
  for (const v of ['public', 'unlisted', 'private', 'direct'] as const) {
    const a = addressing(v, f, [B]);
    assert.equal(visibilityFrom(a.to, a.cc, f), v);
  }
});

const ctx = {
  statusUrl: (id: string) => `https://a.example/statuses/${id}`,
  followersOf: (a: string) => `${a}/followers`,
  activityUrl: (id: string) => `https://a.example/activities/${id}`,
  htmlOf: (s: Status) => `<p>${s.text}</p>`,
};

test('toActivity makes a Create(Note) with warning, tags, mentions, media and reply, and a Question for a poll', () => {
  const { mb } = setup();
  const root = mb.post(B, { text: 'q' });
  const s = mb.post(A, { text: 'hi @bob #x', spoilerText: 'cw', inReplyTo: root.id, visibility: 'unlisted', media: [{ kind: 'image', url: 'https://a.example/i.png', description: 'alt' }], language: 'en' });
  const act = toActivity(s, A, ctx);
  const note = act['object'] as Record<string, unknown>;
  assert.equal(act['type'], 'Create');
  assert.equal(act['actor'], A);
  assert.deepEqual(act['to'], [`${A}/followers`]);
  assert.deepEqual(act['cc'], [PUBLIC, B]);
  assert.equal(note['type'], 'Note');
  assert.equal(note['summary'], 'cw');
  assert.equal(note['sensitive'], true);
  assert.equal(note['inReplyTo'], `https://a.example/statuses/${root.id}`);
  assert.deepEqual(note['tag'], [{ type: 'Mention', href: B }, { type: 'Hashtag', name: '#x' }]);
  assert.deepEqual(note['attachment'], [{ type: 'Image', url: 'https://a.example/i.png', name: 'alt' }]);
  const q = mb.post(A, { text: 'pick', poll: { options: ['a', 'b'], expiresInMs: 600_000 } });
  const qn = toActivity(q, A, ctx)['object'] as Record<string, unknown>;
  assert.equal(qn['type'], 'Question');
  assert.deepEqual((qn['oneOf'] as { name: string }[]).map((o) => o.name), ['a', 'b']);
  const bo = toActivity(mb.boost(C, s.id), C, ctx);
  assert.equal(bo['type'], 'Announce');
  assert.equal(bo['object'], `https://a.example/statuses/${s.id}`);
});

test('fromNote reads a remote note back, refuses other types and notes off their author’s host', () => {
  const { mb } = setup();
  const s = mb.post(A, { text: 'round trip #trip', spoilerText: 'cw', visibility: 'private', media: [{ kind: 'image', url: 'https://a.example/i.png', description: 'alt' }] });
  const note = toActivity(s, A, ctx)['object'] as never;
  const r = fromNote(note, ctx.followersOf);
  assert.deepEqual([r.url, r.author, r.visibility, r.spoilerText, r.sensitive, r.tags], [`https://a.example/statuses/${s.id}`, A, 'private', 'cw', true, ['trip']]);
  assert.deepEqual(r.media, [{ kind: 'image', url: 'https://a.example/i.png', description: 'alt' }]);
  assert.throws(() => fromNote({ ...(note as object), type: 'Article' } as never, ctx.followersOf), /only a Note/);
  assert.throws(() => fromNote({ ...(note as object), attributedTo: B } as never, ctx.followersOf), /not on its author/);
  assert.throws(() => fromNote({ type: 'Note' } as never, ctx.followersOf), /needs an id/);
  const q = fromNote({ id: 'https://a.example/q', type: 'Question', attributedTo: A, oneOf: [{ name: 'x' }, { name: 'y' }], to: [PUBLIC], cc: [] } as never, ctx.followersOf);
  assert.deepEqual(q.pollOptions, ['x', 'y']);
  assert.equal(q.visibility, 'public');
});
