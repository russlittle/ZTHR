import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import {
  BadPackage, BadVersion, ManifestError, bumpKind, canonicalJson, compareVersions, dependencyOrder, manifestProblems, maxSatisfying, parseVersion,
  planInstall, planUpdates, publicKeyOf, readManifest, reviewPermissions, satisfies, signPackage, verifyPackage,
} from './index.ts';
import type { Manifest, PackageEnvelope, TrustStore } from './index.ts';

const manifest = (o: Partial<Record<keyof Manifest, unknown>> = {}): Manifest =>
  ({
    name: 'acme-seo',
    version: '1.2.3',
    title: 'Acme SEO',
    description: 'Search engine helpers',
    author: { name: 'Acme', url: 'https://acme.example' },
    license: 'GPL-2.0-or-later',
    requires: { host: '>=4.2 <6' },
    permissions: ['content:read'],
    entry: 'main.js',
    ...o,
  }) as Manifest;

// ------------------------------------------------------------ semantic versions

test('precedence follows the specification chain, ignores build metadata, and compares numbers as numbers', () => {
  const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
  for (let i = 0; i + 1 < chain.length; i++) {
    assert.equal(compareVersions(chain[i]!, chain[i + 1]!), -1, `${chain[i]} < ${chain[i + 1]}`);
    assert.equal(compareVersions(chain[i + 1]!, chain[i]!), 1);
  }
  assert.equal(compareVersions('1.0.0+build.1', '1.0.0+build.2'), 0);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.0.0-2', '1.0.0-11'), -1);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
});

test('malformed versions are refused', () => {
  for (const bad of ['1.2', '01.2.3', '1.2.3-', '1.2.3-01', '1.2.3+', 'a.b.c', '', '1.2.3.4', '99999999999999999999.0.0', `1.0.0-${'a'.repeat(300)}`]) assert.throws(() => parseVersion(bad), BadVersion, bad);
  assert.deepEqual(parseVersion('1.2.3-rc.1+b5').prerelease, ['rc', 1]);
  assert.deepEqual(parseVersion('1.2.3-rc.1+b5').build, ['b5']);
});

test('caret, tilde, comparators, partials, x and hyphen ranges', () => {
  const table: [string, string[], string[]][] = [
    ['^1.2.3', ['1.2.3', '1.9.9'], ['1.2.2', '2.0.0']],
    ['^0.2.3', ['0.2.3', '0.2.9'], ['0.3.0', '0.2.2']],
    ['^0.0.3', ['0.0.3'], ['0.0.4', '0.0.2']],
    ['^1.2', ['1.2.0', '1.5.0'], ['2.0.0', '1.1.9']],
    ['^0', ['0.0.0', '0.9.9'], ['1.0.0']],
    ['~1.2.3', ['1.2.3', '1.2.9'], ['1.3.0']],
    ['~1', ['1.0.0', '1.9.9'], ['2.0.0']],
    ['1.x', ['1.0.0', '1.8.0'], ['2.0.0', '0.9.0']],
    ['1.2.*', ['1.2.0', '1.2.7'], ['1.3.0']],
    ['*', ['0.0.1', '99.0.0'], []],
    ['>=1.2.3 <2', ['1.2.3', '1.99.0'], ['2.0.0', '1.2.2']],
    ['>1.2.3', ['1.2.4'], ['1.2.3']],
    ['<=1.2', ['1.2.9', '1.0.0'], ['1.3.0']],
    ['1.2.3 - 2.3.4', ['1.2.3', '2.3.4', '2.0.0'], ['1.2.2', '2.3.5']],
    ['1.2 - 2', ['1.2.0', '2.9.9'], ['3.0.0', '1.1.9']],
    ['>= 1.2.3 < 2.0.0', ['1.5.0'], ['2.0.0']],
    ['1.2.3', ['1.2.3'], ['1.2.4']],
    ['=1.2.3', ['1.2.3'], ['1.2.4']],
    ['^1.2.3 || ^3.0.0', ['1.4.0', '3.1.0'], ['2.0.0']],
  ];
  for (const [range, yes, no] of table) {
    for (const v of yes) assert.equal(satisfies(v, range), true, `${v} in ${range}`);
    for (const v of no) assert.equal(satisfies(v, range), false, `${v} not in ${range}`);
  }
});

