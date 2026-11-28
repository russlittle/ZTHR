import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calver, compare, diff, format, inc, InvalidRange, InvalidVersion, isValid, maxSatisfying, minSatisfying, parse, parseRange, rsort, satisfies, solve, sort, TooComplex, validRange } from './index.ts';

test('the SemVer 2.0.0 precedence example sorts exactly as the specification lists it', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  assert.deepEqual(sort([...ordered].reverse()), ordered);
  assert.deepEqual(rsort(ordered), [...ordered].reverse());
  assert.equal(compare('1.0.0-beta.2', '1.0.0-beta.11'), -1, 'numeric identifiers compare as numbers');
  assert.equal(compare('2.1.1', '2.0.9'), 1);
  assert.equal(compare('1.9.0', '1.10.0'), -1, 'not as text');
});

test('build metadata is ignored in precedence but kept in the parse', () => {
  assert.equal(compare('1.0.0+20130313144700', '1.0.0+other'), 0);
  const v = parse('1.2.3-rc.1+build.5');
  assert.deepEqual(v, { major: 1, minor: 2, patch: 3, prerelease: ['rc', 1], build: ['build', '5'] });
  assert.equal(format(v), '1.2.3-rc.1+build.5');
});

test('strict parsing refuses what the specification refuses', () => {
  for (const bad of ['1.2', '1', '01.1.1', '1.01.1', '1.1.01', '1.1.1-01', '1.1.1-', '1.1.1+', 'v1.2.3', ' 1.2.3', '1.2.3.4', '1.2.3-a..b', '1.2.3-a_b', '', '9007199254740993.0.0'])
    assert.throws(() => parse(bad), InvalidVersion, bad);
  assert.equal(isValid('0.0.0'), true);
  assert.equal(isValid('1.0.0-0A.is.legal'), true);
  assert.equal(isValid('1.0.0-x-y-z.--'), true);
  assert.throws(() => parse('1.0.0-' + 'a'.repeat(300)), /longer than 256/);
});

test('inc and diff', () => {
  assert.equal(inc('1.2.3', 'patch'), '1.2.4');
  assert.equal(inc('1.2.3', 'minor'), '1.3.0');
  assert.equal(inc('1.2.3', 'major'), '2.0.0');
  assert.equal(inc('1.2.3-rc.1', 'patch'), '1.2.3', 'a prerelease patch bump releases it');
  assert.equal(inc('1.2.3', 'prerelease', 'beta'), '1.2.4-beta.0');
  assert.equal(inc('1.2.4-beta.0', 'prerelease'), '1.2.4-beta.1');
  assert.equal(inc('1.2.4-beta', 'prerelease'), '1.2.4-beta.0');
  assert.throws(() => inc('1.0.0', 'prerelease', 'a b'), InvalidVersion);
  assert.equal(diff('1.2.3', '2.0.0'), 'major');
  assert.equal(diff('1.2.3', '1.3.0'), 'minor');
  assert.equal(diff('1.2.3', '1.2.4'), 'patch');
  assert.equal(diff('1.2.3-a', '1.2.3-b'), 'prerelease');
  assert.equal(diff('1.2.3+a', '1.2.3+b'), null);
});

