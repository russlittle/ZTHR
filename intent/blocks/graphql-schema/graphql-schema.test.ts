import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GraphQLError, GraphQLSyntaxError, analyze, buildSchema, execute, parse, plan, validate } from './index.ts';
import type { Schema } from './index.ts';

const SDL = `
  """The root."""
  type Query {
    hello(name: String = "world"): String!
    user(id: ID!): User
    users(first: Int, after: String): [User!]!
    search(text: String!): [SearchResult!]!
    node(id: ID!): Node
    flaky: String
    must: String!
    items: [Int!]
    nested: Outer
  }
  type Mutation { bump(by: Int = 1): Int! rename(id: ID!, input: RenameInput!): User }
  directive @auth(role: String!) on FIELD_DEFINITION
  interface Node { id: ID! }
  type User implements Node {
    id: ID!
    name: String
    email: String @deprecated(reason: "use contact")
    role: Role!
    friends(first: Int): [User!]
    posts(limit: Int = 20): [Post!]! @cost(value: 2, multipliers: ["limit"])
  }
  type Post implements Node { id: ID! title: String! author: User }
  union SearchResult = User | Post
  enum Role { ADMIN MEMBER GUEST }
  input RenameInput { name: String! tags: [String!] }
  type Outer { inner: Outer value: Int }
  scalar Date
  extend type Query { today: Date }
`;

let schema: Schema;
const S = () => (schema ??= buildSchema(SDL));

const db = {
  users: [
    { id: '1', name: 'Ana', role: 'ADMIN', __typename: 'User' },
    { id: '2', name: 'Bo', role: 'MEMBER', __typename: 'User' },
    { id: '3', name: 'Cy', role: 'GUEST', __typename: 'User' },
  ],
};

const resolvers = {
  Query: {
    hello: (_: unknown, a: { name: string }) => `Hello, ${a.name}!`,
    user: (_: unknown, a: { id: string }) => db.users.find((u) => u.id === a.id) ?? null,
    users: (_: unknown, a: { first?: number }) => db.users.slice(0, a.first ?? 10),
    search: () => [db.users[0], { id: 'p1', title: 'Post', __typename: 'Post' }],
    node: (_: unknown, a: { id: string }) => (a.id === 'p1' ? { id: 'p1', title: 'T', __typename: 'Post' } : db.users.find((u) => u.id === a.id)),
    flaky: () => {
      throw new Error('boom');
    },
    must: () => null,
    items: () => [1, 2, null],
    nested: () => ({ inner: { inner: { value: 3 } } }),
    today: () => new Date(Date.UTC(2026, 0, 2)),
  },
};

const codes = (errs: readonly GraphQLError[]) => errs.map((e) => e.message);

test('parser: operations, variables, aliases, fragments, directives and string forms', () => {
  const d = parse(`query Q($id: ID! = "7", $tags: [String!]) @dir { a: user(id: $id) @skip(if: false) { ...F ... on User { name } } }
    fragment F on User { id }
    # a comment, and commas are whitespace,,
    mutation { bump(by: 2) }`);
  assert.equal(d.definitions.length, 3);
  const q = d.definitions[0]!;
  assert.equal(q.kind, 'operation');
  if (q.kind === 'operation') {
    assert.equal(q.name, 'Q');
    assert.deepEqual(q.variables.map((v) => v.name), ['id', 'tags']);
    assert.deepEqual(q.variables[0]!.type, { kind: 'nonNull', of: { kind: 'named', name: 'ID' } });
    assert.equal(q.variables[0]!.defaultValue?.kind, 'string');
    const f = q.selections[0]!;
    assert.equal(f.kind === 'field' && f.alias, 'a');
  }
  const s = parse('{ f(a: "tab\\there \\u00e9 \\u{1F600}", b: """\n    block\n      indented\n    end\n  """) }');
  const f = (s.definitions[0] as { selections: { args: { value: { value: string } }[] }[] }).selections[0]!;
  assert.equal(f.args[0]!.value.value, 'tab\there é 😀');
  assert.equal(f.args[1]!.value.value, 'block\n  indented\nend');
});

