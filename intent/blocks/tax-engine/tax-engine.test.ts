import assert from 'node:assert/strict';
import { test } from 'node:test';
import { format, money, parse, type Money } from '../money/index.ts';
import { RefData } from '../refdata/index.ts';
import { TaxEngine, TaxError, divide, parseRate, type TaxRule } from './index.ts';

const usd = (s: string): Money => parse(s, 'USD');
const f = (m: Money): string => format(m);
const DAY = '2026-06-15';

const base = (id: string, over: Partial<TaxRule> = {}): TaxRule => ({ id, name: id, level: 'region', where: { country: 'US', region: 'CA' }, rate: '7.25', from: '2020-01-01', ...over });

function us(extra: { rounding?: 'half-even' | 'half-up' | 'down'; roundAt?: 'line' | 'invoice'; cashIncrement?: number } = {}): TaxEngine {
  const e = new TaxEngine({ seller: { country: 'US', region: 'CA' }, ...extra });
  e.addRules([
    base('ca-state', { name: 'California', rate: '7.25' }),
    base('la-local', { name: 'Los Angeles', level: 'local', where: { country: 'US', region: 'CA', city: 'Los Angeles' }, rate: '2.25' }),
    base('ca-food', { name: 'California food', rate: '0', exempt: true, categories: ['food'] }),
    base('tx-state', { name: 'Texas', where: { country: 'US', region: 'TX' }, rate: '6.25' }),
  ]);
  return e;
}
const la = { country: 'US', region: 'CA', city: 'Los Angeles' };

test('rates are exact percentages of up to four decimals and nothing else', () => {
  assert.equal(parseRate('8.25').n, 82_500n);
  assert.equal(parseRate('0').n, 0n);
  assert.equal(parseRate('100').n, 1_000_000n);
  assert.equal(parseRate('9.975').n, 99_750n);
  for (const t of ['-1', '100.0001', '8.12345', 'abc', '', '1e2', '8,25']) assert.throws(() => parseRate(t), (e: unknown) => e instanceof TaxError && e.code === 'bad-rate', t);
});

test('division rounds by the chosen mode, ties and negatives included', () => {
  const rows: [bigint, bigint, string, bigint][] = [
    [5n, 2n, 'half-even', 2n], [7n, 2n, 'half-even', 4n], [-5n, 2n, 'half-even', -2n],
    [5n, 2n, 'half-up', 3n], [-5n, 2n, 'half-up', -3n], [5n, 2n, 'half-down', 2n], [-5n, 2n, 'half-down', -2n],
    [1n, 3n, 'up', 1n], [-1n, 3n, 'up', -1n], [5n, 3n, 'down', 1n], [-5n, 3n, 'down', -1n], [4n, 2n, 'up', 2n], [2n, 3n, 'half-up', 1n],
  ];
  for (const [n, d, mode, want] of rows) assert.equal(divide(n, d, mode as 'up'), want, `${n}/${d} ${mode}`);
  assert.throws(() => divide(1n, 0n, 'up'), RangeError);
});

test('tax-exclusive: the tax is added, and stacks across levels (state plus city)', () => {
  const c = us().calculate({ day: DAY, currency: 'USD', pricing: 'exclusive', place: la, lines: [{ id: 'l1', amount: usd('100.00'), category: 'goods' }] });
  assert.deepEqual([f(c.net), f(c.tax), f(c.gross), f(c.total)], ['100.00', '9.50', '109.50', '109.50']);
  assert.deepEqual(c.byRule.map((r) => [r.rule, f(r.amount)]), [['ca-state', '7.25'], ['la-local', '2.25']]);
  const elsewhere = us().calculate({ day: DAY, currency: 'USD', pricing: 'exclusive', place: { country: 'US', region: 'CA', city: 'Fresno' }, lines: [{ id: 'l1', amount: usd('100.00'), category: 'goods' }] });
  assert.equal(f(elsewhere.tax), '7.25', 'no city rule for Fresno');
});