test('a pre-release only satisfies a range that names a pre-release of the same version', () => {
  assert.equal(satisfies('1.3.0-beta.1', '^1.2.0'), false);
  assert.equal(satisfies('1.3.0-beta.1', '^1.3.0-beta.0'), true);
  assert.equal(satisfies('1.3.0-beta.1', '>=1.2.0'), false);
  assert.equal(satisfies('1.3.0-beta.1', '^1.2.0', { includePrerelease: true }), true);
  assert.equal(satisfies('2.0.0-alpha', '^1.2.0', { includePrerelease: true }), false, 'the upper bound excludes the next major pre-releases');
  assert.equal(maxSatisfying(['1.0.0', '1.4.2', '1.5.0-rc.1', '2.0.0'], '^1.0.0'), '1.4.2');
  assert.equal(maxSatisfying(['0.1.0'], '^1.0.0'), undefined);
});

test('bad ranges are refused, and bump kinds are named', () => {
  for (const bad of ['^', '>=', '1.2.3 -', 'foo', '1.2.3.4', `^${'1'.repeat(300)}`]) assert.throws(() => satisfies('1.0.0', bad), BadVersion, bad);
  assert.equal(bumpKind('1.2.3', '1.2.4'), 'patch');
  assert.equal(bumpKind('1.2.3', '1.3.0'), 'minor');
  assert.equal(bumpKind('1.2.3', '2.0.0'), 'major');
  assert.equal(bumpKind('1.2.3', '1.3.0-rc.1'), 'prerelease');
  assert.equal(bumpKind('1.2.3', '1.2.3+x'), 'none');
  assert.equal(bumpKind('1.2.3', '1.0.0'), 'downgrade');
});

// ------------------------------------------------------------ manifests

test('a sound manifest passes and the same text parses', () => {
  assert.deepEqual(manifestProblems(manifest()), []);
  assert.equal(readManifest(JSON.stringify(manifest())).name, 'acme-seo');
});

test('every problem is reported at once with plain words', () => {
  const bad = manifest({ name: 'Acme SEO', version: '1.2', title: '', license: 'my own', homepage: 'http://x.example', requires: { host: 'banana' }, permissions: ['content:read', 'content:read', 'rm:rf'], entry: '../main.js', dependencies: { 'Acme SEO': '^1' }, extra: 1 } as never);
  const p = manifestProblems(bad);
  for (const s of ['name must be lower-case', 'version "1.2" is not a semantic version', 'title is required', 'license must be an SPDX', 'homepage must be an https', 'requires.host: "banana"', 'permission "content:read" is listed twice', 'permission "rm:rf" is not one this host offers', 'entry has an empty, "." or ".." part', 'cannot depend on itself', '"extra" is not a manifest field']) {
    assert.ok(p.some((x) => x.includes(s)), `missing: ${s} in ${p.join(' | ')}`);
  }
  assert.throws(() => readManifest(bad), (e: unknown) => e instanceof ManifestError && e.problems.length === p.length);
  assert.ok(manifestProblems(manifest({ requires: {} })).some((x) => x.includes('requires.host is required')));
  assert.deepEqual(manifestProblems('x'), ['the manifest must be an object']);
});

test('manifest text must be JSON and small', () => {
  assert.throws(() => readManifest('{nope'), /not valid JSON/);
  assert.throws(() => readManifest(`{"a":"${'x'.repeat(70_000)}"}`), /larger than 64 KiB/);
  for (const p of ['/etc/passwd', 'a\\b', 'C:x', 'a//b', './a', 'a/../b', 'a\u0000b', '']) assert.ok(manifestProblems(manifest({ entry: p })).some((x) => x.startsWith('entry')), JSON.stringify(p));
});