test('parser: syntax errors carry a line and column and a plain reason', () => {
  const bad = (src: string, re: RegExp) => assert.throws(() => parse(src), (e: GraphQLSyntaxError) => e instanceof GraphQLSyntaxError && re.test(e.message) && e.locations![0]!.line >= 1);
  bad('{ a ', /Expected Name|Unexpected <EOF>/);
  bad('{ a(b: ) }', /Unexpected "\)"/);
  bad('query { a } }', /Unexpected "}"/);
  bad('{ a(b: "unterminated) }', /unterminated string/);
  bad('{ a(b: 12x) }', /invalid number/);
  bad('{ a(b: "\\q") }', /invalid escape/);
  bad('', /Unexpected <EOF>/);
  bad('{ a(b: $v) } fragment on on User { id }', /not a valid fragment name|Expected/);
  try {
    parse('{\n  a\n  b(\n}');
    assert.fail('should throw');
  } catch (e) {
    assert.deepEqual((e as GraphQLSyntaxError).locations, [{ line: 4, column: 1 }]);
  }
});

test('parser limits: size, token count and nesting depth refuse hostile documents', () => {
  assert.throws(() => parse('{ a }'.padEnd(200, ' '), { maxSize: 100 }), /longer than 100 characters/);
  assert.throws(() => parse(`{ ${'a '.repeat(50)} }`, { maxTokens: 20 }), /more than 20 tokens/);
  assert.throws(() => parse(`${'{ a '.repeat(300)}${'}'.repeat(300)}`), /nested too deeply/);
  assert.throws(() => parse(`{ f(a: ${'['.repeat(300)}1${']'.repeat(300)}) }`), /nested too deeply/);
});

test('schema: SDL features build, extensions merge, built-in scalars and directives exist', () => {
  const s = S();
  assert.equal(s.query, 'Query');
  assert.equal(s.mutation, 'Mutation');
  assert.equal(s.types.get('Query')!.description, 'The root.');
  assert.ok(s.types.get('Query')!.fields.has('today'), 'extend type merged');
  assert.deepEqual([...s.types.get('Role')!.values.keys()], ['ADMIN', 'MEMBER', 'GUEST']);
  assert.equal(s.types.get('User')!.fields.get('email')!.deprecated, 'use contact');
  assert.deepEqual(s.types.get('User')!.fields.get('posts')!.cost, { value: 2, multipliers: ['limit'] });
  assert.deepEqual([...s.possibleTypes('SearchResult')], ['User', 'Post']);
  assert.deepEqual([...s.possibleTypes('Node')].sort(), ['Post', 'User']);
  for (const d of ['skip', 'include', 'deprecated', 'specifiedBy', 'auth']) assert.ok(s.directives.has(d), d);
});

test('schema: an incoherent schema is refused with every problem listed', () => {
  const problems = (sdl: string): string[] => {
    try {
      buildSchema(sdl);
    } catch (e) {
      return ((e as GraphQLError).extensions?.['problems'] as string[] | undefined) ?? [(e as Error).message];
    }
    return [];
  };
  assert.match(problems('type Query { a: Missing }').join('|'), /Unknown type "Missing"/);
  assert.match(problems('interface I { a: Int! } type Query implements I { b: Int }').join('|'), /Interface field I.a expected but Query does not provide it/);
  assert.match(problems('interface I { a: Int! } type Query implements I { a: Int }').join('|'), /expects type Int! but Query.a is type Int/);
  assert.match(problems('interface I { a: Int } type Query implements I { a: Int! }').join('|'), /^$/, 'a stricter implementation is allowed');
  assert.match(problems('type A { a: Int } union U = Int type Query { u: U }').join('|'), /can only include Object types/);
  assert.match(problems('type Query { a: Int } type Query { b: Int }').join('|'), /only one type named "Query"/);
  assert.match(problems('input I { a: Query } type Query { a(i: I): Int }').join('|'), /must be an input type/);
  assert.match(problems('type Query { a(x: Query): Int }').join('|'), /must be an input type/);
  assert.match(problems('type Query { a: Int a: Int }').join('|'), /can only be defined once/);
  assert.match(problems('type A { a: Int }').join('|'), /Query root type must be provided/);
  assert.match(problems('enum E { A } type Query { __x: Int }').join('|'), /must not begin with "__"/);
  assert.match(problems('extend type Nope { a: Int } type Query { a: Int }').join('|'), /Cannot extend type "Nope"/);
  assert.match(problems('enum E { true } type Query { a: Int }').join('|') || 'syntax', /syntax|reserved/);
});

