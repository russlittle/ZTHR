#!/usr/bin/env bash
# One-time Google Cloud setup for the ZTHR crew, to run in Cloud Shell (https://shell.cloud.google.com) as the
# project owner. It makes a service account that can call Vertex AI models and nothing else, and lets GitHub Actions
# in russlittle/ZTHR (branches intent-surface and main only) act as it through Workload Identity Federation, so no
# key is ever created or stored. Safe to run again: each step checks before it creates.
#
#   bash tools/crew/setup-cloudshell.sh <project-id> [daily-budget-usd]
#
# It prints the four GitHub repository variables to set at the end. It changes nothing outside the one project
# except, if you confirm, a billing budget alert on the project's billing account.
set -euo pipefail

PROJECT="${1:-${GOOGLE_CLOUD_PROJECT:-}}"
DAILY_USD="${2:-5}"
REPO="russlittle/ZTHR"
SA_NAME="zthr-crew"
POOL="github"
PROVIDER="zthr"
BUDGET_NAME="zthr-crew"

if [ -z "$PROJECT" ]; then
  echo "usage: bash tools/crew/setup-cloudshell.sh <project-id> [daily-budget-usd]" >&2
  exit 2
fi
if ! [[ "$DAILY_USD" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "daily budget must be a number of US dollars, got: $DAILY_USD" >&2
  exit 2
fi
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
step() { printf '\n== %s\n' "$*"; }

step "1. Work in project $PROJECT"
# Every later gcloud command uses this project unless told otherwise.
gcloud config set project "$PROJECT" >/dev/null
# The project number is needed for the federated identity's name.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
echo "project number $PROJECT_NUMBER"

step "2. Enable the APIs"
# aiplatform: Vertex AI, where the Claude, Gemini and open models are served.
# iam, iamcredentials, sts: Workload Identity Federation (exchange GitHub's token for a short-lived Google one).
# billingbudgets: only for the budget alert in step 8.
gcloud services enable aiplatform.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com billingbudgets.googleapis.com

step "3. A service account that can call models and nothing else"
# Created once; the crew and the reviewers run as this account.
if ! gcloud iam service-accounts describe "$SA" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" --display-name="ZTHR crew (Vertex AI inference only)" --description="Used by GitHub Actions in $REPO through Workload Identity Federation. roles/aiplatform.user only."
else
  echo "exists: $SA"
fi
# roles/aiplatform.user carries aiplatform.endpoints.predict, which is what calling a model needs. No other role is
# granted: the account cannot read storage, change IAM, or deploy anything. Adding the same binding again is a no-op.
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" --role="roles/aiplatform.user" --condition=None >/dev/null
echo "granted roles/aiplatform.user to $SA"

step "4. A Workload Identity pool for GitHub Actions"
# A pool holds external identities; this one holds only GitHub's.
if ! gcloud iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub Actions"
else
  echo "exists: pool $POOL"
fi

step "5. An OIDC provider that trusts only $REPO on intent-surface and main"
# GitHub's numeric ids survive a rename and cannot be reused by someone who later takes the name, so the condition
# pins them when GitHub reports them (a public repository needs no login for this lookup).
META="$(curl -fsS -m 20 "https://api.github.com/repos/$REPO" 2>/dev/null || true)"
REPO_ID="$(printf '%s' "$META" | jq -r '.id // empty' 2>/dev/null || true)"
OWNER_ID="$(printf '%s' "$META" | jq -r '.owner.id // empty' 2>/dev/null || true)"
FULL_NAME="$(printf '%s' "$META" | jq -r '.full_name // empty' 2>/dev/null || true)"
REFS="['refs/heads/intent-surface', 'refs/heads/main']"
if [ -n "$REPO_ID" ] && [ -n "$OWNER_ID" ]; then
  CONDITION="assertion.repository_id == '$REPO_ID' && assertion.repository_owner_id == '$OWNER_ID' && assertion.repository == '$FULL_NAME' && assertion.ref in $REFS"
  MEMBER="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository_id/$REPO_ID"
else
  echo "could not read the repository's ids from GitHub; pinning by name only"
  CONDITION="assertion.repository == '$REPO' && assertion.ref in $REFS"
  MEMBER="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository/$REPO"
fi
# The mapping copies claims from GitHub's token into attributes the condition and the binding can name. A token from
# any other repository, or from any other branch (a pull request, a fork, a tag), fails the condition and gets nothing.
MAPPING="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref"
if ! gcloud iam workload-identity-pools providers describe "$PROVIDER" --location=global --workload-identity-pool="$POOL" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --location=global --workload-identity-pool="$POOL" \
    --display-name="GitHub $REPO" --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="$MAPPING" --attribute-condition="$CONDITION"
else
  # Re-running brings an existing provider to the same mapping and condition.
  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER" --location=global --workload-identity-pool="$POOL" \
    --attribute-mapping="$MAPPING" --attribute-condition="$CONDITION"
fi
echo "condition: $CONDITION"

step "6. Let identities from that provider act as the service account"
# roles/iam.workloadIdentityUser on the service account (not on the project) lets the federated identities from this
# repository impersonate exactly this one account. Adding the same binding again is a no-op.
gcloud iam service-accounts add-iam-policy-binding "$SA" --role="roles/iam.workloadIdentityUser" --member="$MEMBER" >/dev/null
echo "bound $MEMBER"

WIF_PROVIDER="projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"

step "7. Enable the models in Model Garden (by hand, once)"
# Partner and open models must be enabled per project in the console, and Anthropic's need their terms accepted.
# Gemini needs no enabling. The crew uses these, all on the global endpoint:
cat <<EOF
  Open https://console.cloud.google.com/vertex-ai/model-garden?project=$PROJECT and enable:
    Anthropic   claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5
    OpenAI      gpt-oss-120b-maas            (open model, MaaS)
    DeepSeek    deepseek-v4.1-flash-maas     (open model, MaaS)
  Gemini        gemini-3.5-flash-lite, gemini-3.8-flash: available without enabling
  Not needed    qwen3-coder-480b-a35b-instruct-maas was retired on 2026-10-21.
  If an organisation policy restricts endpoints (constraints/gcp.restrictEndpointUsage), allow the global endpoint.
EOF

step "8. A billing budget alert"
# A budget alert emails the billing admins at 50%, 90% and 100% of a monthly amount (31 days of the daily budget).
# It does not stop spending; the crew's own daily budget (CREW_DAILY_BUDGET_USD) does that.
MONTHLY_USD="$(awk -v d="$DAILY_USD" 'BEGIN { printf "%.0f", d * 31 }')"
BILLING="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' | sed 's|^billingAccounts/||')"
if [ -z "$BILLING" ]; then
  echo "the project has no billing account; link one, then run this script again"
elif gcloud billing budgets list --billing-account="$BILLING" --format='value(displayName)' 2>/dev/null | grep -qx "$BUDGET_NAME"; then
  echo "exists: budget $BUDGET_NAME on billing account $BILLING"
else
  read -r -p "Create a ${MONTHLY_USD} USD/month budget alert for $PROJECT on billing account $BILLING? [y/N] " yes
  if [ "${yes:-}" = y ] || [ "${yes:-}" = Y ]; then
    gcloud billing budgets create --billing-account="$BILLING" --display-name="$BUDGET_NAME" \
      --budget-amount="${MONTHLY_USD}USD" --filter-projects="projects/$PROJECT" \
      --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0
  else
    echo "skipped; the command is:"
    echo "  gcloud billing budgets create --billing-account=$BILLING --display-name=$BUDGET_NAME --budget-amount=${MONTHLY_USD}USD --filter-projects=projects/$PROJECT --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0"
  fi
fi

step "9. Set these GitHub repository variables (Settings > Secrets and variables > Actions > Variables)"
# They are identifiers, not secrets: none of them grants anything without a token from this repository.
cat <<EOF
  GCP_PROJECT            $PROJECT
  GCP_WIF_PROVIDER       $WIF_PROVIDER
  GCP_SERVICE_ACCOUNT    $SA
  CREW_DAILY_BUDGET_USD  $DAILY_USD

  or, with the GitHub CLI:
    gh variable set GCP_PROJECT --repo $REPO --body '$PROJECT'
    gh variable set GCP_WIF_PROVIDER --repo $REPO --body '$WIF_PROVIDER'
    gh variable set GCP_SERVICE_ACCOUNT --repo $REPO --body '$SA'
    gh variable set CREW_DAILY_BUDGET_USD --repo $REPO --body '$DAILY_USD'
EOF
echo
echo "Done. Then run the Crew workflow by hand with dry_run ticked to see what it would hand out."
