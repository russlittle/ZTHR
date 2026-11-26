/**
 * The interfaces every build carries, set on the factory spec sheet: the API, the events feed, agent tools,
 * training, documentation and connections to the tools a team already uses.
 *
 * The rule is define always, enable by choice. Every custom assembly gets an API contract, an event channel and a
 * training module, written from the same datum as its code and held to the same access rules as its screens. The
 * spec sheet decides which of them are switched on. Switched off, a contract is documented and deployed closed:
 * nothing answers until a person turns it on, and nobody holds a scope for it. Documentation is not optional: every
 * build carries a guide for the people who use it and a reference for the people who run and change it.
 *
 * Every file here is worked out by rule from the datum and the manifest, so the same inputs give the same bytes.
 */
import { byKind, catalogue, chosen, outbox, type Plan } from './connectors.ts';
import type { Line, Manifest } from './manifest.ts';
import type { Prepared } from './pipeline.ts';

/** How far an interface reaches: not at all, every feature, or the features named. */
export type Reach = 'off' | 'all' | 'some';
/** A connector id from the catalogue, or none. */
export type Tool = string;

export interface Options {
  readonly api?: { readonly reach?: Reach; readonly features?: readonly string[]; readonly events?: boolean; readonly agents?: boolean };
  readonly training?: { readonly reach?: Reach; readonly features?: readonly string[] };
  readonly connect?: { readonly tickets?: Tool; readonly wiki?: Tool; readonly chat?: Tool; readonly feed?: boolean; readonly feedTo?: Tool; readonly identity?: Tool };
  readonly admin?: { readonly query?: QueryReach };
}

/** Where the query console runs. Out of production by default, so it cannot be used to take real data out. */
export type QueryReach = 'off' | 'non-production' | 'everywhere';
export const QUERY_REACH: readonly QueryReach[] = ['non-production', 'everywhere', 'off'];

export interface Settled {
  readonly api: { readonly reach: Reach; readonly features: readonly string[]; readonly events: boolean; readonly agents: boolean };
  readonly training: { readonly reach: Reach; readonly features: readonly string[] };
  readonly connect: { readonly tickets: Tool; readonly wiki: Tool; readonly chat: Tool; readonly feed: boolean; readonly feedTo: Tool; readonly identity: Tool };
  readonly admin: { readonly query: QueryReach };
}

/** A tool the catalogue holds for that kind of connection, or the fallback. Names from before the catalogue still work. */
function known(kind: 'tickets' | 'docs' | 'chat' | 'feed' | 'identity', v: string | undefined, fallback = 'none'): Tool {
  if (!v || v === 'none') return fallback;
  const hit = byKind(kind).find((x) => x.id === v || x.name.toLowerCase() === v.toLowerCase());
  return hit ? hit.id : fallback;
}

