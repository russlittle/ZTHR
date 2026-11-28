import assert from 'node:assert/strict';
import { test } from 'node:test';
import { child, children, parseXml } from '../dav/index.ts';
import { CALDAV, CalDav, CS } from './index.ts';
import type { Reply } from './index.ts';

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"';
const HOME = '/calendars/ana/';
const CAL = `${HOME}work/`;
const INBOX = `${HOME}inbox/`;

const ics = (uid: string, lines: string[] = [], o: { method?: string; kind?: string; version?: string } = {}) => ['BEGIN:VCALENDAR', `VERSION:${o.version ?? '2.0'}`, 'PRODID:-//test//EN', ...(o.method ? [`METHOD:${o.method}`] : []), `BEGIN:${o.kind ?? 'VEVENT'}`, `UID:${uid}`, 'DTSTAMP:20260101T000000Z', ...lines, `END:${o.kind ?? 'VEVENT'}`, 'END:VCALENDAR', ''].join('\r\n');
const ev = (uid: string, start: string, end: string, more: string[] = []) => ics(uid, [`DTSTART:${start}`, `DTEND:${end}`, ...more]);

const setup = (o: ConstructorParameters<typeof CalDav>[0] = {}) => {
  const dav = new CalDav({ now: () => 1_800_000_000_000, ...o });
  dav.create(CAL, { displayName: 'Work' });
  const req = (method: string, path: string, body = '', headers: Record<string, string> = {}): Reply => dav.handle({ method, path, headers, body });
  const put = (name: string, text: string) => req('PUT', `${CAL}${name}`, text, { 'content-type': 'text/calendar; charset=utf-8' });
  return { dav, req, put };
};

const responses = (r: Reply) => children(parseXml(r.body), 'DAV:', 'response').map((x) => ({ href: child(x, 'DAV:', 'href')!.text, status: child(x, 'DAV:', 'status')?.text, el: x }));
const hrefs = (r: Reply) => responses(r).map((x) => x.href.replace(CAL, ''));
const query = (filter: string, prop = '<d:getetag/>') => `<c:calendar-query ${NS}><d:prop>${prop}</d:prop><c:filter><c:comp-filter name="VCALENDAR">${filter}</c:comp-filter></c:filter></c:calendar-query>`;
const range = (a: string, b: string) => `<c:time-range start="${a}" end="${b}"/>`;

test('OPTIONS advertises calendar access and MKCALENDAR creates a calendar from its body', () => {
  const { req, dav } = setup();
  const o = req('OPTIONS', CAL);
  assert.match(o.headers.dav!, /calendar-access/);
  assert.match(o.headers.allow!, /MKCALENDAR/);
  const body = `<c:mkcalendar ${NS}><d:set><d:prop><d:displayname>Home</d:displayname><c:calendar-description>Family things</c:calendar-description><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>`;
  assert.equal(req('MKCALENDAR', `${HOME}home/`, body).status, 201);
  const c = dav.collection(`${HOME}home/`);
  assert.deepEqual([c.displayName, c.description, c.components], ['Home', 'Family things', ['VEVENT']]);
  assert.equal(req('MKCALENDAR', `${HOME}home/`).status, 405, 'it exists already');
  assert.equal(req('MKCALENDAR', `${HOME}bad/`, `<c:mkcalendar ${NS}><d:set><d:prop><c:supported-calendar-component-set><c:comp name="VNOPE"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>`).status, 403);
  assert.equal(req('MKCALENDAR', '/elsewhere/x/').status, 404);
  assert.equal(req('MKCALENDAR', '/calendars/../etc/').status, 404);
});

