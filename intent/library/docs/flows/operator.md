# The operator

The operator is the part of the Advocate that works when no one is asking: it refreshes campus feeds, plans each
bus rider's trips, syncs class sites, and carries out writes the student asked for. It is bounded by structure,
not by its own judgment (Patterns 24 to 27).

```mermaid
flowchart TD
  tick[Tick, every minute] --> jobs[For each due job]
  jobs --> lease{Lease free or expired?}
  lease -- no --> skip[Skip: another operator holds it]
  lease -- yes --> run[Run, with heartbeats]
  run --> ok{Finished?}
  ok -- yes --> release[Release the lease]
  ok -- error --> failed[Record the failure; release]
  jobs --> hold{Can it act?}
  hold -- no --> loss[Hold, and name what the student loses]
  release & failed & loss --> evidence[(Evidence: counts only)]
```

## The jobs

| Job | For | What it does |
| --- | --- | --- |
| `campus-feeds:<campus>` | each campus a student attends | Dining locations, hours, menus; spaces and events; postings and mentors; stops |
| `commute:<student>` | bus riders with a stop | A trip to the first class of each of the next 7 days |
| `transit-now:<student>` | bus riders with a stop | Live arrivals and alerts at their stop |
| `class-site:<student>` | students who connected a class site | Assignments into dates, moved dates, room changes |
| `dispatch` | everyone | Sends queued writes with idempotency keys |
| `verify` | everyone | Looks up each sent or ambiguous write before telling the student |

## What bounds it

```mermaid
flowchart LR
  op[Operator] -->|only| jobs[The jobs listed above]
  op -->|only through| egress[The egress door] -->|only| svc[Campus services]
  op -->|only through| gates[Delivery gates: quiet hours, daily limit, tone] --> student[Student]
  op -->|opens only| token[Class-site token: granted to operator:class-site, logged on every use]
  op -.->|never| other[Any other sealed fact, any other host, any free-form message]
```

## Leases

```mermaid
sequenceDiagram
  participant A as Operator A
  participant L as Leases
  participant B as Operator B
  A->>L: take dispatch (until now + 60 s)
  B->>L: take dispatch
  L-->>B: held by A, skip
  A->>L: heartbeat (until now + 60 s)
  Note over A: A crashes
  B->>L: take dispatch after the lease expires
  L-->>B: yours
```

## Verified by

<!-- verified-by:start -->
- [`apps/advocate/test/campus.test.ts`](../../apps/advocate/test/campus.test.ts) (38 test definitions)
<!-- verified-by:end -->
