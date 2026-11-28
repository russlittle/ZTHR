/**
 * Who does what in a factory run by agents. Each role is defined by what it is denied, the way the factory's own
 * roles are: a limit is structural, held by the API rather than by the agent's good behaviour, and each names the
 * test that proves it holds. A person is not a role here: what only a person does has no tool at all.
 */

export type Role = 'reader' | 'steward' | 'builder' | 'reviewer' | 'operator' | 'triager' | 'pipeline';

export interface Duty {
  readonly role: Role;
  readonly does: string;
  readonly denied: readonly { readonly what: string; readonly provenBy: string }[];
}

const T = 'intent/test/agents.test.ts';

export const DUTIES: readonly Duty[] = [
  {
    role: 'reader',
    does: "Reads the person's rough intent into the reading schema, independently of every other reader.",
    denied: [
      { what: 'seeing any other reading before its own is in', provenBy: T },
      { what: 'submitting a reading under another family, or a second reading for its own family', provenBy: T },
      { what: "answering the person's questions", provenBy: T },
    ],
  },
  {
    role: 'steward',
    does: 'Keeps the intent moving: ranks the questions, drafts answers for the person to confirm, issues revisions, proposes journeys.',
    denied: [
      { what: 'answering a question as the person: a drafted answer is a proposal until the person signs it', provenBy: T },
      { what: 'signing the schematic, a gauge or a journey', provenBy: T },
      { what: 'issuing a revision after the first without saying why', provenBy: T },
      { what: 'issuing a clarification that changes what the person signed (Class I), or any without their standing delegation', provenBy: T },
    ],
  },
  {
    role: 'builder',
    does: 'Builds to the released package: opens changes, runs the required checks, proposes journeys, takes defects.',
    denied: [
      { what: 'admitting its own change (admission is computed from checks and reviews)', provenBy: T },
      { what: 'reporting a check result: the API runs the check and records what the process returned', provenBy: T },
      { what: 'touching a locked, person or generated path', provenBy: T },
      { what: 'changing a proven check without re-proving it against its planted defects', provenBy: T },
      { what: 'blaming the intent or the factory for a failure without naming the balloons and another family agreeing', provenBy: T },
    ],
  },
  {
    role: 'reviewer',
    does: 'Reviews changes from other families, and says what it checked as well as what it found.',
    denied: [
      { what: 'reviewing a change its own family wrote, or one it wrote', provenBy: T },
      { what: 'passing a change without saying what it checked, or blocking one without a finding', provenBy: T },
      { what: 'changing what it reviews', provenBy: T },
      { what: 'confirming a diagnosis its own family made', provenBy: T },
    ],
  },
  {
    role: 'operator',
    does: 'Moves an admitted revision through delivery stage by stage, watches service levels, rolls back.',
    denied: [
      { what: 'skipping a stage, or starting one before the pipeline has recorded the last one as passed', provenBy: T },
      { what: 'releasing to everyone without a named person’s approval in production', provenBy: T },
      { what: 'recording a stage result (only the pipeline’s own identity does)', provenBy: T },
      { what: 'any credential, IAM or cloud permission change: no tool exists for it', provenBy: T },
    ],
  },
  {
    role: 'triager',
    does: 'Sorts what people report: status, severity, duplicates, defects for builders and ideas for the person who holds the intent.',
    denied: [
      { what: 'changing what a reporter wrote, or deleting a report', provenBy: T },
      { what: 'resolving a report without evidence: a commit, a test or a revision', provenBy: T },
      { what: 'changing the intent: an idea is a proposal to the person who holds it', provenBy: T },
    ],
  },
  {
    role: 'pipeline',
    does: "The build service's own identity: records what each delivery stage proved, with the build that proved it.",
    denied: [{ what: 'requesting, approving or rolling back a stage', provenBy: T }],
  },
];

/** What only a person does. None of these has a tool; each arrives as a proposal and is signed outside the API. */
export const PERSON_ONLY: readonly string[] = [
  "answer the intent's questions",
  'sign the schematic as what they mean',
  'sign a gauge or lock a journey card',
  'approve a revision in production',
  'reset a ratchet or lower a floor',
  'change who may sign',
  'enter a credential, or change IAM or cloud permissions',
];

/** Authorship tiers, by consequence: the higher the stakes of a path, the less an agent may author it. First match wins. */
export interface Tier {
  readonly tier: 'locked' | 'person' | 'proven' | 'admitted' | 'generated' | 'open';
  readonly meaning: string;
  readonly paths: readonly string[];
}

/** The factory's own tiers (control/authorship.yaml), used when no factory checkout is attached to the session. */
export const TIERS: readonly Tier[] = [
  { tier: 'locked', meaning: 'Goals the work is judged by. Changed only by a person.', paths: ['control/journeys/', 'control/lock.json', 'control/journey-changes.jsonl', 'control/heldout/'] },
  { tier: 'person', meaning: 'Who may sign, and the record of resets.', paths: ['control/people.json', 'control/ratchet-resets.jsonl', 'control/ratchets.json', 'control/mutation-floors.json', 'control/required-checks.yaml', 'tools/person-signed.ts'] },
  { tier: 'proven', meaning: 'The checks themselves. A change re-proves the gate against its planted defects.', paths: ['tools/gates.ts', 'packages/gates/', 'control/proofs.json', 'control/register.yaml', 'control/authorship.yaml', 'control/patterns.yaml', 'cloudbuild.yaml'] },
  { tier: 'admitted', meaning: 'Declarations agents draft and the factory admits when every check passes.', paths: ['control/playbooks/', 'control/scouts/', 'control/colleges/', 'control/programs/', 'control/proposals/', 'control/admissions.jsonl', 'control/review.yaml', 'control/ci-rates.json'] },
  { tier: 'generated', meaning: 'Written only by tools; a hand edit fails the freshness check.', paths: ['docs/data-model.md', 'docs/testing/coverage.md', 'docs/testing/gates.md', 'docs/flows/playbooks.md'] },
  { tier: 'open', meaning: 'Product and test code, written by agents and admitted by the gates, journeys and walks.', paths: [''] },
];

/** A person's paths and the locked ones, any agent; generated ones, any hand. */
export const UNWRITABLE: ReadonlySet<Tier['tier']> = new Set(['locked', 'person', 'generated']);

export function tierOf(path: string, tiers: readonly Tier[] = TIERS): Tier {
  const p = path.replace(/^\.?\//, '');
  return tiers.find((t) => t.paths.some((x) => (x === '' ? true : x.endsWith('/') ? p.startsWith(x) : p === x)))!;
}

/** The factory's required checks (control/required-checks.yaml), and the npm script that runs each. */
export const REQUIRED_CHECKS: readonly { readonly check: string; readonly step: string }[] = [
  // Cheapest first: a change that fails in seconds never pays for minutes of walking.
  { check: 'typecheck', step: 'typecheck' },
  { check: 'changes only a person makes are signed by that person', step: 'person-signed' },
  { check: 'production dependencies audited', step: 'dependencies' },
  { check: 'docs derived and fresh', step: 'docs' },
  { check: 'unit and integration tests', step: 'test' },
  { check: 'proven gates', step: 'gates' },
  { check: 'locked journeys', step: 'journeys' },
  { check: 'exhaustive button walk', step: 'explore' },
  { check: 'exhaustive page walk', step: 'crawl' },
  { check: 'browser walk', step: 'walk' },
];

/** Independence: two reviews, from two families, neither the author's. Three families in all touch every change. */
export const REVIEW_FAMILIES = 2;