/** The spec sheet with every choice filled in. Off is the default for anything that opens the app to the outside. */
export function settle(o: Options | undefined): Settled {
  return {
    api: { reach: o?.api?.reach ?? 'off', features: [...(o?.api?.features ?? [])].sort(), events: !!o?.api?.events, agents: !!o?.api?.agents },
    training: { reach: o?.training?.reach ?? 'off', features: [...(o?.training?.features ?? [])].sort() },
    connect: {
      tickets: known('tickets', o?.connect?.tickets),
      wiki: known('docs', o?.connect?.wiki),
      chat: known('chat', o?.connect?.chat),
      feed: !!o?.connect?.feed,
      feedTo: known('feed', o?.connect?.feedTo, 'webhooks'),
      identity: known('identity', o?.connect?.identity, 'google'),
    },
    admin: { query: o?.admin?.query ?? 'non-production' },
  };
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const nameOf = (id: string) => byKind('tickets').concat(byKind('docs'), byKind('chat'), byKind('feed'), byKind('identity')).find((x) => x.id === id)?.name ?? id;

/** The stable id of a feature: its outcome or request, as a slug. */
export const featureId = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item';

const reaches = (r: { reach: Reach; features: readonly string[] }, id: string) => r.reach === 'all' || (r.reach === 'some' && r.features.includes(id));
export const apiOn = (s: Settled, id: string): boolean => reaches(s.api, id);
export const trainingOn = (s: Settled, id: string): boolean => reaches(s.training, id);
/** Is anything reached from outside the app at all? */
export const anyApi = (s: Settled): boolean => s.api.reach === 'all' || (s.api.reach === 'some' && s.api.features.length > 0);
export const anyTraining = (s: Settled): boolean => s.training.reach === 'all' || (s.training.reach === 'some' && s.training.features.length > 0);

/** The features a build has: its custom assemblies, each with the id its contract, events and training share. */
export function features(m: Manifest): { id: string; line: Line }[] {
  return m.lines.filter((l) => l.source === 'make: new').map((l) => ({ id: featureId(l.gives), line: l }));
}

/** What the spec sheet says, in a sentence, for the screen and the package. */
export function describe(s: Settled, total: number): { api: string; training: string; docs: string; connect: string; admin: string } {
  const n = (r: { reach: Reach; features: readonly string[] }) => (r.reach === 'all' ? total : r.reach === 'some' ? r.features.length : 0);
  const extra = [s.api.events ? 'an events feed' : '', s.api.agents ? 'agent tools' : ''].filter(Boolean).join(' and ');
  return {
    api: anyApi(s) ? `Switched on for ${n(s.api)} of ${total} feature${total === 1 ? '' : 's'}${extra ? `, with ${extra}` : ''}. The rest are defined and documented, and closed.` : `Defined and documented for all ${total} feature${total === 1 ? '' : 's'}, and closed. Nothing answers until it is switched on.`,
    training: anyTraining(s) ? `Published for ${n(s.training)} of ${total} feature${total === 1 ? '' : 's'} as a cmi5 course. The rest are written and held back.` : `Written for all ${total} feature${total === 1 ? '' : 's'} and held back. Switch it on to publish a cmi5 course.`,
    docs: 'Always: a guide for each person who uses it, and a reference for the people who run and change it.',
    admin: `The admin suite comes with every app. The query console runs ${s.admin.query === 'off' ? 'nowhere: it is left out of every build' : s.admin.query === 'non-production' ? 'in development, test and UAT, and is left out of the production build' : 'everywhere, production included, through the same access rules, masking and audit as the screens'}. Test records and UAT overrides are never in production.`,
    connect: `${cap([s.connect.tickets !== 'none' ? `progress to ${nameOf(s.connect.tickets)}` : '', s.connect.wiki !== 'none' ? `docs to ${nameOf(s.connect.wiki)}` : '', s.connect.chat !== 'none' ? `notes to ${nameOf(s.connect.chat)}` : '', s.connect.feed ? `a data feed by ${nameOf(s.connect.feedTo)}` : ''].filter(Boolean).join(', ') || 'Nothing sent anywhere')}. People sign in to the app with ${nameOf(s.connect.identity)}.`,
  };
}

// ---------------------------------------------------------------- a small, stable YAML writer

function y(v: unknown, pad = ''): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return /^[A-Za-z0-9 _./:-]+$/.test(v) && !/^(true|false|null|yes|no|on|off|\d.*)$/i.test(v) && !/: |^-|^ | $/.test(v) ? v : JSON.stringify(v);
  if (Array.isArray(v)) return v.length ? v.map((x) => `\n${pad}- ${y(x, `${pad}  `).replace(/^\n\s*/, '')}`).join('') : '[]';
  const e = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  const key = (k: string) => (/^[A-Za-z_$][A-Za-z0-9_$.-]*$/.test(k) ? k : JSON.stringify(k));
  return e.length
    ? e.map(([k, x]) => {
        const v = y(x, `${pad}  `);
        return `\n${pad}${key(k)}:${v.startsWith('\n') ? '' : ' '}${v}`;
      }).join('')
    : '{}';
}
const yamlDoc = (head: string, v: unknown) => `${head}${y(v).replace(/^\n/, '')}\n`;

