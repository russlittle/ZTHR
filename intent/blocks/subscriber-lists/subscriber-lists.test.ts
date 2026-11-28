import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ListError, SubscriberLists, addressFingerprint, csvCell, isRoleAddress, normalizeEmail, parseCsv } from './index.ts';
import type { ListsOptions } from './index.ts';
import type { Message } from '../notify/index.ts';
import type { Record_ } from '../consent/index.ts';

const T0 = Date.UTC(2026, 5, 1, 9, 0, 0);
const DAY = 86_400_000;

interface Rig {
  readonly lists: SubscriberLists;
  readonly sent: Message[];
  readonly consents: Record_[];
  clock: { t: number };
}

function rig(over: Partial<ListsOptions> = {}, double = true): Rig {
  const sent: Message[] = [];
  const consents: Record_[] = [];
  const clock = { t: T0 };
  const lists = new SubscriberLists({
    secret: 'test-secret-01234', now: () => clock.t, send: async (m) => { sent.push(m); }, onConsent: (r) => consents.push(r),
    confirmUrl: 'https://example.org/confirm', unsubscribeUrl: 'https://example.org/unsub?src=mail', preferencesUrl: 'https://example.org/prefs',
    ...over,
  });
  lists.createList({ id: 'news', name: 'Monthly news', doubleOptIn: double, consentText: 'Send me the monthly news by email.', topics: [{ id: 'product', name: 'Product', defaultOn: true }, { id: 'events', name: 'Events', defaultOn: false }], frequencies: ['weekly', 'monthly'] });
  return { lists, sent, consents, clock };
}

const tokenIn = (body: string): string => /[?&]t=([A-Za-z0-9_.-]+)/.exec(body)![1]!;
const form = { source: 'homepage form', ip: '203.0.113.7', userAgent: 'Mozilla/5.0' };

test('addresses are normalised, and anything that could smuggle a header, a second recipient or a bad domain is refused', () => {
  assert.equal(normalizeEmail('  Ana.Smith+news@Example.COM '), 'ana.smith+news@example.com');
  assert.equal(normalizeEmail('x@bücher.example'), 'x@xn--bcher-kva.example');
  assert.equal(normalizeEmail('a@example.com.'), 'a@example.com');
  for (const bad of ['', 'a', 'a@b', 'a@@b.com', 'a@b.com\nBcc: x@y.com', 'a b@example.com', '"a"@example.com', 'a@example.com, b@example.com', '<a@example.com>', '.a@example.com', 'a..b@example.com', 'a@-x.com', 'a@x-.com', 'a@[1.2.3.4]', 'a@1.2.3.4', `${'x'.repeat(65)}@example.com`, `a@${'x'.repeat(250)}.com`, 'a@exam ple.com'])
    assert.equal(normalizeEmail(bad), undefined, JSON.stringify(bad));
  assert.equal(normalizeEmail(5 as unknown as string), undefined);
  assert.equal(isRoleAddress('postmaster@example.com'), true);
  assert.equal(isRoleAddress('noreply+x@example.com'), true);
  assert.equal(isRoleAddress('ana@example.com'), false);
  assert.equal(addressFingerprint('A@Example.com'), addressFingerprint('a@example.com'));
});

