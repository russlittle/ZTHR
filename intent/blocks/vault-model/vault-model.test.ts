import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import {
  VaultError, checkKdf, deriveMasterKey, authHash, storeAuth, verifyAuth, hkdfExpand, symKey, keyBytes, stretch,
  parseEncString, encString, decString, decBytes, generateRsa, rsaWrap, rsaUnwrap, fingerprint,
  createAccount, login, changeMasterPassword, encryptItem, decryptItem, rekeyItem, encryptFolder, decryptFolder,
  Organization, createSend, accessSend, openSend, inviteEmergency, acceptEmergency, confirmEmergency, initiateEmergency,
  decideEmergency, emergencyAt, emergencyDaysLeft, emergencyKey, emergencyTakeover,
} from './index.ts';
import type { Kdf } from './index.ts';

const WEAK: Kdf = { type: 'pbkdf2', iterations: 1000 };
const DAY = 86_400_000;
let counter = 0;
const det = (n: number) => Buffer.alloc(n, (counter = (counter + 7) % 251));
const alice = generateRsa();
const bob = generateRsa();
const mk = (id: string, email: string, password: string, rsa = alice) => createAccount({ id, email, password, kdf: WEAK, allowWeakKdf: true, rsa });

test('PBKDF2-HMAC-SHA256 matches the RFC 7914 vector through the master key path', () => {
  const k = pbkdf2Sync('passwd', 'salt', 1, 64, 'sha256').toString('hex');
  assert.equal(k, '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783');
  const m = deriveMasterKey('passwd', 'salt', { type: 'pbkdf2', iterations: 1 }, true);
  assert.equal(m.toString('hex'), k.slice(0, 64));
});

