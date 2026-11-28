import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCHEMA_BULK_REQUEST, SCHEMA_ENTERPRISE, SCHEMA_PATCH, ScimError, ScimServer, applyPatch, matches, parseFilter } from './index.ts';
import type { Resource, ScimResponse } from './index.ts';

function setup() {
  let n = 0;
  const t = { v: Date.UTC(2026, 10, 1) };
  const passwords: [string, string][] = [];
  const changes: string[] = [];
  const s = new ScimServer({ baseUrl: 'https://app.example.org/scim/v2', now: () => t.v, newId: () => `id${++n}`, onPassword: (i, p) => passwords.push([i, p]), onChange: (e) => changes.push(`${e.action}:${e.kind}:${e.id}`) });
  const call = (method: string, path: string, body?: unknown, extra: { query?: Record<string, string>; headers?: Record<string, string> } = {}) => s.handle({ method, path, ...(body === undefined ? {} : { body }), ...extra });
  return { s, t, call, passwords, changes };
}
const USER = (name: string, extra: object = {}) => ({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: name, ...extra });
const patch = (...ops: object[]) => ({ schemas: [SCHEMA_PATCH], Operations: ops });
const body = (r: ScimResponse) => r.body as Resource;
const err = (r: ScimResponse) => r.body as { status: string; scimType?: string; detail: string };
const people = [
  { id: '1', userName: 'Ana', name: { givenName: 'Ana', familyName: 'Ruiz' }, active: true, emails: [{ value: 'ana@work.example', type: 'work', primary: true }, { value: 'ana@home.example', type: 'home' }], meta: { lastModified: '2026-01-02T00:00:00Z' } },
  { id: '2', userName: 'bo', name: { givenName: 'Bo' }, active: false, emails: [{ value: 'bo@work.example', type: 'work' }], title: 'Chief' },
  { id: '3', userName: 'Cy', externalId: 'ExT-9', active: true },
];
const pick = (f: string) => people.filter((p) => matches(parseFilter(f), p)).map((p) => p.id).join(',');

test('filters: comparison operators, case-insensitive attribute names and strings, case-exact ids', () => {
  assert.equal(pick('userName eq "ana"'), '1');
  assert.equal(pick('USERNAME EQ "BO"'), '2');
  assert.equal(pick('userName sw "A"'), '1');
  assert.equal(pick('userName ew "y"'), '3');
  assert.equal(pick('userName co "n"'), '1');
  assert.equal(pick('userName gt "b"'), '2,3');
  assert.equal(pick('userName le "bo"'), '1,2');
  assert.equal(pick('active eq true'), '1,3');
  assert.equal(pick('name.givenName eq "Bo"'), '2');
  assert.equal(pick('externalId eq "ExT-9"'), '3');
  assert.equal(pick('externalId eq "ext-9"'), '', 'externalId is case-exact');
  assert.equal(pick('id eq "2"'), '2');
  assert.equal(pick('meta.lastModified gt "2026-01-01T00:00:00Z"'), '1');
});

test('filters: presence, not, and/or precedence, parentheses, and ne over missing attributes', () => {
  assert.equal(pick('title pr'), '2');
  assert.equal(pick('not (title pr)'), '1,3');
  assert.equal(pick('active eq true and name.familyName pr'), '1');
  assert.equal(pick('title pr or externalId pr'), '2,3');
  assert.equal(pick('title pr or active eq true and userName eq "cy"'), '2,3', 'and binds tighter than or');
  assert.equal(pick('(title pr or active eq true) and userName eq "cy"'), '3');
  assert.equal(pick('title ne "Chief"'), '1,3');
  assert.equal(pick('title eq null'), '1,3');
  assert.equal(pick('emails pr'), '1,2');
});