// ---------------------------------------------------------------- the API contract

/** Who may use a feature, from the people on the schematic. Scopes map to the same roles the screens use. */
function roles(p: Prepared): string[] {
  const names = p.statements.filter((s) => s.slot === 'people').map((s) => s.text.replace(/\s*\(.*$/, '').replace(/,.*$/, '').trim());
  return [...new Set(names)].slice(0, 6);
}

function openapi(p: Prepared, m: Manifest, s: Settled, revision: number): string {
  const fs = features(m);
  const scopes = Object.fromEntries(fs.flatMap((f) => [[`${f.id}:read`, `Read: ${f.line.gives}`], [`${f.id}:write`, `Change: ${f.line.gives}`]]));
  const op = (f: { id: string; line: Line }, verb: 'read' | 'write', summary: string, extra: Record<string, unknown> = {}) => ({
    summary,
    operationId: `${verb === 'read' ? 'get' : 'set'}-${f.id}${extra['_suffix'] ?? ''}`,
    tags: [f.id],
    security: [{ oauth2: [`${f.id}:${verb}`] }],
    'x-zthr-enabled': apiOn(s, f.id),
    'x-zthr-access': 'Same authorization as the screens: role-based, then row-level. A caller sees only the rows its person could see.',
    'x-zthr-balloons': f.line.balloons,
    'x-zthr-journeys': f.line.journeys,
    responses: {
      '200': { description: 'The records the caller may see.' },
      '401': { description: 'No valid token.' },
      '403': { description: 'The token does not hold this scope, or the feature is switched off on the spec sheet.' },
      '429': { description: 'Too many requests for this caller.' },
    },
  });
  const paths = Object.fromEntries(
    fs.flatMap((f) => [
      [`/v1/${f.id}`, { get: op(f, 'read', `List what this feature holds: ${f.line.gives}`), post: { ...op(f, 'write', `Do it: ${f.line.gives}`), operationId: `set-${f.id}` } }],
      [`/v1/${f.id}/{id}`, { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], get: { ...op(f, 'read', 'One record, if the caller may see it'), operationId: `get-${f.id}-one` } }],
    ]),
  );
  return yamlDoc(
    `# The API contract, written from the datum. Every feature is defined; x-zthr-enabled says which are switched on.\n# A feature switched off answers 403 to every caller, and no token can hold its scopes.\n`,
    {
      openapi: '3.2.0',
      info: { title: `${p.model.title} API`, version: `revision-${revision}`, description: p.model.end ?? 'The end in mind is not stated yet.' },
      servers: [{ url: 'https://example.invalid/api', description: 'Set where the app runs. No address or credential is held in the package.' }],
      tags: fs.map((f) => ({ name: f.id, description: f.line.gives })),
      paths,
      components: {
        securitySchemes: {
          oauth2: {
            type: 'oauth2',
            description: 'OAuth 2.0. People sign in with the authorization code flow; systems use client credentials. Least access: a client is granted only the scopes it is given, nothing by default.',
            flows: { authorizationCode: { authorizationUrl: 'https://example.invalid/oauth/authorize', tokenUrl: 'https://example.invalid/oauth/token', scopes }, clientCredentials: { tokenUrl: 'https://example.invalid/oauth/token', scopes } },
          },
        },
      },
      'x-zthr-roles': roles(p),
    },
  );
}

