import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, Outbox, SequenceError, checkSequence, merge, fieldsIn, nextOpen } from './index.ts';
import type { Sequence, Step, Contact } from './index.ts';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const MON9 = Date.UTC(2026, 2, 2, 9, 0);
const WINDOW = { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 };
const email = (id: string, delayDays: number, extra: Partial<Step> = {}): Step => ({ id, kind: 'email', wait: { kind: 'delay', minutes: delayDays * 1440 }, subject: `Subject ${id}`, body: `Hi {{first|there}}, this is ${id}.`, ...extra }) as Step;
const seq = (steps: Step[], over: Partial<Sequence> = {}): Sequence => ({ id: 's1', name: 'Outreach', sender: 'sales@example.com', steps, ...over });
const ann: Contact = { id: 'c1', email: 'Ann@Example.com', fields: { first: 'Ann' } };
const mkEngine = () => new Engine({ unsubscribeUrl: (e, em) => `https://example.com/u/${e}?e=${encodeURIComponent(em)}` });

test('merge fields: values, fallbacks, missing names, and prototype-named fields are not values', () => {
  assert.deepEqual(merge('Hi {{first}}', { first: 'Ann' }), { text: 'Hi Ann', missing: [] });
  assert.deepEqual(merge('Hi {{ first | friend }}', {}), { text: 'Hi friend', missing: [] });
  assert.deepEqual(merge('Hi {{first|friend}}', { first: '  ' }), { text: 'Hi friend', missing: [] });
  assert.deepEqual(merge('{{a}} {{b}} {{a}}', {}), { text: '  ', missing: ['a', 'b'] });
  assert.deepEqual(merge('{{constructor}} {{toString|x}}', {}), { text: ' x', missing: ['constructor'] });
  assert.deepEqual(fieldsIn('{{a}} {{b|c}} {{a}}'), ['a', 'b']);
});

test('sequence validation names each problem', () => {
  assert.deepEqual(checkSequence(seq([email('a', 0)])), []);
  const p = checkSequence(seq([], { sender: 'nope', window: { days: [7], startHour: 18, endHour: 9 }, dailyEmailLimit: 0 }));
  assert.ok(p.includes('the sender is not an email address'));
  assert.ok(p.includes('a sequence needs at least one step'));
  assert.ok(p.some((x) => /window days/.test(x)));
  assert.ok(p.some((x) => /window hours/.test(x)));
  assert.ok(p.some((x) => /daily limit/.test(x)));
  assert.ok(checkSequence(seq([email('a', 0), email('a', 1)])).some((x) => /repeated id/.test(x)));
  assert.ok(checkSequence(seq([email('a', 0, { condition: 'previous-opened' })])).some((x) => /first step/.test(x)));
  assert.ok(checkSequence(seq([{ id: 't', kind: 'task', title: ' ', wait: { kind: 'delay', minutes: 0 } }])).some((x) => /task needs a title/.test(x)));
  assert.ok(checkSequence(seq([{ ...email('a', 0), wait: { kind: 'delay', minutes: -1 } } as Step])).some((x) => /delay/.test(x)));
  assert.throws(() => mkEngine().addSequence(seq([])), SequenceError);
});

test('window: inside, before opening, after closing, weekends and UTC offsets', () => {
  const c: Contact = { id: 'x', email: 'a@b.co', fields: {} };
  assert.equal(nextOpen(MON9 + 2 * HOUR, WINDOW, c), MON9 + 2 * HOUR);
  assert.equal(nextOpen(MON9 - 3 * HOUR, WINDOW, c), MON9);
  assert.equal(nextOpen(MON9 + 8 * HOUR, WINDOW, c), MON9 + DAY);
  assert.equal(nextOpen(MON9 + 4 * DAY + 8 * HOUR, WINDOW, c), MON9 + 7 * DAY);
  assert.equal(nextOpen(MON9 + 5 * DAY + 3 * HOUR, WINDOW, c), MON9 + 7 * DAY);
  assert.equal(nextOpen(MON9, undefined, c), MON9);
  // A contact at UTC+2: 09:00 local is 07:00 UTC.
  const east: Contact = { ...c, offsetMinutes: 120 };
  assert.equal(nextOpen(MON9 - 4 * HOUR, WINDOW, east), MON9 - 2 * HOUR);
  assert.throws(() => nextOpen(MON9, { days: [], startHour: 9, endHour: 17 }, c), /never opens/);
});

