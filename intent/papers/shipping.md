# Shipping: Packaging a Signed Release and Moving It to People, One Proven Stage at a Time

**Patterns for a signed release package, publication to the repository and the sites, staged delivery with a gate at every stage, a person approving production, and a way back that always takes one step**

Russ Little · Pattern paper · Draft for review · Nov 26, 2026

v0.1 · Request for comments · © 2026 Russ Little. Licensed under CC BY 4.0. Part of the series rolled up in [The Line](the-line.md).

## Abstract

A passed product is not yet software in service. Between the two are two jobs. The first is to turn the product into a release: package the code, the tests, the docs and the version history into one signed, versioned release, and publish it to the repository and the sites. The second is to move that release to the people it is for, where most outages begin: a data migration that loses records, an image nobody can trace, a revision that starts but fails under real traffic, a release that cannot be undone. Shipping does both, to the standard of configuration management as AS9100 states it. Delivery runs through eight stages, each with a gate it must pass and evidence it must record: build, test, rehearse the data, package and sign, deploy without traffic, canary, release and operate. The operator asks for each stage in order; the pipeline runs it under its own identity and records what it proved; a named person approves production after the canary; and going back is always allowed and always one step. A stage is passed only by what was observed. This paper sets out the patterns for that work. [Deployment engineering](deployment-engineering.md) serves shipping, and sends the release on to the fleet over the air.

> **Central proposition.** Ship a signed, traceable release in stages that each prove one thing, record what was observed rather than what was intended, put a person's signature on production, and keep the way back one step long.

## Where it sits

Shipping is shipping, release and configuration management. It is done by an agent. It takes in a product that passed QA and gives a signed release in the repository, on the sites, and in production. Deployment engineering serves it, and the fleet receives its releases over the air.

```mermaid
flowchart LR
  QA["QA"] -- "passed product" --> SH
  subgraph SH["Shipping"]
    direction TB
    PK["Package: code, tests, docs, version history,<br/>SBOM, licences"] --> SG["Sign and tag"] --> PB["Publish: repository and sites"] --> DP["Deploy in stages,<br/>a person approving production"]
  end
  SH -- "signed release, over the air" --> FL["Fleet"]
  DE["Deployment engineering"] -. "serves" .-> SH
  DE -. "serves" .-> FL
```

```mermaid
erDiagram
  RELEASE ||--|| VERSION_TAG : "is named by"
  RELEASE ||--o{ ARTEFACT : "contains"
  RELEASE ||--|| SBOM : "lists dependencies in"
  RELEASE ||--o{ LICENCE_CHECK : "passes"
  RELEASE ||--o{ STAGE_RECORD : "is moved by"
  RELEASE ||--o| APPROVAL : "reaches production only with"
  RELEASE }o--|| PRODUCT_REVISION : "builds"
  RELEASE {
    string version
    string commit
    string digest
    datetime signedAt
  }
  ARTEFACT {
    string kind "code, tests, docs, version history"
    string checksum
  }
  STAGE_RECORD {
    string stage
    string observed
    string result "passed, failed, not measured"
  }
  APPROVAL {
    string person
    string release
    datetime at
  }
```

## 1. The problem

- **Nothing packaged.** A release is a branch and a hope: no version, no bill of materials, no docs that match the code.
- **Done means deployed.** A deploy command that returned success is reported as a release, though nothing checked what is actually serving.
- **The data is an afterthought.** Code is tested; migrations run for the first time in production.
- **Images from nowhere.** What runs cannot be traced to the build that was certified.
- **No way back.** A bad release is fixed forward, under pressure, because rolling back was never rehearsed.

## 2. The release, then the stages

The release is built once, from the passed product: the code, the tests, the docs built fresh from the source and checked, the version history, a bill of materials (SBOM) and the licence check, under a signed version tag, published to the repository and the sites. The stages then move that exact release.

```mermaid
flowchart LR
  B["1 Build<br/><small>lock file, types, no secrets</small>"] --> T["2 Test<br/><small>every gate in the control plan</small>"] --> D["3 Rehearse the data<br/><small>migrate a copy, nothing lost</small>"] --> P["4 Package and sign<br/><small>provenance, bill of materials</small>"] --> N["5 Deploy without traffic<br/><small>smoke journeys on the candidate</small>"] --> C["6 Canary<br/><small>a small share; budgets hold</small>"] --> R["7 Release<br/><small>everyone; previous ready</small>"] --> O["8 Operate<br/><small>watched; alerts open incidents</small>"]
  C -. a named person approves .-> R
  R -. one step back .-> N
```

