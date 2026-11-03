#!/usr/bin/env bash
# One-time setup of the ZTHR factory on Google Cloud Build. Run in Cloud Shell:
#
#   bash <(curl -sL https://raw.githubusercontent.com/russlittle/ZTHR/reference-implementation/tools/setup-gcp.sh)
#
# Safe to run again: every step checks before it creates. The only manual step is authorizing the
# Cloud Build GitHub App in your browser when the script prints the link.
set -euo pipefail

PROJECT="${PROJECT:-zthr-ai}"
REGION="${REGION:-us-central1}"
BUCKET="${BUCKET:-gs://${PROJECT}-evidence}"
REPO_URL="https://github.com/russlittle/ZTHR.git"
CODE_BRANCH="${CODE_BRANCH:-reference-implementation}"
CONNECTION="github"
REPO_NAME="zthr"
SA_NAME="zthr-factory"
BUDGET_USD="${BUDGET_USD:-100}"
NIGHTLY_CRON="${NIGHTLY_CRON:-17 2 * * *}"
TZ_NAME="${TZ_NAME:-America/New_York}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
exists() { "$@" >/dev/null 2>&1; }

gcloud config set project "$PROJECT" >/dev/null
NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
SA_PATH="projects/${PROJECT}/serviceAccounts/${SA}"
CB_AGENT="service-${NUMBER}@gcp-sa-cloudbuild.iam.gserviceaccount.com"
REPO_PATH="projects/${PROJECT}/locations/${REGION}/connections/${CONNECTION}/repositories/${REPO_NAME}"

if [ "$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null)" != "True" ]; then
  echo "Billing is not enabled on ${PROJECT}. Cloud Build needs it. List your accounts and link one, then run this again:"
  echo "  gcloud billing accounts list"
  echo "  gcloud billing projects link ${PROJECT} --billing-account=ACCOUNT_ID"
  exit 1
fi

say "1/8 Enabling APIs"
gcloud services enable cloudbuild.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com \
  storage.googleapis.com iam.googleapis.com billingbudgets.googleapis.com cloudbilling.googleapis.com

say "2/8 Build service account ${SA}"
exists gcloud iam service-accounts describe "$SA" ||
  gcloud iam service-accounts create "$SA_NAME" --display-name "ZTHR factory builds"
for role in roles/logging.logWriter roles/cloudbuild.builds.editor; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:${SA}" --role "$role" --condition None >/dev/null
done
# Cloud Scheduler runs the nightly trigger as this account, which must be allowed to act as itself.
gcloud iam service-accounts add-iam-policy-binding "$SA" --member "serviceAccount:${SA}" \
  --role roles/iam.serviceAccountUser >/dev/null
# The Cloud Build service agent stores the GitHub connection's token in Secret Manager.
gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:${CB_AGENT}" \
  --role roles/secretmanager.admin --condition None >/dev/null

say "3/8 Evidence bucket ${BUCKET}"
exists gcloud storage buckets describe "$BUCKET" ||
  gcloud storage buckets create "$BUCKET" --location "$REGION" --uniform-bucket-level-access
gcloud storage buckets add-iam-policy-binding "$BUCKET" --member "serviceAccount:${SA}" \
  --role roles/storage.objectAdmin >/dev/null

say "4/8 GitHub connection"
if ! exists gcloud builds connections describe "$CONNECTION" --region "$REGION"; then
  gcloud builds connections create github "$CONNECTION" --region "$REGION"
fi
stage() { gcloud builds connections describe "$CONNECTION" --region "$REGION" --format='value(installationState.stage)'; }
while [ "$(stage)" != "COMPLETE" ]; do
  gcloud builds connections describe "$CONNECTION" --region "$REGION" --format='value(installationState.actionUri,installationState.message)'
  echo "Open the link above, authorize Cloud Build, and install the app on russlittle/ZTHR only."
  read -r -p "Press Enter when done... " _
done
echo "Connection ready."

say "5/8 Linking the repository"
exists gcloud builds repositories describe "$REPO_NAME" --connection "$CONNECTION" --region "$REGION" ||
  gcloud builds repositories create "$REPO_NAME" --remote-uri "$REPO_URL" --connection "$CONNECTION" --region "$REGION"

say "6/8 Triggers"
# Every push to any branch except main (main is the website and has no factory).
exists gcloud builds triggers describe zthr-factory --region "$REGION" ||
  gcloud builds triggers create github --name zthr-factory --region "$REGION" --repository "$REPO_PATH" \
    --branch-pattern '^main$' --invert-regex --build-config cloudbuild.yaml --service-account "$SA_PATH" \
    --substitutions "_EVIDENCE_BUCKET=${BUCKET}" \
    --description "Gates, journeys, tests and UI walk on every push"
exists gcloud builds triggers describe zthr-nightly --region "$REGION" ||
  gcloud builds triggers create manual --name zthr-nightly --region "$REGION" --repository "$REPO_PATH" \
    --branch "$CODE_BRANCH" --build-config cloudbuild.yaml --service-account "$SA_PATH" \
    --substitutions "_EVIDENCE_BUCKET=${BUCKET},_MUTATION=true,_KIND=nightly" \
    --description "Full battery plus mutation testing, nightly"

say "7/8 Nightly schedule (${NIGHTLY_CRON} ${TZ_NAME})"
TRIGGER_ID="$(gcloud builds triggers describe zthr-nightly --region "$REGION" --format='value(id)')"
RUN_URI="https://cloudbuild.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/triggers/${TRIGGER_ID}:run"
exists gcloud scheduler jobs describe zthr-nightly --location "$REGION" ||
  gcloud scheduler jobs create http zthr-nightly --location "$REGION" --schedule "$NIGHTLY_CRON" --time-zone "$TZ_NAME" \
    --uri "$RUN_URI" --http-method POST --message-body "{\"source\":{\"branchName\":\"${CODE_BRANCH}\"}}" \
    --oauth-service-account-email "$SA" --description "Runs the zthr-nightly Cloud Build trigger"

say "8/8 Budget alert at \$${BUDGET_USD}/month"
BILLING="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' | sed 's#billingAccounts/##')"
if [ -z "$BILLING" ]; then
  echo "No billing account is linked to ${PROJECT}; link one, then run this script again."
elif gcloud billing budgets list --billing-account "$BILLING" --format='value(displayName)' 2>/dev/null | grep -qx "ZTHR factory"; then
  echo "Budget already exists."
else
  gcloud billing budgets create --billing-account "$BILLING" --display-name "ZTHR factory" \
    --budget-amount "${BUDGET_USD}USD" --filter-projects "projects/${PROJECT}" \
    --threshold-rule percent=0.5 --threshold-rule percent=0.9 --threshold-rule percent=1.0 ||
    echo "Could not create the budget (needs Billing Account Administrator); the factory works without it."
fi

say "Starting the first factory run on ${CODE_BRANCH}"
gcloud builds triggers run zthr-factory --region "$REGION" --branch "$CODE_BRANCH" --format='value(metadata.build.id)' |
  sed "s#^#Build: https://console.cloud.google.com/cloud-build/builds;region=${REGION}/#;s#\$#?project=${PROJECT}#"
echo "Done. Every push to a branch other than main now runs the factory; mutation runs nightly."
