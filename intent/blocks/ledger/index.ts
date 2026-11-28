/**
 * A double-entry ledger. A chart of accounts (assets, liabilities, equity, income, expenses, in a tree where only
 * leaves take postings, each in one currency); journal entries whose lines are debits and credits that balance,
 * currency by currency, in whole minor units from the money block; trial balances and account statements as of any
 * day; and period control. Nothing posted is ever changed or removed: a mistake is corrected by a reversal (a new
 * entry with the sides swapped, linked to the original, allowed once) and then a fresh entry. A closed period takes
 * no postings; a reversal of an entry in a closed period is dated in the current open period instead, and says
 * so. Periods close in order and reopen latest first, with a reason. Year end moves the year's income and
 * expense into retained earnings by closing entries that the income statement leaves out. Every entry is chained
 * to the one before it by a hash, so `verify` finds a changed, removed or inserted entry; every action is also
 * written to the audit block when one is given. A key on an entry makes posting safe to repeat.
 *
 * Out of scope: multi-currency revaluation, tax rules, sub-ledgers (an inventory or receivables block posts
 * entries here), and storage beyond memory (`snapshot` and `Ledger.load` carry the entries).
 */
import { createHash } from 'node:crypto';
import { canonical, type Audit } from '../audit/index.ts';
import { add, money, sub, type Money } from '../money/index.ts';

export class LedgerError extends Error {
  readonly code: string;
  constructor(code: string, why: string) {
    super(why);
    this.name = 'LedgerError';
    this.code = code;
  }
}

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export interface AccountDef {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly parent?: string;
}
export interface Account extends AccountDef {
  active: boolean;
}

export interface Line {
  readonly account: string;
  readonly side: 'debit' | 'credit';
  readonly amount: Money;
  readonly memo?: string;
}
export interface NewEntry {
  /** The accounting date, YYYY-MM-DD. */
  readonly date: string;
  readonly memo: string;
  readonly lines: readonly Line[];
  readonly reference?: string;
  /** Posting twice with the same key and content returns the first entry; different content is refused. */
  readonly key?: string;
}
export interface Entry extends NewEntry {
  readonly n: number;
  readonly period: string;
  readonly postedAt: string;
  readonly postedBy: string;
  readonly kind: 'normal' | 'reversal' | 'closing';
  readonly reverses?: number;
  readonly note?: string;
  readonly prev: string;
  readonly hash: string;
}

const GENESIS = '0'.repeat(64);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD = /^\d{4}-\d{2}$/;
const NORMAL: Readonly<Record<AccountType, 'debit' | 'credit'>> = { asset: 'debit', expense: 'debit', liability: 'credit', equity: 'credit', income: 'credit' };

export function checkDate(d: string): string {
  if (!DATE.test(d)) throw new LedgerError('bad-date', `"${d}" is not a date (YYYY-MM-DD)`);
  const t = new Date(`${d}T00:00:00Z`);
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) throw new LedgerError('bad-date', `"${d}" is not a real date`);
  return d;
}

const bodyOf = (e: Omit<Entry, 'hash'>) => ({
  ...e,
  lines: e.lines.map((l) => ({ account: l.account, side: l.side, amount: `${l.amount.minor}${l.amount.currency}`, ...(l.memo !== undefined ? { memo: l.memo } : {}) })),
});
const hashOf = (e: Omit<Entry, 'hash'>) => createHash('sha256').update(canonical(bodyOf(e))).digest('hex');
const contentKey = (e: NewEntry) => canonical({ date: e.date, memo: e.memo, reference: e.reference ?? null, lines: e.lines.map((l) => [l.account, l.side, `${l.amount.minor}${l.amount.currency}`, l.memo ?? null]) });

export interface TrialRow {
  readonly account: string;
  readonly name: string;
  readonly currency: string;
  readonly debit: bigint;
  readonly credit: bigint;
}
export interface TrialBalance {
  readonly asOf: string;
  readonly rows: readonly TrialRow[];
  /** Per currency: the two columns' totals and whether they agree. */
  readonly totals: Readonly<Record<string, { debit: bigint; credit: bigint; balanced: boolean }>>;
}

export interface Options {
  readonly now?: () => Date;
  readonly audit?: Pick<Audit, 'record'>;
}

export class Ledger {
  private readonly accounts = new Map<string, Account>();
  private readonly list: Entry[] = [];
  private readonly closed = new Set<string>();
  private readonly keys = new Map<string, { content: string; n: number }>();
  private readonly reversed = new Map<number, number>();
  private readonly now: () => Date;
  private readonly audit: Options['audit'];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(o: Options = {}) {
    this.now = o.now ?? (() => new Date());
    this.audit = o.audit;
  }

