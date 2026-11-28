import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Audit, memoryAudit } from '../audit/index.ts';
import { money } from '../money/index.ts';
import { checkDate, Ledger, LedgerError, type Entry, type NewEntry } from './index.ts';

const usd = (n: number) => money(n, 'USD');
const NOW = new Date('2026-03-15T09:00:00Z');

function book(audit?: Audit) {
  const l = new Ledger({ now: () => NOW, ...(audit ? { audit } : {}) });
  l.openAccount({ code: '1000', name: 'Assets', type: 'asset', currency: 'USD' });
  l.openAccount({ code: '1010', name: 'Cash', type: 'asset', currency: 'USD', parent: '1000' });
  l.openAccount({ code: '1020', name: 'Receivables', type: 'asset', currency: 'USD', parent: '1000' });
  l.openAccount({ code: '2000', name: 'Payables', type: 'liability', currency: 'USD' });
  l.openAccount({ code: '3000', name: 'Equity', type: 'equity', currency: 'USD' });
  l.openAccount({ code: '3900', name: 'Retained earnings', type: 'equity', currency: 'USD' });
  l.openAccount({ code: '4000', name: 'Sales', type: 'income', currency: 'USD' });
  l.openAccount({ code: '5000', name: 'Rent', type: 'expense', currency: 'USD' });
  l.openAccount({ code: '1090', name: 'Euro cash', type: 'asset', currency: 'EUR' });
  l.openAccount({ code: '4090', name: 'Euro sales', type: 'income', currency: 'EUR' });
  return l;
}
const sale = (date: string, cents: number, extra: Partial<NewEntry> = {}): NewEntry => ({ date, memo: 'Sale', lines: [{ account: '1010', side: 'debit', amount: usd(cents) }, { account: '4000', side: 'credit', amount: usd(cents) }], ...extra });
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'no error';
  } catch (e) {
    return e instanceof LedgerError ? e.code : `other: ${(e as Error).message}`;
  }
};

test('a balanced entry posts, numbered and chained, and its lines cannot be changed', async () => {
  const l = book();
  const e = await l.post(sale('2026-03-01', 12_500), 'ann');
  assert.deepEqual([e.n, e.period, e.postedBy, e.kind, e.prev], [1, '2026-03', 'ann', 'normal', '0'.repeat(64)]);
  const e2 = await l.post(sale('2026-03-02', 500), 'ann');
  assert.equal(e2.prev, e.hash);
  assert.throws(() => ((e.lines as unknown as unknown[])[0] = {}), TypeError);
  assert.throws(() => ((e as { memo: string }).memo = 'edited'), TypeError);
  assert.equal(l.verify(), null);
});

test('an entry that does not balance, or is malformed, is refused with the reason', async () => {
  const l = book();
  assert.equal(await code(l.post({ date: '2026-03-01', memo: 'x', lines: [{ account: '1010', side: 'debit', amount: usd(100) }, { account: '4000', side: 'credit', amount: usd(99) }] }, 'a')), 'unbalanced');
  assert.equal(await code(l.post({ date: '2026-03-01', memo: 'x', lines: [{ account: '1010', side: 'debit', amount: usd(100) }] }, 'a')), 'too-few-lines');
  assert.equal(await code(l.post({ ...sale('2026-03-01', 5), memo: '  ' }, 'a')), 'memo-required');
  assert.equal(await code(l.post(sale('2026-02-30', 5), 'a')), 'bad-date');
  assert.equal(await code(l.post(sale('03/01/2026', 5), 'a')), 'bad-date');
  assert.equal(await code(l.post({ date: '2026-03-01', memo: 'x', lines: [{ account: '1010', side: 'debit', amount: usd(0) }, { account: '4000', side: 'credit', amount: usd(0) }] }, 'a')), 'bad-amount');
  assert.equal(await code(l.post({ date: '2026-03-01', memo: 'x', lines: [{ account: '1010', side: 'debit', amount: usd(-5) }, { account: '4000', side: 'credit', amount: usd(-5) }] }, 'a')), 'bad-amount');
  assert.equal(await code(l.post({ date: '2026-03-01', memo: 'x', lines: [{ account: '9999', side: 'debit', amount: usd(5) }, { account: '4000', side: 'credit', amount: usd(5) }] }, 'a')), 'unknown-account');
  assert.equal(await code(l.post({ date: '2026-03-01', memo: 'x', lines: [{ account: '1000', side: 'debit', amount: usd(5) }, { account: '4000', side: 'credit', amount: usd(5) }] }, 'a')), 'group-account');
  assert.equal(await code(l.post({ date: '2026-03-01', memo: 'x', lines: [{ account: '1090', side: 'debit', amount: usd(5) }, { account: '4000', side: 'credit', amount: usd(5) }] }, 'a')), 'currency-mismatch');
  assert.equal(l.entries().length, 0, 'nothing was kept');
  assert.equal(checkDate('2028-02-29'), '2028-02-29');
});