function access(p: Prepared, m: Manifest, s: Settled): string {
  const fs = features(m);
  const who = roles(p);
  return `# Access to the API

Every feature has a contract. ${anyApi(s) ? 'The spec sheet switches some of them on; the rest stay closed.' : 'None is switched on yet: every contract is closed.'} Whatever is switched on is held to the same rules as the screens.

\`\`\`mermaid
flowchart LR
  call[Request] --> token{Valid token?}
  token -- no --> r401[401]
  token -- yes --> on{Feature switched on?}
  on -- no --> r403a[403]
  on -- yes --> scope{Token holds the scope?}
  scope -- no --> r403b[403]
  scope -- yes --> rbac{Role may do it?}
  rbac -- no --> r403c[403]
  rbac -- yes --> rls[Row-level security: only rows its person may see]
  rls --> audit[Recorded in the audit chain]
  audit --> ok[200]
\`\`\`

- **Deny by default.** A new client holds no scopes. Each scope is granted by name, to one client, and can be revoked.
- **One path for every caller.** The API, the screens, the events feed and agent tools go through the same role check and the same row-level rules. Nothing reachable by the API is hidden from the screens' tests, or the other way round.
- **Least access.** Read and change are separate scopes for every feature. Sensitive fields, as the data dictionary marks them, are returned only with the scope that names them.
- **Limits and records.** Every caller is rate limited, and every call is written to the tamper-evident audit chain with the client, the person it acted for and the rows it touched.
- **Keys.** Tokens are short lived; client secrets are named in configuration and set where the app runs, never in the package.

| Feature | Switched on | Scopes | Who may use it | Proved by |
| --- | --- | --- | --- | --- |
${fs.map((f) => `| ${f.line.gives.replace(/\|/g, '\\|')} | ${apiOn(s, f.id) ? 'yes' : 'no, closed'} | \`${f.id}:read\`, \`${f.id}:write\` | ${who.join(', ') || 'the people on the schematic'} | ${f.line.journeys.length} journey${f.line.journeys.length === 1 ? '' : 's'} |`).join('\n') || '| No features yet | | | | |'}
`;
}

function asyncapi(p: Prepared, m: Manifest, s: Settled, revision: number): string {
  const fs = features(m);
  const channels = Object.fromEntries(fs.map((f) => [f.id, { address: `zthr.${f.id}.changed`, description: `Something changed: ${f.line.gives}`, 'x-zthr-enabled': apiOn(s, f.id) && (s.api.events || s.connect.feed), messages: { changed: { $ref: '#/components/messages/changed' } } }]));
  return yamlDoc(
    `# The events contract. Each event is a CloudEvents 1.0 envelope, delivered as a signed webhook.\n# It carries ids and what changed, never more than the subscriber's scopes allow.\n`,
    {
      asyncapi: '3.1.0',
      info: { title: `${p.model.title} events`, version: `revision-${revision}` },
      channels,
      operations: Object.fromEntries(fs.map((f) => [`send-${f.id}`, { action: 'send', channel: { $ref: `#/channels/${f.id}` } }])),
      components: {
        messages: {
          changed: {
            contentType: 'application/cloudevents+json',
            payload: { type: 'object', required: ['specversion', 'id', 'source', 'type', 'time'], properties: { specversion: { const: '1.0' }, id: { type: 'string' }, source: { type: 'string' }, type: { type: 'string' }, time: { type: 'string', format: 'date-time' }, subject: { type: 'string' }, data: { type: 'object' } } },
          },
        },
      },
    },
  );
}

function mcp(p: Prepared, m: Manifest, s: Settled): string {
  const tools = features(m)
    .filter((f) => apiOn(s, f.id))
    .flatMap((f) => [
      { name: `list_${f.id.replace(/-/g, '_')}`, description: `List what the caller may see: ${f.line.gives}`, scope: `${f.id}:read`, operation: `get-${f.id}` },
      { name: `do_${f.id.replace(/-/g, '_')}`, description: `Do it, for the person the agent acts for: ${f.line.gives}`, scope: `${f.id}:write`, operation: `set-${f.id}` },
    ]);
  return `${JSON.stringify({ schema: 'zthr-agent-tools/1', protocol: 'Model Context Protocol, 2026-07-28', server: `${p.model.title} tools`, note: 'Each tool calls the API operation it names, with the scope it names. An agent acts for a person, and sees only what that person may see.', tools }, null, 1)}\n`;
}

// ---------------------------------------------------------------- training

