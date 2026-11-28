import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Awareness, AwarenessError, AwarenessHub, IdentityBinder, PALETTE, assignColours, clampIndex, contrast, luminance, textOn, toScene, toScreen, transformIndex, transformSelection, userColour, type Edit, type Json } from './index.ts';

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}
const make = (id: number, c = clock()) => new Awareness(id, { now: c.now });
const bytes = (...n: number[]) => Uint8Array.from(n);

test('the wire form is y-protocols: varuint count, then id, clock and a length-prefixed JSON string', () => {
  const a = make(1);
  a.setLocalState({ a: 1 });
  assert.equal(a.clockOf(1), 2, 'the constructor made clock 1, this is the second change');
  const fresh = make(1);
  fresh.setLocalState({ a: 1 });
  const text = Buffer.from('{"a":1}');
  assert.deepEqual([...make(1).encodeUpdate([1])].slice(0, 3), [1, 1, 1], 'one client, id 1, clock 1');
  assert.deepEqual([...fresh.encodeUpdate([1])], [1, 1, 2, text.length, ...text]);
  const big = new Awareness(300, { now: clock().now });
  assert.deepEqual([...big.encodeUpdate([300])].slice(0, 3), [1, 0xac, 0x02], '300 is the two bytes AC 02');
  const r = make(9).decodeUpdate(bytes(1, 0x80, 0x80, 0x80, 0x80, 0x80, 0x20, 1, 0x01, 0x34));
  assert.deepEqual(r, [{ id: 2 ** 40, clock: 1, state: 4 }], 'a client id above 32 bits reads exactly');
});

test('an update decoded and applied elsewhere gives the same state; a repeat changes nothing', () => {
  const [a, b] = [make(1), make(2)];
  a.setLocalState({ user: { id: 'u1', name: 'Ann' }, cursor: { anchor: 3, head: 5 } });
  const u = a.encodeUpdate();
  const c1 = b.applyUpdate(u);
  assert.deepEqual([c1.added, c1.updated, c1.removed], [[1], [], []]);
  assert.deepEqual(b.getStates().get(1), { user: { id: 'u1', name: 'Ann' }, cursor: { anchor: 3, head: 5 } });
  const c2 = b.applyUpdate(u);
  assert.deepEqual([c2.added, c2.updated, c2.removed, c2.touched], [[], [], [], []], 'the same update again is nothing');
  a.setLocalField('cursor', { anchor: 4, head: 4 });
  const c3 = b.applyUpdate(a.encodeUpdate([1]));
  assert.deepEqual([c3.added, c3.updated], [[], [1]]);
  assert.deepEqual(b.getStates().get(1), { user: { id: 'u1', name: 'Ann' }, cursor: { anchor: 4, head: 4 } }, 'other fields are kept');
});

test('a newer clock wins, an older one is ignored, in any order', () => {
  const [a, b] = [make(1), make(2)];
  a.setLocalState({ n: 1 });
  const first = a.encodeUpdate([1]);
  a.setLocalState({ n: 2 });
  const second = a.encodeUpdate([1]);
  b.applyUpdate(second);
  assert.deepEqual(b.applyUpdate(first).touched, [], 'the older update is ignored');
  assert.deepEqual(b.getStates().get(1), { n: 2 });
  const c = make(3);
  c.applyUpdate(first);
  c.applyUpdate(second);
  assert.deepEqual(c.getStates().get(1), { n: 2 });
  assert.equal(c.clockOf(1), b.clockOf(1));
});

