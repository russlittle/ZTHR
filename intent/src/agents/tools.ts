/**
 * The factory's API for agents. One registry of tools, each with the roles that may call it, an input schema,
 * a description written for the agent that will read it, and what to do next. A session's role is fixed when
 * the session starts; the tools it may not call are not even listed to it.
 *
 * Three kinds of tool:
 *   read      looks, changes nothing
 *   act       changes the record, inside the role's limits
 *   propose   asks a person: the result is a proposal, and nothing changes until a person signs it
 *
 * Every call, allowed or refused, is logged in a hash chain. A refusal says why and what to do instead.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { scan } from '../../tools/secret-scan.ts';
import { objectives, STAGES } from '../delivery.ts';
import { checkReading } from '../frame.ts';
import { sha256 } from '../hash.ts';
import { CLARIFICATIONS, type Given } from '../pipeline.ts';
import { release } from '../release.ts';
import { readingPrompt } from '../prompt.ts';
import { STAGES as INTENT_STAGES, stageOf } from '../progress.ts';
import { ranked, readBack } from '../readback.ts';
import { review } from '../review.ts';
import { history, issue, load } from '../workspace.ts';
import { REQUIRED_CHECKS, REVIEW_FAMILIES, TIERS, tierOf, UNWRITABLE, type Role, type Tier } from './duties.ts';
import { caseOf, cases, classify, closeFixed, delegation, event, failure, type Cause, type DatumLike } from './correct.ts';
import { budgetState } from './cost.ts';
import { familyOfModel } from './families.ts';
import {
  append, changeOf, changes, decisionOn, fileTicket, head, ledgerOf, log, openChange, propose, proposals, readLines, tickets,
  type CheckRun, type DeployRecord, type Ledger, type ReviewEvidence, type ReviewRecord, type Session, type TicketEvent,
} from './ledger.ts';

export { fileTicket };

export interface Context {
  readonly workspace: string;
  /** A checkout of the factory, on the commit under work. Without one, nothing is built or checked. */
  readonly factory?: string;
  readonly session: Session;
  readonly ledger: Ledger;
  /** Runs one required check in the factory checkout. Replaced only in tests. */
  readonly run?: (step: string, cwd: string) => { exit: number | null; out: string };
  /**
   * The model call this tool call came from, as the driver that made it saw it: never the agent's own input. A
   * review counts toward admission only with all of it.
   */
  readonly answer?: ModelCall;
}

/** Who served a model call, the model id it answered as, and the provider's id for the response. */
export interface ModelCall {
  readonly provider: string;
  readonly model: string;
  readonly response?: string;
}

type Schema = {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: readonly (string | number)[];
  maxLength?: number;
  maxItems?: number;
  minItems?: number;
  minimum?: number;
  additionalProperties?: boolean;
};

export interface Tool {
  readonly name: string;
  readonly kind: 'read' | 'act' | 'propose';
  readonly roles: readonly Role[] | 'all';
  /** Phase of the loop it belongs to, for the guide. */
  readonly phase: 'any' | 'intent' | 'build' | 'review' | 'deliver' | 'operate';
  readonly description: string;
  /** What an agent usually does after this call. */
  readonly next: string;
  readonly input: Schema;
  readonly handle: (c: Context, input: Record<string, unknown>) => unknown;
}

/** A refusal: the reason, and what the agent can do instead. It is logged as refused, not as an error. */
export class Refused extends Error {
  readonly why: string;
  readonly instead: string;
  constructor(why: string, instead: string) {
    super(why);
    this.why = why;
    this.instead = instead;
  }
}
const refuse = (why: string, instead: string): never => {
  throw new Refused(why, instead);
};

const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const text = (description: string, maxLength = 2000): Schema => ({ type: 'string', description, maxLength });
const texts = (description: string, maxItems = 50): Schema => ({ type: 'array', description, items: { type: 'string', maxLength: 500 }, maxItems });
const NONE = obj({});

// ------------------------------------------------------------------ helpers over the work

const prepared = (c: Context) => load({ dir: c.workspace });
const released = (c: Context) => history({ dir: c.workspace }).at(-1);
const releaseDir = (c: Context, rev: number) => join(c.workspace, 'releases', `rev-${rev}`);
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

function factoryTiers(c: Context): readonly Tier[] {
  const p = c.factory ? join(c.factory, 'control', 'authorship.yaml') : '';
  if (!p || !existsSync(p)) return TIERS;
  const y = parseYaml(readFileSync(p, 'utf8')) as { tiers: Tier[] };
  return y.tiers;
}

/** The family a review counts for: read from the model it came from when there is one, else the session's flag. */
const familyOfReview = (r: ReviewRecord) => (r.evidence ? familyOfModel(r.evidence.model) : null) ?? r.by.family;

/** The tree the API's checks ran on for a change: what every review must have been shown. */
export const treeOfChange = (l: Ledger, id: string): string | undefined =>
  readLines<CheckRun>(l, 'checks.jsonl')
    .filter((r) => r.change === id && r.tree)
    .at(-1)?.tree;

/** Why a passing review does not count toward independence, or null when it does. */
export function uncounted(r: ReviewRecord, tree: string | undefined, authorFamily: string): string | null {
  const e = r.evidence;
  if (!e || !e.provider || !e.model || !e.response || !e.tree) return `the ${r.by.family} review carries no record of the model call (provider, model, response id and tree), so its family is only a flag`;
  const fam = familyOfModel(e.model);
  if (!fam) return `the ${r.by.family} review came from ${e.model}, a model whose family is not known`;
  if (fam !== r.by.family) return `the ${r.by.family} review came from ${e.model}, a ${fam} model`;
  if (fam === authorFamily) return `the review came from ${e.model}, of the author's family`;
  if (!tree) return 'no tree is recorded for the change’s checks, so no review can be tied to what was checked';
  if (e.tree !== tree) return `the ${fam} review was of tree ${e.tree.slice(0, 12)}, not the checked tree ${tree.slice(0, 12)}`;
  return null;
}

/**
 * Whether a change is admitted. Computed from what the API recorded; no role can set it. Independence is counted by
 * the family of the model each verdict came from: two verdicts from one family, or one response recorded twice,
 * count once, and a verdict without the record of its model call does not count at all. A block always blocks.
 */
export function admission(l: Ledger, id: string): { admitted: boolean; missing: string[]; blocking: string[]; uncounted: string[] } {
  const ch = changeOf(l, id);
  if (!ch) return { admitted: false, missing: [`no change ${id}`], blocking: [], uncounted: [] };
  const runs = readLines<CheckRun>(l, 'checks.jsonl').filter((r) => r.change === id);
  const missing: string[] = [];
  const blocking: string[] = [];
  for (const rc of REQUIRED_CHECKS) {
    const last = runs.filter((r) => r.step === rc.step).at(-1);
    if (!last) missing.push(`check not run: ${rc.check}`);
    else if (!last.ok) blocking.push(`check failed: ${rc.check}`);
  }
  const tree = treeOfChange(l, id);
  const reviews = readLines<ReviewRecord>(l, 'reviews.jsonl').filter((r) => r.change === id && familyOfReview(r) !== ch.author.family);
  const fams = [...new Set(reviews.map(familyOfReview))];
  const latest = fams.map((f) => reviews.filter((r) => familyOfReview(r) === f).at(-1)!);
  for (const r of latest) if (r.verdict === 'block') blocking.push(`blocked by the ${familyOfReview(r)} review: ${r.findings.map((f) => f.what).join('; ')}`);
  const seen = new Set<string>();
  const counted = new Set<string>();
  const notCounted: string[] = [];
  for (const r of latest.filter((x) => x.verdict === 'pass')) {
    const why = uncounted(r, tree, ch.author.family);
    if (why) {
      notCounted.push(`not counted: ${why}`);
      continue;
    }
    const call = `${r.evidence!.provider}:${r.evidence!.response}`;
    if (seen.has(call)) {
      notCounted.push(`not counted: response ${r.evidence!.response} from ${r.evidence!.provider} is already counted for another verdict`);
      continue;
    }
    seen.add(call);
    counted.add(familyOfModel(r.evidence!.model)!);
  }
  if (counted.size < REVIEW_FAMILIES) missing.push(`${REVIEW_FAMILIES - counted.size} more passing review(s), each from a model of a family other than ${ch.author.family} and the others`, ...notCounted);
  return { admitted: missing.length === 0 && blocking.length === 0, missing, blocking, uncounted: notCounted };
}

const STAGE_IDS = STAGES.map((s) => s.id);

/** Where a change stands in delivery: the last stage the pipeline recorded as passed, and any request waiting. */
export function deliveryOf(l: Ledger, change: string) {
  const rs = readLines<DeployRecord>(l, 'deploy.jsonl').filter((r) => r.change === change);
  const passed = rs.filter((r) => r.kind === 'result' && r.ok).map((r) => r.stage);
  const lastRollback = rs.filter((r) => r.kind === 'rollback').at(-1);
  const after = lastRollback ? rs.slice(rs.lastIndexOf(lastRollback) + 1) : rs;
  const passedSince = after.filter((r) => r.kind === 'result' && r.ok).map((r) => r.stage);
  const reached = STAGE_IDS.filter((s) => passedSince.includes(s)).at(-1) ?? null;
  const waiting = after.filter((r) => r.kind === 'requested' && !after.some((x) => x.kind === 'result' && x.stage === r.stage && x.at >= r.at)).at(-1)?.stage ?? null;
  return { reached, waiting, everPassed: passed, rolledBack: Boolean(lastRollback) };
}

