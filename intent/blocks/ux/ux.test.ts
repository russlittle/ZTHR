import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { Progress, canonicalJson, comfortCss, magicPaste, meOrDown, openView, preview, shareView, smartDefault, snoozeUntil, why } from './index.ts';

const NY = 'America/New_York';
const iso = (d: Date) => d.toISOString().slice(0, 16);

test('snooze lands where people mean, in their own zone', () => {
  const thu2pm = new Date('2026-11-26T19:00:00Z');
  assert.equal(iso(snoozeUntil('tomorrow morning', thu2pm, NY)), '2026-11-27T14:00');
  assert.equal(iso(snoozeUntil('later today', thu2pm, NY)), '2026-11-26T22:00');
  assert.equal(iso(snoozeUntil('tonight', thu2pm, NY)), '2026-11-27T00:00');
  assert.equal(iso(snoozeUntil('this weekend', thu2pm, NY)), '2026-11-28T14:00');
  assert.equal(iso(snoozeUntil('next week', thu2pm, NY)), '2026-11-30T14:00');
  assert.equal(iso(snoozeUntil('next week', new Date('2026-11-30T15:00:00Z'), NY)), '2026-12-07T14:00', 'on a Monday, next week is the following Monday');
});

test('bulk edits are previewed exactly, with unchanged and refused records apart', () => {
  const files = [{ id: 'a', tag: 'draft', owner: 'ana' }, { id: 'b', tag: 'final', owner: 'ana' }, { id: 'c', tag: 'draft', owner: 'ben' }];
  const p = preview(files, () => ({ tag: 'final' }), (f) => f.owner === 'ana');
  assert.deepEqual(p, { changes: [{ id: 'a', field: 'tag', from: 'draft', to: 'final' }], unchanged: ['b'], refused: ['c'] });
});

test('shared views are tamper-evident; defaults are learned only from a clear habit', () => {
  const t = shareView({ folder: '/Plans', sort: 'modified', cols: ['name', 'size'] }, 's');
  assert.deepEqual(openView(t, 's'), { folder: '/Plans', sort: 'modified', cols: ['name', 'size'] });
  assert.equal(openView(t.replace(/^./, 'x'), 's'), undefined);
  assert.equal(openView(t, 'other'), undefined);
  assert.equal(smartDefault(['pdf', 'pdf', 'docx', 'pdf']), 'pdf');
  assert.equal(smartDefault(['pdf', 'docx']), undefined, 'not enough to go on');
});

test('magic paste recognises tables, address lists and links', () => {
  const table = magicPaste('Name\tEmail\nAna\tana@x.org\nBen\tben@x.org');
  assert.equal(table.kind, 'table');
  assert.equal(table.kind === 'table' && table.rows.length, 3);
  const emails = magicPaste('Ana <ana@x.org>, BEN@x.org; ben@x.org cy@x');
  assert.deepEqual(emails, { kind: 'emails', emails: ['ana@x.org', 'ben@x.org'], rejected: ['Ana', 'cy@x'] });
  assert.deepEqual(magicPaste('  https://files.example.org/s/abc  '), { kind: 'url', url: 'https://files.example.org/s/abc' });
  assert.equal(magicPaste('just a note, nothing more').kind, 'text');
});

test('progress waits for enough to go on, then gives a steady time left', () => {
  const p = new Progress(1000, 0);
  assert.equal(p.update(5, 1000).text, '0%, working out the time left');
  p.update(100, 4000);
  const r = p.update(200, 8000);
  assert.equal(r.percent, 20);
  assert.ok(r.leftSeconds! > 20 && r.leftSeconds! < 40, String(r.leftSeconds));
  assert.equal(r.text, '20%, about 30 seconds left');
  assert.equal(p.update(1000, 9000).text, 'Done');
});

