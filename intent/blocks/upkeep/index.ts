/**
 * Upkeep: the things that rot if nobody watches. Dependencies are compared with what is current and with known
 * advisories, and each gets a verdict (fine, update, urgent) with the reason. Anything that expires (certificates,
 * domains, tokens, contracts, keys) is listed with how long it has and warned about at set points. Scanner output
 * in SARIF is turned into findings with a fingerprint, so a finding marked as accepted stays accepted run to run
 * and only new ones need a person.
 */
import { createHash } from 'node:crypto';

/** Compares dotted versions numerically; prerelease sorts before its release. */
export function compare(a: string, b: string): number {
  const [ma, pa] = a.replace(/^v/, '').split('-');
  const [mb, pb] = b.replace(/^v/, '').split('-');
  const xa = ma!.split('.').map(Number);
  const xb = mb!.split('.').map(Number);
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const d = (xa[i] ?? 0) - (xb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (pa && !pb) return -1;
  if (!pa && pb) return 1;
  return pa && pb ? pa.localeCompare(pb) : 0;
}

export interface Advisory {
  readonly package: string;
  readonly id: string;
  readonly severity: 'low' | 'moderate' | 'high' | 'critical';
  /** Versions below this are affected. */
  readonly fixedIn: string;
  readonly introducedIn?: string;
}

export interface Dep {
  readonly name: string;
  readonly version: string;
  readonly latest: string;
  readonly released?: string;
}

export function review(deps: readonly Dep[], advisories: readonly Advisory[], o: { today: string; staleMajor?: boolean } = { today: '' }): { name: string; verdict: 'fine' | 'update' | 'urgent'; because: string }[] {
  return deps
    .map((d) => {
      const hits = advisories.filter((a) => a.package === d.name && compare(d.version, a.fixedIn) < 0 && (!a.introducedIn || compare(d.version, a.introducedIn) >= 0));
      const worst = hits.find((h) => h.severity === 'critical' || h.severity === 'high');
      if (worst) return { name: d.name, verdict: 'urgent' as const, because: `${worst.id} (${worst.severity}) is fixed in ${worst.fixedIn}` };
      if (hits.length) return { name: d.name, verdict: 'update' as const, because: `${hits.map((h) => h.id).join(', ')} fixed in ${hits[0]!.fixedIn}` };
      const behindMajor = Number(d.latest.split('.')[0]) > Number(d.version.split('.')[0]);
      if (behindMajor && o.staleMajor !== false) return { name: d.name, verdict: 'update' as const, because: `a major version behind (${d.version} → ${d.latest})` };
      return { name: d.name, verdict: 'fine' as const, because: compare(d.version, d.latest) < 0 ? `minor update to ${d.latest} available` : 'current' };
    })
    .sort((a, b) => ['urgent', 'update', 'fine'].indexOf(a.verdict) - ['urgent', 'update', 'fine'].indexOf(b.verdict) || a.name.localeCompare(b.name));
}

export interface Expiring {
  readonly what: string;
  readonly kind: 'certificate' | 'domain' | 'token' | 'key' | 'contract' | 'other';
  readonly expires: string;
  readonly owner: string;
}

const DAY = 86_400_000;

/** Days left and whether to warn now: at 30, 14, 7, 3 and 1 day(s), and every day once expired. */
export function expiry(items: readonly Expiring[], today: string, warnAt: readonly number[] = [30, 14, 7, 3, 1]): { what: string; owner: string; daysLeft: number; warn: boolean; state: 'ok' | 'soon' | 'expired' }[] {
  const t = Date.parse(`${today}T00:00:00Z`);
  return items
    .map((i) => {
      const daysLeft = Math.ceil((Date.parse(`${i.expires}T00:00:00Z`) - t) / DAY);
      const state: 'ok' | 'soon' | 'expired' = daysLeft <= 0 ? 'expired' : daysLeft <= Math.max(...warnAt) ? 'soon' : 'ok';
      return { what: i.what, owner: i.owner, daysLeft, warn: daysLeft <= 0 || warnAt.includes(daysLeft), state };
    })
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

export interface Finding {
  readonly fingerprint: string;
  readonly rule: string;
  readonly level: string;
  readonly file: string;
  readonly line: number;
  readonly message: string;
  readonly tool: string;
}

/** Findings from a SARIF 2.1 log; the fingerprint ignores line numbers so moving code does not reopen a finding. */
export function sarif(log: unknown): Finding[] {
  const runs = (log as { runs?: unknown[] }).runs ?? [];
  const out: Finding[] = [];
  for (const run of runs as { tool?: { driver?: { name?: string } }; results?: unknown[] }[]) {
    const tool = run.tool?.driver?.name ?? 'unknown';
    for (const r of (run.results ?? []) as { ruleId?: string; level?: string; message?: { text?: string }; locations?: { physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number; snippet?: { text?: string } } } }[] }[]) {
      const loc = r.locations?.[0]?.physicalLocation;
      const file = loc?.artifactLocation?.uri ?? '';
      const snippet = (loc?.region?.snippet?.text ?? '').trim();
      const rule = r.ruleId ?? 'unknown';
      out.push({ fingerprint: createHash('sha256').update(`${tool}\n${rule}\n${file}\n${snippet || r.message?.text || ''}`).digest('hex').slice(0, 16), rule, level: r.level ?? 'warning', file, line: loc?.region?.startLine ?? 0, message: r.message?.text ?? '', tool });
    }
  }
  return out;
}

/** Splits findings into new since the last run, still open, accepted (with the reason a person gave), and fixed. */
export function triage(now: readonly Finding[], before: readonly Finding[], accepted: Readonly<Record<string, string>>): { new: Finding[]; open: Finding[]; accepted: (Finding & { why: string })[]; fixed: Finding[] } {
  const was = new Set(before.map((f) => f.fingerprint));
  const is = new Set(now.map((f) => f.fingerprint));
  return {
    new: now.filter((f) => !accepted[f.fingerprint] && !was.has(f.fingerprint)),
    open: now.filter((f) => !accepted[f.fingerprint] && was.has(f.fingerprint)),
    accepted: now.filter((f) => accepted[f.fingerprint]).map((f) => ({ ...f, why: accepted[f.fingerprint]! })),
    fixed: before.filter((f) => !is.has(f.fingerprint)),
  };
}
