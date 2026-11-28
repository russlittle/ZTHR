/**
 * Tax engine: sales tax, VAT and GST worked out from dated rate tables, and withholding on payments. A rule says
 * where it applies (country, region, city, postal prefix), to which product categories and which kind of customer,
 * and on which days; a sale is resolved to the rules in force on its day, then priced either tax-exclusive (tax is
 * added to the amount) or tax-inclusive (tax is carved out of it). Rules stack across levels (country, region,
 * local, special) while within one level the most specific rule wins, and two equally specific rules that disagree
 * are an error rather than a guess. Reverse charge, exempt customers and seller registrations are honoured.
 * Amounts are bigint minor units (see money); every rate is an exact fraction of a percentage with up to four
 * decimals, taxes are worked out exactly and rounded once, by the chosen mode, per line or per invoice, and the
 * lines always add back to the totals. Compound taxes are worked on the amount plus the taxes before them.
 * Withholding takes a rate by category and payee country (treaty rates), a threshold and a no-tax-id rate.
 * Product categories can be checked against a refdata list, so a retired category follows its replacement.
 * Standards: ISO 3166-1 alpha-2 country codes, ISO 4217 currencies via money, ISO 8601 dates (YYYY-MM-DD).
 */
import { EXPONENT, money, type Money } from '../money/index.ts';
import type { RefData } from '../refdata/index.ts';

export type TaxErrorCode =
  | 'bad-rate'
  | 'bad-rule'
  | 'duplicate-rule'
  | 'bad-input'
  | 'ambiguous'
  | 'unknown-category'
  | 'currency-mismatch'
  | 'no-withholding-rule';

export class TaxError extends Error {
  readonly code: TaxErrorCode;
  constructor(code: TaxErrorCode, message: string) {
    super(message);
    this.name = 'TaxError';
    this.code = code;
  }
}

export type Level = 'country' | 'region' | 'local' | 'special';
const LEVELS: readonly Level[] = ['country', 'region', 'local', 'special'];

/** How a division that does not come out even is settled. `up` and `down` go away from and toward zero. */
export type Rounding = 'half-even' | 'half-up' | 'half-down' | 'up' | 'down';
const ROUNDINGS: readonly Rounding[] = ['half-even', 'half-up', 'half-down', 'up', 'down'];

export interface Place {
  country: string;
  region?: string;
  city?: string;
  postal?: string;
}

/** The part of a place a rule covers; every field given must match. */
export interface Where {
  country: string;
  region?: string;
  city?: string;
  postalPrefix?: string;
}

export interface TaxRule {
  id: string;
  name: string;
  level: Level;
  where: Where;
  /** A percentage with up to four decimals, such as "8.25". */
  rate: string;
  /** Product categories it covers; left out, all of them. */
  categories?: readonly string[];
  customer?: 'b2b' | 'b2c';
  from: string;
  until?: string;
  /** Worked on the amount plus the taxes before it, as some provinces do. */
  compound?: boolean;
  /** An exemption: kept on the invoice at zero so the reason shows. */
  exempt?: boolean;
  priority?: number;
}

export interface Customer {
  type: 'b2b' | 'b2c';
  taxId?: string;
  /** Exempt from every tax, or from the levels listed. */
  exempt?: 'all' | readonly Level[];
}

export interface LineInput {
  id: string;
  /** The line total: price times quantity, less any discount. May be negative. */
  amount: Money;
  category: string;
}

export interface Sale {
  day: string;
  currency: string;
  pricing: 'exclusive' | 'inclusive';
  place: Place;
  customer?: Customer;
  lines: readonly LineInput[];
  roundAt?: 'line' | 'invoice';
}

export interface LineTax {
  rule: string;
  name: string;
  level: Level;
  rate: string;
  base: Money;
  amount: Money;
}

export interface TaxedLine {
  id: string;
  category: string;
  net: Money;
  tax: Money;
  gross: Money;
  taxes: LineTax[];
  notes: string[];
}

export interface RuleTotal {
  rule: string;
  name: string;
  level: Level;
  rate: string;
  base: Money;
  amount: Money;
}

