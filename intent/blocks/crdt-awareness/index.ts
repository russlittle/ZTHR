/**
 * Presence and cursors for collaborative sessions, following the awareness protocol of y-protocols: each client
 * owns one small JSON state (who it is, where its cursor is, what it is doing) with a clock that only it advances.
 * A newer clock replaces an older state, an equal or older one is ignored, so updates can arrive in any order, twice,
 * or from several relays and everyone ends up agreeing. A state of `null` means the client has gone.
 *
 *  - Expiry: a state not refreshed within the timeout (30 seconds) is dropped, so a closed laptop or lost
 *    connection disappears. The owner renews its own clock on a heartbeat (`renewIfDue`, every 15 seconds); it never
 *    expires its own state. Time is read from an injected clock.
 *  - The wire form is y-protocols' own: a varuint count, then for each client a varuint client id, a varuint clock
 *    and a varstring of JSON (lib0 variable-length integers, UTF-8), so it interoperates with Yjs awareness. Decoding
 *    checks every length against what remains and against limits on clients, bytes and state size.
 *  - Identity binding: on a server, a connection may only speak for the client ids it has claimed, the first claim
 *    wins, and a `user.id` in a state must be the authenticated user, so one person cannot draw another's cursor or
 *    erase it. When a connection closes, its clients are announced as gone.
 *  - Colours: a stable colour per user from a palette, with the least-used slot preferred so people in the same
 *    session look different, and black or white text chosen for contrast (WCAG ratio).
 *  - Cursor transforms: text positions carried through inserts and deletes (an insert at the cursor either pushes it
 *    or leaves it, by `assoc`; a deleted range collapses it), whole selections, and canvas pointer positions between
 *    screen and scene coordinates under scroll and zoom.
 *
 * Not here: the network, the document CRDT the positions refer to (see crdt-map), and rendering. Positions are
 * plain indexes; relative positions that survive concurrent edits belong to the text CRDT.
 */

export class AwarenessError extends Error {}

export type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };

// ---------------------------------------------------------------- lib0 encoding

class Writer {
  readonly out: number[] = [];
  varuint(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0) throw new AwarenessError('a varuint is a whole number, zero or more');
    while (n > 127) {
      this.out.push(128 | (n % 128));
      n = Math.floor(n / 128);
    }
    this.out.push(n);
  }
  varstring(s: string): void {
    const b = Buffer.from(s, 'utf8');
    this.varuint(b.length);
    for (const x of b) this.out.push(x);
  }
}

class Reader {
  private i = 0;
  private readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  get left(): number {
    return this.b.length - this.i;
  }
  varuint(): number {
    let n = 0;
    let mul = 1;
    for (let k = 0; k < 8; k++) {
      if (this.i >= this.b.length) throw new AwarenessError('the update ends in the middle of a number');
      const x = this.b[this.i++]!;
      n += (x & 127) * mul;
      if (x < 128) {
        if (!Number.isSafeInteger(n)) throw new AwarenessError('number too large');
        return n;
      }
      mul *= 128;
    }
    throw new AwarenessError('a number is too long');
  }
  varstring(max: number): string {
    const len = this.varuint();
    if (len > max) throw new AwarenessError(`a state is at most ${max} bytes`);
    if (len > this.left) throw new AwarenessError('a string claims more bytes than the update has');
    const s = Buffer.from(this.b.subarray(this.i, this.i + len));
    this.i += len;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(s);
    return text;
  }
}

// ---------------------------------------------------------------- awareness

export interface Change {
  /** Clients that appeared, whose state changed, or that went. */
  readonly added: readonly number[];
  readonly updated: readonly number[];
  readonly removed: readonly number[];
  /** Every client whose clock moved, even if its state did not change (a heartbeat). */
  readonly touched: readonly number[];
}

export type Listener = (c: Change, origin: unknown) => void;

interface Meta {
  clock: number;
  lastUpdated: number;
}

export interface Options {
  readonly now: () => number;
  readonly timeoutMs?: number;
  readonly renewMs?: number;
  readonly maxStateBytes?: number;
  readonly maxClients?: number;
}

