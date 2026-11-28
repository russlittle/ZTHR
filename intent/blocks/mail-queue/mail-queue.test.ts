import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CURVE, MailQueue, QueueError, Warmup, classifyReply, judgeDay, retryDelay, warmupSchedule, type QueueEvent, type QueueOptions } from './index.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 2, 1, 12, 0, 0);

function setup(o: Partial<QueueOptions> = {}) {
  const clock = { t: T0 };
  const q = new MailQueue({ now: () => clock.t, random: () => 0.5, ...o });
  return { q, clock };
}
const msg = (id: string, to: string[], priority?: number) => ({ id, from: 'app@example.org', recipients: to, ...(priority === undefined ? {} : { priority }) });
const types = (ev: QueueEvent[]) => ev.map((e) => e.type);

test('reply classification: delivered, throttled, greylisted, full, unknown user, policy, content, size', () => {
  const c = (code: number, enh: string | undefined, text: string) => {
    const v = classifyReply(code, enh, text);
    return `${v.action}/${v.class ?? '-'}/${v.scope}${v.suppress ? '/suppress' : ''}`;
  };
  assert.equal(c(250, '2.0.0', 'OK'), 'delivered/-/recipient');
  assert.equal(c(421, '4.7.0', 'Our system has detected an unusual rate of unsolicited mail. Please try again later'), 'defer/throttle/domain');
  assert.equal(c(451, '4.7.1', 'Greylisted, please try again in 300 seconds'), 'defer/greylist/recipient');
  assert.equal(c(450, '4.2.1', 'Too many connections from your IP'), 'defer/throttle/domain');
  assert.equal(c(452, '4.2.2', 'Mailbox full'), 'defer/mailbox-full/recipient');
  assert.equal(c(451, '4.3.0', 'Local error in processing'), 'defer/temporary/recipient');
  assert.equal(c(550, '5.1.1', 'The email account does not exist'), 'bounce/no-such-user/recipient/suppress');
  assert.equal(c(550, undefined, 'User unknown in virtual mailbox table'), 'bounce/no-such-user/recipient/suppress');
  assert.equal(c(550, '5.7.1', 'Message rejected due to DMARC policy'), 'bounce/policy/domain');
  assert.equal(c(554, '5.7.1', 'Service unavailable; client host blocked using zen.spamhaus.org'), 'bounce/policy/domain');
  assert.equal(c(550, '5.7.1', 'Relaying denied'), 'bounce/relay-denied/recipient');
  assert.equal(c(552, '5.3.4', 'Message size exceeds fixed limit'), 'bounce/too-large/recipient');
  assert.equal(c(554, '5.6.0', 'Content rejected as spam'), 'bounce/content/recipient');
  assert.equal(c(554, undefined, 'Transaction failed'), 'bounce/permanent/recipient');
  assert.equal(c(354, undefined, 'go on'), 'defer/temporary/recipient');
});

test('the retry curve doubles from five minutes to the cap, with jitter within bounds', () => {
  const mid = () => 0.5;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => retryDelay(n, 'temporary', DEFAULT_CURVE, mid) / MIN), [5, 10, 20, 40, 80, 160, 240, 240]);
  assert.equal(retryDelay(1, 'temporary', DEFAULT_CURVE, () => 0), 4.5 * MIN, 'jitter is at most 10% down');
  assert.equal(retryDelay(1, 'temporary', DEFAULT_CURVE, () => 1), 5.5 * MIN, 'and at most 10% up');
  assert.deepEqual([1, 2, 3, 4, 9].map((n) => retryDelay(n, 'greylist', DEFAULT_CURVE, mid) / MIN), [5, 15, 30, 30, 30]);
  assert.deepEqual([1, 2, 3, 4].map((n) => retryDelay(n, 'mailbox-full', DEFAULT_CURVE, mid) / MIN), [60, 120, 240, 240]);
  assert.deepEqual([1, 2, 3].map((n) => retryDelay(n, 'connection', DEFAULT_CURVE, mid) / MIN), [2.5, 5, 10]);
  assert.equal(retryDelay(0, 'temporary', DEFAULT_CURVE, mid), 5 * MIN, 'attempt numbers below 1 count as 1');
});

