import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { compare, expiry, review, sarif, triage } from './index.ts';

test('versions compare numerically, with prereleases first', () => {
  assert.equal(compare('1.10.0', '1.9.9'), 1);
  assert.equal(compare('v2.0.0', '2.0'), 0);
  assert.equal(compare('2.0.0-rc.1', '2.0.0'), -1);
});

test('dependencies get a verdict and a reason, worst first', () => {
  const r = review(
    [{ name: 'tar', version: '6.1.0', latest: '7.4.3' }, { name: 'ms', version: '2.1.2', latest: '2.1.3' }, { name: 'semver', version: '7.5.1', latest: '7.6.3' }, { name: 'ws', version: '8.17.1', latest: '8.18.0' }],
    [{ package: 'tar', id: 'GHSA-tar-1', severity: 'high', fixedIn: '6.2.1' }, { package: 'semver', id: 'GHSA-sem-1', severity: 'moderate', fixedIn: '7.5.2' }, { package: 'ws', id: 'GHSA-ws-1', severity: 'high', fixedIn: '8.17.1' }],
    { today: '2026-11-26' },
  );
  assert.deepEqual(r, [
    { name: 'tar', verdict: 'urgent', because: 'GHSA-tar-1 (high) is fixed in 6.2.1' },
    { name: 'semver', verdict: 'update', because: 'GHSA-sem-1 fixed in 7.5.2' },
    { name: 'ms', verdict: 'fine', because: 'minor update to 2.1.3 available' },
    { name: 'ws', verdict: 'fine', because: 'minor update to 8.18.0 available' },
  ]);
});

test('expiring things warn at set points and every day once expired', () => {
  const e = expiry([{ what: 'files.example.org TLS', kind: 'certificate', expires: '2026-12-10', owner: 'ops' }, { what: 'deploy token', kind: 'token', expires: '2026-11-20', owner: 'ana' }, { what: 'domain', kind: 'domain', expires: '2027-06-01', owner: 'ops' }], '2026-11-26');
  assert.deepEqual(e.map((x) => [x.what, x.daysLeft, x.warn, x.state]), [['deploy token', -6, true, 'expired'], ['files.example.org TLS', 14, true, 'soon'], ['domain', 187, false, 'ok']]);
  assert.equal(expiry([{ what: 'x', kind: 'key', expires: '2026-12-09', owner: 'o' }], '2026-11-26')[0]!.warn, false, '13 days is not a warning day');
});

test('SARIF findings keep their fingerprint when code moves, and accepted ones stay accepted', () => {
  const log = (line: number, extra = false) => ({ runs: [{ tool: { driver: { name: 'semgrep' } }, results: [{ ruleId: 'xss', level: 'error', message: { text: 'unescaped output' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/page.ts' }, region: { startLine: line, snippet: { text: 'res.write(name)' } } } }] }, ...(extra ? [{ ruleId: 'sqli', message: { text: 'string-built query' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/db.ts' }, region: { startLine: 3 } } }] }] : [])] }] });
  const a = sarif(log(10));
  const b = sarif(log(42, true));
  assert.equal(a[0]!.fingerprint, b[0]!.fingerprint);
  const t = triage(b, a, { [a[0]!.fingerprint]: 'name is escaped by the template layer' });
  assert.deepEqual(t.new.map((f) => f.rule), ['sqli']);
  assert.deepEqual(triage(b, a, {}).open.map((f) => f.rule), ['xss'], 'seen before and not accepted: still open, not new');
  assert.equal(t.accepted[0]!.why, 'name is escaped by the template layer');
  assert.deepEqual(triage([], a, {}).fixed.map((f) => f.rule), ['xss']);
  assert.deepEqual(sarif({}), []);
});

test('prerelease precedence follows SemVer 2.0.0 §11; build metadata is ignored', () => {
  const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 0; i + 1 < order.length; i++) {
    assert.equal(compare(order[i]!, order[i + 1]!), -1, `${order[i]} < ${order[i + 1]}`);
    assert.equal(compare(order[i + 1]!, order[i]!), 1, `${order[i + 1]} > ${order[i]}`);
  }
  assert.equal(compare('2.0.0-rc.10', '2.0.0-rc.2'), 1);
  assert.equal(compare('1.0.0-x-y', '1.0.0-x'), 1, 'a hyphen inside a prerelease is part of it');
  assert.equal(compare('1.0.0-Beta', '1.0.0-alpha'), -1, 'identifiers compare in ASCII order');
  assert.equal(compare('1.2.3+build.5', '1.2.3'), 0);
  assert.equal(compare('1.2.4+build', '1.2.3'), 1);
});

