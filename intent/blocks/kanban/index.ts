/**
 * Kanban boards that merge across clients: lists (columns), cards with the task facts a card needs (notes, assignee,
 * labels, due date, blocked-by), swimlanes, WIP limits, and moves that every client resolves to the same board
 * whatever order the changes arrive in.
 *
 * How it merges: every change is a write to one named field of one list, card or lane, stamped with a Lamport clock
 * and the writer's id. A field keeps the write with the higher stamp (clock, then writer id), so two clients that
 * have seen the same writes show the same board, a write that arrives twice does nothing the second time, and a
 * write that arrives before the thing it is about waits in the log until its "create". A card's list, its place in
 * the list and its swimlane are one field, so a card is never in two lists. Places are fractional-index keys (the
 * fractional-index block), picked with a little randomness so two people dropping a card into the same gap at
 * once rarely tie; a tie is shown in id order on every client.
 *
 * Rules enforced where a change is made: a list in "block" mode refuses a card past its WIP limit (unless forced),
 * a card blocked by an unfinished card may not enter a "doing" or "done" list, blocked-by may not form a cycle, and
 * sizes and shapes of everything are checked, on received changes too. Rules that concurrent changes can still
 * break (two people each moving a card into the last free slot) are reported, not hidden: `violations()` lists lists
 * over their limit, `strays()` cards whose list was deleted, `cycles()` blocked-by loops.
 *
 * Done-ness comes from the list: a card in a list of kind "done" is done.
 *
 * Out of scope: storing or transporting the log (the caller sends `opsSince` and passes what it receives to
 * `receive`), who may see or change a board, and notifications.
 */
import { between, isKey, jitteredBetween } from '../fractional-index/index.ts';

export class BadOp extends Error {
  constructor(why: string) {
    super(why);
  }
}
export class WipLimit extends Error {
  readonly list: string;
  readonly limit: number;
  constructor(list: string, limit: number) {
    super(`the list is at its limit of ${limit} cards`);
    this.list = list;
    this.limit = limit;
  }
}
export class Blocked extends Error {
  readonly by: readonly string[];
  constructor(by: readonly string[]) {
    super(`the card is blocked by ${by.join(', ')}`);
    this.by = by;
  }
}
export class NotFound extends Error {
  constructor(what: string) {
    super(`no such ${what}`);
  }
}

export type Json = string | number | boolean | null | readonly Json[] | { readonly [k: string]: Json };
export interface Stamp {
  readonly c: number;
  readonly a: string;
}
export type Entity = 'list' | 'card' | 'lane';
/** One write to one field. This is all that travels between clients. */
export interface Op {
  readonly id: string;
  readonly stamp: Stamp;
  readonly entity: Entity;
  readonly ref: string;
  readonly field: string;
  readonly value: Json;
}

export type ListKind = 'todo' | 'doing' | 'done';
export interface Wip {
  readonly limit: number;
  /** "block" refuses a move past the limit; "warn" allows it and reports it. */
  readonly mode: 'block' | 'warn';
}
export interface Pos {
  readonly list: string;
  readonly key: string;
  readonly lane: string | null;
}
export interface List {
  readonly id: string;
  readonly title: string;
  readonly key: string;
  readonly kind: ListKind;
  readonly wip: Wip | null;
}
export interface Lane {
  readonly id: string;
  readonly title: string;
  readonly key: string;
}
export interface Card {
  readonly id: string;
  readonly title: string;
  readonly notes: string;
  readonly list: string;
  readonly key: string;
  readonly lane: string | null;
  readonly assignee: string | null;
  readonly labels: readonly string[];
  readonly due: string | null;
  readonly blockedBy: readonly string[];
}

export interface Limits {
  readonly maxCards: number;
  readonly maxLists: number;
  readonly maxLanes: number;
}
export interface BoardOptions {
  readonly actor: string;
  readonly random?: () => number;
  readonly limits?: Partial<Limits>;
}

const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LEN = { title: 500, notes: 20_000, label: 50, labels: 20, blockers: 50 };

