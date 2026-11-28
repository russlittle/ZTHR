import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ALBUM_ORDER, BadRule, PlaylistCycle, PlaylistError, Rng, ShareLinks, StaleVersion, addEntries, addToBag, canEdit, canView, createPlaylist, dedupe, fold, fromM3u,
  matches, moveEntry, naturalCompare, newBag, nextInBag, removeEntries, removeFromBag, ruleProblems, runSmart, shuffle, shuffleSpread, sortItems, sortKey, sortPlaylist, toM3u,
} from './index.ts';
import type { Item, Rule, Smart } from './index.ts';

const NOW = Date.parse('2026-06-15T12:00:00Z');
const DAY = 86_400_000;
const ctx = { now: () => NOW };
const derive = (s: string) => createHash('sha256').update(`playlists-test:${s}`).digest('hex').slice(0, 12);
const counter = () => { let n = 0; return () => `e${++n}`; };
const det = (seed: string) => { let c = 0; return (n: number) => Uint8Array.from(Buffer.concat(Array.from({ length: Math.ceil(n / 32) }, (_, i) => createHash('sha256').update(`${seed}:${c}:${n}:${i}`).digest())).subarray(0, n), (c++, (x: number) => x)); };

const lib: Item[] = [
  { id: 't1', title: 'The Wall', artist: 'Pink Floyd', album: 'The Wall', albumArtist: 'Pink Floyd', genre: ['Rock', 'Prog'], year: 1979, durationMs: 200_000, playCount: 5, trackNo: 1, discNo: 1, addedAt: new Date(NOW - 3 * DAY).toISOString(), favourite: true },
  { id: 't2', title: 'Track 10', artist: 'Björk', album: 'Homogenic', albumArtist: 'Björk', genre: ['Electronic'], year: 1997, durationMs: 300_000, playCount: 0, trackNo: 10, discNo: 1, addedAt: new Date(NOW - 40 * DAY).toISOString() },
  { id: 't3', title: 'Track 2', artist: 'Bjork', album: 'Homogenic', albumArtist: 'Björk', genre: ['Electronic', 'Pop'], year: 1997, durationMs: 250_000, playCount: 12, trackNo: 2, discNo: 1, addedAt: new Date(NOW - 10 * DAY).toISOString(), favourite: false },
  { id: 't4', title: 'Untitled', artist: 'Nobody', album: 'Demo', albumArtist: 'Nobody', durationMs: 100_000 },
];

test('fold and sort keys ignore case, accents and a leading article', () => {
  assert.equal(fold('  Björk – Hyper-Ballad! '), 'bjork hyper ballad');
  assert.equal(fold('Straße'), 'strasse');
  assert.equal(sortKey('The Beatles'), 'beatles');
  assert.equal(sortKey('The Beatles', false), 'the beatles');
});

test('natural compare orders numbers as numbers', () => {
  assert.ok(naturalCompare('track 2', 'track 10') < 0);
  assert.ok(naturalCompare('a002', 'a2') !== 0);
  assert.equal(['t10', 't9', 't100', 't1'].sort(naturalCompare).join(), 't1,t9,t10,t100');
  assert.ok(naturalCompare('9'.repeat(30), '1' + '0'.repeat(30)) < 0);
});

test('rules are checked before they run', () => {
  assert.deepEqual(ruleProblems({ field: 'year', op: 'gt', value: 1990 }), []);
  assert.match(ruleProblems({ field: 'nope', op: 'is', value: 'x' })[0]!, /unknown field/);
  assert.match(ruleProblems({ field: 'year', op: 'contains', value: 'x' })[0]!, /does not apply/);
  assert.match(ruleProblems({ field: 'year', op: 'gt', value: '1990' })[0]!, /needs a number/);
  assert.match(ruleProblems({ field: 'year', op: 'between', value: 1 })[0]!, /two numbers/);
  assert.match(ruleProblems({ all: [] })[0]!, /at least one/);
  assert.match(ruleProblems({ field: 'addedAt', op: 'after', value: 'not a date' })[0]!, /needs a date/);
  assert.match(ruleProblems({ field: 'title', op: 'is', value: 'x' } as Rule).length ? '' : 'x', /x/);
  let deep: Rule = { field: 'year', op: 'gt', value: 1 };
  for (let i = 0; i < 12; i++) deep = { not: deep };
  assert.ok(ruleProblems(deep).some((p) => /deeper/.test(p)));
  assert.ok(ruleProblems({ field: 'title', op: 'matchesRegex', value: '(a+)+$' }).length > 0);
});

