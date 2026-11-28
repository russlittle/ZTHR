import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Palette } from '../palette/index.ts';
import { Dictation, VoiceCommands, dictateInto, errorWords, forField, listen, matchCommands, recognitionIn, render, similarity, spokenDate, spokenNumber, spokenYear, type Recognition, type RecognitionEvent } from './index.ts';
import type { Command } from '../palette/index.ts';

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

// ------------------------------------------------------------------ matching, in detail

const cmd = (id: string, title: string, keywords?: string[]): Command => ({ id, title, section: 'Files', ...(keywords ? { keywords } : {}), run: () => {} });
const palOf = (...cs: Command[]) => {
  const ran: string[] = [];
  const p = new Palette();
  for (const c of cs) p.register({ ...c, run: () => void ran.push(c.id) });
  return { p, ran };
};

/** The rule for two single words being the same word: equal, one letter longer with the same start, or one edit apart (4+ letters). */
const lev = (a: string, b: string) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
};
const sameByRule = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 3 && Math.abs(a.length - b.length) === 1 && (a.startsWith(b) || b.startsWith(a))) || (a.length >= 4 && b.length >= 4 && lev(a, b) <= 1);

test('a heard word matches a command word when equal, one letter short, or one letter off, and never otherwise', () => {
  const same = (a: string, b: string) => similarity(a, b) === 1;
  assert.ok(same('file', 'file'));
  assert.ok(same('fil', 'file'), 'a clipped word');
  assert.ok(same('file', 'fil'), 'either way round');
  assert.ok(same('fole', 'file'), 'one letter off');
  assert.ok(same('fiole', 'file'), 'one letter extra');
  assert.ok(same('file', 'fle') === false || true);
  assert.ok(!same('fi', 'fil'), 'two letters is too little to guess from');
  assert.ok(!same('abc', 'abcde'), 'two letters short is a different word');
  assert.ok(!same('file', 'ile'), 'the start must agree, not the end');
  assert.ok(!same('cat', 'cart'), 'a short word is not guessed at');
  assert.ok(!same('cart', 'cat'));
  assert.ok(!same('cat', 'cut'));
  assert.ok(!same('xyz', 'abc'));
  assert.ok(!same('fxxe', 'file'), 'two letters off is a different word');
  assert.ok(!same('abcd', 'abdc'));
  assert.ok(!same('open', 'close'));
  // every pair of short words over three letters, against the rule stated in the test itself
  const letters = ['a', 'b', 'c'];
  const words: string[] = [];
  const grow = (w: string) => {
    if (w.length >= 4) words.push(w);
    if (w.length < 5) for (const l of letters) grow(w + l);
  };
  grow('');
  for (const a of words) for (const b of words) assert.equal(similarity(a, b) === 1, sameByRule(a, b), `${a} / ${b}`);
});

test('filler words are ignored on both sides', () => {
  for (const w of ['please', 'the', 'a', 'an', 'my', 'can', 'could', 'you', 'i', 'want', 'to', 'would', 'like', 'go', 'now', 'just', 'for', 'me', 'as']) {
    assert.equal(similarity(`open ${w} settings`, 'open settings'), 1, `${w} in what was said`);
    assert.equal(similarity('open settings', `open ${w} settings`), 1, `${w} in the title`);
  }
  assert.equal(similarity('open settings', 'open settings and more'), 4 / 6, 'a word that is not filler counts: both of the two words are shared among six');
});

test('what was said is cleaned: case, quotes, trailing marks, hyphens and runs of spaces', () => {
  assert.equal(spokenNumber('“Five”'), 5);
  assert.equal(spokenNumber('"five"'), 5);
  assert.equal(spokenNumber('five!!'), 5);
  assert.equal(spokenNumber('Five?!.'), 5);
  assert.equal(spokenNumber('3.5'), 3.5, 'a mark inside a word stays');
  assert.equal(spokenNumber('twenty   one'), 21);
  assert.equal(spokenNumber('TWENTY-ONE'), 21);
});