test('tax-inclusive: the tax is carved out and net plus tax is exactly what was charged', () => {
  const e = us();
  const exact = e.calculate({ day: DAY, currency: 'USD', pricing: 'inclusive', place: la, lines: [{ id: 'l1', amount: usd('109.50'), category: 'goods' }] });
  assert.deepEqual([f(exact.net), f(exact.tax)], ['100.00', '9.50']);
  for (const amount of ['0.01', '9.99', '19.99', '1234.57', '0.50']) {
    const c = e.calculate({ day: DAY, currency: 'USD', pricing: 'inclusive', place: la, lines: [{ id: 'l1', amount: usd(amount), category: 'goods' }] });
    assert.equal(f(c.gross), amount, `gross of ${amount} comes back`);
    assert.equal(c.net.minor + c.tax.minor, usd(amount).minor);
  }
  const twenty = new TaxEngine({ seller: { country: 'GB' } });
  twenty.addRule({ id: 'gb-vat', name: 'VAT', level: 'country', where: { country: 'GB' }, rate: '20', from: '2011-01-04' });
  const v = twenty.calculate({ day: DAY, currency: 'GBP', pricing: 'inclusive', place: { country: 'GB' }, lines: [{ id: 'l1', amount: parse('10.00', 'GBP'), category: 'goods' }] });
  assert.deepEqual([v.net.minor, v.tax.minor], [833n, 167n]);
});

test('a category rule beats the general one and an exemption stays on the invoice at zero', () => {
  const c = us().calculate({
    day: DAY, currency: 'USD', pricing: 'exclusive', place: { country: 'US', region: 'CA', city: 'Fresno' },
    lines: [{ id: 'bread', amount: usd('10.00'), category: 'food' }, { id: 'tv', amount: usd('10.00'), category: 'goods' }],
  });
  assert.deepEqual(c.lines.map((l) => f(l.tax)), ['0.00', '0.72']);
  assert.deepEqual(c.lines[0]!.notes, ['exempt:ca-food']);
  assert.equal(c.lines[0]!.taxes[0]!.rule, 'ca-food');
});

test('rates are dated: a change takes effect on its first day and not a day earlier', () => {
  const e = new TaxEngine({ seller: { country: 'DE' } });
  e.addRules([
    { id: 'de-2020', name: 'MwSt', level: 'country', where: { country: 'DE' }, rate: '16', from: '2020-07-01', until: '2021-01-01' },
    { id: 'de-2021', name: 'MwSt', level: 'country', where: { country: 'DE' }, rate: '19', from: '2021-01-01' },
  ]);
  const rate = (day: string) => e.resolve({ day, category: 'goods', place: { country: 'DE' } }).components.map((c) => c.rule.rate);
  assert.deepEqual([rate('2020-12-31'), rate('2021-01-01')], [['16'], ['19']]);
  assert.deepEqual(e.resolve({ day: '2020-06-30', category: 'goods', place: { country: 'DE' } }).notes, ['no-rule']);
});

test('inside a level the most specific place wins; two equal rules that differ are refused, not guessed', () => {
  const e = new TaxEngine({ seller: { country: 'US' } });
  e.addRules([
    base('ca', { rate: '7.25' }),
    base('ca-zone', { name: 'special zone', where: { country: 'US', region: 'CA', postalPrefix: '900' }, rate: '8.25' }),
  ]);
  const at = (postal: string) => e.resolve({ day: DAY, category: 'goods', place: { country: 'US', region: 'CA', postal } }).components.map((c) => c.rule.id);
  assert.deepEqual([at('90012'), at('94105'), at('900 12')], [['ca-zone'], ['ca'], ['ca-zone']]);
  e.addRule(base('ca-dup', { rate: '5' }));
  assert.throws(() => at('94105'), (x: unknown) => x instanceof TaxError && x.code === 'ambiguous' && /ca and ca-dup/.test(x.message));
  const p = new TaxEngine({ seller: { country: 'US' } });
  p.addRules([base('a'), base('b', { rate: '5', priority: 2 })]);
  assert.equal(p.resolve({ day: DAY, category: 'x', place: { country: 'US', region: 'CA' } }).components[0]!.rule.id, 'b', 'a priority settles it');
});

test('b2b sales across a reverse-charge zone carry no tax; without a tax id, or outside the zone, they do', () => {
  const e = new TaxEngine({ seller: { country: 'DE' }, reverseCharge: ['DE', 'FR', 'IT'] });
  e.addRules([
    { id: 'fr', name: 'TVA', level: 'country', where: { country: 'FR' }, rate: '20', from: '2014-01-01' },
    { id: 'de', name: 'MwSt', level: 'country', where: { country: 'DE' }, rate: '19', from: '2007-01-01' },
    { id: 'ch', name: 'MWST', level: 'country', where: { country: 'CH' }, rate: '8.1', from: '2024-01-01' },
  ]);
  const line = [{ id: 'l', amount: parse('100.00', 'EUR'), category: 'services' }];
  const tax = (country: string, customer: { type: 'b2b' | 'b2c'; taxId?: string }) => e.calculate({ day: DAY, currency: 'EUR', pricing: 'exclusive', place: { country }, customer, lines: line });
  const rc = tax('FR', { type: 'b2b', taxId: 'FR12345678901' });
  assert.deepEqual([rc.tax.minor, rc.notes], [0n, ['reverse-charge']]);
  assert.equal(tax('FR', { type: 'b2b' }).tax.minor, 2000n);
  assert.equal(tax('FR', { type: 'b2c' }).tax.minor, 2000n);
  assert.equal(tax('DE', { type: 'b2b', taxId: 'DE1' }).tax.minor, 1900n, 'at home the tax is charged');
  assert.equal(tax('CH', { type: 'b2b', taxId: 'CHE-1' }).tax.minor, 810n, 'Switzerland is outside the zone');
});

