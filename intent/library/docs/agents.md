# The agent team

One student, one team, one voice. The chief of staff decides who speaks; every specialist's message goes through
the same delivery path. No agent can send anything on a student's behalf: it can only draft.

```mermaid
flowchart TB
  cos[Chief of staff<br/>routes, names, settings]
  cos --> planner[Class planner<br/>deadlines, plans, held time]
  cos --> nav[Help finder<br/>catalog, eligibility, playbooks]
  cos --> coach[Money coach<br/>short months, bills, life skills]
  cos --> week[Week planner<br/>shifts, child care, commute]
  cos --> safety[Safety router<br/>crisis words, 988, 911]
  nav --> pb[Playbooks<br/>FAFSA, SNAP, GI Bill, accommodations, break housing, enrollment]
  builder[Builder agent] -. drafts new scouts and playbooks .-> review{{A person signs off}}
  review -. admitted .-> nav
```

## A message's life

```mermaid
stateDiagram-v2
  [*] --> Written: an agent writes it
  Written --> Held: tone gate fails (scolds, too hard to read, no next step, careless)
  Written --> Checked: tone gate passes
  Checked --> Deferred: quiet hours or the day's limit
  Checked --> Delivered: send now
  Deferred --> Delivered: when the window opens
  Delivered --> Answered: the student taps or replies a number
  Answered --> [*]
  Held --> [*]: counted in evidence, never sent
```

Safety messages skip the reading-grade check and the governor; they always go now.

## What each agent may do

| Agent | Reads | Writes | May never |
| --- | --- | --- | --- |
| Chief of staff | profile, settings, last choices | messages, settings | do coursework |
| Class planner | deadlines, classes, shifts, holds | plans, holds, reminders, drafts to instructors | write assignments |
| Help finder | catalog, eligibility, vault names | messages, playbook runs, drafts | ask about citizenship or immigration status |
| Money coach | balance, bills, pay | messages, drafts to landlords and utilities | give legal, tax or investment advice |
| Week planner | classes, shifts, child care | the week, drafts to managers | move anything without asking |
| Safety router | the words of the message | a crisis reply | wait for quiet hours |
| Builder | evidence of unmet needs | proposals | admit its own work |

## Verified by

<!-- verified-by:start -->
- [`apps/advocate/test/advocate.test.ts`](../apps/advocate/test/advocate.test.ts) (7 test definitions)
- [`apps/advocate/test/builder.test.ts`](../apps/advocate/test/builder.test.ts) (10 test definitions)
- [`apps/advocate/test/plain-language.test.ts`](../apps/advocate/test/plain-language.test.ts) (5 test definitions)
<!-- verified-by:end -->
