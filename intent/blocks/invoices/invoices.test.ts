import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseXml, child, children } from '../dav/index.ts';
import { money, format } from '../money/index.ts';
import { InvoiceBook, InvoiceError, NotAllowed, Numbering, OutOfOrder, computeTotals, dueDate, earlyDiscount, gaps, parseQuantity, parseTerms, toPdf, toUbl, type DraftInput, type LineInput, type TaxRate } from './index.ts';

const RATES: Record<string, TaxRate> = {
  VAT20: { code: 'VAT20', name: 'VAT', rateBp: 2000 },
  VAT5: { code: 'VAT5', name: 'VAT reduced', rateBp: 500 },
  ZERO: { code: 'ZERO', name: 'Zero rated', rateBp: 0 },
  EXEMPT: { code: 'EXEMPT', name: 'Exempt', rateBp: 0, exemptReason: 'Education is exempt' },
  US: { code: 'US', name: 'Sales tax', rateBp: 825 },
};
const usd = (n: number) => money(n, 'USD');
const line = (description: string, quantity: string | number, price: number, tax = 'VAT20', extra: Partial<LineInput> = {}): LineInput => ({ description, quantity, unitPrice: usd(price), tax, ...extra });
const seller = { name: 'Acme & Sons <Ltd>', address: ['1 High Street'], country: 'GB', taxId: 'GB123456789', email: 'billing@example.test' };
const buyer = { name: 'Buyer plc', address: ['2 Low Road'], country: 'GB' };
const draftOf = (lines: LineInput[], extra: Partial<DraftInput> = {}): DraftInput => ({ seller, buyer, currency: 'USD', lines, terms: 'net 30', ...extra });
const newBook = () => {
  let n = 0;
  return new InvoiceBook({ rates: RATES, newId: () => `id${++n}` });
};

test('totals: tax is rounded once per rate, half-even, from whole minor units', () => {
  const t = computeTotals({ currency: 'USD', lines: [line('Widget', 2, 1999)] }, RATES);
  assert.equal(t.net.minor, 3998n);
  assert.equal(t.tax.minor, 800n, '3998 at 20% is 799.6, rounded to 800');
  assert.equal(t.total.minor, 4798n);
  assert.equal(t.lines[0]!.net.minor, 3998n);
  assert.equal(t.taxes[0]!.taxable.minor, 3998n);
});

test('tax per document and tax per line differ, as each rule says', () => {
  const lines = [line('a', 1, 33, 'US'), line('b', 1, 33, 'US'), line('c', 1, 33, 'US')];
  assert.equal(computeTotals({ currency: 'USD', lines }, RATES).tax.minor, 8n, '99 at 8.25% is 8.1675');
  assert.equal(computeTotals({ currency: 'USD', lines, rounding: 'line' }, RATES).tax.minor, 9n, 'each 33 gives 2.7225, rounded to 3');
  assert.throws(() => computeTotals({ currency: 'USD', lines, rounding: 'line', discount: { percentBp: 100 } }, RATES), InvoiceError);
});

test('line discounts, fixed or percentage, come off before tax', () => {
  const t = computeTotals({ currency: 'USD', lines: [line('Seat', 3, 1000, 'VAT20', { discount: { percentBp: 1000 } }), line('Setup', 1, 500, 'VAT20', { discount: { amount: usd(100) } })] }, RATES);
  assert.deepEqual(t.lines.map((l) => [l.lineDiscount.minor, l.net.minor]), [[300n, 2700n], [100n, 400n]]);
  assert.equal(t.net.minor, 3100n);
  assert.equal(t.tax.minor, 620n);
  assert.throws(() => computeTotals({ currency: 'USD', lines: [line('x', 1, 100, 'VAT20', { discount: { amount: usd(101) } })] }, RATES), /more than/);
  assert.throws(() => computeTotals({ currency: 'USD', lines: [line('x', 1, 100, 'VAT20', { discount: { percentBp: 10001 } })] }, RATES), /between 0 and 100/);
});

