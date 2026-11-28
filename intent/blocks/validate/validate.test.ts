import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Invalid, boolean, date, email, fieldErrors, integer, list, number, oneOf, parse, problemDetails, record, text } from './index.ts';

const order = record({
  name: text({ max: 40 }),
  email: email(),
  kind: oneOf(['standard', 'express'] as const),
  when: date().optional(),
  items: list(record({ sku: text({ pattern: /^[A-Z]{3}-\d+$/ }), qty: integer({ min: 1, max: 99 }) }), { min: 1 }),
  gift: boolean().optional(),
});

test('a good input comes back cleaned and typed', () => {
  const v = parse(order, { name: '  Ana  ', email: 'ana@example.org', kind: 'express', items: [{ sku: 'ABC-1', qty: '3' }], gift: 'on' });
  assert.deepEqual(v, { name: 'Ana', email: 'ana@example.org', kind: 'express', items: [{ sku: 'ABC-1', qty: 3 }], gift: true });
});

test('every problem is reported at once, each with its path and a message a person can act on', () => {
  const r = order.check({ name: '', email: 'nope', kind: 'overnight', when: '2026-02-31', items: [{ sku: 'abc', qty: 0 }], extra: 1 }, '');
  assert.equal(r.ok, false);
  const errs = fieldErrors(!r.ok ? r.problems : []);
  assert.equal(errs['name'], 'name is needed');
  assert.match(errs['email']!, /email address/);
  assert.match(errs['kind']!, /standard, express/);
  assert.match(errs['when']!, /not a real date/);
  assert.match(errs['items[0].sku']!, /expected form/);
  assert.equal(errs['items[0].qty'], 'qty must be at least 1');
  assert.equal(errs['extra'], 'extra is not a field here');
});

test('one error format for every API, and Invalid carries the problems', () => {
  assert.throws(() => parse(order, {}), (e: Invalid) => e instanceof Invalid && e.problems.length >= 4);
  const pd = problemDetails([{ path: 'email', code: 'pattern', message: 'x' }], '/orders');
  assert.equal(pd.status, 422);
  assert.deepEqual(pd.errors, [{ path: 'email', code: 'pattern', detail: 'x' }]);
});

test('length counts characters people see, not bytes, and text is normalised', () => {
  assert.equal(parse(text({ max: 2 }), '😀😀'), '😀😀');
  assert.equal(parse(text(), 'é'), 'é');
  assert.equal(parse(text().optional(), ''), undefined);
});

test('a record refuses unknown fields even when they are named like inherited properties', () => {
  const s = record({ name: text() });
  const r = s.check(JSON.parse('{"name":"Ana","__proto__":{"admin":true},"constructor":1,"toString":2}'), '');
  assert.equal(r.ok, false);
  assert.deepEqual(!r.ok && r.problems.map((x) => x.path).sort(), ['__proto__', 'constructor', 'toString']);
  const c = record({ constructor: text().optional() }).check({}, '');
  assert.deepEqual(c, { ok: true, value: {} }, 'a missing field is missing, not the inherited Object constructor');
});

test('problem details follow RFC 9457: with type about:blank the title is the status phrase', () => {
  const pd = problemDetails([{ path: 'email', code: 'pattern', message: 'x' }]);
  assert.equal(pd.type, 'about:blank');
  assert.equal(pd.title, 'Unprocessable Content');
  assert.equal(pd.detail, 'Some of what was sent needs fixing');
});

test('a pattern with the global flag gives the same answer every time', () => {
  const s = text({ pattern: /^[a-z]+$/g });
  assert.equal(s.check('abc', 'x').ok, true);
  assert.equal(s.check('abc', 'x').ok, true);
});

test('fieldErrors keeps a message for __proto__ and constructor paths', () => {
  const r = record({ name: text().optional() }).check(JSON.parse('{"__proto__":1,"constructor":1}'), '');
  assert.equal(r.ok, false);
  if (r.ok) return;
  const errs = fieldErrors(r.problems);
  for (const p of r.problems) assert.ok(Object.hasOwn(errs, p.path) && typeof Object.getOwnPropertyDescriptor(errs, p.path)!.value === 'string', p.path);
  assert.equal(Object.keys(errs).length, r.problems.length);
});