const isStr = (v: Json, max: number) => typeof v === 'string' && v.length <= max;
const isId = (v: Json) => typeof v === 'string' && ID.test(v);
const validDay = (v: string) => DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

/** Which fields exist for each entity and what a good value looks like. */
const FIELDS: Record<Entity, Record<string, (v: Json) => boolean>> = {
  list: {
    create: (v) => v === true,
    deleted: (v) => typeof v === 'boolean',
    title: (v) => isStr(v, LEN.title) && (v as string).trim() !== '',
    key: (v) => typeof v === 'string' && isKey(v),
    kind: (v) => v === 'todo' || v === 'doing' || v === 'done',
    wip: (v) => v === null || (typeof v === 'object' && !Array.isArray(v) && Number.isInteger((v as { limit: Json }).limit) && (v as { limit: number }).limit >= 1 && (v as { limit: number }).limit <= 10_000 && ((v as { mode: Json }).mode === 'block' || (v as { mode: Json }).mode === 'warn')),
  },
  lane: {
    create: (v) => v === true,
    deleted: (v) => typeof v === 'boolean',
    title: (v) => isStr(v, LEN.title) && (v as string).trim() !== '',
    key: (v) => typeof v === 'string' && isKey(v),
  },
  card: {
    create: (v) => v === true,
    deleted: (v) => typeof v === 'boolean',
    title: (v) => isStr(v, LEN.title) && (v as string).trim() !== '',
    notes: (v) => isStr(v, LEN.notes),
    pos: (v) => typeof v === 'object' && v !== null && !Array.isArray(v) && isId((v as { list: Json }).list) && typeof (v as { key: Json }).key === 'string' && isKey((v as { key: string }).key) && ((v as { lane: Json }).lane === null || isId((v as { lane: Json }).lane)),
    assignee: (v) => v === null || (typeof v === 'string' && v.length >= 1 && v.length <= 200),
    labels: (v) => Array.isArray(v) && v.length <= LEN.labels && v.every((x) => isStr(x, LEN.label) && (x as string) !== ''),
    due: (v) => v === null || (typeof v === 'string' && validDay(v)),
    blockedBy: (v) => Array.isArray(v) && v.length <= LEN.blockers && v.every(isId),
  },
};