function lesson(p: Prepared, f: { id: string; line: Line }): string {
  const by = new Map(p.statements.map((s) => [s.balloon, s]));
  const held = f.line.balloons.map((b) => by.get(b)).filter((s) => s && s.slot === 'measures');
  const people = p.statements.filter((s) => s.slot === 'people').map((s) => s.text);
  return `---
type: training-module
feature: ${f.id}
balloons: [${f.line.balloons.join(', ')}]
journeys: [${f.line.journeys.join(', ')}]
---

# ${f.line.gives}

**Why it matters.** ${p.model.end ?? 'The end in mind is not stated yet.'}

**Who uses it.** ${people.join('; ') || 'The people on the schematic.'}

## What you will be able to do

- ${f.line.gives}

## Try it

Each step is a journey the factory walks before release, so the lesson and the software cannot disagree.

${f.line.journeys.map((j, i) => `${i + 1}. Walk the journey \`${j}\`.`).join('\n') || '1. The journeys for this feature are added in the inspection plan.'}

## Check your understanding

${held.map((s) => `- How would you know this holds: ${s!.text}?`).join('\n') || `- What changes for the person once this is done?`}
`;
}

function cmi5(p: Prepared, m: Manifest, s: Settled): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const on = features(m).filter((f) => trainingOn(s, f.id));
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- A cmi5 course structure. Each assignable unit is one feature's module, reporting through xAPI. -->
<courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd">
  <course id="urn:zthr:course:${featureId(p.model.title)}">
    <title><langstring lang="en-US">${esc(p.model.title)}</langstring></title>
    <description><langstring lang="en-US">${esc(p.model.end ?? '')}</langstring></description>
  </course>
${on.map((f) => `  <au id="urn:zthr:au:${f.id}" moveOn="Completed">
    <title><langstring lang="en-US">${esc(f.line.gives)}</langstring></title>
    <description><langstring lang="en-US">Walk the journeys that prove it.</langstring></description>
    <url>training/${f.id}.html</url>
  </au>`).join('\n')}
</courseStructure>
`;
}

// ---------------------------------------------------------------- documentation, for two audiences

function userGuide(p: Prepared, m: Manifest): Record<string, string> {
  const fs = features(m);
  const people = p.statements.filter((s) => s.slot === 'people');
  const out: Record<string, string> = {};
  out['docs/users/README.md'] = `# ${p.model.title}: the guide

For the people who use it. Written from the same datum as the code, so it describes what the software does, not what someone remembers it doing.

**What it is for.** ${p.model.end ?? 'The end in mind is not stated yet.'}

## Who it is for

${people.map((s) => `- ${s.text}`).join('\n') || '- The people on the schematic.'}

## What you can do

${fs.map((f) => `- [${f.line.gives}](${f.id}.md)`).join('\n') || '- Nothing is defined yet.'}

## Getting help

Every screen has help for what is on it. If something will not let you go on, it says why, and what would change its answer.
`;
  for (const f of fs) {
    out[`docs/users/${f.id}.md`] = `# ${f.line.gives}

**Why you would.** ${p.model.end ?? ''}

## How

${f.line.journeys.map((j, i) => `${i + 1}. Follow \`${j}\`. The factory walks this exact journey before every release.`).join('\n') || '1. The steps come from the journeys added in the inspection plan.'}

## If it says no

It tells you why, in plain words, and what would change its answer.
`;
  }
  return out;
}

function technicalRef(p: Prepared, m: Manifest, s: Settled): string {
  const groups = [...new Set(m.lines.map((l) => l.group))];
  const fs = features(m);
  return `# ${p.model.title}: technical reference

For the people who run, support and change it. Every section is generated from the datum, the manifest and the package; nothing here is written by hand, so nothing here drifts.

## How it is built

