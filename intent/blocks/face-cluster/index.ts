/**
 * Clustering of face (or object) embeddings into people, with the controls a person needs over the result: name a
 * person, merge two, split faces out, say "this is not them", and have all of that survive the next re-clustering.
 *
 * Distance is cosine distance (1 minus the cosine of the angle) on embeddings of one fixed length. Two clusterers are
 * given: DBSCAN, which leaves odd faces unassigned instead of forcing them into a group, and agglomerative, which
 * merges the closest groups until none is within the threshold. Confidence floors drop detections that are too weak
 * to trust: below `minScore` a face is never clustered, and a person needs `minFaces` faces to exist.
 *
 * Nothing here needs an index: it compares in memory. A library with hundreds of thousands of faces would put a
 * nearest-neighbour index behind `neighbours`.
 */

export class ClusterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type Vec = readonly number[] | Float32Array | Float64Array;

export function norm(v: Vec): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

export function unit(v: Vec): Float64Array {
  const n = norm(v);
  if (!(n > 0) || !Number.isFinite(n)) throw new ClusterError('embedding', 'an embedding must be finite and not all zero');
  return Float64Array.from(v, (x) => x / n);
}

export function cosineDistance(a: Vec, b: Vec): number {
  if (a.length !== b.length) throw new ClusterError('dimension', `embeddings of ${a.length} and ${b.length} numbers cannot be compared`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!(na > 0) || !(nb > 0)) throw new ClusterError('embedding', 'an embedding must not be all zero');
  return Math.max(0, 1 - dot / Math.sqrt(na * nb));
}

/** The mean direction of unit vectors, as a unit vector. */
export function centroid(vs: readonly Vec[]): Float64Array {
  const first = vs[0];
  if (!first) throw new ClusterError('input', 'a centroid needs at least one vector');
  const sum = new Float64Array(first.length);
  for (const v of vs) {
    const u = unit(v);
    if (u.length !== sum.length) throw new ClusterError('dimension', 'embeddings differ in length');
    for (let i = 0; i < u.length; i++) sum[i]! += u[i] as number;
  }
  return unit(sum);
}

// ------------------------------------------------------------ clusterers

/** Labels 0..k-1, with -1 for noise. Clusters are numbered in order of their lowest point, so a rerun is identical. */
export function dbscan(points: readonly Vec[], eps: number, minPoints: number): number[] {
  if (!(eps >= 0)) throw new ClusterError('params', 'eps cannot be negative');
  if (!Number.isInteger(minPoints) || minPoints < 1) throw new ClusterError('params', 'minPoints must be a whole number of at least 1');
  const n = points.length;
  const near = (i: number) => {
    const out: number[] = [];
    for (let j = 0; j < n; j++) if (cosineDistance(points[i] as Vec, points[j] as Vec) <= eps) out.push(j);
    return out; // includes i itself, as the textbook counts it
  };
  const label = new Array<number>(n).fill(-2); // -2 unvisited
  let next = 0;
  for (let i = 0; i < n; i++) {
    if (label[i] !== -2) continue;
    const seeds = near(i);
    if (seeds.length < minPoints) {
      label[i] = -1;
      continue;
    }
    const c = next++;
    label[i] = c;
    const queue = [...seeds];
    for (let q = 0; q < queue.length; q++) {
      const j = queue[q] as number;
      if (label[j] === -1) label[j] = c; // noise becomes a border point
      if (label[j] !== -2) continue;
      label[j] = c;
      const more = near(j);
      if (more.length >= minPoints) for (const k of more) queue.push(k);
    }
  }
  return label;
}

export type Linkage = 'single' | 'average' | 'complete';

