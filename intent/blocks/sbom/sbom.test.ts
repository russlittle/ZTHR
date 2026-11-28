import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parsePurl, formatPurl, parseCycloneDx, writeCycloneDx, parseSpdx, writeSpdx, matchAdvisories, applyVex, parseVex, writeVex, diffSboms, failing, fromUpkeep, inRanges, SbomError } from './index.ts';
import type { Vuln } from './index.ts';

const sha = createHash('sha256').update('lodash').digest('hex');
const cdx = () => ({
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: 'urn:uuid:3e671687-395b-41f5-a30f-a58921a69b79',
  metadata: { timestamp: '2026-01-02T03:04:05Z', tools: { components: [{ type: 'application', name: 'scanner' }] }, component: { type: 'application', 'bom-ref': 'app', name: 'shop', version: '1.0.0' } },
  components: [
    { type: 'library', 'bom-ref': 'lodash', name: 'lodash', version: '4.17.20', purl: 'pkg:npm/lodash@4.17.20', licenses: [{ license: { id: 'MIT' } }], hashes: [{ alg: 'SHA-256', content: sha.toUpperCase() }], components: [{ type: 'library', 'bom-ref': 'nested', name: 'inner', version: '1.0.0', purl: 'pkg:npm/%40scope/inner@1.0.0' }] },
    { type: 'library', 'bom-ref': 'express', name: 'express', version: '4.18.0', purl: 'pkg:npm/express@4.18.0', licenses: [{ expression: 'MIT OR Apache-2.0' }] },
  ],
  dependencies: [{ ref: 'app', dependsOn: ['express'] }, { ref: 'express', dependsOn: ['lodash'] }, { ref: 'lodash', dependsOn: ['nested'] }],
});

test('purl parse and format round trip with encoding and normalisation', () => {
  const p = parsePurl('pkg:npm/%40Scope/Name@1.2.3?Arch=x86&os=linux#src/a b');
  assert.deepEqual(p, { type: 'npm', namespace: '@scope', name: 'name', version: '1.2.3', qualifiers: { arch: 'x86', os: 'linux' }, subpath: 'src/a b' });
  assert.equal(formatPurl(p), 'pkg:npm/%40scope/name@1.2.3?arch=x86&os=linux#src/a%20b');
  assert.equal(formatPurl(parsePurl(formatPurl(p))), formatPurl(p));
});

test('purl tolerates an unencoded npm scope and lower-cases pypi names', () => {
  assert.equal(formatPurl(parsePurl('pkg:npm/@angular/core@16.0.0')), 'pkg:npm/%40angular/core@16.0.0');
  assert.equal(parsePurl('pkg:pypi/Django_Rest@3.0').name, 'django-rest');
  assert.equal(parsePurl('pkg:maven/org.apache/commons-lang3@3.12.0').namespace, 'org.apache');
  assert.equal(parsePurl('pkg:golang/github.com/gorilla/mux@v1.8.0').namespace, 'github.com/gorilla');
});

test('bad purls are refused', () => {
  for (const bad of ['npm/lodash', 'pkg:lodash', 'pkg:/', 'pkg:NPM$/x', 'pkg:npm/%zz', 'pkg:npm/a?b', 'pkg:npm/a%00b', `pkg:npm/${'x'.repeat(3000)}`]) assert.throws(() => parsePurl(bad), SbomError, bad.slice(0, 30));
  assert.throws(() => formatPurl({ type: 'Bad Type', name: 'x' }), SbomError);
});

test('CycloneDX parse: nested components, licenses, hashes, graph, root', () => {
  const s = parseCycloneDx(cdx());
  assert.equal(s.format, 'cyclonedx');
  assert.equal(s.root, 'app');
  assert.equal(s.tool, 'scanner');
  assert.deepEqual(s.components.map((c) => c.ref), ['lodash', 'nested', 'express']);
  assert.deepEqual(s.components[0]!.licenses, ['MIT']);
  assert.deepEqual(s.components[0]!.hashes, [{ alg: 'SHA-256', value: sha }]);
  assert.deepEqual(s.components[2]!.licenses, ['MIT OR Apache-2.0']);
  assert.deepEqual(s.dependencies['express'], ['lodash']);
  assert.equal(s.components[1]!.purl, 'pkg:npm/%40scope/inner@1.0.0');
});

