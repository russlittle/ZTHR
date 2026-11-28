import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EventType, ReplayPlanError, Redactor, RollingBuffer, SessionRecorder, chunkSession, decideRecording, parseSelectors, projectStorage, scrubText, scrubUrl, sessionBucket, sweep, tierFor,
  type ReplayEvent, type SNode, type StoredSession, type TierPlan,
} from './index.ts';

let nid = 0;
const el = (tag: string, attrs: Record<string, string> = {}, ...children: SNode[]): SNode => ({ id: ++nid, type: 'element', tag, attrs, children });
const tx = (text: string): SNode => ({ id: ++nid, type: 'text', text });
const snap = (root: SNode, ts = 1000): ReplayEvent => ({ type: 2, ts, data: { node: { id: 0, type: 'document', children: [root] } } });
const meta = (href: string, ts = 900): ReplayEvent => ({ type: 4, ts, data: { href, width: 1280, height: 800 } });

const find = (n: SNode, pred: (n: SNode) => boolean): SNode | undefined => (pred(n) ? n : n.children?.map((c) => find(c, pred)).find(Boolean));
const snapNode = (e: ReplayEvent | undefined): SNode => (e as Extract<ReplayEvent, { type: 2 }>).data.node.children![0]!;

test('selectors: tag, class, id, attributes, compound, descendant and child; anything else is refused', () => {
  const c = parseSelectors(['div.card > p', '#main [data-x^=ab]', 'input[type=password], .a.b']);
  assert.equal(c.length, 4);
  for (const bad of ['', 'div:hover', 'a + b', '::before', 'div[', '>']) assert.throws(() => parseSelectors([bad]), ReplayPlanError, bad);
  assert.throws(() => parseSelectors(['a'.repeat(201)]), /over 200/);
});

test('text inside mask selectors becomes asterisks of the same length; spaces and other text stay', () => {
  const root = el('body', {}, el('p', { class: 'public' }, tx('Hello world')), el('div', { class: 'secret' }, el('span', {}, tx('Jane Doe, 12 Elm St'))));
  const r = new Redactor({ maskSelectors: ['.secret'] });
  const out = snapNode(r.event(snap(root)));
  assert.equal(find(out, (n) => n.text === 'Hello world')?.text, 'Hello world');
  assert.equal(find(out, (n) => n.type === 'text' && n.text!.includes('*'))?.text, '**** **** ** *** **');
  assert.equal(r.stats.masked, 1);
});

test('maskAllText masks everything, and unmask selectors give back a subtree', () => {
  const root = el('body', {}, el('h1', {}, tx('Title')), el('nav', { id: 'menu' }, el('a', {}, tx('Home'))), el('p', {}, tx('Body')));
  const out = snapNode(new Redactor({ maskAllText: true, unmaskSelectors: ['#menu'] }).event(snap(root)));
  const texts = (n: SNode): string[] => (n.type === 'text' ? [n.text!] : (n.children ?? []).flatMap(texts));
  assert.deepEqual(texts(out), ['*****', 'Home', '****']);
});

test('inputs: password, e-mail, card fields and all inputs on request are masked; the typed text of events too', () => {
  const pw = el('input', { type: 'password', value: 'hunter22' });
  const em = el('input', { type: 'email', value: 'a@b.co' });
  const cc = el('input', { type: 'text', autocomplete: 'cc-number', value: '4111111111111111' });
  const nm = el('input', { type: 'text', value: 'Visible Name' });
  const root = el('form', {}, pw, em, cc, nm);
  const r = new Redactor({});
  const out = snapNode(r.event(snap(root)));
  const vals = out.children!.map((c) => c.attrs!['value']);
  assert.deepEqual(vals, ['********', '******', '****************', 'Visible Name']);
  const typed = r.event({ type: 3, ts: 1100, data: { source: 5, id: pw.id, text: 'hunter22' } }) as Extract<ReplayEvent, { type: 3 }>;
  assert.deepEqual(typed.data, { source: 5, id: pw.id, text: '********' });
  const plain = r.event({ type: 3, ts: 1100, data: { source: 5, id: nm.id, text: 'Visible Name' } }) as Extract<ReplayEvent, { type: 3 }>;
  assert.equal((plain.data as { text: string }).text, 'Visible Name');
  const all = snapNode(new Redactor({ maskAllInputs: true }).event(snap(el('form', {}, el('input', { type: 'text', value: 'abc' })))));
  assert.equal(all.children![0]!.attrs!['value'], '***');
});

