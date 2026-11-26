#!/usr/bin/env bash
# Invite someone to the tools on zthr.ai, pause them, or list who is invited. Run in Cloud Shell, as yourself.
#   bash intent/tools/invite.sh add person@example.com "Their name"
#   bash intent/tools/invite.sh pause person@example.com
#   bash intent/tools/invite.sh list
# It writes access/{email} in Firestore with your own Cloud Shell sign-in. Browsers can never write these documents.
set -euo pipefail
PROJECT="${PROJECT:-zthr-ai}"
API="https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents"
TOKEN="$(gcloud auth print-access-token)"
cmd="${1:-}"; email="$(printf '%s' "${2:-}" | tr '[:upper:]' '[:lower:]')"; name="${3:-}"
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; by="$(gcloud config get-value account 2>/dev/null)"
case "$cmd" in
  add|pause)
    [[ "$email" == *@*.* ]] || { echo "Give an email address." >&2; exit 2; }
    active=$([ "$cmd" = add ] && echo true || echo false)
    body=$(python3 -c 'import json,sys; a,n,b,t=sys.argv[1:]; print(json.dumps({"fields":{"active":{"booleanValue":a=="true"},"name":{"stringValue":n},"invitedBy":{"stringValue":b},"at":{"timestampValue":t}}}))' "$active" "$name" "$by" "$now")
    curl -sSf -X PATCH -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" "${API}/access/${email}" -d "$body" >/dev/null
    echo "${email}: $([ "$active" = true ] && echo invited || echo paused)";;
  list)
    curl -sSf -H "Authorization: Bearer ${TOKEN}" "${API}/access?pageSize=300" | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(x["name"].rsplit("/",1)[1], "invited" if x["fields"].get("active",{}).get("booleanValue") else "paused", x["fields"].get("name",{}).get("stringValue","")) for x in d.get("documents",[])]';;
  *) sed -n 2,6p "$0"; exit 2;;
esac
