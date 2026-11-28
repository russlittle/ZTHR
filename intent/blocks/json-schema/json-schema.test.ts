import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, validate, infer, example, diff, isCompatible, jsonEqual, SchemaError, SchemaLimitError, type SchemaValue } from './index.ts';

const ok = (s: SchemaValue, i: unknown, o = {}) => validate(s, i, o).valid;
const msgs = (s: SchemaValue, i: unknown) => validate(s, i).problems.map((p) => `${p.path}|${p.code}`);

test('type keyword including integer and arrays of types', () => {
  assert.equal(ok({ type: 'string' }, 'a'), true);
  assert.equal(ok({ type: 'string' }, 1), false);
  assert.equal(ok({ type: 'integer' }, 3), true);
  assert.equal(ok({ type: 'integer' }, 3.0), true);
  assert.equal(ok({ type: 'integer' }, 3.5), false);
  assert.equal(ok({ type: 'number' }, 3), true);
  assert.equal(ok({ type: ['string', 'null'] }, null), true);
  assert.equal(ok({ type: 'object' }, []), false);
  assert.equal(ok({ type: 'array' }, {}), false);
  assert.equal(ok({ type: 'number' }, NaN), false);
});

test('enum and const use deep equality', () => {
  assert.equal(ok({ enum: [1, 'a', { x: [1, 2] }] }, { x: [1, 2] }), true);
  assert.equal(ok({ enum: [1, 'a'] }, 2), false);
  assert.equal(ok({ const: { a: 1, b: 2 } }, { b: 2, a: 1 }), true);
  assert.equal(ok({ const: 1 }, '1'), false);
  assert.equal(jsonEqual([1, { a: 2 }], [1, { a: 2 }]), true);
});

test('numeric keywords', () => {
  assert.equal(ok({ minimum: 5 }, 5), true);
  assert.equal(ok({ minimum: 5 }, 4.9), false);
  assert.equal(ok({ exclusiveMinimum: 5 }, 5), false);
  assert.equal(ok({ maximum: 5 }, 5), true);
  assert.equal(ok({ exclusiveMaximum: 5 }, 5), false);
  assert.equal(ok({ multipleOf: 0.1 }, 0.3), true);
  assert.equal(ok({ multipleOf: 0.01 }, 19.99), true);
  assert.equal(ok({ multipleOf: 3 }, 10), false);
  assert.equal(ok({ minimum: 5 }, 'a'), true);
});

test('string keywords count code points', () => {
  assert.equal(ok({ maxLength: 1 }, '😀'), true);
  assert.equal(ok({ minLength: 2 }, '😀'), false);
  assert.equal(ok({ pattern: '^[a-z]+$' }, 'abc'), true);
  assert.equal(ok({ pattern: '^[a-z]+$' }, 'ab1'), false);
  assert.equal(ok({ pattern: 'b' }, 'abc'), true);
});

test('formats are asserted by default and can be annotation-only', () => {
  assert.equal(ok({ format: 'date' }, '2024-02-29'), true);
  assert.equal(ok({ format: 'date' }, '2023-02-29'), false);
  assert.equal(ok({ format: 'date-time' }, '2024-01-15T12:00:00Z'), true);
  assert.equal(ok({ format: 'date-time' }, '2024-01-15 12:00:00'), false);
  assert.equal(ok({ format: 'email' }, 'a@b.co'), true);
  assert.equal(ok({ format: 'email' }, 'a@b'), false);
  assert.equal(ok({ format: 'uuid' }, '123e4567-e89b-42d3-a456-426614174000'), true);
  assert.equal(ok({ format: 'ipv4' }, '256.1.1.1'), false);
  assert.equal(ok({ format: 'ipv4' }, '192.168.0.1'), true);
  assert.equal(ok({ format: 'ipv6' }, '2001:db8::1'), true);
  assert.equal(ok({ format: 'ipv6' }, '2001:db8::1::2'), false);
  assert.equal(ok({ format: 'hostname' }, '-bad.example'), false);
  assert.equal(ok({ format: 'date' }, 'nope', { formats: 'annotate' }), true);
  assert.equal(ok({ format: 'unknown-thing' }, 'x'), true);
});

