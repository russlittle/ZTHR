/**
 * Expiry watch. Everything with an expiry date (certificates, domains, keys, tokens, contracts, the security
 * contact file) and which alert each needs today. Warnings start well before; past due is critical; an item with
 * no owner is a finding of its own.
 */

export interface Expiring {
  readonly what: string;
  readonly kind: 'certificate' | 'domain' | 'key' | 'token' | 'contract' | 'security contact' | 'other';
  readonly expiresAt: number;
  readonly owner?: string;
}

export interface Alert {
  readonly what: string;
  readonly level: 'critical' | 'warn' | 'notice';
  readonly days: number;
  readonly text: string;
}

const DAY = 86_400_000;

/** Days before expiry each level starts. A domain or certificate gets longer notice than a token. */
export const NOTICE: Readonly<Record<Expiring['kind'], { warn: number; notice: number }>> = {
  certificate: { warn: 14, notice: 30 },
  domain: { warn: 30, notice: 60 },
  key: { warn: 14, notice: 45 },
  token: { warn: 3, notice: 10 },
  contract: { warn: 30, notice: 90 },
  'security contact': { warn: 30, notice: 60 },
  other: { warn: 14, notice: 30 },
};

export function watch(items: readonly Expiring[], now: number): Alert[] {
  const out: Alert[] = [];
  for (const x of items) {
    const days = Math.floor((x.expiresAt - now) / DAY);
    const n = NOTICE[x.kind];
    const level = days < 0 ? 'critical' : days <= n.warn ? 'warn' : days <= n.notice ? 'notice' : null;
    if (level) out.push({ what: x.what, level, days, text: days < 0 ? `${x.what} expired ${-days} day${days === -1 ? '' : 's'} ago` : `${x.what} expires in ${days} day${days === 1 ? '' : 's'}` });
    if (!x.owner?.trim()) out.push({ what: x.what, level: 'notice', days, text: `${x.what} has no owner to renew it` });
  }
  const rank = { critical: 0, warn: 1, notice: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || a.days - b.days);
}
