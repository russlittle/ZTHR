# @zthr/runtime

What keeps a running product safe: approval tokens and the outbound gate, the contact governor, the safety screen
and crisis replies, the deterministic sandwich around any model, the consent ledger, sealed facts, and refusing
to start misconfigured.

```mermaid
flowchart TB
  boot{Start-up checks} -- missing secret or sign-in --> refuse[Refuse to start]
  boot -- ok --> serve[Serve]
  serve --> screen[Safety screen first]
  screen -- crisis --> reply[Crisis reply: 988, 911]
  screen -- ok --> work[Work]
  work --> gov[Governor: quiet hours, daily cap]
  work --> out[Outbound gate: token or no send]
  work --> ledger[(Consent ledger: hash-chained)]
  work --> sealed[(Sealed facts: per-student keys)]
```

## Use it for

The safety screen, sealed facts and their consent ledger, approval tokens and the outbound gate, refusing to start misconfigured, and the deterministic sandwich.

## Not for

The app's own business rules.

## Verified by

<!-- verified-by:start -->
- [`packages/runtime/test/hardening.test.ts`](../../packages/runtime/test/hardening.test.ts) (4 test definitions)
- [`packages/runtime/test/runtime.test.ts`](../../packages/runtime/test/runtime.test.ts) (15 test definitions)
<!-- verified-by:end -->
