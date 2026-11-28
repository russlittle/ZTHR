/**
 * From files and readings to a frame ready to read back: intake, lexicon, the structural diff, derivation,
 * gap checks, balloons and the title block. Everything here is deterministic; the only model output it
 * accepts is a reading that matches the schema, and two readings from different families are needed for
 * the rough parts to count as read.
 */
import { settle as settleSheet, type Options, type Settled } from './interfaces.ts';
import type { OwnJourney } from './journeys.ts';
import { sha256 } from './hash.ts';
import { derive } from './derive.ts';
import { diffReadings, same, words } from './diff.ts';
import { checkReading, SLOTS, type Ballooned, type Question, type Reading, type Statement, type TitleBlock } from './frame.ts';
import { checkPairings } from './gaps.ts';
import { intake } from './intake/index.ts';
import { shaped } from './questions.ts';
import { detectDomain, loadRoles, primaryPeople, staffBranch, type Roles } from './roles.ts';
import { hitStatements, loadLexicon, resolveTerms, type Lexicon } from './lexicon.ts';
import type { IntentModel } from './model.ts';

/** The defaults every application starts from, before the audience profile or the person's words change them. */
export const TITLE_DEFAULTS: Readonly<Record<string, string>> = {
  language: 'English',
  reading: 'plain words',
  density: 'comfortable',
  palette: 'standard, contrast-checked',
  motion: 'full, reduced when the system asks',
  vision: 'standard, with low vision and high contrast available',
  accessibility: 'WCAG 2.2 AA',
  layout: 'adapts from a 320-pixel phone to a desktop',
  feedback: 'within 1 second',
};

export interface Prepared {
  readonly model: IntentModel;
  readonly title: TitleBlock;
  readonly statements: readonly Ballooned[];
  readonly questions: readonly Question[];
  /** Why the rough parts are not yet read, when they are not. */
  readonly unread: readonly string[];
  /** Prose that is tied to nothing yet: a broken thread until it becomes a statement. */
  readonly untied: readonly string[];
  /** The versions of the lexicons that read the words: instruments, recorded with every reading they make. */
  readonly instruments: { readonly design: string; readonly roles: string };
  /** Journeys the person chose to add: suggestions by id, and their own. */
  readonly journeys: { readonly accepted: readonly string[]; readonly own: readonly OwnJourney[] };
  readonly people: People;
  /** The factory spec sheet, every choice filled in. */
  readonly options: Settled;
}

/** A balloon key that survives rewording of case and punctuation, so numbers stay put across revisions. */
export const balloonKey = (s: Statement): string => sha256(`${s.slot}:${[...words(s.text)].sort().join(' ')}`).slice(0, 16);

/** Balloons kept from the previous revision; new statements take the next free numbers in slot order. */
export function assignBalloons(statements: readonly Statement[], prior: Readonly<Record<string, number>> = {}): Ballooned[] {
  const order = (s: Statement) => SLOTS.indexOf(s.slot);
  let next = Math.max(0, ...Object.values(prior)) + 1;
  const used = new Set<number>();
  return [...statements]
    .sort((a, b) => order(a) - order(b))
    .map((s) => {
      const k = balloonKey(s);
      const kept = prior[k];
      if (kept !== undefined && !used.has(kept)) {
        used.add(kept);
        return { ...s, balloon: kept };
      }
      used.add(next);
      return { ...s, balloon: next++ };
    })
    .sort((a, b) => a.balloon - b.balloon);
}

/** The title block: defaults, with every choice the person's own words implied shown as an override. */
export function titleBlock(lexiconChoices: readonly { term: string; choices: Readonly<Record<string, string>> }[]): TitleBlock {
  const block: Record<string, { value: string; from: string; replaces?: { value: string; from: string } }> = {};
  for (const [k, v] of Object.entries(TITLE_DEFAULTS)) block[k] = { value: v, from: 'default' };
  for (const { term, choices } of lexiconChoices)
    for (const [k, v] of Object.entries(choices)) {
      const before = block[k];
      block[k] = before ? { value: v, from: `"${term}"`, replaces: { value: before.value, from: before.from } } : { value: v, from: `"${term}"` };
    }
  return block;
}

/** A person's answer to one question: a pick, several picks, a yes to a proposal, or their own words. */
export interface Given {
  readonly pick?: string;
  readonly picks?: readonly string[];
  readonly yes?: boolean;
  readonly other?: string;
}

