# Meals for the week

A student asks for a meal plan, or taps it on the Help screen. The Advocate plans a week of simple, filling meals
from staples most stores carry and SNAP covers, sized to the household, with one shopping list. When the student
likely qualifies for SNAP, the plan is sized to that estimate split across the month. No prices are quoted: they
change by store and week.

```mermaid
flowchart LR
  ask["Text: what can I cook / Help: plan a week of meals"] --> size[Household size]
  size --> snap{Likely SNAP?}
  snap -- yes --> budget[Weekly budget = SNAP estimate / 4.3]
  snap -- no --> nobudget[No budget assumed]
  budget & nobudget --> plan[7 days x 3 meals from staples]
  plan --> list[One shopping list, scaled]
  plan --> tips[Ways to stretch it]
  list --> online[Buy with SNAP online]
  list --> pantry[Free food near me]
```

## Verified by

<!-- verified-by:start -->
- [`apps/advocate/test/meals.test.ts`](../../apps/advocate/test/meals.test.ts) (7 test definitions)
<!-- verified-by:end -->
