import assert from 'node:assert/strict';
import { test } from 'node:test';
import { I18n, chain, direction, fmt, negotiate } from './index.ts';

const i = new I18n(
  {
    en: { files: { '=0': 'No files', one: '{count} file', other: '{count} files' }, hello: 'Hello, {name}', bye: 'Bye' },
    fr: { files: { one: '{count} fichier', other: '{count} fichiers' }, hello: 'Bonjour, {name}' },
    ar: { files: { one: 'ملف واحد', other: '{count} ملفات' }, hello: 'مرحبا {name}', bye: 'وداعا', extra: 'x' },
  },
  'en',
);

test('plurals follow each language, values are formatted for it, and fallbacks are reported', () => {
  assert.equal(i.t('en', 'files', { count: 0 }), 'No files');
  assert.equal(i.t('en', 'files', { count: 1 }), '1 file');
  assert.equal(i.t('en', 'files', { count: 1200 }), '1,200 files');
  assert.equal(i.t('fr', 'files', { count: 0 }), '0 fichier', 'French treats 0 as singular');
  assert.equal(i.t('fr', 'files', { count: 1200 }), '1 200 fichiers');
  assert.equal(i.t('fr-CA', 'hello', { name: 'Ana' }), 'Bonjour, Ana');
  assert.equal(i.t('fr', 'bye'), 'Bye');
  assert.ok(i.missing.has('fr:bye') && i.missing.has('fr-CA:hello'));
  assert.throws(() => i.t('en', 'hello'), /needs \{name\}/);
  assert.throws(() => i.t('en', 'files'), /needs a count/);
  assert.throws(() => i.t('en', 'nope'), /no message/);
});

test('the check lists missing keys, extras and the plural forms a language needs', () => {
  const c = i.check();
  assert.deepEqual(c.fr, { missing: ['bye'], extra: [], plurals: ['files.many'] });
  assert.deepEqual(c.ar!.extra, ['extra']);
  assert.deepEqual(c.ar!.plurals, ['files.few', 'files.many', 'files.two', 'files.zero']);
});

test('negotiation, chains, direction and Intl formatting', () => {
  assert.equal(negotiate('de-CH, fr-CA;q=0.8, en;q=0.5', ['en', 'fr', 'ar'], 'en'), 'fr');
  assert.equal(negotiate(undefined, ['en'], 'en'), 'en');
  assert.equal(negotiate('*;q=0, ar-EG', ['en', 'ar'], 'en'), 'ar');
  assert.deepEqual(chain('zh-Hant-TW', 'en'), ['zh-Hant-TW', 'zh-Hant', 'zh', 'en']);
  assert.equal(direction('ar-EG'), 'rtl');
  assert.equal(direction('en'), 'ltr');
  assert.equal(fmt.money('en-US', 123456, 'USD'), '$1,234.56');
  assert.equal(fmt.money('ja-JP', 1500, 'JPY'), '￥1,500');
  assert.equal(fmt.list('en', ['Ana', 'Ben', 'Cy']), 'Ana, Ben, and Cy');
  assert.equal(fmt.relative('en', new Date('2026-11-23T00:00:00Z'), new Date('2026-11-26T00:00:00Z')), '3 days ago');
  assert.equal(fmt.date('en-GB', new Date('2026-11-26T03:00:00Z'), 'America/Los_Angeles'), '25 Nov 2026');
});

test('direction follows the script, not only the language', () => {
  assert.equal(direction('ckb'), 'rtl', 'Central Kurdish is written in Arabic script');
  assert.equal(direction('az-Arab'), 'rtl');
  assert.equal(direction('sd-Deva'), 'ltr', 'Sindhi in Devanagari runs left to right');
  assert.equal(direction('syr'), 'rtl');
  assert.equal(direction('not a locale!'), 'ltr');
});

test('keys and values are looked up as own properties only', () => {
  assert.throws(() => i.t('en', 'constructor'), /no message/);
  assert.throws(() => i.t('en', 'toString', { count: 1 }), /no message/);
  const j = new I18n({ en: { hi: 'Hi {constructor}' } }, 'en');
  assert.throws(() => j.t('en', 'hi'), /needs \{constructor\}/);
});

test('negotiation prefers the plain language over a sibling region', () => {
  assert.equal(negotiate('en-US', ['en-GB', 'en'], 'fr'), 'en');
  assert.equal(negotiate('pt-BR', ['pt-PT', 'pt-BR'], 'en'), 'pt-BR');
});

// Intl.Locale.textInfo is present in this runtime, which hides the script and language-list fallbacks; these
// tests replace it with controlled variants so each fallback is exercised on its own.
function withLocale<T>(make: (Base: typeof Intl.Locale) => typeof Intl.Locale, run: () => T): T {
  const real = Intl.Locale;
  (Intl as { Locale: typeof Intl.Locale }).Locale = make(real);
  try {
    return run();
  } finally {
    (Intl as { Locale: typeof Intl.Locale }).Locale = real;
  }
}
const noInfo = (Base: typeof Intl.Locale) => class extends Base { get textInfo() { return undefined; } } as unknown as typeof Intl.Locale;

