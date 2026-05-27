#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Smart Rust test runner.
#
# Collects .rs files from a configurable diff source, converts each
# path to a Rust module filter string, and runs only the matching tests
# via cargo nextest.
#
# Module mapping:  src-tauri/src/cache.rs           → cache
#                  src-tauri/src/commands/blocks.rs  → commands::blocks
#
# Skips: mod.rs, lib.rs, main.rs (no meaningful module filter).
#
# Full-suite fallback: if any matched file is lib.rs, main.rs, db.rs,
# error.rs, op.rs, or pagination.rs — these are foundational modules
# imported by nearly every test, so a targeted run would miss too much.
#
# Diff sources:
#   --cached         (default; pre-commit use) — files in the git index
#   --range REVSPEC  (pre-push use) — files differing in a commit range,
#                    e.g. `--range @{upstream}..HEAD` or `--range main...HEAD`
#   --dry            preview filter expressions (works with either)
#
# Usage:
#   scripts/test-related-rust.sh                              # pre-commit
#   scripts/test-related-rust.sh --range @{upstream}..HEAD    # pre-push
#   scripts/test-related-rust.sh --range main...HEAD --dry    # preview
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

# shellcheck disable=SC1091
. "$HOME/.cargo/env"

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
  STAGED_RS=$(git diff --cached --name-only --diff-filter=ACMR -- '*.rs' || true)
  LABEL="staged"
else
  STAGED_RS=$(git diff "$RANGE" --name-only --diff-filter=ACMR -- '*.rs' || true)
  LABEL="range $RANGE"
fi

if [ -z "$STAGED_RS" ]; then
  echo "No $LABEL .rs files — skipping cargo nextest"
  exit 0
fi

# ── Foundational files that trigger a full test run ──────────────────
# These modules are imported by nearly every test — targeted filtering
# would give a false sense of safety.
FALLBACK_PATTERNS="src-tauri/src/lib.rs src-tauri/src/main.rs src-tauri/src/db.rs src-tauri/src/error.rs src-tauri/src/op.rs src-tauri/src/pagination.rs"

for pat in $FALLBACK_PATTERNS; do
  if echo "$STAGED_RS" | grep -qx "$pat"; then
    echo "Foundational file in $LABEL set ($pat) — running full test suite"
    if [ "$DRY" = "1" ]; then
      echo "  → cargo nextest run (full)"
      exit 0
    fi
    cd src-tauri && exec cargo nextest run
  fi
done

# ── Build per-module filter expressions ──────────────────────────────
FILTERS=()
for file in $STAGED_RS; do
  # Only process files under src-tauri/src/
  case "$file" in
    src-tauri/src/*) ;;
    *) continue ;;
  esac

  basename=$(basename "$file")

  # Skip files that don't map to a useful module filter
  case "$basename" in
    mod.rs|lib.rs|main.rs) continue ;;
  esac

  # Strip prefix (src-tauri/src/) and suffix (.rs) → module path
  module="${file#src-tauri/src/}"
  module="${module%.rs}"
  # Convert / to :: for Rust module notation
  module=$(echo "$module" | sed 's|/|::|g')

  FILTERS+=("$module")
done

if [ ${#FILTERS[@]} -eq 0 ]; then
  echo "No filterable Rust modules staged — skipping"
  exit 0
fi

# Deduplicate filters
readarray -t FILTERS < <(printf '%s\n' "${FILTERS[@]}" | sort -u)

echo "Running cargo nextest for ${#FILTERS[@]} module(s) from $LABEL: ${FILTERS[*]}"

if [ "$DRY" = "1" ]; then
  for mod in "${FILTERS[@]}"; do
    echo "  → test(~$mod)"
  done
  exit 0
fi

# Build a single -E expression: test(~mod1) + test(~mod2) + …
#
# `--no-tests=pass` makes nextest exit 0 (not 4) if the filter matches 0
# tests. That's the legitimate case for cfg-gated modules (e.g.
# `sync_daemon::android_multicast` which is entirely
# `#[cfg(target_os = "android")]`) where a desktop run sees no compiled
# tests but the compile step itself is already covered by `cargo clippy`.
EXPR=""
for mod in "${FILTERS[@]}"; do
  if [ -z "$EXPR" ]; then
    EXPR="test(~$mod)"
  else
    EXPR="$EXPR + test(~$mod)"
  fi
done

cd src-tauri && exec cargo nextest run --no-tests=pass -E "$EXPR"