test('value filters match within one element of a multi-valued attribute, not across elements', () => {
  assert.equal(pick('emails[type eq "work" and value co "ana"]'), '1');
  assert.equal(pick('emails[type eq "home" and value co "bo"]'), '', 'a home address and a bo address are different elements');
  assert.equal(pick('emails.value co "home"'), '1', 'the dotted form matches any element');
  assert.equal(pick('emails[primary eq true]'), '1');
  assert.equal(pick('emails[type eq "work"] and active eq false'), '2');
  assert.equal(pick('not (emails[type eq "home"])'), '2,3');
});

test('malformed filters are refused with invalidFilter', () => {
  for (const f of ['', 'userName', 'userName eq', 'userName foo "x"', 'userName eq "x', '(userName eq "x"', 'userName eq "x")', 'a eq 1 and', 'not userName eq "x"', 'userName co 5', 'emails[type eq "work"', 'a[b[c eq 1] eq 2]', 'userName eq "x" userName eq "y"', '@bad eq 1', `a eq "${'x'.repeat(2100)}"`, `${'('.repeat(30)}a pr${')'.repeat(30)}`]) {
    assert.throws(() => parseFilter(f), (e: Error) => e instanceof ScimError && e.status === 400 && e.scimType === 'invalidFilter', f.slice(0, 40));
  }
  assert.deepEqual(parseFilter('urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department eq "R&D"'), { t: 'cmp', path: ['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User', 'department'], op: 'eq', value: 'R&D' });
});

test('creating a user: 201 with id, meta, location, ETag; passwords go to the callback and are never returned or stored', () => {
  const { call, passwords, changes } = setup();
  const r = call('POST', '/Users', USER('ana@example.org', { password: 'hunter2', name: { givenName: 'Ana' }, emails: [{ value: 'ana@example.org', primary: true }], active: 'True' }));
  assert.equal(r.status, 201);
  const u = body(r);
  assert.deepEqual([u.id, u.active, u.password], ['id1', true, undefined]);
  assert.equal(r.headers.location, 'https://app.example.org/scim/v2/Users/id1');
  assert.match(r.headers.etag!, /^W\/"[0-9a-f]{20}"$/);
  assert.deepEqual(u.meta, { resourceType: 'User', created: '2026-11-01T00:00:00.000Z', lastModified: '2026-11-01T00:00:00.000Z', location: 'https://app.example.org/scim/v2/Users/id1', version: r.headers.etag });
  assert.deepEqual(passwords, [['id1', 'hunter2']]);
  assert.equal(JSON.stringify(call('GET', '/Users/id1').body).includes('hunter2'), false);
  assert.deepEqual(changes, ['create:User:id1']);
  assert.equal(r.headers['content-type'], 'application/scim+json');
});

test('create refuses duplicates (409 uniqueness, any case), unknown and badly typed attributes, a missing userName, two primaries', () => {
  const { call } = setup();
  call('POST', '/Users', USER('Ana@Example.org', { externalId: 'x1' }));
  const dup = call('POST', '/Users', USER('ana@example.org'));
  assert.deepEqual([dup.status, err(dup).scimType, err(dup).status], [409, 'uniqueness', '409']);
  assert.equal(call('POST', '/Users', USER('other', { externalId: 'x1' })).status, 409);
  const cases: [unknown, string][] = [
    [USER('a', { nonsense: 1 }), 'invalidValue'], [USER('a', { active: 'maybe' }), 'invalidValue'], [{ schemas: [] }, 'invalidValue'], [USER('  '), 'invalidValue'],
    [USER('a', { emails: 'x' }), 'invalidValue'], [USER('a', { emails: [{ value: 'a', bogus: 1 }] }), 'invalidValue'],
    [USER('a', { emails: [{ value: 'a', primary: true }, { value: 'b', primary: true }] }), 'invalidValue'], [[1], 'invalidSyntax'],
  ];
  for (const [b, type] of cases) assert.equal(err(call('POST', '/Users', b)).scimType, type, JSON.stringify(b).slice(0, 60));
  const ro = body(call('POST', '/Users', USER('ro', { id: 'chosen', meta: { version: 'x' }, groups: [{ value: 'g' }] })));
  assert.equal(ro.id, 'id2', 'read-only attributes in the body are ignored');
});