test('enqueue splits per domain and by recipient limit, drops duplicates, refuses suppressed and malformed', () => {
  const { q } = setup({ policies: { 'big.example': { maxConcurrent: 2, perMinute: 10, maxRecipients: 2 } } });
  q.suppress('Gone@Example.net', 'hard bounce');
  const r = q.enqueue(msg('m1', ['a@x.example', 'b@x.example', 'a@x.example', 'c@big.example', 'd@big.example', 'e@big.example', 'gone@example.net', 'not an address', 'f@Y.example']));
  assert.deepEqual(r.queued.sort(), ['m1@big.example', 'm1@big.example#2', 'm1@x.example', 'm1@y.example']);
  assert.deepEqual(r.refused, [{ to: 'gone@example.net', reason: 'suppressed: hard bounce' }, { to: 'not an address', reason: 'not an address' }]);
  assert.deepEqual(q.deliveries.get('m1@x.example')!.recipients.map((x) => x.to), ['a@x.example', 'b@x.example']);
  assert.deepEqual(q.deliveries.get('m1@big.example')!.recipients.map((x) => x.to), ['c@big.example', 'd@big.example']);
  assert.throws(() => q.enqueue(msg('m1', ['z@x.example'])), /already queued/);
  assert.throws(() => q.enqueue({ id: '', from: 'a@b.c', recipients: [] }), QueueError);
});

test('next() honours priority, due time, per-domain concurrency and the per-minute start rate', () => {
  const { q, clock } = setup({ defaultPolicy: { maxConcurrent: 2, perMinute: 3, maxRecipients: 50 } });
  q.enqueue(msg('news1', ['a@slow.example'], 9));
  q.enqueue(msg('news2', ['b@slow.example'], 9));
  q.enqueue(msg('reset', ['c@slow.example'], 0));
  q.enqueue(msg('other', ['d@fast.example'], 5));
  const first = q.next();
  assert.deepEqual(first.map((d) => d.id), ['reset@slow.example', 'other@fast.example', 'news1@slow.example'], 'priority order, two at slow.example at most');
  assert.equal(q.next().length, 0, 'slow.example is at its two connections');
  q.report('reset@slow.example', { kind: 'reply', code: 250, text: 'ok' });
  assert.deepEqual(q.next().map((d) => d.id), ['news2@slow.example'], 'a free connection is used at once');
  q.report('news1@slow.example', { kind: 'reply', code: 250, text: 'ok' });
  q.enqueue(msg('more', ['e@slow.example'], 0));
  assert.equal(q.next().length, 0, 'three starts in this minute is the rate limit');
  clock.t += MIN + 1;
  assert.deepEqual(q.next().map((d) => d.id), ['more@slow.example']);
  assert.deepEqual(q.domainStatus('slow.example').inflight, 2);
});

test('a delivery is reported per recipient: delivered ones are done, a permanent refusal bounces and suppresses', () => {
  const { q } = setup();
  q.enqueue(msg('m', ['ok@x.example', 'gone@x.example', 'later@x.example']));
  const [d] = q.next();
  const ev = q.report(d!.id, { kind: 'session', results: [{ to: 'ok@x.example', code: 250, text: 'queued' }, { to: 'gone@x.example', code: 550, enhanced: '5.1.1', text: 'No such user' }, { to: 'later@x.example', code: 452, enhanced: '4.2.2', text: 'Mailbox full' }] });
  assert.deepEqual(types(ev), ['delivered', 'bounced', 'suppressed', 'deferred']);
  assert.deepEqual(d!.recipients.map((r) => r.status), ['delivered', 'bounced', 'pending']);
  assert.equal(d!.state, 'queued', 'only the one recipient left is retried');
  assert.equal(d!.nextAt, T0 + HOUR, 'a full mailbox waits an hour');
  assert.equal(q.enqueue(msg('m2', ['gone@x.example'])).refused[0]!.reason.startsWith('suppressed: 550'), true);
  assert.equal(d!.lastClass, 'mailbox-full');
});