const run = <T>(s: { check: (v: unknown, path: string) => { ok: boolean } }, v: unknown, path = 'field') => s.check(v, path) as { ok: true; value: T } | { ok: false; problems: { path: string; code: string; message: string }[] };
const fails = (s: Parameters<typeof run>[0], v: unknown, path = 'field') => {
  const r = run(s, v, path);
  assert.equal(r.ok, false, `${JSON.stringify(v)} should be refused`);
  return !r.ok ? r.problems : [];
};
const passes = <T>(s: Parameters<typeof run>[0], v: unknown): T => {
  const r = run<T>(s, v);
  assert.equal(r.ok, true, `${JSON.stringify(v)} should be accepted`);
  return r.ok ? r.value : (undefined as T);
};

test('a field is named in messages by the last part of its path, and the whole input is "this" or "(input)"', () => {
  assert.deepEqual(fails(text(), undefined, 'name'), [{ path: 'name', code: 'required', message: 'name is needed' }]);
  assert.deepEqual(fails(text(), undefined, 'order.shipping.city'), [{ path: 'order.shipping.city', code: 'required', message: 'city is needed' }]);
  assert.deepEqual(fails(text(), undefined, 'items[2].qty'), [{ path: 'items[2].qty', code: 'required', message: 'qty is needed' }]);
  assert.deepEqual(fails(text(), undefined, 'items[2]'), [{ path: 'items[2]', code: 'required', message: '2 is needed' }]);
  assert.deepEqual(fails(text(), undefined, ''), [{ path: '(input)', code: 'required', message: 'this is needed' }]);
  assert.throws(() => parse(text(), undefined), { message: '(input): this is needed' });
});

test('text: what is missing, what is the wrong type, and how space and emptiness are treated', () => {
  assert.deepEqual(fails(text(), undefined), [{ path: 'field', code: 'required', message: 'field is needed' }]);
  assert.deepEqual(fails(text(), null), [{ path: 'field', code: 'required', message: 'field is needed' }]);
  assert.deepEqual(fails(text(), ''), [{ path: 'field', code: 'required', message: 'field is needed' }]);
  assert.deepEqual(fails(text(), ' \t\n '), [{ path: 'field', code: 'required', message: 'field is needed' }]);
  for (const v of [5, true, {}, [], 0]) assert.deepEqual(fails(text(), v), [{ path: 'field', code: 'type', message: 'field must be text' }]);
  assert.equal(passes(text(), '  a b  '), 'a b');
  assert.equal(passes(text({ trim: false }), '  a b  '), '  a b  ');
  assert.equal(passes(text({ trim: false }), '   '), '   ');
  assert.equal(passes(text({ trim: true }), ' x '), 'x');
  assert.equal(passes(text({ min: 0 }), ''), '');
  assert.equal(passes(text({ min: 0 }), '   '), '');
  assert.deepEqual(fails(text({ min: 1 }), ''), [{ path: 'field', code: 'required', message: 'field is needed' }]);
  assert.equal(passes(text(), 'é'), 'é');
  assert.equal(passes(text({ trim: false }), 'é'), 'é'.normalize('NFC') === 'é' ? 'é' : 'é');
});

test('text: length limits count characters, include their own boundary, and say what is allowed', () => {
  assert.equal(passes(text({ min: 3 }), 'abc'), 'abc');
  assert.deepEqual(fails(text({ min: 3 }), 'ab'), [{ path: 'field', code: 'short', message: 'field needs at least 3 characters' }]);
  assert.equal(passes(text({ max: 3 }), 'abc'), 'abc');
  assert.deepEqual(fails(text({ max: 3 }), 'abcd'), [{ path: 'field', code: 'long', message: 'field can have at most 3 characters' }]);
  assert.equal(passes(text({ min: 2, max: 2 }), '😀😀'), '😀😀');
  assert.deepEqual(fails(text({ min: 2 }), '😀'), [{ path: 'field', code: 'short', message: 'field needs at least 2 characters' }]);
  assert.deepEqual(fails(text({ max: 1 }), '😀😀'), [{ path: 'field', code: 'long', message: 'field can have at most 1 characters' }]);
  assert.equal(passes(text({ max: 1 }), '😀'), '😀');
  assert.equal(passes(text({ max: 0, min: 0 }), ''), '');
  assert.deepEqual(fails(text({ min: 5, max: 3 }), 'abcd'), [{ path: 'field', code: 'short', message: 'field needs at least 5 characters' }]);
});

