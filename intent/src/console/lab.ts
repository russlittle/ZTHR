/**
 * Metrology: the definition of every measure QA uses, each traced to a reference standard; the certificate of every
 * gauge (capability, repeatability, reproducibility, interval); control charts on the factory's own process; and the
 * internal audit of the factory's claims. QA may use only gauges metrology has certified, so a certificate that is
 * not there is reported as not there.
 */
import catalogData from '../../catalog/catalog.json' with { type: 'json' };
import { lamp } from './missionViews.ts';
import type { BlockScore, Night } from './night.ts';
import { esc } from './views.ts';

/** How far a thing stands, said plainly: what is built and proven, what is partly there, what is missing. */
export type Standing = 'built and proven' | 'partial' | 'missing';
const LIGHT: Record<Standing, 'pass' | 'waiting' | 'fail'> = { 'built and proven': 'pass', partial: 'waiting', missing: 'fail' };
export const standingLamp = (s: Standing) => lamp(LIGHT[s], s);

export const BLOCKS: readonly string[] = (catalogData as { blocks: { name: string; home?: string }[] }).blocks.filter((b) => b.home?.startsWith('intent/blocks')).map((b) => b.name);

/** The references every measure is traced to. A measure with no reference is an opinion. */
export const REFERENCES: readonly { id: string; name: string; traces: string; standing: Standing; evidence: string }[] = [
  { id: 'rfc-vectors', name: 'Published test vectors (RFCs and standards bodies)', traces: 'Protocol and format blocks: what a correct answer is, from the specification’s own examples', standing: 'partial', evidence: 'Some blocks’ tests use their RFC’s vectors (tabular, sessions, validate); no catalogue says which measure traces to which vector' },
  { id: 'nextcloud', name: 'A recording of a real Nextcloud', traces: 'The Files oracle: every request a client makes, answered by the system Files replaces', standing: 'missing', evidence: 'The oracle can check a candidate against a recorded corpus; no recording of a real Nextcloud has been made yet' },
  { id: 'heldout', name: 'Sealed held-out phrasing sets', traces: 'Journeys and readings: phrasings the factory never sees, so a pass is not memorised', standing: 'partial', evidence: 'Held out in control/heldout/, a person-only path; sealed by convention, with no hash a gate checks' },
];

/** What QA measures, defined once here: what it is, its unit, and how a gauge for it is certified. */
export const MEASURES: readonly { id: string; name: string; defined: string; unit: string; reference: string }[] = [
  { id: 'capability', name: 'Gauge capability', defined: 'Of the planted defects (mutants) in a block, the share its tests reject', unit: '% of mutants killed', reference: 'The block’s own code, mutated' },
  { id: 'repeatability', name: 'Repeatability', defined: 'The share of tests that give a different verdict when run again, unchanged, on the same machine (the flake rate)', unit: '% of tests', reference: 'AIAG Measurement Systems Analysis, gauge R&R' },
  { id: 'reproducibility', name: 'Reproducibility', defined: 'Whether the same commit gives the same verdict on every test in a fresh clone and on CI', unit: 'tests that disagree', reference: 'AIAG Measurement Systems Analysis, gauge R&R' },
  { id: 'oracle-msa', name: 'Oracle discrimination', defined: 'Of the differences planted in a recorded corpus, the share the oracle reports; of the rightful differences (etags, ids, dates), the share it masks', unit: '% detected, % masked', reference: 'The recording of the replaced system' },
  { id: 'journey', name: 'Journey pass', defined: 'A person’s goal reached, in every mode and channel the journey names, with nothing forbidden happening', unit: 'pass, fail or not measured', reference: 'The signed intent and the held-out phrasings' },
];

export type CertState = 'certified' | 'capability only' | 'not certified' | 'not measured';

export interface Certificate {
  readonly block: string;
  readonly issued: string | null;
  readonly capability: number | null;
  readonly survivors: number;
  readonly equivalents: number;
  readonly repeatability: number | null;
  readonly reproducible: boolean | null;
  readonly state: CertState;
  readonly why: string;
}

