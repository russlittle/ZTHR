/**
 * The review: raters that grade a schematic before it is signed, by rule, so no model is opened to find what a rule
 * can show. Two kinds. The people the software is for, derived from the schematic itself, each checked against the
 * journeys that will judge it: does every person reach their goals, are they protected, can they get in, and does the
 * schematic actually mean them. Then a panel for product, engineering, QA, design and access, and security and
 * privacy, each a short list of checks with the place each one is fixed.
 *
 * A grade is the share of a rater's checks that hold, as a letter; every check says why and where to fix it.
 */
import { framework } from './outcomes.ts';
import { schemaOf } from './schema.ts';
import type { Ballooned } from './frame.ts';
import { chosenJourneys, neededKinds, suggestJourneys } from './journeys.ts';
import { manifest } from './manifest.ts';
import type { Prepared } from './pipeline.ts';
import { outcomeGauges, type Gauge } from './release.ts';

/** Where a finding is fixed: a balloon, a question, a view, or your words. */
export type Fix = { kind: 'balloon'; balloon: number } | { kind: 'question'; id: string } | { kind: 'view'; view: 'plan' | 'build' | 'map' | 'hire' | 'outcomes' | 'information' } | { kind: 'words'; add: string };

export interface Check {
  readonly id: string;
  readonly holds: boolean;
  readonly text: string;
  readonly why: string;
  readonly fix?: Fix;
}

export interface Rater {
  readonly id: string;
  readonly name: string;
  readonly asks: string;
  readonly checks: readonly Check[];
  readonly grade: string;
}

export interface PersonaReview {
  readonly id: string;
  readonly name: string;
  readonly side: 'primary' | 'other' | 'variant';
  readonly balloon: number | null;
  readonly comesTo: readonly string[];
  readonly journeys: readonly string[];
  readonly protectedBy: readonly string[];
  readonly checks: readonly Check[];
  readonly grade: string;
}

export interface Review {
  readonly people: readonly PersonaReview[];
  /** Journeys walked by someone the schematic never names, and people it names who walk no journey. */
  readonly mismatches: readonly { text: string; fix?: Fix }[];
  readonly panel: readonly Rater[];
  readonly overall: string;
}

const LETTERS: readonly [number, string][] = [
  [0.95, 'A'],
  [0.85, 'A-'],
  [0.78, 'B+'],
  [0.7, 'B'],
  [0.62, 'B-'],
  [0.55, 'C+'],
  [0.45, 'C'],
  [0.35, 'D'],
  [0, 'F'],
];
export const letterOf = (share: number) => LETTERS.find(([min]) => share >= min)![1];
const gradeOf = (cs: readonly Check[]) => letterOf(cs.length ? cs.filter((c) => c.holds).length / cs.length : 0);

const nameOf = (s: Ballooned) => s.text.replace(/\s*\(.*\)$/, '').trim();
const stem = (w: string) => w.toLowerCase().replace(/(ies)$/, 'y').replace(/(?<!s)s$/, '');
const mentions = (text: string, who: string) => {
  const t = text.toLowerCase();
  const head = stem(who.split(/[ ,]/)[0]!);
  return head.length > 2 && new RegExp(`\\b${head.replace(/[^a-z]/g, '')}`).test(t);
};