test('text: a pattern is checked with its own message when given, and a default one otherwise', () => {
  assert.deepEqual(fails(text({ pattern: /^\d+$/ }), 'abc'), [{ path: 'field', code: 'pattern', message: 'field is not in the expected form' }]);
  assert.deepEqual(fails(text({ pattern: /^\d+$/, patternMessage: 'digits only' }), 'abc'), [{ path: 'field', code: 'pattern', message: 'digits only' }]);
  assert.equal(passes(text({ pattern: /^\d+$/ }), ' 123 '), '123');
});

test('numbers: typed or written, whole or not, within limits, with a message for each way to be wrong', () => {
  assert.equal(passes(number(), 5), 5);
  assert.equal(passes(number(), '5'), 5);
  assert.equal(passes(number(), ' 5.5 '), 5.5);
  assert.equal(passes(number(), '1e3'), 1000);
  assert.equal(passes(number(), 0), 0);
  assert.equal(passes(number(), '0'), 0);
  assert.equal(passes(number(), -2), -2);
  for (const v of [undefined, null, '']) assert.deepEqual(fails(number(), v), [{ path: 'field', code: 'required', message: 'field is needed' }]);
  for (const v of ['abc', '   ', '5 apples', NaN, Infinity, -Infinity, true, {}, [], [5]]) assert.deepEqual(fails(number(), v), [{ path: 'field', code: 'type', message: 'field must be a number' }], String(v));
  assert.equal(passes(number(), 1.5), 1.5);
  assert.deepEqual(fails(number({ integer: true }), 1.5), [{ path: 'field', code: 'integer', message: 'field must be a whole number' }]);
  assert.equal(passes(number({ integer: true }), 2), 2);
  assert.equal(passes(number({ min: 1 }), 1), 1);
  assert.deepEqual(fails(number({ min: 1 }), 0.5), [{ path: 'field', code: 'min', message: 'field must be at least 1' }]);
  assert.equal(passes(number({ max: 9 }), 9), 9);
  assert.deepEqual(fails(number({ max: 9 }), 9.5), [{ path: 'field', code: 'max', message: 'field must be at most 9' }]);
  assert.equal(passes(number({ min: 0, max: 0 }), 0), 0);
  assert.deepEqual(fails(number({ min: 5, max: 3 }), 4), [{ path: 'field', code: 'min', message: 'field must be at least 5' }]);
});

test('integer is a number that must be whole, with the same limits', () => {
  assert.equal(passes(integer(), '7'), 7);
  assert.deepEqual(fails(integer(), 7.5), [{ path: 'field', code: 'integer', message: 'field must be a whole number' }]);
  assert.deepEqual(fails(integer({ min: 1 }), 0), [{ path: 'field', code: 'min', message: 'field must be at least 1' }]);
  assert.deepEqual(fails(integer({ max: 1 }), 2), [{ path: 'field', code: 'max', message: 'field must be at most 1' }]);
  assert.equal(passes(integer({ min: 1, max: 1 }), 1), 1);
});

test('boolean accepts true/false, the words on/off and the digits 1/0, and nothing else', () => {
  for (const v of [true, 'true', 'on', '1']) assert.equal(passes(boolean(), v), true, String(v));
  for (const v of [false, 'false', 'off', '0']) assert.equal(passes(boolean(), v), false, String(v));
  for (const v of ['yes', 'no', 'TRUE', ' true', 1, 0, null, undefined, '', {}, 'maybe']) assert.deepEqual(fails(boolean(), v), [{ path: 'field', code: 'type', message: 'field must be yes or no' }], String(v));
});