const same = (a: Json | undefined, b: Json | undefined): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export class Awareness {
  readonly clientId: number;
  private readonly states = new Map<number, Json>();
  private readonly meta = new Map<number, Meta>();
  private readonly listeners = new Set<Listener>();
  private readonly o: Required<Options>;

  constructor(clientId: number, o: Options) {
    if (!Number.isSafeInteger(clientId) || clientId < 0) throw new AwarenessError('a client id is a whole number');
    this.clientId = clientId;
    this.o = { timeoutMs: 30_000, renewMs: 15_000, maxStateBytes: 4096, maxClients: 1000, ...o };
    this.meta.set(clientId, { clock: 1, lastUpdated: o.now() });
    this.states.set(clientId, {});
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(c: Change, origin: unknown): void {
    if (c.touched.length) for (const l of this.listeners) l(c, origin);
  }

  getStates(): ReadonlyMap<number, Json> {
    return this.states;
  }

  getLocalState(): Json | null {
    return this.states.get(this.clientId) ?? null;
  }

  clockOf(id: number): number | undefined {
    return this.meta.get(id)?.clock;
  }

  private checkState(s: Json | null): void {
    if (s !== null && JSON.stringify(s).length > this.o.maxStateBytes) throw new AwarenessError(`a state is at most ${this.o.maxStateBytes} bytes`);
  }

  /** Set this client's state (null to leave). Advances the clock. */
  setLocalState(state: Json | null): void {
    this.checkState(state);
    const m = this.meta.get(this.clientId)!;
    const prev = this.states.get(this.clientId);
    m.clock += 1;
    m.lastUpdated = this.o.now();
    if (state === null) this.states.delete(this.clientId);
    else this.states.set(this.clientId, state);
    const had = prev !== undefined;
    const c: Change = { added: state !== null && !had ? [this.clientId] : [], updated: state !== null && had && !same(prev, state) ? [this.clientId] : [], removed: state === null && had ? [this.clientId] : [], touched: [this.clientId] };
    this.emit(c, 'local');
  }

  /** Change one field of the local state, keeping the rest. */
  setLocalField(key: string, value: Json): void {
    if (key === '__proto__') throw new AwarenessError('"__proto__" is not a usable key');
    const cur = this.getLocalState();
    this.setLocalState({ ...(cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}), [key]: value });
  }

  /** Heartbeat: if the local clock has not moved for the renew interval, advance it so others do not time us out. */
  renewIfDue(): boolean {
    const m = this.meta.get(this.clientId)!;
    if (this.getLocalState() === null || this.o.now() - m.lastUpdated < this.o.renewMs) return false;
    this.setLocalState(this.getLocalState());
    return true;
  }

  /** Drop remote clients not heard from within the timeout. Returns who was dropped. */
  prune(): number[] {
    const now = this.o.now();
    const gone: number[] = [];
    for (const [id, m] of this.meta) {
      if (id !== this.clientId && this.states.has(id) && now - m.lastUpdated >= this.o.timeoutMs) {
        this.states.delete(id);
        gone.push(id);
      }
    }
    this.emit({ added: [], updated: [], removed: gone, touched: gone }, 'timeout');
    return gone;
  }

  /** The update for these clients (default all known), in y-protocols' form. A gone client is sent as null. */
  encodeUpdate(ids: readonly number[] = [...this.meta.keys()]): Uint8Array {
    const known = ids.filter((id) => this.meta.has(id));
    const w = new Writer();
    w.varuint(known.length);
    for (const id of known) {
      w.varuint(id);
      w.varuint(this.meta.get(id)!.clock);
      w.varstring(JSON.stringify(this.states.get(id) ?? null));
    }
    return Uint8Array.from(w.out);
  }

  /** Decode without applying, checking every length. */
  decodeUpdate(update: Uint8Array): { id: number; clock: number; state: Json | null }[] {
    if (update.length > 1_048_576) throw new AwarenessError('an update is at most 1 MiB');
    const r = new Reader(update);
    const n = r.varuint();
    if (n > this.o.maxClients) throw new AwarenessError(`an update names at most ${this.o.maxClients} clients`);
    const out: { id: number; clock: number; state: Json | null }[] = [];
    for (let i = 0; i < n; i++) {
      const id = r.varuint();
      const clock = r.varuint();
      let state: Json | null;
      try {
        state = JSON.parse(r.varstring(this.o.maxStateBytes)) as Json | null;
      } catch (e) {
        if (e instanceof AwarenessError) throw e;
        throw new AwarenessError('a state is not valid JSON text');
      }
      out.push({ id, clock, state });
    }
    if (r.left) throw new AwarenessError('bytes left over after the update');
    return out;
  }

  /** Apply an update from another client or a relay. Returns what changed. */
  applyUpdate(update: Uint8Array, origin: unknown = 'remote'): Change {
    return this.applyEntries(this.decodeUpdate(update), origin);
  }

  applyEntries(entries: readonly { id: number; clock: number; state: Json | null }[], origin: unknown = 'remote'): Change {
    const now = this.o.now();
    const added: number[] = [];
    const updated: number[] = [];
    const removed: number[] = [];
    const touched: number[] = [];
    for (const { id, clock, state } of entries) {
      const m = this.meta.get(id);
      const had = this.states.has(id);
      if (!m && this.meta.size >= this.o.maxClients) throw new AwarenessError('too many clients');
      const curClock = m?.clock ?? 0;
      // a newer clock wins; an equal clock only to announce that a client has gone
      if (!(curClock < clock || (curClock === clock && state === null && had))) continue;
      if (state === null) {
        if (id === this.clientId && this.getLocalState() !== null) {
          // someone says we are gone while we are here: out-vote them with a newer clock
          this.meta.set(id, { clock: clock + 1, lastUpdated: now });
          touched.push(id);
          continue;
        }
        this.states.delete(id);
        if (had) removed.push(id);
      } else {
        if (id === this.clientId) continue; // nobody else writes our state
        const prev = this.states.get(id);
        this.states.set(id, state);
        if (!had) added.push(id);
        else if (!same(prev, state)) updated.push(id);
      }
      this.meta.set(id, { clock, lastUpdated: now });
      touched.push(id);
    }
    const c: Change = { added, updated, removed, touched };
    this.emit(c, origin);
    return c;
  }
}

