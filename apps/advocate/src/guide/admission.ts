import type { Resource } from '../catalog/types.js';
import { readingGrade } from '../domain/tone.js';
import { BARRIER } from './taxonomy.js';

/**
 * The admission gates for a guide entry (docs/flows/resource-guide.md, "Keeping it true"). An entry is admitted only
 * when every check passes; one that fails is held, with the failing checks named. These are the checks that need no
 * network; the verifier (tools/guide-verify.ts) re-reads each source on its schedule.
 */
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const PREFILL_FIELDS = new Set(['chosenName', 'phone', 'zip', 'college', 'creditHours', 'householdSize', 'monthlyGrossIncome', 'weeklyWorkHours']);
const KNOWN_RULES = new Set(['snap', 'lifeline', 'ohio-heap', 'sinclair-emergency-grant']);
const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
const digits = (p: string) => p.replace(/\D/g, '');

export function admit(r: Resource, catalog: Resource[], owners: Set<string>): Check[] {
  const checks: Check[] = [];
  const push = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  push('source of record cited', /^https:\/\//.test(r.source.url) || /^http:\/\//.test(r.source.url), r.source.url);
  push('verified on a real date', isDate(r.verifiedOn), r.verifiedOn);
  push('freshness declared', r.freshnessDays > 0 && r.freshnessDays <= 365, `${r.freshnessDays} days`);
  push('barriers from the taxonomy', r.categories.length > 0 && r.categories.every((c) => !!BARRIER[c]), r.categories.join(', '));
  push('provider stated', !!r.provider?.kind && !!r.provider?.level, r.provider ? `${r.provider.kind}, ${r.provider.level}` : 'missing');
  push('serves somewhere', !!(r.serves.national || r.serves.counties?.length || r.serves.colleges?.length), JSON.stringify(r.serves));
  push('a way to reach it', !!(r.phone || r.url || r.location), [r.phone, r.url, r.location?.address].filter(Boolean).join(' | ') || 'none');
  push('phone is a phone number', !r.phone || [10, 11].includes(digits(r.phone).length) || digits(r.phone).length === 3, r.phone ?? 'none');
  push('how to use it', r.howToApply.length > 0, `${r.howToApply.length} steps`);
  // Grade formulas misread very short text ("Everyone." scores above grade 20), so under six words is judged plain.
  const plain = (t: string, max: number) => t.split(/\s+/).length < 6 || readingGrade(t) <= max;
  push('eligibility in plain words', r.eligibility.text.length > 0 && plain(r.eligibility.text, 10), `grade ${readingGrade(r.eligibility.text).toFixed(1)}`);
  push('description reads plainly', readingGrade(r.description) <= 9, `grade ${readingGrade(r.description).toFixed(1)}`);
  push('every step reads plainly', r.howToApply.every((s) => readingGrade(s) <= 8), r.howToApply.map((s) => readingGrade(s).toFixed(1)).join(', '));
  push('eligibility rule is one the engine knows', !r.eligibility.rule || KNOWN_RULES.has(r.eligibility.rule), r.eligibility.rule ?? 'none');
  push('prefill fields exist', r.prefill.every((f) => PREFILL_FIELDS.has(f)), r.prefill.join(', ') || 'none');
  push('availability facts are sourced and dated', (r.availability ?? []).every((f) => /^https?:\/\//.test(f.source) && isDate(f.checkedOn)), `${r.availability?.length ?? 0} facts`);
  push('owned by a declared scout', owners.has(r.id), owners.has(r.id) ? 'owned' : 'no scout lists it');
  const dupes = catalog.filter((x) => x.id !== r.id && ((r.phone && x.phone && digits(x.phone) === digits(r.phone) && x.name === r.name) || x.id === r.id));
  push('not a duplicate', dupes.length === 0, dupes.map((d) => d.id).join(', ') || 'unique');
  push('unique id', catalog.filter((x) => x.id === r.id).length === 1, r.id);
  return checks;
}

export function admitAll(catalog: Resource[], owners: Set<string>): { id: string; admitted: boolean; failed: Check[] }[] {
  return catalog.map((r) => {
    const checks = admit(r, catalog, owners);
    return { id: r.id, admitted: checks.every((c) => c.ok), failed: checks.filter((c) => !c.ok) };
  });
}
