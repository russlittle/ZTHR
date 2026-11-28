import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statusPage } from '../health/index.ts';
import { isPrivateAddress, matchesHost, Monitor, ProbeError, queryJson, TwinTransport, type ProbeDef, type Transition } from './index.ts';

const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);
const DAY = 86_400_000;
function rig(o: Partial<ConstructorParameters<typeof Monitor>[0]> = {}) {
  const clock = { now: T0 };
  const twin = new TwinTransport();
  const events: Transition[] = [];
  const slept: number[] = [];
  const mon = new Monitor({ transport: twin, now: () => clock.now, sleep: async (ms) => void slept.push(ms), random: () => 0.5, onEvent: (e) => events.push(e), ...o });
  return { clock, twin, events, slept, mon };
}
const web = (o: Partial<Extract<ProbeDef, { type: 'http' }>> = {}): ProbeDef => ({ type: 'http', id: 'web', url: 'https://example.com/', intervalMs: 60_000, timeoutMs: 1000, ...o }) as ProbeDef;
const ok = { status: 200, body: 'ok', ms: 50 };
const status = async (m: Monitor, id = 'web') => (await m.check(id)).result.status;

test('addresses that are not on the public internet are recognised in every spelling', () => {
  for (const ip of ['127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.9', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '2001:db8::1']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateAddress(ip), false, ip);
  assert.equal(isPrivateAddress('not an address'), true, 'what cannot be read is treated as unsafe');
});

test('a monitor refuses targets that would reach inside the network, unless told it may', () => {
  const { mon } = rig();
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://localhost/', 'http://127.0.0.1:8080/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://10.0.0.5/', 'http://intranet/', 'http://db.internal/', 'http://printer.local/', 'http://a.localhost/']) {
    assert.throws(() => mon.add(web({ url })), /private|internal|local/, url);
  }
  assert.throws(() => mon.add({ type: 'tcp', id: 't', host: '192.168.1.1', port: 22, intervalMs: 60_000, timeoutMs: 1000 }), /private/);
  assert.throws(() => mon.add({ type: 'cert', id: 'c', host: 'localhost', intervalMs: 60_000, timeoutMs: 1000 }), /private/);
  assert.throws(() => mon.add(web({ url: 'ftp://example.com/' })), /http or https/);
  assert.throws(() => mon.add(web({ url: 'https://user:pw@example.com/' })), /password/);
  assert.throws(() => mon.add(web({ url: 'not a url' })), /web address/);
  const lan = rig({ allowPrivate: true });
  lan.mon.add(web({ url: 'http://10.0.0.5/health' }));
  assert.equal(lan.mon.ids().length, 1);
});

test('a probe definition must be complete and sane', () => {
  const { mon } = rig();
  assert.throws(() => mon.add(web({ id: 'a b' })), /id/);
  assert.throws(() => mon.add(web({ intervalMs: 1000 })), /interval/);
  assert.throws(() => mon.add(web({ timeoutMs: 10 })), /timeout/);
  assert.throws(() => mon.add(web({ timeoutMs: 60_000 })), /shorter than the interval/);
  assert.throws(() => mon.add(web({ retries: 9 })), /retries/);
  assert.throws(() => mon.add(web({ method: 'DELETE' as never })), /method/);
  assert.throws(() => mon.add(web({ expectStatus: ['9xx'] as never })), /status/);
  assert.throws(() => mon.add(web({ headers: { 'X-A': 'b\r\nX-B: c' } })), /header/);
  assert.throws(() => mon.add(web({ headers: { 'bad name': 'v' } })), /header/);
  assert.throws(() => mon.add({ type: 'tcp', id: 't', host: 'example.com', port: 70_000, intervalMs: 60_000, timeoutMs: 1000 }), /port/);
  assert.throws(() => mon.add({ type: 'keyword', id: 'k', url: 'https://example.com/', keyword: '', intervalMs: 60_000, timeoutMs: 1000 }), /keyword/);
  assert.throws(() => mon.add({ type: 'dns', id: 'd', host: 'example.com', record: 'ANY' as never, intervalMs: 60_000, timeoutMs: 1000 }), /record/);
  assert.throws(() => mon.add({ type: 'cert', id: 'c', host: 'example.com', warnDays: 5, failDays: 9, intervalMs: 60_000, timeoutMs: 1000 }), /failDays/);
  mon.add(web());
  assert.throws(() => mon.add(web()), /already/);
  assert.throws(() => mon.state('nope'), ProbeError);
});