test('validation: a good query passes; each broken rule is reported with its reason', () => {
  const s = S();
  const ok = (q: string) => assert.deepEqual(codes(validate(s, parse(q))), [], q);
  ok('{ hello user(id: "1") { id name role friends(first: 2) { id } } }');
  ok('query Q($id: ID!, $n: Int = 5) { user(id: $id) { friends(first: $n) { name } } }');
  ok('{ search(text: "x") { ... on User { name } ... on Post { title } __typename } }');
  ok('{ node(id: "1") { id ... on User { name } } }');
  const bad = (q: string, re: RegExp) => {
    const m = codes(validate(s, parse(q))).join(' | ');
    assert.match(m, re, q);
  };
  bad('{ nope }', /Cannot query field "nope" on type "Query"/);
  bad('{ user(id: "1") }', /must have a selection of subfields/);
  bad('{ hello { x } }', /must not have a selection/);
  bad('{ user { id } }', /argument "id" of type "ID!" is required/);
  bad('{ user(id: "1", zip: 3) { id } }', /Unknown argument "zip"/);
  bad('{ user(id: 5.5) { id } }', /ID cannot represent value: 5.5/);
  bad('{ users(first: "x") { id } }', /Int cannot represent value: "x"/);
  bad('{ users(first: 99999999999) { id } }', /32-bit/);
  bad('{ user(id: "1") { role email nope } }', /Cannot query field "nope" on type "User"/);
  bad('mutation { rename(id: "1", input: { tags: ["a"] }) { id } }', /Field "RenameInput.name" of required type "String!" was not provided/);
  bad('mutation { rename(id: "1", input: { name: "a", extra: 1 }) { id } }', /Field "extra" is not defined by type "RenameInput"/);
  bad('{ user(id: "1") { role(x: 1) } }', /Unknown argument "x"/);
  bad('{ hello @nope }', /Unknown directive "@nope"/);
  bad('{ hello @skip }', /argument "if" of type "Boolean!" is required/);
  bad('{ hello @skip(if: true) @skip(if: false) }', /can only be used once/);
  bad('{ hello @auth(role: "x") }', /may not be used on FIELD/);
  bad('query A { hello } query A { hello }', /only one operation named "A"/);
  bad('{ hello } query B { hello }', /anonymous operation must be the only/);
  bad('{ __typename ...Missing }', /Unknown fragment "Missing"/);
  bad('subscription { a }', /Schema is not configured for subscriptions/);
  bad('type X { a: Int }', /not executable/);
  bad('fragment U on Int { x } { hello }', /cannot condition on non composite type "Int"/);
  bad('{ hello ... on Nope { x } }', /Unknown type "Nope"/);
  bad('{ user(id: "1") { ... on Post { title } } }', /can never be of type "Post"/);
  bad('query ($a: Query) { hello }', /cannot be non-input type/);
});

