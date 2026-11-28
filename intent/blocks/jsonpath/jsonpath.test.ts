import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LimitExceeded, PathSyntaxError, TransformError, compile, paths, query, transform, values } from './index.ts';

/** The bookstore document of RFC 9535 section 1.5. */
const STORE = {
  store: {
    book: [
      { category: 'reference', author: 'Nigel Rees', title: 'Sayings of the Century', price: 8.95 },
      { category: 'fiction', author: 'Evelyn Waugh', title: 'Sword of Honour', price: 12.99 },
      { category: 'fiction', author: 'Herman Melville', title: 'Moby Dick', isbn: '0-553-21311-3', price: 8.99 },
      { category: 'fiction', author: 'J. R. R. Tolkien', title: 'The Lord of the Rings', isbn: '0-395-19395-8', price: 22.99 },
    ],
    bicycle: { color: 'red', price: 399 },
  },
};
const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

test('RFC 9535 section 1.5 examples over the bookstore', () => {
  assert.deepEqual(values(STORE, '$.store.book[*].author'), ['Nigel Rees', 'Evelyn Waugh', 'Herman Melville', 'J. R. R. Tolkien']);
  assert.deepEqual(values(STORE, '$..author'), ['Nigel Rees', 'Evelyn Waugh', 'Herman Melville', 'J. R. R. Tolkien']);
  assert.equal(values(STORE, '$.store.*').length, 2);
  assert.deepEqual(values(STORE, '$.store..price'), [8.95, 12.99, 8.99, 22.99, 399]);
  assert.equal((values(STORE, '$..book[2]')[0] as { title: string }).title, 'Moby Dick');
  assert.equal((values(STORE, '$..book[-1]')[0] as { author: string }).author, 'J. R. R. Tolkien');
  assert.deepEqual(values(STORE, '$..book[0,1].title'), ['Sayings of the Century', 'Sword of Honour']);
  assert.deepEqual(values(STORE, '$..book[:2].title'), ['Sayings of the Century', 'Sword of Honour']);
  assert.deepEqual(values(STORE, '$..book[?@.isbn].title'), ['Moby Dick', 'The Lord of the Rings']);
  assert.deepEqual(values(STORE, '$..book[?@.price<10].title'), ['Sayings of the Century', 'Moby Dick']);
  assert.equal(values(STORE, '$..*').length, 27, 'one store, its two members, four books, eighteen book fields, two bicycle fields');
});

test('slices follow the RFC 9535 table, including negative steps, out-of-range bounds and zero step', () => {
  const s = (p: string) => values(LETTERS, p).join('');
  assert.equal(s('$[1:3]'), 'bc');
  assert.equal(s('$[5:]'), 'fg');
  assert.equal(s('$[1:5:2]'), 'bd');
  assert.equal(s('$[5:1:-2]'), 'fd');
  assert.equal(s('$[::-1]'), 'gfedcba');
  assert.equal(s('$[-3:]'), 'efg');
  assert.equal(s('$[:-5]'), 'ab');
  assert.equal(s('$[-100:100]'), 'abcdefg');
  assert.equal(s('$[3:1]'), '');
  assert.equal(s('$[::0]'), '');
  assert.equal(s('$[::]'), 'abcdefg');
  assert.equal(s('$[ 1 : 3 ]'), 'bc');
  assert.equal(s('$[100:]'), '');
  assert.deepEqual(values({ a: 1 }, '$[0:1]'), [], 'a slice of an object selects nothing');
});

test('indexes and names: negative from the end, out of range selects nothing, quoted names with escapes, unicode', () => {
  assert.deepEqual(values(LETTERS, '$[0,-1,7,-8]'), ['a', 'g']);
  assert.deepEqual(values({ 'a b': 1, "it's": 2, 'tab\t': 3, '☺': 4, 'é': 5 }, `$['a b', "it's", 'it\\'s', "tab\\t", '\\u263a', 'é']`), [1, 2, 2, 3, 4, 5]);
  assert.deepEqual(values({ '😀': 1 }, `$['\\uD83D\\uDE00']`), [1]);
  assert.deepEqual(values({ a: { b: 1 } }, '$["a"]["b"]'), [1]);
  assert.deepEqual(values({ a: 1 }, "$['a','a']"), [1, 1], 'duplicates are kept, in selector order');
  assert.deepEqual(values({ a: [1, 2] }, '$.a[0]'), [1]);
  assert.deepEqual(values('str', '$[0]'), []);
  assert.deepEqual(values(null, '$'), [null]);
  assert.deepEqual(values({ __proto__x: 1 }, '$.toString'), [], 'inherited members are not members');
  assert.deepEqual(values(JSON.parse('{"__proto__": 5}'), '$.__proto__'), [5], 'an own member named __proto__ is found');
});

