# Running the factory on Google Cloud Build

The tests, gates, journeys and the UI walk run on Google Cloud Build, not on GitHub. GitHub only hosts the code.
The GitHub workflow is manual-only, so a push never starts GitHub-hosted compute.

`cloudbuild.yaml` runs, in order: install, typecheck, unit tests, gates (prove then run), journeys plus the
Playwright walk with accessibility checks, and mutation testing (nightly only). It then records the run's compute
cost, builds the evidence page, and uploads the evidence to a Cloud Storage bucket. Any failing step fails the build.

## One-time setup (project `zthr-ai`)

1. Enable Cloud Build:
   `gcloud services enable cloudbuild.googleapis.com --project zthr-ai`
2. Connect the GitHub repository: Cloud Build → Repositories (2nd gen) → Create host connection → GitHub,
   install the Google Cloud Build GitHub App on `russlittle/zthr` only, then link the repository.
3. Push trigger (every push to any branch):

   ```sh
   gcloud builds triggers create github --project zthr-ai --region us-central1 \
     --name zthr-factory --repository projects/zthr-ai/locations/us-central1/connections/github/repositories/russlittle-zthr \
     --branch-pattern '.*' --build-config cloudbuild.yaml
   ```

   Add a second trigger with `--pull-request-pattern '.*'` if you want pull requests checked before merge.
4. Nightly mutation run: create a manual trigger with `_MUTATION=true` and `_KIND=nightly`, then schedule it.

   ```sh
   gcloud builds triggers create manual --project zthr-ai --region us-central1 \
     --name zthr-nightly --repository projects/zthr-ai/locations/us-central1/connections/github/repositories/russlittle-zthr \
     --branch main --build-config cloudbuild.yaml --substitutions _MUTATION=true,_KIND=nightly
   ```

   In Cloud Build → Triggers → zthr-nightly → Run on schedule, choose a nightly time.
5. Keep evidence and the cost history. Create a bucket and set `_EVIDENCE_BUCKET=gs://<bucket>` on both triggers:

   ```sh
   gcloud storage buckets create gs://zthr-ai-evidence --project zthr-ai --location us-central1
   ```

   Grant the Cloud Build service account Storage Object Admin on that bucket. Without a bucket the build still
   passes or fails the same way, but the published cost covers only the current run.

Run once by hand from a checkout: `gcloud builds submit --project zthr-ai --config cloudbuild.yaml .`

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