test('double opt-in: asking sends one mail, nothing is subscribed until the link is used', async () => {
  const { lists, sent, consents } = rig();
  assert.equal(await lists.subscribe('news', 'Ana@Example.com', form), 'confirmation-sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, 'ana@example.com');
  assert.equal(sent[0]!.subject, 'Confirm your subscription to Monthly news');
  assert.match(sent[0]!.body, /Send me the monthly news by email\./);
  assert.match(sent[0]!.body, /If this was not you, ignore this message/);
  assert.deepEqual(lists.recipients('news'), []);
  assert.equal(lists.get('news', 'ana@example.com')?.state, 'pending');
  assert.equal(consents.length, 0, 'no consent is recorded before confirmation');
  const r = lists.confirm(tokenIn(sent[0]!.body), { ip: '198.51.100.2', userAgent: 'Safari' });
  assert.deepEqual(r, { ok: true, list: 'news', email: 'ana@example.com', alreadyConfirmed: false });
  assert.deepEqual(lists.recipients('news'), ['ana@example.com']);
  assert.equal(consents.length, 1);
  assert.deepEqual([consents[0]!.doc, consents[0]!.version, consents[0]!.given, consents[0]!.how, consents[0]!.at], ['list:news', 1, true, 'confirm-link', '2026-06-01T09:00:00.000Z']);
  assert.match(consents[0]!.who, /^sub_[0-9a-f]{20}$/);
  const ev = lists.get('news', 'ana@example.com')!.evidence;
  assert.deepEqual(ev.map((e) => [e.method, e.source, e.ip]), [['form', 'homepage form', '203.0.113.7'], ['confirm-link', 'confirmation link', '198.51.100.2']]);
  assert.equal(ev[0]!.consentText, 'Send me the monthly news by email.');
  assert.deepEqual(lists.confirm(tokenIn(sent[0]!.body)), { ok: true, list: 'news', email: 'ana@example.com', alreadyConfirmed: true });
  assert.equal(consents.length, 1, 'confirming twice records consent once');
});

test('confirmation links expire, cannot be forged or moved, and a stale one cannot revive an unsubscribed person', async () => {
  const { lists, sent, clock } = rig();
  await lists.subscribe('news', 'ana@example.com', form);
  const tok = tokenIn(sent[0]!.body);
  const [p, s] = tok.split('.') as [string, string];
  assert.deepEqual(lists.confirm(`${p}.${s.slice(0, -2)}AA`), { ok: false, reason: 'invalid' });
  assert.deepEqual(lists.confirm(`${Buffer.from(JSON.stringify(['news', 'eve@example.com', 1, T0 + 9e9])).toString('base64url')}.${s}`), { ok: false, reason: 'invalid' });
  for (const junk of ['', 'abc', 'a.b.c', '.', `${p}.`, 'x'.repeat(2000), 5 as unknown as string]) assert.deepEqual(lists.confirm(junk), { ok: false, reason: 'invalid' });
  clock.t += 3 * DAY + 1;
  assert.deepEqual(lists.confirm(tok), { ok: false, reason: 'expired' });
  clock.t = T0 + 1000;
  assert.equal(lists.confirm(tok).ok, true);
  const unsub = lists.unsubscribeHeaders('news', 'ana@example.com')['List-Unsubscribe']!.slice(1, -1);
  assert.equal(lists.unsubscribe(tokenIn(unsub)).ok, true);
  assert.deepEqual(lists.confirm(tok), { ok: false, reason: 'superseded' }, 'the old link does not resubscribe');
  assert.equal(lists.get('news', 'ana@example.com')?.state, 'unsubscribed');
});

test('a link made for one purpose does not work for another', async () => {
  const { lists, sent } = rig();
  await lists.subscribe('news', 'ana@example.com', form);
  lists.confirm(tokenIn(sent[0]!.body));
  const unsub = tokenIn(lists.unsubscribeHeaders('news', 'ana@example.com')['List-Unsubscribe']!);
  const prefs = tokenIn(lists.preferencesLink('news', 'ana@example.com'));
  const confirmTok = tokenIn(sent[0]!.body);
  assert.deepEqual(lists.confirm(unsub), { ok: false, reason: 'invalid' });
  assert.deepEqual(lists.confirm(prefs), { ok: false, reason: 'invalid' });
  assert.equal(lists.unsubscribe(confirmTok).ok, false);
  assert.equal(lists.unsubscribe(prefs).ok, false);
  assert.equal(lists.preferences(unsub), undefined);
  assert.equal(lists.setPreferences(confirmTok, { topics: { events: true } }), false);
  assert.equal(lists.get('news', 'ana@example.com')?.state, 'subscribed', 'none of that changed anything');
  const other = rig({ secret: 'other-secret-xyz12' });
  assert.equal(other.lists.unsubscribe(unsub).ok, false, 'another deployment cannot read these tokens');
});

test('one-click unsubscribe: RFC 8058 headers, works by one POST, safe to repeat, records the withdrawal', async () => {
  const { lists, sent, consents } = rig();
  await lists.subscribe('news', 'ana@example.com', form);
  lists.confirm(tokenIn(sent[0]!.body));
  const h = lists.unsubscribeHeaders('news', 'ana@example.com');
  assert.match(h['List-Unsubscribe']!, /^<https:\/\/example\.org\/unsub\?src=mail&t=[^>]+>$/);
  assert.equal(h['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const tok = tokenIn(h['List-Unsubscribe']!);
  assert.deepEqual(lists.unsubscribe(tok), { ok: true, list: 'news' });
  assert.deepEqual(lists.unsubscribe(tok), { ok: true, list: 'news' });
  assert.deepEqual(lists.recipients('news'), []);
  assert.deepEqual(consents.map((c) => c.given), [true, false]);
  assert.equal(consents[1]!.how, 'by link');
  assert.deepEqual(lists.history('news', 'ana@example.com').map((e) => e.type), ['confirmation-sent', 'confirmed', 'unsubscribed']);
  assert.deepEqual(lists.stats('news'), { pending: 0, subscribed: 0, unsubscribed: 1 });
  assert.equal(lists.unsubscribe('garbage').ok, false);
});

test('a person who unsubscribed can sign up again themselves, and must confirm again', async () => {
  const { lists, sent, clock } = rig();
  await lists.subscribe('news', 'ana@example.com', form);
  lists.confirm(tokenIn(sent[0]!.body));
  lists.unsubscribe(tokenIn(lists.unsubscribeHeaders('news', 'ana@example.com')['List-Unsubscribe']!));
  clock.t += 1000 * 60 * 5;
  assert.equal(await lists.subscribe('news', 'ana@example.com', form), 'confirmation-sent');
  assert.equal(lists.get('news', 'ana@example.com')?.state, 'pending');
  assert.equal(lists.confirm(tokenIn(sent[1]!.body)).ok, true);
  assert.equal(lists.get('news', 'ana@example.com')?.state, 'subscribed');
  assert.equal(await lists.subscribe('news', 'ana@example.com', form), 'already-subscribed');
  assert.equal(sent.length, 2, 'no mail for someone already on the list');
});

test('confirmation mail is rate limited per address, with a cooldown and a daily cap', async () => {
  const { lists, sent, clock } = rig();
  assert.equal(await lists.subscribe('news', 'ana@example.com', form), 'confirmation-sent');
  assert.equal(await lists.subscribe('news', 'ana@example.com', form), 'rate-limited', 'inside the cooldown');
  clock.t += 61_000;
  assert.equal(await lists.subscribe('news', 'ana@example.com', form), 'confirmation-sent');
  clock.t += 61_000;
  assert.equal(await lists.subscribe('news', 'ana@example.com', form), 'confirmation-sent');
  clock.t += 61_000;
  assert.equal(await lists.subscribe('news', 'ana@example.com', form), 'rate-limited', 'the fourth in a day');
  assert.equal(sent.length, 3);
  clock.t += DAY;
  assert.equal(await lists.subscribe('news', 'ana@example.com', form), 'confirmation-sent');
  assert.equal(await lists.subscribe('news', 'bo@example.com', form), 'confirmation-sent', 'other addresses have their own budget');
});

test('the public reply is the same for every outcome, and invalid or suppressed input sends nothing', async () => {
  const { lists, sent } = rig();
  lists.suppress('bad@example.com', 'complaint');
  assert.equal(await lists.subscribe('news', 'bad@example.com', form), 'suppressed');
  assert.equal(await lists.subscribe('news', 'not an address', form), 'invalid');
  assert.equal(sent.length, 0);
  assert.equal(lists.publicReply('news'), 'Thanks. If this address can be added, a confirmation message is on its way.');
  assert.equal(rig({}, false).lists.publicReply('news'), 'Thanks. You are on the list.');
  await assert.rejects(() => lists.subscribe('nope', 'a@example.com', form), ListError);
});

test('a failing mail service leaves the person pending and reports it without throwing', async () => {
  const { lists } = rig({ send: async () => { throw new Error('smtp down'); } });
  assert.equal(await lists.subscribe('news', 'ana@example.com', form), 'send-failed');
  assert.equal(lists.get('news', 'ana@example.com')?.state, 'pending');
  assert.deepEqual(lists.history('news', 'ana@example.com').map((e) => e.type), ['send-failed']);
});

test('single opt-in lists subscribe at once and still keep the evidence', async () => {
  const { lists, sent, consents } = rig({}, false);
  assert.equal(await lists.subscribe('news', 'ana@example.com', form), 'subscribed');
  assert.equal(sent.length, 0);
  assert.deepEqual(lists.recipients('news'), ['ana@example.com']);
  assert.equal(consents.length, 1);
  assert.equal(lists.get('news', 'ana@example.com')!.evidence[0]!.ip, '203.0.113.7');
});

test('evidence is kept with the wording shown at the time, and wording changes bump the version', async () => {
  const { lists, sent, consents } = rig();
  await lists.subscribe('news', 'ana@example.com', form);
  assert.equal(lists.setConsentText('news', 'Send me news and offers.'), 2);
  await lists.subscribe('news', 'bo@example.com', { source: 'footer', ip: '1.2.3.4\nX-Evil: 1', userAgent: 'u'.repeat(500) });
  lists.confirm(tokenIn(sent[0]!.body));
  lists.confirm(tokenIn(sent[1]!.body));
  const a = lists.get('news', 'ana@example.com')!.evidence[0]!;
  const b = lists.get('news', 'bo@example.com')!.evidence[0]!;
  assert.deepEqual([a.consentVersion, a.consentText], [1, 'Send me the monthly news by email.']);
  assert.deepEqual([b.consentVersion, b.consentText], [2, 'Send me news and offers.']);
  assert.equal(b.ip, '1.2.3.4 X-Evil: 1', 'control characters are replaced');
  assert.equal(b.userAgent!.length, 300);
  assert.deepEqual(consents.map((c) => c.version), [2, 2]);
  assert.throws(() => lists.setConsentText('news', '  '), /cannot be empty/);
});

test('the preference centre: topics, frequency, defaults, unknown values refused, everything off keeps the subscription', async () => {
  const { lists, sent } = rig();
  await lists.subscribe('news', 'ana@example.com', form);
  lists.confirm(tokenIn(sent[0]!.body));
  const tok = tokenIn(lists.preferencesLink('news', 'ana@example.com'));
  const p = lists.preferences(tok)!;
  assert.deepEqual(p.topics, [{ id: 'product', name: 'Product', on: true }, { id: 'events', name: 'Events', on: false }]);
  assert.deepEqual([p.frequency, p.frequencies, p.listName, p.state], ['weekly', ['weekly', 'monthly'], 'Monthly news', 'subscribed']);
  assert.equal(lists.setPreferences(tok, { topics: { events: true, product: false }, frequency: 'monthly' }), true);
  assert.deepEqual(lists.get('news', 'ana@example.com')?.topics, { product: false, events: true });
  assert.deepEqual(lists.recipients('news', { topic: 'events' }), ['ana@example.com']);
  assert.deepEqual(lists.recipients('news', { topic: 'product' }), []);
  assert.deepEqual(lists.recipients('news', { frequency: 'weekly' }), []);
  assert.deepEqual(lists.recipients('news', { frequency: 'monthly' }), ['ana@example.com']);
  assert.throws(() => lists.setPreferences(tok, { topics: { nope: true } }), /unknown topic/);
  assert.throws(() => lists.setPreferences(tok, { frequency: 'hourly' }), /unknown frequency/);
  assert.throws(() => lists.recipients('news', { topic: 'nope' }), /unknown topic/);
  lists.setPreferences(tok, { topics: { events: false } });
  assert.equal(lists.get('news', 'ana@example.com')?.state, 'subscribed');
  assert.equal(lists.unsubscribeViaPreferences(tok), true);
  assert.equal(lists.get('news', 'ana@example.com')?.state, 'unsubscribed');
  assert.throws(() => lists.setPreferences(tok, { topics: { events: true } }), /confirmed subscriber/);
  assert.equal(lists.preferences('x.y'), undefined);
});

test('preference links expire after 30 days', async () => {
  const { lists, sent, clock } = rig();
  await lists.subscribe('news', 'ana@example.com', form);
  lists.confirm(tokenIn(sent[0]!.body));
  const tok = tokenIn(lists.preferencesLink('news', 'ana@example.com'));
  clock.t += 29 * DAY;
  assert.ok(lists.preferences(tok));
  clock.t += 2 * DAY;
  assert.equal(lists.preferences(tok), undefined);
  assert.equal(lists.setPreferences(tok, {}), false);
});

test('suppression beats everything: bounces and complaints remove people, block sign-up, and cannot be lifted', async () => {
  const { lists, sent, consents } = rig();
  await lists.subscribe('news', 'ana@example.com', form);
  await lists.subscribe('news', 'bo@example.com', form);
  lists.confirm(tokenIn(sent[0]!.body));
  lists.confirm(tokenIn(sent[1]!.body));
  lists.recordBounce('ana@example.com', 'hard');
  lists.recordBounce('BO@example.com', 'complaint');
  assert.deepEqual(lists.recipients('news'), []);
  assert.equal(lists.suppressionReason('ana@example.com'), 'hard-bounce');
  assert.equal(lists.suppressionReason('bo@example.com'), 'complaint');
  assert.equal(consents.filter((c) => !c.given).length, 2);
  assert.equal(await lists.subscribe('news', 'ana@example.com', form), 'suppressed');
  assert.throws(() => lists.liftSuppression('ana@example.com'), /cannot be lifted/);
  assert.equal(lists.isSuppressed('ANA@example.com'), true);
  lists.suppress('cy@example.com', 'manual');
  assert.equal(await lists.subscribe('news', 'cy@example.com', form), 'suppressed');
  assert.equal(lists.liftSuppression('cy@example.com'), true);
  assert.equal(await lists.subscribe('news', 'cy@example.com', form), 'confirmation-sent');
  assert.equal(lists.liftSuppression('nobody@example.com'), false);
  assert.equal(lists.suppress('garbage', 'manual'), false);
  assert.deepEqual(lists.confirm(tokenIn(sent[0]!.body)), { ok: false, reason: 'invalid' }, 'an old confirmation link does nothing for a suppressed address');
  assert.deepEqual(lists.recipients('news'), []);
});

test('soft bounces suppress only when they pile up within a week', async () => {
  const { lists, clock } = rig();
  for (let i = 0; i < 4; i++) { lists.recordBounce('ana@example.com', 'soft'); clock.t += DAY; }
  assert.equal(lists.isSuppressed('ana@example.com'), false);
  clock.t += 4 * DAY;
  lists.recordBounce('ana@example.com', 'soft');
  assert.equal(lists.isSuppressed('ana@example.com'), false, 'the earlier ones are more than a week old');
  for (let i = 0; i < 4; i++) { clock.t += 1000; lists.recordBounce('ana@example.com', 'soft'); }
  assert.equal(lists.suppressionReason('ana@example.com'), 'repeated-soft-bounce');
});

test('erasure removes the person from every list and leaves only a keyed hash that still blocks them', async () => {
  const { lists, sent } = rig();
  lists.createList({ id: 'other', name: 'Other', consentText: 'Other news' });
  await lists.subscribe('news', 'ana@example.com', form);
  await lists.subscribe('other', 'ana@example.com', form);
  lists.confirm(tokenIn(sent[0]!.body));
  assert.equal(lists.erase('Ana@example.com'), 2);
  assert.equal(lists.get('news', 'ana@example.com'), undefined);
  assert.equal(lists.get('other', 'ana@example.com'), undefined);
  assert.equal(lists.suppressionReason('ana@example.com'), 'erasure');
  assert.equal(await lists.subscribe('other', 'ana@example.com', form), 'suppressed');
  assert.throws(() => lists.liftSuppression('ana@example.com'), /cannot be lifted/);
  assert.equal(lists.erase('not an address'), 0);
  assert.ok(!JSON.stringify([...(lists as unknown as { suppressions: Map<string, unknown> }).suppressions.keys()]).includes('ana'), 'the address is not stored in the suppression list');
  assert.equal(lists.confirm(tokenIn(sent[0]!.body)).ok, false);
});

const row = (email: string, extra: Partial<{ consentedAt: string | number; consentSource: string; consentText: string; ip: string; topics: string[] }> = {}) => ({ email, consentedAt: '2026-03-01T10:00:00Z', consentSource: 'spring competition form', ...extra });

test('import: each row gets a verdict, evidence is required, and nothing is added without it', async () => {
  const { lists, sent } = rig();
  lists.suppress('sup@example.com', 'complaint');
  await lists.subscribe('news', 'old@example.com', form);
  const rows = [
    row('new1@example.com'), row('NEW1@example.com'), row('bad address'), row('postmaster@example.com'), row('sup@example.com'), row('old@example.com'),
    { email: 'noev@example.com' }, { email: 'nosrc@example.com', consentedAt: '2026-03-01T10:00:00Z' }, { email: 'nodate@example.com', consentSource: 'x' },
    row('future@example.com', { consentedAt: T0 + 5 * DAY }), row('ancient@example.com', { consentedAt: '2019-01-01T00:00:00Z' }), row('junk-date@example.com', { consentedAt: 'last tuesday' }), row('new2@example.com'),
  ];
  const rep = await lists.importRows('news', rows, { batch: 'spring-import' });
  assert.deepEqual(rep.rows.map((r) => r.verdict), ['confirmation-sent', 'duplicate', 'invalid', 'role-account', 'suppressed', 'exists', 'no-evidence', 'no-evidence', 'no-evidence', 'future-consent', 'stale-consent', 'no-evidence', 'confirmation-sent']);
  assert.deepEqual(rep.counts, { 'confirmation-sent': 2, duplicate: 1, invalid: 1, 'role-account': 1, suppressed: 1, exists: 1, 'no-evidence': 4, 'future-consent': 1, 'stale-consent': 1 });
  assert.equal(rep.total, 13);
  assert.equal(rep.batch, 'spring-import');
  assert.deepEqual(sent.filter((m) => m.to.startsWith('new')).map((m) => m.to), ['new1@example.com', 'new2@example.com']);
  const v = lists.get('news', 'new1@example.com')!;
  assert.equal(v.state, 'pending', 'imported people on a double opt-in list still have to confirm');
  assert.deepEqual([v.evidence[0]!.method, v.evidence[0]!.source, v.evidence[0]!.batch, v.evidence[0]!.at], ['import', 'spring competition form', 'spring-import', Date.UTC(2026, 2, 1, 10)]);
  assert.equal(lists.get('news', 'future@example.com'), undefined);
  assert.equal(lists.get('news', 'noev@example.com'), undefined);
});

test('import never re-adds someone who unsubscribed, however good the evidence looks', async () => {
  const { lists, sent } = rig();
  await lists.subscribe('news', 'ana@example.com', form);
  lists.confirm(tokenIn(sent[0]!.body));
  lists.unsubscribe(tokenIn(lists.unsubscribeHeaders('news', 'ana@example.com')['List-Unsubscribe']!));
  const rep = await lists.importRows('news', [row('ana@example.com', { consentedAt: T0 })], { confirm: 'accept-evidence' });
  assert.deepEqual(rep.rows.map((r) => r.verdict), ['previously-unsubscribed']);
  assert.equal(lists.get('news', 'ana@example.com')?.state, 'unsubscribed');
});

test('import with accept-evidence subscribes directly and records consent; dry run changes nothing; topics and limits apply', async () => {
  const { lists, consents, sent } = rig();
  const dry = await lists.importRows('news', [row('a@example.com'), row('b@example.com')], { dryRun: true });
  assert.deepEqual(dry.rows.map((r) => r.verdict), ['would-add', 'would-add']);
  assert.equal(dry.dryRun, true);
  assert.equal(lists.get('news', 'a@example.com'), undefined);
  assert.equal(sent.length, 0);
  const rep = await lists.importRows('news', [row('a@example.com', { topics: ['events'], ip: '9.9.9.9' }), row('b@example.com')], { confirm: 'accept-evidence' });
  assert.deepEqual(rep.counts, { added: 2 });
  assert.deepEqual(lists.get('news', 'a@example.com')?.topics, { product: false, events: true });
  assert.deepEqual(lists.get('news', 'b@example.com')?.topics, { product: true, events: false });
  assert.equal(lists.get('news', 'a@example.com')?.evidence[0]?.ip, '9.9.9.9');
  assert.deepEqual(consents.map((c) => [c.given, c.how]), [[true, 'import'], [true, 'import']]);
  assert.deepEqual(lists.recipients('news'), ['a@example.com', 'b@example.com']);
  const small = rig({ maxSubscribersPerList: 1 });
  const r2 = await small.lists.importRows('news', [row('a@example.com'), row('b@example.com')], { confirm: 'accept-evidence' });
  assert.deepEqual(r2.rows.map((r) => r.verdict), ['added', 'over-limit']);
  await assert.rejects(() => lists.importRows('news', [row('a@x.com'), row('b@x.com')], { maxRows: 1 }), /limited to 1 rows/);
  const single = rig({}, false);
  assert.deepEqual((await single.lists.importRows('news', [row('s@example.com')])).counts, { added: 1 }, 'a single opt-in list accepts the evidence by default');
});

test('CSV in: quotes, embedded commas and line breaks, BOM, blank lines; hostile CSV is refused', async () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n\n"multi\nline",z'), [['a', 'b'], ['x, y', 'say "hi"'], ['multi\nline', 'z']]);
  assert.deepEqual(parseCsv('﻿email\na@b.co'), [['email'], ['a@b.co']]);
  assert.deepEqual(parseCsv(''), []);
  assert.throws(() => parseCsv('a,"unterminated'), /ends inside a quoted cell/);
  assert.throws(() => parseCsv('a,b"c'), /quote in the middle/);
  assert.throws(() => parseCsv('1\n2\n3\n4', { maxRows: 3 }), /more than 3 rows/);
  assert.throws(() => parseCsv('x'.repeat(20), { maxBytes: 10 }), /too large/);
  const rows = SubscriberLists.rowsFromCsv('Email,Consented_At,Consent_Source,Topics\nana@example.com,2026-03-01T10:00:00Z,web form,product;events\n,,,\n');
  assert.deepEqual(rows[0], { email: 'ana@example.com', consentedAt: '2026-03-01T10:00:00Z', consentSource: 'web form', consentText: undefined, ip: undefined, topics: ['product', 'events'] });
  assert.equal(rows[1]!.email, '');
  assert.throws(() => SubscriberLists.rowsFromCsv('name\nx'), /"email" column/);
  const { lists } = rig();
  const rep = await lists.importRows('news', rows, { confirm: 'accept-evidence' });
  assert.deepEqual(rep.rows.map((r) => r.verdict), ['added', 'invalid']);
});

test('CSV out: formulas are neutralised, quoting is right, and the file doubles as a consent register', async () => {
  assert.equal(csvCell('=HYPERLINK("http://evil")'), `"'=HYPERLINK(""http://evil"")"`);
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('-2'), "'-2");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('\tx'), "'\tx");
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('plain'), 'plain');
  const { lists } = rig({}, false);
  await lists.subscribe('news', 'ana@example.com', { source: '=cmd|calc', ip: '203.0.113.7' });
  const csv = lists.exportCsv('news');
  assert.equal(csv, `email,state,consented_at,source,consent_version,ip\r\nana@example.com,subscribed,2026-06-01T09:00:00.000Z,'=cmd|calc,1,203.0.113.7\r\n`);
});

