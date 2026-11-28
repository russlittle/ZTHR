#!/usr/bin/env bash
# Runs a command as the calling user inside a new network namespace that has only loopback, so code a model wrote
# (a test, a fix) cannot reach the network while the gate runs it. Needs password-less sudo, as GitHub's hosted
# runners have. Used as CREW_ACCEPT_PREFIX="bash tools/crew/no-network.sh".
set -euo pipefail
user=$(id -un)
# shellcheck disable=SC2016 # $0 and $@ belong to the inner shell
exec sudo -n -E unshare --net -- bash -c 'ip link set lo up 2>/dev/null || true; exec sudo -n -E -u "$0" -- "$@"' "$user" "$@"
