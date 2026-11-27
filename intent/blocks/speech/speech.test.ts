import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Palette } from '../palette/index.ts';
import { Dictation, VoiceCommands, dictateInto, errorWords, forField, listen, matchCommands, recognitionIn, similarity, spokenDate, spokenNumber, spokenYear, type Recognition, type RecognitionEvent } from './index.ts';

function palette() {
  const ran: string[] = [];
  const p = new Palette();
  const add = (id: string, title: string, o: { keywords?: string[]; permission?: string } = {}) => p.register({ id, title, section: 'Files', ...o, run: () => void ran.push(id) });
  add('settings', 'Open settings', { keywords: ['preferences'] });
  add('delete', 'Delete file');
  add('archive', 'Archive file');
  add('pdf', 'Export as PDF');
  add('csv', 'Export as CSV');
  add('purge', 'Purge cache', { permission: 'admin' });
  return { p, ran };
}
const member = (perm: string) => perm !== 'admin';

test('a clear spoken command runs; filler words and one misheard letter are forgiven; keywords count', async () => {
  const { p, ran } = palette();
  const v = new VoiceCommands(p, member);
  assert.deepEqual(await v.hear('Please open the settings.'), { kind: 'ran', command: (await p.search('settings', member))[0]!.command });
  assert.equal((await v.hear('go to preferences')).kind, 'ran');
  assert.equal((await v.hear('archive the fil')).kind, 'ran', '"fil" is heard as "file"');
  assert.deepEqual(ran, ['settings', 'settings', 'archive']);
  assert.equal(similarity('open settings', 'Open settings'), 1);
  assert.equal(similarity('the', 'Open settings'), 0);
  assert.deepEqual(matchCommands('open', p.search('', member, 99).map((r) => r.command)).map((m) => m.command.id), ['settings']);
});

test('nothing runs on a command the person cannot use, on silence, or on words that match nothing', async () => {
  const { p, ran } = palette();
  const v = new VoiceCommands(p, member);
  assert.deepEqual(await v.hear('purge cache'), { kind: 'none', say: 'I did not find a command for “purge cache”. Try saying it another way.' });
  assert.deepEqual(await v.hear('  '), { kind: 'none', say: 'I did not hear anything. Try again.' });
  assert.equal((await v.hear('make me a sandwich')).kind, 'none');
  assert.deepEqual(ran, []);
});

test('a command that cannot be undone waits for a spoken yes; no, or anything unclear, does nothing', async () => {
  const { p, ran } = palette();
  const v = new VoiceCommands(p, member);
  const asked = await v.hear('delete the file');
  assert.deepEqual(asked.kind === 'confirm' && [asked.command.id, asked.say], ['delete', 'Delete file cannot be undone. Say “yes” to go ahead, or “no” to stop.']);
  assert.equal(v.waiting, 'confirm');
  assert.equal((await v.hear('open settings')).kind, 'confirm', 'another command while waiting asks again, and runs nothing');
  assert.deepEqual(ran, []);
  assert.deepEqual(await v.hear('No.'), { kind: 'cancelled', say: 'Nothing was done.' });
  assert.equal(v.waiting, null);
  await v.hear('delete file');
  assert.equal((await v.hear('Yes')).kind, 'ran');
  assert.deepEqual(ran, ['delete']);
  const custom = new VoiceCommands(p, member, { destructive: (c) => c.id === 'archive' });
  assert.equal((await custom.hear('archive file')).kind, 'confirm');
  assert.equal((await custom.hear('no')).kind, 'cancelled');
  assert.equal((await custom.hear('delete file')).kind, 'ran', 'the given rule replaces the default');
});

