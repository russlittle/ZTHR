import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compile, evaluate, references, render, resolve, resolveDeep, compileTemplate,
  ExpressionSyntaxError, ExpressionRuntimeError, ExpressionLimitError, ExpressionForbidden,
} from './index.ts';

const ev = (s: string, ctx: unknown = {}) => evaluate(s, ctx);

test('arithmetic and precedence', () => {
  assert.equal(ev('1 + 2 * 3'), 7);
  assert.equal(ev('(1 + 2) * 3'), 9);
  assert.equal(ev('2 ** 3 ** 2'), 512);
  assert.equal(ev('10 % 4'), 2);
  assert.equal(ev('-3 + 5'), 2);
});

test('strings, concatenation and comparison', () => {
  assert.equal(ev('"a" + "b" + 1'), 'ab1');
  assert.equal(ev('"abc" < "abd"'), true);
  assert.equal(ev('1 === 1 && 2 !== 3'), true);
});

test('logic operators return operands', () => {
  assert.equal(ev('0 || "x"'), 'x');
  assert.equal(ev('"a" && "b"'), 'b');
  assert.equal(ev('null ?? 5'), 5);
  assert.equal(ev('0 ?? 5'), 0);
  assert.equal(ev('true ? 1 : 2'), 1);
});

test('context lookup, member access and optional chaining', () => {
  const ctx = { user: { name: 'Ada', tags: ['a', 'b'] } };
  assert.equal(ev('user.name', ctx), 'Ada');
  assert.equal(ev('user.tags[1]', ctx), 'b');
  assert.equal(ev('user.missing?.x', ctx), undefined);
  assert.equal(ev('user.tags.length', ctx), 2);
  assert.throws(() => ev('user.missing.x', ctx), ExpressionRuntimeError);
});

test('array methods with arrow functions', () => {
  assert.deepEqual(ev('[1,2,3].map(x => x * 2)'), [2, 4, 6]);
  assert.deepEqual(ev('[1,2,3,4].filter(x => x % 2 === 0)'), [2, 4]);
  assert.equal(ev('[1,2,3].reduce((a, b) => a + b, 0)'), 6);
  assert.equal(ev('[3,1,2].sort().join("-")'), '1-2-3');
  assert.equal(ev('[1,2,3].some(x => x > 2)'), true);
  assert.equal(ev('[1,2,3].every(x => x > 2)'), false);
});

test('string methods and builtins', () => {
  assert.equal(ev('"Hello".toUpperCase()'), 'HELLO');
  assert.deepEqual(ev('"a,b".split(",")'), ['a', 'b']);
  assert.equal(ev('sum([1,2,3])'), 6);
  assert.equal(ev('Math.max(1, 5, 3)'), 5);
  assert.equal(ev('len("héllo")'), 5);
  assert.deepEqual(ev('range(3)'), [0, 1, 2]);
  assert.equal(ev('(3.14159).toFixed(2)'), '3.14');
});

test('object literals and keys', () => {
  assert.deepEqual(ev('{ a: 1, "b": 2 }'), { a: 1, b: 2 });
  assert.deepEqual(ev('keys({ x: 1, y: 2 })'), ['x', 'y']);
});

test('now() uses the injected clock', () => {
  assert.equal(evaluate('now()', {}, { now: () => 0 }), '1970-01-01T00:00:00.000Z');
});

test('hostile: prototype and constructor access refused', () => {
  assert.throws(() => ev('x.constructor', { x: {} }), ExpressionForbidden);
  assert.throws(() => ev('x.__proto__', { x: {} }), ExpressionForbidden);
  assert.throws(() => ev('"a".constructor.constructor("return 1")()'), ExpressionForbidden);
  assert.throws(() => ev('x["constructor"]', { x: [] }), ExpressionForbidden);
  assert.throws(() => ev('{ __proto__: 1 }'), ExpressionForbidden);
});

test('hostile: host globals are not reachable', () => {
  assert.equal(ev('typeof_x', {}), undefined);
  assert.equal(ev('process'), undefined);
  assert.throws(() => evaluate('process', {}, { strict: true }), ExpressionRuntimeError);
  assert.throws(() => ev('this'), ExpressionSyntaxError);
  assert.throws(() => ev('new Date()'), ExpressionSyntaxError);
  assert.throws(() => ev('x = 1'), ExpressionSyntaxError);
});

test('hostile: class instances and functions in context are refused', () => {
  class Secret { v = 1; }
  assert.throws(() => ev('s.v', { s: new Secret() }), ExpressionForbidden);
  assert.throws(() => ev('f', { f: () => 1 }), ExpressionForbidden);
  assert.throws(() => ev('d.getTime()', { d: new Date(0) }), ExpressionForbidden);
});

