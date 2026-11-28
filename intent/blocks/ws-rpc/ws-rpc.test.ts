import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Catalogue, Hub } from '../events/index.ts';
import type { CloudEvent } from '../events/index.ts';
import { Failures } from '../ratelimit/index.ts';
import { Connection, RpcClient, RpcError, RpcFailed } from './index.ts';
import type { ConnectionOptions, Principal } from './index.ts';

const cat = new Catalogue([
  { type: 'files.file.created', version: 1, owner: 'files', description: 'a file was made', fields: { id: 'string', owner: 'string' } },
  { type: 'files.file.deleted', version: 1, owner: 'files', description: 'a file was removed', fields: { id: 'string', owner: 'string' } },
  { type: 'chat.message.sent', version: 1, owner: 'chat', description: 'a message', fields: { id: 'string', owner: 'string' } },
]);
const ev = (type: string, id: string, owner = 'ana') => cat.make('urn:test', type, { id, owner }, { now: new Date(0) });

const people: Record<string, Principal> = { 'tok-ana': { id: 'ana' }, 'tok-bo': { id: 'bo' } };

interface Rig {
  hub: Hub;
  t: { now: number };
  toClient: string[];
  toServer: string[];
  closed: { code: number; reason: string }[];
  conn: () => Connection;
  client: RpcClient;
  server: Connection;
  pump: () => Promise<void>;
  newServer: (o?: Partial<ConnectionOptions>) => Connection;
  resyncs: string[];
}

const rig = (token = 'tok-ana', hubKeep = 1000): Rig => {
  const hub = new Hub(hubKeep);
  const t = { now: 1_000_000 };
  const toClient: string[] = [];
  const toServer: string[] = [];
  const closed: { code: number; reason: string }[] = [];
  const resyncs: string[] = [];
  const base = (extra: Partial<ConnectionOptions> = {}): ConnectionOptions => ({
    send: (x) => void toClient.push(x),
    close: (code, reason) => void closed.push({ code, reason }),
    hub,
    authenticate: (tok) => people[tok] ?? null,
    secret: 'resume-secret',
    now: () => t.now,
    methods: {
      echo: (p) => p,
      whoami: (_p, who) => ({ id: who.id }),
      fail: () => {
        throw new RpcError('conflict', 'that name is taken');
      },
      crash: () => {
        throw new Error('db password is hunter2');
      },
      slow: () => new Promise((r) => setTimeout(() => r('late'), 20)),
    },
    topics: {
      files: { types: ['files.*'], allow: (who, params) => (params['owner'] === who.id ? (e) => e.data['owner'] === who.id : null) },
      chat: { types: ['chat.message.sent'], allow: () => () => true },
    },
    ...extra,
  });
  let server = new Connection(base());
  const state = { server };
  const r: Rig = {
    hub, t, toClient, toServer, closed, resyncs,
    conn: () => state.server,
    get server() { return state.server; },
    newServer: (o = {}) => (state.server = new Connection(base(o))),
    client: new RpcClient({ send: (x) => void toServer.push(x), token: () => token, now: () => t.now, onResync: (s) => void resyncs.push(s) }),
    pump: async () => {
      for (let i = 0; i < 20; i++) {
        const a = toServer.splice(0);
        const b = toClient.splice(0);
        if (!a.length && !b.length) return;
        for (const x of a) await state.server.receive(x);
        for (const x of b) r.client.onMessage(x);
        await new Promise((res) => setImmediate(res));
      }
    },
  };
  server = state.server;
  return r;
};

test('a request is matched to its response by id, whatever order answers arrive in', async () => {
  const r = rig();
  r.client.onOpen();
  await r.pump();
  assert.equal(r.client.state, 'ready');
  const slow = r.client.request('slow');
  const fast = r.client.request('echo', { n: 2 });
  await r.pump();
  assert.deepEqual(await fast, { n: 2 });
  await new Promise((res) => setTimeout(res, 40));
  await r.pump();
  assert.equal(await slow, 'late');
  const me = r.client.request('whoami');
  await r.pump();
  assert.deepEqual(await me, { id: 'ana' });
});

test('nothing but auth is accepted first: other messages, junk and silence all close the socket', async () => {
  const a = rig();
  await a.server.receive(JSON.stringify({ t: 'req', id: '1', method: 'echo' }));
  assert.deepEqual(a.closed, [{ code: 4401, reason: 'authenticate first' }]);
  const b = rig();
  await b.server.receive('not json{');
  assert.deepEqual(b.closed, [{ code: 4400, reason: 'not JSON' }]);
  const c = rig();
  await c.server.receive('[1,2]');
  assert.equal(c.closed[0]!.code, 4400);
  const d = rig();
  d.t.now += 9_999;
  d.server.tick();
  assert.equal(d.closed.length, 0);
  d.t.now += 1;
  d.server.tick();
  assert.deepEqual(d.closed, [{ code: 4401, reason: 'authentication timed out' }]);
});