const personSays = (slot: Statement['slot'], text: string, question: string): Statement => {
  // A measure picked as "what (how close)" keeps its tolerance apart, so it becomes a working range.
  const m = slot === 'measures' ? /^(.*\S)\s+\(([^()]+)\)$/.exec(text) : null;
  return { id: `A:${question}:${text.slice(0, 24)}`, slot, text: m ? m[1]! : text, words: text, state: 'confirmed', supplied: { kind: 'person' }, ...(m ? { tolerance: m[2]! } : {}) };
};

/** A single reading as quick confirmations: each slot a yes or a pick-any, labelled as one model's reading. */
function proposalsFrom(r: Reading): Question[] {
  const by = `one reading so far, by ${r.family}`;
  const out: Question[] = [];
  const one = (id: string, slot: Question['slot'] & string, text: string, value: string, protects: string) => {
    if (value.trim()) out.push({ id, origin: 'diff', slot: slot as never, text: `${text} (${by})`, choices: [value], protects, consequence: 'high' });
  };
  const many = (id: string, slot: Question['slot'] & string, text: string, values: readonly string[], protects: string, consequence: Question['consequence'] = 'high') => {
    if (values.length) out.push({ id, origin: 'diff', slot: slot as never, text: `${text} Pick any it got right (${by}).`, choices: [...values], answer: { kind: 'multi', options: [...values], other: true }, protects, consequence });
  };
  one('one:problem', 'problem', 'Is this the problem?', r.problem, 'building the right thing at all');
  one('one:why', 'why', 'Is this what you are ultimately trying to achieve?', r.why, 'choosing between ways of meeting it');
  many('one:outcomes', 'outcome', 'What will be true when it works?', r.outcomes, 'what counts as done');
  many('one:measures', 'measures', 'How will anyone know it worked?', r.measures.map((m) => `${m.text} (${m.tolerance})`), 'how anyone will know it worked');
  many('one:constraints', 'constraints', 'What must always or never happen?', r.constraints, 'what must always or never happen');
  many('one:people', 'people', 'Who is involved?', r.people.map((p) => `${p.name} (${p.side === 'primary' ? 'who it is for' : 'on the other side'})`), 'who it is built for, and who else it reaches', 'medium');
  many('one:nonGoals', 'nonGoals', 'What is left out on purpose?', r.nonGoals, 'what is left out on purpose', 'low');
  return out;
}

/** Where two words clashed, the title block shows the person's choice, or stays undecided until they make one. */
function resolveClashes(block: TitleBlock, asks: Map<string, { term: string; value: string }[]>, choice: (k: string) => string | undefined): TitleBlock {
  const out: Record<string, TitleBlock[string]> = { ...block };
  for (const [k, list] of asks) {
    if (new Set(list.map((x) => x.value)).size < 2) continue;
    const c = choice(k);
    out[k] = c ? { value: c, from: 'your choice', replaces: { value: list.map((x) => x.value).join(' or '), from: 'clash' } } : { value: `undecided: ${list.map((x) => `${x.value} ("${x.term}")`).join(' or ')}`, from: 'clash' };
  }
  return out;
}

export interface Input {
  readonly files: readonly { path: string; text: string }[];
  readonly answers?: Readonly<Record<string, Given>>;
  readonly readings?: readonly unknown[];
  readonly prior?: Readonly<Record<string, number>>;
  readonly lexicon?: Lexicon;
  readonly roles?: Roles;
  /** Journeys the person added from the suggestions, and their own. */
  readonly journeys?: { readonly accepted?: readonly string[]; readonly own?: readonly OwnJourney[] };
  /** Who holds the intent, and how each person who will use it has been tuned. */
  readonly people?: People;
  /** The factory spec sheet: which interfaces are switched on. */
  readonly options?: Options;
}

/** How one person who will use the software is tuned: what they need for a journey to count as walked by them. */
export interface Tune {
  readonly device?: 'phone' | 'laptop' | 'either';
  readonly language?: string;
  readonly assistive?: 'none' | 'screen reader' | 'low vision';
  readonly often?: 'once' | 'weekly' | 'daily';
}

export interface People {
  /** The person whose intent this is, as distinct from the people who will use what is built. */
  readonly holder?: { readonly name: string; readonly role: string };
  readonly tune?: Readonly<Record<string, Tune>>;
}