test('a near tie asks which was meant, by number or by name', async () => {
  const { p, ran } = palette();
  const v = new VoiceCommands(p, member);
  const q = await v.hear('export');
  assert.deepEqual(q.kind === 'choose' && [q.options.map((c) => c.id), q.say], [['csv', 'pdf'], 'Did you mean one: Export as CSV; two: Export as PDF? Say the number, or “no” to stop.']);
  assert.equal((await v.hear('purple')).kind, 'choose', 'an unclear answer asks again');
  assert.equal((await v.hear('two')).kind, 'ran');
  await v.hear('export');
  assert.equal((await v.hear('csv')).kind, 'ran');
  await v.hear('export');
  assert.equal((await v.hear('never mind')).kind, 'cancelled');
  assert.deepEqual(ran, ['pdf', 'csv']);
});

test('dictation turns spoken punctuation into marks, capitalises sentences and takes back the last thing said', () => {
  const d = new Dictation();
  assert.equal(d.hear('hello comma how are you question mark'), 'Hello, how are you?');
  assert.equal(d.hear('i am fine full stop'), 'Hello, how are you? I am fine.');
  assert.equal(d.hear('scratch that'), 'Hello, how are you?');
  assert.equal(d.hear('see you Monday scratch that Tuesday period new paragraph thanks exclamation mark'), 'Hello, how are you? Tuesday.\n\nThanks!');
  assert.equal(d.hear('new line open quote yes close quote she said colon done semicolon open bracket really close bracket'), 'Hello, how are you? Tuesday.\n\nThanks!\n“Yes” she said: done; (really)');
  const e = new Dictation('Dear Sam,');
  assert.equal(e.hear('the word literal comma is literal full stop spelled out full stop'), 'Dear Sam, the word comma is full stop spelled out.');
  assert.equal(e.hear('scratch that scratch that'), 'Dear Sam,', 'taking back more than was said leaves what was typed');
  assert.equal(new Dictation('', { capitalise: false }).hear('hello full stop there'), 'hello. there');
  assert.equal(new Dictation().hear('Recognisers add their own commas, and full stops.'), 'Recognisers add their own commas and full stops', 'marks the recogniser adds are dropped; only spoken punctuation counts');
});

test('numbers spoken in words, refused when they do not read cleanly', () => {
  const cases: [string, number | null][] = [
    ['two hundred and forty five', 245], ['twenty-one', 21], ['one thousand two hundred', 1200], ['a hundred', 100], ['a thousand and one', 1001],
    ['two million three hundred thousand', 2_300_000], ['ninety nine thousand nine hundred and ninety nine', 99_999], ['zero', 0], ['12', 12],
    ['three point one four', 3.14], ['minus four', -4], ['negative two point five', -2.5],
    ['five five', null], ['hundred', null], ['and five', null], ['one thousand million', null], ['point five', null], ['three point', null], ['blue', null], ['', null],
  ];
  for (const [t, n] of cases) assert.equal(spokenNumber(t), n, t);
  assert.equal(spokenYear(['twenty', 'twenty', 'six']), 2026);
  assert.equal(spokenYear(['nineteen', 'eighty', 'four']), 1984);
  assert.equal(spokenYear(['twenty', 'oh', 'five']), 2005);
  assert.equal(spokenYear(['nineteen', 'hundred']), 1900);
  assert.equal(spokenYear(['twenty', 'six']), null);
});

test('dates spoken in words, relative to today, with real calendar checks', () => {
  const today = '2026-11-27';
  const cases: [string, string | null][] = [
    ['today', '2026-11-27'], ['tomorrow', '2026-11-28'], ['yesterday', '2026-11-26'], ['the day after tomorrow', '2026-11-29'],
    ['in three days', '2026-11-30'], ['in a week', '2026-12-04'], ['in two weeks', '2026-12-11'],
    ['Monday', '2026-11-30'], ['next Friday', '2026-12-04'], ['on Friday', '2026-12-04'], ['last Friday', '2026-11-20'],
    ['the third of March twenty twenty six', '2026-03-03'], ['March 3rd', '2026-03-03'], ['March the twenty first', '2026-03-21'],
    ['December first two thousand and twenty six', '2026-12-01'], ['the 29th of February 2028', '2028-02-29'], ['nineteenth of May nineteen eighty four', '1984-05-19'],
    ['February thirtieth', null], ['the 29th of February 2027', null], ['March', null], ['next week', null], ['the twenty fifth of December twenty six', null],
  ];
  for (const [t, d] of cases) assert.equal(spokenDate(t, today), d, t);
  assert.equal(spokenDate('the third of March', today, { future: true }), '2027-03-03', 'a booking means the next one');
  assert.equal(spokenDate('the third of March twenty twenty six', today, { future: true }), '2026-03-03', 'a year said is a year kept');
  assert.throws(() => spokenDate('today', 'soon'), /today must be a date/);
});