test('permissions split into allowed now and needing approval, by risk and by what is already granted', () => {
  const r = reviewPermissions(['content:read', 'content:write', 'users:write'], { granted: ['content:write'] });
  assert.deepEqual(r.allowed, ['content:read', 'content:write']);
  assert.deepEqual(r.needsApproval, ['users:write']);
  assert.equal(r.highest, 'high');
  assert.equal(reviewPermissions([]).highest, 'none');
  assert.deepEqual(reviewPermissions(['content:write'], { autoAllow: ['low', 'medium'] }).needsApproval, []);
  assert.throws(() => reviewPermissions(['constructor']), /not one this host offers/);
});

// ------------------------------------------------------------ signed packages

const files = { 'main.js': 'export default 1;', 'lang/en.json': '{}' };
const setup = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const trust: TrustStore = { k1: { publicKey: pub, scope: ['acme-*'], notBefore: 1000, notAfter: 9000 } };
  return { privateKey, trust, pub };
};

test('RFC 8032 test 1: the published Ed25519 signature verifies under the published key', () => {
  const pub = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex').toString('base64');
  const sig = Buffer.from('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b', 'hex');
  assert.equal(verify(null, Buffer.alloc(0), publicKeyOf(pub), sig), true);
  assert.equal(verify(null, Buffer.from('x'), publicKeyOf(pub), sig), false);
  assert.throws(() => publicKeyOf('AAAA'), BadPackage);
});

test('a signed package verifies and gives back its manifest', () => {
  const { privateKey, trust } = setup();
  const env = signPackage(manifest(), files, 'k1', privateKey, 2000);
  assert.deepEqual(Object.keys(env.files), ['lang/en.json', 'main.js']);
  assert.match(env.files['main.js']!.sha256, /^[0-9a-f]{64}$/);
  assert.equal(verifyPackage(env, files, trust, 3000).version, '1.2.3');
  assert.equal(verifyPackage(JSON.parse(JSON.stringify(env)), { ...files }, trust, 3000).name, 'acme-seo');
  assert.equal(canonicalJson({ b: [2, { z: 1, a: 2 }], a: 1 }), '{"a":1,"b":[2,{"a":2,"z":1}]}');
});

test('the file digest is the real SHA-256 of the bytes', () => {
  const { privateKey } = setup();
  const env = signPackage(manifest(), { 'main.js': 'abc' }, 'k1', privateKey, 2000);
  assert.equal(env.files['main.js']?.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(env.files['main.js']?.size, 3);
});

test('changing the manifest, a file, or the file list breaks verification', () => {
  const { privateKey, trust } = setup();
  const env = signPackage(manifest(), files, 'k1', privateKey, 2000);
  const evil = { ...env, manifest: { ...env.manifest, permissions: ['content:read', 'code:execute'] } };
  assert.throws(() => verifyPackage(evil, files, trust, 3000), (e: unknown) => e instanceof BadPackage && e.code === 'signature');
  assert.throws(() => verifyPackage(env, { ...files, 'main.js': 'export default 2;' }, trust, 3000), /"main.js" has been changed/);
  assert.throws(() => verifyPackage(env, { ...files, 'extra.php': '<?php' }, trust, 3000), /not in the signed list/);
  const { 'lang/en.json': _gone, ...fewer } = files;
  assert.throws(() => verifyPackage(env, fewer, trust, 3000), /missing from the package/);
  const swapped: PackageEnvelope = { ...env, files: { ...env.files, 'main.js': { ...env.files['main.js']!, sha256: env.files['lang/en.json']!.sha256 } } };
  assert.throws(() => verifyPackage(swapped, files, trust, 3000), (e: unknown) => e instanceof BadPackage && e.code === 'signature');
  const resigned: PackageEnvelope = { ...env, signature: { ...env.signature, signedAt: 2001 } };
  assert.throws(() => verifyPackage(resigned, files, trust, 3000), (e: unknown) => e instanceof BadPackage && e.code === 'signature');
});

test('only ed25519 is accepted, so a package cannot choose a weaker algorithm', () => {
  const { privateKey, trust, pub } = setup();
  const env = signPackage(manifest(), files, 'k1', privateKey, 2000);
  for (const alg of ['none', 'HS256', 'rsa-sha1', 'ES256', '']) assert.throws(() => verifyPackage({ ...env, signature: { ...env.signature, alg } }, files, trust, 3000), (e: unknown) => e instanceof BadPackage && e.code === 'algorithm', alg);
  assert.throws(() => verifyPackage({ ...env, signature: { ...env.signature, value: '' } }, files, trust, 3000), (e: unknown) => e instanceof BadPackage && e.code === 'signature');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => signPackage(manifest(), files, 'k1', rsa.privateKey, 2000), (e: unknown) => e instanceof BadPackage && e.code === 'algorithm');
  const rsaTrust: TrustStore = { k1: { publicKey: rsa.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), scope: ['*'] } };
  assert.throws(() => verifyPackage(env, files, rsaTrust, 3000), BadPackage);
  assert.ok(pub.length > 0);
});