\`\`\`mermaid
flowchart TB
${groups.map((g, i) => `  g${i}["${g} (${m.lines.filter((l) => l.group === g).length})"]`).join('\n')}
${groups.slice(1).map((_, i) => `  g${i} --> g${i + 1}`).join('\n')}
\`\`\`

${m.lines.length} lines on the build manifest: ${m.maintained.fleet} maintained by the fleet, ${m.maintained.local} by this team. See \`build-manifest.md\` for each line, its source and why it is there.

## Features and their interfaces

| Feature | API | Events | Training | Journeys |
| --- | --- | --- | --- | --- |
${fs.map((f) => `| ${f.line.gives.replace(/\|/g, '\\|')} | ${apiOn(s, f.id) ? 'on' : 'closed'} | ${apiOn(s, f.id) && (s.api.events || s.connect.feed) ? 'on' : 'closed'} | ${trainingOn(s, f.id) ? 'published' : 'held back'} | ${f.line.journeys.length} |`).join('\n') || '| None yet | | | | |'}

## Interfaces

- \`api/openapi.yaml\`: the API contract (OpenAPI 3.2). \`api/access.md\`: who may call what, and how.
- \`api/asyncapi.yaml\`: the events contract (AsyncAPI 3.1, CloudEvents 1.0 envelopes).
${s.api.agents ? '- `api/agent-tools.json`: tools for agents, over the Model Context Protocol.\n' : ''}- \`connections.json\`: where the factory reports progress and publishes these docs.

## Running it

- Health and readiness, logs with sensitive values redacted, and errors grouped by build and feature come with the team minimum.
- Settings and secrets are named in configuration and set where the app runs; it refuses to start when one is unsafe.
- Every read of someone else's record, and every API call, is in the audit chain.

## Changing it

Change the intent, not the code. A new revision of the schematic gives a new manifest, new contracts, new docs and new training in one pass, and the change notice says what moved.
`;
}

// ---------------------------------------------------------------- connections to the tools a team already uses

function connections(p: Prepared, s: Settled): string {
  return `${JSON.stringify(
    {
      schema: 'zthr-connections/2',
      note: 'Named connections only. Credentials are never in the package; each is set where the factory runs, with the least access the connection needs. What each would send is in connections/outbox, sent by nobody until it is set up.',
      chosen: chosen(s).map((x) => ({ id: x.id, name: x.name, kind: x.kind, api: x.api, access: x.access, config: x.config, secrets: x.secrets, outbox: `connections/outbox/${x.id}.json` })),
      factoryEvents: { format: 'CloudEvents 1.0', source: `urn:zthr:factory:${featureId(p.model.title)}`, types: ['intent', 'design', 'build', 'qa', 'release'].map((x) => `ai.zthr.factory.${x}`) },
    },
    null,
    1,
  )}\n`;
}

// ---------------------------------------------------------------- the admin suite

const ENVS = ['development', 'test', 'uat', 'production'] as const;

function environments(s: Settled): string {
  const where = (rule: (e: (typeof ENVS)[number]) => boolean) => Object.fromEntries(ENVS.map((e) => [e, rule(e)]));
  return `${JSON.stringify(
    {
      schema: 'zthr-admin-environments/1',
      note: 'Which admin tools are built into which environment. A tool marked false is not switched off in production: it is left out of that build, so there is nothing to switch back on.',
      tools: {
        'Feature explorer': where(() => true),
        'Record inspector': where(() => true),
        'Permission explainer': where(() => true),
        'Tamper-evident audit chain': where(() => true),
        'Request tracer': where(() => true),
        'Act as a user': where(() => true),
        'Query console': where((e) => (s.admin.query === 'everywhere' ? true : s.admin.query === 'non-production' ? e !== 'production' : false)),
        'Test data generator': where((e) => e !== 'production'),
        'UAT overrides': where((e) => e === 'uat' || e === 'test' || e === 'development'),
        'What-if editing': where(() => true),
        'Confidence walkthrough': where((e) => e !== 'production'),
      },
      guards: {
        'Query console': ['runs as the person signed in: same roles, row-level rules and field masking as the screens', 'read only', 'every query, its text and the rows it returned are in the audit chain', 'exports carry sensitivity classes and need the export scope', 'scheduled queries run as a named service client with only the scopes granted to it'],
        'Test data generator': ['every record is marked synthetic', 'production refuses a synthetic record'],
        'UAT overrides': ['every override is recorded with who made it and why', 'one step resets every override', 'the production build does not contain the code'],
        'Act as a user': ['the person acted as is told', 'every action is recorded under both people'],
      },
    },
    null,
    1,
  )}\n`;
}