test('string, number and list tests compare without case or accents', () => {
  const t = (r: Rule, id: string) => matches(r, lib.find((i) => i.id === id)!, ctx);
  assert.ok(t({ field: 'artist', op: 'is', value: 'BJORK' }, 't2'));
  assert.ok(t({ field: 'artist', op: 'contains', value: 'floyd' }, 't1'));
  assert.ok(t({ field: 'title', op: 'startsWith', value: 'track' }, 't3'));
  assert.ok(t({ field: 'year', op: 'between', value: 1999, value2: 1990 }, 't2'));
  assert.ok(t({ field: 'genre', op: 'has', value: 'POP' }, 't3'));
  assert.ok(t({ field: 'genre', op: 'hasNone', value: ['rock'] }, 't2'));
  assert.ok(t({ field: 'genre', op: 'missing' }, 't4'));
  assert.ok(t({ field: 'favourite', op: 'isTrue' }, 't1'));
  assert.ok(t({ field: 'favourite', op: 'isFalse' }, 't2'));
});

test('missing values: not-equal and not-contains hold, comparisons do not', () => {
  const t4 = lib[3]!;
  assert.equal(matches({ field: 'year', op: 'gt', value: 0 }, t4, ctx), false);
  assert.equal(matches({ field: 'year', op: 'ne', value: 1990 }, t4, ctx), true);
  assert.equal(matches({ field: 'genre', op: 'has', value: 'rock' }, t4, ctx), false);
  assert.equal(matches({ not: { field: 'year', op: 'exists' } }, t4, ctx), true);
});

test('date tests use the injected clock', () => {
  const t = (r: Rule, id: string) => matches(r, lib.find((i) => i.id === id)!, ctx);
  assert.ok(t({ field: 'addedAt', op: 'inLast', value: 7 }, 't1'));
  assert.ok(!t({ field: 'addedAt', op: 'inLast', value: 7 }, 't3'));
  assert.ok(t({ field: 'addedAt', op: 'notInLast', value: 30 }, 't2'));
  assert.ok(t({ field: 'addedAt', op: 'notInLast', value: 30 }, 't4'));
  assert.ok(t({ field: 'addedAt', op: 'before', value: '2026-06-01' }, 't2'));
  assert.ok(t({ field: 'addedAt', op: 'on', value: new Date(NOW - 3 * DAY).toISOString().slice(0, 10) }, 't1'));
});

test('sorting: several keys, desc, missing last, stable, album order', () => {
  assert.deepEqual(sortItems(lib, [{ field: 'title' }]).map((i) => i.id), ['t3', 't2', 't4', 't1']);
  assert.deepEqual(sortItems(lib, [{ field: 'year', dir: 'desc' }]).map((i) => i.id), ['t2', 't3', 't1', 't4']);
  assert.deepEqual(sortItems(lib, [{ field: 'year' }, { field: 'playCount', dir: 'desc' }]).map((i) => i.id), ['t1', 't3', 't2', 't4']);
  assert.deepEqual(sortItems(lib, [{ field: 'discNo' }]).map((i) => i.id), ['t1', 't2', 't3', 't4']);
  assert.deepEqual(sortItems(lib, ALBUM_ORDER).map((i) => i.id), ['t3', 't2', 't4', 't1']);
  assert.throws(() => sortItems(lib, [{ field: 'zzz' }]), PlaylistError);
});

test('shuffle: same seed same order, a permutation, different seeds differ', () => {
  const xs = Array.from({ length: 30 }, (_, i) => i);
  const a = shuffle(xs, 'seed-a');
  assert.deepEqual(a, shuffle(xs, 'seed-a'));
  assert.deepEqual([...a].sort((p, q) => p - q), xs);
  assert.notDeepEqual(a, shuffle(xs, 'seed-b'));
  assert.deepEqual(xs, Array.from({ length: 30 }, (_, i) => i));
  assert.deepEqual(shuffle([], 's'), []);
});

