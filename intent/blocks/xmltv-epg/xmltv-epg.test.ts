import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Guide, XmltvError, episodeKey, episodeOf, fold, formatXmltvTime, globMatch, localParts, mapChannels, normaliseChannelName, parseXmltv, parseXmltvTime, pick, plan, ruleMatches, toXmltv } from './index.ts';
import type { Programme, RecordingRule } from './index.ts';

const H = 3_600_000;
const T0 = Date.UTC(2026, 0, 15, 20, 0, 0);

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="test-grabber" source-info-name="Example &amp; Co">
<channel id="bbc1.uk"><display-name lang="en">BBC One HD</display-name><display-name>101</display-name><icon src="http://x.test/bbc1.png"/><url>http://bbc.test</url></channel>
<channel id="itv.uk"><display-name>ITV</display-name></channel>
<programme start="20260115200000 +0000" stop="20260115210000 +0000" channel="bbc1.uk">
 <title lang="en">News &amp; Weather</title><title lang="fr">Infos</title><sub-title>Evening edition</sub-title><desc lang="en">Today's headlines &nbsp;and more</desc>
 <credits><presenter>Ann Anchor</presenter><actor role="Self">Bob Guest</actor></credits><date>2026</date><category lang="en">News</category><length units="minutes">60</length>
 <episode-num system="xmltv_ns">2.4.0/2</episode-num><episode-num system="onscreen">S03E05</episode-num><episode-num system="dd_progid">EP012345670042</episode-num>
 <video><aspect>16:9</aspect><quality>HDTV</quality></video><audio><stereo>stereo</stereo></audio><new/><subtitles type="teletext"/><rating system="BBFC"><value>PG</value></rating><star-rating><value>4/5</value></star-rating>
