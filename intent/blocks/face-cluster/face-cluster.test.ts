import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClusterError, People, agglomerative, centroid, cosineDistance, dbscan, norm, unit, type FaceInput } from './index.ts';

const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const DIM = 16;
const centreOf = (k: number) => {
  const r = rng(1000 + k * 7919);
  return unit(Array.from({ length: DIM }, () => r() * 2 - 1));
};
const around = (k: number, seed: number, spread = 0.05) => {
  const r = rng(seed);
  return Array.from(centreOf(k), (x) => x + (r() - 0.5) * 2 * spread);
};
let n = 0;
/** `count` faces of person k. */
const faces = (k: number, count: number, score = 0.95, prefix = `p${k}`): FaceInput[] =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, assetId: `asset${++n}`, embedding: around(k, k * 100 + i + 1), score }));
const ids = (...fs: FaceInput[][]) => fs.flat().map((f) => f.id);
const sortedGroups = (p: People) => p.people().map((x) => [...x.faces]).sort((a, b) => (a[0] as string).localeCompare(b[0] as string));

test('cosine distance: zero for the same direction, one for orthogonal, two for opposite, and length does not matter', () => {
  assert.equal(cosineDistance([1, 0], [5, 0]), 0);
  assert.ok(Math.abs(cosineDistance([1, 0], [0, 3]) - 1) < 1e-12);
  assert.ok(Math.abs(cosineDistance([1, 0], [-2, 0]) - 2) < 1e-12);
  assert.throws(() => cosineDistance([1, 2], [1, 2, 3]), /cannot be compared/);
  assert.throws(() => cosineDistance([0, 0], [1, 1]), /all zero/);
  assert.throws(() => unit([NaN, 1]), /finite/);
  assert.ok(Math.abs(norm(centroid([[1, 0], [0, 1]])) - 1) < 1e-12);
  assert.throws(() => centroid([]), /at least one/);
});

test('DBSCAN finds dense groups, leaves strays as noise, and numbers clusters in order', () => {
  const pts = [...faces(1, 5), ...faces(2, 5), ...faces(3, 1)].map((f) => f.embedding);
  const l = dbscan(pts, 0.2, 3);
  assert.deepEqual(l.slice(0, 5), [0, 0, 0, 0, 0]);
  assert.deepEqual(l.slice(5, 10), [1, 1, 1, 1, 1]);
  assert.equal(l[10], -1);
  assert.deepEqual(dbscan(pts, 0.2, 3), l);
  assert.deepEqual(dbscan(pts, 0.2, 6).every((x) => x === -1), true);
  assert.deepEqual(dbscan([], 0.2, 3), []);
  assert.throws(() => dbscan(pts, -1, 3), /eps/);
  assert.throws(() => dbscan(pts, 0.2, 0), /minPoints/);
});

test('DBSCAN keeps a border point that is near a core point but not core itself', () => {
  const at = (r: number) => [Math.cos(r), Math.sin(r)];
  const eps = 1 - Math.cos(0.105); // neighbours within about 0.1 rad
  const a = [0, 0.1, 0.2, 0.3].map(at); // 0 and 0.3 each have only one neighbour: borders, not cores
  assert.deepEqual(dbscan(a, eps, 3), [0, 0, 0, 0]);
  assert.deepEqual(dbscan([...a, at(2)], eps, 3), [0, 0, 0, 0, -1]);
  assert.deepEqual(dbscan([[1, 0], [0, 1]], 0.1, 2), [-1, -1]);
});

test('agglomerative clustering: the threshold decides, the linkage changes the shape, nothing is noise', () => {
  const pts = [...faces(1, 4), ...faces(2, 4)].map((f) => f.embedding);
  assert.deepEqual(agglomerative(pts, 0.2), [0, 0, 0, 0, 1, 1, 1, 1]);
  assert.deepEqual(agglomerative(pts, 1.5).every((x) => x === 0), true);
  assert.deepEqual(agglomerative(pts, 0), [0, 1, 2, 3, 4, 5, 6, 7]);
  // a chain of points each 0.1 from the next: single links all, complete does not
  const chain = [0, 1, 2, 3, 4].map((i) => [Math.cos(i * 0.45), Math.sin(i * 0.45)]);
  const step = cosineDistance(chain[0] as number[], chain[1] as number[]);
  assert.equal(new Set(agglomerative(chain, step * 1.01, 'single')).size, 1);
  assert.ok(new Set(agglomerative(chain, step * 1.01, 'complete')).size > 1);
  assert.throws(() => agglomerative(pts, -0.1), /threshold/);
});

