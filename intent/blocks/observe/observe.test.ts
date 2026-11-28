import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Errors, Logger, Metrics, keepDays, redact, span, traceparent, withTrace } from './index.ts';

test('sensitive keys and secret-shaped values never reach a log line', () => {
  const lines: string[] = [];
  const log = new Logger({ write: (l) => lines.push(l), build: 'abc123', extraSensitive: ['diagnosis'] });
  log.info('charged card 4242 4242 4242 4242 for ana', { password: 'hunter2', user: { name: 'Ana', token: 'x', diagnosis: 'flu' }, header: 'Bearer eyJhbGciOi.eyJzdWIiOjF9.c2ln', note: 'ssn 123-45-6789' });
  const l = JSON.parse(lines[0]!);
  assert.equal(l.password, '[redacted]');
  assert.equal(l.user.token, '[redacted]');
  assert.equal(l.user.diagnosis, '[redacted]');
  assert.equal(l.user.name, 'Ana');
  assert.match(l.message, /\[card\]/);
  assert.equal(l.header, 'Bearer [redacted]');
  assert.equal(l.note, 'ssn [ssn]');
  assert.equal(l.build, 'abc123');
  assert.equal(JSON.stringify(redact({ a: [{ secret: 1 }] })), '{"a":[{"secret":"[redacted]"}]}');
});