test('array keywords', () => {
  assert.equal(ok({ minItems: 2 }, [1]), false);
  assert.equal(ok({ maxItems: 1 }, [1, 2]), false);
  assert.equal(ok({ uniqueItems: true }, [1, 2, 1]), false);
  assert.equal(ok({ uniqueItems: true }, [{ a: 1, b: 2 }, { b: 2, a: 1 }]), false);
  assert.equal(ok({ uniqueItems: true }, [1, '1']), true);
  assert.equal(ok({ items: { type: 'integer' } }, [1, 2, 'x']), false);
  assert.equal(ok({ prefixItems: [{ type: 'string' }, { type: 'integer' }], items: false }, ['a', 1]), true);
  assert.equal(ok({ prefixItems: [{ type: 'string' }], items: false }, ['a', 1]), false);
  assert.equal(ok({ contains: { const: 2 } }, [1, 2]), true);
  assert.equal(ok({ contains: { const: 2 } }, [1, 3]), false);
  assert.equal(ok({ contains: { const: 2 }, minContains: 2 }, [2, 1, 2]), true);
  assert.equal(ok({ contains: { const: 2 }, maxContains: 1 }, [2, 2]), false);
  assert.equal(ok({ contains: { const: 2 }, minContains: 0 }, [1]), true);
});

test('object keywords', () => {
  const s = { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'], additionalProperties: false };
  assert.equal(ok(s, { a: 1 }), true);
  assert.deepEqual(msgs(s, {}), ['a|required']);
  assert.deepEqual(msgs(s, { a: 1, b: 2 }), ['b|false']);
  assert.equal(ok({ minProperties: 1 }, {}), false);
  assert.equal(ok({ maxProperties: 1 }, { a: 1, b: 2 }), false);
  assert.equal(ok({ patternProperties: { '^x-': { type: 'string' } } }, { 'x-a': 'v' }), true);
  assert.equal(ok({ patternProperties: { '^x-': { type: 'string' } } }, { 'x-a': 1 }), false);
  assert.equal(ok({ propertyNames: { maxLength: 2 } }, { abc: 1 }), false);
  assert.equal(ok({ dependentRequired: { a: ['b'] } }, { a: 1 }), false);
  assert.equal(ok({ dependentRequired: { a: ['b'] } }, { b: 1 }), true);
  assert.equal(ok({ dependentSchemas: { a: { required: ['b'] } } }, { a: 1 }), false);
});

test('error paths use the validate block style and pointers', () => {
  const s = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { qty: { type: 'integer', minimum: 1 } } } } } };
  const r = validate(s, { items: [{ qty: 1 }, { qty: 0 }] });
  assert.equal(r.valid, false);
  const p = r.problems[0]!;
  assert.equal(p.path, 'items[1].qty');
  assert.equal(p.pointer, '/items/1/qty');
  assert.equal(p.code, 'minimum');
  assert.equal(p.schemaPath, '/properties/items/items/properties/qty/minimum');
  assert.equal(p.message, 'must be at least 1');
  assert.equal(validate({ type: 'string' }, 1).problems[0]!.path, '(input)');
});

test('all problems are reported together', () => {
  const s = { properties: { a: { type: 'string' }, b: { type: 'integer' } }, required: ['c'] };
  assert.deepEqual(msgs(s, { a: 1, b: 'x' }).sort(), ['a|type', 'b|type', 'c|required']);
});

