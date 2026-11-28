import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { test } from 'node:test';
import { DkimRefused, aligned, bodyHash, canonBody, canonHeader, fromDomain, parseKeyRecord, rotationPlan, selectorRecord, sign, splitMessage, txtChunks, verify } from './index.ts';
import type { Algorithm } from './index.ts';

const NOW = Date.parse('2025-06-01T12:00:00Z');
const msg = (extra = '') => `From: Ann Lee <ann@example.com>\r\nTo: bob@example.org\r\nSubject: Hello   there\r\nDate: Sun, 01 Jun 2025 11:59:00 +0000\r\nMessage-ID: <1@example.com>\r\n${extra}\r\nHi Bob,\r\n\r\nSee you at noon.  \r\n\r\n\r\n`;

const keys: Record<Algorithm, { priv: KeyObject; pub: KeyObject }> = {
  'rsa-sha256': (() => { const k = generateKeyPairSync('rsa', { modulusLength: 2048 }); return { priv: k.privateKey, pub: k.publicKey }; })(),
  'ed25519-sha256': (() => { const k = generateKeyPairSync('ed25519'); return { priv: k.privateKey, pub: k.publicKey }; })(),
};
const dns = (alg: Algorithm, o: { testing?: boolean } = {}) => ({ 'sel1._domainkey.example.com': [selectorRecord(keys[alg].pub, alg, o)] }) as Record<string, string[]>;
const lookupOf = (zone: Record<string, readonly string[]>) => async (n: string) => zone[n] ?? [];
const opts = (zone: Record<string, readonly string[]>, now = NOW) => ({ lookup: lookupOf(zone), now: () => now });
const signer = (alg: Algorithm) => ({ domain: 'example.com', selector: 'sel1', privateKey: keys[alg].priv, algorithm: alg });
const signed = (alg: Algorithm, m = msg(), o: Partial<Parameters<typeof sign>[2]> = {}) => `${sign(m, signer(alg), { now: () => NOW, ...o })}\r\n${m}`;

test('RFC 6376 section 3.4.5: the simple and relaxed body examples', () => {
  const body = ' C \r\nD \t E\r\n\r\n\r\n';
  assert.equal(canonBody(body, 'simple'), ' C \r\nD \t E\r\n');
  assert.equal(canonBody(body, 'relaxed'), ' C\r\nD E\r\n');
});

test('RFC 6376 section 3.4.5: the relaxed header example, and simple keeps headers as written', () => {
  const { headers } = splitMessage('A: X\r\nB : Y\t\r\n\tZ  \r\n\r\n C \r\nD \t E\r\n\r\n\r\n');
  assert.equal(headers.map((h) => canonHeader(h, 'relaxed')).join(''), 'a:X\r\nb:Y Z\r\n');
  assert.equal(headers.map((h) => canonHeader(h, 'simple')).join(''), 'A: X\r\nB : Y\t\r\n\tZ  \r\n');
});