test('CycloneDX parse accepts a JSON string and refuses wrong formats, versions, duplicates and junk', () => {
  assert.equal(parseCycloneDx(JSON.stringify(cdx())).components.length, 3);
  assert.throws(() => parseCycloneDx('{not json'), SbomError);
  assert.throws(() => parseCycloneDx({ ...cdx(), bomFormat: 'SPDX' }), /not a CycloneDX/);
  assert.throws(() => parseCycloneDx({ ...cdx(), specVersion: '1.2' }), /not supported/);
  assert.throws(() => parseCycloneDx([]), SbomError);
  const dup = cdx();
  dup.components.push({ ...dup.components[1]! });
  assert.throws(() => parseCycloneDx(dup), /two components/);
  assert.throws(() => parseCycloneDx({ ...cdx(), components: [{ type: 'library' }] }), /no name/);
});

test('CycloneDX parse refuses absurd nesting', () => {
  let c: Record<string, unknown> = { name: 'leaf' };
  for (let i = 0; i < 60; i++) c = { name: `n${i}`, components: [c] };
  assert.throws(() => parseCycloneDx({ ...cdx(), components: [c] }), /nested too deeply/);
});

test('CycloneDX write then parse keeps the model, with injected clock and serial', () => {
  const s = parseCycloneDx(cdx());
  const out = writeCycloneDx({ ...s, created: undefined, serial: undefined } as never, { now: () => new Date('2026-05-06T07:08:09Z'), serial: () => 'fixed-serial' });
  assert.equal(out.serialNumber, 'urn:uuid:fixed-serial');
  assert.equal((out.metadata as { timestamp: string }).timestamp, '2026-05-06T07:08:09.000Z');
  const back = parseCycloneDx(out);
  assert.deepEqual(back.components.map((c) => [c.ref, c.version, c.purl, c.licenses]), s.components.map((c) => [c.ref, c.version, c.purl, c.licenses]));
  assert.deepEqual(back.dependencies, Object.fromEntries(Object.entries(s.dependencies).sort()));
  assert.equal(back.root, 'app');
});

const spdx = () => ({
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: 'shop',
  documentNamespace: 'https://example.invalid/spdx/abc',
  creationInfo: { created: '2026-01-02T03:04:05Z', creators: ['Tool: scanner-1'] },
  packages: [
    { SPDXID: 'SPDXRef-app', name: 'shop', versionInfo: '1.0.0', licenseConcluded: 'NOASSERTION' },
    { SPDXID: 'SPDXRef-lodash', name: 'lodash', versionInfo: '4.17.20', licenseConcluded: 'MIT', supplier: 'Organization: Lodash Team', checksums: [{ algorithm: 'SHA256', checksumValue: sha }], externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: 'pkg:npm/lodash@4.17.20' }] },
  ],
  relationships: [{ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: 'SPDXRef-app' }, { spdxElementId: 'SPDXRef-app', relationshipType: 'DEPENDS_ON', relatedSpdxElement: 'SPDXRef-lodash' }],
});

test('SPDX parse: purl refs, licenses, checksums, describes and depends-on', () => {
  const s = parseSpdx(spdx());
  assert.equal(s.root, 'SPDXRef-app');
  assert.equal(s.tool, 'scanner-1');
  assert.deepEqual(s.dependencies, { 'SPDXRef-app': ['SPDXRef-lodash'] });
  const l = s.components[1]!;
  assert.equal(l.purl, 'pkg:npm/lodash@4.17.20');
  assert.deepEqual(l.licenses, ['MIT']);
  assert.equal(l.supplier, 'Lodash Team');
  assert.deepEqual(s.components[0]!.licenses, []);
});

