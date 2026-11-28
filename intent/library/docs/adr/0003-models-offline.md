# ADR 0003: Deterministic first, models optional

**Decision.** Every Phase 1 capability that decides an outcome is deterministic: today view, deadlines, eligibility,
catalog matching, plans, approvals, safety routing. Models draft, explain and classify, always inside a sandwich
with a deterministic fallback. The factory runs end to end without a model key; review seats without a provider
report unknown.

**Why.** Pattern 19 (Determinism Ladder) and Pattern 31 (fail closed, keep serving the user), and a cost target of
$0.50 of model spend per active student per month.