test('a bad credential gets one error and a close, and repeated failures from an address are cut off', async () => {
  const failures = new Failures(2, 60_000, { now: () => 0 });
  const r = rig();
  const s1 = r.newServer({ failures, remote: '10.0.0.9' });
  await s1.receive(JSON.stringify({ t: 'auth', token: 'wrong' }));
  assert.deepEqual(JSON.parse(r.toClient[0]!), { t: 'err', error: { code: 'unauthorized', message: 'that credential was not accepted' } });
  assert.deepEqual(r.closed, [{ code: 4401, reason: 'unauthorized' }]);
  const s2 = r.newServer({ failures, remote: '10.0.0.9' });
  await s2.receive(JSON.stringify({ t: 'auth', token: 'wrong' }));
  const s3 = r.newServer({ failures, remote: '10.0.0.9' });
  await s3.receive(JSON.stringify({ t: 'auth', token: 'tok-ana' }));
  assert.deepEqual(r.closed.at(-1), { code: 4429, reason: 'too many failed attempts' }, 'even a right credential waits out the lockout');
  assert.equal(s3.principal, undefined);
  const s4 = r.newServer({ failures, remote: '10.0.0.10' });
  await s4.receive(JSON.stringify({ t: 'auth', token: 'tok-ana' }));
  assert.equal(s4.principal?.id, 'ana', 'another address is unaffected');
});

test('nothing may be sent while authentication is still being decided, or after it', async () => {
  const r = rig();
  let release!: (p: Principal) => void;
  const s = r.newServer({ authenticate: () => new Promise<Principal>((res) => (release = res)) });
  const first = s.receive(JSON.stringify({ t: 'auth', token: 'x' }));
  await s.receive(JSON.stringify({ t: 'req', id: '1', method: 'echo' }));
  assert.deepEqual(r.closed, [{ code: 4401, reason: 'nothing is sent before auth_ok' }]);
  release({ id: 'ana' });
  await first;
  assert.equal(r.toClient.length, 0, 'no auth_ok for a connection already closed');
  const r2 = rig();
  r2.client.onOpen();
  await r2.pump();
  await r2.server.receive(JSON.stringify({ t: 'auth', token: 'tok-ana' }));
  assert.equal(r2.closed[0]!.code, 4400);
});

test('method errors: only an RpcError speaks; anything else is "something went wrong"', async () => {
  const r = rig();
  r.client.onOpen();
  await r.pump();
  const a = r.client.request('fail');
  const b = r.client.request('crash');
  const c = r.client.request('nope');
  const d = r.client.request('constructor');
  const checks = [
    assert.rejects(a, (e: RpcFailed) => e.code === 'conflict' && e.message === 'that name is taken'),
    assert.rejects(b, (e: RpcFailed) => e.code === 'internal' && e.message === 'something went wrong' && !/hunter2/.test(e.message)),
    assert.rejects(c, (e: RpcFailed) => e.code === 'method_not_found'),
    assert.rejects(d, (e: RpcFailed) => e.code === 'method_not_found'),
  ];
  await r.pump();
  await Promise.all(checks);
});

test('too many requests at once, and a reused id, are refused', async () => {
  const r = rig();
  const s = r.newServer({ maxInFlight: 2 });
  await s.receive(JSON.stringify({ t: 'auth', token: 'tok-ana' }));
  r.toClient.length = 0;
  const p1 = s.receive(JSON.stringify({ t: 'req', id: 'a', method: 'slow' }));
  await s.receive(JSON.stringify({ t: 'req', id: 'a', method: 'slow' }));
  const p2 = s.receive(JSON.stringify({ t: 'req', id: 'b', method: 'slow' }));
  await s.receive(JSON.stringify({ t: 'req', id: 'c', method: 'slow' }));
  const errs = r.toClient.map((x) => JSON.parse(x)).filter((m) => m.t === 'err');
  assert.deepEqual(errs.map((e) => [e.id, e.error.code]), [['a', 'bad_request'], ['c', 'too_many']]);
  await Promise.all([p1, p2]);
});