test('RFC 6376 body hashes of an empty body: simple is the hash of CRLF, relaxed the hash of nothing', () => {
  assert.equal(bodyHash('', 'simple'), 'frcCV1k9oG9oKj3dpUqdJg1PxRT2RSN/XKdLCPjaYaY=');
  assert.equal(bodyHash('', 'relaxed'), '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
  assert.equal(bodyHash('\r\n\r\n', 'simple'), bodyHash('', 'simple'));
  assert.equal(bodyHash('a b  \r\n', 'relaxed'), createHash('sha256').update('a b\r\n').digest('base64'));
});

test('both algorithms sign and verify, under every canonicalisation pair', async () => {
  for (const alg of ['rsa-sha256', 'ed25519-sha256'] as const)
    for (const header of ['simple', 'relaxed'] as const)
      for (const body of ['simple', 'relaxed'] as const) {
        const v = await verify(signed(alg, msg(), { canon: { header, body } }), opts(dns(alg)));
        assert.deepEqual(v.map((x) => x.result), ['pass'], `${alg} ${header}/${body}: ${v[0]!.reason}`);
        assert.equal(v[0]!.domain, 'example.com');
        assert.equal(v[0]!.selector, 'sel1');
      }
});

test('the signature header has the standard tags, the signed headers listed bottom-up with oversigning, and folds lines', () => {
  const h = sign(msg(), signer('rsa-sha256'), { now: () => NOW, expiresInSeconds: 3600 });
  assert.match(h.replace(/\r\n\t/g, ' '), /^DKIM-Signature: v=1; a=rsa-sha256; c=relaxed\/relaxed; d=example\.com; s=sel1; t=1748779200; x=1748782800; h=from:from:to:to:subject:subject:date:date:message-id:message-id; bh=/);
  assert.ok(h.split('\r\n').every((l) => l.length <= 80));
  assert.ok(h.split('\r\n').slice(1).every((l) => l.startsWith('\t')));
  const noOver = sign(msg(), signer('ed25519-sha256'), { now: () => NOW, oversign: false, headers: ['From', 'Subject'] }).replace(/\r\n\t/g, ' ');
  assert.match(noOver, /h=from:subject; bh=/);
  assert.match(noOver, /a=ed25519-sha256/);
});

test('changing the body breaks the body hash', async () => {
  const m = signed('rsa-sha256').replace('See you at noon.', 'See you at one.');
  const v = (await verify(m, opts(dns('rsa-sha256'))))[0]!;
  assert.deepEqual([v.result, v.reason], ['fail', 'the body hash does not match: the body was changed']);
});

test('changing a signed header breaks the signature; adding a second From does too (oversigning)', async () => {
  const z = dns('ed25519-sha256');
  const m = signed('ed25519-sha256');
  const edited = await verify(m.replace('Subject: Hello   there', 'Subject: Pay now'), opts(z));
  assert.equal(edited[0]!.result, 'fail');
  assert.match(edited[0]!.reason, /does not match the headers/);
  const added = await verify(`From: evil@example.net\r\n${m}`, opts(z));
  assert.equal(added[0]!.result, 'fail');
  const unsignedAdded = await verify(`X-Other: 1\r\n${m}`, opts(z));
  assert.equal(unsignedAdded[0]!.result, 'pass', 'headers that were not signed may be added');
});

test('relaxed canonicalisation survives re-wrapping and extra spaces; simple does not', async () => {
  const rewrap = (m: string) => m.replace('Subject: Hello   there', 'Subject: Hello\r\n there ').replace('See you at noon.  ', 'See you at noon.');
  const relaxed = signed('rsa-sha256', msg(), { canon: { header: 'relaxed', body: 'relaxed' } });
  assert.equal((await verify(rewrap(relaxed), opts(dns('rsa-sha256'))))[0]!.result, 'pass');
  const simple = signed('rsa-sha256', msg(), { canon: { header: 'simple', body: 'simple' } });
  assert.equal((await verify(rewrap(simple), opts(dns('rsa-sha256'))))[0]!.result, 'fail');
});

test('a message with bare line feeds is signed and verified as CRLF', async () => {
  const lf = msg().replace(/\r\n/g, '\n');
  const m = `${sign(lf, signer('rsa-sha256'), { now: () => NOW })}\n${lf}`;
  assert.equal((await verify(m, opts(dns('rsa-sha256'))))[0]!.result, 'pass');
});

test('time: expired and future-dated signatures fail; the clock skew is allowed', async () => {
  const m = signed('rsa-sha256', msg(), { expiresInSeconds: 600 });
  const z = dns('rsa-sha256');
  assert.equal((await verify(m, opts(z, NOW + 500_000)))[0]!.result, 'pass');
  assert.equal((await verify(m, opts(z, NOW + 600_000 + 200_000)))[0]!.result, 'pass', 'within five minutes of skew');
  const late = (await verify(m, opts(z, NOW + 600_000 + 400_000)))[0]!;
  assert.deepEqual([late.result, late.reason], ['fail', 'the signature has expired']);
  const early = (await verify(m, opts(z, NOW - 3600_000)))[0]!;
  assert.deepEqual([early.result, early.reason], ['fail', 'the signature is dated in the future']);
});

test('key records: missing, revoked (empty p=), duplicated, wrong type, unreadable, temporary DNS failure', async () => {
  const m = signed('rsa-sha256');
  assert.match((await verify(m, opts({})))[0]!.reason, /no key record/);
  assert.deepEqual((await verify(m, opts({ 'sel1._domainkey.example.com': ['v=DKIM1; k=rsa; p='] })))[0]!, { result: 'fail', reason: 'the key has been revoked (its record is empty)', domain: 'example.com', selector: 'sel1' });
  const rec = dns('rsa-sha256')['sel1._domainkey.example.com']!;
  assert.match((await verify(m, opts({ 'sel1._domainkey.example.com': [...rec, ...rec] })))[0]!.reason, /more than one key record/);
  const ed = dns('ed25519-sha256');
  assert.match((await verify(m, opts(ed)))[0]!.reason, /the key is ed25519, the signature says rsa-sha256/);
  assert.match((await verify(m, opts({ 'sel1._domainkey.example.com': ['v=DKIM1; k=rsa; p=AAAA'] })))[0]!.reason, /cannot be read/);
  const t = await verify(m, { lookup: async () => { throw new Error('SERVFAIL'); }, now: () => NOW });
  assert.equal(t[0]!.result, 'temperror');
});

test('a key marked for testing still passes but says so; a key with a hash list without sha256 is refused', async () => {
  const v = (await verify(signed('ed25519-sha256'), opts(dns('ed25519-sha256', { testing: true }))))[0]!;
  assert.equal(v.result, 'pass');
  assert.equal(v.testing, true);
  assert.match(v.reason, /marked as a test/);
  const rec = dns('rsa-sha256')['sel1._domainkey.example.com']![0]! + '; h=sha1';
  assert.match((await verify(signed('rsa-sha256'), opts({ 'sel1._domainkey.example.com': [rec] })))[0]!.reason, /does not allow sha256/);
});

test('rsa-sha1, unknown algorithms, missing tags, and signatures that skip From are refused', async () => {
  const m = signed('rsa-sha256');
  const z = dns('rsa-sha256');
  assert.match((await verify(m.replace('a=rsa-sha256', 'a=rsa-sha1'), opts(z)))[0]!.reason, /rsa-sha1 signatures are not accepted/);
  assert.match((await verify(m.replace('a=rsa-sha256', 'a=md5'), opts(z)))[0]!.reason, /not supported/);
  assert.match((await verify(m.replace(' d=example.com;', ''), opts(z)))[0]!.reason, /no d= tag/);
  assert.match((await verify(m.replace('v=1', 'v=2'), opts(z)))[0]!.reason, /version is not 1/);
  assert.match((await verify(m.replace(/h=from:from:/, 'h='), opts(z)))[0]!.reason, /does not cover the From/);
  assert.match((await verify(m.replace('s=sel1;', 's=sel1; s=sel2;'), opts(z)))[0]!.reason, /appears twice/);
  assert.deepEqual((await verify(msg(), opts(z))).map((v) => v.result), ['none']);
});

test('signing refuses what it should: no From, wrong key for the algorithm, small RSA, bad names, signing the signature', () => {
  assert.throws(() => sign('To: a@b.co\r\n\r\nx', signer('rsa-sha256'), { now: () => NOW }), /no From header/);
  assert.throws(() => sign(msg(), { ...signer('rsa-sha256'), privateKey: keys['ed25519-sha256'].priv }, { now: () => NOW }), /needs an RSA key/);
  assert.throws(() => sign(msg(), { ...signer('ed25519-sha256'), privateKey: keys['rsa-sha256'].priv }, { now: () => NOW }), /needs an Ed25519 key/);
  const small = generateKeyPairSync('rsa', { modulusLength: 512 }).privateKey;
  assert.throws(() => sign(msg(), { ...signer('rsa-sha256'), privateKey: small }, { now: () => NOW }), /at least 1024/);
  assert.throws(() => sign(msg(), { ...signer('rsa-sha256'), domain: 'bad domain' }, { now: () => NOW }), /not a valid domain/);
  assert.throws(() => sign(msg(), { ...signer('rsa-sha256'), selector: 'a;b' }, { now: () => NOW }), /selector is not valid/);
  assert.throws(() => sign(msg(), signer('rsa-sha256'), { now: () => NOW, headers: ['from', 'DKIM-Signature'] }), /not signed by name/);
});

test('the body length tag: honoured, flagged, and checked against the real length', async () => {
  const m = signed('rsa-sha256').replace(/(bh=[^;]*;)/, '$1 l=5;');
  const v = (await verify(m, opts(dns('rsa-sha256'))))[0]!;
  assert.equal(v.result, 'fail', 'the headers were signed without l, so adding it breaks the signature');
  const huge = (await verify(signed('rsa-sha256').replace(/(bh=[^;]*;)/, '$1 l=99999;'), opts(dns('rsa-sha256'))))[0]!;
  assert.match(huge.reason, /more body than the message has|does not match/);
});

test('selector records: RSA SPKI, raw 32-byte Ed25519 (RFC 8463), flags, and the 255-character split', () => {
  const rsa = selectorRecord(keys['rsa-sha256'].pub, 'rsa-sha256', { testing: true, strict: true });
  assert.match(rsa, /^v=DKIM1; k=rsa; t=y:s; p=MII/);
  const ed = selectorRecord(keys['ed25519-sha256'].pub, 'ed25519-sha256');
  assert.match(ed, /^v=DKIM1; k=ed25519; p=[A-Za-z0-9+/]{43}=$/);
  assert.equal(Buffer.from(ed.split('p=')[1]!, 'base64').length, 32);
  const chunks = txtChunks(rsa);
  assert.ok(chunks.length >= 2 && chunks.every((c) => c.length <= 255));
  assert.equal(chunks.join(''), rsa);
  const parsed = parseKeyRecord(rsa);
  assert.deepEqual([parsed.keyType, parsed.testing, parsed.strict, parsed.revoked], ['rsa', true, true, false]);
  assert.throws(() => parseKeyRecord('v=DKIM2; p=AAAA'), /not DKIM1/);
  assert.throws(() => parseKeyRecord('k=dsa; p=AAAA'), /not supported/);
  assert.throws(() => parseKeyRecord('v=DKIM1; k=rsa'), /no p= tag/);
  assert.throws(() => parseKeyRecord('v=DKIM1; k=ed25519; p=AAAA'), /cannot be read/);
  const weak = generateKeyPairSync('rsa', { modulusLength: 512 }).publicKey;
  assert.throws(() => parseKeyRecord(selectorRecord(weak, 'rsa-sha256')), /under 1024 bits/);
});

test('alignment with the From domain: the same, a subdomain of the signer, and strict mode', async () => {
  const v = (await verify(signed('rsa-sha256'), opts(dns('rsa-sha256'))))[0]!;
  assert.equal(fromDomain(msg()), 'example.com');
  assert.equal(aligned(v, 'example.com'), true);
  assert.equal(aligned(v, 'mail.example.com'), true);
  assert.equal(aligned(v, 'mail.example.com', true), false);
  assert.equal(aligned(v, 'example.org'), false);
  assert.equal(aligned({ ...v, result: 'fail' }, 'example.com'), false);
  assert.equal(fromDomain('From: "A (x)" <a@Sub.Example.com>\r\n\r\n'), 'sub.example.com');
});

test('rotation: a selector per period, the next one published ahead, the last one kept, older ones retired', () => {
  const o = { prefix: 'k', periodDays: 30, publishAheadDays: 5, keepDays: 7 };
  const day = (n: number) => n * 86_400_000;
  const p = Math.floor(NOW / day(30));
  const start = p * 30;
  const early = rotationPlan(o, day(start + 2), [`k${p - 2}`, `k${p - 1}`, `k${p}`, 'other']);
  assert.deepEqual(early, { signWith: `k${p}`, publish: [`k${p - 1}`, `k${p}`], retire: [`k${p - 2}`] });
  const mid = rotationPlan(o, day(start + 15));
  assert.deepEqual(mid, { signWith: `k${p}`, publish: [`k${p}`], retire: [] });
  const late = rotationPlan(o, day(start + 26));
  assert.deepEqual(late.publish, [`k${p}`, `k${p + 1}`]);
  assert.equal(late.signWith, `k${p}`);
  assert.equal(rotationPlan(o, day(start + 30)).signWith, `k${p + 1}`);
  assert.throws(() => rotationPlan({ ...o, periodDays: 0 }, 0), DkimRefused);
});

test('hostile messages: a header with no name, an oversize message, and more than five signatures', async () => {
  assert.throws(() => splitMessage('not a header\r\n\r\nbody'), /no name/);
  assert.throws(() => splitMessage('A: b\r\n\r\n' + 'x'.repeat(25_000_001)), /larger than 25 MB/);
  const six = Array.from({ length: 6 }, () => 'DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=sel1; h=from; bh=x; b=y\r\n').join('');
  const v = await verify(`${six}From: a@example.com\r\n\r\nx`, opts({}));
  assert.deepEqual(v.map((x) => x.result), ['permerror']);
});

test('two signatures (a service and the author) are each checked on their own', async () => {
  const both = `${sign(msg(), { ...signer('ed25519-sha256') }, { now: () => NOW })}\r\n${signed('rsa-sha256')}`;
  const zone = { 'sel1._domainkey.example.com': dns('rsa-sha256')['sel1._domainkey.example.com']! };
  const v = await verify(both, opts(zone));
  assert.deepEqual(v.map((x) => x.result).sort(), ['pass', 'permerror'], 'one passes; the other has no key published');
});
