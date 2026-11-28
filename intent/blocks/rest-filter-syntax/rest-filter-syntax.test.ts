import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadFilter, OPERATORS, canonical, detectStyle, matches, parseDirectus, parsePostgrest, parseQuery, parseRangeHeader, parseStrapi, toPagingQuery } from './index.ts';
import type { Node } from './index.ts';

const cmp = (path: string, op: string, value: unknown): Node => ({ kind: 'cmp', path: path.split('.'), op, value }) as Node;
const problems = (fn: () => unknown) => { try { fn(); } catch (e) { if (e instanceof BadFilter) return e.problems; throw e; } assert.fail('expected the query to be refused'); };
const codes = (fn: () => unknown) => problems(fn).map((p) => p.code);

test('PostgREST: plain comparisons and is.true combine with and', () => {
  const p = parsePostgrest('age=gte.18&student=is.true&name=eq.Ana');
  assert.deepEqual(p.filter, { kind: 'and', children: [cmp('age', 'gte', '18'), cmp('student', 'eq', true), cmp('name', 'eq', 'Ana')] });
  assert.deepEqual([p.limit, p.offset, p.sort], [25, 0, []]);
  assert.deepEqual(parsePostgrest('age=gte.18&age=lt.65').filter, { kind: 'and', children: [cmp('age', 'gte', '18'), cmp('age', 'lt', '65')] }, 'the same column twice is an and');
  assert.equal(parsePostgrest('').filter, undefined);
});

test('PostgREST: or and nested and/or groups, as in the PostgREST documentation', () => {
  assert.deepEqual(parsePostgrest('or=(age.lt.18,age.gt.21)').filter, { kind: 'or', children: [cmp('age', 'lt', '18'), cmp('age', 'gt', '21')] });
  const n = parsePostgrest('and=(grade.gte.90,student.is.true,or(age.gte.14,age.is.null))').filter;
  assert.deepEqual(n, { kind: 'and', children: [cmp('grade', 'gte', '90'), cmp('student', 'eq', true), { kind: 'or', children: [cmp('age', 'gte', '14'), cmp('age', 'null', true)] }] });
  assert.deepEqual(parsePostgrest('not.or=(a.eq.1,b.eq.2)').filter, { kind: 'not', child: { kind: 'or', children: [cmp('a', 'eq', '1'), cmp('b', 'eq', '2')] } });
  assert.deepEqual(parsePostgrest('or=(a.eq.1,not.and(b.eq.2,c.eq.3))').filter, { kind: 'or', children: [cmp('a', 'eq', '1'), { kind: 'not', child: { kind: 'and', children: [cmp('b', 'eq', '2'), cmp('c', 'eq', '3')] } }] });
});

test('PostgREST: negations fold into their positive twins, and the value keeps its dots', () => {
  assert.deepEqual(parsePostgrest('a=not.eq.x&b=not.in.(1,2)&c=not.is.null&d=not.gt.5&e=not.like.*foo*&f=not.is.true').filter, { kind: 'and', children: [cmp('a', 'ne', 'x'), cmp('b', 'nin', ['1', '2']), cmp('c', 'null', false), cmp('d', 'lte', '5'), { kind: 'not', child: cmp('e', 'contains', 'foo') }, cmp('f', 'ne', true)] });
  assert.deepEqual(parsePostgrest('version=eq.1.2.3&at=gte.2026-01-01T10:00:00.000Z').filter, { kind: 'and', children: [cmp('version', 'eq', '1.2.3'), cmp('at', 'gte', '2026-01-01T10:00:00.000Z')] });
});

