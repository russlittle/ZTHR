import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CREATE, DELETE, READ, UPDATE } from '../grants/index.ts';
import { BadPath, BadSignature, BadTransform, Refused, Signer, Storage, canonicalTransform, cleanPath, grantBit, outputSize, parseTransform, sniff } from './index.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

const store = () => {
  const s = new Storage();
  s.addBucket({ name: 'avatars', public: true, maxBytes: 1000, allowedTypes: ['image/*'], allowedExtensions: ['png', 'jpg'] });
  s.addBucket({ name: 'docs' });
  s.addPolicy({ id: 'own-folder', bucket: 'docs', effect: 'allow', actions: ['list', 'read', 'create', 'update', 'delete'], path: 'users/{id}/**' });
  s.addPolicy({ id: 'tenant-read', bucket: 'docs', effect: 'allow', actions: ['read', 'list'], path: 'tenants/{tenant}/**' });
  s.addPolicy({ id: 'admin-all', bucket: 'docs', effect: 'allow', actions: ['list', 'read', 'create', 'update', 'delete'], path: '**', roles: ['admin'] });
  s.addPolicy({ id: 'no-locked', bucket: 'docs', effect: 'deny', actions: ['read', 'update', 'delete'], path: 'users/*/locked/**' });
  s.addPolicy({ id: 'own-avatar', bucket: 'avatars', effect: 'allow', actions: ['create', 'update', 'delete'], path: '{id}/*' });
  return s;
};
const ana = { id: 'ana', tenant: 't1' };

test('a person reaches their own folder and not anyone else\'s, and anonymous people reach nothing', () => {
  const s = store();
  assert.equal(s.decide(ana, 'read', 'docs', 'users/ana/cv.pdf').allowed, true);
  assert.equal(s.decide(ana, 'read', 'docs', 'users/ben/cv.pdf').allowed, false);
  assert.equal(s.decide({}, 'read', 'docs', 'users/ana/cv.pdf').reason, 'sign in first; no policy allows anonymous access to this');
  assert.equal(s.decide(ana, 'create', 'docs', 'users/ana/a/b/c.txt').policy, 'own-folder');
  assert.equal(s.decide(ana, 'read', 'docs', 'users/ana').allowed, false, '** needs at least one more segment');
});

test('nothing is allowed unless a policy allows it, and an unknown bucket is refused', () => {
  const s = store();
  assert.equal(s.decide(ana, 'read', 'docs', 'secret/file').reason, 'no policy allows this');
  assert.equal(s.decide(ana, 'read', 'nowhere', 'a').reason, 'no bucket nowhere');
  assert.throws(() => s.require(ana, 'delete', 'docs', 'users/ben/x'), Refused);
  assert.equal(s.require(ana, 'delete', 'docs', 'users/ana/x').policy, 'own-folder');
});

test('a deny beats an allow, even for an administrator', () => {
  const s = store();
  const d = s.decide({ id: 'root', roles: ['admin'] }, 'read', 'docs', 'users/ben/locked/plan.pdf');
  assert.deepEqual([d.allowed, d.policy], [false, 'no-locked']);
  assert.equal(s.decide({ id: 'root', roles: ['admin'] }, 'create', 'docs', 'users/ben/locked/plan.pdf').allowed, true, 'the deny does not cover create');
  assert.equal(s.decide(ana, 'update', 'docs', 'users/ana/locked/x').allowed, false);
});

test('roles gate a policy and tenant folders are filled from the person', () => {
  const s = store();
  assert.equal(s.decide(ana, 'read', 'docs', 'tenants/t1/report.csv').policy, 'tenant-read');
  assert.equal(s.decide(ana, 'read', 'docs', 'tenants/t2/report.csv').allowed, false);
  assert.equal(s.decide({ id: 'x' }, 'read', 'docs', 'tenants/t1/report.csv').allowed, false, 'no tenant, no match');
  assert.equal(s.decide(ana, 'read', 'docs', 'anything/at/all').allowed, false);
  assert.equal(s.decide({ id: 'r', roles: ['admin'] }, 'read', 'docs', 'anything/at/all').policy, 'admin-all');
});

