import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Inbox, InboxError, safeLink } from './index.ts';

const H = 3_600_000;
const D = 24 * H;
function mk(o: ConstructorParameters<typeof Inbox>[0] = {}) {
  let t = 1_700_000_000_000;
  const inbox = new Inbox({ now: () => t, hosts: ['app.example.com'], ...o });
  return { inbox, tick: (ms: number) => void (t += ms), now: () => t };
}
const base = { app: 'docs', kind: 'comment', title: 'Ana commented' };

test('an item is stored with cleaned text and appears in the list newest first', () => {
  const { inbox, tick } = mk();
  const a = inbox.add('u', { ...base, title: ' Hello\u0000‮ world ', body: 'line1\r\nline2' });
  tick(1000);
  const b = inbox.add('u', { ...base, title: 'Second' });
  assert.equal(a.title, 'Hello world');
  assert.equal(a.body, 'line1\nline2');
  assert.deepEqual(inbox.list('u').items.map((i) => i.id), [b.id, a.id]);
  assert.deepEqual(inbox.list('other').items, []);
});

test('markup is kept as text, never interpreted', () => {
  const { inbox } = mk();
  const i = inbox.add('u', { ...base, title: '<img src=x onerror=alert(1)>' });
  assert.equal(i.title, '<img src=x onerror=alert(1)>');
  const d = inbox.digest('u', 0, { subject: 'You have {{count}}', line: '- {{title}}' })!;
  assert.match(d.text, /<img src=x/, 'digest text is plain text, so it is not escaped to HTML either');
});

test('input is validated: names, lengths, actions', () => {
  const { inbox } = mk();
  assert.throws(() => inbox.add('u', { ...base, title: '  ' }), /needs a title/);
  assert.throws(() => inbox.add('u', { ...base, title: 'x'.repeat(201) }), /longer than 200/);
  assert.throws(() => inbox.add('u', { ...base, body: 'x'.repeat(2001) }), /longer than 2000/);
  assert.throws(() => inbox.add('u', { ...base, app: 'Docs!' }), /short lowercase/);
  assert.throws(() => inbox.add('', base), /whose inbox/);
  assert.throws(() => inbox.add('u', { ...base, actions: [1, 2, 3, 4].map((n) => ({ id: `a${n}`, label: 'x', url: '/x' })) }), /at most 3 actions/);
  assert.throws(() => inbox.add('u', { ...base, actions: [{ id: 'a', label: 'x', url: '/x' }, { id: 'a', label: 'y', url: '/y' }] }), /must differ/);
  assert.throws(() => inbox.add('u', { ...base, actions: [{ id: 'A b', label: 'x', url: '/x' }] }), /action id/);
  assert.throws(() => inbox.add('u', { ...base, groupKey: '' }), /group key/);
});

test('links: paths and listed https hosts pass; scripts, data, protocol-relative and tricks are refused', () => {
  const hosts = ['app.example.com'];
  assert.equal(safeLink('/docs/7?x=1#a', hosts), '/docs/7?x=1#a');
  assert.equal(safeLink('https://APP.example.com/a', hosts), 'https://app.example.com/a');
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>', '//evil.example/x', '/\\evil.example', 'http://app.example.com/', 'https://evil.example/', 'https://app.example.com.evil.example/', 'https://user:pw@app.example.com/', 'https://app.example.com@evil.example/', '/a\nb', ' /a', 'vbscript:x', 'x', '', 'https://app.example.com/' + 'a'.repeat(2000)]) {
    assert.throws(() => safeLink(bad, hosts), InboxError, JSON.stringify(bad).slice(0, 60));
  }
  const { inbox } = mk();
  assert.throws(() => inbox.add('u', { ...base, link: 'javascript:alert(1)' }), /link is not allowed/);
  assert.throws(() => inbox.add('u', { ...base, actions: [{ id: 'go', label: 'Go', url: 'https://evil.example/' }] }), /link is not allowed/);
});

test('items with a group key collapse with a count; unread while any member is', () => {
  const { inbox, tick } = mk();
  const ids: string[] = [];
  for (const who of ['ana', 'bo', 'cy']) {
    ids.push(inbox.add('u', { ...base, groupKey: 'doc-7', actor: who, title: `${who} commented on Budget` }).id);
    tick(1000);
  }
  inbox.add('u', { ...base, app: 'tasks', kind: 'assigned', title: 'New task', groupKey: 'doc-7' });
  tick(1000);
  const solo = inbox.add('u', { ...base, title: 'Solo' });
  const groups = inbox.groups('u');
  assert.deepEqual(groups.map((g) => [g.count, g.unread]), [[1, 1], [1, 1], [3, 3]], 'the same key in another app is a different group');
  assert.equal(groups[0]!.latest.id, solo.id);
  const g = groups.find((x) => x.count === 3)!;
  assert.equal(g.latest.title, 'cy commented on Budget');
  assert.deepEqual([...g.ids].sort(), [...ids].sort());
  inbox.markRead('u', [ids[2]!]);
  assert.deepEqual(inbox.groups('u').find((x) => x.count === 3)!.unread, 2);
  assert.equal(inbox.markGroupRead('u', 'docs', 'doc-7'), 2);
  assert.equal(inbox.groups('u').find((x) => x.count === 3)!.unread, 0);
});