test('get, list, and 404 with the SCIM error body', () => {
  const { call } = setup();
  for (const n of ['ana', 'bo', 'cy']) call('POST', '/Users', USER(n));
  assert.equal(body(call('GET', '/Users/id2')).userName, 'bo');
  const miss = call('GET', '/Users/nope');
  assert.deepEqual([miss.status, body(miss).schemas, err(miss).status], [404, ['urn:ietf:params:scim:api:messages:2.0:Error'], '404']);
  const l = body(call('GET', '/Users')) as { totalResults: number; startIndex: number; itemsPerPage: number; Resources: Resource[] };
  assert.deepEqual([l.totalResults, l.startIndex, l.itemsPerPage, l.Resources.length], [3, 1, 3, 3]);
  assert.equal(call('GET', '/Nothing').status, 404);
  assert.equal(call('GET', '/Users/a/b/c').status, 404);
  assert.equal(call('DELETE', '/Users').status, 405);
});

test('list: filter, sort, paging, count=0, attributes and excludedAttributes, and bad parameters', () => {
  const { call } = setup();
  for (const [n, a] of [['ana', true], ['bo', false], ['cy', true], ['di', true]] as const) call('POST', '/Users', USER(n, { active: a, title: n.toUpperCase() }));
  const q = (query: Record<string, string>) => body(call('GET', '/Users', undefined, { query })) as { totalResults: number; itemsPerPage: number; startIndex: number; Resources: Resource[] };
  assert.deepEqual(q({ filter: 'active eq true' }).Resources.map((r) => r.userName), ['ana', 'cy', 'di']);
  assert.deepEqual(q({ sortBy: 'userName', sortOrder: 'descending' }).Resources.map((r) => r.userName), ['di', 'cy', 'bo', 'ana']);
  const page = q({ sortBy: 'userName', startIndex: '2', count: '2' });
  assert.deepEqual([page.totalResults, page.startIndex, page.itemsPerPage, page.Resources.map((r) => r.userName)], [4, 2, 2, ['bo', 'cy']]);
  assert.deepEqual([q({ count: '0' }).totalResults, q({ count: '0' }).Resources.length], [4, 0]);
  assert.deepEqual(q({ startIndex: '0', count: '1' }).startIndex, 1, 'startIndex below 1 is 1');
  assert.deepEqual(q({ startIndex: '9' }).Resources, []);
  assert.deepEqual(Object.keys(q({ attributes: 'userName', count: '1' }).Resources[0]!).sort(), ['id', 'schemas', 'userName']);
  assert.equal('title' in q({ excludedAttributes: 'title,meta', count: '1' }).Resources[0]!, false);
  for (const bad of [{ filter: 'x eq' }, { count: '-1' }, { count: 'many' }, { startIndex: '1.5' }, { sortOrder: 'sideways', sortBy: 'userName' }]) assert.equal(call('GET', '/Users', undefined, { query: bad }).status, 400, JSON.stringify(bad));
});

test('PUT replaces everything but keeps id and created; DELETE removes and returns 204', () => {
  const { call, t } = setup();
  const c = call('POST', '/Users', USER('ana', { title: 'Old', active: true }));
  t.v += 60_000;
  const put = call('PUT', '/Users/id1', USER('ana', { displayName: 'Ana R' }));
  const u = body(put);
  assert.deepEqual([put.status, u.id, u.title, u.displayName, (u.meta as { created: string }).created], [200, 'id1', undefined, 'Ana R', (body(c).meta as { created: string }).created]);
  assert.notEqual(put.headers.etag, c.headers.etag);
  assert.equal(call('PUT', '/Users/ghost', USER('x')).status, 404);
  assert.equal(call('PUT', '/Users/id1', USER('bo')).status, 200);
  call('POST', '/Users', USER('cy'));
  assert.equal(call('PUT', '/Users/id2', USER('bo')).status, 409, 'cannot take another user\'s name');
  assert.equal(call('DELETE', '/Users/id1').status, 204);
  assert.equal(call('GET', '/Users/id1').status, 404);
  assert.equal(call('DELETE', '/Users/id1').status, 404);
});