test('listing is allowed only for a folder the policy covers entirely', () => {
  const s = store();
  assert.equal(s.decide(ana, 'list', 'docs', 'users/ana').allowed, true);
  assert.equal(s.decide(ana, 'list', 'docs', 'users/ana/sub/').allowed, true);
  assert.equal(s.decide(ana, 'list', 'docs', 'users').allowed, false, 'would show other people\'s folder names');
  assert.equal(s.decide(ana, 'list', 'docs', '').allowed, false);
  assert.equal(s.decide({ id: 'r', roles: ['admin'] }, 'list', 'docs', '').allowed, true);
});

test('a public bucket lets anyone read but not list, and still checks writes', () => {
  const s = store();
  assert.equal(s.decide({}, 'read', 'avatars', 'ana/me.png').allowed, true);
  assert.equal(s.decide({}, 'list', 'avatars', '').allowed, false);
  assert.equal(s.decide(ana, 'create', 'avatars', 'ana/me.png').allowed, true);
  assert.equal(s.decide(ana, 'create', 'avatars', 'ben/me.png').allowed, false);
  assert.equal(s.decide(ana, 'create', 'avatars', 'ana/deep/me.png').allowed, false);
});

test('paths that could leave the bucket are refused before any policy is read', () => {
  for (const p of ['../etc/passwd', 'users/ana/../ben/x', 'a//b', 'a/./b', 'a\\b', 'a/%2e%2e/b', 'a/b%2Fc', 'a\u0000b', '', '/', 'a/%00']) assert.throws(() => cleanPath(p), BadPath, JSON.stringify(p));
  assert.equal(cleanPath('/users/ana/x.txt'), 'users/ana/x.txt');
  assert.throws(() => cleanPath('a/'.repeat(600)), /longer than 1024/);
  assert.match(store().decide({ id: 'root', roles: ['admin'] }, 'read', 'docs', 'users/ana/../ben/x').reason, /\.\./);
});

test('policies are checked when added', () => {
  const s = store();
  assert.throws(() => s.addPolicy({ id: 'x', bucket: 'ghost', effect: 'allow', actions: ['read'], path: '**' }), /no bucket/);
  assert.throws(() => s.addPolicy({ id: 'own-folder', bucket: 'docs', effect: 'allow', actions: ['read'], path: '**' }), /already exists/);
  assert.throws(() => s.addPolicy({ id: 'y', bucket: 'docs', effect: 'allow', actions: [], path: '**' }), /no actions/);
  assert.throws(() => s.addPolicy({ id: 'z', bucket: 'docs', effect: 'allow', actions: ['read'], path: 'a*/b' }), /whole segment/);
  assert.throws(() => s.addBucket({ name: 'Bad Name' }), /lower-case/);
  assert.throws(() => s.addBucket({ name: 'docs' }), /already exists/);
  assert.equal(grantBit('list'), READ);
  assert.deepEqual([grantBit('create'), grantBit('update'), grantBit('delete')], [CREATE, UPDATE, DELETE]);
});

