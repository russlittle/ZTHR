# @zthr/operator

The parts every persistent operator needs (Patterns 24 to 26), with no knowledge of what its jobs do: leases with
heartbeats so a job never runs twice at once, dispatches that are "sent" until a lookup confirms them, and holds
that record what a person loses when a job does not run.

```mermaid
stateDiagram-v2
  [*] --> queued: idempotency key from owner, kind, request
  queued --> sent: send ok
  queued --> refused: 400 or 409 (a definite no)
  queued --> ambiguous: timeout or 5xx (may have happened)
  ambiguous --> sent: resend with the same key
  ambiguous --> refused: attempts used up
  sent --> confirmed: lookup finds it
  sent --> refused: lookup says no
  sent --> sent: lookup pending
  confirmed --> [*]
  refused --> [*]
```

```mermaid
sequenceDiagram
  participant A as Operator A
  participant S as Store
  participant B as Operator B
  A->>S: take(job) — free, so A holds it for 60 s
  B->>S: take(job) — A's lease has not lapsed: skipped
  A->>S: beat(job) — extended
  A->>S: release(job)
  B->>S: take(job) — free, so B holds it
```

## Use it for

Background work that writes to someone else's system on a person's behalf (bookings, requests, submissions), and any scheduled job that two processes might both try to run. Hand `Leases` any store with get, put and remove.

## Not for

Conversations (they stay synchronous and answer from cached data), exactly-once delivery across systems that ignore idempotency keys, or scheduling itself (the app owns its clock and job list).

## Verified by

<!-- verified-by:start -->
- [`packages/operator/test/operator.test.ts`](../../packages/operator/test/operator.test.ts) (14 test definitions)
<!-- verified-by:end -->