/** A gauge is certified when it rejects every planted defect it can tell apart and gives the same verdict every time and everywhere. */
export function certificate(block: string, s: BlockScore | undefined, rr: { repeatability: number | null; reproducible: boolean | null } = { repeatability: null, reproducible: null }): Certificate {
  const base = { block, issued: s?.at || null, capability: s?.score ?? null, survivors: s?.survived ?? 0, equivalents: s?.equivalent ?? 0, ...rr };
  if (!s || s.score === null) return { ...base, state: 'not measured', why: 'no calibration run has reported on this block' };
  const left = s.survived - s.equivalent;
  if (left > 0) return { ...base, state: 'not certified', why: `${left} planted defect${left === 1 ? '' : 's'} not rejected, and not ruled equivalent` };
  if (rr.repeatability === null || rr.reproducible === null) return { ...base, state: 'capability only', why: 'every planted defect rejected; repeatability and reproducibility not measured yet' };
  if (rr.repeatability > 0 || !rr.reproducible) return { ...base, state: 'not certified', why: rr.repeatability > 0 ? 'some tests change verdict when run again' : 'a fresh clone and CI disagree' };
  return { ...base, state: 'certified', why: 'capable, repeatable and reproducible' };
}

export const certificates = (n: Night, blocks: readonly string[] = BLOCKS): Certificate[] => blocks.map((b) => certificate(b, n.scores.find((s) => s.block === b)));

// ---------------------------------------------------------------- control charts

/**
 * Shewhart individuals chart: the centre line is the mean; sigma is estimated from the average moving range over d2
 * (1.128 for ranges of two). Limits need enough points to mean anything: the AIAG SPC manual asks for 25.
 */
export const MIN_POINTS = 25;

export function limits(xs: readonly number[]): { centre: number; sigma: number; lcl: number; ucl: number } | null {
  if (xs.length < 2) return null;
  const centre = xs.reduce((a, x) => a + x, 0) / xs.length;
  const mr = xs.slice(1).reduce((a, x, i) => a + Math.abs(x - xs[i]!), 0) / (xs.length - 1);
  const sigma = mr / 1.128;
  return { centre, sigma, lcl: centre - 3 * sigma, ucl: centre + 3 * sigma };
}

export interface Signal {
  readonly rule: 1 | 2 | 3 | 4;
  readonly at: number;
  readonly says: string;
}

/** The Western Electric rules: each signal is a point at which the process has drifted, and each raises a tag. */
export function westernElectric(xs: readonly number[], l: { centre: number; sigma: number }): Signal[] {
  const out: Signal[] = [];
  const z = xs.map((x) => (l.sigma ? (x - l.centre) / l.sigma : 0));
  const sameSide = (w: readonly number[], k: number, n: number) => [1, -1].some((sg) => w.filter((v) => v * sg > k).length >= n);
  z.forEach((v, i) => {
    if (Math.abs(v) > 3) out.push({ rule: 1, at: i, says: 'one point beyond three sigma' });
    else if (i >= 2 && sameSide(z.slice(i - 2, i + 1), 2, 2) && Math.abs(v) > 2) out.push({ rule: 2, at: i, says: 'two of three beyond two sigma, on one side' });
    else if (i >= 4 && sameSide(z.slice(i - 4, i + 1), 1, 4) && Math.abs(v) > 1) out.push({ rule: 3, at: i, says: 'four of five beyond one sigma, on one side' });
    else if (i >= 7 && sameSide(z.slice(i - 7, i + 1), 0, 8)) out.push({ rule: 4, at: i, says: 'eight in a row on one side of the centre' });
  });
  return out;
}

/** The factory's own process, charted: where each series comes from, and how many points it has. */
export function charts(n: Night): { metric: string; source: string; points: number }[] {
  const settled = n.tasks.filter((t) => t.state === 'accepted' || t.state === 'rejected');
  return [
    { metric: 'Mutation score, per block', source: 'calibration certificates, one point a run', points: n.scores.length ? 1 : 0 },
    { metric: 'Flake rate', source: 'repeat runs of the suite on an unchanged commit', points: 0 },
    { metric: 'Test time', source: 'each required-check run', points: 0 },
    { metric: 'Cost per accepted change', source: 'the crew’s settled tasks', points: settled.filter((t) => t.usd !== undefined).length },
  ];
}

// ---------------------------------------------------------------- the internal audit