test('an http probe is up, degraded when slow, or down on a wrong status, with the reason in plain words', async () => {
  const { mon, twin } = rig();
  mon.add(web({ degradedMs: 500, expectStatus: ['2xx', 301] }));
  twin.script('http', 'https://example.com/', ok);
  assert.deepEqual(pick((await mon.check('web')).result), ['up', 50, '200 in 50 ms']);
  twin.script('http', 'https://example.com/', { ...ok, ms: 900 });
  assert.deepEqual(pick((await mon.check('web')).result), ['degraded', 900, '200 in 900 ms, slower than the 500 ms limit']);
  twin.script('http', 'https://example.com/', { status: 301, ms: 20 });
  assert.equal(await status(mon), 'up');
  twin.script('http', 'https://example.com/', { status: 302, ms: 20 });
  assert.equal((await mon.check('web')).result.message, 'got 302, expected 2xx, 301');
  twin.script('http', 'https://example.com/', { status: 503, ms: 20 });
  assert.equal(await status(mon), 'down');
});

function pick(r: { status: string; ms: number; message: string }) {
  return [r.status, r.ms, r.message];
}

test('a keyword probe looks for text in the page, and can require its absence', async () => {
  const { mon, twin } = rig();
  mon.add({ type: 'keyword', id: 'k', url: 'https://example.com/', keyword: 'Welcome', intervalMs: 60_000, timeoutMs: 1000 });
  mon.add({ type: 'keyword', id: 'k2', url: 'https://example.com/', keyword: 'Fatal error', invert: true, intervalMs: 60_000, timeoutMs: 1000 });
  mon.add({ type: 'keyword', id: 'k3', url: 'https://example.com/', keyword: 'Welcome', caseSensitive: true, intervalMs: 60_000, timeoutMs: 1000 });
  twin.script('http', 'https://example.com/', { ...ok, body: '<h1>welcome home</h1>' });
  assert.equal(await status(mon, 'k'), 'up', 'case is ignored by default');
  assert.equal(await status(mon, 'k2'), 'up');
  const strict = (await mon.check('k3')).result;
  assert.deepEqual([strict.status, strict.message], ['down', 'the page does not contain "Welcome"']);
  twin.script('http', 'https://example.com/', { ...ok, body: 'PHP Fatal error: x' });
  const bad = (await mon.check('k2')).result;
  assert.deepEqual([bad.status, bad.message], ['down', 'the page contains "Fatal error", which it must not']);
  twin.script('http', 'https://example.com/', { ...ok, body: 'Welcome', status: 500 });
  assert.equal(await status(mon, 'k'), 'down', 'a good keyword does not excuse a bad status');
});

test('a json probe follows a safe path into the answer and checks the value', async () => {
  const { mon, twin } = rig();
  const j = (id: string, query: string, expect: object) => mon.add({ type: 'json', id, url: 'https://example.com/health', query, expect, intervalMs: 60_000, timeoutMs: 1000 } as ProbeDef);
  j('eq', 'data.status', { equals: 'ok' });
  j('gt', 'checks[1].latency', { gt: 10 });
  j('lt', "checks[0]['p95']", { lt: 5 });
  j('ex', 'data.missing', { exists: false });
  j('has', 'data.tags', { contains: 'b' });
  twin.script('http', 'https://example.com/health', { ...ok, body: JSON.stringify({ data: { status: 'ok', tags: ['a', 'b'] }, checks: [{ p95: 3 }, { latency: 25 }] }) });
  for (const id of ['eq', 'gt', 'lt', 'ex', 'has']) assert.equal(await status(mon, id), 'up', id);
  twin.script('http', 'https://example.com/health', { ...ok, body: JSON.stringify({ data: { status: 'fail' } }) });
  assert.equal((await mon.check('eq')).result.message, 'data.status is "fail", expected "ok"');
  assert.equal((await mon.check('gt')).result.message, 'checks[1].latency was not found');
  twin.script('http', 'https://example.com/health', { ...ok, body: '<html>maintenance</html>' });
  assert.equal((await mon.check('eq')).result.message, 'the answer is not valid JSON');
  twin.script('http', 'https://example.com/health', { ...ok, body: '{"a":1', truncated: true });
  assert.equal((await mon.check('eq')).result.message, 'the answer was too large to check');
});