// ---------------------------------------------------------------- identity binding

export interface Identity {
  /** The authenticated user behind a connection. */
  readonly user: string;
}

/** Server side: which connection may speak for which client id, and for which user. */
export class IdentityBinder {
  private readonly owners = new Map<number, { connection: string; user: string }>();
  private readonly conns = new Map<string, { user: string; clients: Set<number> }>();

  connect(connection: string, user: string): void {
    if (this.conns.has(connection)) throw new AwarenessError('connection already open');
    this.conns.set(connection, { user, clients: new Set() });
  }

  /** The first connection to use a client id owns it for as long as that connection lives. */
  private claim(connection: string, id: number): boolean {
    const c = this.conns.get(connection);
    if (!c) throw new AwarenessError('unknown connection');
    const o = this.owners.get(id);
    if (o) return o.connection === connection;
    this.owners.set(id, { connection, user: c.user });
    c.clients.add(id);
    return true;
  }

  /**
   * The entries of an update this connection may speak for. An entry for a client another connection owns is
   * dropped, and a state naming another user (`user.id`) is dropped; the rest pass. Returns what was refused too.
   */
  filter(connection: string, entries: readonly { id: number; clock: number; state: Json | null }[]): { allowed: { id: number; clock: number; state: Json | null }[]; refused: { id: number; why: string }[] } {
    const user = this.conns.get(connection)?.user;
    if (user === undefined) throw new AwarenessError('unknown connection');
    const allowed: { id: number; clock: number; state: Json | null }[] = [];
    const refused: { id: number; why: string }[] = [];
    for (const e of entries) {
      if (!this.claim(connection, e.id)) {
        refused.push({ id: e.id, why: 'the client id belongs to another connection' });
        continue;
      }
      const s = e.state;
      const claimed = s && typeof s === 'object' && !Array.isArray(s) ? (s as { user?: Json }).user : undefined;
      if (claimed && typeof claimed === 'object' && !Array.isArray(claimed) && 'id' in claimed && (claimed as { id: Json }).id !== user) {
        refused.push({ id: e.id, why: 'the state names a different user' });
        continue;
      }
      allowed.push(e);
    }
    return { allowed, refused };
  }

  /** The connection closed: its clients, to be announced as gone (state null with a newer clock). */
  disconnect(connection: string): number[] {
    const c = this.conns.get(connection);
    if (!c) return [];
    this.conns.delete(connection);
    for (const id of c.clients) this.owners.delete(id);
    return [...c.clients];
  }

  userOf(id: number): string | undefined {
    return this.owners.get(id)?.user;
  }
}

/** A relay: authenticated connections in, filtered updates out, with removal announced when a connection closes. */
export class AwarenessHub {
  private readonly aw: Awareness;
  readonly binder = new IdentityBinder();

  /** `aw` holds the server's view of everyone; it needs its own client id nobody else uses. */
  constructor(aw: Awareness) {
    this.aw = aw;
  }

  join(connection: string, user: string): Uint8Array {
    this.binder.connect(connection, user);
    return this.aw.encodeUpdate([...this.aw.getStates().keys()].filter((id) => id !== this.aw.clientId));
  }

  /** Apply an update from a connection and return the update to relay to the others (only what was accepted). */
  receive(connection: string, update: Uint8Array): { relay: Uint8Array; change: Change; refused: { id: number; why: string }[] } {
    const { allowed, refused } = this.binder.filter(connection, this.aw.decodeUpdate(update));
    const change = this.aw.applyEntries(allowed, connection);
    return { relay: this.aw.encodeUpdate(change.touched), change, refused };
  }

  /** Announce a closed connection's clients as gone; returns the update to relay. */
  leave(connection: string): Uint8Array {
    const ids = this.binder.disconnect(connection);
    this.aw.applyEntries(ids.map((id) => ({ id, clock: (this.aw.clockOf(id) ?? 0) + 1, state: null })), 'leave');
    return this.aw.encodeUpdate(ids);
  }
}

