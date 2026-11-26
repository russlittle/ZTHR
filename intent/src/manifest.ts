/**
 * The build manifest: the bill of materials the factory starts from. Every line is a part, with where it comes from
 * (make or buy, in a manufacturing engineer's terms), why the drawing calls for it, which balloons it builds, and the
 * journeys that will prove it. Parts come from the part library: the built blocks, and the catalogue of parts every
 * app needs. What neither holds is made new for this intent, and shown as such, before the factory is asked to build.
 *
 * Every line is worked out by rule from the datum, so the same drawing always gives the same manifest, and a part
 * nobody can trace to a balloon or a default is never on it.
 */
import catalogData from '../catalog/catalog.json' with { type: 'json' };
import commonData from '../catalog/top50.json' with { type: 'json' };
import delightData from '../catalog/delight.json' with { type: 'json' };
import adminData from '../catalog/admin.json' with { type: 'json' };
import intentData from '../catalog/intent.json' with { type: 'json' };
import groupsData from '../catalog/groups.json' with { type: 'json' };
import baselineData from '../catalog/baseline.json' with { type: 'json' };
import type { Ballooned } from './frame.ts';
import { chosenJourneys } from './journeys.ts';
import type { Prepared } from './pipeline.ts';
import { outcomeGauges } from './release.ts';

/** Make or buy: where a part on the manifest will come from. */
export type Source = 'stock' | 'modify' | 'make: catalogued' | 'make: new';
export const SOURCE_LABEL: Record<Source, string> = {
  stock: 'Standard assembly, as is',
  modify: 'Standard assembly, extended',
  'make: catalogued': 'Catalogued part, to make',
  'make: new': 'Custom assembly, new',
};
export const SOURCE_WHAT: Record<Source, string> = {
  stock: 'A standard assembly in the library: built, tested and held to a mutation floor. Used as it is.',
  modify: 'A standard assembly covers part of it. The factory extends that assembly, and the extension is merged back into the library.',
  'make: catalogued': 'On the standard parts list but not built yet. The factory makes it to the catalogue’s spec, once, and it joins the library for every app after.',
  'make: new': 'Nothing in the library or the catalogue does this. The factory makes a custom assembly for this intent, from the balloons below, out of standard assemblies and parts.',
};

/** Who keeps a line working after it ships. */
export type Maintainer = 'fleet' | 'local';
export const MAINTAINER_LABEL: Record<Maintainer, string> = { fleet: 'The fleet', local: 'Your team' };
export const MAINTAINER_WHAT: Record<Source, string> = {
  stock: 'The fleet maintains it. Every fix and update to the assembly is pushed to every app that uses it.',
  modify: 'The fleet maintains it once the extension is merged into the library; from then on every app that uses it gets each update.',
  'make: catalogued': 'The fleet maintains it once it is made and in the library; every app that uses it after gets each update.',
  'make: new': 'Your team maintains it: it exists only in this app, held by this intent’s journeys.',
};
export const BASELINE = baselineData as { name: string; what: string; parts: { part: string; why: string }[] };

export interface Reason {
  readonly text: string;
  readonly balloons: readonly number[];
}

export interface Line {
  /** Find number, as on a bill of materials: the order the factory builds in. */
  readonly find: number;
  readonly part: string;
  readonly group: string;
  readonly gives: string;
  readonly source: Source;
  /** The library block it comes from or extends. */
  readonly from: string | null;
  readonly library: readonly { name: string; tests: number; mutationFloor: number | null; requires: readonly string[] }[];
  readonly why: readonly Reason[];
  readonly balloons: readonly number[];
  readonly journeys: readonly string[];
  /** Who keeps it working after it ships. */
  readonly maintainedBy: Maintainer;
  /** For a custom assembly: the find numbers of the parts and assemblies it is made from. */
  readonly uses: readonly number[];
  /** Inherited from the team's minimum starting point, whatever the intent says. */
  readonly floor: boolean;
}

