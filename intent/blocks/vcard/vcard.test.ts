import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VCardError, build, convert, hasMember, merge, parse, view, write } from './index.ts';
import type { Card } from './index.ts';

const BS = String.fromCharCode(92);
// A 1x1 PNG and a 1x1 GIF, as the bytes a phone would attach.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const V3 = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Ana María Okafor',
  'N:Okafor;Ana;María;Dr.;PhD',
  'NICKNAME:Anita,Ana-M',
  'ORG:Acme\\, Inc.;Research;Lab 2',
  'TITLE:Chief of Things',
  'item1.TEL;TYPE=WORK,VOICE,pref:+1 (937) 555-0100',
  'item1.X-ABLabel:main line',
  'TEL;TYPE=CELL:937-555-0142',
  'EMAIL;TYPE=INTERNET,HOME:ana@example.org',
  'ADR;TYPE=WORK:;;1 Main St' + BS + '; Suite 4;Dayton;OH;45402;USA',
  'BDAY:1980-02-29',
  'CATEGORIES:friends,work\\, other',
  'NOTE:Line one' + BS + 'nLine two' + BS + ', with a comma' + BS + '; and a semicolon',
  'X-CUSTOM-THING;FOO=bar:kept as is',
  'UID:urn:uuid:11111111-2222-3333-4444-555555555555',
  'REV:20260101T000000Z',
  'END:VCARD',
].join('\r\n');

test('a 3.0 card parses to typed fields, including groups, escapes and structured values', () => {
  const [card] = parse(V3);
  const c = view(card!);
  assert.equal(c.fn, 'Ana María Okafor');
  assert.deepEqual(c.name, { family: 'Okafor', given: 'Ana', additional: 'María', prefix: 'Dr.', suffix: 'PhD' });
  assert.deepEqual(c.nicknames, ['Anita', 'Ana-M']);
  assert.deepEqual(c.org, { name: 'Acme, Inc.', units: ['Research', 'Lab 2'] });
  assert.equal(c.phones.length, 2);
  assert.deepEqual(c.phones[0], { value: '+1 (937) 555-0100', types: ['work', 'voice'], pref: true, label: 'main line' });
  assert.deepEqual(c.emails[0], { value: 'ana@example.org', types: ['internet', 'home'], pref: false });
  assert.deepEqual(c.addresses[0], { pobox: '', extended: '', street: '1 Main St; Suite 4', locality: 'Dayton', region: 'OH', postal: '45402', country: 'USA', types: ['work'], pref: false });
  assert.deepEqual(c.categories, ['friends', 'work, other']);
  assert.equal(c.note, 'Line one\nLine two, with a comma; and a semicolon');
  assert.equal(c.birthday, '1980-02-29');
  assert.equal(c.kind, 'individual');
  assert.equal(c.uid, 'urn:uuid:11111111-2222-3333-4444-555555555555');
});

test('write then parse gives back the same card; unknown properties and groups survive untouched', () => {
  const [card] = parse(V3);
  const text = write(card!);
  const [again] = parse(text);
  assert.deepEqual(again, card);
  assert.match(text, /^BEGIN:VCARD\r\nVERSION:3\.0\r\n/);
  assert.match(text, /\r\nX-CUSTOM-THING;FOO=bar:kept as is\r\n/);
  assert.match(text, /\r\nitem1\.TEL;TYPE=work,voice,pref:\+1 \(937\) 555-0100\r\n/);
  assert.match(text, /\r\nitem1\.X-ABLABEL:main line\r\n/);
  assert.match(text, /\r\nORG:Acme\\, Inc\.;Research;Lab 2\r\n/);
  assert.match(text, new RegExp('\\r\\nNOTE:Line one\\\\nLine two\\\\, with a comma\\\\; and a semicolon\\r\\n'));
  assert.match(text, /END:VCARD\r\n$/);
});

test('long lines fold at 75 octets without cutting a UTF-8 character, and unfold on reading', () => {
  const note = `${'é'.repeat(40)} ${'日本語'.repeat(30)} end`;
  const card: Card = { version: '4.0', props: [{ name: 'FN', params: {}, value: 'X' }, { name: 'NOTE', params: {}, value: note }] };
  const text = write(card);
  for (const line of text.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `line is ${Buffer.byteLength(line)} octets`);
  assert.ok(text.includes('\r\n '), 'folded');
  assert.equal(view(parse(text)[0]!).note, note);
  const lf = text.replace(/\r\n/g, '\n');
  assert.equal(view(parse(lf)[0]!).note, note, 'bare LF is accepted');
});