test('PostgREST: in lists with quoted commas, and like patterns map to contains, starts and ends', () => {
  assert.deepEqual(parsePostgrest('name=in.("Hal,Tom",Bob,"say \\"hi\\"")').filter, cmp('name', 'in', ['Hal,Tom', 'Bob', 'say "hi"']));
  assert.deepEqual(parsePostgrest('id=in.()').filter, cmp('id', 'in', []));
  assert.deepEqual(parsePostgrest('a=like.*Smith*&b=like.Sm*&c=like.*son&d=ilike.*x*&e=ilike.Ab*&f=like.exact').filter, { kind: 'and', children: [cmp('a', 'contains', 'Smith'), cmp('b', 'starts', 'Sm'), cmp('c', 'ends', 'son'), cmp('d', 'icontains', 'x'), cmp('e', 'istarts', 'Ab'), cmp('f', 'eq', 'exact')] });
  assert.deepEqual(codes(() => parsePostgrest('a=like.S*m*th')), ['pattern']);
  assert.deepEqual(codes(() => parsePostgrest('a=in.1,2')), ['syntax']);
});

test('PostgREST: select with embedded resources, aliases and inner joins, order, limit, offset', () => {
  const p = parsePostgrest('select=id,name,posts!inner(id,title,comments(*)),boss:users(name)&order=age.desc.nullslast,name&limit=10&offset=30');
  assert.deepEqual(p.populate, { fields: ['id', 'name'], relations: { posts: { fields: ['id', 'title'], inner: true, relations: { comments: { fields: '*', relations: {} } } }, users: { fields: ['name'], alias: 'boss', relations: {} } } });
  assert.deepEqual(p.sort, [{ path: ['age'], dir: 'desc', nulls: 'last' }, { path: ['name'], dir: 'asc' }]);
  assert.deepEqual([p.limit, p.offset], [10, 30]);
  assert.deepEqual(parsePostgrest('select=first_name,age').populate, { fields: ['first_name', 'age'], relations: {} });
  assert.deepEqual(parsePostgrest('posts.title=eq.x').filter, cmp('posts.title', 'eq', 'x'), 'a dotted column filters through the relation');
});

test('PostgREST: range header gives offset and limit', () => {
  assert.deepEqual(parseRangeHeader('items=0-24'), { offset: 0, limit: 25 });
  assert.deepEqual(parseRangeHeader('30-39'), { offset: 30, limit: 10 });
  assert.deepEqual(parseRangeHeader('5-'), { offset: 5, limit: 100 });
  assert.deepEqual(codes(() => parseRangeHeader('10-5')), ['range']);
  assert.deepEqual(codes(() => parseRangeHeader('0-5000')), ['limit']);
  assert.deepEqual(codes(() => parseRangeHeader('all')), ['range']);
});

test('Strapi: the documented operators, arrays, relations and $or', () => {
  const p = parseStrapi('filters[username][$eq]=John&filters[id][$in][0]=3&filters[id][$in][1]=6&filters[id][$in][2]=8&filters[author][name][$containsi]=kai&filters[age][$between][0]=18&filters[age][$between][1]=65&filters[deleted][$null]=true&filters[bio][$notNull]=true');
  assert.deepEqual(p.filter, { kind: 'and', children: [cmp('username', 'eq', 'John'), cmp('id', 'in', ['3', '6', '8']), cmp('author.name', 'icontains', 'kai'), cmp('age', 'between', ['18', '65']), cmp('deleted', 'null', true), cmp('bio', 'null', false)] });
  const o = parseStrapi('filters[$or][0][date][$eq]=2020-01-01&filters[$or][1][date][$eq]=2020-01-02&filters[author][name][$eq]=Kai doe');
  assert.deepEqual(o.filter, { kind: 'and', children: [{ kind: 'or', children: [cmp('date', 'eq', '2020-01-01'), cmp('date', 'eq', '2020-01-02')] }, cmp('author.name', 'eq', 'Kai doe')] });
  assert.deepEqual(parseStrapi('filters[name]=Ana').filter, cmp('name', 'eq', 'Ana'), 'a bare value is eq');
  assert.deepEqual(parseStrapi('filters[title][$notContains]=x&filters[$not][a][$eq]=1').filter, { kind: 'and', children: [{ kind: 'not', child: cmp('title', 'contains', 'x') }, { kind: 'not', child: cmp('a', 'eq', '1') }] });
  assert.deepEqual(parseStrapi('filters[$and][0][a][$gt]=1&filters[$and][1][b][$lt]=2').filter, { kind: 'and', children: [cmp('a', 'gt', '1'), cmp('b', 'lt', '2')] });
});