const later = (a: Stamp, b: Stamp) => a.c > b.c || (a.c === b.c && a.a > b.a);
const byKey = <T extends { key: string; id: string }>(x: T, y: T) => (x.key < y.key ? -1 : x.key > y.key ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

interface Reg {
  stamp: Stamp;
  value: Json;
}

export class Board {
  readonly actor: string;
  private readonly random: () => number;
  private readonly limits: Limits;
  private clock = 0;
  private n = 0;
  private readonly log = new Map<string, Op>();
  private readonly regs = new Map<string, Reg>();
  private cache: { lists: List[]; lanes: Lane[]; cards: Map<string, Card> } | null = null;

  constructor(o: BoardOptions) {
    if (!ID.test(o.actor)) throw new BadOp('the actor id must be 1 to 64 letters, digits or . _ : -');
    this.actor = o.actor;
    this.random = o.random ?? Math.random;
    this.limits = { maxCards: 10_000, maxLists: 200, maxLanes: 200, ...o.limits };
  }

  // --- merging --------------------------------------------------------------------------------------------------

  /** Checks one received write; throws BadOp for anything a good client would not send. */
  private check(op: Op): void {
    if (typeof op !== 'object' || op === null) throw new BadOp('a change must be an object');
    if (typeof op.id !== 'string' || op.id.length > 130 || !op.id) throw new BadOp('a change needs an id');
    const s = op.stamp;
    if (!s || !Number.isSafeInteger(s.c) || s.c < 1 || typeof s.a !== 'string' || !ID.test(s.a)) throw new BadOp('a change needs a stamp with a clock and a writer');
    const f = FIELDS[op.entity];
    if (!f) throw new BadOp(`unknown kind of thing: ${String(op.entity)}`);
    if (!ID.test(String(op.ref))) throw new BadOp('a change needs the id of what it is about');
    const ok = Object.hasOwn(f, op.field) ? f[op.field]!(op.value) : false;
    if (!ok) throw new BadOp(`${op.field} of a ${op.entity} does not accept that value`);
  }

  /** Applies a write from anyone, this client's own included. Returns whether it changed anything. Repeats do nothing. */
  receive(ops: readonly Op[]): number {
    let changed = 0;
    for (const op of ops) {
      this.check(op);
      if (this.log.has(op.id)) continue;
      if (op.field === 'create' && !this.exists(op.entity, op.ref)) {
        const count = this.countOf(op.entity);
        const max = op.entity === 'card' ? this.limits.maxCards : op.entity === 'list' ? this.limits.maxLists : this.limits.maxLanes;
        if (count >= max) throw new BadOp(`a board holds at most ${max} ${op.entity}s`);
      }
      this.log.set(op.id, op);
      this.clock = Math.max(this.clock, op.stamp.c);
      const k = `${op.entity}:${op.ref}:${op.field}`;
      const cur = this.regs.get(k);
      if (!cur || later(op.stamp, cur.stamp)) {
        this.regs.set(k, { stamp: op.stamp, value: op.value });
        changed++;
      }
      this.cache = null;
    }
    return changed;
  }

  /** Every write held, in the order they were made, for a client that is catching up. */
  opsSince(clock = 0): Op[] {
    return [...this.log.values()].filter((o) => o.stamp.c > clock).sort((a, b) => a.stamp.c - b.stamp.c || (a.stamp.a < b.stamp.a ? -1 : a.stamp.a > b.stamp.a ? 1 : 0) || (a.id < b.id ? -1 : 1));
  }

  get lamport(): number {
    return this.clock;
  }

  private write(entity: Entity, ref: string, fields: Record<string, Json>): Op[] {
    const c = ++this.clock;
    const ops = Object.entries(fields).map(([field, value]): Op => ({ id: `${this.actor}:${++this.n}:${c}`, stamp: { c, a: this.actor }, entity, ref, field, value }));
    for (const op of ops) this.check(op);
    this.receive(ops);
    return ops;
  }

  private reg(entity: Entity, ref: string, field: string): Json | undefined {
    return this.regs.get(`${entity}:${ref}:${field}`)?.value;
  }

  private exists(entity: Entity, ref: string): boolean {
    return this.reg(entity, ref, 'create') === true && this.reg(entity, ref, 'deleted') !== true;
  }

  private countOf(entity: Entity): number {
    const view = this.view();
    return entity === 'card' ? view.cards.size : entity === 'list' ? view.lists.length : view.lanes.length;
  }

  // --- reading -------------------------------------------------------------------------------------------------

  private view() {
    if (this.cache) return this.cache;
    const lists: List[] = [];
    const lanes: Lane[] = [];
    const cards = new Map<string, Card>();
    for (const [k, r] of this.regs) {
      if (!k.endsWith(':create') || r.value !== true) continue;
      const [entity, ref] = [k.slice(0, k.indexOf(':')) as Entity, k.slice(k.indexOf(':') + 1, -':create'.length)];
      if (this.reg(entity, ref, 'deleted') === true) continue;
      const g = (f: string) => this.reg(entity, ref, f);
      if (entity === 'list') {
        const key = g('key');
        if (typeof key !== 'string') continue;
        lists.push({ id: ref, title: String(g('title') ?? ''), key, kind: (g('kind') as ListKind | undefined) ?? 'todo', wip: (g('wip') as Wip | null | undefined) ?? null });
      } else if (entity === 'lane') {
        const key = g('key');
        if (typeof key !== 'string') continue;
        lanes.push({ id: ref, title: String(g('title') ?? ''), key });
      } else {
        const pos = g('pos') as Pos | undefined;
        if (!pos) continue;
        cards.set(ref, {
          id: ref,
          title: String(g('title') ?? ''),
          notes: String(g('notes') ?? ''),
          list: pos.list,
          key: pos.key,
          lane: pos.lane,
          assignee: (g('assignee') as string | null | undefined) ?? null,
          labels: (g('labels') as string[] | undefined) ?? [],
          due: (g('due') as string | null | undefined) ?? null,
          blockedBy: (g('blockedBy') as string[] | undefined) ?? [],
        });
      }
    }
    lists.sort(byKey);
    lanes.sort(byKey);
    return (this.cache = { lists, lanes, cards });
  }

  lists(): readonly List[] {
    return this.view().lists;
  }
  lanes(): readonly Lane[] {
    return this.view().lanes;
  }
  list(id: string): List {
    const l = this.view().lists.find((x) => x.id === id);
    if (!l) throw new NotFound('list');
    return l;
  }
  card(id: string): Card {
    const c = this.view().cards.get(id);
    if (!c) throw new NotFound('card');
    return c;
  }
  /** Cards of a list in order, optionally only one swimlane's (null for cards in none). */
  cards(list: string, lane?: string | null): Card[] {
    return [...this.view().cards.values()].filter((c) => c.list === list && (lane === undefined || c.lane === lane)).sort(byKey);
  }
  isDone(cardId: string): boolean {
    const c = this.card(cardId);
    return this.view().lists.find((l) => l.id === c.list)?.kind === 'done';
  }

  // --- changes -------------------------------------------------------------------------------------------------

  private keyIn(siblings: readonly { id: string; key: string }[], moving: string | undefined, o: { before?: string | null; after?: string | null }): string {
    const sib = siblings.filter((s) => s.id !== moving);
    let at = sib.length;
    if (o.after !== undefined && o.after !== null) {
      const i = sib.findIndex((s) => s.id === o.after);
      if (i < 0) throw new NotFound('card or list to place it after');
      at = i + 1;
    } else if (o.before !== undefined && o.before !== null) {
      const i = sib.findIndex((s) => s.id === o.before);
      if (i < 0) throw new NotFound('card or list to place it before');
      at = i;
    } else if (o.before === null || o.after === undefined) {
      at = o.before === null ? 0 : sib.length;
    }
    const a = sib[at - 1]?.key ?? null;
    const b = sib[at]?.key ?? null;
    // A neighbour that shares the key of the one before it leaves no gap; ties are shown in id order, so go past them.
    if (a !== null && b !== null && a >= b) return between(a, null);
    return jitteredBetween(a, b, this.random);
  }

  addList(id: string, title: string, o: { kind?: ListKind; wip?: Wip; after?: string | null } = {}): Op[] {
    if (this.exists('list', id)) throw new BadOp('that list id is taken');
    const key = this.keyIn(this.view().lists, undefined, o.after === undefined ? {} : { after: o.after });
    return this.write('list', id, { create: true, title, key, kind: o.kind ?? 'todo', wip: (o.wip ?? null) as unknown as Json });
  }
  renameList(id: string, title: string): Op[] {
    this.list(id);
    return this.write('list', id, { title });
  }
  moveList(id: string, o: { before?: string | null; after?: string | null }): Op[] {
    this.list(id);
    return this.write('list', id, { key: this.keyIn(this.view().lists, id, o) });
  }
  setWip(id: string, wip: Wip | null): Op[] {
    this.list(id);
    return this.write('list', id, { wip: wip as unknown as Json });
  }
  setKind(id: string, kind: ListKind): Op[] {
    this.list(id);
    return this.write('list', id, { kind });
  }
  deleteList(id: string): Op[] {
    this.list(id);
    return this.write('list', id, { deleted: true });
  }

  addLane(id: string, title: string, o: { after?: string | null } = {}): Op[] {
    if (this.exists('lane', id)) throw new BadOp('that lane id is taken');
    return this.write('lane', id, { create: true, title, key: this.keyIn(this.view().lanes, undefined, o.after === undefined ? {} : { after: o.after }) });
  }
  deleteLane(id: string): Op[] {
    if (!this.lanes().some((l) => l.id === id)) throw new NotFound('lane');
    return this.write('lane', id, { deleted: true });
  }

  /** Counts for a list: cards in it, its limit, and whether it is over. */
  wip(listId: string): { count: number; limit: number | null; over: boolean; mode: 'block' | 'warn' | null } {
    const l = this.list(listId);
    const count = this.cards(listId).length;
    return { count, limit: l.wip?.limit ?? null, over: l.wip !== null && count > l.wip.limit, mode: l.wip?.mode ?? null };
  }

  private guardEntry(cardId: string, list: List, force: boolean): void {
    const here = this.view().cards.get(cardId)?.list === list.id;
    if (!force && list.wip?.mode === 'block' && !here && this.cards(list.id).length >= list.wip.limit) throw new WipLimit(list.id, list.wip.limit);
    if (list.kind !== 'todo') {
      const open = (this.view().cards.get(cardId)?.blockedBy ?? []).filter((b) => this.view().cards.has(b) && !this.isDone(b));
      if (open.length) throw new Blocked(open);
    }
  }

  addCard(id: string, listId: string, title: string, o: { lane?: string | null; after?: string | null; before?: string | null; notes?: string; assignee?: string; labels?: readonly string[]; due?: string; force?: boolean } = {}): Op[] {
    if (this.exists('card', id)) throw new BadOp('that card id is taken');
    const l = this.list(listId);
    this.guardEntry(id, l, o.force ?? false);
    if (o.lane) this.laneExists(o.lane);
    const place: { before?: string | null; after?: string | null } = {};
    if (o.after !== undefined) place.after = o.after;
    if (o.before !== undefined) place.before = o.before;
    const key = this.keyIn(this.cards(listId), undefined, place);
    return this.write('card', id, {
      create: true,
      title,
      notes: o.notes ?? '',
      pos: { list: listId, key, lane: o.lane ?? null },
      assignee: o.assignee ?? null,
      labels: [...new Set(o.labels ?? [])].sort(),
      due: o.due ?? null,
      blockedBy: [],
    });
  }

  private laneExists(id: string) {
    if (!this.lanes().some((l) => l.id === id)) throw new NotFound('lane');
  }

  /** Moves a card to a list, to a place in it (before or after a card; the end if neither) and to a swimlane. */
  moveCard(id: string, listId: string, o: { before?: string | null; after?: string | null; lane?: string | null; force?: boolean } = {}): Op[] {
    const c = this.card(id);
    const l = this.list(listId);
    this.guardEntry(id, l, o.force ?? false);
    const lane = o.lane === undefined ? (c.list === listId ? c.lane : null) : o.lane;
    if (lane) this.laneExists(lane);
    const place: { before?: string | null; after?: string | null } = {};
    if (o.after !== undefined) place.after = o.after;
    if (o.before !== undefined) place.before = o.before;
    const key = this.keyIn(this.cards(listId), id, place);
    return this.write('card', id, { pos: { list: listId, key, lane } });
  }

  editCard(id: string, change: { title?: string; notes?: string; assignee?: string | null; labels?: readonly string[]; due?: string | null }): Op[] {
    this.card(id);
    const f: Record<string, Json> = {};
    if (change.title !== undefined) f.title = change.title;
    if (change.notes !== undefined) f.notes = change.notes;
    if (change.assignee !== undefined) f.assignee = change.assignee;
    if (change.labels !== undefined) f.labels = [...new Set(change.labels)].sort();
    if (change.due !== undefined) f.due = change.due;
    return this.write('card', id, f);
  }

  /** Sets what a card waits on. Refuses an unknown card, itself, and any loop. */
  block(id: string, by: readonly string[]): Op[] {
    this.card(id);
    for (const b of by) {
      if (b === id) throw new BadOp('a card cannot block itself');
      this.card(b);
    }
    const edges = new Map([...this.view().cards.values()].map((c) => [c.id, c.blockedBy] as const));
    edges.set(id, by);
    if (hasCycleFrom(id, edges)) throw new BadOp('that would make cards wait on each other');
    return this.write('card', id, { blockedBy: [...new Set(by)].sort() });
  }

  deleteCard(id: string): Op[] {
    this.card(id);
    return this.write('card', id, { deleted: true });
  }

  // --- views and rules -----------------------------------------------------------------------------------------

  /**
   * The board as rows of swimlanes by columns of lists. By "lane" the rows are the lanes (and "No lane"); by
   * "assignee" one row per assignee in name order, with "Unassigned" last; by "label" one row per label, a card in
   * each row of its labels, and "No label" last.
   */
  grid(by: 'lane' | 'assignee' | 'label' = 'lane'): { row: string | null; title: string; cells: Record<string, Card[]> }[] {
    const lists = this.lists();
    const all = [...this.view().cards.values()].sort(byKey);
    const rows: { row: string | null; title: string; test: (c: Card) => boolean }[] = [];
    if (by === 'lane') {
      for (const l of this.lanes()) rows.push({ row: l.id, title: l.title, test: (c) => c.lane === l.id });
      rows.push({ row: null, title: 'No lane', test: (c) => c.lane === null || !this.lanes().some((l) => l.id === c.lane) });
    } else if (by === 'assignee') {
      for (const a of [...new Set(all.map((c) => c.assignee).filter((a): a is string => a !== null))].sort()) rows.push({ row: a, title: a, test: (c) => c.assignee === a });
      rows.push({ row: null, title: 'Unassigned', test: (c) => c.assignee === null });
    } else {
      for (const t of [...new Set(all.flatMap((c) => c.labels))].sort()) rows.push({ row: t, title: t, test: (c) => c.labels.includes(t) });
      rows.push({ row: null, title: 'No label', test: (c) => c.labels.length === 0 });
    }
    return rows.map((r) => ({ row: r.row, title: r.title, cells: Object.fromEntries(lists.map((l) => [l.id, all.filter((c) => c.list === l.id && r.test(c))])) }));
  }

  /** Lists over their limit, whatever the mode: concurrent moves can pass a "block" check on two clients at once. */
  violations(): { list: string; count: number; limit: number; mode: 'block' | 'warn' }[] {
    const out: { list: string; count: number; limit: number; mode: 'block' | 'warn' }[] = [];
    for (const l of this.lists()) {
      if (!l.wip) continue;
      const count = this.cards(l.id).length;
      if (count > l.wip.limit) out.push({ list: l.id, count, limit: l.wip.limit, mode: l.wip.mode });
    }
    return out;
  }

  /** Cards whose list no longer exists (deleted while someone moved a card into it). */
  strays(): Card[] {
    const ids = new Set(this.lists().map((l) => l.id));
    return [...this.view().cards.values()].filter((c) => !ids.has(c.list)).sort(byKey);
  }

  /** Cards in a blocked-by loop, which two clients can make at once. */
  cycles(): string[] {
    const edges = new Map([...this.view().cards.values()].map((c) => [c.id, c.blockedBy] as const));
    return [...edges.keys()].filter((id) => hasCycleFrom(id, edges)).sort();
  }

  /** Cards not in a done list whose due day is before `today` (YYYY-MM-DD), oldest first. */
  overdue(today: string): Card[] {
    if (!validDay(today)) throw new BadOp('today must be a day like 2026-03-01');
    return [...this.view().cards.values()].filter((c) => c.due !== null && c.due < today && !this.isDone(c.id)).sort((a, b) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : a.id < b.id ? -1 : 1));
  }

  /** Cards that nothing open blocks and that are not done: what can be started. */
  ready(): Card[] {
    return [...this.view().cards.values()].filter((c) => !this.isDone(c.id) && c.blockedBy.every((b) => !this.view().cards.has(b) || this.isDone(b))).sort(byKey);
  }
}

function hasCycleFrom(start: string, edges: ReadonlyMap<string, readonly string[]>): boolean {
  const seen = new Set<string>();
  const stack = [...(edges.get(start) ?? [])];
  while (stack.length) {
    const x = stack.pop()!;
    if (x === start) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    stack.push(...(edges.get(x) ?? []));
  }
  return false;
}