| Stage | Proves | Gate |
| --- | --- | --- |
| Build | Dependencies install from the lock file; types check; no secret-shaped value in the source or its history | Every check passes |
| Test | Every test passes; mutation holds its floors; every ratchet holds; every journey passes on the twins | Every gate in the control plan passes |
| Rehearse the data | The schema revision migrates a copy with nothing lost; every integrity rule holds; no drift from the signed schema | The rehearsal passes |
| Package and sign | The image is built by the build service with signed provenance; a bill of materials is recorded; no critical or high vulnerability | The image is signed and clean |
| Deploy without traffic | Only a signed image can run; the new revision starts healthy; journeys pass against it before anyone is sent to it | Smoke journeys pass on the candidate |
| Canary | A small share of people use it; no error budget is burning fast | A named person approves production |
| Release | Everyone is moved to it; the previous revision stays ready to take traffic back in one step | Service levels hold for the watch window |
| Operate | Service levels watched; integrity and drift checked nightly; every alert has a runbook | An alert opens an incident |

## 3. Patterns

### Pattern 1. Request and Record Are Different Hands

**Problem.** The agent that wants a release out is the one that reports it went well.

**Pattern.** The operator requests each stage, in order. The pipeline runs it under its own identity and records what it proved. The operator cannot record; the pipeline cannot request.

```mermaid
sequenceDiagram
  participant O as Operator
  participant P as Pipeline
  participant H as Approver (a person)
  participant L as Ledger
  O->>P: request stage n for release r
  P->>P: run it
  P->>L: record what it proved, or that it failed
  O->>H: request production approval (after the canary)
  H->>L: signed approval for release r
  O->>P: request release
  P->>L: record: serving r
```

### Pattern 2. Done Means Serving

**Problem.** A deploy that succeeded is not a service that serves the new build.

**Pattern.** A release is recorded only after the public address answers with the build's own identity (its commit), checked from outside. Anything else is "deployed, not confirmed".

### Pattern 3. Record What Was Observed

**Problem.** A pipeline that writes "passed" when it finishes, rather than when it checks, records intentions.

**Pattern.** Each stage's record is what it observed: the commit the service answered with, the checksums of the parts it published, the journeys it ran and their results. A stage the pipeline does not have yet is recorded as not measured, and says which step it lacks.

### Pattern 4. Rehearse the Data

**Problem.** Migrations are the least tested and most destructive step.

**Pattern.** Every revision's change to the information schema runs first against a copy of the data. It must lose no record, keep every integrity rule, and match the signed schema exactly, before any stage that touches real data.

### Pattern 5. Only Signed Images Run

**Problem.** What runs in production cannot be traced to what was certified.

**Pattern.** The build service builds the image and signs its provenance; the runtime admits only signed images; the bill of materials is kept with the release.

### Pattern 6. A Person Approves Production

**Problem.** Fully automated releases remove the one judgement that should be a person's: whether to expose everyone.

**Pattern.** After the canary, production waits for a named person's signed approval of the exact release. The approval has no tool in the agent interface.

### Pattern 7. Back in One Step

**Problem.** A rollback that has never been done does not work when it is needed.

**Pattern.** The previous revision stays ready to take traffic. Rolling back is always allowed, to any role that may request stages, and takes one step. A fast burn of any error budget rolls back without waiting for anyone.

### Pattern 8. Service Levels Come With the Package

**Problem.** Service levels set after launch measure what the system happens to do.

**Pattern.** The objectives shipping enforces come from the released package: availability from the team minimum, latency from the feedback the person asked for, achievement rates from the outcomes' tolerances. The canary and the watch window are judged against them.

## 4. Files, shipped

Files ships as one container to Cloud Run, with its bytes and its state in one Cloud Storage bucket and the first admin's password in Secret Manager. It runs as one instance that scales to zero: its state log has one writer, and refuses a second rather than interleave with it. Its maximum upload chunk is held under Cloud Run's request limit, and advertised to the apps in its capabilities so they never send a larger one.

The plant's own site, zthr.ai, is the reference for the release path: it is packaged with an SBOM, a licence check, a reproducible build and docs checked fresh from the source, and deployed from the main branch; its deploy is the Release stage's observer, fetching the copy of the site the running service serves, checking every part against the build's own checksums, and recording the commit it verified. No product of the line has shipped yet; the live standing of each stage, including the stages the reference pipeline has defined and not run (data rehearsal, signing, canary, operate), is on [/plant](https://zthr.ai/plant) and shown as not measured until it is observed.

```mermaid
flowchart LR
  P["Passed Files"] --> PK["Package, SBOM, licences, docs fresh"] --> SG["Signed version tag"] --> PB["Repository and sites"] --> ST["Staged deploy, person approves"] --> OTA["Over the air to the fleet"]
```

## 5. What it needs, and how it is judged

Shipping needs a release package (code, tests, docs, SBOM, licences), a signed version tag, docs built and checked from the source, and staged deploys with a person approving production. Which are met is shown on [/plant](https://zthr.ai/plant).

- **Observed releases.** Every release recorded as serving has an outside check of the commit it served.
- **Approval.** Every production release has a person's signed approval of that release.
- **Reversibility.** Rollback time, measured on every release.

## 6. What it does not claim

Shipping does not make a release safe. It makes each step of exposing it prove something, and keeps every step reversible.