test('keys must be known, in date, not revoked, and scoped to the name', () => {
  const { privateKey, trust } = setup();
  const env = signPackage(manifest(), files, 'k1', privateKey, 2000);
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof BadPackage ? e.code : 'other';
    }
    return 'none';
  };
  assert.equal(code(() => verifyPackage(env, files, {}, 3000)), 'unknown-key');
  assert.equal(code(() => verifyPackage(env, files, trust, 9001)), 'expired');
  assert.equal(code(() => verifyPackage(env, files, trust, 500)), 'not-yet-valid');
  assert.equal(code(() => verifyPackage(env, files, { k1: { ...trust.k1!, revokedAt: 2500 } }, 3000)), 'revoked');
  assert.equal(code(() => verifyPackage(env, files, { k1: { ...trust.k1!, revokedAt: 2500 } }, 2200)), 'none', 'before the revocation, signed before it');
  assert.equal(code(() => verifyPackage(env, files, { k1: { ...trust.k1!, scope: ['other-*'] } }, 3000)), 'scope');
  assert.equal(code(() => verifyPackage(env, files, { k1: { ...trust.k1!, scope: ['acme-seo'] } }, 3000)), 'none');
  assert.equal(code(() => verifyPackage(env, files, { k1: { ...trust.k1!, scope: ['acme'] } }, 3000)), 'scope', 'a bare name is not a prefix');
  assert.equal(code(() => verifyPackage(env, files, Object.create({ k1: trust.k1 }) as TrustStore, 3000)), 'unknown-key', 'inherited keys do not count');
  assert.equal(code(() => verifyPackage({ ...env, signature: { ...env.signature, keyId: 'constructor' } }, files, trust, 3000)), 'unknown-key');
  assert.equal(code(() => verifyPackage(null as never, files, trust, 3000)), 'format');
});

test('file names that climb out, are absolute, or collide on a case-insensitive disk are refused when signing', () => {
  const { privateKey } = setup();
  for (const bad of ['../evil.js', '/abs.js', 'a\\b.js', 'a/./b.js', 'x/../../y']) assert.throws(() => signPackage(manifest(), { 'main.js': 'x', [bad]: 'y' }, 'k1', privateKey, 2000), (e: unknown) => e instanceof BadPackage && e.code === 'path', bad);
  assert.throws(() => signPackage(manifest(), { 'main.js': 'x', 'Main.JS': 'y' }, 'k1', privateKey, 2000), /collides/);
  assert.throws(() => signPackage(manifest(), { 'other.js': 'x' }, 'k1', privateKey, 2000), /entry file main.js is not in the package/);
  assert.throws(() => signPackage(manifest({ permissions: ['sudo'] }), files, 'k1', privateKey, 2000), ManifestError);
});

test('a signed envelope with an unsafe path is refused on verification too', () => {
  const { privateKey, trust } = setup();
  const env = signPackage(manifest(), files, 'k1', privateKey, 2000);
  const evil = { ...env, files: { ...env.files, '../x': env.files['main.js']! } };
  // The signature check comes first and refuses a changed list; this is what a hostile signer could not get past either.
  assert.throws(() => verifyPackage(evil, { ...files, '../x': 'export default 1;' }, trust, 3000), BadPackage);
});