test('subscribing needs a topic that exists and permission; every event is filtered per person', async () => {
  const r = rig();
  r.client.onOpen();
  await r.pump();
  const got: string[] = [];
  const sub = r.client.subscribe('files', { owner: 'ana' }, (e) => got.push(String(e.data['id'])));
  await r.pump();
  await sub;
  r.hub.publish(ev('files.file.created', 'f1'));
  r.hub.publish(ev('files.file.created', 'f2', 'bo'));
  r.hub.publish(ev('chat.message.sent', 'm1'));
  r.hub.publish(ev('files.file.deleted', 'f1'));
  await r.pump();
  assert.deepEqual(got, ['f1', 'f1'], 'bo\'s file and the chat message are not delivered');
  const nope = r.client.subscribe('files', { owner: 'bo' }, () => {});
  const missing = r.client.subscribe('nowhere', {}, () => {});
  const checks = [assert.rejects(nope, (e: RpcFailed) => e.code === 'forbidden'), assert.rejects(missing, (e: RpcFailed) => e.code === 'not_found')];
  await r.pump();
  await Promise.all(checks);
  assert.deepEqual(r.server.subscriptions, ['s1']);
});

test('unsubscribe stops delivery; an unknown subscription is not found; the limit holds', async () => {
  const r = rig();
  r.client.onOpen();
  await r.pump();
  const got: string[] = [];
  const p = r.client.subscribe('chat', {}, (e) => got.push(String(e.data['id'])));
  await r.pump();
  const h = await p;
  r.hub.publish(ev('chat.message.sent', 'm1'));
  await r.pump();
  const stopped = h.stop();
  await r.pump();
  await stopped;
  r.hub.publish(ev('chat.message.sent', 'm2'));
  await r.pump();
  assert.deepEqual(got, ['m1']);
  assert.deepEqual(r.server.subscriptions, []);
  await r.server.receive(JSON.stringify({ t: 'unsub', id: 'x', sub: 'ghost' }));
  assert.equal(JSON.parse(r.toClient.at(-1)!).error.code, 'not_found');
  const s = r.newServer({ maxSubscriptions: 2 });
  await s.receive(JSON.stringify({ t: 'auth', token: 'tok-ana' }));
  for (const n of [1, 2, 3]) await s.receive(JSON.stringify({ t: 'sub', id: `q${n}`, sub: `s${n}`, topic: 'chat', params: {} }));
  assert.equal(JSON.parse(r.toClient.at(-1)!).error.code, 'too_many');
  await s.receive(JSON.stringify({ t: 'sub', id: 'q9', sub: 'bad id!', topic: 'chat', params: {} }));
  assert.equal(JSON.parse(r.toClient.at(-1)!).error.code, 'bad_request');
});

test('after a reconnect the resume token restores subscriptions and replays exactly what was missed', async () => {
  const r = rig();
  r.client.onOpen();
  await r.pump();
  const got: string[] = [];
  const p = r.client.subscribe('files', { owner: 'ana' }, (e) => got.push(String(e.data['id'])));
  await r.pump();
  await p;
  r.hub.publish(ev('files.file.created', 'a'));
  r.hub.publish(ev('files.file.created', 'b'));
  await r.pump();
  assert.deepEqual(got, ['a', 'b']);
  // the socket drops
  r.server.closedByPeer();
  r.client.onClose();
  r.hub.publish(ev('files.file.created', 'c'));
  r.hub.publish(ev('chat.message.sent', 'noise'));
  r.hub.publish(ev('files.file.created', 'd'));
  // a new socket
  r.newServer();
  r.client.onOpen();
  await r.pump();
  assert.deepEqual(got, ['a', 'b', 'c', 'd'], 'each event once, in order, none missed');
  assert.deepEqual(r.server.subscriptions, ['s1']);
  assert.deepEqual(r.resyncs, []);
  r.hub.publish(ev('files.file.created', 'e'));
  await r.pump();
  assert.deepEqual(got.at(-1), 'e');
});

test('when the replay buffer no longer reaches back, the client is told to refetch', async () => {
  const r = rig('tok-ana', 3);
  r.client.onOpen();
  await r.pump();
  const got: string[] = [];
  const p = r.client.subscribe('files', { owner: 'ana' }, (e) => got.push(String(e.data['id'])));
  await r.pump();
  await p;
  r.hub.publish(ev('files.file.created', 'a'));
  await r.pump();
  r.server.closedByPeer();
  r.client.onClose();
  for (const id of ['b', 'c', 'd', 'e', 'f']) r.hub.publish(ev('files.file.created', id));
  r.newServer();
  r.client.onOpen();
  await r.pump();
  assert.deepEqual(r.resyncs, ['s1']);
  assert.deepEqual(got, ['a', 'd', 'e', 'f'], 'what is still buffered is replayed');
});