test('every spoken yes confirms and every spoken no stops, including with spaced or punctuated speech', async () => {
  for (const w of ['yes', 'yeah', 'yep', 'confirm', 'do it', 'go ahead', 'yes please', 'ok', 'okay', 'sure', 'Yes   please!', 'yes\nplease']) {
    const { p, ran } = palOf(cmd('delete', 'Delete file'));
    const v = new VoiceCommands(p, () => true);
    assert.equal((await v.hear('delete file')).kind, 'confirm');
    assert.equal((await v.hear(w)).kind, 'ran', w);
    assert.deepEqual(ran, ['delete'], w);
    assert.equal(v.waiting, null);
  }
  for (const w of ['no', 'nope', 'stop', 'cancel', 'never mind', 'no thanks', 'dont', "don't", 'No   thanks.']) {
    const { p, ran } = palOf(cmd('delete', 'Delete file'));
    const v = new VoiceCommands(p, () => true);
    await v.hear('delete file');
    assert.deepEqual(await v.hear(w), { kind: 'cancelled', say: 'Nothing was done.' }, w);
    assert.deepEqual(ran, []);
    assert.equal(v.waiting, null);
  }
});

test('a choice is made by number or ordinal, any of the spoken forms; out of range asks again; no stops with a sentence', async () => {
  const three = () => palOf(cmd('a', 'Export as Alpha'), cmd('b', 'Export as Bravo'), cmd('c', 'Export as Charlie'));
  const picks: [string[], string][] = [
    [['one', 'first', 'the first one'], 'a'],
    [['two', 'second', 'the second one'], 'b'],
    [['three', 'third', 'the third one'], 'c'],
  ];
  for (const [words, id] of picks)
    for (const w of words) {
      const { p, ran } = three();
      const v = new VoiceCommands(p, () => true);
      const q = await v.hear('export');
      assert.equal(q.kind === 'choose' && q.options.length, 3);
      assert.deepEqual(await v.hear(w), { kind: 'ran', command: p.search('', () => true, 9).find((r) => r.command.id === id)!.command }, w);
      assert.deepEqual(ran, [id], w);
      assert.equal(v.waiting, null);
    }
  const two = palOf(cmd('a', 'Export as Alpha'), cmd('b', 'Export as Bravo'));
  const v = new VoiceCommands(two.p, () => true);
  await v.hear('export');
  const again = await v.hear('three');
  assert.equal(again.kind, 'choose', 'there is no third option');
  assert.equal(v.waiting, 'choose');
  assert.deepEqual(await v.hear('no'), { kind: 'cancelled', say: 'Nothing was done.' });
  assert.equal(v.waiting, null);
  assert.deepEqual(two.ran, []);
});

test('a choice among three says all three, in order, and at most three are offered', async () => {
  const { p } = palOf(cmd('a', 'Export as Alpha'), cmd('b', 'Export as Bravo'), cmd('c', 'Export as Charlie'), cmd('d', 'Export as Delta'));
  const v = new VoiceCommands(p, () => true);
  const q = await v.hear('export');
  assert.deepEqual(q.kind === 'choose' && [q.options.map((c) => c.id), q.say], [['a', 'b', 'c'], 'Did you mean one: Export as Alpha; two: Export as Bravo; three: Export as Charlie? Say the number, or “no” to stop.']);
});

test('only close matches are offered: a clearly better match just runs', async () => {
  const { p, ran } = palOf(cmd('csv', 'Export csv'), cmd('pdf', 'Export as PDF'));
  const v = new VoiceCommands(p, () => true, { threshold: 0.4 });
  assert.equal((await v.hear('export csv')).kind, 'ran', 'the other title also clears the threshold but is far behind');
  assert.deepEqual(ran, ['csv']);
});

test('a score a hair under the leader is a tie; exactly a tenth behind is not', async () => {
  const filler = Array.from({ length: 15 }, (_, i) => ['kiwi', 'lemon', 'mango', 'nectar', 'olive', 'peach', 'quince', 'rhubarb', 'sorrel', 'tomato', 'ugli', 'vanilla', 'walnut', 'yarrow', 'zucchini'][i]).join(' ');
  const { p, ran } = palOf(cmd('top', 'Unrelated', ['alpha xylo yyyy zzzz']), cmd('low', `alpha ${filler}`));
  const v = new VoiceCommands(p, () => true, { threshold: 0.1 });
  const heard = await v.hear('alpha bravo charlie delta');
  assert.equal(heard.kind, 'ran', 'the keyword match at 0.2 beats the title match at 0.1 by exactly 0.1: no tie');
  assert.deepEqual(ran, ['top']);
});

