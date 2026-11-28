import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { sign as signLink } from '../crypto/index.ts';
import { pdf } from '../pdf/index.ts';
import { readForm } from '../pdf-forms/index.ts';
import { Envelope, EnvelopeError } from './index.ts';
import type { Certificate, FieldSpec, Message } from './index.ts';

const T0 = Date.UTC(2026, 2, 2, 9, 0, 0);
const HOUR = 3_600_000;
const SECRET = createHash('sha256').update('esign-envelope test key 1').digest('hex');

function clock() {
  const c = { t: T0 };
  return { c, now: () => c.t };
}

function make(opts: { days?: number } = {}) {
  const { c, now } = clock();
  let n = 0;
  const env = new Envelope({ now, secret: SECRET, baseUrl: 'https://sign.example.com', ids: () => `env${++n}` }, { subject: 'Services agreement', sender: { name: 'Sam Ortiz', email: 'Sam@Example.com' }, ...(opts.days ? { expiresInDays: opts.days } : {}) });
  return { env, c };
}

const DOC = pdf([{ h: 'Services agreement' }, { p: 'The supplier will deliver the services described.' }, { p: 'Signed by both parties.' }], { title: 'Agreement', size: 'Letter' });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const place = { x: 72, y: 600, width: 200, height: 30 };
const sigField = (id: string, signer: string, over: Partial<FieldSpec> = {}): FieldSpec => ({ id, signer, document: 'd1', page: 0, at: place, kind: 'signature', ...over });

/** An envelope with Ana (step 1) and Bo (step 2), each with a signature, sent. */
function sequential() {
  const x = make();
  x.env.addDocument({ id: 'd1', name: 'Agreement.pdf', bytes: DOC, pages: 1 });
  x.env.addSigner({ id: 'ana', name: 'Ana Rivera', email: 'ana@example.com', order: 1 });
  x.env.addSigner({ id: 'bo', name: 'Bo Chen', email: 'bo@example.com', order: 2 });
  x.env.addField(sigField('s1', 'ana'));
  x.env.addField(sigField('s2', 'bo', { at: { ...place, y: 650 } }));
  const sent = x.env.send();
  return { ...x, sent };
}

const token = (m: Message) => new URL(m.link!).pathname.split('/').pop()!;
const typed = (name: string) => ({ typed: name });

test('a draft is built from documents, signers and fields; every mistake is reported together', () => {
  const { env } = make();
  env.addDocument({ id: 'd1', name: 'A.pdf', bytes: DOC, pages: 2 });
  env.addSigner({ id: 'ana', name: 'Ana', email: 'ana@example.com' });
  env.addSigner({ id: 'cc', name: 'Copy', email: 'copy@example.com', role: 'viewer' });
  assert.throws(() => env.addDocument({ id: 'd1', name: 'again', bytes: DOC, pages: 1 }), /already used/);
  assert.throws(() => env.addDocument({ id: 'd2', name: 'empty', bytes: new Uint8Array(0), pages: 1 }), /empty/);
  assert.throws(() => env.addSigner({ id: 'x y', name: ' ', email: 'nope', role: 'boss' as never, order: 0, accessCode: 'ab' }), (e: unknown) => {
    assert.ok(e instanceof EnvelopeError);
    assert.deepEqual(e.problems, ['signer id "x y" is not valid or is already used', 'a signer needs a name', '"nope" is not an email address', 'role "boss" is not signer, approver or viewer', 'order is a whole number from 1 to 100', 'an access code has at least 4 characters']);
    return true;
  });
  assert.throws(() => env.addSigner({ id: 'ana2', name: 'Ana Again', email: 'ANA@example.com' }), /already a recipient at this step/);
  const bad = () => env.addField({ id: 'f', signer: 'ghost', document: 'nodoc', page: 9, at: { x: 0, y: 0, width: 0, height: 5 }, kind: 'scribble' as never, pattern: '(' });
  assert.throws(bad, (e: unknown) => {
    assert.ok(e instanceof EnvelopeError);
    assert.deepEqual(e.problems, ['there is no signer "ghost"', 'there is no document "nodoc"', '"scribble" is not a field type', 'the pattern is not a valid regular expression', 'the field needs a place with a size']);
    return true;
  });
  assert.throws(() => env.addField(sigField('v', 'cc')), /a viewer has no fields/);
  assert.throws(() => env.addField(sigField('p', 'ana', { page: 2 })), /A\.pdf has 2 page\(s\); there is no page 3/);
  assert.throws(() => env.addField(sigField('o', 'ana', { options: ['a'] })), /only a dropdown has options/);
  assert.throws(() => env.addField({ ...sigField('dd', 'ana'), kind: 'dropdown', options: ['a', 'a'] }), /one or more different options/);
  assert.throws(() => env.addField(sigField('fr', 'ana', { at: { x: 0.5, y: 0.5, width: 0.6, height: 0.1, unit: 'fraction' } })), /within it/);
  assert.throws(() => env.addField(sigField('re', 'ana', { kind: 'text', pattern: '(a+)+$' })), /could take very long/);
  env.addField(sigField('ok', 'ana'));
  assert.throws(() => env.addField(sigField('ok', 'ana')), /already used/);
});

