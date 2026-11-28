import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import {
  ApError, AS_CONTEXT, CollectionStore, Inbox, PUBLIC, accept, actorFromWebfinger, announce, block, create, deliver, digestOf, follow, hasActivityStreamsContext,
  like, makeActor, move, parseAcct, parseSignatureHeader, planDelivery, remove, signRequest, undo, update, validateActivity, validateActor, verifyRequest, webfinger, type Doc,
} from './index.ts';

const NOW = Date.UTC(2026, 10, 28, 12, 0, 0);
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ed = generateKeyPairSync('ed25519');
const pem = rsa.publicKey.export({ type: 'spki', format: 'pem' }) as string;

const ALICE = 'https://a.example/users/alice';
const BOB = 'https://b.example/users/bob';
const note = (id: string, by: string): Doc => ({ id, type: 'Note', attributedTo: by, content: '<p>hi</p>', to: [PUBLIC], cc: [`${by}/followers`], published: '2026-11-28T12:00:00Z' });

let n = 0;
const inbox = (manual = false) => new Inbox({ self: ALICE, manuallyApprovesFollowers: manual, newId: (l) => `https://a.example/activities/${l}-${++n}` });

test('an actor document has the required parts, the security context and a key owned by the actor', () => {
  const a = makeActor({ id: ALICE, preferredUsername: 'alice', name: 'Alice', inbox: `${ALICE}/inbox`, outbox: `${ALICE}/outbox`, followers: `${ALICE}/followers`, sharedInbox: 'https://a.example/inbox', publicKeyPem: pem, manuallyApprovesFollowers: false });
  assert.deepEqual(a['@context'], [AS_CONTEXT, 'https://w3id.org/security/v1']);
  assert.deepEqual(a['publicKey'], { id: `${ALICE}#main-key`, owner: ALICE, publicKeyPem: pem });
  const v = validateActor(a);
  assert.equal(v.sharedInbox, 'https://a.example/inbox');
  assert.equal(v.keyId, `${ALICE}#main-key`);
  assert.throws(() => makeActor({ id: 'http://a.example/x', preferredUsername: 'x', inbox: 'i', outbox: 'o' }), /https/);
  assert.throws(() => makeActor({ id: ALICE, preferredUsername: 'bad name!', inbox: `${ALICE}/inbox`, outbox: `${ALICE}/outbox` }), /preferredUsername/);
});

test('actor checks refuse an inbox on another host, a key owned by someone else, and a non-actor type', () => {
  const ok = makeActor({ id: ALICE, preferredUsername: 'alice', inbox: `${ALICE}/inbox`, outbox: `${ALICE}/outbox`, publicKeyPem: pem });
  assert.throws(() => validateActor({ ...ok, inbox: 'https://evil.example/inbox' }), (e: unknown) => e instanceof ApError && e.code === 'forbidden');
  assert.throws(() => validateActor({ ...ok, publicKey: { id: `${ALICE}#k`, owner: BOB, publicKeyPem: pem } }), /not owned/);
  assert.throws(() => validateActor({ ...ok, type: 'Note' }), /not an actor type/);
  assert.throws(() => validateActor({ ...ok, publicKey: { id: `${ALICE}#k`, owner: ALICE, publicKeyPem: 'nope' } }), /not PEM/);
});

test('WebFinger: the answer points at the actor, and an answer about someone else is refused', () => {
  assert.deepEqual(parseAcct('acct:Alice@A.Example'), { user: 'Alice', host: 'a.example' });
  assert.deepEqual(parseAcct('@bob@b.example'), { user: 'bob', host: 'b.example' });
  assert.throws(() => parseAcct('not an acct'), ApError);
  const jrd = webfinger('alice', 'a.example', ALICE);
  assert.equal(jrd['subject'], 'acct:alice@a.example');
  assert.equal(actorFromWebfinger(jrd, 'alice@a.example'), ALICE);
  assert.throws(() => actorFromWebfinger(jrd, 'bob@a.example'), /another subject/);
  assert.throws(() => actorFromWebfinger({ subject: 'acct:alice@a.example', links: [] }, 'alice@a.example'), /no ActivityPub link/);
  assert.throws(() => actorFromWebfinger({ subject: 'acct:alice@a.example', links: [{ rel: 'self', type: 'application/activity+json', href: 'http://a.example/x' }] }, 'alice@a.example'), /https/);
});