test('json paths cannot reach the prototype, and only own values are read', () => {
  const v = JSON.parse('{"a":{"__proto__":{"x":1},"b":[10,20]},"c":"text"}');
  assert.deepEqual(queryJson(v, 'a.b[1]'), { found: true, value: 20 });
  assert.deepEqual(queryJson(v, 'a.b[2]'), { found: false });
  assert.deepEqual(queryJson(v, 'a.b.length'), { found: false });
  assert.deepEqual(queryJson(v, 'c.length'), { found: false }, 'a string has no own fields to read');
  assert.deepEqual(queryJson(v, '["c"]'), { found: true, value: 'text' });
  for (const bad of ['__proto__', 'a.__proto__.x', 'constructor.name', 'a["prototype"]', '', 'a..b', 'a[', 'a[-1]', '[1.5]', 'a b']) assert.throws(() => queryJson(v, bad), /path/, bad);
  assert.throws(() => queryJson(v, Array.from({ length: 30 }, () => 'a').join('.')), /too deep/);
});

test('a tcp probe connects, or fails with the reason, and a hung connection ends at the timeout', async () => {
  const { mon, twin } = rig();
  mon.add({ type: 'tcp', id: 'db', host: 'db.example.com', port: 5432, degradedMs: 100, intervalMs: 60_000, timeoutMs: 100 });
  twin.script('tcp', 'db.example.com:5432', { ms: 20 });
  assert.equal((await mon.check('db')).result.message, 'connected in 20 ms');
  twin.script('tcp', 'db.example.com:5432', { ms: 250 });
  assert.equal(await status(mon, 'db'), 'degraded');
  twin.script('tcp', 'db.example.com:5432', new Error('ECONNREFUSED'));
  assert.equal((await mon.check('db')).result.message, 'could not connect: ECONNREFUSED');
  twin.script('tcp', 'db.example.com:5432', 'hang');
  const t = (await mon.check('db')).result;
  assert.deepEqual([t.status, t.message], ['down', 'no answer within 100 ms']);
});

test('a dns probe checks that the expected records are there, and says what is missing', async () => {
  const { mon, twin } = rig();
  mon.add({ type: 'dns', id: 'a', host: 'example.com', record: 'A', expect: ['93.184.216.34'], intervalMs: 60_000, timeoutMs: 1000 });
  mon.add({ type: 'dns', id: 'mx', host: 'example.com', record: 'MX', expect: ['10 Mail.Example.com.'], exact: true, intervalMs: 60_000, timeoutMs: 1000 });
  twin.script('dns', 'example.com/A', { records: ['93.184.216.34', '93.184.216.35'] });
  assert.equal((await mon.check('a')).result.message, 'A 93.184.216.34, 93.184.216.35');
  twin.script('dns', 'example.com/A', { records: ['203.0.113.7'] });
  assert.equal((await mon.check('a')).result.message, 'missing 93.184.216.34 (got 203.0.113.7)');
  twin.script('dns', 'example.com/A', { records: [] });
  assert.equal((await mon.check('a')).result.message, 'no records came back');
  twin.script('dns', 'example.com/A', new Error('ENOTFOUND'));
  assert.equal((await mon.check('a')).result.message, 'lookup failed: ENOTFOUND');
  twin.script('dns', 'example.com/MX', { records: ['10 mail.example.com'] });
  assert.equal(await status(mon, 'mx'), 'up', 'case and a trailing dot do not matter');
  twin.script('dns', 'example.com/MX', { records: ['10 mail.example.com', '20 spare.example.com'] });
  assert.match((await mon.check('mx')).result.message, /unexpected 20 spare\.example\.com/);
});