test('currencies balance on their own and never mix', async () => {
  const l = book();
  const e = await l.post({ date: '2026-03-01', memo: 'Two currencies', lines: [{ account: '1010', side: 'debit', amount: usd(100) }, { account: '4000', side: 'credit', amount: usd(100) }, { account: '1090', side: 'debit', amount: money(90, 'EUR') }, { account: '4090', side: 'credit', amount: money(90, 'EUR') }] }, 'a');
  assert.equal(e.lines.length, 4);
  assert.equal(await code(l.post({ date: '2026-03-01', memo: 'x', lines: [{ account: '1010', side: 'debit', amount: usd(100) }, { account: '4090', side: 'credit', amount: money(100, 'EUR') }] }, 'a')), 'unbalanced', 'a dollar debit is not answered by a euro credit');
  const tb = l.trialBalance('2026-03-31');
  assert.deepEqual(tb.totals.USD, { debit: 100n, credit: 100n, balanced: true });
  assert.deepEqual(tb.totals.EUR, { debit: 90n, credit: 90n, balanced: true });
});

test('the trial balance, balances and statements are as of any day', async () => {
  const l = book();
  await l.post({ date: '2026-01-05', memo: 'Owner puts in cash', lines: [{ account: '1010', side: 'debit', amount: usd(100_000) }, { account: '3000', side: 'credit', amount: usd(100_000) }] }, 'a');
  await l.post(sale('2026-02-10', 25_000), 'a');
  await l.post({ date: '2026-03-01', memo: 'March rent', lines: [{ account: '5000', side: 'debit', amount: usd(8_000) }, { account: '1010', side: 'credit', amount: usd(8_000) }] }, 'a');
  const tb = l.trialBalance('2026-03-31');
  assert.deepEqual(tb.rows.map((r) => [r.account, r.debit, r.credit]), [['1010', 117_000n, 0n], ['3000', 0n, 100_000n], ['4000', 0n, 25_000n], ['5000', 8_000n, 0n]]);
  assert.deepEqual(tb.totals.USD, { debit: 125_000n, credit: 125_000n, balanced: true });
  assert.equal(l.trialBalance('2026-02-28').rows.find((r) => r.account === '1010')!.debit, 125_000n);
  assert.equal(l.balance('1010', '2026-01-31').minor, 100_000n);
  assert.equal(l.balance('1000').minor, 117_000n, 'a group sums its accounts');
  assert.equal(l.balance('4000').minor, 25_000n, 'income is positive in its normal direction');
  assert.equal(l.balance('5000').minor, 8_000n);
  const st = l.statement('1010', { from: '2026-02-01' });
  assert.equal(st.opening.minor, 100_000n);
  assert.deepEqual(st.lines.map((x) => [x.n, x.debit.minor, x.credit.minor, x.balance.minor]), [[2, 25_000n, 0n, 125_000n], [3, 0n, 8_000n, 117_000n]]);
  assert.equal(st.closing.minor, 117_000n);
  assert.deepEqual(l.incomeStatement('2026-01-01', '2026-03-31', 'USD'), { income: usd(25_000), expense: usd(8_000), net: usd(17_000) });
});

test('a mistake is corrected by a reversal, once, and the original stays', async () => {
  const l = book();
  const bad = await l.post(sale('2026-03-01', 9_999), 'ann');
  const rev = await l.reverse(1, { reason: 'wrong amount', by: 'bob' });
  assert.deepEqual([rev.kind, rev.reverses, rev.date, rev.memo], ['reversal', 1, '2026-03-01', 'Reversal of entry 1: wrong amount']);
  assert.deepEqual(rev.lines.map((x) => [x.account, x.side]), [['1010', 'credit'], ['4000', 'debit']]);
  assert.equal(l.balance('1010').minor, 0n);
  assert.equal(l.entry(1), bad, 'the original is untouched');
  assert.equal(l.reversedBy(1), 2);
  await l.post(sale('2026-03-01', 999), 'ann');
  assert.equal(l.balance('4000').minor, 999n);
  assert.equal(await code(l.reverse(1, { reason: 'again', by: 'bob' })), 'already-reversed');
  assert.equal(await code(l.reverse(2, { reason: 'undo the undo', by: 'bob' })), 'not-reversible');
  assert.equal(await code(l.reverse(3, { reason: ' ', by: 'bob' })), 'reason-required');
  assert.equal(await code(l.reverse(77, { reason: 'x', by: 'bob' })), 'unknown-entry');
  assert.equal(l.verify(), null);
});