test('activity builders produce the documented shapes', () => {
  const c = create('https://a.example/a/1', ALICE, note('https://a.example/n/1', ALICE));
  assert.equal(c['type'], 'Create');
  assert.deepEqual(c['to'], [PUBLIC]);
  assert.deepEqual(c['cc'], [`${ALICE}/followers`]);
  assert.equal(c['published'], '2026-11-28T12:00:00Z');
  assert.equal(c['@context'], AS_CONTEXT);
  assert.deepEqual(remove('https://a.example/a/2', ALICE, 'https://a.example/n/1')['object'], { id: 'https://a.example/n/1', type: 'Tombstone' });
  const f = follow('https://a.example/a/3', ALICE, BOB);
  assert.deepEqual([f['type'], f['object'], f['to']], ['Follow', BOB, [BOB]]);
  const acc = accept('https://b.example/a/4', BOB, f);
  assert.deepEqual([acc['type'], acc['to']], ['Accept', [ALICE]]);
  const u = undo('https://a.example/a/5', ALICE, f);
  assert.equal((u['object'] as Doc)['id'], 'https://a.example/a/3');
  assert.deepEqual(announce('https://a.example/a/6', ALICE, 'https://b.example/n/9')['to'], [PUBLIC]);
  const mv = move('https://a.example/a/7', ALICE, ALICE, BOB);
  assert.deepEqual([mv['object'], mv['target']], [ALICE, BOB]);
  assert.ok(hasActivityStreamsContext(like('https://a.example/a/8', ALICE, 'https://b.example/n/9')));
  assert.equal(block('https://a.example/a/9', ALICE, BOB)['type'], 'Block');
  assert.equal(update('https://a.example/a/10', ALICE, note('https://a.example/n/1', ALICE))['type'], 'Update');
});

test('validateActivity refuses missing context, unknown types, missing parts, non-https ids and deep or huge documents', () => {
  const good = create('https://a.example/a/1', ALICE, note('https://a.example/n/1', ALICE));
  assert.equal(validateActivity(good).type, 'Create');
  const bad = (d: unknown, re: RegExp) => assert.throws(() => validateActivity(d), re);
  bad('x', /JSON object/);
  bad({ ...good, '@context': 'https://example.com/other' }, /@context/);
  bad({ ...good, type: 'Frobnicate' }, /not an activity type/);
  bad({ ...good, id: 'http://a.example/a/1' }, /https/);
  bad({ ...good, actor: undefined }, /actor is missing/);
  bad({ ...good, object: undefined }, /needs an object/);
  bad({ ...good, object: 'https://a.example/n/1' }, /embedded/);
  bad({ ...good, object: { ...note('https://a.example/n/1', ALICE), x: 'y'.repeat(1_100_000) } }, /1 MB/);
  let deep: Doc = { v: 1 };
  for (let i = 0; i < 20; i++) deep = { v: deep };
  bad({ ...good, object: { ...note('https://a.example/n/1', ALICE), deep } }, /nesting/);
});

test('spoofing is refused: objects on another host, someone else’s attribution, moving another actor', () => {
  const cross = create('https://a.example/a/1', ALICE, note('https://evil.example/n/1', ALICE));
  assert.throws(() => validateActivity(cross), (e: unknown) => e instanceof ApError && e.code === 'forbidden' && /another host/.test(e.message));
  assert.throws(() => validateActivity(update('https://a.example/a/2', ALICE, note('https://b.example/n/1', BOB))), /another host/);
  assert.throws(() => validateActivity(remove('https://a.example/a/3', ALICE, 'https://b.example/n/1')), /another host/);
  assert.throws(() => validateActivity(create('https://a.example/a/4', ALICE, note('https://a.example/n/4', BOB))), /attributed to someone other/);
  assert.throws(() => validateActivity(move('https://a.example/a/5', ALICE, BOB, 'https://a.example/users/new')), /only an actor can move itself/);
});

test('the inbox refuses a signer who is not the activity actor, and a replayed id', () => {
  const ib = inbox();
  const f = follow('https://b.example/a/1', BOB, ALICE);
  assert.throws(() => ib.receive(f, 'https://c.example/users/carol'), (e: unknown) => e instanceof ApError && e.code === 'forbidden');
  const r = ib.receive(f, BOB);
  assert.equal(r.status, 'processed');
  assert.throws(() => ib.receive(f, BOB), (e: unknown) => e instanceof ApError && e.code === 'duplicate');
});

