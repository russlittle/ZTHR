# Running the factory on Google Cloud Build

The tests, gates, journeys and the UI walk run on Google Cloud Build, not on GitHub. GitHub only hosts the code.
The GitHub workflow is manual-only, so a push never starts GitHub-hosted compute.

`cloudbuild.yaml` runs, in order: install, typecheck, unit tests, gates (prove then run), journeys plus the
evidence page, the Playwright walk with accessibility checks, mutation testing (nightly only), and an optional
upload of the evidence to a Cloud Storage bucket. Any failing step fails the build.

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
4. Nightly mutation run: create a manual trigger with `_MUTATION=true`, then a Cloud Scheduler job that runs it.

   ```sh
   gcloud builds triggers create manual --project zthr-ai --region us-central1 \
     --name zthr-nightly --repository projects/zthr-ai/locations/us-central1/connections/github/repositories/russlittle-zthr \
     --branch main --build-config cloudbuild.yaml --substitutions _MUTATION=true
   ```

   In Cloud Build → Triggers → zthr-nightly → Run on schedule, choose a nightly time.
5. Optional: keep evidence. Create a bucket and set `_EVIDENCE_BUCKET=gs://<bucket>` on the triggers.

Run once by hand from a checkout: `gcloud builds submit --project zthr-ai --config cloudbuild.yaml .`

## Cost

The build uses the default e2-standard-2 machine. Cloud Build's free tier covers 2,500 build-minutes a month on
that machine per billing account; after that it is $0.006 a minute
([Cloud Build pricing](https://cloud.google.com/build/pricing)). A full run is a few minutes; the nightly mutation
run is the longest step.

## Model review

Model review is optional and is not part of this build. To run it, set `REVIEW_API_KEY` (and `REVIEW_BASE_URL` for
any OpenAI-compatible provider) and run `npx tsx tools/review.ts --base HEAD~1`.