  // ---------------------------------------------------------------------------------------- chart of accounts

  openAccount(a: AccountDef): Account {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(a.code)) throw new LedgerError('bad-account', `"${a.code}" is not an account code`);
    if (this.accounts.has(a.code)) throw new LedgerError('duplicate-account', `account ${a.code} exists`);
    if (!a.name.trim()) throw new LedgerError('bad-account', 'an account needs a name');
    money(0, a.currency);
    if (a.parent !== undefined) {
      const p = this.accounts.get(a.parent);
      if (!p) throw new LedgerError('bad-account', `parent ${a.parent} does not exist`);
      if (p.type !== a.type) throw new LedgerError('bad-account', `${a.code} is ${a.type} but its parent is ${p.type}`);
      if (p.currency !== a.currency) throw new LedgerError('bad-account', `${a.code} is in ${a.currency} but its parent is in ${p.currency}`);
      if (this.list.some((e) => e.lines.some((l) => l.account === a.parent))) throw new LedgerError('bad-account', `${a.parent} already has postings, so it cannot become a group`);
    }
    const acct: Account = { ...a, active: true };
    this.accounts.set(a.code, acct);
    return acct;
  }
  deactivate(code: string): void {
    const a = this.need(code);
    a.active = false;
  }
  account(code: string): Readonly<Account> | undefined {
    return this.accounts.get(code);
  }
  chart(): readonly Readonly<Account>[] {
    return [...this.accounts.values()].sort((a, b) => a.code.localeCompare(b.code));
  }
  private need(code: string): Account {
    const a = this.accounts.get(code);
    if (!a) throw new LedgerError('unknown-account', `no account ${code}`);
    return a;
  }
  private children(code: string): Account[] {
    return [...this.accounts.values()].filter((a) => a.parent === code);
  }
  private leavesUnder(code: string): string[] {
    const kids = this.children(code);
    return kids.length ? kids.flatMap((k) => this.leavesUnder(k.code)) : [code];
  }

  // ---------------------------------------------------------------------------------------------- periods

  isClosed(period: string): boolean {
    return this.closed.has(period);
  }
  closedPeriods(): string[] {
    return [...this.closed].sort();
  }
  private periodsWithEntries(): string[] {
    return [...new Set(this.list.map((e) => e.period))].sort();
  }

  closePeriod(period: string, by: string): Promise<void> {
    return this.serial(async () => {
      if (!PERIOD.test(period) || Number(period.slice(5)) < 1 || Number(period.slice(5)) > 12) throw new LedgerError('bad-period', `"${period}" is not a period (YYYY-MM)`);
      if (this.closed.has(period)) throw new LedgerError('period-closed', `${period} is already closed`);
      const earlier = this.periodsWithEntries().find((p) => p < period && !this.closed.has(p));
      if (earlier) throw new LedgerError('period-order', `${earlier} has entries and is still open: close periods in order`);
      this.closed.add(period);
      await this.audit?.record({ actor: by, action: 'ledger.period.close', target: `period:${period}` });
    });
  }
  reopenPeriod(period: string, by: string, reason: string): Promise<void> {
    return this.serial(async () => {
      if (!reason.trim()) throw new LedgerError('reason-required', 'reopening a period needs a reason');
      if (!this.closed.has(period)) throw new LedgerError('period-open', `${period} is not closed`);
      const later = [...this.closed].find((p) => p > period);
      if (later) throw new LedgerError('period-order', `${later} is closed after it: reopen the latest first`);
      this.closed.delete(period);
      await this.audit?.record({ actor: by, action: 'ledger.period.reopen', target: `period:${period}`, reason });
    });
  }

  // ----------------------------------------------------------------------------------------------- posting

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const next = this.queue.then(f, f);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private validate(e: NewEntry): void {
    checkDate(e.date);
    if (!e.memo.trim()) throw new LedgerError('memo-required', 'an entry needs a memo');
    if (e.lines.length < 2) throw new LedgerError('too-few-lines', 'an entry has at least two lines');
    const sums = new Map<string, bigint>();
    for (const l of e.lines) {
      const a = this.need(l.account);
      if (!a.active) throw new LedgerError('inactive-account', `account ${l.account} is closed to new postings`);
      if (this.children(l.account).length) throw new LedgerError('group-account', `${l.account} is a group; post to one of its accounts`);
      if (l.amount.currency !== a.currency) throw new LedgerError('currency-mismatch', `${l.account} is in ${a.currency}, the line is in ${l.amount.currency}`);
      if (typeof l.amount.minor !== 'bigint' || l.amount.minor <= 0n) throw new LedgerError('bad-amount', 'every line is a positive amount; the side says debit or credit');
      sums.set(l.amount.currency, (sums.get(l.amount.currency) ?? 0n) + (l.side === 'debit' ? l.amount.minor : -l.amount.minor));
    }
    for (const [c, v] of sums) if (v !== 0n) throw new LedgerError('unbalanced', `${c} debits and credits differ by ${v < 0n ? -v : v}`);
  }

  private commit(e: NewEntry, by: string, extra: { kind: Entry['kind']; reverses?: number; note?: string }): Entry {
    const last = this.list.at(-1);
    const body: Omit<Entry, 'hash'> = {
      date: e.date,
      memo: e.memo,
      lines: Object.freeze(e.lines.map((l) => Object.freeze({ account: l.account, side: l.side, amount: Object.freeze({ minor: l.amount.minor, currency: l.amount.currency }), ...(l.memo !== undefined ? { memo: l.memo } : {}) }))),
      ...(e.reference !== undefined ? { reference: e.reference } : {}),
      ...(e.key !== undefined ? { key: e.key } : {}),
      n: (last?.n ?? 0) + 1,
      period: e.date.slice(0, 7),
      postedAt: this.now().toISOString(),
      postedBy: by,
      kind: extra.kind,
      ...(extra.reverses !== undefined ? { reverses: extra.reverses } : {}),
      ...(extra.note !== undefined ? { note: extra.note } : {}),
      prev: last?.hash ?? GENESIS,
    };
    const entry = Object.freeze({ ...body, hash: hashOf(body) }) as Entry;
    this.list.push(entry);
    if (e.key !== undefined) this.keys.set(e.key, { content: contentKey(e), n: entry.n });
    if (extra.reverses !== undefined) this.reversed.set(extra.reverses, entry.n);
    return entry;
  }

  post(e: NewEntry, by: string): Promise<Entry> {
    return this.serial(async () => {
      if (e.key !== undefined) {
        const k = this.keys.get(e.key);
        if (k) {
          if (k.content !== contentKey(e)) throw new LedgerError('key-conflict', `key ${e.key} was used for a different entry`);
          return this.list[k.n - 1]!;
        }
      }
      this.validate(e);
      if (this.closed.has(e.date.slice(0, 7))) throw new LedgerError('period-closed', `${e.date.slice(0, 7)} is closed`);
      const entry = this.commit(e, by, { kind: 'normal' });
      await this.audit?.record({ actor: by, action: 'ledger.post', target: `entry:${entry.n}`, detail: { hash: entry.hash, date: e.date } });
      return entry;
    });
  }

  /**
   * Undo an entry by a new one with the sides swapped. Once per entry; a reversal cannot itself be reversed (post
   * the corrected entry instead). When the original's period is closed the reversal is dated `date`, which
   * defaults to today and must be in an open period; the note says why it is not on the original's date.
   */
  reverse(n: number, o: { reason: string; by: string; date?: string }): Promise<Entry> {
    return this.serial(async () => {
      const orig = this.list[n - 1];
      if (!orig) throw new LedgerError('unknown-entry', `no entry ${n}`);
      if (!o.reason.trim()) throw new LedgerError('reason-required', 'a reversal needs a reason');
      if (orig.kind === 'reversal') throw new LedgerError('not-reversible', 'a reversal cannot be reversed: post the corrected entry');
      if (this.reversed.has(n)) throw new LedgerError('already-reversed', `entry ${n} was reversed by entry ${this.reversed.get(n)}`);
      const moved = this.closed.has(orig.period);
      const date = checkDate(o.date ?? (moved ? this.now().toISOString().slice(0, 10) : orig.date));
      if (this.closed.has(date.slice(0, 7))) throw new LedgerError('period-closed', `${date.slice(0, 7)} is closed; give a date in an open period`);
      const rev: NewEntry = {
        date,
        memo: `Reversal of entry ${n}: ${o.reason.trim()}`,
        lines: orig.lines.map((l) => ({ account: l.account, side: l.side === 'debit' ? 'credit' : 'debit', amount: l.amount, ...(l.memo !== undefined ? { memo: l.memo } : {}) })),
        ...(orig.reference !== undefined ? { reference: orig.reference } : {}),
      };
      this.validate(rev);
      const entry = this.commit(rev, o.by, { kind: 'reversal', reverses: n, ...(moved ? { note: `dated ${date}, not ${orig.date}, because ${orig.period} is closed` } : {}) });
      await this.audit?.record({ actor: o.by, action: 'ledger.reverse', target: `entry:${entry.n}`, reason: o.reason, detail: { reverses: n, hash: entry.hash } });
      return entry;
    });
  }

  entry(n: number): Entry | undefined {
    return this.list[n - 1];
  }
  entries(): readonly Entry[] {
    return this.list;
  }
  reversedBy(n: number): number | undefined {
    return this.reversed.get(n);
  }

  // ---------------------------------------------------------------------------------------------- reports

  private totals(code: string, o: { from?: string; to?: string; closing?: boolean }): { debit: bigint; credit: bigint } {
    let debit = 0n;
    let credit = 0n;
    for (const e of this.list) {
      if (o.to !== undefined && e.date > o.to) continue;
      if (o.from !== undefined && e.date < o.from) continue;
      if (o.closing === false && e.kind === 'closing') continue;
      for (const l of e.lines) if (l.account === code) l.side === 'debit' ? (debit += l.amount.minor) : (credit += l.amount.minor);
    }
    return { debit, credit };
  }

  /** The balance in the account's normal direction (positive when it is where it usually is), summing sub-accounts when it is a group. */
  balance(code: string, asOf?: string): Money {
    const a = this.need(code);
    let net = 0n;
    for (const leaf of this.leavesUnder(code)) {
      const t = this.totals(leaf, { ...(asOf !== undefined ? { to: checkDate(asOf) } : {}) });
      net += NORMAL[a.type] === 'debit' ? t.debit - t.credit : t.credit - t.debit;
    }
    return money(net, a.currency);
  }

  trialBalance(asOf: string): TrialBalance {
    checkDate(asOf);
    const rows: TrialRow[] = [];
    const totals: Record<string, { debit: bigint; credit: bigint; balanced: boolean }> = {};
    for (const a of this.chart()) {
      if (this.children(a.code).length) continue;
      const t = this.totals(a.code, { to: asOf });
      if (t.debit === 0n && t.credit === 0n) continue;
      const net = t.debit - t.credit;
      const row: TrialRow = { account: a.code, name: a.name, currency: a.currency, debit: net > 0n ? net : 0n, credit: net < 0n ? -net : 0n };
      rows.push(row);
      const c = (totals[a.currency] ??= { debit: 0n, credit: 0n, balanced: true });
      c.debit += row.debit;
      c.credit += row.credit;
    }
    for (const c of Object.values(totals)) c.balanced = c.debit === c.credit;
    return { asOf, rows, totals };
  }

  /** Every line in an account in date order, with the running balance in its normal direction. */
  statement(code: string, o: { from?: string; to?: string } = {}): { opening: Money; lines: { n: number; date: string; memo: string; debit: Money; credit: Money; balance: Money }[]; closing: Money } {
    const a = this.need(code);
    const dir = NORMAL[a.type];
    const delta = (side: 'debit' | 'credit', v: bigint) => (side === dir ? v : -v);
    let run = 0n;
    const lines: { n: number; date: string; memo: string; debit: Money; credit: Money; balance: Money }[] = [];
    let opening = 0n;
    const sorted = [...this.list].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.n - y.n));
    for (const e of sorted) {
      for (const l of e.lines) {
        if (l.account !== code) continue;
        if (o.to !== undefined && e.date > o.to) continue;
        run += delta(l.side, l.amount.minor);
        if (o.from !== undefined && e.date < o.from) {
          opening = run;
          continue;
        }
        lines.push({ n: e.n, date: e.date, memo: e.memo, debit: money(l.side === 'debit' ? l.amount.minor : 0n, a.currency), credit: money(l.side === 'credit' ? l.amount.minor : 0n, a.currency), balance: money(run, a.currency) });
      }
    }
    return { opening: money(opening, a.currency), lines, closing: money(run, a.currency) };
  }

  /** Income less expense between two dates, closing entries left out so a closed year still shows what it earned. */
  incomeStatement(from: string, to: string, currency: string): { income: Money; expense: Money; net: Money } {
    checkDate(from);
    checkDate(to);
    let income = money(0, currency);
    let expense = money(0, currency);
    for (const a of this.accounts.values()) {
      if (a.currency !== currency || this.children(a.code).length) continue;
      const t = this.totals(a.code, { from, to, closing: false });
      if (a.type === 'income') income = add(income, money(t.credit - t.debit, currency));
      if (a.type === 'expense') expense = add(expense, money(t.debit - t.credit, currency));
    }
    return { income, expense, net: sub(income, expense) };
  }

  /**
   * Year end: one closing entry per currency dated 31 December that zeroes every income and expense account and
   * moves the difference into the retained earnings account (equity, same currency).
   */
  closeYear(year: number, retained: string, by: string): Promise<Entry[]> {
    return this.serial(async () => {
      const re = this.need(retained);
      if (re.type !== 'equity') throw new LedgerError('bad-account', `${retained} is not an equity account`);
      const date = `${year}-12-31`;
      checkDate(date);
      if (this.closed.has(`${year}-12`)) throw new LedgerError('period-closed', `${year}-12 is closed`);
      if (this.list.some((e) => e.kind === 'closing' && e.date === date)) throw new LedgerError('already-closed', `the year ${year} already has closing entries`);
      const out: Entry[] = [];
      const currencies = [...new Set([...this.accounts.values()].filter((a) => a.type === 'income' || a.type === 'expense').map((a) => a.currency))].sort();
      for (const cur of currencies) {
        const lines: Line[] = [];
        let net = 0n; // credit minus debit that moves to retained earnings
        for (const a of this.chart()) {
          if (a.currency !== cur || (a.type !== 'income' && a.type !== 'expense') || this.children(a.code).length) continue;
          const t = this.totals(a.code, { from: `${year}-01-01`, to: date });
          const bal = t.credit - t.debit;
          if (bal === 0n) continue;
          lines.push({ account: a.code, side: bal > 0n ? 'debit' : 'credit', amount: money(bal > 0n ? bal : -bal, cur) });
          net += bal;
        }
        if (!lines.length) continue;
        if (re.currency !== cur) throw new LedgerError('currency-mismatch', `${retained} is in ${re.currency} but ${cur} accounts need closing`);
        if (net !== 0n) lines.push({ account: retained, side: net > 0n ? 'credit' : 'debit', amount: money(net > 0n ? net : -net, cur) });
        const e: NewEntry = { date, memo: `Close ${year} income and expense to ${retained}`, lines };
        this.validate(e);
        const entry = this.commit(e, by, { kind: 'closing' });
        out.push(entry);
        await this.audit?.record({ actor: by, action: 'ledger.close-year', target: `entry:${entry.n}`, detail: { year, hash: entry.hash } });
      }
      return out;
    });
  }

  // ------------------------------------------------------------------------------------------------ integrity

  /** Check the whole book: hash chain, numbering, balance of every entry, known accounts, reversal links. Returns the first problem or null. */
  verify(): { at: number; why: string } | null {
    let prev = GENESIS;
    const seen = new Set<number>();
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i]!;
      if (e.n !== i + 1) return { at: e.n, why: `entry ${i + 1} is missing or out of order` };
      if (e.prev !== prev) return { at: e.n, why: 'it does not follow the entry before it' };
      const { hash, ...body } = e;
      if (hashOf(body) !== hash) return { at: e.n, why: 'its content was changed after it was posted' };
      const sums = new Map<string, bigint>();
      for (const l of e.lines) {
        if (!this.accounts.has(l.account)) return { at: e.n, why: `it posts to unknown account ${l.account}` };
        sums.set(l.amount.currency, (sums.get(l.amount.currency) ?? 0n) + (l.side === 'debit' ? l.amount.minor : -l.amount.minor));
      }
      if ([...sums.values()].some((v) => v !== 0n)) return { at: e.n, why: 'its debits and credits differ' };
      if (e.reverses !== undefined) {
        if (e.reverses >= e.n || seen.has(e.reverses)) return { at: e.n, why: 'it reverses an entry that is later or already reversed' };
        seen.add(e.reverses);
      }
      prev = e.hash;
    }
    return null;
  }

  /** The chain's last hash, to publish elsewhere. */
  head(): { n: number; hash: string } {
    const l = this.list.at(-1);
    return { n: l?.n ?? 0, hash: l?.hash ?? GENESIS };
  }

  snapshot(): { accounts: Account[]; entries: Entry[]; closed: string[] } {
    return { accounts: this.chart().map((a) => ({ ...a })), entries: [...this.list], closed: this.closedPeriods() };
  }

  /** Rebuild a ledger from a snapshot, without re-posting: use `verify` to know it is intact. */
  static load(s: { accounts: readonly Account[]; entries: readonly Entry[]; closed: readonly string[] }, o: Options = {}): Ledger {
    const l = new Ledger(o);
    for (const a of s.accounts) l.accounts.set(a.code, { ...a });
    for (const e of s.entries) {
      l.list.push(e);
      if (e.reverses !== undefined) l.reversed.set(e.reverses, e.n);
      const k = (e as NewEntry).key;
      if (k !== undefined) l.keys.set(k, { content: contentKey(e), n: e.n });
    }
    for (const p of s.closed) l.closed.add(p);
    return l;
  }
}