test('reading comfort, why am I seeing this, and is it me or is it down', () => {
  const css = comfortCss({ size: 'larger', spacing: 'relaxed', font: 'readable', motion: 'reduced', contrast: 'default' });
  assert.match(css, /--text-scale:1\.25;--line-height:1\.8/);
  assert.match(css, /animation-duration:0\.01ms/);
  assert.equal(why([{ kind: 'shared', by: 'Ana' }, { kind: 'role', role: 'editor' }, { kind: 'flag', flag: 'new uploads', because: '10% rollout' }]), 'You are seeing this because Ana shared it with you, you are an editor and you are in the early group for new uploads (10% rollout).');
  assert.equal(why([]), 'Everyone sees this.');
  assert.equal(meOrDown({ service: 'ok', internet: false }).who, 'you');
  assert.match(meOrDown({ service: 'down', internet: true, incident: 'uploads failing' }).say, /^It is us, not you: uploads failing/);
  assert.equal(meOrDown({ service: 'unreachable', internet: true }).who, 'you');
  assert.equal(meOrDown({ service: 'ok', internet: true }).who, 'nobody');
});

test('a preview compares values canonically: the same keys in another order are not a change', () => {
  const records = [
    { id: 'a', share: { role: 'viewer', with: 'ana' } as Record<string, unknown> },
    { id: 'b', share: { role: 'viewer', with: 'ben' } as Record<string, unknown> },
  ];
  const p = preview(records, (r) => ({ share: { with: r.share.with, role: 'viewer' } }));
  assert.deepEqual(p, { changes: [], unchanged: ['a', 'b'], refused: [] });
  const nested = preview([{ id: 'c', meta: { a: { x: 1, y: [1, 2] }, b: 2 } as unknown }], () => ({ meta: { b: 2, a: { y: [1, 2], x: 1 } } }));
  assert.deepEqual(nested.unchanged, ['c']);
  const real = preview([{ id: 'd', meta: { a: [1, 2] } as unknown }], () => ({ meta: { a: [2, 1] } }));
  assert.equal(real.changes.length, 1, 'array order still matters');
  assert.equal(canonicalJson({ at: new Date('2026-11-26T00:00:00Z') }), '{"at":"2026-11-26T00:00:00.000Z"}');
  assert.deepEqual(smartDefault([{ sort: 'name', desc: true }, { desc: true, sort: 'name' }, { sort: 'name', desc: true }]), { sort: 'name', desc: true });
});

// Thursday 26 November 2026 in New York is UTC-5; `local` builds an instant from a wall clock there.
const local = (day: number, h: number, min = 0) => new Date(Date.UTC(2026, 10, day, h + 5, min));

test('"later today" is three hours on until mid-afternoon, then this evening, then tomorrow morning', () => {
  assert.equal(iso(snoozeUntil('later today', local(26, 14, 59), NY)), iso(local(26, 17, 59)), 'before 15:00: three hours on');
  assert.equal(iso(snoozeUntil('later today', local(26, 15), NY)), iso(local(26, 19)), 'at 15:00: this evening');
  assert.equal(iso(snoozeUntil('later today', local(26, 18, 59), NY)), iso(local(26, 19)));
  assert.equal(iso(snoozeUntil('later today', local(26, 19), NY)), iso(local(27, 9)), 'at 19:00 sharp the evening has come: tomorrow morning');
  assert.equal(iso(snoozeUntil('later today', local(26, 20), NY)), iso(local(27, 9)));
});

test('"tonight" is 19:00 today until 19:00 has come, then 19:00 tomorrow', () => {
  assert.equal(iso(snoozeUntil('tonight', local(26, 8), NY)), iso(local(26, 19)));
  assert.equal(iso(snoozeUntil('tonight', local(26, 18, 59), NY)), iso(local(26, 19)));
  assert.equal(iso(snoozeUntil('tonight', local(26, 19), NY)), iso(local(27, 19)));
  assert.equal(iso(snoozeUntil('tonight', local(26, 23), NY)), iso(local(27, 19)));
});

test('"this weekend" is the coming Saturday 9:00; on a Saturday or Sunday, the Saturday after', () => {
  assert.equal(iso(snoozeUntil('this weekend', local(27, 12), NY)), iso(local(28, 9)), 'Friday');
  assert.equal(iso(snoozeUntil('this weekend', local(30, 12), NY)), iso(local(35, 9)), 'Monday');
  assert.equal(iso(snoozeUntil('this weekend', local(28, 12), NY)), iso(local(35, 9)), 'on Saturday itself: next Saturday');
  assert.equal(iso(snoozeUntil('this weekend', local(29, 12), NY)), iso(local(35, 9)), 'on Sunday: the Saturday ahead');
});

