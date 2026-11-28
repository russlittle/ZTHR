import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { Recorder, Tracker, type Hit } from '../mail-tracking/index.ts';
import { CampaignError, Campaigns, matches, render, SendFailure, type CampaignDef, type Contact, type Message, type Segment } from './index.ts';

const T0 = Date.UTC(2026, 5, 1, 9, 0, 0);
const human = (at: number): Hit => ({ at, method: 'GET', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/126.0', ip: '203.0.113.5' });

function rig(o: { send?: (m: Message) => Promise<void>; unsub?: (c: Contact) => string } = {}) {
  const clock = { now: T0 };
  const sent: Message[] = [];
  const tracker = new Tracker({ secret: randomBytes(32).toString('base64'), baseUrl: 'https://t.example.com', now: () => clock.now });
  const recorder = new Recorder({ tracker, now: () => clock.now });
  const camp = new Campaigns({
    tracker,
    recorder,
    now: () => clock.now,
    domain: 'mail.example.com',
    unsubscribeUrl: o.unsub ?? ((c) => `https://app.example.com/unsub?c=${encodeURIComponent(c.id)}`),
    send: o.send ?? (async (m) => void sent.push(m)),
  });
  return { clock, sent, tracker, recorder, camp };
}
const def = (o: Partial<CampaignDef> = {}): CampaignDef => ({
  id: 'spring',
  name: 'Spring sale',
  from: { email: 'news@mail.example.com', name: 'Example' },
  subject: 'Hello {{first_name|friend}}',
  html: '<html><body><p>Hi {{first_name|there}}</p><a href="https://shop.example.org/sale?a=1&amp;b=2">Sale</a> <a href="{{unsubscribe_url}}">Unsubscribe</a></body></html>',
  segment: { everyone: true },
  sendAt: T0,
  perMinute: 600,
  ...o,
});
const people = (n: number, f: (i: number) => Partial<Contact> = () => ({})): Contact[] => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, email: `user${i}@example.net`, attrs: { first_name: `User${i}`, plan: i % 2 ? 'pro' : 'free', age: 20 + i }, ...f(i) }));

test('segments combine with all, any and not, and read attributes, tags and the address', () => {
  const c: Contact = { id: 'a', email: 'Ada@Example.com', attrs: { plan: 'pro', age: 36, vip: true, name: 'Ada Lovelace' }, tags: ['news', 'beta'] };
  const m = (s: Segment) => matches(s, c);
  assert.equal(m({ everyone: true }), true);
  assert.equal(m({ field: 'plan', op: 'eq', value: 'pro' }), true);
  assert.equal(m({ field: 'plan', op: 'in', value: ['free', 'team'] }), false);
  assert.equal(m({ field: 'age', op: 'gte', value: 36 }), true);
  assert.equal(m({ field: 'age', op: 'lt', value: 36 }), false);
  assert.equal(m({ field: 'age', op: 'gt', value: '30' }), false, 'a number is not compared with text');
  assert.equal(m({ field: 'vip', op: 'eq', value: true }), true);
  assert.equal(m({ field: 'name', op: 'contains', value: 'LOVE' }), true);
  assert.equal(m({ field: 'name', op: 'startsWith', value: 'ada' }), true);
  assert.equal(m({ field: 'email', op: 'contains', value: '@example.com' }), true);
  assert.equal(m({ field: 'region', op: 'exists' }), false);
  assert.equal(m({ field: 'region', op: 'ne', value: 'eu' }), true);
  assert.equal(m({ tag: 'beta' }), true);
  assert.equal(m({ all: [{ tag: 'news' }, { not: { tag: 'blocked' } }] }), true);
  assert.equal(m({ any: [{ tag: 'x' }, { field: 'plan', op: 'eq', value: 'free' }] }), false);
  assert.equal(m({ all: [] }), true);
  assert.equal(m({ any: [] }), false);
});