test('ETags: If-Match guards writes with 412, If-None-Match gives 304, and the version tracks content', () => {
  const { call } = setup();
  const c = call('POST', '/Users', USER('ana'));
  const v1 = c.headers.etag!;
  assert.equal(call('GET', '/Users/id1', undefined, { headers: { 'If-None-Match': v1 } }).status, 304);
  const p = call('PATCH', '/Users/id1', patch({ op: 'replace', path: 'title', value: 'Boss' }), { headers: { 'if-match': v1 } });
  assert.equal(p.status, 200);
  const v2 = p.headers.etag!;
  assert.notEqual(v1, v2);
  const stale = call('PUT', '/Users/id1', USER('ana'), { headers: { 'If-Match': v1 } });
  assert.deepEqual([stale.status, err(stale).scimType], [412, 'invalidVers']);
  assert.equal(call('DELETE', '/Users/id1', undefined, { headers: { 'If-Match': v1 } }).status, 412);
  assert.equal(call('GET', '/Users/id1', undefined, { headers: { 'if-none-match': v1 } }).status, 200);
  const same = call('PATCH', '/Users/id1', patch({ op: 'replace', path: 'title', value: 'Boss' }));
  assert.equal(same.headers.etag, v2, 'same content, same version');
  assert.equal(call('DELETE', '/Users/id1', undefined, { headers: { 'If-Match': '*' } }).status, 204);
});

const mkUser = (extra: object = {}): Resource => ({ schemas: ['u'], id: 'u1', userName: 'ana', emails: [{ value: 'a@work.example', type: 'work', primary: true }, { value: 'a@home.example', type: 'home' }], meta: { created: 'c', version: 'v' }, ...extra }) as Resource;

test('PatchOp replace and add: simple, complex, sub-attribute paths and no-path objects; operation names in any case', () => {
  const r = applyPatch('User', mkUser(), patch(
    { op: 'Replace', path: 'displayName', value: 'Ana R' },
    { op: 'add', path: 'name.givenName', value: 'Ana' },
    { op: 'ADD', path: 'name', value: { familyName: 'Ruiz' } },
    { op: 'replace', value: { title: 'Dr', active: 'False' } },
    { op: 'add', path: `${SCHEMA_ENTERPRISE}:department`, value: 'R&D' },
    { op: 'add', value: { [SCHEMA_ENTERPRISE]: { costCenter: '42' } } },
  ));
  assert.deepEqual([r.displayName, r.name, r.title, r.active], ['Ana R', { givenName: 'Ana', familyName: 'Ruiz' }, 'Dr', false]);
  assert.deepEqual(r[SCHEMA_ENTERPRISE], { department: 'R&D', costCenter: '42' });
});

test('PatchOp on multi-valued attributes: append without duplicating, replace the list, filter to change one element, one primary', () => {
  const add = applyPatch('User', mkUser(), patch(
    { op: 'add', path: 'emails', value: [{ value: 'a@home.example', type: 'home', display: 'Home' }, { value: 'a@new.example', type: 'other', primary: true }] },
  ));
  assert.deepEqual((add.emails as { value: string; primary?: boolean; display?: string }[]).map((e) => [e.value, e.primary ?? false, e.display]), [['a@work.example', false, undefined], ['a@home.example', false, 'Home'], ['a@new.example', true, undefined]]);
  const one = applyPatch('User', mkUser(), patch(
    { op: 'replace', path: 'emails[type eq "work"].value', value: 'new@work.example' },
    { op: 'replace', path: 'emails[type eq "home"].primary', value: true },
  ));
  assert.deepEqual((one.emails as { value: string; primary: boolean }[]).map((e) => [e.value, e.primary]), [['new@work.example', false], ['a@home.example', true]]);
  const swapped = applyPatch('User', mkUser(), patch({ op: 'replace', path: 'emails[type eq "home"]', value: { value: 'z@home.example', type: 'home' } }));
  assert.deepEqual((swapped.emails as { value: string }[]).map((e) => e.value), ['a@work.example', 'z@home.example']);
  const all = applyPatch('User', mkUser(), patch({ op: 'replace', path: 'emails', value: [{ value: 'only@example.org' }] }));
  assert.deepEqual(all.emails, [{ value: 'only@example.org' }]);
});