/** The audit of the factory's own claims against their evidence, as recorded on the day it was run. */
export const CLAIMS_AUDIT = {
  checked: '2026-11-27',
  claims: 73,
  proven: 10,
  partial: 43,
  unproven: 20,
  findings: [
    'Review by two other model families is designed but not running',
    'Branches are not protected: the record could be bypassed by a direct push',
    'There is no recording of a real Nextcloud for the Files oracle',
    'Held-out sets are sealed by convention, not by a hash a gate checks',
    'The papers’ figures are typed, not generated',
    'Deploys name a movable image tag, not a digest',
    'The reference build was red for 13 days while commits continued',
  ],
} as const;

// ---------------------------------------------------------------- the panel

const CERT_LIGHT: Record<CertState, 'pass' | 'fail' | 'waiting' | 'not measured'> = { certified: 'pass', 'not certified': 'fail', 'capability only': 'waiting', 'not measured': 'not measured' };

export function labHeadline(n: Night, blocks: readonly string[] = BLOCKS): string {
  const cs = certificates(n, blocks);
  const count = (s: CertState) => cs.filter((c) => c.state === s).length;
  const measured = cs.length - count('not measured');
  return `<section class="sheet measure" aria-label="Gauges certified"><div class="headline"><p class="eyebrowless">Gauges QA may use</p><p class="big"><span class="num">${count('certified')}</span> of <span class="num">${cs.length}</span> blocks certified</p><p class="verdict v-${count('certified') === cs.length ? 'ok' : count('not certified') ? 'bad' : 'unk'}">${measured ? `${measured} calibrated: ${count('not certified')} not certified, ${count('capability only')} capable but not yet checked for repeatability and reproducibility` : 'No block has been calibrated yet'} · ${count('not measured')} not measured</p><div class="mbar" role="img" aria-label="${count('certified')} certified, ${count('not certified')} not certified, ${count('capability only')} capability only, ${count('not measured')} not measured">${(['certified', 'not certified', 'capability only', 'not measured'] as const).map((s) => (count(s) ? `<span class="seg ${s === 'certified' ? 'pass' : s === 'not certified' ? 'fail' : 'unk'}" style="width:${(100 * count(s)) / cs.length}%"></span>` : '')).join('')}</div><p class="muted small">A gauge is certified when its tests reject every planted defect they can tell apart (capability) and give the same verdict when run again and in a fresh clone (repeatability and reproducibility, after AIAG Measurement Systems Analysis).</p></div></section>`;
}

export function certTable(n: Night, blocks: readonly string[] = BLOCKS): string {
  const cs = certificates(n, blocks).filter((c) => c.state !== 'not measured');
  const none = blocks.length - cs.length;
  return `${cs.length ? `<div class="tbl-wrap" tabindex="0" role="region" aria-label="Calibration certificates"><table class="gtable"><thead><tr><th scope="col">Block</th><th scope="col">Certificate</th><th scope="col" class="num">Capability</th><th scope="col" class="num">Survivors</th><th scope="col" class="num">Ruled equivalent</th><th scope="col">Repeatability</th><th scope="col">Reproducibility</th><th scope="col">Issued</th></tr></thead><tbody>${cs
    .map((c) => `<tr><th scope="row"><code>${esc(c.block)}</code></th><td>${lamp(CERT_LIGHT[c.state], c.state)}${esc(c.state)}<span class="small muted"> · ${esc(c.why)}</span></td><td class="num">${c.capability === null ? 'not measured' : `${c.capability.toFixed(1)}%`}</td><td class="num">${c.survivors}</td><td class="num">${c.equivalents}</td><td>${c.repeatability === null ? '<span class="muted">not measured</span>' : `${c.repeatability.toFixed(1)}% flaky`}</td><td>${c.reproducible === null ? '<span class="muted">not measured</span>' : c.reproducible ? 'agrees' : 'disagrees'}</td><td class="small">${c.issued ? esc(c.issued.slice(0, 10)) : ''}</td></tr>`)
    .join('')}</tbody></table></div>` : '<p class="muted">No calibration run has reported yet.</p>'}<p class="small muted">${none} of ${blocks.length} blocks have no certificate yet. Interval: every block nightly, and a block again whenever its code changes. Each surviving mutant is tagged as a work order for maintenance.</p>`;
}