test('PROPFIND on a calendar lists its type, name, ctag, sync token and supported components', () => {
  const { req, put } = setup();
  const body = `<d:propfind ${NS}><d:prop><d:resourcetype/><d:displayname/><cs:getctag/><d:sync-token/><c:supported-calendar-component-set/><d:nonsense/></d:prop></d:propfind>`;
  const r = req('PROPFIND', CAL, body, { depth: '0' });
  assert.equal(r.status, 207);
  const x = responses(r)[0]!.el;
  const ok = children(x, 'DAV:', 'propstat')[0]!;
  const p = child(ok, 'DAV:', 'prop')!;
  assert.deepEqual(children(child(p, 'DAV:', 'resourcetype')!, CALDAV, 'calendar').length, 1);
  assert.equal(child(p, 'DAV:', 'displayname')!.text, 'Work');
  assert.equal(child(p, CS, 'getctag')!.text, `${CAL}@0`);
  assert.equal(child(p, 'DAV:', 'sync-token')!.text, 'urn:caldav-sync:0');
  assert.deepEqual(children(child(p, CALDAV, 'supported-calendar-component-set')!, CALDAV, 'comp').map((c) => c.attrs.name), ['VEVENT', 'VTODO']);
  assert.equal(child(children(x, 'DAV:', 'propstat')[1]!, 'DAV:', 'status')!.text, 'HTTP/1.1 404 Not Found');
  put('a.ics', ev('a', '20260601T100000Z', '20260601T110000Z'));
  const d1 = req('PROPFIND', CAL, `<d:propfind ${NS}><d:prop><d:getetag/><d:getcontenttype/></d:prop></d:propfind>`, { depth: '1' });
  assert.deepEqual(hrefs(d1), [CAL.replace(CAL, ''), 'a.ics']);
  assert.match(child(child(children(responses(d1)[1]!.el, 'DAV:', 'propstat')[0]!, 'DAV:', 'prop')!, 'DAV:', 'getcontenttype')!.text, /component=VEVENT/);
  assert.equal(req('PROPFIND', CAL, '', { depth: 'infinity' }).status, 403);
  assert.equal(req('PROPFIND', `${HOME}nowhere/`).status, 404);
});

test('PUT creates then replaces, honours If-None-Match and If-Match, and GET returns the same text', () => {
  const { req, put } = setup();
  const text = ev('u1', '20260601T100000Z', '20260601T110000Z', ['SUMMARY:One']);
  const a = put('u1.ics', text);
  assert.equal(a.status, 201);
  assert.match(a.headers.etag!, /^"[0-9a-f]{16}"$/);
  const g = req('GET', `${CAL}u1.ics`);
  assert.deepEqual([g.status, g.body, g.headers.etag], [200, text, a.headers.etag]);
  assert.equal(req('HEAD', `${CAL}u1.ics`).body, '');
  assert.equal(req('PUT', `${CAL}u1.ics`, text, { 'content-type': 'text/calendar', 'if-none-match': '*' }).status, 412);
  assert.equal(req('PUT', `${CAL}u1.ics`, text, { 'content-type': 'text/calendar', 'if-match': '"stale"' }).status, 412);
  const text2 = ev('u1', '20260601T100000Z', '20260601T120000Z', ['SUMMARY:Two']);
  const b = req('PUT', `${CAL}u1.ics`, text2, { 'content-type': 'text/calendar', 'if-match': a.headers.etag! });
  assert.equal(b.status, 204);
  assert.notEqual(b.headers.etag, a.headers.etag);
  assert.equal(req('PUT', `${CAL}new.ics`, text, { 'content-type': 'text/calendar', 'if-match': '*' }).status, 412, 'If-Match on something that does not exist');
  assert.equal(req('PUT', `${CAL}x.ics`, text, { 'content-type': 'text/plain' }).status, 415);
});

const precondition = (r: Reply) => { const e = parseXml(r.body); return { status: r.status, name: e.children[0]!.name, href: child(e.children[0]!, 'DAV:', 'href')?.text }; };

