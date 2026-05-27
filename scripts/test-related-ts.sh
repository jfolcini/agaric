#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Smart TypeScript test runner.
#
# Collects .ts/.tsx files from a configurable diff source and runs only
# the vitest tests that import (directly or transitively) those files.
# Skips entirely when no TypeScript files match.
#
# Diff sources:
#   --cached         (default; pre-commit use) — files in the git index
#   --range REVSPEC  (pre-push use) — files differing in a commit range,
#                    e.g. `--range @{upstream}..HEAD` or `--range main...HEAD`
#   --dry            preview which files would be tested (works with either)
#
# Usage:
#   scripts/test-related-ts.sh                              # pre-commit
#   scripts/test-related-ts.sh --range @{upstream}..HEAD    # pre-push
#   scripts/test-related-ts.sh --range main...HEAD --dry    # preview
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

SOURCE="--cached"
RANGE=""
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --cached)
      SOURCE="--cached"; shift ;;
    --range)
      SOURCE="--range"; RANGE="${2:-}"; shift 2
      [ -z "$RANGE" ] && { echo "ERROR: --range requires a revspec" >&2; exit 2; } ;;
    --dry)
      DRY=1; shift ;;
    *)
      echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ "$SOURCE" = "--cached" ]; then
  FILES=$(git diff --cached --name-only --diff-filter=ACMR -- '*.ts' '*.tsx' | grep -v 'src/lib/bindings\.ts$' || true)
  LABEL="staged"
else
  FILES=$(git diff "$RANGE" --name-only --diff-filter=ACMR -- '*.ts' '*.tsx' | grep -v 'src/lib/bindings\.ts$' || true)
  LABEL="range $RANGE"
fi

if [ -z "$FILES" ]; then
  echo "No $LABEL .ts/.tsx files — skipping vitest"
  exit 0
fi

FILE_COUNT=$(echo "$FILES" | wc -l)
echo "Running vitest related for $FILE_COUNT $LABEL TS file(s)…"

if [ "$DRY" = "1" ]; then
  echo "$FILES"
  exit 0
fi

# shellcheck disable=SC2086
npx vitest related --run --reporter=dot $FILES