test('leaving is announced as a null state, and a client that has gone can come back with a newer clock', () => {
  const [a, b] = [make(1), make(2)];
  a.setLocalState({ here: true });
  b.applyUpdate(a.encodeUpdate([1]));
  a.setLocalState(null);
  assert.equal(a.getLocalState(), null);
  const ch = b.applyUpdate(a.encodeUpdate([1]));
  assert.deepEqual([ch.removed, b.getStates().has(1)], [[1], false]);
  assert.deepEqual(b.applyUpdate(a.encodeUpdate([1])).removed, [], 'announcing it twice is harmless');
  a.setLocalState({ here: 'again' });
  assert.deepEqual(b.applyUpdate(a.encodeUpdate([1])).added, [1]);
  const d = make(4);
  assert.deepEqual(d.applyUpdate(bytes(1, 7, 3, 4, 0x6e, 0x75, 0x6c, 0x6c)).removed, [], 'a null for a client we never knew removes nothing');
});

test('nobody else can write or erase our state: an announcement that we left is outvoted', () => {
  const a = make(1);
  a.setLocalState({ me: 'ann' });
  const evilGone = bytes(1, 1, a.clockOf(1)!, 4, 0x6e, 0x75, 0x6c, 0x6c);
  a.applyUpdate(evilGone);
  assert.deepEqual(a.getLocalState(), { me: 'ann' });
  assert.ok(a.clockOf(1)! > Buffer.from(evilGone)[2]!, 'our clock moved past the false announcement');
  const body = Buffer.from('{"me":"mallory"}');
  a.applyUpdate(bytes(1, 1, 99, body.length, ...body));
  assert.deepEqual(a.getLocalState(), { me: 'ann' }, 'a remote state for our own id is ignored');
});

test('states that are not refreshed time out; the heartbeat keeps a live client; our own never times out', () => {
  const c = clock();
  const [a, b] = [make(1, c), make(2, c)];
  a.setLocalState({ x: 1 });
  b.applyUpdate(a.encodeUpdate([1]));
  c.t += 29_999;
  assert.deepEqual(b.prune(), []);
  c.t += 1;
  assert.deepEqual(b.prune(), [1]);
  assert.equal(b.getStates().has(1), false);
  assert.ok(b.getStates().has(2), 'our own state stays');
  assert.deepEqual(b.prune(), [], 'already gone');
  a.setLocalState({ x: 2 });
  b.applyUpdate(a.encodeUpdate([1]));
  for (let i = 0; i < 4; i++) {
    c.t += 15_000;
    assert.equal(a.renewIfDue(), true);
    b.applyUpdate(a.encodeUpdate([1]));
    assert.deepEqual(b.prune(), [], `heartbeat ${i}`);
  }
  c.t += 30_000;
  assert.deepEqual(b.prune(), [1], 'it stops when the heartbeats stop');
});

test('renewing waits for the interval, does nothing once left, and moves only the clock', () => {
  const c = clock();
  const a = make(1, c);
  a.setLocalState({ x: 1 });
  const before = a.clockOf(1)!;
  c.t += 14_999;
  assert.equal(a.renewIfDue(), false);
  c.t += 1;
  const seen: number[][] = [];
  a.on((ch) => seen.push([...ch.touched, ...ch.updated]));
  assert.equal(a.renewIfDue(), true);
  assert.equal(a.clockOf(1), before + 1);
  assert.deepEqual(seen, [[1]], 'a heartbeat touches the client but changes no state');
  a.setLocalState(null);
  c.t += 60_000;
  assert.equal(a.renewIfDue(), false);
});

test('listeners hear changes with their origin, and can be removed', () => {
  const [a, b] = [make(1), make(2)];
  const log: string[] = [];
  const off = b.on((ch, origin) => log.push(`${String(origin)}:${ch.added.join()}:${ch.updated.join()}:${ch.removed.join()}`));
  a.setLocalState({ v: 1 });
  b.applyUpdate(a.encodeUpdate([1]), 'ws-7');
  b.setLocalState({ mine: true });
  off();
  b.setLocalState({ mine: false });
  assert.deepEqual(log, ['ws-7:1::', 'local::2:']);
  assert.throws(() => a.setLocalField('__proto__', 1), /__proto__/);
  assert.throws(() => a.setLocalState({ big: 'x'.repeat(5000) }), /at most 4096/);
  assert.throws(() => new Awareness(-1, { now: Date.now }), AwarenessError);
});