test('re-clustering turns faces into people, and weak or lonely faces stay unassigned', () => {
  const p = new People({ minFaces: 3, minScore: 0.7 });
  const weak = faces(1, 3, 0.4, 'weak'); // same person as group 1, but detected with low confidence
  const lone = faces(9, 1, 0.95, 'lone');
  p.addFaces([...faces(1, 5), ...faces(2, 4), ...weak, ...lone]);
  const people = p.recluster();
  assert.equal(people.length, 2);
  assert.deepEqual(people.map((x) => x.faces.length), [5, 4]);
  assert.deepEqual(p.unassigned(), ['lone-0', 'weak-0', 'weak-1', 'weak-2']);
  assert.equal(people[0]?.representative, 'p1-0'); // all scores tie: the lowest id
});

test('the agglomerative choice gives the same people on well separated data', () => {
  const a = new People({ algorithm: 'dbscan' });
  const b = new People({ algorithm: 'agglomerative', eps: 0.3 });
  const input = [...faces(1, 4), ...faces(2, 4), ...faces(3, 3)];
  a.addFaces(input);
  b.addFaces(input);
  a.recluster();
  b.recluster();
  assert.deepEqual(sortedGroups(a), sortedGroups(b));
  assert.equal(sortedGroups(a).length, 3);
});

test('a named person keeps their id and name when more photos arrive and everything is re-clustered', () => {
  const p = new People({ minFaces: 3 });
  p.addFaces([...faces(1, 4), ...faces(2, 4)]);
  const [first] = p.recluster();
  const id = first?.id as string;
  p.name(id, 'Ana');
  p.addFaces(faces(1, 3, 0.9, 'more'));
  const again = p.recluster();
  assert.equal(again.find((x) => x.id === id)?.name, 'Ana');
  assert.equal(again.find((x) => x.id === id)?.faces.length, 7);
  assert.equal(again.length, 2);
  p.name(id, '  ');
  assert.equal(p.person(id)?.name, undefined);
  assert.throws(() => p.name('nope', 'x'), (e) => e instanceof ClusterError && e.code === 'not-found');
});

test('merge folds two people into one and keeps it through re-clustering; two different names need a choice', () => {
  const p = new People({ minFaces: 3 });
  p.addFaces([...faces(1, 4), ...faces(2, 4)]);
  const before = p.recluster();
  assert.equal(before.length, 2);
  const [x, y] = before as [typeof before[0], typeof before[0]];
  p.name(x!.id, 'Ana');
  p.name(y!.id, 'Ana B');
  assert.throws(() => p.merge(x!.id, y!.id), /say which name/);
  const merged = p.merge(x!.id, y!.id, { name: 'Ana' });
  assert.equal(merged.faces.length, 8);
  assert.equal(merged.name, 'Ana');
  assert.equal(p.person(y!.id), undefined);
  assert.equal(p.recluster().length, 1);
  assert.equal(p.recluster()[0]?.faces.length, 8);
  p.addFaces(faces(2, 3, 0.9, 'later')); // new faces of the folded-in person land with the merged one
  assert.equal(p.recluster()[0]?.faces.length, 11);
  assert.throws(() => p.merge(x!.id, x!.id), /themselves/);
  assert.throws(() => p.merge(x!.id, 'p99'), /no person/);
});

test('merging an unnamed person into a named one keeps the name', () => {
  const p = new People({ minFaces: 3 });
  p.addFaces([...faces(1, 3), ...faces(2, 3)]);
  const [x, y] = p.recluster() as [ReturnType<People['people']>[0], ReturnType<People['people']>[0]];
  p.name(y!.id, 'Bo');
  assert.equal(p.merge(x!.id, y!.id).name, 'Bo');
});

test('split moves chosen faces to a new person that stays apart after re-clustering', () => {
  const p = new People({ minFaces: 3 });
  const input = faces(1, 6);
  p.addFaces(input);
  const [one] = p.recluster();
  const moved = ['p1-4', 'p1-5'];
  const created = p.split(one!.id, moved);
  assert.deepEqual(created.faces, moved);
  assert.equal(p.person(one!.id)?.faces.length, 4);
  p.recluster();
  assert.equal(p.personOf('p1-4'), created.id);
  assert.equal(p.personOf('p1-0'), one!.id);
  assert.throws(() => p.split(one!.id, ['nope']), /not in/);
  assert.throws(() => p.split(one!.id, []), /at least one/);
  assert.throws(() => p.split(one!.id, ['p1-0', 'p1-1', 'p1-2', 'p1-3']), /nothing would be left/);
});