export interface Manifest {
  readonly lines: readonly Line[];
  /** Balloons, and what builds each. A balloon nothing builds is a gap to close before the factory starts. */
  readonly trace: readonly { balloon: number; text: string; slot: string; by: readonly number[]; note: string | null }[];
  readonly counts: Record<Source, number>;
  readonly maintained: Record<Maintainer, number>;
  readonly baseline: { readonly name: string; readonly what: string; readonly count: number };
  readonly gaps: readonly { balloon: number; text: string; why: string }[];
}

interface Part {
  name: string;
  gives: string;
  group: string;
  coverage: 'yes' | 'partial' | 'none';
  from: string | null;
}

const LIB = (catalogData as { blocks: { name: string; purpose: string; requires: string[]; tests: number; mutationFloor?: number }[] }).blocks;
const PARTS = (() => {
  const groups = (groupsData as { groups: Record<string, string[]> }).groups;
  const groupOf = new Map(Object.entries(groups).flatMap(([g, ns]) => ns.map((n) => [n, g] as const)));
  type E = { name: string; gives: string; studentAdvocate?: { coverage: 'yes' | 'partial' | 'none'; from?: string } };
  const all: E[] = [
    ...(commonData as { blocks: E[] }).blocks,
    ...(delightData as { delighters: E[]; visual: E[] }).delighters,
    ...(delightData as { delighters: E[]; visual: E[] }).visual,
    ...(adminData as { blocks: E[] }).blocks,
    ...(intentData as { parts: E[] }).parts,
  ];
  return new Map<string, Part>(all.map((e) => [e.name, { name: e.name, gives: e.gives, group: groupOf.get(e.name) ?? 'Other', coverage: e.studentAdvocate?.coverage ?? 'none', from: e.studentAdvocate?.from ?? null }]));
})();

/** The order foundations are laid: what records and decides first, what people see last, this intent's features on top. */
export const BUILD_ORDER = ['Trust and evidence', 'Identity and access', 'Data', 'Work and integrations', 'Content', 'Experience', 'Appearance', 'Data movement and reporting', 'Intent', 'This intent'] as const;

/** The library blocks a catalogue line names in its coverage note ("store and runtime: …"). */
function blocksIn(from: string | null): string[] {
  if (!from) return [];
  const head = from.split(':')[0]!;
  return LIB.map((b) => b.name).filter((n) => new RegExp(`(^|[ ,]|and )${n.replace('-', '\\-')}($|[ ,])`).test(head));
}

interface Ctx {
  readonly p: Prepared;
  readonly st: readonly Ballooned[];
  readonly kinds: ReadonlySet<string>;
}

type When = (c: Ctx) => Reason | null;

const said = (re: RegExp, text: string): When => (c) => {
  const hits = c.st.filter((s) => re.test(s.text) || (s.words ? re.test(s.words) : false));
  return hits.length ? { text, balloons: hits.map((s) => s.balloon) } : null;
};
const rule = (id: string, text: string): When => (c) => {
  const hits = c.st.filter((s) => s.supplied.kind === 'derived' && s.supplied.rule === id);
  return hits.length ? { text, balloons: hits.map((s) => s.balloon) } : null;
};
const feel = (term: string, text: string): When => (c) => {
  const hits = c.st.filter((s) => s.supplied.kind === 'lexicon' && s.supplied.term === term);
  return hits.length ? { text, balloons: hits.map((s) => s.balloon) } : null;
};
const journey = (kind: string, text: string): When => (c) => (c.kinds.has(kind) ? { text, balloons: [] } : null);
const slot = (sl: string, text: string): When => (c) => {
  const hits = c.st.filter((s) => s.slot === sl);
  return hits.length ? { text, balloons: hits.map((s) => s.balloon) } : null;
};
const other = (text: string): When => (c) => {
  const hits = c.st.filter((s) => s.slot === 'people' && /other side/.test(s.text));
  return hits.length ? { text, balloons: hits.map((s) => s.balloon) } : null;
};
const always = (text: string): When => () => ({ text, balloons: [] });

/**
 * What calls for each part. The floor is on every app's manifest: what the title block's defaults and the
 * factory's own evidence need. Everything else is called for by something on the drawing.
 */