test('writes are refused with the RFC 4791 precondition that failed', () => {
  const { put, dav } = setup({ maxResourceBytes: 600 });
  dav.create(`${HOME}events-only/`, { components: ['VEVENT'] });
  put('a.ics', ev('a', '20260601T100000Z', '20260601T110000Z'));
  assert.deepEqual(precondition(put('b.ics', ev('a', '20260602T100000Z', '20260602T110000Z'))), { status: 403, name: 'no-uid-conflict', href: `${CAL}a.ics` });
  assert.equal(precondition(put('c.ics', 'this is not a calendar')).name, 'supported-calendar-data');
  assert.equal(precondition(put('c.ics', ev('c', '20260601T100000Z', '20260601T110000Z').replace('VERSION:2.0', 'VERSION:1.0'))).name, 'supported-calendar-data');
  assert.equal(precondition(put('d.ics', ics('d', ['DTSTART:20260601T100000Z'], { method: 'REQUEST' }))).name, 'valid-calendar-object-resource');
  const mixed = ics('m', ['DTSTART:20260601T100000Z']).replace('END:VCALENDAR', 'BEGIN:VEVENT\r\nUID:other\r\nDTSTART:20260601T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR');
  assert.match(precondition(put('m.ics', mixed)).name, /valid-calendar-object-resource/);
  const noUid = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VEVENT\r\nDTSTART:20260601T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  assert.equal(precondition(put('n.ics', noUid)).name, 'valid-calendar-object-resource');
  assert.equal(precondition(put('big.ics', ev('big', '20260601T100000Z', '20260601T110000Z', [`DESCRIPTION:${'x'.repeat(700)}`]))).name, 'max-resource-size');
});

test('a todo is refused in an events-only calendar, and names that could escape or confuse are refused', () => {
  const { req, dav } = setup();
  dav.create(`${HOME}events-only/`, { components: ['VEVENT'] });
  const todo = ics('t', ['DUE:20260601T100000Z'], { kind: 'VTODO' });
  const r = req('PUT', `${HOME}events-only/t.ics`, todo, { 'content-type': 'text/calendar' });
  assert.equal(precondition(r).name, 'supported-calendar-component');
  for (const name of ['..%2f..%2fx.ics', 'a b.ics', 'noext', '.ics', 'x.ics.exe', `${'a'.repeat(250)}.ics`]) {
    const res = req('PUT', `${CAL}${name}`, ev('z', '20260601T100000Z', '20260601T110000Z'), { 'content-type': 'text/calendar' });
    assert.equal(res.status, 403, name);
  }
});

test('calendar-query time ranges find recurring events by their instances, not just their first date', () => {
  const { req, put } = setup();
  put('daily.ics', ev('daily', '20260601T100000Z', '20260601T110000Z', ['RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:Standup']));
  put('once.ics', ev('once', '20260610T090000Z', '20260610T100000Z', ['SUMMARY:Review']));
  const q = (a: string, b: string) => hrefs(req('REPORT', CAL, query(`<c:comp-filter name="VEVENT">${range(a, b)}</c:comp-filter>`)));
  assert.deepEqual(q('20260603T000000Z', '20260604T000000Z'), ['daily.ics'], 'the third day of a daily series');
  assert.deepEqual(q('20260606T000000Z', '20260609T000000Z'), [], 'after the last occurrence');
  assert.deepEqual(q('20260601T000000Z', '20260611T000000Z'), ['daily.ics', 'once.ics']);
  assert.deepEqual(q('20260610T095900Z', '20260610T100100Z'), ['once.ics'], 'an event under way overlaps');
  assert.deepEqual(q('20260610T100000Z', '20260610T110000Z'), [], 'ends exactly at the start of the range');
  assert.equal(req('REPORT', CAL, query(`<c:comp-filter name="VEVENT"><c:time-range start="2026-06-01" end="x"/></c:comp-filter>`)).status, 400);
  assert.equal(req('REPORT', CAL, query(`<c:comp-filter name="VEVENT">${range('20260602T000000Z', '20260601T000000Z')}</c:comp-filter>`)).status, 400);
});