test('hostile updates are refused before anything is applied', () => {
  const a = make(1);
  a.setLocalState({ ok: true });
  assert.throws(() => a.applyUpdate(bytes(1, 5, 1)), /ends in the middle|claims more bytes/);
  assert.throws(() => a.applyUpdate(bytes(1, 5, 1, 50, 0x7b)), /more bytes than the update has/);
  assert.throws(() => a.applyUpdate(bytes(1, 5, 1, 1, 0xff)), /not valid JSON|invalid|encoded/i);
  assert.throws(() => a.applyUpdate(bytes(1, 5, 1, 2, 0x7b, 0x7b)), /not valid JSON/);
  assert.throws(() => a.applyUpdate(bytes(1, 5, 1, 1, 0x31, 0x00)), /left over/);
  assert.throws(() => a.applyUpdate(bytes(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 1)), /too long/);
  assert.throws(() => a.applyUpdate(bytes(0xe9, 0x07)), /at most 1000 clients/);
  assert.throws(() => a.applyUpdate(new Uint8Array(1_048_577)), /1 MiB/);
  const big = Buffer.from(JSON.stringify({ s: 'x'.repeat(5000) }));
  assert.throws(() => a.applyUpdate(Uint8Array.from([1, 5, 1, ...varuint(big.length), ...big])), /at most 4096 bytes/);
  assert.deepEqual([...a.getStates().keys()], [1], 'nothing was applied');
  const small = new Awareness(1, { now: Date.now, maxClients: 2 });
  small.applyUpdate(bytes(1, 5, 1, 1, 0x31));
  assert.throws(() => small.applyUpdate(bytes(1, 6, 1, 1, 0x31)), /too many clients/);
});
const varuint = (n: number): number[] => (n < 128 ? [n] : [128 | (n % 128), ...varuint(Math.floor(n / 128))]);

test('a connection speaks only for the client ids it claimed first, and only as its own user', () => {
  const b = new IdentityBinder();
  b.connect('c1', 'ann');
  b.connect('c2', 'bob');
  const mk = (id: number, state: Json | null) => ({ id, clock: 1, state });
  assert.deepEqual(b.filter('c1', [mk(10, { user: { id: 'ann' } })]), { allowed: [mk(10, { user: { id: 'ann' } })], refused: [] });
  const spoof = b.filter('c2', [mk(10, { user: { id: 'bob' } }), mk(11, { user: { id: 'bob' } })]);
  assert.deepEqual(spoof.refused, [{ id: 10, why: 'the client id belongs to another connection' }]);
  assert.deepEqual(spoof.allowed.map((e) => e.id), [11]);
  const wrongUser = b.filter('c2', [mk(12, { user: { id: 'ann' } }), mk(13, null), mk(14, { cursor: 1 })]);
  assert.deepEqual(wrongUser.refused, [{ id: 12, why: 'the state names a different user' }]);
  assert.deepEqual(wrongUser.allowed.map((e) => e.id), [13, 14]);
  assert.equal(b.userOf(10), 'ann');
  assert.deepEqual(b.disconnect('c1').sort(), [10]);
  assert.equal(b.userOf(10), undefined);
  assert.deepEqual(b.disconnect('c1'), []);
  assert.throws(() => b.filter('nope', []), /unknown connection/);
  assert.throws(() => b.connect('c2', 'bob'), /already open/);
  assert.deepEqual(b.filter('c2', [mk(10, { user: { id: 'bob' } })]).refused, [], 'a freed id can be claimed');
});

