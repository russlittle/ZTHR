import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Catalogue, Hub } from '../events/index.ts';
import { ChannelError, Channels, eventTypes } from './index.ts';

const DAY = 86_400_000;
const USERS = ['ana', 'bo', 'cy', 'di', 'channel'];
function mk(o: Partial<ConstructorParameters<typeof Channels>[0]> = {}) {
  let t = Date.UTC(2026, 0, 5, 12);
  const ch = new Channels({ person: (h) => (USERS.includes(h) ? h : undefined), now: () => t, ...o });
  return { ch, tick: (ms: number) => void (t += ms), now: () => t };
}

test('names: normalised, validated and unique among channels; direct channels do not take names', () => {
  const { ch } = mk();
  assert.equal(ch.create('ana', { name: ' General ', kind: 'public' }).name, 'general');
  assert.throws(() => ch.create('bo', { name: 'general', kind: 'private' }), /taken/);
  for (const bad of ['', 'has space', '-lead', 'x'.repeat(41), '#general', 'a/b', 'ünï'])
    assert.throws(() => ch.create('ana', { name: bad, kind: 'public' }), /1 to 40 lower-case/, bad);
  assert.throws(() => ch.create('ana', { name: 'x', kind: 'direct' as 'public' }), /public or private/);
  assert.throws(() => ch.create('ana', { name: 'x', kind: 'public', retentionDays: 0 }), /whole number of days/);
  assert.throws(() => ch.create('ana', { name: 'x', kind: 'public', topic: 'y'.repeat(251) }), /250/);
  ch.open('ana', 'bo');
  assert.ok(ch.create('ana', { name: 'bo', kind: 'public' }));
});

test('visibility: public is listed for all, private and direct only for members', () => {
  const { ch } = mk();
  const pub = ch.create('ana', { name: 'pub', kind: 'public' });
  const priv = ch.create('ana', { name: 'priv', kind: 'private', members: ['bo'] });
  const dm = ch.open('ana', 'bo');
  assert.deepEqual(ch.visible('cy').map((c) => c.id), [pub.id]);
  assert.deepEqual(ch.visible('bo').map((c) => c.id).sort(), [dm.id, priv.id, pub.id].sort());
  assert.throws(() => ch.get(priv.id, 'cy'), /no channel/);
  assert.throws(() => ch.get(dm.id, 'cy'), /no channel/);
  assert.throws(() => ch.join('cy', priv.id), /no channel/, 'a private channel cannot be joined, and does not admit it exists');
  assert.equal(ch.get(pub.id, 'cy').id, pub.id);
});

test('a direct channel is one per pair, either order, and cannot be changed', () => {
  const { ch } = mk();
  const a = ch.open('ana', 'bo');
  assert.equal(ch.open('bo', 'ana').id, a.id);
  assert.notEqual(ch.open('ana', 'cy').id, a.id);
  assert.throws(() => ch.open('ana', 'ana'), /two different people/);
  assert.throws(() => ch.invite('ana', a.id, 'cy'), /only its two people/);
  assert.throws(() => ch.leave('ana', a.id), /cannot be left/);
  assert.throws(() => ch.remove('ana', a.id, 'bo'), /cannot be changed/);
  assert.throws(() => ch.archive('ana', a.id), /cannot be archived/);
  assert.throws(() => ch.setRole('ana', a.id, 'bo', 'admin'), /cannot be changed/);
});

test('only members post; posting needs text and respects the length limit and archiving', () => {
  const { ch } = mk({ maxLength: 50 });
  const c = ch.create('ana', { name: 'g', kind: 'public' });
  assert.throws(() => ch.post('bo', c.id, 'hi'), /not a member/);
  ch.join('bo', c.id);
  assert.equal(ch.post('bo', c.id, ' hi ').message.text, 'hi');
  assert.throws(() => ch.post('bo', c.id, '   '), ChannelError);
  assert.throws(() => ch.post('bo', c.id, 'x'.repeat(51)), /at most 50/);
  ch.archive('ana', c.id);
  assert.throws(() => ch.post('bo', c.id, 'hi'), /archived/);
  assert.throws(() => ch.join('cy', c.id), /archived/);
  assert.equal(ch.history('cy', c.id).length, 1, 'archived channels can still be read');
  ch.archive('ana', c.id, false);
  ch.post('bo', c.id, 'back');
});

test('mentions notify only members who exist; mentions of outsiders and of the author are dropped', () => {
  const { ch } = mk();
  const c = ch.create('ana', { name: 'g', kind: 'private', members: ['bo'] });
  const r = ch.post('ana', c.id, 'hey @bo and @cy and @nobody and @ana');
  assert.deepEqual([...r.message.mentions].sort(), ['ana', 'bo']);
  assert.deepEqual(r.notify, [{ who: 'bo', reason: 'mention' }], 'cy cannot see the channel, so is not told; the author is not told of themself');
});

