# @zthr/twin-service

Everything a synthetic service needs to behave like a real vendor's API (Pattern 33): a clock you can set, bad-day
scenarios on request, health and a generated OpenAPI document, plain JSON errors, and seeded randomness so the
same request at the same clock always gets the same answer.

```mermaid
flowchart LR
  req[Request] --> scen{X-Twin-Scenario}
  scen -- outage --> e503[503]
  scen -- slow --> wait[Wait 1.5 s] --> routes
  scen -- none or the service's own --> routes[Service routes]
  routes --> clock[clock: at or X-Twin-Clock, in the twin's zone]
  routes --> rng[rng: seeded, deterministic]
  routes --> ans[Answer + x-synthetic-service]
  routes -- BadRequest --> e400[400]
  routes -- NotFound --> e404[404]
```

## Use it for

Standing in for a service you do not own (dining, transit, room booking, a job board, a learning platform) so tests, walks and demos can rely on it, with a contract that a real vendor can later be checked against.

## Not for

Production data, services you do own (test the real one), or load testing (it answers in-process and fast).

## Verified by

<!-- verified-by:start -->
- [`packages/twin-service/test/twin-service.test.ts`](../../packages/twin-service/test/twin-service.test.ts) (10 test definitions)
<!-- verified-by:end -->