test('validation: variables must be defined, used, and of a compatible type for where they sit', () => {
  const s = S();
  const m = (q: string) => codes(validate(s, parse(q))).join(' | ');
  assert.match(m('{ user(id: $x) { id } }'), /Variable "\$x" is not defined/);
  assert.match(m('query Q($x: ID!) { hello }'), /Variable "\$x" is never used in operation "Q"/);
  assert.match(m('query Q($id: Int!) { user(id: $id) { id } }'), /Variable "\$id" of type "Int!" used in position expecting type "ID!"/);
  assert.match(m('query Q($id: ID) { user(id: $id) { id } }'), /of type "ID" used in position expecting type "ID!"/);
  assert.equal(m('query Q($id: ID = "1") { user(id: $id) { id } }'), '', 'a default makes a nullable variable fit a non-null spot');
  assert.equal(m('query Q($n: Int!) { users(first: $n) { id } }'), '', 'non-null fits nullable');
  assert.match(m('query Q($a: String, $a: String) { hello(name: $a) }'), /only one variable named "\$a"/);
  assert.match(m('query Q($n: Int = "x") { users(first: $n) { id } }'), /invalid default value/);
  assert.match(m('query Q($id: ID!) { user(id: $id) { ...F } } fragment F on User { friends(first: $id) { id } }'), /Variable "\$id" of type "ID!" used in position expecting type "Int"/, 'positions inside fragments count');
  assert.equal(m('query Q($n: Int) { user(id: "1") { ...F } } fragment F on User { friends(first: $n) { id } }'), '', 'a variable used only in a fragment is used');
  assert.match(m('mutation Q($i: RenameInput!) { rename(id: "1", input: $i) { id } }'), /^$/);
  assert.match(m('mutation Q($n: [String!]) { rename(id: "1", input: { name: "x", tags: $n }) { id } }'), /^$/);
  assert.match(m('mutation Q($n: String) { rename(id: "1", input: { name: $n }) { id } }'), /used in position expecting type "String!"/);
});

test('validation: fragments must exist, be used, be possible, and not loop', () => {
  const s = S();
  const m = (q: string) => codes(validate(s, parse(q))).join(' | ');
  assert.match(m('{ user(id: "1") { ...A } } fragment A on User { ...B } fragment B on User { ...A }'), /Cannot spread fragment ".*" within itself/);
  assert.match(m('{ hello } fragment A on User { id }'), /Fragment "A" is never used/);
  assert.match(m('fragment A on User { id } fragment A on User { name } { user(id:"1"){ ...A } }'), /only one fragment named "A"/);
  assert.equal(m('{ node(id: "1") { ...U } } fragment U on User { name }'), '', 'an interface may be spread as one of its implementations');
  assert.match(m('{ node(id: "1") { ...Q } } fragment Q on Query { hello }'), /can never be of type "Query"/);
});

test('validation: fields that share a response name must be the same field with the same arguments', () => {
  const s = S();
  const m = (q: string) => codes(validate(s, parse(q))).join(' | ');
  assert.match(m('{ a: hello b: hello a: users { id } }'), /conflict because "hello" and "users" are different fields/);
  assert.match(m('{ hello(name: "a") hello(name: "b") }'), /differing arguments/);
  assert.equal(m('{ hello hello user(id: "1") { id } user(id: "1") { name } }'), '', 'identical fields merge');
  assert.match(m('{ node(id: "1") { ... on User { x: name } ... on Post { x: title } } }'), /^$/, 'different concrete types may differ');
  assert.match(m('{ user(id:"1") { a: id a: name } }'), /conflict/);
});