test('@channel tells everyone, @here only the active, and a role limit can reserve them; "channel" is never a person', () => {
  const active = new Set(['bo']);
  const { ch } = mk({ isActive: (w) => active.has(w) });
  const c = ch.create('ana', { name: 'g', kind: 'private', members: ['bo', 'cy', 'di'] });
  assert.deepEqual(ch.post('bo', c.id, 'ping @channel').notify.map((n) => [n.who, n.reason]).sort(), [['ana', 'channel'], ['cy', 'channel'], ['di', 'channel']]);
  ch.post('cy', c.id, 'x');
  assert.deepEqual(ch.post('cy', c.id, '@here quick question').notify, [{ who: 'bo', reason: 'here' }]);
  assert.deepEqual(ch.post('cy', c.id, 'email me@channel.example').notify, [], 'a word run into an address is not a broadcast');
  const quiet = ch.create('ana', { name: 'ann', kind: 'private', members: ['bo'], broadcastRole: 'admin' });
  assert.deepEqual(ch.post('bo', quiet.id, '@channel hi').notify, []);
  assert.deepEqual(ch.post('ana', quiet.id, '@channel hi').notify, [{ who: 'bo', reason: 'channel' }]);
  assert.deepEqual(ch.post('ana', quiet.id, 'hi @channel').message.mentions, [], '"channel" is not resolved as the person called channel');
});

test('threads: replies join the root, notify those who took part, and flatten a reply to a reply', () => {
  const { ch } = mk();
  const c = ch.create('ana', { name: 'g', kind: 'private', members: ['bo', 'cy', 'di'] });
  const root = ch.post('ana', c.id, 'question').message;
  const r1 = ch.post('bo', c.id, 'answer', { thread: root.id });
  assert.deepEqual(r1.notify, [{ who: 'ana', reason: 'thread' }]);
  const r2 = ch.post('cy', c.id, 'me too', { thread: r1.message.id });
  assert.equal(r2.message.thread, root.id, 'a reply to a reply lands in the same thread');
  assert.deepEqual(r2.notify.map((n) => n.who).sort(), ['ana', 'bo']);
  assert.deepEqual(ch.thread('di', c.id, root.id).map((m) => m.by), ['ana', 'bo', 'cy']);
  const h = ch.history('ana', c.id);
  assert.equal(h.length, 1, 'replies are not in the main history');
  assert.deepEqual([h[0]!.replies, h[0]!.participants.sort()], [2, ['bo', 'cy']]);
  assert.throws(() => ch.post('ana', c.id, 'x', { thread: 999 }), /no message 999/);
  const other = ch.create('ana', { name: 'h', kind: 'private' });
  assert.throws(() => ch.post('ana', other.id, 'x', { thread: root.id }), /no message/, 'a thread cannot be reached across channels');
  assert.throws(() => ch.thread('ana', c.id, r1.message.id), /no message/, 'only a root opens a thread');
});

test('direct messages notify the other person; muting silences everything but mentions', () => {
  const { ch } = mk();
  const dm = ch.open('ana', 'bo');
  assert.deepEqual(ch.post('ana', dm.id, 'hi').notify, [{ who: 'bo', reason: 'direct' }]);
  ch.mute('bo', dm.id, true);
  assert.deepEqual(ch.post('ana', dm.id, 'hi again').notify, [{ who: 'bo', reason: 'direct' }], 'a direct message is always a direct message');
  const c = ch.create('ana', { name: 'g', kind: 'private', members: ['bo', 'cy'] });
  ch.mute('bo', c.id, true);
  assert.deepEqual(ch.post('ana', c.id, '@channel and @bo').notify.map((n) => [n.who, n.reason]).sort(), [['bo', 'mention'], ['cy', 'channel']]);
  assert.deepEqual(ch.post('ana', c.id, '@channel').notify.map((n) => n.who).sort(), ['cy']);
  assert.throws(() => ch.mute('di', c.id, true), /not a member/);
});