test('sending is refused until the envelope is ready, and says everything that is missing', () => {
  const { env } = make();
  assert.throws(() => env.send(), (e: unknown) => {
    assert.ok(e instanceof EnvelopeError);
    assert.deepEqual(e.problems, ['add at least one document', 'add at least one signer or approver']);
    return true;
  });
  env.addDocument({ id: 'd1', name: 'A.pdf', bytes: DOC, pages: 1 });
  env.addSigner({ id: 'ana', name: 'Ana', email: 'ana@example.com' });
  env.addSigner({ id: 'bo', name: 'Bo', email: 'bo@example.com', order: 2 });
  env.addField({ id: 't', signer: 'bo', document: 'd1', page: 0, at: place, kind: 'text', required: false });
  assert.throws(() => env.send(), (e: unknown) => {
    assert.ok(e instanceof EnvelopeError);
    assert.deepEqual(e.problems, ['Ana has no fields', 'Bo has no required signature field']);
    return true;
  });
  assert.equal(env.state, 'draft');
});

test('sending notifies only the first step, with a link that names that person', () => {
  const { env, sent } = sequential();
  assert.equal(env.state, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, 'ana@example.com');
  assert.equal(sent[0]!.kind, 'request');
  assert.equal(sent[0]!.subject, 'Sam Ortiz sent you "Services agreement" to sign');
  assert.match(sent[0]!.link!, /^https:\/\/sign\.example\.com\/sign\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(env.snapshot().signers.map((s) => s.status), ['notified', 'pending']);
});

test('once sent, the envelope cannot be edited', () => {
  const { env } = sequential();
  assert.throws(() => env.addSigner({ id: 'z', name: 'Z', email: 'z@example.com' }), /sent; only a draft can be changed/);
  assert.throws(() => env.addDocument({ id: 'd9', name: 'x', bytes: DOC, pages: 1 }), /only a draft/);
  assert.throws(() => env.addField(sigField('late', 'ana')), /only a draft/);
  assert.throws(() => env.setReminders({ afterHours: 1, everyHours: 1, max: 1 }), /only a draft/);
  assert.throws(() => env.send(), /not possible from sent/);
});

test('a signer sees their fields on opening, and the first look is recorded once', () => {
  const { env, sent, c } = sequential();
  const v1 = env.open(token(sent[0]!), { ip: '203.0.113.9', agent: 'UnitTest/1.0' });
  assert.equal(v1.canSign, true);
  assert.deepEqual(v1.fields.map((f) => f.id), ['s1']);
  assert.deepEqual(v1.documents.map((d) => d.id), ['d1']);
  c.t += HOUR;
  env.open(token(sent[0]!), { ip: '198.51.100.1' });
  const ana = env.snapshot().signers[0]!;
  assert.equal(ana.status, 'viewed');
  assert.equal(ana.evidence.viewedAt, new Date(T0).toISOString(), 'the first view is the one kept');
  assert.equal(ana.evidence.viewIp, '203.0.113.9');
  assert.equal(env.snapshot().trail.filter((e) => e.action === 'viewed').length, 1);
});

test('routing order is enforced: the second signer waits, and is notified when the first is done', () => {
  const { env, sent, c } = sequential();
  const bo = env.open(resend(env, 'bo'));
  assert.equal(bo.canSign, false);
  assert.deepEqual(bo.waitingFor, ['Ana Rivera']);
  assert.equal(bo.note, 'waiting for Ana Rivera');
  assert.throws(() => env.sign(resend(env, 'bo'), { values: { s2: typed('Bo Chen') }, consent: true }), /not your turn: waiting for Ana Rivera/);
  assert.throws(() => env.decline(resend(env, 'bo'), 'no'), /not your turn/);
  c.t += HOUR;
  const next = env.sign(token(sent[0]!), { values: { s1: typed('Ana Rivera') }, consent: true, ip: '203.0.113.9', agent: 'UnitTest/1.0' });
  assert.deepEqual(next.map((m) => [m.kind, m.to]), [['request', 'bo@example.com']]);
  assert.equal(env.state, 'sent');
  env.sign(token(next[0]!), { values: { s2: typed('Bo Chen') }, consent: true });
  assert.equal(env.state, 'completed');
});

/** A link for a signer made with the same key and purpose the envelope uses, as a resend would. */
function resend(env: Envelope, id: string): string {
  const last = env.snapshot().trail.at(-1)!;
  return signLink(SECRET, 'esign-access', { e: env.id, s: id }, 24 * HOUR, Date.parse(last.at));
}

test('signers at the same step act at the same time, and the envelope completes when the last finishes', () => {
  const { env } = make();
  env.addDocument({ id: 'd1', name: 'A.pdf', bytes: DOC, pages: 1 });
  env.addSigner({ id: 'a', name: 'Ana Rivera', email: 'ana@example.com' });
  env.addSigner({ id: 'b', name: 'Bo Chen', email: 'bo@example.com' });
  env.addSigner({ id: 'cc', name: 'Records', email: 'records@example.com', role: 'viewer', order: 3 });
  env.addField(sigField('sa', 'a'));
  env.addField(sigField('sb', 'b', { at: { ...place, y: 650 } }));
  const sent = env.send();
  assert.deepEqual(sent.map((m) => m.to).sort(), ['ana@example.com', 'bo@example.com']);
  const first = env.sign(token(sent.find((m) => m.to === 'bo@example.com')!), { values: { sb: typed('Bo') }, consent: true });
  assert.deepEqual(first, [], 'nobody is notified; Ana is still to sign');
  assert.equal(env.state, 'sent');
  const done = env.sign(token(sent.find((m) => m.to === 'ana@example.com')!), { values: { sa: typed('Ana') }, consent: true });
  assert.equal(env.state, 'completed');
  assert.deepEqual(done.map((m) => m.to).sort(), ['ana@example.com', 'bo@example.com', 'records@example.com', 'sam@example.com']);
  assert.ok(done.every((m) => m.kind === 'completed'));
});

test('a submission is checked against the signer\'s own fields, and every problem is reported at once', () => {
  const { env } = make();
  env.addDocument({ id: 'd1', name: 'A.pdf', bytes: DOC, pages: 1 });
  env.addSigner({ id: 'a', name: 'Ana Rivera', email: 'ana@example.com' });
  env.addSigner({ id: 'b', name: 'Bo', email: 'bo@example.com' });
  env.addField(sigField('sig', 'a'));
  env.addField({ id: 'ini', signer: 'a', document: 'd1', page: 0, at: place, kind: 'initials' });
  env.addField({ id: 'role', signer: 'a', document: 'd1', page: 0, at: place, kind: 'dropdown', options: ['Buyer', 'Seller'], label: 'Your role' });
  env.addField({ id: 'zip', signer: 'a', document: 'd1', page: 0, at: place, kind: 'text', pattern: '\\d{5}', label: 'ZIP' });
  env.addField({ id: 'note', signer: 'a', document: 'd1', page: 0, at: place, kind: 'text', maxLen: 10, required: false });
  env.addField({ id: 'agree', signer: 'a', document: 'd1', page: 0, at: place, kind: 'checkbox', label: 'I agree' });
  env.addField(sigField('other', 'b'));
  const sent = env.send();
  const t = token(sent.find((m) => m.to === 'ana@example.com')!);
  assert.throws(() => env.sign(t, { values: {}, consent: false }), /agree to use electronic records/);
  assert.throws(() => env.sign(t, { values: { sig: typed('Ana'), ini: typed('A'), role: 'Buyer', zip: '45402', agree: true, other: typed('x') }, consent: true }), /other: that is not one of your fields/);
  assert.throws(
    () => env.sign(t, { values: { sig: typed('   '), ini: typed('ABCDEFGHIJ'), role: 'Landlord', zip: '4540', note: 'much too long a note', agree: false }, consent: true }),
    (e: unknown) => {
      assert.ok(e instanceof EnvelopeError);
      assert.deepEqual(e.problems, [
        'sig: signature is required',
        'ini: the typed initials is too long or has control characters',
        'Your role: choose one of: Buyer, Seller',
        'ZIP: is not in the expected form',
        'note: at most 10 characters',
        'I agree: this box must be checked',
      ]);
      return true;
    },
  );
  assert.equal(env.snapshot().signers[0]!.status, 'notified', 'a refused submission changes nothing');
  assert.ok(env.snapshot().fields.every((f) => f.value === undefined));
  assert.throws(() => env.sign(t, { values: { sig: { drawn: [] }, ini: typed('A'), role: 'Buyer', zip: '45402', agree: true }, consent: true }), /signature: the drawn signature is empty or not valid|sig: the drawn signature/);
  assert.throws(() => env.sign(t, { values: { sig: { drawn: [[[0.1, 0.2], [2, 0.3]]] }, ini: typed('A'), role: 'Buyer', zip: '45402', agree: true }, consent: true }), /not valid/);
  env.sign(t, { values: { sig: { drawn: [[[0.1, 0.2], [0.3, 0.4], [0.5, 0.1]]] }, ini: typed('AR'), role: 'Seller', zip: '45402', agree: true }, consent: true, ip: '192.0.2.5' });
  const f = Object.fromEntries(env.snapshot().fields.map((x) => [x.id, x.value]));
  assert.deepEqual(f.sig, { drawn: [[[0.1, 0.2], [0.3, 0.4], [0.5, 0.1]]] });
  assert.deepEqual([f.ini, f.role, f.zip, f.agree, f.note], [{ typed: 'AR' }, 'Seller', '45402', true, undefined]);
  assert.throws(() => env.sign(t, { values: {}, consent: true }), /already signed/);
});

test('date, name and email fields are filled by the envelope, not the signer', () => {
  const { env, c } = make();
  env.addDocument({ id: 'd1', name: 'A.pdf', bytes: DOC, pages: 1 });
  env.addSigner({ id: 'a', name: 'Ana Rivera', email: 'Ana@Example.com' });
  env.addField(sigField('sig', 'a'));
  for (const [id, kind] of [['dt', 'date'], ['nm', 'name'], ['em', 'email']] as const) env.addField({ id, signer: 'a', document: 'd1', page: 0, at: place, kind });
  const sent = env.send();
  c.t = Date.UTC(2026, 2, 5, 23, 30);
  env.sign(token(sent[0]!), { values: { sig: typed('Ana'), dt: '1999-01-01', nm: 'Eve', em: 'eve@example.com' }, consent: true });
  const f = Object.fromEntries(env.snapshot().fields.map((x) => [x.id, x.value]));
  assert.deepEqual([f.dt, f.nm, f.em], ['2026-03-05', 'Ana Rivera', 'ana@example.com']);
});

test('links are signed and for one person: tampered, foreign, expired and wrong-envelope links are refused', () => {
  const { env, sent, c } = sequential();
  const t = token(sent[0]!);
  assert.throws(() => env.open(`${t.slice(0, -2)}AA`), /not valid/);
  assert.throws(() => env.open('garbage'), /not valid/);
  const other = signLink(SECRET, 'esign-access', { e: 'someone-elses', s: 'ana' }, HOUR, c.t);
  assert.throws(() => env.open(other), /different envelope/);
  assert.throws(() => env.open(signLink(SECRET, 'esign-access', { e: env.id, s: 'nobody' }, HOUR, c.t)), /not on this envelope/);
  assert.throws(() => env.open(signLink(SECRET, 'reset-password', { e: env.id, s: 'ana' }, HOUR, c.t)), /for something else/);
  assert.throws(() => env.open(signLink('a-different-signing-secret', 'esign-access', { e: env.id, s: 'ana' }, HOUR, c.t)), /not issued here/);
  c.t += 40 * 24 * HOUR;
  assert.throws(() => env.open(t), /expired/);
});

test('an access code is kept as a hash, locks after repeated wrong tries, and is recorded as part of the evidence', () => {
  const { env } = make();
  env.addDocument({ id: 'd1', name: 'A.pdf', bytes: DOC, pages: 1 });
  env.addSigner({ id: 'a', name: 'Ana', email: 'ana@example.com', accessCode: '4821-9907' });
  env.addField(sigField('sig', 'a'));
  const sent = env.send();
  const t = token(sent[0]!);
  assert.ok(!JSON.stringify(env.snapshot()).includes('4821'), 'the code is nowhere in the record');
  assert.throws(() => env.open(t), /needs its access code/);
  assert.throws(() => env.open(t, { code: 'wrong-1' }), /not right/);
  const v = env.open(t, { code: '4821-9907' });
  assert.equal(v.canSign, true);
  assert.equal(env.snapshot().signers[0]!.evidence.auth, 'link+code');
  for (let i = 0; i < 5; i++) assert.throws(() => env.sign(t, { values: { sig: typed('A') }, consent: true, code: 'nope' }), /not right|too many/);
  assert.throws(() => env.sign(t, { values: { sig: typed('A') }, consent: true, code: '4821-9907' }), /too many wrong access codes/, 'even the right code is refused once locked');
  assert.equal(env.snapshot().trail.filter((e) => e.action === 'wrong access code').length, 7, 'one with no code, one wrong on opening, five wrong on signing');
  assert.throws(() => make().env.addSigner({ id: 'x', name: 'X', email: 'x@example.com', accessCode: 'abc' }), /at least 4/);
});

test('declining ends the envelope with a reason, and releases everyone else', () => {
  const { env, sent } = sequential();
  const t = token(sent[0]!);
  assert.throws(() => env.decline(t, '   '), /say why/);
  const out = env.decline(t, 'The price is not what we agreed');
  assert.equal(env.state, 'declined');
  assert.equal(env.snapshot().endReason, 'declined by Ana Rivera: The price is not what we agreed');
  assert.deepEqual(out.map((m) => [m.kind, m.to]), [['declined', 'sam@example.com']]);
  assert.deepEqual(env.snapshot().signers.map((s) => s.status), ['declined', 'cancelled']);
  assert.throws(() => env.sign(t, { values: { s1: typed('A') }, consent: true }), /declined; it can no longer be signed/);
  assert.equal(env.open(t).canSign, false);
  assert.equal(env.open(t).note, 'this envelope is declined');
  assert.throws(() => env.certificate(), /only a completed envelope/);
});

test('the sender can void a draft or a sent envelope with a reason, but not a finished one', () => {
  const draft = make().env;
  assert.throws(() => draft.void(' '), /say why/);
  assert.deepEqual(draft.void('created by mistake'), []);
  assert.equal(draft.state, 'voided');
  const { env } = sequential();
  const out = env.void('contract changed');
  assert.equal(env.state, 'voided');
  assert.deepEqual(out.map((m) => [m.kind, m.to]), [['voided', 'ana@example.com']], 'Bo was never asked, so is not told');
  assert.throws(() => env.void('again'), /cannot be voided/);
  const finished = completed().env;
  assert.throws(() => finished.void('too late'), /cannot be voided/);
});

test('an envelope past its expiry date ends, and reminders follow the policy until the person acts', () => {
  const { env, c } = make({ days: 7 });
  env.addDocument({ id: 'd1', name: 'A.pdf', bytes: DOC, pages: 1 });
  env.addSigner({ id: 'a', name: 'Ana', email: 'ana@example.com' });
  env.addSigner({ id: 'b', name: 'Bo', email: 'bo@example.com', order: 2 });
  env.addField(sigField('sa', 'a'));
  env.addField(sigField('sb', 'b'));
  env.setReminders({ afterHours: 24, everyHours: 48, max: 2 });
  env.send();
  c.t += 23 * HOUR;
  assert.deepEqual(env.tick(), []);
  c.t += 2 * HOUR;
  const r1 = env.tick();
  assert.deepEqual(r1.map((m) => [m.kind, m.to]), [['reminder', 'ana@example.com']]);
  assert.ok(r1[0]!.link);
  assert.deepEqual(env.tick(), [], 'not again at once');
  c.t += 47 * HOUR;
  assert.deepEqual(env.tick(), []);
  c.t += 2 * HOUR;
  assert.equal(env.tick().length, 1);
  c.t += 49 * HOUR;
  assert.deepEqual(env.tick(), [], 'the policy allows two reminders');
  assert.equal(env.snapshot().signers[0]!.reminders, 2);
  assert.equal(env.snapshot().signers[1]!.reminders, 0, 'Bo is not yet asked');
  c.t = T0 + 7 * 24 * HOUR;
  const end = env.tick();
  assert.equal(env.state, 'expired');
  assert.deepEqual(end.map((m) => [m.kind, m.to]), [['expired', 'sam@example.com'], ['expired', 'ana@example.com']]);
  assert.deepEqual(env.tick(), []);
  assert.equal(env.snapshot().endReason, 'it was not completed in time');
  assert.throws(() => env.sign(resend(env, 'a'), { values: { sa: typed('A') }, consent: true }), /expired; it can no longer be signed/);
});

test('an envelope without an expiry never expires, and an expiry out of range is refused', () => {
  const { env, c } = make();
  env.addDocument({ id: 'd1', name: 'A.pdf', bytes: DOC, pages: 1 });
  env.addSigner({ id: 'a', name: 'Ana', email: 'ana@example.com' });
  env.addField(sigField('sa', 'a'));
  env.send();
  c.t += 400 * 24 * HOUR;
  assert.ok(env.tick().every((m) => m.kind === 'reminder'));
  assert.equal(env.state, 'sent');
  const clk = clock();
  assert.throws(() => new Envelope({ now: clk.now, secret: SECRET, baseUrl: 'x' }, { subject: 's', sender: { name: 'a', email: 'a@example.com' }, expiresInDays: 400 }), /1 to 365/);
  assert.throws(() => new Envelope({ now: clk.now, secret: 'short', baseUrl: 'x' }, { subject: 's', sender: { name: 'a', email: 'a@example.com' } }), /at least 16/);
  assert.throws(() => new Envelope({ now: clk.now, secret: SECRET, baseUrl: 'x' }, { subject: ' ', sender: { name: 'a', email: 'a@example.com' } }), /needs a subject/);
});

test('the trail is hash-chained, in order, and any change to it is detected', () => {
  const { env, sent } = sequential();
  env.open(token(sent[0]!), { ip: '1.2.3.4' });
  env.sign(token(sent[0]!), { values: { s1: typed('Ana') }, consent: true });
  const trail = env.snapshot().trail;
  assert.deepEqual(trail.map((e) => e.action), ['created', 'document added', 'signer added', 'signer added', 'field added', 'field added', 'sent', 'request sent', 'viewed', 'signed', 'request sent']);
  assert.deepEqual(trail.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(trail[0]!.prev, '0'.repeat(64));
  assert.equal(trail[1]!.prev, trail[0]!.hash);
  assert.equal(Envelope.trailIntact(trail), true);
  const edited = trail.map((e) => (e.seq === 9 ? { ...e, detail: '9.9.9.9' } : e));
  assert.equal(Envelope.trailIntact(edited), false);
  assert.equal(Envelope.trailIntact(trail.filter((e) => e.seq !== 5)), false, 'a removed event');
  assert.equal(Envelope.trailIntact([...trail].reverse()), false);
  assert.equal(Envelope.trailIntact([]), true);
});

function completed() {
  const x = sequential();
  x.c.t += HOUR;
  x.env.open(token(x.sent[0]!), { ip: '203.0.113.9', agent: 'UnitTest/1.0' });
  x.c.t += HOUR;
  const next = x.env.sign(token(x.sent[0]!), { values: { s1: typed('Ana Rivera') }, consent: true, ip: '203.0.113.9', agent: 'UnitTest/1.0' });
  x.c.t += HOUR;
  x.env.sign(token(next[0]!), { values: { s2: typed('Bo Chen') }, consent: true, ip: '198.51.100.7' });
  return x;
}

test('the completion certificate states the documents and each signer\'s evidence, and is sealed', () => {
  const { env } = completed();
  const c = env.certificate();
  assert.equal(c.envelope, 'env1');
  assert.equal(c.completedAt, '2026-03-02T12:00:00.000Z');
  assert.deepEqual(c.documents, [{ id: 'd1', name: 'Agreement.pdf', sha256: sha(DOC), pages: 1 }]);
  assert.deepEqual(c.signers[0], {
    id: 'ana', name: 'Ana Rivera', email: 'ana@example.com', role: 'signer', order: 1,
    evidence: { viewedAt: '2026-03-02T10:00:00.000Z', viewIp: '203.0.113.9', viewAgent: 'UnitTest/1.0', consentAt: '2026-03-02T11:00:00.000Z', signedAt: '2026-03-02T11:00:00.000Z', auth: 'link', signIp: '203.0.113.9', signAgent: 'UnitTest/1.0' },
  });
  assert.equal(c.signers[1]!.evidence.signIp, '198.51.100.7');
  assert.equal(c.trailHead, env.snapshot().trail.at(-1)!.hash);
  assert.equal(c.events, env.snapshot().trail.length);
  assert.equal(env.verifyCertificate(c), true);
  const forged: Certificate = { ...c, signers: [{ ...c.signers[0]!, evidence: { ...c.signers[0]!.evidence, signIp: '10.0.0.1' } }, c.signers[1]!] };
  assert.equal(env.verifyCertificate(forged), false);
  assert.equal(env.verifyCertificate({ ...c, seal: '0'.repeat(64) }), false);
  const resealed = { ...forged, certificateHash: createHash('sha256').update('x').digest('hex') };
  assert.equal(env.verifyCertificate(resealed), false);
  const other = new Envelope({ now: () => T0, secret: createHash('sha256').update('esign-envelope test key 2').digest('hex'), baseUrl: 'x' }, { subject: 's', sender: { name: 'a', email: 'a@example.com' } });
  assert.equal(other.verifyCertificate(c), false, 'a different key does not vouch for it');
});

test('the finished document has every value drawn on its page and no form left', () => {
  const { env } = completed();
  const out = env.finalize('d1', DOC);
  assert.equal(readForm(out).fields.length, 0);
  assert.equal(Buffer.compare(Buffer.from(out).subarray(0, DOC.length), Buffer.from(DOC)), 0, 'the original is untouched under the update');
  const t = Buffer.from(out).toString('latin1');
  assert.match(t, /\(Ana Rivera\) Tj/);
  assert.match(t, /\(Bo Chen\) Tj/);
  assert.match(t, /FlatFm1 Do/);
  assert.throws(() => env.finalize('d1', Buffer.from(DOC).subarray(0, DOC.length - 1)), /not the document that was sent/);
  assert.throws(() => env.finalize('nope', DOC), /no document/);
  const draftSent = sequential().env;
  assert.throws(() => draftSent.finalize('d1', DOC), /only when it is completed|documents are finalized/);
});

test('a field\'s place becomes page coordinates, and the certificate can be printed', () => {
  const { env } = completed();
  assert.deepEqual(env.fieldRect('s1', DOC), [72, 162, 272, 192]);
  assert.throws(() => env.fieldRect('zz', DOC), /no field/);
  const cert = Buffer.from(env.certificatePdf());
  assert.equal(cert.subarray(0, 5).toString(), '%PDF-');
  const t = cert.toString('latin1');
  assert.ok(t.includes('Certificate of completion'));
  assert.ok(t.includes(sha(DOC).slice(0, 20)));
  assert.ok(t.includes('ana@example.com'));
  assert.throws(() => sequential().env.certificatePdf(), /only a completed/);
});

test('the snapshot is a complete record with no secrets in it', () => {
  const { env } = completed();
  const s = env.snapshot();
  const text = JSON.stringify(s);
  assert.ok(!text.includes(SECRET));
  assert.ok(!/codeHash|codeSalt|failedCodes/.test(text));
  assert.equal(s.state, 'completed');
  assert.equal(s.sentAt, '2026-03-02T09:00:00.000Z');
  assert.equal(s.signers.every((x) => x.status === 'signed'), true);
  assert.equal(s.fields.every((f) => f.filledBy !== undefined), true);
  assert.deepEqual(s.reminders, { afterHours: 24, everyHours: 48, max: 3 });
});
