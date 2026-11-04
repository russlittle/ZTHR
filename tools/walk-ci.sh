#!/usr/bin/env bash
# One walk in the pipeline.   tools/walk-ci.sh <explore|crawl> <full: true nightly, false on a push>
#   Nightly: walk tonight's four students to a fixpoint under coverage (stale walks first, then the oldest), save each
#   student's walk with the lines it executed, and assemble this commit's report from every valid walk.
#   Push: if every student's saved walk is still valid, carry them forward; otherwise run the spot check.
set -uo pipefail
walk="$1"; full="$2"
case "$walk" in
  explore) run="npx tsx tools/explore.ts" ;;
  crawl) run="npx tsx tools/crawl.ts" ;;
  *) echo "unknown walk: $walk"; exit 2 ;;
esac
npx tsx tools/walk-rotation.ts plan "$walk" evidence-out/last 4
planned=$?
set -e
if [ "$full" = "true" ]; then
  names="Maria,Ana,Sam,Keisha"
  if [ -s "evidence-out/$walk-tonight.txt" ]; then names=$(cat "evidence-out/$walk-tonight.txt"); fi
  rm -rf ".cov-$walk"
  npx c8 --reporter=json --report-dir ".cov-$walk" --exclude-after-remap --include 'apps/**' --include 'packages/**' --include 'tools/**' $run "$names"
  npx tsx tools/walk-rotation.ts record "$walk" ".cov-$walk/coverage-final.json"
  npx tsx tools/walk-rotation.ts assemble "$walk" evidence-out/last
else
  if [ "$planned" -eq 10 ]; then
    npx tsx tools/walk-rotation.ts assemble "$walk" evidence-out/last; exit 0  # zthr:carry — every student's full walk is still valid; this commit's report is assembled from them
  fi
  $run Maria,Ana,Sam,Keisha --max 150
fi