test('"next week" is the coming Monday 9:00, also from a Sunday and a Saturday', () => {
  assert.equal(iso(snoozeUntil('next week', local(29, 12), NY)), iso(local(30, 9)), 'Sunday: tomorrow');
  assert.equal(iso(snoozeUntil('next week', local(28, 12), NY)), iso(local(30, 9)), 'Saturday');
  assert.equal(iso(snoozeUntil('next week', local(27, 12), NY)), iso(local(30, 9)), 'Friday');
});

test('a preview with no rule about who may be edited edits everyone', () => {
  const p = preview([{ id: 'a', n: 1 }, { id: 'b', n: 2 }], () => ({ n: 2 }));
  assert.deepEqual(p, { changes: [{ id: 'a', field: 'n', from: 1, to: 2 }], unchanged: ['b'], refused: [] });
});

test('a shared view that is malformed, unsigned, mis-signed or signed but not JSON is not opened', () => {
  const t = shareView({ a: 1 }, 's');
  const [p, sig] = t.split('.');
  assert.equal(openView('nodot', 's'), undefined, 'no signature at all');
  assert.equal(openView(`${p}.`, 's'), undefined, 'an empty signature');
  assert.equal(openView(`.${sig}`, 's'), undefined, 'no payload');
  assert.equal(openView(`${p}.${sig!.slice(0, 8)}`, 's'), undefined, 'a signature of the wrong length does not throw');
  assert.equal(openView(`${p}.${sig}extra`, 's'), undefined);
  assert.equal(openView(`${p}.${sig!.slice(0, 15)}x`, 's'), undefined, 'right length, wrong signature');
  const junk = Buffer.from('{not json').toString('base64url');
  const signed = createHmac('sha256', 's').update(junk).digest('base64url').slice(0, 16);
  assert.equal(openView(`${junk}.${signed}`, 's'), undefined, 'a payload that is signed but not JSON');
  assert.equal(sig!.length, 16);
});

