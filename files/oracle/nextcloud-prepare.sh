#!/usr/bin/env bash
# Prepares the stock Nextcloud service container of the first-article workflow, inside a GitHub runner only:
# waits until status.php says installed: true, makes new accounts start empty (no skeleton or template files,
# so the oracle's "empty root" step means the same on both servers), and adds one account.
#
#   files/oracle/nextcloud-prepare.sh <container id> <base url> <user> <password>
#
# Writes the image's resolved digest and the server's status to the job summary, and NEXTCLOUD_IMAGE_RESOLVED to
# GITHUB_ENV when it runs in Actions.
set -euo pipefail
nc="$1" base="$2" user="$3" pass="$4"
summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
here="$(cd "$(dirname "$0")/.." && pwd)"

if ! node "$here/tools/first-article.ts" wait "$base" 900; then
  { echo '### Nextcloud did not become ready'; echo '```'; docker logs --tail 80 "$nc" 2>&1; echo '```'; } >> "$summary"
  exit 1
fi
occ() { docker exec -u www-data "$nc" php occ "$@"; }
occ config:system:set skeletondirectory --value=''
occ config:system:set templatedirectory --value=''
docker exec -u www-data -e OC_PASS="$pass" "$nc" php occ user:add --password-from-env --display-name="$user" "$user"

image_id="$(docker inspect --format '{{.Image}}' "$nc")"
resolved="$(docker image inspect --format '{{join .RepoDigests " "}}' "$image_id")"
status="$(curl -fsS "$base/status.php")"
{
  echo '### Reference server'
  echo
  echo "| | |"
  echo "| --- | --- |"
  echo "| Image digest | \`$resolved\` |"
  echo "| status.php | \`$status\` |"
  echo "| Account | \`$user\`, starts empty |"
  echo
} >> "$summary"
if [ -n "${GITHUB_ENV:-}" ]; then echo "NEXTCLOUD_IMAGE_RESOLVED=${resolved%% *}" >> "$GITHUB_ENV"; fi