const CALLS: readonly { parts: readonly string[]; when: When }[] = [
  // People and who may see what.
  { parts: ['Authentication', 'User accounts'], when: slot('people', 'People use it, so each signs in to their own') },
  { parts: ['Authorization', 'Roles and permissions (RBAC)', 'Row-level security controls', 'Permission explainer'], when: other('More than one kind of person uses it, and each may see only their part') },
  { parts: ['Authorization', 'Roles and permissions (RBAC)', 'Row-level security controls', 'Permission explainer'], when: rule('staff-view', 'Staff see records that belong to someone else') },
  { parts: ['Organizations and teams'], when: said(/\b(college|office|organi[sz]ation|team|department|school|clinic)\b/i, 'People belong to an organisation and an office within it') },
  { parts: ['Privacy: consent, export, erasure', 'Your whole record'], when: said(/\b(permission|consent|grant|share|shared|withdraw|revoke|take back)\b/i, 'Access is granted by the person and can be taken back') },
  { parts: ['Tamper-evident audit chain', 'Field provenance'], when: rule('staff-view', 'Someone else reads a person’s records, so every read is recorded') },
  // Reaching people.
  { parts: ['Notifications', 'Email', 'Background jobs and scheduling'], when: rule('contacts-people', 'It contacts people') },
  { parts: ['Reminders that stop'], when: said(/\bremind/i, 'Reminders, which must stop the moment the thing is done') },
  { parts: ['Dates and time zones'], when: said(/\b(due|deadline|quiet hours|time zone|date|weekday|weekend|overnight)\b/i, 'Dates, deadlines, quiet hours and time zones') },
  { parts: ['Calendar and booking', 'Find a time'], when: said(/\b(appointment|booking|book|meeting|calendar|schedule a)\b/i, 'People book time') },
  { parts: ['Notifications'], when: journey('by text', 'A journey is walked from the message alone') },
  // Money, irreversible acts and outside services.
  { parts: ['Receipts', 'Independent second implementation', 'Decision tables'], when: rule('money', 'Money is involved: every amount is a critical calculation, written twice and compared') },
  { parts: ['Payments'], when: said(/\b(pay online|charge|payment|refund|checkout)\b/i, 'People pay in the app') },
  { parts: ['Undo anything', 'Receipts'], when: rule('irreversible', 'Something cannot be undone once done, so everything else can be') },
  { parts: ['Outbound HTTP', 'Runs', 'Webhooks'], when: rule('outside-service', 'It calls a service outside the app') },
  // Data in and out.
  { parts: ['Ingest connectors', 'Mapping studio', 'Quarantine and repair'], when: said(/\b(already in place|existing|records system|import|spreadsheet|sync)\b/i, 'Data comes from a system already in place') },
  { parts: ['Ingest connectors', 'Quarantine and repair', 'Is it me or is it down?'], when: slot('prerequisites', 'It depends on inputs that will sometimes be missing or late') },
  { parts: ['Report builder', 'Why am I seeing this?'], when: said(/\b(see who|struggling|at risk|flag|dashboard|report|overview)\b/i, 'People see a view across others, flagged by a rule that must explain itself') },
  { parts: ['Search'], when: said(/\b(find|search|look up)\b/i, 'People find things') },
  { parts: ['File upload and storage', 'Document parsing'], when: said(/\b(upload|document|scan|photo|attach|file)\b/i, 'People bring documents') },
  { parts: ['Chat', 'Model guard', 'AI model gateway', 'Safety router'], when: said(/\b(chat|assistant|ai|ask (a|any|their) questions?|answers? (their )?questions)\b/i, 'People ask in their own words') },
  { parts: ['Safety router'], when: said(/\b(student|patient|crisis|housed|homeless|food|shut-?off|evict)/i, 'People it serves may be in crisis; a crisis message is routed to a safety reply first') },
  // Measures.
  { parts: ['Product analytics'], when: slot('measures', 'Measures are counted from what people do, with their consent') },
  { parts: ['Metrics and tracing'], when: (c) => {
    const hits = c.st.filter((s) => s.slot === 'measures' && /\b(second|minute|ms|fast|within)\b/i.test(`${s.text} ${s.tolerance ?? ''}`));
    return hits.length ? { text: 'A measure is held to a time', balloons: hits.map((s) => s.balloon) } : null;
  } },
  // How it should feel.
  { parts: ['Density budget', 'Palettes'], when: feel('calm', 'You said calm: one primary action, quiet colour') },
  { parts: ['Caching', 'Metrics and tracing'], when: feel('snappy', 'You said snappy: answers inside the feedback budget, measured on every walk') },
  { parts: ['Density budget', 'Progress you can feel'], when: feel('at a glance', 'You said at a glance') },
  { parts: ['Teaching empty states'], when: feel('friendly', 'You said friendly') },
  { parts: ['Brand themes'], when: feel('professional', 'You said professional') },
  { parts: ['Progressive web features'], when: feel('on a phone', 'You said on a phone') },
  { parts: ['Progressive web features'], when: rule('phone', 'It is used on a phone') },
  { parts: ['Reading comfort'], when: feel('easy to read', 'You said easy to read') },
  // Journeys the person added.
  { parts: ['Internationalization', 'Your language'], when: journey('another language', 'A journey is walked with the app in another language') },
  { parts: ['Teaching empty states', 'Contextual help'], when: journey('first time', 'A journey is walked by someone new') },
  { parts: ['Pick up where you left off', 'Smart defaults'], when: journey('returning', 'A journey is walked by someone who does this often') },
  { parts: ['Permission explainer'], when: journey('refusal', 'Refusal journeys need a plain reason for every no') },
  { parts: ['Privacy: consent, export, erasure'], when: journey('take back', 'A journey takes permission back') },
  { parts: ['Is it me or is it down?'], when: journey('missing input', 'A journey is walked with an input missing or late') },
];