test('prop-filter text matches use the right collation, can be negated, and is-not-defined works', () => {
  const { req, put } = setup();
  put('a.ics', ev('a', '20260601T100000Z', '20260601T110000Z', ['SUMMARY:Quarterly Planning', 'LOCATION:Room 4', 'CATEGORIES:work,planning']));
  put('b.ics', ev('b', '20260602T100000Z', '20260602T110000Z', ['SUMMARY:Lunch']));
  const q = (inner: string) => hrefs(req('REPORT', CAL, query(`<c:comp-filter name="VEVENT">${inner}</c:comp-filter>`)));
  assert.deepEqual(q('<c:prop-filter name="SUMMARY"><c:text-match>planning</c:text-match></c:prop-filter>'), ['a.ics'], 'case-insensitive by default');
  assert.deepEqual(q('<c:prop-filter name="SUMMARY"><c:text-match collation="i;octet">planning</c:text-match></c:prop-filter>'), []);
  assert.deepEqual(q('<c:prop-filter name="SUMMARY"><c:text-match collation="i;octet">Planning</c:text-match></c:prop-filter>'), ['a.ics']);
  assert.deepEqual(q('<c:prop-filter name="SUMMARY"><c:text-match negate-condition="yes">planning</c:text-match></c:prop-filter>'), ['b.ics']);
  assert.deepEqual(q('<c:prop-filter name="LOCATION"><c:is-not-defined/></c:prop-filter>'), ['b.ics']);
  assert.deepEqual(q('<c:prop-filter name="LOCATION"/>'), ['a.ics']);
  assert.deepEqual(q('<c:prop-filter name="CATEGORIES"><c:text-match>PLAN</c:text-match></c:prop-filter><c:prop-filter name="SUMMARY"><c:text-match>quarter</c:text-match></c:prop-filter>'), ['a.ics'], 'every filter must hold');
  const bad = req('REPORT', CAL, query('<c:comp-filter name="VEVENT"><c:prop-filter name="SUMMARY"><c:text-match collation="i;unicode-casemap">x</c:text-match></c:prop-filter></c:comp-filter>'));
  assert.deepEqual(precondition(bad), { status: 403, name: 'supported-collation', href: undefined });
  assert.equal(req('REPORT', CAL, `<c:calendar-query ${NS}><d:prop><d:getetag/></d:prop></c:calendar-query>`).status, 400);
  assert.equal(req('REPORT', CAL, `<c:calendar-query ${NS}><c:filter><c:comp-filter name="VEVENT"/></c:filter></c:calendar-query>`).status, 400);
});

