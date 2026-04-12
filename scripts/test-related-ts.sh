#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Smart TypeScript test runner for pre-commit.
#
# Collects staged .ts/.tsx files from the git index and runs only the
# vitest tests that import (directly or transitively) those files.
# Skips entirely when no TypeScript files are staged.
#
# Usage:  scripts/test-related-ts.sh          (called by prek hook)
#         scripts/test-related-ts.sh --dry    (preview which files would be tested)
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

STAGED_TS=$(git diff --cached --name-only --diff-filter=ACMR -- '*.ts' '*.tsx' | grep -v 'src/lib/bindings\.ts$' || true)

if [ -z "$STAGED_TS" ]; then
  echo "No staged .ts/.tsx files — skipping vitest"
  exit 0
fi

FILE_COUNT=$(echo "$STAGED_TS" | wc -l)
echo "Running vitest related for $FILE_COUNT staged TS file(s)…"

if [ "${1:-}" = "--dry" ]; then
  echo "$STAGED_TS"
  exit 0
fi

# shellcheck disable=SC2086
npx vitest related --run --reporter=dot $STAGED_TS
