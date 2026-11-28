import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Subscribers, StatusPageError, atomFeed, badge, badgeKeyOk, dailyBars, escapeXml, jsonFeed, monitorStatus, pageView, uptime } from './index.ts';
import type { Beat, Group, Incident, Monitor } from './index.ts';

const DAY = 86_400_000;
const T = Date.UTC(2026, 5, 10, 12, 0, 0);
const beats = (...ups: boolean[]): Beat[] => ups.map((up, i) => ({ at: T - (ups.length - i) * 60_000, up, ms: 100 }));
const groups: Group[] = [
  { name: 'Core', components: [{ id: 'api', name: 'API', monitors: ['m-api'] }, { id: 'web', name: 'Website', monitors: ['m-web'] }] },
  { name: 'Extras', components: [{ id: 'mail', name: 'Email', monitors: ['m-mail'] }] },
];
const inc = (over: Partial<Incident> = {}): Incident => ({ id: 'i1', title: 'API errors', components: ['api'], impact: 'degraded', updates: [{ at: T - 1000, state: 'investigating', text: 'Looking into it' }], ...over });

test('three failures in a row are down, one is degraded, and a pass after them clears it', () => {
  assert.equal(monitorStatus(beats(true, true, false, false, false)), 'down');
  assert.equal(monitorStatus(beats(true, true, true, false)), 'degraded');
  assert.equal(monitorStatus(beats(false, false, false, true)), 'ok');
  assert.equal(monitorStatus([]), 'ok');
});

test('a slow newest answer is degraded', () => {
  const b: Beat[] = [{ at: 1, up: true, ms: 5000 }];
  assert.equal(monitorStatus(b), 'degraded');
  assert.equal(monitorStatus(b, { downAfter: 3, slowMs: 6000 }), 'ok');
});

test('beats are read newest first whatever order they arrive in', () => {
  const b = beats(false, false, false, true).reverse();
  assert.equal(monitorStatus(b), 'ok');
});

test('the page takes the worst monitor per component, group and overall, and says why', () => {
  const monitors: Monitor[] = [{ id: 'm-api', beats: beats(true, false, false, false) }, { id: 'm-web', beats: beats(true, true) }, { id: 'm-mail', beats: beats(true, false) }];
  const v = pageView(groups, monitors, [], [], T);
  assert.equal(v.overall, 'down');
  assert.equal(v.headline, 'Some systems are down');
  assert.deepEqual(v.groups.map((g) => g.status), ['down', 'degraded']);
  assert.equal(v.groups[0]!.components[0]!.because, 'monitor m-api is down');
  assert.equal(v.groups[0]!.components[1]!.status, 'ok');
});

test('an open incident raises a passing component; a resolved one does not', () => {
  const monitors: Monitor[] = [{ id: 'm-api', beats: beats(true, true) }];
  const v = pageView(groups, monitors, [inc()], [], T);
  assert.equal(v.groups[0]!.components[0]!.status, 'degraded');
  assert.equal(v.groups[0]!.components[0]!.because, 'incident: API errors');
  assert.equal(v.incidents[0]!.latest, 'Looking into it');
  const resolved = inc({ updates: [{ at: 1, state: 'investigating', text: 'a' }, { at: 2, state: 'resolved', text: 'fixed' }] });
  assert.equal(pageView(groups, monitors, [resolved], [], T).overall, 'ok');
  assert.equal(pageView(groups, monitors, [resolved], [], T).incidents.length, 0);
});

test('an incident never lowers a worse monitor state', () => {
  const monitors: Monitor[] = [{ id: 'm-api', beats: beats(false, false, false) }];
  const v = pageView(groups, monitors, [inc()], [], T);
  assert.equal(v.groups[0]!.components[0]!.because, 'monitor m-api is down');
});

test('maintenance overrides the monitors only while its window is active, and is listed ahead of time', () => {
  const monitors: Monitor[] = [{ id: 'm-api', beats: beats(false, false, false) }];
  const m = { id: 'mx', title: 'DB upgrade', components: ['api'], from: T + 1000, to: T + 5000 };
  const before = pageView(groups, monitors, [], [m], T);
  assert.equal(before.groups[0]!.components[0]!.status, 'down');
  assert.deepEqual(before.maintenance, [{ id: 'mx', title: 'DB upgrade', active: false, from: T + 1000, to: T + 5000 }]);
  const during = pageView(groups, monitors, [], [m], T + 2000);
  assert.equal(during.groups[0]!.components[0]!.because, 'scheduled maintenance');
  assert.equal(during.maintenance[0]!.active, true);
  assert.deepEqual(pageView(groups, monitors, [], [m], T + 6000).maintenance, []);
});

test('uptime is the share of passing beats in the window, to two decimals', () => {
  const b: Beat[] = [];
  for (let i = 0; i < 300; i++) b.push({ at: T - i * 60_000, up: i !== 5 });
  assert.equal(uptime(b, T, 400 * 60_000), 99.67);
  assert.equal(uptime(b, T, 3 * 60_000), 100);
  assert.equal(uptime([], T, DAY), null);
  assert.equal(uptime(b, T - 10 * DAY, DAY), null);
});

test('daily bars mark each day ok, degraded or down, and empty days as null', () => {
  const today = Math.floor(T / DAY) * DAY;
  const b: Beat[] = [
    { at: today - 2 * DAY + 1000, up: true },
    { at: today - DAY + 1000, up: true }, { at: today - DAY + 2000, up: false }, { at: today - DAY + 3000, up: true }, { at: today - DAY + 4000, up: true },
    { at: today + 1000, up: false }, { at: today + 2000, up: false }, { at: today + 3000, up: true },
  ];
  assert.deepEqual(dailyBars(b, T, 4), [null, 'ok', 'degraded', 'down']);
});