test('PatchOp remove: attributes, sub-attributes, filtered elements, and the last element removing the attribute', () => {
  const r = applyPatch('User', mkUser({ title: 'T', name: { givenName: 'A', familyName: 'B' } }), patch(
    { op: 'remove', path: 'title' },
    { op: 'remove', path: 'name.familyName' },
    { op: 'remove', path: 'emails[type eq "home"]' },
  ));
  assert.deepEqual([r.title, r.name, (r.emails as unknown[]).length], [undefined, { givenName: 'A' }, 1]);
  const none = applyPatch('User', r, patch({ op: 'remove', path: 'emails[type eq "work"]' }));
  assert.equal('emails' in none, false);
  assert.doesNotThrow(() => applyPatch('User', mkUser(), patch({ op: 'remove', path: 'nickName' })), 'removing what is not there succeeds');
  const sub = applyPatch('User', mkUser(), patch({ op: 'remove', path: 'emails[type eq "work"].primary' }));
  assert.equal((sub.emails as { primary?: boolean }[])[0]!.primary, undefined);
});

test('PatchOp errors: read-only, required, unknown paths, no target, bad values; and nothing applies when one operation fails', () => {
  const orig = mkUser();
  const fails = (ops: object[], status: number, type: string) => assert.throws(() => applyPatch('User', orig, patch(...ops)), (e: Error) => e instanceof ScimError && e.status === status && e.scimType === type, JSON.stringify(ops).slice(0, 70));
  fails([{ op: 'replace', path: 'id', value: 'x' }], 400, 'mutability');
  fails([{ op: 'replace', path: 'meta.version', value: 'x' }], 400, 'mutability');
  fails([{ op: 'add', path: 'groups', value: [{ value: 'g' }] }], 400, 'mutability');
  fails([{ op: 'remove', path: 'userName' }], 400, 'mutability');
  fails([{ op: 'remove' }], 400, 'noTarget');
  fails([{ op: 'replace', path: 'nonsense', value: 1 }], 400, 'invalidPath');
  fails([{ op: 'replace', path: 'name.nonsense', value: 1 }], 400, 'invalidPath');
  fails([{ op: 'replace', path: 'emails[type eq "work"', value: 1 }], 400, 'invalidPath');
  fails([{ op: 'replace', path: 'emails[type eq "work"]x', value: 1 }], 400, 'invalidPath');
  fails([{ op: 'replace', path: 'emails[type eq "fax"].value', value: 'x' }], 400, 'noTarget');
  fails([{ op: 'replace', path: 'active', value: 'perhaps' }], 400, 'invalidValue');
  fails([{ op: 'add', path: 'title' }], 400, 'invalidValue');
  fails([{ op: 'add', value: 'not an object' }], 400, 'invalidValue');
  fails([{ op: 'move', path: 'title', value: 1 }], 400, 'invalidSyntax');
  fails([{ op: 'replace', path: 'title', value: 'ok' }, { op: 'replace', path: 'active', value: 'bad' }], 400, 'invalidValue');
  fails([{ op: 'add', path: 'urn:other:schema:x', value: 1 }], 400, 'invalidPath');
  assert.throws(() => applyPatch('User', orig, { schemas: ['wrong'], Operations: [] }), /schema/);
  assert.throws(() => applyPatch('User', orig, { schemas: [SCHEMA_PATCH], Operations: [] }), /non-empty/);
  assert.equal(orig.title, undefined, 'the original is never changed');
});