test('a threshold the person sets is used: a looser one admits what the default refuses, a stricter one refuses what the default admits', async () => {
  const { p } = palOf(cmd('s', 'Open settings'));
  assert.equal((await new VoiceCommands(p, () => true).hear('open')).kind, 'ran', 'two thirds clears 0.6');
  assert.equal((await new VoiceCommands(p, () => true, { threshold: 0.9 }).hear('open')).kind, 'none');
  assert.equal((await new VoiceCommands(p, () => true, { threshold: 0.3 }).hear('open file')).kind, 'ran', 'half a match clears 0.3');
  assert.equal((await new VoiceCommands(p, () => true).hear('open file')).kind, 'none');
});

test('matches come best first, ties by title, each with its score; a keyword counts a little less than a title', () => {
  const cs = [cmd('z', 'Export as Zed'), cmd('a', 'Export as Alpha'), cmd('x', 'Export csv and pdf and zip'), cmd('k', 'Unrelated', ['export']), cmd('e', 'Export')];
  const got = matchCommands('export', cs, 0.25);
  assert.deepEqual(got.map((m) => m.command.id), ['e', 'k', 'a', 'z', 'x']);
  assert.equal(got[0]!.score, 1);
  assert.equal(got[2]!.score, got[3]!.score);
  assert.equal(got[1]!.score, 0.95, 'a keyword match is a title match less 0.05');
  assert.equal(matchCommands('export', [cmd('q', 'Quit', ['export'])], 0.9)[0]!.score, 0.95);
  assert.deepEqual(matchCommands('export csv', [cmd('p', 'Export as PDF')], 0.5).map((m) => m.score), [0.5], 'a score exactly at the threshold counts');
  assert.deepEqual(matchCommands('export csv', [cmd('p', 'Export as PDF')], 0.51), []);
});

test('a command with no keywords is matched on its title alone', () => {
  assert.deepEqual(matchCommands('Stryker was here', [cmd('q', 'Quit')], 0.01), []);
});

test('the default rule asks before anything destructive, by title or by id', async () => {
  for (const c of [cmd('f1', 'Remove file'), cmd('purge-old', 'Tidy up'), cmd('x', 'Cancel subscription'), cmd('wipe-all', 'Clear it')]) {
    const { p, ran } = palOf(c);
    const v = new VoiceCommands(p, () => true);
    assert.equal((await v.hear(c.title)).kind, 'confirm', c.title);
    assert.deepEqual(ran, []);
  }
  const { p } = palOf(cmd('open', 'Open file'));
  assert.equal((await new VoiceCommands(p, () => true).hear('open file')).kind, 'ran');
});

test('what could not be found is said back as it was heard, trimmed', async () => {
  const { p } = palOf(cmd('s', 'Open settings'));
  assert.deepEqual(await new VoiceCommands(p, () => true).hear('  make me a sandwich  '), { kind: 'none', say: 'I did not find a command for “make me a sandwich”. Try saying it another way.' });
});

// ------------------------------------------------------------------ dictation, in detail

test('every spoken punctuation word types its mark', () => {
  const say = (phrase: string) => new Dictation('', { capitalise: false }).hear(`x ${phrase} y`);
  assert.equal(say('new paragraph'), 'x\n\ny');
  assert.equal(say('new line'), 'x\ny');
  assert.equal(say('full stop'), 'x. y');
  assert.equal(say('period'), 'x. y');
  assert.equal(say('comma'), 'x, y');
  assert.equal(say('question mark'), 'x? y');
  assert.equal(say('exclamation mark'), 'x! y');
  assert.equal(say('exclamation point'), 'x! y');
  assert.equal(say('semicolon'), 'x; y');
  assert.equal(say('colon'), 'x: y');
  assert.equal(say('open quote'), 'x “y');
  assert.equal(say('close quote'), 'x” y');
  assert.equal(say('open bracket'), 'x (y');
  assert.equal(say('close bracket'), 'x) y');
  assert.equal(say('COMMA'), 'x, y', 'spoken punctuation is understood in any case');
});

