/**
 * Delivery and operations: how a signed release becomes running software, and how it is kept running.
 *
 * The pipeline is written once, neutrally: the stages, what each proves, and the gate that lets the next one start.
 * Each cloud is an adapter that writes those stages in its own tools. Google Cloud is the first: Cloud Build with
 * signed provenance, Artifact Registry with image scanning and a bill of materials, Binary Authorization so only images
 * the build signed can run, Cloud Run with tagged no-traffic deploys and canaries, Cloud SQL with point-in-time
 * recovery. Another cloud is another adapter over the same stages.
 *
 * Operations come from the schematic, not from a separate exercise: the title block's feedback budget becomes a latency
 * objective, availability an objective with an error budget, every outcome's target in use a journey objective, every
 * forbidden outcome an alert that pages, and the data pipeline's nightly watch a scheduled job. Every alert has a
 * runbook entry, and every incident becomes a defect, a test and a ratchet.
 *
 * Nothing here changes a cloud project. Anything that grants access or creates resources is written as commands for a
 * person to run in Cloud Shell, with the least access each identity needs.
 */
import { achievedText } from './gaps.ts';
import type { Prepared } from './pipeline.ts';
import { rangeOf } from './tolerance.ts';

export interface DeliveryStage {
  readonly id: string;
  readonly name: string;
  readonly proves: readonly string[];
  readonly gate: string;
}

export const STAGES: readonly DeliveryStage[] = [
  { id: 'build', name: 'Build', proves: ['dependencies install from the lock file', 'types check', 'no secret-shaped value in the source or its history'], gate: 'every check passes' },
  { id: 'test', name: 'Test', proves: ['every test passes', 'mutation scores hold their floors', 'every ratchet holds or tightens', 'every journey passes on the twins'], gate: 'every gate in the control plan passes' },
  { id: 'data', name: 'Rehearse the data', proves: ['the schema revision migrates a copy with nothing lost', 'every integrity rule holds', 'no drift from the signed schema'], gate: 'the data pipeline rehearsal passes' },
  { id: 'package', name: 'Package and sign', proves: ['the image is built by the build service, with signed provenance', 'a bill of materials is recorded', 'no critical or high vulnerability in the image'], gate: 'the image is signed and clean' },
  { id: 'deploy', name: 'Deploy without traffic', proves: ['only a signed image can run', 'the new revision starts and is healthy', 'journeys pass against it, before anyone is sent to it'], gate: 'smoke journeys pass on the candidate' },
  { id: 'canary', name: 'Canary', proves: ['a small share of people use it', 'service levels hold: no fast burn of any error budget'], gate: 'a named person approves in production; the error budget is not burning' },
  { id: 'release', name: 'Release', proves: ['everyone is moved to it', 'the previous revision stays ready to take traffic back in one step'], gate: 'service levels hold for the watch window' },
  { id: 'operate', name: 'Operate', proves: ['service levels watched continuously', 'integrity and drift checked nightly', 'every alert has a runbook; every incident becomes a defect, a test and a ratchet'], gate: 'an alert opens an incident' },
];

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'app';

export interface Objective {
  readonly id: string;
  readonly what: string;
  readonly goal: number;
  readonly from: string;
}

/** Service levels from the schematic: the feedback budget, availability, and every outcome's target in use. */
export function objectives(p: Prepared): { latencyMs: number; list: Objective[] } {
  const fb = /within\s+([\d.]+)\s*(second|ms|millisecond)/i.exec(p.title['feedback']?.value ?? '');
  const latencyMs = fb ? (/^s/i.test(fb[2]!) ? Number(fb[1]) * 1000 : Number(fb[1])) : 1000;
  const list: Objective[] = [
    { id: 'availability', what: 'Requests answered without a server error', goal: 0.995, from: 'the team minimum: available 99.5% of every 28 days' },
    { id: 'latency', what: `Requests answered within ${latencyMs} ms`, goal: 0.95, from: `the title block: feedback ${p.title['feedback']?.value ?? 'within 1 second'}` },
  ];
  for (const o of p.statements.filter((s) => s.slot === 'outcome')) {
    const t = p.statements.find((s) => s.slot === 'measures' && s.text === achievedText(o.text));
    const r = rangeOf(t?.tolerance);
    if (t && r.kind === 'rate') list.push({ id: `achieved-${slug(o.text)}`, what: `People who start it achieve it: ${o.text}`, goal: Math.min(0.999, r.min), from: `balloon ${t.balloon}: ${t.tolerance}` });
  }
  return { latencyMs, list };
}