const productionApproval = (l: Ledger, change: string) =>
  proposals(l)
    .filter((p) => p.kind === 'production' && p.body['change'] === change)
    .map((p) => ({ p, d: decisionOn(l, p.id) }))
    .find((x) => x.d?.decision === 'signed');


/** The checks a builder runs locally before anything is pushed: seconds, against build minutes and a reviewer woken for nothing. */
export const PREPUSH = ['typecheck', 'test'] as const;

const git = (c: Context, ...args: string[]) => spawnSync('git', args, { cwd: c.factory!, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** What a commit touches, read from git: since its base, or the commit alone. Null when git cannot say. */
function pathsOf(c: Context, commit: string, base?: string): string[] | null {
  const d = base ? git(c, 'diff', '--name-only', base, commit) : git(c, 'diff-tree', '--root', '-r', '--name-only', '--no-commit-id', commit);
  return d.status === 0 ? d.stdout.split('\n').filter(Boolean) : null;
}

type StepResult = { check: string; step: string; ok: boolean; reused?: boolean; tail?: string };

/**
 * Run checks on one commit in the factory checkout: cheapest first, stopping at the first failure unless asked for
 * all, and never running again what already passed on an identical tree. The checkout is moved to the commit and
 * put back afterwards; it must be clean, so nothing but the commit is ever what was checked.
 */
function runOn(c: Context, sha: string, steps: readonly string[], recordAs: string, all = false): StepResult[] {
  const run = c.run ?? ((step: string, cwd: string) => { const r = spawnSync('npm', ['run', step], { cwd, encoding: 'utf8', timeout: 30 * 60_000 }); return { exit: r.status, out: `${r.stdout}\n${r.stderr}` }; });
  const tree = git(c, 'rev-parse', `${sha}^{tree}`).stdout.trim();
  const before = readLines<CheckRun>(c.ledger, 'checks.jsonl');
  const head = git(c, 'rev-parse', 'HEAD').stdout.trim();
  const branch = git(c, 'symbolic-ref', '-q', '--short', 'HEAD').stdout.trim();
  let moved = false;
  const results: StepResult[] = [];
  try {
    for (const rc of REQUIRED_CHECKS.filter((x) => steps.includes(x.step))) {
      const prior = tree ? before.find((r) => r.tree === tree && r.step === rc.step && r.ok) : undefined;
      if (!prior && !moved && !head.startsWith(sha)) {
        git(c, 'checkout', '-q', '--detach', sha);
        moved = true;
      }
      const r = prior ? { exit: 0, out: prior.tail } : run(rc.step, c.factory!);
      const row: CheckRun = { change: recordAs, check: rc.check, step: rc.step, ok: r.exit === 0, exit: r.exit, tail: r.out.trim().split('\n').slice(-15).join('\n'), ...(tree ? { tree } : {}), ...(prior ? { reused: true } : {}), by: c.session, at: c.ledger.now() };
      append(c.ledger, 'checks.jsonl', row);
      results.push({ check: rc.check, step: rc.step, ok: row.ok, ...(prior ? { reused: true } : {}), ...(row.ok ? {} : { tail: row.tail }) });
      if (!row.ok && !all) break;
    }
  } finally {
    if (moved) git(c, 'checkout', '-q', branch || head);
  }
  return results;
}

// ------------------------------------------------------------------ the tools

export const TOOLS: readonly Tool[] = [
  // ---------------------------------------------------------------- any role
  {
    name: 'guide',
    kind: 'read',
    roles: 'all',
    phase: 'any',
    description: 'How this factory works and what your role does in it: the loop, the rules, your tools and what comes after each. Read it first in every session.',
    next: 'Call status to see where the work stands.',
    input: NONE,
    handle: (c) => ({ guide: guideFor(c.session.role) }),
  },
  {
    name: 'status',
    kind: 'read',
    roles: 'all',
    phase: 'any',
    description: 'Where the work stands across the whole loop: the intent stage and its open questions, the last released revision, changes in flight and whether each is admitted, delivery, reports waiting, and what is waiting on a person.',
    next: 'Pick up the first thing waiting on your role.',
    input: NONE,
    handle: (c) => {
      const p = prepared(c);
      const h = history({ dir: c.workspace });
      const last = h.at(-1);
      const l = c.ledger;
      return {
        you: c.session,
        intent: {
          stage: INTENT_STAGES.find((s) => s.key === stageOf(p, Boolean(last?.ready)))!.label,
          readings: readdirSync(join(c.workspace, 'readings')).filter((f) => f.endsWith('.json')).length,
          openQuestions: p.questions.length,
          lastRevision: last ? { revision: last.revision, ready: last.ready, package: last.package.slice(0, 12) } : null,
        },
        changes: changes(l).map((ch) => ({ id: ch.id, title: ch.title, author: ch.author.family, ...admission(l, ch.id), delivery: deliveryOf(l, ch.id) })),
        tickets: Object.entries(tickets(l).reduce<Record<string, number>>((a, t) => ({ ...a, [t.status]: (a[t.status] ?? 0) + 1 }), {})).map(([status, n]) => ({ status, n })),
        waitingOnAPerson: proposals(l).filter((x) => !decisionOn(l, x.id)).map((x) => ({ id: x.id, kind: x.kind, title: x.title })),
      };
    },
  },
  {
    name: 'log',
    kind: 'read',
    roles: 'all',
    phase: 'any',
    description: 'The most recent calls to this API, by every agent, allowed and refused, and whether the hash chain holds.',
    next: 'Use it to see what others did before you act on the same work.',
    input: obj({ last: { type: 'integer', minimum: 1, description: 'How many entries, newest last (default 20).' } }),
    handle: (c, i) => ({ entries: readLines(c.ledger, 'log.jsonl').slice(-Number(i['last'] ?? 20)) }),
  },

  // ---------------------------------------------------------------- intent: readers
  {
    name: 'reading_context',
    kind: 'read',
    roles: ['reader'],
    phase: 'intent',
    description: "The person's rough intent and the reading schema, exactly as every family receives it. Other readings are never shown: a reading is only worth comparing if it is independent.",
    next: 'Read it, then call reading_submit with one JSON object in the schema.',
    input: NONE,
    handle: (c) => ({ family: c.session.family, prompt: readingPrompt(prepared(c).model, c.session.family) }),
  },
  {
    name: 'reading_submit',
    kind: 'act',
    roles: ['reader'],
    phase: 'intent',
    description: 'Submit your reading. It must match the schema exactly and carry your own family; each family reads once. Where it differs from another family, the person is asked.',
    next: 'Your part is done. The steward takes it from here.',
    input: obj({ reading: { type: 'object', description: 'The reading, in the schema reading_context gives.' } }, ['reading']),
    handle: (c, i) => {
      const r = checkReading(i['reading']);
      if (!r.ok) return refuse(`not a reading: ${r.problems.join('; ')}`, 'Fix the fields named and submit again.');
      if (r.reading.family !== c.session.family) return refuse(`this session reads for ${c.session.family}, not ${r.reading.family}`, `Set family to "${c.session.family}".`);
      const path = join(c.workspace, 'readings', `${c.session.family}.json`);
      if (existsSync(path)) return refuse(`${c.session.family} has already read this intent`, 'A second family reads it, not a second reading from the same one.');
      writeFileSync(path, `${JSON.stringify(r.reading, null, 2)}\n`);
      return { recorded: c.session.family, families: readdirSync(join(c.workspace, 'readings')).filter((f) => f.endsWith('.json')).length };
    },
  },

  // ---------------------------------------------------------------- intent: steward
  {
    name: 'schematic',
    kind: 'read',
    roles: ['steward', 'builder', 'reviewer', 'operator', 'triager'],
    phase: 'intent',
    description: 'The schematic as the person reads it back: every balloon, its state and tolerance, the title block, and what is still open.',
    next: 'Questions and the review show what is left before it can be signed.',
    input: NONE,
    handle: (c) => ({ markdown: readBack(prepared(c)) }),
  },
  {
    name: 'questions',
    kind: 'read',
    roles: ['steward'],
    phase: 'intent',
    description: 'The open questions, most consequential first, with their choices and what a wrong answer would break.',
    next: 'Draft an answer with answer_suggest where the sources settle it; leave the rest for the person.',
    input: obj({ budget: { type: 'integer', minimum: 1, description: 'How many to return (default 10).' } }),
    handle: (c, i) => {
      const { ask, held } = ranked(prepared(c).questions, Number(i['budget'] ?? 10));
      return { questions: ask.map((q) => ({ id: q.id, text: q.text, choices: q.choices ?? [], answer: q.answer ?? null, protects: q.protects, consequence: q.consequence })), held };
    },
  },
  {
    name: 'answer_suggest',
    kind: 'propose',
    roles: ['steward'],
    phase: 'intent',
    description: 'Draft an answer to one open question, with where in the sources it comes from. It is a proposal: the answer counts only when the person signs it.',
    next: 'Go on to the next question. The person sees your drafts together and signs or declines each.',
    input: obj(
      {
        question: text('The question id.', 200),
        answer: obj({ pick: text('One choice.', 500), picks: texts('Several choices.'), yes: { type: 'boolean' }, other: text('In their words, when no choice fits.', 1000) }),
        source: text('Where in the person’s own words this comes from: the file and the line, quoted.', 1000),
      },
      ['question', 'answer', 'source'],
    ),
    handle: (c, i) => {
      const q = prepared(c).questions.find((x) => x.id === i['question']);
      if (!q) return refuse(`no open question ${String(i['question'])}`, 'Call questions for the open ids.');
      const a = i['answer'] as Given;
      if (!Object.keys(a).length) return refuse('an answer must say something', 'Give pick, picks, yes or other.');
      const p = propose(c.ledger, c.session, 'answer', `Answer: ${q.text.slice(0, 80)}`, String(i['source']), { question: q.id, answer: a });
      return { proposal: p.id, waitsFor: 'the person who holds the intent' };
    },
  },
  {
    name: 'review',
    kind: 'read',
    roles: ['steward', 'reviewer'],
    phase: 'intent',
    description: 'What the raters found: each person the schematic serves graded on seven axes, mismatches between people and journeys, and the overall grade.',
    next: 'Turn what can be fixed from the sources into suggested answers or a journey proposal.',
    input: NONE,
    handle: (c) => {
      const r = review(prepared(c));
      return { overall: r.overall, people: r.people.map((x) => ({ name: x.name, grade: x.grade, failing: x.checks.filter((k) => !k.holds).map((k) => k.text) })), raters: r.panel.map((x) => ({ name: x.name, grade: x.grade, failing: x.checks.filter((k) => !k.holds).map((k) => k.text) })), mismatches: r.mismatches.map((m) => m.text) };
    },
  },
  {
    name: 'release_issue',
    kind: 'act',
    roles: ['steward'],
    phase: 'intent',
    description: 'Issue the next revision of the package from the workspace. After the first, say why. Issuing is not signing: the package says whether it is ready for the person to sign.',
    next: 'If it is not ready, the problems say what is left. If it is, tell the person it is ready to sign.',
    input: obj({ reason: text('Why this revision is made. Required after the first.', 1000) }),
    handle: (c, i) => {
      try {
        const r = issue({ dir: c.workspace }, i['reason'] as string | undefined, head(c.ledger));
        const m = JSON.parse(r.release.files['manifest.json']!) as { ready: boolean; package: string; openQuestions: number };
        return { revision: r.revision, ready: m.ready, package: m.package.slice(0, 12), openQuestions: m.openQuestions, problems: r.release.problems.slice(0, 20) };
      } catch (e) {
        return refuse((e as Error).message, 'Give a reason that says why this revision is made.');
      }
    },
  },
  {
    name: 'journey_propose',
    kind: 'propose',
    roles: ['steward', 'builder'],
    phase: 'intent',
    description: 'Propose a journey card: who walks it, what they are trying to do, what must never happen, and the budget. Agents never lock journeys; a person signs the card into the locked set.',
    next: 'Carry on. Until it is signed, the journey judges nothing.',
    input: obj(
      {
        id: text('A short kebab-case id.', 80),
        persona: text('Who walks it.', 200),
        goal: text('What they are trying to do, in a sentence, with what counts as done.', 1000),
        forbidden: texts('What must never happen on the way.', 20),
        budget: obj({ actions: { type: 'integer', minimum: 1 }, ms: { type: 'integer', minimum: 1 } }, ['actions', 'ms']),
        because: text('What in the schematic, a report or a failure calls for it.', 1000),
      },
      ['id', 'persona', 'goal', 'forbidden', 'budget', 'because'],
    ),
    handle: (c, i) => {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(i['id']))) return refuse('the id must be kebab-case', 'Use lower-case words joined by hyphens.');
      if (!(i['forbidden'] as string[]).length) return refuse('a journey needs at least one thing that must never happen', 'Say what would make the walk a failure even if it ended in the right place.');
      const { because, ...card } = i;
      const p = propose(c.ledger, c.session, 'journey', `Journey: ${String(i['id'])}`, String(because), card);
      return { proposal: p.id, waitsFor: 'a person, who signs it into control/journeys' };
    },
  },

  // ---------------------------------------------------------------- build
  {
    name: 'build_plan',
    kind: 'read',
    roles: ['builder', 'reviewer'],
    phase: 'build',
    description: 'What to build, from the last released revision: the manifest in build order, the gauges that judge it, the starting ratchets, the required checks, and the brief for agents in the package.',
    next: 'Build in find-number order on a branch, then call change_open with the commit and the paths you touched.',
    input: NONE,
    handle: (c) => {
      const last = released(c) ?? refuse('nothing has been released yet', 'The steward issues the first revision with release_issue.');
      const dir = releaseDir(c, last.revision);
      const bm = readJson<{ lines: { find: number; part: string; source: string; balloons: number[]; journeys: string[] }[] }>(join(dir, 'build-manifest.json'));
      return {
        revision: last.revision,
        ready: last.ready,
        brief: join(dir, 'AGENTS.md'),
        lines: bm.lines.map((x) => ({ find: x.find, part: x.part, source: x.source, balloons: x.balloons, journeys: x.journeys.length })),
        gauges: existsSync(join(dir, 'gauges')) ? readdirSync(join(dir, 'gauges')).map((f) => f.replace(/\.yaml$/, '')) : [],
        ratchets: readJson<unknown[]>(join(dir, 'ratchets.json')),
        requiredChecks: REQUIRED_CHECKS.map((x) => x.check),
      };
    },
  },
  {
    name: 'path_tier',
    kind: 'read',
    roles: ['builder', 'reviewer'],
    phase: 'build',
    description: 'The authorship tier of each path, and whether your role may write it. Ask before you edit anything under control/, tools/ or packages/gates/.',
    next: 'Leave locked, person and generated paths alone. For a goal you think is wrong, propose a journey.',
    input: obj({ paths: texts('Repository paths.', 200) }, ['paths']),
    handle: (c, i) => {
      const tiers = factoryTiers(c);
      return { paths: (i['paths'] as string[]).map((p) => { const t = tierOf(p, tiers); return { path: p, tier: t.tier, writable: !UNWRITABLE.has(t.tier), meaning: t.meaning }; }) };
    },
  },
  {
    name: 'change_open',
    kind: 'act',
    roles: ['builder'],
    phase: 'build',
    description: 'Open a change, before it is pushed. The API first runs the existing typecheck and tests on the base, so a failure already there becomes a case against the base and is never blamed on this change; then on the commit itself. A red commit is refused: nothing red is pushed, opened or reviewed. Also refused if the commit touches a path no agent may write, or one it does not declare. Changes are immutable; to amend, open a new one on the new commit.',
    next: 'Push the commit, then call checks_run for the rest of the required checks.',
    input: obj({ title: text('What it does, in a line.', 200), commit: text('The full or short git sha.', 40), case: text('The correction case this change fixes, if it is a fix.', 40), base: text('The commit the work starts from; the commit’s parent if left out.', 40), paths: texts('Every path the commit touches. The API checks this against the commit itself.', 500) }, ['title', 'commit', 'paths']),
    handle: (c, i) => {
      if (!/^[0-9a-f]{7,40}$/.test(String(i['commit'])) || (i['base'] !== undefined && !/^[0-9a-f]{7,40}$/.test(String(i['base'])))) return refuse('commit and base must be git shas', 'Give the sha of the commit to review.');
      const last = released(c) ?? refuse('nothing has been released to build to', 'Wait for the steward to issue a revision.');
      const tiers = factoryTiers(c);
      const paths = i['paths'] as string[];
      if (!paths.length) return refuse('a change touches at least one path', 'List the paths.');
      const bad = paths.map((p) => ({ p, t: tierOf(p, tiers) })).filter((x) => UNWRITABLE.has(x.t.tier));
      if (bad.length) return refuse(`no agent writes ${bad.map((x) => `${x.p} (${x.t.tier})`).join(', ')}`, 'Take those paths out of the commit. To change a goal, call journey_propose; generated files come from their tools.');
      const reprove = paths.filter((p) => tierOf(p, tiers).tier === 'proven');
      if (i['case'] !== undefined) {
        const k = caseOf(c.ledger, String(i['case'])) ?? refuse(`no case ${String(i['case'])}`, 'Call cases.');
        if (k.waiting !== 'builder: fix') return refuse(`case ${k.id} is waiting on ${k.waiting}, not a fix`, k.waiting === 'builder: diagnose' ? 'Diagnose it first with case_diagnose.' : 'Leave it to the role it waits on.');
      }
      if (!c.factory) return refuse('no factory checkout is attached to this session', 'Start the session with --factory pointing at a checkout of the factory: a change is tested before it is opened.');
      const commit = String(i['commit']);
      if (git(c, 'cat-file', '-e', `${commit}^{commit}`).status !== 0) return refuse(`no commit ${commit} in the factory checkout`, 'Commit the work in the checkout, then open the change.');
      if (git(c, 'status', '--porcelain').stdout.trim()) return refuse('the checkout has uncommitted work', 'Commit or stash it: what is tested is the commit and nothing else.');
      const actual = pathsOf(c, commit, i['base'] as string | undefined) ?? refuse(`cannot read what ${commit} changes`, 'Give a base the checkout has.');
      const undeclared = actual.filter((p) => !paths.includes(p));
      if (undeclared.length) return refuse(`the commit touches paths the change does not declare: ${undeclared.join(', ')}`, 'List every path, so each is checked against its tier.');
      // The base first: a test that already fails is a case against the base, not this change's fault.
      const base = (i['base'] as string | undefined) ?? (git(c, 'rev-parse', '-q', '--verify', `${commit}^`).stdout.trim() || null);
      const fixingBase = i['case'] !== undefined && caseOf(c.ledger, String(i['case']))?.opened.source?.ref === `base ${base}`;
      if (base && !fixingBase) {
        const red = runOn(c, base, PREPUSH, `base:${base.slice(0, 12)}`).filter((x) => !x.ok);
        if (red.length) {
          const open = cases(c.ledger).find((k) => k.status !== 'closed' && k.opened.source?.ref === `base ${base}`);
          const kase = open?.id ?? failure(c.ledger, { kind: 'check', ref: `base ${base}` }, `the base ${base.slice(0, 12)} already fails: ${red.map((x) => x.check).join(', ')}`, red.length, last.revision, undefined, c.session);
          return refuse(`the base ${base.slice(0, 12)} already fails ${red.map((x) => x.check).join(', ')}, before this change; case ${kase} is open for it`, `Fix the base first: diagnose case ${kase} and open its fix with case ${kase}. Your change waits on a green base.`);
        }
      }
      // Then this commit, before it is pushed or anyone is asked to look at it.
      const mine = runOn(c, commit, PREPUSH, `pending:${commit.slice(0, 12)}`);
      const failed = mine.filter((x) => !x.ok);
      if (failed.length) {
        if (i['case'] !== undefined) failure(c.ledger, { kind: 'check', ref: failed.map((x) => x.check).join(', ') }, `fix attempt ${commit.slice(0, 12)} fails ${failed.map((x) => x.check).join(', ')} before it is pushed`, failed.length + (PREPUSH.length - mine.length), last.revision, String(i['case']), c.session);
        return refuse(`${commit.slice(0, 12)} fails ${failed.map((x) => x.check).join(', ')}: ${failed[0]!.tail ?? ''}`.slice(0, 1500), 'Fix it and commit again. Nothing red is pushed, opened or reviewed.');
      }
      const ch = openChange(c.ledger, { title: String(i['title']), commit, ...(i['base'] ? { base: String(i['base']) } : {}), ...(i['case'] ? { case: String(i['case']) } : {}), paths, revision: last.revision, author: c.session, reprove });
      return { change: ch.id, base: base ? 'green' : 'no base: the first commit', tested: mine.map((x) => `${x.check}${x.reused ? ' (already passed on this tree)' : ''}`), push: 'ready: typecheck and tests pass on this commit', requiredChecks: REQUIRED_CHECKS.map((x) => x.check), reprove, reviews: `${REVIEW_FAMILIES} passing, from families other than ${c.session.family}` };
    },
  },
  {
    name: 'checks_run',
    kind: 'act',
    roles: ['builder'],
    phase: 'build',
    description: "Run required checks on the change's commit in the factory checkout. The API runs them, cheapest first, stops at the first failure, and records what each process returned; nobody reports a result. A check that passed on the identical tree before is not run again. A failure opens a correction case, or counts as another attempt on the change's case.",
    next: 'Fix what failed in a new commit and open a new change; when all pass, wait for reviews.',
    input: obj({ change: text('The change id.', 40), check: { type: 'string', enum: REQUIRED_CHECKS.map((x) => x.step), description: 'One check; all of them if left out.' }, all: { type: 'boolean', description: 'Run every check even after one fails (default: stop at the first failure).' } }, ['change']),
    handle: (c, i) => {
      const ch = changeOf(c.ledger, String(i['change'])) ?? refuse(`no change ${String(i['change'])}`, 'Call status for the open changes.');
      if (!c.factory) return refuse('no factory checkout is attached to this session', 'Start the session with --factory pointing at a checkout of the factory.');
      const commit = ch.commit;
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: c.factory, encoding: 'utf8' }).stdout.trim();
      if (!head.startsWith(commit)) return refuse(`the checkout is on ${head.slice(0, 12)}, not ${commit}`, `Check out ${commit} in the factory checkout first.`);
      if (spawnSync('git', ['status', '--porcelain'], { cwd: c.factory, encoding: 'utf8' }).stdout.trim()) return refuse('the checkout has uncommitted work', 'Checks run on the commit under review and nothing else: commit or stash it.');
      // The paths are read from the commit itself, not taken from the change: a declared list could leave a locked path out.
      const actual = pathsOf(c, commit, ch.base) ?? refuse(`cannot read what ${commit} changes${ch.base ? ` since ${ch.base}` : ''}`, 'Open the change with a base the checkout has.');
      const undeclared = actual.filter((p) => !ch.paths.includes(p));
      if (undeclared.length) return refuse(`the commit touches paths the change does not declare: ${undeclared.join(', ')}`, 'Open a new change that lists every path, so each is checked against its tier.');
      const which = REQUIRED_CHECKS.filter((x) => !i['check'] || x.step === i['check']).map((x) => x.step);
      const results = runOn(c, commit, which, ch.id, i['all'] === true);
      const failed = results.filter((x) => !x.ok);
      const kase = failed.length ? failure(c.ledger, { kind: 'check', ref: failed.map((x) => x.check).join(', '), change: ch.id }, `checks failed on ${ch.id}: ${failed.map((x) => x.check).join(', ')}`, failed.length + (which.length - results.length), ch.revision, ch.case, c.session) : null;
      closeFixed(c.ledger, (id) => admission(c.ledger, id).admitted);
      return { results, admission: admission(c.ledger, ch.id), ...(kase ? { case: kase } : {}) };
    },
  },
  {
    name: 'defects',
    kind: 'read',
    roles: ['builder'],
    phase: 'build',
    description: 'Defects from what people reported: the failing test to write first, what it should expect, and the report it came from.',
    next: 'Write the failing test, see it fail, fix it, and open a change whose title names the ticket.',
    input: NONE,
    handle: (c) => ({ defects: tickets(c.ledger).filter((t) => t.status !== 'resolved').flatMap((t) => t.history.filter((e) => e.event === 'defect').map((e) => ({ ticket: t.id, title: t.filed.title, test: e.test, expectation: e.expectation }))) }),
  },

  // ---------------------------------------------------------------- review
  {
    name: 'review_queue',
    kind: 'read',
    roles: ['reviewer'],
    phase: 'review',
    description: 'Changes you may review: written by another family, not yet reviewed by yours, every required check passed, and not blocked by another family. Nothing reaches a model that a machine can still reject.',
    next: 'Review the commit itself, against the schematic and the gauges, then call review_submit.',
    input: NONE,
    handle: (c) => {
      const mine = readLines<ReviewRecord>(c.ledger, 'reviews.jsonl').filter((r) => r.by.family === c.session.family).map((r) => r.change);
      return {
        changes: changes(c.ledger)
          .filter((ch) => ch.author.family !== c.session.family && !mine.includes(ch.id))
          // A model reads a change only once the machines are satisfied, and only while no other family has blocked it.
          .filter((ch) => { const a = admission(c.ledger, ch.id); return !a.admitted && !a.missing.some((m) => m.startsWith('check not run')) && !a.blocking.length; })
          .map((ch) => ({ id: ch.id, title: ch.title, commit: ch.commit, paths: ch.paths, reprove: ch.reprove, ...admission(c.ledger, ch.id) })),
      };
    },
  },
  {
    name: 'review_packet',
    kind: 'read',
    roles: ['reviewer'],
    phase: 'review',
    description: 'Everything one review needs and nothing else: the diff of the change (capped), its paths and tiers, and the balloons it builds to. One short call instead of reading the repository.',
    next: 'Judge the diff against the balloons and the gauges, then call review_submit.',
    input: obj({ change: text('The change id.', 40), maxBytes: { type: 'integer', minimum: 1000, description: 'Cap on the diff (default 40000).' } }, ['change']),
    handle: (c, i) => {
      const ch = changeOf(c.ledger, String(i['change'])) ?? refuse(`no change ${String(i['change'])}`, 'Call review_queue.');
      if (!c.factory) return refuse('no factory checkout is attached to this session', 'Start the session with --factory.');
      const args = ch.base ? ['diff', '--unified=3', ch.base, ch.commit] : ['show', '--format=', '--unified=3', ch.commit];
      const diff = spawnSync('git', args, { cwd: c.factory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout;
      const cap = Number(i['maxBytes'] ?? 40_000);
      const p = prepared(c);
      const tiers = factoryTiers(c);
      return {
        change: ch.id,
        title: ch.title,
        paths: ch.paths.map((x) => ({ path: x, tier: tierOf(x, tiers).tier })),
        balloons: p.statements.filter((x) => x.slot === 'outcome' || x.slot === 'constraints' || x.slot === 'measures').map((x) => `[${x.balloon}] ${x.text}${x.tolerance ? ` (${x.tolerance})` : ''}${x.mark ? ` ${x.mark}` : ''}`),
        diff: diff.length > cap ? `${diff.slice(0, cap)}\n… ${diff.length - cap} more bytes; review the paths above for what is cut` : diff,
      };
    },
  },
  {
    name: 'review_submit',
    kind: 'act',
    roles: ['reviewer'],
    phase: 'review',
    description: 'Your verdict on one change. A pass says what you checked; a block names at least one finding. You review a change once per family, and never one your family wrote.',
    next: 'Call review_queue for the next.',
    input: obj(
      {
        change: text('The change id.', 40),
        verdict: { type: 'string', enum: ['pass', 'block'] },
        checked: texts('What you checked: each gauge, path or rule you verified, in a line.', 50),
        findings: { type: 'array', maxItems: 50, items: obj({ what: text('What is wrong.', 1000), severity: { type: 'string', enum: ['blocking', 'major', 'minor'] }, path: text('Where.', 300), line: { type: 'integer', minimum: 1 } }, ['what', 'severity']) },
      },
      ['change', 'verdict', 'checked', 'findings'],
    ),
    handle: (c, i) => {
      const ch = changeOf(c.ledger, String(i['change'])) ?? refuse(`no change ${String(i['change'])}`, 'Call review_queue.');
      if (ch.author.agent === c.session.agent) return refuse('you wrote this change', 'Another agent, of another family, reviews it.');
      if (ch.author.family === c.session.family) return refuse(`${c.session.family} wrote this change`, 'A reviewer from another family reviews it; your family shares its blind spots.');
      const fam = c.answer ? familyOfModel(c.answer.model) : null;
      if (c.answer && fam !== c.session.family) return refuse(`this session reviews for ${c.session.family}, but the call came from ${c.answer.model}${fam ? `, a ${fam} model` : ', whose family is not known'}`, 'Start the reviewer with the family of the model it runs.');
      if (readLines<ReviewRecord>(c.ledger, 'reviews.jsonl').some((r) => r.change === ch.id && familyOfReview(r) === c.session.family)) return refuse(`${c.session.family} has already reviewed this change`, 'If something new turned up, block on the next change, or tell the builder.');
      const tree = (c.factory ? git(c, 'rev-parse', `${ch.commit}^{tree}`).stdout.trim() : '') || treeOfChange(c.ledger, ch.id);
      const evidence: ReviewEvidence | undefined = c.answer?.response && tree ? { provider: c.answer.provider, model: c.answer.model, response: c.answer.response, tree } : undefined;
      const checked = i['checked'] as string[];
      const findings = i['findings'] as ReviewRecord['findings'];
      if (i['verdict'] === 'pass' && !checked.length) return refuse('a pass that says nothing about what was checked is not a review', 'List what you verified.');
      if (i['verdict'] === 'block' && !findings.some((f) => f.severity === 'blocking')) return refuse('a block needs a blocking finding', 'Name it, or pass with the findings as major or minor.');
      append(c.ledger, 'reviews.jsonl', { change: ch.id, verdict: i['verdict'] as 'pass' | 'block', checked, findings, by: c.session, at: c.ledger.now(), ...(evidence ? { evidence } : {}) } satisfies ReviewRecord);
      const blocking = findings.filter((f) => f.severity === 'blocking');
      const kase = i['verdict'] === 'block' ? failure(c.ledger, { kind: 'review', ref: c.session.family, change: ch.id }, `blocked by ${c.session.family}: ${blocking.map((f) => f.what).join('; ')}`, blocking.length, ch.revision, ch.case, c.session) : null;
      closeFixed(c.ledger, (id) => admission(c.ledger, id).admitted);
      return { recorded: true, admission: admission(c.ledger, ch.id), ...(kase ? { case: kase } : {}) };
    },
  },
  {
    name: 'admission',
    kind: 'read',
    roles: 'all',
    phase: 'review',
    description: 'Whether a change is admitted, and what is missing or blocking. Computed from the checks the API ran and the reviews recorded; no role can admit a change.',
    next: 'The builder fixes what blocks it; reviewers fill the reviews still missing.',
    input: obj({ change: text('The change id.', 40) }, ['change']),
    handle: (c, i) => admission(c.ledger, String(i['change'])),
  },

  // ---------------------------------------------------------------- deliver
  {
    name: 'deploy_plan',
    kind: 'read',
    roles: ['operator', 'pipeline'],
    phase: 'deliver',
    description: 'The delivery stages in order, what each proves and its gate, and where every admitted change stands.',
    next: 'Request the next stage with deploy_advance.',
    input: NONE,
    handle: (c) => ({ stages: STAGES, changes: changes(c.ledger).filter((ch) => admission(c.ledger, ch.id).admitted).map((ch) => ({ id: ch.id, title: ch.title, ...deliveryOf(c.ledger, ch.id) })) }),
  },
  {
    name: 'deploy_advance',
    kind: 'act',
    roles: ['operator'],
    phase: 'deliver',
    description: "Request the next delivery stage for an admitted change. Stages go in order, each after the pipeline has recorded the last as passed. Release to everyone needs a person's approval in production. The pipeline runs the stage under its own identity; you never hold its credentials.",
    next: 'Wait for the pipeline to record the result, then request the next stage, or roll back.',
    input: obj({ change: text('The change id.', 40), stage: { type: 'string', enum: STAGE_IDS } }, ['change', 'stage']),
    handle: (c, i) => {
      const id = String(i['change']);
      const a = admission(c.ledger, id);
      if (!a.admitted) return refuse(`${id} is not admitted: ${[...a.blocking, ...a.missing].join('; ')}`, 'Nothing is delivered until it is admitted.');
      const d = deliveryOf(c.ledger, id);
      const want = STAGE_IDS[d.reached ? STAGE_IDS.indexOf(d.reached) + 1 : 0];
      if (d.waiting) return refuse(`${d.waiting} is already requested and has no result yet`, 'Wait for the pipeline to record it.');
      if (i['stage'] !== want) return refuse(`the next stage for ${id} is ${want ?? 'none: it is in operation'}, not ${String(i['stage'])}`, 'Stages go in order; none is skipped.');
      if (want === 'release' && !productionApproval(c.ledger, id)) return refuse('release to everyone needs a named person’s approval in production', 'Call production_request with what the canary showed; a person signs it.');
      append(c.ledger, 'deploy.jsonl', { change: id, revision: changeOf(c.ledger, id)!.revision, stage: want!, kind: 'requested', by: c.session, at: c.ledger.now() } satisfies DeployRecord);
      return { requested: want, gate: STAGES.find((s) => s.id === want)!.gate, runsAs: 'the pipeline’s own service identity' };
    },
  },
  {
    name: 'production_request',
    kind: 'propose',
    roles: ['operator'],
    phase: 'deliver',
    description: 'Ask a person to approve a change in production, once its canary has passed. Say what the canary showed: the share of people, the time, and every service level against its budget.',
    next: 'When it is signed, request the release stage.',
    input: obj({ change: text('The change id.', 40), evidence: text('What the canary showed.', 4000) }, ['change', 'evidence']),
    handle: (c, i) => {
      const id = String(i['change']);
      if (deliveryOf(c.ledger, id).reached !== 'canary') return refuse('the canary has not passed for this change', 'Request the canary stage and wait for the pipeline’s result.');
      const p = propose(c.ledger, c.session, 'production', `Approve in production: ${changeOf(c.ledger, id)!.title}`, String(i['evidence']), { change: id });
      return { proposal: p.id, waitsFor: 'a named person who may approve production' };
    },
  },
  {
    name: 'deploy_rollback',
    kind: 'act',
    roles: ['operator'],
    phase: 'operate',
    description: 'Send traffic back to the previous revision, at once. Always allowed: going back is the safe direction. Say why; the change starts delivery again from the first stage when it is fixed.',
    next: 'Ask the triager to open a defect for the cause, so it becomes a test and a ratchet.',
    input: obj({ change: text('The change id.', 40), why: text('What was seen.', 2000) }, ['change', 'why']),
    handle: (c, i) => {
      const id = String(i['change']);
      const ch = changeOf(c.ledger, id) ?? refuse(`no change ${id}`, 'Call deploy_plan.');
      append(c.ledger, 'deploy.jsonl', { change: id, revision: ch.revision, stage: 'rollback', kind: 'rollback', detail: String(i['why']), by: c.session, at: c.ledger.now() } satisfies DeployRecord);
      return { rolledBack: id, runsAs: 'the pipeline’s own service identity', runbook: 'ops/runbook.md' };
    },
  },
  {
    name: 'stage_record',
    kind: 'act',
    roles: ['pipeline'],
    phase: 'deliver',
    description: 'Record what a requested stage proved, with the build that proved it. Only the pipeline records results.',
    next: 'The operator requests the next stage.',
    input: obj({ change: text('The change id.', 40), stage: { type: 'string', enum: STAGE_IDS }, ok: { type: 'boolean' }, build: text('The build id.', 200), detail: text('What it proved, or why it failed.', 4000) }, ['change', 'stage', 'ok', 'build']),
    handle: (c, i) => {
      const id = String(i['change']);
      if (deliveryOf(c.ledger, id).waiting !== i['stage']) return refuse(`${String(i['stage'])} was not requested for ${id}`, 'Record only what was requested.');
      const ch = changeOf(c.ledger, id)!;
      append(c.ledger, 'deploy.jsonl', { change: id, revision: ch.revision, stage: String(i['stage']), kind: 'result', ok: Boolean(i['ok']), build: String(i['build']), detail: String(i['detail'] ?? ''), by: c.session, at: c.ledger.now() } satisfies DeployRecord);
      const kase = i['ok'] ? null : failure(c.ledger, { kind: 'stage', ref: String(i['stage']), change: id }, `${String(i['stage'])} failed for ${id}: ${String(i['detail'] ?? '')}`.slice(0, 500), 1, ch.revision, ch.case, c.session);
      return { recorded: true, delivery: deliveryOf(c.ledger, id), ...(kase ? { case: kase } : {}) };
    },
  },
  {
    name: 'watch',
    kind: 'read',
    roles: ['operator'],
    phase: 'operate',
    description: 'The service levels the schematic sets: availability, the feedback budget, and each outcome’s target in use, with where each comes from.',
    next: 'An alert that burns a budget opens an incident: roll back first, then ask for a defect.',
    input: NONE,
    handle: (c) => objectives(prepared(c)),
  },

  // ---------------------------------------------------------------- operate: what people report
  {
    name: 'tickets_list',
    kind: 'read',
    roles: ['triager', 'builder'],
    phase: 'operate',
    description: 'What people reported, with where each stands. Their words are shown exactly as written.',
    next: 'Triage what is new: set status and severity, mark duplicates, turn bugs into defects and ideas into proposals.',
    input: obj({ status: { type: 'string', enum: ['new', 'triaged', 'in progress', 'resolved', 'duplicate', 'not a problem'] } }),
    handle: (c, i) => ({ tickets: tickets(c.ledger).filter((t) => !i['status'] || t.status === i['status']).map((t) => ({ id: t.id, kind: t.filed.kind, title: t.filed.title, happened: t.filed.happened, expected: t.filed.expected, where: t.filed.where, status: t.status, severity: t.severity, duplicateOf: t.duplicateOf, defects: t.defects })) }),
  },
  {
    name: 'ticket_triage',
    kind: 'act',
    roles: ['triager'],
    phase: 'operate',
    description: "Set a report's status, severity or note. A duplicate names the report it duplicates; resolved names the evidence: a commit, a test or a revision. What the reporter wrote cannot be changed, and no report is deleted.",
    next: 'For a bug, call ticket_defect; for an idea, ticket_idea.',
    input: obj(
      {
        ticket: text('The ticket id.', 100),
        status: { type: 'string', enum: ['triaged', 'in progress', 'resolved', 'duplicate', 'not a problem'] },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        note: text('A note the reporter sees.', 2000),
        duplicateOf: text('The ticket this one repeats.', 100),
        evidence: text('For resolved: "commit <sha>", "test <name>" or "revision <n>".', 300),
      },
      ['ticket'],
    ),
    handle: (c, i) => {
      const all = tickets(c.ledger);
      const t = all.find((x) => x.id === i['ticket']) ?? refuse(`no ticket ${String(i['ticket'])}`, 'Call tickets_list.');
      if (i['status'] === 'duplicate' && (!i['duplicateOf'] || i['duplicateOf'] === t.id || !all.some((x) => x.id === i['duplicateOf']))) return refuse('a duplicate names another report that exists', 'Give duplicateOf.');
      if (i['status'] === 'resolved' && !/^(commit [0-9a-f]{7,40}|test \S.*|revision \d+)$/.test(String(i['evidence'] ?? ''))) return refuse('resolved needs evidence', 'Give "commit <sha>", "test <name>" or "revision <n>".');
      if (i['status'] === 'resolved' && t.filed.kind === 'bug' && !t.defects.length) return refuse('a bug is resolved by a test that failed and now passes', 'Call ticket_defect first, so the fix is held by a test.');
      const { ticket: _, ...rest } = i;
      append(c.ledger, 'tickets.jsonl', { ticket: t.id, event: 'triaged', at: c.ledger.now(), by: `${c.session.agent} (${c.session.family})`, ...rest } as TicketEvent);
      return { ticket: tickets(c.ledger).find((x) => x.id === t.id)!.status };
    },
  },
  {
    name: 'ticket_defect',
    kind: 'act',
    roles: ['triager'],
    phase: 'operate',
    description: 'Turn a confirmed bug into a defect for builders: the name of the failing test to write first and what it must expect.',
    next: 'Builders see it in defects. Resolve the report once the change that fixes it is admitted.',
    input: obj({ ticket: text('The ticket id.', 100), test: text('The failing test to write, named for what it proves.', 300), expectation: text('What the test expects, in a sentence.', 1000) }, ['ticket', 'test', 'expectation']),
    handle: (c, i) => {
      const t = tickets(c.ledger).find((x) => x.id === i['ticket']) ?? refuse(`no ticket ${String(i['ticket'])}`, 'Call tickets_list.');
      if (t.filed.kind !== 'bug') return refuse(`this report is a ${t.filed.kind}, not a bug`, t.filed.kind === 'idea' ? 'Call ticket_idea.' : 'Reply with a note instead.');
      append(c.ledger, 'tickets.jsonl', { ticket: t.id, event: 'defect', at: c.ledger.now(), by: c.session.agent, test: String(i['test']), expectation: String(i['expectation']) } as TicketEvent);
      const kase = failure(c.ledger, { kind: 'ticket', ref: t.id }, `${t.filed.title}: write "${String(i['test'])}" first`, 1, released(c)?.revision ?? 0, undefined, c.session);
      event(c.ledger, { case: kase, event: 'diagnosed', by: c.session, cause: 'bug', evidence: String(i['expectation']) });
      return { defect: String(i['test']), for: 'builders', case: kase };
    },
  },
  {
    name: 'ticket_idea',
    kind: 'propose',
    roles: ['triager'],
    phase: 'operate',
    description: 'Carry an idea from a report to the person who holds the intent, as a proposed change to it. The intent changes only if they sign it.',
    next: 'Mark the report triaged with a note saying it went to them.',
    input: obj({ ticket: text('The ticket id.', 100), change: text('What would change in the intent, in their terms.', 2000) }, ['ticket', 'change']),
    handle: (c, i) => {
      const t = tickets(c.ledger).find((x) => x.id === i['ticket']) ?? refuse(`no ticket ${String(i['ticket'])}`, 'Call tickets_list.');
      const p = propose(c.ledger, c.session, 'intent', `From a report: ${t.filed.title}`, String(i['change']), { ticket: t.id, change: String(i['change']) });
      append(c.ledger, 'tickets.jsonl', { ticket: t.id, event: 'idea', at: c.ledger.now(), by: c.session.agent, proposal: p.id } as TicketEvent);
      return { proposal: p.id, waitsFor: 'the person who holds the intent' };
    },
  },

  // ---------------------------------------------------------------- correction: the loop that does not ask
  {
    name: 'agenda',
    kind: 'read',
    roles: 'all',
    phase: 'any',
    description: 'What is waiting on your role now, most urgent first, and whether spending is paused. A supervisor wakes an agent only when its agenda is not empty, so an idle seat costs nothing.',
    next: 'Do the first item. Call agenda again when it is done.',
    input: NONE,
    handle: (c) => agendaFor(c),
  },
  {
    name: 'cases',
    kind: 'read',
    roles: 'all',
    phase: 'any',
    description: 'Correction cases: every failure the factory saw, its diagnosis, who it waits on, its attempts and whether it is converging.',
    next: 'Take the cases waiting on your role.',
    input: obj({ open: { type: 'boolean', description: 'Only cases not closed (default true).' } }),
    handle: (c, i) => ({ cases: cases(c.ledger).filter((k) => i['open'] === false || k.status !== 'closed').map((k) => ({ id: k.id, summary: k.opened.summary, source: k.opened.source, cause: k.cause, waiting: k.waiting, status: k.status, attempts: k.attempts, trend: k.trend, clarifications: k.clarifications, last: k.events.at(-1)!.why ?? k.events.at(-1)!.summary ?? null })) }),
  },
  {
    name: 'case_diagnose',
    kind: 'act',
    roles: ['builder'],
    phase: 'build',
    description: 'Say what caused a failure. bug: the work misses a datum that is clear. intent: the datum is unclear or silent where the work needs it. infeasible: the intent cannot be met as signed. factory: the factory itself is wrong. Anything but a bug names the balloons and is confirmed by a reviewer of another family.',
    next: 'For a bug, fix it test first and open a change with this case. Otherwise wait for confirmation.',
    input: obj({ case: text('The case id.', 40), cause: { type: 'string', enum: ['bug', 'intent', 'infeasible', 'factory'] }, balloons: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 20, description: 'The balloons the failure turns on.' }, evidence: text('What in the failure shows it: the check output, the finding, the gauge.', 3000) }, ['case', 'cause', 'evidence']),
    handle: (c, i) => {
      const k = caseOf(c.ledger, String(i['case'])) ?? refuse(`no case ${String(i['case'])}`, 'Call cases.');
      if (k.waiting !== 'builder: diagnose') return refuse(`case ${k.id} is waiting on ${k.waiting}`, 'Diagnose only cases waiting on a diagnosis.');
      const cause = i['cause'] as Cause;
      const balloons = (i['balloons'] as number[] | undefined) ?? [];
      if (cause !== 'bug' && !balloons.length) return refuse(`a diagnosis of ${cause} names the balloons it turns on`, 'Cite the balloon numbers from the schematic, or diagnose a bug.');
      const known = new Set(prepared(c).statements.map((x) => x.balloon));
      const unknown = balloons.filter((b) => !known.has(b));
      if (unknown.length) return refuse(`no balloon ${unknown.join(', ')} on the schematic`, 'Call schematic for the numbers.');
      event(c.ledger, { case: k.id, event: 'diagnosed', by: c.session, cause, balloons, evidence: String(i['evidence']) });
      return { case: k.id, waiting: caseOf(c.ledger, k.id)!.waiting };
    },
  },
  {
    name: 'case_confirm',
    kind: 'act',
    roles: ['reviewer'],
    phase: 'review',
    description: 'Agree or disagree with a diagnosis that blames the intent or the factory. You must be of another family than the agent that diagnosed it. Disagreeing sends it back as a bug.',
    next: 'Call agenda.',
    input: obj({ case: text('The case id.', 40), agree: { type: 'boolean' }, why: text('What you read in the datum that decides it.', 2000) }, ['case', 'agree', 'why']),
    handle: (c, i) => {
      const k = caseOf(c.ledger, String(i['case'])) ?? refuse(`no case ${String(i['case'])}`, 'Call cases.');
      if (k.waiting !== 'reviewer: confirm') return refuse(`case ${k.id} is waiting on ${k.waiting}`, 'Confirm only cases waiting on confirmation.');
      if (k.diagnosedBy && (k.diagnosedBy.family === c.session.family || k.diagnosedBy.agent === c.session.agent)) return refuse(`${c.session.family} diagnosed this case`, 'A reviewer of another family confirms it.');
      if (i['agree'] !== true) {
        event(c.ledger, { case: k.id, event: 'disputed', by: c.session, why: String(i['why']) });
        return { case: k.id, waiting: 'builder: fix' };
      }
      event(c.ledger, { case: k.id, event: 'confirmed', by: c.session, why: String(i['why']) });
      if (k.cause === 'factory') {
        append(c.ledger, 'upstream.jsonl', { case: k.id, at: c.ledger.now(), summary: k.opened.summary, evidence: k.events.find((e) => e.event === 'diagnosed')?.evidence ?? '' });
        event(c.ledger, { case: k.id, event: 'upstream', by: c.session, why: 'reported into the factory’s own intent, which is revised the same way' });
      }
      if (k.cause === 'infeasible') {
        const p = propose(c.ledger, c.session, 'intent', `Cannot be met as signed: ${k.opened.summary ?? k.id}`.slice(0, 120), String(i['why']), { case: k.id, balloons: k.events.find((e) => e.event === 'diagnosed')?.balloons ?? [] });
        event(c.ledger, { case: k.id, event: 'escalated', by: c.session, proposal: p.id, why: 'two families agree the intent cannot be met as signed' });
      }
      return { case: k.id, waiting: caseOf(c.ledger, k.id)!.waiting };
    },
  },
  {
    name: 'clarify',
    kind: 'act',
    roles: ['steward'],
    phase: 'intent',
    description: 'Clarify the intent for a confirmed case, with examples and engineering notes only. The API drafts the next revision and compares it with the signed one. Class II (nothing signed is removed, reworded, loosened or re-marked, and no scope is added) is issued at once under the person’s delegation, and the builder goes again. Class I goes to the person with the draft and the reasons.',
    next: 'If it was issued, the case waits on the builder. If it was escalated, carry on with other work.',
    input: obj(
      {
        case: text('The case id.', 40),
        examples: { type: 'array', maxItems: 10, items: obj({ given: text('The situation.', 500), when: text('What happens.', 500), then: text('What must follow.', 500) }, ['when', 'then']) },
        notes: texts('Engineering notes: how, for now. They never change what it must do.', 10),
      },
      ['case'],
    ),
    handle: (c, i) => {
      const k = caseOf(c.ledger, String(i['case'])) ?? refuse(`no case ${String(i['case'])}`, 'Call cases.');
      if (k.waiting !== 'steward: clarify') return refuse(`case ${k.id} is waiting on ${k.waiting}`, 'Clarify only confirmed intent cases.');
      const ex = (i['examples'] as { given?: string; when: string; then: string }[] | undefined) ?? [];
      const notes = (i['notes'] as string[] | undefined) ?? [];
      if (!ex.length && !notes.length) return refuse('a clarification says something', 'Give at least one example or note.');
      const md = `${ex.length ? `\n## Examples\n\n${ex.map((e) => `- ${e.given ? `Given ${e.given}, when` : 'When'} ${e.when}, then ${e.then}`).join('\n')}\n` : ''}${notes.length ? `\n## Engineering notes\n\n${notes.map((n) => `- ${n}`).join('\n')}\n` : ''}`;
      const last = released(c) ?? refuse('nothing has been released to clarify', 'Issue the first revision first.');
      const before = readJson<DatumLike>(join(releaseDir(c, last.revision), 'datum.json'));
      const path = join(c.workspace, 'sources', CLARIFICATIONS);
      const was = existsSync(path) ? readFileSync(path, 'utf8') : null;
      writeFileSync(path, `${was ?? ''}${md}`);
      const restore = () => (was === null ? rmSync(path) : writeFileSync(path, was));
      let verdict: ReturnType<typeof classify>;
      try {
        const draft = release(prepared(c), { revision: last.revision + 1, prior: { revision: last.revision, datum: before as never }, reason: `clarification for ${k.id}` });
        verdict = classify(before, JSON.parse(draft.files['datum.json']!) as DatumLike, last.revision + 1);
      } catch (e) {
        restore();
        throw e;
      }
      const d = delegation(c.ledger);
      if (verdict.klass === 'II' && d.classII) {
        const r = issue({ dir: c.workspace }, `Class II clarification for case ${k.id}: ${verdict.made.join('; ') || 'examples and notes'}`, head(c.ledger));
        event(c.ledger, { case: k.id, event: 'clarified', by: c.session, revision: r.revision, why: verdict.made.join('; ') });
        return { class: 'II', issued: r.revision, made: verdict.made, waiting: 'builder: fix' };
      }
      restore();
      const p = propose(c.ledger, c.session, 'clarification', `Clarify for case ${k.id}`, verdict.klass === 'I' ? `Class I: ${verdict.reasons.join('; ')}` : 'Class II, but no standing delegation lets the factory issue it', { case: k.id, append: md, class: verdict.klass, reasons: verdict.reasons, made: verdict.made });
      event(c.ledger, { case: k.id, event: 'escalated', by: c.session, proposal: p.id, why: verdict.klass === 'I' ? `Class I: ${verdict.reasons.join('; ')}` : 'no delegation for Class II' });
      return { class: verdict.klass, escalated: p.id, reasons: verdict.reasons };
    },
  },
];


