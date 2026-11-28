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
