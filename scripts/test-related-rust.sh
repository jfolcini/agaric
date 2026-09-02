#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Smart Rust test runner.
#
# Collects .rs files from a configurable diff source, converts each
# path to a nextest filter atom, and runs only the matching tests
# via cargo nextest.
#
# Two mapping tiers (#3220):
#
#   1. `src-tauri/src/**` — the app crate (`agaric`). Precise
#      path→module mapping, unchanged:
#        src-tauri/src/cache.rs           → test(~cache)
#        src-tauri/src/commands/blocks.rs → test(~commands::blocks)
#      Skips mod.rs, lib.rs, main.rs (no meaningful module filter).
#
#   2. Any other workspace member (agaric-core / agaric-store /
#      agaric-engine / agaric-sync / agaric-observability /
#      agaric-diagnostics, …) — coarse *package* mapping:
#        src-tauri/agaric-engine/src/apply/kernel.rs
#          → package(agaric-engine)
#      Before #3220 these files matched no `case` arm at all, produced
#      an empty filter list, and the hook exited 0 having run ZERO
#      tests — 2087 of the workspace's ~5452 tests had no local gate.
#      Package granularity is deliberately coarser than a per-module
#      map: the six crates do not share the app crate's layout, and a
#      wrong module guess re-creates the same false-green this fixes.
#      Running a crate's whole suite is strictly better than nothing.
#
#      The crate list is derived from `cargo metadata`, never
#      hardcoded, so a new workspace member is covered the day it is
#      added (note `diagnostics/` ships the package `agaric-diagnostics`
#      — directory name and package name are not interchangeable).
#
#   3. Anything else (`src-tauri/build.rs`, `src-tauri/benches/**`,
#      `src-tauri/fuzz/**`, strays outside the workspace) — reported
#      LOUDLY as unmapped. "I found nothing relevant" and "I found
#      something relevant and could not map it" must not look alike.
#
# Package filters force `--workspace` (#3212): a bare `cargo nextest
# run` from src-tauri/ is package-scoped to `agaric`, so
# `-E "package(agaric-engine)"` alone would silently match 0 tests.
# The `src-tauri/src/**`-only path keeps the historical bare form.
#
# Full-suite fallback: changes to the app entry/library files, the db module,
# agaric-core's error type, agaric-store's op definitions, or its pagination
# module force the whole workspace suite. These are foundational modules
# imported by broad test surfaces, so a targeted run would miss too much.
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

if ! REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
  echo "ERROR: test-related-rust.sh must run inside a Git worktree." >&2
  exit 2
fi
REPO_ROOT=$(cd "$REPO_ROOT" && pwd -P)
# Which cargo the hook runs. Hardcoded, not `${CARGO_BIN:-cargo}` (#3431): an
# ambient `CARGO_BIN` in a developer's shell or on a runner would silently
# redirect the gate to a different binary, and a gate that can be pointed
# elsewhere by an unrelated environment variable is not a gate.
CARGO_BIN=cargo

# ── Foundational targets that force the full workspace suite ─────────
# A trailing slash declares a directory target and matches every file below
# that path. File targets match exactly. Keeping the kind in the spelling makes
# prefix matching path-segment-aware: `src/db/` matches `src/db/pool.rs`, but
# never `src/db_extra.rs`; `src/op.rs` never matches `src/op.rs_extra.rs`.
FALLBACK_TARGETS=(
  "src-tauri/src/lib.rs"
  "src-tauri/src/main.rs"
  "src-tauri/src/db/"
  "src-tauri/agaric-core/src/error.rs"
  "src-tauri/agaric-store/src/op.rs"
  "src-tauri/agaric-store/src/pagination/"
)

validate_fallback_targets() {
  local target resolved failed=0

  for target in "${FALLBACK_TARGETS[@]}"; do
    case "$target" in
      */)
        resolved="$REPO_ROOT/${target%/}"
        if [ ! -d "$resolved" ]; then
          echo "ERROR: configured Rust fallback directory is missing: $target" >&2
          failed=1
        fi
        ;;
      *)
        resolved="$REPO_ROOT/$target"
        if [ ! -f "$resolved" ]; then
          echo "ERROR: configured Rust fallback file is missing: $target" >&2
          failed=1
        fi
        ;;
    esac
  done

  if [ "$failed" -ne 0 ]; then
    echo "ERROR: update FALLBACK_TARGETS after moving a foundational Rust path." >&2
    return 1
  fi
}

