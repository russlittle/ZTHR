/**
 * Collaborative editing of a rich-text-doc document through a central authority, as prosemirror-collab does it:
 * the authority keeps the one true list of steps and a version number (the count of steps); a client keeps its own
 * copy, the version it has caught up to, and the steps it made that the authority has not confirmed. The authority
 * accepts a batch of steps only if the client's version is the authority's current one; a client that loses that
 * race fetches the steps it missed, rebases its unconfirmed steps over them (undo them, apply the others', apply
 * each of its own again mapped through the steps it missed, keeping mirrors so positions inside text that was
 * undone and redone are recovered), and sends again. Everyone ends with the same document.
 *
 * `Authority` validates each step (read from JSON with the schema, applied to its document, refused if it fails or
 * if the document would grow past a limit) and applies a batch all or nothing; it keeps a bounded log, and a client
 * too far behind is told to reload from a snapshot. `Client` has `edit`, `sendable`, `receive` (own steps coming back
 * are recognised by client id and simply confirmed), `mapSelection` for carrying a cursor, or another person's, through
 * what `receive` did, and a collaborative undo.
 *
 * Undo that survives other people's work: each undo item keeps the inverse of the person's own steps, and when it is
 * used those inverses are mapped through every step applied since (other people's, and this client's own rebases)
 * using the same mirrored mappings, so it removes what this person added without touching what others did around
 * it; a part that cannot apply any more (the text was deleted by someone else) is skipped, and an item none of whose parts can apply is dropped with nothing else undone in its place. Edits made within a short
 * time of each other form one item (the clock is passed in); redo is the undo of an undo, and any new edit clears it.
 *
 * Out of scope: the transport (the caller carries batches and step lists between client and authority), who may
 * edit, presence and cursors beyond mapping a selection, and persistence of the log.
 */
import { Mapping, Transform, TransformError, fragSize, stepFromJSON } from '../rich-text-doc/index.ts';
import type { Node, Schema, Step, StepJSON, StepMap } from '../rich-text-doc/index.ts';

export class CollabError extends Error {
  constructor(why: string) {
    super(why);
  }
}

export interface StepBatch {
  /** The authority version the client had when it made these steps. */
  readonly version: number;
  /** Untrusted until the authority has read them against the schema. */
  readonly steps: readonly unknown[];
  readonly clientID: string;
}

export type Rejected = {
  readonly ok: false;
  readonly reason: 'version-mismatch' | 'invalid-step' | 'too-many-steps' | 'too-large' | 'too-old' | 'bad-request';
  readonly message: string;
  /** The authority's current version, so the client knows how far behind it is. */
  readonly version: number;
};
export type Accepted = { readonly ok: true; readonly version: number; readonly applied: number };

export interface StepsSince {
  readonly ok: true;
  /** The version these steps start at: the client's own. */
  readonly from: number;
  readonly version: number;
  readonly steps: readonly StepJSON[];
  readonly clientIDs: readonly string[];
}

export interface AuthorityOptions {
  /** Steps kept for clients to catch up from (default 10000). */
  readonly maxLog?: number;
  /** Most steps in one batch (default 500). */
  readonly maxBatch?: number;
  /** Largest document, in positions (default 5 million). */
  readonly maxDocSize?: number;
}

const ID = /^[A-Za-z0-9_.:-]{1,64}$/;

export class Authority {
  readonly schema: Schema;
  private current: Node;
  private count: number;
  private log: { step: StepJSON; clientID: string }[] = [];
  private floor: number;
  private readonly o: Required<AuthorityOptions>;

  constructor(schema: Schema, doc: Node, o: AuthorityOptions = {}, version = 0) {
    this.schema = schema;
    const problems = schema.check(doc);
    if (problems.length) throw new CollabError(`the starting document is not valid: ${problems[0]}`);
    this.current = doc;
    this.count = version;
    this.floor = version;
    this.o = { maxLog: o.maxLog ?? 10_000, maxBatch: o.maxBatch ?? 500, maxDocSize: o.maxDocSize ?? 5_000_000 };
  }

  get version(): number {
    return this.count;
  }
  get doc(): Node {
    return this.current;
  }
  /** What a new client starts from. */
  snapshot(): { doc: Node; version: number } {
    return { doc: this.current, version: this.count };
  }

  private reject(reason: Rejected['reason'], message: string): Rejected {
    return { ok: false, reason, message, version: this.count };
  }