test('membership rules: public join, private invites need an admin, ranks limit removal, the last owner stays', () => {
  const { ch } = mk();
  const c = ch.create('ana', { name: 'g', kind: 'private', members: ['bo', 'cy'] });
  assert.throws(() => ch.invite('bo', c.id, 'di'), /needs the admin role/);
  ch.setRole('ana', c.id, 'bo', 'admin');
  ch.invite('bo', c.id, 'di');
  assert.ok(c.members.has('di'));
  assert.throws(() => ch.setRole('bo', c.id, 'cy', 'admin'), /needs the owner role/);
  assert.throws(() => ch.remove('bo', c.id, 'ana'), /rank or above/);
  assert.throws(() => ch.remove('cy', c.id, 'di'), /admin role/);
  ch.remove('bo', c.id, 'cy');
  assert.equal(c.members.has('cy'), false);
  assert.throws(() => ch.leave('ana', c.id), /last owner/);
  assert.throws(() => ch.setRole('ana', c.id, 'ana', 'member'), /needs an owner/);
  ch.setRole('ana', c.id, 'bo', 'owner');
  ch.leave('ana', c.id);
  assert.throws(() => ch.post('ana', c.id, 'x'), /not a member/);
  const pub = ch.create('bo', { name: 'p', kind: 'public' });
  ch.invite('bo', pub.id, 'di');
  assert.ok(pub.members.has('di'), 'anyone in a public channel may add people');
  const tiny = new Channels({ person: () => undefined, maxMembers: 2 });
  const t = tiny.create('a', { name: 'x', kind: 'public', members: ['b'] });
  assert.throws(() => tiny.join('c', t.id), /at most 2 members/);
});

test('edit and delete: authors edit; admins delete anyone\'s; a deleted message leaves a marker and cannot be edited', () => {
  const { ch } = mk();
  const c = ch.create('ana', { name: 'g', kind: 'private', members: ['bo', 'cy'] });
  const m = ch.post('bo', c.id, 'first').message;
  assert.equal(ch.edit('bo', c.id, m.id, 'second').edited, true);
  assert.throws(() => ch.edit('cy', c.id, m.id, 'hijack'), /only the author/);
  assert.throws(() => ch.delete('cy', c.id, m.id), /author or a moderator/);
  ch.delete('ana', c.id, m.id);
  assert.equal(ch.history('ana', c.id)[0]!.message.deleted, 'removed by a moderator');
  assert.equal(ch.history('ana', c.id)[0]!.message.text, '');
  assert.throws(() => ch.edit('bo', c.id, m.id, 'x'), /deleted/);
  const mine = ch.post('cy', c.id, 'mine').message;
  ch.delete('cy', c.id, mine.id);
  assert.equal(ch.history('ana', c.id)[0]!.message.deleted, 'deleted by its author');
  assert.throws(() => ch.delete('bo', c.id, 12345), /no message/);
});

test('reactions toggle, are per member, and cannot be added by outsiders or with odd names', () => {
  const { ch } = mk();
  const c = ch.create('ana', { name: 'g', kind: 'public' });
  ch.join('bo', c.id);
  const m = ch.post('ana', c.id, 'x').message;
  ch.react('bo', c.id, m.id, ':+1:');
  ch.react('ana', c.id, m.id, ':+1:');
  assert.deepEqual(ch.history('ana', c.id)[0]!.message.reactions, { ':+1:': ['bo', 'ana'] });
  ch.react('bo', c.id, m.id, ':+1:');
  assert.deepEqual(ch.history('ana', c.id)[0]!.message.reactions, { ':+1:': ['ana'] });
  assert.throws(() => ch.react('cy', c.id, m.id, ':+1:'), /not a member/);
  assert.throws(() => ch.react('bo', c.id, m.id, ''), /1 to 32/);
  ch.react('bo', c.id, m.id, '__proto__');
  assert.deepEqual(ch.history('ana', c.id)[0]!.message.reactions['__proto__'], ['bo']);
  assert.equal(({} as Record<string, unknown>)['bo'], undefined, 'Object.prototype was not touched');
});

test('read markers give unread and mention counts, move only forward, and start at the join point', () => {
  const { ch } = mk();
  const c = ch.create('ana', { name: 'g', kind: 'public' });
  ch.post('ana', c.id, 'before bo joined');
  ch.join('bo', c.id);
  assert.deepEqual(ch.unread('bo', c.id), { unread: 0, mentions: 0 }, 'nothing older than the join counts');
  const a = ch.post('ana', c.id, 'one').message;
  ch.post('ana', c.id, 'two @bo');
  ch.post('bo', c.id, 'mine does not count');
  const d = ch.post('ana', c.id, 'three', { thread: a.id }).message;
  assert.deepEqual(ch.unread('bo', c.id), { unread: 3, mentions: 1 });
  assert.equal(ch.markRead('bo', c.id, a.id), a.id);
  assert.deepEqual(ch.unread('bo', c.id), { unread: 2, mentions: 1 });
  assert.equal(ch.markRead('bo', c.id, 1), a.id, 'never moves back');
  assert.equal(ch.markRead('bo', c.id, 9999), d.id, 'clamped to the newest');
  assert.deepEqual(ch.unread('bo', c.id), { unread: 0, mentions: 0 });
  assert.throws(() => ch.unread('cy', c.id), /not a member/);
});