test('SPDX parse refuses wrong versions, missing ids and duplicates', () => {
  assert.throws(() => parseSpdx({ ...spdx(), spdxVersion: 'SPDX-3.0' }), SbomError);
  assert.throws(() => parseSpdx({ ...spdx(), packages: [{ name: 'x' }] }), /SPDXID/);
  assert.throws(() => parseSpdx({ ...spdx(), packages: [spdx().packages[0], spdx().packages[0]] }), /two packages/);
});

test('SPDX write then parse round-trips, and CycloneDX converts to SPDX and back', () => {
  const s = parseSpdx(spdx());
  const back = parseSpdx(writeSpdx(s, { now: () => new Date('2026-01-01T00:00:00Z'), namespace: () => 'https://example.invalid/x' }));
  assert.deepEqual(back.components.map((c) => [c.name, c.version, c.purl, c.licenses, c.hashes]), s.components.map((c) => [c.name, c.version, c.purl, c.licenses, c.hashes]));
  assert.deepEqual(back.dependencies, s.dependencies);
  const viaSpdx = parseSpdx(writeSpdx(parseCycloneDx(cdx())));
  assert.equal(viaSpdx.components.length, 4);
  assert.equal(viaSpdx.components.find((c) => c.name === 'express')!.purl, 'pkg:npm/express@4.18.0');
  assert.equal(viaSpdx.components.find((c) => c.ref === viaSpdx.root)!.name, 'shop');
});

const vulns: Vuln[] = [
  { id: 'GHSA-lodash-1', aliases: ['CVE-2021-23337'], severity: 'high', package: { type: 'npm', name: 'lodash' }, ranges: [{ introduced: '0', fixed: '4.17.21' }], summary: 'command injection' },
  { id: 'GHSA-inner-1', severity: 'low', package: { type: 'npm', namespace: '@scope', name: 'inner' }, ranges: [{ introduced: '1.0.0', lastAffected: '1.0.5' }] },
  { id: 'GHSA-express-9', severity: 'critical', package: { type: 'npm', name: 'express' }, ranges: [{ introduced: '5.0.0', fixed: '5.0.2' }] },
  { id: 'GHSA-listed', severity: 'moderate', package: { type: 'npm', name: 'express' }, versions: ['4.18.0'] },
];

test('matching uses ranges, lastAffected and listed versions, ordered by severity', () => {
  const f = matchAdvisories(parseCycloneDx(cdx()), vulns);
  assert.deepEqual(f.map((x) => x.vuln), ['GHSA-lodash-1', 'GHSA-listed', 'GHSA-inner-1']);
  assert.equal(f[0]!.fixedIn, '4.17.21');
  assert.deepEqual(f[0]!.aliases, ['CVE-2021-23337']);
});

test('findings say direct or transitive with a shortest path from the root', () => {
  const f = matchAdvisories(parseCycloneDx(cdx()), vulns);
  const byId = Object.fromEntries(f.map((x) => [x.vuln, x]));
  assert.equal(byId['GHSA-listed']!.via, 'direct');
  assert.equal(byId['GHSA-lodash-1']!.via, 'transitive');
  assert.deepEqual(byId['GHSA-lodash-1']!.path, ['app', 'express', 'lodash']);
  assert.deepEqual(byId['GHSA-inner-1']!.path, ['app', 'express', 'lodash', 'nested']);
  const noGraph = matchAdvisories({ ...parseCycloneDx(cdx()), root: undefined, dependencies: {} } as never, vulns);
  assert.ok(noGraph.every((x) => x.via === 'unknown'));
});