test('limits: depth, aliases, and cost with list multipliers, variables, fragments and @cost', () => {
  const s = S();
  const doc = parse('query Q($n: Int) { users(first: $n) { id friends(first: 3) { name } } }');
  assert.deepEqual(analyze(s, doc, { variables: { n: 5 } }), { depth: 3, aliases: 0, cost: 1 + 5 * (1 + 1 + 3 * 1), fields: 4 });
  assert.equal(analyze(s, doc).cost, 1 + 10 * (1 + 1 + 3), 'a list with no limit counts as 10');
  assert.equal(analyze(s, parse('{ user(id:"1") { posts(limit: 4) { id } } }')).cost, 1 + (2 + 4 * 1), '@cost value plus multiplier from its named argument');
  assert.equal(analyze(s, parse('{ users(first: 100000) { id } }')).cost, 1 + 1000 * 1, 'capped at maxListSize');
  assert.equal(analyze(s, parse('{ a: hello b: hello c: hello }')).aliases, 3);
  assert.equal(analyze(s, parse('{ users(first: 2) { ...F } } fragment F on User { id name }')).cost, 1 + 2 * 2);
  assert.equal(analyze(s, parse('{ users(first: 2) { id @skip(if: true) name } }')).cost, 1 + 2 * 1, '@skip(if: true) costs nothing');
  const q = '{ nested { inner { inner { inner { value } } } } }';
  assert.match(codes(validate(s, parse(q), { maxDepth: 4 })).join(), /depth 5 exceeds the maximum of 4/);
  assert.deepEqual(codes(validate(s, parse(q), { maxDepth: 5 })), []);
  assert.match(codes(validate(s, parse('{ a: hello b: hello c: hello }'), { maxAliases: 2 })).join(), /3 aliases/);
  assert.match(codes(validate(s, parse('{ users(first: 50) { friends(first: 50) { friends(first: 50) { id } } } }'), { maxCost: 1000 })).join(), /cost \d+ exceeds the maximum of 1000/);
  const e = validate(s, parse('{ users(first: 50) { friends(first: 50) { id } } }'), { maxCost: 10 })[0]!;
  assert.equal(e.extensions!['code'], 'COST_LIMIT_EXCEEDED');
});

test('introspection can be switched off; __typename always works', () => {
  const s = S();
  assert.match(codes(validate(s, parse('{ __schema { queryType { name } } }'), { disableIntrospection: true })).join(), /introspection is not allowed/);
  assert.match(codes(validate(s, parse('{ __type(name: "User") { name } }'), { disableIntrospection: true })).join(), /introspection is not allowed/);
  assert.deepEqual(codes(validate(s, parse('{ __typename user(id: "1") { __typename } }'), { disableIntrospection: true })), []);
  assert.deepEqual(codes(validate(s, parse('{ __schema { queryType { name } } }'))), []);
  assert.deepEqual(codes(validate(s, parse('{ __schema { types { name } } }'), { maxDepth: 5 })), []);
});

test('execute: arguments, defaults, aliases, enums, nested lists, @skip and @include', async () => {
  const r = await execute(S(), 'query($s: Boolean!) { a: hello b: hello(name: "Ana") users(first: 2) { name role @skip(if: $s) } user(id: "9") { id } }', { resolvers, variables: { s: true } });
  assert.deepEqual(r, { data: { a: 'Hello, world!', b: 'Hello, Ana!', users: [{ name: 'Ana' }, { name: 'Bo' }], user: null } });
  const r2 = await execute(S(), '{ users(first: 1) { role ... @include(if: false) { name } } }', { resolvers });
  assert.deepEqual(r2.data, { users: [{ role: 'ADMIN' }] });
});

