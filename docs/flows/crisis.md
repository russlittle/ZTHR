# When something goes wrong

Five situations have a ready plan: eviction notice, utility shut-off, a car that died, no food, and rent that
will be short. A forwarded shut-off or eviction notice starts the same plan without the student asking.

```mermaid
flowchart TD
  in1[Help screen tile] --> detect
  in2["Text: they're shutting off my power"] --> detect
  in3[Forwarded notice] --> detect
  detect{Which situation?} --> plan[Plan: first step, then verified resources that fit]
  plan --> draft[Draft to the landlord, utility or Legal Aid]
  plan --> start[Start a resource: steps, hours, what I can fill in, what is missing]
  plan --> call[Talk to 2-1-1]
  plan -.-> gap[(Unmet need counted by county, for the builder)]
  draft --> approve{Student approves the exact text?}
  approve -- yes --> token[One-time approval token] --> send[Sent through the outbound gate]
  approve -- no --> waits[Draft waits]
```

Words of self-harm or violence never reach this flow: the safety router answers first, with 988 and 911.

## Verified by

<!-- verified-by:start -->
- [`apps/advocate/test/hardening.test.ts`](../../apps/advocate/test/hardening.test.ts) (14 test definitions)
<!-- verified-by:end -->