test('ignored inputs record nothing, and blocked elements become empty boxes that keep only their size', () => {
  const secret = el('input', { type: 'text', class: 'sensitive', value: 'x' });
  const ad = el('div', { class: 'ad', width: '300', height: '250', style: 'background:red', id: 'a1' }, el('img', { src: 'https://x.example/a.png', alt: 'Buy now' }), tx('Buy now!'));
  const root = el('body', {}, secret, ad);
  const r = new Redactor({ ignoreSelectors: ['.sensitive'], blockSelectors: ['.ad'] });
  const out = snapNode(r.event(snap(root)));
  const box = out.children![1]!;
  assert.deepEqual(box.attrs, { 'data-replay-blocked': 'true', width: '300', height: '250' });
  assert.deepEqual(box.children, []);
  assert.equal(r.event({ type: 3, ts: 1, data: { source: 5, id: secret.id, text: 'typed' } }), undefined);
  assert.equal(r.stats.dropped, 1);
  assert.equal(r.stats.blocked, 1);
  const inside = ad.children![0]!;
  assert.equal(r.event({ type: 3, ts: 2, data: { source: 5, id: inside.id, text: 'x' } }), undefined);
});

test('dangerous attributes go: handlers, srcdoc, javascript urls, big data urls; tokens in urls are redacted', () => {
  const big = `data:image/png;base64,${'A'.repeat(3000)}`;
  const root = el('body', {}, el('a', { href: 'https://app.example/cb?code=abc123&page=2', onclick: 'steal()' }, tx('x')), el('iframe', { srcdoc: '<script>1</script>', src: 'javascript:alert(1)' }), el('img', { src: big }), el('img', { src: 'data:image/gif;base64,R0lG' }));
  const out = snapNode(new Redactor({}).event(snap(root)));
  const [a, f, big1, small] = out.children!;
  assert.deepEqual(a!.attrs, { href: 'https://app.example/cb?code=%5Bredacted%5D&page=2' });
  assert.deepEqual(f!.attrs, {});
  assert.deepEqual(big1!.attrs, {});
  assert.deepEqual(small!.attrs, { src: 'data:image/gif;base64,R0lG' });
  assert.equal(scrubUrl('https://u:p@x.example/p?token=abc&q=1#access_token=zzz'), 'https://x.example/p?token=%5Bredacted%5D&q=1#[redacted]');
  assert.equal(scrubUrl('/rel?sid=1'), '/rel?sid=%5Bredacted%5D');
  assert.equal(scrubUrl('http://[bad'), '[url]');
});

test('free text is scrubbed of e-mail, Luhn-valid card numbers, SSNs and phone numbers, and nothing else', () => {
  assert.equal(scrubText('write to jane.doe+x@mail.example.com now'), 'write to [email] now');
  assert.equal(scrubText('card 4111 1111 1111 1111 ok'), 'card [card] ok');
  assert.equal(scrubText('order 4111 1111 1111 1112 stays'), 'order 4111 1111 1111 1112 stays', 'sixteen digits that fail Luhn are not a card, and too long for a phone');
  assert.equal(scrubText('ref 12345678901234567890 end'), 'ref 12345678901234567890 end');
  assert.equal(scrubText('ssn 123-45-6789.'), 'ssn [ssn].');
  assert.equal(scrubText('call +1 (937) 555-0100 today'), 'call [phone] today');
  assert.equal(scrubText('version 1.2.3 and 2026-11-28'), 'version 1.2.3 and 2026-11-28');
  const out = snapNode(new Redactor({}).event(snap(el('p', {}, tx('mail me at a@b.example')))));
  assert.equal(out.children![0]!.text, 'mail me at [email]');
});