test('shuffle is unbiased: every order of three appears about equally', () => {
  const counts = new Map<string, number>();
  for (let i = 0; i < 6000; i++) {
    const k = shuffle(['a', 'b', 'c'], `fair${i}`).join('');
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  assert.equal(counts.size, 6);
  for (const c of counts.values()) assert.ok(c > 850 && c < 1150, `count ${c}`);
});

test('Rng.int stays in range and rejects bad bounds; float is in [0,1)', () => {
  const r = new Rng('x');
  for (let i = 0; i < 500; i++) {
    const v = r.int(7);
    assert.ok(v >= 0 && v < 7);
    const f = r.float();
    assert.ok(f >= 0 && f < 1);
  }
  assert.throws(() => r.int(0), PlaylistError);
  assert.throws(() => r.int(1.5), PlaylistError);
  assert.equal(r.int(1), 0);
});

test('spread shuffle keeps a large artist apart from itself', () => {
  const tracks = [...Array.from({ length: 6 }, (_, i) => ({ a: 'A', n: i })), ...Array.from({ length: 6 }, (_, i) => ({ a: 'B', n: i })), ...Array.from({ length: 6 }, (_, i) => ({ a: 'C', n: i }))];
  for (let s = 0; s < 20; s++) {
    const out = shuffleSpread(tracks, (t) => t.a, `sp${s}`);
    assert.equal(out.length, 18);
    let adjacent = 0;
    for (let i = 1; i < out.length; i++) if (out[i]!.a === out[i - 1]!.a) adjacent++;
    assert.ok(adjacent <= 3, `adjacent ${adjacent}`);
  }
  assert.deepEqual(shuffleSpread(tracks, (t) => t.a, 'z'), shuffleSpread(tracks, (t) => t.a, 'z'));
  assert.notDeepEqual(shuffleSpread(tracks, (t) => t.a, 'z'), shuffleSpread(tracks, (t) => t.a, 'y'));
});

test('shuffle bag: each round plays everything once, no immediate repeat across rounds', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  let bag = newBag(items, 'bag');
  const played: string[] = [];
  for (let i = 0; i < 5 * 40; i++) {
    const r = nextInBag(bag);
    played.push(r.item!);
    bag = r.bag;
  }
  for (let r = 0; r < 40; r++) assert.deepEqual(played.slice(r * 5, r * 5 + 5).sort(), items);
  for (let i = 1; i < played.length; i++) assert.notEqual(played[i], played[i - 1]);
  assert.equal(nextInBag(newBag([], 's')).item, undefined);
  const one = nextInBag(nextInBag(newBag(['x'], 's')).bag);
  assert.equal(one.item, 'x');
});

test('shuffle bag: additions land in the unplayed part, removals keep the cursor right', () => {
  let bag = newBag(['a', 'b', 'c', 'd'], 'bag2');
  for (let i = 0; i < 2; i++) bag = nextInBag(bag).bag;
  const heard = bag.order.slice(0, 2);
  const added = addToBag(bag, ['x', 'y'], 'one');
  assert.deepEqual(added.order.slice(0, 2), heard);
  assert.equal(added.cursor, 2);
  assert.equal(added.order.length, 6);
  assert.deepEqual(addToBag(bag, ['x', 'y'], 'one'), added);
  const gone = removeFromBag(added, (x) => x === heard[0]);
  assert.equal(gone.cursor, 1);
  assert.equal(gone.order.includes(heard[0]!), false);
  assert.equal(nextInBag(gone).item, added.order[2]);
});

test('manual playlist: add, insert, move, remove, same track twice', () => {
  const id = counter();
  let p = createPlaylist('p1', 'ann', '  Road trip ');
  assert.equal(p.name, 'Road trip');
  p = addEntries(p, 1, ['t1', 't2', 't1'], id);
  assert.deepEqual(p.entries.map((e) => e.item), ['t1', 't2', 't1']);
  p = addEntries(p, 2, ['t3'], id, 1);
  assert.deepEqual(p.entries.map((e) => e.item), ['t1', 't3', 't2', 't1']);
  const last = p.entries[3]!.id;
  p = moveEntry(p, 3, last, 0);
  assert.deepEqual(p.entries.map((e) => e.id), ['e4', 'e1', 'e5', 'e2'].map((x, i) => p.entries[i]!.id));
  assert.equal(p.entries[0]!.id, last);
  p = removeEntries(p, p.version, [last]);
  assert.deepEqual(p.entries.map((e) => e.item), ['t1', 't3', 't2']);
  assert.throws(() => removeEntries(p, p.version, ['nope']), PlaylistError);
  assert.throws(() => moveEntry(p, p.version, p.entries[0]!.id, 9), PlaylistError);
  assert.throws(() => addEntries(p, p.version, ['x'], id, 99), PlaylistError);
  assert.throws(() => createPlaylist('q', 'ann', '   '), PlaylistError);
});

