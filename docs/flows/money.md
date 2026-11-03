# Money found and short months

```mermaid
flowchart TD
  profile[Household size, income, work hours, children] --> engine{Eligibility engine<br/>dated parameters}
  engine --> snap[SNAP: student exemption, gross and net limits]
  engine --> lifeline[Lifeline: 135% of poverty]
  engine --> heap[Ohio HEAP: 175% of poverty]
  engine --> grant[Campus emergency grant]
  snap & lifeline & heap & grant --> results[Likely / needs info / not likely, with reasons and sources]
  results --> card[Money screen and message: what, about how much, start the first one]
  card --> playbook[SNAP playbook or resource steps]

  bal[Balance, bills, pay dates] --> gap{Short before payday?}
  gap -- yes --> heads[Heads-up before it happens]
  heads --> o1[Apply for the emergency grant]
  heads --> o2[Draft to the landlord or utility, ready to approve]
  heads --> o3[Apply for HEAP]
  heads --> o4[Call 2-1-1]
  gap -- no --> quiet[Nothing to say]
```

The engine never asks about citizenship or immigration status. Programs with status rules say so, and the agency
explains them. Every limit is checked against the published table by the `snap-income-oracle` gate.

## Verified by

<!-- verified-by:start -->
- [`apps/advocate/test/domain.test.ts`](../../apps/advocate/test/domain.test.ts) (14 test definitions)
- [`apps/advocate/test/eligibility.test.ts`](../../apps/advocate/test/eligibility.test.ts) (7 test definitions)
- [`apps/advocate/test/plain-language.test.ts`](../../apps/advocate/test/plain-language.test.ts) (5 test definitions)
<!-- verified-by:end -->