test('mutations are masked by what the node was: new text under a masked parent, changed values, removed nodes forgotten', () => {
  const list = el('ul', { class: 'private' });
  const field = el('input', { type: 'password', value: '' });
  const r = new Redactor({ maskSelectors: ['.private'] });
  r.event(snap(el('body', {}, list, field)));
  const added = r.event({ type: 3, ts: 2000, data: { source: 0, adds: [{ parentId: list.id, node: el('li', {}, tx('Alice Smith')) }] } }) as Extract<ReplayEvent, { type: 3 }>;
  const li = (added.data as unknown as { adds: { node: SNode }[] }).adds[0]!.node;
  assert.equal(li.children![0]!.text, '***** *****');
  const textId = li.children![0]!.id;
  const changed = r.event({ type: 3, ts: 2100, data: { source: 0, texts: [{ id: textId, value: 'Bob Jones' }], attributes: [{ id: field.id, attributes: { value: 'pass', onfocus: 'x()', class: 'a' } }] } }) as Extract<ReplayEvent, { type: 3 }>;
  const d = changed.data as unknown as { texts: { value: string }[]; attributes: { attributes: Record<string, string | null> }[] };
  assert.equal(d.texts[0]!.value, '*** *****');
  assert.deepEqual(d.attributes[0]!.attributes, { value: '****', class: 'a' });
  r.event({ type: 3, ts: 2200, data: { source: 0, removes: [{ parentId: list.id, id: li.id }] } });
});

test('page rules: pause drops events, mask-all masks the page, and the page address is scrubbed', () => {
  const r = new Redactor({ pages: [{ match: '/checkout/**', action: 'pause' }, { match: '/account', action: 'mask-all' }, { match: 're:^/admin/\\d+$', action: 'pause' }] });
  const m = r.event(meta('https://shop.example/checkout/pay?token=zzz')) as Extract<ReplayEvent, { type: 4 }>;
  assert.equal(m.data.href, 'https://shop.example/checkout/pay?token=%5Bredacted%5D');
  assert.equal(r.paused, true);
  assert.equal(r.event(snap(el('p', {}, tx('card')))), undefined);
  assert.equal(r.event({ type: 3, ts: 5, data: { source: 3, id: 1, x: 0, y: 5 } }), undefined);
  r.event(meta('https://shop.example/account'));
  assert.equal(r.paused, false);
  assert.equal(snapNode(r.event(snap(el('p', {}, tx('Jane'))))).children![0]!.text, '****');
  r.event(meta('https://shop.example/home'));
  assert.equal(snapNode(r.event(snap(el('p', {}, tx('Jane'))))).children![0]!.text, 'Jane');
  r.event(meta('https://shop.example/admin/42'));
  assert.equal(r.paused, true);
  assert.throws(() => new Redactor({ pages: [{ match: 're:(a+)+', action: 'pause' }] }), /could run for ever/);
  assert.throws(() => new Redactor({ pages: [{ match: 're:(', action: 'pause' }] }), /does not compile/);
});

test('sampling: consent, signals, regions, forced users and a stable share of sessions', () => {
  const ok = { sessionId: 's1', consent: 'granted' as const };
  assert.deepEqual(decideRecording({ rate: 1 }, { ...ok, consent: 'unknown' }), { record: false, buffer: false, reason: 'no consent given' });
  assert.equal(decideRecording({ rate: 1 }, { ...ok, consent: 'denied' }).reason, 'consent denied');
  assert.equal(decideRecording({ rate: 1, requireConsent: false }, { sessionId: 's1', consent: 'unknown' }).record, true);
  assert.equal(decideRecording({ rate: 1 }, { ...ok, globalPrivacyControl: true }).reason, 'Global Privacy Control');
  assert.equal(decideRecording({ rate: 1 }, { ...ok, doNotTrack: true }).reason, 'Do Not Track');
  assert.equal(decideRecording({ rate: 1, respectSignals: false }, { ...ok, doNotTrack: true }).record, true);
  assert.equal(decideRecording({ rate: 1, excludeRegions: ['DE'] }, { ...ok, region: 'DE' }).reason, 'region DE excluded');
  assert.equal(decideRecording({ rate: 0, forceUsers: ['u1'] }, { ...ok, userId: 'u1' }).reason, 'user always recorded');
  assert.deepEqual(decideRecording({ rate: 0, errorWindowMs: 30_000 }, ok), { record: false, buffer: true, reason: 'sampled out' });
  assert.throws(() => decideRecording({ rate: 1.5 }, ok), ReplayPlanError);
  let n = 0;
  for (let i = 0; i < 10_000; i++) if (decideRecording({ rate: 0.1 }, { sessionId: `session-${i}`, consent: 'granted' }).record) n++;
  assert.ok(n > 850 && n < 1150, `about 10% sampled, got ${n}`);
  assert.equal(sessionBucket('abc'), sessionBucket('abc'));
  assert.ok(sessionBucket('abc') >= 0 && sessionBucket('abc') < 1);
});