test('hostile segments are refused, and attribute names cannot reach the prototype', () => {
  const c: Contact = { id: 'a', email: 'a@example.com' };
  assert.equal(matches({ field: '__proto__', op: 'exists' }, c), false);
  assert.equal(matches({ field: 'constructor', op: 'exists' }, c), false);
  assert.throws(() => matches({ field: 'x', op: 'regex' as never, value: '.*' }, c), CampaignError);
  assert.throws(() => matches({ bogus: 1 } as never, c), /not a segment/);
  assert.throws(() => matches(null as never, c), CampaignError);
  let deep: Segment = { everyone: true };
  for (let i = 0; i < 20; i++) deep = { not: deep };
  assert.throws(() => matches(deep, c), /nested too deeply/);
  assert.throws(() => matches({ all: Array.from({ length: 300 }, () => ({ everyone: true as const })) }, c), /too many/);
});

test('templates fill in values, escape them for html, use fallbacks, and never expand twice', () => {
  assert.equal(render('Hi {{name}}', { name: 'Ann' }, { html: true }), 'Hi Ann');
  assert.equal(render('<p>{{x}}</p>', { x: '<script>alert("1")</script> & \'q\'' }, { html: true }), '<p>&lt;script&gt;alert(&quot;1&quot;)&lt;/script&gt; &amp; &#39;q&#39;</p>');
  assert.equal(render('{{ n }} / {{n|none}} / {{m|none}}', { n: 5 }, {}), '5 / 5 / none');
  assert.equal(render('{{a}}', { a: '{{b}}', b: 'LEAK' }, {}), '{{b}}');
  assert.equal(render('{{ok}}', { ok: true }, {}), 'true');
  assert.throws(() => render('{{missing}}', {}, {}), /no value for "missing"/);
  assert.equal(render('plain {braces} {{ }}', {}, {}), 'plain {braces} {{ }}');
});

test('a campaign definition must be complete: sender, subject, an unsubscribe link and a sane pace', () => {
  const { camp } = rig();
  assert.throws(() => camp.create(def({ html: '<p>no way out</p>' })), /unsubscribe_url/);
  assert.throws(() => camp.create(def({ from: { email: 'nope' } })), /sender/);
  assert.throws(() => camp.create(def({ from: { email: 'a@b.test\r\nBcc: x@y.test' } })), /sender/);
  assert.throws(() => camp.create(def({ subject: '  ' })), /subject/);
  assert.throws(() => camp.create(def({ perMinute: 0 })), /perMinute/);
  assert.throws(() => camp.create(def({ perMinute: 1e6 })), /perMinute/);
  assert.throws(() => camp.create(def({ id: 'a b' })), /id/);
  assert.throws(() => camp.create(def({ variants: [{ id: 'a' }] })), /two to five variants/);
  assert.throws(() => camp.create(def({ variants: [{ id: 'a' }, { id: 'a' }] })), /twice/);
  assert.throws(() => camp.create(def({ ab: { testPercent: 20, metric: 'opens', waitMs: 1 } })), /needs variants/);
  camp.create(def());
  assert.throws(() => camp.create(def()), /already exists/);
  assert.throws(() => camp.report('nope'), /no campaign/);
});

test('planning leaves out people who must not be mailed and says why', () => {
  const { camp } = rig();
  camp.create(def({ segment: { not: { tag: 'internal' } } }));
  const list: Contact[] = [
    { id: '1', email: 'a@example.net' },
    { id: '2', email: 'b@example.net', status: 'unsubscribed' },
    { id: '3', email: 'c@example.net', status: 'bounced' },
    { id: '4', email: 'd@example.net', status: 'complained' },
    { id: '5', email: 'not-an-address' },
    { id: '6', email: 'A@Example.net' },
    { id: '7', email: 'e@example.net', tags: ['internal'] },
    { id: '8', email: 'f@example.net\r\nBcc: x@y.test' },
    { id: '1', email: 'g@example.net' },
    { id: '9', email: 'h@example.net', status: 'subscribed' },
  ];
  const p = camp.plan('spring', list);
  assert.equal(p.planned, 2);
  assert.equal(p.notInSegment, 1);
  assert.deepEqual(p.excluded.map((e) => [e.id, e.why]), [['2', 'unsubscribed'], ['3', 'bounced'], ['4', 'complained'], ['5', 'not a valid email address'], ['6', 'same address as an earlier contact'], ['8', 'not a valid email address'], ['1', 'same contact id as an earlier contact']]);
  assert.throws(() => camp.plan('spring', list), /already planned/);
});

