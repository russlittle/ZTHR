import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { join } from 'node:path';
import { EvidenceStore } from '@zthr/evidence';
import { type Gate, type Proof, type RegisteredFinding, checkRegister, fail, pass, proveGate, runProvenGate, type Verdict } from '@zthr/gates';
import { loadCards, lockVerdict, type Lock } from '@zthr/intent';
import { ApprovalService, OutboundGate, screen as realScreen, type OutboundAction, type SafetyResult } from '@zthr/runtime';
import { randomBytes } from 'node:crypto';
import { Advocate } from '../apps/advocate/src/agents/advocate.js';
import { DAYTON_CATALOG } from '../apps/advocate/src/catalog/dayton.js';
import type { Resource } from '../apps/advocate/src/catalog/types.js';
import { checkTone } from '../apps/advocate/src/domain/tone.js';
import { snap } from '../apps/advocate/src/eligibility/engine.js';
import { Community, moderate } from '../apps/advocate/src/domain/community.js';
import { SNAP_FY2027 } from '../apps/advocate/src/eligibility/params.js';
import type { OutboundMessage, Student } from '../apps/advocate/src/domain/types.js';
import type { ActionResult } from '../apps/advocate/src/agents/actions.js';
import { CONTROL, JOURNEY_DIR, OUT, ROOT, readLock } from './lib.js';
import { links, type Links } from './doc-links.js';
import { r2t4, HANDBOOK_CASE_2, type PaymentPeriod, type AidDisbursed, type R2T4Result } from '../apps/advocate/src/domain/r2t4.js';
import { sap, type AcademicPolicy, type SapResult, type TranscriptCourse } from '../apps/advocate/src/domain/academics.js';
import { COLLEGES } from '../apps/advocate/src/domain/colleges.js';
import * as academics from '../apps/advocate/src/agents/academics.js';
import { PERSONAS } from '../apps/advocate/src/server/demo.js';
import { createApp } from '../apps/advocate/src/server/app.js';
import { admit } from '../apps/advocate/src/guide/admission.js';
import { Feed, feed as guideFeed } from '../apps/advocate/src/guide/feed.js';
import * as B from '../apps/advocate/src/guide/barriers.js';

/**
 * Every named gate states what it protects, carries the planted defects that
 * prove it can fail, and is run only with a proof pinned to its current
 * definition (Pattern 8). A gate whose proof is missing or stale reports
 * unknown, which never admits.
 */
const DAY = '2026-11-02';
const def = (fn: (...a: never[]) => unknown) => fn.toString();

// ---- subjects ----

type MessageSet = OutboundMessage[];
const sampleStudent = (a: Advocate) =>
  a.createStudent({ chosenName: 'Gate', zip: '45402', household: { size: 2, monthlyGrossIncome: 1500 }, enrollment: { college: 'sinclair', creditHours: 12, weeklyWorkHours: 20, degreeSeeking: true } });

function productMessages(): MessageSet {
  const a = new Advocate({ today: () => DAY });
  const s = sampleStudent(a);
  a.addDeadline(s.id, { title: 'Essay 2', course: 'ENG 1101', due: '2026-11-05', kind: 'assignment', effortHours: 8, source: { type: 'student' }, confirmed: true });
  a.addDeadline(s.id, { title: 'Lab 3', course: 'BIO 1111', due: '2026-10-30', kind: 'assignment', effortHours: 3, source: { type: 'student' }, confirmed: true });
  a.setMoney(s.id, 100, [{ name: 'Rent', amount: 900, dueDay: 1, kind: 'rent' }], { amount: 300, next: '2026-11-20', everyDays: 14 });
  const crisis = (['eviction', 'utility-shutoff', 'car', 'no-food', 'rent-short'] as const).map((x) => a.crisis(s.id, x).message);
  const school = (['Destiny', 'Tyler', 'Linda', 'Priya', 'Maria'] as const).flatMap((n) => {
    const id = PERSONAS[n]!(a).id;
    return [academics.schoolMessage(a, id), academics.finalNeedMessage(a, id), academics.aidProgressMessage(a, id), academics.dropMessage(a, id), academics.degreeMessage(a, id)];
  });
  return [...school, a.todayMessage(s.id), ...a.lookAhead(s.id), a.moneyCheck(s.id)!, a.moneyFoundMessage(s.id), ...crisis, a.helpMessage(s.id, 'food'), a.helpMessage(s.id, 'caregiving'), a.explainMessage(s.id, 'what is a registrar')!, a.guideMessage(s.id, 'how do I sign a lease')!].filter(Boolean);
}

interface Dispatcher {
  dispatch: (a: OutboundAction, token: undefined) => Promise<{ sent: boolean }>;
  sent: OutboundAction[];
}
const realDispatcher = (): Dispatcher => {
  const sent: OutboundAction[] = [];
  const gate = new OutboundGate(new ApprovalService(randomBytes(32)), async (x) => void sent.push(x));
  return { dispatch: (a, t) => gate.dispatch(a, t), sent };
};

const HELD_OUT_CRISIS = readFileSync(`${CONTROL}/heldout/crisis.txt`, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

type FindFn = (catalog: Resource[]) => string[];
const realFind: FindFn = (catalog) => {
  const a = new Advocate({ today: () => DAY, catalog });
  return a.findHelp(sampleStudent(a).id, 'food').options.map((o) => o.resource.id);
};
const staleCatalog = () => DAYTON_CATALOG.map((r) => (r.id === 'house-of-bread' ? { ...r, verifiedOn: '2025-06-01' } : r));

type SealedProbe = { sealedValue: string; messages: string[] };
const realSealedProbe = (): SealedProbe => {
  const a = new Advocate({ today: () => DAY });
  const s = sampleStudent(a);
  const sealedValue = 'released from prison in March, on parole';
  a.seal(s.id, 'justice_involvement', sealedValue);
  const out = [...a.converse(s.id, 'I need food'), ...a.converse(s.id, 'today'), ...a.converse(s.id, 'what do I qualify for')].map((m) => m.text);
  return { sealedValue, messages: out };
};

type EvidenceProbe = { ids: string[]; dump: string };
const realEvidenceProbe = (): EvidenceProbe => {
  const a = new Advocate({ today: () => DAY });
  const s = sampleStudent(a);
  a.converse(s.id, 'I need food');
  a.textIn('+19375550000', 'hi');
  return { ids: [s.id, s.chosenName, '+19375550000', s.zip], dump: JSON.stringify(a.evidence.events()) };
};

const STATUS_Q = /\b(what is your|are you a|do you have|tell me your|enter your)\b[^.?]*\b(citizen(ship)?|immigration|legal status|green card|visa|social security)\b/i;
const onboardingPrompts = (): string[] => {
  const a = new Advocate({ today: () => DAY });
  const out: string[] = [];
  for (const t of ['hi', 'Sinclair 45402', '3 people, $2000', '12 credits, 20 hours', 'Sam']) out.push(...a.textIn('+19375550001', t));
  for (const t of ['I need food', 'Wright State 45435']) out.push(...a.textIn('+19375550002', t));
  return out;
};

type EligFn = (s: Student, on: string) => { status: string };
const snapLimitOracle = (fn: EligFn): string[] => {
  // Record-derived oracle: expected outcomes come from the published table, not typed into the test.
  const a = new Advocate({ today: () => DAY });
  const bad: string[] = [];
  SNAP_FY2027.value.gross130.forEach((limit, i) => {
    const size = i + 1;
    const mk = (income: number) => a.createStudent({ chosenName: 'O', zip: '45402', age: 30, household: { size, monthlyGrossIncome: income }, enrollment: { college: 'sinclair', creditHours: 3 } });
    if (fn(mk(limit), DAY).status !== 'likely') bad.push(`size ${size} at limit`);
    if (fn(mk(limit + 1), DAY).status !== 'unlikely') bad.push(`size ${size} over limit`);
  });
  return bad;
};

function sourceFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) Object.assign(out, sourceFiles(p));
    else if (f.endsWith('.ts')) out[p.replace(ROOT, '')] = readFileSync(p, 'utf8');
  }
  return out;
}

