/**
 * Invoices and credit notes. A document model (seller, buyer, lines with quantity, unit price, a line discount and
 * a tax code; one discount on the whole document), totals worked out once in whole minor units (money block:
 * half-even, no floats), gap-free numbering per series that restarts by year or month and refuses an issue date
 * earlier than the last one, payment terms ("net 30", "2/10 net 30", "due on receipt", end of month), a status
 * that only moves forward (draft, issued, part paid, paid, void; overdue is read from the date, never stored),
 * credit notes that can never credit more than is still owed on the invoice, and two outputs: a PDF (pdf block)
 * and UBL 2.1 XML in the shape of EN 16931 / Peppol BIS Billing 3.0 (Invoice, with InvoiceTypeCode 380, or
 * CreditNote, with 381; one TaxSubtotal per tax category, the monetary totals the standard's business rules add up).
 *
 * Tax is worked out per rate over the whole document by default (the EU rule: tax is rounded once per rate, not
 * per line), or per line when asked. Prices may include tax: the net is then split out per rate and shared back to
 * the lines so line nets still add up to the rate's taxable amount. Issued documents are frozen; to change one,
 * void it (only while nothing is paid) or credit it.
 *
 * Not here: a tax rate table (callers pass the rates; there is no tax-engine block yet), reverse charge and other
 * exemption logic beyond a code with an exemption reason, e-invoice signing or Peppol transport, and PDF/A or
 * embedded XML (Factur-X): the PDF is the plain pdf block.
 */
import { add, divRound, format, money, sub, times, allocate, type Money } from '../money/index.ts';
import { pdf, type Block } from '../pdf/index.ts';

export class InvoiceError extends Error {}
export class OutOfOrder extends InvoiceError {}
export class NotAllowed extends InvoiceError {}