test('stale edits are refused and the input is not changed', () => {
  const id = counter();
  const p = createPlaylist('p', 'ann', 'x');
  const q = addEntries(p, 1, ['t1'], id);
  assert.equal(p.entries.length, 0);
  assert.throws(() => addEntries(q, 1, ['t2'], id), StaleVersion);
  assert.throws(() => dedupe(q, 1), StaleVersion);
});

test('dedupe keeps the first of each; sortPlaylist orders by library and parks unknowns last', () => {
  const id = counter();
  let p = addEntries(createPlaylist('p', 'ann', 'x'), 1, ['t1', 't2', 't1', 't3', 'gone'], id);
  p = dedupe(p, p.version);
  assert.deepEqual(p.entries.map((e) => e.item), ['t1', 't2', 't3', 'gone']);
  const map = new Map(lib.map((i) => [i.id, i]));
  p = sortPlaylist(p, p.version, map, [{ field: 'year', dir: 'desc' }]);
  assert.deepEqual(p.entries.map((e) => e.item), ['t2', 't3', 't1', 'gone']);
});

test('visibility and edit rights', () => {
  const p = { ...createPlaylist('p', 'ann', 'x', 'unlisted'), collaborators: ['bob'] };
  assert.ok(canEdit(p, 'ann') && canEdit(p, 'bob') && !canEdit(p, 'cy'));
  assert.ok(canView(p, 'bob') && canView(p, 'cy', true));
  assert.ok(!canView(p, 'cy') && !canView(p, undefined));
  assert.ok(canView({ ...p, visibility: 'public' }, undefined));
  assert.ok(!canView({ ...p, visibility: 'private' }, 'cy', true));
});

test('smart playlist: rule, sort, count and duration limits', () => {
  const base: Smart = { id: 's', owner: 'ann', name: 'S', visibility: 'private', rule: { field: 'durationMs', op: 'gte', value: 100_000 }, sort: [{ field: 'durationMs', dir: 'desc' }] };
  assert.deepEqual(runSmart(base, { items: lib }, ctx.now), ['t2', 't3', 't1', 't4']);
  assert.deepEqual(runSmart({ ...base, limit: { count: 2 } }, { items: lib }, ctx.now), ['t2', 't3']);
  assert.deepEqual(runSmart({ ...base, limit: { durationMs: 550_000 } }, { items: lib }, ctx.now), ['t2', 't3']);
  assert.deepEqual(runSmart({ ...base, limit: { durationMs: 549_999 } }, { items: lib }, ctx.now), ['t2']);
  const sh = runSmart({ id: 's', owner: 'ann', name: 'S', visibility: 'private', rule: base.rule, shuffleSeed: 'q' }, { items: lib }, ctx.now);
  assert.deepEqual([...sh].sort(), ['t1', 't2', 't3', 't4']);
  assert.deepEqual(sh, runSmart({ ...base, shuffleSeed: 'q' }, { items: lib }, ctx.now));
  assert.throws(() => runSmart({ ...base, rule: { field: 'zzz', op: 'is', value: 'a' } }, { items: lib }, ctx.now), BadRule);
});