test('a document discount is shared over the tax rates by size and each rate is taxed on what is left', () => {
  const t = computeTotals({ currency: 'USD', lines: [line('A', 1, 1000, 'VAT20'), line('B', 1, 1000, 'VAT5')], discount: { percentBp: 1000 } }, RATES);
  assert.equal(t.lineNet.minor, 2000n);
  assert.equal(t.allowance.minor, 200n);
  assert.deepEqual(t.taxes.map((x) => [x.code, x.taxable.minor, x.tax.minor, x.allowance.minor]), [['VAT20', 900n, 180n, 100n], ['VAT5', 900n, 45n, 100n]]);
  assert.equal(t.net.minor, 1800n);
  assert.equal(t.total.minor, 2025n);
});

test('tax-inclusive prices: the net is split out once and shared back so line nets add up', () => {
  const one = computeTotals({ currency: 'USD', pricesIncludeTax: true, lines: [line('Gross', 1, 1200)] }, RATES);
  assert.deepEqual([one.net.minor, one.tax.minor, one.total.minor], [1000n, 200n, 1200n]);
  const three = computeTotals({ currency: 'USD', pricesIncludeTax: true, lines: [line('a', 1, 100), line('b', 1, 100), line('c', 1, 100)] }, RATES);
  assert.deepEqual(three.lines.map((l) => l.net.minor), [84n, 83n, 83n]);
  assert.equal(three.lineNet.minor, 250n);
  assert.equal(three.tax.minor, 50n);
  assert.equal(three.total.minor, 300n, 'the customer pays exactly the shelf price');
});

test('quantities read exactly and hostile ones are refused', () => {
  assert.equal(parseQuantity('0.125'), 125n);
  assert.equal(parseQuantity(2), 2000n);
  assert.equal(computeTotals({ currency: 'USD', lines: [line('half-even', '1.5', 333, 'ZERO')] }, RATES).net.minor, 500n, '499.5 goes to the even 500');
  for (const bad of ['1.2345', '-1', 'abc', '', '1e3', '1,5']) assert.throws(() => parseQuantity(bad), InvoiceError, bad);
});

test('hostile lines are refused with a plain message', () => {
  assert.throws(() => computeTotals({ currency: 'USD', lines: [] }, RATES), /at least one line/);
  assert.throws(() => computeTotals({ currency: 'USD', lines: [line('x', 1, -5)] }, RATES), /credit note/);
  assert.throws(() => computeTotals({ currency: 'USD', lines: [{ description: 'x', quantity: 1, unitPrice: money(5, 'EUR'), tax: 'VAT20' }] }, RATES), /EUR/);
  assert.throws(() => computeTotals({ currency: 'USD', lines: [line('x', 1, 5, 'NOPE')] }, RATES), /unknown tax code/);
  assert.throws(() => computeTotals({ currency: 'USD', lines: [line('  ', 1, 5)] }, RATES), /description/);
});

test('numbering is gap-free per period, restarts, refuses going back, and can be restored', () => {
  const n = new Numbering();
  assert.equal(n.peek('2026-01-05'), 'INV-2026-00001');
  assert.equal(n.next('2026-01-05'), 'INV-2026-00001', 'peek did not spend it');
  assert.equal(n.next('2026-06-30'), 'INV-2026-00002');
  assert.equal(n.next('2027-01-02'), 'INV-2027-00001', 'a new year starts again');
  assert.throws(() => n.next('2026-12-31'), OutOfOrder);
  const restored = new Numbering({}, n.state());
  assert.equal(restored.next('2027-01-03'), 'INV-2027-00002');
  const monthly = new Numbering({ pattern: '{YY}{MM}-{seq:3}', restart: 'month' });
  assert.deepEqual([monthly.next('2026-02-01'), monthly.next('2026-02-02'), monthly.next('2026-03-01')], ['2602-001', '2602-002', '2603-001']);
  assert.throws(() => new Numbering({ pattern: 'INV-{YYYY}' }), /seq/);
  assert.throws(() => n.next('2026-02-30'), /no such day/);
  assert.deepEqual(gaps([1, 2, 4, 7]), [3, 5, 6]);
});