test('caret, tilde and x-ranges match the npm table', () => {
  const rows: [string, string[], string[]][] = [
    ['^1.2.3', ['1.2.3', '1.9.9'], ['1.2.2', '2.0.0']],
    ['^0.2.3', ['0.2.3', '0.2.9'], ['0.3.0', '0.2.2']],
    ['^0.0.3', ['0.0.3'], ['0.0.4', '0.0.2']],
    ['^1.2.x', ['1.2.0', '1.8.0'], ['2.0.0', '1.1.9']],
    ['^0.0.x', ['0.0.0', '0.0.9'], ['0.1.0']],
    ['^0.x', ['0.0.0', '0.9.9'], ['1.0.0']],
    ['~1.2.3', ['1.2.3', '1.2.99'], ['1.3.0', '1.2.2']],
    ['~1.2', ['1.2.0', '1.2.7'], ['1.3.0']],
    ['~1', ['1.0.0', '1.9.9'], ['2.0.0', '0.9.9']],
    ['1.2.x', ['1.2.0', '1.2.9'], ['1.3.0']],
    ['1.x', ['1.0.0', '1.99.0'], ['2.0.0']],
    ['*', ['0.0.0', '99.1.1'], []],
    ['', ['3.4.5'], []],
    ['1.2.3', ['1.2.3'], ['1.2.4']],
    ['=1.2.3', ['1.2.3'], ['1.2.4']],
  ];
  for (const [r, yes, no] of rows) {
    for (const v of yes) assert.equal(satisfies(v, r), true, `${v} in ${r}`);
    for (const v of no) assert.equal(satisfies(v, r), false, `${v} not in ${r}`);
  }
});

test('comparators, partial bounds, hyphen ranges and alternatives', () => {
  assert.equal(satisfies('1.3.0', '>1.2'), true);
  assert.equal(satisfies('1.2.9', '>1.2'), false, '>1.2 means >=1.3.0');
  assert.equal(satisfies('1.2.9', '<=1.2'), true);
  assert.equal(satisfies('1.3.0', '<=1.2'), false);
  assert.equal(satisfies('1.1.9', '<1.2'), true);
  assert.equal(satisfies('1.2.0', '<1.2'), false);
  assert.equal(satisfies('1.5.0', '>=1.2.3 <2'), true);
  assert.equal(satisfies('2.0.0', '>=1.2.3 <2'), false);
  assert.equal(satisfies('1.5.0', '>= 1.2.3 < 2'), true, 'spaces after an operator');
  assert.equal(satisfies('2.3.4', '1.2.3 - 2.3.4'), true);
  assert.equal(satisfies('2.3.5', '1.2.3 - 2.3.4'), false);
  assert.equal(satisfies('2.9.9', '1.2.3 - 2.3'), false);
  assert.equal(satisfies('2.3.9', '1.2.3 - 2.3'), true, 'partial upper bound covers its whole minor');
  assert.equal(satisfies('0.9.0', '1.0.0 || 0.9.x'), true);
  assert.equal(satisfies('1.5.0', '1.0.0 || 0.9.x'), false);
});

test('a prerelease only satisfies a range that names a prerelease of the same version', () => {
  assert.equal(satisfies('1.2.3-beta.2', '^1.2.3-beta.1'), true);
  assert.equal(satisfies('1.2.4-beta.2', '^1.2.3-beta.1'), false, 'other patch, other prerelease');
  assert.equal(satisfies('1.3.0-beta', '^1.2.3'), false);
  assert.equal(satisfies('2.0.0-alpha', '^1.2.3'), false, '<2.0.0-0 keeps 2.0.0 prereleases out');
  assert.equal(satisfies('1.3.0-beta', '^1.2.3', { includePrerelease: true }), true);
  assert.equal(satisfies('1.0.0-rc.1', '*'), false);
  assert.equal(maxSatisfying(['1.0.0', '1.5.0-rc.1', '1.4.0'], '^1.0.0'), '1.4.0');
});

test('maxSatisfying and minSatisfying pick by precedence, not text', () => {
  const all = ['1.2.0', '1.10.0', '1.9.0', '2.0.0', '0.9.0'];
  assert.equal(maxSatisfying(all, '^1.0.0'), '1.10.0');
  assert.equal(minSatisfying(all, '^1.0.0'), '1.2.0');
  assert.equal(maxSatisfying(all, '>=3'), null);
});

test('bad ranges are refused with the offending text', () => {
  for (const bad of ['>=', '1.2.3.4', '^a.b.c', '~', 'latest', '1.2.3 - ', '>>1', '1.2.3-', '99999999999999999999.0.0'])
    assert.throws(() => parseRange(bad), InvalidRange, bad);
  assert.equal(validRange('^1.2.3 || >=4'), true);
  assert.equal(validRange('not a range'), false);
  assert.throws(() => parseRange('1'.repeat(2000)), /too long/);
});