  /** Accepts a batch made against the current version, whole or not at all. */
  receiveSteps(batch: StepBatch): Accepted | Rejected {
    if (typeof batch !== 'object' || batch === null || !Number.isInteger(batch.version) || !Array.isArray(batch.steps) || typeof batch.clientID !== 'string' || !ID.test(batch.clientID)) return this.reject('bad-request', 'a batch has a version, a list of steps and a client id');
    if (batch.steps.length > this.o.maxBatch) return this.reject('too-many-steps', `at most ${this.o.maxBatch} steps in a batch`);
    if (batch.version !== this.count) return this.reject('version-mismatch', `the batch is for version ${batch.version}; the document is at ${this.count}`);
    let doc = this.current;
    const parsed: StepJSON[] = [];
    for (const [i, j] of batch.steps.entries()) {
      let step: Step;
      try {
        step = stepFromJSON(this.schema, j);
      } catch (e) {
        return this.reject('invalid-step', `step ${i}: ${(e as Error).message}`);
      }
      const r = step.apply(this.schema, doc);
      if ('failed' in r) return this.reject('invalid-step', `step ${i} does not apply: ${r.failed}`);
      doc = r.doc;
      if (fragSize(doc.content ?? []) > this.o.maxDocSize) return this.reject('too-large', `the document would be larger than ${this.o.maxDocSize}`);
      parsed.push(step.toJSON());
    }
    this.current = doc;
    for (const step of parsed) this.log.push({ step, clientID: batch.clientID });
    this.count += parsed.length;
    if (this.log.length > this.o.maxLog) {
      const drop = this.log.length - this.o.maxLog;
      this.log.splice(0, drop);
      this.floor += drop;
    }
    return { ok: true, version: this.count, applied: parsed.length };
  }

  /** The steps after `version`, with who made each. A client that is further behind than the log says so. */
  stepsSince(version: number, limit = 1000): StepsSince | Rejected {
    if (!Number.isInteger(version) || version < 0 || version > this.count) return this.reject('bad-request', `no such version: ${version}`);
    if (version < this.floor) return this.reject('too-old', `the log starts at version ${this.floor}; reload the document`);
    const part = this.log.slice(version - this.floor, version - this.floor + limit);
    return { ok: true, from: version, version: version + part.length, steps: part.map((p) => p.step), clientIDs: part.map((p) => p.clientID) };
  }
}

// ---------------------------------------------------------------------------------------------------------------

interface Local {
  readonly step: Step;
  /** Undoes the step against the document it was applied to. */
  readonly inverted: Step;
}

interface Item {
  /** Steps that undo the person's edits, to apply in order, relative to the document at chain position `after`. */
  inverted: Step[];
  after: number;
  time: number;
}

export interface ClientOptions {
  readonly clientID: string;
  readonly now?: () => number;
  /** Edits within this many ms of each other undo together (default 500). */
  readonly groupMs?: number;
  /** Undo items kept (default 100). */
  readonly maxHistory?: number;
}

export interface EditOptions {
  /** Keep this edit out of undo (for example, a correction made by the program). */
  readonly addToHistory?: boolean;
  /** Start a new undo item even if the last edit was just now. */
  readonly newGroup?: boolean;
}

export interface Selection {
  readonly anchor: number;
  readonly head: number;
}

export interface ReceiveResult {
  /** How positions of the document before moved to the document after, for `mapSelection`. */
  readonly mapping: Mapping;
  /** Own steps confirmed by this batch. */
  readonly confirmed: number;
  /** Steps of other people applied. */
  readonly applied: number;
  /** Own unconfirmed steps that could not be carried over the others' and were dropped. */
  readonly dropped: number;
}

export class Client {
  readonly schema: Schema;
  readonly clientID: string;
  private current: Node;
  private ver: number;
  private unconfirmed: Local[] = [];
  private readonly now: () => number;
  private readonly groupMs: number;
  private readonly maxHistory: number;
  /** Every change this client's document went through since the oldest undo item, as one chain of step maps. */
  private chain = new Mapping();
  private chainBase = 0;
  private undoStack: Item[] = [];
  private redoStack: Item[] = [];

  constructor(schema: Schema, doc: Node, version: number, o: ClientOptions) {
    if (!ID.test(o.clientID)) throw new CollabError('a client id is 1 to 64 letters, digits or . _ : -');
    this.schema = schema;
    this.current = doc;
    this.ver = version;
    this.clientID = o.clientID;
    this.now = o.now ?? Date.now;
    this.groupMs = o.groupMs ?? 500;
    this.maxHistory = o.maxHistory ?? 100;
  }

