import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { integrityToHashes, licenceChoice, normaliseLicence, purl, readProject, render, resolveDep, toCycloneDx } from './sbom.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/demo/', import.meta.url));
type Component = { 'bom-ref': string; group?: string; name: string; version: string; scope: string; hashes?: { alg: string; content: string }[]; licenses?: unknown[]; purl: string; properties: { name: string; value: string }[] };
type Doc = { bomFormat: string; specVersion: string; serialNumber: string; metadata: { timestamp?: string; component: { 'bom-ref': string } }; components: Component[]; dependencies: { ref: string; dependsOn: string[] }[] };

const doc = (dir = FIXTURE, ts?: string): Doc => toCycloneDx(readProject(dir), ts ? { timestamp: ts } : {}) as unknown as Doc;
const byRef = (d: Doc, ref: string): Component => {
  const c = d.components.find((x) => x['bom-ref'] === ref);
  assert.ok(c, `no component ${ref}`);
  return c;
};

test('purls encode the scope and version as the purl spec requires', () => {
  assert.equal(purl('@scope/a', '1.0.0'), 'pkg:npm/%40scope/a@1.0.0');
  assert.equal(purl('left-pad', '1.3.0'), 'pkg:npm/left-pad@1.3.0');
});

test('integrity strings become hex hashes, every algorithm kept, nothing invented', () => {
  const sha512 = createHash('sha512').update('x').digest();
  const sha1 = createHash('sha1').update('x').digest();
  assert.deepEqual(integrityToHashes(`sha512-${sha512.toString('base64')} sha1-${sha1.toString('base64')}`), [
    { alg: 'SHA-1', content: sha1.toString('hex') },
    { alg: 'SHA-512', content: sha512.toString('hex') },
  ]);
  assert.deepEqual(integrityToHashes(undefined), []);
  assert.deepEqual(integrityToHashes('md5-abc'), []);
});

test('licence fields in every npm shape become one SPDX expression', () => {
  assert.equal(normaliseLicence('MIT'), 'MIT');
  assert.equal(normaliseLicence({ type: 'ISC' }), 'ISC');
  assert.equal(normaliseLicence(undefined, [{ type: 'MIT' }, { type: 'Apache-2.0' }]), 'MIT OR Apache-2.0');
  assert.equal(normaliseLicence(undefined), undefined);
  assert.deepEqual(licenceChoice('MIT'), [{ license: { id: 'MIT' } }]);
  assert.deepEqual(licenceChoice('(MIT OR GPL-3.0-only)'), [{ expression: '(MIT OR GPL-3.0-only)' }]);
  assert.deepEqual(licenceChoice('SEE LICENSE IN LICENSE.md'), [{ license: { name: 'SEE LICENSE IN LICENSE.md' } }]);
});

test('dependencies resolve the way Node finds them: nearest node_modules first', () => {
  const { packages } = JSON.parse(readFileSync(join(FIXTURE, 'package-lock.json'), 'utf8'));
  assert.equal(resolveDep(packages, 'node_modules/@scope/a', 'b'), 'node_modules/@scope/a/node_modules/b');
  assert.equal(resolveDep(packages, 'node_modules/@scope/a', 'c'), 'node_modules/c');
  assert.equal(resolveDep(packages, '', 'b'), 'node_modules/b');
  assert.equal(resolveDep(packages, 'node_modules/b', 'missing'), undefined);
});