// ---------------------------------------------------------------- Google Cloud

export function cloudbuild(app: string): string {
  const image = '${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/${_SERVICE}:$SHORT_SHA';
  return `# ${app}: build, test, rehearse the data, package, sign, deploy without traffic, canary.
# Generated from the signed release. One trigger per environment sets _ENV; production requires approval.
substitutions:
  _REGION: us-central1
  _REPO: apps
  _SERVICE: ${slug(app)}
  _ENV: development
  _CANARY: '10'
options:
  # Signed SLSA build provenance, verified by the build platform.
  requestedVerifyOption: VERIFIED
  logging: CLOUD_LOGGING_ONLY
steps:
  - id: build
    name: node:22
    entrypoint: bash
    args: ['-c', 'npm ci && npm run typecheck && npm run secrets']
  - id: test
    name: node:22
    entrypoint: bash
    args: ['-c', 'npm test && npm run mutation && npm run gates && npm run journeys']
  - id: rehearsal-db
    name: gcr.io/cloud-builders/docker
    args: ['run', '-d', '--name', 'rehearsal', '--network', 'cloudbuild', '-e', 'POSTGRES_PASSWORD=rehearsal', 'postgres:16']
  - id: data
    name: postgres:16
    entrypoint: bash
    env: ['DB=postgresql://postgres:rehearsal@rehearsal:5432/postgres']
    args:
      - -c
      - |
        set -euo pipefail
        until pg_isready -h rehearsal; do sleep 1; done
        T=release/information
        if [ -f release/previous/information/schema.sql ]; then
          psql "$$DB" -v ON_ERROR_STOP=1 -q -f release/previous/information/schema.sql
          psql "$$DB" -v ON_ERROR_STOP=1 -q -f release/previous/information/fixtures/seed.sql
          psql "$$DB" -tA -f $$T/preservation.sql > before.txt
          for m in $$T/migrations/*.sql; do psql "$$DB" -v ON_ERROR_STOP=1 -q -f "$$m"; done
          psql "$$DB" -tA -f $$T/preservation.sql > after.txt
          diff before.txt after.txt
        else
          psql "$$DB" -v ON_ERROR_STOP=1 -q -f $$T/schema.sql
          psql "$$DB" -v ON_ERROR_STOP=1 -q -f $$T/fixtures/seed.sql
        fi
        bad=$$(psql "$$DB" -v ON_ERROR_STOP=1 -tA -F ' ' -f $$T/integrity-summary.sql | awk '$$2 != 0')
        if [ -n "$$bad" ]; then echo "$$bad"; exit 1; fi
        drift=$$(psql "$$DB" -v ON_ERROR_STOP=1 -tA -f $$T/drift.sql)
        if [ -n "$$drift" ]; then echo "$$drift"; exit 1; fi
  - id: image
    name: gcr.io/cloud-builders/docker
    args: ['build', '-t', '${image}', '.']
  - id: push
    name: gcr.io/cloud-builders/docker
    args: ['push', '${image}']
  - id: scan
    name: gcr.io/google.com/cloudsdktool/cloud-sdk:slim
    entrypoint: bash
    args:
      - -c
      - |
        set -euo pipefail
        scan=$$(gcloud artifacts docker images scan ${image} --remote --format='value(response.scan)')
        if gcloud artifacts docker images list-vulnerabilities "$$scan" --format='value(vulnerability.effectiveSeverity)' | grep -Eq '^(CRITICAL|HIGH)$$'; then
          echo 'A critical or high vulnerability is in the image.'; exit 1
        fi
  - id: sbom
    name: gcr.io/google.com/cloudsdktool/cloud-sdk:slim
    args: ['gcloud', 'artifacts', 'sbom', 'export', '--uri=${image}']
  - id: deploy
    name: gcr.io/google.com/cloudsdktool/cloud-sdk:slim
    args: ['gcloud', 'run', 'deploy', '\${_SERVICE}-\${_ENV}', '--image=${image}', '--region=\${_REGION}', '--no-traffic', '--tag=candidate', '--service-account=\${_SERVICE}-run@$PROJECT_ID.iam.gserviceaccount.com', '--binary-authorization=default']
  - id: candidate-url
    name: gcr.io/google.com/cloudsdktool/cloud-sdk:slim
    entrypoint: bash
    args: ['-c', "gcloud run services describe \${_SERVICE}-\${_ENV} --region=\${_REGION} --format='value(status.traffic[0].url)' | head -1 > candidate-url"]
  - id: smoke
    name: node:22
    entrypoint: bash
    args: ['-c', 'npm run journeys -- --smoke --base-url="$$(cat candidate-url)"']
  - id: canary
    name: gcr.io/google.com/cloudsdktool/cloud-sdk:slim
    args: ['gcloud', 'run', 'services', 'update-traffic', '\${_SERVICE}-\${_ENV}', '--region=\${_REGION}', '--to-tags=candidate=\${_CANARY}']
images: ['${image}']
`;
}

