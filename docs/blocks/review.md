# @zthr/review

Optional multi-family model review. When a provider is configured, three model families review a change before
commit and a fourth after; each role has things it may not do. Without a provider, admission rests on the
deterministic gates, journeys and walks.

## Use it for

Configuring a review panel of several model families and the shape of their verdicts.

## Not for

Replacing gates, or review by a single model family.

## Verified by

<!-- verified-by:start -->
- [`packages/review/test/review-more.test.ts`](../../packages/review/test/review-more.test.ts) (9 test definitions)
- [`packages/review/test/review.test.ts`](../../packages/review/test/review.test.ts) (6 test definitions)
<!-- verified-by:end -->
