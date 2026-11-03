#!/usr/bin/env bash
# Runs one walk in the pipeline, under coverage, unless nothing it executed last time has changed.
#   tools/walk-ci.sh <walk> <full> <command...>
# <walk> is explore, crawl or crawl-settings. <full> true walks regardless (the nightly run).
set -uo pipefail
walk="$1"; full="$2"; shift 2
if [ "$full" != "true" ]; then
  npx tsx tools/walk-coverage.ts needed "$walk" evidence-out/last
  [ $? -eq 10 ] && exit 0  # zthr:carry — walk-coverage wrote a report for this commit, carried from the last full walk
fi
set -e
rm -rf ".cov-$walk"
npx c8 --reporter=json --report-dir ".cov-$walk" --exclude-after-remap --include 'apps/**' --include 'packages/**' --include 'tools/**' "$@"
npx tsx tools/walk-coverage.ts record "$walk" ".cov-$walk/coverage-final.json"
