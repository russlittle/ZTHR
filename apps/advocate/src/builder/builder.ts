import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import type { EvidenceStore } from '@zthr/evidence';
import { JourneyCard } from '@zthr/intent';
import { PlaybookDef } from '../playbooks/engine.js';
import { ScoutDef } from './scouts.js';

/**
 * The builder: the agent that builds agents. It reads the evidence for gaps
 * (needs with no resource, processes students keep handling by hand, questions
 * that rarely help), drafts a new scout, playbook or retirement, and puts each
 * draft through the same admission as any change: a declaration that parses,
 * sources of record, a falsification case, a locked journey card, minimal
 * grants. A draft that passes every check is certified, and the factory admits
 * it (npm run certify): the checks decide, and the builder does not control the
 * checks. A draft that asks for sealed facts fails "minimal grants" and stays
 * unresolved until a listed person decides. The builder can create agents; it
 * cannot admit them, and it cannot widen any agent's permissions.
 */
export type ProposalKind = 'scout' | 'playbook' | 'retire-pulse';
export type ProposalStatus = 'unresolved' | 'certified' | 'admitted' | 'rejected';

export interface Proposal {
  id: string;
  kind: ProposalKind;
  title: string;
  reason: string;
  evidence: Record<string, number | string>;
  declaration: Record<string, unknown>;
  journey?: Record<string, unknown>;
  falsification?: { name: string; plant: string; mustFail: string };
  checks: { name: string; ok: boolean; detail: string }[];
  status: ProposalStatus;
  createdAt: string;
}

/** Candidate sources the builder may propose for a need. A person still verifies them before any entry is shown. */
const SOURCE_HINTS: Record<string, { url: string; kind: 'agency' | 'college' | 'directory' | 'news' }[]> = {
  caregiving: [{ url: 'https://eldercare.acl.gov', kind: 'agency' }],
  'mental-health': [{ url: 'https://988lifeline.org', kind: 'agency' }],
};

const id = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 10);

export interface BuilderOptions {
  today: string;
  /** Minimum gap count before the builder acts, so one student's request does not spawn an agent. */
  threshold?: number;
  existingScouts: { geography: { county?: string }; needs: string[] }[];
  existingPlaybooks: string[];
}