test('oneOf accepts only its listed values, and lists them when refusing', () => {
  const kind = oneOf(['standard', 'express']);
  assert.equal(passes(kind, 'standard'), 'standard');
  assert.equal(passes(kind, 'express'), 'express');
  assert.deepEqual(fails(kind, 'overnight'), [{ path: 'field', code: 'choice', message: 'field must be one of: standard, express' }]);
  assert.deepEqual(fails(kind, 'Standard'), [{ path: 'field', code: 'choice', message: 'field must be one of: standard, express' }]);
  assert.deepEqual(fails(kind, 5), [{ path: 'field', code: 'choice', message: 'field must be one of: standard, express' }]);
  assert.deepEqual(fails(kind, ['standard']), [{ path: 'field', code: 'choice', message: 'field must be one of: standard, express' }]);
  for (const v of [undefined, null, '']) assert.deepEqual(fails(kind, v), [{ path: 'field', code: 'required', message: 'field is needed' }]);
});

test('an email has one @, a dot in the domain and no spaces, and is at most 254 characters', () => {
  for (const v of ['a@b.co', ' a@b.co ', 'first.last+tag@sub.example.org', 'a@b.c.d']) assert.equal(passes(email(), v), v.trim(), v);
  const message = 'that does not look like an email address';
  for (const v of ['a@b', 'a@b.', '@b.co', 'a@.co', 'a@@b.co', 'a@b@c.d', 'a b@c.de', 'a@b.c d', 'a@b c.de', 'plain', 'a@b.co\nx']) assert.deepEqual(fails(email(), v), [{ path: 'field', code: 'pattern', message }], JSON.stringify(v));
  const longest = `${'a'.repeat(249)}@b.co`;
  assert.equal(longest.length, 254);
  assert.equal(passes(email(), longest), longest);
  assert.deepEqual(fails(email(), `a${longest}`), [{ path: 'field', code: 'long', message: 'field can have at most 254 characters' }]);
});

test('a date is YYYY-MM-DD and must exist on the calendar', () => {
  for (const v of ['2026-11-26', '2024-02-29', '2026-12-31', '2026-01-01', '2000-02-29']) assert.equal(passes(date(), v), v);
  const form = 'field must be a date like 2026-11-26';
  for (const v of ['2026-1-1', '26-11-26', '2026/11/26', '2026-11-26T00:00:00Z', ' 2026-11-26', '2026-11-26 ', 'x2026-11-26', '2026-11-26x', '2026-11-266', '12026-11-26', 20261126, true, {}, '2026-11-2a'])
    assert.deepEqual(fails(date(), v), [{ path: 'field', code: 'date', message: form }], JSON.stringify(v));
  for (const v of [undefined, null, '']) assert.deepEqual(fails(date(), v), [{ path: 'field', code: 'required', message: 'field is needed' }]);
  for (const v of ['2026-02-29', '2026-02-31', '2026-13-01', '2026-00-10', '2026-04-31', '2026-11-00', '2026-11-31', '1900-02-29'])
    assert.deepEqual(fails(date(), v), [{ path: 'field', code: 'date', message: `${v} is not a real date` }], v);
});