test('Strapi: sort, pagination and populate in every form', () => {
  const p = parseStrapi('sort=title:asc,age:desc&pagination[page]=3&pagination[pageSize]=20&fields[0]=title&fields[1]=body&populate[author][fields][0]=firstname&populate[posts][populate][comments]=*&populate[tags]=*');
  assert.deepEqual(p.sort, [{ path: ['title'], dir: 'asc' }, { path: ['age'], dir: 'desc' }]);
  assert.deepEqual([p.limit, p.offset], [20, 40]);
  assert.deepEqual(p.populate, { fields: ['title', 'body'], relations: { author: { fields: ['firstname'], relations: {} }, posts: { fields: '*', relations: { comments: { fields: '*', relations: {} } } }, tags: { fields: '*', relations: {} } } });
  assert.deepEqual(parseStrapi('sort[0]=a:desc&sort[1]=b&pagination[start]=15&pagination[limit]=5').sort.map((s) => s.dir), ['desc', 'asc']);
  const q = parseStrapi('pagination[start]=15&pagination[limit]=5');
  assert.deepEqual([q.limit, q.offset], [5, 15]);
  assert.deepEqual(Object.keys(parseStrapi('populate=author,posts.comments').populate.relations).sort(), ['author', 'posts']);
  assert.deepEqual(codes(() => parseStrapi('populate[posts][filters][a][$eq]=1')), ['unsupported']);
});

test('Directus: bracket filters, JSON filters, csv lists and the negated operators', () => {
  const p = parseDirectus('filter[title][_contains]=Directus&filter[status][_in]=published,draft&filter[age][_between]=18,65&filter[author][name][_eq]=Kai&filter[x][_nnull]=true&filter[y][_ncontains]=bad');
  assert.deepEqual(p.filter, { kind: 'and', children: [cmp('title', 'contains', 'Directus'), cmp('status', 'in', ['published', 'draft']), cmp('age', 'between', ['18', '65']), cmp('author.name', 'eq', 'Kai'), cmp('x', 'null', false), { kind: 'not', child: cmp('y', 'contains', 'bad') }] });
  assert.deepEqual(parseDirectus('filter[_or][0][a][_eq]=1&filter[_or][1][b][_lt]=2').filter, { kind: 'or', children: [cmp('a', 'eq', '1'), cmp('b', 'lt', '2')] });
  const j = parseDirectus(`filter=${encodeURIComponent(JSON.stringify({ _and: [{ age: { _gte: 18 } }, { _or: [{ city: { _eq: 'Oslo' } }, { city: { _null: true } }] }], 'author': { name: { _starts_with: 'K' } } }))}`);
  assert.deepEqual(j.filter, { kind: 'and', children: [{ kind: 'and', children: [cmp('age', 'gte', '18'), { kind: 'or', children: [cmp('city', 'eq', 'Oslo'), cmp('city', 'null', true)] }] }, cmp('author.name', 'starts', 'K')] });
  assert.deepEqual(codes(() => parseDirectus('filter={nope')), ['json']);
});

test('Directus: sort, limit, page, fields with dotted relations', () => {
  const p = parseDirectus('sort=-date_created,title&limit=20&page=3&fields=id,title,author.name,author.email,comments.*');
  assert.deepEqual(p.sort, [{ path: ['date_created'], dir: 'desc' }, { path: ['title'], dir: 'asc' }]);
  assert.deepEqual([p.limit, p.offset], [20, 40]);
  assert.deepEqual(p.populate, { fields: ['id', 'title'], relations: { author: { fields: ['name', 'email'], relations: {} }, comments: { fields: '*', relations: {} } } });
  assert.equal(parseDirectus('offset=7&limit=3').offset, 7);
});