test('param-filter and alarm time ranges', () => {
  const { req, put } = setup();
  put('a.ics', ev('a', '20260601T100000Z', '20260601T110000Z', ['ATTENDEE;PARTSTAT=ACCEPTED:mailto:bo@example.com', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:x', 'END:VALARM']));
  put('b.ics', ev('b', '20260601T100000Z', '20260601T110000Z', ['ATTENDEE;PARTSTAT=DECLINED:mailto:bo@example.com']));
  const q = (inner: string) => hrefs(req('REPORT', CAL, query(`<c:comp-filter name="VEVENT">${inner}</c:comp-filter>`)));
  assert.deepEqual(q('<c:prop-filter name="ATTENDEE"><c:param-filter name="PARTSTAT"><c:text-match>declined</c:text-match></c:param-filter></c:prop-filter>'), ['b.ics']);
  assert.deepEqual(q('<c:prop-filter name="ATTENDEE"><c:param-filter name="ROLE"><c:is-not-defined/></c:param-filter></c:prop-filter>'), ['a.ics', 'b.ics']);
  assert.deepEqual(q(`<c:comp-filter name="VALARM">${range('20260601T094000Z', '20260601T095000Z')}</c:comp-filter>`), ['a.ics'], 'the alarm fires at 09:45');
  assert.deepEqual(q(`<c:comp-filter name="VALARM">${range('20260601T100000Z', '20260601T110000Z')}</c:comp-filter>`), []);
  assert.deepEqual(q('<c:comp-filter name="VALARM"><c:is-not-defined/></c:comp-filter>'), ['b.ics']);
});

test('todos are matched by their due date', () => {
  const { req, put } = setup();
  put('t.ics', ics('t', ['DUE:20260605T170000Z', 'SUMMARY:File'], { kind: 'VTODO' }));
  const q = (a: string, b: string) => hrefs(req('REPORT', CAL, query(`<c:comp-filter name="VTODO">${range(a, b)}</c:comp-filter>`)));
  assert.deepEqual(q('20260605T000000Z', '20260606T000000Z'), ['t.ics']);
  assert.deepEqual(q('20260606T000000Z', '20260607T000000Z'), []);
});

test('calendar-multiget returns the data asked for and a 404 for a missing resource', () => {
  const { req, put } = setup();
  const text = ev('a', '20260601T100000Z', '20260601T110000Z', ['SUMMARY:Hello']);
  put('a.ics', text);
  const body = `<c:calendar-multiget ${NS}><d:prop><d:getetag/><c:calendar-data/></d:prop><d:href>${CAL}a.ics</d:href><d:href>${CAL}gone.ics</d:href><d:href>${CAL}../a.ics</d:href></c:calendar-multiget>`;
  const r = responses(req('REPORT', CAL, body));
  assert.equal(r.length, 3);
  const data = child(child(children(r[0]!.el, 'DAV:', 'propstat')[0]!, 'DAV:', 'prop')!, CALDAV, 'calendar-data')!.text;
  assert.equal(data, text);
  assert.deepEqual([r[1]!.status, r[2]!.status], ['HTTP/1.1 404 Not Found', 'HTTP/1.1 404 Not Found']);
});

test('calendar-data can expand a recurring event into single instances within a range', () => {
  const { req, put } = setup();
  put('w.ics', ev('w', '20260601T100000Z', '20260601T110000Z', ['RRULE:FREQ=WEEKLY;COUNT=6', 'SUMMARY:Weekly']));
  const body = `<c:calendar-multiget ${NS}><d:prop><c:calendar-data><c:expand start="20260608T000000Z" end="20260623T000000Z"/></c:calendar-data></d:prop><d:href>${CAL}w.ics</d:href></c:calendar-multiget>`;
  const text = child(child(children(responses(req('REPORT', CAL, body))[0]!.el, 'DAV:', 'propstat')[0]!, 'DAV:', 'prop')!, CALDAV, 'calendar-data')!.text;
  assert.deepEqual([...text.matchAll(/RECURRENCE-ID:(\S+)/g)].map((m) => m[1]), ['20260608T100000Z', '20260615T100000Z', '20260622T100000Z']);
  assert.deepEqual([...text.matchAll(/DTSTART:(\S+)/g)].map((m) => m[1]), ['20260608T100000Z', '20260615T100000Z', '20260622T100000Z']);
  assert.doesNotMatch(text, /RRULE/);
});

test('free-busy merges overlapping events, keeps tentative apart, and ignores transparent and cancelled ones', () => {
  const { req, put } = setup();
  put('1.ics', ev('1', '20260601T090000Z', '20260601T103000Z'));
  put('2.ics', ev('2', '20260601T100000Z', '20260601T113000Z'));
  put('3.ics', ev('3', '20260601T140000Z', '20260601T150000Z', ['STATUS:TENTATIVE']));
  put('4.ics', ev('4', '20260601T120000Z', '20260601T130000Z', ['TRANSP:TRANSPARENT']));
  put('5.ics', ev('5', '20260601T160000Z', '20260601T170000Z', ['STATUS:CANCELLED']));
  put('6.ics', ev('6', '20260601T073000Z', '20260601T093000Z'));
  put('7.ics', ev('7', '20260602T090000Z', '20260602T100000Z', ['RRULE:FREQ=DAILY;COUNT=2']));
  const r = req('REPORT', CAL, `<c:free-busy-query ${NS}>${range('20260601T080000Z', '20260601T180000Z')}</c:free-busy-query>`);
  assert.equal(r.status, 200);
  assert.match(r.body, /FREEBUSY;FBTYPE=BUSY:20260601T080000Z\/20260601T113000Z\r\n/, 'clipped to the range start and merged');
  assert.match(r.body, /FREEBUSY;FBTYPE=BUSY-TENTATIVE:20260601T140000Z\/20260601T150000Z\r\n/);
  assert.doesNotMatch(r.body, /T120000Z|T160000Z|20260602/);
  assert.match(r.body, /DTSTART:20260601T080000Z/);
  assert.equal(req('REPORT', CAL, `<c:free-busy-query ${NS}/>`).status, 400);
});

test('sync-collection lists everything first, then only what changed, with deletions as 404s', () => {
  const { req, put } = setup();
  put('a.ics', ev('a', '20260601T100000Z', '20260601T110000Z'));
  put('b.ics', ev('b', '20260602T100000Z', '20260602T110000Z'));
  const sync = (token: string) => req('REPORT', CAL, `<d:sync-collection ${NS}><d:sync-token>${token}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`);
  const first = sync('');
  assert.deepEqual(hrefs(first), ['a.ics', 'b.ics']);
  const token = child(parseXml(first.body), 'DAV:', 'sync-token')!.text;
  assert.equal(token, 'urn:caldav-sync:2');
  assert.deepEqual(hrefs(sync(token)), [], 'nothing changed');
  put('b.ics', ev('b', '20260602T100000Z', '20260602T120000Z'));
  put('c.ics', ev('c', '20260603T100000Z', '20260603T110000Z'));
  req('DELETE', `${CAL}a.ics`);
  const next = sync(token);
  assert.deepEqual(responses(next).map((r) => [r.href.replace(CAL, ''), r.status ?? 'present']), [['a.ics', 'HTTP/1.1 404 Not Found'], ['b.ics', 'present'], ['c.ics', 'present']]);
  assert.equal(child(parseXml(next.body), 'DAV:', 'sync-token')!.text, 'urn:caldav-sync:5');
  assert.deepEqual(precondition(sync('urn:caldav-sync:99')), { status: 403, name: 'valid-sync-token', href: undefined });
  assert.equal(precondition(sync('http://evil.example/token')).name, 'valid-sync-token');
  const lim = req('REPORT', CAL, `<d:sync-collection ${NS}><d:sync-token/><d:limit><d:nresults>1</d:nresults></d:limit><d:prop><d:getetag/></d:prop></d:sync-collection>`);
  assert.equal(lim.status, 507);
});

test('a sync token older than the change log is refused, and the ctag moves with every change', () => {
  const { req, put, dav } = setup({ logSize: 2 });
  const c = dav.collection(CAL);
  const t0 = dav.ctag(c);
  for (const n of ['a', 'b', 'c', 'd']) put(`${n}.ics`, ev(n, '20260601T100000Z', '20260601T110000Z'));
  assert.notEqual(dav.ctag(c), t0);
  const body = (t: string) => `<d:sync-collection ${NS}><d:sync-token>${t}</d:sync-token><d:prop><d:getetag/></d:prop></d:sync-collection>`;
  assert.equal(req('REPORT', CAL, body('urn:caldav-sync:1')).status, 403, 'position 1 has been forgotten');
  assert.equal(req('REPORT', CAL, body('urn:caldav-sync:2')).status, 207, 'position 2 is the oldest still known');
  assert.equal(req('REPORT', CAL, body('urn:caldav-sync:3')).status, 207);
});

const request = (uid: string, seq: number, extra: string[] = []) => ics(uid, ['DTSTART:20260701T100000Z', 'DTEND:20260701T110000Z', 'SUMMARY:Planning', `SEQUENCE:${seq}`, 'ORGANIZER:mailto:boss@example.com', 'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:ana@example.com', 'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bo@example.com', ...extra], { method: 'REQUEST' });

test('the scheduling inbox takes requests for its owner, refuses repeats and strangers, and applies them to the calendar', () => {
  const { dav, req } = setup();
  dav.create(INBOX, { kind: 'inbox', components: ['VEVENT'] });
  const post = (text: string, who = 'ana@example.com') => req('POST', INBOX, text, { 'x-schedule-recipient': who, 'content-type': 'text/calendar' });
  assert.equal(post(request('m1', 0)).status, 201);
  assert.equal(precondition(post(request('m1', 0))).name, 'valid-scheduling-message', 'delivered twice');
  assert.equal(precondition(post(request('m1', 0), 'cy@example.com')).name, 'valid-scheduling-message', 'cy is not an attendee');
  assert.equal(precondition(post(ics('p', ['DTSTART:20260701T100000Z'], { method: 'PUBLISH' }))).name, 'valid-scheduling-message');
  assert.equal(req('POST', INBOX, request('m2', 0)).status, 400, 'the recipient must be named');
  assert.equal(req('POST', CAL, request('m3', 0), { 'x-schedule-recipient': 'ana@example.com' }).status, 403, 'only an inbox takes messages');
  assert.equal(req('PUT', `${CAL}../x.ics`, 'x', { 'content-type': 'text/calendar' }).status, 404);
  assert.deepEqual(dav.processInbox(INBOX, CAL).map((d) => d.did), ['created']);
  assert.equal(dav.collection(CAL).resources.size, 1);
});

test('processing the inbox creates, updates, cancels and records replies, and ignores out-of-date requests', () => {
  const { dav } = setup();
  dav.create(INBOX, { kind: 'inbox', components: ['VEVENT'] });
  const run = (text: string, who: string) => { dav.deliver(INBOX, who, text); return dav.processInbox(INBOX, CAL).map((d) => d.did); };
  assert.deepEqual(run(request('m1', 1), 'ana@example.com'), ['created']);
  const stored = () => dav.get(`${CAL}m1.ics`).ics;
  assert.doesNotMatch(stored(), /METHOD/, 'a stored object has no METHOD');
  assert.match(stored(), /SUMMARY:Planning/);
  assert.deepEqual(run(request('m1', 2).replace('SUMMARY:Planning', 'SUMMARY:Planning (moved)'), 'ana@example.com'), ['updated']);
  assert.match(stored(), /SUMMARY:Planning \(moved\)/);
  assert.equal(dav.collection(INBOX).resources.size, 0, 'processed messages leave the inbox');
  const old = request('m1', 1).replace('SUMMARY:Planning', 'SUMMARY:Old');
  assert.throws(() => dav.deliver(INBOX, 'ana@example.com', old), /equal or newer/, 'an older sequence than one delivered is refused');
  assert.throws(() => dav.deliver(INBOX, 'ana@example.com', request('m1', 2)), /equal or newer/, 'the same sequence again is a repeat');
  const other = dav.create(`${HOME}inbox2/`, { kind: 'inbox', components: ['VEVENT'] });
  dav.deliver(other.path, 'ana@example.com', old);
  assert.deepEqual(dav.processInbox(other.path, CAL).map((d) => d.did), ['ignored: sequence 1 is not newer than 2'], 'a stale request that reaches another inbox is not applied');
  assert.match(stored(), /SUMMARY:Planning \(moved\)/);
  const cancel = ics('m1', ['DTSTART:20260701T100000Z', 'SEQUENCE:5', 'ORGANIZER:mailto:boss@example.com', 'ATTENDEE:mailto:ana@example.com'], { method: 'CANCEL' });
  assert.deepEqual(run(cancel, 'ana@example.com'), ['cancelled']);
  assert.match(stored(), /STATUS:CANCELLED/);
  assert.match(stored(), /SEQUENCE:5/);
});

test('a reply sets the attendee\'s answer on the organiser\'s copy, and only for a real attendee', () => {
  const { dav } = setup();
  dav.create(INBOX, { kind: 'inbox', components: ['VEVENT'] });
  dav.put(`${CAL}m9.ics`, request('m9', 0).replace('METHOD:REQUEST\r\n', ''));
  const reply = (who: string, st: string) => ics('m9', ['DTSTART:20260701T100000Z', 'SEQUENCE:0', 'ORGANIZER:mailto:boss@example.com', `ATTENDEE;PARTSTAT=${st}:mailto:${who}`], { method: 'REPLY' });
  dav.deliver(INBOX, 'boss@example.com', reply('bo@example.com', 'ACCEPTED'));
  assert.deepEqual(dav.processInbox(INBOX, CAL).map((d) => d.did), ['bo@example.com is now ACCEPTED']);
  const text = dav.get(`${CAL}m9.ics`).ics;
  assert.match(text, /ATTENDEE;PARTSTAT=ACCEPTED:mailto:bo@example\.com/);
  assert.match(text, /ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:ana@example\.com/, 'others are untouched');
  dav.deliver(INBOX, 'boss@example.com', reply('stranger@example.com', 'ACCEPTED'));
  assert.deepEqual(dav.processInbox(INBOX, CAL).map((d) => d.did), ['ignored: not an attendee']);
  assert.throws(() => dav.deliver(INBOX, 'ana@example.com', reply('bo@example.com', 'DECLINED')), /not addressed to ana/, 'a reply goes to the organiser only');
});

test('PROPPATCH changes only the name and description; DELETE needs a matching ETag when one is given', () => {
  const { req, put, dav } = setup();
  const patch = (inner: string) => req('PROPPATCH', CAL, `<d:propertyupdate ${NS}>${inner}</d:propertyupdate>`);
  assert.equal(patch('<d:set><d:prop><d:displayname>Renamed</d:displayname><c:calendar-description>Words</c:calendar-description></d:prop></d:set>').status, 207);
  assert.deepEqual([dav.collection(CAL).displayName, dav.collection(CAL).description], ['Renamed', 'Words']);
  assert.equal(patch('<d:remove><d:prop><c:calendar-description/></d:prop></d:remove>').status, 207);
  assert.equal(dav.collection(CAL).description, undefined);
  assert.equal(precondition(patch('<d:set><d:prop><d:getetag>x</d:getetag></d:prop></d:set>')).name, 'cannot-modify-protected-property');
  const a = put('a.ics', ev('a', '20260601T100000Z', '20260601T110000Z'));
  assert.equal(req('DELETE', `${CAL}a.ics`, '', { 'if-match': '"nope"' }).status, 412);
  assert.equal(req('DELETE', `${CAL}a.ics`, '', { 'if-match': a.headers.etag! }).status, 204);
  assert.equal(req('DELETE', `${CAL}a.ics`).status, 404);
});

test('hostile XML and unknown methods and reports get clean refusals', () => {
  const { req } = setup();
  assert.equal(req('REPORT', CAL, '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><c:calendar-query xmlns:c="urn:ietf:params:xml:ns:caldav"/>').status, 400);
  assert.equal(req('REPORT', CAL, `<c:principal-match ${NS}/>`).status, 403);
  assert.equal(req('REPORT', CAL, 'not xml').status, 400);
  assert.equal(req('BREW', CAL).status, 405);
  assert.equal(req('GET', `${CAL}missing.ics`).status, 404);
  assert.equal(req('GET', '/etc/passwd').status, 404);
});
