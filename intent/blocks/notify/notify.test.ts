import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Notify, Reminder, localHour, render, type Message } from './index.ts';

const shared = { key: 'shared', category: 'sharing', subject: '{{who}} shared {{name}}', body: '<p>{{who}} shared <b>{{name}}</b></p>' };
const reset = { key: 'reset', category: 'security', subject: 'Reset your password', body: '<a href="{{url}}">Reset</a>', essential: true };

test('templates escape values and refuse a missing one', () => {
  assert.equal(render('<p>{{x}}</p>', { x: '<script>' }), '<p>&#60;script&#62;</p>');
  assert.throws(() => render('{{a}} {{b}}', { a: 1 }), /needs b/);
});

test('quiet hours in their own zone hold mail until morning; essential mail goes at once', async () => {
  let now = new Date('2026-11-26T04:00:00Z');
  const sent: Message[] = [];
  const n = new Notify({ send: async (m) => void sent.push(m), secret: 's', unsubscribeUrl: 'https://x.example/u', now: () => now });
  n.setPrefs('ana', { tz: 'America/New_York', quiet: [22, 7], categories: { sharing: { channels: ['email'] } } });
  assert.equal(localHour(now, 'America/New_York'), 23);
  const [r] = await n.notify('ana', 'ana@example.org', { ...shared }, { who: 'Ben', name: 'Plans' }, {});
  assert.equal(r!.outcome, 'held');
  await n.notify('ana', 'ana@example.org', reset, { url: 'https://x' });
  assert.equal(sent.length, 1, 'the reset is not held');
  assert.equal(sent[0]!.headers['List-Unsubscribe'], undefined, 'and has no unsubscribe link');
  assert.equal(await n.release(), 0, 'still night');
  now = new Date('2026-11-26T13:00:00Z');
  assert.equal(await n.release(), 1);
  assert.match(sent[1]!.headers['List-Unsubscribe']!, /^<https:\/\/x\.example\/u\?t=/);
  assert.equal(sent[1]!.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

test('one-click unsubscribe, bounces, digests and receipts', async () => {
  const sent: Message[] = [];
  const n = new Notify({ send: async (m) => void sent.push(m), secret: 's', unsubscribeUrl: 'https://x.example/u', now: () => new Date('2026-11-26T15:00:00Z') });
  n.setPrefs('ben', { tz: 'UTC', categories: { sharing: { channels: ['email'], digest: true } } });
  await n.notify('ben', 'ben@example.org', shared, { who: 'Ana', name: 'A' });
  await n.notify('ben', 'ben@example.org', shared, { who: 'Ana', name: 'B' });
  assert.equal(sent.length, 0);
  assert.equal(await n.digest('ben', 'ben@example.org'), true);
  assert.equal(sent[0]!.subject, '2 updates');
  assert.equal(await n.digest('ben', 'ben@example.org'), false, 'nothing twice');
  assert.equal(n.unsubscribe('forged.token'), undefined);
  assert.deepEqual(n.unsubscribe(n.token('ben', 'sharing')), { who: 'ben', category: 'sharing' });
  const [off] = await n.notify('ben', 'ben@example.org', shared, { who: 'Ana', name: 'C' });
  assert.equal(off!.outcome, 'off');
  n.bounce('CY@example.org', 'hard');
  const [sup] = await n.notify('cy', 'cy@example.org', reset, { url: 'u' });
  assert.equal(sup!.outcome, 'suppressed');
  assert.deepEqual(n.sentTo('ben').map((r) => r.outcome), ['digest', 'digest', 'sent', 'off']);
});

test('a reminder stops the moment the thing is done, or after its limit', async () => {
  let done = false;
  let fired = 0;
  const r = new Reminder(() => done, async () => void fired++, 3);
  await r.tick();
  await r.tick();
  done = true;
  await r.tick();
  await r.tick();
  assert.equal(fired, 2);
  assert.equal(r.stopped, 'done');
  const g = new Reminder(() => false, async () => {}, 2);
  for (let i = 0; i < 5; i++) await g.tick();
  assert.equal(g.sent, 2);
  assert.equal(g.stopped, 'gave up');
});
