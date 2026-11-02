# ZTHR reference implementation

An independent, open implementation of the [ZTHR pattern language](https://zthr.ai) and the application it builds:
**Student Advocate**, a free, student-owned team of AI agents that runs a college student's day, finds the help
they qualify for, and does the legwork to get it.

Two claims are on trial here, in public: that a ZTHR factory takes weeks to stand up, not years, and that its cost
is real and manageable. Every measure is computed from an append-only evidence store and published on the
evidence page; anything not yet measured is shown as not measured.

## Layout

| Path | What it is |
| --- | --- |
| `packages/gates` | Three-valued verdicts, gates with falsification proofs, ratchets with a reset ledger, datums, findings register |
| `packages/evidence` | Append-only evidence store, token ledger with dated prices, section 16 measures |
| `packages/runtime` | Approval tokens, contact governor, safety router, deterministic sandwich, startup guard, consent ledger, sealed store |
| `packages/models` | Provider-neutral model access with metering and budgets; a model twin for offline runs |
| `packages/review` | Multi-family review panel with role denials enforced by what each seat is shown |
| `packages/intent` | Locked journey cards, the journey runner, the lock gate |
| `packages/twins` | Calibrated twins of external services |
| `control/` | The control plane: journey cards, gates, budgets, playbooks, stop policy, lock and ledgers |
| `apps/advocate` | The Student Advocate application |
| `tools/` | Factory commands: gates, journeys, lock, evidence page |

## Running

```sh
npm install
npm test            # unit tests for every kit and the app
npm run gates       # prove every named gate can fail, then run them
npm run journeys    # run every locked journey and record the results
npm run evidence    # build the evidence page from the evidence store
npm run dev         # start the Advocate locally (text twin and web app)
```

Model calls use `OPENROUTER_API_KEY` when it is set. Without it, model-dependent steps run against a twin and
review seats report **unknown**, which never admits a change.

## Licenses

Code: Apache 2.0. Documentation: CC BY 4.0. See `CLEANROOM.md` for provenance.