export function serviceYaml(app: string): string {
  const s = slug(app);
  return `# ${app} on Cloud Run. Applied by the deploy step; kept here so it is reviewed with the release.
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: ${s}-production
  annotations:
    # Only images the build signed can run.
    run.googleapis.com/binary-authorization: default
    run.googleapis.com/ingress: all
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: '1'
        run.googleapis.com/cloudsql-instances: PROJECT_ID:REGION:${s}-db
        run.googleapis.com/execution-environment: gen2
    spec:
      serviceAccountName: ${s}-run@PROJECT_ID.iam.gserviceaccount.com
      containerConcurrency: 80
      timeoutSeconds: 30
      containers:
        - image: REGION-docker.pkg.dev/PROJECT_ID/apps/${s}:SHA
          ports:
            - containerPort: 8080
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: ${s}-database-url
                  key: latest
          startupProbe:
            httpGet:
              path: /health
          livenessProbe:
            httpGet:
              path: /health
`;
}

export const BINAUTHZ = `# Binary Authorization: in this project, Cloud Run runs only images Cloud Build built and signed.
globalPolicyEvaluationMode: ENABLE
defaultAdmissionRule:
  evaluationMode: REQUIRE_ATTESTATION
  enforcementMode: ENFORCED_BLOCK_AND_AUDIT_LOG
  requireAttestationsBy:
    - projects/PROJECT_ID/attestors/built-by-cloud-build
name: projects/PROJECT_ID/policy
`;

