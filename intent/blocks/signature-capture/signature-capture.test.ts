import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { Consent } from '../consent/index.ts';
import { CaptureRefused, SignatureCapture, flagsOf, inspectImage, intentStatement, measure, strokesToSvg, typedToSvg } from './index.ts';
import type { DeviceEvidence, Point, SignatureBody, Stroke } from './index.ts';

const pad = { width: 400, height: 150 };
const docHash = createHash('sha256').update('the lease').digest('hex');
const evidence: DeviceEvidence = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (X11; Linux)', timezone: 'America/New_York', locale: 'en-US', screen: { width: 1280, height: 800 }, pointer: 'touch' };
const wiggle = (n = 40, dt = 7): Stroke => Array.from({ length: n }, (_, i): Point => ({ x: 10 + i * 8, y: 75 + Math.sin(i / 3) * 30, t: i * dt + (i % 3) }));

const setup = () => {
  const clock = { d: new Date('2025-03-03T12:00:00Z') };
  const consent = new Consent(() => clock.d);
  consent.publish({ doc: 'esign', version: 1, effective: '2025-01-01', requiresAgreement: true, required: true, summary: 'Electronic signature disclosure' });
  consent.agree('s1', 'esign', 'signing page');
  let n = 0;
  const key = randomBytes(24).toString('hex');
  const cap = new SignatureCapture({ consent, consentDoc: 'esign', sealKey: key, now: () => clock.d, newId: () => `sig${++n}` });
  const base = (body: SignatureBody, o: Partial<Parameters<SignatureCapture['capture']>[0]> = {}) => ({ signerId: 's1', signerName: 'Ana Silva', documentSha256: docHash, documentTitle: 'Lease', intentShown: intentStatement('Ana Silva', 'Lease'), body, evidence, ...o });
  return { clock, consent, cap, base, key };
};

const png = (w: number, h: number) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const jpeg = (w: number, h: number) => {
  const b = Buffer.alloc(30);
  b[0] = 0xff; b[1] = 0xd8;
  b[2] = 0xff; b[3] = 0xe0; b.writeUInt16BE(6, 4);
  b[10] = 0xff; b[11] = 0xc0; b.writeUInt16BE(11, 12); b[14] = 8; b.writeUInt16BE(h, 15); b.writeUInt16BE(w, 17);
  return b;
};

test('a drawn signature is measured: points, length, duration, box and speed', () => {
  const s = measure([[{ x: 0, y: 0, t: 0 }, { x: 30, y: 40, t: 10 }, { x: 30, y: 40, t: 10 }], [{ x: 100, y: 10, t: 50 }, { x: 100, y: 60, t: 60 }]], pad);
  assert.equal(s.strokes, 2);
  assert.equal(s.points, 5);
  assert.equal(s.length, 100);
  assert.equal(s.durationMs, 60);
  assert.deepEqual(s.bbox, { x0: 0, y0: 0, x1: 100, y1: 60 });
  assert.equal(s.maxSpeed, 5);
});

test('hostile strokes are refused: empty, outside the pad, NaN, backwards time, huge, bad pressure', () => {
  assert.throws(() => measure([], pad), /nothing was drawn/);
  assert.throws(() => measure([[]], pad), /no points/);
  assert.throws(() => measure([[{ x: 401, y: 0, t: 0 }]], pad), /outside the pad/);
  assert.throws(() => measure([[{ x: -1, y: 0, t: 0 }]], pad), /outside the pad/);
  assert.throws(() => measure([[{ x: NaN, y: 0, t: 0 }]], pad), /missing a number/);
  assert.throws(() => measure([[{ x: 1, y: 0, t: Infinity }]], pad), /missing a number/);
  assert.throws(() => measure([[{ x: 1, y: 1, t: 5 }, { x: 2, y: 2, t: 4 }]], pad), /out of time order/);
  assert.throws(() => measure([[{ x: 1, y: 1, t: 0, p: 2 }]], pad), /pressure/);
  assert.throws(() => measure(Array.from({ length: 101 }, () => [{ x: 1, y: 1, t: 0 }]), pad), /more than 100 strokes/);
  assert.throws(() => measure([Array.from({ length: 5001 }, (_, i) => ({ x: 1, y: 1, t: i }))], pad), /more than 5000 points/);
  assert.throws(() => measure([[{ x: 1, y: 1, t: 0 }]], { width: 0, height: 10 }), /pad size/);
});

test('flags: scripted-looking drawings are marked, a natural wiggle is not', () => {
  const natural = [wiggle()];
  assert.deepEqual(flagsOf(natural, measure(natural, pad)), []);
  const line: Stroke = Array.from({ length: 30 }, (_, i) => ({ x: 10 + i * 5, y: 50, t: i * 7 + (i % 4) }));
  assert.deepEqual(flagsOf([line], measure([line], pad)), ['perfectly-straight']);
  const notime: Stroke = Array.from({ length: 30 }, (_, i) => ({ x: 10 + i * 5, y: 20 + (i % 5) * 9, t: 0 }));
  assert.ok(flagsOf([notime], measure([notime], pad)).includes('no-timing'));
  const regular: Stroke = Array.from({ length: 30 }, (_, i) => ({ x: 10 + i * 5, y: 20 + (i % 5) * 9, t: i * 8 }));
  assert.ok(flagsOf([regular], measure([regular], pad)).includes('machine-regular'));
  const fast: Stroke = [{ x: 0, y: 0, t: 0 }, { x: 300, y: 100, t: 5 }, { x: 10, y: 10, t: 6 }];
  assert.ok(flagsOf([fast], measure([fast], pad)).includes('too-fast'));
});