test('pins: admin only in groups, limited, removed with their message', () => {
  const { ch } = mk({ maxPins: 2 });
  const c = ch.create('ana', { name: 'g', kind: 'private', members: ['bo'] });
  const ids = [1, 2, 3].map((i) => ch.post('ana', c.id, `m${i}`).message.id);
  assert.throws(() => ch.pin('bo', c.id, ids[0]!), /admin role/);
  ch.pin('ana', c.id, ids[0]!);
  ch.pin('ana', c.id, ids[0]!);
  ch.pin('ana', c.id, ids[1]!);
  assert.throws(() => ch.pin('ana', c.id, ids[2]!), /at most 2 pins/);
  assert.deepEqual(ch.pinned('bo', c.id).map((m) => [m.text, m.pinned]), [['m1', true], ['m2', true]]);
  ch.delete('ana', c.id, ids[0]!);
  assert.deepEqual(ch.pinned('bo', c.id).map((m) => m.text), ['m2']);
  assert.throws(() => ch.pin('ana', c.id, ids[0]!), /deleted/);
  assert.deepEqual(ch.pin('ana', c.id, ids[1]!, false), []);
  const dm = ch.open('ana', 'bo');
  const x = ch.post('bo', dm.id, 'keep').message;
  assert.equal(ch.pin('bo', dm.id, x.id).length, 1, 'in a direct channel either person may pin');
});

test('retention hides old messages from history, threads, pins and unread', () => {
  const { ch, tick } = mk();
  const c = ch.create('ana', { name: 'g', kind: 'private', members: ['bo'], retentionDays: 7 });
  const old = ch.post('ana', c.id, 'old').message;
  ch.pin('ana', c.id, old.id);
  tick(5 * DAY);
  ch.post('ana', c.id, 'recent');
  assert.equal(ch.history('bo', c.id).length, 2);
  tick(3 * DAY);
  assert.deepEqual(ch.history('bo', c.id).map((h) => h.message.text), ['recent']);
  assert.deepEqual(ch.pinned('bo', c.id), []);
  assert.deepEqual(ch.unread('bo', c.id), { unread: 1, mentions: 0 }, 'only the message inside the window counts');
  assert.throws(() => ch.thread('bo', c.id, old.id), /no message/);
  assert.throws(() => ch.post('ana', c.id, 'x', { thread: old.id }), /no message/);
});

test('history pages backwards with before and limit, capped', () => {
  const { ch } = mk();
  const c = ch.create('ana', { name: 'g', kind: 'public' });
  const ids = Array.from({ length: 30 }, (_, i) => ch.post('ana', c.id, `m${i}`).message.id).reverse();
  const p1 = ch.history('ana', c.id, { limit: 10 });
  const p2 = ch.history('ana', c.id, { limit: 10, before: p1.at(-1)!.message.id });
  assert.deepEqual([...p1, ...p2].map((h) => h.message.id), ids.slice(0, 20));
  assert.equal(ch.history('ana', c.id, { limit: 5000 }).length, 30);
  assert.equal(ch.history('ana', c.id, { limit: 0 }).length, 1);
  assert.throws(() => ch.history('ana', 'nope'), /no channel/);
});

test('events: changes publish CloudEvents through the catalogue and hub; unknown shapes are refused at the catalogue', () => {
  const hub = new Hub();
  const catalogue = new Catalogue(eventTypes);
  const seen: string[] = [];
  hub.subscribe(() => true, (e) => seen.push(`${e.type} ${e.subject} ${JSON.stringify(e.data)}`));
  const { ch } = mk({ hub, catalogue, newId: (() => { let n = 0; return () => `c${++n}`; })() });
  const c = ch.create('ana', { name: 'g', kind: 'public' });
  ch.join('bo', c.id);
  const m = ch.post('bo', c.id, 'hi').message;
  ch.leave('bo', c.id);
  ch.archive('ana', c.id);
  assert.deepEqual(seen, [
    'channels.channel.created c1 {"channel":"c1","kind":"public","by":"ana"}',
    'channels.member.joined c1 {"channel":"c1","who":"bo"}',
    `channels.message.posted c1 {"channel":"c1","message":${m.id},"by":"bo"}`,
    'channels.member.left c1 {"channel":"c1","who":"bo"}',
    'channels.channel.archived c1 {"channel":"c1","archived":true}',
  ]);
  assert.throws(() => catalogue.make('x', 'channels.message.posted', { channel: 'c1' }), /message must be a number/);
});

test('markup in messages is kept as text for the display layer to escape', () => {
  const { ch } = mk();
  const c = ch.create('ana', { name: 'g', kind: 'public' });
  assert.equal(ch.post('ana', c.id, '<script>alert(1)</script> @bo').message.text, '<script>alert(1)</script> @bo');
});