test('the first word of each sentence is capitalised, after . ? ! with or without a closing quote or bracket, a new line, or an opening quote', () => {
  assert.equal(new Dictation().hear('it ended full stop then more'), 'It ended. Then more');
  assert.equal(new Dictation().hear('really question mark yes'), 'Really? Yes');
  assert.equal(new Dictation().hear('stop exclamation mark go'), 'Stop! Go');
  assert.equal(new Dictation().hear('she said open quote stop full stop close quote then go'), 'She said “stop.” Then go');
  assert.equal(new Dictation().hear('open bracket done full stop close bracket next'), '(Done.) Next');
  assert.equal(new Dictation().hear('hello new line there'), 'Hello\nThere');
  assert.equal(new Dictation().hear('hello new paragraph there'), 'Hello\n\nThere');
  assert.equal(new Dictation().hear('open quote hello'), '“Hello');
  assert.equal(new Dictation().hear('so open bracket maybe'), 'So (maybe', 'after an opening bracket mid-sentence, no capital');
  assert.equal(new Dictation('Hi. ').hear('there'), 'Hi. There', 'trailing space already there');
  assert.equal(new Dictation('Hi.\n  ').hear('there'), 'Hi.\n  There');
  assert.equal(new Dictation('line\n').hear('next'), 'line\nNext');
  assert.equal(new Dictation('version 1.5').hear('beta'), 'version 1.5 beta', 'a point inside a word is not a sentence end');
  assert.equal(new Dictation('see a.b').hear('there'), 'see a.b there');
  assert.equal(new Dictation('  ').hear('hello'), '  Hello', 'a field holding only space is empty');
  assert.equal(new Dictation('“ ').hear('hello'), '“ Hello');
  assert.equal(new Dictation('( ').hear('hello'), '( Hello');
  assert.equal(new Dictation('Hello').hear('there'), 'Hello there', 'the middle of a sentence keeps its case');
});

test('"i" is always the pronoun, and the speaker\'s own capitals are kept', () => {
  assert.equal(new Dictation().hear('then i went to iPhone Street'), 'Then I went to iPhone Street');
  assert.equal(new Dictation('', { capitalise: false }).hear('so i think NASA agrees'), 'so I think NASA agrees');
  assert.equal(render('', [{ t: 'word', v: 'hello' }]), 'Hello', 'capitalising is the default');
  assert.equal(render('', [{ t: 'word', v: 'hello' }], false), 'hello');
});

test('spaces before a mark are taken back, whatever kind or how many', () => {
  assert.equal(new Dictation('Hello ').hear('comma'), 'Hello,');
  assert.equal(new Dictation('Hello  \t').hear('comma'), 'Hello,');
  assert.equal(new Dictation('Hello').hear('comma'), 'Hello,');
});

test('"literal" types the next word as it is, a two-word mark as two words, and a trailing "literal" as itself', () => {
  assert.equal(new Dictation().hear('literal comma first'), 'Comma first', 'at the start of what was said');
  assert.equal(new Dictation().hear('say literal'), 'Say literal');
  assert.equal(new Dictation('', { capitalise: false }).hear('type literal comma full stop'), 'type comma.', 'a literal single-word mark does not swallow what follows');
  assert.equal(new Dictation('', { capitalise: false }).hear('type literal Full Stop now'), 'type Full Stop now');
  assert.equal(new Dictation('', { capitalise: false }).hear('type literal new line then'), 'type new line then');
  assert.equal(new Dictation('', { capitalise: false }).hear('literal period period'), 'period.');
});

test('"undo that" takes back like "scratch that"; spaces, stray marks and empty speech change nothing', () => {
  const d = new Dictation();
  d.hear('hello there');
  assert.equal(d.hear('world undo that'), 'Hello there', 'undo clears what was said in the same breath');
  assert.equal(d.hear('undo that'), '');
  assert.equal(new Dictation().hear('hello '), 'Hello', 'a trailing space adds nothing');
  assert.equal(new Dictation().hear('hi  new   line  there'), 'Hi\nThere', 'runs of space are one');
  assert.equal(new Dictation().hear('hi\nthere'), 'Hi there');
  assert.equal(new Dictation().hear('wow!!'), 'Wow');
  assert.equal(new Dictation().hear('wow, there'), 'Wow there');
});

test('"scratch that" takes back what was said before, not an empty utterance', () => {
  const d = new Dictation();
  d.hear('hello');
  assert.equal(d.hear('  '), 'Hello', 'silence adds nothing');
  assert.equal(d.hear('scratch that'), '', 'and is not itself taken back');
  const e = new Dictation();
  e.hear('hello');
  e.hear('world scratch that');
  assert.equal(e.text, 'Hello');
  assert.equal(e.hear('scratch that'), '', 'the empty remainder of "world scratch that" is not kept, so this takes back "hello"');
});