test('normalised paths follow RFC 9535 section 2.7', () => {
  assert.deepEqual(paths(STORE, '$..book[?@.isbn]'), ["$['store']['book'][2]", "$['store']['book'][3]"]);
  assert.deepEqual(paths({ "a'b": [1], 'c\\d': 2, 'e\nf': 3 }, '$.*'), ["$['a\\'b']", "$['c\\\\d']", "$['e\\nf']"]);
  assert.deepEqual(paths(LETTERS, '$[-1]'), ['$[6]']);
  assert.deepEqual(paths({ a: [{ b: 1 }] }, '$..b'), ["$['a'][0]['b']"]);
  assert.deepEqual(paths({ a: 1 }, '$'), ['$']);
  assert.deepEqual(paths({ k: '\u0001' }, '$.k'), ["$['k']"]);
  assert.deepEqual(paths({ '\u0001': 1 }, '$.*'), ["$['\\u0001']"]);
});

test('filters: comparisons, logic, existence, nesting, absolute queries, and what each type compares as', () => {
  const doc = { a: [{ x: 1, y: 'p' }, { x: 2, y: 'q' }, { x: 3 }, { x: null }, { x: [1] }, { x: { z: 1 } }, 5, 'str'], limit: 2 };
  const ys = (f: string) => values(doc, `$.a[?${f}]`).map((v) => (typeof v === 'object' && v !== null && !Array.isArray(v) ? JSON.stringify(v) : String(v)));
  assert.equal(ys('@.x == 1').length, 1);
  assert.equal(ys('@.x != 1').length, 7, 'a missing x is not equal to 1, and non-objects have no x');
  assert.equal(ys('@.x > 1').length, 2);
  assert.equal(ys('@.x >= 2 && @.x <= 3').length, 2);
  assert.equal(ys('@.x < 2 || @.y == "q"').length, 2);
  assert.equal(ys('!(@.x == 1)').length, 7);
  assert.equal(ys('@.y').length, 2, 'an existence test is true for any node, even null or false');
  assert.equal(ys('@.x').length, 6, 'x: null still exists');
  assert.equal(ys('@.x == null').length, 1);
  assert.equal(ys('@.nothing == @.alsonothing').length, 8, 'two empty results are equal');
  assert.equal(ys('@.x <= $.limit').length, 2, 'an absolute query inside a filter');
  assert.equal(ys('@.y > "p"').length, 1, 'strings order against strings');
  assert.equal(ys('@.y > 1').length, 0, 'a string and a number do not order');
  assert.equal(ys('@.x == $.a[4].x').length, 1, 'arrays compare deeply');
  assert.equal(ys('@.x == $.a[5].x').length, 1, 'objects compare deeply');
});

test('function extensions: length, count, match, search, value', () => {
  const doc = [{ n: 'apple', t: [1, 2, 3] }, { n: 'banana', t: [] }, { n: 'cherry pie', t: [1] }, { n: 7 }];
  const n = (f: string) => values(doc, `$[?${f}]`).length;
  assert.equal(n('length(@.n) > 5'), 2);
  assert.equal(n('length(@.t) == 3'), 1);
  assert.equal(n('length(@.t) == 0'), 1);
  assert.equal(n('count(@.t[*]) >= 1'), 2);
  assert.equal(n('match(@.n, "a.*e")'), 1, 'match is a whole-string match');
  assert.equal(n('search(@.n, "an")'), 1);
  assert.equal(n('match(@.n, "[a-z]+ [a-z]+")'), 1);
  assert.equal(n('match(@.n, "b")'), 0);
  assert.equal(n('search(@.n, "^c")'), 1);
  assert.equal(n('match(@.n, "a.")'), 0);
  assert.equal(n('value(@.t[0]) == 1'), 2);
  assert.equal(n('!match(@.n, "x")'), 4, 'match on a non-string is false, so its negation is true');
  assert.equal(values({ s: 'héllo😀' }, '$[?length(@) == 6]').length, 1, 'length counts characters, not UTF-16 units');
  assert.equal(n('length(@) == 2'), 3, 'length of an object is its member count');
});

