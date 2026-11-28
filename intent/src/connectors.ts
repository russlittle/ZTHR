/**
 * Connector stubs: the tools teams already use, reached without an account with any of them.
 *
 * Each connector is a pure adapter. Given a release, it writes the exact requests it would send: method, address,
 * headers and body, in the tool's own documented API. Nothing is sent. Every value that needs a setup with the tool
 * (a site, a project, a token) is a named placeholder: `{{config.NAME}}` for where, `{{secret.NAME}}` for a credential.
 * A person fills the configuration where the factory runs; the factory fills the secrets from its secret store at the
 * moment of sending. So the package can be read, reviewed and diffed, and never holds a credential.
 */
import type { Settled } from './interfaces.ts';

export type Kind = 'tickets' | 'docs' | 'chat' | 'feed' | 'identity';

export interface Request {
  /** What this request does, in plain words. */
  readonly does: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'GIT';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** The station whose finish sends it. */
  readonly on: Station;
}

export type Station = 'intent' | 'design' | 'build' | 'qa' | 'release';
const STATIONS: readonly { station: Station; when: string; status: string }[] = [
  { station: 'intent', when: 'the schematic is signed', status: 'To do' },
  { station: 'design', when: 'the build manifest is released', status: 'Selected' },
  { station: 'build', when: 'the factory starts the build loop', status: 'In progress' },
  { station: 'qa', when: 'every gate and journey runs', status: 'In review' },
  { station: 'release', when: 'the release is proved and shipped', status: 'Done' },
];

export interface Feature {
  readonly id: string;
  readonly gives: string;
  readonly balloons: readonly number[];
  readonly journeys: readonly string[];
}

export interface Plan {
  readonly title: string;
  readonly revision: number;
  readonly end: string | null;
  readonly features: readonly Feature[];
  /** The documentation the release carries, by path, to publish. */
  readonly docs: Readonly<Record<string, string>>;
}

export interface Connector {
  readonly id: string;
  readonly name: string;
  readonly kind: Kind;
  /** The API it speaks, and the version, so a reader can check every request against the vendor's reference. */
  readonly api: string;
  readonly reference: string;
  /** What a person sets up once, by name: where (config) and what proves who is calling (secrets). */
  readonly config: readonly string[];
  readonly secrets: readonly string[];
  /** How it signs in, at least access first. */
  readonly access: string;
  readonly plan: (p: Plan) => Request[];
}

const c = (n: string) => `{{config.${n}}}`;
const s = (n: string) => `{{secret.${n}}}`;
const json = { 'Content-Type': 'application/json' };
const summary = (p: Plan, f: Feature) => `${f.gives}\n\nPart of ${p.title}, revision ${p.revision}.\nBalloons: ${f.balloons.join(', ') || 'none'}.\nProved by: ${f.journeys.join(', ') || 'no journey yet'}.`;
const statusMoves = (make: (f: Feature, st: (typeof STATIONS)[number]) => Request) => (p: Plan) => p.features.flatMap((f) => STATIONS.slice(1).map((st) => make(f, st)));
const pages = (p: Plan) => Object.entries(p.docs).sort(([a], [b]) => a.localeCompare(b));
const pageTitle = (p: Plan, path: string) => `${p.title}: ${path.replace(/^docs\//, '').replace(/\.md$/, '').replace(/\/README$/, '').replace(/\//g, ' / ')}`;
const message = (p: Plan, st: (typeof STATIONS)[number]) => `${p.title}, revision ${p.revision}: ${st.when}.`;

// ---------------------------------------------------------------- tickets: one per feature, moved as each station finishes