test('a throttling answer slows the whole domain: halved connections, a growing pause, and recovery by ones', () => {
  const { q, clock } = setup({ policies: { 'gmail.com': { maxConcurrent: 8, perMinute: 1000, maxRecipients: 50 } } });
  for (let i = 0; i < 12; i++) q.enqueue(msg(`m${i}`, [`u${i}@gmail.com`]));
  const first = q.next();
  assert.equal(first.length, 8);
  const ev = q.report(first[0]!.id, { kind: 'reply', code: 421, enhanced: '4.7.0', text: 'rate limited, try again later' });
  assert.deepEqual(ev.map((e) => e.type), ['domain-slowed', 'deferred']);
  const slowed = ev[0] as Extract<QueueEvent, { type: 'domain-slowed' }>;
  assert.deepEqual([slowed.limit, slowed.pausedUntil - clock.t], [4, 5 * MIN]);
  assert.equal(q.next().length, 0, 'the domain is paused');
  assert.equal(q.domainStatus('gmail.com').pausedUntil, clock.t + 5 * MIN);
  clock.t += 5 * MIN;
  q.report(first[1]!.id, { kind: 'reply', code: 421, enhanced: '4.7.0', text: 'rate limited' });
  assert.equal(q.domainStatus('gmail.com').limit, 2);
  assert.equal(q.domainStatus('gmail.com').pausedUntil! - clock.t, 10 * MIN, 'the pause doubles while throttling goes on');
  for (const d of first.slice(2)) q.report(d.id, { kind: 'reply', code: 250, text: 'ok' });
  clock.t += 20 * MIN;
  assert.equal(q.next().length, 2, 'two connections now, and the rest waits');
});

test('concurrency recovers one connection per ten successes, never above the policy', () => {
  const { q, clock } = setup({ policies: { 'a.example': { maxConcurrent: 3, perMinute: 10_000, maxRecipients: 50 } } });
  q.enqueue(msg('t', ['x@a.example']));
  q.report(q.next()[0]!.id, { kind: 'reply', code: 421, enhanced: '4.7.0', text: 'too many connections' });
  assert.equal(q.domainStatus('a.example').limit, 1);
  clock.t += HOUR;
  q.report(q.next()[0]!.id, { kind: 'reply', code: 250, text: 'ok' });
  const limits: number[] = [];
  for (let i = 0; i < 40; i++) {
    q.enqueue(msg(`s${i}`, [`u${i}@a.example`]));
    const d = q.next().find((x) => x.message === `s${i}`)!;
    q.report(d.id, { kind: 'reply', code: 250, text: 'ok' });
    limits.push(q.domainStatus('a.example').limit);
  }
  assert.deepEqual([limits[7], limits[8], limits[17], limits[18], limits[39]], [1, 2, 2, 3, 3], 'up by one at the tenth and twentieth success, then held at the policy');
});

test('greylisting retries on its short ladder and does not slow the domain', () => {
  const { q, clock } = setup();
  q.enqueue(msg('g', ['a@grey.example']));
  const [d] = q.next();
  const ev = q.report(d!.id, { kind: 'reply', code: 451, enhanced: '4.7.1', text: 'Greylisted, please try again in 300 seconds' });
  assert.deepEqual(types(ev), ['deferred']);
  assert.equal(d!.nextAt - clock.t, 5 * MIN);
  assert.equal(q.next().length, 0);
  clock.t += 5 * MIN;
  const [again] = q.next();
  assert.equal(again!.id, d!.id);
  q.report(again!.id, { kind: 'reply', code: 451, enhanced: '4.7.1', text: 'Greylisted' });
  assert.equal(d!.nextAt - clock.t, 15 * MIN);
  assert.equal(q.domainStatus('grey.example').limit, 5, 'the domain keeps its full limit');
});

test('connection, DNS and TLS failures defer; each has its class and the queue keeps the last error', () => {
  const { q, clock } = setup();
  q.enqueue(msg('c', ['a@down.example']));
  const [d] = q.next();
  const ev = q.report(d!.id, { kind: 'failed', stage: 'connect', error: 'ECONNREFUSED mx.down.example:25' });
  assert.equal((ev[0] as { class: string }).class, 'connection');
  assert.equal(d!.nextAt - clock.t, 2.5 * MIN);
  assert.equal(d!.lastError, 'connect: ECONNREFUSED mx.down.example:25');
  clock.t = d!.nextAt;
  const dns = q.report(q.next()[0]!.id, { kind: 'failed', stage: 'dns', error: 'ENOTFOUND' });
  assert.equal((dns[0] as { class: string }).class, 'dns');
  clock.t = d!.nextAt;
  const tls = q.report(q.next()[0]!.id, { kind: 'failed', stage: 'tls', error: 'certificate expired' });
  assert.equal((tls[0] as { class: string }).class, 'tls');
  assert.equal(d!.attempts, 3);
});