test('an update clears every advisory that hits the version', () => {
  const r = review([{ name: 'qs', version: '6.0.0', latest: '6.9.0' }], [{ package: 'qs', id: 'A', severity: 'low', fixedIn: '6.2.0' }, { package: 'qs', id: 'B', severity: 'moderate', fixedIn: '6.5.3' }], { today: '2026-11-26' });
  assert.deepEqual(r, [{ name: 'qs', verdict: 'update', because: 'A, B fixed in 6.5.3' }]);
});

test('an expiry with a time of day is read, and one that cannot be read is refused rather than called ok', () => {
  const e = expiry([{ what: 'TLS', kind: 'certificate', expires: '2026-12-10T12:00:00Z', owner: 'ops' }], '2026-11-26');
  assert.deepEqual([e[0]!.daysLeft, e[0]!.state], [15, 'soon']);
  assert.throws(() => expiry([{ what: 'key', kind: 'key', expires: 'soon', owner: 'ops' }], '2026-11-26'), /key/);
});

test('two findings with the same rule, file and text are two findings: accepting one does not hide the other', () => {
  const res = (line: number) => ({ ruleId: 'sqli', message: { text: 'string-built query' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/db.ts' }, region: { startLine: line } } }] });
  const before = sarif({ runs: [{ tool: { driver: { name: 'semgrep' } }, results: [res(3)] }] });
  const now = sarif({ runs: [{ tool: { driver: { name: 'semgrep' } }, results: [res(3), res(40)] }] });
  assert.equal(new Set(now.map((f) => f.fingerprint)).size, 2);
  const t = triage(now, before, { [before[0]!.fingerprint]: 'the input is a constant' });
  assert.deepEqual(t.new.map((f) => f.line), [40]);
  assert.deepEqual(t.accepted.map((f) => f.line), [3]);
});

const fp = (...parts: string[]) => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);

test('a version is read with stray spaces and a leading v, and a v inside a prerelease stays', () => {
  assert.equal(compare(' 1.0.0-rc ', '1.0.0-rc'), 0);
  assert.equal(compare(' v2.1.0', '2.0.0'), 1);
  assert.equal(compare('V2.0.0', '2.0.0'), 0);
  assert.equal(compare('v2.1.0', '2.0'), 1);
  assert.equal(compare('v3.0.0', '2.9.9'), 1, 'the v is not part of the first number');
  assert.equal(compare('v1.0.0', 'v2.0.0'), -1);
  assert.equal(compare('1.0.0-dev', '1.0.0-de'), 1);
});

test('versions with a different number of parts compare as if padded with zeros', () => {
  assert.equal(compare('1.0', '1.0.1'), -1);
  assert.equal(compare('1.2.3.4', '1.2.3'), 1);
  assert.equal(compare('1.0', '1.0.0'), 0);
});

test('a bare prerelease has a core of zero', () => {
  assert.equal(compare('-rc.1', '0.0.0-rc.1'), 0);
  assert.equal(compare('-alpha', '-beta'), -1);
  assert.equal(compare('-alpha', '0.0.0'), -1);
});

test('equal prereleases are equal', () => {
  assert.equal(compare('1.0.0-rc.1', '1.0.0-rc.1'), 0);
  assert.equal(compare('1.0.0-a', '1.0.0-a'), 0);
});

test('numeric prerelease identifiers compare as numbers whatever their length; mixed ones are alphanumeric', () => {
  assert.equal(compare('1.0.0-2', '1.0.0-10'), -1);
  assert.equal(compare('1.0.0-100', '1.0.0-20'), 1);
  assert.equal(compare('1.0.0-20', '1.0.0-100'), -1);
  assert.equal(compare('1.0.0-99999999999999999999', '1.0.0-99999999999999999998'), 1);
  assert.equal(compare('1.0.0-a1', '1.0.0-2'), 1);
  assert.equal(compare('1.0.0-2', '1.0.0-a1'), -1);
  assert.equal(compare('1.0.0-1a', '1.0.0-2'), 1);
  assert.equal(compare('1.0.0-2', '1.0.0-1a'), -1);
  assert.equal(compare('1.0.0-1', '1.0.0--x'), -1, 'numeric sorts before alphanumeric even when ASCII says otherwise');
  assert.equal(compare('1.0.0--x', '1.0.0-1'), 1);
});

test('an advisory applies from the version it was introduced in, up to but not including the fix', () => {
  const dep = (version: string) => [{ name: 'x', version, latest: version }];
  const adv = [{ package: 'x', id: 'A', severity: 'high' as const, fixedIn: '2.0.0', introducedIn: '1.5.0' }];
  assert.deepEqual(review(dep('1.4.9'), adv).map((r) => r.verdict), ['fine'], 'before it was introduced');
  assert.deepEqual(review(dep('1.5.0'), adv), [{ name: 'x', verdict: 'urgent', because: 'A (high) is fixed in 2.0.0' }], 'the version it was introduced in');
  assert.deepEqual(review(dep('1.9.9'), adv).map((r) => r.verdict), ['urgent']);
  assert.deepEqual(review(dep('2.0.0'), adv), [{ name: 'x', verdict: 'fine', because: 'current' }], 'the fixed version is clear');
});

test('a critical advisory is urgent, a low one only an update', () => {
  const dep = [{ name: 'x', version: '1.0.0', latest: '1.0.0' }];
  assert.deepEqual(review(dep, [{ package: 'x', id: 'C', severity: 'critical', fixedIn: '1.0.1' }]), [{ name: 'x', verdict: 'urgent', because: 'C (critical) is fixed in 1.0.1' }]);
  assert.deepEqual(review(dep, [{ package: 'x', id: 'L', severity: 'low', fixedIn: '1.0.1' }]), [{ name: 'x', verdict: 'update', because: 'L fixed in 1.0.1' }]);
});

test('an update is as far as the latest fix among the advisories, whatever their order; on a tie the first named', () => {
  const dep = [{ name: 'qs', version: '6.0.0', latest: '6.9.0' }];
  const a = (id: string, fixedIn: string) => ({ package: 'qs', id, severity: 'low' as const, fixedIn });
  assert.equal(review(dep, [a('B', '6.5.3'), a('A', '6.2.0')])[0]!.because, 'B, A fixed in 6.5.3');
  assert.equal(review(dep, [a('A', '6.2'), a('B', '6.2.0')])[0]!.because, 'A, B fixed in 6.2');
});

test('an update that clears a prerelease names the version the advisory gives, not zero', () => {
  const r = review([{ name: 'x', version: '0.0.0-1', latest: '0.0.0' }], [{ package: 'x', id: 'A', severity: 'low', fixedIn: '0.0.0' }]);
  assert.equal(r[0]!.because, 'A fixed in 0.0.0');
});

test('a dependency a major version behind needs an update unless that is switched off', () => {
  const r = review([{ name: 'old', version: '1.9.9', latest: '2.0.0' }, { name: 'ten', version: '9.0.0', latest: '10.0.0' }, { name: 'same', version: '10.2.0', latest: '10.5.0' }, { name: 'cur', version: '3.1.0', latest: '3.1.0' }, { name: 'ahead', version: '3.2.0', latest: '3.1.0' }], []);
  assert.deepEqual(r, [
    { name: 'old', verdict: 'update', because: 'a major version behind (1.9.9 → 2.0.0)' },
    { name: 'ten', verdict: 'update', because: 'a major version behind (9.0.0 → 10.0.0)' },
    { name: 'ahead', verdict: 'fine', because: 'current' },
    { name: 'cur', verdict: 'fine', because: 'current' },
    { name: 'same', verdict: 'fine', because: 'minor update to 10.5.0 available' },
  ]);
  for (const staleMajor of [true, undefined]) assert.equal(review([{ name: 'old', version: '1.9.9', latest: '2.0.0' }], [], { today: '2026-11-26', ...(staleMajor === undefined ? {} : { staleMajor }) })[0]!.verdict, 'update');
  assert.deepEqual(review([{ name: 'old', version: '1.9.9', latest: '2.0.0' }], [], { today: '2026-11-26', staleMajor: false }), [{ name: 'old', verdict: 'fine', because: 'minor update to 2.0.0 available' }]);
});

test('the worst come first whatever order they arrive in, and alike ones by name', () => {
  const deps = ['f2', 'p2', 'u2', 'f1', 'p1', 'u1'].map((name) => ({ name, version: name.startsWith('p') ? '1.0.0' : '2.0.0', latest: name.startsWith('p') ? '2.0.0' : '2.0.0' }));
  const advisories = ['u1', 'u2'].map((package_) => ({ package: package_, id: `X-${package_}`, severity: 'high' as const, fixedIn: '3.0.0' }));
  const want = ['u1', 'u2', 'p1', 'p2', 'f1', 'f2'];
  for (const order of [deps, [...deps].reverse(), [...deps.slice(2), ...deps.slice(0, 2)], [deps[4]!, deps[1]!, deps[3]!, deps[0]!, deps[5]!, deps[2]!]]) {
    assert.deepEqual(review(order, advisories).map((r) => r.name), want);
  }
  assert.deepEqual(review(deps, advisories).map((r) => r.verdict), ['urgent', 'urgent', 'update', 'update', 'fine', 'fine']);
});

test('a thing expiring today is expired; the warning window starts at its widest point', () => {
  const one = (expires: string, warnAt?: number[]) => expiry([{ what: 'x', kind: 'key', expires, owner: 'o' }], '2026-11-26', warnAt)[0]!;
  assert.deepEqual([one('2026-11-26').daysLeft, one('2026-11-26').state, one('2026-11-26').warn], [0, 'expired', true]);
  assert.deepEqual([one('2026-11-27').daysLeft, one('2026-11-27').state, one('2026-11-27').warn], [1, 'soon', true]);
  assert.deepEqual([one('2026-12-26').daysLeft, one('2026-12-26').state, one('2026-12-26').warn], [30, 'soon', true]);
  assert.deepEqual([one('2026-12-27').daysLeft, one('2026-12-27').state, one('2026-12-27').warn], [31, 'ok', false]);
  assert.deepEqual([one('2026-12-06', [10]).state, one('2026-12-06', [10]).warn], ['soon', true]);
  assert.deepEqual([one('2026-12-07', [10]).state, one('2026-12-07', [10]).warn], ['ok', false]);
  assert.equal(one('2026-12-05', [10]).warn, false, 'inside the window but not a warning day');
  assert.equal(one('2026-12-05', [10]).state, 'soon');
  assert.equal(one('2026-11-26T12:00:00Z').daysLeft, 1, 'part of a day left counts as a day');
});

test('an expiry that is not a date or a full date and time is refused, never read leniently', () => {
  const read = (expires: string) => expiry([{ what: 'k', kind: 'key', expires, owner: 'o' }], '2026-11-26')[0]!.daysLeft;
  for (const bad of ['abcd-12-10', '2026-1-05', '2026-12-1', '2026-12-10 ', ' 2026-12-10', '12026-12-10', 'on 2026-12-10', '12/10/2026', 'Dec 10 2026', '2026-12-10T', '2026-13-01', '']) {
    assert.throws(() => read(bad), /cannot read the expiry/, JSON.stringify(bad));
  }
  assert.equal(read('2026-12-10'), 14);
  assert.equal(read('2026-12-10T00:00:00Z'), 14);
  assert.equal(read('2026-12-10T12:00Z'), 15);
  assert.equal(read('2026-12-10T12:00:00.123Z'), 15, 'fractions of a second can have any number of digits');
  assert.equal(read('2026-12-10T12:00:00.5+02:00'), 15, 'the offset is honoured: 10:00 UTC');
  assert.equal(read('2026-12-10T01:00:00+02:00'), 14, 'the offset is honoured: 23:00 UTC the day before');
  assert.equal(read('2026-12-10T12:00:00'), 15, 'a time with no offset is UTC, not the machine\'s zone');
});

test('a finding with nothing to go on still gets its defaults, and a bad log shape does not throw', () => {
  assert.deepEqual(sarif({ runs: [{ results: [{}] }] }), [{ fingerprint: fp('unknown', 'unknown', '', ''), rule: 'unknown', level: 'warning', file: '', line: 0, message: '', tool: 'unknown' }]);
  assert.equal(sarif({ runs: [{ tool: {}, results: [{}] }] })[0]!.tool, 'unknown');
  assert.equal(sarif({ runs: [{ tool: { driver: {} }, results: [{}] }] })[0]!.tool, 'unknown');
  assert.equal(sarif({ runs: [{ results: [{ locations: [] }] }] })[0]!.file, '');
  assert.deepEqual(sarif({ runs: [{ results: [{ locations: [{ physicalLocation: { region: { startLine: 5 } } }] }] }] }).map((f) => [f.file, f.line]), [['', 5]]);
  assert.deepEqual(sarif({ runs: [{ results: [{ locations: [{ physicalLocation: { artifactLocation: { uri: 'a.ts' } } }] }] }] }).map((f) => [f.file, f.line]), [['a.ts', 0]]);
  assert.deepEqual(sarif({ runs: [{ results: [{ locations: [{}] }] }] }).map((f) => [f.file, f.line]), [['', 0]]);
  assert.deepEqual(sarif({ runs: [{}] }), []);
});

test('a finding reports what the scanner gave and is fingerprinted by tool, rule, file and snippet or message', () => {
  const log = (extra: object) => ({ runs: [{ tool: { driver: { name: 'semgrep' } }, results: [{ ruleId: 'xss', level: 'error', message: { text: 'unescaped output' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/page.ts' }, region: { startLine: 7, ...extra } } }] }] }] });
  const [a] = sarif(log({ snippet: { text: '  res.write(name)\n' } }));
  assert.deepEqual(a, { fingerprint: fp('semgrep', 'xss', 'src/page.ts', 'res.write(name)'), rule: 'xss', level: 'error', file: 'src/page.ts', line: 7, message: 'unescaped output', tool: 'semgrep' });
  const [m] = sarif(log({}));
  assert.equal(m!.fingerprint, fp('semgrep', 'xss', 'src/page.ts', 'unescaped output'), 'no snippet: the message stands in');
  assert.notEqual(m!.fingerprint, a!.fingerprint);
  const other = sarif({ runs: [{ tool: { driver: { name: 'semgrep' } }, results: [{ ruleId: 'xss', message: { text: 'something else' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/page.ts' } } }] }] }] });
  assert.notEqual(other[0]!.fingerprint, m!.fingerprint, 'a different message is a different finding');
  assert.equal(other[0]!.level, 'warning');
});

test('findings alike in everything but line are numbered in line order, however the scanner listed them', () => {
  const res = (line: number) => ({ ruleId: 'sqli', message: { text: 'string-built query' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/db.ts' }, region: { startLine: line } } }] });
  const base = fp('semgrep', 'sqli', 'src/db.ts', 'string-built query');
  const out = sarif({ runs: [{ tool: { driver: { name: 'semgrep' } }, results: [res(40), res(3), res(20)] }] });
  const by = Object.fromEntries(out.map((f) => [f.line, f.fingerprint]));
  assert.deepEqual(by, { 3: base, 20: fp(`${base}#1`), 40: fp(`${base}#2`) });
  assert.deepEqual(out.map((f) => f.line), [40, 3, 20], 'the scanner order is kept');
});

test('triage: a finding already accepted when first seen is accepted, not new; one still present is not fixed', () => {
  const f = (rule: string): Parameters<typeof triage>[0][number] => ({ fingerprint: fp(rule), rule, level: 'warning', file: 'f', line: 1, message: rule, tool: 't' });
  const t = triage([f('a'), f('b'), f('c')], [f('a'), f('d')], { [f('c').fingerprint]: 'known' });
  assert.deepEqual(t.new.map((x) => x.rule), ['b']);
  assert.deepEqual(t.open.map((x) => x.rule), ['a']);
  assert.deepEqual(t.accepted.map((x) => [x.rule, x.why]), [['c', 'known']]);
  assert.deepEqual(t.fixed.map((x) => x.rule), ['d']);
  assert.deepEqual(triage([f('a')], [f('a')], { [f('a').fingerprint]: 'ok' }).open, [], 'accepted and seen before is not open either');
});

test('an expiry on a day the calendar does not have is refused, not rolled into the next month', () => {
  for (const expires of ['2026-02-30', '2026-02-29T10:00Z', '2026-04-31', '2026-13-01']) {
    assert.throws(() => expiry([{ what: 'cert', kind: 'certificate', expires, owner: 'ana' }], '2026-01-01'), /cannot read the expiry/, expires);
  }
  assert.equal(expiry([{ what: 'cert', kind: 'certificate', expires: '2028-02-29', owner: 'ana' }], '2028-02-28')[0]!.daysLeft, 1);
});