// ------------------------------------------------------------ dependency order

test('dependencies come first, and a loop is named', () => {
  const deps: Record<string, string[]> = { a: ['b', 'c'], b: ['c'], c: [], d: [] };
  assert.deepEqual(dependencyOrder(['a', 'b', 'c', 'd'], (n) => deps[n] ?? []), ['c', 'b', 'a', 'd']);
  assert.deepEqual(dependencyOrder(['a'], (n) => deps[n] ?? []), ['a'], 'dependencies outside the set are not ordered');
  const loop: Record<string, string[]> = { a: ['b'], b: ['c'], c: ['a'] };
  assert.throws(() => dependencyOrder(['a', 'b', 'c'], (n) => loop[n] ?? []), /dependency loop: a -> b -> c -> a/);
});

// ------------------------------------------------------------ update plans

const v = (version: string, o: Partial<Record<keyof Manifest, unknown>> = {}, yanked = false) => ({ manifest: manifest({ version, ...o }), ...(yanked ? { yanked } : {}) });
const host = { host: '5.1.0' };

test('the plan takes the newest version that fits the host, skipping yanked and pre-release versions', () => {
  const cat = { 'acme-seo': [v('1.2.3'), v('1.3.0'), v('1.4.0', {}, true), v('1.5.0-beta.1'), v('1.4.5', { requires: { host: '>=6' } })] };
  const plan = planUpdates([{ name: 'acme-seo', version: '1.2.3', granted: ['content:read'] }], cat, host);
  assert.deepEqual(plan.updates.map((u) => [u.name, u.to, u.kind, u.needsApproval]), [['acme-seo', '1.3.0', 'minor', false]]);
  assert.deepEqual(plan.blocked, []);
  const beta = planUpdates([{ name: 'acme-seo', version: '1.2.3', granted: [] }], cat, { ...host, allowPrerelease: true });
  assert.equal(beta.updates[0]?.to, '1.5.0-beta.1');
});

test('a major version or a new permission needs a person, and says why', () => {
  const cat = { 'acme-seo': [v('2.0.0', { permissions: ['content:read', 'users:write'] })], other: [v('1.0.1', { name: 'other', permissions: ['content:write'] })] };
  const plan = planUpdates(
    [{ name: 'acme-seo', version: '1.2.3', granted: ['content:read'] }, { name: 'other', version: '1.0.0', granted: ['content:write'] }],
    cat,
    host,
  );
  const a = plan.updates.find((u) => u.name === 'acme-seo')!;
  assert.equal(a.needsApproval, true);
  assert.deepEqual(a.newPermissions, ['users:write']);
  assert.match(a.reasons.join(' | '), /new major version \(1.2.3 to 2.0.0\)/);
  assert.match(a.reasons.join(' | '), /new permissions: users:write/);
  const b = plan.updates.find((u) => u.name === 'other')!;
  assert.equal(b.needsApproval, false);
  assert.equal(b.kind, 'patch');
});

test('an update the host cannot run, or whose dependency is missing, is blocked with the reason', () => {
  const cat = {
    'acme-seo': [v('2.0.0', { requires: { host: '>=6' } })],
    'acme-ads': [v('1.1.0', { name: 'acme-ads', dependencies: { 'acme-seo': '^2' } })],
    'acme-old': [v('1.1.0', { name: 'acme-old', requires: { host: '>=4', php: '>=8.3' } })],
  };
  const plan = planUpdates(
    [{ name: 'acme-seo', version: '1.2.3', granted: [] }, { name: 'acme-ads', version: '1.0.0', granted: [] }, { name: 'acme-old', version: '1.0.0', granted: [] }],
    cat,
    { ...host, provides: { php: '8.2.1' } },
  );
  assert.deepEqual(plan.updates, []);
  assert.equal(plan.blocked.find((b) => b.name === 'acme-seo')?.reason, '2.0.0 needs host >=6, and this host has 5.1.0');
  assert.equal(plan.blocked.find((b) => b.name === 'acme-ads')?.reason, '1.1.0 needs acme-seo ^2, and 1.2.3 is installed');
  assert.equal(plan.blocked.find((b) => b.name === 'acme-old')?.reason, '1.1.0 needs php >=8.3, and this host has 8.2.1');
});