test('a duplicate inside the window bumps the existing item and makes it unread again; outside it, a new one', () => {
  const { inbox, tick } = mk({ dedupeWindowMs: H });
  const a = inbox.add('u', { ...base, dedupeKey: 'c1', actor: 'ana', title: 'Ana commented' });
  inbox.markRead('u', [a.id]);
  tick(10 * 60_000);
  const b = inbox.add('u', { ...base, dedupeKey: 'c1', actor: 'bo', title: 'Ana and Bo commented' });
  assert.equal(b.id, a.id);
  assert.equal(b.bumps, 1);
  assert.deepEqual(b.actors, ['ana', 'bo']);
  assert.equal(b.readAt, undefined);
  assert.equal(inbox.list('u').items.length, 1);
  tick(2 * H);
  assert.notEqual(inbox.add('u', { ...base, dedupeKey: 'c1' }).id, a.id);
  assert.notEqual(inbox.add('u', { ...base, app: 'tasks', kind: 'x', dedupeKey: 'c1' }).id, a.id, 'dedupe keys are per app');
});

test('unread counts per app follow read, archive and delete; the change callback hears each change', () => {
  const heard: [string, number][] = [];
  const { inbox } = mk({ onChange: (p, n) => heard.push([p, n]) });
  const a = inbox.add('u', base);
  const b = inbox.add('u', { ...base, app: 'tasks' });
  inbox.add('u', { ...base, app: 'tasks' });
  assert.deepEqual(inbox.unreadCount('u'), { total: 3, byApp: { docs: 1, tasks: 2 } });
  inbox.markRead('u', [a.id]);
  inbox.archive('u', b.id);
  assert.deepEqual(inbox.unreadCount('u'), { total: 1, byApp: { tasks: 1 } });
  assert.equal(inbox.markAllRead('u', 'tasks'), 1);
  assert.deepEqual(inbox.unreadCount('u'), { total: 0, byApp: {} });
  inbox.markRead('u', [a.id], false);
  assert.equal(inbox.unreadCount('v').total, 0);
  inbox.delete('u', a.id);
  assert.deepEqual(heard.at(-1), ['u', 0]);
  assert.deepEqual(heard.slice(0, 3), [['u', 1], ['u', 2], ['u', 3]]);
});

test('one person cannot touch another person\'s items, and a bad id changes nothing', () => {
  const { inbox } = mk();
  const mine = inbox.add('ana', base);
  const other = inbox.add('bo', base);
  assert.throws(() => inbox.markRead('bo', [other.id, mine.id]), /no notification/);
  assert.equal(inbox.get('bo', other.id)!.readAt, undefined, 'nothing was marked before the error');
  assert.throws(() => inbox.archive('bo', mine.id), InboxError);
  assert.throws(() => inbox.delete('bo', mine.id), InboxError);
  assert.throws(() => inbox.act('bo', mine.id), InboxError);
  assert.equal(inbox.get('bo', mine.id), undefined);
});

test('archive hides from the main list, shows in the archive, and restores', () => {
  const { inbox } = mk();
  const a = inbox.add('u', base);
  inbox.archive('u', a.id);
  assert.equal(inbox.list('u').items.length, 0);
  assert.deepEqual(inbox.list('u', { archived: true }).items.map((i) => i.id), [a.id]);
  assert.notEqual(inbox.get('u', a.id)!.readAt, undefined, 'archiving reads it');
  inbox.archive('u', a.id, false);
  assert.equal(inbox.list('u').items.length, 1);
});

test('acting on an item marks it read and returns the action or item link', () => {
  const { inbox } = mk();
  const i = inbox.add('u', { ...base, link: '/docs/7', actions: [{ id: 'approve', label: 'Approve', url: 'https://app.example.com/approve/7' }] });
  assert.equal(inbox.act('u', i.id, 'approve'), 'https://app.example.com/approve/7');
  assert.notEqual(inbox.get('u', i.id)!.readAt, undefined);
  inbox.markRead('u', [i.id], false);
  assert.equal(inbox.act('u', i.id), '/docs/7');
  assert.throws(() => inbox.act('u', i.id, 'nope'), /no action nope/);
  assert.equal(inbox.act('u', inbox.add('u', base).id), undefined);
});