test('a resume token is useless to anyone else, expired, or forged; the client then simply subscribes again', async () => {
  const r = rig();
  r.client.onOpen();
  await r.pump();
  const p = r.client.subscribe('files', { owner: 'ana' }, () => {});
  await r.pump();
  await p;
  await r.server.receive(JSON.stringify({ t: 'sub', id: 'q2', sub: 's1', topic: 'files', params: { owner: 'ana' } }));
  const resume = JSON.parse(r.toClient.at(-1)!).resume as string;
  const as = async (token: string, resumeToken: string, t = r.t.now) => {
    r.t.now = t;
    const s = r.newServer();
    await s.receive(JSON.stringify({ t: 'auth', token, resume: { token: resumeToken, seqs: {} } }));
    return JSON.parse(r.toClient.at(-1)!);
  };
  assert.deepEqual((await as('tok-bo', resume)).dropped, ['*'], 'another person cannot use it');
  assert.deepEqual((await as('tok-ana', resume + 'x')).dropped, ['*'], 'a forged one is dropped');
  assert.deepEqual((await as('tok-ana', resume, 1_000_000 + 5 * 60_000 + 1)).dropped, ['*'], 'an expired one is dropped');
  const ok = await as('tok-ana', resume, 1_000_000 + 1000);
  assert.deepEqual(ok.restored, ['s1']);
});

test('a token cannot be used to subscribe to something the person may no longer see', async () => {
  const r = rig();
  const a = r.newServer();
  await a.receive(JSON.stringify({ t: 'auth', token: 'tok-ana' }));
  await a.receive(JSON.stringify({ t: 'sub', id: 'q1', sub: 's1', topic: 'files', params: { owner: 'ana' } }));
  const resume = JSON.parse(r.toClient.at(-1)!).resume as string;
  const b = r.newServer({ topics: { files: { types: ['files.*'], allow: () => null } } });
  await b.receive(JSON.stringify({ t: 'auth', token: 'tok-ana', resume: { token: resume, seqs: {} } }));
  const ok = JSON.parse(r.toClient.at(-1)!);
  assert.deepEqual([ok.restored, ok.dropped], [[], ['s1']]);
  assert.deepEqual(b.subscriptions, []);
});

test('a client that cannot keep up is closed rather than buffered, and can resume', async () => {
  const r = rig();
  let slow = false;
  const s = r.newServer({ backedUp: () => slow });
  await s.receive(JSON.stringify({ t: 'auth', token: 'tok-ana' }));
  await s.receive(JSON.stringify({ t: 'sub', id: 'q', sub: 's1', topic: 'chat', params: {} }));
  r.toClient.length = 0;
  r.hub.publish(ev('chat.message.sent', 'm1'));
  assert.equal(r.toClient.length, 1);
  slow = true;
  r.hub.publish(ev('chat.message.sent', 'm2'));
  assert.deepEqual(r.closed, [{ code: 4429, reason: 'too slow: reconnect and resume' }]);
  assert.equal(r.toClient.length, 1, 'nothing more was written');
  assert.equal(s.closed, true);
  assert.deepEqual(s.subscriptions, []);
});

test('requests made while offline wait for the connection, go out in order, and are failed if it drops mid-flight', async () => {
  const r = rig();
  const a = r.client.request('echo', 1);
  const b = r.client.request('echo', 2);
  assert.equal(r.toServer.length, 0);
  r.client.onOpen();
  await r.pump();
  assert.deepEqual([await a, await b], [1, 2]);
  const lost = r.client.request('slow');
  r.client.onClose();
  await assert.rejects(lost, (e: RpcFailed) => e.code === 'connection_lost');
});

test('requests time out without an answer, and the offline queue is bounded', async () => {
  const r = rig();
  r.client.onOpen();
  await r.pump();
  const p = r.client.request('slow');
  r.t.now += 29_999;
  r.client.tick();
  r.t.now += 1;
  r.client.tick();
  await assert.rejects(p, (e: RpcFailed) => e.code === 'timeout');
  const c = new RpcClient({ send: () => {}, token: () => 't', maxQueued: 2 });
  c.request('a').catch(() => {});
  c.request('b').catch(() => {});
  await assert.rejects(c.request('c'), (e: RpcFailed) => e.code === 'queue_full');
});

test('a duplicate or older event number is ignored by the client, and unknown messages are harmless', async () => {
  const c = new RpcClient({ send: () => {}, token: () => 't' });
  const got: CloudEvent[] = [];
  c.onOpen();
  c.onMessage(JSON.stringify({ t: 'auth_ok', resume: 'r', restored: [], missed: [] }));
  const sub = c.subscribe('x', {}, (e) => got.push(e));
  c.onMessage(JSON.stringify({ t: 'res', id: 'r2', result: { sub: 's1' } }));
  const h = await sub;
  const e = ev('chat.message.sent', 'm');
  for (const seq of [5, 5, 4, 6]) c.onMessage(JSON.stringify({ t: 'evt', sub: h.sub, seq, event: e }));
  c.onMessage('garbage');
  c.onMessage(JSON.stringify({ t: 'evt', sub: 'unknown', seq: 1, event: e }));
  c.onMessage(JSON.stringify({ t: 'what' }));
  assert.equal(got.length, 2);
});
