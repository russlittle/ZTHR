# Starting by text

A student can start with any message. If it names a need, they get help first and questions after. The account is
made at the second reply; replying confirms the student is 18 or older, and that confirmation is in the consent
ledger. Crisis words at any point go straight to the safety reply.

```mermaid
stateDiagram-v2
  [*] --> Start: first message
  Start --> Crisis: crisis words
  Crisis --> [*]: 988 and 911, right away
  Start --> Where: give help first if a need was named
  Where --> Where: no college or ZIP yet
  Where --> Household: account made, adult confirmed by reply
  Household --> Household: needs two numbers
  Household --> School: people and income
  School --> Named: money found shown
  Named --> Talking: "What should I call you?"
  Talking --> Talking: TODAY, PLAN, FAFSA, needs, questions, numbers
```

Spanish is detected from the first message and the whole start runs in Spanish.

## Verified by

<!-- verified-by:start -->
- [`apps/advocate/test/advocate.test.ts`](../../apps/advocate/test/advocate.test.ts) (7 test definitions)
<!-- verified-by:end -->