export interface Calculation {
  currency: string;
  pricing: 'exclusive' | 'inclusive';
  roundAt: 'line' | 'invoice';
  lines: TaxedLine[];
  net: Money;
  tax: Money;
  gross: Money;
  byRule: RuleTotal[];
  /** What cash rounding added to or took off the gross, if it is on. */
  rounding: Money;
  /** What is to be paid: gross plus the cash rounding. */
  total: Money;
  notes: string[];
}

export interface WithholdingRule {
  id: string;
  category: string;
  /** The standard rate, as a percentage. */
  rate: string;
  /** Treaty rates by payee country. */
  treaty?: Readonly<Record<string, string>>;
  /** The rate when the payee gave no tax id; the higher of it and the normal rate applies. */
  noTaxIdRate?: string;
  /** A threshold as a decimal amount in the payment's currency. */
  threshold?: string;
  /** `payment`: the whole payment counts only if it reaches the threshold. `year`: only what lies above it does. */
  thresholdBasis?: 'payment' | 'year';
  payee?: readonly ('individual' | 'company')[];
  from: string;
  until?: string;
}

export interface Payee {
  country: string;
  kind: 'individual' | 'company';
  taxId?: string;
}

export interface Withholding {
  rule: string;
  rate: string;
  basis: Money;
  withheld: Money;
  payable: Money;
  notes: string[];
}

export interface Options {
  seller: Place;
  rounding?: Rounding;
  roundAt?: 'line' | 'invoice';
  /** `destination` (default) or `origin`: where a sale inside the seller's country is taxed. */
  sourcing?: 'destination' | 'origin';
  /** Places the seller is registered to charge tax in: "US", "US-CA". Left out, everywhere. */
  registered?: readonly string[];
  /** Countries inside one reverse-charge zone, such as the EU. */
  reverseCharge?: readonly string[];
  refdata?: RefData;
  categoryList?: string;
  /** Cash rounding of the amount to pay, to a multiple of this many minor units. */
  cashIncrement?: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Exact arithmetic

interface Frac {
  n: bigint;
  d: bigint;
}

const abs = (a: bigint): bigint => (a < 0n ? -a : a);
function gcd(a: bigint, b: bigint): bigint {
  let x = abs(a);
  let y = abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}
function frac(n: bigint, d: bigint = 1n): Frac {
  const s = d < 0n ? -1n : 1n;
  const g = gcd(n, d) || 1n;
  return { n: (s * n) / g, d: (s * d) / g };
}
const fadd = (a: Frac, b: Frac): Frac => frac(a.n * b.d + b.n * a.d, a.d * b.d);
const fmul = (a: Frac, b: Frac): Frac => frac(a.n * b.n, a.d * b.d);
const fdiv = (a: Frac, b: Frac): Frac => frac(a.n * b.d, a.d * b.n);

function floorDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  return n % d !== 0n && n < 0n !== d < 0n ? q - 1n : q;
}

/** Divides whole numbers, settling a remainder by the mode. */
export function divide(n: bigint, d: bigint, mode: Rounding): bigint {
  if (d === 0n) throw new RangeError('division by zero');
  if (d < 0n) return divide(-n, -d, mode);
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const away = n < 0n ? q - 1n : q + 1n;
  if (mode === 'up') return away;
  if (mode === 'down') return q;
  const twice = 2n * abs(r);
  if (twice < d) return q;
  if (twice > d) return away;
  if (mode === 'half-up') return away;
  if (mode === 'half-down') return q;
  return q % 2n === 0n ? q : away;
}
const roundFrac = (f: Frac, mode: Rounding): bigint => divide(f.n, f.d, mode);

/** Splits an already-rounded total over exact shares: each gets its floor, the leftover goes to the largest remainders. */
function distribute(total: bigint, exacts: readonly Frac[]): bigint[] {
  const floors = exacts.map((e) => floorDiv(e.n, e.d));
  let left = total - floors.reduce((a, b) => a + b, 0n);
  const order = exacts
    .map((e, i) => ({ i, r: frac(e.n - floors[i]! * e.d, e.d) }))
    .sort((a, b) => {
      const x = a.r.n * b.r.d;
      const y = b.r.n * a.r.d;
      return x > y ? -1 : x < y ? 1 : a.i - b.i;
    });
  const out = [...floors];
  for (const { i } of order) {
    if (left <= 0n) break;
    out[i] = out[i]! + 1n;
    left -= 1n;
  }
  return out;
}

