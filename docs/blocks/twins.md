# @zthr/twins

Calibrated stand-ins for services outside the factory: text messaging (with STOP and START), calendar feeds, and
the shape every twin follows, so journeys can cover a whole activity even where it crosses systems we do not own.
A twin records when it was last calibrated against the real thing; a stale twin is reported.

## Use it for

Behavioral clones of services you do not own, fitted to recorded probes, with a calibration check that fails the twin when the real service changes.

## Not for

Services you own: test those where they live.

## Verified by

<!-- verified-by:start -->
- [`packages/twins/test/twins.test.ts`](../../packages/twins/test/twins.test.ts) (3 test definitions)
<!-- verified-by:end -->