test('hostnames in certificates match as RFC 6125 says: one label for a wildcard, never an IP', () => {
  assert.equal(matchesHost('example.com', ['example.com']), true);
  assert.equal(matchesHost('EXAMPLE.com', ['example.COM']), true);
  assert.equal(matchesHost('www.example.com', ['*.example.com']), true);
  assert.equal(matchesHost('example.com', ['*.example.com']), false);
  assert.equal(matchesHost('a.b.example.com', ['*.example.com']), false);
  assert.equal(matchesHost('www.example.com', ['w*.example.com']), false);
  assert.equal(matchesHost('www.example.com', ['*.com']), false, 'a wildcard over a whole public suffix is not trusted');
  assert.equal(matchesHost('www.example.com', ['example.com', 'www.example.com']), true);
  assert.equal(matchesHost('example.com', []), false);
});

test('a certificate probe warns before expiry, fails near it, and checks name and pin', async () => {
  const { mon, twin } = rig();
  mon.add({ type: 'cert', id: 'tls', host: 'example.com', warnDays: 21, failDays: 7, pin: 'AA:BB', intervalMs: 60_000, timeoutMs: 1000 });
  const cert = (days: number, o: object = {}) => ({ ms: 80, cert: { subject: 'example.com', issuer: 'Example CA', validFrom: T0 - 90 * DAY, validTo: T0 + days * DAY, altNames: ['example.com', '*.example.com'], fingerprint256: 'AA:BB', ...o } });
  twin.script('cert', 'example.com:443', cert(60));
  assert.deepEqual(pick((await mon.check('tls')).result), ['up', 80, 'valid for 60 more days']);
  twin.script('cert', 'example.com:443', cert(15));
  assert.deepEqual([(await mon.check('tls')).result.status, (await mon.check('tls')).result.message], ['degraded', 'expires in 15 days']);
  twin.script('cert', 'example.com:443', cert(5));
  assert.equal((await mon.check('tls')).result.status, 'down');
  twin.script('cert', 'example.com:443', cert(-3));
  assert.equal((await mon.check('tls')).result.message, 'expired 3 days ago');
  twin.script('cert', 'example.com:443', cert(60, { altNames: ['other.example.net'] }));
  assert.equal((await mon.check('tls')).result.message, 'the certificate does not cover example.com');
  twin.script('cert', 'example.com:443', cert(60, { fingerprint256: 'CC:DD' }));
  assert.equal((await mon.check('tls')).result.message, 'the certificate is not the pinned one');
  twin.script('cert', 'example.com:443', cert(60, { validFrom: T0 + DAY }));
  assert.equal((await mon.check('tls')).result.message, 'the certificate is not valid yet');
});

test('a failed check is retried with backoff before it counts, and the result says how many tries it took', async () => {
  const { mon, twin, slept } = rig();
  mon.add(web({ retries: 2 }));
  twin.script('http', 'https://example.com/', new Error('socket hang up'), ok);
  const r = (await mon.check('web')).result;
  assert.deepEqual([r.status, r.attempts, slept], ['up', 2, [100]]);
  twin.script('http', 'https://example.com/', { status: 500, ms: 10 });
  const down = (await mon.check('web')).result;
  assert.deepEqual([down.status, down.attempts, twin.calls.filter((c) => c.kind === 'http').length], ['down', 3, 5]);
  const none = rig();
  none.mon.add(web({ retries: 0 }));
  none.twin.script('http', 'https://example.com/', new Error('boom'));
  assert.equal((await none.mon.check('web')).result.attempts, 1);
});

test('one bad check does not make an outage: it takes consecutive failures to go down, and successes to come back', async () => {
  const { mon, twin, clock, events } = rig();
  mon.add(web({ retries: 0, failuresToDown: 3, successesToUp: 2 }));
  const step = async (o: object) => {
    twin.script('http', 'https://example.com/', o);
    clock.now += 60_000;
    return mon.check('web');
  };
  assert.equal((await step(ok)).state.state, 'up');
  assert.equal((await step({ status: 500 })).state.state, 'up');
  assert.equal((await step(ok)).state.state, 'up', 'a success resets the count of failures');
  await step({ status: 500 });
  await step({ status: 500 });
  assert.equal((await step({ status: 500 })).state.state, 'down');
  assert.equal((await step(ok)).state.state, 'down', 'one success is not yet recovery');
  assert.equal((await step({ status: 500 })).state.state, 'down');
  await step(ok);
  const back = await step(ok);
  assert.equal(back.state.state, 'up');
  assert.deepEqual(events.filter((e) => e.kind === 'state').map((e) => [e.from, e.to]), [['unknown', 'up'], ['up', 'down'], ['down', 'up']]);
  assert.equal(events[1]!.reason, 'got 500, expected 2xx, 3xx');
});

