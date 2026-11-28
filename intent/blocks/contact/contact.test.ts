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

test('the national "(0)" written after a country code is dropped, and extensions written straight on are understood', () => {
  assert.equal(phone('+44 (0)20 7946 0018', 'US'), '+442079460018');
  assert.equal(phone('0044 (0) 20 7946 0018', 'FR'), '+442079460018');
  assert.equal(phone('937-555-0142x12', 'US'), '+19375550142');
  assert.throws(() => phone('+0 123 456 789', 'US'), /international/);
  assert.throws(() => phone('020 7946 0018', 'constructor'), /country code/);
});

test('the name to use and the sort key are checked like the name, and invisible controls are refused', () => {
  assert.throws(() => name('Ana', { callMe: '<img src=x onerror=alert(1)>' }), /angle brackets/);
  assert.throws(() => name('Ana', { sortAs: 'a\u0000b' }), /control/);
  assert.throws(() => name('Ana‮gnp.exe'), /control/);
  assert.throws(() => name('Ana\u0085'), /control/);
});

test('address values are inserted literally, never read as patterns or placeholders', () => {
  assert.deepEqual(formatAddress({ country: 'US', lines: ['1 Main St'], city: "Dayton $&$'", region: 'oh', postcode: '45402' }), ['1 Main St', "Dayton $&$', OH 45402"]);
  assert.deepEqual(formatAddress({ country: 'DE', lines: ['x'], city: '{postcode}', postcode: '10117' }), ['x', '10117 {postcode}']);
  assert.deepEqual(formatAddress({ country: 'constructor', lines: ['x'], city: 'Y' }), ['x', 'Y']);
  assert.deepEqual(checkAddress({ country: 'toString', lines: ['x'] }), []);
});

test('phone turns full-width and other Unicode digits into ASCII digits, never dropping them', () => {
  assert.throws(() => phone('(937) 555-01１91', 'US'), /10 digits/, 'the full-width 1 is an eleventh digit, counted, not dropped');
  assert.equal(phone('９３７５５５０１９１', 'US'), '+19375550191');
  assert.equal(phone('(937) 555-0191', 'US'), '+19375550191');
  assert.equal(phone('٩٣٧ ٥٥٥ ٠١٩١', 'US'), '+19375550191');
  assert.equal(phone('+４４ ２０ ７９４６ ０９５８', 'GB'), '+442079460958');
});

test('a name, the name to use and the sort key each allow 300 characters and say which one is too long', () => {
  assert.equal(name('a'.repeat(300)).full.length, 300);
  assert.equal(name(` ${'a'.repeat(300)} `).full.length, 300, 'surrounding space is not counted');
  assert.throws(() => name('a'.repeat(301)), { message: 'a name can be at most 300 characters' });
  assert.throws(() => name('Ana', { callMe: 'a'.repeat(301) }), { message: 'the name to use can be at most 300 characters' });
  assert.throws(() => name('Ana', { sortAs: 'a'.repeat(301) }), { message: 'the sort key can be at most 300 characters' });
  assert.equal(name('Ana', { callMe: 'a'.repeat(300), sortAs: 'a'.repeat(300) }).sortAs!.length, 300);
  assert.throws(() => name('a<b'), { message: 'a name cannot contain control characters or angle brackets' });
  assert.throws(() => name('Ana', { callMe: 'a>' }), { message: 'the name to use cannot contain control characters or angle brackets' });
  assert.throws(() => name('Ana', { sortAs: 'a\u0007' }), { message: 'the sort key cannot contain control characters or angle brackets' });
  assert.throws(() => name(''), { message: 'a name cannot be empty' });
});

test('a name carries only the parts it was given', () => {
  assert.deepEqual(name('Ana'), { full: 'Ana' });
  assert.deepEqual(name('Ana', { callMe: 'A' }), { full: 'Ana', callMe: 'A' });
  assert.deepEqual(name('Ana', { sortAs: 'Ana (sort)' }), { full: 'Ana', sortAs: 'Ana (sort)' });
  assert.deepEqual(name('Ana', { callMe: ' B  b ', sortAs: ' C ' }), { full: 'Ana', callMe: 'B b', sortAs: 'C' });
  assert.deepEqual(name('Ana', { callMe: '', sortAs: '  ' }), { full: 'Ana' });
  assert.equal(greeting(name('Ana', { callMe: '' })), 'Ana');
});

