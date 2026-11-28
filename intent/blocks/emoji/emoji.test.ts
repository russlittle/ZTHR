import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CustomRegistry, EmojiError, ReactionError, Reactions, Shortcodes, canTone, extractEmoji, graphemesOf, isEmoji, isModifierBase, renderHtml, stripTone, toneOf, withTone,
} from './index.ts';
import type { Tone } from './index.ts';

const u = (...cps: number[]) => String.fromCodePoint(...cps);
const codes = new Shortcodes();
const THUMB = u(0x1f44d);
const ENGLAND = u(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f);

// ------------------------------------------------------------ detection

test('what counts as an emoji: pictographs, flags, keycaps, joined and toned sequences, but not digits, letters or bare symbols', () => {
  const yes = ['😀', u(0x1f44d, 0x1f3fd), u(0x1f1fa, 0x1f1f8), u(0x31, 0xfe0f, 0x20e3), u(0x2764, 0xfe0f), u(0x1f9d1, 0x200d, 0x1f4bb), u(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467), ENGLAND, u(0xa9, 0xfe0f), '⭐'];
  const no = ['a', '1', '#', '©', '™', ' ', '', '中', u(0x2764), '٣', 'é', 'ab'.repeat(30)];
  for (const e of yes) assert.equal(isEmoji(e), true, [...e].map((c) => c.codePointAt(0)!.toString(16)).join(' '));
  for (const t of no) assert.equal(isEmoji(t), false, JSON.stringify(t.slice(0, 10)));
});

test('emoji are found in a text by grapheme, so a toned or joined emoji is one, and two flags are two', () => {
  const text = `ok ${u(0x1f44d, 0x1f3fd)} and ${THUMB}, flags ${u(0x1f1eb, 0x1f1f7)}${u(0x1f1e9, 0x1f1ea)} dev ${u(0x1f9d1, 0x200d, 0x1f4bb)} 1 2 #`;
  assert.deepEqual(extractEmoji(text), [u(0x1f44d, 0x1f3fd), THUMB, u(0x1f1eb, 0x1f1f7), u(0x1f1e9, 0x1f1ea), u(0x1f9d1, 0x200d, 0x1f4bb)]);
  assert.equal(graphemesOf(`${ENGLAND}!`).length, 2);
  assert.deepEqual(extractEmoji('no emoji here, 100% plain'), []);
});

// ------------------------------------------------------------ skin tones

test('modifier bases follow the Unicode list', () => {
  for (const cp of [0x1f44d, 0x1f9d1, 0x261d, 0x270b, 0x1f64f, 0x1faf0, 0x1f385]) assert.equal(isModifierBase(cp), true, cp.toString(16));
  for (const cp of [0x1f600, 0x1f355, 0x1f3fb, 0x1f525, 0x2764, 0x1f697]) assert.equal(isModifierBase(cp), false, cp.toString(16));
});

test('a tone goes after the person or hand, replaces a variation selector, and replaces an earlier tone', () => {
  assert.equal(withTone(THUMB, 4), u(0x1f44d, 0x1f3fd));
  assert.equal(withTone(THUMB, 2), u(0x1f44d, 0x1f3fb));
  assert.equal(withTone(THUMB, 6), u(0x1f44d, 0x1f3ff));
  assert.equal(withTone(u(0x261d, 0xfe0f), 3), u(0x261d, 0x1f3fc), 'the variation selector is dropped');
  assert.equal(withTone(u(0x1f44d, 0x1f3fd), 6), u(0x1f44d, 0x1f3ff));
  assert.equal(withTone(u(0x1f44d, 0x1f3fd), undefined), THUMB, 'no tone strips it');
  assert.equal(withTone(u(0x1f9d1, 0x200d, 0x1f4bb), 5), u(0x1f9d1, 0x1f3fe, 0x200d, 0x1f4bb));
  assert.equal(withTone(u(0x1f9d1, 0x200d, 0x1f91d, 0x200d, 0x1f9d1), 3), u(0x1f9d1, 0x1f3fc, 0x200d, 0x1f91d, 0x200d, 0x1f9d1, 0x1f3fc), 'both people');
});

