/**
 * Who is involved, offered rather than asked from nothing. The kind of work is detected by rule from the
 * person's words; a question about staff then becomes a short branch of taps: which organisation, which
 * offices, what they may see and when, and whether permission can be taken back.
 */
import roles from '../lexicon/roles.json' with { type: 'json' };
import type { Question, Statement } from './frame.ts';

interface Domain {
  readonly domain: string;
  readonly detect: readonly string[];
  readonly primary: string;
  readonly organisations: readonly { readonly name: string; readonly units: readonly string[] }[];
}
interface Choice {
  readonly label: string;
  readonly means: string;
  readonly recommended?: true;
}
export interface Roles {
  readonly version?: string;
  readonly domains: readonly Domain[];
  readonly access: { readonly question: string; readonly options: readonly Choice[]; readonly revoke: { readonly question: string; readonly options: readonly Choice[] } };
}

export const loadRoles = (): Roles => roles as unknown as Roles;

/** The kind of work, by which domain's words appear most; none when nothing matches. */
export function detectDomain(roles: Roles, texts: readonly string[]): Domain | null {
  const all = texts.join('\n');
  let best: { d: Domain; n: number } | null = null;
  for (const d of roles.domains) {
    const n = d.detect.reduce((k, r) => k + (all.match(new RegExp(r, 'gi'))?.length ?? 0), 0);
    if (n > 0 && (!best || n > best.n)) best = { d, n };
  }
  return best?.d ?? null;
}

const singular = (p: string) => p.replace(/ies$/, 'y').replace(/s$/, '');

/** The primary people, as a default the read-back shows. */
export function primaryPeople(d: Domain, words: string): Statement {
  return { id: `roles.primary`, slot: 'people', text: `${d.primary} (who it is for)`, words, state: 'default', supplied: { kind: 'derived', rule: `domain:${d.domain}` } };
}

/** The branch of questions for "staff see …": organisation, then offices, then what and when, then taking it back. */
export function staffBranch(roles: Roles, d: Domain, about: string): Question {
  const person = singular(d.primary);
  const fill = (s: string) => s.replaceAll('{person}', person);
  const choice = (c: Choice) => fill(c.label);
  const revoke: Question = {
    id: 'who-sees:revoke',
    origin: 'missing',
    slot: 'constraints',
    text: fill(roles.access.revoke.question),
    answer: { kind: 'single', options: roles.access.revoke.options.map(choice), other: true, ...rec(roles.access.revoke.options, fill) },
    means: Object.fromEntries(roles.access.revoke.options.map((c) => [choice(c), { slot: 'constraints' as const, text: fill(c.means).replaceAll('the person', `the ${person}`), mark: 'critical' as const }])),
    protects: `that the ${person} stays in control of what they shared`,
    consequence: 'high',
  };
  const access: Question = {
    id: 'who-sees:access',
    origin: 'missing',
    slot: 'constraints',
    text: fill(roles.access.question),
    answer: { kind: 'single', options: roles.access.options.map(choice), other: true, ...rec(roles.access.options, fill) },
    means: Object.fromEntries(roles.access.options.map((c) => [choice(c), { slot: 'constraints' as const, text: fill(c.means).replaceAll('the person', `the ${person}`), mark: 'critical' as const }])),
    follow: { [choice(roles.access.options[0]!)]: [revoke] },
    protects: `what staff learn about each ${person}, and when`,
    consequence: 'high',
  };
  const units = (o: Domain['organisations'][number], i: number): Question => ({
    id: `who-sees:units:${i + 1}`,
    origin: 'missing',
    slot: 'people',
    text: `Which ${i === 0 ? 'offices' : 'services'}? Pick any that apply.`,
    answer: { kind: 'multi', options: o.units, other: true },
    means: Object.fromEntries(o.units.map((u) => [u, { slot: 'people' as const, text: `${u} staff, ${o.name.toLowerCase().replace(/^at /, 'at ').replace(/^in /, 'in ')} (on the other side)` }])),
    protects: 'exactly who sees it',
    consequence: 'high',
  });
  return {
    id: 'who-sees',
    origin: 'missing',
    slot: 'people',
    text: `"${about}": where do these staff work? Pick any that apply.`,
    answer: { kind: 'multi', options: d.organisations.map((o) => o.name), other: true },
    means: Object.fromEntries(d.organisations.map((o) => [o.name, { slot: 'assumptions' as const, text: `staff ${o.name.toLowerCase()} are involved` }])),
    follow: { ...Object.fromEntries(d.organisations.map((o, i) => [o.name, [units(o, i)]])), __any__: [access] },
    protects: `who outside the ${person} sees this, and from where`,
    consequence: 'high',
  };
}

function rec(options: readonly Choice[], fill: (s: string) => string): { recommended?: string } {
  const r = options.find((c) => c.recommended);
  return r ? { recommended: fill(r.label) } : {};
}