test('names sort by their sort key when they have one, ignoring case and accents, and by the given locale', () => {
  const order = (list: ReturnType<typeof name>[], locale?: string) => sortNames(list, locale).map((n) => n.full);
  assert.deepEqual(order([name('Zed'), name('Anna', { sortAs: 'Zzz' })]), ['Zed', 'Anna']);
  assert.deepEqual(order([name('Anna', { sortAs: 'Zzz' }), name('Zed')]), ['Zed', 'Anna']);
  assert.deepEqual(order([name('Zed', { sortAs: 'Aaa' }), name('Anna')]), ['Zed', 'Anna']);
  assert.deepEqual(order([name('B'), name('b'), name('a'), name('á')]), ['a', 'á', 'B', 'b']);
  assert.deepEqual(order([name('b'), name('B')]), ['b', 'B']);
  assert.deepEqual(order([name('B'), name('b')]), ['B', 'b']);
  assert.deepEqual(order([name('zoe'), name('Ängel')]), ['Ängel', 'zoe']);
  assert.deepEqual(order([name('zoe'), name('Ängel')], 'sv'), ['zoe', 'Ängel']);
  const input = [name('b')];
  sortNames(input);
  assert.equal(input.length, 1);
});

const POSTCODES: Record<string, { ok: string[]; bad: string[]; name: string }> = {
  US: { name: 'United States', ok: ['45402', '45402-1234', ' 45402 '], bad: ['4540', '454021', 'x45402', '45402x', '45402-', '45402-123', '45402-12345', 'abcde', '45402-abcd', '45402-1'] },
  CA: { name: 'Canada', ok: ['M5V 2T6', 'm5v2t6', 'K1A 0B1'], bad: ['M5V  2T6', 'xM5V 2T6', 'M5V 2T6x', '5MV 2T6', 'MXV 2T6', 'M5V 2T', 'M5V 2TT', 'M5V X2T6', 'M5V 2TX', 'M5V 2T66', '55V 2T6', 'M5 2T6'] },
  GB: { name: 'United Kingdom', ok: ['SW1A 2AA', 'sw1a2aa', 'M1 1AE', 'M60 1NW', 'B33 8TH', 'CR2 6XH', 'DN55 1PT'], bad: ['xSW1A 2AA', 'SW1A 2AAx', 'SW1A  2AA', 'SW1A 2A', 'SW1A 2AAA', 'SWW1A 2AA', 'SWWW1 2AA', '1 2AA', 'SWA 2AA', 'SW1A A2AA', 'SW1A 22A', 'SW1A 2A2', 'SW1A 2', '12345', 'SW1-A 2AA', 'SW1AB 2AA'] },
  DE: { name: 'Germany', ok: ['10117', '01067'], bad: ['1011', '101170', 'x10117', '10117x', 'abcde'] },
  FR: { name: 'France', ok: ['75001'], bad: ['7500', '750011', 'x75001', '75001x', 'abcde'] },
  JP: { name: 'Japan', ok: ['100-0001', '1000001'], bad: ['10-0001', '1000-0001', '100-001', '100-00011', 'x100-0001', '100-0001x', '100 0001', 'abc-defg', '100--0001', '100-abcd', '10000011'] },
  IN: { name: 'India', ok: ['110001'], bad: ['11000', '1100011', 'x110001', '110001x', 'abcdef'] },
  AU: { name: 'Australia', ok: ['2000', '0800'], bad: ['200', '20000', 'x2000', '2000x', 'abcd'] },
  BR: { name: 'Brazil', ok: ['01310-100', '01310100'], bad: ['0131-100', '013100-100', '01310-10', '01310-1000', 'x01310-100', '01310-100x', '01310 100', 'abcde-fgh', '01310-abc', '01310--100', '013101000'] },
  IE: { name: 'Ireland', ok: ['D02 AF30', 'd02af30', 'A65 F4E2', 'D6W 1234', 'T12 ABCD'], bad: ['xD02 AF30', 'D02 AF30x', 'D02  AF30', '102 AF30', 'D0X AF30', 'DD2 AF30', 'D02 AF3', 'D02 AF300', 'D02 AF3-', 'D02-AF30', 'D0 AF30', 'D02 AF3!'] },
};