test('direction trusts the runtime text direction when it gives one', () => {
  const says = (dir: unknown) => (Base: typeof Intl.Locale) => class extends Base { get textInfo() { return { direction: dir }; } } as unknown as typeof Intl.Locale;
  assert.equal(withLocale(says('rtl'), () => direction('en')), 'rtl');
  assert.equal(withLocale(says('ltr'), () => direction('ar')), 'ltr');
  assert.equal(withLocale(says('sideways'), () => direction('ar')), 'rtl', 'an unknown value is ignored and the script decides');
  assert.equal(withLocale(says(undefined), () => direction('en')), 'ltr');
});

test('without runtime text direction, every right-to-left script is right-to-left and others are not', () => {
  for (const script of ['Arab', 'Hebr', 'Syrc', 'Thaa', 'Nkoo', 'Adlm', 'Rohg', 'Mand', 'Samr', 'Armi', 'Mend']) {
    assert.equal(withLocale(noInfo, () => direction(`und-${script}`)), 'rtl', script);
  }
  for (const tag of ['en', 'ja', 'ru', 'hi', 'zh-Hant']) assert.equal(withLocale(noInfo, () => direction(tag)), 'ltr', tag);
  assert.equal(withLocale(noInfo, () => direction('ckb')), 'rtl');
});

test('when no script can be worked out, the language list decides', () => {
  const noScript = (Base: typeof Intl.Locale) => class extends Base { get textInfo() { return undefined; } override maximize() { return { script: undefined } as unknown as Intl.Locale; } } as unknown as typeof Intl.Locale;
  assert.equal(withLocale(noScript, () => direction('ar')), 'rtl');
  assert.equal(withLocale(noScript, () => direction('en')), 'ltr');
  assert.equal(direction('qaa'), 'ltr', 'a language with no known script and not in the list');
});

