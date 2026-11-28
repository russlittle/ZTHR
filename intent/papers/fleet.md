# The Fleet: Keeping Every Product in Service, Updated Over the Air, Reporting Back

**Patterns for the installed base: updates over the air with rollback, service levels that decide, incidents that become ratchets, and what the field shows reported back to the office**

Russ Little · Pattern paper · Draft for review · Nov 26, 2026

v0.1 · Request for comments · © 2026 Russ Little. Licensed under CC BY 4.0. Part of the series rolled up in [The Line](the-line.md).

## Abstract

Most of the cost of software comes after it ships: fixing what breaks, keeping dependencies current, answering the same incident in a second product a month after the first. The fleet is everything in service: each app, the blocks it draws on and the data it keeps. It is field service for the installed base, to the standard of service bulletins and field updates. A plant that makes products mostly from shared assemblies can do something separate teams cannot: fix a shared assembly once, in the library, and send the fix to every app that uses it as an update over the air, with rollback. The fleet receives signed releases from shipping, holds each product to the service levels its package set, shows which version each app runs and which apps use which block, and governs the data the same way everywhere. Every incident becomes a defect, a test and a ratchet, in the assembly where it began, so no product meets the same failure twice. What the field shows goes back to mission control, and the plant runs again. This paper sets out seven patterns for the fleet.

> **Central proposition.** Receive every release over the air, hold each app to its service levels, let error budgets decide what happens next, turn every incident into an instrument so no product fails the same way twice, and report what the field shows back to the office.

## Where it sits

The fleet is the field group, after shipping. It is done by an agent. It takes in signed releases, delivered over the air, and gives mission control what the field shows. [Deployment engineering](deployment-engineering.md) serves it: the environments, the updates, the monitoring.

```mermaid
flowchart LR
  SH["Shipping"] -- "signed release, over the air" --> FL
  subgraph FL["Fleet: the installed base"]
    direction TB
    APP["Each app in service, and the version it runs"]
    SLO["Service levels and error budgets"]
    APP --> SLO
  end
  FL -- "what the field shows" --> MC["Mission control"]
  DE["Deployment engineering"] -. "serves" .-> FL
  FL -- "defects, tests, ratchets" --> LIB[("Block library, in product engineering")]
```

## 1. The problem

- **The same bug, again.** A defect fixed in one product's copy of sign-in is still in the four other copies.
- **Upkeep nobody owns.** Dependency updates and security fixes wait until something forces them.
- **Opinions about health.** Whether a product is healthy is argued, not read.

```mermaid
flowchart TB
  LIB[(Library: standard assemblies)] --> P1[Product A]
  LIB --> P2[Product B]
  LIB --> P3[Files]
  P1 & P2 & P3 --> SLO[Service levels and error budgets]
  SLO -->|fast burn| RB[Roll back]
  SLO -->|incident| INC[Incident]
  INC --> DEF[Defect in the assembly where it began]
  DEF --> TEST[Test that fails on it]
  TEST --> RAT[Ratchet that holds it]
  RAT --> LIB
  P1 & P2 & P3 -->|reports and alerts| MC[Mission control]
```

## 2. Principles

**Maintained by the library, or by the product, never by neither.** Every line of every manifest names who maintains it: standard assemblies are maintained once in the library by product engineering, and the fleet shows where each is used and which version each app runs.

**Budgets decide.** Error budgets, not opinions, decide whether a product takes new changes, is held, or is rolled back.

## 3. Patterns

### Pattern 1. Maintained Once, Updated Over the Air

**Problem.** Copies of the same part diverge, and each fix reaches one copy.

**Pattern.** A standard assembly used as it is, or extended, is maintained in the library. A fix to it is made once, there, and sent to every product that uses it as a change through each product's own line, admitted and certified there like any other, then released and delivered over the air. Every update can be rolled back in one step.

**Consequences.** The cost of a fix is paid once. Each product still proves the fix with its own journeys before it ships, and the fleet shows which apps have taken it.

```mermaid
sequenceDiagram
  participant LIB as Block library
  participant LN as A product's line
  participant SH as Shipping
  participant DE as Deployment engineering
  participant FL as Fleet
  LIB->>LN: fix to a shared block
  LN->>LN: admitted and passed by QA, like any change
  LN->>SH: passed product
  SH->>DE: signed release
  DE->>FL: update over the air
  FL->>FL: take it, watch the budgets
  FL-->>DE: rollback if a budget burns fast
```