test('voice input on any field: text is dictated, numbers and dates are read, and what cannot be read is said back', () => {
  assert.deepEqual(forField('text', 'call me back full stop'), { ok: true, value: 'Call me back.' });
  assert.deepEqual(forField('number', 'twelve'), { ok: true, value: 12 });
  assert.deepEqual(forField('date', 'next friday', '2026-11-27'), { ok: true, value: '2026-12-04' });
  assert.deepEqual(forField('number', 'blue'), { ok: false, say: 'I heard “blue” but could not read it as a number. Try saying it again, one number at a time.' });
  assert.deepEqual(forField('date', 'soonish', '2026-11-27'), { ok: false, say: 'I heard “soonish” but could not read it as a date. Try “the third of March” or “next Friday”.' });
  assert.deepEqual(forField('text', ' '), { ok: false, say: 'I did not hear anything. Try again.' });
  assert.throws(() => forField('date', 'today'), /needs today’s date/);
});

class FakeRecognition implements Recognition {
  static last: FakeRecognition | undefined;
  lang = '';
  continuous = false;
  interimResults = false;
  onresult: ((e: RecognitionEvent) => void) | null = null;
  onerror: ((e: { readonly error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  stopped = false;
  constructor() {
    FakeRecognition.last = this;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  say(parts: [string, boolean][]) {
    const results = Object.assign(parts.map(([t, isFinal]) => Object.assign([{ transcript: t }], { isFinal })), { length: parts.length });
    this.onresult?.({ resultIndex: 0, results } as unknown as RecognitionEvent);
  }
}

test('the browser adapter does nothing without speech recognition, and wires it to dictation when present', () => {
  assert.equal(recognitionIn(undefined), null);
  assert.equal(recognitionIn({}), null);
  assert.equal(listen({}, { onFinal: () => {} }), null, 'no recognition: the keyboard is all there is');
  assert.equal(recognitionIn({ webkitSpeechRecognition: FakeRecognition }), FakeRecognition);
  const field = { value: 'Note:' };
  const changes: string[] = [];
  const errors: string[] = [];
  const interim: string[] = [];
  const h = dictateInto({ SpeechRecognition: FakeRecognition }, field, { lang: 'en-US', onChange: (t) => changes.push(t), onError: (m) => errors.push(m), onInterim: (t) => interim.push(t) })!;
  const r = FakeRecognition.last!;
  assert.deepEqual([r.started, r.lang, r.interimResults, r.continuous], [true, 'en-US', true, false]);
  r.say([['buy milk comma', true], [' and', false]]);
  assert.equal(field.value, 'Note: buy milk,');
  assert.deepEqual(interim, ['and']);
  r.onerror!({ error: 'not-allowed' });
  r.onerror!({ error: 'aborted' });
  assert.deepEqual(errors, ['The microphone is blocked. Allow it in your browser’s settings to speak instead of type.']);
  h.stop();
  assert.equal(r.stopped, true);
  assert.deepEqual(changes, ['Note: buy milk,']);
  assert.equal(errorWords('no-speech'), 'Nothing was heard. Try again a little closer to the microphone.');
  assert.equal(errorWords('something-new'), 'Speech recognition stopped. You can keep typing.');
});