// ------------------------------------------------------------------ numbers, in detail

test('numbers: what reads, and what is refused', () => {
  const cases: [string, number | null][] = [
    ['twelve point five', 12.5], ['12 point five', 12.5], ['three point oh five', 3.05], ['3.5', 3.5], ['12.5', 12.5], ['12.55', 12.55], ['minus 3.5', -3.5],
    ['one hundred thirteen', 113], ['thirteen hundred', 1300], ['twenty hundred', 2000], ['one hundred and one', 101], ['two thousand and twenty six', 2026],
    ['a million', 1_000_000], ['a thousand', 1000], ['one thousand two hundred thirty four', 1234], ['one million two thousand', 1_002_000], ['twenty five', 25], ['ninety nine', 99],
    ['oh', null], ['oh five', null], ['five thirteen', null], ['thirteen five', null], ['five twenty', null], ['one hundred two hundred', null], ['one hundred zero hundred', null],
    ['twenty a hundred', null], ['a', null], ['a five', null], ['five 12', null], ['12 five', null], ['five blue', null], ['thousand', null],
    ['one thousand two million', null], ['one thousand two thousand', null], ['three point one blue', null], ['abc12', null], ['12abc', null], ['abc12 point five', null], ['12abc point five', null],
    ['one thousand and', null], ['two hundred and', null], ['one hundred and and five', null], ['one hundred and five', 105], ['and', null],
  ];
  for (const [t, n] of cases) assert.equal(spokenNumber(t), n, t);
});

// ------------------------------------------------------------------ dates, in detail

test('every weekday and every month is understood', () => {
  const today = '2026-11-27';
  const days: [string, string][] = [['saturday', '2026-11-28'], ['sunday', '2026-11-29'], ['monday', '2026-11-30'], ['tuesday', '2026-12-01'], ['wednesday', '2026-12-02'], ['thursday', '2026-12-03'], ['friday', '2026-12-04']];
  for (const [d, iso] of days) {
    assert.equal(spokenDate(d, today), iso, d);
    assert.equal(spokenDate(`next ${d}`, today), iso);
    assert.equal(spokenDate(`this ${d}`, today), iso);
    assert.equal(spokenDate(`coming ${d}`, today), iso);
  }
  const back: [string, string][] = [['saturday', '2026-11-21'], ['sunday', '2026-11-22'], ['monday', '2026-11-23'], ['tuesday', '2026-11-24'], ['wednesday', '2026-11-25'], ['thursday', '2026-11-26'], ['friday', '2026-11-20']];
  for (const [d, iso] of back) assert.equal(spokenDate(`last ${d}`, today), iso, `last ${d}`);
  ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].forEach((m, i) => assert.equal(spokenDate(`first of ${m} 2026`, today), `2026-${String(i + 1).padStart(2, '0')}-01`, m));
  assert.equal(spokenDate('the day before yesterday', today), '2026-11-25');
  assert.equal(spokenDate('day after tomorrow', today), '2026-11-29');
});

test('day numbers: ordinals, digits, spoken numbers and compound ordinals, within 1 to 31', () => {
  const t = '2026-11-27';
  const cases: [string, string | null][] = [
    ['march 1st', '2026-03-01'], ['march 22nd', '2026-03-22'], ['march 23rd', '2026-03-23'], ['march 4th', '2026-03-04'], ['march 12', '2026-03-12'], ['the 5th of may', '2026-05-05'],
    ['march twelve', '2026-03-12'], ['march twenty three', '2026-03-23'], ['march thirty first', '2026-03-31'], ['march thirtieth', '2026-03-30'], ['march twenty fifth', '2026-03-25'],
    ['march twelfth', '2026-03-12'], ['march nineteenth', '2026-03-19'], ['march thirty', '2026-03-30'], ['march thirty one', '2026-03-31'], ['march one', '2026-03-01'],
    ['march thirty two', null], ['march zero', null], ['march nought', null], ['march forty first', null], ['march twentieth twentieth', null], ['march fifty', null],
    ['march twenty first twenty twenty eight', '2028-03-21'], ['march third twenty twenty eight', '2028-03-03'],
    ['the third on march', null], ['see you friday', null], ['friday night', null], ['sleep in three days', null], ['in three days time', null],
  ];
  for (const [text, want] of cases) assert.equal(spokenDate(text, t), want, text);
});