test('a three-email sequence goes out on its delays and completes', () => {
  const e = mkEngine();
  e.addSequence(seq([email('a', 0), email('b', 2), email('c', 3)]));
  const en = e.enrol('s1', ann, MON9);
  const first = e.due(MON9);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.kind, 'email');
  const m = (first[0] as Extract<(typeof first)[0], { kind: 'email' }>).message;
  assert.equal(m.to, 'ann@example.com');
  assert.equal(m.subject, 'Subject a');
  assert.match(m.text, /^Hi Ann, this is a\./);
  assert.match(m.text, /To stop getting these emails: https:\/\/example\.com\/u\/e1\?e=ann%40example\.com/);
  assert.equal(m.headers['List-Unsubscribe'], '<https://example.com/u/e1?e=ann%40example.com>');
  assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.deepEqual(e.due(MON9 + DAY), []);
  assert.equal(e.due(MON9 + 2 * DAY).length, 1);
  assert.equal(e.due(MON9 + 2 * DAY + 3 * DAY - MIN).length, 0);
  assert.equal(e.due(MON9 + 5 * DAY).length, 1, 'with no window, Saturday is fine');
  assert.equal(en.status, 'completed');
  assert.deepEqual(e.summary('s1'), { active: 0, paused: 0, replied: 0, completed: 1, unsubscribed: 0, bounced: 0, stopped: 0 });
});

test('with a window, email waits for the next opening but tasks do not', () => {
  const e = mkEngine();
  e.addSequence(seq([email('a', 0), email('b', 0)], { window: WINDOW }));
  e.enrol('s1', ann, MON9 + 9 * HOUR);
  assert.equal(e.due(MON9 + 9 * HOUR).length, 0);
  assert.equal(e.nextWake(), MON9 + DAY);
  assert.equal(e.due(MON9 + DAY).length, 2);
  const t = mkEngine();
  t.addSequence(seq([{ id: 't', kind: 'task', title: 'Research {{first}}', wait: { kind: 'delay', minutes: 0 } }], { window: WINDOW }));
  t.enrol('s1', ann, MON9 + 10 * HOUR + 5 * DAY);
  const acts = t.due(MON9 + 10 * HOUR + 5 * DAY);
  assert.equal(acts.length, 1);
  assert.equal(acts[0]!.kind, 'task');
});

test('business-day waits skip the weekend', () => {
  const e = mkEngine();
  const step: Step = { ...email('b', 0), wait: { kind: 'business', days: 2 } } as Step;
  e.addSequence(seq([email('a', 0), step]));
  e.enrol('s1', ann, MON9 + 3 * DAY);
  e.due(MON9 + 3 * DAY);
  assert.equal(e.due(MON9 + 5 * DAY).length, 0);
  assert.equal(e.due(MON9 + 6 * DAY).length, 0);
  assert.equal(e.due(MON9 + 7 * DAY).length, 1);
});

test('a reply stops the sequence; auto-replies do not; stopOnReply=false is honoured', () => {
  const e = mkEngine();
  e.addSequence(seq([email('a', 0), email('b', 1)]));
  const en = e.enrol('s1', ann, MON9);
  e.due(MON9);
  assert.equal(e.reply('ann@example.com', MON9 + HOUR, { auto: true }), 0);
  assert.equal(en.status, 'active');
  assert.equal(e.reply(' ANN@example.com ', MON9 + 2 * HOUR), 1);
  assert.equal(en.status, 'replied');
  assert.deepEqual(e.due(MON9 + 2 * DAY), []);
  const f = mkEngine();
  f.addSequence(seq([email('a', 0), email('b', 1)], { stopOnReply: false }));
  const fe = f.enrol('s1', ann, MON9);
  f.reply('ann@example.com', MON9 + HOUR);
  assert.equal(fe.status, 'active');
});

test('unsubscribe and hard bounce suppress the address everywhere; a soft bounce does not', () => {
  const e = mkEngine();
  e.addSequence(seq([email('a', 0), email('b', 1)]));
  const en = e.enrol('s1', ann, MON9);
  e.bounce('ann@example.com', MON9, false);
  assert.equal(en.status, 'active');
  e.unsubscribe('Ann@Example.com', MON9 + HOUR);
  assert.equal(en.status, 'unsubscribed');
  assert.ok(e.isSuppressed('ann@example.com'));
  assert.throws(() => e.enrol('s1', { ...ann, id: 'c9' }, MON9 + DAY), /suppressed \(unsubscribed\)/);
  const b = e.enrol('s1', { id: 'c2', email: 'bob@example.com', fields: {} }, MON9);
  e.bounce('bob@example.com', MON9);
  assert.equal(b.status, 'bounced');
  assert.throws(() => e.enrol('s1', { id: 'c3', email: 'bob@example.com', fields: {} }, MON9), /bounced/);
});