// ---------------------------------------------------------------- colours

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0');

function hsl(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return `#${hex2(f(0) * 255)}${hex2(f(8) * 255)}${hex2(f(4) * 255)}`;
}

/** WCAG relative luminance of #rrggbb. */
export function luminance(color: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) throw new AwarenessError('a colour is #rrggbb');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1]!.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** Black or white, whichever reads better on this colour. */
export const textOn = (color: string): '#000000' | '#ffffff' => (contrast(color, '#000000') >= contrast(color, '#ffffff') ? '#000000' : '#ffffff');

/** Twelve hues, evenly spread, at one saturation and lightness so none shouts or fades. */
export const PALETTE: readonly string[] = Array.from({ length: 12 }, (_, i) => hsl(i * 30 + 10, 0.62, 0.5));

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of Buffer.from(s, 'utf8')) h = Math.imul(h ^ ch, 0x01000193) >>> 0;
  return h;
}

export interface UserColour {
  readonly color: string;
  /** The same colour at 20% for selection backgrounds. */
  readonly light: string;
  readonly text: '#000000' | '#ffffff';
}

const make = (color: string): UserColour => ({ color, light: `${color}33`, text: textOn(color) });

/** The same colour for the same user, every time, anywhere. */
export function userColour(userId: string, palette: readonly string[] = PALETTE): UserColour {
  return make(palette[fnv(userId) % palette.length]!);
}

/** For a session: each user's stable colour, moving to the least-used neighbour when two would share. */
export function assignColours(userIds: readonly string[], palette: readonly string[] = PALETTE): Map<string, UserColour> {
  const used = new Array<number>(palette.length).fill(0);
  const out = new Map<string, UserColour>();
  for (const u of [...new Set(userIds)].sort()) {
    const want = fnv(u) % palette.length;
    let best = want;
    for (let k = 0; k < palette.length; k++) {
      const i = (want + k) % palette.length;
      if (used[i]! < used[best]!) best = i;
    }
    used[best]!++;
    out.set(u, make(palette[best]!));
  }
  return out;
}

// ---------------------------------------------------------------- cursor transforms

export type Edit = { readonly type: 'insert'; readonly at: number; readonly length: number } | { readonly type: 'delete'; readonly at: number; readonly length: number };

/**
 * A text index after one edit. An insert exactly at the index moves it when `assoc` is 1 (the cursor stays after
 * the new text, as for the author's own typing) and leaves it when -1. A delete pulls later positions back and
 * collapses positions inside the deleted range to its start.
 */
export function transformIndex(index: number, e: Edit, assoc: 1 | -1 = 1): number {
  if (!Number.isInteger(index) || index < 0) throw new AwarenessError('a position is a whole number, zero or more');
  if (!Number.isInteger(e.at) || e.at < 0 || !Number.isInteger(e.length) || e.length < 0) throw new AwarenessError('an edit has a position and a length');
  if (e.type === 'insert') return e.at < index || (e.at === index && assoc === 1) ? index + e.length : index;
  if (index <= e.at) return index;
  return index >= e.at + e.length ? index - e.length : e.at;
}

export interface Selection {
  readonly anchor: number;
  readonly head: number;
}

/** A selection through a list of edits applied in order. Anchor and head keep their direction. */
export function transformSelection(s: Selection, edits: readonly Edit[], assoc: 1 | -1 = 1): Selection {
  let { anchor, head } = s;
  for (const e of edits) {
    anchor = transformIndex(anchor, e, anchor <= head ? -1 : assoc);
    head = transformIndex(head, e, assoc);
  }
  return { anchor, head };
}

/** Keep a position inside the document. */
export const clampIndex = (index: number, docLength: number): number => Math.max(0, Math.min(index, docLength));

export interface Viewport {
  readonly scrollX: number;
  readonly scrollY: number;
  readonly zoom: number;
}

/** A screen point as a point on the shared canvas (so every viewer sees the pointer where it really is). */
export function toScene(p: { x: number; y: number }, v: Viewport): { x: number; y: number } {
  if (!(v.zoom > 0) || !Number.isFinite(v.zoom)) throw new AwarenessError('zoom is a positive number');
  return { x: p.x / v.zoom - v.scrollX, y: p.y / v.zoom - v.scrollY };
}

/** A canvas point as it appears in this viewer's screen. */
export function toScreen(p: { x: number; y: number }, v: Viewport): { x: number; y: number } {
  if (!(v.zoom > 0) || !Number.isFinite(v.zoom)) throw new AwarenessError('zoom is a positive number');
  return { x: (p.x + v.scrollX) * v.zoom, y: (p.y + v.scrollY) * v.zoom };
}
