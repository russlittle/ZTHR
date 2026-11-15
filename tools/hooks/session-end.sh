#!/usr/bin/env bash
# Run when an agent session in this repository ends (.claude/settings.json). A stale or unsourced public number
# blocks the end of the session with the reason, so it is fixed before anything is pushed (docs/testing/facts.md).
cd "$(dirname "$0")/../.." || exit 0
[ -d node_modules ] || exit 0
out=$(npx tsx tools/facts.ts --check 2>/dev/null | grep -E '^(STALE|UNMARKED)')
if [ -n "$out" ]; then
  echo "Public material states numbers that are stale or have no source. Run: npx tsx tools/facts.ts --write" >&2
  echo "$out" | head -10 >&2
  exit 2
fi
exit 0