test('every country accepts its own postcode shapes, with or without the optional parts, and refuses near misses', () => {
  for (const [country, { ok, bad, name: label }] of Object.entries(POSTCODES)) {
    for (const postcode of ok) assert.deepEqual(checkAddress({ country, lines: ['x'], postcode }), [], `${country} ${postcode}`);
    for (const postcode of bad) assert.deepEqual(checkAddress({ country, lines: ['x'], postcode }), [`${postcode} is not a ${label} postcode`], `${country} ${postcode}`);
    assert.deepEqual(checkAddress({ country, lines: ['x'] }), [`${label} addresses need a postcode`]);
    assert.deepEqual(checkAddress({ country, lines: ['x'], postcode: '' }), [`${label} addresses need a postcode`]);
  }
});

test('address checks: a street line must have something in it, and the postcode is judged without surrounding space', () => {
  assert.deepEqual(checkAddress({ country: 'ZZ', lines: [] }), ['add a street address']);
  assert.deepEqual(checkAddress({ country: 'ZZ', lines: ['  ', ''] }), ['add a street address']);
  assert.deepEqual(checkAddress({ country: 'ZZ', lines: ['', ' 1 Main St '] }), []);
  assert.deepEqual(checkAddress({ country: 'US', lines: ['x'], postcode: ' 45402\t' }), []);
  assert.deepEqual(checkAddress({ country: 'US', lines: [' '], postcode: ' 4540 ' }), ['add a street address', ' 4540  is not a United States postcode']);
  assert.deepEqual(checkAddress({ country: 'ZZ', lines: ['x'], postcode: 'anything' }), []);
});

test('each country writes its address in its own order, with its own capitals', () => {
  const a = { lines: [' 1 Main St ', '', 'Apt 2'], city: 'new  york', region: 'ny', postcode: 'ab1 2cd' };
  const street = ['1 Main St', 'Apt 2'];
  assert.deepEqual(formatAddress({ country: 'US', ...a }), [...street, 'new york, NY ab1 2cd']);
  assert.deepEqual(formatAddress({ country: 'CA', ...a }), [...street, 'NEW YORK NY AB1 2CD']);
  assert.deepEqual(formatAddress({ country: 'GB', ...a }), [...street, 'NEW YORK', 'AB1 2CD']);
  assert.deepEqual(formatAddress({ country: 'DE', ...a }), [...street, 'ab1 2cd new york']);
  assert.deepEqual(formatAddress({ country: 'FR', ...a }), [...street, 'ab1 2cd NEW YORK']);
  assert.deepEqual(formatAddress({ country: 'JP', ...a }), ['〒ab1 2cd', 'nynew york', ...street]);
  assert.deepEqual(formatAddress({ country: 'IN', ...a }), [...street, 'new york ab1 2cd', 'ny']);
  assert.deepEqual(formatAddress({ country: 'AU', ...a }), [...street, 'NEW YORK NY ab1 2cd']);
  assert.deepEqual(formatAddress({ country: 'BR', ...a }), [...street, 'new york - ny', 'ab1 2cd']);
  assert.deepEqual(formatAddress({ country: 'IE', ...a }), [...street, 'new york', 'ny', 'AB1 2CD']);
  assert.deepEqual(formatAddress({ country: 'ZZ', ...a }), [...street, 'new york ny ab1 2cd']);
});

test('missing parts of an address leave no stray punctuation, spaces or blank lines', () => {
  const l = ['1 Main St'];
  assert.deepEqual(formatAddress({ country: 'US', lines: l }), l);
  assert.deepEqual(formatAddress({ country: 'US', lines: l, city: ' Dayton ' }), ['1 Main St', 'Dayton']);
  assert.deepEqual(formatAddress({ country: 'US', lines: l, city: 'Dayton ', region: 'oh', postcode: '45402' }), ['1 Main St', 'Dayton, OH 45402']);
  assert.deepEqual(formatAddress({ country: 'US', lines: l, region: 'oh', postcode: '45402' }), ['1 Main St', 'OH 45402']);
  assert.deepEqual(formatAddress({ country: 'US', lines: l, postcode: '45402' }), ['1 Main St', '45402']);
  assert.deepEqual(formatAddress({ country: 'BR', lines: l, city: 'São Paulo' }), ['1 Main St', 'São Paulo']);
  assert.deepEqual(formatAddress({ country: 'BR', lines: l, region: 'SP' }), ['1 Main St', 'SP']);
  assert.deepEqual(formatAddress({ country: 'JP', lines: l }), l);
  assert.deepEqual(formatAddress({ country: 'JP', lines: l, postcode: '100-0001' }), ['〒100-0001', '1 Main St']);
  assert.deepEqual(formatAddress({ country: 'DE', lines: l }), l);
  assert.deepEqual(formatAddress({ country: 'DE', lines: ['', ' '] }), []);
  assert.deepEqual(formatAddress({ country: 'GB', lines: l, city: 'Leeds' }), ['1 Main St', 'LEEDS']);
});

