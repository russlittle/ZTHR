#!/usr/bin/env bash
# Checks the nightly factory run end to end, repairs what is missing, and starts a run now. Run in Cloud Shell:
#
#   bash <(curl -sL https://raw.githubusercontent.com/russlittle/ZTHR/reference-implementation/tools/nightly.sh)
#
# It reports the nightly trigger, its Cloud Scheduler job and the last nightly builds (with the step that failed),
# creates the schedule if it is missing, resumes it if it is paused, then starts the nightly through the scheduler,
# the same path it takes at 2:17 a.m., and prints the new build. It changes no permissions: if one is missing it
# says so, and tools/setup-gcp.sh grants it.
set -uo pipefail

PROJECT="${PROJECT:-zthr-ai}"
REGION="${REGION:-us-central1}"
CODE_BRANCH="${CODE_BRANCH:-reference-implementation}"
NIGHTLY_CRON="${NIGHTLY_CRON:-17 2 * * *}"
TZ_NAME="${TZ_NAME:-America/New_York}"
SA="zthr-factory@${PROJECT}.iam.gserviceaccount.com"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
gcloud config set project "$PROJECT" >/dev/null 2>&1

say "1/5 The nightly trigger"
TRIGGER_ID="$(gcloud builds triggers describe zthr-nightly --region "$REGION" --format='value(id)' 2>/dev/null)"
if [ -z "$TRIGGER_ID" ]; then
  echo "Missing. Run tools/setup-gcp.sh, which creates it, then run this again."
  exit 1
fi
gcloud builds triggers describe zthr-nightly --region "$REGION" --format='table(name,id,substitutions,disabled)'

say "2/5 The schedule"
RUN_URI="https://cloudbuild.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/triggers/${TRIGGER_ID}:run"
if ! gcloud scheduler jobs describe zthr-nightly --location "$REGION" >/dev/null 2>&1; then
  echo "Missing: creating it (${NIGHTLY_CRON}, ${TZ_NAME})."
  gcloud services enable cloudscheduler.googleapis.com
  gcloud scheduler jobs create http zthr-nightly --location "$REGION" --schedule "$NIGHTLY_CRON" --time-zone "$TZ_NAME" \
    --uri "$RUN_URI" --http-method POST --message-body "{\"source\":{\"branchName\":\"${CODE_BRANCH}\"}}" \
    --oauth-service-account-email "$SA" --description "Runs the zthr-nightly Cloud Build trigger"
fi
STATE="$(gcloud scheduler jobs describe zthr-nightly --location "$REGION" --format='value(state)')"
if [ "$STATE" = "PAUSED" ]; then
  echo "Paused: resuming it."
  gcloud scheduler jobs resume zthr-nightly --location "$REGION"
fi
URI_NOW="$(gcloud scheduler jobs describe zthr-nightly --location "$REGION" --format='value(httpTarget.uri)')"
if [ "$URI_NOW" != "$RUN_URI" ]; then
  echo "It points at another trigger (${URI_NOW}): pointing it at zthr-nightly."
  gcloud scheduler jobs update http zthr-nightly --location "$REGION" --uri "$RUN_URI"
fi
gcloud scheduler jobs describe zthr-nightly --location "$REGION" \
  --format='table(state,schedule,timeZone,lastAttemptTime,status.code,status.message)'
echo "(status.code is empty or 0 when the last attempt succeeded; 7 means the account it runs as lacks permission.)"

say "3/5 The last nightly builds"
gcloud builds list --region "$REGION" --filter="buildTriggerId=${TRIGGER_ID}" --limit 5 \
  --format='table(id,status,createTime.date(tz=America/New_York),duration(start=startTime,end=finishTime,precision=0):label=TOOK)'
LAST="$(gcloud builds list --region "$REGION" --filter="buildTriggerId=${TRIGGER_ID}" --limit 1 --format='value(id)')"
if [ -n "$LAST" ]; then
  echo
  echo "Steps of the last one:"
  gcloud builds describe "$LAST" --region "$REGION" --format='table(steps.id,steps.status,steps.timing.endTime)' 2>/dev/null ||
    gcloud builds describe "$LAST" --region "$REGION" --format='yaml(status,statusDetail,failureInfo)'
  gcloud builds describe "$LAST" --region "$REGION" --format='value(failureInfo.detail)'
fi

say "4/5 Start a nightly run now, through the scheduler"
gcloud scheduler jobs run zthr-nightly --location "$REGION"
sleep 45

say "5/5 The run it started"
NEW="$(gcloud builds list --region "$REGION" --filter="buildTriggerId=${TRIGGER_ID}" --limit 1 --format='value(id,status,createTime)')"
echo "$NEW"
case "$NEW" in
  "$LAST"*|"") echo "No new build appeared. The scheduler could not start the trigger: see status.code above, then run tools/setup-gcp.sh to restore permissions." ;;
  *) echo "Started. It takes a few hours. Follow it: https://console.cloud.google.com/cloud-build/builds;region=${REGION}/${NEW%%[[:space:]]*}?project=${PROJECT}" ;;
esac
