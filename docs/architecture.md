# Architecture

The Student Advocate is one service with three ways in: the web app, text messages and the integration API. All
three call the same Advocate, so a button, a text reply and an API call do exactly the same thing. Everything the
Advocate says passes the tone gate and the contact governor before it reaches a student. Nothing leaves for the
network except through the egress block, and nothing is sent on a student's behalf without their approval.

## System context

```mermaid
flowchart LR
  student([Student]) -- taps --> web[Web app]
  student -- texts --> sms[Text webhook]
  tools([Student's other tools]) -- token --> api[Integration API]
  web & sms & api --> adv[Advocate]
  adv --> registry[Action registry]
  adv --> agents[Agent team]
  agents --> gate{Tone gate}
  gate -- passes --> gov{Contact governor}
  gate -- fails --> held[(Held, never sent)]
  gov -- now --> deliver[Delivered]
  gov -- quiet hours or daily cap --> deferred[(Deferred)]
  deliver --> student
  adv --> store[(App store)]
  adv --> ledger[(Consent ledger)]
  adv --> sealed[(Sealed facts)]
  adv --> evidence[(Evidence)]
  adv -- approved drafts only --> outbound[Outbound gate]
  adv -- webhooks --> egress[Egress block]
  egress -- allow-listed hosts --> internet((Internet))
  op[Operator: leased jobs] -- feeds, plans, class sites --> egress
  egress -- campus hosts --> campus[Campus services: dining, transit, places, careers, class site]
  op -- writes as dispatches, confirmed by lookup --> egress
  op --> store
  adv --> op
```

The operator is the part that works when no one is asking: it refreshes campus feeds, plans bus trips, syncs class
sites and carries out the writes students asked for, on a schedule and under leases. Conversations never wait on
the network; they answer from what the operator fetched and say how old it is.

## Building blocks

Every box below is a package any app in the factory can reuse. The Advocate is one app built from them.

```mermaid
flowchart TB
  subgraph app[apps/advocate]
    server[server: web app, API, text] --> agentsA[agents: Advocate, action registry]
    agentsA --> domain[domain: planner, money, navigator, crisis, tone, week, schema]
    agentsA --> elig[eligibility engine + dated parameters]
    agentsA --> pb[playbook engine]
    agentsA --> builder[builder agent + scouts]
    agentsA --> opA[operator: leases, dispatches]
    agentsA --> integ[integrations: campus clients]
  end
  subgraph svc[apps/campus-services]
    synth[synthetic dining, transit, places, careers, class site + contracts]
  end
  integ -. contract .-> synth
  subgraph blocks[packages]
    ui["@zthr/ui"]
    explore["@zthr/explore"]
    egressB["@zthr/egress"]
    gates["@zthr/gates"]
    evidenceB["@zthr/evidence"]
    runtime["@zthr/runtime"]
    intent["@zthr/intent"]
    twins["@zthr/twins"]
    models["@zthr/models"]
    review["@zthr/review"]
  end
  server --> ui
  agentsA --> runtime & evidenceB & twins & egressB
  builder --> models
  tests[[Tests, walks, gates]] --> explore & gates & intent & review
```

| Block | What it gives an app |
| --- | --- |
| `@zthr/ui` | Light and dark tokens, app and console shells, notes, day line, week grid, tiles, rows, forms, tables, icons; everything escaped |
| `@zthr/explore` | Exhaustive model-based exploration to a fixpoint, with invariants at every step |
| `@zthr/egress` | The one allow-listed, recorded door to the network, and its twin |
| `@zthr/gates` | Three-valued verdicts, falsification proofs, ratchets, datums, findings |
| `@zthr/evidence` | Append-only, pseudonymous evidence store and measures |
| `@zthr/runtime` | Approval tokens and the outbound gate, contact governor, safety screen, consent ledger, sealed facts, start-up refusal |
| `@zthr/intent` | Locked journey cards and the journey runner |
| `@zthr/twins` | Calibrated stand-ins for outside services |
| `@zthr/models` | Metered, budgeted model client with a twin |
| `@zthr/review` | Optional multi-family model review |

## A tap, end to end

```mermaid
sequenceDiagram
  actor S as Student
  participant W as Web app
  participant A as Advocate
  participant R as Action registry
  participant T as Tone gate
  participant G as Contact governor
  participant St as App store
  S->>W: taps "Hold today 11:30 a.m."
  W->>A: perform(student, "hold-block:dl:2026-11-02:11:30")
  A->>R: look up "hold-block"
  R->>St: save the held time and a reminder (idempotent)
  R-->>A: message + the screen to show
  A->>T: plain? kind? has a next step?
  T-->>A: passes
  A->>G: send now?
  G-->>A: yes (forced: the student asked)
  A->>St: record the delivered message
  A-->>W: redirect to Today with the message on top
  W-->>S: the day line now shows the held time
```

The same action by text is a reply of "1"; by API it is `POST /api/v1/actions`.

## Deployment

```mermaid
flowchart LR
  dev[Push to GitHub] --> cb[Cloud Build: gates, journeys, tests, walks]
  cb -- all pass --> run[Cloud Run: Student Advocate]
  cb --> bucket[(Evidence bucket)]
  fb[Firebase Hosting: zthr.ai] -- /advocate/** --> run
  fb -- /docs, /factory --> static[Static docs and factory console]
  visitor([Visitor]) --> fb
```

## Verified by

<!-- verified-by:start -->
- [`apps/advocate/test/api.test.ts`](../apps/advocate/test/api.test.ts) (33 test definitions)
<!-- verified-by:end -->