test('PATCH over HTTP is atomic: a failing operation leaves the stored user as it was', () => {
  const { call } = setup();
  call('POST', '/Users', USER('ana', { title: 'Before' }));
  const bad = call('PATCH', '/Users/id1', patch({ op: 'replace', path: 'title', value: 'After' }, { op: 'replace', path: 'id', value: 'z' }));
  assert.equal(bad.status, 400);
  assert.equal(body(call('GET', '/Users/id1')).title, 'Before');
  const rename = call('PATCH', '/Users/id1', patch({ op: 'replace', path: 'userName', value: 'ANA2' }));
  assert.equal(body(rename).userName, 'ANA2');
  call('POST', '/Users', USER('bo'));
  assert.equal(call('PATCH', '/Users/id2', patch({ op: 'replace', path: 'userName', value: 'ana2' })).status, 409);
});

test('groups: members must exist, user.groups is derived, patching members, and deleting a user removes them from groups', () => {
  const { call } = setup();
  call('POST', '/Users', USER('ana'));
  call('POST', '/Users', USER('bo'));
  const g = call('POST', '/Groups', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'Admins', members: [{ value: 'id1' }] });
  assert.equal(g.status, 201);
  assert.equal(call('POST', '/Groups', { displayName: 'Bad', members: [{ value: 'ghost' }] }).status, 400);
  assert.equal(call('POST', '/Groups', { displayName: 'Dup', members: [{ value: 'id1' }, { value: 'id1' }] }).status, 400);
  assert.equal(call('POST', '/Groups', { displayName: 'admins' }).status, 409);
  assert.deepEqual(body(call('GET', '/Users/id1')).groups, [{ value: 'id3', $ref: 'https://app.example.org/scim/v2/Groups/id3', display: 'Admins', type: 'direct' }]);
  const add = call('PATCH', '/Groups/id3', patch({ op: 'add', path: 'members', value: [{ value: 'id2' }, { value: 'id1' }] }));
  assert.deepEqual((body(add).members as { value: string }[]).map((m) => m.value), ['id1', 'id2']);
  assert.equal(call('PATCH', '/Groups/id3', patch({ op: 'add', path: 'members', value: [{ value: 'ghost' }] })).status, 400);
  const rm = call('PATCH', '/Groups/id3', patch({ op: 'remove', path: 'members[value eq "id1"]' }));
  assert.deepEqual((body(rm).members as { value: string }[]).map((m) => m.value), ['id2']);
  assert.equal(call('PATCH', '/Users/id2', patch({ op: 'add', path: 'groups', value: [{ value: 'x' }] })).status, 400, 'groups on a user are read-only');
  call('DELETE', '/Users/id2');
  assert.equal('members' in body(call('GET', '/Groups/id3')), false);
  assert.equal(body(call('GET', '/Users', undefined, { query: { filter: 'groups.display eq "Admins"' } })).totalResults, 0);
});