// ---------------------------------------------------------------- dates

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Read a YYYY-MM-DD date as a UTC day number, refusing impossible days such as 2026-02-30. */
function dayOf(s: string): number {
  const m = DATE.exec(s);
  if (!m) throw new InvoiceError(`not a date (YYYY-MM-DD): ${s}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (new Date(t).toISOString().slice(0, 10) !== s) throw new InvoiceError(`no such day: ${s}`);
  return Math.round(t / 86_400_000);
}
const dateOf = (day: number): string => new Date(day * 86_400_000).toISOString().slice(0, 10);
export const addDays = (s: string, n: number): string => dateOf(dayOf(s) + n);
const endOfMonth = (s: string): string => {
  const [y, m] = [Number(s.slice(0, 4)), Number(s.slice(5, 7))];
  return dateOf(Math.round(Date.UTC(y, m, 0) / 86_400_000));
};

// ---------------------------------------------------------------- numbering

export interface NumberingOptions {
  /** Tokens: {YYYY}, {YY}, {MM}, {seq:N} (zero-padded to N). Default "INV-{YYYY}-{seq:5}". */
  readonly pattern?: string;
  /** When the count goes back to one. Default "year". */
  readonly restart?: 'year' | 'month' | 'never';
}

export interface NumberingState {
  readonly counters: Readonly<Record<string, number>>;
  readonly lastDate: string | undefined;
}

/** A gap-free series. A number is spent when issued and is never handed out again, even if the document is voided. */
export class Numbering {
  private readonly pattern: string;
  private readonly restart: 'year' | 'month' | 'never';
  private counters: Record<string, number> = {};
  private last: string | undefined;

  constructor(o: NumberingOptions = {}, state?: NumberingState) {
    this.pattern = o.pattern ?? 'INV-{YYYY}-{seq:5}';
    this.restart = o.restart ?? 'year';
    if (!/\{seq:\d+\}/.test(this.pattern)) throw new InvoiceError('a numbering pattern needs {seq:N}');
    if (this.restart === 'year' && /\{MM\}/.test(this.pattern) && !/\{YY(YY)?\}/.test(this.pattern)) throw new InvoiceError('a pattern with the month needs the year too');
    if (state) {
      this.counters = { ...state.counters };
      this.last = state.lastDate;
    }
  }

  private period(date: string): string {
    return this.restart === 'year' ? date.slice(0, 4) : this.restart === 'month' ? date.slice(0, 7) : 'all';
  }

  private render(date: string, seq: number): string {
    return this.pattern
      .replace('{YYYY}', date.slice(0, 4))
      .replace('{YY}', date.slice(2, 4))
      .replace('{MM}', date.slice(5, 7))
      .replace(/\{seq:(\d+)\}/, (_m, n: string) => String(seq).padStart(Number(n), '0'));
  }

  /** The number the next issue on this date would get, without spending it. */
  peek(date: string): string {
    dayOf(date);
    return this.render(date, (this.counters[this.period(date)] ?? 0) + 1);
  }

  /** Spend the next number. An issue date before the last issue date is refused: numbers must run in date order. */
  next(date: string): string {
    dayOf(date);
    if (this.last !== undefined && dayOf(date) < dayOf(this.last)) throw new OutOfOrder(`${date} is before the last issue date ${this.last}`);
    const p = this.period(date);
    const n = (this.counters[p] ?? 0) + 1;
    this.counters[p] = n;
    this.last = date;
    return this.render(date, n);
  }

  state(): NumberingState {
    return { counters: { ...this.counters }, lastDate: this.last };
  }
}

/** Sequence numbers missing from a list of issued numbers of one pattern and period, so an audit can name each gap. */
export function gaps(sequences: readonly number[]): number[] {
  const set = new Set(sequences);
  const max = Math.max(0, ...sequences);
  const out: number[] = [];
  for (let i = 1; i <= max; i++) if (!set.has(i)) out.push(i);
  return out;
}

// ---------------------------------------------------------------- terms

export interface Terms {
  /** Days from the issue date (or the end of its month) to the due date. */
  readonly days: number;
  readonly endOfMonth: boolean;
  /** Early-payment discount in hundredths of a percent, and the days it lasts. */
  readonly discountBp?: number;
  readonly discountDays?: number;
  readonly text: string;
}

/** "due on receipt", "net 30", "net 30 EOM", "2/10 net 30" (2% off if paid in 10 days, else due in 30). */
export function parseTerms(text: string): Terms {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^(due )?(on|upon) receipt$|^immediate(ly)?$/.test(t)) return { days: 0, endOfMonth: false, text };
  const m = /^(?:(\d{1,2}(?:\.\d{1,2})?)\/(\d{1,3}) )?net (\d{1,3})(?: days?)?( eom)?$/.exec(t);
  if (!m) throw new InvoiceError(`payment terms not understood: ${text}`);
  const base = { days: Number(m[3]), endOfMonth: m[4] !== undefined, text };
  if (m[1] === undefined) return base;
  const bp = Math.round(Number(m[1]) * 100);
  if (bp <= 0 || bp >= 10000) throw new InvoiceError('an early payment discount is between 0 and 100 percent');
  if (Number(m[2]) >= base.days) throw new InvoiceError('the discount period must be shorter than the net period');
  return { ...base, discountBp: bp, discountDays: Number(m[2]) };
}

export function dueDate(issued: string, terms: Terms): string {
  const from = terms.endOfMonth ? endOfMonth(issued) : issued;
  return addDays(from, terms.days);
}

/** What an early payment on a day is worth off an amount (zero when the terms have none or the window is past). */
export function earlyDiscount(issued: string, terms: Terms, owed: Money, paidOn: string): Money {
  if (terms.discountBp === undefined || terms.discountDays === undefined) return money(0, owed.currency);
  if (dayOf(paidOn) > dayOf(issued) + terms.discountDays) return money(0, owed.currency);
  return times(owed, BigInt(terms.discountBp), 10000n);
}

// ---------------------------------------------------------------- the document

export interface TaxRate {
  readonly code: string;
  readonly name: string;
  /** Hundredths of a percent: 825 is 8.25%. */
  readonly rateBp: number;
  /** A zero rate that is an exemption (not merely zero-rated) needs a reason on an e-invoice. */
  readonly exemptReason?: string;
}

export type Discount = { readonly percentBp: number } | { readonly amount: Money };

export interface Party {
  readonly name: string;
  readonly address?: readonly string[];
  /** ISO 3166-1 alpha-2. */
  readonly country?: string;
  readonly taxId?: string;
  readonly email?: string;
}

export interface LineInput {
  readonly description: string;
  /** Up to three decimals: "1.5", 2, "0.125". Never negative. */
  readonly quantity: string | number;
  readonly unitPrice: Money;
  readonly discount?: Discount;
  readonly tax: string;
}

export interface DraftInput {
  readonly kind?: 'invoice' | 'credit-note';
  readonly seller: Party;
  readonly buyer: Party;
  readonly currency: string;
  readonly lines: readonly LineInput[];
  readonly discount?: Discount;
  readonly terms?: string;
  readonly pricesIncludeTax?: boolean;
  readonly rounding?: 'document' | 'line';
  readonly note?: string;
  /** The buyer's order or reference. */
  readonly reference?: string;
}

export interface LineTotal {
  readonly description: string;
  /** Quantity in thousandths. */
  readonly quantityMilli: bigint;
  readonly unitPrice: Money;
  readonly lineDiscount: Money;
  /** Net of tax and of the line discount, before the document discount. */
  readonly net: Money;
  readonly tax: string;
}

export interface TaxLine {
  readonly code: string;
  readonly name: string;
  readonly rateBp: number;
  readonly exemptReason?: string;
  readonly taxable: Money;
  readonly tax: Money;
  /** The document discount that fell on this rate, net of tax. */
  readonly allowance: Money;
}

export interface Totals {
  readonly lines: readonly LineTotal[];
  readonly taxes: readonly TaxLine[];
  /** Sum of line nets. */
  readonly lineNet: Money;
  /** The document discount, net of tax. */
  readonly allowance: Money;
  /** Taxable total: lineNet minus allowance. */
  readonly net: Money;
  readonly tax: Money;
  readonly total: Money;
}

const BP = 10000n;

export function parseQuantity(q: string | number): bigint {
  const s = typeof q === 'number' ? String(q) : q.trim();
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) throw new InvoiceError(`not a quantity (zero or more, at most three decimals): ${s}`);
  return BigInt(m[1]!) * 1000n + BigInt((m[2] ?? '').padEnd(3, '0') || '0');
}

function discountOf(base: bigint, d: Discount | undefined, currency: string): bigint {
  if (!d) return 0n;
  if ('percentBp' in d) {
    if (!Number.isInteger(d.percentBp) || d.percentBp < 0 || d.percentBp > 10000) throw new InvoiceError('a percentage discount is between 0 and 100 percent');
    return divRound(base * BigInt(d.percentBp), BP);
  }
  if (d.amount.currency !== currency) throw new InvoiceError('a discount is in the document currency');
  if (d.amount.minor < 0n || d.amount.minor > base) throw new InvoiceError('a discount cannot be negative or more than what it discounts');
  return d.amount.minor;
}

/** Part of a tax-inclusive amount that is the net at a rate, rounded once. */
const netOfGross = (gross: bigint, rateBp: number): bigint => divRound(gross * BP, BP + BigInt(rateBp));

/** Every figure of the document, from the lines and the declared tax rates. Nothing here is taken from the caller. */
export function computeTotals(input: Pick<DraftInput, 'currency' | 'lines' | 'discount' | 'pricesIncludeTax' | 'rounding'>, rates: Readonly<Record<string, TaxRate>>): Totals {
  const cur = input.currency;
  const zero = money(0, cur);
  if (!input.lines.length) throw new InvoiceError('an invoice needs at least one line');
  const perLine = input.rounding === 'line';
  if (perLine && (input.discount || input.pricesIncludeTax)) throw new InvoiceError('per-line tax rounding cannot be used with a document discount or tax-inclusive prices');

  // 1. line amounts after line discounts
  const raw = input.lines.map((l) => {
    if (l.unitPrice.currency !== cur) throw new InvoiceError(`line "${l.description}" is in ${l.unitPrice.currency}, the document is in ${cur}`);
    if (l.unitPrice.minor < 0n) throw new InvoiceError('unit prices are not negative: use a credit note');
    if (!rates[l.tax]) throw new InvoiceError(`unknown tax code ${l.tax}`);
    if (!l.description.trim()) throw new InvoiceError('every line needs a description');
    const q = parseQuantity(l.quantity);
    const gross = divRound(l.unitPrice.minor * q, 1000n);
    const disc = discountOf(gross, l.discount, cur);
    return { l, q, disc, amount: gross - disc };
  });

  // 2. groups by tax code, in order of first use
  const codes = [...new Set(raw.map((r) => r.l.tax))];
  const groupSum = new Map(codes.map((c) => [c, raw.filter((r) => r.l.tax === c).reduce((a, r) => a + r.amount, 0n)]));
  const sumAll = [...groupSum.values()].reduce((a, b) => a + b, 0n);
  const docDisc = discountOf(sumAll, input.discount, cur);

  // 3. the document discount shared over the groups by size
  const weights = codes.map((c) => Number(groupSum.get(c)));
  const shares = docDisc > 0n && weights.some((w) => w > 0) ? allocate(money(docDisc, cur), weights).map((m) => m.minor) : codes.map(() => 0n);

  const incl = input.pricesIncludeTax === true;
  const taxes: TaxLine[] = [];
  const lines: LineTotal[] = [];
  codes.forEach((code, gi) => {
    const rate = rates[code]!;
    const members = raw.filter((r) => r.l.tax === code);
    const sum = groupSum.get(code)!;
    const share = shares[gi]!;
    // net before and after the document discount, taxable amount and tax
    const lineNetGroup = incl ? netOfGross(sum, rate.rateBp) : sum;
    const taxable = incl ? netOfGross(sum - share, rate.rateBp) : sum - share;
    const allowance = lineNetGroup - taxable;
    const nets = incl && members.length > 1 ? allocate(money(lineNetGroup, cur), members.map((r) => Number(r.amount))).map((m) => m.minor) : incl ? [lineNetGroup] : members.map((r) => r.amount);
    let tax: bigint;
    if (perLine) tax = nets.reduce((a, n) => a + times(money(n, cur), BigInt(rate.rateBp), BP).minor, 0n);
    else if (incl) tax = sum - share - taxable;
    else tax = times(money(taxable, cur), BigInt(rate.rateBp), BP).minor;
    taxes.push({ code, name: rate.name, rateBp: rate.rateBp, ...(rate.exemptReason !== undefined ? { exemptReason: rate.exemptReason } : {}), taxable: money(taxable, cur), tax: money(tax, cur), allowance: money(allowance, cur) });
    members.forEach((r, i) => lines.push({ description: r.l.description, quantityMilli: r.q, unitPrice: r.l.unitPrice, lineDiscount: money(r.disc, cur), net: money(nets[i]!, cur), tax: code }));
  });
  // restore the caller's line order
  const byOrder: LineTotal[] = [];
  const pool = new Map<string, LineTotal[]>(codes.map((c) => [c, lines.filter((x) => x.tax === c)]));
  for (const r of raw) byOrder.push(pool.get(r.l.tax)!.shift()!);

  const lineNet = byOrder.reduce((a, l) => add(a, l.net), zero);
  const allowance = taxes.reduce((a, t) => add(a, t.allowance), zero);
  const net = sub(lineNet, allowance);
  const tax = taxes.reduce((a, t) => add(a, t.tax), zero);
  return { lines: byOrder, taxes, lineNet, allowance, net, tax, total: add(net, tax) };
}

// ---------------------------------------------------------------- status and documents

export type Status = 'draft' | 'issued' | 'part-paid' | 'paid' | 'void';

export interface PaymentRecord {
  readonly ref: string;
  readonly amount: Money;
  readonly date: string;
}

export interface Document {
  readonly id: string;
  readonly kind: 'invoice' | 'credit-note';
  readonly number?: string;
  readonly status: Status;
  readonly issued?: string;
  readonly due?: string;
  readonly terms: Terms;
  readonly input: DraftInput;
  readonly rates: Readonly<Record<string, TaxRate>>;
  readonly totals: Totals;
  readonly payments: readonly PaymentRecord[];
  /** For a credit note, the invoice number it corrects. */
  readonly creditFor?: string;
  readonly voidedOn?: string;
  readonly voidReason?: string;
}

export interface BookOptions {
  readonly rates: Readonly<Record<string, TaxRate>>;
  readonly invoiceNumbers?: NumberingOptions;
  readonly creditNumbers?: NumberingOptions;
  /** Ids come from the caller so tests are deterministic. */
  readonly newId: () => string;
}

const FORWARD: Readonly<Record<Status, readonly Status[]>> = {
  draft: ['issued'],
  issued: ['part-paid', 'paid', 'void'],
  'part-paid': ['part-paid', 'paid'],
  paid: [],
  void: [],
};

/** Drafts, issuing, payments, credit notes and voids, with the rules that keep an issued invoice true. */
export class InvoiceBook {
  private readonly docs = new Map<string, Document>();
  private readonly byNumber = new Map<string, string>();
  private readonly o: BookOptions;
  readonly invoiceNumbers: Numbering;
  readonly creditNumbers: Numbering;

  constructor(o: BookOptions) {
    this.o = o;
    this.invoiceNumbers = new Numbering(o.invoiceNumbers ?? {});
    this.creditNumbers = new Numbering(o.creditNumbers ?? { pattern: 'CN-{YYYY}-{seq:5}' });
  }

  get(idOrNumber: string): Document {
    const d = this.docs.get(idOrNumber) ?? this.docs.get(this.byNumber.get(idOrNumber) ?? '');
    if (!d) throw new InvoiceError(`no document ${idOrNumber}`);
    return d;
  }

  list(): Document[] {
    return [...this.docs.values()];
  }

  private put(d: Document): Document {
    const frozen = Object.freeze(d);
    this.docs.set(d.id, frozen);
    if (d.number) this.byNumber.set(d.number, d.id);
    return frozen;
  }

  private move(d: Document, to: Status): void {
    if (!FORWARD[d.status].includes(to)) throw new NotAllowed(`a ${d.status} document cannot become ${to}`);
  }

  draft(input: DraftInput, creditFor?: string): Document {
    const totals = computeTotals(input, this.o.rates);
    const terms = parseTerms(input.terms ?? 'due on receipt');
    if (input.seller.name.trim() === '' || input.buyer.name.trim() === '') throw new InvoiceError('seller and buyer need names');
    return this.put({ id: this.o.newId(), kind: input.kind ?? 'invoice', status: 'draft', terms, input, rates: this.o.rates, totals, payments: [], ...(creditFor !== undefined ? { creditFor } : {}) });
  }

  /** Replace a draft's content. Only drafts can be edited. */
  revise(id: string, input: DraftInput): Document {
    const d = this.get(id);
    if (d.status !== 'draft') throw new NotAllowed('only a draft can be edited; void or credit an issued invoice');
    return this.put({ ...d, input, totals: computeTotals(input, this.o.rates), terms: parseTerms(input.terms ?? 'due on receipt') });
  }

  /** Give the draft its number and dates. The number is spent here, once. */
  issue(id: string, date: string): Document {
    const d = this.get(id);
    this.move(d, 'issued');
    const number = d.kind === 'credit-note' ? this.creditNumbers.next(date) : this.invoiceNumbers.next(date);
    return this.put({ ...d, status: 'issued', number, issued: date, due: dueDate(date, d.terms) });
  }

  /** Amount of credit notes issued against an invoice. */
  credited(invoiceNumber: string): Money {
    const inv = this.get(invoiceNumber);
    return this.list()
      .filter((c) => c.kind === 'credit-note' && c.creditFor === inv.number && c.status !== 'void' && c.status !== 'draft')
      .reduce((a, c) => add(a, c.totals.total), money(0, inv.input.currency));
  }

  paid(idOrNumber: string): Money {
    const d = this.get(idOrNumber);
    return d.payments.reduce((a, p) => add(a, p.amount), money(0, d.input.currency));
  }

  /** What is still owed: the total less payments and credit notes. */
  balance(idOrNumber: string): Money {
    const d = this.get(idOrNumber);
    if (d.status === 'void' || d.status === 'draft') return money(0, d.input.currency);
    const owed = sub(sub(d.totals.total, this.paid(idOrNumber)), d.kind === 'invoice' ? this.credited(idOrNumber) : money(0, d.input.currency));
    return owed.minor < 0n ? money(0, d.input.currency) : owed;
  }

  /** Record a payment. The same reference twice is the same payment, not two. Overpaying is refused. */
  pay(idOrNumber: string, amount: Money, date: string, ref: string): Document {
    let d = this.get(idOrNumber);
    if (d.kind !== 'invoice') throw new NotAllowed('a credit note is not paid; apply it to an invoice');
    if (d.payments.some((p) => p.ref === ref)) {
      const p = d.payments.find((x) => x.ref === ref)!;
      if (p.amount.minor !== amount.minor) throw new InvoiceError(`payment ${ref} was recorded with a different amount`);
      return d;
    }
    if (d.status === 'draft' || d.status === 'void') throw new NotAllowed(`a ${d.status} invoice cannot be paid`);
    if (amount.currency !== d.input.currency || amount.minor <= 0n) throw new InvoiceError('a payment is a positive amount in the invoice currency');
    if (dayOf(date) < dayOf(d.issued!)) throw new InvoiceError('a payment cannot come before the invoice was issued');
    const left = this.balance(idOrNumber);
    if (amount.minor > left.minor) throw new InvoiceError(`only ${format(left)} is still owed`);
    d = { ...d, payments: [...d.payments, { ref, amount, date }] };
    const settled = this.balance(idOrNumber).minor - amount.minor === 0n;
    const to: Status = settled ? 'paid' : 'part-paid';
    this.move(this.get(idOrNumber), to);
    return this.put({ ...d, status: to });
  }

  /** Void an issued invoice nobody has paid. Its number stays used, so the series has no gap. */
  void(idOrNumber: string, reason: string, date: string): Document {
    const d = this.get(idOrNumber);
    if (d.payments.length) throw new NotAllowed('an invoice with payments cannot be voided; credit it');
    this.move(d, 'void');
    if (d.kind === 'invoice' && this.credited(idOrNumber).minor > 0n) throw new NotAllowed('an invoice with credit notes cannot be voided');
    if (!reason.trim()) throw new InvoiceError('a void needs a reason');
    return this.put({ ...d, status: 'void', voidedOn: date, voidReason: reason });
  }

  /** A credit note against an issued invoice, for chosen lines or in full. It is issued with its own number. */
  creditNote(invoiceNumber: string, date: string, lines?: readonly LineInput[], note?: string): Document {
    const inv = this.get(invoiceNumber);
    if (inv.kind !== 'invoice' || inv.status === 'draft' || inv.status === 'void') throw new NotAllowed('only an issued invoice can be credited');
    const { discount, ...rest } = inv.input;
    const credit: DraftInput = { ...rest, kind: 'credit-note', lines: lines ?? inv.input.lines, ...(!lines && discount ? { discount } : {}), ...(note !== undefined ? { note } : {}), terms: 'due on receipt' };
    const c = this.draft(credit, inv.number);
    const room = sub(inv.totals.total, this.credited(invoiceNumber));
    if (c.totals.total.minor > room.minor) {
      this.docs.delete(c.id);
      throw new InvoiceError(`a credit of ${format(c.totals.total)} is more than the ${format(room)} still creditable`);
    }
    return this.issue(c.id, date);
  }

  /** The status to show on a day: an issued or part-paid invoice past its due date reads "overdue". */
  statusOn(idOrNumber: string, today: string): Status | 'overdue' {
    const d = this.get(idOrNumber);
    if ((d.status === 'issued' || d.status === 'part-paid') && d.kind === 'invoice' && d.due !== undefined && dayOf(today) > dayOf(d.due) && this.balance(idOrNumber).minor > 0n) return 'overdue';
    return d.status;
  }
}

// ---------------------------------------------------------------- outputs

const qtyText = (milli: bigint): string => {
  const s = (milli / 1000n).toString();
  const f = (milli % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return f ? `${s}.${f}` : s;
};
const pct = (bp: number): string => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;

/** The invoice as a PDF: header, parties, lines, the tax table and totals, terms. Text is real and searchable. */
export function toPdf(d: Document, labels: { readonly invoice?: string; readonly creditNote?: string } = {}): Buffer {
  const t = d.totals;
  const cur = d.input.currency;
  const title = `${d.kind === 'credit-note' ? labels.creditNote ?? 'Credit note' : labels.invoice ?? 'Invoice'} ${d.number ?? '(draft)'}`;
  const party = (p: Party) => [p.name, ...(p.address ?? []), ...(p.taxId ? [`Tax ID ${p.taxId}`] : [])].join(', ');
  const blocks: Block[] = [
    { h: title },
    { p: `From: ${party(d.input.seller)}` },
    { p: `To: ${party(d.input.buyer)}` },
    { p: [d.issued ? `Issued ${d.issued}` : 'Not issued', d.due ? `Due ${d.due}` : '', d.creditFor ? `Corrects ${d.creditFor}` : '', d.input.reference ? `Reference ${d.input.reference}` : ''].filter(Boolean).join('   ') },
    { space: 8 },
    {
      table: [
        ['Description', 'Qty', 'Unit price', 'Discount', 'Net', 'Tax'],
        ...t.lines.map((l) => [l.description, qtyText(l.quantityMilli), format(l.unitPrice), format(l.lineDiscount), format(l.net), pct(d.rates[l.tax]!.rateBp)]),
      ],
      widths: [220, 40, 70, 60, 70, 40],
    },
    { space: 8 },
    {
      table: [
        ['Tax', 'Taxable', 'Amount'],
        ...t.taxes.map((x) => [`${x.name} ${pct(x.rateBp)}`, format(x.taxable), format(x.tax)]),
      ],
    },
    { space: 8 },
    {
      table: [
        ['Subtotal', format(t.lineNet)],
        ...(t.allowance.minor > 0n ? [['Discount', `-${format(t.allowance)}`]] : []),
        ['Tax', format(t.tax)],
        [`Total ${cur}`, format(t.total)],
      ],
    },
    { space: 8 },
    { p: `Payment terms: ${d.terms.text}${d.terms.discountBp ? ` (${pct(d.terms.discountBp)} off if paid within ${d.terms.discountDays} days)` : ''}` },
    ...(d.input.note ? [{ p: d.input.note }] : []),
  ];
  return pdf(blocks, { title, author: d.input.seller.name, footer: (p, n) => `${d.number ?? 'draft'}   page ${p} of ${n}` });
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
// eslint-disable-next-line no-control-regex
const clean = (s: string) => esc(s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, ''));

const category = (r: { rateBp: number; exemptReason?: string }) => (r.rateBp > 0 ? 'S' : r.exemptReason ? 'E' : 'Z');

/** UBL 2.1 for Peppol BIS Billing 3.0: an Invoice (type 380) or CreditNote (381), amounts positive in both. */
export function toUbl(d: Document): string {
  if (d.status === 'draft' || !d.number || !d.issued) throw new NotAllowed('only an issued document can be written as an e-invoice');
  const cur = d.input.currency;
  const t = d.totals;
  const credit = d.kind === 'credit-note';
  const root = credit ? 'CreditNote' : 'Invoice';
  const amt = (name: string, m: Money) => `<cbc:${name} currencyID="${cur}">${format(m)}</cbc:${name}>`;
  const party = (tag: string, p: Party) =>
    `<cac:${tag}><cac:Party>${p.email ? `<cbc:EndpointID schemeID="EM">${clean(p.email)}</cbc:EndpointID>` : ''}<cac:PartyName><cbc:Name>${clean(p.name)}</cbc:Name></cac:PartyName>` +
    `<cac:PostalAddress>${(p.address ?? []).slice(0, 1).map((a) => `<cbc:StreetName>${clean(a)}</cbc:StreetName>`).join('')}${p.country ? `<cac:Country><cbc:IdentificationCode>${clean(p.country)}</cbc:IdentificationCode></cac:Country>` : ''}</cac:PostalAddress>` +
    (p.taxId ? `<cac:PartyTaxScheme><cbc:CompanyID>${clean(p.taxId)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` : '') +
    `<cac:PartyLegalEntity><cbc:RegistrationName>${clean(p.name)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:${tag}>`;
  const cat = (x: TaxLine) => `<cac:TaxCategory><cbc:ID>${category(x)}</cbc:ID><cbc:Percent>${(x.rateBp / 100).toFixed(2)}</cbc:Percent>${x.exemptReason ? `<cbc:TaxExemptionReason>${clean(x.exemptReason)}</cbc:TaxExemptionReason>` : ''}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>`;
  const lineTag = credit ? 'CreditNoteLine' : 'InvoiceLine';
  const qtyTag = credit ? 'CreditedQuantity' : 'InvoicedQuantity';
  const lines = t.lines
    .map((l, i) => {
      const x = t.taxes.find((tx) => tx.code === l.tax)!;
      const perUnit = l.quantityMilli === 0n ? l.unitPrice : money(divRound(l.net.minor * 1000n, l.quantityMilli), cur);
      return `<cac:${lineTag}><cbc:ID>${i + 1}</cbc:ID><cbc:${qtyTag} unitCode="C62">${qtyText(l.quantityMilli)}</cbc:${qtyTag}>${amt('LineExtensionAmount', l.net)}` +
        `<cac:Item><cbc:Name>${clean(l.description)}</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>${category(x)}</cbc:ID><cbc:Percent>${(x.rateBp / 100).toFixed(2)}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>` +
        `<cac:Price>${amt('PriceAmount', d.input.pricesIncludeTax ? perUnit : l.lineDiscount.minor === 0n ? l.unitPrice : perUnit)}</cac:Price></cac:${lineTag}>`;
    })
    .join('');
  const allowances = t.taxes
    .filter((x) => x.allowance.minor > 0n)
    .map((x) => `<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReason>Discount</cbc:AllowanceChargeReason>${amt('Amount', x.allowance)}${cat(x)}</cac:AllowanceCharge>`)
    .join('');
  const sub = t.taxes.map((x) => `<cac:TaxSubtotal>${amt('TaxableAmount', x.taxable)}${amt('TaxAmount', x.tax)}${cat(x)}</cac:TaxSubtotal>`).join('');
  const due = credit ? '' : `<cbc:DueDate>${d.due}</cbc:DueDate>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">` +
    `<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID><cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>` +
    `<cbc:ID>${clean(d.number)}</cbc:ID><cbc:IssueDate>${d.issued}</cbc:IssueDate>${due}<cbc:${credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'}>${credit ? '381' : '380'}</cbc:${credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'}>` +
    `${d.input.note ? `<cbc:Note>${clean(d.input.note)}</cbc:Note>` : ''}<cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>${d.input.reference ? `<cbc:BuyerReference>${clean(d.input.reference)}</cbc:BuyerReference>` : ''}` +
    `${d.creditFor ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${clean(d.creditFor)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : ''}` +
    party('AccountingSupplierParty', d.input.seller) + party('AccountingCustomerParty', d.input.buyer) +
    `<cac:PaymentTerms><cbc:Note>${clean(d.terms.text)}</cbc:Note></cac:PaymentTerms>${allowances}` +
    `<cac:TaxTotal>${amt('TaxAmount', t.tax)}${sub}</cac:TaxTotal>` +
    `<cac:LegalMonetaryTotal>${amt('LineExtensionAmount', t.lineNet)}${amt('TaxExclusiveAmount', t.net)}${amt('TaxInclusiveAmount', t.total)}${amt('AllowanceTotalAmount', t.allowance)}${amt('PayableAmount', t.total)}</cac:LegalMonetaryTotal>` +
    `${lines}</${root}>`
  );
}