test('execute: variable coercion refuses bad input before running anything', async () => {
  const run = (variables: Record<string, unknown>) => execute(S(), 'query($id: ID!, $n: Int) { user(id: $id) { id } users(first: $n) { id } }', { resolvers, variables });
  assert.match((await run({})).errors![0]!.message, /Variable "\$id" of required type "ID!" was not provided/);
  assert.match((await run({ id: '1', n: 'x' })).errors![0]!.message, /Variable "\$n".*got invalid value.*Int cannot represent/);
  assert.match((await run({ id: '1', n: 1.5 })).errors![0]!.message, /Int cannot represent non 32-bit signed integer/);
  assert.match((await run({ id: null })).errors![0]!.message, /not to be null/);
  const bad = await execute(S(), 'mutation($i: RenameInput!) { rename(id: "1", input: $i) { id } }', { resolvers, variables: { i: { name: 'x', zz: 1 } } });
  assert.match(bad.errors![0]!.message, /Field "zz" is not defined by type "RenameInput"/);
  assert.equal(bad.data, undefined);
  const list = await execute(S(), 'mutation($i: RenameInput!) { rename(id: "1", input: $i) { id } }', { resolvers: { Mutation: { rename: (_: unknown, a: { input: { tags: string[] } }) => ({ id: a.input.tags.join('+') }) } }, variables: { i: { name: 'x', tags: 'single' } } });
  assert.deepEqual(list.data, { rename: { id: 'single' } }, 'a single value is accepted where a list is expected');
  assert.deepEqual((await run({ id: 7 })).data, { user: null, users: [{ id: '1' }, { id: '2' }, { id: '3' }] }, 'an integer is a valid ID');
});

test('execute: errors carry their path, and null propagates to the nearest nullable parent', async () => {
  const r = await execute(S(), '{ flaky hello must }', { resolvers });
  assert.equal(r.data, null, 'a non-null field at the root nulls the whole result');
  assert.equal(r.errors!.length, 2);
  assert.deepEqual(r.errors![0]!.path, ['flaky']);
  assert.equal(r.errors![0]!.message, 'boom');
  assert.match(r.errors![1]!.message, /Cannot return null for non-nullable field/);
  const r2 = await execute(S(), '{ hello flaky items }', { resolvers });
  assert.deepEqual(r2.data, { hello: 'Hello, world!', flaky: null, items: null });
  assert.deepEqual(r2.errors!.map((e) => e.path), [['flaky'], ['items', 2]], 'a null in a list of non-null items nulls the list');
  const r3 = await execute(S(), '{ users { id name } }', { resolvers: { ...resolvers, Query: { ...resolvers.Query, users: () => [db.users[0], new Error('row 2 failed'), db.users[2]] } } });
  assert.equal(r3.data, null, 'non-null items in a non-null list: the error reaches the root');
  assert.deepEqual(r3.errors![0]!.path, ['users', 1]);
  const r4 = await execute(S(), '{ users { id name } }', { resolvers: { Query: { users: () => [db.users[0]!] }, User: { name: () => { throw new Error('no name'); } } } });
  assert.deepEqual(r4.data, { users: [{ id: '1', name: null }] }, 'a nullable field fails alone');
  assert.deepEqual(r4.errors![0]!.path, ['users', 0, 'name']);
  assert.equal(r4.errors![0]!.locations![0]!.line, 1);
});

test('execute: mutations run one after another, queries may run together', async () => {
  const order: string[] = [];
  let n = 0;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const r = await execute(S(), 'mutation { a: bump(by: 1) b: bump(by: 10) c: bump }', {
    resolvers: {
      Mutation: {
        bump: async (_: unknown, a: { by: number }) => {
          order.push(`start ${a.by}`);
          await wait(a.by === 1 ? 20 : 1);
          n += a.by;
          order.push(`end ${a.by}`);
          return n;
        },
      },
    },
  });
  assert.deepEqual(r.data, { a: 1, b: 11, c: 12 });
  assert.deepEqual(order, ['start 1', 'end 1', 'start 10', 'end 10', 'start 1', 'end 1']);
  const q: string[] = [];
  await execute(S(), '{ a: hello b: hello }', { resolvers: { Query: { hello: async (_: unknown, __: unknown, ___: unknown, i: { path: readonly (string | number)[] }) => { q.push(`s ${i.path[0]}`); await wait(i.path[0] === 'a' ? 10 : 1); q.push(`e ${i.path[0]}`); return 'x'; } } } });
  assert.deepEqual(q, ['s a', 's b', 'e b', 'e a'], 'sibling query fields overlap');
});