test('paging with opaque cursors is complete, ordered, and stable while new items arrive', () => {
  const { inbox, tick } = mk();
  const ids = Array.from({ length: 25 }, () => (tick(1000), inbox.add('u', base).id)).reverse();
  const p1 = inbox.list('u', { limit: 10 });
  assert.equal(p1.items.length, 10);
  inbox.add('u', base);
  const p2 = inbox.list('u', { limit: 10, cursor: p1.next! });
  const p3 = inbox.list('u', { limit: 10, cursor: p2.next! });
  assert.equal(p3.next, undefined);
  assert.deepEqual([...p1.items, ...p2.items, ...p3.items].map((i) => i.id), ids, 'the new arrival does not shift later pages');
  assert.throws(() => inbox.list('u', { cursor: 'AAAA' }), /cursor is not valid/);
  assert.throws(() => inbox.list('u', { cursor: Buffer.from('x:y').toString('base64url') }), /cursor is not valid/);
  assert.equal(inbox.list('u', { limit: 1000 }).items.length, 26, 'the limit is capped at 100, not exceeded');
  assert.equal(inbox.list('u', { limit: 0 }).items.length, 1, 'a limit below one is one');
  assert.equal(inbox.list('u', { unread: true, app: 'tasks' }).items.length, 0);
});

test('retention: expired items, the age limits (unread kept longer) and the cap that drops read before unread', () => {
  const { inbox, tick, now } = mk({ maxAgeMs: 10 * D, maxUnreadAgeMs: 30 * D });
  const e = inbox.add('u', { ...base, expiresAt: now() + 1 });
  const read = inbox.add('u', base);
  const unread = inbox.add('u', base);
  inbox.markRead('u', [read.id]);
  tick(5);
  assert.equal(inbox.list('u').items.some((i) => i.id === e.id), false, 'past its expiry');
  tick(11 * D);
  assert.deepEqual(inbox.list('u').items.map((i) => i.id), [unread.id], 'the read one aged out, the unread one stays');
  tick(20 * D);
  assert.deepEqual(inbox.list('u').items, []);
  const capped = mk({ maxItems: 3 });
  const a = capped.inbox.add('v', base);
  capped.tick(1);
  const b = capped.inbox.add('v', base);
  capped.tick(1);
  const c = capped.inbox.add('v', base);
  capped.inbox.markRead('v', [b.id]);
  capped.tick(1);
  capped.inbox.add('v', base);
  assert.equal(capped.inbox.list('v').items.length, 3);
  assert.equal(capped.inbox.get('v', b.id), undefined, 'the read item went first');
  assert.ok(capped.inbox.get('v', a.id) && capped.inbox.get('v', c.id));
});

test('digest fills the templates from unread items since a time, refuses missing values, and can say nothing', () => {
  const { inbox, tick, now } = mk();
  inbox.add('u', { ...base, title: 'Old' });
  tick(H);
  const since = now();
  const a = inbox.add('u', { ...base, title: 'A', dedupeKey: 'k' });
  inbox.add('u', { ...base, title: 'B', app: 'tasks', kind: 'assigned' });
  inbox.add('u', { ...base, title: 'A again', dedupeKey: 'k' });
  const read = inbox.add('u', { ...base, title: 'Read one' });
  inbox.markRead('u', [read.id]);
  const d = inbox.digest('u', since, { subject: '{{count}} new for {{name}}', line: '[{{app}}] {{title}} ({{count}})' }, { name: 'Ana' })!;
  assert.equal(d.count, 2);
  assert.equal(d.subject, '2 new for Ana');
  assert.deepEqual(d.text.split('\n').sort(), ['[docs] A again (2)', '[tasks] B (1)']);
  assert.equal(a.bumps, 1);
  assert.throws(() => inbox.digest('u', since, { subject: '{{who}}', line: 'x' }), /needs who/);
  inbox.markAllRead('u');
  assert.equal(inbox.digest('u', since, { subject: 's', line: 'l' }), undefined);
  assert.equal(inbox.digest('u', since, { subject: 's', line: 'l', empty: 'nothing new' })!.text, 'nothing new');
});

test('export and import round-trip an inbox without sharing state', () => {
  const { inbox } = mk();
  const i = inbox.add('u', { ...base, actions: [{ id: 'a', label: 'A', url: '/a' }], actor: 'ana' });
  const data = inbox.export('u');
  const other = mk().inbox;
  other.import('u', data);
  other.import('u', [{ ...data[0]!, person: 'someone-else', id: 'zz' }]);
  assert.deepEqual(other.export('u'), data);
  other.get('u', i.id)!.actions.push({ id: 'b', label: 'B', url: '/b' });
  assert.equal(inbox.get('u', i.id)!.actions.length, 1);
});