export function referencesTable(): string {
  return `<div class="tbl-wrap" tabindex="0" role="region" aria-label="Reference standards"><table class="gtable"><thead><tr><th scope="col">Reference</th><th scope="col">What it is the standard for</th><th scope="col">Where it stands</th></tr></thead><tbody>${REFERENCES.map((r) => `<tr><th scope="row">${esc(r.name)}</th><td>${esc(r.traces)}</td><td>${standingLamp(r.standing)}${esc(r.standing)}<span class="small muted"> · ${esc(r.evidence)}</span></td></tr>`).join('')}</tbody></table></div>`;
}

export function measuresTable(): string {
  return `<div class="tbl-wrap" tabindex="0" role="region" aria-label="The measures QA uses"><table class="gtable"><thead><tr><th scope="col">Measure</th><th scope="col">Defined as</th><th scope="col">Unit</th><th scope="col">Traced to</th></tr></thead><tbody>${MEASURES.map((m) => `<tr><th scope="row">${esc(m.name)}</th><td>${esc(m.defined)}</td><td class="small">${esc(m.unit)}</td><td class="small">${esc(m.reference)}</td></tr>`).join('')}</tbody></table></div>`;
}

export function chartsTable(n: Night): string {
  return `<div class="tbl-wrap" tabindex="0" role="region" aria-label="Control charts"><table class="gtable"><thead><tr><th scope="col">Series</th><th scope="col">Read from</th><th scope="col">Points</th></tr></thead><tbody>${charts(n)
    .map((c) => `<tr><th scope="row">${esc(c.metric)}</th><td>${esc(c.source)}</td><td>${lamp(c.points >= MIN_POINTS ? 'pass' : 'not measured', c.points >= MIN_POINTS ? 'limits set' : 'not enough points for limits')}${c.points} of ${MIN_POINTS} needed to set limits</td></tr>`)
    .join('')}</tbody></table></div><p class="small muted">Individuals charts after Shewhart, limits at three sigma from the average moving range; drift is read by the Western Electric rules, and every signal raises a tag. Until a series has ${MIN_POINTS} points, it has no limits and raises nothing.</p>`;
}

export function auditPanel(): string {
  const a = CLAIMS_AUDIT;
  const seg = (v: number, c: string) => `<span class="seg ${c}" style="width:${(100 * v) / a.claims}%"></span>`;
  return `<ul class="lib-stats"><li><span class="n">${a.claims}</span> claims</li><li><span class="n">${a.proven}</span> proven</li><li><span class="n">${a.partial}</span> partial</li><li><span class="n">${a.unproven}</span> unproven</li></ul><div class="mbar" role="img" aria-label="${a.proven} proven, ${a.partial} partial, ${a.unproven} unproven">${seg(a.proven, 'pass')}${seg(a.partial, 'unk')}${seg(a.unproven, 'fail')}</div><p class="small muted">Every claim the factory makes about itself, checked against its evidence on ${a.checked}. The findings:</p><ul>${a.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`;
}

export function labBody(n: Night): string {
  const rulings = n.rulings.length ? `<ul class="jlist">${n.rulings.map((r) => `<li class="jrow">${lamp(r.verdict === 'equivalent' ? 'pass' : 'fail', r.verdict)}<span class="jgoal"><code>${esc(r.block)}</code> ${esc(r.mutant)}</span><span class="jmeta">claimed by ${esc(r.claimant)}, judged by ${esc(r.judge)}: ${esc(r.reasoning)}</span></li>`).join('')}</ul>` : '<p class="muted">No equivalence has been claimed yet.</p>';
  return `${labHeadline(n)}
<section class="sheet" aria-labelledby="h-cert"><h2 id="h-cert">Calibration certificates</h2>${certTable(n)}<h3 class="sub-h">Equivalence rulings</h3>${rulings}</section>
<section class="sheet" aria-labelledby="h-ms"><h2 id="h-ms">The measures QA uses</h2>${measuresTable()}</section>
<section class="sheet" aria-labelledby="h-ref"><h2 id="h-ref">Reference standards</h2>${referencesTable()}</section>
<section class="sheet" aria-labelledby="h-spc"><h2 id="h-spc">Control charts on the factory</h2>${chartsTable(n)}</section>
<section class="sheet" aria-labelledby="h-aud"><h2 id="h-aud">Internal audit: the factory’s own claims</h2>${auditPanel()}</section>`;
}