test('exempt customers, and a seller that is only registered in some places', () => {
  const e = new TaxEngine({ seller: { country: 'US', region: 'CA' }, registered: ['US-CA', 'US-TX'] });
  e.addRules([base('ca'), base('tx', { where: { country: 'US', region: 'TX' }, rate: '6.25' }), base('la', { level: 'local', where: { country: 'US', region: 'CA', city: 'Los Angeles' }, rate: '2.25' })]);
  const sale = (place: { country: string; region?: string; city?: string }, customer?: { type: 'b2b'; exempt: 'all' | ('local')[] }) =>
    e.calculate({ day: DAY, currency: 'USD', pricing: 'exclusive', place, ...(customer ? { customer } : {}), lines: [{ id: 'l', amount: usd('100.00'), category: 'goods' }] });
  assert.equal(f(sale({ country: 'US', region: 'TX' }).tax), '6.25');
  const ny = sale({ country: 'US', region: 'NY' });
  assert.deepEqual([ny.tax.minor, ny.notes], [0n, ['not-registered']]);
  const all = sale(la, { type: 'b2b', exempt: 'all' });
  assert.deepEqual([all.tax.minor, all.notes], [0n, ['customer-exempt']]);
  const local = sale(la, { type: 'b2b', exempt: ['local'] });
  assert.deepEqual([f(local.tax), local.notes], ['7.25', ['customer-exempt:local']]);
});

test('compound taxes are worked on the amount plus the tax before them, and inclusive prices come back exactly', () => {
  const e = new TaxEngine({ seller: { country: 'CA', region: 'QC' } });
  e.addRules([
    { id: 'gst', name: 'GST', level: 'country', where: { country: 'CA' }, rate: '5', from: '2008-01-01' },
    { id: 'qst', name: 'QST', level: 'region', where: { country: 'CA', region: 'QC' }, rate: '9.975', from: '2013-01-01', compound: true },
  ]);
  const place = { country: 'CA', region: 'QC' };
  const x = e.calculate({ day: DAY, currency: 'CAD', pricing: 'exclusive', place, lines: [{ id: 'l', amount: parse('100.00', 'CAD'), category: 'goods' }] });
  assert.deepEqual(x.lines[0]!.taxes.map((t) => [t.rule, f(t.base), f(t.amount)]), [['gst', '100.00', '5.00'], ['qst', '105.00', '10.47']]);
  assert.equal(f(x.gross), '115.47');
  const i = e.calculate({ day: DAY, currency: 'CAD', pricing: 'inclusive', place, lines: [{ id: 'l', amount: parse('115.47', 'CAD'), category: 'goods' }] });
  assert.equal(f(i.net), '100.00');
  assert.equal(i.net.minor + i.tax.minor, 11_547n);
});

test('rounding per line or once per invoice: the lines always add up to the totals either way', () => {
  const lines = ['a', 'b', 'c'].map((id) => ({ id, amount: usd('0.10'), category: 'goods' }));
  const mk = (roundAt: 'line' | 'invoice') => {
    const e = new TaxEngine({ seller: { country: 'US' }, roundAt });
    e.addRule({ id: 't', name: 't', level: 'country', where: { country: 'US' }, rate: '5', from: '2020-01-01' });
    return e.calculate({ day: DAY, currency: 'USD', pricing: 'exclusive', place: { country: 'US' }, lines });
  };
  const perLine = mk('line');
  const perInvoice = mk('invoice');
  assert.deepEqual(perLine.lines.map((l) => l.tax.minor), [0n, 0n, 0n], '0.005 rounds to even, three times');
  assert.equal(perLine.tax.minor, 0n);
  assert.equal(perInvoice.tax.minor, 2n, '0.015 once');
  assert.deepEqual(perInvoice.lines.map((l) => l.tax.minor), [1n, 1n, 0n]);
  for (const c of [perLine, perInvoice]) {
    assert.equal(c.lines.reduce((a, l) => a + l.tax.minor, 0n), c.tax.minor);
    assert.equal(c.net.minor + c.tax.minor, c.gross.minor);
    assert.equal(c.byRule[0]!.amount.minor, c.tax.minor);
  }
  assert.equal(perInvoice.roundAt, 'invoice');
});