// ---- gates ----

const toneGate: Gate<MessageSet> = {
  id: 'tone-and-next-step',
  protects: 'No message to a student scolds, reads above their level, or reports a problem without a next step (PRD P3, P4).',
  definition: def(checkTone),
  check: (ms) => {
    const bad = ms.map((m) => ({ m, r: checkTone(m, 'standard', 8) })).filter((x) => !x.r.ok);
    return bad.length ? fail('tone-and-next-step', bad.map((x) => `${x.m.author}: ${x.r.problems.join(', ')}`).join(' | ')) : pass('tone-and-next-step', `${ms.length} product messages pass`);
  },
  falsification: [
    { name: 'planted scolding message', plant: () => [{ studentId: 'x', author: 'planted', urgency: 'routine', text: "You're late on your essay again.", nextSteps: [{ label: 'ok', action: 'ok' }] }] },
    { name: 'planted message with no next step', plant: () => [{ studentId: 'x', author: 'planted', urgency: 'routine', text: 'Your bill is due Friday.', nextSteps: [] }] },
  ],
};

const approvalGate: Gate<Dispatcher> = {
  id: 'student-sends',
  protects: 'Nothing reaches an outside party without a single-use approval token for that exact content (PRD P9).',
  definition: def(OutboundGate.prototype.dispatch),
  check: async (d) => {
    const r = await d.dispatch({ studentId: 's', kind: 'email', recipient: 'landlord', content: { body: 'x' } }, undefined);
    return r.sent || d.sent.length > 0 ? fail('student-sends', 'an action was sent without an approval token') : pass('student-sends', 'refused without a token');
  },
  falsification: [{ name: 'planted dispatcher that ignores tokens', plant: () => { const sent: OutboundAction[] = []; return { sent, dispatch: async (a) => (sent.push(a), { sent: true }) }; } }],
};

const safetyGate: Gate<(m: string) => SafetyResult> = {
  id: 'safety-router',
  protects: 'Crisis messages, including held-out phrasings, route to 988 before any model (PRD SAF-1).',
  definition: def(realScreen),
  check: (fn) => {
    const missed = HELD_OUT_CRISIS.filter((m) => !fn(m).crisis);
    return missed.length ? fail('safety-router', `missed: ${missed.join(' | ')}`) : pass('safety-router', `${HELD_OUT_CRISIS.length} held-out phrasings routed`);
  },
  falsification: [{ name: 'planted router that only knows one phrase', plant: () => (m: string) => ({ crisis: /kill myself/i.test(m), categories: [] }) }],
};

const freshnessGate: Gate<FindFn> = {
  id: 'freshness',
  protects: 'A catalog entry past its freshness window is never offered as available (PRD P11).',
  definition: def(realFind),
  check: (fn) => (fn(staleCatalog()).includes('house-of-bread') ? fail('freshness', 'a stale entry was offered') : pass('freshness', 'stale entry withheld')),
  falsification: [{ name: 'planted finder that ignores freshness', plant: () => (catalog: Resource[]) => catalog.filter((r) => r.categories.includes('food')).map((r) => r.id) }],
};

const sealedGate: Gate<SealedProbe> = {
  id: 'sealed-facts',
  protects: 'A sealed fact never appears in a message unless the student released it to a playbook that needs it (PRD P10).',
  definition: def(realSealedProbe),
  check: (p) => {
    const words = p.sealedValue.split(/\W+/).filter((w) => w.length > 4);
    const leaked = p.messages.filter((m) => words.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(m)));
    return leaked.length ? fail('sealed-facts', `sealed words in ${leaked.length} messages`) : pass('sealed-facts', `${p.messages.length} messages clean`);
  },
  falsification: [{ name: 'planted message quoting the sealed fact', plant: () => ({ sealedValue: 'released from prison in March, on parole', messages: ['Since you were released from prison, here is help.'] }) }],
};

const evidenceGate: Gate<EvidenceProbe> = {
  id: 'evidence-pseudonymous',
  protects: 'The evidence store holds no student identifiers or content.',
  definition: def(realEvidenceProbe),
  check: (p) => {
    const found = p.ids.filter((id) => p.dump.includes(id));
    return found.length ? fail('evidence-pseudonymous', `identifiers in evidence: ${found.length}`) : pass('evidence-pseudonymous', 'no identifiers found');
  },
  falsification: [{ name: 'planted evidence row with a phone number', plant: () => ({ ids: ['+19375550000'], dump: '[{"subject":"+19375550000"}]' }) }],
};

const statusGate: Gate<string[]> = {
  id: 'no-status-question',
  protects: 'The team never asks about citizenship or immigration status (PRD NAV-7).',
  definition: STATUS_Q.source,
  check: (prompts) => {
    const bad = prompts.filter((p) => STATUS_Q.test(p));
    return bad.length ? fail('no-status-question', bad.join(' | ')) : pass('no-status-question', `${prompts.length} prompts checked`);
  },
  falsification: [{ name: 'planted citizenship question', plant: () => ['Are you a US citizen? Reply YES or NO.'] }],
};

const oracleGate: Gate<EligFn> = {
  id: 'snap-income-oracle',
  protects: 'SNAP income results match the published FY2027 table at and just over every limit (record-derived oracle, Pattern 17).',
  definition: def(snapLimitOracle),
  check: (fn) => {
    const bad = snapLimitOracle(fn);
    return bad.length ? fail('snap-income-oracle', bad.join(', ')) : pass('snap-income-oracle', 'all limits match the table');
  },
  falsification: [{ name: 'planted off-by-one limit', plant: () => (s: Student, on: string) => (s.household.monthlyGrossIncome === SNAP_FY2027.value.gross130[0] ? { status: 'unlikely' } : snap(s, on)) }],
};

const lockGate: Gate<{ lock: Lock }> = {
  id: 'journey-lock',
  protects: 'No change can edit or remove the journey cards it is judged by (Pattern 18).',
  definition: def(lockVerdict),
  check: ({ lock }) => {
    const v = lockVerdict(loadCards(JOURNEY_DIR), lock);
    return v.status === 'pass' ? v : fail('journey-lock', v.reason);
  },
  falsification: [{ name: 'planted lock missing a card', plant: () => { const l = readLock(); const [first] = Object.keys(l.cards); const cards = { ...l.cards }; delete cards[first!]; return { lock: { cards } }; } }],
};