test('a probe that keeps flipping is called flapping, and its state is held rather than announced each time', async () => {
  const { mon, twin, clock, events } = rig();
  mon.add(web({ retries: 0, failuresToDown: 1, successesToUp: 1, flapWindow: 10, flapTransitions: 5 }));
  const step = async (good: boolean) => {
    twin.script('http', 'https://example.com/', good ? ok : { status: 500 });
    clock.now += 60_000;
    return (await mon.check('web')).state;
  };
  await step(true);
  for (let i = 0; i < 8; i++) await step(i % 2 === 1);
  const s = mon.state('web');
  assert.equal(s.flapping, true);
  assert.ok(events.some((e) => e.kind === 'flapping-started'));
  const stateChanges = events.filter((e) => e.kind === 'state').length;
  assert.ok(stateChanges <= 6, `held after the flapping began, got ${stateChanges} announcements for 9 checks`);
  for (let i = 0; i < 10; i++) await step(true);
  assert.equal(mon.state('web').flapping, false);
  assert.ok(events.some((e) => e.kind === 'flapping-ended'));
  assert.equal(mon.state('web').state, 'up');
});

test('during a maintenance window failures are recorded but never counted, announced or held against uptime', async () => {
  const { mon, twin, clock, events } = rig({ maintenance: [{ from: T0 + 10 * 60_000, to: T0 + 30 * 60_000, message: 'database upgrade', noticeMs: 5 * 60_000, probes: ['web'] }] });
  mon.add(web({ retries: 0, failuresToDown: 2 }));
  const at = async (min: number, o: object) => {
    twin.script('http', 'https://example.com/', o);
    clock.now = T0 + min * 60_000;
    return mon.check('web');
  };
  await at(0, ok);
  assert.equal((await at(6, ok)).state.maintenance, 'notice');
  assert.equal((await at(12, { status: 500 })).state.state, 'maintenance');
  assert.equal((await at(15, { status: 500 })).state.state, 'maintenance');
  assert.equal((await at(20, { status: 500 })).state.state, 'maintenance');
  assert.ok(events.every((e) => e.to !== 'down'), 'no outage is announced');
  const after = await at(31, { status: 500 });
  assert.equal(after.state.state, 'up', 'the failures inside the window do not count towards going down');
  assert.equal((await at(32, { status: 500 })).state.state, 'down');
  const u = mon.uptime('web', T0, T0 + 40 * 60_000);
  assert.deepEqual([u.checks, u.maintenance, u.down], [7, 3, 2]);
  assert.equal(mon.state('web').maintenance, 'none');
});

test('a window for other probes does not silence this one', async () => {
  const { mon, twin, clock } = rig({ maintenance: [{ from: T0, to: T0 + 3_600_000, message: 'x', noticeMs: 0, probes: ['other'] }] });
  mon.add(web({ retries: 0, failuresToDown: 1 }));
  twin.script('http', 'https://example.com/', { status: 500 });
  clock.now += 1000;
  assert.equal((await mon.check('web')).state.state, 'down');
});

test('uptime is worked out from the checks: availability, response times and incidents', async () => {
  const { mon, twin, clock } = rig();
  mon.add(web({ retries: 0, failuresToDown: 2, successesToUp: 1 }));
  const outcomes: [number, number, number][] = [[200, 50, 0], [200, 60, 0], [200, 70, 0], [500, 5, 0], [500, 5, 0], [500, 5, 0], [200, 80, 0], [200, 90, 0], [200, 150, 0], [200, 250, 0]];
  for (const [i, [st, ms]] of outcomes.entries()) {
    twin.script('http', 'https://example.com/', { status: st, ms });
    clock.now = T0 + i * 60_000;
    await mon.check('web');
  }
  const u = mon.uptime('web', T0, T0 + 10 * 60_000);
  assert.deepEqual([u.checks, u.up, u.down, u.degraded], [10, 7, 3, 0]);
  assert.equal(u.availability, 0.7);
  assert.deepEqual([u.p50, u.p95], [80, 250]);
  assert.ok(Math.abs(u.avgMs! - 750 / 7) < 1e-9);
  assert.deepEqual(u.incidents, [{ from: T0 + 4 * 60_000, to: T0 + 6 * 60_000 }]);
  const empty = mon.uptime('web', T0 + 3_600_000, T0 + 7_200_000);
  assert.deepEqual([empty.availability, empty.avgMs, empty.p50, empty.incidents], [null, null, null, []]);
});