test('the SVG from strokes has rounded numbers, lines for strokes and dots for single points', () => {
  const svg = strokesToSvg([[{ x: 1.23456, y: 2, t: 0 }, { x: 3, y: 4.5, t: 1 }], [{ x: 10, y: 10, t: 2 }]], pad);
  assert.match(svg, /<path d="M1\.23 2L3 4\.5"\/>/);
  assert.match(svg, /<circle cx="10" cy="10" r="1\.5"\/>/);
  assert.match(svg, /viewBox="0 0 400 150"/);
});

test('typed signatures: NFC, collapsed spaces, escaped in the SVG, only named styles, no direction tricks', () => {
  const t = typedToSvg('  José   <b>Silva</b> ', 'script-2');
  assert.equal(t.name, 'José <b>Silva</b>');
  assert.ok(!t.svg.includes('<b>'));
  assert.match(t.svg, /&#60;b&#62;Silva/);
  assert.match(t.svg, /Brush Script MT/);
  assert.throws(() => typedToSvg('Ana', 'comic-sans' as never), /not one of the signature styles/);
  assert.throws(() => typedToSvg('   ', 'script-1'), /empty/);
  assert.throws(() => typedToSvg('Ana‮live', 'script-1'), /direction-changing/);
  assert.throws(() => typedToSvg('Ana\nSilva', 'script-1'), /control/);
  assert.throws(() => typedToSvg('x'.repeat(101), 'script-1'), /longer than 100/);
});

test('uploaded images are read from their bytes: type and real dimensions, hash of the file', () => {
  const p = inspectImage(png(300, 100));
  assert.deepEqual([p.type, p.width, p.height, p.bytes], ['png', 300, 100, 33]);
  assert.equal(p.sha256, createHash('sha256').update(png(300, 100)).digest('hex'));
  const j = inspectImage(jpeg(640, 200));
  assert.deepEqual([j.type, j.width, j.height], ['jpeg', 640, 200]);
});

test('uploads that are not a small PNG or JPEG are refused, whatever they are named', () => {
  assert.throws(() => inspectImage(new Uint8Array(0)), /empty/);
  assert.throws(() => inspectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')), /not a PNG or JPEG/);
  assert.throws(() => inspectImage(Buffer.from('GIF89a......................')), /not a PNG or JPEG/);
  assert.throws(() => inspectImage(png(10, 10)), /too small/);
  assert.throws(() => inspectImage(png(5000, 100)), /larger than 4000 by 2000/);
  assert.throws(() => inspectImage(Buffer.concat([png(300, 100), Buffer.alloc(1_000_000)])), /larger than 1 MB/);
  assert.throws(() => inspectImage(Buffer.from([0x89, 0x50, 0x4e, 0x47])), /not a PNG or JPEG/);
});

test('a drawn capture stores the stroke picture, the exact intent text, the evidence and a verifiable seal', () => {
  const { cap, base } = setup();
  const r = cap.capture(base({ method: 'drawn', pad, strokes: [wiggle()] }));
  assert.equal(r.method, 'drawn');
  assert.equal(r.intent.text, 'I, Ana Silva, have read "Lease" and intend to sign it electronically. I understand my signature has the same effect as a handwritten one.');
  assert.equal(r.intent.textSha256, createHash('sha256').update(r.intent.text).digest('hex'));
  assert.equal(r.intent.acceptedAt, '2025-03-03T12:00:00.000Z');
  assert.equal(r.stats?.points, 40);
  assert.deepEqual(r.flags, []);
  assert.equal(r.evidence.ip, '203.0.113.7');
  assert.equal(r.documentSha256, docHash);
  assert.ok(r.svg?.startsWith('<svg'));
  assert.deepEqual(cap.verify(r), { ok: true });
});

test('typed and uploaded captures work the same way', () => {
  const { cap, base, clock } = setup();
  const r = cap.capture(base({ method: 'typed', name: 'Ana Silva', style: 'script-1' }));
  assert.equal(r.method, 'typed');
  assert.ok(r.svg?.includes('Ana Silva'));
  assert.deepEqual(cap.verify(r), { ok: true });
  clock.d = new Date('2025-03-04T00:00:00Z');
  const u = setup();
  const r2 = u.cap.capture(u.base({ method: 'uploaded', bytes: png(300, 100) }));
  assert.equal(r2.image?.type, 'png');
  assert.equal(r2.svg, undefined);
  assert.deepEqual(u.cap.verify(r2), { ok: true });
});

test('any change to a record is detected: the picture, the evidence, the intent, the seal', () => {
  const { cap, base } = setup();
  const r = cap.capture(base({ method: 'drawn', pad, strokes: [wiggle()] }));
  assert.match(cap.verify({ ...r, svg: r.svg + ' ' }).why!, /changed after capture/);
  assert.match(cap.verify({ ...r, evidence: { ...r.evidence, ip: '198.51.100.1' } }).why!, /changed after capture/);
  assert.match(cap.verify({ ...r, documentSha256: '0'.repeat(64) }).why!, /changed after capture/);
  // Someone who recomputes the hash but has no key cannot make a matching seal.
  const rest = { ...r, evidence: { ...r.evidence, ip: '198.51.100.1' } };
  const forged = { ...rest, bundleSha256: createHash('sha256').update('x').digest('hex') };
  assert.equal(cap.verify(forged).ok, false);
  const other = setup();
  assert.equal(other.cap.verify(r).ok, false, 'a record is not valid under another key');
});

test('signing needs agreement to the e-sign disclosure, and withdrawing it stops signing', () => {
  const { cap, base, consent } = setup();
  assert.throws(() => cap.capture(base({ method: 'typed', name: 'Bo', style: 'script-1' }, { signerId: 's2', signerName: 'Bo' })), /s2 has not agreed to esign/);
  consent.publish({ doc: 'esign', version: 2, effective: '2025-01-02', requiresAgreement: true, required: true, summary: 'New terms' });
  assert.throws(() => cap.capture(base({ method: 'typed', name: 'Ana Silva', style: 'script-1' })), /has not agreed/, 'a new version needs agreeing again');
});

test('the intent must be the exact statement for this document and signer', () => {
  const { cap, base } = setup();
  const body: SignatureBody = { method: 'typed', name: 'Ana Silva', style: 'script-1' };
  assert.throws(() => cap.capture(base(body, { intentShown: 'I agree' })), /not the statement for this document/);
  assert.throws(() => cap.capture(base(body, { intentShown: intentStatement('Ana Silva', 'Other document') })), /not the statement/);
  assert.throws(() => cap.capture(base(body, { documentSha256: 'xyz' })), /64 hex/);
});

test('a drawing too short to mean anything is refused, and a second signature needs a clear first', () => {
  const { cap, base } = setup();
  assert.throws(() => cap.capture(base({ method: 'drawn', pad, strokes: [[{ x: 1, y: 1, t: 0 }, { x: 5, y: 5, t: 10 }]] })), /too short/);
  cap.capture(base({ method: 'drawn', pad, strokes: [wiggle()] }));
  assert.throws(() => cap.capture(base({ method: 'drawn', pad, strokes: [wiggle()] })), /already signed/);
  cap.clear('s1', docHash);
  assert.ok(cap.capture(base({ method: 'drawn', pad, strokes: [wiggle(30)] })));
});

test('once a document is locked, no signature can be added or cleared', () => {
  const { cap, base } = setup();
  cap.capture(base({ method: 'typed', name: 'Ana Silva', style: 'script-3' }));
  const all = cap.lock(docHash);
  assert.equal(all.length, 1);
  assert.throws(() => cap.clear('s1', docHash), /locked/);
  assert.throws(() => cap.capture(base({ method: 'typed', name: 'Ana Silva', style: 'script-3' })), /locked/);
  assert.equal(cap.forDocument(docHash).length, 1);
});

test('device evidence is checked and cleaned: IP form, zone, screen, pointer, control characters, length', () => {
  const { cap, base } = setup();
  const body: SignatureBody = { method: 'typed', name: 'Ana Silva', style: 'script-1' };
  assert.throws(() => cap.capture(base(body, { evidence: { ...evidence, ip: 'localhost' } })), /not an IP address/);
  assert.throws(() => cap.capture(base(body, { evidence: { ...evidence, timezone: 'Mars/Olympus' } })), /not a real zone/);
  assert.throws(() => cap.capture(base(body, { evidence: { ...evidence, screen: { width: -1, height: 5 } } })), /screen size/);
  assert.throws(() => cap.capture(base(body, { evidence: { ...evidence, pointer: 'telepathy' as never } })), /pointer type/);
  assert.throws(() => cap.capture(base(body, { evidence: { ...evidence, userAgent: '' } })), /browser identification/);
  const r = cap.capture(base(body, { evidence: { ...evidence, ip: '2001:db8::1', userAgent: 'A\r\nX-Injected: 1' + 'b'.repeat(400) } }));
  assert.equal(r.evidence.ip, '2001:db8::1');
  assert.ok(!/[\r\n]/.test(r.evidence.userAgent));
  assert.equal(r.evidence.userAgent.length, 300);
});

test('a short sealing key is refused', () => {
  const { consent } = setup();
  assert.throws(() => new SignatureCapture({ consent, consentDoc: 'esign', sealKey: 'short', now: () => new Date(), newId: () => 'x' }), CaptureRefused);
});
