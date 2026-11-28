import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { isBot, parseLanding, SaltBook, sourceOf, UnknownSite, WebAnalytics, type Hit, type Options } from './index.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-03-10T10:00:00Z');
const DAY = 86_400_000;
const seeded = () => {
  let n = 0;
  return (len: number) => createHash('sha256').update(`seed-${n++}`).digest().subarray(0, len > 32 ? 32 : len);
};
const site = { id: 's1', domains: ['example.com'] };
const make = (extra: Partial<Options> = {}) => new WebAnalytics({ sites: [site], salts: new SaltBook(seeded()), events: ['signup', 'purchase'], ...extra });
const hit = (o: Partial<Hit> = {}): Hit => ({ site: 's1', url: 'https://example.com/', userAgent: 'Mozilla/5.0 (X11; Linux) Firefox/130', ip: '203.0.113.7', at: T0, ...o });

test('the same visitor and day give the same id; another day, site, address or browser do not', () => {
  const a = make();
  const id = a.visitorId('s1', '203.0.113.7', 'UA', T0);
  assert.equal(id.length, 22);
  assert.equal(a.visitorId('s1', '203.0.113.7', 'UA', T0 + 5 * MIN), id);
  assert.notEqual(a.visitorId('s1', '203.0.113.7', 'UA', T0 + DAY), id, 'a new day, a new salt');
  assert.notEqual(a.visitorId('s2', '203.0.113.7', 'UA', T0), id);
  assert.notEqual(a.visitorId('s1', '203.0.113.8', 'UA', T0), id);
  assert.notEqual(a.visitorId('s1', '203.0.113.7', 'UA2', T0), id);
});

test('salts older than yesterday are forgotten, so old ids cannot be recomputed', () => {
  const salts = new SaltBook(seeded());
  salts.forDay('2026-03-10');
  salts.forDay('2026-03-11');
  assert.deepEqual(salts.held(), ['2026-03-10', '2026-03-11']);
  salts.forDay('2026-03-12');
  assert.deepEqual(salts.held(), ['2026-03-11', '2026-03-12']);
  assert.deepEqual(salts.forDay('2026-03-11'), salts.forDay('2026-03-11'), 'the same day keeps its salt');
});

test('the network address and browser string are never kept', () => {
  const a = make();
  a.ingest(hit({ ip: '198.51.100.99', userAgent: 'Mozilla/5.0 UniqueBrowserString/9' }));
  const dump = JSON.stringify([a.sessions, a.records]);
  assert.ok(!dump.includes('198.51.100.99'));
  assert.ok(!dump.includes('UniqueBrowserString'));
});

test('hits within the gap join one session; a longer silence starts another', () => {
  const a = make();
  const r1 = a.ingest(hit());
  const r2 = a.ingest(hit({ url: 'https://example.com/about', at: T0 + 10 * MIN }));
  const r3 = a.ingest(hit({ url: 'https://example.com/pricing', at: T0 + 39 * MIN }));
  const r4 = a.ingest(hit({ url: 'https://example.com/', at: T0 + 80 * MIN }));
  assert.ok(r1.accepted && r2.accepted && r3.accepted && r4.accepted);
  assert.equal(r1.session, r2.session);
  assert.equal(r2.session, r3.session, '29 minutes after the last hit is still the same session');
  assert.notEqual(r3.session, r4.session);
  assert.deepEqual([r1.newSession, r2.newSession, r4.newSession], [true, false, true]);
  assert.equal(a.sessions[0]!.entry, '/');
  assert.equal(a.sessions[0]!.exit, '/pricing');
  assert.equal(a.sessions[0]!.pageviews, 3);
});

test('sessions do not cross midnight, because the visitor id changes', () => {
  const a = make();
  a.ingest(hit({ at: Date.parse('2026-03-10T23:50:00Z') }));
  a.ingest(hit({ at: Date.parse('2026-03-11T00:05:00Z') }));
  assert.equal(a.sessions.length, 2);
  assert.notEqual(a.sessions[0]!.visitor, a.sessions[1]!.visitor);
});

test('bounce means one pageview and no event; duration is first hit to last', () => {
  const a = make();
  a.ingest(hit({ ip: '10.0.0.1' }));
  a.ingest(hit({ ip: '10.0.0.2' }));
  a.ingest(hit({ ip: '10.0.0.2', url: 'https://example.com/b', at: T0 + 2 * MIN }));
  a.ingest(hit({ ip: '10.0.0.3' }));
  a.ingest(hit({ ip: '10.0.0.3', name: 'signup', at: T0 + 30_000 }));
  const s = a.stats('s1', T0 - DAY, T0 + DAY);
  assert.deepEqual([s.visits, s.visitors, s.pageviews, s.events], [3, 3, 4, 1]);
  assert.equal(s.bounceRate, 33.3, 'only the first visit bounced');
  assert.equal(s.avgVisitSeconds, 50, '0, 120 and 30 seconds');
});