/** What waits on the session's role, most urgent first. Empty means: do not wake this agent. */
function agendaFor(c: Context) {
  const l = c.ledger;
  const role = c.session.role;
  const spend = budgetState(l);
  const items: { do: string; tool: string; ref?: string }[] = [];
  const ks = cases(l).filter((k) => k.status === 'open');
  const add = (x: { do: string; tool: string; ref?: string }) => items.push(x);
  if (role === 'reader') {
    const mine = existsSync(join(c.workspace, 'readings', `${c.session.family}.json`));
    const n = readdirSync(join(c.workspace, 'readings')).filter((f) => f.endsWith('.json')).length;
    if (!mine && n < 2) add({ do: 'read the intent', tool: 'reading_context' });
  }
  if (role === 'steward') {
    for (const k of ks.filter((x) => x.waiting === 'steward: clarify')) add({ do: `clarify for ${k.opened.summary ?? k.id}`, tool: 'clarify', ref: k.id });
    const p = prepared(c);
    const asked = new Set(proposals(l).filter((x) => x.kind === 'answer' && !decisionOn(l, x.id)).map((x) => String(x.body['question'])));
    const open = p.questions.filter((q) => !asked.has(q.id)).length;
    if (open && !p.unread.length) add({ do: `${open} open question(s): draft what the sources settle`, tool: 'questions' });
    const last = released(c);
    if (!p.unread.length && (!last || (!p.questions.length && !last.ready))) add({ do: last ? 'issue the next revision' : 'issue the first revision', tool: 'release_issue' });
  }
  if (role === 'builder') {
    for (const k of ks.filter((x) => x.waiting === 'builder: diagnose')) add({ do: `diagnose: ${k.opened.summary}`, tool: 'case_diagnose', ref: k.id });
    for (const k of ks.filter((x) => x.waiting === 'builder: fix')) add({ do: `fix, test first: ${k.opened.summary}`, tool: 'change_open', ref: k.id });
    const last = released(c);
    if (last && !changes(l).some((ch) => ch.revision === last.revision)) add({ do: `build revision ${last.revision}`, tool: 'build_plan' });
  }
  if (role === 'reviewer') {
    for (const k of ks.filter((x) => x.waiting === 'reviewer: confirm' && x.diagnosedBy?.family !== c.session.family)) add({ do: `confirm or dispute: ${k.cause} on ${k.opened.summary}`, tool: 'case_confirm', ref: k.id });
    const q = (TOOLS.find((t) => t.name === 'review_queue')!.handle(c, {}) as { changes: { id: string; title: string }[] }).changes;
    for (const ch of q) add({ do: `review ${ch.title}`, tool: 'review_submit', ref: ch.id });
  }
  if (role === 'operator') {
    for (const ch of changes(l).filter((x) => admission(l, x.id).admitted)) {
      const d = deliveryOf(l, ch.id);
      if (d.waiting || d.reached === 'operate') continue;
      const next = STAGE_IDS[d.reached ? STAGE_IDS.indexOf(d.reached) + 1 : 0]!;
      if (next === 'release' && !productionApproval(l, ch.id)) {
        if (!proposals(l).some((p) => p.kind === 'production' && p.body['change'] === ch.id && !decisionOn(l, p.id))) add({ do: `ask a person to approve ${ch.title} in production`, tool: 'production_request', ref: ch.id });
      } else add({ do: `request ${next} for ${ch.title}`, tool: 'deploy_advance', ref: ch.id });
    }
  }
  if (role === 'triager') for (const t of tickets(l).filter((x) => x.status === 'new')) add({ do: `triage: ${t.filed.title}`, tool: 'ticket_triage', ref: t.id });
  if (role === 'pipeline') for (const ch of changes(l)) { const d = deliveryOf(l, ch.id); if (d.waiting) add({ do: `run ${d.waiting} for ${ch.title}`, tool: 'stage_record', ref: ch.id }); }
  return { role, paused: spend.paused, spend, items: spend.paused ? [] : items, waitingOnAPerson: proposals(l).filter((x) => !decisionOn(l, x.id)).length };
}