test('lists check every item, report each failure at its position, and respect their length limits', () => {
  const nums = list(integer());
  assert.deepEqual(passes(nums, ['1', 2, '3']), [1, 2, 3]);
  assert.deepEqual(passes(nums, []), []);
  assert.deepEqual(fails(nums, ['1', 'x', 2.5, 4], 'ns'), [
    { path: 'ns[1]', code: 'type', message: '1 must be a number' },
    { path: 'ns[2]', code: 'integer', message: '2 must be a whole number' },
  ]);
  for (const v of [undefined, null, 'abc', 5, {}, { length: 1 }]) assert.deepEqual(fails(nums, v), [{ path: 'field', code: 'type', message: 'field must be a list' }], String(v));
  assert.deepEqual(passes(list(integer(), { min: 2 }), [1, 2]), [1, 2]);
  assert.deepEqual(fails(list(integer(), { min: 2 }), [1]), [{ path: 'field', code: 'min', message: 'field needs at least 2' }]);
  assert.deepEqual(passes(list(integer(), { max: 2 }), [1, 2]), [1, 2]);
  assert.deepEqual(fails(list(integer(), { max: 2 }), [1, 2, 3]), [{ path: 'field', code: 'max', message: 'field can have at most 2' }]);
  assert.deepEqual(passes(list(integer(), { min: 0, max: 0 }), []), []);
  assert.deepEqual(fails(list(integer(), { max: 0 }), [1]), [{ path: 'field', code: 'max', message: 'field can have at most 0' }]);
  assert.deepEqual(fails(list(integer(), { min: 3, max: 1 }), [1, 2]), [{ path: 'field', code: 'min', message: 'field needs at least 3' }]);
  assert.deepEqual(passes(list(integer().optional()), [1, '', null, undefined]), [1, undefined, undefined, undefined]);
});

test('a record needs a set of fields, names its extras and its missing fields by path, and can allow extras', () => {
  const s = record({ a: text(), b: integer().optional() });
  for (const v of [null, undefined, 'text', 5, true, []]) assert.deepEqual(fails(s, v, ''), [{ path: '(input)', code: 'type', message: 'the input must be a set of fields' }], String(v));
  assert.deepEqual(fails(s, 'x', 'order'), [{ path: 'order', code: 'type', message: 'order must be a set of fields' }]);
  assert.deepEqual(fails(s, [], 'order.items'), [{ path: 'order.items', code: 'type', message: 'items must be a set of fields' }]);
  assert.deepEqual(fails(s, {}, ''), [{ path: 'a', code: 'required', message: 'a is needed' }]);
  assert.deepEqual(fails(s, {}, 'o'), [{ path: 'o.a', code: 'required', message: 'a is needed' }]);
  assert.deepEqual(fails(s, { a: 'x', z: 1 }, ''), [{ path: 'z', code: 'unknown', message: 'z is not a field here' }]);
  assert.deepEqual(fails(s, { a: 'x', z: 1, y: 2 }, 'o'), [
    { path: 'o.z', code: 'unknown', message: 'z is not a field here' },
    { path: 'o.y', code: 'unknown', message: 'y is not a field here' },
  ]);
  assert.deepEqual(passes(record({ a: text() }, { allowExtra: true }), { a: ' x ', z: 1 }), { a: 'x' });
  assert.deepEqual(fails(record({ a: text() }, { allowExtra: false }), { a: 'x', z: 1 }, ''), [{ path: 'z', code: 'unknown', message: 'z is not a field here' }]);
  assert.deepEqual(fails(record({ a: text() }, { allowExtra: true }), { z: 1 }, ''), [{ path: 'a', code: 'required', message: 'a is needed' }]);
  const nested = record({ shipping: record({ city: text() }) });
  assert.deepEqual(fails(nested, { shipping: { city: '', zip: 1 } }, ''), [
    { path: 'shipping.city', code: 'required', message: 'city is needed' },
    { path: 'shipping.zip', code: 'unknown', message: 'zip is not a field here' },
  ]);
});

test('a cleaned record holds only fields that have a value, as ordinary writable, enumerable, configurable properties', () => {
  const v = passes<Record<string, unknown>>(record({ a: text(), b: integer().optional(), c: text().optional() }), { a: 'x', b: '', c: 'y' });
  assert.deepEqual(Object.keys(v), ['a', 'c']);
  assert.ok(!('b' in v));
  assert.deepEqual(Object.getOwnPropertyDescriptor(v, 'a'), { value: 'x', writable: true, enumerable: true, configurable: true });
  v['a'] = 'changed';
  delete v['c'];
  assert.deepEqual(v, { a: 'changed' });
  const e = fieldErrors([{ path: 'p', code: 'c', message: 'm' }]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(e, 'p'), { value: 'm', writable: true, enumerable: true, configurable: true });
});