test('construction and list setup refuse unsafe settings', () => {
  const base = { secret: 'test-secret-01234', now: () => T0, send: async () => {}, confirmUrl: 'https://e.org/c', unsubscribeUrl: 'https://e.org/u', preferencesUrl: 'https://e.org/p' };
  assert.throws(() => new SubscriberLists({ ...base, secret: 'short' }), /at least 16/);
  assert.throws(() => new SubscriberLists({ ...base, confirmUrl: 'http://e.org/c' }), /https/);
  assert.throws(() => new SubscriberLists({ ...base, unsubscribeUrl: 'not a url' }), /not a URL/);
  assert.throws(() => new SubscriberLists({ ...base, preferencesUrl: 'https://e.org/p#frag' }), /fragment/);
  assert.doesNotThrow(() => new SubscriberLists({ ...base, confirmUrl: 'http://localhost/c', allowInsecureLinks: true }));
  const { lists } = rig();
  assert.throws(() => lists.createList({ id: 'news', name: 'x', consentText: 'y' }), /already exists/);
  assert.throws(() => lists.createList({ id: 'Bad Id', name: 'x', consentText: 'y' }), /list id/);
  assert.throws(() => lists.createList({ id: 'ok', name: '', consentText: 'y' }), /needs a name/);
  assert.throws(() => lists.createList({ id: 'ok', name: 'x', consentText: 'y', topics: [{ id: 'a', name: 'A', defaultOn: true }, { id: 'a', name: 'B', defaultOn: false }] }), /repeated topic/);
  assert.throws(() => lists.get('missing', 'a@example.com'), /no list/);
  assert.throws(() => lists.history('news', 'nobody@example.com'), /no such subscriber/);
});