const universe = {
  app: [{ version: '1.0.0', dependencies: { web: '^2.0.0', db: '^1.0.0' } }],
  web: [
    { version: '2.1.0', dependencies: { util: '^3.0.0' } },
    { version: '2.0.0', dependencies: { util: '^2.0.0' } },
    { version: '1.0.0' },
  ],
  db: [{ version: '1.2.0', dependencies: { util: '^2.0.0' } }, { version: '1.1.0', dependencies: { util: '^2.0.0' } }],
  util: [{ version: '3.1.0' }, { version: '2.5.0' }, { version: '2.4.0' }, { version: '3.0.0-rc.1' }],
};

test('the solver backs up from the newest web to the one that agrees with db on util', () => {
  const r = solve(universe, { app: '*' });
  assert.deepEqual(r, { ok: true, chosen: { app: '1.0.0', db: '1.2.0', util: '2.5.0', web: '2.0.0' } });
});

test('the solver prefers the newest of everything when nothing clashes', () => {
  const r = solve(universe, { web: '^2', util: '^3' });
  assert.deepEqual(r, { ok: true, chosen: { util: '3.1.0', web: '2.1.0' } });
});

test('a conflict names the package and every requirement on it', () => {
  const r = solve(universe, { web: '^1.0.0', db: '^1', app: '^9' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.package, 'app');
    assert.match(r.message, /no version of app satisfies \^9 \(from the application\)/);
  }
  const missing = solve(universe, { nothing: '*' });
  assert.equal(missing.ok === false && missing.message, 'nothing is not available');
  const clash = solve({ a: [{ version: '1.0.0', dependencies: { c: '^1' } }], b: [{ version: '1.0.0', dependencies: { c: '^2' } }], c: [{ version: '1.0.0' }, { version: '2.0.0' }] }, { a: '*', b: '*' });
  assert.equal(clash.ok, false);
  if (!clash.ok) {
    assert.equal(clash.package, 'c');
    assert.deepEqual(clash.requirements.map((q) => q.by).sort(), ['a@1.0.0', 'b@1.0.0']);
  }
});

test('the solver stops, with a plain error, rather than run forever', () => {
  const u: Record<string, { version: string; dependencies?: Record<string, string> }[]> = {};
  for (let i = 0; i < 12; i++) u[`p${i}`] = [{ version: '1.0.0', dependencies: { [`p${i + 1}`]: '^1' } }, { version: '1.1.0', dependencies: { [`p${i + 1}`]: '^1' } }];
  u.p12 = [{ version: '1.0.0' }];
  assert.throws(() => solve(u, { p0: '*' }, { maxSteps: 5 }), TooComplex);
});

test('calendar versions parse, validate and compare per segment', () => {
  const c = calver('YYYY.0M.MICRO');
  assert.deepEqual(c.parse('2026.11.3').parts.length, 3, 'MICRO has no padding rule');
  assert.throws(() => c.parse('2026.1.3'), /two digits/);
  assert.throws(() => c.parse('2026.13.0'), /not a month/);
  assert.throws(() => c.parse('26.11.3'), /four digits/);
  assert.throws(() => c.parse('2026.11'), /expected 3 parts/);
  assert.equal(c.compare('2026.11.10', '2026.11.9'), 1, 'micro compares as a number');
  assert.equal(c.compare('2025.12.9', '2026.01.0'), -1);
  assert.equal(c.forDate(new Date('2026-11-28T12:00:00Z'), 4), '2026.11.4');
  const d = calver('YY.MM.DD');
  assert.throws(() => d.parse('26.2.30'), /does not exist/);
  assert.equal(d.parse('24.2.29').parts[2], 29, 'leap day');
  assert.throws(() => calver('YYYY.QQ'), InvalidRange);
});