test('version range edges and the upkeep adapter', () => {
  assert.equal(inRanges('4.17.21', { ranges: [{ fixed: '4.17.21' }] }), false);
  assert.equal(inRanges('4.17.20', { ranges: [{ fixed: '4.17.21' }] }), true);
  assert.equal(inRanges('1.0.0-rc.1', { ranges: [{ introduced: '1.0.0', fixed: '2.0.0' }] }), false);
  assert.equal(inRanges('3.0.0', { ranges: [{ introduced: '1.0.0' }] }), true);
  const v = fromUpkeep({ package: '@scope/inner', id: 'ADV-1', severity: 'critical', fixedIn: '1.0.9', introducedIn: '1.0.0' });
  assert.deepEqual(v.package, { type: 'npm', namespace: '@scope', name: 'inner' });
  assert.equal(matchAdvisories(parseCycloneDx(cdx()), [v]).length, 1);
  assert.equal(failing(matchAdvisories(parseCycloneDx(cdx()), [...vulns, v]), 'high').length, 2);
});

test('VEX not_affected and fixed remove findings, affected keeps them, a later statement wins', () => {
  const f = matchAdvisories(parseCycloneDx(cdx()), vulns);
  const r = applyVex(f, [
    { vuln: 'CVE-2021-23337', product: 'pkg:npm/lodash', status: 'not_affected', justification: 'code_not_reachable' },
    { vuln: 'GHSA-listed', product: 'express', status: 'affected' },
    { vuln: 'GHSA-inner-1', product: 'pkg:npm/%40scope/inner@9.9.9', status: 'fixed' },
  ]);
  assert.deepEqual(r.active.map((x) => x.vuln), ['GHSA-listed', 'GHSA-inner-1']);
  assert.equal(r.suppressed[0]!.statement.justification, 'code_not_reachable');
  const later = applyVex(f, [{ vuln: 'GHSA-listed', product: 'express', status: 'not_affected' }, { vuln: 'GHSA-listed', product: 'express', status: 'under_investigation' }]);
  assert.ok(later.active.some((x) => x.vuln === 'GHSA-listed'));
});

test('VEX writes and parses CycloneDX vulnerabilities with analysis', () => {
  const st = [{ vuln: 'CVE-1', product: 'lodash', status: 'not_affected' as const, justification: 'code_not_reachable', detail: 'never called' }, { vuln: 'CVE-1', product: 'nested', status: 'not_affected' as const, justification: 'code_not_reachable', detail: 'never called' }];
  const doc = writeVex(st);
  const v = (doc.vulnerabilities as { affects: unknown[]; analysis: { state: string } }[])[0]!;
  assert.equal(v.analysis.state, 'not_affected');
  assert.equal(v.affects.length, 2);
  assert.deepEqual(parseVex(doc), st);
  assert.deepEqual(parseVex({ vulnerabilities: [{ id: 'X', analysis: { state: 'resolved' }, affects: [{ ref: 'a' }] }, { id: 'Y', analysis: { state: 'weird' }, affects: [{ ref: 'a' }] }] }), [{ vuln: 'X', product: 'a', status: 'fixed' }]);
});

test('diffSboms reports added, removed and version changes by package identity', () => {
  const a = parseCycloneDx(cdx());
  const b = parseCycloneDx({ ...cdx(), components: [{ type: 'library', 'bom-ref': 'l2', name: 'lodash', version: '4.17.21', purl: 'pkg:npm/lodash@4.17.21' }, { type: 'library', 'bom-ref': 'new', name: 'zod', version: '3.0.0', purl: 'pkg:npm/zod@3.0.0' }] });
  const d = diffSboms(a, b);
  assert.deepEqual(d.added.map((c) => c.name), ['zod']);
  assert.deepEqual(d.removed.map((c) => c.name).sort(), ['express', 'inner']);
  assert.deepEqual(d.changed, [{ name: 'lodash', from: '4.17.20', to: '4.17.21' }]);
});

test('invalid purls inside a document are dropped rather than trusted', () => {
  const s = parseCycloneDx({ ...cdx(), components: [{ type: 'library', name: 'weird', version: '1', purl: 'not-a-purl' }] });
  assert.equal(s.components[0]!.purl, undefined);
  assert.deepEqual(matchAdvisories(s, vulns), []);
});