test('rejecting a face removes it and it is never put back, even when it looks like them', () => {
  const p = new People({ minFaces: 3 });
  p.addFaces(faces(1, 5));
  const [one] = p.recluster();
  p.reject('p1-2', one!.id);
  assert.equal(p.personOf('p1-2'), undefined);
  p.recluster();
  assert.equal(p.personOf('p1-2'), undefined);
  assert.equal(p.person(one!.id)?.faces.length, 4);
  assert.ok(p.unassigned().includes('p1-2'));
});

test('assigning a face by hand pins it, and a pinned low-confidence face is used rather than dropped', () => {
  const p = new People({ minFaces: 3, minScore: 0.8 });
  p.addFaces([...faces(1, 4), ...faces(2, 4), { id: 'blurry', assetId: 'b', embedding: around(1, 777, 0.1), score: 0.3 }]);
  const people = p.recluster();
  assert.equal(p.personOf('blurry'), undefined);
  const one = people.find((x) => x.faces.includes('p1-0'))!;
  p.assign('blurry', one.id);
  p.recluster();
  assert.equal(p.personOf('blurry'), one.id);
  // pinned to the wrong person on purpose: it stays there
  const two = people.find((x) => x.faces.includes('p2-0'))!;
  p.assign('p1-0', two.id);
  p.recluster();
  assert.equal(p.personOf('p1-0'), two.id);
  assert.throws(() => p.assign('nope', one.id), /no face/);
});

test('recognising a new face needs a close match and a clear winner', () => {
  const p = new People({ minFaces: 3 });
  p.addFaces([...faces(1, 4), ...faces(2, 4)]);
  const people = p.recluster();
  const one = people.find((x) => x.faces.includes('p1-0'))!;
  assert.equal(p.recognise(around(1, 31415))?.person, one.id);
  assert.ok((p.recognise(around(1, 31415))?.distance ?? 1) < 0.1);
  assert.equal(p.recognise(around(7, 5)), undefined); // a stranger
  const between = centroid([centreOf(1), centreOf(2)]);
  assert.equal(p.recognise(between, { eps: 1 }), undefined); // between two people: not guessed
  assert.equal(p.recognise(between, { eps: 1, margin: 0 })?.person !== undefined, true);
  assert.throws(() => p.recognise([1, 2, 3]), /uses 16 numbers/);
  assert.deepEqual(p.neighbours(around(2, 8), 2).map((r) => r.face.startsWith('p2-')), [true, true]);
});

test('bad input: wrong sizes, scores out of range, repeated ids, bad options', () => {
  const p = new People();
  p.addFaces(faces(1, 1));
  assert.throws(() => p.addFaces(faces(1, 1)), /already here/);
  assert.throws(() => p.addFaces([{ id: 'x', assetId: 'a', embedding: [1, 2], score: 0.9 }]), /16 numbers/);
  assert.throws(() => p.addFaces([{ id: 'y', assetId: 'a', embedding: around(1, 1), score: 1.5 }]), /score/);
  assert.throws(() => p.addFaces([{ id: 'z', assetId: 'a', embedding: new Array(DIM).fill(0), score: 0.9 }]), /all zero/);
  assert.throws(() => new People({ eps: 3 }), /eps/);
  assert.throws(() => new People({ minFaces: 0 }), /minFaces/);
  assert.throws(() => new People({ minScore: 2 }), /minScore/);
});

test('removing the last face of an unnamed person removes the person; a named person stays', () => {
  const p = new People({ minFaces: 1 });
  p.addFaces([...faces(1, 1), ...faces(2, 1)]);
  const people = p.recluster();
  assert.equal(people.length, 2);
  p.name(people[0]!.id, 'Keep');
  p.removeFace('p1-0');
  p.removeFace('p2-0');
  assert.equal(p.people().length, 0);
  p.name(people[0]!.id, 'Still here'); // the named person is still known
  assert.throws(() => p.name(people[1]!.id, 'Gone'), /no person/);
});
