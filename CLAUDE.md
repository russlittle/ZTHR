# Working in this repository

This repository is built and kept by agents under ZTHR fixtures. These rules hold for every session, scheduled or not.

## What is true is measured, not typed

- Every number in the README, `docs/` and `writeups/` is a fact between markers: `<!--fact:name-->270<!--/fact-->` (docs/testing/facts.md). Never type a count without a marker. After any change, run `npx tsx tools/facts.ts --write`; the `facts-current` gate fails a push with a stale or unsourced number.
- A number measured by a run (tests run, controls clicked, students walked) is written into the published site by the build that measured it. Never copy a number from a local run into public material.
- A claim with "every", "all" or "never" must be what the evidence shows. When it rests on a sample, say the sample.

## The published site is built, never copied

- zthr.ai's reference site is the static copy the Cloud Build makes from its own evidence (cloudbuild.yaml, site step), served by the app under `/_publish/` and deployed by the zthr.ai workflow. Never build the site locally and copy it into the zthr.ai repository; local evidence is partial.
- The live walk fails when zthr.ai shows a different commit than the app.

## Tests, gates and mutation

- Never weaken or delete a test, lower a floor or ratchet, or add a `Stryker disable` comment. An equivalent mutant is removed by simplifying the code (docs/testing/mutation.md).
- A gate's proof must be current: run `npx tsx tools/gates.ts` and commit `control/proofs.json` with the change that moved it.
- Results a test checks are computed inside the test (or in `beforeEach`), never in a `describe` body.

## What only a person does

- Locked journey cards (`control/journeys`, `control/lock.json`), held-out phrasings (`control/heldout`), `control/people.json`, `control/ratchet-resets.jsonl`, `control/mutation-floors.json`, `control/required-checks.yaml` and `tools/person-signed.ts` are changed only by a person, in a commit GitHub verifies; the `person-signed` build step fails any other. An agent proposes a journey card in `control/proposals` instead.
- No credentials entered, no IAM or Google Cloud changes by an agent.

## Commits

Commit as claude-agent. Pushing to `reference-implementation` starts Cloud Build; a docs-only change uses `[skip ci]`. Never push between 06:30 and 08:30 UTC, when the nightly run starts.