const jira: Connector = {
  id: 'jira', name: 'Jira', kind: 'tickets', api: 'Jira Cloud REST API v3', reference: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/',
  config: ['JIRA_SITE', 'JIRA_PROJECT_KEY', 'JIRA_TRANSITION_IDS'], secrets: ['JIRA_TOKEN'],
  access: 'OAuth 2.0 (3LO) with write:jira-work only, or an API token for a service account limited to the one project',
  plan: (p) => [
    ...p.features.map((f): Request => ({ does: `Open a ticket for: ${f.gives}`, on: 'intent', method: 'POST', url: `https://${c('JIRA_SITE')}/rest/api/3/issue`, headers: { ...json, Authorization: `Bearer ${s('JIRA_TOKEN')}` },
      body: { fields: { project: { key: c('JIRA_PROJECT_KEY') }, issuetype: { name: 'Task' }, summary: f.gives, labels: ['zthr', `zthr-${f.id}`], description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: summary(p, f) }] }] } } } })),
    ...statusMoves((f, st) => ({ does: `Move "${f.gives}" to ${st.status} when ${st.when}`, on: st.station, method: 'POST', url: `https://${c('JIRA_SITE')}/rest/api/3/issue/{{ticket.${f.id}}}/transitions`, headers: { ...json, Authorization: `Bearer ${s('JIRA_TOKEN')}` }, body: { transition: { id: `{{config.JIRA_TRANSITION_IDS.${st.status}}}` } } }))(p),
  ],
};

const asana: Connector = {
  id: 'asana', name: 'Asana', kind: 'tickets', api: 'Asana REST API 1.0', reference: 'https://developers.asana.com/reference/rest-api-reference',
  config: ['ASANA_PROJECT_GID', 'ASANA_SECTION_GIDS'], secrets: ['ASANA_TOKEN'],
  access: 'OAuth with the tasks:write scope, or a service account token limited to the one project',
  plan: (p) => [
    ...p.features.map((f): Request => ({ does: `Open a task for: ${f.gives}`, on: 'intent', method: 'POST', url: 'https://app.asana.com/api/1.0/tasks', headers: { ...json, Authorization: `Bearer ${s('ASANA_TOKEN')}` }, body: { data: { name: f.gives, notes: summary(p, f), projects: [c('ASANA_PROJECT_GID')] } } })),
    ...statusMoves((f, st) => ({ does: `Move "${f.gives}" to the ${st.status} section when ${st.when}`, on: st.station, method: 'POST', url: `https://app.asana.com/api/1.0/sections/{{config.ASANA_SECTION_GIDS.${st.status}}}/addTask`, headers: { ...json, Authorization: `Bearer ${s('ASANA_TOKEN')}` }, body: { data: { task: `{{ticket.${f.id}}}` } } }))(p),
  ],
};

const linear: Connector = {
  id: 'linear', name: 'Linear', kind: 'tickets', api: 'Linear GraphQL API', reference: 'https://linear.app/developers/graphql',
  config: ['LINEAR_TEAM_ID', 'LINEAR_STATE_IDS'], secrets: ['LINEAR_TOKEN'],
  access: 'OAuth with the issues:create and write scopes, or a personal API key for a service member of one team',
  plan: (p) => [
    ...p.features.map((f): Request => ({ does: `Open an issue for: ${f.gives}`, on: 'intent', method: 'POST', url: 'https://api.linear.app/graphql', headers: { ...json, Authorization: s('LINEAR_TOKEN') },
      body: { query: 'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }', variables: { input: { teamId: c('LINEAR_TEAM_ID'), title: f.gives, description: summary(p, f) } } } })),
    ...statusMoves((f, st) => ({ does: `Move "${f.gives}" to ${st.status} when ${st.when}`, on: st.station, method: 'POST', url: 'https://api.linear.app/graphql', headers: { ...json, Authorization: s('LINEAR_TOKEN') },
      body: { query: 'mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', variables: { id: `{{ticket.${f.id}}}`, input: { stateId: `{{config.LINEAR_STATE_IDS.${st.status}}}` } } } }))(p),
  ],
};

const github: Connector = {
  id: 'github-issues', name: 'GitHub Issues', kind: 'tickets', api: 'GitHub REST API, version 2022-11-28', reference: 'https://docs.github.com/en/rest/issues/issues',
  config: ['GITHUB_OWNER', 'GITHUB_REPO'], secrets: ['GITHUB_TOKEN'],
  access: 'A GitHub App installed on the one repository with Issues: write, or a fine-grained token limited to it',
  plan: (p) => {
    const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${s('GITHUB_TOKEN')}`, ...json };
    const base = `https://api.github.com/repos/${c('GITHUB_OWNER')}/${c('GITHUB_REPO')}/issues`;
    return [
      ...p.features.map((f): Request => ({ does: `Open an issue for: ${f.gives}`, on: 'intent', method: 'POST', url: base, headers: h, body: { title: f.gives, body: summary(p, f), labels: ['zthr', 'zthr: to do'] } })),
      ...statusMoves((f, st) => ({ does: `Label "${f.gives}" ${st.status} when ${st.when}${st.station === 'release' ? ', and close it' : ''}`, on: st.station, method: 'PATCH', url: `${base}/{{ticket.${f.id}}}`, headers: h, body: { labels: ['zthr', `zthr: ${st.status.toLowerCase()}`], ...(st.station === 'release' ? { state: 'closed', state_reason: 'completed' } : {}) } }))(p),
    ];
  },
};

