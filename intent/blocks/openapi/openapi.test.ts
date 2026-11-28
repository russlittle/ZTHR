import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Versions } from '../apiver/index.ts';
import { InvalidApi, arr, bool, build, check, contract, diff, enumOf, exampleFor, int, isBackwardCompatible, nullable, obj, ref, str, validateValue, verifyResponse } from './index.ts';
import type { OpenApiDocument, RouteDecl } from './index.ts';

const User = obj({ id: int({ minimum: 1 }), name: str({ minLength: 1 }), role: enumOf(['admin', 'member']), email: nullable(str({ format: 'email' })) }, { required: ['id', 'name', 'role'] });

const routes = (): RouteDecl[] => [
  { method: 'get', path: '/users/{id}', operationId: 'getUser', pathParams: { id: int({ minimum: 1 }) }, responses: { '200': { description: 'The user', schema: ref('User'), example: { id: 1, name: 'Ada', role: 'admin', email: null } }, '404': { description: 'Missing' } } },
  { method: 'post', path: '/users', operationId: 'createUser', body: { schema: obj({ name: str({ minLength: 1 }), role: enumOf(['admin', 'member']) }, { required: ['name'] }) }, responses: { '201': { description: 'Created', schema: ref('User'), headers: { Location: { schema: str(), required: true } } } }, security: 'none' },
  { method: 'get', path: '/users', operationId: 'listUsers', query: { limit: { schema: int({ minimum: 1, maximum: 100 }) }, q: { schema: str(), required: true } }, responses: { '200': { description: 'Users', schema: arr(ref('User')) } } },
];

const make = (r = routes(), extra: Partial<Parameters<typeof build>[0]> = {}): OpenApiDocument =>
  build({ info: { title: 'Users', version: '1.0.0' }, routes: r, schemas: { User }, securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, security: ['bearer'], ...extra });
const clone = <T>(x: T): T => structuredClone(x);

test('build makes a 3.1 document that passes its own check', () => {
  const d = make();
  assert.equal(d.openapi, '3.1.0');
  assert.deepEqual(Object.keys(d.paths).sort(), ['/users', '/users/{id}']);
  assert.deepEqual(check(d).errors, []);
  assert.deepEqual(d.paths['/users']!['post']!['security'], []);
  assert.deepEqual(d.paths['/users/{id}']!['get']!['parameters'], [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }]);
});

test('build lists every problem in one InvalidApi', () => {
  const bad = routes();
  bad.push({ method: 'get', path: '/x/{a}', operationId: 'getUser', responses: { '200': { description: 'ok', schema: ref('Nope') } } });
  assert.throws(() => make(bad), (e: unknown) => {
    assert.ok(e instanceof InvalidApi);
    assert.ok(e.problems.some((p) => p.includes('already used')));
    assert.ok(e.problems.some((p) => p.includes('{a}')));
    assert.ok(e.problems.some((p) => p.includes('#/components/schemas/Nope')));
    return true;
  });
});

test('an example that does not fit its schema is refused', () => {
  const bad = routes();
  bad[0] = { ...bad[0]!, responses: { '200': { description: 'u', schema: ref('User'), example: { id: 0, name: '', role: 'root' } } } };
  assert.throws(() => make(bad), (e: unknown) => e instanceof InvalidApi && e.problems.some((p) => p.includes('example') && p.includes('at least 1')) && e.problems.some((p) => p.includes('one of')));
});

test('problem responses and apiver versions are added to every operation', () => {
  const v = new Versions('2025-01-01', [{ version: '2026-01-01', description: 'x', down: (b) => b }], { notes: 'https://docs.example.org' });
  const d = make(routes(), { problems: [400, 404], versions: v });
  assert.ok(d.components!.schemas!['Problem']);
  const get = d.paths['/users']!['get']!;
  assert.ok((get['responses'] as Record<string, unknown>)['400']);
  assert.ok((d.paths['/users/{id}']!['get']!['responses'] as Record<string, { description: string }>)['404']!.description === 'Missing');
  assert.ok((get['parameters'] as unknown[]).some((p) => (p as { $ref?: string }).$ref === '#/components/parameters/ApiVersion'));
  assert.equal(d.info.version, '1.0.0');
  assert.deepEqual(check(d).errors, []);
});