FALLBACK_MATCH=""
matches_fallback_target() { # <repo-relative-file>
  local file="$1" target
  FALLBACK_MATCH=""
  for target in "${FALLBACK_TARGETS[@]}"; do
    case "$target" in
      */)
        case "$file" in
          "$target"*) FALLBACK_MATCH="$target"; return 0 ;;
        esac
        ;;
      *)
        if [ "$file" = "$target" ]; then
          FALLBACK_MATCH="$target"
          return 0
        fi
        ;;
    esac
  done
  return 1
}

# ── Workspace crate roots, derived from cargo metadata ───────────────
# Emits one "<repo-relative-crate-dir> <package-name>" line per
# workspace member, EXCLUDING the workspace-root package (`agaric`,
# whose directory is `src-tauri/` itself and would therefore swallow
# every path below it).
#
# Derived rather than hardcoded so the mapping cannot rot when a crate
# is added to `[workspace].members`; a hardcoded array is precisely how
# the pre-#3220 blind spot survived six crate extractions.
crate_roots() {
  local manifest meta
  manifest="$REPO_ROOT/src-tauri/Cargo.toml"
  [ -f "$manifest" ] || return 1

  # --offline first (hooks must not reach the network); fall back to a
  # networked resolve only if the lockfile is incomplete.
  meta=$("$CARGO_BIN" metadata --manifest-path "$manifest" --no-deps \
           --format-version 1 --offline 2>/dev/null) \
    || meta=$("$CARGO_BIN" metadata --manifest-path "$manifest" --no-deps \
           --format-version 1 2>/dev/null) \
    || return 1

  printf '%s' "$meta" | python3 -c "
import json, os, sys
meta = json.load(sys.stdin)
ws = os.path.realpath(meta['workspace_root'])
for pkg in meta['packages']:
    d = os.path.dirname(pkg['manifest_path'])
    if os.path.realpath(d) == ws:
        continue
    print(os.path.relpath(d, sys.argv[1]), pkg['name'])
" "$REPO_ROOT"
}

CRATE_MAP=""
CRATE_MAP_LOADED=0
load_crate_map() {
  if [ "$CRATE_MAP_LOADED" = "1" ]; then
    return 0
  fi
  CRATE_MAP_LOADED=1
  CRATE_MAP=$(crate_roots || true)
}

# Validate the REAL checkout before any selection work.
if ! validate_fallback_targets; then
  exit 1
fi

STAGED_RS=()
if [ "$SOURCE" = "--cached" ]; then
  mapfile -d '' -t STAGED_RS < <(
    git -C "$REPO_ROOT" diff --cached --name-only -z --diff-filter=ACMR -- '*.rs' || true
  )
  LABEL="staged"
else
  mapfile -d '' -t STAGED_RS < <(
    git -C "$REPO_ROOT" diff "$RANGE" --name-only -z --diff-filter=ACMR -- '*.rs' || true
  )
  LABEL="range $RANGE"
fi