test('the hub relays what a connection may say, rejects spoofing, and announces a closed connection as gone', () => {
  const c = clock();
  const hub = new AwarenessHub(new Awareness(0, { now: c.now }));
  const ann = new Awareness(10, { now: c.now });
  const bob = new Awareness(20, { now: c.now });
  hub.join('c1', 'ann');
  hub.join('c2', 'bob');
  ann.setLocalState({ user: { id: 'ann' }, cursor: 5 });
  bob.setLocalState({ user: { id: 'bob' }, cursor: 1 });
  const r1 = hub.receive('c1', ann.encodeUpdate([10]));
  assert.deepEqual(r1.change.added, [10]);
  const viewer = new Awareness(30, { now: c.now });
  viewer.applyUpdate(r1.relay);
  assert.deepEqual(viewer.getStates().get(10), { user: { id: 'ann' }, cursor: 5 });
  viewer.applyUpdate(hub.receive('c2', bob.encodeUpdate([20])).relay);
  const forged = new Awareness(10, { now: c.now });
  forged.setLocalState({ user: { id: 'bob' }, cursor: 99 });
  forged.setLocalState({ user: { id: 'bob' }, cursor: 100 });
  const r2 = hub.receive('c2', forged.encodeUpdate([10]));
  assert.deepEqual(r2.refused, [{ id: 10, why: 'the client id belongs to another connection' }]);
  assert.deepEqual(r2.change.touched, []);
  assert.deepEqual((hub.join('c3', 'cy') && viewer.decodeUpdate(hub.join('c4', 'dee')).map((e) => e.id).sort()), [10, 20]);
  const gone = hub.leave('c1');
  viewer.applyUpdate(gone);
  assert.equal(viewer.getStates().has(10), false, 'the viewer sees ann leave');
  assert.equal(viewer.getStates().has(20), true);
});