test('a 4.0 card with PREF, KIND and MEMBER, and several cards in one file', () => {
  const text = [
    'BEGIN:VCARD', 'VERSION:4.0', 'KIND:group', 'FN:Book club', 'MEMBER:urn:uuid:aaaa', 'MEMBER:mailto:bo@example.org', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:4.0', 'FN:Bo', 'EMAIL;PREF=1;TYPE=work:bo@example.org', 'EMAIL;PREF=2:bo@home.example', 'TEL;VALUE=uri:tel:+19375550111', 'END:VCARD',
  ].join('\r\n');
  const [g, p] = parse(text);
  const grp = view(g!);
  assert.equal(grp.kind, 'group');
  assert.deepEqual(grp.members, ['urn:uuid:aaaa', 'mailto:bo@example.org']);
  assert.equal(hasMember(g!, 'urn:uuid:aaaa'), true);
  assert.equal(hasMember(g!, 'urn:uuid:zzzz'), false);
  const bo = view(p!);
  assert.deepEqual(bo.emails.map((e) => e.pref), [true, false]);
  assert.equal(bo.phones[0]!.value, '+19375550111', 'tel: is dropped from the value');
  assert.equal(parse(text).length, 2);
});

test('phones normalise to E.164 when asked and are kept as written when they cannot be', () => {
  const [card] = parse(V3);
  const c = view(card!, { phoneCountry: 'US' });
  assert.deepEqual(c.phones.map((p) => p.value), ['+19375550100', '+19375550142']);
  const odd = parse('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:X\r\nTEL:call the office\r\nEND:VCARD');
  assert.equal(view(odd[0]!, { phoneCountry: 'US' }).phones[0]!.value, 'call the office');
});

test('3.0 to 4.0 and back: types, preference, photo encoding and group markers are rewritten', () => {
  const text = [
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:Cy', 'TEL;TYPE=CELL,pref:555-0100', 'EMAIL;TYPE=INTERNET:cy@example.org',
    'X-ADDRESSBOOKSERVER-KIND:group', 'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:1', `PHOTO;ENCODING=b;TYPE=PNG:${PNG.toString('base64')}`, 'X-KEEP:me', 'END:VCARD',
  ].join('\r\n');
  const v3 = parse(text)[0]!;
  const v4 = convert(v3, '4.0');
  assert.equal(v4.version, '4.0');
  const w = write(v4);
  assert.match(w, /\r\nTEL;PREF=1;TYPE=cell:555-0100\r\n/);
  assert.match(w, /\r\nKIND:group\r\n/);
  assert.match(w, /\r\nMEMBER:urn:uuid:1\r\n/);
  assert.match(w, /\r\nPHOTO:data:image\/png;base64,/);
  assert.match(w, /\r\nX-KEEP:me\r\n/);
  assert.doesNotMatch(w, /X-ADDRESSBOOKSERVER/);
  assert.deepEqual(view(v4).photo!.bytes, PNG);
  const back = convert(parse(w)[0]!, '3.0');
  const bw = write(back);
  assert.match(bw, /\r\nTEL;TYPE=cell,pref:555-0100\r\n/);
  assert.match(bw, /\r\nX-ADDRESSBOOKSERVER-KIND:group\r\n/);
  assert.match(bw, /\r\nPHOTO;ENCODING=b;TYPE=PNG:/);
  assert.equal(convert(v4, '4.0'), v4, 'same version is returned as is');
});

test('build makes valid cards of either version and refuses what a card cannot hold', () => {
  const base = { kind: 'individual' as const, fn: 'Di Zhang', nicknames: [], emails: [{ value: 'di@example.org', types: ['work'], pref: true }], phones: [], addresses: [], urls: [{ value: 'https://example.org/di', types: [], pref: false }], categories: ['x'], members: [] };
  const v4 = write(build({ ...base, photo: { bytes: GIF } }, '4.0'));
  assert.match(v4, /\r\nEMAIL;PREF=1;TYPE=work:di@example\.org\r\n/);
  assert.match(v4, /\r\nPHOTO:data:image\/gif;base64,/);
  const v3 = write(build({ ...base, photo: { bytes: GIF } }, '3.0'));
  assert.match(v3, /\r\nEMAIL;TYPE=work,pref:di@example\.org\r\n/);
  assert.match(v3, /\r\nPHOTO;ENCODING=b;TYPE=GIF:/);
  assert.deepEqual(view(parse(v4)[0]!).photo!.bytes, GIF);
  assert.equal(view(parse(v3)[0]!).photo!.mediaType, 'image/gif');
  assert.throws(() => build({ ...base, fn: '' }), /needs a formatted name/);
  assert.throws(() => build({ ...base, photo: { bytes: Buffer.from('not an image') } }), /not a PNG, JPEG, GIF or WebP/);
  assert.throws(() => build({ ...base, photo: { uri: 'javascript:alert(1)' } }), /https or a data/);
  const g = write(build({ ...base, kind: 'group', members: ['urn:uuid:1'] }, '3.0'));
  assert.match(g, /X-ADDRESSBOOKSERVER-KIND:group/);
  assert.match(g, /X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:1/);
  assert.equal(view(parse(g)[0]!).kind, 'group');
});