export function review(p: Prepared): Review {
  const st = p.statements;
  const outcomes = st.filter((s) => s.slot === 'outcome');
  const people = st.filter((s) => s.slot === 'people');
  const nevers = st.filter((s) => s.slot === 'constraints' && /^never\b/i.test(s.text));
  const base = outcomeGauges(p);
  const chosen = chosenJourneys(p);
  const all: Gauge[] = [...base, ...chosen.map((c) => c.card)];
  const kinds = new Set<string>(chosen.flatMap((c) => (c.from ? [c.from.kind] : [])));
  const suggested = suggestJourneys(p);
  const m = manifest(p);

  const tuned = (name: string) => !!p.people.tune?.[name] && neededKinds({ ...p, people: { tune: { [name]: p.people.tune[name]! } } }).size > 0;
  // The people the software is for, from the schematic.
  const reviews: PersonaReview[] = people.map((pe, i) => {
    const name = nameOf(pe);
    const primary = /who it is for/.test(pe.text) || (!/other side/.test(pe.text) && i === 0);
    const theirs = all.filter((g) => mentions(g.persona, name) || (primary && !people.some((x) => x !== pe && mentions(g.persona, nameOf(x)))));
    const goals = primary ? outcomes.map((o) => o.text) : st.filter((s) => s.slot === 'constraints' && !/^never/i.test(s.text) && mentions(s.text, name)).map((s) => s.text);
    const guards = nevers.filter((n) => primary ? /\b(person|student|patient|client|they|someone)\b/i.test(n.text) || mentions(n.text, name) : mentions(n.text, name));
    const variant = (k: string) => kinds.has(k as never);
    const checks: Check[] = [
      { id: 'goal', holds: goals.length > 0, text: goals.length ? `Has ${goals.length} thing${goals.length === 1 ? '' : 's'} to come for` : 'Nothing on the schematic says what they come to do', why: 'A person the schematic names but gives no goal is either not needed, or missing an outcome.', fix: { kind: 'words', add: `It works when: ${name} can …` } },
      { id: 'walked', holds: theirs.length > 0, text: theirs.length ? `Walks ${theirs.length} journey${theirs.length === 1 ? '' : 's'}` : 'Walks no journey', why: 'Only a journey walked as this person proves the software works for them.', fix: { kind: 'view', view: 'plan' } },
      { id: 'protected', holds: !primary || guards.length > 0 || !nevers.length, text: guards.length ? `Protected by ${guards.length} thing${guards.length === 1 ? '' : 's'} that must never happen` : primary ? 'Nothing that must never happen protects them' : 'Their limits come from the people they serve', why: 'What must never happen to a person is checked on every journey.', ...(nevers[0] ? { fix: { kind: 'balloon' as const, balloon: nevers[0].balloon } } : {}) },
      ...(primary
        ? tuned(name)
          ? [...neededKinds({ ...p, people: { tune: { [name]: p.people.tune![name]! } } })].map((k) => ({ id: `needs-${k}`, holds: variant(k), text: variant(k) ? `Walked as they are tuned: ${k}` : `Tuned to need a journey for ${k === 'another language' ? 'their language' : k === 'small phone' ? 'a small phone' : k}, and none is walked`, why: 'You tuned this person; a journey that does not walk it their way does not prove it works for them.', fix: { kind: 'view' as const, view: 'plan' as const } }))
          : [
              { id: 'first', holds: variant('first time'), text: variant('first time') ? 'Walked by someone new to it' : 'Nobody walks it for the first time, without help', why: 'Most people meet it once, cold. Tune this person to say how they will use it.', fix: { kind: 'view' as const, view: 'plan' as const } },
              { id: 'access', holds: variant('low vision') || variant('another language'), text: variant('low vision') || variant('another language') ? 'Walked with low vision or in another language' : 'Nobody walks it with low vision or in another language', why: 'The title block promises both; only a journey proves them.', fix: { kind: 'view' as const, view: 'plan' as const } },
            ]
        : [{ id: 'limits', holds: guards.length > 0, text: guards.length ? 'What they may not do is on the schematic' : 'Nothing limits what they may do', why: 'Anyone on the other side of an activity needs limits as clear as their permissions.', ...(pe.balloon ? { fix: { kind: 'balloon' as const, balloon: pe.balloon } } : {}) }]),
    ];
    return { id: `person-${pe.balloon}`, name, side: primary ? 'primary' : 'other', balloon: pe.balloon, comesTo: goals, journeys: theirs.map((g) => g.goal), protectedBy: guards.map((g) => g.text), checks, grade: gradeOf(checks) };
  });

  // Do the journeys and the people match up?
  const named = people.map(nameOf);
  const strangers = [...new Set(all.map((g) => g.persona))].filter((who) => !named.some((n) => mentions(who, n)) && !/^(person|someone)\b/i.test(who));
  const mismatches = [
    ...strangers.map((who) => ({ text: `A journey is walked as "${who}", who is not on the schematic as a person`, fix: { kind: 'words' as const, add: `It is for: ${who}` } })),
    ...reviews.filter((r) => !r.journeys.length).map((r) => ({ text: `${r.name} is on the schematic but walks no journey`, fix: { kind: 'view' as const, view: 'plan' as const } })),
    ...(people.length ? [] : [{ text: 'Nobody is named: the schematic does not say who it is for', fix: { kind: 'words' as const, add: 'It is for: ' } }]),
  ];

  const measures = st.filter((s) => s.slot === 'measures');
  const loose = measures.filter((s) => !s.tolerance);
  const hire = p.model.labelled.length || p.model.end;
  const custom = m.lines.filter((l) => l.source === 'make: new');
  const library = m.lines.filter((l) => l.source === 'stock' || l.source === 'modify').length;
  const refusals = suggested.filter((s) => s.kind === 'refusal');
  const refused = refusals.filter((s) => p.journeys.accepted.includes(s.id));
  const feel = st.filter((s) => s.supplied.kind === 'lexicon');
  const marked = st.filter((s) => s.mark);
  const staff = st.some((s) => s.supplied.kind === 'derived' && s.supplied.rule === 'staff-view');
  const contacts = st.some((s) => s.supplied.kind === 'derived' && s.supplied.rule === 'contacts-people');
  const money = st.some((s) => s.supplied.kind === 'derived' && s.supplied.rule === 'money');
  const has = (part: string) => m.lines.some((l) => l.part === part);
  const q = (pred: (id: string) => boolean): Fix | undefined => {
    const x = p.questions.find((qq) => pred(qq.id));
    return x ? { kind: 'question', id: x.id } : undefined;
  };
  const fw = framework(p, m);
  const info = schemaOf(p);
  const yours = info.entities.reduce((a, e) => a + e.fields.filter((f) => f.from === 'your words' || f.from === 'provided').length, 0);
  const exposed = info.entities.flatMap((e) => e.fields.filter((f) => ['financial', 'private', 'health'].includes(f.sensitivity)).map((f) => `${e.name}.${f.name}`));
  const unset = fw.outcomes.filter((o) => !o.complete);
  const unmastered = fw.platform.filter((x) => x.highest !== 'M');
  const c = (id: string, holds: boolean, yes: string, no: string, why: string, fix?: Fix): Check => ({ id, holds, text: holds ? yes : no, why, ...(fix && !holds ? { fix } : {}) });

  const panel: Rater[] = [
    {
      id: 'product',
      name: 'Product',
      asks: 'Is it clear what this is for, for whom, and how anyone will know it worked?',
      checks: [
        c('end', !!p.model.end, 'The end in mind is stated', 'No end in mind: nothing says what all of this is ultimately for', 'Every choice the factory makes is judged against it.', { kind: 'words', add: '## The end in mind\n\n' }),
        c('outcomes', outcomes.length > 0, `${outcomes.length} outcome${outcomes.length === 1 ? ' says' : 's say'} what will be true when it works`, 'No outcome says what will be true when it works', 'An outcome is what a journey walks to.', { kind: 'words', add: 'It works when: ' }),
        c('measured', measures.length > 0, `${measures.length} measure${measures.length === 1 ? ' says' : 's say'} how anyone would know`, 'Nothing says how anyone would know it is doing a good job', 'A measure is what turns working into proven.', { kind: 'words', add: 'I would know it is doing a good job when: ' }),
        c('tolerances', !loose.length, 'Every measure says how close is close enough', `${loose.length} measure${loose.length === 1 ? '' : 's'} with no tolerance`, 'A measure with no tolerance cannot fail, so it proves nothing.', loose[0] ? q((id) => id.endsWith(loose[0]!.id)) ?? { kind: 'balloon', balloon: loose[0].balloon } : undefined),
        c('nongoals', st.some((s) => s.slot === 'nonGoals'), 'What is left out on purpose is said', 'Nothing is left out on purpose', 'Saying what it will not do stops the factory gold-plating.', { kind: 'words', add: 'It will not: ' }),
        c('framework', outcomes.length > 0 && !unset.length, 'Every outcome is assessed, judged on criteria, held to a target and documented, before it is built', `${unset.length} outcome${unset.length === 1 ? '' : 's'} still need${unset.length === 1 ? 's' : ''} ${unset[0]?.missing[0] ?? 'its assessments set'}`, 'Set the measure before the build, and nobody can bend it to fit what happened.', q((id) => id.startsWith('pair:achieved:')) ?? { kind: 'view', view: 'outcomes' }),
        c('hire', !!hire, 'Framed as a hire: the job, a good job, a good year', 'Not framed as a hire: no job, good job or good year stated', 'Leaders judge it the way they judge any hire.', { kind: 'view', view: 'hire' }),
      ],
      grade: '',
    },
    {
      id: 'engineering',
      name: 'Engineering',
      asks: 'Can the factory build it from what exists, with every balloon built and every custom part proved?',
      checks: [
        c('built', !m.gaps.length, 'Every balloon is built by a line on the manifest', `${m.gaps.length} balloon${m.gaps.length === 1 ? '' : 's'} nothing builds`, 'A balloon nothing builds is intent the factory will silently drop.', m.gaps[0] ? { kind: 'balloon', balloon: m.gaps[0].balloon } : undefined),
        c('proved', custom.every((l) => l.journeys.length > 0), 'Every custom assembly is proved by a journey', `${custom.filter((l) => !l.journeys.length).length} custom assembl${custom.filter((l) => !l.journeys.length).length === 1 ? 'y has' : 'ies have'} no journey`, 'Custom code is the riskiest code; only a journey proves it.', { kind: 'view', view: 'build' }),
        c('reuse', library >= custom.length, `${library} standard assemblies carry ${custom.length} custom ones`, `More custom assemblies (${custom.length}) than standard ones from the library (${library})`, 'The more that comes from the library, the more the fleet maintains for you.', { kind: 'view', view: 'build' }),
        c('inputs', !st.some((s) => s.slot === 'prerequisites') || has('Ingest connectors') || has('Is it me or is it down?'), 'Every input it depends on has a part to bring it in', 'An input it depends on has no part to bring it in', 'A missing input is the commonest failure in production.', { kind: 'view', view: 'build' }),
        c('information', !info.unread.length, `The information it keeps is read: ${info.entities.length} records, ${info.rules.length} integrity rules`, `${info.unread.length} sentence${info.unread.length === 1 ? '' : 's'} about the information to read or settle`, 'The records are the one part that cannot be rebuilt; nothing about them is guessed.', { kind: 'view', view: 'information' }),
        c('described', yours > 0, `${yours} field${yours === 1 ? '' : 's'} described in your words or provided by your team`, 'The records come from patterns alone: nothing describes what your team actually keeps', 'Patterns are a start; the fields that matter to the work come from the people who do it.', { kind: 'words', add: '## The information\n\n- A ' }),
        c('decided', !p.questions.length, 'Nothing open that changes the build', `${p.questions.length} question${p.questions.length === 1 ? '' : 's'} still change the build`, 'The factory should never guess what you meant.', p.questions[0] ? { kind: 'question', id: p.questions[0].id } : undefined),
      ],
      grade: '',
    },
    {
      id: 'qa',
      name: 'QA',
      asks: 'Would the tests catch it if it were wrong, including what must never happen?',
      checks: [
        c('walked', outcomes.length > 0 && outcomes.every((o) => base.some((g) => g.goal === o.text)), 'Every outcome has a journey', 'An outcome has no journey', 'A journey is the test a person would run.', { kind: 'view', view: 'plan' }),
        c('refused', !refusals.length || refused.length === refusals.length, refusals.length ? `Every never is tried and must be refused (${refused.length} of ${refusals.length})` : 'Nothing must never happen yet', `${refusals.length - refused.length} of ${refusals.length} things that must never happen are never tried`, 'A forbidden outcome is only proven by a journey that tries to cause it.', { kind: 'view', view: 'plan' }),
        c('edges', kinds.has('missing input') || kinds.has('take back') || kinds.has('first time'), 'Walked off the happy path too', 'Only the happy path is walked', 'Defects live where inputs are missing, permission is withdrawn, or someone is new.', { kind: 'view', view: 'plan' }),
        c('floors', loose.length === 0, 'Every measure has a floor a ratchet can hold', 'A measure has no floor to hold', 'A ratchet needs a starting floor.', loose[0] ? { kind: 'balloon', balloon: loose[0].balloon } : undefined),
        c('mastered', !unmastered.length, 'Every platform outcome is mastered by a feature', `${unmastered.length} of ${fw.platform.length} platform outcomes are not mastered anywhere: ${unmastered.slice(0, 3).map((x) => x.id).join(', ')}${unmastered.length > 3 ? '…' : ''}`, 'Introduced everywhere is a promise; mastered somewhere is proof.', { kind: 'view', view: 'outcomes' }),
        c('many', all.length >= Math.max(3, outcomes.length * 3), `${all.length} journeys: enough to catch a regression`, `${all.length} journey${all.length === 1 ? '' : 's'}: too few to catch a regression`, 'Software is tested well by many journeys, not one per outcome.', { kind: 'view', view: 'plan' }),
      ],
      grade: '',
    },
    {
      id: 'design',
      name: 'Design and access',
      asks: 'Will it feel the way it should, and can everyone get in?',
      checks: [
        c('feel', feel.length > 0, 'How it should feel is on the schematic, with measures', 'Nothing says how it should feel', 'Feel is part of the intent; calm or snappy can be measured.', { kind: 'words', add: 'Make it feel ' }),
        c('settled', !Object.values(p.title).some((e) => e.from === 'clash'), 'No two feel words pull against each other', 'Two feel words pull against each other', 'A clash left open is a coin toss in the build.', q((id) => id.startsWith('clash:'))),
        c('vision', kinds.has('low vision'), 'Walked with low vision and high contrast', 'Nobody walks it with low vision', 'The title block promises low vision mode; only a journey proves it.', { kind: 'view', view: 'plan' }),
        c('language', kinds.has('another language'), 'Walked in another language', 'Nobody walks it in another language', 'A switch to another language breaks layouts first.', { kind: 'view', view: 'plan' }),
        c('phone', !st.some((s) => s.supplied.kind === 'lexicon' && s.supplied.term === 'on a phone') || kinds.has('small phone'), 'Walked on a small phone', 'You said on a phone, and nobody walks it on one', 'A phone is where it will be judged.', { kind: 'view', view: 'plan' }),
      ],
      grade: '',
    },
    {
      id: 'security',
      name: 'Security and privacy',
      asks: 'Who can see what, who agreed to it, and could anything leak?',
      checks: [
        c('staff', !staff || (has('Row-level security controls') && has('Tamper-evident audit chain')), staff ? 'Staff access is controlled per record and every read recorded' : 'No one sees another person’s records', 'Staff see records with no per-record control or read audit', 'Someone else reading a person’s records is the highest-risk path.', { kind: 'view', view: 'build' }),
        c('consent', !contacts || st.some((s) => /consent|agreed/i.test(s.text)), contacts ? 'People are contacted only with consent' : 'Nobody is contacted', 'People are contacted with no consent on the schematic', 'Unwanted messages are a privacy harm and a legal one.'),
        c('money', !money || has('Independent second implementation'), money ? 'Every amount is calculated twice, independently' : 'No money is involved', 'Money is involved but amounts are calculated once', 'An amount wrong once is wrong for everyone.', { kind: 'view', view: 'build' }),
        c('sensitive', true, exposed.length ? `${exposed.length} sensitive field${exposed.length === 1 ? ' is' : 's are'} marked, and shown only to those allowed: ${exposed.slice(0, 3).join(', ')}${exposed.length > 3 ? '…' : ''}` : 'No field is marked financial, private or health', 'Every field carries its sensitivity from the data sheet.', 'Sensitivity on each field is what masking, exports and reports obey.', { kind: 'view', view: 'information' }),
        c('controls', marked.length === 0 || has('Locked datum'), `${marked.length} marked statement${marked.length === 1 ? '' : 's'} reach a control`, 'A marked statement reaches no control', 'Critical and significant characteristics need a control before they ship.'),
        c('tried', !nevers.length || refused.length > 0, 'At least one forbidden outcome is attacked by a journey', 'No journey tries what must never happen', 'A control nobody tries to break is a hope.', { kind: 'view', view: 'plan' }),
      ],
      grade: '',
    },
  ].map((r) => ({ ...r, grade: gradeOf(r.checks) }));

  const allChecks = [...panel.flatMap((r) => r.checks), ...reviews.flatMap((r) => r.checks)];
  return { people: reviews, mismatches, panel, overall: gradeOf(allChecks) };
}
