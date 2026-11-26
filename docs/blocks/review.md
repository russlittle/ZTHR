# @zthr/review

Optional multi-family model review. When a provider is configured, three model families review a change before
commit and a fourth after; each role has things it may not do. Without a provider, admission rests on the
deterministic gates, journeys and walks.

Every seat reviews against the locked datum: the journey cards, checked against their lock before the panel runs.
The author's commit message is not evidence; it reaches only the context-aided seat, labelled as a claim to test.
A seat shown less than the whole change returns unknown without being asked, and the tool names what it left out,
so a change too large to review whole must be split.

## Use it for

Configuring a review panel of several model families and the shape of their verdicts.

## Not for

Replacing gates, or review by a single model family.

## Verified by

<!-- verified-by:start -->
- [`packages/review/test/review-more.test.ts`](../../packages/review/test/review-more.test.ts) (14 test definitions)
- [`packages/review/test/review.test.ts`](../../packages/review/test/review.test.ts) (6 test definitions)
<!-- verified-by:end -->