const egressGate: Gate<Record<string, string>> = {
  id: 'no-hidden-egress',
  protects: 'Only the model client and the egress block may reach the network; domain, agent and server code cannot (PRD P2).',
  definition: 'global fetch (not a method like app.fetch), http.request or https.request outside packages/models and packages/egress',
  check: (files) => {
    const bad = Object.entries(files).filter(([p, src]) => !p.startsWith('packages/models/') && !p.startsWith('packages/egress/') && !p.includes('/test/') && !p.startsWith('tools/') && /(?<![.\w])fetch\s*\(|\bhttps?\.request\s*\(/.test(src));
    return bad.length ? fail('no-hidden-egress', bad.map(([p]) => p).join(', ')) : pass('no-hidden-egress', `${Object.keys(files).length} files scanned`);
  },
  falsification: [{ name: 'planted fetch in a domain file', plant: () => ({ 'apps/advocate/src/domain/leak.ts': "await fetch('https://example.com', { method: 'POST', body: JSON.stringify(student) })" }) }],
};

type CommunityFactory = () => { post: Community['post']; visible: Community['visible'] };
const HELD_OUT_POSTS = readFileSync(`${CONTROL}/heldout/community.txt`, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const moderationGate: Gate<CommunityFactory> = {
  id: 'community-moderation',
  protects: 'Harmful or risky posts never surface in the community (PRD COM-5).',
  definition: def(moderate),
  check: (make) => {
    const c = make();
    const base = { college: 'sinclair', communities: [] as string[], expires: '2026-12-01' };
    for (const t of HELD_OUT_POSTS) c.post('gate', { ...base, type: 'offer', category: 'help', text: t });
    const shown = c.visible('sinclair').filter((p) => HELD_OUT_POSTS.includes(p.text));
    return shown.length ? fail('community-moderation', `${shown.length} harmful posts surfaced`) : pass('community-moderation', `${HELD_OUT_POSTS.length} held-out harmful posts held`);
  },
  falsification: [{ name: 'planted community with no filters', plant: () => () => { const posts: { text: string }[] = []; return { post: ((_s: string, p: { text: string }) => (posts.push(p), p)) as unknown as Community['post'], visible: (() => posts) as unknown as Community['visible'] }; } }],
};

// ---- no dead ends: every button any agent offers does something, in app and text alike ----

type Perform = (a: Advocate, sid: string, action: string) => ActionResult | undefined;

/** A student with a full life, so every agent has something to say. */
export function richStudent(): { a: Advocate; sid: string; seeds: OutboundMessage[] } {
  const a = new Advocate({ today: () => DAY });
  const s = sampleStudent(a);
  const sid = s.id;
  a.addClasses(sid, [{ course: 'BIO 1111', days: ['Mon', 'Wed'], start: '09:00', end: '10:15', building: 'Building 3', room: '212' }]);
  a.addShifts(sid, [{ date: '2026-11-03', start: '15:00', end: '21:00', employer: 'Kroger' }]);
  const essay = a.addDeadline(sid, { title: 'Essay 2', course: 'ENG 1101', due: '2026-11-05', kind: 'assignment', effortHours: 8, source: { type: 'student' }, confirmed: true });
  a.addDeadline(sid, { title: 'Lab 3', course: 'BIO 1111', due: '2026-10-30', kind: 'assignment', effortHours: 3, source: { type: 'student' }, confirmed: true });
  const appt = a.addDeadline(sid, { title: 'Advising appointment', due: '2026-11-04T09:30', kind: 'appointment', durationMin: 30, source: { type: 'student' }, confirmed: true });
  void appt;
  a.addDeadline(sid, { title: 'Quiz 4', course: 'BIO 1111', due: '2026-11-12', kind: 'exam', source: { type: 'syllabus', line: 'Nov 12 Quiz 4' }, confirmed: false });
  a.setMoney(sid, 100, [{ name: 'Rent', amount: 900, dueDay: 1, kind: 'rent' }, { name: 'Electric', amount: 120, dueDay: 10, kind: 'utility' }], { amount: 300, next: '2026-11-20', everyDays: 14 });
  a.connectSource(sid, 'forwarding');
  const mt = a.addMeeting(sid, { title: 'Group project', date: '2026-11-04', start: '18:00', attendees: ['Ana', 'Lee'], course: 'ENG 1101' });
  // A school record under the aid-progress line, with a gradebook, so the School buttons are walked too.
  a.setAcademic(sid, { programCredits: 60, transcript: [{ course: 'ENG 1101', credits: 3, grade: 'W', term: 'Spring 2026' }, { course: 'PSY 1100', credits: 3, grade: 'C', term: 'Spring 2026' }, { course: 'BIO 1111', credits: 4, term: 'Fall 2026' }] });
  a.setGradebook(sid, { course: 'BIO 1111', credits: 4, source: 'student', categories: [{ name: 'Exams', weight: 60 }, { name: 'Final exam', weight: 40 }], items: [{ category: 'Exams', title: 'Exam 1', score: 71, outOf: 100 }, { category: 'Final exam', title: 'Final exam', outOf: 100 }] });
  const seeds: OutboundMessage[] = [
    academics.schoolMessage(a, sid),
    academics.aidProgressMessage(a, sid),
    academics.finalNeedMessage(a, sid),
    academics.dropMessage(a, sid),
    academics.degreeMessage(a, sid),
    a.todayMessage(sid),
    ...a.lookAhead(sid),
    a.moneyCheck(sid),
    a.moneyFoundMessage(sid),
    a.week(sid).message,
    a.weeklyPreview(sid),
    ...a.conflictMessages(sid),
    a.pulse(sid),
    a.planMessage(sid, essay.id),
    a.assignmentHelp(sid, essay.id),
    a.meetingPrep(sid, mt.id),
    a.licensedMessage(sid, 'legal'),
    a.licensedMessage(sid, 'tax'),
    a.courseworkBoundaryMessage(sid),
    a.forward(sid, 'Your financial aid file was selected for verification. Please submit documents.', { subject: 'Verification required' }).message,
    a.forward(sid, 'Class canceled today', { subject: 'BIO 1111 canceled' }).message,
    a.forward(sid, 'Our class moved to a new room', { subject: 'Room change' }).message,
    a.uploadSyllabus(sid, 'HIS 1101', 'Sep 3 Reading: Chapter 1\nNov 20 Paper 1 due', '2026-08-24').message,
    ...[...a.playbooks.keys()].map((id) => a.playbookMessage(sid, a.startPlaybook(sid, id))),
  ].filter((m): m is OutboundMessage => !!m);
  return { a, sid, seeds };
}

/** Follow every button breadth-first, the way a curious student would, up to a few taps deep. */
export function walkActions(perform: Perform, depth = 4): { reached: number; dead: string[]; held: string[] } {
  const { a, sid, seeds } = richStudent();
  const seen = new Set<string>();
  const dead: string[] = [];
  const held: string[] = [];
  let frontier = seeds.flatMap((m) => m.nextSteps.map((n) => n.action));
  for (let level = 0; level < depth && frontier.length; level++) {
    const next: string[] = [];
    for (const action of frontier) {
      if (seen.has(action)) continue;
      seen.add(action);
      if (action === 'delete-account') {
        const fresh = richStudent();
        if (!perform(fresh.a, fresh.sid, action)) dead.push(action);
        continue;
      }
      let r: ActionResult | undefined;
      try {
        r = perform(a, sid, action);
      } catch (e) {
        dead.push(`${action} (crashed: ${(e as Error).message})`);
        continue;
      }
      if (!r) {
        dead.push(action);
        continue;
      }
      const tone = checkTone(r.message, 'standard', 8, 'en');
      if (!tone.ok && r.message.urgency !== 'safety') held.push(`${action}: ${tone.problems.join('; ')}`);
      next.push(...r.message.nextSteps.map((n) => n.action));
    }
    frontier = next;
  }
  return { reached: seen.size, dead, held };
}

const realPerform: Perform = (a, sid, action) => a.perform(sid, action);

const deadEndGate: Gate<Perform> = {
  id: 'no-dead-ends',
  protects: 'Every button any agent offers works, in the app and by text (PRD P3, P8).',
  definition: def(walkActions),
  check: (perform) => {
    const r = walkActions(perform);
    if (r.dead.length) return fail('no-dead-ends', `${r.dead.length} buttons go nowhere: ${r.dead.slice(0, 5).join(', ')}`);
    if (r.held.length) return fail('no-dead-ends', `${r.held.length} buttons answer with a message the tone gate holds: ${r.held.slice(0, 3).join(' | ')}`);
    return pass('no-dead-ends', `${r.reached} distinct buttons followed up to 4 taps deep; every one answers`);
  },
  falsification: [
    { name: 'planted registry missing a handler', plant: () => (a: Advocate, sid: string, action: string) => (action.startsWith('hold-block:') ? undefined : a.perform(sid, action)) },
    { name: 'planted handler that answers with no next step', plant: () => (a: Advocate, sid: string, action: string) => { const r = a.perform(sid, action); return r && action.startsWith('mark-done:') ? { ...r, message: { ...r.message, nextSteps: [] } } : r; } },
  ],
};

// ---- docs linked: every test names the doc it verifies, and every doc has a test ----

const docsGate: Gate<() => Links> = {
  id: 'docs-linked',
  protects: 'Every test file names the document it verifies, that document exists, and every document is verified by a test.',
  definition: def(links),
  check: (read) => {
    const l = read();
    return l.problems.length ? fail('docs-linked', l.problems.slice(0, 4).join('; ')) : pass('docs-linked', `${l.testsToDocs.size} test files linked to ${new Set([...l.testsToDocs.values()].flat()).size} documents`);
  },
  falsification: [
    { name: 'planted test file with no doc', plant: () => () => ({ testsToDocs: new Map([['x.test.ts', []]]), problems: ['x.test.ts does not say which doc it verifies'] }) },
    { name: 'planted link to a missing doc', plant: () => () => { const l = links(); return { ...l, problems: [...l.problems, 'y.test.ts names docs/missing.md, which does not exist'] }; } },
  ],
};

// ---- the factory's own rules (Patterns 6, 7, 13, 32 and the pattern map) ----

const readYaml = <T>(p: string): T => parseYaml(readFileSync(`${CONTROL}/${p}`, 'utf8')) as T;
const exists = (p: string) => existsSync(`${ROOT}${p}`);

type PatternMap = { patterns: { n: number; name: string; implemented_in: string[]; verified_by: string[]; gate?: string }[] };
const patternGate: Gate<{ map: PatternMap; gates: string[]; exists: (p: string) => boolean }> = {
  id: 'pattern-coverage',
  protects: 'All 33 ZTHR patterns are implemented, each points at files that exist, and each is proven by a test (and a gate where it names one).',
  definition: 'every n in 1..33 present once; implemented_in and verified_by paths exist; verified_by is a test file; a named gate is in the catalog',
  check: ({ map, gates, exists: ex }) => {
    const bad: string[] = [];
    for (let n = 1; n <= 33; n++) if (map.patterns.filter((p) => p.n === n).length !== 1) bad.push(`pattern ${n} missing or doubled`);
    for (const p of map.patterns) {
      for (const f of [...p.implemented_in, ...p.verified_by]) if (!ex(f)) bad.push(`${p.n}: ${f} does not exist`);
      if (!p.verified_by.length || p.verified_by.some((f) => !/\.test\.ts$/.test(f))) bad.push(`${p.n}: not proven by a test file`);
      if (p.gate && !gates.includes(p.gate)) bad.push(`${p.n}: gate ${p.gate} is not in the catalog`);
    }
    return bad.length ? fail('pattern-coverage', bad.slice(0, 4).join('; ')) : pass('pattern-coverage', `33 patterns, each implemented and proven`);
  },
  falsification: [
    { name: 'planted map missing a pattern', plant: () => ({ map: { patterns: readYaml<PatternMap>('patterns.yaml').patterns.filter((p) => p.n !== 25) }, gates: gateIds(), exists }) },
    { name: 'planted proof that does not exist', plant: () => ({ map: { patterns: readYaml<PatternMap>('patterns.yaml').patterns.map((p) => (p.n === 1 ? { ...p, verified_by: ['apps/advocate/test/nowhere.test.ts'] } : p)) }, gates: gateIds(), exists }) },
  ],
};

type Register = { findings: (RegisteredFinding & { finding: string })[] };
const registerGate: Gate<{ reg: Register; now: Date }> = {
  id: 'findings-register',
  protects: 'Every finding we have not fixed is written down with a reason, an owner and an expiry, and none has expired (Pattern 13).',
  definition: def(checkRegister),
  check: ({ reg, now }) => {
    const v = checkRegister(reg.findings.map((f) => ({ ...f, expires: String(f.expires) })), now);
    const vague = reg.findings.filter((f) => !f.finding || f.finding.length < 20);
    return v.status !== 'pass' ? v : vague.length ? fail('findings-register', `findings with no description: ${vague.map((f) => f.id).join(', ')}`) : v;
  },
  falsification: [
    { name: 'planted expired finding', plant: () => ({ reg: { findings: [{ id: 'old', gate: 'x', finding: 'A finding accepted long ago and never fixed.', reason: 'was fine then', owner: 'claude-agent', expires: '2026-01-01' }] }, now: new Date('2026-11-03') }) },
    { name: 'planted finding with no owner', plant: () => ({ reg: { findings: [{ id: 'nobody', gate: 'x', finding: 'A finding that nobody owns at all.', reason: 'r', owner: '', expires: '2027-01-01' }] }, now: new Date('2026-11-03') }) },
  ],
};

type Pipeline = { steps: { id: string; allowFailure?: boolean; allow_failure?: unknown; args?: string[] }[] };
const zeroBypassGate: Gate<{ required: { check: string; step: string }[]; pipeline: Pipeline; scripts?: Record<string, string> }> = {
  id: 'zero-bypass',
  protects: 'Every required check runs in the live pipeline, none may fail and none can be skipped (Pattern 7).',
  definition: 'each required step is present in cloudbuild.yaml, has no allowFailure, and neither its command nor any script it runs has an "exit 0" or "|| true" escape; the one sanctioned skip is a line marked zthr:carry, which hands over a carried report for this commit',
  check: ({ required, pipeline, scripts = {} }) => {
    const bad: string[] = [];
    const escape = /\|\|\s*true|(?:;|&&)\s*exit 0\s*$/m;
    for (const r of required) {
      const st = pipeline.steps.find((s) => s.id === r.step);
      if (!st) bad.push(`${r.check}: no ${r.step} step`);
      else if (st.allowFailure || st.allow_failure) bad.push(`${r.check}: allowed to fail`);
      else {
        const cmd = (st.args ?? []).join(' ');
        const run = [...cmd.matchAll(/(tools\/[\w-]+\.sh)/g)].map((m) => scripts[m[1]!] ?? '').join('\n');
        const body = `${cmd}\n${run}`.split('\n').filter((l) => !l.includes('# zthr:carry')).join('\n');
        if (escape.test(body)) bad.push(`${r.check}: can be skipped`);
      }
    }
    return bad.length ? fail('zero-bypass', bad.join('; ')) : pass('zero-bypass', `${required.length} required checks in the live pipeline, none skippable`);
  },
  falsification: [
    { name: 'planted pipeline without the gates step', plant: () => ({ required: readYaml<{ required: { check: string; step: string }[] }>('required-checks.yaml').required, pipeline: { steps: livePipeline().steps.filter((s) => s.id !== 'gates') } }) },
    { name: 'planted step allowed to fail', plant: () => ({ required: readYaml<{ required: { check: string; step: string }[] }>('required-checks.yaml').required, pipeline: { steps: livePipeline().steps.map((s) => (s.id === 'test' ? { ...s, allowFailure: true } : s)) } }) },
    { name: 'planted step that swallows failure', plant: () => ({ required: readYaml<{ required: { check: string; step: string }[] }>('required-checks.yaml').required, pipeline: { steps: livePipeline().steps.map((s) => (s.id === 'journeys' ? { ...s, args: ['-c', 'npm run journeys || true'] } : s)) } }) },
    { name: 'planted script that skips its walk without carrying evidence', plant: () => ({ required: readYaml<{ required: { check: string; step: string }[] }>('required-checks.yaml').required, pipeline: livePipeline(), scripts: { 'tools/walk-ci.sh': 'if [ "$2" != "true" ]; then exit 0\nfi && exit 0' } }) },
  ],
};
const livePipeline = () => parseYaml(readFileSync(`${ROOT}cloudbuild.yaml`, 'utf8')) as Pipeline;

type Tiers = { tiers: { tier: string; guard: string; paths: string[] }[] };
const GUARDS = ['journey-lock', 'ratchet', 'gate-proofs', 'certify', 'docs-check', 'pipeline'];
const tiersGate: Gate<{ tiers: Tiers; files: string[] }> = {
  id: 'authorship-tiers',
  protects: 'Every file belongs to an authorship tier and every tier names a guard that enforces it; the open tier comes last (Pattern 6).',
  definition: 'first matching tier by path prefix; every file matched; every guard known; open ("") last',
  check: ({ tiers, files }) => {
    const bad: string[] = [];
    for (const t of tiers.tiers) if (!GUARDS.includes(t.guard)) bad.push(`${t.tier}: unknown guard ${t.guard}`);
    const last = tiers.tiers[tiers.tiers.length - 1];
    if (!last || !last.paths.includes('')) bad.push('the open tier must come last');
    const unmatched = files.filter((f) => !tiers.tiers.some((t) => t.paths.some((p) => f.startsWith(p))));
    if (unmatched.length) bad.push(`no tier: ${unmatched.slice(0, 3).join(', ')}`);
    const counts = Object.fromEntries(tiers.tiers.map((t) => [t.tier, 0]));
    for (const f of files) {
      const t = tiers.tiers.find((x) => x.paths.some((p) => f.startsWith(p)));
      if (t) counts[t.tier]!++;
    }
    return bad.length ? fail('authorship-tiers', bad.join('; ')) : pass('authorship-tiers', Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', '));
  },
  falsification: [
    { name: 'planted tier with no guard', plant: () => ({ tiers: { tiers: [{ tier: 'locked', guard: 'hope', paths: ['control/journeys/'] }, { tier: 'open', guard: 'pipeline', paths: [''] }] }, files: ['control/journeys/x.yaml'] }) },
    { name: 'planted open tier first', plant: () => ({ tiers: { tiers: [{ tier: 'open', guard: 'pipeline', paths: [''] }, { tier: 'locked', guard: 'journey-lock', paths: ['control/journeys/'] }] }, files: ['control/journeys/x.yaml'] }) },
  ],
};

const RULE_FILES = ['packages/runtime/src/safety.ts', 'apps/advocate/src/domain/crisis.ts', 'apps/advocate/src/domain/community.ts', 'apps/advocate/src/domain/i18n.ts'];
const heldOutLines = (f: string) => readFileSync(`${CONTROL}/heldout/${f}`, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const heldOutGate: Gate<{ held: string[]; rules: Record<string, string> }> = {
  id: 'held-out',
  protects: 'No rule is written against its own evaluation set: a held-out line that appears in a rule is caught, to be retired (Pattern 32).',
  definition: 'no active held-out line (case-insensitive) appears verbatim in any rule source',
  check: ({ held, rules }) => {
    const leaked = held.filter((h) => Object.values(rules).some((src) => src.toLowerCase().includes(h.toLowerCase())));
    return leaked.length ? fail('held-out', `held-out lines in rules (retire them): ${leaked.join(' | ')}`) : pass('held-out', `${held.length} held-out lines, none in ${Object.keys(rules).length} rule files`);
  },
  falsification: [{ name: 'planted rule written against a held-out line', plant: () => ({ held: heldOutLines('crisis.txt'), rules: { 'safety.ts': `const CRISIS = [/${heldOutLines('crisis.txt')[0]}/i];` } }) }],
};


// ---------- sensitive data: every field classified, and the trace finds no leak (docs/flows/sensitive-data.md)
type TraceLike = { leaks: { field: string; sink: string }[]; unexercised: string[] };
const sensitiveGate: Gate<{ unclassified: string[]; trace: TraceLike }> = {
  id: 'sensitive-data',
  protects: 'Every field the app keeps is classified, and a planted marker in each personal, sensitive and secret field turns up only where its class may go.',
  definition: 'no unclassified field; the canary trace reports no leak and no unexercised field',
  check: ({ unclassified, trace }) => {
    const problems = [...unclassified.map((f) => `unclassified: ${f}`), ...trace.leaks.map((l) => `${l.field} reached ${l.sink}`), ...trace.unexercised.map((f) => `not exercised: ${f}`)];
    return problems.length ? fail('sensitive-data', problems.slice(0, 6).join('; ')) : pass('sensitive-data', 'every field classified; no marker outside where its class may go');
  },
  falsification: [
    { name: 'planted field with no class', plant: () => ({ unclassified: ['students.newField'], trace: { leaks: [], unexercised: [] } }) },
    { name: 'planted income marker in the evidence log', plant: () => ({ unclassified: [], trace: { leaks: [{ field: 'students.household', sink: 'evidence' }], unexercised: [] } }) },
    { name: 'planted field the trace never exercised', plant: () => ({ unclassified: [], trace: { leaks: [], unexercised: ['money.bills'] } }) },
  ],
};

// ---------- block library: every block tested, documented, used, at its mutation floor, and never copied (Pattern 2)
type BlockLike = { name: string; tests: number; docHasUseFor: boolean; consumers: string[]; floor: number; mutation?: { score: number } };
const blockGate: Gate<{ blocks: BlockLike[]; appExports: Record<string, string[]>; blockExports: Record<string, string[]> }> = {
  id: 'block-library',
  protects: 'Every block has its own tests, a page saying what to use it for and what not, at least one consumer, a mutation score at or above its floor, and no copy of its code inside an app.',
  definition: 'each block: tests > 0, doc with Use it for and Not for, a consumer, mutation (when measured) >= floor; no app file exports a function a block exports',
  check: ({ blocks, appExports, blockExports }) => {
    const p: string[] = [];
    for (const b of blocks) {
      if (b.tests === 0) p.push(`${b.name} has no tests`);
      if (!b.docHasUseFor) p.push(`${b.name} has no Use it for / Not for page`);
      if (!b.consumers.length) p.push(`${b.name} is used by nothing`);
      if (b.mutation && b.mutation.score < b.floor) p.push(`${b.name} mutation ${b.mutation.score.toFixed(1)}% under its floor of ${b.floor}%`);
    }
    for (const [file, names] of Object.entries(appExports)) for (const n of names) for (const [block, bn] of Object.entries(blockExports)) if (bn.includes(n)) p.push(`${file} copies ${n} from @zthr/${block}`);
    return p.length ? fail('block-library', p.slice(0, 6).join('; ')) : pass('block-library', `${blocks.length} blocks tested, documented, used and at their floors; no copies`);
  },
  falsification: [
    { name: 'planted block with no tests', plant: () => ({ blocks: [{ name: 'x', tests: 0, docHasUseFor: true, consumers: ['app:a'], floor: 70 }], appExports: {}, blockExports: {} }) },
    { name: 'planted block nothing uses', plant: () => ({ blocks: [{ name: 'x', tests: 3, docHasUseFor: true, consumers: [], floor: 70 }], appExports: {}, blockExports: {} }) },
    { name: 'planted block under its mutation floor', plant: () => ({ blocks: [{ name: 'x', tests: 3, docHasUseFor: true, consumers: ['app:a'], floor: 80, mutation: { score: 79.9 } }], appExports: {}, blockExports: {} }) },
    { name: 'planted block with no purpose page', plant: () => ({ blocks: [{ name: 'x', tests: 3, docHasUseFor: false, consumers: ['app:a'], floor: 70 }], appExports: {}, blockExports: {} }) },
    { name: 'planted app copy of a block function', plant: () => ({ blocks: [], appExports: { 'apps/advocate/src/domain/tone.ts': ['readingGrade'] }, blockExports: { 'plain-language': ['readingGrade'] } }) },
  ],
};

/** Functions and classes each file under a directory defines and exports itself (re-exports do not count). */
function ownExports(dir: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = `${d}/${n}`;
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.ts')) out[p.slice(ROOT.length)] = [...readFileSync(p, 'utf8').matchAll(/^export (?:async )?(?:function|class) (\w+)/gm)].map((m) => m[1]!);
    }
  };
  walk(dir);
  return out;
}

// ---- staying enrolled: the federal aid formulas and the student's control of what is shared (Phase 5) ----

type R2T4Fn = (p: PaymentPeriod, lastDay: string, aid: AidDisbursed, charges: number) => R2T4Result;
function r2t4Oracle(fn: R2T4Fn): string[] {
  const H = HANDBOOK_CASE_2;
  const bad: string[] = [];
  const r = fn(H.period, H.lastDay, H.aid, H.charges);
  for (const [k, v] of Object.entries(H.expect)) if ((r as unknown as Record<string, number>)[k] !== v) bad.push(`Handbook case 2 ${k}: ${(r as unknown as Record<string, number>)[k]} not ${v}`);
  const late = fn(H.period, '2026-04-20', H.aid, H.charges);
  if (!late.allEarned || late.unearned !== 0) bad.push('after 60% all aid must be earned');
  const tiny = fn(H.period, H.lastDay, { pell: 100 }, 0);
  if (tiny.studentGrantReturn !== 0) bad.push('a grant overpayment of $50 or less is not owed');
  return bad;
}
const r2t4Gate: Gate<R2T4Fn> = {
  id: 'r2t4-oracle',
  protects: 'The withdrawal estimate reproduces the Federal Student Aid Handbook\'s worked case to the cent, earns everything after 60%, and waives grant overpayments of $50 or less (34 CFR 668.22).',
  definition: def(r2t4Oracle),
  check: (fn) => {
    const bad = r2t4Oracle(fn);
    return bad.length ? fail('r2t4-oracle', bad.join('; ')) : pass('r2t4-oracle', 'Handbook case 2 matches; 60% and $50 rules hold');
  },
  falsification: [
    { name: 'planted count that keeps scheduled breaks in the term', plant: () => (p: PaymentPeriod, d: string, aid: AidDisbursed, c: number) => r2t4({ ...p, breaks: [] }, d, aid, c) },
    { name: 'planted estimate with no 50% grant protection', plant: () => (p: PaymentPeriod, d: string, aid: AidDisbursed, c: number) => { const x = r2t4(p, d, aid, c); return { ...x, studentGrantReturn: x.studentInitialDue - x.studentLoanRepay }; } },
  ],
};

type SapFn = (t: TranscriptCourse[], p: AcademicPolicy['sap'], credits?: number) => SapResult;
function sapOracle(fn: SapFn): string[] {
  const bad: string[] = [];
  const row = (course: string, credits: number, grade: TranscriptCourse['grade']): TranscriptCourse => ({ course, credits, grade, term: 'Fall 2025' });
  for (const c of COLLEGES.filter((x) => x.academic)) {
    const p = c.academic!.sap;
    const credits = c.academic!.level === 'bachelor' ? 120 : 60;
    const ok = (t: TranscriptCourse[], rule: string) => fn(t, p, credits).checks.find((x) => x.rule === rule)!.meets;
    // pace at the line passes and just under fails (in hundredths of a percent)
    const at = Math.ceil(p.pace * 100);
    if (ok([row('A', at, 'A'), row('B', 10000 - at, 'W')], 'pace') !== true) bad.push(`${c.short}: ${at / 100}% must meet ${p.pace}%`);
    if (ok([row('A', at - 2, 'A'), row('B', 10002 - at, 'W')], 'pace') !== false) bad.push(`${c.short}: under ${p.pace}% must not meet`);
    if (ok([row('A', 3, 'B'), row('B', 3, 'D')], 'gpa') !== (2.0 >= p.gpa)) bad.push(`${c.short}: a 2.0 GPA against ${p.gpa}`);
    const max = Math.floor(credits * p.maxTimeframe);
    if (ok([row('A', max, 'C')], 'max-timeframe') !== true || ok([row('A', max + 1, 'C')], 'max-timeframe') !== false) bad.push(`${c.short}: the limit is ${max} attempted credits`);
    if (fn([row('A', 3, 'W'), row('B', 3, 'A')], p, credits).attempted !== 6) bad.push(`${c.short}: a W counts as attempted`);
    if (fn([row('T', 6, 'TR')], p, credits).earned !== 6) bad.push(`${c.short}: transfer credit counts as earned`);
  }
  return bad;
}
const sapGate: Gate<SapFn> = {
  id: 'sap-oracle',
  protects: 'Satisfactory Academic Progress is measured exactly at each college\'s declared GPA, pace and 150% limit, with W counted as attempted and transfer credit as both attempted and earned (34 CFR 668.34).',
  definition: def(sapOracle),
  check: (fn) => {
    const bad = sapOracle(fn);
    return bad.length ? fail('sap-oracle', bad.join('; ')) : pass('sap-oracle', `${COLLEGES.filter((x) => x.academic).length} colleges checked at their thresholds`);
  },
  falsification: [
    { name: 'planted measure that leaves W out of attempted credits', plant: () => (t: TranscriptCourse[], p: AcademicPolicy['sap'], c?: number) => sap(t.filter((x) => x.grade !== 'W'), p, c) },
    { name: 'planted rounding of pace to a whole percent', plant: () => (t: TranscriptCourse[], p: AcademicPolicy['sap'], c?: number) => { const r = sap(t, p, c); return { ...r, checks: r.checks.map((k) => (k.rule === 'pace' && k.value !== undefined ? { ...k, value: Math.round(k.value), meets: Math.round(k.value) >= p.pace } : k)) }; } },
  ],
};

/** A link opened with a set of scopes, and what it showed, what was stored, and how a revoked or expired one answered. */
type ShareProbe = () => Promise<{ scopes: string[]; html: string; marker: string; stored: string; token: string; revoked: number; expired: number }[]>;
const realShareProbe: ShareProbe = async () => {
  const out = [];
  for (const scopes of [['school'], ['degree'], ['schedule'], ['plan'], ['school', 'degree', 'schedule', 'plan']] as academics.ShareScope[][]) {
    const a = new Advocate({ today: () => DAY, now: () => new Date(`${DAY}T15:00:00Z`) });
    const id = PERSONAS.Tyler!(a).id;
    const marker = `SEALED-${randomBytes(4).toString('hex')}`;
    a.seal(id, 'justice_involvement', marker);
    const web = createApp(a);
    const { token, share } = a.createShare(id, 'Advisor', scopes, 7);
    const html = await (await web.request(`/shared/${token}`)).text();
    const stored = JSON.stringify(a.store.exportStudent(id)) + JSON.stringify(a.messages(id));
    a.revokeShare(id, share.id);
    const revoked = (await web.request(`/shared/${token}`)).status;
    const { token: t2, share: s2 } = a.createShare(id, 'Old', scopes, 1);
    a.store.put('shares', s2.id, id, { ...s2, expiresAt: '2026-11-01T00:00:00.000Z' });
    const expired = (await web.request(`/shared/${t2}`)).status;
    out.push({ scopes, html, marker, stored, token, revoked, expired });
  }
  return out;
};
const SECTION: Record<string, RegExp> = { school: /Classes, standing and aid progress/, degree: /Degree progress/, schedule: /This week/, plan: /What they are working on/ };
const shareGate: Gate<ShareProbe> = {
  id: 'share-scope',
  protects: 'A link the student shares shows only the parts they chose, never a sealed fact, stops working when turned off or expired, and is never stored in a form that could be read back.',
  definition: def(realShareProbe) + Object.values(SECTION).join(),
  check: async (probe) => {
    const bad: string[] = [];
    for (const r of await probe()) {
      for (const [k, re] of Object.entries(SECTION)) if (re.test(r.html) !== r.scopes.includes(k)) bad.push(`${r.scopes.join('+')}: ${k} ${re.test(r.html) ? 'shown' : 'missing'}`);
      if (r.html.includes(r.marker)) bad.push(`${r.scopes.join('+')}: sealed fact shown`);
      if (r.stored.includes(r.token)) bad.push(`${r.scopes.join('+')}: link stored`);
      if (r.revoked !== 410 || r.expired !== 410) bad.push(`${r.scopes.join('+')}: revoked ${r.revoked}, expired ${r.expired}`);
    }
    return bad.length ? fail('share-scope', bad.slice(0, 4).join('; ')) : pass('share-scope', 'five scope sets: only what was chosen, nothing sealed, nothing kept, off means off');
  },
  falsification: [
    { name: 'planted link that shows every part', plant: () => async () => (await realShareProbe()).map((r) => ({ ...r, html: `${r.html} Classes, standing and aid progress Degree progress This week What they are working on` })) },
    { name: 'planted link that keeps working after it is turned off', plant: () => async () => (await realShareProbe()).map((r) => ({ ...r, revoked: 200 })) },
    { name: 'planted message that repeats the link', plant: () => async () => (await realShareProbe()).map((r) => ({ ...r, stored: r.stored + r.token })) },
  ],
};

// ---- the community resource guide (docs/flows/resource-guide.md) ----

type AdmitFn = typeof admit;
interface GuideAdmission { catalog: Resource[]; owners: Set<string>; admit: AdmitFn }
const scoutOwners = () => new Set(readdirSync(`${CONTROL}/scouts`).filter((f) => f.endsWith('.yaml')).flatMap((f) => (parseYaml(readFileSync(`${CONTROL}/scouts/${f}`, 'utf8')) as { entries: string[] }).entries));
// One bad entry per kind of fault an admission gate exists to catch; each must be held, by the check named.
const BAD_ENTRIES: [string, (r: Resource) => Resource][] = [
  ['source of record cited', (r) => ({ ...r, id: 'bad-source', source: { ...r.source, url: 'see the flyer' } })],
  ['phone is a phone number', (r) => ({ ...r, id: 'bad-phone', phone: '555-12' })],
  ['eligibility in plain words', (r) => ({ ...r, id: 'bad-words', eligibility: { text: 'Eligibility determinations are contingent upon comprehensive verification of documentation substantiating household composition and residency qualification.' } })],
  ['barriers from the taxonomy', (r) => ({ ...r, id: 'bad-barrier', categories: ['astrology' as Resource['categories'][number]] })],
  ['verified on a real date', (r) => ({ ...r, id: 'bad-date', verifiedOn: '2026-13-40' })],
];
const guideAdmissionGate: Gate<GuideAdmission> = {
  id: 'guide-admission',
  protects: 'Every guide entry passes every admission check, and an entry with no source, a bad phone number, dense wording, a made-up barrier or an impossible date is held by the check named for it.',
  definition: def(admit) + JSON.stringify(BAD_ENTRIES.map(([n]) => n)),
  check: ({ catalog, owners, admit: fn }) => {
    const bad: string[] = [];
    for (const r of catalog) {
      const failed = fn(r, catalog, owners).filter((c) => !c.ok);
      if (failed.length) bad.push(`${r.id} held: ${failed.map((c) => c.name).join(', ')}`);
    }
    const base = DAYTON_CATALOG.find((r) => r.id === 'daybreak')!;
    for (const [check, make] of BAD_ENTRIES) {
      const e = make(base);
      const owned = new Set([...owners, e.id]);
      if (fn(e, [...catalog, e], owned).find((c) => c.name === check)?.ok !== false) bad.push(`a planted entry was not held by "${check}"`);
    }
    return bad.length ? fail('guide-admission', bad.slice(0, 4).join('; ')) : pass('guide-admission', `${catalog.length} entries admitted; ${BAD_ENTRIES.length} planted bad entries each held by its check`);
  },
  falsification: [
    { name: 'planted catalog with an entry that has no source', plant: () => ({ catalog: [...DAYTON_CATALOG, { ...DAYTON_CATALOG[0]!, id: 'no-source', source: { ...DAYTON_CATALOG[0]!.source, url: 'ask around' } }], owners: new Set([...scoutOwners(), 'no-source']), admit }) },
    { name: 'planted gate that admits everything', plant: () => ({ catalog: DAYTON_CATALOG, owners: scoutOwners(), admit: ((r: Resource, c: Resource[], o: Set<string>) => admit(r, c, o).map((x) => ({ ...x, ok: true }))) as AdmitFn }) },
    { name: 'planted gate that no longer checks phone numbers', plant: () => ({ catalog: DAYTON_CATALOG, owners: scoutOwners(), admit: ((r: Resource, c: Resource[], o: Set<string>) => admit(r, c, o).map((x) => (x.name === 'phone is a phone number' ? { ...x, ok: true } : x))) as AdmitFn }) },
  ],
};

type FeedProbe = () => { feed: unknown; studentMarks: string[]; fewAnswers: string };
const realFeedProbe: FeedProbe = () => {
  const a = new Advocate({ today: () => DAY });
  const s = a.createStudent({ chosenName: 'Feedprobe', zip: '45402', phone: '+19375550999', enrollment: { college: 'sinclair', creditHours: 12 } });
  a.openBarrier(s.id, 'housing', 'check-in', 'tonight');
  a.resourceFeedback(s.id, 'daybreak', 'helped');
  return { feed: a.guideFeed(), studentMarks: [s.id, 'Feedprobe', '5550999'], fewAnswers: 'daybreak' };
};
const guideFeedGate: Gate<FeedProbe> = {
  id: 'guide-feed',
  protects: 'The public guide feed matches its published schema, carries no student (no name, phone, id or answer), and shows a "did it help" count only from five answers up.',
  definition: def(realFeedProbe) + def(guideFeed),
  check: (probe) => {
    const { feed: f, studentMarks, fewAnswers } = probe();
    const bad: string[] = [];
    const parsed = Feed.safeParse(f);
    if (!parsed.success) bad.push(`schema: ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    const text = JSON.stringify(f);
    for (const m of studentMarks) if (text.includes(m)) bad.push(`the feed carries a student mark (${m.slice(0, 4)}…)`);
    const few = parsed.success ? parsed.data.services.find((x) => x.id === fewAnswers) : undefined;
    if (few?.record) bad.push('a count is shown from fewer than five answers');
    return bad.length ? fail('guide-feed', bad.join('; ')) : pass('guide-feed', `${parsed.success ? parsed.data.count : 0} services; schema holds; no student marks; small counts withheld`);
  },
  falsification: [
    { name: 'planted feed that carries the student name', plant: () => () => { const p = realFeedProbe(); return { ...p, feed: { ...(p.feed as object), note: 'requested by Feedprobe' } }; } },
    { name: 'planted feed that shows a count from one answer', plant: () => () => { const p = realFeedProbe(); const f = p.feed as ReturnType<typeof guideFeed>; return { ...p, feed: { ...f, services: f.services.map((x) => (x.id === 'daybreak' ? { ...x, record: 'Helped 1 of 1 students who tried it.' } : x)) } }; } },
    { name: 'planted feed with an entry missing its source', plant: () => () => { const p = realFeedProbe(); const f = p.feed as ReturnType<typeof guideFeed>; return { ...p, feed: { ...f, services: f.services.map((x, i) => (i === 0 ? { ...x, source: { license: x.source.license } } : x)) } }; } },
  ],
};

interface BarrierOps { open: typeof B.open; resolve: typeof B.resolve; notToday: typeof B.notToday; start: typeof B.start; asked: typeof B.asked }
const REAL_BARRIERS: BarrierOps = { open: B.open, resolve: B.resolve, notToday: B.notToday, start: B.start, asked: B.asked };
/** Seeded sequences of events, the same every run, so a gate verdict is reproducible. */
function barrierViolations(ops: BarrierOps, runs = 300): string[] {
  let seed = 20261102;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  const needs = ['emergency', 'housing', 'food', 'transportation', 'utilities'] as const;
  const urg = ['tonight', 'soon', 'someday'] as const;
  const rank = { tonight: 0, soon: 1, someday: 2 };
  const out = new Set<string>();
  for (let r = 0; r < runs; r++) {
    let book = B.empty();
    for (let i = 0; i < 25; i++) {
      const need = needs[rnd(needs.length)]!;
      const day = `2026-11-${String(2 + i).padStart(2, '0')}`;
      const before = B.find(book, need);
      const kind = rnd(5);
      book = kind === 0 ? ops.open(book, need, 'check-in', urg[rnd(3)]!, day) : kind === 1 ? ops.resolve(book, need, day) : kind === 2 ? ops.notToday(book, need, day) : kind === 3 ? ops.start(book, need, day) : ops.asked(book, need, day);
      const after = B.find(book, need);
      if (after?.status === 'resolved' && before?.status !== 'resolved' && kind !== 1) out.add('something other than the student closed a barrier');
      if (before && before.status !== 'resolved' && after && kind === 0 && rank[after.urgency] > rank[before.urgency]) out.add('opening an open barrier lowered its urgency');
      if (new Set(book.items.map((b) => b.need)).size !== book.items.length) out.add('a barrier was duplicated');
      if (kind === 2 && before && after && before.status !== after.status) out.add('"not today" changed a barrier\'s status');
    }
  }
  return [...out];
}
const barrierGate: Gate<BarrierOps> = {
  id: 'barrier-lifecycle',
  protects: 'A need a student raised stays open until the student resolves it: nothing else closes it, its urgency never drops while open, "not today" only pauses reminders, and it is never duplicated.',
  definition: def(barrierViolations) + def(B.open) + def(B.resolve) + def(B.notToday) + def(B.start) + def(B.asked),
  check: (ops) => {
    const v = barrierViolations(ops);
    return v.length ? fail('barrier-lifecycle', v.join('; ')) : pass('barrier-lifecycle', '300 seeded sequences of 25 events: every rule held');
  },
  falsification: [
    { name: 'planted open that lowers urgency', plant: () => ({ ...REAL_BARRIERS, open: (book, need, by, u, today) => { const b = B.find(book, need); return b && b.status !== 'resolved' ? { items: [...book.items.filter((x) => x.need !== need), { ...b, urgency: u }] } : B.open(book, need, by, u, today); } }) },
    { name: 'planted "not today" that closes the barrier', plant: () => ({ ...REAL_BARRIERS, notToday: (book, need, today) => B.resolve(book, need, today) }) },
    { name: 'planted check-in that closes a quiet barrier', plant: () => ({ ...REAL_BARRIERS, asked: (book, need, today) => B.resolve(book, need, today) }) },
  ],
};

const gateIds = () => [toneGate, approvalGate, safetyGate, freshnessGate, sealedGate, evidenceGate, statusGate, oracleGate, lockGate, moderationGate, deadEndGate, docsGate, egressGate, patternGate, registerGate, zeroBypassGate, tiersGate, heldOutGate, sensitiveGate, blockGate, r2t4Gate, sapGate, shareGate, guideAdmissionGate, guideFeedGate, barrierGate].map((g) => g.id);

function repoFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(`${ROOT}${d}`)) {
      if (['node_modules', '.git', 'evidence-out', 'site-out', 'site-artifact', 'reports', '.stryker-tmp'].includes(n)) continue;
      const p = d ? `${d}/${n}` : n;
      if (statSync(`${ROOT}${p}`).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk('');
  return out;
}

/** What each gate protects and what it is proven against, for the docs and the console. */
export function gateCatalog(): { id: string; protects: string; plants: string[] }[] {
  return [toneGate, approvalGate, safetyGate, freshnessGate, sealedGate, evidenceGate, statusGate, oracleGate, lockGate, moderationGate, deadEndGate, docsGate, egressGate, patternGate, registerGate, zeroBypassGate, tiersGate, heldOutGate, sensitiveGate, blockGate, r2t4Gate, sapGate, shareGate, guideAdmissionGate, guideFeedGate, barrierGate].map((g) => ({ id: g.id, protects: g.protects, plants: g.falsification.map((f) => f.name) }));
}

export async function runGates(store?: EvidenceStore): Promise<{ verdicts: Verdict[]; proofs: Proof[] }> {
  const ev = store ?? (mkdirSync(OUT, { recursive: true }), new EvidenceStore(`${OUT}/evidence.db`));
  const proofs: Proof[] = [];
  const verdicts: Verdict[] = [];
  const run = async <S>(g: Gate<S>, subject: () => S) => {
    const proof = await proveGate(g);
    proofs.push(proof);
    ev.append('gate_proof', g.id, { valid: proof.valid, cases: proof.cases.length, gateHash: proof.gateHash });
    const v = await runProvenGate(g, subject(), proof);
    verdicts.push(v);
    ev.append('gate', g.id, { status: v.status, reason: v.reason });
  };
  await run(toneGate, productMessages);
  await run(approvalGate, realDispatcher);
  await run(safetyGate, () => realScreen);
  await run(freshnessGate, () => realFind);
  await run(sealedGate, realSealedProbe);
  await run(evidenceGate, realEvidenceProbe);
  await run(statusGate, onboardingPrompts);
  await run(oracleGate, () => snap as EligFn);
  await run(lockGate, () => ({ lock: readLock() }));
  await run(moderationGate, () => () => new Community(() => DAY));
  await run(deadEndGate, () => realPerform);
  await run(docsGate, () => () => links());
  await run(egressGate, () => ({ ...sourceFiles(`${ROOT}apps/advocate/src`), ...sourceFiles(`${ROOT}packages`) }));
  await run(patternGate, () => ({ map: readYaml<PatternMap>('patterns.yaml'), gates: gateIds(), exists }));
  await run(registerGate, () => ({ reg: readYaml<Register>('register.yaml'), now: new Date() }));
  await run(zeroBypassGate, () => ({ required: readYaml<{ required: { check: string; step: string }[] }>('required-checks.yaml').required, pipeline: livePipeline(), scripts: Object.fromEntries(readdirSync(`${ROOT}tools`).filter((f) => f.endsWith('.sh')).map((f) => [`tools/${f}`, readFileSync(`${ROOT}tools/${f}`, 'utf8')])) }));
  await run(tiersGate, () => ({ tiers: readYaml<Tiers>('authorship.yaml'), files: repoFiles() }));
  await run(heldOutGate, () => ({ held: [...heldOutLines('crisis.txt'), ...heldOutLines('community.txt')], rules: Object.fromEntries(RULE_FILES.map((f) => [f, readFileSync(`${ROOT}${f}`, 'utf8')])) }));
  const { runTrace } = await import('../apps/advocate/test/harness/trace.js');
  const { unclassified } = await import('@zthr/store');
  const { COLLECTIONS } = await import('../apps/advocate/src/domain/schema.js');
  const traced = await runTrace();
  await run(sensitiveGate, () => ({ unclassified: unclassified(COLLECTIONS), trace: traced }));
  const { blockNames, report } = await import('./blocks.js');
  const blockExports = Object.fromEntries(blockNames().map((b) => [b, Object.values(ownExports(`${ROOT}packages/${b}/src`)).flat()]));
  const appExports = Object.fromEntries(['advocate', 'campus-services'].flatMap((app) => Object.entries(ownExports(`${ROOT}apps/${app}/src`))));
  await run(blockGate, () => ({ blocks: blockNames().map(report), appExports, blockExports }));
  await run(r2t4Gate, () => r2t4);
  await run(sapGate, () => sap);
  await run(shareGate, () => realShareProbe);
  await run(guideAdmissionGate, () => ({ catalog: DAYTON_CATALOG, owners: scoutOwners(), admit }));
  await run(guideFeedGate, () => realFeedProbe);
  await run(barrierGate, () => REAL_BARRIERS);
  writeFileSync(`${CONTROL}/proofs.json`, `${JSON.stringify(proofs.map(({ gate, gateHash, valid, cases }) => ({ gate, gateHash, valid, cases: cases.map((c) => c.name) })), null, 2)}\n`);
  return { verdicts, proofs };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { verdicts, proofs } = await runGates();
  for (const [i, v] of verdicts.entries()) console.log(`${v.status.padEnd(7)} ${v.gate.padEnd(22)} proof:${proofs[i]!.valid ? 'valid' : 'INVALID'}  ${v.reason}`);
  process.exit(verdicts.every((v) => v.status === 'pass') ? 0 : 1);
}
