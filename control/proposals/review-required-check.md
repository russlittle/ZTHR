# Proposal: make "Review" a required check, and put the crew's workflows on main

**For the owner to decide.** Nothing in `control/` has been changed. This file proposes an edit to `control/required-checks.yaml` and to the branch protection it governs, and asks for two files to be copied to `main`.

## The check

`.github/workflows/review.yml`, job `review` (status check `Review / review`), runs on every push to `intent-surface`. It also runs after each crew push, through `workflow_call`. The check fails when:

- fewer than three model families return a verdict that has a provider response id. A reviewer that did not run, or did not reply in a form that can be read, has approved nothing.
- any reviewer blocks. A reviewer blocks with a blocker finding that names a location, the expectation it violates and its support.

Each verdict is recorded in `intent/factory/reviews/<sha>.json`. The record holds the provider, the model id, the provider's response id, the tree hash of the code reviewed and the cost. The reviewer runs from the base commit, so a change cannot ship the reviewer that approves it.

## Proposed changes

1. Add `Review / review` to the required checks for `intent-surface`.
2. Copy `.github/workflows/crew.yml` and `.github/workflows/night-shift.yml` to `main`. GitHub fires `schedule` and `workflow_run` only from the default branch. Until both files are on `main`, the crew runs only when started by hand.

## Why it should be required rather than advisory

Pattern 21 requires three families before a change is committed. As an advisory check, a red review stops nothing. A model review that blocks and stops nothing teaches everyone to ignore it.

## Before it is made required

- Run `tools/crew/setup-cloudshell.sh` and set the four repository variables. Until then the check fails on every push, which is correct but noisy.
- Enable the three Claude models, `gpt-oss-120b-maas` and `deepseek-v4.1-flash-maas` in Model Garden.
- Commits the crew and the reviewer push are made with `GITHUB_TOKEN`. Branch protection must let `github-actions[bot]` push to `intent-surface`, as the night shift already does.

## Order matters

Require `Review / review` only after the Google Cloud setup in `tools/crew/README.md` is done and the repository
variables are set. Until then the workflow runs its `not-live` job instead, says so in the run summary, and skips the
review job; GitHub counts a skipped required job as passing, so requiring it earlier would let every push through
with no review at all.
