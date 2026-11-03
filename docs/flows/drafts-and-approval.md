# Drafts and approval

The Advocate writes; the student sends. A send needs an approval token minted from the exact draft the student saw.
A token for one draft cannot send another, cannot be reused, and expires.

```mermaid
sequenceDiagram
  actor S as Student
  participant A as Advocate
  participant P as Approval service
  participant O as Outbound gate
  participant L as Consent ledger
  A->>S: Here is a draft to your landlord. Nothing is sent until you say so.
  S->>A: Send it
  A->>P: issue(student, recipient, exact body)
  P-->>A: token bound to that content
  A->>L: approve draft
  A->>O: dispatch(action, token)
  O->>P: verify token matches recipient and body
  P-->>O: valid, now spent
  O-->>A: sent
  A-->>S: Sent to landlord. I will watch for a reply.
```

The `student-sends` gate proves the outbound gate refuses a send without a token, and is itself proven by a planted
dispatcher that ignores tokens.

## Verified by

<!-- verified-by:start -->
- [`apps/advocate/test/hardening.test.ts`](../../apps/advocate/test/hardening.test.ts) (14 test definitions)
- [`packages/runtime/test/runtime.test.ts`](../../packages/runtime/test/runtime.test.ts) (15 test definitions)
<!-- verified-by:end -->
