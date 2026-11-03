# Class-site sync

A student can connect their class site once. From then on, every assignment and exam is in their dates, a due
date moved by the instructor moves here with a message, and a room change announced on the class site updates
their schedule.

```mermaid
sequenceDiagram
  participant S as Student
  participant A as Advocate
  participant V as Sealed store
  participant O as Operator (class-site job)
  participant L as Class site
  S->>A: connect my class site (token)
  A->>V: seal token, grant only operator:class-site
  A->>A: source on, logged in the consent ledger
  loop every tick
    O->>V: open token for "sync assignments" (logged)
    O->>L: courses, assignments, announcements
    L-->>O: answers checked against the contract
    O->>A: add new, move changed, apply room changes
    A-->>S: "Your class site changed a date" (only when one did)
  end
  S->>A: disconnect
  A->>V: remove token and grant
```

```mermaid
flowchart TD
  a[Assignment from the class site] --> seen{Seen before? matched by its id there}
  seen -- no --> add[Add, confirmed, with the class site as the source]
  seen -- yes --> same{Same due date?}
  same -- yes --> nothing[Nothing]
  same -- no --> move[Move it; tell the student if it is still ahead]
  bad{Token refused or service down} --> unknown[Unknown with the reason; dates unchanged]
```

Dates from the class site are confirmed because they come from the instructor's own site, not from reading a
document. The token never appears in an export, a message or the store; only the class-site job can open it, and
every opening is a line in the consent ledger.

## Verified by

<!-- verified-by:start -->
- [`apps/advocate/test/campus.test.ts`](../../apps/advocate/test/campus.test.ts) (36 test definitions)
<!-- verified-by:end -->