test('the same question asked in three dialects gives the same tree, and the same rows', () => {
  const pg = parsePostgrest('age=gte.18&or=(city.eq.Oslo,city.eq.Rome)&name=not.like.*bot*&role=in.(admin,staff)');
  const st = parseStrapi('filters[age][$gte]=18&filters[$or][0][city][$eq]=Oslo&filters[$or][1][city][$eq]=Rome&filters[$not][name][$contains]=bot&filters[role][$in][0]=admin&filters[role][$in][1]=staff');
  const di = parseDirectus('filter[age][_gte]=18&filter[_or][0][city][_eq]=Oslo&filter[_or][1][city][_eq]=Rome&filter[name][_ncontains]=bot&filter[role][_in]=admin,staff');
  assert.equal(canonical(pg.filter), canonical(st.filter));
  assert.equal(canonical(st.filter), canonical(di.filter));
  const rows = [{ age: 30, city: 'Oslo', name: 'Ana', role: 'admin' }, { age: 17, city: 'Oslo', name: 'Kid', role: 'staff' }, { age: 40, city: 'Paris', name: 'Pia', role: 'staff' }, { age: 50, city: 'Rome', name: 'robot', role: 'staff' }, { age: 22, city: 'Rome', name: 'Raj', role: 'staff' }];
  for (const p of [pg, st, di]) assert.deepEqual(rows.filter((r) => matches(p.filter, r)).map((r) => r.name), ['Ana', 'Raj']);
  assert.equal(parseQuery('filters[a][$eq]=1').style, 'strapi');
  assert.equal(parseQuery('filter[a][_eq]=1').style, 'directus');
  assert.equal(parseQuery('a=eq.1').style, 'postgrest');
  assert.equal(detectStyle('pagination[page]=2'), 'strapi');
  assert.equal(detectStyle('fields=a,b'), 'directus');
  assert.equal(parseQuery('a=eq.1', {}, 'directus').style, 'directus');
});

test('the operator table names every operator in every dialect', () => {
  assert.equal(OPERATORS.gte.postgrest, 'gte');
  assert.equal(OPERATORS.gte.strapi, '$gte');
  assert.equal(OPERATORS.gte.directus, '_gte');
  assert.equal(OPERATORS.icontains.strapi, '$containsi');
  assert.equal(OPERATORS.starts.directus, '_starts_with');
  assert.equal(Object.keys(OPERATORS).length, 16);
  for (const [op, names] of Object.entries(OPERATORS)) assert.ok(names.postgrest && names.strapi && names.directus, op);
});

test('depth, size and list caps refuse queries that would be expensive', () => {
  assert.deepEqual(codes(() => parsePostgrest('or=(a.eq.1,or(b.eq.1,or(c.eq.1,or(d.eq.1,or(e.eq.1,or(f.eq.1))))))')), ['depth']);
  const many = Array.from({ length: 60 }, (_, i) => `f${i}=eq.1`).join('&');
  assert.deepEqual(codes(() => parsePostgrest(many)), ['too-many'], 'one problem, not sixty');
  assert.deepEqual(codes(() => parsePostgrest(`a=in.(${Array.from({ length: 300 }, (_, i) => i).join(',')})`)), ['too-long']);
  assert.deepEqual(codes(() => parsePostgrest('limit=1000')), ['limit']);
  assert.deepEqual(codes(() => parseStrapi('pagination[pageSize]=101')), ['limit']);
  assert.deepEqual(codes(() => parseDirectus('limit=-1')), ['limit']);
  assert.equal(parsePostgrest('limit=100').limit, 100);
  assert.deepEqual(codes(() => parseStrapi('filters[a][b][c][d][e][f][$eq]=1')), ['path']);
  assert.deepEqual(codes(() => parseStrapi('filters[$or][0][$or][0][$or][0][$or][0][$or][0][$or][0][a][$eq]=1')), ['depth']);
  assert.deepEqual(codes(() => parsePostgrest(Array.from({ length: 250 }, (_, i) => `a${i}=eq.1`).join('&'))), ['too-many']);
  assert.deepEqual(codes(() => parsePostgrest(`a=eq.${'x'.repeat(600)}`)), ['too-long']);
  assert.equal(parsePostgrest(`a=eq.${'x'.repeat(600)}`, { limits: { maxValueLength: 1000 } }).filter?.kind, 'cmp');
});