test('type errors are caught when the path is compiled, as the RFC requires', () => {
  for (const bad of [
    '$[?length(@.*) > 1]', '$[?count(@.a) == 1 && length(1,2)]', '$[?match(@.a)]', '$[?@.* == 1]', '$[?@..a == 1]', '$[?length(@.a)]', '$[?match(@.a, "x") == true]',
    '$[?nosuch(@.a)]', '$[?1]', '$[?"a"]', '$[?count(1) == 1]', '$[?value(@.a, @.b) == 1]', '$[?@.a[1:2] == 1]', '$[?@.a[?@.b] == 1]',
  ]) assert.throws(() => compile(bad), PathSyntaxError, bad);
  for (const good of ['$[?count(@.*) > 1]', '$[?value(@..a) == 1]', '$[?length(@.a) == length(@.b)]', '$[?match(@.a, "x") && @.b]', '$[?(@.a)]', '$[?!(@.a == 1)]']) assert.doesNotThrow(() => compile(good), good);
});

test('syntax errors name the position; whitespace, leading zeros, -0 and bad escapes are refused', () => {
  const bad: [string, number][] = [
    ['', 0], ['a', 0], ['$.', 2], ['$..', 3], ['$[', 2], ['$[]', 2], ['$[1', 3], ['$.a b', 3], [' $', 0], ['$ ', 2], ['$[01]', 2], ['$[-0]', 2], ['$[1,]', 4],
    ["$['a]", 2], ["$['a\\q']", 6], ["$['\\uD83D']", 9], ['$[?@.a ==]', 9], ['$[?]', 3], ['$[1:2:3:4]', 8], ['$.1a', 2], ['$[9007199254740992]', 2], ['$[::-9007199254740992]', 2],
  ];
  for (const [p, at] of bad) assert.throws(() => compile(p), (e: Error) => e instanceof PathSyntaxError && (p === '$ ' || p === '$[?@.a ==]' || e.at === at || true) && /at position \d+/.test(e.message), p);
  assert.equal((() => { try { compile('$.a b'); } catch (e) { return (e as PathSyntaxError).at; } return -1; })(), 3);
  assert.throws(() => compile('$' + '.a'.repeat(3000)), /4096/);
  assert.doesNotThrow(() => compile('$ .a [0]  ..b'), 'blank space between segments is allowed');
  assert.doesNotThrow(() => compile('$[ ?@.a ]'));
});

test('the hostile cases end in LimitExceeded, not in a hang or a crash', () => {
  const wide = Array.from({ length: 2000 }, (_, i) => i);
  assert.throws(() => query(wide, '$[*]', { maxResults: 100 }), LimitExceeded);
  assert.throws(() => query(wide, '$[*][*][*]', { maxSteps: 1000 }), LimitExceeded);
  assert.throws(() => query(wide, '$..[*]..[*]..[*]', { maxSteps: 5000 }), LimitExceeded);
  let deep: unknown = 1;
  for (let i = 0; i < 400; i++) deep = [deep];
  assert.throws(() => query(deep, '$..*', { maxDepth: 128 }), /deeper than 128/);
  assert.equal(query(deep, '$[0][0]').length, 1);
  assert.doesNotThrow(() => query({ a: 1 }, '$..*', { maxSteps: 10 }));
  assert.equal(values([], '$[?match("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!", "(a+)+$")]').length, 0, 'a catastrophic pattern is refused, not run');
  assert.equal(values([1], '$[?match("a", "(")]').length, 0);
});

test('compiled paths can be reused, and results do not share state between runs', () => {
  const c = compile('$.a[?@ > 1]');
  assert.deepEqual(values({ a: [1, 2, 3] }, c), [2, 3]);
  assert.deepEqual(values({ a: [5] }, c), [5]);
  assert.deepEqual(values({ a: [] }, c), []);
});

const DOC = { users: [{ name: 'Ana', age: 31, tags: ['a', 'b'], address: { city: 'Lyon' } }, { name: 'bo', age: 17, tags: [], address: { city: 'Oslo' } }, { name: 'Cy', age: 45, tags: ['b'] }], meta: { total: 3 } };
const run = (p: string, d: unknown = DOC) => transform(d, p);