// ------------------------------------------------------------------ dispatch

export const toolsFor = (role: Role): Tool[] => TOOLS.filter((t) => t.roles === 'all' || t.roles.includes(role));

/** The guide for a role, as the guide tool and the resources serve it. Set by the guide module. */
let guideFor: (r: Role) => string = (r) => r;
export const setGuide = (g: (r: Role) => string) => {
  guideFor = g;
};

function validate(s: Schema, v: unknown, at: string, out: string[]): void {
  const t = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
  const want = s.type === 'integer' ? 'number' : s.type;
  if (t !== want || (s.type === 'integer' && !Number.isInteger(v))) {
    out.push(`${at} must be ${s.type}`);
    return;
  }
  if (s.enum && !s.enum.includes(v as string)) out.push(`${at} must be one of ${s.enum.join(', ')}`);
  if (s.type === 'string' && s.maxLength && (v as string).length > s.maxLength) out.push(`${at} is longer than ${s.maxLength} characters`);
  if (s.type === 'number' || s.type === 'integer') if (s.minimum !== undefined && (v as number) < s.minimum) out.push(`${at} must be at least ${s.minimum}`);
  if (s.type === 'array') {
    if (s.maxItems && (v as unknown[]).length > s.maxItems) out.push(`${at} has more than ${s.maxItems} items`);
    (v as unknown[]).forEach((x, k) => s.items && validate(s.items, x, `${at}[${k}]`, out));
  }
  if (s.type === 'object' && s.properties) {
    const o = v as Record<string, unknown>;
    for (const r of s.required ?? []) if (o[r] === undefined) out.push(`${at}.${r} is required`);
    for (const [k, x] of Object.entries(o)) {
      const ps = s.properties[k];
      if (!ps) {
        if (s.additionalProperties === false) out.push(`${at}.${k} is not an input of this tool`);
      } else validate(ps, x, `${at}.${k}`, out);
    }
  }
}