test('updates are ordered with dependencies first, a skipped version is not offered again, and up to date is listed', () => {
  const cat = {
    'acme-ui': [v('1.1.0', { name: 'acme-ui' })],
    'acme-app': [v('1.1.0', { name: 'acme-app', dependencies: { 'acme-ui': '^1' } })],
    'acme-same': [v('1.0.0', { name: 'acme-same' })],
    'acme-skip': [v('1.1.0', { name: 'acme-skip' })],
  };
  const plan = planUpdates(
    [{ name: 'acme-app', version: '1.0.0', granted: [] }, { name: 'acme-ui', version: '1.0.0', granted: [] }, { name: 'acme-same', version: '1.0.0', granted: [] }, { name: 'acme-skip', version: '1.0.0', granted: [], skip: '1.1.0' }],
    cat,
    host,
  );
  assert.deepEqual(plan.order, ['acme-ui', 'acme-app']);
  assert.deepEqual([...plan.upToDate].sort(), ['acme-same', 'acme-skip']);
});

test('installing resolves dependencies to the newest versions that fit, in order, reusing what is installed', () => {
  const cat = {
    'acme-app': [v('1.0.0', { name: 'acme-app', dependencies: { 'acme-ui': '^1', 'acme-core': '>=2 <3' } })],
    'acme-ui': [v('1.0.0', { name: 'acme-ui' }), v('1.4.0', { name: 'acme-ui', dependencies: { 'acme-core': '^2' } }), v('2.0.0', { name: 'acme-ui' })],
    'acme-core': [v('2.1.0', { name: 'acme-core' }), v('2.5.0', { name: 'acme-core' }), v('3.0.0', { name: 'acme-core' })],
  };
  assert.deepEqual(planInstall('acme-app', '*', [], cat, host).steps, [{ name: 'acme-core', version: '2.5.0' }, { name: 'acme-ui', version: '1.4.0' }, { name: 'acme-app', version: '1.0.0' }]);
  assert.deepEqual(planInstall('acme-app', '*', [{ name: 'acme-core', version: '2.1.0', granted: [] }], cat, host).steps.map((s) => s.name), ['acme-ui', 'acme-app']);
  assert.deepEqual(planInstall('acme-core', '^2', [{ name: 'acme-core', version: '2.1.0', granted: [] }], cat, host).steps, [], 'already satisfied');
});

test('installing refuses what cannot be satisfied, with the reason', () => {
  const cat = {
    'acme-a': [v('1.0.0', { name: 'acme-a', dependencies: { 'acme-b': '^1' } })],
    'acme-b': [v('1.0.0', { name: 'acme-b', dependencies: { 'acme-a': '^1' } })],
    'acme-new': [v('9.0.0', { name: 'acme-new', requires: { host: '>=9' } })],
    'acme-conflict': [v('1.0.0', { name: 'acme-conflict', dependencies: { 'acme-x': '^1' } })],
    'acme-x': [v('2.0.0', { name: 'acme-x' })],
  };
  assert.throws(() => planInstall('acme-a', '*', [], cat, host), /dependency loop: acme-a -> acme-b -> acme-a/);
  assert.throws(() => planInstall('acme-new', '*', [], cat, host), /no version of acme-new fits \* \(newest, 9.0.0, needs host >=9/);
  assert.throws(() => planInstall('nothing', '*', [], cat, host), /nothing is not in the catalogue/);
  assert.throws(() => planInstall('acme-conflict', '*', [], cat, host), /no version of acme-x fits \^1/);
  assert.throws(() => planInstall('acme-x', '^1', [{ name: 'acme-x', version: '2.0.0', granted: [] }], cat, host), /acme-x 2.0.0 is installed but \^1 is needed/);
});