test('bulk: ordered operations, bulkId references in data and paths, failOnErrors, and limits', () => {
  const { call } = setup();
  const r = call('POST', '/Bulk', {
    schemas: [SCHEMA_BULK_REQUEST],
    Operations: [
      { method: 'POST', path: '/Users', bulkId: 'u', data: USER('ana') },
      { method: 'POST', path: '/Groups', bulkId: 'g', data: { displayName: 'Team', members: [{ value: 'bulkId:u' }] } },
      { method: 'PATCH', path: '/Users/bulkId:u', data: patch({ op: 'replace', path: 'title', value: 'T' }) },
      { method: 'POST', path: '/Users', bulkId: 'dup', data: USER('ANA') },
      { method: 'DELETE', path: '/Groups/bulkId:g' },
      { method: 'POST', path: '/Users', bulkId: 'late', data: USER('cy') },
    ],
  });
  const ops = (body(r).Operations as { method: string; status: string; bulkId?: string; location?: string; response?: { scimType: string } }[]);
  assert.deepEqual(ops.map((o) => o.status), ['201', '201', '200', '409', '204', '201']);
  assert.equal(ops[0]!.location, 'https://app.example.org/scim/v2/Users/id1');
  assert.equal(ops[3]!.response!.scimType, 'uniqueness');
  assert.equal(body(call('GET', '/Users/id1')).title, 'T');
  const stop = call('POST', '/Bulk', { schemas: [SCHEMA_BULK_REQUEST], failOnErrors: 1, Operations: [{ method: 'DELETE', path: '/Users/ghost' }, { method: 'POST', path: '/Users', bulkId: 'x', data: USER('after') }] });
  assert.deepEqual((body(stop).Operations as { status: string }[]).map((o) => o.status), ['404'], 'stops after the first error');
  const unknownRef = call('POST', '/Bulk', { schemas: [SCHEMA_BULK_REQUEST], Operations: [{ method: 'PATCH', path: '/Users/bulkId:nope', data: patch({ op: 'remove', path: 'title' }) }] });
  assert.equal((body(unknownRef).Operations as { status: string }[])[0]!.status, '400');
  const noId = call('POST', '/Bulk', { schemas: [SCHEMA_BULK_REQUEST], Operations: [{ method: 'POST', path: '/Users', data: USER('q') }] });
  assert.equal((body(noId).Operations as { status: string }[])[0]!.status, '400');
  const small = new ScimServer({ baseUrl: 'https://x.example/scim', newId: () => 'i', maxBulkOperations: 2 });
  assert.equal(small.handle({ method: 'POST', path: '/Bulk', body: { schemas: [SCHEMA_BULK_REQUEST], Operations: [{}, {}, {}] } }).status, 413);
  assert.equal(call('POST', '/Bulk', { schemas: ['wrong'] }).status, 400);
});

test('discovery documents say what is supported', () => {
  const { call } = setup();
  const spc = body(call('GET', '/ServiceProviderConfig'));
  assert.deepEqual([(spc.patch as { supported: boolean }).supported, (spc.bulk as { maxOperations: number }).maxOperations, (spc.filter as { maxResults: number }).maxResults, (spc.etag as { supported: boolean }).supported, (spc.changePassword as { supported: boolean }).supported], [true, 100, 200, true, false]);
  const rt = body(call('GET', '/ResourceTypes')) as { Resources: { id: string; endpoint: string }[] };
  assert.deepEqual(rt.Resources.map((r) => [r.id, r.endpoint]), [['User', '/Users'], ['Group', '/Groups']]);
  assert.equal((body(call('GET', '/Schemas')) as { totalResults: number }).totalResults, 3);
});

test('hostile input: prototype keys, huge lists, deep filters and odd paths never corrupt or crash the server', () => {
  const { call } = setup();
  const proto = call('POST', '/Users', JSON.parse('{"userName":"p","__proto__":{"admin":true}}'));
  assert.equal(proto.status, 400);
  assert.equal(({} as Record<string, unknown>).admin, undefined);
  assert.equal(call('POST', '/Users', USER('big', { emails: Array.from({ length: 1001 }, (_, i) => ({ value: `e${i}` })) })).status, 400);
  assert.equal(call('GET', '/Users', undefined, { query: { filter: 'a pr and '.repeat(300) + 'b pr' } }).status, 400);
  assert.equal(call('GET', '/Users/%E0%A4%A').status, 400);
  assert.equal(call('PATCH', '/Users/id1', 'text').status, 404);
  call('POST', '/Users', USER('ok'));
  assert.equal(call('PATCH', '/Users/id1', patch({ op: 'add', path: '__proto__.x', value: 1 })).status, 400);
  assert.equal(call('PATCH', '/Users/id1', patch({ op: 'add', value: JSON.parse('{"__proto__": {"admin": true}}') })).status >= 400, true);
  assert.equal(call('PATCH', '/Users/id1', patch({ op: 'add', path: 'name.givenName', value: 'x'.repeat(20_000) })).status, 400);
  assert.equal(body(call('GET', '/Users/id1')).userName, 'ok');
});