/** Where the factory writes clarifications it made on its own: read as its assumptions, never as the person's words. */
export const CLARIFICATIONS = 'factory-clarifications.md';
const fromFactory = (s: Statement): Statement =>
  s.supplied.kind === 'person' && s.supplied.origin?.path === CLARIFICATIONS
    ? { ...s, state: 'assumed', supplied: { kind: 'derived', rule: `clarified by the factory (${CLARIFICATIONS}, line ${s.supplied.origin.line})` } }
    : s;

export function prepare(input: Input): Prepared {
  const model = intake(input.files);
  const lexicon = input.lexicon ?? loadLexicon();
  const statements: Statement[] = [];
  const questions: Question[] = [];
  const unread: string[] = [];

  // What the person wrote in a structured form is theirs, verbatim.
  for (const r of model.requirements) statements.push({ id: r.id, slot: 'constraints', text: r.text, words: r.text, state: 'confirmed', supplied: { kind: 'person', origin: r.origin } });
  // Lines the person labelled with their slot are theirs, in that slot.
  model.labelled.forEach((l, i) =>
    statements.push({ id: `L${i + 1}`, slot: l.slot, text: l.text, words: l.text, state: 'confirmed', supplied: { kind: 'person', origin: l.origin } }),
  );
  for (const e of model.examples) {
    const text = [e.given && `given ${e.given}`, e.when && `when ${e.when}`, `then ${e.then}`].filter(Boolean).join(', ');
    statements.push({ id: e.id, slot: 'measures', text, words: text, tolerance: 'exactly as stated', state: 'confirmed', supplied: { kind: 'person', origin: e.origin } });
  }
  for (const c of model.clarifications) {
    const about = model.requirements.find((r) => r.origin.path === c.origin.path && r.origin.line === c.origin.line);
    questions.push({ id: c.id, origin: 'marker', text: about ? `"${about.text}": ${c.text}` : c.text, protects: 'a point you marked as undecided', consequence: 'high', sourceOrigin: c.origin });
  }

  // Readings of the rough parts: only schema-valid ones count, and only two from different families compare.
  const valid: Reading[] = [];
  (input.readings ?? []).forEach((r, i) => {
    const c = checkReading(r);
    if (c.ok) valid.push(c.reading);
    else unread.push(`reading ${i + 1} does not match the schema (${c.problems.join('; ')}), so it counts as unknown`);
  });
  const families = [...new Set(valid.map((r) => r.family))];
  if (model.context.length && families.length < 2) unread.push(`the free-text parts need readings from two model families; ${families.length ? `only ${families.join(', ')} read them` : 'none has read them yet'}`);
  // One family alone is not agreement. Its reading becomes proposals for the person to confirm, never facts.
  if (families.length === 1) questions.push(...proposalsFrom(valid[0]!));
  if (families.length >= 2) {
    const a = valid.find((r) => r.family === families[0])!;
    const b = valid.find((r) => r.family === families[1])!;
    const d = diffReadings(a, b);
    statements.push(...d.agreed);
    questions.push(...d.questions);
  }

  // Human terms, resolved without a model.
  const passages = [...model.context.map((t) => ({ text: t })), ...model.requirements.map((r) => ({ text: r.text, origin: r.origin }))];
  const hits = resolveTerms(lexicon, passages);
  statements.push(...hitStatements(hits));

  // Prerequisites, implications and the other side, by rule.
  statements.push(...derive([...model.context, ...model.requirements.map((r) => r.text), ...model.examples.map((e) => `${e.given} ${e.when} ${e.then}`)]));

  // Who is involved, offered from the kind of work: the primary people, and a branch of taps for any staff.
  const roles = input.roles ?? loadRoles();
  const texts = [...model.context, ...model.requirements.map((r) => r.text)];
  const domain = detectDomain(roles, texts);
  if (domain) {
    if (!statements.some((s) => s.slot === 'people' && s.supplied.kind === 'parse' && s.text.includes('who it is for'))) statements.push(primaryPeople(domain, domain.primary));
    const staffReq = model.requirements.find((r) => /\b(staff|advisors?|counsel+ors?|case ?workers?|managers?|coach(es)?)\b/i.test(r.text));
    if (staffReq) {
      questions.push(staffBranch(roles, domain, staffReq.text));
      // A marker asking which staff is answered by the branch, so it is not asked twice.
      for (let i = questions.length - 1; i >= 0; i--) {
        const q = questions[i]!;
        if (q.origin === 'marker' && q.sourceOrigin?.line === staffReq.origin.line && /\b(staff|who|which)\b/i.test(q.text)) questions.splice(i, 1);
      }
    }
  }

  // A missing problem or outcome is asked about with the person's own sentence offered, never from nothing.
  const sentences = model.context.flatMap((t) => t.split(/(?<=[.!?])\s+/));
  const said_ = sentences.find((t) => /\b(want|need|stop|keep|avoid|so that|so they|help)\b/i.test(t));
  // The end is an outcome, never a problem: it is offered for the outcome and the end, not for the problem.
  const offered = said_ ?? model.end ?? undefined;
  const offeredProblem = said_;

  // What the person already said settles a difference between readings: where one reading matches their own end
  // in mind, it wins, and they are never asked a question their words answer.
  const byOwnWords: Record<string, Given> = {};
  if (model.end)
    for (const q of questions) {
      if (q.origin !== 'diff' || !q.choices?.length) continue;
      const hit = q.choices.find((c) => model.end!.toLowerCase().includes(c.toLowerCase()) || same(c, model.end!, 0.6));
      if (hit) byOwnWords[q.id] = { pick: hit };
    }
  // Answers the person has already given are applied before anything is asked again.
  const answers: Record<string, Given> = { ...byOwnWords, ...(input.answers ?? {}) };
  const answered = new Set(Object.keys(answers));
  const said = (id: string): string[] => {
    const a = answers[id];
    if (!a) return [];
    return [...(a.pick ? [a.pick] : []), ...(a.picks ?? []), ...(a.other ? [a.other] : [])];
  };
  const asked = [...questions];
  // A tolerance answer sets how close the measure must be; it never becomes a measure of its own.
  const tolerate = (q: Question, v: string | undefined) => {
    if (!v) return;
    const target = q.id.startsWith('pair:tolerance:') ? q.id.slice('pair:tolerance:'.length) : null;
    const i = target ? statements.findIndex((s) => s.id === target) : -1;
    if (i >= 0) statements[i] = { ...statements[i]!, tolerance: v, state: 'confirmed' };
    else statements.push({ ...personSays('measures', q.tolerates!, q.id), tolerance: v });
  };
  const byId = (id: string) => asked.find((q) => q.id === id);
  // A branch: each pick becomes what it means, and the questions it opens are settled the same way or asked.
  const opened: Question[] = [];
  const settle = (q: Question): void => {
    const values = said(q.id);
    if (!values.length) {
      opened.push(q);
      return;
    }
    for (const v of values) {
      const m = q.means?.[v];
      statements.push(m ? { ...personSays(m.slot, m.text, q.id), ...(m.mark ? { mark: m.mark } : {}) } : personSays(q.slot ?? 'assumptions', v, q.id));
    }
    const next = [...values.flatMap((v) => q.follow?.[v] ?? []), ...(q.follow?.['__any__'] ?? [])];
    for (const f of next) settle(f);
  };
  for (const id of answered) {
    const q = byId(id);
    const values = said(id);
    const yes = answers[id]?.yes === true;
    if (!q) continue;
    if (q.tolerates !== undefined) {
      tolerate(q, values[0]);
      continue;
    }
    if (q.means || q.follow) {
      settle(q);
      continue;
    }
    if (q.answer?.kind === 'confirm' || (q.choices?.length === 1 && !q.answer)) {
      const v = yes ? (q.choices?.[0] ?? '') : values[0];
      if (v && q.slot) statements.push(personSays(q.slot, v, id));
    } else if (q.slot && values.length) for (const v of values) statements.push(personSays(q.slot, v, id));
    else if (values.length) statements.push(personSays('assumptions', `${q.text} ${values.join('; ')}`, id));
  }
  const end = answers['end'] ? (answers['end'].yes ? offered ?? null : said('end')[0] ?? null) : model.end;

  // The end in mind leads everything; without it, the person's own sentence is offered.
  if (!end)
    questions.push(
      offered
        ? { id: 'end', origin: 'missing', text: 'Is this the end the whole thing serves?', choices: [offered], protects: 'what every feature is built toward', consequence: 'high' }
        : { id: 'end', origin: 'missing', text: 'To what end is this being built? What should be different in people\'s lives because it exists?', protects: 'what every feature is built toward', consequence: 'high' },
    );
  for (const v of model.variants.filter((v) => !v.effectivity))
    questions.push({ id: `variant:${v.id}`, origin: 'missing', text: `Where does variant ${v.id} apply ("${v.text}")?`, protects: 'that every variant is authoritative only where it should be', consequence: 'high', sourceOrigin: v.origin });
  questions.push(
    ...checkPairings(statements).map((q) =>
      q.id === 'pair:problem' && offeredProblem
        ? { ...q, text: 'Is this the problem you want solved?', choices: [offeredProblem] }
        : q.id === 'pair:outcome' && offered
          ? { ...q, text: 'Is this what will be true when it works?', choices: [offered] }
          : q,
    ),
  );
  // Second pass: answers to questions raised only now (the pairings and the end) apply the same way.
  const late = questions.filter((q) => answered.has(q.id) && !asked.includes(q));
  for (const q of late) {
    if (q.tolerates !== undefined) {
      tolerate(q, said(q.id)[0]);
      continue;
    }
    const v = answers[q.id]?.yes ? q.choices?.[0] : said(q.id)[0];
    if (v && q.slot) statements.push(personSays(q.slot, v, q.id));
  }
  // A gap already offered as one reading's proposal is not asked a second time from nothing.
  const proposed = new Set(questions.filter((q) => q.id.startsWith('one:')).map((q) => q.slot));
  const covered = (q: Question) => (q.id === 'pair:problem' && proposed.has('problem')) || (q.id === 'pair:outcome' && proposed.has('outcome')) || (q.id === 'pair:measure' && proposed.has('measures'));
  const open = [...questions.filter((q) => !answered.has(q.id) && !covered(q)), ...opened.filter((q) => !answered.has(q.id))];
  const recheck = late.length ? checkPairings(statements).filter((q) => !answered.has(q.id)) : [];
  const remaining = late.length ? [...open.filter((q) => !q.id.startsWith('pair:')), ...recheck] : open;

  // Two of the person's words asking for different things in the same place is a redline, never a silent winner.
  const asks = new Map<string, { term: string; value: string }[]>();
  for (const h of hits) for (const [k, v] of Object.entries(h.term.choices)) asks.set(k, [...(asks.get(k) ?? []), { term: h.term.term, value: v }]);
  for (const [k, list] of asks) {
    const values = [...new Set(list.map((x) => x.value))];
    if (values.length > 1 && !answered.has(`clash:${k}`))
      remaining.push({ id: `clash:${k}`, origin: 'overlap', slot: 'constraints', text: `${list.map((x) => `"${x.term}"`).join(' and ')} want different things for the ${k}. Which should win?`, answer: { kind: 'single', options: list.map((x) => `${x.value} (for "${x.term}")`), other: true }, protects: `that the ${k} is what you meant`, consequence: 'medium' });
  }
  const clashChoice = (k: string) => {
    const a = answers[`clash:${k}`];
    const v = a?.pick ?? a?.other;
    return v ? v.replace(/ \(for "[^"]+"\)$/, '') : undefined;
  };

  const untied = model.context.filter((t) => !hits.some((h) => t.includes(h.words)));
  const finalModel = end === model.end ? model : { ...model, end };
  return { model: finalModel, title: resolveClashes(titleBlock(hits.map((h) => ({ term: h.term.term, choices: h.term.choices }))), asks, clashChoice), statements: assignBalloons(statements.map(fromFactory), input.prior), questions: shaped(remaining), unread, untied, instruments: { design: lexicon.version, roles: roles.version ?? 'unversioned' }, journeys: { accepted: [...(input.journeys?.accepted ?? [])].sort(), own: input.journeys?.own ?? [] }, people: input.people ?? {}, options: settleSheet(input.options) };
}

/**
 * The context every model call and agent working on this package receives: the end in mind first, then the
 * datum as it stands, so no piece of work is done without knowing to what end.
 */
export function modelContext(p: Prepared): string {
  const confirmed = p.statements.filter((s) => s.state === 'confirmed' || s.state === 'assumed');
  return [
    `End in mind: ${p.model.end ?? '(not yet stated; ask before building)'}`,
    '',
    'Datum (what the result must let people do, by balloon):',
    ...confirmed.map((s) => `[${s.balloon}] ${s.slot}: ${s.text}${s.tolerance ? ` (tolerance: ${s.tolerance})` : ''}${s.mark ? ` (${s.mark})` : ''}`),
    ...(p.model.notes.length ? ['', 'Engineering notes (how, for now; never the intent):', ...p.model.notes.map((n) => `- ${n.text}`)] : []),
  ].join('\n');
}