  get doc(): Node {
    return this.current;
  }
  /** The authority version this client has caught up to. */
  get version(): number {
    return this.ver;
  }
  get unconfirmedCount(): number {
    return this.unconfirmed.length;
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private chainLength(): number {
    return this.chainBase + this.chain.maps.length;
  }

  private record(tr: Transform) {
    for (let i = 0; i < tr.steps.length; i++) this.unconfirmed.push({ step: tr.steps[i]!, inverted: tr.steps[i]!.invert(this.schema, tr.docs[i]!) });
    for (const m of tr.mapping.maps) this.chain.appendMap(m);
    this.current = tr.doc;
  }

  /** Makes a change with a Transform; the steps are held until sent and confirmed. Returns whether anything changed. */
  edit(f: (tr: Transform) => void, o: EditOptions = {}): boolean {
    const tr = new Transform(this.schema, this.current);
    f(tr);
    if (!tr.docChanged) return false;
    const problems = this.schema.check(tr.doc);
    if (problems.length) throw new TransformError(`the edit leaves an invalid document: ${problems[0]}`);
    const before = this.chainLength();
    this.record(tr);
    if (o.addToHistory !== false) {
      const inverted = tr.inverted();
      const t = this.now();
      const top = this.undoStack[this.undoStack.length - 1];
      if (top && !o.newGroup && top.after === before && t - top.time <= this.groupMs) {
        top.inverted = [...inverted, ...top.inverted];
        top.after = this.chainLength();
        top.time = t;
      } else this.undoStack.push({ inverted, after: this.chainLength(), time: t });
      this.redoStack = [];
      this.trim();
    }
    return true;
  }

  /** What to send to the authority: the unconfirmed steps and the version they were made against; null if none. */
  sendable(): StepBatch | null {
    if (!this.unconfirmed.length) return null;
    return { version: this.ver, steps: this.unconfirmed.map((u) => u.step.toJSON()), clientID: this.clientID };
  }

  /** Applies a list of steps from the authority (own steps among them are confirmed, others' are rebased over). */
  receive(from: number, steps: readonly Step[], clientIDs: readonly string[]): ReceiveResult {
    if (steps.length !== clientIDs.length) throw new CollabError('there must be one client id for each step');
    if (from > this.ver) throw new CollabError(`steps start at ${from} but this client is at ${this.ver}: some are missing`);
    const skip = this.ver - from;
    if (skip > steps.length) return { mapping: new Mapping(), confirmed: 0, applied: 0, dropped: 0 };
    const news = steps.slice(skip);
    const ids = clientIDs.slice(skip);
    let ours = 0;
    while (ours < ids.length && ids[ours] === this.clientID) ours++;
    if (ours > this.unconfirmed.length) throw new CollabError('the authority has more steps from this client than it sent');
    const others = news.slice(ours);
    const stillUnconfirmed = this.unconfirmed.slice(ours);
    this.ver += news.length;
    if (!others.length) {
      this.unconfirmed = stillUnconfirmed;
      return { mapping: new Mapping(), confirmed: ours, applied: 0, dropped: 0 };
    }
    // Undo what is unconfirmed, apply the others', apply each unconfirmed step again mapped over them.
    const tr = new Transform(this.schema, this.current);
    for (let i = stillUnconfirmed.length - 1; i >= 0; i--) tr.step(stillUnconfirmed[i]!.inverted);
    for (const s of others) {
      const r = tr.maybeStep(s);
      if ('failed' in r) throw new CollabError(`a step from the authority does not apply: ${r.failed}`);
    }
    const rebased: Local[] = [];
    let mapFrom = stillUnconfirmed.length;
    for (let i = 0; i < stillUnconfirmed.length; i++) {
      const docBefore = tr.doc;
      const mapped = stillUnconfirmed[i]!.step.map(tr.mapping.slice(mapFrom));
      mapFrom--;
      if (mapped && !('failed' in tr.maybeStep(mapped))) {
        tr.mapping.setMirror(mapFrom, tr.steps.length - 1);
        rebased.push({ step: mapped, inverted: mapped.invert(this.schema, docBefore) });
      }
    }
    const problems = this.schema.check(tr.doc);
    if (problems.length) throw new CollabError(`rebasing gave an invalid document: ${problems[0]}`);
    const offset = this.chain.maps.length;
    for (const m of tr.mapping.maps) this.chain.appendMap(m);
    for (const [a, b] of tr.mapping.mirrorPairs()) this.chain.setMirror(a + offset, b + offset);
    this.current = tr.doc;
    const dropped = stillUnconfirmed.length - rebased.length;
    this.unconfirmed = rebased;
    this.trim();
    const mapping = new Mapping([...tr.mapping.maps]);
    for (const [a, b] of tr.mapping.mirrorPairs()) mapping.setMirror(a, b);
    return { mapping, confirmed: ours, applied: others.length, dropped };
  }

  /** The same, from what an authority's `stepsSince` returned. Steps are checked against the schema. */
  receiveJSON(payload: { from: number; steps: readonly unknown[]; clientIDs: readonly string[] }): ReceiveResult {
    if (!Number.isInteger(payload.from) || !Array.isArray(payload.steps) || !Array.isArray(payload.clientIDs)) throw new CollabError('a step list has from, steps and clientIDs');
    if (payload.clientIDs.some((c) => typeof c !== 'string' || !ID.test(c))) throw new CollabError('a client id is not valid');
    return this.receive(payload.from, payload.steps.map((s) => stepFromJSON(this.schema, s)), payload.clientIDs);
  }

  /** A cursor or range carried through what `receive` did (or any mapping). The head leans right by default. */
  mapSelection(sel: Selection, mapping: Mapping, assoc = 1): Selection {
    const size = fragSize(this.current.content ?? []);
    const clamp = (n: number) => Math.max(0, Math.min(size, n));
    return { anchor: clamp(mapping.map(sel.anchor, assoc)), head: clamp(mapping.map(sel.head, assoc)) };
  }

  // --- undo ----------------------------------------------------------------------------------------------------

  private trim() {
    while (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    while (this.redoStack.length > this.maxHistory) this.redoStack.shift();
    const oldest = Math.min(...this.undoStack.map((i) => i.after), ...this.redoStack.map((i) => i.after), this.chainLength());
    const drop = oldest - this.chainBase;
    if (drop > 1000) {
      const maps = this.chain.maps.slice(drop);
      const next = new Mapping(maps);
      for (const [a, b] of this.chain.mirrorPairs()) if (a >= drop && b >= drop) next.setMirror(a - drop, b - drop);
      this.chain = next;
      this.chainBase += drop;
    }
  }

  /** The mapping from the document at an item's position to the document now. */
  private since(after: number): { maps: StepMap[]; mirrors: [number, number][] } {
    const rel = after - this.chainBase;
    const maps = this.chain.maps.slice(rel);
    const mirrors = this.chain.mirrorPairs().filter(([a, b]) => a >= rel && b >= rel).map(([a, b]): [number, number] => [a - rel, b - rel]);
    return { maps, mirrors };
  }

  private apply(from: Item[], to: Item[]): boolean {
    const item = from.pop();
    if (!item) return false;
    const { maps: later, mirrors: laterMirrors } = this.since(item.after);
    const tr = new Transform(this.schema, this.current);
    const applied: { i: number }[] = [];
    const appliedMaps = new Map<number, StepMap>();
    for (let j = 0; j < item.inverted.length; j++) {
      const maps: StepMap[] = [];
      const mirrors: number[] = [];
      const invIdx = new Map<number, number>();
      for (let i = j - 1; i >= 0; i--) {
        invIdx.set(i, maps.length);
        maps.push(item.inverted[i]!.getMap().invert());
      }
      const sStart = maps.length;
      maps.push(...later);
      for (const [a, b] of laterMirrors) mirrors.push(a + sStart, b + sStart);
      for (const { i } of applied) {
        const at = maps.length;
        maps.push(appliedMaps.get(i)!);
        mirrors.push(invIdx.get(i)!, at);
      }
      const mapped = item.inverted[j]!.map(new Mapping(maps, mirrors));
      if (!mapped) continue;
      const before = tr.steps.length;
      const r = tr.maybeStep(mapped);
      if ('failed' in r || tr.steps.length === before) continue;
      applied.push({ i: j });
      appliedMaps.set(j, mapped.getMap());
    }
    // An item whose steps can no longer apply (others deleted everything it touched) is dropped, and nothing else is
    // undone in its place.
    if (!tr.docChanged) return false;
    if (this.schema.check(tr.doc).length) return false;
    this.record(tr);
    to.push({ inverted: tr.inverted(), after: this.chainLength(), time: this.now() });
    this.trim();
    return true;
  }

  /** Undoes this person's latest edit (or group of edits), leaving what others did. False when there is nothing to undo. */
  undo(): boolean {
    return this.apply(this.undoStack, this.redoStack);
  }
  redo(): boolean {
    return this.apply(this.redoStack, this.undoStack);
  }
}