test('a long deferral sends one delay notice, then the message expires with its last answer', () => {
  const { q, clock } = setup();
  q.enqueue(msg('slow', ['a@x.example']));
  const all: QueueEvent[] = [];
  let guard = 0;
  while (q.stats().queued + q.stats().sending > 0 && guard++ < 100) {
    const d = q.next();
    if (!d.length) {
      clock.t = q.nextWake()!;
      continue;
    }
    all.push(...q.report(d[0]!.id, { kind: 'reply', code: 451, enhanced: '4.3.0', text: 'try later, server busy' }));
    clock.t += 1;
  }
  assert.equal(all.filter((e) => e.type === 'delay-notice').length, 1, 'told once');
  const notice = all.find((e) => e.type === 'delay-notice') as Extract<QueueEvent, { type: 'delay-notice' }>;
  assert.deepEqual(notice.recipients, ['a@x.example']);
  const exp = all.find((e) => e.type === 'expired') as { text: string };
  assert.ok(exp, 'it expired');
  assert.match(exp.text, /still undelivered after 1[12]\d hours; last answer: 451 try later, server busy/);
  assert.ok(clock.t - T0 <= DEFAULT_CURVE.maxAgeMs + 4 * HOUR);
  assert.equal(q.deliveries.get('slow@x.example')!.recipients[0]!.status, 'expired');
  assert.equal(q.deliveries.get('slow@x.example')!.state, 'done');
});

test('a delivery claimed and never reported is reclaimed by the sweep as a timeout', () => {
  const { q, clock } = setup({ leaseMs: 10 * MIN });
  q.enqueue(msg('lost', ['a@x.example']));
  const [d] = q.next();
  clock.t += 5 * MIN;
  assert.deepEqual(q.sweep(), []);
  clock.t += 6 * MIN;
  const ev = q.sweep();
  assert.deepEqual(types(ev), ['deferred']);
  assert.equal(d!.lastError, 'timeout: no result was reported before the lease ended');
  assert.equal(q.domainStatus('x.example').inflight, 0, 'its connection slot came back');
  assert.throws(() => q.report(d!.id, { kind: 'reply', code: 250, text: 'late' }), /not out for delivery/);
});

test('a session that ends before answering a recipient leaves that recipient queued', () => {
  const { q } = setup();
  q.enqueue(msg('p', ['a@x.example', 'b@x.example']));
  const [d] = q.next();
  q.report(d!.id, { kind: 'session', results: [{ to: 'a@x.example', code: 250, text: 'ok' }] });
  assert.deepEqual(d!.recipients.map((r) => r.status), ['delivered', 'pending']);
  assert.equal(d!.state, 'queued');
});

test('policies match an exact domain first, then the longest suffix, then the default', () => {
  const { q } = setup({ policies: { 'outlook.com': { maxConcurrent: 1, perMinute: 5, maxRecipients: 10 }, '.protection.outlook.com': { maxConcurrent: 2, perMinute: 20, maxRecipients: 20 }, '.outlook.com': { maxConcurrent: 3, perMinute: 30, maxRecipients: 30 } } });
  assert.equal(q.policy('OUTLOOK.com').maxConcurrent, 1);
  assert.equal(q.policy('contoso.mail.protection.outlook.com').maxConcurrent, 2);
  assert.equal(q.policy('eur.outlook.com').maxConcurrent, 3);
  assert.equal(q.policy('example.net').maxConcurrent, 5);
  assert.equal(q.policy('constructor').maxConcurrent, 5, 'inherited names are not policies');
});