test('campaign fields and referrers are read once, at the start of the visit', () => {
  const a = make();
  a.ingest(hit({ url: 'https://example.com/landing?utm_source=Newsletter&utm_medium=email&utm_campaign=Spring&secret=1#frag', referrer: 'https://www.google.com/search?q=x' }));
  a.ingest(hit({ url: 'https://example.com/next', at: T0 + MIN, referrer: 'https://other.org/' }));
  const s = a.sessions[0]!;
  assert.deepEqual(s.utm, { source: 'newsletter', medium: 'email', campaign: 'spring' });
  assert.equal(s.source, 'newsletter', 'a utm_source wins over the referrer');
  assert.equal(s.entry, '/landing');
  assert.ok(!JSON.stringify(a.records).includes('secret'), 'other query parameters are dropped');
  const st = a.stats('s1', T0 - DAY, T0 + DAY);
  assert.deepEqual(st.campaigns, [{ key: 'spring', visitors: 1, visits: 1 }]);
});

test('referrers become source names, and the site itself is not a source', () => {
  const own = ['example.com'];
  assert.equal(sourceOf('https://www.google.co.uk/', own), 'Google');
  assert.equal(sourceOf('https://t.co/abc', own), 'Twitter');
  assert.equal(sourceOf('https://news.ycombinator.com/item?id=1', own), 'Hacker News');
  assert.equal(sourceOf('https://blog.somewhere.net/post', own), 'blog.somewhere.net');
  assert.equal(sourceOf('https://www.example.com/other', own), undefined);
  assert.equal(sourceOf('android-app://com.x', own), undefined);
  assert.equal(sourceOf('not a url', own), undefined);
  assert.equal(sourceOf(undefined, own), undefined);
});

test('addresses are reduced to a path; junk and other schemes are refused', () => {
  assert.equal(parseLanding('https://example.com//a//b/?x=1#y')!.path, '/a/b');
  assert.equal(parseLanding('https://example.com')!.path, '/');
  assert.equal(parseLanding('javascript:alert(1)'), undefined);
  assert.equal(parseLanding('nonsense'), undefined);
  assert.equal(parseLanding(`https://example.com/${'a'.repeat(2000)}`), undefined);
  const a = make();
  assert.deepEqual(a.ingest(hit({ url: 'ftp://example.com/x' })), { accepted: false, reason: 'bad address' });
  assert.deepEqual(a.ingest(hit({ url: 'https://evil.test/x' })), { accepted: false, reason: 'host not on this site' });
  assert.deepEqual(a.refused, { 'bad address': 1, 'host not on this site': 1 });
});

test('bots, ignored addresses and privacy signals are not counted', () => {
  const a = make({ ignoreIps: ['192.0.2.1'] });
  assert.ok(isBot('Googlebot/2.1 (+http://www.google.com/bot.html)'));
  assert.ok(isBot(''));
  assert.ok(isBot('curl/8.4.0'));
  assert.ok(!isBot('Mozilla/5.0 (Macintosh) Safari/605.1.15'));
  assert.deepEqual(a.ingest(hit({ userAgent: 'Googlebot/2.1' })), { accepted: false, reason: 'bot' });
  assert.deepEqual(a.ingest(hit({ ip: '192.0.2.1' })), { accepted: false, reason: 'ignored address' });
  assert.deepEqual(a.ingest(hit({ signals: { gpc: '1' } })), { accepted: false, reason: 'privacy signal' });
  assert.deepEqual(a.ingest(hit({ signals: { dnt: '1' } })), { accepted: false, reason: 'privacy signal' });
  assert.equal(a.sessions.length, 0);
  assert.equal(make({ respectSignals: false }).ingest(hit({ signals: { gpc: '1' } })).accepted, true);
});

test('a persistent id is honoured only with consent, and then ties days together', () => {
  const a = make();
  const d1 = a.ingest(hit({ persistentId: 'abc', at: T0 }));
  const d2 = a.ingest(hit({ persistentId: 'abc', at: T0 + DAY, ip: '198.51.100.5' }));
  assert.ok(d1.accepted && d2.accepted);
  assert.notEqual(d1.visitor, d2.visitor, 'without consent the id is ignored and the daily hash is used');
  const c1 = a.ingest(hit({ persistentId: 'abc', consented: true, at: T0 + 2 * DAY }));
  const c2 = a.ingest(hit({ persistentId: 'abc', consented: true, at: T0 + 3 * DAY, ip: '198.51.100.5' }));
  assert.ok(c1.accepted && c2.accepted);
  assert.equal(c1.visitor, c2.visitor);
  assert.ok(c1.visitor.startsWith('p:'));
  assert.ok(!JSON.stringify(a.records).includes('abc'), 'the client id itself is not stored');
});

