import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GeneratorError, randomBelow, password, countBits, passphrase, pin, username, check, forSite, optionsFor, estimate, checkList, WORDS, SETS, AMBIGUOUS } from './index.ts';

const stream = (seed: string) => {
  let n = 0;
  return (bytes: number) => {
    const out = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i += 32) createHash('sha256').update(`${seed}:${n++}`).digest().copy(out, i, 0, Math.min(32, bytes - i));
    return out;
  };
};
const script = (words: number[]) => { let i = 0; return (b: number) => { const o = Buffer.alloc(b); o.writeUInt32BE(words[i++ % words.length]! >>> 0, 0); return o; }; };

test('randomBelow is unbiased: values in the uneven tail are discarded', () => {
  // n = 3: limit = 2^32 - (2^32 mod 3) = 4294967295; 4294967295 is rejected, the next word is used.
  assert.equal(randomBelow(3, script([4294967295, 7])), 1);
  assert.equal(randomBelow(3, script([4294967294])), 4294967294 % 3);
  assert.equal(randomBelow(1, script([5])), 0);
  assert.equal(randomBelow(10, script([123456789])), 9);
});

test('randomBelow covers a range evenly and refuses nonsense', () => {
  const r = stream('u');
  const counts = new Array<number>(6).fill(0);
  for (let i = 0; i < 6000; i++) counts[randomBelow(6, r)]!++;
  for (const c of counts) assert.ok(c > 850 && c < 1150, `count ${c}`);
  assert.throws(() => randomBelow(0), GeneratorError);
  assert.throws(() => randomBelow(1.5), GeneratorError);
  assert.throws(() => randomBelow(2 ** 32 + 1), GeneratorError);
  assert.throws(() => randomBelow(5, () => Buffer.alloc(2)), /too few bytes/);
  assert.throws(() => randomBelow(3, script([4294967295])), /never produced/);
});

test('entropy is exact: counting strings under the rules', () => {
  // {a,b} + {0}: strings of length 2 over 3 symbols with at least one digit: 9 - 4 = 5.
  assert.ok(Math.abs(countBits({ length: 2, sets: ['ab', '0'], minimum: 0, maxRun: 2 }) - Math.log2(9)) < 1e-12);
  assert.ok(Math.abs(countBits({ length: 2, sets: ['ab', '0'], minimum: 1, maxRun: 2 }) - Math.log2(4)) < 1e-12);
  // one of each is required in length 2: a0 b0 0a 0b = 4. With at least one digit only we cannot ask here, so check 3 chars:
  assert.ok(Math.abs(countBits({ length: 3, sets: ['ab', '0'], minimum: 1, maxRun: 3 }) - Math.log2(27 - 8 - 1)) < 1e-12);
  // no run longer than 1: 3*2*2 = 12 strings of length 3 over 3 symbols.
  assert.ok(Math.abs(countBits({ length: 3, sets: ['abc'], minimum: 0, maxRun: 1 }) - Math.log2(12)) < 1e-12);
  // run of at most 2 over a 2-symbol alphabet, length 3: 8 - 2 = 6.
  assert.ok(Math.abs(countBits({ length: 3, sets: ['ab'], minimum: 0, maxRun: 2 }) - Math.log2(6)) < 1e-12);
});

test('a plain password reports length * log2(pool) and has the right size and alphabet', () => {
  const g = password({ length: 20, sets: ['lower', 'digits'], minimum: 0 }, stream('p1'));
  assert.equal(g.value.length, 20);
  assert.match(g.value, /^[a-z0-9]{20}$/);
  assert.ok(Math.abs(g.bits - 20 * Math.log2(36)) < 1e-9);
});

test('required sets are always met and the entropy drops by exactly what that excludes', () => {
  for (let i = 0; i < 50; i++) {
    const g = password({ length: 8, minimum: 2 }, stream(`m${i}`));
    assert.ok((g.value.match(/[a-z]/g) ?? []).length >= 2);
    assert.ok((g.value.match(/[A-Z]/g) ?? []).length >= 2);
    assert.ok((g.value.match(/[0-9]/g) ?? []).length >= 2);
    assert.ok((g.value.match(/[^A-Za-z0-9]/g) ?? []).length >= 2);
  }
  const free = password({ length: 8, minimum: 0 }, stream('x')).bits;
  const ruled = password({ length: 8, minimum: 2 }, stream('x')).bits;
  assert.ok(ruled < free && ruled > free - 8);
});

test('exclusions, look-alikes and runs are honoured', () => {
  for (let i = 0; i < 30; i++) {
    const g = password({ length: 30, noAmbiguous: true, exclude: 'aeiou', maxRun: 1 }, stream(`e${i}`));
    for (const c of AMBIGUOUS + 'aeiou') assert.ok(!g.value.includes(c), `${c} in ${g.value}`);
    assert.ok(!/(.)\1/.test(g.value));
  }
  assert.ok(!password({ length: 40, sets: ['digits'], minimum: 0, maxRun: 2 }, stream('r')).value.match(/(.)\1\1/));
});

test('custom sets are deduplicated, and sets that overlap do not double-count', () => {
  const g = password({ length: 10, sets: [{ chars: 'aabbcc' }, { chars: 'abcxyz' }], minimum: 0 }, stream('c'));
  assert.ok(Math.abs(g.bits - 10 * Math.log2(6)) < 1e-9);
  assert.match(g.value, /^[abcxyz]{10}$/);
});