interface Rate {
  /** The percentage times 10,000. */
  n: bigint;
}
const rateFrac = (r: Rate): Frac => frac(r.n, 1_000_000n);

/** Reads "8.25" as an exact percentage, refusing anything that is not one to four decimals, 0 to 100. */
export function parseRate(text: string): Rate {
  const m = /^(\d{1,3})(?:\.(\d{1,4}))?$/.exec(typeof text === 'string' ? text.trim() : '');
  if (!m) throw new TaxError('bad-rate', `not a percentage: ${String(text)}`);
  const n = BigInt(`${m[1]}${(m[2] ?? '').padEnd(4, '0')}`);
  if (n > 1_000_000n) throw new TaxError('bad-rate', `a rate cannot pass 100 percent: ${text}`);
  return { n };
}

// ---------------------------------------------------------------------------------------------------------------

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const isDay = (s: unknown): s is string => {
  if (typeof s !== 'string' || !DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const COUNTRY = /^[A-Z]{2}$/;
const up = (s: string): string => s.trim().toUpperCase();
const postalKey = (s: string): string => s.replace(/[\s-]/g, '').toUpperCase();

function bad(message: string): never {
  throw new TaxError('bad-input', message);
}

function normalizePlace(p: Place, what: string): Place {
  if (!p || typeof p.country !== 'string' || !COUNTRY.test(up(p.country))) bad(`${what} needs a two-letter country code`);
  return {
    country: up(p.country),
    ...(p.region ? { region: up(p.region) } : {}),
    ...(p.city ? { city: p.city.trim().toLowerCase() } : {}),
    ...(p.postal ? { postal: postalKey(p.postal) } : {}),
  };
}

function specificity(w: Where): number {
  return 1 + (w.region ? 2 : 0) + (w.city ? 4 : 0) + (w.postalPrefix ? 8 : 0);
}

function matchesWhere(w: Where, p: Place): boolean {
  if (w.country !== p.country) return false;
  if (w.region && w.region !== p.region) return false;
  if (w.city && w.city !== p.city) return false;
  if (w.postalPrefix && !(p.postal ?? '').startsWith(w.postalPrefix)) return false;
  return true;
}

interface Stored {
  rule: TaxRule;
  where: Where;
  rate: Rate;
  categories: ReadonlySet<string> | undefined;
}

interface Component {
  rule: TaxRule;
  rate: Rate;
}

export interface Resolution {
  components: Component[];
  notes: string[];
}

export interface Query {
  day: string;
  category: string;
  place: Place;
  customer?: Customer;
}

interface StoredWithholding {
  rule: WithholdingRule;
  rate: Rate;
  treaty: Map<string, Rate>;
  noTaxId: Rate | undefined;
}

export class TaxEngine {
  private readonly rules: Stored[] = [];
  private readonly withholding: StoredWithholding[] = [];
  private readonly seller: Place;
  private readonly rounding: Rounding;
  private readonly roundAt: 'line' | 'invoice';
  private readonly sourcing: 'destination' | 'origin';
  private readonly registered: ReadonlySet<string> | undefined;
  private readonly zone: ReadonlySet<string>;
  private readonly refdata: RefData | undefined;
  private readonly categoryList: string;
  private readonly cash: number | undefined;

  constructor(o: Options) {
    this.seller = normalizePlace(o.seller, 'the seller');
    this.rounding = o.rounding ?? 'half-even';
    if (!ROUNDINGS.includes(this.rounding)) bad(`unknown rounding ${String(o.rounding)}`);
    this.roundAt = o.roundAt ?? 'line';
    if (this.roundAt !== 'line' && this.roundAt !== 'invoice') bad(`unknown roundAt ${String(o.roundAt)}`);
    this.sourcing = o.sourcing ?? 'destination';
    if (this.sourcing !== 'destination' && this.sourcing !== 'origin') bad(`unknown sourcing ${String(o.sourcing)}`);
    this.registered = o.registered ? new Set(o.registered.map(up)) : undefined;
    this.zone = new Set((o.reverseCharge ?? []).map(up));
    this.refdata = o.refdata;
    this.categoryList = o.categoryList ?? 'tax-category';
    if (o.cashIncrement !== undefined && (!Number.isInteger(o.cashIncrement) || o.cashIncrement < 2)) bad('cashIncrement is a whole number of minor units from 2');
    this.cash = o.cashIncrement;
  }

  addRule(rule: TaxRule): void {
    const problems: string[] = [];
    if (!rule || typeof rule.id !== 'string' || !rule.id.trim()) problems.push('a rule needs an id');
    if (!rule?.name) problems.push('a rule needs a name');
    if (!LEVELS.includes(rule?.level as Level)) problems.push(`level must be one of ${LEVELS.join(', ')}`);
    if (!rule?.where || !COUNTRY.test(up(rule.where.country ?? ''))) problems.push('where needs a two-letter country');
    if (!isDay(rule?.from)) problems.push('from must be a day like 2026-01-31');
    if (rule?.until !== undefined && (!isDay(rule.until) || rule.until <= (rule.from ?? ''))) problems.push('until must be a day after from');
    if (rule?.customer !== undefined && rule.customer !== 'b2b' && rule.customer !== 'b2c') problems.push('customer must be b2b or b2c');
    if (rule?.categories !== undefined && (!rule.categories.length || rule.categories.some((c) => typeof c !== 'string' || !c))) problems.push('categories, when given, are a list of names');
    let rate: Rate = { n: 0n };
    try {
      rate = parseRate(rule?.rate);
    } catch (e) {
      problems.push((e as Error).message);
    }
    if (rule?.exempt && rate.n !== 0n) problems.push('an exemption has a rate of 0');
    if (problems.length) throw new TaxError('bad-rule', `rule ${rule?.id ?? '?'} refused: ${problems.join('; ')}`);
    if (this.rules.some((s) => s.rule.id === rule.id)) throw new TaxError('duplicate-rule', `rule ${rule.id} is already defined`);
    const w = rule.where;
    const where: Where = {
      country: up(w.country),
      ...(w.region ? { region: up(w.region) } : {}),
      ...(w.city ? { city: w.city.trim().toLowerCase() } : {}),
      ...(w.postalPrefix ? { postalPrefix: postalKey(w.postalPrefix) } : {}),
    };
    this.rules.push({ rule: { ...rule }, where, rate, categories: rule.categories ? new Set(rule.categories) : undefined });
  }

  addRules(rules: readonly TaxRule[]): void {
    for (const r of rules) this.addRule(r);
  }

  addWithholding(rule: WithholdingRule): void {
    const problems: string[] = [];
    if (!rule?.id || !rule.category) problems.push('a withholding rule needs an id and a category');
    if (!isDay(rule?.from)) problems.push('from must be a day');
    if (rule?.until !== undefined && (!isDay(rule.until) || rule.until <= (rule.from ?? ''))) problems.push('until must be a day after from');
    const treaty = new Map<string, Rate>();
    let rate: Rate = { n: 0n };
    let noTaxId: Rate | undefined;
    try {
      rate = parseRate(rule?.rate);
      for (const [c, r] of Object.entries(rule?.treaty ?? {})) {
        if (!COUNTRY.test(c)) throw new TaxError('bad-rule', `treaty country ${c} is not a two-letter code`);
        treaty.set(c, parseRate(r));
      }
      if (rule?.noTaxIdRate !== undefined) noTaxId = parseRate(rule.noTaxIdRate);
    } catch (e) {
      problems.push((e as Error).message);
    }
    if (rule?.threshold !== undefined && !/^\d+(\.\d+)?$/.test(rule.threshold)) problems.push('threshold is a decimal amount');
    if (problems.length) throw new TaxError('bad-rule', `withholding rule ${rule?.id ?? '?'} refused: ${problems.join('; ')}`);
    if (this.withholding.some((s) => s.rule.id === rule.id)) throw new TaxError('duplicate-rule', `withholding rule ${rule.id} is already defined`);
    this.withholding.push({ rule: { ...rule }, rate, treaty, noTaxId });
  }

  private category(code: string, day: string): string {
    if (typeof code !== 'string' || !code) bad('a line needs a category');
    if (!this.refdata) return code;
    const current = this.refdata.current(this.categoryList, code, day);
    if (current === undefined) throw new TaxError('unknown-category', `category ${code} is not in use on ${day}`);
    return current;
  }

  /** Which taxes apply to one product in one place on one day, and why none do when none do. */
  resolve(q: Query): Resolution {
    if (!isDay(q.day)) bad('day must be like 2026-01-31');
    const category = this.category(q.category, q.day);
    const place = normalizePlace(q.place, 'the place');
    const customer = q.customer ?? { type: 'b2c' };
    const notes: string[] = [];

    if (customer.exempt === 'all') return { components: [], notes: ['customer-exempt'] };

    if (customer.type === 'b2b' && customer.taxId && this.zone.has(this.seller.country) && this.zone.has(place.country) && this.seller.country !== place.country) {
      return { components: [], notes: ['reverse-charge'] };
    }

    if (this.registered) {
      const key = place.region ? `${place.country}-${place.region}` : place.country;
      if (!this.registered.has(place.country) && !this.registered.has(key)) return { components: [], notes: ['not-registered'] };
    }

    const taxed = this.sourcing === 'origin' && this.seller.country === place.country ? this.seller : place;
    const live = this.rules.filter(({ rule, where, categories }) => {
      if (rule.from > q.day || (rule.until !== undefined && q.day >= rule.until)) return false;
      if (rule.customer && rule.customer !== customer.type) return false;
      if (categories && !categories.has(category)) return false;
      return matchesWhere(where, taxed);
    });

    const components: Component[] = [];
    for (const level of LEVELS) {
      const here = live.filter((s) => s.rule.level === level);
      if (!here.length) continue;
      if (Array.isArray(customer.exempt) && customer.exempt.includes(level)) {
        notes.push(`customer-exempt:${level}`);
        continue;
      }
      const rank = (s: Stored): number[] => [s.categories ? 1 : 0, s.rule.customer ? 1 : 0, specificity(s.where), s.rule.priority ?? 0];
      const cmp = (a: Stored, b: Stored): number => {
        const x = rank(a);
        const y = rank(b);
        for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i]! - x[i]!;
        return 0;
      };
      const ordered = [...here].sort(cmp);
      const best = ordered[0]!;
      const tie = ordered.filter((s) => cmp(s, best) === 0);
      if (tie.length > 1) {
        throw new TaxError('ambiguous', `rules ${tie.map((s) => s.rule.id).sort().join(' and ')} are equally specific for ${category} in ${place.country} on ${q.day}; give one a priority or an end day`);
      }
      components.push({ rule: best.rule, rate: best.rate });
      if (best.rule.exempt) notes.push(`exempt:${best.rule.id}`);
    }
    if (!components.length) notes.push('no-rule');
    return { components, notes };
  }

  /** Works out the tax on a sale. */
  calculate(sale: Sale): Calculation {
    if (!isDay(sale.day)) bad('day must be like 2026-01-31');
    if (EXPONENT[sale.currency] === undefined) bad(`unknown currency ${String(sale.currency)}`);
    if (sale.pricing !== 'exclusive' && sale.pricing !== 'inclusive') bad('pricing is exclusive or inclusive');
    const roundAt = sale.roundAt ?? this.roundAt;
    if (roundAt !== 'line' && roundAt !== 'invoice') bad('roundAt is line or invoice');
    const seen = new Set<string>();
    for (const l of sale.lines) {
      if (!l.id || seen.has(l.id)) bad(`line ids must be given and unique: ${String(l.id)}`);
      seen.add(l.id);
      if (l.amount.currency !== sale.currency) throw new TaxError('currency-mismatch', `line ${l.id} is in ${l.amount.currency}, the sale in ${sale.currency}`);
    }
    const mode = this.rounding;
    const cur = sale.currency;
    const m = (minor: bigint): Money => money(minor, cur);

    // Exact amounts for every line.
    interface Exact {
      line: LineInput;
      res: Resolution;
      net: Frac;
      bases: Frac[];
      taxes: Frac[];
      sig: string;
    }
    const exacts: Exact[] = sale.lines.map((line) => {
      const res = this.resolve({ day: sale.day, category: line.category, place: sale.place, ...(sale.customer ? { customer: sale.customer } : {}) });
      let mult = frac(1n);
      for (const c of res.components) {
        const r = rateFrac(c.rate);
        mult = fadd(mult, c.rule.compound ? fmul(r, mult) : r);
      }
      const amount = frac(line.amount.minor);
      const net = sale.pricing === 'exclusive' ? amount : fdiv(amount, mult);
      let prior = frac(0n);
      const bases: Frac[] = [];
      const taxes: Frac[] = [];
      for (const c of res.components) {
        const base = c.rule.compound ? fadd(net, prior) : net;
        const t = fmul(base, rateFrac(c.rate));
        prior = fadd(prior, t);
        bases.push(base);
        taxes.push(t);
      }
      return { line, res, net, bases, taxes, sig: res.components.map((c) => c.rule.id).join('|') };
    });

    // Round: each amount alone, or each group's total once and shared back by largest remainder.
    const nets: bigint[] = new Array<bigint>(exacts.length);
    const taxMinor: bigint[][] = exacts.map((e) => new Array<bigint>(e.taxes.length));
    const baseMinor: bigint[][] = exacts.map((e) => e.bases.map((b) => roundFrac(b, mode)));
    if (roundAt === 'line') {
      exacts.forEach((e, i) => {
        nets[i] = sale.pricing === 'exclusive' ? e.line.amount.minor : roundFrac(e.net, mode);
        e.taxes.forEach((t, j) => (taxMinor[i]![j] = roundFrac(t, mode)));
      });
    } else {
      const groups = new Map<string, number[]>();
      exacts.forEach((e, i) => groups.set(e.sig, [...(groups.get(e.sig) ?? []), i]));
      for (const idx of groups.values()) {
        const sumOf = (xs: Frac[]): Frac => xs.reduce(fadd, frac(0n));
        if (sale.pricing === 'exclusive') idx.forEach((i) => (nets[i] = exacts[i]!.line.amount.minor));
        else {
          const part = distribute(roundFrac(sumOf(idx.map((i) => exacts[i]!.net)), mode), idx.map((i) => exacts[i]!.net));
          idx.forEach((i, k) => (nets[i] = part[k]!));
        }
        const width = exacts[idx[0]!]!.taxes.length;
        for (let j = 0; j < width; j++) {
          const shares = idx.map((i) => exacts[i]!.taxes[j]!);
          const part = distribute(roundFrac(sumOf(shares), mode), shares);
          idx.forEach((i, k) => (taxMinor[i]![j] = part[k]!));
        }
      }
    }

    // A tax-inclusive line must add back to what was charged: the leftover goes to its largest tax.
    exacts.forEach((e, i) => {
      if (sale.pricing !== 'inclusive') return;
      const gross = e.line.amount.minor;
      const taxes = taxMinor[i]!;
      if (!taxes.length) {
        nets[i] = gross;
        return;
      }
      const left = gross - nets[i]! - taxes.reduce((a, b) => a + b, 0n);
      if (left === 0n) return;
      let at = 0;
      taxes.forEach((t, j) => {
        if (abs(t) > abs(taxes[at]!)) at = j;
      });
      taxes[at] = taxes[at]! + left;
    });

    const lines: TaxedLine[] = exacts.map((e, i) => {
      const taxes: LineTax[] = e.res.components.map((c, j) => ({
        rule: c.rule.id,
        name: c.rule.name,
        level: c.rule.level,
        rate: c.rule.rate,
        base: m(baseMinor[i]![j]!),
        amount: m(taxMinor[i]![j]!),
      }));
      const tax = taxMinor[i]!.reduce((a, b) => a + b, 0n);
      return {
        id: e.line.id,
        category: e.line.category,
        net: m(nets[i]!),
        tax: m(tax),
        gross: m(nets[i]! + tax),
        taxes,
        notes: e.res.notes,
      };
    });

    const byRule = new Map<string, RuleTotal>();
    for (const l of lines)
      for (const t of l.taxes) {
        const prev = byRule.get(t.rule);
        byRule.set(t.rule, prev ? { ...prev, base: m(prev.base.minor + t.base.minor), amount: m(prev.amount.minor + t.amount.minor) } : { ...t });
      }
    const net = lines.reduce((a, l) => a + l.net.minor, 0n);
    const tax = lines.reduce((a, l) => a + l.tax.minor, 0n);
    const gross = net + tax;
    let total = gross;
    if (this.cash) {
      const inc = BigInt(this.cash);
      total = divide(gross, inc, mode) * inc;
    }
    const notes = [...new Set(lines.flatMap((l) => l.notes))];
    return {
      currency: cur,
      pricing: sale.pricing,
      roundAt,
      lines,
      net: m(net),
      tax: m(tax),
      gross: m(gross),
      byRule: [...byRule.values()].sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || a.rule.localeCompare(b.rule)),
      rounding: m(total - gross),
      total: m(total),
      notes,
    };
  }

  /** The same sale turned round, for a credit note: every amount negated. */
  credit(c: Calculation): Calculation {
    const neg = (x: Money): Money => ({ minor: -x.minor, currency: x.currency });
    return {
      ...c,
      lines: c.lines.map((l) => ({ ...l, net: neg(l.net), tax: neg(l.tax), gross: neg(l.gross), taxes: l.taxes.map((t) => ({ ...t, base: neg(t.base), amount: neg(t.amount) })) })),
      net: neg(c.net),
      tax: neg(c.tax),
      gross: neg(c.gross),
      byRule: c.byRule.map((t) => ({ ...t, base: neg(t.base), amount: neg(t.amount) })),
      rounding: neg(c.rounding),
      total: neg(c.total),
    };
  }

  /** What to withhold from a payment to a payee, and what is left to pay. */
  withhold(q: { day: string; category: string; payment: Money; payee: Payee; paidThisYear?: Money }): Withholding {
    if (!isDay(q.day)) bad('day must be like 2026-01-31');
    const country = up(q.payee?.country ?? '');
    if (!COUNTRY.test(country)) bad('the payee needs a two-letter country code');
    const cur = q.payment.currency;
    if (q.paidThisYear && q.paidThisYear.currency !== cur) throw new TaxError('currency-mismatch', 'paid-this-year is in another currency');
    if (q.payment.minor < 0n) bad('a payment is not negative');
    const found = this.withholding.filter(({ rule }) => rule.category === q.category && rule.from <= q.day && (rule.until === undefined || q.day < rule.until) && (!rule.payee || rule.payee.includes(q.payee.kind)));
    if (found.length > 1) throw new TaxError('ambiguous', `withholding rules ${found.map((f) => f.rule.id).join(' and ')} both apply to ${q.category} on ${q.day}`);
    const s = found[0];
    if (!s) throw new TaxError('no-withholding-rule', `no withholding rule for ${q.category} on ${q.day}`);
    const notes: string[] = [];
    let rate = s.treaty.get(country) ?? s.rate;
    if (s.treaty.has(country)) notes.push(`treaty:${country}`);
    if (!q.payee.taxId && s.noTaxId && s.noTaxId.n > rate.n) {
      rate = s.noTaxId;
      notes.push('no-tax-id');
    }
    const pay = q.payment.minor;
    let basis = pay;
    if (s.rule.threshold !== undefined) {
      const [whole = '0', part = ''] = s.rule.threshold.split('.');
      const e = EXPONENT[cur];
      if (e === undefined) bad(`unknown currency ${cur}`);
      const limit = BigInt(whole + part.padEnd(e, '0').slice(0, e));
      if ((s.rule.thresholdBasis ?? 'payment') === 'payment') {
        if (pay < limit) {
          basis = 0n;
          notes.push('below-threshold');
        }
      } else {
        const before = q.paidThisYear?.minor ?? 0n;
        const over = before + pay - (before > limit ? before : limit);
        basis = over < 0n ? 0n : over > pay ? pay : over;
        if (basis < pay) notes.push(basis === 0n ? 'below-threshold' : 'part-above-threshold');
      }
    }
    const withheld = divide(basis * rate.n, 1_000_000n, this.rounding);
    return { rule: s.rule.id, rate: formatRate(rate), basis: money(basis, cur), withheld: money(withheld, cur), payable: money(pay - withheld, cur), notes };
  }

  /** The gross payment that leaves a payee the wanted net after withholding, for contracts that promise a net. */
  grossUp(q: { day: string; category: string; net: Money; payee: Payee }): Money {
    const probe = this.withhold({ day: q.day, category: q.category, payment: q.net, payee: q.payee });
    const rate = parseRate(probe.rate);
    if (rate.n >= 1_000_000n) throw new TaxError('bad-rate', 'a rate of 100 percent leaves nothing to gross up');
    return money(divide(q.net.minor * 1_000_000n, 1_000_000n - rate.n, this.rounding), q.net.currency);
  }
}

function formatRate(r: Rate): string {
  const s = r.n.toString().padStart(5, '0');
  const frac = s.slice(-4).replace(/0+$/, '');
  return frac ? `${s.slice(0, -4)}.${frac}` : s.slice(0, -4);
}