test('payment terms give due dates, end of month and early-payment discounts', () => {
  assert.equal(dueDate('2026-01-15', parseTerms('net 30')), '2026-02-14');
  assert.equal(dueDate('2026-01-15', parseTerms('Net 30 days')), '2026-02-14');
  assert.equal(dueDate('2026-01-15', parseTerms('net 30 EOM')), '2026-03-02', 'from 31 January');
  assert.equal(dueDate('2026-01-15', parseTerms('due on receipt')), '2026-01-15');
  const t = parseTerms('2/10 net 30');
  assert.deepEqual([t.days, t.discountBp, t.discountDays], [30, 200, 10]);
  assert.equal(earlyDiscount('2026-01-01', t, usd(10000), '2026-01-11').minor, 200n);
  assert.equal(earlyDiscount('2026-01-01', t, usd(10000), '2026-01-12').minor, 0n, 'day 11 is too late');
  assert.equal(earlyDiscount('2026-01-01', parseTerms('net 30'), usd(10000), '2026-01-02').minor, 0n);
  for (const bad of ['whenever', '10/30 net 30', '100/5 net 30', 'net']) assert.throws(() => parseTerms(bad), InvoiceError, bad);
});

test('an invoice moves forward only: draft, issued, part paid, paid; payments are exact and repeatable', () => {
  const book = newBook();
  const d = book.draft(draftOf([line('Widget', 2, 1999)]));
  assert.equal(d.status, 'draft');
  assert.equal(d.number, undefined);
  assert.throws(() => book.pay(d.id, usd(1), '2026-03-01', 'p0'), NotAllowed);
  const inv = book.issue(d.id, '2026-03-01');
  assert.deepEqual([inv.number, inv.status, inv.due], ['INV-2026-00001', 'issued', '2026-03-31']);
  assert.throws(() => book.issue(d.id, '2026-03-02'), NotAllowed);
  assert.throws(() => book.revise(d.id, draftOf([line('Other', 1, 1)])), /only a draft/);
  assert.throws(() => Object.assign(book.get(d.id) as object, { status: 'draft' }), TypeError, 'issued documents are frozen');
  assert.equal(book.statusOn(inv.number!, '2026-03-31'), 'issued');
  assert.equal(book.statusOn(inv.number!, '2026-04-01'), 'overdue');
  const p1 = book.pay(inv.number!, usd(2000), '2026-03-05', 'bank-1');
  assert.equal(p1.status, 'part-paid');
  assert.equal(book.balance(inv.number!).minor, 2798n);
  assert.equal(book.pay(inv.number!, usd(2000), '2026-03-05', 'bank-1').payments.length, 1, 'the same reference is the same payment');
  assert.throws(() => book.pay(inv.number!, usd(1999), '2026-03-05', 'bank-1'), /different amount/);
  assert.throws(() => book.pay(inv.number!, usd(2799), '2026-03-06', 'bank-2'), /only 27\.98 is still owed/);
  assert.throws(() => book.pay(inv.number!, usd(100), '2026-02-01', 'bank-3'), /before the invoice/);
  assert.equal(book.statusOn(inv.number!, '2026-04-10'), 'overdue');
  const done = book.pay(inv.number!, usd(2798), '2026-04-10', 'bank-4');
  assert.equal(done.status, 'paid');
  assert.equal(book.balance(inv.number!).minor, 0n);
  assert.equal(book.statusOn(inv.number!, '2026-12-01'), 'paid');
  assert.throws(() => book.pay(inv.number!, usd(1), '2026-04-11', 'bank-5'), InvoiceError);
});

