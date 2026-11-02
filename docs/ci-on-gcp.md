# Running the factory on Google Cloud Build

The tests, gates, journeys and the UI walk run on Google Cloud Build, not on GitHub. GitHub only hosts the code.
The GitHub workflow is manual-only, so a push never starts GitHub-hosted compute.

`cloudbuild.yaml` runs, in order: install, typecheck, unit tests, gates (prove then run), journeys, the
Playwright walk with accessibility checks, and mutation testing (nightly only). It then records the run's compute
cost, builds the evidence page, and uploads the evidence to a Cloud Storage bucket. Any failing step fails the build.

## One-time setup

Open [Cloud Shell](https://console.cloud.google.com/cloudshell) signed in to the account that owns `zthr-ai` and run:

```sh
bash <(curl -sL https://raw.githubusercontent.com/russlittle/ZTHR/reference-implementation/tools/setup-gcp.sh)
```

`tools/setup-gcp.sh` is safe to run again; each step checks before it creates. It:

1. Enables Cloud Build, Secret Manager, Cloud Scheduler, Storage and the billing budget APIs.
2. Creates a build service account, `zthr-factory`, with only log writing, build running and the evidence bucket.
3. Creates the evidence bucket `gs://zthr-ai-evidence`, which holds each run's evidence and cost record.
4. Connects GitHub. This is the one manual step: the script prints a link, you authorize Cloud Build and install
   its app on `russlittle/ZTHR` only, then press Enter.
5. Links the repository.
6. Creates two triggers. `zthr-factory` runs on every push to any branch except `main`, which holds the website.
   `zthr-nightly` runs the same build plus mutation testing.
7. Schedules `zthr-nightly` for 2:17 a.m. Eastern with Cloud Scheduler.
8. Sets a $100-a-month budget alert on the project, with emails at 50%, 90% and 100%.

It finishes by starting the first run and printing its link. Defaults can be changed with environment variables
(`PROJECT`, `REGION`, `BUCKET`, `CODE_BRANCH`, `BUDGET_USD`, `NIGHTLY_CRON`, `TZ_NAME`).

Run a build by hand from a checkout: `gcloud builds submit --project zthr-ai --config cloudbuild.yaml .`

## Cost

The build runs on an 8-vCPU machine (`E2_HIGHCPU_8`) so the suite and the nightly mutation run finish quickly.
Its list price is $0.0156 a build-minute ([Cloud Build pricing](https://cloud.google.com/build/pricing)); the free
monthly minutes apply only to the smaller default machine, so every run is billed.

Each run measures itself. `tools/ci-cost.ts` takes the minutes from the first step to the cost step, multiplies them
by the dated rate in `control/ci-rates.json`, and stores one record per run in the bucket (`costs/<build>.json`). The
evidence page publishes the run count, the last 30 days, the all-time total, the average run length and this run's
cost. Costs are at list price with no free tier subtracted. The evidence page and upload after the cost step are not
counted. When Google changes the price, update `control/ci-rates.json` with the new rate and date.

To switch machines, change `machineType` in `cloudbuild.yaml` and `CI_MACHINE` in its cost step together, and make
sure the machine has a rate in `control/ci-rates.json`; the cost step refuses a machine with no dated rate.

## Model review

Model review is optional and is not part of this build. To run it, set `REVIEW_API_KEY` (and `REVIEW_BASE_URL` for
any OpenAI-compatible provider) and run `npx tsx tools/review.ts --base HEAD~1`.