test('the rolling buffer keeps the window from a snapshot on, so an error can rescue a session', () => {
  const b = new RollingBuffer(10_000);
  const snaps = [0, 10_000, 20_000, 30_000, 40_000].map((t) => snap(el('p', {}, tx(`s${t}`)), t));
  b.push(meta('https://x.example/', -1));
  for (let t = 0; t <= 40_000; t += 1000) {
    if (t % 10_000 === 0) b.push(snaps[t / 10_000]!);
    else b.push({ type: 3, ts: t, data: { source: 3, id: 1, x: 0, y: t } });
  }
  const out = b.flush();
  assert.equal(out[0]!.type, 4, 'the page address came before the window, so it is put first');
  assert.equal(out[1], snaps[3], 'the window starts at the snapshot that covers it');
  assert.deepEqual(out.slice(1).map((e) => e.ts), [30_000, 31_000, 32_000, 33_000, 34_000, 35_000, 36_000, 37_000, 38_000, 39_000, 40_000]);
  const big = new RollingBuffer(1e9, 5);
  big.push(snaps[0]!);
  for (let i = 1; i <= 4; i++) big.push(snaps[i]!);
  assert.equal(big.flush().length, 5);
  assert.throws(() => new RollingBuffer(0), ReplayPlanError);
});

test('a recorder enforces event, byte and duration limits, and discards sessions that are too short', () => {
  const mk = (limits: Partial<{ maxEvents: number; maxBytes: number; maxDurationMs: number; minDurationMs: number }> = {}) => new SessionRecorder({}, { maxEvents: 5, maxBytes: 1e6, maxDurationMs: 60_000, minDurationMs: 2000, ...limits });
  const mv = (ts: number): ReplayEvent => ({ type: 3, ts, data: { source: 3, id: 1, x: 0, y: 0 } });
  const a = mk();
  for (let i = 0; i < 5; i++) assert.equal(a.accept(mv(i * 1000)).ok, true);
  assert.deepEqual(a.accept(mv(6000)), { ok: false, reason: 'limit-events' });
  assert.deepEqual(a.accept(mv(7000)), { ok: false, reason: 'stopped' });
  assert.deepEqual([a.close().keep, a.close().reason], [true, 'kept up to the limit-events']);
  const b = mk({ maxDurationMs: 3000 });
  b.accept(mv(0));
  assert.deepEqual(b.accept(mv(3001)), { ok: false, reason: 'limit-duration' });
  const c = mk({ maxBytes: 100 });
  assert.deepEqual(c.accept(snap(el('p', {}, tx('a long enough text to pass one hundred bytes of json for sure, yes'))))  , { ok: false, reason: 'limit-bytes' });
  const d = mk();
  d.accept(mv(0));
  d.accept(mv(1000));
  assert.deepEqual([d.close().keep, d.close().reason], [false, 'shorter than the minimum']);
  assert.equal(d.close(true).keep, true, 'an error keeps even a short session');
  assert.equal(mk().close().reason, 'no events');
  const p = new SessionRecorder({ pages: [{ match: '/pay', action: 'pause' }] }, { maxEvents: 9, maxBytes: 1e6, maxDurationMs: 1e6, minDurationMs: 0 });
  p.accept(meta('https://x.example/pay'));
  assert.deepEqual(p.accept(mv(1000)), { ok: false, reason: 'paused' });
});