test('nothing goes out before the send time, and a message is personal, tracked and carries unsubscribe headers', async () => {
  const { camp, sent, clock, tracker } = rig();
  camp.create(def({ sendAt: T0 + 3_600_000 }));
  camp.plan('spring', people(1));
  assert.deepEqual(await camp.tick(), { sent: 0, failed: 0, bounced: 0, skipped: 0, retrying: 0, waiting: 1 });
  clock.now = T0 + 3_600_000;
  assert.equal((await camp.tick()).sent, 1);
  const m = sent[0]!;
  assert.equal(m.subject, 'Hello User0');
  assert.deepEqual([m.to.email, m.from.email, m.campaign, m.variant], ['user0@example.net', 'news@mail.example.com', 'spring', 'main']);
  assert.match(m.messageId, /^<[a-f0-9]{24}@mail\.example\.com>$/);
  assert.ok(m.html.includes('Hi User0'));
  assert.equal([...m.html.matchAll(/t\.example\.com\/t\/c\//g)].length, 1, 'the sale link is tracked');
  assert.ok(m.html.includes('data-track="off" href="https://app.example.com/unsub?c=c0"'), 'the unsubscribe link is not');
  assert.ok(m.html.includes('/t/o/'));
  assert.deepEqual([m.headers['List-Unsubscribe'], m.headers['List-Unsubscribe-Post'], m.headers['Precedence']], ['<https://app.example.com/unsub?c=c0>', 'List-Unsubscribe=One-Click', 'bulk']);
  assert.match(m.text, /Hi User0/);
  assert.ok(!/<\w/.test(m.text));
  assert.ok(tracker.rewriteHtml('x', { campaign: 'c' }).html.includes('/t/o/'));
});

test('sending is throttled to the stated rate, in order, with no burst beyond the batch', async () => {
  const { camp, sent, clock } = rig();
  camp.create(def({ perMinute: 6, batch: 2 }));
  camp.plan('spring', people(6));
  assert.equal((await camp.tick()).sent, 2, 'a full bucket allows the batch');
  assert.equal((await camp.tick()).sent, 0);
  clock.now += 10_000;
  assert.equal((await camp.tick()).sent, 1, 'six a minute is one every ten seconds');
  clock.now += 3_600_000;
  assert.equal((await camp.tick()).sent, 2, 'an idle hour does not bank more than the batch');
  clock.now += 3_600_000;
  assert.equal((await camp.tick()).sent, 1);
  assert.deepEqual(sent.map((m) => m.contact), ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
  assert.equal(camp.report('spring').state, 'done');
});

test('a contact whose data lacks a required value is skipped, not sent a broken mail', async () => {
  const { camp, sent } = rig();
  camp.create(def({ subject: 'For {{company}}' }));
  camp.plan('spring', [{ id: 'a', email: 'a@example.net', attrs: { company: 'Acme' } }, { id: 'b', email: 'b@example.net' }]);
  const t = await camp.tick();
  assert.deepEqual([t.sent, t.skipped], [1, 1]);
  assert.deepEqual(sent.map((m) => m.subject), ['For Acme']);
  assert.deepEqual(camp.report('spring').skipped, [{ id: 'b', why: 'no value for "company"' }]);
});

test('temporary failures are retried later with a growing wait, then given up on', async () => {
  let calls = 0;
  const { camp, clock } = rig({ send: async () => { calls++; throw new SendFailure('mailbox busy', false); } });
  camp.create(def({ maxAttempts: 3 }));
  camp.plan('spring', people(1));
  assert.deepEqual(await camp.tick(), { sent: 0, failed: 0, bounced: 0, skipped: 0, retrying: 1, waiting: 0 });
  assert.equal((await camp.tick()).retrying, 0, 'not due yet');
  clock.now += 60_000;
  assert.equal((await camp.tick()).retrying, 1);
  clock.now += 119_000;
  assert.equal((await camp.tick()).retrying, 0, 'the second wait is twice as long');
  clock.now += 1_000;
  const last = await camp.tick();
  assert.deepEqual([last.failed, calls], [1, 3]);
  const r = camp.report('spring');
  assert.deepEqual([r.counts.failed, r.failed], [1, [{ id: 'c0', why: 'mailbox busy' }]]);
});

test('a permanent refusal is a bounce: never retried, and the contact is reported for suppression', async () => {
  const { camp } = rig({ send: async (m) => { if (m.to.email.startsWith('user1@')) throw new SendFailure('550 no such user', true); } });
  camp.create(def());
  camp.plan('spring', people(3));
  const t = await camp.tick();
  assert.deepEqual([t.sent, t.bounced], [2, 1]);
  assert.deepEqual(camp.bounces('spring'), [{ id: 'c1', email: 'user1@example.net', why: '550 no such user' }]);
  assert.equal((await camp.tick()).bounced, 0);
  const odd = rig({ send: async () => { throw new Error('socket hang up'); } });
  odd.camp.create(def());
  odd.camp.plan('spring', people(1));
  assert.equal((await odd.camp.tick()).retrying, 1, 'an unknown error is treated as temporary');
});

test('a link that is not https cannot be used as the unsubscribe address', async () => {
  const { camp, sent } = rig({ unsub: (c) => `http://app.example.com/u/${c.id}` });
  camp.create(def());
  camp.plan('spring', people(1));
  const t = await camp.tick();
  assert.deepEqual([t.sent, t.failed, sent.length], [0, 1, 0]);
  assert.equal(camp.report('spring').failed[0]!.why, 'the unsubscribe link must be https');
});

test('overlapping ticks never send the same message twice', async () => {
  let n = 0;
  const { camp } = rig({ send: async () => { n++; await new Promise((r) => setTimeout(r, 5)); } });
  camp.create(def());
  camp.plan('spring', people(5));
  const all = await Promise.all([camp.tick(), camp.tick(), camp.tick()]);
  assert.equal(n, 5);
  assert.equal(all.reduce((a, t) => a + t.sent, 0), 5);
});

test('pausing stops sending, resuming carries on, and cancelling is final', async () => {
  const { camp, sent } = rig();
  camp.create(def({ perMinute: 600 }));
  camp.plan('spring', people(3));
  camp.pause('spring');
  assert.equal((await camp.tick()).sent, 0);
  assert.equal(camp.report('spring').state, 'paused');
  camp.resume('spring');
  assert.equal((await camp.tick()).sent, 3);
  const b = rig();
  b.camp.create(def());
  b.camp.plan('spring', people(3));
  b.camp.cancel('spring');
  assert.equal((await b.camp.tick()).sent, 0);
  assert.equal(b.camp.report('spring').state, 'cancelled');
  assert.equal(b.camp.report('spring').counts.cancelled, 3);
  assert.throws(() => b.camp.resume('spring'), /cancelled/);
  assert.equal(sent.length, 3);
});

test('variants are assigned by a stable hash, in proportion to their weights', async () => {
  const { camp, sent } = rig();
  camp.create(def({ perMinute: 6000, batch: 1000, variants: [{ id: 'a', subject: 'A: {{first_name}}', weight: 3 }, { id: 'b', subject: 'B: {{first_name}}', weight: 1 }] }));
  camp.plan('spring', people(400));
  await camp.tick();
  const a = sent.filter((m) => m.variant === 'a').length;
  assert.equal(a + sent.filter((m) => m.variant === 'b').length, 400);
  assert.ok(a > 270 && a < 330, `about three quarters get A, got ${a}`);
  assert.ok(sent.every((m) => m.subject.startsWith(m.variant.toUpperCase() + ': ')));
  const again = rig();
  again.camp.create(def({ perMinute: 6000, batch: 1000, variants: [{ id: 'a', weight: 3 }, { id: 'b', weight: 1 }] }));
  again.camp.plan('spring', people(400));
  await again.camp.tick();
  assert.deepEqual(again.sent.map((m) => m.variant), sent.map((m) => m.variant), 'the same contact lands on the same variant every time');
});

test('an A/B test mails a share first, waits, then sends the rest the winner', async () => {
  const { camp, sent, clock, recorder } = rig();
  camp.create(def({ perMinute: 6000, batch: 1000, variants: [{ id: 'a', subject: 'A' }, { id: 'b', subject: 'B' }], ab: { testPercent: 20, metric: 'opens', waitMs: 3_600_000, minPerVariant: 5 } }));
  const p = camp.plan('spring', people(100));
  assert.equal(p.planned, 100);
  const first = await camp.tick();
  assert.equal(first.sent, 20, 'only the test share goes out');
  assert.equal(first.waiting, 80);
  assert.equal(camp.report('spring').state, 'waiting');
  const byVariant = (v: string) => sent.filter((m) => m.variant === v);
  assert.ok(byVariant('a').length >= 5 && byVariant('b').length >= 5);
  clock.now += 60_000;
  for (const m of byVariant('b')) recorder.open(m.html.match(/\/t\/o\/([^"]+)\.gif/)![1]!, human(clock.now));
  clock.now += 100_000;
  assert.equal((await camp.tick()).sent, 0, 'still inside the waiting time');
  clock.now += 3_600_000;
  const rest = await camp.tick();
  assert.equal(rest.sent, 80);
  assert.ok(sent.slice(20).every((m) => m.variant === 'b'));
  const r = camp.report('spring');
  assert.deepEqual(r.winner, { variant: 'b', reason: 'b had the higher open rate (100% against 0%)' });
  assert.equal(r.state, 'done');
});

test('an A/B test with too little data, or a tie, falls back to the first variant and says so', async () => {
  const { camp, clock } = rig();
  camp.create(def({ perMinute: 6000, batch: 1000, variants: [{ id: 'a' }, { id: 'b' }], ab: { testPercent: 10, metric: 'clicks', waitMs: 1000, minPerVariant: 50 } }));
  camp.plan('spring', people(100));
  await camp.tick();
  clock.now += 2000;
  await camp.tick();
  assert.equal(camp.report('spring').winner?.variant, 'a');
  assert.match(camp.report('spring').winner!.reason, /fewer than 50 sent/);
  const t = rig();
  t.camp.create(def({ id: 'tie', perMinute: 6000, batch: 1000, variants: [{ id: 'x' }, { id: 'y' }], ab: { testPercent: 20, metric: 'opens', waitMs: 1000 } }));
  t.camp.plan('tie', people(50));
  await t.camp.tick();
  t.clock.now += 2000;
  await t.camp.tick();
  assert.deepEqual(t.camp.report('tie').winner, { variant: 'x', reason: 'no difference between the variants, so the first is used' });
});

test('the report joins what was sent with what came back, by variant and overall', async () => {
  const { camp, sent, clock, recorder } = rig();
  camp.create(def({ perMinute: 6000, batch: 1000 }));
  camp.plan('spring', people(10));
  await camp.tick();
  clock.now += 120_000;
  const tok = (m: Message, re: RegExp) => m.html.match(re)![1]!;
  for (const m of sent.slice(0, 4)) recorder.open(tok(m, /\/t\/o\/([^"]+)\.gif/), human(clock.now));
  recorder.click(tok(sent[0]!, /\/t\/c\/([^"]+)"/), human(clock.now));
  recorder.click(tok(sent[9]!, /\/t\/c\/([^"]+)"/), human(clock.now));
  recorder.open(tok(sent[5]!, /\/t\/o\/([^"]+)\.gif/), { ...human(clock.now), ip: '17.4.4.4' });
  const r = camp.report('spring');
  assert.equal(r.counts.sent, 10);
  assert.deepEqual([r.overall.opens, r.overall.proxyOpens, r.overall.uniqueClicks], [5, 1, 2]);
  assert.deepEqual([r.overall.openRate, r.overall.clickRate], [0.5, 0.2]);
  assert.deepEqual(Object.keys(r.variants), ['main']);
  assert.equal(r.variants['main']!.sent, 10);
  assert.equal(r.state, 'done');
});