function setup(app: string, objectivesN: number): string {
  const s = slug(app);
  return `# Setting up ${app} on Google Cloud

Run these once, as yourself, in Cloud Shell. Nothing in the factory changes a cloud project: every grant and every
resource below is created by a person, with the least access each identity needs. Replace PROJECT_ID and REGION.

\`\`\`mermaid
flowchart LR
  CB[Cloud Build<br>signed provenance] --> AR[Artifact Registry<br>scan and SBOM]
  AR --> BA{Binary Authorization<br>built by Cloud Build?}
  BA -->|yes| CR[Cloud Run<br>no-traffic, canary, release]
  BA -->|no| X[Refused]
  CR --> SQL[(Cloud SQL<br>point-in-time recovery)]
  CR --> SM[Secret Manager]
  CR --> MON[Cloud Monitoring<br>${objectivesN} service levels, alerts]
  SCH[Cloud Scheduler] --> JOB[Cloud Run job<br>nightly integrity and drift]
  JOB --> SQL
\`\`\`

## 1. Turn on the services

\`\`\`bash
gcloud config set project PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \\
  binaryauthorization.googleapis.com containeranalysis.googleapis.com ondemandscanning.googleapis.com \\
  sqladmin.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com monitoring.googleapis.com
gcloud artifacts repositories create apps --repository-format=docker --location=REGION
\`\`\`

## 2. Identities, each with the least it needs

| Identity | Used by | Roles |
| --- | --- | --- |
| \`${s}-run\` | The running app | Cloud SQL Client, Secret Manager Secret Accessor (its own secret only), Logs Writer, Monitoring Metric Writer |
| \`${s}-deploy\` | Cloud Build | Cloud Run Developer, Service Account User on \`${s}-run\` only, Artifact Registry Writer, On-Demand Scanning Admin |
| \`${s}-watch\` | The nightly job | Cloud SQL Client, Secret Manager Secret Accessor (its own secret only), Logs Writer |

\`\`\`bash
for sa in ${s}-run ${s}-deploy ${s}-watch; do gcloud iam service-accounts create $sa; done
P=PROJECT_ID
for r in roles/cloudsql.client roles/logging.logWriter roles/monitoring.metricWriter; do
  gcloud projects add-iam-policy-binding $P --member=serviceAccount:${s}-run@$P.iam.gserviceaccount.com --role=$r
done
for r in roles/run.developer roles/artifactregistry.writer roles/ondemandscanning.admin; do
  gcloud projects add-iam-policy-binding $P --member=serviceAccount:${s}-deploy@$P.iam.gserviceaccount.com --role=$r
done
gcloud iam service-accounts add-iam-policy-binding ${s}-run@$P.iam.gserviceaccount.com \\
  --member=serviceAccount:${s}-deploy@$P.iam.gserviceaccount.com --role=roles/iam.serviceAccountUser
for r in roles/cloudsql.client roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding $P --member=serviceAccount:${s}-watch@$P.iam.gserviceaccount.com --role=$r
done
\`\`\`

## 3. The database, with point-in-time recovery

\`\`\`bash
gcloud sql instances create ${s}-db --database-version=POSTGRES_16 --region=REGION --tier=db-custom-1-3840 \\
  --enable-point-in-time-recovery --retained-transaction-log-days=7 --backup-start-time=07:00 \\
  --retained-backups-count=30 --require-ssl --availability-type=REGIONAL
gcloud sql databases create app --instance=${s}-db
\`\`\`

Restores are rehearsed every quarter: restore to a new instance at a point in time, run \`information/integrity-summary.sql\`
and \`information/drift.sql\` against it, and record the result.

## 4. Secrets, by name

\`\`\`bash
printf '%s' 'postgresql://...' | gcloud secrets create ${s}-database-url --data-file=-
gcloud secrets add-iam-policy-binding ${s}-database-url \\
  --member=serviceAccount:${s}-run@PROJECT_ID.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding ${s}-database-url \\
  --member=serviceAccount:${s}-watch@PROJECT_ID.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
\`\`\`

## 5. Only signed images run

\`\`\`bash
gcloud container binauthz policy import delivery/gcp/binauthz-policy.yaml
\`\`\`

## 6. One build trigger per environment; production waits for a person

\`\`\`bash
for env in development test uat; do
  gcloud builds triggers create github --name=${s}-$env --repo-owner=OWNER --repo-name=REPO --branch-pattern='^main$' \\
    --build-config=delivery/gcp/cloudbuild.yaml --substitutions=_ENV=$env \\
    --service-account=projects/PROJECT_ID/serviceAccounts/${s}-deploy@PROJECT_ID.iam.gserviceaccount.com
done
gcloud builds triggers create github --name=${s}-production --repo-owner=OWNER --repo-name=REPO --tag-pattern='^release-' \\
  --build-config=delivery/gcp/cloudbuild.yaml --substitutions=_ENV=production --require-approval \\
  --service-account=projects/PROJECT_ID/serviceAccounts/${s}-deploy@PROJECT_ID.iam.gserviceaccount.com
\`\`\`

## 7. Service levels, alerts and the nightly watch

Create the service levels in \`ops/slos.json\` and the alert policies in \`ops/alerts.json\` (the Monitoring API, or the
console's JSON editor), the log-based metrics in \`ops/log-metrics.json\`, and the nightly job in \`ops/scheduler.json\`.
`;
}