/** Merges the two closest groups until the closest pair is farther than `threshold`. Labels as for dbscan; nothing is noise. */
export function agglomerative(points: readonly Vec[], threshold: number, linkage: Linkage = 'average'): number[] {
  if (!(threshold >= 0)) throw new ClusterError('params', 'threshold cannot be negative');
  const n = points.length;
  const d: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) d[i]![j] = d[j]![i] = cosineDistance(points[i] as Vec, points[j] as Vec);
  let groups: number[][] = points.map((_, i) => [i]);
  const between = (a: number[], b: number[]) => {
    let lo = Infinity;
    let hi = 0;
    let sum = 0;
    for (const i of a) for (const j of b) {
      const v = d[i]![j] as number;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
      sum += v;
    }
    return linkage === 'single' ? lo : linkage === 'complete' ? hi : sum / (a.length * b.length);
  };
  for (;;) {
    let best = Infinity;
    let bi = -1;
    let bj = -1;
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const v = between(groups[i] as number[], groups[j] as number[]);
      if (v <= threshold && v < best) [best, bi, bj] = [v, i, j];
    }
    if (bi < 0) break;
    groups[bi] = [...(groups[bi] as number[]), ...(groups[bj] as number[])];
    groups = groups.filter((_, k) => k !== bj);
  }
  const label = new Array<number>(n).fill(-1);
  groups.sort((a, b) => Math.min(...a) - Math.min(...b)).forEach((g, k) => g.forEach((i) => (label[i] = k)));
  return label;
}

// ------------------------------------------------------------ people

export interface FaceInput {
  readonly id: string;
  readonly assetId: string;
  readonly embedding: Vec;
  /** The detector's confidence, 0..1. */
  readonly score: number;
}

export interface Face extends FaceInput {
  readonly embedding: Float64Array;
  /** Set when a person put the face with someone: re-clustering keeps it there. */
  readonly pinned?: string;
  /** People this face was said not to be. */
  readonly notThem: readonly string[];
}

export interface Person {
  readonly id: string;
  readonly name?: string;
  readonly faces: readonly string[];
  readonly centroid: Float64Array;
  /** The highest-scoring face, to show as the person. */
  readonly representative: string;
}

export interface Options {
  readonly algorithm?: 'dbscan' | 'agglomerative';
  /** Cosine distance at which two faces count as the same person. */
  readonly eps?: number;
  /** Faces a person needs to exist (DBSCAN core size). Fewer and they stay unassigned. */
  readonly minFaces?: number;
  /** Detections below this are never clustered. */
  readonly minScore?: number;
  readonly linkage?: Linkage;
}

export const DEFAULTS = { algorithm: 'dbscan', eps: 0.4, minFaces: 3, minScore: 0.7, linkage: 'average' } as const;

export interface Recognition {
  readonly person: string;
  readonly distance: number;
}

export class People {
  private readonly o: Required<Options>;
  private readonly faces = new Map<string, Face>();
  private readonly of = new Map<string, string>(); // face -> person
  private readonly names = new Map<string, string>();
  private readonly known = new Set<string>(); // person ids that exist
  private dim = 0;
  private seq = 0;

  constructor(o: Options = {}) {
    this.o = { ...DEFAULTS, ...o };
    if (!(this.o.eps >= 0 && this.o.eps <= 2)) throw new ClusterError('params', 'eps is a cosine distance between 0 and 2');
    if (!Number.isInteger(this.o.minFaces) || this.o.minFaces < 1) throw new ClusterError('params', 'minFaces must be at least 1');
    if (!(this.o.minScore >= 0 && this.o.minScore <= 1)) throw new ClusterError('params', 'minScore is between 0 and 1');
  }

  addFaces(inputs: readonly FaceInput[]): void {
    for (const f of inputs) {
      if (this.faces.has(f.id)) throw new ClusterError('duplicate', `face ${f.id} is already here`);
      if (!(f.score >= 0 && f.score <= 1)) throw new ClusterError('score', 'a detection score is between 0 and 1');
      const e = unit(f.embedding);
      if (this.dim === 0) this.dim = e.length;
      else if (e.length !== this.dim) throw new ClusterError('dimension', `this library uses ${this.dim} numbers per embedding, not ${e.length}`);
      this.faces.set(f.id, { ...f, embedding: e, notThem: [] });
    }
  }

  face(id: string): Face | undefined {
    return this.faces.get(id);
  }

  /** The person a face is with, if any. */
  personOf(faceId: string): string | undefined {
    return this.of.get(faceId);
  }

  private eligible(f: Face): boolean {
    return f.score >= this.o.minScore || f.pinned !== undefined;
  }