test('photos: the bytes must be the image they claim, within the size limit, and links must be https', () => {
  const wrap = (photo: string) => parse(`BEGIN:VCARD\r\nVERSION:4.0\r\nFN:P\r\n${photo}\r\nEND:VCARD`)[0]!;
  assert.deepEqual(view(wrap(`PHOTO:data:image/png;base64,${PNG.toString('base64')}`)).photo, { mediaType: 'image/png', bytes: PNG });
  assert.throws(() => view(wrap(`PHOTO:data:image/jpeg;base64,${PNG.toString('base64')}`)), /says image\/jpeg but its bytes are image\/png/);
  assert.throws(() => view(wrap(`PHOTO:data:image/png;base64,${Buffer.from('<svg onload=alert(1)>').toString('base64')}`)), /not a PNG, JPEG, GIF or WebP/);
  assert.throws(() => view(wrap(`PHOTO:data:image/png;base64,${PNG.toString('base64')}`), { maxPhotoBytes: 10 }), /over the 10 byte limit/);
  assert.deepEqual(view(wrap('PHOTO:https://example.org/me.jpg')).photo, { uri: 'https://example.org/me.jpg' });
  assert.throws(() => view(wrap('PHOTO:http://example.org/me.jpg')), /https or a data/);
  assert.throws(() => view(wrap('PHOTO:file:///etc/passwd')), /https or a data/);
  assert.throws(() => view(wrap('PHOTO:data:image/png;base64')), /malformed/);
});

test('three-way merge: independent edits combine, set-valued fields merge, true clashes are reported', () => {
  const base = parse('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Ana\r\nTITLE:Engineer\r\nORG:Acme\r\nEMAIL:ana@a.example\r\nEMAIL:ana@b.example\r\nTEL:+19375550100\r\nX-NOTE-ID:7\r\nREV:20260101T000000Z\r\nEND:VCARD')[0]!;
  const ours = parse('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Ana\r\nTITLE:Staff Engineer\r\nORG:Acme\r\nEMAIL:ana@a.example\r\nEMAIL:ana@b.example\r\nEMAIL:ana@ours.example\r\nTEL:+19375550100\r\nX-NOTE-ID:7\r\nREV:20260102T000000Z\r\nEND:VCARD')[0]!;
  const theirs = parse('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Ana\r\nTITLE:Engineer\r\nORG:Acme Corp\r\nEMAIL:ana@a.example\r\nTEL:+19375550100\r\nTEL:+19375550199\r\nX-NOTE-ID:7\r\nX-NEW:added by them\r\nREV:20260103T000000Z\r\nEND:VCARD')[0]!;
  const r = merge(base, ours, theirs);
  assert.deepEqual(r.conflicts, []);
  const c = view(r.card);
  assert.equal(c.title, 'Staff Engineer', 'only we changed it');
  assert.equal(c.org!.name, 'Acme Corp', 'only they changed it');
  assert.deepEqual(c.emails.map((e) => e.value).sort(), ['ana@a.example', 'ana@ours.example'], 'they removed b, we added ours');
  assert.deepEqual(c.phones.map((e) => e.value).sort(), ['+19375550100', '+19375550199']);
  assert.equal(c.rev, '20260103T000000Z', 'the later revision wins');
  assert.ok(r.card.props.some((p) => p.name === 'X-NEW'), 'unknown properties merge too');
  assert.ok(r.card.props.some((p) => p.name === 'X-NOTE-ID'));
  const clash = merge(base, parse(write({ ...ours, props: ours.props.map((p) => (p.name === 'TITLE' ? { ...p, value: 'A' } : p)) }))[0]!, parse(write({ ...theirs, props: theirs.props.map((p) => (p.name === 'TITLE' ? { ...p, value: 'B' } : p)) }))[0]!);
  assert.deepEqual(clash.conflicts, ['TITLE']);
  assert.equal(view(clash.card).title, 'A', 'ours is kept on a clash');
  assert.throws(() => merge(base, ours, convert(theirs, '3.0')), /one version before merging/);
});