test('the Atom feed is newest first, well formed and escapes everything', () => {
  const evil = inc({ id: 'i2', title: '<script>alert(1)</script> & "x"', updates: [{ at: T, state: 'identified', text: 'a < b ]]> c' }] });
  const xml = atomFeed({ title: 'Acme & Co', baseUrl: 'https://status.example.com', id: 'urn:acme' }, [inc(), evil]);
  assert.ok(xml.indexOf('i2') < xml.indexOf('/incidents/i1'));
  assert.ok(!xml.includes('<script>'));
  assert.ok(xml.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;'));
  assert.ok(xml.includes('<title>Acme &amp; Co</title>'));
  assert.ok(xml.includes(`<updated>${new Date(T).toISOString()}</updated>`));
  assert.ok(!xml.includes(']]> c'));
});

test('control characters never reach the XML', () => {
  assert.equal(escapeXml('a\u0000b\u0008c\u001fd퟿e'), 'abcd퟿e');
});

test('the JSON feed carries each incident with its updates oldest first', () => {
  const i = inc({ updates: [{ at: 1000, state: 'investigating', text: 'one' }, { at: 2000, state: 'resolved', text: 'two' }] });
  const f = JSON.parse(jsonFeed({ title: 'S', baseUrl: 'https://s.example' }, [i]));
  assert.equal(f.version, 'https://jsonfeed.org/version/1.1');
  assert.equal(f.items[0].content_text, 'resolved: two\ninvestigating: one');
  assert.equal(f.items[0].date_published, '1970-01-01T00:00:01.000Z');
});

test('subscribers are live only after the signed link is followed, and the link works once for the right purpose', () => {
  const subs = new Subscribers('test-signing-key-for-status', 'https://s.example');
  const link = subs.subscribe(' Ana@Example.com ', ['api'], T);
  assert.equal(subs.get('ana@example.com')!.confirmed, false);
  assert.deepEqual(subs.messagesFor(inc(), T), []);
  const token = link.split('t=')[1]!;
  assert.throws(() => subs.unsubscribe(token, T), StatusPageError, 'a confirm token is not an unsubscribe token');
  assert.throws(() => subs.confirm(token, T + 3 * DAY), /expired/);
  assert.equal(subs.confirm(token, T + 1000).confirmed, true);
  assert.deepEqual(subs.count(), { confirmed: 1, pending: 0 });
  assert.throws(() => subs.confirm(token.slice(0, -2) + 'AA', T), StatusPageError);
});

test('notices go only to confirmed people who chose an affected component, once per update', () => {
  const subs = new Subscribers('test-signing-key-for-status', 'https://s.example');
  for (const [e, c] of [['a@x.io', ['api']], ['b@x.io', ['mail']], ['c@x.io', []], ['d@x.io', ['api']]] as const) subs.subscribe(e, c, T);
  for (const e of ['a@x.io', 'b@x.io', 'c@x.io']) subs.confirm(new URL(subs.subscribe(e, subs.get(e)!.components, T)).searchParams.get('t')!, T);
  const first = subs.messagesFor(inc(), T);
  assert.deepEqual(first.map((m) => m.to).sort(), ['a@x.io', 'c@x.io']);
  assert.equal(first[0]!.subject, '[investigating] API errors');
  assert.deepEqual(subs.messagesFor(inc(), T), [], 'asked again, nobody is told twice');
  const next = inc({ updates: [...inc().updates, { at: T + 1, state: 'resolved', text: 'Fixed' }] });
  assert.equal(subs.messagesFor(next, T + 1).length, 2, 'a new update is a new notice');
});

test('one click unsubscribes, and a stranger cannot make a link for someone else', () => {
  const subs = new Subscribers('test-signing-key-for-status', 'https://s.example');
  subs.confirm(new URL(subs.subscribe('a@x.io', [], T)).searchParams.get('t')!, T);
  const m = subs.messagesFor(inc(), T)[0]!;
  assert.equal(subs.unsubscribe(new URL(m.unsubscribe).searchParams.get('t')!, T + 5 * DAY), true);
  assert.equal(subs.get('a@x.io'), undefined);
  const other = new Subscribers('another-signing-key-entirely', 'https://s.example');
  assert.throws(() => subs.unsubscribe(new URL(other.unsubscribeLink('a@x.io', T)).searchParams.get('t')!, T), /not valid/);
});

test('addresses that are not addresses are refused', () => {
  const subs = new Subscribers('test-signing-key-for-status', 'https://s.example');
  for (const bad of ['', 'nobody', 'a@b', 'a b@c.io', 'a@@c.io', '<x>@c.io', 'a@c..io']) assert.throws(() => subs.subscribe(bad, [], T), /not an email/, bad);
});

test('the badge shows the state in words and colour, and a hostile label cannot break out', () => {
  const svg = badge('Acme "API" <x>', 'down');
  assert.ok(svg.includes('aria-label="Acme &quot;API&quot; &lt;x&gt;: down"'));
  assert.ok(svg.includes('fill="#c62828"'));
  assert.ok(!svg.includes('<x>'));
  assert.ok(badge('status', 'ok').includes('operational'));
  assert.ok(badge('status', 'unknown').includes('#5f6368'));
  const wide = Number(/width="(\d+)"/.exec(badge('a much longer label here', 'ok'))![1]);
  const narrow = Number(/width="(\d+)"/.exec(badge('a', 'ok'))![1]);
  assert.ok(wide > narrow);
});

test('badge keys compare in constant time and an empty key never matches', () => {
  assert.equal(badgeKeyOk('k1', 'k1'), true);
  assert.equal(badgeKeyOk('k2', 'k1'), false);
  assert.equal(badgeKeyOk('', ''), false);
});