const azure: Connector = {
  id: 'azure-boards', name: 'Azure Boards', kind: 'tickets', api: 'Azure DevOps REST API 7.1, work item tracking', reference: 'https://learn.microsoft.com/rest/api/azure/devops/wit/work-items',
  config: ['ADO_ORGANIZATION', 'ADO_PROJECT', 'ADO_STATES'], secrets: ['ADO_TOKEN'],
  access: 'Microsoft Entra ID with the vso.work_write scope; a personal access token only for a first trial',
  plan: (p) => {
    const h = { 'Content-Type': 'application/json-patch+json', Authorization: `Bearer ${s('ADO_TOKEN')}` };
    return [
      ...p.features.map((f): Request => ({ does: `Open a work item for: ${f.gives}`, on: 'intent', method: 'POST', url: `https://dev.azure.com/${c('ADO_ORGANIZATION')}/${c('ADO_PROJECT')}/_apis/wit/workitems/$Task?api-version=7.1`, headers: h,
        body: [{ op: 'add', path: '/fields/System.Title', value: f.gives }, { op: 'add', path: '/fields/System.Description', value: summary(p, f) }, { op: 'add', path: '/fields/System.Tags', value: `zthr; zthr-${f.id}` }] })),
      ...statusMoves((f, st) => ({ does: `Move "${f.gives}" to ${st.status} when ${st.when}`, on: st.station, method: 'PATCH', url: `https://dev.azure.com/${c('ADO_ORGANIZATION')}/_apis/wit/workitems/{{ticket.${f.id}}}?api-version=7.1`, headers: h, body: [{ op: 'add', path: '/fields/System.State', value: `{{config.ADO_STATES.${st.status}}}` }] }))(p),
    ];
  },
};

// ---------------------------------------------------------------- docs: the guide and the reference, replaced whole on each release

const confluence: Connector = {
  id: 'confluence', name: 'Confluence', kind: 'docs', api: 'Confluence Cloud REST API v2', reference: 'https://developer.atlassian.com/cloud/confluence/rest/v2/',
  config: ['CONFLUENCE_SITE', 'CONFLUENCE_SPACE_ID', 'CONFLUENCE_PARENT_ID'], secrets: ['CONFLUENCE_TOKEN'],
  access: 'OAuth 2.0 (3LO) with write:page:confluence for the one space',
  plan: (p) => pages(p).map(([path, md]) => ({ does: `Publish "${pageTitle(p, path)}"`, on: 'release' as const, method: 'POST' as const, url: `https://${c('CONFLUENCE_SITE')}/wiki/api/v2/pages`, headers: { ...json, Authorization: `Bearer ${s('CONFLUENCE_TOKEN')}` },
    body: { spaceId: c('CONFLUENCE_SPACE_ID'), parentId: c('CONFLUENCE_PARENT_ID'), status: 'current', title: pageTitle(p, path), body: { representation: 'storage', value: `<pre>${md.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>` } } })),
};

const notion: Connector = {
  id: 'notion', name: 'Notion', kind: 'docs', api: 'Notion API, version 2026-03-11', reference: 'https://developers.notion.com/reference',
  config: ['NOTION_PARENT_PAGE_ID'], secrets: ['NOTION_TOKEN'],
  access: 'An internal connection shared with the one parent page, with insert content only',
  plan: (p) => pages(p).map(([path, md]) => ({ does: `Publish "${pageTitle(p, path)}"`, on: 'release' as const, method: 'POST' as const, url: 'https://api.notion.com/v1/pages', headers: { ...json, Authorization: `Bearer ${s('NOTION_TOKEN')}`, 'Notion-Version': '2026-03-11' },
    body: { parent: { page_id: c('NOTION_PARENT_PAGE_ID') }, properties: { title: { title: [{ text: { content: pageTitle(p, path) } }] } }, children: md.split(/\n{2,}/).filter((b) => b.trim()).slice(0, 100).map((b) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: b.slice(0, 2000) } }] } })) } })),
};