test('stats and wake time tell a worker what is waiting and when to look again', () => {
  const { q, clock } = setup();
  assert.equal(q.nextWake(), null);
  q.enqueue(msg('a', ['x@one.example']));
  q.enqueue(msg('b', ['y@two.example']));
  assert.equal(q.nextWake(), T0);
  const [d] = q.next(1);
  q.report(d!.id, { kind: 'reply', code: 451, enhanced: '4.3.0', text: 'later' });
  clock.t += 3 * MIN;
  const s = q.stats();
  assert.deepEqual([s.queued, s.sending, s.done, s.oldestQueuedMs, s.byDomain], [2, 0, 0, 3 * MIN, { 'one.example': 1, 'two.example': 1 }]);
  assert.equal(q.nextWake(), T0, 'the other message is already due');
});

test('warm-up schedules ramp to the target, and bad inputs are refused', () => {
  assert.deepEqual(warmupSchedule({ target: 1000 }), [50, 100, 200, 400, 800, 1000]);
  assert.deepEqual(warmupSchedule({ start: 100, target: 100 }), [100]);
  assert.deepEqual(warmupSchedule({ start: 10, target: 40, growth: 1.5 }), [10, 15, 23, 35, 40]);
  assert.throws(() => warmupSchedule({ start: 0, target: 10 }), QueueError);
  assert.throws(() => warmupSchedule({ target: 10 }), QueueError);
  assert.throws(() => warmupSchedule({ target: 1000, growth: 1 }), QueueError);
});

test('judging a day: advance only when healthy and nearly used, hold when bounces rise, back off on a spike', () => {
  assert.equal(judgeDay(100, { sent: 90, bounced: 1, complaints: 0 }), 'advance');
  assert.equal(judgeDay(100, { sent: 50, bounced: 0, complaints: 0 }), 'hold', 'the limit was not used, so there is nothing to learn');
  assert.equal(judgeDay(100, { sent: 100, bounced: 4, complaints: 0 }), 'hold');
  assert.equal(judgeDay(100, { sent: 100, bounced: 6, complaints: 0 }), 'back-off');
  assert.equal(judgeDay(100, { sent: 1000, bounced: 0, complaints: 4 }), 'back-off');
  assert.equal(judgeDay(100, { sent: 1000, bounced: 0, complaints: 2 }), 'hold');
  assert.equal(judgeDay(100, { sent: 0, bounced: 0, complaints: 0 }), 'hold');
});

test('an IP warms up day by day: limits are taken, the day rolls, healthy days advance, bad days step back', () => {
  const clock = { t: T0 };
  const w = new Warmup([50, 100, 200], ['192.0.2.1', '192.0.2.2'], () => clock.t);
  assert.deepEqual(w.allowance('192.0.2.1'), { day: 1, limit: 50, used: 0, remaining: 50, warm: false });
  assert.equal(w.take('192.0.2.1', 45), true);
  assert.equal(w.take('192.0.2.1', 6), false, 'the whole request must fit');
  assert.equal(w.take('192.0.2.1', 5), true);
  assert.equal(w.pick(), '192.0.2.2', 'the IP with room is chosen');
  w.take('192.0.2.2', 50);
  assert.equal(w.pick(), undefined, 'everything used: the rest waits for tomorrow');
  assert.equal(w.advice('192.0.2.1'), 'advance');
  clock.t += 24 * HOUR;
  assert.equal(w.allowance('192.0.2.1').limit, 100, 'a healthy full day moved it up');
  w.take('192.0.2.1', 100);
  for (let i = 0; i < 7; i++) w.note('192.0.2.1', 'bounce');
  clock.t += 24 * HOUR;
  assert.equal(w.allowance('192.0.2.1').limit, 50, '7% bounces: back a step');
  w.take('192.0.2.1', 50);
  clock.t += 24 * HOUR;
  assert.equal(w.allowance('192.0.2.1').day, 2);
  w.take('192.0.2.1', 100);
  clock.t += 24 * HOUR;
  w.take('192.0.2.1', 200);
  clock.t += 24 * HOUR;
  const a = w.allowance('192.0.2.1');
  assert.deepEqual([a.limit, a.warm], [200, true], 'the top of the ramp is the last step');
  assert.throws(() => w.take('192.0.2.9'), /not in the warm-up/);
  assert.throws(() => new Warmup([], [], () => 0), /at least one day/);
});