function gate(p: Proposal): Proposal {
  const checks: Proposal['checks'] = [];
  if (p.kind === 'scout') {
    const r = ScoutDef.safeParse(p.declaration);
    checks.push({ name: 'declaration parses', ok: r.success, detail: r.success ? 'scout schema valid' : r.error.issues.map((i) => i.message).join('; ') });
  } else if (p.kind === 'playbook') {
    const r = PlaybookDef.safeParse(p.declaration);
    checks.push({ name: 'declaration parses', ok: r.success, detail: r.success ? 'playbook schema valid' : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const sealed = ((p.declaration.student_grants as { sealed?: string[] } | undefined)?.sealed ?? []).length;
    checks.push({ name: 'minimal grants', ok: sealed === 0, detail: sealed === 0 ? 'no sealed facts requested' : `requests ${sealed} sealed facts; a person must justify each` });
  } else {
    checks.push({ name: 'declaration parses', ok: true, detail: 'retirement of an existing question' });
  }
  if (p.kind !== 'retire-pulse') {
    const card = JourneyCard.safeParse(p.journey);
    checks.push({ name: 'journey card', ok: card.success, detail: card.success ? 'card valid; it will be locked on admission' : 'missing or invalid journey card' });
    checks.push({ name: 'falsification case', ok: !!p.falsification, detail: p.falsification ? p.falsification.name : 'no planted defect to prove the new agent can fail' });
  }
  const ok = checks.every((c) => c.ok);
  return { ...p, checks, status: ok ? 'certified' : 'unresolved' };
}

export function propose(ev: EvidenceStore, o: BuilderOptions): Proposal[] {
  const threshold = o.threshold ?? 3;
  const out: Proposal[] = [];

  // 1. Needs that found no resource, by county.
  const gaps = new Map<string, number>();
  for (const e of ev.events('unmet_need')) {
    const key = `${e.subject}|${String(e.data.need)}`;
    gaps.set(key, (gaps.get(key) ?? 0) + 1);
  }
  for (const [key, count] of gaps) {
    if (count < threshold) continue;
    const [county, need] = key.split('|') as [string, string];
    if (county === 'unknown') continue;
    if (o.existingScouts.some((s) => s.geography.county === county && s.needs.includes(need))) continue;
    const slug = `${county}-${need}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    out.push(
      gate({
        id: `p-${id(`scout|${slug}`)}`,
        kind: 'scout',
        title: `New scout: ${need} in ${county} County`,
        reason: `${count} students asked for ${need} help in ${county} County and no verified resource existed.`,
        evidence: { unmetRequests: count, county, need },
        declaration: {
          scout: slug,
          geography: { county },
          needs: [need],
          sources: SOURCE_HINTS[need] ?? [],
          entries: [],
          freshness_days: 45,
          datum: { precision_min: 0.8 },
          owner: 'builder',
          admitted_by: 'factory',
        },
        journey: {
          id: `scout-${slug}`,
          persona: 'any',
          phase: 2,
          goal: `A student in ${county} County who needs ${need} help is offered a verified resource, or told plainly that none is verified yet and the gap is counted.`,
          forbidden: ['a resource is offered that is stale or the student is ineligible for', 'a gap is hidden instead of counted'],
          budget: { actions: 3, ms: 5000 },
          requirements: ['NAV-6', 'P11'],
          modes: ['standard'],
          channels: ['app'],
        },
        falsification: { name: 'planted unverified entry offered as available', plant: `an entry for ${need} in ${county} with no verification date`, mustFail: 'freshness gate' },
        checks: [],
        status: 'unresolved',
        createdAt: o.today,
      }),
    );
  }

  // 2. Processes students keep handling by hand: recertification notices with no playbook.
  const recerts = ev.events('inbound').filter((e) => e.data.kind === 'benefit-recertification').length;
  if (recerts >= threshold && !o.existingPlaybooks.includes('snap-recertification')) {
    out.push(
      gate({
        id: `p-${id('playbook|snap-recertification')}`,
        kind: 'playbook',
        title: 'New playbook: SNAP recertification',
        reason: `${recerts} students forwarded recertification notices and handled them without a playbook.`,
        evidence: { recertificationNotices: recerts },
        declaration: {
          playbook: 'snap-recertification',
          title: 'Keeping SNAP: recertification',
          purpose: 'Carry a student through SNAP recertification so benefits do not stop.',
          owner: 'builder',
          admitted_by: 'factory',
          sources: ['https://www.fna.usda.gov/snap/students'],
          student_grants: { sealed: [], profile: ['chosenName', 'phone', 'householdSize', 'monthlyGrossIncome', 'weeklyWorkHours'] },
          journeys: ['playbook-snap-recertification'],
          steps: [
            { id: 'notice', kind: 'info', text: 'Your SNAP recertification notice came in. Finishing it on time keeps your benefits from stopping.' },
            { id: 'documents', kind: 'documents', text: 'Get these ready. Anything in your vault is checked off.', documents: ['Proof of income for the last 30 days', 'Proof of your student exemption'] },
            { id: 'submit', kind: 'checklist', text: 'Submit the renewal at benefits.ohio.gov before the date on your notice.', done_when: 'student-confirms' },
            { id: 'interview', kind: 'wait', text: 'If they schedule an interview, tell me the time and I will remind you.', timeout_days: 14, on_timeout: 'Call your county Job and Family Services office to check on your renewal.' },
          ],
          recovery: ['If the date passes, I can help you reapply and ask about the gap.'],
        },
        journey: {
          id: 'playbook-snap-recertification',
          persona: 'any',
          phase: 2,
          goal: 'A student who forwards a SNAP recertification notice is walked through renewal before the deadline, with documents lined up and reminders set.',
          forbidden: ['a message fails the tone rubric', "something is sent without the student's approval"],
          budget: { actions: 6, ms: 5000 },
          requirements: ['PB-2'],
          modes: ['standard'],
          channels: ['app', 'text'],
        },
        falsification: { name: 'planted renewal step that submits for the student', plant: 'a step of kind "submit" with no student confirmation', mustFail: 'student-sends gate' },
        checks: [],
        status: 'unresolved',
        createdAt: o.today,
      }),
    );
  }

  // 3. Questions that rarely help: retire a pulse whose answers seldom reveal a need.
  const byPulse = new Map<string, { asked: number; revealed: number }>();
  for (const e of ev.events('pulse')) {
    const k = String(e.data.pulse);
    const c = byPulse.get(k) ?? { asked: 0, revealed: 0 };
    if (e.data.event === 'answered') {
      c.asked += 1;
      if (e.data.revealedNeed) c.revealed += 1;
    }
    byPulse.set(k, c);
  }
  for (const [pulse, c] of byPulse) {
    if (c.asked >= threshold * 10 && c.revealed / c.asked < 0.02) {
      out.push(
        gate({
          id: `p-${id(`retire|${pulse}`)}`,
          kind: 'retire-pulse',
          title: `Retire question: ${pulse}`,
          reason: `Asked ${c.asked} times; revealed a need ${c.revealed} times. It costs students attention without returning help.`,
          evidence: { asked: c.asked, revealed: c.revealed },
          declaration: { retire: pulse },
          checks: [],
          status: 'unresolved',
          createdAt: o.today,
        }),
      );
    }
  }
  return out;
}

export const asYaml = (p: Proposal) => stringify(p.declaration);
