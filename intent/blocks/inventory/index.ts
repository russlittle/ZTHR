/**
 * Stock, by place, as a record of moves. Quantity in a place is only ever the sum of moves into it less moves out;
 * nothing sets a quantity directly. Places are internal (your shelves), transit, or outside (supplier, customer,
 * loss), and only moves across that edge change the value of stock. Products are tracked plainly, by lot (with
 * an expiry) or by serial number (each exists in one place at a time). Reservations hold stock for an order
 * without moving it, choosing lots first-in or first-expiring, and lapse on their own. Valuation is first-in
 * first-out (cost layers, consumed oldest first, restored exactly by a reversal) or weighted average (value and
 * quantity kept whole, so rounding never loses a cent). A cycle count compares what was found with what the
 * moves say, and turns each difference into a move to or from the loss place at the current cost. A move
 * is corrected by a reversal, never edited. Valued moves become balanced journal entries for the ledger block
 * (inventory against clearing, cost of goods sold or adjustments), keyed by move so posting twice is safe.
 *
 * Quantities are whole units. Out of scope: fractional units and unit conversion, costs added after receipt
 * (landed cost), and warehouse tasks such as picking routes and putaway rules.
 */
import { divRound, money, type Money } from '../money/index.ts';
import type { Ledger, NewEntry } from '../ledger/index.ts';

export class StockError extends Error {
  readonly code: string;
  constructor(code: string, why: string) {
    super(why);
    this.name = 'StockError';
    this.code = code;
  }
}

export type PlaceKind = 'internal' | 'transit' | 'supplier' | 'customer' | 'loss';
export interface Place {
  readonly id: string;
  readonly kind: PlaceKind;
}
export interface Product {
  readonly sku: string;
  readonly tracking: 'none' | 'lot' | 'serial';
  readonly valuation: 'fifo' | 'average';
}

export interface Move {
  readonly id: number;
  readonly date: string;
  readonly sku: string;
  readonly qty: number;
  readonly from: string;
  readonly to: string;
  readonly lot?: string;
  readonly serial?: string;
  /** What the units cost: positive into owned stock, and the cost taken out of it on the way out. */
  readonly value: Money;
  readonly kind: 'receipt' | 'issue' | 'transfer' | 'count' | 'reversal';
  readonly ref?: string;
  readonly reverses?: number;
  /** FIFO layers an outflow used, so a reversal can put the cost back. */
  readonly layers?: readonly { readonly layer: number; readonly qty: number }[];
}

interface Layer {
  readonly id: number;
  readonly sku: string;
  readonly unit: bigint;
  readonly date: string;
  qty: number;
  readonly move: number;
}
export interface Reservation {
  readonly ref: string;
  readonly sku: string;
  readonly place: string;
  readonly allocations: readonly { readonly lot?: string; readonly serial?: string; readonly qty: number }[];
  readonly expiresAt?: number;
}

const SEP = '\u0000';
const keyOf = (place: string, sku: string, id: string) => `${place}${SEP}${sku}${SEP}${id}`;
const isOwned = (k: PlaceKind) => k === 'internal' || k === 'transit';
const whole = (n: number, what = 'quantity') => {
  if (!Number.isSafeInteger(n) || n <= 0) throw new StockError('bad-quantity', `${what} is a whole number above zero`);
};

export interface Options {
  readonly now: () => Date;
  readonly currency: string;
}
export interface Variance {
  readonly sku: string;
  readonly place: string;
  readonly lot?: string;
  readonly serial?: string;
  readonly expected: number;
  readonly counted: number;
  readonly difference: number;
}

export class Inventory {
  private readonly places = new Map<string, Place>();
  private readonly products = new Map<string, Product>();
  private readonly bal = new Map<string, number>();
  private readonly lots = new Map<string, { expiry?: string; first: number }>();
  private readonly serialAt = new Map<string, string>();
  private readonly layers: Layer[] = [];
  private readonly avg = new Map<string, { qty: number; value: bigint }>();
  private readonly moves: Move[] = [];
  private readonly held = new Map<string, Reservation>();
  private readonly reversedMoves = new Set<number>();
  private layerSeq = 0;
  private readonly o: Options;

  constructor(o: Options) {
    this.o = o;
    money(0, o.currency);
  }