test('a user keeps one colour everywhere, people in a session get different ones, and the label is readable', () => {
  assert.deepEqual(userColour('ann@example.test'), userColour('ann@example.test'));
  assert.notDeepEqual(userColour('ann'), userColour('cy'));
  assert.match(userColour('ann').color, /^#[0-9a-f]{6}$/);
  assert.equal(userColour('ann').light, `${userColour('ann').color}33`);
  const users = Array.from({ length: PALETTE.length }, (_, i) => `user-${i}`);
  const assigned = assignColours(users);
  assert.equal(new Set([...assigned.values()].map((u) => u.color)).size, PALETTE.length, 'twelve people, twelve colours');
  const again = assignColours([...users].reverse());
  assert.deepEqual([...again.entries()].sort(), [...assigned.entries()].sort(), 'the order people arrive does not matter');
  assert.equal(new Set([...assignColours(['a', 'a', 'a']).keys()]).size, 1);
  assert.equal(assignColours(Array.from({ length: 13 }, (_, i) => `u${i}`)).size, 13, 'more people than colours share, they are not refused');
  for (const color of PALETTE) assert.ok(contrast(color, textOn(color)) >= 4.5, `${color} with ${textOn(color)}`);
  assert.equal(luminance('#ffffff'), 1);
  assert.equal(luminance('#000000'), 0);
  assert.equal(Math.round(contrast('#ffffff', '#000000')), 21);
  assert.equal(textOn('#ffff00'), '#000000');
  assert.equal(textOn('#000080'), '#ffffff');
  assert.throws(() => luminance('red'), /#rrggbb/);
});

test('text positions follow inserts and deletes; an insert at the cursor moves it or not by assoc', () => {
  const ins = (at: number, length: number): Edit => ({ type: 'insert', at, length });
  const del = (at: number, length: number): Edit => ({ type: 'delete', at, length });
  assert.equal(transformIndex(10, ins(4, 3)), 13);
  assert.equal(transformIndex(10, ins(10, 3), 1), 13, 'typing at the cursor pushes it');
  assert.equal(transformIndex(10, ins(10, 3), -1), 10, 'or leaves it before the new text');
  assert.equal(transformIndex(10, ins(11, 3)), 10);
  assert.equal(transformIndex(10, del(2, 3)), 7);
  assert.equal(transformIndex(10, del(8, 5)), 8, 'inside the deleted range collapses to its start');
  assert.equal(transformIndex(10, del(10, 5)), 10);
  assert.equal(transformIndex(10, del(11, 5)), 10);
  assert.equal(transformIndex(0, del(0, 4)), 0);
  assert.deepEqual(transformSelection({ anchor: 2, head: 6 }, [ins(0, 2), del(5, 2), ins(8, 1)]), { anchor: 4, head: 6 });
  assert.deepEqual(transformSelection({ anchor: 6, head: 2 }, [ins(2, 2)]), { anchor: 8, head: 4 }, 'a backwards selection keeps its direction');
  assert.deepEqual(transformSelection({ anchor: 3, head: 3 }, [ins(3, 2)]), { anchor: 3, head: 5 }, 'an empty selection grows when text is typed at it by someone else');
  assert.equal(clampIndex(50, 10), 10);
  assert.equal(clampIndex(-3, 10), 0);
  assert.throws(() => transformIndex(-1, ins(0, 1)), /whole number/);
  assert.throws(() => transformIndex(1, ins(0, -1)), /position and a length/);
  assert.throws(() => transformIndex(1.5, ins(0, 1)), AwarenessError);
});

test('pointer positions go between screen and canvas under scroll and zoom, and back', () => {
  const v = { scrollX: 100, scrollY: -50, zoom: 2 };
  assert.deepEqual(toScene({ x: 400, y: 200 }, v), { x: 100, y: 150 });
  assert.deepEqual(toScreen({ x: 100, y: 150 }, v), { x: 400, y: 200 });
  const p = { x: 123.5, y: -77.25 };
  const back = toScreen(toScene(p, v), v);
  assert.ok(Math.abs(back.x - p.x) < 1e-9 && Math.abs(back.y - p.y) < 1e-9);
  const other = { scrollX: 0, scrollY: 0, zoom: 0.5 };
  assert.deepEqual(toScreen(toScene({ x: 400, y: 200 }, v), other), { x: 50, y: 75 }, 'the same canvas point on a zoomed-out viewer');
  for (const zoom of [0, -1, Number.NaN, Infinity]) assert.throws(() => toScene({ x: 1, y: 1 }, { scrollX: 0, scrollY: 0, zoom }), /positive/, String(zoom));
});

test('clients that exchange updates in any order, with repeats, agree (50 random sessions)', () => {
  const rng = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let seed = 1; seed <= 50; seed++) {
    const r = rng(seed);
    const c = clock();
    const nodes = [1, 2, 3, 4].map((id) => new Awareness(id, { now: c.now }));
    const updates: Uint8Array[] = [];
    for (let i = 0; i < 30; i++) {
      const n = nodes[Math.floor(r() * 4)]!;
      if (r() < 0.15) n.setLocalState(null);
      else n.setLocalState({ step: i, at: Math.floor(r() * 100) });
      updates.push(n.encodeUpdate([n.clientId]));
    }
    for (const n of nodes) for (const u of [...updates, ...updates].sort(() => r() - 0.5)) n.applyUpdate(u);
    const view = (n: Awareness) => JSON.stringify([...n.getStates()].filter(([id]) => id !== n.clientId).sort((x, y) => x[0] - y[0]));
    for (const n of nodes) {
      const others = nodes.filter((o) => o !== n);
      for (const o of others) {
        const mine = [...n.getStates()].filter(([id]) => id === o.clientId);
        const theirs = [...o.getStates()].filter(([id]) => id === o.clientId);
        assert.equal(JSON.stringify(mine.length ? mine[0]![1] : null), JSON.stringify(theirs.length ? theirs[0]![1] : null), `seed ${seed}: ${n.clientId} sees ${o.clientId}`);
      }
    }
    assert.ok(view(nodes[0]!).length >= 2);
  }
});