test('Follow is accepted at once, with an Accept to send; with manual approval it waits, then approve or deny', () => {
  const ib = inbox();
  const r = ib.receive(follow('https://b.example/a/1', BOB, ALICE), BOB);
  assert.deepEqual(r.events, [{ kind: 'follower-added', actor: BOB }]);
  assert.deepEqual([...ib.followers], [BOB]);
  assert.equal(r.outgoing[0]!['type'], 'Accept');
  assert.equal(((r.outgoing[0]!['object']) as Doc)['id'], 'https://b.example/a/1');
  assert.equal(r.outgoing[0]!['actor'], ALICE);

  const m = inbox(true);
  const w = m.receive(follow('https://b.example/a/2', BOB, ALICE), BOB);
  assert.deepEqual(w.events, [{ kind: 'follow-request', actor: BOB, activity: 'https://b.example/a/2' }]);
  assert.equal(m.followers.size, 0);
  const acc = m.approve('https://b.example/a/2');
  assert.equal(acc['type'], 'Accept');
  assert.deepEqual([...m.followers], [BOB]);
  m.receive(follow('https://b.example/a/3', 'https://b.example/users/zed', ALICE), 'https://b.example/users/zed');
  assert.equal(m.deny('https://b.example/a/3')['type'], 'Reject');
  assert.equal(m.followers.has('https://b.example/users/zed'), false);
  assert.throws(() => m.approve('https://b.example/a/missing'), /no such follow request/);
  assert.equal(inbox().receive(follow('https://b.example/a/9', BOB, 'https://a.example/users/other'), BOB).status, 'ignored');
});

test('our Follow is matched by the Accept, and an Accept from anyone else is refused', () => {
  const ib = inbox();
  const f = ib.startFollow(BOB);
  assert.equal(ib.following.get(BOB), 'pending');
  const wrong = accept('https://c.example/a/1', 'https://c.example/users/carol', f);
  assert.throws(() => ib.receive(wrong, 'https://c.example/users/carol'), /someone other than who was asked/);
  const r = ib.receive(accept('https://b.example/a/2', BOB, f), BOB);
  assert.deepEqual(r.events, [{ kind: 'follow-accepted', actor: BOB }]);
  assert.equal(ib.following.get(BOB), 'accepted');
  const g = ib.startFollow('https://b.example/users/dan');
  ib.receive({ ...accept('https://b.example/a/3', 'https://b.example/users/dan', g), type: 'Reject' }, 'https://b.example/users/dan');
  assert.equal(ib.following.has('https://b.example/users/dan'), false);
});

test('Like and Announce are counted per object and Undo removes only the undoer’s own', () => {
  const ib = inbox();
  const obj = 'https://a.example/n/1';
  const l = like('https://b.example/a/1', BOB, obj);
  ib.receive(l, BOB);
  ib.receive(announce('https://b.example/a/2', BOB, obj), BOB);
  assert.deepEqual([...ib.likes.get(obj)!], [BOB]);
  assert.deepEqual([...ib.announces.get(obj)!], [BOB]);
  const carol = 'https://c.example/users/carol';
  assert.throws(() => ib.receive(undo('https://c.example/a/3', carol, l), carol), /someone other than the original actor/);
  const r = ib.receive(undo('https://b.example/a/4', BOB, l), BOB);
  assert.deepEqual(r.events, [{ kind: 'unlike', actor: BOB, object: obj }]);
  assert.equal(ib.likes.get(obj)!.size, 0);
  assert.equal(ib.announces.get(obj)!.size, 1);
  ib.receive(follow('https://b.example/a/5', BOB, ALICE), BOB);
  const un = ib.receive(undo('https://b.example/a/6', BOB, 'https://b.example/a/5' as unknown as Doc), BOB);
  assert.deepEqual(un.events, [{ kind: 'follower-removed', actor: BOB }]);
  assert.equal(ib.followers.size, 0);
});

test('Create, Update and Delete reach the app as events, and deleting an actor drops its relationships', () => {
  const ib = inbox();
  ib.receive(follow('https://b.example/a/1', BOB, ALICE), BOB);
  const n1 = note('https://b.example/n/1', BOB);
  assert.deepEqual(ib.receive(create('https://b.example/a/2', BOB, n1), BOB).events, [{ kind: 'create', actor: BOB, object: n1 }]);
  assert.equal(ib.receive(update('https://b.example/a/3', BOB, n1), BOB).events[0]!.kind, 'update');
  assert.deepEqual(ib.receive(remove('https://b.example/a/4', BOB, 'https://b.example/n/1'), BOB).events, [{ kind: 'delete', actor: BOB, object: 'https://b.example/n/1' }]);
  ib.receive(remove('https://b.example/a/5', BOB, BOB), BOB);
  assert.equal(ib.followers.has(BOB), false);
});

