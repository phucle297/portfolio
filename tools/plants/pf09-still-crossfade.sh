#!/usr/bin/env bash
# Plant (negative control) for PF-09 QA M1: swap in the pre-fix still-crossfade.ts and check that
# the "every engine" regression test catches it on Firefox and WebKit (Chromium was never broken).
#
# Usage: [CHROME_PATH=/usr/bin/google-chrome] [E2E_PORT=4513] tools/plants/pf09-still-crossfade.sh
# Exit 0 = the plant was caught (firefox and webkit fail, chromium passes); 1 = not caught;
# 2 = cannot run (dirty file). The file is always restored from HEAD.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
F=src/_pages/home/lib/still-crossfade.ts
# main before PF-09's ff01b70 fix (6de618f); pinned so the plant stays valid after the merge.
REF=${PF09_PLANT_REF:-6de618f}
if ! git diff --quiet HEAD -- "$F"; then
  echo "plant: $F has local changes, refusing to overwrite" >&2
  exit 2
fi
trap 'git checkout HEAD -- "$F"' EXIT
git show "$REF:$F" > "$F" || exit 2
git diff --stat HEAD -- "$F"
LOG=$(mktemp)
bunx playwright test tests/e2e/reduced-motion-live.spec.ts -g "the current section.s still after a mid-visit switch, every engine" --reporter=list 2>&1 | tee "$LOG"
pass() { grep -qE "✓ .*every engine › $1: at p = 0.6 the Services still" "$LOG"; }
fail() { grep -qE "✘ .*every engine › $1: at p = 0.6 the Services still" "$LOG"; }
if pass chromium && fail firefox && fail webkit; then
  echo "plant: CAUGHT (chromium passes, firefox and webkit fail on the pre-fix still-crossfade.ts)"
  exit 0
fi
echo "plant: NOT CAUGHT (expected chromium ✓, firefox ✘, webkit ✘)" >&2
exit 1