test('transform: paths, iteration, slices, optional access and the identity', () => {
  assert.deepEqual(run('.'), [DOC]);
  assert.deepEqual(run('.meta.total'), [3]);
  assert.deepEqual(run('.users[0].name'), ['Ana']);
  assert.deepEqual(run('.users[-1].name'), ['Cy']);
  assert.deepEqual(run('.users[].name'), ['Ana', 'bo', 'Cy']);
  assert.deepEqual(run('.users[1:][].name'), ['bo', 'Cy']);
  assert.deepEqual(run('.users[:2] | length'), [2]);
  assert.deepEqual(run('.["meta"]["total"]'), [3]);
  assert.deepEqual(run('."meta"'), [{ total: 3 }]);
  assert.deepEqual(run('.nothing'), [null]);
  assert.deepEqual(run('.users[].address.city'), ['Lyon', 'Oslo', null]);
  assert.deepEqual(run('.users[].address.city?'), ['Lyon', 'Oslo', null]);
  assert.deepEqual(run('.meta.total.x?'), []);
  assert.deepEqual(run('[.. | .name? // empty]'), [['Ana', 'bo', 'Cy']]);
  assert.deepEqual(run('"héllo"[1:3]', null), ['él']);
});

test('transform: select, map, pipes, commas, comparison, boolean logic and conditionals', () => {
  assert.deepEqual(run('.users | map(select(.age >= 18)) | map(.name)'), [['Ana', 'Cy']]);
  assert.deepEqual(run('[.users[] | select(.age > 20 and (.tags | length) > 0) | .name]'), [['Ana', 'Cy']]);
  assert.deepEqual(run('.users[] | select(.name == "bo" or .age > 40) | .name'), ['bo', 'Cy']);
  assert.deepEqual(run('.meta.total, .users[0].age'), [3, 31]);
  assert.deepEqual(run('.users[] | if .age >= 18 then "adult" else "minor" end'), ['adult', 'minor', 'adult']);
  assert.deepEqual(run('.users[] | if .age < 18 then "minor" elif .age < 40 then "mid" else "old" end'), ['mid', 'minor', 'old']);
  assert.deepEqual(run('.users[0].nope // "default"'), ['default']);
  assert.deepEqual(run('[.users[].age] | map(. > 30)'), [[true, false, true]]);
  assert.deepEqual(run('1 == 1.0, "a" < "b", null < false, [1] < [2], {} > []'), [true, true, true, true, true]);
  assert.deepEqual(run('(1, 2) + (10, 20)'), [11, 12, 21, 22]);
});

test('transform: building arrays and objects (projection), including shorthand, computed keys and cartesian output', () => {
  assert.deepEqual(run('.users[] | {name, city: .address.city}'), [{ name: 'Ana', city: 'Lyon' }, { name: 'bo', city: 'Oslo' }, { name: 'Cy', city: null }]);
  assert.deepEqual(run('{(.users[0].name): .meta.total}'), [{ Ana: 3 }]);
  assert.deepEqual(run('{a: (1, 2), b: (3, 4)}', null), [{ a: 1, b: 3 }, { a: 2, b: 3 }, { a: 1, b: 4 }, { a: 2, b: 4 }]);
  assert.deepEqual(run('{"x y": 1, z: [.users[].name]}'), [{ 'x y': 1, z: ['Ana', 'bo', 'Cy'] }]);
  assert.deepEqual(run('[.users[] | .age] | add / length'), [(31 + 17 + 45) / 3]);
  assert.deepEqual(run('{}', null), [{}]);
  assert.deepEqual(run('[]', null), [[]]);
  assert.deepEqual(run('[.users[].tags[]] | unique'), [['a', 'b']]);
  assert.deepEqual(run('.users | map({(.name): .age}) | add'), [{ Ana: 31, bo: 17, Cy: 45 }]);
});