test('uploads are held to the bucket\'s size, extension and type rules', () => {
  const s = store();
  assert.deepEqual(s.checkUpload('avatars', { path: 'ana/me.png', size: 500, contentType: 'image/png; charset=binary', head: PNG }), { path: 'ana/me.png', contentType: 'image/png' });
  assert.throws(() => s.checkUpload('avatars', { path: 'ana/me.png', size: 1001, contentType: 'image/png' }), /over this bucket's limit of 1000/);
  assert.throws(() => s.checkUpload('avatars', { path: 'ana/me.gif', size: 5, contentType: 'image/gif' }), /\.gif are not allowed/);
  assert.throws(() => s.checkUpload('avatars', { path: 'ana/me', size: 5, contentType: 'image/png' }), /\.\(none\)/);
  assert.throws(() => s.checkUpload('avatars', { path: 'ana/me.png', size: 5, contentType: 'application/pdf' }), /not an allowed type/);
  assert.throws(() => s.checkUpload('avatars', { path: 'ana/me.png', size: -1, contentType: 'image/png' }), /not a number/);
  assert.throws(() => s.checkUpload('avatars', { path: 'ana/me.png', size: 5, contentType: 'image png' }), /not a content type/);
  assert.equal(s.checkUpload('docs', { path: 'users/ana/anything.bin', size: 1e9, contentType: 'application/octet-stream' }).contentType, 'application/octet-stream');
});

test('the real type is read from the first bytes: a web page or another image type posing as a png is refused', () => {
  const s = store();
  const html = Buffer.from('<!DOCTYPE html><script>alert(1)</script>');
  assert.throws(() => s.checkUpload('avatars', { path: 'ana/me.png', size: 40, contentType: 'image/png', head: html }), /look like a web page/);
  assert.throws(() => s.checkUpload('avatars', { path: 'ana/me.png', size: 6, contentType: 'image/png', head: JPG }), /bytes are image\/jpeg, not the claimed image\/png/);
  assert.equal(sniff(PNG), 'image/png');
  assert.equal(sniff(Buffer.from('%PDF-1.7')), 'application/pdf');
  assert.equal(sniff(Buffer.from('RIFF....WEBPVP8 ')), 'image/webp');
  assert.equal(sniff(Buffer.from('plain text')), undefined);
});

const T0 = 1_800_000_000_000;
test('a signed URL verifies for its own bucket, path and action, until it expires', () => {
  let t = T0;
  const sg = new Signer(['k'.repeat(32)], { now: () => t });
  const token = sg.sign({ bucket: 'docs', path: 'users/ana/cv.pdf', action: 'read', ttlSeconds: 60, by: 'ana' });
  assert.equal(sg.verify(token, { bucket: 'docs', path: 'users/ana/cv.pdf', action: 'read' }).by, 'ana');
  assert.throws(() => sg.verify(token, { bucket: 'docs', path: 'users/ana/other.pdf', action: 'read' }), /different file/);
  assert.throws(() => sg.verify(token, { bucket: 'avatars', path: 'users/ana/cv.pdf', action: 'read' }), /different file/);
  assert.throws(() => sg.verify(token, { bucket: 'docs', path: 'users/ana/cv.pdf', action: 'create' }), /allows read, not create/);
  t += 59_000;
  sg.verify(token, { bucket: 'docs', path: 'users/ana/cv.pdf', action: 'read' });
  t += 1_000;
  assert.throws(() => sg.verify(token, { bucket: 'docs', path: 'users/ana/cv.pdf', action: 'read' }), /expired/);
});

test('a tampered, truncated or foreign token is refused, and rotated keys keep old links alive', () => {
  const sg = new Signer(['a'.repeat(32)], { now: () => T0 });
  const token = sg.sign({ bucket: 'docs', path: 'x', action: 'read', ttlSeconds: 60 });
  const [body, sig] = token.split('.') as [string, string];
  const forged = Buffer.from(JSON.stringify({ b: 'docs', p: 'x', a: 'read', exp: 9e9 })).toString('base64url');
  assert.throws(() => sg.verify(`${forged}.${sig}`, { bucket: 'docs', path: 'x', action: 'read' }), BadSignature);
  assert.throws(() => sg.verify(`${body}.${sig.slice(0, -2)}`, { bucket: 'docs', path: 'x', action: 'read' }), /does not match/);
  assert.throws(() => sg.verify('nodots', { bucket: 'docs', path: 'x', action: 'read' }), /malformed/);
  assert.throws(() => sg.verify(`${body}.`, { bucket: 'docs', path: 'x', action: 'read' }), BadSignature);
  const other = new Signer(['b'.repeat(32)], { now: () => T0 });
  assert.throws(() => other.verify(token, { bucket: 'docs', path: 'x', action: 'read' }), /does not match/);
  const rotated = new Signer(['b'.repeat(32), 'a'.repeat(32)], { now: () => T0 });
  rotated.verify(token, { bucket: 'docs', path: 'x', action: 'read' });
  assert.throws(() => new Signer(['short']), /at least 16/);
  assert.throws(() => sg.sign({ bucket: 'docs', path: 'x', action: 'read', ttlSeconds: 8 * 86_400 }), /1 to 604800/);
  assert.throws(() => sg.sign({ bucket: 'docs', path: '../x', action: 'read', ttlSeconds: 5 }), BadPath);
});

test('the image transform is signed, so a link for a thumbnail cannot be edited to ask for the original', () => {
  const sg = new Signer(['k'.repeat(32)], { now: () => T0 });
  const thumb = { width: 100, height: 100 };
  const token = sg.sign({ bucket: 'avatars', path: 'ana/me.png', action: 'read', ttlSeconds: 60, transform: thumb });
  sg.verify(token, { bucket: 'avatars', path: 'ana/me.png', action: 'read', transform: { height: 100, width: 100, quality: 80, resize: 'cover' } });
  assert.throws(() => sg.verify(token, { bucket: 'avatars', path: 'ana/me.png', action: 'read' }), /different image settings/);
  assert.throws(() => sg.verify(token, { bucket: 'avatars', path: 'ana/me.png', action: 'read', transform: { width: 4000, height: 4000 } }), /different image settings/);
  const url = sg.url({ bucket: 'avatars', path: 'ana/my pic.png', action: 'read', ttlSeconds: 60, transform: { width: 50, format: 'webp' } });
  assert.match(url, /^\/object\/sign\/avatars\/ana\/my%20pic\.png\?token=[\w-]+\.[\w-]+&format=webp&width=50$/);
});

test('transform parameters are parsed within caps, refusing unknown names and bad values', () => {
  assert.deepEqual(parseTransform(new URLSearchParams('width=200&height=100&resize=contain&quality=70&format=webp')), { width: 200, height: 100, resize: 'contain', quality: 70, format: 'webp' });
  assert.deepEqual(parseTransform({ width: '10' }), { width: 10 });
  assert.deepEqual(parseTransform(new URLSearchParams('token=abc&width=10')), { width: 10 }, 'the token is not an image setting');
  const bad = (q: string, re: RegExp, l = {}) => assert.throws(() => parseTransform(new URLSearchParams(q), l), re, q);
  bad('width=0', /between 1 and 4096/);
  bad('width=5000', /between 1 and 4096/);
  bad('width=12.5', /whole number/);
  bad('width=-3', /whole number/);
  bad('quality=5', /between 20 and 100/);
  bad('resize=stretch', /resize must be/);
  bad('format=gif', /format must be/);
  bad('rotate=90', /unknown image setting rotate/);
  bad('width=4096&height=4096', /more pixels than allowed/);
  bad('width=500', /between 1 and 100/, { maxDimension: 100 });
  assert.ok(new BadTransform('x') instanceof Error);
});

test('equal transforms get one canonical spelling and the output size follows the resize mode', () => {
  assert.equal(canonicalTransform({ width: 100, height: 50, format: 'origin', quality: 80, resize: 'cover' }), 'height=50&width=100');
  assert.equal(canonicalTransform({ resize: 'fill', quality: 60, format: 'avif', width: 1 }), 'format=avif&quality=60&resize=fill&width=1');
  assert.equal(canonicalTransform({}), '');
  const src = { width: 2000, height: 1000 };
  assert.deepEqual(outputSize(src, { width: 500 }), { width: 500, height: 250 });
  assert.deepEqual(outputSize(src, { height: 100 }), { width: 200, height: 100 });
  assert.deepEqual(outputSize(src, { width: 300, height: 300 }), { width: 300, height: 300 });
  assert.deepEqual(outputSize(src, { width: 300, height: 300, resize: 'contain' }), { width: 300, height: 150 });
  assert.deepEqual(outputSize(src, {}), src);
});