  // ------------------------------------------------------------------------------------------------ setup

  addPlace(p: Place): void {
    if (this.places.has(p.id)) throw new StockError('duplicate', `place ${p.id} exists`);
    this.places.set(p.id, p);
  }
  addProduct(p: Product): void {
    if (this.products.has(p.sku)) throw new StockError('duplicate', `product ${p.sku} exists`);
    this.products.set(p.sku, p);
    this.avg.set(p.sku, { qty: 0, value: 0n });
  }
  private place(id: string): Place {
    const p = this.places.get(id);
    if (!p) throw new StockError('unknown-place', `no place ${id}`);
    return p;
  }
  private product(sku: string): Product {
    const p = this.products.get(sku);
    if (!p) throw new StockError('unknown-product', `no product ${sku}`);
    return p;
  }
  private today(): string {
    return this.o.now().toISOString().slice(0, 10);
  }

  // ------------------------------------------------------------------------------------------------ queries

  /** Units in a place (all places that are yours when none is given), optionally one lot or serial. */
  onHand(sku: string, place?: string, id?: string): number {
    let n = 0;
    for (const [k, v] of this.bal) {
      const [p, s, i] = k.split(SEP) as [string, string, string];
      if (s !== sku || (place !== undefined && p !== place) || (id !== undefined && i !== id)) continue;
      if (place === undefined && !isOwned(this.place(p).kind)) continue;
      n += v;
    }
    return n;
  }
  reserved(sku: string, place: string, id?: string): number {
    let n = 0;
    for (const r of this.held.values()) if (r.sku === sku && r.place === place) for (const a of r.allocations) if (id === undefined || (a.lot ?? a.serial ?? '') === id) n += a.qty;
    return n;
  }
  available(sku: string, place: string, id?: string): number {
    return this.onHand(sku, place, id) - this.reserved(sku, place, id);
  }
  /** Units by lot or serial in a place, with expiry: what is on the shelf. */
  contents(sku: string, place: string): { id: string; qty: number; expiry?: string }[] {
    const out: { id: string; qty: number; expiry?: string }[] = [];
    for (const [k, v] of this.bal) {
      const [p, s, i] = k.split(SEP) as [string, string, string];
      if (p === place && s === sku && v !== 0) out.push({ id: i, qty: v, ...(this.lots.get(`${sku}${SEP}${i}`)?.expiry ? { expiry: this.lots.get(`${sku}${SEP}${i}`)!.expiry! } : {}) });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }
  /** What the stock is worth now. */
  value(sku: string): Money {
    const p = this.product(sku);
    const v = p.valuation === 'average' ? this.avg.get(sku)!.value : this.layers.filter((l) => l.sku === sku).reduce((a, l) => a + BigInt(l.qty) * l.unit, 0n);
    return money(v, this.o.currency);
  }
  /** Value per unit: the weighted average, or the next unit out under FIFO. */
  unitCost(sku: string): Money {
    const p = this.product(sku);
    if (p.valuation === 'average') {
      const a = this.avg.get(sku)!;
      return money(a.qty ? divRound(a.value, BigInt(a.qty)) : 0n, this.o.currency);
    }
    const l = this.layers.find((x) => x.sku === sku && x.qty > 0);
    return money(l?.unit ?? 0n, this.o.currency);
  }
  history(sku?: string): readonly Move[] {
    return sku ? this.moves.filter((m) => m.sku === sku) : this.moves;
  }
  reservation(ref: string): Reservation | undefined {
    return this.held.get(ref);
  }

  // ------------------------------------------------------------------------------------------------- moves

  private checkTracking(p: Product, o: { lot?: string; serial?: string }): string {
    if (p.tracking === 'none') {
      if (o.lot !== undefined || o.serial !== undefined) throw new StockError('not-tracked', `${p.sku} is not tracked by lot or serial`);
      return '';
    }
    if (p.tracking === 'lot') {
      if (!o.lot || o.serial !== undefined) throw new StockError('lot-required', `${p.sku} needs a lot`);
      return o.lot;
    }
    if (!o.serial || o.lot !== undefined) throw new StockError('serial-required', `${p.sku} needs a serial number`);
    return o.serial;
  }

  /** The one place all stock changes: checks, updates balances, valuation and layers, and records the move. */
  private move(m: { sku: string; qty: number; from: string; to: string; lot?: string; serial?: string; kind: Move['kind']; ref?: string; unitCost?: bigint; date?: string; reverses?: number; undo?: Move }): Move {
    const p = this.product(m.sku);
    const from = this.place(m.from);
    const to = this.place(m.to);
    whole(m.qty);
    const id = this.checkTracking(p, m);
    if (p.tracking === 'serial' && m.qty !== 1) throw new StockError('bad-quantity', 'a serial number is one unit');
    if (m.from === m.to) throw new StockError('same-place', 'a move needs two different places');
    if (!isOwned(from.kind) && !isOwned(to.kind)) throw new StockError('outside-only', 'a move must start or end in a place that is yours');
    if (isOwned(from.kind)) {
      if (p.tracking === 'serial' && this.serialAt.get(`${m.sku}${SEP}${id}`) !== m.from) throw new StockError('serial-not-here', `serial ${id} is not in ${m.from}`);
      // a count records what is physically gone, reserved or not; every other move may only take free stock
      const free = m.kind === 'count' ? this.onHand(m.sku, m.from, p.tracking === 'none' ? '' : id) : this.available(m.sku, m.from, p.tracking === 'none' ? '' : id);
      if (free < m.qty) throw new StockError('insufficient', `${m.from} has ${free} of ${m.sku}${id ? ` (${id})` : ''} free, ${m.qty} wanted`);
    } else if (p.tracking === 'serial') {
      const at = this.serialAt.get(`${m.sku}${SEP}${id}`);
      if (at !== undefined && isOwned(this.place(at).kind)) throw new StockError('serial-exists', `serial ${id} is already in ${at}`);
    }
    // value
    let value = 0n;
    let used: { layer: number; qty: number }[] | undefined;
    const entering = !isOwned(from.kind) && isOwned(to.kind);
    const leaving = isOwned(from.kind) && !isOwned(to.kind);
    if (entering) {
      const unit = m.unitCost ?? 0n;
      if (unit < 0n) throw new StockError('bad-cost', 'a cost is zero or more');
      value = m.undo ? m.undo.value.minor : unit * BigInt(m.qty);
      if (p.valuation === 'fifo') {
        if (m.undo) {
          for (const u of m.undo.layers ?? []) this.layers.find((l) => l.id === u.layer)!.qty += u.qty;
          used = [...(m.undo.layers ?? [])];
        } else {
          const l: Layer = { id: ++this.layerSeq, sku: m.sku, unit, date: m.date ?? this.today(), qty: m.qty, move: this.moves.length + 1 };
          this.layers.push(l);
          used = [{ layer: l.id, qty: m.qty }];
        }
      } else {
        const a = this.avg.get(m.sku)!;
        a.qty += m.qty;
        a.value += value;
      }
    } else if (leaving) {
      if (p.valuation === 'fifo') {
        used = [];
        if (m.undo) {
          // take back exactly the layers the receipt made
          for (const u of m.undo.layers ?? []) {
            const l = this.layers.find((x) => x.id === u.layer)!;
            if (l.qty < u.qty) throw new StockError('already-used', `the stock received in move ${m.undo.id} has been used`);
          }
          for (const u of m.undo.layers ?? []) {
            this.layers.find((x) => x.id === u.layer)!.qty -= u.qty;
            used.push({ ...u });
          }
          value = m.undo.value.minor;
        } else {
          let need = m.qty;
          for (const l of this.layers.filter((x) => x.sku === m.sku && x.qty > 0).sort((a, b) => a.id - b.id)) {
            const take = Math.min(l.qty, need);
            l.qty -= take;
            need -= take;
            value += BigInt(take) * l.unit;
            used.push({ layer: l.id, qty: take });
            if (need === 0) break;
          }
          if (need > 0) throw new StockError('insufficient', `the cost layers of ${m.sku} hold ${m.qty - need}, ${m.qty} wanted`);
        }
      } else {
        const a = this.avg.get(m.sku)!;
        if (a.qty < m.qty) throw new StockError('insufficient', `the valuation of ${m.sku} holds ${a.qty}, ${m.qty} wanted`);
        value = m.undo ? m.undo.value.minor : a.qty === m.qty ? a.value : divRound(a.value * BigInt(m.qty), BigInt(a.qty));
        a.qty -= m.qty;
        a.value -= value;
      }
    }
    // balances
    const lotKey = p.tracking === 'none' ? '' : id;
    this.bal.set(keyOf(m.from, m.sku, lotKey), (this.bal.get(keyOf(m.from, m.sku, lotKey)) ?? 0) - m.qty);
    this.bal.set(keyOf(m.to, m.sku, lotKey), (this.bal.get(keyOf(m.to, m.sku, lotKey)) ?? 0) + m.qty);
    if (p.tracking === 'serial') this.serialAt.set(`${m.sku}${SEP}${id}`, m.to);
    const mv: Move = {
      id: this.moves.length + 1,
      date: m.date ?? this.today(),
      sku: m.sku,
      qty: m.qty,
      from: m.from,
      to: m.to,
      ...(p.tracking === 'lot' ? { lot: id } : {}),
      ...(p.tracking === 'serial' ? { serial: id } : {}),
      value: money(value, this.o.currency),
      kind: m.kind,
      ...(m.ref !== undefined ? { ref: m.ref } : {}),
      ...(m.reverses !== undefined ? { reverses: m.reverses } : {}),
      ...(used ? { layers: used } : {}),
    };
    this.moves.push(Object.freeze(mv));
    return mv;
  }

  /** Stock arrives from a supplier (or anywhere outside) at a unit cost. Serial products take a list of serials, one move each. */
  receive(o: { sku: string; qty: number; to: string; unitCost: Money; lot?: string; expiry?: string; serials?: readonly string[]; from?: string; ref?: string; date?: string }): Move[] {
    const p = this.product(o.sku);
    if (o.unitCost.currency !== this.o.currency) throw new StockError('bad-cost', `costs are in ${this.o.currency}`);
    const from = o.from ?? [...this.places.values()].find((x) => x.kind === 'supplier')?.id;
    if (!from) throw new StockError('unknown-place', 'there is no supplier place');
    if (this.place(from).kind === 'internal' || this.place(from).kind === 'transit') throw new StockError('not-outside', 'a receipt comes from outside');
    if (o.expiry !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(o.expiry)) throw new StockError('bad-date', 'an expiry is YYYY-MM-DD');
    if (p.tracking === 'serial') {
      if (!o.serials || o.serials.length !== o.qty || new Set(o.serials).size !== o.serials.length) throw new StockError('serial-required', `${o.qty} different serial numbers are needed`);
      return this.atomically(() => o.serials!.map((serial) => this.move({ sku: o.sku, qty: 1, from, to: o.to, serial, kind: 'receipt', unitCost: o.unitCost.minor, ...(o.ref !== undefined ? { ref: o.ref } : {}), ...(o.date ? { date: o.date } : {}) })));
    }
    if (p.tracking === 'lot' && o.lot) {
      const lk = `${o.sku}${SEP}${o.lot}`;
      const known = this.lots.get(lk);
      if (known && (known.expiry ?? '') !== (o.expiry ?? '')) throw new StockError('lot-conflict', `lot ${o.lot} already has expiry ${known.expiry ?? 'none'}`);
      if (!known) this.lots.set(lk, { ...(o.expiry ? { expiry: o.expiry } : {}), first: this.moves.length + 1 });
    }
    return [this.move({ sku: o.sku, qty: o.qty, from, to: o.to, ...(o.lot !== undefined ? { lot: o.lot } : {}), kind: 'receipt', unitCost: o.unitCost.minor, ...(o.ref !== undefined ? { ref: o.ref } : {}), ...(o.date ? { date: o.date } : {}) })];
  }

  /** Stock leaves to a customer (or any outside place). Only what is free (not reserved) may go; use `fulfil` for reserved stock. */
  issue(o: { sku: string; qty: number; from: string; to?: string; lot?: string; serials?: readonly string[]; ref?: string; date?: string }): Move[] {
    const p = this.product(o.sku);
    const to = o.to ?? [...this.places.values()].find((x) => x.kind === 'customer')?.id;
    if (!to) throw new StockError('unknown-place', 'there is no customer place');
    if (isOwned(this.place(to).kind)) throw new StockError('not-outside', 'an issue goes outside; use transfer within your places');
    return this.out(p, { ...o, to }, 'issue');
  }
  transfer(o: { sku: string; qty: number; from: string; to: string; lot?: string; serials?: readonly string[]; ref?: string; date?: string }): Move[] {
    const p = this.product(o.sku);
    if (!isOwned(this.place(o.from).kind) || !isOwned(this.place(o.to).kind)) throw new StockError('not-owned', 'a transfer is between your own places');
    return this.out(p, o, 'transfer');
  }
  private out(p: Product, o: { sku: string; qty: number; from: string; to: string; lot?: string; serials?: readonly string[]; ref?: string; date?: string }, kind: 'issue' | 'transfer'): Move[] {
    const base = { sku: o.sku, from: o.from, to: o.to, kind, ...(o.ref !== undefined ? { ref: o.ref } : {}), ...(o.date ? { date: o.date } : {}) };
    if (p.tracking === 'serial') {
      if (!o.serials || o.serials.length !== o.qty) throw new StockError('serial-required', `${o.qty} serial numbers are needed`);
      return this.atomically(() => o.serials!.map((serial) => this.move({ ...base, qty: 1, serial })));
    }
    return [this.move({ ...base, qty: o.qty, ...(o.lot !== undefined ? { lot: o.lot } : {}) })];
  }

  /** Several moves that all happen or none do. */
  private atomically<T>(f: () => T): T {
    const snap = this.snapshotState();
    try {
      return f();
    } catch (e) {
      this.restoreState(snap);
      throw e;
    }
  }
  private snapshotState() {
    return { bal: new Map(this.bal), serialAt: new Map(this.serialAt), layers: this.layers.map((l) => ({ ...l })), avg: new Map([...this.avg].map(([k, v]) => [k, { ...v }])), moves: this.moves.length, layerSeq: this.layerSeq };
  }
  private restoreState(s: ReturnType<Inventory['snapshotState']>) {
    this.bal.clear();
    s.bal.forEach((v, k) => this.bal.set(k, v));
    this.serialAt.clear();
    s.serialAt.forEach((v, k) => this.serialAt.set(k, v));
    this.layers.length = 0;
    this.layers.push(...s.layers);
    this.avg.clear();
    s.avg.forEach((v, k) => this.avg.set(k, v));
    this.moves.length = s.moves;
    this.layerSeq = s.layerSeq;
  }

  /** Undo a move by its mirror; the cost goes back where it came from. A receipt whose stock has been used cannot be reversed. */
  reverse(id: number, reason: string): Move {
    const m = this.moves[id - 1];
    if (!m) throw new StockError('unknown-move', `no move ${id}`);
    if (!reason.trim()) throw new StockError('reason-required', 'a reversal needs a reason');
    if (m.kind === 'reversal') throw new StockError('not-reversible', 'a reversal cannot be reversed');
    if (this.reversedMoves.has(id)) throw new StockError('already-reversed', `move ${id} was already reversed`);
    const snap = this.snapshotState();
    try {
      const r = this.move({ sku: m.sku, qty: m.qty, from: m.to, to: m.from, ...(m.lot !== undefined ? { lot: m.lot } : {}), ...(m.serial !== undefined ? { serial: m.serial } : {}), kind: 'reversal', reverses: id, undo: m, ref: `reversal of ${id}: ${reason.trim()}` });
      this.reversedMoves.add(id);
      return r;
    } catch (e) {
      this.restoreState(snap);
      throw e;
    }
  }

  // ------------------------------------------------------------------------------------------- reservations

  /** Hold stock for a reference. Picks first-in (`fifo`) or first-expiring (`fefo`) lots, never an expired one; refuses if there is not enough free. */
  reserve(o: { ref: string; sku: string; qty: number; place: string; strategy?: 'fifo' | 'fefo'; lot?: string; serials?: readonly string[]; ttlMs?: number }): Reservation {
    const p = this.product(o.sku);
    whole(o.qty);
    if (this.held.has(o.ref)) throw new StockError('duplicate', `reservation ${o.ref} exists`);
    if (!isOwned(this.place(o.place).kind)) throw new StockError('not-owned', 'only your own places hold stock');
    const alloc: { lot?: string; serial?: string; qty: number }[] = [];
    const key = p.tracking === 'serial' ? 'serial' : 'lot';
    if (p.tracking === 'none') {
      if (this.available(o.sku, o.place, '') < o.qty) throw new StockError('insufficient', `${o.place} has ${this.available(o.sku, o.place, '')} of ${o.sku} free, ${o.qty} wanted`);
      alloc.push({ qty: o.qty });
    } else {
      const wanted = o.serials ? new Set(o.serials) : undefined;
      if (wanted && wanted.size !== o.qty) throw new StockError('serial-required', `${o.qty} serial numbers are needed`);
      const cands = this.contents(o.sku, o.place)
        .filter((c) => (o.lot === undefined || c.id === o.lot) && (!wanted || wanted.has(c.id)) && (c.expiry === undefined || c.expiry >= this.today()))
        .map((c) => ({ ...c, free: this.available(o.sku, o.place, c.id), first: this.lots.get(`${o.sku}${SEP}${c.id}`)?.first ?? 0 }))
        .filter((c) => c.free > 0)
        .sort((a, b) => (o.strategy === 'fefo' ? (a.expiry ?? '9999') < (b.expiry ?? '9999') ? -1 : (a.expiry ?? '9999') > (b.expiry ?? '9999') ? 1 : 0 : 0) || a.first - b.first || a.id.localeCompare(b.id));
      let need = o.qty;
      for (const c of cands) {
        if (need === 0) break;
        const take = Math.min(c.free, need);
        alloc.push({ [key]: c.id, qty: take } as { lot?: string; serial?: string; qty: number });
        need -= take;
      }
      if (need > 0) throw new StockError('insufficient', `${o.place} has ${o.qty - need} usable of ${o.sku} free, ${o.qty} wanted`);
    }
    const r: Reservation = { ref: o.ref, sku: o.sku, place: o.place, allocations: alloc, ...(o.ttlMs !== undefined ? { expiresAt: this.o.now().getTime() + o.ttlMs } : {}) };
    this.held.set(o.ref, r);
    return r;
  }
  release(ref: string): boolean {
    return this.held.delete(ref);
  }
  /** Release every reservation whose time has passed; returns their references. */
  sweep(): string[] {
    const now = this.o.now().getTime();
    const gone = [...this.held.values()].filter((r) => r.expiresAt !== undefined && r.expiresAt <= now).map((r) => r.ref);
    for (const g of gone) this.held.delete(g);
    return gone;
  }
  /** Turn a reservation into moves to an outside place (an issue) or to another of your places (a transfer). */
  fulfil(ref: string, to: string): Move[] {
    const r = this.held.get(ref);
    if (!r) throw new StockError('unknown-reservation', `no reservation ${ref}`);
    this.held.delete(ref);
    try {
      const outside = !isOwned(this.place(to).kind);
      return this.atomically(() => r.allocations.flatMap((a) => {
        const common = { sku: r.sku, from: r.place, to, ref, kind: (outside ? 'issue' : 'transfer') as Move['kind'] };
        if (a.serial !== undefined) return [this.move({ ...common, qty: 1, serial: a.serial })];
        return [this.move({ ...common, qty: a.qty, ...(a.lot !== undefined ? { lot: a.lot } : {}) })];
      }));
    } catch (e) {
      this.held.set(ref, r);
      throw e;
    }
  }

  // -------------------------------------------------------------------------------------------- cycle count

  /**
   * Compare a count with the moves. Each difference is a move between the place and the loss place, valued at
   * the current cost (the weighted average, or under FIFO the cost of the next unit out; a gain with no cost on record needs `fallbackCost`). Reservations that now exceed what is
   * on the shelf are listed in `shortReserved`; they are not released for you.
   */
  count(o: { sku: string; place: string; found: readonly { id?: string; qty: number }[]; fallbackCost?: Money; lossPlace?: string; date?: string; ref?: string }): { variances: Variance[]; moves: Move[]; shortReserved: string[] } {
    const p = this.product(o.sku);
    const loss = o.lossPlace ?? [...this.places.values()].find((x) => x.kind === 'loss')?.id;
    if (!loss || this.place(loss).kind !== 'loss') throw new StockError('unknown-place', 'a count needs a loss place');
    if (!isOwned(this.place(o.place).kind)) throw new StockError('not-owned', 'only your own places are counted');
    const found = new Map<string, number>();
    for (const f of o.found) {
      if (!Number.isSafeInteger(f.qty) || f.qty < 0) throw new StockError('bad-quantity', 'a counted quantity is zero or more');
      const id = p.tracking === 'none' ? '' : f.id;
      if (id === undefined) throw new StockError(p.tracking === 'lot' ? 'lot-required' : 'serial-required', `${o.sku} is counted by ${p.tracking}`);
      if (p.tracking === 'serial' && f.qty > 1) throw new StockError('bad-quantity', 'a serial number is counted once');
      found.set(id, (found.get(id) ?? 0) + f.qty);
    }
    const ids = new Set([...found.keys(), ...this.contents(o.sku, o.place).map((c) => c.id)]);
    const variances: Variance[] = [];
    const moves: Move[] = [];
    const snap = this.snapshotState();
    try {
      for (const id of [...ids].sort()) {
        const expected = this.onHand(o.sku, o.place, id);
        const counted = found.get(id) ?? 0;
        if (expected === counted) continue;
        const diff = counted - expected;
        variances.push({ sku: o.sku, place: o.place, ...(p.tracking === 'lot' ? { lot: id } : {}), ...(p.tracking === 'serial' ? { serial: id } : {}), expected, counted, difference: diff });
        const idArg = p.tracking === 'lot' ? { lot: id } : p.tracking === 'serial' ? { serial: id } : {};
        if (diff > 0) {
          const unit = this.unitCost(o.sku).minor || o.fallbackCost?.minor;
          if (!unit) throw new StockError('bad-cost', `${o.sku} has no cost on record; give a fallbackCost for the gain`);
          if (p.tracking === 'serial') {
            const at = this.serialAt.get(`${o.sku}${SEP}${id}`);
            if (at !== undefined && isOwned(this.place(at).kind)) throw new StockError('serial-exists', `serial ${id} is on record in ${at}, not ${o.place}`);
          }
          moves.push(this.move({ sku: o.sku, qty: diff, from: loss, to: o.place, ...idArg, kind: 'count', unitCost: unit, ...(o.date ? { date: o.date } : {}), ...(o.ref ? { ref: o.ref } : {}) }));
        } else moves.push(this.move({ sku: o.sku, qty: -diff, from: o.place, to: loss, ...idArg, kind: 'count', ...(o.date ? { date: o.date } : {}), ...(o.ref ? { ref: o.ref } : {}) }));
      }
    } catch (e) {
      this.restoreState(snap);
      throw e;
    }
    const shortReserved = [...this.held.values()].filter((r) => r.sku === o.sku && r.place === o.place && r.allocations.some((a) => this.onHand(o.sku, o.place, a.lot ?? a.serial ?? '') < this.reserved(o.sku, o.place, a.lot ?? a.serial ?? ''))).map((r) => r.ref);
    return { variances, moves, shortReserved };
  }

  // ------------------------------------------------------------------------------------------------ ledger

  /** The journal entries a set of moves make, keyed by move so posting them twice posts them once. Moves with no value make none. */
  journal(moves: readonly Move[], a: { inventory: string; clearing: string; cogs: string; adjustments: string }): NewEntry[] {
    const out: NewEntry[] = [];
    for (const m of moves) {
      if (m.value.minor === 0n) continue;
      const from = this.place(m.from);
      const to = this.place(m.to);
      const inflow = !isOwned(from.kind) && isOwned(to.kind);
      const outside = inflow ? from : to;
      if (isOwned(from.kind) === isOwned(to.kind)) continue;
      const other = outside.kind === 'supplier' ? a.clearing : outside.kind === 'customer' ? a.cogs : a.adjustments;
      const [debit, credit] = inflow ? [a.inventory, other] : [other, a.inventory];
      out.push({ date: m.date, memo: `Stock move ${m.id}: ${m.qty} x ${m.sku} ${m.from} to ${m.to}`, reference: `move:${m.id}`, key: `inv-move-${m.id}`, lines: [{ account: debit, side: 'debit', amount: m.value }, { account: credit, side: 'credit', amount: m.value }] });
    }
    return out;
  }
  async postToLedger(ledger: Ledger, moves: readonly Move[], a: { inventory: string; clearing: string; cogs: string; adjustments: string }, by: string) {
    const entries = [];
    for (const e of this.journal(moves, a)) entries.push(await ledger.post(e, by));
    return entries;
  }
}