test('HKDF-Expand matches RFC 5869 test case 1', () => {
  const prk = Buffer.from('077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5', 'hex');
  const info = Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex');
  assert.equal(hkdfExpand(prk, info, 42).toString('hex'), '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
  assert.throws(() => hkdfExpand(prk, info, 0), VaultError);
  assert.throws(() => hkdfExpand(prk, info, 8161), VaultError);
});

test('weak KDF parameters are refused unless allowed, and bad ones always', () => {
  assert.throws(() => checkKdf({ type: 'pbkdf2', iterations: 1000 }), /too few/);
  assert.doesNotThrow(() => checkKdf({ type: 'pbkdf2', iterations: 1000 }, true));
  assert.throws(() => checkKdf({ type: 'pbkdf2', iterations: 0 }, true), VaultError);
  assert.throws(() => checkKdf({ type: 'scrypt', N: 3, r: 8, p: 1 }, true), /power of two/);
  assert.throws(() => checkKdf({ type: 'scrypt', N: 1024, r: 8, p: 1 }), /too small/);
  assert.doesNotThrow(() => checkKdf({ type: 'scrypt', N: 2 ** 15, r: 8, p: 1 }));
  assert.throws(() => checkKdf({ type: 'argon2' } as unknown as Kdf), /unknown/);
});

test('master key depends on password, email (case-insensitive) and KDF', () => {
  const a = deriveMasterKey('pw-one', 'A@Example.com', WEAK, true);
  assert.equal(a.length, 32);
  assert.deepEqual(deriveMasterKey('pw-one', ' a@example.com ', WEAK, true), a);
  assert.notDeepEqual(deriveMasterKey('pw-two', 'a@example.com', WEAK, true), a);
  assert.notDeepEqual(deriveMasterKey('pw-one', 'b@example.com', WEAK, true), a);
  const s = deriveMasterKey('pw-one', 'a@example.com', { type: 'scrypt', N: 1024, r: 8, p: 1 }, true);
  assert.notDeepEqual(s, a);
  assert.throws(() => deriveMasterKey('', 'a@example.com', WEAK, true), /empty/);
});

test('auth hash is checked against a salted server record', () => {
  const m = deriveMasterKey('pw-one', 'a@example.com', WEAK, true);
  const auth = authHash(m, 'pw-one');
  const stored = storeAuth(auth, det, 1000);
  assert.ok(verifyAuth(auth, stored));
  assert.ok(!verifyAuth(authHash(m, 'pw-other'), stored));
  assert.notEqual(stored.hash, Buffer.from(auth, 'base64').toString('hex'));
});

test('cipher string matches an independently computed openssl vector', () => {
  const key = symKey(Buffer.concat([Buffer.alloc(32, 1), Buffer.alloc(32, 2)]));
  const s = encString('attack at dawn', key, () => Buffer.alloc(16, 3));
  assert.equal(s, '2.AwMDAwMDAwMDAwMDAwMDAw==|gOmvcEX2464TnajkMLHdsg==|SrxHURiu0R8SyMelTSNyEdKQxV0L44JnphaCqz6eaIQ=');
  assert.equal(decString(s, key), 'attack at dawn');
});

test('cipher strings round trip text and bytes, with a fresh iv each time', () => {
  const key = symKey(det(64));
  const a = encString('héllo wörld ✓', key);
  const b = encString('héllo wörld ✓', key);
  assert.notEqual(a, b);
  assert.equal(decString(a, key), 'héllo wörld ✓');
  assert.deepEqual(decBytes(encString(Buffer.from([0, 255, 1]), key), key), Buffer.from([0, 255, 1]));
  assert.equal(decString(encString('', key), key), '');
});

test('tampering, wrong keys and malformed strings are all the same refusal', () => {
  const key = symKey(det(64));
  const other = symKey(det(64));
  const s = encString('secret text', key);
  const [iv, ct, mac] = s.slice(2).split('|') as [string, string, string];
  const flip = (b64: string) => { const b = Buffer.from(b64, 'base64'); b[0] = b[0]! ^ 1; return b.toString('base64'); };
  const msgs = new Set<string>();
  for (const bad of [`2.${flip(iv)}|${ct}|${mac}`, `2.${iv}|${flip(ct)}|${mac}`, `2.${iv}|${ct}|${flip(mac)}`, '2.x|y', '0.abc', '', '2.!!|!!|!!', `2.${iv}|${ct}`, `3.${iv}|${ct}|${mac}`]) {
    assert.throws(() => decString(bad, key), (e: Error) => { msgs.add(e.message); return e instanceof VaultError; });
  }
  assert.throws(() => decString(s, other), VaultError);
  assert.equal(msgs.size, 1);
  assert.throws(() => parseEncString(`2.${Buffer.alloc(8).toString('base64')}|${ct}|${mac}`), VaultError);
  assert.throws(() => symKey(Buffer.alloc(32)), /64 bytes/);
});

test('RSA wrap round trips, fails for the wrong key and the wrong type', () => {
  const data = det(64);
  const w = rsaWrap(alice.publicKey, data);
  assert.ok(w.startsWith('4.'));
  assert.deepEqual(rsaUnwrap(alice.privateKey, w), data);
  assert.throws(() => rsaUnwrap(bob.privateKey, w), VaultError);
  assert.throws(() => rsaUnwrap(alice.privateKey, '2.abc'), VaultError);
  assert.throws(() => rsaWrap(Buffer.from('not a key'), data));
});

test('account: create, log in, wrong password fails, server verifies the auth hash', () => {
  const { record, unlocked } = mk('u1', 'Ann@Example.com', 'correct horse');
  assert.equal(record.email, 'ann@example.com');
  const l = login(record, 'correct horse', true);
  assert.ok(verifyAuth(l.auth, record.auth));
  assert.deepEqual(keyBytes(l.unlock().userKey), keyBytes(unlocked.userKey));
  assert.deepEqual(l.unlock().privateKey, alice.privateKey);
  const bad = login(record, 'wrong horse', true);
  assert.ok(!verifyAuth(bad.auth, record.auth));
  assert.throws(() => bad.unlock(), VaultError);
  assert.throws(() => login(record, 'correct horse'), /too few/);
});

test('changing the master password re-wraps only the user key', () => {
  const { record, unlocked } = mk('u1', 'ann@example.com', 'old password');
  const next = changeMasterPassword(record, unlocked, 'new password', { allowWeakKdf: true });
  assert.equal(next.revision, 2);
  assert.equal(next.privateKey, record.privateKey);
  assert.notEqual(next.key, record.key);
  assert.equal(next.kdf.type, 'pbkdf2');
  assert.deepEqual(keyBytes(login(next, 'new password', true).unlock().userKey), keyBytes(unlocked.userKey));
  assert.throws(() => login(next, 'old password', true).unlock(), VaultError);
});

test('changing to a stronger KDF works and a weak change is refused', () => {
  const { record, unlocked } = mk('u1', 'ann@example.com', 'pw pw pw');
  assert.throws(() => changeMasterPassword(record, unlocked, 'pw2', { kdf: { type: 'pbkdf2', iterations: 10 } }), /too few/);
  const next = changeMasterPassword(record, unlocked, 'pw2', { kdf: { type: 'scrypt', N: 1024, r: 8, p: 1 }, allowWeakKdf: true });
  assert.equal(next.kdf.type, 'scrypt');
  assert.deepEqual(keyBytes(login(next, 'pw2', true).unlock().userKey), keyBytes(unlocked.userKey));
});

test('items: every field is encrypted and round trips, with and without an item key', () => {
  const key = symKey(det(64));
  const data = { type: 'login' as const, name: 'Bank', notes: 'pin 1234', login: { username: 'ann', password: 'hunter2!', uris: ['https://bank.example'] }, fields: [{ name: 'q', value: 'a', hidden: true }], favorite: true };
  for (const itemKey of [true, false]) {
    const e = encryptItem('i1', data, key, { itemKey });
    assert.equal(Boolean(e.key), itemKey);
    assert.ok(!JSON.stringify(e).includes('hunter2'));
    assert.ok(!JSON.stringify(e).includes('Bank'));
    const d = decryptItem(e, key);
    assert.equal(d.login?.password, 'hunter2!');
    assert.deepEqual(d.login?.uris, ['https://bank.example']);
    assert.equal(d.name, 'Bank');
    assert.equal(d.notes, 'pin 1234');
    assert.equal(d.fields?.[0]?.hidden, true);
    assert.equal(d.favorite, true);
  }
  assert.throws(() => encryptItem('i', { type: 'login', name: ' ' }, key), /needs a name/);
  assert.throws(() => encryptItem('i', { type: 'bogus' as never, name: 'x' }, key), /not an item type/);
  const card = decryptItem(encryptItem('c', { type: 'card', name: 'Visa', card: { number: '4111111111111111', code: '123' } }, key), key);
  assert.equal(card.card?.number, '4111111111111111');
});

test('items cannot be opened with another key, and folders encrypt names', () => {
  const key = symKey(det(64));
  const e = encryptItem('i1', { type: 'note', name: 'n', notes: 'x' }, key);
  assert.throws(() => decryptItem(e, symKey(det(64))), VaultError);
  const f = encryptFolder('f1', 'Finance', key);
  assert.ok(!f.name.includes('Finance'));
  assert.deepEqual(decryptFolder(f, key), { id: 'f1', name: 'Finance' });
  assert.throws(() => encryptFolder('f', '', key), VaultError);
});

test('rekeyItem moves an item between owner keys with and without item keys', () => {
  const a = symKey(det(64));
  const b = symKey(det(64));
  for (const itemKey of [true, false]) {
    const e = encryptItem('i1', { type: 'login', name: 'X', login: { password: 'pw-x' } }, a, { itemKey });
    const r = rekeyItem(e, a, b, { organizationId: 'org', collectionIds: ['c1'] });
    assert.equal(r.revision, 2);
    assert.equal(r.organizationId, 'org');
    assert.deepEqual(r.collectionIds, ['c1']);
    assert.equal(decryptItem(r, b).login?.password, 'pw-x');
    assert.throws(() => decryptItem(r, a), VaultError);
  }
});

function setup() {
  const owner = mk('own', 'owner@example.com', 'owner pw', alice);
  const { org, orgKey } = Organization.found('org1', 'Acme', { id: 'own', email: 'owner@example.com', publicKey: alice.publicKey });
  return { owner, org, orgKey };
}

test('organisation: invite, accept, confirm hands the member the key', () => {
  const { org, orgKey } = setup();
  assert.deepEqual(org.openKey('own', alice.privateKey).enc, orgKey.enc);
  org.invite('own', 'bob', 'Bob@Example.com', 'user');
  assert.throws(() => org.openKey('bob', bob.privateKey), /not been confirmed/);
  org.accept('bob', bob.publicKey);
  assert.throws(() => org.confirm('own', orgKey, 'bob', 'dead-beef'), /fingerprint/);
  org.confirm('own', orgKey, 'bob', fingerprint(bob.publicKey, 'bob'));
  assert.deepEqual(keyBytes(org.openKey('bob', bob.privateKey)), keyBytes(orgKey));
  assert.throws(() => org.openKey('bob', alice.privateKey), VaultError);
  assert.throws(() => org.invite('own', 'b2', 'bob@example.com', 'user'), /already/);
  assert.throws(() => org.invite('bob', 'c', 'c@example.com', 'user'), /only owner or admin/);
  assert.throws(() => org.accept('nobody', bob.publicKey), /no open invitation/);
});

test('collections: rights combine, hidden passwords are stripped, non-members see nothing', () => {
  const { org, orgKey } = setup();
  org.invite('own', 'bob', 'bob@example.com', 'user');
  org.accept('bob', bob.publicKey);
  org.confirm('own', orgKey, 'bob', fingerprint(bob.publicKey, 'bob'));
  org.addCollection('own', 'c1', 'enc-name', { bob: { readOnly: true, hidePasswords: true, manage: false } });
  org.addCollection('own', 'c2', 'enc-name2');
  assert.deepEqual(org.view('bob', ['c1']), { read: true, write: false, seePasswords: false, manage: false });
  assert.deepEqual(org.view('bob', ['c2']), { read: false, write: false, seePasswords: false, manage: false });
  org.setAccess('own', 'c2', 'bob', { readOnly: false, hidePasswords: false, manage: false });
  assert.deepEqual(org.view('bob', ['c1', 'c2']), { read: true, write: true, seePasswords: true, manage: false });
  assert.equal(org.view('own', []).manage, true);
  assert.equal(org.view('stranger', ['c1']).read, false);
  const item = encryptItem('i1', { type: 'login', name: 'Wifi', login: { username: 'u', password: 'pw-wifi' } }, orgKey, { organizationId: 'org1', collectionIds: ['c1'] });
  const red = org.redactFor('bob', item);
  assert.equal(red.login?.password, undefined);
  assert.equal(red.key, undefined);
  assert.equal(org.redactFor('own', item), item);
  assert.deepEqual(org.visible('bob', [item]).length, 1);
  assert.throws(() => org.redactFor('stranger', item), /not shared/);
  assert.throws(() => org.addCollection('own', 'c1', 'x'), /taken/);
  assert.throws(() => org.addCollection('bob', 'c3', 'x'), /only/);
});

test('managers only manage collections they have manage rights to', () => {
  const { org, orgKey } = setup();
  org.invite('own', 'bob', 'bob@example.com', 'manager');
  org.accept('bob', bob.publicKey);
  org.confirm('own', orgKey, 'bob', fingerprint(bob.publicKey, 'bob'));
  org.addCollection('own', 'c1', 'n', { bob: { readOnly: false, hidePasswords: false, manage: true } });
  org.addCollection('own', 'c2', 'n');
  org.setAccess('bob', 'c1', 'own', { readOnly: true, hidePasswords: false, manage: false });
  assert.throws(() => org.setAccess('bob', 'c2', 'own', null), /manage rights/);
});

test('removing members: last owner is protected and access is cleared', () => {
  const { org, orgKey } = setup();
  org.invite('own', 'bob', 'bob@example.com', 'admin');
  org.accept('bob', bob.publicKey);
  org.confirm('own', orgKey, 'bob', fingerprint(bob.publicKey, 'bob'));
  org.addCollection('own', 'c1', 'n', { bob: { readOnly: false, hidePasswords: false, manage: false } });
  assert.throws(() => org.remove('bob', 'own'), /only an owner/);
  assert.throws(() => org.remove('own', 'own'), /at least one owner/);
  org.remove('own', 'bob');
  assert.equal(org.member('bob'), undefined);
  assert.deepEqual(org.collection('c1')?.access, {});
});

test('rotating the organisation key re-wraps items and re-seals every member key', () => {
  const { org, orgKey } = setup();
  org.invite('own', 'bob', 'bob@example.com', 'user');
  org.accept('bob', bob.publicKey);
  org.confirm('own', orgKey, 'bob', fingerprint(bob.publicKey, 'bob'));
  const item = encryptItem('i1', { type: 'login', name: 'Wifi', login: { password: 'pw-wifi' } }, orgKey, { organizationId: 'org1', collectionIds: ['c1'] });
  const mine = encryptItem('i2', { type: 'note', name: 'private' }, symKey(det(64)));
  const r = org.rotateKey('own', orgKey, [item, mine]);
  assert.equal(org.keyVersion, 2);
  assert.deepEqual(keyBytes(org.openKey('bob', bob.privateKey)), keyBytes(r.newKey));
  assert.equal(decryptItem(r.items[0]!, r.newKey).login?.password, 'pw-wifi');
  assert.throws(() => decryptItem(r.items[0]!, orgKey), VaultError);
  assert.equal(r.items[1], mine);
  assert.throws(() => org.rotateKey('bob', orgKey, []), /only owner or admin/);
});

test('send: the link secret opens what the server relays, and the server enforces its rules', () => {
  const userKey = symKey(det(64));
  const now = 1_700_000_000_000;
  const { send, urlKey } = createSend({ id: 's1', name: 'Wifi', text: 'the code is 4821', userKey, now, deleteInDays: 7, expiresInDays: 2, maxAccessCount: 2, random: det });
  assert.ok(!JSON.stringify(send).includes('4821'));
  assert.equal(urlKey.length, 22);
  const a1 = accessSend(send, now + 1000);
  assert.deepEqual(openSend(a1.payload, urlKey), { name: 'Wifi', text: 'the code is 4821' });
  const a2 = accessSend(a1.send, now + 2000);
  assert.equal(a2.send.accessCount, 2);
  assert.throws(() => accessSend(a2.send, now + 3000), /not available/);
  assert.throws(() => openSend(a1.payload, 'A'.repeat(22)), VaultError);
  assert.throws(() => openSend(a1.payload, 'short'), /not a send link/);
  const fresh = createSend({ id: 's2', name: 'n', text: 't', userKey, now, deleteInDays: 7, expiresInDays: 2 });
  assert.throws(() => accessSend(fresh.send, now + 2 * DAY), /not available/);
  assert.throws(() => accessSend({ ...fresh.send, disabled: true }, now), /not available/);
  assert.throws(() => accessSend({ ...fresh.send, expiresAt: null }, now + 8 * DAY), /not available/);
});

test('send passwords and creation rules', () => {
  const userKey = symKey(det(64));
  const now = 1_700_000_000_000;
  const { send } = createSend({ id: 's1', name: 'n', text: 't', userKey, now, deleteInDays: 3, password: 'open sesame' });
  assert.throws(() => accessSend(send, now), /needs its password/);
  assert.throws(() => accessSend(send, now, 'nope nope'), /needs its password/);
  assert.equal(accessSend(send, now, 'open sesame').send.accessCount, 1);
  assert.throws(() => createSend({ id: 's', name: 'n', text: 't', userKey, now, deleteInDays: 40 }), /31 days/);
  assert.throws(() => createSend({ id: 's', name: 'n', text: 't', userKey, now, deleteInDays: 3, expiresInDays: 5 }), /cannot expire/);
  assert.throws(() => createSend({ id: 's', name: 'n', text: 't', userKey, now, deleteInDays: 3, maxAccessCount: 0 }), /whole number/);
  assert.throws(() => createSend({ id: 's', name: 'n', text: 't', userKey, now, deleteInDays: 3, password: 'abc' }), /4 characters/);
});

test('emergency access: waiting period, refusal, approval and viewing the key', () => {
  const owner = mk('own', 'owner@example.com', 'owner pw', alice);
  const t0 = 1_700_000_000_000;
  let r = inviteEmergency('own', 'Friend@Example.com', 'view', 7);
  assert.equal(r.granteeEmail, 'friend@example.com');
  assert.throws(() => initiateEmergency(r, t0), /not been confirmed/);
  r = acceptEmergency(r, bob.publicKey);
  assert.throws(() => confirmEmergency(r, owner.unlocked.userKey, 'friend', 'aaaa-bbbb'), /fingerprint/);
  r = confirmEmergency(r, owner.unlocked.userKey, 'friend', fingerprint(bob.publicKey, 'friend'));
  assert.throws(() => emergencyKey(r, bob.privateKey, t0), /not been granted/);
  r = initiateEmergency(r, t0);
  assert.equal(emergencyDaysLeft(r, t0 + 2 * DAY), 5);
  assert.throws(() => emergencyKey(r, bob.privateKey, t0 + 2 * DAY), /5 day/);
  assert.equal(emergencyAt(r, t0 + 7 * DAY).status, 'approved');
  assert.deepEqual(keyBytes(emergencyKey(r, bob.privateKey, t0 + 7 * DAY)), keyBytes(owner.unlocked.userKey));
  const refused = decideEmergency(r, false);
  assert.equal(refused.status, 'rejected');
  assert.throws(() => emergencyKey(refused, bob.privateKey, t0 + 30 * DAY), /not been granted/);
  assert.equal(decideEmergency(r, true).status, 'approved');
  assert.throws(() => decideEmergency(refused, true), /no request/);
  assert.throws(() => inviteEmergency('own', 'nope', 'view', 7), /email/);
  assert.throws(() => inviteEmergency('own', 'a@b.c', 'view', 0), /1 to 90/);
});

test('emergency takeover sets a new master password; view-only contacts cannot', () => {
  const owner = mk('own', 'owner@example.com', 'owner pw', alice);
  const t0 = 1_700_000_000_000;
  const go = (type: 'view' | 'takeover') => {
    let r = inviteEmergency('own', 'friend@example.com', type, 3);
    r = acceptEmergency(r, bob.publicKey);
    r = confirmEmergency(r, owner.unlocked.userKey, 'friend', fingerprint(bob.publicKey, 'friend'));
    return initiateEmergency(r, t0);
  };
  assert.throws(() => emergencyTakeover(go('view'), owner.record, bob.privateKey, 'new pw', t0 + 4 * DAY, { allowWeakKdf: true }), /view, not take over/);
  assert.throws(() => emergencyTakeover(go('takeover'), owner.record, bob.privateKey, 'new pw', t0 + DAY), /not yet granted/);
  const next = emergencyTakeover(go('takeover'), owner.record, bob.privateKey, 'new pw', t0 + 4 * DAY, { allowWeakKdf: true });
  assert.deepEqual(keyBytes(login(next, 'new pw', true).unlock().userKey), keyBytes(owner.unlocked.userKey));
  assert.throws(() => login(next, 'owner pw', true).unlock(), VaultError);
});

test('stretch gives distinct enc and mac keys and the fingerprint is stable and key-bound', () => {
  const s = stretch(Buffer.alloc(32, 9));
  assert.notDeepEqual(s.enc, s.mac);
  assert.equal(keyBytes(s).length, 64);
  assert.throws(() => stretch(Buffer.alloc(16)), /32 bytes/);
  const f = fingerprint(alice.publicKey, 'u');
  assert.match(f, /^([0-9a-f]{4}-){9}[0-9a-f]{4}$/);
  assert.equal(f, fingerprint(alice.publicKey, 'u'));
  assert.notEqual(f, fingerprint(bob.publicKey, 'u'));
  assert.notEqual(f, fingerprint(alice.publicKey, 'v'));
});
