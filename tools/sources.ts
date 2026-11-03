import { z } from 'zod';
import { erd, field, type CollectionDef, type DataClass, type FieldDef } from '@zthr/store';
import * as K from '../apps/campus-services/src/contracts.js';
import { SERVICES } from '../apps/campus-services/src/index.js';

/**
 * Every outside source the Advocate reads, with an ERD of what each one returns. The campus services' entities are
 * read from the same zod schemas the contract tests hold every implementation to, so the pictures cannot drift
 * from what the app actually accepts. Each field carries its sensitivity, as the app's own data does.
 */

/** A zod schema's fields, typed in plain words, with every field given one class unless named otherwise. */
export function zodFields(schema: z.ZodTypeAny, cls: DataClass, overrides: Record<string, DataClass> = {}): FieldDef[] {
  const shape = (schema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
  return Object.entries(shape).map(([name, t]) => {
    const { type, optional } = describe(t);
    return { ...field(name, type, overrides[name] ?? cls), optional };
  });
}

function describe(t: z.ZodTypeAny): { type: string; optional: boolean } {
  let optional = false;
  let cur = t;
  for (;;) {
    if (cur instanceof z.ZodOptional || cur instanceof z.ZodNullable) {
      optional = true;
      cur = cur.unwrap() as z.ZodTypeAny;
    } else if (cur instanceof z.ZodEffects) cur = cur.innerType() as z.ZodTypeAny;
    else break;
  }
  const name = (x: z.ZodTypeAny): string =>
    x instanceof z.ZodString ? 'string' : x instanceof z.ZodNumber ? 'number' : x instanceof z.ZodBoolean ? 'boolean' : x instanceof z.ZodEnum || x instanceof z.ZodLiteral || x instanceof z.ZodUnion ? 'enum' : x instanceof z.ZodArray ? `${name(x.element as z.ZodTypeAny)}[]` : x instanceof z.ZodRecord ? 'record' : x instanceof z.ZodTuple ? 'tuple' : x instanceof z.ZodOptional ? name(x.unwrap() as z.ZodTypeAny) : 'object';
  return { type: name(cur), optional };
}

export interface Source {
  id: string;
  name: string;
  kind: 'campus service (synthetic twin)' | 'reference data in the repository' | 'public web service';
  how: string;
  /** Where its data lands in the app. */
  lands: string;
  entities: CollectionDef[];
}

const ent = (name: string, purpose: string, fields: FieldDef[], relations: [string, string, string][] = []): CollectionDef => ({ name, purpose, key: 'id', fields, relations });

export function sources(): Source[] {
  const svc = (id: keyof typeof SERVICES) => SERVICES[id].info;
  return [
    {
      id: 'dining', name: svc('dining').title, kind: 'campus service (synthetic twin)', how: 'The operator fetches locations, a week of hours and today\'s menus for each student\'s campus.', lands: 'campus_feeds (shared, not about any student)',
      entities: [
        ent('DiningLocation', 'A place to eat on campus', zodFields(K.DiningLocation, 'public'), [['Period', 'opens for', '||--o{'], ['MenuItem', 'serves', '||--o{']]),
        ent('Period', 'An opening period on a date', zodFields(K.Period, 'public')),
        ent('MenuItem', 'A dish with price, calories and allergens', zodFields(K.MenuItem, 'public')),
      ],
    },
    {
      id: 'transit', name: svc('transit').title, kind: 'campus service (synthetic twin)', how: 'GTFS-style routes and stops, a trip planner, and live arrivals and alerts. The operator plans each bus rider\'s trip to their first class; live times count for ten minutes.', lands: 'campus_feeds.stops (shared); commute_plans and transit_now (per student)',
      entities: [
        ent('Stop', 'A bus stop, with its campus when it serves one', zodFields(K.Stop, 'public'), [['Arrival', 'predicts', '||--o{']]),
        ent('Itinerary', 'A planned trip, at most one transfer', zodFields(K.Itinerary, 'public'), [['Leg', 'is made of', '||--|{']]),
        ent('Leg', 'One ride on one route', zodFields(K.Leg, 'public'), [['Stop', 'boards at', '}o--||']]),
        ent('Arrival', 'A predicted arrival with its delay', zodFields(K.Arrival, 'public')),
        ent('Alert', 'Snow delays, detours, no service', zodFields(K.Alert, 'public')),
      ],
    },
    {
      id: 'places', name: svc('places').title, kind: 'campus service (synthetic twin)', how: 'Study spaces, room availability and campus events (free food among them). A booking is a dispatch with an idempotency key, confirmed by looking it up.', lands: 'campus_feeds (spaces, events); dispatches (bookings, per student)',
      entities: [
        ent('Space', 'A library, study room, lab or lounge', zodFields(K.Space, 'public'), [['Reservation', 'is booked by', '||--o{']]),
        ent('Reservation', 'A booking the student asked for', zodFields(K.Reservation, 'personal', { id: 'internal', room: 'public', minutes: 'internal' })),
        ent('Event', 'A campus event; free ones are offered to hungry students', zodFields(K.Event, 'public')),
      ],
    },
    {
      id: 'careers', name: svc('careers').title, kind: 'campus service (synthetic twin)', how: 'Job postings with weekly schedules and a fair-chance flag, and a mentor directory. An introduction the student approves sends only their first name and note.', lands: 'campus_feeds (postings, mentors); dispatches (introductions)',
      entities: [
        ent('Posting', 'A job, with the hours it needs each week', zodFields(K.Posting, 'public')),
        ent('Mentor', 'A volunteer mentor and how many people they can take', zodFields(K.Mentor, 'public'), [['MentorRequest', 'receives', '||--o{']]),
        ent('MentorRequest', 'An introduction the student approved', zodFields(K.MentorRequest, 'internal', { firstName: 'personal', note: 'personal', meeting: 'personal' })),
      ],
    },
    {
      id: 'lms', name: svc('lms').title, kind: 'campus service (synthetic twin)', how: 'The student\'s own courses, assignments and announcements, read with their class-site token (sealed, granted only to the sync).', lands: 'deadlines (assignments, deduplicated by class-site id); classes (room changes)',
      entities: [
        ent('LmsCourse', 'A course the student is in', zodFields(K.LmsCourse, 'personal', { id: 'internal' }), [['LmsAssignment', 'assigns', '||--o{'], ['LmsAnnouncement', 'announces', '||--o{']]),
        ent('LmsAssignment', 'Work with a due date', zodFields(K.LmsAssignment, 'personal', { id: 'internal', course_id: 'internal' })),
        ent('LmsAnnouncement', 'A post from the instructor; room changes are read from these', zodFields(K.LmsAnnouncement, 'personal', { id: 'internal' })),
      ],
    },
    {
      id: 'catalog', name: 'Help catalog', kind: 'reference data in the repository', how: 'Verified programs and services, shaped after the Open Referral data specification. Each entry has a source and a verification date; stale entries are never offered as current.', lands: 'read in place; nothing copied per student',
      entities: [
        ent('Resource', 'A program or service, with how to apply and what to bring', [field('id', 'string', 'public'), field('name', 'string', 'public'), field('organization', 'string', 'public'), field('categories', 'enum[]', 'public'), field('serves', 'object', 'public', 'counties, colleges or national'), field('hours', 'string', 'public', 'unpublished means call ahead', true), field('phone', 'string', 'public', undefined, true), field('eligibility', 'object', 'public', 'rule and plain text'), field('howToApply', 'string[]', 'public'), field('documents', 'string[]', 'public'), field('source', 'object', 'public', 'url and license'), field('verifiedOn', 'date', 'public'), field('freshnessDays', 'number', 'public')], [['Scout', 'is kept fresh by', '}o--||']]),
        ent('Scout', 'A declared check that keeps a slice of the catalog current, admitted by the factory', [field('id', 'string', 'public'), field('owns', 'string[]', 'public', 'resource ids'), field('sources', 'url[]', 'public'), field('admitted_by', 'enum', 'public', 'factory or person')]),
      ],
    },
    {
      id: 'rules', name: 'Benefit rules and playbooks', kind: 'reference data in the repository', how: 'Dated parameters (poverty guidelines, SNAP limits) with sources and effective periods; playbooks as declared steps. A date outside every period answers unconfirmed, never a stale number.', lands: 'read in place; playbook progress lands in playbook_runs',
      entities: [
        ent('DatedParameter', 'A value with its source and the period it applies to', [field('value', 'object', 'public'), field('effectiveFrom', 'date', 'public'), field('effectiveTo', 'date', 'public'), field('source', 'url', 'public'), field('verifiedOn', 'date', 'public')]),
        ent('Playbook', 'A multi-week process as declared steps', [field('id', 'string', 'public'), field('title', 'string', 'public'), field('steps', 'Step[]', 'public'), field('sealed', 'string[]', 'public', 'facts it may open'), field('admitted_by', 'enum', 'public')], [['Step', 'runs', '||--|{']]),
        ent('Step', 'A question, wait, draft or document check', [field('id', 'string', 'public'), field('kind', 'enum', 'public'), field('text', 'string', 'public'), field('branches', 'record', 'public', undefined, true), field('timeout_days', 'number', 'public', undefined, true)]),
      ],
    },
    {
      id: 'colleges', name: 'Colleges', kind: 'reference data in the repository', how: 'One file per college: name, county, website and career center. Adding a college is adding a file; the builder drafts its county scouts.', lands: 'read in place',
      entities: [ent('College', 'A college the Advocate serves', [field('college', 'string', 'public'), field('name', 'string', 'public'), field('short', 'string', 'public'), field('county', 'string', 'public'), field('state', 'string', 'public'), field('website', 'url', 'public'), field('career', 'object', 'public', 'name, contact, source')])],
    },
    {
      id: 'weather', name: 'National Weather Service', kind: 'public web service', how: 'The forecast for the student\'s campus, through the egress door, for weather closures and bus delays.', lands: 'used in the moment; not stored',
      entities: [ent('Forecast', 'A forecast period', [field('name', 'string', 'public'), field('temperature', 'number', 'public'), field('shortForecast', 'string', 'public'), field('startTime', 'date-time', 'public')])],
    },
  ];
}

export function sourcesPage(): string {
  const all = sources();
  const flow = ["flowchart LR", ...all.map((s) => `  ${s.id}["${s.name}"]`), '  op((Operator))', '  egress{{Egress door}}', '  store[(App store)]', '  repo[(Repository)]',
    ...all.filter((s) => s.kind !== 'reference data in the repository').map((s) => `  ${s.id} --> egress`), '  egress --> op', '  op --> store',
    ...all.filter((s) => s.kind === 'reference data in the repository').map((s) => `  ${s.id} --- repo`), '  repo --> app[Advocate]', '  store --> app'].join('\n');
  return `# Data sources

<!-- generated by tools/sources.ts from the campus contracts and the repository's reference data; do not edit by hand -->

Everything the Advocate reads that it does not own. Campus services are reached only through the egress door,
fetched by the operator on a schedule, parsed against their contracts, and kept as shared feeds; a vendor that
drifts from its contract produces an unknown, never a wrong answer. Reference data lives in the repository, dated
and sourced. Each ERD below is drawn from the same schema the contract tests enforce; every field shows its
sensitivity class (see [Sensitive data](flows/sensitive-data.md)).

\`\`\`mermaid
${flow}
\`\`\`

| Source | Kind | How it is read | Where it lands |
| --- | --- | --- | --- |
${all.map((s) => `| ${s.name} | ${s.kind} | ${s.how} | ${s.lands} |`).join('\n')}

${all.map((s) => `## ${s.name}

${s.how}

\`\`\`mermaid
${erd(s.entities, { showClass: true })}
\`\`\`
`).join('\n')}
## Verified by

<!-- verified-by:start -->
<!-- verified-by:end -->
`;
}
