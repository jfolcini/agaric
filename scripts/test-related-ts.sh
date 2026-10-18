#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Smart TypeScript test runner.
#
# Collects .ts/.tsx/.mjs files from a configurable diff source and runs only
# the vitest tests that import (directly or transitively) those files.
# Skips entirely when nothing relevant changed.
#
# Two inputs reach tests with no import edge, so vitest's graph cannot see them:
# the shared conformance fixtures (`conformance/`) and the generated
# `src/lib/bindings.ts` (excluded from the file list: every IPC wrapper imports
# it, so it would select nearly everything). Tests read both through `fs`, so
# when either changes the script adds the tests that read it.
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
  DIFF=(git diff --cached)
  LABEL="staged"
else
  DIFF=(git diff "$RANGE")
  LABEL="range $RANGE"
fi

CHANGED=$("${DIFF[@]}" --name-only --diff-filter=ACMR -- '*.ts' '*.tsx' '*.mjs' 'conformance/' || true)
FILES=$(echo "$CHANGED" | grep -E '\.(ts|tsx|mjs)$' | grep -v 'src/lib/bindings\.ts$' || true)

# Test files that read `$1` (a path regex) through fs, found by content so a new
# reader is picked up without editing this list.
fs_readers() {
  { grep -rlE --include='*.test.ts' --include='*.test.tsx' -e "$1" src e2e-tauri 2>/dev/null || true; } |
    while read -r f; do
      if grep -qE 'readFileSync|readdirSync' "$f"; then echo "$f"; fi
    done
}

EXTRA=""
if grep -q '^conformance/' <<<"$CHANGED"; then
  EXTRA="$EXTRA
$(fs_readers "['\"/]conformance['\"/]")"
fi
if grep -q '^src/lib/bindings\.ts$' <<<"$CHANGED"; then
  EXTRA="$EXTRA
$(fs_readers "bindings\.ts['\"]")"
fi
EXTRA=$(echo "$EXTRA" | sed '/^$/d' | sort -u)
FILES=$(printf '%s\n%s\n' "$FILES" "$EXTRA" | sed '/^$/d' | sort -u)

if [ -z "$FILES" ]; then
  echo "No $LABEL .ts/.tsx/.mjs files — skipping vitest"
  exit 0
fi

FILE_COUNT=$(echo "$FILES" | wc -l)
echo "Running vitest related for $FILE_COUNT $LABEL file(s)…"
if [ -n "$EXTRA" ]; then
  echo "(includes $(echo "$EXTRA" | wc -l) test file(s) that read a changed fixture or bindings.ts through fs)"
fi

if [ "$DRY" = "1" ]; then
  echo "$FILES"
  exit 0
fi

# shellcheck disable=SC2086
npx vitest related --run --reporter=dot $FILES