test('a void keeps its number, needs a reason and is refused once money has moved', () => {
  const book = newBook();
  const a = book.issue(book.draft(draftOf([line('A', 1, 1000)])).id, '2026-01-02');
  assert.throws(() => book.void(a.number!, ' ', '2026-01-03'), /reason/);
  const v = book.void(a.number!, 'wrong customer', '2026-01-03');
  assert.deepEqual([v.status, v.voidReason], ['void', 'wrong customer']);
  assert.equal(book.balance(a.number!).minor, 0n);
  const b = book.issue(book.draft(draftOf([line('B', 1, 1000)])).id, '2026-01-04');
  assert.equal(b.number, 'INV-2026-00002', 'the voided number is not reused');
  assert.throws(() => book.void(a.number!, 'again', '2026-01-05'), NotAllowed);
  book.pay(b.number!, usd(100), '2026-01-05', 'r1');
  assert.throws(() => book.void(b.number!, 'oops', '2026-01-06'), /credit it/);
});

test('credit notes get their own series, point at the invoice, and can never credit more than is left', () => {
  const book = newBook();
  const inv = book.issue(book.draft(draftOf([line('Widget', 2, 1999)])).id, '2026-03-01');
  assert.equal(inv.totals.total.minor, 4798n);
  const cn = book.creditNote(inv.number!, '2026-03-10', [line('Widget', 1, 1999)], 'one returned');
  assert.deepEqual([cn.kind, cn.number, cn.creditFor, cn.totals.total.minor], ['credit-note', 'CN-2026-00001', 'INV-2026-00001', 2399n]);
  assert.equal(book.credited(inv.number!).minor, 2399n);
  assert.equal(book.balance(inv.number!).minor, 2399n);
  assert.throws(() => book.creditNote(inv.number!, '2026-03-11'), /more than the 23\.99 still creditable/);
  assert.equal(book.list().filter((d) => d.kind === 'credit-note').length, 1, 'a refused credit leaves nothing behind');
  const rest = book.creditNote(inv.number!, '2026-03-12', [line('Widget', 1, 1999)]);
  assert.equal(rest.number, 'CN-2026-00002');
  assert.equal(book.balance(inv.number!).minor, 0n);
  assert.throws(() => book.pay(cn.number!, usd(1), '2026-03-13', 'x'), /credit note is not paid/);
  assert.throws(() => book.creditNote(book.draft(draftOf([line('x', 1, 1)])).id, '2026-03-14'), /only an issued invoice/);
});

test('the PDF is a real, searchable document naming the number, parties and totals', () => {
  const book = newBook();
  const inv = book.issue(book.draft(draftOf([line('Widget', 2, 1999), line('Gadget', 1, 500, 'VAT5')], { discount: { percentBp: 1000 }, terms: '2/10 net 30' })).id, '2026-03-01');
  const buf = toPdf(inv);
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
  const text = buf.toString('latin1');
  for (const s of ['Invoice INV-2026-00001', 'Buyer plc', 'Widget', 'Gadget', 'Payment terms: 2/10 net 30', 'page 1 of 1', format(inv.totals.total)]) assert.ok(text.includes(s), s);
  assert.ok(text.includes('Acme & Sons <Ltd>'.replace(/[()\\]/g, '\\$&')), 'party names are written as given');
  const draft = book.draft(draftOf([line('x', 1, 1)]));
  assert.ok(toPdf(draft).toString('latin1').includes('Invoice \\(draft\\)'));
});