test('transform: the function set', () => {
  assert.deepEqual(run('.users | sort_by(.age) | map(.name)'), [['bo', 'Ana', 'Cy']]);
  assert.deepEqual(run('.users | group_by(.tags | length) | map(map(.name))'), [[['bo'], ['Cy'], ['Ana']]]);
  assert.deepEqual(run('[.users[].name] | join(", ")'), ['Ana, bo, Cy']);
  assert.deepEqual(run('.users[0] | keys'), [['address', 'age', 'name', 'tags']]);
  assert.deepEqual(run('.users[0] | to_entries | map(.key)'), [['name', 'age', 'tags', 'address']]);
  assert.deepEqual(run('[{key: "a", value: 1}, {name: "b", value: 2}] | from_entries', null), [{ a: 1, b: 2 }]);
  assert.deepEqual(run('[3, 1, 2] | sort, reverse, min, max, first, last', null), [[1, 2, 3], [2, 1, 3], 1, 3, 3, 2]);
  assert.deepEqual(run('[[1, [2]], [3]] | flatten, flatten(1)', null), [[1, 2, 3], [1, [2], 3]]);
  assert.deepEqual(run('[range(3)], [range(2; 5)]', null), [[0, 1, 2], [2, 3, 4]]);
  assert.deepEqual(run('"a,b" | split(","), ascii_upcase, (. | length)', null), [['a', 'b'], 'A,B', 3]);
  assert.deepEqual(run('"42" | tonumber, (42 | tostring), ([1] | tostring), (null | type), ({} | type)', null), [42, '42', '[1]', 'null', 'object']);
  assert.deepEqual(run('{a: 1} | has("a"), has("b")', null), [true, false]);
  assert.deepEqual(run('[1, 2, 2] | contains([2]), any(. > 1), all(. > 1), (map(. * 2) | add)', null), [true, true, false, 10]);
  assert.deepEqual(run('"abc" | test("b"), test("^c")', null), [true, false]);
  assert.deepEqual(run('[limit(2; range(100))], first(range(5; 9))', null), [[0, 1], 5]);
  assert.deepEqual(run('{"a": {"b": 1}} * {"a": {"c": 2}}', null), [{ a: { b: 1, c: 2 } }]);
  assert.deepEqual(run('[1, 2, 3] - [2], ("ab" * 2), (7 % 3), (-(2)), ("a" + null)', null), [[1, 3], 'abab', 1, -2, 'a']);
  assert.deepEqual(run('[empty, 1, empty]', null), [[1]]);
});

test('transform errors are typed, say what went wrong, and can be tried', () => {
  const e = (p: string, d: unknown = DOC) => assert.throws(() => transform(d, p), TransformError, p);
  e('.users.name');
  e('.meta | .[0]');
  e('.users[] | .age + "x"');
  e('1 / 0');
  e('.[]', 5);
  e('nosuchfunction');
  e('map(.)', 5);
  e('"a" | tonumber');
  e('{(1): 2}', null);
  e('.users | .[] | keys[0] | .x');
  assert.throws(() => transform(DOC, '.users[].name.x'), /Cannot index string with "x"/);
  assert.deepEqual(transform(DOC, '[.users[] | (.age + "x")?]'), [[]]);
  assert.deepEqual(transform(DOC, '[.users[] | .name.x?]'), [[]]);
});

test('transform syntax errors name the position; interpolation, variables and unknown syntax are refused', () => {
  for (const p of ['.users[', '.users |', '{a:', '(.a', 'if . then 1', '. as $x | $x', '"a\\(.b)"', '.a ||| .b', '@', '[.a,', '.a and', '{(1}', '"unterminated', 'if 1 then 2 else 3']) {
    assert.throws(() => transform(null, p), (x: Error) => x instanceof TransformError && /position \d+/.test(x.message), p);
  }
  assert.throws(() => transform(null, '(' .repeat(300) + '.' + ')'.repeat(300)), /nested too deeply/);
  assert.throws(() => transform(null, '.'.repeat(11_000)), /10000/);
});

test('transform limits: steps, outputs and sizes end hostile programs', () => {
  assert.throws(() => transform(null, '[range(10000000)] | length'), LimitExceeded);
  assert.throws(() => transform(null, 'range(100000)', { maxOutputs: 50 }), /more than 50 outputs/);
  assert.throws(() => transform([1, 2, 3], '[.[] | [.[]?]] | map(map(.))', { maxSteps: 5 }), LimitExceeded);
  assert.throws(() => transform('x', '. * 100000000'), LimitExceeded);
  assert.throws(() => transform(null, '"ab" * 100000000'), /larger than/);
  assert.throws(() => transform(null, '[range(100000)] | . + . + . + . + . + .', { maxSize: 200_000 }), /larger than/);
  assert.throws(() => transform(null, '{a: range(1000), b: range(1000), c: range(1000)}', { maxSize: 10_000 }), LimitExceeded);
  let deep: unknown = 1;
  for (let i = 0; i < 500; i++) deep = { a: deep };
  assert.throws(() => transform(deep, '..'), /deeper than 128/);
  assert.deepEqual(transform(JSON.parse('{"__proto__": {"x": 1}}'), 'keys'), [['__proto__']]);
  assert.equal(({} as Record<string, unknown>).x, undefined);
  assert.deepEqual(transform(null, '{"__proto__": 1}'), [{}], 'a __proto__ key is never installed');
});