### Pattern 2. Where Used Before Changed

**Problem.** A change to a shared part breaks a product nobody thought of.

**Pattern.** Before a shared assembly changes, the fleet lists every product that uses it, how (as is, extended, inside a custom assembly), which version each app runs and with which of its data. The change is certified against all of them.

### Pattern 3. Error Budgets Decide

**Problem.** Whether to ship more changes to an unstable product is argued case by case.

**Pattern.** Each product's objectives come from its package, each with an error budget over its window. A budget burning fast rolls the latest release back; a budget spent holds new changes to that product until it recovers; a healthy budget lets changes flow.

| Budget | What the fleet does |
| --- | --- |
| Healthy | Changes flow through the line as usual |
| Burning fast | The latest release rolls back, at once, without waiting |
| Spent for the window | Only fixes ship to that product until it recovers |

### Pattern 4. Every Incident Becomes a Ratchet

**Problem.** An incident is resolved and forgotten, and recurs.

**Pattern.** An incident is closed only when it has become a defect against the assembly where it began, a test that fails on it, and a ratchet or gate that holds it. Because the assembly is shared, the new test protects every product that uses it.

```mermaid
stateDiagram-v2
  [*] --> Incident: an alert opens it
  Incident --> Mitigated: roll back or hold
  Mitigated --> Defect: the cause, in the assembly where it began
  Defect --> Test: a test that fails on it
  Test --> Ratchet: a gate or floor that holds it
  Ratchet --> [*]: closed, and every product using the assembly is protected
```

### Pattern 5. Upkeep on a Cadence

**Problem.** Dependency and security updates wait for a crisis.

**Pattern.** Dependencies of shared assemblies are updated on a fixed cadence, through the line, and records for each product how far behind the library it is. A product far behind is a reading on mission control, not a surprise.

### Pattern 6. One Governance for the Data

**Problem.** Sensitive data is guarded differently in each product.

**Pattern.** Every product's information carries the same sensitivity classes, and every read, export and query of sensitive data goes through the same gate and the same audit, whichever product holds it. The fleet shows, for each class, which products hold it.

### Pattern 7. Reports Close the Loop

**Problem.** What people report about a product in service never reaches the place that could change it.

**Pattern.** Problems people report, and what the field's telemetry shows, are filed in their own words, triaged into defects or intent questions, and shown on mission control against the product and the balloon they concern. An intent question goes to the holder as a clarification; a defect goes to rework as a return and, where its cause is a shared block, to the library.

```mermaid
flowchart LR
  FIELD["People and telemetry in the field"] --> FL["Fleet"]
  FL -- "what the field shows" --> MC["Mission control"]
  MC --> T{"Triage"}
  T -- "intent question" --> IS["Intent studio: a clarification for the holder"]
  T -- "defect" --> RW["Rework: a return"]
  T -- "defect in a shared block" --> LIB["Block library"]
  IS -.-> PL["Next release"]
  RW -.-> PL
  LIB -.-> PL
  PL -- "signed release, over the air" --> FL
```

## 4. Files, in the fleet

Files draws on the library blocks its manifest names. A fix to any of them (the tree's etag propagation, the object store's checksums, the uploads' expiry, the grants' throttling) is made once in the library, and reaches Files and every later product that uses the same block, each through its own line and over the air. Its service levels come from its package, and its nightly sweep (the trash after its days, old versions after theirs, idle uploads, expired links) is planned by the retention block and recorded as a run.

A second product in its line (calendars and contacts) would share the device sessions, grants and DAV core with Files. An incident in sign-in found in either would become a test in the devices block, protecting both.

Nothing from the line is in service yet, so the fleet's lamp is off, and it stays off until an app is live; [/plant](https://zthr.ai/plant) shows the standing.

## 5. What it needs, and how it is judged

The fleet needs updates over the air with rollback, live walks of every product in service, and telemetry back to mission control. Which are met is shown on [/plant](https://zthr.ai/plant).


- **Reach of fixes.** For each fix to a shared assembly, the share of products using it that have taken it, and how long they took.
- **Recurrence.** The number of incidents whose cause was already covered by a ratchet: it should be zero.
- **Budgets.** The share of time each product's budgets are healthy, burning or spent.

## 6. What it does not claim

The fleet does not prevent incidents. It makes each one cheaper than the last: the fix is shared, the test is shared, and the same failure is caught everywhere before it happens again.