export function opsFiles(p: Prepared): Record<string, string> {
  const app = p.model.title || 'app';
  const s = slug(app);
  const { latencyMs, list } = objectives(p);
  const run = (extra = '') => `resource.type="cloud_run_revision" AND resource.labels.service_name="${s}-production"${extra}`;
  const slo = (o: Objective) =>
    o.id === 'availability'
      ? { name: o.id, displayName: o.what, goal: o.goal, rollingPeriod: '2419200s', serviceLevelIndicator: { requestBased: { goodTotalRatio: { goodServiceFilter: `metric.type="run.googleapis.com/request_count" AND ${run(' AND metric.labels.response_code_class!="5xx"')}`, totalServiceFilter: `metric.type="run.googleapis.com/request_count" AND ${run()}` } } } }
      : o.id === 'latency'
        ? { name: o.id, displayName: o.what, goal: o.goal, rollingPeriod: '2419200s', serviceLevelIndicator: { requestBased: { distributionCut: { distributionFilter: `metric.type="run.googleapis.com/request_latencies" AND ${run()}`, range: { min: 0, max: latencyMs } } } } }
        : { name: o.id, displayName: o.what, goal: o.goal, rollingPeriod: '2419200s', serviceLevelIndicator: { requestBased: { goodTotalRatio: { goodServiceFilter: `metric.type="logging.googleapis.com/user/${s}_journey_completed" AND metric.labels.journey="${o.id.replace(/^achieved-/, '')}"`, totalServiceFilter: `metric.type="logging.googleapis.com/user/${s}_journey_started" AND metric.labels.journey="${o.id.replace(/^achieved-/, '')}"` } } } };
  const burn = (o: Objective, rate: number, window: string, page: boolean) => ({
    displayName: `${o.what}: error budget burning ${rate}× over ${window}`,
    combiner: 'OR',
    conditions: [{ displayName: `${rate}× burn over ${window}`, conditionThreshold: { filter: `select_slo_burn_rate("projects/PROJECT_ID/services/${s}-production/serviceLevelObjectives/${o.id}", "${window}")`, comparison: 'COMPARISON_GT', thresholdValue: rate, duration: '0s' } }],
    documentation: { content: `See ops/runbook.md, "${o.what}".`, mimeType: 'text/markdown' },
    severity: page ? 'CRITICAL' : 'WARNING',
  });
  const forbidden = p.statements.some((x) => x.slot === 'constraints' && /^never\b|must not/i.test(x.text));
  const alerts = [
    ...list.flatMap((o) => [burn(o, 14.4, '3600s', true), burn(o, 6, '21600s', false)]),
    ...(forbidden ? [{ displayName: 'Something that must never happen happened', combiner: 'OR', conditions: [{ displayName: 'journey.forbidden logged', conditionMatchedLog: { filter: `${run()} AND jsonPayload.kind="journey.forbidden"` } }], alertStrategy: { notificationRateLimit: { period: '300s' } }, documentation: { content: 'See ops/runbook.md, "Something that must never happen happened".', mimeType: 'text/markdown' }, severity: 'CRITICAL' }] : []),
    { displayName: 'The nightly watch found broken integrity or drift', combiner: 'OR', conditions: [{ displayName: 'watch failed', conditionMatchedLog: { filter: `resource.type="cloud_run_job" AND resource.labels.job_name="${s}-watch" AND jsonPayload.check=("integrity" OR "drift") AND jsonPayload.passed=false` } }], alertStrategy: { notificationRateLimit: { period: '3600s' } }, documentation: { content: 'See ops/runbook.md, "The nightly watch found broken integrity or drift".', mimeType: 'text/markdown' }, severity: 'ERROR' },
  ];
  const metrics = [
    { name: `${s}_journey_started`, description: 'Journeys started, by journey, from the events the tracking plan allows', filter: `${run()} AND jsonPayload.kind="journey.started"`, labelExtractors: { journey: 'EXTRACT(jsonPayload.journey)' }, metricDescriptor: { metricKind: 'DELTA', valueType: 'INT64', labels: [{ key: 'journey' }] } },
    { name: `${s}_journey_completed`, description: 'Journeys completed, by journey', filter: `${run()} AND jsonPayload.kind="journey.completed"`, labelExtractors: { journey: 'EXTRACT(jsonPayload.journey)' }, metricDescriptor: { metricKind: 'DELTA', valueType: 'INT64', labels: [{ key: 'journey' }] } },
  ];
  const scheduler = { job: { name: `${s}-watch`, image: `REGION-docker.pkg.dev/PROJECT_ID/apps/${s}-watch:SHA`, serviceAccount: `${s}-watch@PROJECT_ID.iam.gserviceaccount.com`, runs: ['information/integrity-summary.sql', 'information/drift.sql'], logs: 'one JSON line per check: {"check": "integrity" | "drift", "passed": true | false, "detail": ...}' }, schedule: { name: `${s}-watch-nightly`, cron: '17 3 * * *', timeZone: 'Etc/UTC', target: `the Cloud Run job ${s}-watch` } };
  const runbook = `# Runbook: ${app}

Every alert has an entry here. Every incident ends the same way: a defect, a test that would have caught it, and a
ratchet so it cannot come back.

\`\`\`mermaid
flowchart LR
  A[Alert] --> T[Triage: which revision, which journey]
  T -->|a release caused it| R[Move traffic back in one step]
  T -->|data| D[Run integrity and drift; nothing is dropped, so no restore]
  R --> F[Defect, test, ratchet]
  D --> F
\`\`\`

## Moving traffic back

\`\`\`bash
gcloud run revisions list --service=${s}-production --region=REGION
gcloud run services update-traffic ${s}-production --region=REGION --to-revisions=PREVIOUS_REVISION=100
\`\`\`

The data needs nothing: migrations only add and retire, so the previous revision reads the database as it is.

${list.map((o) => `## ${o.what}

Objective: ${(o.goal * 100).toFixed(1)}% over 28 days, from ${o.from}. A fast burn (14.4× in an hour) pages; a slow burn (6× in six hours) opens a ticket.

1. Look at the latest revision: did the burn start when it took traffic? If so, move traffic back.
2. If not, open the journey report and the error report for the feature that burns.
3. Close with a defect, a test and a ratchet.
`).join('\n')}${forbidden ? `
## Something that must never happen happened

Stop first: move traffic back to the previous revision, then find which journey logged it. Every forbidden outcome is
already a check on every journey, so a failing test is written from the log line before anything is fixed.
` : ''}
## The nightly watch found broken integrity or drift

1. Read the log line: which rule, or which column.
2. Integrity: the records the rule's query returns are the ones to fix; fix them with a recorded change, never by hand.
3. Drift: someone changed the database outside the pipeline. Put it back through the pipeline, then find how.
`;
  const pipeline = { schema: 'zthr-delivery/1', app, target: p.options.target, stages: STAGES, objectives: list, adapters: { gcp: ['delivery/gcp/cloudbuild.yaml', 'delivery/gcp/service.yaml', 'delivery/gcp/binauthz-policy.yaml', 'delivery/gcp/setup.md'] } };
  return {
    'delivery/pipeline.json': `${JSON.stringify(pipeline, null, 1)}\n`,
    'delivery/gcp/cloudbuild.yaml': cloudbuild(app),
    'delivery/gcp/service.yaml': serviceYaml(app),
    'delivery/gcp/binauthz-policy.yaml': BINAUTHZ,
    'delivery/gcp/setup.md': setup(app, list.length),
    'ops/slos.json': `${JSON.stringify({ service: `${s}-production`, objectives: list.map(slo) }, null, 1)}\n`,
    'ops/alerts.json': `${JSON.stringify({ alertPolicies: alerts }, null, 1)}\n`,
    'ops/log-metrics.json': `${JSON.stringify({ metrics }, null, 1)}\n`,
    'ops/scheduler.json': `${JSON.stringify(scheduler, null, 1)}\n`,
    'ops/runbook.md': runbook,
  };
}