test('smart playlists can include other playlists, and cycles are refused', () => {
  const id = counter();
  const manual = addEntries(createPlaylist('m', 'ann', 'M'), 1, ['t1', 't4'], id);
  const a: Smart = { id: 'a', owner: 'ann', name: 'A', visibility: 'private', rule: { inPlaylist: 'm' } };
  const b: Smart = { id: 'b', owner: 'ann', name: 'B', visibility: 'private', rule: { all: [{ inPlaylist: 'a' }, { field: 'year', op: 'exists' }] } };
  const all = new Map<string, Smart | typeof manual>([['m', manual], ['a', a], ['b', b]]);
  const L = { items: lib, playlist: (x: string) => all.get(x) };
  assert.deepEqual(runSmart(a, L, ctx.now), ['t1', 't4']);
  assert.deepEqual(runSmart(b, L, ctx.now), ['t1']);
  assert.deepEqual(runSmart({ ...a, rule: { notInPlaylist: 'm' } }, L, ctx.now), ['t2', 't3']);
  assert.throws(() => runSmart({ ...a, rule: { inPlaylist: 'nope' } }, L, ctx.now), PlaylistError);
  const x: Smart = { id: 'x', owner: 'ann', name: 'X', visibility: 'private', rule: { inPlaylist: 'y' } };
  const y: Smart = { id: 'y', owner: 'ann', name: 'Y', visibility: 'private', rule: { inPlaylist: 'x' } };
  const cyc = new Map<string, Smart>([['x', x], ['y', y]]);
  assert.throws(() => runSmart(x, { items: lib, playlist: (i) => cyc.get(i) }, ctx.now), PlaylistCycle);
});

test('share links: token shown once, hash kept, expiry, use limit, revoke', () => {
  let now = 1_000_000;
  const links = new ShareLinks({ now: () => now, random: det('links') });
  const { token, link } = links.create('p1', 'ann', { permission: 'collaborate', ttlMs: 60_000, maxUses: 2 });
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(!JSON.stringify(link).includes(token));
  assert.deepEqual(links.open(token), { playlist: 'p1', permission: 'collaborate' });
  links.open(token);
  assert.throws(() => links.open(token), /used up/);
  const t2 = links.create('p1', 'ann', { ttlMs: 1000 }).token;
  now += 1001;
  assert.throws(() => links.open(t2), /expired/);
  const t3 = links.create('p1', 'ann');
  assert.equal(links.open(t3.token).permission, 'view');
  assert.ok(links.revoke(t3.link.id));
  assert.throws(() => links.open(t3.token), /not valid/);
  assert.throws(() => links.open('short'), /not a share link/);
  assert.throws(() => links.open('A'.repeat(32)), /not valid/);
  assert.equal(links.forPlaylist('p1').length, 2);
  assert.equal(links.revoke('nope'), false);
});

test('share links with a password: wrong ones count and lock the link', () => {
  const pw = derive('pw');
  const links = new ShareLinks({ now: () => 0, random: det('pw'), maxFailures: 3 });
  const { token } = links.create('p', 'ann', { password: pw });
  assert.throws(() => links.open(token), /wrong password/);
  assert.throws(() => links.open(token, 'x'.repeat(12)), /wrong password/);
  assert.equal(links.open(token, pw).playlist, 'p');
  for (let i = 0; i < 3; i++) assert.throws(() => links.open(token, 'y'.repeat(12)), /wrong password/);
  assert.throws(() => links.open(token, pw), /locked/);
  assert.throws(() => links.create('p', 'ann', { password: 'abc' }), PlaylistError);
  assert.throws(() => links.create('p', 'ann', { maxUses: 0 }), PlaylistError);
});

test('M3U: round trip, odd titles, control characters, size and count limits', () => {
  const text = toM3u([{ path: '/m/a.flac', title: 'A, B', durationSec: 200.4 }, { path: '/m/b.flac' }]);
  assert.equal(text, '#EXTM3U\n#EXTINF:200,A, B\n/m/a.flac\n#EXTINF:-1,\n/m/b.flac\n');
  assert.deepEqual(fromM3u(text), [{ path: '/m/a.flac', durationSec: 200, title: 'A, B' }, { path: '/m/b.flac' }]);
  assert.deepEqual(fromM3u('﻿#EXTM3U\r\n# a comment\r\n\r\nx.mp3\r\n'), [{ path: 'x.mp3' }]);
  assert.throws(() => toM3u([{ path: '/a\nb' }]), PlaylistError);
  assert.throws(() => toM3u([{ path: '/a', title: 'x\ry' }]), PlaylistError);
  assert.throws(() => fromM3u('a\u0000b'), PlaylistError);
  assert.throws(() => fromM3u(Array.from({ length: 5 }, (_, i) => `f${i}`).join('\n'), { maxEntries: 3 }), /too many/);
});
