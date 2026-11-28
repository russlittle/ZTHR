import assert from 'node:assert/strict';
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