test('check rejects 3.0 leftovers, external refs, missing security schemes and bad statuses', () => {
  const d = clone(make());
  d.openapi = '3.0.3';
  (d.components!.schemas!['User'] as { properties: Record<string, unknown> }).properties['x'] = { type: 'string', nullable: true };
  (d.paths['/users']!['get']!['responses'] as Record<string, unknown>)['200'] = { description: 'x', content: { 'application/json': { schema: { $ref: 'https://example.com/a.json' } } } };
  (d.paths['/users']!['get'] as Record<string, unknown>)['security'] = [{ missing: [] }];
  (d.paths['/users']!['get']!['responses'] as Record<string, unknown>)['9xx'] = { description: 'bad' };
  const msgs = check(d).errors.map((e) => e.message).join('\n');
  assert.match(msgs, /3\.1/);
  assert.match(msgs, /nullable/);
  assert.match(msgs, /not inside this document/);
  assert.match(msgs, /"missing"/);
  assert.match(msgs, /"9xx"/);
});

test('check warns about unused schemas and missing operationIds', () => {
  const d = clone(make());
  d.components!.schemas!['Orphan'] = str();
  delete d.paths['/users']!['get']!['operationId'];
  const w = check(d).warnings.map((x) => x.message).join('\n');
  assert.match(w, /never referenced/);
  assert.match(w, /operationId/);
});