test('a trace follows a request through every step, and every line written inside carries it', async () => {
  const lines: string[] = [];
  const log = new Logger({ write: (l) => lines.push(l), project: 'p' });
  const incoming = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const { spans } = await withTrace({ traceparent: incoming, feature: 'upload', name: 'PUT /file' }, async () => {
    await span('store', async () => {
      log.info('stored');
      assert.match(traceparent()!, /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
    });
    await span('index', async () => undefined, { rows: 3 });
  });
  assert.equal(spans.length, 3);
  assert.ok(spans.every((s) => s.trace === '4bf92f3577b34da6a3ce929d0e0e4736' && s.end !== undefined));
  assert.equal(spans[1]!.parent, spans[0]!.span);
  const l = JSON.parse(lines[0]!);
  assert.equal(l['logging.googleapis.com/trace'], 'projects/p/traces/4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(l['logging.googleapis.com/spanId'], spans[1]!.span);
  assert.equal(l.feature, 'upload');
});

test('errors group by kind and place, with ids stripped, linked to builds, features and traces', async () => {
  const seen: string[] = [];
  const errs = new Errors({ onNew: (g) => seen.push(g.fingerprint) });
  const boom = (id: number) => {
    throw new Error(`order ${id} not found`);
  };
  for (const id of [1, 22, 333])
    await withTrace({ name: 'x', feature: 'orders' }, async () => {
      try {
        boom(id);
      } catch (e) {
        errs.capture(e, { build: 'b1' });
      }
    });
  assert.equal(errs.groups.size, 1, 'three occurrences, one group');
  const g = [...errs.groups.values()][0]!;
  assert.equal(g.count, 3);
  assert.equal(g.message, 'order # not found');
  assert.deepEqual([...g.features], ['orders']);
  assert.equal(g.traces.length, 3);
  assert.equal(seen.length, 1, 'alerted once, on the first');
  errs.capture(new TypeError('different'));
  assert.equal(errs.groups.size, 2);
});

test('metrics: counters, latency percentiles and the Prometheus text format', () => {
  const m = new Metrics();
  m.count('requests', { route: 'dav' });
  m.count('requests', { route: 'dav' });
  for (let i = 1; i <= 100; i++) m.observe('latency_ms', i, { route: 'dav' });
  assert.equal(m.value('requests', { route: 'dav' }), 2);
  assert.equal(m.percentile('latency_ms', 95, { route: 'dav' }), 95);
  const t = m.text();
  assert.match(t, /requests\{route="dav"\} 2/);
  assert.match(t, /latency_ms_bucket\{route="dav",le="50"\} 50/);
  assert.match(t, /latency_ms_count\{route="dav"\} 100/);
  assert.equal(keepDays({ severity: 'INFO', kind: 'audit' }, [{ match: { kind: 'audit' }, days: 400 }, { match: { severity: 'INFO' }, days: 30 }]), 400);
});

test('Prometheus text: label values are escaped, each family is typed and grouped, histograms carry _sum and ordered buckets', () => {
  const m = new Metrics();
  m.count('requests', { route: 'a"b\\c\nd' });
  m.count('requests', { route: 'x', code: '200' });
  m.observe('latency_ms', 7, { route: 'x' });
  m.observe('latency_ms', 20_000, { route: 'x' });
  const t = m.text();
  assert.ok(t.includes('requests{route="a\\"b\\\\c\\nd"} 1'), t);
  assert.equal(t.split('\n').filter((l) => l.startsWith('requests')).length, 2, 'a value cannot start a line of its own');
  assert.match(t, /# TYPE requests counter\n/);
  assert.match(t, /# TYPE latency_ms histogram\n/);
  assert.match(t, /latency_ms_sum\{route="x"\} 20007\n/);
  const les = [...t.matchAll(/latency_ms_bucket\{route="x",le="([^"]+)"\}/g)].map((x) => x[1]);
  assert.deepEqual(les, ['5', '10', '25', '50', '100', '250', '500', '1000', '2500', '5000', '10000', '+Inf'], 'buckets in increasing order, +Inf last');
  assert.notEqual(m.value('requests', { route: 'x",code="200' }), 1, 'a crafted value is not another series');
  assert.throws(() => m.count('bad name', {}), /metric name/);
  assert.throws(() => m.count('ok', { 'bad-label': 'x' }), /label name/);
});

test('the 0th percentile is the smallest observation', () => {
  const m = new Metrics();
  for (const v of [3, 1, 2]) m.observe('x', v);
  assert.equal(m.percentile('x', 0), 1);
  assert.equal(m.percentile('x', 100), 3);
});

test('fields cannot overwrite a line’s severity, message or time', () => {
  const lines: string[] = [];
  new Logger({ write: (l) => lines.push(l) }).error('disk full', { severity: 'DEBUG', message: 'all fine', time: 'never' });
  const l = JSON.parse(lines[0]!);
  assert.equal(l.severity, 'ERROR');
  assert.equal(l.message, 'disk full');
  assert.notEqual(l.time, 'never');
});

test('secret-bearing keys are redacted in their common spellings', () => {
  const r = redact({ client_secret: 'a', 'x-api-key': 'b', 'api-key': 'c', 'proxy-authorization': 'd', id_token: 'e', newPassword: 'f', aws_secret_access_key: 'g', privateKey: 'h', user: 'ana' }) as Record<string, unknown>;
  for (const k of ['client_secret', 'x-api-key', 'api-key', 'proxy-authorization', 'id_token', 'newPassword', 'aws_secret_access_key', 'privateKey']) assert.equal(r[k], '[redacted]', k);
  assert.equal(r['user'], 'ana');
});

test('an all-zero trace or parent id in traceparent is invalid (W3C Trace Context) and starts a new trace', async () => {
  const zeroTrace = '00-00000000000000000000000000000000-00f067aa0ba902b7-01';
  const zeroParent = '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01';
  for (const tp of [zeroTrace, zeroParent]) {
    const { spans } = await withTrace({ traceparent: tp, name: 'x' }, async () => undefined);
    assert.notEqual(spans[0]!.trace, '00000000000000000000000000000000');
    assert.equal(spans[0]!.parent, undefined);
  }
});

test('error groups are capped: the least recently seen is evicted, and evictions are counted', () => {
  const errs = new Errors({ maxGroups: 3 });
  const fail = (name: string) => errs.capture(new Error(`no user named ${name}`));
  for (const k of ['alpha', 'bravo', 'charlie', 'alpha', 'delta']) fail(k);
  assert.equal(errs.groups.size, 3);
  assert.deepEqual([...errs.groups.values()].map((g) => g.message), ['no user named charlie', 'no user named alpha', 'no user named delta'], 'bravo, seen least recently, went');
  assert.equal(errs.evicted, 1);
  assert.equal([...errs.groups.values()][1]!.count, 2, 'a group kept keeps its count');
  const many = new Errors();
  // Base 20 written in letters that are not hex digits, so the message stripping leaves every one distinct.
  const word = (i: number) => [...i.toString(20)].map((c) => 'ghijklmnopqrstuvwxyz'[parseInt(c, 20)]!).join('');
  for (let i = 0; i < 1500; i++) many.capture(new Error(`no user named ${word(i)}`));
  assert.equal(many.groups.size, 1000, 'the default cap holds');
  assert.equal(many.evicted, 500);
});

test('keys are redacted only when they are secret-bearing: short names exactly, the rest wherever they appear', () => {
  const r = redact({ ssn: 1, card: 1, cardnumber: 1, cvv: 1, cvc: 1, pin: 1, dob: 1, dateofbirth: 1, apikey: 1, api_key: 1, privatekey: 1, 'private-key': 1, private_key: 1, Authorization: 1, 'Set-Cookie': 1, db_credentials: 1, passwd: 1, password: 1 }) as Record<string, unknown>;
  for (const k of Object.keys(r)) assert.equal(r[k], '[redacted]', k);
  const kept = redact({ discard: 1, pinned: 1, cardinality: 1, xssn: 1, ssnx: 1, dobson: 1, spin: 1, apikeys_count: 0, pri: 1 }) as Record<string, unknown>;
  assert.equal(kept['discard'], 1);
  assert.equal(kept['pinned'], 1);
  assert.equal(kept['cardinality'], 1);
  assert.equal(kept['xssn'], 1);
  assert.equal(kept['ssnx'], 1);
  assert.equal(kept['dobson'], 1);
  assert.equal(kept['spin'], 1);
  assert.equal(kept['pri'], 1);
});

test('secret-shaped values are replaced wherever they appear: bearer and basic credentials, API keys, JWTs', () => {
  assert.equal(redact('Authorization: Bearer   abc.DEF-123_x='), 'Authorization: Bearer [redacted]');
  assert.equal(redact('Basic\tdXNlcjpwYXNz'), 'Basic [redacted]');
  assert.equal(redact('key sk_live_abcdefgh12345 used'), 'key [key] used');
  assert.equal(redact('pk_test_ABCDEFGH and rk_live_12345678'), '[key] and [key]');
  assert.equal(redact('sk_test_abc is too short to be a key'), 'sk_test_abc is too short to be a key');
  assert.equal(redact('sk_live_abcdefg is seven'), 'sk_live_abcdefg is seven');
  // A JWT made here, so the repository holds no token: its header and claims encoded as any issuer would.
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = `${b64({ alg: 'HS256' })}.${b64({ sub: '1234567890' })}.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk`;
  assert.equal(redact(`token ${jwt} done`), 'token [jwt] done');
  assert.equal(redact('eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.sig'), '[jwt]');
});

test('nothing deeper than eight levels is written', () => {
  const nest = (n: number): unknown => (n === 0 ? 'leaf' : { a: nest(n - 1) });
  const walk = (v: unknown): number => (typeof v === 'object' && v ? 1 + walk((v as { a: unknown }).a) : 0);
  const out = redact(nest(12));
  assert.equal(walk(out), 9, 'nine levels of objects, then the marker');
  let cur: unknown = out;
  for (let i = 0; i < 9; i++) cur = (cur as { a: unknown }).a;
  assert.equal(cur, '[deep]');
  let kept: unknown = redact(nest(8));
  for (let i = 0; i < 8; i++) kept = (kept as { a: unknown }).a;
  assert.equal(kept, 'leaf', 'a value at depth 8 is still written');
  const arrays = (n: number): unknown => (n === 0 ? 'leaf' : [arrays(n - 1)]);
  let a: unknown = redact(arrays(12));
  for (let i = 0; i < 9; i++) a = (a as unknown[])[0];
  assert.equal(a, '[deep]');
  const withLeaf = (n: number, leaf: unknown): unknown => (n === 0 ? leaf : { a: withLeaf(n - 1, leaf) });
  let shallow: unknown = redact(withLeaf(7, new Error('shown')));
  for (let i = 0; i < 7; i++) shallow = (shallow as { a: unknown }).a;
  assert.deepEqual(shallow, { name: 'Error', message: 'shown' });
  let deep: unknown = redact(withLeaf(8, new Error('hidden')));
  for (let i = 0; i < 8; i++) deep = (deep as { a: unknown }).a;
  assert.deepEqual(deep, { name: 'Error', message: '[deep]' }, 'an error’s message is one level below the error');
});

test('errors are written as name and redacted message; plain values pass through untouched', () => {
  assert.deepEqual(redact(new TypeError('bad Bearer abc123')), { name: 'TypeError', message: 'bad Bearer [redacted]' });
  assert.deepEqual(redact({ e: new Error('x') }), { e: { name: 'Error', message: 'x' } });
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(42), 42);
  assert.equal(redact(0), 0);
  assert.equal(redact(true), true);
  assert.equal(redact(false), false);
  assert.equal(redact(''), '');
});

test('a minimum severity drops everything below it and keeps everything at or above it', () => {
  const order = ['DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL'] as const;
  for (const [mi, min] of order.entries())
    for (const [si, sev] of order.entries()) {
      const lines: string[] = [];
      new Logger({ write: (l) => lines.push(l), min }).log(sev, 'm');
      assert.equal(lines.length, si >= mi ? 1 : 0, `${sev} with min ${min}`);
    }
  for (const sev of order) {
    const lines: string[] = [];
    new Logger({ write: (l) => lines.push(l) }).log(sev, 'm');
    assert.equal(lines.length, 1, `${sev} with no minimum`);
  }
});

test('the shorthand methods file lines under INFO, WARNING and ERROR', () => {
  const lines: string[] = [];
  const log = new Logger({ write: (l) => lines.push(l) });
  log.info('a');
  log.warn('b');
  log.error('c');
  assert.deepEqual(lines.map((l) => JSON.parse(l).severity), ['INFO', 'WARNING', 'ERROR']);
  assert.deepEqual(lines.map((l) => JSON.parse(l).message), ['a', 'b', 'c']);
});

test('with no writer given, a line goes to standard output as one JSON object ending in a newline', () => {
  const w = mock.method(process.stdout, 'write', () => true);
  try {
    new Logger().info('hello', { n: 1 });
  } finally {
    w.mock.restore();
  }
  assert.equal(w.mock.callCount(), 1);
  const out = String(w.mock.calls[0]!.arguments[0]);
  assert.ok(out.endsWith('}\n'), out);
  assert.equal(JSON.parse(out).message, 'hello');
  assert.equal(out.split('\n').length, 2);
});

test('a traceparent must match the W3C shape in full; ids with zeros inside or at the ends are fine', async () => {
  const idsOf = async (tp: string) => (await withTrace({ traceparent: tp, name: 'x' }, async () => undefined)).spans[0]!;
  const ok = await idsOf('00-0bf92f3577b34da6a3ce929d0e0e4700-00f067aa0ba90200-01');
  assert.equal(ok.trace, '0bf92f3577b34da6a3ce929d0e0e4700');
  assert.equal(ok.parent, '00f067aa0ba90200');
  const trailingParent = await idsOf('00-4bf92f3577b34da6a3ce929d0e0e4736-f067aa0ba9020000-01');
  assert.equal(trailingParent.parent, 'f067aa0ba9020000');
  const leadingParent = await idsOf('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000001-01');
  assert.equal(leadingParent.parent, '0000000000000001');
  const leadingTrace = await idsOf('00-00000000000000000000000000000001-00f067aa0ba902b7-01');
  assert.equal(leadingTrace.trace, '00000000000000000000000000000001');
  for (const bad of ['x00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01x', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-1']) {
    const s = await idsOf(bad);
    assert.notEqual(s.trace, '4bf92f3577b34da6a3ce929d0e0e4736', bad);
    assert.equal(s.parent, undefined, bad);
    assert.match(s.trace, /^[0-9a-f]{32}$/);
  }
});

test('the root span records the caller’s span as its parent; every span ends with its outcome', async () => {
  const { spans } = await withTrace({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', name: 'root' }, async () => {
    await span('fine', async () => undefined);
    try {
      await span('broken', async () => {
        throw new Error('nope');
      });
    } catch {
      // the failure is recorded on the span and rethrown; the request carries on
    }
  });
  assert.equal(spans[0]!.parent, '00f067aa0ba902b7');
  assert.equal(spans[0]!.status, 'ok');
  assert.equal(spans[1]!.status, 'ok');
  assert.equal(spans[2]!.status, 'error');
  assert.ok(spans.every((x) => typeof x.end === 'number' && x.end >= x.start));
  const fresh = await withTrace({ name: 'noparent' }, async () => undefined);
  assert.equal('parent' in fresh.spans[0]!, false, 'no caller, no parent key');
});

test('a failing request rejects with its own error, and a failing step rejects too', async () => {
  const boom = new Error('request failed');
  await assert.rejects(withTrace({ name: 'x' }, async () => { throw boom; }), (e) => e === boom);
  const stepBoom = new Error('step failed');
  await assert.rejects(withTrace({ name: 'x' }, async () => { await span('s', async () => { throw stepBoom; }); }), (e) => e === stepBoom);
});

test('a step run outside any trace just runs', async () => {
  assert.equal(await span('alone', async () => 5), 5);
  await assert.rejects(span('alone', async () => { throw new Error('still thrown'); }), /still thrown/);
});

test('an error group names the place it was thrown, from the first frame in the application’s own code', () => {
  const errs = new Errors();
  const withStack = (stack: string) => {
    const e = new Error('x');
    e.stack = stack;
    return errs.capture(e).where;
  };
  assert.equal(withStack('Error: x\n    at foo (node:internal/foo:1:2)\n    at pkg (/app/node_modules/pkg/index.js:3:4)\n    at real (/app/src/mod.ts:10:15)\n    at later (/app/src/other.ts:1:1)'), 'real (mod.ts:10');
  assert.equal(withStack('Error: x\n    at   spaced (C:\\app\\src\\win.ts:7:22)'), 'spaced (win.ts:7');
  assert.equal(withStack('Error: x\n    at /app/src/anon.ts:12:5'), '/app/src/anon.ts:12', 'a frame with no function name keeps its path');
  assert.equal(withStack('Error: x\n    at node:internal/a:1:1\n    at /app/node_modules/x/y.js:1:1'), 'unknown');
  assert.equal(withStack('Error: x\n    inside a function that at   happens (/app/src/odd.ts:3:4)'), 'inside a function that at   happens (odd.ts:3', 'only a leading "at" is dropped');
  assert.equal(withStack('Error: x'), 'unknown');
  assert.equal(withStack('only one line'), 'unknown', 'the first line is the message, not a frame');
  const noStack = new Error('x');
  delete (noStack as { stack?: string }).stack;
  assert.equal(errs.capture(noStack).where, 'unknown');
  const boom = () => {
    throw new Error('real');
  };
  try {
    boom();
  } catch (e) {
    assert.match(errs.capture(e).where, /^boom \(observe\.test\.ts:\d+$/);
  }
});

test('error messages lose hex ids and numbers, and the fingerprint is sixteen hex digits', () => {
  const errs = new Errors();
  const fail = (m: string) => errs.capture(new Error(m));
  const g = fail('session 0123abcd4567 for deadbeefcafe at 10.0.0.1:5432 failed');
  assert.equal(g.message, 'session # for # at #.#.#.#:# failed');
  assert.match(g.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(fail('session ffffffff0000 for abcdef012345 at 1.2.3.4:80 failed').fingerprint, g.fingerprint, 'same shape, same group');
  assert.notEqual(fail('something else').fingerprint, g.fingerprint);
  assert.equal(errs.capture('a plain string').name, 'Error', 'a thrown non-error is wrapped');
});

test('an error group records the builds and features that saw it, and only those that were given', async () => {
  const errs = new Errors();
  const fail = () => new Error('same place');
  const mk = (o?: { build?: string; feature?: string }) => errs.capture(fail(), o ?? {});
  const bare = mk();
  assert.equal(bare.builds.size, 0);
  assert.equal(bare.features.size, 0);
  assert.equal(bare.traces.length, 0, 'outside a trace there is no trace to link');
  mk({ build: 'b1', feature: 'f1' });
  mk({ build: 'b2' });
  const g = mk({ build: 'b1' });
  assert.deepEqual([...g.builds], ['b1', 'b2']);
  assert.deepEqual([...g.features], ['f1']);
});

test('an error group links at most the first twenty traces', async () => {
  const errs = new Errors();
  const ids: string[] = [];
  for (let i = 0; i < 25; i++)
    await withTrace({ name: 'x' }, async () => {
      ids.push(traceparent()!.split('-')[1]!);
      errs.capture(new Error('same'));
    });
  const g = [...errs.groups.values()][0]!;
  assert.equal(g.count, 25);
  assert.equal(g.traces.length, 20);
  assert.deepEqual(g.traces, ids.slice(0, 20));
});

test('label order never matters: the same labels in any order are one series, written sorted by name', () => {
  const m = new Metrics();
  const perms = [['a', 'b', 'c', 'd', 'e'], ['e', 'd', 'c', 'b', 'a'], ['c', 'a', 'e', 'b', 'd'], ['b', 'e', 'a', 'd', 'c']];
  for (const p of perms) m.count('hits', Object.fromEntries(p.map((k) => [k, k.toUpperCase()])));
  assert.equal(m.value('hits', { e: 'E', d: 'D', c: 'C', b: 'B', a: 'A' }), 4);
  assert.match(m.text(), /^hits\{a="A",b="B",c="C",d="D",e="E"\} 4$/m);
  assert.equal(m.text().split('\n').filter((l) => l.startsWith('hits')).length, 1);
});

test('a label named le or starting with two underscores is refused; one that merely ends in underscores is fine', () => {
  const m = new Metrics();
  assert.throws(() => m.count('x', { le: '1' }), /"le" is not a label name that can be used/);
  assert.throws(() => m.count('x', { __name: '1' }), /label name/);
  assert.throws(() => m.observe('x', 1, { __name: '1' }), /label name/);
  m.count('x', { trailing__: '1', less: '2' });
  assert.equal(m.value('x', { trailing__: '1', less: '2' }), 1);
});

test('the whole Prometheus text, exactly: families sorted, series sorted, one TYPE line each, histograms cumulative', () => {
  const m = new Metrics();
  m.count('z_total');
  m.count('req', { code: '500' });
  m.count('req', { code: '200' }, 3);
  m.count('a_total', { y: '1', x: '2' });
  m.observe('lat', 7);
  m.observe('lat', 20_000);
  m.observe('lat', 5);
  const buckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];
  const cum = [1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2];
  const expected = [
    '# TYPE a_total counter',
    'a_total{x="2",y="1"} 1',
    ...['# TYPE lat histogram', ...buckets.map((b, i) => `lat_bucket{le="${b}"} ${cum[i]}`), 'lat_bucket{le="+Inf"} 3', 'lat_sum 20012', 'lat_count 3'],
    '# TYPE req counter',
    'req{code="200"} 3',
    'req{code="500"} 1',
    '# TYPE z_total counter',
    'z_total 1',
  ].join('\n') + '\n';
  assert.equal(m.text(), expected);
});

test('a labelled histogram: _sum and _count carry the labels, +Inf counts what is beyond the last bucket', () => {
  const m = new Metrics();
  m.observe('lat', 99_999, { route: 'r' });
  const t = m.text();
  assert.match(t, /^lat_bucket\{route="r",le="10000"\} 0$/m);
  assert.match(t, /^lat_bucket\{route="r",le="\+Inf"\} 1$/m);
  assert.match(t, /^lat_sum\{route="r"\} 99999$/m);
  assert.match(t, /^lat_count\{route="r"\} 1$/m);
});

test('an empty registry writes just a newline', () => {
  assert.equal(new Metrics().text(), '\n');
});

test('percentiles: unobserved is null, above 100 is the largest, and only the last 2000 observations count', () => {
  const m = new Metrics();
  assert.equal(m.percentile('none', 50), null);
  assert.equal(m.percentile('none', 50, { a: 'b' }), null);
  for (const v of [5, 1, 3]) m.observe('few', v);
  assert.equal(m.percentile('few', 150), 5);
  assert.equal(m.percentile('few', 1000), 5);
  assert.equal(m.percentile('few', 50), 3);
  for (let i = 1; i <= 2005; i++) m.observe('many', i);
  assert.equal(m.percentile('many', 0), 6, 'the oldest five fell out');
  assert.equal(m.percentile('many', 100), 2005);
  const exact = new Metrics();
  for (let i = 1; i <= 2000; i++) exact.observe('x', i);
  assert.equal(exact.percentile('x', 0), 1, 'exactly 2000 are all kept');
  exact.observe('x', 2001);
  assert.equal(exact.percentile('x', 0), 2, 'the 2001st pushes out the first');
});

test('retention: the longest matching rule wins; a rule matches only when every field it names matches; otherwise the fallback', () => {
  const line = { severity: 'INFO' as const, kind: 'audit' };
  assert.equal(keepDays(line, []), 30);
  assert.equal(keepDays(line, [], 7), 7);
  assert.equal(keepDays(line, [{ match: { severity: 'ERROR' }, days: 90 }], 7), 7, 'a different severity does not match');
  assert.equal(keepDays(line, [{ match: { severity: 'INFO' }, days: 90 }], 7), 90);
  assert.equal(keepDays(line, [{ match: { kind: 'access' }, days: 90 }], 7), 7, 'a different kind does not match');
  assert.equal(keepDays({ severity: 'INFO' }, [{ match: { kind: 'audit' }, days: 90 }], 7), 7, 'a line with no kind does not match a kind rule');
  assert.equal(keepDays(line, [{ match: { kind: 'audit' }, days: 90 }], 7), 90);
  assert.equal(keepDays(line, [{ match: {}, days: 11 }], 7), 11, 'an empty match applies to every line');
  assert.equal(keepDays(line, [{ match: { severity: 'ERROR', kind: 'audit' }, days: 90 }], 7), 7, 'both fields must match');
  assert.equal(keepDays(line, [{ match: { severity: 'INFO', kind: 'billing' }, days: 90 }], 7), 7, 'both fields must match');
  assert.equal(keepDays(line, [{ match: { severity: 'INFO', kind: 'audit' }, days: 90 }], 7), 90);
  assert.equal(keepDays(line, [{ match: { severity: 'INFO' }, days: 30 }, { match: { kind: 'audit' }, days: 400 }, { match: {}, days: 10 }, { match: { severity: 'ERROR' }, days: 9999 }]), 400);
  assert.equal(keepDays(line, [{ match: { kind: 'audit' }, days: 400 }, { match: { severity: 'INFO' }, days: 30 }]), 400, 'order of rules does not matter');
});