export function manifest(p: Prepared): Manifest {
  const st = p.statements;
  const chosen = chosenJourneys(p);
  const kinds = new Set(chosen.flatMap((j) => (j.from ? [j.from.kind] : [])));
  const ctx: Ctx = { p, st, kinds };
  const by = new Map<string, { why: Reason[]; floor: boolean }>();
  // The team's minimum starting point comes first: every app inherits it, whatever the intent says.
  const calls: { parts: readonly string[]; when: When; floor?: true }[] = [
    ...BASELINE.parts.map((b) => ({ parts: [b.part], when: always(`${b.why} (inherited from the ${BASELINE.name})`), floor: true as const })),
    ...CALLS,
  ];
  for (const c of calls) {
    const r = c.when(ctx);
    if (!r) continue;
    for (const name of c.parts) {
      if (!PARTS.has(name)) throw new Error(`the manifest calls for "${name}", which is not in the catalogue`);
      const e = by.get(name) ?? { why: [], floor: true };
      if (!e.why.some((w) => w.text === r.text)) e.why.push(r);
      e.floor = e.floor && !!c.floor;
      by.set(name, e);
    }
  }
  // Journeys prove parts through the balloons they walk: an outcome's gauge proves the parts that build that outcome.
  const gaugeIds = [...outcomeGauges(p).map((g) => g.id), ...chosen.map((j) => j.card.id)];
  const outcomes = st.filter((s) => s.slot === 'outcome');
  const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item';

  const known: Omit<Line, 'find'>[] = [...by.entries()].map(([name, e]) => {
    const part = PARTS.get(name)!;
    const source: Source = part.coverage === 'yes' ? 'stock' : part.coverage === 'partial' ? 'modify' : 'make: catalogued';
    const blocks = blocksIn(part.from);
    const balloons = [...new Set(e.why.flatMap((w) => w.balloons))].sort((a, b) => a - b);
    return {
      part: name,
      group: part.group,
      gives: part.gives,
      source,
      from: part.from,
      library: blocks.map((b) => {
        const l = LIB.find((x) => x.name === b)!;
        return { name: l.name, tests: l.tests, mutationFloor: l.mutationFloor ?? null, requires: l.requires };
      }),
      why: e.why,
      balloons,
      uses: [],
      maintainedBy: 'fleet' as const,
      journeys: e.floor ? gaugeIds : chosen.filter((j) => j.from && j.from.balloons.some((b) => balloons.includes(b))).map((j) => j.card.id).concat(outcomeGauges(p).filter(() => balloons.length > 0).map((g) => g.id)).filter((v, i, a) => a.indexOf(v) === i),
      floor: e.floor,
    };
  });

  // What no part does is made new: every outcome, and every behaviour the person asked for in their own words.
  // Each is an assembly of the parts that build its balloons, as a bill of materials nests parts under assemblies.
  const children = (s: Ballooned) => st.filter((x) => x !== s && (x.supplied.kind === 'derived' || x.supplied.kind === 'lexicon') && !!x.words && s.text.toLowerCase().includes(x.words.toLowerCase()));
  const STOP = new Set(['should', 'must', 'will', 'when', 'then', 'with', 'that', 'this', 'every', 'each', 'them', 'they', 'their', 'from', 'have', 'been', 'only', 'more', 'what', 'into', 'once', 'there', 'about', 'after', 'before']);
  const words = (t: string) => new Set((t.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)));
  const holds = (o: Ballooned) => {
    const w = words(o.text);
    return st.filter((s) => s !== o && (s.slot === 'measures' || (s.slot === 'constraints' && s.supplied.kind !== 'lexicon')) && [...words(s.text)].some((x) => w.has(x)));
  };
  const asked = st.filter((s) => s.slot === 'constraints' && s.supplied.kind === 'person' && !/^(never|must not)\b/i.test(s.text) && !children(s).some((c) => c.supplied.kind === 'lexicon'));
  const features: Omit<Line, 'find'>[] = [...outcomes, ...asked].map((o) => {
    const held = holds(o);
    const kids = children(o);
    const gid = slug(o.text);
    const balloons = [...new Set([o.balloon, ...held.map((h) => h.balloon), ...kids.map((k) => k.balloon)])].sort((a, b) => a - b);
    return {
      maintainedBy: 'local' as const,
      part: `Custom assembly: ${o.text}`,
      group: 'This intent',
      gives: o.text,
      source: 'make: new' as const,
      from: null,
      library: [],
      why: [
        { text: o.slot === 'outcome' ? 'An outcome on the drawing; no library or catalogue part does it' : 'You asked for it in your own words; no library or catalogue part does it', balloons: [o.balloon] },
        ...(held.length ? [{ text: 'Held to these measures and rules', balloons: held.map((h) => h.balloon) }] : []),
        ...(kids.length ? [{ text: 'With what follows from it', balloons: kids.map((k) => k.balloon) }] : []),
      ],
      balloons,
      journeys: [gid, ...chosen.filter((j) => j.from?.balloons.some((b) => balloons.includes(b))).map((j) => j.card.id)].filter((v, i, a) => gaugeIds.includes(v) && a.indexOf(v) === i),
      uses: [],
      floor: false,
    };
  });

  const rank = (g: string) => {
    const i = (BUILD_ORDER as readonly string[]).indexOf(g);
    return i < 0 ? BUILD_ORDER.length : i;
  };
  const order: Record<Source, number> = { stock: 0, modify: 1, 'make: catalogued': 2, 'make: new': 3 };
  const lines: Line[] = [...known, ...features]
    .sort((a, b) => rank(a.group) - rank(b.group) || order[a.source] - order[b.source] || a.part.localeCompare(b.part))
    .map((l, i) => ({ ...l, find: i + 1 }));
  // An assembly uses every part, below the floor, that builds one of its balloons.
  const assembled: Line[] = lines.map((l) =>
    l.source === 'make: new' ? { ...l, uses: lines.filter((x) => x.source !== 'make: new' && !x.floor && x.balloons.some((b) => l.balloons.includes(b))).map((x) => x.find) } : l,
  );

  // The drawing, balloon by balloon, against what builds it.
  const note = (s: Ballooned): string | null =>
    s.slot === 'nonGoals' ? 'Left out on purpose: nothing builds it, and a journey checks it stays out' : s.slot === 'assumptions' ? 'Taken as given: nothing builds it; it is checked when it stops being true' : s.slot === 'why' || s.slot === 'problem' ? 'Served by every part; measured through the outcomes' : null;
  const builders = (s: Ballooned) => assembled.filter((l) => l.balloons.includes(s.balloon)).map((l) => l.find);
  // A line of the person's that only says how it should feel is built by whatever builds the feel it names.
  const trace = st.map((s) => {
    const by = builders(s);
    const via = by.length ? by : [...new Set(children(s).flatMap(builders))].sort((a, b) => a - b);
    return { balloon: s.balloon, text: s.text, slot: s.slot, by: via, note: note(s) };
  });
  const gaps = trace.filter((t) => !t.by.length && !t.note).map((t) => ({ balloon: t.balloon, text: t.text, why: t.slot === 'people' ? 'nobody signs in as this person yet' : t.slot === 'prerequisites' ? 'no part supplies this input' : 'no part on the manifest builds it' }));
  const counts: Record<Source, number> = { stock: 0, modify: 0, 'make: catalogued': 0, 'make: new': 0 };
  for (const l of assembled) counts[l.source]++;
  const maintained: Record<Maintainer, number> = { fleet: 0, local: 0 };
  for (const l of assembled) maintained[l.maintainedBy]++;
  return { lines: assembled, trace, counts, maintained, baseline: { name: BASELINE.name, what: BASELINE.what, count: assembled.filter((l) => l.floor).length }, gaps };
}