const sharepoint: Connector = {
  id: 'sharepoint', name: 'SharePoint', kind: 'docs', api: 'Microsoft Graph v1.0', reference: 'https://learn.microsoft.com/graph/api/driveitem-put-content',
  config: ['SHAREPOINT_SITE_ID', 'SHAREPOINT_FOLDER'], secrets: ['GRAPH_TOKEN'],
  access: 'Microsoft Entra ID application with Sites.Selected, granted on the one site',
  plan: (p) => pages(p).map(([path, md]) => ({ does: `Upload ${path}`, on: 'release' as const, method: 'PUT' as const, url: `https://graph.microsoft.com/v1.0/sites/${c('SHAREPOINT_SITE_ID')}/drive/root:/${c('SHAREPOINT_FOLDER')}/${path}:/content`, headers: { 'Content-Type': 'text/markdown', Authorization: `Bearer ${s('GRAPH_TOKEN')}` }, body: md })),
};

const drive: Connector = {
  id: 'google-drive', name: 'Google Drive', kind: 'docs', api: 'Google Drive API v3', reference: 'https://developers.google.com/workspace/drive/api/guides/manage-uploads',
  config: ['DRIVE_FOLDER_ID'], secrets: ['GOOGLE_TOKEN'],
  access: 'A service account or OAuth with the drive.file scope, so it touches only files it created',
  plan: (p) => pages(p).map(([path, md]) => ({ does: `Publish "${pageTitle(p, path)}" as a Google Doc`, on: 'release' as const, method: 'POST' as const, url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', headers: { 'Content-Type': 'multipart/related', Authorization: `Bearer ${s('GOOGLE_TOKEN')}` },
    body: { metadata: { name: pageTitle(p, path), mimeType: 'application/vnd.google-apps.document', parents: [c('DRIVE_FOLDER_ID')] }, media: { mimeType: 'text/markdown', content: md } } })),
};