test('faces, objects, flags and families take no tone and are returned as they are', () => {
  const family = u(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  for (const e of ['😀', '🍕', u(0x1f1fa, 0x1f1f8), '❤️', family]) {
    assert.equal(canTone(e), false, e);
    assert.equal(withTone(e, 3), e, e);
  }
  assert.equal(canTone(THUMB), true);
  assert.equal(canTone(u(0x1f9d1, 0x200d, 0x1f4bb)), true);
  assert.throws(() => withTone(THUMB, 7 as Tone), /2 to 6/);
});

test('the tone of an emoji can be read back', () => {
  assert.equal(toneOf(u(0x1f44d, 0x1f3fb)), 2);
  assert.equal(toneOf(u(0x1f44d, 0x1f3ff)), 6);
  assert.equal(toneOf(THUMB), undefined);
  assert.equal(stripTone(u(0x1f9d1, 0x1f3fe, 0x200d, 0x1f4bb)), u(0x1f9d1, 0x200d, 0x1f4bb));
});

// ------------------------------------------------------------ shortcodes

test('the built-in table is large, every entry is one real emoji, and names are plain', () => {
  assert.ok(codes.size >= 190, `only ${codes.size} names`);
  for (const n of codes.names()) {
    assert.match(n, /^[a-z0-9_+-]{1,64}$/);
    const e = codes.emoji(n)!;
    assert.equal(graphemesOf(e).length, 1, `:${n}:`);
    assert.equal(isEmoji(e), true, `:${n}:`);
  }
});

test('names and aliases resolve to the same emoji, and the reverse gives the canonical name even through a tone', () => {
  assert.equal(codes.emoji('+1'), THUMB);
  assert.equal(codes.emoji(':thumbsup:'), THUMB);
  assert.equal(codes.emoji('thumbs_up'), THUMB);
  assert.equal(codes.emoji('nope'), undefined);
  assert.equal(codes.nameOf(THUMB), '+1');
  assert.equal(codes.nameOf(u(0x1f44d, 0x1f3fd)), '+1');
  assert.equal(codes.shortcodeFor(u(0x1f44d, 0x1f3fd)), ':+1::skin-tone-4:');
  assert.equal(codes.shortcodeFor(THUMB), ':+1:');
  assert.equal(codes.nameOf(u(0x2764)), 'heart', 'a heart without its selector is still the heart');
  assert.equal(codes.shortcodeFor('🧿'), undefined);
  assert.equal(codes.emoji('flag_us'), u(0x1f1fa, 0x1f1f8));
});

test('shortcodes in text become emoji, with Slack-style tones, a default tone, and code left alone', () => {
  assert.equal(codes.replace('Hi :wave: team :tada:'), `Hi ${u(0x1f44b)} team ${u(0x1f389)}`);
  assert.equal(codes.replace(':wave::skin-tone-4:'), u(0x1f44b, 0x1f3fd));
  assert.equal(codes.replace(':+1::skin-tone-2: :+1:', { defaultTone: 6 }), `${u(0x1f44d, 0x1f3fb)} ${u(0x1f44d, 0x1f3ff)}`);
  assert.equal(codes.replace(':smile::skin-tone-3:'), '😄', 'a tone on a face is dropped');
  assert.equal(codes.replace('Meet at 10:30:45 or :nosuchthing: ok'), 'Meet at 10:30:45 or :nosuchthing: ok');
  assert.equal(codes.replace('see `:fire:` and ```\n:fire:\n``` but :fire:'), 'see `:fire:` and ```\n:fire:\n``` but 🔥');
  assert.equal(codes.replace(':fire::fire::fire:'), '🔥🔥🔥');
  assert.equal(codes.replace(':+1:'), THUMB);
});

test('emoji in text can be turned back into shortcodes, tones included', () => {
  assert.equal(codes.toShortcodes(`Great ${u(0x1f44d, 0x1f3fd)} ${u(0x1f525)} 100%`), 'Great :+1::skin-tone-4: :fire: 100%');
  assert.equal(codes.toShortcodes('🧿 stays'), '🧿 stays');
  assert.equal(codes.replace(codes.toShortcodes('x 👍🏿 y 🚀')), 'x 👍🏿 y 🚀');
});

test('adding names checks the emoji and refuses names that clash or are reserved', () => {
  const c = new Shortcodes();
  c.add(['evil_eye', 'nazar'], '🧿');
  assert.equal(c.emoji('nazar'), '🧿');
  assert.equal(c.nameOf('🧿'), 'evil_eye');
  assert.throws(() => c.add(['fire'], '🧿'), /already means/);
  assert.throws(() => c.add(['x'], 'ab'), /exactly one emoji/);
  assert.throws(() => c.add(['x'], '🔥🔥'), /exactly one emoji/);
  assert.throws(() => c.add(['skin-tone-3'], '🧿'), /not a usable shortcode/);
  for (const bad of ['Upper', 'has space', '', 'a:b', 'x'.repeat(65)]) assert.throws(() => c.add([bad], '🧿'), EmojiError, bad);
  c.add(['fire'], '🔥');
  assert.equal(new Shortcodes([[['custom_one'], '🧿']]).emoji('custom_one'), '🧿');
});

// ------------------------------------------------------------ custom emoji

const reg = () => new CustomRegistry(codes, () => 5);

test('custom emoji have checked names and https images, aliases, and cannot shadow a built-in or each other', () => {
  const r = reg();
  const c = r.add({ name: 'blobcat', url: 'https://cdn.example/blobcat.png', aliases: ['bc'], category: 'cats', createdBy: 'ana' });
  assert.deepEqual({ ...c }, { name: 'blobcat', url: 'https://cdn.example/blobcat.png', animated: false, aliases: ['bc'], category: 'cats', createdBy: 'ana', createdAt: 5, disabled: false });
  assert.equal(r.find(':bc:')?.name, 'blobcat');
  assert.equal(r.find('constructor'), undefined);
  assert.throws(() => r.add({ name: 'fire', url: 'https://x.example/a.png', createdBy: 'a' }), /built-in emoji name/);
  assert.throws(() => r.add({ name: 'blobcat', url: 'https://x.example/a.png', createdBy: 'a' }), /already taken/);
  assert.throws(() => r.add({ name: 'bc', url: 'https://x.example/a.png', createdBy: 'a' }), /already taken/);
  assert.throws(() => r.add({ name: 'other', aliases: ['other'], url: 'https://x.example/a.png', createdBy: 'a' }), /listed twice|already taken/);
  for (const name of ['A', 'a', 'has space', 'a:b', 'x'.repeat(33), '+1']) assert.throws(() => r.add({ name, url: 'https://x.example/a.png', createdBy: 'a' }), /not a usable name/, name);
  for (const url of ['http://x.example/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '//x.example/a.png', 'https://user:pw@x.example/a.png', 'not a url']) assert.throws(() => r.add({ name: 'okname', url, createdBy: 'a' }), /https address/, url);
});

test('custom emoji can be disabled, removed and listed by category', () => {
  const r = reg();
  r.add({ name: 'aa', url: 'https://x.example/a.png', category: 'x', createdBy: 'a' });
  r.add({ name: 'bb', url: 'https://x.example/b.png', animated: true, createdBy: 'a' });
  r.setDisabled('aa', true);
  assert.deepEqual(r.list().map((c) => c.name), ['bb']);
  assert.deepEqual(r.list({ includeDisabled: true }).map((c) => c.name), ['aa', 'bb']);
  assert.deepEqual(r.list({ includeDisabled: true, category: 'x' }).map((c) => c.name), ['aa']);
  r.remove('bb');
  assert.throws(() => r.remove('bb'), /no custom emoji/);
  assert.throws(() => r.setDisabled('zz', true), /no custom emoji/);
});

// ------------------------------------------------------------ html

test('rendering escapes everything, puts emoji and custom images in, and keeps code literal', () => {
  const r = reg();
  r.add({ name: 'blobcat', url: 'https://cdn.example/b.png?a=1&b="2"', createdBy: 'a' });
  r.add({ name: 'gone', url: 'https://cdn.example/g.png', createdBy: 'a' });
  r.setDisabled('gone', true);
  const html = renderHtml('<script>alert(1)</script> & :smile: :blobcat: :gone: :unknown: `:smile: <b>` ok', codes, r);
  assert.equal(
    html,
    '&lt;script&gt;alert(1)&lt;/script&gt; &amp; 😄 <img class="emoji" src="https://cdn.example/b.png?a=1&amp;b=&quot;2&quot;" alt=":blobcat:" title=":blobcat:" draggable="false"> :gone: :unknown: <code>:smile: &lt;b&gt;</code> ok',
  );
  assert.equal(renderHtml(':wave::skin-tone-5:', codes), u(0x1f44b, 0x1f3fe));
  assert.equal(renderHtml(':blobcat:', codes), ':blobcat:', 'without a registry a custom name is just text');
  assert.ok(!renderHtml('":x onerror=alert(1)"', codes, r).includes('<'));
});

// ------------------------------------------------------------ reactions

const make = (o: Partial<ConstructorParameters<typeof Reactions>[0]> = {}) => new Reactions({ codes, ...o });

test('reactions are added once per person, counted, ordered by first use, and shown with the viewer\'s own', () => {
  const r = make();
  assert.equal(r.react('m1', 'ana', '👍'), true);
  assert.equal(r.react('m1', 'bo', ':fire:'), true);
  assert.equal(r.react('m1', 'cy', ':+1:'), true, 'a shortcode is the same as the character');
  assert.equal(r.react('m1', 'ana', '👍'), false, 'twice is a no-op');
  assert.deepEqual(r.summary('m1', 'ana'), [
    { emoji: '👍', count: 2, me: true, users: ['ana', 'cy'], custom: false },
    { emoji: '🔥', count: 1, me: false, users: ['bo'], custom: false },
  ]);
  assert.deepEqual(r.summary('m1').map((s) => s.me), [false, false]);
  assert.deepEqual(r.summary('m1', 'ana', { maxUsers: 1 })[0]?.users, ['ana']);
  assert.deepEqual(r.summary('nothing'), []);
});

test('removing and toggling work, and a reaction nobody holds disappears', () => {
  const r = make();
  r.react('m1', 'ana', '🔥');
  assert.equal(r.unreact('m1', 'bo', '🔥'), false);
  assert.equal(r.unreact('m1', 'ana', '🔥'), true);
  assert.equal(r.unreact('m1', 'ana', '🔥'), false);
  assert.deepEqual(r.summary('m1'), []);
  assert.equal(r.toggle('m1', 'ana', '🚀'), true);
  assert.equal(r.toggle('m1', 'ana', '🚀'), false);
  assert.deepEqual(r.summary('m1'), []);
});

test('only one emoji can be a reaction, and unknown shortcodes are refused', () => {
  const r = make();
  for (const bad of ['', 'hi', '1', '👍👍', ':nosuch:', '<b>', '👍 x', ':fire']) assert.throws(() => r.react('m', 'a', bad), ReactionError, JSON.stringify(bad));
  assert.equal(r.react('m', 'a', u(0x2764, 0xfe0f)), true);
});

test('limits: different reactions per message, and reactions per person', () => {
  const r = make({ maxDistinct: 3, maxPerUser: 2 });
  r.react('m', 'ana', '🔥');
  r.react('m', 'ana', '🚀');
  assert.throws(() => r.react('m', 'ana', '🎉'), /at most 2 reactions/);
  r.react('m', 'bo', '🎉');
  assert.throws(() => r.react('m', 'cy', '💯'), /at most 3 different reactions/);
  assert.equal(r.react('m', 'cy', '🔥'), true, 'joining an existing reaction is always allowed');
  r.unreact('m', 'bo', '🎉');
  assert.equal(r.react('m', 'cy', '💯'), true, 'room is freed when a reaction disappears');
});

test('tones are separate reactions unless folded', () => {
  const plain = make();
  plain.react('m', 'a', THUMB);
  plain.react('m', 'b', u(0x1f44d, 0x1f3fd));
  assert.equal(plain.summary('m').length, 2);
  const folded = make({ foldTones: true });
  folded.react('m', 'a', THUMB);
  folded.react('m', 'b', u(0x1f44d, 0x1f3fd));
  assert.deepEqual(folded.summary('m').map((s) => [s.emoji, s.count]), [[THUMB, 2]]);
  assert.equal(folded.unreact('m', 'b', u(0x1f44d, 0x1f3ff)), true, 'any tone finds the same reaction');
});

test('an allow list restricts reactions to its emoji, by character or name', () => {
  const r = make({ allowed: ['👍', ':fire:', '🎉'] });
  assert.equal(r.react('m', 'a', ':+1:'), true);
  assert.equal(r.react('m', 'a', '🔥'), true);
  assert.throws(() => r.react('m', 'a', '🚀'), /not on the list/);
});

test('custom emoji work as reactions while enabled, and are shown by name', () => {
  const c = reg();
  c.add({ name: 'blobcat', url: 'https://cdn.example/b.png', createdBy: 'a' });
  const r = make({ custom: c });
  assert.equal(r.react('m', 'a', ':blobcat:'), true);
  assert.deepEqual(r.summary('m', 'a'), [{ emoji: ':blobcat:', count: 1, me: true, users: ['a'], custom: true }]);
  c.setDisabled('blobcat', true);
  assert.throws(() => r.react('m', 'b', ':blobcat:'), /there is no emoji/);
  assert.throws(() => make().react('m', 'b', ':blobcat:'), /there is no emoji/);
});

test('most used emoji, clearing a message, and forgetting a person', () => {
  const r = make();
  for (const m of ['1', '2', '3']) r.react(m, 'ana', '👍');
  for (const m of ['1', '2']) r.react(m, 'ana', '🔥');
  r.react('1', 'ana', '🚀');
  r.react('1', 'bo', '👍');
  assert.deepEqual(r.frequent('ana'), ['\u{1F44D}', '\u{1F525}', '\u{1F680}']);
  assert.deepEqual(r.frequent('ana', 2), ['\u{1F44D}', '\u{1F525}']);
  assert.deepEqual(r.frequent('nobody'), []);
  r.clear('2');
  assert.deepEqual(r.summary('2'), []);
  assert.equal(r.forget('ana'), 4, 'four reactions remained after message 2 was cleared');
  assert.deepEqual(r.summary('1').map((s) => [s.emoji, s.users]), [['👍', ['bo']]]);
  assert.deepEqual(r.frequent('ana'), []);
  assert.deepEqual(r.summary('3'), []);
});