test('the fixture SBOM has every package, its hashes, licences, scopes and the graph', () => {
  const d = doc();
  assert.equal(d.bomFormat, 'CycloneDX');
  assert.equal(d.specVersion, '1.5');
  assert.match(d.serialNumber, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(d.metadata.timestamp, undefined);
  assert.equal(d.metadata.component['bom-ref'], 'pkg:npm/demo@1.2.3');
  assert.deepEqual(d.components.map((c) => c['bom-ref']), [
    'pkg:npm/%40scope/a@1.0.0', 'pkg:npm/b@1.5.0', 'pkg:npm/b@2.0.0', 'pkg:npm/c@1.0.0', 'pkg:npm/devtool@3.0.0', 'pkg:npm/nolic@1.0.0',
  ]);
  const a = byRef(d, 'pkg:npm/%40scope/a@1.0.0');
  assert.equal(a.group, '@scope');
  assert.equal(a.name, 'a');
  assert.deepEqual(a.hashes, [{ alg: 'SHA-512', content: createHash('sha512').update('a').digest('hex') }]);
  assert.deepEqual(a.licenses, [{ license: { id: 'MIT' } }]);
  assert.equal(a.scope, 'required');
  assert.deepEqual(byRef(d, 'pkg:npm/b@1.5.0').hashes?.map((h) => h.alg), ['SHA-1', 'SHA-512']);
  assert.equal(byRef(d, 'pkg:npm/c@1.0.0').scope, 'optional');
  const dev = byRef(d, 'pkg:npm/devtool@3.0.0');
  assert.equal(dev.scope, 'excluded');
  assert.ok(dev.properties.some((p) => p.name === 'cdx:npm:package:development' && p.value === 'true'));
  const nolic = byRef(d, 'pkg:npm/nolic@1.0.0');
  assert.equal(nolic.licenses, undefined);
  assert.ok(nolic.properties.some((p) => p.name === 'zthr:licence:source' && p.value === 'none'));
  const edges = Object.fromEntries(d.dependencies.map((x) => [x.ref, x.dependsOn]));
  assert.deepEqual(edges['pkg:npm/demo@1.2.3'], ['pkg:npm/%40scope/a@1.0.0', 'pkg:npm/b@2.0.0', 'pkg:npm/devtool@3.0.0', 'pkg:npm/nolic@1.0.0']);
  assert.deepEqual(edges['pkg:npm/%40scope/a@1.0.0'], ['pkg:npm/b@1.5.0', 'pkg:npm/c@1.0.0']);
  assert.deepEqual(edges['pkg:npm/b@2.0.0'], ['pkg:npm/c@1.0.0']);
  assert.deepEqual(edges['pkg:npm/c@1.0.0'], []);
});

test('output is deterministic: same bytes every run, independent of key order; a timestamp only when passed', () => {
  assert.equal(render(doc() as unknown as Record<string, unknown>), render(doc() as unknown as Record<string, unknown>));
  const tmp = mkdtempSync(join(tmpdir(), 'sbom-test-'));
  try {
    const lock = JSON.parse(readFileSync(join(FIXTURE, 'package-lock.json'), 'utf8'));
    const reversed = { ...lock, packages: Object.fromEntries(Object.entries(lock.packages).reverse()) };
    writeFileSync(join(tmp, 'package-lock.json'), JSON.stringify(reversed));
    cpSync(join(FIXTURE, 'package.json'), join(tmp, 'package.json'));
    assert.equal(render(doc(tmp) as unknown as Record<string, unknown>), render(doc() as unknown as Record<string, unknown>));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const stamped = doc(FIXTURE, '2026-11-27T00:00:00Z');
  assert.equal(stamped.metadata.timestamp, '2026-11-27T00:00:00.000Z');
  assert.notEqual(stamped.serialNumber, doc().serialNumber);
});

test('a licence missing from the lockfile is read from the installed package.json', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sbom-test-'));
  try {
    cpSync(FIXTURE, tmp, { recursive: true });
    mkdirSync(join(tmp, 'node_modules', 'nolic'), { recursive: true });
    writeFileSync(join(tmp, 'node_modules', 'nolic', 'package.json'), JSON.stringify({ name: 'nolic', version: '1.0.0', license: 'BSD-2-Clause' }));
    const c = byRef(doc(tmp), 'pkg:npm/nolic@1.0.0');
    assert.deepEqual(c.licenses, [{ license: { id: 'BSD-2-Clause' } }]);
    assert.ok(c.properties.some((p) => p.name === 'zthr:licence:source' && p.value === 'package.json'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a project with no lockfile is an SBOM of itself, unless it declares dependencies it does not pin', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sbom-test-'));
  try {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'solo', version: '0.1.0', license: 'Apache-2.0' }));
    const d = doc(tmp);
    assert.deepEqual(d.components, []);
    assert.deepEqual(d.dependencies, [{ ref: 'pkg:npm/solo@0.1.0', dependsOn: [] }]);
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'solo', version: '0.1.0', dependencies: { x: '1' } }));
    assert.throws(() => readProject(tmp), /no package-lock.json to pin them/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