test('a closed period takes no postings; closing is in order and reopening is latest first with a reason', async () => {
  const l = book();
  await l.post(sale('2026-01-10', 100), 'a');
  await l.post(sale('2026-02-10', 100), 'a');
  assert.equal(await code(l.closePeriod('2026-02', 'a')), 'period-order');
  await l.closePeriod('2026-01', 'a');
  assert.equal(await code(l.post(sale('2026-01-31', 5), 'a')), 'period-closed');
  assert.equal(await code(l.closePeriod('2026-01', 'a')), 'period-closed');
  await l.closePeriod('2026-02', 'a');
  assert.deepEqual(l.closedPeriods(), ['2026-01', '2026-02']);
  assert.equal(await code(l.reopenPeriod('2026-01', 'a', 'late invoice')), 'period-order');
  assert.equal(await code(l.reopenPeriod('2026-02', 'a', '')), 'reason-required');
  await l.reopenPeriod('2026-02', 'a', 'late invoice');
  assert.equal(l.isClosed('2026-02'), false);
  await l.post(sale('2026-02-28', 5), 'a');
  assert.equal(await code(l.closePeriod('2026-13', 'a')), 'bad-period');
  assert.equal(await code(l.reopenPeriod('2026-05', 'a', 'x')), 'period-open');
});

test('reversing an entry from a closed period is dated in the open period and says why', async () => {
  const l = book();
  await l.post(sale('2026-01-10', 700), 'a');
  await l.closePeriod('2026-01', 'a');
  const rev = await l.reverse(1, { reason: 'duplicate', by: 'b' });
  assert.equal(rev.date, '2026-03-15', "today's date from the injected clock");
  assert.equal(rev.note, 'dated 2026-03-15, not 2026-01-10, because 2026-01 is closed');
  assert.equal(l.trialBalance('2026-01-31').totals.USD!.debit, 700n, 'the closed month still shows what it showed');
  assert.equal(l.balance('1010').minor, 0n);
  const l2 = book();
  await l2.post(sale('2026-01-10', 700), 'a');
  await l2.closePeriod('2026-01', 'a');
  assert.equal(await code(l2.reverse(1, { reason: 'x', by: 'b', date: '2026-01-20' })), 'period-closed');
});

test('posting twice with the same key is safe; the same key with other content is refused', async () => {
  const l = book();
  const a = await l.post(sale('2026-03-01', 500, { key: 'order-17' }), 'a');
  const b = await l.post(sale('2026-03-01', 500, { key: 'order-17' }), 'a');
  assert.equal(a, b);
  assert.equal(l.entries().length, 1);
  assert.equal(await code(l.post(sale('2026-03-01', 501, { key: 'order-17' }), 'a')), 'key-conflict');
});

test('the chart is checked: unique codes, matching parents, no postings on groups, inactive accounts closed', async () => {
  const l = book();
  assert.throws(() => l.openAccount({ code: '1010', name: 'dup', type: 'asset', currency: 'USD' }), /exists/);
  assert.throws(() => l.openAccount({ code: '1011', name: 'x', type: 'liability', currency: 'USD', parent: '1000' }), /parent is asset/);
  assert.throws(() => l.openAccount({ code: '1012', name: 'x', type: 'asset', currency: 'EUR', parent: '1000' }), /parent is in USD/);
  assert.throws(() => l.openAccount({ code: '1013', name: 'x', type: 'asset', currency: 'USD', parent: 'nope' }), /does not exist/);
  assert.throws(() => l.openAccount({ code: 'bad code', name: 'x', type: 'asset', currency: 'USD' }), LedgerError);
  assert.throws(() => l.openAccount({ code: '1014', name: 'x', type: 'asset', currency: 'XXX' }), RangeError);
  await l.post(sale('2026-03-01', 1), 'a');
  assert.throws(() => l.openAccount({ code: '4001', name: 'sub', type: 'income', currency: 'USD', parent: '4000' }), /already has postings/);
  l.deactivate('5000');
  assert.equal(await code(l.post({ date: '2026-03-01', memo: 'x', lines: [{ account: '5000', side: 'debit', amount: usd(1) }, { account: '1010', side: 'credit', amount: usd(1) }] }, 'a')), 'inactive-account');
  assert.equal(l.chart().length, 10);
});