  /**
   * Runs the clusterer over every trusted face and reconciles with what exists. A cluster keeps the id and name of the
   * person most of its faces already belonged to; faces a person placed stay placed; faces said not to be someone
   * are never put with them.
   */
  recluster(): Person[] {
    const all = [...this.faces.values()].filter((f) => this.eligible(f)).sort((a, b) => (a.id < b.id ? -1 : 1));
    const labels =
      this.o.algorithm === 'dbscan'
        ? dbscan(all.map((f) => f.embedding), this.o.eps, this.o.minFaces)
        : agglomerative(all.map((f) => f.embedding), this.o.eps, this.o.linkage).map((l, _i, ls) => (ls.filter((x) => x === l).length < this.o.minFaces ? -1 : l));
    const before = new Map(this.of);
    const next = new Map<string, string>();
    const claimed = new Set<string>();
    const clusters = new Map<number, Face[]>();
    all.forEach((f, i) => {
      const l = labels[i] as number;
      if (l >= 0) (clusters.get(l) ?? clusters.set(l, []).get(l))!.push(f);
    });
    // Pinned faces stay where they were put.
    for (const f of all) if (f.pinned) next.set(f.id, f.pinned);
    for (const [, members] of [...clusters].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const pinned = [...new Set(members.filter((f) => f.pinned).map((f) => f.pinned as string))];
      let person: string;
      if (pinned.length > 0) {
        // A cluster holding placed faces: faces that already had a person keep them; new faces go to the nearest person here.
        const groups = new Map<string, Face[]>();
        const put = (p: string, f: Face) => (groups.get(p) ?? groups.set(p, []).get(p))!.push(f);
        const fresh: Face[] = [];
        for (const f of members) {
          const prev = before.get(f.id);
          if (f.pinned) put(f.pinned, f);
          else if (prev && this.known.has(prev) && !f.notThem.includes(prev)) put(prev, f);
          else fresh.push(f);
        }
        const cents = [...groups].map(([p, fs]) => ({ p, c: centroid(fs.map((f) => f.embedding)) }));
        for (const f of fresh) {
          const ok = cents.filter((c) => !f.notThem.includes(c.p)).sort((a, b) => cosineDistance(f.embedding, a.c) - cosineDistance(f.embedding, b.c));
          if (ok[0]) next.set(f.id, ok[0].p);
        }
        for (const [p, fs] of groups) {
          claimed.add(p);
          for (const f of fs) next.set(f.id, p);
        }
        continue;
      }
      const votes = new Map<string, number>();
      for (const f of members) {
        const p = before.get(f.id);
        if (p && this.known.has(p) && !claimed.has(p)) votes.set(p, (votes.get(p) ?? 0) + 1);
      }
      const top = [...votes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
      person = top && top[1] * 2 >= members.length ? top[0] : `p${++this.seq}`;
      claimed.add(person);
      for (const f of members) if (!f.notThem.includes(person)) next.set(f.id, person);
    }
    this.of.clear();
    for (const [f, p] of next) this.of.set(f, p);
    const alive = new Set(next.values());
    for (const p of [...this.known]) if (!alive.has(p) && !this.names.has(p)) this.known.delete(p);
    for (const p of alive) this.known.add(p);
    return this.people();
  }

  people(): Person[] {
    const by = new Map<string, Face[]>();
    for (const [fid, p] of this.of) (by.get(p) ?? by.set(p, []).get(p))!.push(this.faces.get(fid) as Face);
    const out: Person[] = [];
    for (const [id, fs] of by) {
      const rep = [...fs].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))[0] as Face;
      const name = this.names.get(id);
      out.push({ id, ...(name ? { name } : {}), faces: fs.map((f) => f.id).sort(), centroid: centroid(fs.map((f) => f.embedding)), representative: rep.id });
    }
    return out.sort((a, b) => b.faces.length - a.faces.length || (a.id < b.id ? -1 : 1));
  }

  person(id: string): Person | undefined {
    return this.people().find((p) => p.id === id);
  }

  /** Faces the clusterer left alone: too weak, or not close enough to enough others. */
  unassigned(): string[] {
    return [...this.faces.keys()].filter((id) => !this.of.has(id)).sort();
  }

  private mustKnow(id: string): void {
    if (!this.known.has(id)) throw new ClusterError('not-found', `no person ${id}`);
  }

  name(personId: string, name: string): void {
    this.mustKnow(personId);
    const n = name.trim();
    if (!n) {
      this.names.delete(personId);
      return;
    }
    if (n.length > 200) throw new ClusterError('name', 'a name is at most 200 characters');
    this.names.set(personId, n);
  }

  /**
   * Folds `from` into `into`. Two differently named people are only merged when the caller says which name wins.
   */
  merge(into: string, from: string, o: { name?: string } = {}): Person {
    if (into === from) throw new ClusterError('merge', 'a person cannot be merged with themselves');
    this.mustKnow(into);
    this.mustKnow(from);
    const a = this.names.get(into);
    const b = this.names.get(from);
    if (a && b && a !== b && o.name === undefined) throw new ClusterError('merge', `both are named (${a} and ${b}); say which name to keep`);
    for (const f of this.faces.values()) if (f.notThem.includes(into) && this.of.get(f.id) === from) throw new ClusterError('merge', `face ${f.id} was said not to be ${into}`);
    // Both sides are pinned: the merged person spans two clusters now, and re-clustering must not fall back to one.
    for (const [fid, p] of [...this.of]) if (p === from || p === into) this.place(fid, into);
    this.known.delete(from);
    const keep = o.name ?? a ?? b;
    this.names.delete(from);
    if (keep) this.names.set(into, keep);
    return this.person(into) as Person;
  }

  /** Moves the chosen faces of a person to a new person; the rest stay. */
  split(personId: string, faceIds: readonly string[]): Person {
    this.mustKnow(personId);
    if (faceIds.length === 0) throw new ClusterError('split', 'choose at least one face to split off');
    for (const f of faceIds) if (this.of.get(f) !== personId) throw new ClusterError('split', `face ${f} is not in ${personId}`);
    if (new Set(faceIds).size === [...this.of.values()].filter((p) => p === personId).length) throw new ClusterError('split', 'that is every face: nothing would be left');
    const id = `p${++this.seq}`;
    this.known.add(id);
    for (const f of faceIds) this.place(f, id);
    return this.person(id) as Person;
  }

  private place(faceId: string, personId: string): void {
    const f = this.faces.get(faceId) as Face;
    this.faces.set(faceId, { ...f, pinned: personId, notThem: f.notThem.filter((p) => p !== personId) });
    this.of.set(faceId, personId);
  }

  /** Puts one face with a person, and keeps it there. */
  assign(faceId: string, personId: string): void {
    if (!this.faces.has(faceId)) throw new ClusterError('not-found', `no face ${faceId}`);
    this.mustKnow(personId);
    this.place(faceId, personId);
  }

  /** "This is not them": the face leaves the person and will not be put back. */
  reject(faceId: string, personId: string): void {
    const f = this.faces.get(faceId);
    if (!f) throw new ClusterError('not-found', `no face ${faceId}`);
    this.mustKnow(personId);
    const { pinned, ...rest } = f;
    this.faces.set(faceId, { ...rest, ...(pinned && pinned !== personId ? { pinned } : {}), notThem: [...new Set([...f.notThem, personId])] });
    if (this.of.get(faceId) === personId) this.of.delete(faceId);
  }

  /** Removes a face (the picture was deleted). A person left with no faces and no name disappears. */
  removeFace(faceId: string): void {
    const p = this.of.get(faceId);
    this.faces.delete(faceId);
    this.of.delete(faceId);
    if (p && !this.names.has(p) && ![...this.of.values()].includes(p)) this.known.delete(p);
  }

  /**
   * Who a new face is, without changing anything. A person is named only when the face is within `eps` of their
   * centroid and clearly nearer than the runner up: `margin` is how much nearer, so a face between two people is
   * left unnamed rather than guessed.
   */
  recognise(embedding: Vec, o: { eps?: number; margin?: number } = {}): Recognition | undefined {
    const e = unit(embedding);
    if (this.dim !== 0 && e.length !== this.dim) throw new ClusterError('dimension', `this library uses ${this.dim} numbers per embedding`);
    const eps = o.eps ?? this.o.eps;
    const margin = o.margin ?? 0.05;
    const ranked = this.people()
      .map((p) => ({ person: p.id, distance: cosineDistance(e, p.centroid) }))
      .sort((a, b) => a.distance - b.distance);
    const best = ranked[0];
    if (!best || best.distance > eps) return undefined;
    const second = ranked[1];
    if (second && second.distance - best.distance < margin) return undefined;
    return best;
  }

  /** The faces closest to an embedding, nearest first. */
  neighbours(embedding: Vec, k: number): { face: string; distance: number }[] {
    const e = unit(embedding);
    return [...this.faces.values()]
      .map((f) => ({ face: f.id, distance: cosineDistance(e, f.embedding) }))
      .sort((a, b) => a.distance - b.distance || (a.face < b.face ? -1 : 1))
      .slice(0, k);
  }
}