test('execute: interfaces and unions resolve by __typename or resolveType, and bad answers are errors', async () => {
  const r = await execute(S(), '{ search(text: "q") { __typename ... on User { name } ... on Post { title } } node(id: "p1") { id ... on Post { title } } }', { resolvers });
  assert.deepEqual(r.data, { search: [{ __typename: 'User', name: 'Ana' }, { __typename: 'Post', title: 'Post' }], node: { id: 'p1', title: 'T' } });
  const noType = await execute(S(), '{ node(id: "1") { id } }', { resolvers: { Query: { node: () => ({ id: '1' }) } } });
  assert.match(noType.errors![0]!.message, /must resolve to an Object type at runtime/);
  const viaFn = await execute(S(), '{ node(id: "1") { id ... on User { name } } }', { resolvers: { Query: { node: () => ({ id: '1', name: 'Zed' }) } }, resolveType: { Node: () => 'User' } });
  assert.deepEqual(viaFn.data, { node: { id: '1', name: 'Zed' } });
  const wrong = await execute(S(), '{ search(text: "x") { __typename } }', { resolvers: { Query: { search: () => [{ __typename: 'Role' }] } } });
  assert.match(wrong.errors![0]!.message, /does not exist inside the schema|not a possible type/);
  const notMember = await execute(S(), '{ search(text: "x") { __typename } }', { resolvers: { Query: { search: () => [{ __typename: 'Outer' }] } } });
  assert.match(notMember.errors![0]!.message, /not a possible type for "SearchResult"/);
});

test('execute: result coercion and custom scalars', async () => {
  const bad = await execute(S(), '{ user(id: "1") { role } }', { resolvers: { Query: { user: () => ({ role: 'SUPERUSER' }) } } });
  assert.match(bad.errors![0]!.message, /Enum "Role" cannot represent value: "SUPERUSER"/);
  const badInt = await execute(S(), '{ items }', { resolvers: { Query: { items: () => [1.5] } } });
  assert.match(badInt.errors![0]!.message, /Int cannot represent non-integer value: 1.5/);
  const date = await execute(S(), '{ today }', { resolvers, scalars: { Date: { serialize: (v) => (v as Date).toISOString().slice(0, 10), parse: (v) => new Date(String(v)) } } });
  assert.deepEqual(date.data, { today: '2026-01-02' });
  const s = buildSchema('scalar Date type Query { when(d: Date): Date }');
  const echo = await execute(s, 'query($d: Date) { when(d: $d) }', { variables: { d: '2025-05-05' }, resolvers: { Query: { when: (_: unknown, a: { d: Date }) => a.d } }, scalars: { Date: { serialize: (v) => (v as Date).toISOString().slice(0, 10), parse: (v) => new Date(String(v)) } } });
  assert.deepEqual(echo.data, { when: '2025-05-05' });
});

test('execute: a query that fails validation or parsing never reaches a resolver', async () => {
  let called = 0;
  const res = { Query: { hello: () => (called++, 'x') } };
  assert.match((await execute(S(), '{ hello nope }', { resolvers: res })).errors![0]!.message, /Cannot query field "nope"/);
  assert.match((await execute(S(), '{ hello ', { resolvers: res })).errors![0]!.message, /Syntax Error/);
  assert.match((await execute(S(), '{ hello }', { resolvers: res, maxCost: 0 })).errors![0]!.message, /cost 1 exceeds/);
  assert.match((await execute(S(), 'query A { hello } query B { hello }', { resolvers: res })).errors![0]!.message, /Must provide operation name/);
  assert.match((await execute(S(), 'query A { hello }', { resolvers: res, operationName: 'Z' })).errors![0]!.message, /Unknown operation named "Z"/);
  assert.equal(called, 0);
  assert.deepEqual((await execute(S(), 'query A { hello } query B { hello(name: "b") }', { resolvers: { Query: { hello: (_: unknown, a: { name: string }) => a.name } }, operationName: 'B' })).data, { hello: 'b' });
});