test('rounding modes change the last cent, and cash rounding is shown apart from the tax', () => {
  const sale = { day: DAY, currency: 'USD', pricing: 'exclusive' as const, place: { country: 'US' }, lines: [{ id: 'l', amount: usd('10.50'), category: 'goods' }] };
  const mk = (rounding: 'half-even' | 'half-up' | 'down', cashIncrement?: number) => {
    const e = new TaxEngine({ seller: { country: 'US' }, rounding, ...(cashIncrement ? { cashIncrement } : {}) });
    e.addRule({ id: 't', name: 't', level: 'country', where: { country: 'US' }, rate: '5', from: '2020-01-01' });
    return e.calculate(sale);
  };
  assert.deepEqual([mk('half-even').tax.minor, mk('half-up').tax.minor, mk('down').tax.minor], [52n, 53n, 52n], '0.525');
  const cash = mk('half-up', 5);
  assert.deepEqual([f(cash.gross), f(cash.rounding), f(cash.total)], ['11.03', '0.02', '11.05']);
  const none = mk('half-even');
  assert.deepEqual([f(none.rounding), f(none.total)], ['0.00', f(none.gross)]);
});

test('a discount line is a negative amount and nets the tax off with it', () => {
  const c = us().calculate({ day: DAY, currency: 'USD', pricing: 'exclusive', place: { country: 'US', region: 'CA' }, lines: [{ id: 'p', amount: usd('100.00'), category: 'goods' }, { id: 'd', amount: usd('-20.00'), category: 'goods' }] });
  assert.deepEqual([f(c.net), f(c.tax), f(c.gross)], ['80.00', '5.80', '85.80']);
  const back = us().credit(c);
  assert.deepEqual([f(back.net), f(back.tax), f(back.total), f(back.byRule[0]!.amount)], ['-80.00', '-5.80', '-85.80', '-5.80']);
  assert.equal(c.tax.minor, 580n, 'the original is untouched');
});

test('origin sourcing taxes a domestic sale at the seller, destination sourcing at the buyer', () => {
  const rules = [base('ca'), base('tx', { where: { country: 'US', region: 'TX' }, rate: '6.25' })];
  const mk = (sourcing: 'origin' | 'destination') => {
    const e = new TaxEngine({ seller: { country: 'US', region: 'TX' }, sourcing });
    e.addRules(rules);
    return e.calculate({ day: DAY, currency: 'USD', pricing: 'exclusive', place: { country: 'US', region: 'CA' }, lines: [{ id: 'l', amount: usd('100.00'), category: 'goods' }] });
  };
  assert.equal(f(mk('origin').tax), '6.25');
  assert.equal(f(mk('destination').tax), '7.25');
});

test('product categories can be checked against a refdata list, and a retired one follows its replacement', () => {
  const refdata = new RefData();
  refdata.load({ name: 'tax-category', version: 1, codes: [
    { code: 'food', label: 'Food', from: '2000-01-01' },
    { code: 'groceries', label: 'Groceries', from: '2000-01-01', until: '2025-01-01', replacedBy: 'food' },
    { code: 'goods', label: 'Goods', from: '2000-01-01' },
  ] });
  const e = new TaxEngine({ seller: { country: 'US', region: 'CA' }, refdata });
  e.addRules([base('ca'), base('ca-food', { rate: '0', exempt: true, categories: ['food'] })]);
  const place = { country: 'US', region: 'CA' };
  assert.deepEqual(e.resolve({ day: DAY, category: 'groceries', place }).notes, ['exempt:ca-food']);
  assert.throws(() => e.resolve({ day: DAY, category: 'spaceships', place }), (x: unknown) => x instanceof TaxError && x.code === 'unknown-category');
  assert.equal(e.resolve({ day: '2024-06-01', category: 'groceries', place }).components[0]!.rule.id, 'ca', 'before the change it is still groceries, which no rule names');
});