test('the country is added to the end of an address only when sending from somewhere else', () => {
  const a = { country: 'US', lines: ['1 Main St'], city: 'Dayton', region: 'OH', postcode: '45402' };
  assert.deepEqual(formatAddress(a, 'US'), ['1 Main St', 'Dayton, OH 45402']);
  assert.deepEqual(formatAddress(a), ['1 Main St', 'Dayton, OH 45402']);
  assert.deepEqual(formatAddress(a, ''), ['1 Main St', 'Dayton, OH 45402']);
  assert.deepEqual(formatAddress(a, 'GB'), ['1 Main St', 'Dayton, OH 45402', 'UNITED STATES']);
  assert.deepEqual(formatAddress({ country: 'ZZ', lines: ['x'] }, 'US'), ['x', 'ZZ']);
  assert.deepEqual(formatAddress({ country: 'ZZ', lines: ['x'] }, 'ZZ'), ['x']);
  const names: Record<string, string> = { US: 'UNITED STATES', CA: 'CANADA', GB: 'UNITED KINGDOM', DE: 'GERMANY', FR: 'FRANCE', JP: 'JAPAN', IN: 'INDIA', AU: 'AUSTRALIA', BR: 'BRAZIL', IE: 'IRELAND' };
  for (const [country, label] of Object.entries(names)) assert.equal(formatAddress({ country, lines: ['x'] }, 'ZZ').at(-1), label);
});

test('each country has its calling code and number length, with the national prefix dropped only when it is one', () => {
  const ok: [string, string, string][] = [
    ['US', '937 555 0142', '+19375550142'],
    ['US', '1 937 555 0142', '+19375550142'],
    ['US', '1375550142', '+11375550142'],
    ['CA', '416 555 0123', '+14165550123'],
    ['CA', '1 416 555 0123', '+14165550123'],
    ['GB', '020 7946 0018', '+442079460018'],
    ['GB', '0207946001', '+44207946001'],
    ['GB', '2079460010', '+442079460010'],
    ['GB', '207946001', '+44207946001'],
    ['DE', '030 1234567', '+49301234567'],
    ['DE', '123456', '+49123456'],
    ['DE', '1234567890123', '+491234567890123'],
    ['FR', '06 12 34 56 78', '+33612345678'],
    ['FR', '612345678', '+33612345678'],
    ['JP', '090-1234-5678', '+819012345678'],
    ['JP', '3-1234-5678', '+81312345678'],
    ['IN', '098765 43210', '+919876543210'],
    ['IN', '9876543210', '+919876543210'],
    ['AU', '0412 345 678', '+61412345678'],
    ['AU', '412 345 678', '+61412345678'],
    ['BR', '(11) 91234-5678', '+5511912345678'],
    ['BR', '011 91234 5678', '+5511912345678'],
    ['BR', '11 1234-5678', '+551112345678'],
    ['IE', '01 234 5678', '+35312345678'],
    ['IE', '1234567', '+3531234567'],
    ['IE', '85 123 4567', '+353851234567'],
  ];
  for (const [country, typed, e164] of ok) assert.equal(phone(typed, country), e164, `${country} ${typed}`);
  const bad: [string, string, string][] = [
    ['US', '937 555 014', 'a US number has 10 digits after the area code prefix'],
    ['US', '1 937 555 0142 5', 'a US number has 10 digits after the area code prefix'],
    ['CA', '416 555 012', 'a CA number has 10 digits after the area code prefix'],
    ['GB', '2079460', 'a GB number has 9 to 10 digits after the area code prefix'],
    ['GB', '20794600180', 'a GB number has 9 to 10 digits after the area code prefix'],
    ['GB', '2079460018 0 0', 'a GB number has 9 to 10 digits after the area code prefix'],
    ['DE', '12345', 'a DE number has 6 to 13 digits after the area code prefix'],
    ['DE', '12345678901234', 'a DE number has 6 to 13 digits after the area code prefix'],
    ['FR', '61234567', 'a FR number has 9 digits after the area code prefix'],
    ['FR', '1612345678', 'a FR number has 9 digits after the area code prefix'],
    ['JP', '1234567', 'a JP number has 9 to 10 digits after the area code prefix'],
    ['IN', '987654321', 'a IN number has 10 digits after the area code prefix'],
    ['AU', '41234567', 'a AU number has 9 digits after the area code prefix'],
    ['BR', '123456789', 'a BR number has 10 to 11 digits after the area code prefix'],
    ['BR', '123456789012', 'a BR number has 10 to 11 digits after the area code prefix'],
    ['IE', '123456', 'a IE number has 7 to 9 digits after the area code prefix'],
    ['IE', '1234567890', 'a IE number has 7 to 9 digits after the area code prefix'],
  ];
  for (const [country, typed, message] of bad) assert.throws(() => phone(typed, country), { message }, `${country} ${typed}`);
});