test('populate depth and size are capped in every dialect', () => {
  assert.deepEqual(codes(() => parsePostgrest('select=a(b(c(d(e))))')), ['populate-depth']);
  assert.equal(parsePostgrest('select=a(b(c(id)))').populate.relations.a!.relations.b!.relations.c!.fields[0], 'id');
  assert.deepEqual(codes(() => parseStrapi('populate=a.b.c.d')), ['populate-depth']);
  assert.deepEqual(codes(() => parseDirectus('fields=a.b.c.d.name')), ['populate-depth']);
  const wide = Array.from({ length: 40 }, (_, i) => `r${i}`).join(',');
  assert.deepEqual(codes(() => parseStrapi(`populate=${wide}`)), ['populate-size']);
  assert.equal(Object.keys(parseStrapi(`populate=${wide}`, { limits: { maxPopulateNodes: 50 } }).populate.relations).length, 40);
});

test('hostile keys, names and operators are refused, and every problem is reported together', () => {
  assert.deepEqual(codes(() => parseStrapi('filters[__proto__][$eq]=1')), ['field']);
  assert.deepEqual(codes(() => parseStrapi('filters[a][constructor][$eq]=1')), ['field']);
  assert.deepEqual(codes(() => parseDirectus('filter[prototype][_eq]=1')), ['field']);
  assert.equal(parseDirectus(`filter=${encodeURIComponent('{"__proto__":{"_eq":1}}')}`).filter, undefined, 'a __proto__ key in JSON is dropped');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.deepEqual(codes(() => parsePostgrest('a;drop=eq.1')), ['field']);
  assert.deepEqual(codes(() => parsePostgrest('data->>name=eq.x')), ['unsupported']);
  assert.deepEqual(codes(() => parsePostgrest('a=regex.x')), ['operator']);
  assert.deepEqual(codes(() => parseStrapi('filters[a][$sql]=1')), ['operator']);
  assert.deepEqual(codes(() => parseDirectus('filter[a][_xyz]=1')), ['operator']);
  assert.deepEqual(codes(() => parsePostgrest('order=a.sideways')), ['syntax']);
  assert.deepEqual(codes(() => parsePostgrest('limit=ten&offset=-1')), ['number', 'number']);
  const ps = problems(() => parsePostgrest('a=regex.x&limit=ten&b;c=eq.1'));
  assert.deepEqual(ps.map((p) => p.path), ['a', 'limit', 'b;c']);
  assert.deepEqual(codes(() => parseDirectus('deep[posts][_filter][a][_eq]=1')), ['unsupported']);
  assert.deepEqual(codes(() => parseDirectus('filter[owner][_eq]=$CURRENT_USER')), ['unsupported']);
  assert.deepEqual(codes(() => parseStrapi('filters[a]=1&filters[a][$eq]=2')), ['syntax']);
});