test('withholding: treaty rate, threshold by payment and by year, the no-tax-id rate, and gross-up', () => {
  const e = new TaxEngine({ seller: { country: 'US' } });
  e.addWithholding({ id: 'royalty', category: 'royalty', rate: '30', treaty: { GB: '0', DE: '5' }, noTaxIdRate: '24', from: '2020-01-01' });
  e.addWithholding({ id: 'fees', category: 'fees', rate: '10', threshold: '600.00', thresholdBasis: 'year', from: '2020-01-01' });
  e.addWithholding({ id: 'rent', category: 'rent', rate: '5', threshold: '1000', from: '2020-01-01', payee: ['individual'] });
  const pay = (category: string, amount: string, payee: { country: string; kind: 'individual' | 'company'; taxId?: string }, paid?: string) =>
    e.withhold({ day: DAY, category, payment: usd(amount), payee, ...(paid ? { paidThisYear: usd(paid) } : {}) });

  const gb = pay('royalty', '1000.00', { country: 'GB', kind: 'company', taxId: 'x' });
  assert.deepEqual([gb.rate, f(gb.withheld), f(gb.payable), gb.notes], ['0', '0.00', '1000.00', ['treaty:GB']]);
  const jp = pay('royalty', '1000.00', { country: 'JP', kind: 'company', taxId: 'x' });
  assert.deepEqual([jp.rate, f(jp.withheld), f(jp.payable)], ['30', '300.00', '700.00']);
  const noId = pay('royalty', '1000.00', { country: 'DE', kind: 'company' });
  assert.deepEqual([noId.rate, noId.notes], ['24', ['treaty:DE', 'no-tax-id']], 'the higher of the treaty rate and the no-id rate');
  assert.equal(pay('fees', '500.00', { country: 'US', kind: 'company' }).withheld.minor, 0n, 'still under 600 this year');
  const part = pay('fees', '500.00', { country: 'US', kind: 'company' }, '400.00');
  assert.deepEqual([f(part.basis), f(part.withheld), part.notes], ['300.00', '30.00', ['part-above-threshold']]);
  assert.equal(f(pay('fees', '500.00', { country: 'US', kind: 'company' }, '900.00').withheld), '50.00');
  assert.equal(pay('rent', '999.99', { country: 'US', kind: 'individual' }).withheld.minor, 0n);
  assert.equal(f(pay('rent', '1000.00', { country: 'US', kind: 'individual' }).withheld), '50.00');
  assert.throws(() => pay('rent', '2000.00', { country: 'US', kind: 'company' }), (x: unknown) => x instanceof TaxError && x.code === 'no-withholding-rule');
  assert.equal(f(e.grossUp({ day: DAY, category: 'royalty', net: usd('700.00'), payee: { country: 'JP', kind: 'company', taxId: 'x' } })), '1000.00');
});

test('bad rules, duplicate ids, mixed currencies and unknown currencies are refused with plain messages', () => {
  const e = new TaxEngine({ seller: { country: 'US' } });
  assert.throws(() => e.addRule(base('x', { rate: '120' })), /cannot pass 100 percent/);
  assert.throws(() => e.addRule(base('x', { from: '2020-02-30' })), /from must be a day/);
  assert.throws(() => e.addRule(base('x', { until: '2019-01-01' })), /until must be a day after from/);
  assert.throws(() => e.addRule(base('x', { exempt: true, rate: '3' })), /exemption has a rate of 0/);
  assert.throws(() => e.addRule(base('x', { where: { country: 'USA' } })), /two-letter country/);
  e.addRule(base('ca'));
  assert.throws(() => e.addRule(base('ca')), (x: unknown) => x instanceof TaxError && x.code === 'duplicate-rule');
  const line = { id: 'l', amount: parse('1.00', 'EUR'), category: 'goods' };
  assert.throws(() => e.calculate({ day: DAY, currency: 'USD', pricing: 'exclusive', place: { country: 'US' }, lines: [line] }), (x: unknown) => x instanceof TaxError && x.code === 'currency-mismatch');
  assert.throws(() => e.calculate({ day: DAY, currency: 'XXX', pricing: 'exclusive', place: { country: 'US' }, lines: [] }), /unknown currency/);
  assert.throws(() => e.calculate({ day: 'tomorrow', currency: 'USD', pricing: 'exclusive', place: { country: 'US' }, lines: [] }), /day must be/);
  const dup = { id: 'l', amount: usd('1.00'), category: 'goods' };
  assert.throws(() => e.calculate({ day: DAY, currency: 'USD', pricing: 'exclusive', place: { country: 'US' }, lines: [dup, dup] }), /unique/);
  assert.throws(() => new TaxEngine({ seller: { country: 'US' }, cashIncrement: 1 }), /cashIncrement/);
  assert.equal(money(0, 'USD').minor, 0n);
});