test('a number with a country code must be complete: 8 to 15 digits, not starting with 0', () => {
  const refused = { message: 'that is not a complete international number' };
  assert.equal(phone('+1234567 8', 'ZZ'), '+12345678');
  assert.equal(phone('+123456789012345', 'ZZ'), '+123456789012345');
  assert.throws(() => phone('+1234567', 'US'), refused);
  assert.throws(() => phone('+1234567890123456', 'US'), refused);
  assert.throws(() => phone('+0123456789', 'US'), refused);
  assert.throws(() => phone('0012345', 'US'), refused);
  assert.equal(phone('00 44 20 7946 0018', 'ZZ'), '+442079460018');
});

test('international numbers are read whatever the punctuation, even without spaces, and a country is not needed', () => {
  assert.equal(phone('+442079460018', 'US'), '+442079460018');
  assert.equal(phone('(+44) 20 7946 0018', 'US'), '+442079460018');
  assert.equal(phone('+44-20-7946-0018', 'ZZ'), '+442079460018');
  assert.equal(phone('  +44 20 7946 0018  ', 'ZZ'), '+442079460018');
  assert.equal(phone('+44 (0) 20 7946 0018', 'ZZ'), '+442079460018');
  assert.equal(phone('+44 ( 0 ) 20 7946 0018', 'ZZ'), '+442079460018');
  assert.equal(phone('+1 (900) 555-0100', 'ZZ'), '+19005550100');
  assert.equal(phone('+4420 7946 0018 x 55', 'ZZ'), '+442079460018');
  assert.equal(phone('0044 20 7946 0018 ext 5', 'US'), '+442079460018');
});

test('extensions are dropped only at the end of the number; letters anywhere else are refused', () => {
  assert.equal(phone('937 555 0142 EXT 12', 'US'), '+19375550142');
  assert.equal(phone('937 555 0142 Ext. 12', 'US'), '+19375550142');
  assert.equal(phone('937 555 0142 x. 12', 'US'), '+19375550142');
  assert.equal(phone('937 555 0142ext12', 'US'), '+19375550142');
  assert.equal(phone('  937 555 0142 x12  ', 'US'), '+19375550142');
  assert.throws(() => phone('937 ext 1 555 0142', 'US'), { message: 'a phone number cannot contain letters' });
  assert.throws(() => phone('937 555 0142 ext', 'US'), { message: 'a phone number cannot contain letters' });
  assert.throws(() => phone('+44 20 7946 0018 ext', 'US'), { message: 'a phone number cannot contain letters' });
  assert.throws(() => phone('12345', 'ZZ'), { message: 'write the number with its country code (+...) for ZZ' });
});

test('stray characters inside a national number are ignored, not counted', () => {
  assert.equal(phone('937+555 0142', 'US'), '+19375550142');
  assert.equal(phone('937.555.0142', 'US'), '+19375550142');
  assert.equal(phone('937/555-0142', 'US'), '+19375550142');
});