test('allOf, anyOf, oneOf, not', () => {
  assert.equal(ok({ allOf: [{ type: 'integer' }, { minimum: 2 }] }, 1), false);
  assert.equal(ok({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, 1), true);
  assert.equal(ok({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, null), false);
  assert.equal(ok({ oneOf: [{ minimum: 1 }, { maximum: 5 }] }, 3), false);
  assert.match(validate({ oneOf: [{ minimum: 1 }, { maximum: 5 }] }, 3).problems[0]!.message, /matches 2/);
  assert.equal(ok({ oneOf: [{ minimum: 1 }, { maximum: 5 }] }, 10), true);
  assert.equal(ok({ not: { type: 'string' } }, 1), true);
  assert.equal(ok({ not: { type: 'string' } }, 'a'), false);
});

test('if/then/else', () => {
  const s = { if: { properties: { country: { const: 'US' } }, required: ['country'] }, then: { required: ['zip'] }, else: { required: ['postcode'] } };
  assert.equal(ok(s, { country: 'US', zip: '1' }), true);
  assert.equal(ok(s, { country: 'US' }), false);
  assert.equal(ok(s, { country: 'UK', postcode: 'x' }), true);
  assert.equal(ok(s, { country: 'UK' }), false);
});

test('boolean schemas', () => {
  assert.equal(ok(true, 1), true);
  assert.equal(ok(false, 1), false);
  assert.equal(ok({ properties: { a: false } }, { a: 1 }), false);
  assert.equal(ok({ properties: { a: false } }, {}), true);
});

test('$ref with $defs, recursion and pointer escapes', () => {
  const s = { $defs: { node: { type: 'object', properties: { next: { $ref: '#/$defs/node' }, v: { type: 'integer' } } }, 'a/b': { type: 'string' } }, $ref: '#/$defs/node' };
  assert.equal(ok(s, { v: 1, next: { v: 2, next: {} } }), true);
  assert.equal(ok(s, { v: 1, next: { v: 'x' } }), false);
  assert.equal(ok({ $defs: { 'a/b': { type: 'string' } }, $ref: '#/$defs/a~1b' }, 1), false);
});

test('$anchor, $id and external documents supplied by the caller', () => {
  const s = { $id: 'https://example.com/root', $defs: { x: { $anchor: 'thing', type: 'integer' } }, properties: { a: { $ref: '#thing' }, b: { $ref: 'https://example.com/other' } } };
  const other = { $id: 'https://example.com/other', type: 'string' };
  const v = compile(s, { schemas: [other] });
  assert.equal(v.validate({ a: 1, b: 'x' }).valid, true);
  assert.equal(v.validate({ a: 'x' }).valid, false);
  assert.equal(v.validate({ b: 1 }).valid, false);
  assert.throws(() => compile(s), SchemaError);
});

test('refs to unknown places fail at compile time and never fetch', () => {
  assert.throws(() => compile({ $ref: '#/$defs/missing' }), SchemaError);
  assert.throws(() => compile({ $ref: 'http://169.254.169.254/latest' }), /never fetched/);
  assert.throws(() => compile({ $ref: '#nope' }), SchemaError);
});

test('a $ref cycle without progress stops with a limit error', () => {
  const s = { $defs: { a: { $ref: '#/$defs/a' } }, $ref: '#/$defs/a' };
  assert.throws(() => validate(s, 1), SchemaLimitError);
});

test('unevaluatedProperties sees through allOf, $ref and if', () => {
  const s = { allOf: [{ properties: { a: true } }], properties: { b: true }, unevaluatedProperties: false };
  assert.equal(ok(s, { a: 1, b: 2 }), true);
  assert.equal(ok(s, { a: 1, c: 2 }), false);
  const viaRef = { $defs: { base: { properties: { id: true } } }, $ref: '#/$defs/base', unevaluatedProperties: false };
  assert.equal(ok(viaRef, { id: 1 }), true);
  assert.equal(ok(viaRef, { id: 1, x: 1 }), false);
  const failed = { anyOf: [{ properties: { a: true }, required: ['z'] }, { properties: { b: true } }], unevaluatedProperties: false };
  assert.equal(ok(failed, { a: 1 }), false);
  assert.equal(ok(failed, { b: 1 }), true);
});

test('unevaluatedItems', () => {
  assert.equal(ok({ prefixItems: [true], unevaluatedItems: false }, [1]), true);
  assert.equal(ok({ prefixItems: [true], unevaluatedItems: false }, [1, 2]), false);
  assert.equal(ok({ contains: { const: 1 }, unevaluatedItems: false }, [1, 1]), true);
  assert.equal(ok({ contains: { const: 1 }, unevaluatedItems: false }, [1, 2]), false);
});

test('hostile: invalid patterns rejected at compile, long inputs not run through patterns', () => {
  assert.throws(() => compile({ pattern: '(' }), SchemaError);
  assert.throws(() => compile({ pattern: 'a'.repeat(1001) }), SchemaError);
  const r = validate({ pattern: '^(a+)+$' }, 'a'.repeat(50_000));
  assert.equal(r.valid, false);
  assert.match(r.problems[0]!.message, /too long/);
});

test('hostile: deep instance is cut off, problems are capped', () => {
  let deep: unknown = 1;
  for (let i = 0; i < 200; i++) deep = [deep];
  assert.throws(() => validate({ $defs: { n: { items: { $ref: '#/$defs/n' } } }, $ref: '#/$defs/n' }, deep), SchemaLimitError);
  const r = validate({ items: { type: 'string' } }, Array.from({ length: 1000 }, () => 1), { maxProblems: 5 });
  assert.equal(r.problems.length, 5);
});

test('hostile: __proto__ in instances is plain data', () => {
  const inst = JSON.parse('{"__proto__": {"x": 1}}');
  assert.equal(ok({ additionalProperties: false }, inst), false);
  assert.equal(ok({ properties: { x: { type: 'string' } } }, inst), true);
  assert.equal(ok({ required: ['toString'] }, {}), false);
});

test('compile rejects non-schemas and conflicting ids', () => {
  assert.throws(() => compile(5 as unknown as SchemaValue), SchemaError);
  assert.throws(() => compile({ $defs: { a: { $id: 'urn:x:a', type: 'string' }, b: { $id: 'urn:x:a', type: 'integer' } } }), SchemaError);
  assert.throws(() => compile({ $defs: { a: { $anchor: 'z' }, b: { $anchor: 'z' } } }), SchemaError);
});

test('infer builds a schema accepting every sample', () => {
  const samples = [{ id: 1, name: 'a', tags: ['x'], when: '2024-01-15' }, { id: 2, name: 'b', tags: [], note: null }];
  const s = infer(samples) as Record<string, unknown>;
  assert.deepEqual(s.required, ['id', 'name', 'tags']);
  const v = compile(s as SchemaValue);
  for (const x of samples) assert.equal(v.validate(x).valid, true);
  assert.equal(v.validate({ id: 'x', name: 'a', tags: [] }).valid, false);
  const props = s.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.id!.type, 'integer');
  assert.deepEqual(props.note!.type, 'null');
  assert.equal(props.when!.format, 'date');
  assert.equal((infer([1, 2.5]) as Record<string, unknown>).type, 'number');
  assert.deepEqual((infer([1, 'a']) as Record<string, unknown>).type, ['integer', 'string']);
});

test('example generates valid instances', () => {
  const s: SchemaValue = { type: 'object', required: ['id', 'email', 'tags', 'kind'], properties: { id: { type: 'integer', minimum: 10, maximum: 20 }, email: { type: 'string', format: 'email' }, tags: { type: 'array', minItems: 2, items: { type: 'string', minLength: 3 }, uniqueItems: true }, kind: { enum: ['a', 'b'] }, opt: { type: 'string' } } };
  const e = example(s) as Record<string, unknown>;
  assert.equal(e.id, 10);
  assert.equal(e.email, 'user@example.com');
  assert.equal((e.tags as unknown[]).length, 2);
  assert.equal(e.kind, 'a');
  assert.equal('opt' in e, false);
  assert.equal(compile(s).validate(e).valid, true);
  assert.equal(example({ type: 'integer', exclusiveMinimum: 5, multipleOf: 4 }), 8);
  assert.equal(example({ $defs: { d: { type: 'string', minLength: 3 } }, $ref: '#/$defs/d' }), 'aaa');
  assert.equal(example({ oneOf: [{ type: 'string', pattern: '^x$', examples: ['x'] }, { type: 'integer' }] }), 'x');
  assert.deepEqual(example({ allOf: [{ properties: { a: { const: 1 } }, required: ['a'] }, { properties: { b: { const: 2 } }, required: ['b'] }] }), { a: 1, b: 2 });
});

test('example refuses what it cannot do and picks via injected rng', () => {
  assert.throws(() => example(false), SchemaError);
  assert.throws(() => example({ type: 'string', pattern: '^[a-z]{3}$' }), SchemaError);
  assert.throws(() => example({ $defs: { n: { type: 'object', required: ['n'], properties: { n: { $ref: '#/$defs/n' } } } }, $ref: '#/$defs/n' }), SchemaError);
  assert.equal(example({ enum: ['a', 'b', 'c'] }, { rng: () => 0.99 }), 'c');
});

const base: SchemaValue = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 }, name: { type: 'string', maxLength: 10 }, kind: { enum: ['a', 'b'] } } };