test('an allow-list limits which fields and operators may be used, and declared types turn strings into values', () => {
  const o = { fields: ['age', 'city', 'author.name'], ops: ['eq', 'gte', 'in'] as const };
  assert.equal(parsePostgrest('age=gte.18&author.name=eq.Kai', { ...o, ops: [...o.ops] }).filter?.kind, 'and');
  assert.deepEqual(codes(() => parsePostgrest('salary=gte.1', { ...o, ops: [...o.ops] })), ['unknown-field']);
  assert.deepEqual(codes(() => parsePostgrest('age=like.*1*', { ...o, ops: [...o.ops] })), ['operator']);
  assert.deepEqual(codes(() => parsePostgrest('order=salary', { fields: ['age'] })), ['unknown-field']);
  assert.deepEqual(codes(() => parseStrapi('filters[author][email][$eq]=a', { fields: ['author.name'] })), ['unknown-field']);
  const fn = parseDirectus('filter[a][_eq]=1', { fields: (p) => p[0] === 'a' });
  assert.equal(fn.filter?.kind, 'cmp');
  const typed = parsePostgrest('age=gte.18&active=is.true&n=in.(1,2)&at=gt.2026-01-01', { types: { age: 'number', n: 'number', at: 'date' } });
  assert.deepEqual(typed.filter, { kind: 'and', children: [cmp('age', 'gte', 18), cmp('active', 'eq', true), cmp('n', 'in', [1, 2]), cmp('at', 'gt', '2026-01-01')] });
  assert.deepEqual(codes(() => parsePostgrest('age=gte.old', { types: { age: 'number' } })), ['type']);
  assert.deepEqual(codes(() => parseStrapi('filters[ok][$eq]=maybe', { types: { ok: 'boolean' } })), ['type']);
  assert.deepEqual(codes(() => parsePostgrest('at=gt.never', { types: { at: 'date' } })), ['type']);
});

test('matches follows the operator meanings, including missing values and nested paths', () => {
  const row = { a: 5, s: 'Hello World', n: null, who: { name: 'Kai' } };
  const t = (n: Node) => matches(n, row);
  assert.deepEqual([t(cmp('a', 'eq', 5)), t(cmp('a', 'eq', '5')), t(cmp('a', 'ne', 5)), t(cmp('a', 'lt', 6)), t(cmp('a', 'gte', 5)), t(cmp('a', 'between', [1, 5])), t(cmp('a', 'between', [6, 9]))], [true, true, false, true, true, true, false]);
  assert.deepEqual([t(cmp('s', 'contains', 'World')), t(cmp('s', 'contains', 'world')), t(cmp('s', 'icontains', 'world')), t(cmp('s', 'starts', 'Hel')), t(cmp('s', 'iends', 'WORLD'))], [true, false, true, true, true]);
  assert.deepEqual([t(cmp('n', 'null', true)), t(cmp('missing', 'null', true)), t(cmp('a', 'null', true)), t(cmp('a', 'null', false)), t(cmp('n', 'eq', 'x')), t(cmp('missing', 'ne', 'x')), t(cmp('missing', 'nin', ['x']))], [true, true, false, true, false, true, true]);
  assert.equal(t(cmp('who.name', 'eq', 'Kai')), true);
  assert.equal(t(cmp('who.age', 'gt', 1)), false);
  assert.equal(matches(undefined, row), true);
  assert.equal(matches(cmp('toString', 'eq', 'x'), {}), false, 'inherited properties are not values');
});

test('a flat query converts to the paging block\'s form, and a complex one says why not', () => {
  const p = parsePostgrest('status=eq.open&age=gte.18&order=created.desc&limit=10');
  assert.deepEqual(toPagingQuery(p), { sort: { field: 'created', dir: 'desc' }, filters: [{ field: 'status', op: 'eq', value: 'open' }, { field: 'age', op: 'gte', value: '18' }], limit: 10 });
  assert.deepEqual(toPagingQuery(parsePostgrest('a=eq.1')), { filters: [{ field: 'a', op: 'eq', value: '1' }], limit: 25 });
  assert.throws(() => toPagingQuery(parsePostgrest('or=(a.eq.1,b.eq.2)')), /flat list/);
  assert.throws(() => toPagingQuery(parsePostgrest('a=starts.x')), BadFilter);
  assert.throws(() => toPagingQuery(parsePostgrest('author.name=eq.x')), /flat list/);
  assert.throws(() => toPagingQuery(parsePostgrest('order=a,b')), /one sort/);
});
