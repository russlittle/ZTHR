import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAddress, formatAddress, greeting, name, phone, sortNames } from './index.ts';

test('names are kept as written, with a name to use and a sort key, never split by guesswork', () => {
  const n = name('  María-José   de la Cruz ', { callMe: 'Majo', sortAs: 'Cruz, María-José de la' });
  assert.equal(n.full, 'María-José de la Cruz');
  assert.equal(greeting(n), 'Majo');
  assert.equal(greeting(name('毛泽东')), '毛泽东');
  assert.deepEqual(sortNames([name('zoe'), n, name('Ängel')]).map((x) => x.full), ['Ängel', 'María-José de la Cruz', 'zoe']);
  assert.throws(() => name('   '), /empty/);
  assert.throws(() => name('<b>x</b>'), /angle brackets/);
});

test('addresses format in their country’s order and postcodes are checked by country', () => {
  assert.deepEqual(formatAddress({ country: 'US', lines: ['1600 Main St', 'Apt 2'], city: 'Dayton', region: 'oh', postcode: '45402' }), ['1600 Main St', 'Apt 2', 'Dayton, OH 45402']);
  assert.deepEqual(formatAddress({ country: 'DE', lines: ['Unter den Linden 77'], city: 'Berlin', postcode: '10117' }, 'US'), ['Unter den Linden 77', '10117 Berlin', 'GERMANY']);
  assert.deepEqual(formatAddress({ country: 'JP', lines: ['1-1 Chiyoda'], city: 'Chiyoda-ku', region: 'Tokyo', postcode: '100-0001' }), ['〒100-0001', 'TokyoChiyoda-ku', '1-1 Chiyoda']);
  assert.deepEqual(formatAddress({ country: 'GB', lines: ['10 Downing St'], city: 'London', postcode: 'sw1a 2aa' }), ['10 Downing St', 'LONDON', 'SW1A 2AA']);
  assert.deepEqual(checkAddress({ country: 'GB', lines: ['x'], postcode: '12345' }), ['12345 is not a United Kingdom postcode']);
  assert.deepEqual(checkAddress({ country: 'CA', lines: [''] }), ['add a street address', 'Canada addresses need a postcode']);
  assert.deepEqual(checkAddress({ country: 'ZZ', lines: ['Somewhere'] }), [], 'an unknown country is not refused');
});

test('phone numbers become E.164 from what people type', () => {
  assert.equal(phone('(937) 555-0142', 'US'), '+19375550142');
  assert.equal(phone('1-937-555-0142 ext. 12', 'US'), '+19375550142');
  assert.equal(phone('020 7946 0018', 'GB'), '+442079460018');
  assert.equal(phone('0044 20 7946 0018', 'US'), '+442079460018');
  assert.equal(phone('+33 6 12 34 56 78', 'GB'), '+33612345678');
  assert.equal(phone('06 12 34 56 78', 'FR'), '+33612345678');
  assert.throws(() => phone('555-0142', 'US'), /10 digits/);
  assert.throws(() => phone('call me', 'US'), /letters/);
  assert.throws(() => phone('12345', 'ZZ'), /country code/);
});