test('UBL: a Peppol BIS invoice whose totals add up as the standard requires, with text escaped', () => {
  const book = newBook();
  const inv = book.issue(book.draft(draftOf([line('Widget & <co>', 2, 1999), line('Gadget', 1, 500, 'VAT5'), line('Tuition', 1, 1000, 'EXEMPT')], { discount: { percentBp: 500 }, reference: 'PO-77' })).id, '2026-03-01');
  const doc = parseXml(toUbl(inv));
  assert.equal(doc.name, 'Invoice');
  assert.equal(doc.ns, 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2');
  const CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
  const CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
  assert.equal(child(doc, CBC, 'ID')!.text, 'INV-2026-00001');
  assert.equal(child(doc, CBC, 'InvoiceTypeCode')!.text, '380');
  assert.equal(child(doc, CBC, 'DueDate')!.text, '2026-03-31');
  assert.equal(child(doc, CBC, 'BuyerReference')!.text, 'PO-77');
  const m = child(doc, CAC, 'LegalMonetaryTotal')!;
  const get = (n: string) => BigInt(child(m, CBC, n)!.text.replace('.', ''));
  const t = inv.totals;
  assert.equal(get('LineExtensionAmount'), t.lineNet.minor);
  assert.equal(get('TaxExclusiveAmount'), get('LineExtensionAmount') - get('AllowanceTotalAmount'), 'BR-CO-13');
  assert.equal(get('TaxInclusiveAmount'), get('TaxExclusiveAmount') + BigInt(child(child(doc, CAC, 'TaxTotal')!, CBC, 'TaxAmount')!.text.replace('.', '')), 'BR-CO-15');
  assert.equal(get('PayableAmount'), t.total.minor);
  const subs = children(child(doc, CAC, 'TaxTotal')!, CAC, 'TaxSubtotal');
  assert.equal(subs.length, 3);
  const cats = subs.map((s) => child(child(s, CAC, 'TaxCategory')!, CBC, 'ID')!.text);
  assert.deepEqual(cats, ['S', 'S', 'E']);
  assert.equal(child(child(subs[2]!, CAC, 'TaxCategory')!, CBC, 'TaxExemptionReason')!.text, 'Education is exempt');
  const names = children(doc, CAC, 'InvoiceLine').map((l) => child(child(l, CAC, 'Item')!, CBC, 'Name')!.text);
  assert.deepEqual(names, ['Widget & <co>', 'Gadget', 'Tuition']);
  assert.equal(child(child(child(doc, CAC, 'AccountingSupplierParty')!, CAC, 'Party')!, CAC, 'PartyName')!.children[0]!.text, 'Acme & Sons <Ltd>');
});

test('UBL: a credit note is a CreditNote with type 381 and refers to its invoice; drafts are not written', () => {
  const book = newBook();
  const inv = book.issue(book.draft(draftOf([line('Widget', 2, 1999)])).id, '2026-03-01');
  const cn = book.creditNote(inv.number!, '2026-03-05', [line('Widget', 1, 1999)]);
  const doc = parseXml(toUbl(cn));
  const CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
  const CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
  assert.equal(doc.name, 'CreditNote');
  assert.equal(child(doc, CBC, 'CreditNoteTypeCode')!.text, '381');
  assert.equal(child(child(child(doc, CAC, 'BillingReference')!, CAC, 'InvoiceDocumentReference')!, CBC, 'ID')!.text, 'INV-2026-00001');
  assert.equal(child(child(doc, CAC, 'LegalMonetaryTotal')!, CBC, 'PayableAmount')!.text, '23.99');
  assert.equal(child(child(children(doc, CAC, 'CreditNoteLine')[0]!, CBC, 'CreditedQuantity')!.text === '1' ? doc : doc, CBC, 'ID')!.text, cn.number);
  assert.throws(() => toUbl(book.draft(draftOf([line('x', 1, 1)]))), /only an issued document/);
});

test('hostile text cannot break the XML and impossible dates are refused', () => {
  const book = newBook();
  const evil = '\u0000bad\u0008 ]]> <!DOCTYPE x> &amp;';
  const inv = book.issue(book.draft(draftOf([line(evil, 1, 100)], { note: evil })).id, '2026-03-01');
  const xml = toUbl(inv);
  assert.ok(!xml.includes('\u0000') && !xml.includes('\u0008'));
  const doc = parseXml(xml);
  assert.equal(doc.name, 'Invoice', 'the XML reader (which refuses DTDs) accepts it, so nothing was injected');
  assert.throws(() => book.issue(book.draft(draftOf([line('x', 1, 1)])).id, '2026-02-30'), /no such day/);
  assert.throws(() => book.draft(draftOf([line('x', 1, 1)], { terms: 'pay me' })), /not understood/);
});