export type Result = { ok: true; value: unknown } | { ok: false; refused: true; why: string; instead: string } | { ok: false; refused: false; why: string };

/** Call one tool as the session's role. Refuses tools the role does not have, bad input, and anything credential-shaped. */
export function call(c: Context, name: string, input: Record<string, unknown> = {}): Result {
  const tool = TOOLS.find((t) => t.name === name);
  const raw = JSON.stringify(input);
  const done = (outcome: 'ok' | 'refused' | 'error', why?: string) => log(c.ledger, { session: c.session, tool: name, input: sha256(raw).slice(0, 16), outcome, ...(why ? { why } : {}) });
  const no = (why: string, instead: string): Result => {
    done('refused', why);
    return { ok: false, refused: true, why, instead };
  };
  if (!tool) return no(`there is no tool ${name}`, 'Call guide for your tools.');
  if (tool.roles !== 'all' && !tool.roles.includes(c.session.role)) return no(`${/^[aeiou]/.test(c.session.role) ? 'an' : 'a'} ${c.session.role} does not ${name}`, `It belongs to: ${tool.roles.join(', ')}.`);
  const secret = scan(raw, 'input');
  if (secret.length) return no(`the input holds something shaped like a ${secret[0]!.shape}`, 'Never pass a credential. Name the secret by its Secret Manager name instead.');
  const problems: string[] = [];
  validate(tool.input, input, 'input', problems);
  if (problems.length) return no(problems.join('; '), 'Fix the input to match the tool’s schema.');
  try {
    const value = tool.handle(c, input);
    done('ok');
    return { ok: true, value };
  } catch (e) {
    if (e instanceof Refused) return no(e.why, e.instead);
    done('error', (e as Error).message);
    return { ok: false, refused: false, why: (e as Error).message };
  }
}