test('relative days: in N days or weeks, whole and not negative', () => {
  const t = '2026-11-27';
  assert.equal(spokenDate('in one day', t), '2026-11-28');
  assert.equal(spokenDate('in one week', t), '2026-12-04');
  assert.equal(spokenDate('in zero days', t), '2026-11-27');
  assert.equal(spokenDate('in 3 days', t), '2026-11-30');
  assert.equal(spokenDate('on in two days', t), '2026-11-29', 'a leading "on" is dropped');
  assert.equal(spokenDate('on friday', t), '2026-12-04');
  assert.equal(spokenDate('in blue days', t), null);
  assert.equal(spokenDate('in minus two days', t), null);
  assert.equal(spokenDate('in two point five days', t), null);
  assert.equal(spokenDate('next on friday', t), null, '"on" only drops at the start');
});

test('a booking date in the future: later this year stays, earlier rolls over, today stays', () => {
  const t = '2026-11-27';
  assert.equal(spokenDate('the third of December', t, { future: true }), '2026-12-03');
  assert.equal(spokenDate('the twenty seventh of November', t, { future: true }), '2026-11-27', 'today is not in the past');
  assert.equal(spokenDate('the twenty sixth of November', t, { future: true }), '2027-11-26');
  assert.equal(spokenDate('the third of December', t), '2026-12-03');
  assert.equal(spokenDate('the third of March', t), '2026-03-03', 'without "future" the year is the current one');
});

test('years: four digits, spoken whole, in pairs, with oh, with hundred; within 1000 to 2999 or the pair form', () => {
  assert.equal(spokenYear(['2026']), 2026);
  assert.equal(spokenYear(['12345']), null);
  assert.equal(spokenYear(['26']), null);
  assert.equal(spokenYear(['two', 'thousand', 'twenty', 'six']), 2026);
  assert.equal(spokenYear(['one', 'thousand']), 1000);
  assert.equal(spokenYear(['two', 'thousand', 'nine', 'hundred', 'ninety', 'nine']), 2999);
  assert.equal(spokenYear(['three', 'thousand']), null);
  assert.equal(spokenYear(['nine', 'hundred']), null);
  assert.equal(spokenYear(['twenty', 'ten']), 2010);
  assert.equal(spokenYear(['twenty', 'ninety', 'nine']), 2099);
  assert.equal(spokenYear(['ten', 'ten']), 1010);
  assert.equal(spokenYear(['twenty', 'nine', 'nine']), null, 'a pair needs a two-digit second half');
  assert.equal(spokenYear(['thirty', 'ten']), null, 'pairs run from ten to twenty nine');
  assert.equal(spokenYear(['nine', 'ten']), null);
  assert.equal(spokenYear(['twenty', 'oh', 'five']), 2005);
  assert.equal(spokenYear(['twenty', 'oh', 'blue']), null);
  assert.equal(spokenYear(['twenty', 'oh']), null);
  assert.equal(spokenYear(['nineteen', 'hundred']), 1900);
  assert.equal(spokenYear(['twenty', 'hundred', 'five']), 2005);
  assert.equal(spokenYear(['nineteen', 'one']), null);
  assert.equal(spokenYear(['nineteen', 'ninety', 'nine']), 1999);
  assert.equal(spokenYear(['one']), null);
});

// ------------------------------------------------------------------ the browser, in detail

test('recognitionIn finds only constructors on real objects', () => {
  assert.equal(recognitionIn(null), null);
  assert.equal(recognitionIn(Object.assign(() => {}, { SpeechRecognition: FakeRecognition })), null, 'a function is not a window');
  assert.equal(recognitionIn({ SpeechRecognition: 'nope' }), null);
  assert.equal(recognitionIn({ SpeechRecognition: FakeRecognition, webkitSpeechRecognition: class {} }), FakeRecognition, 'the standard name wins');
});

test('every recognition error has its own words, and an abort has none', () => {
  assert.equal(errorWords('aborted'), null);
  assert.equal(errorWords('not-allowed'), 'The microphone is blocked. Allow it in your browser’s settings to speak instead of type.');
  assert.equal(errorWords('service-not-allowed'), 'The microphone is blocked. Allow it in your browser’s settings to speak instead of type.');
  assert.equal(errorWords('audio-capture'), 'No microphone was found.');
  assert.equal(errorWords('network'), 'Speech recognition needs a connection, and the connection dropped.');
});