test('merge: emails match without regard to case, and removing on one side wins over keeping on the other', () => {
  const mk = (emails: string[]) => parse(`BEGIN:VCARD\r\nVERSION:4.0\r\nFN:A\r\n${emails.map((e) => `EMAIL:${e}`).join('\r\n')}\r\nEND:VCARD`)[0]!;
  const r = merge(mk(['A@X.example']), mk(['a@x.example', 'new@x.example']), mk([]));
  assert.deepEqual(view(r.card).emails.map((e) => e.value), ['new@x.example'], 'removed by them, so gone; added by us, so kept');
});

test('hostile and malformed input is refused with the line', () => {
  const bad = (t: string, re: RegExp) => assert.throws(() => parse(t), (e: Error) => e instanceof VCardError && re.test(e.message), t.slice(0, 40));
  bad('', /no vCard/);
  bad('BEGIN:VCARD\r\nFN:X\r\nEND:VCARD', /no VERSION/);
  bad('BEGIN:VCARD\r\nVERSION:2.1\r\nFN:X\r\nEND:VCARD', /version 2\.1 is not supported/);
  bad('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:X', /no END:VCARD/);
  bad('FN:X', /outside BEGIN:VCARD/);
  bad('BEGIN:VCARD\r\nVERSION:4.0\r\nBEGIN:VCARD\r\nEND:VCARD', /nested/);
  bad('BEGIN:VCALENDAR\r\nEND:VCALENDAR', /only VCARD/);
  bad('BEGIN:VCARD\r\nVERSION:4.0\r\nno colon here\r\nEND:VCARD', /line 3: there is no ":"/);
  bad('BEGIN:VCARD\r\nVERSION:4.0\r\nB@D NAME:x\r\nEND:VCARD', /not a valid property name/);
  bad('BEGIN:VCARD\r\nVERSION:4.0\r\nEND:VCARD\r\nEND:VCARD', /outside BEGIN/);
  assert.throws(() => parse('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:X\r\nEND:VCARD', { maxBytes: 10 }), /larger than 10 bytes/);
  const many = Array.from({ length: 5 }, () => 'BEGIN:VCARD\r\nVERSION:4.0\r\nFN:X\r\nEND:VCARD').join('\r\n');
  assert.throws(() => parse(many, { maxCards: 4 }), /more than 4 cards/);
  assert.throws(() => parse(`BEGIN:VCARD\r\nVERSION:4.0\r\n${'NOTE:x\r\n'.repeat(10)}END:VCARD`, { maxProps: 5 }), /more than 5 properties/);
  assert.throws(() => parse(`BEGIN:VCARD\r\nVERSION:4.0\r\nNOTE:${'x'.repeat(200)}\r\nEND:VCARD`, { maxLine: 100 }), /longer than 100/);
});

test('parameters: quoted values with separators, repeated TYPE, and bare 2.1-style types are read', () => {
  const c = parse('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Q\r\nADR;LABEL="1 Main St; Dayton, OH";TYPE=home;TYPE=postal:;;1 Main;Dayton;OH;45402;US\r\nTEL;WORK;VOICE:555\r\nEND:VCARD')[0]!;
  const adr = c.props.find((p) => p.name === 'ADR')!;
  assert.deepEqual(adr.params['LABEL'], ['1 Main St; Dayton, OH']);
  assert.deepEqual(adr.params['TYPE'], ['home', 'postal']);
  assert.deepEqual(view(c).phones[0]!.types, ['work', 'voice']);
  assert.match(write(c), /LABEL="1 Main St; Dayton, OH"/);
});

test('escapes survive both ways, including backslashes and a lone trailing backslash', () => {
  const nasty = 'back\\slash, comma; semi\nnewline \\n literal';
  const card: Card = { version: '4.0', props: [{ name: 'FN', params: {}, value: 'N' }, { name: 'NOTE', params: {}, value: nasty }, { name: 'ADR', params: {}, value: [[''], [''], ['a;b,c'], ['x'], [''], [''], ['']] }] };
  const back = parse(write(card))[0]!;
  assert.equal(view(back).note, nasty);
  assert.equal(view(back).addresses[0]!.street, 'a;b,c');
  assert.equal(view(parse('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:X\r\nNOTE:ends with backslash\\\r\nEND:VCARD')[0]!).note, 'ends with backslash\\');
});