test('waiting for an open: an open releases the step early, silence waits out the timeout', () => {
  const until: Step = { ...email('b', 0), wait: { kind: 'until', event: 'opened', timeoutMinutes: 3 * 1440 } } as Step;
  const e = mkEngine();
  e.addSequence(seq([email('a', 0), until]));
  const en = e.enrol('s1', ann, MON9);
  e.due(MON9);
  assert.equal(e.due(MON9 + DAY).length, 0);
  e.event(en.id, 'opened', MON9 + DAY + HOUR);
  assert.equal(e.due(MON9 + DAY + HOUR).length, 1);
  const f = mkEngine();
  f.addSequence(seq([email('a', 0), until]));
  f.enrol('s1', ann, MON9);
  f.due(MON9);
  assert.equal(f.due(MON9 + 3 * DAY - MIN).length, 0);
  assert.equal(f.due(MON9 + 3 * DAY).length, 1);
});

test('a click releases a wait-for-open, but an open does not release a wait-for-click', () => {
  const mk = (event: 'opened' | 'clicked') => {
    const e = mkEngine();
    e.addSequence(seq([email('a', 0), { ...email('b', 0), wait: { kind: 'until', event, timeoutMinutes: 5 * 1440 } } as Step]));
    const en = e.enrol('s1', ann, MON9);
    e.due(MON9);
    return { e, en };
  };
  const a = mk('opened'); a.e.event(a.en.id, 'clicked', MON9 + HOUR);
  assert.equal(a.e.due(MON9 + HOUR).length, 1);
  const b = mk('clicked'); b.e.event(b.en.id, 'opened', MON9 + HOUR);
  assert.equal(b.e.due(MON9 + HOUR).length, 0);
  b.e.event(b.en.id, 'clicked', MON9 + 2 * HOUR);
  assert.equal(b.e.due(MON9 + 2 * HOUR).length, 1);
});

test('conditions on the previous email skip steps, and the skipped step is in the history', () => {
  const e = mkEngine();
  e.addSequence(seq([email('a', 0), email('nudge', 1, { condition: 'previous-not-opened' }), email('thanks', 1, { condition: 'previous-opened' })]));
  const en = e.enrol('s1', ann, MON9);
  e.due(MON9);
  e.event(en.id, 'opened', MON9 + HOUR);
  const out = e.due(MON9 + DAY);
  assert.equal(out.length, 0);
  assert.deepEqual(en.history.filter((h) => h.what === 'skipped').map((h) => h.step), ['nudge']);
  const sent = e.due(MON9 + 2 * DAY);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.step, 'thanks');
});

test('tasks and calls hand out an action and wait for a person to complete them', () => {
  const e = mkEngine();
  e.addSequence(seq([
    { id: 'call', kind: 'call', script: 'Call {{first}} about the demo', wait: { kind: 'delay', minutes: 0 } },
    email('after', 1),
  ]));
  const en = e.enrol('s1', ann, MON9);
  const a = e.due(MON9);
  assert.deepEqual(a, [{ kind: 'call', enrolment: en.id, step: 'call', contact: 'c1', text: 'Call Ann about the demo' }]);
  assert.deepEqual(e.due(MON9 + 10 * DAY), []);
  assert.equal(e.nextWake(), null);
  e.complete(en.id, MON9 + 10 * DAY, 'left voicemail');
  assert.equal(e.due(MON9 + 10 * DAY).length, 0);
  assert.equal(e.due(MON9 + 11 * DAY).length, 1);
  assert.equal(en.history.find((h) => h.what === 'done')?.note, 'left voicemail');
  assert.throws(() => e.complete(en.id, MON9), SequenceError);
});

test('a missing merge field pauses the enrolment instead of sending a hole, and resume fixes it', () => {
  const e = mkEngine();
  e.addSequence(seq([{ ...email('a', 0), body: 'Hello {{company}}' } as Step]));
  const en = e.enrol('s1', { id: 'c1', email: 'ann@example.com', fields: {} }, MON9);
  assert.deepEqual(e.due(MON9), []);
  assert.equal(en.status, 'paused');
  assert.equal(en.pausedBecause, 'missing company');
  assert.equal(e.outbox.count('queued'), 0);
  assert.throws(() => e.enrol('s1', { id: 'c1', email: 'ann@example.com', fields: {} }, MON9), /already in a sequence/);
  e.resume(en.id, { company: 'Acme' }, MON9 + HOUR);
  const out = e.due(MON9 + HOUR);
  assert.equal(out.length, 1);
  assert.match((out[0] as { message: { text: string } }).message.text, /^Hello Acme/);
});