test('impossible or silly options are refused with plain messages', () => {
  assert.throws(() => password({ length: 0 }), /length/);
  assert.throws(() => password({ length: 5000 }), /length/);
  assert.throws(() => password({ sets: [] }), /at least one set/);
  assert.throws(() => password({ length: 3, minimum: 1 }), /do not fit/);
  assert.throws(() => password({ sets: ['digits'], exclude: SETS.digits }), /no characters are left/);
  assert.throws(() => password({ sets: ['nope' as never] }), /not a character set/);
  assert.throws(() => password({ maxRun: 0 }), /longest run/);
  assert.throws(() => password({ length: 4, sets: [{ chars: 'a' }], minimum: 0, maxRun: 1 }), GeneratorError);
  assert.throws(() => password({ minimum: -1 }), /minimum/);
});

test('output is reproducible under a fixed source and differs under another', () => {
  assert.equal(password({}, stream('same')).value, password({}, stream('same')).value);
  assert.notEqual(password({}, stream('a')).value, password({}, stream('b')).value);
  assert.notEqual(password().value, password().value);
});

test('the built-in word list is 4096 distinct pronounceable words', () => {
  assert.equal(WORDS.length, 4096);
  assert.equal(new Set(WORDS).size, 4096);
  assert.match(WORDS[0]!, /^[a-z]{4}$/);
  assert.doesNotThrow(() => checkList(WORDS));
});

test('passphrase: six words is 72 bits; options add and account for entropy', () => {
  const p = passphrase({}, stream('w'));
  assert.equal(p.value.split('-').length, 6);
  assert.equal(p.bits, 72);
  const q = passphrase({ words: 4, separator: ' ', capitalize: true, number: true }, stream('w2'));
  assert.equal(q.value.split(' ').length, 4);
  assert.equal((q.value.match(/\d/g) ?? []).length, 1);
  assert.ok(q.value.split(' ').every((w) => /^[A-Z]/.test(w)));
  assert.ok(Math.abs(q.bits - (48 + 2 + Math.log2(10))) < 1e-9);
});

test('passphrase checks a custom list for repeats and bad entries, and picks the right word', () => {
  assert.throws(() => passphrase({ list: ['a', 'b', 'A'] }), /twice/);
  assert.throws(() => passphrase({ list: ['one'] }), /at least 2/);
  assert.throws(() => passphrase({ list: ['a b', 'c'] }), /space/);
  assert.throws(() => passphrase({ words: 0 }), /1 to 64/);
  assert.throws(() => passphrase({ separator: 'x'.repeat(9) }), /separator/);
  const g = passphrase({ words: 2, list: ['red', 'green', 'blue'], separator: '+' }, script([1, 2]));
  assert.equal(g.value, 'green+blue');
  assert.ok(Math.abs(g.bits - 2 * Math.log2(3)) < 1e-12);
});

test('PIN and username carry their entropy', () => {
  const p = pin(6, script([7, 3, 0, 9, 4, 1]));
  assert.equal(p.value, '730941');
  assert.ok(Math.abs(p.bits - 6 * Math.log2(10)) < 1e-12);
  assert.throws(() => pin(3), /4 to 32/);
  const u = username({}, stream('u'));
  assert.match(u.value, /^[a-z]{8}\d\d$/);
  assert.ok(Math.abs(u.bits - (24 + 2 * Math.log2(10))) < 1e-9);
  assert.throws(() => username({ words: 9 }), /1 to 4/);
});

test('site rules are checked with specific plain problems', () => {
  assert.deepEqual(check('abc', { minLength: 8, requireUpper: true, requireDigit: true, requireSymbol: true }), ['needs at least 8 characters', 'needs an upper-case letter', 'needs a digit', 'needs a symbol']);
  assert.deepEqual(check('Abcdefg1!', { minLength: 8, maxLength: 12, requireLower: true, requireUpper: true, requireDigit: true, requireSymbol: true }), []);
  assert.deepEqual(check('aaaab', { maxRun: 3 }), ['must not repeat a character more than 3 times in a row']);
  assert.deepEqual(check('ab<c>', { forbidden: '<>' }), ['must not contain < >']);
  assert.deepEqual(check('ab c', { allowedOnly: 'abc' }), ['may not contain  ']);
  assert.deepEqual(check('x'.repeat(20), { maxLength: 16 }), ['needs at most 16 characters']);
});

test('forSite produces a password the rules accept, or says it cannot', () => {
  const rules = { minLength: 12, maxLength: 16, requireUpper: true, requireDigit: true, requireSymbol: true, requireLower: true, forbidden: '<>\\', maxRun: 2 };
  for (let i = 0; i < 20; i++) {
    const g = forSite(rules, stream(`s${i}`));
    assert.deepEqual(check(g.value, rules), []);
    assert.ok(g.value.length >= 16 && g.value.length <= 16);
  }
  const digitsOnly = forSite({ minLength: 6, maxLength: 6, allowedOnly: '0123456789' }, stream('d'));
  assert.match(digitsOnly.value, /^\d{6}$/);
  assert.deepEqual(optionsFor({ maxLength: 10 }).length, 10);
  assert.throws(() => optionsFor({ minLength: 40, maxLength: 20 }), /no length/);
});

test('estimate gives an upper bound and penalises predictable choices', () => {
  assert.equal(estimate('').bits, 0);
  const a = estimate('aaaaaaaa');
  const b = estimate('abcdefgh');
  const c = estimate('q7!Zm2#x');
  assert.ok(a.bits < 10);
  assert.ok(b.bits < c.bits);
  assert.ok(c.bits > 50);
  assert.ok(a.notes.some((n) => /repeat/.test(n)));
  assert.ok(estimate('123456').notes.includes('digits only'));
  assert.ok(estimate('Password1').bits < 40);
  assert.ok(estimate('Password1').notes.some((n) => /common pattern/.test(n)));
});