</programme>
<programme start="20260115210000 +0000" channel="bbc1.uk"><title>Drama</title></programme>
<programme start="20260115220000 +0100" stop="20260115230000 +0100" channel="itv.uk"><title>Late Show</title><previously-shown/></programme>
<programme start="20260230100000" channel="itv.uk"><title>Impossible date</title></programme>
<programme start="20260115100000" channel="itv.uk"><desc>No title</desc></programme>
<programme start="20260115110000" stop="20260115100000" channel="itv.uk"><title>Stop before start</title></programme>
<programme start="20260115120000" channel="ghost.uk"><title>Orphan</title></programme>
</tv>`;

test('XMLTV times: forms, zones, calendar checks, round trip', () => {
  assert.equal(parseXmltvTime('20260115203000 +0100'), Date.UTC(2026, 0, 15, 19, 30, 0));
  assert.equal(parseXmltvTime('20260115203000'), Date.UTC(2026, 0, 15, 20, 30, 0));
  assert.equal(parseXmltvTime('202601152030 -0530'), Date.UTC(2026, 0, 16, 2, 0, 0));
  assert.equal(parseXmltvTime('20260115'), Date.UTC(2026, 0, 15));
  assert.equal(parseXmltvTime('2026'), Date.UTC(2026, 0, 1));
  assert.equal(parseXmltvTime('20260115203000 Z'), Date.UTC(2026, 0, 15, 20, 30, 0));
  assert.equal(parseXmltvTime('20260230000000'), undefined);
  assert.equal(parseXmltvTime('20260115250000'), undefined);
  assert.equal(parseXmltvTime('2026-01-15'), undefined);
  assert.equal(parseXmltvTime('20260115203000 +9900'), undefined);
  assert.equal(formatXmltvTime(T0), '20260115200000 +0000');
  assert.equal(formatXmltvTime(T0, 90), '20260115213000 +0130');
  assert.equal(formatXmltvTime(T0, -300), '20260115150000 -0500');
  assert.equal(parseXmltvTime(formatXmltvTime(T0, -300)), T0);
});

test('reading a guide: channels, programme fields, credits, flags, entities', () => {
  const x = parseXmltv(XML);
  assert.equal(x.generator, 'test-grabber');
  assert.equal(x.source, 'Example & Co');
  assert.deepEqual(x.channels.map((c) => c.id), ['bbc1.uk', 'itv.uk']);
  assert.deepEqual(x.channels[0]!.names, [{ lang: 'en', text: 'BBC One HD' }, { text: '101' }]);
  assert.deepEqual(x.channels[0]!.icons, ['http://x.test/bbc1.png']);
  const p = x.programmes[0]!;
  assert.equal(pick(p.title, ['fr']), 'Infos');
  assert.equal(pick(p.title, ['de']), 'News & Weather');
  assert.equal(pick(p.title), 'News & Weather');
  assert.match(p.desc[0]!.text, /Today's headlines &nbsp;and more/);
  assert.deepEqual(p.credits, { presenter: [{ name: 'Ann Anchor' }], actor: [{ name: 'Bob Guest', role: 'Self' }] });
  assert.equal(p.lengthMs, 3_600_000);
  assert.deepEqual([p.aspect, p.quality, p.stereo, p.isNew, p.previouslyShown], ['16:9', 'HDTV', 'stereo', true, false]);
  assert.deepEqual(p.ratings, [{ system: 'BBFC', value: 'PG' }]);
  assert.deepEqual(p.stars, [{ value: '4/5' }]);
  assert.equal(p.stop, T0 + H);
  assert.equal(x.programmes[1]!.stop, undefined);
  assert.equal(x.programmes[2]!.previouslyShown, true);
});

test('bad programmes are skipped and counted; the rest loads', () => {
  const x = parseXmltv(XML);
  assert.deepEqual(x.programmes.map((p) => pick(p.title)), ['News & Weather', 'Drama', 'Late Show', 'Stop before start', 'Orphan']);
  assert.equal(x.programmes[3]!.stop, undefined);
  assert.ok(x.skipped >= 4);
  assert.ok(x.problems.some((p) => /not declared/.test(p)));
  assert.ok(x.problems.some((p) => /no title/.test(p)));
  assert.ok(x.problems.some((p) => /no usable channel or start/.test(p)));
});

test('hostile or broken XML is refused; stray ampersands do not break a file', () => {
  assert.throws(() => parseXmltv('<!DOCTYPE tv [<!ENTITY x SYSTEM "file:///etc/passwd">]><tv/>'), XmltvError);
  assert.throws(() => parseXmltv('<rss/>'), /start with <tv>/);
  assert.throws(() => parseXmltv('<tv><programme'), XmltvError);
  assert.throws(() => parseXmltv(XML, { maxBytes: 100 }), XmltvError);
  assert.throws(() => parseXmltv(XML, { maxProgrammes: 2 }), /more than 2 programmes/);
  const x = parseXmltv('<tv><channel id="a"><display-name>AT&T & Co &eacute;</display-name></channel></tv>');
  assert.equal(x.channels[0]!.names[0]!.text, 'AT&T & Co &eacute;');
});

test('write then read back keeps everything', () => {
  const a = parseXmltv(XML);
  const b = parseXmltv(toXmltv(a, { generator: 'me', offsetMinutes: 60 }));
  assert.deepEqual(b.channels, a.channels);
  assert.deepEqual(b.programmes, a.programmes);
  assert.equal(b.generator, 'me');
  assert.throws(() => toXmltv({ channels: [], programmes: [{ ...a.programmes[0]!, credits: { 'bad kind': [{ name: 'x' }] } }] }), XmltvError);
});

test('episode numbers: xmltv_ns, on-screen, ids, and keys', () => {
  const p = parseXmltv(XML).programmes[0]!;
  assert.deepEqual(episodeOf(p), { season: 3, episode: 5, part: 1, parts: 2, ids: { dd_progid: 'EP012345670042' } });
  const e = episodeOf({ episodeNums: [{ system: 'xmltv_ns', value: '0.4.0/2' }] });
  assert.deepEqual([e.season, e.episode, e.part, e.parts], [1, 5, 1, 2]);
  assert.deepEqual(episodeOf({ episodeNums: [{ system: 'xmltv_ns', value: '.12.' }] }), { episode: 13, ids: {} });
  assert.deepEqual(episodeOf({ episodeNums: [{ system: 'onscreen', value: '2x07' }] }), { season: 2, episode: 7, ids: {} });
  assert.deepEqual(episodeOf({ episodeNums: [{ system: 'onscreen', value: 'Ep 9' }] }), { episode: 9, ids: {} });
  assert.deepEqual(episodeOf({ episodeNums: [{ system: 'thetvdb.com', value: 'series/1' }] }).ids, { 'thetvdb.com': 'series/1' });
  assert.deepEqual(episodeOf({ episodeNums: [{ system: 'xmltv_ns', value: 'garbage' }] }), { ids: {} });
  const a = { ...p, channel: 'a', start: 1 };
  const b = { ...p, channel: 'b', start: 99 };
  assert.equal(episodeKey(a), episodeKey(b));
  const show = (extra: Partial<Programme>): Programme => ({ ...p, episodeNums: [], subTitle: [], ...extra });
  assert.equal(episodeKey(show({ subTitle: [{ text: 'The Pilot!' }] })), episodeKey(show({ subTitle: [{ text: 'the pilot' }], start: 5 })));
  assert.notEqual(episodeKey(show({ start: 1 })), episodeKey(show({ start: 2 })));
});

test('channel names: quality words, +1 shifts, folding', () => {
  assert.deepEqual(normaliseChannelName('BBC One HD'), { key: 'bbc one hd', loose: 'bbc one', shiftHours: 0 });
  assert.deepEqual(normaliseChannelName('Channel 4 +1'), { key: 'channel 4', loose: '4', shiftHours: 1 });
  assert.equal(normaliseChannelName('Télé-Québec').key, 'tele quebec');
  assert.equal(fold('Fish & Chips'), 'fish and chips');
});

test('channel map: by id, name, loose name, number, +1 shift, ambiguity and clashes', () => {
  const local = [{ id: 'L1', name: 'BBC One', number: '1' }, { id: 'L2', name: 'ITV' }, { id: 'L3', name: 'Dave', number: '19' }, { id: 'L4', name: 'Film4' }, { id: 'L5', name: 'Film 4' }, { id: 'ITV3', name: 'ITV3' }, { id: 'L6', name: 'Film4' }];
  const ch = (id: string, ...names: string[]) => ({ id, names: names.map((text) => ({ text })), icons: [], urls: [] });
  const m = mapChannels([ch('bbc1.uk', 'BBC One HD'), ch('itv.uk', 'ITV +1'), ch('x1', 'Whatever', '19'), ch('x2', 'Film4'), ch('ITV3', 'foo'), ch('x3', 'Nothing')], local);
  const by = Object.fromEntries(m.map((x) => [x.xmltv, x]));
  assert.deepEqual([by['bbc1.uk']!.local, by['bbc1.uk']!.how], ['L1', 'name-loose']);
  assert.deepEqual([by['itv.uk']!.local, by['itv.uk']!.shiftMs, by['itv.uk']!.how], ['L2', H, 'name']);
  assert.deepEqual([by.x1!.local, by.x1!.how], ['L3', 'number']);
  assert.deepEqual([by.x2!.local, by.x2!.ambiguous.length], [undefined, 2]);
  assert.deepEqual([by.ITV3!.local, by.ITV3!.how, by.ITV3!.confidence], ['ITV3', 'id', 1]);
  assert.equal(by.x3!.how, 'none');
  const clash = mapChannels([ch('a', 'Dave'), ch('b', 'Dave HD')], local);
  assert.deepEqual(clash.map((x) => x.local), ['L3', undefined]);
  assert.deepEqual(clash[1]!.ambiguous, ['L3']);
  assert.equal(mapChannels([ch('a', 'zzz')], local, { a: 'L2' })[0]!.local, 'L2');
  assert.equal(mapChannels([ch('a', 'zzz')], local, { a: 'nope' })[0]!.how, 'none');
});

const prog = (channel: string, startH: number, title: string, o: Partial<Programme> = {}): Programme => ({
  channel, start: T0 + startH * H, stop: T0 + (startH + 1) * H, title: [{ text: title }], subTitle: [], desc: [], credits: {}, categories: [], keywords: [], icons: [], urls: [], episodeNums: [], previouslyShown: false, premiere: false, lastChance: false, isNew: false, subtitles: [], ratings: [], stars: [], ...o,
});

test('guide: sorting, missing stops, overlaps clipped, now/next, between, gaps', () => {
  const g = new Guide({ defaultLengthMs: H });
  const noStop = (c: string, h: number, t: string) => { const { stop, ...rest } = prog(c, h, t); void stop; return rest as Programme; };
  g.add([prog('a', 2, 'Three'), noStop('a', 0, 'One'), prog('a', 1, 'Two', { stop: T0 + 5 * H })]);
  const all = g.between('a', T0 - H, T0 + 10 * H);
  assert.deepEqual(all.map((x) => x.title[0]!.text), ['One', 'Two', 'Three']);
  assert.deepEqual(all.map((x) => (x.end - T0) / H), [1, 2, 3]);
  assert.equal(g.now('a', T0 + 1.5 * H).current!.title[0]!.text, 'Two');
  assert.equal(g.now('a', T0 + 1.5 * H).next!.title[0]!.text, 'Three');
  assert.equal(g.now('a', T0 + 9 * H).current, undefined);
  assert.equal(g.now('nope', T0).current, undefined);
  assert.deepEqual(g.between('a', T0 + 1.5 * H, T0 + 1.6 * H).map((x) => x.title[0]!.text), ['Two']);
  g.add([prog('a', 6, 'Six')]);
  assert.deepEqual(g.gaps('a', T0, T0 + 8 * H), [{ from: T0 + 3 * H, to: T0 + 6 * H }, { from: T0 + 7 * H, to: T0 + 8 * H }]);
});

test('guide: sources by priority, shifts and renames, search', () => {
  const g = new Guide();
  g.add([prog('a', 0, 'Old title')], 1);
  g.add([prog('a', 0, 'Better title')], 5);
  g.add([prog('a', 0, 'Ignored')], 2);
  assert.equal(g.between('a', T0, T0 + 1)[0]!.title[0]!.text, 'Better title');
  g.add([prog('plus1', 0, 'Show')], 0, { shiftMs: () => H, rename: (c) => (c === 'plus1' ? 'a' : c) });
  assert.deepEqual(g.between('a', T0 + 1.5 * H, T0 + 1.6 * H).map((x) => x.title[0]!.text), ['Show']);
  g.add([prog('b', 3, 'Quiet Night', { desc: [{ text: 'A café opens late' }] })]);
  assert.deepEqual(g.search('CAFE open').map((x) => x.channel), ['b']);
  assert.deepEqual(g.search('show', { from: T0 + 5 * H }), []);
  assert.deepEqual(g.search('  '), []);
  assert.deepEqual(g.channels(), ['a', 'b']);
});

test('globs: * and ?, no regex, no blow-up', () => {
  assert.ok(globMatch('news*', 'News at Ten'));
  assert.ok(globMatch('*at ten', 'News at Ten'));
  assert.ok(globMatch('n?ws*ten', 'News at Ten'));
  assert.ok(!globMatch('news', 'News at Ten'));
  assert.ok(globMatch('*', ''));
  assert.ok(!globMatch('*a*a*a*a*a*a*a*a*b', 'a'.repeat(5000)));
  assert.ok(globMatch('(a+)+$', '(a+)+$'));
});

test('rule matching: title forms, channels, categories, people, words, length, new only', () => {
  const p = prog('bbc', 0, 'Great British Bake Off', { categories: [{ text: 'Reality' }], credits: { presenter: [{ name: 'Noel Fielding' }] }, desc: [{ text: 'Baking in a tent' }] });
  const m = (r: Omit<RecordingRule, 'id'>, q: Programme = p) => ruleMatches({ id: 'r', ...r }, q);
  assert.ok(m({ title: { is: 'great british bake off' } }));
  assert.ok(!m({ title: { is: 'bake off' } }));
  assert.ok(m({ title: { contains: 'bake' } }));
  assert.ok(m({ title: { startsWith: 'GREAT' } }));
  assert.ok(m({ title: { glob: '*bake*' } }));
  assert.ok(m({ channels: ['bbc'] }) && !m({ channels: ['itv'] }));
  assert.ok(m({ categories: ['reality', 'news'] }) && !m({ categories: ['news'] }));
  assert.ok(m({ people: ['noel fielding'] }) && !m({ people: ['nobody'] }));
  assert.ok(m({ words: ['tent', 'baking'] }) && !m({ words: ['tent', 'cricket'] }));
  assert.ok(m({ minMinutes: 60 }) && !m({ minMinutes: 61 }) && m({ maxMinutes: 60 }) && !m({ maxMinutes: 59 }));
  assert.ok(m({ newOnly: true }) && !m({ newOnly: true }, { ...p, previouslyShown: true }) && m({ newOnly: true }, { ...p, previouslyShown: true, isNew: true }));
  assert.ok(!m({ enabled: false }));
  assert.ok(m({}));
});

test('rule windows use the time zone: days, hours, wrapping past midnight', () => {
  assert.deepEqual(localParts(Date.UTC(2026, 0, 15, 3, 30), 'America/New_York'), { day: 3, minutes: 22 * 60 + 30 });
  assert.deepEqual(localParts(Date.UTC(2026, 6, 15, 12, 0), 'Europe/London'), { day: 3, minutes: 13 * 60 });
  assert.throws(() => localParts(0, 'Mars/Base'), XmltvError);
  const at = (h: number, m = 0) => prog('c', 0, 'x', { start: Date.UTC(2026, 0, 15, h, m), stop: Date.UTC(2026, 0, 15, h + 1, m) });
  const r = (window: NonNullable<RecordingRule['window']>) => (q: Programme) => ruleMatches({ id: 'r', window }, q);
  const evening = r({ timeZone: 'UTC', from: '19:00', to: '22:00' });
  assert.ok(evening(at(19)) && evening(at(21, 59)) && !evening(at(22)) && !evening(at(18, 59)));
  const night = r({ timeZone: 'UTC', from: '22:00', to: '04:00' });
  assert.ok(night(at(23)) && night(at(2)) && !night(at(12)));
  assert.ok(r({ timeZone: 'UTC', days: [4] })(at(12)) && !r({ timeZone: 'UTC', days: [0, 1] })(at(12)));
  assert.ok(r({ timeZone: 'America/New_York', from: '14:00', to: '15:00' })(at(19, 30)));
  assert.throws(() => r({ timeZone: 'UTC', from: '7pm' })(at(12)), XmltvError);
});

const built = () => {
  const g = new Guide();
  const ep = (n: number) => [{ system: 'onscreen', value: `S01E0${n}` }];
  g.add([
    prog('a', 0, 'Show', { episodeNums: ep(1) }), prog('b', 5, 'Show', { episodeNums: ep(1), previouslyShown: true }),
    prog('a', 1, 'Show', { episodeNums: ep(2) }), prog('a', 2, 'Other'), prog('b', 1, 'Rival'), prog('c', 1, 'Rival too'),
  ]);
  return g;
};

test('plan: one airing per episode, repeats skipped, padding, past and partial', () => {
  const rules: RecordingRule[] = [{ id: 'show', title: { is: 'Show' }, padBeforeMs: 60_000, padAfterMs: 120_000 }];
  const p = plan(rules, built(), { now: T0 - H, tuners: 2 });
  assert.deepEqual(p.scheduled.map((r) => [r.programme.channel, (r.programme.start - T0) / H]), [['a', 0], ['a', 1]]);
  assert.equal(p.scheduled[0]!.start, T0 - 60_000);
  assert.equal(p.scheduled[0]!.end, T0 + H + 120_000);
  assert.deepEqual(p.skipped.map((s) => s.reason), ['another-airing']);
  const late = plan(rules, built(), { now: T0 + 0.5 * H, tuners: 2 });
  assert.equal(late.scheduled[0]!.partial, true);
  assert.equal(late.scheduled[0]!.start, T0 + 0.5 * H);
  const rec = plan(rules, built(), { now: T0 - H, tuners: 2, recorded: new Set([late.scheduled[0]!.key]) });
  assert.deepEqual(rec.scheduled.map((r) => (r.programme.start - T0) / H), [1]);
  assert.ok(rec.skipped.some((s) => s.reason === 'already-recorded'));
  assert.deepEqual(plan(rules, built(), { now: T0 + 10 * H, tuners: 2 }).scheduled, []);
  assert.deepEqual(plan(rules, built(), { now: T0 - H, tuners: 2, until: T0 + 0.5 * H }).scheduled.map((r) => r.programme.channel), ['a']);
});

test('plan: tuners, priority, and moving to a later airing to avoid a clash', () => {
  const rules: RecordingRule[] = [{ id: 'low', title: { glob: 'rival*' }, priority: 1 }, { id: 'high', title: { is: 'Show' }, priority: 9, keep: 'all' }];
  const g = built();
  const one = plan(rules, g, { now: T0 - H, tuners: 1 });
  const at1 = one.scheduled.filter((r) => r.start === T0 + H);
  assert.equal(at1.length, 1);
  assert.equal(at1[0]!.rule, 'high');
  assert.ok(one.skipped.some((s) => s.reason === 'conflict' && s.rule === 'low'));
  const two = plan(rules, g, { now: T0 - H, tuners: 2 });
  assert.equal(two.scheduled.filter((r) => r.start === T0 + H).length, 2);
  const g2 = new Guide();
  const ep1 = [{ system: 'onscreen', value: 'S01E01' }];
  g2.add([prog('c', 0, 'Blocker'), prog('a', 0, 'Show', { episodeNums: ep1 }), prog('b', 5, 'Show', { episodeNums: ep1, previouslyShown: true })]);
  const moved = plan([{ id: 'blk', title: { is: 'Blocker' }, priority: 9 }, { id: 's', title: { is: 'Show' } }], g2, { now: T0 - H, tuners: 1 });
  assert.deepEqual(moved.scheduled.map((r) => [r.rule, r.programme.channel]), [['blk', 'c'], ['s', 'b']]);
  assert.deepEqual(moved.skipped.map((s) => s.reason), ['another-airing']);
  const none = plan([{ id: 'blk', title: { is: 'Blocker' }, priority: 9 }, { id: 's', title: { is: 'Show' } }], g2, { now: T0 - H, tuners: 1, until: T0 + H });
  assert.deepEqual(none.scheduled.map((r) => r.rule), ['blk']);
  assert.deepEqual(none.skipped.map((s) => s.reason), ['conflict']);
  assert.throws(() => plan(rules, g, { now: 0, tuners: 0 }), XmltvError);
});

test('plan: the same airing on one tuner is shared by two rules', () => {
  const g = new Guide();
  g.add([prog('a', 0, 'Football', { categories: [{ text: 'Sport' }] })]);
  const p = plan([{ id: 'x', title: { is: 'Football' }, keep: 'all' }, { id: 'y', categories: ['sport'], keep: 'all' }], g, { now: T0 - H, tuners: 1 });
  assert.equal(p.scheduled.length, 1);
  assert.equal(p.scheduled[0]!.rule, 'x');
});

test('plan: guide channel names can be mapped to local ones before channel rules apply', () => {
  const g = built();
  const p = plan([{ id: 'r', channels: ['L-A'], title: { is: 'Show' } }], g, { now: T0 - H, tuners: 2, channelOf: (c) => (c === 'a' ? 'L-A' : c) });
  assert.deepEqual(p.scheduled.map((r) => r.programme.channel), ['a', 'a']);
});