/**
 * For git's pre-push hook: every commit being pushed must have passed the pre-push checks on its exact tree, as the
 * API recorded them. Returns what is missing; empty means the push may go. The hook is a convenience: the gate that
 * holds is admission, which no push can pass without every check run by the API.
 */
export function prepushGaps(l: Ledger, trees: readonly { sha: string; tree: string }[]): string[] {
  const runs = readLines<CheckRun>(l, 'checks.jsonl');
  return trees.flatMap(({ sha, tree }) => PREPUSH.filter((step) => !runs.some((r) => r.tree === tree && r.step === step && r.ok)).map((step) => `${sha.slice(0, 12)}: ${step} has not passed on this tree`));
}

/** The input schemas in the shape model tool-use APIs take, for agents that do not speak MCP. */
export const toolDefinitions = (role: Role) => toolsFor(role).map((t) => ({ name: t.name, description: `${t.description} Next: ${t.next}`, input_schema: t.input }));

/** For a person: apply a signed answer to the workspace, so the next preparation reads it as theirs. */
export function applySigned(workspace: string, proposal: { kind: string; body: Record<string, unknown> }): string {
  if (proposal.kind === 'answer') {
    const path = join(workspace, 'answers.json');
    const all = { ...readJson<Record<string, Given>>(path), [String(proposal.body['question'])]: proposal.body['answer'] as Given };
    writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`);
    return 'recorded as your answer';
  }
  if (proposal.kind === 'journey') {
    const dir = join(workspace, 'agents', 'journeys-signed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${String(proposal.body['id'])}.json`), `${JSON.stringify(proposal.body, null, 2)}\n`);
    return 'signed; lock it into control/journeys in the factory with npm run lock, in a commit GitHub verifies';
  }
  if (proposal.kind === 'clarification') {
    const path = join(workspace, 'sources', CLARIFICATIONS);
    writeFileSync(path, `${existsSync(path) ? readFileSync(path, 'utf8') : ''}${String(proposal.body['append'])}`);
    const l = ledgerOf(workspace);
    const r = issue({ dir: workspace }, `Clarification for case ${String(proposal.body['case'])}, signed by a person`, head(l));
    event(l, { case: String(proposal.body['case']), event: 'clarified', by: 'the factory', revision: r.revision, why: 'signed by a person' });
    return `issued as revision ${r.revision}; the builder goes again`;
  }
  return 'signed';
}