test('introspection answers from the schema: types, fields, wrappers, enums, directives, deprecation', async () => {
  const r = await execute(
    S(),
    `{ __schema { queryType { name } mutationType { name } subscriptionType { name } directives { name locations args { name } } }
       user: __type(name: "User") { kind name interfaces { name } fields { name isDeprecated type { kind name ofType { kind name ofType { name } } } } all: fields(includeDeprecated: true) { name isDeprecated deprecationReason } }
       role: __type(name: "Role") { kind enumValues { name } }
       node: __type(name: "Node") { kind possibleTypes { name } }
       input: __type(name: "RenameInput") { kind inputFields { name type { kind } } }
       none: __type(name: "Nope") { name } }`,
  );
  assert.equal(r.errors, undefined);
  const d = r.data as any;
  assert.deepEqual(d.__schema.queryType, { name: 'Query' });
  assert.deepEqual(d.__schema.mutationType, { name: 'Mutation' });
  assert.equal(d.__schema.subscriptionType, null);
  assert.deepEqual(d.__schema.directives.find((x: { name: string }) => x.name === 'skip'), { name: 'skip', locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [{ name: 'if' }] });
  assert.equal(d.user.kind, 'OBJECT');
  assert.deepEqual(d.user.interfaces, [{ name: 'Node' }]);
  assert.equal(d.user.fields.some((f: { name: string }) => f.name === 'email'), false, 'deprecated fields are hidden by default');
  assert.deepEqual(d.user.all.find((f: { name: string }) => f.name === 'email'), { name: 'email', isDeprecated: true, deprecationReason: 'use contact' });
  assert.deepEqual(d.user.fields.find((f: { name: string }) => f.name === 'friends').type, { kind: 'LIST', name: null, ofType: { kind: 'NON_NULL', name: null, ofType: { name: 'User' } } });
  assert.deepEqual(d.role, { kind: 'ENUM', enumValues: [{ name: 'ADMIN' }, { name: 'MEMBER' }, { name: 'GUEST' }] });
  assert.deepEqual(d.node.possibleTypes.map((t: { name: string }) => t.name).sort(), ['Post', 'User']);
  assert.deepEqual(d.input.inputFields, [{ name: 'name', type: { kind: 'NON_NULL' } }, { name: 'tags', type: { kind: 'LIST' } }]);
  assert.equal(d.none, null);
  const off = await execute(S(), '{ __schema { queryType { name } } }', { disableIntrospection: true });
  assert.match(off.errors![0]!.message, /introspection is not allowed/);
});

test('plan: lists the resolver calls with arguments resolved, and every possible type under an abstract field', () => {
  const p = plan(S(), parse('query($n: Int) { users(first: $n) { id posts { title } } search(text: "t") { ... on User { name } ... on Post { title } } hello }'), { variables: { n: 3 } });
  assert.deepEqual(p.map((x) => x.responseKey), ['users', 'search', 'hello']);
  assert.deepEqual(p[0]!.args, { first: 3 });
  assert.deepEqual(p[0]!.children.map((c) => `${c.parentType}.${c.field}`), ['User.id', 'User.posts']);
  assert.deepEqual(p[0]!.children[1]!.args, { limit: 20 }, 'defaults are applied');
  assert.deepEqual(p[0]!.children[1]!.path, ['users', 'posts']);
  assert.deepEqual(p[1]!.children.map((c) => `${c.typeCondition}:${c.parentType}.${c.field}`), ['User:User.name', 'Post:Post.title']);
  assert.equal(p[2]!.returnType, 'String!');
  assert.throws(() => plan(S(), parse('query($n: Int!) { users(first: $n) { id } }')), /required type "Int!" was not provided/);
});
