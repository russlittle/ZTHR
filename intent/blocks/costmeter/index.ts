/**
 * The cost meter: usage is recorded against meters (requests, storage, model tokens, emails), priced from a rate
 * card, and attributed to a feature and a tenant, so a bill can be explained line by line. Budgets warn at set
 * fractions and can stop a feature from spending further; a month-end forecast from the pace so far says early when
 * a budget will be missed.
 */

export interface Rate {
  readonly meter: string;
  readonly unit: string;
  /** Price per unit, in the smallest currency unit times 1e6 (micro-cents), so tiny rates stay exact. */
  readonly microCentsPerUnit: number;
  /** Units free each month. */
  readonly free?: number;
}

export interface Use {
  readonly meter: string;
  readonly units: number;
  readonly feature: string;
  readonly tenant: string;
  readonly at: string;
}

export interface Budget {
  readonly name: string;
  readonly cents: number;
  readonly feature?: string;
  readonly tenant?: string;
  /** Fractions at which to warn. */
  readonly warnAt?: readonly number[];
  /** Whether going over stops further spending for its scope. */
  readonly hard?: boolean;
}

export class Meter {
  private readonly rates = new Map<string, Rate>();
  private readonly uses: Use[] = [];
  private readonly warned = new Set<string>();
  private readonly budgets: Budget[];
  private readonly onWarn: (b: Budget, fraction: number, cents: number) => void;

  constructor(rates: readonly Rate[], budgets: readonly Budget[] = [], onWarn: (b: Budget, fraction: number, cents: number) => void = () => {}) {
    for (const r of rates) this.rates.set(r.meter, r);
    this.budgets = [...budgets];
    this.onWarn = onWarn;
  }

  /** Whether this feature and tenant may spend: false once a hard budget covering them is spent. */
  allowed(feature: string, tenant: string, month: string): boolean {
    return !this.budgets.some((b) => b.hard && covers(b, feature, tenant) && this.spent(month, b) >= b.cents);
  }

  record(u: Use): void {
    if (!this.rates.has(u.meter)) throw new Error(`no rate for ${u.meter}`);
    if (!(u.units >= 0)) throw new Error('usage cannot be negative');
    this.uses.push(u);
    const month = u.at.slice(0, 7);
    for (const b of this.budgets) {
      if (!covers(b, u.feature, u.tenant)) continue;
      const cents = this.spent(month, b);
      for (const f of b.warnAt ?? [0.5, 0.8, 1]) {
        const key = `${b.name}\n${month}\n${f}`;
        if (cents >= b.cents * f && !this.warned.has(key)) {
          this.warned.add(key);
          this.onWarn(b, f, cents);
        }
      }
    }
  }

  /** Cents for a month, optionally for one feature or tenant, after free units. */
  spent(month: string, scope: { feature?: string; tenant?: string } = {}): number {
    return this.bill(month, scope).reduce((s, l) => s + l.cents, 0);
  }

  /** The bill, one line per meter, feature and tenant. Free units are shared across the whole month. */
  bill(month: string, scope: { feature?: string; tenant?: string } = {}): { meter: string; feature: string; tenant: string; units: number; cents: number }[] {
    const inMonth = this.uses.filter((u) => u.at.startsWith(month));
    const out = new Map<string, { meter: string; feature: string; tenant: string; units: number; cents: number }>();
    const freeLeft = new Map<string, number>();
    for (const u of [...inMonth].sort((a, b) => a.at.localeCompare(b.at))) {
      const r = this.rates.get(u.meter)!;
      const left = freeLeft.get(u.meter) ?? r.free ?? 0;
      const free = Math.min(left, u.units);
      freeLeft.set(u.meter, left - free);
      if (scope.feature && u.feature !== scope.feature) continue;
      if (scope.tenant && u.tenant !== scope.tenant) continue;
      const k = `${u.meter}\n${u.feature}\n${u.tenant}`;
      const line = out.get(k) ?? { meter: u.meter, feature: u.feature, tenant: u.tenant, units: 0, cents: 0 };
      line.units += u.units;
      line.cents += ((u.units - free) * r.microCentsPerUnit) / 1e6;
      out.set(k, line);
    }
    return [...out.values()].map((l) => ({ ...l, cents: Math.round(l.cents * 100) / 100 })).sort((a, b) => b.cents - a.cents);
  }

  /** Straight-line forecast for the month from the pace so far. */
  forecast(month: string, today: Date, scope: { feature?: string; tenant?: string } = {}): { cents: number; over: Budget[] } {
    const [y, m] = month.split('-').map(Number);
    const days = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
    const start = Date.UTC(y!, m! - 1, 1);
    const elapsed = Math.max(1 / 24, (today.getTime() - start) / 86_400_000);
    const cents = Math.round((this.spent(month, scope) / Math.min(elapsed, days)) * days);
    return { cents, over: this.budgets.filter((b) => (b.feature ?? undefined) === scope.feature && (b.tenant ?? undefined) === scope.tenant && cents > b.cents) };
  }
}

const covers = (b: Budget, feature: string, tenant: string) => (!b.feature || b.feature === feature) && (!b.tenant || b.tenant === tenant);