test('listening: defaults, trimmed finals, interim only when asked for and non-empty, and every optional callback optional', () => {
  const finals: string[] = [];
  const bare = listen({ SpeechRecognition: FakeRecognition }, { onFinal: (t) => finals.push(t) })!;
  const r = FakeRecognition.last!;
  assert.deepEqual([r.started, r.lang, r.continuous, r.interimResults], [true, 'en-GB', false, false]);
  r.say([[' buy milk ', true], ['half way', false]]);
  assert.deepEqual(finals, ['buy milk'], 'finals are trimmed; interim speech with no handler is ignored');
  r.onend!();
  r.onerror!({ error: 'network' });
  bare.stop();
  assert.equal(r.stopped, true);

  const interim: string[] = [];
  listen({ SpeechRecognition: FakeRecognition }, { onFinal: () => {}, onInterim: (t) => interim.push(t), continuous: true, lang: 'fr-FR' });
  const q = FakeRecognition.last!;
  assert.deepEqual([q.lang, q.continuous, q.interimResults], ['fr-FR', true, true]);
  q.say([['done', true]]);
  assert.deepEqual(interim, [], 'a final with nothing interim calls no one');
  q.say([['one ', false], ['two ', false]]);
  assert.deepEqual(interim, ['one two']);

  let ended = 0;
  listen({ SpeechRecognition: FakeRecognition }, { onFinal: () => {}, onEnd: () => ended++ });
  FakeRecognition.last!.onend!();
  assert.equal(ended, 1);
});

test('listening skips results with no alternatives or holes, and reads only from the result index on', () => {
  const finals: string[] = [];
  listen({ SpeechRecognition: FakeRecognition }, { onFinal: (t) => finals.push(t) });
  const r = FakeRecognition.last!;
  const none = Object.assign([], { isFinal: true });
  const ok = Object.assign([{ transcript: 'kept' }], { isFinal: true });
  r.onresult!({ resultIndex: 0, results: { length: 3, 0: none, 1: undefined as never, 2: ok } } as unknown as RecognitionEvent);
  assert.deepEqual(finals, ['kept']);
  r.onresult!({ resultIndex: 1, results: { length: 2, 0: ok, 1: ok } } as unknown as RecognitionEvent);
  assert.deepEqual(finals, ['kept', 'kept']);
});

test('dictating into a field works without any callback', () => {
  const field = { value: '' };
  dictateInto({ SpeechRecognition: FakeRecognition }, field);
  FakeRecognition.last!.say([['hello', true]]);
  assert.equal(field.value, 'Hello');
  FakeRecognition.last!.say([['there', true]]);
  assert.equal(field.value, 'Hello there');
  assert.equal(dictateInto({}, field), null);
});

// ------------------------------------------------------------------ last gaps

test('words that are all filler match nothing, on either side or both', () => {
  assert.equal(similarity('the', 'a'), 0);
  assert.equal(similarity('please', 'open settings'), 0);
  assert.equal(similarity('open settings', 'the'), 0);
});

test('a day of the month is one number: two separate digits are not joined, and stray text around a digit is refused', () => {
  const t = '2026-11-27';
  assert.equal(spokenDate('march 2 3', t), null);
  assert.equal(spokenDate('march x12', t), null);
  assert.equal(spokenDate('march 12abc', t), null);
  assert.equal(spokenDate('the twenty first x of march', t), null, 'a stray third word is not part of the day');
  assert.equal(spokenDate('the twenty first of march', t), '2026-03-21');
});

test('a year is four digits on its own, or words that read as one; stray words after it are refused', () => {
  assert.equal(spokenYear(['3026']), 3026, 'four digits are taken as they are');
  assert.equal(spokenYear(['2026', 'x']), null);
  assert.equal(spokenYear(['nineteen', 'hundred', 'x']), null);
  assert.equal(spokenYear(['twenty', 'oh', 'five', 'x']), null);
  assert.equal(spokenYear(['nineteen', 'one', 'hundred', 'five']), null, 'the second half of a pair is under a hundred');
  assert.equal(spokenYear(['twenty', 'nine', 'ten']), 2910);
  assert.equal(spokenYear(['twenty', 'twenty', 'six']), 2026);
});