/** The manifest as the factory reads it, and as a person reads it, for the release package. */
export function manifestFiles(m: Manifest): Record<string, string> {
  const json = {
    schema: 'zthr-build-manifest/1',
    counts: m.counts,
    maintained: m.maintained,
    baseline: m.baseline,
    lines: m.lines.map((l) => ({ find: l.find, part: l.part, group: l.group, source: l.source, maintainedBy: l.maintainedBy, inherited: l.floor, uses: l.uses, from: l.from, library: l.library.map((b) => b.name), balloons: l.balloons, journeys: l.journeys, why: l.why.map((w) => w.text), floor: l.floor })),
    gaps: m.gaps,
  };
  const row = (l: Line) => `| ${l.find} | ${l.part.replace(/\|/g, '\\|')} | ${l.group} | ${SOURCE_LABEL[l.source]} | ${MAINTAINER_LABEL[l.maintainedBy]}${l.floor ? ' (inherited)' : ''} | ${l.library.map((b) => b.name).join(', ') || '–'} | ${l.balloons.join(', ') || 'team minimum'} | ${l.journeys.length} |`;
  const md = `# Build manifest

What the factory starts from: ${m.lines.length} lines. ${m.counts.stock} standard assemblies used as they are, ${m.counts.modify} standard assemblies extended, ${m.counts['make: catalogued']} catalogued parts to make, and ${m.counts['make: new']} custom assemblies made new for this intent.

**Who maintains it:** the fleet maintains ${m.maintained.fleet}, and pushes every update to each app that uses them; this app's team maintains ${m.maintained.local}. ${m.baseline.count} lines are inherited from the ${m.baseline.name}.

\`\`\`mermaid
pie showData title Where each line comes from
  "Standard assembly, as is" : ${m.counts.stock}
  "Standard assembly, extended" : ${m.counts.modify}
  "Catalogued part, to make" : ${m.counts['make: catalogued']}
  "Custom assembly, new" : ${m.counts['make: new']}
\`\`\`

| Find | Line | Group | Source | Maintained by | Standard assembly | Balloons | Journeys |
| --- | --- | --- | --- | --- | --- | --- | --- |
${m.lines.map(row).join('\n')}

${m.gaps.length ? `## Balloons nothing on the manifest builds\n\n${m.gaps.map((g) => `- ${g.balloon}: ${g.text} (${g.why})`).join('\n')}\n` : 'Every balloon on the drawing is built by a line on this manifest, or is left out or taken as given on purpose.\n'}`;
  return { 'build-manifest.json': `${JSON.stringify(json, null, 1)}\n`, 'build-manifest.md': md };
}
