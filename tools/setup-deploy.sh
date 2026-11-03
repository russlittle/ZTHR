#!/usr/bin/env bash
# Lets the factory deploy the Student Advocate to Cloud Run after a passing build. Run once in Cloud Shell,
# after tools/setup-gcp.sh:
#
#   bash <(curl -sL https://raw.githubusercontent.com/russlittle/ZTHR/reference-implementation/tools/setup-deploy.sh)
#
# Safe to run again.
set -euo pipefail

PROJECT="${PROJECT:-zthr-ai}"
REGION="${REGION:-us-central1}"
BUILDER="zthr-factory@${PROJECT}.iam.gserviceaccount.com"
RUNTIME_NAME="zthr-advocate"
RUNTIME="${RUNTIME_NAME}@${PROJECT}.iam.gserviceaccount.com"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
exists() { "$@" >/dev/null 2>&1; }
retry() { local n=0; until "$@" >/dev/null; do n=$((n + 1)); [ "$n" -ge 12 ] && return 1; echo "  waiting for IAM to catch up..."; sleep 10; done; }

gcloud config set project "$PROJECT" >/dev/null

say "1/4 Enabling Cloud Run and Artifact Registry"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com

say "2/4 Image repository"
exists gcloud artifacts repositories describe zthr --location "$REGION" ||
  gcloud artifacts repositories create zthr --repository-format docker --location "$REGION" --description "ZTHR reference images"

say "3/4 Service accounts"
# The service runs as an account with no roles: it needs nothing from Google Cloud to serve the demo.
exists gcloud iam service-accounts describe "$RUNTIME" ||
  gcloud iam service-accounts create "$RUNTIME_NAME" --display-name "Student Advocate (runtime, no roles)"
# The factory may push images, deploy the one service, and run it as that account.
retry gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:${BUILDER}" --role roles/run.admin --condition None
retry gcloud artifacts repositories add-iam-policy-binding zthr --location "$REGION" --member "serviceAccount:${BUILDER}" --role roles/artifactregistry.writer
retry gcloud iam service-accounts add-iam-policy-binding "$RUNTIME" --member "serviceAccount:${BUILDER}" --role roles/iam.serviceAccountUser

say "4/4 Turning on deploys, then the first deploy"
gcloud builds triggers update github zthr-factory --region "$REGION" --update-substitutions _DEPLOY_BRANCH=reference-implementation >/dev/null
gcloud builds triggers update manual zthr-nightly --region "$REGION" --update-substitutions _DEPLOY_BRANCH=reference-implementation >/dev/null || true
gcloud builds triggers run zthr-factory --region "$REGION" --branch reference-implementation --format='value(metadata.build.id)' |
  sed "s#^#Build: https://console.cloud.google.com/cloud-build/builds;region=${REGION}/#;s#\$#?project=${PROJECT}#"
echo "When that build finishes, the service is live at its run.app address:"
echo "  gcloud run services describe advocate --region ${REGION} --format='value(status.url)'"
echo "Then merge the route-advocate-to-cloud-run branch on the site repo: zthr.ai/advocate and /twins will serve it."