test('year end closes income and expense into retained earnings and the income statement still shows the year', async () => {
  const l = book();
  await l.post(sale('2026-02-10', 25_000), 'a');
  await l.post({ date: '2026-03-01', memo: 'Rent', lines: [{ account: '5000', side: 'debit', amount: usd(8_000) }, { account: '1010', side: 'credit', amount: usd(8_000) }] }, 'a');
  assert.equal(await code(l.closeYear(2026, '1010', 'a')), 'bad-account');
  const closing = await l.closeYear(2026, '3900', 'a');
  assert.equal(closing.length, 1);
  assert.deepEqual(closing[0]!.lines.map((x) => [x.account, x.side, x.amount.minor]), [['4000', 'debit', 25_000n], ['5000', 'credit', 8_000n], ['3900', 'credit', 17_000n]]);
  assert.equal(l.balance('4000').minor, 0n);
  assert.equal(l.balance('5000').minor, 0n);
  assert.equal(l.balance('3900').minor, 17_000n);
  assert.deepEqual(l.incomeStatement('2026-01-01', '2026-12-31', 'USD').net, usd(17_000));
  assert.equal(await code(l.closeYear(2026, '3900', 'a')), 'already-closed');
  assert.equal(l.verify(), null);
});

test('every action reaches the audit log, whose chain verifies', async () => {
  const store = memoryAudit();
  const audit = new Audit(store, { now: () => NOW });
  const l = book(audit);
  await l.post(sale('2026-03-01', 5), 'ann');
  await l.reverse(1, { reason: 'oops', by: 'bob' });
  await l.closePeriod('2026-03', 'cy');
  await l.reopenPeriod('2026-03', 'cy', 'audit query');
  assert.deepEqual(store.entries.map((e) => [e.actor, e.action, e.target]), [['ann', 'ledger.post', 'entry:1'], ['bob', 'ledger.reverse', 'entry:2'], ['cy', 'ledger.period.close', 'period:2026-03'], ['cy', 'ledger.period.reopen', 'period:2026-03']]);
  assert.equal(store.entries[0]!.detail!.hash, l.entry(1)!.hash);
  assert.equal(store.entries[3]!.reason, 'audit query');
  assert.equal(await audit.verify(), null);
});

test('a changed, removed or inserted entry is found by verify', async () => {
  const l = book();
  await l.post(sale('2026-03-01', 100), 'a');
  await l.post(sale('2026-03-02', 200), 'a');
  await l.post(sale('2026-03-03', 300), 'a');
  const snap = l.snapshot();
  assert.equal(Ledger.load(snap).verify(), null);
  const edit = (f: (es: Entry[]) => Entry[]) => Ledger.load({ ...snap, entries: f(snap.entries.map((e) => ({ ...e }) as Entry)) }).verify();
  assert.deepEqual(edit((es) => ((es[1] = { ...es[1]!, memo: 'edited' }), es)), { at: 2, why: 'its content was changed after it was posted' });
  assert.deepEqual(edit((es) => es.filter((e) => e.n !== 2)), { at: 3, why: 'entry 2 is missing or out of order' });
  assert.deepEqual(edit((es) => [es[0]!, { ...es[0]!, n: 2 } as Entry, es[2]!]), { at: 2, why: 'it does not follow the entry before it' });
  const head = l.head();
  assert.equal(head.n, 3);
  assert.equal(head.hash, snap.entries[2]!.hash);
});

test('posting is serialised: many at once get distinct numbers in a single chain', async () => {
  const l = book();
  await Promise.all(Array.from({ length: 25 }, (_, i) => l.post(sale('2026-03-01', i + 1), 'a')));
  assert.deepEqual(l.entries().map((e) => e.n), Array.from({ length: 25 }, (_, i) => i + 1));
  assert.equal(l.verify(), null);
  assert.equal(l.balance('4000').minor, BigInt((25 * 26) / 2));
});