test('validateValue covers types, limits, formats, unions and refs with paths', () => {
  const r = (n: string) => (n === '#/components/schemas/User' ? User : undefined);
  assert.deepEqual(validateValue(ref('User'), { id: 1, name: 'a', role: 'admin', email: 'a@b.co' }, r), []);
  const p = validateValue(ref('User'), { id: 1.5, role: 'x', extra: 1, email: 'nope' }, r);
  const text = p.map((x) => `${x.path} ${x.message}`).join('|');
  assert.match(text, /\/id must be integer/);
  assert.match(text, /\/name is required/);
  assert.match(text, /\/role must be one of/);
  assert.match(text, /\/extra is not allowed/);
  assert.match(text, /\/email must be a valid email/);
  assert.equal(validateValue({ oneOf: [str(), int()] }, true).length, 1);
  assert.equal(validateValue({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 3).length, 1);
  assert.equal(validateValue(arr(int(), { uniqueItems: true }), [1, 2, 1]).length, 1);
  assert.equal(validateValue(str({ maxLength: 2 }), '😀😀😀').length, 1);
  assert.equal(validateValue({ type: 'number', multipleOf: 0.1 }, 0.3).length, 0);
  assert.equal(validateValue(str({ format: 'date' }), '2026-02-30').length, 1);
});

test('exampleFor builds a valid value from the schema', () => {
  const s = obj({ a: str({ format: 'uuid' }), b: arr(int({ minimum: 5 }), { minItems: 2 }), c: enumOf(['x', 'y']), d: nullable(bool()), e: str({ minLength: 8 }) }, { required: ['a'] });
  const v = exampleFor(s) as Record<string, unknown>;
  assert.deepEqual(validateValue(s, v), []);
  assert.deepEqual(v['b'], [5, 5]);
  assert.equal(exampleFor(int({ example: 42 })), 42);
});

test('diff: removed operations and paths are breaking', () => {
  const a = make();
  const b = clone(a);
  delete b.paths['/users']!['post'];
  delete b.paths['/users/{id}'];
  const c = diff(a, b);
  assert.deepEqual(c.map((x) => x.rule).sort(), ['operation-removed', 'path-removed']);
  assert.equal(isBackwardCompatible(c), false);
});

test('diff: requests that got stricter break, ones that got looser do not', () => {
  const a = make();
  const b = clone(a);
  const lim = b.paths['/users']!['get']!['parameters'] as { name: string; schema: { maximum?: number } }[];
  lim.find((p) => p.name === 'limit')!.schema.maximum = 50;
  b.paths['/users']!['get']!['parameters'] = [...lim, { name: 'sort', in: 'query', required: true, schema: { type: 'string' } }];
  const body = (b.paths['/users']!['post']!['requestBody'] as { content: Record<string, { schema: { required: string[]; properties: Record<string, unknown> } }> }).content['application/json']!.schema;
  body.required.push('role');
  const rules = diff(a, b).filter((x) => x.severity === 'breaking').map((x) => x.rule).sort();
  assert.deepEqual(rules, ['maximum-tightened', 'property-now-required', 'required-parameter-added']);
  // The reverse direction: everything loosened is safe.
  assert.deepEqual(diff(b, a).filter((x) => x.severity === 'breaking'), []);
});

test('diff: response changes break in the opposite direction', () => {
  const a = make();
  const b = clone(a);
  const user = b.components!.schemas!['User'] as { properties: Record<string, unknown>; required: string[] };
  user.properties['role'] = { type: 'string', enum: ['admin', 'member', 'guest'] };
  delete user.properties['email'];
  user.properties['age'] = { type: 'integer' };
  user.required = ['id'];
  const c = diff(a, b);
  const by = (r: string) => c.filter((x) => x.rule === r);
  assert.equal(by('enum-value-added')[0]!.severity, 'breaking');
  assert.equal(by('property-removed')[0]!.severity, 'breaking');
  assert.equal(by('property-added')[0]!.severity, 'non-breaking');
  assert.equal(by('property-now-optional').length > 0, true);
  assert.ok(c.some((x) => x.where.startsWith('GET /users/{id} 200')));
});

test('diff: type changes, security added and deprecation are classified', () => {
  const a = make();
  const b = clone(a);
  (b.components!.schemas!['User'] as { properties: Record<string, { type: unknown }> }).properties['id']!.type = 'string';
  (b.paths['/users']!['post'] as Record<string, unknown>)['security'] = [{ bearer: [] }];
  (b.paths['/users']!['get'] as Record<string, unknown>)['deprecated'] = true;
  const c = diff(a, b);
  assert.ok(c.some((x) => x.rule === 'type-changed' && x.severity === 'breaking'));
  assert.ok(c.some((x) => x.rule === 'security-added' && x.severity === 'breaking'));
  assert.ok(c.some((x) => x.rule === 'deprecated' && x.severity === 'info'));
  assert.equal(c[0]!.severity, 'breaking');
});

test('diff of a document with itself is empty and a new operation is not breaking', () => {
  const a = make();
  assert.deepEqual(diff(a, clone(a)), []);
  const extra = [...routes(), { method: 'delete', path: '/users/{id}', operationId: 'deleteUser', pathParams: { id: int() }, responses: { '204': { description: 'Gone' } } } as RouteDecl];
  const c = diff(a, make(extra));
  assert.deepEqual(c.map((x) => x.rule), ['operation-added']);
  assert.equal(isBackwardCompatible(c), true);
});

test('contract makes a request per operation from examples and schemas', () => {
  const cases = contract(make());
  assert.equal(cases.length, 3);
  const get = cases.find((c) => c.operationId === 'getUser')!;
  assert.equal(get.request.url, '/users/1');
  const list = cases.find((c) => c.operationId === 'listUsers')!;
  assert.deepEqual(list.request.query, { q: 'string' });
  const create = cases.find((c) => c.operationId === 'createUser')!;
  assert.equal(create.request.contentType, 'application/json');
  assert.deepEqual(validateValue(obj({ name: str({ minLength: 1 }), role: enumOf(['admin', 'member']) }, { required: ['name'] }), create.request.body), []);
  assert.deepEqual(get.statuses, ['200', '404']);
});

test('verifyResponse accepts a conforming response and explains each deviation', () => {
  const d = make();
  const ok = { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: { id: 1, name: 'Ada', role: 'admin', email: null } };
  assert.deepEqual(verifyResponse(d, { operationId: 'getUser' }, ok), []);
  const wrongBody = verifyResponse(d, { operationId: 'getUser' }, { ...ok, body: { id: 'x', name: 'Ada', role: 'admin' } });
  assert.match(wrongBody[0]!.path, /^\/body\/id/);
  assert.match(verifyResponse(d, { operationId: 'getUser' }, { status: 500 })[0]!.message, /not declared/);
  assert.match(verifyResponse(d, { operationId: 'getUser' }, { ...ok, headers: { 'content-type': 'text/html' } })[0]!.message, /text\/html/);
  assert.match(verifyResponse(d, { operationId: 'createUser' }, { status: 201, headers: { 'content-type': 'application/json' }, body: ok.body })[0]!.message, /required/);
  assert.match(verifyResponse(d, { method: 'GET', path: '/nope' }, ok)[0]!.message, /no such operation/);
  assert.match(verifyResponse(d, { operationId: 'getUser' }, { status: 404, body: { oops: true } })[0]!.message, /no body/);
});