const gitWiki: Connector = {
  id: 'github-wiki', name: 'GitHub wiki', kind: 'docs', api: 'Git, to the repository wiki', reference: 'https://docs.github.com/en/communities/documenting-your-project-with-wikis',
  config: ['GITHUB_OWNER', 'GITHUB_REPO'], secrets: ['GITHUB_TOKEN'],
  access: 'A GitHub App with Contents: write on the one repository',
  plan: (p) => [{ does: `Replace the wiki with the release's ${pages(p).length} pages, in one commit`, on: 'release', method: 'GIT', url: `https://github.com/${c('GITHUB_OWNER')}/${c('GITHUB_REPO')}.wiki.git`, headers: { Authorization: `Bearer ${s('GITHUB_TOKEN')}` }, body: { commit: `${p.title}, revision ${p.revision}`, files: pages(p).map(([path]) => path.replace(/^docs\//, '').replace(/\//g, '-')) } }],
};

// ---------------------------------------------------------------- chat: a note when each station finishes

const slack: Connector = {
  id: 'slack', name: 'Slack', kind: 'chat', api: 'Slack Web API, chat.postMessage', reference: 'https://api.slack.com/methods/chat.postMessage',
  config: ['SLACK_CHANNEL'], secrets: ['SLACK_BOT_TOKEN'],
  access: 'A Slack app with chat:write only, invited to the one channel',
  plan: (p) => STATIONS.map((st) => ({ does: `Post when ${st.when}`, on: st.station, method: 'POST' as const, url: 'https://slack.com/api/chat.postMessage', headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${s('SLACK_BOT_TOKEN')}` }, body: { channel: c('SLACK_CHANNEL'), text: message(p, st) } })),
};

const teams: Connector = {
  id: 'teams', name: 'Microsoft Teams', kind: 'chat', api: 'Teams Workflows webhook, Adaptive Card', reference: 'https://support.microsoft.com/office/create-incoming-webhooks-with-workflows-for-microsoft-teams-8ae491c7-0394-4861-ba59-055e33f75498',
  config: [], secrets: ['TEAMS_WORKFLOW_URL'],
  access: 'A Workflows webhook for the one channel; its address is the credential, so it is kept as a secret',
  plan: (p) => STATIONS.map((st) => ({ does: `Post when ${st.when}`, on: st.station, method: 'POST' as const, url: s('TEAMS_WORKFLOW_URL'), headers: json,
    body: { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text: message(p, st), wrap: true }] } }] } })),
};

const gchat: Connector = {
  id: 'google-chat', name: 'Google Chat', kind: 'chat', api: 'Google Chat incoming webhook', reference: 'https://developers.google.com/workspace/chat/quickstart/webhooks',
  config: [], secrets: ['GOOGLE_CHAT_WEBHOOK_URL'],
  access: 'An incoming webhook for the one space; its address is the credential, so it is kept as a secret',
  plan: (p) => STATIONS.map((st) => ({ does: `Post when ${st.when}`, on: st.station, method: 'POST' as const, url: s('GOOGLE_CHAT_WEBHOOK_URL'), headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: { text: message(p, st) } })),
};

// ---------------------------------------------------------------- feeds: data for systems already in place

const event = (p: Plan, f: Feature) => ({ specversion: '1.0', id: `{{event.id}}`, source: `urn:zthr:app:${p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, type: `ai.zthr.${f.id}.changed`, time: '{{event.time}}', datacontenttype: 'application/json', data: { ids: '{{event.ids}}' } });

const webhooks: Connector = {
  id: 'webhooks', name: 'Signed webhooks', kind: 'feed', api: 'Standard Webhooks, carrying CloudEvents 1.0', reference: 'https://www.standardwebhooks.com/',
  config: ['WEBHOOK_URL'], secrets: ['WEBHOOK_SIGNING_SECRET'],
  access: 'Each subscriber holds a signing secret and named read scopes, like any API client',
  plan: (p) => p.features.map((f) => ({ does: `Send a change event for: ${f.gives}`, on: 'release' as const, method: 'POST' as const, url: c('WEBHOOK_URL'), headers: { 'Content-Type': 'application/cloudevents+json', 'webhook-id': '{{event.id}}', 'webhook-timestamp': '{{event.unix}}', 'webhook-signature': `v1,{{hmac_sha256_base64(${s('WEBHOOK_SIGNING_SECRET')}, id.timestamp.body)}}` }, body: event(p, f) })),
};

const bigquery: Connector = {
  id: 'bigquery', name: 'BigQuery', kind: 'feed', api: 'BigQuery API v2, tabledata.insertAll', reference: 'https://cloud.google.com/bigquery/docs/reference/rest/v2/tabledata/insertAll',
  config: ['BQ_PROJECT', 'BQ_DATASET', 'BQ_TABLE'], secrets: ['GOOGLE_TOKEN'],
  access: 'A service account with BigQuery Data Editor on the one dataset, nothing more',
  plan: (p) => [{ does: `Append the changed records of ${p.features.length} features`, on: 'release', method: 'POST', url: `https://bigquery.googleapis.com/bigquery/v2/projects/${c('BQ_PROJECT')}/datasets/${c('BQ_DATASET')}/tables/${c('BQ_TABLE')}/insertAll`, headers: { ...json, Authorization: `Bearer ${s('GOOGLE_TOKEN')}` }, body: { kind: 'bigquery#tableDataInsertAllRequest', rows: p.features.map((f) => ({ insertId: `{{event.id}}-${f.id}`, json: event(p, f) })) } }],
};

const snowflake: Connector = {
  id: 'snowflake', name: 'Snowflake', kind: 'feed', api: 'Snowflake SQL API v2', reference: 'https://docs.snowflake.com/developer-guide/sql-api/reference',
  config: ['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_WAREHOUSE', 'SNOWFLAKE_DATABASE', 'SNOWFLAKE_SCHEMA'], secrets: ['SNOWFLAKE_KEYPAIR_JWT'],
  access: 'Key-pair authentication for a service user whose role may insert into the one table',
  plan: (p) => [{ does: `Insert the changed records of ${p.features.length} features`, on: 'release', method: 'POST', url: `https://${c('SNOWFLAKE_ACCOUNT')}.snowflakecomputing.com/api/v2/statements`, headers: { ...json, Authorization: `Bearer ${s('SNOWFLAKE_KEYPAIR_JWT')}`, 'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT' }, body: { statement: 'insert into zthr_events (event) select parse_json(column1) from values (?)', bindings: { '1': { type: 'TEXT', value: '{{events.json}}' } }, warehouse: c('SNOWFLAKE_WAREHOUSE'), database: c('SNOWFLAKE_DATABASE'), schema: c('SNOWFLAKE_SCHEMA') } }],
};

const gcs: Connector = {
  id: 'cloud-storage', name: 'Cloud Storage export', kind: 'feed', api: 'Cloud Storage JSON API v1', reference: 'https://cloud.google.com/storage/docs/uploading-objects',
  config: ['GCS_BUCKET'], secrets: ['GOOGLE_TOKEN'],
  access: 'A service account with object create on the one bucket, nothing more',
  plan: (p) => [{ does: 'Drop the scheduled export, one file per run', on: 'release', method: 'POST', url: `https://storage.googleapis.com/upload/storage/v1/b/${c('GCS_BUCKET')}/o?uploadType=media&name=zthr/{{run.date}}/export.jsonl`, headers: { 'Content-Type': 'application/jsonl', Authorization: `Bearer ${s('GOOGLE_TOKEN')}` }, body: '{{export.jsonl}}' }],
};

// ---------------------------------------------------------------- identity: how people sign in to the app the factory builds

const oidc = (id: string, name: string, issuer: string, reference: string, where: readonly string[] = []): Connector => {
  const key = id.toUpperCase().replace(/-/g, '_');
  return {
    id, name, kind: 'identity', api: 'OpenID Connect, authorization code flow with PKCE', reference,
    config: [...where, `${key}_CLIENT_ID`], secrets: [`${key}_CLIENT_SECRET`],
    access: 'Only the openid, email and profile scopes; roles come from the app, not the identity provider',
    plan: () => [{ does: `Read ${name}'s sign-in settings`, on: 'build', method: 'GET', url: `${issuer}/.well-known/openid-configuration`, headers: {} }],
  };
};
const google = oidc('google', 'Google', 'https://accounts.google.com', 'https://developers.google.com/identity/openid-connect/openid-connect');
const entra = oidc('entra-id', 'Microsoft Entra ID', `https://login.microsoftonline.com/${c('ENTRA_TENANT_ID')}/v2.0`, 'https://learn.microsoft.com/entra/identity-platform/v2-protocols-oidc', ['ENTRA_TENANT_ID']);
const okta = oidc('okta', 'Okta', `https://${c('OKTA_DOMAIN')}`, 'https://developer.okta.com/docs/reference/api/oidc/', ['OKTA_DOMAIN']);

export const CONNECTORS: readonly Connector[] = [jira, asana, linear, github, azure, confluence, notion, sharepoint, drive, gitWiki, slack, teams, gchat, webhooks, bigquery, snowflake, gcs, google, entra, okta];
export const byKind = (k: Kind): Connector[] => CONNECTORS.filter((x) => x.kind === k);
export const connector = (id: string): Connector | undefined => CONNECTORS.find((x) => x.id === id);

/** The connectors a spec sheet chooses: none, or one per kind. */
export function chosen(s: Settled): Connector[] {
  return [s.connect.tickets, s.connect.wiki, s.connect.chat, ...(s.connect.feed ? [s.connect.feedTo] : []), s.connect.identity].map((id) => (id === 'none' ? undefined : connector(id))).filter((x): x is Connector => !!x);
}

/** Every request a connector would send for this release, written down and sent by nobody. */
export function outbox(x: Connector, p: Plan): string {
  return `${JSON.stringify({ schema: 'zthr-outbox/1', connector: x.id, name: x.name, api: x.api, reference: x.reference, access: x.access, sent: false, note: 'Nothing here has been sent. {{config.*}} is set once where the factory runs; {{secret.*}} is filled from its secret store at the moment of sending; {{ticket.*}} and {{event.*}} come from earlier answers.', config: x.config, secrets: x.secrets, requests: x.plan(p) }, null, 1)}\n`;
}

/** The whole catalogue, for the package and for anyone adding a connector. */
export function catalogue(): string {
  return `${JSON.stringify({ schema: 'zthr-connectors/1', stations: STATIONS, connectors: CONNECTORS.map(({ plan: _plan, ...rest }) => rest) }, null, 1)}\n`;
}