function queryGuide(p: Prepared, m: Manifest, s: Settled): string {
  const fs = features(m);
  return `# The query console

Query the application in SQL, as if it were one database. Every feature answers as a set of views, and the system views answer for the whole app. ${s.admin.query === 'off' ? 'It is left out of every build on this spec sheet.' : s.admin.query === 'non-production' ? 'It is built into development, test and UAT, and left out of production, so it cannot be used to take real data out.' : 'It is built into every environment, production included.'}

\`\`\`mermaid
flowchart LR
  q[Your SQL] --> parse[Parsed, read only]
  parse --> who[Runs as you: your roles]
  who --> rls[Row-level rules: only rows you may see]
  rls --> mask[Sensitive fields masked by class]
  mask --> audit[Query and rows in the audit chain]
  audit --> out[Results: view, save, export, schedule]
\`\`\`

## Views each feature answers

| View | What it holds |
| --- | --- |
${fs.map((f) => `| \`${f.id.replace(/-/g, '_')}\` | The records behind: ${f.line.gives.replace(/\|/g, '\\|')} |\n| \`${f.id.replace(/-/g, '_')}_history\` | Every change to them, by whom and when |`).join('\n') || '| None yet | |'}

## System views

| View | What it holds |
| --- | --- |
| \`features\` | Every feature, its assemblies, parts and whether its journeys pass |
| \`parts\` | Every line on the build manifest: source, maintainer, tests, mutation floor |
| \`permissions\` | Who may do what, on which rows, and why |
| \`audit\` | Every change, and every read of sensitive data |
| \`journeys\` | Every journey, the balloons it proves and its last walk |
| \`evidence\` | What each release proved, claim by claim |

## Saved, exported and scheduled

A saved query has a name, an owner and the scopes it needs. Exports carry each field's sensitivity class. A scheduled query runs as a named service client holding only the scopes granted to it, and each run is recorded.

\`\`\`sql
-- Which features have a journey that has not passed on this build?
select f.name, j.id, j.last_result
from features f join journeys j on j.feature = f.id
where j.last_result <> 'passed';
\`\`\`
`;
}

/** Every interface file the release carries. */
export function interfaceFiles(p: Prepared, m: Manifest, revision: number): Record<string, string> {
  const s = settle(p.options);
  const fs = features(m);
  const out: Record<string, string> = {
    'spec-sheet.json': `${JSON.stringify({ schema: 'zthr-spec-sheet/1', ...s }, null, 1)}\n`,
    'api/openapi.yaml': openapi(p, m, s, revision),
    'api/access.md': access(p, m, s),
    'api/asyncapi.yaml': asyncapi(p, m, s, revision),
    'connections.json': connections(p, s),
    'docs/technical/README.md': technicalRef(p, m, s),
    ...userGuide(p, m),
    'training/cmi5.xml': cmi5(p, m, s),
    'admin/environments.json': environments(s),
    'admin/query.md': queryGuide(p, m, s),
    ...Object.fromEntries(fs.map((f) => [`training/${f.id}.md`, lesson(p, f)])),
  };
  if (s.api.agents) out['api/agent-tools.json'] = mcp(p, m, s);
  // What each chosen connector would send, written down and sent by nobody.
  const plan: Plan = {
    title: p.model.title,
    revision,
    end: p.model.end,
    features: fs.map((f) => ({ id: f.id, gives: f.line.gives, balloons: f.line.balloons, journeys: f.line.journeys })),
    docs: Object.fromEntries(Object.entries(out).filter(([k]) => k.startsWith('docs/'))),
  };
  out['connections/catalogue.json'] = catalogue();
  for (const x of chosen(s)) out[`connections/outbox/${x.id}.json`] = outbox(x, plan);
  return out;
}