test('events must be declared; properties are cleaned and capped', () => {
  const a = make();
  assert.deepEqual(a.ingest(hit({ name: 'made-up' })), { accepted: false, reason: 'undeclared event' });
  const props: Record<string, unknown> = { plan: 'pro\u0000\n', amount: 49, ok: true, nested: { a: 1 }, 'bad key!': 'x', long: 'y'.repeat(500), nan: Number.NaN };
  for (let i = 0; i < 20; i++) props[`k${i}`] = i;
  a.ingest(hit({ name: 'purchase', props }));
  const r = a.records[0]!;
  assert.equal(r.props.plan, 'pro');
  assert.equal(r.props.amount, 49);
  assert.equal(r.props.ok, true);
  assert.equal((r.props.long as string).length, 200);
  assert.ok(!('nested' in r.props) && !('bad key!' in r.props) && !('nan' in r.props));
  assert.equal(Object.keys(r.props).length, 10);
});

test('goals count pages by pattern and events by name and property, with the conversion rate', () => {
  const a = make({
    goals: [
      { id: 'read-blog', match: { kind: 'pageview', path: '/blog/*' } },
      { id: 'pro-signup', match: { kind: 'event', name: 'signup', props: { plan: 'pro' } } },
      { id: 'any-signup', match: { kind: 'event', name: 'signup' } },
    ],
  });
  a.ingest(hit({ ip: '10.0.0.1', url: 'https://example.com/blog/one' }));
  a.ingest(hit({ ip: '10.0.0.1', url: 'https://example.com/blog/two', at: T0 + MIN }));
  a.ingest(hit({ ip: '10.0.0.2', url: 'https://example.com/blogger' }));
  a.ingest(hit({ ip: '10.0.0.2', name: 'signup', props: { plan: 'free' }, at: T0 + MIN }));
  a.ingest(hit({ ip: '10.0.0.3', name: 'signup', props: { plan: 'pro' } }));
  a.ingest(hit({ ip: '10.0.0.4' }));
  const g = Object.fromEntries(a.stats('s1', T0 - DAY, T0 + DAY).goals.map((x) => [x.goal, x]));
  assert.deepEqual(g['read-blog'], { goal: 'read-blog', conversions: 2, converted: 1, rate: 25 });
  assert.deepEqual(g['pro-signup'], { goal: 'pro-signup', conversions: 1, converted: 1, rate: 25 });
  assert.deepEqual(g['any-signup'], { goal: 'any-signup', conversions: 2, converted: 2, rate: 50 });
});

test('reports rank pages, entry pages and sources, and split by day', () => {
  const a = make();
  for (let i = 0; i < 3; i++) a.ingest(hit({ ip: `10.1.0.${i}`, url: 'https://example.com/a', referrer: 'https://www.google.com/' }));
  a.ingest(hit({ ip: '10.1.0.0', url: 'https://example.com/b', at: T0 + MIN }));
  a.ingest(hit({ ip: '10.1.0.9', url: 'https://example.com/b', referrer: 'https://news.ycombinator.com/' }));
  a.ingest(hit({ ip: '10.1.0.1', url: 'https://example.com/a', at: T0 + DAY }));
  const s = a.stats('s1', T0 - DAY, T0 + 2 * DAY);
  assert.deepEqual(s.pages, [{ key: '/a', visitors: 4, pageviews: 4 }, { key: '/b', visitors: 2, pageviews: 2 }]);
  assert.deepEqual(s.sources, [{ key: 'Google', visitors: 3, visits: 3 }, { key: 'Hacker News', visitors: 1, visits: 1 }]);
  assert.deepEqual(s.byDay, [{ day: '2026-03-10', visitors: 4, pageviews: 5 }, { day: '2026-03-11', visitors: 1, pageviews: 1 }]);
  assert.equal(s.visitors, 5, 'ids rotate, so a range sums each day');
  const none = a.stats('s1', T0 + 10 * DAY, T0 + 11 * DAY);
  assert.deepEqual([none.visits, none.bounceRate, none.avgVisitSeconds], [0, 0, 0]);
});

test('an unknown site is an error, never a silent drop', () => {
  const a = make();
  assert.throws(() => a.ingest(hit({ site: 'nope' })), UnknownSite);
  assert.throws(() => a.stats('nope', 0, 1), UnknownSite);
  assert.deepEqual(a.ingest(hit({ at: Number.NaN })), { accepted: false, reason: 'bad time' });
});