test('methods are allow-listed, not prototype lookups', () => {
  assert.throws(() => ev('"a".anchor("x")'), ExpressionRuntimeError);
  assert.throws(() => ev('[1].constructor()'), ExpressionForbidden);
  assert.throws(() => ev('[1].push(2)'), ExpressionRuntimeError);
  assert.throws(() => ev('({}).hasOwnProperty("a")'), ExpressionRuntimeError);
});

test('limits: steps, memory, output, source length, exponent', () => {
  assert.throws(() => evaluate('range(1000).map(x => range(1000).length)', {}, { limits: { maxSteps: 5000 } }), ExpressionLimitError);
  assert.throws(() => ev('"x".repeat(1000000000)'), ExpressionLimitError);
  assert.throws(() => ev('2 ** 5000'), ExpressionLimitError);
  assert.throws(() => compile('1+' .repeat(3000) + '1'), ExpressionSyntaxError);
  assert.throws(() => render('{{ "ab".repeat(1000) }}', {}, { limits: { maxOutput: 100, maxSize: 5000 } }), ExpressionLimitError);
});

test('limits: nesting depth', () => {
  assert.throws(() => compile('('.repeat(200) + '1' + ')'.repeat(200)), (e) => e instanceof ExpressionSyntaxError || e instanceof ExpressionLimitError);
});

test('syntax errors carry a position', () => {
  try { compile('1 + * 2'); assert.fail('should throw'); } catch (e) {
    assert.ok(e instanceof ExpressionSyntaxError);
    assert.equal(e.at, 4);
  }
});

test('references lists free names, not arrow params', () => {
  assert.deepEqual(references('a + b.c + [1].map(x => x + d).length').sort(), ['a', 'b', 'd']);
  assert.deepEqual(references('Math.max(x, 1)'), ['x']);
});

test('templates render text and expressions', () => {
  assert.equal(render('Hi {{ name }}, you have {{ n + 1 }} items', { name: 'Ada', n: 2 }), 'Hi Ada, you have 3 items');
  assert.equal(render('{{ missing }}!', {}), '!');
  assert.equal(render('\\{{ literal }}', {}), '{{ literal }}');
  assert.equal(render('{{ { a: 1 }.a }}', {}), '1');
});

test('templates escape html when asked', () => {
  assert.equal(render('<p>{{ x }}</p>', { x: '<b>&"\'' }, { escape: 'html' }), '<p>&lt;b&gt;&amp;&quot;&#39;</p>');
  assert.equal(render('<p>{{ x }}</p>', { x: '<b>' }), '<p><b></p>');
});

test('template syntax errors', () => {
  assert.throws(() => compileTemplate('{{ }}'), ExpressionSyntaxError);
  assert.throws(() => compileTemplate('{{ 1 + '), ExpressionSyntaxError);
  assert.throws(() => compileTemplate('a {{ 1 + }} b'), ExpressionSyntaxError);
});

test('resolve keeps type for a single expression', () => {
  assert.equal(resolve('{{ 1 + 2 }}', {}), 3);
  assert.deepEqual(resolve('{{ items }}', { items: [1, 2] }), [1, 2]);
  assert.equal(resolve('n={{ 1 + 2 }}', {}), 'n=3');
});

test('resolveDeep walks JSON and drops dangerous keys', () => {
  const out = resolveDeep({ a: '{{ x }}', b: ['{{ x + 1 }}', 'plain'], n: 5 }, { x: 1 }) as Record<string, unknown>;
  assert.deepEqual(out, { a: 1, b: [2, 'plain'], n: 5 });
  const bad = JSON.parse('{"__proto__": {"p": 1}, "ok": 1}');
  const r = resolveDeep(bad, {}) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(r), Object.prototype);
  assert.deepEqual(Object.keys(r), ['ok']);
});

test('caller functions return plain data only', () => {
  const functions = { double: (n: unknown) => (n as number) * 2, bad: () => new Date(0), evil: () => ({ __proto__: null, constructor: 1, ok: 1 }) };
  assert.equal(evaluate('double(4)', {}, { functions }), 8);
  assert.throws(() => evaluate('bad()', {}, { functions }), ExpressionForbidden);
  assert.deepEqual(evaluate('evil()', {}, { functions }), { ok: 1 });
});

test('result that is a function is refused', () => {
  assert.throws(() => ev('Math.max'), ExpressionRuntimeError);
});

test('evaluation is deterministic and context is not mutated', () => {
  const ctx = { list: [3, 1, 2] };
  assert.equal(ev('list.sort().join("")', ctx), '123');
  assert.deepEqual(ctx.list, [3, 1, 2]);
  assert.equal(ev('list.sort().join("")', ctx), ev('list.sort().join("")', ctx));
});