test('a merged value cannot inject a header line into the subject', () => {
  const e = mkEngine();
  e.addSequence(seq([{ ...email('a', 0), subject: 'Hello {{first}}' } as Step]));
  const en = e.enrol('s1', { id: 'c1', email: 'ann@example.com', fields: { first: 'Ann\r\nBcc: evil@example.net' } }, MON9);
  assert.deepEqual(e.due(MON9), []);
  assert.equal(en.status, 'paused');
  assert.match(en.pausedBecause!, /line break in the subject/);
});

test('the daily email cap holds the rest until the next open day', () => {
  const e = mkEngine();
  e.addSequence(seq([email('a', 0)], { window: WINDOW, dailyEmailLimit: 2 }));
  for (let i = 0; i < 5; i++) e.enrol('s1', { id: `c${i}`, email: `p${i}@example.com`, fields: {} }, MON9);
  assert.equal(e.due(MON9).length, 2);
  assert.equal(e.due(MON9 + HOUR).length, 0);
  assert.equal(e.nextWake(), MON9 + DAY);
  assert.equal(e.due(MON9 + DAY).length, 2);
  assert.equal(e.due(MON9 + 2 * DAY).length, 1);
});

test('enrolment refuses bad addresses, impossible offsets and double enrolment', () => {
  const e = mkEngine();
  e.addSequence(seq([email('a', 0)]));
  for (const bad of ['', 'nobody', 'a@b', 'a b@c.co', '<x>@c.co', 'a@@c.co']) assert.throws(() => e.enrol('s1', { id: 'x', email: bad, fields: {} }, MON9), /not an email/);
  assert.throws(() => e.enrol('s1', { id: 'x', email: 'a@b.co', fields: {}, offsetMinutes: 15 * 60 }, MON9), /14 hours/);
  assert.throws(() => e.enrol('nope', ann, MON9), /no sequence/);
  e.enrol('s1', ann, MON9);
  assert.throws(() => e.enrol('s1', ann, MON9), /already in a sequence/);
  assert.throws(() => e.addSequence(seq([email('a', 0)])), /already exists/);
  assert.throws(() => e.stop('ghost', MON9), SequenceError);
});

test('stopping by hand works once, and a finished contact can be enrolled again', () => {
  const e = mkEngine();
  e.addSequence(seq([email('a', 0), email('b', 1)]));
  const en = e.enrol('s1', ann, MON9);
  e.stop(en.id, MON9);
  assert.equal(en.status, 'stopped');
  assert.throws(() => e.stop(en.id, MON9), /not running/);
  assert.equal(e.enrol('s1', ann, MON9 + DAY).status, 'active');
});

test('outbox: idempotent keys, batches, backoff and a dead letter after five tries', () => {
  const o = new Outbox();
  const msg = { key: 'k1', to: 'a@b.co', from: 'x@y.co', subject: 's', text: 't', headers: {} };
  const a = o.enqueue(msg, 0);
  assert.equal(o.enqueue(msg, 5), a);
  assert.equal(o.count('queued'), 1);
  o.enqueue({ ...msg, key: 'k2' }, 0);
  assert.equal(o.claim(0, 1).length, 1);
  assert.equal(o.claim(0, 5).length, 1);
  assert.equal(o.claim(0, 5).length, 0);
  o.sent(a.id);
  assert.equal(o.get(a.id)!.state, 'sent');
  assert.throws(() => o.sent(a.id), /not being sent/);
  const b = o.get('m2')!;
  const waits: number[] = [];
  let now = 0;
  for (let i = 0; i < 5; i++) {
    o.failed(b.id, now, `try ${i + 1} failed`);
    if (b.state === 'dead') break;
    waits.push(b.notBefore - now);
    assert.equal(o.claim(now + 1, 1).length, 0 + (b.notBefore <= now + 1 ? 1 : 0));
    now = b.notBefore;
    o.claim(now, 1);
  }
  assert.deepEqual(waits, [MIN, 5 * MIN, 30 * MIN, 120 * MIN]);
  assert.equal(b.state, 'dead');
  assert.equal(b.lastError, 'try 5 failed');
  assert.throws(() => o.failed('nope', 0, 'x'), /no such message/);
});

test('due emails are queued in the outbox once, so calling due twice never doubles them', () => {
  const e = mkEngine();
  e.addSequence(seq([email('a', 0)]));
  e.enrol('s1', ann, MON9);
  e.due(MON9);
  e.due(MON9);
  assert.equal(e.outbox.count('queued'), 1);
});