test('optional turns an empty value into undefined, but still checks anything else', () => {
  for (const v of [undefined, null, '']) assert.equal(passes(text().optional(), v), undefined);
  assert.equal(passes(text().optional(), 'x'), 'x');
  assert.equal(passes(integer().optional(), 0), 0);
  assert.deepEqual(fails(integer().optional(), 'abc'), [{ path: 'field', code: 'type', message: 'field must be a number' }]);
  assert.deepEqual(fails(text({ min: 3 }).optional(), 'ab'), [{ path: 'field', code: 'short', message: 'field needs at least 3 characters' }]);
  assert.equal(passes(boolean().optional(), null), undefined);
  assert.equal(passes(boolean().optional(), false), false);
  assert.equal(passes(oneOf(['a']).optional(), ''), undefined);
  assert.equal(passes(date().optional(), null), undefined);
  assert.equal(passes(list(text()).optional(), undefined), undefined);
  assert.deepEqual(passes(list(text()).optional(), []), []);
  assert.equal(passes(record({ a: text() }).optional(), null), undefined);
  assert.equal(passes(text().optional().optional(), ''), undefined);
});

test('Invalid joins every problem as "path: message", and parse starts at the root of the input', () => {
  const s = record({ a: text(), b: text() });
  assert.throws(() => parse(s, {}), (e: unknown) => e instanceof Invalid && e instanceof Error && e.message === 'a: a is needed; b: b is needed' && e.problems.length === 2);
  assert.throws(() => parse(s, { a: 'x' }), { message: 'b: b is needed' });
  assert.throws(() => parse(list(text()), ['x', '']), { message: '[1]: 1 is needed' });
  assert.throws(() => parse(record({ a: record({ b: text() }) }), { a: {} }), { message: 'a.b: b is needed' });
  assert.equal(new Invalid([]).message, '');
  assert.equal(parse(text(), ' ok '), 'ok');
  assert.deepEqual(parse(s, { a: 'x', b: 'y' }), { a: 'x', b: 'y' });
});

test('problem details carry the instance only when one is given, and list each problem as path, code and detail', () => {
  const p = [{ path: 'a', code: 'required', message: 'a is needed' }, { path: 'b', code: 'min', message: 'b must be at least 1' }];
  assert.deepEqual(problemDetails(p, '/orders/7'), {
    type: 'about:blank',
    title: 'Unprocessable Content',
    status: 422,
    detail: 'Some of what was sent needs fixing',
    instance: '/orders/7',
    errors: [{ path: 'a', code: 'required', detail: 'a is needed' }, { path: 'b', code: 'min', detail: 'b must be at least 1' }],
  });
  assert.deepEqual(problemDetails(p), {
    type: 'about:blank',
    title: 'Unprocessable Content',
    status: 422,
    detail: 'Some of what was sent needs fixing',
    errors: [{ path: 'a', code: 'required', detail: 'a is needed' }, { path: 'b', code: 'min', detail: 'b must be at least 1' }],
  });
  assert.ok(!('instance' in problemDetails(p, '')));
  assert.deepEqual(problemDetails([]).errors, []);
});

test('a form shows the first problem of each field', () => {
  assert.deepEqual(fieldErrors([{ path: 'a', code: 'x', message: 'first' }, { path: 'b', code: 'x', message: 'other' }, { path: 'a', code: 'y', message: 'second' }]), { a: 'first', b: 'other' });
  assert.deepEqual(fieldErrors([]), {});
});

test('a field name is shown whole, even if it contains a closing bracket, and a date must be text, not something that prints like one', () => {
  assert.deepEqual(fails(record({ 'a]b': text() }), {}, ''), [{ path: 'a]b', code: 'required', message: 'a]b is needed' }]);
  assert.deepEqual(fails(text(), undefined, 'items[2]'), [{ path: 'items[2]', code: 'required', message: '2 is needed' }]);
  assert.deepEqual(fails(date(), ['2026-11-26']), [{ path: 'field', code: 'date', message: 'field must be a date like 2026-11-26' }]);
  assert.deepEqual(fails(date(), { toString: () => '2026-11-26' }), [{ path: 'field', code: 'date', message: 'field must be a date like 2026-11-26' }]);
});