test('history is bounded: old checks fall off and the newest are kept', async () => {
  const { mon, twin, clock } = rig({ historySize: 5 });
  mon.add(web({ retries: 0 }));
  for (let i = 0; i < 8; i++) {
    twin.script('http', 'https://example.com/', { ...ok, ms: 10 + i });
    clock.now = T0 + i * 60_000;
    await mon.check('web');
  }
  assert.deepEqual(mon.history('web').map((r) => r.ms), [13, 14, 15, 16, 17]);
});

test('tick runs only what is due, spreads first checks across the interval, and never overlaps a probe with itself', async () => {
  const { mon, twin, clock } = rig();
  for (const id of ['a', 'b', 'c']) mon.add(web({ id, url: `https://${id}.example.com/` }));
  for (const id of ['a', 'b', 'c']) twin.script('http', `https://${id}.example.com/`, ok);
  const firstDue = ['a', 'b', 'c'].map((id) => mon.nextDue(id) - T0);
  assert.ok(firstDue.every((d) => d >= 0 && d < 60_000));
  assert.ok(new Set(firstDue).size > 1, 'the start times are staggered');
  assert.equal((await mon.tick()).length, firstDue.filter((d) => d === 0).length);
  clock.now = T0 + 60_000;
  const ran = await mon.tick();
  assert.equal(ran.length, 3);
  assert.equal((await mon.tick()).length, 0, 'not due again for a minute');
  clock.now += 60_000;
  twin.script('http', 'https://a.example.com/', 'hang');
  mon.add(web({ id: 'slow', url: 'https://a.example.com/', timeoutMs: 100 }));
  const first = mon.check('slow');
  await assert.rejects(mon.check('slow'), /already being checked/);
  assert.equal((await first).result.status, 'down');
});

test('ticks are limited to a few probes at a time', async () => {
  let now = 0;
  let peak = 0;
  const { mon, twin, clock } = rig({ concurrency: 2 });
  for (let i = 0; i < 6; i++) {
    mon.add({ type: 'tcp', id: `t${i}`, host: `h${i}.example.com`, port: 80, intervalMs: 60_000, timeoutMs: 1000 });
    twin.script('tcp', `h${i}.example.com:80`, async () => {
      now++;
      peak = Math.max(peak, now);
      await new Promise((r) => setTimeout(r, 5));
      now--;
      return { ms: 5 };
    });
  }
  clock.now = T0 + 60_000;
  assert.equal((await mon.tick()).length, 6);
  assert.equal(peak, 2);
});

test('the confirmed states feed the status page of the health block', async () => {
  const { mon, twin, clock } = rig();
  mon.add(web({ id: 'site', retries: 0, failuresToDown: 1, name: 'Website' }));
  mon.add({ type: 'tcp', id: 'db', name: 'Database', host: 'db.example.com', port: 5432, intervalMs: 60_000, timeoutMs: 1000, degradedMs: 10 });
  twin.script('http', 'https://example.com/', { status: 500 });
  twin.script('tcp', 'db.example.com:5432', { ms: 50 });
  clock.now += 1;
  await mon.check('site');
  await mon.check('db');
  assert.deepEqual(mon.components(), [{ name: 'Website', status: 'down' }, { name: 'Database', status: 'degraded' }]);
  assert.equal(statusPage(mon.components(), []).overall, 'down');
  mon.remove('site');
  assert.deepEqual(mon.ids(), ['db']);
  assert.throws(() => mon.remove('site'), /no probe/);
});

test('an unscripted twin fails loudly, so a test never passes by accident', async () => {
  const { mon } = rig();
  mon.add(web({ retries: 0 }));
  const r = (await mon.check('web')).result;
  assert.deepEqual([r.status, r.message], ['down', 'the twin has nothing scripted for https://example.com/']);
});