if [ ${#STAGED_RS[@]} -eq 0 ]; then
  echo "No $LABEL .rs files — skipping cargo nextest"
  exit 0
fi

# Check the changed files against exact-file and path-bounded directory targets
# before module/package filtering. This ensures foundational mod.rs files are
# escalated instead of being skipped by the non-filterable basename rule below.
for file in "${STAGED_RS[@]}"; do
  if matches_fallback_target "$file"; then
    echo "Foundational file in $LABEL set ($file matches $FALLBACK_MATCH) — running full test suite"
    if [ "$DRY" = "1" ]; then
      echo "  → cargo nextest run --workspace (full)"
      exit 0
    fi
    # --workspace (#3212): the bare form is package-scoped to `agaric` only and
    # silently skips agaric-core/store/engine/sync/observability/diagnostics —
    # exactly the workspace members a foundational-file change (error.rs lives
    # in agaric-core) needs to re-verify.
    cd "$REPO_ROOT/src-tauri" && exec "$CARGO_BIN" nextest run --workspace
  fi
done

# ── Build filter atoms ───────────────────────────────────────────────
MODULE_FILTERS=()
PKG_FILTERS=()
UNMAPPED=()
NEED_SPECTA=0
for file in "${STAGED_RS[@]}"; do
  case "$file" in
    src-tauri/src/*)
      # Any commands/*.rs change can alter the specta surface; the
      # checked-in src/lib/bindings.ts must be regenerated in the same
      # commit or `specta_tests::ts_bindings_up_to_date` (src-tauri/src/
      # lib.rs) fails in CI ~15 min later. Pull that test into the
      # related-set here so the drift surfaces at commit time (#818).
      case "$file" in
        src-tauri/src/commands/*) NEED_SPECTA=1 ;;
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
      module="${module//\//::}"

      MODULE_FILTERS+=("$module")
      continue
      ;;
  esac

  # Outside src-tauri/src/ (#3220): map the file to its owning
  # workspace member and select that package wholesale.
  load_crate_map
  crate=""
  while read -r crate_dir crate_name; do
    [ -n "$crate_dir" ] || continue
    case "$file" in
      "$crate_dir"/*) crate="$crate_name"; break ;;
    esac
  done <<< "$CRATE_MAP"

  if [ -n "$crate" ]; then
    PKG_FILTERS+=("$crate")
  else
    UNMAPPED+=("$file")
  fi
done

# Bindings-drift guard (#818): commands/ changed → also run the
# specta bindings-up-to-date test.
if [ "$NEED_SPECTA" = "1" ]; then
  MODULE_FILTERS+=("specta_tests")
fi

# ── Report unmappable Rust changes loudly (#3220) ────────────────────
# Silence here used to be indistinguishable from "nothing relevant
# changed". These files ARE relevant Rust changes the selector could
# not translate into a filter, so say so, by name, on stderr.
if [ ${#UNMAPPED[@]} -gt 0 ]; then
  {
    echo ""
    echo "──────────────────────────────────────────────────────────"
    echo "UNMAPPED Rust changes (${#UNMAPPED[@]}) in the $LABEL set:"
    for f in "${UNMAPPED[@]}"; do
      echo "    ! $f"
    done
    echo ""
    echo "  These are neither under src-tauri/src/ (module mapping) nor"
    echo "  inside a workspace member (package mapping), so NO test"
    echo "  filter covers them. This is NOT the same as \"nothing"
    echo "  relevant changed\"."
    echo ""
    echo "  If they carry test-relevant logic, verify by hand:"
    echo "    (cd src-tauri && cargo nextest run --workspace)"
    echo "──────────────────────────────────────────────────────────"
    echo ""
  } >&2
fi

if [ ${#MODULE_FILTERS[@]} -eq 0 ] && [ ${#PKG_FILTERS[@]} -eq 0 ]; then
  if [ ${#UNMAPPED[@]} -gt 0 ]; then
    echo "NO Rust tests were selected: every $LABEL .rs file is UNMAPPED (see above)." >&2
    exit 0
  fi
  echo "All $LABEL .rs files are mod.rs/lib.rs/main.rs — they carry no module filter — skipping"
  exit 0
fi

# Deduplicate, then build the nextest filter atoms.
FILTERS=()
if [ ${#MODULE_FILTERS[@]} -gt 0 ]; then
  readarray -t MODULE_FILTERS < <(printf '%s\n' "${MODULE_FILTERS[@]}" | sort -u)
  for mod in "${MODULE_FILTERS[@]}"; do
    FILTERS+=("test(~$mod)")
  done
fi
if [ ${#PKG_FILTERS[@]} -gt 0 ]; then
  readarray -t PKG_FILTERS < <(printf '%s\n' "${PKG_FILTERS[@]}" | sort -u)
  for pkg in "${PKG_FILTERS[@]}"; do
    FILTERS+=("package($pkg)")
  done
fi

# `package(...)` only resolves against packages nextest was asked to
# consider. Run from src-tauri/, the bare invocation is scoped to the
# `agaric` package alone (#3212), so a package filter without
# `--workspace` matches zero tests and — with --no-tests=pass — exits 0
# having run nothing: the exact false green #3220 is about. Module-only
# runs keep the historical narrow scope.
SCOPE=()
if [ ${#PKG_FILTERS[@]} -gt 0 ]; then
  SCOPE=(--workspace)
fi

echo "Running cargo nextest for ${#FILTERS[@]} filter(s) from $LABEL: ${FILTERS[*]}"

# Build a single -E expression: test(~mod1) + package(crate) + …
#
# `--no-tests=pass` makes nextest exit 0 (not 4) if the filter matches 0
# tests. That's the legitimate case for cfg-gated modules (e.g.
# `sync_daemon::android_multicast` which is entirely
# `#[cfg(target_os = "android")]`) where a desktop run sees no compiled
# tests but the compile step itself is already covered by `cargo clippy`.
EXPR=""
for atom in "${FILTERS[@]}"; do
  if [ -z "$EXPR" ]; then
    EXPR="$atom"
  else
    EXPR="$EXPR + $atom"
  fi
done

if [ "$DRY" = "1" ]; then
  echo "  → cargo nextest run ${SCOPE[*]:-} --no-tests=pass -E \"$EXPR\""
  exit 0
fi

cd "$REPO_ROOT/src-tauri" && exec "$CARGO_BIN" nextest run "${SCOPE[@]}" --no-tests=pass -E "$EXPR"