test('Block removes a follower and blocked actors are ignored from then on', () => {
  const ib = inbox();
  ib.receive(follow('https://b.example/a/1', BOB, ALICE), BOB);
  const r = ib.receive(block('https://b.example/a/2', BOB, ALICE), BOB);
  assert.deepEqual(r.events, [{ kind: 'blocked', actor: BOB }]);
  assert.equal(ib.followers.size, 0);
  ib.blockActor(BOB);
  assert.equal(ib.receive(create('https://b.example/a/3', BOB, note('https://b.example/n/3', BOB)), BOB).status, 'ignored');
});

test('Move changes nothing until both actors vouch for it', () => {
  const ib = inbox();
  const old = BOB;
  const neu = 'https://c.example/users/bob';
  ib.startFollow(old);
  ib.following.set(old, 'accepted');
  const r = ib.receive(move('https://b.example/a/1', old, old, neu), old);
  assert.deepEqual(r.events, [{ kind: 'move-claimed', from: old, to: neu }]);
  assert.equal(ib.following.has(old), true);
  const oldDoc: Doc = { id: old, movedTo: neu };
  assert.throws(() => ib.confirmMove(oldDoc, { id: neu, alsoKnownAs: [] }), /alsoKnownAs/);
  assert.throws(() => ib.confirmMove({ id: old }, { id: neu, alsoKnownAs: [old] }), /does not say it moved/);
  const out = ib.confirmMove(oldDoc, { id: neu, alsoKnownAs: [old] });
  assert.equal(out[0]!['type'], 'Follow');
  assert.equal(out[0]!['object'], neu);
  assert.equal(ib.following.has(old), false);
  assert.equal(ib.following.get(neu), 'pending');
});

test('collections: totals, newest first, pages with next and prev, removal', () => {
  const c = new CollectionStore();
  for (let i = 1; i <= 5; i++) c.add(String(i).padStart(4, '0'), { id: `https://a.example/n/${i}` });
  assert.equal(c.add('0003', { id: 'dup' }), false);
  const top = c.collection('https://a.example/users/alice/outbox');
  assert.deepEqual([top['type'], top['totalItems'], top['first']], ['OrderedCollection', 5, 'https://a.example/users/alice/outbox?page=true']);
  const p1 = c.page({ id: 'https://a.example/users/alice/outbox', limit: 2 });
  assert.deepEqual((p1['orderedItems'] as Doc[]).map((x) => x['id']), ['https://a.example/n/5', 'https://a.example/n/4']);
  assert.equal(p1['next'], 'https://a.example/users/alice/outbox?page=true&max_id=0004');
  assert.equal(p1['prev'], undefined);
  const p2 = c.page({ id: 'https://a.example/users/alice/outbox', limit: 2, maxKey: '0004' });
  assert.deepEqual((p2['orderedItems'] as Doc[]).map((x) => x['id']), ['https://a.example/n/3', 'https://a.example/n/2']);
  assert.ok(p2['next'] && p2['prev']);
  const p3 = c.page({ id: 'https://a.example/users/alice/outbox', limit: 2, maxKey: '0002' });
  assert.equal(p3['next'], undefined);
  assert.equal(c.remove('0005'), true);
  assert.equal(c.totalItems, 4);
  assert.equal(c.page({ id: 'x', limit: 1000 })['orderedItems'] instanceof Array, true);
});

test('delivery plan: expands followers, uses shared inboxes once, skips public and the sender, strips bto and bcc', () => {
  const act: Doc = { ...create('https://a.example/a/1', ALICE, note('https://a.example/n/1', ALICE)), bcc: [BOB], bto: ['https://d.example/users/dan'] };
  const dir: Record<string, { inbox: string; sharedInbox?: string }> = {
    'https://b.example/users/bob': { inbox: 'https://b.example/users/bob/inbox', sharedInbox: 'https://b.example/inbox' },
    'https://b.example/users/zed': { inbox: 'https://b.example/users/zed/inbox', sharedInbox: 'https://b.example/inbox' },
    'https://c.example/users/carol': { inbox: 'https://c.example/users/carol/inbox' },
    'https://d.example/users/dan': { inbox: 'https://d.example/users/dan/inbox' },
    [ALICE]: { inbox: `${ALICE}/inbox` },
  };
  const plan = planDelivery(act, ALICE, () => [BOB, 'https://b.example/users/zed', 'https://c.example/users/carol', ALICE], (id) => dir[id], { followersCollection: `${ALICE}/followers` });
  assert.deepEqual(plan.inboxes, ['https://b.example/inbox', 'https://c.example/users/carol/inbox', 'https://d.example/users/dan/inbox']);
  assert.equal('bcc' in plan.body, false);
  assert.equal('bto' in plan.body, false);
  assert.equal(plan.body['id'], 'https://a.example/a/1');
});