test('a default is learned from the recent window only, and a tie goes to the most recent choice', () => {
  assert.equal(smartDefault(['old', 'old', 'old', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']), undefined, 'only the last ten count by default');
  assert.equal(smartDefault(['a', 'a', 'a', 'b', 'b'], { window: 2 }), undefined, 'a window of two sees only b, b');
  assert.equal(smartDefault(['a', 'a', 'a', 'b', 'b', 'b'], { window: 3 }), 'b');
  assert.equal(smartDefault(['a', 'a'], { min: 2 }), 'a', 'min is configurable');
  assert.equal(smartDefault(['a', 'a'], { min: 3 }), undefined);
  assert.equal(smartDefault([]), undefined);
  assert.equal(smartDefault(['b', 'a', 'a', 'a']), 'a', 'the most chosen, wherever it first appeared');
  assert.equal(smartDefault(['a', 'a', 'a', 'b', 'b']), 'a', 'more choices beat a more recent one');
  assert.equal(smartDefault(['a', 'b', 'a', 'b', 'a', 'b']), 'b', 'tied: the one chosen last');
  assert.equal(smartDefault(['b', 'a', 'b', 'a', 'b', 'a']), 'a', 'tied the other way round');
  assert.equal(smartDefault(['a', 'b', 'c', 'b', 'c', 'a', 'a', 'b', 'c']), 'c', 'three-way tie');
});

test('magic paste: only a whole http(s) link is a link', () => {
  assert.deepEqual(magicPaste('http://files.example.org'), { kind: 'url', url: 'http://files.example.org/' });
  assert.deepEqual(magicPaste('HTTPS://Files.Example.org/a?b=1'), { kind: 'url', url: 'https://files.example.org/a?b=1' });
  assert.equal(magicPaste('ftp://files.example.org/x').kind, 'text');
  assert.equal(magicPaste('xhttps://files.example.org').kind, 'text', 'a link must start the text');
  assert.equal(magicPaste('https://files.example.org/a b').kind, 'text', 'a link has no spaces in it');
  assert.equal(magicPaste('https://[broken').kind, 'text', 'looks like a link but is not one');
});

test('magic paste: a table is two or more lines with the same number of columns, by tab or by comma', () => {
  assert.deepEqual(magicPaste('a,b\nc,d'), { kind: 'table', rows: [['a', 'b'], ['c', 'd']] }, 'two lines are enough, and commas do');
  assert.deepEqual(magicPaste('a\tb\r\nc\td'), { kind: 'table', rows: [['a', 'b'], ['c', 'd']] });
  assert.deepEqual(magicPaste('a\tb\n\nc\td'), { kind: 'table', rows: [['a', 'b'], ['c', 'd']] }, 'a blank line is skipped');
  assert.deepEqual(magicPaste('a\tb\n   \nc\td'), { kind: 'table', rows: [['a', 'b'], ['c', 'd']] }, 'so is a line of spaces');
  assert.equal(magicPaste('a,b').kind, 'text', 'one line is not a table');
  assert.equal(magicPaste('a,b\nc,d,e').kind, 'text', 'ragged rows are not a table');
  assert.equal(magicPaste('a,b,c\nd,e').kind, 'text', 'ragged the other way');
  assert.equal(magicPaste('a,b\nc d').kind, 'text', 'a line without the separator is not a row');
  assert.equal(magicPaste('x,"y\nz\nw",q').kind, 'text', 'every line must hold the separator, even where a quote carries a field over');
  assert.equal(magicPaste('"a,b"\n"c,d"').kind, 'text', 'a single column is not a table');
  const emails = magicPaste('ana@x.org,ben@x.org\ncy@x.org,dee@x.org');
  assert.equal(emails.kind, 'emails', 'a grid of nothing but addresses is a list of addresses');
  assert.deepEqual(emails.kind === 'emails' && emails.emails, ['ana@x.org', 'ben@x.org', 'cy@x.org', 'dee@x.org']);
  assert.equal(magicPaste('name,email\nana,ana@x.org').kind, 'table', 'a table with some addresses is still a table');
});

test('magic paste: addresses are found whole, cleaned of angle brackets, and need to be most of what was pasted', () => {
  assert.deepEqual(magicPaste('ana@x.org'), { kind: 'emails', emails: ['ana@x.org'], rejected: [] }, 'one address is enough');
  assert.deepEqual(magicPaste('ana@x.org,  ben@mail.org'), { kind: 'emails', emails: ['ana@x.org', 'ben@mail.org'], rejected: [] }, 'a comma and a space make one break');
  assert.deepEqual(magicPaste(',ana@x.org,'), { kind: 'emails', emails: ['ana@x.org'], rejected: [] }, 'no empty pieces at the ends');
  assert.deepEqual(magicPaste('<ana@x.org>'), { kind: 'emails', emails: ['ana@x.org'], rejected: [] });
  assert.deepEqual(magicPaste('a<b@x.org'), { kind: 'emails', emails: ['a<b@x.org'], rejected: [] }, 'only the ends are trimmed of brackets');
  assert.deepEqual(magicPaste('a>b@x.org'), { kind: 'emails', emails: ['a>b@x.org'], rejected: [] });
  const withBad = (bad: string) => magicPaste(`ana@x.org cy@x.org ${bad}`);
  const rejects = (bad: string) => ({ kind: 'emails', emails: ['ana@x.org', 'cy@x.org'], rejected: [bad] });
  assert.deepEqual(withBad('a@b@c.org'), rejects('a@b@c.org'), 'one @ only');
  assert.deepEqual(withBad('ben@x.org1'), rejects('ben@x.org1'), 'ends in letters');
  assert.deepEqual(withBad('ben@.org'), rejects('ben@.org'), 'a domain needs a name');
  assert.deepEqual(withBad('ben@x.o'), rejects('ben@x.o'), 'and at least two letters at the end');
  assert.deepEqual(withBad('ben@xorg'), rejects('ben@xorg'), 'and a dot');
  assert.deepEqual(magicPaste('ana@mail.example.org'), { kind: 'emails', emails: ['ana@mail.example.org'], rejected: [] }, 'a long domain');
  assert.deepEqual(magicPaste('one@x.org two@x.org three@x.org four oh'), { kind: 'emails', emails: ['one@x.org', 'two@x.org', 'three@x.org'], rejected: ['four', 'oh'] }, 'three of five is enough');
  assert.deepEqual(magicPaste('one@x.org two@x.org three words here'), { kind: 'text', text: 'one@x.org two@x.org three words here' }, 'two of five is not');
  assert.deepEqual(magicPaste('please mail ana@x.org today'), { kind: 'text', text: 'please mail ana@x.org today' });
  assert.deepEqual(magicPaste(''), { kind: 'text', text: '' }, 'nothing is text');
  assert.deepEqual(magicPaste('   '), { kind: 'text', text: '' });
  assert.deepEqual(magicPaste('  hello there  '), { kind: 'text', text: 'hello there' });
});

test('progress: no time left until a rate exists, three seconds have passed, and two percent is done', () => {
  const first = new Progress(1000, 0).update(500, 5000);
  assert.deepEqual(first, { percent: 50, text: '50%, working out the time left' }, 'a first reading gives no rate, however far along');
  const late = new Progress(1000, 10_000);
  late.update(100, 10_900);
  assert.equal(late.update(200, 11_800).text, '20%, working out the time left', 'under three seconds since the start');
  const edge = new Progress(1000, 10_000);
  edge.update(100, 11_000);
  assert.equal(edge.update(200, 12_999).text, '20%, working out the time left', 'one millisecond short of three seconds');
  assert.equal(edge.update(300, 13_000).text, '30%, a few seconds left', 'at three seconds sharp the estimate begins');
  const few = new Progress(1000, 0);
  few.update(10, 1000);
  assert.equal(few.update(15, 4000).text, '1%, working out the time left', 'under two percent done');
  assert.equal(few.update(20, 7000).text.startsWith('2%, about'), true, 'exactly two percent is enough');
});

test('progress: the time left is worded as a few seconds, tens of seconds or minutes', () => {
  const at = (total: number, done: number, atMs: number) => {
    const p = new Progress(total, 0);
    p.update(0, 0);
    return p.update(done, atMs);
  };
  assert.deepEqual(at(2000, 1000, 5000), { percent: 50, leftSeconds: 5, text: '50%, a few seconds left' }, 'under ten seconds');
  assert.deepEqual(at(2000, 1000, 10_000), { percent: 50, leftSeconds: 10, text: '50%, about 10 seconds left' }, 'at ten seconds it is no longer "a few"');
  assert.equal(at(9400, 500, 5000).text, '5%, about 90 seconds left', 'just under 90 seconds it is still seconds');
  assert.equal(at(9500, 500, 5000).text, '5%, about 2 minutes left', 'at 90 seconds it is minutes, rounded');
  assert.equal(at(1000, 20, 4000).leftSeconds, 196);
  assert.equal(at(1000, 20, 4000).text, '2%, about 3 minutes left');
  assert.equal(at(3000, 1000, 10_000).text, '33%, about 20 seconds left', 'tens of seconds are rounded to the nearest ten');
  assert.equal(at(1000, 1000, 10_000).text, 'Done');
  assert.equal(at(1000, 1500, 10_000).percent, 100);
});

test('progress: the rate is smoothed, and a reading at the same moment or earlier does not disturb it', () => {
  const p = new Progress(1000, 0);
  p.update(100, 4000);
  p.update(200, 8000);
  assert.equal(p.update(300, 10_000).text, '30%, about 20 seconds left', 'a faster spell is blended in, not taken whole: 22 s, not 14 s');
  const q = new Progress(1000, 0);
  q.update(100, 4000);
  q.update(200, 8000);
  assert.equal(q.update(250, 8000).text, '25%, about 30 seconds left', 'two readings at one moment give no new rate');
  assert.equal(q.update(260, 7000).text, '26%, about 30 seconds left', 'nor does one from the past');
});

test('reading comfort is exact: each setting adds its own CSS and nothing else', () => {
  assert.equal(comfortCss({ size: 'default', spacing: 'default', font: 'default', motion: 'default', contrast: 'default' }), ':root{--text-scale:1;--line-height:1.5;--letter-spacing:normal}');
  assert.equal(comfortCss({ size: 'large', spacing: 'default', font: 'default', motion: 'default', contrast: 'default' }), ':root{--text-scale:1.125;--line-height:1.5;--letter-spacing:normal}');
  assert.equal(comfortCss({ size: 'default', spacing: 'relaxed', font: 'default', motion: 'default', contrast: 'default' }), ':root{--text-scale:1;--line-height:1.8;--letter-spacing:0.02em}');
  assert.equal(comfortCss({ size: 'default', spacing: 'default', font: 'readable', motion: 'default', contrast: 'default' }), ':root{--text-scale:1;--line-height:1.5;--letter-spacing:normal;--font-body:Atkinson Hyperlegible, Verdana, sans-serif}');
  assert.equal(comfortCss({ size: 'default', spacing: 'default', font: 'default', motion: 'default', contrast: 'more' }), ':root{--text-scale:1;--line-height:1.5;--letter-spacing:normal;--text-muted:var(--text);--border:var(--text)}');
  assert.equal(comfortCss({ size: 'default', spacing: 'default', font: 'default', motion: 'reduced', contrast: 'default' }), ':root{--text-scale:1;--line-height:1.5;--letter-spacing:normal}*,*::before,*::after{animation-duration:0.01ms!important;transition-duration:0.01ms!important;scroll-behavior:auto!important}');
  assert.equal(
    comfortCss({ size: 'larger', spacing: 'relaxed', font: 'readable', motion: 'reduced', contrast: 'more' }),
    ':root{--text-scale:1.25;--line-height:1.8;--letter-spacing:0.02em;--font-body:Atkinson Hyperlegible, Verdana, sans-serif;--text-muted:var(--text);--border:var(--text)}*,*::before,*::after{animation-duration:0.01ms!important;transition-duration:0.01ms!important;scroll-behavior:auto!important}',
  );
});

test('why: each reason in its own words, "a" or "an" by the sound of the role, and a list that reads as a sentence', () => {
  assert.equal(why([{ kind: 'shared', by: 'Ana' }]), 'You are seeing this because Ana shared it with you.');
  assert.equal(why([{ kind: 'role', role: 'viewer' }]), 'You are seeing this because you are a viewer.');
  assert.equal(why([{ kind: 'role', role: 'owner' }]), 'You are seeing this because you are an owner.');
  assert.equal(why([{ kind: 'role', role: 'Admin' }]), 'You are seeing this because you are an Admin.');
  assert.equal(why([{ kind: 'role', role: 'doctor' }]), 'You are seeing this because you are a doctor.', 'only a first vowel makes it "an"');
  assert.equal(why([{ kind: 'flag', flag: 'dark mode', because: 'beta' }]), 'You are seeing this because you are in the early group for dark mode (beta).');
  assert.equal(why([{ kind: 'follows', what: 'Plans' }]), 'You are seeing this because you follow Plans.');
  assert.equal(why([{ kind: 'recent' }]), 'You are seeing this because you opened it recently.');
  assert.equal(why([{ kind: 'mentioned', by: 'Ben' }]), 'You are seeing this because Ben mentioned you.');
  assert.equal(why([{ kind: 'recent' }, { kind: 'mentioned', by: 'Ben' }]), 'You are seeing this because you opened it recently and Ben mentioned you.');
  assert.equal(why([{ kind: 'follows', what: 'Plans' }, { kind: 'recent' }, { kind: 'mentioned', by: 'Ben' }]), 'You are seeing this because you follow Plans, you opened it recently and Ben mentioned you.');
});

test('is it me or is it down: who, and the words to say it', () => {
  const offline = 'Your device seems to be offline. Check your Wi-Fi or network; your changes are kept and will be sent when you are back.';
  assert.deepEqual(meOrDown({ service: 'ok', internet: false }), { who: 'you', say: offline });
  assert.deepEqual(meOrDown({ service: 'down', internet: false, incident: 'x' }), { who: 'you', say: offline }, 'no connection comes first');
  const doing = 'We are working on it; you do not need to do anything.';
  assert.deepEqual(meOrDown({ service: 'down', internet: true }), { who: 'us', say: `It is us, not you. ${doing}` });
  assert.deepEqual(meOrDown({ service: 'degraded', internet: true }), { who: 'us', say: `It is us, not you. ${doing}` });
  assert.deepEqual(meOrDown({ service: 'degraded', internet: true, incident: 'slow search' }), { who: 'us', say: `It is us, not you: slow search. ${doing}` });
  assert.deepEqual(meOrDown({ service: 'unreachable', internet: true }), { who: 'you', say: 'Your internet works, but our service cannot be reached from your network. A firewall or VPN may be blocking it.' });
  assert.deepEqual(meOrDown({ service: 'ok', internet: true }), { who: 'nobody', say: 'Everything looks fine on our side and yours. Try reloading the page; if it still fails, report the problem and we will look.' });
});
