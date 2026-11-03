# Mutation testing and ratchets

Tests that pass prove little unless they fail when the code is wrong. Mutation testing makes thousands of small
wrong versions of the code that matters most (verdicts, ratchets, gates, approvals, the governor, eligibility, the
tone rubric) and counts how many the tests catch. The score may only go up: a ratchet holds the floor, and only a
listed person can reset it, in a ledger.

```mermaid
flowchart LR
  code[Critical files] --> mut[Stryker makes mutants]
  mut --> run[Run the tests against each]
  run --> killed[Killed: a test failed]
  run --> survived[Survived: no test noticed]
  killed & survived --> score[Score = killed / total]
  score --> ratchet{At or above the floor?}
  ratchet -- yes --> raise[Floor rises to the new score]
  ratchet -- no --> fail[Build fails]
  reset[A listed person] -. signed reset in the ledger .-> ratchet
```

Mutation runs nightly on an 8-CPU Cloud Build machine.

## Verified by

<!-- verified-by:start -->
- [`packages/gates/test/gates.test.ts`](../../packages/gates/test/gates.test.ts) (16 test definitions)
<!-- verified-by:end -->