test('signing: a signed POST verifies, with RSA and with Ed25519, and the digest binds the body', () => {
  const body = JSON.stringify(follow('https://a.example/a/1', ALICE, BOB));
  const keyId = `${ALICE}#main-key`;
  for (const [priv, pub] of [[rsa.privateKey, rsa.publicKey], [ed.privateKey, ed.publicKey]] as const) {
    const h = signRequest({ method: 'POST', url: 'https://b.example/users/bob/inbox', body, keyId, privateKey: priv, now: NOW });
    assert.equal(h['digest'], digestOf(body));
    assert.match(h['signature']!, /headers="\(request-target\) host date digest"/);
    assert.equal(verifyRequest({ method: 'POST', url: 'https://b.example/users/bob/inbox', headers: h, body, now: NOW + 1000, publicKey: (k) => (k === keyId ? pub : undefined) }), keyId);
  }
  assert.match(digestOf(''), /^SHA-256=47DEQpj8HBSa\+\/TImW\+5JCeuQeRkm5NMpJWZG3hSuFU=$/, 'the SHA-256 of empty input');
});

test('verification refuses a changed body, a wrong key, a stale date, a missing key, missing covered headers and a repeated parameter', () => {
  const body = '{"a":1}';
  const keyId = `${ALICE}#main-key`;
  const url = 'https://b.example/inbox';
  const h = signRequest({ method: 'POST', url, body, keyId, privateKey: rsa.privateKey, now: NOW });
  const keys = (k: string) => (k === keyId ? rsa.publicKey : undefined);
  const v = (over: Partial<Parameters<typeof verifyRequest>[0]>) => verifyRequest({ method: 'POST', url, headers: h, body, now: NOW, publicKey: keys, ...over });
  assert.equal(v({}), keyId);
  assert.throws(() => v({ body: '{"a":2}' }), /Digest does not match/);
  assert.throws(() => v({ now: NOW + 6 * 60_000 }), /too far from now/);
  assert.throws(() => v({ publicKey: () => undefined }), /no key for/);
  assert.throws(() => v({ publicKey: () => generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey }), /does not verify/);
  assert.throws(() => v({ url: 'https://b.example/other' }), /does not verify/, 'the path is signed');
  assert.throws(() => v({ headers: { ...h, signature: h['signature']!.replace('digest', 'x-other') } }), /does not cover digest/);
  assert.throws(() => v({ headers: { ...h, signature: h['signature']! + ',keyId="again"' } }), /repeats keyId/);
  assert.throws(() => v({ headers: { ...h, signature: h['signature']!.replace('rsa-sha256', 'md5') } }), /unsupported algorithm/);
  assert.throws(() => v({ headers: { host: h['host']!, date: h['date']!, digest: h['digest']! } }), /no Signature header/);
  assert.throws(() => parseSignatureHeader('garbage'), /malformed/);
  assert.throws(() => parseSignatureHeader('keyId="a"'), /lacks keyId or signature/);
});

test('deliver signs and posts to each inbox, and one failing server does not stop the rest', async () => {
  const keyId = `${ALICE}#main-key`;
  const plan = { inboxes: ['https://b.example/inbox', 'https://c.example/inbox', 'https://d.example/inbox'], body: follow('https://a.example/a/1', ALICE, BOB) };
  const seen: string[] = [];
  const res = await deliver(plan, {
    keyId, privateKey: rsa.privateKey, now: () => NOW,
    send: async (inbox, req) => {
      seen.push(inbox);
      if (inbox.includes('c.example')) throw new Error('down');
      verifyRequest({ method: 'POST', url: inbox, headers: req.headers, body: req.body, now: NOW, publicKey: () => rsa.publicKey });
      assert.equal(req.headers['content-type'], 'application/activity+json');
      return { status: inbox.includes('d.example') ? 410 : 202 };
    },
  });
  assert.deepEqual(res, [{ inbox: 'https://b.example/inbox', status: 202, ok: true }, { inbox: 'https://c.example/inbox', status: 'error', ok: false }, { inbox: 'https://d.example/inbox', status: 410, ok: false }]);
  assert.equal(seen.length, 3);
});