test('diff: compatible changes for an input contract', () => {
  const next: SchemaValue = { type: 'object', required: [], properties: { id: { type: 'integer', minimum: 0 }, name: { type: 'string', maxLength: 20 }, kind: { enum: ['a', 'b', 'c'] }, extra: true } };
  const d = diff(base, next);
  assert.equal(d.every((c) => c.kind === 'compatible'), true);
  assert.deepEqual(d.map((c) => c.code).sort(), ['enum', 'maxLength', 'minimum', 'property-added', 'required']);
  assert.equal(isCompatible(base, next), true);
});

test('diff: breaking changes for an input contract carry pointers', () => {
  const next: SchemaValue = { type: 'object', required: ['id', 'name'], properties: { id: { type: 'integer', minimum: 5 }, name: { type: 'string', maxLength: 5 }, kind: { enum: ['a'] } } };
  const d = diff(base, next);
  assert.equal(d.every((c) => c.kind === 'breaking'), true);
  assert.deepEqual(d.map((c) => c.at).sort(), ['/properties/id/minimum', '/properties/kind/enum', '/properties/name/maxLength', '/required']);
  assert.equal(d.find((c) => c.code === 'required')!.message, 'name is now required');
});

test('diff: output direction flips the classification', () => {
  const narrowed: SchemaValue = { ...(base as object), required: ['id', 'name'] };
  assert.equal(isCompatible(base, narrowed, { direction: 'input' }), false);
  assert.equal(isCompatible(base, narrowed, { direction: 'output' }), true);
});

test('diff: type changes, closing objects and unchanged schemas', () => {
  assert.deepEqual(diff(base, base), []);
  const t = diff({ type: 'string' }, { type: ['string', 'null'] });
  assert.deepEqual(t.map((c) => [c.kind, c.code]), [['compatible', 'type']]);
  const t2 = diff({ type: ['string', 'null'] }, { type: 'string' });
  assert.equal(t2[0]!.kind, 'breaking');
  assert.equal(diff({ type: 'number' }, { type: 'integer' })[0]!.kind, 'breaking');
  assert.equal(diff({ type: 'integer' }, { type: 'number' })[0]!.kind, 'compatible');
  const closed = diff({ type: 'object' }, { type: 'object', additionalProperties: false });
  assert.equal(closed[0]!.kind, 'breaking');
  assert.equal(diff({ $ref: '#/a' }, { $ref: '#/b' })[0]!.kind, 'breaking');
});