test('chunks are cut at snapshots and by size, and each snapshot chunk can be played alone', () => {
  const ev: ReplayEvent[] = [meta('https://x.example/', 0), snap(el('p', {}, tx('a')), 1)];
  for (let t = 2; t < 12; t++) ev.push({ type: 3, ts: t, data: { source: 3, id: 1, x: 0, y: t } });
  ev.push(snap(el('p', {}, tx('b')), 20));
  ev.push({ type: 3, ts: 21, data: { source: 3, id: 1, x: 0, y: 1 } });
  const c = chunkSession(ev, { maxEvents: 4, maxBytes: 1e6 });
  assert.deepEqual(c.map((x) => x.events.length), [1, 4, 4, 3, 2]);
  assert.deepEqual(c.map((x) => x.seekable), [false, true, false, false, true]);
  assert.equal(c.reduce((n, x) => n + x.events.length, 0), ev.length);
  assert.equal(c.at(-1)!.endTs, 21);
  assert.deepEqual(c.map((x) => x.index), [0, 1, 2, 3, 4]);
  assert.throws(() => chunkSession(ev, { maxEvents: 0, maxBytes: 1 }), ReplayPlanError);
  const bySize = chunkSession(ev, { maxEvents: 100, maxBytes: 150 });
  assert.ok(bySize.every((x) => x.events.length === 1 || x.bytes <= 150));
  assert.equal(EventType.FullSnapshot, 2);
});

const DAY = 86_400_000;
const plan: TierPlan = { hotDays: 7, warmDays: 30, coldDays: 90 };
const NOW = Date.UTC(2026, 10, 28);
const sess = (id: string, ageDays: number, over: Partial<StoredSession> = {}): StoredSession => ({ id, createdAt: NOW - ageDays * DAY, bytes: 1000, tier: 'hot', ...over });

test('tiers by age, longer for starred and error sessions, held by tickets and legal holds', () => {
  assert.deepEqual(tierFor(sess('a', 3), plan, NOW), { tier: 'hot', reason: 'young' });
  assert.equal(tierFor(sess('a', 8), plan, NOW).tier, 'warm');
  assert.equal(tierFor(sess('a', 40), plan, NOW).tier, 'cold');
  assert.equal(tierFor(sess('a', 100), plan, NOW).tier, 'deleted');
  assert.equal(tierFor(sess('a', 20, { starred: true }), plan, NOW).tier, 'hot', 'three times longer in hot');
  assert.equal(tierFor(sess('a', 100, { hadError: true }), plan, NOW).tier, 'cold');
  assert.deepEqual(tierFor(sess('a', 400, { ticket: 'SUP-9' }), plan, NOW), { tier: 'cold', reason: 'kept: linked to SUP-9' });
  assert.equal(tierFor(sess('a', 400, { legalHold: true }), plan, NOW).reason, 'kept: legal hold');
  assert.throws(() => tierFor(sess('a', 1), { hotDays: 30, warmDays: 7, coldDays: 90 }, NOW), /must grow/);
});

test('sweep lists moves only forward, and never deletes a legal hold', () => {
  const list = [sess('young', 2), sess('old', 8), sess('cold', 40, { tier: 'warm' }), sess('gone', 120, { tier: 'cold' }), sess('held', 500, { tier: 'cold', legalHold: true }), sess('already', 40, { tier: 'cold' })];
  assert.deepEqual(sweep(list, plan, NOW), [
    { id: 'old', from: 'hot', to: 'warm', reason: 'aged past hot' },
    { id: 'cold', from: 'warm', to: 'cold', reason: 'aged past warm' },
    { id: 'gone', from: 'cold', to: 'deleted', reason: 'past retention' },
  ]);
});

test('storage projection from rates: bytes in each tier and in all', () => {
  const p = projectStorage({ sessionsPerDay: 10_000, sampleRate: 0.1, meanBytes: 200_000, plan });
  assert.equal(p.hotBytes, 1000 * 200_000 * 7);
  assert.equal(p.warmBytes, 1000 * 200_000 * 23);
  assert.equal(p.coldBytes, 1000 * 200_000 * 60);
  assert.equal(p.totalBytes, 1000 * 200_000 * 90);
});