test('a malformed tag falls back to the language list, case-insensitively', () => {
  for (const l of ['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'yi', 'dv', 'ug']) {
    assert.equal(direction(`${l}-`), 'rtl', l);
    assert.equal(direction(`${l.toUpperCase()}-`), 'rtl', `${l} upper-case`);
  }
  assert.equal(direction('en-'), 'ltr');
  assert.equal(direction('a-'), 'ltr', 'only the part before the first hyphen names the language');
});

test('the chain does not repeat the source language', () => {
  assert.deepEqual(chain('en', 'en'), ['en']);
  assert.deepEqual(chain('fr-CA', 'fr'), ['fr-CA', 'fr']);
  assert.deepEqual(chain('fr-CA', 'en'), ['fr-CA', 'fr', 'en']);
});

test('negotiation honours q values, spacing, and refusals', () => {
  const sup = ['fr', 'de', 'en'];
  assert.equal(negotiate('fr; q=0.1, de', sup, 'en'), 'de', 'a space before q is still a q value');
  assert.equal(negotiate('fr;q=0.1, de;q=0.9, en;q=0.5', sup, 'x'), 'de', 'highest q first');
  assert.equal(negotiate('fr;q=0.5, de;q=0.9', sup, 'x'), 'de');
  assert.equal(negotiate('de;q=0.9 , fr;q=0.1', sup, 'x'), 'de');
  assert.equal(negotiate('fr;q=0, en', sup, 'x'), 'en', 'q=0 means not acceptable');
  assert.equal(negotiate('fr;q=0', sup, 'x'), 'x');
  assert.equal(negotiate('fr;level=1, de;q=0.5', sup, 'x'), 'fr', 'a parameter that is not q does not set q');
  assert.equal(negotiate('fr;q=0.8;foo=1', sup, 'x'), 'fr');
  assert.equal(negotiate(' , ,de', sup, 'x'), 'de', 'empty entries are skipped');
  assert.equal(negotiate('', sup, 'x'), 'x');
  assert.equal(negotiate('ja', sup, 'x'), 'x');
});

test('negotiation prefers an exact match, then the plain language, then a sibling region', () => {
  assert.equal(negotiate('en-GB', ['en-GB', 'en'], 'x'), 'en-GB', 'exact beats plain even at the first position');
  assert.equal(negotiate('EN-gb', ['en-GB', 'en'], 'x'), 'en-GB', 'case-insensitive');
  assert.equal(negotiate('en-US', ['en-GB'], 'x'), 'en-GB', 'a sibling region when nothing better');
  assert.equal(negotiate('fr-CA', ['de', 'fr-BE'], 'x'), 'fr-BE');
  assert.equal(negotiate('fr-CA', ['de', 'frx'], 'x'), 'x', 'a different language that merely starts the same');
});

test('the source catalogue is required, and says which language', () => {
  assert.throws(() => new I18n({}, 'en'), /no catalogue for the source language en/);
  assert.throws(() => new I18n({ fr: {} }, 'en'), /source language en/);
});

test('only a message found in another language is reported as missing', () => {
  const j = new I18n({ en: { a: 'A' }, fr: { a: 'Un' } }, 'en');
  j.t('en', 'a');
  j.t('fr', 'a');
  assert.equal(j.missing.size, 0);
  assert.throws(() => j.t('fr', 'zzz'), /no message zzz in any language/);
  assert.ok(j.missing.has('fr:zzz'), 'a key found nowhere is reported');
});

test('plural forms fall back to other, and an unusable message falls through to the next language', () => {
  const j = new I18n({ en: { n: { one: '{count} item', other: '{count} items' } }, fr: { n: { many: 'beaucoup' } }, de: { m: { other: 'viele {count}' } } }, 'en');
  assert.equal(j.t('de', 'm', { count: 1 }), 'viele 1', 'no form for one, so other');
  assert.equal(j.t('fr', 'n', { count: 1 }), '1 item', 'French has no usable form for 1, so the source is used');
  assert.ok(j.missing.has('fr:n'));
  assert.equal(j.t('fr', 'n', { count: 1_000_000 }), 'beaucoup', 'a form French does have');
});

test('the check is for other languages, sorted, and counts only plural forms against plural sources', () => {
  const j = new I18n(
    {
      en: { z: 'Z', a: 'A', m: 'M', p: { one: '1', other: '2' }, q: { one: '1', other: '2' }, s: 'S' },
      de: { x: 'X', b: 'B', p: { one: '1' }, q: { one: '1' }, s: { one: '1' } },
      fr: { z: 'Z', a: 'A', m: 'M', s: 'S', p: { one: 'a', other: 'b' }, q: 'plain' },
    },
    'en',
  );
  const c = j.check();
  assert.deepEqual(Object.keys(c), ['de', 'fr'], 'the source language is not checked against itself');
  assert.deepEqual(c.de!.missing, ['a', 'm', 'z']);
  assert.deepEqual(c.de!.extra, ['b', 'x']);
  assert.deepEqual(c.de!.plurals, ['p.other', 'q.other'], 'sorted across keys; a plural object where the source is a string is not checked');
  assert.deepEqual(c.fr!.missing, []);
  assert.deepEqual(c.fr!.plurals.filter((x) => x.startsWith('p.')), ['p.many'], 'French needs many');
});

test('numbers, lists, money and relative times are formatted for the reader', () => {
  assert.equal(fmt.number('de-DE', 1234.5), '1.234,5');
  assert.equal(fmt.number('en', 0.256, { style: 'percent' }), '26%');
  assert.equal(fmt.money('en', 1234567, 'KWD'), 'KWD\u00a01,234.567', 'three minor digits');
  assert.equal(fmt.money('en', 5, 'USD'), '$0.05');
  assert.equal(fmt.list('en', ['Ana', 'Ben', 'Cy'], 'disjunction'), 'Ana, Ben, or Cy');
  assert.equal(fmt.date('en-GB', new Date('2026-11-26T03:00:00Z'), 'UTC', { dateStyle: 'short' }), '26/11/2026');
});

test('relative times pick the largest unit that fits, at its boundary', () => {
  const now = new Date('2030-01-01T00:00:00Z');
  const ago = (s: number) => fmt.relative('en', new Date(now.getTime() - s * 1000), now);
  const ahead = (s: number) => fmt.relative('en', new Date(now.getTime() + s * 1000), now);
  assert.equal(ago(0), 'now');
  assert.equal(ago(0.4), 'now');
  assert.equal(ago(1), '1 second ago');
  assert.equal(ago(59), '59 seconds ago');
  assert.equal(ago(60), '1 minute ago');
  assert.equal(ago(3600), '1 hour ago');
  assert.equal(ago(86_400), 'yesterday');
  assert.equal(ahead(86_400), 'tomorrow');
  assert.equal(ago(604_800), 'last week');
  assert.equal(ago(2_592_000), 'last month');
  assert.equal(ago(31_536_000), 'last year');
  assert.equal(ahead(2 * 3600), 'in 2 hours');
  assert.equal(ahead(3 * 604_800), 'in 3 weeks');
});

test('negotiation tolerates spaces around the tag and inside the q parameter', () => {
  assert.equal(negotiate('fr ;q=1', ['fr'], 'x'), 'fr');
  assert.equal(negotiate('fr; q=0.9, de;q=0.5', ['de', 'fr'], 'x'), 'fr');
});

test('the check sorts plural gaps by key even when the language lists its keys out of order', () => {
  const j = new I18n({ en: { a: { one: '1', other: '2' }, b: { one: '1', other: '2' } }, de: { b: { one: '1' }, a: { one: '1' } } }, 'en');
  assert.deepEqual(j.check().de!.plurals, ['a.other', 'b.other']);
});
