#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Smart Rust test runner for pre-commit.
#
# Collects staged .rs files from the git index, converts each path to
# a Rust module filter string, and runs only the matching tests via
# cargo nextest.
#
# Module mapping:  src-tauri/src/cache.rs           → cache
#                  src-tauri/src/commands/blocks.rs  → commands::blocks
#
# Skips: mod.rs, lib.rs, main.rs (no meaningful module filter).
#
# Full-suite fallback: if any staged file is lib.rs, main.rs, db.rs,
# error.rs, or op.rs — these are foundational modules imported by
# nearly every test, so a targeted run would miss too much.
#
# Usage:  scripts/test-related-rust.sh          (called by prek hook)
#         scripts/test-related-rust.sh --dry    (preview filter expressions)
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

# shellcheck disable=SC1091
. "$HOME/.cargo/env"

STAGED_RS=$(git diff --cached --name-only --diff-filter=ACMR -- '*.rs' || true)

if [ -z "$STAGED_RS" ]; then
  echo "No staged .rs files — skipping cargo nextest"
  exit 0
fi

# ── Foundational files that trigger a full test run ──────────────────
# These modules are imported by nearly every test — targeted filtering
# would give a false sense of safety.
FALLBACK_PATTERNS="src-tauri/src/lib.rs src-tauri/src/main.rs src-tauri/src/db.rs src-tauri/src/error.rs src-tauri/src/op.rs src-tauri/src/pagination.rs"

for pat in $FALLBACK_PATTERNS; do
  if echo "$STAGED_RS" | grep -qx "$pat"; then
    echo "Foundational file staged ($pat) — running full test suite"
    if [ "${1:-}" = "--dry" ]; then
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

echo "Running cargo nextest for ${#FILTERS[@]} module(s): ${FILTERS[*]}"

if [ "${1:-}" = "--dry" ]; then
  for mod in "${FILTERS[@]}"; do
    echo "  → test(~$mod)"
  done
  exit 0
fi

# Build a single -E expression: test(~mod1) + test(~mod2) + …
EXPR=""
for mod in "${FILTERS[@]}"; do
  if [ -z "$EXPR" ]; then
    EXPR="test(~$mod)"
  else
    EXPR="$EXPR + test(~$mod)"
  fi
done

cd src-tauri && exec cargo nextest run -E "$EXPR"
