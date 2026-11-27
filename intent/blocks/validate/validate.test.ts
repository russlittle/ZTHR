import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Invalid, date, email, fieldErrors, integer, list, oneOf, parse, problemDetails, record, text, boolean } from './index.ts';

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
